//! These are the fast-lane primitives Hybrid mode injects straight into whatever window
//! currently holds the foreground - NO Codex, NO watched-cursor choreography. This is the
//! direct-input tier of the Hybrid router (see src/voice/hybridRouter.ts).
//!
//! Reuses the SAME enigo path Live mode's operator already links (see computer_use.rs
//! send_paste/send_enter and native_ops.rs tap_media) - this module just exposes the
//! generic "type arbitrary text" + "press a named key" + "scroll" that those two
//! specialized helpers never generalized. No new dependency: enigo is already a dep.
//!
//! Safety: these inject into the ALREADY-FOCUSED window, and WHO ASKED is the only
//! thing that decides whether anything is withheld (see `crate::autonomy`).
//!
//!   Live       the owner spoke it, now, watching the field it goes into. Nothing is
//!              withheld - he IS the confirmation. Enter presses. Chords fire.
//!   Unattended Nobody is watching, so the trust dial decides. A submit key is a
//!              sensitive action there (it can send, buy or post something no one
//!              saw), and only IV · SOVEREIGN clears it.
//!
//! This replaced a `confirmed: bool` that every model-driven call site hardcoded
//! to `false`, which made Enter unreachable from the Realtime lane at EVERY trust
//! level - "type this in the search bar and hit enter" could never complete.

use crate::autonomy::{unattended_decision, ActionClass, ActionOrigin, Approval, Decision, Level};

/// One key the Hybrid router can ask us to press, resolved to a Windows virtual key.
///
/// This used to be 17 named keys with no letters, no digits, no function keys and
/// no modifier chords - so Praxis could not copy, paste, save, select all, switch
/// windows or refresh a page. That is most of operating a computer, and the
/// narrowness bought nothing: the owner directs every live press himself.
#[cfg(windows)]
fn resolve_key(name: &str) -> Option<enigo::Key> {
    use enigo::Key;
    let n = name.trim().to_lowercase();

    // A single printable character resolves to its RAW virtual key, not a Unicode
    // packet. Accelerators match on virtual keys: Ctrl + Key::Unicode('a') is
    // ignored by most apps, Ctrl + VK_A is not. Same reasoning, and the same
    // hard-won bug, as computer_use::send_paste.
    let mut chars = n.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return Some(Key::Other(c.to_ascii_uppercase() as u32));
        }
        if c.is_ascii_digit() {
            return Some(Key::Other(c as u32));
        }
    }

    // F1..F24 → VK_F1 (0x70) upward. "refresh the page" is F5 and nothing else.
    if let Some(rest) = n.strip_prefix('f') {
        if let Ok(num) = rest.parse::<u32>() {
            if (1..=24).contains(&num) {
                return Some(Key::Other(0x6F + num));
            }
        }
    }

    Some(match n.as_str() {
        "enter" | "return" | "submit" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" | "spacebar" => Key::Space,
        "backspace" | "delete back" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" | "arrow up" | "up arrow" => Key::UpArrow,
        "down" | "arrow down" | "down arrow" => Key::DownArrow,
        "left" | "arrow left" | "left arrow" => Key::LeftArrow,
        "right" | "arrow right" | "right arrow" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "page up" | "pageup" => Key::PageUp,
        "page down" | "pagedown" => Key::PageDown,
        "insert" | "ins" => Key::Other(0x2D),
        "print screen" | "printscreen" | "prtsc" => Key::Print,
        "caps lock" | "capslock" => Key::CapsLock,
        // Modifiers are pressable on their own too ("hold windows"), not only as
        // the qualifier half of a chord.
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,
        "win" | "windows" | "super" | "meta" | "cmd" | "command" => Key::Meta,
        _ => return None,
    })
}

/// The modifier half of a chord, if this word is one.
#[cfg(windows)]
fn modifier_key(word: &str) -> Option<enigo::Key> {
    use enigo::Key;
    Some(match word {
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,
        "win" | "windows" | "super" | "meta" | "cmd" | "command" => Key::Meta,
        _ => return None,
    })
}

