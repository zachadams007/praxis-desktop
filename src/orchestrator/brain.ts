/**
 * brain.ts - plain reader for the currently selected brain model.
 *
 * Reads localStorage `praxis.brain.v1` (same key as brainStore.ts) without
 * requiring React context. Safe to call from orchestrator.ts at invoke time.
 *
 * Returns { provider, model } - the exact shape hermes_brain / brain_chat expects.
 *
 *   - SAFE_FALLBACK - NVIDIA NIM · `nvidia/nemotron-3.5-lightning-30b-a3b` (free, no breaker -
 *     VERIFY THIS ID STAYS ALIVE: the previous two NIM picks silently reached end-of-life
 *     (glm-5.1 on 2026-07-02, llama-3.3-70b on 2026-08-26) and each time every breaker-cut
 *     reroute in the app landed on a 410. See hermes_bridge.rs's NIM default comment.
 *     see fleetStore.ts's RAIL_BREAKER comment), used when storage is corrupt/
 *     unreadable AND as the reroute target when a kill-toggle cuts the persisted
 *     rail. This one must stay a rail with NO breaker of its own, or a cut Claude
 *     rail could "reroute" to another cut instance of Claude - see
 *     selectedBrainWithGate() below.
 *
 * Kill-toggle coherence: the Command Center "OpenRouter" switch is a REAL spend
 * gate, not informational. When the persisted brain is an OpenRouter model but
 * the toggle is off, `selectedBrain()` falls back to SAFE_FALLBACK - one choke
 * point, so every consumer (orchestrator plan/verify, brain chat) respects the
 * kill switch. `selectedBrainWithGate()` additionally reports the reroute so the
 * orchestrator can surface it as a visible thought.
 */

import { isToolEnabled } from "./policy";
import { brainRawAfterDefaultMigration } from "@/shared/brainPersistence";

/** One rail in Praxis's brain order (the Rust `BrainRail`). */
export interface BrainRail {
  provider: string;
  model: string;
}


export const OPUS_55: BrainRail = { provider: "claude-max", model: "claude-opus-5-5" };

export const CODEX_ASTRA: BrainRail = { provider: "openai-codex", model: "gpt-6-astra" };

export const API_ASTRA: BrainRail = { provider: "openai-api", model: "gpt-6-astra" };

/** Used ONLY when nothing is persisted yet - matches brainStore.ts's DEFAULT_BRAIN. */
export const FIRST_RUN_DEFAULT: { provider: string; model: string } = { ...OPUS_55 };

/** Used for corrupt/unreadable storage AND as the universal breaker-cut reroute
 *  target - NVIDIA NIM has no breaker (fleetStore.ts's RAIL_BREAKER), so it's
 *  always reachable regardless of which rail got cut. */
const SAFE_FALLBACK: { provider: string; model: string } = {
  provider: "nvidia",
  model: "nvidia/nemotron-3.5-lightning-30b-a3b",
};

// "openai-codex" is the one provider that legitimately has no model string - Hermes
// routes it through ~/.codex/auth.json and never takes a --model flag for it. Every
// other provider (including "claude-max") MUST resolve to a non-empty model before it
// reaches hermes_brain/brain_chat on the Rust side, or the CLI call breaks (see
// hermes_bridge.rs's hermes_brain/brain_chat for the matching defensive checks).
const NO_MODEL_PROVIDERS = new Set(["openai-codex"]);
const ACTIVE_PROVIDERS = new Set(["openai-api", "openai-codex", "claude-max", "openrouter", "nvidia"]);
const CLAUDE_CLI_MODELS = new Set(["opus", "sonnet", "claude-opus-5-5", "claude-sonnet-5-5"]);

/** Raw persisted selection - no kill-toggle applied. */
function persistedBrain(): { provider: string; model: string } {
  try {
    if (typeof localStorage === "undefined") return FIRST_RUN_DEFAULT;
    const raw = brainRawAfterDefaultMigration(localStorage);
    if (!raw) return FIRST_RUN_DEFAULT;
    const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
    const provider = typeof parsed.provider === "string" ? parsed.provider : null;
    if (!provider) return FIRST_RUN_DEFAULT;
    if (!ACTIVE_PROVIDERS.has(provider)) return FIRST_RUN_DEFAULT;
    const model = typeof parsed.model === "string" ? parsed.model : "";
    // Never revive an old Fable selection: it is not a current catalog choice
    // or a verified CLI route. A stale Claude choice returns to the safe
    // first-run Codex rail instead of selecting a paid API provider.
    if (provider === "claude-max" && !CLAUDE_CLI_MODELS.has(model)) return FIRST_RUN_DEFAULT;
    // Stale/corrupt storage could persist a provider with no model (or a future
    // catalog entry could ship one by mistake) - don't let that reach the Rust side.
    // This is a corruption case, not a fresh install, so it gets the SAFE fallback.
    if (!model && !NO_MODEL_PROVIDERS.has(provider)) return SAFE_FALLBACK;
    return { provider, model };
  } catch {
    return SAFE_FALLBACK;
  }
}

