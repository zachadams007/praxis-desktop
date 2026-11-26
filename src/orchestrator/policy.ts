/**
 * policy.ts - reads Command Center kill-toggles + exec-mode from localStorage
 * and exposes functions the orchestrator consults before each step.
 *
 * localStorage keys (canonical source: src/command/controlStore.ts):
 *   praxis.tools.v1    → JSON object { claude: bool, codex: bool, cursor: bool,
 *                                       openrouter: bool, hermes: bool, "computer-use": bool }
 *   praxis.execmode.v1 → "live" | "hybrid" | "background"
 *
 * All functions are defensive: localStorage unavailable or missing key → safe default.
 *
 * What each toggle gates (every ToolKey in controlStore TOOL_ROWS is REAL - none decorative):
 *   claude / codex / cursor  → requested driver when enabled; Codex is the safe
 *                               default fallback while optional CLIs are unavailable
 *   openrouter               → selectedBrainWithGate() / boardRouteForSelection() via
 *                               isToolEnabled("openrouter") - metered brain/board route
 *                               only when explicitly enabled
 *   hermes                   → isHermesEnabled() - orchestrator skips hermes_brain plan AND the
 *                               verify/iterate loop when off (single direct pass)
 *   computer-use             → isComputerUseEnabled() - Live mode blocked when off; graceful
 *                               degrade path emits status without cursor-steal
 */

import { loadAutonomy, type AutonomyKey } from "@/shared/autonomy";
import {
  unattendedDecision,
  type ActionClass,
  type AutonomyDecision,
} from "@/shared/autonomyPolicy";
import type { ExecMode } from "@/command/controlStore";
import { defaultModelForTool } from "@/command/fleetStore";
import { TOOL_DEFAULTS, readToolToggles } from "@/shared/toolPolicyPersistence";
import { formatClock, rememberedToolFailure, type DriverTool } from "./drivers";
import type { BrainDumpKind } from "./parse";

// ── Constants (must match controlStore.ts exactly) ────────────────────────────

const EXECMODE_KEY = "praxis.execmode.v1";


