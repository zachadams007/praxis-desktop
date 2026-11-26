/**
 * submitClassify - the brain behind the UNIFIED input (spec 2026-07-06).
 *
 * One primary input in the main window. When the owner submits a prompt it must
 * SIMULTANEOUSLY do everything that applies to it:
 *   (a) FILE - the plannable parts sprout onto the journey (persisted)
 *                (the existing deterministic dump() parser).
 *   (b) EXECUTE - control commands run right now (parseCommand → executeAndSpeak),
 *                and build/do goals kick off the real orchestrator loop
 *                (orchestrate()).
 *   (c) ANSWER - genuine questions get a spoken/typed reply (ask()).
 *
 * A single long prompt can hit ALL THREE ("file the broker idea, build the tile
 * layout, and what's Catalyzed's status?"). This module is the PURE classifier:
 * text → which faculties apply, split into the clauses each one should act on.
 * No React, no store, no Tauri - unit-testable in isolation. The store's
 * submit() action drives the side-effects off this plan.
 */

import { parseCommand, type VoiceCommand } from "@/voice/commands";
import type { AreaRef } from "@/voice/commands";
import { parseDump, isMultiAskDump, splitBrainDump, splitBrainDumpClauses } from "./parse";
import { sensitiveGoal } from "@/shared/sovereignGate";

/** Clause-level split - the same separators dump() splits on, so "file X; build Y"
 *  becomes two independently-classified clauses. Kept lenient (a lone sentence is
 *  one clause) so short prompts aren't over-fragmented. */
export function splitClauses(text: string): string[] {
  return text
    .split(/\r?\n|;|·|•|(?:\s+—\s+)|(?:\s+\+\s+)/)
    .map((c) => c.trim())
    .filter((c) => c.length > 1);
}

/** Build/do INTENT - an imperative that should spin up the orchestrator loop
 *  rather than merely file a note. Anchored to a lead build verb so "research
 *  broker APIs next week" (a plan to file) is NOT mistaken for "build the bot
 *  now" (a goal to run). "add"/"note" are deliberately absent - those are filing
 *  verbs the dump parser owns. */
export const GOAL_RE =
  /\b(build|implement|create|code|refactor|fix|wire\s*up|set\s*up|scaffold|generate|write|make\s+me|ship|deploy|automate|orchestrate|go\s+do|do\s+everything)\b/i;

/** "run everything / go do everything / overnight" - the explicit unattended
 *  long-horizon session (raises orchestrate()'s iteration ceiling). */
export const UNATTENDED_RE =
  /\b(go\s+do\s+everything|do\s+everything|run\s+everything|overnight|work\s+all\s+night|knock\s+out\s+(?:the\s+)?(?:whole\s+)?backlog)\b/i;

/** QUESTION - ends with "?" or opens with an interrogative. These get answered,
 *  not filed or built (though a compound prompt may also file/build OTHER clauses). */
