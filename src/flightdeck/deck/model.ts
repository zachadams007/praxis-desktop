/**
 * Flight Deck v3 - deck model. Maps the REAL backend contract (fd_sessions
 * LanesSnapshot + fd_worktree_topology) onto the Claude Design package's view
 * vocabulary (agents → sessions → lanes → repos, mirrored delegation flow).
 *
 * EVERYTHING here is derived from live data - the design's sample arrays
 * (praxis-core / volatility-desk / …) are gone. Repos come from the git
 * topology scan (auto-discovered on disk) merged with the session snapshot;
 * lanes are the repo's real worktrees wearing generic letters; sessions are
 * real Claude/Codex/Cursor processes and transcripts.
 *
 * Deviations from the design package are collected in DECK_DEVIATIONS at the
 * bottom of this file so they're greppable and reviewable in one place.
 */
import type { Driver, Lane, LaneDiff, LanesSnapshot, Repo, SessionCard, TopologyRepo, TopologySnapshot } from '../types';
import type { PlanNames } from '../api';
import { COLORS } from './tokens';
import { FLEET_AGENTS, getFleetSelection, type FleetModelOption } from '@/command/fleetStore';

export type AgentId = 'forge' | 'vega' | 'quill' | 'you';

export interface DeckAgentMeta {
  id: AgentId;
  name: string;
  glyph: string;
  tool: string;
  color: string;
  via: string;
}

/** Flight Deck's visible fleet. `via` is the FALLBACK shown before/without a live
 *  plan read - see `viaLabel()` for the live upgrade. Forge/Vega carry the
 *  provider name only, because their tier can change; Quill's "CURSOR PRO" has no
 *  live source to draw from, so it is static. It stays as
 *  the one source of truth. */
export const DECK_AGENTS: DeckAgentMeta[] = [
  { id: 'forge', name: 'FORGE', glyph: '◆', tool: 'claude code', color: '#ff9d7a', via: 'CLAUDE' },
  { id: 'vega', name: 'VEGA', glyph: '▲', tool: 'codex', color: '#62dbe8', via: 'CHATGPT' },
  { id: 'quill', name: 'QUILL', glyph: '◇', tool: 'cursor', color: '#6f9dff', via: 'CURSOR PRO' },
  { id: 'you', name: 'YOU', glyph: '◈', tool: 'your own hands', color: '#dfe4f4', via: '' },
];

/**
 * Quill keeps its static AGENT_META value: Cursor's own label ("pro") doesn't fit this shape and
 * "CURSOR PRO" is already right.
 */
export function viaLabel(agent: AgentId, plans: PlanNames | null | undefined): string {
  const base = AGENT_META[agent].via;
  const tier = agent === 'forge' ? plans?.claude : agent === 'vega' ? plans?.codex : null;
  return tier ? `${base} ${tier.toUpperCase()}` : base;
}

/**
 * The PLATFORM a session ran on, as a chip: name + the agent colour that already
 * stands for that tool everywhere else on the deck.
 *
 * Claude, Codex and Cursor sessions must be told apart at a glance, so the
 * chip says what a session is running under.
 *
 * Driver, not model, for the same reason `identityForSession` uses it: Vega can
 * run another vendor's model and Cursor can run Claude models, so the model never
 * reliably names the platform.
 */
/**
 * The driver of ONE SESSION, which is not always the driver of its lane.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Codex and Cursor sessions do not get their own lane when Praxis already tracks
 * a lane for the same directory. `flightdeck.rs` folds them into that lane's card
 * list (`b.cards.extend(lane.sessions)`) so the deck shows one lane per worktree
 * instead of three stacked on the same folder. That is the right layout.
 *
 * But the badge was read off the LANE, and the lane for the main checkout is tagged
 * `integration` - which means Claude. So every Codex session running in a folder Praxis already
 * knew about rendered as CLAUDE.
 *
 * The backend already stamps the tool into the card id (`codex:<uuid>`,
 * `cursor:<uuid>`), which survives the fold because it belongs to the session
 * rather than its container. Use that first; fall back to the lane only for cards
 * that carry no prefix, which are the Claude ones.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function sessionDriver(sessionId: string, laneDriver?: string | null): string | null {
  if (sessionId.startsWith('codex:')) return 'codex';
  if (sessionId.startsWith('cursor:')) return 'cursor';
  return laneDriver ?? null;
}

export function toolBadge(driver?: string | null): { label: string; color: string } | null {
  switch (driver) {
    case 'codex':
      return { label: 'CODEX', color: '#62dbe8' };
    case 'cursor':
      return { label: 'CURSOR', color: '#6f9dff' };
    case 'claude':
    case 'max':
    case 'cloud':
    // The PRIMARY worktree lane is tagged by role, not by tool, and its sessions come from the
    // Claude session store - Codex and Cursor are folded in as their own synthetic lanes with
    // explicit drivers.
    case 'integration':
      return { label: 'CLAUDE', color: '#ff9d7a' };
    default:
      // `integration` and anything unrecognised get NO badge rather than a
      // guessed one - an unlabelled card is honest, a mislabelled one is not.
      return null;
  }
}

/**
 * Is this model string worth its own chip, or does it just repeat the platform?
 *
 * "openai", "anthropic" and friends are vendors, not models. They were rendering
 * in the model slot beside a real model like "Opus 4.8", so two cards described
 * themselves at two different levels of specificity.
 */
