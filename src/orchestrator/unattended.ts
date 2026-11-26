/**
 * unattended.ts - the "go do everything" entry point (Pending #1, 2026-07-02 handoff).
 *
 * The iteration-budget mechanism already existed in orchestrator.ts
 * (iterationBudget() / UNATTENDED_MAX_ITERS=500 vs INTERACTIVE_MAX_ITERS=10) but
 * nothing ever passed `unattended: true` - this module is that missing call site,
 * plus the three things a real unattended run needs beyond the flag itself:
 *
 *   1. SCOPE - no single goal is spoken ("go do everything" names nothing), so the
 *      goal handed to orchestrate() is built from the Command Center to-do store
 *      (localStorage `praxis.todo.v1`, shared across all Tauri webviews) + the
 *      intent ledger's "Open now" section (Rust `memory_todo_open_now`, same data
 *      todoStore.ts's useMemoryTodos() surfaces in the panel).
 *   2. VISIBILITY - one module-level "is a run active" flag + label, so the fast
 *      router (and any future UI) can show/announce it without re-deriving state.
 *   3. CANCELLATION - an AbortController threaded into orchestrate()'s new
 *      `opts.signal`, wired to the SAME "stop"/"stand down" halt path the router
 *      already uses for the Live-mode operator (see hybridRouter.ts's onHalt).
 *
 * Kept OUT of hybridRouter.ts itself (a large file already) so the scope-building
 * and lifecycle logic is independently testable - see scripts/test-unattended.cjs.
 */

import { unattendedPolicy } from "./policy";

// ── Goal scope: to-do store + memory ledger "Open now" ───────────────────────

/** Mirrors TodoTask in src/command/todoStore.ts (only the fields we need here). */
interface StoredTask {
  text: string;
  status: "upcoming" | "done";
  source: "manual" | "roadmap" | "voice" | "memory";
}

const TODO_STORAGE_KEY = "praxis.todo.v1";

/**
 * Read the Command Center to-do list DIRECTLY from localStorage rather than the
 * useTodoStore() hook - the Hybrid voice session runs in the brain window, a
 * separate webview from the Command Center, but Tauri webviews of the same app
 * share the same localStorage origin, so this is a safe, hook-free read. Never
 * throws: any failure (private mode, corrupt JSON, no window) yields [].
 */
function readUpcomingTodos(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(TODO_STORAGE_KEY);
    if (!raw) return [];
    const tasks = JSON.parse(raw) as StoredTask[];
    if (!Array.isArray(tasks)) return [];
    // Real tasks (manual/voice/memory) first, roadmap filler last - mirrors the
    // same ordering todoStore.ts's useTodoStore() applies for the visible slots,
    // so the unattended goal reflects what the owner actually SEES in the panel.
    const upcoming = tasks.filter((t) => t && t.status === "upcoming" && typeof t.text === "string");
    const real = upcoming.filter((t) => t.source !== "roadmap");
    const roadmap = upcoming.filter((t) => t.source === "roadmap");
    return [...real, ...roadmap].map((t) => t.text.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * Read the intent ledger's "Open now" titles via the same Rust command the
 * Command Center panel uses (`memory_todo_open_now`). Guarded: returns [] outside
 * Tauri or on any invoke failure - an unattended run should still start on
 * to-do-only scope rather than fail because the ledger file moved.
 */
async function readMemoryLedgerOpenNow(): Promise<string[]> {
  if (!inTauri()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke<{ title: string }[]>("memory_todo_open_now");
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => r.title?.trim()).filter((t): t is string => Boolean(t));
  } catch {
    return [];
  }
}

/** Cap so the goal prompt handed to the brain stays cheap and doesn't run away. */
const MAX_SCOPE_ITEMS = 20;

/**
 * Build the goal string for an unattended run: an optional spoken focus note,
 * followed by the Command Center to-do list and the memory ledger's "Open now"
 * items, deduplicated and capped. Exported (pure, async-but-guarded) so it's
 * independently testable and reusable by a future /overnight-style entry point.
 *
 * When BOTH sources are empty (fresh install, nothing queued), falls back to a
 * generic "keep the codebase healthy" goal rather than handing the brain an
 * empty prompt - an unattended run should never be a no-op.
 */
export async function buildUnattendedGoal(focusNote?: string): Promise<string> {
  const todos = readUpcomingTodos();
  const ledger = await readMemoryLedgerOpenNow();

  const seen = new Set<string>();
  const items: string[] = [];
  for (const t of [...todos, ...ledger]) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(t);
    if (items.length >= MAX_SCOPE_ITEMS) break;
  }

  const lines = [
    "Unattended run — work through as much of this backlog as you genuinely can, in priority order. Each item is a separate task; move to the next once one is done or genuinely blocked. Stop only when the list is done or nothing more can be done autonomously.",
    ...(focusNote ? [`Zach's focus note for this run: ${focusNote}`] : []),
    "",
    items.length ? "Backlog:" : "",
    ...items.map((t, i) => `${i + 1}. ${t}`),
  ].filter((l) => l !== "");

  if (items.length === 0) {
    return [
      "Unattended run — the to-do list and memory ledger are both empty right now.",
      ...(focusNote ? [`Zach's focus note: ${focusNote}`] : []),
      "Use your judgment: review the codebase for anything clearly unfinished, broken, or flagged TODO and fix what you safely can.",
    ].join(" ");
  }

  return lines.join("\n");
}

