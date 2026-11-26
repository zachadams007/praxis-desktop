function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export type OperatorStopState = "requested" | "idle" | "unavailable";

export interface OperatorStopResult {
  orchestration: OperatorStopState;
  unattended: OperatorStopState;
  computerUse: OperatorStopState;
  sovereign: OperatorStopState;
  native: OperatorStopState;
  /** True only when every actuator that could belong to this owner is terminal. */
  terminal: boolean;
}

const unresolvedOperatorOwners = new Set<string>();

function normalizedOwners(ownerTokens: Iterable<string>): string[] {
  return [...new Set([...ownerTokens].map((token) => token.trim()).filter(Boolean))];
}

export function retainUnresolvedOperatorOwners(ownerTokens: Iterable<string>): void {
  for (const owner of normalizedOwners(ownerTokens)) unresolvedOperatorOwners.add(owner);
}

export function releaseUnresolvedOperatorOwners(ownerTokens: Iterable<string>): void {
  for (const owner of normalizedOwners(ownerTokens)) unresolvedOperatorOwners.delete(owner);
}

export function getUnresolvedOperatorOwners(): string[] {
  return [...unresolvedOperatorOwners];
}

/**
 * Monotonic latest-turn gate shared by the local Hybrid hook and Realtime tool
 * bridge. A replacement turn claims a new epoch before it awaits the prior
 * owner's stop. Only the still-current epoch may mint a new owner afterwards.
 */
export interface OperatorTurnEpoch {
  begin: () => number;
  invalidate: () => number;
  isCurrent: (epoch: number) => boolean;
}

export function createOperatorTurnEpoch(): OperatorTurnEpoch {
  let current = 0;
  return {
    begin: () => ++current,
    invalidate: () => ++current,
    isCurrent: (epoch) => epoch === current,
  };
}

/** Await the prior owner's scoped stop, then enforce latest-turn/session state. */
export async function waitForCurrentOperatorTurn(
  epoch: OperatorTurnEpoch,
  claimedEpoch: number,
  priorStop: PromiseLike<unknown>,
  isInactive: () => boolean,
): Promise<boolean> {
  try {
    await priorStop;
  } catch {
    // Stop uncertainty is a closed admission gate, never permission to overlap.
    return false;
  }
  return !isInactive() && epoch.isCurrent(claimedEpoch);
}

/**
 * Serialize owner-scoped stop requests. Realtime uses this before replacing a
 * native operator/tool turn so two provider tool events cannot race the single
 * backend operator slot.
 */
export class SerializedOperatorStopQueue {
  private pending: Promise<void> | null = null;
  /** Owners stay here until a terminal acknowledgement is observed. A failed
   *  attempt is deliberately retained so enqueue(null) retries it even after the
   *  route's owner ref has already cleared. */
  private readonly queuedOwners: string[] = [];

  constructor(
    private readonly stopOwner: (ownerToken: string) => Promise<void | OperatorStopResult> = stopOperatorRuns,
  ) {}

  enqueue(ownerToken: string | null): Promise<void> {
    const normalized = ownerToken?.trim() || null;
    if (normalized && !this.queuedOwners.includes(normalized)) this.queuedOwners.push(normalized);
    if (this.pending) return this.pending;
    if (this.queuedOwners.length === 0) return Promise.resolve();

    const pending = this.drain();
    this.pending = pending;
    void pending.then(
      () => {
        if (this.pending === pending) this.pending = null;
      },
      () => {
        if (this.pending === pending) this.pending = null;
      },
    );
    return pending;
  }

  private async drain(): Promise<void> {
    while (this.queuedOwners.length > 0) {
      const ownerToken = this.queuedOwners[0];
      try {
        const result = await this.stopOwner(ownerToken);
        if (result && !result.terminal) {
          retainUnresolvedOperatorOwners([ownerToken]);
          throw new Error(`Operator owner ${ownerToken} did not reach a confirmed terminal state.`);
        }
      } catch (error) {
        retainUnresolvedOperatorOwners([ownerToken]);
        throw error;
      }
      releaseUnresolvedOperatorOwners([ownerToken]);
      this.queuedOwners.shift();
    }
  }
}

