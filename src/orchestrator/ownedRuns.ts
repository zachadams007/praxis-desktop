/** Exact-owner lifecycle for ordinary detached orchestrator work.
 *
 * Hybrid acknowledgements return before background orchestration finishes. This
 * registry keeps the owner, cancellation signal, and exact terminal promise
 * together so scoped HALT/session teardown cannot report terminal while that
 * background work is still running.
 */

export type OwnedOrchestrationStopState = "requested" | "idle";

interface OwnedRunRecord {
  ownerToken: string;
  controller: AbortController;
  terminal: Promise<unknown>;
}

const activeRuns = new Map<string, Set<OwnedRunRecord>>();
const DEFAULT_TERMINAL_TIMEOUT_MS = 5_000;

function normalizedOwner(ownerToken?: string): string | null {
  const owner = ownerToken?.trim() || "";
  return owner || null;
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => target.abort();
  if (source.aborted) target.abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

/** Register before invoking `run`, closing the dynamic-import/pre-admission gap. */
export function startOwnedOrchestration<T>(
  ownerToken: string | undefined,
  upstreamSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const owner = normalizedOwner(ownerToken);
  const controller = new AbortController();
  const unlink = linkAbortSignal(upstreamSignal, controller);

  if (!owner) {
    return Promise.resolve()
      .then(() => run(controller.signal))
      .finally(unlink);
  }

  let record!: OwnedRunRecord;
  const terminal = Promise.resolve()
    .then(() => run(controller.signal))
    .finally(() => {
      unlink();
      const ownerRuns = activeRuns.get(owner);
      ownerRuns?.delete(record);
      if (ownerRuns?.size === 0) activeRuns.delete(owner);
    });
  record = { ownerToken: owner, controller, terminal };
  const ownerRuns = activeRuns.get(owner) ?? new Set<OwnedRunRecord>();
  ownerRuns.add(record);
  activeRuns.set(owner, ownerRuns);
  return terminal;
}

async function waitForRecordsTerminal(
  records: OwnedRunRecord[],
  timeoutMs: number,
): Promise<void> {
  if (records.length === 0) return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.all(records.map((record) => record.terminal.then(() => undefined, () => undefined))),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for owned orchestration to become terminal.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Abort and await every exact run registered to one voice/tool owner. */
export async function stopOwnedOrchestration(
  ownerToken: string,
  timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS,
): Promise<OwnedOrchestrationStopState> {
  const owner = normalizedOwner(ownerToken);
  if (!owner) return "idle";
  const records = [...(activeRuns.get(owner) ?? [])];
  if (records.length === 0) return "idle";
  for (const record of records) record.controller.abort();
  await waitForRecordsTerminal(records, timeoutMs);
  return "requested";
}

/** Explicit global sibling reserved for HALT ALL. */
export async function stopAllOwnedOrchestrations(
  timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS,
): Promise<OwnedOrchestrationStopState> {
  const records = [...activeRuns.values()].flatMap((ownerRuns) => [...ownerRuns]);
  if (records.length === 0) return "idle";
  for (const record of records) record.controller.abort();
  await waitForRecordsTerminal(records, timeoutMs);
  return "requested";
}

/** Read-only test/diagnostic surface; never mutates ownership. */
export function ownedOrchestrationCount(ownerToken: string): number {
  const owner = normalizedOwner(ownerToken);
  return owner ? activeRuns.get(owner)?.size ?? 0 : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Brain-dump run ledger (2026-09-12)
//
// The registry above tracks WHO owns a running promise so a scoped stop can find it. It says
// nothing about what a brain dump turned into. Persisted to localStorage (capped) so it survives
// a reload; a run that was mid-flight when the window closed is marked "stopped" on the next
// read, never left looking alive.
// ═══════════════════════════════════════════════════════════════════════════

export type BrainDumpRunState =
  | "queued" // routable kind, but no rail is usable right now - waiting, not lost
  | "running"
  | "done" // the orchestrator VERIFIED the goal done
  | "failed" // ran, did not reach done (or the tool errored)
  | "stopped" // cancelled / window closed mid-run
  | "noted" // a note: filed, deliberately not dispatched
  | "unclassified"; // kept, needs the owner to say what it is

export interface BrainDumpRunRecord {
  runId: string;
  dumpId: string;
  taskId: string;
  /** Verbatim words this run came from. */
  text: string;
  ask: string;
  kind: "build" | "investigate" | "note" | "unclassified";
  tool: "claude" | "codex" | "cursor" | null;
  folder: string | null;
  state: BrainDumpRunState;
  /** Why it is queued/unclassified/failed - one sentence naming the fix. */
  reason: string | null;
  /** What the run reported when it ended. */
  summary: string | null;
  steps: number;
  okSteps: number;
  startedAt: number;
  endedAt: number | null;
}

const LEDGER_KEY = "praxis.braindump.runs.v1";
const LEDGER_CAP = 200;

let ledger: BrainDumpRunRecord[] | null = null;
const ledgerListeners = new Set<(runs: BrainDumpRunRecord[]) => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function loadLedger(): BrainDumpRunRecord[] {
  if (ledger) return ledger;
  let parsed: BrainDumpRunRecord[] = [];
  try {
    const raw = storage()?.getItem(LEDGER_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) parsed = v.filter((r): r is BrainDumpRunRecord => typeof r === "object" && r !== null && typeof (r as { runId?: unknown }).runId === "string");
  } catch {
    parsed = [];
  }
  // Anything still "running" from a previous process is not running now.
  for (const r of parsed) {
    if (r.state === "running") {
      r.state = "stopped";
      r.reason = r.reason ?? "the window closed before this run finished";
      r.endedAt = r.endedAt ?? Date.now();
    }
  }
  ledger = parsed;
  return ledger;
}

function saveLedger(): void {
  if (!ledger) return;
  if (ledger.length > LEDGER_CAP) ledger.splice(0, ledger.length - LEDGER_CAP);
  try {
    storage()?.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    /* storage full/unavailable - the in-memory ledger still serves this session */
  }
  const snapshot = [...ledger];
  for (const cb of ledgerListeners) {
    try {
      cb(snapshot);
    } catch {
      /* a listener must never break the dispatcher */
    }
  }
}

let runSeq = 0;
/** Unique-enough id for one run: time + per-process sequence. */
export function nextBrainDumpRunId(prefix = "run"): string {
  runSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${runSeq.toString(36)}`;
}

/** Upsert one record (by runId) and notify listeners. */
export function recordBrainDumpRun(rec: BrainDumpRunRecord): BrainDumpRunRecord {
  const runs = loadLedger();
  const i = runs.findIndex((r) => r.runId === rec.runId);
  if (i >= 0) runs[i] = rec;
  else runs.push(rec);
  saveLedger();
  return rec;
}

/** Patch one record's fields by runId; no-op when unknown. */
export function patchBrainDumpRun(runId: string, patch: Partial<BrainDumpRunRecord>): BrainDumpRunRecord | null {
  const runs = loadLedger();
  const i = runs.findIndex((r) => r.runId === runId);
  if (i < 0) return null;
  runs[i] = { ...runs[i], ...patch };
  saveLedger();
  return runs[i];
}

/** Every record, oldest first - optionally for one dump only. */
export function listBrainDumpRuns(dumpId?: string): BrainDumpRunRecord[] {
  const runs = loadLedger();
  return dumpId ? runs.filter((r) => r.dumpId === dumpId) : [...runs];
}

/** Subscribe to ledger changes (full snapshot each time). Returns unsubscribe. */
export function onBrainDumpRuns(cb: (runs: BrainDumpRunRecord[]) => void): () => void {
  ledgerListeners.add(cb);
  return () => ledgerListeners.delete(cb);
}

/** Test/diagnostic reset - clears memory + storage. Never called by product code. */
export function clearBrainDumpRuns(): void {
  ledger = [];
  try {
    storage()?.removeItem(LEDGER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * One honest sentence for a dump's runs. Never says "done" for anything the
 * orchestrator did not verify done; never hides a queued or unclassified piece.
 */
export function brainDumpRunSummary(runs: BrainDumpRunRecord[]): string {
  if (runs.length === 0) return "Nothing in that to act on — I heard no task.";
  const by = (s: BrainDumpRunState) => runs.filter((r) => r.state === s);
  const dispatched = runs.filter((r) => r.tool !== null && r.state !== "queued");
  const parts: string[] = [];
  if (dispatched.length) {
    const tools = [...new Set(dispatched.map((r) => r.tool))].join("/");
    const done = by("done").length;
    const failed = by("failed").length;
    const running = by("running").length;
    const stopped = by("stopped").length;
    const outcome = [
      done ? `${done} done` : "",
      failed ? `${failed} failed` : "",
      running ? `${running} running` : "",
      stopped ? `${stopped} stopped` : "",
    ].filter(Boolean).join(", ");
    parts.push(`${dispatched.length} dispatched to ${tools}${outcome ? ` (${outcome})` : ""}`);
  }
  const queued = by("queued");
  if (queued.length) {
    const reasons = [...new Set(queued.map((r) => r.reason).filter(Boolean))].join("; ");
    parts.push(`${queued.length} queued — ${reasons || "no rail is usable right now"}`);
  }
  const noted = by("noted").length;
  if (noted) parts.push(`${noted} noted`);
  const un = by("unclassified").length;
  if (un) parts.push(`${un} unclassified — say what ${un === 1 ? "it is" : "they are"} and I'll route ${un === 1 ? "it" : "them"}`);
  const head = `${runs.length} task${runs.length === 1 ? "" : "s"}`;
  if (!dispatched.length) return `${head} — nothing dispatched: ${parts.join("; ")}.`;
  return `${head}: ${parts.join("; ")}.`;
}
