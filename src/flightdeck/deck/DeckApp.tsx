/**
 * Flight Deck v3 - 1:1 port of the Claude Design package (Flight Deck.dc.html,
 * design_handoff_flight_deck), wired to the REAL backend:
 *
 *   sessions/lanes/repos/collisions ← fd_sessions + praxis://fd-update + topology
 *   spawn/stop                      ← fd_spawn_session / fd_stop_session
 *   messages/steer/casts            ← session_deliver (real CLI conversation turns)
 *   prompt vault                    ← pv_* global vault + outcome write-back
 *   HALT ALL                        ← haltStore (halted.txt - FlowRunner-gated)
 *   trust badge                     ← shared autonomy store + praxis://autonomy
 *   praxis directives               ← orchestrate()
 *
 * Layout contract (locked): mirrored delegation flow, Praxis → agents →
 * sessions (scrollable middle) → worktree lanes → repos (pinned). Zero line
 * crossings by construction; RED = collision; dashed = the owner's own hands.
 * Deviations from the package: see DECK_DEVIATIONS in model.ts.
 */
import { activateDeckControl } from '@/flightdeck/deck/a11y';
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { fetchLanes, fetchSessionTail, spawnSession, stopSession, setActiveWindow, activeWindowLabel, ACTIVE_WINDOW_OPTIONS, refreshLiveState, fetchPlanNames, type SpawnDriver, type PlanNames } from '../api';
import { appendFlightDeckAgentChat } from '../lib/sendToAgent';
import {
  DELIVER_CONCURRENCY,
  castToast,
  deliverToSession,
  enqueueDelivery,
  planCast,
  runLimited,
  takeReady,
  type DeliverResult,
  type DeliverTarget,
} from '../lib/deliverToSession';
import { useHalt } from '@/command/haltStore';
import { useFleetModels, getFleetSelection, executableModelFor } from '@/command/fleetStore';
import { loadAutonomy, type AutonomyKey } from '@/shared/autonomy';
import { useDeckData } from './useDeckData';
import { useDeckVault, type DeckVault, type PvEntry } from './useDeckVault';
import {
  AGENT_META,
  DECK_AGENTS,
  EFFORTS,
  agentForDriver,
  driverForAgent,
  effortAliasFor,
  DEFAULT_VAULT_MODEL,
  routedSessions,
  laneDiffLabel,
  vaultTagFor,
  toolBadge,
  modelChipText,
  pidForSpawnedSession,
  viaLabel,
  type AgentId,
  type DeckModel,
  type DeckSession,
  type EffortLabel,
  type SpawnMark,
  fmtElapsed,
} from './model';
import { DeckDock, type DockState, type DockTarget } from './DeckDock';
import { DeckVaultSearch } from './DeckVaultSearch';
import { AgentFlowPanel, CodeLanesPanel } from './DeckPanels';
import coreImg from './praxis-core.png';
import { COLORS, withAlpha } from './tokens';
import './deck.css';

const CW = 1760;
const CH = 990;
const RED = COLORS.red;

/** Header nav - same real window-open commands the Hud/RightDock/voice use. */
const NAV_TABS: Array<{ label: string; cmd: string | null }> = [
  { label: 'BRAIN', cmd: 'show_main_cmd' },
  { label: 'GALAXY', cmd: 'open_knowledge_cmd' },
  { label: 'FLIGHT DECK', cmd: null }, // you are here
  { label: 'COMMAND', cmd: 'open_command_center_cmd' },
];

function navWindow(cmd: string, name: string): void {
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke(cmd))
    .catch((e) => console.warn(`[deck] open ${name} failed`, e));
}

const TRUST_LINE: Record<AutonomyKey, string> = {
  observe: 'TRUST I · OBSERVE',
  suggest: 'TRUST II · PROPOSE',
  approve: 'TRUST II · APPROVE',
  operator: 'TRUST III · EXECUTE',
  full: 'TRUST IV · SOVEREIGN',
};

