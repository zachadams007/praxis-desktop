/**
 * brainStore - selected brain model for the Hermes orchestrator.
 *
 * useBrain() - React hook; persisted to localStorage; emits Tauri event on change.
 * getSelectedBrain() - plain reader for use outside React (e.g. orchestrator.ts).
 *
 * Emits Tauri event `praxis://brain-model` { label, provider, model? } on change (guarded).
 * The catalog names the real execution rail and its billing surface. Codex is
 * the safe first-run default for this Codex-primary installation; other rails
 * remain explicit choices and fail closed when authentication is unavailable.
 */

import { useState, useCallback, useEffect } from "react";
import { mirrorSet } from "@/shared/persist";
import { BRAIN_KEY, brainRawAfterDefaultMigration } from "@/shared/brainPersistence";

// ----------------------------------------------------------------- types ---

export interface BrainOption {
  label: string;
  provider: string;
  model: string;
  /** Short tag shown to the owner in the picker and the active-brain line. */
  account: string;
}

// ---------------------------------------------------------------- catalog ---

// Provider/model IDs are passed unchanged to the Tauri dispatch boundary. The brain order in
// brain.ts falls back through the same seats in the same spirit.
export const BRAIN_OPTIONS: BrainOption[] = [
  {
    label: "Opus 5.5",
    provider: "claude-max",
    model: "claude-opus-5-5",
    account: "Claude subscription · Claude Code CLI",
  },
  {
    label: "Sonnet 5.5",
    provider: "claude-max",
    model: "claude-sonnet-5-5",
    account: "Claude subscription · lighter on the 5h window",
  },
  {
    label: "GPT-6 Astra · Codex",
    provider: "openai-codex",
    model: "gpt-6-astra",
    account: "ChatGPT/Codex subscription",
  },
  {
    label: "NVIDIA NIM · Nemotron 3.5 Lightning 30B",
    provider: "nvidia",
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    account: "NVIDIA developer rail · free limits",
  },
  {
    label: "OpenRouter · GLM 5.3",
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    account: "OpenRouter API · backup · metered",
  },
  {
    label: "OpenRouter · Kimi K3",
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    account: "OpenRouter API · backup · metered",
  },
  {
    label: "GPT-6 Astra · API",
    provider: "openai-api",
    model: "gpt-6-astra",
    account: "OpenAI API · backup · shared brain/QA/voice wallet",
  },
  {
    label: "GPT-5.6 Sol · API",
    provider: "openai-api",
    model: "gpt-5.6-sol",
    account: "OpenAI API · backup · shared brain/QA/voice wallet",
  },
  {
    label: "GPT-5.6 Terra · API",
    provider: "openai-api",
    model: "gpt-5.6-terra",
    account: "OpenAI API · backup · shared brain/QA/voice wallet",
  },
  {
    label: "GPT-5.6 Luna · API",
    provider: "openai-api",
    model: "gpt-5.6-luna",
    account: "OpenAI API · backup · shared brain/QA/voice wallet",
  },
];

// Resolved by provider+model, not index, so a catalog reorder cannot change it.
export const DEFAULT_BRAIN =
  BRAIN_OPTIONS.find((o) => o.provider === "claude-max" && o.model === "claude-opus-5-5") ??
  BRAIN_OPTIONS[0];

// --------------------------------------------------------------- storage helpers ---

/**
 * One-time move off GPT-5.6 Sol for the BRAIN, 2026-09-09 - the same upgrade the
 * fleet gets, for the same reason. Sol is deliberately still in the catalog as the
 * previous top, so the ordinary "does this id still exist?" guard leaves a stored
 * Sol selection exactly where it is. Marked by its own key so a later deliberate
 * pick of Sol sticks.
 */
const BRAIN_ASTRA_KEY = "praxis.brain.upgrade.astra";

function applyBrainAstraUpgrade(storage: Storage): void {
  try {
    if (storage.getItem(BRAIN_ASTRA_KEY) === "1") return;
    const raw = storage.getItem(BRAIN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
      if (parsed.provider === "openai-api" && parsed.model === "gpt-5.6-sol") {
        const body = JSON.stringify({ provider: "openai-api", model: "gpt-6-astra" });
        storage.setItem(BRAIN_KEY, body);
        mirrorSet(BRAIN_KEY, body);
      }
    }
    storage.setItem(BRAIN_ASTRA_KEY, "1");
    mirrorSet(BRAIN_ASTRA_KEY, "1");
  } catch {
    /* storage unavailable - the catalog already leads with Astra */
  }
}

function loadBrain(): BrainOption {
  try {
    applyBrainAstraUpgrade(localStorage);
    const raw = brainRawAfterDefaultMigration(localStorage);
    if (!raw) return DEFAULT_BRAIN;
    const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
    // Match by provider+model to restore the full catalog entry (incl. account tag).
    const match = BRAIN_OPTIONS.find(
      (o) => o.provider === parsed.provider && o.model === (parsed.model ?? ""),
    );
    return match ?? DEFAULT_BRAIN;
  } catch {
    return DEFAULT_BRAIN;
  }
}

function saveBrain(b: BrainOption): void {
  try {
    const body = JSON.stringify({ provider: b.provider, model: b.model });
    localStorage.setItem(BRAIN_KEY, body);
    mirrorSet(BRAIN_KEY, body);
  } catch {
    /* best-effort */
  }
}

// --------------------------------------------------------------- Tauri emit (guarded) ---

