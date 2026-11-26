/**
 * Voice command EXECUTION - the brain-side half of the Praxis loop.
 *
 * Split out of useVoice so the SAME execution path serves both callers:
 *   • the brain's own mic - useVoice → executeVoiceCommand (drives component status)
 *   • a secondary window's mic - the praxis://command bus forwards a raw utterance, the
 *                                   brain parses it and runs executeAndSpeak (no local UI)
 *
 * This module lives in the BRAIN window only - it touches usePraxisStore + the scene
 * eventBus. Secondary windows never import it; they forward raw utterances over the bus,
 * so there is exactly one mouth + one source of truth no matter which window is focused.
 */
import { invoke } from "@tauri-apps/api/core";
import { usePraxisStore } from "@/store/usePraxisStore";
import { buildGraph } from "@/data/graph";
import { eventBus } from "@/data/eventBus";
import { speak, cancelSpeech } from "./speak";
import { setExecMode, setToolEnabled } from "@/command/controlStore";
import { FLEET_AGENTS, setFleetModel } from "@/command/fleetStore";
import { setHalted } from "@/command/haltStore";
import { resolveBrainByName, setSelectedBrain } from "@/command/brainStore";
import { startOwnedOrchestration } from "@/orchestrator/ownedRuns";
import type { AreaRef, FormationPlacement, MonitorPlacement, VoiceCommand } from "./commands";

/** Tier-1 initiative areas, for the command router's "fly to <area>" matching. */
export const areaRefs = (): AreaRef[] =>
  buildGraph()
    .nodes.filter((n) => n.tier === 1)
    .map((n) => ({ id: n.id, label: n.label }));

const nodeLabel = (id?: string): string | undefined =>
  id ? buildGraph().byId.get(id)?.label : undefined;

/** Feed Hermes's REAL built-in memory (`~/.hermes/memories/MEMORY.md` / `USER.md`) a durable
 *  lesson via the `hermes_teach` Tauri command (see hermes_bridge.rs) - rides the same `hermes
 *  -z` mechanism as hermes_brain, framed so the agent's own `memory` tool saves it. Fire-and-
 *  forget: native Tauri only, and failure (Hermes off/uninstalled/slow) is swallowed - this
 *  must never affect the voice UX it's attached to. */
function teachHermes(lesson: string, target: "memory" | "user" = "memory") {
  const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!tauri) return;
  invoke("hermes_teach", { lesson, target }).catch(() => {
    /* Hermes off/uninstalled/slow - silent, non-fatal */
  });
}

/** Open a secondary super-app window by Rust command (native Tauri only; silent in a
 *  plain browser). */
function openWindow(cmd: string, name: string) {
  const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!tauri) return;
  invoke(cmd).catch((err) => {
    console.error(`[voice] ${name} open failed:`, err);
    usePraxisStore.getState().notify(`${name} didn't open — see console.`);
  });
}
const openFlightDeck = () => openWindow("open_flight_deck_cmd", "Flight Deck");
const openCommandCenter = () => openWindow("open_command_center_cmd", "Command Center");
const openMemoryGalaxy = () => openWindow("open_knowledge_cmd", "Memory Galaxy");

/** Hide (not destroy) a Praxis window by its Rust label. HIDE, not close: the secondary
 *  windows carry a live WebGL/Quartz context and the brain is a singleton the app keeps
 *  resident - destroying+rebuilding is slow and re-runs the deadlock-prone builder thread,
 *  so `close_window_cmd` calls `.hide()` on the Rust side. Silent in a plain browser. */
function closeWindow(label: "main" | "command" | "knowledge" | "flightdeck", name: string) {
  const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!tauri) return;
  invoke("close_window_cmd", { label }).catch((err) => {
    console.error(`[voice] ${name} close failed:`, err);
    usePraxisStore.getState().notify(`${name} didn't close — see console.`);
  });
}

const WINDOW_LABELS = {
  main: "Praxis",
  command: "Command Center",
  knowledge: "Memory Galaxy",
  flightdeck: "Flight Deck",
} as const;

