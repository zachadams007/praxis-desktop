//! Native simple-ops fast path + shared Win32 window utilities.
//!
//! Two jobs:
//!  1. `match_simple_op` / `run_simple_op` - trivially deterministic desktop goals
//!     ("open chrome", "focus obsidian", "close my browser") are executed DIRECTLY
//!     through Windows instead of escalating to visible Codex computer use. Instant,
//!     zero spend, and the seed of the native driver. Scoped to open / focus / URL /
//!     search / media / single-window control (close·min·max·restore·move) - never
//!     clicking or typing arbitrary UIs, and never force-terminating processes or close-all.
//!  2. `win` - raw Win32 window enumeration + the AttachThreadInput foreground
//!     trick (same pattern proven in lib.rs), shared with computer_use.rs so the
//!     Codex auto-submit can find and focus the Codex Desktop window.
//!
//! HWNDs are carried as `isize` (pointer-sized int) so they stay `Send` across
//! the spawn_blocking boundary - raw pointers would poison the async command.

use std::collections::VecDeque;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

// ───────────────────────────────────────────── owner-scoped native run tracking ──

static NATIVE_RUN_STATE_LOCK: Mutex<()> = Mutex::new(());
static NATIVE_RUNNING: AtomicBool = AtomicBool::new(false);
static NATIVE_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static NATIVE_ACTIVE_OWNER: Mutex<Option<String>> = Mutex::new(None);
static NATIVE_PRE_CANCELLED_OWNERS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const MAX_NATIVE_PRE_CANCELLED_OWNERS: usize = 64;
const NATIVE_TERMINAL_TIMEOUT: Duration = Duration::from_secs(5);
const NATIVE_TERMINAL_POLL: Duration = Duration::from_millis(10);

fn normalized_owner_token(owner_token: Option<String>) -> Option<String> {
    owner_token.and_then(|token| {
        let token = token.trim().to_string();
        (!token.is_empty()).then_some(token)
    })
}

fn native_owner_matches(active: Option<&str>, requested: Option<&str>) -> bool {
    match requested {
        None => false,
        Some(token) if token.trim().is_empty() => false,
        Some(token) => active == Some(token.trim()),
    }
}

fn record_native_pre_cancelled_owner(token: &str) -> Result<(), String> {
    let mut tokens = NATIVE_PRE_CANCELLED_OWNERS.lock().map_err(|e| e.to_string())?;
    if !tokens.iter().any(|existing| existing == token) {
        tokens.push_back(token.to_string());
        while tokens.len() > MAX_NATIVE_PRE_CANCELLED_OWNERS {
            let _ = tokens.pop_front();
        }
    }
    Ok(())
}

fn take_native_pre_cancelled_owner(token: &str) -> Result<bool, String> {
    let mut tokens = NATIVE_PRE_CANCELLED_OWNERS.lock().map_err(|e| e.to_string())?;
    let Some(index) = tokens.iter().position(|existing| existing == token) else {
        return Ok(false);
    };
    let _ = tokens.remove(index);
    Ok(true)
}

fn native_owner_is_terminal(owner_token: &str) -> Result<bool, String> {
    if !NATIVE_RUNNING.load(Ordering::SeqCst) {
        return Ok(true);
    }
    let active_owner = NATIVE_ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
    Ok(active_owner.as_deref() != Some(owner_token))
}

fn wait_for_native_owner_terminal(owner_token: &str) -> Result<(), String> {
    let deadline = Instant::now() + NATIVE_TERMINAL_TIMEOUT;
    loop {
        if native_owner_is_terminal(owner_token)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Timed out waiting for native owner {owner_token} to become terminal."
            ));
        }
        thread::sleep(NATIVE_TERMINAL_POLL);
    }
}

fn wait_for_native_slot_terminal() -> Result<(), String> {
    let deadline = Instant::now() + NATIVE_TERMINAL_TIMEOUT;
    while NATIVE_RUNNING.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err("Timed out waiting for the native action to become terminal.".to_string());
        }
        thread::sleep(NATIVE_TERMINAL_POLL);
    }
    Ok(())
}

struct NativeRunGuard;
impl Drop for NativeRunGuard {
    fn drop(&mut self) {
        let _state_guard = NATIVE_RUN_STATE_LOCK.lock().ok();
        if let Ok(mut owner) = NATIVE_ACTIVE_OWNER.lock() {
            *owner = None;
        }
        NATIVE_RUNNING.store(false, Ordering::SeqCst);
    }
}

// ─────────────────────────────────────────────────────────── goal parsing ──

/// How a known app is launched. `Shell` goes through `cmd /C start "" <target>`
/// (App-Paths lookup + protocol URIs; GUI apps never flash a console). `Shim`
/// runs `cmd /C <name>` with a HIDDEN console - needed for .cmd shims like
/// `code`/`cursor`, where `start` would pop a visible console window.
#[derive(Clone, Copy, Debug)]
pub enum LaunchSpec {
    Shell(&'static str),
    Shim(&'static str),
}

/// A trivially deterministic media/volume key. Maps 1:1 to an `enigo::Key`
/// media variant so the whole thing stays a single tap of a hardware key.
#[derive(Clone, Copy, Debug)]
pub enum MediaKey {
    PlayPause,
    NextTrack,
    PrevTrack,
    VolumeUp,
    VolumeDown,
    Mute,
}

impl MediaKey {
    fn verb(&self) -> &'static str {
        match self {
            MediaKey::PlayPause => "toggled play/pause",
            MediaKey::NextTrack => "skipped to the next track",
            MediaKey::PrevTrack => "went to the previous track",
            MediaKey::VolumeUp => "turned the volume up",
            MediaKey::VolumeDown => "turned the volume down",
            MediaKey::Mute => "toggled mute",
        }
    }
}

/// A single named external window we will control. Generic browser resolves only
/// to the supported Chrome / Edge / Firefox window currently in front - never
/// another background browser and never close-all.
///
/// `Named` is the escape hatch that makes this usable. The set used to be exactly
/// these four browsers and EVERY other window was a refusal, so "focus Obsidian"
/// and "minimize Cursor" could not be said out loud. A named target matches an
/// open window by executable stem or title, so it covers whatever is actually
/// running rather than whatever was listed here in advance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowTarget {
    GenericBrowser,
    Chrome,
    Edge,
    Firefox,
    Named(String),
}

impl WindowTarget {
    fn label(&self) -> String {
        match self {
            WindowTarget::GenericBrowser => "browser".to_string(),
            WindowTarget::Chrome => "Chrome".to_string(),
            WindowTarget::Edge => "Edge".to_string(),
            WindowTarget::Firefox => "Firefox".to_string(),
            WindowTarget::Named(name) => name.clone(),
        }
    }
}

/// Conservative monitor destination spoken in a move request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MonitorDest {
    Next,
    Primary,
    Left,
    Right,
    Largest,
    Index(usize),
}

/// Next/other monitor moves need ≥2 displays. Mirrors lib.rs's single-display honesty:
/// never claim a move onto the only monitor as "the other monitor."
pub fn require_other_display(monitor_count: usize) -> Result<(), String> {
    if monitor_count < 2 {
        Err("There's no other display to move to.".to_string())
    } else {
        Ok(())
    }
}

/// How a monitor move should treat show-state - same contract as lib.rs's mover:
/// unmaximize/restore → place → re-apply prior maximized or minimized state. Never
/// leave a previously maximized/minimized window silently restored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveShowPlan {
    MoveOnly,
    UnmaximizeMoveRemaximize,
    RestoreMoveReminimize,
}

pub fn plan_move_show_state(was_maximized: bool, was_minimized: bool) -> MoveShowPlan {
    if was_minimized {
        MoveShowPlan::RestoreMoveReminimize
    } else if was_maximized {
        MoveShowPlan::UnmaximizeMoveRemaximize
    } else {
        MoveShowPlan::MoveOnly
    }
}

/// Back-compat alias used by earlier maximized-only regressions.
pub type MaximizedMovePlan = MoveShowPlan;

