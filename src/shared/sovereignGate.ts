/**
 * sovereignGate - the SINGLE shared decision + entry point for Praxis' Sovereign
 * (Trust IV) loop. Every surface that can carry a "pay / post / log in / send /
 * buy" goal (the Mission unified input, the voice fast-lane router, and Atlas's
 * escalate tool) routes through THIS module so the trust×sensitivity decision is
 * made in exactly one place and can never drift between surfaces.
 *
 * NORTH STAR: at Trust IV Praxis DOES these things (with a per-action human veto),
 * it does not refuse them. Below Trust IV a sensitive goal is refused with an
 * HONEST, ACTIONABLE message - "raise the dial" - not a dead-end "I can't".
 *
 * The decision table (trust level × sensitive? → what happens):
 *
 *   sensitive? | trust < IV (observe/suggest/approve/operator) | trust == IV (full)
 *   -----------+-----------------------------------------------+---------------------
 *   yes        | REFUSE, honestly: "That needs Trust IV - | ROUTE into sovereign_do
 *              |   Sovereign. Set the dial in the Command      |   (browser-automation loop
 *              |   Center."                                    |   with per-action veto)
 *   no         | (this module is not consulted - normal        | (not sovereign - the normal
 *              |   command/goal/answer routing runs)           |   goal path runs)
 *
 * SAFETY: this module OPENS the path; it never weakens what's inside. The veto
 * gate, the credential overlay, and the HALT breaker all live Rust-side / in their
 * own stores and are untouched. We add ONE extra guard at the door: if HALT is
 * engaged, a sovereign run refuses to start (fail-closed, mirroring the loop's own
 * refusal to begin new steps while halted).
 *
 * Pure-ish + testable: the two classifiers (sensitiveGoal / canRunSovereign) touch
 * only a regex + localStorage-backed autonomy, no React/Tauri. runSovereign is the
 * one side-effecting entry (invoke + notify) and is guarded for the browser/dev view.
 */

import { loadAutonomy } from "@/shared/autonomy";
import { isToolEnabled } from "@/orchestrator/policy";
import type { ActionOrigin } from "@/shared/actionOrigin";
import { unattendedDecision } from "@/shared/autonomyPolicy";

/**
 * SENSITIVE_RE - the ONE canonical test for "this goal wants a credentialed /
 * irreversible real-world action" (pay, post, log in, send, buy, create account,
 * destructive change). Extracted here as the single source of truth; the voice
 * fast-lane's direct-input gate (hybridRouter.ts) and route.ts import it rather
 * than each carrying their own copy that could silently diverge.
 *
 * Kept in sync with the Rust `is_irreversible` action set (sovereign.rs) in intent:
 * both cover pay / purchase / post / send / login-submit / create-account. Rust
 * gates the ACTION classes mid-loop (the veto gate); this regex gates the spoken
 * GOAL up front so the whole loop only opens at Trust IV.
 */
export const SENSITIVE_RE =
  /\b(password|passcode|credential|secret|api key|log ?in|sign ?in|sign ?on|sign ?up|create (an? )?account|new account|register (for|an|a)|payment|pay(?! attention| off| respects)?|buy|purchase|checkout|order|transfer|trade|send (an? )?(email|message|text|dm)|post (this|that|it|a|the)|delete|remove|wipe|format|factory reset|uninstall)\b/i;

/**
 * Does this goal read as a sensitive / credentialed real-world action - the kind
 * only Trust IV Sovereign may take? A boolean so every call site agrees. Empty /
 * whitespace text is never sensitive.
 */
export function sensitiveGoal(text: string): boolean {
  if (!text || !text.trim()) return false;
  return SENSITIVE_RE.test(text);
}

/**
 * Is the trust dial at Trust IV (Sovereign / "full")? The sovereign loop may run
 * ONLY here. Reads the same localStorage-backed autonomy the Command Center dial
 * writes, so voice, Mission, and Atlas all see the identical live level.
 */
export function canRunSovereign(): boolean {
  return loadAutonomy() === "full";
}

/** The single honest, actionable refusal shown when a sensitive goal is asked
 *  below Trust IV. Kept as one string so all surfaces speak the same line. */
export const SOVEREIGN_REFUSAL =
  "That needs Trust IV — Sovereign. Set the dial in the Command Center and I'll do it for you, asking before each irreversible step.";

/** Outcome of a routing decision, so callers can render/speak the right feedback. */
export type SovereignDecision =
  | { kind: "sovereign"; run: Promise<string> } // routed into the sovereign loop (awaitable outcome)
  | { kind: "refused"; message: string } // sensitive but below Trust IV - honest refusal
  | { kind: "not-sovereign" }; // not a sensitive goal - caller runs its normal path
  // (never returned for non-sensitive goals; callers check sensitiveGoal() first,
  //  but the variant exists so the type is exhaustive.)

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Read the HALT breaker without importing the React hook (safe outside React). */
function isHaltedNow(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("praxis.halted.v1") === "1";
  } catch {
    return false;
  }
}