export function modelChipText(model?: string | null, driver?: string | null): string | null {
  const raw = (model ?? '').trim();
  if (!raw) return null;
  const vendorish = /^(openai|anthropic|google|cursor|codex|claude|max|cloud|unknown)$/i;
  if (vendorish.test(raw)) return null;
  const badge = toolBadge(driver);
  if (badge && raw.toUpperCase() === badge.label) return null;
  return raw;
}
export const AGENT_META: Record<AgentId, DeckAgentMeta> = Object.fromEntries(
  DECK_AGENTS.map((a) => [a.id, a]),
) as Record<AgentId, DeckAgentMeta>;

/** Model roster for the prompt-vault's per-entry "RUN THIS PROMPT ON" quick tag
 *  (DeckDock.tsx) - a small, driver-agnostic label independent of which agent
 *  ultimately fires the prompt. NEVER Haiku. NOT used for the per-agent default
 *  model picker below - that reads the real per-agent catalog (deckAgentOptions). */
export const FLEET_MODELS = ['OPUS 4.8', 'SONNET 5', 'FABLE 5', 'CODEX', 'CURSOR'] as const;
/** What an untagged vault prompt actually runs on.
 *
 *  The vault row's model chip used to display 'GPT-5.6 SOL' for an entry with no
 *  model - a label that is not in FLEET_MODELS (so it could not be selected or
 *  re-selected) and that the fire path never uses: fireVault looks the label up in
 *  its routing table, a null misses every key, and it falls through to Forge, i.e.
 *  Claude. The chip named a vendor the run would not use. Both the badge and the
 *  fire fallback now read this one constant. */
export const DEFAULT_VAULT_MODEL: (typeof FLEET_MODELS)[number] = 'OPUS 4.8';

/** Lane id for a worktree path - the SAME key the backend uses.
 *
 *  Mirrors `encode_cwd` in flightdeck.rs exactly: ':' stripped, separators to
 *  '-', and a leading drive letter doubled ("C:\Users" -> "C--Users").
 *
 *  It exists because topology-only lanes (a repo with no live sessions) used a
 *  synthetic `topo:<path>` id. Locking one sent THAT string to
 *  fd_set_lane_readonly, which stored it verbatim, while the snapshot matches
 *  overrides against `encode_cwd(path)` - so the lock never came back. The chip
 *  read LOCKED indefinitely in that one window, blocked spawn/cast/fire only
 *  there, was invisible to every other window, and vanished on reload. One lane
 *  now has one identity in both sources. */
export function laneIdForPath(path: string): string {
  let out = '';
  for (const c of path) {
    if (c === ':') continue;
    out += c === '\\' || c === '/' ? '-' : c;
  }
  if (out.length >= 2 && /[A-Za-z]/.test(out[0]) && out[1] === '-') {
    out = out[0] + '-' + out.slice(1);
  }
  return out;
}

export const EFFORTS = ['LOW', 'MED', 'HIGH', 'XHIGH', 'MAX'] as const;
export type EffortLabel = (typeof EFFORTS)[number];

/** Deck model label → the CLI `--model` alias fd_spawn_session forwards. Only used
 *  by the vault quick-tag picker above (FLEET_MODELS) - the per-agent default model
 *  picker uses the real fleetStore ids directly (deckAgentOptions), no translation
 *  needed since those options already store CLI-ready ids. */
export function modelAliasFor(label: string): string | undefined {
  switch (label) {
    case 'OPUS 4.8':
      return 'opus';
    case 'SONNET 5':
      return 'sonnet';
    case 'FABLE 5':
      return 'fable';
    default:
      return undefined;
  }
}

/**
 * Real per-agent model options for Flight Deck's agent console - sourced from the
 * SAME catalog the Command Center's Fleet panel uses (fleetStore.ts's FLEET_AGENTS),
 * so CC and FD read one source (2026-07-10 fix). Replaces the old flat FLEET_MODELS
 * list, which showed the identical 4 Claude-ish labels for EVERY agent regardless of
 * driver - nonsensical for Vega (codex) and especially Quill (cursor, which now has
 * its own real cursor-agent model catalog). `AgentId`'s forge/vega/quill values are
 * identical strings to fleetStore's FLEET_AGENTS keys by construction - no mapping
 * table needed.
 */
export function deckAgentOptions(agent: Exclude<AgentId, 'you'>): FleetModelOption[] {
  return FLEET_AGENTS.find((a) => a.key === agent)?.options ?? [];
}

