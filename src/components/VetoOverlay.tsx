/**
 * VetoOverlay - the human veto gate for Praxis' Sovereign (Trust IV) layer.
 *
 * When the sovereign engine (src-tauri/src/sovereign.rs) is about to take an
 * IRREVERSIBLE action on the owner's behalf - pay, post, send a message/email, submit
 * a login, create an account, accept a ToS - it emits `praxis://veto-request`
 * and BLOCKS. This overlay shows the exact action (the amount + recipient, the
 * post text, the email body, the login target) with Approve / Reject, and emits
 * `praxis://veto-response { veto_id, approved }` back. Rust proceeds only on an
 * approval; a rejection (or the request's TTL lapsing) cancels the step.
 *
 * Mounted once in the MAIN (brain) window from src/App.tsx. Inert outside the
 * Tauri shell - the event import fails silently in a plain browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

interface VetoRequest {
  veto_id: number;
  action: string;
  summary: string;
  // The redacted planner decision: selector, url, value (password shown as ••••),
  // key, etc. We surface whatever the action carries.
  args: Record<string, unknown>;
}

/** Human labels + a warmth cue per irreversible action class. */
const ACTION_META: Record<string, { label: string; verb: string; tone: "pay" | "post" | "send" | "auth" }> = {
  pay: { label: "Payment", verb: "Pay", tone: "pay" },
  purchase: { label: "Purchase", verb: "Buy", tone: "pay" },
  post: { label: "Public post", verb: "Post", tone: "post" },
  send: { label: "Send message", verb: "Send", tone: "send" },
  submit_login: { label: "Log in", verb: "Log in", tone: "auth" },
  create_account: { label: "Create account", verb: "Create", tone: "auth" },
  accept_tos: { label: "Accept terms", verb: "Accept", tone: "auth" },
};

function metaFor(action: string) {
  return ACTION_META[action] ?? { label: action, verb: "Proceed", tone: "auth" as const };
}

async function emitResponse(vetoId: number, approved: boolean) {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("praxis://veto-response", { veto_id: vetoId, approved });
  } catch {
    /* not in the Tauri shell - nothing listening */
  }
}

