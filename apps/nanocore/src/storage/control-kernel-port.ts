import type { AuditEvent, WorkOwner } from '@openkit/protocol';
import type { ExecutionBackendCorrelation } from '../runtime/execution-backend.js';
import type { ExecutionJournalRef, ExecutionStepRef } from '../runtime/execution-step-journal.js';
import type { NanoHostRuntimeTargetRecord } from '../runtime/nanohost-runtime-target-records.js';
import type { WorkerBackendSessionRecord } from '../runtime/worker-backend-session-records.js';
import type {
  ChannelInboundEnvelope,
  ChannelInboundKey,
  ChannelInboundOrigin,
  ChannelInboundReceipt,
  ChannelInboundState,
  PairingAuditIntent,
  PairingAuditReceipt,
} from './communication-port.js';
import type { NanoHostEpochInvalidation, NanoHostEpochReceipt } from './nanohost-port.js';
import type { ServerWorkIntent, ServerWorkReceipt } from './server-work-port.js';
import type {
  StorageDecision,
  StorageIntent,
  StorageReceipt,
  StorageReceiptLookup,
  StorageResult,
  StorageStatus,
} from './storage-owner.js';

/** Observations from one admitted NanoHost owner. A ready null requires complete readable history. */
export interface NanoHostCoreReads {
  readTarget(targetId: string): StorageResult<'nanohost', NanoHostRuntimeTargetRecord | null>;
  readBackendSession(
    key: { readonly attemptId: string } | { readonly packageSnapshotId: string }
  ): StorageResult<'nanohost', WorkerBackendSessionRecord | null>;
  readResident(bindingRef: string): StorageResult<
    'nanohost',
    {
      readonly binding: string;
      readonly origin: string;
      readonly target: string;
      readonly drain: string;
    } | null
  >;
  listDrainingResidents(
    after: string | null,
    limit: number
  ): StorageResult<
    'nanohost',
    { readonly bindings: readonly string[]; readonly next: string | null }
  >;
}

/** A4 resolves original committed bytes at the work owner and verifies the digest. */
export interface WorkInputRef {
  readonly owner: WorkOwner;
  readonly inputId: string;
  readonly digest: string;
}

/** A8 uses the original preparation step's clock until the submission deadline is set. */
export type ExecutionGrant = ExecutionBackendCorrelation & {
  readonly execution: ExecutionJournalRef;
  readonly turnId: string;
  readonly generation: string;
} & (
    | { readonly deadline: null; readonly preparationStep: ExecutionStepRef }
    | { readonly deadline: string }
  );

/** A8 binds the original selected input, including equal-text siblings, before contact. */
export interface SelectedExecutionInput {
  readonly input: WorkInputRef;
  readonly order: number;
  readonly originalInvocationId: string;
  readonly grant: ExecutionGrant;
}

/** Bounded reference to evidence that stays at its origin. */
interface ExecutionEvidenceRef {
  readonly ref: string;
  readonly digest: string;
}

/** The proof must match the backend ID in the original admitted grant. */
export interface BackendEvidenceRef extends ExecutionEvidenceRef {
  readonly backendId: string;
}

/** An authenticated work owner supplies evidence of its own committed records. */
export interface WorkEvidenceRef extends ExecutionEvidenceRef {
  readonly owner: WorkOwner;
}

/** Use a linked observation for an intake finding or proved non-submission of this exact input. */
export type ExecutionInputProof<Evidence extends ExecutionEvidenceRef = BackendEvidenceRef> = {
  readonly obligation: ExecutionStepRef;
  readonly selected: SelectedExecutionInput;
  readonly boundary: string;
} & (
  | {
      readonly kind: 'intake';
      readonly finding: 'accepted' | 'consumed';
      readonly evidence: Evidence;
    }
  | { readonly kind: 'intake'; readonly finding: 'unknown'; readonly evidence: Evidence | null }
  | {
      readonly kind: 'non-submission';
      readonly reason: 'refused-before-contact' | 'removed-before-processing';
      readonly evidence: Evidence;
    }
);

