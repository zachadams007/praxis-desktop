/**
 * FitScaler / BrainHudScaler - window fit wrappers.
 *
 * That scaling was itself the bug - every Praxis window's layout is FLUID and viewport-anchored
 * (the brain HUD is all position:fixed; Command Center / Memory Galaxy / Flight Deck are
 * position:fixed inset:0 or height:100% with flex/grid that reflows). A CSS transform:scale
 * wrapper re-roots position:fixed to the scaled box and leaves a letterbox gap, which is exactly
 * what produced the "zoomed-out + gaps at the top and bottom when not maximized" look. So by
 * DEFAULT both wrappers render native: the layout fills the real window from every edge,
 * pixel-crisp, no letterbox.
 *
 * FORMATION MODE (quad-tile maximized-look, 2026-07-10): when window_ops.rs tiles the
 * four windows into screen quadrants it emits `praxis://formation` with the target
 * monitor's FULL work-area size in LOGICAL pixels (`baseW`/`baseH`, DPI-aware per
 * window). While active, the wrapper renders the app root at exactly baseW×baseH -
 * the viewport a MAXIMIZED window on that monitor would lay out at - and scales it
 * down uniformly (origin top-left) to fit the quarter-size window. Because the scaled
 * box covers the whole viewport, the position:fixed re-rooting that made the old
 * always-on scaling buggy is harmless here: fixed chrome anchors to the scaled box's
 * edges, which ARE the window's edges. Result: a pixel-faithful miniature of the
 * maximized layout - identical proportions, nothing cropped, no reflowed "small
 * window" layout. The quarter is half the work area per axis so the scale is ~0.5;
 * we compute min(vw/baseW, vh/baseH) instead of hard-coding 0.5 because the tiled
 * window's INNER viewport is the quarter minus window decorations (window_ops.rs
 * compensates set_size by the measured decoration delta) - a hard 0.5 would crop
 * the last ~15–40 logical px at the right/bottom edge. Uniform min-fit keeps it a
 * true miniature and never crops; the leftover sliver is filled by the outer's
 * black (DOM windows) or the live canvas (brain window).
 *
 * Reload while tiled: the hook PULLS `formation_state` on mount (window_ops.rs keeps
 * the formation in a static), so a mid-formation reload re-enters scaled mode.
 * Manual resize away from the quarter: a resize watchdog drops back to native.
 *
 * Browser test (npx vite dev, no Tauri) - paste in devtools:
 *   window.dispatchEvent(new CustomEvent("praxis-formation",
 *     { detail: { active: true, baseW: 2560, baseH: 1392 } }))
 *   window.dispatchEvent(new CustomEvent("praxis-formation", { detail: { active: false } }))
 */
import { useEffect, useState, type ReactNode } from "react";

type FormationBase = { baseW: number; baseH: number };

const IN_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** How far (logical px) the viewport may drift from the expected quarter (base/2)
 * Window decorations eat up to ~40 logical px of the quarter (see window_ops.rs's decoration
 * compensation), so the threshold sits well above decoration slop but below any deliberate
 * resize.
 *  Sub-threshold drifts just re-fit the miniature (scale is recomputed on resize). */
const QUARTER_DRIFT_PX = 96;

function readPayload(p: unknown): FormationBase | null {
  if (!p || typeof p !== "object") return null;
  const { active, baseW, baseH } = p as {
    active?: boolean;
    baseW?: number;
    baseH?: number;
  };
  if (!active || !baseW || !baseH || baseW <= 0 || baseH <= 0) return null;
  return { baseW, baseH };
}

/** Formation state for THIS window: null = render native (the default), a base =
 *  render the maximized-look miniature. Fed by three sources:
 *   • `praxis://formation` Tauri events - live tile-enter/exit transitions.
 *   • `formation_state` invoke on mount - reload/boot while a formation is live.
 *   • `praxis-formation` DOM CustomEvent - plain-browser dev + tests (no Tauri).
 */
