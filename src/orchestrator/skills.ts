/**
 * skills.ts - the SKILL-CAPTURE LOOP (Example Creator workflow idea #2).
 *
 * When orchestrate() finishes a goal GENUINELY DONE, we distil the run into a
 * named, reusable "skill" and persist it. Later, "run my <name>" re-runs the
 * saved goal through orchestrate() again - so Praxis compounds what it learns
 * instead of solving the same thing from scratch every time.
 *
 * Storage is a JSONL file owned by Rust (skill_store.rs) at
 * `%LOCALAPPDATA%\Praxis\skills.jsonl` - same append-only pattern as the run
 * ledger. Two commands: `skill_save(entry)` and `skill_list() -> entries[]`.
 *
 * DEFENSIVE like orchestrator.ts: every Tauri touch is dynamically imported and
 * guarded, so this module is safe to bundle/run in a plain browser or a headless
 * test. The PURE bits (slug derivation, capture-eligibility, fuzzy resolution)
 * take their inputs explicitly - including `ts` - so the test harness can drive
 * them without a clock or a runtime.
 */

import type { OrchResult } from "./orchestrator";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One step of a captured skill - the minimal replayable slice of an OrchStep. */
export interface SkillStep {
  tool: string;
  model?: string;
  prompt: string;
}

/** A reusable skill distilled from a successful run. Schema-loose on the Rust
 *  side (raw JSON), so extra fields are fine; these are the ones we author. */
export interface CapturedSkill {
  /** Short slug from the goal - the re-invocation handle ("deploy the site"). */
  name: string;
  /** The full original goal - what we re-run on invocation (self-healing). */
  goal: string;
  /** The steps the run actually executed (for display / future direct replay). */
  steps: SkillStep[];
  /** The run's final summary line. */
  summary: string;
  /** Unix epoch ms - passed IN so the pure derivation stays clock-free/testable. */
  ts: number;
}

// ── Pure logic (no Tauri, no clock) ─────────────────────────────────────────────

const SLUG_STOP = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "my", "me", "please",
  "in", "on", "with", "into", "that", "this", "it",
]);

/**
 * Derive a short skill name from a goal: the first ~4 meaningful words (stop
 * words dropped), lowercased, joined by spaces. Falls back to a trimmed slice
 * of the raw goal when nothing meaningful survives (e.g. an all-stopword goal).
 * Deterministic and pure so the test harness can assert exact names.
 */
export function skillNameFromGoal(goal: string, maxWords = 4): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !SLUG_STOP.has(w));
  const picked = words.slice(0, Math.max(1, maxWords));
  if (picked.length) return picked.join(" ");
  // No meaningful tokens - degrade to a trimmed raw slice so we never emit "".
  return goal.trim().toLowerCase().slice(0, 40) || "skill";
}

/**
 * Should this finished run be captured as a skill? ONLY genuinely-done runs
 * that completed cleanly:
 *   • done must be true (the brain verified the goal), AND
 *   • at least one step actually succeeded (not a handoff-only / all-failed run).
 * A Live-mode "auto-submitted" run reports done:false (Codex only STARTED), so
 * this naturally excludes it. Failed and handoff-only runs are never captured.
 */
export function isCaptureEligible(result: Pick<OrchResult, "done" | "steps">): boolean {
  if (!result.done) return false;
  return result.steps.some((s) => s.ok);
}

/**
 * Distil a CapturedSkill from a finished run + the ORIGINAL goal. Pure: `ts` is
 * supplied by the caller. Only successful steps are kept (a captured skill is a
 * recipe of what WORKED), reduced to the replayable {tool, model, prompt} slice.
 */
export function deriveSkill(
  goal: string,
  result: Pick<OrchResult, "steps" | "summary">,
  ts: number,
): CapturedSkill {
  const steps: SkillStep[] = result.steps
    .filter((s) => s.ok)
    .map((s) => ({ tool: s.tool, ...(s.model ? { model: s.model } : {}), prompt: s.prompt }));
  return {
    name: skillNameFromGoal(goal),
    goal,
    steps,
    summary: result.summary || goal.slice(0, 120),
    ts,
  };
}

/**
 * Handle words that decorate a spoken invocation ("run my deploy ROUTINE") but
 * aren't part of the skill's identity - dropped during matching so the spoken
 * tokens reduce to the real name ({deploy}) and the ⊆ test can succeed.
 */
const HANDLE_WORDS = new Set(["skill", "routine", "workflow", "recipe", "macro"]);

