/**
 * Faculty A - the write-path ("brain-dump"), MOCK (spec §B.2).
 *
 * A deterministic LOCAL parser - no LLM, zero spend. It splits a dump into
 * clauses, routes each to a branch by keyword, lifts an eta/status hint when
 * one is present, and cleans the clause into a milestone label. In Phase 3
 * the real ingestion replaces this module; the contract (text → drafts)
 * stays identical.
 */

import type { MilestoneStatus } from "@/data/journey";

export interface DumpDraft {
  areaId: string;
  label: string;
  status: Extract<MilestoneStatus, "next" | "later">;
  eta?: string;
}

// Routed in order - first match wins. Praxis is also the fallback lane, so its
// generic words (agent, brain) sit last and everything else gets first claim.
const AREA_KEYWORDS: [string, RegExp][] = [
  ["catalyzed", /\b(catalyzed|stocks?|tickers?|terminal|feeds?|signals?|blueprint|scor(?:e|es|ing)|watchlist|alerts?)\b/i],
  ["ventures", /\b(freelanc\w*|client|gig|business|monetiz\w*|pricing|offer|invoice|contract|revenue)\b/i],
  ["finance", /\b(finance|financial|money|budget|spend|cost|usage|portfolio|account|ledger|trad(?:e|es|ing)|bot|backtest|paper-?trade|broker|quant|algo)\b/i],
  ["studio", /\b(videos?|tiktok|insta(?:gram)?|youtube|shorts|reels?|studio|content|post(?:s|ing)?|channels?|clips?|caption)\b/i],
  ["learnai", /\b(learn|stud(?:y|ies)|course|tutorial|skill|workflow|codex|agents?|subscription|prompt|three\.?js|r3f|webgl|rust|python|shader)\b/i],
  ["praxis", /\b(praxis|jarvis|brain|orchestrator|journey|gestures?|voice|memory|3d)\b/i],
];

const ETA_RE = /\b(today|tonight|tomorrow|this week|next week|this month|next month|phase ?[23]|q[1-4])\b/i;
const LATER_RE = /\b(later|someday|eventually|backlog|one day|phase ?[23])\b/i;
const LEAD_VERBS = /^(?:add|build|make|create|finish|start|do|ship|set ?up|wire|fix|try|get|plan|research)\s+(?:the\s+|a\s+|an\s+)?/i;

export function routeArea(clause: string): string {
  for (const [areaId, re] of AREA_KEYWORDS) {
    if (re.test(clause)) return areaId;
  }
  return "praxis"; // the OS catches what nothing else claims
}

function toLabel(clause: string): string {
  let s = clause.replace(ETA_RE, "").replace(/\s{2,}/g, " ").trim();
  s = s.replace(LEAD_VERBS, "");
  s = s.replace(/[.!?\s]+$/g, "").trim();
  if (!s) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 44 ? `${s.slice(0, 42).trimEnd()}…` : s;
}

/** Deterministic dump → milestone drafts. Empty input → empty array. */
export function parseDump(text: string): DumpDraft[] {
  return text
    .split(/\r?\n|;|·|•|—|(?:\s+\+\s+)/)
    .map((c) => c.trim())
    .filter((c) => c.length > 2)
    .map((clause): DumpDraft | null => {
      const eta = clause.match(ETA_RE)?.[1]?.toLowerCase();
      const status: DumpDraft["status"] = LATER_RE.test(clause) ? "later" : "next";
      const label = toLabel(clause);
      if (!label) return null;
      const draft: DumpDraft = { areaId: routeArea(clause), label, status };
      if (eta) draft.eta = eta;
      return draft;
    })
    .filter((d): d is DumpDraft => d !== null)
    .slice(0, 6); // a dump is a thought, not a spreadsheet
}

// ═══════════════════════════════════════════════════════════════════════════
// Brain dump → discrete tasks (2026-09-12)
//
// This section turns it into WORK: one task per ask, each with the verbatim words it came from,
// the repo it implies, and what kind of work it is, so the orchestrator can route each one to a
// real tool.
//
// Deterministic and local (no model call, zero spend) so the split is the same
// every time and testable offline. A piece that has real words but fits no kind
// is kept as "unclassified" - dropping half a brain dump is the failure mode
// that makes the whole feature untrustworthy.
// ═══════════════════════════════════════════════════════════════════════════

export type BrainDumpKind = "build" | "investigate" | "note" | "unclassified";

export interface BrainDumpRepo {
  /** Short id: "praxis" | "catalyzed-alpha" | "trading-bot". */
  id: string;
  /** Absolute folder a worker should run in. */
  folder: string;
  /** The word(s) in the clause that implied this repo. */
  hint: string;
}

