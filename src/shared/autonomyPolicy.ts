/**
 * autonomyPolicy - the trust dial's ONE decision function, for UNATTENDED runs only.
 *
 * Before this module the dial was four detents wearing two thresholds: `observe`,
 * `suggest` and `approve` were byte-for-byte identical in effect (nothing branched
 * on them), II · PROPOSE's promised per-step approval was never built, and `full`
 * still could not clear the sensitivity block, the submit-key gate, the browser
 * veto or the Codex ask-first prompt. Four labels, two behaviours, and the top one
 * was not sovereign.
 *
 * The ladder now, and each rung is observably different from the one below it:
 *
 *   I  · OBSERVE  (observe)   Reads and reports. Actuates NOTHING.
 * - · (suggest)            Legacy key, off the dial. Drafts/plans, actuates
 *                             nothing. Kept so a stale persisted value degrades to
 *                             something sane instead of silently reading as
 *                             OBSERVE's neighbour.
 *   II · PROPOSE  (approve)   Acts, but asks before EVERY step. The ask is the
 *                             existing veto channel (sovereign.rs request_veto →
 *                             VetoOverlay), so there is one approval UI, not two.
 *   III· EXECUTE  (operator)  Acts on its own. Asks only at a SENSITIVE step -
 *                             pay, purchase, create account, submit login, post,
 *                             send, accept ToS, destructive.
 *   IV · SOVEREIGN(full)      Clears everything. No approval of any kind, at any
 *                             step, sensitive or not. Pays, creates accounts,
 *                             submits forms, drives the browser. The ONLY thing
 *                             that stops it is HALT.
 *
 * PURE: no DOM, no Tauri, no localStorage. The caller supplies the level, so this
 * unit-tests headless and the Rust half (src-tauri/src/autonomy.rs) can mirror it
 * exactly. Any change here must be mirrored there - the two are checked against
 * each other by scripts/test-autonomy-policy.cjs.
 */

import type { AutonomyKey } from "./autonomy";

/**
 * What kind of thing an unattended run is trying to do.
 */
export type ActionClass =
  /** Reading state, listing, screenshotting. Mutates nothing. */
  | "read"
  /** Any real actuation: keystrokes, clicks, spawning a lane, editing a file. */
  | "actuate"
  /** Actuation that is credentialed, irreversible, or outward-facing. */
  | "sensitive";

/** How much human approval this action needs before it may proceed. */
export type ApprovalMode =
  /** Proceed. Nobody is asked. */
  | "none"
  /** Ask before this step, every time, through the veto channel. */
  | "step";

export type AutonomyDecision =
  | { allowed: true; approval: ApprovalMode }
  | { allowed: false; reason: string };

/** Low → high. The array position IS the rung; do not reorder. */
const LADDER: AutonomyKey[] = ["observe", "suggest", "approve", "operator", "full"];

export function levelIndex(level: AutonomyKey): number {
  const i = LADDER.indexOf(level);
  return i >= 0 ? i : LADDER.indexOf("operator");
}

/** Human-facing rung name, matching the dial's own detent labels. */
export function levelLabel(level: AutonomyKey): string {
  switch (level) {
    case "observe":
      return "I · OBSERVE";
    case "suggest":
      return "Suggest";
    case "approve":
      return "II · PROPOSE";
    case "operator":
      return "III · EXECUTE";
    case "full":
      return "IV · SOVEREIGN";
  }
}

/**
 * THE decision. Given the dial's level and what an unattended run wants to do,
 * say whether it may, and whether a human is asked first.
 *
 * Never consulted for a live action - see actionOrigin.ts. A live instruction
 * does not reach this function at all, which is the entire point of the split.
 */
export function unattendedDecision(level: AutonomyKey, action: ActionClass): AutonomyDecision {
  // Looking is always allowed. A dial that stopped an unattended run from READING
  // its own state would break the run without protecting anything.
  if (action === "read") return { allowed: true, approval: "none" };

  switch (level) {
    case "observe":
      return {
        allowed: false,
        reason:
          "Trust is at I · OBSERVE — unattended runs watch and report, they don't touch the machine. Raise the dial to act while you're away.",
      };

    case "suggest":
      return {
        allowed: false,
        reason:
          "Trust is at Suggest — unattended runs draft the next move but never fire it. Raise the dial to II · PROPOSE or higher.",
      };

    case "approve":
      // II · PROPOSE, and this is what it was always supposed to mean: it DOES act,
      // it just asks first - every step, sensitive or not.
      return { allowed: true, approval: "step" };

    case "operator":
      // III · EXECUTE: autonomous for ordinary work, asks at the irreversible ones.
      return { allowed: true, approval: action === "sensitive" ? "step" : "none" };

    case "full":
      // IV · SOVEREIGN clears EVERYTHING. Pay, create an account, submit a form,
      // drive the browser - no prompt, at any step. HALT is the only remaining stop.
      return { allowed: true, approval: "none" };
  }
}

/**
 * Convenience for the many call sites that only need "may this proceed at all",
 * because they have no approval channel to route a "step" answer through.
 * A step-approval requirement counts as allowed here - the caller is responsible
 * for honouring `approval` when it can, and callers that cannot ask must say so.
 */
export function unattendedAllows(level: AutonomyKey, action: ActionClass): boolean {
  return unattendedDecision(level, action).allowed;
}

/** True when the top of the dial is set: no approvals, nothing withheld. */
export function isSovereign(level: AutonomyKey): boolean {
  return level === "full";
}
