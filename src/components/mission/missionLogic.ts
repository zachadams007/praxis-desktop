/**
 * missionLogic - the PURE half of the Mission chat (no React, no DOM, no Tauri), so every
 * decision the UI makes about the thread is unit-testable (scripts/test-mission-ui.cjs):
 *
 *   • who is working right now (latest dispatch per agent with no later progress row),
 *   • live status incl. "interrupted" (a running mission that predates this window can
 *     never post its result, so it must not read as running),
 *   • unread counting + the dock's state (running / done glow / failed / unread),
 *   • whether a new mission should open the panel on its own,
 *   • merge/dedupe of the persisted thread with live messages,
 *   • small formatters (elapsed time, clock, summary line, model chip).
 *
 * The thread contract itself lives in src/orchestrator/missionThread.ts (frozen); this
 * file only reads it.
 */

import { groupMissions, type MissionAgent, type MissionMsg } from "@/orchestrator/missionThread";
import { stripControl } from "./lightMarkdown";

export type MissionGroup = ReturnType<typeof groupMissions>[number];
/** `interrupted` = it was running when the app last stopped and nothing has spoken since. */
export type LiveStatus = "running" | "done" | "failed" | "interrupted";

/** Newest messages kept in memory (the full thread stays on disk). */
export const THREAD_LIMIT = 400;
/** A mission that opens within this window of "now" may pull the panel open. */
export const AUTO_OPEN_MAX_AGE_MS = 30_000;
/** After it finishes, a mission keeps the header strip for this long. */
export const STRIP_LINGER_MS = 15 * 60_000;

const AGENT_KEYS: ReadonlySet<string> = new Set(["forge", "vega", "quill", "lens"]);

/** The agent a row is about: its explicit `agent`, else the sender when it is an agent. */
export function agentOf(m: MissionMsg): MissionAgent | undefined {
  if (m.agent) return m.agent;
  return AGENT_KEYS.has(m.from) ? (m.from as MissionAgent) : undefined;
}

// ------------------------------------------------------------------ thread ---

/**
 * Fold `incoming` into `prev`: dedupe by id, keep oldest-first (stable on equal
 * timestamps), cap to the newest `limit`. Returns `prev` itself when nothing is new, so
 * React state doesn't churn.
 */
export function mergeThread(prev: MissionMsg[], incoming: MissionMsg[], limit = THREAD_LIMIT): MissionMsg[] {
  const seen = new Set(prev.map((m) => m.id));
  const add: MissionMsg[] = [];
  for (const m of incoming) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    add.push(m);
  }
  if (add.length === 0) return prev;
  let merged = prev.concat(add);
  let sorted = true;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].ts < merged[i - 1].ts) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    merged = merged
      .map((m, i) => ({ m, i }))
      .sort((a, b) => a.m.ts - b.m.ts || a.i - b.i)
      .map((x) => x.m);
  }
  return merged.length > limit ? merged.slice(-limit) : merged;
}

/** Newest timestamp in a thread (0 when empty). */
export function maxTs(msgs: MissionMsg[]): number {
  let t = 0;
  for (const m of msgs) if (m.ts > t) t = m.ts;
  return t;
}

// ----------------------------------------------------------- who is working ---

export interface AgentPresence {
  agent: MissionAgent;
  /** When the dispatch (or the reroute that handed it the work) arrived. */
  since: number;
  model?: string;
  step?: { index: number; of: number };
  /** The dispatch row this presence came from (to mark that row "live"). */
  dispatchId?: string;
}

/**
 * Which agents are working right now: the latest `dispatch` per agent that has no later
 * `progress` row from that agent. A `reroute` takes the unavailable agent off (the
 * stand-in shows up when ITS dispatch row does, not before). A `result`/`failure` (or a
 * terminal `status`) means nobody is working. `msgs` is one mission's messages, oldest
 * first. Oldest-started first in the result.
 */
