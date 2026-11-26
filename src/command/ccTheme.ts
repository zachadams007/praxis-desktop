/**
 * ccTheme - the Command Center v2 design tokens, ported 1:1 from the approved
 * Claude Design package (`Praxis Command Center.dc.html`, 2026-07-05). Jewel-toned
 * functional color on near-black; IBM Plex Mono for UI/data, Newsreader italic for
 * every serif run. Color always MEANS something - see the README table in the
 * design handoff. Do not invent new accents; extend by reusing these.
 */

export const C = {
  abyss: "#0a0908", // app background
  rail: "#0e0d0b", // status rail background
  seam: "#040303", // grid gap / hairline seams
  panel: "#131110", // panel background
  header: "#181512", // panel header bar
  rowHover: "#1a1712", // hover + selected row background
  inset: "#0f0e0c", // dropdowns, jot input, chips
  ink: "#e9e2d3", // primary text
  dim: "rgba(233,226,211,.55)",
  faint: "rgba(233,226,211,.34)",
  emerald: "#2be28f", // alive / nominal / healthy / holds
  sapphire: "#49a0f4", // active selection + "this is Praxis"
  sapphireLt: "#8ecbff", // SPEAKING, jot chevron, report tag
  ruby: "#e04355", // cut / halted / offline / gone
  pink: "#e8509d", // needs attention / nearing limit
  amber: "rgba(233,180,120,.72)", // degraded local infra / stale telemetry
  amethyst: "#9b5cf6", // Sovereign only
  amethystLt: "#b98cff", // ARMED text, ACTING voice state
} as const;

export const GLOW = {
  emerald: "0 0 8px rgba(43,226,143,.55)",
  sapphire: "0 0 8px rgba(73,160,244,.55)",
  ruby: "0 0 7px rgba(224,67,85,.5)",
  rubyPip: "0 0 5px rgba(224,67,85,.6)",
  pink: "0 0 7px rgba(232,80,157,.55)",
} as const;

export const FONT = {
  mono: "'IBM Plex Mono', ui-monospace, monospace",
  serif: "'Newsreader', Georgia, serif",
} as const;

/** Panel header bar - 32px, 3px colored tick, mono label, serif-italic caption. */
export const panelHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 32,
  padding: "0 14px",
  borderBottom: "1px solid rgba(233,220,196,.07)",
  background: C.header,
  flex: "none",
};

export const headTick = (color: string): React.CSSProperties => ({
  width: 3,
  height: 11,
  background: color,
});

export const headLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: ".18em",
  color: C.dim,
};

export const headCaption: React.CSSProperties = {
  fontFamily: FONT.serif,
  fontStyle: "italic",
  fontSize: 11,
  color: "rgba(233,226,211,.32)",
};

/** Small bordered mono rail tag (MAX / CODEX / CURSOR / NVIDIA / OR). */
export const railTag = (color: string = "rgba(233,226,211,.45)"): React.CSSProperties => ({
  fontSize: 8.5,
  letterSpacing: ".12em",
  padding: "3px 5px",
  border: "1px solid rgba(233,220,196,.1)",
  color,
});

/** Supply-bar tiering: emerald < 70%, pink 70-89%, ruby >= 90% (fill, glow, value). */
export function barTier(pct: number): { color: string; glow: string } {
  if (pct >= 90) return { color: C.ruby, glow: GLOW.ruby };
  if (pct >= 70) return { color: C.pink, glow: "0 0 6px rgba(232,80,157,.45)" };
  return { color: "rgba(43,226,143,.75)", glow: "0 0 5px rgba(43,226,143,.3)" };
}
