/**
 * BreakersPanel - six REAL kill-switches (right column, bottom), ported 1:1 from
 * the approved Claude Design package. Each row flips the matching controlStore
 * tool toggle (localStorage → policy.ts, read at call time by the orchestrator) -
 * the same real gates the old Tool Switches card controlled, in breaker clothing.
 * The cascade (fleet LEDs, model chips, disabled dropdown options, mode note,
 * manifest caption, rail stat) all derive from this state elsewhere.
 */

import { C, FONT, panelHead, headTick, headLabel, headCaption } from "./ccTheme";
import type { ToolKey, ToolToggleStore } from "./controlStore";
import { useWatchMe } from "@/components/watchMeStore";

/**
 * What each breaker CUTS - which agents and capabilities go dark when it opens.
 *
 * A caption that never changes cannot be reporting anything, so it now says the one thing it
 * actually knows - what this switch is wired to.
 */
const BREAKERS: { id: ToolKey; name: string; deps: string }[] = [
  { id: "claude", name: "CLAUDE", deps: "cuts forge · sage · atlas · scribe" },
  { id: "codex", name: "CODEX", deps: "cuts vega · visible computer-use handoff" },
  { id: "cursor", name: "CURSOR", deps: "cuts quill · in-editor lanes" },
  { id: "openrouter", name: "OPENROUTER", deps: "cuts metered overflow brain" },
  { id: "hermes", name: "HERMES · PLANNER", deps: "cuts manifest · dispatch · self-scheduling" },
  { id: "computer-use", name: "COMPUTER-USE", deps: "cuts atlas’s hands — live and unattended" },
];

export function BreakersPanel({ toggles, setTool }: ToolToggleStore) {
  return (
    <div style={{ flex: 1, minHeight: 0, background: C.panel, display: "flex", flexDirection: "column" }}>
      <div style={panelHead}>
        <span style={headTick("rgba(224,67,85,.85)")} />
        <span style={headLabel}>BREAKERS</span>
        <span style={{ flex: 1 }} />
        <span style={headCaption}>cut a tool cold</span>
      </div>
      {BREAKERS.map((b) => {
        const on = toggles[b.id] !== false;
        return (
          <button
            key={b.id}
            type="button"
            className="px-hover-row"
            onClick={() => setTool(b.id, !on)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              padding: "9px 14px",
              background: "transparent",
              border: "none",
              borderBottom: "1px solid rgba(233,220,196,.05)",
              cursor: "pointer",
              color: "inherit",
              fontFamily: "inherit",
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 11, fontWeight: 600, letterSpacing: ".14em", color: on ? C.ink : "rgba(224,67,85,.8)" }}>
                {b.name}
              </span>
              <span style={{ display: "block", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10.5, color: "rgba(233,226,211,.36)", marginTop: 2 }}>
                {b.deps}
              </span>
            </span>
            <span style={{ flex: "none", display: "block", width: 22, height: 34, border: "1px solid rgba(233,220,196,.16)", background: C.abyss, position: "relative" }}>
              <span
                style={{
                  position: "absolute",
                  left: 2,
                  width: 16,
                  height: 13,
                  background: "#221e18",
                  border: "1px solid rgba(233,220,196,.2)",
                  top: on ? 2 : 17,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "top .12s ease-out",
                }}
              >
                <span
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: "50%",
                    background: on ? C.emerald : C.ruby,
                    boxShadow: on ? "0 0 5px rgba(43,226,143,.6)" : "0 0 5px rgba(224,67,85,.6)",
                  }}
                />
              </span>
            </span>
          </button>
        );
      })}
      <WatchMeBreaker />
      <div style={{ flex: 1 }} />
      <div style={{ padding: "10px 14px 12px", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 11, color: "rgba(233,226,211,.3)" }}>
        an open breaker hard-stops its dependents mid-task. praxis will not route around it.
      </div>
    </div>
  );
}

/**
 * WATCH ME breaker - master enable for the screen-observe capability, wired to the
 * cross-window watchMeStore (NOT the orchestrator tool toggles, so it never leaks into
 * policy.ts gating). ON reflects the live watching state; flipping it OFF force-stops
 * an active watch in the brain window via the store's praxis://watchme broadcast.
 */
function WatchMeBreaker() {
  const enabled = useWatchMe((s) => s.enabled);
  const watching = useWatchMe((s) => s.watching);
  const setEnabled = useWatchMe((s) => s.setEnabled);
  const on = enabled;
  const live = enabled && watching;
  return (
    <button
      type="button"
      className="px-hover-row"
      onClick={() => setEnabled(!on)}
      title={on ? "master on — click to hard-stop watch-me everywhere" : "watch-me disabled — click to allow"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "9px 14px",
        background: "transparent",
        border: "none",
        borderBottom: "1px solid rgba(233,220,196,.05)",
        cursor: "pointer",
        color: "inherit",
        fontFamily: "inherit",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: ".14em", color: on ? C.ink : "rgba(224,67,85,.8)" }}>
          WATCH ME
          {live && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: C.emerald,
                boxShadow: "0 0 6px rgba(43,226,143,.7)",
                animation: "pxPulse 1.6s ease-in-out infinite",
              }}
            />
          )}
        </span>
        <span style={{ display: "block", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10.5, color: "rgba(233,226,211,.36)", marginTop: 2 }}>
          {live ? "watching your screen now · atlas eyes" : "screen observe · vision Q&A"}
        </span>
      </span>
      <span style={{ flex: "none", display: "block", width: 22, height: 34, border: "1px solid rgba(233,220,196,.16)", background: C.abyss, position: "relative" }}>
        <span
          style={{
            position: "absolute",
            left: 2,
            width: 16,
            height: 13,
            background: "#221e18",
            border: "1px solid rgba(233,220,196,.2)",
            top: on ? 2 : 17,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "top .12s ease-out",
          }}
        >
          <span
            style={{
              width: 3,
              height: 3,
              borderRadius: "50%",
              background: on ? C.emerald : C.ruby,
              boxShadow: on ? "0 0 5px rgba(43,226,143,.6)" : "0 0 5px rgba(224,67,85,.6)",
            }}
          />
        </span>
      </span>
    </button>
  );
}
