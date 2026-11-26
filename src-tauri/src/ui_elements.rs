//! ui_elements.rs - click things by NAME instead of by pixel, and make sure the click LANDED.
//!
//! Every click Atlas could make was a PIXEL click read off a downscaled screenshot by an
//! audio-first model. On Windows that is unnecessary: a "Continue" button already knows it
//! is named "Continue", and UI Automation can find it by that name.
//!
//! WHY IT WAS STILL STUCK (reproduced live 2026-09-17 on duolingo.com). The 09-15 version
//! pressed the control with `IUIAutomationInvokePattern::Invoke`, which returned SUCCESS -
//! Atlas said "Clicked CONTINUE." - and the page did not move. Twice in a row (the
//! "Spanish" card, then CONTINUE). A real mouse click on the same pixel advanced the page
//! at once. Chromium maps Invoke to an accessibility "default action", and modern React
//! sites (and every Electron app) wire their buttons to pointer events that a default
//! action never fires. So on real sites the old tool reported a click that never happened,
//! and nothing downstream could tell. That is exactly "it gets stopped at a Continue button".
//!
//! What this version does, in order:
//!   1. FIND by name with ONE native UIA query (substring + ignore-case run inside the
//!      target process). The old matcher walked the tree node-by-node from Rust and waited
//!      out a 2.5 s timeout in every scope with no match - 6–8 s per click, measured.
//!   2. RANK: page content before browser chrome, exact label before prefix before word,
//!      enabled before greyed-out, real controls before bare text.
//!   3. MAKE IT CLICKABLE: scroll it into view if it is off-screen, bring its window to the
//!      front, and hit-test the point - if something else (a cookie banner, a modal) covers
//!      it, say what, instead of clicking the cover.
//!   4. PRESS IT LIKE A HAND: web/Electron content gets a real mouse click; native controls
//!      keep Invoke (reliable there, and it does not move the pointer).
//!   5. VERIFY: fingerprint the page before and after (title, URL, the control itself, the
//!      pressable controls around it). If nothing changed, try the keyboard (focus + Enter)
//!      once, then say honestly that the page did not respond. Never "Clicked" for a no-op.
//!   6. When UI Automation cannot see the control at all, READ THE SCREEN: Windows' built-in
//!      OCR finds the label's pixels (screen_ocr.rs) and the same verified click follows.
//!
//! (One public voice agent, read as a reference, clicks raw x/y via
//! AppleScript and its screenshot tool returns only a file
//! path, so its model never sees the screen. Element-level clicking plus a screen-read
//! fallback is the Windows answer; there was nothing further to copy.)
//!
//! THREADING: every entry point hops to `spawn_blocking`. A synchronous `#[tauri::command]`
//! runs on the UI thread, and UIA calls can take hundreds of ms - that is the exact shape
//! that froze the app on 2026-09-15 (see praxis-blocking-tauri-command-kills-app).
//! `UIAutomation::new()` also initialises COM as MTA per call, which must not happen on
//! the WebView2 thread.

use serde::Serialize;

/// Cap on elements returned, so a huge page cannot flood the model's context.
const MAX_ELEMENTS: usize = 120;

/// One interactable thing on screen, as the model should see it.
#[derive(Serialize, Clone, Debug)]
pub struct UiElement {
    pub name: String,
    /// "Button", "Hyperlink", "MenuItem", "CheckBox", "Edit", "TabItem", …
    pub control_type: String,
    /// False for greyed-out controls. The model must not keep retrying a disabled button.
    pub enabled: bool,
    /// Centre point in SCREEN pixels.
    pub x: i32,
    pub y: i32,
}

/// Result of a click attempt, in words the voice path can speak verbatim.
#[derive(Serialize, Clone, Debug)]
pub struct UiClickResult {
    pub ok: bool,
    pub message: String,
    /// How it was pressed: "mouse", "keyboard", "invoke", "ocr-mouse", or "none".
    pub method: String,
    /// What was actually matched, so a wrong match is visible in the transcript rather
    /// than silently doing the wrong thing.
    pub matched: Option<UiElement>,
    /// Whether Praxis SAW the screen change after pressing. `false` with `ok: true` only
    /// happens for native controls pressed by Invoke, which can legitimately change nothing
    /// visible (a toggle that only flips app state).
    #[serde(default)]
    pub verified: bool,
}

/// Result of putting text into a named field, in words the voice path can speak verbatim.
#[derive(Serialize, Clone, Debug)]
pub struct UiFillResult {
    pub ok: bool,
    pub message: String,
    /// The field that was matched, so a wrong match is visible in the transcript.
    pub matched: Option<UiElement>,
    /// Whether the field's own value was read back and contains the text.
    pub verified: bool,
    /// The suggestion that was accepted (Enter) because it covered the field.
    pub accepted: Option<String>,
}

/// Is this control a place text goes? Text-field types always are; a pressable control
/// never is, even when it exposes a value (Chromium gives every link a read-only
/// ValuePattern holding its URL); anything else is when it takes a value or text.
pub(crate) fn field_kind(control_type: &str, writable_value: bool, text_pattern: bool) -> bool {
    match control_type {
        "Edit" | "Document" | "ComboBox" => true,
        "Button" | "Hyperlink" | "MenuItem" | "CheckBox" | "RadioButton" | "TabItem" | "ListItem" | "TreeItem"
        | "SplitButton" => false,
        _ => writable_value || text_pattern,
    }
}

/// How long a typed value counts as "ours" when a suggestion list covers the next field.
pub(crate) const OWN_SUGGESTION_SECS: u64 = 90;

/// Did OUR OWN typing open the thing that covers a field?
pub(crate) fn covered_by_own_suggestion(cover: &str, typed: &str, age: std::time::Duration) -> bool {
    let typed = typed.trim().to_lowercase();
    !typed.is_empty() && age.as_secs() <= OWN_SUGGESTION_SECS && cover.to_lowercase().contains(&typed)
}

/// Does a field's read-back value hold the text typed into it? Whitespace-collapsed and
/// case-insensitive: an editor may re-wrap lines or auto-capitalise the first letter.
pub(crate) fn value_holds(value: &str, text: &str) -> bool {
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let want = norm(text);
    !want.is_empty() && norm(value).contains(&want)
}

/// The key pressed after filling a field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Submit {
    Enter,
    Tab,
}

pub(crate) fn parse_submit(raw: Option<&str>) -> Result<Option<Submit>, String> {
    match raw.map(|s| s.trim().to_lowercase()).as_deref() {
        None | Some("") | Some("none") => Ok(None),
        Some("enter") | Some("return") => Ok(Some(Submit::Enter)),
        Some("tab") => Ok(Some(Submit::Tab)),
        Some(other) => Err(format!("After filling a field I can press enter or tab, not {other:?}.")),
    }
}

/// The spoken result of a fill: "Filled "Subject" with "hello"." only when the value was
/// read back; otherwise the honest "Typed into … but can't read it back".
pub(crate) fn fill_message(field: &str, text: &str, submit: Option<Submit>, read_back: bool, accepted: Option<&str>) -> String {
    let preview: String = text.chars().take(60).collect();
    let preview = if text.chars().count() > 60 { format!("{preview}…") } else { preview };
    let core = if read_back {
        format!("filled {field:?} with {preview:?}")
    } else {
        format!("typed into {field:?} but can't read it back")
    };
    let pressed = match submit {
        Some(Submit::Enter) => ", then pressed Enter",
        Some(Submit::Tab) => ", then pressed Tab",
        None => "",
    };
    match accepted {
        Some(s) => format!("Accepted the suggestion {s:?}, then {core}{pressed}."),
        None => {
            let mut c = core.chars();
            let first = c.next().map(|f| f.to_uppercase().collect::<String>()).unwrap_or_default();
            format!("{first}{}{pressed}.", c.as_str())
        }
    }
}

/// Score a candidate against the spoken target. Lower is better; `None` means "not a
/// match at all". Exact beats prefix beats whole-word-substring, so "Continue" wins
/// over "Continue without saving" when both are on screen.
///
/// The substring rule is DELIBERATELY strict, because the loose version clicked the
/// wrong thing on the first live run (2026-09-15): asked for "Continue", it pressed an
/// Edge toolbar button named "Use the new ChatGPT side chat feature. Open the ChatGPT
/// extension to continue., NEW". Two guards, both learned from that miss:
///   * WHOLE WORD only - "continue" must not match inside "continued".
///   * LENGTH RATIO - a control whose name is far longer than what was asked for is
///     prose, not a label. Pressing something the user never named is worse than
///     saying "I can't find it", because they cannot see that it happened.
pub(crate) fn score(candidate: &str, want: &str) -> Option<u8> {
    let c = candidate.trim().to_lowercase();
    let w = want.trim().to_lowercase();
    if w.is_empty() {
        return None;
    }
    if c == w {
        return Some(0);
    }
    if c.starts_with(&w) {
        // "Continue without saving" / "Spanish 42.2M learners" - a real, if less exact, label.
        let next = c[w.len()..].chars().next();
        if next.is_none_or(|ch| !ch.is_alphanumeric()) {
            return Some(1);
        }
    }
    const MAX_NAME_RATIO: usize = 4;
    if c.len() > w.len().saturating_mul(MAX_NAME_RATIO).max(24) {
        return None;
    }
    let is_boundary = |b: Option<char>| b.is_none_or(|ch| !ch.is_alphanumeric());
    let mut from = 0usize;
    while let Some(idx) = c[from..].find(&w) {
        let at = from + idx;
        let before = c[..at].chars().next_back();
        let after = c[at + w.len()..].chars().next();
        if is_boundary(before) && is_boundary(after) {
            return Some(2);
        }
        from = at + w.len().max(1);
        if from >= c.len() {
            break;
        }
    }
    None
}

