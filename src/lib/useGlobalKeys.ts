/**
 * useGlobalKeys - one place for the app's keyboard verbs.
 *
 *   J        flip brain ⇄ journey (the morph)
 *   1–N      jump to that initiative (brain: fly to its cluster · journey: its lane)
 *   Esc      stop Praxis talking (barge-in) + overview (or close the dump box if it's open)
 *   D        open/close the brain-dump box
 *   O        open/close the Orchestrator panel
 *   V        toggle the Praxis voice (wake-word listening + spoken replies)
 *
 * JOURNEY-mode navigation (three distinct axes - never overloaded):
 *   ← / →    TIME - sweep the camera through the whole roadmap, past ↔ future,
 *            one column further each press. This is the through-line; it does
 *            NOT hop task-to-task.
 *   ↑ / ↓    AREA - bump straight UP/DOWN to the adjacent initiative row,
 *            keeping the current time position AND zoom (a pure vertical glide
 *            between lanes - never a sideways jump through time, never a rezoom).
 *   [ / ]    TASK - hop milestone-to-milestone within the focused lane (detail).
 *
 * Time scrub reuses the SAME store hook (stepJourney → scrubTime) the gesture
 * swipe calls, so input modes stay co-equal. Typing in any field is never hijacked.
 */

import { useEffect } from "react";
import { usePraxisStore } from "@/store/usePraxisStore";
import { areaOrder } from "@/brain/framings";
import { cancelSpeech } from "@/voice/speak";

export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" || // leva's theme/navMode dropdowns
          t.isContentEditable);
      const st = usePraxisStore.getState();

      // Barge-in: Esc ALWAYS stops Praxis talking first, regardless of focus
      // target or dump-box state - typing in a field or having a panel open
      // should never block the one universal "shut up" key.
      if (e.key === "Escape") cancelSpeech();

      if (typing) {
        if (e.key === "Escape") st.setDumpOpen(false);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // while the dump box is open, letters belong to the (about-to-focus)
      // textarea - only Escape acts globally, so a fast typist can't morph
      // the scene with a "j" in the 60ms before focus lands
      if (st.dumpOpen) {
        if (e.key === "Escape") st.setDumpOpen(false);
        return;
      }

      const journey = st.viewMode === "journey";

      switch (e.key) {
        case "j":
        case "J":
          st.toggleViewMode();
          break;
        case "d":
        case "D":
          st.setDumpOpen(!st.dumpOpen);
          break;
        case "o":
        case "O":
          st.setChatOpen(!st.chatOpen);
          break;
        case "v":
        case "V":
          // tap V = start listening / send (the LauncherDock mic controller owns the engine);
          // hold T = push-to-talk. Both go through the one Voice control, no corner orb.
          window.dispatchEvent(new Event("praxis:voice-toggle"));
          break;

        // ← / → - TIME: move through the roadmap, past ↔ future (NOT task-hop)
        case "ArrowRight":
          if (journey) {
            e.preventDefault();
            st.scrubTime(1);
          }
          break;
        case "ArrowLeft":
          if (journey) {
            e.preventDefault();
            st.scrubTime(-1);
          }
          break;

        // ↑ / ↓ - AREA: bump up/down to the adjacent lane (keeps time + zoom)
        case "ArrowUp":
          if (journey) {
            e.preventDefault();
            st.switchArea(-1);
          }
          break;
        case "ArrowDown":
          if (journey) {
            e.preventDefault();
            st.switchArea(1);
          }
          break;

        // [ / ] - TASK: hop milestone-to-milestone within the focused lane
        case "[":
          if (journey) {
            e.preventDefault();
            st.hopTask(-1);
          }
          break;
        case "]":
          if (journey) {
            e.preventDefault();
            st.hopTask(1);
          }
          break;

        case "Escape":
          if (st.dumpOpen) st.setDumpOpen(false);
          else st.focus(null); // back to the overview framing
          break;

        default:
          // number keys 1–N jump to that initiative (live count = areaOrder length)
          if (/^[1-9]$/.test(e.key)) {
            const id = areaOrder()[Number(e.key) - 1];
            if (id) (journey ? st.focusAreaLane : st.focus)(id);
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
