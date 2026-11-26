import { C, FONT } from "./ccTheme";
import type {
  VoiceBackendUsage,
  VoiceUsageSnapshot,
  VoiceUsageState,
} from "./voiceUsageStore";

export function formatVoiceCost(snapshot: VoiceUsageSnapshot | null): string {
  if (
    snapshot?.cost_basis === "provider_reported" &&
    snapshot.cost_usd != null &&
    Number.isFinite(snapshot.cost_usd)
  ) {
    return `$${snapshot.cost_usd.toFixed(2)}`;
  }
  return "UNKNOWN";
}

/**
 * The provider's own meter, as ElevenLabs states it.
 *
 * Deliberately characters, not dollars: the plan is a flat monthly fee, so any
 * per-call dollar figure would be invented. Characters against the plan limit is
 * the real quantity, and the one that runs out.
 */
export function formatVoiceQuota(snapshot: VoiceUsageSnapshot | null): string | null {
  const q = snapshot?.provider_quota;
  if (!q || !Number.isFinite(q.character_limit) || q.character_limit <= 0) return null;
  const pct = Math.min(100, Math.round((q.character_count / q.character_limit) * 100));
  return `${q.character_count.toLocaleString()}/${q.character_limit.toLocaleString()} chars · ${pct}%`;
}

export function voiceQuotaTier(snapshot: VoiceUsageSnapshot | null): string | null {
  const q = snapshot?.provider_quota;
  return q ? q.tier : null;
}

export function voiceBackendRows(snapshot: VoiceUsageSnapshot | null): VoiceBackendUsage[] {
  if (!snapshot) return [];
  return snapshot.backends
    .filter((backend) => backend.attempts > 0 || backend.fallback_departures > 0)
    .sort((a, b) => b.last_event_ms - a.last_event_ms)
    .slice(0, 3);
}