/// Where a candidate sits, which decides how it gets pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Surface {
    /// Inside a web document (a browser page, or an Electron app's content).
    Page,
    /// Native window chrome / a native app control.
    Native,
}

/// Ranking key for one candidate (lower sorts first). Pure, so it is tested.
pub(crate) fn rank_key(name_rank: u8, enabled: bool, interactable: bool, surface: Surface, offscreen: bool) -> (u8, u8, u8, u8, u8) {
    (
        // Page content first: when the user says "click Continue" while reading a page,
        // they mean the page, not a toolbar button that happens to share a word.
        if surface == Surface::Page { 0 } else { 1 },
        name_rank,
        if enabled { 0 } else { 1 },
        if interactable { 0 } else { 1 },
        if offscreen { 1 } else { 0 },
    )
}

/// Whether a document lies inside its window's rectangle (left, top, right, bottom), i.e.
/// is the page on screen. Measured 2026-09-18 in Edge: next to the Duolingo tab the window's
/// tree held a hidden "Google" document 2549 px wide in a 1536 px window; read first, it
/// made "list elements" answer with Google's buttons instead of Duolingo's.
pub(crate) fn doc_on_screen(win: (i32, i32, i32, i32), doc: (i32, i32, i32, i32)) -> bool {
    const SLACK: i32 = 24;
    let ((wl, wt, wr, wb), (dl, dt, dr, db)) = (win, doc);
    dr > dl && db > dt && dl >= wl - SLACK && dt >= wt - SLACK && dr <= wr + SLACK && db <= wb + SLACK
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{Duration, Instant};
    use uiautomation::controls::ControlType;
    use uiautomation::patterns::{
        UIInvokePattern, UIScrollItemPattern, UISelectionItemPattern, UITextPattern, UITogglePattern, UIValuePattern,
    };
    use uiautomation::types::{Handle, Point, PropertyConditionFlags, TreeScope, UIProperty};
    use uiautomation::variants::Variant;
    use uiautomation::{UIAutomation, UIElement as UiaElement};

    /// Control types worth offering as "things you can click or type into".
    fn interactable(ct: ControlType) -> bool {
        matches!(
            ct,
            ControlType::Button
                | ControlType::Hyperlink
                | ControlType::MenuItem
                | ControlType::CheckBox
                | ControlType::RadioButton
                | ControlType::TabItem
                | ControlType::ListItem
                | ControlType::Edit
                | ControlType::ComboBox
                | ControlType::SplitButton
                | ControlType::TreeItem
        )
    }

    /// Named-but-not-a-control types that are still worth pressing when nothing better
    /// matches: the text inside a `<div onclick>` button, a clickable image, a card.
    fn pressable_fallback(ct: ControlType) -> bool {
        matches!(ct, ControlType::Text | ControlType::Group | ControlType::Custom | ControlType::Image | ControlType::Pane)
    }

    #[derive(Clone, Copy)]
    struct R {
        l: i32,
        t: i32,
        r: i32,
        b: i32,
    }
    impl R {
        fn of(e: &UiaElement) -> Option<R> {
            let rect = e.get_bounding_rectangle().ok()?;
            let r = R { l: rect.get_left(), t: rect.get_top(), r: rect.get_right(), b: rect.get_bottom() };
            (r.r > r.l && r.b > r.t).then_some(r)
        }
        fn cx(&self) -> i32 {
            self.l + (self.r - self.l) / 2
        }
        fn cy(&self) -> i32 {
            self.t + (self.b - self.t) / 2
        }
        fn contains(&self, x: i32, y: i32) -> bool {
            x >= self.l && x < self.r && y >= self.t && y < self.b
        }
    }

    /// The window to act in: the named one, or the one in front - never Praxis itself.
    ///
    /// When the owner talks to Atlas, a Praxis window (the voice pill, the Atlas panel) can hold
    /// focus. "Click continue" means the page he is looking at, not Praxis's own UI, so Praxis
    /// windows are skipped and the topmost real window is used.
    fn target_window(window: Option<&str>) -> Result<(isize, String), String> {
        use crate::native_ops::win;
        if let Some(title) = window.map(str::trim).filter(|w| !w.is_empty()) {
            return win::find_window_matching(title)
                .map(|w| (w.hwnd, w.title))
                .ok_or_else(|| format!("I couldn't find a window called {title:?}."));
        }
        let windows = win::list_windows(); // visible, titled, NOT Praxis, in Z-order
        if let Some(fg) = win::foreground_window() {
            if let Some(w) = windows.iter().find(|w| w.hwnd == fg) {
                return Ok((w.hwnd, w.title.clone()));
            }
        }
        windows
            .into_iter()
            .next()
            .map(|w| (w.hwnd, w.title))
            .ok_or_else(|| "I couldn't find a window to click in.".to_string())
    }

    /// Every document in the window's tree, shown or not.
    fn all_documents(automation: &UIAutomation, root: &UiaElement) -> Vec<UiaElement> {
        automation
            .create_property_condition(UIProperty::ControlType, Variant::from(ControlType::Document as i32), None)
            .ok()
            .and_then(|c| root.find_all(TreeScope::Descendants, &c).ok())
            .unwrap_or_default()
    }

    /// The window's documents split into the page(s) on screen and the ones that aren't
    /// (see `doc_on_screen`).
    fn split_documents(automation: &UIAutomation, root: &UiaElement) -> (Vec<UiaElement>, Vec<UiaElement>) {
        let all = all_documents(automation, root);
        let Some(w) = R::of(root) else { return (all, Vec::new()) };
        all.into_iter().partition(|d| {
            !d.is_offscreen().unwrap_or(false)
                && R::of(d).is_some_and(|r| super::doc_on_screen((w.l, w.t, w.r, w.b), (r.l, r.t, r.r, r.b)))
        })
    }

    /// The page(s) he can see in this window.
    pub(crate) fn documents(automation: &UIAutomation, root: &UiaElement) -> Vec<UiaElement> {
        split_documents(automation, root).0
    }

    /// Whether `el` belongs to one of the `hidden` documents (walks up to its document).
    fn in_hidden_document(automation: &UIAutomation, el: &UiaElement, hidden: &[UiaElement]) -> bool {
        if hidden.is_empty() {
            return false;
        }
        let Ok(walker) = automation.get_control_view_walker() else { return false };
        let mut cur = el.clone();
        for _ in 0..64 {
            let Ok(parent) = walker.get_parent(&cur) else { return false };
            match parent.get_control_type() {
                Ok(ControlType::Document) => return hidden.iter().any(|h| automation.compare_elements(h, &parent).unwrap_or(false)),
                Ok(ControlType::Window) => return false,
                _ => {}
            }
            cur = parent;
        }
        false
    }

    struct Candidate {
        el: UiaElement,
        ui: UiElement,
        rect: R,
        name_rank: u8,
        interactable: bool,
        surface: Surface,
        offscreen: bool,
    }

    /// What a name search is looking for: something to press, or a field to type into.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Want {
        Press,
        Field,
    }

    /// A place text goes (see `field_kind`).
    fn is_field(el: &UiaElement, ct: ControlType) -> bool {
        let writable_value = el
            .get_pattern::<UIValuePattern>()
            .ok()
            .and_then(|v| v.is_readonly().ok())
            .is_some_and(|read_only| !read_only);
        let text_pattern = el.get_pattern::<UITextPattern>().is_ok();
        super::field_kind(&format!("{ct:?}"), writable_value, text_pattern)
    }

    /// A text node inside a real control should press the CONTROL (its name is usually
    /// the same text). Walk up a few levels to find it.
    fn control_ancestor(automation: &UIAutomation, el: &UiaElement, want: Want) -> Option<UiaElement> {
        let walker = automation.get_control_view_walker().ok()?;
        let mut cur = el.clone();
        for _ in 0..4 {
            cur = walker.get_parent(&cur).ok()?;
            let ct = cur.get_control_type().ok()?;
            let accept = match want {
                Want::Press => interactable(ct),
                Want::Field => ct != ControlType::Document && is_field(&cur, ct),
            };
            if accept {
                return Some(cur);
            }
            if matches!(ct, ControlType::Document | ControlType::Window) {
                return None;
            }
        }
        None
    }

    fn candidates(automation: &UIAutomation, root: &UiaElement, want: &str) -> Vec<Candidate> {
        candidates_for(automation, root, want, Want::Press)
    }

    fn candidates_for(automation: &UIAutomation, root: &UiaElement, want: &str, kind: Want) -> Vec<Candidate> {
        let Ok(cond) = automation.create_property_condition(
            UIProperty::Name,
            Variant::from(want.trim()),
            Some(PropertyConditionFlags::All),
        ) else {
            return Vec::new();
        };
        let mut found = root.find_all(TreeScope::Descendants, &cond).unwrap_or_default();
        if found.is_empty() {
            // Chromium builds its accessibility tree lazily, the first time a UIA client
            // asks. A page nobody has queried yet can answer "nothing here" once.
            std::thread::sleep(Duration::from_millis(450));
            found = root.find_all(TreeScope::Descendants, &cond).unwrap_or_default();
        }
        let (shown, hidden) = split_documents(automation, root);
        let docs: Vec<R> = shown.iter().filter_map(R::of).collect();
        let mut out: Vec<Candidate> = Vec::new();
        for raw in found.into_iter().take(200) {
            let Ok(name) = raw.get_name() else { continue };
            let Some(name_rank) = score(&name, want) else { continue };
            if in_hidden_document(automation, &raw, &hidden) {
                continue; // a page that isn't on screen
            }
            let Ok(ct) = raw.get_control_type() else { continue };
            let direct = match kind {
                Want::Press => interactable(ct),
                // The page itself is a Document too, named after its title: never a field.
                Want::Field => {
                    is_field(&raw, ct)
                        && !(ct == ControlType::Document && shown.iter().any(|d| automation.compare_elements(d, &raw).unwrap_or(false)))
                }
            };
            let (el, ct, name) = if direct {
                (raw, ct, name)
            } else if pressable_fallback(ct) {
                match control_ancestor(automation, &raw, kind) {
                    Some(parent) => {
                        let pname = parent.get_name().unwrap_or_default();
                        let pct = parent.get_control_type().unwrap_or(ct);
                        // Keep the parent's own name when it has one that still matches.
                        let use_name = if score(&pname, want).is_some() { pname } else { name };
                        (parent, pct, use_name)
                    }
                    None if kind == Want::Field => continue, // a label is not the field
                    None => (raw, ct, name),
                }
            } else {
                continue;
            };
            let Some(rect) = R::of(&el) else { continue };
            let offscreen = el.is_offscreen().unwrap_or(false);
            let surface = if docs.iter().any(|d| d.contains(rect.cx(), rect.cy())) || (offscreen && !docs.is_empty()) {
                Surface::Page
            } else {
                Surface::Native
            };
            let ui = UiElement {
                name: name.trim().to_string(),
                control_type: format!("{ct:?}"),
                enabled: el.is_enabled().unwrap_or(true),
                x: rect.cx(),
                y: rect.cy(),
            };
            // Chromium exposes one control through several nodes; keep one per place.
            if out.iter().any(|c| c.ui.x == ui.x && c.ui.y == ui.y && c.ui.name.eq_ignore_ascii_case(&ui.name)) {
                continue;
            }
            out.push(Candidate {
                el,
                name_rank: score(&ui.name, want).unwrap_or(name_rank),
                interactable: interactable(ct),
                ui,
                rect,
                surface,
                offscreen,
            });
        }
        out.sort_by_key(|c| rank_key(c.name_rank, c.ui.enabled, c.interactable, c.surface, c.offscreen));
        out
    }

    /// A cheap fingerprint of "what the user sees": window title, page URL(s), the target
    /// control's own state, and the names of the pressable controls in scope. A click that
    /// did anything changes at least one of these.
    fn fingerprint(automation: &UIAutomation, root: &UiaElement, target: Option<&UiaElement>) -> u64 {
        let mut h = DefaultHasher::new();
        root.get_name().unwrap_or_default().hash(&mut h);
        let docs = documents(automation, root);
        for d in docs.iter().take(4) {
            d.get_name().unwrap_or_default().hash(&mut h);
            if let Ok(v) = d.get_pattern::<UIValuePattern>() {
                v.get_value().unwrap_or_default().hash(&mut h);
            }
        }
        if let Some(t) = target {
            match t.get_name() {
                Ok(n) => n.hash(&mut h),
                Err(_) => "<gone>".hash(&mut h),
            }
            if let Some(r) = R::of(t) {
                (r.l, r.t, r.r, r.b).hash(&mut h);
            }
            t.is_enabled().unwrap_or(false).hash(&mut h);
            if let Ok(tp) = t.get_pattern::<UITogglePattern>() {
                format!("{:?}", tp.get_toggle_state()).hash(&mut h);
            }
        }
        let scope: Vec<UiaElement> = if docs.is_empty() { vec![root.clone()] } else { docs };
        let kinds = [ControlType::Button, ControlType::Hyperlink, ControlType::Edit, ControlType::CheckBox, ControlType::RadioButton, ControlType::ListItem];
        let mut cond = automation.create_property_condition(UIProperty::ControlType, Variant::from(kinds[0] as i32), None).ok();
        for k in &kinds[1..] {
            if let (Some(c), Ok(next)) = (cond.take(), automation.create_property_condition(UIProperty::ControlType, Variant::from(*k as i32), None)) {
                cond = automation.create_or_condition(c, next).ok();
            }
        }
        if let Some(c) = cond {
            for s in scope.iter().take(4) {
                for e in s.find_all(TreeScope::Descendants, &c).unwrap_or_default().iter().take(400) {
                    e.get_name().unwrap_or_default().hash(&mut h);
                    e.is_enabled().unwrap_or(false).hash(&mut h);
                }
            }
        }
        h.finish()
    }

    fn changed_within(automation: &UIAutomation, root: &UiaElement, target: Option<&UiaElement>, before: u64, budget: Duration) -> bool {
        let start = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(180));
            if fingerprint(automation, root, target) != before {
                return true;
            }
            if start.elapsed() >= budget {
                return false;
            }
        }
    }

    /// Is keyboard focus on `target` or inside it? The check that makes a UIA `SetFocus`
    /// trustworthy before typing or pressing Enter without a pointer.
    fn focus_is_on(automation: &UIAutomation, target: &UiaElement) -> bool {
        let Ok(focused) = automation.get_focused_element() else { return false };
        if automation.compare_elements(&focused, target).unwrap_or(false) {
            return true;
        }
        let Ok(walker) = automation.get_control_view_walker() else { return false };
        let mut cur = focused;
        for _ in 0..12 {
            match walker.get_parent(&cur) {
                Ok(p) => {
                    if automation.compare_elements(&p, target).unwrap_or(false) {
                        return true;
                    }
                    cur = p;
                }
                Err(_) => break,
            }
        }
        false
    }

    /// Is the element under (x, y) the target itself (or inside it)? If not, return what
    /// is covering it so the caller can name it.
    fn hit_test(automation: &UIAutomation, target: &UiaElement, x: i32, y: i32) -> Result<(), Option<String>> {
        let Ok(hit) = automation.element_from_point(Point::new(x, y)) else { return Ok(()) };
        if automation.compare_elements(&hit, target).unwrap_or(false) {
            return Ok(());
        }
        let Ok(walker) = automation.get_control_view_walker() else { return Ok(()) };
        // Hit inside the target (a label or icon inside the button)?
        let mut cur = hit.clone();
        for _ in 0..12 {
            match walker.get_parent(&cur) {
                Ok(p) => {
                    if automation.compare_elements(&p, target).unwrap_or(false) {
                        return Ok(());
                    }
                    cur = p;
                }
                Err(_) => break,
            }
        }
        // Hit an ancestor of the target (accessibility hit-testing is coarse on some
        // pages)? The pixel still belongs to the target's area - fine to click.
        let mut cur = target.clone();
        for _ in 0..12 {
            match walker.get_parent(&cur) {
                Ok(p) => {
                    if automation.compare_elements(&p, &hit).unwrap_or(false) {
                        return Ok(());
                    }
                    cur = p;
                }
                Err(_) => break,
            }
        }
        // Another app's window on top of that pixel, or an overlay in the page.
        let same_process = hit.get_process_id().ok() == target.get_process_id().ok();
        let cover = hit.get_name().unwrap_or_default().trim().to_string();
        if !same_process || !cover.is_empty() {
            return Err((!cover.is_empty()).then_some(cover));
        }
        Ok(())
    }

    fn mouse_click(x: i32, y: i32) -> Result<(), String> {
        crate::desktop_ops::click_screen_point(x, y).map(|_| ())
    }

    fn press_enter() -> Result<(), String> {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("keyboard init failed: {e}"))?;
        enigo.key(Key::Return, Direction::Click).map_err(|e| format!("Enter failed: {e}"))
    }

    fn fail(message: String, matched: Option<UiElement>) -> UiClickResult {
        UiClickResult { ok: false, message, method: "none".into(), matched, verified: false }
    }

    pub fn list(window: Option<String>) -> Result<Vec<UiElement>, String> {
        let automation = UIAutomation::new().map_err(|e| format!("UI Automation init failed: {e}"))?;
        let (hwnd, _) = target_window(window.as_deref())?;
        let root = automation.element_from_handle(Handle::from(hwnd)).map_err(|e| format!("I couldn't read that window ({e})."))?;
        let kinds = [
            ControlType::Button, ControlType::Hyperlink, ControlType::MenuItem, ControlType::CheckBox, ControlType::RadioButton,
            ControlType::TabItem, ControlType::ListItem, ControlType::Edit, ControlType::ComboBox, ControlType::SplitButton,
        ];
        let mut cond = automation
            .create_property_condition(UIProperty::ControlType, Variant::from(kinds[0] as i32), None)
            .map_err(|e| e.to_string())?;
        for k in &kinds[1..] {
            let next = automation.create_property_condition(UIProperty::ControlType, Variant::from(*k as i32), None).map_err(|e| e.to_string())?;
            cond = automation.create_or_condition(cond, next).map_err(|e| e.to_string())?;
        }
        let (docs, hidden) = split_documents(&automation, &root);
        // No page on screen (between two pages): read the window, minus the hidden pages.
        let filter_hidden = docs.is_empty() && !hidden.is_empty();
        let scopes: Vec<UiaElement> = if docs.is_empty() { vec![root.clone()] } else { docs };
        let mut out: Vec<UiElement> = Vec::new();
        for s in &scopes {
            for e in s.find_all(TreeScope::Descendants, &cond).unwrap_or_default() {
                let name = e.get_name().unwrap_or_default().trim().to_string();
                if name.is_empty() || e.is_offscreen().unwrap_or(false) {
                    continue; // unnamed can't be asked for; off-screen isn't what he sees
                }
                if filter_hidden && in_hidden_document(&automation, &e, &hidden) {
                    continue;
                }
                let Some(r) = R::of(&e) else { continue };
                let ui = UiElement {
                    name,
                    control_type: format!("{:?}", e.get_control_type().unwrap_or(ControlType::Custom)),
                    enabled: e.is_enabled().unwrap_or(true),
                    x: r.cx(),
                    y: r.cy(),
                };
                if !out.iter().any(|o| o.x == ui.x && o.y == ui.y && o.name == ui.name) {
                    out.push(ui);
                }
                if out.len() >= MAX_ELEMENTS {
                    return Ok(out);
                }
            }
        }
        Ok(out)
    }

    pub fn name_contains(window: &str, needle: &str) -> bool {
        let Ok(automation) = UIAutomation::new() else { return false };
        let Ok((hwnd, _)) = target_window(Some(window)) else { return false };
        let Ok(root) = automation.element_from_handle(Handle::from(hwnd)) else { return false };
        let Ok(cond) = automation.create_property_condition(UIProperty::Name, Variant::from(needle), Some(PropertyConditionFlags::All)) else { return false };
        root.find_first(TreeScope::Descendants, &cond).is_ok()
    }

    pub fn name_present(window: &str, name: &str) -> bool {
        let Ok(automation) = UIAutomation::new() else { return false };
        let Ok((hwnd, _)) = target_window(Some(window)) else { return false };
        let Ok(root) = automation.element_from_handle(Handle::from(hwnd)) else { return false };
        let Ok(cond) = automation.create_property_condition(UIProperty::Name, Variant::from(name), None) else { return false };
        root.find_first(TreeScope::Descendants, &cond).is_ok()
    }

    pub fn click(name: String, window: Option<String>, control_type: Option<String>) -> UiClickResult {
        let want = name.trim().to_string();
        if want.is_empty() {
            return fail("I need the name of the control to press.".into(), None);
        }
        let wanted_type = control_type.map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty());
        let automation = match UIAutomation::new() {
            Ok(a) => a,
            Err(e) => return fail(format!("UI Automation init failed: {e}"), None),
        };
        let (hwnd, title) = match target_window(window.as_deref()) {
            Ok(w) => w,
            Err(e) => return fail(e, None),
        };
        let root = match automation.element_from_handle(Handle::from(hwnd)) {
            Ok(r) => r,
            Err(e) => return fail(format!("I couldn't read {title:?} ({e})."), None),
        };

        let find = || {
            let mut cands = candidates(&automation, &root, &want);
            if let Some(t) = &wanted_type {
                cands.retain(|c| c.ui.control_type.to_lowercase().contains(t.as_str()));
            }
            cands
        };
        let cands = with_patience(&automation, &root, &title, find);

        let Some(best) = cands.into_iter().next() else {
            return click_by_reading_the_screen(&automation, &root, hwnd, &want, &title);
        };
        press(&automation, &root, hwnd, &title, best)
    }

    /// A page that just changed needs a moment to show its next control. Web and Electron
    /// windows get a few seconds to catch up.
    fn with_patience(automation: &UIAutomation, root: &UiaElement, title: &str, find: impl Fn() -> Vec<Candidate>) -> Vec<Candidate> {
        let mut cands = find();
        if cands.is_empty() && (crate::desktop_ops::page_part(title) != title.trim() || !all_documents(automation, root).is_empty()) {
            let until = Instant::now() + Duration::from_millis(4500);
            while cands.is_empty() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(350));
                cands = find();
            }
        }
        cands
    }

    /// The last text `fill` typed without a submit key, so a suggestion list it opened can
    /// be recognised when it covers the next field (see `covered_by_own_suggestion`).
    static LAST_FILLED: std::sync::Mutex<Option<(String, Instant)>> = std::sync::Mutex::new(None);

    fn own_suggestion(cover: &str) -> bool {
        let last = LAST_FILLED.lock().ok().and_then(|g| g.clone());
        last.is_some_and(|(typed, at)| super::covered_by_own_suggestion(cover, &typed, at.elapsed()))
    }

    /// A field's current text: its ValuePattern, else its TextPattern document. None when
    /// neither can be read.
    fn read_value(el: &UiaElement) -> Option<String> {
        let value = el.get_pattern::<UIValuePattern>().ok().and_then(|v| v.get_value().ok());
        if let Some(v) = value.as_ref().filter(|v| !v.trim().is_empty()) {
            return Some(v.clone());
        }
        let text = el
            .get_pattern::<UITextPattern>()
            .ok()
            .and_then(|t| t.get_document_range().ok())
            .and_then(|r| r.get_text(8192).ok());
        text.or(value)
    }

    fn fill_fail(message: String, matched: Option<UiElement>, accepted: Option<String>) -> UiFillResult {
        UiFillResult { ok: false, message, matched, verified: false, accepted }
    }

    /// Put `text` into the field named `name`: find it (same matching and ranking as
    /// `click`), make it reachable, focus it with a real click, type, read it back, then
    /// press `submit`. One call per form field, so a covered click can't strand the text.
    pub fn fill(name: String, text: String, submit: Option<String>, window: Option<String>) -> UiFillResult {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};

        let want = name.trim().to_string();
        if want.is_empty() {
            return fill_fail("I need the name of the field to fill.".into(), None, None);
        }
        let text = text.trim_end_matches('\n').to_string();
        if text.is_empty() {
            return fill_fail("There was nothing to type.".into(), None, None);
        }
        let submit = match super::parse_submit(submit.as_deref()) {
            Ok(s) => s,
            Err(e) => return fill_fail(e, None, None),
        };
        let automation = match UIAutomation::new() {
            Ok(a) => a,
            Err(e) => return fill_fail(format!("UI Automation init failed: {e}"), None, None),
        };
        let (hwnd, title) = match target_window(window.as_deref()) {
            Ok(w) => w,
            Err(e) => return fill_fail(e, None, None),
        };
        let root = match automation.element_from_handle(Handle::from(hwnd)) {
            Ok(r) => r,
            Err(e) => return fill_fail(format!("I couldn't read {title:?} ({e})."), None, None),
        };

        let cands = with_patience(&automation, &root, &title, || candidates_for(&automation, &root, &want, Want::Field));
        let Some(best) = cands.into_iter().next() else {
            let fields: Vec<String> = list(window)
                .unwrap_or_default()
                .into_iter()
                .filter(|e| matches!(e.control_type.as_str(), "Edit" | "ComboBox"))
                .map(|e| e.name)
                .fold(Vec::new(), |mut acc, n| {
                    if !acc.contains(&n) {
                        acc.push(n);
                    }
                    acc
                });
            let hint = if fields.is_empty() {
                String::new()
            } else {
                format!(" Fields on screen: {}.", fields.into_iter().take(10).collect::<Vec<_>>().join(" · "))
            };
            return fill_fail(format!("I can't find a field called {want:?}.{hint}"), None, None);
        };
        if !best.ui.enabled {
            return fill_fail(format!("{:?} is greyed out right now — something probably has to be chosen or filled in first.", best.ui.name), Some(best.ui), None);
        }
        if !crate::native_ops::win::focus_window_verified(hwnd, 4, Duration::from_millis(120)) {
            return fill_fail(format!("I couldn't bring {title:?} to the front to fill {:?}.", best.ui.name), Some(best.ui), None);
        }

        // Off-screen (scrolled away): scroll it into view, then re-read where it is.
        let mut rect = best.rect;
        if best.offscreen {
            if let Ok(p) = best.el.get_pattern::<UIScrollItemPattern>() {
                let _ = p.scroll_into_view();
                std::thread::sleep(Duration::from_millis(350));
                if let Some(r) = R::of(&best.el) {
                    rect = r;
                }
            }
        }
        let mut matched = best.ui.clone();

        // Covered: by the suggestion list our own typing opened → accept it (Enter) and go on;
        // by anything else → say what, exactly as `click` does.
        let mut accepted: Option<String> = None;
        let mut focused_by_uia = false;
        if let Err(cover) = hit_test(&automation, &best.el, rect.cx(), rect.cy()) {
            let covered = |cover: &Option<String>| {
                let what = cover.as_ref().map(|c| format!(" by {c:?}")).unwrap_or_default();
                format!("{:?} is covered{what} — that has to be closed or dismissed first.", matched.name)
            };
            match cover.as_deref() {
                Some(c) if own_suggestion(c) => {
                    if let Err(e) = press_enter() {
                        return fill_fail(format!("{} (I couldn't accept the suggestion: {e})", covered(&cover)), Some(matched), None);
                    }
                    accepted = Some(c.to_string());
                    std::thread::sleep(Duration::from_millis(450));
                    if let Some(r) = R::of(&best.el) {
                        rect = r;
                    }
                    if let Err(still) = hit_test(&automation, &best.el, rect.cx(), rect.cy()) {
                        let msg = format!("Accepted the suggestion {c:?}, but {}", covered(&still));
                        return fill_fail(msg, Some(matched), accepted);
                    }
                }
                // Anything else: a field needs no pointer.
                _ => {
                    if best.el.set_focus().is_ok() && focus_is_on(&automation, &best.el) {
                        focused_by_uia = true;
                    } else {
                        return fill_fail(covered(&cover), Some(matched), None);
                    }
                }
            }
        }
        matched.x = rect.cx();
        matched.y = rect.cy();

        // Focus it the way a hand would: web and Electron fields answer a real click; a
        // native field takes UIA focus, with the click as the fallback.
        let before = read_value(&best.el).unwrap_or_default();
        let focused = focused_by_uia || (best.surface == Surface::Native && best.el.set_focus().is_ok());
        if !focused {
            if let Err(e) = mouse_click(rect.cx(), rect.cy()) {
                return fail_typed(format!("I found {:?} but couldn't click into it: {e}", matched.name), matched, accepted);
            }
        }
        std::thread::sleep(Duration::from_millis(150));

        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(e) => return fail_typed(format!("input synthesizer init failed: {e}"), matched, accepted),
        };
        if !crate::native_ops::win::is_foreground(hwnd) {
            return fail_typed(format!("{title:?} lost focus before typing."), matched, accepted);
        }
        // Text already there: type after it, not wherever the click put the caret.
        if !before.trim().is_empty() {
            let _ = enigo.key(Key::Control, Direction::Press);
            let _ = enigo.key(Key::End, Direction::Click);
            let _ = enigo.key(Key::Control, Direction::Release);
        }
        if let Err(e) = enigo.text(&text) {
            return fail_typed(format!("typing into {:?} failed: {e}", matched.name), matched, accepted);
        }

        // Read it back BEFORE the submit key: Enter turns a recipient into a chip and
        // empties the input, which would read as a miss.
        std::thread::sleep(Duration::from_millis(200));
        let verified = read_value(&best.el).is_some_and(|v| super::value_holds(&v, &text));
        if let Ok(mut last) = LAST_FILLED.lock() {
            *last = submit.is_none().then(|| (text.clone(), Instant::now()));
        }
        if let Some(key) = submit {
            let k = if key == super::Submit::Enter { Key::Return } else { Key::Tab };
            if let Err(e) = enigo.key(k, Direction::Click) {
                let msg = format!("{} But pressing {key:?} failed: {e}", super::fill_message(&matched.name, &text, None, verified, accepted.as_deref()));
                return UiFillResult { ok: false, message: msg, matched: Some(matched), verified, accepted };
            }
        }
        UiFillResult {
            ok: true,
            message: super::fill_message(&matched.name, &text, submit, verified, accepted.as_deref()),
            matched: Some(matched),
            verified,
            accepted,
        }
    }

    fn fail_typed(message: String, matched: UiElement, accepted: Option<String>) -> UiFillResult {
        fill_fail(message, Some(matched), accepted)
    }

    /// Press one exact element - the one `clear_popups` found INSIDE the pop-up, not
    /// whichever control elsewhere on the page shares its name ("Next", "Close").
    pub fn press_exact(automation: &UIAutomation, root: &UiaElement, hwnd: isize, title: &str, el: UiaElement) -> UiClickResult {
        let Some(rect) = R::of(&el) else {
            return fail("That control has no place on screen any more.".into(), None);
        };
        let ct = el.get_control_type().unwrap_or(ControlType::Button);
        let offscreen = el.is_offscreen().unwrap_or(false);
        let docs: Vec<R> = documents(automation, root).iter().filter_map(R::of).collect();
        let surface = if docs.iter().any(|d| d.contains(rect.cx(), rect.cy())) { Surface::Page } else { Surface::Native };
        let ui = UiElement {
            name: el.get_name().unwrap_or_default().trim().to_string(),
            control_type: format!("{ct:?}"),
            enabled: el.is_enabled().unwrap_or(true),
            x: rect.cx(),
            y: rect.cy(),
        };
        press(automation, root, hwnd, title, Candidate { el, ui, rect, name_rank: 0, interactable: true, surface, offscreen })
    }

    /// The verified press shared by `click` and `press_exact`.
    fn press(automation: &UIAutomation, root: &UiaElement, hwnd: isize, title: &str, best: Candidate) -> UiClickResult {
        let (automation, root, title) = (automation, root, title.to_string());
        if !best.ui.enabled {
            return fail(format!("{:?} is greyed out right now — something probably has to be chosen or filled in first.", best.ui.name), Some(best.ui));
        }

        // Bring the window forward: a mouse click lands on whatever is on top of that pixel.
        if !crate::native_ops::win::focus_window_verified(hwnd, 4, Duration::from_millis(120)) {
            return fail(format!("I couldn't bring {title:?} to the front to press {:?}.", best.ui.name), Some(best.ui));
        }

        // Off-screen (scrolled away): scroll it into view, then re-read where it is.
        let mut rect = best.rect;
        if best.offscreen {
            if let Ok(p) = best.el.get_pattern::<UIScrollItemPattern>() {
                let _ = p.scroll_into_view();
                std::thread::sleep(Duration::from_millis(350));
                if let Some(r) = R::of(&best.el) {
                    rect = r;
                }
            }
        }
        let mut matched = best.ui.clone();
        matched.x = rect.cx();
        matched.y = rect.cy();

        // An option that is ALREADY chosen: pressing it changes nothing, and "nothing
        // changed" would read as a failure. Live 2026-09-17 (Duolingo "Just for fun", already
        // picked): Atlas was told "It may need something chosen first" - misleading. Say
        // what is true instead, and leave it alone.
        if let Ok(sel) = best.el.get_pattern::<UISelectionItemPattern>() {
            if sel.is_selected().unwrap_or(false) {
                return UiClickResult {
                    ok: true,
                    message: format!("{:?} is already selected.", matched.name),
                    method: "none".into(),
                    matched: Some(matched),
                    verified: true,
                };
            }
        }
        // A checkbox flips: name the state it ended in, so "click X" on a ticked box is
        // visibly an UN-tick rather than a silent reversal.
        let toggle_after = |el: &UiaElement| -> String {
            el.get_pattern::<UITogglePattern>()
                .ok()
                .and_then(|t| t.get_toggle_state().ok())
                .map(|s| match s {
                    uiautomation::types::ToggleState::On => " (now ticked)".to_string(),
                    uiautomation::types::ToggleState::Off => " (now unticked)".to_string(),
                    _ => String::new(),
                })
                .unwrap_or_default()
        };

        let before = fingerprint(&automation, &root, Some(&best.el));

        if best.surface == Surface::Native {
            // Native controls: Invoke is semantic, reliable, and leaves the pointer alone.
            if let Ok(p) = best.el.get_pattern::<UIInvokePattern>() {
                if p.invoke().is_ok() {
                    let verified = changed_within(&automation, &root, Some(&best.el), before, Duration::from_millis(900));
                    let now = now_reads(hwnd, &title);
                    return UiClickResult { ok: true, message: format!("Clicked {:?}.{now}", matched.name), method: "invoke".into(), matched: Some(matched), verified };
                }
            }
        }

        // Web/Electron content (or a native control with no Invoke): a real click.
        if let Err(cover) = hit_test(&automation, &best.el, rect.cx(), rect.cy()) {
            // Before calling it covered, activate the named element itself from the keyboard and
            // trust only a real page change - it is still exactly the control he named, never
            // whatever sits under the pointer.
            if best.el.set_focus().is_ok()
                && focus_is_on(&automation, &best.el)
                && press_enter().is_ok()
                && changed_within(&automation, &root, Some(&best.el), before, Duration::from_millis(1500))
            {
                return UiClickResult {
                    ok: true,
                    message: format!(
                        "Pressed {:?} with the keyboard (the pointer path read as covered).{}",
                        matched.name,
                        now_reads(hwnd, &title)
                    ),
                    method: "keyboard".into(),
                    matched: Some(matched),
                    verified: true,
                };
            }
            let what = cover.map(|c| format!(" by {c:?}")).unwrap_or_default();
            return fail(format!("{:?} is covered{what} — that has to be closed or dismissed first.", matched.name), Some(matched));
        }
        if let Err(e) = mouse_click(rect.cx(), rect.cy()) {
            return fail(format!("I found {:?} but couldn't press it: {e}", matched.name), Some(matched));
        }
        if changed_within(&automation, &root, Some(&best.el), before, Duration::from_millis(2200)) {
            let state = toggle_after(&best.el);
            let now = now_reads(hwnd, &title);
            return UiClickResult { ok: true, message: format!("Clicked {:?}{state}.{now}", matched.name), method: "mouse".into(), matched: Some(matched), verified: true };
        }

        // Nothing changed, but the option is SELECTED: "click Just for fun" on an already
        // chosen answer is done, not broken. (Live 2026-09-17 the pre-click check missed this
        // because the page re-renders the option as a new element, so it is re-checked here.)
        if let Ok(sel) = best.el.get_pattern::<UISelectionItemPattern>() {
            if sel.is_selected().unwrap_or(false) {
                return UiClickResult {
                    ok: true,
                    message: format!("{:?} is selected.", matched.name),
                    method: "mouse".into(),
                    matched: Some(matched),
                    verified: true,
                };
            }
        }

        // The page ignored the mouse. Keyboard activation is the other thing a person can do.
        if best.el.set_focus().is_ok() && press_enter().is_ok()
            && changed_within(&automation, &root, Some(&best.el), before, Duration::from_millis(1500))
        {
            return UiClickResult {
                ok: true,
                message: format!(
                    "Pressed {:?} with the keyboard (the mouse click didn't register).{}",
                    matched.name,
                    now_reads(hwnd, &title)
                ),
                method: "keyboard".into(),
                matched: Some(matched),
                verified: true,
            };
        }

        fail(
            format!(
                "I clicked {:?} but nothing on the screen changed. It may need something chosen or filled in first — look at the screen before trying again.",
                matched.name
            ),
            Some(matched),
        )
    }

    fn now_reads(hwnd: isize, before: &str) -> String {
        let now = crate::native_ops::win::window_title(hwnd);
        if now.trim().is_empty() || now == before {
            String::new()
        } else {
            format!(" The window now reads {now:?}.")
        }
    }

    /// UI Automation has no node for it: find the label's pixels with Windows OCR.
    fn click_by_reading_the_screen(automation: &UIAutomation, root: &UiaElement, hwnd: isize, want: &str, title: &str) -> UiClickResult {
        let Some(win_rect) = R::of(root) else {
            return fail(format!("I can't find anything called {want:?} on screen."), None);
        };
        if !crate::native_ops::win::focus_window_verified(hwnd, 4, Duration::from_millis(120)) {
            return fail(format!("I can't find anything called {want:?} in {title:?}."), None);
        }
        std::thread::sleep(Duration::from_millis(150));
        let rect = (win_rect.l, win_rect.t, win_rect.r, win_rect.b);
        let page = documents(automation, root).first().and_then(R::of).map(|p| (p.l, p.t, p.r, p.b));
        let mut hits = match page.map(|p| crate::screen_ocr::find_label(p, want)) {
            Some(Ok(h)) => h,
            _ => Vec::new(),
        };
        if hits.is_empty() {
            hits = match crate::screen_ocr::find_label(rect, want) {
                Ok(h) => h,
                Err(e) => return fail(format!("I can't find anything called {want:?} on screen (screen read failed: {e})."), None),
            };
        }
        let Some(hit) = hits.first().cloned() else {
            let seen = crate::screen_ocr::read_lines(page.unwrap_or(rect), 12);
            let hint = if seen.is_empty() { String::new() } else { format!(" I can see: {}.", seen.join(" · ")) };
            return fail(format!("I can't find anything called {want:?} on screen.{hint}"), None);
        };
        let matched = UiElement { name: hit.text.clone(), control_type: "Text (read from screen)".into(), enabled: true, x: hit.x, y: hit.y };
        let before = fingerprint(automation, root, None);
        if let Err(e) = mouse_click(hit.x, hit.y) {
            return fail(format!("I found {:?} on screen but couldn't press it: {e}", hit.text), Some(matched));
        }
        let mut verified = changed_within(automation, root, None, before, Duration::from_millis(2000));
        if !verified {
            // Nothing accessible to fingerprint (a canvas). Read the screen again: the label
            // moving or disappearing is the change.
            let again = crate::screen_ocr::find_label(rect, want).unwrap_or_default();
            verified = !again.iter().any(|h| (h.x - hit.x).abs() <= 3 && (h.y - hit.y).abs() <= 3);
        }
        if verified {
            let now = now_reads(hwnd, title);
            UiClickResult { ok: true, message: format!("Clicked {:?} (found it by reading the screen).{now}", hit.text), method: "ocr-mouse".into(), matched: Some(matched), verified: true }
        } else {
            fail(format!("I clicked {:?} (read from the screen) but nothing changed — look at the screen before trying again.", hit.text), Some(matched))
        }
    }
}

