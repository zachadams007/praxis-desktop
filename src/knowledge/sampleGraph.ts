/**
 * sampleGraph.ts - the fallback star-atlas graph, shown only if public/memory-graph.json is
 * absent (so the galaxy is never blank, and the browser preview reads exactly like the design
 * prototype). Real data comes from scripts/build-memory-graph.cjs over the owner's second brain.
 *
 * This ports the design prototype's own buildGraph() data model (CONTENT / DUST / EXTRA_LINKS
 * / DEPS) - the same area taxonomy, artifact types, functional links, and directed
 * dependencies - emitted as a serializable GraphData. Deterministic (seeded).
 */
import { AREAS } from "./atlas";
import { mulberry32 } from "./atlas";
import type { AreaId, ArtifactKind, GraphData, GEdge, GNode } from "./types";

/** content: notes/refs/convos/ideas carry the task they FUNCTIONALLY belong to. */
const CONTENT: Record<
  string,
  {
    tasks: [string, string][];
    notes: [string, string | null][];
    refs: [string, string | null][];
    convos: [string, string | null][];
    ideas: [string, string | null][];
  }
> = {
  praxis: {
    tasks: [["brain", "Neural brain core"], ["agentviz", "Agent visualization"], ["flightdeck", "Flight Deck"], ["orchestrator", "Orchestrator"], ["journey", "Journey mode"], ["gesture", "Gesture nav"], ["realeventbus", "Real event bus"], ["costplan", "Cost plan"], ["runtime", "Phase-3 runtime"]],
    notes: [["Hub.tsx", "brain"], ["ClusterField.tsx", "brain"], ["CameraRig.tsx", "journey"], ["DumpBox.tsx", "orchestrator"], ["runtime.ts", "brain"], ["shaders.ts", "brain"], ["Effects.tsx", "brain"], ["modelTint.ts", "agentviz"], ["schema.ts", "realeventbus"], ["eventBus.ts", "realeventbus"], ["AgentField.tsx", "agentviz"], ["PulseField.tsx", "agentviz"], ["useHandGesture.ts", "gesture"], ["GesturePanel.tsx", "gesture"], ["journeyLayout.ts", "journey"], ["JourneyChrome.tsx", "journey"], ["usePraxisStore.ts", "brain"], ["flightdeck.rs", "flightdeck"], ["transcript_tailer.rs", "realeventbus"], ["session_poller.rs", "realeventbus"], ["useRealEvents.ts", "realeventbus"], ["DeckApp.tsx", "flightdeck"], ["DeckDock.tsx", "flightdeck"], ["model.ts", "flightdeck"], ["lib.rs", "flightdeck"]],
    refs: [["round4-connectome.md", "brain"], ["journey-spec.md", "journey"], ["three-phase-roadmap.md", "runtime"], ["r3-remodel-lock.md", "brain"]],
    convos: [["Polish the Memory Galaxy", "brain"], ["Phase-1 super-app windows", "flightdeck"], ["Force-graph tuning", "brain"], ["Agent dock drill-in", "agentviz"]],
    ideas: [["Praxis Super App", "brain"], ["Second-brain orchestrator", "orchestrator"], ["Ambient autonomy", "runtime"], ["Voice-first OS", "gesture"]],
  },
  catalyzed: {
    tasks: [["feed", "Friends feed reskin"], ["algo", "Algorithm scrollytelling"], ["terminal", "Bloomberg terminal"], ["ops", "Ops surfaces"], ["picks", "Calibrate ranking"], ["alerts", "Market alerts"]],
    notes: [["FriendsFeed.tsx", "feed"], ["aiRelevance.ts", "algo"], ["EngineCore.tsx", "algo"], ["useStoryScroll.ts", "algo"], ["ApiQuotaBoard.tsx", "ops"], ["MyDesk.tsx", "ops"], ["terminalFeed.ts", "terminal"], ["form4_miner.py", "terminal"], ["scoring.ts", "picks"], ["ranking.ts", "algo"], ["socialAlerts.ts", "alerts"], ["fetch_real_data.py", "terminal"], ["movers_miner.py", "alerts"]],
    refs: [["feed-algorithm.md", "algo"], ["scoring-framework.md", "picks"], ["bloomberg-terminal.md", "terminal"], ["weight-calibration.md", "algo"]],
    convos: [["Feed heat-identity cards", "feed"], ["Algorithm reactor core", "algo"], ["Terminal command bar", "terminal"]],
    ideas: [["AI relevance ranking", "algo"], ["In-app terminal", "terminal"]],
  },
  learnai: {
    tasks: [["skills", "Custom skills"], ["workflows", "Operating workflows"], ["agents", "Agent / model stack"], ["subs", "Toolbelt"], ["decisions", "Operating decisions"]],
    notes: [["memprompt", "skills"], ["offload", "skills"], ["overnight", "skills"], ["skill-scout", "skills"], ["design→code", "workflows"], ["offload router", "workflows"], ["memory + intent", "workflows"], ["Flight Deck flow", "workflows"], ["Codex CLI", "agents"], ["sonnet-worker", "agents"], ["Hermes Agent", "agents"], ["subagent fan-out", "agents"], ["Claude Max", "subs"], ["Hume EVI", "subs"], ["Groq", "subs"], ["Cursor", "subs"]],
    refs: [["model-routing.md", "agents"], ["ai-frontend-flow.md", "workflows"]],
    convos: [["Offload routing rules", "workflows"], ["Hermes phase-3 plan", "agents"]],
    ideas: [["Compounding workflows", "workflows"], ["Model routing stack", "agents"]],
  },
  finance: {
    tasks: [["ledger", "Usage ledger"], ["dash", "Spend dashboards"], ["budget", "Budget guardrails"], ["tradingbot", "Strategy research"], ["revenue", "Revenue tracking"]],
    notes: [["apiUsage.ts", "ledger"], ["UsagePanel.tsx", "dash"], ["admin.ts", "dash"], ["operatorSafety.ts", "budget"], ["strategy.py", "tradingbot"], ["backtest.py", "tradingbot"], ["paper_trade.py", "tradingbot"], ["alpaca_client.py", "tradingbot"], ["kill_switch.py", "budget"], [".env", null]],
    refs: [["data-sources.md", "ledger"], ["usage-report.md", "ledger"], ["trading-bot-research.md", "tradingbot"], ["risk-rules.md", "budget"], ["freqai-config.md", null]],
    convos: [["Usage ledger wiring", "ledger"], ["Strategy review", "tradingbot"]],
    ideas: [["Strategy research", "tradingbot"], ["Spend guardrails", "budget"]],
  },
  ventures: {
    tasks: [["freelance", "Client work"], ["monetize", "Release plan"], ["offers", "Service templates"]],
    notes: [["service-deck", "offers"], ["client-list", "freelance"], ["release-tiers", "monetize"]],
    refs: [["service-notes.md", null]],
    convos: [["Scope templates", "offers"], ["Release plan", "monetize"]],
    ideas: [["Service catalogue", "offers"], ["Catalyzed packaging", "monetize"]],
  },
  studio: {
    tasks: [["mpt", "Render pipeline"], ["launch", "Publish schedule"], ["autopost", "Auto-posting"], ["hooks", "Hook A / B loop"]],
    notes: [["webui.bat", "mpt"], ["config.toml", "mpt"], ["catalyzed_generate.py", "mpt"], ["autopost.py", "autopost"], ["hooks_ab.py", "hooks"]],
    refs: [["publish-notes.md", "launch"], ["format-notes.md", "launch"], ["visual-quality-bar.md", "mpt"]],
    convos: [["MPT end-to-end render", "mpt"], ["Publish schedule", "launch"]],
    ideas: [["Shorts engine", "mpt"], ["Hook A/B loop", "hooks"]],
  },
};

