/**
 * controlStore - Command Center tool-kill toggles + execution-mode state.
 *
 * useToolToggles() - one boolean per tool; independent; persisted to localStorage.
 * useExecMode() - 3-way Live / Hybrid / Background mode; persisted to localStorage.
 *
 * The real channel is localStorage, read at call time by src/orchestrator/policy.ts
 * (isToolEnabled / currentExecMode) - there is no cross-window event bus for these.
 *
 * Both hooks: localStorage best-effort (silent on failure).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { mirrorSet } from "@/shared/persist";
import {
  TOOLS_KEY,
  TOOL_DEFAULTS,
  readToolToggles,
  type PersistedToolKey,
} from "@/shared/toolPolicyPersistence";
import { visibleInterval } from "@/shared/visibility";

// ----------------------------------------------------------------- types ---

export type ToolKey = PersistedToolKey;

/** Per-model breakdown row from the Rust `usage_snapshot`. */
export interface ModelUsage {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** Unix ms of the most recent recorded run (0 = never / pre-dates this field). */
  last_run_ms: number;
}

/**
 * Anthropic (and Kimi/NVIDIA NIM) expose no API for this, so these are computed Rust-side from a
 * locally observed append-only ledger (`usage.jsonl`) aggregated into rolling windows, compared
 * against a hand-maintained limit table. A source can carry BOTH a `5h` entry and a `weekly`
 * entry (Claude Max has both).
 */
export interface PlanUsage {
  label: string;
  window: "5h" | "weekly" | "credits" | "rpm" | "auth" | "refused" | "paused" | "limit";
  used: number;
  limit: number;
  unit: "msgs" | "tokens" | "credits" | "requests" | "percent";
  /** True when `limit` is an observed estimate, not a published quota - render an "est." marker. */
  estimated: boolean;
  /**
   * Precise basis of the LIMIT figure (preferred over `estimated` for wording):
   *  - "real" - live/authoritative (Codex's own %, Cursor's own count, NVIDIA cap)
   *  - "learned" - empirically learned from a real signal (Claude Max cap)
   *  - "estimated" - a hand-maintained observed band (last-resort fallback)
   */
  basis?: "real" | "learned" | "estimated";
  /** Fleet agent that owns keeping this source real (e.g. "Forge", "Vega", "Lens"). */
  owner?: string;
  /** ISO timestamp of the next reset, when known (rolling windows usually don't have one). */
  resetsAt?: string;
  /** Account email the meter measures, when the backend source provides one. */
  account?: string;
  /** ISO time a blocking condition began (the `refused` sentinel row: the vendor refusing Claude Code). */
  since?: string;
}

/** Shape returned by the Rust `usage_summary` Tauri command. */
interface PlanUsageRow {
  key: string;
  plan: RawPlanLimit[];
}

/** Wire shape of one Rust `PlanLimit` entry (snake_case, as serialized). */
interface RawPlanLimit {
  label: string;
  window: string;
  used: number;
  limit: number;
  unit: string;
  estimated: boolean;
  basis?: string;
  owner?: string;
  resets_at?: number | null;
  account?: string | null;
  since_ms?: number | null;
}

/** Shape returned by the Rust `usage_snapshot` Tauri command (W6a). */
export interface ToolUsage {
  key: string;
  label: string;
  spent_usd: number;
  limit_usd: number | null;
  status: string;
  live: boolean;
  /**
   * Backend signal that THIS rail's numbers are affected by a usage-system fault.
   * Scoped per rail: a ledger fault sets it everywhere locally metered, an OpenAI
   * Realtime accounting fault sets it on the OpenAI row only.
   */
  persistence_degraded?: boolean;
  /** The specific fault, in a sentence - present only when `persistence_degraded`. */
  degraded_reason?: string;
  /**
   * Unix ms of the last OpenAI credit refusal actually observed on this key, or
   * absent when none is on record. A measurement, not an inference from `spent_usd` -
   * an API key cannot read a balance, so this is the only credit fact Praxis has.
   */
  no_credit_since_ms?: number;
  /** Per-model breakdown (populated when token data has been accumulated). */
  models: ModelUsage[];
}

