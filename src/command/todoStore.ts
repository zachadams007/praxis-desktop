/**
 * todoStore - Command Center to-do list state + persistence.
 *
 * Rules:
 *   - Max 5 upcoming items shown; refilled from the LIVE intent ledger
 *     (useMemoryTodos' "🔴 Open now" pull, see seedFromMemory()) as slots open -
 *     NOT a frozen static list.
 *   - Max 3 done items kept (most-recent); oldest done auto-vanishes.
 *   - completeTask(id) marks a task done - called by the orchestrator programmatically.
 *   - Tauri event `praxis://task-complete` with payload {id?, text?} also crosses off.
 *   - Source of truth: localStorage key `praxis.todo.v1`.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { mirrorSet } from "@/shared/persist";

// ------------------------------------------------------------------ types ---

export type TaskStatus = "upcoming" | "done";
export type TaskSource = "manual" | "roadmap" | "voice" | "memory";

export interface TodoTask {
  id: string;
  text: string;
  status: TaskStatus;
  source: TaskSource;
  createdAt: number;
  doneAt?: number;
}

// ---------------------------------------------------------------- constants ---

const STORAGE_KEY = "praxis.todo.v1";
const MAX_UPCOMING = 5;
const MAX_DONE = 3;

// ------------------------------------------------------------------ helpers ---

function uid(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function load(): TodoTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const tasks = JSON.parse(raw) as TodoTask[];
    // One-time migration (2026-07-10, CDP QA CC-MANIFEST): `source: "roadmap"` was the
    // old frozen-corpus seed (roadmapTasks(), see its doc comment) - retired 2026-07-09
    // in favor of seedFromMemory()'s live intent-ledger pull. Sessions that persisted
    // roadmap rows before that switch keep them forever (several are already-shipped
    // June relics) since enforce() never re-checks a task once it's in the list. Drop
    // them here so the MANIFEST always reflects the live ledger, not a frozen snapshot;
    // enforce() below immediately refills any freed slots from seedFromMemory().
    return tasks.filter((t) => t.source !== "roadmap");
  } catch {
    return [];
  }
}

/**
 * upcomingTaskTexts - the CURRENT crossable to-do items, read hook-free straight
 * from localStorage (Tauri webviews of the same app share one origin, so this is
 * safe from any window - same pattern as unattended.ts's readUpcomingTodos()).
 * This is the fuzzy-match corpus `orchestrator.ts#emitTaskComplete` scores a
 * completed goal against: matching only items actually ON the list guarantees
 * every match is crossable. (Replaced the frozen roadmapTasks() array 2026-07-09
 * - once MANIFEST seeding moved to the live intent ledger, roadmap matches named
 * items that no longer existed in the list, a permanent no-op.)
 */
export function upcomingTaskTexts(): { text: string }[] {
  const tasks = load();
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => t && t.status === "upcoming" && typeof t.text === "string" && t.text.trim())
    .map((t) => ({ text: t.text }));
}

function save(tasks: TodoTask[]): void {
  try {
    const body = JSON.stringify(tasks);
    localStorage.setItem(STORAGE_KEY, body);
    mirrorSet(STORAGE_KEY, body); // durable disk mirror - tasks must survive reboots
  } catch {
    /* best-effort - private/storage-full */
  }
}

/**
 * Enforce display constraints:
 *   - Drop upcoming "memory" tasks the LIVE ledger has already resolved.
 *   - Cap done list to MAX_DONE (keep newest by doneAt, drop oldest).
 *   - After dropping done/resolved items, refill upcoming from the LIVE intent ledger.
 */
export function enforce(tasks: TodoTask[], memoryItems: MemoryTodoItem[], ledgerState: LedgerState): TodoTask[] {
  const pruned = pruneResolvedMemory(tasks, memoryItems, ledgerState);

  const done = pruned
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));

  const trimmedDone = done.slice(0, MAX_DONE);
  const keptDoneIds = new Set(trimmedDone.map((t) => t.id));
  const upcoming = pruned.filter((t) => t.status === "upcoming");

  let next = [
    ...upcoming,
    ...pruned.filter((t) => t.status === "done" && keptDoneIds.has(t.id)),
  ];

  // Refill upcoming if slots opened up - from the live ledger, never a frozen list.
  next = seedFromMemory(next, memoryItems);
  return next;
}

