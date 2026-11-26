/**
 * missionFeed - the Mission thread as ONE live, shared feed for this window.
 *
 * The Mission panel and the always-visible dock both need the same thread (the dock must
 * show "running", an unread badge and the "done" glow while the panel is closed), so the
 * thread lives here, outside React, behind useSyncExternalStore:
 *
 *   • loads the persisted thread once (`loadMissionThread`), then follows `subscribeMission`
 *     (this window + every other, deduped by id) and merges the two,
 *   • remembers what the owner has SEEN (`praxis.mission.seen.v1` = newest timestamp) so unread
 *     counts and the done-glow survive a restart - and treats history from before the very
 *     first run as seen, so a fresh install doesn't light up,
 *   • opens the panel when a new mission starts (without taking keyboard focus),
 *   • tells the difference between an empty thread and one that could not be read.
 *
 * UI state only - this never writes to the thread (the orchestrator posts; the store's
 * submit() posts the owner's own message). The decisions themselves are pure, in missionLogic.ts.
 */

import { useMemo, useSyncExternalStore } from "react";
import {
  MISSION_THREAD_ID,
  groupMissions,
  subscribeMission,
  type MissionMsg,
} from "@/orchestrator/missionThread";
import { usePraxisStore } from "@/store/usePraxisStore";
import { dockState, maxTs, mergeThread, shouldAutoOpen, visibleMissions, type DockState } from "./missionLogic";
import { loadThreadShared } from "./threadLoad";

const SEEN_KEY = "praxis.mission.seen.v1";
/** Newest timestamp the owner cleared through (finished missions up to it are hidden). */
const CLEARED_KEY = "praxis.mission.clearedThrough.v1";

/** When this window started - a mission still "running" from before it can never finish. */
export const WINDOW_START = Date.now();

export interface FeedSnapshot {
  /** Oldest first, capped; the full thread stays on disk. */
  msgs: MissionMsg[];
  /** The persisted thread has been read (or there is none to read). */
  loaded: boolean;
  /** Set when the thread exists but could not be read - never faked as "empty". */
  error: string | null;
  /** Newest timestamp the owner has seen; 0 = never. */
  lastSeen: number;
  /** Finished missions whose last message is at or before this are hidden; 0 = none. */
  clearedThrough: number;
}

// ------------------------------------------------------------------ seen ---

function readSeen(): number | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSeen(ts: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(ts));
  } catch {
    /* best effort - an unpersisted "seen" only means the badge may return after a restart */
  }
}

function readCleared(): number {
  try {
    const n = Number(localStorage.getItem(CLEARED_KEY) ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCleared(ts: number): void {
  try {
    if (ts > 0) localStorage.setItem(CLEARED_KEY, String(ts));
    else localStorage.removeItem(CLEARED_KEY);
  } catch {
    /* best effort - an unpersisted clear only means old missions return after a restart */
  }
  void import("@/shared/persist")
    .then(({ mirrorSet }) => mirrorSet(CLEARED_KEY, String(ts)))
    .catch(() => {});
}

// ----------------------------------------------------------------- loading ---

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * `loadMissionThread()` swallows read failures and returns [] - which would make a broken
 * thread look like a quiet one. When it comes back empty inside Tauri, ask the backend
 * once more so a real failure can be shown as one.
 */
export async function loadThreadWithStatus(fresh = false): Promise<{ msgs: MissionMsg[]; error: string | null }> {
  const msgs = await loadThreadShared(fresh);
  if (msgs.length > 0 || !inTauri()) return { msgs, error: null };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("agent_chat_read", { agentId: MISSION_THREAD_ID });
    return { msgs, error: null };
  } catch (err) {
    return { msgs, error: err instanceof Error ? err.message : String(err) };
  }
}

// ------------------------------------------------------------------- store ---

let snap: FeedSnapshot = { msgs: [], loaded: false, error: null, lastSeen: readSeen() ?? 0, clearedThrough: readCleared() };
/** Did a persisted "seen" exist before this window started? (First run → history counts as seen.) */
let seenKnown = readSeen() !== null;
const listeners = new Set<() => void>();
let unsubscribeLive: (() => void) | null = null;
let generation = 0;
/** Missions that already opened the panel by themselves - closing it means "not now". */
const openedFor = new Set<string>();
let quietOpenAt = 0;

function set(next: FeedSnapshot): void {
  snap = next;
  for (const l of listeners) l();
}

function maybeAutoOpen(msg: MissionMsg): void {
  const st = usePraxisStore.getState();
  const go = shouldAutoOpen({
    msg,
    now: Date.now(),
    dumpOpen: st.dumpOpen,
    openedFor,
  });
  if (!go) return;
  openedFor.add(msg.missionId);
  quietOpenAt = Date.now();
  st.setDumpOpen(true);
}

/**
 * True once after the panel was opened by a new mission (not by the owner): the panel must not
 * pull keyboard focus into its composer then. Bounded in time so a stale flag can never
 * swallow a later, deliberate open.
 */
export function consumeQuietOpen(): boolean {
  const quiet = quietOpenAt > 0 && Date.now() - quietOpenAt < 1500;
  quietOpenAt = 0;
  return quiet;
}

async function load(fresh = false): Promise<void> {
  const mine = ++generation;
  const { msgs, error } = await loadThreadWithStatus(fresh);
  if (mine !== generation) return;
  // history first (older by construction), then anything that arrived while the read ran
  const merged = mergeThread(msgs, snap.msgs);
  let lastSeen = snap.lastSeen;
  if (!seenKnown) {
    lastSeen = maxTs(merged);
    seenKnown = true;
    writeSeen(lastSeen);
  }
  set({ msgs: merged, loaded: true, error, lastSeen, clearedThrough: snap.clearedThrough });
}

function onLive(m: MissionMsg): void {
  set({ ...snap, msgs: mergeThread(snap.msgs, [m]) });
  maybeAutoOpen(m);
}

/** The history read waits out the app's own start-up (WebGL, stores) - live messages are followed at once. */
const BOOT_DEFER_MS = 1200;
let bootTimer: number | undefined;

/** Another Praxis window cleared (or restored) the Mission history: follow it. */
function onStorage(e: StorageEvent): void {
  if (e.key === CLEARED_KEY) set({ ...snap, clearedThrough: readCleared() });
}

function start(): void {
  unsubscribeLive = subscribeMission(onLive);
  bootTimer = window.setTimeout(() => void load(), BOOT_DEFER_MS);
  window.addEventListener("storage", onStorage);
}

function stop(): void {
  window.clearTimeout(bootTimer);
  unsubscribeLive?.();
  unsubscribeLive = null;
  window.removeEventListener("storage", onStorage);
}

function subscribeFeed(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) stop();
  };
}