const CODING_TOOLS: DriverTool[] = ["codex", "claude", "cursor"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeLocalStorage(): Storage | null {
  try {
    // In a non-browser environment (e.g. Node/Tauri backend) `localStorage`
    // is undefined - guard silently.
    if (typeof localStorage !== "undefined") return localStorage;
    return null;
  } catch {
    return null;
  }
}

/** Read the raw toggle map. Returns an empty object on any failure. */
function readToggleMap(): Partial<Record<string, boolean>> {
  try {
    const store = safeLocalStorage();
    if (!store) return {};
    return readToolToggles(store);
  } catch {
    return {};
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true when the given tool is allowed to run.
 *
 * A stored choice wins. With no stored settings, use Command Center defaults.
 * Unrecognised tools remain enabled for backwards compatibility.
 */
export function isToolEnabled(tool: string): boolean {
  try {
    const map = readToggleMap();
    const stored = map[tool];
    if (typeof stored === "boolean") return stored;
    return (TOOL_DEFAULTS as Record<string, boolean>)[tool] ?? true;
  } catch {
    return (TOOL_DEFAULTS as Record<string, boolean>)[tool] ?? true;
  }
}

/**
 * Returns the current execution mode persisted by the Command Center.
 * Falls back to "hybrid" when localStorage is unavailable or the stored
 * value is unrecognised.
 */
export function currentExecMode(): ExecMode {
  try {
    const store = safeLocalStorage();
    if (!store) return "hybrid";
    const raw = store.getItem(EXECMODE_KEY);
    if (raw === "live" || raw === "hybrid" || raw === "background") return raw;
    return "hybrid";
  } catch {
    return "hybrid";
  }
}

/**
 * Returns true when Hermes PLANNING is enabled (the Command Center's "Hermes planning" toggle).
 * When disabled, the orchestrator skips the hermes_brain planning call and falls back directly
 * to a single-step plan using the default driver. This does NOT control the :9119 Hermes
 * gateway/dashboard sidecar itself - that process is managed independently by
 * `ensure_dashboard()`/`spawn_observer()` in hermes_bridge.rs and stays up regardless of this
 * toggle (previously the "Hermes" label implied otherwise - renamed to avoid that).
 */
export function isHermesEnabled(): boolean {
  return isToolEnabled("hermes");
}

/**
 * Returns true when Computer Use is enabled.
 * When false, "Live" mode is blocked - the orchestrator degrades to Hybrid
 * behaviour and emits a clear status rather than silently no-opping.
 */
export function isComputerUseEnabled(): boolean {
  return isToolEnabled("computer-use");
}

/**
 * What the trust dial permits an UNATTENDED run to do right now.
 *
 * This module is the policy the unattended orchestrator consults, and until now
 * it had no autonomy function at all - `src/orchestrator/unattended.ts` never
 * read the dial, and only the Rust `flow_runner` did, as a single bool. So the
 * dial's main effect was on LIVE voice actions (which it should not govern) and
 * it was nearly absent from unattended runs (which it should be the sole
 * authority over). Exactly backwards. This is the missing half.
 *
 * Live actions never call this. See src/shared/actionOrigin.ts.
 */
export function unattendedAutonomy(): AutonomyKey {
  return loadAutonomy();
}

/** May an unattended run do this, and is a human asked first?
 *
 *  Call sites read this object (allowed + approval), not a boolean wrapper -
 *  `src/orchestrator/unattended.ts` is the consumer.
 */
export function unattendedPolicy(action: ActionClass): AutonomyDecision {
  return unattendedDecision(loadAutonomy(), action);
}

/** True when the Command Center's HALT ALL breaker is thrown (`praxis.halted.v1`). */
export function isHalted(): boolean {
  try {
    const store = safeLocalStorage();
    return store?.getItem("praxis.halted.v1") === "1";
  } catch {
    return false;
  }
}

/**
 * Given the requested tool, returns the tool that should actually be used:
 *   - the requested Claude/Codex/Cursor rail when its breaker is enabled,
 *   - null when every coding rail is disabled.
 */
export function resolveToolOrNull(requested: DriverTool): DriverTool | null {
  if (isToolEnabled(requested)) return requested;
  for (const candidate of CODING_TOOLS) {
    if (isToolEnabled(candidate)) return candidate;
  }
  return null;
}

/**
 * The fleet-panel default model for a delegation tool (Command Center's Fleet
 * panel, `src/command/fleetStore.ts`). Consulted by the orchestrator ONLY when
 * the brain's own plan didn't pin a per-step model - the brain's choice always
 * wins when present; this is the floor underneath it, not an override.
 * Returns undefined when unset ("CLI default" selected) so the CLI's own
 * configured default applies, same as omitting --model entirely.
 */
export function defaultModelFor(tool: DriverTool): string | undefined {
  return defaultModelForTool(tool);
}

// ═══════════════════════════════════════════════════════════════════════════
// Live tool availability (2026-09-12)
//
// resolveToolOrNull() above answers "is this rail ALLOWED?" (the Command Center
// breaker). It never asked "is this rail USABLE right now?" - so a brain dump
// would be routed to Codex while Codex was out of its usage window, or to
// cursor-agent while the binary was not on the machine, and the answer came
// back as a tool error minutes later instead of a sentence up front.
//
// This section answers the second question from LIVE signals, never a
// hardcoded preference:
//   claude - the frontend failure memory (drivers.ts, mirrors hermes_bridge.rs's
//             explain_claude_failure + 120s TTL) plus the install probe.
//   codex - install probe, ~/.codex/auth.json presence (logged in), and the
//             real `usage_summary` plan rows: a window Codex itself reports as
//             ≥99% used with a future reset is "out of usage until <time>".
//             Ledger ESTIMATES are never allowed to declare a rail dark.
//   cursor - the same install candidates hermes_bridge.rs::resolve_bin probes;
//             none present ⇒ not installed (identical semantics to run_cursor).
// Every probe is injectable so the headless test drives the exact decisions.
// ═══════════════════════════════════════════════════════════════════════════

export type AvailabilitySource =
  | "ok"
  | "breaker"
  | "failure-memory"
  | "not-installed"
  | "not-logged-in"
  | "usage"
  | "folder";

export interface ToolAvailability {
  tool: DriverTool;
  usable: boolean;
  /** One sentence naming the fix. Present whenever !usable. */
  reason?: string;
  /** Unix ms when the rail is worth retrying, if known (usage windows). */
  retryAt?: number;
  source: AvailabilitySource;
}

export type FleetAvailability = Record<DriverTool, ToolAvailability>;

/** Wire shape of one `usage_summary` plan row (mirrors usage.rs PlanLimit). */
export interface PlanLimitRow {
  label: string;
  window: string;
  used: number;
  limit: number;
  unit: string;
  basis?: string;
  resets_at?: number | null;
  /** When a blocking condition began (the `refused` sentinel row). */
  since_ms?: number | null;
}

export interface AvailabilityProbe {
  /** Live plan-limit rows keyed by tool (real: Tauri `usage_summary`). */
  planUsage?: () => Promise<Array<{ key: string; plan: PlanLimitRow[] }>>;
  /** Does an absolute path exist (real: Tauri `path_exists`). */
  pathExists?: (path: string) => Promise<boolean>;
  /** Well-known dirs (real: @tauri-apps/api/path). */
  dirs?: () => Promise<{ home: string; localData: string; data: string }>;
  now?: () => number;
}

/** Windows dir join that tolerates a trailing separator from the path API. */
function winJoin(dir: string, rel: string): string {
  return `${dir.replace(/[\\/]+$/, "")}\\${rel}`;
}

/** Same candidates as hermes_bridge.rs::resolve_bin, per tool. */
function installCandidates(tool: DriverTool, d: { home: string; localData: string; data: string }): string[] {
  switch (tool) {
    case "claude":
      return [winJoin(d.home, ".local\\bin\\claude.exe")];
    case "codex":
      return [winJoin(d.data, "npm\\codex.cmd"), winJoin(d.home, ".local\\bin\\codex.exe")];
    case "cursor":
      return [
        winJoin(d.localData, "cursor-agent\\cursor-agent.cmd"),
        winJoin(d.home, ".local\\bin\\cursor-agent.exe"),
        winJoin(d.home, ".local\\bin\\cursor-agent.cmd"),
        winJoin(d.home, ".local\\bin\\cursor-agent"),
        winJoin(d.data, "npm\\cursor-agent.cmd"),
      ];
  }
}

function breakerReason(tool: DriverTool): string {
  const label = tool === "claude" ? "Claude" : tool === "codex" ? "Codex" : "Cursor";
  return `${label} is switched off in Command Center → Tool switches; turn it on to route work there`;
}

/** Codex's own window report: ≥99% used with a live reset ⇒ out of usage until then. */
export function codexUsageExhaustion(
  rows: Array<{ key: string; plan: PlanLimitRow[] }>,
  now: number,
): { reason: string; retryAt?: number } | null {
  const codex = rows.find((r) => r.key === "codex");
  if (!codex) return null;
  for (const p of codex.plan) {
    if (p.basis !== "real" || !(p.limit > 0)) continue; // an estimate can't declare a rail dark
    const frac = p.used / p.limit;
    if (frac < 0.99) continue;
    const resets = typeof p.resets_at === "number" && p.resets_at > now ? p.resets_at : undefined;
    const win = p.window === "5h" ? "5h" : p.window === "weekly" ? "weekly" : p.window;
    return {
      reason: resets
        ? `Codex is out of its ${win} usage until ${formatClock(resets, now)}`
        : `Codex reports its ${win} usage window is exhausted; wait for it to reset or route elsewhere`,
      ...(resets ? { retryAt: resets } : {}),
    };
  }
  return null;
}

/** Live Cursor pools, including the API-allowed case where both pools are empty. */
export interface CursorPoolSnapshot {
  models_pool_pct?: number | null;
  api_pool_pct?: number | null;
  exhausted?: boolean;
  api_pool_allowed?: boolean;
  resets_at_ms?: number | null;
  note?: string;
}
export function cursorPoolExhaustion(pool: CursorPoolSnapshot, now = Date.now()): { reason: string; retryAt?: number } | null {
  const ownEmpty = pool.exhausted || (pool.models_pool_pct ?? 0) >= 99.5;
  const apiEmpty = (pool.api_pool_pct ?? 0) >= 99.5;
  if (!pool.note && !(ownEmpty && (!pool.api_pool_allowed || apiEmpty)) && !(pool.api_pool_allowed && apiEmpty)) return null;
  const retryAt = pool.resets_at_ms && pool.resets_at_ms > now ? pool.resets_at_ms : undefined;
  return { reason: pool.note || `Cursor is out of usage${retryAt ? ` until ${formatClock(retryAt, now)}` : ""}`, ...(retryAt ? { retryAt } : {}) };
}

/** Real usage bars only; estimated token ledgers must never bench a rail. */
export function railUsageExhaustion(tool: DriverTool, rows: Array<{ key: string; plan: PlanLimitRow[] }>, now: number): { reason: string; retryAt?: number } | null {
  if (rows.find((r) => r.key === tool)?.plan.some((p) => p.window === "auth")) return { reason: `${tool} is signed out; authentication is required` };
  // the vendor refusing Claude Code for this account: no retry instant exists - it lasts
  // until Anthropic allows it again, and the backend re-checks on its own.
  const refused = rows.find((r) => r.key === tool)?.plan.find((p) => p.window === "refused");
  if (refused) {
    const since = refused.since_ms ? ` since ${formatClock(refused.since_ms, now)}` : "";
    return { reason: `The vendor is refusing Claude Code${since}, so Forge can't run` };
  }
  if (tool === "codex") return codexUsageExhaustion(rows, now);
  if (tool !== "claude") return null;
  const row = rows.find((r) => r.key === tool)?.plan.find((p) => p.basis === "real" && p.limit > 0 && p.used >= p.limit);
  if (!row) return null;
  const retryAt = row.resets_at && row.resets_at > now ? row.resets_at : undefined;
  return { reason: `Claude is out of ${row.window} usage${retryAt ? ` until ${formatClock(retryAt, now)}` : ""}`, ...(retryAt ? { retryAt } : {}) };
}

/** Availability bookkeeping cannot consume a build step. */
export function isAvailabilityOnlyStep(prompt: string): boolean {
  return /^(?:check|verify|record|document|wait|confirm|report|note)\b/i.test(prompt.trim()) &&
    /(?:availability|out of usage|quota|usage limit|signed out|sign.in|blocker|(?:cursor|quill|claude|forge|codex|vega).*(?:available|accessible|unavailable|blocked))/i.test(prompt);
}

async function firstExisting(paths: string[], exists: (p: string) => Promise<boolean>): Promise<string | null> {
  for (const p of paths) {
    try {
      if (await exists(p)) return p;
    } catch {
      /* probe failed - treat as absent, keep looking */
    }
  }
  return null;
}

/** Live usability of ONE rail. Cheap; every probe is optional and failure-tolerant. */
export async function toolAvailability(tool: DriverTool, probe: AvailabilityProbe = {}): Promise<ToolAvailability> {
  const now = probe.now?.() ?? Date.now();

  // 1) Command Center breaker - the owner's explicit choice always wins.
  if (!isToolEnabled(tool)) {
    return { tool, usable: false, reason: breakerReason(tool), source: "breaker" };
  }

  // 2) A fresh remembered failure (drivers.ts) - the precise reason, at once.
  const remembered = rememberedToolFailure(tool, now);
  if (remembered) {
    const age = Math.round(remembered.ageMs / 1000);
    return {
      tool,
      usable: false,
      reason: `${remembered.reason} (seen ${age}s ago)`,
      ...(remembered.retryAt ? { retryAt: remembered.retryAt } : {}),
      source: "failure-memory",
    };
  }

  // 3) Install / login probes (only when the runtime can look at the disk).
  if (probe.pathExists && probe.dirs) {
    let dirs: { home: string; localData: string; data: string } | null = null;
    try {
      dirs = await probe.dirs();
    } catch {
      dirs = null;
    }
    if (dirs) {
      const found = await firstExisting(installCandidates(tool, dirs), probe.pathExists);
      if (!found && tool === "cursor") {
        // resolve_bin falls back to the bare name ⇒ run_cursor refuses. Same rule here.
        return {
          tool,
          usable: false,
          reason: "cursor-agent is not installed on this machine — install it with: irm 'https://cursor.com/install?win32=true' | iex",
          source: "not-installed",
        };
      }
      // claude/codex: a missing candidate is NOT decisive - Rust falls back to PATH
      // at spawn time. Only a failure memory can mark them uninstalled.
      if (tool === "codex") {
        const auth = winJoin(dirs.home, ".codex\\auth.json");
        let loggedIn = true;
        try {
          loggedIn = await probe.pathExists(auth); // presence only - never read
        } catch {
          loggedIn = true; // probe failure ⇒ don't invent a login problem
        }
        if (!loggedIn) {
          return { tool, usable: false, reason: "Codex CLI is not logged in — run `codex login` in a terminal", source: "not-logged-in" };
        }
      }
    }
  }

  // 4) Usage windows - Codex reports its own; only a REAL row may decide.
  if (probe.planUsage) {
    try {
      const rows = await probe.planUsage();
      const out = railUsageExhaustion(tool, rows, now);
      if (out) {
        return { tool, usable: false, reason: out.reason, ...(out.retryAt ? { retryAt: out.retryAt } : {}), source: "usage" };
      }
    } catch {
      /* usage unavailable - say nothing rather than guess */
    }
  }

  return { tool, usable: true, source: "ok" };
}

const ALL_TOOLS: DriverTool[] = ["codex", "claude", "cursor"];

/** Live usability of every rail, probed in parallel. */
export async function fleetAvailability(probe: AvailabilityProbe = {}): Promise<FleetAvailability> {
  const [codex, claude, cursor] = await Promise.all(ALL_TOOLS.map((t) => toolAvailability(t, probe)));
  return { codex, claude, cursor };
}

/** Availability when nothing can be probed: breaker + failure memory only. */
export function staticAvailability(now = Date.now()): FleetAvailability {
  const one = (tool: DriverTool): ToolAvailability => {
    if (!isToolEnabled(tool)) return { tool, usable: false, reason: breakerReason(tool), source: "breaker" };
    const r = rememberedToolFailure(tool, now);
    if (r) return { tool, usable: false, reason: `${r.reason} (seen ${Math.round(r.ageMs / 1000)}s ago)`, ...(r.retryAt ? { retryAt: r.retryAt } : {}), source: "failure-memory" };
    return { tool, usable: true, source: "ok" };
  };
  return { codex: one("codex"), claude: one("claude"), cursor: one("cursor") };
}

/** The one sentence that explains why NOTHING can run: every rail's reason, joined. */
export function unroutableReason(avail: FleetAvailability): string {
  const parts = ALL_TOOLS.map((t) => avail[t]).filter((a) => !a.usable).map((a) => a.reason ?? `${a.tool} is unavailable`);
  return parts.length ? parts.join("; ") : "no coding rail is usable right now";
}

export type ToolRoute =
  | { tool: DriverTool; rerouted: boolean; reason?: undefined }
  | { tool: null; rerouted: false; reason: string };

/**
 * Pick the rail a step should ACTUALLY run on:
 *   - the requested rail when it is enabled AND usable right now,
 *   - else the preferred rail (a brain-dump task's chosen tool), if usable,
 *   - else the first usable rail in the safe fallback order,
 *   - else null with ONE sentence per dark rail naming its fix.
 */
export function resolveUsableTool(
  requested: DriverTool,
  avail: FleetAvailability,
  preferred?: DriverTool,
): ToolRoute {
  if (avail[requested]?.usable) return { tool: requested, rerouted: false };
  if (preferred && avail[preferred]?.usable) return { tool: preferred, rerouted: true };
  for (const candidate of CODING_TOOLS) {
    if (avail[candidate]?.usable) return { tool: candidate, rerouted: true };
  }
  return { tool: null, rerouted: false, reason: unroutableReason(avail) };
}

/**
 * Route one brain-dump task by kind. Notes never go to a coding tool (they are
 * filed, not dispatched). Builds and investigations take the first usable rail;
 * the order is the same safe fallback resolveToolOrNull uses, so availability -
 * not a brand preference - is what actually decides.
 */
export function routeTaskKind(kind: BrainDumpKind, avail: FleetAvailability): ToolRoute {
  if (kind === "note" || kind === "unclassified") {
    return { tool: null, rerouted: false, reason: kind === "note" ? "a note is filed, not dispatched" : "unclassified — say whether this is a build, an investigation or a note" };
  }
  return resolveUsableTool(CODING_TOOLS[0], avail);
}

// ── Default (Tauri) probe ─────────────────────────────────────────────────────

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * The real probe: existing Tauri commands only (`usage_summary`, `path_exists`)
 * plus the path API for well-known dirs. Outside Tauri returns an empty probe so
 * decisions fall back to breaker + failure memory - never a fabricated "usable".
 */
export function defaultAvailabilityProbe(): AvailabilityProbe {
  if (!inTauri()) return {};
  const invoke = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  };
  return {
    planUsage: () => invoke<Array<{ key: string; plan: PlanLimitRow[] }>>("usage_summary"),
    pathExists: (path) => invoke<boolean>("path_exists", { path }),
    dirs: async () => {
      const { homeDir, localDataDir, dataDir } = await import("@tauri-apps/api/path");
      const [home, localData, data] = await Promise.all([homeDir(), localDataDir(), dataDir()]);
      return { home, localData, data };
    },
  };
}

// Snapshot cache: one brain dump probes once, not once per task per step.
const AVAIL_CACHE_MS = 15_000;
let availCache: { at: number; value: FleetAvailability } | null = null;

/** Cached live availability (≤15s old). `force` re-probes - used right after a failure. */
export async function liveAvailability(force = false, probe?: AvailabilityProbe): Promise<FleetAvailability> {
  const now = Date.now();
  if (!force && availCache && now - availCache.at < AVAIL_CACHE_MS) return availCache.value;
  const value = await fleetAvailability(probe ?? defaultAvailabilityProbe());
  availCache = { at: now, value };
  return value;
}

/** Drop the snapshot (a failure was just remembered; the next read must be fresh). */
export function invalidateAvailability(): void {
  availCache = null;
}
