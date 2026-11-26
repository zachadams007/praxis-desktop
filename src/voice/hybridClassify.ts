/**
 * hybridClassify - PURE classification for the Hybrid Praxis fast router.
 *
 * The Hybrid router (hybridRouter.ts) runs a strict latency ladder per finalized
 * utterance: grammar → native op → direct-input primitive → brain intent parse.
 * This module owns two of the pure, testable pieces of that ladder:
 *
 *   1. LOCAL pre-classification (zero-latency, no model): detect the utterance
 *      shapes we can resolve WITHOUT a brain round-trip -
 *        • HALT       ("stop", "cancel", "never mind") - abort the current action/run
 *        • UNATTENDED ("go do everything", "handle it all") - a long-horizon,
 *                     multi-task overnight-style run (distinct from ESCALATE below)
 *        • TYPE       ("type this: …", "type hello world") - direct text injection
 *        • PRESS      ("press enter", "hit tab", "press escape")
 *        • SCROLL     ("scroll down", "scroll up a bit")
 *        • TODO       ("remind me to …", "add a to-do …", "note that …", "I need to …")
 *      Anything else is UNKNOWN → the router falls through to the brain classify.
 *
 *   2. The brain CLASSIFY prompt + parse: for UNKNOWN utterances, ask the fast NIM
 *      brain to bucket the utterance into QUICK_ACTION | ANSWER | TODO | ESCALATE |
 *      UNATTENDED with a tiny, low-latency response contract.
 *
 * ESCALATE vs UNATTENDED (read before touching either path):
 *
 * PURE + testable (scripts/test-hybrid-router.cjs): no React, no Tauri, no DOM.
 */

// ── Local pre-classification ────────────────────────────────────────────────

