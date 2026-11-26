/**
 * mermaidRepair - the ONE automatic repair pass for a diagram that failed to parse.
 *
 * Models write Mermaid that is almost right. The failures are overwhelmingly the same few
 * things, and none of them change what the diagram MEANS:
 *   - a label with `(`, `)`, `[`, `{`, `"`, `;`, `%`, `<`, `>` or the word `end` in it,
 *     unquoted, which Mermaid reads as syntax: `A[Start (init)] --> B{Is "x" > 3?}`;
 *   - a label that wraps onto the next line;
 *   - `<br/>` and other HTML in a label;
 *   - smart quotes and long dashes pasted in where ASCII was needed (an arrow typed with an
 *     em dash instead of `-->`);
 *   - an edge label with punctuation: `-->|yes (ok)|`;
 *   - a few per-diagram habits (`;` in a sequence message, an unquoted pie slice name,
 *     a `List<T>` in a class diagram, an unquoted ER relationship label).
 *
 * The pass is deliberately conservative: it quotes and simplifies, it never invents or
 * deletes a node, an edge or a participant. If it can't improve the text it returns it
 * unchanged, and the caller shows the source instead. Pure and synchronous, so it is
 * unit-tested in node and checked against Mermaid's real parser in a browser
 * (scripts/test-mermaid-oracle.cjs).
 */

export type DiagramKind =
  | "flowchart"
  | "sequence"
  | "class"
  | "state"
  | "er"
  | "gantt"
  | "pie"
  | "journey"
  | "mindmap"
  | "timeline"
  | "git"
  | "other";

// -- Diagram kind -------------------------------------------------------------------

/** The first line that says what the diagram is, skipping blanks, comments, directives, front matter. */
function headerLine(source: string): string {
  const lines = source.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t && !t.startsWith("%%")) return t;
  }
  return "";
}

export function diagramKind(source: string): DiagramKind {
  const h = headerLine(source);
  if (/^(?:graph|flowchart)\b/i.test(h)) return "flowchart";
  if (/^sequenceDiagram\b/i.test(h)) return "sequence";
  if (/^classDiagram\b/i.test(h)) return "class";
  if (/^stateDiagram(?:-v2)?\b/i.test(h)) return "state";
  if (/^erDiagram\b/i.test(h)) return "er";
  if (/^gantt\b/i.test(h)) return "gantt";
  if (/^pie\b/i.test(h)) return "pie";
  if (/^journey\b/i.test(h)) return "journey";
  if (/^mindmap\b/i.test(h)) return "mindmap";
  if (/^timeline\b/i.test(h)) return "timeline";
  if (/^gitGraph\b/i.test(h)) return "git";
  return "other";
}

// -- Characters and HTML ------------------------------------------------------------

/** Control characters, zero-width and bidi marks: never meaningful in a diagram. */
const INVISIBLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠﻿]/g;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** HTML elements that are formatting only: dropped, their text kept. Others are shown literally. */
const FORMATTING_TAG_RE =
  /<\/?(?:b|i|u|s|em|strong|span|div|p|code|small|big|sub|sup|font|a|center|mark|abbr|kbd|tt)\b[^<>]*>/gi;

/** Smart punctuation -> ASCII, invisible characters out, non-breaking spaces -> spaces. */
function normalizeCharacters(text: string): string {
  return text
    .replace(INVISIBLE_RE, "")
    .replace(/[   ]/g, " ")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[–—]+>/g, "-->")
    .replace(/\t/g, "    ");
}

/**
 * The text of one label, made safe to sit inside double quotes:
 * entities decoded, `<br>` a space, formatting tags dropped, any other `<`/`>` escaped to
 * Mermaid's entity form, line breaks collapsed, and inner double quotes escaped.
 */
export function cleanLabel(raw: string): string {
  let t = raw.trim();
  // A label that arrives already quoted is unwrapped, then re-quoted by the caller.
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  t = decodeEntities(t)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(FORMATTING_TAG_RE, "")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/"/g, "#quot;")
    .trim();
  return t || " ";
}

// -- Flowchart ----------------------------------------------------------------------

interface ShapeDef {
  open: string;
  closers: string[];
}

