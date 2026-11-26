/**
 * ArtifactButton - one REAL "Open preview / Open folder / Open file" button.
 *
 * Idle → pending (ring, `aria-busy`) → "Opened" (a short confirmation that clears itself)
 * or an inline error sentence under the button. The three label states are stacked in one
 * grid cell so the button never changes width while it works. The open itself is
 * openArtifact() - this only reflects what really happened.
 */

import type { MissionArtifact } from "@/orchestrator/missionThread";
import { effectiveKind } from "./openArtifact";
import { useArtifactOpen } from "./useArtifactOpen";

type Kind = ReturnType<typeof effectiveKind>;

function KindIcon({ kind }: { kind: Kind }) {
  const common = { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true } as const;
  const stroke = { stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  if (kind === "folder") {
    return (
      <svg {...common}>
        <path d="M2.5 5.2V4a1 1 0 0 1 1-1h2.6l1.4 1.6h5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5.2Z" {...stroke} />
      </svg>
    );
  }
  if (kind === "file") {
    return (
      <svg {...common}>
        <path d="M4 2.5h5.5l3 3V13a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" {...stroke} />
        <path d="M9.5 2.5v3h3" {...stroke} />
      </svg>
    );
  }
  // preview · url - a window with an arrow leaving it
  return (
    <svg {...common}>
      <path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" {...stroke} />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const DEFAULT_LABEL: Record<Kind, string> = {
  preview: "Open preview",
  url: "Open link",
  folder: "Open folder",
  file: "Open file",
};

export function ArtifactButton({ art, primary = false }: { art: MissionArtifact; primary?: boolean }) {
  const { state, run } = useArtifactOpen(art);
  const kind = effectiveKind(art);
  const label = art.label.trim() || DEFAULT_LABEL[kind];
  const pending = state.status === "pending";
  const opened = state.status === "opened";
  return (
    <div className="ms-art">
      <button
        type="button"
        className={`ms-open${primary ? " is-primary" : ""} is-${state.status}`}
        onClick={run}
        aria-busy={pending || undefined}
        title={art.target}
      >
        <span className="ms-open-ico" aria-hidden>
          {pending ? <i className="ms-spin" /> : opened ? <CheckIcon /> : <KindIcon kind={kind} />}
        </span>
        <span className="ms-open-labels">
          <span className={state.status === "idle" || state.status === "error" ? "on" : undefined}>{label}</span>
          <span className={pending ? "on" : undefined} aria-hidden>Opening…</span>
          <span className={opened ? "on" : undefined} aria-hidden>Opened</span>
        </span>
      </button>
      {state.status === "error" && (
        <p className="ms-open-err" role="alert">
          {state.message}
        </p>
      )}
      <span className="ms-sr" role="status" aria-live="polite">
        {pending ? `Opening ${label}` : opened ? `${label}: opened` : ""}
      </span>
    </div>
  );
}

/** The row of buttons under a result / failure card. The first web-facing one leads. */
export function ArtifactRow({ artifacts }: { artifacts: MissionArtifact[] }) {
  const lead = artifacts.findIndex((a) => {
    const k = effectiveKind(a);
    return k === "preview" || k === "url";
  });
  return (
    <div className="ms-arts">
      {artifacts.map((a, i) => (
        <ArtifactButton key={`${a.kind}:${a.target}:${i}`} art={a} primary={i === (lead === -1 ? 0 : lead)} />
      ))}
    </div>
  );
}
