/**
 * Praxis theme tokens - swappable from day one.
 *
 * Color ENCODES STATE:
 *   - idle / structural = the cool BASE family (bright turquoise → soft warm blue),
 *     ramped by depth (shallow = turquoise, deep = soft blue).
 *   - active / firing   = the warm ACCENT (amber-orange → red). Explicitly NO yellow.
 *   - spend climbing (future) = the base hue is allowed to drift warmer.
 *
 * Every color lives here. `ThemeProvider` mirrors these into CSS custom properties
 * for the DOM HUD; the 3D layer reads the same hex values via `useTheme()`.
 *
 * Flip palettes live with the leva "theme" control (dev HUD).
 */

export interface Palette {
  /** Display name (leva dropdown + HUD). */
  label: string;
  /** Near-black canvas background. */
  bg: string;
  /** Deeper black for vignette / fog falloff. */
  bgDeep: string;
  /** Primary text (near-white). */
  text: string;
  /** Muted text. */
  textDim: string;
  /** Hairline / panel borders. */
  line: string;

  /** BASE family - idle structural nodes/edges. Shallow (near hub). */
  baseCool: string;
  /** BASE family - idle structural nodes/edges. Deep (far from hub). */
  baseWarm: string;
  /** Idle edge color (dim base). */
  edge: string;

  /** ACCENT - active / firing. */
  accent: string;
  /** ACCENT - alert / spend / danger (hotter, toward red). */
  accentHot: string;

  /** Orchestrator hub core (brightest point in the scene). */
  hub: string;

  /** Bloom intensity multiplier for this palette (tuned per look). */
  bloom: number;

  /**
   * Optional in-brain spectrum ramp (cool → hot). When present, the 3D web may
   * spread these hues across depth/clusters - the CHROME still uses the flat
   * tokens above, so the dashboard stays disciplined while the brain goes vivid.
   */
  spectrum?: [string, string, string, string];

  /**
   * Per-AREA accent hues (round3-remodel-lock R7): medallions, branches, rail
   * glyphs and dock chips all key the same hue per area, so the multicolor of
   * the map is *information*, not noise. Falls back to DEFAULT_AREA_HUES.
   */
  areaHues?: Record<string, string>;
}

/**
 * The shared per-area hue map (keys = graph area ids). Electric multicolor in
 * the inspo's register: cyan / violet / pink / green / gold - saturated but
 * never the alert red, which stays reserved for activity (accentHot).
 */
export const DEFAULT_AREA_HUES: Record<string, string> = {
  catalyzed: "#2de2ff", // cyan
  ventures: "#ffc24b",
  finance: "#34e0a0", // emerald
  studio: "#ff5fa8", // magenta
  praxis: "#8b7bff", // violet
  learnai: "#ff9d3c", // amber (AI craft - warm, distinct from the reserved red)
};

/** Resolved per-area hues for a palette (theme override → defaults). */
export function areaHuesOf(p: Palette): Record<string, string> {
  return { ...DEFAULT_AREA_HUES, ...(p.areaHues ?? {}) };
}

export type ThemeName = "abyss" | "plasma" | "praxis" | "iceberg" | "ember" | "mono";

/** themeName as stored: a preset, or the user's live Theme-Lab palette. */
export type ActiveThemeName = ThemeName | "custom";

