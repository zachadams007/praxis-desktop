/**
 * BrainCanvas - the R3F <Canvas> host. Owns the GL surface, clamps DPR for perf, and
 * routes a click on empty space back to the overview. Antialiasing is handled by the
 * EffectComposer (MSAA), so the canvas itself is non-AA.
 */

import { Suspense, useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Perf } from "r3f-perf";
import { Brain } from "@/brain/Brain";
import { usePraxisStore } from "@/store/usePraxisStore";
import { isVisible, onVisibilityChange } from "@/shared/visibility";
import { setQualityTier } from "@/brain/adaptiveQuality";

function PerfGate() {
  const show = usePraxisStore((s) => s.showPerf);
  return show ? <Perf position="bottom-left" /> : null;
}

/**
 * Pauses the entire R3F render loop while the window is hidden (minimized / in the
 * tray / another Praxis window focused over it). Tauri HIDES rather than destroys the
 * main window on close, so without this the full scene - 12+ useFrame loops plus the
 * EffectComposer (bloom + DoF + MSAA) - keeps rendering forever in the background,
 * pinning the GPU and holding render-target memory. This was the biggest single
 * contributor to the WebView ballooning past 2 GB. Visible → "always" (live animation
 * preserved, hero look untouched); hidden → "never" (zero frames).
 */
function FrameloopGate() {
  const setFrameloop = useThree((s) => s.setFrameloop);
  useEffect(() => {
    setFrameloop(isVisible() ? "always" : "never");
    return onVisibilityChange((visible) => setFrameloop(visible ? "always" : "never"));
  }, [setFrameloop]);
  return null;
}

/**
 * Native-resolution guard. The prior automatic <PerformanceMonitor> could treat busy boot
 * frames as a permanent decline, then leave the live Tauri canvas at a lower DPR and DoF
 * target forever. That made the neural field soft after the app had already settled.
 * Visible content is a fidelity contract: keep the renderer at the display's native DPR
 * (capped at 2) for its full visible lifetime. FrameloopGate still stops all rendering
 * while the window is hidden, so background GPU safety remains intact.
 */
function NativeResolutionGuard() {
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => {
    setQualityTier("high");
    setDpr([1, 2]);
  }, [setDpr]);
  return null;
}

export function BrainCanvas() {
  return (
    <Canvas
      // viewport-relative inline size so R3F always measures a non-zero container,
      // independent of stylesheet load timing (avoids the 0-size / 300x150 gate)
      style={{ width: "100vw", height: "100vh", display: "block" }}
      resize={{ debounce: 0, scroll: false }}
      gl={{ antialias: false, powerPreference: "high-performance", alpha: false }}
      dpr={[1, 2]}
      camera={{ position: [14, 9, 46], fov: 50, near: 0.1, far: 400 }}
      onPointerMissed={() => usePraxisStore.getState().focus(null)}
    >
      <Suspense fallback={null}>
        <Brain />
      </Suspense>
      <FrameloopGate />
      <NativeResolutionGuard />
      <PerfGate />
    </Canvas>
  );
}