/// Split a chord into its held modifiers and the one key they qualify.
///
/// Accepts every shape a spoken or model-written chord actually arrives in:
/// `ctrl+a`, `ctrl-a`, `control a`, `ctrl shift s`, `ctrl+page down`, `alt tab`.
/// Modifiers are peeled off the FRONT one word at a time and whatever remains is
/// handed to `resolve_key` intact - so multi-word key names ("page down", "arrow
/// up") survive, which a naive split on whitespace would destroy.
///
/// Returns `None` when there is no modifier, so the caller falls back to a plain
/// single-key press rather than treating every key as a degenerate chord.
#[cfg(windows)]
fn parse_chord(spec: &str) -> Option<(Vec<enigo::Key>, enigo::Key)> {
    let cleaned = spec.trim().to_lowercase().replace('+', " ").replace('-', " ");
    let mut mods: Vec<enigo::Key> = Vec::new();
    let mut rest = cleaned.trim();

    while let Some((head, tail)) = rest.split_once(char::is_whitespace) {
        match modifier_key(head) {
            Some(m) => {
                if !mods.contains(&m) {
                    mods.push(m);
                }
                rest = tail.trim_start();
            }
            None => break,
        }
    }

    if mods.is_empty() {
        return None;
    }
    let key = resolve_key(rest)?;
    Some((mods, key))
}

/// Send a modifier chord and always release each held modifier. The direct-input
/// commands share this with `Ctrl+L` so address-bar routing has the same
/// stuck-modifier protection as a spoken `press_key` chord.
#[cfg(windows)]
fn press_chord(enigo: &mut enigo::Enigo, spec: &str) -> Result<(), String> {
    use enigo::{Direction, Keyboard};

    let Some((mods, key)) = parse_chord(spec) else {
        return Err(format!("unknown key '{spec}'"));
    };

    let mut held: Vec<enigo::Key> = Vec::with_capacity(mods.len());
    let mut press_err: Option<String> = None;
    for modifier in &mods {
        match enigo.key(*modifier, Direction::Press) {
            Ok(()) => held.push(*modifier),
            Err(error) => {
                press_err = Some(format!("modifier press failed: {error}"));
                break;
            }
        }
    }

    let click = if press_err.is_none() {
        enigo
            .key(key, Direction::Click)
            .map_err(|error| format!("key press failed: {error}"))
    } else {
        Ok(())
    };

    let mut release_err: Option<String> = None;
    for modifier in held.iter().rev() {
        if let Err(error) = enigo.key(*modifier, Direction::Release) {
            release_err.get_or_insert(format!("modifier release failed: {error}"));
        }
    }

    if let Some(error) = press_err {
        return Err(error);
    }
    click?;
    if let Some(error) = release_err {
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TypeTargetField {
    Focused,
    AddressBar,
}

#[cfg(windows)]
fn parse_type_target_field(value: Option<&str>) -> Result<TypeTargetField, String> {
    match value.unwrap_or("focused").trim().to_lowercase().as_str() {
        "" | "focused" => Ok(TypeTargetField::Focused),
        "address_bar" | "address bar" => Ok(TypeTargetField::AddressBar),
        other => Err(format!("unknown type target field '{other}'")),
    }
}

#[cfg(windows)]
fn is_browser_stem(stem: &str) -> bool {
    matches!(stem, "chrome" | "msedge" | "firefox" | "brave" | "opera" | "vivaldi")
}

/// Resolve and foreground the requested target immediately before an input
/// action. The foreground verification is the boundary that prevents a late
/// focus race from sending text or a key to some other window.
#[cfg(windows)]
fn bind_target_window(target_window: &str) -> Result<crate::native_ops::win::WinInfo, String> {
    use std::time::Duration;

    let target = target_window.trim();
    let found = crate::native_ops::win::find_window_matching(target)
        .ok_or_else(|| format!("No open window matches \"{target}\"."))?;
    if crate::native_ops::win::focus_window_verified(
        found.hwnd,
        12,
        Duration::from_millis(120),
    ) {
        Ok(found)
    } else {
        Err(format!("I couldn't bring \"{}\" to the front.", found.title))
    }
}

// ─────────────────────────────────────────────────────────────── type text ──

/// Type a string into the focused window, character by character, via enigo's
/// Unicode text path. Returns a short spoken-friendly confirmation.
#[cfg(windows)]
#[tauri::command]
pub async fn hybrid_type(
    text: String,
    target_window: Option<String>,
    target_field: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        hybrid_type_blocking(text, target_window, target_field)
    })
    .await
    .map_err(|error| format!("typing task panicked: {error}"))?
}

