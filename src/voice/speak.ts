/**
 * speak - Praxis's VOICE (Jarvis-style TTS).
 *
 * Phase 1 uses the built-in Web Speech `SpeechSynthesis` (free, no signup, works in Windows
 * WebView2).
 *
 * Voice selection leans British + measured for the butler cadence; falls back
 * gracefully across platforms. Voices load async, so we re-pick on voiceschanged.
 */

import { eventBus } from "@/data/eventBus";
import { publishTtsAudio } from "./micLevel";

let cachedVoice: SpeechSynthesisVoice | null = null;

// Preference order for a "Praxis" voice - refined British male first, then any
// en-GB, then deeper en-US males, then anything English.
const VOICE_PREFS: RegExp[] = [
  /google uk english male/i,
  /\bdaniel\b/i, // macOS en-GB male
  /microsoft (george|ryan)/i, // Windows en-GB males
  /\b(arthur|oliver|brian)\b/i,
  /en[-_]gb/i,
  /microsoft (guy|david|mark)/i, // en-US male fallbacks
];

function pickVoice(): SpeechSynthesisVoice | null {
  const synth = window.speechSynthesis;
  const voices = synth?.getVoices?.() ?? [];
  if (!voices.length) return null;
  for (const re of VOICE_PREFS) {
    const hit = voices.find((v) => re.test(v.name) || re.test(v.lang));
    if (hit) return hit;
  }
  return voices.find((v) => /^en/i.test(v.lang)) ?? voices[0];
}

/** Warm the voice list (call once at startup; voices arrive async on some platforms). */
export function primeVoices(): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const set = () => {
    cachedVoice = pickVoice();
  };
  set();
  synth.addEventListener?.("voiceschanged", set);
}

export interface SpeakOpts {
  onStart?: () => void;
  onEnd?: () => void;
}
export interface SpeakHandle {
  cancel: () => void;
}

/** True if the platform can speak at all (honest dead-toggle guard). */
export const canSpeak = (): boolean => typeof window !== "undefined" && !!window.speechSynthesis;

/**
 * True if we should use the browser's Web Speech `SpeechRecognition` (STT) - i.e. only in a
 * REAL browser (dev/Chrome). It is deliberately FALSE inside the Tauri shell: WebView2 *exposes*
 * the SpeechRecognition constructor (Blink ships the JS interface) but has NO recognition backend,
 * so it looks available and silently never works. So in the app we ignore it and use the capture
 * path (useVoiceCapture → Groq Whisper) instead. Detecting "am I in WebView2" via the Tauri bridge
 * is the only reliable signal - constructor presence is a false positive there.
 */
export const canRecognize = (): boolean => {
  if (typeof window === "undefined") return false;
  const inTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (inTauri) return false; // WebView2's SpeechRecognition is a dead stub - use Groq capture
  return !!(
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
  );
};

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let currentAudio: HTMLAudioElement | null = null;
let speakGen = 0; // bumped per speak(); a superseded in-flight synthesis drops its result
let cancelCurrentSpeech: (() => void) | null = null;

// ── Shared "is Praxis talking right now" flag - barge-in reads this ──────────
// speak() is only ever called from the BRAIN window (see execute.ts / route.ts /
// usePraxisStore.ask), so a module-level flag is a complete source of truth; no
// cross-window sync needed. Subscribers (the orb UI) get a sync callback so the
// pulsing stops the instant cancelSpeech() tears the audio down - not just when
// the (possibly never-firing) onended eventually would have.
let speaking = false;
const speakingSubs = new Set<(v: boolean) => void>();
function setSpeaking(v: boolean): void {
  if (speaking === v) return;
  speaking = v;
  for (const fn of speakingSubs) fn(v);
}
/** True while a TTS utterance (native clip or SpeechSynthesis) is actually playing. */
export const isSpeaking = (): boolean => speaking;
/** Subscribe to speaking-state flips (returns an unsubscribe fn). Fires synchronously. */
export function onSpeakingChange(fn: (v: boolean) => void): () => void {
  speakingSubs.add(fn);
  return () => speakingSubs.delete(fn);
}

function stopCurrentAudio(): void {
  publishTtsAudio(null); // release the level tap
  if (currentAudio) {
    try {
      currentAudio.onerror = null;
      currentAudio.onended = null;
      currentAudio.onplay = null;
      currentAudio.pause();
      currentAudio.src = ""; // drop the source so the in-flight fetch/decoder is abandoned
      currentAudio.load(); // force the media element to actually release the old src (WebView2)
      currentAudio.remove(); // drop the DOM node speak() parented in (see the append below)
    } catch {
      /* noop */
    }
    currentAudio = null;
  }
  setSpeaking(false);
}

/** The robotic-but-always-available SpeechSynthesis path (fallback / dev browser). */
function speakViaSynthesis(text: string, opts: SpeakOpts): void {
  const synth = window.speechSynthesis;
  if (!synth) {
    opts.onEnd?.();
    return;
  }
  synth.cancel();
  if (!cachedVoice) cachedVoice = pickVoice();
  const u = new SpeechSynthesisUtterance(text);
  if (cachedVoice) u.voice = cachedVoice;
  u.rate = 1.2;
  u.pitch = 0.9;
  u.volume = 1;
  u.onstart = () => {
    setSpeaking(true);
    eventBus.emit({ type: "orchestrator:speaking", t: 0, duration: Math.min(30, text.length * 0.06) });
    opts.onStart?.();
  };
  u.onend = () => {
    setSpeaking(false);
    opts.onEnd?.();
  };
  u.onerror = () => {
    setSpeaking(false);
    opts.onEnd?.();
  };
  synth.speak(u);
}

