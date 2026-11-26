/**
 * liveOnResume - re-derive the world when the owner comes back to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * He is describing a REPLAYED reading, not a measured one. Praxis caches what it
 * last observed - a Codex window at 29%, a session "working", a quota part-spent -
 * and those are facts with a shelf life. Left alone they do not stay true; they
 * stop being true quietly, which is worse than going blank.
 *
 * The backend already knows how to throw every cached reading away and rebuild from source: that
 * is what the RESTORE button calls. This is that half.
 *
 * TWO ways to come back, and only one of them fires a DOM event:
 *
 *   1. The window was hidden / minimised / behind something → `visibilitychange`.
 *   2. THE MACHINE SLEPT, or the window simply sat untouched for hours with
 *      nothing to hide it. No event fires at all. Timers do not run while a
 *      machine is asleep, so the only evidence is that the wall clock jumped
 *      further than the heartbeat interval could account for.
 *
 * (2) is the one that produced his twelve-hour case, and it is why this watches
 * the clock instead of trusting an event.
 *
 * What this deliberately does NOT do: reload the window. `restore_live_state`
 * broadcasts a reload to every window, which is right when the owner presses the
 * button and far too violent to do silently every time he alt-tabs back. This
 * clears the backend's cached readings and forces a fresh Flight Deck snapshot;
 * the stores' own visibility catch-up then refetches through the normal path.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect } from "react";
import { isVisible, onVisibilityChange } from "@/shared/visibility";

/** How long away counts as "long enough that readings may have expired". */
export const RESUME_STALE_MS = 90_000;

/** Heartbeat. A gap materially larger than this means time was skipped. */
const HEARTBEAT_MS = 20_000;

/** A gap beyond this much more than the heartbeat is a sleep/suspend, not jitter. */
const GAP_SLACK_MS = 10_000;

/** Never re-derive more often than this, however the resume was detected. */
const MIN_INTERVAL_MS = 30_000;

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Local signal so in-window stores can refetch without waiting for their poll. */
export const LIVE_REFRESH_EVENT = "praxis:live-refresh";

/**
 * Drop every cached reading and force a fresh Flight Deck snapshot.
 *
 * Failure is non-fatal and silent by design: this runs unprompted on every
 * resume, and an error toast for a background refresh would be noise. The visible
 * consequence of a failure is simply that the panels keep their previous values
 * and their own "as of" timestamps continue to say how old they are.
 */
export async function refreshLiveState(): Promise<boolean> {
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("refresh_live_state");
    } catch {
      return false;
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(LIVE_REFRESH_EVENT));
  } catch {
    /* non-DOM environment */
  }
  return true;
}

/**
 * Mount once per window root, beside `useRestoreListener`.
 *
 * Exported separately from the hook so a test can drive the decision without a
 * DOM: given the last-seen time and now, should we re-derive?
 */
export function shouldRefreshAfterGap(lastSeenAt: number, now: number): boolean {
  return now - lastSeenAt >= RESUME_STALE_MS;
}

export function useLiveOnResume(): void {
  useEffect(() => {
    let lastSeenAt = Date.now();
    let lastRefreshAt = 0;
    let disposed = false;

    const maybeRefresh = (awayFor: number) => {
      const now = Date.now();
      if (now - lastRefreshAt < MIN_INTERVAL_MS) return;
      if (awayFor < RESUME_STALE_MS) return;
      lastRefreshAt = now;
      void refreshLiveState();
    };

    // (1) came back to a window that was hidden
    const offVisibility = onVisibilityChange((visible) => {
      if (disposed) return;
      if (!visible) {
        lastSeenAt = Date.now();
        return;
      }
      const awayFor = Date.now() - lastSeenAt;
      lastSeenAt = Date.now();
      maybeRefresh(awayFor);
    });

    // (2) the machine slept, or the window sat untouched: no event, only a clock
    // that moved further than a heartbeat can explain.
    const beat = window.setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      const gap = now - lastSeenAt;
      lastSeenAt = now;
      if (gap > HEARTBEAT_MS + GAP_SLACK_MS && isVisible()) maybeRefresh(gap);
    }, HEARTBEAT_MS);

    return () => {
      disposed = true;
      offVisibility();
      window.clearInterval(beat);
    };
  }, []);
}