/** Node shapes, longest opener first so `((` wins over `(`. */
const SHAPES: ShapeDef[] = [
  { open: "(((", closers: [")))"] },
  { open: "((", closers: ["))"] },
  { open: "([", closers: ["])"] },
  { open: "[(", closers: [")]"] },
  { open: "[[", closers: ["]]"] },
  { open: "[/", closers: ["/]", "\\]"] },
  { open: "[\\", closers: ["\\]", "/]"] },
  { open: "{{", closers: ["}}"] },
  { open: "[", closers: ["]"] },
  { open: "(", closers: [")"] },
  { open: "{", closers: ["}"] },
  { open: ">", closers: ["]"] },
];

/**
 * What may follow a node's closing bracket: the end of the statement, a separator, a class
 * marker, or the start of an edge. This is how a closer INSIDE a label (`A[arr[0] = 1]`) is
 * told apart from the real one.
 */
const BOUNDARY_RE = /^\s*(?:$|;|&|:::|[-=.~]{2,}|[-=]>|<[-=]|[ox][-=]{2}|\|)/;

/** The real closing bracket of a node whose label starts at `from`, or null. */
function findCloser(line: string, from: number, closers: string[]): { at: number; closer: string } | null {
  let last: { at: number; closer: string } | null = null;
  for (let k = from; k < line.length; k += 1) {
    for (const closer of closers) {
      if (!line.startsWith(closer, k)) continue;
      if (BOUNDARY_RE.test(line.slice(k + closer.length))) return { at: k, closer };
      last = { at: k, closer };
    }
  }
  return last;
}

interface ReadShape {
  open: string;
  label: string;
  close: string;
  end: number;
}

function readShape(line: string, pos: number): ReadShape | null {
  for (const shape of SHAPES) {
    if (!line.startsWith(shape.open, pos)) continue;
    const labelStart = pos + shape.open.length;
    const found = findCloser(line, labelStart, shape.closers);
    if (found) {
      return { open: shape.open, label: line.slice(labelStart, found.at), close: found.closer, end: found.at + found.closer.length };
    }
  }
  return null;
}

const ID_CHAR_RE = /[\p{L}\p{N}_]/u;

/** True when `text` ends in an edge operator (`-->`, `---`, `==>`, `-.->`, `--x` ...). */
function endsWithEdgeOperator(text: string): boolean {
  return /(?:[-=.~]{2,}[>ox]?|[-=.]>)\s*$/.test(text);
}

/** Statement keywords whose lines are not node/edge lines and must pass through untouched. */
const PASS_THROUGH_RE = /^\s*(?:%%|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b|accTitle\b|accDescr\b|title\b|end\s*$)/;

/** Quote every node label and edge label on one flowchart line. */
function quoteFlowchartLine(line: string): string {
  if (PASS_THROUGH_RE.test(line)) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "|" && endsWithEdgeOperator(out)) {
      const close = line.indexOf("|", i + 1);
      if (close !== -1) {
        out += `|"${cleanLabel(line.slice(i + 1, close))}"|`;
        i = close + 1;
        continue;
      }
    }
    if (ID_CHAR_RE.test(ch) && !(i > 0 && ID_CHAR_RE.test(line[i - 1]))) {
      let j = i + 1;
      while (j < line.length && ID_CHAR_RE.test(line[j])) j += 1;
      const id = line.slice(i, j);
      const shaped = readShape(line, j);
      if (shaped) {
        out += `${id}${shaped.open}"${cleanLabel(shaped.label)}"${shaped.close}`;
        i = shaped.end;
      } else {
        out += id;
        i = j;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** `subgraph My Title (x)` -> `subgraph sg1["My Title (x)"]`; `subgraph one [Title]` keeps its id. */
function repairSubgraph(line: string, counter: { n: number }): string | null {
  const m = /^(\s*)subgraph\s+(.+?)\s*$/i.exec(line);
  if (!m) return null;
  const [, indent, rest] = m;
  if (/^[\p{L}\p{N}_-]+$/u.test(rest)) return line;
  const withId = /^([\p{L}\p{N}_-]+)\s*\[(.*)\]$/u.exec(rest);
  if (withId) return `${indent}subgraph ${withId[1]}["${cleanLabel(withId[2])}"]`;
  counter.n += 1;
  return `${indent}subgraph sg${counter.n}["${cleanLabel(rest)}"]`;
}

/** Brackets opened and not yet closed on a line, ignoring anything inside double quotes. */
function openBrackets(line: string): number {
  let depth = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "[" || ch === "(" || ch === "{")) depth += 1;
    else if (!quoted && (ch === "]" || ch === ")" || ch === "}")) depth -= 1;
  }
  return quoted ? Math.max(depth, 1) : depth;
}

