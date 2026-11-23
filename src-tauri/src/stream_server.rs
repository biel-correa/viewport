use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use viewport_core::{DamageRegion, SessionId, SessionManager, SharedFrameBuffer};
use viewport_input::{
    mouse_button_event, mouse_move_event, mouse_wheel_event, scancode_to_event, unicode_to_event,
    MouseButton, Scancode,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientInputMessage {
    #[serde(rename = "mousemove")]
    MouseMove { x: u16, y: u16 },
    #[serde(rename = "mousebutton")]
    MouseButton {
        button: String,
        down: bool,
        x: u16,
        y: u16,
    },
    #[serde(rename = "wheel")]
    Wheel { x: u16, y: u16, delta: i16 },
    #[serde(rename = "key")]
    Key {
        scancode: u8,
        extended: bool,
        down: bool,
    },
    #[serde(rename = "unicode")]
    Unicode { text: String, down: bool },
    #[serde(rename = "resize")]
    Resize { width: u16, height: u16 },
}

#[derive(Debug, Serialize)]
struct ServerInfoMessage {
    #[serde(rename = "type")]
    msg_type: String,
    width: u16,
    height: u16,
    status: String,
}

#[derive(Debug, Serialize)]
struct ServerStatsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    ping_ms: Option<u32>,
}

#[allow(dead_code)]
pub struct StreamServer {
    pub port: u16,
    session_manager: Arc<SessionManager>,
}

impl StreamServer {
    pub async fn start(session_manager: Arc<SessionManager>) -> anyhow::Result<(Arc<Self>, u16)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let port = addr.port();

        info!("RDP Frame Streamer listening on ws://127.0.0.1:{}", port);

        let server = Arc::new(Self {
            port,
            session_manager: Arc::clone(&session_manager),
        });

