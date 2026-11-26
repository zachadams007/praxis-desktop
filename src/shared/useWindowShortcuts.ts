/**
 * useWindowShortcuts - keyboard window control across the whole super-app. Mounted in every
 * Praxis window so the chords work no matter which one is focused:
 *
 *   Ctrl+Alt+1   Brain          Ctrl+Alt+3   Memory Galaxy
 *   Ctrl+Alt+2   Command Center Ctrl+Alt+4   Flight Deck
 *   Ctrl+Alt+→   next window    Ctrl+Alt+←   previous window  (cycle the OPEN windows)
 *
 * (Window→screen assignment for a multi-monitor rig is a later pass; this is the keyboard layer.)
 */
import { useEffect } from "react";

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

async function run(cmd: string, args?: Record<string, unknown>): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(cmd, args);
  } catch (err) {
    console.error(`[window-shortcut] ${cmd} failed:`, err);
  }
}

export function useWindowShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // require Ctrl+Alt exactly (no Shift/Meta) - distinct from the bare 1-9 area keys
      if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable))
        return;

      const k = e.key.toLowerCase();
      const map: Record<string, [string, Record<string, unknown>?]> = {
        "1": ["show_main_cmd"],
        "2": ["open_command_center_cmd"],
        "3": ["open_knowledge_cmd"],
        "4": ["open_flight_deck_cmd"],
        arrowright: ["cycle_windows", { forward: true }],
        arrowleft: ["cycle_windows", { forward: false }],
      };
      const hit = map[k];
      if (hit) {
        e.preventDefault();
        void run(hit[0], hit[1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
