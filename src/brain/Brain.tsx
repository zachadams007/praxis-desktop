/**
 * Brain - assembles the whole living scene and owns the single BrainRuntime.
 *
 * The runtime owns the mock timeline player and is subscribed to the eventBus; here
 * we also bridge the eventBus into the Zustand store so the DOM HUD (roster, ticker,
 * file-births) updates at human rate. Everything 3D reads the runtime through context.
 */

import { useEffect, useMemo, useRef } from "react";
import gsap from "gsap";
import { eventBus } from "@/data/eventBus";
import { usePraxisStore } from "@/store/usePraxisStore";
import { RuntimeProvider, useRuntime, useThemeColors } from "./context";
import { BloomSelectionProvider } from "./bloomSelection";
import { BrainRuntime } from "./runtime";
import { Hub } from "./Hub";
import { NodeField } from "./NodeField";
import { EdgeField } from "./EdgeField";
import { PulseField } from "./PulseField";
import { FlickerField } from "./FlickerField";
import { AgentField } from "./AgentField";
import { JourneyHandoffField } from "./JourneyHandoffField";
import { ClusterField } from "./ClusterField";
import { Labels } from "./Labels";
import { CameraRig } from "./CameraRig";
import { GroundField } from "./GroundField";
import { JourneyChrome } from "./JourneyChrome";

/**
 * MorphDriver - owns THE tween between the two layouts (spec §A.4). GSAP drives a
 * single scalar with a linear ease; every node applies its own smootherstep inside
 * a deterministic stagger window (runtime.setMorph), which is what makes the nebula
 * UNFURL into the corridor rather than slide. Reduced motion → snap, still legible.
 */
function MorphDriver() {
  const rt = useRuntime();
  const viewMode = usePraxisStore((s) => s.viewMode);
  const tween = useRef<gsap.core.Tween | null>(null);

  useEffect(() => {
    const target = viewMode === "journey" ? 1 : 0;
    tween.current?.kill();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      rt.setMorph(target);
      return;
    }
    const obj = { t: rt.morph };
    tween.current = gsap.to(obj, {
      t: target,
      duration: 1.5,
      ease: "none", // per-node smootherstep inside the stagger does the easing
      onUpdate: () => rt.setMorph(obj.t),
      // Commit the exact endpoint even if WebView/background throttling skips the
      // tween's last sampled frame. Navigation and round-trips read this scalar.
      onComplete: () => rt.setMorph(target),
    });
    return () => {
      tween.current?.kill();
    };
  }, [viewMode, rt]);

  return null;
}

// R9: the ambient Dust field is gone - every light outside the core must BE
// something (a node, an agent, an event pulse). No decorative particles.
//
// NO scene lighting rig (2026-06-16 rebuild #5): the core is now a SELF-LUMINOUS
// glow organism - soft additive somas + a branching dendrite web + firing sparks,
// all emissive. A key-lit opaque mass read as "candy balls" and was rejected; an
// organic glow core doesn't want hard key-lit shading. Depth is sold by in-shader
// depth-of-field + depth-graded size/brightness, not by lighting. Everything in
// the scene is additive/emissive, so there are no lights to add.

export function Brain() {
  const runtime = useMemo(() => new BrainRuntime(), []);
  const colors = useThemeColors();

  if (import.meta.env.DEV) {
    const w = window as unknown as { __praxisRT?: BrainRuntime; __praxisBus?: typeof eventBus };
    w.__praxisRT = runtime;
    // expose the firehose so the headless harness can drive REAL events (which
    // flow through BOTH the runtime and the store → roster stays authoritative)
    w.__praxisBus = eventBus;
  }

  useEffect(() => () => runtime.dispose(), [runtime]);

  // bridge the firehose into the store for the DOM HUD (human-rate)
  useEffect(() => {
    const unsub = eventBus.subscribe((e) => usePraxisStore.getState().applyEvent(e));
    return unsub;
  }, []);

  return (
    <RuntimeProvider runtime={runtime}>
      <BloomSelectionProvider>
        <color attach="background" args={[colors.palette.bg]} />
        {/* fog starts past the whole map plane (camera sits ~64 out) so the
            flat composition stays crisp edge to edge */}
        <fog attach="fog" args={[colors.palette.bg, 95, 230]} />
        {/* the receding space the connectome floats in (grid floor + horizon) */}
        <GroundField />
        <EdgeField />
        <NodeField />
        <ClusterField />
        <Hub />
        <PulseField />
        <FlickerField />
        <AgentField />
        <JourneyHandoffField />
        <Labels />
        <JourneyChrome />
        <MorphDriver />
        <CameraRig />
      </BloomSelectionProvider>
    </RuntimeProvider>
  );
}
