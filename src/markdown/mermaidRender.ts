/**
 * mermaidRender - turn a ```mermaid block into an SVG, or say honestly that it can't.
 *
 * The contract, in order:
 *   1. Mermaid is a dynamic import: nothing about it is in the main bundle, and it isn't
 *      fetched until the first diagram actually appears.
 *   2. It runs with `securityLevel: "strict"` and the Praxis dark theme (mermaidTheme.ts).
 *   3. The text is parsed first. If it doesn't parse, ONE repair pass runs
 *      (mermaidRepair.ts: quote labels, strip unsupported characters and HTML, collapse
 *      newlines in labels) and the result is tried once more.
 *   4. Still no? The caller shows the original code with a calm note. Never a stack trace,
 *      never Mermaid's own "Syntax error in text" bomb: `suppressErrorRendering` is on and
 *      any leftover element Mermaid parked in the document is removed.
 *
 * Everything that can fail is caught here. In particular this function NEVER rejects: the
 * Memory Galaxy window replaces its whole UI with an error screen on an unhandled promise
 * rejection (knowledge.html), so a diagram problem must not be able to reach that handler.
 */

import { diagramKind, repairMermaid, type DiagramKind } from "./mermaidRepair";
import { DIAGRAM_FONT, mermaidThemeVariables, readPalette, type DiagramVariant } from "./mermaidTheme";

export type DiagramResult =
  | {
      kind: "svg";
      svg: string;
      /** The diagram's natural width in px (from its viewBox), for responsive sizing. */
      width: number | null;
      /** True when the repair pass changed the text and THAT is what rendered. */
      repaired: boolean;
      diagram: DiagramKind;
    }
  | { kind: "failed"; diagram: DiagramKind };

/** The slice of Mermaid's API this uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string, options: { suppressErrors: boolean }): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** Everything with a side effect, injected so the retry logic is tested without a browser. */
export interface RenderDeps {
  load(variant: DiagramVariant): Promise<MermaidApi>;
  nextId(): string;
  /** Remove anything Mermaid left in the document for this render id. */
  cleanup(id: string): void;
}

/** One diagram is not worth waiting on forever. */
const RENDER_TIMEOUT_MS = 12_000;

// -- Pure helpers -------------------------------------------------------------------

/** The diagram's natural width from the SVG's viewBox, or null. */
export function svgViewBoxWidth(svg: string): number | null {
  const m = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+\s*"/i.exec(svg);
  const width = m ? Number(m[1]) : NaN;
  return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
}

/**
 * Belt and braces on top of Mermaid's own strict-mode sanitising: no script elements, no
 * event-handler attributes, no `javascript:` URLs in what we put into the page.
 */