const DUST: Record<string, string[]> = {
  praxis: ["scratch · camera easing", "clip · cockpit refs", "log · r3 lock notes", "frag · shader glow", "note · lod budget", "scratch · fog pass", "clip · atlas type", "log · gesture calib", "frag · pulse pool", "note · dock spacing", "scratch · bloom tune", "log · session 06-28", "frag · easing curves", "note · zoom rails", "clip · nebula refs", "scratch · hud copy"],
  catalyzed: ["log · wire retries", "frag · ticker cache", "note · quota math", "scratch · card heat ramp", "clip · terminal refs", "log · form4 backfill", "frag · ranker seeds", "note · desk layout", "scratch · alert copy", "log · session 06-25", "frag · api shims", "note · reveal timing"],
  learnai: ["note · prompt patterns", "log · offload wins", "frag · skill stubs", "scratch · router rules", "clip · agent demos", "note · fan-out costs", "log · session 06-22", "frag · memory hooks", "scratch · intent tags", "note · model quirks"],
  finance: ["log · daily spend 06-30", "frag · vendor caps", "note · alpaca sandbox", "scratch · risk notes", "log · backtest run 41", "frag · pnl snaps", "note · quota drift", "scratch · kill drill", "log · daily spend 06-29", "frag · fee table"],
  ventures: ["note · scope draft", "scratch · handoff copy", "log · review 06-27", "frag · estimate math", "note · checklist", "scratch · format picks"],
  studio: ["clip · hook bank", "log · render queue", "frag · caption styles", "note · post windows", "scratch · thumb text", "log · session 06-26", "frag · voice picks", "note · watch-time", "clip · b-roll pulls"],
};

