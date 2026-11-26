/**
 * micLevel - a tiny module-level tap on the REAL microphone stream, so the HUD
 * waveform can render actual input amplitude while Praxis listens (never a
 * decorative fake). useVoiceCapture publishes its MediaStream here when a
 * recording starts and clears it when the recorder tears down; the analyser
 * rides the SAME stream - no second getUserMedia, no extra permission prompt.
 *
 * getMicLevel() returns 0..1 RMS-ish amplitude; 0 when no capture is live.
 */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let buf: Uint8Array | null = null;

export function publishMicStream(stream: MediaStream | null): void {
  // tear down the previous tap (the stream's tracks are owned by the recorder,
  // never stopped here)
  if (source) {
    try {
      source.disconnect();
    } catch {
      /* already gone */
    }
    source = null;
  }
  analyser = null;
  if (!stream) return;
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    ctx = ctx ?? new Ctx();
    if (ctx.state === "suspended") void ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.55;
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser); // analysis only - never routed to destination
    buf = new Uint8Array(analyser.fftSize);
  } catch {
    analyser = null; // no tap - the waveform falls back to its listening baseline
  }
}

/** Live mic amplitude 0..1 (0 when no capture is running). */
export function getMicLevel(): number {
  if (!analyser || !buf) return 0;
  try {
    analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const d = (buf[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / buf.length);
    // speech RMS peaks around ~0.3 - normalize so a normal voice reads ~0.7
    return Math.min(1, rms * 2.4);
  } catch {
    return 0;
  }
}

// ── TTS tap - the SAME trick for Praxis's own voice ─────────────────────────
// speak.ts publishes its <audio> element when a neural clip starts; we tap it
// via captureStream() (analysis only, playback untouched) so the state-bar
// waveform AND the brain core can move to the ACTUAL audio, word for word.
// SpeechSynthesis fallback has no element - callers keep the event envelope.

let ttsAnalyser: AnalyserNode | null = null;
let ttsSource: MediaStreamAudioSourceNode | null = null;
let ttsBuf: Uint8Array | null = null;

export function publishTtsAudio(audio: HTMLAudioElement | null): void {
  if (ttsSource) {
    try {
      ttsSource.disconnect();
    } catch {
      /* already gone */
    }
    ttsSource = null;
  }
  ttsAnalyser = null;
  if (!audio) return;
  try {
    const cap = (audio as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream;
    if (!cap) return;
    const stream = cap.call(audio);
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    ctx = ctx ?? new Ctx();
    if (ctx.state === "suspended") void ctx.resume();
    ttsAnalyser = ctx.createAnalyser();
    ttsAnalyser.fftSize = 256;
    ttsAnalyser.smoothingTimeConstant = 0.5;
    ttsSource = ctx.createMediaStreamSource(stream);
    ttsSource.connect(ttsAnalyser); // analysis only
    ttsBuf = new Uint8Array(ttsAnalyser.fftSize);
  } catch {
    ttsAnalyser = null; // no tap - callers fall back to the event envelope
  }
}

/** Live amplitude of Praxis's own voice, 0..1 (0 = no tapped clip playing). */
export function getTtsLevel(): number {
  if (!ttsAnalyser || !ttsBuf) return 0;
  try {
    ttsAnalyser.getByteTimeDomainData(ttsBuf as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < ttsBuf.length; i++) {
      const d = (ttsBuf[i] - 128) / 128;
      sum += d * d;
    }
    return Math.min(1, Math.sqrt(sum / ttsBuf.length) * 2.6);
  } catch {
    return 0;
  }
}
