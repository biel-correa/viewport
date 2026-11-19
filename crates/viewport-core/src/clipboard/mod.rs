use std::io::Cursor;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use arboard::{Clipboard, ImageData};
use ironrdp_cliprdr::backend::{ClipboardMessage, CliprdrBackend};
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId, OwnedFormatDataResponse,
};
use ironrdp_cliprdr_format::bitmap::{dib_to_png, dibv5_to_png, png_to_cf_dib, png_to_cf_dibv5};
use ironrdp_core::impl_as_any;
use tokio::sync::mpsc;
use tracing::{debug, warn};

#[cfg(target_os = "macos")]
extern "C" {
    fn mac_pasteboard_change_count() -> i64;
}

/// Returns the current macOS general pasteboard change counter, or `0` on other platforms.
pub fn current_change_count() -> i64 {
    #[cfg(target_os = "macos")]
    {
        unsafe { mac_pasteboard_change_count() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Polls the OS pasteboard and returns formats to advertise if local content changed externally.
pub fn poll_local_clipboard_change(last_change_count: &AtomicI64) -> Option<Vec<ClipboardFormat>> {
    let count = current_change_count();
    let prev = last_change_count.load(Ordering::Relaxed);
    if count == prev {
        return None;
    }
    last_change_count.store(count, Ordering::Relaxed);
    let formats = available_local_formats();
    if formats.is_empty() {
        None
    } else {
        Some(formats)
    }
}

/// Native macOS `NSPasteboard` backend for IronRDP's `CLIPRDR` static virtual channel.
#[derive(Debug)]
pub struct MacClipboardBackend {
    tx: mpsc::UnboundedSender<ClipboardMessage>,
    last_change_count: Arc<AtomicI64>,
    temp_dir: String,
    pending_paste_format: Option<ClipboardFormatId>,
}

impl_as_any!(MacClipboardBackend);

impl MacClipboardBackend {
    pub fn new(
        tx: mpsc::UnboundedSender<ClipboardMessage>,
        last_change_count: Arc<AtomicI64>,
    ) -> Self {
        let temp_path = std::env::temp_dir().join("viewport-cliprdr");
        let _ = std::fs::create_dir_all(&temp_path);
        let temp_dir = temp_path.to_string_lossy().into_owned();
        last_change_count.store(current_change_count(), Ordering::Relaxed);
        Self {
            tx,
            last_change_count,
            temp_dir,
            pending_paste_format: None,
        }
    }

    fn record_local_write(&self) {
        self.last_change_count
            .store(current_change_count(), Ordering::Relaxed);
    }
}

impl CliprdrBackend for MacClipboardBackend {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }

    fn on_ready(&mut self) {
        debug!("CLIPRDR channel ready");
    }

    fn on_request_format_list(&mut self) {
        self.record_local_write();
        let formats = available_local_formats();
        if !formats.is_empty() {
            let _ = self.tx.send(ClipboardMessage::SendInitiateCopy(formats));
        }
    }

    fn on_process_negotiated_capabilities(&mut self, capabilities: ClipboardGeneralCapabilityFlags) {
        debug!(?capabilities, "Negotiated CLIPRDR capabilities");
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let preferred = select_preferred_remote_format(available_formats);
        if let Some(format_id) = preferred {
            debug!(?format_id, "Requesting remote clipboard data");
            self.pending_paste_format = Some(format_id);
            let _ = self.tx.send(ClipboardMessage::SendInitiatePaste(format_id));
        } else {
            self.pending_paste_format = None;
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = build_local_format_data(request.format);
        let _ = self.tx.send(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        let Some(format_id) = self.pending_paste_format.take() else {
            return;
        };
        if response.is_error() {
            debug!(?format_id, "Remote clipboard FormatDataResponse returned error");
            return;
        }

        if write_remote_format_to_local(format_id, &response) {
            self.record_local_write();
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        debug!(?request, "Ignoring unsupported file contents request");
        let _ = self.tx.send(ClipboardMessage::SendFileContentsResponse(
            FileContentsResponse::new_error(request.stream_id),
        ));
    }

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

fn available_local_formats() -> Vec<ClipboardFormat> {
    let Ok(mut clipboard) = Clipboard::new() else {
        return Vec::new();
    };
    if clipboard.get_text().is_ok_and(|s| !s.is_empty()) {
        return vec![
            ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
            ClipboardFormat::new(ClipboardFormatId::CF_TEXT),
        ];
    }
    if clipboard.get_image().is_ok() {
        return vec![
            ClipboardFormat::new(ClipboardFormatId::CF_DIB),
            ClipboardFormat::new(ClipboardFormatId::CF_DIBV5),
        ];
    }
    Vec::new()
}

fn select_preferred_remote_format(formats: &[ClipboardFormat]) -> Option<ClipboardFormatId> {
    let has = |id: ClipboardFormatId| formats.iter().any(|f| f.id() == id);
    if has(ClipboardFormatId::CF_UNICODETEXT) {
        Some(ClipboardFormatId::CF_UNICODETEXT)
    } else if has(ClipboardFormatId::CF_TEXT) {
        Some(ClipboardFormatId::CF_TEXT)
    } else if has(ClipboardFormatId::CF_DIBV5) {
        Some(ClipboardFormatId::CF_DIBV5)
    } else if has(ClipboardFormatId::CF_DIB) {
        Some(ClipboardFormatId::CF_DIB)
    } else {
        None
    }
}

fn build_local_format_data(format: ClipboardFormatId) -> OwnedFormatDataResponse {
    let Ok(mut clipboard) = Clipboard::new() else {
        return OwnedFormatDataResponse::new_error();
    };

    match format {
        ClipboardFormatId::CF_UNICODETEXT => match clipboard.get_text() {
            Ok(text) => OwnedFormatDataResponse::new_unicode_string(&normalize_crlf(&text)),
            Err(_) => OwnedFormatDataResponse::new_error(),
        },
        ClipboardFormatId::CF_TEXT => match clipboard.get_text() {
            Ok(text) => OwnedFormatDataResponse::new_string(&normalize_crlf(&text)),
            Err(_) => OwnedFormatDataResponse::new_error(),
        },
        ClipboardFormatId::CF_DIB | ClipboardFormatId::CF_DIBV5 => {
            let Ok(image) = clipboard.get_image() else {
                return OwnedFormatDataResponse::new_error();
            };
            let Ok(png_bytes) = rgba_to_png(image.width, image.height, &image.bytes) else {
                return OwnedFormatDataResponse::new_error();
            };
            let converted = if format == ClipboardFormatId::CF_DIBV5 {
                png_to_cf_dibv5(&png_bytes)
            } else {
                png_to_cf_dib(&png_bytes)
            };
            match converted {
                Ok(dib) => OwnedFormatDataResponse::new_data(dib),
                Err(e) => {
                    warn!("Failed to convert PNG to DIB: {}", e);
                    OwnedFormatDataResponse::new_error()
                }
            }
        }
        _ => OwnedFormatDataResponse::new_error(),
    }
}

fn write_remote_format_to_local(
    format: ClipboardFormatId,
    response: &FormatDataResponse<'_>,
) -> bool {
    let Ok(mut clipboard) = Clipboard::new() else {
        return false;
    };

    match format {
        ClipboardFormatId::CF_UNICODETEXT => match response.to_unicode_string() {
            Ok(text) => clipboard.set_text(normalize_lf(&text)).is_ok(),
            Err(e) => {
                warn!("Failed to decode CF_UNICODETEXT: {:?}", e);
                false
            }
        },
        ClipboardFormatId::CF_TEXT => match response.to_string() {
            Ok(text) => clipboard.set_text(normalize_lf(&text)).is_ok(),
            Err(e) => {
                warn!("Failed to decode CF_TEXT: {:?}", e);
                false
            }
        },
        ClipboardFormatId::CF_DIB | ClipboardFormatId::CF_DIBV5 => {
            let png_res = if format == ClipboardFormatId::CF_DIBV5 {
                dibv5_to_png(response.data())
            } else {
                dib_to_png(response.data())
            };
            let Ok(png_bytes) = png_res else {
                warn!("Failed to decode remote clipboard DIB");
                return false;
            };
            let Ok((width, height, rgba)) = png_to_rgba(&png_bytes) else {
                warn!("Failed to decode PNG from remote clipboard DIB");
                return false;
            };
            clipboard
                .set_image(ImageData {
                    width,
                    height,
                    bytes: rgba.into(),
                })
                .is_ok()
        }
        _ => false,
    }
}

fn normalize_crlf(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_cr = false;
    for ch in input.chars() {
        if ch == '\n' && !prev_cr {
            out.push('\r');
        }
        out.push(ch);
        prev_cr = ch == '\r';
    }
    out
}

fn normalize_lf(input: &str) -> String {
    input.replace("\r\n", "\n")
}

fn rgba_to_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let w = u32::try_from(width).map_err(|_| "image width overflow".to_string())?;
    let h = u32::try_from(height).map_err(|_| "image height overflow".to_string())?;
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn png_to_rgba(png_bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(Cursor::new(png_bytes));
    decoder.set_transformations(
        png::Transformations::ALPHA | png::Transformations::EXPAND | png::Transformations::STRIP_16,
    );
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size().ok_or_else(|| "unknown png size".to_string())?];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());

    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .chunks_exact(3)
            .flat_map(|c| [c[0], c[1], c[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => buf
            .chunks_exact(2)
            .flat_map(|c| [c[0], c[0], c[0], c[1]])
            .collect(),
        png::ColorType::Grayscale => buf.into_iter().flat_map(|g| [g, g, g, 255]).collect(),
        other => return Err(format!("unsupported PNG color type: {:?}", other)),
    };

    Ok((info.width as usize, info.height as usize, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_line_ending_normalization() {
        assert_eq!(normalize_crlf("a\nb\r\nc"), "a\r\nb\r\nc");
        assert_eq!(normalize_lf("a\r\nb\nc"), "a\nb\nc");
    }

    #[test]
    fn test_rgba_png_roundtrip() {
        let pixels = vec![255, 0, 0, 255, 0, 255, 0, 128];
        let encoded = rgba_to_png(2, 1, &pixels).expect("encode png");
        let (w, h, decoded) = png_to_rgba(&encoded).expect("decode png");
        assert_eq!((w, h), (2, 1));
        assert_eq!(decoded, pixels);
    }
}
