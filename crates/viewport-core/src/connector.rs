use std::sync::Arc;
use std::sync::atomic::AtomicI64;

use anyhow::{Context, Result};
use ironrdp_cliprdr::backend::ClipboardMessage;
use ironrdp_cliprdr::CliprdrClient;
use ironrdp_connector as connector;
use ironrdp_connector::{BitmapConfig, ClientConnector, ConnectionOutcome, ServerName};
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_dvc::DrdynvcClient;
use ironrdp_pdu::gcc::{ChannelName, ChannelOptions, ConnectionType, KeyboardType};
use ironrdp_pdu::rdp::capability_sets::{client_codecs_capabilities, MajorPlatformType, RailSupportLevel};
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp_pdu::PduResult;
use ironrdp_svc::{CompressionCondition, SvcClientProcessor, SvcMessage, SvcProcessor};
use ironrdp_tokio::TokioFramed;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tracing::info;

use crate::camera::MacCameraBackend;
use crate::clipboard::MacClipboardBackend;
use crate::config::RdpConfig;

/// Builds an `ironrdp_connector::Config` from our client `RdpConfig`.
/// Wraps an [`SvcClientProcessor`] so its static virtual channel advertises
/// `INITIALIZED | ENCRYPT_RDP` options in GCC Client Network Data, matching MSTSC.
#[derive(Debug)]
pub(crate) struct InitializedChannel<P>(pub(crate) P);

impl<P: 'static> ironrdp_core::AsAny for InitializedChannel<P> {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl<P: SvcProcessor + 'static> SvcProcessor for InitializedChannel<P> {
    fn channel_name(&self) -> ChannelName {
        self.0.channel_name()
    }

    fn compression_condition(&self) -> CompressionCondition {
        self.0.compression_condition()
    }

    fn channel_options(&self) -> ChannelOptions {
        ChannelOptions::INITIALIZED | ChannelOptions::ENCRYPT_RDP | self.0.channel_options()
    }

    fn start(&mut self) -> PduResult<Vec<SvcMessage>> {
        self.0.start()
    }

    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        self.0.process(payload)
    }
}

impl<P: SvcClientProcessor + 'static> SvcClientProcessor for InitializedChannel<P> {}

/// No-op EGFX handler; `ActiveStage` drains `GraphicsPipelineClient` into `DecodedImage`.
struct NoopGfxHandler;

impl ironrdp_egfx::client::GraphicsPipelineHandler for NoopGfxHandler {}

pub fn create_connector_config(config: &RdpConfig) -> connector::Config {
    let (domain, username) = if config.domain.is_some() {
        (config.domain.clone(), config.username.clone())
    } else if let Some((dom, user)) = config.username.split_once('\\') {
        (
            if dom.is_empty() { None } else { Some(dom.to_owned()) },
            user.to_owned(),
        )
    } else {
        (None, config.username.clone())
    };

    let codecs = client_codecs_capabilities(&[]).expect("default client codecs");

    connector::Config {
        desktop_size: connector::DesktopSize {
            width: config.desktop_width,
            height: config.desktop_height,
        },
        monitor_layout: None,
        desktop_scale_factor: config.desktop_scale_factor,
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: None,
        monitor_extended_layout: None,
        relative_mouse_input: false,
        enable_tls: true,
        enable_credssp: config.enable_nla,
        enable_standard_rdp_security: false,
        credentials: connector::Credentials::UsernamePassword {
            username,
            password: config.password.clone(),
        },
        domain,
        client_build: 26100,
        client_name: "ViewPortClient".to_owned(),
        keyboard_type: KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409, // US English
        connection_type: ConnectionType::Lan,
        ime_file_name: "".to_owned(),
        bitmap: Some(BitmapConfig {
            lossy_compression: true,
            color_depth: 32,
            codecs,
        }),
        dig_product_id: "".to_owned(),
        client_dir: "".to_owned(),
        alternate_shell: "".to_owned(),
        work_dir: "".to_owned(),
        remote_application_mode: false,
        rail_support_level: RailSupportLevel::empty(),
        platform: MajorPlatformType::OSX,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: config.enable_audio,
        enable_audio_capture: config.enable_mic,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        enable_server_pointer: false,
        pointer_software_rendering: false,
        multitransport_flags: None,
        support_dyn_vc_gfx_protocol: true,
    }
}

