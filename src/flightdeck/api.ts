// Flight Deck data access - Tauri commands (Rust), no HTTP sidecar.
// All data is read live from the local Claude state by src-tauri/src/flightdeck.rs.
import { invoke } from '@tauri-apps/api/core';
import type { LanesSnapshot, TopologySnapshot } from './types';
import { TOPOLOGY_FIXTURE } from './lib/fixture';

// DEV-only demo: `?demo=fleet` serves a static topology fixture, so the flow
// diagram can be screenshotted in a plain browser where the Tauri `invoke`
// bridge is absent. Never reached in a release build.
function demoTopology(): TopologySnapshot | null {
  if (!import.meta.env.DEV) return null;
  try {
    return new URLSearchParams(window.location.search).get('demo') === 'fleet' ? TOPOLOGY_FIXTURE : null;
  } catch {
    return null;
  }
}

export async function fetchLanes(): Promise<LanesSnapshot> {
  return invoke<LanesSnapshot>('fd_sessions');
}

/** Drop usage + Flight Deck caches and force a fresh snapshot rebuild (no window reload). */
export async function refreshLiveState(): Promise<void> {
  await invoke('refresh_live_state');
}

/** Live plan TIER per provider ("Pro", "Plus", "Max", …) from the Rust `plan_names`
 *  command - the cheap companion to usage_summary's full rail bars. `null` means
 *  "not known right now": callers must render the provider name alone rather than
 *  guess a tier (Vega's VIA badge used to hardcode "CHATGPT PRO" no matter what
 *  the owner's actual ChatGPT plan was). */
export interface PlanNames {
  claude: string | null;
  codex: string | null;
  cursor: string | null;
}

export async function fetchPlanNames(): Promise<PlanNames> {
  return invoke<PlanNames>('plan_names');
}

/** Last `n` (≤20) meaningful transcript lines for a session, newest-first, as
 *  short display strings ("✎ Edit foo.ts", "▸ Bash cargo check"). Claude sessions
 *  only; codex/cursor return []. Reads the on-disk tail - never the live process.
 *  Returns [] on any error so a caller can fall back to the snapshot preview. */
export async function fetchSessionTail(
  sessionId: string,
  cwd: string | null,
  driver: string,
  n = 12,
): Promise<string[]> {
  try {
    return await invoke<string[]>('fd_session_tail', { sessionId, cwd: cwd ?? '', driver, n });
  } catch {
    return [];
  }
}

/** The STATIC worktree/code-lane topology diagram - fetched ONCE on demand (the
 *  diagram panel opening, or a manual "rebuild" click), never polled. Backed by
 *  the new `fd_worktree_topology` command (src-tauri/src/flightdeck_topology.rs).
 *  NOTE: requires the one-line handler registration in lib.rs noted in that file's
 *  header comment - until that lands, this call fails and the caller shows an
 *  empty/error state rather than crashing. */
export async function fetchTopology(): Promise<TopologySnapshot> {
  const demo = demoTopology();
  if (demo) return demo;
  return invoke<TopologySnapshot>('fd_worktree_topology');
}

// NOTE: the v2 per-lane vault (fd_read_vault/fd_write_vault + Vault/VaultEntry)
// had its TS bindings removed here as dead code - the v3 deck uses the GLOBAL
// pv_* prompt vault instead (useDeckVault.ts). The Rust commands themselves are
// left in src-tauri/src/flightdeck.rs; they may still be a migration source.

// ── Session lifecycle (real spawn/stop) ───────────────────────────────────────
// Thin typed bindings over the Rust commands `fd_spawn_session` / `fd_stop_session`.
// No UI here - any Flight Deck view can call these to launch or kill real sessions.

/** Drivers that can be spawned as a LOCAL headless process. 'cloud' is deliberately
 *  excluded - it runs off-machine and `fd_spawn_session` rejects it with a clear Err. */
export type SpawnDriver = 'claude' | 'max' | 'integration' | 'codex' | 'cursor';

/** Effort levels Claude Code accepts (`--effort`). Other drivers ignore effort. */
export type SpawnEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SpawnSessionArgs {
  /** Absolute working directory / worktree the session runs in. */
  dir: string;
  /** Task prompt handed to the CLI. */
  prompt: string;
  /** Lane driver - maps onto claude/codex/cursor CLIs. */
  driver: SpawnDriver;
  /** Optional model alias/name (passed to `--model` / `-m`). */
  model?: string;
  /** Optional effort level (Claude only). */
  effort?: SpawnEffort;
}

/** What `fd_spawn_session` returns - mirrors the Rust `SpawnResult` (camelCase). */
export interface SpawnResult {
  pid: number;
  sessionId: string;
  driver: 'claude' | 'codex' | 'cursor';
  bin: string;
  logPath: string;
  cwd: string;
}

/** Launch a NEW headless coding session. Detached, no console window. Resolves with
 *  the PID + session id; rejects with a clear message for cloud lanes or an
 *  uninstalled cursor-agent CLI. */
export async function spawnSession(args: SpawnSessionArgs): Promise<SpawnResult> {
  return invoke<SpawnResult>('fd_spawn_session', {
    dir: args.dir,
    prompt: args.prompt,
    driver: args.driver,
    model: args.model,
    effort: args.effort,
  });
}

/** Stop a running session by PID. The backend verifies the process image matches
 *  `driver` before killing (never kills an arbitrary/recycled PID) and terminates
 *  the whole child tree. Rejects if the PID is not a live process of that driver. */
export async function stopSession(pid: number, driver: SpawnDriver): Promise<string> {
  return invoke<string>('fd_stop_session', { pid, driver });
}

/** How far back a session still counts as ACTIVE on the deck, in ms. 0 = "All"
 * Persisted in the flight-deck vault, so it survives a restart and is shared by every window;
 * the backend emits `praxis://fd-update` so they all re-poll at
 *  once instead of drifting until their next interval. */
export const ACTIVE_WINDOW_OPTIONS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 60 * 60_000, label: '1H' },
  { ms: 8 * 60 * 60_000, label: '8H' },
  { ms: 24 * 60 * 60_000, label: '24H' },
  { ms: 7 * 24 * 60 * 60_000, label: '7D' },
  { ms: 0, label: 'ALL' },
];

export function activeWindowLabel(ms: number): string {
  return ACTIVE_WINDOW_OPTIONS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 3_600_000)}H`;
}

export async function setActiveWindow(ms: number): Promise<number> {
  return invoke<number>('fd_set_active_window', { ms });
}

