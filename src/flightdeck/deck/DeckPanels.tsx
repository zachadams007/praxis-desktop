/**
 * Flight Deck v3 - the two bottom pull-up panels, 1:1 from the design package:
 *
 *   • CodeLanesPanel - worktree topology, DATA-DRIVEN from the live DeckModel
 *     (real repos, real worktrees, real occupants). Redraws as the model does.
 *   • AgentFlowPanel - "how Praxis works, end to end": an authored map whose
 *     volatile actor/model/rail facts come from fleet config. Atlas validates
 *     those facts daily; the build contract guards the ported package sections,
 *     and topology/trust seams remain live.
 *
 * Honesty deltas from the package: the Quartz vault box carries no invented
 * artifact counts, and the header shows a durable validation stamp instead of
 * the package's fake clock.
 */
import { activateDeckControl } from '@/flightdeck/deck/a11y';
import React from 'react';
import type { PlanNames } from '../api';
import type { DeckModel, DeckSession } from './model';
import { AGENT_META, laneDiffLabel } from './model';
import {
  buildAgentFlowManifest,
  formatAtlasCheckTime,
  recordAtlasFlowCheck,
} from './agentFlowManifest';
import { COLORS, withAlpha } from './tokens';

const RED = COLORS.red;
const serif: React.CSSProperties = { fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic' };

function Grip({ onDrag }: { onDrag: (e: React.MouseEvent) => void }): React.ReactElement {
  return (
    <div className="fd-hov-band" onMouseDown={onDrag} title="drag to resize" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '7px 0 4px', flex: 'none', cursor: 'ns-resize', userSelect: 'none' }}>
      <span style={{ width: 56, height: 4, borderRadius: 99, background: withAlpha(COLORS.line, 0.32) }} />
      <span style={{ fontSize: 6, letterSpacing: '.22em', color: COLORS.textFaintest }}>⇕ DRAG</span>
    </div>
  );
}

// ── Code Lanes (worktree topology) ────────────────────────────────────────────

interface LanesProps {
  style: React.CSSProperties;
  onDrag: (e: React.MouseEvent) => void;
  onClose: () => void;
  model: DeckModel;
  byLane: Record<string, DeckSession[]>;
  collLanes: Record<string, DeckSession[]>;
  /** Open the repo's next lane for real (git worktree add). The row below used to
   *  be a plain div captioned "praxis does it" with no handler and no command
   *  behind it - the deck had never run `git worktree add` at all. */
  onAddLane: (repoRoot: string, letter: string) => void;
}

