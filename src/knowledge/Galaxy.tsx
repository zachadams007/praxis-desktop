/**
 * Galaxy - the Memory Galaxy canvas. A thin React wrapper over the bespoke star-atlas engine
 * (galaxyEngine.ts): it owns a single <canvas>, mounts the engine (its own rAF loop + force
 * sim + camera + draw), and bridges discrete UI (selection, agent drill-in, live readout) back
 * to React. Per-frame state stays imperative in the engine; React state only for discrete UI.
 *
 * Replaces the old react-force-graph-2d renderer entirely (the bespoke agent rigs / comet
 * trails / weave sparks / nebula fog aren't what its node/link callbacks are built for).
 *
 * Live bridge (Tauri only): when `liveBridge` is on, attachEventBridge wires the galaxy's
 * eventBus to the engine's vault vocabulary. Real events are pushed onto that bus by
 * useGalaxyRealEvents (mounted in App.tsx) - the galaxy's own copy of the transcript /
 * session-state / hermes push translation, since useRealEvents feeds only the brain bundle.
 */
import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { GalaxyEngine } from "./galaxyEngine";
import { attachEventBridge } from "./eventAdapter";
import type { GraphData } from "./types";
import type { EngineAgent } from "./engineTypes";
import type { GraphSettings } from "./graphSettings";

export interface GalaxyHandle {
  /** select a node (fly-to + inspector) - used by the inspector's neighbor buttons. */
  select: (id: string | null) => void;
  /** fly the camera to an agent's focus node (Fleet drill-in). */
  focusAgent: (agentId: string) => void;
  /** reset layout (unpin + reflow + refit). */
  resetLayout: () => void;
  /** fit the whole galaxy in view. */
  fit: () => void;
}

export interface GalaxyProps {
  data: GraphData;
  agents: EngineAgent[];
  settings: GraphSettings;
  accent: string;
  grid: boolean;
  ambient: boolean;
  colorMode: "areas" | "mono";
  /** live event bridge on? (real PraxisEvents → vault mutations). Off in a plain browser. */
  liveBridge: boolean;
  onSelect: (id: string | null) => void;
  onGraphMutate?: () => void;
  onReadout?: (text: string) => void;
}

export const Galaxy = forwardRef<GalaxyHandle, GalaxyProps>(function Galaxy(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GalaxyEngine | null>(null);
  // keep a live mutable agents ref the event bridge can read/refresh
  const agentsRef = useRef<EngineAgent[]>(props.agents);
  agentsRef.current = props.agents;

  // mount the engine once (data identity change → remount via key on the element upstream)
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const engine = new GalaxyEngine(
      {
        canvas,
        root,
        onSelect: props.onSelect,
        onGraphMutate: props.onGraphMutate,
        onReadout: props.onReadout,
      },
      props.data,
      props.agents,
      props.settings,
    );
    engine.accent = props.accent;
    engine.grid = props.grid;
    engine.ambient = props.ambient;
    // Only the browser demo may invent vault facts. Under Tauri the rig pulses
    // real stars and never bears new ones - `liveBridge` is on exactly when a
    // real backend is feeding the engine.
    engine.fabricate = !props.liveBridge;
    engine.colorMode = props.colorMode;
    engine.mount();
    engineRef.current = engine;
    if (import.meta.env.DEV) {
      // headless diagnostics (scripts/diag + shot-galaxy) inspect sim state through this
      (window as unknown as { __galaxyEngine?: GalaxyEngine }).__galaxyEngine = engine;
    }

    // live bridge: real PraxisEvents (pushed onto the eventBus by useGalaxyRealEvents) → the
    // engine's vault mutations (Tauri only). The adapter also marks the engine's real-events
    // clock on every bus event so the ambient simulation stands down while reality is flowing.
    let detach: (() => void) | undefined;
    if (props.liveBridge) {
      detach = attachEventBridge(engine, {
        getAgents: () => agentsRef.current,
        setAgents: (a) => {
          agentsRef.current = a;
          engine.setAgents(a);
        },
      });
    }

    return () => {
      detach?.();
      engine.unmount();
      engineRef.current = null;
    };
    // engine is rebuilt only when the graph data object itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data]);

  // sync live props → engine (no remount)
  useEffect(() => {
    engineRef.current?.setSettings(props.settings);
  }, [props.settings]);
  useEffect(() => {
    engineRef.current?.setAccent(props.accent);
  }, [props.accent]);
  useEffect(() => {
    engineRef.current?.setGrid(props.grid);
  }, [props.grid]);
  useEffect(() => {
    engineRef.current?.setAmbient(props.ambient);
  }, [props.ambient]);
  useEffect(() => {
    engineRef.current?.setColorMode(props.colorMode);
  }, [props.colorMode]);
  useEffect(() => {
    // only push roster changes to the engine when NOT under the live bridge (which owns the
    // working set itself); in demo/browser mode the roster is the source.
    if (!props.liveBridge) engineRef.current?.setAgents(props.agents);
  }, [props.agents, props.liveBridge]);

  useImperativeHandle(ref, () => ({
    select: (id) => engineRef.current?.selectExternal(id),
    focusAgent: (id) => engineRef.current?.focusAgent(id),
    resetLayout: () => engineRef.current?.resetLayout(),
    fit: () => engineRef.current?.flyToFit(),
  }));

  return (
    <div ref={rootRef} style={{ position: "absolute", inset: 0 }}>
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
          touchAction: "none",
          cursor: "grab",
          zIndex: 1,
        }}
      />
    </div>
  );
});