pub fn plan_maximized_move(was_maximized: bool) -> MoveShowPlan {
    plan_move_show_state(was_maximized, false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowAction {
    Close,
    Minimize,
    Maximize,
    Restore,
    Move(MonitorDest),
}

#[derive(Debug)]
pub enum SimpleOp {
    Open {
        target: String,
        spec: LaunchSpec,
    },
    Focus {
        target: String,
    },
    /// Open the default browser at a bare URL/domain ("open github.com").
    OpenUrl {
        url: String,
    },
    /// Open the default browser on a Google search for a plain query.
    Search {
        query: String,
    },
    /// Tap a media/volume hardware key (no window focus needed - the OS routes it).
    Media(MediaKey),
    /// Single graceful window control for a named browser/app window.
    WindowControl {
        target: WindowTarget,
        action: WindowAction,
    },
    /// Matched but explicitly refused (e.g. close-everything). Terminates locally
    /// with an honest error - never a Codex handoff and never multi-window actuation.
    Refuse {
        message: String,
    },
}

impl SimpleOp {
    pub fn describe(&self) -> String {
        match self {
            SimpleOp::Open { target, .. } => format!("open {target}"),
            SimpleOp::Focus { target } => format!("focus {target}"),
            SimpleOp::OpenUrl { url } => format!("open {url}"),
            SimpleOp::Search { query } => format!("search for {query}"),
            SimpleOp::Media(k) => k.verb().to_string(),
            SimpleOp::WindowControl { target, action } => match action {
                WindowAction::Close => format!("close {}", target.label()),
                WindowAction::Minimize => format!("minimize {}", target.label()),
                WindowAction::Maximize => format!("maximize {}", target.label()),
                WindowAction::Restore => format!("restore {}", target.label()),
                WindowAction::Move(dest) => format!("move {} to {:?}", target.label(), dest),
            },
            SimpleOp::Refuse { message } => message.clone(),
        }
    }
}

/// Known-app alias table. Open only fast-paths apps on this list - an unknown
/// target falls through to the Codex operator, which can figure it out visibly.
const APP_ALIASES: &[(&[&str], LaunchSpec)] = &[
    (&["chrome", "google chrome"], LaunchSpec::Shell("chrome")),
    (&["edge", "microsoft edge"], LaunchSpec::Shell("msedge")),
    (&["firefox"], LaunchSpec::Shell("firefox")),
    (&["notepad"], LaunchSpec::Shell("notepad")),
    (&["calculator", "calc"], LaunchSpec::Shell("calc")),
    (
        &["file explorer", "explorer", "files"],
        LaunchSpec::Shell("explorer"),
    ),
    (
        &["settings", "windows settings"],
        LaunchSpec::Shell("ms-settings:"),
    ),
    (&["task manager"], LaunchSpec::Shell("taskmgr")),
    (
        &["vs code", "vscode", "visual studio code", "code"],
        LaunchSpec::Shim("code"),
    ),
    (&["cursor"], LaunchSpec::Shim("cursor")),
    (&["obsidian"], LaunchSpec::Shell("obsidian://")),
    (&["spotify"], LaunchSpec::Shell("spotify:")),
    (&["discord"], LaunchSpec::Shell("discord://")),
    (&["slack"], LaunchSpec::Shell("slack:")),
    (&["terminal", "windows terminal"], LaunchSpec::Shell("wt")),
    (&["paint"], LaunchSpec::Shell("mspaint")),
];

fn normalize(goal: &str) -> String {
    let mut g = goal.trim().to_lowercase();
    loop {
        let trimmed = g
            .trim_end_matches(['.', '!', '?', ',', ';', ':', ' '])
            .to_string();
        if trimmed == g {
            break;
        }
        g = trimmed;
    }
    g = g.split_whitespace().collect::<Vec<_>>().join(" ");
    for prefix in [
        "please, ",
        "please ",
        "could you ",
        "can you ",
        "would you ",
        "will you ",
    ] {
        if let Some(rest) = g.strip_prefix(prefix) {
            g = rest.trim().to_string();
            break;
        }
    }
    loop {
        let before = g.clone();
        for suffix in [
            ", please",
            " please",
            ", thanks",
            " thanks",
            ", thank you",
            " thank you",
            ", for me",
            " for me",
        ] {
            if let Some(rest) = g.strip_suffix(suffix) {
                g = rest.trim_end_matches([',', ' ']).trim().to_string();
            }
        }
        if g == before {
            break;
        }
    }
    g
}

/// Action verbs that, appearing INSIDE what should be a window's name, mean the
/// utterance was two instructions rather than one oddly-named window.
const EMBEDDED_ACTIONS: &[&str] = &[
    " open ", " close ", " launch ", " focus ", " switch ", " minimize ",
    " minimise ", " maximize ", " maximise ", " restore ", " hide ", " show ",
    " move ", " set ", " delete ", " search ", " type ", " press ",
];

fn contains_embedded_action(candidate: &str) -> bool {
    let padded = format!(" {candidate} ");
    EMBEDDED_ACTIONS.iter().any(|verb| padded.contains(verb))
}

/// Words that name no window in particular. A goal built only from these is
/// genuinely unresolvable, and that is the one case still worth declining - as a
/// miss, so a wider actuator gets its turn, not as a refusal.
const VAGUE_TARGETS: &[&str] = &[
    "", "it", "that", "this", "them", "those", "these", "everything", "every", "all",
    "all of it", "all of them", "stuff", "things", "thing", "window", "windows",
    "the window", "app", "apps", "application", "applications", "everything else",
];

/// A window name cannot START with one of these. "hide and seek" is a game, not
/// an instruction to minimize a window called "and seek" - the leading conjunction
/// is what tells them apart, and it is the cheapest reliable signal there is.
const NOT_A_NAME_START: &[&str] = &[
    "and", "or", "then", "but", "so", "if", "to", "from", "with", "of", "in", "on",
    "at", "for", "about", "into", "out", "up", "down", "away", "back", "me", "us",
];

fn parse_window_target(raw: &str) -> Option<WindowTarget> {
    let cleaned = clean_target(raw);

    if cleaned
        .split_whitespace()
        .next()
        .is_some_and(|first| NOT_A_NAME_START.contains(&first))
    {
        return None;
    }

    // A second action verb inside the "name" means this is a compound that got
    // this far, not a window called "bar open foo". Decline so the sequencer
    // takes it; inventing a window name from a compound would silently do the
    // wrong half of the instruction.
    if contains_embedded_action(&cleaned) {
        return None;
    }

    match cleaned.as_str() {
        "browser" | "web browser" => Some(WindowTarget::GenericBrowser),
        "chrome" | "google chrome" => Some(WindowTarget::Chrome),
        "edge" | "microsoft edge" => Some(WindowTarget::Edge),
        "firefox" | "mozilla firefox" => Some(WindowTarget::Firefox),
        // Anything else names a real window: Obsidian, Cursor, Spotify, Safari,
        // "Order Management". Resolution happens against the live window list at
        // actuation time, so this does not need to know what is installed.
        other => {
            if VAGUE_TARGETS.contains(&other) || other.len() > 60 {
                None
            } else {
                Some(WindowTarget::Named(other.to_string()))
            }
        }
    }
}

fn parse_monitor_dest(text: &str) -> Option<MonitorDest> {
    let mut t = text.trim();
    for prefix in ["the ", "my ", "a ", "an "] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim();
            break;
        }
    }
    if t.is_empty() {
        return None;
    }
    if Regexish::any(t, &["largest", "biggest"]) {
        return Some(MonitorDest::Largest);
    }
    if Regexish::any(t, &["main", "primary", "home"]) {
        return Some(MonitorDest::Primary);
    }
    if let Some(n) = parse_monitor_index(t) {
        return Some(MonitorDest::Index(n));
    }
    if Regexish::word(t, "left") {
        return Some(MonitorDest::Left);
    }
    if Regexish::word(t, "right") {
        return Some(MonitorDest::Right);
    }
    if Regexish::any(t, &["next", "other", "different"]) {
        return Some(MonitorDest::Next);
    }
    // Bare "monitor"/"display"/"screen" after "to my …" → next/other.
    if matches!(
        t,
        "monitor" | "display" | "screen" | "monitors" | "displays" | "screens"
    ) {
        return Some(MonitorDest::Next);
    }
    None
}

fn parse_monitor_index(text: &str) -> Option<usize> {
    let words = text.split_whitespace().collect::<Vec<_>>();
    for i in 0..words.len() {
        if matches!(words[i], "monitor" | "display" | "screen") {
            if let Some(n) = words
                .get(i + 1)
                .and_then(|w| w.trim_start_matches('#').parse::<usize>().ok())
            {
                if n >= 1 {
                    return Some(n);
                }
            }
        }
        let w = words[i].trim_end_matches('.');
        if let Some(n) = ordinal_word(w) {
            return Some(n);
        }
        // "2nd monitor" / "3rd screen"
        if let Some(stripped) = w
            .strip_suffix("st")
            .or_else(|| w.strip_suffix("nd"))
            .or_else(|| w.strip_suffix("rd"))
            .or_else(|| w.strip_suffix("th"))
        {
            if let Ok(n) = stripped.parse::<usize>() {
                if n >= 1
                    && words
                        .get(i + 1)
                        .is_some_and(|n| matches!(*n, "monitor" | "display" | "screen"))
                {
                    return Some(n);
                }
            }
        }
        if let Ok(n) = w.parse::<usize>() {
            if n >= 1
                && words
                    .get(i + 1)
                    .is_some_and(|n| matches!(*n, "monitor" | "display" | "screen"))
            {
                return Some(n);
            }
        }
    }
    None
}

fn ordinal_word(w: &str) -> Option<usize> {
    Some(match w {
        "first" => 1,
        "second" => 2,
        "third" => 3,
        "fourth" => 4,
        "fifth" => 5,
        "sixth" => 6,
        "seventh" => 7,
        "eighth" => 8,
        "ninth" => 9,
        "tenth" => 10,
        _ => return None,
    })
}

/// Tiny helper so matchers stay readable without pulling a regex crate into this module.
struct Regexish;
impl Regexish {
    fn word(hay: &str, needle: &str) -> bool {
        hay.split_whitespace().any(|w| w == needle)
    }
    fn any(hay: &str, needles: &[&str]) -> bool {
        needles.iter().any(|n| Self::word(hay, n))
    }
}

/// Reached only when a window command names NO window at all ("close", "move to
/// monitor 2", "close the window"). Everything else - any app, any title, several
/// actions at once - is now either handled or declined so a wider actuator gets
/// it. The old copy said "name one supported browser", which stopped being true
/// when the target set stopped being four browsers.
const WINDOW_REFUSAL: &str =
    "I didn't catch which window you meant — say its name and what to do with it.";

fn refuse_window_control() -> SimpleOp {
    SimpleOp::Refuse {
        message: WINDOW_REFUSAL.to_string(),
    }
}

fn is_window_control_shaped(g: &str) -> bool {
    let close_like = [
        "close ",
        "shut ",
        "minimize ",
        "minimise ",
        "maximize ",
        "maximise ",
        "restore ",
        "unmaximize ",
        "unmaximise ",
    ]
    .iter()
    .any(|verb| g.starts_with(verb))
        || matches!(
            g,
            "close"
                | "shut"
                | "minimize"
                | "minimise"
                | "maximize"
                | "maximise"
                | "restore"
                | "unmaximize"
                | "unmaximise"
        );
    if close_like {
        return true;
    }

    // Unsupported dismiss verbs are window-shaped only when they actually name
    // a window/app target. This keeps "hide my browser" fail-closed without
    // hijacking ordinary language such as "hide and seek".
    let unsupported_dismiss = ["hide ", "dismiss ", "get rid of "]
        .iter()
        .any(|verb| g.starts_with(verb));
    if unsupported_dismiss && mentions_window_target(g) {
        return true;
    }

    let move_like = ["move ", "put ", "place ", "send ", "shift "]
        .iter()
        .any(|verb| g.starts_with(verb));
    if !move_like {
        return false;
    }

    Regexish::any(
        g,
        &[
            "browser", "browsers", "window", "windows", "chrome", "edge", "firefox", "safari",
            "opera", "brave", "vivaldi", "arc", "monitor", "monitors", "display", "displays",
            "screen", "screens", "notepad", "obsidian", "cursor", "vscode",
        ],
    )
}

fn has_multiple_window_actions(g: &str) -> bool {
    is_window_control_shaped(g) && has_clause_boundary(g)
}

fn has_clause_boundary(g: &str) -> bool {
    [
        " and ",
        " or ",
        " but ",
        " then ",
        " plus ",
        " also ",
        " before ",
        " after ",
        " while ",
        " whilst ",
        " because ",
        " if ",
        " when ",
        " unless ",
        " until ",
    ]
    .iter()
    .any(|marker| g.contains(marker))
        || g.chars()
            .any(|c| matches!(c, ',' | ';' | '.' | '!' | '?' | '&' | '|' | '+'))
}

fn mentions_window_target(g: &str) -> bool {
    [
        "browser",
        "browsers",
        "window",
        "windows",
        "chrome",
        "edge",
        "firefox",
        "safari",
        "monitor",
        "display",
        "screen",
        "command center",
        "cockpit",
        "flight deck",
        "memory galaxy",
        "praxis",
        "notepad",
        "calculator",
        "obsidian",
        "cursor",
        "vscode",
    ]
    .iter()
    .any(|target| g.contains(target))
}

