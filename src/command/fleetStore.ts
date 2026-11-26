/**
 * fleetStore - per-agent model selection for the Praxis fleet.
 *
 * Every option carries its billing source; the Command Center renders it as a rail badge (MAX /
 * CODEX / CURSOR / OR / NVIDIA) on the option AND the row.
 *
 * Quill (cursor) went LIVE 2026-07-10: `cursor-agent` is installed AND authenticated
 * on this machine (verified via `cursor-agent status` / `cursor-agent models`), so
 * its options are now real cursor-agent model ids (billing "cursor-sub" throughout)
 * instead of the old preference-only placeholder set.
 *
 * Selections persist to localStorage (`praxis.fleet.models.v1`) + the disk mirror
 * (state_mirror.rs) and are read by the SAME plain-reader pattern
 * `src/orchestrator/policy.ts` uses for tool kill-switches. `useFleetModels()` also
 * broadcasts a Tauri event + listens for the `storage` event (same idiom as
 * haltStore.ts's useHalt / controlStore.ts's useExecMode) so a model switched in the
 * Command Center's Fleet panel is reflected LIVE in every other open window (Flight
 * Deck's agent console included) - no reload, no restart.
 *
 * Picking an option OUTSIDE the seam's native sources persists the preference and shows it
 * honestly in the UI (FleetPanel marks it "pref" even when the agent's OTHER picks are live),
 * but the seam readers (`defaultModelForTool`, `executableModelFor`) return the CLI default
 * instead of injecting a --model the executor would crash on. Those ranks go live the moment a
 * matching driver/seam exists.
 *
 * Live seams today:
 *   - Forge (claude) / Vega (codex) / Quill (cursor) → defaultModelFor(tool) in
 *     policy.ts → agent_delegate(tool, …, model) in hermes_bridge.rs - consumed by
 *     BOTH the in-webview orchestrate() loop AND Flight Deck's fd_spawn_session path
 *     (src/flightdeck/deck/DeckApp.tsx reads the SAME executableModelFor()).
 *   - Sage/Atlas/Scribe → preference-only until their drivers land (no research/
 *     vault/org CLI drivers yet). Board-meeting contributions (boardContributors.ts)
 *     DO route through each agent's selection via brain_chat.
 */

import { useState, useEffect, useCallback } from "react";
import type { DriverTool } from "@/orchestrator/drivers";
import { mirrorSet } from "@/shared/persist";
import { brainRawAfterDefaultMigration } from "@/shared/brainPersistence";

// ----------------------------------------------------------------- types ---

export type BillingSource =
  | "openai-api"
  | "openrouter"
  | "nvidia" // NVIDIA NIM - free finite pool
  | "claude-max"
  | "chatgpt"
  | "cursor-sub"; // Cursor sub

export const BILLING_LABEL: Record<BillingSource, string> = {
  "openai-api": "OpenAI API",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA",
  "claude-max": "Claude Pro",
  chatgpt: "Codex",
  "cursor-sub": "Cursor",
};

/** Short rail tag for the Command Center fleet rows + option badges. */
export const RAIL_TAG: Record<BillingSource, string> = {
  "openai-api": "OAI",
  "claude-max": "PRO",
  chatgpt: "CODEX",
  "cursor-sub": "CURSOR",
  openrouter: "OR",
  nvidia: "NVIDIA",
};

/** Which Command Center breaker (controlStore ToolKey) cuts this billing rail.
 *  NVIDIA has no breaker - it's the free fallback pool. */
export const RAIL_BREAKER: Partial<Record<BillingSource, string>> = {
  "claude-max": "claude",
  chatgpt: "codex",
  "cursor-sub": "cursor",
  openrouter: "openrouter",
};

/** One selectable model for an agent's dropdown. */
export interface FleetModelOption {
  /** Model id passed straight to the delegation seam when executable
   *  (e.g. "sonnet", "gpt-5.5", "moonshotai/kimi-k3"). Empty = CLI default. */
  id: string;
  label: string;
  billing: BillingSource;
  /** Serif-italic note in the dropdown - WHY this rank (from the approved table). */
  note: string;
}

export type WireClass = "live" | "preference-only";

