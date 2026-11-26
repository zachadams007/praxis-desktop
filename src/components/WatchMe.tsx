/**
 * WatchMe - the "watch-me / screen-share" overlay for Praxis.
 *
 * Praxis WATCHES the owner's screen (he drives it, not Praxis) and answers questions about what he's
 * doing - the ChatGPT/Gemini live screen-share experience, built on our own capture → vision
 * loop. This is the OBSERVE inverse of the sovereign control path.
 *
 * Backend contract (src-tauri/src/watchme.rs):
 *   • invoke("watchme_start") - begin the capture stream + backend keeper.
 *   • invoke("watchme_stop") - stop watching, clear the buffer.
 *   • invoke("watchme_ask", {question}) - vision answer about the current screen; returns text.
 *   • event praxis://screen-frame  {b64,ts} - live frames (drives the "watching" thumbnail).
 *   • event praxis://watchme-answer {text} - the answer text (also returned by the invoke).
 *   • event praxis://watchme-speak  {audio} - TTS audio bytes for the answer (we play them).
 *
 * Mounted once in the MAIN (brain) window from src/App.tsx. Inert outside the Tauri shell -
 * the dynamic @tauri-apps imports fail silently in a plain browser, leaving a dormant button.
 *
 * ENTRY POINT (voice-UX restructure 2026-07-07): the old floating bottom-left chip is GONE.
 * Watch-me is now toggled from the right dock's Controls tab (RightDock ControlsTab). The
 * open/watching intent is shared via watchMeStore so the button (a different component) and
 * this panel stay in sync; this component still owns the real backend start/stop + vision Q&A.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useWatchMe } from "./watchMeStore";

interface QA {
  q: string;
  a: string;
}

/** Play answer audio (WAV/MP3 bytes) emitted by the backend. Best-effort; sniffs the container
 *  the same way voice/speak.ts does so WebView2 doesn't silently drop an MP3 labelled as WAV. */
function playAnswerAudio(bytes: number[]) {
  try {
    if (!bytes || bytes.length <= 44) return;
    const u8 = new Uint8Array(bytes);
    const isWav = u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46; // "RIFF"
    const isMp3 =
      (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) || // "ID3"
      (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0); // MPEG frame sync
    const mime = isWav ? "audio/wav" : isMp3 ? "audio/mpeg" : "audio/wav";
    const url = URL.createObjectURL(new Blob([u8], { type: mime }));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => URL.revokeObjectURL(url);
    void audio.play().catch(() => URL.revokeObjectURL(url));
  } catch {
    /* no audio sink - the text answer still shows */
  }
}

