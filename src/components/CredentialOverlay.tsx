/**
 * CredentialOverlay - the "give Praxis a password ONCE" gate for the Sovereign
 * (Trust IV) layer.
 *
 * When the sovereign engine (src-tauri/src/sovereign.rs) needs a credential to
 * log in AND the DPAPI vault has no entry for that label, it emits
 * `praxis://credential-request { cred_id, label, field, known_username }` and
 * BLOCKS. This overlay asks the owner for the missing username/password ONE time and
 * emits `praxis://credential-response { cred_id, value, provided }`. Rust persists
 * the answer to the DPAPI vault, so every later sovereign action reuses it and
 * never asks again. A cancel (or the request's TTL lapsing) fails the action
 * closed - Praxis never proceeds with a blank secret.
 *
 * The secret is typed here and rides ONE event straight to Rust; it is never
 * logged, never echoed back, and the field is cleared on close. Mounted once in
 * the MAIN (brain) window from src/App.tsx, alongside VetoOverlay. Inert outside
 * the Tauri shell.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

interface CredentialRequest {
  cred_id: number;
  label: string;
  /** "username" | "password" - which field the vault is missing. */
  field: string;
  /** Whatever Rust already knows (e.g. the username when only the password is
   *  missing). NEVER a secret. */
  known_username: string;
}

async function emitResponse(credId: number, value: string, provided: boolean) {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("praxis://credential-response", { cred_id: credId, value, provided });
  } catch {
    /* not in the Tauri shell - nothing listening */
  }
}

