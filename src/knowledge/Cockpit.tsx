/**
 * Cockpit.tsx - the right panel: Inspect ⇄ Fleet ⇄ System (ported from the design prototype's
 * right column). Frameless hairline chrome over the canvas.
 *   • Inspect - the selected node: tags, description, progress, metrics, deps, links, Open file.
 *   • Fleet - the agent roster (real useAgentRoster rows + constellation sigils) with drill-in.
 *   • System - area legend, the Autonomy ladder, system metrics.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AREA, AREAS, TYPE_GLYPH, TYPE_LABEL, rgba } from "./atlas";
import { TRUST_LEVELS } from "@/shared/autonomy";
import { MODEL_TINT } from "./agentRig";
import { agentSigil } from "@/glyphs/glyphs";
import { MODEL_LABEL, type AgentRow } from "@/shared/agents";
import { loadThread, sendToAgent, type ChatMessage } from "./agentChat";
import { isFiringAgent, deriveAreaBuckets } from "./derive";
import { useToolToggles, type ToolKey } from "@/command/controlStore";
import {
  BILLING_LABEL,
  FLEET_AGENTS,
  RAIL_BREAKER,
  RAIL_TAG,
  fleetDefForAgent,
  getFleetModel,
  useFleetModels,
  type FleetAgentDef,
  type FleetModelOption,
} from "@/command/fleetStore";
import type { GraphData, GNode, AreaId } from "./types";

const ACCENT_FALLBACK = "#ff2d2d";

interface CockpitProps {
  pane: "inspect" | "fleet" | "system";
  setPane: (p: "inspect" | "fleet" | "system") => void;
  selectedNode: GNode | null;
  byId: Map<string, GNode>;
  graph: GraphData;
  accent: string;
  roster: AgentRow[];
  live: boolean;
  working: number;
  openAgent: string | null;
  setOpenAgent: (id: string | null) => void;
  autonomy: string;
  setAutonomy: (k: string) => void;
  onSelect: (id: string) => void;
  onFocusAgent: (id: string) => void;
  /** open the selected node's real backing file (open_memory_file - see App.openNodeFile). */
  onOpenFile: (node: GNode) => void;
  mutateTick: number;
}

