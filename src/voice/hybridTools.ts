/**
 * hybridTools - the ONE source of truth for the Realtime session's tool roster and
 * its dispatcher.
 *
 * ── How this used to be wrong (do not reintroduce it) ────────────────────────
 * Every tool call was converted BACK into an English sentence and re-parsed by
 * `routeHybridUtterance`'s regex ladder. The model would correctly decide
 * "open the browser"; the ladder would fail to match "browser" against a
 * 16-entry hardcoded alias table, fall through to a Codex-Desktop prompt-paste,
 * and refuse it because execution mode wasn't "Live". Atlas could not open a
 * browser - not because it lacked permission, but because its own decision was
 * discarded and guessed at again.
 *
 * ── The rule now ────────────────────────────────────────────────────────────
 * DESKTOP tools (open/focus/click/type/press/scroll/search) dispatch STRAIGHT to
 * the `desktop_*` and `hybrid_*` Rust primitives. The model already named the
 * target; re-parsing it can only lose information.
 *
 * IN-APP tools (halt, capture_todo, escalate, and `praxis_command` for Praxis's
 * own window verbs) still route through `routeHybridUtterance`, because those
 * genuinely need the router's grammar, sovereign gate, and never-escalate guard.
 *
 * The trust gate is applied ONCE per call here via `operatorActionBlockedReason`
 * - the same shared policy the local voice lane uses - so both lanes agree on
 * what's allowed without one of them silently owning a second copy of the rules.
 */

import { routeEscalation, routeHybridUtterance, type HybridFeedItem } from "./hybridRouter";
import type { HybridTransport } from "./hybridTransport";
// Shared sovereign sensitivity test - so a sensitive escalate goal passes through
// verbatim to the router's sovereign rung instead of being "build:"-prefixed.
import { sensitiveGoal } from "@/shared/sovereignGate";
import type { OperatorStopResult } from "./stopOperatorRuns";
import { searchWebAnswer, webSearchSpokenBrief } from "./webSearchAnswer";
import { operatorActionBlockedReason } from "./operatorPolicy";
import { hybridType, hybridPress, hybridScroll } from "./hybridActions";
import {
  click as desktopClick,
  clickElement as desktopClickElement,
  clearPopups as desktopClearPopups,
  fillField as desktopFillField,
  recallMemory,
  listElements as desktopListElements,
  focusWindow as desktopFocusWindow,
  listWindows as desktopListWindows,
  openApp as desktopOpenApp,
  openUrl as desktopOpenUrl,
  screenshot as desktopScreenshot,
  screenLocked,
  SCREEN_LOCKED_MESSAGE,
  webSearch as desktopWebSearch,
  windowControl as desktopWindowControl,
  type DesktopResult,
} from "./desktopActions";

/** Tools that act ON the screen: behind a locked screen none of them can work. */
const NEEDS_SCREEN = new Set([
  "focus_window",
  "window_control",
  "click_element",
  "clear_popups",
  "click",
  "type_text",
  "fill_field",
  "press_key",
  "scroll",
]);

/**
 * How long text Atlas typed counts as "ours" when a suggestion list covers the next target.
 *
 * Nothing accepted the suggestion that Atlas's own typing had opened.
 */
export const OWN_SUGGESTION_MS = 90_000;

/** Tools whose "covered by …" result is retried once after accepting our own suggestion. */
const RETRY_WHEN_COVERED = new Set(["click_element", "fill_field"]);

/** The last text type_text / fill_field typed, and when. */
let lastTyped: { text: string; at: number } | null = null;

/**
 * The name of what covers the target, when it is the suggestion our own typing opened -
 * i.e. the result says `covered by "X"` and X contains the typed text (case-insensitive,
 * within OWN_SUGGESTION_MS). Null otherwise. Pure, so it is unit-tested.
 */
export function coveringSuggestion(
  result: string,
  typed: { text: string; at: number } | null,
  now: number,
): string | null {
  if (!typed || now - typed.at > OWN_SUGGESTION_MS || now < typed.at) return null;
  const match = /covered by "((?:[^"\\]|\\.)*)"/.exec(result);
  if (!match) return null;
  // Rust Debug-formats the name: \" and \\ are escapes, \n a line break.
  const cover = match[1].replace(/\\n/g, " ").replace(/\\(.)/g, "$1").trim();
  const want = typed.text.trim().toLowerCase();
  return want && cover.toLowerCase().includes(want) ? cover : null;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tool spec shape the Realtime session advertises (OpenAI function-tool schema). */