/// What `clear_popups` pressed, in words.
#[derive(Serialize, Clone, Debug)]
pub struct UiClearResult {
    pub cleared: Vec<String>,
    pub message: String,
}

/// The controls that stand between the owner and where he is going, in the order Atlas should prefer
/// them.
pub(crate) const OBSTACLE_LABELS: &[&str] = &[
    // Dismiss and decline.
    "close", "close dialog", "close modal", "close banner", "close popup", "close this dialog", "dismiss",
    "dismiss banner", "×", "✕",
    "no thanks", "no, thanks", "no thank you", "not now", "maybe later", "remind me later", "later", "skip",
    "skip for now", "not interested",
    "reject all", "reject all cookies", "reject", "decline", "decline all", "deny", "deny all", "refuse all",
    "do not accept", "i do not accept", "reject non-essential", "reject non-essential cookies",
    "reject optional cookies", "reject additional cookies", "necessary only", "only necessary",
    "necessary cookies only", "only necessary cookies", "use necessary cookies only", "essential cookies only",
    "only essential cookies", "allow essential cookies", "allow necessary cookies", "accept necessary",
    "accept only necessary", "accept essential cookies", "continue without accepting",
    "continue without agreeing", "stay signed out", "stay logged out",
    // The forward buttons of an interstitial.
    "got it", "ok", "okay", "i understand", "understood", "continue", "next",
    // Accept and agree, only when nothing gentler is offered.
    "accept", "accept all", "accept all cookies", "accept cookies", "allow all", "allow all cookies",
    "allow cookies", "agree", "i agree", "agree and continue", "accept and continue", "i accept",
];