export interface BrainDumpTask {
  /** Stable within one dump, in spoken order: "t1", "t2", … */
  id: string;
  /** The verbatim clause this task came from (only glue/whitespace trimmed). */
  text: string;
  /** The clause with spoken filler stripped - what a worker is actually asked. */
  ask: string;
  kind: BrainDumpKind;
  /** Repo/folder when the clause implies one; absent when it doesn't. */
  repo?: BrainDumpRepo;
  /** Journey lane (same router parseDump uses), for filing/visibility. */
  areaId: string;
}

/**
 * Repos a clause can imply. Folders are the real checkouts on this machine
 * (Desktop layout as of 2026-09-12). The dispatcher probes each folder before
 * spawning anything there and refuses out loud when it is missing - this table
 * is a hint, not a promise.
 */
export const REPO_HINTS: ReadonlyArray<{ id: string; folder: string; re: RegExp }> = [
  {
    id: "praxis",
    folder: "C:\\Users\\dev\\Desktop\\praxis",
    // Praxis names its UI, not just its windows. A dump says "the restore button in
    // the control panel", "forge keeps orbiting", "the usage limits are random" -
    // none of which contained a window name, so each got no repo and could not be
    // dispatched anywhere.
    re: /\b(praxis|flight ?deck|(?:memory )?galaxy|brain ?window|command ?cent(?:er|re)|control ?panel|controls? tab|atlas|hud|journey|neural|mission input|dump ?box|knowledge window|tauri|r3f|three\.?js|voice loop|wake word|orchestrator|forge|vega|quill|sage|lens|scribe|fleet|orbit(?:s|ing)?|board meeting|agent board|supply (?:panel|rail)|usage (?:limits?|rails?|panel|window)|breakers?|trust dial|restore button|converse|inbox|sigil)\b/i,
  },
  // The Earnings Print Detector is its OWN project (a trading-bot lane), not part of
  // Catalyzed Alpha. The catalyzed pattern used to claim "earnings? detector|earnings",
  // so "why the earnings detector missed BABA" was dispatched to the wrong repo.
  {
    id: "earnings-print-detector",
    folder: "C:\\Users\\dev\\Desktop\\trading-bot-lanes\\earnings-print-detector",
    re: /\b(earnings? (?:print )?detector|earnings? print|print detector|earnings panel)\b/i,
  },
  {
    id: "catalyzed-alpha",
    folder: "C:\\Users\\dev\\Desktop\\catalyzed-alpha",
    re: /\b(catalyzed|tickers?|watchlist|blueprint|catalysts?|scor(?:e|es|ing) engine|signal feed|the feed|the terminal|research desk)\b/i,
  },
  {
    id: "trading-bot",
    folder: "C:\\Users\\dev\\Desktop\\trading-bot",
    re: /\b(trading ?bot|the bot|backtests?|backtesting|broker|paper[- ]?trad(?:e|es|ing)|order (?:router|flow|book)|fills?|position sizing)\b/i,
  },
];

/** Infer the repo a clause implies, if any (first hint wins, table order). */
export function inferRepo(clause: string): BrainDumpRepo | undefined {
  for (const { id, folder, re } of REPO_HINTS) {
    const m = clause.match(re);
    if (m) return { id, folder, hint: m[1] ?? m[0] };
  }
  return undefined;
}

// ── Splitting ────────────────────────────────────────────────────────────────

/** Hard separators typed dumps use (plus sentence ends that aren't decimals). */
const HARD_SEP_RE = /\r?\n|;|·|•|(?:\s+—\s+)|(?:\s+\+\s+)|(?<![0-9])[.!?]+\s+(?=\S)/;


/** Request-shaped openers: a person asking for something new. */
const REQUEST_CUE =
  "(?:can|could|would|will) (?:you|u)\\b|remind me\\b|remember to\\b|don'?t forget\\b|i (?:want|need|wanna|gotta)\\b|i'?d like\\b|please\\b|let'?s\\b|we (?:should|need)\\b|the \\w+(?: \\w+)? (?:is|still|keeps|won'?t|doesn'?t|isn'?t|should)\\b";
/** Request cues plus lead verbs - only trusted after an explicit ", and" / ", then". */
const ASK_CUE =
  REQUEST_CUE +
  "|(?:look|dig) into\\b|figure out\\b|find out\\b|check (?:why|whether|if|out)\\b|investigate\\b|fix\\b|make (?:the|it|sure)\\b|build\\b|add\\b";

