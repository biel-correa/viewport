# Multi-Session, Tabbed Interface & Fullscreen Management

This document details how **ViewPort** manages multiple concurrent RDP connections, provides a tabbed UI with detachable windows, and implements fullscreen mode with dynamic resolution resizing (`MS-RDPEDISP`).

---

## 1. High-Level Architecture

The multi-session architecture separates **logical sessions** (the network connection and decoding pipeline) from **presentation targets** (tabs or independent OS windows).

```mermaid
flowchart TD
    subgraph Manager ["SessionManager (Central Coordinator)"]
        SM["SessionManager"]
        S1["Session 1: 'Prod-DB' (Tokio Task)"]
        S2["Session 2: 'Dev-Box' (Tokio Task)"]
        S3["Session 3: 'Windows 11' (Tokio Task)"]
    end

    subgraph Windowing ["winit / wgpu Windowing Layer"]
        Win1["Window 1 (Tabbed Window)"]
        TabStrip["Tab Strip [Prod-DB | Dev-Box]"]
        Surf1["wgpu::Surface 1"]
        
        Win2["Window 2 (Detached Window)"]
        Surf2["wgpu::Surface 2"]
    end

    SM --> S1
    SM --> S2
    SM --> S3

    TabStrip -->|Active Tab| S1
    S1 -->|Renders to| Surf1
    S2 -.->|Background updates| Surf1

    S3 -->|Renders to| Surf2
    Win2 -->|Fullscreen or Detached| S3
```

---

## 2. Multi-Session Concurrency Model

Each RDP connection is isolated in its own asynchronous Tokio task. A network hiccup or protocol error on one connection never impacts other active sessions.

### Session Identification & State Management

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub u64);

pub enum SessionStatus {
    Connecting,
    Active { latency_ms: u32 },
    Reconnecting { attempt: u32 },
    Disconnected { reason: String },
}

pub struct SessionHandle {
    pub id: SessionId,
    pub title: String,
    pub host: String,
    pub status: SessionStatus,
    /// Channel to send user inputs (keyboard, mouse) to this session's Tokio task
    pub input_tx: mpsc::Sender<InputEvent>,
    /// Shared texture/framebuffer containing the latest decoded desktop image
    pub framebuffer: Arc<RwLock<GpuFrameBuffer>>,
}

pub struct SessionManager {
    sessions: HashMap<SessionId, SessionHandle>,
    next_id: u64,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_id: 1,
        }
    }

    pub fn create_session(&mut self, config: RdpSessionConfig) -> SessionId {
        let id = SessionId(self.next_id);
        self.next_id += 1;

        let (input_tx, input_rx) = mpsc::channel(256);
        let framebuffer = Arc::new(RwLock::new(GpuFrameBuffer::new(config.width, config.height)));

        // Spawn isolated Tokio task for this session
        let fb_clone = Arc::clone(&framebuffer);
        tokio::spawn(async move {
            if let Err(e) = run_rdp_session_worker(config, input_rx, fb_clone).await {
                tracing::error!("Session {:?} failed: {:?}", id, e);
            }
        });

        self.sessions.insert(id, SessionHandle {
            id,
            title: config.host.clone(),
            host: config.host,
            status: SessionStatus::Connecting,
            input_tx,
            framebuffer,
        });

        id
    }
}
```

---

## 3. Tabbed UI & Switching Mechanism

The application UI supports tabbed navigation (replicating `SessionWindowManager` in Microsoft Windows App):

### Tab Strip Features
- **Visual Status Indicator**:
  - 🟢 Green: Active, connected (shows round-trip latency, e.g. `18ms`).
  - 🟡 Yellow: Connecting / Auto-reconnecting.
  - 🔴 Red: Disconnected / Error.
- **Close Button**: Sends a graceful `Disconnect` PDU to the server before closing the tab.
- **Add Tab (+)**: Opens the quick-connect dialog or bookmark picker.

### Tab Switching Logic
1. When switching from Tab A to Tab B:
   - The UI redirects the host input listener (`winit` keyboard/mouse events) to Tab B's `input_tx`.
   - The renderer switches its active texture binding to Tab B's `framebuffer`.
2. **Background Throttling**:
   - Active Tab: Renders at full display refresh rate (e.g. 60 Hz or 120 Hz ProMotion on Mac).
   - Inactive (Background) Tabs: Continue decoding incoming frames to keep state current, but throttle GPU blitting and damage uploads to save battery and GPU cycles.

---

## 4. Detachable Windows (Docking & Undocking)

Users can drag a tab out of the tab strip to spawn an independent OS window, or drag a window back onto a tab strip to re-dock it.

```mermaid
stateDiagram-v2
    TabbedSession --> DraggingTab : Mouse Drag past TabStrip threshold
    DraggingTab --> DetachedWindow : Mouse Released outside window
    DraggingTab --> TabbedSession : Mouse Released inside TabStrip
    DetachedWindow --> DraggingWindow : Drag window into another TabStrip
    DraggingWindow --> TabbedSession : Merged back into Tab
