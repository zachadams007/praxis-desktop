/**
 * atlas.ts - the star-atlas constants (ported from the Memory Galaxy design prototype).
 * The single source of truth for area taxonomy + hues, artifact glyphs/labels, the
 * autonomy ladder, and small color helpers the canvas engine + chrome both read.
 *
 * Area taxonomy reuses the EXACT names from src/data/realEvents.ts repoToArea() and
 * src/shared/agents.ts AgentRow.touches, so the whole app speaks one initiative set.
 */
import type { Area, AreaId, ArtifactKind } from "./types";

/** Background / text / hairline tokens - the "abyss" family (matches the brain). */
export const P = {
  bg: "#05060B",
  text: "#E9EEF7",
  dim: "#8B95AB",
  line: "rgba(167,181,212,.13)",
  line2: "rgba(167,181,212,.3)",
  blue: "#6C8CFF",
  ice: "#DFE9FF",
  struct: "#6C8CFF",
} as const;

/** Locked accent default + curated alternates (the DC's `accent` prop). */
export const ACCENT_DEFAULT = "#ff2d2d";
export const ACCENT_ALTS = ["#ff5c47", "#ff7a18", "#ff2d2d", "#00e5ff"];

/** Type fonts (vendored @font-face - see galaxy.css). */
export const FONT = {
  serif: "'Spectral', Georgia, serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/**
 * AREAS - irregular anchors; hues span the spectrum so density clusters read like an
 * Obsidian vault. `global` is the fallback bucket for meta/global notes (a quiet slate,
 * anchored below the main cluster so it doesn't fight the six initiatives).
 */
export const AREAS: Area[] = [
  { id: "praxis", name: "Praxis", hue: "#6C8CFF", ax: -30, ay: -40, blurb: "Praxis itself · second-brain OS" },
  { id: "catalyzed", name: "Catalyzed Alpha", hue: "#35D3C0", ax: 205, ay: -70, blurb: "consumer stock-signal app" },
  { id: "learnai", name: "Learn AI", hue: "#9D7BFF", ax: 15, ay: 150, blurb: "skills · workflows · agents" },
  { id: "finance", name: "Finance", hue: "#F5B84B", ax: 235, ay: 95, blurb: "spend ledger · guardrails · bot" },
  { id: "ventures", name: "Ventures", hue: "#FF8A5C", ax: 130, ay: 215, blurb: "client work" },
  { id: "studio", name: "Studio", hue: "#FF6FA5", ax: -215, ay: 55, blurb: "short-form video" },
  { id: "global", name: "Global", hue: "#7E8AA6", ax: -120, ay: 250, blurb: "meta · cross-cutting notes" },
];

/** Fast lookup: area id → Area. */
export const AREA: Record<string, Area> = Object.fromEntries(AREAS.map((a) => [a.id, a]));

/** The six "real" initiatives (the Vault filter list - `global` is shown but last). */
export const AREA_IDS: AreaId[] = AREAS.map((a) => a.id);

/** Artifact type → glyph (star-atlas marks). */
export const TYPE_GLYPH: Record<ArtifactKind, string> = {
  task: "▲",
  note: "◆",
  reference: "❏",
  conversation: "✦",
  idea: "✷",
  capture: "◦",
};

/** Artifact type → human label. */
export const TYPE_LABEL: Record<ArtifactKind, string> = {
  task: "Task",
  note: "Note",
  reference: "Reference",
  conversation: "Conversation",
  idea: "Idea",
  capture: "Capture",
};

// The autonomy ladder was a near-verbatim fork of the canonical TRUST_LEVELS. It's been
// removed so the galaxy speaks the ONE trust value (src/shared/autonomy.ts): the ladder now
// reads/writes through loadAutonomy/saveAutonomy + the praxis://autonomy broadcast, exactly
// like the Command Center TrustPanel. Consumers import TRUST_LEVELS directly.

// ---------------------------------------------------------------------------
// Color helpers (hex math) - shared by the engine, rig, and chrome.
// ---------------------------------------------------------------------------

/** "#rrggbb" → "r,g,b" (tolerant of 3-digit shorthand). */
export function rgbOf(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
}

/** "#rrggbb" + alpha → rgba() string. */
export function rgba(hex: string, a: number): string {
  return `rgba(${rgbOf(hex)},${a})`;
}

/** Mix two hex colors by t (0..1). */
export function mix(h1: string, h2: string, t: number): string {
  const p = (h: string): [number, number, number] => {
    h = h.replace("#", "");
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const a = p(h1), b = p(h2);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** mulberry32 PRNG - deterministic layout jitter (matches the design prototype). */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
