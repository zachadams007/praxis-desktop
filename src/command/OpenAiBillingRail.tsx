import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageSource } from "./controlStore";
import { C, FONT, barTier } from "./ccTheme";

type BillingStatus = "ok" | "signed_out" | "never" | "error" | "reading";

export interface OpenAiBillingState {
  status: BillingStatus;
  balance_usd: number | null;
  granted_usd: number | null;
  used_usd: number | null;
  grants: Array<{
    amount_usd: number | null;
    used_usd: number | null;
    remaining_usd: number | null;
    effective_at: string | null;
    expires_at: string | null;
  }>;
  read_at_ms: number;
  source: string;
  detail: string;
  praxis_spend_at_read_usd: number | null;
}

const EMPTY_BILLING: OpenAiBillingState = {
  status: "never",
  balance_usd: null,
  granted_usd: null,
  used_usd: null,
  grants: [],
  read_at_ms: 0,
  source: "",
  detail: "OpenAI balance has not been read yet",
  praxis_spend_at_read_usd: null,
};

export function useOpenAiBilling() {
  const [state, setState] = useState<OpenAiBillingState>(EMPTY_BILLING);
  const stateRef = useRef(state);

  const accept = useCallback((next: OpenAiBillingState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const fail = useCallback((detail: string) => {
    const next = { ...stateRef.current, status: "error" as const, detail };
    accept(next);
  }, [accept]);

  useEffect(() => {
    let disposed = false;
    let pushed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          import("@tauri-apps/api/core"),
          import("@tauri-apps/api/event"),
        ]);
        unlisten = await listen<OpenAiBillingState>("praxis://openai-billing", (event) => {
          pushed = true;
          if (!disposed) accept(event.payload);
        });
        const initial = await invoke<OpenAiBillingState>("openai_billing_state");
        if (!disposed && !pushed) accept(initial);
      } catch {
        // Browser preview and older installed binaries keep the honest "never" state.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [accept]);

  const signIn = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<void>("openai_billing_sign_in");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not open OpenAI billing sign-in");
    }
  }, [fail]);

  const refreshIfEverOk = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "ok" && current.read_at_ms <= 0) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<OpenAiBillingState>("openai_billing_refresh"))
      .then(accept)
      .catch((error: unknown) => {
        fail(error instanceof Error ? error.message : "Could not refresh OpenAI billing");
      });
  }, [accept, fail]);

  return { state, signIn, refreshIfEverOk };
}

const money = (value: number): string => `$${value.toFixed(2)}`;

const readClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const actionStyle: React.CSSProperties = {
  border: `1px solid color-mix(in srgb, ${C.sapphire} 45%, transparent)`,
  background: `color-mix(in srgb, ${C.sapphire} 8%, transparent)`,
  color: C.sapphireLt,
  fontFamily: FONT.mono,
  fontSize: 8.5,
  letterSpacing: ".12em",
  lineHeight: 1.2,
  padding: "4px 7px",
  cursor: "pointer",
};

export function OpenAiBillingRail({
  billing,
  ledger,
  onSignIn,
}: {
  billing: OpenAiBillingState;
  ledger: UsageSource;
  onSignIn: () => Promise<void>;
}) {
  const left = billing.balance_usd;
  const loaded = billing.granted_usd;
  const derivedUsed =
    billing.used_usd ?? (loaded != null && left != null ? Math.max(0, loaded - left) : null);
  const canScale = loaded != null && loaded > 0 && left != null;
  const usedPct = canScale
    ? Math.min(100, Math.max(0, ((derivedUsed ?? loaded - left) / loaded) * 100))
    : 0;
  const tier = barTier(usedPct);
  const spentSince =
    billing.praxis_spend_at_read_usd == null
      ? null
      : Math.max(0, ledger.spend - billing.praxis_spend_at_read_usd);

  const shellStyle: React.CSSProperties = {
    padding: "8px 14px 9px",
    borderBottom: `1px solid color-mix(in srgb, ${C.ink} 5%, transparent)`,
  };
  const mutedStyle: React.CSSProperties = {
    color: C.faint,
    fontSize: 9,
    lineHeight: 1.45,
  };

  if (billing.status !== "ok" || left == null) {
    const signedOut = billing.status === "signed_out";
    return (
      <div style={shellStyle} aria-live="polite">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".16em" }}>OPENAI API</span>
          <span style={{ ...mutedStyle, flex: 1, textAlign: "right" }}>
            SPENT {money(ledger.spend)} · own ledger
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 6 }}>
          <span
            style={{
              ...mutedStyle,
              ...(billing.status === "reading" ? { animation: "pxPulse 1.8s ease-in-out infinite" } : {}),
              flex: 1,
            }}
          >
            {billing.status === "reading"
              ? "reading balance…"
              : signedOut
                ? "OpenAI signed out · sign in again"
                : billing.status === "error"
                  ? billing.detail || "OpenAI balance read failed"
                  : "Balance has not been read from OpenAI"}
          </span>
          {(billing.status === "never" || signedOut) && (
            <button
              type="button"
              className="px-hover-border"
              style={actionStyle}
              onClick={() => void onSignIn()}
              onFocus={(event) => {
                event.currentTarget.style.boxShadow = `0 0 0 1px ${C.sapphire}`;
              }}
              onBlur={(event) => {
                event.currentTarget.style.boxShadow = "none";
              }}
            >
              SIGN IN TO READ BALANCE
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={shellStyle} aria-live="polite">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".16em" }}>OPENAI API</span>
        <span style={{ flex: 1, textAlign: "right", color: C.dim, fontSize: 10 }}>
          {loaded != null
            ? `${money(left)} left of ${money(loaded)} loaded`
            : `${money(left)} left · loaded amount unavailable`}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "72px 1fr 46px",
          gap: 9,
          alignItems: "center",
          padding: "5px 0 3px",
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: ".1em", color: C.faint }}>USED</span>
        <span
          style={{
            display: "block",
            height: 3,
            background: `color-mix(in srgb, ${C.ink} 10%, transparent)`,
            position: "relative",
          }}
        >
          <span
            style={{
              position: "absolute",
              inset: 0,
              width: `${usedPct.toFixed(1)}%`,
              background: tier.color,
              boxShadow: tier.glow,
            }}
          />
        </span>
        <span style={{ fontSize: 10.5, textAlign: "right", color: tier.color }}>
          {derivedUsed == null ? "—" : money(derivedUsed)}
        </span>
      </div>
      <div style={mutedStyle}>
        {derivedUsed == null ? "used amount unavailable" : `used ${money(derivedUsed)}`}
        {" · "}read from OpenAI {readClock(billing.read_at_ms)}
      </div>
      <div style={{ ...mutedStyle, color: C.dim }}>
        {spentSince == null
          ? "Praxis ledger baseline pending the next OpenAI read"
          : `+ ${money(spentSince)} spent by Praxis since · own ledger`}
      </div>
    </div>
  );
}
