/**
 * missionText - what Praxis says when a mission ends, in words the owner can read at a glance.
 *
 * The first live run of the Mission thread (2026-10-01) closed with a wall of raw tool
 * errors: the same "Codex is out of its 5h usage … Claude is out of usage …" sentence three
 * times, prefixed with "agent_delegate(claude):" and "unroutable:", cut off mid-word. The
 * second ended "the agents could not complete the work" although every step had succeeded and
 * only the final check was unconvinced. A failure has to say, briefly and truly: what stopped
 * it, and what's left.
 */

import { classifyToolFailure, type DriverTool } from "./drivers";

const MAX_REASONS = 3;
const MAX_LEFT = 3;

function firstLine(s: string): string {
  return (s || "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
}

/** Strip plumbing prefixes ("agent_delegate(claude):", "Forge: unroutable:") from an error. */
function plain(s: string): string {
  return s
    .replace(/\b(?:agent_delegate|delegate)\([a-z]+\):\s*/gi, "")
    .replace(/^\s*(?:Forge|Vega|Quill|Lens)\s*:\s*/i, "")
    .replace(/^\s*unroutable:\s*/i, "")
    .trim();
}

/** Pure: the closing failure message for a run that ended not-done. */
export function failureMessage(input: {
  summary: string;
  steps: { tool: DriverTool; ok: boolean; output: string; why?: string; prompt: string; toolError?: boolean }[];
}): string {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const s of input.steps) {
    if (s.ok) continue;
    const cap = s.toolError === false ? null : classifyToolFailure(s.tool, s.output);
    const reason = clip(cap?.reason ?? plain(firstLine(s.output)), 150);
    const key = reason.toLowerCase();
    if (reason && !seen.has(key)) {
      seen.add(key);
      reasons.push(reason);
    }
  }
  const summary = (input.summary || "").trim();
  const plumbing = /agent_delegate\(|unroutable:|\bstack\b|at \w+ \(/i.test(summary);
  if (!reasons.length && summary && !plumbing) reasons.push(clip(summary, 220));
  // Every step succeeded but the final check never confirmed the goal: say that, with the
  // checker's own reason - "the agents could not complete the work" would be untrue.
  const anyFailed = input.steps.some((s) => !s.ok);
  const lead = anyFailed || !input.steps.length ? "What stopped it" : "The final check still had open items";
  const fallback = anyFailed || !input.steps.length ? "the agents could not complete the work" : "it never confirmed the goal was met";
  const left = [...new Set(input.steps.filter((s) => !s.ok).map((s) => clip(s.why || firstLine(s.prompt), 90)).filter(Boolean))];
  const stopped = reasons.length ? reasons.slice(0, MAX_REASONS).join("; ") : fallback;
  const more = reasons.length > MAX_REASONS ? ` (+${reasons.length - MAX_REASONS} more)` : "";
  const leftText = left.length
    ? ` What's left: ${left.slice(0, MAX_LEFT).join("; ")}${left.length > MAX_LEFT ? ` (+${left.length - MAX_LEFT} more)` : ""}.`
    : "";
  return `Not finished. ${lead}: ${stopped}${more}.${leftText}`.replace(/\.\./g, ".");
}

/** Team-step boilerplate that says who the agent is, not what it is doing. */
const PREAMBLE_RE = /^(?:you are (?:forge|vega|quill|lens)\b|.*\bbuild team\b|.*\bworking for zach\b)/i;

/**
 * Pure: the one line Mission shows for a planned or dispatched step - WHAT the agent is doing.
 * Live 2026-10-01 rows read "You are Vega (Codex) on Praxis's build team - …" (the prompt's
 * preamble) and "deliverable gate failed" (a checker's terse note) instead of the task.
 */
export function stepLabel(step: { why?: string; prompt: string }, max = 170): string {
  const why = (step.why || "").trim();
  const taskLine =
    (step.prompt || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 12 && !PREAMBLE_RE.test(l)) ?? "";
  if (why && !PREAMBLE_RE.test(why) && why.split(/\s+/).length >= 5) return clip(why, max);
  if (why && !PREAMBLE_RE.test(why) && taskLine) return clip(`Fix: ${why} - ${taskLine}`, max);
  return clip(taskLine || why || "work on the deliverable", max);
}

const AGENT_NAME: Record<DriverTool, string> = { claude: "Forge", codex: "Vega", cursor: "Quill" };

function andList(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

/**
 * Pure: the closing message of a finished mission - concise, and it says WHAT was done. Done in
 * 11 min. Vega and Forge did the work (Forge covered for Quill). The preview is open, and it's
 * in your Inbox.
 */
export function resultMessage(input: {
  minutes: number;
  title?: string | null;
  steps: { tool: DriverTool; ok: boolean; output: string }[];
  benched?: { tool: DriverTool; standIn?: DriverTool | null }[];
  hasPreview: boolean;
  previewOpened: boolean;
}): string {
  const who = [...new Set(input.steps.filter((s) => s.ok).map((s) => AGENT_NAME[s.tool]))];
  let checks: string | null = null;
  for (const s of [...input.steps].reverse()) {
    if (!s.ok) continue;
    const m = /(\d+)\s*\/\s*(\d+)\s+(?:[\w:/-]+\s+){0,3}?checks?\s+pass/i.exec(s.output || "");
    if (m && m[1] === m[2]) {
      checks = `${m[1]}/${m[2]} checks passed`;
      break;
    }
  }
  const covered = (input.benched ?? [])
    .filter((b) => b.standIn)
    .map((b) => `${AGENT_NAME[b.standIn as DriverTool]} covered for ${AGENT_NAME[b.tool]}`);
  const what = input.title ? `"${clip(input.title, 80)}" is built` : "The work is done";
  const by = who.length ? ` ${andList(who)} did the work${covered.length ? ` (${covered.join("; ")})` : ""}.` : "";
  const where = input.previewOpened
    ? " The preview is open, and it's in your Inbox."
    : input.hasPreview
      ? " Open the preview below or from your Inbox."
      : " It's in your Inbox.";
  return `Done in ${Math.max(1, Math.round(input.minutes))} min. ${what}${checks ? ` - ${checks}` : ""}.${by}${where}`;
}

/** Pure: Praxis's words made easy on the ear for Atlas to read out (no paths, no slashes). */
export function speakable(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s,;)]+/g, "its folder")
    .replace(/file:\/\/\/\S+/g, "the preview")
    .replace(/(\d+)\s*\/\s*(\d+)/g, "$1 of $2")
    .replace(/\bmin\b/g, "minutes")
    .replace(/["“”]/g, "")
    .replace(/\s+-\s+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