export function runningAgents(msgs: MissionMsg[]): AgentPresence[] {
  const live = new Map<MissionAgent, AgentPresence>();
  for (const m of msgs) {
    if (m.kind === "result" || m.kind === "failure" || m.status === "done" || m.status === "failed") {
      live.clear();
      continue;
    }
    const agent = agentOf(m);
    if (m.kind === "dispatch" && agent) {
      live.delete(agent);
      live.set(agent, { agent, since: m.ts, model: m.model, step: m.step, dispatchId: m.id });
    } else if (m.kind === "progress" && agent) {
      live.delete(agent);
    } else if (m.kind === "reroute") {
      if (m.agent) live.delete(m.agent);
    }
  }
  return [...live.values()].sort((a, b) => a.since - b.since);
}

// -------------------------------------------------------------- mission view ---

export interface MissionView {
  missionId: string;
  title: string;
  status: LiveStatus;
  startedAt: number;
  /** Timestamp of the newest message in the mission. */
  lastAt: number;
  /** When it finished (done/failed/interrupted), else null while running. */
  endedAt: number | null;
  agents: AgentPresence[];
  /** The latest `step` any row carried, e.g. 2 of 4. */
  step: { index: number; of: number } | null;
  /** Dispatch rows whose agent is still working (the rows that get a live dot). */
  liveDispatchIds: Set<string>;
  
  stopped: boolean;
}

/** The closing line of a mission the owner stopped himself (missionControl / orchestrator). */
export const STOPPED_BY_ZACH_RE = /^Stopped — you (?:stopped|cancelled)\b/;

/** Derive everything the header strip and the dock need from one mission group. */
export function missionView(g: MissionGroup, windowStart: number): MissionView {
  const msgs = g.msgs;
  const startedAt = msgs.length ? msgs[0].ts : 0;
  const lastAt = msgs.length ? msgs[msgs.length - 1].ts : 0;
  let status: LiveStatus = g.status;
  if (status === "running" && lastAt < windowStart) status = "interrupted";

  let terminalAt: number | null = null;
  for (const m of msgs) {
    if (m.kind === "result" || m.kind === "failure" || m.status === "done" || m.status === "failed") terminalAt = m.ts;
  }
  const endedAt = status === "running" ? null : status === "interrupted" ? lastAt : terminalAt ?? lastAt;

  const lastFailure = [...msgs].reverse().find((m) => m.kind === "failure");
  const stopped = status === "failed" && !!lastFailure && STOPPED_BY_ZACH_RE.test(lastFailure.text);
  const agents = status === "running" ? runningAgents(msgs) : [];
  let step: MissionView["step"] = null;
  for (const m of msgs) if (m.step) step = m.step;

  return {
    missionId: g.missionId,
    title: g.title,
    status,
    startedAt,
    lastAt,
    endedAt,
    agents,
    step,
    liveDispatchIds: new Set(agents.map((a) => a.dispatchId).filter((x): x is string => !!x)),
    stopped,
  };
}

/**
 * The missions the panel shows. The owner can clear finished missions (2026-10-10, the same
 * ask as deleting Inbox messages): the thread stays on disk and the clear is undoable;
 * the panel just stops showing missions whose last word came before the boundary. A
 * mission still running in this window is never hidden.
 */
export function visibleMissions(groups: MissionGroup[], clearedThrough: number, windowStart: number): MissionGroup[] {
  if (!clearedThrough) return groups;
  return groups.filter((g) => {
    const v = missionView(g, windowStart);
    return v.status === "running" || v.lastAt > clearedThrough;
  });
}

/**
 * What a running mission with NO agent working this second is doing, from the thread alone:
 * no plan yet → planning; a plan but no agent dispatched yet → starting; otherwise it is
 * between steps (every dispatched agent has reported back).
 */
export type MissionPhase = "planning" | "starting" | "between";

export function missionPhase(msgs: MissionMsg[]): MissionPhase {
  if (!msgs.some((m) => m.kind === "plan")) return "planning";
  if (!msgs.some((m) => m.kind === "dispatch")) return "starting";
  return "between";
}