/**
 * Register an async listener/resource without leaking it when React cleanup
 * wins the race against dynamic import/listen. Cleanup is idempotent.
 */
export function registerAsyncCleanup(register: () => Promise<() => void>): () => void {
  let disposed = false;
  let cleanup: (() => void) | null = null;

  void register()
    .then((registeredCleanup) => {
      if (disposed) {
        registeredCleanup();
      } else {
        cleanup = registeredCleanup;
      }
    })
    .catch(() => {
      // Optional listeners stay inert when their host surface is unavailable.
    });

  return () => {
    if (disposed) return;
    disposed = true;
    const registeredCleanup = cleanup;
    cleanup = null;
    registeredCleanup?.();
  };
}

/** Mint a per-turn owner token without depending on crypto being present in tests. */
export function createOperatorOwnerToken(prefix = "voice"): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

type OperatorStopLanes = Pick<
  OperatorStopResult,
  "orchestration" | "unattended" | "computerUse" | "sovereign" | "native"
>;

type OperatorStopLaneFactories = {
  [Lane in keyof OperatorStopLanes]: () => Promise<OperatorStopState>;
};

/** Start every lane before awaiting any lane. This prevents a dependent
 * orchestration/unattended promise from withholding the desktop abort it needs
 * in order to become terminal. Exported for deterministic ordering regressions. */
export async function settleOperatorStopLanes(
  factories: OperatorStopLaneFactories,
): Promise<OperatorStopLanes> {
  const lanes: (keyof OperatorStopLanes)[] = [
    "orchestration",
    "unattended",
    "computerUse",
    "sovereign",
    "native",
  ];
  const pending = lanes.map((lane) => Promise.resolve().then(factories[lane]));
  const settled = await Promise.allSettled(pending);
  return Object.fromEntries(
    lanes.map((lane, index) => [
      lane,
      settled[index].status === "fulfilled" ? settled[index].value : "unavailable",
    ]),
  ) as OperatorStopLanes;
}

function withTerminal(lanes: OperatorStopLanes): OperatorStopResult {
  return {
    ...lanes,
    terminal: Object.values(lanes).every((state) => state !== "unavailable"),
  };
}

function desktopStopFactory(
  invokeReady: Promise<typeof import("@tauri-apps/api/core").invoke> | null,
  command: string,
  args?: Record<string, unknown>,
): () => Promise<OperatorStopState> {
  if (!invokeReady) return async () => "idle";
  return async () => {
    const invoke = await invokeReady;
    const message = (await invoke<string>(command, args)).toLowerCase();
    return stopMessageIsIdle(message) ? "idle" : "requested";
  };
}

/**
 * Cooperatively stop every work lane owned by one voice/tool turn. All lane
 * requests start concurrently, and terminal is true only when the ordinary
 * orchestrator plus unattended and every desktop actuator are exact-owner done.
 */
export async function stopOperatorRuns(ownerToken: string): Promise<OperatorStopResult> {
  const invokeReady = inTauri()
    ? import("@tauri-apps/api/core").then(({ invoke }) => invoke)
    : null;
  const lanes = await settleOperatorStopLanes({
    orchestration: async () => {
      const { stopOwnedOrchestration } = await import("@/orchestrator/ownedRuns");
      return stopOwnedOrchestration(ownerToken);
    },
    unattended: async () => {
      const { stopUnattendedRun } = await import("@/orchestrator/unattended");
      return stopUnattendedRun(ownerToken);
    },
    computerUse: desktopStopFactory(invokeReady, "computer_use_abort", { ownerToken }),
    sovereign: desktopStopFactory(invokeReady, "sovereign_abort", { ownerToken }),
    native: desktopStopFactory(invokeReady, "native_op_abort", { ownerToken }),
  });
  const result = withTerminal(lanes);
  if (result.terminal) releaseUnresolvedOperatorOwners([ownerToken]);
  else retainUnresolvedOperatorOwners([ownerToken]);
  return result;
}

