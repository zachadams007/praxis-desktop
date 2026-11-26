/**
 * supervision.ts - the PER-DELEGATION supervision loop (Forge/Vega/Quill's
 * "monitor and make sure the task gets done" behavior).
 *
 * Today the orchestrator verifies at the PLAN level: it runs every step, then
 * asks the brain "is the whole goal done?". That misses the tighter loop the owner
 * described: when Claude Code (Forge) / Codex (Vega) / Cursor (Quill) returns a
 * result for ONE delegated task, an agent should look at THAT result against
 * THAT task, and if it fell short, re-prompt the SAME tool with concrete
 * feedback - reasoning, doing, evaluating, giving feedback, looping - instead of
 * blindly passing a half-done step up to plan-level verify.
 *
 * This module holds the PURE bits of that loop (prompt building, verdict
 * parsing, the bounded decision) so the test harness can drive them with no
 * runtime. orchestrator.ts wires them to the real brain seam (hermes_brain) and
 * the drivers.
 *
 * Bounds (hard): at most SUPERVISION_MAX_REPROMPTS corrective re-prompts per
 * delegation. After that the step is returned marked FAILED with the evaluation
 * feedback attached, and the existing plan-level verify/iterate loop takes over.
 * A single delegation therefore costs at most 1 initial run + 2 re-prompts = 3
 * driver invocations, plus ≤ 3 cheap brain evaluations.
 */


export const SUPERVISION_MAX_REPROMPTS = 2;

/** The brain's judgement of one delegated result against its task. */
export interface DelegationVerdict {
  /** Did the tool's output genuinely accomplish the delegated task? */
  sufficient: boolean;
  /** One-line concrete feedback on what's missing/wrong (used to re-prompt). */
  feedback: string;
}

/**
 * Build the evaluation prompt for ONE delegated result. Tight on purpose - this
 * runs after every delegation (and after each re-prompt), so it must be cheap.
 * The brain sees the task the tool was given and exactly what it returned, and
 * must judge sufficiency + name the gap.
 */
export function evaluateDelegationPrompt(task: string, output: string): string {
  // Live 2026-10-10: the brief was cut at 600 chars and the result at its first 1,400 -
  // Praxis's own file check comes FIRST in the result, so the agent's closing report was
  // always cut off, and the supervisor sent finished work back twice as "unverified".
  // The whole brief now (briefs run 1-4K), and the result's head (the file check) plus
  // its tail (the agent's own report). The Codex harness alone is ~20K tokens, so this
  // costs little next to a needless re-run (one was 750K tokens).
  const taskLine = task.length > 6000 ? `${task.slice(0, 6000)}\n…(brief continues)` : task;
  const raw = output && output.trim() ? output : "(no output)";
  const outLine = raw.length > 5000 ? `${raw.slice(0, 1200)}\n…\n${raw.slice(-3800)}` : raw;
  return [
    "You are Praxis's delegation supervisor, checking an agent's work the way Zach would: you gave it ONE task and it returned a result.",
    "Judge whether the result genuinely ACCOMPLISHED the task at a high bar — correct, complete and good, not merely attempted, acknowledged or half-done.",
    "You cannot open files or run commands. Judge from the brief, Praxis's own check of the files on disk, and the agent's report below. Do not send work back only because more evidence could exist: when the report and the file check together show the task done, accept it and say what you could not verify — a real-browser look and a final review of the whole goal still come after you. Send it back when something required is missing, wrong or clearly unfinished, and name exactly what.",
    "",
    `Task given to the tool:\n${taskLine}`,
    "",
    `What the tool returned:\n${outLine}`,
    "",
    'Return ONLY valid JSON (no prose, no markdown fences) in this exact shape:',
    '{"sufficient":true|false,"feedback":"one line ≤ 160 chars"}',
    'If sufficient, feedback says in one line what you checked and found good (Zach reads it). If NOT sufficient, feedback MUST concretely name what is missing or wrong so the agent can be re-prompted to fix it.',
  ].join("\n");
}

/** The run ended because the agent's tool itself failed (spawn error, CLI error), not
 *  because the supervisor rejected a finished result. Only this may mark a rail dark -
 *  live 2026-10-10 a rejected Codex result was read as "Codex CLI is not logged in". */
export function endedOnToolError(trail: SupervisionCycle[]): boolean {
  return trail[trail.length - 1]?.feedback.startsWith("tool error:") ?? false;
}

/** Strip ```json … ``` fences (mirrors orchestrator.stripFences). */
function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * Parse the evaluation JSON. Returns null when the reply isn't a usable verdict
 * - the caller then treats the delegation as sufficient (fail-open: we never
 * block a real result just because the cheap evaluator hiccuped; plan-level
 * verify remains the backstop).
 */
export function parseDelegationVerdict(raw: string): DelegationVerdict | null {
  try {
    const obj = JSON.parse(stripFences(raw)) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    const v = obj as { sufficient?: unknown; feedback?: unknown };
    if (typeof v.sufficient !== "boolean") return null;
    return {
      sufficient: v.sufficient,
      feedback: typeof v.feedback === "string" ? v.feedback.trim() : "",
    };
  } catch {
    return null;
  }
}

