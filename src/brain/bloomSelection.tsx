/**
 * bloomSelection - a tiny registry so the SelectiveBloom pass (Effects.tsx) can
 * bloom ONLY the meaningful glow systems, wherever they are mounted.
 *
 * Why not `<Selection>`/`<Select>` from @react-three/postprocessing? That API's
 * traversal only tags `o.type === "Mesh"`, so it silently drops every Points /
 * LineSegments object - which is most of this scene's glow (pulses, flow beads,
 * synapse flickers, the plexus point-mass + filament web, the dendrite spray).
 * SelectiveBloom's explicit `selection` prop, by contrast, accepts ANY Object3D,
 * so each glow field registers its host object here and Effects feeds the whole
 * set to the pass. Labels, agent chips, cluster medallions and journey chrome
 * simply never register → they never bloom (R16: every glow means something).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Object3D } from "three";

interface BloomApi {
  objects: Object3D[];
  register: (o: Object3D) => () => void;
}

const BloomCtx = createContext<BloomApi | null>(null);
const EMPTY: Object3D[] = [];

export function BloomSelectionProvider({ children }: { children: ReactNode }) {
  const [objects, setObjects] = useState<Object3D[]>([]);
  const register = useCallback((o: Object3D) => {
    setObjects((prev) => (prev.includes(o) ? prev : [...prev, o]));
    return () => setObjects((prev) => prev.filter((x) => x !== o));
  }, []);
  const value = useMemo<BloomApi>(() => ({ objects, register }), [objects, register]);
  return <BloomCtx.Provider value={value}>{children}</BloomCtx.Provider>;
}

/** The live set of objects to bloom (read by Effects). */
export function useBloomObjects(): Object3D[] {
  return useContext(BloomCtx)?.objects ?? EMPTY;
}

/**
 * Register a glow object (Points / LineSegments / Mesh - anything) into the
 * SelectiveBloom selection for as long as it is mounted. The host object is
 * created during render, so `ref.current` is populated by the time this effect
 * runs after commit.
 */
export function useBloomTarget(ref: RefObject<Object3D | null>): void {
  const register = useContext(BloomCtx)?.register;
  useEffect(() => {
    const o = ref.current;
    if (!register || !o) return;
    return register(o);
    // ref.current is stable for the lifetime of these merged-mesh fields
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register]);
}