// ── Run lifecycle: visibility + cancellation ─────────────────────────────────

export interface UnattendedRunState {
  active: boolean;
  /** Wall-clock start, for a future "running for Xm" readout. */
  startedAt: number | null;
  /** The goal actually handed to orchestrate() (for the session panel/debug). */
  goal: string | null;
  /** Voice/tool turn that owns this run; null means only explicit global HALT may stop it. */
  ownerToken: string | null;
}

let state: UnattendedRunState = { active: false, startedAt: null, goal: null, ownerToken: null };
type UnattendedResult = import("./orchestrator").OrchResult;
interface ActiveUnattendedRun {
  ownerToken: string | null;
  controller: AbortController;
  promise: Promise<UnattendedResult>;
}
let activeRun: ActiveUnattendedRun | null = null;
const listeners = new Set<(s: UnattendedRunState) => void>();
const OWNER_STOP_TIMEOUT_MS = 5_000;

function setState(next: UnattendedRunState): void {
  state = next;
  for (const fn of listeners) fn(state);
}

/** Current unattended-run state (for the session panel / roster / debug reads). */
export function getUnattendedState(): UnattendedRunState {
  return state;
}

/** Subscribe to run-state changes (start/stop). Returns an unsubscribe fn. */
export function onUnattendedStateChange(fn: (s: UnattendedRunState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Cancel the in-flight unattended run, if any - wired to the SAME "stop"/"stand
 * down" halt phrases the router already recognizes (HALT_RE in hybridClassify.ts).
 * Cooperative: aborts orchestrate()'s signal, which stops the loop at the top of
 * its next iteration (see orchestrator.ts's iteration-loop abort check) - it does
 * not kill an in-flight tool call. Safe to call when nothing is running (no-op).
 */
export function unattendedOwnerMatches(activeOwner: string | null, requestedOwner: string): boolean {
  const normalized = requestedOwner.trim();
  return normalized.length > 0 && activeOwner === normalized;
}

/** Scoped cancellation used by one voice/tool turn. Missing or blank ownership
 *  is never interpreted as global cancellation. */
export function cancelUnattendedRun(ownerToken: string): boolean {
  const run = activeRun;
  if (!run || !unattendedOwnerMatches(run.ownerToken, ownerToken)) return false;
  run.controller.abort();
  return true;
}

/** Explicit global cancellation reserved for HALT ALL and deliberate stop UI. */
export function cancelAllUnattendedRuns(): boolean {
  const run = activeRun;
  if (!run) return false;
  run.controller.abort();
  return true;
}

async function waitForUnattendedTerminal(run: ActiveUnattendedRun): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      run.promise.then(() => undefined, () => undefined),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the unattended owner to become terminal.")),
          OWNER_STOP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Scoped stop acknowledgement. A matching run resolves only after its exact
 *  orchestrator promise has settled; a timeout rejects so replacement admission
 *  remains closed and may retry this owner later. */
export async function stopUnattendedRun(ownerToken: string): Promise<"requested" | "idle"> {
  const run = activeRun;
  if (!run || !unattendedOwnerMatches(run.ownerToken, ownerToken)) return "idle";
  run.controller.abort();
  await waitForUnattendedTerminal(run);
  return "requested";
}

/** Terminal global sibling used only by HALT ALL / deliberate stop UI. */
export async function stopAllUnattendedRuns(): Promise<"requested" | "idle"> {
  const run = activeRun;
  if (!run) return "idle";
  run.controller.abort();
  await waitForUnattendedTerminal(run);
  return "requested";
}

// HALT ALL (Command Center status rail → `praxis://halt`) aborts the in-flight
// unattended run through the same cooperative signal as the voice halt phrases.
// Registered once at module load; guarded so the dev browser stays inert. New
// orchestrate() calls are separately blocked by policy.isHalted() while the
// breaker stays thrown - this just stops the one already running.
void (async () => {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ halted: boolean }>("praxis://halt", (e) => {
      if (e.payload?.halted) cancelAllUnattendedRuns();
    });
  } catch {
    /* not in Tauri */
  }
})();

/**
 * Why the last `startUnattendedRun` call declined, when it declined for a reason
 * worth saying out loud. Read it immediately after a `null` return.
 *
 * `null` on its own is ambiguous - it means "already running" as well as "the dial
 * says no" - and a spoken instruction that produces silence is indistinguishable
 * from a broken app.
 */
let lastBlockedReason: string | null = null;

export function unattendedBlockedReason(): string | null {
  return lastBlockedReason;
}

/**
 * Start an unattended run: builds the goal from to-do + ledger scope, marks the
 * run active (visible to the roster/session panel via getUnattendedState()), and
 * calls orchestrate() with `{ unattended: true, signal }`. Returns immediately
 * with a promise the caller may await or fire-and-forget (the router does the
 * latter, matching the existing ESCALATE path's fire-and-forget shape).
 *
 * Refuses to start a second concurrent run (returns null) - one unattended
 * session at a time, same discipline as the Live-mode operator's RUNNING guard.
 *
 * THIS is the surface the trust dial exists for. An unattended run is Praxis
 * working with nobody watching it, which is the entire question the dial answers -
 * and until now this function never asked. The dial's whole observable effect was
 * on LIVE voice actions, which it should not govern at all, while the one thing it
 * was built for started regardless of where it was set.
 */
export function startUnattendedRun(
  focusNote?: string,
  ownerToken?: string,
): Promise<UnattendedResult> | null {
  if (state.active) {
    lastBlockedReason = null; // already running is not a policy refusal
    return null;
  }

  const decision = unattendedPolicy("actuate");
  if (!decision.allowed) {
    lastBlockedReason = decision.reason;
    return null;
  }
  lastBlockedReason = null;

  const runController = new AbortController();
  const signal = runController.signal;
  const startedAt = Date.now();
  const normalizedOwner = ownerToken?.trim() || null;
  setState({ active: true, startedAt, goal: null, ownerToken: normalizedOwner });

  let run!: Promise<UnattendedResult>;
  run = (async () => {
    try {
      const goal = await buildUnattendedGoal(focusNote);
      setState({ active: true, startedAt, goal, ownerToken: normalizedOwner });
      const { orchestrate } = await import("./orchestrator");
      return await orchestrate(goal, { unattended: true, signal, ownerToken: normalizedOwner ?? undefined });
    } finally {
      if (activeRun?.promise === run) {
        activeRun = null;
        setState({ active: false, startedAt: null, goal: null, ownerToken: null });
      }
    }
  })();
  activeRun = { ownerToken: normalizedOwner, controller: runController, promise: run };

  return run;
}
