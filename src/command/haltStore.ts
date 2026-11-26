/**
 * haltStore - the HALT ALL breaker for the whole fleet. A REAL global stop:
 *
 *   1. Persists `praxis.halted.v1` to localStorage - `policy.ts` (isHalted) reads it
 *      at call time, so orchestrate()'s iteration loop and executeSteps() refuse to
 *      start any new step in ANY same-origin window while halted.
 *   2. Emits the Tauri event `praxis://halt` { halted } - the brain window's
 *      unattended runner listens and aborts its in-flight AbortController, and the
 *      hybrid voice session suspends on it.
 *
 * Resume clears the flag and re-emits; nothing auto-restarts - halted work stays
 * stopped, Praxis just becomes ALLOWED to run again.
 */

import { useCallback, useEffect, useState } from "react";

const HALT_KEY = "praxis.halted.v1";
export const HALT_EVENT = "praxis://halt";

export function isHaltedNow(): boolean {
  try {
    return localStorage.getItem(HALT_KEY) === "1";
  } catch {
    return false;
  }
}

async function broadcast(halted: boolean): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(HALT_EVENT, { halted });
  } catch {
    /* dev browser - localStorage flag alone still gates same-window policy reads */
  }
  // Mirror the breaker to %LOCALAPPDATA%\Praxis\halted.txt so the Rust side (no
  // localStorage) - the native FlowRunner's HALT gate - reads the live breaker.
  // Best-effort, fully independent of the event emit above.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("halt_sync", { halted });
    if (halted) {
      // HALT is an active stop, not only a future-dispatch gate. Both commands
      // fail safely when no matching run exists.
      await Promise.allSettled([
        invoke("computer_use_abort_all"),
        invoke("sovereign_abort_all"),
        // Every running agent CLI (Forge/Vega/Quill): live 2026-09-16 HALT at 23:17
        // left Quill editing the workspace until its timeout at 23:23.
        invoke("agent_delegate_abort_all"),
        // LIVE team work is not an agent_delegate process. Stop the exact owned
        // chats through their token-checked visible controls as well.
        invoke("live_operate_abort_all"),
      ]);
    }
  } catch {
    /* dev browser / command missing - same-window policy read still gates */
  }
}

/**
 * Sync the current breaker state to the Rust-side mirror once at startup, so a
 * fresh app launch reflects a breaker that was thrown in a prior session (the
 * localStorage flag persists; the halted.txt mirror must be re-asserted). Call
 * once from the Command Center bootstrap.
 */
export function syncHaltToNative(): void {
  void broadcast(isHaltedNow());
}

/**
 * Plain module-level setter - safe to call outside React (voice/chat command
 * execution). Sets the breaker to an EXPLICIT on/off state (unlike the hook's
 * toggleHalt, which flips): persists `praxis.halted.v1` and broadcasts the same
 * `praxis://halt` Tauri event toggleHalt does, so "halt all"/"resume all" spoken
 * commands land exactly like the Command Center's breaker switch.
 */
export function setHalted(on: boolean): void {
  try {
    localStorage.setItem(HALT_KEY, on ? "1" : "0");
  } catch {
    /* best-effort */
  }
  void broadcast(on);
}

/**
 * Shut the Sovereign browser down when the breaker is thrown.
 *
 * HALT already stopped every LOOP, but the headed Chromium that Trust IV spawns outlived it:
 * `sovereign_abort` deliberately does not force-kill the process tree, and `sovereign_stop` -
 * the command that does - had no caller anywhere in the app.
 *
 * Best-effort and non-blocking: HALT must take effect instantly whether or not a
 * sidecar is up, and "no sovereign service running" is the common case.
 */
async function stopSovereignBrowser(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sovereign_stop");
  } catch {
    /* not in Tauri, or no sovereign service was running - both are fine */
  }
}

export function useHalt(): { halted: boolean; toggleHalt: () => void } {
  const [halted, setHalted] = useState(isHaltedNow);

  // Cross-window sync: another window flipping the breaker updates this one.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === HALT_KEY) setHalted(e.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<{ halted: boolean }>(HALT_EVENT, (e) => setHalted(!!e.payload?.halted)))
      .then((f) => (off = f))
      .catch(() => {});
    return () => {
      window.removeEventListener("storage", onStorage);
      off?.();
    };
  }, []);

  const toggleHalt = useCallback(() => {
    setHalted((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HALT_KEY, next ? "1" : "0");
      } catch {
        /* best-effort */
      }
      void broadcast(next);
      if (next) void stopSovereignBrowser();
      return next;
    });
  }, []);

  return { halted, toggleHalt };
}
