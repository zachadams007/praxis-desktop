/**
 * watchMeStore - shared open/watching/enabled state for the Watch-me screen-share
 * surface, synced ACROSS Praxis windows.
 *
 * Watch-me (WatchMe.tsx) used to own its state locally and mount a floating chip
 * bottom-left. The voice-UX restructure (2026-07-07) moved the ENTRY POINT into the
 * right dock's Controls tab, so the button and the panel now live in different
 * components. This zustand store is the seam between them.
 *
 * It is ALSO the seam between windows: the Command Center is a separate Tauri window
 * from the brain window (where the WatchMe panel + capture live), and the CC now has a
 * WATCH ME breaker. So the three flags sync cross-window via a `praxis://watchme` event
 * (+ a localStorage mirror for the master `enabled` flag), mirroring the haltStore
 * pattern. The brain-window panel owns the real backend start/stop; this store only
 * carries intent.
 *
 * Flags:
 *   • open - panel visible (brain window). Closing it also drops `watching`.
 *   • watching - user intends Praxis to be watching the screen; the panel reconciles
 *                the backend capture (watchme_start / watchme_stop) to match this.
 *   • enabled - MASTER switch (the CC breaker). enabled=false force-stops any active
 *                watch and blocks new ones until re-enabled.
 */

import { create } from "zustand";

const ENABLED_KEY = "praxis.watchme.enabled.v1";
export const WATCHME_EVENT = "praxis://watchme";

/** Cross-window message - any subset of the three flags. */
interface WatchMeMsg {
  open?: boolean;
  watching?: boolean;
  enabled?: boolean;
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

function persistEnabled(v: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

/** Broadcast a flag change to the other Praxis windows (best-effort). */
async function broadcast(msg: WatchMeMsg): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(WATCHME_EVENT, msg);
  } catch {
    /* dev browser / non-Tauri - single-window state still works */
  }
}

interface WatchMeState {
  /** Panel visible. */
  open: boolean;
  /** Intent: Praxis should be watching the screen (backend capture follows this). */
  watching: boolean;
  /** Master enable for the whole watch-me capability (the CC breaker). */
  enabled: boolean;
  setOpen: (v: boolean) => void;
  setWatching: (v: boolean) => void;
  /** Master switch - false force-stops any active watch. */
  setEnabled: (v: boolean) => void;
  /** Toggle the panel open/closed (the Controls-tab button's primary action). */
  toggleOpen: () => void;
}

export const useWatchMe = create<WatchMeState>((set, get) => ({
  open: false,
  watching: false,
  enabled: loadEnabled(),

  setOpen: (v) => {
    // Closing the panel is a clean reset: also drop `watching` so reopening never
    // silently resumes a stale capture, and so the panel's reconcile stops the backend.
    if (!v && get().watching) {
      set({ open: false, watching: false });
      void broadcast({ open: false, watching: false });
    } else {
      set({ open: v });
      void broadcast({ open: v });
    }
  },

  setWatching: (v) => {
    // Master off wins - never start watching while disabled.
    const next = v && get().enabled;
    set({ watching: next });
    void broadcast({ watching: next });
  },

  setEnabled: (v) => {
    persistEnabled(v);
    if (!v) {
      // Master OFF force-stops an active watch (the breaker must actually kill it).
      set({ enabled: false, watching: false });
      void broadcast({ enabled: false, watching: false });
    } else {
      set({ enabled: true });
      void broadcast({ enabled: true });
    }
  },

  toggleOpen: () => {
    const next = !get().open;
    // Route through setOpen so the close-resets-watching rule applies uniformly.
    get().setOpen(next);
  },
}));

// ── Cross-window bridge (installed once per window at module load) ───────────────
//
// Apply a remote flag change WITHOUT re-broadcasting (setState bypasses the custom
// setters above), so an inbound event can't echo into an emit loop.
function applyRemote(msg: WatchMeMsg): void {
  const patch: Partial<WatchMeState> = {};
  if (typeof msg.open === "boolean") patch.open = msg.open;
  if (typeof msg.watching === "boolean") patch.watching = msg.watching;
  if (typeof msg.enabled === "boolean") {
    patch.enabled = msg.enabled;
    persistEnabled(msg.enabled);
    // A remote master-off must also clear local watching (breaker kills every window).
    if (!msg.enabled) patch.watching = false;
  }
  if (Object.keys(patch).length) useWatchMe.setState(patch);
}

if (typeof window !== "undefined") {
  // Tauri event - the primary cross-window channel.
  import("@tauri-apps/api/event")
    .then(({ listen }) => listen<WatchMeMsg>(WATCHME_EVENT, (e) => e.payload && applyRemote(e.payload)))
    .catch(() => {
      /* not in the Tauri shell */
    });
  // localStorage mirror - a safety net for the master flag across same-origin windows.
  window.addEventListener("storage", (e) => {
    if (e.key === ENABLED_KEY) applyRemote({ enabled: e.newValue !== "0" });
  });
}
