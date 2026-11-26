/**
 * inboxStore - the Command Center INBOX: everything Praxis needs the owner to see,
 * aggregated from REAL sources only (rule from the design handoff: short → inline
 * row, long/structured → document overlay). No fabricated items, ever.
 *
 * Sources today:
 *   • Board-meeting digest - localStorage `praxis.board.v1` (written by the main
 *     window's 6am scheduler / manual regenerate). Big report → document overlay,
 *     from "AGENT BOARD". This is board-meeting v2's surface: the doc renders the
 *     synthesized digest AND the per-agent statements section.
 *   • Atlas org-report - latest `org-report-*.md`, read via the SAME
 *     `board_meeting_gather` command the board pipeline uses (local IO only).
 *   • Sage research inbox - `research-inbox.md` via the same gather call.
 *   • Hermes health - `praxis://hermes-degraded` transitions as small rows.
 *   • Delivered - each Mission `result` (and an unresolved `failure`, as
 *     "needs you") from the Mission thread (`agent-chats/mission.jsonl`), from "PRAXIS":
 *     the mission title, when, the summary line, and the same Open preview / folder /
 *     file actions the Mission chat shows. Live via `subscribeMission`.
 *
 * Read/unread persists per item id in `praxis.inbox.read.v1`. Dismissed ids persist
 * in `praxis.inbox.dismissed.v1` (newest 500). A dismissed row leaves every inbox
 * surface; the Hermes health row is not a message and is not dismissable.
 * Refreshes on mount, then every 60s, plus instantly when the board cache or either
 * inbox set changes - the storage event in other windows, and `praxis://inbox-changed`
 * so a second open window updates even when storage doesn't cross the webview.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mirrorSet } from "@/shared/persist";
import { visibleInterval } from "@/shared/visibility";
import {
  groupMissions,
  subscribeMission,
  type MissionArtifact,
  type MissionMsg,
} from "@/orchestrator/missionThread";
import { STOPPED_BY_ZACH_RE, mergeThread, summaryLine, whenLabel } from "@/components/mission/missionLogic";
import { loadThreadShared } from "@/components/mission/threadLoad";
import { C } from "./ccTheme";

// ------------------------------------------------------------------ types ---

export interface DocPara {
  t: string;
  mark: string; // "▲" warning · "◆" decision/recommendation · "" plain
  markColor: string;
}

export interface DocSection {
  h: string;
  hColor: string;
  ps: DocPara[];
}

export interface InboxDoc {
  dot: string;
  from: string;
  time: string;
  title: string;
  meta: string;
  sections: DocSection[];
  /** Which pipeline produced it - the overlay footer uses this (board gets Regenerate).
   *  "node" = a live brain-node dossier pulled out of the Inspector on demand. */
  kind: "board" | "org" | "research" | "node";
}

export interface InboxItem {
  id: string;
  from: string;
  text: string;
  time: string;
  unread: boolean;
  dotColor: string;
  doc?: InboxDoc;
  /** Headline above `text` - a delivered mission's title. */
  title?: string;
  /** Small source tag beside `from`: "DELIVERED" · "NEEDS YOU". */
  tag?: string;
  /** Real things to open (a delivered mission's preview / folder / file). */
  actions?: MissionArtifact[];
}

// ---------------------------------------------------------------- helpers ---

const READ_KEY = "praxis.inbox.read.v1";
const DISMISSED_KEY = "praxis.inbox.dismissed.v1";
const BOARD_KEY = "praxis.board.v1";
/** Years of read ids must not accrete. Newest stay. */
const READ_CAP = 200;
/** Same idea for deletes - a cleared inbox from months ago should not hide a new row
 *  that happens to reuse an old id, and it must not grow without a bound. */
export const DISMISSED_CAP = 500;
/** Live engine warning. It leaves when Hermes recovers; the owner cannot delete it. */
export const HERMES_INBOX_ID = "hermes-degraded";
/** Tauri broadcast. Listeners re-read localStorage and must not emit this again. */
export const INBOX_CHANGED_EVENT = "praxis://inbox-changed";
/**
 * Same-window ping. `storage` does not fire in the window that wrote the key, and
 * the Command Center panel writes through the helpers below while App owns the one
 * `useInbox`. A microtask (not a sync dispatch) so we never setState inside an updater.
 */
