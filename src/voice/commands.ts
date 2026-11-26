/**
 * Voice command router - Phase 2: voice that DOES things, not just echoes.
 *
 * Phase 1 sent every utterance straight to the canned planner. Now we FIRST try to
 * match the command to a real Praxis verb - switch views, fly to an area, drive the
 * journey transport, open a window, capture a thought, ask for status - and only
 * fall back to the planner for genuine questions. So "Praxis, open the journey" or
 * "Praxis, fly to Catalyzed" actually moves the app, the way Praxis should.
 *
 * PURE + testable (scripts/test-voice-commands.cjs): no React, no store, no DOM.
 *   parseCommand(raw, areas) → { intent, say } | null
 * `intent` is a structured verb; `say` is the precomputed spoken confirmation for
 * deterministic intents (status/ask compute their reply at execution from live
 * state, so their `say` is ""). useVoice executes the intent against the store.
 */

export interface AreaRef {
  id: string;
  label: string;
}

/** Where to send a window - mirrors the Rust-side `MonitorTarget` enum in src-tauri/src/lib.rs
 *  (`MonitorTarget::parse`). Keep the two in sync: `execute.ts` serializes this to the plain
 *  strings the Rust parser expects ("next" | "primary" | "left" | "right" | "index:<n>"). */
export type MonitorPlacement =
  | { kind: "next" }
  | { kind: "primary" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "index"; n: number };

export type FormationPlacement = MonitorPlacement | { kind: "largest" };

export type VoiceIntent =
  | { kind: "view"; view: "brain" | "journey" | "toggle" }
  | { kind: "overview" }
  | { kind: "area"; areaId: string; label: string }
  | { kind: "transport"; axis: "time" | "task" | "area"; dir: 1 | -1 }
  | { kind: "open"; target: "flightdeck" | "command" | "memory" | "dump" | "planner" }
  | { kind: "close"; target: "main" | "command" | "knowledge" | "flightdeck" }
  | { kind: "window-placement"; target: "main" | "command" | "knowledge" | "flightdeck"; placement: MonitorPlacement }
  | { kind: "gesture"; on: boolean }
  | { kind: "capture"; text: string }
  | { kind: "run-skill"; name: string }
  | { kind: "org-scan" }
  /** Tile all four Praxis windows into the screen quadrants (window_ops::tile_quadrants). */
  | { kind: "tile-quadrants"; placement?: FormationPlacement }
  /** Exit quad-tile: restore the pre-tiling layout (window_ops::restore_formation). */
  | { kind: "exit-formation" }
  /** Set the trust/autonomy detent (usePraxisStore.setAutonomy → autonomy.txt → Rust). */
  | { kind: "trust"; key: "observe" | "approve" | "operator" | "full"; label: string }
  /** Set the Command Center execution mode (controlStore.ts setExecMode). */
  | { kind: "exec-mode"; mode: "live" | "hybrid" | "background"; label: string }
  /** Global HALT breaker (haltStore.ts setHalted) - true = halt, false = resume. */
  | { kind: "halt"; on: boolean }
  /** Switch the selected brain model (command/brainStore.ts setSelectedBrain). */
  | { kind: "brain-model"; name: string }
  | { kind: "refresh-usage" }
  | { kind: "refresh-flightdeck" }
  | { kind: "refresh-memory" }
  | { kind: "fleet-model"; agent: string; model: string }
  | { kind: "tool-breaker"; key: "claude" | "codex" | "cursor" | "openrouter" | "hermes" | "computer-use"; enabled: boolean }
  /** Phase C: pull the latest board digest out across the screen + narrate it. */
  | { kind: "show-board" }
  | { kind: "research-scan" }
  /** Explicit zero-mutation refusal for unsafe/ambiguous window-control phrasing. */
  | { kind: "refuse" }
  | { kind: "sleep" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "ask"; text: string };

export interface VoiceCommand {
  intent: VoiceIntent;
  /** Precomputed spoken confirmation. "" when the reply is computed at execution
   *  time from live store state (status) or the planner (ask). */
  say: string;
}

export const HELP =
  "Try: open the journey, or the brain. Fly to an area like Catalyzed or Praxis. " +
  "Say next, or back in time. Open the Command Center, the Memory Galaxy, or Flight Deck. " +
  "Move a window — like, put the Command Center on my other monitor, or monitor 2. " +
  "Say remember, then your idea. Ask me to build something and I'll delegate it, " +
  "and once I finish it cleanly I'll remember how — say run my, then the name, to redo it. " +
  "Say run org scan and Atlas will sweep the Desktop and memory vault for a dry-run cleanup report. " +
  "Say run research scan and Sage will check Example Creator and the other watched sources right now. " +
  "Say switch to hybrid mode, or live mode, or background mode, to change how I execute. " +
  "Say halt everything to stop the whole fleet, and resume all to clear it. " +
  "Say switch to Sol, Terra, or Luna, to change the brain model. " +
  "Refresh usage, agents, or the memory galaxy. Set Quill to a model from its fleet menu, or turn off the Cursor breaker. " +
  "Or ask for something on your computer and I'll drive it. Ask me what's running, or just ask a question.";

const STOP = new Set(["the", "a", "an", "of", "to", "my", "me", "on"]);
const FILLER = new Set(["box", "that", "this", "it", "them", "stuff"]);

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "remember/note/jot/file/dump/save/add <X>" - captured on the RAW text so the
 *  filed thought keeps its original casing. */
const CAP_RE =
  /^\s*(?:please\s+)?(?:remember|note(?:\s+that|\s+down)?|jot(?:\s+down)?|file|capture|dump|save|add(?:\s+a)?(?:\s+note|\s+task|\s+reminder)?)\b\s*[:,-]?\s+(.+?)\s*$/i;

/**
 * "run my <name>" / "run the <name> skill|routine" / "do the <name> skill|routine"
 * - re-invoke a previously captured skill by name. Deliberately EXPLICIT (mirrors
 * the repeat-command gating discipline): a bare "run" or an incidental "running
 * late" must NEVER match, so the verb must be immediately anchored to a skill
 * HANDLE - either the possessive "run/do my …" or a trailing "skill"/"routine"
 * keyword. The captured group is the spoken skill name; resolution against the
 * saved skill list (fuzzy: spoken tokens ⊆ a saved skill's name/goal) happens at
 * EXECUTION time in execute.ts, which has the runtime to read skill_list().
 *
 *   run my deploy routine           → name "deploy routine"  (possessive form)
 *   run the deploy routine          → name "deploy"          (trailing keyword)
 *   do the nightly build skill      → name "nightly build"   (trailing keyword)
 *   run   (bare)                    → no match (falls through to journey/ask)
 *   running late                    → no match ("running" ≠ the "run/do" verb)
 */
const RUN_SKILL_RE =
  /^\s*(?:please\s+)?(?:run|do|execute|replay|perform)\s+(?:my\s+(.+?)(?:\s+(?:skill|routine|workflow|recipe|macro))?|(?:the\s+)?(.+?)\s+(?:skill|routine|workflow|recipe|macro))\s*$/i;