/** Serialize a parsed `MonitorPlacement` into the plain string spec the Rust command parses
 *  (`MonitorTarget::parse` in src-tauri/src/lib.rs) - keep the two in sync. */
function placementSpec(placement: MonitorPlacement): string {
  switch (placement.kind) {
    case "primary":
      return "primary";
    case "left":
      return "left";
    case "right":
      return "right";
    case "index":
      return `index:${placement.n}`;
    case "next":
    default:
      return "next";
  }
}

function formationScreenSpec(placement?: FormationPlacement): string | undefined {
  if (!placement) return undefined;
  if (placement.kind === "largest") return "largest";
  return placementSpec(placement);
}

async function moveWindowToMonitor(windowLabel: keyof typeof WINDOW_LABELS, placement: MonitorPlacement): Promise<string> {
  const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!tauri) return `${WINDOW_LABELS[windowLabel]} window placement only works in the Praxis desktop app.`;
  try {
    return await invoke<string>("move_window_to_monitor_cmd", { label: windowLabel, target: placementSpec(placement) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[voice] ${WINDOW_LABELS[windowLabel]} move failed:`, err);
    usePraxisStore.getState().notify(`${WINDOW_LABELS[windowLabel]} move failed - ${msg}`);
    return `${WINDOW_LABELS[windowLabel]} did not move: ${msg}`;
  }
}

export interface ExecResult {
  reply: string;
  /** emit the core's speaking ripple? (ask/capture route through the store, which already
   *  ripples, so they return false). */
  ripple: boolean;
  /** stand the mic down after speaking? */
  sleep: boolean;
}

const stoppedExecResult = (): ExecResult => ({ reply: "Stopped.", ripple: false, sleep: false });

const inDesktop = (): boolean => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const result = (reply: string): ExecResult => ({ reply, ripple: true, sleep: false });
const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

interface UsageRow {
  key: string;
  plan: {
    window: string; label: string; used: number; limit: number;
    basis?: string; estimated?: boolean; resets_at?: number | null;
  }[];
}


function resetClock(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return new Date().toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })} ${time}`;
}

/** Use the wire rows, including refusal/backoff sentinels; never turn missing
 *  readings into zero, or an estimated limit into a live percentage. */
function usageReply(rows: UsageRow[]): string {
  return rows.map(({ key, plan }) => {
    const name = ({ claude: "Claude", codex: "Codex", cursor: "Cursor", openrouter: "OpenRouter" } as Record<string, string>)[key] ?? key;
    const refused = plan.find((p) => p.window === "refused");
    if (refused) return `${name}: The vendor is refusing Claude Code`;
    return `${name}: ${plan.map((p) => {
      const reset = p.resets_at != null && Number.isFinite(p.resets_at)
        ? resetClock(p.resets_at) : "";
      if (p.window === "paused") return `live meter paused${reset ? ` until ${reset}` : " (reset unknown)"}`;
      if (p.window === "auth" || p.window === "limit") return `${p.label}${reset ? `; resets ${reset}` : ""}`;
      const label = p.window === "5h" || p.window === "weekly" ? p.window : p.label || p.window;
      const basis = p.basis ?? (p.estimated ? "estimated" : "unknown basis");
      const qualifier = basis === "real" ? "" : ` (${basis})`;
      const value = Number.isFinite(p.used) && Number.isFinite(p.limit) && p.limit > 0
        ? `${Math.round(p.used / p.limit * 100)}%${qualifier}` : "unavailable";
      return `${label} ${value}${reset ? `; resets ${reset}` : ""}`;
    }).join(", ") || "no meter available"}`;
  }).join("; ") || "no plan meters available";
}

// Match spelling, punctuation and partial names against TODAY'S catalog. An
// ambiguous partial name must never select whichever option happens to be first.
function fuzzyChoice<T>(query: string, choices: T[], names: (choice: T) => string[]): T | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const needle = normalize(query);
  if (!needle) return undefined;
  const exact = choices.filter((choice) => names(choice).some((name) => normalize(name) === needle));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  if (needle.length < 3) return undefined;
  const partial = choices.filter((choice) => names(choice).some((name) => normalize(name).includes(needle)));
  return partial.length === 1 ? partial[0] : undefined;
}

async function broadcastRefresh(event: string): Promise<string> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event);
    return "";
  } catch (err) {
    return `; window refresh broadcast failed: ${errorText(err)}`;
  }
}