```

### Multi-Window Handling in `winit`

`winit` natively supports multi-window applications where each window has a unique `WindowId`:

```rust
use winit::window::{Window, WindowId};
use std::collections::HashMap;

pub enum ViewMode {
    Tabbed { tab_index: usize },
    Detached,
    FullScreen,
}

pub struct PresentationWindow {
    pub window: Arc<Window>,
    pub surface: wgpu::Surface<'static>,
    pub current_session_id: Option<SessionId>,
    pub tabs: Vec<SessionId>,
}

pub struct WindowManager {
    pub windows: HashMap<WindowId, PresentationWindow>,
}

impl WindowManager {
    /// Detach a session into its own independent OS window
    pub fn detach_session_to_new_window(
        &mut self,
        session_id: SessionId,
        event_loop: &winit::event_loop::ActiveEventLoop,
        gpu_instance: &wgpu::Instance,
    ) -> Result<WindowId, anyhow::Error> {
        // 1. Create a new independent native window
        let window_attrs = Window::default_attributes()
            .with_title(format!("ViewPort - Session {}", session_id.0))
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 800.0));
        
        let window = Arc::new(event_loop.create_window(window_attrs)?);
        let window_id = window.id();

        // 2. Create a dedicated wgpu surface for this new window
        let surface = gpu_instance.create_surface(Arc::clone(&window))?;

        // 3. Register presentation target
        self.windows.insert(window_id, PresentationWindow {
            window,
            surface,
            current_session_id: Some(session_id),
            tabs: vec![session_id],
        });

        Ok(window_id)
    }
}
```

---

## 5. Fullscreen Mode & Dynamic Resolution (`MS-RDPEDISP`)

Entering fullscreen should not merely stretch an existing low-resolution image (which looks pixelated) or show black letterbox bars. Instead, it must dynamically resize the remote Windows desktop on the fly.

### The Display Update Virtual Channel (`MS-RDPEDISP`)
Microsoft defines `MS-RDPEDISP` specifically for on-the-fly resolution adjustments without session reconnection.

```mermaid
sequenceDiagram
    autonumber
    participant Client as ViewPort Client (macOS)
    participant Server as Remote Windows Host

    Note over Client: User clicks Fullscreen (or Green Zoom button)
    Client->>Client: window.set_fullscreen(Some(Fullscreen::Borderless(None)))
    Client->>Client: Detect physical display resolution (e.g. 2560x1440, Scale: 200%)

    Client->>Server: DVC 'Microsoft::Windows::RDS::DisplayControl'
    Client->>Server: DISPLAYCONTROL_MONITOR_LAYOUT_PDU (Width: 2560, Height: 1440, Scale: 200)

    Server->>Server: Windows Desktop Window Manager (DWM) resizes remote desktop
    Server->>Client: RDPGFX_RESET_GRAPHICS_PDU (New Surface: 2560x1440)
    Server->>Client: Stream new desktop frames at native 2560x1440 resolution!
    Note over Client: Pixel-perfect fullscreen presentation with no distortion!
```

### Display Control PDU Structure

```rust
// crates/viewport-channels/src/display_control.rs
use ironrdp_pdu::PduEncode;

#[repr(C)]
pub struct MonitorLayout {
    pub flags: u32,       // 0x00000001 = Primary Monitor
    pub left: i32,
    pub top: i32,
    pub width: u32,       // Native monitor width in pixels (e.g. 2560)
    pub height: u32,      // Native monitor height in pixels (e.g. 1440)
    pub physical_width: u32,  // mm
    pub physical_height: u32, // mm
    pub orientation: u32, // 0 = Landscape, 90 = Portrait, etc.
    pub desktop_scale_factor: u32, // e.g. 200 for 2x Retina
    pub device_scale_factor: u32,
}

pub struct DisplayControlMonitorLayoutPdu {
    pub monitors: Vec<MonitorLayout>,
}
```

### Fullscreen Window Configuration

In `winit`, toggling fullscreen on macOS integrates directly with native macOS Spaces:

```rust
impl PresentationWindow {
    pub fn toggle_fullscreen(&self) {
        if self.window.fullscreen().is_some() {
            // Restore windowed mode
            self.window.set_fullscreen(None);
        } else {
            // Enter native macOS borderless fullscreen space
            self.window.set_fullscreen(Some(winit::window::Fullscreen::Borderless(None)));
        }
    }
}
```

---

## 6. Multi-Monitor Spanning (Optional Advanced Mode)

When multiple physical Mac monitors are connected, ViewPort can configure:
1. **Single-Monitor Fullscreen**: Session occupies only the selected monitor.
2. **Multi-Monitor Spanning**: Sends multiple `MonitorLayout` entries in the `DISPLAYCONTROL_MONITOR_LAYOUT_PDU`, telling Windows to treat the Mac screens as a multi-monitor desktop array.
