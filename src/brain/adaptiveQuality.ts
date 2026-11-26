/**
 * Adaptive quality - a tiny subscribable that publishes the current render-quality
 * TIER for the brain scene, so the heavy post-processing (DoF/bloom render targets)
 * and the canvas DPR can ease their cost when the main thread starts to starve, then
 * snap back to full fidelity the moment FPS recovers.
 *
 * WHY a discrete 3-tier ladder instead of a continuous factor: the approved "DoF-sold"
 * look is the single most taste-protected surface in the app. A continuous knob would
 * subtly shift the render on every micro-jitter; a stepped ladder with hysteresis (the
 * flip-flop guard lives in drei's <PerformanceMonitor>) keeps the scene BYTE-IDENTICAL
 * to today at rest and only visibly changes on a sustained, real FPS drop.
 *
 *   TIER "high"   → today's exact values. A healthy machine NEVER leaves this tier.
 *   TIER "medium" → DPR clamped ~0.85, DoF blur render target 640→512. Silhouette + DoF
 *                   character fully intact; only the blur buffer is slightly softer.
 *   TIER "low"    → DPR clamped ~0.72, DoF blur render target 512→400. Still a real DoF
 *                   pass - the effect is CHEAPENED, never removed.
 *
 * The producer is <QualityMonitor> in BrainCanvas; the consumers are the canvas DPR (same file)
 * and the DoF resolution in Effects.tsx.
 */

export type QualityTier = "high" | "medium" | "low";

export interface QualitySpec {
  /** devicePixelRatio ceiling for this tier. "high" keeps today's [1,2] range untouched. */
  dprMax: number;
  /** DoF blur render-target height. 640 === today's exact <DepthOfField height={640}>. */
  dofHeight: number;
}

/**
 * The ladder. "high" MUST reproduce today's values exactly (dofHeight 640; dprMax 2 so
 * the existing dpr={[1,2]} range is unchanged - DPR is only ever CLAMPED DOWN below that).
 */
export const QUALITY: Record<QualityTier, QualitySpec> = {
  high: { dprMax: 2, dofHeight: 640 },
  medium: { dprMax: 1.5, dofHeight: 512 },
  low: { dprMax: 1.0, dofHeight: 400 },
};

type Listener = (tier: QualityTier) => void;

const listeners = new Set<Listener>();
let current: QualityTier = "high";

/** Imperative read - safe from any module (loops, effects, React). */
export function getQualityTier(): QualityTier {
  return current;
}

export function getQualitySpec(): QualitySpec {
  return QUALITY[current];
}

/** Producer-side: set the tier. Notifies subscribers only on an actual change. */
export function setQualityTier(tier: QualityTier): void {
  if (tier === current) return;
  current = tier;
  for (const fn of listeners) {
    try {
      fn(current);
    } catch {
      /* a bad listener must not break the rest */
    }
  }
}

/**
 * Subscribe to tier changes. Returns an unsubscribe fn. The callback fires only on
 * transitions, never with the current value - read getQualityTier() for the initial.
 */
export function onQualityChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
