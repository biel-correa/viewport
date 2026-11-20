use std::fs::OpenOptions;
use std::sync::Arc;
use viewport_core::SessionManager;
use tauri::Manager;
use tracing::info;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter, Registry};

mod commands;
mod stream_server;
mod updater;

use commands::{
    connect_session, detach_tab, detect_mac_address, disconnect_session, dock_tab, get_stream_port,
    list_sessions, probe_tcp_port, reconnect_session, start_window_drag, toggle_fullscreen,
    toggle_maximize, wake_on_lan, AppState,
};
use stream_server::StreamServer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(
            "info,viewport=debug,ironrdp_connector=debug,ironrdp_svc=debug,ironrdp_session=info,ironrdp_session::fast_path=off,ironrdp_session::autodetect=off,ironrdp_graphics=info,ironrdp_rdpsnd=debug,ironrdp_rdpsnd_native=debug,ironrdp_dvc=debug,ironrdp_rdpeai=debug,ironrdp_rdpecam=debug",
        )
    });

    let log_path = std::env::temp_dir().join("viewport.log");
    let log_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .ok();

    if let Some(file) = log_file {
        let file_layer = fmt::layer().with_writer(Arc::new(file)).with_ansi(false);
        let stdout_layer = fmt::layer();
        let _ = Registry::default()
            .with(filter)
            .with(stdout_layer)
            .with(file_layer)
            .try_init();
    } else {
        let _ = fmt().with_env_filter(filter).try_init();
    }

    info!("Initializing ViewPort Tauri application (writing logs to {})...", log_path.display());

    let session_manager = Arc::new(SessionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup({
            let sm = Arc::clone(&session_manager);
            move |app| {
                let (_, port) = tauri::async_runtime::block_on(StreamServer::start(Arc::clone(&sm)))?;
                app.manage(AppState {
                    session_manager: sm,
                    stream_port: port,
                });
                info!("StreamServer successfully attached on port {}", port);
                Ok(())
            }
        })
        .on_window_event({
            let sm = Arc::clone(&session_manager);
            move |_window, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    let label = _window.label();
                    if label == "main" {
                        tauri::async_runtime::block_on(sm.disconnect_all());
                    } else if let Some(raw_id) = label.strip_prefix("detached-") {
                        if let Ok(num_id) = raw_id.parse::<u64>() {
                            let id = viewport_core::SessionId(num_id);
                            let sm_clone = Arc::clone(&sm);
                            tauri::async_runtime::spawn(async move {
                                let still_detached = {
                                    let sessions = sm_clone.sessions();
                                    let map = sessions.read().await;
                                    map.get(&id).is_some_and(|h| h.is_detached)
                                };
                                if still_detached {
                                    sm_clone.remove_session(id).await;
                                }
                            });
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_stream_port,
            connect_session,
            reconnect_session,
            disconnect_session,
            list_sessions,
            detach_tab,
            dock_tab,
            toggle_fullscreen,
            start_window_drag,
            toggle_maximize,
            wake_on_lan,
            detect_mac_address,
            probe_tcp_port,
            updater::get_app_version,
            updater::check_for_update,
            updater::install_update,
            updater::open_download_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