#[cfg(windows)]
fn hybrid_type_blocking(
    text: String,
    target_window: Option<String>,
    target_field: Option<String>,
) -> Result<String, String> {
    use enigo::{Enigo, Keyboard, Settings};
    use std::time::Duration;

    let text = text.trim_end_matches('\n').to_string();
    if text.is_empty() {
        return Err("nothing to type".to_string());
    }
    let field = parse_type_target_field(target_field.as_deref())?;
    let target = target_window.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if field == TypeTargetField::AddressBar && target.is_none() {
        return Err("address_bar typing needs a target window.".to_string());
    }

    // Bind the requested window in this same native action, immediately before
    // injection. A prior focus_window tool is only advisory: another window can
    // steal focus between separate model tool calls.
    let bound = target.map(bind_target_window).transpose()?;
    if field == TypeTargetField::AddressBar {
        let browser = bound
            .as_ref()
            .ok_or_else(|| "address_bar typing needs a target window.".to_string())?;
        if !is_browser_stem(&browser.exe_stem) {
            return Err(format!(
                "\"{}\" is not a supported browser for address_bar typing.",
                browser.title
            ));
        }
    }

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("input synthesizer init failed: {e}"))?;
    if let Some(window) = bound.as_ref() {
        // Enigo setup can take long enough for another window to steal focus, so
        // the target-bound focused-field path needs the same final guard as the
        // address-bar path.
        if !crate::native_ops::win::is_foreground(window.hwnd) {
            return Err(format!("\"{}\" lost focus before typing.", window.title));
        }
    }
    if field == TypeTargetField::AddressBar {
        press_chord(&mut enigo, "ctrl+l")?;
        // Browser accelerators apply asynchronously. Do not race text into the
        // document; after the brief handoff, re-check the exact target window.
        std::thread::sleep(Duration::from_millis(75));
        let browser = bound
            .as_ref()
            .ok_or_else(|| "address_bar typing needs a target window.".to_string())?;
        if !crate::native_ops::win::is_foreground(browser.hwnd) {
            return Err(format!("\"{}\" lost focus before typing.", browser.title));
        }
    }
    enigo
        .text(&text)
        .map_err(|e| format!("typing failed: {e}"))?;
    let preview: String = text.chars().take(40).collect();
    Ok(format!(
        "Typed \"{}{}\".",
        preview,
        if text.chars().count() > 40 { "…" } else { "" }
    ))
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn hybrid_type(
    _text: String,
    _target_window: Option<String>,
    _target_field: Option<String>,
) -> Result<String, String> {
    Err("hybrid input synthesis is Windows-only".to_string())
}

// ──────────────────────────────────────────────────────────────── press key ──

/// Enter, Return and Submit are the only keys that were ever gated, because an
/// UNATTENDED press of one can send, buy or post something nobody saw.
fn is_submit_key(key: &str) -> bool {
    matches!(
        key.trim().to_lowercase().as_str(),
        "enter" | "return" | "submit"
    )
}

/// May this key be pressed right now?
///
/// The old gate wanted a `confirmed: bool` that every model-driven call site hardcoded to
/// `false`, so Enter was unreachable from the Realtime lane at every trust level.
///
/// Unattended keeps the check and hands it to the dial, where it belongs: a
/// submit key is a sensitive action, so III · EXECUTE and below want a human and
/// this actuator has no channel to ask through - only IV · SOVEREIGN clears it,
/// which is exactly what that detent promises.
fn submit_key_is_authorized(key: &str, origin: ActionOrigin, level: Level) -> bool {
    if !is_submit_key(key) {
        return true;
    }
    if origin.is_live() {
        return true;
    }
    matches!(
        unattended_decision(level, ActionClass::Sensitive),
        Decision::Allowed(Approval::None)
    )
}

/// Press a key or chord in the focused window.
///
/// `origin` replaced a `confirmed: bool`. See the module header for why.
#[cfg(windows)]
#[tauri::command]
pub async fn hybrid_press(
    key: String,
    origin: Option<ActionOrigin>,
    target_window: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || hybrid_press_blocking(key, origin, target_window))
        .await
        .map_err(|error| format!("key press task panicked: {error}"))?
}

