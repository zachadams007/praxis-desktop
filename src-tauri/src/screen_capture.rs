use std::collections::VecDeque;
use std::result::Result;
use std::sync::atomic::{AtomicU64, Ordering};

/// Where the last screenshot came from, and how it was scaled.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// THIS EXISTS BECAUSE CLICKS SILENTLY MISSED BY 25%.
///
/// The model is handed a JPEG capped at 1280px on its longest edge and then asked
/// for click coordinates. It answers in the coordinate space of the image it can
/// see. `desktop_click` moved the pointer to those numbers in RAW SCREEN PIXELS.
/// Nothing converted between the two and nothing told the model a scale existed.
///
/// Measured on this machine 2026-09-09: primary monitor 1707x1067, so a 1280-wide capture is
/// scaled by 0.7499. The model clicking a Chrome profile at image (300, 380) sent the pointer to
/// screen (300, 380) when the profile was really at (400, 507) - far enough to hit nothing at
/// all. Every click was reported as "Clicked at 300, 380." and every one of them was a lie of
/// omission: the event fired, it just landed somewhere else.
///
/// The second half of the same bug: capture was hard-wired to `Monitor::primary()`
/// while his second display sits at x=2048. A window over there was invisible to
/// the screenshot AND unreachable by any coordinate derived from it.
/// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CaptureGeometry {
    /// Desktop-space origin of the captured monitor. Non-zero on a second screen.
    pub origin_x: i32,
    pub origin_y: i32,
    /// The monitor's real pixel size.
    pub src_w: u32,
    pub src_h: u32,
    /// The delivered image's size, after downscaling.
    pub img_w: u32,
    pub img_h: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaptureRecord {
    id: u64,
    geometry: CaptureGeometry,
    created_at: std::time::Instant,
}

const ATLAS_CAPTURE_CACHE_SIZE: usize = 8;
const ATLAS_CAPTURE_TTL: std::time::Duration = std::time::Duration::from_secs(30);
static ATLAS_CAPTURES: std::sync::Mutex<VecDeque<CaptureRecord>> =
    std::sync::Mutex::new(VecDeque::new());
static NEXT_ATLAS_CAPTURE_ID: AtomicU64 = AtomicU64::new(1);

fn record_atlas_capture(g: CaptureGeometry) -> u64 {
    let id = NEXT_ATLAS_CAPTURE_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut captures) = ATLAS_CAPTURES.lock() {
        captures.push_back(CaptureRecord {
            id,
            geometry: g,
            created_at: std::time::Instant::now(),
        });
        while captures.len() > ATLAS_CAPTURE_CACHE_SIZE {
            captures.pop_front();
        }
    }
    id
}

fn capture_geometry_from_cache(
    captures: &mut VecDeque<CaptureRecord>,
    id: u64,
    now: std::time::Instant,
) -> Option<CaptureGeometry> {
    captures.retain(|capture| now.duration_since(capture.created_at) <= ATLAS_CAPTURE_TTL);
    captures
        .iter()
        .find(|capture| capture.id == id)
        .map(|capture| capture.geometry)
}

fn atlas_capture_geometry(id: u64) -> Option<CaptureGeometry> {
    ATLAS_CAPTURES.lock().ok().and_then(|mut captures| {
        capture_geometry_from_cache(&mut captures, id, std::time::Instant::now())
    })
}

/// Map a point from the last screenshot's coordinate space into desktop pixels.
///
/// Returns `None` when no screenshot has been taken, which is the honest answer:
/// a click derived from an image nobody captured cannot be placed, and guessing
/// that image space equals screen space is exactly the bug this replaces.
pub(crate) fn capture_point_to_screen(capture_id: u64, x: i32, y: i32) -> Option<(i32, i32)> {
    let geometry = atlas_capture_geometry(capture_id)?;
    point_is_within_capture(geometry, x, y)
        .then(|| map_capture_point(geometry, x, y))
        .flatten()
}

fn point_is_within_capture(g: CaptureGeometry, x: i32, y: i32) -> bool {
    x >= 0 && y >= 0 && (x as u32) < g.img_w && (y as u32) < g.img_h
}