/** The breaker that cuts a brain rail, if it has one (NVIDIA and the OpenAI API have none). */
const RAIL_BREAKER: Record<string, string> = {
  "openai-codex": "codex",
  "claude-max": "claude",
  openrouter: "openrouter",
};

function railOn(rail: BrainRail): boolean {
  const breaker = RAIL_BREAKER[rail.provider];
  return !breaker || isToolEnabled(breaker);
}

/**
 * Rust walks it (`hermes_bridge::walk_brain_order`), skipping a rail it already knows is dark -
 * the vendor refusing Claude Code, Codex out of usage, an empty API wallet - and says which rail
 * answered. A breaker the owner cut is never in the order.
 */
export function brainOrder(primary: BrainRail): BrainRail[] {
  const subs = [OPUS_55, CODEX_ASTRA].filter((r) => r.provider !== primary.provider && railOn(r));
  const api = primary.provider === "openai-api" ? [] : [API_ASTRA];
  const free = primary.provider === "nvidia" ? [] : [SAFE_FALLBACK];
  return [...subs, ...api, ...free];
}

/**
 * Selected brain with the rail kill-toggles applied, a reroute flag, and the fallback order.
 */
export function selectedBrainWithGate(): { provider: string; model: string; rerouted: boolean; fallbacks: BrainRail[] } {
  const b = persistedBrain();
  const order = brainOrder(b);
  if (!railOn(b)) {
    const next = order[0] ?? SAFE_FALLBACK;
    return { ...next, rerouted: true, fallbacks: order.slice(1) };
  }
  return { ...b, rerouted: false, fallbacks: order };
}

/** The brain every model call should use (kill-toggle applied), with its fallback order -
 *  pass all three to `hermes_brain` / `brain_chat`. */
export function selectedBrain(): { provider: string; model: string; fallbacks: BrainRail[] } {
  const { provider, model, fallbacks } = selectedBrainWithGate();
  return { provider, model, fallbacks };
}

/** "GPT-6 Astra · Codex" - how a rail reads on a status line. */
export function railShortLabel(rail: BrainRail): string {
  const name: Record<string, string> = {
    "claude-opus-5-5": "Opus 5.5",
    "claude-sonnet-5-5": "Sonnet 5.5",
    opus: "Opus",
    sonnet: "Sonnet",
    "gpt-6-astra": "GPT-6 Astra",
    "nvidia/nemotron-3.5-lightning-30b-a3b": "Nemotron",
  };
  const where: Record<string, string> = {
    "claude-max": "Claude",
    "openai-codex": "Codex",
    "openai-api": "OpenAI API",
    openrouter: "OpenRouter",
    nvidia: "NVIDIA",
  };
  const model = name[rail.model] ?? (rail.model || "default");
  return `${model} · ${where[rail.provider] ?? rail.provider}`;
}

/**
 * What Atlas says when the brain call fails. That reply is spoken aloud and shown in
 * the Atlas panel, so it has to be a sentence, never a provider's JSON body.
 *
 * Measured 2026-09-15 with the OpenAI API wallet empty: every local-lane answer read
 * "my brain hit a snag - openai responses gpt-6-astra HTTP 429 Too Many Requests:
 * {"error":{"code":"credit_balance_exhausted",...}}" out loud, about thirty seconds
 * of Windows speech per question, while the fix was one sentence and a billing page.
 * The raw detail still goes to the console for debugging.
 */
export function brainFailureReply(detail: string): string {
  const raw = detail.trim();
  // Reaching this now means the reroute ALSO failed.
  if (/credit_balance_exhausted|insufficient_quota|credit is used up/i.test(raw)) {
    return "OpenAI API credit is used up, and your ChatGPT subscription and the free rail didn't answer either - so this one's a connection problem, not a billing one.";
  }
  if (!raw) return "my brain's unreachable for a sec — try again";
  // Keep the status line, drop any response body that follows it.
  const head = raw.split("\n")[0].replace(/[:\s]*[{[][\s\S]*$/, "").trim();
  const short = head.length > 110 ? `${head.slice(0, 107)}...` : head;
  return `my brain hit a snag — ${short || "try again"}`;
}