const WINDOW_MOVE_RE = /\b(move|put|place|send|shift|drag|snap|position|bring)\b/i;
/**
 * Window-DISMISS verbs - "close / hide / dismiss / get rid of / shut / minimize the <window>".
 * Distinct from WINDOW_MOVE_RE (relocation) and the open verbs. When one of these is spoken
 * alongside a Praxis window name we route to a real `close` intent (execute.ts hides the
 * window) instead of falling through to the brain - the whole point of deliverable A.
 * "get rid of" and "close out" are handled as phrases; the rest are single verbs.
 */
const WINDOW_CLOSE_RE =
  /\b(close|shut|hide|dismiss|minimi[sz]e|get rid of|banish|stow|tuck away|put away)\b/i;

const GLOBAL_WINDOW_DISMISS_RE =
  /\b(everything|all(?:\s+(?:the\s+)?)?(?:windows?|browsers?|apps?|applications?|tabs?)|every\s+(?:window|browser|app|application|tab))\b/i;
// "this window" / "this app" are established deictic aliases for the current
// Praxis shell. Bare "the/current/that window" has no trustworthy target.
const AMBIGUOUS_WINDOW_RE = /\b(?:the|current|that)\s+window\b|\b(?:the|that)\s+app(?:lication)?\b/i;
const WINDOW_CONTROL_TARGET_RE =
  /\b(window|browser|chrome|edge|firefox|safari|app|application|praxis|brain|command center|cockpit|flight deck|memory galaxy|notepad|obsidian|cursor|vscode|visual studio code)\b/i;
function hasWindowClause(text: string): boolean {
  // Remove politeness only when it is the terminal suffix, then ignore terminal
  // sentence punctuation. Any remaining connector or punctuation is a second
  // clause boundary and must refuse before other mutating grammar wins.
  const withoutCourtesy = text.replace(/,\s*(?:please|thanks|thank you|for me)[.!?]*\s*$/i, "").trim();
  const body = withoutCourtesy.replace(/[.!?]+\s*$/, "");
  return /\b(?:and|or|but|then|plus|also|before|after|while|whilst|because|if|when|unless|until)\b|[;.!?&,]/i.test(body);
}
/**
 * Browsers and apps the fast-path grammar has no special handling for.
 *
 * `native_ops` now resolves any named window against the live window list, so naming one is a
 * MISS for this grammar rather than an ambiguity - it falls through to the actuator that can
 * actually find it.
 */
const UNKNOWN_BROWSER_RE = /\b(safari|opera|brave|vivaldi|arc)\b/i;
const UNSUPPORTED_APP_TARGET_RE =
  /\b(notepad|obsidian|cursor|vscode|visual studio code|calculator|paint|spotify|discord|slack|terminal|file explorer|task manager)\b/i;
const PLURAL_WINDOW_TARGET_RE = /\b(windows|browsers|apps|applications|tabs)\b/i;
const BROWSER_TARGET_RE = /\b(browser|chrome|edge|firefox)\b/i;
const TARGETLESS_WINDOW_ACTION_RE =
  /^(?:close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|move|put|send|shift)(?:\s+(?:to|onto|on))?(?:\s+(?:monitor|display|screen)(?:\s+\d+)?)?$/i;

// Fail closed on imperative compounds even when the window/app target is unknown. The old guard
// depended on a known target or a close-like verb, which let phrases such as "open foobar and
// switch to live mode" reach the later mode parser and "set trust to sovereign and open foobar"
// reach the trust parser.
const IMPERATIVE_COMPOUND_START_RE =
  /^(?:open|launch|show|reopen|focus|switch|bring|pull|close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|move|put|place|send|shift|drag|snap|position|search|set|delete|remove|go|do|run)\b/i;
const IMPERATIVE_ACTION_RE =
  /\b(?:open|launch|show|reopen|focus|switch|bring|pull|close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|move|put|place|send|shift|drag|snap|position|search|set|delete|remove|go|do|run)\b/gi;
const WINDOWISH_ACTION_RE =
  /\b(?:open|launch|show|reopen|focus|switch|bring|pull|close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|move|put|place|send|shift|drag|snap|position|search)\b/i;

/**
 *
 * This used to be REFUSED as "ambiguous".
 *
 * It was also over-matching: the verb list counts `search`, so the NOUN in
 * "search bar" scored as a second action verb and tripped the refusal on a
 * command with only one real verb in it.
 *
 * These commands now return null from parseCommand, which hands them to the model
 * path - which has real tools (open_app, type_text, press_key, click, screenshot)
 * and can order them. The regex grammar stays what it is good at: single,
 * unambiguous, zero-latency commands.
 */
/** Every verb that names a real desktop action Praxis can take. Deliberately much
 *  which is why those commands fell through to a refusal instead of being run. */
const SEQUENCE_ACTION_RE =
  /\b(?:open|launch|start|show|reopen|focus|switch|bring|pull|close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|move|put|place|send|shift|drag|snap|position|search|look\s+up|find|go|navigate|visit|type|write|enter|input|paste|copy|cut|select|press|hit|click|tap|double[-\s]?click|right[-\s]?click|scroll|screenshot|capture|save|download|play|pause|run|execute|do|set|change|raise|lower|halt|resume|delete|remove|rename|create|make|tile|arrange)\b/gi;
/** A conjunction that joins two steps of one spoken instruction.
 *
 *  Wider than a grammarian would write it, deliberately: "close chrome AND switch
 *  to live mode", "... & ...", "... plus ...", "... while you ...", "... or ...",
 *  and a full stop followed by more words are all one breath with two orders in
 *  it. Every shape missing from this list was a shape where the FIRST clause won
 *  and the second silently vanished. */
const SEQUENCE_JOIN_RE =
  /\b(?:and(?:\s+then)?|then|after\s+that|next|plus|also|while|or|but)\b|,|;|&|\.\s+\S/i;

function isMultiStepImperative(text: string): boolean {
  if (!IMPERATIVE_COMPOUND_START_RE.test(text)) return false;
  if (!SEQUENCE_JOIN_RE.test(text)) return false;
  const verbs = text.match(SEQUENCE_ACTION_RE) ?? [];
  // Two DISTINCT actions. Counting repeats would make "close chrome and chrome"
  // look like a sequence, and "search bar" alone must never count as a step -
  // that noun scoring as a verb is what refused the owner's example command.
  const distinct = new Set(verbs.map((v) => v.toLowerCase().replace(/[-\s]+/g, " ")));
  return distinct.size >= 2;
}

/**
 * Verbs that operate the MACHINE, as opposed to configuring Praxis itself.
 *
 * Deliberately excludes "switch", because "switch to live mode" is how the exec
 * mode is named out loud.
 */
const DESKTOP_ACTION_VERB_RE =
  /\b(?:open|launch|start|close|shut|quit|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|focus|type|write|press|hit|click|scroll|copy|paste|save|download|search|google|navigate|visit|move|drag|snap)\b/i;

