/**
 * throttle - keep a streaming answer from re-parsing on every token.
 *
 * Markdown parsing and re-layout on each of dozens of deltas a second is what makes
 * streamed text shimmer. This lets the first change through at once, then at most one
 * update per `minMs`, and always delivers the LAST value (trailing edge) so the finished
 * text is never left a few tokens short.
 */

import { useEffect, useRef, useState } from "react";

/** Milliseconds to wait before the next update may run. Pure, so the timing is unit-tested. */
export function throttleDelay(now: number, lastRunAt: number, minMs: number): number {
  return Math.max(0, lastRunAt + minMs - now);
}

/** The default re-parse cadence while text streams: ~11 updates a second. */
export const STREAM_REPARSE_MS = 90;

/**
 * `text`, delivered at most once per `minMs` while `enabled`; passed straight through
 * otherwise (so a finished or historical message costs no extra render).
 */
export function useThrottledText(text: string, enabled: boolean, minMs: number = STREAM_REPARSE_MS): string {
  const [shown, setShown] = useState(text);
  const lastRun = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      window.clearTimeout(timer.current);
      setShown(text);
      return undefined;
    }
    const wait = throttleDelay(Date.now(), lastRun.current, minMs);
    window.clearTimeout(timer.current);
    if (wait === 0) {
      lastRun.current = Date.now();
      setShown(text);
    } else {
      timer.current = window.setTimeout(() => {
        lastRun.current = Date.now();
        setShown(text);
      }, wait);
    }
    return () => window.clearTimeout(timer.current);
  }, [text, enabled, minMs]);

  return enabled ? shown : text;
}