const CONNECTOR_RE = new RegExp(
  [
    // ", also" / ", and also" / " and also" - the comma or "and" is what makes it a new ask
    "\\s*,\\s*(?:and\\s+)?also\\b\\s*[,:\\-]?\\s*",
    "\\s+and\\s+also\\b\\s*[,:\\-]?\\s*",
    // markers that are new-ask glue wherever they appear
    "\\s*,?\\s*\\b(?:and\\s+)?(?:oh\\s*,?\\s*(?:and|also)|plus|additionally|on top of that|another thing|one more thing|lastly|finally|next up|secondly|thirdly)\\b\\s*[,:\\-]?\\s*",
    // ", then <cue>" / ", and <cue>" - a fresh ask after an explicit joiner
    "\\s*,\\s*(?:then|and)\\s+(?=" + ASK_CUE + ")",
    // " and <request>" (spoken, no comma) - only person-asking cues
    "\\s+and\\s+(?=(?:can|could|would|will) (?:you|u)\\b|remind me\\b|don'?t forget\\b|i (?:want|need|wanna)\\b|please\\b|(?:look|dig) into\\b|figure out\\b|find out\\b)",
    // ", <request>"
    "\\s*,\\s*(?=" + REQUEST_CUE + ")",
  ].join("|"),
  "gi",
);

/** Spoken filler a clause may open with. Stripped from `ask`, kept in `text`. */
const LEAD_FILLER_RE =
  /^(?:(?:ok(?:ay)?|so|um+|uh+|uhh*|hmm+|alright|right|hey|yeah|yep|well|like|anyway|anyways|basically|actually|honestly|oh|and|also|then|plus|lastly|finally)[,\s]+)+/i;

/** Softeners in front of the actual ask ("can you", "please", "oh and"). */
const SOFTENER_RE = /^(?:(?:can|could|would|will) (?:you|u)(?: please)?|please|i'?d like you to|i want you to|i need you to|go ahead and|just)[,\s]+/i;

/** Trailing spoken debris ("…, ok?", "…thanks"). */
const TAIL_FILLER_RE = /[\s,]*\b(?:ok(?:ay)?\??|thanks|thank you|please|yeah|alright)\s*[.!?]*$/i;

function cleanAsk(clause: string): string {
  let s = clause.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(LEAD_FILLER_RE, "").replace(SOFTENER_RE, "").trim();
    if (s === before) break;
  }
  s = s.replace(TAIL_FILLER_RE, "").replace(/[\s,.;:!?]+$/g, "").trim();
  return s;
}

/** Split one dump into verbatim clauses (glue consumed, content untouched). */
export function splitBrainDumpClauses(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(HARD_SEP_RE)) {
    if (!piece || !piece.trim()) continue;
    for (const clause of piece.split(CONNECTOR_RE)) {
      const c = clause?.trim().replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "");
      if (c) out.push(c);
    }
  }
  return out;
}

// ── Classification ───────────────────────────────────────────────────────────

