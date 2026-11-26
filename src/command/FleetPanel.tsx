/**
 * FleetPanel - the Command Center v2 FLEET panel (center column, resizable half).
 * Ported 1:1 from the approved Claude Design package: eight rows - row 0 is PRAXIS
 * itself (the brain, sapphire-tinted), rows 1-7 the agent fleet - each with LED,
 * name/role, live activity line, model chip (inline assignment dropdown with source
 * badges) and a billing-rail tag. Breakers cascade in for real: an open breaker
 * ruby-cuts its dependents' LED/activity/chip and disables matching dropdown options.
 *
 * Data honesty: activity lines come from the REAL roster (fd_sessions) - a fleet
 * agent with no live work reads "standby", never a fabricated task. The mock POOLS
 * rotation from the design prototype is deliberately NOT ported.
 */

import { useState } from "react";
import { codenameForFamily, type AgentRow } from "@/shared/agents";
import { agentRunSummary, fmtAgo, type ToolKey, type ExecMode, type UsageSource } from "./controlStore";
import type { BrainRailStatus } from "./brainStore";
import { railShortLabel } from "@/orchestrator/brain";
import { C, GLOW, FONT, panelHead, headTick, headLabel, headCaption, railTag } from "./ccTheme";
import {
  FLEET_AGENTS,
  RAIL_TAG,
  RAIL_BREAKER,
  BILLING_LABEL,
  type FleetAgentDef,
  type FleetModelOption,
  type FleetStore,
} from "./fleetStore";
import { BRAIN_OPTIONS, type BrainOption, type BrainStore } from "./brainStore";
import { runOrgScan } from "@/shared/orgScan";
import { runResearchScan } from "@/shared/researchScan";

// ------------------------------------------------------------- derivation ---

export interface FleetRowState {
  key: string;
  name: string;
  role: string;
  isBrain: boolean;
  led: string;
  ledAnim: string;
  ledGlow: string;
  activity: string;
  actColor: string;
  modelLabel: string;
  chipCut: boolean;
  rail: string;
  railTitle: string;
}

export interface FleetDerived {
  rows: FleetRowState[];
  running: number;
  cutCount: number;
}

/** Dependency tools per agent (breakers that hard-cut it regardless of model). */
const AGENT_DEPS: Record<string, ToolKey[]> = {
  forge: ["claude"],
  vega: ["codex"],
  quill: ["cursor"],
  atlas: ["computer-use"],
  sage: [],
  lens: [],
  scribe: [],
};
function cutBy(
  def: FleetAgentDef,
  selected: FleetModelOption | undefined,
  toggles: Record<ToolKey, boolean>,
): string | null {
  for (const dep of AGENT_DEPS[def.key] ?? []) {
    if (toggles[dep] === false) return dep;
  }
  const rb = selected ? RAIL_BREAKER[selected.billing] : undefined;
  if (rb && toggles[rb as ToolKey] === false) return rb;
  return null;
}

/**
 * The provider refusing an agent's rail outright - today, the vendor refusing Claude Code for
 * this account (the `refused` row on the Claude usage source).
 */
function providerRefused(sources: UsageSource[], selected: FleetModelOption | undefined): boolean {
  if (selected?.billing !== "claude-max") return false;
  return !!sources.find((s) => s.key === "claude")?.plan?.some((p) => p.window === "refused");
}

const GREY_LED = "rgba(233,226,211,.2)";
const STANDBY_LED = "rgba(233,226,211,.28)";
/** A run older than this doesn't headline the activity line - see the real-run seam
 *  comment in deriveFleet() below (2026-07-10 CDP QA, CC-FORGE). */
const RUN_SUMMARY_STALE_MS = 24 * 60 * 60 * 1000;

