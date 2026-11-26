import { currentExecMode, isHalted, isToolEnabled } from "@/orchestrator/policy";
import { loadAutonomy } from "@/shared/autonomy";
import { SENSITIVE_RE } from "@/shared/sovereignGate";
import type { ActionOrigin } from "@/shared/actionOrigin";
import {
  evaluateOperatorPolicy,
  operatorApprovalRequired,
  type OperatorCapability,
} from "./operatorPolicyCore";

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * Is this desktop action allowed? Returns null when it may proceed, or the
 * spoken refusal when it may not.
 *
 * `origin` is REQUIRED and is the whole decision - see operatorPolicyCore.ts.
 * A live instruction passes everything except HALT, the Computer Use master
 * breaker, and "there is no desktop here". An unattended one is judged by the
 * trust dial alone.
 *
 * The sensitivity test still runs, but ONLY to classify an unattended action for the dial.
 */
export function operatorActionBlockedReason(
  text: string,
  capability: OperatorCapability,
  origin: ActionOrigin,
): string | null {
  const autonomy = loadAutonomy();
  return evaluateOperatorPolicy({
    origin,
    capability,
    text,
    halted: isHalted(),
    execMode: currentExecMode(),
    toolEnabled: isToolEnabled("computer-use"),
    autonomy,
    sensitive: origin === "unattended" && SENSITIVE_RE.test(text),
    desktopAvailable: inTauri(),
  });
}

/**
 * Does this action need a per-step human approval before it runs? Always false
 * for a live action (the owner asking for it IS the approval); for an unattended one
 * this is II · PROPOSE's every-step ask and III · EXECUTE's sensitive-step ask.
 */
export function operatorActionNeedsApproval(text: string, origin: ActionOrigin): boolean {
  return operatorApprovalRequired(origin, loadAutonomy(), SENSITIVE_RE.test(text));
}