/// The move parser is deliberately whole-string: recognizing one monitor token
/// inside a longer tail would execute only the first half of a multi-action request.
fn is_exact_monitor_dest(text: &str) -> bool {
    let mut t = text.trim();
    for prefix in ["the ", "my ", "a ", "an "] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim();
            break;
        }
    }
    let words = t.split_whitespace().collect::<Vec<_>>();
    let noun = |w: &str| matches!(w, "monitor" | "display" | "screen");
    let qualifier = |w: &str| {
        matches!(
            w,
            "other"
                | "next"
                | "different"
                | "main"
                | "primary"
                | "home"
                | "left"
                | "right"
                | "largest"
                | "biggest"
                | "first"
                | "second"
                | "third"
                | "fourth"
                | "fifth"
                | "sixth"
                | "seventh"
                | "eighth"
                | "ninth"
                | "tenth"
        )
    };
    match words.as_slice() {
        [one] => noun(one),
        [first, second] if qualifier(first) && noun(second) => true,
        [first, second] if noun(first) => second
            .trim_start_matches('#')
            .parse::<usize>()
            .is_ok_and(|n| n >= 1),
        [first, second] if noun(second) => {
            let raw = first
                .trim_end_matches("st")
                .trim_end_matches("nd")
                .trim_end_matches("rd")
                .trim_end_matches("th");
            raw.parse::<usize>().is_ok_and(|n| n >= 1)
        }
        _ => false,
    }
}

/// Match a single-window control goal for a named browser (generic / Edge / Chrome /
/// Firefox). Clearly window-shaped ambiguous, unsupported, and multi-action requests
/// are matched refusals so they cannot mutate Praxis or escape into Live execution.
fn match_window_control(g: &str) -> Option<SimpleOp> {
    // "Close everything" is a real instruction, not an attack. The fast path only
    // knows how to control ONE window, so it declines and lets an actuator that
    // can enumerate windows do the work. It used to refuse, which meant the owner
    // could watch a screen full of windows and be told no.
    if is_global_window_dismiss(g) {
        return None;
    }

    // Likewise several actions in one breath: not handled here, handled elsewhere.
    if has_multiple_window_actions(g) {
        return None;
    }

    // The connectorless shape ("close bar open foo") carries its second verb with
    // no "and" to mark the boundary, so the clause check above misses it. Decline
    // rather than refuse: it IS two instructions, and the sequencer can run both.
    // Tested on the REMAINDER - the goal's own leading verb is the first action,
    // not a second one.
    if g
        .split_once(char::is_whitespace)
        .is_some_and(|(_, rest)| contains_embedded_action(rest))
    {
        return None;
    }

    // move <target> to/onto/on <monitor…>
    // Must match the move_like list in `is_window_control_shaped` - a verb that is
    // shaped like a move but missing here becomes a refusal for no reason ("place
    // chrome on monitor 2" was exactly that).
    for verb in ["move ", "put ", "place ", "send ", "shift "] {
        if let Some(rest) = g.strip_prefix(verb) {
            // Require an explicit monitor/display/screen noun. A clearly window-shaped
            // incomplete move is a local refusal rather than an operator handoff.
            if !Regexish::any(
                rest,
                &[
                    "monitor", "display", "screen", "monitors", "displays", "screens",
                ],
            ) {
                return is_window_control_shaped(g).then(refuse_window_control);
            }
            let Some((target_raw, dest_raw)) = split_move_target_dest(rest) else {
                return Some(refuse_window_control());
            };
            if !is_exact_monitor_dest(dest_raw) {
                return Some(refuse_window_control());
            }
            let Some(target) = parse_window_target(target_raw) else {
                return Some(refuse_window_control());
            };
            let Some(dest) = parse_monitor_dest(dest_raw) else {
                return Some(refuse_window_control());
            };
            return Some(SimpleOp::WindowControl {
                target,
                action: WindowAction::Move(dest),
            });
        }
    }

    for (verb, action) in [
        ("close ", WindowAction::Close),
        ("shut ", WindowAction::Close),
        ("minimize ", WindowAction::Minimize),
        ("minimise ", WindowAction::Minimize),
        ("maximize ", WindowAction::Maximize),
        ("maximise ", WindowAction::Maximize),
        ("restore ", WindowAction::Restore),
        ("unmaximize ", WindowAction::Restore),
        ("unmaximise ", WindowAction::Restore),
    ] {
        if let Some(rest) = g.strip_prefix(verb) {
            let Some(target) = parse_window_target(rest) else {
                return Some(refuse_window_control());
            };
            return Some(SimpleOp::WindowControl { target, action });
        }
    }

    // "hide my browser" and "get rid of Slack" mean minimize. They used to be
    // classed "unsupported control verbs" and refused, which is a strange thing
    // to say to someone who just named one window and one action.
    //
    // These verbs are SOFT: they are ordinary English far more often than they
    // are window commands. So an unparseable target is a miss, not a refusal -
    // "hide and seek" must leave here as None, while "close" (a hard verb with
    // no target) is a genuine "which window?".
    for (verb, action) in [
        ("hide ", WindowAction::Minimize),
        ("dismiss ", WindowAction::Minimize),
        ("get rid of ", WindowAction::Minimize),
    ] {
        if let Some(rest) = g.strip_prefix(verb) {
            return parse_window_target(rest)
                .map(|target| SimpleOp::WindowControl { target, action });
        }
    }

    // Unsupported control verbs such as "hide my browser" are still clearly
    // window-shaped. Refuse locally instead of silently handing them to Codex.
    if is_window_control_shaped(g) {
        return Some(refuse_window_control());
    }
    None
}

/// "close everything" / "minimize all browsers" - never a single-window fast path.
fn is_global_window_dismiss(g: &str) -> bool {
    let dismiss = g.starts_with("close ")
        || g.starts_with("shut ")
        || g.starts_with("minimize ")
        || g.starts_with("minimise ")
        || g.starts_with("hide ")
        || g.starts_with("dismiss ")
        || g.starts_with("get rid of ");
    if !dismiss {
        return false;
    }
    Regexish::word(g, "everything")
        || Regexish::any(g, &["every"])
            && Regexish::any(
                g,
                &[
                    "window",
                    "windows",
                    "browser",
                    "browsers",
                    "app",
                    "apps",
                    "application",
                    "applications",
                ],
            )
        || (Regexish::word(g, "all")
            && Regexish::any(
                g,
                &[
                    "window",
                    "windows",
                    "browser",
                    "browsers",
                    "app",
                    "apps",
                    "application",
                    "applications",
                    "tab",
                    "tabs",
                ],
            ))
}

fn split_move_target_dest(rest: &str) -> Option<(&str, &str)> {
    for sep in [
        " to the ",
        " onto the ",
        " on the ",
        " to my ",
        " onto my ",
        " on my ",
        " to ",
        " onto ",
        " on ",
    ] {
        if let Some((left, right)) = rest.split_once(sep) {
            let left = left.trim();
            let right = right.trim();
            if !left.is_empty() && !right.is_empty() {
                return Some((left, right));
            }
        }
    }
    None
}

/// Strip filler around the target: leading articles, trailing politeness/nouns.
fn clean_target(raw: &str) -> String {
    let mut t = raw.trim();
    for prefix in ["the ", "my "] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim();
        }
    }
    for suffix in [" for me", " please", " app", " application", " window"] {
        if let Some(rest) = t.strip_suffix(suffix) {
            t = rest.trim();
        }
    }
    t.to_string()
}

/// Clean a search query: strip a leading "for ", trailing politeness, and outer
/// quotes. Multi-word is fine (that's a query) - only reject empties upstream.
fn clean_query(raw: &str) -> String {
    let mut q = raw.trim();
    if let Some(rest) = q.strip_prefix("for ") {
        q = rest.trim();
    }
    for suffix in [" for me", " please", " on google", " on the web"] {
        if let Some(rest) = q.strip_suffix(suffix) {
            q = rest.trim();
        }
    }
    q.trim_matches(['"', '\'']).trim().to_string()
}

/// A target is "simple" when it's a short plain name - anything URL-ish,
/// multi-clause, or long means the goal needs a real operator, not the fast path.
fn is_simple_target(t: &str) -> bool {
    if t.is_empty() || t.split_whitespace().count() > 4 {
        return false;
    }
    if t.contains("http") || t.contains("www.") || t.contains(".com") {
        return false;
    }
    t.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '+'))
}

fn lookup_alias(target: &str) -> Option<LaunchSpec> {
    APP_ALIASES.iter().find_map(|(names, spec)| {
        if names.contains(&target) {
            Some(*spec)
        } else {
            None
        }
    })
}

/// Common multi-word TLDs whose LAST label alone (`co`, `com`) wouldn't look
/// like a valid TLD - kept tiny and conservative on purpose.
const KNOWN_TLDS: &[&str] = &[
    "com", "org", "net", "io", "dev", "app", "ai", "co", "gov", "edu", "me", "gg",
];

/// Is a single token a bare domain/URL we can hand to the browser? Deliberately
/// conservative: `https?://…`, or a `label.tld` where the tld is on the known
/// list - so plain sentences ("open the door") never trip it. A trailing path
/// (`github.com/foo`) is allowed; whitespace is not (single token only).
fn as_open_url(token: &str) -> Option<String> {
    let t = token.trim();
    if t.is_empty() || t.contains(char::is_whitespace) {
        return None;
    }
    if let Some(rest) = t
        .strip_prefix("http://")
        .or_else(|| t.strip_prefix("https://"))
    {
        // must have an actual host after the scheme
        return if rest.contains('.') && !rest.starts_with('.') {
            Some(t.to_string())
        } else {
            None
        };
    }
    // bare domain: host[/path]. Only the HOST part is checked for a known TLD.
    let host = t.split(['/', '?', '#']).next().unwrap_or(t);
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty()) {
        return None;
    }
    let tld = *labels.last().unwrap();
    // hostnames are ascii letters/digits/hyphens; the tld must be a known one
    let host_ok = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
    if host_ok && KNOWN_TLDS.contains(&tld) {
        Some(format!("https://{t}"))
    } else {
        None
    }
}

