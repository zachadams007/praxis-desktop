/**
 * missionThread - Praxis's side of the conversation (owner request 2026-09-30).
 *
 * So every mission - typed into Mission or handed over by Atlas - lives in ONE persisted
 * thread (`agent-chats/mission.jsonl`, same store as the agent chats):
 *   • `brief` - Atlas → Praxis: the detailed prompt Atlas wrote (shown, so the owner sees
 *                  exactly what was asked),
 *   • `plan` - Praxis: who does what, in which folder,
 *   • `dispatch` - Praxis: an agent started its part,
 *   • `reroute` - Praxis: an agent was unavailable and who took its part (and when it's back),
 *   • `progress` - an agent's or Praxis's intermediate result,
 *   • `result` - Praxis: what was made + artifacts to open,
 *   • `failure` - Praxis: why it stopped + what's left,
 *   • `answer` - Praxis: an answer to a question asked in Mission,
 *   • `note` - anything else worth saying.
 *
 * Every window renders the same thread live: a post is announced in-window at once
 * (CustomEvent), persisted (agent_chat_append), then broadcast to every window (Tauri
 * event). Readers dedupe by id, so the emitting window seeing its own broadcast is fine.
 * Posting NEVER throws: the thread is the record of a run, never a gate on it.
 */

export type MissionFrom = "zach" | "atlas" | "praxis" | "forge" | "vega" | "quill" | "lens";

export type MissionKind =
  | "mission"
  | "brief"
  | "plan"
  | "dispatch"
  | "reroute"
  | "progress"
  | "result"
  | "failure"
  | "answer"
  | "note"
  
  | "review"
  /** Something Praxis decided on its own authority (an idea added, an approach changed). */
  | "decision";

export type MissionAgent = "forge" | "vega" | "quill" | "lens";

export interface MissionArtifact {
  /** preview = open in a browser · folder = open in Explorer · file = open the file · url = open a link */
  kind: "preview" | "folder" | "file" | "url";
  /** Button text, e.g. "Open preview". */
  label: string;
  /** file:///…, http(s)://…, or an absolute Windows path. */
  target: string;
}

export interface MissionMsg {
  /** Unique per message; readers dedupe on it. */
  id: string;
  /** Epoch ms. */
  ts: number;
  /** Groups every message of one mission. */
  missionId: string;
  from: MissionFrom;
  kind: MissionKind;
  /** Plain text with light markdown (bold, bullets, inline code). */
  text: string;
  /** Short mission title, set on the opening `mission`/`brief` message. */
  title?: string;
  artifacts?: MissionArtifact[];
  /** The agent a dispatch/progress/reroute row is about. */
  agent?: MissionAgent;
  /** For reroutes: the agent that took over. */
  standIn?: MissionAgent;
  model?: string;
  step?: { index: number; of: number };
  /** Live state of the whole mission, carried on plan/result/failure messages. */
  status?: "running" | "done" | "failed";
  /** A review's outcome: accepted, sent back for another pass, or stuck after the retries. */
  verdict?: "accepted" | "revise" | "stuck";
}

/** Thread id inside the agent-chat store (`agent-chats/mission.jsonl`). */
export const MISSION_THREAD_ID = "mission";
/** Same-window announcement (CustomEvent detail = MissionMsg). */
export const MISSION_EVENT = "praxis:mission-msg";
/** Cross-window broadcast (Tauri event payload = MissionMsg). */
export const MISSION_TAURI_EVENT = "praxis://mission-msg";

const FROM: ReadonlySet<string> = new Set(["zach", "atlas", "praxis", "forge", "vega", "quill", "lens"]);
const KINDS: ReadonlySet<string> = new Set([
  "mission", "brief", "plan", "dispatch", "reroute", "progress", "result", "failure", "answer", "note",
  "review", "decision",
]);
const AGENTS: ReadonlySet<string> = new Set(["forge", "vega", "quill", "lens"]);
const ARTIFACT_KINDS: ReadonlySet<string> = new Set(["preview", "folder", "file", "url"]);

let seq = 0;
function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** A new mission id, e.g. `m-lq3k2x-ab12cd`. */
export function newMissionId(): string {
  return `m-${Date.now().toString(36)}-${rand()}`;
}

/** A short, human title for a mission: its first sentence, capped at 60 characters. */
export function missionTitle(text: string): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

/** Fill id/ts for a message about to be posted. Pure (exported for tests). */
export function makeMissionMsg(partial: Omit<MissionMsg, "id" | "ts"> & { ts?: number }): MissionMsg {
  const ts = partial.ts ?? Date.now();
  seq += 1;
  return { ...partial, ts, id: `${ts.toString(36)}-${seq}-${rand()}` };
}

function coerceArtifacts(x: unknown): MissionArtifact[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out = x.filter(
    (a): a is MissionArtifact =>
      !!a &&
      typeof a === "object" &&
      ARTIFACT_KINDS.has((a as MissionArtifact).kind) &&
      typeof (a as MissionArtifact).label === "string" &&
      typeof (a as MissionArtifact).target === "string" &&
      (a as MissionArtifact).target.trim() !== "",
  );
  return out.length ? out : undefined;
}

/**
 * Validate anything that claims to be a mission message: a MissionMsg itself, or a
 * persisted agent-chat row `{ role, text, ts, meta }` whose `meta` is the message.
 * Returns null for anything that doesn't hold up (never throws).
 */
