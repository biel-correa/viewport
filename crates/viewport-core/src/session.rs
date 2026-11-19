use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use anyhow::{Context, Result};
use ironrdp_cliprdr::backend::ClipboardMessage;
use ironrdp_cliprdr::CliprdrClient;
use ironrdp_connector::connection_activation::ConnectionActivationState;
use ironrdp_connector::Sequence as _;
use ironrdp_core::WriteBuf;
use ironrdp_displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::input::fast_path::FastPathInputEvent;
use ironrdp_pdu::input::mouse::PointerFlags;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_svc::{SvcMessage, SvcProcessorMessages};
use ironrdp_tokio::FramedWrite;
use tokio::sync::{mpsc, watch, Notify, RwLock};
use tracing::{error, info, warn};

use crate::clipboard::poll_local_clipboard_change;
use crate::config::RdpConfig;
use crate::connector::{establish_connection, InitializedChannel};

#[derive(Debug, Clone, Copy)]
pub struct DamageRegion {
    pub left: u16,
    pub top: u16,
    pub right: u16,
    pub bottom: u16,
}

impl DamageRegion {
    pub fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }
}

impl From<InclusiveRectangle> for DamageRegion {
    fn from(r: InclusiveRectangle) -> Self {
        Self {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        }
    }
}

/// Events emitted by an active RDP session to notify UI / renderers.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    Connected {
        width: u16,
        height: u16,
    },
    FrameUpdated {
        damage_rects: Vec<DamageRegion>,
    },
    Disconnected {
        reason: String,
    },
}

/// Thread-safe shared framebuffer accessible by renderer (RGBA8 format: 4 bytes per pixel).
pub struct SharedFrameBuffer {
    pub width: u16,
    pub height: u16,
    pub data: Vec<u8>,
    pub frame_version: u64,
    pub dirty_rect: Option<DamageRegion>,
    pub notify: Arc<Notify>,
    /// Smoothed TCP round-trip time in milliseconds (`-1` when unavailable).
    pub rtt_ms: Arc<AtomicI32>,
}

impl SharedFrameBuffer {
    pub fn new(width: u16, height: u16) -> Self {
        let size = (width as usize) * (height as usize) * 4;
        Self {
            width,
            height,
            data: vec![0u8; size],
            frame_version: 0,
            dirty_rect: None,
            notify: Arc::new(Notify::new()),
            rtt_ms: Arc::new(AtomicI32::new(-1)),
        }
    }

    /// Copies only the damaged scanline span from `src` and unions the dirty bounding box.
    pub fn update_damaged(&mut self, width: u16, height: u16, src: &[u8], rects: &[DamageRegion]) {
        if rects.is_empty() || width == 0 || height == 0 {
            return;
        }

        let expected_len = (width as usize) * (height as usize) * 4;
        if src.len() < expected_len {
            return;
        }

        if self.width != width || self.height != height || self.data.len() != expected_len {
            self.width = width;
            self.height = height;
            self.data.resize(expected_len, 0);
            self.data.copy_from_slice(&src[..expected_len]);
            let full = DamageRegion {
                left: 0,
                top: 0,
                right: width.saturating_sub(1),
                bottom: height.saturating_sub(1),
            };
            self.dirty_rect = Some(full);
            self.frame_version = self.frame_version.wrapping_add(1);
            self.notify.notify_waiters();
            return;
        }

        let mut bbox = rects[0];
        for r in &rects[1..] {
            bbox = bbox.union(*r);
        }

        let max_x = width.saturating_sub(1);
        let max_y = height.saturating_sub(1);
        bbox.left = bbox.left.min(max_x);
        bbox.right = bbox.right.min(max_x).max(bbox.left);
        bbox.top = bbox.top.min(max_y);
        bbox.bottom = bbox.bottom.min(max_y).max(bbox.top);

        let stride = (width as usize) * 4;
        let start_byte = (bbox.top as usize) * stride;
        let end_byte = ((bbox.bottom as usize) + 1) * stride;

        self.data[start_byte..end_byte].copy_from_slice(&src[start_byte..end_byte]);
        self.dirty_rect = Some(match self.dirty_rect {
            Some(prev) => prev.union(bbox),
            None => bbox,
        });
        self.frame_version = self.frame_version.wrapping_add(1);
        self.notify.notify_waiters();
    }
}

