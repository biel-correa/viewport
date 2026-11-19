use std::sync::Arc;
use eframe::egui;
use viewport_core::SessionManager;
use tracing::info;

mod app;
mod keymap;
mod session_view;

use app::ViewPortApp;

fn main() -> eframe::Result {
    // Initialize logging
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,viewport=debug")),
        )
        .try_init();

    info!("Starting ViewPort Pure Rust Desktop Client...");

    // Create background Tokio runtime for async RDP network & protocol sessions
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to initialize Tokio async runtime");

    let tokio_handle = runtime.handle().clone();
    let session_manager = Arc::new(SessionManager::new());

    // Configure macOS native window options
    let mut native_options = eframe::NativeOptions::default();
    native_options.viewport = egui::ViewportBuilder::default()
        .with_title("ViewPort - High Performance Remote Desktop")
        .with_inner_size([1280.0, 820.0])
        .with_min_inner_size([800.0, 600.0]);

    eframe::run_native(
        "ViewPort",
        native_options,
        Box::new(move |_cc| {
            Ok(Box::new(ViewPortApp::new(session_manager, tokio_handle)))
        }),
    )
}
