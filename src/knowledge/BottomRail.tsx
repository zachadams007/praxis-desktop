/**
 * BottomRail.tsx - the "memory bus" rail (ported from the design prototype's bottom rail):
 * a hold-to-talk voice button (real voice plumbing), a status pip, a scrolling live ticker of
 * recent vault ops, the RA/Dec/× readout (fed by the engine), and a clock.
 *
 * The voice button reuses the window's existing voice stack (useVoiceRemote / useVoiceCapture /
 * forwardUtterance) - the same plumbing the old GalaxyVoice used - so "Praxis, …" from the
 * galaxy still forwards to the brain to execute + speak.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AREA, mix } from "./atlas";
import { TRUST_LEVELS } from "@/shared/autonomy";
import { MOCK_AGENTS } from "@/shared/agents";
import { eventBus } from "@/data/eventBus";
import { toolVerb } from "./eventAdapter";
import type { PraxisEvent } from "@/data/schema";
import type { GraphData, GNode } from "./types";
import { useVoiceRemote, forwardUtterance } from "@/voice/useVoiceRemote";
import { useVoiceCapture } from "@/voice/useVoiceCapture";
import { useWindowFocus } from "@/voice/useWindowFocus";
import { canRecognize } from "@/voice/speak";
import { inPraxisTauri, usePraxisStatus, type PraxisStatusState } from "@/shared/praxisStatus";
import { useMemoryTodos, type MemoryTodoItem } from "@/command/todoStore";

const RECOG = canRecognize();

interface BottomRailProps {
  accent: string;
  autonomyKey: string;
  graph: GraphData;
  /** Real firing count (shared rule) - gates the status verb so the rail never claims
   *  "executing" while no real coding session is running. */
  firing: number;
  voiceOn: boolean;
  onVoice: () => void;
}

