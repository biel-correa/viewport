use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use ironrdp_pdu::input::fast_path::FastPathInputEvent;
use tokio::sync::{mpsc, watch, RwLock};
use tracing::{error, info, warn};

use crate::config::RdpConfig;
use crate::session::{DamageRegion, RdpSession, SessionEvent, SharedFrameBuffer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub u64);

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Session-{}", self.0)
    }
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStatus {
    Disconnected,
    Connecting,
    Connected { width: u16, height: u16 },
    Error(String),
}

impl std::fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected => write!(f, "Disconnected"),
            Self::Connecting => write!(f, "Connecting..."),
            Self::Connected { width, height } => write!(f, "Connected ({}x{})", width, height),
            Self::Error(msg) => write!(f, "Error: {}", msg),
        }
    }
}

#[derive(Clone)]
pub struct SessionHandle {
    pub id: SessionId,
    pub config: RdpConfig,
    pub status: SessionStatus,
    /// Indicates if the tab has been detached into its own independent OS window.
    pub is_detached: bool,
    /// Indicates if the session view is currently in fullscreen mode.
    pub is_fullscreen: bool,
    pub framebuffer: Arc<RwLock<SharedFrameBuffer>>,
    pub input_tx: Option<mpsc::Sender<FastPathInputEvent>>,
    pub resize_tx: Option<mpsc::Sender<(u16, u16)>>,
    pub damage_rects: Vec<DamageRegion>,
    pub frame_version: u64,
}

impl SessionHandle {
    pub fn new(id: SessionId, config: RdpConfig) -> Self {
        let width = config.desktop_width;
        let height = config.desktop_height;
        Self {
            id,
            config,
            status: SessionStatus::Disconnected,
            is_detached: false,
            is_fullscreen: false,
            framebuffer: Arc::new(RwLock::new(SharedFrameBuffer::new(width, height))),
            input_tx: None,
            resize_tx: None,
            damage_rects: Vec::new(),
            frame_version: 0,
        }
    }

    pub fn display_name(&self) -> String {
        format!("{} ({}:{})", self.config.username, self.config.host, self.config.port)
    }
}

struct RunningSession {
    shutdown_tx: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

pub struct SessionManager {
    sessions: Arc<RwLock<HashMap<SessionId, SessionHandle>>>,
    active_tab: Arc<RwLock<Option<SessionId>>>,
    tasks: Arc<RwLock<HashMap<SessionId, RunningSession>>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            active_tab: Arc::new(RwLock::new(None)),
            tasks: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn sessions(&self) -> Arc<RwLock<HashMap<SessionId, SessionHandle>>> {
        Arc::clone(&self.sessions)
    }

    pub fn active_tab(&self) -> Arc<RwLock<Option<SessionId>>> {
        Arc::clone(&self.active_tab)
    }

    pub async fn add_session(&self, config: RdpConfig) -> SessionId {
        let id = SessionId(NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed));
        let handle = SessionHandle::new(id, config);
        let mut map = self.sessions.write().await;
        map.insert(id, handle);

        let mut active = self.active_tab.write().await;
        if active.is_none() {
            *active = Some(id);
        }
        id
    }

    pub async fn select_tab(&self, id: SessionId) {
        let mut active = self.active_tab.write().await;
        *active = Some(id);
    }

    pub async fn set_detached(&self, id: SessionId, detached: bool) {
        let mut map = self.sessions.write().await;
        if let Some(handle) = map.get_mut(&id) {
            handle.is_detached = detached;
        }
    }

    pub async fn toggle_fullscreen(&self, id: SessionId) {
        let mut map = self.sessions.write().await;
        if let Some(handle) = map.get_mut(&id) {
            handle.is_fullscreen = !handle.is_fullscreen;
        }
    }

