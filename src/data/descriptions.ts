/**
 * Detail-card copy - concise, grounded descriptions for every graph node, shown
 * in the RightDock when an entity is selected (name + DESCRIPTION + info + links).
 *
 * Mined from the owner's intent ledger + master roadmap (one pass per initiative,
 * 2026-06-16) so the card says what the work ACTUALLY is in his own framing,
 * not a generic label echo. Keep blurbs ≤ ~1 sentence and present-tense.
 *
 *   NODE_DESCRIPTIONS - keyed by node id: "hub", area ids, task (milestone) ids.
 *   ARTIFACT_NOTES - keyed by tier-3 artifact LABEL (file/doc/memory name), so
 *                       the same file reused under several tasks shares one note.
 *
 * When the journey/area model changes, refresh via the `praxis-node-descriptions`
 * workflow rather than hand-editing piecemeal.
 */

import type { BrainNode } from "./graph";

/** Areas, tasks, and the hub - keyed by node id. */
export const NODE_DESCRIPTIONS: Record<string, string> = {
  // ---- the core ----
  hub: "The orchestrator core — ingests Zach's brain-dumps and routes work to parallel Claude agents; the bright heart every initiative branches from.",

  // ---- Praxis ----
  praxis:
    "Zach's Praxis: a living 3D neural-brain that organizes his brain-dumps and routes work to parallel Claude agents — built front-end-first, no spend.",
  "t.praxis.brain":
    "The alive central neural-NET core: a contained, breathing connectome hub that fires neurons near active work — never a literal human brain.",
  "t.praxis.gesture":
    "Webcam hand-nav via MediaPipe: a closed fist plus movement flies the same camera rig, with an honest ON/OFF chip and live landmark overlay.",
  "t.praxis.journey":
    "Press J to morph the brain into a NOW-centred roadmap: the core is NOW, completed work streams left, active + upcoming work streams right, with artifacts and dependencies on demand.",
  "t.praxis.orchestrator":
    "The orchestrator: D sprouts dumped ideas onto the corridor, O is a docked chat that reads journey state, says what's next, and flies there. It runs on the real brain_chat seam and the native FlowRunner — no longer the zero-spend mock planner this line used to describe.",
  "t.praxis.flightdeck":
    "Mission-control cockpit window: worktree-aware repo→lane→session lanes from real local Claude data, a per-prompt vault (model + effort), and a global wake hotkey.",
  "t.praxis.agentviz":
    "Agents made legible: each travels the connectome to its cluster trailing a comet, hands work off to the next, and colours by its Claude model (Opus/Sonnet/Haiku/Fable) so who's-doing-what reads at a glance.",
  "t.praxis.realeventbus":
    "Phase-2 live bridge: a Rust transcript-tailer + session-poller push REAL Claude-session activity onto the same event contract the mock used, so the brain lights up to actual work.",
  "t.praxis.costplan":
    "Phase-2 routing model: spread work across Opus/Sonnet/Haiku/local/Python by difficulty and price the cost of a task by how long it runs.",
  "t.praxis.runtime":
    "Real subscription-backed Claude/Codex/Cursor agents on the shared event contract — the platform the second brain and posting pipeline sit on. The mock swap this line described is done.",

  // ---- Catalyzed Alpha ----
  catalyzed:
    "Catalyzed Alpha — the consumer stock-signal app: a social feed, AI relevance ranking, and a Bloomberg-style terminal, built premium and shipped on desktop + phone.",
  "t.catalyzed.feed":
    "Full feed reskin: heat-identity cards, self-drawing hero charts, a briefing console, and choreographed reveals across Today/Weekly/For You.",
  "t.catalyzed.algo":
    "Apple-style scrollytelling Algorithm tab — converge → reactor engine → divergence portal — showing the real Discovery→scoring→ranking pipeline, with a live Run-it mode.",
  "t.catalyzed.ops":
    "Admin console (email-gated, pause/budget controls, who's-online) plus a per-user Desk and the API usage ledger that meters every market-data call.",
  "t.catalyzed.terminal":
    "Bloomberg-style in-app terminal: ⌘K command bar, per-ticker workspace, compare and linked spreads, fed by a real multi-source wire (SEC/Alpaca/FMP/Congress).",
  "t.catalyzed.picks":
    "Calibrate the real selection scoring weights from accept/reject signals — staying a pure, explainable function.",
  "t.catalyzed.alerts":
    "Detect ultra-significant market moves (e.g. Nasdaq −4% in 2h) and push a warning to the phone — a phase-2 item after the desktop app is perfect.",

  // ---- Finance ----
  finance:
    "The money/ops front: track every API call's spend, surface it on dashboards, and cap it with guardrails before revenue eventually flows in.",
  "t.finance.ledger":
    "Every market-data call funnels through checkApiAllowed/recordApiCall, persisting events + per-vendor daily aggregates with full/elevated/degraded/paused states.",
  "t.finance.dash":
    "Live spend surfaces off the ledger: a shared ApiQuotaBoard on Research + Admin, plus per-device API spend on Your Desk; the always-on read view.",
  "t.finance.budget":
    "Pause kill-switch + per-vendor daily budgets, then a soft per-user refresh cap (~3 runs/day, admin bypass) so a shared build can't overrun the quota.",
  "t.finance.tradingbot":
    "Strategy research track: a rules-based strategy that is backtested, then paper-traded behind a kill switch.",
  "t.finance.revenue":
    "Tracks money in as well as out, so the ledger covers both sides.",

  ventures:
    "Client work and release planning.",
  "t.ventures.freelance":
    "Client projects: scope, delivery and hand-off.",
  "t.ventures.monetize":
    "Release planning for the research app.",
  "t.ventures.offers":
    "Service descriptions and scope templates.",

  // ---- Studio ----
  studio:
    "Short-form video pipeline that records build footage.",
  "t.studio.mpt":
    "Render pipeline: script, stock footage, text-to-speech voice and caption burn-in, verified at 1080x1920.",
  "t.studio.launch":
    "Publish schedule for the short-form channel.",
  "t.studio.autopost":
    "Hands-off posting: a render writes a pending clip and an approval gate releases it.",
  "t.studio.hooks":
    "Compare opening lines against real watch time, then favour the ones that hold.",

  learnai:
    "The agent toolchain: skills, model routing, and the workflows that connect them.",
  "t.learnai.skills":
    "The custom skills that automate the workflow — click each artifact to recall what it is and how to invoke it.",
  "t.learnai.workflows":
    "Reusable operating workflows — design→code, the offload router, auto-memory + intent capture, the Flight Deck multi-lane flow.",
  "t.learnai.agents":
    "The agent/model stack — Codex CLI for grunt, the Sonnet worker, parallel subagent fan-out, and Hermes as the Phase-3 orchestrator runtime.",
  "t.learnai.subs":
    "The toolbelt: model providers, voice and speech services, and the editor.",
  "t.learnai.decisions":
    "Where learning turns into decisions: what to adopt, what to drop.",
};

