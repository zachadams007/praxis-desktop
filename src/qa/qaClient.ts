/**
 * QA "eyes" client - thin typed wrappers over the Rust `qa_capture_window` / `qa_inspect`
 * commands (src-tauri/src/qa_eyes.rs).
 *
 * This is the LOOK step of Praxis's visual-QA loop: an AI screenshots a real app window,
 * a vision model finds visual/layout defects, and each defect is emitted onto the brain's
 * event bus (as the Lens QA agent, `a.lens`) so findings animate the neural viz - and the
 * orchestrator can delegate fixes.
 *
 * Every call is defensive: outside the Tauri shell (plain browser / dev server) `invoke`
 * isn't available, so we import it lazily and surface a clear error rather than throwing an
 * undefined-reference. Field names match the Rust structs verbatim (snake_case) - Tauri v2
 * maps our camelCase argument keys to the Rust snake_case params automatically.
 */

/** Severity levels the vision inspector returns, in descending order of urgency. */
export type QaSeverity = "high" | "med" | "low";

/** One visual defect the inspector found. Mirrors the Rust findings JSON element shape. */
export interface QaFinding {
  /** The UI element/region the issue concerns (e.g. "header title", "primary button"). */
  element: string;
  /** What's wrong (e.g. "text clipped on the right edge"). */
  issue: string;
  /** How bad it is. */
  severity: QaSeverity;
}

/** Metadata for a saved window capture - mirrors the Rust `CaptureResult` struct. */
export interface QaCaptureResult {
  /** Absolute path of the saved PNG (%LOCALAPPDATA%\Praxis\qa\<timestamp>.png). */
  path: string;
  /** Captured image width in pixels. */
  width: number;
  /** Captured image height in pixels. */
  height: number;
  /** The matched window's full title. */
  title: string;
}

function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** Lazily grab Tauri's `invoke`, or throw a clear error when we're not in the shell. */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri()) {
    throw new Error(`qaClient: '${cmd}' requires the Tauri shell (not available in the browser)`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Capture a full-window PNG of the top-level window whose title CONTAINS `windowTitle`
 * (case-insensitive). Set `bringToFront` to focus the window before the shot (defaults to
 * false so a background pass never steals the foreground). Returns the saved-file metadata.
 */
export async function captureWindow(
  windowTitle: string,
  bringToFront = false,
): Promise<QaCaptureResult> {
  return tauriInvoke<QaCaptureResult>("qa_capture_window", {
    windowTitleSubstring: windowTitle,
    bringToFront,
  });
}

/**
 * Capture + vision-inspect the matched window. Emits one `praxis://hermes-event` per finding
 * (routed to the Lens QA agent) as a side effect, and resolves to the parsed findings.
 *
 * `focusNote` optionally steers the inspector (e.g. "focus on the sidebar spacing") without
 * changing its defect taxonomy. `model` optionally overrides `qa_eyes.rs`'s QA_VISION_MODEL
 * const - set from the Command Center Fleet panel's Lens dropdown (fleetStore.ts); omitted
 * falls back to the Rust-side default.
 */
export async function inspectWindow(
  windowTitle: string,
  focusNote?: string,
  model?: string,
): Promise<QaFinding[]> {
  const raw = await tauriInvoke<string>("qa_inspect", {
    windowTitleSubstring: windowTitle,
    focusNote: focusNote ?? null,
    model: model ?? null,
  });
  return parseFindings(raw);
}

/**
 * Orchestrator entry point: run a full QA pass over a window by title and return the findings.
 * Plain function (no React) so any code - an orchestrator step, a voice handler, a scheduled
 * job - can call it. Findings also animate the brain via the events `qa_inspect` emits.
 *
 * `model` optionally overrides the vision model (Fleet panel's Lens selection).
 *
 * Never throws: on any failure (not in Tauri, window not found, vision error) it returns an
 * empty array so a caller loop keeps going. Callers that need the error can use `inspectWindow`.
 */
export async function runQaPass(windowTitle: string, model?: string): Promise<QaFinding[]> {
  try {
    return await inspectWindow(windowTitle, undefined, model);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[qa] runQaPass('${windowTitle}') failed:`, err);
    return [];
  }
}

/** Parse the raw findings JSON string returned by `qa_inspect` into typed findings. */
export function parseFindings(raw: string): QaFinding[] {
  try {
    const parsed = JSON.parse(raw) as { findings?: unknown };
    const list = Array.isArray(parsed.findings) ? parsed.findings : [];
    return list
      .map((f): QaFinding | null => {
        if (typeof f !== "object" || f === null) return null;
        const rec = f as Record<string, unknown>;
        const element = typeof rec.element === "string" ? rec.element : "element";
        const issue = typeof rec.issue === "string" ? rec.issue : "issue";
        const severity = normalizeSeverity(rec.severity);
        return { element, issue, severity };
      })
      .filter((f): f is QaFinding => f !== null);
  } catch {
    return [];
  }
}

function normalizeSeverity(value: unknown): QaSeverity {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "high") return "high";
  if (s === "med" || s === "medium") return "med";
  return "low";
}
