/**
 * useArtifactOpen - the pending → opened | error life of ONE open button.
 *
 * `run()` flips to `pending`, awaits the REAL open (openArtifact), and only then shows
 * `opened` (a brief confirmation that clears itself) or `error` (the inline sentence,
 * which stays until the next try). A second click while pending is ignored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionArtifact } from "@/orchestrator/missionThread";
import { openArtifact } from "./openArtifact";

export type ArtifactUiState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "opened" }
  | { status: "error"; message: string };

/** How long the "opened" confirmation stays. */
const OPENED_MS = 2400;

export function useArtifactOpen(art: MissionArtifact): { state: ArtifactUiState; run: () => void } {
  const [state, setState] = useState<ArtifactUiState>({ status: "idle" });
  const pending = useRef(false);
  const alive = useRef(true);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    window.clearTimeout(timer.current);
    setState({ status: "pending" });
    void openArtifact(art)
      .then((res) => {
        pending.current = false;
        if (!alive.current) return;
        if (res.ok) {
          setState({ status: "opened" });
          timer.current = window.setTimeout(() => {
            if (alive.current) setState({ status: "idle" });
          }, OPENED_MS);
        } else {
          setState({ status: "error", message: res.message });
        }
      })
      .catch((err: unknown) => {
        // openArtifact never throws by contract; if it ever does, say so instead of hanging.
        pending.current = false;
        if (alive.current) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
  }, [art]);

  return { state, run };
}
