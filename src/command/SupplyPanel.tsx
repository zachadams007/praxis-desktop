/**
 * SupplyPanel - the spend/quota picture, RELATIVE to each rail's limit (right column, top). Bar
 * color is functional: emerald holds, pink nears (≥70%), ruby is gone (≥90%). "est."
 * denominators are observed bands, marked in the note - a guess is never presented as a bill.
 */

import { useEffect, useRef, useState } from "react";
import { C, FONT, panelHead, headTick, headLabel, headCaption, barTier } from "./ccTheme";
import { fmtAgo, type UsageSource, type PlanUsage } from "./controlStore";
import { VoiceUsageRail } from "./VoiceUsageRail";
import type { VoiceUsageState } from "./voiceUsageStore";
import type { CursorPoolState } from "./cursorPoolStore";
import { OpenAiBillingRail, useOpenAiBilling } from "./OpenAiBillingRail";

interface BarSpec {
  label: string;
  pct: number; // 0..100
  valueText: string;
  includeInTightest?: boolean;
  mutedNote?: string;
}

/** Per-rail freshness stamp - honest "when was this fetched" (2026-07-10 Codex live
 *  QA #14). `stale` = carried-over (last live refresh failed); `cached` = hydrated
 *  from the on-disk snapshot, awaiting the first live pull; `live` = fetched this
 *  session (with the real fetch time when known, else the bare word "live"). */
interface Freshness {
  text: string;
  tone: "live" | "stale" | "cached" | "degraded";
  /** Full explanation for the hover title, when the short text is a summary. */
  title?: string;
}

/** A rail stamp has room for a few words, so summarise the backend's sentence -
 *  but keep the distinctions that matter. Never the bare word "degraded": that is
 *  what six identical captions looked like. */
function shortDegraded(reason?: string): string {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("realtime")) return "voice turn unmetered";
  if (r.includes("unparseable")) return "ledger lines lost";
  if (r.includes("consistency check")) return "spend journal mismatch";
  if (r.includes("lock is poisoned")) return "ledger lock stuck";
  if (r.includes("unreadable") || r.includes("not valid json")) return "ledger unreadable";
  if (r.includes("could not be written") || r.includes("failed")) return "ledger write failed";
  return "ledger degraded";
}

/** Local wall-clock "7:19 PM" for a Unix-ms instant - the rail states WHEN a refusal
 *  was observed, so the claim ages honestly instead of implying a present balance. */
const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

interface RailSpec {
  name: string;
  note: string;
  bars: BarSpec[];
  emptyText?: string;
  freshness?: Freshness;
  includeInTightest?: boolean;
}

const pulseStyle = { animation: "pxPulse 1.8s ease-in-out infinite" };

function planBar(label: string, p: PlanUsage, valueText?: string): BarSpec {
  const pct = p.limit > 0 ? Math.min(100, (p.used / p.limit) * 100) : 0;
  return { label, pct, valueText: valueText ?? `${Math.round(pct)}%` };
}

