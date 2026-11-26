import { mirrorSet } from "./persist";

export const BRAIN_KEY = "praxis.brain.v1";

// The former all-OpenAI build could generate a Sol + all-OAI fleet signature, but that signature
// is indistinguishable from a deliberate Sol selection made while that build was installed.
// Cost-bearing preferences must never be guessed.
export const BRAIN_DEFAULTS_KEY = "praxis.brain.defaults.v2";
const BRAIN_DEFAULTS_VERSION = "2";

/**
 * His stored brain was GPT-6 Astra on the paid OpenAI API.
 */
export const BRAIN_OPUS55_KEY = "praxis.brain.upgrade.opus55";
export const OPUS55_BRAIN_BODY = JSON.stringify({ provider: "claude-max", model: "claude-opus-5-5" });

export function brainRawAfterDefaultMigration(storage: Storage): string | null {
  if (storage.getItem(BRAIN_DEFAULTS_KEY) !== BRAIN_DEFAULTS_VERSION) {
    storage.setItem(BRAIN_DEFAULTS_KEY, BRAIN_DEFAULTS_VERSION);
    mirrorSet(BRAIN_DEFAULTS_KEY, BRAIN_DEFAULTS_VERSION);
  }
  if (storage.getItem(BRAIN_OPUS55_KEY) !== "1") {
    storage.setItem(BRAIN_KEY, OPUS55_BRAIN_BODY);
    mirrorSet(BRAIN_KEY, OPUS55_BRAIN_BODY);
    storage.setItem(BRAIN_OPUS55_KEY, "1");
    mirrorSet(BRAIN_OPUS55_KEY, "1");
  }
  return storage.getItem(BRAIN_KEY);
}
