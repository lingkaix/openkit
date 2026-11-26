import type { WorkerStopDeclaration } from './adapter-registry.js';
import type { LifecycleDeadline } from './lifecycle-deadline.js';

/** One authenticated carrier. A reconnect advances the generation within the same incarnation. */
export interface WorkerShimSession {
  readonly sandboxIncarnationId: string;
  readonly connectionGeneration: number;
}

/** One Core-authorized Worker start, with the exact retained native reference when resuming. */
export interface WorkerShimStart {
  readonly workerId: string;
  readonly adapterId: string;
  readonly agentSessionId: string;
  readonly workSlotRef: string;
  readonly resume: { readonly locator: string; readonly digest: string } | null;
}

/** Monotonic desired state for an immutable Worker lifetime. */
export type WorkerShimDesiredWorker =
  | { readonly state: 'run'; readonly worker: WorkerShimStart }
  | { readonly state: 'stop'; readonly workerId: string };

/** Correlation of a one-shot operation. Payload changes cannot replace the original outcome. */
export interface WorkerShimOperationKey {
  readonly operationId: string;
  readonly workerId: string;
  readonly payloadDigest: string;
}

/** Exact attempt target, shared by input, steer and desired interrupt. */
export interface WorkerShimTurn {
  readonly workerId: string;
  readonly attemptId: string;
  readonly turnId: string;
}

/** Original one-shot work against the addressed Turn. */
export interface WorkerShimKeyedWork extends WorkerShimOperationKey, WorkerShimTurn {
  readonly inputRef: string;
}

/** Initial Turn input with the admitted route grant. */
export interface WorkerShimTurnInput extends WorkerShimKeyedWork {
  /** Opaque correlation to the already admitted route grant. */
  readonly routeGrant: string;
}

/** Desired interruption carrying the original request for settlement. */
export interface WorkerShimInterrupt extends WorkerShimTurn {
  readonly requestId: string;
  /** The governed collection cutoff, when this is a system stop. */
  readonly cause?: 'observation_limit_reached';
}

/** Native intake result. Acceptance alone conveys no processing or absence proof. */
export type WorkerShimDisposition = 'accepted' | 'refused' | 'unknown';

/** Original input or steer evidence carried until Core acknowledges it. */
export interface WorkerShimReceipt {
  readonly kind: 'input' | 'steer';
  readonly key: WorkerShimOperationKey;
  readonly disposition: WorkerShimDisposition;
}

/** Original settlement for an admitted desired interruption. */
export interface WorkerShimInterruptReceipt extends WorkerShimInterrupt {
  readonly disposition: 'cancelled' | 'refused' | 'unknown';
}

/** Local Worker observation. Direct-child exit is independent of whole-tree proof. */
export interface WorkerShimObservation {
  readonly workerId: string;
  readonly state: 'running' | 'stopping' | 'exited';
  readonly stop: WorkerStopDeclaration;
  readonly absence?: Extract<WorkerShimAbsence, { state: 'absent' }>;
}

/** Scoped absence after ingress closure and the join of accepted work, or a held claim. */
export type WorkerShimAbsence =
  | { readonly state: 'held' }
  | { readonly state: 'absent'; readonly workerId: string; readonly proofKind: string };

/** Complete upward inventory for the current authenticated shim session. */
export interface WorkerShimInventory {
  readonly session: WorkerShimSession;
  readonly workers: readonly WorkerShimObservation[];
  readonly receipts: readonly WorkerShimReceipt[];
  readonly interrupts: readonly WorkerShimInterruptReceipt[];
}

/** Complete downward desired set, with a revision local to the current session. */
export interface WorkerShimDesiredSet {
  readonly session: WorkerShimSession;
  readonly revision: number;
  readonly workers: readonly WorkerShimDesiredWorker[];
  readonly inputs: readonly WorkerShimTurnInput[];
  readonly steers: readonly WorkerShimKeyedWork[];
  readonly interrupts: readonly WorkerShimInterrupt[];
  readonly acknowledgedOperations: readonly WorkerShimOperationKey[];
}

/** Worker Shim boundary for environments with incarnation-scoped supervision. */
export interface WorkerShimPort {
  /** Realizes one authorized Worker ID at most once. */
  start(worker: WorkerShimStart): Promise<WorkerShimDisposition>;

  /** Applies durable desired stop to the exact Worker. Acknowledgement is not absence. */
  stop(workerId: string): Promise<'stopping' | 'exited' | 'unknown'>;

  /** Observes qualified absence within the original stop budget. Expiry supplies no proof. */
  waitUntilAbsent(workerId: string, deadline: LifecycleDeadline): Promise<WorkerShimAbsence>;

  /** Applies original Turn input at most once and preserves the outcome for the poll. */
  keyedTurnInput(input: WorkerShimTurnInput): Promise<WorkerShimDisposition>;

  /** Applies original steer to the active attempt and preserves uncertain delivery. */
  keyedSteer(input: WorkerShimKeyedWork): Promise<WorkerShimDisposition>;

  /** Publishes full inventory and applies only the current session's newer desired set. */
  poll(
    session: WorkerShimSession,
    exchange: (inventory: WorkerShimInventory) => Promise<WorkerShimDesiredSet>
  ): Promise<'applied' | 'stale'>;
}