export interface RealtimeToolSpec {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The tools the Realtime model is given. These mirror the router's rungs 1:1:
 * native ops (open/url/search/focus/media), direct input (type/press/scroll),
 * to-do capture, and escalation to the background orchestrator.
 */
export const HYBRID_TOOL_SPECS: RealtimeToolSpec[] = [
  {
    type: "function",
    name: "halt",
    description:
      "Immediately stop or cancel the current Praxis action. Always call this for bare stop, cancel, never mind, wait, hold on, Praxis stop, or that's enough.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "open_app",
    description:
      "Open any application on this Windows machine by name, or focus it if it is already running. Works for ANY installed app — not a fixed list. Use this whenever the user asks to open, launch, bring up, or start a program. For a plain 'open the browser' pass \"browser\" and the user's default browser opens.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'The app name as the user said it, e.g. "browser", "chrome", "Codex", "Cursor", "Obsidian", "Blender", "Spotify".',
        },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "open_url",
    description:
      "Open a web address in the browser Zach is using — the one in front, or the one you just opened or focused — as a new tab. Pass `browser` only when he names one. Accepts a bare domain or a full URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: 'e.g. "github.com" or "https://news.ycombinator.com".' },
        browser: {
          type: "string",
          description:
            'Only when Zach names a browser: "chrome", "edge", "firefox", "brave", "default", or part of a browser window title. Omit it otherwise.',
        },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web and put a sourced text answer in Atlas at $0. Pass `browser` only when Zach explicitly asks to open browser results instead.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        browser: {
          type: "string",
          description: 'Only when Zach names a browser: "chrome", "edge", "firefox", "brave" or "default".',
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "focus_window",
    description:
      "Bring an already-open window to the front by any part of its title. Use before typing so the text lands in the right place.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Part of the window title, e.g. "Codex", "Chrome", "Notepad".' },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "list_windows",
    description:
      "List the titles of the currently open windows. Call this when you are unsure what is open or which window to target.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "click_element",
    description:
      "Press a button, link, menu item or tab BY ITS NAME — 'Continue', 'Sign in', 'Next', 'Allow'. THIS IS THE PREFERRED WAY TO CLICK: it asks Windows which control has that name and presses it directly, so there is no screenshot, no coordinates and nothing to misjudge. Use this first whenever the user names what to press. Only fall back to screenshot + click when a control has no name (a canvas, a game, an image map).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The visible label, e.g. \"Continue\"." },
        window: { type: "string", description: "Optional window title to search; omit for the window in front." },
        control_type: {
          type: "string",
          description: "Optional filter: Button, Hyperlink, MenuItem, CheckBox, TabItem, Edit.",
        },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "list_elements",
    description:
      "List the named controls on screen (buttons, links, menu items, tabs, text fields) with whether each is greyed out. Call this when click_element cannot find what the user asked for, or when you need to know what is pressable before deciding.",
    parameters: {
      type: "object",
      properties: {
        window: { type: "string", description: "Optional window title; omit for the window in front." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "screenshot",
    description:
      "Look at the screen. Returns an image of the active monitor so you can SEE what is there — read text, find a button, check whether something worked. Call this before clicking so you know where to click, and after an action when you need to confirm the result.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "click",
    description:
      "Click at coordinates read from the most recent screenshot image. Its top-left is 0,0; do not convert for monitor origin, DPI, or image scaling. Take a fresh screenshot immediately before clicking.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "X in the most recent screenshot image's pixels." },
        y: { type: "number", description: "Y in the most recent screenshot image's pixels." },
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean", description: "True for a double-click." },
      },
      required: ["x", "y"],
    },
  },
  {
    type: "function",
    name: "window_control",
    description:
      "Minimize, maximize, restore or close a window — ANY window, not just browsers. Omit `target` (or pass \"this\") to act on the window currently in front, which is what the user means by \"maximize this window\" or \"minimize it\". Acts on ONE window; never close everything at once.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["minimize", "maximize", "restore", "close"] },
        target: {
          type: "string",
          description:
            'Which window: part of its title or app name ("chrome", "Obsidian"). Omit or use "this" for the window in front.',
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "praxis_command",
    description:
      "Run one of Praxis's OWN commands: open its windows (Command Center, Flight Deck, Memory Galaxy, Cockpit), arrange or tile them, change view or trust level, refresh usage limits/supply/meters, refresh Flight Deck/sessions/agents, rebuild Memory Galaxy/memory graph/vault graph, set an agent's model from its runtime fleet choices, turn a tool breaker on/off (Claude, Codex, Cursor, OpenRouter, Hermes, computer-use), report status with usage and working agents, or tap a media/volume key. Use this only for Praxis's own surfaces and media keys — use open_app for ordinary Windows programs.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            'A short natural command, e.g. "refresh usage limits", "refresh agents", "rebuild the memory galaxy", "set Quill to Grok 4.7", "put Vega on GPT-6 Astra", "use Opus 5.5 for Forge", "turn off Cursor", "cut Codex", "status", "open command center", "tile the windows", "exit formation", "play", "volume up".',
        },
      },
      required: ["goal"],
    },
  },
  {
    type: "function",
    name: "type_text",
    description:
      "Type exact text into whatever has focus. For a named form field use fill_field instead. Optionally set target_window to bind and verify that window immediately before typing. Use target_field address_bar only with a named supported browser; it focuses the browser address bar with Ctrl+L and does not press Enter unless you set then. Otherwise target_field is focused. Set then to \"enter\" or \"tab\" to press it right after typing — for recipient fields, search boxes and address bars.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The exact text to type." },
        target_window: { type: "string", description: 'Optional window title or app name, e.g. "Google Chrome".' },
        target_field: {
          type: "string",
          enum: ["focused", "address_bar"],
          description: "Where to type: focused (default) or address_bar for a named browser.",
        },
        then: {
          type: "string",
          enum: ["enter", "tab"],
          description: "Optional key to press right after typing.",
        },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "fill_field",
    description:
      "Put text into a form field BY ITS LABEL — THE DEFAULT FOR ANY FORM: an email's To, Subject and Message Body; a Search box; Email, Name, Password or any field Zach dictates into. One call finds the field the way click_element finds a button, clicks into it, types the text, reads it back and optionally presses Enter or Tab. Never click a field and then type_text into it unless fill_field says it can't find the field.",
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: 'The field\'s visible label or placeholder, e.g. "To", "Subject", "Message Body", "Search", "Email".',
        },
        text: { type: "string", description: "The exact text to put in the field." },
        submit: {
          type: "string",
          enum: ["enter", "tab"],
          description:
            'Key to press after typing: "enter" to accept a recipient suggestion or run a search; "tab" to move on. Omit for Subject and message bodies.',
        },
      },
      required: ["label", "text"],
    },
  },
  {
    type: "function",
    name: "press_key",
    description:
      "Press a named key or supported modifier chord in the focused window, or bind target_window immediately before pressing. Supports enter, tab, escape, arrows, page up/down, home/end, F1-F24, letters/digits, and chords such as Ctrl+L, Ctrl+A, Ctrl+Shift+S, and Alt+Tab.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: 'The key name or chord, e.g. "enter", "ctrl+l", or "ctrl shift s".' },
        target_window: { type: "string", description: 'Optional window title or app name to bind before pressing.' },
      },
      required: ["key"],
    },
  },
  {
    type: "function",
    name: "scroll",
    description: "Scroll the focused window up or down.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number", description: "Optional number of scroll steps (default a few)." },
      },
      required: ["direction"],
    },
  },
  {
    type: "function",
    name: "clear_popups",
    description:
      "Clear whatever is standing between Zach and where he's going in the window in front: a cookie banner (declines non-essential first), a 'Not now' / 'No thanks' / 'Got it' prompt, the X on a modal, the Continue or Next of an interstitial. Up to three in a row, each verified; never pays, sends, deletes or signs in. Call it whenever something pops up in the way — do not ask Zach which button to press.",
    parameters: {
      type: "object",
      properties: {
        window: { type: "string", description: "Optional window title; omit for the window in front." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "recall_memory",
    description:
      "Search Praxis's Memory Galaxy — Zach's own notes about himself, his projects, decisions and preferences — and get back the most relevant ones. Use it whenever he refers to something personal or to past work you don't already have in your context (his address, a project's details, what he decided about something). You share this memory with Praxis; look it up instead of asking him.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for, in plain words." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mission_status",
    description:
      "Read what Praxis has said in Mission about the job it is running or just finished: the plan, which agents are working, reroutes, and the result with how to open it. Use it whenever Zach asks how a job is going, whether it's done, or where the result is. Read-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "capture_todo",
    description:
      "Save a task or reminder to the Command Center to-do list. Use when the user is noting something to remember rather than asking you to do it now.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The task text to remember." } },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "escalate",
    description:
      "Hand a heavy or multi-step job to Praxis, the orchestrator. Always write a complete ready-to-run brief for Mission before handing off. Use for two kinds of goal: (1) a build/research job (write/build/fix/refactor code, create a site or app, deep research, anything needing tools over several steps) — Praxis plans it, pulls real memory, delegates to Forge (Claude), Vega (Codex) and Quill (Cursor), checks the files and finishes it, including follow-ups like opening the result and maximizing it; (2) a real-world CREDENTIALED or IRREVERSIBLE action the user asks you to take on their behalf — log in, pay, buy, post, send a message — which at Trust IV opens the sovereign browser (asking the user before each irreversible step) and below Trust IV is refused with a note to raise the dial. Either way it runs asynchronously and Praxis announces the result; tell the user you've handed it off. Do NOT also call open_app, open_url or window tools for a job you escalate.",
    parameters: {
      type: "object",
      properties: {
        brief: {
          type: "string",
          description:
            "A real engineered prompt for Praxis and its agents (Zach reads it in Mission). Under ~170 words, in exactly this shape, bold labels, short bullets: **Goal:** one sentence. **Context:** who it is for and the facts about Zach that matter (from your context card or recall_memory - never invented). **Requirements:** 2-6 bullets, every constraint he said and nothing he didn't. **Deliverable:** what gets made and where (e.g. a static index.html with styles). **Done when:** how Praxis can check it (e.g. opens with no console errors, passes a headless check at phone and desktop widths). **Team:** the agents he named, if any - Praxis assigns them.",
        },
        goal: {
          type: "string",
          description:
            "The user's COMPLETE request in their own words — keep every constraint, every agent they named (Forge/Vega/Quill), and every follow-up step (e.g. 'then open it in a browser and maximize it'). Do not summarize or shorten it.",
        },
      },
      required: ["goal", "brief"],
    },
  },
];

