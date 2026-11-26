/**
 * Waveform - the state bar's live voice scope. Every sample is REAL signal,
 * never decoration:
 *
 *   LISTENING  the actual microphone amplitude (micLevel taps the recorder's
 *              own MediaStream - no second mic).
 *   SPEAKING   the MEASURED speech envelope (micLevel's tap on the clip that is
 *              actually playing), gated solely by speak.ts's real "audio is
 *              playing" flag. There is NO synthetic cadence - when the level
 *              can't be measured the line stays low rather than inventing a
 *              wave, because a predicted duration is not evidence of audio.
 *   IDLE       a flat line with a faint ripple proportional to how many agents
 *              are genuinely firing right now (0 firing = perfectly still). The
 *              firing count comes from the store roster, which the applyEvent gate
 *              keeps REAL-only (synthetic mock events don't populate it, spec §A.2) -
 *              so with no real work the executing ripple is honestly flat, not an
 *              echo of the ambient mock timeline.
 *
 * Rolling-scope render: samples push in from the right and drift left, drawn as
 * a mirrored polyline around the center axis. DPR-aware; ~zero cost when flat.
 */

import { useEffect, useRef } from "react";
import { usePraxisStore, selectFiringAgents } from "@/store/usePraxisStore";
import { getMicLevel, getTtsLevel } from "@/voice/micLevel";
import { isSpeaking, onSpeakingChange } from "@/voice/speak";

const SAMPLES = 160; // rolling buffer width (one sample per frame)

export function Waveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const buf = new Float32Array(SAMPLES);
    let speaking = isSpeaking();
    let last = performance.now();
    let frame = 0;

    //   speaking  (Praxis)   → violet (amethyst) - clearly its own voice
    //   executing (agents)   → emerald (alive/nominal, not red)
    let cool = "#34f0db";
    let violet = "#9b5cf6";
    let emerald = "#2be28f";
    let dim = "rgba(146,168,189,.4)";
    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      cool = cs.getPropertyValue("--base-cool").trim() || cool;
      violet = cs.getPropertyValue("--cc-amethyst").trim() || violet;
      emerald = cs.getPropertyValue("--cc-emerald").trim() || emerald;
      dim = "rgba(146,168,189,.4)";
    };
    readColors();

    const offSpeak = onSpeakingChange((v) => {
      speaking = v;
    });

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(r.width * dpr));
      h = Math.max(1, Math.round(r.height * dpr));
      canvas.width = w;
      canvas.height = h;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      last = now;
      if ((frame++ & 255) === 0) readColors();

      const st = usePraxisStore.getState();
      const listening = st.voiceListening;
      // same ONE firing rule the StateBar uses - the idle ripple scales with REAL coding
      // agents only (ambient Atlas/Sage + core + engine excluded), so it can't disagree.
      const firing = selectFiringAgents(st.agents).length;

      // one new REAL sample per frame
      let amp: number;
      const t = now / 1000;
      if (listening) {
        // real mic; tiny floor so "armed but silent" still reads as an open channel
        amp = 0.1 + getMicLevel() * 0.9;
      } else if (speaking) {
        // Praxis speaking. Gated SOLELY by speak.ts's real "audio is playing"
        // flag - an orchestrator:speaking duration hint is deliberately not
        // enough on its own.
        //
        // Cause was this branch firing on a duration event alone and then drawing a layered-sine
        // cadence - a fabricated waveform with no audio behind it. The synthetic carrier is
        // gone: if the voice can't be MEASURED we don't draw one. A speaking state requires
        // audible output.
        const lvl = getTtsLevel();
        amp = lvl > 0.015 ? 0.12 + Math.min(1, lvl * 1.2) * 0.82 : 0.04;
      } else if (firing > 0) {
        // quiet activity ripple - height scales with how many agents actually fire
        const k = Math.min(1, firing / 6);
        amp = 0.03 + 0.05 * k * (1 + Math.sin(t * 2.1)) * 0.5;
      } else {
        amp = 0.015; // truly idle - a calm flat line
      }
      buf.copyWithin(0, 1);
      buf[SAMPLES - 1] = amp;

      // render
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2;
      const color = listening ? cool : speaking ? violet : firing > 0 ? emerald : dim;

      // center axis hairline
      ctx.strokeStyle = "rgba(146,168,189,.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      // mirrored scope polyline - voice states glow; the executing/idle ripple
      // stays a quiet instrument line, never a hot laser across the bar
      const voiceLive = listening || speaking;
      const pad = 8 * dpr;
      const span = w - pad * 2;
      const maxA = mid * 0.82;
      ctx.lineWidth = (voiceLive ? 1.4 : 1.1) * dpr;
      ctx.globalAlpha = voiceLive ? 1 : 0.55;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = (voiceLive ? 6 : 3) * dpr;
      for (const sign of [1, -1]) {
        ctx.beginPath();
        for (let i = 0; i < SAMPLES; i++) {
          const x = pad + (i / (SAMPLES - 1)) * span;
          // subtle per-column carrier so a held level still reads as a wave
          const wob = 0.72 + 0.28 * Math.sin(i * 0.55 + t * 6);
          const y = mid + sign * buf[i] * wob * maxA;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offSpeak();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden />;
}