export function coerceMissionMsg(x: unknown): MissionMsg | null {
  if (!x || typeof x !== "object") return null;
  const raw = x as Record<string, unknown>;
  const m = (raw.meta && typeof raw.meta === "object" ? raw.meta : raw) as Record<string, unknown>;
  const text = typeof m.text === "string" ? m.text : typeof raw.text === "string" ? raw.text : null;
  const ts = typeof m.ts === "number" ? m.ts : typeof raw.ts === "number" ? raw.ts : null;
  if (
    text === null ||
    ts === null ||
    typeof m.id !== "string" ||
    typeof m.missionId !== "string" ||
    !FROM.has(String(m.from)) ||
    !KINDS.has(String(m.kind))
  ) {
    return null;
  }
  const msg: MissionMsg = {
    id: m.id,
    ts,
    missionId: m.missionId,
    from: m.from as MissionFrom,
    kind: m.kind as MissionKind,
    text,
  };
  if (typeof m.title === "string" && m.title.trim()) msg.title = m.title;
  const artifacts = coerceArtifacts(m.artifacts);
  if (artifacts) msg.artifacts = artifacts;
  if (AGENTS.has(String(m.agent))) msg.agent = m.agent as MissionAgent;
  if (AGENTS.has(String(m.standIn))) msg.standIn = m.standIn as MissionAgent;
  if (typeof m.model === "string" && m.model) msg.model = m.model;
  const step = m.step as { index?: unknown; of?: unknown } | undefined;
  if (step && typeof step.index === "number" && typeof step.of === "number") {
    msg.step = { index: step.index, of: step.of };
  }
  if (m.status === "running" || m.status === "done" || m.status === "failed") msg.status = m.status;
  if (m.verdict === "accepted" || m.verdict === "revise" || m.verdict === "stuck") msg.verdict = m.verdict;
  return msg;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * Post one message: announce in this window, persist, broadcast to every window.
 * Never throws; returns the message as posted.
 */
export async function postMissionMsg(
  partial: Omit<MissionMsg, "id" | "ts"> & { ts?: number },
): Promise<MissionMsg> {
  const msg = makeMissionMsg(partial);
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(MISSION_EVENT, { detail: msg }));
    }
  } catch {
    /* no DOM in this context */
  }
  if (!inTauri()) return msg;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("agent_chat_append", {
      agentId: MISSION_THREAD_ID,
      role: msg.from === "zach" ? "zach" : "agent",
      text: msg.text,
      meta: msg,
    });
  } catch (err) {
    console.error("[mission] persist failed:", err);
  }
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(MISSION_TAURI_EVENT, msg);
  } catch (err) {
    console.error("[mission] broadcast failed:", err);
  }
  return msg;
}

/** Praxis speaking in the thread. */
export function praxisSay(
  missionId: string,
  kind: MissionKind,
  text: string,
  extra: Partial<Omit<MissionMsg, "id" | "ts" | "missionId" | "from" | "kind" | "text">> = {},
): Promise<MissionMsg> {
  return postMissionMsg({ missionId, from: "praxis", kind, text, ...extra });
}

/** The persisted thread, oldest first, capped to the newest `limit` messages. */
export async function loadMissionThread(limit = 400): Promise<MissionMsg[]> {
  if (!inTauri()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke<unknown[]>("agent_chat_read", { agentId: MISSION_THREAD_ID });
    const msgs = (Array.isArray(rows) ? rows : [])
      .map(coerceMissionMsg)
      .filter((m): m is MissionMsg => m !== null);
    return msgs.slice(-limit);
  } catch (err) {
    console.error("[mission] load failed:", err);
    return [];
  }
}

/**
 * Live feed of new messages from this window and every other one. Deduplicates by id
 * (the emitting window also receives its own broadcast). Returns an unsubscribe.
 */
export function subscribeMission(fn: (m: MissionMsg) => void): () => void {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  const deliver = (raw: unknown) => {
    const m = coerceMissionMsg(raw);
    if (!m || seenSet.has(m.id)) return;
    seenSet.add(m.id);
    seen.push(m.id);
    if (seen.length > 500) seenSet.delete(seen.shift()!);
    fn(m);
  };
  const onLocal = (e: Event) => deliver((e as CustomEvent).detail);
  let unlistenTauri: (() => void) | null = null;
  let cancelled = false;
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener(MISSION_EVENT, onLocal);
  }
  if (inTauri()) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<unknown>(MISSION_TAURI_EVENT, (ev) => deliver(ev.payload)))
      .then((un) => {
        if (cancelled) un();
        else unlistenTauri = un;
      })
      .catch((err) => console.error("[mission] subscribe failed:", err));
  }
  return () => {
    cancelled = true;
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener(MISSION_EVENT, onLocal);
    }
    unlistenTauri?.();
  };
}

/** Group a thread into missions, oldest mission first; each group's messages in order. Pure. */
export function groupMissions(msgs: MissionMsg[]): { missionId: string; title: string; status: "running" | "done" | "failed"; msgs: MissionMsg[] }[] {
  const order: string[] = [];
  const by = new Map<string, MissionMsg[]>();
  for (const m of msgs) {
    if (!by.has(m.missionId)) {
      by.set(m.missionId, []);
      order.push(m.missionId);
    }
    by.get(m.missionId)!.push(m);
  }
  return order.map((missionId) => {
    const list = by.get(missionId)!.slice().sort((a, b) => a.ts - b.ts);
    const opener = list.find((m) => m.title) ?? list[0];
    // The latest word wins, in order: an explicit status, else a result/failure row.
    let status: "running" | "done" | "failed" = "running";
    for (const m of list) {
      if (m.status) status = m.status;
      else if (m.kind === "result") status = "done";
      else if (m.kind === "failure") status = "failed";
    }
    return { missionId, title: opener?.title ?? missionTitle(opener?.text ?? ""), status, msgs: list };
  });
}