/** Nearest-match an agent's REAL fleetStore selection onto the vault's small
 *  driver-agnostic FLEET_MODELS quick-tag label (the "RUN THIS PROMPT ON" picker
 *  + fireVault's untargeted-fire agent routing both key off these 4 strings -
 *  see DeckDock.tsx/DeckApp.tsx). Best-effort labeling only; the vault tag doesn't
 *  gate execution, but keeping it one of the 4 known labels keeps fireVault's
 *  model→agent routing table meaningful instead of silently defaulting to Forge
 *  for every non-matching custom label. */
export function vaultTagFor(agent: Exclude<AgentId, 'you'>): (typeof FLEET_MODELS)[number] {
  const selection = getFleetSelection(agent);
  const label = selection?.label ?? '';
  if (agent === 'vega') return 'CODEX';
  if (agent === 'quill') return 'CURSOR';
  if (/opus/i.test(label)) return 'OPUS 4.8';
  if (/fable/i.test(label)) return 'FABLE 5';
  if (/sonnet/i.test(label)) return 'SONNET 5';
  return 'OPUS 4.8';
}

export function effortAliasFor(label: EffortLabel): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  switch (label) {
    case 'LOW':
      return 'low';
    case 'MED':
      return 'medium';
    case 'HIGH':
      return 'high';
    case 'XHIGH':
      return 'xhigh';
    case 'MAX':
      return 'max';
  }
}

/** Which fleet agent operates a lane driver. */
export function agentForDriver(driver: Driver): Exclude<AgentId, 'you'> {
  if (driver === 'codex') return 'vega';
  if (driver === 'cursor') return 'quill';
  return 'forge'; // claude · max · integration · cloud → Claude Code
}

/**
 * A session Praxis just launched. Cards never carry the synthetic `fd-…` id
 * `fd_spawn_session` returns - they use the CLI session UUID (`codex:`/`cursor:`
 * prefixed, or the Claude transcript id). The join both sides share is the PID
 * (Claude cards) or, for a few seconds after spawn, a unique cwd+driver pair
 * (Codex/Cursor cards carry no pid).
 */
export interface SpawnMark {
  pid: number;
  cwd: string;
  driver: string;
  at: number;
}

/** Rise-animation window, and the only window in which a cwd+driver join is honest. */
export const SPAWN_FRESH_MS = 60_000;

export function canonPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function spawnToolOfCard(cardId: string, laneDriver?: string | null): string {
  const d = sessionDriver(cardId, laneDriver);
  if (d === 'codex' || d === 'cursor') return d;
  return 'claude';
}

/**
 * Who started this card, and whether it was spawned just now.
 *
 * Backend `origin` is the durable answer for Claude (pid ∈ fd-spawned.json).
 * A matching SpawnMark covers the gap before the next snapshot, the rise
 * animation, and Codex/Cursor cards that the backend still stamps `manual`
 * because they expose no pid.
 */
export function sessionAttribution(
  card: { id: string; pid?: number | null; origin?: string },
  lanePath: string | null,
  marks: readonly SpawnMark[],
  now = Date.now(),
): { manual: boolean; fresh: boolean } {
  const pidHit =
    typeof card.pid === 'number' && card.pid > 0 ? marks.find((m) => m.pid === card.pid) : undefined;

  let cwdHit: SpawnMark | undefined;
  if (!pidHit && lanePath) {
    const want = spawnToolOfCard(card.id);
    const hits = marks.filter(
      (m) => m.driver === want && canonPath(m.cwd) === canonPath(lanePath) && now - m.at < SPAWN_FRESH_MS,
    );
    if (hits.length === 1) cwdHit = hits[0];
  }

  const mark = pidHit ?? cwdHit;
  const fromBackend = card.origin === 'praxis';
  const fromMark = Boolean(mark);
  return {
    manual: !(fromBackend || fromMark),
    fresh: Boolean(mark && now - mark.at < SPAWN_FRESH_MS),
  };
}

/** STOP fallback: card pid, else the unique live spawn in this cwd+driver. */
export function pidForSpawnedSession(
  session: { id: string; pid?: number | null; driver?: string | null; cwd: string | null },
  marks: readonly SpawnMark[],
): { pid: number; driver: string } | null {
  if (typeof session.pid === 'number' && session.pid > 0) {
    return { pid: session.pid, driver: spawnToolOfCard(session.id, session.driver) };
  }
  if (!session.cwd) return null;
  const want = spawnToolOfCard(session.id, session.driver);
  const hits = marks.filter((m) => m.driver === want && canonPath(m.cwd) === canonPath(session.cwd!));
  if (hits.length !== 1) return null;
  return { pid: hits[0].pid, driver: hits[0].driver };
}

/** Spawn driver for an agent (fd_spawn_session contract). */
export function driverForAgent(agent: Exclude<AgentId, 'you'>): 'max' | 'codex' | 'cursor' {
  return agent === 'vega' ? 'codex' : agent === 'quill' ? 'cursor' : 'max';
}

