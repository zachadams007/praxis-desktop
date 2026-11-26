/**
 * atlasChatBridge - mirror every spoken turn into Atlas's PERSISTENT chat thread.
 *
 * The voice popup's `feed` is ephemeral React state: it's cleared on every
 * session start and dies with the popup. So a Ctrl+T conversation left no trace
 * in the Atlas chat window, even though that window is meant to be the one place
 * Atlas's conversation lives. The owner hit exactly that - he'd speak a command and
 * find nothing in the Atlas chat afterwards.
 *
 * This writes both halves of each turn (what the owner said, what Atlas did or
 * answered) to the SAME `agent_chat_*` store the Atlas chat panel reads, so the
 * spoken lane and the typed lane share one history.
 *
 * Best-effort by construction: a persistence failure must never break or delay
 * the voice turn, so every call is fire-and-forget and swallows its errors.
 */

import type { HybridFeedItem } from "./hybridRouter";
import { praxisWindowKey } from "./voiceEvents";

/** Atlas's agent key - matches `fleetStore`'s roster entry. */
/**
 * Atlas's canonical thread id - the ROSTER id (`src/shared/agents.ts`), which is
 * what the Cockpit's Fleet chat opens.
 *
 * This bridge used to write `"atlas"` (the fleetStore key), so the voice
 * conversation went to `atlas.jsonl` while the Cockpit read `a.atlas.jsonl`. Same
 * agent, two histories, and the one the owner could open through the roster was empty.
 * Nothing was lost - it was filed under a name nothing else looked up.
 */
const ATLAS_AGENT_ID = "a.atlas";

/**
 * Where the voice thread was written before 2026-09-09. Still READ, never written,
 * so the conversation the owner already had stays visible. Merging on read rather than
 * moving the file means a migration cannot lose history if it half-runs - the old
 * file is only ever a source.
 */
const LEGACY_ATLAS_AGENT_ID = "atlas";

/**
 * One turn in Atlas's conversation, as the UI consumes it.
 *
 * `meta` is the resolution/lane tag the writer chose ("voice", "atlas", "action",
 * "answer", "blocked", …) - a plain string, which is what actually lands in the
 * JSONL. (knowledge/agentChat.ts types the same column as an object and casts to
 * it; reading through that type would quietly lie about these rows, so the Atlas
 * thread gets its own honest reader below.)
 */
export interface AtlasTurn {
  role: "zach" | "agent";
  text: string;
  ts: number;
  meta?: string;
}

/**
 * Live announcement of a turn, so the Atlas chat panel renders the conversation AS
 * IT HAPPENS instead of only after a reload.
 *
 * Persisting was never the missing half - `agent_chat_append` has been writing
 * every turn to `agent-chats/atlas.jsonl` all along. Nothing TOLD the panel, so
 * the one surface that is supposed to BE the conversation sat on a stale canned
 * greeting while the owner talked. Same pattern the rest of the app uses for
 * cross-surface state: a DOM event for this window, a Tauri emit for the others.
 */
export const ATLAS_TURN_EVENT = "praxis:atlas-turn";
export const ATLAS_TURN_TAURI_EVENT = "praxis://atlas-turn";

/**
 * A visible Atlas clear never destroys the underlying JSONL transcript. Instead it
 * saves the instant the new conversation starts and readers hide rows at or before
 * it. That makes the control reversible at the storage layer and keeps the audit
 * trail intact while still giving the chat a real fresh start on reopen.
 */
export const ATLAS_CHAT_CLEARED_THROUGH_KEY = "praxis.atlas.chat.cleared-through.v1";
export const ATLAS_CHAT_CLEAR_EVENT = "praxis:atlas-chat-cleared";
export const ATLAS_CHAT_CLEAR_TAURI_EVENT = "praxis://atlas-chat-cleared";

const ORIGIN = praxisWindowKey();

export interface AtlasChatClear {
  clearedThrough: number;
}

