import type { ActionOrigin } from "@/shared/actionOrigin";
import type { OrchResult } from "@/orchestrator/orchestrator";
import { speak } from "./speak";
import { tryOrchestrate } from "@/orchestrator/respond";
import { isMultiAskDump } from "@/orchestrator/parse";
import { parseCommand } from "./commands";
import { areaRefs, executeAndSpeak } from "./execute";
import { eventBus } from "@/data/eventBus";
// The ONE shared sovereign gate (sensitivity test + Trust-IV check + entry point),
// so the brain's own mic opens the Trust-IV sovereign loop exactly like the Mission
// input and the hybrid fast-lane do - instead of dead-ending sensitive goals at the
// generic "protected area" block.
import { sensitiveGoal, routeSovereign } from "@/shared/sovereignGate";
import { mirrorVoiceHeard, mirrorVoiceSpoke } from "./atlasChatBridge";
import { operatorActionBlockedReason } from "./operatorPolicy";
import { voiceCommandNeedsDesktop } from "./operatorPolicyCore";
import { currentExecMode } from "@/orchestrator/policy";

export type VoiceRouteKind =
  | "orchestrated"
  | "command"
  | "computer"
  | "blocked"
  /** Nothing local could do it - the caller may try the next rung. Never spoken. */
  | "unhandled"
  | "ignored";

export interface VoiceRouteResult {
  kind: VoiceRouteKind;
  transcript: string;
  summary: string;
  steps?: OrchResult["steps"];
}

const COMPUTER_ACTION_RE =
  /\b(open|launch|close|shut|hide|dismiss|minimize|minimise|maximize|maximise|restore|unmaximize|unmaximise|quit|switch|focus|click|press|type|fill|drag|move|resize|scroll|copy|paste|download|upload|search|google|look up|browse|navigate|go to|find|use|operate|control|start|stop)\b/i;

const COMPUTER_TARGET_RE =
  /\b(computer|desktop|screen|display|monitor|window|tab|browser|chrome|edge|firefox|file explorer|explorer|folder|file|app|application|notepad|calculator|settings|obsidian|gmail|outlook|slack|discord|spotify|teams|zoom|terminal|powershell|command prompt|cmd|website|web page|web|internet|google|cursor|mouse|keyboard)\b/i;

const COMPUTER_PHRASE_RE =
  /\b(on my computer|on the computer|my screen|the screen|my display|the display|my monitor|the monitor|use computer|computer use|take over|drive my screen|control my screen|my desktop|windows desktop)\b/i;

// Media/volume utterances reach the native media-key rung without needing a
// COMPUTER_TARGET noun - "next track" / "pause the music" / "volume up" name no
// app or device, but they ARE desktop operations (audit finding #2: this whole
// rung was unreachable from voice, and commands.ts's journey hop ate "next track").
const MEDIA_RE =
  /\b(next|previous|skip)\s+(track|song|tune)\b|\b(play|pause|resume|stop)\b[^.]*\b(music|song|track|audio|playback)\b|\bvolume\s+(up|down)\b|\bturn\s+(up|down)\s+the\s+volume\b|\b(mute|unmute)\b/i;

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Verbs that only ever mean "do this to the machine in front of me". Unlike
 * COMPUTER_ACTION_RE these need no target noun to be unambiguous: there is no
 * conversational reading of "click the blue button" or "scroll to the bottom".
 */
const DIRECT_MANIPULATION_RE =
  /\b(click|double[-\s]?click|right[-\s]?click|tap|type|press|hit|scroll|drag|paste|highlight|select all|zoom in|zoom out|maximi[sz]e|minimi[sz]e|screenshot|take a screenshot)\b/i;

/** An order rather than a remark: starts with a bare verb, no subject. */
const IMPERATIVE_START_RE =
  /^(?:please\s+|can you\s+|could you\s+|would you\s+|go ahead and\s+)?(?:open|launch|start|run|close|shut|quit|hide|show|focus|switch|bring|pull|click|tap|type|write|press|hit|scroll|drag|move|resize|make|set|turn|copy|paste|select|find|search|look|go|navigate|visit|download|upload|save|delete|remove|maximi[sz]e|minimi[sz]e|restore|zoom|screenshot|take)\b/i;

