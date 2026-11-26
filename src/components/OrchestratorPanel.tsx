/**
 * OrchestratorPanel - ATLAS, the fast front-of-house companion (voice-UX restructure
 * 2026-07-07; formerly "Helper").
 *
 * The deep MISSION input (DumpBox) files + executes + builds + answers. This is the
 * small SEPARATE fast surface for simple questions that should NOT spawn tasks or a
 * mission - pure ask() to the selected brain, answering what's next / how a lane is
 * doing, and flying the camera to the node it names. It shares Praxis's memory and
 * context (ask() assembles the same live context the deep lane sees) so Atlas and
 * Praxis answer from the same knowledge. It deliberately does NOT run control
 * commands or kick off builds: those belong to Mission.
 *
 * ⭐ This is also where the SPOKEN conversation lives.
 *
 * The turns were already being written: atlasChatBridge has been mirroring both
 * halves of every voice turn into `agent-chats/atlas.jsonl` all along. Nothing told
 * this panel, so it sat on a stale canned greeting while the owner talked to it. It now
 * loads that thread on mount and appends each new turn the moment the bridge
 * announces it (ATLAS_TURN_EVENT) - no second store, one thread, live.
 *
 * Same HUD v2 / Command Center design language + expand/collapse as the Mission
 * input, from the same bottom-left anchor, so the two capture surfaces are a family.
 */

import "@/styles/orch.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { usePraxisStore, type ChatMsg } from "@/store/usePraxisStore";
import { Markdown } from "@/markdown/Markdown";
import { buildGraph } from "@/data/graph";
import {
  ATLAS_TURN_EVENT,
  ATLAS_TURN_TAURI_EVENT,
  ATLAS_CHAT_CLEARED_THROUGH_KEY,
  ATLAS_CHAT_CLEAR_EVENT,
  ATLAS_CHAT_CLEAR_TAURI_EVENT,
  clearAtlasChat,
  coerceAtlasChatClear,
  coerceAtlasTurn,
  loadAtlasThread,
  readAtlasChatClearedThrough,
  turnsSinceAtlasChatClear,
  type AtlasTurn,
} from "@/voice/atlasChatBridge";

const QUICK = ["what's next?", "status", "catalyzed?", "what shipped?"];

/** Ceiling on rendered turns. A long continuous conversation must not grow this
 *  list without bound; the full thread stays on disk either way. */
const MAX_TURNS = 200;

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * Atlas's persisted conversation, live.
 *
 * Loads the thread once on mount, then appends every announced turn. Turns that
 * arrive DURING the load are buffered and flushed after it, so a fast first sentence
 * can't be swallowed by the read that was already in flight (and can't be
 * double-rendered either - anything announced after mount is newer than the file by
 * construction).
 */