export function deriveFleet(args: {
  roster: AgentRow[];
  mode: ExecMode;
  halted: boolean;
  toggles: Record<ToolKey, boolean>;
  selections: Record<string, string>;
  brain: BrainOption;
  engineDegraded: boolean;
  voiceLabel: string | null;
  /** Usage sources (controlStore's useUsage()) - the real delegation-call counts
   *  behind the per-agent run-summary seam appended to Forge/Vega/Quill's activity
   *  line below. Only those three have a `tool` a run count can attach to
   *  (AGENT_NAME_FOR_TOOL in controlStore.ts); everyone else renders nothing. */
  sources: UsageSource[];
  /** Which rail answered the last brain call (useBrainRail). */
  brainRail?: BrainRailStatus | null;
}): FleetDerived {
  const { roster, mode, halted, toggles, selections, brain, engineDegraded, voiceLabel, sources, brainRail } = args;
  let cutCount = 0;

  // Live-agent count = the ONE shared rule every window uses: roster rows in the
  // "working" state, excluding infra (hermes/relay/ledger). Derived straight from
  // useAgentRoster()/fd_sessions so the CC's "N/8" agrees with the brain, galaxy and
  // Flight Deck instead of each window counting its own way (2026-07-10 Codex live
  // QA #1, one-truth). Deliberately NOT the per-row LED heuristics below - those
  // still light the brain/Atlas as "on" for the operator, but they don't define the
  // honest count of agents actually doing delegated work.
  const INFRA_IDS = new Set(["a.hermes", "a.relay", "a.ledger"]);
  const running = halted ? 0 : roster.filter((r) => r.status === "working" && !INFRA_IDS.has(r.id)).length;

  // Real run count + last-run age per codename ("Forge"/"Vega"/"Quill") - never
  // fabricated: agentRunSummary() only returns agents that have actually run.
  const runSummaryByAgent = new Map(agentRunSummary(sources).map((s) => [s.agent, s]));

  // Live work per codename from the real roster.
  const liveFor: Record<string, AgentRow[]> = {};
  for (const r of roster) {
    if (!r.live || r.status !== "working") continue;
    const code = codenameForFamily(r.family);
    if (!code) continue;
    (liveFor[code] ??= []).push(r);
  }

  // ── Brain row ──
  const brainRailBrk =
    brain.provider === "claude-max"
      ? "claude"
      : brain.provider === "openai-codex"
        ? "codex"
        : brain.provider === "openrouter"
          ? "openrouter"
          : null;
  const brainCut = brainRailBrk ? toggles[brainRailBrk as ToolKey] === false : false;
  let brainRow: FleetRowState;
  if (halted) {
    brainRow = row("praxis", "PRAXIS", "the brain", true, GREY_LED, "none", "none", "— halted —", C.faint);
  } else if (brainCut) {
    cutCount++;
    brainRow = row(
      "praxis",
      "PRAXIS",
      "the brain",
      true,
      C.ruby,
      "pxBlink 1.2s ease-in-out infinite",
      GLOW.ruby,
      `tool cut — ${brainRailBrk} breaker open`,
      "rgba(224,67,85,.85)",
    );
  } else {
    const act = engineDegraded
      ? "queueing — hermes degraded"
      : mode === "hybrid"
        ? `voice · ${(voiceLabel ?? "listening").toLowerCase()}`
        : mode === "live"
          ? "narrating the atlas run"
          : "planning · dispatch loop";
    brainRow = row("praxis", "PRAXIS", "the brain", true, C.sapphire, "pxPulse 2.8s ease-in-out infinite", GLOW.sapphire, act, C.dim);
    // The pick is not always what runs: say which rail is actually thinking, and why.
    const used = brainRail?.used;
    const fellBack = !!used && (used.provider !== brain.provider || (used.model || "") !== (brain.model || ""));
    const claudeRefused = brain.provider === "claude-max" && sources.find((s) => s.key === "claude")?.plan?.some((p) => p.window === "refused");
    if (fellBack || claudeRefused) {
      const onRail = fellBack && used ? railShortLabel(used) : "GPT-6 Astra · Codex";
      const why = claudeRefused ? "Anthropic refused Claude Code" : (brainRail?.skipped[0]?.split(": ").slice(1).join(": ") || "chosen rail unavailable");
      brainRow.activity = `thinking on ${onRail} — ${why}`;
      brainRow.actColor = "rgba(233,180,120,.85)";
    }
  }
  brainRow.modelLabel = brain.label;
  brainRow.chipCut = brainCut;
  brainRow.rail =
    brain.provider === "openai-api"
      ? "OAI"
      : brain.provider === "claude-max"
      ? "PRO"
      : brain.provider === "openai-codex"
        ? "CODEX"
        : brain.provider === "nvidia"
          ? "NVIDIA"
          : "OR";
  brainRow.railTitle = `billed via ${brain.account}`;

  // ── The seven hands ──
  const hands = FLEET_AGENTS.map((def) => {
    const selectedId = selections[def.key] ?? def.options[0]?.id ?? "";
    const selected = def.options.find((o) => o.id === selectedId) ?? def.options[0];
    const cut = cutBy(def, selected, toggles);

    let r: FleetRowState;
    if (halted) {
      r = row(def.key, def.name.toUpperCase(), def.role, false, GREY_LED, "none", "none", "— halted —", C.faint);
    } else if (cut) {
      cutCount++;
      r = row(
        def.key,
        def.name.toUpperCase(),
        def.role,
        false,
        C.ruby,
        "pxBlink 1.2s ease-in-out infinite",
        GLOW.ruby,
        `tool cut — ${cut} breaker open`,
        "rgba(224,67,85,.85)",
      );
    } else if (def.key !== "atlas" && providerRefused(sources, selected)) {
      r = row(
        def.key,
        def.name.toUpperCase(),
        def.role,
        false,
        C.amber,
        "pxBlink 2.4s ease-in-out infinite",
        "none",
        def.key === "forge"
          ? "blocked — Anthropic refused Claude Code · missions reroute"
          : "Claude refused by Anthropic — answers on a fallback rail",
        "rgba(233,180,120,.85)",
      );
    } else if (def.key === "atlas") {
      if (mode === "live") {
        r = row(def.key, "ATLAS", def.role, false, C.emerald, "pxPulse 2.6s ease-in-out infinite", GLOW.emerald, "driving — visible operator seat", C.dim);
      } else if (mode === "hybrid") {
        r = row(def.key, "ATLAS", def.role, false, C.emerald, "pxPulse 3.4s ease-in-out infinite", GLOW.emerald, "on call — voice dispatch", C.dim);
      } else {
        r = row(def.key, "ATLAS", def.role, false, STANDBY_LED, "none", "none", "standby — no live session", C.faint);
      }
    } else {
      const live = liveFor[def.key] ?? [];
      if (live.length > 0) {
        const top = live[0];
        const label = top.task ?? top.thought ?? "working";
        const act = live.length > 1 ? `${live.length} lanes · ${label}` : label;
        r = row(def.key, def.name.toUpperCase(), def.role, false, C.emerald, "pxPulse 2.6s ease-in-out infinite", GLOW.emerald, act, C.dim);
      } else {
        r = row(def.key, def.name.toUpperCase(), def.role, false, STANDBY_LED, "none", "none", "standby", C.faint);
      }
    }

    // Real-run seam: append "· N runs · Nm ago" to the existing activity line, same
    // style, when this agent has actually run this session - rendered nowhere when
    // there's no data (agentRunSummary already excludes zero-run agents), and skipped
    // while halted/cut so it doesn't clutter those states. Also skipped once the last
    // run is stale (>24h): a run from days ago tacked onto an otherwise-idle "standby"
    // line reads as current activity it isn't - leave the honest "standby" alone
    // instead (2026-07-10 CDP QA, CC-FORGE).
    const runSummary = !halted && !cut ? runSummaryByAgent.get(def.name) : undefined;
    if (runSummary && Date.now() - runSummary.lastRunMs < RUN_SUMMARY_STALE_MS) {
      r.activity = `${r.activity} · ${runSummary.runs} run${runSummary.runs === 1 ? "" : "s"} · ${fmtAgo(runSummary.lastRunMs)}`;
    }

    r.modelLabel = selected?.label ?? "—";
    r.chipCut = !!cut;
    r.rail = selected ? RAIL_TAG[selected.billing] : "—";
    r.railTitle = selected ? `billed via ${BILLING_LABEL[selected.billing]}` : "";
    return r;
  });

  return { rows: [brainRow, ...hands], running, cutCount };
}

