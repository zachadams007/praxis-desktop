/**
 * Effects - the cinematic layer.
 *
 *  - SelectiveBloom (R16/R5): ONLY the registered glow systems bloom - active
 *    pathways, flow beads, event pulses, the plasma heart, synapse sparks, the
 *    plexus + dendrite web, firing node cores. Context tube, labels, agent chips,
 *    cluster medallions and journey chrome are NEVER in the selection, so they
 *    stay crisp and a glow always MEANS something. A luminance threshold on top
 *    keeps the dim plexus mass under the bloom floor so bright stays detailed,
 *    never a clipped white smear. The selection is gathered via bloomSelection.
 *  - DepthOfField: focus tracks runtime.focusTarget, so when the GSAP rig flies to
 *    a node the focus racks onto it on arrival. Subtle so the overview stays crisp.
 *  - Vignette: gently darkens the edges to seat the brain in the void.
 */

import { Component, useEffect, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { DepthOfField, EffectComposer, SelectiveBloom, Vignette } from "@react-three/postprocessing";
import type { DepthOfFieldEffect } from "postprocessing";
import type { AmbientLight } from "three";
import { useRuntime, useThemeColors } from "./context";
import { useBloomObjects } from "./bloomSelection";
import { QUALITY, getQualityTier, onQualityChange } from "./adaptiveQuality";

// Postprocessing can throw when bloom targets are disposed between frames (R3F
// headless, mid-morph, or layout transitions). An error boundary here prevents
// the crash from propagating to App's HTML layer (DumpBox, OrchestratorPanel).
class EffectsErrorBoundary extends Component<
  { children: ReactNode },
  { dead: boolean }
> {
  state = { dead: false };
  static getDerivedStateFromError() { return { dead: true }; }
  componentDidCatch(e: Error) {
    if (import.meta.env.DEV) console.warn("[Effects] postprocessing error (contained):", e.message);
  }
  render() {
    return this.state.dead ? null : this.props.children;
  }
}

export function Effects() {
  const rt = useRuntime();
  const { palette } = useThemeColors();
  const dofRef = useRef<DepthOfFieldEffect>(null);
  const bloomTargets = useBloomObjects();
  // The brain is entirely shader-emissive - there are deliberately NO scene
  // lights (in-shader DoF/lighting, see brain-3d-lit-neurons). SelectiveBloom
  // console-warns every render without a `lights` prop, so we feed it one
  // intensity-0 ambient light: mathematically zero contribution to any
  // material, keeps the at-rest frame byte-identical, kills the spam.
  const silentLight = useRef<AmbientLight>(null!);

  // bind the DoF auto-focus to the live focus target; guard against the
  // postprocessing effect not being fully initialised yet (e.g. headless boot)
  useEffect(() => {
    if (dofRef.current) try { dofRef.current.target = rt.focusTarget; } catch (_) {}
  }, [rt]);

  // Adaptive quality: under sustained FPS pressure the QualityMonitor drops the tier,
  // and we shrink ONLY the DoF blur render target (640 → 512 → 400) to cheapen the most
  // expensive post pass. The effect character (bokeh scale, focal length, focus tracking)
  // is untouched - just a slightly softer blur buffer. At tier "high" this sets 640, which
  // is exactly the `height` prop below, so the at-rest render is byte-identical.
  useEffect(() => {
    const apply = () => {
      const h = QUALITY[getQualityTier()].dofHeight;
      const res = dofRef.current?.resolution;
      // guard: effect may not be initialised yet (headless boot / mid-morph dispose)
      if (res) try { res.height = h; } catch (_) {}
    };
    apply();
    return onQualityChange(apply);
  }, []);
  useFrame(() => {
    if (dofRef.current && dofRef.current.target !== rt.focusTarget) {
      try { dofRef.current.target = rt.focusTarget; } catch (_) {}
    }
  });

  return (
    <EffectsErrorBoundary>
      {/* intensity-0: exists only so SelectiveBloom stops warning (no scene lights by design) */}
      <ambientLight ref={silentLight} intensity={0} />
      <EffectComposer multisampling={4}>
        {/* DoF - the core's own per-element depth-of-field is computed IN-SHADER
            (somas/dendrites are additive glow and write no depth, so this pass
            can't grade them per-element). This pass therefore stays GENTLE: it
            adds a touch of cinematic softness to the deep background (ground
            plane, far detail leaves) and racks focus onto a flown-in cluster,
            without smearing the sharp foreground somas. Focus tracks the live
            target. */}
        <DepthOfField
          ref={dofRef}
          target={rt.focusTarget}
          focalLength={0.014}
          bokehScale={1.4}
          height={640}
        />
        {/* R16 anti-blowout: only the registered emissive systems can bloom, and
            even within them the threshold keeps the dim plexus mass / context
            edges below the floor - only firing paths, beads, sparks + the heart
            cross it. `inverted=false`, `ignoreBackground` so the near-black canvas
            never seeds a halo. */}
        <SelectiveBloom
          lights={[silentLight]}
          selection={bloomTargets}
          ignoreBackground
          intensity={palette.bloom * 1.1}
          luminanceThreshold={0.32}
          luminanceSmoothing={0.5}
          mipmapBlur
          radius={0.62}
        />
        <Vignette eskil={false} offset={0.32} darkness={0.82} />
      </EffectComposer>
    </EffectsErrorBoundary>
  );
}
