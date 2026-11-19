//! ViewPort Core Protocol Engine
//!
//! Provides the core RDP connection state machines, session management,
//! and protocol message routing.

pub mod camera;
pub mod clipboard;
pub mod config;
pub mod connector;
pub mod manager;
pub mod session;
pub mod wol;

pub use camera::MacCameraBackend;
pub use config::RdpConfig;
pub use manager::{SessionHandle, SessionId, SessionManager, SessionStatus};
pub use session::{DamageRegion, RdpSession, SessionEvent, SharedFrameBuffer};




