/**
 * eventAdapter.ts - the live bridge between the real PraxisEvent bus (src/data/eventBus.ts,
 * fed by useRealEvents.ts under Tauri) and the galaxy engine's narrow vault vocabulary
 * (applyEvent: read | write | link | create).
 *
 * The two schemas are related but NOT identical (see the design handoff "Event bridge"):
 *   • memory:updated / file:created         → write | create
 *   • agent:thinking "⚙ ToolName"           → read (Read/Grep/Glob…) | write (Write/Edit…)
 *   • agent:status (working/idle/done)       → whether the agent body exists / roams
 *   • task:progress                          → the agent's prog (rig hairline + Inspector)
 *
 * This is subscribe-only glue: it never touches React state directly; it drives the engine's
 * imperative state via applyEvent + setAgents. Returns an unsubscribe fn.
 */
import { eventBus } from "@/data/eventBus";
import type { PraxisEvent } from "@/data/schema";
import type { GalaxyEngine } from "./galaxyEngine";
import type { EngineAgent } from "./engineTypes";

/** Tools whose thought glyph ("⚙ Read") reads the vault vs. writes it. */
const READ_TOOLS = /^(read|grep|glob|ls|cat|search|find|bash)$/i;
const WRITE_TOOLS = /^(write|edit|multiedit|apply|patch|notebookedit|create)$/i;

/** Parse a "⚙ ToolName" thought into read | write | null. Exported as the ONE
 *  tool→verb classification - BottomRail's ticker imports it so the ticker and
 *  the canvas beads can never disagree on what reads vs writes the vault. */
export function toolVerb(thought?: string): "read" | "write" | null {
  if (!thought) return null;
  const m = thought.match(/^⚙\s*([A-Za-z]+)/);
  if (!m) return null;
  const tool = m[1];
  if (WRITE_TOOLS.test(tool)) return "write";
  if (READ_TOOLS.test(tool)) return "read";
  return "read"; // any other tool activity reads as a light "read"
}

/**
 * Wire the engine to the live event bus. `getAgents`/`setAgents` let the adapter maintain a
 * live working-set of agents (so a session coming alive spawns a roaming rig, and a session
 * ending docks it). `focusHint` resolves an agent to a node to operate on.
 */
export function attachEventBridge(
  engine: GalaxyEngine,
  opts: {
    /** current engine agents (a mutable snapshot the adapter refreshes). */
    getAgents: () => EngineAgent[];
    setAgents: (agents: EngineAgent[]) => void;
  },
): () => void {
  const { getAgents, setAgents } = opts;

  const patchAgent = (id: string, patch: Partial<EngineAgent>, ensure?: Partial<EngineAgent>) => {
    const agents = getAgents();
    const idx = agents.findIndex((a) => a.id === id);
    if (idx < 0) {
      if (!ensure) return;
      setAgents([
        ...agents,
        {
          id,
          name: id.replace(/^a\./, "").replace(/^\w/, (c) => c.toUpperCase()),
          fam: "sonnet",
          status: "idle",
          focus: null,
          prog: 0,
          progKnown: false,
          touches: [],
          ...ensure,
          ...patch,
        },
      ]);
      return;
    }
    const next = agents.slice();
    next[idx] = { ...next[idx], ...patch };
    setAgents(next);
  };

  const onEvent = (ev: PraxisEvent) => {
    // Every event on the galaxy's eventBus is a REAL Tauri push (useGalaxyRealEvents) - this
    // window has no mock timeline - so receiving one means reality is flowing. Mark the engine
    // so its ambient simulation stands down for the decay window (see engine.markRealEvent).
    engine.markRealEvent();
    const agentId = ev.agentId;
    switch (ev.type) {
      case "agent:status": {
        if (!agentId) return;
        const status = ev.status === "working" ? "working" : ev.status === "done" ? "done" : "idle";
        patchAgent(
          agentId,
          {
            status,
            ...(ev.areaId ? { touches: [ev.areaId] } : {}),
            ...(ev.model ? { fam: famOf(ev.model) } : {}),
            ...(ev.nodeId || ev.taskId ? { focus: ev.nodeId ?? ev.taskId ?? null } : {}),
          },
          { touches: ev.areaId ? [ev.areaId] : [], focus: ev.nodeId ?? ev.taskId ?? null },
        );
        break;
      }
      case "task:progress": {
        if (!agentId || ev.progress == null) return;
        // A genuine task:progress event IS a measurement - mark it known so the
        // rig's hairline may render it.
        patchAgent(agentId, { prog: Math.max(0, Math.min(1, ev.progress)), progKnown: true });
        break;
      }
      case "agent:thinking": {
        // tool activity → a read/write pulse on the agent's focus node
        if (!agentId) return;
        const verb = toolVerb(ev.thought);
        if (!verb) return;
        const path = ev.nodeId ?? ev.taskId ?? focusOf(getAgents(), agentId);
        if (path) engine.applyEvent({ type: verb, agent: agentId, path });
        break;
      }
      case "memory:updated": {
        if (!agentId) return;
        const path = ev.nodeId ?? ev.label;
        if (path) engine.applyEvent({ type: "write", agent: agentId, path });
        break;
      }
      case "file:created": {
        if (!agentId) return;
        const path = ev.nodeId ?? ev.label ?? ev.path;
        if (path) engine.applyEvent({ type: "create", agent: agentId, path, label: ev.label });
        break;
      }
      // task:start / task:complete / handoffs / journey / speaking: no direct vault mutation
      default:
        break;
    }
  };

  return eventBus.subscribe(onEvent);
}

function focusOf(agents: EngineAgent[], id: string): string | null {
  return agents.find((a) => a.id === id)?.focus ?? null;
}

/** Map a model string → a sigil/tint family token. */
function famOf(model: string): string {
  const s = model.toLowerCase();
  if (s.includes("hermes")) return "hermes";
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("fable")) return "fable";
  if (s.includes("codex")) return "codex";
  if (s.includes("cursor")) return "cursor";
  return "sonnet";
}
