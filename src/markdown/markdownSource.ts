/**
 * markdownSource - text-level preparation for the markdown renderer: pure, no React.
 *
 * Streaming is the reason this exists. While an answer arrives token by token the text is
 * often mid-construct - most visibly a ```mermaid fence that hasn't closed yet. Handing that
 * to the diagram renderer fails on every partial chunk and then flickers when it finally
 * parses, so an unfinished diagram is shown as a quiet code block until its closing fence
 * lands.
 */

/** A runaway dump must not freeze the panel. Longer text is cut with an ellipsis. */
export const MAX_MARKDOWN_CHARS = 40_000;

/** The code-block language an unfinished ```mermaid fence is rewritten to while streaming. */
export const PENDING_MERMAID_LANG = "mermaid-pending";

interface OpenFence {
  index: number;
  info: string;
}

/** The fence still open at the end of `text` (CommonMark: a fence runs to the end if unclosed). */
export function openFenceAtEnd(text: string): OpenFence | null {
  const lines = text.split("\n");
  let open: { index: number; ch: string; len: number; info: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!open) {
      // A backtick fence's info string can't itself contain a backtick.
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/.exec(line);
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        open = { index: i, ch: m[1][0], len: m[1].length, info: m[2].trim() };
      }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) open = null;
    }
  }
  return open ? { index: open.index, info: open.info } : null;
}

/** True when `text` ends inside a fenced block that has not been closed. */
export function hasUnclosedFence(text: string): boolean {
  return openFenceAtEnd(text) !== null;
}

/**
 * While streaming: an unclosed ```mermaid fence becomes ```mermaid-pending, which the
 * renderer shows as plain code (labelled "drawing") instead of attempting a diagram.
 */
export function deferUnclosedMermaid(text: string): string {
  const open = openFenceAtEnd(text);
  if (!open || !/^mermaid\b/i.test(open.info)) return text;
  const lines = text.split("\n");
  lines[open.index] = lines[open.index].replace(/mermaid/i, PENDING_MERMAID_LANG);
  return lines.join("\n");
}

/** Normalise newlines, bound the length, and (while streaming) defer an unfinished diagram. */
export function prepareMarkdown(input: unknown, streaming = false): string {
  let text = typeof input === "string" ? input : input == null ? "" : String(input);
  text = text.replace(/\r\n?/g, "\n");
  if (text.length > MAX_MARKDOWN_CHARS) {
    let cut = text.slice(0, MAX_MARKDOWN_CHARS);
    // Never end on half of a surrogate pair.
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    text = `${cut}\n\n…`;
  }
  return streaming ? deferUnclosedMermaid(text) : text;
}