export function hardenSvg(svg: string): string {
  return svg
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href\s*=\s*["']?)\s*javascript:[^"'>\s]*/gi, "$1#");
}

/** Strip a byte-order mark and surrounding whitespace; the text Mermaid is first handed. */
export function normalizeDiagramSource(code: string): string {
  return code.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("diagram render timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// -- The retry logic ----------------------------------------------------------------

type Attempt = { ok: true; svg: string } | { ok: false };

async function attempt(text: string, variant: DiagramVariant, deps: RenderDeps): Promise<Attempt> {
  const id = deps.nextId();
  try {
    const api = await deps.load(variant);
    // `suppressErrors` returns false for an invalid diagram instead of throwing (and
    // instead of drawing Mermaid's error graphic).
    const parsed = await api.parse(text, { suppressErrors: true });
    if (parsed === false) return { ok: false };
    const out = await withTimeout(api.render(id, text), RENDER_TIMEOUT_MS);
    if (!out || typeof out.svg !== "string" || !out.svg.includes("<svg")) return { ok: false };
    return { ok: true, svg: hardenSvg(out.svg) };
  } catch {
    return { ok: false };
  } finally {
    try {
      deps.cleanup(id);
    } catch {
      /* a cleanup that can't run is not worth reporting */
    }
  }
}

/**
 * Render one diagram. Tries the text as written; if that fails, ONE repaired version
 * (only when the repair actually changed something); otherwise reports failure so the
 * caller can show the source. Never rejects.
 */
export async function renderDiagram(
  code: string,
  variant: DiagramVariant = "atlas",
  deps: RenderDeps = defaultDeps,
): Promise<DiagramResult> {
  const original = normalizeDiagramSource(code);
  const diagram = diagramKind(original);
  if (!original) return { kind: "failed", diagram };

  const first = await attempt(original, variant, deps);
  if (first.ok) return { kind: "svg", svg: first.svg, width: svgViewBoxWidth(first.svg), repaired: false, diagram };

  const repaired = repairMermaid(original);
  if (repaired && repaired !== original) {
    const second = await attempt(repaired, variant, deps);
    if (second.ok) return { kind: "svg", svg: second.svg, width: svgViewBoxWidth(second.svg), repaired: true, diagram };
  }
  return { kind: "failed", diagram };
}

// -- Result cache -------------------------------------------------------------------
//
// The Atlas panel unmounts when it closes and re-mounts when it opens, and a long
// conversation can scroll a diagram out and back. Without a cache every one of those
// re-runs Mermaid (and flashes the placeholder). Keyed by surface + palette + source, so a
// theme change draws a fresh diagram instead of a stale one.

const MAX_CACHED_DIAGRAMS = 48;
const settled = new Map<string, DiagramResult>();
const inflight = new Map<string, Promise<DiagramResult>>();

function cacheKey(code: string, variant: DiagramVariant): string {
  return `${variant}|${JSON.stringify(readPalette(variant))}|${normalizeDiagramSource(code)}`;
}

/** An already-rendered diagram, or null. Lets a component start in its final state. */
export function peekDiagram(code: string, variant: DiagramVariant): DiagramResult | null {
  return settled.get(cacheKey(code, variant)) ?? null;
}

/** `renderDiagram`, remembered: the same source on the same surface renders once. */
export function renderDiagramCached(code: string, variant: DiagramVariant = "atlas"): Promise<DiagramResult> {
  const key = cacheKey(code, variant);
  const hit = settled.get(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const job = renderDiagram(code, variant).then((result) => {
    inflight.delete(key);
    settled.set(key, result);
    if (settled.size > MAX_CACHED_DIAGRAMS) {
      const oldest = settled.keys().next().value;
      if (oldest !== undefined) settled.delete(oldest);
    }
    return result;
  });
  inflight.set(key, job);
  return job;
}

// -- The real Mermaid ---------------------------------------------------------------

let mermaidLoad: Promise<MermaidApi> | null = null;
let configuredFor = "";
let renderSeq = 0;

function mermaidConfig(variant: DiagramVariant): Record<string, unknown> {
  const palette = readPalette(variant);
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: mermaidThemeVariables(palette),
    fontFamily: DIAGRAM_FONT,
    // Text labels, not HTML in <foreignObject>: smaller, themeable, nothing to sanitise.
    htmlLabels: false,
    // A failed diagram is handled by us; Mermaid must not paint its own error graphic.
    suppressErrorRendering: true,
    logLevel: 5,
    flowchart: { htmlLabels: false, useMaxWidth: false, curve: "basis", padding: 12, nodeSpacing: 38, rankSpacing: 44 },
    sequence: { useMaxWidth: false, wrap: true, width: 150 },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    pie: { useMaxWidth: false },
    journey: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
  };
}

const defaultDeps: RenderDeps = {
  load: async (variant) => {
    if (!mermaidLoad) {
      // The dynamic import is the whole point: Mermaid (and its per-diagram chunks) is
      // fetched here, the first time a diagram appears, and never before.
      mermaidLoad = import("mermaid").then((m) => m.default as unknown as MermaidApi);
      mermaidLoad.catch(() => {
        // A failed fetch must not be cached forever: the next diagram tries again.
        mermaidLoad = null;
      });
    }
    const api = await mermaidLoad;
    // The faces are vendored with font-display: swap; Mermaid measures text as it lays out,
    // so wait (briefly) for the diagram font rather than size boxes for a fallback face.
    try {
      await Promise.race([document.fonts.load('13px "IBM Plex Mono"'), new Promise((resolve) => setTimeout(resolve, 1500))]);
    } catch {
      /* no FontFaceSet: render with what is there */
    }
    const config = mermaidConfig(variant);
    const key = `${variant}:${JSON.stringify(config.themeVariables)}`;
    if (key !== configuredFor) {
      api.initialize(config);
      configuredFor = key;
    }
    return api;
  },
  nextId: () => {
    renderSeq += 1;
    return `md-mmd-${renderSeq}`;
  },
  cleanup: (id) => {
    // Mermaid parks a scratch element (`d<id>`) in <body> while it measures; a render that
    // throws can leave it behind.
    for (const stray of [`d${id}`, id]) document.getElementById(stray)?.remove();
  },
};
