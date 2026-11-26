/**
 * Knowledge window - the Memory Galaxy (star-atlas). One window:
 *   • CANVAS - the galaxy: every memory note / conversation / task / reference / idea /
 *     capture, clustered by AREA, with agent rigs roaming and live vault traffic.
 *   • LEFT - the "Atlas" panel: View / Vault (area filter) / Forces.
 *   • RIGHT - the "Cockpit": Inspect (node) ⇄ Fleet (agents) ⇄ System (areas/autonomy/metrics).
 *   • BOTTOM - the "memory bus" rail: voice, status, live ticker, RA/Dec readout, clock.
 *
 * Phase-1 / filmable: reads the REAL memory + intent files + (under Tauri) the real Claude
 * sessions and live PraxisEvent bus. Never blank (sample fallback), zero spend.
 *
 * grid (graticule) + ambient (live traffic) are hard-coded to their locked defaults (both on);
 * they were the design-tool's tweak knobs, not user-facing settings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowHeartbeat } from '@/shared/useWindowHeartbeat';
import { VoiceStateSatellite } from '@/voice/VoiceStateIndicator';
import { visibleInterval } from "@/shared/visibility";
import { Galaxy, type GalaxyHandle } from "./Galaxy";
import { GraphControls } from "./GraphControls";
import { Cockpit } from "./Cockpit";
import { BottomRail } from "./BottomRail";
import { SAMPLE_GRAPH } from "./sampleGraph";
import { defaultSettings } from "./graphSettings";
import type { GraphSettings } from "./graphSettings";
import { mirrorSet } from "@/shared/persist";
import { loadAutonomy, saveAutonomy, type AutonomyKey } from "@/shared/autonomy";
import { broadcastAutonomy } from "@/command/launch";
import { AREAS, ACCENT_DEFAULT, FONT, P } from "./atlas";
import type { GraphData, GNode, AreaId } from "./types";
import type { EngineAgent } from "./engineTypes";
import { useAgentRoster, type AgentRow } from "@/shared/agents";
import { useWindowShortcuts } from "@/shared/useWindowShortcuts";
import { useGalaxyRealEvents } from "./useGalaxyRealEvents";
import { firingCount, deriveAreaBuckets } from "./derive";
import "./galaxy.css";

import { useRestoreListener } from "@/shared/restore";
import { useLiveOnResume } from "@/shared/liveOnResume";
const inTauri = () =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Open another Praxis window by its Rust command (native only; silent in a plain browser). */
function openWin(cmd: string, args?: Record<string, unknown>) {
  if (!inTauri()) return;
  import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke(cmd, args).catch((e) => console.error(`[galaxy] ${cmd}`, e)),
  );
}

/** Inspector "open" button: open the node's REAL backing file on disk with the OS default
 *  app, via the `open_memory_file` Rust command (memory_graph.rs). The command resolves
 *  `path` (absolute, from the graph builder) first, then falls back to resolving `slug`
 *  against the Praxis memory vault - so older cached graphs without `path` still open.
 *
 *  WHY a Rust command and not the JS opener plugin (dead-button fix, 2026-07-10): the old
 *  dispatch deep-linked vault notes to `obsidian://open?vault=memory&…`, a custom URL scheme
 *  the opener plugin's default URL scope (http/https/mailto/tel) silently REJECTS - every
 *  vault-internal node's button died in a console.error nobody saw. The Rust-side
 *  `tauri_plugin_opener::open_path` API involves no JS scope at all, and the real file is
 *  the honest artifact regardless of whether Obsidian is installed. */
function openNodeFile(node: GNode) {
  if (!inTauri()) return;
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("open_memory_file", { path: node.path ?? null, slug: node.slug ?? null }))
    .catch((e) => console.error("[galaxy] open_memory_file", e));
}