async function pauseRefresh(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Execute a parsed voice command against the store. Returns the text to speak, whether the
 * caller should emit the core's speaking ripple, and whether to stand the mic down.
 */
export async function executeVoiceCommand(
  cmd: VoiceCommand,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<ExecResult> {
  if (signal?.aborted) return stoppedExecResult();
  const s = usePraxisStore.getState();
  const { intent, say } = cmd;
  switch (intent.kind) {
    case "view":
      if (intent.view === "toggle") s.toggleViewMode();
      else s.setViewMode(intent.view);
      return { reply: say, ripple: true, sleep: false };
    case "overview":
      s.focus(null);
      return { reply: say, ripple: true, sleep: false };
    case "area":
      if (s.viewMode === "journey") s.focusAreaLane(intent.areaId);
      else s.focus(intent.areaId);
      return { reply: say, ripple: true, sleep: false };
    case "transport": {
      if (s.viewMode !== "journey") s.setViewMode("journey");
      const j = usePraxisStore.getState();
      if (intent.axis === "time") j.scrubTime(intent.dir);
      else if (intent.axis === "task") j.hopTask(intent.dir);
      else j.switchArea(intent.dir);
      return { reply: say, ripple: true, sleep: false };
    }
    case "open":
      if (intent.target === "flightdeck") openFlightDeck();
      else if (intent.target === "command") openCommandCenter();
      else if (intent.target === "memory") openMemoryGalaxy();
      else if (intent.target === "dump") s.setDumpOpen(true);
      else s.setChatOpen(true);
      return { reply: say, ripple: true, sleep: false };
    case "close": {
      // Hide the named Praxis window (main | command | knowledge | flightdeck). The
      // secondary windows keep their renderer alive for an instant re-open; the brain
      // hides to the tray exactly like the Ctrl+Shift+Space dismiss.
      const names = {
        main: "Praxis",
        command: "Command Center",
        knowledge: "Memory Galaxy",
        flightdeck: "Flight Deck",
      } as const;
      closeWindow(intent.target, names[intent.target]);
      return { reply: say, ripple: true, sleep: false };
    }
    case "window-placement": {
      const reply = await moveWindowToMonitor(intent.target, intent.placement);
      return signal?.aborted ? stoppedExecResult() : { reply, ripple: true, sleep: false };
    }
    case "gesture":
      s.setMode(intent.on ? "gesture" : "orbit");
      return { reply: say, ripple: true, sleep: false };
    case "capture": {
      const made = s.dump(intent.text); // dump() emits its own ripple + files onto the journey
      const reply = made.length
        ? `Filed ${made.length === 1 ? `“${made[0].label}”` : `${made.length} notes`} onto the journey.`
        : "I couldn't file that one — say it another way?";
      // Also teach Hermes's real built-in memory (~/.hermes/memories/USER.md) - a spoken
      // "remember X" is exactly the durable-preference signal that store is for. Fire-and-
      // forget: Hermes being off/slow must never affect the journey-note UX above.
      teachHermes(intent.text, "user");
      return { reply, ripple: false, sleep: false };
    }
    case "status": {
      const working = Object.values(s.agents).filter((a) => a.status === "working");
      const list = working
        .slice(0, 3)
        .map((a) => `${a.name}${a.taskId ? ` on ${nodeLabel(a.taskId) ?? "a task"}` : ""}`)
        .join(", ");
      const agents = `${working.length} agent${working.length === 1 ? "" : "s"} working${list ? `: ${list}` : ""}.`;
      if (!inDesktop()) return result(`${agents} Live usage is available in the Praxis desktop app.`);
      try {
        const rows = await invoke<UsageRow[]>("usage_summary");
        return signal?.aborted ? stoppedExecResult() : result(`${agents} ${usageReply(rows)}`);
      } catch (err) {
        return signal?.aborted ? stoppedExecResult() : result(`${agents} Usage unavailable: ${errorText(err)}`);
      }
    }
    case "refresh-usage": {
      if (!inDesktop()) return result("Usage reload only works in the Praxis desktop app.");
      try {
        await invoke("refresh_live_state");
        if (signal?.aborted) return stoppedExecResult();
        // Notify every Supply hook even if this command's own summary read fails.
        const warning = await broadcastRefresh("praxis://usage-refresh");
        if (signal?.aborted) return stoppedExecResult();
        const rows = await invoke<UsageRow[]>("usage_summary");
        return signal?.aborted ? stoppedExecResult() : result(`Usage reloaded — ${usageReply(rows)}${warning}`);
      } catch (err) {
        return signal?.aborted ? stoppedExecResult() : result(`Usage reload failed: ${errorText(err)}`);
      }
    }
    case "refresh-flightdeck": {
      if (!inDesktop()) return result("Flight Deck refresh only works in the Praxis desktop app.");
      try {
        const started = Date.now();
        await invoke("refresh_live_state");
        // fd_sessions serves the prior cache while the forced rebuild runs.
        // Wait for its generation to advance before claiming a fresh count.
        for (let attempt = 0; attempt < 120; attempt++) {
          if (signal?.aborted) return stoppedExecResult();
          const snapshot = await invoke<{ generatedAt: number; activeCount: number; runningCount: number; error?: string }>("fd_sessions");
          if (signal?.aborted) return stoppedExecResult();
          if (snapshot.error) throw new Error(snapshot.error);
          if (snapshot.generatedAt >= started)
            return result(`Flight Deck refreshed — ${snapshot.activeCount} active, ${snapshot.runningCount} running`);
          await pauseRefresh(signal);
        }
        return result("Flight Deck refresh requested — still waiting for a fresh snapshot.");
      } catch (err) {
        return signal?.aborted ? stoppedExecResult() : result(`Flight Deck refresh failed: ${errorText(err)}`);
      }
    }
    case "refresh-memory": {
      if (!inDesktop()) return result("Memory Galaxy refresh only works in the Praxis desktop app.");
      try {
        await invoke("refresh_memory_graph");
        if (signal?.aborted) return stoppedExecResult();
        const warning = await broadcastRefresh("praxis://memory-refresh");
        if (signal?.aborted) return stoppedExecResult();
        const raw = await invoke<string | null>("read_memory_graph");
        if (signal?.aborted) return stoppedExecResult();
        // This backend command is fire-and-forget/debounced and supplies no
        // completion signal. Counts describe the available graph, not a made-up
        // successful rebuild. The Galaxy listener watches for the new file.
        if (!raw) return result(`Memory Galaxy rebuild requested — no graph available yet${warning}`);
        const graph = JSON.parse(raw) as { nodes?: unknown[]; edges?: unknown[] };
        if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error("invalid memory graph");
        return result(`Memory Galaxy rebuild requested — currently ${graph.nodes.length} nodes, ${graph.edges.length} links${warning}`);
      } catch (err) {
        return signal?.aborted ? stoppedExecResult() : result(`Memory Galaxy refresh failed: ${errorText(err)}`);
      }
    }
    case "fleet-model": {
      const agent = fuzzyChoice(intent.agent, FLEET_AGENTS, (a) => [a.key, a.name]);
      if (!agent) return result(`Unknown or ambiguous agent "${intent.agent}". Choose ${FLEET_AGENTS.map((a) => a.name).join(", ")}.`);
      const model = fuzzyChoice(intent.model, agent.options, (o) => [o.label, o.id]);
      if (!model) return result(`${agent.name}'s valid models: ${agent.options.map((o) => `${o.label} (${o.id || "default"})`).join(", ")}.`);
      if (!setFleetModel(agent.key, model.id)) return result(`Could not set ${agent.name}'s model; the fleet catalog changed.`);
      return result(`${agent.name}'s model set to ${model.label}.`);
    }
    case "tool-breaker": {
      setToolEnabled(intent.key, intent.enabled);
      return result(`${intent.key} breaker ${intent.enabled ? "on — enabled" : "off — disabled"}.`);
    }
    case "run-skill": {
      // Re-invoke a previously captured skill by spoken name. Resolve against the
      // saved skill list (fuzzy: spoken tokens ⊆ a skill's name/goal), then RE-RUN
      // orchestrate(savedGoal) - re-running is simpler than replaying stored steps
      // and self-healing (the brain re-plans against the current repo). All Tauri
      // touches are guarded inside the skills module; a browser/dev env just gets
      // an empty skill list → the honest "no such skill" reply.
      const { loadSkills, resolveSkill } = await import("@/orchestrator/skills");
      if (signal?.aborted) return stoppedExecResult();
      const skills = await loadSkills();
      if (signal?.aborted) return stoppedExecResult();
      const match = resolveSkill(intent.name, skills);
      if (!match) {
        const reply = skills.length
          ? `I don't have a skill called "${intent.name}" yet. Ask me to build something and I'll learn it.`
          : `I haven't learned any skills yet. Finish a build and I'll remember how to redo it.`;
        return { reply, ripple: true, sleep: false };
      }
      // Fire the orchestration (async, self-managing via eventBus + its own capture
      // hook) and confirm immediately - the brain animates progress in the scene.
      void startOwnedOrchestration(ownerToken, signal, async (ownedSignal) => {
        if (ownedSignal.aborted) throw new Error("Owned orchestration stopped before admission.");
        const { orchestrate } = await import("@/orchestrator/orchestrator");
        return orchestrate(match.goal, {
          signal: ownedSignal,
          ownerToken,
          ownerRunRegistered: true,
        });
      }).catch((err) => console.error("[voice] run-skill orchestrate failed:", err));
      return { reply: `Running your "${match.name}" skill.`, ripple: true, sleep: false };
    }
    case "show-board": {
      // Phase C - the demonstration surface. Read the REAL board digest from the
      // same cache the inbox uses, pull it out across the screen, and hand back a
      // spoken walkthrough of its first lines so Praxis narrates WHILE showing it.
      try {
        const raw = localStorage.getItem("praxis.board.v1");
        if (!raw) {
          return {
            reply: "There's no board digest filed yet — the meeting runs at six each morning, or ask me to regenerate it from the command center.",
            ripple: true,
            sleep: false,
          };
        }
        const b = JSON.parse(raw) as { date: string; digestMarkdown: string; generatedAtMs: number };
        const { digestToSections } = await import("@/command/inboxStore");
        if (signal?.aborted) return stoppedExecResult();
        const { usePraxisStore } = await import("@/store/usePraxisStore");
        if (signal?.aborted) return stoppedExecResult();
        const sections = digestToSections(b.digestMarkdown);
        usePraxisStore.getState().setPulloutDoc({
          dot: "#e8509d",
          from: "AGENT BOARD",
          time: b.date,
          title: "Daily board meeting — fleet digest",
          meta: "SYNTHESIZED BY THE BRAIN · STATEMENTS BY EACH AGENT · FILED TO THE VAULT",
          sections,
          kind: "board",
        });
        // narrate: headline lines from the first sections (real content, trimmed for voice)
        const spoken = sections
          .slice(0, 2)
          .flatMap((s) => s.ps.slice(0, 2).map((p) => p.t))
          .join(" ")
          .slice(0, 420);
        return {
          reply: spoken
            ? `Here's the board summary from ${b.date}. ${spoken}`
            : `Here's the board summary from ${b.date} — it's on screen now.`,
          ripple: true,
          sleep: false,
        };
      } catch (err) {
        console.error("[voice] show-board failed:", err);
        return { reply: "I couldn't open the board digest — see the console.", ripple: true, sleep: false };
      }
    }
    case "org-scan": {
      // Atlas's dry-run organization sweep (org_scan.rs) - Desktop top-level files,
      // stale vault handoffs/orphan notes, repo scratch. Fire-and-report: nothing is
      // moved or deleted, so this is safe to confirm immediately and speak the
      // summary once the scan (a few filesystem stats, not a long-running job) resolves.
      const { runOrgScan, summarizeOrgScan } = await import("@/shared/orgScan");
      if (signal?.aborted) return stoppedExecResult();
      const result = await runOrgScan();
      if (signal?.aborted) return stoppedExecResult();
      const reply = result
        ? summarizeOrgScan(result)
        : "I couldn't run the organization scan — see the console.";
      return { reply, ripple: true, sleep: false };
    }
    case "research-scan": {
      // Sage's on-demand RSS + transcript sweep (research_watch.rs) - otherwise only
      // fires on its own daily timer. A live YouTube/transcript fetch can take a few
      // seconds; still fine to await inline (same shape as org-scan above).
      const { runResearchScan, summarizeResearchScan } = await import("@/shared/researchScan");
      if (signal?.aborted) return stoppedExecResult();
      const result = await runResearchScan();
      if (signal?.aborted) return stoppedExecResult();
      const reply = result
        ? summarizeResearchScan(result)
        : "I couldn't run the research scan — see the console.";
      return { reply, ripple: true, sleep: false };
    }
    case "tile-quadrants": {
      // Real action: position all four Praxis windows into the screen quadrants
      // (window_ops::tile_quadrants). This is the fix for "enter quad tile → described
      // not done" - the command existed, it just had no route until now.
      const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
      if (!tauri) return { reply: "Window tiling only works in the Praxis desktop app.", ripple: true, sleep: false };
      try {
        // Tell Rust WHICH window this command fired from, so the formation lands
        // on the monitor the owner is actually at (window_ops.rs resolution order:
        // screen hint → invoker's monitor → focused → main → largest). Degrades
        // gracefully outside Tauri / on API failure: undefined → Rust falls back.
        let invoker: string | undefined;
        try {
          const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          if (signal?.aborted) return stoppedExecResult();
          invoker = getCurrentWebviewWindow().label;
        } catch {
          /* not in the Tauri shell (or API unavailable) - let Rust pick */
        }
        const screen = formationScreenSpec(intent.placement);
        const msg = await invoke<string>("tile_quadrants", { invoker, screen });
        if (signal?.aborted) return stoppedExecResult();
        return { reply: msg || say || "Tiled the four windows into quadrants.", ripple: true, sleep: false };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error("[voice] tile_quadrants failed:", err);
        return { reply: `I couldn't tile the windows: ${m}`, ripple: true, sleep: false };
      }
    }
    case "exit-formation": {
      // Real action: restore the window layout captured before the last tile
      // (window_ops::restore_formation). The counterpart to tile-quadrants so the
      // formation is never a one-way trap.
      const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
      if (!tauri) return { reply: "Window formations only work in the Praxis desktop app.", ripple: true, sleep: false };
      try {
        const msg = await invoke<string>("restore_formation");
        if (signal?.aborted) return stoppedExecResult();
        return { reply: msg || say || "Exited the formation.", ripple: true, sleep: false };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error("[voice] restore_formation failed:", err);
        return { reply: m || "There's no tiled formation to exit.", ripple: true, sleep: false };
      }
    }
    case "trust": {
      // Real action: move the trust dial. setAutonomy persists + mirrors to
      // %LOCALAPPDATA%\Praxis\autonomy.txt, which the Rust side reads to gate actions.
      // TRUST-IV AUTO-HYBRID now lives in the store funnel (setAutonomy) so EVERY
      // trust-set path inherits it - we only append the spoken confirmation here.
      s.setAutonomy(intent.key);
      const reply = intent.key === "full" ? `${say} Switching to Hybrid execution to match.` : say;
      return { reply, ripple: true, sleep: false };
    }
    case "exec-mode": {
      // Real action: move the Command Center's Live/Hybrid/Background dial.
      // setExecMode persists to localStorage AND dispatches 'praxis:exec-mode' so
      // every mounted useExecMode() (RightDock, Command Center) updates live.
      setExecMode(intent.mode);
      return { reply: say, ripple: true, sleep: false };
    }
    case "halt": {
      // Real action: the global HALT breaker. setHalted persists praxis.halted.v1
      // AND emits the Tauri praxis://halt event - orchestrate()'s policy gate and
      // the unattended runner's AbortController both react immediately.
      setHalted(intent.on);
      return {
        reply: intent.on
          ? "Halting everything. Say resume all when you're ready."
          : "Resuming — the breaker is clear.",
        ripple: true,
        sleep: false,
      };
    }
    case "brain-model": {
      // Real action: change the selected BRAIN model (command/brainStore.ts).
      // Resolve the spoken name against the REV 2 catalog; an honest miss beats a
      // silent no-op so the owner knows to rephrase.
      const match = resolveBrainByName(intent.name);
      if (!match) {
        return {
          reply: `I don't have a model called "${intent.name}" - try Sol, Terra, Luna, or OpenAI.`,
          ripple: true,
          sleep: false,
        };
      }
      setSelectedBrain(match);
      return { reply: `Switching the brain to ${match.label}.`, ripple: true, sleep: false };
    }
    case "help":
      return { reply: say, ripple: true, sleep: false };
    case "refuse":
      return { reply: say, ripple: true, sleep: false };
    case "sleep":
      return { reply: say, ripple: true, sleep: true };
    case "ask":
    default: {
      s.setChatOpen(true); // surface the exchange while it's spoken
      // ask() is async - reading chat immediately returns the PREVIOUS orch message
      // (stale ref = the repeat-command bug). ask() already speaks via voiceOn or
      // the speak:true opt, so we return an empty reply and let it handle TTS.
      // Voice callers record the exchange themselves; don't write a "typed" copy.
      const answer = await s.ask(intent.text, { speak: false, signal, transcript: "caller" });
      if (signal?.aborted) return stoppedExecResult();
      return { reply: answer?.text ?? "", ripple: false, sleep: false };
    }
  }
}

/** Emit the core's "Praxis is speaking" ripple, sized to the reply length. */
export function rippleSpeaking(reply: string): void {
  eventBus.emit({
    type: "orchestrator:speaking",
    t: 0,
    duration: Math.min(4.5, Math.max(1.2, reply.length * 0.03)),
  });
}

/**
 * Execute + ripple + SPEAK a command - the entry point for utterances forwarded from a secondary
 * window's mic over the praxis://command bus. There's no local status UI here (the brain may not
 * even be the focused window), so this just does the work and talks.
 */
export async function executeAndSpeak(
  cmd: VoiceCommand,
  signal?: AbortSignal,
  ownerToken?: string,
  options: { speak?: boolean } = {},
): Promise<ExecResult> {
  if (signal?.aborted) return stoppedExecResult();
  if (options.speak !== false) cancelSpeech();
  const res = await executeVoiceCommand(cmd, signal, ownerToken);
  if (signal?.aborted) return stoppedExecResult();
  // the speaking pulse is emitted from speak() on actual audio start (kept in phase with the voice)
  // bring the brain forward for verbs whose result lives in the scene (so a command spoken
  // from the cockpit doesn't silently change a window you can't see). Window-open verbs
  // raise their own target; capture/status/ask/help/sleep stay put.
  if (NAV_KINDS.has(cmd.intent.kind)) openWindow("show_main_cmd", "Praxis");
  if (res.reply && options.speak !== false)
    speak(res.reply, {
      onEnd: () => {
        if (res.sleep) usePraxisStore.getState().setVoiceOn(false);
      },
    });
  else if (res.sleep) usePraxisStore.getState().setVoiceOn(false);
  return res;
}

const NAV_KINDS = new Set(["view", "overview", "area", "transport"]);
