/**
 * MissionMessages - how each kind of Mission message looks.
 *
 *   brief              Atlas → Praxis: a distinct card, ~4 lines + "show full brief"
 *   plan               Praxis: who does what, in which folder
 *   dispatch/progress/reroute   compact agent rows - glyph + model tint, model, step 2/4;
 *                      a reroute reads "Quill → Vega"
 *   result             the prominent card: summary + one real button per artifact
 *   failure            a calm warning card: why, and what's left
 *   answer / note      Praxis, left, with its mark
 *
 * Same HUD v2 / Command Center language as the Atlas chat (orch.css): hairline borders,
 * squared 2px corners, tracked-caps labels, Spectral for Praxis's voice, IBM Plex Mono
 * for data. Agent hues come from the model-tint system the brain and the dock already use.
 */

import { createContext, memo, useContext, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Glyph, AGENT_GLYPH } from "@/glyphs/glyphs";
import { MODEL_TINT, type ModelFamily } from "@/brain/modelTint";
import type { MissionAgent, MissionMsg } from "@/orchestrator/missionThread";
import { agentName, agentOf, clockLabel, parsePlanLines, prettyModel } from "./missionLogic";
import { LightText } from "./LightText";
import { stripControl } from "./lightMarkdown";
import { ArtifactRow } from "./ArtifactButton";

/** A card that grows under the reader (e.g. "show full brief") tells the thread to stop following the bottom. */
export const UnpinContext = createContext<() => void>(() => {});

const AGENT_ID: Record<MissionAgent, string> = { forge: "a.forge", vega: "a.vega", quill: "a.quill", lens: "a.lens" };
/** Same families as graph.ts / agents.ts: Forge=opus, Vega=codex, Quill=cursor, Lens=sonnet. */
const AGENT_FAMILY: Record<MissionAgent, ModelFamily> = { forge: "opus", vega: "codex", quill: "cursor", lens: "sonnet" };
const ATLAS_TINT = MODEL_TINT.codex; // a.atlas → codex (teal), per graph.ts

const tint = (hex: string) => ({ "--m": hex }) as React.CSSProperties;
const isAgent = (s: string): s is MissionAgent => s === "forge" || s === "vega" || s === "quill" || s === "lens";

// ------------------------------------------------------------------- marks ---

export function AgentMark({ agent, size = 14 }: { agent: MissionAgent; size?: number }) {
  return (
    <span className="ms-mark" style={tint(MODEL_TINT[AGENT_FAMILY[agent]])} aria-hidden>
      <Glyph id={AGENT_GLYPH[AGENT_ID[agent]] ?? "hex"} size={size} />
    </span>
  );
}

function PraxisMark({ size = 13 }: { size?: number }) {
  return (
    <span className="ms-mark is-praxis" aria-hidden>
      <Glyph id="praxis" size={size} />
    </span>
  );
}

function AtlasMark({ size = 13 }: { size?: number }) {
  return (
    <span className="ms-mark" style={tint(ATLAS_TINT)} aria-hidden>
      <Glyph id={AGENT_GLYPH["a.atlas"] ?? "hex"} size={size} />
    </span>
  );
}

export function agentTint(agent: MissionAgent): string {
  return MODEL_TINT[AGENT_FAMILY[agent]];
}

function Time({ ts }: { ts: number }) {
  const d = new Date(ts);
  return (
    <time className="ms-time" dateTime={d.toISOString()} title={d.toLocaleString()}>
      {clockLabel(ts)}
    </time>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`ms-chev${open ? " is-open" : ""}`} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 6.2L8 10l4-3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Does this clamped body hold more than its collapsed height? Re-measured when its width
 * changes (the panel expands) - and only while collapsed, since an open body has no clamp.
 */
function useOverflow(open: boolean, text: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);
  return { ref, over };
}

// -------------------------------------------------------------- entrance ----

