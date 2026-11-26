/**
 * lightMarkdown - the tiny, SAFE renderer behind every Mission message.
 *
 * Mission text is "plain text with light markdown (bold, bullets, inline code)", and a
 * lot of it is raw agent output, so this never builds HTML: it parses to a small token
 * tree that React turns into elements (React escapes everything). Supported:
 *
 *   **bold** / __bold__ · `inline code` · - bullets / • bullets / 1. numbered ·
 *   # headings (rendered as a bold line) · [label](url) and bare http(s):// URLs
 *   (links become BUTTONS, see LightText - never anchors, so nothing navigates the webview).
 *
 * Only http and https links survive; any other scheme - file://, javascript:, anything -
 * degrades to plain text. Agent output is untrusted, and a file:// link handed to the shell
 * could launch a program; local things open through a result's structured artifacts instead.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; label: string; href: string };

export type Block =
  | { t: "p"; inline: Inline[] }
  | { t: "h"; inline: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] };

/** Parsing is bounded: a runaway agent dump must not freeze the panel. */
export const MAX_RENDER_CHARS = 20_000;

const INLINE_RE =
  /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+?)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"'`]+)/g;

function safeHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

/** Inline tokens for one run of text (may contain newlines). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev && prev.t === "text") prev.v += v;
    else out.push({ t: "text", v });
  };
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(src)) !== null) {
    pushText(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: "bold", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "bold", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "code", v: m[3] });
    else if (m[4] !== undefined) {
      if (safeHref(m[5])) out.push({ t: "link", label: m[4], href: m[5].trim() });
      else pushText(`${m[4]} (${m[5]})`);
    } else if (m[6] !== undefined) {
      // a bare URL: sentence punctuation (and an unbalanced ")") is not part of it
      let url = m[6];
      let tail = "";
      const trim = url.match(/[.,;:!?)\]}]+$/);
      if (trim) {
        tail = trim[0];
        url = url.slice(0, url.length - tail.length);
      }
      if (url) out.push({ t: "link", label: url, href: url });
      pushText(tail);
    }
  }
  pushText(src.slice(last));
  return out;
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBERED_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;

// Terminal colour / cursor sequences (CSI) and operating-system commands (OSC), then any
// remaining control character except tab and newline - raw agent output carries all of these.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Plain text fit to show: no terminal escape sequences, no stray control characters. */
export function stripControl(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\r(?!\n)/g, "\n").replace(CONTROL_RE, "");
}

/** Parse a message into blocks. Never throws; unknown shapes become paragraphs. */
export function parseLight(source: string): Block[] {
  let src = stripControl(source || "");
  if (src.length > MAX_RENDER_CHARS) src = `${src.slice(0, MAX_RENDER_CHARS)}…`;
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", inline: parseInline(para.join("\n")) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map(parseInline);
      blocks.push(list.ordered ? { t: "ol", start: list.start, items } : { t: "ul", items });
    }
    list = null;
  };

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ t: "h", inline: parseInline(heading[1]) });
      continue;
    }
    const bullet = line.match(BULLET_RE);
    const numbered = bullet ? null : line.match(NUMBERED_RE);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList(); // bullets then numbers (or back) are two lists
      if (!list) list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(bullet ? bullet[1] : numbered![2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // an indented continuation of the previous item
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
