/**
 * voiceEvents - the ONE contract between voice CONTROLS and the voice ENGINE.
 *
 * Buttons live in the right dock (RightDock), the push-to-talk mic lives in the
 * HUD (LauncherDock owns exactly one mic instance for the window), and the
 * continuous session lives in VoicePopup. None of them can call into each other
 * directly, so they agree through these window events instead of three
 * hand-typed string literals that quietly drift apart.
 *
 * The three ways to talk to Praxis, and which event each uses:
 *
 *   HOLD      hold the button (or hold T) → listening while held, sends on
 *             release. HOLD_START / HOLD_END.
 *   TOGGLE    Ctrl+T (or the keyboard's V tap) → starts listening, press again
 *             to stop and send. TOGGLE.
 *   CONVERSE  the conversation button (or the Ctrl+T→Space chord) → an ongoing,
 *             always-listening session you interrupt freely. CONVERSATION
 *             toggles it on and off.
 */

/** Begin listening and KEEP listening (pointer is down / T is held). */
export const VOICE_HOLD_START = "praxis:voice-hold-start";

/** Stop listening and SEND what was captured (pointer released / T released). */
export const VOICE_HOLD_END = "praxis:voice-hold-end";

/** Start listening, or stop-and-send if already listening. Ctrl+T's behaviour. */
export const VOICE_TOGGLE = "praxis:voice-toggle";

/** Start the continuous conversation session, or end it if one is running. */
export const VOICE_CONVERSATION = "praxis:voice-conversation";

/** Fired BY the engine whenever the continuous session starts or stops, so the
 *  buttons can render live state instead of guessing. `detail` is the new state. */
export const VOICE_CONVERSATION_STATE = "praxis:voice-conversation-state";

/**
 * The live SESSION state, broadcast so a corner indicator can render in whichever
 * Praxis window the owner is actually working in.
 *
 * VOICE_CONVERSATION_STATE above only carries on/off - enough for a button, not
 * enough to draw "listening / speaking / working" with a timer and the transport
 * badge. Each Praxis window is its own webview, so a same-window DOM event can't
 * reach the Command Center / Memory Galaxy / Flight Deck: this rides the Tauri bus
 * as well, exactly like `praxis://status` in shared/praxisStatus.ts.
 *
 * Only the window that OWNS the session publishes. Everyone else reads.
 */
export const VOICE_POPUP_STATE = "praxis:voice-popup-state";
export const VOICE_POPUP_STATE_TAURI = "praxis://voice-popup-state";
/** Last published state, so a window opened mid-session draws immediately instead
 *  of waiting for the next transition. */
const VOICE_POPUP_STATE_CACHE = "praxis.voice.popup.v1";

/** Coarse session states the indicator can draw. Mirrors `SessionLiveState`
 *  (useHybridSession) - kept structurally identical so neither side drifts. */
export type VoicePopupLiveState = "listening" | "hearing" | "transcribing" | "acting" | "speaking";

export interface VoicePopupState {
  /** false = no session is running; every reader hides. */
  active: boolean;
  state: VoicePopupLiveState;
  /** True only while audio is ACTUALLY playing (drives tap-to-interrupt). */
  speaking: boolean;
  transport: "realtime" | "local";
  /** Epoch ms the session started. Readers tick their own clock from this, so the
   *  publisher doesn't have to broadcast once a second just to move a timer. */
  startedAt: number;
  /** Non-blocking transport notice (realtime fell back to local / cap hit). */
  notice?: string | null;
  /** Mic/transport failure. When set, readers must NOT draw a listening state -
   *  the mic is not listening, and saying so would be a lie. */
  error?: string | null;
  /** "once" (Ctrl+T, one turn) or "continuous" (CONVERSE). Same engine; only what
   *  the keyboard does next differs, so readers can say the right thing. */
  mode?: "once" | "continuous";
  ts: number;
}

/**
 * Identity of THIS webview, used to ignore our own Tauri echo (Tauri delivers an
 * `emit` to every window including the sender, and the sender already handled the
 * DOM event). Path-derived so it needs no async Tauri call: index.html / command.html
 * / knowledge.html / flightdeck.html are one window each.
 */
