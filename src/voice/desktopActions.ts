/**
 * desktopActions - thin, honest wrappers over the `desktop_*` Rust primitives
 * (src-tauri/src/desktop_ops.rs).
 *
 * These are the calls Atlas's Realtime tools make DIRECTLY. Deliberately no
 * parsing, no keyword matching, no natural-language round trip: the model has
 * already decided what to do and named the target, so the only job left is to
 * actuate it and report what really happened.
 *
 * Outside the Tauri shell (dev browser view) every call returns an honest
 * "needs the desktop app" result rather than throwing, so the tool layer and its
 * headless tests never crash on a missing bridge.
 */

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

export interface DesktopResult {
  ok: boolean;
  /** Spoken-friendly outcome - this becomes the tool result the model narrates. */
  message: string;
}

const NO_SHELL: DesktopResult = {
  ok: false,
  message: "Desktop control needs the Praxis desktop app — this browser view can't drive other Windows apps.",
};

/** Trim a Rust error to something speakable, keeping its actual content. */
function speakable(err: unknown, fallback: string): string {
  const raw = String(err ?? "").trim();
  if (!raw) return fallback;
  const stripped = raw.replace(/^.*?failed:\s*/i, "").replace(/^"|"$/g, "").trim();
  return (stripped || raw).slice(0, 200) || fallback;
}

async function run(cmd: string, args: Record<string, unknown>, fallback: string): Promise<DesktopResult> {
  if (!inTauri()) return NO_SHELL;
  try {
    const message = await invoke<string>(cmd, args);
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: speakable(err, fallback) };
  }
}

/** Open (or focus, if already running) any installed app by spoken name. */
export function openApp(name: string): Promise<DesktopResult> {
  return run("desktop_open_app", { name }, `I couldn't open ${name}.`);
}

/**
 * Open a URL or bare domain in the browser the owner is using (the one in front, else the
 * top-most one, else the default) - or in `browser` when he names one.
 */
export function openUrl(url: string, browser?: string): Promise<DesktopResult> {
  return run("desktop_open_url", { url, browser: browser ?? null }, `I couldn't open ${url}.`);
}

/** Run a web search in the browser the owner is using, or in `browser` when he names one. */
export function webSearch(query: string, browser?: string): Promise<DesktopResult> {
  return run("desktop_web_search", { query, browser: browser ?? null }, `I couldn't search for ${query}.`);
}

/** Bring any window matching `query` to the foreground. */
export function focusWindow(query: string): Promise<DesktopResult> {
  return run("desktop_focus_window", { query }, `I couldn't focus ${query}.`);
}

export type WindowAction = "minimize" | "maximize" | "restore" | "close";

/**
 * Minimize / maximize / restore / close a window. Omit `target` (or say "this")
 * to act on whatever window is currently in front - which is what makes
 * "maximize this window" work instead of refusing it as ambiguous.
 */
export function windowControl(action: WindowAction, target?: string): Promise<DesktopResult> {
  return run(
    "desktop_window_control",
    { target: target ?? null, action },
    `I couldn't ${action} that window.`,
  );
}

let latestAtlasCaptureId: number | null = null;

/** Click at a point from the latest Atlas screenshot. */
export function click(
  x: number,
  y: number,
  options: {
    button?: "left" | "right" | "middle";
    double?: boolean;
    captureId?: number | null;
    /**
     * Which pixels `x`/`y` are in. Defaults to "capture" - the last screenshot -
     * because that is where a model's coordinates ALWAYS come from: it picked the
     * point off an image. Rust maps them through that capture's own geometry.
     * Pass "screen" only when the caller genuinely knows a desktop coordinate.
     */
    space?: "capture" | "screen";
  } = {},
): Promise<DesktopResult> {
  const captureId = options.captureId ?? latestAtlasCaptureId;
  // The token is NOT consumed here any more.
  //
  // It used to be: one click cleared it, so the model's SECOND attempt - the retry after a
  // near-miss, which is the common case for pixel clicking - failed outright with "take a fresh
  // screenshot" instead of just clicking again.
  //
  // Staleness is still bounded, just by the right thing: `screen_capture` expires its
  // own tokens, and every new screenshot replaces this one. So a genuinely stale frame
  // is rejected by Rust (with a sentence telling the model to re-shoot), while a
  // same-frame retry - where the desktop has NOT changed - is allowed to proceed.
  return run(
    "desktop_click",
    {
      x: Math.round(x),
      y: Math.round(y),
      button: options.button ?? "left",
      double: options.double ?? false,
      space: options.space ?? "capture",
      captureId,
    },
    "I couldn't click there.",
  );
}