/** curated second-order links (real functional relationships, incl. cross-area seams). */
const EXTRA_LINKS: [string, string][] = [
  ["eventBus.ts", "schema.ts"], ["runtime.ts", "shaders.ts"], ["AgentField.tsx", "modelTint.ts"],
  ["scoring.ts", "ranking.ts"], ["backtest.py", "strategy.py"], ["kill_switch.py", "operatorSafety.ts"],
  ["config.toml", "webui.bat"], ["offload", "Codex CLI"], ["memprompt", "memory + intent"],
  ["Flight Deck flow", "@task:praxis.flightdeck"], ["apiUsage.ts", "@task:catalyzed.ops"],
  ["catalyzed_generate.py", "@task:catalyzed.feed"], ["Hermes Agent", "@task:praxis.runtime"],
  ["Claude Max", "@task:finance.budget"],
];

/** directed dependencies - from depends on to. */
const DEPS: [string, string][] = [
  ["praxis.realeventbus", "praxis.brain"], ["praxis.runtime", "praxis.realeventbus"], ["praxis.costplan", "praxis.runtime"],
  ["praxis.flightdeck", "praxis.agentviz"], ["praxis.agentviz", "praxis.brain"], ["praxis.journey", "praxis.brain"],
  ["praxis.orchestrator", "praxis.journey"], ["praxis.gesture", "praxis.brain"],
  ["catalyzed.algo", "catalyzed.feed"], ["catalyzed.terminal", "finance.ledger"], ["catalyzed.ops", "finance.dash"],
  ["catalyzed.picks", "catalyzed.algo"], ["catalyzed.alerts", "catalyzed.terminal"],
  ["finance.dash", "finance.ledger"], ["finance.budget", "finance.ledger"], ["finance.tradingbot", "finance.budget"],
  ["finance.revenue", "ventures.monetize"], ["ventures.monetize", "catalyzed.feed"], ["ventures.offers", "ventures.freelance"],
  ["studio.launch", "studio.mpt"], ["studio.autopost", "praxis.orchestrator"], ["studio.hooks", "studio.launch"],
  ["learnai.agents", "praxis.runtime"], ["learnai.workflows", "praxis.flightdeck"], ["learnai.skills", "learnai.workflows"],
  ["learnai.subs", "learnai.agents"], ["studio.mpt", "learnai.workflows"], ["catalyzed.feed", "learnai.workflows"],
];

