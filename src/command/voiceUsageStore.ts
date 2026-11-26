import { useCallback, useEffect, useRef, useState } from "react";
import { visibleInterval } from "@/shared/visibility";

export interface VoiceBackendUsage {
  backend: string;
  model: string;
  attempts: number;
  successes: number;
  failures: number;
  fallback_departures: number;
  characters_sent: number;
  last_event_ms: number;
  recent: {
    attempts: number;
    successes: number;
    failures: number;
    fallback_departures: number;
  };
  last_failure_ms: number | null;
  last_failure_reason: string | null;
}


export interface ElevenLabsQuota {
  character_count: number;
  character_limit: number;
  tier: string;
  resets_at_unix: number | null;
  fetched_at_ms: number;
}

export interface VoiceUsageSnapshot {
  logical_requests: number;
  provider_attempts: number;
  pending_attempts: number;
  successes: number;
  failures: number;
  fallback_transitions: number;
  logical_characters: number;
  provider_characters: number;
  last_event_ms: number | null;
  cost_usd: number | null;
  cost_basis: "unknown" | "provider_reported";
  /**
   * ElevenLabs' OWN count of characters used against the plan limit, or null when
   * it could not be reached. Null means NOT MEASURED and must never render as a
   * zero bar - "nothing used" and "we did not ask" look identical on a meter and
   * mean opposite things. This rail said "billing not queried" for months while
   * the number sat behind one authenticated GET.
   */
  provider_quota?: ElevenLabsQuota | null;
  ledger_status: "empty" | "ready" | "degraded" | "unavailable";
  malformed_lines: number;
  write_failures: number;
  maintenance_failures: number;
  backends: VoiceBackendUsage[];
}

export type VoiceUsagePhase = "loading" | "empty" | "ready" | "unavailable" | "error";

export interface VoiceUsageState {
  phase: VoiceUsagePhase;
  snapshot: VoiceUsageSnapshot | null;
  refreshing: boolean;
  stale: boolean;
  degraded: boolean;
  lastLiveMs: number;
  refresh: () => void;
}

const REFRESH_MS = 30_000;

export function phaseForVoiceSnapshot(snapshot: VoiceUsageSnapshot): VoiceUsagePhase {
  if (snapshot.ledger_status === "unavailable") return "unavailable";
  return snapshot.logical_requests === 0 && snapshot.provider_attempts === 0 && snapshot.fallback_transitions === 0
    ? "empty"
    : "ready";
}

export function isNewerVoiceSnapshot(
  previous: VoiceUsageSnapshot | null,
  incoming: VoiceUsageSnapshot,
): boolean {
  if (!previous) return true;
  if (voiceSnapshotCountersRegress(previous, incoming)) return false;
  const previousEvent = previous.last_event_ms ?? 0;
  const incomingEvent = incoming.last_event_ms ?? 0;
  if (incomingEvent !== previousEvent) return incomingEvent > previousEvent;

  // Multiple route events can share a millisecond. In that tie, accept only
  // monotonic counters so an older poll can never roll a newer event snapshot back.
  return (
    incoming.logical_requests >= previous.logical_requests &&
    incoming.provider_attempts >= previous.provider_attempts &&
    incoming.successes >= previous.successes &&
    incoming.failures >= previous.failures &&
    incoming.fallback_transitions >= previous.fallback_transitions &&
    incoming.logical_characters >= previous.logical_characters &&
    incoming.provider_characters >= previous.provider_characters
  );
}

export function voiceSnapshotCountersRegress(
  previous: VoiceUsageSnapshot,
  incoming: VoiceUsageSnapshot,
): boolean {
  return (
    incoming.logical_requests < previous.logical_requests ||
    incoming.provider_attempts < previous.provider_attempts ||
    incoming.successes < previous.successes ||
    incoming.failures < previous.failures ||
    incoming.fallback_transitions < previous.fallback_transitions ||
    incoming.logical_characters < previous.logical_characters ||
    incoming.provider_characters < previous.provider_characters
  );
}

function voiceSnapshotUsageMatches(
  previous: VoiceUsageSnapshot,
  incoming: VoiceUsageSnapshot,
): boolean {
  return (
    incoming.last_event_ms === previous.last_event_ms &&
    incoming.logical_requests === previous.logical_requests &&
    incoming.provider_attempts === previous.provider_attempts &&
    incoming.pending_attempts === previous.pending_attempts &&
    incoming.successes === previous.successes &&
    incoming.failures === previous.failures &&
    incoming.fallback_transitions === previous.fallback_transitions &&
    incoming.logical_characters === previous.logical_characters &&
    incoming.provider_characters === previous.provider_characters
  );
}

export type VoiceSnapshotDecision = "accept" | "ignore" | "preserve_degraded";

