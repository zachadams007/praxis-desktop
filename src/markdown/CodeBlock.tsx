/**
 * CodeBlock - a fenced code block: a thin header (language, Copy) over a horizontally
 * scrolling <pre>. The code is a React text child, so it is escaped: HTML inside a fence
 * is DISPLAYED, never interpreted.
 */

import { useEffect, useRef, useState } from "react";

interface CodeBlockProps {
  lang: string;
  code: string;
  /** Replaces the language label (e.g. "mermaid - drawing" while a diagram streams in). */
  label?: string;
}

export function CodeBlock({ lang, code, label }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      } catch {
        /* clipboard unavailable (denied, unfocused): the button simply doesn't confirm */
      }
    })();
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{label ?? (lang || "text")}</span>
        <button type="button" className="md-code-copy" onClick={copy} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={lang ? `language-${lang}` : undefined}>{code}</code>
      </pre>
    </div>
  );
}