/** A7–A9 report submit disposition or a fence. A fence only covers its proved writer scopes. */
export type ExecutionOperationProof =
  | ({ readonly kind: 'submission' } & (
      | { readonly disposition: 'accepted' | 'not_accepted'; readonly evidence: BackendEvidenceRef }
      | { readonly disposition: 'unknown'; readonly evidence: BackendEvidenceRef | null }
    ))
  | {
      readonly kind: 'fence';
      readonly fence: BackendEvidenceRef;
      readonly coveredScopeRefs: readonly string[];
    };

/** A8 resolves each committed handoff independently of native fence evidence. */
export interface ExecutionHandoff extends WorkEvidenceRef {
  readonly kind: 'terminal-publication' | 'output' | 'evidence' | 'outside-workspace-collection';
}

/** The source identity is open. Match backend submissions to the original admitted backend. */
export type ExecutionProofIntent = StorageIntent<string, 'apply-execution-proof', ExecutionGrant>;

/** The deciding step commits before the source settles its proof intent. */
export type ExecutionProofReceipt = StorageReceipt<
  ExecutionProofIntent,
  { readonly step: ExecutionStepRef }
>;

/** A7 and A9 use the same proof tuple under their own admitted backend identities. */
export interface ExecutionProofSubmission {
  readonly intent: ExecutionProofIntent;
  readonly proof: ExecutionInputProof | ExecutionOperationProof;
}

/** The kernel reads the verified repair role and actor from the original entry step. */
export type RepairCallIntent = StorageIntent<
  'control-kernel',
  'repair.model-call',
  {
    readonly entryStep: ExecutionStepRef;
    readonly attemptId: string;
    readonly invocationId: string;
    readonly callId: string;
    readonly routeRef: string;
    readonly allocationRef: string;
  }
>;

/** A5 uses the applied reserve step to settle the original call. */
export type RepairCallReservation = Extract<
  StorageReceipt<RepairCallIntent, { readonly step: ExecutionStepRef }>,
  { readonly disposition: 'applied' }
>;

