use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use egui::{
    vec2, Align, Button, Color32, Layout, RichText, TopBottomPanel, ViewportBuilder,
    ViewportCommand, ViewportId,
};
use viewport_core::{RdpConfig, SessionId, SessionManager, SessionStatus};

use crate::session_view::SessionView;

pub struct NewConnectionForm {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: String,
    pub width: u16,
    pub height: u16,
    pub enable_nla: bool,
}

impl Default for NewConnectionForm {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 3389,
            username: "Administrator".to_string(),
            password: "".to_string(),
            domain: "".to_string(),
            width: 1920,
            height: 1080,
            enable_nla: true,
        }
    }
}

pub struct ViewPortApp {
    pub session_manager: Arc<SessionManager>,
    pub tokio_handle: tokio::runtime::Handle,
    pub views: HashMap<SessionId, SessionView>,
    pub show_new_modal: bool,
    pub form: NewConnectionForm,
    pub is_main_fullscreen: bool,
}

impl ViewPortApp {
    pub fn new(session_manager: Arc<SessionManager>, tokio_handle: tokio::runtime::Handle) -> Self {
        Self {
            session_manager,
            tokio_handle,
            views: HashMap::new(),
            show_new_modal: false,
            form: NewConnectionForm::default(),
            is_main_fullscreen: false,
        }
    }

    fn get_or_create_view(&mut self, id: SessionId) -> &mut SessionView {
        self.views.entry(id).or_insert_with(|| SessionView::new(id))
    }
}

