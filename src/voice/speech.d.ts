/**
 * Minimal ambient types for the Web Speech `SpeechRecognition` API. It's a
 * non-standard (webkit-prefixed) API not always present in lib.dom, so we declare
 * just the surface we use and expose the constructors on `window`. Kept loose on
 * purpose - the runtime feature-detects and degrades honestly.
 */

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { readonly transcript: string; readonly confidence: number };
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
}

// NB: lib.dom already declares a (partial) global `SpeechRecognition`, so we do
// NOT augment Window here - useVoice accesses the constructor via a local cast to
// SpeechRecognitionCtor instead, avoiding the type clash.