/// Labels too ordinary to press on sight: "Next" is also a carousel arrow, "Close" a sidebar's,
/// "OK"/"Continue"/"Accept" a form's. These count only inside something that is plainly a pop-up
/// (see `in_popup`).
pub(crate) const GENERIC_OBSTACLES: &[&str] = &[
    "close", "dismiss", "×", "✕", "later", "skip", "reject", "decline", "deny", "got it", "ok", "okay",
    "i understand", "understood", "continue", "next", "accept", "accept all", "allow all", "allow cookies",
    "agree", "i agree", "i accept", "agree and continue", "accept and continue",
];

fn obstacle_norm(label: &str) -> String {
    label
        .trim()
        .trim_matches(|c: char| c.is_ascii_punctuation() && c != '×')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Normalise a control's label for exact matching ("Got it!" / "  OK " / "Close ×").
pub(crate) fn obstacle_rank(label: &str) -> Option<usize> {
    let norm = obstacle_norm(label);
    OBSTACLE_LABELS.iter().position(|l| *l == norm)
}

/// True when this label only counts inside a pop-up.
pub(crate) fn needs_popup(label: &str) -> bool {
    GENERIC_OBSTACLES.contains(&obstacle_norm(label).as_str())
}

/// What marks a container as a pop-up in a web page: an ARIA dialog, or a class/id that
/// names one (OneTrust, Cookiebot, Quantcast, Didomi, Usercentrics, TrustArc, plain modals).
/// "banner" is deliberately absent: that is also the page header's landmark role and every
/// hero section's class name.
pub(crate) fn popup_hint(aria_role: &str, localized_type: &str, class: &str, automation_id: &str) -> bool {
    const HINTS: &[&str] = &[
        "modal", "dialog", "popup", "popover", "overlay", "consent", "cookie", "gdpr", "qc-cmp", "cmpbox", "onetrust",
        "usercentrics", "didomi", "truste", "interstitial", "toast", "snackbar", "paywall",
    ];
    let role = aria_role.trim().to_lowercase();
    let lct = localized_type.trim().to_lowercase();
    if matches!(role.as_str(), "dialog" | "alertdialog") || matches!(lct.as_str(), "dialog" | "alert dialog") {
        return true;
    }
    let (class, id) = (class.to_lowercase(), automation_id.to_lowercase());
    HINTS.iter().any(|h| class.contains(h) || id.contains(h))
}

#[cfg(windows)]
pub(crate) fn clear_popups_impl(window: Option<String>) -> UiClearResult {
    use std::time::Duration;
    use uiautomation::controls::ControlType;
    use uiautomation::types::{Handle, PropertyConditionFlags, TreeScope, UIProperty};
    use uiautomation::variants::Variant;
    use uiautomation::UIAutomation;
    let _ = PropertyConditionFlags::None;
    let mut cleared: Vec<String> = Vec::new();
    for _round in 0..3 {
        let Ok(automation) = UIAutomation::new() else { break };
        let hwnd = match window.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
            Some(t) => crate::native_ops::win::find_window_matching(t).map(|w| w.hwnd),
            None => {
                let wins = crate::native_ops::win::list_windows();
                let fg = crate::native_ops::win::foreground_window();
                wins.iter().find(|w| Some(w.hwnd) == fg).or(wins.first()).map(|w| w.hwnd)
            }
        };
        let Some(hwnd) = hwnd else { break };
        let Ok(root) = automation.element_from_handle(Handle::from(hwnd)) else { break };
        // Only the page on screen: a hidden document can hold its own "Reject all".
        let docs = imp::documents(&automation, &root);
        let (Ok(b), Ok(h)) = (
            automation.create_property_condition(UIProperty::ControlType, Variant::from(ControlType::Button as i32), None),
            automation.create_property_condition(UIProperty::ControlType, Variant::from(ControlType::Hyperlink as i32), None),
        ) else {
            break;
        };
        let Ok(cond) = automation.create_or_condition(b, h) else { break };
        let walker = automation.get_raw_view_walker().ok();
        // Inside a pop-up? Walk up from the control until the page itself.
        let in_popup = |e: &uiautomation::UIElement| -> bool {
            let Some(w) = walker.as_ref() else { return false };
            let mut cur = e.clone();
            for _ in 0..14 {
                let Ok(parent) = w.get_parent(&cur) else { return false };
                if parent.get_control_type().map(|t| t == ControlType::Document).unwrap_or(false) {
                    return false;
                }
                let role = parent
                    .get_property_value(UIProperty::AriaRole)
                    .ok()
                    .and_then(|v| v.get_string().ok())
                    .unwrap_or_default();
                if popup_hint(
                    &role,
                    &parent.get_localized_control_type().unwrap_or_default(),
                    &parent.get_classname().unwrap_or_default(),
                    &parent.get_automation_id().unwrap_or_default(),
                ) {
                    return true;
                }
                cur = parent;
            }
            false
        };
        // Best (lowest rank) visible, enabled, page-content control.
        let mut best: Option<(usize, String, uiautomation::UIElement)> = None;
        for doc in docs.iter().take(4) {
            for e in doc.find_all(TreeScope::Descendants, &cond).unwrap_or_default().into_iter().take(600) {
                let Ok(name) = e.get_name() else { continue };
                let Some(rank) = obstacle_rank(&name) else { continue };
                if best.as_ref().is_some_and(|(r, _, _)| *r <= rank) {
                    continue;
                }
                if !e.is_enabled().unwrap_or(false) || e.is_offscreen().unwrap_or(true) {
                    continue;
                }
                if needs_popup(&name) && !in_popup(&e) {
                    continue;
                }
                best = Some((rank, name.trim().to_string(), e));
            }
        }
        let Some((_, label, el)) = best else { break };
        let title = crate::native_ops::win::window_title(hwnd);
        let pressed = imp::press_exact(&automation, &root, hwnd, &title, el);
        if !pressed.ok {
            break;
        }
        cleared.push(label);
        std::thread::sleep(Duration::from_millis(250));
    }
    let message = if cleared.is_empty() {
        "Nothing in the way — no pop-up, banner or interstitial to clear.".to_string()
    } else {
        format!("Cleared: {}.", cleared.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", then "))
    };
    UiClearResult { cleared, message }
}