/**
 * pruneResolvedMemory - drop upcoming, `source: "memory"` tasks the LIVE intent ledger no longer
 * lists (done, superseded, or moved to the owner's decisions). The ledger was reconciled 2026-09-27,
 * yet shipped items like "Deck design-token pass (259 hexes)" kept showing as open because
 * seedFromMemory/enforce only ever ADDED from the ledger, never re-checked a row once it was in
 * the list - the same failure class `load()`'s roadmap migration comment documents above.
 *
 * Matches the way seedFromMemory dedupes (trimmed, case-insensitive text), and never touches
 * "manual"/"voice" tasks or anything already "done".
 */
export function pruneResolvedMemory(
  tasks: TodoTask[],
  memoryItems: MemoryTodoItem[],
  ledgerState: LedgerState,
): TodoTask[] {
  if (ledgerState !== "live") return tasks;

  const liveTexts = new Set(
    memoryItems.map((item) => item.title.trim().toLowerCase()).filter(Boolean),
  );
  return tasks.filter((t) => {
    if (t.status !== "upcoming" || t.source !== "memory") return true;
    return liveTexts.has(t.text.trim().toLowerCase());
  });
}

// ----------------------------------------------------------------- hook ---

export interface TodoStore {
  upcoming: TodoTask[];
  done: TodoTask[];
  /** Whether the intent ledger behind the open slots could be READ. "unavailable"
   *  must never be rendered as "0 open" - the manifest used to do exactly that. */
  ledgerState: LedgerState;
  /** Add one or more tasks from a brain-dump string (splits on newlines / semicolons). */
  addBrainDump: (raw: string) => void;
  /** Add a SINGLE task verbatim (no splitting) with an explicit source - used by the
   *  Hybrid voice session so a spoken note lands as one to-do tagged "voice", and by
   *  "pull into list" on a memory-ledger item (source "memory"). */
  addTask: (text: string, source?: TaskSource) => void;
  /** Mark a task done. Called by orchestrator or Tauri event listener. */
  completeTask: (id: string) => void;
  /** Mark done by fuzzy-text match (for Tauri payload {text} without an id). */
  completeTaskByText: (text: string) => void;
  /** True when `text` is already present in the active list (any status) -
   *  used to disable "pull into list" for memory items already pulled. */
  hasTask: (text: string) => boolean;
}

