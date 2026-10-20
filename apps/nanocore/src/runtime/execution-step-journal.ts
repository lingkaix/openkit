import type { ActorRef, WorkOwner } from '@openkit/protocol';

/** Owner-qualified existing execution identity; this reference grants no authority. */
export interface ExecutionJournalRef {
  readonly owner: Readonly<WorkOwner>;
  readonly executionId: string;
}

/** One immutable invocation in its owning execution, not a retry or replay request. */
export interface ExecutionStepRef {
  readonly execution: ExecutionJournalRef;
  readonly stepId: string;
}

/** Release-authored step kinds from the durable execution transition and lifecycle owners. */
export type ExecutionStepKind =
  | 'admit'
  | 'queue-capacity-wait'
  | 'reserve'
  | 'resolve-setup'
  | 'validate-setup'
  | 'materialize'
  | 'open-session'
  | 'inspect-session'
  | 'deliver-start'
  | 'observe'
  | 'collect'
  | 'terminal-publication'
  | 'cancel'
  | 'human-wait'
  | 'consume-receipt'
  | 'inspect-cleanup'
  | 'fence'
  | 'release';

/** Ended outcomes exclude intent; later evidence cannot revise any of these outcomes. */
export type EndedExecutionStepState = 'completed' | 'failed' | 'unknown' | 'cancelled';

/**
 * Control facts stay separate from diagnostic attributes and never derive authority from them.
 * References name existing immutable inputs, decisions, declarations and fence evidence, not bodies or credentials.
 */
export interface ExecutionStepControl {
  readonly definitionVersion: string;
  readonly kind: ExecutionStepKind;
  readonly workId: string;
  readonly operationId: string | null;
  readonly attemptId: string | null;
  readonly invocationId: string;
  readonly actor: Readonly<ActorRef>;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly fingerprint: string;
  readonly permittingDecisionRef: string | null;
  readonly authorityRefs: readonly string[];
  readonly retryDeclarationRef: string | null;
  readonly retryPermitted: boolean;
  readonly deadlineUnixNano: bigint | null;
  readonly physicalFenceRefs: readonly string[];
}

/**
 * Lossless OTel AnyValue, including an unset value; int is exact signed int64, never a double or string.
 * Bytes contain integers from 0 through 255. These declarations perform no validation or serialization.
 */
export type ExecutionJournalAnyValue =
  | { readonly type: 'empty' }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'int'; readonly value: bigint }
  | { readonly type: 'double'; readonly value: number }
  | { readonly type: 'bytes'; readonly value: readonly number[] }
  | { readonly type: 'array'; readonly value: readonly ExecutionJournalAnyValue[] }
  | { readonly type: 'kvlist'; readonly value: readonly ExecutionJournalAttribute[] };

/** One typed key/value entry; arrays preserve stored order without SDK narrowing. */
export interface ExecutionJournalAttribute {
  readonly key: string;
  readonly value: ExecutionJournalAnyValue;
}

/** Point observation, including admitted unverified Worker markers; never a child duration or control input. */
export interface ExecutionJournalEvent {
  readonly timeUnixNano: bigint;
  readonly name: string;
  readonly attributes: readonly ExecutionJournalAttribute[];
  readonly droppedAttributesCount: number;
}

/** Non-authoritative OTel link; IDs are nonzero lowercase hex of trace/span width, not runtime identities. */
export interface ExecutionJournalLink {
  /** Exactly 32 lowercase hexadecimal digits. */
  readonly traceId: string;
  /** Exactly 16 lowercase hexadecimal digits. */
  readonly spanId: string;
  readonly traceState?: string;
  readonly flags: number;
  readonly attributes: readonly ExecutionJournalAttribute[];
  readonly droppedAttributesCount: number;
}

/** Stable instrumentation descriptor with its exact optional metadata and pinned schema URL. */
export interface ExecutionJournalInstrumentationScope {
  readonly name: string;
  readonly version?: string;
  readonly attributes: readonly ExecutionJournalAttribute[];
  readonly droppedAttributesCount: number;
  readonly schemaUrl?: string;
}