export function CodeLanesPanel({ style, onDrag, onClose, model, byLane, collLanes, onAddLane }: LanesProps): React.ReactElement {
  return (
    <div ref={(el) => { if (el) el.inert = style.pointerEvents === 'none'; }} data-screen-label="Code Lanes panel" style={style}>
      <Grip onDrag={onDrag} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '4px 28px 13px', borderBottom: `1px solid ${withAlpha(COLORS.line, 0.08)}`, flex: 'none' }}>
        <span style={{ ...serif, fontSize: 19, color: COLORS.textBright }}>Code Lanes</span>
        <span style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.textFaint }}>WORKTREE TOPOLOGY</span>
        <span style={{ ...serif, fontSize: 12, color: COLORS.textFaint }}>where every branch lives, and who's standing in it</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: COLORS.statusWorking, boxShadow: `0 0 7px ${withAlpha(COLORS.statusWorking, 0.8)}` }} />
          <span style={{ fontSize: 7.5, letterSpacing: '.14em', color: COLORS.statusWorking }}>LIVE FROM WORKTREE DATA</span>
          <span style={{ fontSize: 7.5, letterSpacing: '.14em', color: COLORS.textFaint }}>· REDRAWN AS SESSIONS MOVE</span>
        </span>
        <button type="button" aria-label="Close Code Lanes" className="fd-control fd-hov-x" style={{ fontSize: 11, color: COLORS.textFaint, cursor: 'pointer', padding: '2px 8px' }} onClick={onClose}>✕</button>
      </div>
      <div data-scroll="1" style={{ flex: 1, overflowY: 'auto', padding: '18px 28px 24px' }}>
        {model.repos.map((r) => {
          const rlanes = model.lanes.filter((l) => l.repoId === r.id);
          const nextLetter = `LANE ${String.fromCharCode(65 + rlanes.filter((l) => !l.isIntegration).length)}`;
          return (
            <div key={r.id} style={{ border: `1px solid ${withAlpha(COLORS.line, 0.12)}`, borderRadius: 14, background: 'rgba(10,13,24,.5)', padding: '16px 20px 12px', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ ...serif, fontSize: 16, color: COLORS.text }}>{r.name}</span>
                <span style={{ fontSize: 8, color: COLORS.textFaintest, letterSpacing: '.08em' }}>{r.path}</span>
                <span style={{ fontSize: 7, letterSpacing: '.16em', color: COLORS.textFainter, border: `1px dashed ${withAlpha(COLORS.line, 0.25)}`, borderRadius: 99, padding: '3px 8px', whiteSpace: 'nowrap' }}>
                  {rlanes.length} LANE SLOT{rlanes.length === 1 ? '' : 'S'} · AUTO-DISCOVERED
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 8, color: COLORS.textMuted, letterSpacing: '.1em', border: `1px solid ${withAlpha(COLORS.line, 0.16)}`, borderRadius: 99, padding: '3px 9px' }}>{r.mainLine}</span>
              </div>
              <div style={{ position: 'relative', marginTop: 10, paddingLeft: 8 }}>
                <div style={{ position: 'absolute', left: 13, top: 4, bottom: 10, width: 2, background: `linear-gradient(180deg,${withAlpha(COLORS.accent, 0.4)},${withAlpha(COLORS.line, 0.1)})`, borderRadius: 2 }} />
                {rlanes.map((l) => {
                  const occ = byLane[l.id] ?? [];
                  const coll = Boolean(collLanes[l.id]);
                  let state = 'IDLE';
                  let c = COLORS.textIdle;
                  if (coll) {
                    state = `${(collLanes[l.id] ?? []).length} WRITERS — SERIALIZE OR SPLIT`;
                    c = RED;
                  } else if (occ.some((x) => x.status === 'blocked')) {
                    state = 'AWAITING APPROVAL';
                    c = COLORS.statusPending;
                  } else if (occ.some((x) => x.status === 'working')) {
                    state = 'WORKING';
                    c = COLORS.statusWorking;
                  } else if (occ.some((x) => x.status === 'done')) {
                    state = 'RECENTLY LANDED';
                    c = COLORS.accent;
                  }
                  return (
                    <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44, position: 'relative', borderRadius: 8, paddingRight: 6, background: coll ? withAlpha(COLORS.red, 0.05) : 'transparent' }}>
                      <span style={{ width: 22, height: 2, background: withAlpha(COLORS.line, 0.25), flex: 'none', marginLeft: 6 }} />
                      <span
                        style={{
                          fontSize: 8.5,
                          fontWeight: 700,
                          letterSpacing: '.14em',
                          color: coll ? COLORS.redText : COLORS.textLilac,
                          border: `1px solid ${coll ? withAlpha(COLORS.red, 0.5) : `${r.hue}4d`}`,
                          borderRadius: 8,
                          padding: '4px 10px',
                          background: `linear-gradient(135deg, ${r.hue}14, rgba(12,16,30,.85) 60%)`,
                          flex: 'none',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {l.letter}
                      </span>
                      <span style={{ fontSize: 8.5, color: COLORS.textFaint, flex: 'none' }}>{l.branch ? `⎇ ${l.branch} · ` : ''}{l.wt}</span>
                      {laneDiffLabel(l.diff) && (
                        <span style={{ fontSize: 8, color: COLORS.textFaintBlue, flex: 'none', letterSpacing: '.04em', whiteSpace: 'nowrap' }} title="lines changed vs base · commits ahead">
                          {laneDiffLabel(l.diff)}
                        </span>
                      )}
                      <span style={{ flex: 1, height: 1, background: `repeating-linear-gradient(90deg,${withAlpha(COLORS.line, 0.18)} 0 5px,transparent 5px 11px)`, minWidth: 18 }} />
                      {occ.map((o) => (
                        <span
                          key={o.id}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${AGENT_META[o.agent].color}40`, color: AGENT_META[o.agent].color, fontSize: 7.5, letterSpacing: '.06em', borderRadius: 99, padding: '3px 8px', background: `${AGENT_META[o.agent].color}0d`, flex: 'none', whiteSpace: 'nowrap' }}
                        >
                          {AGENT_META[o.agent].glyph} {o.name.toLowerCase()}
                        </span>
                      ))}
                      <span style={{ flex: 1, height: 1, background: `repeating-linear-gradient(90deg,${withAlpha(COLORS.line, 0.18)} 0 5px,transparent 5px 11px)`, minWidth: 18 }} />
                      <span style={{ fontSize: 8.5, color: COLORS.textFaint, flex: 'none' }}>
                        {occ.length} SESSION{occ.length === 1 ? '' : 'S'}
                      </span>
                      <span style={{ fontSize: 7, letterSpacing: '.12em', color: c, border: `1px solid ${c}4d`, borderRadius: 99, padding: '3px 9px', flex: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}>{state}</span>
                    </div>
                  );
                })}
                <div role="button" tabIndex={0} onKeyDown={activateDeckControl} aria-label={`Open ${nextLetter} for ${r.name}`}
                  onClick={() => onAddLane(r.root, nextLetter.replace(/^LANE\s+/i, ''))}
                  title={`open ${nextLetter} — runs git worktree add on ${r.name}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, paddingRight: 6, opacity: 0.85, cursor: 'pointer' }}
                >
                  <span style={{ width: 22, height: 2, background: withAlpha(COLORS.line, 0.12), flex: 'none', marginLeft: 6 }} />
                  <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.14em', color: COLORS.textFainter, border: `1px dashed ${withAlpha(COLORS.line, 0.3)}`, borderRadius: 8, padding: '4px 10px', flex: 'none', whiteSpace: 'nowrap' }}>{nextLetter}</span>
                  <span style={{ ...serif, fontSize: 11.5, color: COLORS.textFaintest }}>click to open it — praxis runs git worktree add</span>
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ ...serif, fontSize: 12.5, color: COLORS.textFainter, textAlign: 'center', padding: '6px 0 2px' }}>
          nothing here is hand-drawn — praxis reads the git worktrees and redraws this as sessions move. lanes are generic slots: sessions come and go, the letters stay, new slots open on demand.
        </div>
      </div>
    </div>
  );
}

// ── Agent Flow (static authored map, live seams marked) ──────────────────────

interface FlowProps {
  style: React.CSSProperties;
  onDrag: (e: React.MouseEvent) => void;
  onClose: () => void;
  model: DeckModel;
  collLanes: Record<string, DeckSession[]>;
  coreImg: string;
  trustLine: string;
  /** Live plan tier per provider for the configured actor/provider facts. */
  planNames: PlanNames;
}

const box = (l: number, t: number, w: number, h: number, extra?: React.CSSProperties): React.CSSProperties => ({
  position: 'absolute',
  left: l,
  top: t,
  width: w,
  height: h,
  borderRadius: 12,
  padding: '11px 13px',
  ...extra,
});
const tag = (l: number, t: number, dim = true): React.CSSProperties => ({
  position: 'absolute',
  left: l,
  top: t,
  fontSize: 6,
  letterSpacing: '.26em',
  color: dim ? COLORS.textFaintest : COLORS.textDim2,
  background: dim ? 'rgba(4,6,13,.9)' : 'rgba(4,6,13,.95)',
  padding: '2px 6px',
  borderRadius: 4,
});
const lbl = (l: number, t: number, color = COLORS.textFainter): React.CSSProperties => ({
  position: 'absolute',
  left: l,
  top: t,
  fontSize: 6.5,
  letterSpacing: '.18em',
  color,
  background: 'rgba(10,13,26,.95)',
  padding: '2px 7px',
  borderRadius: 99,
});
const h1 = (color: string): React.CSSProperties => ({ fontSize: 9.5, fontWeight: 700, letterSpacing: '.18em', color });
const sub: React.CSSProperties = { ...serif, fontSize: 12, color: COLORS.textMuted, marginTop: 2 };
const body: React.CSSProperties = { fontSize: 7, color: COLORS.textFaint, marginTop: 7, letterSpacing: '.12em', lineHeight: 1.9 };

function marker(id: string, stroke: string): React.ReactElement {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" markerUnits="strokeWidth" orient="auto-start-reverse">
      <path d="M1.5,1.5 L8.5,5 L1.5,8.5" fill="none" stroke={stroke} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    </marker>
  );
}

export function AgentFlowPanel({ style, onDrag, onClose, model, collLanes, coreImg, trustLine, planNames }: FlowProps): React.ReactElement {
  const collN = Object.keys(collLanes).length;
  const flowManifest = buildAgentFlowManifest(planNames);
  const [atlasCheck, setAtlasCheck] = React.useState(() => recordAtlasFlowCheck(flowManifest));
  React.useEffect(() => {
    let active = true;
    let timer = 0;
    const checkAndSchedule = () => {
      const checked = recordAtlasFlowCheck(flowManifest);
      if (!active) return;
      setAtlasCheck(checked);
      const delay = Math.max(1_000, checked.nextCheckAt - Date.now() + 1_000);
      timer = window.setTimeout(checkAndSchedule, delay);
    };
    checkAndSchedule();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [flowManifest.fingerprint]);
  const flow = flowManifest.facts;
  const checkTone = atlasCheck.ok ? COLORS.statusWorking : COLORS.statusPending;
  const trustLevel = trustLine.includes('IV') ? 'IV' : trustLine.includes('III') ? 'III' : trustLine.includes('II') ? 'II' : 'I';
  const gateChip = (lv: string): React.CSSProperties =>
    lv === trustLevel
      ? { fontSize: 7, color: COLORS.accentBright, border: `1px solid ${withAlpha(COLORS.accent, 0.55)}`, borderRadius: 5, padding: '2px 5px', background: 'rgba(112,80,220,.18)' }
      : { fontSize: 7, color: COLORS.textFainter, border: `1px solid ${withAlpha(COLORS.line, 0.18)}`, borderRadius: 5, padding: '2px 5px' };
  return (
    <div ref={(el) => { if (el) el.inert = style.pointerEvents === 'none'; }} data-screen-label="Agent Flow panel" style={style}>
      <Grip onDrag={onDrag} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '4px 28px 13px', borderBottom: `1px solid ${withAlpha(COLORS.line, 0.08)}`, flex: 'none', flexWrap: 'wrap' }}>
        <span style={{ ...serif, fontSize: 19, color: COLORS.textBright }}>Agent Flow</span>
        <span style={{ fontSize: 7.5, letterSpacing: '.24em', color: COLORS.textFaint }}>HOW PRAXIS WORKS, END TO END</span>
        <span style={{ ...serif, fontSize: 12, color: COLORS.textFaint }}>two ways in — talk or mission · one gated door out to the world</span>
        <span style={{ flex: 1 }} />
        <span
          data-agent-flow-check={atlasCheck.ok ? 'verified' : 'warning'}
          title={atlasCheck.ok ? 'Atlas checked every configured diagram actor. Package sections are guarded by the build contract.' : atlasCheck.issues.join(' · ')}
          style={{ fontSize: 7.5, letterSpacing: '.12em', color: checkTone, whiteSpace: 'nowrap' }}
        >
          ● ATLAS {atlasCheck.ok ? 'CHECKED' : 'FOUND CONFIG GAPS'} {formatAtlasCheckTime(atlasCheck.checkedAt)} · {atlasCheck.factCount} CONFIG FACTS · PACKAGE CONTRACT {atlasCheck.packagePortCount} PORTS
        </span>
        <button
          type="button"
          className="fd-control"
          aria-label="Run Atlas Agent Flow check now"
          onClick={() => setAtlasCheck(recordAtlasFlowCheck(flowManifest, Date.now(), true))}
          style={{ fontSize: 7, letterSpacing: '.14em', color: COLORS.textDim, border: `1px solid ${withAlpha(COLORS.line, 0.2)}`, borderRadius: 7, padding: '4px 8px', cursor: 'pointer' }}
        >
          CHECK NOW
        </button>
        <button type="button" aria-label="Close Agent Flow" className="fd-control fd-hov-x" style={{ fontSize: 11, color: COLORS.textFaint, cursor: 'pointer', padding: '2px 8px' }} onClick={onClose}>✕</button>
      </div>
      <div data-scroll="1" style={{ flex: 1, overflow: 'auto', padding: '8px 24px 18px' }}>
        <div style={{ position: 'relative', width: 1560, height: 960, margin: '0 auto' }}>
          <svg width="1560" height="960" style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
            <defs>
              {marker('fdmA', 'rgba(246,193,119,.75)')}
              {marker('fdmW', withAlpha(COLORS.textValue, 0.7))}
              {marker('fdmWD', withAlpha(COLORS.textValue, 0.55))}
              {marker('fdmG', 'rgba(154,163,196,.75)')}
              {marker('fdmF', 'rgba(255,157,122,.7)')}
              {marker('fdmV', 'rgba(98,219,232,.7)')}
              {marker('fdmQ', 'rgba(111,157,255,.7)')}
              {marker('fdmGr', withAlpha(COLORS.statusWorking, 0.7))}
              {marker('fdmP', withAlpha(COLORS.accent, 0.75))}
              {marker('fdmT', 'rgba(94,234,212,.7)')}
              {marker('fdmS', 'rgba(168,224,110,.65)')}
              {marker('fdmH', 'rgba(232,121,249,.7)')}
              {marker('fdmSa', 'rgba(255,122,194,.65)')}
            </defs>
            <path d="M190,185 C235,185 258,95 300,95" fill="none" markerEnd="url(#fdmA)" style={{ stroke: 'rgba(246,193,119,.55)', strokeWidth: 1.5 }} />
            <path d="M300,140 C258,140 235,235 190,235" fill="none" markerEnd="url(#fdmWD)" style={{ stroke: withAlpha(COLORS.textValue, 0.38), strokeWidth: 1.5, strokeDasharray: '6 6' }} />
            <path d="M190,255 C240,255 252,330 300,330" fill="none" markerEnd="url(#fdmW)" style={{ stroke: withAlpha(COLORS.textValue, 0.5), strokeWidth: 1.5 }} />
            <path d="M425,170 L425,250" fill="none" markerEnd="url(#fdmA)" style={{ stroke: 'rgba(246,193,119,.55)', strokeWidth: 1.5 }} />
            <path d="M690,130 C650,190 575,220 512,247" fill="none" markerEnd="url(#fdmG)" style={{ stroke: 'rgba(154,163,196,.55)', strokeWidth: 1.5, strokeDasharray: '2 5' }} />
            <path d="M550,290 C592,290 608,295 650,295" fill="none" markerEnd="url(#fdmF)" style={{ stroke: 'rgba(255,157,122,.5)', strokeWidth: 1.5 }} />
            <path d="M550,340 C606,340 600,425 650,425" fill="none" markerEnd="url(#fdmV)" style={{ stroke: 'rgba(98,219,232,.5)', strokeWidth: 1.5 }} />
            <path d="M550,390 C610,390 596,555 650,555" fill="none" markerEnd="url(#fdmQ)" style={{ stroke: 'rgba(111,157,255,.5)', strokeWidth: 1.5 }} />
            <path d="M850,295 L900,295" fill="none" markerEnd="url(#fdmF)" style={{ stroke: 'rgba(255,157,122,.42)', strokeWidth: 1.5 }} />
            <path d="M850,425 L900,425" fill="none" markerEnd="url(#fdmV)" style={{ stroke: 'rgba(98,219,232,.42)', strokeWidth: 1.5 }} />
            <path d="M850,555 L900,555" fill="none" markerEnd="url(#fdmQ)" style={{ stroke: 'rgba(111,157,255,.42)', strokeWidth: 1.5 }} />
            <path d="M1090,295 C1118,295 1124,340 1150,340" fill="none" markerEnd="url(#fdmF)" style={{ stroke: 'rgba(255,157,122,.38)', strokeWidth: 1.5 }} />
            <path d="M1090,425 L1150,425" fill="none" markerEnd="url(#fdmV)" style={{ stroke: 'rgba(98,219,232,.38)', strokeWidth: 1.5 }} />
            <path d="M1090,555 C1118,555 1124,510 1150,510" fill="none" markerEnd="url(#fdmQ)" style={{ stroke: 'rgba(111,157,255,.38)', strokeWidth: 1.5 }} />
            <path d="M1350,435 L1400,435" fill="none" markerEnd="url(#fdmGr)" style={{ stroke: withAlpha(COLORS.statusWorking, 0.5), strokeWidth: 1.5 }} />
            <path d="M1477,490 L1477,908 Q1477,922 1463,922 L494,922 Q480,922 480,908 L480,436" fill="none" markerEnd="url(#fdmP)" style={{ stroke: withAlpha(COLORS.accent, 0.55), strokeWidth: 1.5, strokeDasharray: '6 6' }} />
            <path d="M300,415 C230,432 105,430 105,490 L105,690" fill="none" markerEnd="url(#fdmP)" style={{ stroke: withAlpha(COLORS.accent, 0.55), strokeWidth: 1.5 }} />
            <path d="M60,300 L60,535 Q60,558 76,565" fill="none" markerEnd="url(#fdmW)" style={{ stroke: withAlpha(COLORS.textValue, 0.5), strokeWidth: 1.5, strokeDasharray: '6 6' }} />
            <path d="M530,430 C560,505 590,580 620,660" fill="none" markerStart="url(#fdmT)" markerEnd="url(#fdmT)" style={{ stroke: 'rgba(94,234,212,.5)', strokeWidth: 1.5, strokeDasharray: '6 6' }} />
            <path d="M860,782 C830,782 806,764 780,750" fill="none" markerEnd="url(#fdmS)" style={{ stroke: 'rgba(168,224,110,.45)', strokeWidth: 1.5 }} />
            <path d="M860,872 C824,872 800,832 782,792" fill="none" markerEnd="url(#fdmH)" style={{ stroke: 'rgba(232,121,249,.5)', strokeWidth: 1.5, strokeDasharray: '6 6' }} />
            <path d="M1060,690 C1096,690 1114,697 1150,701" fill="none" markerEnd="url(#fdmSa)" style={{ stroke: 'rgba(255,122,194,.45)', strokeWidth: 1.5 }} />
            <path d="M105,150 L105,34 Q105,22 119,22 L1156,22 Q1170,22 1170,36 L1170,300" fill="none" markerEnd="url(#fdmWD)" style={{ stroke: withAlpha(COLORS.textValue, 0.38), strokeWidth: 1.5, strokeDasharray: '5 7' }} />
            <path d="M139,570 L152,570" fill="none" style={{ stroke: withAlpha(COLORS.accent, 0.3), strokeWidth: 1 }} />
          </svg>

          {/* OPERATOR */}
          <div style={box(20, 150, 170, 150, { border: `1px dashed ${withAlpha(COLORS.textValue, 0.35)}`, background: 'rgba(12,16,30,.85)', padding: '12px 14px' })}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.18em', color: COLORS.textValue }}>◈ YOU</div>
            <div style={sub}>the operator</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 10, lineHeight: 1.9, letterSpacing: '.1em' }}>
              TWO WAYS IN —<br />TALK FAST · MISSION DEEP<br />ONE VETO OVER THE DOOR OUT
            </div>
          </div>

          {/* ATLAS */}
          <div style={box(300, 40, 250, 130, { border: '1px solid rgba(246,193,119,.4)', borderRadius: 14, background: 'rgba(22,17,10,.85)', padding: '12px 14px' })}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.2em', color: COLORS.flowAtlas }}>◎ ATLAS</div>
            <div style={sub}>{flow.atlas.role} — the fast lane</div>
            <div style={{ fontSize: 6.8, color: COLORS.textDim, marginTop: 8, lineHeight: 1.9, letterSpacing: '.1em' }}>
              {flow.atlas.model.toUpperCase()} · {flow.atlas.rail}<br />OPENAI REALTIME · INSTANT ANSWERS<br />“WATCH ME” SCREEN-WATCHING<br />LIGHT COMPUTER USE · ORG SCANS
            </div>
          </div>

          {/* SELF-FIRING */}
          <div style={box(600, 40, 190, 90, { border: `1px solid ${withAlpha(COLORS.line, 0.22)}`, background: 'rgba(10,13,24,.8)', padding: '10px 12px' })}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: COLORS.textStrong }}>⏱ SELF-FIRING</div>
            <div style={{ ...serif, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>the clock, not you</div>
            <div style={{ fontSize: 6.5, color: COLORS.textFaint, marginTop: 6, lineHeight: 1.8, letterSpacing: '.1em' }}>6AM BOARD · RESEARCH CADENCE<br />ORG SCAN</div>
          </div>

          {/* legend */}
          <div style={box(1200, 40, 355, 158, { border: `1px solid ${withAlpha(COLORS.line, 0.18)}`, background: 'rgba(10,13,24,.6)', padding: '11px 14px' })}>
            <div style={{ fontSize: 6.5, letterSpacing: '.26em', color: COLORS.textFainter }}>READING THIS MAP</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 26, height: 0, borderTop: `2px solid ${withAlpha(COLORS.textValue, 0.55)}`, flex: 'none' }} /><span style={{ fontSize: 7, letterSpacing: '.12em', color: COLORS.textDim }}>SOLID — WORK MOVES FORWARD</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 26, height: 0, borderTop: `2px dashed ${withAlpha(COLORS.textValue, 0.55)}`, flex: 'none' }} /><span style={{ fontSize: 7, letterSpacing: '.12em', color: COLORS.textDim }}>DASHED — FEEDBACK · MANUAL</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 26, height: 0, borderTop: '2px dotted rgba(154,163,196,.8)', flex: 'none' }} /><span style={{ fontSize: 7, letterSpacing: '.12em', color: COLORS.textDim }}>DOTTED — SELF-FIRING (THE CLOCK)</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ display: 'flex', gap: 3, width: 26, flex: 'none' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: AGENT_META.forge.color }} />
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: AGENT_META.vega.color }} />
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: AGENT_META.quill.color }} />
                </span>
                <span style={{ fontSize: 7, letterSpacing: '.12em', color: COLORS.textDim }}>COLOR — AGENT IDENTITY</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 26, display: 'flex', justifyContent: 'center', flex: 'none' }}><span style={{ width: 9, height: 9, transform: 'rotate(45deg)', border: `1px solid ${withAlpha(COLORS.accent, 0.75)}`, flex: 'none' }} /></span>
                <span style={{ fontSize: 7, letterSpacing: '.12em', color: COLORS.textDim }}>DIAMOND — GATE, PASSED THROUGH</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 26, display: 'flex', justifyContent: 'center', flex: 'none' }}><span style={{ width: 18, height: 9, border: '1px solid rgba(94,234,212,.55)', borderRadius: '5px 5px 3px 3px', flex: 'none' }} /></span>
                <span style={{ fontSize: 7, letterSpacing: '.12em', color: COLORS.textDim }}>CYLINDER — MEMORY · DASHED BOX — YOU</span>
              </div>
            </div>
          </div>

          {/* PRAXIS */}
          <div style={box(300, 250, 250, 180, { border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, borderRadius: 14, background: 'rgba(14,13,32,.9)', padding: '13px 15px', boxShadow: '0 0 40px rgba(112,80,220,.15)' })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <img src={coreImg} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', boxShadow: '0 0 16px rgba(140,150,255,.6)', flex: 'none' }} />
              <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.22em', color: COLORS.text }}>PRAXIS</span>
            </div>
            <div style={sub}>the orchestrator</div>
            <div style={{ fontSize: 7.5, color: COLORS.textDim, marginTop: 9, lineHeight: 2, letterSpacing: '.1em' }}>
              INTENT → PLAN<br />SPAWN → ROUTE → WATCH<br />VERIFY → MERGE / RE-PLAN
            </div>
            <div style={{ display: 'inline-block', fontSize: 6.5, letterSpacing: '.16em', color: COLORS.accentBright, border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, borderRadius: 99, padding: '3px 8px', marginTop: 9 }}>{trustLine}</div>
          </div>

          {/* HANDS */}
          <div style={box(650, 250, 200, 90, { border: '1px solid rgba(255,157,122,.32)', background: 'rgba(20,14,14,.75)' })}>
            <div style={h1(AGENT_META.forge.color)}>◆ FORGE</div>
            <div style={sub}>{flow.forge.role}</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 7, letterSpacing: '.12em' }}>{flow.forge.model.toUpperCase()} · {flow.forge.rail}</div>
          </div>
          <div style={box(650, 380, 200, 90, { border: '1px solid rgba(98,219,232,.32)', background: 'rgba(11,19,24,.75)' })}>
            <div style={h1(AGENT_META.vega.color)}>▲ VEGA</div>
            <div style={sub}>{flow.vega.role}</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 7, letterSpacing: '.12em' }}>{flow.vega.model.toUpperCase()} · {flow.vega.rail}</div>
          </div>
          <div style={box(650, 510, 200, 90, { border: '1px solid rgba(111,157,255,.32)', background: 'rgba(12,15,26,.75)' })}>
            <div style={h1(AGENT_META.quill.color)}>◇ QUILL</div>
            <div style={sub}>{flow.quill.role}</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 7, letterSpacing: '.12em' }}>{flow.quill.model.toUpperCase()} · {flow.quill.rail}</div>
          </div>

          {/* PROVIDERS */}
          <div style={box(900, 265, 190, 60, { border: `1px solid ${withAlpha(COLORS.line, 0.25)}`, borderRadius: 4, background: 'rgba(10,13,24,.7)', padding: '10px 12px' })}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.16em', color: COLORS.textStrong }}>CLAUDE CODE</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 6, letterSpacing: '.1em' }}>{flow.forge.rail} · {flow.forge.wire === 'live' ? 'LIVE SEAM' : 'PREFERENCE'}</div>
          </div>
          <div style={box(900, 395, 190, 60, { border: `1px solid ${withAlpha(COLORS.line, 0.25)}`, borderRadius: 4, background: 'rgba(10,13,24,.7)', padding: '10px 12px' })}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.16em', color: COLORS.textStrong }}>CODEX CLI</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 6, letterSpacing: '.1em' }}>{flow.vega.rail} · {flow.vega.wire === 'live' ? 'LIVE SEAM' : 'PREFERENCE'}</div>
          </div>
          <div style={box(900, 525, 190, 60, { border: `1px solid ${withAlpha(COLORS.line, 0.25)}`, borderRadius: 4, background: 'rgba(10,13,24,.7)', padding: '10px 12px' })}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.16em', color: COLORS.textStrong }}>CURSOR CLI</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 6, letterSpacing: '.1em' }}>{flow.quill.rail} · {flow.quill.wire === 'live' ? 'LIVE SEAM' : 'PREFERENCE'}</div>
          </div>
          <div style={{ position: 'absolute', left: 900, top: 598, fontSize: 6.5, letterSpacing: '.14em', color: COLORS.textFainter, border: `1px solid ${withAlpha(COLORS.line, 0.14)}`, borderRadius: 99, padding: '3px 9px' }}>OVERFLOW → OPENROUTER · NVIDIA NIM</div>

          {/* WORKTREE LANES (live seams) */}
          <div style={box(1150, 300, 200, 250, { border: `1px solid ${withAlpha(COLORS.accent, 0.28)}`, background: 'rgba(12,14,28,.8)', padding: '12px 14px' })}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: COLORS.textStrong }}>⎇ WORKTREE LANES</div>
            <div style={sub}>isolated checkouts</div>
            <div style={{ fontSize: 6.8, color: COLORS.textFaint, marginTop: 9, letterSpacing: '.12em', lineHeight: 1.9 }}>◂ DIFFS LAND HERE<br />SLOTS OPEN ON DEMAND</div>
            <div style={{ display: 'flex', gap: 5, marginTop: 10, flexWrap: 'wrap' }}>
              {model.lanes.map((l) => (
                <span key={l.id} style={{ width: 24, height: 5, borderRadius: 2, background: collLanes[l.id] ? RED : withAlpha(COLORS.line, 0.35), flex: 'none' }} />
              ))}
            </div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 9, letterSpacing: '.12em', lineHeight: 2 }}>
              {model.lanes.length} LANES · {model.repos.length} REPOS
              <br />
              <span style={{ color: collN > 0 ? COLORS.redText : COLORS.statusWorking }}>{collN > 0 ? `${collN} COLLISION${collN === 1 ? '' : 'S'}` : 'ALL CLEAR'}</span>
            </div>
          </div>

          {/* LENS */}
          <div style={box(1400, 380, 155, 110, { border: `1px solid ${withAlpha(COLORS.statusWorking, 0.3)}`, background: 'rgba(10,18,14,.75)', padding: '11px 13px' })}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: COLORS.statusWorking }}>◉ LENS</div>
            <div style={{ ...serif, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>{flow.lens.role} — the proof step</div>
            <div style={{ fontSize: 6.5, color: COLORS.textFaint, marginTop: 7, lineHeight: 1.8, letterSpacing: '.1em' }}>{flow.lens.model.toUpperCase()} · {flow.lens.rail}<br />TESTS · VISUAL QA · DIFF REVIEW</div>
          </div>

          {/* TRUST GATE (real level highlighted) */}
          <div style={{ position: 'absolute', left: 81, top: 546, width: 48, height: 48, transform: 'rotate(45deg)', border: `1.5px solid ${withAlpha(COLORS.accent, 0.7)}`, background: 'rgba(10,9,22,.97)', boxShadow: '0 0 26px rgba(112,80,220,.3)' }}>
            <div style={{ position: 'absolute', inset: 5, border: `1px dashed ${withAlpha(COLORS.accent, 0.35)}` }} />
          </div>
          <div style={{ position: 'absolute', left: 81, top: 546, width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, color: COLORS.accentBright, textShadow: `0 0 12px ${withAlpha(COLORS.accent, 0.8)}` }}>⛨</div>
          <div style={{ position: 'absolute', left: 154, top: 540, width: 156 }}>
            <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.18em', color: COLORS.accentBright }}>TRUST GATE</div>
            <div style={{ display: 'flex', gap: 3, marginTop: 6, alignItems: 'center' }}>
              <span style={gateChip('I')}>I</span>
              <span style={gateChip('II')}>II</span>
              <span style={gateChip('III')}>III</span>
              <span style={gateChip('IV')}>IV</span>
            </div>
            <div style={{ fontSize: 6.5, color: COLORS.textDim2, letterSpacing: '.12em', marginTop: 6, lineHeight: 1.75 }}>A CHECKPOINT, NOT AN ACTOR —<br />DIAL + YOUR VETO CLEAR IT</div>
          </div>

          {/* REAL-WORLD EFFECTS */}
          <div style={box(20, 690, 170, 110, { border: `1px solid ${withAlpha(COLORS.accent, 0.34)}`, background: 'rgba(14,13,30,.9)', boxShadow: '0 0 26px rgba(112,80,220,.1)' })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <img src={coreImg} alt="" style={{ width: 15, height: 15, borderRadius: '50%', objectFit: 'cover', flex: 'none', boxShadow: '0 0 8px rgba(140,150,255,.6)' }} />
              <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.13em', color: COLORS.accentBright, whiteSpace: 'nowrap' }}>REAL-WORLD EFFECTS</span>
            </div>
            <div style={{ ...serif, fontSize: 11.5, color: COLORS.textMuted, marginTop: 3 }}>praxis acts — once cleared</div>
            <div style={{ fontSize: 6.8, color: COLORS.textFaint, marginTop: 7, lineHeight: 1.9, letterSpacing: '.1em' }}>PAY · POST · LOG IN<br />SOVEREIGN BROWSER · CRED VAULT</div>
          </div>

          {/* QUARTZ VAULT */}
          <div style={{ position: 'absolute', left: 560, top: 660, width: 220, height: 140, border: '1px solid rgba(94,234,212,.32)', borderRadius: '18px 18px 12px 12px', background: 'rgba(9,17,20,.85)', padding: '19px 14px 11px' }}>
            <div style={{ position: 'absolute', left: 8, right: 8, top: 5, height: 11, borderRadius: '50%', border: '1px solid rgba(94,234,212,.22)' }} />
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: COLORS.teal }}>◈ QUARTZ VAULT</div>
            <div style={sub}>shared memory</div>
            <div style={{ fontSize: 7, color: COLORS.textFaint, marginTop: 8, letterSpacing: '.12em', lineHeight: 1.9 }}>
              EVERY AGENT READS IT<br />EVERY LESSON LANDS IN IT<br />RECALL ⇄ COMMIT
            </div>
          </div>

          {/* AMBIENT STAFF */}
          <div style={box(860, 655, 200, 74, { border: '1px solid rgba(255,122,194,.35)', background: 'rgba(22,12,18,.8)', padding: '9px 12px' })}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: COLORS.pink }}>✳ SAGE</div>
            <div style={{ ...serif, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>{flow.sage.role} — on cadence</div>
            <div style={{ fontSize: 6.5, color: COLORS.textFaint, marginTop: 4, letterSpacing: '.1em' }}>{flow.sage.model.toUpperCase()} · {flow.sage.rail}<br />FIELD DIGESTS → INBOX + VAULT</div>
          </div>
          <div style={box(860, 745, 200, 74, { border: '1px solid rgba(168,224,110,.35)', background: 'rgba(14,20,10,.8)', padding: '9px 12px' })}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: COLORS.lime }}>✒ SCRIBE</div>
            <div style={{ ...serif, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>{flow.scribe.role} — dispatched by praxis</div>
            <div style={{ fontSize: 6.5, color: COLORS.textFaint, marginTop: 4, letterSpacing: '.1em' }}>{flow.scribe.model.toUpperCase()} · {flow.scribe.rail}<br />SPECS · NOTES · WRITE-UPS</div>
          </div>
          <div style={box(860, 835, 200, 74, { border: '1px solid rgba(232,121,249,.35)', background: 'rgba(20,12,22,.8)', padding: '9px 12px' })}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: COLORS.magenta }}>☰ HERMES</div>
            <div style={{ ...serif, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>background planning brain</div>
            <div style={{ fontSize: 6.5, color: COLORS.textFaint, marginTop: 4, letterSpacing: '.1em' }}>PLANS AHEAD · SELF-IMPROVES</div>
          </div>

          {/* YOUR INBOX */}
          <div style={box(1150, 660, 220, 100, { border: `1px dashed ${withAlpha(COLORS.textValue, 0.3)}`, background: 'rgba(12,16,30,.85)', padding: '11px 13px' })}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: COLORS.textValue }}>◈ YOUR INBOX</div>
            <div style={{ ...serif, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>wakes up with you</div>
            <div style={{ fontSize: 6.8, color: COLORS.textFaint, marginTop: 6, lineHeight: 1.8, letterSpacing: '.1em' }}>BOARD MINUTES · DIGESTS<br />APPROVALS WAITING</div>
          </div>

          {/* zone tags */}
          <div style={tag(20, 126)}>OPERATOR</div>
          <div style={tag(300, 226)}>ORCHESTRATION</div>
          <div style={tag(650, 226)}>HANDS</div>
          <div style={tag(900, 241)}>PROVIDERS</div>
          <div style={tag(1196, 276)}>CODE</div>
          <div style={tag(1400, 356)}>PROOF</div>
          <div style={tag(20, 489, false)}>THE ONLY DOOR OUT</div>
          <div style={tag(560, 636)}>MEMORY</div>
          <div style={tag(860, 631)}>AMBIENT STAFF — SELF-FIRING</div>
          <div style={tag(1150, 636)}>FOR YOU</div>

          {/* edge labels */}
          <div style={lbl(168, 118)}>TALK — VOICE · INSTANT</div>
          <div style={lbl(200, 196)}>INSTANT ANSWERS</div>
          <div style={lbl(178, 268)}>MISSION — BRAIN-DUMP</div>
          <div style={lbl(433, 200, COLORS.flowAmber)}>HANDOFF — BIG JOBS</div>
          <div style={lbl(556, 182)}>SELF-FIRING MISSIONS</div>
          <div style={lbl(562, 281)}>PLAN → DISPATCH</div>
          <div style={lbl(560, 914, COLORS.flowViolet)}>VERIFIED? MERGE — ELSE RE-PLAN</div>
          <div style={lbl(200, 424, COLORS.flowViolet)}>ACT IN THE WORLD</div>
          <div style={lbl(30, 400, COLORS.textDim2)}>APPROVE / DENY — YOUR VETO</div>
          <div style={lbl(36, 642)}>CLEARED → EXECUTE</div>
          <div style={lbl(508, 537)}>RECALL ⇄ COMMIT</div>
          <div style={lbl(800, 846, COLORS.flowPlum)}>LESSONS</div>
          <div style={lbl(1082, 682)}>DIGESTS</div>
          <div style={lbl(480, 14, COLORS.textFaint)}>MANUAL — YOUR HANDS, STRAIGHT INTO A LANE</div>
        </div>
        <div style={{ ...serif, fontSize: 12.5, color: COLORS.textFainter, textAlign: 'center', padding: '10px 0 2px' }}>
          solid lines carry work forward · dashed lines are feedback and manual hands · dotted lines are self-firing (the clock, not you) · color is agent identity
        </div>
      </div>
    </div>
  );
}