// ── View model ────────────────────────────────────────────────────────────────

export type DeckStatus = 'working' | 'blocked' | 'idle' | 'done';

export interface DeckSession {
  owner: SessionCard['owner'];
  activity: SessionCard['activity'];
  groupLabel?: string;
  id: string;
  name: string;
  agent: AgentId;
  driver: Driver;
  model: string; // display label
  effort: string | null;
  status: DeckStatus;
  /** ms since the session's last activity (transcript mtime) - REAL, not a fake
   *  "elapsed since start" (the backend doesn't know start times). */
  lastActiveMs: number;
  laneId: string;
  /** A prompt is actually executing (backend turn-state). Only this orbits. */
  working: boolean;
  manual: boolean; // NOT spawned by Praxis (origin: manual) → the owner's own hands
  peeks: string[];
  running: boolean;
  pid: number | null;
  cwd: string | null;
  fresh?: boolean;
  /** The pending tool/command this session is parked on when status === 'blocked'
   *  (a real approval gate). Null otherwise. */
  wants: string | null;
}

/** ROUTED = sessions PRAXIS dispatched. One definition, used everywhere.
 *
 *  The core printed `sessions.length` - every session on the deck including the
 *  ones the owner started by hand - while the Praxis console computed its own
 *  `agent !== 'you' && status !== 'done'`. The two numbers disagreed on one
 *  screen: the core could read "12 ROUTED" while clicking it opened a console
 *  reading ROUTED 0. Now that `manual` is real (backend `origin`), this is the
 *  honest count, and if it is genuinely 0 it prints 0. */
export function routedSessions(sessions: DeckSession[]): DeckSession[] {
  return sessions.filter((s) => !s.manual);
}

/** Display label for a lane's branch: the branch name, '@ abc1234' for a
 *  detached HEAD, '' when unknown - render sites drop the ⎇ glyph entirely
 *  rather than printing the '⎇ - ' placeholder the owner flagged. */
export function prettyBranchLabel(branch: string | null, head: string | null): string {
  if (branch && branch !== '(detached)') return branch;
  if (head) return `@ ${head.slice(0, 7)}`;
  return '';
}

export interface DeckLane {
  id: string; // stable lane id (encoded worktree path)
  repoId: string;
  letter: string; // LANE A / LANE B / MAIN - generic reusable slot names
  /** Display-ready branch label from prettyBranchLabel - '' means unknown. */
  branch: string;
  wt: string; // worktree path (short display form)
  path: string | null; // absolute dir - spawn target
  collision: boolean;
  isIntegration: boolean;
  remote: boolean;
  /** Read-only LOCK state (restored from the v2 lane lock the port dropped).
   *  `readOnly` is the effective gate = auto (background dir, computed in Rust)
   *  OR the operator's manual lock. Blocks spawn/cast/fire into this lane. */
  readOnly: boolean;
  autoReadOnly: boolean; // computed background lane - not operator-toggleable
  userReadOnly: boolean; // operator's manual lock (fd_set_lane_readonly)
  /** Real +adds/−dels/files/ahead vs the repo's base branch (null for empty
   *  topology lanes and cloud/codex/cursor lanes with no local worktree diff). */
  diff: LaneDiff | null;
  /** Unarchived sessions beyond the backend's per-lane card cap (MAX_CARDS).
   *  Never silently trimmed - the deck header surfaces the honest total. */
  overflow: number;
}

export interface DeckRepo {
  id: string;
  name: string; // pretty label, lowercased for the deck's typography
  path: string; // display path
  root: string; // absolute root
  hue: string;
  mainLine: string; // "⎇ main @ abc123 · clean" style summary
  merge: boolean; // any lane has landed work queued for merge (best-effort)
}

export interface DeckModel {
  repos: DeckRepo[];
  lanes: DeckLane[];
  sessions: DeckSession[];
  laneById: Record<string, DeckLane>;
  repoById: Record<string, DeckRepo>;
  generatedAt: number;
  /** ACTIVE WINDOW in ms (0 = no time filter) - what the deck's window chip shows. */
  activeWindowMs: number;
  
  hiddenOlder: number;
  hiddenOtherAccount: number;
  hiddenAccounts: { email: string; count: number }[];
  hiddenSubagents: number;
  hiddenProbes: number;
  hiddenPraxis: number;
  hiddenAutomation: number;
  hiddenPlaceholders: number;
  activeCount: number;
  runningCount: number;
}

// Stable hue assignment - praxis first, then by label; palette from the design.
// Values byte-identical to the original hex array, sourced from the deck tokens.
const REPO_HUES = [COLORS.accent, COLORS.teal, COLORS.pink, COLORS.statusPending, COLORS.blue, COLORS.lime, COLORS.magenta, COLORS.cyan];

function shortPath(p: string | null): string {
  if (!p) return '';
  return p.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, '~').replace(/\\/g, '/');
}