const INBOX_LOCAL_EVENT = "praxis-inbox-local";

export function isInboxDismissable(id: string): boolean {
  return id.length > 0 && id !== HERMES_INBOX_ID;
}

/** One calendar day, one board row - dismissing today's digest must not hide tomorrow's. */
export function boardInboxId(date: string): string {
  return `board-${date}`;
}

function loadIdList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const id of parsed) {
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

function readSet(): Set<string> {
  return new Set(loadIdList(READ_KEY));
}

function dismissedSet(): Set<string> {
  return new Set(loadIdList(DISMISSED_KEY));
}

function writeIdList(key: string, ids: readonly string[]): void {
  try {
    const body = JSON.stringify(ids);
    localStorage.setItem(key, body);
    mirrorSet(key, body);
  } catch {
    /* best-effort */
  }
}

function persistRead(set: Set<string>): void {
  writeIdList(READ_KEY, [...set].slice(-READ_CAP));
  publishInboxChanged();
}

/**
 * Newest ids win the cap. Ids in `incoming` are the newest - dismissing one that
 * was already stored moves it to the end so the cap trims something older.
 */
export function keepNewestIds(existing: readonly string[], incoming: readonly string[], cap: number): string[] {
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const id of incoming) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    fresh.push(id);
  }
  const kept: string[] = [];
  const seenKept = new Set<string>();
  for (const id of existing) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id) || seenKept.has(id)) continue;
    seenKept.add(id);
    kept.push(id);
  }
  return [...kept, ...fresh].slice(-cap);
}

/** Dismissed-set math with the Hermes id stripped. Pure - no storage, no React. */
export function nextDismissed(existing: readonly string[], incoming: readonly string[], cap = DISMISSED_CAP): string[] {
  return keepNewestIds(existing.filter(isInboxDismissable), incoming.filter(isInboxDismissable), cap);
}

export function withoutDismissed<T extends { id: string }>(items: readonly T[], dismissed: ReadonlySet<string>): T[] {
  return items.filter((item) => !dismissed.has(item.id) || !isInboxDismissable(item.id));
}

/** What `clearRead` removes: already-read rows, never the health warning. */
export function dismissableReadIds(items: readonly { id: string; unread: boolean }[]): string[] {
  return items.filter((item) => isInboxDismissable(item.id) && !item.unread).map((item) => item.id);
}

/** What `clearAll` / mark-all-read may touch. */
export function dismissableIds(items: readonly { id: string }[]): string[] {
  return items.filter((item) => isInboxDismissable(item.id)).map((item) => item.id);
}

/** Rows still shown after the persisted dismissed set is applied. */
export function visibleInboxItems<T extends { id: string }>(items: readonly T[]): T[] {
  return withoutDismissed(items, dismissedSet());
}

function publishInboxChanged(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    queueMicrotask(() => {
      try {
        window.dispatchEvent(new Event(INBOX_LOCAL_EVENT));
      } catch {
        /* test harness without a real Event */
      }
    });
  }
  void broadcastInboxChanged();
}

async function broadcastInboxChanged(): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(INBOX_CHANGED_EVENT, {});
  } catch {
    /* dev browser - the storage event still covers other same-origin windows */
  }
}

/** Delete one row and mark it read. The Hermes id is refused and nothing is written. */
export function commitDismiss(id: string): boolean {
  if (!isInboxDismissable(id)) return false;
  writeIdList(DISMISSED_KEY, nextDismissed(loadIdList(DISMISSED_KEY), [id]));
  writeIdList(READ_KEY, keepNewestIds(loadIdList(READ_KEY), [id], READ_CAP));
  publishInboxChanged();
  return true;
}

/** Dismiss these ids. Does not mark them read - clear-all must come back as it was. */
export function commitDismissMany(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.filter(isInboxDismissable))];
  if (unique.length === 0) return [];
  writeIdList(DISMISSED_KEY, nextDismissed(loadIdList(DISMISSED_KEY), unique));
  publishInboxChanged();
  return unique;
}