        let server_clone = Arc::clone(&server);
        tokio::spawn(async move {
            while let Ok((stream, peer)) = listener.accept().await {
                let _ = stream.set_nodelay(true);
                let sm = Arc::clone(&server_clone.session_manager);
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, peer, sm).await {
                        warn!("WebSocket connection from {} closed: {:?}", peer, e);
                    }
                });
            }
        });

        Ok((server, port))
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
    session_manager: Arc<SessionManager>,
) -> anyhow::Result<()> {
    let ws_stream = tokio_tungstenite::accept_async(stream).await?;
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // The first message from client must be JSON identifying the session: { "session_id": <id> }
    let session_id = match ws_rx.next().await {
        Some(Ok(Message::Text(txt))) => {
            let val: serde_json::Value = serde_json::from_str(&txt)?;
            let id = val.get("session_id").and_then(|v| v.as_u64()).unwrap_or(0);
            SessionId(id)
        }
        _ => return Ok(()),
    };

    info!("Client {} subscribed to session {}", peer, session_id);

    // Fetch initial session dimensions and framebuffer handle
    let (mut fb_arc, width, height) = {
        let sessions = session_manager.sessions();
        let map = sessions.read().await;
        if let Some(h) = map.get(&session_id) {
            (
                Arc::clone(&h.framebuffer),
                h.config.desktop_width,
                h.config.desktop_height,
            )
        } else {
            return Ok(());
        }
    };

    // Send initial metadata
    let info_msg = serde_json::to_string(&ServerInfoMessage {
        msg_type: "info".to_string(),
        width,
        height,
        status: "active".to_string(),
    })?;
    ws_tx.send(Message::Text(info_msg.into())).await?;

    let mut last_version = 0u64;
    let mut packet_buf: Vec<u8> = Vec::new();
    let (mut frame_notify, mut rtt_handle) = {
        let fb = fb_arc.read().await;
        (fb.notify.clone(), fb.rtt_ms.clone())
    };
    let mut last_ping_sent: i32 = -2;
    let mut stats_interval = tokio::time::interval(tokio::time::Duration::from_secs(1));

    let sm_input = Arc::clone(&session_manager);

    // Spawn task to read incoming input from frontend WebSocket
    let mut input_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Text(txt) => {
                    if let Ok(input_msg) = serde_json::from_str::<ClientInputMessage>(&txt) {
                        match input_msg {
                            ClientInputMessage::MouseMove { x, y } => {
                                let evt = mouse_move_event(x, y);
                                sm_input.send_input(session_id, evt).await;
                            }
                            ClientInputMessage::MouseButton {
                                button,
                                down,
                                x,
                                y,
                            } => {
                                let mb = match button.as_str() {
                                    "right" => MouseButton::Right,
                                    "middle" => MouseButton::Middle,
                                    _ => MouseButton::Left,
                                };
                                let evt = mouse_button_event(mb, down, x, y);
                                sm_input.send_input(session_id, evt).await;
                            }
                            ClientInputMessage::Wheel { x, y, delta } => {
                                let evt = mouse_wheel_event(x, y, delta);
                                sm_input.send_input(session_id, evt).await;
                            }
                            ClientInputMessage::Key {
                                scancode,
                                extended,
                                down,
                            } => {
                                let sc = Scancode(scancode, extended);
                                let evt = scancode_to_event(sc, down);
                                sm_input.send_input(session_id, evt).await;
                            }
                            ClientInputMessage::Unicode { text, down } => {
                                for unit in text.encode_utf16() {
                                    let evt = unicode_to_event(unit, down);
                                    sm_input.send_input(session_id, evt).await;
                                }
                            }
                            ClientInputMessage::Resize { width, height } => {
                                sm_input.send_resize(session_id, width, height).await;
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Event-driven frame streaming loop: wakes immediately when a full frame commits.
    loop {
        let mut next_handles = None;
        let mut send_stats = false;
        let should_break = {
            // Register listener before checking `frame_version` so no notification is missed.
            let notified = frame_notify.notified();
            tokio::pin!(notified);

            let frame_to_send = {
                let mut fb = fb_arc.write().await;
                pack_dirty_frame(&mut fb, &mut last_version, &mut packet_buf)
            };

            if let Some(payload) = frame_to_send {
                if let Err(e) = ws_tx.send(Message::Binary(payload.into())).await {
                    warn!("WebSocket send error: {:?}", e);
                    break;
                }
                continue;
            }

            tokio::select! {
                _ = &mut input_task => true,
                _ = &mut notified => false,
                _ = stats_interval.tick() => {
                    send_stats = true;
                    false
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => {
                    let sessions = session_manager.sessions();
                    let map = sessions.read().await;
                    if let Some(h) = map.get(&session_id) {
                        if !Arc::ptr_eq(&fb_arc, &h.framebuffer) {
                            fb_arc = Arc::clone(&h.framebuffer);
                            let fb = fb_arc.read().await;
                            next_handles = Some((fb.notify.clone(), fb.rtt_ms.clone()));
                            last_version = 0;
                            last_ping_sent = -2;
                        }
                        false
                    } else {
                        true
                    }
                }
            }
        };

        if should_break {
            break;
        }
        if let Some((notify, rtt)) = next_handles {
            frame_notify = notify;
            rtt_handle = rtt;
        }
        if send_stats {
            let cur_rtt = rtt_handle.load(Ordering::Relaxed);
            if cur_rtt >= 0 && cur_rtt != last_ping_sent {
                let stats_msg = serde_json::to_string(&ServerStatsMessage {
                    msg_type: "stats".to_string(),
                    ping_ms: Some(cur_rtt as u32),
                })?;
                if let Err(e) = ws_tx.send(Message::Text(stats_msg.into())).await {
                    warn!("WebSocket send stats error: {:?}", e);
                    break;
                }
                last_ping_sent = cur_rtt;
            }
        }
    }

    Ok(())
}

fn pack_dirty_frame(
    fb: &mut SharedFrameBuffer,
    last_version: &mut u64,
    packet_buf: &mut Vec<u8>,
) -> Option<Vec<u8>> {
    if fb.frame_version == *last_version || fb.width == 0 || fb.height == 0 {
        return None;
    }

    let full_w = fb.width;
    let full_h = fb.height;
    let region = if *last_version == 0 {
        let _ = fb.dirty_rect.take();
        DamageRegion {
            left: 0,
            top: 0,
            right: full_w.saturating_sub(1),
            bottom: full_h.saturating_sub(1),
        }
    } else {
        fb.dirty_rect.take().unwrap_or(DamageRegion {
            left: 0,
            top: 0,
            right: full_w.saturating_sub(1),
            bottom: full_h.saturating_sub(1),
        })
    };

    let rect_x = region.left.min(full_w.saturating_sub(1));
    let rect_y = region.top.min(full_h.saturating_sub(1));
    let rect_r = region.right.min(full_w.saturating_sub(1)).max(rect_x);
    let rect_b = region.bottom.min(full_h.saturating_sub(1)).max(rect_y);
    let rect_w = rect_r - rect_x + 1;
    let rect_h = rect_b - rect_y + 1;

    let full_bytes = (full_w as usize) * (full_h as usize) * 4;
    if fb.data.len() < full_bytes {
        return None;
    }

    let sub_bytes = (rect_w as usize) * (rect_h as usize) * 4;
    let total_len = 12 + sub_bytes;
    packet_buf.resize(total_len, 0);

    packet_buf[0..2].copy_from_slice(&full_w.to_le_bytes());
    packet_buf[2..4].copy_from_slice(&full_h.to_le_bytes());
    packet_buf[4..6].copy_from_slice(&rect_x.to_le_bytes());
    packet_buf[6..8].copy_from_slice(&rect_y.to_le_bytes());
    packet_buf[8..10].copy_from_slice(&rect_w.to_le_bytes());
    packet_buf[10..12].copy_from_slice(&rect_h.to_le_bytes());

    let full_stride = (full_w as usize) * 4;
    let row_bytes = (rect_w as usize) * 4;

    if rect_x == 0 && rect_w == full_w {
        let src_start = (rect_y as usize) * full_stride;
        let src_end = src_start + sub_bytes;
        packet_buf[12..total_len].copy_from_slice(&fb.data[src_start..src_end]);
    } else {
        for row in 0..(rect_h as usize) {
            let src_offset = ((rect_y as usize) + row) * full_stride + (rect_x as usize) * 4;
            let dst_offset = 12 + row * row_bytes;
            packet_buf[dst_offset..dst_offset + row_bytes]
                .copy_from_slice(&fb.data[src_offset..src_offset + row_bytes]);
        }
    }

    *last_version = fb.frame_version;
    Some(packet_buf.clone())
}