export interface FleetAgentDef {
  key: string;
  name: string;
  role: string;
  options: FleetModelOption[];
  wire: WireClass;
  /** Billing sources this agent's LIVE seam can actually execute. Selections on
   *  other sources persist as preference but never reach the executor. */
  nativeBilling: BillingSource[];
  /** One-line note on exactly what this dropdown does when changed. */
  hint: string;
}


const FLEET_AGENT_CATALOG: FleetAgentDef[] = [
  {
    key: "forge",
    name: "Forge",
    role: "claude code",
    wire: "live",
    nativeBilling: ["claude-max"],
    hint: "PRO ranks set --model on agent_delegate claude steps; OR/NVIDIA ranks persist until an overflow driver exists",
    options: [
      { id: "claude-opus-5-5", label: "Opus 5.5", billing: "claude-max", note: "default · hardest reasoning · Claude subscription" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", billing: "claude-max", note: "routine Claude Code work · lighter on the 5h window" },
      { id: "claude-fable-5-1", label: "Fable 5.1", billing: "claude-max", note: "creative / writing · Claude subscription" },
      { id: "z-ai/glm-5.3", label: "GLM 5.3", billing: "openrouter", note: "coding/tool-use overflow" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", billing: "openrouter", note: "agentic overflow" },
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning 30B", billing: "nvidia", note: "free fallback" },
    ],
  },
  {
    key: "vega",
    name: "Vega",
    role: "codex",
    wire: "live",
    nativeBilling: ["chatgpt"],
    hint: "CODEX ranks set --model on agent_delegate codex steps; OR/NVIDIA ranks persist until an overflow driver exists",
    options: [
      // The id is verified against his own /v1/models listing, not assumed from the name.
      { id: "gpt-6-astra", label: "GPT-6 Astra", billing: "chatgpt", note: "default · hardest execution · ChatGPT subscription" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", billing: "chatgpt", note: "previous top · ChatGPT subscription" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", billing: "chatgpt", note: "balanced · lighter on the 5h window" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", billing: "chatgpt", note: "fast · simple execution" },
      { id: "z-ai/glm-5.3", label: "GLM 5.3", billing: "openrouter", note: "overflow route" },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", billing: "openrouter", note: "cheap reasoning" },
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning 30B", billing: "nvidia", note: "free fallback" },
    ],
  },
  {
    key: "quill",
    name: "Quill",
    role: "cursor",
    // LIVE as of 2026-07-10 - cursor-agent is installed AND authenticated
    // (`cursor-agent status` → "Logged in"). Every option below is a real
    // cursor-agent model id (verified via `cursor-agent models`), billed through
    // the Cursor sub, so the whole catalog is executable, not just rank 1.
    wire: "live",
    nativeBilling: ["cursor-sub"],
    hint: "Sets --model on Quill's cursor-agent steps. Only Cursor's own models: they bill the Cursor Models pool, never the API pool",
    options: [
      // A saved pick that is no longer listed falls back to the first option (loadFleet's
      // guard), and Rust remaps any other id to Grok 4.6 regardless
      // (hermes_bridge::quill_model).
      { id: "grok-4.7-high", label: "Grok 4.7", billing: "cursor-sub", note: "default · fast execution · Cursor Models pool, not API" },
      { id: "grok-4.7-xhigh", label: "Grok 4.7 Extra High", billing: "cursor-sub", note: "harder execution · Cursor Models pool" },
      { id: "grok-4.7-medium", label: "Grok 4.7 Medium", billing: "cursor-sub", note: "quick passes · Cursor Models pool" },
      { id: "composer-2.5", label: "Composer 2.5", billing: "cursor-sub", note: "simple / mechanical work · cheapest · Cursor Models pool" },
      { id: "cursor-grok-4.6-high", label: "Grok 4.6", billing: "cursor-sub", note: "previous Grok · Cursor Models pool" },
    ],
  },
  {
    key: "sage",
    name: "Sage",
    role: "research",
    wire: "preference-only",
    nativeBilling: ["openrouter", "nvidia", "chatgpt", "claude-max"],
    hint: "Routes Sage's board-meeting statement + future research driver through this model/provider",
    options: [
      { id: "claude-opus-5-5", label: "Opus 5.5", billing: "claude-max", note: "default · deep research · Claude subscription" },
      { id: "gpt-6-astra", label: "GPT-6 Astra", billing: "chatgpt", note: "deep research · ChatGPT subscription" },
      { id: "claude-fable-5-1", label: "Fable 5.1", billing: "claude-max", note: "synthesis · Claude subscription" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", billing: "openrouter", note: "multimodal overflow" },
      { id: "minimax/minimax-m3", label: "MiniMax M3", billing: "openrouter", note: "multimodal incl. video overflow" },
      { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", billing: "nvidia", note: "free fallback" },
    ],
  },
  {
    key: "lens",
    name: "Lens",
    role: "visual qa",
    wire: "live",
    nativeBilling: ["chatgpt", "openrouter", "nvidia"],
    hint: "Chooses the model Praxis uses to LOOK at a finished build's screenshots (Codex subscription for GPT ranks); OR/NVIDIA ranks also drive qa_inspect for app windows",
    options: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", billing: "chatgpt", note: "default · looks at build screenshots through the Codex subscription" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", billing: "chatgpt", note: "lighter vision · ChatGPT subscription" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", billing: "openrouter", note: "multimodal · runs qa_inspect for app windows" },
      { id: "minimax/minimax-m3", label: "MiniMax M3", billing: "openrouter", note: "best vision" },
      { id: "claude-fable-5-1", label: "Fable 5.1", billing: "claude-max", note: "sharp judgment · Claude subscription" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", billing: "claude-max", note: "cheaper · Claude subscription" },
      { id: "meta/llama-3.2-90b-vision-instruct", label: "Llama 3.2 Vision", billing: "nvidia", note: "free vision" },
    ],
  },
  {
    key: "atlas",
    name: "Atlas",
    role: "live operator",
    wire: "preference-only",
    nativeBilling: ["nvidia", "openrouter", "claude-max", "chatgpt"],
    hint: "Routes Atlas's board statement + org-sweep summarization; the visible CU operator itself drives Codex Desktop directly. Atlas's VOICE stays OpenAI Realtime (API, no subscription equivalent) — unaffected by this text-model pick",
    options: [
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", billing: "claude-max", note: "default · fast always-on driver · Claude subscription" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", billing: "chatgpt", note: "subscription alternate · ChatGPT" },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", billing: "openrouter", note: "fast + cheap overflow" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", billing: "openrouter", note: "when it matters" },
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning 30B", billing: "nvidia", note: "free fallback" },
    ],
  },
  {
    key: "scribe",
    name: "Scribe",
    role: "vault keeper",
    wire: "preference-only",
    nativeBilling: ["nvidia", "openrouter", "claude-max", "chatgpt"],
    hint: "Routes Scribe's future summarize/link passes; board statement is mechanical (no model call)",
    options: [
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", billing: "claude-max", note: "default · fast always-on driver · Claude subscription" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", billing: "chatgpt", note: "subscription alternate · ChatGPT" },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", billing: "openrouter", note: "cheap bulk overflow" },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", billing: "openrouter", note: "when it matters" },
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning 30B", billing: "nvidia", note: "free fallback" },
    ],
  },
];

/** Agents whose `key` doubles as a `DriverTool` - the live delegation seam. */
// A previous compatibility layer replaced every row with paid OpenAI API models, which made the
// live UI and execution contract contradict the available Codex/Claude/Cursor seats.
export const FLEET_AGENTS: FleetAgentDef[] = FLEET_AGENT_CATALOG;

const DRIVER_TOOL_KEYS = new Set<string>(["forge", "vega", "quill"]);
const TOOL_FOR_AGENT: Record<string, DriverTool> = {
  forge: "claude",
  vega: "codex",
  quill: "cursor",
};

// --------------------------------------------------------------- constants ---

const FLEET_KEY = "praxis.fleet.models.v1";

function agentDef(key: string): FleetAgentDef | undefined {
  return FLEET_AGENTS.find((a) => a.key === key);
}

function defaultSelections(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const agent of FLEET_AGENTS) {
    out[agent.key] = agent.options[0]?.id ?? "";
  }
  return out;
}