export const THEMES: Record<ThemeName, Palette> = {
  // Round-2 default (design lock 2026-06-12): deep-blue PRAXIS - electric blue web,
  // ice-white burning core, coral-red strictly for activity/alerts. Dark + smooth,
  // never bright as a whole.
  abyss: {
    label: "Abyss",
    bg: "#030712",
    bgDeep: "#01030a",
    text: "#eaf2ff",
    textDim: "#7d8fb0",
    line: "#101b33",
    baseCool: "#3b6cff",
    baseWarm: "#8fb8ff",
    edge: "#1d3a73",
    accent: "#ff5c47",
    accentHot: "#ff2d2d",
    hub: "#dbeaff",
    bloom: 1.05,
  },

  // Vivid fallback: full spectrum INSIDE the brain only (see `spectrum`);
  // chrome tokens stay mono-ice so the dashboard never gets noisy.
  plasma: {
    label: "Plasma",
    bg: "#050308",
    bgDeep: "#020103",
    text: "#f2eefc",
    textDim: "#8e87a3",
    line: "#1c1430",
    baseCool: "#2de2ff",
    baseWarm: "#8b5cf6",
    edge: "#3b2f6e",
    accent: "#ff4fd8",
    accentHot: "#ff4030",
    hub: "#eef6ff",
    bloom: 1.12,
    spectrum: ["#2de2ff", "#8b5cf6", "#ff4fd8", "#ff6b2f"],
  },

  // The owner's original locked palette: bright turquoise → soft warm blue base,
  // amber/red accent, near-black bg, white text.
  praxis: {
    label: "Praxis",
    bg: "#04060a",
    bgDeep: "#010205",
    text: "#eaf6ff",
    textDim: "#7e94a9",
    line: "#13202c",
    baseCool: "#34f0db",
    baseWarm: "#5c9bf0",
    edge: "#1c6f86",
    accent: "#ff7a2f",
    accentHot: "#ff3b30",
    hub: "#8affff",
    bloom: 1.0,
  },

  // Cooler, cleaner A/B - cyan base, coral accent.
  iceberg: {
    label: "Iceberg",
    bg: "#060a10",
    bgDeep: "#02050a",
    text: "#f1f9ff",
    textDim: "#86a0b6",
    line: "#152634",
    baseCool: "#67e8ff",
    baseWarm: "#9ad0ff",
    edge: "#28728f",
    accent: "#ff6b6b",
    accentHot: "#ff2d6b",
    hub: "#d6fbff",
    bloom: 0.92,
  },

  // Warmer base test - teal → violet, hot orange accent.
  ember: {
    label: "Ember",
    bg: "#070608",
    bgDeep: "#030205",
    text: "#fdf2ec",
    textDim: "#9a8b94",
    line: "#231a26",
    baseCool: "#2ce0c8",
    baseWarm: "#7b6cff",
    edge: "#3a5f86",
    accent: "#ff7a18",
    accentHot: "#ff2d2d",
    hub: "#b6fff2",
    bloom: 1.08,
  },

  // Minimal, high-contrast, filmable - near-mono cool base, amber spark.
  mono: {
    label: "Mono",
    bg: "#050608",
    bgDeep: "#020304",
    text: "#ffffff",
    textDim: "#8593a0",
    line: "#1a2026",
    baseCool: "#cfe9f0",
    baseWarm: "#8fb4c8",
    accent: "#ff8a3d",
    edge: "#3a4a54",
    accentHot: "#ff4d4d",
    hub: "#ffffff",
    bloom: 0.85,
  },
};

export const DEFAULT_THEME: ThemeName = "abyss";

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

// ---------------------------------------------------------------------------
// Theme Lab - the user's custom scheme, persisted across sessions
// ---------------------------------------------------------------------------

const CUSTOM_KEY = "praxis-theme-custom";
const ACTIVE_KEY = "praxis-theme-active";

/** Load the saved Theme-Lab palette (null if none / unparsable). */
export function loadCustomPalette(): Palette | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Palette;
    // minimal shape check - every chrome token must be a string
    const keys: (keyof Palette)[] = [
      "bg", "bgDeep", "text", "textDim", "line",
      "baseCool", "baseWarm", "edge", "accent", "accentHot", "hub",
    ];
    if (!keys.every((k) => typeof p[k] === "string")) return null;
    return { ...p, label: "Custom", bloom: typeof p.bloom === "number" ? p.bloom : 1 };
  } catch {
    return null;
  }
}

/** Persist the Theme-Lab palette (the "Save scheme" button). */
export function saveCustomPalette(p: Palette): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify({ ...p, label: "Custom" }));
  } catch {
    /* storage may be unavailable (private mode) - saving is best-effort */
  }
}

/** Remember which theme was active so a reload restores the look. */
export function saveActiveTheme(name: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, name);
  } catch {
    /* best-effort */
  }
}

export function loadActiveTheme(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** Mirror a palette into CSS custom properties on :root (for the DOM HUD). */
export function applyThemeVars(p: Palette): void {
  const root = document.documentElement.style;
  root.setProperty("--bg", p.bg);
  root.setProperty("--bg-deep", p.bgDeep);
  root.setProperty("--text", p.text);
  root.setProperty("--text-dim", p.textDim);
  root.setProperty("--line", p.line);
  root.setProperty("--base-cool", p.baseCool);
  root.setProperty("--base-warm", p.baseWarm);
  root.setProperty("--accent", p.accent);
  root.setProperty("--accent-hot", p.accentHot);
  root.setProperty("--hub", p.hub);
  for (const [id, hue] of Object.entries(areaHuesOf(p))) {
    root.setProperty(`--area-${id}`, hue);
  }
}
