/**
 * InboxPanel - "surface anything Praxis needs me to see" (left column, fills
 * remaining height). Ported 1:1 from the approved Claude Design package.
 * Small update → inline row (click marks read). Big report → `REPORT ⇗` tag,
 * click opens the full-screen document overlay. Items come from inboxStore's
 * REAL sources (board digest, org report, research inbox, Hermes health, and work
 * Praxis delivered from Mission - those rows carry real Open buttons).
 */

import { useEffect, useRef, useState } from "react";
import { C, FONT, panelHead, headTick, headLabel } from "./ccTheme";
import {
  commitDismiss,
  commitDismissMany,
  commitMarkAllRead,
  commitRestore,
  dismissableIds,
  dismissableReadIds,
  isInboxDismissable,
  useInboxUndo,
  type InboxItem,
} from "./inboxStore";
import type { MissionArtifact } from "@/orchestrator/missionThread";
import { effectiveKind } from "@/components/mission/openArtifact";
import { useArtifactOpen } from "@/components/mission/useArtifactOpen";

/** One real Open button on a delivered row - same open path (and honest pending / opened /
 *  error states) as the Mission chat's buttons, in the Command Center's own dress. */
function ActionButton({ art, color }: { art: MissionArtifact; color: string }) {
  const { state, run } = useArtifactOpen(art);
  const kind = effectiveKind(art);
  const fallback = kind === "folder" ? "Open folder" : kind === "file" ? "Open file" : kind === "url" ? "Open link" : "Open preview";
  const label = (art.label.trim() || fallback).toUpperCase();
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 0, maxWidth: "100%" }}>
      <button
        type="button"
        className="px-hover-bright px-open"
        onClick={run}
        title={art.target}
        aria-busy={state.status === "pending" || undefined}
        style={{
          padding: "4px 9px",
          fontFamily: "inherit",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: ".12em",
          color,
          background: "transparent",
          border: `1px solid ${color}55`,
          cursor: state.status === "pending" ? "progress" : "pointer",
        }}
      >
        {state.status === "pending" ? "OPENING…" : state.status === "opened" ? "OPENED ✓" : label}
      </button>
      {state.status === "error" && (
        <span role="alert" style={{ fontSize: 10, lineHeight: 1.4, color: C.pink, overflowWrap: "anywhere" }}>
          {state.message}
        </span>
      )}
    </span>
  );
}

export function InboxPanel({
  items,
  unreadCount,
  onOpen,
}: {
  items: InboxItem[];
  unreadCount: number;
  onOpen: (item: InboxItem) => void;
}) {
  // App owns `useInbox` and only passes the list. These writes notify that hook
  // (local event + storage) so this panel and the brain dock stay on one set.
  const undo = useInboxUndo(commitRestore);
  const canManage = dismissableIds(items).length > 0;
  const anyUnread = items.some((n) => n.unread && isInboxDismissable(n.id));
  const anyRead = dismissableReadIds(items).length > 0;
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
    // Capture so Escape closes the menu without also collapsing a pull-out.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  const dismissOne = (id: string) => {
    if (!commitDismiss(id)) return;
    undo.arm([id]);
  };

  return (
    <div style={{ flex: 1, minHeight: 130, background: C.panel, display: "flex", flexDirection: "column" }}>
      <div style={{ ...panelHead, position: "relative", zIndex: 2 }}>
        <span style={headTick("rgba(232,80,157,.85)")} />
        <span style={headLabel}>INBOX</span>
        <span style={{ flex: 1 }} />
        {canManage && (
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              type="button"
              className="px-inbox-menu-btn"
              aria-label="Inbox actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Inbox actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="px-inbox-menu" role="menu" aria-label="Inbox actions">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!anyUnread}
                  onClick={() => {
                    commitMarkAllRead(dismissableIds(items));
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
                    const ids = commitDismissMany(dismissableReadIds(items));
                    undo.arm(ids);
                    setMenuOpen(false);
                  }}
                >
                  Clear read
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const ids = commitDismissMany(dismissableIds(items));
                    undo.arm(ids);
                    setMenuOpen(false);
                  }}
                >
                  Clear all
                </button>
              </div>
            )}
          </div>
        )}
        <span style={{ fontSize: 9, letterSpacing: ".12em", color: unreadCount > 0 ? C.pink : "rgba(233,226,211,.35)" }}>
          {unreadCount > 0 ? `${unreadCount} UNREAD` : "CLEAR"}
        </span>
      </div>
      {undo.visible && (
        <div className="px-inbox-undo" role="status">
          <span>
            {undo.count} deleted ·
          </span>
          <button type="button" onClick={undo.undo}>
            UNDO
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {items.map((n) => (
          <div key={n.id} className="px-inbox-row" style={{ borderBottom: "1px solid rgba(233,220,196,.04)" }}>
          <button
            type="button"
            className="px-hover-row"
            title={n.doc ? "opens as a document" : "tap to mark read"}
            onClick={() => onOpen(n)}
            style={{
              display: "grid",
              gridTemplateColumns: "10px minmax(0,1fr) auto",
              gap: 9,
              alignItems: "start",
              width: "100%",
              textAlign: "left",
              padding: "7px 14px",
              paddingRight: isInboxDismissable(n.id) ? 32 : 14,
              background: n.unread ? "rgba(73,160,244,.03)" : "transparent",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              fontFamily: "inherit",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                marginTop: 4,
                background: n.unread ? n.dotColor : "rgba(233,226,211,.18)",
                boxShadow: n.unread ? `0 0 6px ${n.dotColor}` : "none",
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".16em", color: n.unread ? "rgba(233,226,211,.7)" : "rgba(233,226,211,.4)" }}>
                  {n.from}
                </span>
                {n.doc && (
                  <span style={{ fontSize: 8, letterSpacing: ".12em", color: "rgba(142,203,255,.85)", border: "1px solid rgba(73,160,244,.35)", padding: "1px 4px" }}>
                    REPORT ⇗
                  </span>
                )}
                {n.tag && (
                  <span style={{ fontSize: 8, letterSpacing: ".12em", color: n.dotColor, border: `1px solid ${n.dotColor}59`, padding: "1px 4px" }}>
                    {n.tag}
                  </span>
                )}
              </span>
              {n.title && (
                <span style={{ display: "block", fontSize: 11.5, fontWeight: 500, lineHeight: 1.35, color: n.unread ? C.ink : "rgba(233,226,211,.55)", marginTop: 3 }}>
                  {n.title}
                </span>
              )}
              <span style={{ display: "block", fontSize: 11, lineHeight: 1.4, color: n.unread ? C.ink : "rgba(233,226,211,.45)", marginTop: 3 }}>
                {n.text}
              </span>
            </span>
            <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10, color: "rgba(233,226,211,.3)", whiteSpace: "nowrap" }}>{n.time}</span>
          </button>
          {isInboxDismissable(n.id) && (
            <button
              type="button"
              className="px-inbox-x"
              aria-label="Delete this message"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                dismissOne(n.id);
              }}
            >
              ×
            </button>
          )}
          {n.actions && n.actions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: "1px 14px 9px 33px" }}>
              {n.actions.map((a, i) => (
                <ActionButton key={`${a.kind}:${a.target}:${i}`} art={a} color={n.dotColor} />
              ))}
            </div>
          )}
          </div>
        ))}
        <div style={{ padding: "7px 14px", fontFamily: FONT.serif, fontStyle: "italic", fontSize: 10.5, color: "rgba(233,226,211,.28)" }}>
          small things land here — big things open as documents.
        </div>
      </div>
    </div>
  );
}