// --------------------------------------------------------------- storage helpers ---

/**
 * One-time move off GPT-5.6 Sol, 2026-09-09.
 *
 * A selection that is still valid is left alone, which is normally right and wrong here.
 *
 * Runs once, marked by its own key, so a later deliberate pick of Sol survives
 * every restart after it.
 */
const ASTRA_UPGRADE_KEY = "praxis.fleet.models.upgrade.astra";
const ASTRA_UPGRADES: Record<string, string> = {
  "gpt-5.6-sol": "gpt-6-astra",
  // Vega-only medium tier; Quill never had a live cursor-agent id here - any quill
  // row that lands on this id is cleared by applyQuillStaleCursorIds below.
  "gpt-5.6-sol-medium": "gpt-6-astra-medium",
};

/**
 * One-time move to the 2026-10-10 catalog. Claude seats now carry the exact model id instead of
 * the CLI's moving alias, so the label can't drift from what runs; gpt-5.5-pro left the Codex
 * roster. Runs once; a later deliberate pick sticks.
 */
const LATEST_UPGRADE_KEY = "praxis.fleet.models.upgrade.1010";
const LATEST_UPGRADES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  "claude-fable-5": "claude-fable-5-1",
  "cursor-grok-4.6-high": "grok-4.7-high",
  "gpt-5.5-pro": "gpt-6-astra",
  "gpt-5.5": "gpt-5.6-terra",
};
/** Agent-specific moves: Lens's old default becomes the seat that can actually look. */
const LATEST_AGENT_UPGRADES: Record<string, Record<string, string>> = {
  lens: { "gpt-5.6-terra": "gpt-6-astra" },
};

