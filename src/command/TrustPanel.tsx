/**
 * TrustPanel - the four-detent trust gauge (I OBSERVE · II PROPOSE · III EXECUTE ·
 * IV SOVEREIGN), ported 1:1 from the approved Claude Design package.
 *
 * Wiring: detents map onto the canonical autonomy ladder (src/shared/autonomy.ts) -
 * observe → approve → operator → full. Legacy "suggest" reads as detent II. Commit
 * persists via saveAutonomy (localStorage + autonomy_sync shell mirror) and
 * broadcastAutonomy so the brain's leash is REAL, exactly like the old dial.
 *
 * Sovereign (IV) is guarded by a 750ms press-and-hold arm. The hold gates on a
 * SYNCHRONOUS instance flag (armingRef) - React state coalesces updates and a
 * mouseup could read stale state, leaving the arm timer running (design handoff
 * calls this out explicitly). After a successful arm, the click that fires on the
 * same mouseup is ignored for ~450ms so it can't immediately toggle back down.
 */

import { useEffect, useRef, useState } from "react";
import { saveAutonomy, loadAutonomy, type AutonomyKey } from "@/shared/autonomy";
import { broadcastAutonomy } from "./launch";
import { C, FONT, panelHead, headTick, headLabel, headCaption } from "./ccTheme";

const DETENT_KEYS: AutonomyKey[] = ["observe", "approve", "operator", "full"];

/**
 * The dial governs UNATTENDED runs only - flows, overnight waves, schedulers,
 * anything still working after the owner walks away. It has no effect whatsoever on
 * live computer use: what he says out loud, while watching the screen, runs the
 * same at I · OBSERVE as at IV · SOVEREIGN. Every description below is therefore
 * about what Praxis does WHEN HE IS NOT LOOKING.
 */
const LEVELS = [
  { n: 1, r: "I", name: "OBSERVE", desc: "watches and reports while you're away. touches nothing." },
  { n: 2, r: "II", name: "PROPOSE", desc: "works while you're away — but every step waits for your yes." },
  { n: 3, r: "III", name: "EXECUTE", desc: "works alone. stops to ask before money, sign-ins, posts and sends." },
  { n: 4, r: "IV", name: "SOVEREIGN", desc: "works alone and asks nothing. pays, signs in, submits. HALT still stops it." },
] as const;

/** Shown under the dial so the scale can't be mistaken for a master switch. */
const SCOPE_NOTE = "governs unattended runs · what you ask for out loud is never gated";

const ANGLES = [-120, -40, 40, 120];

/** Current 1-based detent from the persisted autonomy key (legacy "suggest" → II).
 *  Exported so App.tsx can seed its own `trust` state from the SAME real, persisted
 *  value on first paint - a hardcoded initial guess there let the sovereign badge
 *  flash the wrong detent before this panel's mount effect corrected it. */
export function detentFromAutonomy(): number {
  const key = loadAutonomy();
  const i = DETENT_KEYS.indexOf(key);
  if (i >= 0) return i + 1;
  return key === "suggest" ? 2 : 3;
}

