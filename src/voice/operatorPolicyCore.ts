import type { ActionOrigin } from "@/shared/actionOrigin";
import type { AutonomyKey } from "@/shared/autonomy";
import { unattendedDecision, type ActionClass } from "@/shared/autonomyPolicy";

export type OperatorCapability = "native" | "direct-input" | "visible";

export interface OperatorPolicyInput {
  /** WHO asked. Required - see src/shared/actionOrigin.ts. This is the whole gate. */
  origin: ActionOrigin;
  capability: OperatorCapability;
  text: string;
  halted: boolean;
  execMode: "live" | "hybrid" | "background";
  toolEnabled: boolean;
  autonomy: AutonomyKey;
  /** Sensitivity of the goal. Consulted for UNATTENDED runs only. */
  sensitive: boolean;
  desktopAvailable: boolean;
}

/**
 * The single policy for every voice- and UI-driven desktop actuator.
 *
 * It answers one question - "may this proceed?" - and the answer depends almost
 * entirely on WHO ASKED.
 *
 * ── LIVE ─────────────────────────────────────────────────────────────────────
 * the owner spoke it, just now, watching the screen. It is equivalent to him clicking
 * and typing himself, so it carries NO policy gates. Three things can still stop
 * it, and none of them is a policy:
 *
 *   1. HALT - his own stop button. It stops everything, always.
 *   3. No shell - we are in a browser view with no Windows to drive. Physics,
 *                  not permission.
 *
 * The trust dial is NOT consulted. The sensitivity regex is NOT consulted. Exec
 * mode is NOT consulted. There is no confirmation step. Removing those was the
 * point: the dial gated the surface the owner is watching while barely touching the
 * one he is not, which is exactly backwards.
 *
 * ── UNATTENDED ───────────────────────────────────────────────────────────────
 * A flow, an overnight run, a scheduler. Nobody is watching each step, so the
 * trust dial decides - and it is the ONLY thing that decides. The graduated
 * ladder lives in one place (src/shared/autonomyPolicy.ts) so the four detents
 * mean four observably different things, and so IV · SOVEREIGN genuinely clears
 * everything rather than advertising that it does.
 *
 * Ordering is intentional in both branches: the two breakers the owner controls come
 * before anything derived, so a HALT is never masked by a policy refusal.
 */
export function evaluateOperatorPolicy(input: OperatorPolicyInput): string | null {
  // ── the owner's own switches. Both surfaces, every level, no exceptions. ─────────
  if (input.halted) {
    return "Everything is halted right now. Say 'resume all' or clear the HALT breaker before I control the desktop.";
  }
  if (!input.toolEnabled) {
    return "Computer Use is off in Command Center. Turn it on and I'll do whatever you tell me.";
  }
  if (!input.desktopAvailable) {
    return "Desktop computer control needs the Praxis desktop app. This browser view cannot drive other Windows apps.";
  }

  if (input.capability === "visible" && input.execMode !== "live") {
    return visibleCodexNeedsLive(input.execMode);
  }

  // ── LIVE: nothing further. The owner is the confirmation. ───────────────────────
  if (input.origin === "live") return null;

  // ── UNATTENDED: the dial, and only the dial. ───────────────────────────────

  const action: ActionClass = input.sensitive ? "sensitive" : "actuate";
  const decision = unattendedDecision(input.autonomy, action);
  if (!decision.allowed) return decision.reason;

  // `approval: "step"` is honoured by the caller through the veto channel, not by
  // refusing here - II · PROPOSE and III · EXECUTE ask, they do not block.
  return null;
}

/**
 * Whether an unattended action at this level must be approved step-by-step before
 * it runs. Live actions never require approval, so this is `false` for them by
 * construction rather than by a check the caller could forget.
 */
export function operatorApprovalRequired(
  origin: ActionOrigin,
  autonomy: AutonomyKey,
  sensitive: boolean,
): boolean {
  if (origin === "live") return false;
  const decision = unattendedDecision(autonomy, sensitive ? "sensitive" : "actuate");
  return decision.allowed && decision.approval === "step";
}

/** The spoken reason a visible-Codex hand-off did not happen. */
export function visibleCodexNeedsLive(execMode: OperatorPolicyInput["execMode"]): string {
  const mode = execMode === "background" ? "Background" : "Hybrid";
  return `Codex only takes over the screen in Live mode, and the Command Center is set to ${mode}.`;
}

export function voiceCommandNeedsDesktop(kind: string): boolean {
  return ["open", "close", "window-placement", "tile-quadrants", "exit-formation"].includes(kind);
}