const LIVE_TASKS: Record<string, number> = {
  "praxis.brain": 0.72,
  "praxis.realeventbus": 0.41,
  "catalyzed.feed": 0.64,
  "finance.ledger": 0.88,
  "studio.mpt": 0.55,
};
const ORPHAN_LABELS = new Set(["freqai-config.md", "service-notes.md", ".env"]);

const DESC: Record<string, string> = {
  "praxis.brain": "The alive central neural core: a contained, breathing connectome hub that fires neurons near active work.",
  "praxis.gesture": "Webcam hand-nav via MediaPipe — a closed fist plus movement flies the camera, with an honest ON/OFF chip.",
  "praxis.journey": "Press J to morph the brain into a NOW-centred roadmap: completed work streams left, active + upcoming right.",
  "praxis.orchestrator": "Zero-spend mock planner: D sprouts dumped ideas onto the corridor, O is a docked chat that reads journey state.",
  "praxis.flightdeck": "Mission-control window: worktree-aware repo→lane→session lanes from real local Claude data, plus a global wake hotkey.",
  "praxis.agentviz": "Agents made legible: each travels the connectome to its cluster trailing a comet and colours by its Claude model.",
  "praxis.realeventbus": "Phase-2 live bridge: a Rust transcript-tailer + session-poller push REAL Claude activity onto the same event contract.",
  "praxis.costplan": "Phase-2 routing model: spread work across Opus / Sonnet / Haiku / local by difficulty and price by runtime.",
  "praxis.runtime": "Phase-3 swap of mocks for real Max-backed Claude agents on the same event contract.",
  "catalyzed.feed": "Full feed reskin: heat-identity cards, self-drawing hero charts, a briefing console, choreographed reveals.",
  "catalyzed.algo": "Apple-style scrollytelling Algorithm tab — converge → reactor engine → divergence portal — with a live Run-it mode.",
  "catalyzed.terminal": "Bloomberg-style in-app terminal: ⌘K command bar, per-ticker workspace, fed by a real multi-source wire.",
  "catalyzed.ops": "Admin console, per-user Desk, and the API usage ledger that meters every market-data call.",
  "catalyzed.picks": "Calibrate the real selection scoring weights to Zach's own taste via a light RLHF-style loop.",
  "catalyzed.alerts": "Detect ultra-significant market moves and push a warning to the phone — a phase-2 item.",
  "finance.ledger": "Every market-data call funnels through checkApiAllowed / recordApiCall, persisting per-vendor daily aggregates.",
  "finance.dash": "Live spend surfaces off the ledger: a shared ApiQuotaBoard plus per-device API spend — the always-on read view.",
  "finance.budget": "Pause kill-switch + per-vendor daily budgets, then a soft per-user refresh cap so a shared build can't overrun.",
  "finance.tradingbot": "Strategy research track: a rules-based strategy that is backtested, then paper-traded behind a kill switch.",
  "finance.revenue": "Tracks money in as well as out, so the ledger covers both sides.",
  "ventures.freelance": "Client projects: scope, delivery and hand-off.",
  "ventures.monetize": "Release planning for the research app.",
  "ventures.offers": "Service descriptions and scope templates.",
  "studio.mpt": "Render pipeline: script, stock footage, text-to-speech voice and caption burn-in, verified at 1080x1920.",
  "studio.launch": "Publish schedule for the short-form channel.",
  "studio.autopost": "Hands-off posting: a render writes a pending clip and an approval gate releases it.",
  "studio.hooks": "Compare opening lines against real watch time, then favour the ones that hold.",
  "learnai.skills": "The custom skills that automate Zach's workflow — click each artifact to recall what it is and how to invoke it.",
  "learnai.workflows": "Reusable operating workflows — design→code, the offload router, auto-memory + intent capture, Flight Deck.",
  "learnai.agents": "The agent / model stack — Codex CLI for grunt, the Sonnet worker, parallel fan-out, Hermes as orchestrator.",
  "learnai.subs": "The toolbelt: model providers, voice and speech services, and the editor.",
  "learnai.decisions": "Where learning turns into decisions: what to adopt, what to drop.",
};

