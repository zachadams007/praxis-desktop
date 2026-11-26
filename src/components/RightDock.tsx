/**
 * RightDock v3 - the tabbed right-hand surface (brain-window v3, spec item 6):
 *
 *   INSPECTOR  the demonstration surface. Click any node → its detail card.
 *              Nothing selected → the live hub view (who's firing, files born).
 *              Its documents pull out full-width; the tab itself also expands.
 *   INBOX      everything Praxis needs the owner to see - the SAME real inboxStore
 *              the Command Center reads (board digest · Atlas org report · Sage
 *              research · Hermes health · work Praxis delivered from Mission, with
 *              its Open buttons). Items open in-panel as a document.
 *   CONTROLS   the CC summary strip - HALT ALL, exec mode, trust, the tightest
 *              usage rail, breakers - plus the window's own controls (backup
 *              talk, gesture nav, journey, cluster-sigil A/B). EXPANDED it becomes
 *              the COMMAND LAUNCHER (v3): quad-tile · gesture · journey · sigil ·
 *              HALT · open the other windows · keyboard-shortcut reference.
 *
 * v3 gives EVERY tab a general ⤢ expand button that pulls the whole tab out
 * across the screen with the same pull-out motion the inbox docs use (see
 * .rd-expand in hud.css). The old AGENTS roster tab is retired (spec item 7).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { usePraxisStore, type AgentLive, type RightTab, isFiringAgent, selectFiringAgents } from "@/store/usePraxisStore";
import { VOICE_CONVERSATION_STATE, voiceConversation } from "@/voice/voiceEvents";
import { useFiringAgents } from "@/shared/agents";
import { buildGraph, type BrainNode } from "@/data/graph";
import { describeNode } from "@/data/descriptions";
import { Glyph, AGENT_GLYPH, AREA_GLYPH } from "@/glyphs/glyphs";
import { MODEL_LABEL, MODEL_TINT } from "@/brain/modelTint";
import { LABEL_FONTS, useLabelFont } from "@/brain/labelFontStore";
import { TRUST_LEVELS } from "@/shared/autonomy";
import { useHalt } from "@/command/haltStore";
import {
  useExecMode,
  useToolToggles,
  useUsage,
  TOOL_ROWS,
  EXEC_MODE_META,
  type ExecMode,
} from "@/command/controlStore";
import { buildRails } from "@/command/SupplyPanel";
import { useCursorPoolState } from "@/command/cursorPoolStore";
import { useOpenAiBilling } from "@/command/OpenAiBillingRail";
import {
  useInbox,
  useInboxUndo,
  isInboxDismissable,
  type DocSection,
  type InboxDoc,
  type InboxItem,
} from "@/command/inboxStore";
import { ArtifactRow } from "./mission/ArtifactButton";
import "@/styles/mission.css";
import { useVoiceProfile, type VoiceProfile } from "@/voice/voiceProfile";
import { useWatchMe } from "./watchMeStore";
import { restoreEverything } from "@/shared/restore";
import { useHermesHealthState } from "@/shared/hermesHealth";
import {
  PRAXIS_REPO_ROOT,
  candidateAbsolutePaths,
  missingPathMessage,
  openFailureMessage,
  praxisDataFromLocal,
  vaultRootFromHome,
  type PathRoots,
} from "@/shared/artifactPath";

const VOICE_OPTIONS: { id: VoiceProfile; label: string; hint?: string; backend: "openai" | "hume" | "elevenlabs" }[] = [
  { id: "atlas", label: "Atlas · Cedar", hint: "Same voice as live conversation", backend: "openai" },
  { id: "hume-conversational", label: "Deep Male Conversational", hint: "Hume Octave", backend: "hume" },
  { id: "hume-actor", label: "Classical Film Actor", hint: "Hume Octave", backend: "hume" },
  { id: "elevenlabs", label: "George · Storyteller", hint: "ElevenLabs · British", backend: "elevenlabs" },
];

/** Honest per-backend key status from Rust (voice_tts::voice_backends) - an option whose
 *  loading or dev browser → options stay enabled (browser speaks via speechSynthesis anyway). */
function useVoiceBackends(): { openai: boolean; hume: boolean; elevenlabs: boolean } | null {
  const [status, setStatus] = useState<{ openai: boolean; hume: boolean; elevenlabs: boolean } | null>(null);
  useEffect(() => {
    let dead = false;
    if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<{ openai: boolean; hume: boolean; elevenlabs: boolean }>("voice_backends"))
      .then((s) => {
        if (!dead) setStatus(s);
      })
      .catch(() => {
        /* older backend - leave options enabled */
      });
    return () => {
      dead = true;
    };
  }, []);
  return status;
}

const TABS: { id: RightTab; label: string }[] = [
  { id: "inspector", label: "Inspector" },
  { id: "inbox", label: "Inbox" },
  { id: "controls", label: "Controls" },
];

/** Hermes degraded state - same praxis://hermes-degraded signal App.tsx surfaces. */
function useHermesDegraded(): { degraded: boolean; reason: string } | null {
  // Pull + listen (src/shared/hermesHealth.ts): the dock mounts after the one
  // change-only emit, so listening alone never learned the state.
  return useHermesHealthState();
}

/** ⤢ / ⤡ expand-toggle icon - matches the OrchestratorPanel's affordance so the
 *  whole HUD speaks one "pull out / pull in" language. */
function ExpandGlyph({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden width="13" height="13">
      <path d="M10 6L14 2M14 2H10.5M14 2V5.5M6 10L2 14M2 14H5.5M2 14V10.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden width="13" height="13">
      <path d="M9 7L14 2M14 2H10M14 2V6M7 9L2 14M2 14H6M2 14V10"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RightDock() {
  const rightTab = usePraxisStore((s) => s.rightTab);
  const selectedId = usePraxisStore((s) => s.selectedId);
  const hermes = useHermesDegraded();
  const inbox = useInbox(hermes);
  // v3: the whole active tab can pull out across the screen (Inspector · Inbox ·
  // Controls). Local to the dock - no store setter needed (another lane owns those).
  const [expanded, setExpanded] = useState(false);
  // read `expanded` inside the selection effect WITHOUT making it a dependency - a
  // dep would re-run the effect on collapse and re-introduce the very bug we're fixing.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // selecting a node in the scene pulls the INSPECTOR forward - the demonstration surface always
  // shows what Praxis (or the owner) just pointed at. BUT never while the dock is expanded on another
  // tab (Inbox/Controls) or a document is pulled out: stealing the tab there made "expand Inbox
  // → close" dump you on Inspector, and even flipped the expanded content mid-view. So a
  // background selection is silently remembered; it only takes the tab once you're back on the
  // normal dock.
  useEffect(() => {
    if (!selectedId) return;
    if (expandedRef.current) return; // a tab is pulled out - don't hijack it
    if (usePraxisStore.getState().pulloutDoc) return; // a doc is open over the dock
    usePraxisStore.getState().setRightTab("inspector");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const caption =
    rightTab === "inspector"
      ? selectedId
        ? "inspecting"
        : "click a node — praxis shows it here"
      : rightTab === "inbox"
        ? "what praxis needs you to see"
        : "the essentials, from the cockpit";

  const expandLabel =
    rightTab === "controls" ? "open the command launcher" : "pull this tab out across the screen";

  return (
    <>
      <aside className="dock pane" aria-label="right dock">
        <header className="dock-head" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={rightTab === t.id}
              className={`dock-tab ${rightTab === t.id ? "tab-on" : ""}`}
              onClick={() => usePraxisStore.getState().setRightTab(t.id)}
            >
              <span>{t.label}</span>
              {/* Honesty guard: the pip counts UNREAD, but it is bound to the SAME
                  inbox.items the tab renders - so it can never claim "2" while the
                  panel has nothing to show. If there are no items, the badge reads 0
                  (hidden) and the tab shows its honest "inbox zero" empty state. */}
              {t.id === "inbox" && inbox.unreadCount > 0 && inbox.items.length > 0 && (
                <span className="tab-pip">{inbox.unreadCount}</span>
              )}
            </button>
          ))}
          {/* general per-tab expand (v3) - every tab pulls out with the same motion */}
          <button
            className="dock-expand"
            onClick={() => setExpanded(true)}
            aria-label={expandLabel}
            title={expandLabel}
          >
            <ExpandGlyph expanded={false} />
          </button>
        </header>

        <AnimatePresence mode="wait" initial={false}>
          {rightTab === "inspector" ? (
            <DockBody key={selectedId ? `sel-${selectedId}` : "inspector"}>
              {selectedId ? <DetailCard selectedId={selectedId} /> : <InspectorHome />}
              <footer className="dock-foot">{caption}</footer>
            </DockBody>
          ) : rightTab === "inbox" ? (
            <DockBody key="inbox">
              <InboxTab inbox={inbox} />
            </DockBody>
          ) : (
            <DockBody key="controls">
              <ControlsTab />
            </DockBody>
          )}
        </AnimatePresence>
      </aside>

      <ExpandedTab
        tab={rightTab}
        open={expanded}
        onClose={() => setExpanded(false)}
        selectedId={selectedId}
        inbox={inbox}
      />
    </>
  );
}

function DockBody({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="dock-body"
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -8 }}
      transition={{ duration: 0.18 }}
    >
      {children}
    </motion.div>
  );
}

