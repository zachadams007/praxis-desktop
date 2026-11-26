import type { ActionOrigin } from "@/shared/actionOrigin";
/**
 * hybridActions - the Hybrid Praxis DIRECT-INPUT executor.
 *
 * Wraps the Rust `hybrid_type` / `hybrid_press` / `hybrid_scroll` commands (enigo
 * input synthesis, src-tauri/src/hybrid_ops.rs) so the voice router can make
 * "type this: …" / "press enter" / "scroll down" happen INSTANTLY and VISIBLY in
 * whatever window holds the foreground - no Codex, no watched cursor. This is the
 * (c) rung of the fast router in front of the brain classify.
 *
 * All calls are guarded: outside the Tauri shell (dev browser) they return an
 * honest "needs the desktop app" message instead of throwing, so the router never
 * crashes when tested headless.
 */

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

export interface HybridActionResult {
  ok: boolean;
  /** Spoken-friendly confirmation or error. */
  message: string;
}

export type HybridTypeTargetField = "focused" | "address_bar";

/** Type arbitrary text, optionally binding the named target window at injection time. */
export async function hybridType(
  text: string,
  targetWindow?: string,
  targetField: HybridTypeTargetField = "focused",
): Promise<HybridActionResult> {
  if (!inTauri()) return { ok: false, message: "Typing needs the Praxis desktop app." };
  try {
    const message = await invoke<string>("hybrid_type", {
      text,
      targetWindow: targetWindow ?? null,
      targetField,
    });
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: `Couldn't type that: ${String(err).slice(0, 80)}` };
  }
}

/** Press a single named key (enter/tab/escape/arrows/…). */
/**
 * Press a key in the focused window.
 *
 * `origin` replaces the old `confirmed` boolean.
 */
export async function hybridPress(
  key: string,
  origin: ActionOrigin,
  targetWindow?: string,
): Promise<HybridActionResult> {
  if (!inTauri()) return { ok: false, message: "Key presses need the Praxis desktop app." };
  try {
    const message = await invoke<string>("hybrid_press", { key, origin, targetWindow: targetWindow ?? null });
    return { ok: true, message };
  } catch (err) {
    // A rejected/unknown key is an honest miss, not a crash - say so briefly.
    return { ok: false, message: `I can't press "${key}".` };
  }
}

/** Scroll the focused window up or down. */
export async function hybridScroll(direction: "up" | "down", amount?: number): Promise<HybridActionResult> {
  if (!inTauri()) return { ok: false, message: "Scrolling needs the Praxis desktop app." };
  try {
    const message = await invoke<string>("hybrid_scroll", { direction, amount: amount ?? null });
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: `Couldn't scroll: ${String(err).slice(0, 80)}` };
  }
}
