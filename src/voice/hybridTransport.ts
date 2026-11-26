/**
 * hybridTransport - the swappable speech I/O layer behind the Hybrid Praxis session.
 *
 * Example Creator's voice assistant runs on the OpenAI Realtime API (speech-to-speech over WebRTC,
 * server-side VAD, native barge-in). Praxis has NO OpenAI key today, so V1 ships on the
 * EXISTING stack: continuous STT capture (Groq Whisper via useVoiceCapture's Rust path)
 * + the NIM fast brain (brain_chat) + Groq/Orpheus TTS (speak.ts). The whole point of
 * this interface is that the router and UI never touch the transport directly - so when
 * an OpenAI Realtime transport is added later (a `RealtimeTransport implements
 * HybridTransport`), NOTHING in hybridRouter.ts / HybridSession.tsx changes.
 *
 * STT is driven by the session hook (useHybridSession) which already owns the continuous
 * recognizer lifecycle; a future speech-to-speech transport would fold STT into itself and the
 * hook would defer to it.
 *
 * V1 (LocalStackTransport) simply delegates to speak.ts - which already implements the
 * Groq/Orpheus-with-SpeechSynthesis-fallback path AND the isSpeaking/cancelSpeech
 * barge-in plumbing merged earlier today. So the "transport" is a thin, honest seam,
 * not speculative scaffolding: it names the boundary Realtime will slot into.
 */

import { speak, cancelSpeech, isSpeaking, onSpeakingChange } from "./speak";
import { realtimeAvailable, RealtimeTransport } from "./realtimeTransport";

export interface HybridTransport {
  /** Speak text aloud. Resolves when playback FINISHES (or is cancelled). */
  say(text: string): Promise<void>;
  /** True while audio is actually playing (drives the tap-to-interrupt affordance). */
  isSpeaking(): boolean;
  /** Barge-in: stop whatever is currently speaking, immediately. */
  stopSpeaking(): void;
  /** Subscribe to speaking-state flips. Returns an unsubscribe fn. */
  onSpeakingChange(fn: (speaking: boolean) => void): () => void;
  /**
   * Whether this transport owns its OWN speech input (true for a future
   * speech-to-speech Realtime transport). V1 is false: the session hook drives
   * STT via the existing continuous recognizer. Lets the hook know whether to
   * run its own capture loop or defer to the transport.
   */
  readonly ownsInput: boolean;
}

/**
 * V1 transport: the existing Praxis stack. STT is handled by useHybridSession's
 * continuous recognizer; this transport just wraps the TTS + barge-in half.
 */
export class LocalStackTransport implements HybridTransport {
  readonly ownsInput = false;

  say(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return Promise.resolve();
    return new Promise<void>((resolve) => {
      speak(clean, { onEnd: () => resolve() });
    });
  }

  isSpeaking(): boolean {
    return isSpeaking();
  }

  stopSpeaking(): void {
    cancelSpeech();
  }

  onSpeakingChange(fn: (speaking: boolean) => void): () => void {
    return onSpeakingChange(fn);
  }
}

/**
 * Non-hook choke point: pick a transport from the CACHED availability flag.
 *
 * NOTE: useHybridSession does NOT use this - it owns the realtime/local decision
 * directly so it can await connect() and fall back to local on failure (a sync
 * factory can't). This remains the documented default for any non-hook caller and
 * keeps the seam's intent in one obvious place. `realtimeAvailable()` reads a cache
 * that defaults to false until refreshRealtimeReady() confirms key + budget, so
 * this is safe to call synchronously.
 */
export function createHybridTransport(): HybridTransport {
  if (realtimeAvailable()) return new RealtimeTransport();
  return new LocalStackTransport();
}
