import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { installDiagTap } from "@/lib/diagTap";
import { VoiceStateSatellite, useBroadcastVoiceState } from "@/voice/VoiceStateIndicator";
import { useWindowHeartbeat } from "@/shared/useWindowHeartbeat";

// Serialize transitions so a slow start cannot finish after a newer stop.
let operations = Promise.resolve();
function sendCommand(command: "voice_pill_track" | "voice_pill_resize", args: { on: boolean } | { height: number }): void {
  operations = operations.then(() => invoke<void>(command, args)).catch((error: unknown) => {
    console.error("Voice pill command failed", error);
  });
}
const setTracking = (on: boolean) => sendCommand("voice_pill_track", { on });

export function VoicePill() {
  useWindowHeartbeat();
  const content = useRef<HTMLDivElement>(null);
  const state = useBroadcastVoiceState();
  const active = state !== null;
  useEffect(() => { setTracking(active); }, [active]);
  useEffect(() => () => setTracking(false), []);
  useEffect(() => {
    if (!active) return;
    const pill = content.current?.querySelector<HTMLElement>(".vsi-root");
    if (!pill) return;
    let lastHeight = 0;
    const resize = () => {
      // offsetHeight rounds CSS subpixels; reserve one pixel to avoid clipping.
      const height = Math.max(72, pill.offsetHeight + 1);
      if (height === lastHeight) return;
      lastHeight = height;
      sendCommand("voice_pill_resize", { height });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(pill);
    resize();
    return () => observer.disconnect();
  }, [active]);
  return <div ref={content}><VoiceStateSatellite overlay /></div>;
}

installDiagTap();
createRoot(document.getElementById("root")!).render(<VoicePill />);