/** A NOTE: something to remember/file - never dispatched to a coding tool. */
const NOTE_RE =
  /^(?:remind me|remember (?:to|that|the)|don'?t (?:let me )?forget|note(?: to self)?\b|jot (?:down|this)|write (?:down|this down)|make a note|add (?:it |this |that )?to (?:my|the) (?:list|todo|to-do|backlog)|todo\b|to-do\b|memo\b|save this|file (?:this|that)|put (?:this|that|it) on (?:my|the) (?:list|board|backlog)|idea:)/i;

/** An INVESTIGATION: find out why, no product change expected up front. */
const INVESTIGATE_RE =
  /\b(?:look into|investigate|dig into|figure out|find out|check (?:why|whether|if|what|out|on)|diagnose|debug|root[- ]?cause|why\b|what happened|what'?s going on|what went wrong|audit|review why|understand|explain|see if|see whether|see what|compare|research|analy[sz]e)\b/i;

/**
 * A BUILD: an imperative, a defect report, or a desired behaviour change.
 *
 * The owner rarely phrases an ask as an imperative. He states what is wrong: "the usage limits are
 * random", "it's all stale", "forge keeps orbiting", "the agents say unavailable". A complaint
 * about a thing he built IS a request to fix it, so the defect words he actually uses are build
 * cues - otherwise most of a real dump lands in "unclassified" and the brain dump does nothing.
 */
const BUILD_RE =
  /\b(?:fix|build|implement|create|code|refactor|wire\s*up|set\s*up|scaffold|generate|write|make|ship|deploy|automate|add|remove|delete|rename|move|change|update|upgrade|tweak|adjust|polish|redesign|restyle|improve|speed up|optimi[sz]e|stop|start|enable|disable|hide|show|swap|replace|convert|migrate|port|clean up|tidy|should(?:n'?t)?|still (?:shows?|does|is|has|doesn'?t|isn'?t|won'?t|broken|says|thinks)|(?:is|are|looks?|seems?|feels?) (?:wrong|broken|off|missing|stuck|slow|flaky|laggy)|wrong|broken|doesn'?t work|isn'?t working|not working|keeps? (?:crashing|spinning|failing|breaking|freezing|dying|orbiting|showing|saying|popping up)|random|inaccurate|not accurate|stale|outdated|out of date|incorrect|frozen|not updating|doesn'?t update|isn'?t updating|made[- ]up|not real|fake|unavailable|(?:is|are) (?:random|inaccurate|stale|frozen|incorrect|fake|unavailable|outdated)|won'?t|bug|glitch|crash(?:es|ing)?|lag(?:s|gy|ging)?|jank(?:y)?|i want (?:the|it|to|a|an)|i need (?:the|it|to|a|an)|i'?d like (?:the|it|to|a|an))\b/i;

/** Classify one cleaned ask. Order matters: a note beats an investigation beats a build. */
export function classifyBrainDumpKind(ask: string): BrainDumpKind {
  if (!ask) return "unclassified";
  if (NOTE_RE.test(ask)) return "note";
  if (INVESTIGATE_RE.test(ask)) return "investigate";
  if (BUILD_RE.test(ask)) return "build";
  return "unclassified";
}

/**
 * Brain dump → discrete tasks. The verbatim clause rides along on every task;
 * nothing with real words is dropped - it becomes "unclassified" instead.
 * Pieces that are ONLY filler ("ok", "um", "thanks") are not work and are not
 * kept; they are noise, not a lost ask.
 */
/** The unambiguous ways a person signals "and here is ANOTHER thing". */
const MULTI_ASK_MARKER_RE =
  /(?:^|[\s,.;:])(?:also|oh\s*,?\s*and|plus|additionally|on top of that|another thing|one more thing|the other thing(?: is)?|not to mention|furthermore|secondly|thirdly|lastly|finally|next up|first of all)\b|,\s*(?:and\s+|then\s+)?(?:can|could|would|will) (?:you|u)\b|(?:\band\b|,)\s*(?:remind me|don'?t forget|remember to)\b/i;

/** A typed list: newlines, semicolons, bullets, spaced dashes or pluses. */
const LIST_SEP_RE = /\r?\n|;|·|•|\s+—\s+|\s+\+\s+/;

/** A clause that STARTS a new instruction, as opposed to describing the last one. */
const LEAD_ASK_RE =
  /^(?:fix|build|implement|create|add|remove|delete|rename|move|change|update|upgrade|make|stop|start|enable|disable|hide|show|swap|replace|convert|migrate|clean\s+up|tidy|improve|speed\s+up|optimi[sz]e|refactor|rewrite|write|ship|deploy|automate|wire\s*up|set\s*up|look\s+into|investigate|dig\s+into|figure\s+out|find\s+out|check|diagnose|debug|audit|review|research|compare|explain|remind\s+me|remember|note|jot|todo|(?:can|could|would|will)\s+(?:you|u)|please|i\s+(?:want|need)|i'?d\s+like|let'?s|we\s+(?:should|need))\b/i;

/**
 * Is this utterance a BRAIN DUMP - several separate asks - or one ask?
 *
 * The single definition every entry point uses, so the D box, Atlas's voice and
 * the Mission input cannot disagree about the same sentence.
 *
 * Speaking the same four asks sent the whole paragraph to ONE agent run.
 *
 * Splitting too eagerly is its own failure, so a dump needs BOTH:
 *   1. at least two pieces that are real work (a build, an investigation, or a
 *      note to file). Chatter with one incidental request stays one thing.
 *   2. a signal the SPEAKER meant several things - a list separator, an explicit
 *      "also / oh and / one more thing / can you", or two sentences that each
 *      LEAD with an instruction.
 *
 * Rule 2 is what keeps context attached. "Fix the deck. The count is wrong when
 * sessions archive." is one ask followed by the detail an agent needs; split, the
 * worker would receive "fix the deck" with no idea what is wrong with it.
 */
export function isMultiAskDump(text: string): boolean {
  const real = splitBrainDump(text).filter((t) => t.kind !== "unclassified");
  if (real.length < 2) return false;
  if (LIST_SEP_RE.test(text) || MULTI_ASK_MARKER_RE.test(text)) return true;
  const leading = real.filter(
    (t) => LEAD_ASK_RE.test(t.text.trim().replace(LEAD_FILLER_RE, "")) || LEAD_ASK_RE.test(t.ask),
  );
  return leading.length >= 2;
}

export function splitBrainDump(text: string): BrainDumpTask[] {
  const tasks: BrainDumpTask[] = [];
  for (const clause of splitBrainDumpClauses(text)) {
    const ask = cleanAsk(clause);
    // Fewer than two real words is filler or a stray fragment, not a task.
    if (ask.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length < 2) continue;
    const task: BrainDumpTask = {
      id: `t${tasks.length + 1}`,
      text: clause,
      ask,
      kind: classifyBrainDumpKind(ask),
      areaId: routeArea(ask),
    };
    const repo = inferRepo(ask);
    if (repo) task.repo = repo;
    tasks.push(task);
  }
  return tasks;
}
