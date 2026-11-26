/**
 * LightText - Mission message text, rendered safely.
 *
 * lightMarkdown.ts parses to tokens; this maps them to React elements (so everything is
 * escaped - no HTML ever reaches the DOM). Links are BUTTONS, not anchors: clicking one
 * goes through the same real open path as an artifact button (desktop_open_url → the
 * browser the owner uses), with the same pending / confirmed / failed states, so a link in an
 * agent's output can never navigate the webview itself.
 */

import { useMemo } from "react";
import type { MissionArtifact } from "@/orchestrator/missionThread";
import { parseLight, type Inline } from "./lightMarkdown";
import { useArtifactOpen } from "./useArtifactOpen";

function LinkButton({ href, label }: { href: string; label: string }) {
  const art = useMemo<MissionArtifact>(() => ({ kind: "url", label, target: href }), [href, label]);
  const { state, run } = useArtifactOpen(art);
  return (
    <>
      <button
        type="button"
        className={`ms-link is-${state.status}`}
        onClick={run}
        title={href}
        aria-busy={state.status === "pending" || undefined}
      >
        {label}
      </button>
      {state.status === "error" && (
        <span className="ms-link-err" role="alert">
          {" "}
          {state.message}
        </span>
      )}
    </>
  );
}

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((x, i) => {
        switch (x.t) {
          case "bold":
            return <strong key={i}>{x.v}</strong>;
          case "code":
            return <code key={i}>{x.v}</code>;
          case "link":
            return <LinkButton key={i} href={x.href} label={x.label} />;
          default:
            return <span key={i}>{x.v}</span>;
        }
      })}
    </>
  );
}

export function LightText({ text, className = "" }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseLight(text), [text]);
  return (
    <div className={`ms-text ${className}`.trim()}>
      {blocks.map((b, i) => {
        if (b.t === "ul" || b.t === "ol") {
          const items = b.items.map((it, j) => (
            <li key={j}>
              <Inlines items={it} />
            </li>
          ));
          return b.t === "ol" ? (
            <ol key={i} start={b.start}>
              {items}
            </ol>
          ) : (
            <ul key={i}>{items}</ul>
          );
        }
        return (
          <p key={i} className={b.t === "h" ? "ms-h" : undefined}>
            <Inlines items={b.inline} />
          </p>
        );
      })}
    </div>
  );
}