/** Resource descriptor shared by spans without discarding its stored types or schema metadata. */
export interface ExecutionJournalResource {
  readonly attributes: readonly ExecutionJournalAttribute[];
  readonly droppedAttributesCount: number;
  readonly schemaUrl?: string;
}

/**
 * Stored span model, not an SDK span or export buffer. Times are integer Unix nanoseconds.
 * Open roots/steps have a null end and are inspectable but unexported. Ended unknown steps use ERROR.
 * Diagnostic fields exclude prompts, arguments, output bodies, credentials and private reasoning.
 */
export interface ExecutionJournalSpan {
  /** Nonzero, exactly 32 lowercase hexadecimal digits. */
  readonly traceId: string;
  /** Nonzero, exactly 16 lowercase hexadecimal digits. */
  readonly spanId: string;
  /** When present, nonzero and exactly 16 lowercase hexadecimal digits. */
  readonly parentSpanId?: string;
  readonly traceState?: string;
  readonly flags: number;
  readonly name: string;
  readonly kind: 'UNSPECIFIED' | 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint | null;
  readonly status: {
    readonly code: 'UNSET' | 'OK' | 'ERROR';
    readonly description?: string;
  };
  readonly attributes: readonly ExecutionJournalAttribute[];
  readonly droppedAttributesCount: number;
  readonly events: readonly ExecutionJournalEvent[];
  readonly droppedEventsCount: number;
  readonly links: readonly ExecutionJournalLink[];
  readonly droppedLinksCount: number;
  readonly instrumentationScope: ExecutionJournalInstrumentationScope;
  readonly resource: ExecutionJournalResource;
}

/** Immutable ended invocation and its single span/sample source; reads and exports never resample it. */
export interface EndedExecutionStep {
  readonly ref: ExecutionStepRef;
  readonly state: EndedExecutionStepState;
  readonly control: ExecutionStepControl;
  /** The persisted execution root's nonzero 16-digit span ID; distinct executions link, not reparent. */
  readonly rootSpanId: string;
  readonly span: ExecutionJournalSpan & { readonly endTimeUnixNano: bigint };
}

/**
 * A separate ended inspection/cleanup invocation whose span links to the inspected step's trace/span.
 * Its evidence cannot rewrite the original outcome, reopen work or itself prove release of exclusion.
 * Late Host observations belong here, never on an already-ended original span.
 */
export interface LinkedExecutionInspection {
  readonly inspectedStep: ExecutionStepRef;
  readonly inspection: EndedExecutionStep;
}

/**
 * Read-only boundary for the durable execution owner's journal; no implementation or wiring is supplied.
 * Reads preserve exact types, values, counts, order and metadata. Missing or unreadable authority is not empty history.
 * Callers retain scope admission and disclosure checks; correlation IDs and diagnostic attributes grant neither.
 */
export interface ExecutionStepJournalReader {
  /**
   * Reads immutable ended steps for exactly one owner-qualified execution; never advances or replays it.
   * @param executionRef Existing execution selected under current admission and authorization.
   * @returns Ended steps in journal order, with original outcomes and span values unchanged.
   * @throws When required authority is missing, unavailable, conflicting or unsupported; no empty fallback.
   */
  readEndedSteps(executionRef: ExecutionJournalRef): Promise<readonly EndedExecutionStep[]>;

  /**
   * Reads separate linked inspection evidence without revising or resampling the original step.
   * @param stepRef Exact original step selected under current admission and authorization.
   * @returns Separate ended inspection invocations in journal order; unknown originals remain unknown.
   * @throws When the original or linked authority is missing, unavailable, conflicting or unsupported.
   */
  readLinkedInspections(stepRef: ExecutionStepRef): Promise<readonly LinkedExecutionInspection[]>;
}