/// The mapping itself, with no global state. Separate from the lookup above so it
/// can be tested without a shared static - the first version of these tests raced
/// each other through `LAST_CAPTURE` and reported a failure that was the harness's
/// fault, not the arithmetic's.
pub(crate) fn map_capture_point(g: CaptureGeometry, x: i32, y: i32) -> Option<(i32, i32)> {
    if g.img_w == 0 || g.img_h == 0 {
        return None;
    }
    let sx = f64::from(g.src_w) / f64::from(g.img_w);
    let sy = f64::from(g.src_h) / f64::from(g.img_h);
    Some((
        g.origin_x + (f64::from(x) * sx).round() as i32,
        g.origin_y + (f64::from(y) * sy).round() as i32,
    ))
}

/// Capture the primary monitor as a base64 JPEG.
///
/// MUST stay `async` + `spawn_blocking`. `CaptureFrame::start()` is the BLOCKING
/// windows-capture variant: it takes over the calling thread and runs its own
/// message pump until the capture stops. As a synchronous `#[tauri::command]` it
/// therefore ran on the main UI thread, starved Tauri's event loop, and killed the
/// whole app - reproduced live on 2026-08-02: one call took Praxis from running to
/// exited every time. Moving it onto a dedicated blocking thread leaves the UI
/// thread free to keep pumping, which is what makes the app survive the call.
#[tauri::command]
pub async fn capture_active_monitor_jpeg(max_edge: u32, quality: u8) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || capture_once(max_edge, quality))
        .await
        .map_err(|error| format!("screen capture task failed: {error}"))?
}

/// Atlas's pointable screenshot. Unlike the stream/Watch Me frames, this records
/// immutable geometry under a short-lived token that must accompany the click.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasCaptureFrame {
    b64: String,
    capture_id: u64,
    width: u32,
    height: u32,
}

#[tauri::command]
pub async fn capture_atlas_monitor_frame(
    max_edge: u32,
    quality: u8,
) -> Result<AtlasCaptureFrame, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let frame = capture_once_frame(max_edge, quality)?;
        let capture_id = record_atlas_capture(frame.geometry);
        Ok(AtlasCaptureFrame {
            b64: frame.b64,
            capture_id,
            width: frame.geometry.img_w,
            height: frame.geometry.img_h,
        })
    })
    .await
    .map_err(|error| format!("screen capture task failed: {error}"))?
}

struct CapturedFrame {
    b64: String,
    geometry: CaptureGeometry,
}

/// The SYNCHRONOUS capture core. Blocks its caller's thread by design, so it must
/// only ever be called from a dedicated thread - `spawn_blocking` above, or the
/// stream thread in `capture_stream_start`. Never from the UI thread.
pub(crate) fn capture_once(max_edge: u32, quality: u8) -> Result<String, String> {
    capture_once_frame(max_edge, quality).map(|frame| frame.b64)
}

fn capture_once_frame(max_edge: u32, quality: u8) -> Result<CapturedFrame, String> {
    #[cfg(windows)]
    {
        capture_active_monitor_jpeg_windows(max_edge, quality)
    }

    #[cfg(not(windows))]
    {
        let _ = (max_edge, quality);
        Err("screen capture is only supported on Windows".to_string())
    }
}

#[cfg(windows)]
fn capture_active_monitor_jpeg_windows(
    max_edge: u32,
    quality: u8,
) -> Result<CapturedFrame, String> {
    use std::sync::mpsc;
    use windows_capture::capture::GraphicsCaptureApiHandler;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };

    if max_edge == 0 {
        return Err("max_edge must be greater than zero".to_string());
    }

    // The monitor the user is actually working on, not always the primary one.
    //
    // The owner's second display sits at desktop x=2048. With `Monitor::primary()` a
    // window opened over there was invisible to every screenshot AND unreachable
    // by any coordinate derived from one - the model would be shown the wrong
    // screen and then click confidently into it. `from_point` on the foreground
    // window's centre follows the work; primary stays the fallback.
    let (monitor, origin_x, origin_y) = foreground_capture_target()
        .or_else(|| Monitor::primary().ok().map(|monitor| (monitor, 0, 0)))
        .ok_or_else(|| "failed to find a monitor to capture".to_string())?;
    let (result_tx, result_rx) = mpsc::channel();
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        CaptureFrameFlags {
            max_edge,
            quality,
            origin_x,
            origin_y,
            result_tx,
        },
    );

    CaptureFrame::start(settings).map_err(|error| format!("screen capture failed: {error}"))?;
    result_rx
        .recv()
        .map_err(|error| format!("screen capture produced no frame: {error}"))?
}