function useAtlasThread(onCleared: () => void): SeqTurn[] {
  const [turns, setTurns] = useState<SeqTurn[]>([]);
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;

  useEffect(() => {
    let alive = true;
    let loaded = false;
    let seq = 0;
    let pending: SeqTurn[] = [];
    let clearedThrough = readAtlasChatClearedThrough();
    if (clearedThrough > 0) onClearedRef.current();
    // Render keys come from this counter, not the array index: trimming to
    // MAX_TURNS shifts every index, which would remount the whole list mid-sentence.
    const withSeq = (t: AtlasTurn): SeqTurn => ({ ...t, seq: seq++ });

    const push = (turn: AtlasTurn | null) => {
      if (!turn || !alive) return;
      if (turn.ts < clearedThrough) return;
      if (!loaded) {
        pending.push(withSeq(turn));
        return;
      }
      setTurns((prev) => [...prev, withSeq(turn)].slice(-MAX_TURNS));
    };

    // A `typed` turn announced in THIS window is already on screen from the store's
    // chat, which renders the typed lane; drawing the announcement too showed every
    // typed line twice. Typed turns from other windows arrive over Tauri and still show.
    const onLocal = (e: Event) => {
      const turn = coerceAtlasTurn((e as CustomEvent<AtlasTurn>).detail);
      if (turn?.meta === "typed") return;
      push(turn);
    };
    window.addEventListener(ATLAS_TURN_EVENT, onLocal);

    const applyClear = (clear: ReturnType<typeof coerceAtlasChatClear>) => {
      if (!clear || clear.clearedThrough <= clearedThrough || !alive) return;
      clearedThrough = clear.clearedThrough;
      pending = pending.filter((turn) => turn.ts >= clearedThrough);
      setTurns((prev) => prev.filter((turn) => turn.ts >= clearedThrough));
      onClearedRef.current();
    };
    const onLocalClear = (e: Event) => applyClear(coerceAtlasChatClear((e as CustomEvent<unknown>).detail));
    const onStorageClear = (e: StorageEvent) => {
      if (e.key !== ATLAS_CHAT_CLEARED_THROUGH_KEY) return;
      applyClear(coerceAtlasChatClear({ clearedThrough: Number(e.newValue) }));
    };
    window.addEventListener(ATLAS_CHAT_CLEAR_EVENT, onLocalClear);
    window.addEventListener("storage", onStorageClear);

    // Cross-window twin: today the session and this panel share the brain window, so
    // this path is quiet - but it means the panel stays correct wherever it mounts.
    let off: (() => void) | undefined;
    let offClear: (() => void) | undefined;
    if (inTauri()) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen<unknown>(ATLAS_TURN_TAURI_EVENT, (e) => push(coerceAtlasTurn(e.payload))))
        .then((f) => {
          off = f;
        })
        .catch(() => {
          /* not inside the Tauri shell */
        });
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen<unknown>(ATLAS_CHAT_CLEAR_TAURI_EVENT, (e) => applyClear(coerceAtlasChatClear(e.payload))))
        .then((f) => {
          offClear = f;
        })
        .catch(() => {
          /* not inside the Tauri shell */
        });
    }

    void loadAtlasThread().then((history) => {
      if (!alive) return;
      // History first (it is older by construction), then anything spoken while the
      // read was in flight - so a fast opening sentence is never swallowed.
      const seeded = [
        ...turnsSinceAtlasChatClear(history, clearedThrough).map(withSeq),
        ...pending.filter((turn) => turn.ts >= clearedThrough),
      ];
      loaded = true;
      setTurns(seeded.slice(-MAX_TURNS));
      pending = [];
    });

    return () => {
      alive = false;
      window.removeEventListener(ATLAS_TURN_EVENT, onLocal);
      window.removeEventListener(ATLAS_CHAT_CLEAR_EVENT, onLocalClear);
      window.removeEventListener("storage", onStorageClear);
      off?.();
      offClear?.();
    };
  }, []);

  return turns;
}

/**
 * When each typed message first appeared, so spoken and typed turns interleave in
 * the order they actually happened. ChatMsg carries no timestamp and the store is
 * out of this lane's reach, so the panel stamps arrivals itself; whatever was
 * already in the store at first render (the greeting) sorts to the top.
 */
function useTypedArrivals(chat: ChatMsg[], resetNonce: number): Map<number, number> {
  const stamps = useRef(new Map<number, number>());
  const first = useRef(true);
  const resetAt = useRef(resetNonce);
  if (resetAt.current !== resetNonce) {
    stamps.current.clear();
    first.current = true;
    resetAt.current = resetNonce;
  }
  for (const m of chat) {
    if (!stamps.current.has(m.id)) stamps.current.set(m.id, first.current ? 0 : Date.now());
  }
  first.current = false;
  return stamps.current;
}

/** A spoken turn plus a stable render key. `seq` orders nothing - `ts` does. */
type SeqTurn = AtlasTurn & { seq: number };

/** One rendered row - a typed exchange or a spoken one, on one timeline. */
type Row =
  | { kind: "typed"; key: string; at: number; msg: ChatMsg }
  | { kind: "voice"; key: string; at: number; turn: SeqTurn };

/**
 * Resolution tags worth showing. A spoken line from the owner is always tagged so the
 * conversation visibly IS the voice one; an Atlas reply is tagged only when the
 * router did something more specific than answer (ran a command, refused, filed a
 * to-do), because "atlas said this" is the default in the Atlas panel and labelling
 * every line with it would be noise.
 */
function tagFor(turn: AtlasTurn): string | null {
  if (turn.role === "zach") return "spoken";
  const meta = turn.meta;
  if (!meta || meta === "atlas" || meta === "answer") return null;
  return meta;
}

const voiceTagStyle: React.CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--fs-xs)",
  fontWeight: 600,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "color-mix(in srgb, var(--base-cool) 58%, transparent)",
};

/** Live window size so the panel animates between REAL pixel targets - motion can't
 *  smoothly tween min()/calc() strings (it snaps), which was the "shoots to the top
 *  then drops then opens sideways" jank. Numbers tween cleanly. */
