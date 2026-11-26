/**
 * Hermes (planning brain) health for chips and banners - asked for, not just heard.
 *
 * The backend emits `praxis://hermes-degraded` on state CHANGES only, which is right
 * for toasts and means it fires about once per process. Two windows held that state
 * by listening alone: the Command Center header and the right dock. Both are opened
 * after the app starts, so both missed the only message and read "engine · checking…"
 * indefinitely - and the backend used to wait up to 150s on an optional gateway before
 * emitting even that one.
 *
 * So: pull the current state on mount (`hermes_health` always answers), then keep
 * listening for changes. The main window's transition TOASTS stay push-only on
 * purpose; a toast announces a change, and there is no change to announce on mount.
 */
import { useEffect, useState } from "react";

export interface HermesHealth {
  degraded: boolean;
  reason: string;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** null only until the first answer - a window no longer stays there. */
export function useHermesHealthState(): HermesHealth | null {
  const [state, setState] = useState<HermesHealth | null>(null);
  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;

    // Subscribe FIRST, then pull, so a change that lands between the two is not lost;
    // a pull that resolves after a newer push must not overwrite it.
    let pushed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<HermesHealth>("praxis://hermes-degraded", (e) => {
          pushed = true;
          if (!disposed) setState(e.payload);
        }),
      )
      .then((f) => {
        if (disposed) f();
        else off = f;
      })
      .catch(() => {
        /* no event bus - the pull below still answers */
      });

    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<HermesHealth>("hermes_health"))
      .then((h) => {
        if (!disposed && !pushed) setState(h);
      })
      .catch(() => {
        /* older backend without the command - the listener still works */
      });

    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return state;
}
