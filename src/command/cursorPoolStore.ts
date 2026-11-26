import { useEffect, useState } from "react";
import { visibleInterval } from "@/shared/visibility";

export interface CursorPoolState {
  models_pool_pct: number | null;
  api_pool_pct: number | null;
  resets_at_ms: number | null;
  exhausted: boolean;
  api_pool_allowed: boolean;
  effective_pct: number | null;
  note: string;
}

export function useCursorPoolState(): CursorPoolState | null {
  const [state, setState] = useState<CursorPoolState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const next = await invoke<CursorPoolState>("cursor_pool_state");
        if (!cancelled) setState(next);
      } catch {
        if (!cancelled) setState(null);
      }
    };
    void refresh();
    const stop = visibleInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return state;
}
