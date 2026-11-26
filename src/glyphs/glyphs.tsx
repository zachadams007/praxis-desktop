/**
 * The Praxis glyph family - ONE consistent 24px-grid, stroke-based set
 * (round3-remodel-lock R8). Geometric instrument markings, not emoji:
 *
 *   - 6 AREA glyphs    (catalyzed spark · praxis neural core · learn strata ·
 *                       finance curve · studio play · trading bot head)
 *   - 6 AGENT insignia (eye · gear · delta · bolt · hex · orbit)
 *   - state MODIFIERS  (ring = active · dot = alert · slash = paused)
 *   - chrome utilities (overview · history · add · chat · hand · files · pulse)
 *
 * Everything is path data on a 0–24 grid, stroked at 1.7 (dots are zero-length
 * round-cap strokes with a width multiplier). Two consumers:
 *   - <Glyph id …/> - the DOM chrome (rail, docks, chips)
 *   - makeGlyphSprite(id, …) - a canvas the 3D slice wraps in a CanvasTexture
 *                                for in-scene medallions / agent chips.
 */

export interface GlyphPath {
  d: string;
  /** Stroke-width multiplier (dots use ~2.2 so they survive small sizes). */
  w?: number;
}

export type AreaGlyphId =
  | "catalyzed"
  | "praxis"
  | "studio"
  | "finance"
  | "ventures"
  | "learnai";
export type AgentGlyphId = "eye" | "gear" | "delta" | "bolt" | "hex" | "orbit";
export type ChromeGlyphId =
  | "overview"
  | "history"
  | "add"
  | "chat"
  | "hand"
  | "files"
  | "pulse"
  | "deck";
export type GlyphId = AreaGlyphId | AgentGlyphId | ChromeGlyphId;

export type GlyphModifier = "ring" | "dot" | "slash";

const BASE_W = 1.7;