/// Dummy network client used when Kerberos KDC lookup is unconfigured (standard NLA / NTLM).
pub struct NoopNetworkClient;

impl ironrdp_async::NetworkClient for NoopNetworkClient {
    async fn send(
        &mut self,
        _network_request: &ironrdp_connector::sspi::generator::NetworkRequest,
    ) -> ironrdp_connector::ConnectorResult<Vec<u8>> {
        Err(ironrdp_connector::general_err!(
            "Kerberos KDC network lookup not configured; falling back to NTLM"
        ))
    }
}

pub type RdpStream = ironrdp_tls::TlsStream<TcpStream>;

pub struct ClipboardChannelState {
    pub rx: mpsc::UnboundedReceiver<ClipboardMessage>,
    pub last_change_count: Arc<AtomicI64>,
}

/// Executes the RDP connection handshake: X.224 -> TLS upgrade -> CredSSP/NLA -> MCS -> Capabilities.
pub async fn establish_connection(
    config: &RdpConfig,
) -> Result<(
    TokioFramed<RdpStream>,
    ConnectionOutcome,
    mpsc::UnboundedReceiver<Vec<SvcMessage>>,
    Option<ClipboardChannelState>,
)> {
    let server_addr = config.server_addr();
    info!("Establishing TCP connection to {}", server_addr);

    let tcp_stream = TcpStream::connect(&server_addr)
        .await
        .with_context(|| format!("Failed to connect to {}", server_addr))?;

    let _ = tcp_stream.set_nodelay(true);

    let client_addr = tcp_stream.local_addr()?;
    let mut framed = TokioFramed::new(tcp_stream);

    let (dvc_tx, dvc_rx) = mpsc::unbounded_channel::<Vec<SvcMessage>>();

    let connector_config = create_connector_config(config);
    let client_name = connector_config.client_name.clone();
    let mut drdynvc = DrdynvcClient::new()
        .with_dynamic_channel(ironrdp_echo::client::EchoClient::new())
        .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())))
        .with_dynamic_channel(ironrdp_egfx::client::GraphicsPipelineClient::new(
            Box::new(NoopGfxHandler),
            None,
        ));

    if config.enable_audio {
        info!("Registering RDPSND audio playback dynamic channels (AUDIO_PLAYBACK_DVC / AUDIO_PLAYBACK_LOSSY_DVC)");
        let playback_backend = ironrdp_rdpsnd_native::cpal::RdpsndBackend::new();
        let dvc_state = ironrdp_rdpsnd::client::RdpsndDvcState::new(Box::new(playback_backend));

        let dvc_state_rel = dvc_state.clone();
        drdynvc = drdynvc.with_dynamic_channel_factory(
            ironrdp_rdpsnd::client::DVC_CHANNEL_NAME,
            move || dvc_state_rel.channel(),
        );

        let dvc_state_lossy = dvc_state.clone();
        drdynvc = drdynvc.with_dynamic_channel_factory(
            ironrdp_rdpsnd::client::LOSSY_DVC_CHANNEL_NAME,
            move || dvc_state_lossy.lossy_channel(),
        );
    }

    if config.enable_mic {
        info!("Registering RDPEAI microphone redirection channel factory");
        let dvc_tx_mic = dvc_tx.clone();
        drdynvc = drdynvc.with_dynamic_channel_factory(
            ironrdp_rdpeai::CHANNEL_NAME,
            move || {
                let tx = dvc_tx_mic.clone();
                let mic_uplink: ironrdp_rdpeai::client::DvcUplink =
                    Box::new(move |_channel_id, svc_messages| {
                        let _ = tx.send(svc_messages);
                        Ok(())
                    });
                let capture_backend = ironrdp_rdpsnd_native::RdpeaiCaptureBackend::new();
                ironrdp_rdpeai::client::RdpeaiClient::new(
                    Box::new(capture_backend),
                    mic_uplink,
                )
            },
        );
    }

    if config.enable_camera {
        info!("Registering RDPECAM webcam redirection channel");
        let dvc_tx_cam = dvc_tx.clone();
        let cam_uplink: ironrdp_rdpecam::SampleUplink =
            Arc::new(move |_channel_id, svc_messages| {
                let _ = dvc_tx_cam.send(svc_messages);
                Ok(())
            });

        let cam_session = ironrdp_rdpecam::CameraRedirectionSession::new();
        let descriptor = ironrdp_rdpecam::DeviceDescriptor::new(
            "Mac FaceTime HD Camera".to_string(),
            "rdpecam_mac".to_string(),
        )
        .context("Failed to create camera descriptor")?;

        let redirected_device = cam_session
            .select_device(descriptor)
            .context("Failed to select camera device")?;

        let enum_client = cam_session
            .enumeration_client(vec![redirected_device.clone()])
            .context("Failed to create camera enumeration client")?;

        drdynvc = drdynvc.with_dynamic_channel(enum_client);

        let listener = redirected_device.listener(
            move || Some(MacCameraBackend::new()),
            cam_uplink,
        );
        drdynvc = drdynvc.with_listener(listener);
    }

    let mut connector = ClientConnector::new(connector_config, client_addr)
        .with_static_channel(drdynvc)
        .with_static_channel(InitializedChannel(ironrdp_rdpdr::Rdpdr::new(
            Box::new(ironrdp_rdpdr::NoopRdpdrBackend {}),
            client_name,
        )));

    if config.enable_audio {
        info!("Registering RDPSND audio playback static channel");
        let playback_backend = ironrdp_rdpsnd_native::cpal::RdpsndBackend::new();
        let rdpsnd = ironrdp_rdpsnd::client::Rdpsnd::new(Box::new(playback_backend));
        connector = connector.with_static_channel(InitializedChannel(rdpsnd));
    }

    let clipboard_state = if config.enable_clipboard {
        info!("Registering CLIPRDR clipboard synchronization static channel");
        let (clip_tx, clip_rx) = mpsc::unbounded_channel::<ClipboardMessage>();
        let last_change_count = Arc::new(AtomicI64::new(0));
        let backend = Box::new(MacClipboardBackend::new(
            clip_tx,
            Arc::clone(&last_change_count),
        ));
        let cliprdr = CliprdrClient::new(backend);
        connector = connector.with_static_channel(InitializedChannel(cliprdr));
        Some(ClipboardChannelState {
            rx: clip_rx,
            last_change_count,
        })
    } else {
        None
    };

    info!("Starting X.224 negotiation...");
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .context("X.224 negotiation failed")?;

    info!("Upgrading connection to TLS...");
    let (tcp_stream, _leftover) = framed.into_inner();
    let (tls_stream, server_cert) = ironrdp_tls::upgrade(tcp_stream, &config.host)
        .await
        .context("TLS handshake failed")?;

    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&server_cert)
        .context("Unable to extract server public key from TLS certificate")?
        .to_vec();

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut tls_framed = TokioFramed::new(tls_stream);

    info!("Starting CredSSP/NLA authentication and capability finalization...");
    let mut network_client = NoopNetworkClient;
    let server_name = ServerName::new(&config.host);

    let outcome = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut tls_framed,
        &mut network_client,
        server_name,
        server_public_key,
        None,
    )
    .await
    .context("Connection finalization and authentication failed")?;

    info!("RDP connection successfully activated!");
    Ok((tls_framed, outcome, dvc_rx, clipboard_state))
}