/** Shape the UsagePanel in ControlPanel.tsx renders. */
export interface UsageSource {
  key: string;
  label: string;
  /** Spend in USD so far this billing period. */
  spend: number;
  /** Hard limit in USD, if known. */
  limit?: number;
  unit: string;
  /** "live" = real-time query; "est" = estimated/accumulated locally; "idle" = unused. */
  status: "live" | "est" | "idle";
  /** Per-model breakdown (empty when no token data has been accumulated yet). */
  models: ModelUsage[];
  
  isSubscription: boolean;
  /** Unix ms of the last observed credit refusal on this rail, if any. */
  noCreditSinceMs?: number;
  /**
   * Plan-relative usage bars (5h / weekly / rpm windows), merged in from the
   * `usage_summary` Tauri command. Empty/absent when this source has no modeled
   * plan limit (e.g. Hermes) - the UI renders nothing extra in that case.
   */
  plan?: PlanUsage[];
  /** True when this row was synchronously hydrated from the last good local snapshot. */
  hydratedFromCache?: boolean;
  /** True while a cache-hydrated row is waiting for the first live refresh. */
  refreshing?: boolean;
  /** Unix ms when the cached usage snapshot was written. */
  usageSnapshotMs?: number;
  /**
   * True when this row is showing CARRIED-OVER (not-live) data because the most
   * recent refresh failed for it - the dollar meter (`usage_snapshot`) succeeded but
   * the plan bars (`usage_summary`) didn't, or the whole fetch threw. The UI marks it
   * "as of <time>" instead of letting stale numbers silently pose as live.
   */
  stale?: boolean;
  /** Unix ms of the last time THIS row's data was actually live (for the "as of" note). */
  staleAsOfMs?: number;
  /** This rail's own numbers are affected by a usage-system fault; values stay visible but marked. */
  persistenceDegraded?: boolean;
  /** What is actually wrong with this rail, for the caption. */
  degradedReason?: string;
}
export type ExecMode = "live" | "hybrid" | "background";

export interface ToolToggleRow {
  key: ToolKey;
  label: string;
  hint: string;
}

// ---------------------------------------------------------------- catalog ---

export const TOOL_ROWS: ToolToggleRow[] = [
  { key: "claude",       label: "Claude CLI",     hint: "Requires CLI sign-in; off by default and never a paid API fallback" },
  { key: "codex",        label: "Codex",          hint: "Gates the Codex subscription brain rail and Codex CLI steps" },
  { key: "cursor",       label: "Cursor",         hint: "Gates Cursor IDE steps; falls back to Codex when off" },
  { key: "openrouter",   label: "OpenRouter",     hint: "Gates the metered OpenRouter brain rail; no free-tier assumption" },
  // Label deliberately says "Hermes planning" not bare "Hermes" - this only gates the
  // hermes_brain CLI planning call, NOT the :9119 dashboard/gateway sidecar (that's managed
  // separately by ensure_dashboard()/spawn_observer() and has its own health signal - see
  // praxis://hermes-degraded). Toggling this off does NOT kill or disconnect the gateway.
  { key: "hermes",       label: "Hermes planning", hint: "Off = skip the Hermes brain PLAN call, run direct single-step (does not affect the :9119 gateway/dashboard)" },
  { key: "computer-use", label: "Computer Use",   hint: "Off = Live mode blocked; must be on to let Praxis touch your screen" },
];

// ---------------------------------------------------------------- exec mode labels ---

export const EXEC_MODE_META: Record<ExecMode, { label: string; hint: string }> = {
  live:       { label: "Live",       hint: "All tasks run through visible apps; Zach can watch every action" },
  hybrid:     { label: "Hybrid",     hint: "Background by default; specifically-flagged tasks run live" },
  background: { label: "Background", hint: "All background; Praxis runs flows itself through the native engine — spawns, watches, verifies, retries (away mode)" },
};

// --------------------------------------------------------------- constants ---

const EXECMODE_KEY = "praxis.execmode.v1";
const USAGE_SNAPSHOT_KEY = "praxis.usage.snapshot.v1";
const DEFAULT_MODE: ExecMode = "hybrid";

// --------------------------------------------------------------- storage helpers ---

function loadTools(): Record<ToolKey, boolean> {
  try {
    return readToolToggles(localStorage);
  } catch {
    return { ...TOOL_DEFAULTS };
  }
}

