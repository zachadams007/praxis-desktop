/**
 * ModePanel - execution mode (LIVE / HYBRID / BACKGROUND), ported 1:1 from the
 * approved Claude Design package. Selecting a row sets the REAL exec mode
 * (controlStore → localStorage → policy.ts currentExecMode, consulted by the
 * orchestrator). The conditional pink note mirrors real state: computer-use
 * breaker open, or halted.
 */

import type { ExecMode, ToolKey } from "./controlStore";
import { C, FONT, panelHead, headTick, headLabel, headCaption } from "./ccTheme";

const MODES: { id: ExecMode; name: string; desc: string; glyph: (color: string) => React.ReactNode }[] = [
  {
    id: "live",
    name: "LIVE",
    desc: "atlas drives a visible cursor — you watch it work.",
    glyph: (color) => (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke={color} strokeWidth="1.3" />
        <circle cx="8" cy="8" r="2" fill={color} />
      </svg>
    ),
  },
  {
    id: "hybrid",
    name: "HYBRID",
    desc: "always listening — real actions, instantly, no theater.",
    glyph: (color) => (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="6" width="1.8" height="4" fill={color} />
        <rect x="5.4" y="3.5" width="1.8" height="9" fill={color} />
        <rect x="8.8" y="5" width="1.8" height="6" fill={color} />
        <rect x="12.2" y="6.5" width="1.8" height="3" fill={color} />
      </svg>
    ),
  },
  {
    id: "background",
    name: "BACKGROUND",
    desc: "headless in the terminal while you do other things.",
    glyph: (color) => (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="3" width="12" height="10" fill="none" stroke={color} strokeWidth="1.3" />
        <polyline points="4.5,6 6.5,8 4.5,10" fill="none" stroke={color} strokeWidth="1.3" />
        <line x1="8" y1="10.5" x2="11.5" y2="10.5" stroke={color} strokeWidth="1.3" />
      </svg>
    ),
  },
];

export function ModePanel({
  mode,
  setMode,
  toggles,
  halted,
}: {
  mode: ExecMode;
  setMode: (m: ExecMode) => void;
  toggles: Record<ToolKey, boolean>;
  halted: boolean;
}) {
  const modeNote = !toggles["computer-use"]
    ? "computer-use breaker is open — live and hybrid have no hands until it closes."
    : halted
      ? "halted — mode changes take effect on resume."
      : null;

  return (
    <div style={{ flex: "none", background: C.panel }}>
      <div style={panelHead}>
        <span style={headTick("rgba(73,160,244,.85)")} />
        <span style={headLabel}>MODE</span>
        <span style={{ flex: 1 }} />
        <span style={headCaption}>how the work happens</span>
      </div>
      {MODES.map((m, i) => {
        const sel = mode === m.id;
        const glyphColor = sel ? C.sapphire : "rgba(233,226,211,.38)";
        return (
          <button
            key={m.id}
            type="button"
            className="px-hover-row"
            onClick={() => setMode(m.id)}
            style={{
              display: "grid",
              gridTemplateColumns: "24px 1fr auto",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              padding: "11px 14px",
              background: sel ? C.rowHover : "transparent",
              border: "none",
              borderBottom: i < MODES.length - 1 ? "1px solid rgba(233,220,196,.05)" : "none",
              cursor: "pointer",
              color: "inherit",
              fontFamily: "inherit",
            }}
          >
            <span style={{ filter: sel ? "drop-shadow(0 0 3px rgba(73,160,244,.65))" : "none", display: "flex" }}>{m.glyph(glyphColor)}</span>
            <span>
              <span style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: ".12em", color: sel ? C.ink : "rgba(233,226,211,.6)" }}>
                {m.name}
              </span>
              <span style={{ display: "block", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 11.5, color: "rgba(233,226,211,.45)", marginTop: 2 }}>
                {m.desc}
              </span>
            </span>
            <span style={{ color: sel ? C.sapphire : "rgba(233,226,211,.22)", fontSize: 10 }}>{sel ? "◆" : "◇"}</span>
          </button>
        );
      })}
      {modeNote && (
        <div
          style={{
            padding: "8px 14px 10px",
            borderTop: "1px solid rgba(233,220,196,.05)",
            fontFamily: FONT.serif,
            fontStyle: "italic",
            fontSize: 11,
            color: "rgba(232,80,157,.85)",
          }}
        >
          {modeNote}
        </div>
      )}
    </div>
  );
}