export function praxisWindowKey(): string {
  if (typeof window === "undefined") return "server";
  const file = (window.location?.pathname || "/").split("/").pop();
  return file && file.length > 0 ? file : "index.html";
}

const ORIGIN = praxisWindowKey();

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function fire(name: string, detail?: unknown): void {
  try {
    window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));
  } catch {
    /* non-DOM environment - best-effort */
  }
}

/** Publish the live session state to every Praxis window. Best-effort by
 *  construction: a broadcast failure must never break or delay a voice turn. */
export function announceVoicePopupState(next: Omit<VoicePopupState, "ts"> & { ts?: number }): void {
  const payload: VoicePopupState = { ...next, ts: next.ts ?? Date.now() };
  fire(VOICE_POPUP_STATE, payload);
  try {
    localStorage.setItem(VOICE_POPUP_STATE_CACHE, JSON.stringify(payload));
  } catch {
    /* cache is a convenience; the events are the live path */
  }
  if (!inTauri()) return;
  void (async () => {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(VOICE_POPUP_STATE_TAURI, { ...payload, origin: ORIGIN });
    } catch {
      /* plain browser / bridge unavailable */
    }
  })();
}

/** Narrow an untrusted payload (Tauri bus / localStorage) to a real state. */
export function coerceVoicePopupState(v: unknown): VoicePopupState | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<VoicePopupState> & { origin?: unknown };
  if (typeof p.origin === "string" && p.origin === ORIGIN) return null; // our own echo
  if (
    p.state !== "listening" &&
    p.state !== "hearing" &&
    p.state !== "transcribing" &&
    p.state !== "acting" &&
    p.state !== "speaking"
  ) {
    return null;
  }
  return {
    active: p.active === true,
    state: p.state,
    speaking: p.speaking === true,
    transport: p.transport === "realtime" ? "realtime" : "local",
    startedAt: typeof p.startedAt === "number" ? p.startedAt : Date.now(),
    notice: typeof p.notice === "string" ? p.notice : null,
    error: typeof p.error === "string" ? p.error : null,
    mode: p.mode === "once" ? "once" : "continuous",
    ts: typeof p.ts === "number" ? p.ts : Date.now(),
  };
}

/**
 * How long a published state stays believable. The owner re-publishes on a slow
 * heartbeat while a session runs, so silence past this means the owner is gone
 * (window closed, app crashed) - readers fall back to "no session" instead of
 * leaving a LISTENING pill on screen forever. A guard that can only latch on is
 * how Praxis ends up asserting things that stopped being true.
 */
export const VOICE_POPUP_STATE_STALE_MS = 60_000;

/** The last published state, for a window that mounts mid-session. Stale entries
 *  are discarded rather than trusted. */
export function readCachedVoicePopupState(): VoicePopupState | null {
  try {
    const cached = coerceVoicePopupState(JSON.parse(localStorage.getItem(VOICE_POPUP_STATE_CACHE) ?? "null"));
    if (!cached) return null;
    return Date.now() - cached.ts > VOICE_POPUP_STATE_STALE_MS ? null : cached;
  } catch {
    return null;
  }
}

/**
 * One turn whose words were already captured somewhere else - another Praxis window's
 * mic forwarded them over praxis://command. It runs in the same session as Ctrl+T,
 * not in the old route.ts ladder. `detail` is the text.
 */
export const VOICE_ONCE_TEXT = "praxis:voice-once-text";
export const voiceOnceText = (text: string): void => fire(VOICE_ONCE_TEXT, text);

export const voiceHoldStart = (): void => fire(VOICE_HOLD_START);
export const voiceHoldEnd = (): void => fire(VOICE_HOLD_END);
export const voiceToggle = (): void => fire(VOICE_TOGGLE);
export const voiceConversation = (): void => fire(VOICE_CONVERSATION);
export const announceConversationState = (active: boolean): void =>
  fire(VOICE_CONVERSATION_STATE, active);