impl eframe::App for ViewPortApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Request steady 60fps repaints when active connections exist
        ctx.request_repaint_after(Duration::from_millis(16));

        // Clone current sessions map safely
        let sessions_map = {
            if let Ok(guard) = self.session_manager.sessions().try_read() {
                guard.clone()
            } else {
                return;
            }
        };

        let active_tab_id = {
            if let Ok(guard) = self.session_manager.active_tab().try_read() {
                *guard
            } else {
                None
            }
        };

        // 1. Top Panel: Tabs & Controls
        TopBottomPanel::top("top_panel").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading(RichText::new("⚡ ViewPort").strong().color(Color32::from_rgb(0, 180, 240)));
                ui.separator();

                // Tab strip for attached sessions
                let mut session_keys: Vec<SessionId> = sessions_map
                    .iter()
                    .filter(|(_, h)| !h.is_detached)
                    .map(|(id, _)| *id)
                    .collect();
                session_keys.sort_by_key(|id| id.0);

                for id in session_keys {
                    let Some(handle) = sessions_map.get(&id) else {
                        continue;
                    };

                    let is_active = active_tab_id == Some(id);
                    let (status_icon, status_color) = match handle.status {
                        SessionStatus::Connected { .. } => ("●", Color32::from_rgb(50, 205, 50)),
                        SessionStatus::Connecting => ("◐", Color32::from_rgb(255, 190, 0)),
                        SessionStatus::Error(_) => ("✖", Color32::from_rgb(230, 60, 60)),
                        SessionStatus::Disconnected => ("○", Color32::GRAY),
                    };

                    let tab_title = format!("{} {} ", status_icon, handle.display_name());
                    let mut tab_button = Button::new(RichText::new(tab_title).color(status_color));
                    if is_active {
                        tab_button = tab_button.fill(Color32::from_rgb(45, 50, 65));
                    }

                    if ui.add(tab_button).clicked() {
                        let sm = Arc::clone(&self.session_manager);
                        self.tokio_handle.spawn(async move {
                            sm.select_tab(id).await;
                        });
                    }

                    // Detach to independent window button
                    if ui.button("⧉").on_hover_text("Detach into separate OS window").clicked() {
                        let sm = Arc::clone(&self.session_manager);
                        self.tokio_handle.spawn(async move {
                            sm.set_detached(id, true).await;
                        });
                    }

                    // Close tab button
                    if ui.button("✕").on_hover_text("Close session").clicked() {
                        let sm = Arc::clone(&self.session_manager);
                        self.tokio_handle.spawn(async move {
                            sm.remove_session(id).await;
                        });
                    }

                    ui.separator();
                }

                // New Connection Button
                if ui.button(RichText::new("➕ New Connection").strong()).clicked() {
                    self.show_new_modal = true;
                }

                // Main Window Fullscreen Toggle
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let fs_label = if self.is_main_fullscreen { "⤓ Exit Fullscreen" } else { "⛶ Fullscreen" };
                    if ui.button(fs_label).clicked() {
                        self.is_main_fullscreen = !self.is_main_fullscreen;
                        ctx.send_viewport_cmd(ViewportCommand::Fullscreen(self.is_main_fullscreen));
                    }
                });
            });
        });

        // 2. Render Detached Native OS Windows
        for (id, handle) in sessions_map.iter().filter(|(_, h)| h.is_detached) {
            let session_id = *id;
            let viewport_id = ViewportId::from_hash_of(&session_id.0);
            let title = format!("ViewPort - {}", handle.display_name());

            let sm_clone = Arc::clone(&self.session_manager);
            let tokio_clone = self.tokio_handle.clone();
            let view = self.get_or_create_view(session_id);

            ctx.show_viewport_immediate(
                viewport_id,
                ViewportBuilder::default()
                    .with_title(title)
                    .with_inner_size(vec2(1024.0, 768.0)),
                |v_ctx, _class| {
                    TopBottomPanel::top("detached_bar").show(v_ctx, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(format!("🖥️ {}", handle.display_name())).strong());

                            if ui.button("⤓ Dock back to Tabs").on_hover_text("Reattach to main tab window").clicked() {
                                let sm = Arc::clone(&sm_clone);
                                tokio_clone.spawn(async move {
                                    sm.set_detached(session_id, false).await;
                                    sm.select_tab(session_id).await;
                                });
                            }

                            if ui.button("⛶ Toggle Fullscreen").clicked() {
                                let sm = Arc::clone(&sm_clone);
                                tokio_clone.spawn(async move {
                                    sm.toggle_fullscreen(session_id).await;
                                });
                                v_ctx.send_viewport_cmd(ViewportCommand::Fullscreen(!handle.is_fullscreen));
                            }

                            if ui.button("✕ Disconnect").clicked() {
                                let sm = Arc::clone(&sm_clone);
                                tokio_clone.spawn(async move {
                                    sm.disconnect(session_id).await;
                                });
                            }
                        });
                    });

                    egui::CentralPanel::default().show(v_ctx, |ui| {
                        view.render(ui, handle, &sm_clone, &tokio_clone);
                    });
                },
            );
        }

        // 3. Render Active Tab inside Main Window
        egui::CentralPanel::default().show(ctx, |ui| {
            if let Some(id) = active_tab_id {
                if let Some(handle) = sessions_map.get(&id) {
                    if !handle.is_detached {
                        let sm = Arc::clone(&self.session_manager);
                        let tokio_handle = self.tokio_handle.clone();
                        let view = self.get_or_create_view(id);
                        view.render(ui, handle, &sm, &tokio_handle);
                        return;
                    }
                }
            }

            // Empty state view
            ui.centered_and_justified(|ui| {
                ui.vertical_centered(|ui| {
                    ui.heading("Welcome to ViewPort");
                    ui.label("A high-performance pure Rust multi-connection RDP client.");
                    ui.add_space(16.0);
                    if ui.button(RichText::new("➕ Connect to a Computer").heading()).clicked() {
                        self.show_new_modal = true;
                    }
                });
            });
        });

        // 4. Modal Dialog: New Connection
        if self.show_new_modal {
            let mut close_modal = false;
            let mut initiate_connect = false;

            egui::Window::new("New RDP Connection")
                .collapsible(false)
                .resizable(false)
                .anchor(egui::Align2::CENTER_CENTER, vec2(0.0, 0.0))
                .show(ctx, |ui| {
                    ui.set_width(380.0);
                    ui.heading("Connection Details");
                    ui.add_space(8.0);

                    egui::Grid::new("conn_grid").spacing(vec2(8.0, 8.0)).show(ui, |ui| {
                        ui.label("Host / IP:");
                        ui.text_edit_singleline(&mut self.form.host);
                        ui.end_row();

                        ui.label("Port:");
                        ui.add(egui::DragValue::new(&mut self.form.port).range(1..=65535));
                        ui.end_row();

                        ui.label("Username:");
                        ui.text_edit_singleline(&mut self.form.username);
                        ui.end_row();

                        ui.label("Password:");
                        ui.add(egui::TextEdit::singleline(&mut self.form.password).password(true));
                        ui.end_row();

                        ui.label("Domain:");
                        ui.text_edit_singleline(&mut self.form.domain);
                        ui.end_row();

                        ui.label("Resolution:");
                        ui.horizontal(|ui| {
                            if ui.selectable_label(self.form.width == 1920 && self.form.height == 1080, "1080p").clicked() {
                                self.form.width = 1920;
                                self.form.height = 1080;
                            }
                            if ui.selectable_label(self.form.width == 2560 && self.form.height == 1440, "1440p").clicked() {
                                self.form.width = 2560;
                                self.form.height = 1440;
                            }
                            if ui.selectable_label(self.form.width == 1280 && self.form.height == 720, "720p").clicked() {
                                self.form.width = 1280;
                                self.form.height = 720;
                            }
                        });
                        ui.end_row();

                        ui.label("Security:");
                        ui.checkbox(&mut self.form.enable_nla, "Network Level Auth (NLA/CredSSP)");
                        ui.end_row();
                    });

                    ui.add_space(16.0);
                    ui.horizontal(|ui| {
                        if ui.button(RichText::new("Connect").strong().color(Color32::from_rgb(0, 180, 240))).clicked() {
                            initiate_connect = true;
                            close_modal = true;
                        }
                        if ui.button("Cancel").clicked() {
                            close_modal = true;
                        }
                    });
                });

            if initiate_connect {
                let mut config = RdpConfig::new(&self.form.host, &self.form.username, &self.form.password)
                    .with_port(self.form.port)
                    .with_resolution(self.form.width, self.form.height)
                    .with_nla(self.form.enable_nla);

                if !self.form.domain.is_empty() {
                    config = config.with_domain(&self.form.domain);
                }

                let sm = Arc::clone(&self.session_manager);
                self.tokio_handle.spawn(async move {
                    let id = sm.add_session(config).await;
                    sm.connect(id).await;
                });
            }

            if close_modal {
                self.show_new_modal = false;
            }
        }
    }
}
