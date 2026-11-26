/**
 * useQaFindings - headless React hook that surfaces QA-eyes findings as they stream in.
 *
 * The Rust `qa_inspect` command emits one `praxis://hermes-event` per finding, tagged with
 * `session_id: "qa-eyes"` and `subagent_id: "a.lens"` (the Lens QA agent). Those same frames
 * already drive the brain viz through `useRealEvents`; this hook is a SEPARATE, additive
 * listener that keeps a plain list of the findings so a UI surface can render them later.
 *
 * Tonight this is intentionally headless - it's exported for a future Command Center panel to
 * consume, but nothing renders it yet (the to-do surface, src/command/Todo.tsx, is owned
 * elsewhere and untouched). Inert outside the Tauri shell: it simply returns an empty list.
 *
 * The `text` on each event is the human-readable finding the Rust side formats as
 * `[severity] element: issue` (or a `QA <title>: no visual defects found` heartbeat), so this
 * hook parses that back into a structured `QaFindingEvent` while also keeping the raw text.
 */

import { useEffect, useState } from "react";
import type { QaSeverity } from "./qaClient";

/** A single QA finding as received over the event bus (one per emitted Hermes frame). */
export interface QaFindingEvent {
  /** The UI element/region (parsed from the formatted text; "" for the clean-pass heartbeat). */
  element: string;
  /** The issue description (or the full heartbeat line for a clean pass). */
  issue: string;
  /** Parsed severity; "low" when the text isn't a `[sev] ...` finding (e.g. the heartbeat). */
  severity: QaSeverity;
  /** The raw text exactly as emitted (useful for debugging / verbatim display). */
  raw: string;
  /** Client-side receipt time (ms epoch) - for ordering / relative timestamps in the UI. */
  at: number;
}

/** Minimal shape of the Hermes event payload we care about (matches the Rust emit fields). */
interface HermesEventPayload {
  kind: string;
  session_id: string;
  text?: string | null;
  subagent_id?: string | null;
}

/** The `session_id` the Rust QA command stamps on every finding frame. */
const QA_SESSION_ID = "qa-eyes";
/** The QA agent id (Lens) the findings are attributed to. */
const QA_AGENT_ID = "a.lens";

function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** Parse `[severity] element: issue` back into fields. Falls back gracefully for the
 *  clean-pass heartbeat ("QA <title>: no visual defects found") and any other shape. */
export function parseFindingText(text: string): { element: string; issue: string; severity: QaSeverity } {
  const m = /^\[(high|med|low)\]\s*([^:]+):\s*(.*)$/i.exec(text.trim());
  if (m) {
    const sev = m[1].toLowerCase();
    const severity: QaSeverity = sev === "high" ? "high" : sev === "med" ? "med" : "low";
    return { element: m[2].trim(), issue: m[3].trim(), severity };
  }
  return { element: "", issue: text.trim(), severity: "low" };
}

export interface UseQaFindings {
  /** Findings received so far, most-recent last. */
  findings: QaFindingEvent[];
  /** Clear the accumulated list (e.g. before kicking off a fresh pass). */
  clear: () => void;
}

/**
 * Listen for QA-eyes findings on `praxis://hermes-event` and expose them.
 * @param max Cap the retained list so a long-running session doesn't grow unbounded.
 */
export function useQaFindings(max = 200): UseQaFindings {
  const [findings, setFindings] = useState<QaFindingEvent[]>([]);

  useEffect(() => {
    if (!inTauri()) return; // browser / headless: no event bus, stay empty

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<HermesEventPayload>("praxis://hermes-event", (e) => {
          const p = e.payload;
          // Only our QA frames: stamped with the qa-eyes session AND the Lens agent.
          if (p.session_id !== QA_SESSION_ID || p.subagent_id !== QA_AGENT_ID) return;
          const text = (p.text ?? "").trim();
          if (!text) return;
          const { element, issue, severity } = parseFindingText(text);
          setFindings((prev) => {
            const next = [...prev, { element, issue, severity, raw: text, at: Date.now() }];
            return next.length > max ? next.slice(next.length - max) : next;
          });
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        /* not in the Tauri shell - nothing to listen to */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [max]);

  const clear = () => setFindings([]);
  return { findings, clear };
}
