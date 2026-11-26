/**
 * ManifestPanel - the shared task manifest (center column, below the divider).
 * Ported 1:1 from the approved Claude Design package, wired onto the REAL
 * todoStore: checkbox crosses off, jot input files a task on Enter, Praxis's
 * own completions arrive via the existing `praxis://task-complete` event.
 * Origin glyph: ◆ sapphire = filed by Praxis (roadmap/memory/orchestrator),
 * ○ faint = filed by you (manual/voice). Caption reflects planner health.
 */

import { useState } from "react";
import { C, FONT, panelHead, headTick, headLabel, headCaption } from "./ccTheme";
import type { TodoStore } from "./todoStore";

/** Small words kept lowercase mid-phrase in Title Case. */
const TITLE_SMALL = new Set(["a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "vs", "via", "with", "by", "at", "per"]);

/**
 * Humanize a ledger-filed task title for DISPLAY - the intent-ledger seeds raw slugs
 * ("estTokens Load-figure product call", "codex-run outcome badge / dead emitter")
 * that read like code, not a to-do (2026-07-10 Codex live QA #9). Strips code/path
 * refs, splits camelCase/hyphen-joins, and Title-Cases the result. Presentation only:
 * the raw text stays the storage + fuzzy-match key (and the hover title), so nothing
 * about the real ledger source changes. Falls back to the original if stripping
 * leaves nothing.
 */
function humanizeTask(text: string): string {
  const raw = (text || "").trim();
  if (!raw) return raw;
  let s = raw;
  s = s.replace(/`+/g, ""); // drop backticks
  s = s.replace(/\bsrc\/[^\s)]+/gi, " "); // drop src/... code paths
  s = s.replace(/\b[\w-]+\.(tsx?|jsx?|rs|py|md|json|css|html)\b/gi, " "); // drop file.ext refs
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2"); // split camelCase
  s = s.replace(/(\w)-(\w)/g, "$1 $2"); // hyphen-joined slugs → words
  s = s.replace(/[_]+/g, " "); // underscores → space
  s = s.replace(/\s*\/\s*/g, " · "); // slash separators → middot
  s = s.replace(/\s{2,}/g, " ").trim();
  if (!s) return raw; // stripped to nothing - keep the original
  return s
    .split(" ")
    .map((w, i) => {
      if (!w || w === "·") return w;
      if (w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w; // keep acronyms (CC, QA, API, IV)
      const lower = w.toLowerCase();
      if (i > 0 && TITLE_SMALL.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function ManifestPanel({
  todo,
  hermesToggleOn,
  engineDegraded,
}: {
  todo: TodoStore;
  hermesToggleOn: boolean;
  engineDegraded: boolean;
}) {
  const [jot, setJot] = useState("");
  const openCount = todo.upcoming.length;

  // "N open" is a claim about the ledger. When the ledger could not be READ, a
  // failure used to become an empty list and render as "0 open" - asserting there
  // is nothing to do when the truth is that the source is unavailable.
  const ledgerBroken = todo.ledgerState === "unavailable";
  const manifestNote = !hermesToggleOn
    ? "planner breaker open — praxis won't self-schedule"
    : engineDegraded
      ? "planner lagging — syncing slowly"
      : ledgerBroken
        ? "intent ledger unavailable — this list may be out of date"
        : todo.ledgerState === "loading"
          ? "reading the intent ledger…"
          : `${openCount} open · praxis crosses off as work lands`;
  const noteWarn = !hermesToggleOn || engineDegraded || ledgerBroken;

  return (
    <div style={{ flex: 1, minHeight: 120, background: C.panel, display: "flex", flexDirection: "column" }}>
      <div style={panelHead}>
        <span style={headTick("rgba(73,160,244,.85)")} />
        <span style={headLabel}>MANIFEST</span>
        <span style={{ flex: 1 }} />
        <span style={{ ...headCaption, color: noteWarn ? "rgba(232,80,157,.8)" : "rgba(233,226,211,.32)" }}>{manifestNote}</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {todo.upcoming.map((t) => {
          const praxisFiled = t.source === "roadmap" || t.source === "memory";
          // Ledger-filed slugs get humanized for display; a task you typed yourself
          // is shown exactly as written.
          const label = praxisFiled ? humanizeTask(t.text) : t.text;
          return (
            <div
              key={t.id}
              style={{
                display: "grid",
                gridTemplateColumns: "14px 12px minmax(0,1fr) auto",
                gap: 9,
                alignItems: "center",
                padding: "8px 14px",
                borderBottom: "1px solid rgba(233,220,196,.04)",
              }}
            >
              <button
                type="button"
                title="cross it off"
                onClick={() => todo.completeTask(t.id)}
                style={{ width: 12, height: 12, border: "1px solid rgba(233,220,196,.32)", background: "transparent", cursor: "pointer", padding: 0 }}
              />
              <span title={praxisFiled ? "praxis filed this" : "you filed this"} style={{ fontSize: 9, color: praxisFiled ? "rgba(73,160,244,.9)" : C.faint }}>
                {praxisFiled ? "◆" : "○"}
              </span>
              <span title={t.text} style={{ fontSize: 12, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10.5, color: C.faint, whiteSpace: "nowrap" }}>
                {t.source === "voice" ? "spoken" : t.source === "memory" ? "from the ledger" : t.source === "roadmap" ? "roadmap" : ""}
              </span>
            </div>
          );
        })}

        {todo.done.length > 0 && (
          <>
            <div style={{ padding: "10px 14px 2px", fontSize: 8.5, letterSpacing: ".22em", color: "rgba(233,226,211,.28)" }}>EARLIER</div>
            {todo.done.map((d) => (
              <div key={d.id} style={{ display: "flex", gap: 9, alignItems: "baseline", padding: "5px 14px" }}>
                <span style={{ color: "rgba(43,226,143,.65)", fontSize: 10 }}>✓</span>
                <span style={{ fontSize: 11, color: "rgba(233,226,211,.38)", textDecoration: "line-through" }}>{d.text}</span>
                <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10, color: "rgba(233,226,211,.28)" }}>
                  {d.doneAt ? new Date(d.doneAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
              </div>
            ))}
          </>
        )}
        <div style={{ height: 8 }} />
      </div>

      <div
        style={{
          flex: "none",
          display: "flex",
          gap: 9,
          alignItems: "center",
          padding: "9px 14px",
          borderTop: "1px solid rgba(233,220,196,.07)",
          background: C.inset,
        }}
      >
        <span style={{ color: C.sapphireLt, fontSize: 11, textShadow: "0 0 6px rgba(142,203,255,.5)" }}>❯</span>
        <input
          value={jot}
          onChange={(e) => setJot(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = jot.trim();
              if (v) {
                todo.addTask(v, "manual");
                setJot("");
              }
            }
          }}
          placeholder="jot it down — enter files it"
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: C.ink, fontFamily: "inherit", fontSize: 12 }}
        />
      </div>
    </div>
  );
}