export function VetoOverlay() {
  const [req, setReq] = useState<VetoRequest | null>(null);
  const respondedRef = useRef(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<VetoRequest>("praxis://veto-request", (e) => {
          respondedRef.current = false;
          setReq(e.payload);
        }),
      )
      .then((f) => {
        // Unlisten immediately if we unmounted before listen() resolved,
        // otherwise the veto-request listener leaks.
        if (cancelled) f();
        else off = f;
      })
      .catch(() => {
        /* not inside the Tauri shell - gate stays dormant */
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const respond = useCallback(
    (approved: boolean) => {
      if (!req || respondedRef.current) return;
      respondedRef.current = true;
      void emitResponse(req.veto_id, approved);
      setReq(null);
    },
    [req],
  );

  // Safety TTL: Rust (sovereign.rs, VETO_TTL_SECS = 180s) cancels the action if no
  // response arrives, but emits no cancel event - so without this the gate could sit
  // up forever, and a click made AFTER Rust's TTL would dismiss the card as if it had
  // taken effect. Auto-reject a little before the backend's window so the gate always
  // self-clears and a lapsed request never reads as approved. (175s < 180s.)
  useEffect(() => {
    if (!req) return;
    const id = window.setTimeout(() => respond(false), 175_000);
    return () => window.clearTimeout(id);
  }, [req, respond]);

  // Keyboard: Enter approves, Esc rejects - but ONLY while a request is up.
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        respond(false);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        respond(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req, respond]);

  return (
    <>
      <VetoStyles />
      <AnimatePresence>
        {req && <VetoCard key={req.veto_id} req={req} onApprove={() => respond(true)} onReject={() => respond(false)} />}
      </AnimatePresence>
    </>
  );
}

function VetoCard({
  req,
  onApprove,
  onReject,
}: {
  req: VetoRequest;
  onApprove: () => void;
  onReject: () => void;
}) {
  const meta = metaFor(req.action);
  const detail = renderArgs(req.args);

  return (
    <motion.div
      className="veto-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      role="alertdialog"
      aria-modal="true"
      aria-label={`Confirm ${meta.label}`}
    >
      <motion.div
        className="veto-card"
        data-tone={meta.tone}
        initial={{ y: 22, scale: 0.96, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 14, scale: 0.97, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
      >
        <header className="veto-head">
          <span className="veto-sigil" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <div className="veto-titles">
            <span className="veto-kicker">Sovereign · human veto</span>
            <strong className="veto-title">{meta.label}</strong>
          </div>
          <span className="veto-badge" data-tone={meta.tone}>
            irreversible
          </span>
        </header>

        <p className="veto-summary">{req.summary}</p>

        {detail.length > 0 && (
          <dl className="veto-args">
            {detail.map(({ k, v }) => (
              <div className="veto-arg" key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        <footer className="veto-actions">
          <button className="veto-btn veto-reject" onClick={onReject} autoFocus>
            Reject <kbd>Esc</kbd>
          </button>
          <button className="veto-btn veto-approve" data-tone={meta.tone} onClick={onApprove}>
            {meta.verb} · Approve <kbd>⌘↵</kbd>
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}

/** Turn the redacted arg bag into a small labelled list, hiding plumbing keys. */
function renderArgs(args: Record<string, unknown>): Array<{ k: string; v: string }> {
  if (!args || typeof args !== "object") return [];
  const HIDE = new Set(["action", "summary", "done", "credential"]);
  const LABEL: Record<string, string> = {
    value: "Value",
    url: "Target",
    selector: "Element",
    key: "Key",
    amount: "Amount",
    recipient: "Recipient",
    body: "Body",
    text: "Text",
  };
  const out: Array<{ k: string; v: string }> = [];
  for (const [key, raw] of Object.entries(args)) {
    if (HIDE.has(key)) continue;
    if (raw == null || raw === "") continue;
    const v = typeof raw === "string" ? raw : JSON.stringify(raw);
    out.push({ k: LABEL[key] ?? key, v });
  }
  return out;
}

/** One-time injected styles - keeps the gate a single self-contained file that
 *  speaks the brain window's glass language (see styles/hud.css, operator.css). */
function VetoStyles() {
  return (
    <style>{`
      .veto-scrim {
        position: fixed; inset: 0; z-index: 120;
        display: grid; place-items: center;
        padding: 24px;
        background: radial-gradient(120% 120% at 50% 30%, rgba(4,8,20,0.62), rgba(2,4,12,0.86));
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      }
      .veto-card {
        --v-accent: #3b6cff; --v-good: #34e0a0; --v-bad: #ff5c47;
        --v-bg: rgba(6,10,22,0.86);
        width: min(520px, calc(100vw - 48px));
        padding: 20px 22px 18px;
        color: var(--text, #eaf2ff);
        border: 1px solid color-mix(in srgb, var(--v-accent) 30%, rgba(255,255,255,0.10));
        border-radius: 20px;
        background: linear-gradient(168deg, color-mix(in srgb, var(--v-accent) 8%, var(--v-bg)), var(--v-bg) 64%);
        -webkit-backdrop-filter: blur(26px) saturate(1.25); backdrop-filter: blur(26px) saturate(1.25);
        box-shadow: 0 40px 100px -34px rgba(0,0,0,0.92),
                    0 0 56px -20px color-mix(in srgb, var(--v-accent) 60%, transparent),
                    inset 0 1px 0 rgba(255,255,255,0.06);
        position: relative; overflow: hidden;
      }
      .veto-card[data-tone="pay"]  { --v-accent: #ffb020; }
      .veto-card[data-tone="post"] { --v-accent: #7b5cff; }
      .veto-card[data-tone="send"] { --v-accent: #2fd0c6; }
      .veto-card[data-tone="auth"] { --v-accent: #3b6cff; }
      .veto-card::before, .veto-card::after {
        content: ""; position: absolute; width: 14px; height: 14px; pointer-events: none;
      }
      .veto-card::before {
        top: -1px; left: -1px; border-top-left-radius: 20px;
        border-top: 1px solid color-mix(in srgb, var(--v-accent) 72%, transparent);
        border-left: 1px solid color-mix(in srgb, var(--v-accent) 72%, transparent);
      }
      .veto-card::after {
        bottom: -1px; right: -1px; border-bottom-right-radius: 20px;
        border-bottom: 1px solid color-mix(in srgb, var(--v-accent) 72%, transparent);
        border-right: 1px solid color-mix(in srgb, var(--v-accent) 72%, transparent);
      }
      .veto-head { display: flex; align-items: center; gap: 11px; margin-bottom: 12px; }
      .veto-sigil { display: inline-flex; gap: 3px; align-items: flex-end; height: 18px; }
      .veto-sigil i {
        width: 3px; border-radius: 2px; background: var(--v-accent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--v-accent) 80%, transparent);
        animation: veto-pulse 1.2s ease-in-out infinite;
      }
      .veto-sigil i:nth-child(1) { height: 8px; animation-delay: 0s; }
      .veto-sigil i:nth-child(2) { height: 16px; animation-delay: 0.15s; }
      .veto-sigil i:nth-child(3) { height: 11px; animation-delay: 0.3s; }
      @keyframes veto-pulse { 0%,100% { opacity: 0.55; transform: scaleY(0.8); } 50% { opacity: 1; transform: scaleY(1); } }
      .veto-titles { display: flex; flex-direction: column; line-height: 1.2; margin-right: auto; }
      .veto-kicker { font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(220,232,255,0.5); }
      .veto-title { font-size: 17px; font-weight: 650; }
      .veto-badge {
        font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
        padding: 4px 8px; border-radius: 999px; color: #0a0f1e; font-weight: 700;
        background: color-mix(in srgb, var(--v-accent) 82%, white);
      }
      .veto-summary { margin: 0 0 14px; font-size: 14px; line-height: 1.5; color: rgba(234,242,255,0.92); }
      .veto-args {
        margin: 0 0 16px; padding: 12px 14px; display: grid; gap: 9px;
        border-radius: 13px; background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.07);
      }
      .veto-arg { display: grid; grid-template-columns: 92px 1fr; gap: 10px; align-items: baseline; }
      .veto-arg dt { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(220,232,255,0.46); margin: 0; }
      .veto-arg dd { margin: 0; font-size: 13px; color: #eaf2ff; word-break: break-word; overflow-wrap: anywhere; }
      .veto-actions { display: flex; gap: 10px; }
      .veto-btn {
        flex: 1; padding: 11px 14px; border-radius: 12px; cursor: pointer;
        font-size: 13.5px; font-weight: 600; letter-spacing: 0.01em;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);
        color: #eaf2ff; transition: transform 0.12s ease, background 0.15s ease, border-color 0.15s ease;
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      }
      .veto-btn:hover { transform: translateY(-1px); }
      .veto-btn:active { transform: translateY(0); }
      .veto-btn kbd {
        font: inherit; font-size: 10.5px; padding: 1px 6px; border-radius: 6px;
        background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.12); color: rgba(234,242,255,0.7);
      }
      .veto-reject:hover { border-color: color-mix(in srgb, var(--v-bad) 55%, transparent); background: color-mix(in srgb, var(--v-bad) 14%, rgba(255,255,255,0.05)); }
      .veto-approve {
        color: #050a16; font-weight: 700; border: none;
        background: linear-gradient(180deg, color-mix(in srgb, var(--v-accent) 92%, white), var(--v-accent));
        box-shadow: 0 10px 26px -12px color-mix(in srgb, var(--v-accent) 80%, transparent);
      }
      .veto-approve kbd { background: rgba(0,0,0,0.16); color: rgba(5,10,22,0.7); border-color: rgba(5,10,22,0.18); }
      @media (prefers-reduced-motion: reduce) {
        .veto-sigil i { animation: none; }
      }
    `}</style>
  );
}
