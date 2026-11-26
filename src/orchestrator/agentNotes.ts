/**
 * agentNotes - a note the owner leaves for an AGENT on the Flight Deck reaches it with its next job.
 *
 * The deck's agent dock (Forge / Vega / Quill, not one session) appended the note to the
 * agent's thread and said "QUEUED FOR FORGE - READ AT NEXT PICKUP". Nothing ever read it:
 * the thread was only displayed (audit 2026-10-01). Now the driver hands every unread note
 * to the agent at the top of its next job, and marks them read only once that job ran, so
 * a run that fails before the agent sees them leaves them for the next one.
 *
 * Messages aimed at a SESSION go straight into that session (session_deliver) and are not
 * notes; neither are old "[LANE CAST]" rows, which the deck wrote before it could deliver.
 */

import type { DriverTool } from "./drivers";

export const NOTES_KEY = "praxis.agentNotes.pickedUp.v1";
/** Older notes are stale instructions, not context. */
export const NOTE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
export const MAX_NOTES = 5;

const AGENT_THREAD: Record<DriverTool, string> = { claude: "a.forge", codex: "a.vega", cursor: "a.quill" };

export type ThreadRow = { role?: unknown; text?: unknown; ts?: unknown; meta?: unknown };
export type AgentNote = { text: string; at: number };

/** Pure: the owner's unread agent-level Flight Deck notes, oldest first, newest MAX_NOTES kept. */
export function unreadNotes(rows: ThreadRow[], since: number, now: number): AgentNote[] {
  const out: AgentNote[] = [];
  for (const r of rows) {
    if (r?.role !== "zach" || typeof r.text !== "string" || typeof r.ts !== "number") continue;
    const meta = r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : null;
    if (!meta || meta.source !== "flightdeck") continue;
    if (typeof meta.sessionId === "string" && meta.sessionId) continue; // went to a session
    const text = r.text.trim();
    if (!text || /^\[(?:LANE CAST|STEER)\]/i.test(text)) continue;
    if (r.ts <= since || now - r.ts > NOTE_MAX_AGE_MS) continue;
    out.push({ text, at: r.ts });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-MAX_NOTES);
}

/** Pure: the block that goes on top of the agent's job. */
export function notesPreamble(notes: AgentNote[]): string {
  if (!notes.length) return "";
  const lines = notes.map((n) => `- ${n.text.replace(/\s+/g, " ").slice(0, 600)}`);
  return `Notes Zach left for you on Praxis's Flight Deck - follow any that apply to this job:\n${lines.join("\n")}\n\n`;
}

function readMarks(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(NOTES_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeMark(agentId: string, ts: number): void {
  try {
    const marks = readMarks();
    marks[agentId] = Math.max(marks[agentId] ?? 0, ts);
    globalThis.localStorage?.setItem(NOTES_KEY, JSON.stringify(marks));
  } catch {
    /* storage unavailable: the notes come again next job, never lost */
  }
}

/**
 * The unread notes for `tool` as a prompt preamble, plus `markRead()` to call once the job
 * actually ran. Never throws: no thread / no Tauri / no storage = no notes.
 */
export async function pendingAgentNotes(
  tool: DriverTool,
  read: (agentId: string) => Promise<unknown[]>,
  now = Date.now(),
): Promise<{ preamble: string; count: number; markRead: () => void }> {
  const agentId = AGENT_THREAD[tool];
  try {
    const rows = await read(agentId);
    const notes = unreadNotes(Array.isArray(rows) ? (rows as ThreadRow[]) : [], readMarks()[agentId] ?? 0, now);
    const last = notes.length ? notes[notes.length - 1].at : 0;
    return { preamble: notesPreamble(notes), count: notes.length, markRead: () => (last ? writeMark(agentId, last) : undefined) };
  } catch {
    return { preamble: "", count: 0, markRead: () => undefined };
  }
}
