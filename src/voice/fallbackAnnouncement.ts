import type { HybridTransport } from "./hybridTransport";

// Same voice either way now (voice_tts `atlas` profile), so do not announce a "local
// voice" that no longer sounds different - just say the connection hiccuped.
export const FALLBACK_ANNOUNCEMENT = "My live connection dropped. I'm still listening.";

/** Announce the voice change before opening local capture, so our own speech
 * cannot be transcribed as a user command. Cleanup also retires late TTS. */
export function announceLocalFallback(
  transport: Pick<HybridTransport, "say" | "stopSpeaking">,
  resume: () => void,
  timeoutMs = 8000,
): () => void {
  let retired = false;
  const finish = () => {
    if (retired) return;
    retired = true;
    clearTimeout(timer);
    resume();
  };
  const timer = setTimeout(() => {
    if (retired) return;
    transport.stopSpeaking();
    finish();
  }, timeoutMs);
  try {
    void transport.say(FALLBACK_ANNOUNCEMENT).then(finish, finish);
  } catch {
    finish();
  }
  return () => {
    if (retired) return;
    retired = true;
    clearTimeout(timer);
    transport.stopSpeaking();
  };
}