export function useTodoStore(): TodoStore {
  // Live intent-ledger read - the seed source for open MANIFEST slots (replaces the
  // old frozen roadmap array, removed 2026-07-09). Kept in a ref too so
  // the Tauri event-listener closures (subscribed once, deps []) and the mutation
  // callbacks always seed against the LATEST ledger read, not a stale mount-time one.
  const { items: memoryItems, state: ledgerState, refresh: refreshMemory } = useMemoryTodos();
  const memoryItemsRef = useRef<MemoryTodoItem[]>(memoryItems);
  // Mirrors ledgerState the same way memoryItemsRef mirrors memoryItems - so the
  // event-listener closures and mutation callbacks below prune against the LATEST
  // known ledger state, not whatever it was when the effect first subscribed.
  const ledgerStateRef = useRef<LedgerState>(ledgerState);
  useEffect(() => {
    memoryItemsRef.current = memoryItems;
    ledgerStateRef.current = ledgerState;
  }, [memoryItems, ledgerState]);

  const [tasks, setTasks] = useState<TodoTask[]>(() =>
    enforce(load(), memoryItemsRef.current, ledgerStateRef.current),
  );

  // Persist whenever tasks change
  useEffect(() => {
    save(tasks);
  }, [tasks]);

  // Re-seed open slots (and prune resolved ones) whenever the ledger read changes
  // (mount fetch + any later refresh()) - this is what makes seeding/pruning track
  // live data instead of a one-shot static fill. Depends only on `memoryItems` and
  // `ledgerState`, never on `tasks`, so it can't loop.
  useEffect(() => {
    setTasks((prev) => enforce(prev, memoryItems, ledgerState));
  }, [memoryItems, ledgerState]);

  // Wire Tauri event listeners (guarded for non-Tauri/dev environments):
  //   praxis://task-complete → cross a task OFF (id or fuzzy text)
  //   praxis://todo-add      → add a voice-captured task ON (Hybrid session)
  useEffect(() => {
    const offs: Array<() => void> = [];

    const attachListeners = async () => {
      try {
        // Dynamic import so bundler doesn't break in a plain browser dev context
        const { listen } = await import("@tauri-apps/api/event");
        offs.push(
          await listen<{ id?: string; text?: string }>(
            "praxis://task-complete",
            (event) => {
              const { id, text } = event.payload ?? {};
              if (id) {
                setTasks((prev) => enforce(markDone(prev, id), memoryItemsRef.current, ledgerStateRef.current));
              } else if (text) {
                setTasks((prev) => enforce(markDoneByText(prev, text), memoryItemsRef.current, ledgerStateRef.current));
              }
            }
          )
        );
        offs.push(
          await listen<{ text?: string; source?: TaskSource }>(
            "praxis://todo-add",
            (event) => {
              const { text, source } = event.payload ?? {};
              if (text && text.trim()) {
                setTasks((prev) => enforce(addOne(prev, text.trim(), source ?? "voice"), memoryItemsRef.current, ledgerStateRef.current));
              }
            }
          )
        );
      } catch {
        // Not in Tauri - silent; dev browser works fine without it
      }
    };

    void attachListeners();
    return () => {
      offs.forEach((off) => off());
    };
  }, []);

  const completeTask = useCallback((id: string) => {
    setTasks((prev) => enforce(markDone(prev, id), memoryItemsRef.current, ledgerStateRef.current));
    refreshMemory(); // a slot may have opened up - re-check the ledger promptly
  }, [refreshMemory]);

  const completeTaskByText = useCallback((text: string) => {
    setTasks((prev) => enforce(markDoneByText(prev, text), memoryItemsRef.current, ledgerStateRef.current));
    refreshMemory();
  }, [refreshMemory]);

  const addTask = useCallback((text: string, source: TaskSource = "voice") => {
    const clean = text.trim();
    if (!clean) return;
    setTasks((prev) => enforce(addOne(prev, clean, source), memoryItemsRef.current, ledgerStateRef.current));
  }, []);

  const addBrainDump = useCallback((raw: string) => {
    const lines = raw
      .split(/[\n;]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    setTasks((prev) => {
      const existingTexts = new Set(prev.map((t) => t.text.trim().toLowerCase()));
      const newTasks: TodoTask[] = lines
        .filter((l) => !existingTexts.has(l.toLowerCase()))
        .map((text) => ({
          id: uid(),
          text,
          status: "upcoming" as TaskStatus,
          source: "manual" as TaskSource,
          createdAt: Date.now(),
        }));
      return enforce([...prev, ...newTasks], memoryItemsRef.current, ledgerStateRef.current);
    });
  }, []);

  // Real tasks (manual/voice) always outrank ledger-seeded filler for the visible
  // slots - otherwise a burst of memory-seeded rows could permanently fill
  // MAX_UPCOMING and every task the owner adds afterward is silently swallowed by the
  // slice below (the same bug class fixed 2026-07-02 for the old roadmap filler: the
  // add DID persist to storage, it just never rendered once the filler slots were
  // full). Order: real tasks oldest-first, then filler oldest-first, THEN cut to
  // MAX_UPCOMING. "roadmap" is legacy-only now (the frozen roadmap seed array was
  // removed 2026-07-09) but a prior session's persisted roadmap rows are treated as
  // filler the same as fresh "memory" rows until manually completed.
  const allUpcoming = tasks.filter((t) => t.status === "upcoming");
  const isFiller = (t: TodoTask) => t.source === "roadmap" || t.source === "memory";
  const realUpcoming = allUpcoming.filter((t) => !isFiller(t));
  const fillerUpcoming = allUpcoming.filter(isFiller);
  const upcoming = [...realUpcoming, ...fillerUpcoming].slice(0, MAX_UPCOMING);

  const done = tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    .slice(0, MAX_DONE);

  const hasTask = useCallback(
    (text: string) => {
      const needle = text.trim().toLowerCase();
      return tasks.some((t) => t.text.trim().toLowerCase() === needle);
    },
    [tasks],
  );

  return { upcoming, done, ledgerState, addBrainDump, addTask, completeTask, completeTaskByText, hasTask };
}

// --------------------------------------------------------------- pure helpers ---

/**
 * Add a single task verbatim (no splitting), deduped by text. Voice-captured notes
 * go through here so a spoken sentence lands as ONE to-do, not fragmented on any
 * incidental punctuation the brain-dump splitter would break on.
 */
function addOne(tasks: TodoTask[], text: string, source: TaskSource): TodoTask[] {
  const clean = text.trim();
  if (!clean) return tasks;
  const exists = tasks.some((t) => t.text.trim().toLowerCase() === clean.toLowerCase());
  if (exists) return tasks;
  return [
    ...tasks,
    { id: uid(), text: clean, status: "upcoming" as TaskStatus, source, createdAt: Date.now() },
  ];
}

function markDone(tasks: TodoTask[], id: string): TodoTask[] {
  return tasks.map((t) =>
    t.id === id && t.status === "upcoming"
      ? { ...t, status: "done" as TaskStatus, doneAt: Date.now() }
      : t
  );
}

function markDoneByText(tasks: TodoTask[], text: string): TodoTask[] {
  const needle = text.trim().toLowerCase();
  let hit = false;
  return tasks.map((t) => {
    if (!hit && t.status === "upcoming" && t.text.trim().toLowerCase().includes(needle)) {
      hit = true;
      return { ...t, status: "done" as TaskStatus, doneAt: Date.now() };
    }
    return t;
  });
}

// ------------------------------------------------------- memory-ledger group ---

/** One "Open now" item from the intent ledger (mirrors the Rust `MemoryTodoItem`). */
export interface MemoryTodoItem {
  status: string;
  date: string;
  title: string;
}

/**
 * Refill open upcoming slots from the LIVE intent ledger - the real backend truth,
 * not a frozen snapshot. Dedupes by text against the full task list (upcoming AND
 * done) so a ledger item already pulled in, or already completed locally, never
 * reappears just because it's still open in the ledger. Items land with
 * `source: "memory"`, which ManifestPanel already renders with the ◆ "praxis filed
 * this" glyph and a "from the ledger" caption - no rendering changes needed.
 */
export function seedFromMemory(tasks: TodoTask[], memoryItems: MemoryTodoItem[]): TodoTask[] {
  const upcoming = tasks.filter((t) => t.status === "upcoming");
  if (upcoming.length >= MAX_UPCOMING || memoryItems.length === 0) return tasks;

  const existingTexts = new Set(tasks.map((t) => t.text.trim().toLowerCase()));
  const needed = MAX_UPCOMING - upcoming.length;
  const toAdd: TodoTask[] = [];

  for (const item of memoryItems) {
    if (toAdd.length >= needed) break;
    const title = item.title.trim();
    const key = title.toLowerCase();
    if (!title || existingTexts.has(key)) continue;
    existingTexts.add(key); // guard against duplicate titles within the same batch
    toAdd.push({ id: uid(), text: title, status: "upcoming", source: "memory", createdAt: Date.now() });
  }

  return toAdd.length > 0 ? [...tasks, ...toAdd] : tasks;
}

/**
 * useMemoryTodos - read-only pull of the intent ledger's "🔴 Open now" section via
 * the Rust `memory_todo_open_now` command. Fetched once on mount (the ledger changes
 * at session-end cadence, not live) with a manual `refresh()` escape hatch. Never
 * throws: outside Tauri or on any read/parse failure it resolves to an empty list so
 * the "from memory" group simply renders nothing rather than an error state.
 */
/** Whether the intent ledger could actually be read.
 *
 *  A failure used to be converted into `[]`, which the manifest then rendered as
 *  "0 open" - asserting that the ledger is empty when the truth was that it could
 *  not be read. Empty and unavailable are different facts and must look different. */
export type LedgerState = "loading" | "live" | "unavailable";

export function useMemoryTodos(): {
  items: MemoryTodoItem[];
  state: LedgerState;
  refresh: () => void;
} {
  const [items, setItems] = useState<MemoryTodoItem[]>([]);
  const [state, setState] = useState<LedgerState>("loading");

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const rows = await invoke<MemoryTodoItem[]>("memory_todo_open_now");
        if (!Array.isArray(rows)) throw new Error("ledger returned a non-list");
        setItems(rows);
        setState("live");
      } catch {
        // Keep the last good rows on screen rather than blanking them, and say
        // the source is unavailable instead of claiming zero.
        setState("unavailable");
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { items, state, refresh };
}
