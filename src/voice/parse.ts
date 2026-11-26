/**
 * Wake-word parsing - pure + testable (scripts/test-voice-parse.cjs).
 *
 * Praxis answers to its primary wake word, with a legacy alias. We detect the wake word in a
 * transcript and extract whatever command followed it in the same breath, so
 * "Praxis, what's next?" runs immediately instead of waiting for a second pass.
 */

export const WAKE = /\b(praxis|jarvis)\b/i;

export function hasWake(text: string): boolean {
  return WAKE.test(text);
}

/** Strip a leading wake word + polite filler, returning the actual command (may be ""). */
export function afterWake(text: string): string {
  const m = text.match(WAKE);
  if (!m) return text.trim();
  let rest = text.slice((m.index ?? 0) + m[0].length);
  rest = rest.replace(
    /^[\s,.:;!?-]*(?:hey|hi|hello|please|can you|could you|would you|okay|ok)?[\s,.:;!?-]*/i,
    "",
  );
  return rest.trim();
}
