/**
 * flows.ts - thin typed bindings to the NATIVE orchestration engine
 * (src-tauri/src/flow_runner.rs).
 *
 * The FlowRunner is Praxis running orchestration flows ITSELF: it spawns real
 * `claude -p` / `codex exec` / `cursor-agent` processes in parallel waves, watches
 * each to terminal, runs a verify command, retries a failed lane once, and persists
 * crash-safe state - no Claude Code orchestrator session babysitting it. See the
 * north star [[praxis-is-the-orchestrator-north-star]].
 *
 * These wrappers are the ONLY thing the frontend needs; all engine logic is Rust.
 * Every call is guarded so this module is safe to import in a plain browser (dev):
 * a missing Tauri runtime rejects with a clear message rather than throwing at
 * import time.
 *
 * Progress is push-based: subscribe to `praxis://flow-progress` (full FlowState on
 * every transition) via onFlowProgress() rather than polling flowStatus().
 */

// ── Types (mirror flow_runner.rs's serde camelCase shapes exactly) ─────────────

export type FlowStatus = "running" | "done" | "failed" | "halted" | "stopped";
export type LaneStatus =
  | "pending"
  | "running"
  | "verifying"
  | "retrying"
  | "done"
  | "failed-escalate";
export type WaveStatus = "pending" | "running" | "done";

/** One lane as authored in a definition / inline flow request. */
export interface LaneSpec {
  id?: string;
  driver: "claude" | "codex" | "cursor";
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** Shell verify run in cwd after the process exits (e.g. "npx tsc --noEmit"). */
  verify?: string;
  /** Per-lane wall-clock cap (seconds); omitted → engine default (45 min). */
  timeoutSecs?: number;
}

export interface WaveSpec {
  label?: string;
  lanes: LaneSpec[];
}

/** An inline flow definition (alternative to a saved definition id). */
export interface FlowDefinition {
  id: string;
  label?: string;
  waves: WaveSpec[];
}

/** Live per-lane state from the engine. */
export interface LaneState {
  id: string;
  driver: string;
  prompt: string;
  cwd?: string;
  model?: string;
  verify?: string;
  timeoutSecs: number;
  status: LaneStatus;
  pid?: number;
  attempt: number;
  log: string;
  failure?: string;
  startedAt: number;
  endedAt: number;
}

export interface WaveState {
  label: string;
  status: WaveStatus;
  lanes: LaneState[];
}

/** The whole flow - the payload of `praxis://flow-progress` and flowStatus(). */
export interface FlowState {
  flowId: string;
  definitionId: string;
  label: string;
  status: FlowStatus;
  currentWave: number;
  waves: WaveState[];
  params: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  hadFailures: boolean;
  hadRetries: boolean;
}

// ── Guarded invoke (safe in a plain browser) ───────────────────────────────────

function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!inTauri()) {
    throw new Error("native flows require the Praxis desktop runtime (Tauri not present)");
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

// ── Commands ────────────────────────────────────────────────────────────────────

/**
 * Start a flow. `definition` is EITHER a saved definition id (e.g. "delegate",
 * "overnight" - loaded from %LOCALAPPDATA%\Praxis\flows\definitions\<id>.json) OR
 * an inline FlowDefinition object. `params` fill `{token}` slots in lane
 * prompts/cwds. Returns the new flowId.
 *
 * Rejects (spawning NOTHING) when the trust dial is below III (EXECUTE/SOVEREIGN)
 * or the HALT breaker is thrown - the engine enforces both gates before any lane.
 */
export function flowStart(
  definition: string | FlowDefinition,
  params?: Record<string, string>,
): Promise<string> {
  return invoke<string>("flow_start", { definition, params: params ?? null });
}

/** Current persisted state of one flow (for a cockpit that missed live events). */
export function flowStatus(flowId: string): Promise<FlowState> {
  return invoke<FlowState>("flow_status", { flowId });
}

/** Stop a flow: kill its live lane processes and mark it "stopped". */
export function flowStop(flowId: string): Promise<void> {
  return invoke<void>("flow_stop", { flowId });
}

/** Every persisted flow, newest first - the cockpit's flow list. */
export function flowList(): Promise<FlowState[]> {
  return invoke<FlowState[]>("flow_list", {});
}

/**
 * Subscribe to live flow progress. The callback fires with the full FlowState on
 * every engine transition (wave advance, lane spawn/terminal, retry). Returns an
 * unlisten function; no-ops (returns a noop unlisten) outside Tauri.
 */
export async function onFlowProgress(
  cb: (state: FlowState) => void,
): Promise<() => void> {
  if (!inTauri()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<FlowState>("praxis://flow-progress", (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}