export function classifyVoiceSnapshot(
  previous: VoiceUsageSnapshot | null,
  incoming: VoiceUsageSnapshot,
): VoiceSnapshotDecision {
  // Ledger health is sticky in the Rust process. With no newer usage position,
  // a healthy snapshot can only be an older poll resolving after a degraded
  // event, so it must not erase that health signal.
  if (
    previous?.ledger_status === "degraded" &&
    incoming.ledger_status !== "degraded" &&
    voiceSnapshotUsageMatches(previous, incoming)
  ) return "ignore";
  if (
    previous &&
    voiceSnapshotCountersRegress(previous, incoming) &&
    incoming.ledger_status === "degraded"
  ) return "preserve_degraded";
  return isNewerVoiceSnapshot(previous, incoming) ? "accept" : "ignore";
}

export function isCurrentVoiceRefresh(
  requestGeneration: number,
  latestGeneration: number,
  revisionAtStart: number,
  currentRevision: number,
): boolean {
  return requestGeneration === latestGeneration && revisionAtStart === currentRevision;
}

async function fetchVoiceUsageSnapshot(): Promise<VoiceUsageSnapshot> {
  const { invoke } = await import("@tauri-apps/api/core");
  const snapshot = await invoke<VoiceUsageSnapshot>("voice_usage_snapshot");
  // The provider meter is a separate, failable call. A failure degrades this to
  // the local ledger alone rather than failing the whole rail - the local counts
  // are real on their own and were the only thing here before.
  try {
    snapshot.provider_quota = await invoke<ElevenLabsQuota | null>("elevenlabs_usage");
  } catch {
    snapshot.provider_quota = null;
  }
  return snapshot;
}

export function useVoiceUsage(): VoiceUsageState {
  const [state, setState] = useState<Omit<VoiceUsageState, "refresh">>({
    phase: "loading",
    snapshot: null,
    refreshing: true,
    stale: false,
    degraded: false,
    lastLiveMs: 0,
  });
  const lastGoodRef = useRef<VoiceUsageSnapshot | null>(null);
  const snapshotRevisionRef = useRef(0);
  const refreshGenerationRef = useRef(0);

  const acceptSnapshot = useCallback((snapshot: VoiceUsageSnapshot) => {
    const previous = lastGoodRef.current;
    if (snapshot.ledger_status === "unavailable") {
      snapshotRevisionRef.current += 1;
      setState((current) => ({
        ...current,
        phase: previous ? "error" : "unavailable",
        snapshot: previous,
        refreshing: false,
        stale: !!previous,
      }));
      return;
    }

    // An out-of-order event/poll must never roll the meter back to older counts.
    // A degraded lower-count snapshot still surfaces the ledger failure while
    // preserving the prior metrics rather than hiding corruption as healthy.
    const decision = classifyVoiceSnapshot(previous, snapshot);
    if (decision === "preserve_degraded" && previous) {
      const preserved: VoiceUsageSnapshot = {
        ...previous,
        ledger_status: "degraded",
        malformed_lines: Math.max(previous.malformed_lines, snapshot.malformed_lines),
        write_failures: Math.max(previous.write_failures, snapshot.write_failures),
        maintenance_failures: Math.max(previous.maintenance_failures, snapshot.maintenance_failures),
      };
      lastGoodRef.current = preserved;
      snapshotRevisionRef.current += 1;
      setState((current) => ({
        ...current,
        snapshot: preserved,
        refreshing: false,
        stale: true,
        degraded: true,
      }));
      return;
    }
    if (decision === "ignore") {
      setState((current) => ({ ...current, refreshing: false }));
      return;
    }

    snapshotRevisionRef.current += 1;
    lastGoodRef.current = snapshot;
    setState({
      phase: phaseForVoiceSnapshot(snapshot),
      snapshot,
      refreshing: false,
      stale: false,
      degraded: snapshot.ledger_status === "degraded",
      lastLiveMs: Date.now(),
    });
  }, []);

  const refresh = useCallback(() => {
    const requestGeneration = ++refreshGenerationRef.current;
    const revisionAtStart = snapshotRevisionRef.current;
    setState((current) => ({
      ...current,
      phase: current.snapshot ? current.phase : "loading",
      refreshing: true,
    }));
    void fetchVoiceUsageSnapshot()
      .then((snapshot) => {
        if (!isCurrentVoiceRefresh(
          requestGeneration,
          refreshGenerationRef.current,
          revisionAtStart,
          snapshotRevisionRef.current,
        )) return;
        acceptSnapshot(snapshot);
      })
      .catch(() => {
        if (!isCurrentVoiceRefresh(
          requestGeneration,
          refreshGenerationRef.current,
          revisionAtStart,
          snapshotRevisionRef.current,
        )) return;
        const previous = lastGoodRef.current;
        setState((current) => ({
          ...current,
          phase: previous ? "error" : "unavailable",
          snapshot: previous,
          refreshing: false,
          stale: !!previous,
        }));
      });
  }, [acceptSnapshot]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    refresh();
    const stopPolling = visibleInterval(refresh, REFRESH_MS);
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<VoiceUsageSnapshot>("praxis://voice-usage", (event) => {
          if (!cancelled) acceptSnapshot(event.payload);
        }),
      )
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {
        // The 30-second local poll remains the recovery path in older/non-Tauri builds.
      });

    return () => {
      cancelled = true;
      stopPolling();
      unlisten?.();
    };
  }, [acceptSnapshot, refresh]);

  return { ...state, refresh };
}