/** Fold a label that wraps onto following lines back into one line (bounded: 6 lines). */
function joinWrappedLabels(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    let joined = 0;
    while (!PASS_THROUGH_RE.test(line) && openBrackets(line) > 0 && i + 1 < lines.length && joined < 6) {
      i += 1;
      joined += 1;
      line = `${line} ${lines[i].trim()}`;
    }
    out.push(line);
  }
  return out;
}

function repairFlowchart(lines: string[]): string[] {
  const counter = { n: 0 };
  return joinWrappedLabels(lines).map((line) => {
    const subgraph = repairSubgraph(line, counter);
    return subgraph ?? quoteFlowchartLine(line);
  });
}

// -- Other diagram types ------------------------------------------------------------

function repairSequence(lines: string[]): string[] {
  return lines.map((line) => {
    // A message or note: `A->>B: text`, `Note over A,B: text`. `;` ends a statement in
    // Mermaid, so it must not appear in the text.
    const isMessage = /^\s*(?:Note\s+(?:over|left of|right of)\b|[^:]*?(?:-->>|->>|-->|->|--x|-x|--\)|-\)))/i.test(line);
    const colon = line.indexOf(":");
    if (!isMessage || colon === -1) return line;
    const text = line
      .slice(colon + 1)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(FORMATTING_TAG_RE, "")
      .replace(/;/g, ",");
    return `${line.slice(0, colon + 1)}${text}`;
  });
}

function repairPie(lines: string[]): string[] {
  return lines.map((line) => {
    if (/^\s*(?:pie\b|title\b|showData\b|%%)/i.test(line)) return line;
    const m = /^(\s*)"?([^":]+?)"?\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    return m ? `${m[1]}"${cleanLabel(m[2])}" : ${m[3]}` : line;
  });
}

function repairClass(lines: string[]): string[] {
  // `List<String>` is a generic: Mermaid writes it `List~String~`.
  return lines.map((line) => (/^\s*%%/.test(line) ? line : line.replace(/([\p{L}\p{N}_])<([^<>"]+)>/gu, "$1~$2~")));
}

function repairEr(lines: string[]): string[] {
  // `CUSTOMER ||--o{ ORDER : places order` -> the label must be one word or quoted.
  return lines.map((line) => {
    const m = /^(\s*)(\S+)(\s+[|}o{.-]+(?:--|\.\.)[|}o{.-]+\s+)(\S+)\s*:\s*(.+?)\s*$/.exec(line);
    return m ? `${m[1]}${m[2]}${m[3]}${m[4]} : "${cleanLabel(m[5])}"` : line;
  });
}

// -- Entry point --------------------------------------------------------------------

/** Remove a fence a model wrapped inside the fence (` ```mermaid ` twice). */
function unwrapNestedFence(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:`{3,}|~{3,})\s*(?:mermaid)?\s*$/i.test(line))
    .join("\n");
}

function repair(source: string): string {
  let text = normalizeCharacters(source.replace(/\r\n?/g, "\n"));
  text = unwrapNestedFence(text);
  let lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const kind = diagramKind(lines.join("\n"));

  // A flowchart with edges but no header line still parses once it has one.
  if (kind === "other" && lines.some((l) => /-->/.test(l)) && !lines.some((l) => /^\s*(?:graph|flowchart)\b/i.test(l))) {
    lines = ["flowchart TD", ...lines];
  }

  const effective = kind === "other" && lines[0] === "flowchart TD" ? "flowchart" : kind;
  switch (effective) {
    case "flowchart":
      lines = repairFlowchart(lines);
      break;
    case "sequence":
      lines = repairSequence(lines);
      break;
    case "pie":
      lines = repairPie(lines);
      break;
    case "class":
      lines = repairClass(lines);
      break;
    case "er":
      lines = repairEr(lines);
      break;
    default:
      // Mindmap, gantt, journey, timeline, state...: only the character-level cleanup above.
      break;
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The repaired diagram source. Returns `source` (trimmed) unchanged when there is nothing
 * to improve, and never throws: a repair that blows up is a repair that didn't happen.
 */
export function repairMermaid(source: string): string {
  try {
    return repair(source);
  } catch {
    return source.trim();
  }
}