/** A row that arrives live eases in once; rows that were already there simply appear. */
function Enter({
  fresh,
  className,
  style,
  children,
}: {
  fresh: boolean;
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const wasFresh = useRef(fresh).current; // decided at mount - a later re-render must not replay it
  return (
    <motion.div
      className={className}
      style={style}
      initial={wasFresh ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** "ATLAS" · "PRAXIS" · an agent's name, with its mark and the time. */
function Who({ m }: { m: MissionMsg }) {
  const agent = isAgent(m.from) ? m.from : null;
  const name = agent ? agentName(agent).toUpperCase() : m.from === "atlas" ? "ATLAS" : "PRAXIS";
  return (
    <div className="ms-who">
      {agent ? <AgentMark agent={agent} size={13} /> : m.from === "atlas" ? <AtlasMark /> : <PraxisMark />}
      <span className="ms-who-name">{name}</span>
      <Time ts={m.ts} />
    </div>
  );
}

// ---------------------------------------------------------- The owner (right) ----

function ZachMsg({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  return (
    <Enter fresh={fresh} className="ms-msg ms-you">
      {/* */}
      <p className="ms-bubble ms-bubble-you" title={new Date(m.ts).toLocaleString()}>
        {stripControl(m.text)}
      </p>
      {m.from === "atlas" && <span className="ms-via">via Atlas</span>}
    </Enter>
  );
}

// ------------------------------------------------------- Atlas → Praxis ----

function BriefCard({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  const unpin = useContext(UnpinContext);
  const [open, setOpen] = useState(false);
  const { ref: bodyRef, over } = useOverflow(open, m.text); // more than the ~4 collapsed lines?

  return (
    <Enter fresh={fresh} className="ms-msg ms-brief" style={tint(ATLAS_TINT)}>
      <div className="ms-brief-head">
        <AtlasMark />
        <span className="ms-brief-label">
          <span className="ms-brief-who">ATLAS → PRAXIS</span>
          <span className="ms-brief-kind"> · brief</span>
        </span>
        <Time ts={m.ts} />
      </div>
      <div ref={bodyRef} className={`ms-brief-body${open ? " is-open" : over ? " is-over" : ""}`}>
        <LightText text={m.text} />
      </div>
      {(over || open) && (
        <button
          type="button"
          className="ms-toggle"
          aria-expanded={open}
          onClick={() => {
            unpin();
            setOpen((v) => !v);
          }}
        >
          <span>{open ? "hide full brief" : "show full brief"}</span>
          <Chevron open={open} />
        </button>
      )}
    </Enter>
  );
}

// ----------------------------------------------------------------- plan ----

function PlanCard({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  const lines = parsePlanLines(m.text);
  return (
    <Enter fresh={fresh} className="ms-msg ms-praxis is-wide">
      <Who m={m} />
      <div className="ms-card ms-plan" role="group" aria-label="Plan">
        <p className="ms-kicker">Plan</p>
        <ul className="ms-plan-lines">
          {lines.map((l, i) =>
            l.kind === "agent" ? (
              <li key={i} className="ms-plan-agent" style={tint(agentTint(l.agent))}>
                <AgentMark agent={l.agent} size={13} />
                <b>{agentName(l.agent)}</b>
                <LightText text={l.text} className="ms-inline" />
              </li>
            ) : l.kind === "workspace" ? (
              <li key={i} className="ms-plan-ws">
                <span>workspace</span>
                <code title={l.path}>{l.path}</code>
              </li>
            ) : (
              <li key={i} className="ms-plan-text">
                <LightText text={l.text} className="ms-inline" />
              </li>
            ),
          )}
        </ul>
      </div>
    </Enter>
  );
}

// ---------------------------------------------------------- agent rows -----

/** Name · model · step - the header line every agent row shares. */
function AgentLine({ m, agent, children }: { m: MissionMsg; agent: MissionAgent; children?: React.ReactNode }) {
  const model = prettyModel(m.model);
  return (
    <div className="ms-ag-line">
      <span className="ms-ag-name">{agentName(agent).toUpperCase()}</span>
      {model && <span className="ms-ag-model">{model}</span>}
      {m.step && (
        <span className="ms-ag-step" title={`step ${m.step.index} of ${m.step.of}`}>
          {m.step.index}/{m.step.of}
        </span>
      )}
      {children}
    </div>
  );
}

function DispatchRow({ m, agent, live, fresh }: { m: MissionMsg; agent: MissionAgent; live: boolean; fresh: boolean }) {
  return (
    <Enter fresh={fresh} className={`ms-msg ms-agent is-dispatch${live ? " is-live" : ""}`} style={tint(agentTint(agent))}>
      <AgentMark agent={agent} />
      <div className="ms-ag-body">
        <AgentLine m={m} agent={agent} />
        {m.text.trim() && (
          <p className="ms-ag-text" title={stripControl(m.text)}>
            {stripControl(m.text)}
          </p>
        )}
      </div>
      <span className="ms-ag-end">
        {live && <i className="ms-pulse" aria-label="working now" role="img" />}
        <Time ts={m.ts} />
      </span>
    </Enter>
  );
}

function ProgressRow({ m, agent, fresh }: { m: MissionMsg; agent: MissionAgent; fresh: boolean }) {
  const unpin = useContext(UnpinContext);
  const [open, setOpen] = useState(false);
  const { ref: bodyRef, over } = useOverflow(open, m.text);
  return (
    <Enter fresh={fresh} className="ms-msg ms-agent is-progress" style={tint(agentTint(agent))}>
      <AgentMark agent={agent} />
      <div className="ms-ag-body">
        <AgentLine m={m} agent={agent}>
          <span className="ms-ag-verb">reported</span>
        </AgentLine>
        {m.text.trim() && (
          <div ref={bodyRef} className={`ms-ag-out${open ? " is-open" : over ? " is-over" : ""}`}>
            <LightText text={m.text} />
          </div>
        )}
        {(over || open) && (
          <button
            type="button"
            className="ms-toggle is-small"
            aria-expanded={open}
            onClick={() => {
              unpin();
              setOpen((v) => !v);
            }}
          >
            <span>{open ? "less" : "more"}</span>
            <Chevron open={open} />
          </button>
        )}
      </div>
      <span className="ms-ag-end">
        <Time ts={m.ts} />
      </span>
    </Enter>
  );
}

function RerouteRow({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  const from = m.agent;
  const to = m.standIn;
  return (
    <Enter fresh={fresh} className="ms-msg ms-agent is-reroute">
      <span className="ms-reroute-ico" aria-hidden>
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M3 5.5h8.5M9.5 3l2.5 2.5L9.5 8M13 10.5H4.5M6.5 8L4 10.5 6.5 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="ms-ag-body">
        <div className="ms-ag-line">
          {from && (
            <span className="ms-rr-who" style={tint(agentTint(from))}>
              <AgentMark agent={from} size={12} />
              <span className="ms-ag-name">{agentName(from).toUpperCase()}</span>
            </span>
          )}
          {from && to && (
            <span className="ms-rr-arrow" aria-label="to">
              →
            </span>
          )}
          {to && (
            <span className="ms-rr-who" style={tint(agentTint(to))}>
              <AgentMark agent={to} size={12} />
              <span className="ms-ag-name">{agentName(to).toUpperCase()}</span>
            </span>
          )}
          {from && !to && <span className="ms-ag-verb">unavailable</span>}
          {!from && !to && <span className="ms-ag-name">REROUTED</span>}
        </div>
        {m.text.trim() && (
          <p className="ms-ag-text is-wrap" title={stripControl(m.text)}>
            {stripControl(m.text)}
          </p>
        )}
      </div>
      <span className="ms-ag-end">
        <Time ts={m.ts} />
      </span>
    </Enter>
  );
}

// -------------------------------------------------- result · failure --------

function ResultCard({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  return (
    <Enter fresh={fresh} className="ms-msg ms-praxis is-wide">
      <Who m={m} />
      <div className="ms-card ms-result" role="group" aria-label="Delivered">
        <p className="ms-kicker">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Delivered
        </p>
        <LightText text={m.text} className="ms-summary" />
        {m.artifacts && m.artifacts.length > 0 && <ArtifactRow artifacts={m.artifacts} />}
      </div>
    </Enter>
  );
}

function FailureCard({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  return (
    <Enter fresh={fresh} className="ms-msg ms-praxis is-wide">
      <Who m={m} />
      <div className="ms-card ms-fail" role="group" aria-label="Needs you">
        <p className="ms-kicker">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M8 2.8L14 13H2L8 2.8Z M8 7v2.6 M8 11.4h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Needs you
        </p>
        <LightText text={m.text} className="ms-summary" />
        {m.artifacts && m.artifacts.length > 0 && <ArtifactRow artifacts={m.artifacts} />}
      </div>
    </Enter>
  );
}

// ------------------------------------------------------ answer · note -------

function PraxisSays({ m, fresh, quiet }: { m: MissionMsg; fresh: boolean; quiet: boolean }) {
  return (
    <Enter fresh={fresh} className={`ms-msg ms-praxis${quiet ? " is-quiet" : ""}`}>
      <Who m={m} />
      <div className="ms-bubble ms-bubble-praxis">
        <LightText text={m.text} />
      </div>
    </Enter>
  );
}

// ------------------------------------------------- praxis supervising --

const REVIEW_LABEL = { accepted: "ACCEPTED", revise: "SENT BACK", stuck: "STUCK" } as const;

/** Praxis checking an agent's work the way the owner would: accept it, or send it back with the
 *  concrete feedback it gave. The text is Praxis's own judgment. */
function ReviewRow({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  const agent = m.agent;
  const verdict = m.verdict ?? "accepted";
  return (
    <Enter fresh={fresh} className={`ms-msg ms-agent is-review is-${verdict}`} style={agent ? tint(agentTint(agent)) : undefined}>
      <span className="ms-review-ico" aria-hidden>
        <svg viewBox="0 0 16 16" fill="none">
          {verdict === "accepted" ? (
            <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          ) : verdict === "revise" ? (
            <path d="M6 4L3 7l3 3M3.5 7h6.5a3 3 0 010 6H8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M8 3.5v5.5M8 11.6v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          )}
        </svg>
      </span>
      <div className="ms-ag-body">
        <div className="ms-ag-line">
          <span className="ms-ag-name ms-praxis-name">PRAXIS</span>
          <span className="ms-ag-verb">reviewed</span>
          {agent && (
            <span className="ms-rr-who">
              <AgentMark agent={agent} size={12} />
              <span className="ms-ag-name">{agentName(agent).toUpperCase()}</span>
            </span>
          )}
          <span className={`ms-review-verdict is-${verdict}`}>{REVIEW_LABEL[verdict]}</span>
        </div>
        {m.text.trim() && (
          <p className="ms-ag-text is-wrap" title={stripControl(m.text)}>
            {stripControl(m.text)}
          </p>
        )}
      </div>
      <span className="ms-ag-end">
        <Time ts={m.ts} />
      </span>
    </Enter>
  );
}

/** Something Praxis decided on its own authority - an idea it added, an approach it chose.
 *  Shown so a decision made for the owner is never invisible to him. */
function DecisionRow({ m, fresh }: { m: MissionMsg; fresh: boolean }) {
  return (
    <Enter fresh={fresh} className="ms-msg ms-agent is-decision">
      <span className="ms-decision-ico" aria-hidden>
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4L8 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="ms-ag-body">
        <div className="ms-ag-line">
          <span className="ms-ag-name ms-praxis-name">PRAXIS</span>
          <span className="ms-ag-verb">decided</span>
        </div>
        <p className="ms-ag-text is-wrap" title={stripControl(m.text)}>
          {stripControl(m.text)}
        </p>
      </div>
      <span className="ms-ag-end">
        <Time ts={m.ts} />
      </span>
    </Enter>
  );
}

// -------------------------------------------------------------- the switch --

export interface MessageProps {
  m: MissionMsg;
  /** Arrived live (not part of the thread when the panel opened) → ease in once. */
  fresh: boolean;
  /** This dispatch row's agent has not reported back yet. */
  live: boolean;
}

function MissionMessageImpl({ m, fresh, live }: MessageProps) {
  switch (m.kind) {
    case "mission":
      return <ZachMsg m={m} fresh={fresh} />;
    case "brief":
      return <BriefCard m={m} fresh={fresh} />;
    case "plan":
      return <PlanCard m={m} fresh={fresh} />;
    case "dispatch": {
      const a = agentOf(m);
      return a ? <DispatchRow m={m} agent={a} live={live} fresh={fresh} /> : <PraxisSays m={m} fresh={fresh} quiet />;
    }
    case "progress": {
      const a = agentOf(m);
      return a ? <ProgressRow m={m} agent={a} fresh={fresh} /> : <PraxisSays m={m} fresh={fresh} quiet />;
    }
    case "reroute":
      return <RerouteRow m={m} fresh={fresh} />;
    case "result":
      return <ResultCard m={m} fresh={fresh} />;
    case "failure":
      return <FailureCard m={m} fresh={fresh} />;
    case "note":
      return <PraxisSays m={m} fresh={fresh} quiet />;
    case "review":
      return <ReviewRow m={m} fresh={fresh} />;
    case "decision":
      return <DecisionRow m={m} fresh={fresh} />;
    default:
      return <PraxisSays m={m} fresh={fresh} quiet={false} />;
  }
}

export const MissionMessage = memo(MissionMessageImpl);
