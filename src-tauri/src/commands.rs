use std::sync::Arc;
use viewport_core::{RdpConfig, SessionId, SessionManager};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tracing::info;

pub struct AppState {
    pub session_manager: Arc<SessionManager>,
    pub stream_port: u16,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct ConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
    pub enable_nla: bool,
    #[serde(default = "default_true")]
    pub enable_mic: bool,
    #[serde(default = "default_true")]
    pub enable_audio: bool,
    #[serde(default = "default_true")]
    pub enable_camera: bool,
    #[serde(default = "default_true")]
    pub enable_clipboard: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionDto {
    pub id: u64,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub width: u16,
    pub height: u16,
    pub status: String,
    pub is_detached: bool,
    pub is_fullscreen: bool,
}

#[tauri::command]
pub fn get_stream_port(state: State<'_, AppState>) -> u16 {
    state.stream_port
}

#[tauri::command]
pub async fn connect_session(
    options: ConnectOptions,
    state: State<'_, AppState>,
) -> Result<SessionDto, String> {
    info!("Connect requested for {}:{}", options.host, options.port);

    let mut config = RdpConfig::new(&options.host, &options.username, &options.password)
        .with_port(options.port)
        .with_resolution(options.width, options.height)
        .with_nla(options.enable_nla)
        .with_mic(options.enable_mic)
        .with_audio(options.enable_audio)
        .with_camera(options.enable_camera)
        .with_clipboard(options.enable_clipboard);

    if let Some(domain) = &options.domain {
        if !domain.is_empty() {
            config = config.with_domain(domain);
        }
    }

    let sm = Arc::clone(&state.session_manager);
    let session_id = sm.add_session(config.clone()).await;
    sm.connect(session_id).await;

    Ok(SessionDto {
        id: session_id.0,
        host: options.host,
        port: options.port,
        username: options.username,
        width: options.width,
        height: options.height,
        status: "Connecting...".to_string(),
        is_detached: false,
        is_fullscreen: false,
    })
}

#[tauri::command]
pub async fn reconnect_session(
    session_id: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = SessionId(session_id);
    state.session_manager.connect(id).await;
    Ok(())
}

#[tauri::command]
pub async fn disconnect_session(
    app: AppHandle,
    session_id: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = SessionId(session_id);
    state.session_manager.disconnect(id).await;
    state.session_manager.remove_session(id).await;

    let window_label = format!("detached-{}", session_id);
    if let Some(win) = app.get_webview_window(&window_label) {
        let _ = win.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionDto>, String> {
    let sessions = state.session_manager.sessions();
    let map = sessions.read().await;
    let mut list: Vec<SessionDto> = map
        .values()
        .map(|h| SessionDto {
            id: h.id.0,
            host: h.config.host.clone(),
            port: h.config.port,
            username: h.config.username.clone(),
            width: h.config.desktop_width,
            height: h.config.desktop_height,
            status: h.status.to_string(),
            is_detached: h.is_detached,
            is_fullscreen: h.is_fullscreen,
        })
        .collect();

    list.sort_by_key(|s| s.id);
    Ok(list)
}

#[tauri::command]
pub async fn detach_tab(
    app: AppHandle,
    session_id: u64,
    title: Option<String>,
    query: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = SessionId(session_id);
    state.session_manager.set_detached(id, true).await;

    let window_label = format!("detached-{}", session_id);
    if let Some(existing) = app.get_webview_window(&window_label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let win_title = title.unwrap_or_else(|| format!("ViewPort — Session #{}", session_id));
    let extra_query = query.map(|q| format!("&{}", q)).unwrap_or_default();
    let url = format!("index.html?detached={}{}", session_id, extra_query);

    info!("Creating detached window: label={}, url={}", window_label, url);

    let win = WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App(url.into()))
        .title(&win_title)
        .inner_size(1120.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .build()
        .map_err(|e| format!("Failed to create detached window: {}", e))?;

    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dock_tab(
    app: AppHandle,
    session_id: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = SessionId(session_id);
    state.session_manager.set_detached(id, false).await;
    state.session_manager.select_tab(id).await;

    let window_label = format!("detached-{}", session_id);
    if let Some(win) = app.get_webview_window(&window_label) {
        let _ = win.close();
    }

    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.set_focus();
    }

    Ok(())
}

#[tauri::command]
pub async fn toggle_fullscreen(
    window: tauri::Window,
    app: AppHandle,
    window_label: Option<String>,
) -> Result<bool, String> {
    if let Some(label) = window_label {
        if let Some(win) = app.get_webview_window(&label) {
            let current_fs = win.is_fullscreen().map_err(|e| e.to_string())?;
            win.set_fullscreen(!current_fs).map_err(|e| e.to_string())?;
            return Ok(!current_fs);
        }
    }
    let current_fs = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!current_fs).map_err(|e| e.to_string())?;
    Ok(!current_fs)
}

#[tauri::command]
pub fn start_window_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wake_on_lan(
    mac: String,
    broadcast_ip: Option<String>,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    info!(
        "Sending Wake-on-LAN magic packet to {} (broadcast: {:?}, port: {:?})",
        mac, broadcast_ip, port
    );
    match viewport_core::wol::send_wake_on_lan(&mac, broadcast_ip.as_deref(), port.unwrap_or(9)) {
        Ok(targets) => {
            info!("Wake-on-LAN packet dispatched to {:?}", targets);
            Ok(targets)
        }
        Err(err) => {
            tracing::error!("Wake-on-LAN dispatch failed for {}: {}", mac, err);
            Err(err)
        }
    }
}

#[tauri::command]
pub fn detect_mac_address(host: String) -> Result<Option<String>, String> {
    let result = viewport_core::wol::lookup_mac_for_host(&host);
    match &result {
        Ok(Some(mac)) => info!("Detected MAC address {} for {}", mac, host),
        Ok(None) => info!("No ARP MAC address entry found for {}", host),
        Err(err) => tracing::warn!("MAC address detection failed for {}: {}", host, err),
    }
    result
}

#[tauri::command]
pub async fn probe_tcp_port(host: String, port: u16) -> Result<bool, String> {
    let target = format!("{}:{}", host.trim(), port);
    match tokio::time::timeout(
        tokio::time::Duration::from_millis(800),
        tokio::net::TcpStream::connect(&target),
    )
    .await
    {
        Ok(Ok(_stream)) => Ok(true),
        _ => Ok(false),
    }
}

#[tauri::command]
pub fn toggle_maximize(window: tauri::Window) -> Result<(), String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}
