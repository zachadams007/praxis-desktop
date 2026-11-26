/**
 * derive.ts - the Memory Galaxy's single-source-of-truth chrome derivations. Both live here
 * so the header, cockpit, atlas panel, and bottom rail can never disagree with each other (or
 * with the other Praxis windows) about "who's firing" and "how many artifacts".
 *
 *   • firingCount / isFiringAgent - the ONE fleet rule, mirroring src/store/usePraxisStore.ts's
 *     isFiringAgent so every window agrees on how many real coding sessions are running now.
 *   • deriveAreaBuckets - bucket every non-hub node by area with a guaranteed-reconciling total
 *     (header total === Σ shown category counts), surfacing any un-tagged node as an explicit
 *     "Uncategorized" row instead of silently dropping it from the visible sum.
 */
import { AREAS } from "./atlas";
import type { AgentRow } from "@/shared/agents";
import type { GraphData } from "./types";

// ---------------------------------------------------------------------------
// Fleet - the firing rule (2026-07-10 cross-window live-count fix)
// ---------------------------------------------------------------------------

/** Always-on ambient companions + the orchestrator core - real, but not a discrete coding
 *  session, so they must not inflate the "firing" count. Mirrors AMBIENT_AGENT_IDS. */
const AMBIENT_AGENT_IDS: ReadonlySet<string> = new Set(["a.praxis", "a.atlas", "a.sage", "a.scribe"]);
/** The invisible infra engine (brain runtime / router / records) - likewise never "firing".
 *  Mirrors the graph.ts `infra:true` set the store derives INFRA_AGENT_IDS from. */
const INFRA_AGENT_IDS: ReadonlySet<string> = new Set(["a.hermes", "a.relay", "a.ledger"]);

/** True for agents whose "working" state counts as a real firing coding session - the ONE
 *  rule every window shares (see src/store/usePraxisStore.ts isFiringAgent). */
export function isFiringAgent(id: string): boolean {
  return !AMBIENT_AGENT_IDS.has(id) && !INFRA_AGENT_IDS.has(id);
}

/** How many roster agents are genuinely firing right now: working AND firing-eligible.
 *  Derived from useAgentRoster() (fd_sessions) exactly like the Command Center fleet count. */
export function firingCount(roster: AgentRow[]): number {
  return roster.reduce((n, a) => (a.status === "working" && isFiringAgent(a.id) ? n + 1 : n), 0);
}

// ---------------------------------------------------------------------------
// Area buckets - reconciling artifact totals (2026-07-10 total-mismatch fix)
// ---------------------------------------------------------------------------

export interface AreaBucket {
  id: string;
  name: string;
  hue: string;
  blurb: string;
  count: number;
  /** true for the catch-all row (nodes whose area is not one of the labeled initiatives). */
  uncategorized?: boolean;
}

export interface AreaBuckets {
  /** present labeled areas (count > 0) in legend order, plus a trailing "Uncategorized" row
   *  when - and only when - there are non-hub nodes with no recognized area. */
  buckets: AreaBucket[];
  /** total non-hub artifacts. Guaranteed === Σ buckets[].count, so the header total the UI
   *  shows can never exceed (or fall short of) the sum of the category counts it renders. */
  total: number;
}

const UNCAT_HUE = "#5B6478";

/** Bucket every non-hub node by area. The total is the sum of the returned buckets by
 *  construction - every counted node lands in exactly one shown bucket (a labeled area or the
 *  explicit Uncategorized row), so header total and visible category counts always reconcile. */
export function deriveAreaBuckets(graph: GraphData): AreaBuckets {
  const areaIds = new Set(AREAS.map((a) => a.id));
  const counts: Record<string, number> = {};
  let uncat = 0;
  let total = 0;
  for (const n of graph.nodes) {
    if (n.kind === "hub") continue;
    total++;
    if (areaIds.has(n.area)) counts[n.area] = (counts[n.area] || 0) + 1;
    else uncat++;
  }
  const buckets: AreaBucket[] = [];
  for (const a of AREAS) {
    const c = counts[a.id] || 0;
    if (c > 0) buckets.push({ id: a.id, name: a.name, hue: a.hue, blurb: a.blurb, count: c });
  }
  if (uncat > 0)
    buckets.push({
      id: "__uncategorized__",
      name: "Uncategorized",
      hue: UNCAT_HUE,
      blurb: "no initiative tag yet",
      count: uncat,
      uncategorized: true,
    });
  return { buckets, total };
}
