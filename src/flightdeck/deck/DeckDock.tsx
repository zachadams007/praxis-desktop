/**
 * Flight Deck v3 - inspector dock (right slide-out console), 1:1 port of the
 * package's dock: one console per entity (session / agent / lane / repo /
 * praxis) with ✉ MESSAGE + ▣ PROMPT VAULT tabs.
 *
 * Real wiring: stats/tails read the live DeckModel; vault tab is the GLOBAL
 * pv_* vault (outcome write-back on fire); sends go through the shared agent
 * chat threads; HALT FLEET flips the real halted.txt gate. Where the package
 * demoed impossible things (switching a RUNNING CLI's model) the control moved
 * to the honest place (agent default → next spawn); see DECK_DEVIATIONS.
 */
import { activateDeckControl } from '@/flightdeck/deck/a11y';
import React from 'react';
import { useHalt } from '@/command/haltStore';
import type { FleetStore } from '@/command/fleetStore';
import type { PlanNames } from '../api';
import { AGENT_META, DECK_AGENTS, DEFAULT_VAULT_MODEL, EFFORTS, FLEET_MODELS, deckAgentOptions, laneDiffLabel, routedSessions, vaultTagFor, viaLabel, type AgentId, type DeckModel, type DeckSession, fmtElapsed } from './model';
import { COLORS, withAlpha } from './tokens';
import type { DeckVault, PvEntry } from './useDeckVault';
import type { ChannelMsg } from './DeckApp';

// APPROVE/DENY can't inject a decision into another running CLI - so they say so,
// honestly, instead of faking a resolution (see DECK_DEVIATIONS #2).
const GATE_HINT = "APPROVE OR DENY IN THAT SESSION'S OWN TERMINAL — PRAXIS CAN'T INJECT APPROVALS YET";

export type DockTarget = 'session' | 'agent' | 'lane' | 'repo' | 'praxis';
export interface DockState {
  type: DockTarget;
  id: string;
  tab: 'msg' | 'vault';
  mode: 'message' | 'steer';
}

interface Props {
  D: DockState | null; // dock or ghost (keeps content during slide-out)
  open: boolean;
  dockW: number;
  dockDrag: boolean;
  startDockDrag: (e: React.MouseEvent) => void;
  model: DeckModel;
  /** Live plan tier per provider, for the agent console's VIA stat - see viaLabel(). */
  planNames: PlanNames;
  sessions: DeckSession[];
  byLane: Record<string, DeckSession[]>;
  collLanes: Record<string, DeckSession[]>;
  statusMap: Record<string, [string, string]>;
  /** ONE truth for per-agent default models - same fleetStore selections the
   *  Command Center's Fleet panel reads/writes (2026-07-10 fix). */
  fleet: FleetStore;
  vault: DeckVault;
  msgs: Record<string, ChannelMsg[]>;
  dockVal: string;
  setDockVal: (v: string) => void;
  onSend: () => void;
  onSave: () => void;
  onClose: () => void;
  setDockTab: (tb: 'msg' | 'vault') => void;
  setDockMode: (md: 'message' | 'steer') => void;
  openDock: (type: DockTarget, id: string, opts?: { tab?: 'msg' | 'vault'; keep?: boolean }) => void;
  openSpawn: (laneId: string | null, e: React.MouseEvent) => void;
  fireVault: (key: string, entry: PvEntry) => void;
  doStop: (s: DeckSession) => void;
  say: (txt: string) => void;
  now: number;
  pidKnown: (id: string) => boolean;
  /** Live transcript tail lines (fd_session_tail) for the open session console;
   *  null when no session is focused or the tail hasn't loaded - falls back to the
   *  session's snapshot preview peek. */
  liveTail: string[] | null;
  /** When a vault-search result is picked, this points at the entry to reveal on
   *  the (already-opened) vault tab. `n` is a nonce so re-picking the same id
   *  re-fires the scroll. Null when no reveal is pending. */
  focusPv?: { id: string; n: number } | null;
  /** Effective read-only LOCK for a lane (auto background dir OR operator lock,
   *  optimistic overlay applied). Blocks spawn/cast/fire in the lane console. */
  isLaneReadOnly: (laneId: string | null | undefined) => boolean;
  /** Flip the operator's manual lock on a lane (fd_set_lane_readonly). */
  toggleLaneLock: (laneId: string) => void;
}


interface StatCell {
  k: string;
  v: string;
  c?: string;
}