/** Tokenize a name/goal for fuzzy matching - lowercase alnum words, no stop/handle words. */
function matchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !SLUG_STOP.has(w) && !HANDLE_WORDS.has(w));
}

/**
 * Resolve a spoken skill name against saved skills. A skill matches when EVERY
 * meaningful token the user spoke also appears in that skill's name or goal
 * tokens (spoken ⊆ skill) - so "run my deploy routine" resolves the "deploy the
 * site" skill (tokens {deploy} ⊆ {deploy, site}) without matching an unrelated
 * skill. Requires ≥ 1 spoken token; an empty/all-stopword spoken name never
 * matches (guards the bare "run" case at resolution time too). Among multiple
 * matches, the one whose name shares the MOST tokens with the spoken name wins;
 * ties break to the NEWEST (highest ts) so a refreshed skill is preferred.
 *
 * Pure - takes the skill list explicitly so the harness can drive it.
 */
export function resolveSkill(spokenName: string, skills: CapturedSkill[]): CapturedSkill | null {
  const spoken = matchTokens(spokenName);
  if (spoken.length === 0) return null;

  let best: CapturedSkill | null = null;
  let bestScore = -1;

  for (const skill of skills) {
    const nameToks = matchTokens(skill.name);
    const goalToks = new Set([...nameToks, ...matchTokens(skill.goal)]);
    const allPresent = spoken.every((t) => goalToks.has(t));
    if (!allPresent) continue;

    // Score by name-token overlap (name is the canonical handle), tie-break newest.
    const nameSet = new Set(nameToks);
    const score = spoken.filter((t) => nameSet.has(t)).length;
    if (score > bestScore || (score === bestScore && best !== null && skill.ts > best.ts)) {
      best = skill;
      bestScore = score;
    }
  }

  return best;
}

// ── Tauri-guarded side effects (never throw into the caller) ────────────────────

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Dynamically import invoke so this module stays browser/test-safe. */
async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Capture a skill from a finished run - the hook respond.ts / the orchestrate
 * caller invokes after a run. No-op (returns null) unless the run is
 * capture-eligible AND we're in Tauri. Best-effort: any save failure is
 * swallowed so it never fails the orchestration result. Returns the captured
 * skill on success (for logging), or null when nothing was captured.
 */
export async function captureSkillFromRun(
  goal: string,
  result: OrchResult,
): Promise<CapturedSkill | null> {
  if (!inTauri()) return null;
  if (!isCaptureEligible(result)) return null;
  const skill = deriveSkill(goal, result, Date.now());
  try {
    await tauriInvoke("skill_save", { entry: skill });
    // Fold the freshly-learned skill into the Learning AI cluster right away so
    // the brain shows it without waiting for a reload. Best-effort - never fails
    // the capture. (Fire-and-forget: the returned skill is what the caller wants.)
    void refreshSkillArtifacts().catch(() => {});
    return skill;
  } catch {
    /* skill store unavailable (dev browser / command missing) - non-fatal */
    return null;
  }
}

/**
 * Load all saved skills (deduped by name, newest wins on the Rust side).
 * Guarded: returns [] in a browser or on any failure so callers (voice
 * resolution + the Learning AI surface) never crash. Validates each entry has
 * the minimum shape (name + goal strings) before trusting it.
 */
export async function loadSkills(): Promise<CapturedSkill[]> {
  if (!inTauri()) return [];
  try {
    const raw = await tauriInvoke<unknown[]>("skill_list", {});
    if (!Array.isArray(raw)) return [];
    return raw.filter(isCapturedSkill);
  } catch {
    return [];
  }
}

/** Runtime shape guard for a skill_list() entry. */
function isCapturedSkill(v: unknown): v is CapturedSkill {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && o.name.trim().length > 0 && typeof o.goal === "string";
}

/**
 * Learning AI surface: load the saved skills and fold their names into the brain
 * graph as artifact nodes under the "Skills" task (see graph.mergeSkillArtifacts).
 * Call this on brain-window startup and after a fresh capture so the cluster
 * reflects what Praxis has learned. Fully guarded - a browser/dev env loads no
 * skills, so it's a harmless no-op. Returns the count merged (for logging).
 */
export async function refreshSkillArtifacts(): Promise<number> {
  const skills = await loadSkills();
  const { mergeSkillArtifacts } = await import("@/data/graph");
  const labels = skills.map((s) => s.name);
  mergeSkillArtifacts(labels);
  return labels.length;
}