function useFormation(): FormationBase | null {
  const [formation, setFormation] = useState<FormationBase | null>(null);

  useEffect(() => {
    let disposed = false;
    const offs: Array<() => void> = [];
    const apply = (p: unknown) => {
      if (!disposed) setFormation(readPayload(p));
    };

    const onDom = (e: Event) => apply((e as CustomEvent).detail);
    window.addEventListener("praxis-formation", onDom);
    offs.push(() => window.removeEventListener("praxis-formation", onDom));

    if (IN_TAURI) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen("praxis://formation", (e) => apply(e.payload)),
        )
        .then((off) => {
          if (disposed) off();
          else offs.push(off);
        })
        .catch(() => {
          /* event API unavailable - native rendering is the safe default */
        });
      // Pull, don't wait for a push: a window that reloads mid-formation must
      // re-enter scaled mode even though the tile-enter event fired long ago.
      // Only ACTIVATES here - an inactive pull result must not stomp a tile
      // event that may have already landed between mount and this resolving.
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("formation_state"))
        .then((p) => {
          const base = readPayload(p);
          if (base && !disposed) setFormation(base);
        })
        .catch(() => {
          /* command unavailable (old backend) - native rendering */
        });
    }
    return () => {
      disposed = true;
      offs.forEach((f) => f());
    };
  }, []);

  // Manual-resize watchdog: meaningfully away from the quarter → back to native.
  useEffect(() => {
    if (!formation) return;
    const check = () => {
      const dw = Math.abs(window.innerWidth - formation.baseW / 2);
      const dh = Math.abs(window.innerHeight - formation.baseH / 2);
      if (dw > QUARTER_DRIFT_PX || dh > QUARTER_DRIFT_PX) setFormation(null);
    };
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [formation]);

  return formation;
}

/** Uniform miniature scale: fit the baseW×baseH root inside the live viewport
 *  (~0.5 - see the header for why it isn't hard-coded 0.5). Tracks resizes so
 *  sub-threshold drifts (e.g. decoration settle) re-fit instead of cropping. */
function useMiniatureScale(formation: FormationBase | null): number {
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  useEffect(() => {
    if (!formation) return;
    const measure = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [formation]);
  if (!formation) return 1;
  return Math.min(viewport.w / formation.baseW, viewport.h / formation.baseH);
}

/** DOM windows (Command Center, Memory Galaxy, Flight Deck). Native full-window by
 *  default; maximized-look miniature while the quad formation is active. */
export function FitScaler({
  children,
}: {
  children: ReactNode;
  /** kept for call-site compatibility; unused (native render has no letterbox). */
  background?: string;
}) {
  const formation = useFormation();
  const scale = useMiniatureScale(formation);
  if (!formation) return <>{children}</>;
  return (
    <div className="fit-scaler-outer">
      <div
        className="fit-scaler-inner"
        style={{
          width: formation.baseW,
          height: formation.baseH,
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Brain window: the WebGL canvas ALWAYS renders native full-window - the 3D scene
 *  is resolution-independent, and rendering it at the maximized base size just to
 *  scale it back down would ~4× the pixel budget in the one window that's known to
 *  OOM-wedge under memory pressure. Only the DOM HUD chrome gets the maximized-look
 *  miniature treatment while the formation is active. */
export function BrainHudScaler({
  canvas,
  children,
}: {
  canvas: ReactNode;
  children: ReactNode;
}) {
  const formation = useFormation();
  const scale = useMiniatureScale(formation);
  if (!formation) {
    return (
      <>
        {canvas}
        {children}
      </>
    );
  }
  return (
    <>
      {canvas}
      {/* pointer-events dance lives in fitScaler.css: the wrapper is click-through
          so letterbox slivers reach the canvas; HUD children re-enable themselves. */}
      <div
        className="fit-scaler-inner--chrome"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: formation.baseW,
          height: formation.baseH,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </>
  );
}