/* --------------------------------------------------- expanded-tab pull-out ---- */

/**
 * ExpandedTab - the v3 general expand: the ACTIVE dock tab grows OUT of the dock
 * across the brain, anchored at the dock's right edge, on the same expo width
 * animation as the inbox Pullout (so the motion vocabulary is identical). Esc or
 * ‹ dock collapses it back. Controls-expanded renders the COMMAND LAUNCHER.
 */
function ExpandedTab({
  tab,
  open,
  onClose,
  selectedId,
  inbox,
}: {
  tab: RightTab;
  open: boolean;
  onClose: () => void;
  selectedId: string | null;
  inbox: ReturnType<typeof useInbox>;
}) {
  const [winW, setWinW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1920));
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // The expanded target width. The inner content is PINNED to this width so it never
  // reflows/crushes while the panel retracts - it just slides out under the panel's clip.
  const expandedW = Math.max(640, winW - 96);
  const title =
    tab === "inspector" ? "Inspector" : tab === "inbox" ? "Inbox" : "Command Launcher";
  const caption =
    tab === "inspector"
      ? "the demonstration surface"
      : tab === "inbox"
        ? "everything praxis needs you to see"
        : "one place to drive the whole workspace";

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="rd-expand pane"
          initial={{ width: 308, opacity: 0.6 }}
          animate={{ width: expandedW, opacity: 1 }}
          // Close is the true REVERSE of the open, not a fade: width retracts
          // full→308 into the dock, and the panel stays fully opaque through ~80%
          // of that slide, only vanishing in the last beat. (Fading opacity in
          // lockstep with the width - the old behavior - reads as a fade because
          // it's half-transparent mid-retract instead of visibly sliding home.)
          exit={{
            width: 308,
            opacity: [1, 1, 0],
            transition: {
              width: { duration: 0.44, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.44, times: [0, 0.82, 1], ease: "linear" },
            },
          }}
          transition={{
            width: { duration: 0.46, ease: [0.22, 1, 0.36, 1] },
            opacity: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
          }}
          aria-label={`${title} — expanded`}
        >
          <motion.div
            className="rd-expand-inner"
            // pinned to the full expanded width (right-aligned) so it never reflows as the
            // panel retracts; fades out fast on close so you never see a crushed launcher
            // nor a hard flip to the Controls tab underneath - just a clean slide home.
            style={{
              width: expandedW,
              marginLeft: "auto",
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
            exit={{ opacity: 0, transition: { duration: 0.16, ease: "linear" } }}
          >
          <header className="rd-expand-head">
            <span className="rd-expand-tick" aria-hidden />
            <div className="rd-expand-titles">
              <span className="rd-expand-label">{title}</span>
              <span className="rd-expand-caption">{caption}</span>
            </div>
            <button className="rd-expand-close" onClick={onClose} title="collapse (Esc)">
              <ExpandGlyph expanded />
              <span>dock</span>
            </button>
          </header>
          <div className="rd-expand-body">
            {tab === "inspector" ? (
              selectedId ? <DetailCard selectedId={selectedId} wide /> : <InspectorHome wide />
            ) : tab === "inbox" ? (
              <InboxTab inbox={inbox} wide />
            ) : (
              <CommandLauncher onClose={onClose} />
            )}
          </div>
          </motion.div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------- inspector (home) ---- */

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function loadPathRoots(): Promise<PathRoots> {
  const { homeDir, localDataDir } = await import("@tauri-apps/api/path");
  const [home, local] = await Promise.all([homeDir(), localDataDir()]);
  return {
    home,
    vault: vaultRootFromHome(home),
    repoRoot: PRAXIS_REPO_ROOT,
    praxisData: praxisDataFromLocal(local),
  };
}

function usePathRoots(): PathRoots | null {
  const [roots, setRoots] = useState<PathRoots | null>(null);
  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    void loadPathRoots()
      .then((r) => {
        if (!cancelled) setRoots(r);
      })
      .catch(() => {
        /* path API unavailable - chips stay non-openable rather than guessing */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return roots;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      if (await invoke<boolean>("path_exists", { path: p })) return p;
    } catch {
      /* backend unavailable - skip this candidate */
    }
  }
  return null;
}

async function openFile(path?: string, _label?: string) {
  if (!path || !inTauri()) return;
  let tried = path;
  try {
    const roots = await loadPathRoots();
    const candidates = candidateAbsolutePaths(path, roots);
    const abs = await firstExisting(candidates);
    if (!abs) {
      usePraxisStore.getState().notify(missingPathMessage(candidates[0] ?? path));
      return;
    }
    tried = abs;
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(abs);
  } catch (e) {
    usePraxisStore.getState().notify(openFailureMessage(tried, e));
  }
}

/** Which of these paths actually exist on disk, mapped raw → absolute.
 *
 *  Artifact paths are DERIVED from a label by string concatenation, and the
 *  label list mixes Praxis files with files from other repos and with plain
 *  concepts - so a chip could claim to open `src/components/EngineCore.tsx`
 *  (a Catalyzed Alpha file) that has never existed here. Checked once per card
 *  so only real files get the openable affordance. Click re-validates. */
function useExistingPaths(paths: (string | null)[]): ReadonlyMap<string, string> {
  const roots = usePathRoots();
  const [ok, setOk] = useState<ReadonlyMap<string, string>>(() => new Map());
  const key = paths.filter(Boolean).join("|");
  useEffect(() => {
    if (!inTauri() || !roots) return;
    let cancelled = false;
    const wanted = key ? key.split("|") : [];
    if (!wanted.length) {
      setOk(new Map());
      return;
    }
    void (async () => {
      const hits = new Map<string, string>();
      await Promise.all(
        wanted.map(async (raw) => {
          const abs = await firstExisting(candidateAbsolutePaths(raw, roots));
          if (abs) hits.set(raw, abs);
        }),
      );
      if (!cancelled) setOk(hits);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, roots]);
  return ok;
}

/**
 * Best-effort node/artifact → real repo file resolver (spec item: "Inspector node
 * click → open the real linked file/task, extend the existing openFile path").
 *
 * Brain nodes are conceptual - a task/artifact carries a LABEL, not an absolute
 * path - so we map the labels that ARE real source files (React chrome under
 * src/**, Rust commands under src-tauri/src/**, and the vault docs) to their path
 * under the repo root. Anything we can't resolve stays a camera fly-to (unchanged),
 * so this only ADDS an open affordance, never removes the existing one. */
const REPO_ROOT = PRAXIS_REPO_ROOT;

/** Explicit label → repo-relative path for artifacts whose file location isn't a
 *  simple src/<dir>/<label> derivation (Rust, scripts, docs, memory). */
const ARTIFACT_PATHS: Record<string, string> = {
  "flightdeck.rs": "src-tauri/src/flightdeck.rs",
  "transcript_tailer.rs": "src-tauri/src/transcript_tailer.rs",
  "session_poller.rs": "src-tauri/src/session_poller.rs",
  "usePraxisStore.ts": "src/store/usePraxisStore.ts",
  "modelTint.ts": "src/brain/modelTint.ts",
  "runtime.ts": "src/brain/runtime.ts",
  "eventBus.ts": "src/data/eventBus.ts",
  "schema.ts": "src/data/schema.ts",
  "useRealEvents.ts": "src/data/useRealEvents.ts",
  "parse.ts": "src/voice/parse.ts",
  // Corrected: this hook lives under src/gesture (GesturePanel imports it from
  // @/gesture/useHandGesture); the old src/voice path did not exist, so the chip
  // advertised itself as openable and did nothing.
  "useHandGesture.ts": "src/gesture/useHandGesture.ts",
  "journeyLayout.ts": "src/data/journeyLayout.ts",
  // Deck files are under src/flightdeck, not src/components - the derived
  // src/components/<label> path resolved to nothing.
  "DeckApp.tsx": "src/flightdeck/deck/DeckApp.tsx",
  "DeckDock.tsx": "src/flightdeck/deck/DeckDock.tsx",
};

/** Directory that owns a given source-file extension for the derived lookups. */
function dirFor(label: string): string | null {
  if (/\.(tsx)$/.test(label)) {
    // component vs brain-field - brain fields live in src/brain, the rest in components
    return BRAIN_TSX.has(label) ? "src/brain" : "src/components";
  }
  return null;
}
const BRAIN_TSX = new Set([
  "Hub.tsx", "ClusterField.tsx", "EdgeField.tsx", "NodeField.tsx", "AgentField.tsx",
  "PulseField.tsx", "Labels.tsx", "CameraRig.tsx", "JourneyChrome.tsx", "JourneyHandoffField.tsx",
]);

/** Resolve a node (or its artifact label) to an absolute repo path, or null. */
function resolveNodePath(node: BrainNode): string | null {
  const label = node.label;
  if (ARTIFACT_PATHS[label]) return `${REPO_ROOT}/${ARTIFACT_PATHS[label]}`;
  const dir = dirFor(label);
  if (dir) return `${REPO_ROOT}/${dir}/${label}`;
  return null;
}

/** Nothing selected: the live hub read - who's firing + files born. Deliberately
 *  NOT an agent dashboard (that lives in CC/galaxy) - just the pulse. */
function InspectorHome({ wide = false }: { wide?: boolean }) {
  const files = usePraxisStore((s) => s.recentFiles);
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const g = useMemo(() => buildGraph(), [graphVersion]);

  // ONE-TRUTH firing list - off the fd_sessions roster (useFiringAgents), the SAME
  // source Galaxy/CC/Flight Deck read, so this list's length matches the state bar's
  // "N FIRING" and every other window. Real coding sessions only; infra + parked
  // (≥30 min silent) sessions are excluded upstream. (Was the event-bus store, which
  // over-reported: 5 here vs 0-1 on fd_sessions - 2026-07-10 CDP QA.)
  const firing = useFiringAgents();
  const filePaths = useMemo(() => files.map((f) => f.path ?? null), [files]);
  const existingFiles = useExistingPaths(filePaths);

  return (
    <div
      className={`dock-list ${wide ? "is-wide" : ""}`}
      style={wide ? undefined : { padding: 0, gap: 0 }}
    >
      <div className="insp-sec">
        <div className="insp-head" style={{ "--g": "var(--cc-emerald)" } as React.CSSProperties}>
          <span className="insp-tick" />
          <span className="insp-label">Firing now</span>
          <span className="insp-caption">
            {firing.length === 0 ? "the pulse, live" : `${firing.length} working`}
          </span>
        </div>
        {firing.length === 0 ? (
          <div className="insp-empty">all quiet — no agents firing</div>
        ) : (
          <div className="insp-rows">
            {firing.map((a) => {
              // AgentRow.focus is a node id OR a session-title label; only fly-to when
              // it resolves to a real brain node (a live session's title usually won't).
              const node = a.focus ? g.byId.get(a.focus) : null;
              const fam = a.family;
              return (
                <div
                  key={a.id}
                  className={`insp-firing-row ${node ? "clickable" : ""}`}
                  onClick={() => node && usePraxisStore.getState().focus(node.id)}
                  title={node ? `fly to ${node.label}` : undefined}
                >
                  <span className="insignia status-working sm" aria-hidden>
                    <Glyph id={AGENT_GLYPH[a.id] ?? "hex"} size={12} />
                  </span>
                  <span className="name mono">{a.name}</span>
                  {fam && (
                    <span
                      className="ag-model"
                      style={{ "--m": MODEL_TINT[fam] } as React.CSSProperties}
                    >
                      {MODEL_LABEL[fam]}
                    </span>
                  )}
                  <span className="task">{a.task ?? "…"}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="insp-sec">
        <div className="insp-head" style={{ "--g": "var(--cc-sapphire)" } as React.CSSProperties}>
          <span className="insp-tick" />
          <span className="insp-label">Files born</span>
          <span className="insp-caption">
            {files.length === 0 ? "nothing yet" : "what praxis just made"}
          </span>
        </div>
        {files.length === 0 ? (
          <div className="insp-empty">no files born yet…</div>
        ) : (
          <div className="insp-rows">
            {files.map((f) => {
              const area = f.areaId ? g.byId.get(f.areaId)?.label : undefined;
              const abs = f.path ? existingFiles.get(f.path) : undefined;
              return (
                <button
                  key={f.id}
                  className={`file-row ${abs ? "openable" : ""}`}
                  onClick={() => {
                    if (abs) void openFile(abs);
                  }}
                  title={abs ?? f.path ?? f.label}
                  style={
                    f.areaId
                      ? ({ "--g": `var(--area-${f.areaId})` } as React.CSSProperties)
                      : undefined
                  }
                >
                  <span className="file-icon" aria-hidden>
                    <Glyph id="files" size={13} />
                  </span>
                  <span className="file-meta">
                    <span className="file-name mono">{f.label}</span>
                    {area && <span className="file-area">{area}</span>}
                  </span>
                  <span className="file-born">born</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- inbox ---- */

function InboxTab({ inbox, wide = false }: { inbox: ReturnType<typeof useInbox>; wide?: boolean }) {
  // A doc-worthy inbox item (board · org · research reports - every item that
  // carries a `doc`) PULLS OUT full-screen the instant it's clicked: no in-panel
  // cramping, no "expand" round-trip. Rows without a doc (e.g. Hermes health) just
  // mark read. The ⤢ on each doc row is the explicit manual force of the same thing.
  const open = (item: InboxItem) => {
    inbox.markRead(item.id);
    if (item.doc) usePraxisStore.getState().setPulloutDoc(item.doc);
  };

  const undo = useInboxUndo(inbox.restore);
  const canManage = inbox.items.some((item) => isInboxDismissable(item.id));
  const anyUnread = inbox.items.some((item) => item.unread && isInboxDismissable(item.id));
  const anyRead = inbox.items.some((item) => !item.unread && isInboxDismissable(item.id));
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    // Capture so Escape closes the menu without also collapsing the pull-out.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  return (
    <>
      {(undo.visible || canManage) && (
        <div className="ib-manage">
          {undo.visible ? (
            <p className="ib-undo" role="status">
              <span>{undo.count} deleted · </span>
              <button type="button" className="ib-undo-btn" onClick={undo.undo}>
                UNDO
              </button>
            </p>
          ) : (
            <span />
          )}
          {canManage && (
            <div className="ib-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="ib-menu-btn"
                aria-label="Inbox actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Inbox actions"
                onClick={() => setMenuOpen((open) => !open)}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="ib-menu" role="menu" aria-label="Inbox actions">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!anyUnread}
                    onClick={() => {
                      inbox.markAllRead();
                      setMenuOpen(false);
                    }}
                  >
                    Mark all read
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!anyRead}
                    onClick={() => {
                      undo.arm(inbox.clearRead());
                      setMenuOpen(false);
                    }}
                  >
                    Clear read
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      undo.arm(inbox.clearAll());
                      setMenuOpen(false);
                    }}
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className={`dock-list ${wide ? "is-wide" : ""}`}>
        {inbox.items.length === 0 && (
          <div className="dock-empty">inbox zero — praxis has nothing waiting on you</div>
        )}
        {inbox.items.map((item) => {
          const canDismiss = isInboxDismissable(item.id);
          return (
            // Positioning context for the delete control. Delivered rows also carry
            // real Open buttons, which can't live inside the row's own <button>.
            <div
              key={item.id}
              className={`ib-item${item.actions?.length ? " has-actions" : ""}${item.unread ? "" : " read"}${canDismiss ? " can-dismiss" : ""}`}
              style={{ "--ib-c": item.dotColor } as React.CSSProperties}
            >
              <button className={`ib-row ${item.unread ? "" : "read"}`} onClick={() => open(item)}>
                <span className="ib-dot" aria-hidden />
                <span className="ib-main">
                  <span className="ib-top">
                    <span className="ib-from">{item.from}</span>
                    {item.tag && <span className="ib-tag">{item.tag}</span>}
                    <span className="ib-time">{item.time}</span>
                  </span>
                  {item.title && <span className="ib-title">{item.title}</span>}
                  <span className="ib-text">{item.text}</span>
                </span>
                {item.doc && (
                  <span className="ib-expand" aria-hidden title="opens full-screen">
                    ⤢
                  </span>
                )}
              </button>
              {canDismiss && (
                <button
                  type="button"
                  className="ib-delete"
                  aria-label="Delete this message"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    inbox.dismiss(item.id);
                    undo.arm([item.id]);
                  }}
                >
                  ×
                </button>
              )}
              {item.actions && item.actions.length > 0 && (
                <div className="ib-actions">
                  <ArtifactRow artifacts={item.actions} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <footer className="dock-foot">reports open right here — board · org · research · delivered work</footer>
    </>
  );
}

/* ---------------------------------------------------- document + pull-out ---- */

/** Shared document renderer - the in-dock view AND the full-width pull-out. */
function DocView({
  doc,
  backLabel,
  onBack,
  onExpand,
}: {
  doc: InboxDoc;
  backLabel: string;
  onBack: () => void;
  onExpand?: () => void;
}) {
  return (
    <div className="ibdoc">
      <div className="ibdoc-head">
        <div className="ibdoc-kicker">
          <span
            className="ib-dot"
            style={{ "--ib-c": doc.dot, marginTop: 0 } as React.CSSProperties}
            aria-hidden
          />
          <span>{doc.from}</span>
          {/* date + source line so the owner can tell the content is real + current
              (fixes: the board-meeting doc had no date at its top) */}
          {doc.time && (
            <span className="ibdoc-src" style={{ opacity: 0.6, fontSize: "0.82em" }}>
              · {doc.time}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {onExpand && (
            <button className="ibdoc-back" onClick={onExpand} title="pull out across the screen">
              ⤢ expand
            </button>
          )}
          <button className="ibdoc-back" onClick={onBack}>
            {backLabel}
          </button>
        </div>
        <h2 className="ibdoc-title">{doc.title}</h2>
        <p className="ibdoc-meta">{doc.meta}</p>
      </div>
      <div className="ibdoc-body">
        {doc.sections.map((s, i) => (
          <div key={i}>
            <h3 className="ibdoc-h" style={{ color: s.hColor }}>
              {s.h}
            </h3>
            {s.ps.map((p, j) => (
              <p key={j} className="ibdoc-p">
                {p.mark && (
                  <span className="mark" style={{ color: p.markColor }}>
                    {p.mark}
                  </span>
                )}
                <span>{p.t}</span>
              </p>
            ))}
          </div>
        ))}
      </div>
      <footer className="dock-foot">filed to the vault · full view in the command center</footer>
    </div>
  );
}

/**
 * Pullout - the Phase-C demonstration surface. The inspector's document PULLS OUT
 * across the whole screen in one smooth motion (width animates from the dock's
 * 308px to nearly full-width, anchored at the dock's right edge, so it visibly
 * grows OUT of the dock), Praxis narrates over it, Esc / ‹ dock collapses it back.
 */
export function Pullout() {
  const doc = usePraxisStore((s) => s.pulloutDoc);
  const [winW, setWinW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1920));
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") usePraxisStore.getState().setPulloutDoc(null);
    };
    if (doc) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc]);

  return (
    <AnimatePresence>
      {doc && (
        <motion.section
          className="pullout pane"
          initial={{ width: 308, opacity: 0.6 }}
          animate={{ width: Math.max(640, winW - 96), opacity: 1 }}
          // Close must be the REVERSE of the open, not a fade: width retracts full→308
          // on the same expo ease while the panel stays fully opaque through ~80% of
          // the slide, only vanishing in the last beat - so it visibly slides back
          // into the dock rather than dissolving in place.
          exit={{
            width: 308,
            opacity: [1, 1, 0],
            transition: {
              width: { duration: 0.44, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.44, times: [0, 0.82, 1], ease: "linear" },
            },
          }}
          transition={{
            width: { duration: 0.46, ease: [0.22, 1, 0.36, 1] },
            opacity: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
          }}
          aria-label="demonstration surface"
        >
          <DocView
            doc={doc}
            backLabel="‹ dock"
            onBack={() => usePraxisStore.getState().setPulloutDoc(null)}
          />
        </motion.section>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------- command launcher ---- */

/** Fire a control-plane command through the SAME voice router the mic + typed chat
 *  use, so a launcher button DOES the thing (and Praxis confirms aloud) rather than
 *  re-implementing it. Falls back to a direct store/tauri path when there's no
 *  matching voice intent. Only imports from src/voice/* - never edits it. */
async function runCommand(text: string) {
  try {
    const [{ parseCommand }, { executeAndSpeak, areaRefs }] = await Promise.all([
      import("@/voice/commands"),
      import("@/voice/execute"),
    ]);
    const cmd = parseCommand(text, areaRefs());
    if (cmd && cmd.intent.kind !== "ask") {
      await executeAndSpeak(cmd);
      return true;
    }
  } catch {
    /* fall through to a direct path below */
  }
  return false;
}

/** Open a Praxis window directly (native Tauri only; silent in a plain browser). */
function openWindowCmd(cmd: string, name: string) {
  const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!tauri) return;
  invoke(cmd).catch((err) => {
    console.error(`[launcher] ${name} open failed:`, err);
    usePraxisStore.getState().notify(`${name} didn't open — see console.`);
  });
}

interface LaunchAction {
  id: string;
  label: string;
  hint: string;
  glyph: Parameters<typeof Glyph>[0]["id"];
  run: () => void;
  danger?: boolean;
  live?: boolean;
}

/** Keyboard reference - the real bindings, so the launcher doubles as the cheat-sheet. */
const SHORTCUTS: { keys: string; what: string }[] = [
  // voice - the primary way to drive Praxis
  { keys: "hold T", what: "push-to-talk (release sends)" },
  { keys: "Ctrl+T", what: "talk from anywhere (single shot)" },
  { keys: "Ctrl+T → Space", what: "start a continuous Jarvis session — always-listening, hands-free (or the CONVERSE button below)" },
  { keys: "V", what: "hands-free voice toggle" },
  { keys: "Esc", what: "barge-in / stop talking · overview · collapse pull-outs" },
  // capture + navigation
  { keys: "D", what: "Mission — dump / file · do · build · answer" },
  { keys: "O", what: "Atlas — fast companion chat" },
  { keys: "J", what: "journey ⇄ brain toggle" },
  { keys: "1–6", what: "fly to an area" },
  { keys: "← →", what: "journey: move through time · ↑ ↓ area · [ ] task" },
  // windows
  { keys: "Ctrl+Alt+1", what: "Brain (main window)" },
  { keys: "Ctrl+Alt+2", what: "Command Center" },
  { keys: "Ctrl+Alt+3", what: "Memory Galaxy" },
  { keys: "Ctrl+Alt+4", what: "Flight Deck" },
  { keys: "Ctrl+Alt+← →", what: "cycle through open windows" },
];

/**
 * CommandLauncher - the Controls tab, EXPANDED (spec item: "the CONTROLS tab
 * expanded = a COMMAND LAUNCHER"). One board to drive the whole workspace:
 * layout + navigation verbs, the window links, the HALT breaker, and the live
 * trust/mode read, plus the keyboard reference. Every button routes through a
 * real path (voice router → store/tauri), never a mock.
 */
function CommandLauncher({ onClose }: { onClose: () => void }) {
  const { halted, toggleHalt } = useHalt();
  const { mode } = useExecMode();
  const autonomy = usePraxisStore((s) => s.autonomy);
  const navMode = usePraxisStore((s) => s.mode);
  const viewMode = usePraxisStore((s) => s.viewMode);
  const sigil = usePraxisStore((s) => s.clusterSigil);
  const trust = TRUST_LEVELS.find((l) => l.key === autonomy);

  const TRUST_DETENT: Record<string, string> = {
    observe: "I · OBSERVE",
    suggest: "II · PROPOSE",
    approve: "II · PROPOSE",
    operator: "III · EXECUTE",
    full: "IV · SOVEREIGN",
  };

  // WORKSPACE verbs - real store/window actions (quad-tile via the voice router so it
  // hits window_ops::tile_quadrants; the rest call the same store actions the dock uses).
  const layout: LaunchAction[] = [
    {
      id: "tile",
      label: "Quad-tile windows",
      hint: "snap all four Praxis windows into the screen quadrants",
      glyph: "add",
      run: () => void runCommand("tile the windows"),
    },
    {
      id: "untile",
      label: "Exit tiling",
      hint: "restore the window layout from before quad-tiling",
      glyph: "history",
      run: () => void runCommand("exit formation"),
    },
    {
      id: "gesture",
      label: navMode === "gesture" ? "Gesture nav · on" : "Gesture nav",
      hint: "camera hand-tracking navigation",
      glyph: "hand",
      live: navMode === "gesture",
      run: () => usePraxisStore.getState().toggleMode(),
    },
    {
      id: "journey",
      label: viewMode === "journey" ? "Journey · on" : "Journey toggle",
      hint: "morph the brain into the roadmap tree · J",
      glyph: "history",
      live: viewMode === "journey",
      run: () => usePraxisStore.getState().toggleViewMode(),
    },
    {
      id: "sigil",
      label: `Sigil: ${sigil === "glyph" ? "Glyph" : sigil === "orbital" ? "Orbital" : "Stars"}`,
      hint: "cycle the cluster symbol style",
      glyph: "orbit",
      run: () =>
        usePraxisStore
          .getState()
          .setClusterSigil(
            sigil === "glyph" ? "orbital" : sigil === "orbital" ? "constellation" : "glyph",
          ),
    },
  ];

  const windows: LaunchAction[] = [
    {
      id: "cc",
      label: "Command Center",
      hint: "autonomy · fleet · spend · launcher · Ctrl+Alt+2",
      glyph: "pulse",
      run: () => openWindowCmd("open_command_center_cmd", "Command Center"),
    },
    {
      id: "galaxy",
      label: "Memory Galaxy",
      hint: "the second-brain graph · Ctrl+Alt+3",
      glyph: "orbit",
      run: () => openWindowCmd("open_knowledge_cmd", "Memory Galaxy"),
    },
    {
      id: "deck",
      label: "Flight Deck",
      hint: "parallel Claude sessions · Ctrl+Alt+4",
      glyph: "deck",
      run: () => openWindowCmd("open_flight_deck_cmd", "Flight Deck"),
    },
  ];

  return (
    <div className="cl">
      <div className="cl-cols">
        <section className="cl-col">
          <p className="cl-label">Workspace</p>
          <div className="cl-grid">
            {layout.map((a) => (
              <button
                key={a.id}
                className={`cl-btn ${a.live ? "live" : ""}`}
                onClick={a.run}
                title={a.hint}
              >
                <span className="cl-btn-glyph" aria-hidden>
                  <Glyph id={a.glyph} size={16} />
                </span>
                <span className="cl-btn-text">
                  <span className="cl-btn-label">{a.label}</span>
                  <span className="cl-btn-hint">{a.hint}</span>
                </span>
              </button>
            ))}
          </div>

          <p className="cl-label">Windows</p>
          <div className="cl-grid">
            {windows.map((a) => (
              <button key={a.id} className="cl-btn" onClick={a.run} title={a.hint}>
                <span className="cl-btn-glyph" aria-hidden>
                  <Glyph id={a.glyph} size={16} />
                </span>
                <span className="cl-btn-text">
                  <span className="cl-btn-label">{a.label}</span>
                  <span className="cl-btn-hint">{a.hint}</span>
                </span>
              </button>
            ))}
          </div>

          <p className="cl-label">Command</p>
          <button
            className={`cl-halt ${halted ? "halted" : ""}`}
            onClick={toggleHalt}
            title="stop every agent, every mode, instantly"
          >
            {halted ? "HALTED · RESUME ALL" : "HALT ALL"}
          </button>
          <div className="cl-state" data-level={autonomy}>
            <span className="cl-state-cell">
              <span className="cl-state-k">Trust</span>
              <span className="cl-state-v trust" title={trust ? `${trust.blurb}\n${trust.guard}` : undefined}>
                {TRUST_DETENT[autonomy] ?? autonomy}
              </span>
            </span>
            <span className="cl-state-cell">
              <span className="cl-state-k">Mode</span>
              <span className="cl-state-v">{EXEC_MODE_META[mode].label}</span>
            </span>
            <span className="cl-state-cell">
              <span className="cl-state-k">Fleet</span>
              <span className={`cl-state-v ${halted ? "cut" : "live"}`}>
                {halted ? "HALTED" : "READY"}
              </span>
            </span>
          </div>
          <p className="cl-note">set the trust dial + exec mode in the Command Center</p>
        </section>

        <section className="cl-col cl-col-keys">
          <p className="cl-label">Keyboard</p>
          <div className="cl-keys">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="cl-key-row">
                <kbd>{s.keys}</kbd>
                <span className="cl-key-what">{s.what}</span>
              </div>
            ))}
          </div>
          <p className="cl-note">
            hold <kbd>T</kbd> (or <kbd>Ctrl+T</kbd> anywhere) is the primary way to talk —
            the mic is push-to-talk
          </p>
        </section>
      </div>
      <footer className="cl-foot">
        <span>the launcher drives the real control plane · nothing here is a mock</span>
        <button className="cl-back" onClick={onClose} title="collapse (Esc)">
          ‹ dock
        </button>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------- controls ---- */

const MODES: ExecMode[] = ["live", "hybrid", "background"];

function ControlsTab() {
  const { halted, toggleHalt } = useHalt();
  const { mode, setMode } = useExecMode();
  const { toggles, setTool } = useToolToggles();
  const { sources } = useUsage();
  const cursorPool = useCursorPoolState();
  const { state: openAiBilling } = useOpenAiBilling();
  const autonomy = usePraxisStore((s) => s.autonomy);
  const navMode = usePraxisStore((s) => s.mode);
  const viewMode = usePraxisStore((s) => s.viewMode);
  const voiceListening = usePraxisStore((s) => s.voiceListening);
  // Live continuous-conversation state, straight from the engine's own broadcast
  // (VOICE_CONVERSATION_STATE) rather than a local flag that could drift from
  // what the mic is actually doing.
  const [conversationOn, setConversationOn] = useState(false);
  useEffect(() => {
    const onState = (e: Event) => setConversationOn(Boolean((e as CustomEvent).detail));
    window.addEventListener(VOICE_CONVERSATION_STATE, onState);
    return () => window.removeEventListener(VOICE_CONVERSATION_STATE, onState);
  }, []);
  const sigil = usePraxisStore((s) => s.clusterSigil);
  const { profile: voiceProfile, setProfile: setVoiceProfile } = useVoiceProfile();
  const voiceBackends = useVoiceBackends();
  const [restoring, setRestoring] = useState(false);
  const watchOpen = useWatchMe((s) => s.open);
  const watching = useWatchMe((s) => s.watching);
  const labelFont = useLabelFont((s) => s.font);
  const setLabelFont = useLabelFont((s) => s.setFont);

  const { tightest } = useMemo(
    () => buildRails(sources, 0, cursorPool),
    [sources, cursorPool],
  );
  const openBreakers = TOOL_ROWS.filter((r) => toggles[r.key] === false).length;

  // FOUR detents - the same canonical scale as the Command Center's gauge
  // (I OBSERVE · II PROPOSE · III EXECUTE · IV SOVEREIGN). The 5-key autonomy
  // ladder maps onto it exactly like TrustPanel.detentFromAutonomy (legacy
  // "suggest" → II), so the two windows can never disagree again.
  //
  // Scope: UNATTENDED runs only. Moving this dial changes nothing about what the owner
  // can do by voice while watching the screen - that path reads no trust level at
  // all (src/shared/actionOrigin.ts).
  const DETENTS = [
    { key: "observe", name: "I · OBSERVE" },
    { key: "approve", name: "II · PROPOSE" },
    { key: "operator", name: "III · EXECUTE" },
    { key: "full", name: "IV · SOVEREIGN" },
  ] as const;
  const detentIdx = (() => {
    const i = DETENTS.findIndex((d) => d.key === autonomy);
    return i >= 0 ? i : autonomy === "suggest" ? 1 : 2;
  })();
  const trust = TRUST_LEVELS.find((l) => l.key === autonomy);

  const pct = tightest ? Math.min(100, Math.round(tightest.pct)) : 0;
  const barC = pct >= 90 ? "var(--cc-ruby)" : pct >= 70 ? "var(--cc-pink)" : "var(--cc-emerald)";

  return (
    <div className="ctl">
      <div className="ctl-sec">
        <p className="ctl-label">Command</p>
        <button
          className={`ctl-halt ${halted ? "halted" : ""}`}
          onClick={toggleHalt}
          title="stop every agent, every mode, instantly"
        >
          {halted ? "HALTED · RESUME" : "HALT ALL"}
        </button>
      </div>

      <div className="ctl-sec">
        <p className="ctl-label">
          Mode <span className="whisper">{EXEC_MODE_META[mode].hint}</span>
        </p>
        <div className="ctl-mode" role="radiogroup" aria-label="execution mode">
          {MODES.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => setMode(m)}
              title={EXEC_MODE_META[m].hint}
            >
              {EXEC_MODE_META[m].label}
            </button>
          ))}
        </div>
      </div>

      <div className="ctl-sec">
        <p className="ctl-label">Trust</p>
        <div
          className="ctl-trust"
          data-level={autonomy}
          title={trust ? `${trust.blurb}\n${trust.guard}` : undefined}
        >
          <span className="detents" aria-hidden>
            {DETENTS.map((d, i) => (
              <span key={d.key} className={`detent ${i <= detentIdx ? "lit" : ""}`} />
            ))}
          </span>
          <span className="t-name">{DETENTS[detentIdx].name}</span>
        </div>
        <p className="ctl-note">set the dial in the command center</p>
      </div>

      <div className="ctl-sec">
        <p className="ctl-label">Tightest rail</p>
        <div
          className="ctl-rail-bar"
          style={{ "--bar-c": barC } as React.CSSProperties}
          aria-hidden
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="ctl-rail-meta" style={{ "--bar-c": barC } as React.CSSProperties}>
          <span>{tightest ? tightest.name : "ALL RAILS NOMINAL"}</span>
          <span className="pct">{tightest ? `${pct}%` : "—"}</span>
        </div>
        {openAiBilling.status === "ok" && openAiBilling.balance_usd != null && (
          <div
            className="ctl-rail-meta"
            style={{ "--bar-c": "var(--cc-emerald)" } as React.CSSProperties}
            title={`read from OpenAI at ${new Date(openAiBilling.read_at_ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
          >
            <span>OPENAI · LEFT</span>
            <span className="pct">${openAiBilling.balance_usd.toFixed(2)}</span>
          </div>
        )}
      </div>

      <div className="ctl-sec">
        <p className="ctl-label">
          Breakers{" "}
          <span className="whisper">
            {openBreakers === 0 ? "all closed" : `${openBreakers} open — nothing routes around them`}
          </span>
        </p>
        <div className="ctl-breakers">
          {TOOL_ROWS.map((r) => {
            const on = toggles[r.key] !== false;
            return (
              <button
                key={r.key}
                className={`ctl-brk ${on ? "" : "cut"}`}
                onClick={() => setTool(r.key, !on)}
                title={r.hint}
              >
                <span className="led" aria-hidden />
                {r.label.replace(" planning", "").replace("Computer Use", "Comp-Use")}
              </button>
            );
          })}
        </div>
      </div>

      <div className="ctl-sec">
        <p className="ctl-label">Controls</p>
        <div className="ctl-btns">
          <button
            className={`ctl-btn ${voiceListening ? "on" : ""}`}
            onClick={() => window.dispatchEvent(new Event("praxis:voice-toggle"))}
            title="one command — press, speak, press again to send (hold T is the same thing)"
          >
            <Glyph id="pulse" size={12} />
            {voiceListening ? "Listening…" : "Talk"}
          </button>
          {/* The continuous conversation. It existed only behind the invisible
              Ctrl+T -> Space chord, so the visible button beside it was the
              single-shot recognizer and a real conversation was unreachable. */}
          <button
            className={`ctl-btn ${conversationOn ? "on" : ""}`}
            onClick={() => voiceConversation()}
            title="continuous conversation — Praxis keeps listening and acts as you speak; interrupt any time. Click again to end."
          >
            <Glyph id="orbit" size={12} />
            {conversationOn ? "In conversation" : "Converse"}
          </button>
          <button
            className={`ctl-btn ${navMode === "gesture" ? "on" : ""}`}
            onClick={() => usePraxisStore.getState().toggleMode()}
            title="camera hand-tracking navigation"
          >
            <Glyph id="hand" size={12} />
            Gesture
          </button>
          <button
            className={`ctl-btn ${viewMode === "journey" ? "on" : ""}`}
            onClick={() => usePraxisStore.getState().toggleViewMode()}
            title="the roadmap tree · J"
          >
            <Glyph id="history" size={12} />
            Journey
          </button>
          <button
            className="ctl-btn"
            onClick={() =>
              usePraxisStore
                .getState()
                .setClusterSigil(
                  sigil === "glyph" ? "orbital" : sigil === "orbital" ? "constellation" : "glyph",
                )
            }
            title="cluster symbol style — cycle glyph · orbital reticle · constellation (the knot quiets under the alternatives so you can judge the mark itself)"
          >
            <Glyph id="orbit" size={12} />
            Sigil: {sigil === "glyph" ? "Glyph" : sigil === "orbital" ? "Orbital" : "Stars"}
          </button>
          {/* Watch-me lives here now (relocated from the old floating bottom-left chip).
              Opens the screen-share panel; the panel (WatchMe.tsx) owns the real
              start/stop + vision Q&A. Watch-me is OBSERVE-only (Praxis watches the owner's
              screen, it doesn't drive it), so it needs no exec-mode switch. */}
          <button
            className={`ctl-btn ${watching ? "on" : watchOpen ? "on" : ""}`}
            onClick={() => useWatchMe.getState().setOpen(!watchOpen)}
            title="let Praxis watch your screen and answer questions about it (observe-only)"
          >
            <Glyph id="pulse" size={12} />
            {watching ? "Watching" : "Watch me"}
          </button>
          {/* Settings, chat history and the ledger live on disk and survive it. */}
          <button
            className={`ctl-btn ${restoring ? "on" : ""}`}
            disabled={restoring}
            onClick={() => {
              setRestoring(true);
              void restoreEverything().then((r) => {
                if (!r.ok) usePraxisStore.getState().notify(r.detail);
              });
            }}
            title="reload everything — clears every cached reading, rebuilds the Flight Deck snapshot, and reloads all Praxis windows. Settings and history are kept."
          >
            <Glyph id="history" size={12} />
            {restoring ? "Restoring…" : "Restore"}
          </button>
        </div>
        {/* Say what the two buttons DO. The distinction that matters is who decides when a turn ends. */}
        <p className="ctl-note">
          {conversationOn
            ? "in conversation — praxis is listening continuously; just talk, and interrupt any time. Esc ends it."
            : "conversation = praxis listens continuously until you stop it · talk = hold T (or Ctrl+T anywhere) for one turn"}
        </p>
      </div>

      {/* The cluster-typeface picker was REMOVED 2026-08-03 - the owner locked the
          brain to Spectral 500. `labelFontStore` now ships that single face, so
          there is nothing to choose and a picker would be a control that changes
          nothing. It also retires the font-cycler crash class for good. */}

      <div className="ctl-sec">
        <p className="ctl-label">Voice</p>
        <div className="ctl-voice-opts" role="radiogroup" aria-label="TTS voice">
          {VOICE_OPTIONS.map((opt) => {
            // honest state: an option whose backend has no key is DISABLED with the
            // reason spelled out - never selectable-but-secretly-playing-Hume.
            const connected = voiceBackends === null || voiceBackends[opt.backend];
            return (
              <button
                key={opt.id}
                role="radio"
                aria-checked={voiceProfile === opt.id}
                disabled={!connected}
                className={`ctl-voice-opt ${voiceProfile === opt.id ? "on" : ""} ${connected ? "" : "cut"}`}
                onClick={() => connected && setVoiceProfile(opt.id)}
                title={connected ? undefined : `no ${opt.backend} key found — drop one in %LOCALAPPDATA%\\Praxis or the secrets vault`}
              >
                <span className="ctl-voice-name">{opt.label}</span>
                <span className="ctl-voice-hint">
                  {connected ? opt.hint : `${opt.hint} · not connected`}
                </span>
              </button>
            );
          })}
        </div>
        <p className="ctl-note">picks Praxis's TTS voice live — applies now, Atlas says it back so you hear it</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- detail card ---- */

interface DetailLink {
  id: string;
  label: string;
}

interface DetailInfo {
  kicker: string;
  title: string;
  meta: string;
  description?: string;
  agents: AgentLive[];
  links: DetailLink[];
  linksLabel: string;
}

/** Turn a live brain-node's detail into a pull-out document so the Inspector's
 *  ⤢ (and, later, a Praxis walkthrough) can present a node full-screen. */
function nodeToDoc(info: DetailInfo, node: BrainNode, hue: string | null): InboxDoc {
  const plain = (t: string): DocSection["ps"][number] => ({ t, mark: "", markColor: "transparent" });
  const sections: DocSection[] = [];
  if (info.description)
    sections.push({ h: "OVERVIEW", hColor: "rgba(233,226,211,.55)", ps: [plain(info.description)] });
  if (info.agents.length)
    sections.push({
      h: "ON IT NOW",
      hColor: "rgba(73,160,244,.8)",
      ps: info.agents.map((a) => plain(`${a.name} — ${a.role}`)),
    });
  if (info.links.length)
    sections.push({
      h: info.linksLabel.toUpperCase(),
      hColor: "rgba(233,226,211,.55)",
      ps: info.links.map((l) => plain(l.label)),
    });
  if (sections.length === 0)
    sections.push({ h: "DETAIL", hColor: "rgba(233,226,211,.55)", ps: [plain(info.meta)] });
  return {
    dot: hue ? `var(--area-${hue})` : "var(--cc-sapphire)",
    from: (info.kicker || node.kind).toUpperCase(),
    time: node.kind,
    title: info.title,
    meta: info.meta,
    sections,
    kind: "node",
  };
}

function DetailCard({ selectedId, wide = false }: { selectedId: string; wide?: boolean }) {
  const agents = usePraxisStore((s) => s.agents);
  const tasks = usePraxisStore((s) => s.tasks);
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const g = useMemo(() => buildGraph(), [graphVersion]);

  const node = g.byId.get(selectedId);

  const info = useMemo(() => {
    if (!node) return null;
    const description = describeNode(node);
    const toLinks = (ids: (string | undefined)[]): DetailLink[] =>
      ids
        .map((id) => (id ? g.byId.get(id) : undefined))
        .filter((n): n is BrainNode => !!n)
        .map((n) => ({ id: n.id, label: n.label }));

    if (node.kind === "task") {
      const live = tasks[node.id];
      const onIt = Object.values(agents).filter(
        (a) => a.taskId === node.id && a.status === "working" && isFiringAgent(a.id),
      );
      return {
        kicker: node.areaId ? g.byId.get(node.areaId)?.label ?? "" : "",
        title: node.label,
        meta: live?.active ? "working" : live ? "complete" : "idle",
        progress: live?.progress ?? 0,
        agents: onIt,
        description,
        linksLabel: "artifacts",
        links: toLinks(g.nodes.filter((n) => n.parentId === node.id).map((n) => n.id)),
      };
    }
    if (node.kind === "area") {
      const taskIds = g.tasksByArea.get(node.id) ?? [];
      const active = taskIds.filter((t) => tasks[t]?.active).length;
      const onIt = Object.values(agents).filter(
        (a) => a.areaId === node.id && a.status === "working" && isFiringAgent(a.id),
      );
      return {
        kicker: "initiative",
        title: node.label,
        meta: `${taskIds.length} tasks · ${active} active`,
        progress: -1,
        agents: onIt,
        description,
        linksLabel: "milestones",
        links: toLinks(taskIds),
      };
    }
    if (node.kind === "hub") {
      const working = selectFiringAgents(agents);
      const active = Object.values(tasks).filter((t) => t.active).length;
      return {
        kicker: "the core",
        title: "Praxis",
        meta: `${working.length} agents firing · ${active} tasks active`,
        progress: -1,
        agents: working,
        description,
        linksLabel: "initiatives",
        links: toLinks(g.nodes.filter((n) => n.tier === 1).map((n) => n.id)),
      };
    }
    return {
      kicker: node.areaId ? g.byId.get(node.parentId ?? "")?.label ?? "" : "",
      title: node.label,
      meta: node.kind,
      progress: -1,
      agents: [] as AgentLive[],
      description,
      linksLabel: "part of",
      links: toLinks([node.parentId ?? undefined]),
    };
  }, [node, agents, tasks, g]);

  // Hooks first, every render. These used to sit below the early returns, so the
  // selection moving between "not on the map yet" and "on the map" (a mission files
  // its goal as a journey node and focuses it before the graph holds it) changed the
  // hook count - React #300 - and, with no boundary around the dock, blanked the whole
  // main window (live 2026-10-10, right after the otters mission's result).
  // Node click → open the REAL linked file. If THIS node maps to a repo file,
  // surface a direct "open file" affordance in the header.
  const derivedSelf = node ? resolveNodePath(node) : null;
  // Every path this card might offer, checked on disk once. A derivation is a
  // guess; only a hit earns the openable affordance.
  const candidatePaths = useMemo(
    () => [derivedSelf, ...(info?.links ?? []).map((l) => {
      const n = g.byId.get(l.id);
      return n ? resolveNodePath(n) : null;
    })],
    [derivedSelf, info, g],
  );
  const existingPaths = useExistingPaths(candidatePaths);

  // An id the graph does not hold (a real file's synthetic "real:<path>", a node
  // dropped by a rebuild) used to render NOTHING - the Inspector went blank with
  // only its footer left, which reads as a broken panel rather than a miss.
  if (!node && selectedId) {
    const isFile = selectedId.startsWith("real:");
    return (
      <div className="insp-empty" style={{ padding: "14px 2px" }}>
        {isFile
          ? `${selectedId.slice(5).split(/[\/]/).pop()} — a real file, not a node on the map`
          : "that node is no longer on the map"}
      </div>
    );
  }
  if (!node || !info) return null;
  const hue = node.areaId ?? (node.kind === "area" ? node.id : null);
  const focus = (id: string) => usePraxisStore.getState().focus(id);
  const tauri = inTauri();
  const selfPath = derivedSelf ? existingPaths.get(derivedSelf) ?? null : null;

  return (
    <div
      className={`detail ${wide ? "is-wide" : ""}`}
      style={hue ? ({ "--g": `var(--area-${hue})` } as React.CSSProperties) : undefined}
    >
      <div className="detail-top">
        {/* single back affordance (P1-3): fly the camera back to overview AND
            close the card - the inverse of the fly-in that opened it. */}
        <button className="detail-back" onClick={() => usePraxisStore.getState().focus(null)}>
          ‹ back
        </button>
        <span className="detail-top-spacer" />
        {tauri && selfPath && (
          <button
            className="detail-open"
            onClick={() => openFile(selfPath, node.label)}
            title={`open ${node.label} in your editor`}
          >
            <Glyph id="files" size={11} /> open file
          </button>
        )}
        {!wide && (
          <button
            className="detail-expand"
            onClick={() => usePraxisStore.getState().setPulloutDoc(nodeToDoc(info, node, hue))}
            title="pull this out across the screen"
          >
            ⤢ expand
          </button>
        )}
        <span className={`detail-kind kind-${node.kind}`}>{node.kind}</span>
      </div>

      <div className="detail-id">
        <span className="detail-glyph" aria-hidden>
          <Glyph
            id={hue ? AREA_GLYPH[hue] ?? "praxis" : node.kind === "hub" ? "praxis" : "files"}
            size={17}
          />
        </span>
        <div>
          <p className="detail-kicker">{info.kicker}</p>
          <h2 className="detail-title">{info.title}</h2>
        </div>
      </div>

      {info.description && <p className="detail-desc">{info.description}</p>}

      <div className="detail-meta">{info.meta}</div>
      {node.kind === "task" && node.status && (
        <div className={`detail-plan plan-${node.status}`}>
          <span className="plan-status">{node.status}</span>
          {node.eta && <span className="plan-eta">{node.eta}</span>}
        </div>
      )}

      {info.progress >= 0 && (
        <div className="detail-progress">
          <div className="bar">
            <span style={{ width: `${Math.round(info.progress * 100)}%` }} />
          </div>
          <span className="mono">{Math.round(info.progress * 100)}%</span>
        </div>
      )}

      {info.agents.length > 0 && (
        <div className="detail-agents">
          <p className="detail-label">on it now</p>
          {info.agents.map((a) => (
            <div key={a.id} className="agent-row">
              <span className="insignia status-working sm" aria-hidden>
                <Glyph id={AGENT_GLYPH[a.id] ?? "hex"} size={12} />
              </span>
              <span className="agent-name mono">{a.name}</span>
              <span className="agent-role">{a.role}</span>
            </div>
          ))}
        </div>
      )}

      {info.links.length > 0 && (
        <div className="detail-links">
          <p className="detail-label">{info.linksLabel}</p>
          <div className="link-chips">
            {info.links.map((l) => {
              // Clicking a linked artifact opens the REAL file when one exists;
              // otherwise it flies the camera to the node. The ↗ marks the openable
              // ones - and a chip only earns it once the path has been CHECKED on
              // disk (existingPaths). It used to be granted from a string
              // derivation, so chips for other repos' files and for files that had
              // moved wore the arrow and did nothing when clicked.
              const linkNode = g.byId.get(l.id);
              const derived = tauri && linkNode ? resolveNodePath(linkNode) : null;
              const path = derived ? existingPaths.get(derived) ?? null : null;
              return (
                <button
                  key={l.id}
                  className={`link-chip ${path ? "openable" : ""}`}
                  onClick={() => (path ? openFile(path, l.label) : focus(l.id))}
                  title={path ? `open ${l.label} in your editor` : `fly to ${l.label}`}
                >
                  {l.label}
                  {path && <span className="link-open" aria-hidden>↗</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