/**
 * Grab the active monitor as a JPEG data URL - Atlas's eyes.
 *
 * `capture_active_monitor_jpeg` returns BARE base64 (no prefix), so the data-URL
 * header is added here. 1280px/quality 70 is a deliberate trade: large enough to
 * read UI text and locate controls, small enough that the frame doesn't stall the
 * Realtime data channel or blow up the per-turn image cost.
 */
export async function screenshot(): Promise<DesktopResult & { image?: string; captureId?: number }> {
  if (!inTauri()) return NO_SHELL;
  latestAtlasCaptureId = null;
  try {
    // 1280 was costing accuracy, not just detail. On the owner's displays that scaled the
    // capture by ~2x, so ONE pixel the model could see was two real pixels it had to
    // hit - a Chrome profile card is forgiving, a toolbar icon is not, and the result
    // feels like an agent that cannot click anything. Example Creator's assistant, the
    // reference build for this feature, sidesteps the problem entirely by handing
    // the model a full-resolution screencapture file rather than a downscaled inline
    // image. We cannot do that over the Realtime wire, so we buy back most of the
    // precision instead: 1920 roughly halves the error, and quality 78 keeps small
    // UI text legible, which is what the model is actually reading.
    const frame = await invoke<{ b64: string; captureId: number; width: number; height: number }>(
      "capture_atlas_monitor_frame",
      { maxEdge: 1920, quality: 78 },
    );
    if (!frame.b64) return { ok: false, message: "The screen capture came back empty." };
    latestAtlasCaptureId = frame.captureId;
    // Say WHICH image the coordinates will be read against. The model picks click
    // points off this frame, and Rust maps them back through the same capture's
    // geometry (screen_capture::capture_point_to_screen) - so the two can never be
    // different units again, and the message says out loud which space is meant.
    return {
      ok: true,
      message: `Screenshot captured (${frame.width} × ${frame.height}, capture ${frame.captureId}). Give click coordinates in THIS image's pixels before taking another screenshot.`,
      image: `data:image/jpeg;base64,${frame.b64}`,
    };
  } catch (err) {
    return { ok: false, message: speakable(err, "I couldn't capture the screen.") };
  }
}

/**
 * Every named, clickable control on screen - Atlas's "what can I press here?".
 *
 * This is the reliable path. Pixel clicking asks an audio-first model to visually
 * ground a small control to a few pixels on a downscaled image; UI Automation just
 * asks Windows what the button is called.
 */
export async function listElements(window?: string): Promise<DesktopResult> {
  if (!inTauri()) return NO_SHELL;
  try {
    const els = await invoke<
      { name: string; control_type: string; enabled: boolean; x: number; y: number }[]
    >("ui_list_elements", { window: window ?? null });
    if (!els.length) {
      return {
        ok: true,
        message:
          "I can't see any named controls there — take a screenshot and click by position instead.",
      };
    }
    // Names + types only. Coordinates stay on the Rust side: handing the model x/y here
    // would just tempt it back into pixel clicking, which is the thing being replaced.
    const list = els
      .map((e) => `${e.name}${e.enabled ? "" : " (greyed out)"} [${e.control_type}]`)
      .join(" · ");
    return { ok: true, message: `Controls on screen: ${list}` };
  } catch (err) {
    return { ok: false, message: speakable(err, "I couldn't read the controls on screen.") };
  }
}