/**
 * Speak text in the Praxis voice. In the app, this asks the Rust `speak_tts` command for a
 * neural clip (Groq Orpheus) and plays it; on ANY failure (no key, Orpheus terms not yet
 * accepted, network) it falls back to SpeechSynthesis so Praxis is never mute. Barges in over
 * any current utterance.
 */
export function speak(text: string, opts: SpeakOpts = {}): SpeakHandle {
  const clean = text.trim();
  if (!clean) {
    opts.onEnd?.();
    return { cancel: () => {} };
  }
  cancelSpeech(); // barge-in
  const myGen = ++speakGen; // anything synthesized for an earlier call is now stale

  let cancelled = false;
  let settled = false;
  let fallbackStarted = false;
  let cancelThisSpeech: () => void;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (cancelCurrentSpeech === cancelThisSpeech) cancelCurrentSpeech = null;
    opts.onEnd?.();
  };
  cancelThisSpeech = () => {
    if (cancelled) return;
    cancelled = true;
    // A stale SpeakHandle must settle only its own promise; it must never stop a
    // newer utterance that has since become the module's current speech owner.
    if (cancelCurrentSpeech === cancelThisSpeech) {
      cancelCurrentSpeech = null;
      speakGen += 1;
      stopCurrentAudio();
      window.speechSynthesis?.cancel();
    }
    finish();
  };
  cancelCurrentSpeech = cancelThisSpeech;
  const handle: SpeakHandle = { cancel: cancelThisSpeech };

  if (!inTauri()) {
    speakViaSynthesis(clean, { ...opts, onEnd: finish });
    return handle;
  }

  void (async () => {
    let played = false;
    const fallback = () => {
      if (cancelled || settled || fallbackStarted || myGen !== speakGen) return;
      fallbackStarted = true;
      speakViaSynthesis(clean, { ...opts, onEnd: finish });
    };
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = await invoke<number[]>("speak_tts", { text: clean });
      if (cancelled || myGen !== speakGen) return; // a newer speak() superseded this one
      if (!bytes || bytes.length <= 44) throw new Error("empty-tts"); // <= a bare WAV header
      // Sniff the container so the <audio> blob gets the right MIME. Hume/Groq
      // return WAV ("RIFF"); ElevenLabs returns MP3 (ID3 tag or a 0xFFEx frame
      // sync). Mislabeling MP3 as audio/wav can silently fail to play in WebView2
      // (this was why the ElevenLabs voice "didn't switch").
      const u8 = new Uint8Array(bytes);
      const isWav = u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46; // "RIFF"
      const isMp3 =
        (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) || // "ID3"
        (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0); // MPEG frame sync
      const mime = isWav ? "audio/wav" : isMp3 ? "audio/mpeg" : "audio/wav";
      const blob = new Blob([u8], { type: mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      // WebView2 will silently drop audio from a DETACHED media element - it never acquires an
      // output-device sink, so `.play()` resolves and `onplay` fires (UI shows SPEAKING) while
      // nothing is actually heard. Parent the element into the DOM (zero-size, hidden) so it
      // routes to a real audio output.
      audio.preload = "auto";
      audio.style.cssText =
        "position:fixed;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;";
      document.body.appendChild(audio);
      currentAudio = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (audio.parentNode) audio.parentNode.removeChild(audio);
        if (currentAudio === audio) currentAudio = null;
      };
      audio.onplay = () => {
        played = true;
        setSpeaking(true);
        publishTtsAudio(audio); // waveform + brain core ride the REAL audio level
        // drive the brain's speaking pulse from the ACTUAL audio start (synced - not a pre-estimate)
        const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : clean.length * 0.06;
        eventBus.emit({ type: "orchestrator:speaking", t: 0, duration: Math.min(30, dur) });
        opts.onStart?.();
      };
      audio.onended = () => {
        publishTtsAudio(null);
        cleanup();
        setSpeaking(false);
        finish();
      };
      audio.onerror = () => {
        cleanup();
        setSpeaking(false);
        if (played) finish();
        else fallback();
      };
      await audio.play();
    } catch {
      if (!cancelled) fallback();
    }
  })();

  return handle;
}

/**
 * Barge-in: tear down whatever is currently making sound RIGHT NOW - pause + drop the
 * <audio> source (native Groq/Orpheus clip) AND cancel any in-flight SpeechSynthesis
 * utterance. Safe to call even when nothing is speaking. `speakGen` (bumped in speak())
 * additionally guards against a same-tick in-flight `speak_tts` invoke() landing after a
 * cancel - its result is dropped rather than played, so a "start new speech" call and a
 * "just stop" call compose correctly.
 */
export function cancelSpeech(): void {
  const cancel = cancelCurrentSpeech;
  if (cancel) {
    cancel();
    return;
  }
  // Even without an installed completion callback, invalidate any pending TTS
  // result from an older generation and tear down all platform playback.
  speakGen += 1;
  stopCurrentAudio();
  window.speechSynthesis?.cancel();
  setSpeaking(false);
}

/**
 * A short ascending "I'm listening" chime, synthesized via Web Audio (no asset).
 * Two soft sine blips - a polite acknowledgement, not a notification jingle.
 */
let audioCtx: AudioContext | null = null;
export function wakeChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx ?? new Ctx();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const notes = [659.25, 987.77]; // E5 → B5, a clean ascending fifth
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.24);
    });
  } catch {
    /* audio unavailable - silent is fine */
  }
}
