/**
 *
 * An app left open for a long while can go stale. Views should update by
 * themselves, and the Restore button is the backup that reloads
 * everything.
 *
 * The automatic half was a real bug, fixed in flightdeck.rs: one Flight Deck
 * rebuild that hung on a git call or panicked left its in-flight flag set forever,
 * so every later poll was served the same frozen snapshot until the app restarted.
 * This is the backstop on top of that fix - it trusts no cache to have
 * noticed anything:
 *
 *   1. the backend drops every usage cache and forces a fresh Flight Deck rebuild;
 *   2. every Praxis window reloads, which also discards any frontend state that has
 *      drifted (timers, listeners, in-memory stores).
 *
 * Persistent state survives: localStorage, the trust dial, breakers, fleet picks,
 * chat history and the usage ledger are all on disk. Only cached READINGS go.
 */
import { useEffect } from "react";

export const RESTORE_EVENT = "praxis://restore";
const LOCAL_RESTORE_EVENT = "praxis:restore";

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export interface RestoreOutcome {
  ok: boolean;
  /** Plain-language reason, shown to the owner when something could not be restored. */
  detail: string;
}

/**
 * Clear every backend cache, force a fresh snapshot, and reload every window -
 * including this one. Resolves just before the reload so the caller can show the
 * outcome if the reload is somehow blocked.
 */
export async function restoreEverything(): Promise<RestoreOutcome> {
  let detail = "Reloading every window.";
  let ok = true;
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // The backend also broadcasts praxis://restore to the OTHER windows.
      await invoke("restore_live_state");
    } catch (error) {
      // A failed backend call must not stop the reload: reloading the frontend is
      // still the most useful thing Restore can do, and it says what failed.
      ok = false;
      detail = `Backend caches could not be cleared (${error instanceof Error ? error.message : String(error)}) — reloading windows anyway.`;
    }
  }
  // This window reloads itself; it does not wait for its own broadcast echo.
  window.dispatchEvent(new CustomEvent(LOCAL_RESTORE_EVENT));
  return { ok, detail };
}

/**
 * Mount once in every window root. Reloads the window when any window restores.
 *
 * A short delay lets the backend's forced snapshot rebuild get a head start, so the
 * reloaded window's first poll has a fresh answer waiting instead of racing it.
 */
export function useRestoreListener(): void {
  useEffect(() => {
    let reloading = false;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      window.setTimeout(() => window.location.reload(), 400);
    };
    window.addEventListener(LOCAL_RESTORE_EVENT, reload);

    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (inTauri()) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen(RESTORE_EVENT, reload))
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {
          /* no event bus (dev browser) - the local event still reloads this window */
        });
    }
    return () => {
      disposed = true;
      window.removeEventListener(LOCAL_RESTORE_EVENT, reload);
      unlisten?.();
    };
  }, []);
}
