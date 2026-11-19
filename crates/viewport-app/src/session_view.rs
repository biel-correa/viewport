use std::sync::Arc;
use egui::{Color32, ColorImage, Event, PointerButton, Rect, Response, Sense, TextureOptions, Ui, Vec2};
use viewport_core::{SessionHandle, SessionId, SessionManager, SessionStatus};
use viewport_input::{
    local_to_remote_coords, mouse_button_event, mouse_move_event, mouse_wheel_event,
    scancode_to_event, MouseButton,
};

use crate::keymap::egui_key_to_scancode;

pub struct SessionView {
    pub id: SessionId,
    pub texture: Option<egui::TextureHandle>,
    pub last_frame_version: u64,
    pub rgba_buffer: Vec<u8>,
    pub last_mouse_pos: Option<(u16, u16)>,
}

impl SessionView {
    pub fn new(id: SessionId) -> Self {
        Self {
            id,
            texture: None,
            last_frame_version: 0,
            rgba_buffer: Vec::new(),
            last_mouse_pos: None,
        }
    }

    /// Updates the GPU texture from the decoded RDP framebuffer if a new frame arrived.
    pub fn update_texture(&mut self, ui: &mut Ui, handle: &SessionHandle) {
        if handle.frame_version == self.last_frame_version && self.texture.is_some() {
            return;
        }

        // Try reading the shared framebuffer
        if let Ok(fb) = handle.framebuffer.try_read() {
            let width = fb.width as usize;
            let height = fb.height as usize;
            let total_pixels = width * height;

            if fb.data.len() >= total_pixels * 4 {
                let color_image = ColorImage::from_rgba_unmultiplied([width, height], &fb.data[..total_pixels * 4]);

                // Use Nearest Neighbor filtering to match Metal pixel-doubler (integer Retina scaling)
                let texture = ui.ctx().load_texture(
                    format!("rdp_session_{}", self.id.0),
                    color_image,
                    TextureOptions::NEAREST,
                );
                self.texture = Some(texture);
                self.last_frame_version = handle.frame_version;
            }
        }
    }