/** Press a control by its NAME - no screenshot, no coordinates, no scaling error. */
export async function clickElement(
  name: string,
  window?: string,
  controlType?: string,
): Promise<DesktopResult> {
  if (!inTauri()) return NO_SHELL;
  try {
    const res = await invoke<{ ok: boolean; message: string; method: string }>(
      "ui_click_element",
      { name, window: window ?? null, controlType: controlType ?? null },
    );
    return { ok: res.ok, message: res.message };
  } catch (err) {
    return { ok: false, message: speakable(err, `I couldn't click ${name}.`) };
  }
}

export type FillSubmit = "enter" | "tab";

/**
 * Put text into a form field by its NAME ("To", "Subject", "Message Body", "Search"): Rust
 * finds it the way click_element finds a button, clicks into it, types, reads it back and
 * then presses `submit`. One call per field, so a covered click can't strand the text.
 */
export async function fillField(label: string, text: string, submit?: FillSubmit, window?: string): Promise<DesktopResult> {
  if (!inTauri()) return NO_SHELL;
  try {
    const res = await invoke<{ ok: boolean; message: string; verified: boolean; accepted: string | null }>(
      "ui_fill_field",
      { name: label, text, submit: submit ?? null, window: window ?? null },
    );
    return { ok: res.ok, message: res.message };
  } catch (err) {
    return { ok: false, message: speakable(err, `I couldn't fill ${label}.`) };
  }
}

/**
 * Is the lock screen up? Behind it nothing can be brought forward, clicked or typed, and a
 * screenshot shows only the lock screen (live 2026-09-18: Atlas spent 55 s failing to focus
 * windows behind it). False when unknown, so a failed check never blocks a real action.
 */
export async function screenLocked(): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await invoke<boolean>("desktop_screen_locked", {});
  } catch {
    return false;
  }
}

export const SCREEN_LOCKED_MESSAGE =
  "The screen is locked (Windows lock screen), so nothing can be brought forward, clicked, typed or seen until Zach unlocks it. Tell him that in one short sentence and stop — do not retry.";

/** Clear the pop-ups, banners and interstitials standing between the owner and his goal. */
export async function clearPopups(window?: string): Promise<DesktopResult> {
  if (!inTauri()) return NO_SHELL;
  try {
    const res = await invoke<{ cleared: string[]; message: string }>("ui_clear_popups", { window: window ?? null });
    return { ok: true, message: res.message };
  } catch (err) {
    return { ok: false, message: speakable(err, "I couldn't clear what's on screen.") };
  }
}


export async function recallMemory(query: string): Promise<DesktopResult> {
  if (!inTauri()) return NO_SHELL;
  try {
    // A spoken turn must not hang on memory: right after launch the notes may still be
    // loading, and Atlas should say so and carry on rather than go silent.
    const hits = await Promise.race([
      invoke<{ label: string; description?: string | null; excerpt: string }[]>("memory_recall", {
        query,
        limit: 5,
        includeProfile: false,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    if (hits === null) {
      return { ok: false, message: "Praxis's memory is still loading — ask again in a moment." };
    }
    if (!hits.length) return { ok: true, message: `Nothing in Praxis's memory matches "${query}".` };
    const lines = hits.map((h) => {
      const body = (h.description?.trim() || h.excerpt || "").replace(/\s+/g, " ").slice(0, 320);
      return `${h.label}: ${body}`;
    });
    return { ok: true, message: `From Praxis's memory: ${lines.join(" | ")}` };
  } catch (err) {
    return { ok: false, message: speakable(err, "I couldn't reach Praxis's memory.") };
  }
}

/** Titles of the visible windows, so the model can target one by its real name. */
export async function listWindows(): Promise<DesktopResult> {
  if (!inTauri()) return NO_SHELL;
  try {
    const titles = await invoke<string[]>("desktop_list_windows", {});
    if (!titles.length) return { ok: true, message: "No open windows I can see." };
    return { ok: true, message: `Open windows: ${titles.join(" · ")}` };
  } catch (err) {
    return { ok: false, message: speakable(err, "I couldn't read the window list.") };
  }
}
