/**
 * Brain context - shares the single BrainRuntime instance and the resolved theme
 * colors (as THREE.Color) with every 3D component, without prop-drilling.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import * as THREE from "three";
import { type Palette } from "@/theme/tokens";
import { useActivePalette } from "@/theme/useActivePalette";
import { BrainRuntime } from "./runtime";

const RuntimeCtx = createContext<BrainRuntime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: BrainRuntime; children: ReactNode }) {
  return <RuntimeCtx.Provider value={runtime}>{children}</RuntimeCtx.Provider>;
}

export function useRuntime(): BrainRuntime {
  const rt = useContext(RuntimeCtx);
  if (!rt) throw new Error("useRuntime must be used inside <RuntimeProvider>");
  return rt;
}

export interface ThemeColors {
  palette: Palette;
  bg: THREE.Color;
  baseCool: THREE.Color;
  baseWarm: THREE.Color;
  edge: THREE.Color;
  accent: THREE.Color;
  accentHot: THREE.Color;
  hub: THREE.Color;
}

/** Resolved THREE colors for the active palette (re-memoized on theme flip). */
export function useThemeColors(): ThemeColors {
  const p = useActivePalette();
  return useMemo(() => {
    return {
      palette: p,
      bg: new THREE.Color(p.bg),
      baseCool: new THREE.Color(p.baseCool),
      baseWarm: new THREE.Color(p.baseWarm),
      edge: new THREE.Color(p.edge),
      accent: new THREE.Color(p.accent),
      accentHot: new THREE.Color(p.accentHot),
      hub: new THREE.Color(p.hub),
    };
  }, [p]);
}

/** sRGB hex → linear rgb array, for raw ShaderMaterial uniforms/attributes. */
export function toLinear(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b]; // THREE.Color stores linear when ColorManagement is on
}
