/**
 * Markdown - how Atlas's words are drawn.
 *
 * Atlas answers in markdown (headings, lists, emphasis, code, tables, links, and Mermaid
 * diagrams) and a web search answers with numbered sources. This renders that, safely:
 *
 *   - NO raw HTML. remarkSafeHtml removes `<script>`-style elements with their contents and
 *     drops every other tag, keeping tag-shaped words like `<Enter>` as text; rehype-sanitize
 *     (markdownSchema.ts) is the second wall. Images are not rendered at all.
 *   - Links are buttons that open through Praxis's own open-URL path in the system browser,
 *     never inside the webview (MdLink). Only absolute http(s) links are links.
 *   - A ```mermaid fence becomes a diagram (lazy-loaded Mermaid, strict security level, the
 *     Praxis dark theme, one automatic repair pass, a calm fallback): MermaidBlock.
 *   - Streaming: pass `streaming` while text is still arriving and re-parses are throttled
 *     (throttle.ts), and a half-written diagram fence stays plain code until it closes.
 *
 * Styling is markdown.css, themed by variant: "atlas" (the main window's tokens) or
 * "galaxy" (the Memory Galaxy's), so the same message looks native on either surface.
 */

import "./markdown.css";
import { Children, isValidElement, memo, useMemo, type ComponentProps, type CSSProperties, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { MarkdownContext } from "./MarkdownContext";
import { MdLink } from "./MdLink";
import { MermaidBlock } from "./MermaidBlock";
import { MARKDOWN_SCHEMA } from "./markdownSchema";
import { PENDING_MERMAID_LANG, prepareMarkdown } from "./markdownSource";
import type { DiagramVariant } from "./mermaidTheme";
import { textOf } from "./nodeText";
import { remarkSafeHtml } from "./remarkSafeHtml";
import { safeHttpUrl } from "./safeUrl";
import { useThrottledText } from "./throttle";

type Plugins = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;

// Module-level so the plugin lists keep one identity across renders.
// `singleTilde: false`: "~5 minutes" must stay as typed, not become strikethrough.
const REMARK_PLUGINS: Plugins = [remarkSafeHtml, [remarkGfm, { singleTilde: false }]];
const REHYPE_PLUGINS: Plugins = [[rehypeSanitize, MARKDOWN_SCHEMA]];

/** A fenced block: a diagram, a quiet pending diagram, or plain code. */
function FencedBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(
    (child): child is ReactElement<{ className?: string; children?: ReactNode }> => isValidElement(child),
  );
  const lang = /language-([\w+#.-]+)/.exec(code?.props.className ?? "")?.[1] ?? "";
  const text = textOf(code?.props.children ?? children).replace(/\n$/, "");
  if (lang.toLowerCase() === "mermaid") return <MermaidBlock code={text} />;
  if (lang === PENDING_MERMAID_LANG) return <CodeBlock lang="mermaid" label="mermaid - drawing" code={text} />;
  return <CodeBlock lang={lang} code={text} />;
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = safeHttpUrl(href);
    return safe ? <MdLink href={safe}>{children}</MdLink> : <span>{children}</span>;
  },
  pre: ({ children }) => <FencedBlock>{children}</FencedBlock>,
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  // Text-first: no image is ever fetched into a chat bubble.
  img: () => null,
};

export interface MarkdownProps {
  text: string;
  /** Text is still arriving: throttle re-parses and hold an unfinished diagram as code. */
  streaming?: boolean;
  /** Which surface this is on. Default "atlas" (the main window). */
  variant?: DiagramVariant;
  /** Accent override, e.g. the open agent's tint in the Cockpit. */
  accent?: string;
  className?: string;
}

function MarkdownImpl({ text, streaming = false, variant = "atlas", accent, className }: MarkdownProps) {
  const shown = useThrottledText(typeof text === "string" ? text : String(text ?? ""), streaming);
  const source = useMemo(() => prepareMarkdown(shown, streaming), [shown, streaming]);
  const context = useMemo(() => ({ variant }), [variant]);
  const style = accent ? ({ "--md-accent": accent } as CSSProperties) : undefined;
  return (
    <MarkdownContext.Provider value={context}>
      <div className={["md", `md--${variant}`, className].filter(Boolean).join(" ")} style={style}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={COMPONENTS}
          skipHtml
          urlTransform={(url) => safeHttpUrl(url) ?? ""}
        >
          {source}
        </ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  );
}

/** Memoised: a message's markdown is parsed once, not on every panel re-render. */
export const Markdown = memo(MarkdownImpl);
