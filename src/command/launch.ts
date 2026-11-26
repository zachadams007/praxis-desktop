/**
 * Window launch bridge for the Command Center. Each call invokes the matching Rust
 * `open_*` command (same pattern as the in-brain Flight Deck button). Silent in a
 * plain browser (no Tauri) so the cockpit still demos; any real failure is logged.
 */

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

async function call(cmd: string): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(cmd);
  } catch (err) {
    console.error(`[command-center] ${cmd} failed:`, err);
  }
}

export const openFlightDeck = () => call("open_flight_deck_cmd");
export const openMemoryGalaxy = () => call("open_knowledge_cmd");
export const focusBrain = () => call("show_main_cmd");

/**
 * Run a brain verb from the cockpit: focus the brain window, then emit a typed
 * `praxis://command` event the brain listens for and dispatches against its store.
 * This is what makes the command launcher's navigate/capture verbs actually DO the
 * thing instead of just raising the window. Silent in a plain browser.
 */
export async function runCommand(id: string): Promise<void> {
  if (!inTauri()) return;
  try {
    const [{ invoke }, { emit }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);
    await invoke("show_main_cmd"); // bring the brain forward first
    await emit("praxis://command", { id });
  } catch (err) {
    console.error(`[command-center] runCommand(${id}) failed:`, err);
  }
}

/**
 * Broadcast the autonomy / trust level to the brain so the dial controls something real:
 * the brain stores it (persisted) and surfaces it as the active leash. Does NOT raise the
 * brain - changing the leash shouldn't yank you out of the cockpit. Silent in a browser.
 */
export async function broadcastAutonomy(level: string): Promise<void> {
  if (!inTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("praxis://autonomy", { level });
  } catch (err) {
    console.error(`[command-center] broadcastAutonomy(${level}) failed:`, err);
  }
}