/**
 * Tools whose meaning is Praxis-internal and therefore MUST keep going through
 * the router: its own window grammar, the sovereign gate, the to-do capture, and
 * the never-escalate guard all live there. Everything not in this set is a real
 * desktop action and dispatches straight to a primitive.
 */
const ROUTER_TOOLS = new Set(["halt", "praxis_command", "native_op", "capture_todo", "escalate"]);

/**
 * Map a tool call to the normalized utterance the router already understands. Kept
 * as a pure function so it is unit-testable headless (scripts/test-hybrid-router.cjs
 * can assert the mapping without a live model).
 *
 * Only meaningful for ROUTER_TOOLS now; the desktop tools bypass this entirely.
 * The `native_op` / `type_text` / `press_key` / `scroll` mappings are retained so
 * the existing headless router tests keep exercising the same grammar.
 */
export function toolCallToUtterance(name: string, args: Record<string, unknown>): string | null {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  switch (name) {
    case "halt":
      return "stop";
    case "praxis_command":
    case "native_op":
      return str(args.goal) || null;
    case "type_text": {
      const text = str(args.text);
      // The router's TYPE_MARKER_RE keys on "type this: …" and preserves casing.
      return text ? `type this: ${text}` : null;
    }
    case "press_key": {
      const key = str(args.key);
      return key ? `press ${key}` : null;
    }
    case "scroll": {
      const dir = str(args.direction) === "up" ? "up" : "down";
      const amt = typeof args.amount === "number" && args.amount > 0 ? ` ${Math.round(args.amount)}` : "";
      return `scroll ${dir}${amt}`;
    }
    case "capture_todo": {
      const text = str(args.text);
      // "remind me to …" hits the router's TODO_RE local pre-classify (no brain hop).
      return text ? `remind me to ${text}` : null;
    }
    case "escalate": {
      const goal = str(args.goal);
      if (!goal) return null;
      // A SENSITIVE goal (pay/post/log in/send/buy) must pass through VERBATIM so the
      // router's sovereign rung catches it - never "build:"-prefix it (that would turn
      // "pay the invoice" into a code-build goal and skip the Trust-IV veto path).
      if (sensitiveGoal(goal)) return goal;
      // Otherwise, prefixing "build" guarantees the router's GOAL_RE/ESCALATE path.
      return /\b(build|create|make|fix|write|research|refactor|implement)\b/i.test(goal) ? goal : `build: ${goal}`;
    }
    default:
      return null;
  }
}