async function tauriEmitBrain(b: BrainOption): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("praxis://brain-model", {
      label: b.label,
      provider: b.provider,
      model: b.model,
    });
  } catch {
    // Not in Tauri - silent in dev browser
  }
}

// --------------------------------------------------------------- plain reader ---

/**
 * getSelectedBrain - safe to call outside React.
 * Returns { provider, model } for the currently persisted brain selection.
 */
export function getSelectedBrain(): { provider: string; model: string } {
  const b = loadBrain();
  return { provider: b.provider, model: b.model };
}

/**
 * Resolve a spoken/typed brain name to a BRAIN_OPTIONS catalog entry.
 * Returns null when nothing plausible matches, so callers can give an honest
 * "I don't have that model" reply instead of silently no-op'ing.
 */
export function resolveBrainByName(spoken: string): BrainOption | null {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  const q = normalize(spoken);
  if (!q) return null;

  const ALIASES: Record<string, string[]> = {
    "Opus 5.5": ["opus", "opus 5 5", "opus five point five", "claude", "claude opus", "claude cli", "claude pro"],
    "Sonnet 5.5": ["sonnet", "sonnet 5 5", "sonnet five point five", "claude sonnet"],
    "GPT-6 Astra · Codex": ["codex", "chatgpt", "codex subscription", "astra", "gpt 6", "gpt 6 astra", "gpt six astra", "gpt six"],
    // "llama" stays an alias on purpose: the NIM rail was Llama 3.3 for months and the owner
    // still says it out loud. Spoken aliases outlive model ids (this rail was GLM 5.1
    // before that), so old names keep resolving to whatever the free rail currently is.
    "NVIDIA NIM · Nemotron 3.5 Lightning 30B": [
      "nvidia",
      "nvidia nim",
      "nim",
      "nemotron",
      "lightning",
      "llama",
      "llama 3 3 70b",
      "free",
    ],
    "OpenRouter · GLM 5.3": ["glm", "glm 5.3", "glm-5.3", "glm 5.2", "z-ai", "zai"],
    "OpenRouter · Kimi K3": ["openrouter", "kimi", "kimi k3", "kimi k2.6", "router", "moonshot"],
    "GPT-6 Astra · API": ["astra api", "gpt 6 astra api", "openai api astra", "api astra"],
    "GPT-5.6 Sol · API": ["sol", "gpt 5 6 sol", "gpt 5 6", "openai api sol", "openai api"],
    "GPT-5.6 Terra · API": ["terra", "gpt 5 6 terra", "openai api terra", "balanced"],
    "GPT-5.6 Luna · API": ["luna", "gpt 5 6 luna", "openai api luna", "fast", "efficient", "cheap"],
  };

  let best: { option: BrainOption; score: number } | null = null;
  for (const opt of BRAIN_OPTIONS) {
    const names = [opt.label, opt.provider, ...(ALIASES[opt.label] ?? [])]
      .map(normalize)
      .filter(Boolean);
    for (const name of names) {
      if (q !== name && !q.includes(name)) continue;
      // Exact matches win; otherwise the longest specific phrase wins. This
      // prevents "gpt 5.6 terra" from being captured by Sol's shorter
      // "gpt 5.6" alias and prevents "openai api luna" becoming paid Sol.
      const score = name.length + (q === name ? 10_000 : 0);
      if (!best || score > best.score) best = { option: opt, score };
    }
  }
  return best?.option ?? null;
}

/**
 * Plain module-level setter - safe to call outside React (voice/chat command
 * execution). Persists + emits the Tauri event exactly like useBrain().setBrain,
 * so a spoken "switch to Luna" changes the SAME selection the Command Center's
 * brain picker reads and RightDock/CC pick it up on their next render/poll.
 */
export function setSelectedBrain(b: BrainOption): void {
  saveBrain(b);
  void tauriEmitBrain(b);
}

// --------------------------------------------------------------- live rail ---

/** Which rail answered the last brain call (Rust `BrainRailStatus`, praxis://brain-rail). */
export interface BrainRailStatus {
  requested?: { provider: string; model: string } | null;
  used?: { provider: string; model: string } | null;
  /** One sentence per rail skipped or failed before `used`. */
  skipped: string[];
  at_ms: number;
}

/**
 * The rail Praxis is ACTUALLY thinking on.
 */
export function useBrainRail(): BrainRailStatus | null {
  const [status, setStatus] = useState<BrainRailStatus | null>(null);
  useEffect(() => {
    let dead = false;
    let off: (() => void) | undefined;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const last = await invoke<BrainRailStatus | null>("brain_rail_status");
        if (!dead && last) setStatus(last);
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<BrainRailStatus>("praxis://brain-rail", (e) => setStatus(e.payload));
        if (dead) unlisten();
        else off = unlisten;
      } catch {
        /* dev browser: no live rail to show */
      }
    })();
    return () => {
      dead = true;
      off?.();
    };
  }, []);
  return status;
}

// --------------------------------------------------------------- hook ---

export interface BrainStore {
  brain: BrainOption;
  setBrain: (b: BrainOption) => void;
}

export function useBrain(): BrainStore {
  const [brain, setBrainState] = useState<BrainOption>(loadBrain);

  const setBrain = useCallback((b: BrainOption) => {
    setBrainState(b);
    saveBrain(b);
    void tauriEmitBrain(b);
  }, []);

  return { brain, setBrain };
}