export const GLYPHS: Record<GlyphId, GlyphPath[]> = {
  // ------------------------------------------------------------- area glyphs
  /** Catalyzed Alpha - the catalyst spark (4-point reaction star). */
  catalyzed: [
    { d: "M12 3.6 14.3 9.7 20.4 12 14.3 14.3 12 20.4 9.7 14.3 3.6 12 9.7 9.7Z" },
    { d: "M12 12h.01", w: 2.2 },
  ],
  /** Praxis - the neural core: nucleus + three filaments with terminal nodes. */
  praxis: [
    { d: "M12 12m-2.7 0a2.7 2.7 0 1 0 5.4 0a2.7 2.7 0 1 0-5.4 0" },
    { d: "M12 9.3V5.6" },
    { d: "M9.9 13.2 6.8 15.6" },
    { d: "M14.1 13.2 17.2 15.6" },
    { d: "M12 4.6h.01", w: 2.2 },
    { d: "M5.9 16.3h.01", w: 2.2 },
    { d: "M18.1 16.3h.01", w: 2.2 },
  ],
  /** Studio - the play-in-circle (faceless short-form video). */
  studio: [
    { d: "M12 12m-8.4 0a8.4 8.4 0 1 0 16.8 0a8.4 8.4 0 1 0-16.8 0" },
    { d: "M10 8.4 16 12 10 15.6Z" },
  ],
  /** Learning AI - the AI chip: core die + pins. */
  learnai: [
    { d: "M8 8h8v8H8Z" },
    { d: "M10 8V5.4" },
    { d: "M14 8V5.4" },
    { d: "M10 16v2.6" },
    { d: "M14 16v2.6" },
    { d: "M8 10H5.4" },
    { d: "M8 14H5.4" },
    { d: "M16 10h2.6" },
    { d: "M16 14h2.6" },
    { d: "M12 12h.01", w: 2.2 },
  ],
  /** Finance - the rising curve with a breakout arrow. */
  finance: [
    { d: "M3.8 18.2 9.4 12.6 13 15.4 20.2 7.4" },
    { d: "M15.8 7.4h4.4V12" },
  ],
  
  ventures: [
    { d: "M9 7.4V6a1.4 1.4 0 0 1 1.4-1.4h3.2A1.4 1.4 0 0 1 15 6v1.4" },
    { d: "M4.8 7.4h14.4a1 1 0 0 1 1 1v8.4a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1V8.4a1 1 0 0 1 1-1Z" },
    { d: "M3.8 12h16.4" },
    { d: "M12 11.4v1.2" },
  ],

  // ---------------------------------------------------------- agent insignia
  /** Scout · Research - the eye. */
  eye: [
    {
      d: "M3.6 12C6.1 7.6 8.9 5.9 12 5.9s5.9 1.7 8.4 6.1c-2.5 4.4-5.3 6.1-8.4 6.1S6.1 16.4 3.6 12Z",
    },
    { d: "M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0" },
  ],
  /** Forge · Coder - the gear (core + six spokes). */
  gear: [
    { d: "M12 12m-3.1 0a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0-6.2 0" },
    { d: "M12 7.4V5" },
    { d: "M12 16.6V19" },
    { d: "M16 9.7 18.1 8.5" },
    { d: "M8 9.7 5.9 8.5" },
    { d: "M8 14.3 5.9 15.5" },
    { d: "M16 14.3 18.1 15.5" },
  ],
  /** Lumen · Design - the delta (prism). */
  delta: [
    { d: "M12 4.6 19.4 18.6H4.6Z" },
    { d: "M12 13.6h.01", w: 2.2 },
  ],
  /** Relay · Comms - the bolt. */
  bolt: [{ d: "M13.2 3.8 7.2 13h4.2l-.6 7.2L16.8 11h-4.2Z" }],
  /** Ledger · Quant - the hex cell. */
  hex: [
    { d: "M12 3.8 19.1 7.9v8.2L12 20.2 4.9 16.1V7.9Z" },
    { d: "M12 12h.01", w: 2.2 },
  ],
  /** Reel · Media - the orbit (core + ring + satellite). */
  orbit: [
    { d: "M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0" },
    { d: "M12 12h.01", w: 2.6 },
    { d: "M16.9 7.1h.01", w: 2.6 },
  ],

  // -------------------------------------------------------- chrome utilities
  /** Overview - the compass reticle (rail home). */
  overview: [
    { d: "M12 12m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0" },
    { d: "M12 2.8v2.6" },
    { d: "M12 18.6v2.6" },
    { d: "M2.8 12h2.6" },
    { d: "M18.6 12h2.6" },
    { d: "M12 12h.01", w: 2.2 },
  ],
  /** History layer toggle - the clock. */
  history: [
    { d: "M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0" },
    { d: "M12 7.8V12l3.1 1.9" },
  ],
  /** Dump / capture - file an idea. */
  add: [{ d: "M12 5.4v13.2" }, { d: "M5.4 12h13.2" }],
  /** Planner chat. */
  chat: [
    { d: "M5.4 5.8h13.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-8.4l-4.6 3.9V6.8a1 1 0 0 1 1-1Z" },
    { d: "M8.6 10.3h.01", w: 2.2 },
    { d: "M12 10.3h.01", w: 2.2 },
    { d: "M15.4 10.3h.01", w: 2.2 },
  ],
  /** Gesture nav - the hand. */
  hand: [
    { d: "M18 11V6.2a1.8 1.8 0 0 0-3.6 0V10" },
    { d: "M14.4 10V4.4a1.8 1.8 0 0 0-3.6 0v5.2" },
    { d: "M10.8 9.6V6a1.8 1.8 0 0 0-3.6 0v8" },
    {
      d: "M18 8.4a1.8 1.8 0 0 1 3.6 0v5.8a7.4 7.4 0 0 1-7.4 7.4h-1.8c-2.6 0-4.1-.8-5.5-2.2l-3.3-3.3a1.8 1.8 0 0 1 2.5-2.5l1.1 1.1",
    },
  ],
  /** Files / artifacts. */
  files: [
    { d: "M7 3.8h6.8L18 7.6v12.6H7Z" },
    { d: "M13.8 3.8v3.8H18" },
    { d: "M9.6 12.4h4.8" },
    { d: "M9.6 15.6h4.8" },
  ],
  /** Agents / activity - the pulse trace. */
  pulse: [{ d: "M3.8 12h3.6l2-4.6 4.4 9.2 2-4.6h4.4" }],
  /** Flight Deck - mission-control board: a framed set of parallel session lanes. */
  deck: [
    { d: "M4.6 5.4h14.8a1 1 0 0 1 1 1v11.2a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1V6.4a1 1 0 0 1 1-1Z" },
    { d: "M9.5 5.6V18.4" },
    { d: "M14.5 5.6V18.4" },
    { d: "M6.4 8.7h1.6", w: 1 },
    { d: "M11.2 8.7h1.6", w: 1 },
    { d: "M16 8.7h1.6", w: 1 },
  ],
};

/** State-modifier strokes, drawn AROUND a glyph (chips + sprites). */
export const MODIFIERS: Record<GlyphModifier, GlyphPath[]> = {
  ring: [{ d: "M12 12m-10.2 0a10.2 10.2 0 1 0 20.4 0a10.2 10.2 0 1 0-20.4 0", w: 0.8 }],
  dot: [{ d: "M19.4 4.6h.01", w: 3 }],
  slash: [{ d: "M5 19 19 5" }],
};

/** Area id → glyph id (graph area ids are the keys everywhere). */
export const AREA_GLYPH: Record<string, AreaGlyphId> = {
  catalyzed: "catalyzed",
  praxis: "praxis",
  studio: "studio",
  finance: "finance",
  ventures: "ventures",
  learnai: "learnai",
};