/**
 * A transport that captures spoken confirmations instead of voicing them. Used to
 * run routeHybridUtterance for a tool call: the router's `.say(...)` text becomes
 * the tool RESULT the model narrates, so the outcome isn't spoken twice.
 */
class SilentCaptureTransport implements HybridTransport {
  readonly ownsInput = false;
  private lines: string[] = [];

  say(text: string): Promise<void> {
    const clean = text.trim();
    if (clean) this.lines.push(clean);
    return Promise.resolve();
  }
  isSpeaking(): boolean {
    return false;
  }
  stopSpeaking(): void {
    /* no-op */
  }
  onSpeakingChange(): () => void {
    return () => {};
  }

  /** The captured confirmations, joined - the tool result text for the model. */
  result(): string {
    return this.lines.join(" ");
  }
}

/** The outcome of dispatching one tool call, returned to the model over the channel. */
export interface ToolDispatchResult {
  /** Short natural-language result the model speaks (e.g. "Opened Chrome."). */
  output: string;
  /** The router's resolution class, for the session panel feed. */
  resolution: HybridFeedItem["resolution"];
  /** The full feed item, so the Realtime session can render it in the panel too. */
  item: HybridFeedItem;
  /**
   * A JPEG data URL the transport must add to the conversation as an `input_image`
   * BEFORE returning the tool output - this is how the Realtime model actually
   * sees the screen (a tool result string alone can only describe, never show).
   */
  image?: string;
}

