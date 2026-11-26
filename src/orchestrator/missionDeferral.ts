/**
 * missionDeferral - when every agent is out, a mission WAITS instead of failing.
 *
 * Nothing was broken; nothing could run yet.
 *
 * At most MAX_DEFERRALS times; then it fails honestly.
 */

import { classifyToolFailure, formatClock, type DriverTool } from "./drivers";
import type { FleetAvailability } from "./policy";

export const MAX_DEFERRALS = 3;
/** Wait when no agent said when it is back. */
export const DEFAULT_WAIT_MS = 30 * 60_000;
/** Start a minute after the window reopens, not on the dot. */
export const START_SLACK_MS = 60_000;
export const DEFER_KEY = "praxis.mission.deferred.v1";

const TOOLS: DriverTool[] = ["claude", "codex", "cursor"];
const NAMES: Record<DriverTool, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

export interface DeferredMission {
  missionId: string;
  goal: string;
  intent?: string;
  /** Unix ms to start. */
  at: number;
  /** How many times this mission has been deferred, including this one. */
  deferrals: number;
}

/** Pure: should a run that ended not-done wait for capacity instead of failing? */
export function deferralFor(input: {
  steps: { tool: DriverTool; ok: boolean; output: string; toolError?: boolean }[];
  avail: FleetAvailability;
  deferrals: number;
  now: number;
}): { at: number; text: string } | null {
  const { steps, avail, deferrals, now } = input;
  if (deferrals >= MAX_DEFERRALS) return null;
  // Partial work: the failure message says what's left; a blind re-run could redo it.
  if (steps.some((s) => s.ok)) return null;
  if (steps.some((s) => !s.ok && (s.toolError === false || !classifyToolFailure(s.tool, s.output, now)))) return null;
  // And nobody can run right now.
  if (TOOLS.some((t) => avail[t]?.usable)) return null;
  const back = TOOLS.map((t) => ({ t, at: avail[t]?.retryAt }))
    .filter((x): x is { t: DriverTool; at: number } => typeof x.at === "number" && x.at > now)
    .sort((a, b) => a.at - b.at);
  const first = back[0];
  const at = (first?.at ?? now + DEFAULT_WAIT_MS) + START_SLACK_MS;
  const who = TOOLS.map((t) => {
    const r = avail[t]?.retryAt;
    return `${NAMES[t]} ${typeof r === "number" && r > now ? `until ${formatClock(r, now)}` : "unavailable"}`;
  }).join(", ");
  const text =
    `Every agent is out right now (${who}). I've queued this mission and will start it at ` +
    `${formatClock(at, now)}${first ? `, when ${NAMES[first.t]} is back` : ""}. Nothing for you to do.`;
  return { at, text };
}

function readQueue(): DeferredMission[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DEFER_KEY) : null;
    const list = raw ? (JSON.parse(raw) as DeferredMission[]) : [];
    return Array.isArray(list) ? list.filter((d) => d && typeof d.missionId === "string" && typeof d.goal === "string" && typeof d.at === "number") : [];
  } catch {
    return [];
  }
}

function writeQueue(list: DeferredMission[]): void {
  try {
    localStorage.setItem(DEFER_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the timer still runs this session */
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function arm(d: DeferredMission): void {
  const prev = timers.get(d.missionId);
  if (prev) clearTimeout(prev);
  const delay = Math.max(5_000, d.at - Date.now());
  timers.set(
    d.missionId,
    setTimeout(() => {
      timers.delete(d.missionId);
      writeQueue(readQueue().filter((x) => x.missionId !== d.missionId));
      void import("./orchestrator")
        .then(({ orchestrate }) =>
          orchestrate(d.goal, { missionId: d.missionId, missionOpened: true, intent: d.intent, deferrals: d.deferrals }),
        )
        .catch((err) => console.error("[mission] deferred start failed:", err));
    }, delay),
  );
}

/** Queue a mission to start at `d.at` (persisted; replaces an earlier entry for the same mission). */
export function scheduleDeferredMission(d: DeferredMission): void {
  writeQueue([...readQueue().filter((x) => x.missionId !== d.missionId), d]);
  arm(d);
}

/** Re-arm queued missions after a restart. Call once, from the main window only. */
export function rearmDeferredMissions(): number {
  const list = readQueue();
  for (const d of list) arm(d);
  return list.length;
}

/** Cancel a queued mission (the owner pressed Stop before it started). True when it was queued. */
export function cancelDeferredMission(missionId: string): boolean {
  const timer = timers.get(missionId);
  if (timer) clearTimeout(timer);
  timers.delete(missionId);
  const list = readQueue();
  if (!list.some((d) => d.missionId === missionId)) return false;
  writeQueue(list.filter((d) => d.missionId !== missionId));
  return true;
}

/** Missions waiting for capacity (for surfaces that want to show the queue). */
export function deferredMissions(): DeferredMission[] {
  return readQueue();
}