pub struct RdpSession {
    config: RdpConfig,
    framebuffer: Arc<RwLock<SharedFrameBuffer>>,
    input_tx: mpsc::Sender<FastPathInputEvent>,
    resize_tx: mpsc::Sender<(u16, u16)>,
}

impl RdpSession {
    pub fn new(
        config: RdpConfig,
    ) -> (
        Self,
        mpsc::Receiver<FastPathInputEvent>,
        mpsc::Receiver<(u16, u16)>,
    ) {
        let (input_tx, input_rx) = mpsc::channel(512);
        let (resize_tx, resize_rx) = mpsc::channel(16);
        let framebuffer = Arc::new(RwLock::new(SharedFrameBuffer::new(
            config.desktop_width,
            config.desktop_height,
        )));

        (
            Self {
                config,
                framebuffer,
                input_tx,
                resize_tx,
            },
            input_rx,
            resize_rx,
        )
    }

    pub fn framebuffer(&self) -> Arc<RwLock<SharedFrameBuffer>> {
        Arc::clone(&self.framebuffer)
    }

    pub fn input_sender(&self) -> mpsc::Sender<FastPathInputEvent> {
        self.input_tx.clone()
    }

    pub fn resize_sender(&self) -> mpsc::Sender<(u16, u16)> {
        self.resize_tx.clone()
    }