/** Agent id → insignia. Same marks in the scene chips and the roster (R10).
 *  LEGACY: superseded app-wide by generated constellation sigils (see `agentSigil`).
 *  Kept only as a fallback for any consumer that hasn't migrated. */
export const AGENT_GLYPH: Record<string, AgentGlyphId> = {
  "a.praxis": "delta",  // Orchestrator - convergence point
  "a.forge":  "gear",   // Claude Coder - machines
  "a.vega":   "orbit",  // Codex Coder - the revolving engine
  "a.quill":  "bolt",   // Cursor Coder - fast transmission
  "a.atlas":  "hex",    // Operator - the grid cell (computer-use)
  "a.sage":   "eye",    // Research - sees
  "a.lens":   "eye",    // QA/Inspector - inspects (shares eye; distinct tint)
  "a.ledger": "hex",    // Records - structured store
  "a.relay":  "bolt",   // Router - transmission
  "a.hermes": "delta",  // Brain Engine - convergence (distinct cyan tint)
};

// ---------------------------------------------------------------------------
// Constellation sigils - the agent symbol system (cross-app). One mark per
// agent: a tiny asterism generated deterministically from the agent id, drawn
// on the same 0–24 grid as the rest of the family. Star COUNT = model-family
// tier (hermes 6 · opus 5 · sonnet/codex/cursor 4 · haiku 3); LAYOUT is a
// stable hash of the id; the first star is the "alpha" (drawn heavier). This
// replaces the fixed 6-icon AGENT_GLYPH set app-wide - every consumer that
// resolves an agent mark through `agentSigil()` picks it up automatically.
// (Ported verbatim from the Memory Galaxy design prototype's sigilPaths().)
// ---------------------------------------------------------------------------

/** A model family for sigil star-count tiers. Superset-tolerant string so callers
 *  can pass any of the roster's family tokens without importing modelTint here. */
export type SigilFamily = string | null | undefined;

/** Small deterministic PRNG (mulberry32) - same as the design prototype. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Star count per model family (tier). Unknown → 4. */
const SIGIL_STARS: Record<string, number> = {
  hermes: 6,
  opus: 5,
  sonnet: 4,
  codex: 4,
  cursor: 4,
  haiku: 3,
  fable: 5,
};

const sigilCache = new Map<string, GlyphPath[]>();

/**
 * Generate the constellation sigil for an agent as `GlyphPath[]` - the exact
 * shape `Glyph`, `makeGlyphSprite`, and the galaxy roster consume. Deterministic
 * from `agentId`; `family` only sets the star count. Cached per (id|family).
 */
export function agentSigil(agentId: string, family?: SigilFamily): GlyphPath[] {
  const fam = family || "";
  const key = `${agentId}|${fam}`;
  const cached = sigilCache.get(key);
  if (cached) return cached;

  const N = SIGIL_STARS[fam] ?? 4;
  let h = 2166136261;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rng = mulberry32(h >>> 0);
  const a0 = rng() * 6.283;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < N; i++) {
    const a = a0 + (i / N) * 6.283 + (rng() - 0.5) * 1.1;
    const r = 5.2 + rng() * 4.2;
    pts.push({
      x: +(12 + Math.cos(a) * r).toFixed(2),
      y: +(12 + Math.sin(a) * r * 0.92).toFixed(2),
    });
  }
  const seg = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    "M" + p.x + " " + p.y + "L" + q.x + " " + q.y;
  const out: GlyphPath[] = [
    { d: pts.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join(""), w: 0.72 },
  ];
  if (N >= 5) out.push({ d: seg(pts[0], pts[(N / 2) | 0]), w: 0.55 });
  pts.forEach((p, i) => out.push({ d: "M" + p.x + " " + p.y + "h.01", w: i === 0 ? 2.5 : 1.55 }));

  sigilCache.set(key, out);
  return out;
}

export interface GlyphProps {
  id: GlyphId;
  size?: number;
  /** Base stroke width on the 24 grid (default 1.7). */
  weight?: number;
  className?: string;
  /** Accessible name; omit for purely decorative marks. */
  title?: string;
}

/** Stroke-based SVG glyph. Color rides `currentColor` so chrome can tint it. */
export function Glyph({ id, size = 16, weight = BASE_W, className, title }: GlyphProps) {
  const paths = GLYPHS[id];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {paths.map((p, i) => (
        <path key={i} d={p.d} strokeWidth={weight * (p.w ?? 1)} />
      ))}
    </svg>
  );
}

export interface AgentSigilProps {
  agentId: string;
  family?: SigilFamily;
  size?: number;
  /** Base stroke width on the 24 grid (default 1.7). */
  weight?: number;
  className?: string;
  title?: string;
}