/** Build the fallback GraphData deterministically (ports the DC buildGraph structure). */
function buildSampleGraph(): GraphData {
  const rng = mulberry32(0x51a37);
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const labelId: Record<string, string> = {};
  const taskId: Record<string, boolean> = {};
  const areaIds = new Set(Object.keys(CONTENT));

  const add = (n: GNode) => {
    nodes.push(n);
    labelId[n.label] = n.id;
  };
  const link = (source: string, target: string, kind: GEdge["kind"], cross?: boolean) =>
    edges.push({ source, target, kind, ...(cross != null ? { cross } : {}) });

  // hubs + leaves
  const leafList: Record<string, GNode[]> = {};
  for (const area of AREAS) {
    if (!areaIds.has(area.id)) continue;
    add({ id: "hub." + area.id, label: area.name, kind: "hub", area: area.id, degree: 0 });
    leafList[area.id] = [];
    const c = CONTENT[area.id];

    const place = (id: string, label: string, type: ArtifactKind, minor?: boolean): GNode => {
      const n: GNode = {
        id,
        label,
        kind: type,
        type,
        area: area.id as AreaId,
        degree: 0,
        minor: !!minor,
        orphan: ORPHAN_LABELS.has(label),
        slug: label,
        description: DESC[id] || DESC[label],
      };
      add(n);
      leafList[area.id].push(n);
      return n;
    };

    for (const [k, label] of c.tasks) {
      const id = area.id + "." + k;
      taskId[id] = true;
      const n = place(id, label, "task");
      n.live = LIVE_TASKS[id] != null;
      n.prog = LIVE_TASKS[id] || 0;
      n.description = DESC[id];
      link("hub." + area.id, id, "member");
    }
    const attach = (arr: [string, string | null][], type: ArtifactKind, pfx: string) =>
      arr.forEach(([label, tk], i) => {
        const id = area.id + ":" + pfx + i;
        const n = place(id, label, type);
        link("hub." + area.id, id, "member");
        if (tk && !n.orphan) link(id, area.id + "." + tk, "link");
      });
    attach(c.notes, "note", "n");
    attach(c.refs, "reference", "r");
    attach(c.convos, "conversation", "c");
    attach(c.ideas, "idea", "i");
  }

  // dust captures
  for (const area of AREAS) {
    if (!areaIds.has(area.id)) continue;
    (DUST[area.id] || []).forEach((label, i) => {
      const id = area.id + ":d" + i;
      const r = rng();
      const orphan = r < 0.26;
      add({
        id,
        label,
        kind: "capture",
        type: "capture",
        area: area.id as AreaId,
        degree: 0,
        minor: true,
        orphan,
        slug: label,
      });
      if (!orphan) {
        if (r < 0.44) link(id, "hub." + area.id, "link");
        else {
          const pool = leafList[area.id];
          link(id, pool[(rng() * pool.length) | 0].id, "link");
        }
      }
    });
  }

  // directed dependencies (between tasks)
  for (const [s, d] of DEPS) {
    if (taskId[s] && taskId[d]) link(s, d, "dep", s.split(".")[0] !== d.split(".")[0]);
  }
  // extra functional links (incl. cross-area seams)
  for (const [a, b] of EXTRA_LINKS) {
    const ia = a.indexOf("@task:") === 0 ? a.slice(6) : labelId[a];
    const ib = b.indexOf("@task:") === 0 ? b.slice(6) : labelId[b];
    if (ia && ib) link(ia, ib, "link", ia.split(/[.:]/)[0] !== ib.split(/[.:]/)[0]);
  }

  // degree from real links (link + dep), used for size + orphan read
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.kind === "member") continue;
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (a) a.degree++;
    if (b) b.degree++;
  }

  return { areas: AREAS, nodes, edges };
}

export const SAMPLE_GRAPH: GraphData = buildSampleGraph();
// DEV / empty-state fallback only: used when memory-graph.json is absent,
// and never shown when real data exists.