/**
 * True when an utterance asks ONLY to change a Praxis setting.
 *
 * The trust dial, the exec mode and the HALT breaker are settings, and a setting
 * must never move as a SIDE EFFECT of a sentence that was mostly about something
 * else. "Set trust to sovereign and close foobar" used to return a trust-change
 * intent - the dial moved to IV · SOVEREIGN and the close never happened, which
 * is the worst of both outcomes and the only genuine security defect in this
 * whole area.
 *
 * It slipped through the sequence detector because "set" was not counted as an
 * action verb, so the utterance scored one verb ("close") and did not look like
 * a sequence at all. Both halves are fixed: "set" now counts, AND the setting
 * parsers independently require that nothing else is being asked for - because a
 * connectorless compound ("set trust to sovereign close chrome") has no "and" for
 * the sequence detector to find.
 */
function isSoleConfigChange(text: string): boolean {
  return !DESKTOP_ACTION_VERB_RE.test(text);
}

/**
 * Everything in this grammar that MUTATES Praxis itself rather than operating the
 * machine: the trust dial, the execution mode, the brain model, the window
 * formation, the HALT breaker.
 */
const CONFIG_MUTATION_RE =
  /\b(?:trust|autonomy|sovereign|observe\s+mode|propose\s+mode|execute\s+mode|live\s+mode|hybrid\s+mode|background\s+mode|quad[\s-]?tile|tile|arrange|formation|as\s+the\s+brain|halt|unhalt)\b/i;

/**
 * A settings change mixed into a sentence that also asks for a desktop action.
 *
 * This is the whole class the "set trust to sovereign and close foobar" defect
 * belonged to, and it was five bugs, not one. Measured before the fix:
 *
 *   "close chrome. switch to live mode"        → changed the EXEC MODE, no close
 *   "close chrome & switch to live mode"       → changed the EXEC MODE, no close
 *   "close chrome plus switch to live mode"    → changed the EXEC MODE, no close
 *   "close chrome while you switch to live"    → changed the EXEC MODE, no close
 *   "close chrome and use codex as the brain"  → changed the BRAIN MODEL, no close
 *   "tile the windows and close chrome"        → tiled, never closed chrome
 *   "set trust to sovereign and close foobar"  → moved the DIAL, never closed
 *
 * In every case the half that ran was a persistent setting and the half that was
 * dropped was the desktop action - so the utterance quietly reconfigured Praxis
 * and did not do the thing the owner asked for. Returning null hands the whole
 * sentence to the model path, which has tools for both halves and can order them.
 */
function mixesConfigWithDesktopAction(text: string): boolean {
  const desktop = DESKTOP_ACTION_VERB_RE.exec(text);
  const config = CONFIG_MUTATION_RE.exec(text);
  if (!desktop || !config) return false;

  // A conjunction settles it outright.
  if (SEQUENCE_JOIN_RE.test(text)) return true;

  // Without one, the question is whether the config phrase IS the desktop verb's
  // target or a SECOND order after it. "Open | quad tile formation on a different
  // display" is one instruction - the verb introduces the config phrase directly.
  // "Close chrome | live mode" is two, because `chrome` already answered "close
  // what?" before the mode was ever mentioned.
  const between = text.slice(desktop.index + desktop[0].length, config.index).trim();
  return between.length > 0 && !/^(?:the|a|an|my|up|to|into|on)$/i.test(between);
}

const GLOBAL_DISMISS_REFUSAL =
  "I won't close or minimize everything at once — name one window or browser.";
const AMBIGUOUS_WINDOW_REFUSAL =
  "I couldn't tell which window you meant — name one supported browser or Praxis window.";

/** How many distinct windows this utterance names. Two means the one-window
 *  grammar cannot honour it, whatever the verb says. */
function countNamedTargets(text: string): number {
  const global = new RegExp(WINDOW_CONTROL_TARGET_RE.source, "gi");
  const hits = text.match(global) ?? [];
  return new Set(hits.map((h) => h.toLowerCase())).size;
}

function isGlobalWindowDismiss(text: string): boolean {
  return WINDOW_CLOSE_RE.test(text) && GLOBAL_WINDOW_DISMISS_RE.test(text);
}

/** True when this text should be handed to the model instead of the regex grammar
 * - a multi-step imperative the model can sequence with its real tools. */
function needsSequencing(text: string): boolean {
  if (text === "dismiss") return false; // established mic sleep alias
  const commandText = commandCore(text);
  if (/^hide\s+and\s+seek$/i.test(commandText)) return false;
  return isMultiStepImperative(commandText);
}

/** Normalize politeness/punctuation the same way needsSequencing does, so both
 *  gates judge the same string. */
/**
 * Everything people put in front of an instruction before the instruction starts.
 *
 * The bare imperative *"open up Chrome and type in Port Perryweather"* worked. The only
 * difference was five words of ordinary English at the front, and they were enough: the sequence
 * detector requires the FIRST word to be an imperative verb, so "okay" pushed the whole
 * utterance past it and into the ambiguous-window refusal.
 *
 * Applied REPEATEDLY, because they stack: "okay, so, can you just..." is one
 * utterance with four of them.
 */