// ── Small persisted UI stores (preferences + transient channel logs) ─────────
// NOTE: per-agent DEFAULT MODEL used to live here in its own `praxis.fd.agentModel.v1`
// key - a second, disconnected source of truth from the Command Center's Fleet panel
// (`praxis.fleet.models.v1` / fleetStore.ts). Switching Forge's model in the CC never
// touched a Flight Deck spawn and vice versa. Fixed 2026-07-10: Flight Deck now reads
// the SAME fleetStore selection (`useFleetModels()` below) CC's Fleet panel writes.
const MSGS_KEY = 'praxis.fd.msgs.v1';
const PIDS_KEY = 'praxis.fd.spawnedPids.v1';
const PV_PENDING_KEY = 'praxis.fd.pvPending.v1';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export interface ChannelMsg {
  t: string;
  mode: string;
  at: string;
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtClock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDate(t: number): string {
  const d = new Date(t);
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${mo[d.getMonth()]}`;
}

interface PathSpec {
  key: string;
  kind: 'praxis' | 'wire' | 'L' | 'R';
  agent?: string;
  session?: string;
  lane?: string;
  repo?: string;
  color?: string;
  hue?: string;
  w?: number;
  manual?: boolean;
  working?: boolean;
  coll?: boolean;
  d: string;
}

type Focus = { type: 'session' | 'agent' | 'lane' | 'repo' | 'praxis'; id: string } | null;

function deliveryTarget(s: DeckSession): DeliverTarget {
  return {
    id: s.id,
    driver: s.driver,
    cwd: s.cwd,
    // A parked approval gate is just as unsafe to resume over as an active turn.
    working: s.working || s.status === 'blocked',
    name: s.name,
  };
}

const collectorStyle = (n: number, isTop: boolean): React.CSSProperties => ({
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  border: `1px solid ${withAlpha(COLORS.line, 0.22)}`,
  background: 'rgba(8,11,20,.96)',
  borderRadius: 999,
  padding: '5px 12px',
  zIndex: 3,
  boxShadow: `0 6px 20px ${withAlpha(COLORS.black, 0.4)}`,
  pointerEvents: 'none',
  opacity: n > 0 ? 1 : 0,
  visibility: n > 0 ? 'visible' : 'hidden',
  transition: 'opacity .2s',
  ...(isTop ? { top: 8 } : { bottom: 8 }),
});

/** Off-screen-session collector chip ("▲ N ABOVE"). Its own component with its
 *  own tiny state so the per-scroll-frame measure pass can update it WITHOUT
 *  re-rendering the whole deck: measure() calls the registered updater and the
 *  equality guard commits only when a card actually crosses the viewport edge. */
const CollectorChip = React.memo(function CollectorChip({
  side,
  register,
}: {
  side: 'top' | 'bottom';
  register: (fn: (n: number, cols: string[]) => void) => void;
}) {
  const [st, setSt] = useState<{ n: number; cols: string[] }>({ n: 0, cols: [] });
  useEffect(() => {
    register((n, cols) =>
      setSt((cur) =>
        cur.n === n && cur.cols.length === cols.length && cur.cols.every((c, i) => c === cols[i]) ? cur : { n, cols },
      ),
    );
  }, [register]);
  return (
    <div data-anchor={`collector-${side}`} style={collectorStyle(st.n, side === 'top')}>
      <span style={{ fontSize: 7.5, letterSpacing: '.18em', color: COLORS.textMuted, whiteSpace: 'nowrap' }}>
        {side === 'top' ? '▲' : '▼'} {st.n} {side === 'top' ? 'ABOVE' : 'BELOW'}
      </span>
      {st.cols.map((c, i) => (
        <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: c, flex: 'none' }} />
      ))}
    </div>
  );
});

export default function DeckApp(): React.ReactElement {
  const deck = useDeckData();
  const vault = useDeckVault();
  const { halted, toggleHalt } = useHalt();

  const model = deck.model;

  // ── clock (1s - drives the header clock, peek pins and elapsed chips) ──
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── real app version (tauri) ──
  const [version, setVersion] = useState('');
  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(`${v} · ${__BUILD_TS__}`))
      .catch(() => {});
  }, []);

  // ── live plan tier per provider, for the agent VIA badges (see viaLabel) ──
  // Never blocks first paint: starts all-null (provider-only labels) and upgrades
  // once plan_names resolves; a failed fetch just leaves it at the fallback.
  const [planNames, setPlanNames] = useState<PlanNames>({ claude: null, codex: null, cursor: null });
  useEffect(() => {
    fetchPlanNames().then(setPlanNames).catch(() => {});
  }, []);

  // ── trust badge (real autonomy state, live-updated) ──
  const [autonomy, setAutonomy] = useState<AutonomyKey>(() => loadAutonomy());
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('praxis://autonomy', () => setAutonomy(loadAutonomy())))
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // ── UI state ──
  const [focus, setFocus] = useState<Focus>(null);
  const [filter, setFilter] = useState<'all' | 'praxis' | 'mine' | 'alert'>('all');
  const [dock, setDock] = useState<DockState | null>(null);
  const [dockGhost, setDockGhost] = useState<DockState | null>(null);
  const [dockVal, setDockVal] = useState('');
  const [dockW, setDockW] = useState(474);
  const [dockDrag, setDockDrag] = useState(false);
  // Global prompt-vault search overlay + the entry a picked result should reveal
  // on the opened console's vault tab (nonce re-fires the scroll on re-pick).
  const [vaultSearchOpen, setVaultSearchOpen] = useState(false);
  const [dockFocus, setDockFocus] = useState<{ id: string; n: number } | null>(null);
  const [panel, setPanel] = useState<null | 'lanes' | 'flow'>(null);
  // ACTIVE WINDOW picker (bottom bar). The chosen window is persisted by the
  // backend, so this is menu-open state only - the value always comes from the
  // snapshot, never from local state that could disagree with what is rendered.
  const [windowMenu, setWindowMenu] = useState(false);
  const [reloadPhase, setReloadPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const [reloadStamp, setReloadStamp] = useState<string | null>(null);
  const [reloadErr, setReloadErr] = useState<string | null>(null);
  const [panelH, setPanelH] = useState(752);
  const [panelDrag, setPanelDrag] = useState(false);
  const [spawn, setSpawn] = useState<null | { lane: string | null; agent: AgentId; effort: EffortLabel; x: number; y: number }>(null);
  const [spawnPrompt, setSpawnPrompt] = useState('');
  // Optimistic lane-lock overlay: keyed by laneId, mirrors fd_set_lane_readonly
  // so the 🔒 flips instantly before the next fd_sessions poll returns the
  // authoritative `lane.readOnly`. Reconciled away once the model catches up.
  const [lockPending, setLockPending] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [haltArmed, setHaltArmed] = useState(false);
  const [fit, setFit] = useState({ k: 1, ox: 0, oy: 0 });
  const [paths, setPaths] = useState<PathSpec[]>([]);
  // ONE truth for per-agent default models - same fleetStore selections + persist +
  // cross-window live sync the Command Center's Fleet panel uses (2026-07-10 fix).
  // (The old local agentModel state is gone with it; the scroll-collector chips
  // live behind chipApi refs now, so their colTop/colBot state is gone too.)
  const fleet = useFleetModels();
  const [msgs, setMsgs] = useState<Record<string, ChannelMsg[]>>(() => loadJson(MSGS_KEY, {}));
  const [pins, setPins] = useState<Record<string, { text: string; until: number }>>({});
  // Live transcript tail for the open session console (fd_session_tail, 5s poll).
  const [liveTail, setLiveTail] = useState<string[] | null>(null);

  const toastT = useRef<number>(0);
  const haltT = useRef<number>(0);
  const ghostT = useRef<number>(0);
  const rafM = useRef<number | null>(null);
  const sigRef = useRef('');
  // Scroll-smooth machinery: live SVG <g> nodes by path key (for imperative `d`
  // writes during scroll), the array last handed to setPaths (its specs are
  // mutated in place so React and the DOM never disagree), and the collector-
  // chip updaters (tiny isolated components - no deck-wide re-render per frame).
  const pathEls = useRef(new Map<string, SVGGElement>());
  const pathsRef = useRef<PathSpec[]>([]);
  const chipApi = useRef<{ top?: (n: number, cols: string[]) => void; bottom?: (n: number, cols: string[]) => void }>({});
  const regChipTop = useCallback((fn: (n: number, cols: string[]) => void) => {
    chipApi.current.top = fn;
  }, []);
  const regChipBottom = useCallback((fn: (n: number, cols: string[]) => void) => {
    chipApi.current.bottom = fn;
  }, []);
  const geomRef = useRef<Array<{ id: string; agent: string; lane: string; color: string; working: boolean; manual: boolean; coll: boolean; ai: number; an: number; li: number; ln: number }>>([]);

  const say = useCallback((txt: string) => {
    window.clearTimeout(toastT.current);
    setToast(txt);
    toastT.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  const pinPeek = useCallback((sessionId: string, text: string) => {
    setPins((p) => ({ ...p, [sessionId]: { text, until: Date.now() + 6000 } }));
  }, []);

  // ── canvas fit ──
  const fitCanvas = useCallback(() => {
    const k = Math.min(window.innerWidth / CW, window.innerHeight / CH);
    const ox = Math.max(0, (window.innerWidth - CW * k) / 2);
    const oy = Math.max(0, (window.innerHeight - CH * k) / 2);
    setFit((f) => (Math.abs(f.k - k) < 0.0005 && Math.abs(f.ox - ox) < 0.5 && Math.abs(f.oy - oy) < 0.5 ? f : { k, ox, oy }));
  }, []);

  // ── derived session view (design's renderVals data section) ──
  const sessions = model.sessions;
  const laneById = model.laneById;
  const repoById = model.repoById;

  const byLane = useMemo(() => {
    const m: Record<string, DeckSession[]> = {};
    sessions.forEach((s) => {
      (m[s.laneId] ??= []).push(s);
    });
    return m;
  }, [sessions]);

  const collLanes = useMemo(() => {
    const m: Record<string, DeckSession[]> = {};
    for (const [laneId, list] of Object.entries(byLane)) {
      const lane = laneById[laneId];
      if (!lane?.collision) continue;
      const busy = list.filter((x) => x.status === 'working' || x.status === 'blocked');
      if (busy.length > 1) m[laneId] = busy;
    }
    return m;
  }, [byLane, laneById]);

  const isColl = useCallback(
    (s: DeckSession) => Boolean(collLanes[s.laneId]) && (s.status === 'working' || s.status === 'blocked'),
    [collLanes],
  );

  // ── live transcript tail for the open session console ──
  // Polls fd_session_tail every 5s while a session dock is open. Depends only on
  // the dock target (not the 6s-changing sessions array) so the interval is stable;
  // reads the latest session via a ref. Claude sessions return real tool/text lines;
  // codex/cursor return [] and the dock keeps the snapshot preview peek.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    if (dock?.type !== 'session') {
      setLiveTail(null);
      return;
    }
    const sid = dock.id;
    let alive = true;
    const pull = async () => {
      const s = sessionsRef.current.find((x) => x.id === sid);
      if (!s) return;
      const lines = await fetchSessionTail(s.id, s.cwd, s.driver, 12);
      if (alive && lines.length) setLiveTail(lines);
    };
    setLiveTail(null); // drop the previous session's lines immediately
    pull();
    const id = window.setInterval(pull, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [dock?.type, dock?.id]);

  const vis = useMemo(() => {
    const passes = (s: DeckSession) =>
      filter === 'all' ? true : filter === 'praxis' ? s.agent !== 'you' : filter === 'mine' ? s.agent === 'you' : s.status === 'blocked' || isColl(s);
    // Stable, crossing-free order: group by agent column order, then lane order.
    const agentOrder: Record<string, number> = { forge: 0, vega: 1, quill: 2, you: 3 };
    const laneOrder = new Map(model.lanes.map((l, i) => [l.id, i]));
    return sessions
      .filter(passes)
      .sort((a, b) => agentOrder[a.agent] - agentOrder[b.agent] || (laneOrder.get(a.laneId) ?? 0) - (laneOrder.get(b.laneId) ?? 0));
  }, [sessions, filter, isColl, model.lanes]);

  // geometry bookkeeping for the measure pass
  useEffect(() => {
    const agCnt: Record<string, number> = {};
    const laneCnt: Record<string, number> = {};
    vis.forEach((s) => {
      agCnt[s.agent] = (agCnt[s.agent] || 0) + 1;
      laneCnt[s.laneId] = (laneCnt[s.laneId] || 0) + 1;
    });
    const agIdx: Record<string, number> = {};
    const laneIdx: Record<string, number> = {};
    geomRef.current = vis.map((s) => {
      const ai = (agIdx[s.agent] = agIdx[s.agent] ?? 0);
      agIdx[s.agent] += 1;
      const li = (laneIdx[s.laneId] = laneIdx[s.laneId] ?? 0);
      laneIdx[s.laneId] += 1;
      return {
        id: s.id,
        agent: s.agent,
        lane: s.laneId,
        color: AGENT_META[s.agent].color,
        working: s.status === 'working',
        manual: s.manual,
        coll: isColl(s),
        ai,
        an: agCnt[s.agent],
        li,
        ln: laneCnt[s.laneId],
      };
    });
  }, [vis, isColl]);

  // ── the measure/path engine (ported verbatim from the package) ──
  const measure = useCallback(() => {
    // Backslashes in an attribute selector are CSS escapes - a topology lane id
    // like `topo:C:\Users\…` silently matched NOTHING, so every quiet-repo lane
    // lost its wire to the repo card. Escape them (and quotes) literally.
    const q = (s: string) => document.querySelector(`[data-anchor="${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
    const stage = q('stage');
    const scroll = q('sessions-scroll');
    if (!stage || !scroll) return;
    const sr = stage.getBoundingClientRect();
    const cvEl = q('canvas');
    const k = cvEl ? cvEl.getBoundingClientRect().width / CW : 1;
    const rel = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: (r.left - sr.left) / k, r: (r.right - sr.left) / k, t: (r.top - sr.top) / k, b: (r.bottom - sr.top) / k, cy: ((r.top + r.bottom) / 2 - sr.top) / k };
    };
    const scr = rel(scroll);
    if (!scr) return;
    const vTop = scr.t + 6;
    const vBot = scr.b - 6;
    const cT = rel(q('collector-top'));
    const cB = rel(q('collector-bottom'));
    const pr = rel(q('praxis'));
    // An endpoint is only real once its card has been MEASURED. Before first
    // layout (and for a tile that is not mounted at all - an empty deck, a lane
    // scrolled out and unmounted) a rect can be missing, which used to produce
    // `M NaN,NaN C NaN,NaN…` and a stream of SVG "Expected number" errors with no
    // wire drawn. Returning '' marks the path unbuildable; it is dropped below.
    const ok4 = (a: number, b: number, c: number, d: number) =>
      Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d);
    const cub = (x1: number, y1: number, x2: number, y2: number) => {
      if (!ok4(x1, y1, x2, y2)) return '';
      const dx = Math.max(34, Math.abs(x2 - x1) * 0.42);
      return `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    };
    const drop = (x1: number, y1: number, x2: number, y2: number) => {
      if (!ok4(x1, y1, x2, y2)) return '';
      const dx = x2 - x1;
      const dy = y2 - y1;
      return `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx * 0.5).toFixed(1)},${(y1 + dy * 0.06).toFixed(1)} ${(x1 + dx * 0.82).toFixed(1)},${(y1 + dy * 0.62).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    };
    // Right (lanes/repos) column visible band - with many lanes the column scrolls,
    // so a tile can sit outside the viewport; clamping every lane/repo endpoint into
    // this band makes its lines bend to the column edge ("it went that way") instead
    // of floating toward a ghost position offscreen.
    const lscr = rel(q('lanes-scroll'));
    const lvT = lscr ? lscr.t + 4 : -1e9;
    const lvB = lscr ? lscr.b - 4 : 1e9;
    const clampBand = (y: number) => Math.max(lvT, Math.min(lvB, y));
    const out: PathSpec[] = [];
    let topN = 0;
    let botN = 0;
    const topC: string[] = [];
    const botC: string[] = [];
    const liveBy: Record<string, number> = {};
    sessions.forEach((s) => {
      if (s.status === 'working' || s.status === 'blocked') liveBy[s.agent] = (liveBy[s.agent] || 0) + 1;
    });
    (['forge', 'vega', 'quill'] as const).forEach((aid) => {
      const ar = rel(q(`agent:${aid}`));
      if (!ar || !pr) return;
      const off = aid === 'forge' ? -16 : aid === 'vega' ? 0 : 16;
      out.push({ key: `P${aid}`, kind: 'praxis', agent: aid, color: AGENT_META[aid].color, w: 1 + (liveBy[aid] || 0) * 0.7, d: cub(pr.r + 4, pr.cy + off, ar.l - 3, ar.cy) });
    });
    const laneRect: Record<string, ReturnType<typeof rel>> = {};
    model.lanes.forEach((l) => {
      laneRect[l.id] = rel(q(`lane:${l.id}`));
    });
    geomRef.current.forEach((g) => {
      const ar = rel(q(`agent:${g.agent}`));
      const lr = laneRect[g.lane];
      if (!ar || !lr) return;
      const sRect = rel(q(`session:${g.id}`));
      let lx = 0;
      let ly = 0;
      let rx = 0;
      let ry = 0;
      let cl: 't' | 'b' | null = null;
      if (sRect) {
        const cy = sRect.cy;
        if (cy < vTop) cl = 't';
        else if (cy > vBot) cl = 'b';
        else {
          lx = sRect.l;
          ly = cy;
          rx = sRect.r;
          ry = cy;
        }
      } else cl = 't';
      // Fan endpoints MUST stay on their tile: the per-sibling offsets (±12/±9)
      // overshoot small cards once an agent/lane carries many sessions (the owner hit
      // this with 8+ YOURS sessions and 13-lane repos - lines hung in empty space).
      const say2 = Math.max(ar.t + 6, Math.min(ar.b - 6, ar.cy + (g.ai - (g.an - 1) / 2) * 12));
      const lay = clampBand(Math.max(lr.t + 4, Math.min(lr.b - 4, lr.cy + (g.li - (g.ln - 1) / 2) * 9)));
      if (cl) {
        if (cl === 't') {
          if (!cT) return;
          topN += 1;
          if (topC.length < 4) topC.push(g.color);
        } else {
          if (!cB) return;
          botN += 1;
          if (botC.length < 4) botC.push(g.color);
        }
        const gy = cl === 't' ? vTop + 2 : vBot - 2;
        const lgx = scr.l - 3;
        const rgx = lr.l - Math.max(20, (lr.l - scr.r) * 0.5);
        out.push({ key: `L${g.id}`, kind: 'L', session: g.id, agent: g.agent, color: g.color, manual: g.manual, working: g.working, coll: false, d: drop(ar.r + 3, say2, lgx, gy) });
        out.push({ key: `R${g.id}`, kind: 'R', session: g.id, agent: g.agent, lane: g.lane, color: g.color, manual: g.manual, working: g.working, coll: g.coll, d: drop(lr.l - 3, lay, rgx, gy) });
        return;
      }
      out.push({ key: `L${g.id}`, kind: 'L', session: g.id, agent: g.agent, color: g.color, manual: g.manual, working: g.working, coll: false, d: cub(ar.r + 3, say2, lx - 3, ly) });
      out.push({ key: `R${g.id}`, kind: 'R', session: g.id, agent: g.agent, lane: g.lane, color: g.color, manual: g.manual, working: g.working, coll: g.coll, d: cub(rx + 3, ry, lr.l - 3, lay) });
    });
    model.lanes.forEach((l) => {
      const lr = laneRect[l.id];
      const rr = rel(q(`repo:${l.repoId}`));
      if (!lr || !rr) return;
      const sibs = model.lanes.filter((x) => x.repoId === l.repoId);
      const i = sibs.indexOf(l);
      // Distribute wire endpoints evenly WITHIN the repo card (the old ±10px-per-
      // sibling fan overshot the ~64px tile once a repo had more than ~6 lanes -
      // catalyzed-alpha's 13 lanes left outer wires hanging off the card).
      const n = sibs.length;
      const wPad = 5;
      const wy = n > 1 ? rr.t + wPad + (i / (n - 1)) * (rr.b - rr.t - wPad * 2) : rr.cy;
      out.push({ key: `W${l.id}`, kind: 'wire', lane: l.id, repo: l.repoId, hue: repoById[l.repoId]?.hue, d: cub(lr.r + 3, clampBand(lr.cy), rr.l - 3, clampBand(wy)) });
    });
    // Collector chips live in their own micro-components - value-guarded, so a
    // commit happens only when a card actually crosses the viewport edge.
    chipApi.current.top?.(topN, topC);
    chipApi.current.bottom?.(botN, botC);
    // Signature covers geometry AND the style-relevant flags, so a flag-only
    // change (working→idle) still refreshes the stored specs below.
    const sig = out
      .map((p) => `${p.key}${p.d}${p.working ? 1 : 0}${p.coll ? 1 : 0}${p.manual ? 1 : 0}${p.w ?? ''}`)
      .join('|');
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    // SCROLL-SMOOTH FAST PATH: when the path SET is unchanged (pure geometry
    // shift - i.e. scrolling), write the new `d`s straight onto the live SVG
    // nodes and sync the state specs in place so React's next render (the 1s
    // clock at the latest) repaints the SAME geometry and fresh styles. Zero
    // React re-renders per scroll frame - the wires track the cards at rAF
    // cadence instead of snapping into place when scrolling stops.
    // Drop every wire whose endpoints were not measurable this pass (see ok4).
    // A missing wire for one frame is invisible; a NaN one is a console error and
    // an SVG element the browser refuses to render anyway.
    const drawable = out.filter((p) => p.d !== '');
    const prev = pathsRef.current;
    out.length = 0;
    out.push(...drawable);
    if (prev.length === out.length && prev.every((p, i) => p.key === out[i].key)) {
      for (let i = 0; i < out.length; i++) {
        const dChanged = prev[i].d !== out[i].d;
        Object.assign(prev[i], out[i]); // keep React state coherent (flags too)
        if (!dChanged) continue;
        const g = pathEls.current.get(out[i].key);
        if (g) {
          for (let c = 0; c < g.children.length; c++) g.children[c].setAttribute('d', out[i].d);
        }
      }
      return;
    }
    // Structure changed (sessions/lanes/filter) → let React reconcile the SVG.
    pathsRef.current = out;
    setPaths(out);
  }, [sessions, model.lanes, repoById]);

  const scheduleMeasure = useCallback(() => {
    if (rafM.current != null) return;
    rafM.current = requestAnimationFrame(() => {
      rafM.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    fitCanvas();
    const onRes = () => {
      fitCanvas();
      scheduleMeasure();
    };
    window.addEventListener('resize', onRes);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSpawn((sp) => {
          if (sp) return null;
          setDock((d) => {
            if (d) {
              closeDockInner(d);
              return null;
            }
            setPanel(null);
            return d;
          });
          return sp;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    const t1 = window.setTimeout(measure, 300);
    const t2 = window.setTimeout(measure, 900);
    if (document.fonts?.ready) document.fonts.ready.then(() => scheduleMeasure()).catch(() => {});
    return () => {
      window.removeEventListener('resize', onRes);
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      if (rafM.current != null) cancelAnimationFrame(rafM.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-measure only when the stage's geometry can actually change: the session
  // set / lanes / repos (via scheduleMeasure's identity, which follows measure's
  // deps) or the filter (changes which cards exist). Deps-less, this ran after
  // EVERY render - the 1s clock tick forced a full querySelector +
  // getBoundingClientRect layout pass over the whole board every second (the
  // signature check only skips the setState, not the reflow).
  useEffect(() => {
    scheduleMeasure();
  }, [scheduleMeasure, filter]);

  // ── dock open/close ──
  function closeDockInner(d: DockState) {
    setDockGhost(d);
    window.clearTimeout(ghostT.current);
    ghostT.current = window.setTimeout(() => setDockGhost(null), 650);
  }
  const openDock = useCallback(
    (type: DockTarget, id: string, opts?: { tab?: 'msg' | 'vault'; keep?: boolean }) => {
      setDock((cur) => {
        const same = Boolean(cur && cur.type === type && cur.id === id);
        if (same && !opts?.tab && !opts?.keep && cur) {
          closeDockInner(cur);
          return null;
        }
        window.clearTimeout(ghostT.current);
        if (!same) setDockVal('');
        return { type, id, tab: opts?.tab ?? (same && cur ? cur.tab : 'msg'), mode: same && cur ? cur.mode : 'message' };
      });
      setSpawn(null);
    },
    [],
  );
  const closeDock = useCallback(() => {
    setDock((d) => {
      if (d) closeDockInner(d);
      return null;
    });
  }, []);

  // Vault-search result → open its owning console on the vault tab, flag the entry
  // for reveal, and dismiss the overlay. View-only: no prompt is ever fired here.
  const openFromSearch = useCallback(
    (type: DockTarget, id: string, entryId: string) => {
      openDock(type, id, { tab: 'vault', keep: true });
      setDockFocus({ id: entryId, n: Date.now() });
      setVaultSearchOpen(false);
    },
    [openDock],
  );

  // ── entity helpers ──
  const entKey = useCallback((type: DockTarget, id: string) => (type === 'praxis' ? 'praxis' : `${type}:${id}`), []);
  const pushMsg = useCallback(
    (key: string, m: ChannelMsg) => {
      setMsgs((prev) => {
        const arr = [...(prev[key] ?? []), m].slice(-12);
        const next = { ...prev, [key]: arr };
        saveJson(MSGS_KEY, next);
        return next;
      });
    },
    [],
  );

  /** Deliver one real turn and mirror the result into both the originating
   * console and the target session's own channel. */
  const deliverOne = useCallback(
    async (target: DeliverTarget, text: string, channelKey: string): Promise<DeliverResult> => {
      const result = await deliverToSession(target, text);
      const targetKey = entKey('session', target.id);
      const label = target.name || target.id;
      const row: ChannelMsg = result.ok
        ? { t: `${label} — ${result.reply}`, mode: result.forked ? 'REPLY · FORK' : 'REPLY', at: fmtTime(Date.now()) }
        : { t: `${label} — ${result.reason}`, mode: 'FAILED', at: fmtTime(Date.now()) };
      pushMsg(channelKey, row);
      if (targetKey !== channelKey) pushMsg(targetKey, row);
      pinPeek(target.id, result.ok ? `↳ ${result.reply.replace(/\s+/g, ' ')}` : `⊘ ${result.reason}`);
      return result;
    },
    [entKey, pinPeek, pushMsg],
  );

  // Busy sessions receive queued Flight Deck messages as soon as the live census
  // says their current turn is over. takeReady removes them atomically before the
  // async resume, so a 6-second model refresh cannot double-deliver a message.
  useEffect(() => {
    const { ready, expired } = takeReady((id) => {
      const s = sessions.find((x) => x.id === id);
      return s ? s.working || s.status === 'blocked' : undefined;
    });
    for (const p of expired) {
      pushMsg(p.channelKey ?? entKey('session', p.sessionId), {
        t: `${p.label} — queued message expired after 12 hours`,
        mode: 'EXPIRED',
        at: fmtTime(Date.now()),
      });
    }
    if (!ready.length) return;
    let alive = true;
    void (async () => {
      let delivered = 0;
      let failed = 0;
      const bySession = new Map<string, typeof ready>();
      for (const p of ready) {
        const group = bySession.get(p.sessionId) ?? [];
        group.push(p);
        bySession.set(p.sessionId, group);
      }
      await runLimited([...bySession.values()], DELIVER_CONCURRENCY, async (group) => {
        // Multiple notes queued behind the same long turn must land in order;
        // only different sessions may resume concurrently.
        for (const p of group) {
          const live = sessionsRef.current.find((s) => s.id === p.sessionId);
          const target = live
            ? deliveryTarget(live)
            : p.driver
              ? { id: p.sessionId, driver: p.driver, cwd: p.cwd ?? null, working: false, name: p.label }
              : null;
          if (!target) {
            failed += 1;
            pushMsg(p.channelKey ?? entKey('session', p.sessionId), {
              t: `${p.label} — session routing details are no longer available`,
              mode: 'FAILED',
              at: fmtTime(Date.now()),
            });
            continue;
          }
          const result = await deliverOne(target, p.text, p.channelKey ?? entKey('session', p.sessionId));
          if (result.ok) delivered += 1;
          else failed += 1;
        }
      });
      if (alive) say(`⇶ QUEUED DELIVERY COMPLETE — ${delivered} REACHED${failed ? ` · ${failed} FAILED` : ''}`);
    })();
    return () => {
      alive = false;
    };
  }, [deliverOne, entKey, pushMsg, say, sessions]);

  // ── lane read-only LOCK (restored v2 behavior) ──
  // Effective lock = the model's real `readOnly` (auto background dir OR the
  // persisted operator override from fd_sessions), with the optimistic overlay
  // winning while a toggle is in flight.
  const isLaneReadOnly = useCallback(
    (laneId: string | null | undefined): boolean => {
      if (!laneId) return false;
      if (laneId in lockPending) return lockPending[laneId];
      return Boolean(laneById[laneId]?.readOnly);
    },
    [lockPending, laneById],
  );

  const toggleLaneLock = useCallback(
    async (laneId: string) => {
      const lane = laneById[laneId];
      if (!lane) return;
      // Auto-locked background lanes aren't operator-toggleable - they're locked
      // by what they are, so removing a user override can't make them writable.
      if (lane.autoReadOnly) {
        say(`${lane.letter} IS A BACKGROUND LANE — AUTO READ-ONLY, CAN'T UNLOCK`);
        return;
      }
      const next = !isLaneReadOnly(laneId);
      setLockPending((p) => ({ ...p, [laneId]: next }));
      say(next ? `🔒 ${lane.letter} LOCKED — READ-ONLY` : `🔓 ${lane.letter} UNLOCKED`);
      try {
        await invoke('fd_set_lane_readonly', { laneId, readOnly: next });
        deck.refresh();
      } catch (e) {
        setLockPending((p) => {
          const n = { ...p };
          delete n[laneId];
          return n;
        });
        say(`⊘ LOCK FAILED — ${String(e).slice(0, 50)}`);
      }
    },
    [laneById, isLaneReadOnly, deck, say],
  );

  // Drop the optimistic overlay once the polled model agrees with it.
  useEffect(() => {
    setLockPending((p) => {
      const keys = Object.keys(p);
      if (!keys.length) return p;
      let changed = false;
      const n = { ...p };
      for (const id of keys) {
        const lane = laneById[id];
        if (lane && Boolean(lane.readOnly) === p[id]) {
          delete n[id];
          changed = true;
        }
      }
      return changed ? n : p;
    });
  }, [laneById]);

  // ── send / cast / steer (REAL: session resume + agent notes + orchestrate) ──
  const sendDock = useCallback(async () => {
    if (!dock) return;
    const v = dockVal.trim();
    if (!v) {
      say('NOTHING TO SEND');
      return;
    }
    const key = entKey(dock.type, dock.id);
    const mode = dock.mode ?? 'message';
    const short = v.replace(/\s+/g, ' ');
    const logOutbound = (msgMode: string) => {
      pushMsg(key, { t: v, mode: msgMode, at: fmtTime(Date.now()) });
      setDockVal('');
    };

    if (dock.type === 'session') {
      const s = sessions.find((x) => x.id === dock.id);
      if (!s) {
        say('SESSION IS NO LONGER ON THE DECK — REFRESH AND TRY AGAIN');
        return;
      }
      const target = deliveryTarget(s);
      const payload = (mode === 'steer' ? '[STEER] ' : '') + v;
      const plan = planCast([target]);
      logOutbound(mode === 'steer' ? 'STEER' : 'MSG');
      say(castToast(plan));
      if (plan.queued.length) {
        enqueueDelivery({ sessionId: s.id, text: payload, at: Date.now(), label: s.name, driver: String(s.driver), cwd: s.cwd, channelKey: key });
        pinPeek(s.id, `⌛ queued — ${short}`);
      } else if (plan.unreachable.length) {
        const reason = plan.unreachable[0].why;
        pushMsg(key, { t: `${s.name} — ${reason}`, mode: 'FAILED', at: fmtTime(Date.now()) });
        pinPeek(s.id, `⊘ ${reason}`);
      } else {
        const result = await deliverOne(target, payload, key);
        say(result.ok ? `✓ DELIVERED TO ${s.name.toUpperCase()} — REPLY IS IN THIS CHANNEL` : `⊘ ${s.name.toUpperCase()} — ${result.reason}`);
      }
    } else if (dock.type === 'agent') {
      const a = AGENT_META[dock.id as AgentId];
      if (dock.id !== 'you') {
        const tool = dock.id === 'vega' ? 'codex' : dock.id === 'quill' ? 'cursor' : 'claude';
        await appendFlightDeckAgentChat({ tool, role: 'zach', text: v, driver: driverForAgent(dock.id as Exclude<AgentId, 'you'>), cwd: null });
      }
      logOutbound('QUEUED');
      say(`✉ QUEUED FOR ${a.name} — READ AT NEXT PICKUP`);
    } else if (dock.type === 'lane' || dock.type === 'repo') {
      // A locked lane refuses casts too - its sessions are left alone. For a single
      // lane that's an outright block; for a repo broadcast the locked lanes are
      // simply skipped so the rest of the repo still hears it.
      if (dock.type === 'lane' && isLaneReadOnly(dock.id)) {
        say(`🔒 ${laneById[dock.id]?.letter ?? 'LANE'} IS LOCKED — UNLOCK TO CAST`);
        return;
      }
      const laneIds = new Set(
        dock.type === 'lane' ? [dock.id] : model.lanes.filter((l) => l.repoId === dock.id).map((l) => l.id),
      );
      const targets = sessions.filter((x) => laneIds.has(x.laneId) && x.status !== 'done' && !isLaneReadOnly(x.laneId));
      if (targets.length === 0) {
        const unlocked = [...laneIds].some((id) => !isLaneReadOnly(id));
        say(
          dock.type === 'lane'
            ? 'NO LIVE SESSIONS IN THIS LANE'
            : unlocked
              ? 'NO LIVE SESSIONS IN THIS REPO'
              : '🔒 EVERY LANE HERE IS LOCKED — NOTHING TO CAST',
        );
        return;
      }
      const plan = planCast(targets.map(deliveryTarget));
      logOutbound('CAST');
      say(castToast(plan));
      for (const s of plan.queued) {
        enqueueDelivery({ sessionId: s.id, text: v, at: Date.now(), label: s.name ?? s.id, driver: String(s.driver), cwd: s.cwd, channelKey: key });
        pinPeek(s.id, `⌛ ${dock.type} queued — ${short}`);
      }
      for (const { s, why } of plan.unreachable) {
        pushMsg(key, { t: `${s.name ?? s.id} — ${why}`, mode: 'UNREACHABLE', at: fmtTime(Date.now()) });
        pinPeek(s.id, `⊘ ${why}`);
      }
      let delivered = 0;
      let failed = 0;
      await runLimited(plan.now, DELIVER_CONCURRENCY, async (s) => {
        const result = await deliverOne(s, v, key);
        if (result.ok) delivered += 1;
        else failed += 1;
      });
      say(
        `⇶ CAST COMPLETE — ${delivered} DELIVERED${plan.queued.length ? ` · ${plan.queued.length} QUEUED` : ''}${
          plan.unreachable.length ? ` · ${plan.unreachable.length} UNREACHABLE` : ''
        }${failed ? ` · ${failed} FAILED` : ''}`,
      );
    } else {
      // praxis directive → a REAL work order through the orchestrator
      logOutbound('DIRECTIVE');
      say('✦ DIRECTIVE ROUTED — PRAXIS FOLDS IT INTO THE NEXT PLAN');
      import('@/orchestrator/orchestrator')
        .then(({ orchestrate }) => orchestrate(v))
        .catch(() => say('✦ DIRECTIVE LOGGED — ORCHESTRATOR OFFLINE'));
    }
  }, [deliverOne, dock, dockVal, sessions, model.lanes, laneById, entKey, pushMsg, pinPeek, say, isLaneReadOnly]);

  const saveDockToVault = useCallback(async () => {
    if (!dock) return;
    const v = dockVal.trim();
    if (!v) {
      say('NOTHING TO SAVE — WRITE THE PROMPT FIRST');
      return;
    }
    const key = entKey(dock.type, dock.id);
    // The vault entry's model TAG is the small, driver-agnostic FLEET_MODELS label
    // (independent quick-tag subsystem - see model.ts) - nearest-match it from this
    // agent's REAL fleetStore selection so a saved prompt at least starts tagged with
    // something plausible for its agent, rather than one hardcoded model for
    // every agent regardless of who it was saved from.
    const defModel =
      dock.type === 'agent' && dock.id !== 'you' ? vaultTagFor(dock.id as Exclude<AgentId, 'you'>) : 'OPUS 4.8';
    const laneHint = dock.type === 'lane' ? laneById[dock.id]?.branch ?? undefined : undefined;
    await vault.add(key, v, defModel, 'MED', laneHint);
    setDockVal('');
    setDock((d) => (d ? { ...d, tab: 'vault' } : d));
    say('▣ SAVED — LIVES ON THIS CONSOLE');
  }, [dock, dockVal, entKey, vault, laneById, say]);

  // ── spawn / stop / fire (REAL lifecycle) ──
  // Immediate pid/cwd registry for STOP in this window, before React state catches up.
  // Shape is SpawnMark[] (pid+cwd+driver) - never keyed by the synthetic fd- session id,
  // which no card carries. Legacy Record<sessionId, {pid,driver}> is dropped on load.
  const pidMap = useRef<SpawnMark[]>((() => {
    const raw = loadJson<unknown>(PIDS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (x): x is SpawnMark =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as SpawnMark).pid === 'number' &&
        (x as SpawnMark).pid > 0 &&
        typeof (x as SpawnMark).cwd === 'string' &&
        typeof (x as SpawnMark).driver === 'string' &&
        typeof (x as SpawnMark).at === 'number',
    );
  })());
  const pvPending = useRef<Record<string, string>>(loadJson(PV_PENDING_KEY, {}));

  const doSpawn = useCallback(
    async (laneId: string, agent: AgentId, effort: EffortLabel, prompt: string) => {
      const lane = laneById[laneId];
      if (!lane?.path) {
        say('LANE HAS NO LOCAL WORKTREE');
        return null;
      }
      if (isLaneReadOnly(laneId)) {
        say(`🔒 ${lane.letter} IS LOCKED — UNLOCK TO SPAWN`);
        return null;
      }
      if (agent === 'you') {
        say('MANUAL SESSIONS START FROM YOUR OWN TERMINAL — PICK AN AGENT');
        return null;
      }
      const driver = driverForAgent(agent);
      // Real per-agent model, read fresh from the SAME fleetStore selection the
      // Command Center's Fleet panel writes (2026-07-10 fix - this used to read a
      // separate, disconnected `agentModel` localStorage key that a CC switch never
      // touched). executableModelFor applies the identical native-billing gate the
      // orchestrator's agent_delegate path uses, so a preference-only pick (e.g. a
      // Lens OpenRouter choice with no matching seam here) never gets injected as
      // --model on a CLI that would reject it - it just omits the flag, same as the
      // CLI's own default. Trimmed to undefined so an empty pick (Quill's Composer
      // default) omits --model entirely rather than sending an empty string.
      const rawModel = executableModelFor(agent);
      const model = rawModel.trim() ? rawModel.trim() : undefined;
      try {
        const res = await spawnSession({
          dir: lane.path,
          prompt,
          driver,
          model,
          effort: effortAliasFor(effort),
        });
        const mark: SpawnMark = { pid: res.pid, cwd: res.cwd, driver: res.driver, at: Date.now() };
        deck.registerSpawned(mark);
        pidMap.current = [...pidMap.current.filter((m) => m.pid !== mark.pid), mark].slice(-400);
        saveJson(PIDS_KEY, pidMap.current);
        say(`⊕ SPAWNED INTO ${lane.letter} — ${AGENT_META[agent].name}`);
        deck.refresh();
        return res;
      } catch (e) {
        say(`⊘ SPAWN FAILED — ${String(e).slice(0, 60)}`);
        return null;
      }
    },
    [laneById, deck, say, isLaneReadOnly],
  );

  // A session's pid comes from the BACKEND (Claude's own liveness-checked session
  // registry) for anything running, and from this window's spawn registry as a
  // fallback for a session Praxis just launched. Preferring the backend is what
  // makes STOP work for the sessions the owner started by hand - the case he tries
  // first, and the case that used to be silently unstoppable. Codex/Cursor cards
  // expose no pid; STOP then works only when exactly one Praxis spawn in that
  // cwd+driver is in the local registry.

  const pidFor = useCallback((s: DeckSession): { pid: number; driver: SpawnDriver } | null => {
    const hit = pidForSpawnedSession(s, pidMap.current);
    if (!hit) return null;
    const driver: SpawnDriver =
      hit.driver === 'codex' ? 'codex' : hit.driver === 'cursor' ? 'cursor' : 'claude';
    return { pid: hit.pid, driver };
  }, []);

  // Open the repo's next worktree lane for real. The Code Lanes panel's dashed
  // "next lane" row promised this ("git worktree add, praxis does it") and had no
  // handler behind it - the deck had never run git worktree add at all.
  const doAddLane = useCallback(
    async (repoRoot: string, letter: string) => {
      try {
        const msg = await invoke<string>('fd_add_worktree', { repoRoot, letter });
        say(`⎇ ${msg.toUpperCase()}`);
        deck.refresh();
        void deck.refreshTopology().catch((error: unknown) => setReloadErr(`TOPOLOGY REFRESH FAILED: ${String(error)}`));
      } catch (e) {
        say(`⊘ COULD NOT OPEN LANE — ${String(e).slice(0, 70)}`);
      }
    },
    [deck, say],
  );

  const doStop = useCallback(
    async (s: DeckSession) => {
      const rec = pidFor(s);
      if (!rec) {
        say('NO LIVE PID FOR THIS SESSION — STOP IT FROM ITS OWN TERMINAL');
        return;
      }
      try {
        await stopSession(rec.pid, rec.driver);
        pinPeek(s.id, '■ stopped by you — worktree left clean');
        say(`■ STOPPED — ${s.name}`);
        deck.refresh();
      } catch (e) {
        say(`⊘ STOP FAILED — ${String(e).slice(0, 60)}`);
      }
    },
    [deck, pinPeek, say, pidFor],
  );

  const fireVault = useCallback(
    async (key: string, entry: PvEntry) => {
      if (!entry.text.trim()) {
        say('EMPTY PROMPT — EDIT IT FIRST');
        return;
      }
      const sp = key.split(':');
      const scope = sp[0];
      const id = sp.slice(1).join(':');
      const m2a: Record<string, Exclude<AgentId, 'you'>> = {
        'OPUS 4.8': 'forge',
        'SONNET 5': 'forge',
        'FABLE 5': 'forge',
        CODEX: 'vega',
        CURSOR: 'quill',
        // Backward compatibility for vault entries written by the short-lived
        // all-OpenAI migration. They now route to the native Codex worker.
        'GPT-6 ASTRA': 'vega',
        'GPT-5.6 SOL': 'vega',
        'GPT-5.6 TERRA': 'vega',
        'GPT-5.6 LUNA': 'vega',
      };
      if (scope === 'session') {
        // FIRE at a session RUNS the prompt in that session's lane.
        //
        // It used to append the text to a per-AGENT chat file, write
        // `outcome: 'done'` with "delivered to live session thread", DELETE the
        // entry, and toast "SENT INTO <session>" - while nothing whatsoever
        // reached the session. It cannot: a headless `claude -p` was handed its
        // whole prompt at spawn and runs with stdin closed (Stdio::null), so
        // there is no channel into a live CLI to inject anything.
        //
        // The real action is to run the work in that session's own working dir,
        // which is what "fire this at that session" means in practice. The toast
        // now says what actually happened, the entry survives until the spawn
        // resolves, and the outcome is written by the same terminal write-back
        // loop every other fire uses - never fabricated up front.
        const s = sessions.find((x) => x.id === id);
        if (!s) return;
        if (isLaneReadOnly(s.laneId)) {
          say(`🔒 ${laneById[s.laneId]?.letter ?? 'LANE'} IS LOCKED — UNLOCK TO FIRE`);
          return;
        }
        const target = s.agent !== 'you' ? s.agent : m2a[entry.model ?? DEFAULT_VAULT_MODEL] ?? 'forge';
        const res = await doSpawn(
          s.laneId,
          target,
          ((entry.effort ?? 'MED').toUpperCase() as EffortLabel) || 'MED',
          entry.text,
        );
        if (res) {
          pvPending.current[res.sessionId] = entry.id;
          saveJson(PV_PENDING_KEY, pvPending.current);
          pinPeek(s.id, `▣ vault — ${entry.text.replace(/\s+/g, ' ').slice(0, 80)}`);
          say(`▸ FIRED INTO ${laneById[s.laneId]?.letter ?? 'LANE'} — ${AGENT_META[target].name}`);
        }
        return;
      }
      // Explicit locked lane → outright block (don't silently reroute elsewhere).
      if (scope === 'lane' && isLaneReadOnly(id)) {
        say(`🔒 ${laneById[id]?.letter ?? 'LANE'} IS LOCKED — UNLOCK TO FIRE`);
        return;
      }
      let agent: Exclude<AgentId, 'you'> = scope === 'agent' && id !== 'you' ? (id as Exclude<AgentId, 'you'>) : m2a[entry.model ?? DEFAULT_VAULT_MODEL] ?? 'forge';
      // lane resolution: explicit lane → that lane; repo → quietest lane; else quietest anywhere.
      // Locked lanes are excluded so a repo/agent fire never lands in one.
      const busy: Record<string, number> = {};
      sessions.forEach((s) => {
        if (s.status !== 'done') busy[s.laneId] = (busy[s.laneId] || 0) + 1;
      });
      const pool = model.lanes.filter(
        (l) => l.path && !isLaneReadOnly(l.id) && (scope === 'lane' ? l.id === id : scope === 'repo' ? l.repoId === id : true),
      );
      pool.sort((a, b) => (busy[a.id] || 0) - (busy[b.id] || 0));
      const lane = pool[0];
      if (!lane) {
        say('NO UNLOCKED LOCAL LANE AVAILABLE TO FIRE INTO');
        return;
      }
      const res = await doSpawn(lane.id, agent, ((entry.effort ?? 'MED').toUpperCase() as EffortLabel) || 'MED', entry.text);
      if (res) {
        pvPending.current[res.sessionId] = entry.id;
        saveJson(PV_PENDING_KEY, pvPending.current);
        say(`▸ FIRED — ${AGENT_META[agent].name} INTO ${lane.letter}`);
      }
    },
    [sessions, model.lanes, vault, doSpawn, pinPeek, say, isLaneReadOnly, laneById],
  );

  // Outcome write-back: when a fired session goes terminal, record the run on
  // its vault entry (pv_record_outcome) - the loop that makes the vault alive.
  useEffect(() => {
    const pending = pvPending.current;
    const ids = Object.keys(pending);
    if (!ids.length) return;
    for (const sid of ids) {
      const s = sessions.find((x) => x.id === sid);
      if (s && s.running) continue; // still live
      const pvId = pending[sid];
      const snippet = s?.peeks[0] ?? 'session ended';
      vault
        .recordOutcome(pvId, {
          firedAt: Date.now(),
          driver: s?.driver ?? 'claude',
          agent: s?.agent,
          cwd: s?.cwd ?? undefined,
          outcome: 'done',
          resultSnippet: snippet,
        })
        .catch(() => {});
      delete pending[sid];
    }
    saveJson(PV_PENDING_KEY, pending);
  }, [sessions, vault]);

  // ── HALT ALL (real: halted.txt gate all agents/flows respect) ──
  const haltAll = useCallback(() => {
    if (!haltArmed) {
      setHaltArmed(true);
      window.clearTimeout(haltT.current);
      haltT.current = window.setTimeout(() => setHaltArmed(false), 2600);
      return;
    }
    window.clearTimeout(haltT.current);
    setHaltArmed(false);
    toggleHalt();
    say(halted ? '▸ FLEET RESUMED — HALT LIFTED' : '■ FLEET HALTED — NEW WORK REFUSED (halted.txt)');
  }, [haltArmed, halted, toggleHalt, say]);

  const reloadDeck = useCallback(async () => {
    if (reloadPhase === 'loading') return;
    setReloadPhase('loading');
    setReloadErr(null);
    const before = model.generatedAt;
    const deadline = Date.now() + 15_000;
    let timeout: ReturnType<typeof window.setTimeout> | undefined;
    try {
      const snap = await Promise.race([
        (async () => {
          await deck.refreshTopology();
          if (Date.now() >= deadline) throw new Error('Topology refresh timed out');
          await refreshLiveState();
          while (Date.now() < deadline) {
            const next = await fetchLanes();
            if (next.error) throw new Error(next.error);
            if (next.generatedAt > before) return next;
            await new Promise((r) => window.setTimeout(r, 250));
          }
          throw new Error('No fresh snapshot within 15 seconds');
        })(),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('No fresh snapshot within 15 seconds')), 15_000);
        }),
      ]);
      deck.refresh();
      deck.acceptSnapshot(snap);
      const stamp = new Date().toLocaleTimeString([], { hour12: false });
      const unchanged = snap.activeCount === model.activeCount && snap.runningCount === model.runningCount;
      setReloadStamp(`${unchanged ? 'UP TO DATE' : 'RELOADED'} ${stamp} \u00b7 ${snap.activeCount} active \u00b7 ${snap.runningCount} running`);
      setReloadPhase('done');
      window.setTimeout(() => setReloadPhase('idle'), 5000);
    } catch (error) {
      setReloadPhase('idle');
      setReloadErr(`RELOAD FAILED: ${String(error instanceof Error ? error.message : error)}`);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }, [reloadPhase, model.generatedAt, model.activeCount, model.runningCount, deck]);

  // ── focus threading (design's th maps) ──
  const F: Focus = focus ?? (dock ? { type: dock.type, id: dock.id } : null);
  const th = useMemo(() => {
    const t = { s: {} as Record<string, 1>, a: {} as Record<string, 1>, l: {} as Record<string, 1>, r: {} as Record<string, 1> };
    if (!F) return { ...t, has: false };
    const addS = (x: DeckSession) => {
      t.s[x.id] = 1;
      t.a[x.agent] = 1;
      t.l[x.laneId] = 1;
      const lane = laneById[x.laneId];
      if (lane) t.r[lane.repoId] = 1;
    };
    if (F.type === 'session') {
      const x = sessions.find((z) => z.id === F.id);
      if (x) addS(x);
    } else if (F.type === 'agent') {
      t.a[F.id] = 1;
      sessions.forEach((x) => {
        if (x.agent === F.id) addS(x);
      });
    } else if (F.type === 'lane') {
      t.l[F.id] = 1;
      const lane = laneById[F.id];
      if (lane) t.r[lane.repoId] = 1;
      (byLane[F.id] ?? []).forEach(addS);
    } else if (F.type === 'repo') {
      t.r[F.id] = 1;
      model.lanes.forEach((l) => {
        if (l.repoId === F.id) {
          t.l[l.id] = 1;
          (byLane[l.id] ?? []).forEach(addS);
        }
      });
    } else {
      sessions.forEach((x) => {
        if (x.agent !== 'you' && x.status !== 'done') addS(x);
      });
    }
    return { ...t, has: true };
  }, [F, sessions, byLane, laneById, model.lanes]);

  const nodeOp = (m: boolean) => (th.has ? (m ? 1 : 0.3) : 1);

  // ── header stats ──
  // ONE truth for every "live/firing" readout on the deck: a working coding session
  // = running AND < 30 min since last activity (displayStatus computes 'working'
  // exactly that way). This matches the rule the brain/galaxy windows use, so the
  // four windows can't disagree. It drives BOTH "N LIVE" (top strip) and "N FIRING"
  // (origin core + bottom bar) - never two independent counts.
  const firingN = sessions.filter((s) => s.status === 'working').length;
  const workingN = firingN; // alias - kept for the existing LIVE/FIRING render sites
  // Real sessions the ACTIVE WINDOW / account / fold rules kept off the deck.
  // Surfaced on the window chip so the filter is never a silent truncation.
  const hiddenAccountN = model.hiddenAccounts.reduce((n, a) => n + a.count, 0);
  const hiddenTotal =
    model.hiddenOlder +
    (hiddenAccountN || model.hiddenOtherAccount) +
    model.hiddenSubagents +
    model.hiddenProbes + model.hiddenPraxis + model.hiddenAutomation + model.hiddenPlaceholders;
  const blockedN = sessions.filter((s) => s.status === 'blocked').length;
  const collLaneN = Object.keys(collLanes).length;
  const alertN = blockedN + Object.values(collLanes).reduce((n, arr) => n + arr.length, 0);
  // ROUTED = the full ACTIVE session pool on the deck (visibility = unarchived, on a current
  // Claude account, and running or inside the ACTIVE WINDOW). It is exactly the "N OF M"
  // denominator below, and is always ≥ firingN, so "N ROUTED · N FIRING" can never contradict "N
  // LIVE". ONE definition of ROUTED, shared with the Praxis console (routedSessions in
  // model.ts).
  const routedN = routedSessions(sessions).length;
  // Honest overflow: unarchived sessions beyond the backend's per-lane card cap.
  // Never silently trimmed - the header names the count so M is trusted.
  const hiddenN = useMemo(() => model.lanes.reduce((n, l) => n + (l.overflow || 0), 0), [model.lanes]);

  // The owner's three words, used exactly: RUNNING (a prompt is going) / ACTIVE (open
  // in the sidebar, nothing running) / DONE. Archived never reaches the client.
  const statusMap: Record<string, [string, string]> = {
    working: ['RUNNING', COLORS.statusWorking],
    blocked: ['TOOL PENDING', COLORS.statusPending],
    idle: ['ACTIVE', COLORS.textIdle],
    done: ['DONE ✓', COLORS.textDim],
  };

  // ── spawn popover ──
  const canvasRect = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cv = document.querySelector('[data-anchor="canvas"]');
    if (!cv) return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    const cr = cv.getBoundingClientRect();
    const k = cr.width / CW;
    return { left: (r.left - cr.left) / k, right: (r.right - cr.left) / k, top: (r.top - cr.top) / k, bottom: (r.bottom - cr.top) / k };
  };
  const openSpawn = (laneId: string | null, e: React.MouseEvent) => {
    e.stopPropagation();
    const r = canvasRect(e.currentTarget);
    const W = 316;
    const H = 360;
    let x = laneId ? r.left - W - 16 : r.right - W;
    let y = laneId ? r.top - 40 : r.bottom + 10;
    // Degenerate rects (0-width canvas while hidden/minimized) divide to NaN -
    // clamp to a sane default instead of poisoning the popover's CSS `left`.
    if (!Number.isFinite(x)) x = CW / 2 - W / 2;
    if (!Number.isFinite(y)) y = CH / 2 - H / 2;
    x = Math.max(10, Math.min(x, CW - W - 10));
    y = Math.max(46, Math.min(y, CH - H - 10));
    setSpawn({ lane: laneId, agent: 'forge', effort: 'MED', x, y });
    setSpawnPrompt('');
  };
  const submitSpawn = async () => {
    if (!spawn) return;
    if (!spawn.lane) {
      say('PICK A LANE FIRST');
      return;
    }
    if (!spawnPrompt.trim()) {
      say('WRITE THE TASK PROMPT FIRST');
      return;
    }
    const res = await doSpawn(spawn.lane, spawn.agent, spawn.effort, spawnPrompt.trim());
    if (res) {
      setSpawn(null);
      setSpawnPrompt('');
    }
  };

  // ── drag handlers (panel height + dock width) ──
  const startPanelDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const cv = document.querySelector('[data-anchor="canvas"]');
    const move = (ev: MouseEvent) => {
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const k = r.width / CW;
      const y = (ev.clientY - r.top) / k;
      setPanelH(Math.max(380, Math.min(CH - 76, CH - y + 12)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setPanelDrag(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    setPanelDrag(true);
  };
  const startDockDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const cv = document.querySelector('[data-anchor="canvas"]');
    const move = (ev: MouseEvent) => {
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const k = r.width / CW;
      const x = (ev.clientX - r.left) / k;
      setDockW(Math.max(380, Math.min(920, CW - x + 6)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDockDrag(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    setDockDrag(true);
  };

  // ── path styling (design's renderVals path section) ──
  const styledPaths = paths.map((p) => {
    let m = false;
    if (p.kind === 'praxis') m = Boolean(th.a[p.agent ?? '']);
    else if (p.kind === 'wire') m = Boolean(th.l[p.lane ?? ''] || (F && F.type === 'repo' && th.r[p.repo ?? '']));
    else m = Boolean(th.s[p.session ?? '']);
    const color = p.kind === 'R' && p.coll ? RED : p.kind === 'wire' ? p.hue ?? COLORS.pathFallback : p.color ?? COLORS.pathFallback;
    const baseOp = p.kind === 'praxis' ? 0.3 : p.kind === 'wire' ? 0.38 : 0.5;
    const op = th.has ? (m ? 0.95 : 0.05) : baseOp;
    const main: React.CSSProperties = { stroke: color, strokeWidth: p.kind === 'praxis' ? p.w : 1.4, opacity: op, strokeLinecap: 'round', transition: 'opacity .25s' };
    if (p.manual) main.strokeDasharray = '5 6';
    if (p.coll) main.animation = 'fdRed 1.6s ease-in-out infinite';
    const glow: React.CSSProperties = { stroke: color, strokeWidth: 7, opacity: th.has ? (m ? 0.14 : 0.015) : p.coll ? 0.12 : 0.055, transition: 'opacity .25s' };
    let flow: React.CSSProperties | null = null;
    if ((p.kind === 'L' || p.kind === 'R') && p.working && !p.manual) {
      flow = { stroke: color, strokeWidth: 1.8, opacity: th.has ? (m ? 0.95 : 0.04) : 0.75, strokeDasharray: '2 10', strokeLinecap: 'round', animation: 'fdDash 1.15s linear infinite' };
    }
    return { d: p.d, glow, main, flow, key: p.key };
  });

  // ── agent cards ──
  const buildBy: Record<string, number> = {};
  const liveByAll: Record<string, number> = {};
  sessions.forEach((s) => {
    if (s.status === 'working' || s.status === 'blocked') buildBy[s.agent] = (buildBy[s.agent] || 0) + 1;
    if (s.status !== 'done') liveByAll[s.agent] = (liveByAll[s.agent] || 0) + 1;
  });

  const renderAgent = (a: (typeof DECK_AGENTS)[number]) => {
    const live = buildBy[a.id] || 0;
    const m = Boolean(th.a[a.id]);
    const st: React.CSSProperties = {
      border: `1px solid ${m ? `${a.color}66` : `${a.color}26`}`,
      borderRadius: 12,
      background: 'rgba(12,16,30,.72)',
      padding: '11px 13px',
      position: 'relative',
      opacity: nodeOp(m),
      transition: 'opacity .25s, border-color .25s, box-shadow .25s',
      cursor: 'pointer',
      boxShadow: m ? `0 0 0 1px ${a.color}22, 0 10px 30px ${withAlpha(COLORS.black, 0.3)}` : 'none',
    };
    if (a.id === 'you') st.borderStyle = 'dashed';
    const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: '50%', background: a.color, flex: 'none', boxShadow: `0 0 10px ${a.color}` };
    if (live > 0) dot.animation = 'fdPulse 2.2s ease-in-out infinite';
    if (live === 0) {
      dot.background = 'transparent';
      dot.border = `1.5px solid ${a.color}`;
      dot.boxShadow = 'none';
    }
    const vaultN = vault.counts[`agent:${a.id}`] ?? 0;
    return (
      <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Open ${a.name} console`}
        key={a.id}
        data-anchor={`agent:${a.id}`}
        style={st}
        onMouseEnter={() => setFocus({ type: 'agent', id: a.id })}
        onMouseLeave={() => setFocus(null)}
        onClick={() => openDock('agent', a.id)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={dot} />
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.18em', color: a.color }}>{a.name}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 7, letterSpacing: '.14em', color: live > 0 ? COLORS.textMuted : COLORS.textFainter, flex: 'none', whiteSpace: 'nowrap' }}>
            {a.id === 'you' ? `${liveByAll.you || 0} YOURS` : `${live} LIVE`}
          </span>
        </div>
        <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 12.5, color: COLORS.textMuted, marginTop: 2 }}>{a.tool}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <span style={{ fontSize: 7, letterSpacing: '.14em', color: COLORS.textFainter, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {a.id === 'you' ? 'HANDS ON KEYBOARD' : `${getFleetSelection(a.id)?.label ?? '—'} · VIA ${viaLabel(a.id, planNames)}`}
          </span>
          <button type="button" aria-label={`Open ${a.name} prompt vault (${vaultN})`} className="fd-control"
            style={{
              fontSize: 7,
              letterSpacing: '.1em',
              color: COLORS.accentBright,
              border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`,
              borderRadius: 6,
              padding: '2px 7px',
              cursor: 'pointer',
              flex: 'none',
              whiteSpace: 'nowrap',
              display: vaultN > 0 ? 'inline-block' : 'none',
            }}
            onClick={(e) => {
              e.stopPropagation();
              openDock('agent', a.id, { keep: true, tab: 'vault' });
            }}
          >
            ▣ {vaultN}
          </button>
        </div>
      </div>
    );
  };

  // ── session cards ──
  const renderSession = (s: DeckSession) => {
    const a = AGENT_META[s.agent];
    const coll = isColl(s);
    const m = Boolean(th.s[s.id]);
    const lane = laneById[s.laneId];
    const repo = lane ? repoById[lane.repoId] : undefined;
    const stw = s.activity === 'running' ? statusMap.working : statusMap.idle;
    let border = withAlpha(COLORS.line, 0.14);
    let shadow = 'none';
    if (coll) {
      border = withAlpha(COLORS.red, 0.55);
      shadow = `0 0 0 1px ${withAlpha(COLORS.red, 0.14)}, 0 0 26px ${withAlpha(COLORS.red, 0.09)}`;
    } else if (s.status === 'blocked') border = withAlpha(COLORS.statusPending, 0.4);
    else if (m) border = `${a.color}66`;
    const st: React.CSSProperties = {
      position: 'relative',
      border: `1px solid ${border}`,
      borderRadius: 12,
      background: 'linear-gradient(180deg, rgba(15,19,34,.88), rgba(11,14,26,.88))',
      padding: '12px 13px 13px',
      cursor: 'pointer',
      width: '100%',
      maxWidth: 700,
      margin: '0 auto',
      flex: 'none',
      opacity: th.has ? (m ? 1 : 0.35) : s.status === 'done' ? 0.62 : 1,
      transition: 'opacity .25s, border-color .25s, box-shadow .25s',
      boxShadow: m ? (shadow === 'none' ? `0 10px 30px ${withAlpha(COLORS.black, 0.35)}` : shadow) : shadow,
    };
    if (s.manual) {
      st.borderStyle = s.activity === 'running' ? 'solid' : 'dashed';
      if (!coll) st.border = `1px ${s.activity === 'running' ? 'solid' : 'dashed'} ${withAlpha(s.activity === 'running' ? COLORS.statusWorking : COLORS.textValue, 0.3)}`;
    }
    if (s.fresh) st.animation = 'fdRise .5s cubic-bezier(.16,1,.3,1)';
    const dot: React.CSSProperties = { width: 9, height: 9, borderRadius: '50%', flex: 'none' };
    if (s.status === 'working') {
      dot.background = a.color;
      dot.boxShadow = `0 0 10px ${a.color}`;
      dot.animation = 'fdPulse 2s ease-in-out infinite';
    } else if (s.status === 'blocked') {
      dot.background = COLORS.statusPending;
      dot.boxShadow = `0 0 10px ${withAlpha(COLORS.statusPending, 0.8)}`;
      dot.animation = 'fdPulse 1.1s ease-in-out infinite';
    } else if (s.status === 'idle') {
      dot.background = 'transparent';
      dot.border = `1.5px solid ${COLORS.textIdle}`;
    } else {
      dot.background = withAlpha(COLORS.statusWorking, 0.65);
    }
    const pin = pins[s.id];
    const peek = pin && pin.until > now ? pin.text : s.peeks[0] ?? '—';
    const vaultN = vault.counts[`session:${s.id}`] ?? 0;
    const others = coll ? (collLanes[s.laneId] ?? []).filter((x) => x.id !== s.id) : [];
    const canStop = (s.status === 'working' || s.status === 'blocked') && Boolean(pidFor(s));
    const actBase: React.CSSProperties = { fontSize: 7, letterSpacing: '.12em', color: COLORS.textStrong, border: `1px solid ${withAlpha(COLORS.line, 0.4)}`, background: 'rgba(8,11,20,.97)', borderRadius: 6, padding: '4px 9px', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' };
    const actRed: React.CSSProperties = { ...actBase, color: COLORS.redText, border: `1px solid ${withAlpha(COLORS.red, 0.4)}` };
    return (
      <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Open session ${s.name}`}
        key={s.id}
        data-anchor={`session:${s.id}`}
        data-activity={s.activity}
        style={st}
        onMouseEnter={() => setFocus({ type: 'session', id: s.id })}
        onMouseLeave={() => setFocus(null)}
        onClick={() => openDock('session', s.id, { keep: true })}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span style={dot} />
          {/* The TITLE carries the platform colour, so which tool ran a session is
              readable from across the room without reading a chip. Falls back to
              the neutral ink when the driver is unrecognised - an uncoloured title
              means "unattributed", never a guessed colour. */}
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.1em', color: toolBadge(s.driver)?.color ?? (s.manual ? COLORS.textBrightest : COLORS.text), overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.name}</span>
          {s.manual && (
            <span style={{ fontSize: 6.5, letterSpacing: '.16em', color: COLORS.textValue, border: `1px solid ${withAlpha(COLORS.textValue, 0.35)}`, borderRadius: 99, padding: '2px 6px', flex: 'none' }}>◈ YOURS</span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" aria-label={`Open ${s.name} prompt vault (${vaultN})`} className="fd-control"
            style={{ fontSize: 7, letterSpacing: '.1em', color: COLORS.accentBright, border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, borderRadius: 6, padding: '2px 7px', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap', display: vaultN > 0 ? 'inline-block' : 'none' }}
            onClick={(e) => {
              e.stopPropagation();
              openDock('session', s.id, { keep: true, tab: 'vault' });
            }}
          >
            ▣ {vaultN}
          </button>
          <span style={{ fontSize: 8, color: COLORS.textFainter, letterSpacing: '.08em', flex: 'none', whiteSpace: 'nowrap' }}>{fmtElapsed(s.lastActiveMs)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${a.color}3a`, color: a.color, borderRadius: 99, padding: '3px 8px', fontSize: 7.5, letterSpacing: '.16em', flex: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: a.color, flex: 'none' }} />
            {a.name}
          </span>
          {(() => {
            // WHICH TOOL RAN THIS.
            const tb = toolBadge(s.driver);
            return tb ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${tb.color}3a`, background: `${tb.color}12`, color: tb.color, borderRadius: 99, padding: '3px 8px', fontSize: 7.5, letterSpacing: '.16em', flex: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}>
                {tb.label}
              </span>
            ) : null;
          })()}
          {(() => {
            const mc = modelChipText(s.model, s.driver);
            return mc ? (
              <span style={{ fontSize: 7.5, letterSpacing: '.1em', color: COLORS.textDim, border: `1px solid ${withAlpha(COLORS.line, 0.18)}`, borderRadius: 99, padding: '3px 8px', flex: 'none', whiteSpace: 'nowrap' }}>{mc}</span>
            ) : null;
          })()}
          {s.effort && (
            <span style={{ fontSize: 7.5, letterSpacing: '.08em', color: COLORS.textDim, flex: 'none', whiteSpace: 'nowrap' }}>
              {({ low: '▮▯▯ LOW', medium: '▮▮▯ MED', high: '▮▮▮ HIGH', xhigh: '▮▮▮▮ XHIGH', max: '▮▮▮▮▮ MAX' } as Record<string, string>)[s.effort.toLowerCase()] ?? s.effort.toUpperCase()}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 7.5, letterSpacing: '.16em', color: stw[1], flex: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}>{stw[0]}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 9, minWidth: 0 }}>
          <span style={{ fontSize: 9, color: COLORS.textFaintBlue, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '.02em' }}>{peek}</span>
          {s.status === 'working' && <span style={{ display: 'inline-block', color: a.color, marginLeft: 2, fontSize: 9, animation: 'fdCaret 1.1s step-end infinite' }}>▍</span>}
        </div>
        {s.groupLabel && <div className="fd-session-folder" title={s.cwd ?? undefined}>
          {s.groupLabel} / {s.owner === 'praxis' ? s.cwd?.split(/[\\/]/).filter(Boolean).pop() : s.cwd}
        </div>}
        {coll && (
          <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Coordinate shared lane for ${s.name}`}
            style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9, border: `1px solid ${withAlpha(COLORS.red, 0.38)}`, background: withAlpha(COLORS.red, 0.07), borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              openDock('lane', s.laneId, { keep: true, tab: 'msg' });
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: RED, flex: 'none', animation: 'fdRed 1.5s ease-in-out infinite' }} />
            <span style={{ fontSize: 8, color: COLORS.redText, letterSpacing: '.04em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ⚠ SHARED LANE — {lane?.letter} · {repo?.name} — WITH {others[0]?.name ?? ''}
            </span>
            <span style={{ fontSize: 7, color: RED, letterSpacing: '.16em', flex: 'none', fontWeight: 700 }}>COORDINATE ▸</span>
          </div>
        )}
        {s.status === 'blocked' && s.wants && !coll && (
          <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Check pending tool for ${s.name}`}
            style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9, border: `1px solid ${withAlpha(COLORS.statusPending, 0.38)}`, background: withAlpha(COLORS.statusPending, 0.07), borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              openDock('session', s.id, { keep: true });
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.statusPending, flex: 'none', animation: 'fdPulse 1.1s ease-in-out infinite' }} />
            <span style={{ fontSize: 8, color: COLORS.statusPendingText, letterSpacing: '.02em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ⏸ TOOL PENDING — {s.wants} — running long or awaiting approval
            </span>
            <span style={{ fontSize: 7, color: COLORS.statusPending, letterSpacing: '.16em', flex: 'none', fontWeight: 700 }}>CHECK ▸</span>
          </div>
        )}
        <div className="fd-hover-actions" style={{ position: 'absolute', top: 8, right: 11, display: 'flex', gap: 5, opacity: m ? 1 : 0, pointerEvents: m ? 'auto' : 'none', transition: 'opacity .18s', zIndex: 2 }}>
          {canStop ? (
            <button type="button" aria-label={`Stop session ${s.name}`} className="fd-control"
              style={actRed}
              onClick={(e) => {
                e.stopPropagation();
                doStop(s);
              }}
            >
              ■ STOP
            </button>
          ) : (
            <button type="button" aria-label={`Open console for ${s.name}`} className="fd-control"
              style={actBase}
              onClick={(e) => {
                e.stopPropagation();
                openDock('session', s.id, { keep: true });
              }}
            >
              ◫ CONSOLE
            </button>
          )}
        </div>
      </div>
    );
  };

  // ── lane + repo column ──
  const renderGroup = (r: (typeof model.repos)[number]) => {
    const rm = Boolean(th.r[r.id]);
    const rlanes = model.lanes.filter((l) => l.repoId === r.id);
    return (
      <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '252px 1fr', columnGap: 40, alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 6px 2px' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.hue, boxShadow: `0 0 9px ${r.hue}88`, flex: 'none' }} />
            <span style={{ fontSize: 7, letterSpacing: '.22em', color: COLORS.textFainter, whiteSpace: 'nowrap' }}>
              {r.name.toUpperCase()} · {rlanes.length}
              {rlanes.length === 1 ? ' LANE' : ' LANES'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rlanes.map((l) => {
              const occ = byLane[l.id] ?? [];
              const coll = Boolean(collLanes[l.id]);
              const lm = Boolean(th.l[l.id]);
              const vaultN = vault.counts[`lane:${l.id}`] ?? 0;
              const rh = r.hue;
              const laneLive = occ.some((x) => x.status === 'working' || x.status === 'blocked');
              const laneRO = isLaneReadOnly(l.id);
              const laneAutoRO = Boolean(l.autoReadOnly);
              return (
                <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Open ${r.name} ${l.letter} console`}
                  key={l.id}
                  data-anchor={`lane:${l.id}`}
                  style={{
                    position: 'relative',
                    border: `1px solid ${coll ? withAlpha(COLORS.red, 0.55) : lm ? `${rh}8c` : `${rh}30`}`,
                    borderRadius: 10,
                    background: `linear-gradient(135deg, ${rh}14, rgba(12,16,30,.72) 52%)`,
                    padding: '8px 11px',
                    cursor: 'pointer',
                    opacity: nodeOp(lm),
                    transition: 'opacity .25s, border-color .25s, box-shadow .25s',
                    boxShadow: coll ? `0 0 0 1px ${withAlpha(COLORS.red, 0.14)}, 0 0 24px ${withAlpha(COLORS.red, 0.08)}` : lm ? `0 0 0 1px ${rh}2b, 0 8px 26px ${withAlpha(COLORS.black, 0.35)}` : 'none',
                  }}
                  onMouseEnter={() => setFocus({ type: 'lane', id: l.id })}
                  onMouseLeave={() => setFocus(null)}
                  onClick={() => openDock('lane', l.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 6,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 9.5,
                        fontWeight: 800,
                        color: COLORS.ink,
                        background: coll ? `linear-gradient(145deg,${COLORS.redText},${COLORS.redDeep})` : `linear-gradient(145deg,${rh},${rh}7a)`,
                        boxShadow: `0 0 12px ${coll ? withAlpha(COLORS.red, 0.55) : `${rh}55`}`,
                        flex: 'none',
                      }}
                    >
                      {l.letter.replace('LANE ', '').slice(0, 2)}
                    </span>
                    <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.18em', color: coll ? COLORS.redText : COLORS.textIce, flex: 'none', whiteSpace: 'nowrap' }}>{l.letter}</span>
                    {coll && (
                      <span style={{ fontSize: 6.5, letterSpacing: '.12em', color: COLORS.redText, border: `1px solid ${withAlpha(COLORS.red, 0.45)}`, borderRadius: 99, padding: '2px 6px', flex: 'none', animation: 'fdRed 1.6s ease-in-out infinite' }}>
                        {(collLanes[l.id] ?? []).length} WRITERS
                      </span>
                    )}
                    {laneRO && (
                      <span
                        title={laneAutoRO ? 'background lane — auto read-only' : 'lane locked — read-only'}
                        style={{ fontSize: 6.5, letterSpacing: '.12em', color: COLORS.accentLilac, border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, background: withAlpha(COLORS.accent, 0.08), borderRadius: 99, padding: '2px 6px', flex: 'none', whiteSpace: 'nowrap' }}
                      >
                        🔒 {laneAutoRO ? 'AUTO' : 'LOCKED'}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    {occ.map((o) => {
                      const oc = AGENT_META[o.agent].color;
                      const ds: React.CSSProperties = { width: 6, height: 6, borderRadius: '50%', background: oc, flex: 'none', marginLeft: 3 };
                      if (o.status === 'working') ds.animation = 'fdPulse 2.4s ease-in-out infinite';
                      if (o.status === 'done') ds.opacity = 0.35;
                      if (o.status === 'idle') ds.opacity = 0.5;
                      if (coll && (o.status === 'working' || o.status === 'blocked')) ds.boxShadow = `0 0 0 1.5px ${withAlpha(COLORS.red, 0.65)}`;
                      return <span key={o.id} style={ds} />;
                    })}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <span style={{ fontSize: 7.5, color: COLORS.textFainter, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{l.branch ? `⎇ ${l.branch} · ` : ''}{l.wt}</span>
                    {laneDiffLabel(l.diff) && (
                      <span style={{ fontSize: 7, letterSpacing: '.04em', color: COLORS.textFaintBlue, flex: 'none', whiteSpace: 'nowrap' }} title="lines changed vs base · commits ahead">
                        {laneDiffLabel(l.diff)}
                      </span>
                    )}
                    <button type="button" aria-label={`Open ${r.name} ${l.letter} prompt vault (${vaultN})`} className="fd-control"
                      style={{ fontSize: 7.5, letterSpacing: '.08em', color: vaultN > 0 ? COLORS.accentBright : COLORS.textFaint, border: `1px solid rgba(177,149,255,${vaultN > 0 ? '.4' : '.15'})`, borderRadius: 6, padding: '2px 7px', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDock('lane', l.id, { keep: true, tab: 'vault' });
                      }}
                    >
                      ▣ {vaultN}
                    </button>
                  </div>
                  <div style={{ position: 'absolute', left: 11, right: 11, bottom: 0, height: 2, borderRadius: 2, overflow: 'hidden', opacity: laneLive ? 0.9 : 0, transition: 'opacity .3s' }}>
                    <div style={{ height: '100%', width: '100%', background: `repeating-linear-gradient(90deg, transparent 0 6px, ${coll ? RED : rh}cc 6px 14px)`, animation: laneLive ? 'fdFlowX 1.1s linear infinite' : 'none' }} />
                  </div>
                  <div className="fd-hover-actions" style={{ position: 'absolute', top: -12, right: 8, display: 'flex', gap: 5, opacity: lm ? 1 : 0, pointerEvents: lm ? 'auto' : 'none', transition: 'opacity .2s', zIndex: 3 }}>
                    <button type="button" aria-label={`Spawn session in ${r.name} ${l.letter}`}
                      className="fd-control fd-hov-btn"
                      title={laneRO ? 'lane locked — unlock to spawn' : 'spawn a session into this lane'}
                      style={{ border: `1px solid ${withAlpha(COLORS.line, 0.35)}`, background: 'rgba(8,11,20,.97)', borderRadius: 6, padding: '3px 8px', cursor: laneRO ? 'not-allowed' : 'pointer', fontSize: 7, letterSpacing: '.12em', color: laneRO ? COLORS.textFaint : COLORS.textStrong, opacity: laneRO ? 0.5 : 1 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (laneRO) {
                          say(`🔒 ${l.letter} IS LOCKED — UNLOCK TO SPAWN`);
                          return;
                        }
                        openSpawn(l.id, e);
                      }}
                    >
                      ⊕ SPAWN
                    </button>
                    <button type="button" aria-label={`Broadcast to ${r.name} ${l.letter}`}
                      className="fd-control fd-hov-btn"
                      title={laneRO ? 'lane locked — unlock to cast' : 'broadcast to every session in this lane'}
                      style={{ border: `1px solid ${withAlpha(COLORS.line, 0.35)}`, background: 'rgba(8,11,20,.97)', borderRadius: 6, padding: '3px 8px', cursor: laneRO ? 'not-allowed' : 'pointer', fontSize: 7, letterSpacing: '.12em', color: laneRO ? COLORS.textFaint : COLORS.textStrong, opacity: laneRO ? 0.5 : 1 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (laneRO) {
                          say(`🔒 ${l.letter} IS LOCKED — UNLOCK TO CAST`);
                          return;
                        }
                        openDock('lane', l.id, { keep: true, tab: 'msg' });
                      }}
                    >
                      ⇶ CAST
                    </button>
                    <button type="button" aria-label={`Lock ${r.name} ${l.letter}`} aria-pressed={laneRO} aria-disabled={laneAutoRO}
                      className="fd-control fd-hov-btn"
                      title={
                        laneAutoRO
                          ? 'background lane — auto read-only, cannot unlock'
                          : laneRO
                            ? 'unlock this lane — allow spawn/cast/fire'
                            : 'lock this lane read-only — block spawn/cast/fire'
                      }
                      style={{
                        border: `1px solid ${laneRO ? withAlpha(COLORS.accent, 0.5) : withAlpha(COLORS.line, 0.35)}`,
                        background: laneRO ? withAlpha(COLORS.accent, 0.14) : 'rgba(8,11,20,.97)',
                        borderRadius: 6,
                        padding: '3px 8px',
                        cursor: laneAutoRO ? 'not-allowed' : 'pointer',
                        fontSize: 7,
                        letterSpacing: '.12em',
                        color: laneAutoRO ? COLORS.textFaint : laneRO ? COLORS.accentBright : COLORS.textStrong,
                        opacity: laneAutoRO ? 0.5 : 1,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleLaneLock(l.id);
                      }}
                    >
                      {laneRO ? '🔒 LOCKED' : '🔓 LOCK'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Open ${r.name} repository console`}
          data-anchor={`repo:${r.id}`}
          style={{
            border: `1px solid ${rm ? `${r.hue}8c` : `${r.hue}30`}`,
            borderRadius: 12,
            background: `linear-gradient(135deg, ${r.hue}12, rgba(12,16,30,.75) 55%)`,
            padding: '11px 13px',
            opacity: nodeOp(rm),
            transition: 'opacity .25s, border-color .25s, box-shadow .25s',
            boxShadow: rm ? `0 0 0 1px ${r.hue}2b, 0 10px 28px ${withAlpha(COLORS.black, 0.35)}` : 'none',
            minWidth: 0,
            cursor: 'pointer',
          }}
          onMouseEnter={() => setFocus({ type: 'repo', id: r.id })}
          onMouseLeave={() => setFocus(null)}
          onClick={() => openDock('repo', r.id)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <span style={{ width: 26, height: 26, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: COLORS.ink, background: `linear-gradient(145deg, ${r.hue}, ${r.hue}7a)`, boxShadow: `0 0 16px ${r.hue}4d`, flex: 'none' }}>⎇</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: COLORS.textBright, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{r.name}</div>
              <div style={{ fontSize: 6.5, letterSpacing: '.12em', color: COLORS.textFainter, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.mainLine}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
            {rlanes.map((l2) => (
              <span
                key={l2.id}
                style={{
                  width: 16,
                  height: 4,
                  borderRadius: 2,
                  background: collLanes[l2.id] ? RED : r.hue,
                  opacity: collLanes[l2.id] ? 1 : (byLane[l2.id] ?? []).some((x) => x.status === 'working' || x.status === 'blocked') ? 0.9 : 0.3,
                  flex: 'none',
                  boxShadow: collLanes[l2.id] ? `0 0 8px ${withAlpha(COLORS.red, 0.6)}` : 'none',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ── filters ──
  const filterDefs: Array<[typeof filter, string]> = [
    ['all', 'ALL'],
    ['praxis', 'PRAXIS'],
    ['mine', 'MINE'],
    ['alert', `⚠ ${alertN}`],
  ];

  const D = dock ?? dockGhost;

  const panelBase = (open: boolean): React.CSSProperties => ({
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    height: panelH,
    // Open panel sits above the closed one and only it takes pointer events, so the
    // two bottom pull-ups are cleanly mutually exclusive - the hidden panel (parked
    // at translateY(105%)) can never intercept or bleed into the visible one.
    zIndex: open ? 46 : 44,
    pointerEvents: open ? 'auto' : 'none',
    transform: open ? 'translateY(0)' : 'translateY(105%)',
    transition: panelDrag ? 'none' : 'transform .6s cubic-bezier(.16,1,.3,1)',
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(6,8,16,.97)',
    borderTop: `1px solid ${withAlpha(COLORS.accent, 0.3)}`,
    borderRadius: '18px 18px 0 0',
    boxShadow: `0 -40px 120px ${withAlpha(COLORS.black, 0.7)}`,
  });

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: COLORS.bg }}>
      <div
        data-anchor="canvas"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: CW,
          height: CH,
          transformOrigin: '0 0',
          transform: `translate(${fit.ox}px,${fit.oy}px) scale(${fit.k})`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          userSelect: 'none',
          color: COLORS.text,
          fontFamily: "'JetBrains Mono',ui-monospace,monospace",
          background:
            `radial-gradient(1100px 700px at 10% -8%, rgba(96,72,190,.16), transparent 62%),radial-gradient(900px 640px at 92% -6%, rgba(46,130,168,.11), transparent 60%),radial-gradient(1300px 900px at 50% 118%, rgba(70,54,160,.12), transparent 58%),linear-gradient(180deg,${COLORS.bgGradTop} 0%,${COLORS.bgGradBottom} 100%)`,
        }}
      >
        {/* header */}
        <div style={{ height: 58, flex: 'none', display: 'flex', alignItems: 'center', gap: 22, padding: '0 22px', borderBottom: `1px solid ${withAlpha(COLORS.line, 0.09)}`, position: 'relative', zIndex: 30 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontWeight: 500, fontSize: 21, color: COLORS.textBright }}>Flight Deck</span>
            <span style={{ fontSize: 7.5, letterSpacing: '.26em', color: COLORS.textFainter }}>{version ? `PRAXIS V${version} · DELEGATION FLOW` : 'PRAXIS · DELEGATION FLOW'}</span>
          </div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginLeft: 6 }}>
            {NAV_TABS.map((t) => (
              <button type="button" aria-label={t.label} disabled={!t.cmd}
                key={t.label}
                className={`fd-control ${t.cmd ? 'fd-hov-line' : ''}`}
                style={t.cmd
                  ? { fontSize: 8.5, letterSpacing: '.22em', color: COLORS.textFainter, cursor: 'pointer', whiteSpace: 'nowrap' }
                  : { fontSize: 8.5, letterSpacing: '.22em', color: COLORS.accentBright, borderBottom: `1px solid ${withAlpha(COLORS.accent, 0.6)}`, paddingBottom: 3, whiteSpace: 'nowrap' }}
                onClick={t.cmd ? () => navWindow(t.cmd!, t.label) : undefined}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span style={{ width: 1, height: 14, background: withAlpha(COLORS.line, 0.15) }} />
          <button type="button" aria-label="Search vault"
            className="fd-control fd-hov-line"
            title="search every saved prompt across the fleet"
            onClick={() => setVaultSearchOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 8.5, letterSpacing: '.2em', color: COLORS.textFainter, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <span style={{ fontSize: 11, lineHeight: 1 }}>⌕</span> SEARCH VAULT
          </button>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.statusWorking, boxShadow: `0 0 8px ${withAlpha(COLORS.statusWorking, 0.8)}` }} />
              <span style={{ fontSize: 8, letterSpacing: '.14em', color: COLORS.textMuted, whiteSpace: 'nowrap' }}>{workingN} LIVE</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.statusPending }} />
              <span style={{ fontSize: 8, letterSpacing: '.14em', color: COLORS.textMuted, whiteSpace: 'nowrap' }}>{blockedN} PENDING</span>
            </span>
            <span style={{ display: collLaneN > 0 ? 'flex' : 'none', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: RED, animation: 'fdRed 1.4s ease-in-out infinite' }} />
              <span style={{ fontSize: 8, letterSpacing: '.14em', color: COLORS.redText, whiteSpace: 'nowrap' }}>{collLaneN} COLLISION</span>
            </span>
          </div>
          <span style={{ width: 1, height: 16, background: withAlpha(COLORS.line, 0.15) }} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, letterSpacing: '.08em', color: COLORS.textStrong }}>{fmtClock(now)}</div>
            <div style={{ fontSize: 7, letterSpacing: '.22em', color: COLORS.textFainter, marginTop: 1 }}>{fmtDate(now)}</div>
          </div>
          <button
            type="button"
            disabled={reloadPhase === 'loading'}
            aria-live="polite"
            onClick={() => {
              void reloadDeck();
            }}
            style={{
              fontSize: 8,
              letterSpacing: '.2em',
              padding: '7px 14px',
              borderRadius: 8,
              cursor: reloadPhase === 'loading' ? 'wait' : 'pointer',
              fontWeight: 700,
              whiteSpace: 'nowrap',
              border: `1px solid ${withAlpha(COLORS.line, 0.34)}`,
              color: reloadPhase === 'done' ? COLORS.accentBright : COLORS.textMuted,
              background: reloadPhase === 'loading' ? withAlpha(COLORS.accent, 0.1) : 'transparent',
              opacity: reloadPhase === 'loading' ? 0.7 : 1,
              transition: 'all .2s',
            }}
          >
            {reloadPhase === 'loading'
              ? 'RELOADING…'
              : reloadPhase === 'done' && reloadStamp
                ? reloadStamp
                : 'RELOAD'}
          </button>
          {reloadErr && (
            <span role="alert" style={{ fontSize: 7.5, letterSpacing: '.14em', color: COLORS.statusPending }}>{reloadErr}</span>
          )}
          <button type="button" aria-label={haltArmed ? "Confirm halt all" : halted ? "Resume fleet" : "Halt all"} aria-pressed={halted} className="fd-control"
            style={{
              fontSize: 8,
              letterSpacing: '.2em',
              padding: '7px 14px',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 700,
              whiteSpace: 'nowrap',
              border: `1px solid ${withAlpha(COLORS.red, 0.5)}`,
              color: haltArmed ? COLORS.ink : COLORS.redText,
              background: haltArmed ? RED : halted ? withAlpha(COLORS.red, 0.18) : 'transparent',
              transition: 'all .2s',
            }}
            onClick={haltAll}
          >
            {haltArmed ? 'CONFIRM HALT?' : halted ? 'HALTED — RESUME?' : 'HALT ALL'}
          </button>
        </div>

        {/* stage */}
        <div data-anchor="stage" style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <div style={{ position: 'absolute', inset: 0, backgroundImage: `radial-gradient(circle, ${withAlpha(COLORS.line, 0.05)} 1px, transparent 1.4px)`, backgroundSize: '26px 26px', pointerEvents: 'none' }} />
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1, overflow: 'visible' }}>
            {styledPaths.map((p) => (
              <g
                key={p.key}
                ref={(el) => {
                  // Registry for the scroll-smooth fast path: measure() writes new
                  // `d`s onto these nodes directly while scrolling (no re-render).
                  if (el) pathEls.current.set(p.key, el);
                  else pathEls.current.delete(p.key);
                }}
              >
                <path d={p.d} fill="none" style={p.glow} />
                <path d={p.d} fill="none" style={p.main} />
                {p.flow && <path d={p.d} fill="none" style={p.flow} />}
              </g>
            ))}
          </svg>
          <div style={{ position: 'relative', zIndex: 2, height: '100%', display: 'grid', gridTemplateColumns: '150px 220px minmax(430px,1fr) 448px', columnGap: 40, padding: '10px 24px 8px 18px' }}>
            {/* ORIGIN */}
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ height: 24, flex: 'none', fontSize: 8, letterSpacing: '.28em', color: COLORS.textFainter, display: 'flex', alignItems: 'center' }}>ORIGIN</div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, minHeight: 0 }}>
                <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label="Open Praxis console" data-anchor="praxis" onClick={() => openDock('praxis', 'praxis')} style={{ position: 'relative', width: 104, height: 104, flex: 'none', cursor: 'pointer' }}>
                  <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `1px dashed ${withAlpha(COLORS.accent, 0.35)}`, animation: 'fdSpin 26s linear infinite' }} />
                  <div style={{ position: 'absolute', inset: 9, borderRadius: '50%', border: `1px solid ${withAlpha(COLORS.accent, 0.14)}` }} />
                  <div style={{ position: 'absolute', inset: 14, borderRadius: '50%', background: 'radial-gradient(circle, rgba(140,150,255,.5), rgba(96,72,190,.2) 55%, rgba(96,72,190,0) 76%)', filter: 'blur(7px)', animation: 'fdCore 3.4s ease-in-out infinite' }} />
                  <div style={{ position: 'absolute', inset: 7, borderRadius: '50%', boxShadow: '0 0 44px rgba(122,146,255,.38), 0 0 100px rgba(90,60,190,.26)', animation: 'fdCore 4.2s ease-in-out infinite' }}>
                    <img src={coreImg} alt="" style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', borderRadius: '50%', animation: 'fdSpin 90s linear infinite', pointerEvents: 'none' }} />
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.3em', color: COLORS.text }}>PRAXIS</div>
                  <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 12.5, color: COLORS.textMuted, marginTop: 4 }}>the orchestrator</div>
                  <div style={{ fontSize: 7.5, letterSpacing: '.18em', color: COLORS.accent, marginTop: 9 }}>● {routedN} ROUTED · {workingN} FIRING</div>
                  <div style={{ fontSize: 7, letterSpacing: '.18em', color: COLORS.textFainter, marginTop: 4 }}>{TRUST_LINE[autonomy]}</div>
                </div>
              </div>
            </div>

            {/* AGENTS */}
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ height: 24, flex: 'none', fontSize: 8, letterSpacing: '.28em', color: COLORS.textFainter, display: 'flex', alignItems: 'center', gap: 8 }}>
                AGENTS <span style={{ color: COLORS.accent, letterSpacing: '.1em' }}>4</span>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-evenly', minHeight: 0, padding: '4px 0' }}>
                {DECK_AGENTS.slice(0, 3).map(renderAgent)}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px' }}>
                  <span style={{ flex: 1, height: 1, background: withAlpha(COLORS.line, 0.12) }} />
                  <span style={{ fontSize: 6.5, letterSpacing: '.26em', color: COLORS.textFaintest }}>MANUAL</span>
                  <span style={{ flex: 1, height: 1, background: withAlpha(COLORS.line, 0.12) }} />
                </div>
                {renderAgent(DECK_AGENTS[3])}
              </div>
            </div>

            {/* SESSIONS (scrollable middle) */}
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
              <div style={{ height: 24, flex: 'none', display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px' }}>
                {/* The header names the rule the list is actually filtered by. It
                    used to read "UNARCHIVED", which stopped being true when the
                    ACTIVE WINDOW replaced the archive-only rule. */}
                <span style={{ fontSize: 8, letterSpacing: '.28em', color: COLORS.textFainter }}>
                  SESSIONS · {model.activeCount} ACTIVE · {model.runningCount} RUNNING · {activeWindowLabel(model.activeWindowMs)}
                </span>
                <span
                  style={{ fontSize: 8, letterSpacing: '.1em', color: COLORS.accent, whiteSpace: 'nowrap' }}
                  title={hiddenN > 0 ? `${hiddenN} more unarchived session${hiddenN === 1 ? '' : 's'} beyond the per-lane card cap — archive sessions to clear them` : undefined}
                >
                  {filter !== 'all' ? `\u00b7 ${vis.length} MATCHING` : ''}
                  {hiddenN > 0 ? ` · +${hiddenN} MORE` : ''}
                </span>
                <span style={{ flex: 1 }} />
                {filterDefs.map(([k, label]) => (
                  <button type="button" aria-label={k === 'alert' ? `Alerts (${alertN})` : label} aria-pressed={filter === k} className="fd-control"
                    key={k}
                    style={{
                      fontSize: 7.5,
                      letterSpacing: '.16em',
                      padding: '4px 9px',
                      borderRadius: 99,
                      cursor: 'pointer',
                      flex: 'none',
                      whiteSpace: 'nowrap',
                      color: filter === k ? COLORS.accentBright : COLORS.textFaint,
                      border: `1px solid ${filter === k ? withAlpha(COLORS.accent, 0.4) : withAlpha(COLORS.line, 0.14)}`,
                      background: filter === k ? withAlpha(COLORS.accent, 0.12) : 'transparent',
                      transition: 'all .2s',
                    }}
                    onClick={() => setFilter(k)}
                  >
                    {label}
                  </button>
                ))}
                <span style={{ width: 1, height: 11, background: withAlpha(COLORS.line, 0.16), margin: '0 2px' }} />
                <button type="button" aria-label="Spawn a session" className="fd-control fd-hov-btn" style={{ fontSize: 7.5, letterSpacing: '.16em', color: COLORS.textStrong, border: `1px solid ${withAlpha(COLORS.line, 0.3)}`, borderRadius: 99, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={(e) => openSpawn(null, e)}>
                  ⊕ SPAWN
                </button>
              </div>
              <div style={{ position: 'relative', flex: 1, minHeight: 0, marginTop: 6 }}>
                <CollectorChip side="top" register={regChipTop} />
                <div data-anchor="sessions-scroll" data-scroll="1" onScroll={scheduleMeasure} style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '8px 8px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {vis.length === 0 && (
                    <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 13, color: COLORS.textFaint, textAlign: 'center', padding: '40px 0' }}>
                      {deck.loading
                        ? 'reading the fleet — first scan of a fresh boot can take a moment…'
                        : 'no active sessions — spawn one into a lane, or fire from a vault'}
                    </div>
                  )}
                  {(['zach', 'praxis', 'automation'] as const).map((owner) => {
                    const cards = vis.filter((s) => s.owner === owner);
                    if (!cards.length) return null;
                    return <React.Fragment key={owner}>
                      <span className="fd-session-group">{owner === 'praxis' ? 'Praxis at work' : owner === 'automation' ? 'Automations' : 'Your sessions'}</span>
                      {cards.map(renderSession)}
                    </React.Fragment>;
                  })}
                </div>
                <CollectorChip side="bottom" register={regChipBottom} />
              </div>
            </div>

            {/* LANES + REPOS */}
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ height: 24, flex: 'none', display: 'grid', gridTemplateColumns: '252px 1fr', columnGap: 40, alignItems: 'center' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 8, letterSpacing: '.28em', color: COLORS.textFainter }}>LANES · WORKTREES</span>
                  <span className="fd-lane-help">
                    <button
                      type="button"
                      className="fd-control fd-lane-help-btn"
                      aria-label="What's the difference between a code lane and MAIN?"
                      aria-describedby="fd-lane-help-pop"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 13,
                        height: 13,
                        borderRadius: '50%',
                        border: `1px solid ${withAlpha(COLORS.line, 0.32)}`,
                        color: COLORS.textFainter,
                        fontSize: 8,
                        lineHeight: 1,
                        cursor: 'help',
                      }}
                    >
                      ?
                    </button>
                    <span
                      id="fd-lane-help-pop"
                      role="tooltip"
                      className="fd-lane-help-pop"
                      style={{
                        width: 248,
                        padding: '10px 12px',
                        borderRadius: 9,
                        border: `1px solid ${withAlpha(COLORS.line, 0.22)}`,
                        background: 'rgba(8,11,20,.97)',
                        boxShadow: '0 10px 34px rgba(0,0,0,.6)',
                        fontFamily: "'Newsreader',Georgia,serif",
                        fontStyle: 'italic',
                        fontSize: 11,
                        lineHeight: 1.55,
                        color: COLORS.textMuted,
                      }}
                    >
                      A code lane is a git worktree: its own folder (praxis-lanes/lane-a…e) checked out on its own branch, so agents can work in parallel without touching MAIN. MAIN is the repo's primary checkout.
                    </span>
                  </span>
                </span>
                <span style={{ fontSize: 8, letterSpacing: '.28em', color: COLORS.textFainter }}>REPOS</span>
              </div>
              <div data-anchor="lanes-scroll" data-scroll="1" onScroll={scheduleMeasure} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: model.repos.length > 5 ? 'flex-start' : 'space-evenly', gap: model.repos.length > 5 ? 14 : 0, minHeight: 0, padding: '4px 0', overflowY: 'auto' }}>
                {model.repos.map(renderGroup)}
              </div>
            </div>
          </div>
        </div>

        {/* bottom bar */}
        <div style={{ height: 46, flex: 'none', display: 'flex', alignItems: 'center', gap: 16, padding: '0 22px', borderTop: `1px solid ${withAlpha(COLORS.line, 0.09)}`, background: 'rgba(4,6,13,.72)', position: 'relative', zIndex: 30 }}>
          <span style={{ fontSize: 7.5, letterSpacing: '.16em', color: COLORS.textFaintest }}>
            TOPOLOGY — LIVE FROM WORKTREES · SNAPSHOT {fmtTime(model.generatedAt)}{deck.online ? '' : ' · OFFLINE'}
          </span>

          {/* ACTIVE WINDOW - the deck's visibility rule, made visible. Everything it filters out is COUNTED
   here rather than silently dropped, and the window itself is a real control: the value round-trips
   through fd_set_active_window → vault → next snapshot. */}
          <div style={{ position: 'relative' }}>
            <span role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Active session window: ${activeWindowLabel(model.activeWindowMs)}`} aria-expanded={windowMenu}
              title="How far back a session still counts as active. Running sessions are always shown."
              onClick={() => setWindowMenu((v) => !v)}
              style={{ fontSize: 7.5, letterSpacing: '.18em', padding: '5px 10px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${withAlpha(COLORS.line, windowMenu ? 0.34 : 0.18)}`, color: windowMenu ? COLORS.accentBright : COLORS.textDim, background: windowMenu ? withAlpha(COLORS.accent, 0.1) : 'transparent', transition: 'all .18s' }}
            >
              ACTIVE · {activeWindowLabel(model.activeWindowMs)}
              {hiddenTotal > 0 && <span style={{ color: COLORS.textFaintest }}> · +{hiddenTotal} HIDDEN</span>}
              <span style={{ color: COLORS.textFaintest }}> ▾</span>
            </span>
            {windowMenu && (
              <div style={{ position: 'absolute', bottom: 30, left: 0, minWidth: 188, padding: 6, borderRadius: 9, border: `1px solid ${withAlpha(COLORS.line, 0.22)}`, background: 'rgba(8,11,20,.97)', boxShadow: '0 10px 34px rgba(0,0,0,.6)', zIndex: 60 }}>
                {ACTIVE_WINDOW_OPTIONS.map((o) => (
                  <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={o.label === 'ALL' ? 'All sessions — no time filter' : `Last ${o.label}`} aria-pressed={o.ms === model.activeWindowMs}
                    key={o.label}
                    onClick={() => {
                      setWindowMenu(false);
                      setActiveWindow(o.ms)
                        .then(() => {
                          deck.refresh();
                          say(`ACTIVE WINDOW · ${o.label}`);
                        })
                        .catch(() => say('COULD NOT CHANGE WINDOW — BACKEND OFFLINE'));
                    }}
                    style={{ fontSize: 7.5, letterSpacing: '.18em', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', color: o.ms === model.activeWindowMs ? COLORS.accentBright : COLORS.textDim, background: o.ms === model.activeWindowMs ? withAlpha(COLORS.accent, 0.12) : 'transparent' }}
                  >
                    {o.ms === model.activeWindowMs ? '● ' : '　'}{o.label === 'ALL' ? 'ALL — NO TIME FILTER' : `LAST ${o.label}`}
                  </div>
                ))}
                <div style={{ fontSize: 7, letterSpacing: '.12em', color: COLORS.textFaintest, padding: '7px 10px 3px', lineHeight: 1.7, borderTop: `1px solid ${withAlpha(COLORS.line, 0.12)}`, marginTop: 4 }}>
                  YOUR CLAUDE SIDEBAR + CODEX/CURSOR WINDOW; RUNNING TURNS STAY VISIBLE
                  {model.hiddenOlder > 0 && <><br />{model.hiddenOlder} OLDER THAN WINDOW</>}
                  {model.hiddenAccounts.map((a) => (
                    <Fragment key={a.email}>
                      <br />
                      {a.count} ON {a.email.toUpperCase()}
                    </Fragment>
                  ))}
                  {model.hiddenAccounts.length === 0 && model.hiddenOtherAccount > 0 && (
                    <><br />{model.hiddenOtherAccount} ON A SIGNED-OUT ACCOUNT</>
                  )}
                  <br />{model.hiddenPraxis} PRAXIS RUNS HIDDEN
                  <br />{model.hiddenAutomation} AUTOMATIONS HIDDEN
                  <br />{model.hiddenPlaceholders} PLACEHOLDERS HIDDEN
                  {model.hiddenSubagents > 0 && <><br />{model.hiddenSubagents} SUBAGENTS HIDDEN</>}
                  {model.hiddenProbes > 0 && <><br />{model.hiddenProbes} PROBE RUNS HIDDEN</>}
                </div>
              </div>
            )}
          </div>

          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 11.5, color: COLORS.textFaint }}>hover to trace — click any node, its console slides out</span>
          <span style={{ fontSize: 7.5, letterSpacing: '.18em', color: workingN > 0 ? COLORS.statusWorking : COLORS.textIdle }}>
            ● {workingN > 0 ? `EXECUTING · ${workingN} FIRING` : 'OBSERVING'}
          </span>
          {/* Panel toggles float ABOVE the scrim (z48 > scrim z40 > panels z45's
              closed sibling): while a panel is open the scrim overlays the bottom
              bar, so without this the toggles were unclickable and a tap on AGENT
              FLOW hit the scrim (which closes) - the deck "stayed on Code Lanes".
              Fixed positioning escapes the bottom bar's z30 stacking context. */}
          <div style={{ position: 'fixed', left: '50%', bottom: 0, transform: 'translateX(-50%)', height: 46, zIndex: 48, display: 'flex', alignItems: 'center', gap: 10, pointerEvents: 'auto' }}>
            <button type="button" aria-label="Code Lanes" aria-expanded={panel === 'lanes'} className="fd-control"
              style={{ fontSize: 7.5, letterSpacing: '.18em', padding: '6px 13px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${panel === 'lanes' ? withAlpha(COLORS.accent, 0.5) : withAlpha(COLORS.line, 0.22)}`, color: panel === 'lanes' ? COLORS.accentBright : COLORS.textDim, background: panel === 'lanes' ? withAlpha(COLORS.accent, 0.12) : 'rgba(10,13,24,.7)', transition: 'all .2s' }}
              onClick={() => {
                setPanel((p) => (p === 'lanes' ? null : 'lanes'));
                void deck.refreshTopology().catch((error: unknown) => setReloadErr(`TOPOLOGY REFRESH FAILED: ${String(error)}`));
              }}
            >
              ▲ CODE LANES
            </button>
            <button type="button" aria-label="Agent Flow" aria-expanded={panel === 'flow'} className="fd-control"
              style={{ fontSize: 7.5, letterSpacing: '.18em', padding: '6px 13px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${panel === 'flow' ? withAlpha(COLORS.accent, 0.5) : withAlpha(COLORS.line, 0.22)}`, color: panel === 'flow' ? COLORS.accentBright : COLORS.textDim, background: panel === 'flow' ? withAlpha(COLORS.accent, 0.12) : 'rgba(10,13,24,.7)', transition: 'all .2s' }}
              onClick={() => setPanel((p) => (p === 'flow' ? null : 'flow'))}
            >
              ▲ AGENT FLOW
            </button>
          </div>
        </div>

        {/* inspector dock */}
        <DeckDock
          D={D}
          open={Boolean(dock)}
          dockW={dockW}
          dockDrag={dockDrag}
          startDockDrag={startDockDrag}
          model={model}
          planNames={planNames}
          sessions={sessions}
          byLane={byLane}
          collLanes={collLanes}
          statusMap={statusMap}
          fleet={fleet}
          vault={vault}
          msgs={msgs}
          dockVal={dockVal}
          setDockVal={setDockVal}
          onSend={sendDock}
          onSave={saveDockToVault}
          onClose={closeDock}
          setDockTab={(tb) => setDock((d) => (d ? { ...d, tab: tb } : d))}
          setDockMode={(md) => setDock((d) => (d ? { ...d, mode: md } : d))}
          openDock={openDock}
          openSpawn={openSpawn}
          fireVault={fireVault}
          doStop={doStop}
          say={say}
          now={now}
          pidKnown={(id) => {
            const s = sessions.find((x) => x.id === id);
            return Boolean(s && pidFor(s));
          }}
          liveTail={dock?.type === 'session' ? liveTail : null}
          focusPv={dockFocus}
          isLaneReadOnly={isLaneReadOnly}
          toggleLaneLock={toggleLaneLock}
        />

        {/* global prompt-vault search overlay */}
        <DeckVaultSearch
          open={vaultSearchOpen}
          onClose={() => setVaultSearchOpen(false)}
          model={model}
          sessions={sessions}
          onPick={openFromSearch}
        />

        {/* spawn catcher + popover */}
        <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label="Close spawn menu" style={{ position: 'fixed', inset: 0, zIndex: 50, display: spawn ? 'block' : 'none', background: 'transparent' }} onClick={() => setSpawn(null)} />
        {spawn && (
          <div style={{ position: 'fixed', left: spawn.x * fit.k + fit.ox, top: spawn.y * fit.k + fit.oy, width: 316 * fit.k, zIndex: 51, border: `1px solid ${withAlpha(COLORS.accent, 0.35)}`, background: 'rgba(9,12,22,.98)', borderRadius: 14, padding: '14px 15px', boxShadow: `0 24px 70px ${withAlpha(COLORS.black, 0.6)}`, animation: 'fdRise .22s ease', transformOrigin: '0 0' }}>
            <div style={{ fontSize: 8, letterSpacing: '.2em', color: COLORS.textStrong }}>
              {spawn.lane ? `⊕ SPAWN — ${laneById[spawn.lane]?.letter} · ${repoById[laneById[spawn.lane]?.repoId ?? '']?.name ?? ''}` : '⊕ SPAWN A SESSION — PICK A LANE'}
            </div>
            <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 12, color: COLORS.textFaint, marginTop: 3 }}>a fresh session, straight into this worktree</div>
            {!spawn.lane && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10, maxHeight: 96, overflowY: 'auto' }} data-scroll="1">
                {model.lanes
                  .filter((l) => l.path && !isLaneReadOnly(l.id))
                  .map((l) => (
                    <button type="button" aria-label={`Spawn in ${repoById[l.repoId]?.name ?? ''} ${l.letter}`} aria-pressed={spawn.lane === l.id} className="fd-control"
                      key={l.id}
                      style={{ fontSize: 7.5, letterSpacing: '.12em', padding: '5px 9px', borderRadius: 8, cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap', color: COLORS.textDim, border: `1px solid ${withAlpha(COLORS.line, 0.2)}` }}
                      onClick={() => setSpawn((sp) => (sp ? { ...sp, lane: l.id } : sp))}
                    >
                      {(repoById[l.repoId]?.name ?? '').split('-')[0].toUpperCase()} · {l.letter.replace('LANE ', '')}
                    </button>
                  ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              {DECK_AGENTS.filter((a) => a.id !== 'you').map((a) => (
                <button type="button" aria-label={a.name} aria-pressed={spawn.agent === a.id} className="fd-control"
                  key={a.id}
                  style={{
                    fontSize: 7.5,
                    letterSpacing: '.12em',
                    padding: '5px 9px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    flex: 'none',
                    whiteSpace: 'nowrap',
                    color: spawn.agent === a.id ? a.color : COLORS.textDim,
                    border: `1px solid ${spawn.agent === a.id ? `${a.color}77` : withAlpha(COLORS.line, 0.2)}`,
                    background: spawn.agent === a.id ? `${a.color}14` : 'transparent',
                    fontWeight: spawn.agent === a.id ? 700 : 400,
                  }}
                  onClick={() => setSpawn((sp) => (sp ? { ...sp, agent: a.id } : sp))}
                >
                  {a.glyph} {a.name}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 7.5, color: COLORS.textFaint, letterSpacing: '.12em', marginTop: 11 }}>
              {`${getFleetSelection(spawn.agent)?.label ?? AGENT_META[spawn.agent].name} · VIA ${viaLabel(spawn.agent, planNames)}`}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              {EFFORTS.map((ef) => (
                <button type="button" aria-label={`Effort ${ef}`} aria-pressed={spawn.effort === ef} className="fd-control"
                  key={ef}
                  style={{
                    fontSize: 7.5,
                    letterSpacing: '.12em',
                    padding: '5px 9px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    flex: 'none',
                    whiteSpace: 'nowrap',
                    color: spawn.effort === ef ? COLORS.accentBright : COLORS.textDim,
                    border: `1px solid ${spawn.effort === ef ? withAlpha(COLORS.accent, 0.77) : withAlpha(COLORS.line, 0.2)}`,
                    background: spawn.effort === ef ? withAlpha(COLORS.accent, 0.14) : 'transparent',
                    fontWeight: spawn.effort === ef ? 700 : 400,
                  }}
                  onClick={() => setSpawn((sp) => (sp ? { ...sp, effort: ef } : sp))}
                >
                  {ef}
                </button>
              ))}
            </div>
            <textarea
              className="fd-focus-input"
              value={spawnPrompt}
              onChange={(e) => setSpawnPrompt(e.target.value)}
              placeholder="the task prompt — the session boots with exactly this"
              style={{ width: '100%', marginTop: 12, minHeight: 64, resize: 'vertical', background: withAlpha(COLORS.line, 0.06), border: `1px solid ${withAlpha(COLORS.line, 0.18)}`, borderRadius: 8, outline: 'none', color: COLORS.text, fontSize: 10, padding: '8px 10px', lineHeight: 1.6 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" aria-label="Spawn selected session" className="fd-control" style={{ fontSize: 8.5, letterSpacing: '.16em', color: COLORS.ink, background: COLORS.accent, borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 700 }} onClick={submitSpawn}>
                ▸ SPAWN
              </button>
            </div>
          </div>
        )}

        {/* scrim + panels */}
        <div role="button" tabIndex={panel ? 0 : -1} onKeyDown={activateDeckControl} aria-label="Close deck panel" aria-hidden={!panel} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(2,3,8,.55)', opacity: panel ? 1 : 0, pointerEvents: panel ? 'auto' : 'none', transition: 'opacity .4s' }} onClick={() => setPanel(null)} />
        <CodeLanesPanel style={panelBase(panel === 'lanes')} onDrag={startPanelDrag} onClose={() => setPanel(null)} model={model} byLane={byLane} collLanes={collLanes} onAddLane={doAddLane} />
        <AgentFlowPanel style={panelBase(panel === 'flow')} onDrag={startPanelDrag} onClose={() => setPanel(null)} model={model} collLanes={collLanes} coreImg={coreImg} trustLine={TRUST_LINE[autonomy]} planNames={planNames} />

        {/* toast */}
        {toast && (
          <div style={{ position: 'fixed', left: '50%', bottom: 104, transform: 'translateX(-50%)', zIndex: 70, border: `1px solid ${withAlpha(COLORS.accent, 0.35)}`, background: 'rgba(12,15,28,.97)', borderRadius: 10, padding: '9px 16px', fontSize: 9, letterSpacing: '.1em', color: COLORS.accentBright, boxShadow: `0 12px 40px ${withAlpha(COLORS.black, 0.5)}`, animation: 'fdToastIn .22s ease', whiteSpace: 'nowrap' }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