function fmtReset(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return ` · resets ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/** Short clock stamp ("4:37p") for the "as of" staleness note. */
function fmtClock(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
}

/** Reload feedback clock: "4:12:05P" (seconds + capital meridian). */
export function fmtReloadClock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const ap = h >= 12 ? "P" : "A";
  h = h % 12 || 12;
  return `${h}:${m}:${s}${ap}`;
}

/**
 * RELOAD → clear backend caches → refresh the usage store.
 * Exported so the node test can assert order without mounting React.
 */
export async function reloadSupply(
  refreshLiveState: () => Promise<unknown>,
  refreshUsage: () => Promise<void> | void,
): Promise<void> {
  await refreshLiveState();
  await refreshUsage();
}

/** Honest freshness stamp for one rail, from its own source's real fetch flags.
 *  `lastLiveMs` is the store's last FULLY-live fetch time (useUsage().lastLiveMs),
 *  used for the "as of" clock on a live rail - every rail refreshes together on the
 *  30s poll, so a fresh rail's fetch time is that shared instant. */
function railFreshness(src: UsageSource | undefined, lastLiveMs: number): Freshness | undefined {
  if (!src) return undefined;
  if (src.persistenceDegraded) {
    return {
      text: shortDegraded(src.degradedReason),
      tone: "degraded",
      title: src.degradedReason,
    };
  }
  if (src.stale) {
    const t = fmtClock(src.staleAsOfMs);
    return { text: t ? `as of ${t}` : "stale", tone: "stale" };
  }
  if (src.hydratedFromCache) {
    return { text: src.usageSnapshotMs ? `cached · ${fmtAgo(src.usageSnapshotMs)}` : "cached", tone: "cached" };
  }
  return { text: lastLiveMs ? `as of ${fmtClock(lastLiveMs)}` : "live", tone: "live" };
}

function liveForTightest(src: UsageSource | undefined): boolean {
  return !!src && !src.stale && !src.hydratedFromCache && !src.refreshing && !src.persistenceDegraded;
}

function accountSuffix(plan: PlanUsage[]): string {
  const acct = plan.find((p) => p.account)?.account;
  return acct ? ` · ${acct}` : "";
}

/** Map the real usage sources onto the design's rail blocks. Rails with no data
 *  simply don't render a bar - nothing is fabricated. */
export function buildRails(
  sources: UsageSource[],
  lastLiveMs = 0,
  cursorPool: CursorPoolState | null = null,
): { rails: RailSpec[]; tightest: { name: string; pct: number } | null; alerts: string[] } {
  const by = new Map(sources.map((s) => [s.key, s]));
  const rails: RailSpec[] = [];

  // Window bars (Claude, Codex).
  const windowLabel = (p: PlanUsage) => (p.window === "weekly" ? "WEEKLY" : "5H WINDOW");
  const msgBar = (p: PlanUsage): BarSpec =>
    p.unit === "percent"
      ? planBar(windowLabel(p), p, `${Math.round(p.used)}%`)
      : planBar(windowLabel(p), p, `${Math.round(p.used)}/${Math.round(p.limit)}`);

  const basisNote = (plan: PlanUsage[], realText: string): string => {
    const owner = plan.find((p) => p.owner)?.owner;
    const suffix = owner ? ` · ${owner}` : "";
    if (plan.length === 0) return "no live meter yet";
    if (plan.every((p) => p.basis === "real")) return `${realText} · real${suffix}`;
    if (plan.some((p) => p.basis === "estimated")) return `${realText} · est. caps${suffix}`;
    return `${realText} · learned caps${suffix}`;
  };

  const claude = by.get("claude");
  const claudePlanAll = claude?.plan ?? [];
  const claudeAuth = claudePlanAll.find((p) => p.window === "auth");
  // Live 2026-10-04 this showed as a quiet "est. caps" estimate that RELOAD could never turn
  // real. The rail now says what is wrong; the bars after it are the best figure left (a recent
  // real reading, else the local estimate - labelled as such).
  const claudeRefused = claudePlanAll.find((p) => p.window === "refused");
  // Anthropic rate-limited the meter (429 + Retry-After): it resumes on its own at resetsAt.
  const claudePaused = claudePlanAll.find((p) => p.window === "paused");
  const claudePlan = claudePlanAll.filter((p) => p.window !== "auth" && p.window !== "refused" && p.window !== "paused");
  const estBars = claudePlan.length ? (claudePlan.every((p) => p.basis === "real") ? "last real bars" : "est. bars") : "";
  const claudeName = claude?.label ?? "Claude";
  const claudeInactive = /expired|inactive/i.test(claudeName);
  const claudeLocked = claudePlan
    .map((p) => {
      const m = /locked:\s*(.+)$/i.exec(p.label);
      return m?.[1]?.trim();
    })
    .find(Boolean);
  const refusedSince = claudeRefused?.since ? fmtClock(Date.parse(claudeRefused.since)) : null;
  rails.push({
    name: claudeName,
    note: claudeAuth
      ? claudeAuth.label
      : claudeRefused
        ? `Anthropic: refused${estBars ? ` · ${estBars}` : ""}${refusedSince ? ` · since ${refusedSince}` : ""} · Forge benched`
      : claudePaused
        ? `live meter paused by Anthropic${claudePaused.resetsAt ? ` until ${fmtClock(Date.parse(claudePaused.resetsAt))}` : ""}${estBars ? ` · ${estBars}` : ""}`
      : claudePlan.length
        ? `${basisNote(claudePlan, "live use")}${claudeLocked ? ` · locked: ${claudeLocked}` : ""}${accountSuffix(claudePlan)}`
        : claudeInactive
          ? "plan inactive · no quota meter"
          : "no local quota meter",
    bars: claudeAuth ? [] : claudePlan.map(msgBar),
    emptyText: claudeAuth ? "SIGN-IN" : claudeRefused ? "REFUSED" : claudeInactive ? "INACTIVE" : "NO METER",
    freshness: claudeRefused
      ? { text: "refused", tone: "degraded", title: claudeRefused.label }
      : claudePaused
        ? { text: "paused", tone: "stale", title: "Anthropic rate-limited its usage meter; Praxis waits out the pause it asked for instead of retrying into it" }
        : railFreshness(claude, lastLiveMs),
    includeInTightest: !claudeAuth && !claudeRefused && !claudePaused && liveForTightest(claude),
  });
  // A rail that cannot be used at all outranks "how full is the fullest" in the header.
  const alerts: string[] = claudeRefused ? ["CLAUDE REFUSED"] : claudeAuth ? ["CLAUDE SIGN-IN"] : [];

  const codex = by.get("codex");
  const codexPlan = codex?.plan ?? [];
  const codexLimit = codexPlan.find((p) => /limit reached|exhaust/i.test(p.label));
  rails.push({
    name: "CODEX",
    note: codexLimit
      ? codexLimit.label.replace(/^Codex · /, "")
      : basisNote(codexPlan, "5h + weekly"),
    bars: codexPlan.map(msgBar),
    emptyText: "NO METER",
    freshness: railFreshness(codex, lastLiveMs),
    includeInTightest: liveForTightest(codex),
  });

  // Cursor: TOTAL + API from live percents (never the saturated 2000/2000 counter).
  // Labels arrive as "Cursor · pro · TOTAL" so the note can show membership.
  const cursor = by.get("cursor");
  const cursorPlan = cursor?.plan ?? [];
  const cursorBarLabel = (p: PlanUsage): string => {
    const tail = p.label.replace(/^Cursor · /i, "");
    const parts = tail.split(" · ");
    return (parts[parts.length - 1] || "QUOTA").toUpperCase();
  };
  const cursorMembership = (() => {
    const first = cursorPlan[0];
    if (!first) return "";
    const tail = first.label.replace(/^Cursor · /i, "");
    const parts = tail.split(" · ");
    return parts.length >= 2 ? parts.slice(0, -1).join(" · ") : "";
  })();
  const cursorNote = (() => {
    if (!cursorPlan.length) return "live meter unavailable · open dashboard";
    const reset = fmtReset(cursorPlan[0]?.resetsAt);
    const fallback = cursorPlan.some((p) => /fallback/i.test(p.label)) ? " · used/limit fallback" : "";
    const membership = cursorMembership || "cursor";
    return `${membership}${reset}${fallback}${accountSuffix(cursorPlan)}`;
  })();
  rails.push({
    name: "CURSOR",
    note: cursorNote,
    freshness: railFreshness(cursor, lastLiveMs),
    emptyText: "NO METER",
    includeInTightest: liveForTightest(cursor),
    bars: cursorPlan.map((p) => {
      const label = cursorBarLabel(p);
      const apiIsEffective = cursorPool?.api_pool_allowed === true;
      if (p.unit === "percent") {
        const bar = planBar(label, p, `${Math.round(p.used)}%`);
        if (apiIsEffective && label === "CURSOR MODELS" && cursorPool.exhausted) {
          const reset = cursorPool.resets_at_ms
            ? new Date(cursorPool.resets_at_ms).toLocaleDateString([], { month: "short", day: "numeric" })
            : "the next reset";
          return {
            ...bar,
            label: "OWN MODELS",
            mutedNote: `used up until ${reset} · Quill on API pool`,
            includeInTightest: false,
          };
        }
        return {
          ...bar,
          includeInTightest: !apiIsEffective || label === "API",
        };
      }
      return {
        ...planBar(label, p, `${Math.round(p.used)}/${Math.round(p.limit)}`),
        includeInTightest: !apiIsEffective,
      };
    }),
  });

  const nvidia = by.get("nvidia");
  const nvRate = (nvidia?.plan ?? []).find((p) => p.window === "rpm");
  rails.push({
    name: "NVIDIA NIM",
    note: "free tier · finite pool, 40 req/min",
    bars: nvRate ? [planBar("RATE", nvRate)] : [],
    emptyText: "NO RATE",
    freshness: railFreshness(nvidia, lastLiveMs),
    includeInTightest: liveForTightest(nvidia),
  });

  const or = by.get("openrouter");
  if (or) {
    if (or.limit != null && or.limit > 0) {
      const pct = Math.min(100, (or.spend / or.limit) * 100);
      rails.push({
        name: "OPENROUTER",
        note: `prepaid · $${Math.max(0, or.limit - or.spend).toFixed(2)} left of $${or.limit.toFixed(2)}`,
        bars: [{ label: "SPENT", pct, valueText: `$${or.spend.toFixed(2)}` }],
        freshness: railFreshness(or, lastLiveMs),
        includeInTightest: liveForTightest(or),
      });
    } else {
      rails.push({
        name: "OPENROUTER",
        note: "live spend · no cap set on this key",
        bars: [{ label: "SPENT", pct: 0, valueText: `$${or.spend.toFixed(2)}` }],
        freshness: railFreshness(or, lastLiveMs),
        includeInTightest: liveForTightest(or),
      });
    }
  }

  // OPENAI API - the one rail with no readable ceiling.
  //
  // It was easy to read as an account balance, but it was arithmetic on
  // two numbers OpenAI never sent, and it read the same whether the account was full or refusing
  // every call.
  const oa = by.get("openai");
  if (oa) {
    rails.push(
      oa.noCreditSinceMs
        ? {
            name: "OPENAI API",
            // Anchored to the moment of the refusal, so it stays true as it ages
            // and never implies a balance in either direction.
            note: `NO CREDIT since ${clockTime(oa.noCreditSinceMs)} · voice on ElevenLabs`,
            // No progress bar. A bar needs a maximum, and there isn't one to know.
            bars: [],
            emptyText: "CALLS REFUSED",
            freshness: railFreshness(oa, lastLiveMs),
            includeInTightest: liveForTightest(oa),
          }
        : {
            name: "OPENAI API",
            // "not a balance" leads, because it is the one clause that must survive
            // being ellipsized - it is the whole correction.
            note: "own ledger, not a balance · brain, QA + realtime",
            bars: [{ label: "SPENT", pct: 0, valueText: `$${oa.spend.toFixed(2)}` }],
            freshness: railFreshness(oa, lastLiveMs),
            includeInTightest: liveForTightest(oa),
          },
    );
  }

  const watch: { name: string; pct: number }[] = [];
  const shortName = (name: string): string => {
    if (name.includes("Claude Max")) return "MAX";
    if (name.startsWith("Claude")) return "CLAUDE";
    return ({ CODEX: "CDX", CURSOR: "CURSOR", "NVIDIA NIM": "NVIDIA", OPENROUTER: "OR", "OPENAI VOICE": "VOICE" } as Record<string, string>)[name] ?? name;
  };
  for (const rail of rails) {
    if (rail.includeInTightest === false) continue;
    for (const b of rail.bars) {
      if (b.includeInTightest === false) continue;
      const tag = b.label === "WEEKLY" ? "·WK" : b.label === "5H WINDOW" ? "·5H" : "";
      watch.push({ name: `${shortName(rail.name)}${tag}`, pct: b.pct });
    }
  }
  const tightest = watch.length ? watch.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;

  return { rails, tightest, alerts };
}

const freshTone = (t: Freshness["tone"]): string =>
  t === "stale" || t === "degraded" ? "rgba(233,180,120,.72)" : "rgba(233,226,211,.34)";

// Same bordered, hover-lit treatment as the rail's BRAIN / GALAXY / DECK buttons: a
// borderless caption-styled RELOAD read as a label, not as something you can press.
const reloadBtnStyle: React.CSSProperties = {
  ...headCaption,
  fontFamily: FONT.mono,
  fontStyle: "normal",
  fontSize: 8.5,
  letterSpacing: ".16em",
  background: "transparent",
  border: "1px solid rgba(233,220,196,.14)",
  padding: "3px 8px",
  margin: "0 0 0 4px",
  cursor: "pointer",
  color: "rgba(233,226,211,.6)",
  flex: "none",
  lineHeight: 1.2,
};

export function SupplyPanel({
  sources,
  voiceUsage,
  cursorPool,
  lastLiveMs = 0,
  onReload,
}: {
  sources: UsageSource[];
  voiceUsage: VoiceUsageState;
  cursorPool: CursorPoolState | null;
  lastLiveMs?: number;
  /** Clears backend caches then refreshes the usage store (threaded from App). */
  onReload?: () => Promise<void> | void;
}) {
  const { rails } = buildRails(sources, lastLiveMs, cursorPool);
  const openAiLedger = sources.find((source) => source.key === "openai");
  const {
    state: openAiBilling,
    signIn: signInToOpenAi,
    refreshIfEverOk: refreshOpenAiBilling,
  } = useOpenAiBilling();
  const cacheRefreshing = sources.some((source) => source.hydratedFromCache && source.refreshing);
  const degradedRows = sources.filter((source) => source.persistenceDegraded);
  const persistenceDegraded = degradedRows.length > 0;
  const degradedLabels = degradedRows.map((source) => source.key.toUpperCase()).join(", ");
  const degradedReason = degradedRows.find((source) => source.degradedReason)?.degradedReason;
  const staleAsOf = sources.find((source) => source.stale)?.staleAsOfMs;

  const [reloadPhase, setReloadPhase] = useState<"idle" | "loading" | "done">("idle");
  const [reloadAsOf, setReloadAsOf] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (doneTimer.current) clearTimeout(doneTimer.current);
  }, []);

  const handleReload = async () => {
    if (reloadPhase === "loading") return;
    setReloadPhase("loading");
    setReloadError(null);
    setReloadAsOf(null);
    refreshOpenAiBilling();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await reloadSupply(
        () => invoke("refresh_live_state"),
        () => onReload?.() ?? Promise.resolve(),
      );
      const stamp = fmtReloadClock(Date.now());
      setReloadAsOf(`as of ${stamp}`);
      setReloadPhase("done");
      if (doneTimer.current) clearTimeout(doneTimer.current);
      doneTimer.current = setTimeout(() => {
        setReloadPhase("idle");
        setReloadAsOf(null);
      }, 4000);
    } catch {
      setReloadPhase("idle");
      setReloadError("reload failed");
    }
  };

  const headerCaption = (() => {
    if (reloadError) {
      return (
        <span style={{ ...headCaption, color: "rgba(233,180,120,.85)" }}>{reloadError}</span>
      );
    }
    if (reloadPhase === "done" && reloadAsOf) {
      return <span style={{ ...headCaption, color: "rgba(233,226,211,.55)" }}>{reloadAsOf}</span>;
    }
    if (persistenceDegraded) {
      return (
        <span
          style={{ ...headCaption, color: "rgba(233,180,120,.72)" }}
          title={
            degradedReason
              ? `${degradedReason} — affects ${degradedLabels}; those rails stay visible but are excluded from tightest-rail decisions`
              : `affects ${degradedLabels}`
          }
        >
          {degradedLabels} · {shortDegraded(degradedReason)}
        </span>
      );
    }
    if (staleAsOf) {
      return (
        <span style={{ ...headCaption, color: "rgba(233,180,120,.72)" }} title="live refresh failed — showing last good data">
          as of {fmtClock(staleAsOf)}
        </span>
      );
    }
    return <span style={headCaption}>green holds · pink nears · red is gone</span>;
  })();

  return (
    <div style={{ flex: "none", background: C.panel }}>
      <div style={panelHead}>
        <span style={{ ...headTick(staleAsOf || persistenceDegraded || reloadError ? "rgba(233,180,120,.7)" : "rgba(233,220,196,.5)"), ...(cacheRefreshing || reloadPhase === "loading" ? pulseStyle : {}) }} />
        <span style={headLabel}>SUPPLY</span>
        <button
          type="button"
          className="px-hover-border"
          onClick={() => void handleReload()}
          disabled={reloadPhase === "loading"}
          aria-label="Reload supply meters"
          title="re-measure every rail now"
          style={{
            ...reloadBtnStyle,
            opacity: reloadPhase === "loading" ? 0.55 : 1,
            cursor: reloadPhase === "loading" ? "wait" : "pointer",
            outline: "none",
          }}
          onFocus={(e) => {
            e.currentTarget.style.boxShadow = "0 0 0 1px rgba(73,160,244,.7)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          {reloadPhase === "loading" ? "RELOADING…" : "RELOAD"}
        </button>
        <span style={{ flex: 1 }} />
        {headerCaption}
      </div>
      {rails.filter((g) => g.name !== "OPENAI API").map((g) => (
        <div key={g.name} style={{ padding: "7px 14px 8px", borderBottom: "1px solid rgba(233,220,196,.05)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".16em", flex: "none" }}>{g.name}</span>
            <span
              style={{
                fontSize: 9,
                color: "rgba(233,226,211,.38)",
                flex: 1,
                minWidth: 0,
                textAlign: "right",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span title={g.note}>{g.note}</span>
            </span>
            {g.freshness && (
              <span
                title={g.freshness.title ?? "when this rail was last fetched"}
                style={{ flex: "none", fontSize: 8.5, letterSpacing: ".02em", color: freshTone(g.freshness.tone), whiteSpace: "nowrap" }}
              >
                {g.freshness.text}
              </span>
            )}
          </div>
          {g.bars.length === 0 && (
            <div
              aria-label={`${g.name} ${g.emptyText ? "meter unavailable" : "meter loading"}`}
              style={{ display: "grid", gridTemplateColumns: "72px 1fr 46px", gap: 9, alignItems: "center", padding: "2px 0", opacity: 0.62 }}
            >
              <span style={{ ...(g.emptyText ? {} : pulseStyle), fontSize: 9, letterSpacing: ".1em", color: "rgba(233,226,211,.36)" }}>
                {g.emptyText ?? "SYNC"}
              </span>
              <span style={{ display: "block", height: 3, background: "rgba(233,220,196,.08)", position: "relative", overflow: "hidden" }}>
                {!g.emptyText && (
                  <span
                    style={{
                      ...pulseStyle,
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: "38%",
                      background: "rgba(233,220,196,.22)",
                    }}
                  />
                )}
              </span>
              <span style={{ ...(g.emptyText ? {} : pulseStyle), fontSize: 10.5, textAlign: "right", color: "rgba(233,226,211,.32)" }}>
                {g.emptyText ? "-" : "..."}
              </span>
            </div>
          )}
          {g.bars.map((b) => {
            const tier = barTier(b.pct);
            if (b.mutedNote) {
              return (
                <div key={b.label} title={`${b.label.toLowerCase()} · ${b.mutedNote}`} style={{ display: "grid", gridTemplateColumns: "72px minmax(0, 1fr) 46px", gap: 9, alignItems: "center", padding: "2px 0" }}>
                  <span style={{ fontSize: 9, letterSpacing: ".1em", color: C.dim }}>{b.label}</span>
                  <span style={{ fontSize: 9, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.mutedNote}</span>
                  <span style={{ fontSize: 10.5, textAlign: "right", color: C.dim }}>{b.valueText}</span>
                </div>
              );
            }
            return (
              <div key={b.label} style={{ display: "grid", gridTemplateColumns: "72px 1fr 46px", gap: 9, alignItems: "center", padding: "2px 0" }}>
                <span style={{ fontSize: 9, letterSpacing: ".1em", color: "rgba(233,226,211,.45)" }}>{b.label}</span>
                <span style={{ display: "block", height: 3, background: "rgba(233,220,196,.1)", position: "relative" }}>
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${Math.min(100, b.pct).toFixed(1)}%`,
                      background: tier.color,
                      boxShadow: tier.glow,
                    }}
                  />
                </span>
                <span style={{ fontSize: 10.5, textAlign: "right", color: tier.color }}>{b.valueText}</span>
              </div>
            );
          })}
        </div>
      ))}
      {openAiLedger && (
        <OpenAiBillingRail
          billing={openAiBilling}
          ledger={openAiLedger}
          onSignIn={signInToOpenAi}
        />
      )}
      <VoiceUsageRail state={voiceUsage} />
    </div>
  );
}