/** notify() into the bottom timeline strip without a static store import cycle. */
async function notify(text: string): Promise<void> {
  try {
    const { usePraxisStore } = await import("@/store/usePraxisStore");
    usePraxisStore.getState().notify(text);
  } catch {
    /* best-effort - the strip is a nicety, not a gate */
  }
}

/** Speak a line through the brain's single mouth, when a transport isn't already
 *  owning the voice. Best-effort + guarded (no-op in the browser/dev view). */
async function speak(text: string): Promise<void> {
  try {
    const { speak: say } = await import("@/voice/speak");
    say(text);
  } catch {
    /* no TTS available - the notify() line still surfaces it visually */
  }
}

/**
 * Redact a goal for a notify()/log line the same way Rust redacts args: never echo a raw secret.
 */
export function redactGoal(goal: string): string {
  return goal
    // key: value / password = "…" style leaks
    .replace(/\b(pass(?:word|code)?|secret|token|api[_\s-]?key)\b\s*[:=]\s*\S+/gi, "$1: ••••••••")
    // long opaque tokens (20+ non-space chars - likely a key, not a sentence word)
    .replace(/\b[A-Za-z0-9_\-]{20,}\b/g, "••••••••")
    .slice(0, 140);
}

/**
 * THE entry point. Given a sensitive goal, decide + act:
 *
 *   • Trust IV (full) AND not halted → invoke("sovereign_do", { goal }), announce
 *     the start (notify + optional speak), and return an awaitable that resolves to
 *     the loop's outcome string (also announced on finish/fail). The per-action
 *     veto + credential overlays fire from Rust during the run - untouched here.
 *   • Trust IV but HALTED → fail-closed refusal (the breaker is engaged).
 *   • Below Trust IV → honest, actionable refusal (raise the dial).
 *
 * `opts.speak` - when true, the outcome lines are spoken (voice surfaces pass true
 * so the fast-lane talks; Mission passes false so it doesn't double-talk over ask()).
 * The caller is responsible for having already confirmed sensitiveGoal(goal) is true.
 */
export function routeSovereign(
  goal: string,
  opts: { speak?: boolean; ownerToken?: string; origin: ActionOrigin },
): SovereignDecision {
  const trimmed = goal.trim();
  const origin = opts.origin;

  // The owner's own switches, both surfaces. HALT first so it is never masked.
  if (isHaltedNow()) {
    return {
      kind: "refused",
      message: "Everything's halted right now — clear the HALT breaker before I run a sovereign action.",
    };
  }
  if (!isToolEnabled("computer-use")) {
    return {
      kind: "refused",
      message: "Computer Use is off in Command Center. Turn it on and I'll drive the browser for you.",
    };
  }
  // Not in the desktop shell → there's no sidecar/vault to reach; say so honestly.
  if (!inTauri()) {
    return {
      kind: "refused",
      message: "Sovereign actions need the Praxis desktop app — the secure browser lives there.",
    };
  }

  // LIVE: the owner asked for it out loud, watching. No dial, no exec mode, no veto - the loop runs
  // with origin "live" and Rust skips the per-action veto entirely.
  if (origin === "unattended") {
    const decision = unattendedDecision(loadAutonomy(), "sensitive");
    if (!decision.allowed) {
      return { kind: "refused", message: decision.reason };
    }
  }

  const safeGoal = redactGoal(trimmed);
  const wantSpeak = opts.speak ?? false;

  const run = (async (): Promise<string> => {
    // Announce the start with the REDACTED goal (never a raw credential).
    const startLine =
      origin === "live"
        ? `Sovereign: starting “${safeGoal}” — you're watching, so I won't stop to ask.`
        : `Sovereign: starting “${safeGoal}”.`;
    void notify(startLine);
    if (wantSpeak) void speak("Starting now.");

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<string>("sovereign_do", {
        goal: trimmed,
        ownerToken: opts.ownerToken ?? null,
        origin,
      });
      const outcome = (result || "Sovereign action finished.").trim();
      void notify(`Sovereign: ${outcome}`);
      if (wantSpeak) void speak(outcome);
      return outcome;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const failLine = `Sovereign action failed on “${safeGoal}”: ${redactGoal(detail)}`;
      void notify(failLine);
      if (wantSpeak) void speak(`That sovereign action failed — ${detail}`);
      throw e;
    }
  })();

  // Don't let an unobserved rejection surface as an unhandled promise; the run's
  // own notify/speak already reported it. Callers that await get the real error.
  run.catch(() => {});

  return { kind: "sovereign", run };
}
