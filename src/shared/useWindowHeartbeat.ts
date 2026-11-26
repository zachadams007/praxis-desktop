/**
 * useWindowHeartbeat - the frontend half of the "always awake" contract.
 *
 * Every Praxis window calls this once at its App root.
 *
 * The interval deliberately does NOT pause when the tab is hidden: a hidden
 * window that stops beating is indistinguishable from a dead one, and the
 * watchdog only acts on visible windows anyway.
 *
 * This hook ALSO piggybacks JS-heap telemetry (every 30s, where the Chromium
 * `performance.memory` extension exists) onto the same lifecycle so no window
 * needs separate wiring: it invokes `memory_telemetry` with used/limit heap in MB,
 * which Rust appends to memory-telemetry.log. That log is the data to finally trace
 * the recurring WebView2 "Out of Memory" crash (renderer climbing to ~2.6GB) to the
 * window and growth curve responsible.
 */
import { useEffect } from 'react';

const BEAT_MS = 15_000;
const MEM_MS = 30_000;

/** Non-standard Chromium heap gauge (Blink/WebView2 only); absent = telemetry skipped. */
interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function useWindowHeartbeat(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let stop = false;
    let beatTimer: number | undefined;
    let memTimer: number | undefined;
    void (async () => {
      try {
        const [{ invoke }, { getCurrentWebviewWindow }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('@tauri-apps/api/webviewWindow'),
        ]);
        const label = getCurrentWebviewWindow().label;
        const beat = () => void invoke('window_heartbeat', { label }).catch(() => {});
        beat();
        if (!stop) beatTimer = window.setInterval(beat, BEAT_MS);

        const sampleMemory = () => {
          const mem = (performance as unknown as { memory?: PerfMemory }).memory;
          if (!mem) return;
          const usedMb = mem.usedJSHeapSize / (1024 * 1024);
          const totalMb = mem.jsHeapSizeLimit / (1024 * 1024);
          void invoke('memory_telemetry', { label, usedMb, totalMb }).catch(() => {});
        };
        sampleMemory();
        if (!stop) memTimer = window.setInterval(sampleMemory, MEM_MS);
      } catch {
        /* non-Tauri or API unavailable - no heartbeat, watchdog stays inert */
      }
    })();
    return () => {
      stop = true;
      if (beatTimer !== undefined) window.clearInterval(beatTimer);
      if (memTimer !== undefined) window.clearInterval(memTimer);
    };
  }, []);
}