/** Explicit global stop used only by HALT ALL and deliberate stop-button clicks. */
export async function stopAllOperatorRuns(): Promise<OperatorStopResult> {
  const invokeReady = inTauri()
    ? import("@tauri-apps/api/core").then(({ invoke }) => invoke)
    : null;
  const lanes = await settleOperatorStopLanes({
    orchestration: async () => {
      const { stopAllOwnedOrchestrations } = await import("@/orchestrator/ownedRuns");
      return stopAllOwnedOrchestrations();
    },
    unattended: async () => {
      const { stopAllUnattendedRuns } = await import("@/orchestrator/unattended");
      return stopAllUnattendedRuns();
    },
    computerUse: desktopStopFactory(invokeReady, "computer_use_abort_all"),
    sovereign: desktopStopFactory(invokeReady, "sovereign_abort_all"),
    native: desktopStopFactory(invokeReady, "native_op_abort_all"),
  });
  const result = withTerminal(lanes);
  if (result.terminal) releaseUnresolvedOperatorOwners(getUnresolvedOperatorOwners());
  return result;
}

function stopMessageIsIdle(message: string): boolean {
  return message.includes("no active") ||
    message.includes("no matching") ||
    message.includes("before run admission") ||
    message.includes("different owner");
}

function mergeStopState(states: OperatorStopState[]): OperatorStopState {
  if (states.includes("requested")) return "requested";
  if (states.length > 0 && states.every((state) => state === "idle")) return "idle";
  return "unavailable";
}

/** Stop every distinct owner represented by one voice session. This remains
 *  scoped: it never calls the explicit `_abort_all` backend commands. */
export async function stopOperatorOwners(ownerTokens: Iterable<string>): Promise<OperatorStopResult> {
  const owners = normalizedOwners(ownerTokens);
  if (owners.length === 0) {
    return {
      orchestration: "idle",
      unattended: "idle",
      computerUse: "idle",
      sovereign: "idle",
      native: "idle",
      terminal: true,
    };
  }
  const results = await Promise.all(owners.map((owner) => stopOperatorRuns(owner)));
  return {
    orchestration: mergeStopState(results.map((result) => result.orchestration)),
    unattended: mergeStopState(results.map((result) => result.unattended)),
    computerUse: mergeStopState(results.map((result) => result.computerUse)),
    sovereign: mergeStopState(results.map((result) => result.sovereign)),
    native: mergeStopState(results.map((result) => result.native)),
    terminal: results.every((result) => result.terminal),
  };
}

/**
 * End one continuous voice session without widening the stop to unrelated work.
 * The active router turn is aborted immediately, then every pending or detached
 * owner minted by that session is stopped through the owner-scoped backend path.
 */
export function stopOperatorSessionRuns(
  abortHandle: { abort: () => void } | null | undefined,
  pendingOwner: string | null | undefined,
  detachedOwners: Iterable<string>,
  stopOwners: (ownerTokens: Iterable<string>) => Promise<OperatorStopResult> = stopOperatorOwners,
): Promise<OperatorStopResult> {
  abortHandle?.abort();
  const owners = normalizedOwners([pendingOwner ?? "", ...detachedOwners]);
  // Durable before the first await: an unmount must never create an owner-loss gap.
  retainUnresolvedOperatorOwners(owners);
  const stop = stopOwners(owners);
  return stop.then(
    (result) => {
      if (result.terminal) releaseUnresolvedOperatorOwners(owners);
      else retainUnresolvedOperatorOwners(owners);
      return result;
    },
    (error) => {
      retainUnresolvedOperatorOwners(owners);
      throw error;
    },
  );
}
