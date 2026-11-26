/**
 * todoBridge - capture a voice-noted task into the Command Center to-do store,
 * live, from the brain window.
 *
 * The to-do store (src/command/todoStore.ts) lives in the Command Center window;
 * the Hybrid voice session runs in the brain window. They're separate webviews,
 * so we bridge over the SAME cross-window Tauri event channel the store already
 * listens on - but the store only listened for `praxis://task-complete` (cross
 * OFF). This adds a `praxis://todo-add` channel (add ON), wired into the store in
 * useTodoStore. Payload: { text, source? } - source defaults to "voice".
 *
 * Guarded: outside the Tauri shell (dev browser) it no-ops silently so the router
 * stays crash-free headless. The brain window ALSO carries a to-do store instance
 * only if the Command Center is open; the emit reaches every window that listens,
 * so the capture lands wherever the panel is mounted - and persists to the shared
 * localStorage key regardless.
 */

export const TODO_ADD_EVENT = "praxis://todo-add";

export interface TodoAddPayload {
  text: string;
  /** Provenance tag; "voice" for Hybrid-captured notes. */
  source?: "voice" | "manual" | "roadmap";
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * Emit a voice-captured task onto the Command Center to-do list. Fire-and-forget
 * + guarded: never throws, never blocks the voice loop.
 */
export async function captureTodo(text: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  if (!inTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(TODO_ADD_EVENT, { text: clean, source: "voice" } satisfies TodoAddPayload);
  } catch {
    /* not in Tauri or emit unavailable - ignore */
  }
}