/**
 * Dispatch a Realtime tool call through the existing router. `onHalt` is wired to
 * the transport's own barge-in/abort so a "stop" tool (should the model ever emit
 * one) behaves like a spoken halt. Never throws - a bad/unknown tool returns an
 * honest result string.
 */
let toolSeq = 0;

/** Build the feed item + result the session panel and the model both consume. */
function toolResult(
  transcript: string,
  resolution: HybridFeedItem["resolution"],
  detail: string,
  displayMarkdown?: string,
): ToolDispatchResult {
  const item: HybridFeedItem = {
    id: `hf-tool-${Date.now()}-${toolSeq++}`,
    transcript,
    resolution,
    detail,
    displayMarkdown,
    ts: Date.now(),
  };
  return { output: detail, resolution, item };
}

/**
 * Dispatch a DESKTOP tool straight to its primitive.
 *
 * `capability` picks which half of the shared operator policy applies: "native"
 * for launching/focusing/searching (no input synthesis), "direct-input" for
 * anything that synthesizes keystrokes or clicks into another app.
 *
 * Returns null for a tool this function does not own, so the caller can fall
 * through to the router path.
 */
async function dispatchDesktopTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolDispatchResult | null> {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  /** Describe the call for the trust gate + the session feed, in the user's terms. */
  let transcript: string;
  let capability: "native" | "direct-input";
  let gateText: string;
  let act: () => Promise<DesktopResult>;
  /** Text this call types, remembered so a suggestion it opens can be accepted later. */
  let typedText = "";

  switch (name) {
    case "open_app": {
      const app = str(args.name);
      if (!app) return toolResult("open_app()", "ignored", "I need an app name to open.");
      transcript = `open ${app}`;
      capability = "native";
      gateText = transcript;
      act = () => desktopOpenApp(app);
      break;
    }
    case "open_url": {
      const url = str(args.url);
      if (!url) return toolResult("open_url()", "ignored", "I need a web address to open.");
      const browser = str(args.browser) || undefined;
      transcript = browser ? `open ${url} in ${browser}` : `open ${url}`;
      capability = "native";
      gateText = `open ${url}`;
      act = () => desktopOpenUrl(url, browser);
      break;
    }
    case "web_search": {
      const query = str(args.query);
      if (!query) return toolResult("web_search()", "ignored", "I need something to search for.");
      const browser = str(args.browser) || undefined;
      transcript = `search the web for ${query}`;
      if (!browser) {
        if (signal?.aborted) return toolResult(transcript, "halt", "Stopped.");
        try {
          const answer = await searchWebAnswer(query, signal);
          const spoken = webSearchSpokenBrief(answer);
          return toolResult(transcript, "answer", spoken, answer.markdown);
        } catch (error) {
          if (signal?.aborted) return toolResult(transcript, "halt", "Stopped.");
          const detail = error instanceof Error ? error.message : String(error);
          return toolResult(transcript, "blocked", detail || "I couldn't search the web right now.");
        }
      }
      capability = "native";
      gateText = transcript;
      act = () => desktopWebSearch(query, browser);
      break;
    }
    case "focus_window": {
      const query = str(args.query);
      if (!query) return toolResult("focus_window()", "ignored", "I need a window name to focus.");
      transcript = `focus ${query}`;
      capability = "native";
      gateText = transcript;
      act = () => desktopFocusWindow(query);
      break;
    }
    case "screenshot": {
      // Reading the screen is gated as a desktop action (it can capture whatever
      // is on it), but it mutates nothing, so it goes no further than the dial.
      const gate = operatorActionBlockedReason("", "native", "live");
      if (gate) return toolResult("screenshot", "blocked", gate);
      if (await screenLocked()) return toolResult("screenshot", "blocked", SCREEN_LOCKED_MESSAGE);
      const shot = await desktopScreenshot();
      const result = toolResult("screenshot", shot.ok ? "action" : "blocked", shot.message);
      return shot.image ? { ...result, image: shot.image } : result;
    }
    case "window_control": {
      const action = str(args.action).toLowerCase();
      if (!["minimize", "maximize", "restore", "close"].includes(action)) {
        return toolResult("window_control()", "ignored", `I can't "${action}" a window.`);
      }
      const wanted = str(args.target);
      // An unnamed target means the window in front - not an error.
      const label = wanted && !/^(this|that|it|current|active)$/i.test(wanted) ? wanted : "this window";
      transcript = `${action} ${label}`;
      capability = "native";
      gateText = transcript;
      act = () =>
        desktopWindowControl(
          action as "minimize" | "maximize" | "restore" | "close",
          wanted || undefined,
        );
      break;
    }
    case "list_windows": {
      // Read-only: no actuation, so it is not gated as a desktop action. Refusing
      // to even LOOK at the window list would leave the model guessing targets.
      const result = await desktopListWindows();
      return toolResult("list windows", result.ok ? "action" : "blocked", result.message);
    }
    case "click_element": {
      const name = str(args.name);
      if (!name) return toolResult("click_element()", "ignored", "I need the name of the control to press.");
      transcript = `click ${name}`;
      capability = "direct-input";
      gateText = transcript;
      act = () => desktopClickElement(name, str(args.window) || undefined, str(args.control_type) || undefined);
      break;
    }
    case "clear_popups": {
      transcript = "clear pop-ups";
      capability = "direct-input";
      gateText = transcript;
      act = () => desktopClearPopups(str(args.window) || undefined);
      break;
    }
    case "recall_memory": {
      // Read-only: looking something up in the owner's own memory is never gated.
      const query = str(args.query);
      if (!query) return toolResult("recall_memory()", "ignored", "I need something to look up.");
      const result = await recallMemory(query);
      // The model gets every note; Atlas's thread shows one line, not a wall of excerpts.
      const shown = result.ok ? `Looked in the Memory Galaxy for "${query}".` : result.message;
      return { ...toolResult(`recall: ${query}`, result.ok ? "answer" : "blocked", shown), output: result.message };
    }
    case "mission_status": {
      // Read-only: Atlas relays what PRAXIS said in Mission; it never invents progress.
      const { loadMissionThread, groupMissions } = await import("@/orchestrator/missionThread");
      const latest = groupMissions(await loadMissionThread(200)).pop();
      if (!latest) {
        return { ...toolResult("mission status", "answer", "Mission is empty."), output: "Praxis has not run any mission yet." };
      }
      const lines = latest.msgs.slice(-8).map((m) => {
        const opens = m.artifacts?.length ? ` [${m.artifacts.map((a) => a.label).join(", ")} — buttons in Mission and the Inbox]` : "";
        return `${m.from} ${m.kind}: ${m.text.replace(/\s+/g, " ").slice(0, 240)}${opens}`;
      });
      return {
        ...toolResult(`mission status: ${latest.title}`, "answer", `Checked Mission: "${latest.title}" is ${latest.status}.`),
        output: `Latest mission "${latest.title}" is ${latest.status}.\n${lines.join("\n")}`,
      };
    }
    case "list_elements": {
      // Read-only, like list_windows: refusing to LOOK would leave the model guessing
      // names, which is the failure this whole path exists to remove.
      const result = await desktopListElements(str(args.window) || undefined);
      return toolResult("list elements", result.ok ? "action" : "blocked", result.message);
    }
    case "click": {
      const x = num(args.x);
      const y = num(args.y);
      if (x === null || y === null) {
        return toolResult("click()", "ignored", "I need screen coordinates to click.");
      }
      const button = str(args.button) || "left";
      const double = args.double === true;
      transcript = `${double ? "double-click" : "click"} at ${Math.round(x)}, ${Math.round(y)}`;
      capability = "direct-input";
      gateText = transcript;
      act = () =>
        desktopClick(x, y, {
          button: button === "right" ? "right" : button === "middle" ? "middle" : "left",
          double,
        });
      break;
    }
    case "type_text": {
      const text = str(args.text);
      if (!text) return toolResult("type_text()", "ignored", "There was nothing to type.");
      const targetWindow = str(args.target_window) || undefined;
      const requestedTargetField = str(args.target_field);
      if (requestedTargetField && requestedTargetField !== "focused" && requestedTargetField !== "address_bar") {
        return toolResult("type_text()", "ignored", "I need a focused field or a browser address bar.");
      }
      const targetField = requestedTargetField === "address_bar" ? "address_bar" : "focused";
      const rawThen = str(args.then).toLowerCase();
      if (rawThen && rawThen !== "enter" && rawThen !== "tab") {
        return toolResult("type_text()", "ignored", "After typing I can press enter or tab.");
      }
      const then = rawThen === "enter" || rawThen === "tab" ? rawThen : null;
      transcript = then ? `type: ${text} (then ${then})` : `type: ${text}`;
      capability = "direct-input";
      gateText = text;
      typedText = text;
      act = async () => {
        const typed = await hybridType(text, targetWindow, targetField);
        if (!typed.ok || !then) return typed;
        const pressed = await hybridPress(then, "live", targetWindow);
        const key = then === "enter" ? "Enter" : "Tab";
        return pressed.ok
          ? { ok: true, message: `${typed.message.replace(/\.$/, "")}, then pressed ${key}.` }
          : { ok: false, message: `${typed.message} But pressing ${key} failed: ${pressed.message}` };
      };
      break;
    }
    case "fill_field": {
      const label = str(args.label);
      if (!label) return toolResult("fill_field()", "ignored", "I need the label of the field to fill.");
      const text = typeof args.text === "string" ? args.text.replace(/\n+$/, "") : "";
      if (!text.trim()) return toolResult("fill_field()", "ignored", "There was nothing to type.");
      const rawSubmit = str(args.submit).toLowerCase();
      if (rawSubmit && rawSubmit !== "enter" && rawSubmit !== "tab") {
        return toolResult("fill_field()", "ignored", "After filling a field I can press enter or tab.");
      }
      const submit = rawSubmit === "enter" || rawSubmit === "tab" ? rawSubmit : undefined;
      transcript = `fill ${label}: ${text}`;
      capability = "direct-input";
      // Same gate as type_text: it reads the TEXT, so a password or card number is caught.
      gateText = text;
      typedText = text;
      act = () => desktopFillField(label, text, submit);
      break;
    }
    case "press_key": {
      const key = str(args.key);
      if (!key) return toolResult("press_key()", "ignored", "I need a key name to press.");
      const targetWindow = str(args.target_window) || undefined;
      transcript = `press ${key}`;
      capability = "direct-input";
      gateText = "";
      // Atlas only ever runs inside a turn the owner is speaking through and watching, so a tool call
      // here IS live. It used to hardcode `false`, which meant the Realtime lane could type a
      // query and then never submit it - "type this in the search bar and hit enter" could not
      // complete at ANY trust level.
      act = () => hybridPress(key, "live", targetWindow);
      break;
    }
    case "scroll": {
      const direction = str(args.direction) === "up" ? "up" : "down";
      const amount = num(args.amount);
      transcript = `scroll ${direction}`;
      capability = "direct-input";
      gateText = "";
      act = () => hybridScroll(direction, amount && amount > 0 ? Math.round(amount) : undefined);
      break;
    }
    default:
      return null;
  }

  if (signal?.aborted) return toolResult(transcript, "halt", "Stopped.");

  const blocked = operatorActionBlockedReason(gateText, capability, "live");
  if (blocked) return toolResult(transcript, "blocked", blocked);

  if (signal?.aborted) return toolResult(transcript, "halt", "Stopped.");

  if (NEEDS_SCREEN.has(name) && (await screenLocked())) {
    return toolResult(transcript, "blocked", SCREEN_LOCKED_MESSAGE);
  }

  let result = await act();
  if (signal?.aborted) return toolResult(transcript, "halt", "Stopped.");

  // Covered by the suggestion our own typing opened: accept it, then try ONCE more.
  const cover = RETRY_WHEN_COVERED.has(name) && !result.ok ? coveringSuggestion(result.message, lastTyped, Date.now()) : null;
  if (cover) {
    const accepted = await hybridPress("enter", "live");
    if (!accepted.ok) {
      result = { ok: false, message: `${result.message} (I couldn't accept the suggestion "${cover}": ${accepted.message})` };
    } else {
      lastTyped = null;
      await pause(350); // the page turns the suggestion into a chip and re-lays out
      if (signal?.aborted) return toolResult(transcript, "halt", "Stopped.");
      const retry = await act();
      if (signal?.aborted) return toolResult(transcript, "halt", "Stopped.");
      result = { ok: retry.ok, message: `Accepted the suggestion "${cover}", then ${lowerFirst(retry.message)}` };
    }
  }

  if (result.ok && typedText) lastTyped = { text: typedText, at: Date.now() };
  return toolResult(transcript, result.ok ? "action" : "blocked", result.message);
}