#[cfg(windows)]
fn hybrid_press_blocking(
    key: String,
    origin: Option<ActionOrigin>,
    target_window: Option<String>,
) -> Result<String, String> {
    use enigo::{Direction, Enigo, Keyboard, Settings};

    // A missing origin reads as unattended - the gated half. A call site that
    // forgets to say who asked must never buy the ungated path by accident.
    let origin = origin.unwrap_or_default();
    let level = crate::autonomy::effective_level();

    if !submit_key_is_authorized(&key, origin, level) {
        return Err(format!(
            "Trust is at {} — an unattended run can't press {} on its own, because it submits. Set the dial to IV · SOVEREIGN, or tell me to press it yourself.",
            level.label(),
            key.trim().to_lowercase()
        ));
    }

    let bound = target_window
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(bind_target_window)
        .transpose()?;

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("input synthesizer init failed: {e}"))?;
    if let Some(window) = bound.as_ref() {
        if !crate::native_ops::win::is_foreground(window.hwnd) {
            return Err(format!("\"{}\" lost focus before pressing a key.", window.title));
        }
    }

    // Plain key first: "page down" and "arrow up" are key names, not chords, and
    // resolve_key already knows them.
    if let Some(ekey) = resolve_key(&key) {
        enigo
            .key(ekey, Direction::Click)
            .map_err(|e| format!("key press failed: {e}"))?;
        return Ok(format!("Pressed {}.", key.trim().to_lowercase()));
    }

    press_chord(&mut enigo, &key)?;
    Ok(format!("Pressed {}.", key.trim().to_lowercase()))
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn hybrid_press(
    _key: String,
    _origin: Option<ActionOrigin>,
    _target_window: Option<String>,
) -> Result<String, String> {
    Err("hybrid input synthesis is Windows-only".to_string())
}

// ───────────────────────────────────────────────────────────────── scroll ──

/// Scroll the focused window. `direction` is "up" | "down" (default down);
/// `amount` is the number of wheel notches (clamped 1..=20, default 3).
#[cfg(windows)]
#[tauri::command]
pub fn hybrid_scroll(direction: String, amount: Option<i32>) -> Result<String, String> {
    use enigo::{Axis, Enigo, Mouse, Settings};
    let dir = direction.trim().to_lowercase();
    // enigo scroll: positive length scrolls DOWN, negative UP (wheel-notch units).
    let magnitude = amount.unwrap_or(3).clamp(1, 20);
    let length = match dir.as_str() {
        "up" => -magnitude,
        "down" | "" => magnitude,
        other => return Err(format!("unknown scroll direction '{other}'")),
    };
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("input synthesizer init failed: {e}"))?;
    enigo
        .scroll(length, Axis::Vertical)
        .map_err(|e| format!("scroll failed: {e}"))?;
    Ok(format!(
        "Scrolled {} {} notch{}.",
        if length < 0 { "up" } else { "down" },
        magnitude,
        if magnitude == 1 { "" } else { "es" }
    ))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn hybrid_scroll(_direction: String, _amount: Option<i32>) -> Result<String, String> {
    Err("hybrid input synthesis is Windows-only".to_string())
}

#[cfg(test)]
mod safety_tests {
    use super::submit_key_is_authorized;
    use crate::autonomy::{ActionOrigin, Level};

    /// The behaviour these tests used to assert - Enter refused unless a caller
    /// passed `confirmed: true` - was the reason "type this and hit enter" could
    /// not complete: every model-driven call site hardcoded `false`, so the
    /// authorization it demanded could not be expressed. Live now self-authorizes.
    #[test]
    fn a_live_press_needs_no_confirmation_at_any_level() {
        for key in ["enter", "RETURN", " submit ", "tab", "ctrl+s"] {
            for level in [Level::Observe, Level::Approve, Level::Operator, Level::Full] {
                assert!(
                    submit_key_is_authorized(key, ActionOrigin::Live, level),
                    "live press of {key} blocked at {level:?}"
                );
            }
        }
    }

    #[test]
    fn an_unattended_submit_needs_the_top_of_the_dial() {
        for key in ["enter", "RETURN", " submit "] {
            for level in [Level::Observe, Level::Suggest, Level::Approve, Level::Operator] {
                assert!(
                    !submit_key_is_authorized(key, ActionOrigin::Unattended, level),
                    "unattended {key} allowed at {level:?}"
                );
            }
            // IV · SOVEREIGN clears it - submitting a form is precisely what the
            // top detent promises, and it is the level's whole point.
            assert!(submit_key_is_authorized(key, ActionOrigin::Unattended, Level::Full));
        }
    }