// v3 → v4 (2026-07-03): defaults changed to the owner's APPROVED DC slider tuning - bumping the
// key resets everyone's persisted settings once so the old untuned values can't pin the
// pre-approval look. His screenshot showed gravity 0.040 persisted from the old defaults.
const LS_KEY = "praxis-galaxy-v4";

interface Persisted {
  pane: "inspect" | "fleet" | "system";
  ctrlOpen: boolean;
  // NOTE: autonomy is NOT persisted here anymore. The trust level is the ONE canonical value
  // in src/shared/autonomy.ts (localStorage "praxis.autonomy" + disk mirror + shell mirror),
  // read via loadAutonomy() and written via saveAutonomy() so every window agrees.
  settings: GraphSettings;
}

function loadPersisted(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    if (p?.settings?.shown) {
      const shown = { ...defaultSettings().shown, ...p.settings.shown };
      p.settings = { ...defaultSettings(), ...p.settings, shown };
    }
    return p;
  } catch {
    return {};
  }
}

/** Map an AgentRow (roster) → the minimal EngineAgent the canvas needs. */
function toEngineAgent(a: AgentRow): EngineAgent {
  return {
    id: a.id,
    name: a.name,
    fam: a.family ?? "sonnet",
    status: a.status,
    focus: a.focus,
    prog: a.prog ?? 0,
    progKnown: a.progKnown ?? false,
    touches: a.touches,
  };
}