const getSnapshot = (): FeedSnapshot => snap;

/** Everything up to now is seen (the panel is open and visible). */
export function markSeen(): void {
  const t = maxTs(snap.msgs);
  if (t <= snap.lastSeen) return;
  writeSeen(t);
  set({ ...snap, lastSeen: t });
}

/**
 * Hide every finished mission up to now (running ones stay). Returns the previous
 * boundary for Undo and how many missions it hid.
 */
export function clearFinishedMissions(): { previous: number; hidden: number } {
  const previous = snap.clearedThrough;
  const through = Math.max(maxTs(snap.msgs), Date.now());
  const groups = groupMissions(snap.msgs);
  const hidden = visibleMissions(groups, previous, WINDOW_START).length - visibleMissions(groups, through, WINDOW_START).length;
  writeCleared(through);
  markSeen();
  set({ ...snap, clearedThrough: through });
  return { previous, hidden };
}

/** Undo a clear: put the previous boundary back. */
export function restoreClearedMissions(previous: number): void {
  writeCleared(previous);
  set({ ...snap, clearedThrough: previous });
}

/** Read the thread again (the error state's "try again"). */
export function reloadFeed(): void {
  set({ ...snap, loaded: false, error: null });
  void load(true);
}

// ------------------------------------------------------------------- hooks ---

export function useMissionFeed(): FeedSnapshot {
  return useSyncExternalStore(subscribeFeed, getSnapshot, getSnapshot);
}

/** The thread grouped into missions, oldest mission first. */
export function useMissionGroups(): { feed: FeedSnapshot; groups: ReturnType<typeof groupMissions> } {
  const feed = useMissionFeed();
  const groups = useMemo(
    () => visibleMissions(groupMissions(feed.msgs), feed.clearedThrough, WINDOW_START),
    [feed.msgs, feed.clearedThrough],
  );
  return { feed, groups };
}

/** What the dock shows: running · done glow · stopped · unread badge (cleared missions don't count). */
export function useMissionDock(): DockState {
  const { msgs, lastSeen, clearedThrough } = useMissionFeed();
  return useMemo(() => {
    if (!clearedThrough) return dockState(msgs, lastSeen, WINDOW_START);
    const shown = new Set(visibleMissions(groupMissions(msgs), clearedThrough, WINDOW_START).map((g) => g.missionId));
    return dockState(msgs.filter((m) => shown.has(m.missionId)), lastSeen, WINDOW_START);
  }, [msgs, lastSeen, clearedThrough]);
}