/** Stroke-based SVG constellation sigil for an agent - the `Glyph` equivalent for
 *  the new agent-mark system. Drop-in for `<Glyph id={AGENT_GLYPH[id]} />`. */
export function AgentSigil({
  agentId,
  family,
  size = 16,
  weight = BASE_W,
  className,
  title,
}: AgentSigilProps) {
  const paths = agentSigil(agentId, family);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {paths.map((p, i) => (
        <path key={i} d={p.d} strokeWidth={weight * (p.w ?? 1)} />
      ))}
    </svg>
  );
}

export interface SpriteOptions {
  /** Canvas edge in px (power of two recommended for mips). Default 128. */
  size?: number;
  /** State modifier drawn around the glyph. */
  modifier?: GlyphModifier;
  /** Modifier color (defaults to the glyph color). */
  modifierColor?: string;
  /** Soft additive halo behind the strokes (default true - bloom-friendly). */
  glow?: boolean;
  /** Base stroke width on the 24 grid (default 1.7). */
  weight?: number;
}

/**
 * Rasterize a glyph (+ optional state modifier) into a canvas for the 3D layer:
 * `new THREE.CanvasTexture(makeGlyphSprite("catalyzed", hue))`. Transparent
 * background; strokes are drawn twice (halo pass + crisp pass) so medallions
 * read under bloom without being hot.
 */
export function makeGlyphSprite(
  id: GlyphId,
  color: string,
  opts: SpriteOptions = {},
): HTMLCanvasElement {
  const { size = 128, modifier, modifierColor, glow = true, weight = BASE_W } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas; // headless edge case - caller gets a blank sprite
  const s = size / 24;
  ctx.scale(s, s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const strokeSet = (paths: GlyphPath[], col: string) => {
    ctx.strokeStyle = col;
    for (const p of paths) {
      ctx.lineWidth = weight * (p.w ?? 1);
      ctx.stroke(new Path2D(p.d));
    }
  };

  if (glow) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 0.07;
    strokeSet(GLYPHS[id], color);
    if (modifier) strokeSet(MODIFIERS[modifier], modifierColor ?? color);
    ctx.restore();
  }
  strokeSet(GLYPHS[id], color);
  if (modifier) strokeSet(MODIFIERS[modifier], modifierColor ?? color);
  return canvas;
}

/**
 * Render an arbitrary GlyphPath set as a sprite canvas - same halo + crisp
 * double pass as makeGlyphSprite, but for paths that aren't in the GLYPHS
 * catalog (cluster sigil alternatives, constellation marks).
 */
export function makePathSprite(
  paths: GlyphPath[],
  color: string,
  opts: SpriteOptions = {},
): HTMLCanvasElement {
  const { size = 256, glow = true, weight = BASE_W } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas; // headless edge case
  const s = size / 24;
  ctx.scale(s, s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const strokeSet = (col: string) => {
    ctx.strokeStyle = col;
    for (const p of paths) {
      ctx.lineWidth = weight * (p.w ?? 1);
      ctx.stroke(new Path2D(p.d));
    }
  };
  if (glow) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 0.07;
    strokeSet(color);
    ctx.restore();
  }
  strokeSet(color);
  return canvas;
}

/**
 * Cluster-sigil alternative A - ORBITAL RETICLE: a fine instrument ring with
 * cardinal ticks, a bright core, and a satellite dot on the orbit. Reads as a
 * "tracked body" - calm, technical, at home next to the CC gauges.
 */
export const ORBITAL_SIGIL: GlyphPath[] = [
  // orbit ring
  { d: "M12 12m-7.6 0a7.6 7.6 0 1 0 15.2 0a7.6 7.6 0 1 0-15.2 0", w: 0.7 },
  // cardinal ticks (outside the ring)
  { d: "M12 2.6v1.9", w: 0.8 },
  { d: "M12 19.5v1.9", w: 0.8 },
  { d: "M2.6 12h1.9", w: 0.8 },
  { d: "M19.5 12h1.9", w: 0.8 },
  // core + inner accent ring
  { d: "M12 12h.01", w: 2.6 },
  { d: "M12 12m-2.9 0a2.9 2.9 0 1 0 5.8 0a2.9 2.9 0 1 0-5.8 0", w: 0.55 },
  // satellite on the orbit (upper-right)
  { d: "M17.4 6.6h.01", w: 2.0 },
];

/**
 * Cluster-sigil alternative B - CONSTELLATION: the same deterministic star-web
 * language the agent sigils / Memory Galaxy wear, seeded per initiative id so
 * every cluster gets its own permanent little asterism.
 */
export function constellationSigil(clusterId: string): GlyphPath[] {
  return agentSigil(`cluster:${clusterId}`, "hermes");
}
