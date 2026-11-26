import { mirrorSet } from "./persist";

export type PersistedToolKey = "claude" | "codex" | "cursor" | "openrouter" | "hermes" | "computer-use";

export const TOOLS_KEY = "praxis.tools.v1";
export const TOOLS_DEFAULTS_KEY = "praxis.tools.defaults.v7";
const TOOLS_DEFAULTS_VERSION = "7";

/**
 * Breaker defaults, matched to what the owner actually has access to (2026-09-09).
 *
 * ALL SIX ARE ON. He holds paid plans on Claude, ChatGPT/Codex and Cursor, and every API key in
 * `~/.praxis/` is current.
 *
 * The two that were off had reasons that expired:
 *
 * That mattered more than a toggle: the default roster assigns Forge/Sage/Atlas
 * to Claude and Quill to Cursor, so an open breaker made those agents report
 * "tool cut - breaker open" in the fleet and the board meeting, which reads as
 * "the agent is broken" rather than "you switched its tool off".
 */
export const TOOL_DEFAULTS: Record<PersistedToolKey, boolean> = {
  claude: true,
  codex: true,
  cursor: true,
  openrouter: true,
  hermes: true,
  "computer-use": true,
};

/**
 * Normalize the persisted toggle map without erasing a deliberate user choice.
 * Older migrations replaced all six values whenever their version marker was
 * missing. This one preserves every explicit boolean and fills only absent or
 * invalid fields from the current safe defaults.
 *
 * ONE EXCEPTION, at a version bump. A stored `false` is normally sacred - it is the owner having cut
 * a tool on purpose. But a default that was itself `false` leaves an identical `false` in
 * storage, so "he chose this" and "he never touched it" are indistinguishable afterwards.
 */
export function readToolToggles(storage: Storage): Record<PersistedToolKey, boolean> {
  const raw = storage.getItem(TOOLS_KEY);
  const defaultsCurrent = storage.getItem(TOOLS_DEFAULTS_KEY) === TOOLS_DEFAULTS_VERSION;
  let parsed: Partial<Record<PersistedToolKey, unknown>> = {};
  try {
    const value = raw ? (JSON.parse(raw) as unknown) : {};
    if (typeof value === "object" && value !== null) {
      parsed = value as Partial<Record<PersistedToolKey, unknown>>;
    }
  } catch {
    // Corrupt storage is rebuilt from the fail-safe defaults below.
  }

  const next = { ...TOOL_DEFAULTS };
  if (defaultsCurrent) {
    for (const key of Object.keys(TOOL_DEFAULTS) as PersistedToolKey[]) {
      if (typeof parsed[key] === "boolean") next[key] = parsed[key];
    }
  }

  const body = JSON.stringify(next);
  if (raw !== body) {
    storage.setItem(TOOLS_KEY, body);
    mirrorSet(TOOLS_KEY, body);
  }
  if (storage.getItem(TOOLS_DEFAULTS_KEY) !== TOOLS_DEFAULTS_VERSION) {
    storage.setItem(TOOLS_DEFAULTS_KEY, TOOLS_DEFAULTS_VERSION);
    mirrorSet(TOOLS_DEFAULTS_KEY, TOOLS_DEFAULTS_VERSION);
  }
  return next;
}