function applyLatestUpgrade(storage: Storage): void {
  try {
    if (storage.getItem(LATEST_UPGRADE_KEY) === "1") return;
    const raw = storage.getItem(FLEET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<string, string>>;
      let changed = false;
      for (const [agent, id] of Object.entries(parsed)) {
        if (typeof id !== "string") continue;
        const next = LATEST_AGENT_UPGRADES[agent]?.[id] ?? LATEST_UPGRADES[id];
        if (next && next !== id) {
          parsed[agent] = next;
          changed = true;
        }
      }
      if (changed) {
        const body = JSON.stringify(parsed);
        storage.setItem(FLEET_KEY, body);
        mirrorSet(FLEET_KEY, body);
      }
    }
    storage.setItem(LATEST_UPGRADE_KEY, "1");
    mirrorSet(LATEST_UPGRADE_KEY, "1");
  } catch {
    /* storage unavailable - the catalog defaults already lead with the latest models */
  }
}

/** cursor-agent ids removed from Quill's catalog - fall back to "" (no --model). */
const QUILL_STALE_CURSOR_IDS = new Set(["gpt-6-astra-medium", "claude-opus-4-8-high"]);

function applyQuillStaleCursorIds(storage: Storage): void {
  try {
    const raw = storage.getItem(FLEET_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Record<string, string>>;
    const quillId = parsed.quill;
    if (typeof quillId === "string" && QUILL_STALE_CURSOR_IDS.has(quillId)) {
      parsed.quill = "";
      const body = JSON.stringify(parsed);
      storage.setItem(FLEET_KEY, body);
      mirrorSet(FLEET_KEY, body);
    }
  } catch {
    /* storage unavailable - catalog migration guard still rescues on read */
  }
}

function applyAstraUpgrade(storage: Storage): void {
  try {
    if (storage.getItem(ASTRA_UPGRADE_KEY) === "1") return;
    const raw = storage.getItem(FLEET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<string, string>>;
      let changed = false;
      for (const [agent, id] of Object.entries(parsed)) {
        const next = typeof id === "string" ? ASTRA_UPGRADES[id] : undefined;
        if (next) {
          parsed[agent] = next;
          changed = true;
        }
      }
      if (changed) {
        const body = JSON.stringify(parsed);
        storage.setItem(FLEET_KEY, body);
        mirrorSet(FLEET_KEY, body);
      }
    }
    storage.setItem(ASTRA_UPGRADE_KEY, "1");
    mirrorSet(ASTRA_UPGRADE_KEY, "1");
  } catch {
    /* storage unavailable - the catalog default already leads with Astra */
  }
}

const NATIVE_RAIL_KEY = "praxis.fleet.nativeRail.v1";

/**
 * Put the three DRIVER agents back on a rail that can actually run them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Forge, Vega and Quill are not chat personas - they ARE Claude Code, Codex and
 * Cursor. `delegateContribution` refuses to run one whose selected model is not on
 * that tool's native billing, because there is no executor for an OpenRouter model
 * pretending to be Codex. That refusal is correct.
 *
 * What was wrong is that a stored preference could put an agent there and leave it there
 * forever.
 *
 * A non-native pick on a driver agent is not a preference, it is an agent that can
 * never speak. So this runs ONCE and moves only those agents, only when their
 * current pick cannot execute, and only to that agent's own native default. A
 * deliberate re-pick afterwards sticks, exactly like the Astra migration above.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function applyNativeRailRepair(storage: Storage): void {
  try {
    if (storage.getItem(NATIVE_RAIL_KEY) === "1") return;
    const raw = storage.getItem(FLEET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<string, string>>;
      let changed = false;
      for (const def of FLEET_AGENT_CATALOG) {
        // Only the driver agents; everyone else may sit on any rail they like.
        if (!DRIVER_TOOL_KEYS.has(def.key)) continue;
        const nativeBilling = def.nativeBilling ?? [];
        if (!nativeBilling.length) continue;
        const currentId = parsed[def.key];
        if (typeof currentId !== "string") continue;
        const current = def.options.find((o: FleetModelOption) => o.id === currentId);
        // Unknown ids are left alone: the catalog may simply have moved on, and
        // guessing is what this migration exists to stop.
        if (!current) continue;
        if (nativeBilling.includes(current.billing)) continue;
        const nativeDefault = def.options.find((o: FleetModelOption) => nativeBilling.includes(o.billing));
        if (!nativeDefault || nativeDefault.id === currentId) continue;
        parsed[def.key] = nativeDefault.id;
        changed = true;
      }
      if (changed) {
        const body = JSON.stringify(parsed);
        storage.setItem(FLEET_KEY, body);
        mirrorSet(FLEET_KEY, body);
      }
    }
    storage.setItem(NATIVE_RAIL_KEY, "1");
    mirrorSet(NATIVE_RAIL_KEY, "1");
  } catch {
    /* storage unavailable - the catalog default already leads with a native rail */
  }
}

