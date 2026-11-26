/**
 * Flight Deck window entry - renders the v3 deck (1:1 Claude Design port,
 * fully live; see deck/DeckApp.tsx). The v2 functional shell this replaced
 * lives on in components/hooks for its still-shared pieces (api, types,
 * sendToAgent); unused v2 views are dead code slated for cleanup once the
 * v3 deck has survived a few days of real use.
 */
import DeckApp from './deck/DeckApp';
import { useWindowHeartbeat } from '@/shared/useWindowHeartbeat';
import { useWindowShortcuts } from '@/shared/useWindowShortcuts';
import { VoiceStateSatellite } from "@/voice/VoiceStateIndicator";

import { useRestoreListener } from "@/shared/restore";
import { useLiveOnResume } from "@/shared/liveOnResume";
export default function App() {
  // Restore (Controls tab) reloads every window; this window must hear it.
  useRestoreListener();
  // Re-measure after a gap: a cached reading is a fact with a shelf life.
  useLiveOnResume();
  useWindowHeartbeat();
  useWindowShortcuts(); // Ctrl+Alt+1-4 jump windows · Ctrl+Alt+←/→ cycle
  return (
    <>
      <DeckApp />
      {/* The voice-state pill follows whichever Praxis window the owner is working in.
          A SATELLITE: state only, no microphone. Only the window that owns the
          conversation runs the engine, because three more mounted engines would be
          three more mics rather than one assistant visible in four places. */}
      <VoiceStateSatellite />
    </>
  );
}
