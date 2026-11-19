#[derive(Debug, Clone)]
pub struct RdpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub desktop_width: u16,
    pub desktop_height: u16,
    pub desktop_scale_factor: u32,
    pub enable_nla: bool,
    pub enable_gfx: bool,
    pub enable_mic: bool,
    pub enable_audio: bool,
    pub enable_camera: bool,
    pub enable_clipboard: bool,
}

impl RdpConfig {
    pub fn new(host: impl Into<String>, username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            port: 3389,
            username: username.into(),
            password: password.into(),
            domain: None,
            desktop_width: 1920,
            desktop_height: 1080,
            desktop_scale_factor: 100,
            enable_nla: true,
            enable_gfx: true,
            enable_mic: true,
            enable_audio: true,
            enable_camera: true,
            enable_clipboard: true,
        }
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    pub fn with_domain(mut self, domain: impl Into<String>) -> Self {
        self.domain = Some(domain.into());
        self
    }

    pub fn with_resolution(mut self, width: u16, height: u16) -> Self {
        self.desktop_width = width;
        self.desktop_height = height;
        self
    }

    pub fn with_scale_factor(mut self, scale: u32) -> Self {
        self.desktop_scale_factor = scale;
        self
    }

    pub fn with_nla(mut self, enable_nla: bool) -> Self {
        self.enable_nla = enable_nla;
        self
    }

    pub fn with_mic(mut self, enable_mic: bool) -> Self {
        self.enable_mic = enable_mic;
        self
    }

    pub fn with_audio(mut self, enable_audio: bool) -> Self {
        self.enable_audio = enable_audio;
        self
    }

    pub fn with_camera(mut self, enable_camera: bool) -> Self {
        self.enable_camera = enable_camera;
        self
    }

    pub fn with_clipboard(mut self, enable_clipboard: bool) -> Self {
        self.enable_clipboard = enable_clipboard;
        self
    }

    pub fn server_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}