function saveTools(v: Record<ToolKey, boolean>): void {
  try {
    const body = JSON.stringify(v);
    localStorage.setItem(TOOLS_KEY, body);
    mirrorSet(TOOLS_KEY, body);
  } catch { /* best-effort */ }
}

function loadMode(): ExecMode {
  try {
    const raw = localStorage.getItem(EXECMODE_KEY);
    if (raw === "live" || raw === "hybrid" || raw === "background") return raw;
    return DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

function saveMode(m: ExecMode): void {
  try {
    localStorage.setItem(EXECMODE_KEY, m);
    mirrorSet(EXECMODE_KEY, m);
  } catch { /* best-effort */ }
}

// --------------------------------------------------------------- hooks ---

export interface ToolToggleStore {
  toggles: Record<ToolKey, boolean>;
  setTool: (key: ToolKey, enabled: boolean) => void;
}

/**
 * Fired whenever a tool breaker changes from ANYWHERE. Same contract as
 * EXEC_MODE_EVENT.
 *
 * Without this, flipping a breaker in Command Center left every OTHER window
 * showing the old state until it was reopened - `useToolToggles` seeded itself
 * from localStorage once at mount and never re-read. The owner hit exactly that:
 * enabled Claude and Cursor in Command Center, went back to the main window, and
 * they were still red. The breakers WERE live; only the display was stale, which
 * is indistinguishable from a dead control.
 */
export const TOOLS_EVENT = "praxis:tool-toggles";

/** Tauri-side twin of TOOLS_EVENT. A DOM `storage` event is not reliably
 *  delivered between Tauri windows, so - exactly like fleetStore's model sync -
 *  the breaker change is ALSO emitted on the Tauri bus. Belt and braces: whichever
 *  arrives first wins, and both just re-read localStorage. */
const TOOLS_TAURI_EVENT = "praxis://tool-toggles";

function broadcastTools(next: Record<ToolKey, boolean>): void {
  try {
    window.dispatchEvent(new CustomEvent<Record<ToolKey, boolean>>(TOOLS_EVENT, { detail: next }));
  } catch {
    /* non-DOM environment - best-effort */
  }
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(TOOLS_TAURI_EVENT, next))
    .catch(() => {
      /* browser/dev view - no Tauri bus */
    });
}

/**
 * Module-level setter - safe to call outside React (voice commands, orchestrator).
 * Persists and broadcasts exactly like the hook's `setTool`.
 */
export function setToolEnabled(key: ToolKey, enabled: boolean): void {
  const next = { ...loadTools(), [key]: enabled };
  saveTools(next);
  broadcastTools(next);
}

export function useToolToggles(): ToolToggleStore {
  const [toggles, setToggles] = useState<Record<ToolKey, boolean>>(loadTools);

  const setTool = useCallback((key: ToolKey, enabled: boolean) => {
    setToggles((prev) => {
      const next = { ...prev, [key]: enabled };
      saveTools(next);
      broadcastTools(next);
      return next;
    });
  }, []);

  // Stay live when the change came from somewhere else: another component in
  // this window (custom event) or another Praxis window (storage event).
  useEffect(() => {
    const onToolsEvent = (e: Event) => {
      const detail = (e as CustomEvent<Record<ToolKey, boolean>>).detail;
      if (detail && typeof detail === "object") setToggles({ ...TOOL_DEFAULTS, ...detail });
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === TOOLS_KEY) setToggles(loadTools());
    };
    window.addEventListener(TOOLS_EVENT, onToolsEvent);
    window.addEventListener("storage", onStorage);

    // Cross-WINDOW sync over the Tauri bus. `cancelled` guards the unmount-
    // before-listen()-resolves race, the same way the rest of the app does.
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen(TOOLS_TAURI_EVENT, () => setToggles(loadTools())))
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {
        /* browser/dev view - no Tauri bus */
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      window.removeEventListener(TOOLS_EVENT, onToolsEvent);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return { toggles, setTool };
}

export interface ExecModeStore {
  mode: ExecMode;
  setMode: (m: ExecMode) => void;
}

/** Fired whenever the exec mode changes from ANYWHERE (React setter below, or the
 *  module-level `setExecMode` voice/chat execution calls) - every mounted
 *  `useExecMode()` consumer (RightDock, Command Center) re-reads localStorage and
 *  updates live, even across components that don't share React state. */
export const EXEC_MODE_EVENT = "praxis:exec-mode";

/**
 * Plain module-level setter - safe to call outside React (voice/chat command
 * execution, orchestrator code). Persists exactly like the hook's setMode, then
 * dispatches a window event so every mounted `useExecMode()` picks up the change
 * live without needing to share a single React state instance.
 */
export function setExecMode(m: ExecMode): void {
  saveMode(m);
  try {
    window.dispatchEvent(new CustomEvent<ExecMode>(EXEC_MODE_EVENT, { detail: m }));
  } catch {
    /* non-DOM environment - best-effort */
  }
}

export function useExecMode(): ExecModeStore {
  const [mode, setModeState] = useState<ExecMode>(loadMode);

  const setMode = useCallback((m: ExecMode) => {
    setModeState(m);
    saveMode(m);
    try {
      window.dispatchEvent(new CustomEvent<ExecMode>(EXEC_MODE_EVENT, { detail: m }));
    } catch {
      /* non-DOM environment - best-effort */
    }
  }, []);

  // Subscribe to exec-mode changes fired from OUTSIDE this hook instance (the
  // module-level setExecMode above, e.g. a voice command or the trust-IV
  // auto-hybrid switch) so this component's view of the mode stays live.
  useEffect(() => {
    const onModeEvent = (e: Event) => {
      const detail = (e as CustomEvent<ExecMode>).detail;
      if (detail === "live" || detail === "hybrid" || detail === "background") setModeState(detail);
    };
    window.addEventListener(EXEC_MODE_EVENT, onModeEvent);
    // Cross-window sync, same pattern as useHalt's storage listener.
    const onStorage = (e: StorageEvent) => {
      if (e.key === EXECMODE_KEY && (e.newValue === "live" || e.newValue === "hybrid" || e.newValue === "background"))
        setModeState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EXEC_MODE_EVENT, onModeEvent);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return { mode, setMode };
}

// --------------------------------------------------------------- usage snapshot ---

interface UsageSnapshotCache {
  timestamp: number;
  sources: UsageSource[];
}

/**
 * Claude is shown as authentication-required until its CLI can prove an active route.
 */
/** Placeholder rows used when not in Tauri or `usage_snapshot` throws. */
const PLACEHOLDER_SOURCES: UsageSource[] = [
  { key: "nvidia",     label: "NVIDIA NIM",  spend: 0, unit: "free",       status: "est",  models: [], isSubscription: false },
  { key: "openai",     label: "OpenAI API",  spend: 0, limit: 5.0, unit: "USD · live", status: "idle", models: [], isSubscription: false },
  { key: "claude",     label: "Claude CLI",  spend: 0, unit: "sign-in required", status: "idle", models: [], isSubscription: false },
  { key: "codex",      label: "Codex",       spend: 0, unit: "on plan",    status: "est",  models: [], isSubscription: true  },
  { key: "cursor",     label: "Cursor",      spend: 0, unit: "on plan",    status: "est",  models: [], isSubscription: true  },
  { key: "openrouter", label: "OpenRouter",  spend: 0, unit: "USD · live", status: "idle", models: [], isSubscription: false },
  { key: "hermes",     label: "Hermes",      spend: 0, unit: "USD",        status: "idle", models: [], isSubscription: false },
];


const SUBSCRIPTION_KEYS = new Set(["cursor", "codex"]);

function toolUsageToSource(t: ToolUsage): UsageSource {
  // Never show a fabricated spend figure - label them "on plan" instead.
  const isSub = SUBSCRIPTION_KEYS.has(t.key);
  const isFreeProvider = t.key === "nvidia";
  const unit = isSub ? "on plan" : t.live ? "USD · live" : "USD";

  const displayUnit = isFreeProvider ? "free" : unit;
  const rawStatus = t.status.toLowerCase();
  let status: UsageSource["status"];
  if (rawStatus === "live") {
    status = "live";
  } else if (rawStatus === "idle") {
    status = "idle";
  } else {
    status = "est";
  }

  return {
    key: t.key,
    label: t.label,
    spend: isSub || isFreeProvider ? 0 : t.spent_usd,
    limit: isSub || isFreeProvider ? undefined : (t.limit_usd ?? undefined),
    unit: displayUnit,
    status,
    models: t.models ?? [],
    isSubscription: isSub,
    persistenceDegraded: t.persistence_degraded === true,
    degradedReason: t.degraded_reason,
    noCreditSinceMs: t.no_credit_since_ms,
  };
}

/** Convert one wire-shape `RawPlanLimit` into the camelCase `PlanUsage` the UI reads. */
function rawPlanLimitToPlanUsage(raw: RawPlanLimit): PlanUsage {
  return {
    label: raw.label,
    window: (raw.window as PlanUsage["window"]) ?? "5h",
    used: raw.used,
    limit: raw.limit,
    unit: (raw.unit as PlanUsage["unit"]) ?? "msgs",
    estimated: raw.estimated,
    basis: (raw.basis as PlanUsage["basis"]) ?? (raw.estimated ? "estimated" : "real"),
    owner: raw.owner || undefined,
    resetsAt: raw.resets_at != null ? new Date(raw.resets_at).toISOString() : undefined,
    account: raw.account || undefined,
    since: raw.since_ms != null ? new Date(raw.since_ms).toISOString() : undefined,
  };
}

/**
 * Fetch plan-relative usage bars from the Rust `usage_summary` command and key
 * them by source. Best-effort: returns an empty map on any failure (older builds
 * without the command registered, or not running in Tauri) so callers can merge
 * without special-casing failure.
 */
async function fetchPlanUsage(): Promise<{ planByKey: Map<string, PlanUsage[]>; ok: boolean }> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke<PlanUsageRow[]>("usage_summary");
    return {
      planByKey: new Map(rows.map((r) => [r.key, r.plan.map(rawPlanLimitToPlanUsage)])),
      ok: true,
    };
  } catch {
    return { planByKey: new Map(), ok: false };
  }
}

function stripUsageCacheFlags(sources: UsageSource[]): UsageSource[] {
  return sources.map(
    ({
      hydratedFromCache: _hydratedFromCache,
      refreshing: _refreshing,
      usageSnapshotMs: _usageSnapshotMs,
      stale: _stale,
      staleAsOfMs: _staleAsOfMs,
      ...source
    }) => source,
  );
}

function saveUsageSnapshot(sources: UsageSource[]): void {
  try {
    const payload: UsageSnapshotCache = {
      timestamp: Date.now(),
      sources: stripUsageCacheFlags(sources),
    };
    const body = JSON.stringify(payload);
    localStorage.setItem(USAGE_SNAPSHOT_KEY, body);
    mirrorSet(USAGE_SNAPSHOT_KEY, body);
  } catch {
    /* best-effort */
  }
}

function loadUsageSnapshot(): UsageSnapshotCache | null {
  try {
    const raw = localStorage.getItem(USAGE_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UsageSnapshotCache>;
    if (typeof parsed.timestamp !== "number" || !Array.isArray(parsed.sources)) return null;
    return { timestamp: parsed.timestamp, sources: parsed.sources };
  } catch {
    return null;
  }
}

function hydrateUsageSourcesFromCache(): UsageSource[] {
  const snapshot = loadUsageSnapshot();
  if (!snapshot) return PLACEHOLDER_SOURCES.map((source) => ({ ...source, refreshing: true }));
  return snapshot.sources.map((source) => ({
    ...source,
    hydratedFromCache: true,
    refreshing: true,
    usageSnapshotMs: snapshot.timestamp,
  }));
}

export function usageSnapshotPersistenceDegraded(rows: ToolUsage[]): boolean {
  return rows.some((row) => row.persistence_degraded === true);
}

async function fetchUsageSources(): Promise<{
  sources: UsageSource[];
  live: boolean;
  planOk: boolean;
  persistenceDegraded: boolean;
}> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const [raw, planResult] = await Promise.all([
      invoke<ToolUsage[]>("usage_snapshot"),
      fetchPlanUsage(),
    ]);
    const sources = raw.map((t) => {
      const source = toolUsageToSource(t);
      const plan = planResult.planByKey.get(t.key);
      return plan && plan.length > 0 ? { ...source, plan } : source;
    });
    const persistenceDegraded = usageSnapshotPersistenceDegraded(raw);
    // ── A DEGRADED FLAG IS A LABEL, NOT A FETCH FAILURE ─────────────────────
    // `live` used to be `!persistenceDegraded`. The command had SUCCEEDED and
    // returned real rows, but a degraded flag made `useUsage` take its hard-failure
    // branch, which DISCARDS `result.sources` and re-renders `lastGoodRef` instead.
    // So while the flag was set - on this machine, from 09:20 this morning until
    // The owner looked at the panel - not one rail ever updated again: the Codex, Cursor,
    // Claude and NVIDIA bars were frozen at whatever the localStorage cache held at
    // mount. That is the "none of the usage limits are actually accurate" report,
    // and it is why only the API-key rails looked plausible.
    //
    // `live` now means what its name says: the fetch worked. The degraded flag
    // still rides along per-rail, so the caption marks the affected rails without
    // throwing away the fresh numbers for all of them.
    // `planOk` distinguishes a full refresh from a partial one (snapshot live, plan
    // fetch failed) so the store can carry the last-good plan bars forward.
    return {
      sources,
      live: true,
      planOk: planResult.ok,
      persistenceDegraded,
    };
  } catch {
    // Not running in Tauri, or the usage command failed. "you have spent nothing" when the truth
    // is that nothing could be read. Mark them stale so the panel reports them as such.
    return {
      sources: PLACEHOLDER_SOURCES.map((source) => ({ ...source, stale: true })),
      live: false,
      planOk: false,
      persistenceDegraded: false,
    };
  }
}

export interface UsageStore {
  sources: UsageSource[];
  /** Re-fetch usage_snapshot + usage_summary. Resolves when the fetch settles. */
  refresh: () => Promise<void>;
  /** Unix ms of the last FULLY-live fetch (dollar meters + plan bars). 0 = none yet this session. */
  lastLiveMs: number;
  /** True while any rail is showing carried-over (not-live) data. */
  stale: boolean;
}

const USAGE_REFRESH_INTERVAL_MS = 30_000;

export function isLatestUsageRefresh(requestGeneration: number, latestGeneration: number): boolean {
  return requestGeneration === latestGeneration;
}

/** Re-tag sources as carried-over/stale, dropping the one-shot cache-hydration flags. */
function markStale(sources: UsageSource[], asOf: number | undefined): UsageSource[] {
  return sources.map(({ hydratedFromCache: _h, refreshing: _r, ...rest }) => ({
    ...rest,
    stale: true,
    staleAsOfMs: asOf,
  }));
}

function canCarryPlan(source: UsageSource): boolean {
  if (source.key !== "claude") return true;
  const text = `${source.label} ${source.unit}`.toLowerCase();
  return !/\b(expired|inactive|disabled|off)\b/.test(text);
}

export function useUsage(): UsageStore {
  const [sources, setSources] = useState<UsageSource[]>(hydrateUsageSourcesFromCache);
  const [lastLiveMs, setLastLiveMs] = useState<number>(() => loadUsageSnapshot()?.timestamp ?? 0);
  // Last FULLY-good sources (with real plan bars). Carried forward across a failed or
  // partial refresh so the plan rails (Claude / Codex / Cursor / NVIDIA) never
  // blank or silently reset to zero - the "some rails go stale, not all" bug.
  const lastGoodRef = useRef<UsageSource[]>(sources);
  const lastLiveRef = useRef<number>(lastLiveMs);
  const refreshGenerationRef = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    const requestGeneration = ++refreshGenerationRef.current;
    return fetchUsageSources().then((result) => {
      if (!isLatestUsageRefresh(requestGeneration, refreshGenerationRef.current)) return;
      // Full success - real dollar meters AND real plan bars. Replace everything,
      // clear the cache-hydration flags, persist, and stamp the live time.
      if (result.live && result.planOk) {
        const now = Date.now();
        // Persist only after this response wins the generation gate; an older
        // overlapping refresh must never regress startup cache truth.
        saveUsageSnapshot(result.sources);
        lastGoodRef.current = result.sources;
        lastLiveRef.current = now;
        setLastLiveMs(now);
        setSources(result.sources);
        return;
      }
      // Partial - usage_snapshot (dollar meters) is live but usage_summary (plan bars)
      // failed. Keep the fresh dollar rows, but CARRY the last-good plan bars forward
      // instead of dropping them, and mark those carried rails stale ("as of <time>").
      if (result.live) {
        const priorPlan = new Map(lastGoodRef.current.map((s) => [s.key, s.plan]));
        const asOf = lastLiveRef.current || undefined;
        const merged = result.sources.map((s) => {
          if (s.plan && s.plan.length > 0) return s;
          if (!canCarryPlan(s)) return s;
          const carried = priorPlan.get(s.key);
          return carried && carried.length > 0
            ? { ...s, plan: carried, stale: true, staleAsOfMs: asOf }
            : s;
        });
        lastGoodRef.current = merged;
        setSources(merged);
        return;
      }
      // Hard failure - usage_snapshot itself threw (not in Tauri, or the command
      // errored). Keep the last-good rows but SURFACE staleness; never let stale
      // numbers pose as live with no marker.
      const asOf = lastLiveRef.current || loadUsageSnapshot()?.timestamp;
      const carried = markStale(lastGoodRef.current, asOf);
      setSources(
        result.persistenceDegraded
          ? carried.map((source) => ({ ...source, persistenceDegraded: true }))
          : carried,
      );
    });
  }, []);

  useEffect(() => {
    // Immediate fetch on mount, then a 30s poll that pauses while the CC window is
    // hidden and fires one catch-up the instant it's visible again (shared/visibility.ts).
    refresh();
    const stop = visibleInterval(refresh, USAGE_REFRESH_INTERVAL_MS);
    return () => stop();
  }, [refresh]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("praxis://usage-refresh", () => { if (!disposed) void refresh(); }))
      .then((off) => { if (disposed) off(); else unlisten = off; })
      .catch((err) => console.error("[usage] refresh listener failed", err));
    // Listeners only read; re-emitting here would loop across open windows.
    return () => { disposed = true; unlisten?.(); };
  }, [refresh]);

  return { sources, refresh, lastLiveMs, stale: sources.some((s) => s.stale) };
}

