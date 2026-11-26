/**
 * StatusRail - the persistent 48px top rail: brand · HERMES chip · QUARTZ chip ·
 * FLEET / RAILS / BREAKERS stats · voice cluster (Hybrid only) · window nav ·
 * clock · HALT ALL. Ported 1:1 from the approved Claude Design package; every
 * chip is telemetry over real state. One deliberate addition vs the reference:
 * the BRAIN / GALAXY / DECK nav buttons (window access must stay visible - the
 * old launcher cards retired with the redesign, and the rail is the design's own
 * documented extension slot).
 */

import { useEffect, useState } from "react";
import { C, GLOW, FONT } from "./ccTheme";
import { openFlightDeck, openMemoryGalaxy, focusBrain } from "./launch";

const DIVIDER: React.CSSProperties = { width: 1, height: 16, background: "rgba(233,220,196,.12)", flex: "none" };

export interface VoiceView {
  label: string; // IDLE | LISTENING | SPEAKING | ACTING | EXECUTING | SUSPENDED
  color: string;
  barAnim: string;
  line: string;
}

export interface QuartzView {
  state: "up" | "starting" | "idle" | "failed";
  detail: string;
}

export function StatusRail(props: {
  /** "checking" until the first health fact arrives. Without it a cold-start
   *  Command Center printed "engine · nominal" while nothing had been probed. */
  engine: "linked" | "degraded" | "checking";
  engineReason: string;
  quartz: QuartzView | null;
  running: number;
  cutCount: number;
  tightest: { name: string; pct: number } | null;
  /** A rail that cannot be used at all (e.g. "CLAUDE REFUSED") - outranks the tightest-% stat. */
  railAlert?: string | null;
  /** Total OPEN breakers - tool breakers + watch-me (App counts watch-me in). */
  openBreakers: number;
  /** Watch-me capability disabled - named specifically when it's the only open breaker
   *  so the rail never reads "CLOSED" while a breaker is off (2026-07-10 Codex live QA). */
  watchMeOff: boolean;
  voice: VoiceView | null; // null = not hybrid → cluster hidden
  halted: boolean;
  toggleHalt: () => void;
  sovereign: boolean;
  /** Real installed-app version (empty until resolved / outside Tauri - see
   *  App.tsx's useAppVersion()). Matches the version chip already shown in the Flight
   *  Deck header and Memory Galaxy brand line (2026-07-10 CDP QA, CC-7). */
  version: string;
}) {
  const { engine, engineReason, quartz, running, cutCount, tightest, railAlert, openBreakers, watchMeOff, voice, halted, toggleHalt, sovereign, version } = props;

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const two = (n: number) => String(n).padStart(2, "0");
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const mons = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  // Only "linked" | "degraded" are real, observable states - see App.tsx's
  // useHermesHealth(): the Rust observer's `praxis://hermes-degraded` payload is a
  // binary "is the hermes CLI present" flag, so there is no distinct "probe never
  // responded at all" signal to render as a third HERMES OFFLINE state (an unreachable
  // "offline" branch used to live here - removed 2026-07-09, visual-truth audit).
  const eng = {
    linked: { dot: C.emerald, glow: GLOW.emerald, anim: "pxPulse 3s ease-in-out infinite", color: "rgba(233,226,211,.78)", label: "HERMES", sub: "engine · nominal" },
    degraded: { dot: C.pink, glow: "0 0 7px rgba(232,80,157,.55)", anim: "pxBlink 1.1s ease-in-out infinite", color: C.pink, label: "HERMES DEGRADED", sub: engineReason || "retrying" },
    // Nothing has been probed yet. "nominal" is a claim, and the health observer
    // can take until READY_TIMEOUT_SECS to say anything at all.
    checking: { dot: "rgba(233,226,211,.35)", glow: "none", anim: "pxPulse 2s ease-in-out infinite", color: "rgba(233,226,211,.5)", label: "HERMES", sub: "engine · checking…" },
  }[engine];

  // "NOMINAL" while Anthropic refused Claude Code (2026-10-04) was the header contradicting
  // the Supply rail right below it. A dead rail outranks the fullest meter.
  const railStat = railAlert ?? (tightest && tightest.pct >= 70 ? `${tightest.name} ${Math.round(tightest.pct)}%` : "NOMINAL");
  const railStatColor = railAlert ? C.amber : tightest && tightest.pct >= 90 ? C.ruby : tightest && tightest.pct >= 70 ? C.pink : "rgba(43,226,143,.8)";
  const quartzView = quartz == null
    ? { text: "…", color: C.faint, dot: C.faint, glow: "none", animation: "none" }
    : {
        up: { text: "vault", color: C.faint, dot: C.emerald, glow: GLOW.emerald, animation: "pxPulse 3.6s ease-in-out infinite" },
        starting: { text: "starting", color: C.faint, dot: C.faint, glow: "none", animation: "pxPulse 2s ease-in-out infinite" },
        idle: { text: "idle · opens with Galaxy", color: C.faint, dot: C.faint, glow: "none", animation: "none" },
        failed: { text: "failed", color: C.amber, dot: C.amber, glow: "none", animation: "none" },
      }[quartz.state];

  // Honest breaker summary: name watch-me when it's the sole open breaker, else the
  // count. Never "CLOSED" while anything (watch-me included) is open.
  const breakersText = openBreakers === 0 ? "CLOSED" : openBreakers === 1 && watchMeOff ? "WATCH-ME OFF" : `${openBreakers} OPEN`;
  const breakersTitle =
    openBreakers === 0 ? "all breakers closed" : watchMeOff ? `${openBreakers} open · watch-me disabled` : "tool breakers open";

  const hairline = halted
    ? C.ruby
    : engine === "degraded"
      ? "rgba(232,80,157,.85)"
      : sovereign
        ? C.amethyst
        : "rgba(233,220,196,.06)";

  const stat = (label: string, value: string, color: string, title: string) => (
    <div title={title} style={{ display: "flex", alignItems: "baseline", gap: 7, flex: "none" }}>
      <span style={{ fontSize: 8.5, letterSpacing: ".18em", color: "rgba(233,226,211,.38)" }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color }}>{value}</span>
    </div>
  );

  const navBtn = (label: string, go: () => void) => (
    <button
      key={label}
      type="button"
      className="px-hover-border"
      onClick={go}
      style={{
        background: "none",
        border: "1px solid rgba(233,220,196,.12)",
        color: "rgba(233,226,211,.5)",
        fontFamily: "inherit",
        fontSize: 8.5,
        letterSpacing: ".16em",
        padding: "4px 8px",
        cursor: "pointer",
        flex: "none",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div style={{ flex: "none", height: 48, display: "flex", alignItems: "center", gap: 12, padding: "0 16px", background: C.rail }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, flex: "none" }}>
          <span style={{ color: C.sapphire, fontSize: 9, textShadow: "0 0 8px rgba(73,160,244,.6)" }}>◆</span>
          <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 17, letterSpacing: ".01em" }}>Praxis</span>
          <span style={{ fontSize: 9, letterSpacing: ".32em", color: "rgba(233,226,211,.4)", fontWeight: 500 }}>COMMAND</span>
          {version && (
            <span style={{ fontSize: 8, letterSpacing: ".16em", color: "rgba(233,226,211,.3)" }}>V{version}</span>
          )}
        </div>
        <div style={DIVIDER} />
        <div title={engineReason || "hermes engine link"} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", flex: "none" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: eng.dot, boxShadow: eng.glow, animation: eng.anim }} />
          <span style={{ fontSize: 10, letterSpacing: ".14em", fontWeight: 600, color: eng.color }}>{eng.label}</span>
          <span style={{ fontSize: 10, color: "rgba(233,226,211,.38)", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{eng.sub}</span>
        </div>
        <div title={quartz?.detail || "quartz vault server — local infra"} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", flex: "none" }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: halted ? C.faint : quartzView.dot,
              boxShadow: halted ? "none" : quartzView.glow,
              animation: halted ? "none" : quartzView.animation,
            }}
          />
          <span style={{ fontSize: 10, letterSpacing: ".14em", fontWeight: 600, color: "rgba(233,226,211,.78)" }}>QUARTZ</span>
          <span style={{ fontSize: 10, color: quartzView.color }}>{quartzView.text}</span>
        </div>
        <div style={DIVIDER} />
        {stat("FLEET", halted ? "HALTED" : `${running}/8`, halted ? C.faint : cutCount > 0 ? C.ruby : "rgba(43,226,143,.85)", "agents live right now")}
        <div style={DIVIDER} />
        {stat("RAILS", railStat, railStatColor, railAlert ? "a rail can't be used right now - see SUPPLY" : "tightest rail right now")}
        <div style={DIVIDER} />
        {stat("BREAKERS", breakersText, openBreakers === 0 ? "rgba(233,226,211,.55)" : C.ruby, breakersTitle)}
        {voice && (
          <>
            <div style={DIVIDER} />
            {/* Shrinks and clips instead of spilling: on a narrower window the label used to
                run under the BRAIN button ("EXECUTINGRAIN"). The italic line gives way first. */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: "0 1 auto", overflow: "hidden", marginRight: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 2, height: 14, flex: "none" }}>
                {[0, 0.14, 0.28, 0.42, 0.56].map((d) => (
                  <span
                    key={d}
                    style={{
                      width: 2,
                      height: 12,
                      background: voice.color,
                      boxShadow: `0 0 6px ${voice.color}`,
                      // delay folded into the shorthand (2nd time value) - mixing the
                      // shorthand with animationDelay trips React's style-conflict warning
                      animation: voice.barAnim === "none" ? "none" : `${voice.barAnim} ${d}s`,
                    }}
                  />
                ))}
              </div>
              <span style={{ fontSize: 9.5, letterSpacing: ".22em", fontWeight: 600, color: voice.color, flex: "none" }}>{voice.label}</span>
              <span
                style={{
                  fontFamily: FONT.serif,
                  fontStyle: "italic",
                  fontSize: 12.5,
                  color: "rgba(233,226,211,.52)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 230,
                  minWidth: 0,
                  flex: "0 1 auto",
                }}
              >
                {voice.line}
              </span>
            </div>
          </>
        )}
        <div style={{ flex: 1 }} />
        {navBtn("BRAIN", focusBrain)}
        {navBtn("GALAXY", openMemoryGalaxy)}
        {navBtn("DECK", openFlightDeck)}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.25, flex: "none" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{`${two(now.getHours())}:${two(now.getMinutes())}`}</span>
          <span style={{ fontSize: 8.5, letterSpacing: ".14em", color: "rgba(233,226,211,.4)" }}>
            {`${days[now.getDay()]} ${two(now.getDate())} ${mons[now.getMonth()]}`}
          </span>
        </div>
        <button
          type="button"
          className="px-hover-bright"
          title="stop every agent, every mode, instantly"
          onClick={toggleHalt}
          style={{
            height: 26,
            padding: "0 12px",
            border: "1px solid rgba(224,67,85,.6)",
            background: halted ? C.ruby : "transparent",
            color: halted ? "#14100d" : C.ruby,
            fontFamily: "inherit",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: ".16em",
            cursor: "pointer",
            flex: "none",
          }}
        >
          {halted ? "HALTED · RESUME" : "HALT ALL"}
        </button>
      </div>
      <div style={{ flex: "none", height: 2, background: hairline }} />
    </>
  );
}