#[cfg(not(windows))]
pub(crate) fn clear_popups_impl(_window: Option<String>) -> UiClearResult {
    UiClearResult { cleared: vec![], message: "UI Automation is Windows-only.".into() }
}

/// Up to three in a row, each verified.
#[tauri::command]
pub async fn ui_clear_popups(window: Option<String>) -> Result<UiClearResult, String> {
    tauri::async_runtime::spawn_blocking(move || clear_popups_impl(window))
        .await
        .map_err(|e| format!("ui_clear_popups join failed: {e}"))
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn list(_window: Option<String>) -> Result<Vec<UiElement>, String> {
        Err("UI Automation is Windows-only.".to_string())
    }
    pub fn click(_name: String, _window: Option<String>, _ct: Option<String>) -> UiClickResult {
        UiClickResult { ok: false, message: "UI Automation is Windows-only.".into(), method: "none".into(), matched: None, verified: false }
    }
    pub fn fill(_name: String, _text: String, _submit: Option<String>, _window: Option<String>) -> UiFillResult {
        UiFillResult { ok: false, message: "UI Automation is Windows-only.".into(), matched: None, verified: false, accepted: None }
    }
}

/// Every clickable/typable control on screen, by name. Atlas's "what can I press here?".
#[tauri::command]
pub async fn ui_list_elements(window: Option<String>) -> Result<Vec<UiElement>, String> {
    tauri::async_runtime::spawn_blocking(move || imp::list(window))
        .await
        .map_err(|e| format!("ui_list_elements join failed: {e}"))?
}

