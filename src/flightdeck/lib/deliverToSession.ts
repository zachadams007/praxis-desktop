/**
 * deliverToSession - a Flight Deck message that actually reaches the session it's sent to.
 *
 * Until 2026-10-01 every deck "send" appended to the agent's thread file and toasted
 * "CAST TO 3 SESSIONS" / "READ AT NEXT PICKUP" - the sessions never heard a word. The
 * `session_deliver` command (src-tauri/src/session_deliver.rs) continues the session itself
 * (`claude -p --resume <id>`, `codex exec resume <uuid>`) and returns its reply, so:
 *   • an idle Claude or Codex session gets the message now, and its reply comes back;
 *   • a session mid-task gets it the moment that task ends (queued here, persisted, flushed
 *     by the deck's session poll) - a resume can't cut into a running turn;
 *   • a Cursor or cloud session can't be reached, and the deck says so instead of pretending.
 * The exchange is also written to the agent's thread, tagged with the session id.
 */
import { appendFlightDeckAgentChat } from './sendToAgent';
import type { Driver } from '../types';

export type DeliverTarget = { id: string; driver: Driver | string; cwd: string | null; working: boolean; name?: string };
export type DeliverResult = { ok: true; reply: string; forked: boolean; sessionId: string } | { ok: false; reason: string };
type Cli = 'claude' | 'codex';

export const PENDING_KEY = 'praxis.deck.pendingDeliveries.v1';
/** A message nobody could deliver for this long is stale - dropped, not sent late. */
export const PENDING_MAX_AGE_MS = 12 * 60 * 60_000;
/** Each delivery is a real agent turn on the owner's plan: at most this many at once. */
export const DELIVER_CONCURRENCY = 2;

/** Pure: which CLI continues this session, or why none can. */
export function deliveryRoute(s: { id: string; driver: string }): { cli: Cli } | { unsupported: string } {
  if (s.id.includes('::cloud-')) return { unsupported: 'it runs in the cloud, not on this PC' };
  if (s.id.startsWith('cursor:') || s.driver === 'cursor') return { unsupported: "Cursor's CLI can't continue a chat" };
  if (s.id.startsWith('codex:') || s.driver === 'codex') return { cli: 'codex' };
  return { cli: 'claude' };
}

export type CastPlan<T> = { now: T[]; queued: T[]; unreachable: { s: T; why: string }[] };

/** Pure: split targets into deliver-now, deliver-when-free, and can't-reach. */
export function planCast<T extends { id: string; driver: string; working: boolean }>(targets: T[]): CastPlan<T> {
  const plan: CastPlan<T> = { now: [], queued: [], unreachable: [] };
  for (const s of targets) {
    const r = deliveryRoute(s);
    if ('unsupported' in r) plan.unreachable.push({ s, why: r.unsupported });
    else if (s.working) plan.queued.push(s);
    else plan.now.push(s);
  }
  return plan;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'S'}`;

/** Pure: the toast for a cast, saying exactly where the message is going. */
export function castToast(plan: CastPlan<unknown>): string {
  const parts: string[] = [];
  if (plan.now.length) parts.push(`⇶ DELIVERING TO ${plural(plan.now.length, 'SESSION')}`);
  if (plan.queued.length) parts.push(`${plural(plan.queued.length, 'BUSY SESSION')} GET IT WHEN FREE`);
  if (plan.unreachable.length) parts.push(`${plural(plan.unreachable.length, 'SESSION')} CAN'T TAKE MESSAGES`);
  return parts.length ? parts.join(' · ') : 'NO SESSIONS TO DELIVER TO';
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/** Deliver `text` into session `s` and bring back its reply. Never throws. */
export async function deliverToSession(
  s: DeliverTarget,
  text: string,
  invoke?: <R>(cmd: string, args: Record<string, unknown>) => Promise<R>,
): Promise<DeliverResult> {
  const route = deliveryRoute({ id: s.id, driver: String(s.driver) });
  if ('unsupported' in route) return { ok: false, reason: route.unsupported };
  const call =
    invoke ??
    (inTauri()
      ? async <R,>(cmd: string, args: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<R>(cmd, args)
      : null);
  if (!call) return { ok: false, reason: 'Praxis is not running as the desktop app' };
  const tool = route.cli;
  await appendFlightDeckAgentChat({ tool, role: 'zach', text, driver: s.driver as Driver, cwd: s.cwd, sessionId: s.id });
  try {
    const r = await call<{ reply: string; sessionId: string; forked: boolean }>('session_deliver', {
      driver: route.cli,
      sessionId: s.id,
      cwd: s.cwd ?? '',
      message: text,
    });
    await appendFlightDeckAgentChat({ tool, role: 'agent', text: r.reply, driver: s.driver as Driver, cwd: s.cwd, sessionId: r.sessionId });
    return { ok: true, reply: r.reply, forked: Boolean(r.forked), sessionId: r.sessionId };
  } catch (e) {
    return { ok: false, reason: String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, '') };
  }
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

// ── deliver-when-free queue (persisted: the deck can close and reopen) ──────────

export type PendingDelivery = {
  sessionId: string;
  text: string;
  at: number;
  label: string;
  /** Persist enough routing context to resume a session even if it falls out of
   * the deck's active-window census before its current turn finishes. */
  driver?: string;
  cwd?: string | null;
  /** The lane/repo/session console that originated the message. */
  channelKey?: string;
};

function readPending(): PendingDelivery[] {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((p) => p && typeof p.sessionId === 'string' && typeof p.text === 'string') : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingDelivery[]): void {
  try {
    globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the queue lives for this window only */
  }
}

export function enqueueDelivery(p: PendingDelivery): void {
  writePending([...readPending(), p]);
}

export function pendingDeliveries(): PendingDelivery[] {
  return readPending();
}

/**
 * Take the queued messages whose session is no longer mid-task. `isWorking(id)` returns
 * undefined for a session the deck no longer lists - a closed session can still be resumed,
 * so that counts as free. Stale entries are dropped and returned separately so the deck
 * can say they expired instead of silently losing them.
 */
export function takeReady(
  isWorking: (sessionId: string) => boolean | undefined,
  now = Date.now(),
): { ready: PendingDelivery[]; expired: PendingDelivery[] } {
  const ready: PendingDelivery[] = [];
  const expired: PendingDelivery[] = [];
  const keep: PendingDelivery[] = [];
  for (const p of readPending()) {
    if (now - p.at > PENDING_MAX_AGE_MS) expired.push(p);
    else if (isWorking(p.sessionId) === true) keep.push(p);
    else ready.push(p);
  }
  if (ready.length || expired.length) writePending(keep);
  return { ready, expired };
}