#[cfg(windows)]
struct CaptureFrameFlags {
    max_edge: u32,
    quality: u8,
    origin_x: i32,
    origin_y: i32,
    result_tx: std::sync::mpsc::Sender<Result<CapturedFrame, String>>,
}

#[cfg(windows)]
struct CaptureFrame {
    flags: CaptureFrameFlags,
}

#[cfg(windows)]
impl windows_capture::capture::GraphicsCaptureApiHandler for CaptureFrame {
    type Flags = CaptureFrameFlags;
    type Error = String;

    fn new(ctx: windows_capture::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { flags: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture::frame::Frame<'_>,
        capture_control: windows_capture::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let encoded = encode_frame_jpeg_base64(
            frame,
            self.flags.max_edge,
            self.flags.quality,
            self.flags.origin_x,
            self.flags.origin_y,
        );
        capture_control.stop();

        self.flags
            .result_tx
            .send(encoded)
            .map_err(|error| format!("failed to return captured frame: {error}"))
    }
}

#[cfg(windows)]
fn encode_frame_jpeg_base64(
    frame: &mut windows_capture::frame::Frame<'_>,
    max_edge: u32,
    quality: u8,
    origin_x: i32,
    origin_y: i32,
) -> Result<CapturedFrame, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::codecs::jpeg::JpegEncoder;
    use image::{DynamicImage, RgbaImage};

    let buffer = frame
        .buffer()
        .map_err(|error| format!("failed to read captured frame: {error}"))?;
    let width = buffer.width();
    let height = buffer.height();
    let mut unpadded = Vec::new();
    let rgba_bytes = buffer.as_nopadding_buffer(&mut unpadded).to_vec();
    let rgba = RgbaImage::from_raw(width, height, rgba_bytes)
        .ok_or_else(|| "captured frame buffer size did not match its dimensions".to_string())?;

    let image = DynamicImage::ImageRgba8(rgba);
    let image = downscale_to_max_edge(image, max_edge);

    // Record HOW this frame was scaled, so a click derived from it can be mapped
    // back to real desktop pixels. Without this the model's coordinates and the
    // pointer's coordinates were different units that merely looked alike.
    use image::GenericImageView;
    let (img_w, img_h) = image.dimensions();
    let geometry = CaptureGeometry {
        origin_x,
        origin_y,
        src_w: width,
        src_h: height,
        img_w,
        img_h,
    };

    let rgb = image.to_rgb8();
    let mut jpeg = Vec::new();
    let quality = quality.clamp(1, 100);

    JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(&rgb)
        .map_err(|error| format!("failed to encode captured frame as jpeg: {error}"))?;

    Ok(CapturedFrame {
        b64: STANDARD.encode(jpeg),
        geometry,
    })
}