export interface AtlasChatClearResult extends AtlasChatClear {
  /** The fresh start succeeded locally; another open window could not be signalled. */
  syncError?: string;
}

/** Read the durable fresh-start boundary. Malformed or absent values mean no clear. */
export function readAtlasChatClearedThrough(): number {
  try {
    const value = Number(localStorage.getItem(ATLAS_CHAT_CLEARED_THROUGH_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Keep the first turn created at the fresh-start instant as well as all later turns. */
export function turnsSinceAtlasChatClear(turns: AtlasTurn[], clearedThrough: number): AtlasTurn[] {
  return clearedThrough > 0 ? turns.filter((turn) => turn.ts >= clearedThrough) : turns;
}

/**
 * How long a conversation stays on screen before it stops being context.
 *
 * The button alone puts the tidying on him every time; this is the other half. Twelve hours
 * keeps a morning conversation through lunch and drops yesterday's.
 */
export const ATLAS_CHAT_STALE_MS = 12 * 60 * 60 * 1000;

/**
 * Drop turns too old to be part of the conversation any more.
 *
 * NOTHING IS DELETED. Like the Clear button, this only narrows what the panel
 * renders - `atlas.jsonl` keeps every line, so a stale turn is out of sight, not
 * gone. Deliberately time-based rather than a message cap: a count would cut a
 * conversation mid-exchange and leave an answer with no question above it, which
 * reads as Atlas having spoken unprompted.
 */
export function turnsWithinAtlasChatWindow(
  turns: AtlasTurn[],
  now: number = Date.now(),
  windowMs: number = ATLAS_CHAT_STALE_MS,
): AtlasTurn[] {
  if (!(windowMs > 0)) return turns;
  const cutoff = now - windowMs;
  // A turn with a nonsense timestamp (0, NaN, future) is KEPT rather than hidden -
  // losing a real message is worse than showing an old one.
  return turns.filter((turn) => !Number.isFinite(turn.ts) || turn.ts <= 0 || turn.ts >= cutoff);
}

/** Narrow the untrusted local/Tauri clear payload and ignore our own Tauri echo. */
export function coerceAtlasChatClear(v: unknown): AtlasChatClear | null {
  if (!v || typeof v !== "object") return null;
  const payload = v as { clearedThrough?: unknown; origin?: unknown };
  if (typeof payload.origin === "string" && payload.origin === ORIGIN) return null;
  return typeof payload.clearedThrough === "number" && Number.isFinite(payload.clearedThrough) && payload.clearedThrough > 0
    ? { clearedThrough: payload.clearedThrough }
    : null;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start a fresh visible Atlas chat without deleting either canonical or legacy
 * transcript files. The saved marker survives reopen; the local event updates this
 * webview immediately and the Tauri event updates the other Praxis windows.
 */
export async function clearAtlasChat(): Promise<AtlasChatClearResult> {
  const clearedThrough = Date.now();
  try {
    localStorage.setItem(ATLAS_CHAT_CLEARED_THROUGH_KEY, String(clearedThrough));
  } catch (error) {
    throw new Error(`Couldn't save the fresh start: ${errorDetail(error)}`);
  }

  resetRealtimeMirror();
  const detail: AtlasChatClear = { clearedThrough };
  try {
    window.dispatchEvent(new CustomEvent<AtlasChatClear>(ATLAS_CHAT_CLEAR_EVENT, { detail }));
  } catch {
    /* non-DOM environments have no panel to update */
  }

  if (!inTauri()) return detail;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(ATLAS_CHAT_CLEAR_TAURI_EVENT, { ...detail, origin: ORIGIN });
    return detail;
  } catch (error) {
    // Local storage already made the clear durable. Expose the limited live-sync
    // failure truthfully instead of pretending every open window updated.
    return { ...detail, syncError: errorDetail(error) };
  }
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Narrow an untrusted turn (Tauri bus / JSONL row) - and drop our own Tauri echo,
 *  which the local DOM event already delivered. */
export function coerceAtlasTurn(v: unknown): AtlasTurn | null {
  if (!v || typeof v !== "object") return null;
  const p = v as { role?: unknown; text?: unknown; ts?: unknown; meta?: unknown; origin?: unknown };
  if (typeof p.origin === "string" && p.origin === ORIGIN) return null;
  if (typeof p.text !== "string" || !p.text.trim()) return null;
  return {
    role: p.role === "zach" ? "zach" : "agent",
    text: p.text,
    ts: typeof p.ts === "number" ? p.ts : Date.now(),
    meta: typeof p.meta === "string" ? p.meta : undefined,
  };
}

function broadcast(turn: AtlasTurn): void {
  try {
    window.dispatchEvent(new CustomEvent<AtlasTurn>(ATLAS_TURN_EVENT, { detail: turn }));
  } catch {
    /* non-DOM environment */
  }
  if (!inTauri()) return;
  void (async () => {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(ATLAS_TURN_TAURI_EVENT, { ...turn, origin: ORIGIN });
    } catch {
      /* bridge unavailable - the local panel still updated */
    }
  })();
}

/**
 * Read Atlas's persisted thread back, oldest-first, so a panel opened mid-life
 * shows the conversation so far rather than starting blank. Empty on any failure
 * (dev browser, command missing) - a history read must never throw into the UI.
 */
export async function loadAtlasThread(limit = 80): Promise<AtlasTurn[]> {
  if (!inTauri()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const read = async (agentId: string): Promise<AtlasTurn[]> => {
      try {
        const rows = await invoke<unknown[]>("agent_chat_read", { agentId });
        return (Array.isArray(rows) ? rows : [])
          .map((r) => coerceAtlasTurn(r))
          .filter((t): t is AtlasTurn => t !== null);
      } catch {
        return [];
      }
    };
    // Both ids, merged by time. The legacy file holds every conversation before
    // the id was corrected; reading it costs one call and keeps that history on
    // screen instead of appearing to have deleted it.
    const [legacy, current] = await Promise.all([
      read(LEGACY_ATLAS_AGENT_ID),
      read(ATLAS_AGENT_ID),
    ]);
    const turns = turnsWithinAtlasChatWindow(turnsSinceAtlasChatClear(
      [...legacy, ...current].sort((a, b) => a.ts - b.ts),
      // Read after both async file loads: a clear made while either read was in
      // flight must win, never let its stale result resurrect the old rows.
      readAtlasChatClearedThrough(),
    ));
    return limit > 0 ? turns.slice(-limit) : turns;
  } catch {
    return [];
  }
}

/**
 * The push-to-talk (hold-T) lane's two halves.
 *
 * Named separately from the realtime pair because they must NOT inherit its
 * de-duplication: the realtime transport drops consecutive identical text since a
 * provider reconnect replays the tail, whereas saying "next" twice into the brain
 * mic is two real turns.
 */
export function mirrorVoiceHeard(text: string): void {
  void append("zach", text, "voice");
}

export function mirrorVoiceSpoke(text: string): void {
  void append("agent", text, "voice");
}

/**
 * Something the owner needs to KNOW about the voice itself, in plain words, in the panel where he
 * reads the conversation - e.g. "OpenAI API credit is used up". A pill notice disappears when
 * the session closes; this stays.
 */
export function mirrorVoiceNotice(text: string): void {
  void append("agent", text, "blocked");
}

/**
 * How a job Atlas handed to Praxis ended, in the thread where the owner asked for it. Live 2026-09-17
 * the site was built, opened and maximized while Atlas's thread still ended at "Handing that to
 * Praxis - it's building it now."
 */
export function mirrorJobOutcome(text: string, done: boolean): void {
  void append("agent", text, done ? "done" : "not done");
}

/**
 * Persist a TYPED turn - something the owner wrote in the Atlas box rather than said.
 *
 * `ask()` wrote only to the in-memory `chat` array, capped at 40 and gone on
 * restart. So the durable thread held the spoken half of every conversation and
 * none of the typed half: reopening Praxis showed a dialogue with one side of it
 * missing, which reads as Atlas having forgotten.
 *
 * Deliberately NOT `mirrorRealtimeTurn`: that de-duplicates consecutive identical
 * text, because a provider reconnect replays the tail. Typing the same thing twice
 * on purpose is a real thing to do, and the second one must not vanish.
 */
export function mirrorTypedTurn(role: "zach" | "agent", text: string): void {
  void append(role, text, "typed");
}

/**
 * Announce the turn FIRST, then persist.
 *
 * The conversation is the truth; the JSONL is its durable copy. If the disk write
 * fails, the line the owner just spoke still belongs on screen - dropping it because a
 * best-effort write failed would be the panel lying about what was said.
 */
async function append(role: "zach" | "agent", text: string, meta?: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  broadcast({ role, text: body, ts: Date.now(), meta });
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("agent_chat_append", {
      agentId: ATLAS_AGENT_ID,
      role,
      text: body,
      meta: meta ?? null,
    });
  } catch {
    /* chat mirroring is never allowed to break a voice turn */
  }
}

/**
 * Resolutions that are pure noise in a chat transcript. An empty utterance or a
 * no-op adds nothing a reader wants, and would bury the real conversation.
 */
const SKIP: ReadonlySet<HybridFeedItem["resolution"]> = new Set(["ignored"]);

/**
 * Mirror one finalized voice turn into Atlas's thread.
 *
 * `meta` carries the resolution class ("action", "answer", "blocked", …) so the
 * chat panel can style a executed command differently from a spoken answer
 * without re-deriving it from the text.
 */
export function mirrorVoiceTurn(item: HybridFeedItem): void {
  if (SKIP.has(item.resolution)) return;
  // Live 2026-09-16 that wrote his sentence twice. Only a repeat within seconds is the same
  // utterance - saying it again later is not.
  const said = item.transcript.trim();
  const now = Date.now();
  const duplicate = Boolean(said) && lastMirrored.zach === said && now - (lastMirroredAt.zach ?? 0) < 15_000;
  if (said) {
    lastMirrored.zach = said;
    lastMirroredAt.zach = now;
  }
  void (async () => {
    if (!duplicate) await append("zach", item.transcript, "voice");
    await append("agent", item.displayMarkdown?.trim() || item.detail, item.resolution);
  })();
}

/**
 * Mirror one side of a REALTIME (Atlas continuous) turn.
 *
 * The hybrid lane above mirrors a finished turn as a pair. A Realtime
 * conversation has no such pair - the two halves arrive as separate provider
 * events, minutes apart if the owner is mid-sentence - so each is written as it
 * finalizes. Without this the entire continuous lane wrote nothing to the Atlas
 * thread, which is the panel that is supposed to BE the conversation.
 *
 * De-duplicated per side: the provider can re-emit a completed transcript (a
 * reconnect replays the tail), and a doubled line in the thread reads as Atlas
 * repeating itself.
 */
let lastMirrored: { zach?: string; agent?: string } = {};
let lastMirroredAt: { zach?: number; agent?: number } = {};

export function mirrorRealtimeTurn(role: "zach" | "agent", text: string): void {
  const body = text.trim();
  if (!body) return;
  if (lastMirrored[role] === body) return;
  lastMirrored[role] = body;
  lastMirroredAt[role] = Date.now();
  void append(role, body, role === "zach" ? "voice" : "atlas");
}

/** Drop the de-dup memory when a session ends, so the same opening line in a new
 *  conversation is not silently swallowed. */
export function resetRealtimeMirror(): void {
  lastMirrored = {};
  lastMirroredAt = {};
}