// Mirrors flightdeck.rs RECENT_MS: a live process with no transcript activity for
// this long is PARKED, not working. Surfacing it as IDLE keeps the deck's
// LIVE/FIRING counts honest - a 4h47m "working" card is almost always a stale or
// forgotten process, never real active work.
// STATUS TIER ONLY: this constant never gates card visibility. Visibility is the
// backend ACTIVE WINDOW (flightdeck.rs) - unarchived, on a current Claude
// account, and running or active within the window.
const PARKED_AFTER_MS = 30 * 60 * 1000;

/**
 * The three states the owner asked for, kept distinct (2026-09-05):
 *   RUNNING - a prompt is actually going. `card.working`, derived backend-side
 *             from the transcript's last turn record. ONLY this orbits the brain.
 *   ACTIVE - the session is OPEN (live process, in Claude Code's sidebar) but no
 *             prompt is running. A window left open all day lives here.
 *   DONE - no live process.
 * Archived never reaches the client at all.
 *
 * The old rule was `running ? (ageMs >= 30min ? idle : working)`, which called any
 * open window "working" - and file mtime kept ageMs fresh because an idle session
 * writes attachment/queue-operation records constantly, so it never even aged out.
 */
function displayStatus(card: SessionCard): DeckStatus {
  return card.activity === 'running' || card.working ? 'working' : 'idle';
}