/// Whether any element in the window's name CONTAINS `needle` (case-insensitive) - e.g. a
/// chat message carrying Praxis's marker, which proves which conversation is on screen.
pub(crate) fn name_contains(window: &str, needle: &str) -> bool {
    #[cfg(windows)]
    {
        imp::name_contains(window, needle)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, needle);
        false
    }
}

/// Whether any element in the window has exactly this accessible name (any control type,
/// text included). The LIVE driver uses it to read what the app shows - a dialog's path,
/// a header - without clicking anything.
pub(crate) fn name_present(window: &str, name: &str) -> bool {
    #[cfg(windows)]
    {
        imp::name_present(window, name)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, name);
        false
    }
}

/// Blocking sibling used by the owned LIVE-session driver. Keeping the actual
/// lookup in this module means the driver cannot quietly fall back to pixels.
pub(crate) fn list_blocking(window: Option<String>) -> Result<Vec<UiElement>, String> {
    imp::list(window)
}

/// Press the control named `name`, and only report success when the screen responded.
#[tauri::command]
pub async fn ui_click_element(
    name: String,
    window: Option<String>,
    control_type: Option<String>,
) -> Result<UiClickResult, String> {
    tauri::async_runtime::spawn_blocking(move || imp::click(name, window, control_type))
        .await
        .map_err(|e| format!("ui_click_element join failed: {e}"))
}