/// Percent-encode a search query for a URL query string. Small hand-rolled
/// encoder (no url crate) - spaces → `+`, everything non-unreserved → `%XX`.
fn encode_query(q: &str) -> String {
    let mut out = String::with_capacity(q.len() * 2);
    for b in q.bytes() {
        match b {
            b' ' => out.push('+'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Match a media/volume goal. The whole utterance must BE the command (a short
/// fixed phrase) - anything longer/other is None so real sentences never trip it.
fn match_media(g: &str) -> Option<MediaKey> {
    Some(match g {
        "play" | "pause" | "play pause" | "play/pause" | "resume" | "unpause"
        | "toggle playback" | "pause music" | "play music" | "resume music" => MediaKey::PlayPause,
        "next" | "next track" | "next song" | "skip" | "skip track" | "skip song"
        | "skip this song" | "next please" => MediaKey::NextTrack,
        "previous" | "previous track" | "previous song" | "prev" | "prev track"
        | "go back a track" | "last track" | "last song" => MediaKey::PrevTrack,
        "volume up" | "turn it up" | "turn the volume up" | "louder" | "raise the volume"
        | "raise volume" | "increase volume" | "turn up the volume" => MediaKey::VolumeUp,
        "volume down"
        | "turn it down"
        | "turn the volume down"
        | "quieter"
        | "lower the volume"
        | "lower volume"
        | "decrease volume"
        | "turn down the volume" => MediaKey::VolumeDown,
        "mute" | "unmute" | "toggle mute" | "mute it" | "silence" | "mute the volume" => {
            MediaKey::Mute
        }
        _ => return None,
    })
}

/// Match "open <app>" / "focus <window>" / "open <url>" / "search <query>" /
/// media-key / single-window-control style goals. Returns None for anything with
/// multi-step markers - those escalate to the visible Codex operator.
pub fn match_simple_op(goal: &str) -> Option<SimpleOp> {
    let g = normalize(goal);

    // media/volume commands are short fixed phrases - check BEFORE the clause
    // guard (they never contain " and "/commas) and before the open/focus verbs.
    if let Some(key) = match_media(&g) {
        return Some(SimpleOp::Media(key));
    }

    // A COMPOUND IS NOT A REFUSAL. The fast path simply does not handle two actions - so it
    // declines (None) and the sequencing path takes it. Declining and refusing look identical
    // from here and could not be more different at the microphone: one gets the job done, the
    // other lectures the owner.
    //
    // The frontend stopped refusing these in commands.ts; Rust kept refusing, and
    // because `native_op_matches` answered `true` for a Refuse, Rust won the race
    // on the voice fast lane and the frontend fix never got a turn.

    // Single-window control for named browsers - before search/open so
    // "close chrome" never becomes a web search or app launch. It also sees
    // multi-clause text first so shaped window commands can terminate as Refuse.
    if let Some(op) = match_window_control(&g) {
        return Some(op);
    }

    // Other multi-clause goals are never simple ("open chrome and search for…").
    if g.contains(" and ") || g.contains(" then ") || g.contains(',') || g.contains(';') {
        return None;
    }

    const OPEN_VERBS: [&str; 4] = ["open up ", "open ", "launch ", "start "];
    const GOTO_VERBS: [&str; 4] = ["go to ", "navigate to ", "browse to ", "open the site "];
    const WEB_SEARCH_VERBS: [&str; 5] = [
        "google ",
        "search the web for ",
        "search online for ",
        "web search for ",
        "look up ",
    ];
    const PLAIN_SEARCH_VERBS: [&str; 2] = ["search for ", "search "];
    const FOCUS_VERBS: [&str; 5] = ["focus on ", "focus ", "switch to ", "bring up ", "pull up "];

    /// Nouns that signal a LOCAL search (files, app content) - never a web search.
    fn looks_local(query: &str) -> bool {
        [
            "folder",
            "file",
            "files",
            "directory",
            "downloads",
            "desktop",
            "drive",
            "vault",
            "memory",
            "galaxy",
            "note",
            "notes",
            "inbox",
            "email",
            "emails",
        ]
        .iter()
        .any(|w| query.split_whitespace().any(|q| q == *w))
    }

    /// If a phrase NAMES AN INSTALLED APP, return the op that opens it.
    ///
    /// An app name is an app, never a query.
    fn open_if_app_name(phrase: &str) -> Option<SimpleOp> {
        let target = clean_target(phrase);
        if target.is_empty() || !is_simple_target(&target) {
            return None;
        }
        lookup_alias(&target).map(|spec| SimpleOp::Open { target, spec })
    }

    // ── search <query> → default browser at a Google search ──────────────────
    // Checked before FOCUS/OPEN so a web search never becomes a window hunt.
    for verb in WEB_SEARCH_VERBS {
        if let Some(rest) = g.strip_prefix(verb) {
            // "google chrome" names an app - OPEN it rather than searching for
            // its name. Checked before the query is built so the app wins.
            if let Some(open) = open_if_app_name(rest) {
                return Some(open);
            }
            let query = clean_query(rest);
            if query.is_empty() || query.split_whitespace().count() > 10 {
                return None; // over-long queries escalate to the operator
            }
            return Some(SimpleOp::Search { query });
        }
    }
    for verb in PLAIN_SEARCH_VERBS {
        if let Some(rest) = g.strip_prefix(verb) {
            let query = clean_query(rest);
            if query.is_empty() || query.split_whitespace().count() > 6 || looks_local(&query) {
                return None; // ambiguous/local-looking → visible operator decides
            }
            return Some(SimpleOp::Search { query });
        }
    }

    // ── go to <url> → default browser at that URL ────────────────────────────
    for verb in GOTO_VERBS {
        if let Some(rest) = g.strip_prefix(verb) {
            let target = clean_target(rest);
            // GOTO verbs only make sense for a URL/domain - a bare app name here
            // is ambiguous, so None (falls to the operator) rather than guessing.
            return as_open_url(&target).map(|url| SimpleOp::OpenUrl { url });
        }
    }

    for verb in FOCUS_VERBS {
        if let Some(rest) = g.strip_prefix(verb) {
            // A focus request carrying a second action ("focus chrome and close
            // the tab") is two steps, so the one-step fast path declines it and
            // the sequencer runs it. It used to be refused outright.
            if [
                " open ",
                " close ",
                " move ",
                " switch ",
                " set ",
                " delete ",
                " search ",
                " minimize ",
                " maximize ",
                " restore ",
            ]
            .iter()
            .any(|marker| format!(" {rest} ").contains(marker))
            {
                return None;
            }
            let target = clean_target(rest);
            if is_simple_target(&target) {
                return Some(SimpleOp::Focus { target });
            }
            return None;
        }
    }

    for verb in OPEN_VERBS {
        if let Some(rest) = g.strip_prefix(verb) {
            let target = clean_target(rest);
            // "open <url/domain>" → browser (checked before the app-alias table so
            // "open github.com" opens the site, not a hunt for a "github.com" app).
            if let Some(url) = as_open_url(&target) {
                return Some(SimpleOp::OpenUrl { url });
            }
            if !is_simple_target(&target) {
                return None;
            }
            // only fast-path KNOWN apps - unknown targets go to the Codex operator
            return lookup_alias(&target).map(|spec| SimpleOp::Open { target, spec });
        }
    }

    None
}

// ─────────────────────────────────────────────────────────────── execution ──

#[cfg(windows)]
fn launch(spec: &LaunchSpec) -> Result<(), String> {
    let mut command = Command::new("cmd.exe");
    hide_window(&mut command);
    match spec {
        // `start ""` detaches GUI apps / protocol URIs; App-Paths registry resolves names.
        LaunchSpec::Shell(target) => {
            command.args(["/C", "start", "", target]);
        }
        // .cmd shims (code, cursor) run inside THIS hidden console; they exec the
        // real GUI app and return. `start` on a .cmd would flash a visible console.
        LaunchSpec::Shim(name) => {
            command.args(["/C", name]);
        }
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("launch failed: {e}"))?;

    // Catch immediate failures (bad protocol, missing shim) without blocking on
    // long-lived shims: poll ~2.5s, then assume the launch took.
    for _ in 0..10 {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("launcher exited with {status}")),
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(format!("launcher poll failed: {e}")),
        }
    }
    Ok(())
}

/// Open a URL in the user's DEFAULT browser via `start "" <url>` (no browser
/// hardcoded - Windows resolves the http/https handler).
#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    let mut command = Command::new("cmd.exe");
    hide_window(&mut command);
    command.args(["/C", "start", "", url]);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("open browser failed: {e}"))?;
    for _ in 0..8 {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("browser launcher exited with {status}")),
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(format!("browser launcher poll failed: {e}")),
        }
    }
    Ok(())
}

/// Tap one media/volume hardware key via enigo. The OS routes media keys to the
/// active media session, so no window focus/verification is needed.
#[cfg(windows)]
fn tap_media(key: MediaKey) -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let ekey = match key {
        MediaKey::PlayPause => Key::MediaPlayPause,
        MediaKey::NextTrack => Key::MediaNextTrack,
        MediaKey::PrevTrack => Key::MediaPrevTrack,
        MediaKey::VolumeUp => Key::VolumeUp,
        MediaKey::VolumeDown => Key::VolumeDown,
        MediaKey::Mute => Key::VolumeMute,
    };
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("input synthesizer init failed: {e}"))?;
    enigo
        .key(ekey, Direction::Click)
        .map_err(|e| format!("media key tap failed: {e}"))
}

/// Run a matched simple op. Errors are soft for open/focus/url/search/media -
/// the Hybrid router speaks the honest local error for matched failures and does
/// NOT collapse them into a Live Codex handoff. Window-control failures are
/// always local (no target / timeout / postcondition) and never claim success
/// when the HWND remains.
#[cfg(windows)]
pub fn run_simple_op(op: &SimpleOp) -> Result<String, String> {
    match op {
        SimpleOp::Open { target, spec } => {
            launch(spec)?;
            Ok(format!("Opened {target}."))
        }
        SimpleOp::Focus { target } => {
            let w = win::find_window_matching(target)
                .ok_or_else(|| format!("no open window matches \"{target}\""))?;
            if win::focus_window_verified(w.hwnd, 12, Duration::from_millis(120)) {
                Ok(format!("Focused {}.", w.title))
            } else {
                Err(format!("could not bring \"{}\" to the foreground", w.title))
            }
        }
        SimpleOp::OpenUrl { url } => {
            open_in_browser(url)?;
            Ok(format!("Opened {url}."))
        }
        SimpleOp::Search { query } => {
            let url = format!("https://www.google.com/search?q={}", encode_query(query));
            open_in_browser(&url)?;
            Ok(format!("Searching the web for {query}."))
        }
        SimpleOp::Media(key) => {
            tap_media(*key)?;
            Ok(format!("Done — {}.", key.verb()))
        }
        SimpleOp::WindowControl { target, action } => win::run_window_control(target, *action),
        SimpleOp::Refuse { message } => Err(message.clone()),
    }
}

#[cfg(not(windows))]
pub fn run_simple_op(_op: &SimpleOp) -> Result<String, String> {
    Err("native desktop ops are Windows-only".to_string())
}

/// The ONE native-fast-path implementation, shared by the voice router
/// (`native_op_try`) and the orchestrator live-mode operator (computer_use.rs) so
/// the two callers can never drift. `Ok(Some(msg))` = handled natively, speak
/// `msg`; `Ok(None)` = not native-eligible (caller may escalate to visible Codex);
/// `Err(e)` = matched a native op but it FAILED - Hybrid speaks `e` locally and
/// must NOT collapse into a Live handoff. This never escalates to Codex itself.
pub fn try_native(goal: &str) -> Result<Option<String>, String> {
    match match_simple_op(goal) {
        Some(op) => run_simple_op(&op).map(Some),
        None => Ok(None),
    }
}