function sessionName(card: SessionCard, _laneLabel?: string, _repoLabel?: string): string {
  // Defense-in-depth over the backend sanitizer: strip any residual markdown bold /
  // code ticks so `**THE "RESEARCH UNTIL` can never reach the label.
  const strip = (s: string): string => s.replace(/\*\*/g, '').replace(/`/g, '').trim();
  // Show the backend title as-is (truncated). Do NOT substitute LANE · REPO for a
  // SESSION fallback - that made every untitled Codex card read "MAIN · PRAXIS".
  const t = strip(card.title ?? '');
  if (t) return t.length > 26 ? `${t.slice(0, 25)}…` : t;
  const p = strip(card.preview ?? '');
  // Never let raw XML/tag scaffolding (e.g. "<recommended_plugins>") become a name.
  if (p && !p.startsWith('<')) {
    const words = p.split(/\s+/).slice(0, 3).join(' ');
    return words.length > 26 ? `${words.slice(0, 25)}…` : words;
  }
  // Absolute last resort - strip any driver prefix ("cursor:" / "codex:") so the id
  // fallback can never read as "SESSION CURSOR" / "SESSION CODEX". Cursor cards
  // must never use SESSION xxxxxx (name, else first prompt, else "Cursor").
  const bareId = card.id.replace(/^[a-z]+:/, '');
  if (card.id.startsWith('cursor:')) return 'Cursor';
  return `SESSION ${bareId.slice(0, 6).toUpperCase()}`;
}

/** A lane is named by its FOLDER, never by its position in the list: `lane-a` is
 *  LANE A even when it sorts third (2026-09-24 the deck showed praxis-lanes\lane-a as
 *  "LANE C"). trading-bot's single-letter folders map the same way; any other folder
 *  keeps its own name. Position is only the last resort for a lane with no path. */
export function laneLetterFor(path: string | null | undefined, isMain: boolean, fallbackIndex: number): string {
  if (isMain) return 'MAIN';
  const base = (path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const m = /^lane-([a-z0-9]+)$/i.exec(base) ?? /^([a-z])$/i.exec(base);
  if (m) return `LANE ${m[1].toUpperCase()}`;
  if (base) return `LANE ${base.toUpperCase()}`;
  return `LANE ${String.fromCharCode(65 + fallbackIndex)}`;
}

function laneLetterName(index: number, lane: Lane): string {
  if (lane.isIntegration) return 'MAIN';
  return laneLetterFor(lane.path, false, index);
}

/** Compact real-diff summary for a lane: "+214 −38 · ↑2" (empty when no diff/all
 *  zero). Uses the true minus sign (−) to match the design package's "+214 −38". */
/** "NOW" / "12M" / "1H 05" elapsed label - shared by the board cards and the
 *  dock's LAST ACTIVE stat so the two can never disagree. */
export function fmtElapsed(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return 'NOW';
  if (m < 60) return `${m}M`;
  return `${Math.floor(m / 60)}H ${String(m % 60).padStart(2, '0')}`;
}

export function laneDiffLabel(d: LaneDiff | null | undefined): string {
  if (!d) return '';
  const parts: string[] = [];
  if (d.added || d.deleted) parts.push(`+${d.added} −${d.deleted}`);
  if (d.ahead) parts.push(`↑${d.ahead}`);
  return parts.join(' · ');
}

/**
 * Build the deck view model from the live snapshot + the on-disk topology.
 * Topology supplies the full real repo fleet (auto-discovered git repos), so
 * quiet repos still render; the snapshot layers sessions/collisions on top.
 */
export function buildDeck(
  snapshot: LanesSnapshot | null,
  topology: TopologySnapshot | null,
  praxisSpawned: readonly SpawnMark[] = [],
): DeckModel {
  const repos: DeckRepo[] = [];
  const lanes: DeckLane[] = [];
  const sessions: DeckSession[] = [];
  // Operator lane locks, from the backend. A lane that exists ONLY in the
  // topology scan is absent from repos[].lanes, so this is the only place its
  // real lock state can come from.
  const lockedLanes = new Set(snapshot?.readOnlyLanes ?? []);

  const appendSession = (s: SessionCard, l: Lane | null, groupLabel?: string): void => {
    const { fresh } = sessionAttribution(s, s.cwd, praxisSpawned);
    const manual = s.owner === 'zach';
    const driver = (sessionDriver(s.id, l?.driver) ?? 'claude') as Driver;
    // A real approval gate (backend `wants`) only reads as BLOCKED for a live
    // session that is the owner's OWN hands - the fleet's headless sessions skip
    // permissions, so a pending tool there is normal execution, never a gate.
    const wants = s.wants ?? null;
    const blocked = Boolean(wants) && s.running && manual;
    sessions.push({
      id: s.id,
      owner: s.owner,
      activity: s.activity,
      groupLabel,
      name: sessionName(s),
      // The tool that ran THIS session. A folded-in Codex/Cursor card keeps its
      // own identity instead of inheriting the lane's.
      driver,
      agent: manual ? 'you' : agentForDriver(driver),
      // The model badge on the card. Every driver reports one (the Claude
      // session store carries `model`, codex/cursor carry their own), so the
      // card shows it - it used to read "LEGACY SESSION" for anything that
      // wasn't codex, which was every Claude session the owner runs, and threw
      // away a real value the backend had already resolved. The driver name
      // is only the fallback for a session whose model is genuinely unknown.
      model: s.modelLabel ?? s.model ?? (driver === 'codex' ? 'CODEX' : driver === 'cursor' ? 'CURSOR' : 'CLAUDE'),
      effort: s.effort,
      status: blocked ? 'blocked' : displayStatus(s),
      lastActiveMs: s.ageMs,
      laneId: l?.id ?? '',
      manual,
      peeks: [s.preview ?? s.branch ?? '—'].filter(Boolean) as string[],
      running: s.running,
      working: s.working ?? false,
      // Real pid from the backend's liveness check. It used to be hardcoded
      // null, so STOP could only ever appear for a session Praxis spawned in
      // THIS window's lifetime - i.e. essentially never, which is why
      // fd_stop_session was real and completely unreachable.
      pid: s.pid ?? null,
      cwd: s.cwd,
      fresh,
      wants: blocked ? wants : null,
    });
  };
  for (const group of snapshot?.groups ?? []) {
    for (const card of group.sessions) appendSession(card, null, group.label);
  }

  // Canonical repo identity = the NORMALIZED root path. The two sources spell the
  // same folder differently - the snapshot's root comes from `git worktree list`
  // (forward slashes) while the topology's comes from a Windows PathBuf
  // (backslashes) - so the old `root.toLowerCase()` key never matched and one
  // folder rendered TWICE (a rich session block + an empty duplicate). Normalize
  // slashes + trailing slash + case (mirrors Rust `norm_path`) so a repo has ONE
  // identity, then MERGE the two sources on it: the discovered topology fleet is
  // the base, session data layers on, never concatenated → no duplicate groups.
  const canonRoot = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  // Emit a session-bearing repo: rich lanes + sessions + real diffs from the live
  // snapshot. When a topology entry exists for the same root, any of its worktrees
  // NOT already covered by a live lane are appended as quiet empty lanes so nothing
  // on disk is dropped (matched by canonical path so a worktree is never doubled).
  const emitSnapRepo = (r: Repo, topo: TopologyRepo | null): void => {
    repos.push({
      id: r.id,
      name: r.label.toLowerCase().replace(/\s+/g, '-'),
      path: shortPath(r.root),
      root: r.root,
      hue: '', // assigned after the full list settles (stable ordering)
      mainLine: '',
      merge: false,
    });
    let li = 0;
    const covered = new Set<string>();
    const laneOrder = [...r.lanes].sort((a, b) => Number(b.isIntegration) - Number(a.isIntegration));
    for (const l of laneOrder) {
      if (l.remote) continue; // cloud lanes render once they have local truth
      // A repo's own checkout is MAIN even when it has no lane folders (command-deck read
      // "LANE COMMAND-DECK" because a lone worktree is never tagged integration).
      const isRepoRoot = !!l.path && canonRoot(l.path) === canonRoot(r.root);
      const letter = isRepoRoot ? 'MAIN' : laneLetterName(l.isIntegration ? 0 : li, l);
      if (!l.isIntegration && !isRepoRoot) li += 1;
      if (l.path) covered.add(canonRoot(l.path));
      lanes.push({
        id: l.id,
        repoId: r.id,
        letter,
        branch: prettyBranchLabel(l.branch, l.head),
        wt: shortPath(l.path),
        path: l.path,
        collision: l.collision,
        isIntegration: l.isIntegration,
        remote: l.remote,
        readOnly: l.readOnly,
        autoReadOnly: l.autoReadOnly,
        userReadOnly: l.userReadOnly,
        diff: l.diff ?? null,
        overflow: l.overflow ?? 0,
      });
      for (const s of l.sessions) {
        // Backend ownership and visibility are authoritative.
        appendSession(s, l);
      }
    }
    // Quiet worktrees the live snapshot didn't surface (rare - the snapshot already
    // walks `git worktree list`) still render as empty lanes so the on-disk fleet
    // is whole. The letter sequence continues from the live lanes above.
    for (const wt of topo?.worktrees ?? []) {
      if (covered.has(canonRoot(wt.path))) continue;
      const letter = laneLetterFor(wt.path, wt.isMain, li);
      if (!wt.isMain) li += 1;
      lanes.push({
        id: laneIdForPath(wt.path),
        repoId: r.id,
        letter,
        branch: wt.branch ?? '—',
        wt: shortPath(wt.path),
        path: wt.path,
        collision: false,
        isIntegration: wt.isMain,
        remote: false,
        // Real lock state, from the snapshot's operator-lock set. Hardcoding
        // false here is what stopped a lock on a quiet repo ever coming back.
        readOnly: lockedLanes.has(laneIdForPath(wt.path)),
        autoReadOnly: false,
        userReadOnly: lockedLanes.has(laneIdForPath(wt.path)),
        diff: null, // quiet topology-only lane - no live snapshot diff yet
        overflow: 0,
      });
    }
  };

  const emitTopoRepo = (tr: TopologyRepo): void => {
    const id = laneIdForPath(tr.id);
    repos.push({
      id,
      name: tr.label.toLowerCase().replace(/\s+/g, '-'),
      path: shortPath(tr.root),
      root: tr.root,
      hue: '',
      mainLine: '',
      merge: false,
    });
    let li = 0;
    for (const wt of tr.worktrees) {
      const letter = laneLetterFor(wt.path, wt.isMain, li);
      if (!wt.isMain) li += 1;
      lanes.push({
        id: laneIdForPath(wt.path),
        repoId: id,
        letter,
        branch: wt.branch ?? '—',
        wt: shortPath(wt.path),
        path: wt.path,
        collision: false,
        isIntegration: wt.isMain,
        remote: false,
        readOnly: lockedLanes.has(laneIdForPath(wt.path)),
        autoReadOnly: false,
        userReadOnly: lockedLanes.has(laneIdForPath(wt.path)),
        diff: null,
        overflow: 0,
      });
    }
  };

  // Index session-bearing repos by canonical root, then merge. The discovered
  // topology fleet defines the column order (praxis first, then alphabetical) and
  // each entry is ONE group: a topology repo that also has live sessions renders
  // from the snapshot (rich); a quiet one renders empty; a session-bearing repo the
  // scan didn't find (outside Desktop\ / tools\) is appended after, praxis-first.
  const snapRepos = snapshot?.repos ?? [];
  const snapByRoot = new Map<string, Repo>();
  for (const r of snapRepos) snapByRoot.set(canonRoot(r.root), r);

  const placed = new Set<string>();
  for (const tr of topology?.repos ?? []) {
    // Dedup identity = the git-resolved MAIN WORKTREE path. TopologyRepo.id is
    // norm_path(git worktree[0].path) - the SAME string the snapshot puts in
    // Repo.root (both come from `git worktree list`). tr.root, by contrast, is the
    // raw Desktop\ directory PathBuf, which differs from git's stored path whenever
    // that folder is a junction/relocated (the owner's Desktop repos are) - keying on it
    // let the same repo render twice (rich snapshot group + quiet topology group).
    // Keying on tr.id makes the two sources agree, so each repo shows once.
    const c = canonRoot(tr.id);
    if (placed.has(c)) continue; // topology itself never lists a root twice, but stay safe
    placed.add(c);
    const snap = snapByRoot.get(c);
    if (snap) emitSnapRepo(snap, tr);
    else emitTopoRepo(tr);
  }
  const snapOnly = [...snapRepos]
    .filter((r) => !placed.has(canonRoot(r.root)))
    .sort((a, b) => {
      const ap = /praxis/i.test(a.label) ? 0 : 1;
      const bp = /praxis/i.test(b.label) ? 0 : 1;
      return ap - bp || a.label.localeCompare(b.label);
    });
  for (const r of snapOnly) {
    // The filter above is evaluated eagerly, so two snapshot repos sharing one
    // canonical root would both survive it - guard inside the loop too.
    const c = canonRoot(r.root);
    if (placed.has(c)) continue;
    placed.add(c);
    emitSnapRepo(r, null);
  }

  // Stable hue assignment over the final ordering.
  repos.forEach((r, i) => {
    r.hue = REPO_HUES[i % REPO_HUES.length];
    const repoLanes = lanes.filter((l) => l.repoId === r.id);
    const main = repoLanes.find((l) => l.isIntegration);
    const anyColl = repoLanes.some((l) => l.collision);
    const live = sessions.some((s) => repoLanes.some((l) => l.id === s.laneId) && s.status === 'working');
    // MAIN's real working-tree state, from `git status --porcelain` on the
    // integration lane. "MAIN CLEAN" used to be an unconditional literal prefix on
    // every one of these strings - a repo with 40 uncommitted files on main still
    // read MAIN CLEAN. When the diff hasn't been computed for this lane yet the
    // word is omitted entirely rather than guessed.
    const dirty = main?.diff?.dirtyFiles;
    const mainState =
      dirty === undefined ? 'MAIN' : dirty > 0 ? `MAIN ${dirty} DIRTY` : 'MAIN CLEAN';
    r.mainLine = anyColl
      ? `${mainState} · ⚠ SHARED LANE`
      : live
        ? `${mainState} · WORKING`
        : `${mainState} · QUIET`;
    // MERGE QUEUED now requires something that actually IS queued: commits on a
    // non-integration lane that main does not have. The old rule was "the repo has
    // >1 lane, nothing is working, and some session finished", which is not
    // evidence about merges at all.
    const readyToMerge = repoLanes.some((l) => !l.isIntegration && (l.diff?.ahead ?? 0) > 0);
    r.merge = Boolean(main?.branch && readyToMerge);
    if (r.merge) r.mainLine = `${mainState} · MERGE QUEUED`;
  });

  return {
    repos,
    lanes,
    sessions,
    laneById: Object.fromEntries(lanes.map((l) => [l.id, l])),
    repoById: Object.fromEntries(repos.map((r) => [r.id, r])),
    generatedAt: snapshot?.generatedAt ?? Date.now(),
    // Default to 24h (flightdeck.rs DEFAULT_ACTIVE_WINDOW_MS) before the first
    // snapshot lands so the chip never flashes a window the backend is not using.
    activeWindowMs: snapshot?.activeWindowMs ?? 24 * 60 * 60_000,
    hiddenOlder: snapshot?.hiddenOlder ?? 0,
    hiddenOtherAccount: snapshot?.hiddenOtherAccount ?? 0,
    hiddenAccounts: snapshot?.hiddenAccounts ?? [],
    hiddenSubagents: snapshot?.hiddenSubagents ?? 0,
    hiddenProbes: snapshot?.hiddenProbes ?? 0,
    hiddenPraxis: snapshot?.hiddenPraxis ?? 0,
    hiddenAutomation: snapshot?.hiddenAutomation ?? 0,
    hiddenPlaceholders: snapshot?.hiddenPlaceholders ?? 0,
    activeCount: snapshot?.activeCount ?? 0,
    runningCount: snapshot?.runningCount ?? 0,
  };
}

/**
 * Deviations from the Claude Design package - every one deliberate, every one
 * in the direction of honesty (no fabricated state on screen):
 *
 * 1. Session progress %: the package animates a fake per-session progress bar.
 *    Real sessions report no % - the bar renders only when a real progress
 *    signal exists (today: never), exactly like the package's `prog: null`
 *    manual-session path. No invented numbers.
 * 3. Elapsed chip shows time since LAST ACTIVITY (transcript mtime - real),
 *    not "elapsed since start" (start times don't exist backend-side).
 * 4. Session ✉ MESSAGE / ⌁ STEER continue that exact Claude/Codex conversation
 *    through its supported CLI resume command. A busy turn is persisted and
 *    delivered when free; unsupported Cursor/cloud sessions say so plainly.
 * 5. Live-session "peek" is the session's real transcript preview line; the
 *    package cycled through 3-4 demo lines per card.
 * 6. Manual (YOU) detection = backend origin !== praxis, unless a SpawnMark
 *    joins this card by pid (Claude) or by a unique recent cwd+driver
 *    (Codex/Cursor, which expose no pid). The synthetic fd- session id is
 *    never the join key - cards carry the CLI session UUID.
 * 8. The package's mock OS title strip ("Praxis · Flight Deck" + ─ ▢ ✕) is not
 *    rendered - the real window already has chrome. Header nav tabs (BRAIN /
 *    GALAXY / COMMAND) are kept and wired to the real window-open commands.
 * 9. The Agent Flow pull-up drops the package's invented Quartz artifact/link
 *    counts and fake "SNAPSHOT 15:29" clock. Volatile actor/model/rail facts
 *    come from fleet configuration + live plan names, Atlas records a durable
 *    daily validation stamp (and rechecks on config changes), and the existing
 *    topology/trust seams remain live.
 */
export const DECK_DEVIATIONS = 9;