export function TrustPanel({ onTrustChange }: { onTrustChange: (level: number) => void }) {
  const [trust, setTrustState] = useState<number>(detentFromAutonomy);
  const [arming, setArming] = useState(false);
  const [armHint, setArmHint] = useState(false);
  const armingRef = useRef(false); // synchronous gate - see module comment
  const armTimer = useRef<number | undefined>(undefined);
  const hintTimer = useRef<number | undefined>(undefined);
  const justArmed = useRef(0);
  const needleRef = useRef<SVGGElement | null>(null);
  const prevTrust = useRef(trust);
  // The whole gauge is one big click/drag target (a small per-detent hit circle
  // read as DEAD to a real, imprecise mouse - 2026-07-10 Codex live QA #5). `svgRef`
  // maps client → viewBox coords; `dragDetent` highlights the stop the pointer is
  // nearest to during a press/drag so it reads as obviously interactive.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pointerActive = useRef(false);
  const [dragDetent, setDragDetent] = useState<number | null>(null);

  useEffect(() => {
    onTrustChange(trust);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report once per change
  }, [trust]);

  // Needle springs between detents (WAAPI - the design's exact curve).
  useEffect(() => {
    const g = needleRef.current;
    if (g && prevTrust.current !== trust && typeof g.animate === "function") {
      try {
        g.animate(
          [{ transform: `rotate(${ANGLES[prevTrust.current - 1]}deg)` }, { transform: `rotate(${ANGLES[trust - 1]}deg)` }],
          { duration: 500, easing: "cubic-bezier(.34,1.3,.4,1)" },
        );
      } catch {
        /* non-animating environments fall back to the static transform */
      }
    }
    prevTrust.current = trust;
  }, [trust]);

  useEffect(
    () => () => {
      window.clearTimeout(armTimer.current);
      window.clearTimeout(hintTimer.current);
    },
    [],
  );

  const commit = (n: number) => {
    armingRef.current = false;
    window.clearTimeout(armTimer.current);
    setArming(false);
    setTrustState(n);
    const key = DETENT_KEYS[n - 1];
    saveAutonomy(key);
    void broadcastAutonomy(key);
  };

  const startArm = () => {
    if (trust === 4 || armingRef.current) return;
    armingRef.current = true;
    setArming(true);
    setArmHint(false);
    window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => {
      armingRef.current = false;
      justArmed.current = Date.now();
      setArming(false);
      commit(4);
    }, 750);
  };

  const cancelArm = () => {
    if (!armingRef.current) return;
    armingRef.current = false;
    window.clearTimeout(armTimer.current);
    setArming(false);
    setArmHint(true);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setArmHint(false), 1600);
  };

  const clickFour = () => {
    if (Date.now() - justArmed.current < 450) return;
    if (trust === 4) commit(3); // tap a lower detent to stand down - or tap IV again
  };

  // ── Gauge as one big click/drag target ──────────────────────────────────
  // Detent centres in viewBox coords (where each stop meets the arc).
  const DETENTS: [number, number, number][] = [
    [1, 54.2, 150],
    [2, 71.1, 53.8],
    [3, 168.9, 53.8],
    [4, 185.8, 150],
  ];
  const HIT_RADIUS = 42; // viewBox units - forgiving; stops sit ≥96 apart so no overlap

  /** Nearest detent to a client point, or null when the pointer is off in dead space
   *  (e.g. the centre readout) so an idle tap can't jump the leash. */
  const detentAt = (clientX: number, clientY: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // The SVG carries no fixed height, so its box keeps the 240×170 viewBox aspect
    // (no letterboxing) and this linear map is exact - CSS zoom scales rect AND
    // pointer together, so the ratio is zoom-invariant.
    const vx = ((clientX - rect.left) / rect.width) * 240;
    const vy = ((clientY - rect.top) / rect.height) * 170;
    let best: number | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (const [n, cx, cy] of DETENTS) {
      const d = (vx - cx) ** 2 + (vy - cy) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  };

  const gaugeDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const n = detentAt(e.clientX, e.clientY);
    if (n == null) return;
    e.preventDefault();
    pointerActive.current = true;
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported - a plain click still commits on release */
    }
    setDragDetent(n);
    if (n === 4) startArm(); // IV keeps the deliberate 750ms hold-to-arm
  };
  const gaugeMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointerActive.current) return;
    const n = detentAt(e.clientX, e.clientY);
    if (n == null) return;
    if (n === 4) {
      if (!armingRef.current && trust !== 4) startArm(); // slid onto IV - begin arming
    } else if (armingRef.current) {
      cancelArm(); // slid off IV before the hold finished
    }
    setDragDetent(n);
  };
  const gaugeUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointerActive.current) return;
    pointerActive.current = false;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    const n = detentAt(e.clientX, e.clientY);
    setDragDetent(null);
    if (n == null || n === 4) {
      cancelArm(); // released in dead space, or on IV without the full hold → no jump
      return;
    }
    commit(n); // I / II / III commit on release - click OR drag, from any detent
  };

  const sovereign = trust === 4;
  const lvl = LEVELS[trust - 1];
  const needleColor = sovereign ? C.amethystLt : C.sapphire;
  const arcColor = sovereign ? C.amethyst : C.sapphire;
  const numColor = (n: number) =>
    trust === n ? (n === 4 ? C.amethystLt : C.sapphireLt) : dragDetent === n ? C.sapphireLt : "rgba(233,226,211,.4)";

  return (
    <div style={{ flex: "none", background: C.panel }}>
      <div style={panelHead}>
        <span style={headTick("rgba(155,92,246,.85)")} />
        <span style={headLabel}>TRUST</span>
        <span style={{ flex: 1 }} />
        <span style={headCaption}>how far it may go</span>
      </div>

      <div style={{ padding: "8px 20px 0" }}>
        <svg
          ref={svgRef}
          viewBox="0 0 240 170"
          onPointerDown={gaugeDown}
          onPointerMove={gaugeMove}
          onPointerUp={gaugeUp}
          onPointerCancel={gaugeUp}
          style={{ width: "100%", display: "block", userSelect: "none", cursor: "pointer", touchAction: "none" }}
        >
          <path d="M 54.2 150 A 76 76 0 1 1 185.8 150" fill="none" stroke="rgba(233,220,196,.13)" strokeWidth="1.5" />
          <path
            d="M 54.2 150 A 76 76 0 1 1 185.8 150"
            fill="none"
            stroke={arcColor}
            strokeWidth="1.5"
            pathLength={100}
            strokeDasharray={`${((trust - 1) * 33.34).toFixed(1)} 100`}
            opacity=".85"
          />
          <line x1="61.1" y1="146" x2="49" y2="153" stroke="rgba(233,220,196,.35)" strokeWidth="1.5" />
          <line x1="76.3" y1="59.9" x2="67.3" y2="49.2" stroke="rgba(233,220,196,.35)" strokeWidth="1.5" />
          <line x1="163.7" y1="59.9" x2="172.7" y2="49.2" stroke="rgba(233,220,196,.35)" strokeWidth="1.5" />
          <line x1="178.9" y1="146" x2="191" y2="153" stroke="rgba(233,220,196,.35)" strokeWidth="1.5" />
          <line x1="49.1" y1="99.5" x2="44.2" y2="98.6" stroke="rgba(233,220,196,.15)" strokeWidth="1" />
          <line x1="120" y1="40" x2="120" y2="35" stroke="rgba(233,220,196,.15)" strokeWidth="1" />
          <line x1="190.9" y1="99.5" x2="195.8" y2="98.6" stroke="rgba(233,220,196,.15)" strokeWidth="1" />
          <text x="36.9" y="163" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill={numColor(1)}>
            I
          </text>
          <text x="58.3" y="42.5" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill={numColor(2)}>
            II
          </text>
          <text x="181.7" y="42.5" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill={numColor(3)}>
            III
          </text>
          <text x="203.1" y="163" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill={numColor(4)}>
            IV
          </text>
          {arming && (
            <circle
              cx="185.8"
              cy="150"
              r="10"
              fill="none"
              stroke={C.amethystLt}
              strokeWidth="2"
              pathLength={100}
              strokeDasharray="100 100"
              strokeDashoffset={100}
              transform="rotate(-90 185.8 150)"
              style={{ animation: "pxArm .75s linear forwards" }}
            />
          )}
          <g ref={needleRef} style={{ transform: `rotate(${ANGLES[trust - 1]}deg)`, transformOrigin: "120px 112px" }}>
            <line x1="120" y1="112" x2="120" y2="48" stroke={needleColor} strokeWidth="2" />
            <line x1="120" y1="112" x2="120" y2="124" stroke={needleColor} strokeWidth="2" opacity=".4" />
          </g>
          <circle cx="120" cy="112" r="4.5" fill={C.panel} stroke={needleColor} strokeWidth="1.5" />
          <text x="120" y="150" textAnchor="middle" fontFamily="Newsreader, Georgia, serif" fontSize="26" fill={sovereign ? C.amethystLt : C.ink}>
            {lvl.r}
          </text>
          <text x="120" y="164" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="8" letterSpacing="3" fill="rgba(233,226,211,.5)">
            {lvl.name}
          </text>
          {/* Visible detent pips - the four selectable stops. Pointer events pass
              straight through to the SVG's own click/drag handler above (the entire
              gauge is the hit target now, so a real, imprecise click always lands). */}
          {DETENTS.map(([n, cx, cy]) => {
            const active = trust === n;
            const hot = dragDetent === n && !active;
            const fill = active ? (n === 4 ? C.amethystLt : C.sapphireLt) : hot ? C.sapphireLt : "rgba(233,220,196,.34)";
            return (
              <g key={n} style={{ pointerEvents: "none" }}>
                {(active || hot) && <circle cx={cx} cy={cy} r={6.5} fill="none" stroke={fill} strokeWidth="1" opacity={active ? 0.5 : 0.35} />}
                <circle cx={cx} cy={cy} r={active || hot ? 3.4 : 2.4} fill={fill} />
              </g>
            );
          })}
        </svg>
      </div>

      {LEVELS.map((l) => {
        const sel = trust === l.n;
        const four = l.n === 4;
        return (
          <div
            key={l.n}
            className="px-hover-row"
            onClick={four ? clickFour : () => commit(l.n)}
            onMouseDown={four ? startArm : undefined}
            onMouseUp={four ? cancelArm : undefined}
            onMouseLeave={four ? cancelArm : undefined}
            onTouchStart={four ? startArm : undefined}
            onTouchEnd={four ? cancelArm : undefined}
            style={{
              display: "grid",
              gridTemplateColumns: "24px 82px minmax(0,1fr)",
              gap: 8,
              alignItems: "baseline",
              padding: "7px 14px",
              background: sel ? C.rowHover : "transparent",
              borderTop: "1px solid rgba(233,220,196,.05)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <span style={{ fontFamily: FONT.serif, fontSize: 16, lineHeight: 1.1, color: sel ? (four ? C.amethystLt : C.sapphireLt) : "rgba(233,226,211,.45)" }}>
              {l.r}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: ".12em", color: sel ? C.ink : "rgba(233,226,211,.6)" }}>{l.name}</span>
            <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 11.5, lineHeight: 1.4, color: "rgba(233,226,211,.44)" }}>{l.desc}</span>
          </div>
        );
      })}

      {/* The scale is not a master switch. Without this line, a dial reading
          I · OBSERVE looks like it has switched computer use off - and it used to
          do exactly that, which is the coupling this build removed. */}
      <div
        style={{
          padding: "7px 14px",
          borderTop: "1px solid rgba(233,220,196,.05)",
          fontFamily: FONT.serif,
          fontStyle: "italic",
          fontSize: 10.5,
          lineHeight: 1.45,
          letterSpacing: ".01em",
          color: "rgba(233,226,211,.34)",
        }}
      >
        {SCOPE_NOTE}
      </div>

      {!sovereign && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 14px", borderTop: "1px solid rgba(233,220,196,.05)" }}>
          <span style={{ width: 4, height: 4, borderRadius: "50%", background: arming ? C.amethystLt : armHint ? C.pink : C.faint }} />
          <span style={{ fontSize: 8.5, letterSpacing: ".14em", color: arming ? C.amethystLt : armHint ? C.pink : C.faint }}>
            {arming ? "ARMING… KEEP HOLDING IV" : armHint ? "HELD TOO BRIEFLY — HOLD IV TO ARM" : "HOLD IV TO ARM FULL AUTONOMY"}
          </span>
        </div>
      )}
      {sovereign && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "9px 14px",
            borderTop: "1px solid rgba(155,92,246,.3)",
            background: "rgba(155,92,246,.06)",
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: C.amethystLt,
              boxShadow: "0 0 7px rgba(185,140,255,.6)",
              animation: "pxPulse 1.6s ease-in-out infinite",
            }}
          />
          <span style={{ fontSize: 9.5, letterSpacing: ".1em", color: "rgba(185,140,255,.9)" }}>
            <span style={{ color: "#d9c4ff", fontWeight: 600 }}>ARMED · </span>praxis may pay, install, post, send. tap a lower detent to stand down.
          </span>
        </div>
      )}
    </div>
  );
}