// --------------------------------------------------------- per-agent run counts ---

/**
 * The named-agent identities in `src/shared/agents.ts` (Forge, Vega, Quill, ...) are a
 * frontend roster concept layered over the delegation `tool` string the Rust side
 * actually records usage against (`agent_delegate(tool, ...)` → `record_usage(tool, ...)`).
 * There is no separate per-agent-name backend counter - Forge and Vega both resolve to
 * a `tool` key ("claude" / "codex" / "cursor"), so a run count "per agent" is the same
 * data as the tool's aggregate call count, just relabeled with the codename that tool
 * delegates through. This mapping is the ONLY place that association lives.
 */
const AGENT_NAME_FOR_TOOL: Partial<Record<string, string>> = {
  claude: "Forge",
  codex: "Vega",
  cursor: "Quill",
};

export interface AgentRunSummary {
  /** Codename shown in the UI ("Forge", "Vega", "Quill"). */
  agent: string;
  /** Underlying delegation tool key this codename runs through. */
  tool: string;
  /** Total delegation runs recorded across all models for this tool. */
  runs: number;
  /** Unix ms of the most recent recorded run (0 = never run this session). */
  lastRunMs: number;
}

/**
 * Aggregate `UsageSource.models[].calls` (+ `last_run_ms`) per delegation tool and
 * relabel with the codename that tool delegates through. Returns only agents that
 * have actually run at least once - no fabricated zero rows.
 */
export function agentRunSummary(sources: UsageSource[]): AgentRunSummary[] {
  const out: AgentRunSummary[] = [];
  for (const src of sources) {
    const agent = AGENT_NAME_FOR_TOOL[src.key];
    if (!agent) continue;
    const runs = src.models.reduce((sum, m) => sum + m.calls, 0);
    if (runs === 0) continue;
    const lastRunMs = src.models.reduce((max, m) => Math.max(max, m.last_run_ms), 0);
    out.push({ agent, tool: src.key, runs, lastRunMs });
  }
  return out.sort((a, b) => b.lastRunMs - a.lastRunMs);
}

/** Format a Unix-ms timestamp as a short relative age ("4m ago", "2h ago", "just now"). */
export function fmtAgo(ms: number): string {
  if (!ms) return "never";
  const deltaS = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (deltaS < 30) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.floor(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.floor(deltaM / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  const deltaD = Math.floor(deltaH / 24);
  return `${deltaD}d ago`;
}