/// Put `text` into the field named `name` ("To", "Subject", "Message Body", "Search"),
/// then press `submit` ("enter" | "tab") if given. Reports "Filled" only when the field's
/// value was read back holding the text.
#[tauri::command]
pub async fn ui_fill_field(
    name: String,
    text: String,
    submit: Option<String>,
    window: Option<String>,
) -> Result<UiFillResult, String> {
    tauri::async_runtime::spawn_blocking(move || imp::fill(name, text, submit, window))
        .await
        .map_err(|e| format!("ui_fill_field join failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_shape_serializes_for_the_model() {
        let e = UiElement { name: "Continue".into(), control_type: "Button".into(), enabled: true, x: 640, y: 480 };
        let j = serde_json::to_string(&e).expect("serializes");
        assert!(j.contains("\"name\":\"Continue\""));
        assert!(j.contains("\"enabled\":true"));
    }

    /// The ranking rule that makes "click continue" press the right thing when a dialog
    /// also offers "Continue without saving".
    #[test]
    fn exact_name_outranks_a_longer_one_that_merely_contains_it() {
        assert_eq!(score("Continue", "continue"), Some(0));
        assert!(score("Continue", "continue").unwrap() < score("Continue without saving", "continue").unwrap());
        assert!(score("Nothing like it", "continue").is_none());
        // Live 2026-09-17: Duolingo's language cards are named "Spanish 42.2M learners".
        assert_eq!(score("Spanish 42.2M learners", "spanish"), Some(1));
    }

    /// THE REAL MISS, 2026-09-15. Asked to click "Continue" on a page that had a Continue
    /// button, the first version pressed an Edge toolbar button because its tooltip
    /// contained the word. Clicking something the user never named is worse than failing.
    #[test]
    fn a_word_buried_in_a_long_tooltip_is_not_a_match() {
        assert_eq!(
            score("Use the new ChatGPT side chat feature. Open the ChatGPT extension to continue., NEW\nNo access needed", "continue"),
            None,
            "a sentence that merely mentions the word must never be pressed"
        );
        assert_eq!(score("Continue anyway", "continue"), Some(1));
        assert_eq!(score("Save and continue", "continue"), Some(2));
        assert_eq!(score("Discontinued", "continue"), None);
        // A prefix must end on a word boundary: "Continued" is not "Continue".
        assert_eq!(score("Continued", "continue"), None);
    }

    /// Page content outranks browser chrome with the same label; a live control outranks
    /// a greyed-out one; a real control outranks the bare text beside it.
    #[test]
    fn popup_labels_match_exactly_and_prefer_the_gentlest_way_past() {
        assert!(obstacle_rank("Reject all").unwrap() < obstacle_rank("Accept all").unwrap(), "decline before accept");
        assert!(obstacle_rank("Not now").unwrap() < obstacle_rank("Continue").unwrap(), "dismiss before advancing");
        assert!(obstacle_rank("Got it!").is_some() && obstacle_rank("  OK ").is_some(), "punctuation and spacing ignored");
        for never in ["Continue to checkout", "Accept payment", "Sign in", "Send", "Delete", "Buy now", "Subscribe", "Close account", "X", "Accept invitation"] {
            assert!(obstacle_rank(never).is_none(), "{never} must never be cleared as a pop-up");
        }
        // Real consent-banner wordings are recognised.
        for real in ["Necessary cookies only", "Reject All", "Decline all", "Allow essential cookies", "Accept all cookies", "Stay signed out", "Remind me later"] {
            assert!(obstacle_rank(real).is_some(), "{real} should be recognised");
        }
    }

    #[test]
    fn ordinary_labels_only_count_inside_a_pop_up() {
        // A carousel's "Next", a sidebar's "Close", a form's "OK" are not in the way.
        for generic in ["Next", "Close", "OK", "Continue", "Accept all", "Got it!"] {
            assert!(needs_popup(generic), "{generic} must be inside a pop-up to be pressed");
        }
        for plain in ["Reject all", "Necessary cookies only", "Not now", "Stay signed out", "No thanks"] {
            assert!(!needs_popup(plain), "{plain} is unmistakable wherever it is");
        }
        assert!(popup_hint("dialog", "", "", ""));
        assert!(popup_hint("", "dialog", "", ""));
        assert!(popup_hint("", "", "ot-sdk-container onetrust-banner-sdk", ""));
        assert!(popup_hint("", "", "", "CybotCookiebotDialog"));
        assert!(popup_hint("", "", "qc-cmp2-container", ""));
        assert!(!popup_hint("banner", "", "hero-banner", ""), "the page header and a hero section are not pop-ups");
        assert!(!popup_hint("", "", "carousel slides", "main"));
    }

    /// The live Edge window of 2026-09-18 (physical pixels): the Duolingo tab's document is
    /// on screen; the hidden "Google" document that overran the window is not.
    #[test]
    fn only_a_document_inside_its_window_is_the_page_on_screen() {
        let edge = (3838, 215, 3838 + 1536, 215 + 1152);
        assert!(doc_on_screen(edge, (3856, 385, 3856 + 1504, 385 + 965)), "the Duolingo tab");
        assert!(!doc_on_screen(edge, (3850, 215, 3850 + 2549, 215 + 1422)), "the hidden Google document");
        // A maximized window hangs 8 px past the monitor; its page is still on screen.
        assert!(doc_on_screen((-8, -8, 2568, 1408), (0, 120, 2560, 1400)));
        assert!(!doc_on_screen(edge, (4000, 400, 4000, 900)), "an empty rectangle is nothing");
    }

    #[test]
    fn a_spoken_field_label_finds_the_gmail_compose_field() {
        // (name, control type, surface) - the page's fields plus browser chrome that shares words.
        let fixture = [
            ("To recipients", "ComboBox", Surface::Page),
            ("Subject", "Edit", Surface::Page),
            ("Message Body", "Edit", Surface::Page),
            ("Search mail", "Edit", Surface::Page),
            ("Address and search bar", "Edit", Surface::Native),
            ("Top stories", "Edit", Surface::Page),
        ];
        let pick = |want: &str| -> Option<&str> {
            fixture
                .iter()
                .filter(|(_, ct, _)| field_kind(ct, true, false))
                .filter_map(|(name, _, surface)| score(name, want).map(|s| (rank_key(s, true, true, *surface, false), *name)))
                .min_by_key(|(k, _)| *k)
                .map(|(_, n)| n)
        };
        assert_eq!(pick("To"), Some("To recipients"), "\"To\" is a whole-word prefix of Gmail's field");
        assert_eq!(pick("subject"), Some("Subject"));
        assert_eq!(pick("Message Body"), Some("Message Body"));
        assert_eq!(pick("search"), Some("Search mail"), "the page's search box before the address bar");
        assert_eq!(pick("body"), Some("Message Body"));
        assert_eq!(pick("Cc"), None, "a field that isn't there is an honest miss");
        // Whole words only: "to" is not inside "Top stories".
        assert_eq!(score("Top stories", "to"), None);
    }

    #[test]
    fn only_text_fields_are_filled() {
        assert!(field_kind("Edit", false, false));
        assert!(field_kind("ComboBox", false, false));
        assert!(field_kind("Document", false, true));
        assert!(!field_kind("Hyperlink", false, false), "a link's read-only URL value is not a field");
        assert!(!field_kind("Button", true, true), "a pressable control is never a field");
        assert!(field_kind("Custom", true, false), "a custom control that takes a value is");
        assert!(field_kind("Group", false, true), "a contenteditable group exposing text is");
        assert!(!field_kind("Text", false, false));
    }

    /// That cover is ours to accept; any other cover is not.
    #[test]
    fn the_suggestion_our_typing_opened_is_recognised() {
        use std::time::Duration;
        let cover = "Zachary Adams deckowner1@example.com";
        assert!(covered_by_own_suggestion(cover, "deckowner1@example.com", Duration::from_secs(5)));
        assert!(covered_by_own_suggestion(cover, "DeckOwner1@Example.com", Duration::from_secs(89)), "case-insensitive");
        assert!(!covered_by_own_suggestion(cover, "deckowner1@example.com", Duration::from_secs(91)), "stale after 90 s");
        assert!(!covered_by_own_suggestion("Accept all cookies", "deckowner1@example.com", Duration::from_secs(1)));
        assert!(!covered_by_own_suggestion(cover, "   ", Duration::from_secs(1)), "nothing typed matches nothing");
    }

    #[test]
    fn a_fill_is_reported_filled_only_when_the_value_reads_back() {
        assert!(value_holds("hello", "hello"));
        assert!(value_holds("Hi my name is\nZach", "hi my name is zach"), "re-wrapped and auto-capitalised");
        assert!(!value_holds("", "hello"));
        assert!(!value_holds("help", "hello"));
        assert_eq!(fill_message("Subject", "hello", None, true, None), "Filled \"Subject\" with \"hello\".");
        assert_eq!(fill_message("Subject", "hello", None, false, None), "Typed into \"Subject\" but can't read it back.");
        assert_eq!(
            fill_message("To recipients", "deckowner1@example.com", Some(Submit::Enter), true, None),
            "Filled \"To recipients\" with \"deckowner1@example.com\", then pressed Enter."
        );
        assert_eq!(
            fill_message("Subject", "hello", None, true, Some("Zachary Adams deckowner1@example.com")),
            "Accepted the suggestion \"Zachary Adams deckowner1@example.com\", then filled \"Subject\" with \"hello\"."
        );
        assert_eq!(parse_submit(None), Ok(None));
        assert_eq!(parse_submit(Some("Enter")), Ok(Some(Submit::Enter)));
        assert_eq!(parse_submit(Some("tab")), Ok(Some(Submit::Tab)));
        assert!(parse_submit(Some("ctrl+enter")).is_err(), "only enter or tab, never a send chord");
    }

    #[test]
    fn ranking_prefers_the_page_then_the_label_then_live_controls() {
        let page_prefix = rank_key(1, true, true, Surface::Page, false);
        let chrome_exact = rank_key(0, true, true, Surface::Native, false);
        assert!(page_prefix < chrome_exact, "what he is reading wins over the toolbar");
        assert!(rank_key(0, true, true, Surface::Page, false) < rank_key(0, false, true, Surface::Page, false));
        assert!(rank_key(0, true, true, Surface::Page, false) < rank_key(0, true, false, Surface::Page, false));
        assert!(rank_key(0, true, true, Surface::Page, false) < rank_key(0, true, true, Surface::Page, true));
    }
}
