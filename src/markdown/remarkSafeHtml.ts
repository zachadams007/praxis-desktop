/**
 * remarkSafeHtml - no raw HTML ever reaches the page, but plain text that merely LOOKS
 * like a tag survives.
 *
 * Why a plugin and not react-markdown's `skipHtml`: `skipHtml` deletes every raw-HTML node,
 * and CommonMark calls `Press <Enter> to continue` raw HTML, so an ordinary spoken answer
 * about keys would lose a word. Working on the mdast tree knows exactly what is raw HTML
 * (and what is code, which is never touched), so:
 *
 *   - `<script>`, `<style>`, `<iframe>`, ... are removed WITH their contents, inline or as a
 *     block. An unclosed one removes everything after it in that paragraph.
 *   - Comments, declarations and processing instructions are removed.
 *   - `<br>` becomes a real line break (models use it in table cells and lists).
 *   - Any other known HTML tag (`<b>`, `<div>`, `<span>` ...) is dropped and its text stays.
 *   - A tag-shaped word that is NOT an HTML element (`<Enter>`, `<your-name>`) becomes
 *     literal text, so it reads as typed.
 *
 * Whatever gets past this still meets rehype-sanitize (markdownSchema.ts).
 */

/** The slice of an mdast node this cares about. Local on purpose: no transitive type deps. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** Elements whose CONTENT is as unsafe as the tag: never keep the text between them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "textarea",
  "svg", "math", "head", "title", "applet", "frame", "frameset", "xmp", "plaintext",
]);

/** Real HTML element names. A tag outside this list is text that happens to have angle brackets. */
const KNOWN_HTML = new Set([
  ...DROP_WITH_CONTENT,
  "a", "abbr", "acronym", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo",
  "big", "blink", "blockquote", "body", "br", "button", "canvas", "caption", "center", "cite", "code",
  "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "dialog", "dir", "div", "dl",
  "dt", "em", "fieldset", "figcaption", "figure", "font", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hgroup", "hr", "html", "i", "img", "input", "ins", "kbd", "label", "legend",
  "li", "link", "main", "map", "mark", "marquee", "menu", "meta", "meter", "nav", "ol", "optgroup",
  "option", "output", "p", "param", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp",
  "search", "section", "select", "slot", "small", "source", "span", "strike", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "track", "tt", "u",
  "ul", "var", "video", "wbr",
]);

/** Parents whose children are block-level (an html node here is a block, not a word). */
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

interface TagInfo {
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

/** The first tag in `html`, or null when it starts with a comment/declaration/PI or has none. */
function firstTag(html: string): TagInfo | null {
  const m = /<\s*(\/)?\s*([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/)?\s*>/.exec(html);
  if (!m) return null;
  return { name: m[2].toLowerCase(), closing: Boolean(m[1]), selfClosing: Boolean(m[3]) };
}

/** `<!-- ... -->`, `<!DOCTYPE>`, `<![CDATA[`, `<?php ... ?>`: never content. */
function isNonElement(html: string): boolean {
  return /^\s*<(?:!|\?)/.test(html);
}

function stripAllTags(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[A-Za-z][^>]*>/g, "");
}

function clean(parent: MdNode): void {
  const kids = parent.children;
  if (!kids) return;
  const flow = FLOW_PARENTS.has(parent.type);
  const out: MdNode[] = [];
  /** Set after an inline `<script>`-like opener: drop everything up to its closer. */
  let skipUntil: string | null = null;

  for (const node of kids) {
    if (skipUntil) {
      if (node.type === "html") {
        const tag = firstTag(node.value ?? "");
        if (tag && tag.closing && tag.name === skipUntil) skipUntil = null;
      }
      continue;
    }
    if (node.type !== "html") {
      clean(node);
      out.push(node);
      continue;
    }

    const value = node.value ?? "";
    if (isNonElement(value)) continue;
    const tag = firstTag(value);

    if (flow) {
      // A block of raw HTML: unsafe elements go whole, a pseudo-tag stays as typed text,
      // anything else keeps its words without the markup.
      if (!tag || DROP_WITH_CONTENT.has(tag.name)) continue;
      const text = KNOWN_HTML.has(tag.name) ? stripAllTags(value).trim() : value.trim();
      if (text) out.push({ type: "paragraph", children: [{ type: "text", value: text }] });
      continue;
    }

    // Inline raw HTML: one tag per node.
    if (!tag) {
      out.push({ type: "text", value });
    } else if (DROP_WITH_CONTENT.has(tag.name)) {
      if (!tag.closing && !tag.selfClosing) skipUntil = tag.name;
    } else if (tag.name === "br") {
      out.push({ type: "break" });
    } else if (!KNOWN_HTML.has(tag.name)) {
      out.push({ type: "text", value });
    }
    // else: a known inline tag (<b>, </span> ...): dropped, the text around it stays.
  }
  parent.children = out;
}

/**
 * The unified plugin. Typed `(tree: unknown)` so it slots into react-markdown's
 * `remarkPlugins` without importing mdast's types (they arrive only transitively).
 */
export function remarkSafeHtml(): (tree: unknown) => void {
  return (tree) => clean(tree as MdNode);
}