/** A5 reports bounded outcomes and redacted observed usage to kernel Audit. */
export interface RepairCallOutcome {
  readonly disposition: 'succeeded' | 'failed' | 'unknown';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Repair lookup and replay grant no provider contact. */
export type RepairCallInspection =
  | { readonly state: 'reserved'; readonly reservation: RepairCallReservation }
  | { readonly state: 'terminal'; readonly auditEventId: AuditEvent['id'] }
  | { readonly state: 'refused'; readonly reason: 'policy' | 'vault' | 'budget' }
  | { readonly state: 'absent' | 'unknown' | 'conflict' };

/** A8 exposes the deciding operations and their typed results. */
export interface ControlKernelStore {
  status(): StorageStatus<'control-kernel'>;
  decideServerWork<Intent extends ServerWorkIntent>(
    intent: Intent
  ): Promise<StorageResult<'control-kernel', StorageDecision<ServerWorkReceipt<Intent>>>>;
  inspectServerWork<Intent extends ServerWorkIntent>(
    intent: Intent
  ): Promise<StorageResult<'control-kernel', StorageReceiptLookup<ServerWorkReceipt<Intent>>>>;
  relayPairingAudit(
    intent: PairingAuditIntent,
    event: AuditEvent
  ): Promise<StorageResult<'control-kernel', StorageDecision<PairingAuditReceipt>>>;
  inspectPairingAudit(
    intent: PairingAuditIntent
  ): Promise<StorageResult<'control-kernel', StorageReceiptLookup<PairingAuditReceipt>>>;
  /** Reserve permanent uniqueness against the authenticated envelope. Existing keys inspect. */
  reserveChannelInbound(
    envelope: ChannelInboundEnvelope
  ): Promise<
    StorageResult<
      'control-kernel',
      { readonly state: 'reserved-now' | 'inspect-original' | 'conflict' | 'unknown' }
    >
  >;
  /** Commit the verified origin once. A replay inspects the saved origin and its decision. */
  bindChannelInboundOrigin(
    origin: ChannelInboundOrigin
  ): Promise<
    StorageResult<
      'control-kernel',
      { readonly state: 'bound-now' | 'inspect-original' | 'conflict' | 'unknown' }
    >
  >;
  /** Settle the original envelope. A Pending Request effect requires its bound origin and decision. */
  settleChannelInbound(
    envelope: ChannelInboundEnvelope,
    outcome: Extract<ChannelInboundReceipt, { disposition: 'applied' }>['result']
  ): Promise<StorageResult<'control-kernel', StorageDecision<ChannelInboundReceipt>>>;
  /** Look up stage, origin and decision by key under current read authority. */
  inspectChannelInbound(
    key: ChannelInboundKey
  ): Promise<StorageResult<'control-kernel', ChannelInboundState>>;
  /** Commit the per-input admit step before possible contact. */
  admitInput(
    selected: SelectedExecutionInput
  ): Promise<StorageResult<'control-kernel', StorageDecision<ExecutionStepRef>>>;
  /**
   * Verify the original admitted backend, generation and scope. Persist the proof and deciding step.
   * Match late fences to the original execution. CAS release with the surviving exclusions.
   */
  applyExecutionProof(
    submission: ExecutionProofSubmission
  ): Promise<StorageResult<'control-kernel', StorageDecision<ExecutionProofReceipt>>>;
  inspectExecutionProof(
    intent: ExecutionProofIntent
  ): Promise<StorageResult<'control-kernel', StorageReceiptLookup<ExecutionProofReceipt>>>;
  /** Verify the Gateway/work owner and link its evidence to the exact original input obligation. */
  applyWorkInputProof(
    intent: ExecutionProofIntent,
    proof: ExecutionInputProof<WorkEvidenceRef>
  ): Promise<StorageResult<'control-kernel', StorageDecision<ExecutionProofReceipt>>>;
  /**
   * Resolve the original work owner's committed reference and digest.
   * Record it before or after the fence and CAS release with the surviving exclusions.
   * Missing handoffs prevent successful release. Any qualified waiver needs a fenced scope and Audit.
   */
  recordExecutionHandoff(
    intent: ExecutionProofIntent,
    handoff: ExecutionHandoff
  ): Promise<StorageResult<'control-kernel', StorageDecision<ExecutionProofReceipt>>>;
  /** Settle the existing Vault holder fences for an invalidated epoch before successor readiness. */
  fenceNanoHostEpoch(
    intent: NanoHostEpochInvalidation
  ): Promise<StorageResult<'control-kernel', StorageDecision<NanoHostEpochReceipt>>>;
  inspectNanoHostEpochFence(
    intent: NanoHostEpochInvalidation
  ): Promise<StorageResult<'control-kernel', StorageReceiptLookup<NanoHostEpochReceipt>>>;
  /** Only a new applied reserve commit permits one provider contact under verified repair lineage. */
  reserveRepairCall(
    intent: RepairCallIntent
  ): Promise<
    StorageResult<
      'control-kernel',
      | { readonly state: 'reserved-now'; readonly reservation: RepairCallReservation }
      | RepairCallInspection
    >
  >;
  /** Inspect the original entry and reserve step or terminal Audit after a lost ACK. */
  inspectRepairCall(
    intent: RepairCallIntent
  ): Promise<StorageResult<'control-kernel', RepairCallInspection>>;
  /** Settle the original call, including after recovering its applied reservation. */
  settleRepairCall(
    reservation: RepairCallReservation,
    outcome: RepairCallOutcome
  ): Promise<StorageResult<'control-kernel', StorageDecision<AuditEvent['id']>>>;
}
