/**
 * Flight Deck v3 - deck colour tokens.
 *
 * The design language of the 1:1 Claude Design port expressed as named
 * constants, so the deck honours the repo rule "all colours are design tokens;
 * never hardcode hex values." EVERY value here is byte-identical to the hex it
 * replaced - this module is a rename, never a re-colour. Do not "tune" a value
 * to something prettier: the deck is pixel-approved; a wrong shade is a bug.
 *
 * Reuse, don't duplicate: agent identity colours live in `DECK_AGENTS`
 * (model.ts) and repo hues in `REPO_HUES` - those remain the source of truth and
 * are referenced, not re-listed, here. The matching CSS custom properties (for
 * deck.css) live in `:root` there with the SAME values (see --deck-*).
 */

/**
 * Compose an `rgba()` string from a hex token + alpha. Renders byte-identically
 * to the hand-written `rgba(r,g,b,a)` literals it replaces (CSS treats
 * `rgba(148,163,216,.14)` and `rgba(148, 163, 216, 0.14)` as the same colour),
 * so it is a safe substitution for the deck's line/border/shadow rgbas that
 * share one base at many alphas.
 */
export function withAlpha(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * The deck palette. Grouped by role; each value is the exact hex previously
 * hardcoded across DeckApp/DeckDock/DeckPanels/DeckVaultSearch. Names describe
 * the ROLE, not the colour, so intent survives a future re-theme.
 */
export const COLORS = {
  // ── surfaces & ink ──────────────────────────────────────────────────────
  bg: '#04060d', // app background
  bgGradTop: '#05070f', // canvas radial-gradient top stop
  bgGradBottom: '#04060b', // canvas radial-gradient bottom stop
  ink: '#0a0716', // dark text on a coloured chip / lane letter
  inkGreen: '#06140c', // dark text on the green (approve) button
  black: '#000000', // shadow base (rgba only)

  // ── lines / borders (rgba base) ─────────────────────────────────────────
  line: '#94a3d8', // the steel border/divider base - rgba(148,163,216,·)

  // ── text ramp (bright → faintest) ───────────────────────────────────────
  white: '#ffffff',
  textBrightest: '#eef2ff', // manual (your) session name
  textBright: '#eef0fb', // panel / dock headings
  textLilac: '#e8ecff', // lane letter (Code Lanes panel)
  textIce: '#dfe6ff', // lane letter (board)
  text: '#e6e9f8', // primary body text
  textValue: '#dfe4f4', // stat values / "yours" badge (mirrors YOU agent)
  textSoft: '#d4daf0', // vault prompt body
  textStrong: '#c6cdf0', // button labels / clock
  textMuted2: '#aeb6d8', // dock action base label
  textMuted: '#9aa3c4', // tool name / sublines
  textDim: '#8b93b8', // model badge / done
  textDim2: '#8a90ac', // map tag alt / trust body
  pathFallback: '#8890bd', // wire/path default stroke fallback
  textFaintBlue: '#7c86ad', // peek line / diff stat
  textIdle: '#6b7394', // idle state
  textFaint: '#5c6484', // faint labels (most common)
  textFainter: '#4a5170', // section labels / placeholder
  textFaintest: '#3d4460', // dimmest hints

  // ── accent (violet) ─────────────────────────────────────────────────────
  accent: '#b195ff',
  accentBright: '#d3c3ff', // active nav / hover / accent text
  accentLilac: '#c6b6ff', // lane lock icon

  // ── status ──────────────────────────────────────────────────────────────
  statusWorking: '#7be3a3', // working / live green
  statusPending: '#f6b96b', // tool-pending amber
  statusPendingText: '#f6c98a', // amber body text
  statusPendingHi: '#e9d3a6', // amber highlight text
  red: '#ff5566', // collision / halt
  redText: '#ff8291', // red body text
  redDeep: '#c23a4e', // collision chip gradient tail

  // ── extra hues (Agent Flow staff boxes & legend) ────────────────────────
  teal: '#5eead4', // quartz vault
  cyan: '#62dbe8', // cyan accent / vega mirror
  pink: '#ff7ac2', // sage
  blue: '#79c0ff',
  lime: '#a8e06e', // scribe
  magenta: '#e879f9', // hermes

  // ── Agent Flow map one-off accents ──────────────────────────────────────
  flowAtlas: '#f6c177',
  flowAmber: '#c9a86a',
  flowViolet: '#8a7bc8',
  flowPlum: '#a86bc9',
  flowSand: '#8a7a55',
};
// NB: intentionally NOT `as const` - deck styles do `let x = COLORS.foo; x = COLORS.bar`
// and pass tokens to params with string-literal defaults, which need `string`
// (widened) typing exactly as the original hex string literals had.

export type ColorToken = keyof typeof COLORS;