export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  onHalt: () => OperatorStopResult | Promise<OperatorStopResult>,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<ToolDispatchResult> {
  // Desktop actuation first - these never round-trip through the grammar.
  if (!ROUTER_TOOLS.has(name)) {
    const direct = await dispatchDesktopTool(name, args, signal);
    if (direct) return direct;
  }

  // An explicit escalate is a decision Atlas already made - hand it to Praxis
  // directly instead of re-classifying it (see routeEscalation). Sensitive goals
  // still take the full ladder so the Sovereign gate decides them.
  if (name === "escalate") {
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (goal && !sensitiveGoal(goal)) {
      const capture = new SilentCaptureTransport();
      let captured: HybridFeedItem | null = null;
      const item = await routeEscalation(goal, {
        transport: capture,
        signal,
        ownerToken,
        onHalt,
        emit: (i) => {
          captured = i;
        },
      }, typeof args.brief === "string" ? args.brief : goal);
      const final = captured ?? item;
      return { output: capture.result() || final.detail || "Handed to Praxis.", resolution: final.resolution, item: final };
    }
  }

  const utterance = toolCallToUtterance(name, args);
  if (!utterance) {
    const item: HybridFeedItem = {
      id: `hf-tool-${Date.now()}`,
      transcript: `${name}(${JSON.stringify(args)})`,
      resolution: "ignored",
      detail: `I couldn't act on ${name}.`,
      ts: Date.now(),
    };
    return { output: item.detail, resolution: "ignored", item };
  }

  const capture = new SilentCaptureTransport();
  let captured: HybridFeedItem | null = null;
  const item = await routeHybridUtterance(utterance, {
    transport: capture,
    signal,
    ownerToken,
    onHalt,
    emit: (i) => {
      captured = i;
    },
  });
  const final = captured ?? item;
  // Prefer the router's spoken text (captured) as the model's result; fall back to
  // the feed detail so the model always has something concrete to narrate.
  const output = capture.result() || final.detail || "Done.";

  // Safety net for the exact failure this file's header describes: a Praxis/legacy
  // command the grammar didn't recognise used to dead-end in the Codex prompt-paste
  // ("switch execution mode to Live"). If the router couldn't act, give the real
  // app launcher one honest attempt before reporting failure. `openApp` fails
  // cleanly when there is no such app, so this can't fire something unintended.
  if ((final.resolution === "blocked" || final.resolution === "ignored") && !signal?.aborted) {
    if (name === "native_op" || name === "praxis_command") {
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      if (goal && !operatorActionBlockedReason(goal, "native", "live")) {
        const retry = await desktopOpenApp(goal);
        if (retry.ok) return toolResult(goal, "action", retry.message);
      }
    }
  }

  return { output, resolution: final.resolution, item: final };
}
