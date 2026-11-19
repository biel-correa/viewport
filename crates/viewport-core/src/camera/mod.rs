use std::sync::{Arc, Mutex};
use ironrdp_rdpecam::client::{CameraBackend, SampleSink};
use ironrdp_rdpecam::pdu::{
    ErrorCode, MediaFormat, MediaType, PropertyDescription, PropertyId, PropertySet, PropertyValue,
    StartStreamInfo, StreamDescription,
};
use tracing::{debug, info, warn};

#[cfg(target_os = "macos")]
extern "C" {
    fn mac_camera_create(
        width: u32,
        height: u32,
        fps: u32,
        callback: extern "C" fn(*const u8, usize, *mut std::ffi::c_void),
        user_data: *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void;

    fn mac_camera_start(handle: *mut std::ffi::c_void);
    fn mac_camera_stop(handle: *mut std::ffi::c_void);
    fn mac_camera_destroy(handle: *mut std::ffi::c_void);
}

#[cfg(target_os = "macos")]
extern "C" fn on_mac_camera_frame(data: *const u8, len: usize, user_data: *mut std::ffi::c_void) {
    if data.is_null() || len == 0 || user_data.is_null() {
        return;
    }
    unsafe {
        let sink_lock = &*(user_data as *const Mutex<Option<SampleSink>>);
        if let Ok(guard) = sink_lock.lock() {
            if let Some(ref sink) = *guard {
                if sink.is_active() && sink.pending_requests(0) > 0 {
                    let bytes = std::slice::from_raw_parts(data, len).to_vec();
                    let _ = sink.send_sample(0, bytes);
                }
            }
        }
    }
}

pub struct MacCameraBackend {
    #[cfg(target_os = "macos")]
    handle: Option<*mut std::ffi::c_void>,
    sink: Arc<Mutex<Option<SampleSink>>>,
    activated: bool,
    streaming: bool,
}

unsafe impl Send for MacCameraBackend {}

impl MacCameraBackend {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            handle: None,
            sink: Arc::new(Mutex::new(None)),
            activated: false,
            streaming: false,
        }
    }
}

impl Default for MacCameraBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for MacCameraBackend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl CameraBackend for MacCameraBackend {
    fn activate(&mut self) -> Result<(), ErrorCode> {
        info!("MacCameraBackend: activating camera");
        self.activated = true;
        Ok(())
    }

    fn deactivate(&mut self) -> Result<(), ErrorCode> {
        info!("MacCameraBackend: deactivating camera");
        self.stop_streams()?;
        self.activated = false;
        Ok(())
    }

    fn streams(&mut self) -> Result<Vec<StreamDescription>, ErrorCode> {
        Ok(vec![StreamDescription::color(true, true)])
    }

    fn media_types(&mut self, stream_index: u8) -> Result<Vec<MediaType>, ErrorCode> {
        if stream_index != 0 {
            return Err(ErrorCode::InvalidStreamNumber);
        }

        // Advertise MJPEG (standard for USB/webcam redirection supported by Windows RDP)
        let mjpg_720p = MediaType::new(
            MediaFormat::Mjpg,
            1280,
            720,
            30,
            1,
            1,
            1,
            MediaType::DECODING_REQUIRED,
        )
        .map_err(|_| ErrorCode::InvalidMediaType)?;

        let mjpg_480p = MediaType::new(
            MediaFormat::Mjpg,
            640,
            480,
            30,
            1,
            1,
            1,
            MediaType::DECODING_REQUIRED,
        )
        .map_err(|_| ErrorCode::InvalidMediaType)?;

        Ok(vec![mjpg_720p, mjpg_480p])
    }

    fn current_media_type(&mut self, stream_index: u8) -> Result<MediaType, ErrorCode> {
        self.media_types(stream_index)?
            .into_iter()
            .next()
            .ok_or(ErrorCode::InvalidMediaType)
    }

    fn start_streams(
        &mut self,
        streams: &[StartStreamInfo],
        sink: SampleSink,
    ) -> Result<(), ErrorCode> {
        let stream = streams.first().ok_or(ErrorCode::InvalidRequest)?;
        if stream.stream_index != 0 {
            return Err(ErrorCode::InvalidStreamNumber);
        }

        info!(
            "MacCameraBackend: starting streams at {}x{} (format: {:?})",
            stream.media_type.width, stream.media_type.height, stream.media_type.format
        );

        *self.sink.lock().unwrap_or_else(|p| p.into_inner()) = Some(sink);

        #[cfg(target_os = "macos")]
        {
            if let Some(old) = self.handle.take() {
                unsafe {
                    mac_camera_destroy(old);
                }
            }

            let user_data = Arc::as_ptr(&self.sink) as *mut std::ffi::c_void;
            let handle = unsafe {
                mac_camera_create(
                    stream.media_type.width,
                    stream.media_type.height,
                    30,
                    on_mac_camera_frame,
                    user_data,
                )
            };

            if handle.is_null() {
                warn!("MacCameraBackend: failed to create AVFoundation camera capture");
                return Err(ErrorCode::NotInitialized);
            }

            unsafe {
                mac_camera_start(handle);
            }
            self.handle = Some(handle);
        }

        self.streaming = true;
        Ok(())
    }

    fn stop_streams(&mut self) -> Result<(), ErrorCode> {
        info!("MacCameraBackend: stopping streams");
        let _ = self.sink.lock().unwrap_or_else(|p| p.into_inner()).take();

        #[cfg(target_os = "macos")]
        {
            if let Some(handle) = self.handle.take() {
                unsafe {
                    mac_camera_stop(handle);
                    mac_camera_destroy(handle);
                }
            }
        }

        self.streaming = false;
        Ok(())
    }

    fn sample_requested(&mut self, _stream_index: u8) {
        debug!("MacCameraBackend: server requested sample");
    }

    fn properties(&mut self) -> Result<Vec<PropertyDescription>, ErrorCode> {
        Ok(Vec::new())
    }

    fn property_value(
        &mut self,
        _property_set: PropertySet,
        _property_id: PropertyId,
    ) -> Result<PropertyValue, ErrorCode> {
        Err(ErrorCode::ItemNotFound)
    }

    fn set_property_value(
        &mut self,
        _property_set: PropertySet,
        _property_id: PropertyId,
        _value: PropertyValue,
    ) -> Result<(), ErrorCode> {
        Err(ErrorCode::OperationNotSupported)
    }

    fn shutdown(&mut self) {
        let _ = self.stop_streams();
        self.activated = false;
    }
}