export type LocalKind =
  | { kind: "halt" }
  | { kind: "unattended"; note?: string }
  | { kind: "type"; text: string }
  | { kind: "press"; key: string; confirmed?: boolean }
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "todo"; text: string }
  | { kind: "unknown" };

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[.!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * HALT - abort the current action or escalated run. Deliberately tight: only
 * bare, unambiguous stop phrases. "stop the music" carries an object and must
 * NOT halt the session (it's a media op), so we anchor to end-of-utterance.
 */
const HALT_RE =
  /^(?:praxis[,\s]+)?(?:stop|cancel|nevermind|never mind|abort|wait|hold on|hold up|forget it|stop that|cancel that|stop it|that's enough|enough)$/i;

/**
 * UNATTENDED - the "go do everything" family. Deliberately a canonical-phrase fast
 * match (zero brain latency) covering the owner's stated forms plus close variants; any
 * paraphrase that doesn't match falls through to the brain classify's UNATTENDED
 * bucket (see classifyPrompt below) so odd phrasings still route correctly, just
 * with one extra round-trip. Anchored loosely (not full-utterance) so a leading
 * "Praxis," or a trailing "please"/"tonight" doesn't defeat the match, but each verb
 * phrase still requires its full object ("do/handle/work through/run" + "everything
 * /it all") - a bare "go" or "run" must NEVER match (that's ordinary transport/build
 * vocabulary elsewhere in the router).
 */
const UNATTENDED_RE =
  /\b(?:go\s+)?(?:do|handle|take care of|work through|clear|run|get)\s+(?:everything|it all|the whole (?:backlog|list|to-?do list|roadmap)|all of it|all the (?:tasks|to-?dos))\b|\bjust\s+(?:handle|do)\s+everything\b|\bhandle\s+it\s+all\b/i;

/**
 * TYPE - direct text injection. Two shapes:
 *   "type this: <text>" / "type the following <text>"  → explicit colon/marker
 *   "type <text>"                                        → bare, rest is the text
 * The captured text keeps its ORIGINAL casing (we match on raw, not normalized).
 * "type" with no payload is not a type op (falls through).
 */
const TYPE_MARKER_RE =
  /^\s*(?:please\s+)?(?:type|enter|write|input|dictate)\s+(?:this|the following|out|in)?\s*[:,-]\s*(.+?)\s*$/i;
const TYPE_BARE_RE =
  /^\s*(?:please\s+)?(?:type|write|input|dictate)\s+(?:out\s+|in\s+)?(.+?)\s*$/i;

/**
 * PRESS - a single named key. "press enter" / "hit tab" / "press the escape key".
 * The key name is validated Rust-side (hybrid_ops::resolve_key); here we just
 * extract the spoken key token. A bare "press" with no key falls through.
 */
const PRESS_RE =
  /^\s*(?:please\s+)?(?:(confirm)\s+)?(?:press|hit|tap|push|strike)\s+(?:the\s+)?(.+?)(?:\s+key|\s+button)?\s*$/i;

/** Keys that Rust normalizes to Return and that can submit/send the active UI. */
export function requiresSubmitConfirmation(key: string): boolean {
  return ["enter", "return", "submit"].includes(key.trim().toLowerCase());
}

/** SCROLL - "scroll down", "scroll up a bit", "scroll down 5". */
const SCROLL_RE =
  /^\s*(?:please\s+)?scroll\s+(up|down)\b(?:\s+(?:by\s+)?(\d+))?/i;

/**
 * TODO - a note/task to capture (not a command). Explicit task-capture phrasing
 * only, so a passing remark never becomes a to-do:
 *   "remind me to X" / "add a to-do to X" / "note that X" / "I need to X" /
 *   "todo: X" / "put X on my to-do list" / "don't let me forget to X"
 * The captured text keeps original casing.
 */
const TODO_RE =
  /^\s*(?:please\s+)?(?:remind me to\s+(.+)|(?:add|make|create)\s+(?:a\s+)?(?:to-?do|task|reminder|note)\s*(?:to|that|for|:|-)?\s+(.+)|note (?:that|down|to)\s+(.+)|to-?do\s*[:,-]\s*(.+)|don'?t let me forget to\s+(.+)|i (?:need|have|want|gotta|got to|have got) to\s+(.+)|put\s+(.+?)\s+on my (?:to-?do|task)\s*(?:list)?)\s*$/i;

/**
 * An unmistakable, imperative BUILD request: it OPENS with a build verb aimed at a thing
 * ("create a personal website …", "build me a landing page", "fix the deck count"), is not a
 * question, and has real content. Such an utterance needs no classifier to know it is a job for
 * Praxis. Deliberately narrow: "make"/"design"/"write" count only with a real artifact noun, so
 * "make me a coffee" or "set up a meeting" still go to the classifier.
 */
const ARTIFACT_NOUN =
  "(?:new\\s+|personal\\s+|simple\\s+|small\\s+|landing\\s+)*(?:web ?site|site|web ?page|page|landing page|portfolio|app|web app|game|tool|dashboard|script|extension|prototype|demo|blog|api|bot|cli)";
const IMPERATIVE_BUILD_RE = new RegExp(
  "^(?:(?:hey|ok|okay|so)[,\\s]+)?(?:(?:atlas|praxis)[,\\s]+)?(?:(?:please|can you|could you|would you|will you|i want you to|i need you to|go ahead and|let's)\\s+)*" +
    "(?:build|create|implement|scaffold|generate|refactor|code up|spin up|fix|" +
    `(?:make|design|write)\\s+(?:me\\s+|us\\s+)?(?:a|an|my|the)\\s+${ARTIFACT_NOUN})\\b`,
  "i",
);

export function isImperativeBuildGoal(raw: string): boolean {
  const text = raw.trim();
  if (!text || /\?\s*$/.test(text)) return false;
  if (!IMPERATIVE_BUILD_RE.test(text)) return false;
  return text.split(/\s+/).filter(Boolean).length >= 4;
}

/** Word-number map for spoken scroll amounts ("scroll down three"). */
const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Classify an utterance with ZERO latency (no model). Returns a concrete local
 * op or `{ kind: "unknown" }` when the utterance needs the brain to decide.
 * Order matters: HALT first (safety), then the direct primitives, then TODO.
 */
export function classifyLocal(raw: string): LocalKind {
  const text = normalize(raw);
  if (!text) return { kind: "unknown" };

  if (HALT_RE.test(text)) return { kind: "halt" };

  // UNATTENDED - the "go do everything" family, checked right after HALT (before
  // any direct-input primitive) so it can never be misread as typing/pressing a
  // literal word. Canonical phrases only here; paraphrases fall through to the
  // brain classify's UNATTENDED bucket.
  if (UNATTENDED_RE.test(text)) return { kind: "unattended" };

  // TYPE - check the marker form first (explicit "type this: …") on RAW text so
  // the injected text keeps its casing; then the bare form.
  const marker = raw.trim().match(TYPE_MARKER_RE);
  if (marker && marker[1]?.trim()) return { kind: "type", text: marker[1].trim() };

  // SCROLL and PRESS must be checked before bare-TYPE so "type" never eats them,
  // and so "scroll down" isn't read as typing "down".
  const scroll = text.match(SCROLL_RE);
  if (scroll) {
    const direction = scroll[1].toLowerCase() as "up" | "down";
    let amount: number | undefined;
    if (scroll[2]) amount = parseInt(scroll[2], 10);
    else {
      const w = Object.keys(WORD_NUM).find((k) => new RegExp(`\\b${k}\\b`).test(text));
      if (w) amount = WORD_NUM[w];
    }
    return { kind: "scroll", direction, amount };
  }

  const press = text.match(PRESS_RE);
  if (press && press[2]?.trim()) {
    // Reject press payloads that are obviously a sentence, not a key name - a
    // real key phrase is short (≤ 3 words: "arrow down", "page up").
    const key = press[2].trim();
    if (key.split(/\s+/).length <= 3) return { kind: "press", key, confirmed: Boolean(press[1]) };
  }

  const todo = raw.trim().match(TODO_RE);
  if (todo) {
    const captured = (todo.slice(1).find((g) => g && g.trim()) ?? "").trim();
    if (captured.length > 1) return { kind: "todo", text: captured };
  }

  const bare = raw.trim().match(TYPE_BARE_RE);
  if (bare && bare[1]?.trim()) return { kind: "type", text: bare[1].trim() };

  return { kind: "unknown" };
}

// ── Brain classification (fast NIM intent parse) ────────────────────────────

export type BrainClass = "QUICK_ACTION" | "ANSWER" | "TODO" | "ESCALATE" | "UNATTENDED";

export interface BrainClassResult {
  /** The bucket the brain chose. */
  class: BrainClass;
  /** For ANSWER: a short spoken reply. For QUICK_ACTION: a normalized command to
   *  re-route (e.g. "open chrome"). For TODO: the task text. For ESCALATE: the
   *  goal to hand to orchestrate(). For UNATTENDED: an optional focus note (may be
   *  empty - scope is pulled from the to-do/ledger, not spoken). Empty string when
   *  the brain omitted it. */
  payload: string;
}

/**
 * The CLASSIFY system prompt. Tight + explicit so the fast model returns a tiny,
 * parseable line and stays low-latency. It classifies a single conversational
 * utterance into one of five buckets and returns ONE line of JSON.
 */
export function classifyPrompt(utterance: string): string {
  return [
    "You are Atlas — the fast, front-of-house voice of Praxis, the user's AI operating system. You share Praxis's memory and answer from the same knowledge. You answer instantly and operate the computer, but NEVER do long multi-step reasoning yourself — you hand big jobs to Mission (the deep builder) via ESCALATE.",
    "For this turn you are the fast intent classifier: classify the user's utterance into EXACTLY one of these buckets and reply with ONE line of minified JSON, no prose, no fences:",
    '{"class":"QUICK_ACTION"|"ANSWER"|"TODO"|"ESCALATE"|"UNATTENDED","payload":"..."}',
    "",
    "- QUICK_ACTION: a simple, single-step computer action (open an app/site, search the web, play/pause media, focus a window). payload = a short normalized command like \"open chrome\" or \"search for weather in lisbon\".",
    "- ANSWER: a question or chit-chat you (as Atlas) can answer in ONE short spoken sentence from Praxis's shared knowledge. payload = that sentence (<= 25 words, conversational, no markdown, first-person as Atlas).",
    "- TODO: the user is noting a task/reminder to remember, not asking you to do it now. payload = the task text.",
    "- ESCALATE: ONE specific multi-step or heavy job named in the utterance (write/build/fix/refactor code, research, anything needing several steps of reasoning or tools). You never do these in the fast lane — they go to Mission. payload = a clear one-line goal to hand to Mission.",
    "- UNATTENDED: the user wants an open-ended, long-running session that works through EVERYTHING it can (their whole backlog/to-do list), not one named task — phrases like \"go do everything\", \"handle everything\", \"work through my whole list\", \"just take care of it all tonight\". No single goal is named. payload = an optional short focus note if they mentioned one (e.g. \"focus on Praxis\"), else empty string.",
    "",
    "Prefer QUICK_ACTION over ESCALATE for anything that is one obvious action. Prefer ANSWER for questions. Only pick UNATTENDED when the request is clearly open-ended/everything-scoped, not a single named task (that's ESCALATE). Keep payload short.",
    "",
    `Utterance: ${utterance}`,
  ].join("\n");
}

/** Strip ```json … ``` fences a model may add despite instructions. */
function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

const VALID_CLASSES: BrainClass[] = ["QUICK_ACTION", "ANSWER", "TODO", "ESCALATE", "UNATTENDED"];

/**
 * Parse the brain's classify reply. Tolerant: accepts the JSON line, or a bare
 * "CLASS: payload" fallback, or a leading class token. Returns null only when no
 * class token is recoverable - the caller then treats the utterance as an ANSWER
 * with the raw text (never silently drops it).
 */
export function parseClassify(raw: string): BrainClassResult | null {
  if (!raw || !raw.trim()) return null;
  const body = stripFences(raw);

  // Preferred path: a JSON object.
  try {
    const obj = JSON.parse(body) as unknown;
    if (typeof obj === "object" && obj !== null) {
      const o = obj as { class?: unknown; payload?: unknown };
      const cls = typeof o.class === "string" ? o.class.trim().toUpperCase() : "";
      if (VALID_CLASSES.includes(cls as BrainClass)) {
        return {
          class: cls as BrainClass,
          payload: typeof o.payload === "string" ? o.payload.trim() : "",
        };
      }
    }
  } catch {
    /* not JSON - fall through to the loose parse */
  }

  // Loose path: find a class token anywhere near the start, take the rest as payload.
  const upper = body.toUpperCase();
  for (const cls of VALID_CLASSES) {
    const idx = upper.indexOf(cls);
    if (idx !== -1 && idx < 40) {
      const after = body.slice(idx + cls.length).replace(/^["'\s:,-]+/, "").replace(/["']+$/, "").trim();
      return { class: cls, payload: after };
    }
  }
  return null;
}