function loadFleet(): Record<string, string> {
  try {
    applyAstraUpgrade(localStorage);
    applyQuillStaleCursorIds(localStorage);
    applyLatestUpgrade(localStorage);
    applyNativeRailRepair(localStorage);
    // The brain's one-time legacy-default migration depends on the exact
    // generated all-OAI fleet signature. Run it before this loader normalizes
    // that fleet snapshot so hook order cannot erase the migration evidence.
    brainRawAfterDefaultMigration(localStorage);
    const raw = localStorage.getItem(FLEET_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<string, string>>) : {};
    const merged = defaultSelections();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      // Catalog migration guard: a persisted id from an older table that no longer
      // exists in this agent's options falls back to rank 1 instead of rendering a
      // phantom selection the dropdown can't show.
      const def = agentDef(key);
      if (def && !def.options.some((o) => o.id === value)) continue;
      merged[key] = value;
    }
    const body = JSON.stringify(merged);
    if (raw !== body) {
      localStorage.setItem(FLEET_KEY, body);
      mirrorSet(FLEET_KEY, body);
    }
    return merged;
  } catch {
    return defaultSelections();
  }
}

function saveFleet(v: Record<string, string>): void {
  try {
    const body = JSON.stringify(v);
    localStorage.setItem(FLEET_KEY, body);
    mirrorSet(FLEET_KEY, body);
  } catch {
    /* best-effort */
  }
  void broadcastFleetChange();
}

// --------------------------------------------------------------- cross-window sync ---

/** Fired whenever ANY window saves a fleet model change. Every `useFleetModels()`
 *  instance (Command Center's Fleet panel, Flight Deck's agent console) listens
 *  and re-reads localStorage, so a switch made in one window shows up live in every
 *  other open window - same idiom as haltStore.ts's HALT_EVENT / controlStore.ts's
 *  EXEC_MODE_EVENT. Combined with the native `storage` event (fires in every OTHER
 *  same-origin window automatically) for double coverage - the Tauri event catches
 *  same-window-different-render-tree cases the DOM storage event doesn't. */
export const FLEET_MODEL_EVENT = "praxis://fleet-model";

async function broadcastFleetChange(): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(FLEET_MODEL_EVENT, {});
  } catch {
    /* dev browser - the storage event alone still covers same-origin windows */
  }
}

// --------------------------------------------------------------- plain readers ---

/**
 * getFleetModel - safe to call outside React. Returns the persisted model id for
 * an agent key ("" if unset/unknown). Raw - does NOT gate on executability.
 */