/** Tier-3 artifacts (files / docs / memory topics) - keyed by their LABEL. */
export const ARTIFACT_NOTES: Record<string, string> = {
  // ---- Praxis ----
  "Hub.tsx": "the CORE — plexus points/lines, dendrite spray, glowing heart; the contained Praxis neural net",
  "ClusterField.tsx": "tier-1 area medallions (ring mesh + glyph sprite) radiating around the core",
  "round4-connectome.md": "build contract for the volumetric-but-constrained connectome remodel (move through, no orbit)",
  "useHandGesture.ts": "MediaPipe hand-tracking hook; fist+move flies the camera, degrades honestly to a status chip",
  "GesturePanel.tsx": "the gesture ON/OFF chip + live webcam landmark-skeleton overlay",
  "CameraRig.tsx": "drei CameraControls with rotation pinned; drag-pan + dolly on a rail, GSAP fly-to (no teleport)",
  "journeyLayout.ts": "computes each node's left→root→right journey-mode position from status/order",
  "JourneyChrome.tsx": "the NOW ring + time ticks drawn in journey/corridor mode",
  "journey-spec.md": "locked spec: Journey as a morph-mode of the brain canvas + the Orchestrator",
  "parse.ts": "Faculty A: deterministic local dump parser — text to milestone drafts, zero LLM spend",
  "respond.ts": "Faculty B: canned planner that reads journey state to answer 'next up' and point a fly-to",
  "DumpBox.tsx": "the D brain-dump input that sprouts a real node live on the corridor",
  "usePraxisStore.ts": "Zustand UI state: selection, focus, theme, nav mode, agents, tasks, direction toggle",
  "three-phase-roadmap.md": "Phase 1 filmable front end, Phase 2 cost plan, Phase 3 full Praxis build",
  "flight-deck": "the mission-control window organizing parallel Claude sessions into lanes from real local data",
  "runtime.ts": "typed-array engine: node glow, pooled pulses, agent bodies, distance-based LOD",
  "flightdeck.rs": "Rust data layer reading real Claude session/process/transcript state — never mock",
  "eventBus.ts": "the event bus the brain subscribes to and maps to animation — fed by the real Tauri bridge in the app, and by the scripted timeline only in a browser preview",
  "DeckApp.tsx": "the Flight Deck v3 window — mirrored live delegation flow: Praxis → agents · real sessions · worktree lanes → auto-discovered repos, with real spawn/stop + HALT",
  "DeckDock.tsx": "the deck's slide-out inspector dock — ✉ message + ▣ prompt vault tabs; the global pv_* vault, each prompt carrying a model + effort, outcomes written back on fire",
  "model.ts": "maps the real backend contract (fd_sessions + worktree topology) onto the deck view model — deviations from the design package greppable in DECK_DEVIATIONS",
  "AgentField.tsx": "renders agent bodies: routed travel to their cluster, comet trails, agent→agent handoff packets, idle docking, per-model tint",
  "PulseField.tsx": "travelling neuron pulses + flow beads riding the routed edges — the brain's signal traffic between core, clusters and tasks",
  "modelTint.ts": "maps a Claude model id → signature hue (Opus violet / Sonnet gold / Haiku mint / Fable rose) so agents read by model",
  "useRealEvents.ts": "subscribes to the Rust live bridge + polls fd_sessions, mapping real Claude-session deltas to the same PraxisEvent shapes",
  "transcript_tailer.rs": "Rust background thread byte-tailing live Claude session transcripts → praxis://transcript-event (~500ms)",
  "session_poller.rs": "Rust background thread diffing the running session set → praxis://session-state (~2s graceful fallback)",
  "schema.ts": "the flat JSON PraxisEvent contract every animation maps from — identical for the mock stream and the real bridge",

  // ---- Catalyzed Alpha ----
  "FriendsFeed.tsx": "social For-You feed surface — personalized, AI-ranked signal cards",
  "aiRelevance.ts": "pure producer turning the research agent's ResearchIntel into a ticker→0–100 relevance map",
  "feed-algorithm.md": "spec for the feed ranking / personalize() logic",
  "EngineCore.tsx": "the catalyst-spark reactor-core visual at the heart of the Algorithm scrollytelling",
  "useStoryScroll.ts": "lenis + ScrollTrigger scroll infra driving the pinned Algorithm-tab scenes",
  "scoring-framework.md": "doc of the 9-weight scoring (blend − risk + confidence) model",
  "ApiQuotaBoard.tsx": "shared usage dashboard showing per-vendor API spend vs free-tier budgets",
  "MyDesk.tsx": "per-user Desk — profile editor, activity, library/friends stats, device API spend",
  "ops-surfaces": "the three ops surfaces: usage ledger, Admin console, per-user Desk",
  "terminalFeed.ts": "aggregator loading the terminal wire from pluggable sources, deduped and severity-ranked",
  "form4_miner.py": "scheduled Python miner crawling SEC Form 4 insider filings into terminal events",
  "bloomberg-terminal.md": "build spec/direction for the in-app Bloomberg-style terminal",
  "scoring.ts": "the real stock-selection scoring engine — pure, testable weight math",
  "ranking.ts": "feed ranking that orders scored signals into Today/Weekly/For You",
  "weight-calibration.md": "plan to calibrate selection weights",
  "socialAlerts.ts": "phone push for ultra-significant market events (phase-2 alerts)",
  "limiter-plan.md": "plan for the per-user refresh limiter + global vendor budget at a hosted proxy",
  "market-signals": "the market-data domain: SEC/Alpaca/FMP/Finnhub feeds behind the engine",

  // ---- Finance ----
  "apiUsage.ts": "the usage ledger: gates calls, records events + per-day per-vendor spend to localStorage",
  "UsagePanel.tsx": "per-device activity/spend panel shown on Your Desk",
  "admin.ts": "isAdminEmail() gate — only VITE_ADMIN_EMAILS unlock the operator console",
  "data-sources.md": "doc cataloguing the data vendors + their free-tier limits the ledger enforces",
  "operatorSafety.ts": "planned agent-runtime kill-switch + spend guard so an autonomous run can't burn budget",
  "refresh-limiter": "soft per-user daily run cap hooked into runResearchNow, admin bypass",
  "usage-report.md": "usage notes",
  "roadmap.md": "where Finance sits in the master roadmap: ledger done, dashboards ongoing, guardrails next",
  "free-data-policy": "rule: exhaust free tiers first, only propose paid APIs with sign-off",

  // ---- Trading Bot ----
  "trading-bot-research.md": "the original reference doc: best 2026 approach to an autonomous bot, staged plan",
  "autonomous-bot": "the roadmap idea: a bot that researches strategies, and adapts",
  "strategy.py": "the DGCM strategy: catalyst durability gate + momentum entries, long and inverse-ETF",
  "backtest.py": "event-driven backtester with ablations and PIT integrity; gates the go/no-go bet",
  "freqai-config.md": "v0 crypto path: Freqtrade + FreqAI config — set aside once equities was chosen",
  "ccxt-freqtrade": "the crypto/CCXT+Freqtrade stack evaluated then dropped in favour of Alpaca equities",
  "paper_trade.py": "paper-trading harness on Alpaca: runs the live engine flat-by-EOD to validate edge",
  "alpaca_client.py": "Alpaca order/fill client (alpaca-py)",
  "risk-rules.md": "the safety contract: per-trade cap, daily cap, drawdown floor, kill-switch thresholds",
  "kill_switch.py": "circuit breaker that flattens and halts at the drawdown trip",
  ".env": "secrets-only store: Alpaca API keys live in env vars, never in code",
  "drawdown-guard": "the deterministic SafetyGuard rail enforcing caps and the drawdown stop before any order",

  // ---- Studio ----
  "webui.bat": "launches Render pipeline's Streamlit WebUI on :8501 to walk the render workflow",
  "config.toml": "render config: model, footage, voice and caption settings",
  "mpt-setup": "Render pipeline clone on Desktop — the verified video render engine",
  "catalyzed_generate.py": "render CLI: --lane + --subject (or --script) builds a short, drops a pending sidecar",
  "publish-notes.md": "format, schedule and upload defaults",
  "reference-clips": "reference clips for the render format",
  "autopost.py": "cross-poster: lists the queue and posts approved clips",
  "format-notes.md": "format notes for the second lane",
  "publish-queue": "pending publish path behind the approval gate",
  "hooks_ab.py": "hook A/B harness — variant openers measured against watch-time to pick winners",
  "visual-quality-bar.md": "the open clip-quality checklist",
  "perf-feedback": "performance signal feeding back into which hooks and formats get produced next",

  // ---- Learn the Stack ----
  "cc-setup": "Claude Code config — settings, skills, offload and auto-memory hooks",
  "ai-frontend-flow.md": "the vibe-coding loop: brief, premium-frontend-ui skill, Fable/ultracode build, screenshot-verify",
  "offload-router": "offload skill — sends model-agnostic grunt work to Codex/Sonnet to spare Opus budget",
  "shaders.ts": "GLSL glow system — one Points material for node halos, pulses and agent cores",
  "Effects.tsx": "post-processing layer — selective bloom, depth-of-field racking, vignette over the brain",
  "r3-remodel-lock.md": "R3 design contract — 3D look / 2D organization, no orbit, plexus brain, glyphs, wedge trees",
  "lib.rs": "Praxis Tauri shell — watch_folder file-birth visualizer, commands, window wiring",
  "Cargo.toml": "Rust manifest — Tauri 2 + plugins (global-shortcut, autostart, single-instance, notify)",
  "fetch_real_data.py": "keyless Yahoo Finance fetcher → research-data JSON (Catalyzed data engine)",
  "movers_miner.py": "scrapes most-active / gainers / losers via Yahoo screener, Finviz fallback",
  "model-routing.md": "notes on the model-routing stack — Opus/Sonnet/Haiku/local/Python by difficulty",

  memprompt: "/memprompt — turn what's in memory (your ideas + our decisions) into a prompt for a generation tool, WITHOUT over-constraining the design",
  offload: "offload skill — send model-agnostic grunt to Codex CLI (zero Claude usage); Opus keeps taste/architecture/scoring",
  overnight: "/overnight — autonomous overnight orchestrator: fast plan → you confirm → it fans out all night",
  "skill-scout": "ecc:skill-scout — search local/marketplace/GitHub for an existing skill before building a new one",
  "design→code": "Claude Design → Claude Code: design the UI visually (repo-linked) in claude.ai/design, then Send to Claude Code to build it against the real codebase",
  "offload router": "the routing rule — Opus for taste/architecture/scoring, Codex/Sonnet for grunt; never cut quality to save usage",
  "memory + intent": "auto-memory + intent-ledger hooks — every session writes durable facts + verbatim intent so the next session inherits context",
  "Flight Deck flow": "the worktree-aware multi-lane cockpit — run parallel Claude sessions/branches without collisions",
  "Codex CLI": "GPT-5.x via Codex CLI — the default grunt offload, no Claude usage; you verify the result",
  "sonnet-worker": "a Sonnet subagent for grunt that needs live repo context",
  "Hermes Agent": "Phase-3 orchestrator runtime candidate — native Windows computer-use",
  "subagent fan-out": "parallel agents / workflows for comprehensive, multi-step or adversarially-verified work",
  "Claude Max": "the model provider the Phase-3 agents run on",
  "Hume EVI": "the Praxis voice (Octave TTS) — key in the secrets vault",
  Groq: "free Whisper STT + Orpheus TTS — the voice-loop fallback",
  Cursor: "spread heavy visual work through Cursor when asked — paste-ready prompts + named model",
};

/** Resolve the best description for a node: id lookup for hub/area/task, label
 *  lookup for tier-3 artifacts. Returns undefined when nothing is authored. */
export function describeNode(node: BrainNode): string | undefined {
  return NODE_DESCRIPTIONS[node.id] ?? ARTIFACT_NOTES[node.label];
}