#[cfg(windows)]
/// Win32 monitor facts for the foreground window: desktop origin and device name.
///
/// `windows_capture::Monitor` exposes `primary()`, `from_index()`, `device_name()`,
/// `width()` and `height()` - but no origin and no "monitor at this point". The
/// origin is exactly what a second display needs (this machine's sits at x=2048),
/// so it comes from `GetMonitorInfoW` and the two views are joined by device name.
#[cfg(windows)]
fn foreground_monitor_info() -> Option<(i32, i32, String)> {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MonitorInfoExW {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: u32,
        sz_device: [u16; 32],
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfoExW) -> i32;
    }

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }
    let hmon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if hmon.is_null() {
        return None;
    }
    let mut info = MonitorInfoExW {
        cb_size: std::mem::size_of::<MonitorInfoExW>() as u32,
        rc_monitor: Rect::default(),
        rc_work: Rect::default(),
        dw_flags: 0,
        sz_device: [0u16; 32],
    };
    if unsafe { GetMonitorInfoW(hmon, &mut info) } == 0 {
        return None;
    }
    let len = info.sz_device.iter().position(|&c| c == 0).unwrap_or(32);
    let device = String::from_utf16_lossy(&info.sz_device[..len]);
    Some((info.rc_monitor.left, info.rc_monitor.top, device))
}

/// The `windows_capture` monitor matching the foreground window, by device name.
#[cfg(windows)]
fn foreground_capture_target() -> Option<(windows_capture::monitor::Monitor, i32, i32)> {
    use windows_capture::monitor::Monitor;
    let (origin_x, origin_y, device) = foreground_monitor_info()?;
    let all = Monitor::enumerate().ok()?;
    all.into_iter()
        .find(|m| m.device_name().map(|n| n == device).unwrap_or(false))
        .map(|monitor| (monitor, origin_x, origin_y))
}

fn downscale_to_max_edge(image: image::DynamicImage, max_edge: u32) -> image::DynamicImage {
    use image::imageops::FilterType;
    use image::GenericImageView;

    let (width, height) = image.dimensions();
    let longest_edge = width.max(height);
    if longest_edge <= max_edge {
        return image;
    }

    let scaled_width = (u64::from(width) * u64::from(max_edge) / u64::from(longest_edge))
        .max(1)
        .try_into()
        .unwrap_or(1);
    let scaled_height = (u64::from(height) * u64::from(max_edge) / u64::from(longest_edge))
        .max(1)
        .try_into()
        .unwrap_or(1);

    image.resize_exact(scaled_width, scaled_height, FilterType::Triangle)
}
static STREAMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct ScreenFramePayload {
    b64: String,
    ts: u64,
}

#[tauri::command]
pub fn capture_stream_start(
    app: tauri::AppHandle,
    fps: f64,
    max_edge: u32,
    quality: u8,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    if STREAMING.swap(true, Ordering::SeqCst) {
        return Err("screen capture stream is already running".to_string());
    }

    let fps = if fps.is_finite() && fps > 0.0 {
        fps.min(30.0)
    } else {
        1.0
    };
    let frame_interval = std::time::Duration::from_secs_f64(1.0 / fps);

    std::thread::Builder::new()
        .name("praxis-screen-capture-stream".to_string())
        .spawn(move || {
            let mut last_encoded_len: Option<usize> = None;
            const NEAR_IDENTICAL_LEN_DELTA: usize = 96;

            while STREAMING.load(Ordering::SeqCst) {
                let frame_started = std::time::Instant::now();

                // Already on a dedicated thread - call the sync core directly.
                match capture_once(max_edge, quality) {
                    Ok(b64) => {
                        let encoded_len = b64.len();
                        let should_emit = last_encoded_len
                            .map(|last| last.abs_diff(encoded_len) > NEAR_IDENTICAL_LEN_DELTA)
                            .unwrap_or(true);

                        if should_emit {
                            last_encoded_len = Some(encoded_len);
                            let ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|duration| duration.as_millis() as u64)
                                .unwrap_or(0);

                            let payload = ScreenFramePayload { b64, ts };
                            if let Err(error) =
                                tauri::Emitter::emit(&app, "praxis://screen-frame", payload)
                            {
                                crate::elog!("failed to emit screen frame: {error}");
                            }
                        }
                    }
                    Err(error) => {
                        crate::elog!("failed to capture screen frame: {error}");
                    }
                }

                let elapsed = frame_started.elapsed();
                if elapsed < frame_interval {
                    std::thread::sleep(frame_interval - elapsed);
                }
            }
        })
        .map(|_| ())
        .map_err(|error| {
            STREAMING.store(false, Ordering::SeqCst);
            error.to_string()
        })
}