    /// Renders the remote desktop view and processes user mouse and keyboard inputs.
    pub fn render(
        &mut self,
        ui: &mut Ui,
        handle: &SessionHandle,
        session_manager: &Arc<SessionManager>,
        tokio_handle: &tokio::runtime::Handle,
    ) {
        match &handle.status {
            SessionStatus::Connecting => {
                ui.centered_and_justified(|ui| {
                    ui.vertical_centered(|ui| {
                        ui.spinner();
                        ui.add_space(8.0);
                        ui.heading("Connecting to Remote Host...");
                        ui.label(format!("Target: {}:{}", handle.config.host, handle.config.port));
                        ui.label(format!("User: {}", handle.config.username));
                    });
                });
                return;
            }
            SessionStatus::Error(err) => {
                ui.centered_and_justified(|ui| {
                    ui.vertical_centered(|ui| {
                        ui.colored_label(Color32::from_rgb(230, 60, 60), "Connection Failed");
                        ui.add_space(8.0);
                        ui.label(err);
                        ui.add_space(12.0);
                        if ui.button("Retry Connection").clicked() {
                            let sm = Arc::clone(session_manager);
                            let sid = self.id;
                            tokio_handle.spawn(async move {
                                sm.connect(sid).await;
                            });
                        }
                    });
                });
                return;
            }
            SessionStatus::Disconnected => {
                ui.centered_and_justified(|ui| {
                    ui.vertical_centered(|ui| {
                        ui.heading("Session Disconnected");
                        ui.add_space(8.0);
                        ui.label(format!("{}:{}", handle.config.host, handle.config.port));
                        ui.add_space(12.0);
                        if ui.button("Reconnect").clicked() {
                            let sm = Arc::clone(session_manager);
                            let sid = self.id;
                            tokio_handle.spawn(async move {
                                sm.connect(sid).await;
                            });
                        }
                    });
                });
                return;
            }
            SessionStatus::Connected { .. } => {}
        }

        self.update_texture(ui, handle);

        let Some(texture) = &self.texture else {
            ui.centered_and_justified(|ui| {
                ui.label("Waiting for first desktop frame...");
            });
            return;
        };

        // Calculate aspect ratio preserving viewport rect
        let avail_size = ui.available_size();
        let remote_width = handle.config.desktop_width as f32;
        let remote_height = handle.config.desktop_height as f32;
        let aspect = remote_width / remote_height;

        let target_size = if avail_size.x / avail_size.y > aspect {
            Vec2::new(avail_size.y * aspect, avail_size.y)
        } else {
            Vec2::new(avail_size.x, avail_size.x / aspect)
        };

        let (rect, response) = ui.allocate_exact_size(target_size, Sense::click_and_drag());

        // Paint remote desktop surface
        let uv = Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0));
        ui.painter().image(texture.id(), rect, uv, Color32::WHITE);

        // Process pointer (mouse) interaction
        self.handle_pointer_input(ui, &response, rect, handle, session_manager, tokio_handle);

        // Process keyboard interaction
        self.handle_keyboard_input(ui, &response, session_manager, tokio_handle);
    }

    fn handle_pointer_input(
        &mut self,
        ui: &Ui,
        response: &Response,
        rect: Rect,
        handle: &SessionHandle,
        session_manager: &Arc<SessionManager>,
        tokio_handle: &tokio::runtime::Handle,
    ) {
        let remote_size = (handle.config.desktop_width, handle.config.desktop_height);
        let rect_min = (rect.min.x, rect.min.y);
        let rect_size = (rect.width(), rect.height());

        // Hover / Move
        if let Some(hover_pos) = response.hover_pos() {
            if let Some((rx, ry)) =
                local_to_remote_coords((hover_pos.x, hover_pos.y), rect_min, rect_size, remote_size)
            {
                if self.last_mouse_pos != Some((rx, ry)) {
                    self.last_mouse_pos = Some((rx, ry));
                    let sm = Arc::clone(session_manager);
                    let sid = self.id;
                    let evt = mouse_move_event(rx, ry);
                    tokio_handle.spawn(async move {
                        sm.send_input(sid, evt).await;
                    });
                }

                // Inspect button clicks/drags
                ui.input(|i| {
                    for (btn, mb) in [
                        (PointerButton::Primary, MouseButton::Left),
                        (PointerButton::Secondary, MouseButton::Right),
                        (PointerButton::Middle, MouseButton::Middle),
                    ] {
                        if i.pointer.button_pressed(btn) {
                            let sm = Arc::clone(session_manager);
                            let sid = self.id;
                            let evt = mouse_button_event(mb, true, rx, ry);
                            tokio_handle.spawn(async move {
                                sm.send_input(sid, evt).await;
                            });
                        }
                        if i.pointer.button_released(btn) {
                            let sm = Arc::clone(session_manager);
                            let sid = self.id;
                            let evt = mouse_button_event(mb, false, rx, ry);
                            tokio_handle.spawn(async move {
                                sm.send_input(sid, evt).await;
                            });
                        }
                    }

                    // Mouse wheel
                    let scroll_delta_y = i.raw_scroll_delta.y;
                    if scroll_delta_y.abs() > 0.0 {
                        let units = (scroll_delta_y * 10.0).clamp(-256.0, 255.0) as i16;
                        let sm = Arc::clone(session_manager);
                        let sid = self.id;
                        let evt = mouse_wheel_event(rx, ry, units);
                        tokio_handle.spawn(async move {
                            sm.send_input(sid, evt).await;
                        });
                    }
                });
            }
        }
    }

    fn handle_keyboard_input(
        &mut self,
        ui: &Ui,
        response: &Response,
        session_manager: &Arc<SessionManager>,
        tokio_handle: &tokio::runtime::Handle,
    ) {
        if !response.has_focus() && !response.hovered() {
            return;
        }

        ui.input(|i| {
            for event in &i.events {
                match event {
                    Event::Key {
                        key,
                        pressed,
                        repeat,
                        ..
                    } => {
                        if !repeat {
                            if let Some(scancode) = egui_key_to_scancode(*key) {
                                let sm = Arc::clone(session_manager);
                                let sid = self.id;
                                let input_evt = scancode_to_event(scancode, *pressed);
                                tokio_handle.spawn(async move {
                                    sm.send_input(sid, input_evt).await;
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        });
    }
}