/** Elapsed time of a mission: ticking while running, frozen once it has ended. */
export function elapsedMs(v: MissionView, now: number): number {
  return Math.max(0, (v.endedAt ?? now) - v.startedAt);
}

/** The mission the header strip should describe, or null when it should stay out of the way. */
export function stripMission(groups: MissionGroup[], now: number, windowStart: number): MissionView | null {
  // The newest still-running mission wins; otherwise the latest one, while it is fresh.
  let latest: MissionView | null = null;
  let running: MissionView | null = null;
  for (const g of groups) {
    const v = missionView(g, windowStart);
    latest = v;
    if (v.status === "running") running = v;
  }
  if (running) return running;
  if (latest && now - latest.lastAt <= STRIP_LINGER_MS) return latest;
  return null;
}

// ------------------------------------------------------------------- unread ---

export interface UnreadSummary {
  
  count: number;
  /** A `result` arrived that the owner has not seen - the dock glows until he opens the panel. */
  hasResult: boolean;
  hasFailure: boolean;
  /** The newest unseen message (the dock's screen-reader line). */
  latest: MissionMsg | null;
}

export function unreadSummary(msgs: MissionMsg[], lastSeen: number): UnreadSummary {
  let count = 0;
  let hasResult = false;
  let hasFailure = false;
  let latest: MissionMsg | null = null;
  for (const m of msgs) {
    if (m.from === "zach" || m.ts <= lastSeen) continue;
    count += 1;
    if (m.kind === "result") hasResult = true;
    if (m.kind === "failure") hasFailure = true;
    if (!latest || m.ts >= latest.ts) latest = m;
  }
  return { count, hasResult, hasFailure, latest };
}

// --------------------------------------------------------------- the dock ---

export type DockTone = "failed" | "done" | "live" | "unread" | null;

export interface DockState {
  tone: DockTone;
  /** Text for the dock slot ("" = keep the idle "dump a thought…"). */
  label: string;
  /** Unread badge number (0 = none). */
  count: number;
  /** Tooltip / accessible name. */
  title: string;
  /** One line for screen readers when something new arrives while the panel is closed. */
  announce: string;
  running: MissionView | null;
}

/**
 * What the always-visible dock shows.
 */
export function dockState(msgs: MissionMsg[], lastSeen: number, windowStart: number): DockState {
  const groups = groupMissions(msgs);
  const views = groups.map((g) => missionView(g, windowStart));
  const running = [...views].reverse().find((v) => v.status === "running") ?? null;
  const unread = unreadSummary(msgs, lastSeen);
  const titleOf = (id: string | undefined) => views.find((v) => v.missionId === id)?.title ?? "";

  const announce = unread.latest ? `${senderName(unread.latest.from)}: ${summaryLine(unread.latest.text, 120)}` : "";
  const idle: DockState = { tone: null, label: "", count: unread.count, title: "", announce, running };
  let latestFail: MissionMsg | null = null;
  let latestDone: MissionMsg | null = null;
  for (const m of msgs) {
    if (m.from === "zach" || m.ts <= lastSeen) continue;
    // The owner's own Stop is not an alert for the owner.
    if (m.kind === "failure" && !STOPPED_BY_ZACH_RE.test(m.text)) latestFail = m;
    if (m.kind === "result") latestDone = m;
  }
  if (latestFail) {
    const t = titleOf(latestFail.missionId);
    return { ...idle, tone: "failed", label: t ? `stopped · ${t}` : "mission stopped", title: `Mission stopped: ${t || "it needs you"}` };
  }
  if (latestDone) {
    const t = titleOf(latestDone.missionId);
    return { ...idle, tone: "done", label: t ? `done · ${t}` : "mission done", title: `Mission delivered: ${t || "open it"}` };
  }
  if (running) {
    const names = running.agents.map((a) => agentName(a.agent));
    const who = names.length ? ` (${names.join(", ")} working)` : "";
    return { ...idle, tone: "live", label: running.title, title: `Mission running: ${running.title}${who}` };
  }
  if (unread.count > 0) {
    return { ...idle, tone: "unread", label: "Praxis replied", title: `Mission: Praxis posted ${unread.count} new message${unread.count === 1 ? "" : "s"}` };
  }
  return idle;
}

