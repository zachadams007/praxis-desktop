/**
 * mermaidTheme - the Praxis dark look, expressed as Mermaid theme variables.
 *
 * Mermaid cannot take `var(--x)`: it computes lighter/darker shades of every colour you
 * give it, so it needs real colour strings. The palette is therefore READ from the live CSS
 * custom properties at render time (the theme can change; ThemeApplier mirrors the active
 * palette onto :root), with the shipped defaults as fallbacks for a window that doesn't
 * define them. The Memory Galaxy window has its own token set (`--p-*` on `.mg-root`), so
 * the diagram look follows whichever surface the message is on.
 */

import { DEFAULT_AREA_HUES } from "@/theme/tokens";

/** Which surface a message is rendered on: the main window's Atlas panel, or the Memory Galaxy. */
export type DiagramVariant = "atlas" | "galaxy";

export interface DiagramPalette {
  bg: string;
  text: string;
  dim: string;
  accent: string;
  warm: string;
  hot: string;
}

/** The shipped Praxis palette (base.css :root). */
const ATLAS_DEFAULTS: DiagramPalette = {
  bg: "#04060a",
  text: "#eaf6ff",
  dim: "#92a8bd",
  accent: "#34f0db",
  warm: "#5c9bf0",
  hot: "#ff3b30",
};

/** The Memory Galaxy palette (galaxy.css `.mg-root`). */
const GALAXY_DEFAULTS: DiagramPalette = {
  bg: "#05060b",
  text: "#e9eef7",
  dim: "#8b95ab",
  accent: "#6c8cff",
  warm: "#8b7bff",
  hot: "#ff2d2d",
};

export const DIAGRAM_FONT = '"IBM Plex Mono", ui-monospace, "Cascadia Mono", monospace';

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` -> channels. Anything else is null. */
export function parseColor(css: string): Rgb | null {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)) as Rgb;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as Rgb;
  const f = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (f) return [Number(f[1]), Number(f[2]), Number(f[3])].map((n) => Math.max(0, Math.min(255, Math.round(n)))) as Rgb;
  return null;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** `t` of the way from `a` to `b` (0 = a, 1 = b), as a hex colour. An unparseable input yields `a`. */
export function mixColors(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return ca ? toHex(ca) : a;
  return toHex(ca.map((v, i) => Math.round(v + (cb[i] - v) * t)) as Rgb);
}

/** The live palette for a surface; every token that isn't a parseable colour falls back to the default. */
export function readPalette(variant: DiagramVariant, doc: Document | undefined = typeof document === "undefined" ? undefined : document): DiagramPalette {
  const defaults = variant === "galaxy" ? GALAXY_DEFAULTS : ATLAS_DEFAULTS;
  if (!doc) return defaults;
  try {
    const host = (variant === "galaxy" ? doc.querySelector(".mg-root") : null) ?? doc.documentElement;
    const style = doc.defaultView?.getComputedStyle(host);
    if (!style) return defaults;
    const read = (name: string, fallback: string) => {
      const value = style.getPropertyValue(name).trim();
      return value && parseColor(value) ? toHex(parseColor(value)!) : fallback;
    };
    return variant === "galaxy"
      ? {
          bg: read("--p-bg", defaults.bg),
          text: read("--p-text", defaults.text),
          dim: read("--p-dim", defaults.dim),
          accent: read("--p-blue", defaults.accent),
          warm: defaults.warm,
          hot: read("--p-accent", defaults.hot),
        }
      : {
          bg: read("--bg", defaults.bg),
          text: read("--text", defaults.text),
          dim: read("--text-dim", defaults.dim),
          accent: read("--base-cool", defaults.accent),
          warm: read("--base-warm", defaults.warm),
          hot: read("--accent-hot", defaults.hot),
        };
  } catch {
    return defaults;
  }
}

/** Twelve distinguishable slice colours: the accent, the per-area hues, then softened repeats. */
function sliceColors(p: DiagramPalette): string[] {
  const base = [p.accent, ...Object.values(DEFAULT_AREA_HUES), p.warm, p.hot];
  const out = base.slice(0, 12);
  while (out.length < 12) out.push(mixColors(base[out.length % base.length], p.text, 0.35));
  return out;
}

/** Mermaid `themeVariables` (theme "base") for a palette. */
export function mermaidThemeVariables(p: DiagramPalette): Record<string, string | boolean> {
  const surface = mixColors(p.bg, p.accent, 0.13);
  const surfaceBorder = mixColors(p.bg, p.accent, 0.6);
  const second = mixColors(p.bg, p.warm, 0.15);
  const secondBorder = mixColors(p.bg, p.warm, 0.58);
  const third = mixColors(p.bg, p.text, 0.06);
  const thirdBorder = mixColors(p.bg, p.text, 0.28);
  const line = mixColors(p.dim, p.accent, 0.38);
  const slices = sliceColors(p);
  const vars: Record<string, string | boolean> = {
    darkMode: true,
    background: p.bg,
    fontFamily: DIAGRAM_FONT,
    fontSize: "13px",
    textColor: p.text,
    titleColor: p.text,
    lineColor: line,
    primaryColor: surface,
    primaryTextColor: p.text,
    primaryBorderColor: surfaceBorder,
    secondaryColor: second,
    secondaryTextColor: p.text,
    secondaryBorderColor: secondBorder,
    tertiaryColor: third,
    tertiaryTextColor: p.text,
    tertiaryBorderColor: thirdBorder,
    mainBkg: surface,
    nodeBorder: surfaceBorder,
    nodeTextColor: p.text,
    clusterBkg: mixColors(p.bg, p.text, 0.035),
    clusterBorder: mixColors(p.bg, p.text, 0.22),
    edgeLabelBackground: p.bg,
    noteBkgColor: second,
    noteTextColor: p.text,
    noteBorderColor: secondBorder,
    // sequence
    actorBkg: surface,
    actorBorder: surfaceBorder,
    actorTextColor: p.text,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: p.text,
    labelBoxBkgColor: third,
    labelBoxBorderColor: thirdBorder,
    labelTextColor: p.text,
    loopTextColor: p.text,
    activationBkgColor: second,
    activationBorderColor: secondBorder,
    sequenceNumberColor: p.bg,
    // state / class
    classText: p.text,
    // gantt
    gridColor: mixColors(p.bg, p.text, 0.14),
    todayLineColor: p.hot,
    taskBkgColor: surface,
    taskBorderColor: surfaceBorder,
    taskTextColor: p.text,
    taskTextLightColor: p.text,
    taskTextDarkColor: p.bg,
    activeTaskBkgColor: second,
    activeTaskBorderColor: secondBorder,
    doneTaskBkgColor: mixColors(p.bg, p.dim, 0.3),
    doneTaskBorderColor: p.dim,
    critBkgColor: mixColors(p.bg, p.hot, 0.38),
    critBorderColor: p.hot,
    sectionBkgColor: third,
    altSectionBkgColor: mixColors(p.bg, p.text, 0.03),
    sectionBkgColor2: third,
    // pie
    pieTitleTextColor: p.text,
    pieSectionTextColor: p.bg,
    pieLegendTextColor: p.text,
    pieStrokeColor: p.bg,
    pieOuterStrokeColor: line,
    pieOpacity: "0.92",
  };
  slices.forEach((color, i) => {
    vars[`pie${i + 1}`] = color;
  });
  return vars;
}
