/**
 * A tiny synchronous pub/sub for the live event firehose.
 *
 * Why not Zustand for everything? Timeline events fire many times per second and
 * drive per-frame GPU animation (pulses, node glow, agent travel). Pushing those
 * through React state would thrash re-renders. So:
 *
 *   - This bus carries the high-frequency firehose straight to the 3D layer, which
 *     keeps mutable buffers (refs / typed arrays) and reads them in useFrame.
 *   - A throttled reducer also folds events into the Zustand store for the *discrete*
 *     UI (agent roster, task status, the "now firing" ticker) that updates at human
 *     rate and is fine to re-render.
 */

import type { PraxisEvent } from "./schema";

type Handler = (e: PraxisEvent) => void;

const handlers = new Set<Handler>();
const origin = `praxis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const RELAY = "praxis://orchestrator-event";
let seq = 0;
let send: ((payload: RelayEnvelope) => Promise<void>) | undefined;
const pending: RelayEnvelope[] = [];
interface RelayEnvelope { origin: string; seq: number; event: PraxisEvent }
let incoming = Promise.resolve();
let outgoing = Promise.resolve();

// All windows import the bus. Only explicitly orchestrator-owned events leave it;
// receiving uses emit(), so it can never echo back through this transport.
if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
  void import("@tauri-apps/api/event").then(async ({ emit, listen }) => {
    const seen = new Map<string, number>();
    await listen<RelayEnvelope>(RELAY, ({ payload }) => {
      if (!payload || payload.origin === origin || !payload.event || payload.seq <= (seen.get(payload.origin) ?? 0)) return;
      seen.set(payload.origin, payload.seq);
      incoming = incoming.then(async () => {
        const e = { ...payload.event, t: performance.now() / 1000 };
        if (e.missionNode) {
          const { usePraxisStore } = await import("@/store/usePraxisStore");
          usePraxisStore.getState().receiveMissionNode(e.missionNode);
        }
        eventBus.emit(e);
      }).catch((err) => console.error("[mission events] receive failed", err));
    });
    send = (payload) => {
      const sent = outgoing.then(() => emit(RELAY, payload));
      outgoing = sent.catch(() => {});
      return sent;
    };
    for (const payload of pending.splice(0)) void send(payload).catch((err) => console.error("[mission events] queued broadcast failed", err));
  }).catch((err) => console.error("[mission events] relay unavailable", err));
}


export const eventBus = {
  subscribe(fn: Handler): () => void {
    handlers.add(fn);
    return () => handlers.delete(fn);
  },
  emitOrchestrator(e: PraxisEvent): void {
    const event = { ...e, orchestrator: true };
    eventBus.emit(event);
    const payload = { origin, seq: ++seq, event };
    if (send) void send(payload).catch((err) => console.error("[mission events] broadcast failed", err));
    else if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) pending.push(payload);
  },
  emit(e: PraxisEvent): void {
    for (const fn of handlers) fn(e);
  },
};
