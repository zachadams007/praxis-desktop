/**
 * useFileWatch - the REAL half of the file-birth visualizer (Phase 1, no API).
 *
 * In the Tauri desktop shell it asks the Rust backend (notify crate) to watch a local
 * folder and, when a file appears there, emits a `file:created` onto the same eventBus
 * the mock timeline uses - so a real file an agent writes pulses the brain and lands in
 * the Files panel, with a click that opens it. In a plain browser it is inert.
 *
 * Dynamic per-file 3D nodes are a small follow-up; for now a real birth pulses the
 * "New Lane" branch and is listed in the Files panel.
 */

import { useEffect } from "react";
import { eventBus } from "./eventBus";
import { usePraxisStore } from "@/store/usePraxisStore";
import { milestoneForSignal } from "./journey";
import { attachCreatedFileArtifact } from "./graph";

interface FileBorn {
  name: string;
  path: string;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export function useFileWatch(): void {
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const [{ listen }, { invoke }, { homeDir, join }] = await Promise.all([
          import("@tauri-apps/api/event"),
          import("@tauri-apps/api/core"),
          import("@tauri-apps/api/path"),
        ]);

        // Real agents write into their repo worktrees, and the transcript bus already carries
        // every Write/Edit they perform - that is the second listener below.
        const dir = await join(await homeDir(), "Desktop", "agent-output");
        await invoke("watch_folder", { path: dir }).catch(() => {});

        // A file an AGENT actually wrote, from the transcript tailer's tool frames.
        const stopTool = await listen<{ tool_path?: string | null; tool_name?: string | null }>(
          "praxis://transcript-event",
          (e) => {
            const p = e.payload?.tool_path;
            if (!p) return; // only Write/Edit/NotebookEdit carry a path
            const name = p.split(/[\/]/).pop() || p;
            born({ name, path: p });
          },
        );

        const stop = await listen<FileBorn>("praxis://file-born", (e) => {
          born(e.payload);
        });
        const combined = () => {
          stop();
          stopTool();
        };
        if (cancelled) combined();
        else unlisten = combined;
      } catch {
        /* watcher unavailable - file births simply stay quiet */
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}

/** One file-birth → the brain's event bus. Shared by the folder watcher and the
 *  transcript tool frames so both routes land identically. */
function bornImpl(payload: FileBorn): void {
  {
    {
          const { name, path } = payload;
          // Map the real file to the milestone it belongs to (spec §B.8): explicit
          // signal match on its name+path, else fall back to the praxis area. When
          // mapped, the file:created event targets that task's branch (resolveTarget
          // uses taskId) AND the file is attached as a tier-3 artifact leaf under it.
          const journey = usePraxisStore.getState().journey;
          const milestoneId = milestoneForSignal({ text: `${name} ${path}` }, journey);
          const areaId = milestoneId
            ? journey.find((m) => m.id === milestoneId)?.areaId ?? "praxis"
            : "praxis";
          eventBus.emit({
            type: "file:created",
            t: 0,
            nodeId: `real:${path}`,
            taskId: milestoneId, // real branch target when known
            areaId, // resolveTarget falls back to this for the pulse
            label: name,
            path,
          });
          if (milestoneId) attachCreatedFileArtifact(milestoneId, name);
  }
  }
}

/** De-duplicated entry point: an agent editing the same file repeatedly in one
 *  turn should not spray the brain with births of the same node. */
const recentBirths = new Map<string, number>();
function born(payload: FileBorn): void {
  const key = payload.path;
  const now = Date.now();
  const last = recentBirths.get(key) ?? 0;
  if (now - last < 30_000) return;
  recentBirths.set(key, now);
  if (recentBirths.size > 200) {
    for (const [k, t] of recentBirths) if (now - t > 300_000) recentBirths.delete(k);
  }
  bornImpl(payload);
}
