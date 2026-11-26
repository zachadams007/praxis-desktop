/**
 * MermaidBlock - a ```mermaid fence, drawn.
 *
 * The three things a reader can see, and only these:
 *   - the diagram (a card: kind label, the SVG, a "Source" toggle);
 *   - a quiet placeholder while Mermaid loads and lays it out;
 *   - if it could not be rendered even after the automatic repair pass, the code block
 *     with a calm one-line note. Never an error message, never Mermaid's error graphic.
 */

import { useContext, useEffect, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { MarkdownContext } from "./MarkdownContext";
import { peekDiagram, renderDiagramCached, type DiagramResult } from "./mermaidRender";
import { diagramKind, type DiagramKind } from "./mermaidRepair";

const KIND_LABEL: Record<DiagramKind, string> = {
  flowchart: "Flowchart",
  sequence: "Sequence",
  class: "Class diagram",
  state: "State diagram",
  er: "ER diagram",
  gantt: "Gantt",
  pie: "Pie chart",
  journey: "Journey",
  mindmap: "Mind map",
  timeline: "Timeline",
  git: "Git graph",
  other: "Diagram",
};

/** The words shown when a diagram can't be drawn. Calm, one line, no jargon, no stack. */
export const DIAGRAM_FAILED_NOTE = "Diagram couldn't render. Here is its source instead.";

export function DiagramFallback({ code }: { code: string }) {
  return (
    <div className="md-diagram md-diagram--failed">
      <p className="md-diagram-note" role="note">
        {DIAGRAM_FAILED_NOTE}
      </p>
      <CodeBlock lang="mermaid" code={code} />
    </div>
  );
}

export function DiagramLoading() {
  return (
    <div className="md-diagram md-diagram--loading" aria-busy="true" role="status">
      <span className="md-diagram-pulse" aria-hidden />
      <span>Drawing diagram</span>
    </div>
  );
}

interface DiagramCardProps {
  code: string;
  result: Extract<DiagramResult, { kind: "svg" }>;
  showSource: boolean;
  onToggleSource: () => void;
}

export function DiagramCard({ code, result, showSource, onToggleSource }: DiagramCardProps) {
  const label = KIND_LABEL[result.diagram];
  return (
    <figure className="md-diagram" data-diagram={result.diagram}>
      <figcaption className="md-diagram-head">
        <span className="md-diagram-kind">{label}</span>
        {result.repaired && (
          <span className="md-diagram-tag" title="The diagram needed a few labels simplified to render.">
            simplified
          </span>
        )}
        <button type="button" className="md-diagram-toggle" onClick={onToggleSource} aria-expanded={showSource}>
          {showSource ? "Hide source" : "Source"}
        </button>
      </figcaption>
      {/* Mermaid's own output, rendered with securityLevel "strict" and hardened again in
          mermaidRender.hardenSvg (no scripts, no event handlers, no javascript: URLs). */}
      <div
        className="md-diagram-body"
        role="img"
        aria-label={`${label}`}
        style={result.width ? ({ "--md-diagram-w": `${result.width}px` } as React.CSSProperties) : undefined}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
      {showSource && <CodeBlock lang="mermaid" code={code} />}
    </figure>
  );
}

type View = { state: "loading" } | { state: "done"; result: DiagramResult };

export function MermaidBlock({ code }: { code: string }) {
  const { variant } = useContext(MarkdownContext);
  const [view, setView] = useState<View>(() => {
    const hit = peekDiagram(code, variant);
    return hit ? { state: "done", result: hit } : { state: "loading" };
  });
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let alive = true;
    const hit = peekDiagram(code, variant);
    if (hit) {
      setView({ state: "done", result: hit });
      return undefined;
    }
    setView({ state: "loading" });
    renderDiagramCached(code, variant).then(
      (result) => {
        if (alive) setView({ state: "done", result });
      },
      () => {
        // renderDiagram never rejects by contract; if it ever does, show the source.
        if (alive) setView({ state: "done", result: { kind: "failed", diagram: diagramKind(code) } });
      },
    );
    return () => {
      alive = false;
    };
  }, [code, variant]);

  if (view.state === "loading") return <DiagramLoading />;
  if (view.result.kind === "failed") return <DiagramFallback code={code} />;
  return <DiagramCard code={code} result={view.result} showSource={showSource} onToggleSource={() => setShowSource((v) => !v)} />;
}
