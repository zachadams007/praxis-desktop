import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const WAKE_PHRASE = "praxis wake up";

export function usePraxisWake(onWake: () => void) {
  const stableOnWake = useCallback(onWake, []);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Hotkey path: Rust registers Ctrl+Shift+Space globally → emits "praxis:wake"
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<null>("praxis:wake", () => stableOnWake())
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event API unavailable - browser/dev keeps the local wake path */
      });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [stableOnWake]);

  // Voice path: continuously listen for "Praxis, wake up"
  useEffect(() => {
    const SR: typeof SpeechRecognition | undefined =
      window.SpeechRecognition ??
      (window as { webkitSpeechRecognition?: typeof SpeechRecognition })
        .webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    recognition.onresult = async (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase().trim();
        if (transcript.includes(WAKE_PHRASE)) {
          try {
            const win = getCurrentWindow();
            await win.show();
            await win.unminimize();
            await win.setFocus();
          } catch {
            // desktop APIs unavailable in browser dev mode - ignore
          }
          stableOnWake();
        }
      }
    };

    // Auto-restart so listening is continuous; guarded by ref to avoid restart after unmount
    recognition.onend = () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch {
          /* already starting */
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        // Mic permission denied - degrade gracefully to hotkey-only
        recognitionRef.current = null;
      }
    };

    try {
      recognition.start();
    } catch {
      /* ignore if already running */
    }

    return () => {
      recognitionRef.current = null;
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    };
  }, [stableOnWake]);
}