export function DeckDock(props: Props): React.ReactElement {
  const {
    D, open, dockW, dockDrag, startDockDrag, model, planNames, sessions, byLane, collLanes, statusMap,
    fleet, vault, msgs, dockVal, setDockVal, onSend, onSave, onClose,
    setDockTab, setDockMode, openDock, openSpawn, fireVault, doStop, say, pidKnown, liveTail,
    focusPv, isLaneReadOnly, toggleLaneLock,
  } = props;
  const { halted, toggleHalt } = useHalt();

  const [vaultEdit, setVaultEdit] = React.useState(-1);
  const [vaultEditVal, setVaultEditVal] = React.useState('');
  const [vaultModelMenu, setVaultModelMenu] = React.useState(-1);
  const [vaultCopied, setVaultCopied] = React.useState(-1);
  const copyT = React.useRef(0);
  React.useEffect(() => {
    setVaultEdit(-1);
    setVaultModelMenu(-1);
  }, [D?.type, D?.id, D?.tab]);

  // ── vault-search reveal: scroll to + briefly ring the picked entry ──
  const pvRowRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const [pvHi, setPvHi] = React.useState<string | null>(null);
  const hiT = React.useRef(0);
  React.useEffect(() => {
    if (!focusPv || (D?.tab ?? 'msg') !== 'vault') return;
    // A beat so the tab switch / dock slide-in has committed the rows to the DOM.
    const t = window.setTimeout(() => {
      const el = pvRowRefs.current.get(focusPv.id);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setPvHi(focusPv.id);
        window.clearTimeout(hiT.current);
        hiT.current = window.setTimeout(() => setPvHi(null), 1700);
      }
    }, 90);
    return () => window.clearTimeout(t);
  }, [focusPv?.id, focusPv?.n, D?.tab, D?.id, D?.type]);
  React.useEffect(() => () => window.clearTimeout(hiT.current), []);

  const dockStyle: React.CSSProperties = {
    position: 'fixed',
    top: 98,
    bottom: 54,
    right: 0,
    width: dockW,
    zIndex: 46,
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(7,9,18,.985)',
    borderTop: `1px solid ${withAlpha(COLORS.line, 0.14)}`,
    borderBottom: `1px solid ${withAlpha(COLORS.line, 0.14)}`,
    borderRadius: '16px 0 0 16px',
    boxShadow: `-30px 0 90px ${withAlpha(COLORS.black, 0.55)}`,
    transform: open ? 'translateX(0)' : 'translateX(104%)',
    transition: dockDrag ? 'none' : 'transform .55s cubic-bezier(.16,1,.3,1)',
    overflow: 'hidden',
  };

  if (!D) {
    return <div ref={(el) => { if (el) el.inert = !open; }} data-screen-label="Inspector Dock" style={{ ...dockStyle, borderLeft: `1px solid ${withAlpha(COLORS.accent, 0.55)}` }} />;
  }

  const entKey = D.type === 'praxis' ? 'praxis' : `${D.type}:${D.id}`;
  const vItems = vault.forKey(entKey);
  const logArr = msgs[entKey] ?? [];
  const laneById = model.laneById;
  const repoById = model.repoById;

  // Lane read-only LOCK for the open console (only meaningful for a lane) - gates
  // SPAWN HERE, CAST, and vault FIRE in this dock. Auto (background dir) locks
  // aren't operator-toggleable.
  const laneLocked = D.type === 'lane' ? isLaneReadOnly(D.id) : false;
  const laneAutoLocked = D.type === 'lane' && Boolean(laneById[D.id]?.autoReadOnly);

  // ── per-entity console content (the design's renderVals dock section) ──
  let chipColor = COLORS.accent;
  let chipLabel = 'PRAXIS';
  let glyph = '✦';
  let typeLabel = 'ORCHESTRATOR';
  let subLine = '';
  let stats: StatCell[] = [];
  let headStatus: string | null = null;
  let headStatusColor = COLORS.textDim;
  let tail: DeckSession | null = null;
  let gateWants: string | null = null; // real approval-gate command, when this session is blocked
  let gateCwd: string | null = null; // that session's working dir, for the copy action below
  let models: Array<{ label: string; sel: boolean; onClick: () => void }> | null = null;
  let modelTitle = '';
  let miniSessions: DeckSession[] | null = null;
  let sessTitle = '';
  let actions: Array<{ label: string; kind: 'base' | 'red' | 'green'; onClick: () => void }> | null = null;
  let modes = false;
  let composeTitle = 'COMPOSE';
  let modeHint = '';
  let placeholder = '';
  let sendLabel = 'SEND ▸';
  let vaultSub = 'queued intent — fires in order';

  const workingN = sessions.filter((s) => s.status === 'working').length;
  const blockedN = sessions.filter((s) => s.status === 'blocked').length;

  if (D.type === 'session') {
    const s = sessions.find((x) => x.id === D.id);
    if (s) {
      const a = AGENT_META[s.agent];
      const lane = laneById[s.laneId];
      const repo = lane ? repoById[lane.repoId] : undefined;
      const stw = statusMap[s.status];
      chipColor = a.color;
      chipLabel = s.name;
      glyph = a.glyph;
      typeLabel = 'SESSION CONSOLE';
      subLine = `${a.name.toLowerCase()} · ${a.tool} — ${(lane?.letter ?? '').toLowerCase()}, ${repo?.name ?? ''}`;
      stats = [
        { k: 'STATUS', v: stw[0], c: stw[1] },
        { k: 'LAST ACTIVE', v: fmtElapsed(s.lastActiveMs) },
        { k: 'MODEL', v: s.model },
        { k: 'BRANCH', v: lane?.branch || '—' },
      ];
      headStatus = stw[0];
      headStatusColor = stw[1];
      tail = s;
      gateWants = s.status === 'blocked' ? s.wants ?? null : null;
      gateCwd = s.cwd ?? null;
      const aa: Array<{ label: string; kind: 'base' | 'red' | 'green'; onClick: () => void }> = [];
      if ((s.status === 'working' || s.status === 'blocked') && pidKnown(s.id)) {
        aa.push({ label: '■ STOP SESSION', kind: 'red', onClick: () => doStop(s) });
      }
      actions = aa.length ? aa : null;
      modes = !s.manual;
      composeTitle = 'COMPOSE';
      const mo = D.mode === 'steer' && !s.manual ? 'steer' : 'message';
      modeHint = s.working || s.status === 'blocked'
        ? 'busy — queued until this turn ends'
        : s.driver === 'cursor'
          ? "Cursor can't continue an existing chat yet"
          : mo === 'steer'
            ? 'continues this exact session with a marked priority turn'
            : 'continues this exact session and returns its reply';
      placeholder = mo === 'steer' ? 'steer this session — new priority, what to drop, what to keep…' : 'write to this session — brief it, as much detail as you need…';
      if (mo === 'steer') sendLabel = 'STEER ▸';
      vaultSub = 'saved on this session — fire sends it into its thread';
    }
  } else if (D.type === 'agent') {
    const a = AGENT_META[D.id as AgentId];
    chipColor = a.color;
    chipLabel = a.name;
    glyph = a.glyph;
    typeLabel = D.id === 'you' ? 'MANUAL CHANNEL' : 'AGENT CONSOLE';
    const mine = sessions.filter((x) => x.agent === D.id);
    const liveN = mine.filter((x) => x.status === 'working' || x.status === 'blocked').length;
    subLine = `${a.tool} — ${liveN} live of ${mine.length} sessions`;
    // Real per-agent catalog (fleetStore.ts - same source the Command Center's
    // Fleet panel reads/writes), not the old flat 4-label FLEET_MODELS list.
    const agentOpts = D.id !== 'you' ? deckAgentOptions(D.id as Exclude<AgentId, 'you'>) : [];
    const selectedId = D.id !== 'you' ? fleet.selections[D.id] ?? agentOpts[0]?.id ?? '' : '';
    const selectedOpt = agentOpts.find((o) => o.id === selectedId) ?? agentOpts[0];
    stats = [
      { k: 'LIVE', v: String(liveN) },
      { k: 'MODEL', v: D.id === 'you' ? 'MANUAL' : selectedOpt?.label ?? '—' },
      { k: 'VIA', v: viaLabel(D.id as AgentId, planNames) || 'KEYBOARD' },
    ];
    if (D.id !== 'you') {
      // Honest: a switch here applies to the NEXT spawned session for this agent -
      // it can never reach into an already-running headless process.
      modelTitle = 'DEFAULT MODEL — NEXT SESSION PICKS IT UP';
      models = agentOpts.map((o) => ({
        label: o.label,
        sel: o.id === selectedId,
        onClick: () => {
          fleet.setModel(D.id, o.id);
          say(`⚙ ${a.name} DEFAULT → ${o.label}`);
        },
      }));
      const stoppable = mine.filter((x) => (x.status === 'working' || x.status === 'blocked') && pidKnown(x.id));
      actions = stoppable.length
        ? [{
            label: `■ STOP ITS ${stoppable.length} SESSION${stoppable.length === 1 ? '' : 'S'}`,
            kind: 'red',
            onClick: () => stoppable.forEach((x) => doStop(x)),
          }]
        : null;
    }
    miniSessions = mine;
    sessTitle = 'ITS SESSIONS';
    composeTitle = D.id === 'you' ? 'NOTE TO SELF' : 'STANDING ORDER';
    modeHint = D.id === 'you' ? 'pinned to your manual channel' : 'lands on its thread — read at next pickup';
    placeholder = D.id === 'you' ? 'a note for future you…' : `standing instruction for ${a.name.toLowerCase()} — as long as you need…`;
    vaultSub = `saved on ${a.name.toLowerCase()} — fire spawns its next session`;
  } else if (D.type === 'lane') {
    const l = laneById[D.id];
    const repo = l ? repoById[l.repoId] : undefined;
    const occ = byLane[D.id] ?? [];
    const coll = Boolean(collLanes[D.id]);
    chipColor = coll ? COLORS.red : repo?.hue ?? COLORS.accent;
    chipLabel = `${l?.letter ?? 'LANE'} — ${repo?.name ?? ''}`;
    glyph = (l?.letter ?? 'L').replace('LANE ', '').slice(0, 2);
    typeLabel = 'LANE CONSOLE';
    if (coll) {
      headStatus = `${(collLanes[D.id] ?? []).length} WRITERS`;
      headStatusColor = COLORS.red;
    } else if (laneLocked) {
      headStatus = laneAutoLocked ? 'AUTO READ-ONLY' : 'LOCKED';
      headStatusColor = COLORS.accentLilac;
    }
    subLine = [l?.branch, l?.wt].filter(Boolean).join(' · ');
    // Real lane diff replaces the (already-in-subline) BRANCH cell when present.
    const laneDiff = laneDiffLabel(l?.diff);
    const laneState: StatCell = coll
      ? { k: 'STATE', v: `${(collLanes[D.id] ?? []).length} WRITERS`, c: COLORS.red }
      : laneLocked
        ? { k: 'STATE', v: laneAutoLocked ? '🔒 AUTO' : '🔒 LOCKED', c: COLORS.accentLilac }
        // Real working-tree state, not a hardcoded word. 'CLEAN' here was a
        // literal for any lane that wasn't colliding or locked, so a lane with
        // uncommitted work reported CLEAN. ' - ' when the diff hasn't been computed
        // for this lane yet: unknown is honest, CLEAN is a claim.
        : l?.diff?.dirtyFiles === undefined
          ? { k: 'STATE', v: '—', c: COLORS.textDim }
          : l.diff.dirtyFiles > 0
            ? { k: 'STATE', v: `${l.diff.dirtyFiles} DIRTY`, c: COLORS.statusPending }
            : { k: 'STATE', v: 'CLEAN', c: COLORS.statusWorking };
    stats = [
      { k: 'SESSIONS', v: String(occ.length) },
      laneDiff ? { k: 'DIFF', v: laneDiff } : { k: 'BRANCH', v: l?.branch || '—' },
      { k: 'LIVE', v: String(occ.filter((x) => x.status === 'working' || x.status === 'blocked').length) },
      laneState,
    ];
    miniSessions = occ;
    sessTitle = 'IN THIS LANE';
    actions = l?.path ? [{ label: '⊕ SPAWN HERE', kind: 'base', onClick: () => {} }] : null; // onClick replaced below (needs the event)
    composeTitle = 'BROADCAST';
    modeHint = laneLocked ? 'lane is locked — casts are refused until you unlock it' : 'idle sessions hear it now; busy sessions get it when free';
    placeholder = laneLocked
      ? 'lane locked — unlock to broadcast to its sessions…'
      : coll
        ? 'coordinate the writers — who pauses, who lands first…'
        : 'broadcast to this lane — every occupant reads it…';
    sendLabel = 'CAST ▸';
    vaultSub = laneLocked
      ? 'lane locked — queued prompts stay put; unlock to fire them in'
      : `queued for this lane — fires into ${l?.branch || 'its worktree'} in order`;
  } else if (D.type === 'repo') {
    const r = repoById[D.id];
    const rlanes = model.lanes.filter((l) => l.repoId === D.id);
    const laneIds = new Set(rlanes.map((l) => l.id));
    const occ = sessions.filter((x) => laneIds.has(x.laneId));
    const liveN = occ.filter((x) => x.status === 'working' || x.status === 'blocked').length;
    chipColor = r?.hue ?? COLORS.accent;
    chipLabel = r?.name ?? 'repo';
    glyph = '⎇';
    typeLabel = 'REPO CONSOLE';
    subLine = `${r?.path ?? ''} — ${r?.mainLine.toLowerCase() ?? ''}`;
    stats = [
      { k: 'LANES', v: String(rlanes.length) },
      { k: 'LIVE', v: String(liveN) },
      { k: 'SESSIONS', v: String(occ.length) },
    ];
    miniSessions = occ;
    sessTitle = 'ACROSS ITS LANES';
    composeTitle = 'BROADCAST — ALL LANES';
    modeHint = `delivers now or queues until free across ${r?.name ?? 'this repo'}`;
    placeholder = `broadcast across ${r?.name ?? 'this repo'} — every lane hears it…`;
    sendLabel = 'CAST ▸';
    vaultSub = `saved on ${r?.name ?? 'this repo'} — fire picks its quietest lane`;
  } else {
    // Same definition the core's "N ROUTED" prints (routedSessions in model.ts).
    // These were two different filters on one screen, so the core could read
    // 12 ROUTED while this console read 0.
    const routed = routedSessions(sessions);
    chipColor = COLORS.accent;
    chipLabel = 'PRAXIS';
    glyph = '✦';
    typeLabel = 'ORCHESTRATOR';
    subLine = 'the orchestrator — plans, routes, verifies, merges';
    stats = [
      { k: 'ROUTED', v: String(routed.length) },
      { k: 'FIRING', v: String(workingN) },
      { k: 'PENDING', v: String(blockedN), c: blockedN > 0 ? COLORS.statusPending : COLORS.textValue },
      { k: 'LANES', v: String(model.lanes.length) },
    ];
    miniSessions = routed;
    sessTitle = 'ROUTED NOW';
    actions = [{ label: halted ? '▸ LIFT HALT' : '■ HALT FLEET', kind: 'red', onClick: () => {
      toggleHalt();
      say(halted ? '▸ FLEET RESUMED — HALT LIFTED' : '■ FLEET HALTED — NEW WORK REFUSED (halted.txt)');
    } }];
    composeTitle = 'DIRECTIVE';
    modeHint = 'praxis folds it into the next plan';
    placeholder = 'a directive for the whole fleet — praxis replans around it…';
  }

  const isMsg = (D.tab ?? 'msg') === 'msg';
  const tabSt = (on: boolean): React.CSSProperties => ({
    fontSize: 8.5,
    letterSpacing: '.18em',
    padding: '9px 14px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    color: on ? COLORS.textBright : COLORS.textFaint,
    borderBottom: `2px solid ${on ? chipColor : 'transparent'}`,
    marginBottom: -1,
    fontWeight: on ? 700 : 400,
    transition: 'color .2s',
  });
  const selChip = (sel: boolean): React.CSSProperties =>
    sel
      ? { fontSize: 8.5, letterSpacing: '.12em', padding: '6px 12px', borderRadius: 99, cursor: 'default', flex: 'none', whiteSpace: 'nowrap', color: COLORS.ink, background: chipColor, border: '1px solid transparent', fontWeight: 800, boxShadow: `0 2px 9px ${chipColor}55`, transition: 'all .15s' }
      : { fontSize: 8.5, letterSpacing: '.12em', padding: '6px 12px', borderRadius: 99, cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap', color: COLORS.textDim, background: 'transparent', border: `1px dashed ${withAlpha(COLORS.line, 0.32)}`, fontWeight: 400, transition: 'all .15s' };
  const actStyle = (kind: 'base' | 'red' | 'green'): React.CSSProperties => {
    const base: React.CSSProperties = { fontSize: 8.5, letterSpacing: '.12em', color: COLORS.textMuted2, border: `1px solid ${withAlpha(COLORS.line, 0.3)}`, borderRadius: 8, padding: '7px 12px', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap', background: 'transparent' };
    if (kind === 'red') return { ...base, color: COLORS.redText, border: `1px solid ${withAlpha(COLORS.red, 0.45)}`, background: withAlpha(COLORS.red, 0.08), fontWeight: 700 };
    if (kind === 'green') return { ...base, color: COLORS.inkGreen, border: '1px solid transparent', background: COLORS.statusWorking, fontWeight: 800, boxShadow: `0 2px 9px ${withAlpha(COLORS.statusWorking, 0.35)}` };
    return base;
  };
  const vBtn: React.CSSProperties = { fontSize: 11, color: COLORS.textDim, border: `1px solid ${withAlpha(COLORS.line, 0.22)}`, borderRadius: 6, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'transparent', flex: 'none', lineHeight: 1 };
  const vGhost: React.CSSProperties = { fontSize: 7.5, letterSpacing: '.12em', color: COLORS.textStrong, border: `1px solid ${withAlpha(COLORS.line, 0.3)}`, borderRadius: 6, padding: '4px 9px', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600, background: 'transparent', flex: 'none' };
  const vFire: React.CSSProperties = { fontSize: 7.5, letterSpacing: '.14em', color: COLORS.ink, background: COLORS.accent, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 800, flex: 'none', boxShadow: `0 2px 8px ${withAlpha(COLORS.accent, 0.35)}` };

  const allModels = [...FLEET_MODELS];

  const miniRow = (x: DeckSession) => {
    const a2 = AGENT_META[x.agent];
    const stw2 = statusMap[x.status];
    const dd: React.CSSProperties = {
      width: 7,
      height: 7,
      borderRadius: '50%',
      flex: 'none',
      background: x.status === 'idle' ? 'transparent' : a2.color,
      border: x.status === 'idle' ? `1.5px solid ${COLORS.textIdle}` : 'none',
      opacity: x.status === 'done' ? 0.4 : 1,
    };
    return (
      <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Open session ${x.name}`}
        key={x.id}
        className="fd-hov-row"
        style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${withAlpha(COLORS.line, 0.12)}`, borderRadius: 8, padding: '7px 10px', cursor: 'pointer', background: withAlpha(COLORS.line, 0.03) }}
        onClick={(e) => {
          e.stopPropagation();
          openDock('session', x.id, { keep: true });
        }}
      >
        <span style={dd} />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: COLORS.textValue, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{x.name}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 7, letterSpacing: '.14em', color: stw2[1], flex: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}>{stw2[0]}</span>
      </div>
    );
  };

  return (
    <div data-screen-label="Inspector Dock" style={{ ...dockStyle, borderLeft: `1px solid ${chipColor}55` }}>
      <div
        className="fd-hov-dockgrip"
        onMouseDown={startDockDrag}
        title="drag to resize the console"
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 22, cursor: 'ew-resize', zIndex: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none', touchAction: 'none' }}
      >
        <span className="fd-dockgrip-pill" style={{ width: 5, height: 54, borderRadius: 99, background: withAlpha(COLORS.line, 0.4) }} />
      </div>
      <div style={{ height: 2, flex: 'none', background: `linear-gradient(90deg,${chipColor}cc,${chipColor}00 78%)` }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 13px', borderBottom: `1px solid ${withAlpha(COLORS.line, 0.1)}`, flex: 'none', background: withAlpha(COLORS.line, 0.03) }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: chipColor, background: `${chipColor}16`, border: `1px solid ${chipColor}55`, flex: 'none', letterSpacing: '.02em' }}>{glyph}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '.14em', color: COLORS.textBright, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{chipLabel}</div>
          <div style={{ fontSize: 7.5, letterSpacing: '.26em', color: COLORS.textFainter, marginTop: 5, whiteSpace: 'nowrap' }}>{typeLabel}</div>
        </div>
        {headStatus && (
          <span style={{ fontSize: 7.5, letterSpacing: '.16em', color: headStatusColor, border: `1px solid ${headStatusColor}55`, background: `${headStatusColor}12`, borderRadius: 99, padding: '3px 8px', fontWeight: 700, flex: 'none', whiteSpace: 'nowrap' }}>{headStatus}</span>
        )}
        <button type="button" aria-label="Close inspector dock" className="fd-control fd-hov-x" style={{ fontSize: 12, color: COLORS.textFaint, cursor: 'pointer', padding: '4px 8px' }} onClick={onClose}>✕</button>
      </div>
      <div data-scroll="1" style={{ flex: 1, overflowY: 'auto', padding: '13px 18px 18px', display: 'flex', flexDirection: 'column', gap: 13, minHeight: 0 }}>
        <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 13.5, color: COLORS.textMuted }}>{subLine}</div>

        {tail && (
          <div style={{ border: `1px solid ${withAlpha(COLORS.line, 0.13)}`, background: 'rgba(2,4,9,.8)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  flex: 'none',
                  background: tail.status === 'idle' ? 'transparent' : tail.status === 'working' ? AGENT_META[tail.agent].color : statusMap[tail.status][1],
                  border: tail.status === 'idle' ? `1.5px solid ${COLORS.textIdle}` : 'none',
                  boxShadow: tail.status === 'working' ? `0 0 8px ${AGENT_META[tail.agent].color}` : 'none',
                  // Only pulse when a tail is genuinely streaming. A pulsing dot
                  // over one frozen snapshot line (every codex/cursor session
                  // Praxis did not spawn) claims a liveness that is not there.
                  animation:
                    tail.status === 'working' && liveTail && liveTail.length
                      ? 'fdPulse 2s ease-in-out infinite'
                      : 'none',
                }}
              />
              <span style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.textFainter }}>
                {liveTail && liveTail.length ? 'LIVE TAIL' : 'LAST SEEN'}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 7.5, letterSpacing: '.14em', color: COLORS.textFaintest, whiteSpace: 'nowrap' }}>
                {tail.model}
                {tail.effort ? ` · ${tail.effort.toUpperCase()}` : ''}
                {tail.manual ? ' · YOUR HANDS' : ''}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9 }}>
              {(liveTail && liveTail.length ? liveTail : tail.peeks).slice(0, 3).map((p, ti) => (
                <div key={ti} style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                  <span style={{ fontSize: 9, color: ti === 0 ? AGENT_META[tail!.agent].color : COLORS.textFaintest, flex: 'none' }}>{ti === 0 ? '▸' : '·'}</span>
                  <span style={{ fontSize: 10.5, color: ti === 0 ? COLORS.textStrong : COLORS.textFaint, letterSpacing: '.02em', lineHeight: 1.6, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>{p}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {gateWants && (
          <div style={{ border: `1px solid ${withAlpha(COLORS.statusPending, 0.4)}`, background: withAlpha(COLORS.statusPending, 0.07), borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.statusPending, flex: 'none', animation: 'fdPulse 1.1s ease-in-out infinite' }} />
              <span style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.statusPendingText }}>TOOL PENDING — POSSIBLE APPROVAL GATE</span>
            </div>
            <div style={{ fontSize: 11, color: COLORS.statusPendingHi, marginTop: 8, lineHeight: 1.5, wordBreak: 'break-word' }}>{gateWants}</div>
            {/* APPROVE / DENY used to sit here as full-strength primary buttons
                whose only behaviour was a toast saying they don't work. A control
                that can only tell you it isn't a control still costs a click to
                discover that. The slot now holds an action that DOES something -
                copy the session's working dir so the terminal is one paste away -
                and the fact that approvals can't be injected is a plain line, not
                two buttons. Restore APPROVE/DENY when a channel into the CLI
                exists. */}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button type="button" aria-label="Copy session working directory" className="fd-control"
                style={actStyle('base')}
                onClick={(e) => {
                  e.stopPropagation();
                  const target = gateCwd ?? '';
                  if (!target) { say('NO WORKING DIR ON THIS SESSION'); return; }
                  navigator.clipboard
                    .writeText(target)
                    .then(() => say('▣ COPIED ITS WORKING DIR — PASTE INTO A TERMINAL'))
                    .catch(() => say('COULD NOT COPY — CLIPBOARD UNAVAILABLE'));
                }}
              >
                ▣ COPY ITS WORKING DIR
              </button>
            </div>
            <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 11.5, color: COLORS.flowSand, marginTop: 8 }}>
              approve or deny it in that session's own terminal — Praxis has no channel into another CLI
            </div>
          </div>
        )}

        <div style={{ display: 'flex', border: `1px solid ${withAlpha(COLORS.line, 0.1)}`, borderRadius: 11, background: withAlpha(COLORS.line, 0.03), padding: '10px 2px' }}>
          {stats.map((x, i) => (
            <div key={x.k} style={{ flex: 1, minWidth: 0, padding: '0 13px', borderLeft: i ? `1px solid ${withAlpha(COLORS.line, 0.12)}` : 'none' }}>
              <div style={{ fontSize: 7, letterSpacing: '.22em', color: COLORS.textFainter, whiteSpace: 'nowrap' }}>{x.k}</div>
              <div style={{ fontSize: 12.5, color: x.c ?? COLORS.textValue, marginTop: 6, fontWeight: 700, letterSpacing: '.05em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.v}</div>
            </div>
          ))}
        </div>

        {models && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.textFainter, flex: 'none' }}>{modelTitle}</span>
              <span style={{ flex: 1, height: 1, background: withAlpha(COLORS.line, 0.1) }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {models.map((mn) => (
                <button type="button" aria-label={mn.label} aria-pressed={mn.sel} className="fd-control"
                  key={mn.label}
                  style={selChip(mn.sel)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!mn.sel) mn.onClick();
                  }}
                >
                  {mn.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {miniSessions && miniSessions.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.textFainter, flex: 'none' }}>{sessTitle}</span>
              <span style={{ flex: 1, height: 1, background: withAlpha(COLORS.line, 0.1) }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>{miniSessions.map(miniRow)}</div>
          </div>
        )}

        {(actions || D.type === 'lane') && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {D.type === 'lane' && laneById[D.id]?.path && (
              <button type="button" aria-label="Spawn here" className="fd-control"
                style={{ ...actStyle('base'), ...(laneLocked ? { opacity: 0.4, cursor: 'not-allowed' } : null) }}
                title={laneLocked ? 'lane locked — unlock to spawn' : 'spawn a fresh session into this lane'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (laneLocked) {
                    say('🔒 LANE LOCKED — UNLOCK TO SPAWN');
                    return;
                  }
                  openSpawn(D.id, e);
                }}
              >
                ⊕ SPAWN HERE
              </button>
            )}
            {D.type === 'lane' && laneById[D.id]?.path && (
              <button type="button" aria-label="Lock lane" aria-pressed={laneLocked} aria-disabled={laneAutoLocked} className="fd-control"
                style={{
                  ...actStyle('base'),
                  ...(laneLocked ? { color: COLORS.accentBright, border: `1px solid ${withAlpha(COLORS.accent, 0.5)}`, background: withAlpha(COLORS.accent, 0.12) } : null),
                  ...(laneAutoLocked ? { opacity: 0.4, cursor: 'not-allowed' } : null),
                }}
                title={
                  laneAutoLocked
                    ? 'background lane — auto read-only, cannot unlock'
                    : laneLocked
                      ? 'unlock this lane — allow spawn/cast/fire'
                      : 'lock this lane read-only — block spawn/cast/fire'
                }
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLaneLock(D.id);
                }}
              >
                {laneLocked ? '🔒 UNLOCK LANE' : '🔓 LOCK LANE'}
              </button>
            )}
            {(actions ?? []).filter((a) => !(D.type === 'lane' && a.label === '⊕ SPAWN HERE')).map((a) => (
              <button type="button" aria-label={a.label} aria-pressed={D.type === 'praxis' ? halted : undefined} className="fd-control" key={a.label} style={actStyle(a.kind)} onClick={(e) => { e.stopPropagation(); a.onClick(); }}>{a.label}</button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${withAlpha(COLORS.line, 0.12)}`, flex: 'none' }}>
          <button type="button" aria-label="Message" aria-pressed={isMsg} className="fd-control" style={tabSt(isMsg)} onClick={() => setDockTab('msg')}>✉ MESSAGE</button>
          <button type="button" aria-label={`Prompt vault (${vItems.length})`} aria-pressed={!isMsg} className="fd-control" style={tabSt(!isMsg)} onClick={() => setDockTab('vault')}>▣ PROMPT VAULT · {vItems.length}</button>
        </div>

        {isMsg ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.textFainter, flex: 'none' }}>{composeTitle}</span>
              {modes && (
                <div style={{ display: 'flex', gap: 3, background: withAlpha(COLORS.line, 0.06), border: `1px solid ${withAlpha(COLORS.line, 0.14)}`, borderRadius: 8, padding: 3, flex: 'none' }}>
                  {(['message', 'steer'] as const).map((md) => {
                    const on = (D.mode ?? 'message') === md;
                    return (
                      <button type="button" aria-label={md === 'message' ? 'Message' : 'Steer'} aria-pressed={on} className="fd-control"
                        key={md}
                        style={on
                          ? { fontSize: 7.5, letterSpacing: '.12em', color: COLORS.ink, background: chipColor, borderRadius: 6, padding: '5px 10px', cursor: 'default', fontWeight: 800, whiteSpace: 'nowrap' }
                          : { fontSize: 7.5, letterSpacing: '.12em', color: COLORS.textFaint, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDockMode(md);
                        }}
                      >
                        {md === 'message' ? '✉ MESSAGE' : '⌁ STEER'}
                      </button>
                    );
                  })}
                </div>
              )}
              <span style={{ flex: 1, height: 1, background: withAlpha(COLORS.line, 0.1) }} />
              <span style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 12.5, color: COLORS.textFaint, flex: 'none' }}>{modeHint}</span>
            </div>
            <textarea
              data-anchor="dock-input"
              className="fd-focus-input"
              value={dockVal}
              onChange={(e) => setDockVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder={placeholder}
              style={{ width: '100%', minHeight: 120, maxHeight: 260, resize: 'vertical', background: withAlpha(COLORS.line, 0.05), border: `1px solid ${withAlpha(COLORS.line, 0.2)}`, borderRadius: 10, outline: 'none', color: COLORS.text, fontSize: 12.5, lineHeight: 1.7, padding: '12px 14px', letterSpacing: '.01em' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 7, letterSpacing: '.14em', color: COLORS.textFaintest, whiteSpace: 'nowrap' }}>⌘⏎ SEND · ⏎ NEW LINE</span>
              <span style={{ flex: 1 }} />
              <button type="button" aria-label="Save to vault" className="fd-control fd-hov-save" style={{ fontSize: 8.5, letterSpacing: '.14em', color: COLORS.accentBright, border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, borderRadius: 8, padding: '8px 13px', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={onSave}>
                ▣ SAVE TO VAULT
              </button>
              <button type="button" aria-label={laneLocked ? 'Send — lane locked' : sendLabel} className="fd-control"
                title={laneLocked ? 'lane locked — unlock to send' : undefined}
                style={{ fontSize: 9.5, letterSpacing: '.16em', color: COLORS.ink, background: chipColor, borderRadius: 8, padding: '8px 16px', cursor: laneLocked ? 'not-allowed' : 'pointer', fontWeight: 700, whiteSpace: 'nowrap', opacity: laneLocked ? 0.35 : dockVal.trim() ? 1 : 0.4, transition: 'opacity .2s' }}
                onClick={laneLocked ? () => say('🔒 LANE LOCKED — UNLOCK TO SEND') : onSend}
              >
                {laneLocked ? '🔒 LOCKED' : sendLabel}
              </button>
            </div>
            {logArr.length > 0 && (
              <div style={{ borderTop: `1px dashed ${withAlpha(COLORS.line, 0.14)}`, paddingTop: 10 }}>
                <div style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.textFainter }}>RECENT — THIS CHANNEL</div>
                {logArr.slice(-4).reverse().map((m, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 7.5, color: COLORS.textFainter, flex: 'none', letterSpacing: '.06em' }}>{m.at}</span>
                    <span style={{ fontSize: 7, letterSpacing: '.12em', color: chipColor, border: `1px solid ${chipColor}40`, borderRadius: 99, padding: '2px 7px', flex: 'none', whiteSpace: 'nowrap' }}>{m.mode}</span>
                    <span style={{ fontSize: 10, color: COLORS.textDim, lineHeight: 1.55, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', minWidth: 0 }}>{m.t}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 12.5, color: COLORS.textFaint, marginTop: -4 }}>{vaultSub}</div>
            {vItems.map((it, i) => (
              <div
                key={it.id}
                data-pv-id={it.id}
                ref={(el) => {
                  if (el) pvRowRefs.current.set(it.id, el);
                  else pvRowRefs.current.delete(it.id);
                }}
                className="fd-hov-vault"
                style={{
                  display: 'flex',
                  gap: 9,
                  alignItems: 'flex-start',
                  border: `1px solid ${pvHi === it.id ? `${chipColor}aa` : withAlpha(COLORS.line, 0.12)}`,
                  background: pvHi === it.id ? `${chipColor}12` : withAlpha(COLORS.line, 0.04),
                  borderRadius: 9,
                  padding: '9px 11px',
                  transition: 'border-color .3s, background .3s',
                  boxShadow: pvHi === it.id ? `0 0 0 1px ${chipColor}55, 0 6px 20px ${chipColor}22` : 'none',
                }}
              >
                <span style={{ fontSize: 8.5, color: COLORS.textFaint, marginTop: 3, flex: 'none' }}>{String(i + 1).padStart(2, '0')}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {vaultEdit === i ? (
                    <textarea
                      data-anchor="vault-edit"
                      autoFocus
                      value={vaultEditVal}
                      onChange={(e) => setVaultEditVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          if (!vaultEditVal.trim()) vault.remove(it.id);
                          else vault.update(it.id, { text: vaultEditVal });
                          setVaultEdit(-1);
                        }
                      }}
                      placeholder="write the full prompt — multiple lines welcome"
                      style={{ width: '100%', minHeight: 72, resize: 'vertical', background: withAlpha(COLORS.line, 0.08), border: `1px solid ${withAlpha(COLORS.accent, 0.35)}`, borderRadius: 7, outline: 'none', color: COLORS.text, fontSize: 10.5, lineHeight: 1.6, padding: '8px 10px' }}
                    />
                  ) : (
                    <div style={{ fontSize: 11, color: COLORS.textSoft, lineHeight: 1.65, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{it.text || '— empty —'}</div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6, position: 'relative' }}>
                    <button type="button" aria-label={`Prompt ${i + 1} model: ${it.model ?? DEFAULT_VAULT_MODEL}`} aria-expanded={vaultModelMenu === i} className="fd-control"
                      style={{ fontSize: 8, letterSpacing: '.08em', color: vaultModelMenu === i ? COLORS.ink : COLORS.accentBright, background: vaultModelMenu === i ? COLORS.accent : withAlpha(COLORS.accent, 0.1), border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600 }}
                      title="pick the model this prompt runs on"
                      onClick={(e) => {
                        e.stopPropagation();
                        setVaultModelMenu(vaultModelMenu === i ? -1 : i);
                      }}
                    >
                      ◈ {it.model ?? DEFAULT_VAULT_MODEL} ▾
                    </button>
                    <button type="button" aria-label={`Cycle prompt ${i + 1} effort: ${it.effort ?? 'MED'}`} className="fd-control"
                      style={{ fontSize: 7.5, letterSpacing: '.12em', color: COLORS.textFaint, border: `1px solid ${withAlpha(COLORS.line, 0.22)}`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}
                      title="click — cycle effort"
                      onClick={(e) => {
                        e.stopPropagation();
                        const cur = EFFORTS.indexOf((it.effort ?? 'MED') as (typeof EFFORTS)[number]);
                        vault.update(it.id, { effort: EFFORTS[(cur + 1) % EFFORTS.length] });
                      }}
                    >
                      {it.effort ?? 'MED'}
                    </button>
                    {it.history.length > 0 && (
                      <span style={{ fontSize: 7.5, letterSpacing: '.1em', color: COLORS.textFainter }} title={it.history[it.history.length - 1]?.resultSnippet ?? ''}>
                        FIRED ×{it.history.length}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <button type="button" aria-label={`Copy prompt ${i + 1}`} className="fd-control"
                      style={{ ...vGhost, ...(vaultCopied === i ? { color: COLORS.statusWorking, border: `1px solid ${withAlpha(COLORS.statusWorking, 0.5)}` } : null) }}
                      title="copy prompt text to clipboard"
                      onClick={(e) => {
                        e.stopPropagation();
                        const txt = it.text ?? '';
                        navigator.clipboard?.writeText(txt).catch(() => {});
                        setVaultCopied(i);
                        window.clearTimeout(copyT.current);
                        copyT.current = window.setTimeout(() => setVaultCopied(-1), 1400);
                      }}
                    >
                      {vaultCopied === i ? '✓ COPIED' : '⧉ COPY'}
                    </button>
                    <button type="button" aria-label={`Edit prompt ${i + 1}`} aria-expanded={vaultEdit === i} className="fd-control"
                      style={vGhost}
                      title="edit this prompt"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (vaultEdit === i) {
                          if (!vaultEditVal.trim()) vault.remove(it.id);
                          else vault.update(it.id, { text: vaultEditVal });
                          setVaultEdit(-1);
                        } else {
                          setVaultEdit(i);
                          setVaultEditVal(it.text);
                        }
                      }}
                    >
                      {vaultEdit === i ? '✓ DONE' : '✎ EDIT'}
                    </button>
                    <button type="button" aria-label={`Fire prompt ${i + 1}`} className="fd-control"
                      style={{ ...vFire, ...(laneLocked ? { opacity: 0.35, cursor: 'not-allowed' } : null) }}
                      title={laneLocked ? 'lane locked — unlock to fire' : 'send this prompt now'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (laneLocked) {
                          say('🔒 LANE LOCKED — UNLOCK TO FIRE');
                          return;
                        }
                        fireVault(entKey, it);
                      }}
                    >
                      ▸ FIRE
                    </button>
                    {vaultModelMenu === i && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 5, zIndex: 60, background: 'rgba(9,12,22,.99)', border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, borderRadius: 10, padding: 5, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 158, boxShadow: `0 12px 34px ${withAlpha(COLORS.black, 0.55)}` }}>
                        <div style={{ fontSize: 6.5, letterSpacing: '.24em', color: COLORS.textFainter, padding: '4px 8px 3px' }}>RUN THIS PROMPT ON</div>
                        {allModels.map((mn) => (
                          <button type="button" aria-label={mn} aria-pressed={it.model === mn} className="fd-control"
                            key={mn}
                            style={{ fontSize: 8.5, letterSpacing: '.08em', color: it.model === mn ? COLORS.ink : COLORS.textStrong, background: it.model === mn ? COLORS.accent : 'transparent', fontWeight: it.model === mn ? 700 : 400, borderRadius: 6, padding: '5px 9px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              vault.update(it.id, { model: mn });
                              setVaultModelMenu(-1);
                            }}
                          >
                            {mn}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 'none', marginTop: 1 }}>
                  <button type="button" aria-label={`Move prompt ${i + 1} up in queue`} className="fd-control" style={vBtn} title="move up in queue" onClick={(e) => { e.stopPropagation(); vault.move(entKey, it.id, -1); }}>↑</button>
                  <button type="button" aria-label={`Move prompt ${i + 1} down in queue`} className="fd-control" style={vBtn} title="move down in queue" onClick={(e) => { e.stopPropagation(); vault.move(entKey, it.id, 1); }}>↓</button>
                </div>
              </div>
            ))}
            {vItems.length === 0 && (
              <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 12.5, color: COLORS.textFaint, padding: '12px 4px', textAlign: 'center' }}>vault is empty — queue a prompt, it stays right here</div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <button type="button" aria-label="Queue prompt"
                className="fd-control fd-hov-btn"
                style={{ fontSize: 8, letterSpacing: '.14em', color: COLORS.textStrong, border: `1px solid ${withAlpha(COLORS.line, 0.3)}`, borderRadius: 8, padding: '7px 11px', cursor: 'pointer' }}
                onClick={async () => {
                  const laneHint = D.type === 'lane' ? laneById[D.id]?.branch || undefined : undefined;
                  const defModel = D.type === 'agent' && D.id !== 'you' ? vaultTagFor(D.id as Exclude<AgentId, 'you'>) : 'OPUS 4.8';
                  const entry = await vault.add(entKey, '', defModel, 'MED', laneHint);
                  if (entry) {
                    setVaultEdit(vItems.length);
                    setVaultEditVal('');
                  } else {
                    // vault.add swallows the backend error and returns null - say so
                    // instead of leaving a silently dead button (pv_add unavailable).
                    say('⊘ VAULT OFFLINE — COULD NOT QUEUE THE PROMPT');
                  }
                }}
              >
                + QUEUE PROMPT
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" aria-label="Fire next prompt" className="fd-control"
                title={laneLocked ? 'lane locked — unlock to fire' : undefined}
                style={{ fontSize: 8, letterSpacing: '.16em', color: COLORS.ink, background: COLORS.accent, borderRadius: 8, padding: '6px 12px', cursor: laneLocked ? 'not-allowed' : 'pointer', fontWeight: 700, whiteSpace: 'nowrap', opacity: laneLocked || !vItems.length ? 0.35 : 1 }}
                onClick={() => {
                  if (laneLocked) {
                    say('🔒 LANE LOCKED — UNLOCK TO FIRE');
                    return;
                  }
                  if (vItems.length) fireVault(entKey, vItems[0]);
                }}
              >
                ▸ FIRE NEXT
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
