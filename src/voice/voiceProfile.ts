/**
 * voiceProfile - temporary CONTROLS-tab voice picker (3 options for Praxis's TTS voice).
 *
 * Persisted to localStorage (`praxis.voice.profile`) and synced to the Rust backend via
 * `set_voice_profile` so `speak_tts` picks the right Hume voice id (or ElevenLabs) on the
 * next utterance - the picker is authoritative over the raw `hume.voice` file. Inert outside
 * Tauri (dev browser): localStorage still works, the backend invoke is a silent no-op.
 */

import { useCallback, useEffect, useState } from "react";

/** `atlas` speaks in the live Realtime conversation's own voice, so Hold-T replies and
 *  the conversation sound like ONE assistant. The other three are deliberate picks. */
export type VoiceProfile = "atlas" | "hume-conversational" | "hume-actor" | "elevenlabs";

const PROFILE_KEY = "praxis.voice.profile";
const DEFAULT_PROFILE: VoiceProfile = "atlas";
/** Set once the stored pick has been moved onto `atlas`; a later re-pick is respected. */
const ATLAS_MIGRATION_KEY = "praxis.voice.profile.atlas-v1";

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

function isVoiceProfile(v: string | null): v is VoiceProfile {
  return v === "atlas" || v === "hume-conversational" || v === "hume-actor" || v === "elevenlabs";
}

function readProfile(): VoiceProfile {
  try {
    if (localStorage.getItem(ATLAS_MIGRATION_KEY) !== "1") {
      localStorage.setItem(PROFILE_KEY, DEFAULT_PROFILE);
      localStorage.setItem(ATLAS_MIGRATION_KEY, "1");
      return DEFAULT_PROFILE;
    }
    const v = localStorage.getItem(PROFILE_KEY);
    return isVoiceProfile(v) ? v : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

async function syncToBackend(profile: VoiceProfile): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_voice_profile", { profile });
  } catch {
    /* older backend without the command, or invoke failed - localStorage still works */
  }
}

export interface VoiceProfileStore {
  profile: VoiceProfile;
  setProfile: (profile: VoiceProfile) => void;
}

/** Hook for the CONTROLS tab's voice picker. */
export function useVoiceProfile(): VoiceProfileStore {
  const [profile, setProfileState] = useState<VoiceProfile>(readProfile);

  // Cross-window sync: another window changing the picker updates this one.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROFILE_KEY && isVoiceProfile(e.newValue)) setProfileState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setProfile = useCallback((next: VoiceProfile) => {
    setProfileState(next);
    try {
      localStorage.setItem(PROFILE_KEY, next);
    } catch {
      /* best-effort */
    }
    // Apply the new profile to the backend, THEN speak an audible confirmation in the
    // NEW voice so the owner hears the switch immediately. Ordering matters: speak() invokes
    // speak_tts, which reads the just-set profile - so we wait for set_voice_profile to
    // land before speaking, otherwise the confirmation could render in the OLD voice.
    void announceSwitch(next);
  }, []);

  return { profile, setProfile };
}

/**
 * Apply the profile to the backend and speak a short confirmation in the NEW voice.
 * Any stop() first so a barge-in guard / prior utterance doesn't swallow it. Kept
 * out of the hook body so it's callable once per switch without stale-closure risk.
 */
async function announceSwitch(profile: VoiceProfile): Promise<void> {
  // 1) push the new profile to Rust and WAIT - the next speak_tts must use it.
  await syncToBackend(profile);
  if (!inTauri()) return; // dev browser has no speak_tts sink
  try {
    // 2) cancel anything mid-flight, then speak in the freshly-applied voice.
    const { speak, cancelSpeech } = await import("./speak");
    try {
      cancelSpeech();
    } catch {
      /* ignore */
    }
    speak("Atlas here — this is my new voice.");
  } catch {
    /* speak module unavailable - the profile still switched */
  }
}