function looksLikeComputerOperation(text: string): boolean {
  if (COMPUTER_PHRASE_RE.test(text)) return true;
  if (MEDIA_RE.test(text)) return true;
  if (/\bhttps?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(text) && COMPUTER_ACTION_RE.test(text)) return true;
  if (COMPUTER_ACTION_RE.test(text) && COMPUTER_TARGET_RE.test(text)) return true;

  // A direct-manipulation verb needs no target noun. "Click the blue button",
  // "make the third row bold", "scroll to the bottom of this" contain no word
  // from COMPUTER_TARGET_RE, so all three used to fall past this rung, past
  // tryOrchestrate, and out as `ignored` - the owner said a thing and nothing at all
  // happened. A wrong guess here costs one screenshot; a missed instruction cost
  // the whole feature.
  if (IMPERATIVE_START_RE.test(text) && DIRECT_MANIPULATION_RE.test(text)) return true;

  // Any other bare imperative is still a candidate: let the actuator decide, and
  // if nothing can do it, routeComputerUse hands back "unhandled" and the caller
  // says so out loud rather than dropping it.
  return IMPERATIVE_START_RE.test(text) && !/\?\s*$/.test(text);
}

function computerUseBlockedReason(text: string): string | null {
  return operatorActionBlockedReason(text, "native", "live");
}

/**
 * Light the Operator lobe (Atlas) for a beat so the brain SHOWS the native op
 * happened - same event shape the real-event bridge uses. Working → idle after a
 * short pulse; native ops finish instantly so there's no long-lived agent state.
 */
function pulseAtlas(): void {
  const t = performance.now() / 1000;
  eventBus.emit({ type: "agent:status", t, agentId: "a.atlas", areaId: "praxis", status: "working" });
  window.setTimeout(() => {
    eventBus.emit({ type: "agent:status", t: performance.now() / 1000, agentId: "a.atlas", status: "idle" });
  }, 1400);
}

function nativeFailureMessage(err: unknown): string {
  const raw = String(err ?? "").trim();
  if (!raw) return "That local desktop action failed.";
  const stripped = raw.replace(/^.*?failed:\s*/i, "").trim();
  const msg = (stripped || raw).replace(/^"|"$/g, "").trim();
  return msg.slice(0, 220) || "That local desktop action failed.";
}

/**
 * Mirrors hybridRouter.tryRealOpen.
 */
const OPEN_VERB_RE =
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:open|launch|start|run|bring)\s+(?:up\s+)?(.+)$/i;

async function tryRealOpen(text: string, signal?: AbortSignal): Promise<string | null> {
  if (!inTauri() || signal?.aborted) return null;
  const match = OPEN_VERB_RE.exec(text.trim());
  if (!match) return null;
  const target = match[1].trim().replace(/[.!?,;]+$/, "");
  if (!target) return null;
  try {
    return await tauriInvoke<string>("desktop_open_app", { name: target });
  } catch {
    return null;
  }
}

