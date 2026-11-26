/**
 * threadLoad - ONE shared read of the persisted Mission thread.
 *
 * `agent_chat_read` hands back the WHOLE append-only `mission.jsonl` (the file only grows),
 * and it is a synchronous Tauri command. Two places in a window want the thread at about the
 * same moment (the Mission feed behind the dock, and the Inbox's "Delivered" source), so
 * concurrent callers share one in-flight read instead of each paying for it. Live messages
 * never need a re-read - `subscribeMission` delivers those - so nothing polls this.
 */

import { loadMissionThread, type MissionMsg } from "@/orchestrator/missionThread";

const SHARE_MS = 4000;

let inflight: Promise<MissionMsg[]> | null = null;
let startedAt = 0;

/** The persisted thread, oldest first. Callers within a few seconds share one read; `fresh` forces a new one. */
export function loadThreadShared(fresh = false): Promise<MissionMsg[]> {
  const now = Date.now();
  if (!fresh && inflight && now - startedAt < SHARE_MS) return inflight;
  startedAt = now;
  inflight = loadMissionThread();
  return inflight;
}
