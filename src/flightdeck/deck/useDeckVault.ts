/**
 * Deck prompt vault - thin client over the GLOBAL prompt-vault backend
 * (src-tauri/src/prompt_vault.rs: pv_list/pv_add/pv_update/pv_remove/
 * pv_record_outcome + praxis://pv-update). One shared vault across the whole
 * app; the deck scopes entries to an entity (praxis / agent:x / lane:x /
 * repo:x / session:x) with an `fd:<entKey>` tag. Queue order is a UI
 * preference kept in localStorage (the vault itself is order-free).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface PvHistoryItem {
  firedAt: number;
  driver: string;
  agent?: string;
  cwd?: string;
  outcome: string;
  resultSnippet: string;
}

export interface PvEntry {
  id: string;
  text: string;
  model?: string;
  effort?: string;
  tags: string[];
  laneHint?: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  history: PvHistoryItem[];
}

interface PvVault {
  version: number;
  entries: PvEntry[];
}

const ORDER_KEY = 'praxis.fd.vaultOrder.v1';

function loadOrder(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function saveOrder(order: Record<string, string[]>): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* ignore */
  }
}

export function entTag(entKey: string): string {
  return `fd:${entKey}`;
}

/**
 * Thin binding over the global vault's `pv_search` Rust command (case-insensitive
 * substring match over prompt text + every tag). This is the "search ALL saved
 * prompts" seam the v2 deck had and the port dropped - it reaches across every
 * entity's queue at once, unlike `forKey`, which is scoped to one console.
 *
 * A blank/whitespace query resolves to `[]` (never the whole vault) so a caller
 * renders an empty state, not every prompt in Praxis; any IPC error degrades to
 * `[]` so the search UI stays honest instead of throwing.
 */
export async function searchVault(query: string): Promise<PvEntry[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await invoke<PvEntry[]>('pv_search', { query: q });
  } catch {
    return [];
  }
}

export interface DeckVault {
  /** Entries for one entity key, in queue order. */
  forKey: (entKey: string) => PvEntry[];
  counts: Record<string, number>;
  add: (entKey: string, text: string, model: string, effort: string, laneHint?: string) => Promise<PvEntry | null>;
  update: (id: string, patch: Partial<Pick<PvEntry, 'text' | 'model' | 'effort'>>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  move: (entKey: string, id: string, dir: -1 | 1) => void;
  recordOutcome: (id: string, item: PvHistoryItem) => Promise<void>;
  refresh: () => void;
}

export function useDeckVault(): DeckVault {
  const [entries, setEntries] = useState<PvEntry[]>([]);
  const [order, setOrder] = useState<Record<string, string[]>>(() => loadOrder());

  const refresh = useCallback(async () => {
    try {
      const v = await invoke<PvVault>('pv_list');
      setEntries(v.entries ?? []);
    } catch {
      /* vault offline → empty; the UI reads counts of 0, never fakes */
    }
  }, []);

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('praxis://pv-update', () => refresh()))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  const byKey = useMemo(() => {
    const map: Record<string, PvEntry[]> = {};
    for (const e of entries) {
      for (const t of e.tags) {
        if (!t.startsWith('fd:')) continue;
        (map[t.slice(3)] ??= []).push(e);
      }
    }
    // Apply queue order (unlisted entries append in createdAt order).
    for (const [k, list] of Object.entries(map)) {
      const ord = order[k] ?? [];
      const idx = new Map(ord.map((id, i) => [id, i]));
      list.sort((a, b) => {
        const ia = idx.has(a.id) ? (idx.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const ib = idx.has(b.id) ? (idx.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ia - ib || a.createdAt - b.createdAt;
      });
    }
    return map;
  }, [entries, order]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const [k, list] of Object.entries(byKey)) c[k] = list.length;
    return c;
  }, [byKey]);

  const forKey = useCallback((entKey: string) => byKey[entKey] ?? [], [byKey]);

  const add = useCallback(
    async (entKey: string, text: string, model: string, effort: string, laneHint?: string) => {
      try {
        const entry = await invoke<PvEntry>('pv_add', {
          entry: {
            text,
            model,
            effort,
            tags: [entTag(entKey)],
            laneHint: laneHint ?? null,
            source: 'flightdeck',
          },
        });
        refresh();
        return entry;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Pick<PvEntry, 'text' | 'model' | 'effort'>>) => {
      try {
        await invoke('pv_update', { id, patch });
        refresh();
      } catch {
        /* surface-level: pv-update event will reconcile */
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await invoke('pv_remove', { id });
        refresh();
      } catch {
        /* ignore */
      }
    },
    [refresh],
  );

  const move = useCallback(
    (entKey: string, id: string, dir: -1 | 1) => {
      setOrder((prev) => {
        const cur = byKey[entKey] ?? [];
        const ids = cur.map((e) => e.id);
        const i = ids.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= ids.length) return prev;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        const next = { ...prev, [entKey]: ids };
        saveOrder(next);
        return next;
      });
    },
    [byKey],
  );

  const recordOutcome = useCallback(
    async (id: string, item: PvHistoryItem) => {
      try {
        await invoke('pv_record_outcome', { id, historyItem: item });
      } catch {
        /* best-effort write-back */
      }
    },
    [],
  );

  return { forKey, counts, add, update, remove, move, recordOutcome, refresh };
}