/**
 * Build the re-prompt sent to the SAME tool after an insufficient result: the
 * ORIGINAL task plus the supervisor's concrete feedback about what was wrong.
 * Keeping the original task verbatim (not a paraphrase) means the tool still has
 * full context; the feedback block steers the retry.
 */
export function repromptText(originalTask: string, feedback: string, attempt: number): string {
  const fb = feedback.trim() || "The previous attempt did not fully accomplish the task.";
  const lines = [
    originalTask,
    "",
    `--- Supervisor feedback (re-prompt ${attempt}/${SUPERVISION_MAX_REPROMPTS}) ---`,
    `Your previous attempt was judged INSUFFICIENT: ${fb}`,
    "Address this specific gap and complete the ORIGINAL task above. Do not restate the task — do the work.",
  ];
  // Advisor escalation trigger §2.1 (docs/advisor-architecture-2026-07-05.md):
  // the LAST re-prompt is the two-strike - before changing approach, the executor
  // must consult its advisor and say what it advised. Claude Code sessions have a
  // real in-session advisor (`--advisor`, wired in run_claude); other executors
  // treat this as an explicit stop-and-reason instruction, which is the point.
  if (attempt >= SUPERVISION_MAX_REPROMPTS) {
    lines.push(
      "This is your final attempt. STOP before re-trying the same approach: consult your advisor " +
        "(if you have an in-session advisor, ask it now; otherwise reason explicitly about WHY the " +
        "previous attempts failed), state the advice/diagnosis in one line, then act on it.",
    );
  }
  return lines.join("\n");
}

/** One recorded supervision cycle - appended to the run ledger for auditability. */
export interface SupervisionCycle {
  /** 0 = initial evaluation; 1..N = evaluation after the Nth re-prompt. */
  attempt: number;
  /** The brain's sufficiency verdict for this attempt (null = evaluator unavailable). */
  sufficient: boolean | null;
  /** The feedback that drove the NEXT re-prompt (empty when sufficient / final). */
  feedback: string;
}

/** The outcome of a supervised delegation. */
export interface SupervisionOutcome {
  output: string;
  ok: boolean;
  supervision: SupervisionCycle[];
  /** Corrective re-prompts taken (0 = accepted on the first result). */
  reprompts: number;
}

/**
 * Dependencies the supervision loop needs - injected so the loop is PURE and
 * fully testable without a Tauri runtime or a real brain. orchestrator.ts wires
 * the real driver + brain seam; the test harness wires deterministic mocks.
 */
export interface SupervisionDeps {
  /** Exact owner cancellation gate. Checked before every tool/evaluator admission
   *  and after every awaited call so a stop cannot launch a re-prompt. */
  signal?: AbortSignal;
  /**
   * Run the tool with a prompt. Resolves with its output; REJECTS when the tool
   * throws (spawn error / CLI failure). The loop treats a throw as an
   * un-repromptable failure (the tool never produced a result to critique).
   */
  runTool: (prompt: string) => Promise<string>;
  /**
   * Optional local invariant check, run after a tool replies and before the
   * model evaluator. A failing check is authoritative: it re-prompts the same
   * tool even if Hermes is disabled, unavailable, or incorrectly accepts the
   * prose reply. Null means this step has no mechanically checkable invariant.
   */
  checkResult?: (task: string, output: string) => Promise<DelegationVerdict | null>;
  /**
   * Evaluate a result against the ORIGINAL task. Resolves with a verdict, or
   * null when the evaluator is unavailable (Hermes off / brain unreachable) -
   * in which case the loop FAILS OPEN and accepts the result.
   */
  evaluate: (task: string, output: string) => Promise<DelegationVerdict | null>;
  /** Optional side-effect hook per lifecycle beat - drives roster events in prod. */
  onEvent?: (ev: SupervisionEvent) => void;
}

/** Lifecycle beats the loop emits (orchestrator maps these to PraxisEvents). */
export type SupervisionEvent =
  | { kind: "reprompt"; attempt: number; feedback: string }
  | { kind: "checking" }
  | { kind: "accepted"; feedback?: string }
  | { kind: "insufficient"; feedback: string }
  | { kind: "exhausted"; feedback: string };

/**
 * The pure per-delegation supervision loop: run → evaluate → (re-prompt with
 * feedback) → loop, bounded by SUPERVISION_MAX_REPROMPTS. This is the heart of
 * Forge/Vega/Quill "monitoring and making sure the task gets done" and is unit-
 * tested directly via injected deps.
 *
 *   • `supervise === false` → single pass, accept the first result (no brain).
 *   • tool throws → ok:false immediately (can't re-prompt a non-result).
 *   • evaluate → null (unavailable) → FAIL OPEN, accept the result.
 *   • sufficient → accept; insufficient + budget left → re-prompt the SAME tool
 *     with the original task + concrete feedback; insufficient + no budget →
 *     ok:false (two-strike failure) with the feedback attached to the output.
 *
 * `reprompts` counts corrective re-prompts actually issued (the `attempt` index
 * at which the loop resolved: 0 = first result accepted, N = accepted/failed
 * after N re-prompts).
 */
