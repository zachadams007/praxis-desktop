/**
 * Live deck data - one hook, three real sources:
 *   • fd_sessions (poll + praxis://fd-update push) - sessions/lanes/collisions
 *   • fd_worktree_topology - the auto-discovered on-disk repo fleet
 *   • fd-spawned registry (localStorage mirror of spawn pid/cwd/driver)
 * - which sessions Praxis launched vs. the owner's own hands, joined the
 *     same way the backend does (pid), not by the synthetic fd- session id
 *
 * The hook folds them into the DeckModel the view renders. No mock data - a
 * cold window shows the real (possibly quiet) fleet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLanes, fetchTopology } from '../api';
import type { LanesSnapshot, TopologySnapshot } from '../types';
import { buildDeck, type DeckModel, type SpawnMark } from './model';

const POLL_MS = 6000;
const TOPOLOGY_REFRESH_MS = 5 * 60_000;
const SPAWNED_KEY = 'praxis.fd.spawned.v2';

function inTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

function isSpawnMark(x: unknown): x is SpawnMark {
  if (!x || typeof x !== 'object') return false;
  const m = x as SpawnMark;
  return typeof m.pid === 'number' && m.pid > 0 && typeof m.cwd === 'string' && typeof m.driver === 'string' && typeof m.at === 'number';
}

function loadSpawned(): SpawnMark[] {
  try {
    const raw = localStorage.getItem(SPAWNED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSpawnMark).slice(-400);
  } catch {
    return [];
  }
}

function saveSpawned(marks: SpawnMark[]): void {
  try {
    localStorage.setItem(SPAWNED_KEY, JSON.stringify(marks.slice(-400)));
  } catch {
    /* ignore */
  }
}

export interface DeckData {
  model: DeckModel;
  online: boolean;
  loading: boolean;
  refresh: () => void;
  refreshTopology: () => Promise<void>;
  acceptSnapshot: (snapshot: LanesSnapshot) => void;
  /** Record a spawn by pid+cwd+driver - the keys cards actually carry. */
  registerSpawned: (mark: SpawnMark) => void;
}

export function useDeckData(): DeckData {
  const [snapshot, setSnapshot] = useState<LanesSnapshot | null>(null);
  const [topology, setTopology] = useState<TopologySnapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [spawned, setSpawned] = useState<SpawnMark[]>(() => loadSpawned());
  const inflight = useRef(false);

  const acceptSnapshot = useCallback((snap: LanesSnapshot) => {
    setSnapshot((previous) => !previous || snap.generatedAt >= previous.generatedAt ? snap : previous);
    setOnline(!snap.error);
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    // Perf mandate: pollers pause while the window is hidden (fd-update pushes
    // and the visibilitychange handler below cover the wake-up refresh).
    if (document.visibilityState === 'hidden') return;
    if (inflight.current) return;
    inflight.current = true;
    try {
      const snap = await fetchLanes();
      acceptSnapshot(snap);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }, [acceptSnapshot]);

  const loadTopology = useCallback(async () => {
    setTopology(await fetchTopology());
  }, []);

  useEffect(() => {
    load();
    void loadTopology().catch(() => {});
    const id = window.setInterval(load, POLL_MS);
    const tid = window.setInterval(() => { void loadTopology().catch(() => {}); }, TOPOLOGY_REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        load();
        void loadTopology().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVis);

    // Push channel - spawn/stop and future backend events refresh instantly.
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    if (inTauri()) {
      import('@tauri-apps/api/event')
        .then(({ listen }) =>
          listen('praxis://fd-update', () => {
            load();
          }),
        )
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.clearInterval(tid);
      document.removeEventListener('visibilitychange', onVis);
      if (unlisten) unlisten();
    };
  }, [load, loadTopology]);

  const registerSpawned = useCallback((mark: SpawnMark) => {
    setSpawned((prev) => {
      const next = [...prev.filter((m) => m.pid !== mark.pid), mark];
      saveSpawned(next);
      return next;
    });
  }, []);

  const model = useMemo(() => buildDeck(snapshot, topology, spawned), [snapshot, topology, spawned]);

  return { model, online, loading, refresh: load, refreshTopology: loadTopology, acceptSnapshot, registerSpawned };
}
