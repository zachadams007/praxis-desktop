/**
 * Shared voice types. Kept in their own module (no React, no store, no DOM) so the
 * secondary-window recognizer + the orb UI can import `VoiceStatus` WITHOUT pulling in the
 * brain-only execution engine (which touches the store + scene event bus).
 */

export type VoiceStatus =
  | "off"
  | "unsupported"
  | "denied"
  | "no-mic"
  | "idle" // listening for the wake word
  | "armed" // wake heard / push-to-talk - capturing the command
  | "thinking"
  | "speaking";

export interface VoiceState {
  status: VoiceStatus;
  partial: string; // live interim transcript
  lastReply: string; // last thing Praxis said
}