function row(
  key: string,
  name: string,
  role: string,
  isBrain: boolean,
  led: string,
  ledAnim: string,
  ledGlow: string,
  activity: string,
  actColor: string,
): FleetRowState {
  return {
    key,
    name,
    role,
    isBrain,
    led,
    ledAnim,
    ledGlow,
    activity,
    actColor,
    modelLabel: "",
    chipCut: false,
    rail: "",
    railTitle: "",
  };
}

// ----------------------------------------------------------------- panel ---

/** Per-agent quick actions surfaced in the assignment dropdown footer - the design's
 *  brain-row "foot" slot, reused so Atlas's org sweep and Sage's research check stay
 *  reachable after the old launcher cards retired. */
function AgentAction({ label, run }: { label: string; run: () => Promise<string> }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  return (
    <button
      type="button"
      className="px-hover-inset"
      disabled={state === "running"}
      onClick={() => {
        setState("running");
        run()
          .then((n) => {
            setNote(n);
            setState("done");
          })
          .catch(() => setState("error"));
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 8px",
        background: "transparent",
        border: "none",
        color: state === "error" ? C.pink : "rgba(233,226,211,.55)",
        fontFamily: FONT.serif,
        fontStyle: "italic",
        fontSize: 11,
        cursor: state === "running" ? "default" : "pointer",
      }}
    >
      {state === "running" ? "running…" : state === "done" ? note : state === "error" ? "failed — desktop app only" : label}
    </button>
  );
}

