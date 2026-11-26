/**
 * The canonical JOURNEY model - the ONE place the plan lives (spec §B.1).
 *
 * The Journey corridor, the arrow-key scrub, and the Orchestrator's canned
 * planner all render/reason from this model. The brain-dump mock appends to it
 * in-memory (session-lifetime); in Phase 3 the real ingestion writes here.
 *
 * Authored truthfully against the owner's real roadmap (master-roadmap).
 *
 * `status` drives front/back placement on the time-corridor, `order` sequences
 * milestones within a branch, `eta` is the human label shown in journey mode.
 */

export type MilestoneStatus = "done" | "active" | "next" | "later";

export interface JourneyMilestone {
  /** Node id - doubles as the brain-graph task node id. */
  id: string;
  /** Branch (tier-1 area id in the graph). */
  areaId: string;
  label: string;
  status: MilestoneStatus;
  /** Within-branch sequence (gaps of 10 leave room for inserts). */
  order: number;
  /** Optional human time label, shown on the node in journey mode. */
  eta?: string;
  /** True when this was born from a brain-dump this session (demo ingest). */
  sprouted?: boolean;
}

/** done is deepest behind you; later is furthest ahead. */
export const STATUS_RANK: Record<MilestoneStatus, number> = {
  done: 0,
  active: 1,
  next: 2,
  later: 3,
};

// ---------------------------------------------------------------------------
// The authored roadmap (Phase 1: static; the dump box appends at runtime)
// ---------------------------------------------------------------------------

/** When this roadmap was last hand-edited.
 *
 *  It matters because AUTHORED_MILESTONES is a hand-typed array with hand-typed
 *  `status` and `eta` values, and the Journey view renders it as though it were
 *  tracked plan state. The only thing that can move a status is a real
 *  `journey:status` event from a session that keyword-matches a milestone, so
 *  most of it stays at whatever was typed here. Surfacing the date (see the
 *  Journey banner) makes it read as a PLAN rather than a status board.
 *  Bump this whenever the array below is edited. */
export const ROADMAP_AUTHORED_AT = "2026-06-16";

export const AUTHORED_MILESTONES: JourneyMilestone[] = [
  // ---- Catalyzed Alpha -----------------------------------------------------
  { id: "t.catalyzed.feed", areaId: "catalyzed", label: "Feed remodel", status: "done", order: 10 },
  { id: "t.catalyzed.algo", areaId: "catalyzed", label: "Algorithm scrollytelling", status: "done", order: 20 },
  { id: "t.catalyzed.ops", areaId: "catalyzed", label: "Ops surfaces: admin + desk", status: "done", order: 30 },
  { id: "t.catalyzed.terminal", areaId: "catalyzed", label: "Terminal data engine", status: "active", order: 40 },
  { id: "t.catalyzed.picks", areaId: "catalyzed", label: "Stock-picking fine-tune", status: "next", order: 50 },
  { id: "t.catalyzed.alerts", areaId: "catalyzed", label: "Phone alerts", status: "later", order: 60, eta: "phase 2" },

  { id: "t.ventures.freelance", areaId: "ventures", label: "Client work", status: "active", order: 10 },
  { id: "t.ventures.monetize", areaId: "ventures", label: "Release plan", status: "next", order: 20, eta: "after launch" },
  { id: "t.ventures.offers", areaId: "ventures", label: "Offers & positioning", status: "later", order: 30 },

  // ---- Finance (usage / money / ops + the Trading Bot track) ---------------
  { id: "t.finance.ledger", areaId: "finance", label: "Usage ledger + ops board", status: "done", order: 10 },
  { id: "t.finance.dash", areaId: "finance", label: "Spend dashboards", status: "active", order: 20 },
  { id: "t.finance.budget", areaId: "finance", label: "Budget guardrails", status: "next", order: 30 },
  { id: "t.finance.tradingbot", areaId: "finance", label: "Strategy research", status: "next", order: 40, eta: "after Catalyzed" },
  { id: "t.finance.revenue", areaId: "finance", label: "Revenue tracking", status: "later", order: 50, eta: "when shipping" },

  // ---- Studio (faceless short-form channel) ---------------------------
  { id: "t.studio.mpt", areaId: "studio", label: "Render pipeline", status: "done", order: 10 },
  { id: "t.studio.launch", areaId: "studio", label: "Studio launch", status: "done", order: 20 },
  { id: "t.studio.autopost", areaId: "studio", label: "Posting automation", status: "later", order: 30 },
  { id: "t.studio.hooks", areaId: "studio", label: "Hook A/B engine", status: "later", order: 40 },
  { id: "t.studio.praxispromo", areaId: "studio", label: "Post about Praxis & Catalyzed Alpha", status: "next", order: 50, eta: "after Praxis Phase 3" },
  { id: "t.studio.creatorresearch", areaId: "studio", label: "Format research", status: "later", order: 60 },

  // ---- Praxis (this app - synced to real shipped work) ----------------------
  { id: "t.praxis.brain", areaId: "praxis", label: "Neural-brain core", status: "done", order: 10 },
  { id: "t.praxis.gesture", areaId: "praxis", label: "Gesture nav v1", status: "done", order: 20 },
  { id: "t.praxis.journey", areaId: "praxis", label: "Journey roadmap", status: "done", order: 30 },
  { id: "t.praxis.orchestrator", areaId: "praxis", label: "Orchestrator mock", status: "done", order: 40 },
  { id: "t.praxis.flightdeck", areaId: "praxis", label: "Flight Deck cockpit", status: "done", order: 50 },
  { id: "t.praxis.agentviz", areaId: "praxis", label: "Agent activity viz", status: "done", order: 60 },
  { id: "t.praxis.realeventbus", areaId: "praxis", label: "Live event bridge", status: "active", order: 70 },
  { id: "t.praxis.costplan", areaId: "praxis", label: "Cost plan", status: "next", order: 80, eta: "phase 2" },
  { id: "t.praxis.runtime", areaId: "praxis", label: "Real agent runtime", status: "later", order: 90, eta: "phase 3" },

  { id: "t.learnai.skills", areaId: "learnai", label: "Skills", status: "active", order: 10 },
  { id: "t.learnai.workflows", areaId: "learnai", label: "Workflows", status: "active", order: 20 },
  { id: "t.learnai.agents", areaId: "learnai", label: "Agents & Codex", status: "next", order: 30 },
  { id: "t.learnai.subs", areaId: "learnai", label: "Toolbelt", status: "next", order: 40 },
  { id: "t.learnai.decisions", areaId: "learnai", label: "Learning & decisions", status: "later", order: 50 },
];

