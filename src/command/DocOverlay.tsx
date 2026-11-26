/**
 * DocOverlay - the full-screen document view for big reports (board digests,
 * org sweeps, research briefs). Ported 1:1 from the approved Claude Design
 * package: dim + blur backdrop, centered card, serif title, colored section
 * heads, optional mark glyphs per paragraph. Closes on ESC (App-level listener),
 * backdrop click, or the buttons. The board digest additionally gets a
 * Regenerate action - the old card's manual refresh, kept in-idiom.
 */

import { C, FONT } from "./ccTheme";
import type { InboxDoc } from "./inboxStore";

export function DocOverlay({
  doc,
  onClose,
  onRegenerate,
  regenerating,
}: {
  doc: InboxDoc;
  onClose: () => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(4,3,3,.82)",
        backdropFilter: "blur(5px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(760px,88vw)",
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          background: "#171412",
          border: "1px solid rgba(233,220,196,.18)",
          boxShadow: "0 24px 80px rgba(0,0,0,.6)",
        }}
      >
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid rgba(233,220,196,.09)", background: "#1b1815" }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: doc.dot, boxShadow: `0 0 7px ${doc.dot}` }} />
          <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: ".2em", color: "rgba(233,226,211,.6)" }}>{doc.from}</span>
          <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 11, color: "rgba(233,226,211,.35)" }}>{doc.time}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="px-hover-border"
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid rgba(233,220,196,.16)",
              color: "rgba(233,226,211,.6)",
              fontFamily: "inherit",
              fontSize: 10,
              letterSpacing: ".14em",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            ESC · CLOSE
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "26px 34px 30px" }}>
          <div style={{ fontFamily: FONT.serif, fontSize: 26, lineHeight: 1.2, letterSpacing: ".01em", marginBottom: 4 }}>{doc.title}</div>
          <div style={{ fontSize: 9, letterSpacing: ".2em", color: "rgba(233,226,211,.4)", marginBottom: 18 }}>{doc.meta}</div>
          {doc.sections.map((sec, i) => (
            <div key={`${sec.h}-${i}`} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: ".22em", color: sec.hColor, marginBottom: 8 }}>{sec.h}</div>
              {sec.ps.map((p, j) => (
                <div key={j} style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                  <span style={{ flex: "none", color: p.markColor, fontSize: 10, paddingTop: 4 }}>{p.mark}</span>
                  <span style={{ fontFamily: FONT.serif, fontSize: 14.5, lineHeight: 1.65, color: "rgba(233,226,211,.85)" }}>{p.t}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ flex: "none", display: "flex", gap: 8, alignItems: "center", padding: "11px 18px", borderTop: "1px solid rgba(233,220,196,.09)", background: "#14110f" }}>
          <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 11, color: "rgba(233,226,211,.35)" }}>
            filed to the vault · praxis keeps the original
          </span>
          <span style={{ flex: 1 }} />
          {onRegenerate && (
            <button
              type="button"
              className="px-hover-border"
              disabled={regenerating}
              onClick={onRegenerate}
              style={{
                background: "none",
                border: "1px solid rgba(233,220,196,.16)",
                color: "rgba(233,226,211,.6)",
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: ".14em",
                padding: "5px 12px",
                cursor: regenerating ? "default" : "pointer",
              }}
            >
              {regenerating ? "REGENERATING…" : "REGENERATE"}
            </button>
          )}
          <button
            type="button"
            className="px-hover-done"
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid rgba(73,160,244,.4)",
              color: C.sapphireLt,
              fontFamily: "inherit",
              fontSize: 10,
              letterSpacing: ".14em",
              padding: "5px 12px",
              cursor: "pointer",
            }}
          >
            DONE
          </button>
        </div>
      </div>
    </div>
  );
}