export function voiceUsageSummary(snapshot: VoiceUsageSnapshot): string {
  const recent = snapshot.backends.reduce(
    (total, row) => ({
      attempts: total.attempts + (row.recent?.attempts ?? 0),
      successes: total.successes + (row.recent?.successes ?? 0),
      failures: total.failures + (row.recent?.failures ?? 0),
    }),
    { attempts: 0, successes: 0, failures: 0 },
  );
  return `${recent.attempts} provider ${recent.attempts === 1 ? "attempt" : "attempts"} today · ${recent.successes} ok · ${recent.failures} fail`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function outcomeText(row: VoiceBackendUsage): string {
  const recent = row.recent ?? { attempts: 0, successes: 0, failures: 0, fallback_departures: 0 };
  const parts = [`${recent.attempts} att`, `${recent.successes} ok`];
  if (recent.failures > 0) {
    parts.push(`${recent.failures} fail today`);
  } else if (row.failures > 0) {
    const when = row.last_failure_ms ? shortDate(row.last_failure_ms) : "before reason tracking";
    parts.push(`0 fail today · last fail ${when} (${row.last_failure_reason ?? "reason not recorded"})`);
  } else {
    parts.push("0 fail today");
  }
  if (recent.fallback_departures > 0) parts.push(`${recent.fallback_departures} fallback out today`);
  return parts.join(" · ");
}

function outcomeColor(row: VoiceBackendUsage): string {
  if ((row.recent?.failures ?? 0) > 0) return C.ruby;
  if ((row.recent?.fallback_departures ?? 0) > 0) return C.pink;
  if (row.failures > 0) return C.dim;
  return C.emerald;
}

function lifetimeOutcome(row: VoiceBackendUsage): string {
  const reason = row.last_failure_reason ?? "reason not recorded";
  const lastFailure = row.last_failure_ms ? `; last failure ${shortDate(row.last_failure_ms)} (${reason})` : "";
  return `Lifetime: ${row.attempts} attempts, ${row.successes} successful, ${row.failures} failed, ${row.fallback_departures} fallback departures, ${row.characters_sent} characters sent${lastFailure}`;
}

const blockStyle: React.CSSProperties = {
  padding: "8px 14px 9px",
  borderBottom: `1px solid ${C.faint}`,
  background: C.panel,
};

const metaStyle: React.CSSProperties = {
  fontFamily: FONT.mono,
  fontSize: 9,
  lineHeight: 1.45,
  letterSpacing: ".02em",
  color: C.dim,
  fontVariantNumeric: "tabular-nums",
};

function Retry({ state }: { state: VoiceUsageState }) {
  return (
    <button
      type="button"
      className="px-voice-retry px-hover-border"
      onClick={state.refresh}
      disabled={state.refreshing}
      style={{
        border: `1px solid ${C.faint}`,
        background: C.inset,
        color: C.ink,
        padding: "4px 7px",
        fontFamily: FONT.mono,
        fontSize: 8.5,
        letterSpacing: ".1em",
        cursor: state.refreshing ? "default" : "pointer",
        opacity: state.refreshing ? 0.55 : 1,
      }}
    >
      {state.refreshing ? "SYNCING" : "RETRY"}
    </button>
  );
}

export function VoiceUsageRail({ state }: { state: VoiceUsageState }) {
  const snapshot = state.snapshot;
  const rows = voiceBackendRows(snapshot);
  const announce = state.phase === "loading" || state.phase === "unavailable" || state.phase === "error";
  const cost = formatVoiceCost(snapshot);
  const quota = formatVoiceQuota(snapshot);
  const tier = voiceQuotaTier(snapshot);

  return (
    <section
      aria-label="Voice backend usage"
      aria-busy={state.refreshing && !snapshot}
      aria-live={announce ? "polite" : "off"}
      style={blockStyle}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".16em", color: C.ink }}>
          VOICE BACKENDS
        </span>
        <span style={{ ...metaStyle, flex: 1, textAlign: "right" }}>
          {quota
            ? `elevenlabs ${tier ?? ""}`.trim()
            : `local privacy-safe ledger${snapshot?.cost_basis === "provider_reported" ? "" : " · quota unreachable"}`}
        </span>
        {quota ? (
          // The provider's own number. Not a dollar figure, because the plan is a
          // flat fee - characters are what actually run out.
          <span title="Characters used against the ElevenLabs plan limit, as ElevenLabs reports them" style={{ ...metaStyle, color: C.ink }}>
            {quota}
          </span>
        ) : (
          <span
            title="ElevenLabs could not be reached, so nothing is claimed about the quota"
            style={{ ...metaStyle, color: snapshot?.cost_basis === "provider_reported" ? C.ink : C.pink }}
          >
            COST {cost}
          </span>
        )}
      </div>

      {state.phase === "loading" && !snapshot && (
        <div className="px-voice-loading" style={{ ...metaStyle, color: C.sapphireLt, minHeight: 34, display: "flex", alignItems: "center" }}>
          SYNCING LOCAL VOICE LEDGER
        </div>
      )}

      {(state.phase === "unavailable" || (state.phase === "error" && !snapshot)) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 34 }}>
          <div style={{ flex: 1 }}>
            <div style={{ ...metaStyle, color: C.ruby, fontWeight: 600 }}>VOICE METER UNAVAILABLE</div>
            <div style={metaStyle}>Local ledger could not be read. No provider was queried.</div>
          </div>
          <Retry state={state} />
        </div>
      )}

      {snapshot && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: rows.length ? 7 : 0 }}>
            <span
              title={`${snapshot.logical_requests} lifetime requests · ${snapshot.provider_attempts} lifetime provider attempts · ${snapshot.logical_characters.toLocaleString()} lifetime chars`}
              style={{ ...metaStyle, flex: 1, color: C.ink }}
            >
              {voiceUsageSummary(snapshot)}
            </span>
            {state.phase === "error" ? (
              <span style={{ ...metaStyle, color: C.ruby }}>as of {clock(state.lastLiveMs)} · refresh failed</span>
            ) : snapshot.last_event_ms ? (
              <span style={metaStyle}>last event {clock(snapshot.last_event_ms)}</span>
            ) : null}
            {(state.phase === "error" || state.degraded) && <Retry state={state} />}
          </div>

          {state.phase === "empty" && (
            <div style={{ ...metaStyle, minHeight: 28, display: "flex", alignItems: "center" }}>
              NO CLOUD VOICE REQUESTS YET
            </div>
          )}

          {state.degraded && (
            <div role="status" style={{ ...metaStyle, color: C.pink, marginBottom: 6 }}>
              LEDGER DEGRADED
              {snapshot.malformed_lines > 0
                ? ` · ${snapshot.malformed_lines} malformed ${snapshot.malformed_lines === 1 ? "line" : "lines"} ignored`
                : ""}
              {snapshot.write_failures > 0
                ? ` · ${snapshot.write_failures} ${snapshot.write_failures === 1 ? "write failure" : "write failures"}`
                : ""}
              {snapshot.maintenance_failures > 0
                ? ` · ${snapshot.maintenance_failures} ${snapshot.maintenance_failures === 1 ? "maintenance issue" : "maintenance issues"}`
                : ""}
            </div>
          )}

          {snapshot.pending_attempts > 0 && (
            <div role="status" style={{ ...metaStyle, color: C.pink, marginBottom: 6 }}>
              {snapshot.pending_attempts} PROVIDER {snapshot.pending_attempts === 1 ? "ATTEMPT HAS" : "ATTEMPTS HAVE"} NO RECORDED RESULT
            </div>
          )}

          {rows.map((row) => {
            const fullLabel = `${row.backend}, model ${row.model}: ${outcomeText(row)}. ${lifetimeOutcome(row)}`;
            return (
              <div
                key={`${row.backend}:${row.model}`}
                aria-label={fullLabel}
                title={fullLabel}
                style={{
                  display: "grid",
                  gridTemplateColumns: "86px minmax(0, 1fr) auto",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "3px 0",
                  borderTop: `1px solid ${C.faint}`,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span style={{ ...metaStyle, color: C.ink, fontWeight: 600 }}>{row.backend.toUpperCase()}</span>
                <span style={{ ...metaStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.model}</span>
                <span style={{ ...metaStyle, color: outcomeColor(row), whiteSpace: "nowrap" }}>{outcomeText(row)}</span>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