#[tauri::command]
pub fn capture_stream_stop() -> Result<(), String> {
    STREAMING.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geom(origin_x: i32, origin_y: i32, src: (u32, u32), img: (u32, u32)) -> CaptureGeometry {
        CaptureGeometry {
            origin_x,
            origin_y,
            src_w: src.0,
            src_h: src.1,
            img_w: img.0,
            img_h: img.1,
        }
    }

    /// THE BUG, with the real numbers off the owner's machine.
    ///
    /// Primary monitor 1707x1067; the capture is capped at 1280 on its longest
    /// edge, so it arrives 1280x800 and every coordinate in it is 0.7499 of the
    /// real thing. The model clicked a Chrome profile at image (300, 380). The old
    /// code sent the pointer to screen (300, 380) and reported "Clicked at 300,
    /// 380." The profile was at (400, 507).
    #[test]
    fn a_downscaled_capture_maps_back_to_real_pixels() {
        let g = geom(0, 0, (1707, 1067), (1280, 800));
        assert_eq!(map_capture_point(g, 300, 380).unwrap(), (400, 507));
        // The origin is the top-left, and the far corner is the far corner.
        assert_eq!(map_capture_point(g, 0, 0).unwrap(), (0, 0));
        assert_eq!(map_capture_point(g, 1280, 800).unwrap(), (1707, 1067));
    }

    /// The other half: his second display starts at desktop x=2048. A coordinate
    /// read off a capture of THAT screen has to carry the origin, or it lands on
    /// the primary monitor instead - a click in a completely different window.
    #[test]
    fn a_second_display_carries_its_origin() {
        let g = geom(2048, 8, (2048, 1152), (1280, 720));
        assert_eq!(
            map_capture_point(g, 640, 360).unwrap(),
            (2048 + 1024, 8 + 576)
        );
        // Its top-left is the monitor's origin, not the desktop's.
        assert_eq!(map_capture_point(g, 0, 0).unwrap(), (2048, 8));
    }

    /// An un-scaled capture is the identity, so the mapping is safe to always run.
    #[test]
    fn an_unscaled_capture_changes_nothing() {
        let g = geom(0, 0, (1280, 800), (1280, 800));
        assert_eq!(map_capture_point(g, 300, 380).unwrap(), (300, 380));
    }

    #[test]
    fn capture_tokens_are_isolated_and_expire() {
        let now = std::time::Instant::now();
        let mut captures = VecDeque::from([
            CaptureRecord {
                id: 1,
                geometry: geom(-1920, 0, (100, 100), (100, 100)),
                created_at: now,
            },
            CaptureRecord {
                id: 2,
                geometry: geom(2048, 8, (200, 100), (100, 50)),
                created_at: now - ATLAS_CAPTURE_TTL - std::time::Duration::from_secs(1),
            },
        ]);
        assert_eq!(
            capture_geometry_from_cache(&mut captures, 1, now),
            Some(geom(-1920, 0, (100, 100), (100, 100)))
        );
        assert_eq!(capture_geometry_from_cache(&mut captures, 2, now), None);
    }

    #[test]
    fn capture_points_reject_negative_and_out_of_bounds_coordinates() {
        let g = geom(-1920, 0, (1920, 1080), (960, 540));
        assert_eq!(map_capture_point(g, 0, 0), Some((-1920, 0)));
        assert_eq!(map_capture_point(g, 959, 539), Some((-2, 1078)));
        // Bounds are enforced before the token lookup maps a user point; the
        // arithmetic itself remains inclusive for its existing edge tests.
        assert!(!point_is_within_capture(g, -1, 0));
        assert!(!point_is_within_capture(g, 960, 0));
        assert!(!point_is_within_capture(g, 0, 540));
    }

    /// A degenerate frame must not divide by zero or invent a point.
    #[test]
    fn a_zero_sized_image_maps_nothing() {
        let g = geom(0, 0, (1707, 1067), (0, 0));
        assert!(map_capture_point(g, 10, 10).is_none());
    }
}
