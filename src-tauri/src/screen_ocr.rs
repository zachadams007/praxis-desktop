//! screen_ocr.rs - find a control's visible LABEL on screen when UI Automation can't see it.
//!
//! WHY (2026-09-17). Click-by-name (ui_elements.rs) asks Windows which control is called
//! "Continue". That fails when the thing on screen has no accessibility node at all: a
//! canvas-drawn UI, a game, an Electron app with accessibility off, a `<div>` whose text
//! is painted by CSS. A person still sees the word "Continue" and clicks it. So does this:
//! capture the window, run Windows' own OCR engine (Windows.Media.Ocr - built into the
//! OS, free, local, no model call), find the label, and click the middle of it.
//!
//! One public voice-agent repo clicks raw
//! x/y and its screenshot tool returns only a file PATH, so its model never sees the screen.
//! Reading the label off the pixels is the grounded version of that idea.

/// One label found on screen, in desktop (physical) pixels.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OcrHit {
    pub text: String,
    /// Centre of the matched words.
    pub x: i32,
    pub y: i32,
    pub height: i32,
    /// 0 = the whole line IS the label, 1 = the line starts with it. Longer prose that
    /// merely contains the word is never returned: pressing a sentence is not a click.
    pub rank: u8,
}

/// Lowercase and strip punctuation around a word so "Continue," and "CONTINUE" match.
pub(crate) fn norm_word(w: &str) -> String {
    w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

/// Pure matcher (tested): does this OCR line carry the wanted label, and how well?
/// `words` are the line's words in order. Returns (rank, first word index, word count).
pub(crate) fn match_line(words: &[String], want: &str) -> Option<(u8, usize, usize)> {
    let tokens: Vec<String> = want.split_whitespace().map(norm_word).filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return None;
    }
    let line: Vec<String> = words.iter().map(|w| norm_word(w)).filter(|w| !w.is_empty()).collect();
    if line.len() < tokens.len() {
        return None;
    }
    if line == tokens {
        return Some((0, 0, tokens.len()));
    }
    // A label with a trailing arrow or chevron glyph ("Continue →") normalises to the
    // same words; a button that STARTS with the label ("Continue with email") is a real
    // label too, but only when the line is short enough to be one.
    if line[..tokens.len()] == tokens[..] && line.len() <= tokens.len() + 3 {
        return Some((1, 0, tokens.len()));
    }
    None
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    /// BGRA pixels of a desktop rectangle (physical pixels), top-down.
    fn capture_rect(left: i32, top: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
        if width <= 0 || height <= 0 {
            return Err("nothing to capture".into());
        }
        unsafe {
            let screen = GetDC(HWND::default());
            if screen.is_invalid() {
                return Err("GetDC failed".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, width, height);
            let old = SelectObject(mem, bmp);
            let blit = BitBlt(mem, 0, 0, width, height, screen, left, top, SRCCOPY | CAPTUREBLT);
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // negative = top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                height as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            );
            SelectObject(mem, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(mem);
            ReleaseDC(HWND::default(), screen);
            blit.map_err(|e| format!("screen copy failed: {e}"))?;
            if lines == 0 {
                return Err("reading the captured pixels failed".into());
            }
            Ok(buf)
        }
    }

    /// Every place the label appears as a button-like line inside the rectangle.
    pub fn find_label(rect: (i32, i32, i32, i32), want: &str) -> Result<Vec<OcrHit>, String> {
        let (left, top, right, bottom) = rect;
        let (width, height) = (right - left, bottom - top);
        // WinRT activation needs an initialised apartment on this worker thread; an
        // already-initialised one (UI Automation's MTA) is fine and returns S_FALSE.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let max = OcrEngine::MaxImageDimension().unwrap_or(10_000) as i32;
        let (width, height) = (width.min(max), height.min(max));
        let pixels = capture_rect(left, top, width, height)?;
        let buffer = CryptographicBuffer::CreateFromByteArray(&pixels).map_err(|e| format!("OCR buffer: {e}"))?;
        let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            width,
            height,
            BitmapAlphaMode::Ignore,
        )
        .map_err(|e| format!("OCR bitmap: {e}"))?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| format!("OCR engine: {e}"))?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| format!("OCR start: {e}"))?
            .get()
            .map_err(|e| format!("OCR: {e}"))?;
        let mut hits = Vec::new();
        for line in result.Lines().map_err(|e| format!("OCR lines: {e}"))? {
            let Ok(words) = line.Words() else { continue };
            let mut texts = Vec::new();
            let mut rects = Vec::new();
            for w in words {
                let (Ok(t), Ok(r)) = (w.Text(), w.BoundingRect()) else { continue };
                texts.push(t.to_string());
                rects.push(r);
            }
            // Punctuation-only "words" (an arrow glyph) are dropped by norm_word inside
            // match_line; keep indices aligned by matching on the filtered list.
            let kept: Vec<usize> = (0..texts.len()).filter(|&i| !norm_word(&texts[i]).is_empty()).collect();
            let kept_texts: Vec<String> = kept.iter().map(|&i| texts[i].clone()).collect();
            if let Some((rank, first, count)) = match_line(&kept_texts, want) {
                let span = &kept[first..first + count];
                let x0 = span.iter().map(|&i| rects[i].X).fold(f32::MAX, f32::min);
                let y0 = span.iter().map(|&i| rects[i].Y).fold(f32::MAX, f32::min);
                let x1 = span.iter().map(|&i| rects[i].X + rects[i].Width).fold(f32::MIN, f32::max);
                let y1 = span.iter().map(|&i| rects[i].Y + rects[i].Height).fold(f32::MIN, f32::max);
                hits.push(OcrHit {
                    text: span.iter().map(|&i| texts[i].as_str()).collect::<Vec<_>>().join(" "),
                    x: left + ((x0 + x1) / 2.0).round() as i32,
                    y: top + ((y0 + y1) / 2.0).round() as i32,
                    height: (y1 - y0).round() as i32,
                    rank,
                });
            }
        }
        // Best first: exact label, then the biggest type (buttons are set larger than
        // the prose around them).
        hits.sort_by(|a, b| a.rank.cmp(&b.rank).then(b.height.cmp(&a.height)));
        Ok(hits)
    }

    pub fn read_lines(rect: (i32, i32, i32, i32), limit: usize) -> Vec<String> {
        let (left, top, right, bottom) = rect;
        let run = || -> Result<Vec<String>, String> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let (w, h) = (right - left, bottom - top);
            let pixels = capture_rect(left, top, w, h)?;
            let buffer = CryptographicBuffer::CreateFromByteArray(&pixels).map_err(|e| e.to_string())?;
            let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h, BitmapAlphaMode::Ignore)
                .map_err(|e| e.to_string())?;
            let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| e.to_string())?;
            let result = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for line in result.Lines().map_err(|e| e.to_string())? {
                if let Ok(t) = line.Text() {
                    let t = t.to_string();
                    if t.split_whitespace().count() <= 4 && !t.trim().is_empty() {
                        out.push(t);
                    }
                }
                if out.len() >= limit {
                    break;
                }
            }
            Ok(out)
        };
        run().unwrap_or_default()
    }
}