export function BottomRail({ accent, autonomyKey, graph, firing, voiceOn, onVoice }: BottomRailProps) {
  const focused = useWindowFocus();
  const remote = useVoiceRemote(RECOG && voiceOn && focused);
  const cap = useVoiceCapture(forwardUtterance, !RECOG && voiceOn && focused);
  const partial = RECOG ? remote.partial : cap.partial;
  const praxisStatus = usePraxisStatus();

  // start the recognizer when toggled on
  useEffect(() => {
    if (!voiceOn) return;
    if (RECOG) remote.startCommand?.();
    else cap.toggle?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOn]);

  const [clock, setClock] = useState(nowClock());
  useEffect(() => {
    const id = window.setInterval(() => setClock(nowClock()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const autoLabel = TRUST_LEVELS.find((r) => r.key === autonomyKey)?.label ?? "Operator";
  const statusText =
    inPraxisTauri() && praxisStatus ? `Praxis ${statusVerb(praxisStatus.state, firing)}` : "Praxis online";

  // REAL recent vault ops, attributed to real agents + real nodes, straight off THIS
  // window's live event bus (fed by useGalaxyRealEvents). When any are present they ARE
  // the ticker; otherwise fall back to the ambient rows (the REAL "Open now" intent
  // ledger + a light sampling of real vault notes - never fabricated attribution or a
  // build-time status snapshot dressed up as "live"). See useGalaxyOps / buildBus.
  const { items: ledgerItems } = useMemoryTodos();
  const realOps = useGalaxyOps(graph, accent);
  const bus = useMemo(
    () => (realOps.length ? realOps : buildBus(graph, accent, ledgerItems)),
    [realOps, graph, accent, ledgerItems],
  );
  const busLoop = useMemo(() => bus.concat(bus), [bus]);

  return (
    <div className="mg-rail">
      <button
        className="mg-voice"
        title="Hold to talk to Praxis"
        onClick={onVoice}
        style={{
          borderColor: voiceOn ? accent : "var(--p-line2)",
          color: voiceOn ? "#fff" : "var(--p-dim)",
          background: voiceOn
            ? `radial-gradient(circle at 38% 30%, ${mix(accent, "#ffffff", 0.35)}, ${accent} 62%, ${mix(accent, "#000000", 0.5)})`
            : "transparent",
          boxShadow: voiceOn ? `0 0 16px -4px ${accent}` : "none",
        }}
      >
        {voiceOn && <span className="mg-voice-ring" style={{ borderColor: accent }} />}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" fill="currentColor" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>

      <div className="mg-rail-status">
        <span className="mg-rail-dot" style={{ background: accent, boxShadow: `0 0 8px -1px ${accent}` }} />
        <span className="mg-rail-status-txt" title={praxisStatus?.detail}>{statusText}</span>
        <span className="mg-rail-auto">· {autoLabel}</span>
      </div>

      <div className="mg-ticker-mask">
        <div className="mg-ticker">
          {busLoop.map((t, i) => (
            <span key={i} className="mg-ticker-item">
              <span className="mg-ticker-dot" style={{ background: t.dot }} />
              <span className="mg-ticker-txt">
                {t.v && <span style={{ color: t.vc, fontWeight: 600 }}>{t.v}</span>}
                <span style={{ color: "#C7CFDF" }}>{t.path}</span>
                {t.who && <span>· {t.who}</span>}
              </span>
            </span>
          ))}
        </div>
      </div>

      <span id="mg-readout" className="mg-readout">
        α —h—m · δ +—°—′ · ×1.00
      </span>
      <span className="mg-clock">{clock}</span>

      {voiceOn && partial && (
        <div className="mg-voice-partial">
          <span style={{ color: accent }}>Listening</span> · “{partial}”
        </div>
      )}
    </div>
  );
}

function statusVerb(state: PraxisStatusState, firing: number): string {
  // Honesty gate (2026-07-10 cross-window fix): the brain may publish "acting"/"executing"
  // for a voice turn, but with zero real coding sessions the galaxy must not imply active
  // build work - show "observing" (watching, not building). Voice states (listening/speaking)
  // are real regardless of firing and pass through unchanged.
  if ((state === "acting" || state === "executing") && firing <= 0) return "observing";
  if (state === "idle") return "idle";
  return state;
}

function nowClock(): string {
  const n = new Date();
  return String(n.getHours()).padStart(2, "0") + ":" + String(n.getMinutes()).padStart(2, "0");
}

interface BusItem {
  /** verb (TASK) - omitted for plain note rows so we don't fabricate an op. */
  v?: string;
  /** verb color (only when v is present). */
  vc?: string;
  path: string;
  /** real status / attribution - omitted when there is none (no invented agent/%). */
  who?: string;
  dot: string;
}

/** Status emoji → the ambient ticker's honest label (mirrors the intent ledger's own
 *  legend: 🔜 future / ❓ unverified / 🚧 in progress / ⛔ blocked). Only "in progress"
 *  gets the TASK verb treatment below - the others aren't a claim of active work. */
const LEDGER_STATUS_LABEL: Record<string, string> = {
  "🚧": "in progress",
  "🔜": "planned",
  "❓": "unverified",
  "⛔": "blocked",
};

/**
 * Present a raw intent-ledger slug as a deliberate, user-facing work item (2026-07-10 QA #7):
 * the source stays real - we only strip the debug debris that made it read as internal noise.
 *   • drop a trailing parenthetical code ref:  "… (pv_search)"        → "…"
 *   • drop a "/ implementation note" tail:      "… / dead emitter"     → "…"
 *   • drop trailing implementation jargon:      "… product call"       → "…"
 *   • Title-Case plain words, but keep already-cased identifiers as-is (estTokens, codex-run)
 * Falls back to the original title if cleaning would empty it (never invents text).
 */
function cleanWorkLabel(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim(); // trailing "(pv_search)"
  s = s.replace(/\s*\/\s*(dead emitter|dead code|no-?op|stub|todo|wip)\b.*$/i, "").trim(); // "/ dead emitter …"
  s = s.replace(/\s+(product call|dead emitter|dead code|no-?op|stub)\s*$/i, "").trim(); // trailing jargon
  s = s.replace(/[\s/·–-]+$/g, "").trim(); // any dangling separator left behind
  if (!s) return raw.trim();
  return s.replace(/[A-Za-z][A-Za-z']*/g, (w) =>
    /[A-Z_]/.test(w.slice(1)) ? w : w.charAt(0).toUpperCase() + w.slice(1),
  );
}

/**
 * Build the ambient ticker from REAL sources only:
 *   - TASK rows: the intent ledger's own "🔴 Open now" section (memory_todo_open_now) -
 *     a curated, recency-windowed list of what's genuinely open right now, not the
 *     memory-graph builder's blanket "any topic ever tagged 🚧" snapshot (that flag is
 *     set once when the note was authored, never re-checked - "authored-once data read
 *     as live", the exact bug flagged by the 2026-07-09 visual-truth audit and again by
 *     the 2026-07-10 CDP QA pass, GX-3). Deduped by title.
 *   - NOTE rows: real vault note titles as pure ambience - no verb, no "live" claim
 *     (ambience may breathe; only real work may headline). Deduped by label so a note
 *     the graph happens to carry more than once can't repeat itself in the same pass.
 * Honest empty state when neither source has anything - never falls back to inventing
 * a row.
 */
function buildBus(graph: GraphData, accent: string, ledgerItems: MemoryTodoItem[]): BusItem[] {
  const items: BusItem[] = [];
  const seen = new Set<string>();
  const dotFor = (area: string) => AREA[area]?.hue ?? accent;

  for (const item of ledgerItems) {
    if (items.length >= 5) break;
    const title = cleanWorkLabel(item.title); // present as deliberate work, not a raw code slug
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    const label = LEDGER_STATUS_LABEL[item.status] ?? item.status;
    items.push({
      v: item.status === "🚧" ? "TASK" : undefined,
      vc: "#F5B84B",
      path: title,
      who: label,
      dot: accent,
    });
  }

  const notes = graph.nodes.filter((n) => n.type === "note" && !n.orphan);
  for (const n of notes) {
    if (items.length >= 12) break;
    const key = n.label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({ path: n.label, dot: dotFor(n.area) });
  }

  if (!items.length) items.push({ path: "vault quiet — no open work", dot: accent });
  return items;
}

// ---------------------------------------------------------------------------
// Real vault-ops ticker (visual-truth §item-1) - every line traces to a real,
// non-synthetic PraxisEvent, a real agent identity (src/shared/agents roster),
// and a real node/area. Events that can't be attributed are DROPPED, never
// dressed up with an invented verb or agent (the fabrication that lived in
// buildBus's note rows before 2026-07-09).
// ---------------------------------------------------------------------------

const MAX_OPS = 9; // recent ops kept in the ticker
const FLUSH_MS = 8000; // coalesce bursts → at most one marquee refresh per 8s (52s loop)

/** id → display name from the canonical fleet roster; unknown ids (subagents) titlecase. */
const AGENT_NAMES = new Map(MOCK_AGENTS.map((a) => [a.id, a.name] as const));
function agentName(id: string): string {
  const known = AGENT_NAMES.get(id);
  if (known) return known;
  const raw = id.replace(/^a\./, "").replace(/[-_]+/g, " ").trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "agent";
}

// The tool → verb split is imported from eventAdapter.ts (the one source of
// truth) so the ticker and the canvas beads can never disagree.

/** Resolve the op's path to the most specific REAL attribution available - a graph node
 *  label, else the event's own label (a filename / memory title), else the real AREA name.
 *  All three are real; ordered most-specific first. null when none exist → the op is dropped. */
function opLocation(ev: PraxisEvent, byId: Map<string, GNode>): { path: string; area: string } | null {
  const nodeId = ev.nodeId ?? ev.taskId;
  const node = nodeId ? byId.get(nodeId) : undefined;
  if (node) return { path: node.label, area: node.area };
  if (ev.label) return { path: ev.label, area: ev.areaId ?? "" }; // e.g. a file:created filename
  if (ev.areaId && AREA[ev.areaId]) return { path: AREA[ev.areaId].name, area: ev.areaId };
  return null;
}

/** Map a real event → a ticker line, or null if it isn't an attributable vault op. */
function opFromEvent(ev: PraxisEvent, byId: Map<string, GNode>, accent: string): BusItem | null {
  let v: string;
  let vc: string;
  switch (ev.type) {
    case "agent:thinking": {
      const verb = toolVerb(ev.thought);
      if (!verb) return null;
      v = verb === "write" ? "WRITE" : "READ";
      vc = verb === "write" ? accent : "#7FA3FF";
      break;
    }
    case "memory:updated":
      v = "WRITE";
      vc = accent;
      break;
    case "file:created":
      v = "CREATE";
      vc = "#35D3C0";
      break;
    case "task:complete":
      v = "DONE";
      vc = "#2BE28F";
      break;
    default:
      return null; // status/handoff/speaking/journey - not a vault op the ticker narrates
  }
  const loc = opLocation(ev, byId);
  if (!loc) return null; // can't attribute to a real node/area → drop, don't invent
  return {
    v,
    vc,
    path: loc.path,
    who: ev.agentId ? agentName(ev.agentId) : undefined,
    dot: AREA[loc.area]?.hue ?? accent,
  };
}

/**
 * Subscribe to THIS window's live event bus and surface the recent REAL vault ops as
 * ticker rows. Coalesces bursts to one state flush per FLUSH_MS so the CSS marquee
 * doesn't restart on every tool call; the first op appears immediately. Synthetic
 * (mock ambient) events are ignored - but the galaxy has no mock timeline anyway, so in
 * practice this only ever carries real Rust-bridge activity (useGalaxyRealEvents).
 */
function useGalaxyOps(graph: GraphData, accent: string): BusItem[] {
  const [ops, setOps] = useState<BusItem[]>([]);
  const byId = useMemo(() => {
    const m = new Map<string, GNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);
  const byIdRef = useRef(byId);
  useEffect(() => {
    byIdRef.current = byId;
  }, [byId]);
  const accentRef = useRef(accent);
  accentRef.current = accent;

  useEffect(() => {
    const buf: BusItem[] = [];
    let lastSig = "";
    const flush = () => {
      const sig = buf.map((o) => `${o.v}${o.path}${o.who ?? ""}`).join("|");
      if (sig === lastSig) return;
      lastSig = sig;
      setOps(buf.slice());
    };
    const unsub = eventBus.subscribe((ev) => {
      if (ev.synthetic) return;
      const item = opFromEvent(ev, byIdRef.current, accentRef.current);
      if (!item) return;
      const last = buf[0];
      if (last && last.v === item.v && last.path === item.path && last.who === item.who) return; // dedup repeats
      buf.unshift(item);
      if (buf.length > MAX_OPS) buf.length = MAX_OPS;
      if (buf.length === 1) flush(); // first real op appears without waiting for the interval
    });
    const id = window.setInterval(flush, FLUSH_MS);
    return () => {
      unsub();
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ops;
}