    /// Spawns the connection and active session loop in an asynchronous Tokio task.
    pub async fn run(
        self,
        mut input_rx: mpsc::Receiver<FastPathInputEvent>,
        mut resize_rx: mpsc::Receiver<(u16, u16)>,
        mut shutdown_rx: watch::Receiver<bool>,
        event_tx: mpsc::Sender<SessionEvent>,
    ) -> Result<()> {
        if *shutdown_rx.borrow() {
            return Ok(());
        }

        let (mut framed, outcome, mut dvc_rx, clipboard_state) = tokio::select! {
            res = establish_connection(&self.config) => res?,
            _ = wait_for_shutdown(&mut shutdown_rx) => {
                info!("RDP connection cancelled before handshake completed");
                let _ = event_tx.send(SessionEvent::Disconnected {
                    reason: "Disconnected by user".to_string(),
                }).await;
                return Ok(());
            }
        };
        let conn_result = outcome.into_connected().context("Server requested redirection")?;

        let width = conn_result.desktop_size.width;
        let height = conn_result.desktop_size.height;
        let activation_factory = conn_result.activation_factory;

        // Initialize decoded image directly in RGBA32 format for zero-overhead canvas/GPU blitting
        let mut decoded_image = DecodedImage::new(PixelFormat::RgbA32, width, height);

        {
            let mut fb = self.framebuffer.write().await;
            fb.width = width;
            fb.height = height;
            let expected_len = (width as usize) * (height as usize) * 4;
            if fb.data.len() != expected_len {
                fb.data.resize(expected_len, 0);
            }
        }

        for (type_id, svc) in conn_result.static_channels.iter() {
            let ch_id = conn_result.static_channels.get_channel_id_by_type_id(type_id);
            info!(
                channel = ?svc.channel_name().as_str(),
                channel_id = ?ch_id,
                options = ?svc.channel_options(),
                "Negotiated static virtual channel"
            );
        }
        let rdpsnd_ch_id = conn_result
            .static_channels
            .get_channel_id_by_channel_name(&ironrdp_rdpsnd::client::Rdpsnd::NAME);

        let mut active_stage = ActiveStageBuilder {
            static_channels: conn_result.static_channels,
            user_channel_id: conn_result.user_channel_id,
            io_channel_id: conn_result.io_channel_id,
            message_channel_id: conn_result.message_channel_id,
            share_id: conn_result.share_id,
            compression_type: conn_result.compression_type,
            enable_server_pointer: conn_result.enable_server_pointer,
            pointer_software_rendering: conn_result.pointer_software_rendering,
        }
        .build();

        let _ = event_tx.send(SessionEvent::Connected { width, height }).await;

        info!("Entering active RDP session loop ({}x{})", width, height);

        let mut input_batch = Vec::with_capacity(32);
        let mut pending_resize: Option<(u32, u32)> = None;
        let rtt_ms = { Arc::clone(&self.framebuffer.read().await.rtt_ms) };
        if let Some(ms) = read_socket_rtt_ms(&framed) {
            rtt_ms.store(ms.min(i32::MAX as u32) as i32, Ordering::Relaxed);
        }
        let mut rtt_interval = tokio::time::interval(tokio::time::Duration::from_secs(1));

        let (mut clip_rx, clip_change_count) = match clipboard_state {
            Some(state) => (Some(state.rx), Some(state.last_change_count)),
            None => (None, None),
        };
        let mut clip_poll_interval = tokio::time::interval(tokio::time::Duration::from_millis(250));
        let mut clip_timeout_interval = tokio::time::interval(tokio::time::Duration::from_secs(5));

        loop {
            tokio::select! {
                // Read incoming packets from server
                pdu_result = framed.read_pdu() => {
                    match pdu_result {
                        Ok((action, frame)) => {
                            if action == ironrdp_pdu::Action::X224 {
                                if let Ok(ctx) = ironrdp_pdu::mcs::decode_send_data_indication(&frame) {
                                    if rdpsnd_ch_id == Some(ctx.channel_id) {
                                        info!(
                                            channel_id = ctx.channel_id,
                                            len = ctx.user_data.len(),
                                            "Received raw RDPSND static channel PDU"
                                        );
                                    }
                                }
                            }
                            let last_read_at = framed.last_read_at();
                            match active_stage.process(&mut decoded_image, action, &frame, last_read_at) {
                                Ok(outputs) => {
                                    let mut response_frames = Vec::new();
                                    let mut damage_rects = Vec::new();
                                    let mut needs_reactivation = false;

                                    for out in outputs {
                                        match out {
                                            ActiveStageOutput::ResponseFrame(resp) => {
                                                if !resp.is_empty() {
                                                    response_frames.push(resp);
                                                }
                                            }
                                            ActiveStageOutput::GraphicsUpdate(rect) => {
                                                damage_rects.push(DamageRegion::from(rect));
                                            }
                                            ActiveStageOutput::DeactivateAll => {
                                                needs_reactivation = true;
                                            }
                                            ActiveStageOutput::Terminate(reason) => {
                                                let reason_str = reason.description();
                                                info!("RDP session ended: {}", reason_str);
                                                let _ = event_tx.send(SessionEvent::Disconnected { reason: reason_str }).await;
                                                return Ok(());
                                            }
                                            _ => {}
                                        }
                                    }

                                    // Send any required protocol responses (e.g. FrameAcknowledge, DVC open)
                                    for resp in response_frames {
                                        if let Err(e) = framed.write_all(&resp).await {
                                            warn!("Failed to write protocol response: {:?}", e);
                                        }
                                    }

                                    if damage_rects.is_empty() {
                                        for r in active_stage.take_damage_regions() {
                                            damage_rects.push(DamageRegion::from(r));
                                        }
                                    } else {
                                        let _ = active_stage.take_damage_regions();
                                    }

                                    // Update shared framebuffer if damage occurred
                                    if !damage_rects.is_empty() {
                                        let mut fb = self.framebuffer.write().await;
                                        fb.update_damaged(
                                            decoded_image.width(),
                                            decoded_image.height(),
                                            decoded_image.data(),
                                            &damage_rects,
                                        );
                                    }

                                    // If DisplayControl just became ready and a resize was queued, send it now
                                    if let Some((rw, rh)) = pending_resize {
                                        if active_stage.display_control_ready() == Some(true) {
                                            pending_resize = None;
                                            if let Some(Ok(dvc_bytes)) = active_stage.encode_resize(rw, rh, None, None) {
                                                if !dvc_bytes.is_empty() {
                                                    let _ = framed.write_all(&dvc_bytes).await;
                                                }
                                            }
                                        }
                                    }

                                    // Handle Deactivation-Reactivation Sequence (e.g. after DisplayControl resize)
                                    if needs_reactivation {
                                        info!("Executing Deactivation-Reactivation Sequence...");
                                        let mut activation = activation_factory.create();
                                        let mut buf = WriteBuf::new();
                                        while !activation.state().is_terminal() {
                                            ironrdp_tokio::single_sequence_step(&mut framed, &mut activation, &mut buf)
                                                .await
                                                .context("Reactivation sequence step failed")?;
                                        }

                                        if let ConnectionActivationState::Finalized {
                                            desktop_size,
                                            share_id,
                                            static_channel_chunk_size,
                                            enable_server_pointer,
                                            pointer_software_rendering,
                                            ..
                                        } = activation.connection_activation_state()
                                        {
                                            let new_w = desktop_size.width;
                                            let new_h = desktop_size.height;
                                            info!("Session reactivated at {}x{}", new_w, new_h);

                                            decoded_image = DecodedImage::new(PixelFormat::RgbA32, new_w, new_h);
                                            active_stage.reactivate(
                                                activation.io_channel_id(),
                                                activation.user_channel_id(),
                                                share_id,
                                                enable_server_pointer,
                                                pointer_software_rendering,
                                                static_channel_chunk_size,
                                            );

                                            {
                                                let mut fb = self.framebuffer.write().await;
                                                fb.width = new_w;
                                                fb.height = new_h;
                                                let expected_len = (new_w as usize) * (new_h as usize) * 4;
                                                fb.data.resize(expected_len, 0);
                                            }

                                            let _ = event_tx.send(SessionEvent::Connected {
                                                width: new_w,
                                                height: new_h,
                                            }).await;
                                        }
                                    }
                                }
                                Err(e) => {
                                    warn!("Error processing incoming RDP packet: {:?}", e);
                                }
                            }
                        }
                        Err(e) => {
                            error!("Connection closed by remote host: {:?}", e);
                            let _ = event_tx.send(SessionEvent::Disconnected {
                                reason: format!("Connection lost: {:?}", e),
                            }).await;
                            break;
                        }
                    }
                }

                // Forward outgoing DVC messages (Microphone audio samples and Webcam video frames)
                Some(svc_messages) = dvc_rx.recv() => {
                    match active_stage.encode_dvc_messages(svc_messages) {
                        Ok(bytes) => {
                            if !bytes.is_empty() {
                                if let Err(e) = framed.write_all(&bytes).await {
                                    warn!("Failed to write DVC uplink messages: {:?}", e);
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Failed to encode DVC uplink messages: {:?}", e);
                        }
                    }
                }

                // Process dynamic display resize requests (MS-RDPEDISP)
                Some((mut req_w, mut req_h)) = resize_rx.recv() => {
                    while let Ok((nw, nh)) = resize_rx.try_recv() {
                        req_w = nw;
                        req_h = nh;
                    }

                    let (adj_w, adj_h) = MonitorLayoutEntry::adjust_display_size(
                        u32::from(req_w),
                        u32::from(req_h),
                    );

                    if (adj_w as u16, adj_h as u16) != (decoded_image.width(), decoded_image.height()) {
                        info!("Requesting dynamic resolution resize to {}x{}", adj_w, adj_h);
                        match active_stage.encode_resize(adj_w, adj_h, None, None) {
                            Some(Ok(dvc_bytes)) => {
                                pending_resize = None;
                                if !dvc_bytes.is_empty() {
                                    if let Err(e) = framed.write_all(&dvc_bytes).await {
                                        warn!("Failed to write DisplayControl resize PDU: {:?}", e);
                                    }
                                }
                            }
                            Some(Err(e)) => {
                                warn!("Failed to encode DisplayControl resize PDU: {:?}", e);
                            }
                            None => {
                                // DisplayControl channel not yet ready; queue it
                                pending_resize = Some((adj_w, adj_h));
                            }
                        }
                    }
                }

                // Process outgoing user input events (batched & coalesced)
                Some(first_input) = input_rx.recv() => {
                    input_batch.clear();
                    input_batch.push(first_input);

                    while let Ok(next_input) = input_rx.try_recv() {
                        let is_prev_move = matches!(
                            input_batch.last(),
                            Some(FastPathInputEvent::MouseEvent(p)) if p.flags == PointerFlags::MOVE
                        );
                        let is_curr_move = matches!(
                            &next_input,
                            FastPathInputEvent::MouseEvent(p) if p.flags == PointerFlags::MOVE
                        );

                        if is_prev_move && is_curr_move {
                            if let Some(last) = input_batch.last_mut() {
                                *last = next_input;
                            }
                        } else {
                            input_batch.push(next_input);
                            if input_batch.len() >= 64 {
                                break;
                            }
                        }
                    }

                    match active_stage.process_fastpath_input(&mut decoded_image, &input_batch) {
                        Ok(outputs) => {
                            for out in outputs {
                                if let ActiveStageOutput::ResponseFrame(pdu_bytes) = out {
                                    if !pdu_bytes.is_empty() {
                                        if let Err(e) = framed.write_all(&pdu_bytes).await {
                                            warn!("Failed to send input PDU: {:?}", e);
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Failed to encode fastpath input: {:?}", e);
                        }
                    }
                }

                _ = rtt_interval.tick() => {
                    if let Some(ms) = read_socket_rtt_ms(&framed) {
                        rtt_ms.store(ms.min(i32::MAX as u32) as i32, Ordering::Relaxed);
                    }
                }

                // Process outgoing clipboard protocol messages
                Some(clip_msg) = async {
                    match clip_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Some(bytes) = process_clipboard_message(&mut active_stage, clip_msg) {
                        if !bytes.is_empty() {
                            if let Err(e) = framed.write_all(&bytes).await {
                                warn!("Failed to send clipboard PDU: {:?}", e);
                            }
                        }
                    }
                }

                // Poll macOS general pasteboard change counter when clipboard sync is enabled
                _ = clip_poll_interval.tick(), if clip_change_count.is_some() => {
                    if let Some(ref counter) = clip_change_count {
                        if let Some(formats) = poll_local_clipboard_change(counter) {
                            if let Some(bytes) = process_clipboard_message(
                                &mut active_stage,
                                ClipboardMessage::SendInitiateCopy(formats),
                            ) {
                                if !bytes.is_empty() {
                                    if let Err(e) = framed.write_all(&bytes).await {
                                        warn!("Failed to advertise local clipboard copy: {:?}", e);
                                    }
                                }
                            }
                        }
                    }
                }

                // Drive CLIPRDR lock timeouts
                _ = clip_timeout_interval.tick(), if clip_rx.is_some() => {
                    if let Some(cliprdr) = active_stage.get_svc_processor_mut::<InitializedChannel<CliprdrClient>>() {
                        match cliprdr.0.drive_timeouts() {
                            Ok(svc_messages) => {
                                let raw: Vec<SvcMessage> = svc_messages.into();
                                if !raw.is_empty() {
                                    if let Ok(bytes) = active_stage.process_svc_processor_messages(
                                        SvcProcessorMessages::<InitializedChannel<CliprdrClient>>::new(raw),
                                    ) {
                                        if !bytes.is_empty() {
                                            let _ = framed.write_all(&bytes).await;
                                        }
                                    }
                                }
                            }
                            Err(e) => warn!("Clipboard timeout cleanup failed: {:?}", e),
                        }
                    }
                }

                // Graceful shutdown signal when user closes tab or disconnects
                _ = wait_for_shutdown(&mut shutdown_rx) => {
                    info!("RDP session shutdown requested; closing connection");
                    if let Ok(outputs) = active_stage.graceful_shutdown() {
                        for out in outputs {
                            if let ActiveStageOutput::ResponseFrame(pdu_bytes) = out {
                                if !pdu_bytes.is_empty() {
                                    let _ = framed.write_all(&pdu_bytes).await;
                                }
                            }
                        }
                    }
                    let _ = event_tx.send(SessionEvent::Disconnected {
                        reason: "Disconnected by user".to_string(),
                    }).await;
                    break;
                }
            }
        }

        Ok(())
    }
}

async fn wait_for_shutdown(shutdown_rx: &mut watch::Receiver<bool>) {
    while !*shutdown_rx.borrow() {
        if shutdown_rx.changed().await.is_err() {
            break;
        }
    }
}

fn process_clipboard_message(
    active_stage: &mut ActiveStage,
    msg: ClipboardMessage,
) -> Option<Vec<u8>> {
    let cliprdr = active_stage.get_svc_processor_mut::<InitializedChannel<CliprdrClient>>()?;
    let svc_result = match msg {
        ClipboardMessage::SendInitiateCopy(formats) => cliprdr.0.initiate_copy(&formats),
        ClipboardMessage::SendInitiateFileCopy(files) => cliprdr.0.initiate_file_copy(files),
        ClipboardMessage::SendFormatData(response) => cliprdr.0.submit_format_data(response),
        ClipboardMessage::SendInitiatePaste(format) => cliprdr.0.initiate_paste(format),
        ClipboardMessage::SendFileContentsRequest(request) => {
            cliprdr.0.request_file_contents(request)
        }
        ClipboardMessage::SendFileContentsResponse(response) => {
            cliprdr.0.submit_file_contents(response)
        }
        ClipboardMessage::Error(e) => {
            warn!("Clipboard backend error: {}", e);
            return None;
        }
    };

    match svc_result {
        Ok(svc_messages) => {
            let raw: Vec<SvcMessage> = svc_messages.into();
            if raw.is_empty() {
                return None;
            }
            match active_stage.process_svc_processor_messages(
                SvcProcessorMessages::<InitializedChannel<CliprdrClient>>::new(raw),
            ) {
                Ok(bytes) => Some(bytes),
                Err(e) => {
                    warn!("Failed to encode clipboard SVC messages: {:?}", e);
                    None
                }
            }
        }
        Err(e) => {
            warn!("CLIPRDR action failed: {:?}", e);
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn read_socket_rtt_ms(framed: &ironrdp_tokio::TokioFramed<crate::connector::RdpStream>) -> Option<u32> {
    use std::os::fd::AsRawFd;

    let (tls_stream, _) = framed.get_inner();
    let (tcp_stream, _) = tls_stream.get_ref();
    let fd = tcp_stream.as_raw_fd();

    let mut info: libc::tcp_connection_info = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::tcp_connection_info>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::IPPROTO_TCP,
            libc::TCP_CONNECTION_INFO,
            (&mut info as *mut libc::tcp_connection_info).cast(),
            &mut len,
        )
    };
    if rc == 0 && (info.tcpi_srtt > 0 || info.tcpi_rttcur > 0 || info.tcpi_rto > 0) {
        Some(if info.tcpi_srtt > 0 { info.tcpi_srtt } else { info.tcpi_rttcur })
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn read_socket_rtt_ms(_framed: &ironrdp_tokio::TokioFramed<crate::connector::RdpStream>) -> Option<u32> {
    None
}