    pub async fn connect(&self, id: SessionId) {
        self.stop_session_task(id).await;

        let config = {
            let mut map = self.sessions.write().await;
            if let Some(handle) = map.get_mut(&id) {
                handle.status = SessionStatus::Connecting;
                handle.config.clone()
            } else {
                return;
            }
        };

        let (session, input_rx, resize_rx) = RdpSession::new(config);
        let fb = session.framebuffer();
        let input_sender = session.input_sender();
        let resize_sender = session.resize_sender();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        {
            let mut map = self.sessions.write().await;
            if let Some(handle) = map.get_mut(&id) {
                handle.framebuffer = fb;
                handle.input_tx = Some(input_sender);
                handle.resize_tx = Some(resize_sender);
            }
        }

        let (event_tx, mut event_rx) = mpsc::channel(128);
        let sessions_clone = Arc::clone(&self.sessions);

        // Spawn connection and protocol engine task
        let task = tokio::spawn(async move {
            info!("Starting session task for {}", id);
            if let Err(e) = session.run(input_rx, resize_rx, shutdown_rx, event_tx).await {
                error!("Session {} error: {:?}", id, e);
                let mut map = sessions_clone.write().await;
                if let Some(h) = map.get_mut(&id) {
                    h.status = SessionStatus::Error(format!("{:#}", e));
                }
            }
            info!("Session task for {} exited", id);
        });

        self.tasks
            .write()
            .await
            .insert(id, RunningSession { shutdown_tx, task });

        // Event listener task
        let sessions_for_events = Arc::clone(&self.sessions);
        tokio::spawn(async move {
            while let Some(evt) = event_rx.recv().await {
                let mut map = sessions_for_events.write().await;
                let Some(handle) = map.get_mut(&id) else {
                    break;
                };

                match evt {
                    SessionEvent::Connected { width, height } => {
                        info!("Session {} connected ({}x{})", id, width, height);
                        handle.config.desktop_width = width;
                        handle.config.desktop_height = height;
                        handle.status = SessionStatus::Connected { width, height };
                    }
                    SessionEvent::FrameUpdated { damage_rects } => {
                        handle.damage_rects = damage_rects;
                        handle.frame_version = handle.frame_version.wrapping_add(1);
                    }
                    SessionEvent::Disconnected { reason } => {
                        warn!("Session {} disconnected: {}", id, reason);
                        handle.status = SessionStatus::Disconnected;
                        handle.input_tx = None;
                        handle.resize_tx = None;
                        break;
                    }
                }
            }
        });
    }

    async fn stop_session_task(&self, id: SessionId) {
        let running = self.tasks.write().await.remove(&id);
        if let Some(RunningSession { shutdown_tx, mut task }) = running {
            let _ = shutdown_tx.send(true);
            tokio::select! {
                _ = &mut task => {}
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(300)) => {
                    warn!("Session {} did not exit gracefully within 300ms; aborting task", id);
                    task.abort();
                }
            }
        }
    }

    pub async fn disconnect(&self, id: SessionId) {
        {
            let mut map = self.sessions.write().await;
            if let Some(handle) = map.get_mut(&id) {
                handle.status = SessionStatus::Disconnected;
                handle.input_tx = None;
                handle.resize_tx = None;
            }
        }
        self.stop_session_task(id).await;
    }

    pub async fn disconnect_all(&self) {
        let ids: Vec<SessionId> = self.sessions.read().await.keys().copied().collect();
        for id in ids {
            self.disconnect(id).await;
        }
    }

    pub async fn remove_session(&self, id: SessionId) {
        self.disconnect(id).await;
        let mut map = self.sessions.write().await;
        map.remove(&id);

        let mut active = self.active_tab.write().await;
        if *active == Some(id) {
            *active = map.keys().next().copied();
        }
    }

    pub async fn send_input(&self, id: SessionId, event: FastPathInputEvent) {
        let sender = {
            let map = self.sessions.read().await;
            map.get(&id).and_then(|h| h.input_tx.clone())
        };

        if let Some(tx) = sender {
            let _ = tx.send(event).await;
        }
    }

    pub async fn send_resize(&self, id: SessionId, width: u16, height: u16) {
        let sender = {
            let map = self.sessions.read().await;
            map.get(&id).and_then(|h| h.resize_tx.clone())
        };

        if let Some(tx) = sender {
            let _ = tx.send((width, height)).await;
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_session_lifecycle() {
        let manager = SessionManager::new();
        let config = RdpConfig::new("192.168.1.50", "admin", "secret")
            .with_port(3389)
            .with_resolution(1920, 1080);

        let s1 = manager.add_session(config.clone()).await;
        let s2 = manager.add_session(config.clone()).await;

        assert_ne!(s1, s2);
        assert_eq!(*manager.active_tab().read().await, Some(s1));

        manager.select_tab(s2).await;
        assert_eq!(*manager.active_tab().read().await, Some(s2));

        manager.set_detached(s1, true).await;
        {
            let sessions = manager.sessions();
            let map = sessions.read().await;
            assert!(map.get(&s1).unwrap().is_detached);
            assert!(!map.get(&s2).unwrap().is_detached);
        }

        manager.toggle_fullscreen(s2).await;
        {
            let sessions = manager.sessions();
            let map = sessions.read().await;
            assert!(map.get(&s2).unwrap().is_fullscreen);
        }

        manager.remove_session(s2).await;
        assert_eq!(*manager.active_tab().read().await, Some(s1));
    }

    #[tokio::test]
    async fn test_disconnect_stops_session_task() {
        let manager = SessionManager::new();
        let config = RdpConfig::new("127.0.0.1", "admin", "secret").with_port(1);
        let id = manager.add_session(config).await;

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let completed_flag = Arc::clone(&completed);

        let task = tokio::spawn(async move {
            let _ = shutdown_rx.changed().await;
            completed_flag.store(true, Ordering::SeqCst);
        });

        manager
            .tasks
            .write()
            .await
            .insert(id, RunningSession { shutdown_tx, task });

        manager.disconnect(id).await;

        assert!(completed.load(Ordering::SeqCst));
        assert!(!manager.tasks.read().await.contains_key(&id));
    }
}