const LEAD_IN_RE =
  /^(?:\s*(?:ok|okay|okey|alright|all right|right|so|now|then|well|hey|yo|hi|hello|praxis|atlas|yeah|yep|uh|um|er|actually|basically|just|please|could you|can you|would you|will you|i want you to|i need you to|i'd like you to|i would like you to|go ahead and|why don't you|lets|let's|we should|you should|maybe)\b[\s,.:;-]*)+/i;

function commandCore(text: string): string {
  let out = text;
  // Peel stacked lead-ins until the sentence starts with its actual verb.
  for (let i = 0; i < 6; i++) {
    const next = out.replace(LEAD_IN_RE, "");
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/(?:,\s*|\s+)(?:please|thanks|thank you|for me)[.!?]*$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
}

/** Genuinely UNSUPPORTED window control - an unknown browser, a plural/absent
 *  target, a multi-window clause. These stay refusals: there is no single action
 *  to take, and guessing would move the wrong window. Multi-step imperatives are
 *  NOT in this set any more - see needsSequencing. */
function shouldRefuseAmbiguousWindowControl(text: string): boolean {
  if (text === "dismiss") return false; // established mic sleep alias
  const commandText = commandCore(text);
  if (/^hide\s+and\s+seek$/i.test(commandText)) return false;

  // ONE control verb on ONE named target is not this grammar's to refuse.
  // native_ops resolves any window by name or title now, so refusing here just
  // stops a command Rust would have run: "hide my browser" (→ minimize) and
  // "place chrome on monitor 2" (→ move) were both refused by this function
  // while the actuator behind it knew exactly what to do with them.
  const singleControlOnNamedTarget =
    !hasWindowClause(commandText) &&
    !PLURAL_WINDOW_TARGET_RE.test(commandText) &&
    !isGlobalWindowDismiss(commandText) &&
    /^(?:close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|place|move|put|send|shift|get rid of)\s+/i.test(
      commandText,
    ) &&
    (BROWSER_TARGET_RE.test(commandText) ||
      UNKNOWN_BROWSER_RE.test(commandText) ||
      UNSUPPORTED_APP_TARGET_RE.test(commandText)) &&
    // ...and exactly ONE of them. "Close chrome command center" names two windows
    // with one verb, so acting would close whichever the grammar happened to
    // match and silently drop the other.
    countNamedTargets(commandText) === 1;
  if (singleControlOnNamedTarget) return false;

  const praxisTarget =
    "(?:command center|control center|cockpit|mission deck|memory galaxy|second brain|knowledge graph|memory map|the galaxy|agent dashboard|flight ?deck|mission control|the deck|praxis|brain|main window|main view|home window)";
  const browserTarget =
    "(?:(?:my|the)\\s+)?(?:(?:web\\s+)?browser|(?:google\\s+)?chrome|(?:microsoft\\s+)?edge|(?:mozilla\\s+)?firefox)(?:\\s+(?:window|app|application))?";
  const appTarget =
    "(?:chrome|google chrome|edge|microsoft edge|firefox|mozilla firefox|notepad|calculator|calc|file explorer|explorer|files|settings|windows settings|task manager|vs code|vscode|visual studio code|code|cursor|obsidian|spotify|discord|slack|terminal|windows terminal|paint|planner|assistant|chat)";
  const focusTarget = `(?:${browserTarget}|(?:the\\s+)?${praxisTarget}|(?:the\\s+)?${appTarget})`;
  const focusStarts =
    /^(?:focus(?:\s+on)?|bring\s+up|pull(?:\s+it)?\s+up)\b/i.test(commandText) ||
    new RegExp(`^switch\\s+to\\s+${focusTarget}\\b`, "i").test(commandText);
  const windowVerbMention =
    /\b(?:open|launch|show|reopen|focus|close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|move|put|place|send|shift|drag|snap|position|bring|pull|switch)\b|get rid of|tuck away|put away/i.test(commandText);
  // A NAMED window - even one this grammar has no special case for - is not an
  // ambiguity. Only a plural ("close the browsers") or a bare display reference
  // leaves genuinely nothing to resolve.
  const namedButUnhandled =
    UNKNOWN_BROWSER_RE.test(commandText) || UNSUPPORTED_APP_TARGET_RE.test(commandText);
  const targetMention =
    WINDOW_CONTROL_TARGET_RE.test(commandText) ||
    PLURAL_WINDOW_TARGET_RE.test(commandText) ||
    DISPLAY_RE.test(commandText);
  if (namedButUnhandled && !PLURAL_WINDOW_TARGET_RE.test(commandText)) return false;
  const targetlessAction = TARGETLESS_WINDOW_ACTION_RE.test(commandText);
  const closeLikeMention =
    /\b(?:close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|banish|stow)\b|get rid of|tuck away|put away/i.test(commandText);
  const startsControlAction =
    /^(?:close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e|get rid of|banish|stow|tuck away|put away)\b/i.test(commandText);
  // A multi-clause window command ("trust level four and close edge") is two instructions, and
  // the model path can run both.
  if (hasWindowClause(commandText) && closeLikeMention && (startsControlAction || targetMention)) {
    return false;
  }
  const looksLikeWindowControl =
    (targetMention && windowVerbMention) || focusStarts || targetlessAction || startsControlAction;

  if (!looksLikeWindowControl) return false;
  if (isGlobalWindowDismiss(commandText)) return true;
  if (hasWindowClause(commandText)) return true;
  // Formation language owns its display noun. Keep the established single-action
  // "open quad tile formation ..." route, after the multi-clause guard above.
  if (/^open\s+quad[\s-]?tile\s+formation\b/i.test(commandText)) return false;

  const monitorNoun = "(?:monitor|display|screen)";
  const wordOrdinal = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)";
  const monitorDestination =
    `(?:(?:my|the|a|an)\\s+)?(?:` +
    `(?:(?:other|next|different|main|primary|home|left|right|${wordOrdinal})\\s+${monitorNoun})|` +
    `(?:${monitorNoun}\\s+#?[1-9]\\d*)|(?:[1-9]\\d*(?:st|nd|rd|th)?\\s+${monitorNoun})|${monitorNoun})`;
  const browserMonitorDestination =
    `(?:${monitorDestination}|(?:(?:my|the|a|an)\\s+)?(?:largest|biggest)\\s+${monitorNoun})`;
  const praxisMonitorDestination = `(?:${monitorDestination}|(?:(?:my|the)\\s+)?monitor's\\s+display)`;
  const browserAction = new RegExp(
    `^(?:close|shut|minimi[sz]e|maximi[sz]e|restore|unmaximi[sz]e)\\s+(?:${browserTarget})$`,
    "i",
  );
  const browserMove = new RegExp(
    `^(?:move|put|send|shift)\\s+(?:${browserTarget})\\s+(?:to|onto|on)\\s+${browserMonitorDestination}$`,
    "i",
  );
  const praxisClose = new RegExp(
    `^(?:close|shut|hide|dismiss|minimi[sz]e|get rid of|banish|stow|tuck away|put away)\\s+(?:the\\s+)?(?:${praxisTarget})(?:\\s+window)?$`,
    "i",
  );
  const deicticClose = /^(?:close|shut|hide|dismiss|minimi[sz]e)\s+(?:it|this window|this app(?:lication)?)$/i;
  const praxisMove = new RegExp(
    `^(?:move|put|place|send|shift|drag|snap|position|bring)\\s+(?:the\\s+)?(?:${praxisTarget})(?:\\s+window)?(?:\\s+back)?\\s+(?:to|onto|on)\\s+${praxisMonitorDestination}$`,
    "i",
  );
  const deicticMove = new RegExp(
    `^(?:move|put|place|send|shift|drag|snap|position|bring)\\s+(?:it|this window)(?:\\s+back)?\\s+(?:to|onto|on)\\s+${praxisMonitorDestination}$`,
    "i",
  );
  const safeFocus = new RegExp(
    `^(?:focus(?:\\s+on)?|bring\\s+up|pull(?:\\s+it)?\\s+up|switch\\s+to)\\s+${focusTarget}$`,
    "i",
  );
  const safeOpen = new RegExp(
    `^(?:open(?:\\s+up)?|pop\\s+open|launch|show(?:\\s+me)?|display|reopen)\\s+${focusTarget}$`,
    "i",
  );

  if (browserAction.test(commandText) || browserMove.test(commandText)) return false;
  if (praxisClose.test(commandText) || deicticClose.test(commandText)) return false;
  if (praxisMove.test(commandText) || deicticMove.test(commandText)) return false;
  if (safeFocus.test(commandText) || safeOpen.test(commandText)) return false;

  // Positive grammar: every other action-starting shape is refused. This closes
  // unknown targets, swallowed STT conjunctions, extra targets, and ignored tails
  // without trying to enumerate every English connector.
  return true;
}
// A display reference needs a real monitor NOUN - bare or with a qualifier on it.
// Bare qualifiers ("main", "left", "next") deliberately do NOT count on their own:
// "bring up the main view" was being read as a window-move to the primary monitor
// (audit finding #13), and "move it next to X" isn't a display reference either.
const DISPLAY_RE =
  /\b(other|second|third|external|next|left|right|main|primary)\s+(monitor|display|screen)s?\b|\b(monitor|monitors|display|displays|screen|screens)\b/i;

// For quad formation, a bare "tile the screens" is the object of the command, not
// a monitor target. Require either a placement preposition, an explicit monitor
// number, or a big-screen/largest-TV phrase before sending a screen hint to Rust.
const FORMATION_DISPLAY_TARGET_RE =
  /\b(?:on|onto|to|at|in)\s+(?:my\s+|the\s+|a\s+|an\s+)?(?:other|different|second|third|fourth|fifth|external|next|left|right|main|primary|largest|biggest)\s+(?:monitor|display|screen)s?\b|\b(?:on|onto|to|at|in)\s+(?:my\s+|the\s+|a\s+|an\s+)?(?:tv|television|big screen)\b|\b(?:monitor|display|screen)\s*#?\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)?\s*(?:monitor|display|screen)\b|\b(?:largest|biggest)\s+(?:monitor|display|screen|tv|television)\b/i;

/** Word-form ordinals up to "tenth" - the owner's rig tops out at 3 monitors today, but this
 *  costs nothing extra and avoids a re-visit if he adds a 4th. */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/**
 * Parse a monitor-placement modifier OUT OF an utterance that has ALREADY passed the move-verb +
 * display-word gate (see the "window-placement" branch below).
 */
function parsePlacement(text: string): MonitorPlacement {
  // Only inspect the destination clause. Target aliases such as "main window"
  // and "home window" must not override "other monitor" or "right screen".
  const destination = text.match(/\b(?:to|onto|on)\s+(.+)$/)?.[1] ?? text;
  if (/\b(back|main|primary|home)\b/.test(destination)) return { kind: "primary" };

  const digit = destination.match(/\b(?:monitor|display|screen)\s*#?\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)?\s*(?:monitor|display|screen)\b/);
  if (digit) {
    const n = Number(digit[1] ?? digit[2]);
    if (n > 0) return { kind: "index", n };
  }
  for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(destination)) return { kind: "index", n };
  }

  // direction words must be scoped to the monitor/screen/display noun so "move it to the
  // left" (no display noun) doesn't get treated as a placement here - that phrase never
  // reaches parsePlacement anyway because DISPLAY_RE already gated the caller, but this
  // keeps the direction check itself honest if that gate ever loosens.
  if (/\bleft\b/.test(destination)) return { kind: "left" };
  if (/\bright\b/.test(destination)) return { kind: "right" };

  return { kind: "next" };
}

function parseFormationPlacement(text: string): FormationPlacement | undefined {
  if (!FORMATION_DISPLAY_TARGET_RE.test(text)) return undefined;
  if (/\b(largest|biggest|tv|television|big screen)\b/.test(text)) return { kind: "largest" };
  return parsePlacement(text);
}

function formationSay(placement?: FormationPlacement): string {
  if (!placement) return "Tiling the four windows into quadrants.";
  switch (placement.kind) {
    case "largest":
      return "Tiling the four windows on the largest display.";
    case "primary":
      return "Tiling the four windows on your main monitor.";
    case "left":
      return "Tiling the four windows on the left screen.";
    case "right":
      return "Tiling the four windows on the right screen.";
    case "index":
      return `Tiling the four windows on monitor ${placement.n}.`;
    case "next":
    default:
      return "Tiling the four windows on the other display.";
  }
}

function aliasesFor(a: AreaRef): string[] {
  const out = new Set<string>();
  const label = a.label.toLowerCase();
  out.add(label);
  for (const w of label.split(/\s+/)) if (w.length > 2 && !STOP.has(w)) out.add(w);
  out.add(a.id.toLowerCase());
  return [...out];
}

/** Longest-alias match of any area named in the text (null if none). */
function matchArea(text: string, areas: AreaRef[]): AreaRef | null {
  let best: { a: AreaRef; len: number } | null = null;
  for (const a of areas) {
    for (const al of aliasesFor(a)) {
      if (new RegExp(`\\b${esc(al)}\\b`, "i").test(text) && (!best || al.length > best.len))
        best = { a, len: al.length };
    }
  }
  return best?.a ?? null;
}

function matchWindowTarget(text: string): { target: "main" | "command" | "knowledge" | "flightdeck"; label: string } | null {
  if (/\b(command center|control center|cockpit|mission deck|the cockpit)\b/.test(text)) {
    return { target: "command", label: "Command Center" };
  }
  if (/\b(memory galaxy|second brain|knowledge graph|memory map|the galaxy|agent dashboard)\b/.test(text)) {
    return { target: "knowledge", label: "Memory Galaxy" };
  }
  if (/\b(flight ?deck|mission control|the deck|open sessions)\b/.test(text)) {
    return { target: "flightdeck", label: "Flight Deck" };
  }
  if (/\b(praxis|brain|main window|main view|home window)\b/.test(text)) {
    return { target: "main", label: "Praxis" };
  }
  return null;
}

/**
 * Map an utterance (already stripped of the wake word) to a Praxis verb.
 * Returns null only for empty input; otherwise always resolves - unmatched text
 * becomes an `ask` for the planner, preserving Phase-1 behavior for questions.
 */
export function parseCommand(raw: string, areas: AreaRef[] = []): VoiceCommand | null {
  // Strip conversational lead-ins ONCE, here, so every grammar below judges the same string.
  const text = commandCore(norm(raw));
  if (!text) return null;

  // 1) capture a thought - verb + real content (not a bare "dump box")
  const cap = raw.trim().match(CAP_RE);
  if (cap && cap[1] && cap[1].length > 1 && !FILLER.has(cap[1].toLowerCase())) {
    return { intent: { kind: "capture", text: cap[1].trim() }, say: "" };
  }

  // Universal zero-mutation preflight. It must run before every mutating grammar
  // (trust/mode/model/tiling/unattended included), otherwise a dangerous second clause could win
  // an earlier parser branch. "Close everything" said out loud, while looking at a screen full
  // of windows, is an ordinary instruction. The regex grammar controls ONE window, so it hands
  // this to the model path (which can enumerate windows and close them) instead of refusing.
  if (isGlobalWindowDismiss(text)) return null;
  // A multi-step imperative ("open Chrome and type X") is a SEQUENCE, not an
  // ambiguity. Returning null hands it to the model path, which has the real
  // desktop tools and can order them - instead of refusing to act at all.
  if (needsSequencing(text)) return null;
  // A Praxis setting must never move as a side effect of a sentence that was
  // mostly about something else. See mixesConfigWithDesktopAction.
  if (mixesConfigWithDesktopAction(text)) return null;
  // Own-app operations precede window placement and brain-model switching: "put
  // Vega on GPT-6 Astra" assigns an agent; it does not move a window.
  if (/^(?:reload|refresh) (?:the )?(?:usage(?: limits)?|supply|meters)$/.test(text) || /^check (?:my|the) limits$/.test(text))
    return { intent: { kind: "refresh-usage" }, say: "" };
  if (/^(?:reload|refresh) (?:the )?(?:flight\s*deck|sessions|agents)$/.test(text))
    return { intent: { kind: "refresh-flightdeck" }, say: "" };
  if (/^(?:refresh|rebuild|reload) (?:the )?(?:memory galaxy|memory graph|vault graph)$/.test(text))
    return { intent: { kind: "refresh-memory" }, say: "" };

  const fleet = text.match(/^(?:set|switch|put) (?:the )?([a-z]+)(?:'s model| model)? (?:to|on) (.+)$/);
  const forAgent = text.match(/^use (.+) for (?:the )?([a-z]+)(?: agent)?$/);
  if ((fleet || forAgent) && !hasWindowClause(text.replace(/(\d)\.(?=\d)/g, "$1")) && isSoleConfigChange(text)) {
    // Resolve against the live catalog in execute.ts, including unknown names.
    // Preserve "switch to <brain>" and "set trust to ..." in their own grammar.
    const agent = fleet?.[1] ?? forAgent![2];
    // Only agent-shaped targets take this route. "Put Chrome on monitor 2" and
    // "use memory for research" still belong to the desktop/conversation path.
    const agentName = agent.length >= 3 && ["forge", "vega", "quill", "sage", "lens", "atlas", "scribe"].some((name) => name.includes(agent));
    if (!/^(?:trust|autonomy|mode|brain|model)$/.test(agent) && (agentName || /(?:'s model| model) (?:to|on) /.test(text)))
      return { intent: { kind: "fleet-model", agent, model: fleet?.[2] ?? forAgent![1] }, say: "" };
  }
  const breaker = text.match(/^(?:(?:turn|switch) (on|off)|cut) (?:the )?(claude|codex|cursor|open\s?router|hermes|computer[ -]use|forge|vega|quill)(?:'?s)?(?: breaker)?$/);
  if (breaker) {
    const named = breaker[2].replace("open router", "openrouter").replace("computer use", "computer-use");
    const byAgent: Record<string, string> = { forge: "claude", vega: "codex", quill: "cursor" };
    const key = (byAgent[named] ?? named) as Extract<VoiceIntent, { kind: "tool-breaker" }>["key"];
    return { intent: { kind: "tool-breaker", key, enabled: breaker[1] === "on" }, say: "" };
  }
  // Window-shaped but not resolvable by THIS grammar. Two very different cases:
  //
  //   "close" - names no window at all. There is nothing to
  //                              resolve and nothing downstream can do better, so
  //                              asking which one is the honest answer.
  //   "close chrome and ..." - names a window perfectly well; this grammar just
  //                              cannot do it in one step. Refusing there tells
  //                              The owner the app can't understand him, when the model
  //                              path has open_app / type_text / click / screenshot
  //                              and can. Decline, don't refuse.
  //
  // Only the first is a refusal now. Everything else falls through to the model.
  if (shouldRefuseAmbiguousWindowControl(text)) {
    return TARGETLESS_WINDOW_ACTION_RE.test(text)
      ? { intent: { kind: "refuse" }, say: AMBIGUOUS_WINDOW_REFUSAL }
      : null;
  }

  // 1.4) run the organization scan - Atlas's dry-run Desktop/vault cleanup sweep
  // (org_scan.rs). Matched BEFORE RUN_SKILL_RE so "run org scan" / "run the organization
  // scan" never gets misread as a saved-skill name lookup.
  if (/\brun\b[^.]*\borgan(?:i[sz]ation)?\s*(?:scan|clean\s*up|cleanup)\b/.test(text))
    return { intent: { kind: "org-scan" }, say: "" };

  // 1.42) the demonstration surface (Phase C): "give me the board (meeting) summary",
  // "show me the board meeting/report", "what did the board say" - Praxis pulls the
  // digest out across the screen AND talks through it (execute.ts speaks the top lines).
  if (
    /\b(board)\b[^.]*\b(summary|meeting|report|digest)\b/.test(text) ||
    /\b(summary|report)\b[^.]*\bboard\b/.test(text)
  )
    return { intent: { kind: "show-board" }, say: "" };

  // 1.45) run the research-watch scan on demand - Sage's RSS/transcript sweep
  // (research_watch.rs), otherwise only fires on its own daily timer. Matched
  // BEFORE RUN_SKILL_RE for the same reason as org-scan above.
  if (/\brun\b[^.]*\bresearch\s*(?:scan|watch|check)\b/.test(text))
    return { intent: { kind: "research-scan" }, say: "" };

  // 1.5) run a captured skill - "run my <name>", "do the <name> skill/routine".
  // EXPLICIT verb+handle only (see RUN_SKILL_RE): bare "run" and "running late"
  // fall through untouched. The name is resolved against the saved skill list at
  // execution time; `say` is "" because the confirmation depends on whether the
  // name actually resolves (execute.ts speaks the honest result).
  const runSkill = text.match(RUN_SKILL_RE);
  if (runSkill) {
    const name = (runSkill[1] ?? runSkill[2] ?? "").trim();
    if (name.length > 1) return { intent: { kind: "run-skill", name }, say: "" };
  }

  // 1.55) EXIT quad-tile formation - restore the layout from before tiling. Checked
  //        BEFORE the tile rule so "exit/leave the tile formation" restores instead of
  //        re-tiling. Matches "exit/leave/undo/break/restore/untile … formation/tile/layout".
  if (
    /\buntile\b/.test(text) ||
    (/\b(exit|leave|undo|break|end|restore|reset|unfold|cancel|stop)\b/.test(text) &&
      /\b(formation|quad[\s-]?tile|tiling|tiled|tile\s*mode|layout|arrangement|grid)\b/.test(text))
  )
    return { intent: { kind: "exit-formation" }, say: "Exiting the formation." };

  // 1.6) QUAD-TILE the four Praxis windows into the screen quadrants (this was the exact
  //       "enter quad tile formation → described, not done" bug: the Rust command exists,
  //       there was just no voice/chat route). Gated to real window-tiling phrasing so a
  //       stray "tile" never fires it.
  if (
    /\bquad[\s-]?tile\b/.test(text) ||
    /\btile\b[^.]*\b(windows?|quadrants?|screens?|four|formation|layout|grid)\b/.test(text) ||
    /\b(quadrant|four[\s-]?up)\b[^.]*\b(formation|arrangement|layout|windows?)\b/.test(text) ||
    /\barrange\b[^.]*\bwindows?\b/.test(text)
  ) {
    const placement = parseFormationPlacement(text);
    return { intent: { kind: "tile-quadrants", placement }, say: formationSay(placement) };
  }

  // 1.7) SET THE TRUST / AUTONOMY level - "go sovereign", "set trust to execute", "trust
  //       level four", "observe mode". Gated on a trust/autonomy/sovereign keyword so a bare
  //       number never changes the dial. Maps the spoken level onto the 4 canonical detents.
  // "observe mode" / "propose mode" / "execute mode" name a detent directly. The
  // comment above has always listed "observe mode" as a supported phrasing; the
  // guard only accepted trust/autonomy/sovereign, so it never once worked.
  if (
    (/\b(trust|autonomy|sovereign)\b/.test(text) ||
      /\b(observe|propose|execute)\s+mode\b/.test(text)) &&
    isSoleConfigChange(text)
  ) {
    let key: "observe" | "approve" | "operator" | "full" | null = null;
    let label = "";
    if (/\b(sovereign|full autonomy|level\s*(?:four|4)|trust\s*(?:level\s*)?(?:four|4)|four|4)\b/.test(text)) { key = "full"; label = "IV · SOVEREIGN"; }
    else if (/\b(execute|operator|level\s*(?:three|3)|trust\s*(?:level\s*)?(?:three|3)|three|3)\b/.test(text)) { key = "operator"; label = "III · EXECUTE"; }
    else if (/\b(propose|suggest|level\s*(?:two|2)|trust\s*(?:level\s*)?(?:two|2)|two|2)\b/.test(text)) { key = "approve"; label = "II · PROPOSE"; }
    else if (/\b(observe|read.?only|level\s*(?:one|1)|trust\s*(?:level\s*)?(?:one|1)|one|1)\b/.test(text)) { key = "observe"; label = "I · OBSERVE"; }
    if (key) return { intent: { kind: "trust", key, label }, say: `Trust set to ${label}.` };
  }

  // 1.75) HALT / RESUME the whole fleet - "halt all", "halt everything", "emergency stop",
  //       "stop everything" → halt; "resume all" / "resume everything" / "unhalt" → resume.
  //       Gated tightly (halt/stop/emergency + all/everything, or an explicit resume phrase)
  //       so an ordinary "stop" (sleep/gesture-off) never trips the fleet breaker.
  if (
    /\bemergency\s*stop\b/.test(text) ||
    /\b(halt)\b[^.]*\b(all|everything|the fleet)\b/.test(text) ||
    /\b(stop)\b[^.]*\b(everything|all agents|the fleet)\b/.test(text)
  )
    return { intent: { kind: "halt", on: true }, say: "Halting everything." };
  if (/\b(resume|unhalt|un-halt)\b[^.]*\b(all|everything|the fleet)\b/.test(text) || /\bresume\s+all\b/.test(text))
    return { intent: { kind: "halt", on: false }, say: "Resuming — the breaker is clear." };

  // 1.76) EXEC-MODE - "live mode", "hybrid mode", "background mode", "switch to hybrid",
  //       "go live", "go background". Gated on the mode word ITSELF plus a mode/execution
  //       keyword so "hybrid" alone still requires "mode" (avoids stray false positives),
  //       while "switch to live/hybrid/background" and "go live" are explicit enough alone.
  if (
    /\b(live|hybrid|background)\s+mode\b/.test(text) ||
    /\b(switch|change|set)\b[^.]*\b(to\s+)?(live|hybrid|background)\b[^.]*\bmode\b/.test(text) ||
    /\bswitch\s+to\s+(live|hybrid|background)\b/.test(text) ||
    /\bgo\s+(live|hybrid|background)\b/.test(text)
  ) {
    let mode: "live" | "hybrid" | "background" | null = null;
    if (/\bhybrid\b/.test(text)) mode = "hybrid";
    else if (/\bbackground\b/.test(text)) mode = "background";
    else if (/\blive\b/.test(text)) mode = "live";
    if (mode) {
      const label = mode === "live" ? "Live" : mode === "hybrid" ? "Hybrid" : "Background";
      return { intent: { kind: "exec-mode", mode, label }, say: `Switching to ${label} mode.` };
    }
  }

  // 1.77) MODEL-SWITCH - "switch to Opus/Sonnet/Fable/Codex/GLM/Kimi/Llama" changes the
  //       selected BRAIN model. Gated on an explicit switch/change/use verb so a bare model
  //       name spoken in passing (e.g. asking a question ABOUT Opus) doesn't fire this.
  {
    const brainNamePattern =
      "(gpt[\\s.-]?5(?:[\\s.-]?6)?(?:\\s+(?:sol|terra|luna))?|" +
      "openai(?:\\s+api)?(?:\\s+(?:sol|terra|luna))?|" +
      "sol|terra|luna|chatgpt|codex(?:\\s+subscription)?|" +
      "claude(?:\\s+(?:cli|pro|opus))*|opus|" +
      "nvidia(?:\\s+nim)?|nim|llama(?:\\s+3[.\\s-]?3\\s+70b)?|" +
      "openrouter(?:\\s+(?:glm(?:\\s+5[.\\s-]?2)?|kimi(?:\\s+k2[.\\s-]?6)?))?|" +
      "glm(?:\\s+5[.\\s-]?2)?|kimi(?:\\s+k2[.\\s-]?6)?)";
    const modelSwitch = text.match(
      new RegExp(`\\b(?:switch|change|set)\\b[^.]*\\bto\\s+(?:the\\s+)?${brainNamePattern}\\s*(?:model|brain)?\\b`),
    );
    const useModel = text.match(
      new RegExp(`\\buse\\s+${brainNamePattern}\\s+(?:as\\s+)?(?:the\\s+)?(?:model|brain)\\b`),
    );
    const name = (modelSwitch?.[1] ?? useModel?.[1] ?? "").trim();
    if (name) return { intent: { kind: "brain-model", name }, say: "" };
  }

  // 2) help / vocabulary
  if (/\b(help|what can (i|you)|your commands|list commands|what do you do)\b/.test(text))
    return { intent: { kind: "help" }, say: HELP };

  // 3) status - "what are you working on / what's running / who's working"
  if (
    /\b(status|anything running|who('s| is) working)\b/.test(text) ||
    /\bwhat(?:'s| is| are you)?\s+(working|doing|happening|going on|running)\b/.test(text)
  )
    return { intent: { kind: "status" }, say: "" };

  // 4) sleep / stop listening. "dismiss" is intentionally the ONLY sleep trigger that also
  //    reads as a window verb ("dismiss the command center"), so it yields to a named window:
  //    if a Praxis window is spoken, this bare-"dismiss" sleep match steps aside and the
  //    close block (6.5) handles it. Every other sleep phrase ("go to sleep", "stand down",
  //    "never mind" …) carries no window name and is unaffected.
  if (
    /\b(stop listening|go to sleep|stand down|that'?s all|never ?mind|be quiet)\b/.test(text) ||
    (/\bdismiss\b/.test(text) && !matchWindowTarget(text) && !isGlobalWindowDismiss(text))
  )
    return {
      intent: { kind: "sleep" },
      say: "Going quiet. Say Praxis, or tap the mic, to wake me.",
    };

  // 5) gesture mode (off before on, so "stop gesture" doesn't read as "gesture")
  if (/\b(stop|exit|end|turn off|disable)\b[^.]*\bgesture/.test(text) || /\bexit hand\b/.test(text))
    return { intent: { kind: "gesture", on: false }, say: "Gesture control off." };
  if (
    /\bgestures?\b/.test(text) ||
    /\bhand (control|tracking|nav|mode)\b/.test(text) ||
    /\bcontrol with (my )?hands?\b/.test(text)
  )
    return {
      intent: { kind: "gesture", on: true },
      say: "Gesture control on. Make a fist to grab.",
    };

  const deicticMainMove =
    /^(?:move|put|place|send|shift|drag|snap|position|bring)\s+(?:it|this window|the window)\b/.test(text);
  const windowTarget = matchWindowTarget(text) ?? (WINDOW_MOVE_RE.test(text) && DISPLAY_RE.test(text) && deicticMainMove
    ? { target: "main" as const, label: "Praxis" }
    : null);
  if (windowTarget && WINDOW_MOVE_RE.test(text) && DISPLAY_RE.test(text)) {
    const placement = parsePlacement(text);
    const say =
      placement.kind === "primary"
        ? `Bringing ${windowTarget.label} back to your main monitor.`
        : placement.kind === "index"
          ? `Moving ${windowTarget.label} to monitor ${placement.n}.`
          : placement.kind === "left"
            ? `Moving ${windowTarget.label} to the left screen.`
            : placement.kind === "right"
              ? `Moving ${windowTarget.label} to the right screen.`
              : `Moving ${windowTarget.label} to the other display.`;
    return {
      intent: { kind: "window-placement", target: windowTarget.target, placement },
      say,
    };
  }

  // 6.5) CLOSE / HIDE / DISMISS a Praxis window - "close the command center", "hide the
  //      memory galaxy", "get rid of the flight deck", "close it". Checked BEFORE the open
  //      block so a dismiss verb never re-opens the window, and it wins over the ask
  //      fallback (the whole reason "close the command center" used to produce garbage:
  //      it had no matching verb and fell through to brain_chat). When no window is named
  //      ("close it" / "close this window"), default to the brain (main) - same convention
  //      as the move block. Media/journey words are untouched: they carry no window name and
  //      no close verb, so this gate never fires on them.
  if (WINDOW_CLOSE_RE.test(text) && !isGlobalWindowDismiss(text)) {
    const deicticMainClose =
      /^(?:close|shut|hide|dismiss|minimi[sz]e)\s+(?:it|this window|this app(?:lication)?)$/.test(text);
    const closeTarget =
      matchWindowTarget(text) ??
      (deicticMainClose
        ? { target: "main" as const, label: "Praxis" }
        : null);
    if (closeTarget) {
      // matchWindowTarget uses "knowledge" for the galaxy but the OPEN path uses "memory";
      // the CLOSE intent addresses windows by their Rust label, so "knowledge" is correct here.
      return {
        intent: { kind: "close", target: closeTarget.target },
        say:
          closeTarget.target === "main"
            ? "Tucking Praxis away."
            : `Closing the ${closeTarget.label}.`,
      };
    }
  }

  const wantsOpen = /\b(open|show|launch|bring up|pull up|pull it up|pop open|go to|jump to|take me to|display|reopen|switch to|head to)\b/.test(text);
  const wantsModify = /\b(move|close|shut|hide|dismiss|minimi[sz]e|maximi[sz]e|resi[sz]e|shrink|enlarge|expand|drag|put|send|shift|relocate|throw|snap|push)\b/.test(text);
  if (!wantsModify) {
    if (/\b(command cent(?:er|re)|control center|cockpit|mission deck)\b/.test(text) &&
        (wantsOpen || /^(?:the )?(?:command cent(?:er|re)|control center|cockpit)$/.test(text)))
      return { intent: { kind: "open", target: "command" }, say: "Opening the Command Center." };
    if (/\b(memory galaxy|second brain|knowledge graph|memory map|the galaxy|agent dashboard)\b/.test(text) &&
        (wantsOpen || /^(?:the )?(?:memory galaxy|second brain|agent dashboard|galaxy)$/.test(text)))
      return { intent: { kind: "open", target: "memory" }, say: "Opening the Memory Galaxy." };
    if (/\b(flight ?deck|mission control|the deck|open sessions)\b/.test(text) &&
        (wantsOpen || /^(?:the )?(?:flight ?deck|mission control|deck)$/.test(text)))
      return { intent: { kind: "open", target: "flightdeck" }, say: "Opening Flight Deck." };
    if (/\bopen (?:the )?(?:planner|assistant|chat)\b/.test(text) || (wantsOpen && /\b(planner|assistant)\b/.test(text)))
      return { intent: { kind: "open", target: "planner" }, say: "Opening the planner." };
    if (/\b(dump box|brain ?dump|new (?:idea|thought)|open (?:the )?dump)\b/.test(text))
      return { intent: { kind: "open", target: "dump" }, say: "Dump box is open — go ahead." };
  }

  // 7.5) media transport is NOT journey transport - "next track"/"pause the music"/
  //      "volume up" fall through as `ask` so the voice router's desktop rung
  //      (native media keys) handles them; the journey hop must never eat them.
  if (
    /\b(next|previous|skip)\s+(track|song|tune)\b/.test(text) ||
    /\b(play|pause|resume|stop)\b[^.]*\b(music|song|track|audio|playback)\b/.test(text) ||
    /\bvolume\s+(up|down)\b|\bturn\s+(up|down)\s+the\s+volume\b|\b(mute|unmute)\b/.test(text)
  )
    return { intent: { kind: "ask", text: raw.trim() }, say: "" };

  // 8) journey transport (time before generic "back"; lane before bare task)
  if (/\b(forward in time|later|into the future|fast ?forward|go forward)\b/.test(text))
    return { intent: { kind: "transport", axis: "time", dir: 1 }, say: "Moving forward in time." };
  if (/\b(back in time|earlier|into the past|rewind|further back)\b/.test(text))
    return { intent: { kind: "transport", axis: "time", dir: -1 }, say: "Going back in time." };
  if (/\b(next (area|lane|initiative)|down a (lane|row)|lane down)\b/.test(text))
    return { intent: { kind: "transport", axis: "area", dir: 1 }, say: "Next lane." };
  if (/\b(previous (area|lane|initiative)|up a (lane|row)|lane up)\b/.test(text))
    return { intent: { kind: "transport", axis: "area", dir: -1 }, say: "Previous lane." };
  if (/^(next|continue|keep going|step forward)\b/.test(text) || /\bnext (task|milestone|step|one)\b/.test(text))
    return { intent: { kind: "transport", axis: "task", dir: 1 }, say: "Next." };
  if (/^(previous|step back)\b/.test(text) || /\b(previous|last) (task|milestone|step|one)\b/.test(text) || /\bback a step\b/.test(text))
    return { intent: { kind: "transport", axis: "task", dir: -1 }, say: "Previous." };

  // 9) views
  if (/\b(journey|timeline|time ?line|the story|roadmap|history|time view)\b/.test(text))
    return { intent: { kind: "view", view: "journey" }, say: "Opening the journey." };
  if (/\b(brain|neural|main view|now view|the now)\b/.test(text))
    return { intent: { kind: "view", view: "brain" }, say: "Back to the brain." };
  if (/\b(switch|toggle|flip)\b[^.]*\bview\b|\bother view\b/.test(text))
    return { intent: { kind: "view", view: "toggle" }, say: "Switching the view." };

  // 10) overview / escape
  const overviewText = text
    .replace(/^(?:please\s*,?\s*)/i, "")
    .replace(/(?:,\s*|\s+)(?:please|thanks|thank you|for me)$/i, "")
    .trim();
  if (
    /^(?:overview|zoom out|back out|reset(?: the)? view|reset|deselect|clear|escape|go home|go back(?: to (?:the )?overview)?|home)$/.test(
      overviewText,
    )
  )
    return { intent: { kind: "overview" }, say: "Back to the overview." };

  // 11) fly to an area - needs a lead verb OR the area name spoken on its own
  const ledVerb = /\b(go to|show( me)?|open|fly to|take me to|jump to|focus( on)?|navigate to)\b/.test(text);
  const area = matchArea(text, areas);
  if (area && (ledVerb || text === area.label.toLowerCase() || text === area.id.toLowerCase()))
    return { intent: { kind: "area", areaId: area.id, label: area.label }, say: `Flying to ${area.label}.` };

  // fallback - a genuine question → the planner (Phase-1 behavior preserved)
  return { intent: { kind: "ask", text: raw.trim() }, say: "" };
}
