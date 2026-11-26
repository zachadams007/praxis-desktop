/**
 * modelTint - per-MODEL signature hues, so an agent's chip + comet trail tells you
 * WHICH Claude model is driving it at a glance.
 *
 * The design rule (so this never fights the existing visual language): an agent's
 * HUE carries model identity, its LUMINANCE carries work-state. A working agent is
 * bright, an idle one is dim - that channel is untouched; we only shift the base
 * colour toward the model's signature. Agents with no known model fall back to the
 * theme accent (today's exact look), so nothing regresses.
 *
 * The real transcript bus already carries the model string per event
 * (claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-*, claude-fable-5); we map
 * it to a stable family + a premium hue tuned to glow on the near-black brain bg.
 *
 * Pure + dependency-free on purpose: the 3D runtime AND the chrome roster share this
 * one source of truth, and it unit-tests headless.
 */

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "hermes" | "codex" | "cursor";

/** Signature hue per family. Picked distinct corners of the wheel so no two
 *  families read alike, each luminous on dark.
 *  Hermes is the orchestrator/brain-core itself: electric cyan.
 *  Codex agents (Vega, Atlas) use teal - distinct from Claude violet.
 *  Cursor agent (Quill) uses warm amber - distinct from Codex teal. */
export const MODEL_TINT: Record<ModelFamily, string> = {
  opus:   "#b48cff", // luminous violet - Claude flagship (Forge)
  sonnet: "#ffc24a", // warm gold - Claude workhorse (Sage, Ledger)
  haiku:  "#5ef0a0", // fresh mint - fast Claude (Lens, Relay)
  fable:  "#ff6cc4", // rose - Claude creative
  hermes: "#00e5ff", // electric cyan - brain engine (Hermes, Praxis)
  codex:  "#26d4c8", // teal - Codex CLI agents (Vega, Atlas)
  cursor: "#f0a832", // warm amber - Cursor Composer agent (Quill)
};

/** Short, human label for the chrome (roster model pill). */
export const MODEL_LABEL: Record<ModelFamily, string> = {
  opus:   "Opus",
  sonnet: "Sonnet",
  haiku:  "Haiku",
  fable:  "Fable",
  hermes: "Hermes",
  codex:  "Codex",
  cursor: "Cursor",
};

/** Map any model id/string to its family, or null when unknown → no tint. Matches
 *  by substring so version suffixes (…-4-8, …-4-5-20251001) still resolve.
 *  "hermes" resolves from the literal agent id "a.hermes" as well as any model
 *  string containing "hermes" (e.g. Hermes-3 variants on OpenRouter).
 *  "codex" matches "codex" in the model string (Codex CLI / OpenAI Codex).
 *  "cursor" matches "cursor" in the model string. */
export function modelFamily(model?: string | null): ModelFamily | null {
  if (!model) return null;
  const s = model.toLowerCase();
  if (s.includes("hermes")) return "hermes";
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("fable")) return "fable";
  if (s.includes("gpt-") || s.includes("gpt_") || s.includes("openai")) return "codex";
  if (s.includes("codex")) return "codex";
  if (s.includes("cursor")) return "cursor";
  return null;
}

/** Signature hex for a model string, or null when the model is unknown. */
export function modelTint(model?: string | null): string | null {
  const f = modelFamily(model);
  return f ? MODEL_TINT[f] : null;
}