export function CredentialOverlay() {
  const [req, setReq] = useState<CredentialRequest | null>(null);
  const respondedRef = useRef(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<CredentialRequest>("praxis://credential-request", (e) => {
          respondedRef.current = false;
          setReq(e.payload);
        }),
      )
      .then((f) => {
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
    (value: string, provided: boolean) => {
      if (!req || respondedRef.current) return;
      respondedRef.current = true;
      void emitResponse(req.cred_id, provided ? value : "", provided);
      setReq(null);
    },
    [req],
  );

  // Safety TTL: Rust (sovereign.rs, VETO_TTL_SECS = 180s) aborts the action if no
  // response arrives but emits no cancel event, so auto-decline just before the
  // backend window (175s < 180s) - the gate always self-clears and a lapsed prompt
  // can never read as "provided".
  useEffect(() => {
    if (!req) return;
    const id = window.setTimeout(() => respond("", false), 175_000);
    return () => window.clearTimeout(id);
  }, [req, respond]);

  return (
    <>
      <CredentialStyles />
      <AnimatePresence>
        {req && <CredentialCard key={req.cred_id} req={req} onSubmit={(v) => respond(v, true)} onCancel={() => respond("", false)} />}
      </AnimatePresence>
    </>
  );
}

function CredentialCard({
  req,
  onSubmit,
  onCancel,
}: {
  req: CredentialRequest;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isPassword = req.field === "password";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc cancels; the form's onSubmit handles Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return; // empty = don't fail-closed by accident; require a value or Cancel
    setValue(""); // clear the secret from state the moment it leaves
    onSubmit(v);
  };

  return (
    <motion.div
      className="cred-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      role="alertdialog"
      aria-modal="true"
      aria-label={`Provide ${req.field} for ${req.label}`}
    >
      <motion.form
        className="cred-card"
        onSubmit={submit}
        initial={{ y: 22, scale: 0.96, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 14, scale: 0.97, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
      >
        <header className="cred-head">
          <span className="cred-sigil" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <div className="cred-titles">
            <span className="cred-kicker">Sovereign · credential vault</span>
            <strong className="cred-title">
              {isPassword ? "Password" : "Username"} for {req.label}
            </strong>
          </div>
          <span className="cred-badge">saved once</span>
        </header>

        <p className="cred-summary">
          Praxis needs the {req.field} for <b>{req.label}</b> to continue.
          {req.known_username && !isPassword ? "" : req.known_username ? ` Signing in as ${req.known_username}.` : ""} It'll be
          stored in your encrypted vault (Windows DPAPI) and reused — you won't be asked again.
        </p>

        <input
          ref={inputRef}
          className="cred-input"
          type={isPassword ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isPassword ? "Enter password" : "Enter username"}
          autoComplete={isPassword ? "current-password" : "username"}
          spellCheck={false}
        />

        <footer className="cred-actions">
          <button type="button" className="cred-btn cred-cancel" onClick={onCancel}>
            Cancel <kbd>Esc</kbd>
          </button>
          <button type="submit" className="cred-btn cred-save" disabled={!value.trim()}>
            Save &amp; continue <kbd>↵</kbd>
          </button>
        </footer>
      </motion.form>
    </motion.div>
  );
}

/** One-time injected styles - same glass language as VetoOverlay. */
function CredentialStyles() {
  return (
    <style>{`
      .cred-scrim {
        position: fixed; inset: 0; z-index: 121;
        display: grid; place-items: center;
        padding: 24px;
        background: radial-gradient(120% 120% at 50% 30%, rgba(4,8,20,0.62), rgba(2,4,12,0.86));
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      }
      .cred-card {
        --c-accent: #3b6cff; --c-bg: rgba(6,10,22,0.86);
        width: min(460px, calc(100vw - 48px));
        padding: 20px 22px 18px;
        color: var(--text, #eaf2ff);
        border: 1px solid color-mix(in srgb, var(--c-accent) 30%, rgba(255,255,255,0.10));
        border-radius: 20px;
        background: linear-gradient(168deg, color-mix(in srgb, var(--c-accent) 8%, var(--c-bg)), var(--c-bg) 64%);
        -webkit-backdrop-filter: blur(26px) saturate(1.25); backdrop-filter: blur(26px) saturate(1.25);
        box-shadow: 0 40px 100px -34px rgba(0,0,0,0.92),
                    0 0 56px -20px color-mix(in srgb, var(--c-accent) 60%, transparent),
                    inset 0 1px 0 rgba(255,255,255,0.06);
      }
      .cred-head { display: flex; align-items: center; gap: 11px; margin-bottom: 12px; }
      .cred-sigil { display: inline-flex; gap: 3px; align-items: flex-end; height: 18px; }
      .cred-sigil i {
        width: 3px; border-radius: 2px; background: var(--c-accent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--c-accent) 80%, transparent);
        animation: cred-pulse 1.2s ease-in-out infinite;
      }
      .cred-sigil i:nth-child(1) { height: 8px; animation-delay: 0s; }
      .cred-sigil i:nth-child(2) { height: 16px; animation-delay: 0.15s; }
      .cred-sigil i:nth-child(3) { height: 11px; animation-delay: 0.3s; }
      @keyframes cred-pulse { 0%,100% { opacity: 0.55; transform: scaleY(0.8); } 50% { opacity: 1; transform: scaleY(1); } }
      .cred-titles { display: flex; flex-direction: column; line-height: 1.2; margin-right: auto; }
      .cred-kicker { font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(220,232,255,0.5); }
      .cred-title { font-size: 16px; font-weight: 650; }
      .cred-badge {
        font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
        padding: 4px 8px; border-radius: 999px; color: #0a0f1e; font-weight: 700;
        background: color-mix(in srgb, var(--c-accent) 82%, white);
      }
      .cred-summary { margin: 0 0 14px; font-size: 13px; line-height: 1.5; color: rgba(234,242,255,0.9); }
      .cred-input {
        width: 100%; box-sizing: border-box; margin: 0 0 16px;
        padding: 11px 13px; border-radius: 11px;
        font-size: 14px; font-family: inherit; letter-spacing: 0.02em;
        color: #eaf2ff; background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.14);
        outline: none; transition: border-color 0.15s ease, background 0.15s ease;
      }
      .cred-input:focus {
        border-color: color-mix(in srgb, var(--c-accent) 65%, transparent);
        background: rgba(255,255,255,0.07);
      }
      .cred-actions { display: flex; gap: 10px; }
      .cred-btn {
        flex: 1; padding: 11px 14px; border-radius: 12px; cursor: pointer;
        font-size: 13.5px; font-weight: 600; letter-spacing: 0.01em; font-family: inherit;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);
        color: #eaf2ff; transition: transform 0.12s ease, background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      }
      .cred-btn:hover { transform: translateY(-1px); }
      .cred-btn:active { transform: translateY(0); }
      .cred-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
      .cred-btn kbd {
        font: inherit; font-size: 10.5px; padding: 1px 6px; border-radius: 6px;
        background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.12); color: rgba(234,242,255,0.7);
      }
      .cred-cancel:hover { border-color: color-mix(in srgb, #ff5c47 55%, transparent); background: color-mix(in srgb, #ff5c47 14%, rgba(255,255,255,0.05)); }
      .cred-save {
        color: #050a16; font-weight: 700; border: none;
        background: linear-gradient(180deg, color-mix(in srgb, var(--c-accent) 92%, white), var(--c-accent));
        box-shadow: 0 10px 26px -12px color-mix(in srgb, var(--c-accent) 80%, transparent);
      }
      .cred-save kbd { background: rgba(0,0,0,0.16); color: rgba(5,10,22,0.7); border-color: rgba(5,10,22,0.18); }
      @media (prefers-reduced-motion: reduce) {
        .cred-sigil i { animation: none; }
      }
    `}</style>
  );
}
