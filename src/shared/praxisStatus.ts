import { useEffect, useState } from "react";

export const PRAXIS_STATUS_EVENT = "praxis://status";
const CACHE_KEY = "praxis.status.v1";

export type PraxisStatusState = "idle" | "listening" | "acting" | "executing" | "speaking";

export interface PraxisStatusPayload {
  state: PraxisStatusState;
  detail?: string;
  ts: number;
}

export function inPraxisTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function keyOf(p: Pick<PraxisStatusPayload, "state" | "detail">): string {
  return `${p.state}\u0000${p.detail ?? ""}`;
}

function coerceStatusPayload(v: unknown): PraxisStatusPayload | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<PraxisStatusPayload>;
  if (
    p.state !== "idle" &&
    p.state !== "listening" &&
    p.state !== "acting" &&
    p.state !== "executing" &&
    p.state !== "speaking"
  ) {
    return null;
  }
  return {
    state: p.state,
    detail: typeof p.detail === "string" ? p.detail : undefined,
    ts: typeof p.ts === "number" ? p.ts : Date.now(),
  };
}

export function readCachedPraxisStatus(): PraxisStatusPayload | null {
  if (!inPraxisTauri()) return null;
  try {
    return coerceStatusPayload(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"));
  } catch {
    return null;
  }
}

let lastPublishedKey = "";

export async function publishPraxisStatus(
  next: Pick<PraxisStatusPayload, "state"> & Partial<Pick<PraxisStatusPayload, "detail" | "ts">>,
): Promise<void> {
  if (!inPraxisTauri()) return;
  const payload: PraxisStatusPayload = { state: next.state, detail: next.detail, ts: next.ts ?? Date.now() };
  const key = keyOf(payload);
  if (key === lastPublishedKey) return;
  lastPublishedKey = key;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* cache is best-effort; the event is the live sync path */
  }
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(PRAXIS_STATUS_EVENT, payload);
  } catch {
    /* plain browser / bridge unavailable */
  }
}

export function usePraxisStatus(): PraxisStatusPayload | null {
  const [status, setStatus] = useState<PraxisStatusPayload | null>(() => readCachedPraxisStatus());
  useEffect(() => {
    if (!inPraxisTauri()) return;
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<PraxisStatusPayload>(PRAXIS_STATUS_EVENT, (e) => {
          const payload = coerceStatusPayload(e.payload);
          if (payload) setStatus(payload);
        }),
      )
      .then((f) => {
        off = f;
      })
      .catch(() => {
        /* not inside the Tauri shell */
      });
    return () => off?.();
  }, []);
  return status;
}