export default function App() {
  // Restore (Controls tab) reloads every window; this window must hear it.
  useRestoreListener();
  // Re-measure after a gap: a cached reading is a fact with a shelf life.
  useLiveOnResume();
  useWindowHeartbeat();
  const saved = useRef(loadPersisted()).current;
  const [data, setData] = useState<GraphData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [pane, setPane] = useState<"inspect" | "fleet" | "system">(saved.pane ?? "inspect");
  const [ctrlOpen, setCtrlOpen] = useState(saved.ctrlOpen !== false);
  // The trust ladder is REAL: seed from the canonical value, and write through the same path the
  // Command Center TrustPanel uses (saveAutonomy → localStorage + autonomy_sync shell mirror +
  // disk mirror, then broadcastAutonomy → praxis://autonomy so the brain's leash updates live).
  const [autonomy, setAutonomyState] = useState<AutonomyKey>(() => loadAutonomy());
  const setAutonomy = (k: string) => {
    const key = k as AutonomyKey;
    setAutonomyState(key);
    saveAutonomy(key);
    void broadcastAutonomy(key);
  };
  const [voiceOn, setVoiceOn] = useState(false);
  const [settings, setSettings] = useState<GraphSettings>(() => saved.settings ?? defaultSettings());
  const [version, setVersion] = useState<string>("");
  const accent = ACCENT_DEFAULT; // locked default
  const [mutateTick, setMutateTick] = useState(0);
  const [quartzError, setQuartzError] = useState<string | null>(null);
  const galaxyRef = useRef<GalaxyHandle>(null);
  useWindowShortcuts();
  // Plumb REAL Claude-session activity into THIS window's eventBus (the one the galaxy's live
  // bridge subscribes to). Without this, attachEventBridge (Galaxy.tsx) had no real source -
  // useRealEvents only feeds the brain window's separate bundle. Tauri-only; inert in a browser.
  useGalaxyRealEvents();

  const { agents: roster, live } = useAgentRoster();

  // Graph freshness: the bundled memory-graph.json is baked into dist at BUILD time and goes
  // stale between rebuilds (found 9 days stale in the wild). Paint it (or the sample) instantly,
  // then under Tauri swap in the LIVE graph from %LOCALAPPDATA%\Praxis\memory-graph.json via
  // refresh_memory_graph / read_memory_graph, re-pulling every 5 min while the window is open.
  // The string-compare gate avoids re-seeding the engine (and re-flowing the whole layout)
  // when the vault hasn't actually changed between pulls.
  useEffect(() => {
    fetch("memory-graph.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no graph"))))
      .then((d: GraphData) => setData((cur) => cur ?? normalizeGraph(d)))
      .catch(() => setData((cur) => cur ?? SAMPLE_GRAPH));

    if (!inTauri()) return;
    let cancelled = false;
    let lastRaw = "";
    const pull = async (rebuild = true) => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (rebuild) await invoke("refresh_memory_graph").catch((e) => console.error("[galaxy] refresh_memory_graph", e));
        const raw = await invoke<string | null>("read_memory_graph").catch((e) => {
          console.error("[galaxy] read_memory_graph", e);
          return null;
        });
        if (cancelled || !raw || raw === lastRaw) return;
        lastRaw = raw;
        const next = normalizeGraph(JSON.parse(raw) as GraphData);
        setData((cur) => {
          // Shrink guard: a degenerate builder run once published a 13-node sessions-only
          // graph over the real ~950-node vault (2026-07-02). The builder now refuses to
          // write those, but never swap a full galaxy for a near-empty one from ANY source.
          // Count VAULT artifacts (same definition as the builder's own degenerate check):
          // conversations are exactly what a degenerate sessions-only graph is made of, so
          // they must not count toward "this graph looks healthy".
          const count = (g: GraphData) =>
            g.nodes.filter((n) => n.kind !== "hub" && n.kind !== "conversation").length;
          if (cur && count(next) < 50 && count(cur) >= 200) {
            console.warn(`[galaxy] ignoring suspicious graph shrink ${count(cur)} → ${count(next)} vault artifacts`);
            return cur;
          }
          return next;
        });
      } catch (e) {
        console.error("[galaxy] memory graph refresh failed", e);
      }
    };
    pull();
    // Pause the 5-min memory-graph rebuild while the galaxy window is hidden.
    const stop = visibleInterval(pull, 5 * 60 * 1000);
    let unlisten: (() => void) | undefined;
    let refreshPoll: ReturnType<typeof setInterval> | undefined;
    let refreshUntil = 0;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("praxis://memory-refresh", () => {
        if (cancelled) return;
        void pull(false);
        // The rebuild command returns before its child writes the file. Read
        // through that interval, even when hidden; never rebuild or re-emit.
        refreshUntil = Date.now() + 60_000;
        if (refreshPoll) clearInterval(refreshPoll);
        refreshPoll = setInterval(() => {
          if (Date.now() >= refreshUntil) clearInterval(refreshPoll);
          else void pull(false);
        }, 1_000);
      }))
      .then((off) => { if (cancelled) off(); else unlisten = off; })
      .catch((e) => console.error("[galaxy] refresh listener failed", e));
    return () => {
      cancelled = true;
      stop();
      unlisten?.();
      if (refreshPoll) clearInterval(refreshPoll);
    };
  }, []);

  // Real installed-app version in the brand label (tauri.conf.json's version - the one truth).
  // A hardcoded string here would go stale the first release after it was written.
  useEffect(() => {
    if (!inTauri()) return;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(`v${v} · ${__BUILD_TS__}`))
      .catch(() => {
        /* label just omits the version */
      });
  }, []);

  // Surface a dead/misconfigured vault (Quartz) sidecar instead of failing silently
  // (pairs with the Rust-side emits in quartz_sidecar.rs / open_knowledge) - and CLEAR
  // the banner on praxis://quartz-ready, since a cold Quartz boot legitimately takes
  // 60-120s and resolves itself (a warning that never retracts reads as a broken app).
  useEffect(() => {
    if (!inTauri()) return;
    let offErr: (() => void) | undefined;
    let offReady: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        offErr = await listen<string>("praxis://quartz-error", (e) => setQuartzError(e.payload));
        offReady = await listen("praxis://quartz-ready", () => setQuartzError(null));
      })
      .catch(() => {
        /* not inside the Tauri shell - nothing to listen for */
      });
    return () => {
      offErr?.();
      offReady?.();
    };
  }, []);

  useEffect(() => {
    try {
      const body = JSON.stringify({ pane, ctrlOpen, settings });
      localStorage.setItem(LS_KEY, body);
      mirrorSet(LS_KEY, body); // durable disk mirror - survives WebView2 data loss
    } catch {
      /* storage unavailable */
    }
  }, [pane, ctrlOpen, settings]);

  // Live cross-window trust sync: when another window (Command Center dial, voice "go
  // sovereign") broadcasts praxis://autonomy, update the ladder here too. Persist so THIS
  // window's localStorage + mirror stay current; do NOT re-broadcast (would loop). Mirrors the
  // brain's handler in src/App.tsx.
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        off = await listen<{ level?: AutonomyKey }>("praxis://autonomy", (e) => {
          const lvl = e.payload?.level;
          if (!lvl) return;
          setAutonomyState(lvl);
          saveAutonomy(lvl);
        });
      })
      .catch(() => {
        /* not inside the Tauri shell */
      });
    return () => off?.();
  }, []);

  const engineAgents = useMemo(() => roster.map(toEngineAgent), [roster]);

  const selectNode = (id: string | null) => {
    setSelected(id);
    if (id) {
      setPane("inspect");
      setOpenAgent(null);
    }
  };

  const byId = useMemo(() => {
    const m = new Map<string, GNode>();
    data?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [data]);

  useEffect(() => {
    if (import.meta.env.DEV)
      (window as unknown as { __galaxySelect?: (id: string | null) => void }).__galaxySelect = (id) => {
        selectNode(id);
        galaxyRef.current?.select(id);
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchSettings = (p: Partial<GraphSettings>) => setSettings((s) => ({ ...s, ...p }));
  const toggleArea = (id: AreaId) =>
    setSettings((s) => ({ ...s, shown: { ...s.shown, [id]: !s.shown[id] } }));
  const resetSettings = () => {
    setSettings(defaultSettings());
    galaxyRef.current?.resetLayout();
  };

  // Firing = real coding sessions only (the ONE shared rule - excludes the orchestrator core,
  // ambient companions, and infra engine), so this window's fleet/firing count matches Brain,
  // Command Center, and Flight Deck instead of contradicting them (2026-07-10 live-count fix).
  const working = firingCount(roster);

  // Header stats - memoized (2026-07-10 click-perf pass): this was recomputed on EVERY App
  // render (each node select re-scans all nodes + edges). mutateTick keeps engine-side graph
  // mutations (weave/bear) reflected without re-deriving on unrelated state changes.
  const stats = useMemo(() => (data ? deriveStats(data) : null), [data, mutateTick]);

  if (!data) {
    return (
      <div className="mg-root" style={rootStyle}>
        <div className="mg-loading">loading memory galaxy…</div>
      </div>
    );
  }

  const quartzStarting = quartzError?.toLowerCase().includes("still starting") ?? false;

  return (
    <div className="mg-root" style={rootStyle}>
      <div className="mg-vignette" aria-hidden />

      <Galaxy
        ref={galaxyRef}
        data={data}
        agents={engineAgents}
        settings={settings}
        accent={accent}
        grid={true}
        ambient={true}
        colorMode="areas"
        liveBridge={inTauri()}
        onSelect={selectNode}
        onGraphMutate={() => setMutateTick((n) => n + 1)}
        onReadout={(t) => {
          const el = document.getElementById("mg-readout");
          if (el) el.textContent = t;
        }}
      />

      {quartzError && (
        <div className="mg-banner-error" role={quartzStarting ? "status" : "alert"}>
          <span>
            {quartzStarting ? "vault content server starting - " : "vault content server unavailable - "}
            {quartzError}
          </span>
          <button onClick={() => setQuartzError(null)} aria-label="dismiss">
            ×
          </button>
        </div>
      )}

      <header className="mg-top">
        <div className="mg-top-l">
          <div className="mg-brand">
            <span className="mg-brand-orb" aria-hidden />
            <div className="mg-brand-txt">
              <div className="mg-brand-title">Memory Galaxy</div>
              <div className="mg-brand-sub">{version ? `Praxis ${version} · Shared memory` : "Praxis · Shared memory"}</div>
            </div>
          </div>
          <nav className="mg-nav">
            <button title="the live neural map" onClick={() => openWin("show_main_view_cmd", { view: "brain" })}>Brain</button>
            {/* Journey is a VIEW of the Brain window, not its own Tauri window - so
                this raises Brain and switches it to Journey in one command, rather
                than raising Brain on whatever view was last active. */}
            <button title="the roadmap timeline, in the Brain window" onClick={() => openWin("show_main_view_cmd", { view: "journey" })}>Journey</button>
            <button title="parallel Claude sessions" onClick={() => openWin("open_flight_deck_cmd")}>Flight Deck</button>
            <button title="autonomy · fleet · spend" onClick={() => openWin("open_command_center_cmd")}>Command</button>
          </nav>
        </div>
        <div className="mg-stats">
          <Stat n={stats?.artifacts ?? 0} label="artifacts" />
          <Stat n={stats?.links ?? 0} label="links" />
          <Stat n={`${working}/${roster.length}`} label="fleet" color={accent} />
        </div>
      </header>

      <GraphControls
        open={ctrlOpen}
        settings={settings}
        onChange={patchSettings}
        onToggleArea={toggleArea}
        onReset={resetSettings}
        onCollapse={() => setCtrlOpen((v) => !v)}
        graph={data}
      />

      <Cockpit
        pane={pane}
        setPane={setPane}
        selectedNode={selected ? byId.get(selected) ?? null : null}
        byId={byId}
        graph={data}
        accent={accent}
        roster={roster}
        live={live}
        working={working}
        openAgent={openAgent}
        setOpenAgent={setOpenAgent}
        autonomy={autonomy}
        setAutonomy={setAutonomy}
        onSelect={(id) => {
          selectNode(id);
          galaxyRef.current?.select(id);
        }}
        onFocusAgent={(id) => galaxyRef.current?.focusAgent(id)}
        onOpenFile={openNodeFile}
        mutateTick={mutateTick}
      />

      <BottomRail
        accent={accent}
        autonomyKey={autonomy}
        graph={data}
        firing={working}
        voiceOn={voiceOn}
        onVoice={() => setVoiceOn((v) => !v)}
      />

      {/* The voice-state pill follows whichever Praxis window the owner is working in.
          A SATELLITE: state only, no microphone. Only the window that owns the
          conversation runs the engine, because three more mounted engines would be
          three more mics rather than one assistant visible in four places. */}
      <VoiceStateSatellite />
    </div>
  );
}

const rootStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  overflow: "hidden",
  color: P.text,
  background: P.bg,
  fontFamily: FONT.serif,
};

function Stat({ n, label, color }: { n: number | string; label: string; color?: string }) {
  return (
    <div className="mg-stat">
      <strong style={{ color: color ?? "var(--p-text)" }}>{n}</strong>
      <span>{label}</span>
    </div>
  );
}

function deriveStats(data: GraphData) {
  // artifacts = the reconciling bucket total, so the header number always equals the sum of the
  // per-area counts the Atlas/System panels render (see deriveAreaBuckets) - no orphaned 50.
  const artifacts = deriveAreaBuckets(data).total;
  const links = data.edges.filter((e) => e.kind === "link" || e.kind === "dep").length;
  return { artifacts, links };
}

/** Normalize a fetched graph into the star-atlas shape (defensive against older schemas). */
function normalizeGraph(d: GraphData): GraphData {
  const areaIds = new Set(AREAS.map((a) => a.id));
  const nodes = d.nodes.map((n) => {
    const area: AreaId = areaIds.has(n.area) ? n.area : "global";
    return { ...n, area };
  });
  return { ...d, nodes, areas: d.areas ?? AREAS };
}