export function commitMarkAllRead(ids: readonly string[]): void {
  const accepted = ids.filter(isInboxDismissable);
  if (accepted.length === 0) return;
  writeIdList(READ_KEY, keepNewestIds(loadIdList(READ_KEY), accepted, READ_CAP));
  publishInboxChanged();
}

/** Put ids back. A single delete also marked the row read, and that mark stays. */
export function commitRestore(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  writeIdList(
    DISMISSED_KEY,
    loadIdList(DISMISSED_KEY).filter((id) => !drop.has(id)),
  );
  publishInboxChanged();
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Short calendar date, e.g. "2026-07-09". */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Pull a YYYY-MM-DD out of a report filename like "org-report-2026-07-08.md". */
function dateFromFile(file: string): string | null {
  const m = file.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// ------------------------------------------------- markdown → doc sections ---

/**
 * Parse a board-meeting digest (## sections + bullets, then "## Agent statements"
 * with ### per-agent blocks) into document-overlay sections. Purely mechanical -
 * unknown shapes degrade to one plain section, never an error.
 */
export function digestToSections(markdown: string): DocSection[] {
  const out: DocSection[] = [];
  const lines = markdown.split(/\r?\n/);
  let current: DocSection | null = null;
  let inStatements = false;

  const sectionColor = (h: string): string => {
    const l = h.toLowerCase();
    if (l.includes("needs zach") || l.includes("warning")) return "rgba(232,80,157,.8)";
    if (l.includes("decision") || l.includes("recommend")) return "rgba(142,203,255,.85)";
    if (l.includes("agent statements")) return "rgba(73,160,244,.8)";
    return "rgba(233,226,211,.5)";
  };

  const markFor = (h: string): { mark: string; markColor: string } => {
    const l = h.toLowerCase();
    if (l.includes("needs zach") || l.includes("warning")) return { mark: "▲", markColor: "rgba(232,80,157,.8)" };
    if (l.includes("decision") || l.includes("recommend")) return { mark: "◆", markColor: "rgba(73,160,244,.8)" };
    return { mark: "", markColor: "transparent" };
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h2 = line.match(/^##\s+(.+)$/);
    const h3 = line.match(/^###\s+(.+)$/);
    if (h2) {
      inStatements = /agent statements/i.test(h2[1]);
      current = { h: h2[1].toUpperCase(), hColor: sectionColor(h2[1]), ps: [] };
      out.push(current);
      continue;
    }
    if (h3 && inStatements) {
      // Each agent's statement becomes its own subsection so "who said what" scans.
      current = { h: h3[1].toUpperCase(), hColor: "rgba(73,160,244,.8)", ps: [] };
      out.push(current);
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const text = bullet ? bullet[1] : line.trim();
    if (!text || !current) continue;
    const { mark, markColor } = bullet ? markFor(current.h) : { mark: "", markColor: "transparent" };
    current.ps.push({ t: text, mark, markColor });
  }

  if (out.length === 0 && markdown.trim()) {
    out.push({
      h: "DIGEST",
      hColor: "rgba(233,226,211,.5)",
      ps: [{ t: markdown.trim().slice(0, 2000), mark: "", markColor: "transparent" }],
    });
  }
  return out;
}

/** Plain markdown (org report / research inbox) → sections: headings split, bullets kept. */
function plainMarkdownToSections(markdown: string, fallbackTitle: string): DocSection[] {
  const sections = digestToSections(markdown);
  if (sections.length === 1 && sections[0].h === "DIGEST") sections[0].h = fallbackTitle;
  return sections;
}

// ---------------------------------------------------------- source readers ---

interface StoredBoard {
  date: string;
  digestMarkdown: string;
  path: string;
  generatedAtMs: number;
}

function boardItem(read: Set<string>): InboxItem | null {
  try {
    const raw = localStorage.getItem(BOARD_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as StoredBoard;
    if (!b?.digestMarkdown) return null;
    // Date-scoped on purpose: dismissing Monday's digest must not hide Tuesday's.
    // A missing `date` still falls back to the generation day so two digests don't share one id.
    const date = b.date || fmtDate(b.generatedAtMs);
    const id = boardInboxId(date);
    return {
      id,
      from: "AGENT BOARD",
      text: `daily board meeting is in — every agent reported via its own provider.`,
      // freshness reads at a glance from the date; the doc header carries the full stamp
      time: date,
      unread: !read.has(id),
      dotColor: C.pink,
      doc: {
        dot: C.pink,
        from: "AGENT BOARD",
        time: `${date} · ${fmtClock(b.generatedAtMs)}`,
        title: "Daily board meeting — fleet digest",
        meta: "SYNTHESIZED BY THE BRAIN · STATEMENTS BY EACH AGENT · FILED TO THE VAULT",
        sections: digestToSections(b.digestMarkdown),
        kind: "board",
      },
    };
  } catch {
    return null;
  }
}

/** The id of the board digest currently in localStorage, if one is cached. */
export function currentBoardInboxId(): string | null {
  return boardItem(new Set())?.id ?? null;
}

/** Wire shape subset of `board_meeting_gather` (board_meeting.rs BoardInputs). */
interface GatherSubset {
  research_inbox: string;
  research_inbox_present: boolean;
  latest_org_report: string;
  latest_org_report_file: string;
}

async function gatherItems(read: Set<string>): Promise<InboxItem[]> {
  if (!inTauri()) return [];
  // Store-observation time - the fallback stamp for sources that carry no timestamp
  // of their own (spec: never render a blank date; if truly absent, use the mtime we
  // saw it at). Captured once per gather so every backfilled item agrees.
  const nowMs = Date.now();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const g = await invoke<GatherSubset>("board_meeting_gather");
    const items: InboxItem[] = [];

    if (g.latest_org_report.trim() && g.latest_org_report_file) {
      const id = `org-${g.latest_org_report_file}`;
      const orgDate = dateFromFile(g.latest_org_report_file) ?? fmtDate(nowMs);
      items.push({
        id,
        from: "ATLAS",
        text: "organization sweep report is ready — dry run, nothing touched.",
        time: orgDate,
        unread: !read.has(id),
        dotColor: C.emerald,
        doc: {
          dot: C.emerald,
          from: "ATLAS",
          time: `${orgDate} · ${g.latest_org_report_file}`,
          title: "Organization sweep — proposed cleanup",
          meta: "DRY RUN · NOTHING MOVED WITHOUT YOUR OK",
          sections: plainMarkdownToSections(g.latest_org_report, "REPORT"),
          kind: "org",
        },
      });
    }

    if (g.research_inbox_present && g.research_inbox.trim()) {
      // Stable-ish id from content length + first line so a NEW batch reads unread.
      const first = g.research_inbox.trim().split("\n")[0]?.slice(0, 40) ?? "";
      const id = `research-${g.research_inbox.length}-${first.replace(/\W+/g, "").slice(0, 16)}`;
      items.push({
        id,
        from: "SAGE",
        text: "new research ideas are in the inbox — worth a skim.",
        // the research inbox carries no per-item timestamp → stamp with the observation
        // date so the row is never blank / never a bare "inbox" (spec: always a date)
        time: fmtDate(nowMs),
        unread: !read.has(id),
        dotColor: C.sapphire,
        doc: {
          dot: C.sapphire,
          from: "SAGE",
          time: `research-inbox.md · ${fmtDate(nowMs)}`,
          title: "Research inbox — new ideas",
          meta: "FROM THE WATCHED SOURCES · FILED BY THE RESEARCH LANE",
          sections: plainMarkdownToSections(g.research_inbox, "IDEAS"),
          kind: "research",
        },
      });
    }

    return items;
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- delivered ---

/** How many delivered / needs-you rows the inbox keeps (newest first). */
const DELIVERED_LIMIT = 12;

/**
 * Mission thread → inbox rows. Every `result` becomes a "DELIVERED" row; a mission whose
 * LAST word is a `failure` becomes one "NEEDS YOU" row (a failure that a later result
 * resolved is not a thing waiting on the owner) - unless a LATER mission for the same request
 * (same title) was delivered: asking again and getting it supersedes the old failure
 * (live 2026-10-01, two stale NEEDS YOU rows sat under the delivered site). Pure: the
 * thread in, rows out - nothing is invented, so a quiet thread means no rows.
 */
export function deliveredItems(
  msgs: MissionMsg[],
  read: Set<string>,
  now: number = Date.now(),
  limit: number = DELIVERED_LIMIT,
): InboxItem[] {
  const rows: { at: number; item: InboxItem }[] = [];
  const row = (m: MissionMsg, title: string, kind: "delivered" | "needs-you"): void => {
    const id = kind === "delivered" ? `delivered-${m.id}` : `needs-you-${m.id}`;
    rows.push({
      at: m.ts,
      item: {
        id,
        from: "PRAXIS",
        title,
        text: summaryLine(m.text),
        time: whenLabel(m.ts, now),
        unread: !read.has(id),
        dotColor: kind === "delivered" ? C.emerald : C.pink,
        tag: kind === "delivered" ? "DELIVERED" : "NEEDS YOU",
        ...(m.artifacts && m.artifacts.length ? { actions: m.artifacts.map((a) => ({ ...a })) } : {}),
      },
    });
  };
  const groups = groupMissions(msgs);
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const deliveredAt = new Map<string, number>();
  for (const g of groups) {
    for (const m of g.msgs) {
      if (m.kind !== "result") continue;
      const k = norm(g.title);
      deliveredAt.set(k, Math.max(deliveredAt.get(k) ?? 0, m.ts));
    }
  }
  for (const g of groups) {
    for (const m of g.msgs) if (m.kind === "result") row(m, g.title, "delivered");
    if (g.status === "failed") {
      const failures = g.msgs.filter((m) => m.kind === "failure");
      const last = failures[failures.length - 1];
      // A mission the owner stopped himself is not waiting on him (live 2026-10-10: Stop
      // produced a pink NEEDS YOU row for the thing he had just cancelled).
      const stoppedByZach = !!last && STOPPED_BY_ZACH_RE.test(last.text);
      if (last && !stoppedByZach && !((deliveredAt.get(norm(g.title)) ?? 0) > last.ts)) row(last, g.title, "needs-you");
    }
  }
  return rows
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((r) => r.item);
}

// ------------------------------------------------------------------- hook ---

export interface InboxStore {
  items: InboxItem[];
  unreadCount: number;
  markRead: (id: string) => void;
  /** Delete one row. Also marks it read. No-op for the Hermes health row. */
  dismiss: (id: string) => void;
  markAllRead: () => void;
  /** Dismiss every row that is already read. Returns those ids (for undo). */
  clearRead: () => string[];
  /** Dismiss every message row. Returns the ids so the UI can undo. */
  clearAll: () => string[];
  /** Undo the last delete or clear. Puts those ids back; does not re-emit by itself beyond the write. */
  restore: (ids: readonly string[]) => void;
  refresh: () => void;
}

/** "N deleted · UNDO" - about six seconds, then the offer expires. Last action wins. */
const UNDO_MS = 6000;

export function useInboxUndo(restore: (ids: readonly string[]) => void): {
  count: number;
  visible: boolean;
  arm: (ids: readonly string[]) => void;
  undo: () => void;
} {
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const idsRef = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const arm = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    if (timer.current) clearTimeout(timer.current);
    idsRef.current = [...ids];
    setCount(ids.length);
    timer.current = setTimeout(() => {
      timer.current = null;
      idsRef.current = [];
      setCount(0);
    }, UNDO_MS);
  }, []);

  const undo = useCallback(() => {
    const ids = idsRef.current;
    idsRef.current = [];
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setCount(0);
    if (ids.length > 0) restoreRef.current(ids);
  }, []);

  return { count, visible: count > 0, arm, undo };
}

export function useInbox(hermes: { degraded: boolean; reason: string } | null): InboxStore {
  const [read, setRead] = useState<Set<string>>(readSet);
  const [dismissed, setDismissed] = useState<Set<string>>(dismissedSet);
  const [items, setItems] = useState<InboxItem[]>([]);
  // The Mission thread: what Praxis has delivered. Read ONCE on mount (the file only grows,
  // so it is not polled) and followed live, so a finished mission lands in the inbox the
  // moment it is announced.
  const [thread, setThread] = useState<MissionMsg[]>([]);

  // Re-read both sets and repaint unread flags. Does not emit - callers that wrote
  // already published, and a listener that published would ping-pong forever.
  const absorbSets = useCallback(() => {
    const r = readSet();
    setRead(r);
    setDismissed(dismissedSet());
    setItems((prev) => prev.map((n) => ({ ...n, unread: !r.has(n.id) })));
  }, []);

  const refresh = useCallback(() => {
    const r = readSet();
    setRead(r); // another window may have read items since this one last looked
    setDismissed(dismissedSet());
    void (async () => {
      // Re-read after the gather. A delete during the round-trip must not be
      // painted back on with the read-set snapshot from when the fetch started.
      const gathered = await gatherItems(readSet());
      const now = readSet();
      const base: InboxItem[] = [];
      const board = boardItem(now);
      if (board) base.push(board);
      for (const item of gathered) base.push({ ...item, unread: !now.has(item.id) });
      setItems(base);
      setRead(now);
      setDismissed(dismissedSet());
    })();
  }, []);

  useEffect(() => {
    let alive = true;
    void loadThreadShared().then((msgs) => {
      if (alive) setThread((prev) => mergeThread(msgs, prev));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    refresh();
    // Pause the 60s inbox gather while hidden; visibleInterval catches up on return.
    const stop = visibleInterval(refresh, 60_000);
    const onStorage = (e: StorageEvent) => {
      if (e.key === BOARD_KEY) refresh();
      else if (e.key === READ_KEY || e.key === DISMISSED_KEY) absorbSets();
    };
    const onLocal = () => absorbSets();
    window.addEventListener("storage", onStorage);
    window.addEventListener(INBOX_LOCAL_EVENT, onLocal);
    const offMission = subscribeMission((m) => setThread((prev) => mergeThread(prev, [m])));
    let unlisten: (() => void) | undefined;
    let dead = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen(INBOX_CHANGED_EVENT, () => absorbSets()))
      .then((off) => {
        if (dead) off();
        else unlisten = off;
      })
      .catch(() => {
        /* dev browser - storage + the local event still cover this window */
      });
    return () => {
      dead = true;
      stop();
      offMission();
      unlisten?.();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(INBOX_LOCAL_EVENT, onLocal);
    };
  }, [refresh, absorbSets]);

  const delivered = useMemo(() => deliveredItems(thread, read), [thread, read]);

  const markRead = useCallback((id: string) => {
    const next = new Set(readSet());
    next.add(id);
    persistRead(next);
    setRead(next);
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, unread: false } : n)));
  }, []);

  const visibleRef = useRef<InboxItem[]>([]);

  const dismiss = useCallback((id: string) => {
    if (!commitDismiss(id)) return;
    absorbSets();
  }, [absorbSets]);

  const markAllRead = useCallback(() => {
    commitMarkAllRead(dismissableIds(visibleRef.current));
    absorbSets();
  }, [absorbSets]);

  const clearRead = useCallback((): string[] => {
    const ids = commitDismissMany(dismissableReadIds(visibleRef.current));
    if (ids.length > 0) absorbSets();
    return ids;
  }, [absorbSets]);

  const clearAll = useCallback((): string[] => {
    const ids = commitDismissMany(dismissableIds(visibleRef.current));
    if (ids.length > 0) absorbSets();
    return ids;
  }, [absorbSets]);

  const restore = useCallback((ids: readonly string[]) => {
    commitRestore(ids);
    absorbSets();
  }, [absorbSets]);

  // Hermes degradation surfaces as a small (non-doc) row while active. Delivered work
  // comes next - it is the newest, most actionable thing Praxis has for the owner.
  // Dismissed ids drop out here so every consumer (dock, pull-out, Command Center,
  // the unread pip) sees one filtered list.
  const all = useMemo(() => {
    const merged: InboxItem[] = [];
    if (hermes?.degraded) {
      merged.push({
        id: HERMES_INBOX_ID,
        from: "HERMES",
        text: hermes.reason || "engine link degraded — retrying.",
        time: "now",
        unread: true,
        dotColor: C.pink,
      });
    }
    merged.push(...delivered, ...items);
    return withoutDismissed(merged, dismissed);
  }, [hermes, delivered, items, dismissed]);
  visibleRef.current = all;

  return {
    items: all,
    unreadCount: all.filter((n) => n.unread).length,
    markRead,
    dismiss,
    markAllRead,
    clearRead,
    clearAll,
    restore,
    refresh,
  };
}