#[cfg(windows)]
pub(crate) use imp::{find_label, read_lines};

#[cfg(not(windows))]
pub(crate) fn find_label(_rect: (i32, i32, i32, i32), _want: &str) -> Result<Vec<OcrHit>, String> {
    Err("screen OCR is Windows-only".into())
}

#[cfg(not(windows))]
pub(crate) fn read_lines(_rect: (i32, i32, i32, i32), _limit: usize) -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn a_button_label_alone_on_its_line_is_an_exact_match() {
        assert_eq!(match_line(&words("CONTINUE"), "continue"), Some((0, 0, 1)));
        assert_eq!(match_line(&words("Continue →"), "Continue"), Some((0, 0, 1)));
        assert_eq!(match_line(&words("Sign in"), "sign in"), Some((0, 0, 2)));
    }

    #[test]
    fn a_label_that_starts_a_short_line_still_counts() {
        assert_eq!(match_line(&words("Continue with email"), "continue"), Some((1, 0, 1)));
    }

    /// The same rule click-by-name learned the hard way on 2026-09-15: a sentence that
    /// happens to contain the word is not the control. Never press prose.
    #[test]
    fn prose_that_mentions_the_word_is_never_a_target() {
        assert_eq!(match_line(&words("Press the button below to continue"), "continue"), None);
        assert_eq!(match_line(&words("Continue reading this very long article about something"), "continue"), None);
        assert_eq!(match_line(&words("Discontinued"), "continue"), None);
    }
}