    #[test]
    fn only_submit_keys_were_ever_gated() {
        for level in [Level::Observe, Level::Operator, Level::Full] {
            assert!(submit_key_is_authorized("tab", ActionOrigin::Unattended, level));
            assert!(submit_key_is_authorized("escape", ActionOrigin::Unattended, level));
        }
    }
}

#[cfg(all(test, windows))]
mod key_tests {
    use super::{is_browser_stem, parse_chord, parse_type_target_field, resolve_key, TypeTargetField};
    use enigo::Key;

    #[test]
    fn letters_digits_and_function_keys_resolve_to_raw_virtual_keys() {
        // Raw VKs, not Unicode packets - accelerators match on virtual keys.
        assert_eq!(resolve_key("a"), Some(Key::Other(0x41)));
        assert_eq!(resolve_key("Z"), Some(Key::Other(0x5A)));
        assert_eq!(resolve_key("7"), Some(Key::Other(0x37)));
        assert_eq!(resolve_key("f5"), Some(Key::Other(0x74)));
        assert_eq!(resolve_key("F12"), Some(Key::Other(0x7B)));
        assert_eq!(resolve_key("f25"), None);
    }

    #[test]
    fn the_original_named_keys_still_resolve() {
        assert_eq!(resolve_key("enter"), Some(Key::Return));
        assert_eq!(resolve_key(" Page Down "), Some(Key::PageDown));
        assert_eq!(resolve_key("arrow up"), Some(Key::UpArrow));
        assert_eq!(resolve_key("nonsense key"), None);
    }

    #[test]
    fn chords_parse_in_every_shape_a_spoken_one_arrives_in() {
        // The owner's four from the acceptance criteria: select all, copy, save, refresh.
        assert_eq!(parse_chord("ctrl+a"), Some((vec![Key::Control], Key::Other(0x41))));
        assert_eq!(parse_chord("control c"), Some((vec![Key::Control], Key::Other(0x43))));
        assert_eq!(parse_chord("ctrl-s"), Some((vec![Key::Control], Key::Other(0x53))));
        assert_eq!(parse_chord("alt tab"), Some((vec![Key::Alt], Key::Tab)));
        assert_eq!(
            parse_chord("ctrl shift t"),
            Some((vec![Key::Control, Key::Shift], Key::Other(0x54)))
        );
    }

    #[test]
    fn a_multi_word_key_name_survives_its_modifier() {
        // Peeling modifiers off the FRONT is what keeps this working; splitting
        // the whole string on whitespace would leave "page" and lose "down".
        assert_eq!(
            parse_chord("ctrl+page down"),
            Some((vec![Key::Control], Key::PageDown))
        );
        assert_eq!(
            parse_chord("shift arrow left"),
            Some((vec![Key::Shift], Key::LeftArrow))
        );
    }

    #[test]
    fn a_plain_key_is_not_a_chord() {
        // No modifier → None, so hybrid_press falls back to a single-key press
        // instead of treating every key as a degenerate chord.
        assert_eq!(parse_chord("enter"), None);
        assert_eq!(parse_chord("a"), None);
        // A modifier with no key is not a chord either.
        assert_eq!(parse_chord("ctrl+"), None);
    }

    #[test]
    fn a_repeated_modifier_is_held_once() {
        assert_eq!(parse_chord("ctrl ctrl a"), Some((vec![Key::Control], Key::Other(0x41))));
    }

    #[test]
    fn type_targets_explicitly_limit_address_bar_to_supported_browsers() {
        assert_eq!(
            parse_type_target_field(None),
            Ok(TypeTargetField::Focused)
        );
        assert_eq!(
            parse_type_target_field(Some("address_bar")),
            Ok(TypeTargetField::AddressBar)
        );
        assert!(parse_type_target_field(Some("document")).is_err());
        for browser in ["chrome", "msedge", "firefox", "brave", "opera", "vivaldi"] {
            assert!(is_browser_stem(browser));
        }
        assert!(!is_browser_stem("explorer"));
    }
}