/// The Tauri fast-path entry point for the voice router. Thin wrapper over
/// `try_native` (the shared impl) - see route.ts `routeComputerUse`.
#[tauri::command]
pub async fn native_op_try(
    goal: String,
    owner_token: Option<String>,
) -> Result<Option<String>, String> {
    let owner_token = normalized_owner_token(owner_token);
    {
        let state_guard = NATIVE_RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
        if let Some(token) = owner_token.as_deref() {
            if take_native_pre_cancelled_owner(token)? {
                return Err("Native action was cancelled before it started.".to_string());
            }
        }
        let mut active_owner = NATIVE_ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
        if NATIVE_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("A native action is already in flight — stop it before starting another.".to_string());
        }
        NATIVE_STOP_REQUESTED.store(false, Ordering::SeqCst);
        *active_owner = owner_token;
        drop(active_owner);
        drop(state_guard);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = NativeRunGuard;
        if NATIVE_STOP_REQUESTED.load(Ordering::SeqCst) {
            return Err("Native action was cancelled before execution.".to_string());
        }
        try_native(&goal)
    })
    .await
    .map_err(|e| format!("native action task panicked: {e}"))?
}

/// Scoped native stop. Native Win32 calls cannot be interrupted safely in the
/// middle, so success is acknowledged only after the exact owner is terminal.
#[tauri::command]
pub async fn native_op_abort(owner_token: Option<String>) -> Result<String, String> {
    let Some(owner_token) = normalized_owner_token(owner_token) else {
        return Ok("No matching native action to abort; a scoped owner token is required.".to_string());
    };
    let state_guard = NATIVE_RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if !NATIVE_RUNNING.load(Ordering::SeqCst) {
        record_native_pre_cancelled_owner(&owner_token)?;
        return Ok("Scoped native cancellation recorded before run admission.".to_string());
    }
    {
        let active_owner = NATIVE_ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
        if !native_owner_matches(active_owner.as_deref(), Some(owner_token.as_str())) {
            record_native_pre_cancelled_owner(&owner_token)?;
            return Ok("Scoped native cancellation recorded; the active run has a different owner.".to_string());
        }
    }
    NATIVE_STOP_REQUESTED.store(true, Ordering::SeqCst);
    drop(state_guard);
    let wait_owner = owner_token.clone();
    tauri::async_runtime::spawn_blocking(move || wait_for_native_owner_terminal(&wait_owner))
        .await
        .map_err(|e| format!("native terminal wait panicked: {e}"))??;
    Ok("Native action cancellation completed.".to_string())
}

/// Explicit global sibling used only by HALT ALL / deliberate stop UI.
#[tauri::command]
pub async fn native_op_abort_all() -> Result<String, String> {
    let state_guard = NATIVE_RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if !NATIVE_RUNNING.load(Ordering::SeqCst) {
        return Ok("No active native action to abort.".to_string());
    }
    NATIVE_STOP_REQUESTED.store(true, Ordering::SeqCst);
    drop(state_guard);
    tauri::async_runtime::spawn_blocking(wait_for_native_slot_terminal)
        .await
        .map_err(|e| format!("native terminal wait panicked: {e}"))??;
    Ok("All native action cancellation completed.".to_string())
}

/// Read-only eligibility probe used by the voice router so it can apply the
/// shared HALT / breaker / shell policy before the native actuator runs.
///
/// A `Refuse` is NOT a match. It used to be, and that single `is_some()` was a
/// real bug: the router saw `true`, called `native_op_try`, got the refusal text
/// back as an error, spoke it, and returned `blocked` - so a local refusal could
/// pre-empt every wider path that would have succeeded. A refusal is a decision
/// not to act, which is the opposite of "this actuator handles it".
#[tauri::command]
pub fn native_op_matches(goal: String) -> bool {
    matches!(
        match_simple_op(&goal),
        Some(op) if !matches!(op, SimpleOp::Refuse { .. })
    )
}

// ────────────────────────────────────────────────────── Win32 window layer ──

#[cfg(windows)]
pub mod win {
    use std::ffi::c_void;
    use std::time::Duration;

    /// HWND at the FFI boundary - SAME type as lib.rs's win32 module, so the
    /// duplicate extern declarations of shared symbols don't clash. Public API
    /// carries `isize` (Send-safe); convert only at the call sites.
    type HwndPtr = *mut c_void;

    #[derive(Clone, Debug)]
    pub struct WinInfo {
        pub hwnd: isize,
        pub title: String,
        pub exe_stem: String,
    }

    const SW_RESTORE: i32 = 9;
    const SW_MINIMIZE: i32 = 6;
    const SW_MAXIMIZE: i32 = 3;
    const SW_SHOW: i32 = 5;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const WM_CLOSE: u32 = 0x0010;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const HWND_TOP: isize = 0;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    /// GetWindow cmd: next window below hwnd in Z-order (MSDN GW_HWNDNEXT).
    const GW_HWNDNEXT: u32 = 2;

