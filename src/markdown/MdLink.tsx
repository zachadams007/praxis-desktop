/**
 * MdLink - a link in an Atlas message.
 *
 * Rendered as a BUTTON, not an anchor, and opened through Praxis's existing open-URL path
 * (`openArtifact` -> `desktop_open_url`: the browser the owner actually uses), the same one
 * Mission's links and artifact buttons take. A link in a model's output therefore can never
 * navigate the Tauri webview itself, whatever it says. Only absolute http(s) addresses get
 * here at all (safeUrl.ts); everything else is rendered as plain text by the caller.
 *
 * A source citation like [1] is the same link drawn as a small chip.
 */

import { useMemo, type ReactNode } from "react";
import type { MissionArtifact } from "@/orchestrator/missionThread";
import { useArtifactOpen } from "@/components/mission/useArtifactOpen";
import { textOf } from "./nodeText";

export function MdLink({ href, children }: { href: string; children: ReactNode }) {
  const label = textOf(children).trim();
  const art = useMemo<MissionArtifact>(() => ({ kind: "url", label: label || href, target: href }), [href, label]);
  const { state, run } = useArtifactOpen(art);
  const cite = /^\[\d{1,2}\]$/.test(label);
  return (
    <>
      <button
        type="button"
        className={`md-link${cite ? " md-cite" : ""} is-${state.status}`}
        onClick={run}
        title={href}
        aria-busy={state.status === "pending" || undefined}
      >
        {children}
      </button>
      {state.status === "error" && (
        <span className="md-link-err" role="alert">
          {" "}
          {state.message}
        </span>
      )}
    </>
  );
}