export async function superviseDelegation(
  originalTask: string,
  supervise: boolean,
  deps: SupervisionDeps,
): Promise<SupervisionOutcome> {
  const trail: SupervisionCycle[] = [];
  let currentPrompt = originalTask;
  let output = "";

  const stopped = (attempt: number): SupervisionOutcome => ({
    output: output ? `${output}\n\n[supervision: stopped by owner]` : "Stopped by owner.",
    ok: false,
    supervision: [...trail, { attempt, sufficient: null, feedback: "stopped by owner" }],
    reprompts: attempt,
  });

  for (let attempt = 0; attempt <= SUPERVISION_MAX_REPROMPTS; attempt++) {
    if (deps.signal?.aborted) return stopped(attempt);
    if (attempt > 0) {
      deps.onEvent?.({ kind: "reprompt", attempt, feedback: trail[attempt - 1]?.feedback ?? "" });
    }

    try {
      output = await deps.runTool(currentPrompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      trail.push({ attempt, sufficient: null, feedback: `tool error: ${msg.slice(0, 120)}` });
      return { output: msg, ok: false, supervision: trail, reprompts: attempt };
    }
    if (deps.signal?.aborted) return stopped(attempt);

    // No brain to judge with - single-pass contract; accept the result.
    if (!supervise) {
      const checked = await deps.checkResult?.(originalTask, output) ?? null;
      if (deps.signal?.aborted) return stopped(attempt);
      if (checked?.sufficient === false) {
        trail.push({ attempt, sufficient: false, feedback: checked.feedback });
        deps.onEvent?.({ kind: "insufficient", feedback: checked.feedback });
        if (attempt >= SUPERVISION_MAX_REPROMPTS) {
          deps.onEvent?.({ kind: "exhausted", feedback: checked.feedback });
          return { output: `${output}\n\n[supervision: FAILED after ${SUPERVISION_MAX_REPROMPTS} re-prompts — ${checked.feedback}]`, ok: false, supervision: trail, reprompts: attempt };
        }
        currentPrompt = repromptText(originalTask, checked.feedback, attempt + 1);
        continue;
      }
      return { output, ok: true, supervision: trail, reprompts: attempt };
    }

    // Disk facts outrank the evaluator's transcript reading. Keep this before
    // evaluate() so a missing artifact cannot be accepted by a stale/null brain.
    const checked = await deps.checkResult?.(originalTask, output) ?? null;
    if (deps.signal?.aborted) return stopped(attempt);
    if (checked?.sufficient === false) {
      trail.push({ attempt, sufficient: false, feedback: checked.feedback });
      deps.onEvent?.({ kind: "insufficient", feedback: checked.feedback });
      if (attempt >= SUPERVISION_MAX_REPROMPTS) {
        deps.onEvent?.({ kind: "exhausted", feedback: checked.feedback });
        return {
          output: `${output}\n\n[supervision: FAILED after ${SUPERVISION_MAX_REPROMPTS} re-prompts — ${checked.feedback}]`,
          ok: false,
          supervision: trail,
          reprompts: attempt,
        };
      }
      currentPrompt = repromptText(originalTask, checked.feedback, attempt + 1);
      continue;
    }

    deps.onEvent?.({ kind: "checking" });
    if (deps.signal?.aborted) return stopped(attempt);
    const verdict = await deps.evaluate(originalTask, output);
    if (deps.signal?.aborted) return stopped(attempt);

    if (verdict === null) {
      // Evaluator unavailable - FAIL OPEN (plan-level verify is the backstop).
      trail.push({ attempt, sufficient: null, feedback: "supervisor unavailable — accepted result" });
      return { output, ok: true, supervision: trail, reprompts: attempt };
    }

    if (verdict.sufficient) {
      trail.push({ attempt, sufficient: true, feedback: "" });
      deps.onEvent?.({ kind: "accepted", feedback: verdict.feedback });
      return { output, ok: true, supervision: trail, reprompts: attempt };
    }

    trail.push({ attempt, sufficient: false, feedback: verdict.feedback });
    deps.onEvent?.({ kind: "insufficient", feedback: verdict.feedback });

    if (attempt >= SUPERVISION_MAX_REPROMPTS) {
      // Two-strike failure: out of re-prompts, still insufficient.
      deps.onEvent?.({ kind: "exhausted", feedback: verdict.feedback });
      return {
        output: `${output}\n\n[supervision: FAILED after ${SUPERVISION_MAX_REPROMPTS} re-prompts — ${verdict.feedback}]`,
        ok: false,
        supervision: trail,
        reprompts: attempt,
      };
    }

    currentPrompt = repromptText(originalTask, verdict.feedback, attempt + 1);
  }

  // Unreachable (loop always returns), but satisfies the type checker.
  return { output, ok: true, supervision: trail, reprompts: trail.length };
}
