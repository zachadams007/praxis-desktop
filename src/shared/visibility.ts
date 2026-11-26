/**
 * Shared page-visibility primitive - ONE listener for the whole window instead of
 * every hook/store rolling its own. Two consumers:
 *
 *   • Pollers (setInterval → Tauri `invoke`): skip the fetch while the window is
 *     hidden/minimized, and fire one catch-up fetch the moment it comes back. This
 *     is the single biggest lag win - a dozen concurrent polls each doing IPC +
 *     React re-renders while the window sits in the tray was burning the main thread.
 *   • The R3F frameloop: pause rendering the brain scene when it can't be seen.
 *
 * "Visible" = the tab/window is not `document.hidden`. We deliberately do NOT gate on
 * OS focus (document.hasFocus()) here - a window can be visible but unfocused (side by
 * side), and we still want fresh data / a live brain in that case. Focus-gating stays
 * in `voice/useWindowFocus.ts`, which is a different concern (own the mic).
 */

type Listener = (visible: boolean) => void;

const listeners = new Set<Listener>();

function computeVisible(): boolean {
  if (typeof document === "undefined") return true;
  return !document.hidden;
}

let current = computeVisible();

if (typeof document !== "undefined") {
  const sync = () => {
    const next = computeVisible();
    if (next === current) return;
    current = next;
    for (const fn of listeners) {
      try {
        fn(current);
      } catch {
        /* a bad listener must not break the rest */
      }
    }
  };
  document.addEventListener("visibilitychange", sync);
}

/** Imperative read - safe from any module (stores, loops, useFrame). */
export function isVisible(): boolean {
  return current;
}

/**
 * Subscribe to visibility changes. Returns an unsubscribe fn. The callback fires only
 * on transitions (hidden↔visible), never on the current value - read `isVisible()` for
 * the initial state.
 */
export function onVisibilityChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Interval that automatically pauses while the window is hidden and fires one immediate
 * catch-up when it becomes visible again. Drop-in for `setInterval(fn, ms)` in a poller.
 *
 *   const stop = visibleInterval(pull, 2500);   // ...later: stop();
 *
 * `fn` is NOT called on setup (matching setInterval); call it once yourself first if you
 * want an immediate initial fetch.
 */
export function visibleInterval(fn: () => void, ms: number): () => void {
  let id: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (id !== null) return;
    id = setInterval(() => {
      if (isVisible()) fn();
    }, ms);
  };

  start();

  const off = onVisibilityChange((visible) => {
    if (visible) fn(); // catch-up the instant we're seen again
  });

  return () => {
    if (id !== null) clearInterval(id);
    id = null;
    off();
  };
}