    #[repr(C)]
    #[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
    pub(crate) struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: u32,
    }

    const MONITORINFOF_PRIMARY: u32 = 1;

    /// Foreground monitor bounds and usable work area in physical pixels.
    /// The caller's click-through overlay must never become its own target.
    pub(crate) fn foreground_work_area(own: isize) -> Option<(isize, Rect, Rect)> {
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.is_null() || foreground as isize == own { return None; }
            let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
            let mut info = MonitorInfo {
                cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                rc_monitor: Rect::default(), rc_work: Rect::default(), dw_flags: 0,
            };
            if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 { return None; }
            Some((monitor as isize, info.rc_monitor, info.rc_work))
        }
    }

    /// Read-only visibility check. Plain Win32 reads like this one, `window_rect`
    /// and `monitor_scale` are safe from any thread; Tauri's own window getters are
    /// not free, because each one blocks its caller on the UI thread's event loop.
    pub(crate) fn window_visible(hwnd: isize) -> bool {
        unsafe { IsWindowVisible(hwnd as HwndPtr) != 0 }
    }

    /// Effective DPI scale of a monitor (1.0 = 96 dpi), from an HMONITOR such as the
    /// one `foreground_work_area` returns.
    pub(crate) fn monitor_scale(monitor: isize) -> Option<f64> {
        const MDT_EFFECTIVE_DPI: i32 = 0;
        let (mut dpi_x, mut dpi_y) = (0u32, 0u32);
        let hr = unsafe { GetDpiForMonitor(monitor as HwndPtr, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
        (hr == 0 && dpi_x > 0).then(|| f64::from(dpi_x) / 96.0)
    }

    #[link(name = "shcore")]
    extern "system" {
        fn GetDpiForMonitor(monitor: HwndPtr, dpi_type: i32, dpi_x: *mut u32, dpi_y: *mut u32) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(cb: unsafe extern "system" fn(HwndPtr, isize) -> i32, lparam: isize) -> i32;
        fn GetTopWindow(hwnd: HwndPtr) -> HwndPtr;
        fn GetWindow(hwnd: HwndPtr, cmd: u32) -> HwndPtr;
        fn IsWindowVisible(hwnd: HwndPtr) -> i32;
        fn IsWindow(hwnd: HwndPtr) -> i32;
        fn GetWindowTextW(hwnd: HwndPtr, buf: *mut u16, n: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: HwndPtr, pid: *mut u32) -> u32;
        fn GetForegroundWindow() -> HwndPtr;
        fn SetForegroundWindow(hwnd: HwndPtr) -> i32;
        fn BringWindowToTop(hwnd: HwndPtr) -> i32;
        fn ShowWindow(hwnd: HwndPtr, cmd: i32) -> i32;
        fn IsIconic(hwnd: HwndPtr) -> i32;
        fn IsZoomed(hwnd: HwndPtr) -> i32;
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, attach: i32) -> i32;
        fn keybd_event(vk: u8, scan: u8, flags: u32, extra_info: usize);
        fn SwitchToThisWindow(hwnd: HwndPtr, alt_tab: i32);
        fn PostMessageW(hwnd: HwndPtr, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn GetWindowRect(hwnd: HwndPtr, rect: *mut Rect) -> i32;
        fn SetWindowPos(
            hwnd: HwndPtr,
            insert_after: HwndPtr,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn MonitorFromWindow(hwnd: HwndPtr, flags: u32) -> HwndPtr;
        fn GetMonitorInfoW(monitor: HwndPtr, info: *mut MonitorInfo) -> i32;
        fn EnumDisplayMonitors(
            hdc: HwndPtr,
            clip: *const Rect,
            cb: unsafe extern "system" fn(HwndPtr, HwndPtr, *mut Rect, isize) -> i32,
            dw_data: isize,
        ) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> HwndPtr;
        fn CloseDesktop(desktop: HwndPtr) -> i32;
        fn GetUserObjectInformationW(obj: HwndPtr, index: i32, info: *mut u16, len: u32, needed: *mut u32) -> i32;
    }

    /// True while the lock screen or the secure desktop (Ctrl+Alt+Del, a UAC prompt) owns
    /// the screen. Nothing can be brought forward, clicked or typed then, and a screenshot
    /// shows the lock screen. Live 2026-09-18: behind a locked screen Atlas spent 55 s
    /// failing to focus Edge, window after window, instead of saying the screen was locked.
    pub fn screen_locked() -> bool {
        if let Some(fg) = foreground_window() {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(fg as HwndPtr, &mut pid) };
            if process_exe_stem(pid) == "lockapp" {
                return true;
            }
        }
        const DESKTOP_READOBJECTS: u32 = 0x0001;
        const UOI_NAME: i32 = 2;
        unsafe {
            let desk = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if desk.is_null() {
                return true;
            }
            let mut buf = [0u16; 64];
            let mut needed = 0u32;
            let ok = GetUserObjectInformationW(desk, UOI_NAME, buf.as_mut_ptr(), (buf.len() * 2) as u32, &mut needed);
            CloseDesktop(desk);
            if ok == 0 {
                return false;
            }
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            !String::from_utf16_lossy(&buf[..end]).eq_ignore_ascii_case("default")
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn GetCurrentProcessId() -> u32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> HwndPtr;
        fn CloseHandle(h: HwndPtr) -> i32;
        fn QueryFullProcessImageNameW(h: HwndPtr, flags: u32, buf: *mut u16, size: *mut u32)
            -> i32;
    }

    unsafe extern "system" fn collect_cb(hwnd: HwndPtr, lparam: isize) -> i32 {
        let out = &mut *(lparam as *mut Vec<isize>);
        out.push(hwnd as isize);
        1 // keep enumerating
    }

    pub(crate) fn window_title(hwnd: isize) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(hwnd as HwndPtr, buf.as_mut_ptr(), buf.len() as i32) };
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    fn process_exe_stem(pid: u32) -> String {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return String::new();
            }
            let mut buf = [0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase()
        }
    }

    /// All visible, titled top-level windows (excluding our own process).
    pub fn list_windows() -> Vec<WinInfo> {
        let mut handles: Vec<isize> = Vec::with_capacity(64);
        unsafe {
            EnumWindows(collect_cb, &mut handles as *mut Vec<isize> as isize);
        }
        let own_pid = unsafe { GetCurrentProcessId() };
        handles
            .into_iter()
            .filter(|&h| unsafe { IsWindowVisible(h as HwndPtr) } != 0)
            .filter_map(|hwnd| {
                let title = window_title(hwnd);
                if title.is_empty() {
                    return None;
                }
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd as HwndPtr, &mut pid) };
                if pid == own_pid {
                    return None;
                }
                Some(WinInfo {
                    hwnd,
                    title,
                    exe_stem: process_exe_stem(pid),
                })
            })
            .collect()
    }

    /// The Codex Desktop window, if one exists. Exe-name match ranks above a
    /// title match (a "codex-…" filename open in an editor must not win), and
    /// the prompt-handoff file's own name is excluded outright.
    pub fn find_codex_window() -> Option<WinInfo> {
        let windows = list_windows();
        windows
            .iter()
            .find(|w| w.exe_stem.contains("codex"))
            .or_else(|| {
                windows.iter().find(|w| {
                    let t = w.title.to_lowercase();
                    t.contains("codex") && !t.contains("codex-computer-use")
                })
            })
            .cloned()
    }

    /// Best window whose title/exe matches a spoken needle ("obsidian", "vs code").
    pub fn find_window_matching(needle: &str) -> Option<WinInfo> {
        let n = needle.to_lowercase();
        let n_joined = n.replace(' ', "");
        let mut best: Option<(u32, WinInfo)> = None;
        for w in list_windows() {
            let t = w.title.to_lowercase();
            let score = if t == n {
                100
            } else if t.starts_with(&n) {
                80
            } else if t.contains(&n) {
                60
            } else if !n_joined.is_empty() && w.exe_stem.contains(&n_joined) {
                50
            } else {
                continue;
            };
            // Chrome's "Who's using Chrome?" picker is titled exactly "Google Chrome",
            // which out-scored every real browser window for the target "Google
            // Chrome" - so typing went into the picker. Any real tab window wins.
            let score = if w.exe_stem == "chrome" && t == "google chrome" { score.min(40) } else { score };
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, w));
            }
        }
        best.map(|(_, w)| w)
    }

    pub fn is_foreground(hwnd: isize) -> bool {
        unsafe { GetForegroundWindow() as isize == hwnd }
    }

    /// Force a window to the real foreground. Windows blocks background processes
    /// from SetForegroundWindow (the "foreground lock"); the canonical workaround -
    /// same as lib.rs's `force_foreground` - is to AttachThreadInput to the current
    /// foreground thread for the duration. Only SW_RESTOREs when minimized so a
    /// maximized window keeps its size.
    pub fn focus_window(hwnd: isize) {
        const VK_MENU: u8 = 0x12;
        const KEYEVENTF_KEYUP: u32 = 0x0002;
        unsafe {
            let fg_thread = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
            let this_thread = GetCurrentThreadId();
            AttachThreadInput(fg_thread, this_thread, 1);
            if IsIconic(hwnd as HwndPtr) != 0 {
                ShowWindow(hwnd as HwndPtr, SW_RESTORE);
            }
            SetForegroundWindow(hwnd as HwndPtr);
            BringWindowToTop(hwnd as HwndPtr);
            AttachThreadInput(fg_thread, this_thread, 0);

            // ─────────────────────────────────────────────────────────────────
            // THE SECOND STEP OF EVERY SPOKEN SEQUENCE FAILED HERE.
            //
            // AttachThreadInput alone does not lift Windows' foreground lock when Praxis is a
            // background process - which it always is while the owner is talking to it from another
            // app.
            //
            // Injected keyboard input does lift it. Alt DOWN before the switch and
            // Alt UP after it (pywinauto's order): the down lands on the old window
            // and the up on the new one, so neither sees a complete Alt tap and no
            // menu bar gets activated in either.
            // ─────────────────────────────────────────────────────────────────
            if GetForegroundWindow() as isize != hwnd {
                keybd_event(VK_MENU, 0, 0, 0);
                SetForegroundWindow(hwnd as HwndPtr);
                BringWindowToTop(hwnd as HwndPtr);
                keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
            }
            if GetForegroundWindow() as isize != hwnd {
                SwitchToThisWindow(hwnd as HwndPtr, 1);
            }
        }
    }

    /// Focus + verify with retries. Returns whether the window actually holds
    /// the foreground - the caller must NOT inject keys on false.
    pub fn focus_window_verified(hwnd: isize, attempts: u32, delay: Duration) -> bool {
        for _ in 0..attempts {
            if is_foreground(hwnd) {
                return true;
            }
            focus_window(hwnd);
            std::thread::sleep(delay);
        }
        is_foreground(hwnd)
    }

    fn is_alive(hwnd: isize) -> bool {
        unsafe { IsWindow(hwnd as HwndPtr) != 0 }
    }

    pub(crate) fn window_rect(hwnd: isize) -> Option<Rect> {
        let mut rect = Rect::default();
        let ok = unsafe { GetWindowRect(hwnd as HwndPtr, &mut rect) };
        if ok != 0 {
            Some(rect)
        } else {
            None
        }
    }

    #[derive(Clone, Debug)]
    struct MonitorGeom {
        handle: isize,
        monitor: Rect,
        work: Rect,
        primary: bool,
    }

    unsafe extern "system" fn monitor_enum_cb(
        monitor: HwndPtr,
        _hdc: HwndPtr,
        _rect: *mut Rect,
        lparam: isize,
    ) -> i32 {
        let out = &mut *(lparam as *mut Vec<MonitorGeom>);
        let mut info = MonitorInfo {
            cb_size: std::mem::size_of::<MonitorInfo>() as u32,
            rc_monitor: Rect::default(),
            rc_work: Rect::default(),
            dw_flags: 0,
        };
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            out.push(MonitorGeom {
                handle: monitor as isize,
                monitor: info.rc_monitor,
                work: info.rc_work,
                primary: (info.dw_flags & MONITORINFOF_PRIMARY) != 0,
            });
        }
        1
    }

    fn list_monitors() -> Vec<MonitorGeom> {
        let mut out: Vec<MonitorGeom> = Vec::with_capacity(4);
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                monitor_enum_cb,
                &mut out as *mut _ as isize,
            );
        }
        out.sort_by_key(|m| (m.monitor.left, m.monitor.top));
        out
    }

    fn monitor_of_window(hwnd: isize) -> Option<MonitorGeom> {
        let handle =
            unsafe { MonitorFromWindow(hwnd as HwndPtr, MONITOR_DEFAULTTONEAREST) as isize };
        list_monitors().into_iter().find(|m| m.handle == handle)
    }

    fn resolve_monitor_dest(hwnd: isize, dest: super::MonitorDest) -> Result<MonitorGeom, String> {
        let monitors = list_monitors();
        if monitors.is_empty() {
            return Err("Windows did not report any displays.".to_string());
        }
        let current = monitor_of_window(hwnd);
        match dest {
            super::MonitorDest::Primary => monitors
                .into_iter()
                .find(|m| m.primary)
                .or_else(|| list_monitors().into_iter().min_by_key(|m| m.monitor.left))
                .ok_or_else(|| "Could not find the main display.".to_string()),
            super::MonitorDest::Largest => monitors
                .into_iter()
                .max_by_key(|m| {
                    let w = (m.work.right - m.work.left) as i64;
                    let h = (m.work.bottom - m.work.top) as i64;
                    w * h
                })
                .ok_or_else(|| "Could not find the largest display.".to_string()),
            super::MonitorDest::Index(n) => {
                if n == 0 {
                    return Err("Monitor numbers start at 1.".to_string());
                }
                monitors
                    .get(n - 1)
                    .cloned()
                    .ok_or_else(|| format!("There's no monitor {n}."))
            }
            super::MonitorDest::Next => {
                super::require_other_display(monitors.len())?;
                let idx = current
                    .as_ref()
                    .and_then(|c| monitors.iter().position(|m| m.handle == c.handle))
                    .unwrap_or(0);
                Ok(monitors[(idx + 1) % monitors.len()].clone())
            }
            super::MonitorDest::Left | super::MonitorDest::Right => {
                let Some(cur) = current else {
                    return Err("Could not read the window's current display.".to_string());
                };
                let candidates: Vec<_> = monitors
                    .iter()
                    .filter(|m| m.handle != cur.handle)
                    .cloned()
                    .collect();
                if candidates.is_empty() {
                    return Err("There's no other display to move to.".to_string());
                }
                let picked = if dest == super::MonitorDest::Left {
                    candidates
                        .into_iter()
                        .filter(|m| m.monitor.left < cur.monitor.left)
                        .max_by_key(|m| m.monitor.left)
                } else {
                    candidates
                        .into_iter()
                        .filter(|m| m.monitor.left > cur.monitor.left)
                        .min_by_key(|m| m.monitor.left)
                };
                picked.ok_or_else(|| {
                    format!(
                        "There's no display to the {} of the current one.",
                        if dest == super::MonitorDest::Left {
                            "left"
                        } else {
                            "right"
                        }
                    )
                })
            }
        }
    }

    const BROWSER_STEMS: &[&str] = &["chrome", "msedge", "firefox"];

    /// Does this window belong to the requested target?
    ///
    /// The browser variants stay exact-stem matches - "close chrome" must never resolve to
    /// something merely chrome-ish. Either half is enough.
    fn window_matches_target(stem: &str, title: &str, target: &super::WindowTarget) -> bool {
        match target {
            super::WindowTarget::GenericBrowser => BROWSER_STEMS.iter().any(|s| stem == *s),
            super::WindowTarget::Chrome => stem == "chrome",
            super::WindowTarget::Edge => stem == "msedge" || stem == "edge",
            super::WindowTarget::Firefox => stem == "firefox",
            super::WindowTarget::Named(name) => {
                let needle = name.trim().to_lowercase();
                if needle.is_empty() {
                    return false;
                }
                stem.to_lowercase().contains(&needle)
                    || title.to_lowercase().contains(&needle)
            }
        }
    }

    fn matching_browser_window(
        hwnd: isize,
        own_pid: u32,
        target: &super::WindowTarget,
    ) -> Option<WinInfo> {
        if hwnd == 0 || unsafe { IsWindowVisible(hwnd as HwndPtr) } == 0 {
            return None;
        }
        let title = window_title(hwnd);
        if title.is_empty() {
            return None;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd as HwndPtr, &mut pid) };
        if pid == own_pid {
            return None;
        }
        let exe_stem = process_exe_stem(pid);
        window_matches_target(&exe_stem, &title, target).then_some(WinInfo {
            hwnd,
            title,
            exe_stem,
        })
    }

    /// A generic "browser" request is deliberately foreground-only: it either
    /// controls the allowlisted browser the owner is looking at or refuses. Explicit
    /// Chrome/Edge/Firefox requests keep documented topmost-match Z-order
    /// traversal (`GetTopWindow(NULL)` then `GetWindow(..., GW_HWNDNEXT)`).
    pub fn find_window_for_target(target: &super::WindowTarget) -> Option<WinInfo> {
        let own_pid = unsafe { GetCurrentProcessId() };

        if matches!(target, super::WindowTarget::GenericBrowser) {
            let foreground = unsafe { GetForegroundWindow() as isize };
            return matching_browser_window(foreground, own_pid, target);
        }

        let mut hwnd = unsafe { GetTopWindow(std::ptr::null_mut()) as isize };
        while hwnd != 0 {
            if let Some(window) = matching_browser_window(hwnd, own_pid, target) {
                return Some(window);
            }
            hwnd = unsafe { GetWindow(hwnd as HwndPtr, GW_HWNDNEXT) as isize };
        }
        None
    }

    fn short_title(title: &str) -> String {
        let t = title.trim();
        if t.chars().count() <= 64 {
            t.to_string()
        } else {
            let clipped: String = t.chars().take(61).collect();
            format!("{clipped}…")
        }
    }

    pub fn foreground_window() -> Option<isize> {
        let hwnd = unsafe { GetForegroundWindow() } as isize;
        (hwnd != 0).then_some(hwnd)
    }

    /// Best-effort title for an hwnd, so confirmations name the real window
    /// instead of saying a bare "Done".
    pub fn title_for(hwnd: isize) -> Option<String> {
        list_windows().into_iter().find(|w| w.hwnd == hwnd).map(|w| w.title)
    }

    /// Apply a window action to ANY window.
    ///
    /// The old `run_window_control` path only accepted three hardcoded browsers,
    /// so "maximize this window" came back as an ambiguous-command refusal. This
    /// is the generic entry point: the caller resolves the hwnd (by name, or the
    /// foreground window) and this just performs the action.
    pub fn apply_window_action(hwnd: isize, action: &str) -> Result<(), String> {
        match action {
            "minimize" => minimize_window(hwnd),
            "maximize" => maximize_window(hwnd),
            "restore" | "unmaximize" => restore_window(hwnd),
            "close" => close_window_graceful(hwnd),
            other => Err(format!("I don't know how to \"{other}\" a window.")),
        }
    }

    fn close_window_graceful(hwnd: isize) -> Result<(), String> {
        let ok = unsafe { PostMessageW(hwnd as HwndPtr, WM_CLOSE, 0, 0) };
        if ok == 0 {
            return Err("Windows refused the close request.".to_string());
        }
        for _ in 0..25 {
            if !is_alive(hwnd) {
                return Ok(());
            }
            // A hung save-dialog still counts as "HWND remains" - never claim success.
            std::thread::sleep(Duration::from_millis(100));
        }
        if is_alive(hwnd) {
            Err("the window is still open after a graceful close request".to_string())
        } else {
            Ok(())
        }
    }

    fn minimize_window(hwnd: isize) -> Result<(), String> {
        unsafe { ShowWindow(hwnd as HwndPtr, SW_MINIMIZE) };
        for _ in 0..15 {
            if unsafe { IsIconic(hwnd as HwndPtr) } != 0 {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        if unsafe { IsIconic(hwnd as HwndPtr) } != 0 {
            Ok(())
        } else {
            Err("the window did not minimize".to_string())
        }
    }

    fn maximize_window(hwnd: isize) -> Result<(), String> {
        if unsafe { IsIconic(hwnd as HwndPtr) } != 0 {
            unsafe { ShowWindow(hwnd as HwndPtr, SW_RESTORE) };
            std::thread::sleep(Duration::from_millis(80));
        }
        unsafe { ShowWindow(hwnd as HwndPtr, SW_MAXIMIZE) };
        for _ in 0..15 {
            if unsafe { IsZoomed(hwnd as HwndPtr) } != 0 {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        if unsafe { IsZoomed(hwnd as HwndPtr) } != 0 {
            Ok(())
        } else {
            Err("the window did not maximize".to_string())
        }
    }

    fn restore_window(hwnd: isize) -> Result<(), String> {
        unsafe { ShowWindow(hwnd as HwndPtr, SW_RESTORE) };
        unsafe { ShowWindow(hwnd as HwndPtr, SW_SHOW) };
        for _ in 0..15 {
            let iconic = unsafe { IsIconic(hwnd as HwndPtr) } != 0;
            let zoomed = unsafe { IsZoomed(hwnd as HwndPtr) } != 0;
            if !iconic && !zoomed {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        let iconic = unsafe { IsIconic(hwnd as HwndPtr) } != 0;
        let zoomed = unsafe { IsZoomed(hwnd as HwndPtr) } != 0;
        if !iconic && !zoomed {
            Ok(())
        } else {
            Err("the window did not restore".to_string())
        }
    }

    fn dest_label(dest: super::MonitorDest) -> String {
        match dest {
            super::MonitorDest::Primary => "your main monitor".to_string(),
            super::MonitorDest::Next => "the other monitor".to_string(),
            super::MonitorDest::Left => "the left monitor".to_string(),
            super::MonitorDest::Right => "the right monitor".to_string(),
            super::MonitorDest::Largest => "the largest monitor".to_string(),
            super::MonitorDest::Index(n) => format!("monitor {n}"),
        }
    }

    fn move_window_to_dest(hwnd: isize, dest: super::MonitorDest) -> Result<String, String> {
        let target = resolve_monitor_dest(hwnd, dest)?;
        let where_to = dest_label(dest);

        // Truthful no-op when the window is already on the requested display.
        if let Some(current) = monitor_of_window(hwnd) {
            if current.handle == target.handle {
                return Ok(format!("already on {where_to}"));
            }
        }

        // Mirror lib.rs: restore as needed → SetWindowPos → re-apply prior show state.
        let was_maximized = unsafe { IsZoomed(hwnd as HwndPtr) } != 0;
        let was_minimized = unsafe { IsIconic(hwnd as HwndPtr) } != 0;
        let plan = super::plan_move_show_state(was_maximized, was_minimized);
        if was_minimized || was_maximized {
            unsafe { ShowWindow(hwnd as HwndPtr, SW_RESTORE) };
            std::thread::sleep(Duration::from_millis(60));
        }
        let rect = window_rect(hwnd).ok_or_else(|| "could not read the window size".to_string())?;
        let mut width = (rect.right - rect.left).max(200);
        let mut height = (rect.bottom - rect.top).max(150);
        let work_w = (target.work.right - target.work.left).max(200);
        let work_h = (target.work.bottom - target.work.top).max(150);
        width = width.min(work_w);
        height = height.min(work_h);
        let x = target.work.left + ((work_w - width) / 2).max(0);
        let y = target.work.top + ((work_h - height) / 2).max(0);
        let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW;
        let ok = unsafe {
            SetWindowPos(
                hwnd as HwndPtr,
                HWND_TOP as HwndPtr,
                x,
                y,
                width,
                height,
                flags,
            )
        };
        if ok == 0 {
            return Err("Windows refused the move request.".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
        let after = monitor_of_window(hwnd)
            .ok_or_else(|| "could not verify the window's display".to_string())?;
        if after.handle != target.handle {
            return Err("the window did not land on the requested display".to_string());
        }
        match plan {
            super::MoveShowPlan::UnmaximizeMoveRemaximize => {
                maximize_window(hwnd).map_err(|e| {
                    format!("moved the window but could not restore maximized state ({e})")
                })?;
                if unsafe { IsZoomed(hwnd as HwndPtr) } == 0 {
                    return Err("moved the window but it is no longer maximized".to_string());
                }
            }
            super::MoveShowPlan::RestoreMoveReminimize => {
                minimize_window(hwnd).map_err(|e| {
                    format!("moved the window but could not restore minimized state ({e})")
                })?;
                if unsafe { IsIconic(hwnd as HwndPtr) } == 0 {
                    return Err("moved the window but it is no longer minimized".to_string());
                }
            }
            super::MoveShowPlan::MoveOnly => {}
        }
        Ok(where_to)
    }

    /// Execute one graceful window-control action. Never force-terminates a process.
    pub fn run_window_control(
        target: &super::WindowTarget,
        action: super::WindowAction,
    ) -> Result<String, String> {
        let w = find_window_for_target(target).ok_or_else(|| match target {
            super::WindowTarget::GenericBrowser => {
                "I can only control a supported browser that is currently in front. Bring Chrome, Edge, or Firefox forward and try again.".to_string()
            }
            _ => format!(
                "I couldn't find an open {} window to control.",
                target.label()
            ),
        })?;
        if !is_alive(w.hwnd) {
            return Err(format!(
                "I couldn't find an open {} window to control.",
                target.label()
            ));
        }
        let title = short_title(&w.title);
        match action {
            super::WindowAction::Close => {
                close_window_graceful(w.hwnd)?;
                if is_alive(w.hwnd) {
                    return Err(format!(
                        "\"{title}\" is still open after a graceful close request"
                    ));
                }
                Ok(format!("Closed {title}."))
            }
            super::WindowAction::Minimize => {
                minimize_window(w.hwnd)?;
                Ok(format!("Minimized {title}."))
            }
            super::WindowAction::Maximize => {
                maximize_window(w.hwnd)?;
                Ok(format!("Maximized {title}."))
            }
            super::WindowAction::Restore => {
                restore_window(w.hwnd)?;
                Ok(format!("Restored {title}."))
            }
            super::WindowAction::Move(dest) => {
                let detail = move_window_to_dest(w.hwnd, dest)?;
                if let Some(rest) = detail.strip_prefix("already on ") {
                    Ok(format!("{title} is already on {rest}."))
                } else {
                    Ok(format!("Moved {title} to {detail}."))
                }
            }
        }
    }
}

#[cfg(not(windows))]
pub mod win {
    // Non-Windows stubs keep the module graph compiling in CI cross-checks.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_native_stop_matches_only_the_exact_owner() {
        assert!(native_owner_matches(Some("voice:one"), Some("voice:one")));
        assert!(!native_owner_matches(Some("voice:two"), Some("voice:one")));
        assert!(!native_owner_matches(None, Some("voice:one")));
        assert!(!native_owner_matches(Some("voice:one"), Some("")));
        assert!(!native_owner_matches(Some("voice:one"), None));
    }

    fn window_control(goal: &str) -> Option<(WindowTarget, WindowAction)> {
        match match_simple_op(goal) {
            Some(SimpleOp::WindowControl { target, action }) => Some((target, action)),
            _ => None,
        }
    }

    #[test]
    fn exact_close_browser_please_matches() {
        for phrase in ["Close my browser, please.", "Close my browser, please,"] {
            let (target, action) = window_control(phrase).expect("match");
            assert_eq!(target, WindowTarget::GenericBrowser, "{phrase}");
            assert_eq!(action, WindowAction::Close, "{phrase}");
        }
    }

    #[test]
    fn leading_request_wrappers_preserve_single_browser_actions() {
        for phrase in [
            "Please close my browser",
            "could you close my browser",
            "can you minimize chrome",
        ] {
            assert!(
                matches!(
                    match_simple_op(phrase),
                    Some(SimpleOp::WindowControl { .. })
                ),
                "{phrase}"
            );
        }
    }

    #[test]
    fn browser_aliases_and_explicit_browsers() {
        assert_eq!(
            window_control("close the web browser").unwrap(),
            (WindowTarget::GenericBrowser, WindowAction::Close)
        );
        assert_eq!(
            window_control("close chrome").unwrap(),
            (WindowTarget::Chrome, WindowAction::Close)
        );
        assert_eq!(
            window_control("minimize Google Chrome").unwrap(),
            (WindowTarget::Chrome, WindowAction::Minimize)
        );
        assert_eq!(
            window_control("maximize Microsoft Edge").unwrap(),
            (WindowTarget::Edge, WindowAction::Maximize)
        );
        assert_eq!(
            window_control("restore firefox").unwrap(),
            (WindowTarget::Firefox, WindowAction::Restore)
        );
        assert_eq!(
            window_control("close edge").unwrap(),
            (WindowTarget::Edge, WindowAction::Close)
        );
    }

    #[test]
    fn move_monitor_destinations() {
        assert_eq!(
            window_control("move my browser to the other monitor")
                .unwrap()
                .1,
            WindowAction::Move(MonitorDest::Next)
        );
        assert_eq!(
            window_control("move chrome to my next display").unwrap().1,
            WindowAction::Move(MonitorDest::Next)
        );
        assert_eq!(
            window_control("put edge on the main monitor").unwrap().1,
            WindowAction::Move(MonitorDest::Primary)
        );
        assert_eq!(
            window_control("move firefox to the left screen").unwrap().1,
            WindowAction::Move(MonitorDest::Left)
        );
        assert_eq!(
            window_control("move my browser to the right monitor")
                .unwrap()
                .1,
            WindowAction::Move(MonitorDest::Right)
        );
        assert_eq!(
            window_control("move chrome to the largest display")
                .unwrap()
                .1,
            WindowAction::Move(MonitorDest::Largest)
        );
        assert_eq!(
            window_control("move edge to monitor 2").unwrap().1,
            WindowAction::Move(MonitorDest::Index(2))
        );
        assert_eq!(
            window_control("put firefox on the third screen").unwrap().1,
            WindowAction::Move(MonitorDest::Index(3))
        );
    }

    #[test]
    fn next_monitor_fails_honestly_with_one_display() {
        let err = require_other_display(1).expect_err("one display is not 'other'");
        assert!(err.contains("no other display"), "got: {err}");
        assert!(require_other_display(0).is_err());
        assert!(require_other_display(2).is_ok());
        assert!(require_other_display(3).is_ok());
    }

    #[test]
    fn move_preserves_maximized_state_plan() {
        assert_eq!(
            plan_maximized_move(true),
            MoveShowPlan::UnmaximizeMoveRemaximize
        );
        assert_eq!(plan_maximized_move(false), MoveShowPlan::MoveOnly);
    }

    #[test]
    fn move_preserves_minimized_state_plan() {
        assert_eq!(
            plan_move_show_state(false, true),
            MoveShowPlan::RestoreMoveReminimize
        );
        // Minimized wins over maximized when both are reported.
        assert_eq!(
            plan_move_show_state(true, true),
            MoveShowPlan::RestoreMoveReminimize
        );
    }

    #[test]
    fn a_compound_declines_so_the_sequencer_can_run_both_halves() {
        // THE regression this whole change exists for.
        //
        // None is not a shrug - it means "this one-step fast path does not handle
        // two steps", and the sequencing path takes it from here. Refusing instead
        // is what ended the conversation.
        for phrase in [
            "open google chrome and type this into my search bar",
            "open chrome and search for cats",
            "close my browser and open notepad",
            "close chrome then minimize edge",
            "close chrome; maximize edge",
            "move chrome to monitor 2 or close firefox",
            "move chrome to monitor 2 delete a file",
            "focus chrome and delete a file",
            "focus chrome switch to live mode",
            "switch to chrome and set trust to sovereign",
            "set trust to sovereign and close chrome",
            "set trust to sovereign close chrome",
            "delete a file close chrome",
            "go do everything close chrome",
            "open command center close chrome",
            "open foobar and switch to live mode",
            "set trust to sovereign and open foobar",
            "switch to live mode and open foobar",
            "open foobar and set trust to sovereign",
            "open foo close bar",
            "close bar open foo",
        ] {
            assert!(
                match_simple_op(phrase).is_none(),
                "{phrase} should DECLINE to the sequencer, got {:?}",
                match_simple_op(phrase)
            );
        }
    }

    #[test]
    fn any_open_window_can_be_named_not_only_four_browsers() {
        // The target set used to be chrome/edge/firefox/generic, and every other
        // window was a refusal - so "focus Obsidian" could not be said out loud.
        for (phrase, expected) in [
            ("close safari", WindowTarget::Named("safari".to_string())),
            ("close notepad", WindowTarget::Named("notepad".to_string())),
            ("minimize cursor", WindowTarget::Named("cursor".to_string())),
            (
                "move obsidian to monitor 2",
                WindowTarget::Named("obsidian".to_string()),
            ),
            ("close my browser", WindowTarget::GenericBrowser),
            ("place chrome on monitor 2", WindowTarget::Chrome),
        ] {
            match match_simple_op(phrase) {
                Some(SimpleOp::WindowControl { target, .. }) => {
                    assert_eq!(target, expected, "{phrase}");
                }
                other => panic!("{phrase} should be window control, got {other:?}"),
            }
        }
        // "hide X" means minimize X. It used to be an "unsupported control verb".
        assert!(matches!(
            match_simple_op("hide my browser"),
            Some(SimpleOp::WindowControl {
                action: WindowAction::Minimize,
                ..
            })
        ));
    }

    #[test]
    fn naming_no_window_at_all_is_the_one_thing_still_worth_asking_about() {
        // Not a policy refusal - there is genuinely nothing to resolve. Everything
        // else either runs or declines to a wider actuator.
        for phrase in [
            "close",
            "minimize",
            "close the window",
            "move to monitor 2",
            "move chrome aside",
        ] {
            match match_simple_op(phrase) {
                Some(SimpleOp::Refuse { message }) => {
                    assert_eq!(message, WINDOW_REFUSAL, "{phrase}");
                }
                other => panic!("{phrase} should ask which window, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_refusal_is_never_reported_as_a_match() {
        // The precedence bug: `native_op_matches` answered `is_some()`, so a local
        // Refuse looked like "this actuator handles it". The router then called
        // native_op_try, got the refusal back as an error, spoke it, and stopped -
        // pre-empting every wider path that would have succeeded.
        for phrase in ["close", "minimize", "close the window"] {
            assert!(matches!(
                match_simple_op(phrase),
                Some(SimpleOp::Refuse { .. })
            ));
            assert!(
                !native_op_matches(phrase.to_string()),
                "{phrase}: a Refuse must not claim to be a match"
            );
        }
        // A real op still matches.
        assert!(native_op_matches("open chrome".to_string()));
        assert!(native_op_matches("close safari".to_string()));
    }

    #[test]
    fn ordinary_english_is_still_not_a_window_command() {
        // The guard that keeps a wider target set from swallowing normal speech.
        for phrase in [
            "move the meeting aside",
            "bring the book to me",
            "put the groceries away",
            "hide and seek",
            "I am open to switching approaches",
            "the store is open and close to home",
        ] {
            assert!(
                match_simple_op(phrase).is_none(),
                "{phrase} is not a window command, got {:?}",
                match_simple_op(phrase)
            );
        }
    }

        #[test]
    fn close_everything_declines_to_an_actuator_that_can_enumerate_windows() {
        // The fast path only knows how to control ONE window, so it declines and something wider
        // does the work - which is the honest version of the same fact.
        for phrase in [
            "close everything",
            "minimize everything",
            "close all browsers",
            "minimize all windows",
            "hide every browser",
            "get rid of all apps",
            "close all tabs",
        ] {
            assert!(
                match_simple_op(phrase).is_none(),
                "{phrase} should decline, got {:?}",
                match_simple_op(phrase)
            );
        }
        // Named single-window closes remain real window-control ops.
        assert!(matches!(
            match_simple_op("close my browser"),
            Some(SimpleOp::WindowControl {
                action: WindowAction::Close,
                ..
            })
        ));
    }

    /// "chrome" instead of opening the browser, because "google " is a search verb
    /// and the search branch was checked before the open branch. An app's own name
    /// must never be treated as a query.
    #[test]
    fn app_names_beat_search_verbs() {
        for phrase in ["google chrome", "open google chrome", "launch google chrome"] {
            assert!(
                matches!(match_simple_op(phrase), Some(SimpleOp::Open { .. })),
                "{phrase} should OPEN Chrome, not search for it"
            );
        }
        // A real query that merely starts with the same verb must still search.
        assert!(matches!(
            match_simple_op("google the weather in Lisbon"),
            Some(SimpleOp::Search { .. })
        ));
        assert!(matches!(
            match_simple_op("google how to poach an egg"),
            Some(SimpleOp::Search { .. })
        ));
    }

    #[test]
    fn existing_open_focus_media_still_match() {
        assert!(matches!(
            match_simple_op("open chrome"),
            Some(SimpleOp::Open { .. })
        ));
        assert!(matches!(
            match_simple_op("focus obsidian"),
            Some(SimpleOp::Focus { .. })
        ));
        assert!(matches!(
            match_simple_op("volume up"),
            Some(SimpleOp::Media(_))
        ));
        assert!(matches!(
            match_simple_op("next track"),
            Some(SimpleOp::Media(_))
        ));
        assert!(matches!(
            match_simple_op("search for the weather in Lisbon"),
            Some(SimpleOp::Search { .. })
        ));
        // A compound declines to the sequencer; it is no longer a refusal.
        assert!(match_simple_op("open chrome and search for cats").is_none());
    }


    #[test]
    fn politeness_comma_does_not_block_open() {
        assert!(matches!(
            match_simple_op("open chrome, please"),
            Some(SimpleOp::Open { .. })
        ));
    }
}