// ---------------------------------------------------------------------------
// Story geometry - shared by the corridor layout AND the arrow-key scrub
// ---------------------------------------------------------------------------

/**
 * A milestone's signed SLOT on the time axis within its branch.
 *   done   → -k … -1   (-1 = most recently finished, just behind you)
 *   active → 0          (clustered at the origin: NOW)
 *   undone → +1 … +m    (next sooner, later further ahead)
 */
export function storySlots(milestones: JourneyMilestone[]): Map<string, number> {
  const slots = new Map<string, number>();
  const byArea = new Map<string, JourneyMilestone[]>();
  for (const m of milestones) {
    const arr = byArea.get(m.areaId) ?? [];
    arr.push(m);
    byArea.set(m.areaId, arr);
  }
  for (const arr of byArea.values()) {
    const sorted = [...arr].sort(
      (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order,
    );
    const done = sorted.filter((m) => m.status === "done");
    const active = sorted.filter((m) => m.status === "active");
    const undone = sorted.filter((m) => m.status === "next" || m.status === "later");
    done.forEach((m, i) => slots.set(m.id, i - done.length)); // oldest deepest
    active.forEach((m) => slots.set(m.id, 0));
    undone.forEach((m, i) => slots.set(m.id, i + 1));
  }
  return slots;
}

/** Slot → world Z. Ahead opens up; behind compresses so ancient work recedes. */
export function slotToZ(slot: number, activeIndex = 0): number {
  if (slot > 0) return 8 + (slot - 1) * 7.2; // undone: roomy river ahead
  if (slot < 0) {
    const k = -slot;
    return -(5 + Math.pow(k - 1, 0.82) * 5.4); // done: mirrored + compressing
  }
  return 2.2 + activeIndex * 3.0; // active: right at your feet, just ahead
}

/**
 * The global scrub order (most ancient done → furthest later). Arrow keys and
 * the Orchestrator's "next up" both walk this. Tie-break keeps a stable,
 * deterministic ordering across branches.
 */
export function storyOrder(milestones: JourneyMilestone[]): string[] {
  const slots = storySlots(milestones);
  return [...milestones]
    .sort(
      (a, b) =>
        (slots.get(a.id) ?? 0) - (slots.get(b.id) ?? 0) ||
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.areaId.localeCompare(b.areaId) ||
        a.order - b.order,
    )
    .map((m) => m.id);
}

/** Index of the NOW boundary in storyOrder - the first non-done milestone. */
export function nowBoundary(orderedIds: string[], milestones: JourneyMilestone[]): number {
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const i = orderedIds.findIndex((id) => byId.get(id)?.status !== "done");
  return i === -1 ? orderedIds.length : i;
}

/** First milestone to do next (active first, else nearest "next"). */
export function nextUp(milestones: JourneyMilestone[]): JourneyMilestone | null {
  const ordered = storyOrder(milestones);
  const byId = new Map(milestones.map((m) => [m.id, m]));
  for (const id of ordered) {
    const m = byId.get(id)!;
    if (m.status === "next") return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency DAG - the journey roadmap (Part C: NOW-centered, splits & merges)
// ---------------------------------------------------------------------------

/**
 * Cross-area dependency edges `[fromId blocks toId]` - the hand-curated links
 * that make the FUTURE a genuine DAG (it SPLITS and MERGES across initiatives,
 * not just parallel lanes). Each is credible against the owner's real roadmap. The
 * per-area sequential spine is derived in code (not hand-listed); these are only
 * the cross-area edges. Solid edges = "blocks". Keep ACYCLIC (guarded below).
 */
export const JOURNEY_DEPS: [string, string][] = [
  // praxis runtime is the platform several things sit on
  ["t.praxis.orchestrator", "t.praxis.costplan"],
  ["t.praxis.flightdeck", "t.praxis.costplan"], // the cockpit's session/lane data feeds the cost plan
  ["t.praxis.realeventbus", "t.praxis.runtime"], // the live event bridge underwrites the real runtime
  ["t.praxis.costplan", "t.praxis.runtime"], // MERGE
  ["t.finance.budget", "t.praxis.costplan"], // cross-area MERGE
  // finance ops underwrite money-touching work (incl. the trading bot track)
  ["t.finance.budget", "t.finance.tradingbot"], // budget guardrails gate the live bot
  ["t.finance.budget", "t.catalyzed.alerts"], // SPLIT from finance.budget
  ["t.finance.revenue", "t.studio.autopost"],
  ["t.catalyzed.terminal", "t.finance.tradingbot"], // SPLIT
  ["t.catalyzed.picks", "t.finance.tradingbot"], // MERGE
  ["t.catalyzed.picks", "t.ventures.monetize"],
  // learning the AI craft underwrites the real agent runtime
  ["t.learnai.agents", "t.praxis.runtime"],
  // praxis agents run the posting pipeline
  ["t.praxis.runtime", "t.studio.autopost"], // cross-area SPLIT
];

/**
 * The full journey dependency DAG: the per-area sequential spine (consecutive
 * milestones by status→order) PLUS the authored cross-area deps, deduped and
 * cycle-guarded (a candidate edge is dropped if its target can already reach its
 * source). Returns `[fromId, toId]` predecessor→successor edges. Deterministic.
 */
export function journeyDagEdges(milestones: JourneyMilestone[]): [string, string][] {
  const ids = new Set<string>(milestones.map((m) => m.id));
  ids.add("hub"); // the brain is the root every branch sprouts from
  const out: [string, string][] = [];
  const succ = new Map<string, string[]>();
  const seen = new Set<string>();
  // reachability check (would adding from→to close a cycle? i.e. can `to` reach `from`?)
  const reaches = (from: string, to: string): boolean => {
    const stack = [from];
    const visited = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const n of succ.get(cur) ?? []) stack.push(n);
    }
    return false;
  };
  const add = (a: string, b: string) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const k = `${a}|${b}`;
    if (seen.has(k)) return;
    if (reaches(b, a)) {
      if (import.meta.env.DEV) console.warn(`[journey] dropped cyclic dep ${a} -> ${b}`);
      return;
    }
    seen.add(k);
    out.push([a, b]);
    (succ.get(a) ?? succ.set(a, []).get(a)!).push(b);
  };
  // per-area HUB-ROOTED branches: the brain sprouts each area's FUTURE chain to
  // the right (hub → active → next → later) and its PAST chain to the left
  // (hub → newest-done → … → oldest). The two sides join ONLY through the brain -
  // never a direct done→active edge (the owner's Journey-Tree spec).
  const byArea = new Map<string, JourneyMilestone[]>();
  for (const m of milestones) {
    const arr = byArea.get(m.areaId) ?? [];
    arr.push(m);
    byArea.set(m.areaId, arr);
  }
  for (const arr of byArea.values()) {
    const sorted = [...arr].sort(
      (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order,
    );
    const done = sorted.filter((m) => m.status === "done"); // oldest → newest
    const ahead = sorted.filter((m) => m.status !== "done"); // active → next → later
    // FUTURE branch (right): hub → active → next → later
    if (ahead.length) {
      add("hub", ahead[0].id);
      for (let i = 0; i < ahead.length - 1; i++) add(ahead[i].id, ahead[i + 1].id);
    }
    // PAST branch (left): hub → newest-done → … → oldest-done
    if (done.length) {
      add("hub", done[done.length - 1].id);
      for (let i = done.length - 1; i > 0; i--) add(done[i].id, done[i - 1].id);
    }
  }
  // authored cross-area deps - but SKIP any that straddle NOW (one endpoint done, the other
  // not). Same-area time order is already carried by the hub-rooted spine above.
  const statusOf = new Map(milestones.map((m) => [m.id, m.status]));
  const straddlesNow = (a: string, b: string): boolean => {
    const sa = statusOf.get(a);
    const sb = statusOf.get(b);
    if (!sa || !sb) return false;
    return (sa === "done") !== (sb === "done"); // one behind NOW, one ahead
  };
  for (const [a, b] of JOURNEY_DEPS) {
    if (straddlesNow(a, b)) continue;
    add(a, b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real-work → milestone targeting (spec §B.5/B.6) - EXPLICIT, EDITABLE mapping
// ---------------------------------------------------------------------------

/** The real-work signals that point a live session / flow lane / created file at a
 *  specific milestone. All matches are lowercase substring / keyword tests. */
export interface MilestoneSignal {
  /** substrings of a session/lane cwd (repo path) that target this milestone. */
  cwd?: string[];
  /** git-branch substrings that target this milestone. */
  branches?: string[];
  /** keywords matched against a prompt / preview / file name+path. */
  keywords?: string[];
}

/**
 * milestone id → its real-work signals. This is the ONE place to teach Praxis
 * "a session in <repo> on <branch> about <topic> is advancing <milestone>". It is
 * deliberately hand-authored, EDITABLE, and NOT fuzzy: a miss falls back to the
 * area's authored active milestone (never a hash-random pick - see areaTask). Keep
 * keywords specific enough that two milestones in one area don't both trivially
 * match the same generic word (branch > cwd > keyword in the scoring below).
 */
export const MILESTONE_SIGNALS: Record<string, MilestoneSignal> = {
  // ---- Catalyzed Alpha ----
  "t.catalyzed.feed": { keywords: ["feed remodel", "for-you", "social feed"] },
  "t.catalyzed.algo": { keywords: ["scrollytelling", "core guide", "algorithm explain"] },
  "t.catalyzed.ops": { keywords: ["admin", "ops desk", "ops surface"] },
  "t.catalyzed.terminal": { keywords: ["terminal", "data engine", "market data", "charts"] },
  "t.catalyzed.picks": { keywords: ["stock pick", "scorer", "ranking", "fine-tune", "signal"] },
  "t.catalyzed.alerts": { keywords: ["phone alert", "push notification", "price alert"] },
  // ---- Ventures ----
  "t.ventures.freelance": { keywords: ["freelance", "client work", "contract"] },
  "t.ventures.monetize": { keywords: ["monetize", "pricing", "paywall", "subscription tier"] },
  "t.ventures.offers": { keywords: ["offer", "positioning", "sales page"] },
  // ---- Finance ----
  "t.finance.ledger": { keywords: ["usage ledger", "ops board", "cost ledger"] },
  "t.finance.dash": { keywords: ["spend dashboard", "spend chart", "usage dashboard"] },
  "t.finance.budget": { keywords: ["budget guardrail", "budget cap", "spend limit"] },
  "t.finance.tradingbot": { cwd: ["trading", "alpha-fund"], keywords: ["trading bot", "backtest", "strategy"] },
  "t.finance.revenue": { keywords: ["revenue", "mrr", "income tracking"] },
  // ---- Studio ----
  "t.studio.mpt": { keywords: ["render-pipeline", "mpt", "video pipeline"] },
  "t.studio.launch": { keywords: ["studio launch", "channel launch"] },
  "t.studio.autopost": { keywords: ["autopost", "posting automation", "scheduler"] },
  "t.studio.hooks": { keywords: ["hook a/b", "hook engine", "thumbnail"] },
  "t.studio.praxispromo": { keywords: ["post about praxis", "catalyzed alpha promo", "studio promo"] },
  "t.studio.creatorresearch": { keywords: ["chorus.com", "creator inspiration", "ig transcript", "instagram transcript"] },
  // ---- Praxis (branch is the sharpest discriminator here) ----
  "t.praxis.brain": { branches: ["brain-window", "brain-v2"], keywords: ["neural brain", "dof", "soma", "dendrite"] },
  "t.praxis.gesture": { keywords: ["gesture nav", "one-euro", "pinch"] },
  "t.praxis.journey": { keywords: ["journey roadmap", "time corridor", "milestone"] },
  "t.praxis.orchestrator": { keywords: ["orchestrator", "delegate", "fan-out", "fleet"] },
  "t.praxis.flightdeck": { branches: ["flightdeck", "flight-deck"], keywords: ["flight deck", "flightdeck", "worktree lane"] },
  "t.praxis.agentviz": { keywords: ["agent viz", "agent activity", "comet trail"] },
  "t.praxis.realeventbus": { branches: ["brain-window-v2", "event-bridge"], keywords: ["event bridge", "real event", "flow runner", "flow_runner", "flow-progress", "userealevents"] },
  "t.praxis.costplan": { keywords: ["cost plan", "cost tracker", "budget plan"] },
  "t.praxis.runtime": { keywords: ["real runtime", "sovereign", "native orchestrat"] },
  // ---- Learning AI ----
  "t.learnai.skills": { keywords: ["skill capture", "skill-scout", "new skill"] },
  "t.learnai.workflows": { keywords: ["workflow", "design→code", "design to code"] },
  "t.learnai.agents": { keywords: ["subagent", "codex cli", "agent sdk"] },
  "t.learnai.subs": { keywords: ["subscription", "claude max", "hume", "groq"] },
  "t.learnai.decisions": { keywords: ["decision log", "learning note"] },
};

/**
 * Resolve real-work signals (cwd / branch / free text) to the milestone they most
 * specifically target. Scored: branch (3) > cwd (2) > keyword (1), summed across all
 * hits; the highest-scoring milestone that EXISTS in `milestones` wins. Returns
 * undefined on no match (the caller then falls back to the area's active milestone).
 */
export function milestoneForSignal(
  sig: { cwd?: string; branch?: string; text?: string },
  milestones: JourneyMilestone[],
): string | undefined {
  const cwd = (sig.cwd ?? "").toLowerCase();
  const branch = (sig.branch ?? "").toLowerCase();
  const text = (sig.text ?? "").toLowerCase();
  if (!cwd && !branch && !text) return undefined;
  const present = new Set(milestones.map((m) => m.id));
  let bestId: string | undefined;
  let bestScore = 0;
  for (const [id, s] of Object.entries(MILESTONE_SIGNALS)) {
    if (!present.has(id)) continue;
    let score = 0;
    if (branch && s.branches) for (const b of s.branches) if (branch.includes(b)) score += 3;
    if (cwd && s.cwd) for (const c of s.cwd) if (cwd.includes(c)) score += 2;
    if (text && s.keywords) for (const k of s.keywords) if (text.includes(k)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestScore > 0 ? bestId : undefined;
}

/**
 * The lane's authored "you are here" milestone - active, else nearest upcoming,
 * else the first - the DETERMINISTIC fallback target when no explicit signal
 * matches (spec §B.6). NEVER a hash-random pick. Returns the milestone id.
 */
export function areaActiveMilestone(
  areaId: string,
  milestones: JourneyMilestone[],
): string | undefined {
  const lane = milestones
    .filter((m) => m.areaId === areaId)
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order);
  return (
    lane.find((m) => m.status === "active") ??
    lane.find((m) => m.status === "next") ??
    lane[0]
  )?.id;
}

/**
 * The successor milestone a COMPLETED one feeds (spec §B.7). Prefers the dependency
 * DAG edge (journeyDagEdges - the authored splits/merges + the per-area spine);
 * falls back to the next milestone in the same area's story order. Undefined when
 * nothing follows it. Drives the real journey:handoff packet on task completion.
 */
export function journeySuccessor(
  milestoneId: string,
  milestones: JourneyMilestone[],
): string | undefined {
  for (const [from, to] of journeyDagEdges(milestones)) {
    if (from === milestoneId && to !== "hub") return to;
  }
  const order = storyOrder(milestones);
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const self = byId.get(milestoneId);
  if (!self) return undefined;
  const idx = order.indexOf(milestoneId);
  for (let i = idx + 1; i < order.length; i++) {
    const cand = byId.get(order[i]);
    if (cand && cand.areaId === self.areaId) return cand.id;
  }
  return undefined;
}