/** Map a live roster row to its Fleet definition (Forge / Sage / Vega / …).
 *  Shared so the model a surface SHOWS for an agent and the model that actually
 *  serves that agent's requests are resolved from one place - they used to be
 *  derived independently, which is how the Memory Galaxy's chat header could show
 *  one model while another answered. */
export function fleetDefForAgent(agent: { id: string; name: string }): FleetAgentDef | null {
  const candidates = [agent.id.replace(/^a\./, "").toLowerCase(), agent.name.toLowerCase()];
  if (candidates.includes("ledger")) candidates.push("scribe");
  return (
    FLEET_AGENTS.find(
      (def) => candidates.includes(def.key) || candidates.includes(def.name.toLowerCase()),
    ) ?? null
  );
}

export function getFleetModel(agentKey: string): string {
  const all = loadFleet();
  return all[agentKey] ?? "";
}

/** The full selected option (id + billing) for an agent, or null when unresolvable. */
export function getFleetSelection(agentKey: string): FleetModelOption | null {
  const def = agentDef(agentKey);
  if (!def) return null;
  const id = getFleetModel(agentKey);
  return def.options.find((o) => o.id === id) ?? def.options[0] ?? null;
}

/**
 * executableModelFor - the selected model id IF the agent's live seam can execute
 * its billing source, else "" (meaning: let the executor's own default apply).
 * This is what keeps an OpenRouter overflow pick from being injected as --model
 * into the claude/codex CLI, which would crash the delegation.
 */
export function executableModelFor(agentKey: string): string {
  const def = agentDef(agentKey);
  const sel = getFleetSelection(agentKey);
  if (!def || !sel) return "";
  return def.nativeBilling.includes(sel.billing) ? sel.id : "";
}

/**
 * defaultModelFor - the seam `src/orchestrator/policy.ts` calls. Maps a DriverTool
 * (claude/codex/cursor) back to its fleet agent and returns the persisted model id
 * when the CLI can execute it, or undefined for "use the CLI default".
 */
export function defaultModelForTool(tool: DriverTool): string | undefined {
  const key = Object.entries(TOOL_FOR_AGENT).find(([, t]) => t === tool)?.[0];
  if (!key) return undefined;
  const model = executableModelFor(key);
  return model.trim() ? model.trim() : undefined;
}

/**
 * setFleetModel - the plain (non-React) setter, so Praxis itself can reassign a model:
 * a typed or spoken "set Quill to Grok 4.7", or the orchestrator. Same persistence and
 * cross-window broadcast as the Fleet panel's own dropdown. Refuses an id that is not
 * in that agent's catalog, so nothing can persist a model the agent cannot run.
 */
export function setFleetModel(agentKey: string, modelId: string): boolean {
  const def = agentDef(agentKey);
  if (!def || !def.options.some((o) => o.id === modelId)) return false;
  saveFleet({ ...loadFleet(), [agentKey]: modelId });
  return true;
}

// --------------------------------------------------------------- hook ---

export interface FleetStore {
  selections: Record<string, string>;
  setModel: (agentKey: string, modelId: string) => void;
}

export function useFleetModels(): FleetStore {
  const [selections, setSelections] = useState<Record<string, string>>(loadFleet);

  // Cross-window sync: another window (Flight Deck's agent console, another CC
  // instance) changed a fleet model - re-read localStorage and update this
  // instance's view. Deliberately does NOT call saveFleet/broadcast itself (only
  // setModel below does that) - otherwise two open windows would ping-pong an
  // event back and forth forever. Same idiom as haltStore.ts's useHalt /
  // controlStore.ts's useExecMode.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === FLEET_KEY) setSelections(loadFleet());
    };
    window.addEventListener("storage", onStorage);
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen(FLEET_MODEL_EVENT, () => setSelections(loadFleet())))
      .then((f) => (off = f))
      .catch(() => {});
    return () => {
      window.removeEventListener("storage", onStorage);
      off?.();
    };
  }, []);

  const setModel = useCallback((agentKey: string, modelId: string) => {
    setSelections((prev) => {
      const next = { ...prev, [agentKey]: modelId };
      saveFleet(next); // localStorage + disk mirror + cross-window broadcast
      return next;
    });
  }, []);

  return { selections, setModel };
}

export { DRIVER_TOOL_KEYS };