function useWindowSize() {
  const [size, setSize] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1920,
    h: typeof window !== "undefined" ? window.innerHeight : 1080,
  }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
  // ⤢ (expand, arrows pointing out to corners) / ⤡ (collapse, arrows pointing in)
  return expanded ? (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M10 6L14 2M14 2H10.5M14 2V5.5M6 10L2 14M2 14H5.5M2 14V10.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9 7L14 2M14 2H10M14 2V6M7 9L2 14M2 14H6M2 14V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 3L13 13M13 3L3 13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5h10M6 4.5V3.2h4v1.3M5 6.5v5.2M8 6.5v5.2M11 6.5v5.2M4.4 4.5l.5 8.3h6.2l.5-8.3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OrchestratorPanel() {
  const open = usePraxisStore((s) => s.chatOpen);
  const chat = usePraxisStore((s) => s.chat);
  const atlasChatResetNonce = usePraxisStore((s) => s.atlasChatResetNonce);
  const resetAtlasChat = usePraxisStore((s) => s.resetAtlasChat);
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearNotice, setClearNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const g = useMemo(() => buildGraph(), [graphVersion]);
  const { w: winW, h: winH } = useWindowSize();

  // The spoken lane, merged into the typed one on a single timeline.
  const voiceTurns = useAtlasThread(resetAtlasChat);
  const arrivals = useTypedArrivals(chat, atlasChatResetNonce);
  const rows = useMemo<Row[]>(() => {
    const merged: Row[] = [
      ...chat.map((m) => ({ kind: "typed" as const, key: `t${m.id}`, at: arrivals.get(m.id) ?? 0, msg: m })),
      ...voiceTurns.map((t) => ({ kind: "voice" as const, key: `v${t.seq}`, at: t.ts, turn: t })),
    ];
    // Stable sort: equal timestamps keep insertion order, so a turn's two halves
    // never flip (Atlas answering before the owner asked would read as nonsense).
    return merged.sort((a, b) => a.at - b.at);
  }, [chat, voiceTurns, arrivals]);

  // real pixel targets (numbers tween cleanly; min()/calc() strings snapped)
  // expanded top edge stops at 120px below the window top - the old winH-96 poked
  // past the visible top when the HUD ran inside the fit-scaled 1080 canvas
  const dims = expanded
    ? { width: Math.min(Math.round(winW * 0.64), 900), height: winH - 132 }
    : { width: 340, height: Math.min(540, winH - 140) };

  // Follow the newest turn.
  //
  // This used to ask for `behavior: "smooth"`, which does NOTHING here: the list
  // lives inside a motion.aside that holds a transform while it animates, and
  // Chromium drops a smooth-scroll animation on a descendant of one. Measured live -
  // an instant scrollTop assignment reached the bottom, the smooth request left it at
  // 0. The result was a panel showing the TOP of a conversation that had moved on,
  // intermittently enough to look like a ghost. Pin it directly instead.
  //
  // Pinned only while the owner is already at the bottom: if he has scrolled up to re-read
  // something, a new spoken line must not yank him back down mid-sentence.
  const pinnedRef = useRef(true);
  useEffect(() => {
    const pin = () => {
      const el = listRef.current;
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    };
    pin(); // after React's commit - reading scrollHeight forces layout
    const raf = requestAnimationFrame(pin); // again once the open/expand tween lands
    return () => cancelAnimationFrame(raf);
  }, [rows, open, expanded]);

  const send = (text: string) => {
    const v = text.trim();
    if (!v) return;
    setQ("");
    // Atlas is PURE ask() - a simple question answered by the selected brain, with
    // NO side effects: it never files a note, runs a control command, or kicks off a
    // build. Anything that should DO or BUILD or FILE belongs in the Mission input
    // (DumpBox → submit()), which fans out across every faculty. Keeping Atlas
    // answer-only is the whole reason it exists: a fast lookup that can't spawn work.
    usePraxisStore.getState().ask(v);
  };

  // focusJourney also parks the arrow-key scrub on the node, so the next
  // ← / → continues the story from where the planner just took you
  const flyTo = (refId: string) => usePraxisStore.getState().focusJourney(refId);

  const startFresh = async () => {
    if (clearing) return;
    setClearing(true);
    setClearNotice(null);
    try {
      const result = await clearAtlasChat();
      setQ("");
      setClearNotice(result.syncError
        ? { kind: "error", text: `Started fresh here, but couldn't update other open Praxis windows: ${result.syncError}` }
        : { kind: "success", text: "Fresh Atlas chat started. Older messages are hidden here and remain in the original transcript." });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setClearNotice({ kind: "error", text: detail || "Couldn't start a fresh Atlas chat." });
    } finally {
      setClearing(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="orch2"
          initial={{ opacity: 0, x: -24, width: 340, height: Math.min(540, winH - 140) }}
          animate={{ opacity: 1, x: 0, width: dims.width, height: dims.height }}
          exit={{ opacity: 0, x: -24 }}
          transition={{
            // width + height grow TOGETHER on one smooth easeOut curve - no spring
            // overshoot (that was the "shoots too high then drops" bounce), so it
            // reads as a single clean diagonal drag-out from the bottom-left anchor.
            opacity: { duration: 0.18 },
            x: { type: "spring", stiffness: 320, damping: 34 },
            width: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
            height: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
          }}
        >
          <header className="orch2-head">
            <span className="orch2-tick" aria-hidden />
            <div className="orch2-titles">
              <span className="orch2-label">Atlas</span>
              <span className="orch2-caption">fast companion · answers now, spawns nothing</span>
            </div>
            <div className="orch2-headbtns">
              <button
                className="orch2-iconbtn"
                onClick={() => void startFresh()}
                disabled={clearing}
                aria-label="Clear visible Atlas chat history and start fresh"
                aria-busy={clearing || undefined}
                title="Start fresh — hide visible chat history"
              >
                <ClearIcon />
              </button>
              <button
                className="orch2-iconbtn"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? "Collapse Atlas panel" : "Expand Atlas panel"}
                title={expanded ? "Collapse" : "Expand"}
              >
                <ExpandIcon expanded={expanded} />
              </button>
              <button
                className="orch2-iconbtn"
                onClick={() => usePraxisStore.getState().setChatOpen(false)}
                aria-label="Close Atlas panel"
                title="Close"
              >
                <CloseIcon />
              </button>
            </div>
          </header>

          <div
            className="orch2-list"
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              // Within a bubble's height of the end still counts as "following".
              pinnedRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48;
            }}
          >
            {clearNotice && (
              <div className={`orch2-clear-notice is-${clearNotice.kind}`} role={clearNotice.kind === "error" ? "alert" : "status"}>
                {clearNotice.text}
              </div>
            )}
            {rows.length === 0 && (
              <section className="orch2-empty" aria-live="polite">
                <span className="orch2-empty-kicker">new thread</span>
                <p>Start a fresh conversation with Atlas.</p>
                <span>New typed and spoken turns will appear here.</span>
              </section>
            )}
            {rows.map((row) => {
              if (row.kind === "typed") {
                const m = row.msg;
                return (
                  <div key={row.key} className={`orch2-msg from-${m.role}`}>
                    {m.role === "orch" ? (
                      <div className="orch2-bubble">
                        <Markdown text={m.text} />
                      </div>
                    ) : (
                      <p className="orch2-bubble">{m.text}</p>
                    )}
                    {m.refId && g.byId.has(m.refId) && (
                      <button className="orch2-fly" onClick={() => flyTo(m.refId!)}>
                        fly to “{g.byId.get(m.refId)!.label}” →
                      </button>
                    )}
                  </div>
                );
              }
              // Spoken turn - same bubble language as the typed lane (the owner right,
              // Atlas left), with a small tag so the voice conversation reads as
              // itself rather than as something he typed.
              const t = row.turn;
              const mine = t.role === "zach";
              const tag = tagFor(t);
              return (
                <div key={row.key} className={`orch2-msg from-${mine ? "you" : "orch"}`}>
                  {tag && (
                    <span style={{ ...voiceTagStyle, alignSelf: mine ? "flex-end" : "flex-start" }}>{tag}</span>
                  )}
                  {mine ? (
                    <p className="orch2-bubble">{t.text}</p>
                  ) : (
                    <div className="orch2-bubble">
                      <Markdown text={t.text} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="orch2-quick">
            {QUICK.map((s) => (
              <button key={s} className="orch2-chip" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>

          <div className="orch2-inputrow">
            <input
              className="orch2-input"
              value={q}
              placeholder="ask a quick question…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send(q)}
            />
            <button className="orch2-send" onClick={() => send(q)} disabled={q.trim().length === 0}>
              ↵
            </button>
          </div>

          <footer className="orch2-foot">
            <span className="dim">answer-only · to file, do, or build, hand it to Mission</span>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
