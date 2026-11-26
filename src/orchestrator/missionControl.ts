/**
 * missionControl - stop a running mission from the Mission panel.
 *
 * The only stop used to be HALT ALL, which cuts the whole fleet. Every orchestrate() registers
 * an AbortController under its missionId here; Stop aborts it in whichever window runs it (a
 * Tauri broadcast reaches the right webview). The abort travels the run's own signal into the
 * drivers, which kill the agent CLI trees (agent_delegate_abort), so a stopped mission actually
 * stops working instead of just stopping waiting.
 */

// A mission can have more than one run at once (a typed "open spotify. build me a
// site" runs the operator and the orchestrator under the same mission): Stop stops all.
const running = new Map<string, Set<AbortController>>();

/** Cross-window stop request (payload `{ missionId }`). */
export const MISSION_STOP_EVENT = "praxis://mission-stop";

/** Register a run. A parent signal (Atlas's own stop, an owned run) still stops it too. */
export function registerMission(missionId: string, parent?: AbortSignal): AbortController {
  const control = new AbortController();
  if (parent) {
    if (parent.aborted) control.abort();
    else parent.addEventListener("abort", () => control.abort(), { once: true });
  }
  let runs = running.get(missionId);
  if (!runs) running.set(missionId, (runs = new Set()));
  runs.add(control);
  listenForStops();
  return control;
}

/** A run ended (any way): forget it - or every run of the mission when none is named. */
export function finishMission(missionId: string, control?: AbortController): void {
  const runs = running.get(missionId);
  if (!runs) return;
  if (control) runs.delete(control);
  if (!control || runs.size === 0) running.delete(missionId);
}

/** True while this window is running that mission. */
export function isMissionRunningHere(missionId: string): boolean {
  return (running.get(missionId)?.size ?? 0) > 0;
}

/** Abort every run of the mission this window holds. */
export function stopMissionHere(missionId: string): boolean {
  const runs = running.get(missionId);
  if (!runs?.size) return false;
  for (const control of runs) control.abort();
  return true;
}

/** Stop a mission wherever it runs: here, and in any other Praxis window. A mission still
 *  queued for capacity (missionDeferral) is cancelled before it starts. */
export async function requestMissionStop(missionId: string): Promise<void> {
  stopMissionHere(missionId);
  await cancelQueued(missionId);
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(MISSION_STOP_EVENT, { missionId });
  } catch {
    /* dev browser: the local abort above is the whole story */
  }
}

/** Cancel a queued (deferred) mission and say so - only the window that removed it posts. */
async function cancelQueued(missionId: string): Promise<void> {
  try {
    const { cancelDeferredMission } = await import("./missionDeferral");
    if (!cancelDeferredMission(missionId)) return;
    const { praxisSay } = await import("./missionThread");
    await praxisSay(missionId, "failure", "Stopped — you cancelled this queued mission before it started.", { status: "failed" });
  } catch (err) {
    console.error("[mission] cancelling a queued mission failed:", err);
  }
}

let listening = false;

function listenForStops(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ missionId?: string }>(MISSION_STOP_EVENT, (e) => {
        // Only aborts (and cancels a queued start); never re-emits, so two windows
        // can't ping-pong a stop.
        if (e.payload?.missionId) {
          stopMissionHere(e.payload.missionId);
          void cancelQueued(e.payload.missionId);
        }
      }),
    )
    .catch(() => {
      listening = false;
    });
}
