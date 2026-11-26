/**
 * useVoiceCapture - push-to-talk speech input for the packaged app (WebView2), where the Web
 * Speech `SpeechRecognition` API does not exist. It captures a mic clip with getUserMedia +
 * MediaRecorder (both DO work in WebView2), sends the bytes to the Rust `transcribe_audio`
 * command (Groq whisper-large-v3-turbo), and hands the recognized text to `onTranscript` - which
 * the caller routes through the SAME command parser + TTS as the old wake-word path.
 *
 * Push-to-talk, not always-on: toggle() starts a recording, toggle() again (or a max-length
 * timeout) sends it. That's the right model for a cloud STT - you don't stream the room to the
 * cloud, you speak a command and release. Honest states: needs a Groq key → "unsupported" with a
 * setup hint; mic blocked → "denied". Reuses the VoiceStatus vocabulary so the orb UI is shared.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelSpeech } from "./speak";
import { publishMicStream } from "./micLevel";
import type { VoiceStatus } from "./types";

/** Ask Rust whether the Groq key is present - best-effort, never throws. */
async function checkSttReady(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("stt_ready");
  } catch {
    return true; // optimistic: let a real recording attempt surface the error
  }
}

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const MAX_MS = 60000; // safety ceiling only; the owner should normally release/click to send

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const m of opts) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return "";
}

export function useVoiceCapture(
  onTranscript: (t: string) => void,
  enabled: boolean,
  /** Called with the FINAL Groq transcript before the command router runs.
   *  Return true to handle it and skip the default route. */
  onFinal?: (t: string) => boolean | void | Promise<boolean | void>,
) {
  const [status, setStatusState] = useState<VoiceStatus>("off");
  const [partial, setPartial] = useState("");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<VoiceStatus>("off");
  const onTextRef = useRef(onTranscript);
  onTextRef.current = onTranscript;
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const set = (s: VoiceStatus) => {
    statusRef.current = s;
    setStatusState(s);
  };

  const stopTracks = () => {
    publishMicStream(null); // release the HUD waveform's analyser tap
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const transcribe = useCallback(
    async (blob: Blob, mime: string) => {
      set("thinking");
      try {
        const buf = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const { invoke } = await import("@tauri-apps/api/core");
        const text = await invoke<string>("transcribe_audio", { audio: bytes, mime });
        if (text && text.trim()) {
          setPartial("");
          const handled = (await onFinalRef.current?.(text.trim())) === true;
          if (!handled) onTextRef.current(text.trim());
        } else {
          setPartial("didn't catch that — try again");
        }
        set(enabled ? "idle" : "off");
      } catch (err) {
        const msg = String(err);
        if (msg.includes("no-key")) {
          setPartial("add a free Groq key to enable voice (see the README)");
          set("unsupported");
        } else {
          setPartial(`couldn't transcribe: ${msg.slice(0, 70)}`);
          set(enabled ? "idle" : "off");
        }
      }
    },
    [enabled],
  );

  const startRec = useCallback(async () => {
    if (!inTauri()) {
      set("unsupported");
      return;
    }
    cancelSpeech(); // barge-in: starting a new listen always kills whatever Praxis is saying
    try {
      // ─────────────────────────────────────────────────────────────────────
      // THE SAME CONSTRAINTS AS EVERY OTHER MIC LANE. This one asked for a bare
      // `{ audio: true }`, which opts OUT of the browser's echo canceller, noise
      // suppressor and gain control - so it heard Praxis's own TTS coming back
      // through the speakers, and it heard the room at full sensitivity.
      //
      // Echo cancellation is the one that matters most here: without it Atlas can
      // transcribe its OWN voice as a new instruction, which is two things
      // talking with only one person in the room. `realtimeTransport.ts:429` and
      // `useHybridSession.ts:745` already set all three; this lane was the outlier.
      // ─────────────────────────────────────────────────────────────────────
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      publishMicStream(stream); // HUD waveform taps the SAME stream (no 2nd mic)
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        stopTracks();
        recRef.current = null;
        if (blob.size > 0) void transcribe(blob, type);
        else set(enabled ? "idle" : "off");
      };
      rec.start();
      set("armed");
      setPartial("listening… click to send");
      if (maxTimer.current) clearTimeout(maxTimer.current);
      maxTimer.current = setTimeout(() => {
        if (statusRef.current === "armed") {
          try {
            rec.stop();
          } catch {
            /* already stopped */
          }
        }
      }, MAX_MS);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("NotAllowed") || msg.includes("Permission")) set("denied");
      else if (msg.includes("NotFound") || msg.includes("Devices")) set("no-mic");
      else set("unsupported");
    }
  }, [enabled, transcribe]);

  const stopRec = useCallback(() => {
    if (maxTimer.current) clearTimeout(maxTimer.current);
    try {
      recRef.current?.stop();
    } catch {
      /* noop */
    }
  }, []);

  /** Push-to-talk: start a recording, or send the one in progress. */
  const toggle = useCallback(() => {
    if (statusRef.current === "armed") stopRec();
    else if (statusRef.current === "idle" || statusRef.current === "unsupported") void startRec();
  }, [startRec, stopRec]);

  useEffect(() => {
    if (!enabled) {
      set("off");
      if (maxTimer.current) clearTimeout(maxTimer.current);
      try {
        recRef.current?.stop();
      } catch {
        /* noop */
      }
      stopTracks();
      recRef.current = null;
      return;
    }
    // Proactively check the Groq key so the UI shows "no key" immediately
    // instead of only after a failed recording attempt.
    set("idle");
    void checkSttReady().then((ready) => {
      if (!ready && statusRef.current === "idle") {
        setPartial("add a free Groq key to enable voice (see the README)");
        set("unsupported");
      }
    });
  }, [enabled]);

  // tear down on unmount
  useEffect(
    () => () => {
      if (maxTimer.current) clearTimeout(maxTimer.current);
      try {
        recRef.current?.stop();
      } catch {
        /* noop */
      }
      stopTracks();
    },
    [],
  );

  /** explicit start/stop for push-to-talk (hold the T key). start() is a no-op if already
   *  recording; stop() sends only if there's a recording in flight. */
  const start = useCallback(() => {
    if (statusRef.current !== "armed") void startRec();
  }, [startRec]);
  const stop = useCallback(() => {
    if (statusRef.current === "armed") stopRec();
  }, [stopRec]);

  return { status, partial, toggle, start, stop };
}