export function FleetPanel({
  derived,
  fleet,
  brainStore,
  toggles,
  fleetBasis,
  voiceCreditLeft,
}: {
  derived: FleetDerived;
  fleet: FleetStore;
  brainStore: BrainStore;
  toggles: Record<ToolKey, boolean>;
  fleetBasis: number;
  voiceCreditLeft: number | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const isOptionDisabled = (billing: FleetModelOption["billing"]): boolean => {
    const rb = RAIL_BREAKER[billing];
    return !!rb && toggles[rb as ToolKey] === false;
  };

  const optionRow = (
    key: string,
    o: { label: string; note: string; railTagText: string; disabled: boolean; selected: boolean },
    onPick: () => void,
  ) => (
    <button
      key={key}
      type="button"
      className="px-hover-inset"
      onClick={() => {
        if (!o.disabled) onPick();
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "14px minmax(0,1fr) auto",
        gap: 9,
        alignItems: "baseline",
        width: "100%",
        textAlign: "left",
        padding: "7px 8px",
        background: "transparent",
        border: "none",
        color: "inherit",
        fontFamily: "inherit",
        cursor: o.disabled ? "default" : "pointer",
      }}
    >
      <span style={{ color: o.selected ? C.sapphireLt : C.faint, fontSize: 9 }}>{o.selected ? "●" : "○"}</span>
      <span>
        <span style={{ fontSize: 11.5, color: o.disabled ? "rgba(224,67,85,.75)" : o.selected ? C.ink : "rgba(233,226,211,.68)" }}>
          {o.label}
        </span>
        <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10.5, color: "rgba(233,226,211,.38)", marginLeft: 8 }}>
          {o.disabled ? "breaker open" : o.note}
        </span>
      </span>
      <span style={railTag(o.disabled ? "rgba(224,67,85,.6)" : C.faint)}>{o.railTagText}</span>
    </button>
  );

  return (
    <div style={{ flex: `0 0 ${fleetBasis}%`, minHeight: 140, background: C.panel, display: "flex", flexDirection: "column" }}>
      <div style={panelHead}>
        <span style={headTick("rgba(43,226,143,.85)")} />
        <span style={headLabel}>FLEET</span>
        <span style={{ flex: 1 }} />
        <span style={headCaption}>
          {derived.rows[0]?.activity === "— halted —" ? "all hands halted" : `${derived.running} of 8 live · tap a model to reassign`}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {derived.rows.map((r) => {
          const isBrain = r.isBrain;
          const def = isBrain ? null : FLEET_AGENTS.find((a) => a.key === r.key);
          const isExpanded = expanded === r.key;
          // Honest wire-status marker (2026-07-10): "preference-only" agents' picks
          // persist but never reach an executor (no live driver yet - fleetStore.ts's
          // `wire` field). But an agent marked "live" can STILL have a preference-
          // only pick - e.g. Lens is live for OpenRouter/NVIDIA only, so its default
          // (GPT-5.6 Terra, chatgpt) is preference-only even though the agent overall
          // is "live". Compute honesty from the ACTUAL selected option's billing vs
          // this agent's nativeBilling - the same check executableModelFor() makes -
          // so the "pref" tag is never wrong for whichever option happens to be
          // picked right now (never silently decorative, never silently broken; see
          // fleetStore.ts's header rule).
          const selectedId = def ? (fleet.selections[def.key] ?? def.options[0]?.id ?? "") : "";
          const selectedOpt = def?.options.find((o) => o.id === selectedId) ?? def?.options[0];
          const prefOnly = !isBrain && !!def && (def.wire === "preference-only" || (!!selectedOpt && !def.nativeBilling.includes(selectedOpt.billing)));
          const chipTitle = isBrain
            ? "assign the brain's model — plan/verify calls; a per-step model in the brain's own plan can still override this"
            : prefOnly
              ? `assign model + billing — PREFERENCE ONLY for this pick: ${def?.name} has no live executor for ${selectedOpt?.label ?? "this model"} yet, saved but not run`
              : "assign model + billing — applies to this agent's NEXT run (a session already in flight keeps its model); the brain's per-step plan can still override it";
          return (
            <div key={r.key} style={{ borderBottom: "1px solid rgba(233,220,196,.05)", background: isBrain ? "rgba(73,160,244,.04)" : "transparent" }}>
              <div style={{ display: "grid", gridTemplateColumns: "16px 150px minmax(0,1fr) auto 60px", gap: 10, alignItems: "center", padding: "10px 14px" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: r.led, animation: r.ledAnim, boxShadow: r.ledGlow }} />
                <span>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: ".12em", color: isBrain ? C.sapphireLt : C.ink }}>
                    {r.name}
                  </span>
                  <span style={{ display: "block", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10.5, color: "rgba(233,226,211,.36)", marginTop: 1 }}>
                    {r.role}
                  </span>
                </span>
                <span style={{ fontSize: 11.5, color: r.actColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.activity}</span>
                <button
                  type="button"
                  className="px-hover-chip"
                  title={chipTitle}
                  onClick={() => setExpanded((p) => (p === r.key ? null : r.key))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 9px",
                    border: prefOnly ? "1px dashed rgba(233,220,196,.22)" : "1px solid rgba(233,220,196,.14)",
                    background: C.inset,
                    color: r.chipCut ? "rgba(224,67,85,.85)" : C.ink,
                    fontFamily: "inherit",
                    fontSize: 10.5,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ whiteSpace: "nowrap" }}>{r.modelLabel}</span>
                  {prefOnly && (
                    <span style={{ fontSize: 8, letterSpacing: ".08em", color: "rgba(233,226,211,.4)" }} title="preference only — no live executor yet">
                      pref
                    </span>
                  )}
                  <span style={{ fontSize: 8, color: "rgba(233,226,211,.4)" }}>▾</span>
                </button>
                <span title={r.railTitle} style={{ justifySelf: "end", ...railTag() }}>
                  {r.rail}
                </span>
              </div>

              {isExpanded && (
                <div style={{ background: C.inset, borderTop: "1px solid rgba(233,220,196,.05)", padding: "4px 14px 10px 40px" }}>
                  <div style={{ fontSize: 8.5, letterSpacing: ".2em", color: "rgba(233,226,211,.35)", padding: "8px 0 4px" }}>
                    ASSIGN {r.name} — billed where it runs
                  </div>
                  <div style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10, color: "rgba(233,226,211,.3)", padding: "0 0 6px" }}>
                    applies to the next run — a session already in flight keeps the model it started with
                  </div>
                  {isBrain
                    ? BRAIN_OPTIONS.map((o) => {
                        const rb = o.provider === "claude-max" ? "claude" : o.provider === "openai-codex" ? "codex" : o.provider === "openrouter" ? "openrouter" : null;
                        const disabled = !!rb && toggles[rb as ToolKey] === false;
                        const selected = brainStore.brain.provider === o.provider && brainStore.brain.model === o.model;
                        const tag = o.provider === "openai-api" ? "OAI" : o.provider === "claude-max" ? "PRO" : o.provider === "openai-codex" ? "CODEX" : o.provider === "nvidia" ? "NVIDIA" : "OR";
                        return optionRow(`${o.provider}-${o.model}`, { label: o.label, note: o.account, railTagText: tag, disabled, selected }, () => {
                          brainStore.setBrain(o);
                          setExpanded(null);
                        });
                      })
                    : def?.options.map((o) => {
                        const disabled = isOptionDisabled(o.billing);
                        const selected = (fleet.selections[def.key] ?? def.options[0]?.id) === o.id;
                        return optionRow(`${def.key}-${o.id}`, { label: o.label, note: o.note, railTagText: RAIL_TAG[o.billing], disabled, selected }, () => {
                          fleet.setModel(def.key, o.id);
                          setExpanded(null);
                        });
                      })}
                  {isBrain && (
                    // The in-app explainer for how Praxis picks its brain and spreads the work
                    // (brain.ts brainOrder · orchestrator.ts balanceBrain / rebalanceSteps).
                    <div style={{ padding: "8px 8px 0", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10.5, lineHeight: 1.5, color: "rgba(233,226,211,.42)" }}>
                      thinks on your pick first, then the other subscription, then the paid API only as a backup, then free NVIDIA —
                      and spreads the work so no plan runs dry: Codex and Cursor execute, each step goes to the rail with the most
                      headroom, and Claude is kept for thinking
                    </div>
                  )}
                  {isBrain && voiceCreditLeft != null && (
                    <div style={{ padding: "7px 8px 0", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 11, color: "rgba(233,226,211,.4)" }}>
                      shared OpenAI API wallet · $${voiceCreditLeft.toFixed(2)} before Realtime lockout
                    </div>
                  )}
                  {def && (
                    <div style={{ padding: "4px 0 0", borderTop: "1px solid rgba(233,220,196,.05)", marginTop: 6 }}>
                      {def.key === "atlas" && (
                        <AgentAction
                          label="run organization sweep now — dry run, nothing moved"
                          run={async () => {
                            const res = await runOrgScan();
                            if (!res) throw new Error("unavailable");
                            const n = res.counts.archive_candidate + res.counts.trash_candidate;
                            return n === 0 ? "swept — nothing worth flagging" : `swept — ${n} candidates proposed, report filed`;
                          }}
                        />
                      )}
                      {def.key === "sage" && (
                        <AgentAction
                          label="check watched sources now — instead of the daily timer"
                          run={async () => {
                            const res = await runResearchScan();
                            if (!res) throw new Error("unavailable");
                            if (res.skipped) return "already checked moments ago";
                            const n = res.newVideos ?? 0;
                            return n === 0 ? "nothing new this check" : `${n} new — digests queued`;
                          }}
                        />
                      )}
                      <div style={{ padding: "5px 8px 0", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10, color: "rgba(233,226,211,.28)" }}>
                        {def.hint}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