async function routeComputerUse(
  text: string,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<VoiceRouteResult> {
  // Probe and execution are deliberately separate. A probe outage is unknown and
  // may continue to the allowed Live rung. Once the probe says a local action
  // matched, any execution/postcondition failure terminates here honestly.
  if (inTauri()) {
    if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
    try {
      const matches = await tauriInvoke<boolean>("native_op_matches", { goal: text });
      if (matches) {
        if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
        const blocked = operatorActionBlockedReason(text, "native", "live");
        if (blocked) {
          speak(blocked);
          return { kind: "blocked", transcript: text, summary: blocked };
        }
        try {
          if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
          const native = await tauriInvoke<string | null>("native_op_try", {
            goal: text,
            ownerToken: ownerToken ?? null,
          });
          if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
          if (native) {
            pulseAtlas();
            speak(native);
            return { kind: "computer", transcript: text, summary: native };
          }
          const msg = "I matched that as a local desktop action, but it didn't complete.";
          speak(msg);
          return { kind: "blocked", transcript: text, summary: msg };
        } catch (err) {
          const msg = nativeFailureMessage(err);
          speak(msg);
          return { kind: "blocked", transcript: text, summary: msg };
        }
      }
    } catch {
      // Probe unavailable: continue to the separately gated Live path.
    }

    // No local match. Give the REAL app launcher a turn before anything heavier -
    // `desktop_open_app` resolves any installed app from the Start Menu, App Paths
    // or PATH, so "open Blender" works even though Blender is not in the 17-entry
    // alias table that the fast path uses for latency.
    const opened = await tryRealOpen(text, signal);
    if (opened) {
      pulseAtlas();
      speak(opened);
      return { kind: "computer", transcript: text, summary: opened };
    }
  }

  if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
  // Nothing local handled it. Hand back so the caller can try the browser loop;
  // the visible-Codex handoff is the last resort, reached via routeVisibleOperator.
  return { kind: "unhandled", transcript: text, summary: "" };
}

/**
 * Last resort for a live desktop goal nothing local could do: hand a scoped prompt
 * to visible Codex Computer Use.
 */
async function routeVisibleOperator(
  text: string,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<VoiceRouteResult> {
  const visibleBlocked = operatorActionBlockedReason(text, "visible", "live");
  if (visibleBlocked) {
    // In HYBRID this is the end of the road by design: Praxis's own tools could not
    // do it, and the owner only wants Codex driving the screen in Live mode.
    const said = currentExecMode() === "live" ? visibleBlocked : `I couldn't do that with my own tools. ${visibleBlocked}`;
    speak(said);
    return { kind: "blocked", transcript: text, summary: said };
  }

  if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
  const output = await tauriInvoke<string>("computer_use_operate", {
    goal: text,
    skipNative: true,
    ownerToken: ownerToken ?? null,
    // Spoken at the brain mic, right now, with the owner watching. The handoff prompt drops its "ask
    // before financial/account/credential actions" paragraph for this - he already answered that
    // by saying it out loud.
    origin: "live" satisfies ActionOrigin,
  });
  if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
  // The Rust operator's return says HOW the goal actually ran - speak the truth,
  // not a one-size line (the native path finishes in ~1s with no Codex at all;
  // auto-submit means zero clicks, while the handoff paths still need a paste).
  const lower = output.toLowerCase();
  const summary = lower.includes("native fast path")
    ? "Done — handled it directly."
    : lower.includes("cancellable handoff")
      ? "Codex is open with the prompt ready. Auto-submit stays off until Praxis can cancel the submitted run itself."
      : lower.includes("auto-submitted")
        ? "Praxis sent the scoped prompt to Codex Desktop, but has not verified that Codex accepted or began the run yet."
      : lower.includes("clipboard copy failed")
        ? "Visible Codex Computer Use is opening. Clipboard handoff failed, so use the saved Praxis prompt file if Codex needs it."
        : "Visible Codex Computer Use is opening. The prepared @Computer prompt is on the clipboard if Codex needs you to paste it.";
  speak(summary);
  return {
    kind: "computer",
    transcript: text,
    summary,
  };
}

/**
 * Single path for final voice text after STT.
 *
 * This keeps the HUD, popup, legacy VoicePanel, and secondary-window bus from
 * drifting apart: build goals reach A3 orchestration, app verbs mutate Praxis,
 * and ordinary questions go through the selected brain_chat backend.
 */
/**
 * HOLD-T AND CONVERSE ARE THE SAME ASSISTANT.
 *
 * They were not. Three lanes already mirrored into the Atlas thread - the Realtime
 * transport, the hybrid session, and typed asks - and this one, the push-to-talk
 * brain mic, mirrored nothing. So holding T produced a real conversation that left
 * no trace in the panel on the left, which is exactly where he keeps looking for it.
 *
 * Wrapping rather than editing each of the 27 return paths is deliberate: a lane
 * that mirrors on SOME exits is worse than one that never did, because the gaps
 * look like lost messages rather than a missing feature.
 */
export async function routeVoiceTranscript(
  transcript: string,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<VoiceRouteResult> {
  const said = transcript.trim();
  if (said) mirrorVoiceHeard(said);
  const result = await routeVoiceTranscriptInner(transcript, signal, ownerToken);
  // `summary` is what Atlas says back on every path that answers at all. An
  // "ignored" turn with no summary writes nothing rather than an empty bubble.
  const replied = (result.summary ?? "").trim();
  if (replied) mirrorVoiceSpoke(replied);
  return result;
}

async function routeVoiceTranscriptInner(
  transcript: string,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<VoiceRouteResult> {
  const text = transcript.trim();
  if (!text) {
    // Genuinely nothing said. The ONLY silent return left in this function.
    return { kind: "ignored", transcript, summary: "" };
  }
  if (signal?.aborted) {
    return { kind: "blocked", transcript: text, summary: "Stopped." };
  }

  const cmd = parseCommand(text, areaRefs());
  if (cmd && cmd.intent.kind !== "ask") {
    if (voiceCommandNeedsDesktop(cmd.intent.kind)) {
      const blocked = operatorActionBlockedReason(text, "native", "live");
      if (blocked) {
        speak(blocked);
        return { kind: "blocked", transcript: text, summary: blocked };
      }
    }
    const result = await executeAndSpeak(cmd, signal, ownerToken);
    if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
    return {
      kind: "command",
      transcript: text,
      summary: result.reply || "Done.",
    };
  }

  // COMPUTER USE first. A live instruction gets the DIRECT actuator before anything else,
  // including when it reads as "sensitive". A BRAIN DUMP is several asks, and it must fan out
  // BEFORE any single-action lane can claim the whole paragraph. The branches below each take
  // ONE action: a dump that happens to mention "the control panel" would otherwise be handed to
  // the desktop operator as one instruction, and the other three asks would vanish. A lone
  // control command above still wins - that is one thing, said once.
  if (isMultiAskDump(text)) {
    const dumpRun = tryOrchestrate(text, { signal, ownerToken });
    if (dumpRun) {
      const result = await dumpRun;
      if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
      return {
        kind: "orchestrated",
        transcript: text,
        summary: result.summary,
        steps: result.steps,
      };
    }
  }

  if (looksLikeComputerOperation(text)) {
    const direct = await routeComputerUse(text, signal, ownerToken);
    if (direct.kind !== "unhandled") return direct;
    // Fell through: nothing local could do it. The browser loop is the last resort.
  }

  // SOVEREIGN - only reached when there was no direct way to do it. This is the real-browser
  // loop (log in, transact, fill a form on a site).
  if (sensitiveGoal(text) && !/\?\s*$/.test(text)) {
    const decision = routeSovereign(text, { speak: true, ownerToken, origin: "live" });
    if (decision.kind === "refused") {
      speak(decision.message);
      return { kind: "blocked", transcript: text, summary: decision.message };
    }
    if (decision.kind === "sovereign") {
      return {
        kind: "orchestrated",
        transcript: text,
        summary: "On it — driving the browser now.",
      };
    }
  }

  // A desktop order nothing local could do, and not a browser goal → visible Codex.
  if (looksLikeComputerOperation(text)) {
    return routeVisibleOperator(text, signal, ownerToken);
  }

  const orch = tryOrchestrate(text, { signal, ownerToken });
  if (orch) {
    const result = await orch;
    if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
    return {
      kind: "orchestrated",
      transcript: text,
      summary: result.summary,
      steps: result.steps,
    };
  }

  if (!cmd) {
    // NEVER drop a live instruction in silence. The owner speaking and getting nothing
    // back - no action, no sentence - is indistinguishable from the app being
    // broken, and it was one of the two returns that did exactly that.
    const msg = "I heard you, but I couldn't work out what to do with that. Say it another way?";
    speak(msg);
    return { kind: "blocked", transcript: text, summary: msg };
  }

  const result = await executeAndSpeak(cmd, signal);
  if (signal?.aborted) return { kind: "blocked", transcript: text, summary: "Stopped." };
  return {
    kind: "command",
    transcript: text,
    summary: result.reply || "Done.",
  };
}