// --------------------------------------------------------------- auto-open ---

export interface AutoOpenInput {
  msg: MissionMsg;
  now: number;
  /** The Mission panel is already open. */
  dumpOpen: boolean;
  /** Missions that already opened the panel once (closing it means "not now"). */
  openedFor: ReadonlySet<string>;
  maxAgeMs?: number;
}

/**
 * A new mission (its first `mission` or `brief` row) opens the panel by itself, once, unless it
 * is already open or the row is old news.
 */
export function shouldAutoOpen(i: AutoOpenInput): boolean {
  if (i.msg.kind !== "mission" && i.msg.kind !== "brief") return false;
  if (i.dumpOpen) return false;
  if (i.openedFor.has(i.msg.missionId)) return false;
  return i.now - i.msg.ts <= (i.maxAgeMs ?? AUTO_OPEN_MAX_AGE_MS);
}

// --------------------------------------------------------------- plan lines ---

export type PlanLine =
  | { kind: "agent"; agent: MissionAgent; text: string }
  | { kind: "workspace"; path: string }
  | { kind: "text"; text: string };

/** "Forge: builds the layout" → an agent line; "Workspace: C:\\x" → a path line. */
export function parsePlanLines(text: string): PlanLine[] {
  const out: PlanLine[] = [];
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const agent = line.match(/^(forge|vega|quill|lens)\s*[:\u2014-]\s*(.+)$/i);
    if (agent) {
      out.push({ kind: "agent", agent: agent[1].toLowerCase() as MissionAgent, text: agent[2].trim() });
      continue;
    }
    const ws = line.match(/^workspace\s*:\s*(.+)$/i);
    if (ws) {
      out.push({ kind: "workspace", path: ws[1].trim() });
      continue;
    }
    out.push({ kind: "text", text: line });
  }
  return out;
}

// ---------------------------------------------------------------- formatters ---

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 7 → "0:07", 134 → "2:14", 3734 → "1:02:14". */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** "14:02" (local). */
export function clockLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Today → "14:02"; any other day → "2026-09-29 14:02". */
export function whenLabel(ts: number, now: number): string {
  const a = new Date(ts);
  const b = new Date(now);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? clockLabel(ts) : `${a.getFullYear()}-${pad2(a.getMonth() + 1)}-${pad2(a.getDate())} ${clockLabel(ts)}`;
}

/** One plain line from a (possibly markdown, possibly multi-line) message - for the Inbox. */
export function summaryLine(text: string, max = 160): string {
  const first =
    stripControl(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const plain = first
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*\u2022]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}\u2026` : plain;
}

/** "claude-opus-4-8" → "opus-4.8" · "gpt-6-astra" stays. Null when there is no model. */
export function prettyModel(model?: string | null): string | null {
  const raw = (model ?? "").trim();
  if (!raw) return null;
  const pretty = raw
    .replace(/^(anthropic|openai)\//i, "")
    .replace(/^claude-/i, "")
    .replace(/(\d)-(\d)(?!\d)/g, "$1.$2");
  return pretty.length > 22 ? `${pretty.slice(0, 21)}\u2026` : pretty;
}

/** Agent → display name, e.g. "forge" → "Forge". */
export function agentName(agent: MissionAgent): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

/** Who said it, for a screen-reader line: "Praxis" · "Atlas" · "Forge" · "You". */
export function senderName(from: MissionMsg["from"]): string {
  if (from === "zach") return "You";
  return from.charAt(0).toUpperCase() + from.slice(1);
}