export function Cockpit(p: CockpitProps) {
  const { accent, roster } = p;
  const liveAreas = useMemo(() => {
    const s = new Set<string>();
    // Only genuinely firing agents (shared rule) light an area - an ambient/infra row must not
    // make an area read "live" when no real coding session is touching it.
    for (const a of roster)
      if (a.status === "working" && isFiringAgent(a.id)) a.touches.forEach((t) => s.add(areaIdOf(t)));
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster]);

  const seg = (on: boolean): React.CSSProperties => ({
    flex: 1,
    border: 0,
    background: "none",
    padding: "9px 0 11px",
    fontFamily: "var(--p-mono)",
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: ".24em",
    textTransform: "uppercase",
    color: on ? "var(--p-text)" : "var(--p-dim)",
    boxShadow: on ? "inset 0 -1px 0 var(--p-accent)" : "none",
    cursor: "pointer",
  });
  const liveOn = p.working > 0;

  return (
    <aside className="mg-cockpit">
      <div className="mg-cockpit-head">
        <div className="mg-cockpit-head-l">
          <span
            className="mg-live-dot"
            style={{
              background: liveOn ? accent : "#4A587A",
              boxShadow: liveOn ? `0 0 10px -1px ${accent}` : "none",
              animation: liveOn ? "pblink 2.4s ease-in-out infinite" : "none",
            }}
          />
          <div style={{ lineHeight: 1.1 }}>
            <div className="mg-cockpit-title">Cockpit</div>
            <div className="mg-cockpit-sub">
              {p.working} agents in the vault · {roster.length} in fleet
            </div>
          </div>
        </div>
        <span
          style={{
            fontFamily: "var(--p-mono)",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: ".2em",
            color: liveOn ? accent : "var(--p-dim)",
          }}
        >
          {liveOn ? "● LIVE" : "DEMO"}
        </span>
      </div>

      <div className="mg-seg">
        <button style={seg(p.pane === "inspect")} onClick={() => p.setPane("inspect")}>Inspect</button>
        <button style={seg(p.pane === "fleet")} onClick={() => p.setPane("fleet")}>Fleet</button>
        <button style={seg(p.pane === "system")} onClick={() => p.setPane("system")}>System</button>
      </div>

      {p.pane === "inspect" && <InspectPane {...p} />}
      {p.pane === "fleet" && <FleetPane {...p} />}
      {p.pane === "system" && <SystemPane {...p} liveAreas={liveAreas} />}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------
function InspectPane(p: CockpitProps) {
  const { selectedNode: sn, accent, graph, byId } = p;
  if (!sn) {
    return (
      <div className="mg-pane mg-inspect-empty">
        <span className="mg-empty-orb">⊹</span>
        <p className="mg-empty-lead">Select a star to read its memory.</p>
        <p className="mg-empty-hint">
          hover · preview&ensp;drag · arrange
          <br />
          scroll · dive&ensp;esc · back
        </p>
      </div>
    );
  }
  const isHub = sn.kind === "hub";
  const area = AREA[sn.area];
  const col = sn.orphan ? "#6B7488" : area?.hue ?? "#6C8CFF";
  const typeLabel = isHub ? "Area index" : sn.type ? TYPE_LABEL[sn.type] : "Artifact";
  const glyph = isHub ? "❖" : sn.type ? TYPE_GLYPH[sn.type] : "•";
  const desc =
    sn.description ||
    (isHub
      ? `${area?.name ?? "Area"} — ${area?.blurb ?? ""}. The index note anchoring this region of the vault.`
      : sn.minor
        ? sn.orphan
          ? "An orphan capture — jotted into the vault but not yet linked to any work. Agents will weave it in or archive it."
          : "A loose capture — linked lightly, waiting to be woven deeper into the web."
        : sn.orphan
          ? "An orphan in the vault — captured but not yet linked to any work."
          : "An artifact in the shared memory — captured, linked, and recallable by every agent.");

  // neighbors (real link/dep edges)
  const neighborIds = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === "member") continue;
    if (e.source === sn.id) neighborIds.add(e.target);
    if (e.target === sn.id) neighborIds.add(e.source);
  }
  const neighbors = [...neighborIds].map((id) => byId.get(id)).filter((n): n is GNode => !!n && n.kind !== "hub");

  const dotStyle = (n: GNode): React.CSSProperties => {
    const c = n.orphan ? "#6B7488" : AREA[n.area]?.hue ?? "#6C8CFF";
    return { width: 6, height: 6, borderRadius: "50%", flex: "none", background: c, boxShadow: `0 0 6px -1px ${c}` };
  };

  // dep groups (tasks)
  const depGroups: Array<{ title: string; sym: string; color: string; items: GNode[] }> = [];
  if (sn.type === "task") {
    const dependsOn = graph.edges
      .filter((e) => e.kind === "dep" && e.source === sn.id)
      .map((e) => byId.get(e.target))
      .filter((n): n is GNode => !!n);
    const feeds = graph.edges
      .filter((e) => e.kind === "dep" && e.target === sn.id)
      .map((e) => byId.get(e.source))
      .filter((n): n is GNode => !!n);
    if (dependsOn.length) depGroups.push({ title: "Depends on", sym: "↳", color: accent, items: dependsOn });
    if (feeds.length) depGroups.push({ title: "Feeds into", sym: "↰", color: "var(--p-blue)", items: feeds });
  }
  const depIds = new Set(depGroups.flatMap((g) => g.items.map((n) => n.id)));
  const links = neighbors.filter((n) => !depIds.has(n.id));

  const metrics = [
    { k: "Links", v: String(neighborIds.size), c: "var(--p-text)" },
    { k: "Type", v: isHub ? "Index" : typeLabel, c: col },
    { k: "Area", v: area ? area.name.split(" ")[0] : "—", c: area ? area.hue : "var(--p-text)" },
  ];

  // GNode.prog is never written by the memory-graph builder - do NOT invent a number.
  // Suppress the % bar unless a real 0..1 progress value exists.
  const prog = sn.prog != null ? Math.round(sn.prog * 100) : null;

  // TWO DIFFERENT CLAIMS, kept apart.
  //   sn.live is NOT liveness. The graph builder sets it once, from the note's own
  //   text (a 🚧 / "in progress" marker in the intent ledger). A note tagged 🚧
  //   months ago kept rendering a pulsing "in flight" badge as though work were
  //   happening right now.
  //   REAL liveness is a firing agent whose focus resolves to THIS node.
  const inFlightNow = p.roster.some(
    (a) => a.status === "working" && isFiringAgent(a.id) && resolveFocusNode(a, p)?.id === sn.id,
  );
  const markedInProgress = !!sn.live && !inFlightNow;

  return (
    <div className="mg-pane mg-inspect">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="mg-tag" style={{ color: col }}>
              <span style={{ textShadow: "0 0 8px currentColor" }}>{glyph}</span>
              {typeLabel}
            </span>
            <span className="mg-tag mg-tag-dim">
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: area?.hue ?? "#6B7488",
                  boxShadow: `0 0 6px -1px ${area?.hue ?? "#6B7488"}`,
                }}
              />
              {area?.name ?? "Vault"}
            </span>
            {inFlightNow && (
              <span className="mg-inflight" style={{ color: accent }} title="A firing agent is focused on this node right now.">
                <span className="mg-inflight-dot" style={{ background: accent, boxShadow: `0 0 7px ${accent}` }} />
                in flight
              </span>
            )}
            {markedInProgress && (
              <span className="mg-tag mg-tag-dim" title="This note marks itself in progress (🚧 in the intent ledger). No agent is working on it right now.">
                🚧 marked in progress
              </span>
            )}
          </div>
          <h3 className="mg-inspect-title">{sn.label}</h3>
          <p className="mg-inspect-desc">{desc}</p>
        </div>

        {inFlightNow && prog != null && (
          <div>
            <div className="mg-prog-head">
              <span>In flight</span>
              <span style={{ color: "var(--p-text)" }}>{prog}%</span>
            </div>
            <div className="mg-prog-track">
              <div
                className="mg-prog-bar"
                style={{ width: `${prog}%`, background: accent, boxShadow: `0 0 10px -2px ${accent}` }}
              />
            </div>
          </div>
        )}

        <section className="mg-metrics">
          {metrics.map((m) => (
            <div key={m.k} className="mg-metric">
              <div className="mg-metric-k">{m.k}</div>
              <div className="mg-metric-v" style={{ color: m.c }}>
                {m.v}
              </div>
            </div>
          ))}
        </section>

        {depGroups.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {depGroups.map((dg) => (
              <div key={dg.title} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div className="mg-dep-head">
                  <span style={{ color: dg.color }}>{dg.sym}</span>
                  {dg.title}
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {dg.items.map((n) => (
                    <button key={n.id} className="mg-dep-item" onClick={() => p.onSelect(n.id)}>
                      <span style={dotStyle(n)} />
                      <span className="mg-ellip">{n.label}</span>
                      <span className="mg-dep-tag">{AREA[n.area]?.name ?? ""}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {links.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h4 className="mg-linked-head">Linked · {links.length}</h4>
            <div className="mg-linked-wrap">
              {links.slice(0, 10).map((n) => (
                <button key={n.id} className="mg-linked-item" onClick={() => p.onSelect(n.id)}>
                  <span style={dotStyle(n)} />
                  {n.label}
                </button>
              ))}
            </div>
          </section>
        )}

        <OpenFileButton node={sn} onOpen={p.onOpenFile} />
      </div>
    </div>
  );
}

/** The inspector's open-file affordance - REAL or honestly disabled, never silently dead
 *  (2026-07-10 fix). Enabled only when the node actually carries a backing file (path or
 *  vault slug) AND we're inside the Tauri shell (a plain browser can't open local files).
 *  Disabled states say WHY in the tooltip instead of swallowing the click. */
function OpenFileButton({ node, onOpen }: { node: GNode; onOpen: (n: GNode) => void }) {
  const hasFile = !!(node.path || node.slug);
  const inShell =
    typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  const canOpen = hasFile && inShell;
  const title = canOpen
    ? `open with your default app${node.path ? ` — ${node.path}` : ""}`
    : hasFile
      ? "opening files needs the Praxis desktop app (browser preview can't touch disk)"
      : "this node has no backing file on disk — nothing to open";
  return (
    <button
      className="mg-obsidian"
      disabled={!canOpen}
      title={title}
      onClick={() => canOpen && onOpen(node)}
    >
      {hasFile ? "Open file →" : "No source file"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------
function FleetPane(p: CockpitProps) {
  const { roster, accent } = p;
  const open = p.openAgent ? roster.find((a) => a.id === p.openAgent) ?? null : null;

  const stColor: Record<string, string> = { working: accent, idle: "var(--p-dim)", done: "#7D8FB0" };
  const tintOf = (a: AgentRow) => (a.family ? MODEL_TINT[a.family] ?? accent : accent);

  if (open) {
    const tint = tintOf(open);
    const focusNode = resolveFocusNode(open, p);
    // Only print a percentage when it is a real measurement (progKnown). The
    // fd_sessions snapshot has none, so a running agent shows an honest state
    // instead of the same "50%" for every agent, forever.
    const prog = open.progKnown ? Math.round((open.prog ?? 0) * 100) : null;
    return (
      <div className="mg-pane mg-fleet mg-fleet-open">
        <div className="mg-agent-detail mg-agent-detail-fixed">
          <button className="mg-fleet-back" onClick={() => p.setOpenAgent(null)}>‹ FLEET</button>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Sigil agentId={open.id} family={open.family} size={24} color={tint} glow />
            <div>
              <h3 className="mg-agent-name">{open.name}</h3>
              <p className="mg-agent-role" style={{ color: tint }}>{open.role}</p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span className="mg-mono-strong" style={{ color: tint }}>{open.family ? MODEL_LABEL[open.family] : "agent"}</span>
            <span className="mg-mono-state" style={{ color: stColor[open.status] }}>{open.status}</span>
          </div>
          {open.thought && <p className="mg-agent-think">“{open.thought}”</p>}
          <div className="mg-agent-facts">
            <div>
              <div className="mg-fact-k">Focus</div>
              <div className="mg-fact-v mg-ellip">{focusNode?.label ?? open.task ?? "—"}</div>
            </div>
            <div>
              <div className="mg-fact-k">Lane</div>
              <div className="mg-fact-v mg-ellip">{open.lane ?? "—"}</div>
            </div>
          </div>
          {open.status === "working" && (
            <div>
              <div className="mg-prog-head">
                <span>Task</span>
                <span style={{ color: prog != null ? "var(--p-text)" : "var(--p-dim)" }}>
                  {prog != null ? `${prog}%` : "in flight"}
                </span>
              </div>
              {prog != null && (
                <div className="mg-prog-track">
                  <div className="mg-prog-bar" style={{ width: `${prog}%`, background: tint, boxShadow: `0 0 9px -1px ${tint}` }} />
                </div>
              )}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <p className="mg-touch-label">Touching</p>
            <div className="mg-touch-wrap">
              {open.touches.map((t) => {
                const aid = areaIdOf(t);
                const ar = AREA[aid];
                return (
                  <button
                    key={t}
                    className="mg-touch-item"
                    onClick={() => {
                      const hub = p.byId.get("hub." + aid);
                      if (hub) p.onSelect(hub.id);
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", background: ar?.hue ?? accent, boxShadow: `0 0 6px -1px ${ar?.hue ?? accent}` }} />
                    {ar?.name ?? t}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <AgentChatThread agent={open} accent={accent} tint={tint} />
      </div>
    );
  }

  return (
    <div className="mg-pane mg-fleet">
      <div className="mg-fleet-sub">
        <strong>{p.working}</strong> firing · <strong>{roster.length}</strong> in the fleet
      </div>
      <div className="mg-fleet-roster">
        {roster.map((a) => {
          const tint = tintOf(a);
          const prog = a.progKnown ? Math.round((a.prog ?? 0) * 100) : null;
          return (
            <button
              key={a.id}
              className="mg-agent-row"
              style={{ opacity: a.status === "done" ? 0.62 : 1 }}
              onClick={() => {
                p.setOpenAgent(a.id);
                p.onFocusAgent(a.id);
              }}
            >
              <Sigil
                agentId={a.id}
                family={a.family}
                size={17}
                color={tint}
                dim={a.status === "idle"}
                glow={a.status === "working"}
              />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span className="mg-agent-rowname">{a.name}</span>
                  <span className="mg-agent-model" style={{ color: tint }}>{a.family ? MODEL_LABEL[a.family] : "agent"}</span>
                  <span className="mg-agent-state" style={{ color: stColor[a.status] }}>{a.status}</span>
                </span>
                <span
                  className="mg-agent-task mg-ellip"
                  style={{ color: a.status !== "idle" ? "#A9B4CA" : "var(--p-dim)", fontStyle: a.status === "idle" ? "italic" : "normal" }}
                >
                  {a.task ?? "standing by"}
                </span>
                {a.status === "working" && prog != null && (
                  <span className="mg-agent-prog-track">
                    <span className="mg-agent-prog-bar" style={{ width: `${prog}%`, background: tint, boxShadow: `0 0 8px -1px ${tint}` }} />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// See agentChat.ts.
// ---------------------------------------------------------------------------
function AgentChatThread({ agent, accent, tint }: { agent: AgentRow; accent: string; tint: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentIdRef = useRef(agent.id);

  // Load the persisted thread whenever the OPEN agent changes (not on every
  // roster poll re-render - agent.id is the real identity key).
  useEffect(() => {
    let cancelled = false;
    agentIdRef.current = agent.id;
    setLoaded(false);
    setMessages([]);
    loadThread(agent.id).then((thread) => {
      if (cancelled || agentIdRef.current !== agent.id) return;
      setMessages(thread);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // Auto-scroll to the newest line whenever the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    setDraft("");
    setPending(true);
    const beforeHistory = messages;
    // Optimistic: show the owner's line immediately.
    const optimistic: ChatMessage = { role: "zach", text, ts: Date.now(), meta: { operatorDirected: true } };
    setMessages((m) => [...m, optimistic]);
    try {
      const { reply, workOrder } = await sendToAgent(agent, text, beforeHistory);
      setMessages((m) => [...m, reply]);
      if (workOrder) {
        workOrder
          .then(() => loadThread(agent.id))
          .then((thread) => {
            if (agentIdRef.current === agent.id) setMessages(thread);
          })
          .catch(() => {
            /* failure line already appended by sendToAgent's own handler */
            loadThread(agent.id).then((thread) => {
              if (agentIdRef.current === agent.id) setMessages(thread);
            });
          });
      }
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="mg-chat">
      <div className="mg-chat-head">
        <span className="mg-chat-head-copy">
          <span className="mg-chat-head-label">Comms</span>
          <span className="mg-chat-head-hint">direct to {agent.name}</span>
        </span>
        <FleetModelPicker agent={agent} accent={accent} />
      </div>
      <div className="mg-chat-scroll" ref={scrollRef}>
        {!loaded && <div className="mg-chat-empty">reading the thread…</div>}
        {loaded && messages.length === 0 && (
          <div className="mg-chat-empty">No exchanges yet — send {agent.name} an instruction or ask it something.</div>
        )}
        {messages.map((m, i) => (
          <ChatBubble key={i} msg={m} agent={agent} accent={accent} tint={tint} />
        ))}
        {pending && (
          <div className="mg-chat-row mg-chat-row-agent">
            <Sigil agentId={agent.id} family={agent.family} size={14} color={tint} glow />
            <div className="mg-chat-bubble mg-chat-bubble-agent mg-chat-typing">
              <span className="mg-chat-dot" />
              <span className="mg-chat-dot" />
              <span className="mg-chat-dot" />
            </div>
          </div>
        )}
      </div>
      <div className="mg-chat-input-row">
        <textarea
          className="mg-chat-input"
          placeholder={`Instruct or ask ${agent.name}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
        />
        <button
          className="mg-chat-send"
          style={{ color: draft.trim() ? accent : "var(--p-dim)" }}
          disabled={!draft.trim() || pending}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function FleetModelPicker({ agent, accent }: { agent: AgentRow; accent: string }) {
  const fleet = useFleetModels();
  const { toggles } = useToolToggles();
  const [expanded, setExpanded] = useState(false);
  const def = fleetDefForAgent(agent);
  const setFleetModel = fleet.setModel;
  const defKey = def?.key ?? null;
  const currentSelectedId = defKey ? fleet.selections[defKey] ?? "" : "";

  useEffect(() => {
    setExpanded(false);
  }, [agent.id]);

  useEffect(() => {
    if (!defKey) return;
    const syncSelection = () => {
      const persisted = getFleetModel(defKey);
      if (persisted && persisted !== currentSelectedId) setFleetModel(defKey, persisted);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncSelection();
    };
    syncSelection();
    window.addEventListener("storage", syncSelection);
    window.addEventListener("focus", syncSelection);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("storage", syncSelection);
      window.removeEventListener("focus", syncSelection);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [currentSelectedId, defKey, setFleetModel]);

  if (!def) return null;

  const selectedId = (currentSelectedId || def.options[0]?.id) ?? "";
  const selected = def.options.find((o) => o.id === selectedId) ?? def.options[0];
  const selectedCut = selected ? isModelOptionDisabled(selected.billing, toggles) : false;
  const prefOnly = def.wire === "preference-only";
  const rail = selected ? RAIL_TAG[selected.billing] : "--";
  const chipTitle = prefOnly
    ? `assign model + billing - PREFERENCE ONLY: ${def.name} has no live executor yet, this choice is saved but not run`
    : def.key === "lens"
      ? "assign model + billing - live for OpenRouter/NVIDIA picks; a Claude Max pick here persists but qa_inspect has no Max vision seam yet"
      : "assign model + billing - sets the floor model for this agent's real runs; the brain's per-step plan can still override it";

  return (
    <div className="mg-model-picker" style={{ "--mg-model-accent": accent } as React.CSSProperties}>
      <button
        type="button"
        className={`mg-model-chip ${selectedCut ? "is-cut" : ""} ${prefOnly ? "is-pref" : ""}`}
        title={chipTitle}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="mg-model-chip-label">{selected?.label ?? "Model"}</span>
        {prefOnly && <span className="mg-model-pref" title="preference only - no live executor yet">pref</span>}
        <span className="mg-model-rail" title={selected ? `billed via ${BILLING_LABEL[selected.billing]}` : ""}>{rail}</span>
        <span className="mg-model-caret">▾</span>
      </button>

      {expanded && (
        <div className="mg-model-menu" role="listbox" aria-label={`Assign ${def.name} model`}>
          <div className="mg-model-menu-head">ASSIGN {def.name.toUpperCase()} - billed where it runs</div>
          {def.options.map((option) => {
            const disabled = isModelOptionDisabled(option.billing, toggles);
            const isSelected = selected?.id === option.id;
            return (
              <button
                key={`${def.key}-${option.id}`}
                type="button"
                className={`mg-model-option ${disabled ? "is-disabled" : ""}`}
                role="option"
                aria-selected={isSelected}
                disabled={disabled}
                onClick={() => {
                  setFleetModel(def.key, option.id);
                  setExpanded(false);
                }}
              >
                <span className="mg-model-option-dot">{isSelected ? "●" : "○"}</span>
                <span className="mg-model-option-main">
                  <span className="mg-model-option-label">{option.label}</span>
                  <span className="mg-model-option-note">{disabled ? "breaker open" : option.note}</span>
                </span>
                <span className="mg-model-option-rail">{RAIL_TAG[option.billing]}</span>
              </button>
            );
          })}
          <div className="mg-model-hint">{def.hint}</div>
        </div>
      )}
    </div>
  );
}

function isModelOptionDisabled(
  billing: FleetModelOption["billing"],
  toggles: Record<ToolKey, boolean>,
): boolean {
  const breaker = RAIL_BREAKER[billing];
  return !!breaker && toggles[breaker as ToolKey] === false;
}

function ChatBubble({
  msg,
  agent,
  accent,
  tint,
}: {
  msg: ChatMessage;
  agent: AgentRow;
  accent: string;
  tint: string;
}) {
  const isZach = msg.role === "zach";
  return (
    <div className={`mg-chat-row ${isZach ? "mg-chat-row-zach" : "mg-chat-row-agent"}`}>
      {!isZach && <Sigil agentId={agent.id} family={agent.family} size={14} color={tint} />}
      <div className={`mg-chat-bubble ${isZach ? "mg-chat-bubble-zach" : "mg-chat-bubble-agent"}`}>
        {!isZach && msg.meta?.kind === "work-order" && (
          <div className="mg-chat-tag" style={{ color: accent }}>▸ orchestrator</div>
        )}
        {isZach && msg.meta?.operatorDirected && (
          <div className="mg-chat-tag mg-chat-tag-dim">direct instruction</div>
        )}
        <p className="mg-chat-text">{msg.text}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------
function SystemPane(p: CockpitProps & { liveAreas: Set<string> }) {
  const { graph, accent, liveAreas } = p;
  // ONE bucket derivation (shared with the header + Atlas panel via deriveAreaBuckets): the
  // artifacts total ALWAYS equals Σ the shown category counts, and any un-tagged node surfaces
  // as an explicit "Uncategorized" row instead of vanishing from the sum (2026-07-10 fix).
  const { buckets, total: artifacts } = useMemo(
    () => deriveAreaBuckets(graph),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, p.mutateTick],
  );
  const links = graph.edges.filter((e) => e.kind === "link" || e.kind === "dep").length;

  const autoIdx = TRUST_LEVELS.findIndex((r) => r.key === p.autonomy);
  const auto = TRUST_LEVELS[Math.max(0, autoIdx)];

  const systemMetrics = [
    { k: "Artifacts", v: String(artifacts), c: "var(--p-text)" },
    { k: "Connections", v: String(links), c: "var(--p-text)" },
    { k: "Areas live", v: `${liveAreas.size}/${buckets.length}`, c: accent },
    { k: "Fleet firing", v: String(p.working), c: accent },
  ];

  return (
    <div className="mg-pane mg-system">
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h4 className="mg-sec-head">Areas · {buckets.length}</h4>
        <ul className="mg-area-legend">
          {buckets.map((a) => {
            const firing = liveAreas.has(a.id);
            return (
              <li key={a.id} className="mg-area-row">
                <span className="mg-area-dot" style={{ background: a.hue, boxShadow: `0 0 10px -3px ${a.hue}` }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                  <span className="mg-area-name">{a.name}</span>
                  <span className="mg-area-blurb mg-ellip">{a.blurb}</span>
                </span>
                {firing && <span className="mg-area-firing" style={{ background: accent, boxShadow: `0 0 7px ${accent}` }} />}
                <span className="mg-area-count">{a.count}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mg-sec-bordered">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h4 className="mg-sec-head">Autonomy</h4>
          <span className="mg-auto-label" style={{ color: accent }}>{auto.label}</span>
        </div>
        <div style={{ display: "flex", gap: 3 }}>
          {TRUST_LEVELS.map((r, i) => (
            <button
              key={r.key}
              title={r.label}
              onClick={() => p.setAutonomy(r.key)}
              className="mg-auto-rung"
              style={{
                background: i <= autoIdx ? accent : "rgba(150,168,205,.16)",
                boxShadow: i <= autoIdx ? `0 0 7px -2px ${accent}` : "none",
              }}
            />
          ))}
        </div>
        <p className="mg-auto-blurb">{auto.blurb}</p>
        <p className="mg-auto-guard">⊘ {auto.guard}</p>
      </section>

      <section className="mg-sys-metrics">
        {systemMetrics.map((m) => (
          <div key={m.k} className="mg-sys-metric">
            <div className="mg-metric-k">{m.k}</div>
            <div className="mg-sys-metric-v" style={{ color: m.c }}>{m.v}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A constellation sigil as an inline SVG (mirrors the DC's roster glyph). */
function Sigil({
  agentId,
  family,
  size,
  color,
  dim,
  glow,
}: {
  agentId: string;
  family: string | null;
  size: number;
  color: string;
  dim?: boolean;
  glow?: boolean;
}) {
  const paths = agentSigil(agentId, family);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        flex: "none",
        marginTop: 2,
        color,
        opacity: dim ? 0.45 : 1,
        filter: glow ? `drop-shadow(0 0 3px ${rgba(color, 0.7)})` : "none",
      }}
    >
      {paths.map((gp, i) => (
        <path key={i} d={gp.d} stroke="currentColor" strokeWidth={1.7 * (gp.w ?? 1)} />
      ))}
    </svg>
  );
}

/** Resolve an agent's focus (a node id or a label the graph names) to a GNode. */
function resolveFocusNode(a: AgentRow, p: CockpitProps): GNode | null {
  if (!a.focus) return null;
  if (p.byId.has(a.focus)) return p.byId.get(a.focus)!;
  // try label match
  for (const n of p.byId.values()) if (n.label === a.focus) return n;
  return null;
}

/** Map an AgentRow.touches display name (e.g. "Praxis", "Catalyzed Alpha") OR an area id to an AreaId. */
function areaIdOf(touch: string): AreaId {
  const byName = AREAS.find((a) => a.name === touch || a.id === touch);
  if (byName) return byName.id;
  const lc = touch.toLowerCase();
  if (lc.includes("catalyzed")) return "catalyzed";
  if (lc.includes("learn")) return "learnai";
  if (lc.includes("financ") || lc.includes("trad")) return "finance";
  if (lc.includes("venture") || lc.includes("freelanc")) return "ventures";
  if (lc.includes("studio")) return "studio";
  if (lc.includes("praxis")) return "praxis";
  return "global";
}