const QUESTION_RE =
  /(\?\s*$)|^(?:\s*)(what|who|when|where|why|how|which|is|are|do|does|did|can|could|should|would|will|whats|what's|who's|hows|how's)\b/i;

/** A clause that only CONTINUES the goal before it - a constraint ("you choose the
 *  content"), the team ("using Vega, Quill and Forge"), or what happens after
 *  ("then open it in a browser and maximize it") - rather than opening a new ask.
 *  Sequencing cues matter most: "then maximize it" must wait for the goal it
 *  follows, not run as a window command against whatever is on screen right now. */
export const CONTINUATION_RE =
  /^(?:you\b|using\b|use\b|with\b|via\b|through\b|by\b|then\b|and then\b|after that\b|afterwards\b|once (?:it'?s|that'?s|you'?re) (?:done|built|finished)\b|when (?:it'?s|that'?s|you'?re) (?:done|built|finished)\b|so (?:that|it)\b|make sure\b|keep it\b|including\b|based on\b|from (?:my|your) memory\b)/i;

/** "can you / could you / please / hey Praxis," - politeness in front of an instruction. */
const POLITE_LEAD_RE =
  /^(?:(?:hey\s+|ok(?:ay)?\s+)?praxis[,:]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?/i;

/** The lead verbs of a task Praxis does on the owner's computer RIGHT NOW (open an app,
 * go to a site, click, play, check his mail).
 *  FILED as an idea on the journey and nothing opened. */
const OPERATE_LEAD_RE =
  /^(?:open|launch|go\s+to|navigate\s+to|browse\s+to|visit|search|google|look\s+up|click|double[- ]?click|right[- ]?click|press|type|scroll|play|pause|skip|mute|unmute|turn\s+(?:up|down)|switch\s+to|focus|bring\s+up|pull\s+up|minimi[sz]e|maximi[sz]e|watch|listen\s+to|fill\s+(?:in|out)|check\s+(?:my|the)\s+(?:e-?mails?|inbox|calendar|messages|notifications|dms?)|find(?!\s+out))\b/i;

/** Words that make a "find…"/"open…" clause about CODE, which is the build loop's
 *  job - "find the bug in the deck" must not become a desktop search. */
const CODE_WORD_RE =
  /\b(?:bugs?|errors?|exceptions?|code|codebase|repo|repository|builds?|tests?|functions?|components?|commits?|branch(?:es)?|crash(?:es)?|logs?|stack\s*traces?|regressions?)\b/i;

/** The clause refers back to work stated earlier ("open it in Chrome when it's done"). */
const REFERS_BACK_RE = /\b(?:it|that|this|them|the result)\b|\bwhen (?:it'?s |you'?re )?(?:done|finished|built|ready)\b|\bafterwards?\b/i;

/**
 * A desktop task to do now, or null. Returns the instruction without its politeness
 * ("can you open spotify?" → "open spotify"). A build verb anywhere wins (that's a
 * goal), and code-shaped clauses stay with the build loop.
 */
export function operatorClause(clause: string): string | null {
  const stripped = clause.replace(POLITE_LEAD_RE, "").replace(/[?.!]+\s*$/, "").trim();
  if (!stripped || !OPERATE_LEAD_RE.test(stripped)) return null;
  if (GOAL_RE.test(stripped) || UNATTENDED_RE.test(stripped) || CODE_WORD_RE.test(stripped)) return null;
  return stripped;
}

/** An investigation to RUN, not a note to file: "figure out why the deck count is
 *  wrong" is an end goal for Praxis. Plans with a time cue ("look into X next week")
 *  are still filed, and a question stays a question. */
const INVESTIGATE_LEAD_RE =
  /^(?:look\s+into|dig\s+into|investigate|figure\s+out|find\s+out|diagnose|debug|root[- ]?cause|audit)\b/i;
const LATER_RE = /\b(?:next\s+(?:week|month|year)|tomorrow|later|someday|eventually|this\s+weekend|at\s+some\s+point)\b/i;

export function investigationClause(clause: string): boolean {
  const stripped = clause.replace(POLITE_LEAD_RE, "").trim();
  return INVESTIGATE_LEAD_RE.test(stripped) && !LATER_RE.test(stripped) && !/\?\s*$/.test(stripped);
}

/** A clause is worth FILING when the deterministic dump parser can lift a
 *  milestone from it (real plannable content), and it isn't purely a question
 *  or a bare control command. */
function isFilable(clause: string): boolean {
  return parseDump(clause).length > 0;
}

export interface SubmitPlan {
  /** The verbatim prompt (the persistent work-order text). */
  text: string;
  /** Control commands to run immediately via executeAndSpeak (view/window/trust/…). */
  commands: VoiceCommand[];
  /** Build/do goals to hand to orchestrate(). One per goal clause. */
  goals: string[];
  /** SOVEREIGN goals - sensitive credentialed/irreversible clauses (pay/post/log in
   *  /send/buy). These do NOT go to orchestrate(); at Trust IV they route into the
   *  sovereign_do browser-automation loop (with per-action veto), and below Trust IV
   *  the store refuses them honestly. Kept SEPARATE from `goals` so a "pay the invoice"
   *  clause can never be silently handed to the ordinary code-building loop. */
  sovereignGoals: string[];
  /** Whether the goal run(s) should use the unattended (long-horizon) budget. */
  unattended: boolean;
  /** Desktop tasks to do now on the owner's computer (operator.ts - Atlas's tools, no Atlas). */
  operations: string[];
  /** Questions to answer via ask(). */
  questions: string[];
  /** The full text to file onto the journey via dump() (empty = nothing to file). */
  fileText: string;
}

/**
 * Classify a submitted prompt into the faculties that apply. Every clause is
 * examined independently so a compound prompt fans out correctly:
 *
 *   - A clause that parseCommand resolves to a real CONTROL verb (not ask/capture)
 *     → a command (executed now). "capture" folds back into the file path so the
 *     journey stays the single filing surface.
 *   - A clause with a build/do lead verb → a goal (orchestrate()).
 *   - A clause that reads as a question → a question (ask()).
 *   - Any clause the dump parser can lift a milestone from → filed onto the journey.
 *
 * These are NOT mutually exclusive across clauses: the returned plan can carry
 * commands AND goals AND questions AND file text all at once.
 */
export function classifySubmit(rawText: string, areas: AreaRef[] = []): SubmitPlan {
  const text = rawText.trim();
  const plan: SubmitPlan = {
    text,
    commands: [],
    goals: [],
    sovereignGoals: [],
    unattended: UNATTENDED_RE.test(text),
    operations: [],
    questions: [],
    fileText: "",
  };
  if (!text) return plan;

  // A brain dump splits on the same cues the D box and Atlas's voice use, so one
  // sentence cannot be four tasks in one place and one task in another. A single
  // ask keeps the lenient split, which is what keeps its supporting detail attached
  // ("Fix the deck. The count is wrong when…" stays ONE goal with its context).
  const dumpMode = isMultiAskDump(text);
  const clauses = dumpMode ? splitBrainDumpClauses(text) : splitClauses(text);
  // clauses that should still be filed (not consumed by a command/goal/question)
  const fileClauses: string[] = [];
  // Index in plan.goals of the goal the previous clause produced, so a supporting
  // clause that can't stand on its own stays attached to it.
  let openGoal = -1;

  for (const clause of clauses) {
    const cmd = parseCommand(clause, areas);
    if (!dumpMode && openGoal >= 0 && CONTINUATION_RE.test(clause) && cmd?.intent.kind !== "fleet-model" && !GOAL_RE.test(clause) && !QUESTION_RE.test(clause)) {
      plan.goals[openGoal] = `${plan.goals[openGoal]} — ${clause}`;
      continue;
    }

    // 1) CONTROL command? parseCommand owns the whole Praxis verb vocabulary.
    if (cmd && cmd.intent.kind !== "ask" && cmd.intent.kind !== "capture") {
      plan.commands.push(cmd);
      openGoal = -1;
      continue; // a pure control verb isn't also filed/answered
    }

    if (sensitiveGoal(clause) && !QUESTION_RE.test(clause)) {
      plan.sovereignGoals.push(clause);
      openGoal = -1;
      continue;
    }

    // After a goal, a clause that points back at it ("open it in Chrome when it's done") is that
    // goal's delivery step, not something to do now.
    const operation = operatorClause(clause);
    if (operation) {
      if (!dumpMode && openGoal >= 0 && REFERS_BACK_RE.test(operation)) {
        plan.goals[openGoal] = `${plan.goals[openGoal]} — ${clause}`;
        continue;
      }
      plan.operations.push(operation);
      openGoal = -1;
      continue;
    }

    // 3a) Inside a dump, the dump classifier decides - it knows the owner's actual phrasing. He
    // states defects ("the usage limits are random") far more often than he issues imperatives,
    // and GOAL_RE's verb list would file those as notes instead of running them.
    if (dumpMode) {
      const [task] = splitBrainDump(clause);
      if (!task) continue; // pure filler ("ok", "um") - noise, not a lost ask
      if (task.kind === "build" || task.kind === "investigate") {
        plan.goals.push(clause);
        if (isFilable(clause)) fileClauses.push(clause);
      } else if (task.kind === "note") {
        fileClauses.push(clause);
      } else {
        // Unclassified is ANSWERED, never dropped: the brain can ask what was meant.
        plan.questions.push(clause);
      }
      continue;
    }

    // 3) BUILD/DO goal? An imperative to actually execute → orchestrator loop. An
    //    investigation ("figure out why…") is an end goal too, not a note.
    if (GOAL_RE.test(clause) || investigationClause(clause)) {
      plan.goals.push(clause);
      openGoal = plan.goals.length - 1;
      // a build goal is also worth remembering on the map - fall through to file it
      if (isFilable(clause)) fileClauses.push(clause);
      continue;
    }

    // 4) QUESTION? Answer it.
    if (QUESTION_RE.test(clause)) {
      plan.questions.push(clause);
      openGoal = -1;
      continue; // a question isn't a milestone
    }

    // 5) FILE - plannable content sprouts onto the journey. A "capture" command
    //    (remember/note/…) also lands here so the journey is the one filing path.
    if (cmd && cmd.intent.kind === "capture") {
      fileClauses.push(cmd.intent.text);
      openGoal = -1;
    } else if (isFilable(clause)) {
      fileClauses.push(clause);
      openGoal = -1;
    } else if (openGoal >= 0) {
      // A clause that is not a command, goal, question or plannable note used to be
      // DROPPED. After a goal it is that goal's supporting detail: "Create a personal
      // website - you choose the content, you have memory - using Vega, Quill and
      // Forge. Then open it in a browser and maximize it" reached the orchestrator as
      // just "Create a personal website", losing memory, the team and the delivery.
      plan.goals[openGoal] = `${plan.goals[openGoal]} — ${clause}`;
    }
  }

  // Preserve the original separators the dump parser understands by rejoining with
  // newlines - parseDump re-splits, so each filed clause becomes its own milestone.
  plan.fileText = fileClauses.join("\n");
  return plan;
}
