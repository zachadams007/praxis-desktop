/**
 * graphSettings.ts - the live, user-tunable Atlas settings (the DC's persisted `settings`).
 * Shared by the canvas engine (reads them per frame) and GraphControls (the Atlas UI).
 * Persisted under `praxis-galaxy-v3` in localStorage (the design prototype's key).
 */
import { AREA_IDS } from "./atlas";
import type { AreaId } from "./types";

/** Which areas are shown - one boolean per area id. */
export type AreaVisibility = Record<AreaId, boolean>;

export interface GraphSettings {
  nodeScale: number; // node radius multiplier (View · Node size)
  linkOpacity: number; // link opacity multiplier (View · Link opacity)
  labels: boolean; // node labels on/off
  arrows: boolean; // directional arrowheads on dep links
  fog: boolean; // nebula fog on/off
  showOrphans: boolean; // unconnected nodes on/off
  shown: AreaVisibility; // per-area visibility (the Vault filter)
  repel: number; // charge strength (Forces · Repel)
  gravity: number; // center gravity (Forces · Gravity)
  linkDist: number; // real-link target distance (Forces · Link length)
}

export const DEFAULT_SHOWN: AreaVisibility = Object.fromEntries(
  AREA_IDS.map((id) => [id, true]),
) as AreaVisibility;

export function defaultSettings(): GraphSettings {
  // NOT the DC file's shipped defaults - these are the slider values THE OWNER TUNED in the
  // Claude Design page and approved (visible in the Atlas panel of his DC screenshots,
  // 2026-07-03): node 0.85× · link opacity 2.00× · repel 54 · gravity 0.090 · link 42.
  // The stronger gravity + shorter links are what make the seven areas read as ONE
  // intermixed nebula galaxy instead of separated blobs, and the tighter world raises
  // fit-to-view zoom into the range where leaf labels + agent rigs turn on. The approved
  // LOOK is the spec, not the prototype's untouched slider positions.
  return {
    nodeScale: 0.85,
    linkOpacity: 2,
    labels: true,
    arrows: true,
    fog: true,
    showOrphans: true,
    shown: { ...DEFAULT_SHOWN },
    repel: 54,
    gravity: 0.09,
    linkDist: 42,
  };
}
