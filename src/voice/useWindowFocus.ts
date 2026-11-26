/**
 * useWindowFocus - true while THIS window has OS focus (and isn't hidden).
 *
 * Voice uses it so only the focused Praxis window runs its microphone: with the brain,
 * the Command Center and the Memory Galaxy all able to listen, exactly one of them should
 * own the mic at a time, or a single "Praxis, open the journey" would fire two or three
 * times. The OS guarantees at most one focused window, so focus-gating each recognizer is
 * all the coordination we need - no cross-window locks.
 */
import { useEffect, useState } from "react";

export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document === "undefined" ? true : document.hasFocus() && !document.hidden,
  );

  useEffect(() => {
    const sync = () => setFocused(document.hasFocus() && !document.hidden);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return focused;
}