export function WatchMe() {
  // open/watching are SHARED (watchMeStore) so the Controls-tab button and this panel
  // stay in sync across components; the rest is local UI state owned here.
  const open = useWatchMe((s) => s.open);
  const setOpen = useWatchMe((s) => s.setOpen);
  const watching = useWatchMe((s) => s.watching);
  const setWatching = useWatchMe((s) => s.setWatching);
  const enabled = useWatchMe((s) => s.enabled);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [last, setLast] = useState<QA | null>(null);
  const [frame, setFrame] = useState<string | null>(null); // latest screen frame (base64 jpeg)
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the BACKEND capture is currently running, so the reconcile effect
  // below issues watchme_start/watchme_stop exactly once per transition (no double
  // starts, no leaked capture) even under rapid open/close/toggle.
  const startedRef = useRef(false);

  // Live frames → the "watching" thumbnail. Only listened to while watching is on.
  useEffect(() => {
    if (!watching) {
      setFrame(null);
      return;
    }
    let off: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ b64: string; ts: number }>("praxis://screen-frame", (e) => {
          if (e.payload?.b64) setFrame(e.payload.b64);
        }),
      )
      .then((f) => {
        // If the effect was torn down before listen() resolved, unlisten now -
        // otherwise `off` is set after cleanup already ran and the frame
        // listener leaks (re-registered every watch toggle).
        if (cancelled) f();
        else off = f;
      })
      .catch(() => {
        /* not in the Tauri shell */
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [watching]);

  // Answer audio from the backend TTS path → play it in the WebView (Rust has no audio sink).
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ audio: number[] }>("praxis://watchme-speak", (e) => {
          if (e.payload?.audio) playAnswerAudio(e.payload.audio);
        }),
      )
      .then((f) => {
        // Unlisten immediately if we unmounted before listen() resolved.
        if (cancelled) f();
        else off = f;
      })
      .catch(() => {
        /* not in the Tauri shell */
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // start/stop/toggle are pure INTENT setters now - the reconcile effect below drives
  // the real backend. This decouples the UI from the async start/stop so rapid clicks
  // (or a close mid-start) can't wedge the panel or leak a capture.
  const start = useCallback(() => {
    if (!useWatchMe.getState().enabled) return; // master breaker off - ignore
    setError(null);
    setOpen(true);
    setWatching(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [setOpen, setWatching]);

  const stop = useCallback(() => {
    setWatching(false);
  }, [setWatching]);

  const toggle = useCallback(() => {
    if (watching) stop();
    else start();
  }, [watching, start, stop]);

  // Reconcile the BACKEND capture to the desired state (watch intent AND master on).
  // Every route that changes watching/enabled - the panel button, the X, the RightDock
  // Controls toggle (via setOpen→watching reset), the CC breaker (cross-window
  // enabled), a stale-capture close - funnels through here, so start/stop happens once
  // and consistently. A failed start reverts intent + surfaces the error.
  useEffect(() => {
    let cancelled = false;
    const desired = watching && enabled;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (desired && !startedRef.current) {
          startedRef.current = true;
          await invoke("watchme_start");
        } else if (!desired && startedRef.current) {
          startedRef.current = false;
          await invoke("watchme_stop");
        }
      } catch (e) {
        if (!cancelled && desired) {
          startedRef.current = false;
          setError(String(e));
          setWatching(false); // couldn't start - don't pretend we're watching
        }
        /* stop failure: the UI is already off; nothing to surface */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [watching, enabled, setWatching]);

  // Safety net: if the panel ever unmounts (app/window teardown) with a live capture,
  // stop it so the screen grabber doesn't outlive the UI.
  useEffect(() => {
    return () => {
      if (startedRef.current) {
        startedRef.current = false;
        void import("@tauri-apps/api/core")
          .then(({ invoke }) => invoke("watchme_stop"))
          .catch(() => {});
      }
    };
  }, []);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const a = await invoke<string>("watchme_ask", { question: q });
      setLast({ q, a });
      setQuestion("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [question, busy]);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void ask();
      }
    },
    [ask],
  );

  return (
    <>
      <WatchMeStyles />

      {/* The floating bottom-left chip is retired - Watch-me is opened from the right
          dock's Controls tab now (RightDock ControlsTab → watchMeStore). Only the panel
          mounts here; it renders off the shared open/watching state. */}

      <AnimatePresence>
        {open && (
          <motion.div
            className="wm-panel"
            initial={{ y: 16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 12, opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
          >
            <header className="wm-head">
              <span className="wm-sigil" data-on={watching ? "1" : "0"} aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <div className="wm-titles">
                <span className="wm-kicker">Screen share · observe</span>
                <strong className="wm-title">{watching ? "Praxis is watching" : "Watch-me"}</strong>
              </div>
              <button className="wm-x" onClick={() => setOpen(false)} title="Collapse">
                ✕
              </button>
            </header>

            {/* Live thumbnail of what Praxis sees. */}
            <div className="wm-view" data-on={watching ? "1" : "0"}>
              {frame ? (
                <img className="wm-frame" src={`data:image/jpeg;base64,${frame}`} alt="Live screen" />
              ) : (
                <div className="wm-view-empty">{watching ? "Capturing…" : "Not watching"}</div>
              )}
              {watching && <span className="wm-live">● LIVE</span>}
            </div>

            <div className="wm-toggle-row">
              <button className="wm-toggle" data-on={watching ? "1" : "0"} onClick={toggle}>
                {watching ? "Stop watching" : "Start watching"}
              </button>
            </div>

            {/* Ask box. */}
            <div className="wm-ask">
              <input
                ref={inputRef}
                className="wm-input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={onKey}
                placeholder="Ask about what's on your screen…"
                disabled={busy}
              />
              <button className="wm-send" onClick={() => void ask()} disabled={busy || !question.trim()}>
                {busy ? "…" : "Ask"}
              </button>
            </div>

            {error && <p className="wm-error">{error}</p>}

            <AnimatePresence>
              {last && (
                <motion.div
                  className="wm-answer"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <span className="wm-answer-q">{last.q}</span>
                  <p className="wm-answer-a">{last.a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Self-contained glass styling, matching the brain window's veto/operator language. */
function WatchMeStyles() {
  return (
    <style>{`
      .wm-panel {
        position: fixed; left: 18px; bottom: 18px; z-index: 119;
        width: min(360px, calc(100vw - 36px));
        padding: 14px 15px 15px; border-radius: 18px; color: #eaf2ff;
        --wm-accent: #2fd0c6;
        border: 1px solid color-mix(in srgb, var(--wm-accent) 24%, rgba(255,255,255,0.1));
        background: linear-gradient(168deg, color-mix(in srgb, var(--wm-accent) 7%, rgba(6,10,22,0.9)), rgba(6,10,22,0.9) 66%);
        -webkit-backdrop-filter: blur(26px) saturate(1.25); backdrop-filter: blur(26px) saturate(1.25);
        box-shadow: 0 40px 100px -34px rgba(0,0,0,0.92),
                    0 0 56px -24px color-mix(in srgb, var(--wm-accent) 55%, transparent),
                    inset 0 1px 0 rgba(255,255,255,0.06);
      }
      .wm-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .wm-sigil { display: inline-flex; gap: 3px; align-items: flex-end; height: 16px; }
      .wm-sigil i { width: 3px; border-radius: 2px; background: rgba(220,232,255,0.4); }
      .wm-sigil[data-on="1"] i {
        background: var(--wm-accent); box-shadow: 0 0 10px color-mix(in srgb, var(--wm-accent) 80%, transparent);
        animation: wm-pulse 1.2s ease-in-out infinite;
      }
      .wm-sigil i:nth-child(1) { height: 7px; animation-delay: 0s; }
      .wm-sigil i:nth-child(2) { height: 14px; animation-delay: 0.15s; }
      .wm-sigil i:nth-child(3) { height: 10px; animation-delay: 0.3s; }
      @keyframes wm-pulse { 0%,100% { opacity: 0.55; transform: scaleY(0.8); } 50% { opacity: 1; transform: scaleY(1); } }
      .wm-titles { display: flex; flex-direction: column; line-height: 1.2; margin-right: auto; }
      .wm-kicker { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(220,232,255,0.5); }
      .wm-title { font-size: 15px; font-weight: 650; }
      .wm-x {
        background: none; border: none; color: rgba(220,232,255,0.5); cursor: pointer;
        font-size: 13px; padding: 4px; line-height: 1; border-radius: 6px;
      }
      .wm-x:hover { color: #eaf2ff; background: rgba(255,255,255,0.06); }

      .wm-view {
        position: relative; aspect-ratio: 16 / 9; width: 100%; border-radius: 12px; overflow: hidden;
        background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); margin-bottom: 11px;
      }
      .wm-frame { width: 100%; height: 100%; object-fit: cover; display: block; }
      .wm-view-empty {
        position: absolute; inset: 0; display: grid; place-items: center;
        font-size: 12px; color: rgba(220,232,255,0.4);
      }
      .wm-live {
        position: absolute; top: 8px; left: 8px; font-size: 9.5px; font-weight: 700;
        letter-spacing: 0.08em; padding: 3px 7px; border-radius: 999px; color: #2fd0c6;
        background: rgba(4,8,20,0.7); border: 1px solid color-mix(in srgb, #2fd0c6 40%, transparent);
      }

      .wm-toggle-row { margin-bottom: 11px; }
      .wm-toggle {
        width: 100%; padding: 9px; border-radius: 10px; cursor: pointer;
        font-size: 12.5px; font-weight: 600; color: #eaf2ff;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .wm-toggle:hover { background: rgba(255,255,255,0.08); }
      .wm-toggle[data-on="1"] {
        border-color: color-mix(in srgb, #ff5c47 45%, transparent);
        background: color-mix(in srgb, #ff5c47 12%, rgba(255,255,255,0.05));
      }

      .wm-ask { display: flex; gap: 8px; }
      .wm-input {
        flex: 1; min-width: 0; padding: 10px 12px; border-radius: 10px;
        font-size: 13px; color: #eaf2ff;
        background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.12);
        outline: none; transition: border-color 0.15s ease;
      }
      .wm-input:focus { border-color: color-mix(in srgb, var(--wm-accent) 55%, transparent); }
      .wm-input::placeholder { color: rgba(220,232,255,0.38); }
      .wm-input:disabled { opacity: 0.6; }
      .wm-send {
        padding: 10px 16px; border-radius: 10px; cursor: pointer; border: none;
        font-size: 13px; font-weight: 700; color: #041018;
        background: linear-gradient(180deg, color-mix(in srgb, var(--wm-accent) 92%, white), var(--wm-accent));
        box-shadow: 0 10px 24px -12px color-mix(in srgb, var(--wm-accent) 80%, transparent);
        transition: transform 0.12s ease, opacity 0.15s ease;
      }
      .wm-send:hover:not(:disabled) { transform: translateY(-1px); }
      .wm-send:disabled { opacity: 0.45; cursor: default; }

      .wm-error {
        margin: 10px 0 0; font-size: 11.5px; line-height: 1.4;
        color: #ff9a8a; word-break: break-word;
      }
      .wm-answer {
        margin-top: 12px; padding: 11px 12px; border-radius: 12px;
        background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.07);
      }
      .wm-answer-q {
        display: block; font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase;
        color: rgba(220,232,255,0.45); margin-bottom: 5px;
      }
      .wm-answer-a { margin: 0; font-size: 13.5px; line-height: 1.5; color: #eaf2ff; }

      @media (prefers-reduced-motion: reduce) {
        .wm-sigil[data-on="1"] i { animation: none; }
      }
    `}</style>
  );
}
