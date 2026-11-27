import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { canonicalJsonText, readRetainedV1, WorkspaceIdSchema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { SchedulerExecutionAttemptRecord } from '../runtime/execution-attempt-records.js';
import {
  readExecutionJournalInvocation,
  readExecutionJournalLinkedInspections,
  readExecutionJournalRoot,
  WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
} from '../runtime/execution-journal.js';
import {
  NANO_HOST_HEARTBEAT_BUDGET_MS,
  nanoHostStartupDeadline,
} from '../runtime/nanohost-attempt-clocks.js';
import type { NanoHostExecutionAttemptRecord } from '../runtime/nanohost-attempt-records.js';
import type { NanoHostClaimedCleanupResult } from '../runtime/nanohost-cleanup-continuation.js';
import {
  createNanoHostEffectRequest,
  createNanoHostInitialImageRequest,
  nanoHostSandboxIdFromBackendSessionId,
} from '../runtime/nanohost-effect-identity.js';
import {
  getNanoHostRuntimeTarget,
  type NanoHostRuntimeTargetRecord,
} from '../runtime/nanohost-runtime-target-records.js';
import {
  bindNanoHostWorkerRoutes,
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  type NanoHostSubmissionPlacement,
  readNanoHostSubmissionPlacement,
  readNanoHostWorkerLease,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
} from '../runtime/worker-backend-session-records.js';
import { getWorkerStorageBinding } from '../runtime/worker-storage-binding-records.js';
import type { ExecutionGrant } from './control-kernel-port.js';
import { commandInputHash } from './control-store-input.js';
import { assertControlProductWriter } from './control-store-product-records.js';
import type { ControlNanoHostOrphanRetirementInput } from './core-journal-codecs.js';
import type { WorkspaceDb } from './db.js';

const clock = z.iso.datetime({ precision: 3 });
/** Retains the original transport pin on the existing Native recovery claim. */
export const NanoHostCleanupOccurrenceSchema = z.strictObject({
  targetId: z.string().min(1),
  identityId: z.string().min(1),
  deploymentId: z.string().min(1),
  connectionGeneration: z.number().int().positive().safe(),
  physicalEpoch: z.string().regex(/^[a-f0-9]{64}$/),
  firstOperation: z.enum(['bridge.close', 'sandbox.delete']),
  firstRequestId: z.string().regex(/^[a-f0-9]{64}$/),
  deleteRequestId: z.string().regex(/^[a-f0-9]{64}$/),
});

export type NanoHostCleanupOccurrence = z.output<typeof NanoHostCleanupOccurrenceSchema>;

const physicalCleanup = z.strictObject({
  connectionGeneration: z.number().int().positive().safe(),
  physicalEpoch: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: clock,
});
/** The original cleanup-only claim stays on its materialization anchor without creating a lease. */
const cleanupOnlyRecovery = z.strictObject({
  version: z.literal(1),
  kind: z.literal('cleanup-only'),
  occurrence: NanoHostCleanupOccurrenceSchema.nullable(),
  physicalCleanup: physicalCleanup.optional(),
  readyBindingProof: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  imageDecision: z.enum(['not-enqueued', 'result-consumed', 'origin-ended']).optional(),
});
type CleanupOnlyRecovery = z.output<typeof cleanupOnlyRecovery>;

/** Reads the exact unused preparation and keeps unresolved prior claims inspectable. */
export function readNanoHostCleanupOnly(
  sqlite: Database.Database,
  attempt: SchedulerExecutionAttemptRecord
) {
  const session = getWorkerBackendSession({ sqlite }, attempt.attemptId);
  const row = sqlite
    .prepare(`SELECT worker_recovery_json AS proof,
    worker_route_binding_json AS route FROM worker_backend_sessions WHERE attempt_id=?`)
    .get(attempt.attemptId) as
    | { readonly proof: string | null; readonly route: string | null }
    | undefined;
  if (
    !session ||
    !row ||
    row.route !== null ||
    attempt.backendId !== 'nanohost' ||
    (attempt.disposition === 'accepted' && (attempt.deadline !== null || !attempt.operationId)) ||
    session.workspaceId !== attempt.workspaceId ||
    session.threadId !== attempt.threadId ||
    session.turnId !== attempt.turnId ||
    session.agentSessionId !== attempt.agentSessionId ||
    session.packageSnapshotId !== attempt.inputRef ||
    session.sandboxBindingRef !== attempt.bindingRef ||
    ![
      'materializing',
      'materialized',
      'cleanup-pending',
      'cleanup-failed',
      'physical-cleaned',
      'cleaned',
    ].includes(session.state) ||
    (attempt.phase === 'closed' &&
      (attempt.operationId === null
        ? attempt.deadline !== null || attempt.terminalCause !== 'turn-start-failed'
        : session.state !== 'cleaned' || (attempt.deadline !== null && !attempt.fenceRef))) ||
    (attempt.phase !== 'closed' && (attempt.phase !== 'closing' || !attempt.operationId)) ||
    sqlite
      .prepare(`SELECT 1 FROM worker_control_records WHERE turn_id=? AND package_snapshot_id=?
      UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints WHERE turn_id=? AND package_snapshot_id=? LIMIT 1`)
      .get(attempt.turnId, attempt.inputRef, attempt.turnId, attempt.inputRef) ||
    sqlite
      .prepare(
        `SELECT 1 FROM agent_session_runtime_bindings WHERE current_attempt_id=? OR current_turn_id=? LIMIT 1`
      )
      .get(attempt.attemptId, attempt.turnId)
  )
    return null;
  const proof = row.proof ? cleanupOnlyRecovery.safeParse(JSON.parse(row.proof)) : null;
  if (proof && !proof.success) return null;
  return { session, proof: proof?.data ?? null };
}

/**
 * Selects the original preparation from its retained Workspace occurrence and Native placement.
 * Committed-release inspection uses the original create after Core proves the release receipt.
 */
export function readNanoHostPreparationOccurrence(
  workspace: WorkspaceDb,
  sqlite: Database.Database,
  pkg: AgentEnvironmentPackage,
  attempt: SchedulerExecutionAttemptRecord,
  session: WorkerBackendSessionRecord,
  target: NanoHostRuntimeTargetRecord,
  cleanup: ReturnType<typeof readNanoHostCleanupOnly>,
  attachmentCheck: 'current' | 'committed-release' = 'current'
): 'image' | 'sandbox-create' | undefined {
  if (attempt.deadline !== null || !attempt.operationId) return;
  if (
    createNanoHostInitialImageRequest(session, attempt.attemptId, pkg).requestId ===
    attempt.operationId
  )
    return 'image';
  const rows = workspace.sqlite
    .prepare(`SELECT e.id AS executionId, s.step_id AS stepId
      FROM control_executions e JOIN control_execution_steps s ON e.id=s.execution_id
      WHERE e.work_id=? AND e.definition_version=?
        AND json_extract(s.control_json,'$.attemptId')=?
        AND json_extract(s.invocation_json,'$.carriage.operation')='sandbox.create'
        AND json_extract(s.invocation_json,'$.carriage.requestId')=? LIMIT 2`)
    .all(
      attempt.turnId,
      WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
      attempt.attemptId,
      attempt.operationId
    ) as { executionId: string; stepId: string }[];
  if (rows.length !== 1) return;
  const { executionId, stepId } = rows[0]!;
  const original = readExecutionJournalInvocation(workspace, {
    execution: { owner: { kind: 'workspace', workspaceId: workspace.workspaceId }, executionId },
    stepId,
  });
  const [
    turnId,
    packageSnapshotId,
    storageRef,
    generation,
    identityId,
    connectionGeneration,
    epoch,
  ] = original.control.inputRefs;
  if (
    original.control.kind !== 'materialize' ||
    !['unknown', 'completed'].includes(original.state) ||
    original.control.attemptId !== attempt.attemptId ||
    original.control.workId !== attempt.turnId ||
    original.control.operationId !== attempt.operationId ||
    original.carriage.operation !== 'sandbox.create' ||
    original.carriage.requestId !== attempt.operationId ||
    original.carriage.bindingRef !== session.sandboxBindingRef ||
    original.control.target?.backendKind !== 'nanohost' ||
    original.control.target?.targetId !== target.targetId ||
    original.control.target?.allocationRef !== session.sandboxBindingRef ||
    original.control.inputRefs.length !== 7 ||
    turnId !== attempt.turnId ||
    packageSnapshotId !== pkg.snapshotId ||
    !storageRef ||
    !generation ||
    !/^[1-9][0-9]*$/.test(generation) ||
    !Number.isSafeInteger(Number(generation)) ||
    target.targetId !== session.runtimeTargetId ||
    target.deploymentId !== session.deploymentId ||
    identityId !== target.identityId ||
    !connectionGeneration ||
    !/^[1-9][0-9]*$/.test(connectionGeneration) ||
    !Number.isSafeInteger(Number(connectionGeneration)) ||
    Number(connectionGeneration) > target.connectionGeneration ||
    epoch !== session.originPhysicalEpoch ||
    ((!cleanup?.proof?.occurrence ||
      Number(connectionGeneration) === target.connectionGeneration) &&
      target.physicalEpoch !== epoch)
  )
    return;
  if (attachmentCheck === 'committed-release') return 'sandbox-create';
  const attachment = getWorkerStorageBinding({ sqlite }, { storageRef });
  if (
    !attachment ||
    attachment.workspaceId !== session.workspaceId ||
    attachment.deploymentId !== session.deploymentId ||
    attachment.runtimeTargetId !== session.runtimeTargetId ||
    attachment.attachmentGeneration <= 0 ||
    String(attachment.attachmentGeneration) !== generation
  )
    return;
  const retained = attachment.state === 'idle' && cleanup?.proof?.occurrence;
  if (
    !retained &&
    (!['reserved', 'attached', 'unknown'].includes(attachment.state) ||
      attachment.currentAgentSessionId !== session.agentSessionId ||
      attachment.currentThreadId !== session.threadId ||
      (attachment.currentSandboxBindingRef !== null &&
        attachment.currentSandboxBindingRef !== session.sandboxBindingRef))
  )
    return;
  return 'sandbox-create';
}

/** Reads the original image outcome before allowing a no-Sandbox preparation to settle. */
export function readNanoHostInitialImageDecision(
  workspace: WorkspaceDb,
  pkg: AgentEnvironmentPackage,
  attempt: SchedulerExecutionAttemptRecord,
  session: WorkerBackendSessionRecord,
  target: NanoHostRuntimeTargetRecord,
  observedAt: string
): CleanupOnlyRecovery['imageDecision'] | 'unknown-hold' {
  if (attempt.deadline !== null || !attempt.operationId || !attempt.bindingRef) return;
  const { kind, requestId } = createNanoHostInitialImageRequest(session, attempt.attemptId, pkg);
  if (requestId !== attempt.operationId) return;
  const rows = workspace.sqlite
    .prepare(`SELECT c.id AS executionId, s.step_id AS stepId
      FROM control_executions c JOIN control_execution_steps s ON s.execution_id=c.id
      WHERE c.work_id=? AND json_extract(s.control_json,'$.kind')='resolve-setup'
      AND json_extract(s.control_json,'$.attemptId')=?
      AND json_extract(s.invocation_json,'$.carriage.operation')=?`)
    .all(attempt.turnId, attempt.attemptId, kind) as { executionId: string; stepId: string }[];
  if (rows.length !== 1) return;
  const { executionId, stepId } = rows[0]!;
  const execution = {
    owner: { kind: 'workspace' as const, workspaceId: workspace.workspaceId },
    executionId,
  };
  const root = readExecutionJournalRoot(workspace, execution);
  const original = readExecutionJournalInvocation(workspace, { execution, stepId });
  if (
    root.workId !== attempt.turnId ||
    root.definitionVersion !== WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION ||
    original.control.workId !== attempt.turnId ||
    original.control.attemptId !== attempt.attemptId ||
    original.control.operationId !== requestId ||
    original.carriage.requestId !== requestId ||
    original.carriage.bindingRef !== attempt.bindingRef ||
    original.control.target?.targetId !== session.runtimeTargetId ||
    original.control.target?.allocationRef !== attempt.bindingRef ||
    !isDeepStrictEqual(original.control.inputRefs, [attempt.turnId, session.packageSnapshotId])
  )
    return;
  if (
    original.state === 'failed' &&
    original.control.outputRefs.length === 0 &&
    attempt.disposition === 'not_accepted'
  )
    return 'not-enqueued';
  const expiry = original.control.deadlineUnixNano;
  if (original.state === 'unknown' && expiry === null) return;
  const expired = expiry !== null && BigInt(Date.parse(observedAt)) * 1_000_000n >= expiry;
  const originalPlacement =
    target.targetId === session.runtimeTargetId &&
    target.deploymentId === session.deploymentId &&
    target.physicalEpoch === session.originPhysicalEpoch;
  if (original.state === 'unknown' && !expired)
    return originalPlacement ? 'unknown-hold' : undefined;
  if (
    (original.state === 'completed' || original.state === 'unknown') &&
    target.physicalEpoch === session.originPhysicalEpoch
  ) {
    const receipts = readExecutionJournalLinkedInspections(workspace, original.ref)
      .map(({ inspection }) => inspection)
      .filter((inspection) => {
        const [digest] = inspection.control.outputRefs;
        if (
          inspection.state !== 'completed' ||
          inspection.control.kind !== 'consume-receipt' ||
          inspection.control.operationId !== requestId ||
          inspection.control.attemptId !== attempt.attemptId ||
          !digest ||
          !/^sha256:[a-f0-9]{64}$/.test(digest) ||
          !isDeepStrictEqual(inspection.control.inputRefs, [digest]) ||
          !isDeepStrictEqual(inspection.control.outputRefs, [digest]) ||
          digest === commandInputHash({ failureCode: 'effect_failed' }) ||
          inspection.control.fingerprint !==
            commandInputHash({
              child: original.control.fingerprint,
              result: digest,
            }) ||
          (original.state === 'completed' &&
            !isDeepStrictEqual(original.control.outputRefs, [digest]))
        )
          return false;
        return isDeepStrictEqual(
          readExecutionJournalInvocation(workspace, inspection.ref).carriage,
          original.carriage
        );
      });
    if (receipts.length === 1) return 'result-consumed';
  }
  if (
    original.state === 'unknown' &&
    original.control.outputRefs.length === 0 &&
    expired &&
    target.ready &&
    target.freshEmpty &&
    target.predecessorFenced &&
    target.targetId === session.runtimeTargetId &&
    target.deploymentId === session.deploymentId &&
    target.physicalEpoch &&
    target.physicalEpoch !== session.originPhysicalEpoch
  )
    return 'origin-ended';
  if (original.state === 'unknown' && originalPlacement) return 'unknown-hold';
}

/** Checks exact resource exclusivity independently of whether the original attempt can submit. */
export function hasExclusiveNanoHostCleanupOnly(
  sqlite: Database.Database,
  session: WorkerBackendSessionRecord
): boolean {
  return (
    !sqlite
      .prepare(`SELECT 1 FROM worker_backend_sessions WHERE attempt_id<>?
    AND state NOT IN ('physical-cleaned','cleaned') AND
    (sandbox_binding_ref=? OR agent_session_id=? OR backend_session_id=?) LIMIT 1`)
      .get(
        session.attemptId,
        session.sandboxBindingRef,
        session.agentSessionId,
        session.backendSessionId
      ) &&
    !sqlite
      .prepare(`SELECT 1 FROM agent_session_runtime_bindings
      WHERE agent_session_id=? AND lifecycle_state IN ('open','opening','active') LIMIT 1`)
      .get(session.agentSessionId)
  );
}

/** The cleanup-only command uses the same Native row and fixed physical transport. */
export type CleanupOnlyNanoHostMutation =
  | { readonly kind: 'claim'; readonly occurrence: NanoHostCleanupOccurrence }
  | { readonly kind: 'failed' }
  | { readonly kind: 'result'; readonly result: NanoHostClaimedCleanupResult }
  | { readonly kind: 'image'; readonly decision: NonNullable<CleanupOnlyRecovery['imageDecision']> }
  | { readonly kind: 'finish' };

/** Extends the existing classification write to the unused, non-submitted anchor. */
export function applyNanoHostCleanupOnlyMutation(
  sqlite: Database.Database,
  attempt: SchedulerExecutionAttemptRecord,
  mutation: CleanupOnlyNanoHostMutation,
  target: NanoHostRuntimeTargetRecord,
  observedAt: string,
  readyBindingProof?: string
): WorkerBackendSessionRecord {
  assertControlProductWriter(sqlite);
  const current = readNanoHostCleanupOnly(sqlite, attempt);
  if (
    !current ||
    (readyBindingProof
      ? Boolean(current.proof && current.proof.readyBindingProof !== readyBindingProof)
      : Boolean(current.proof?.readyBindingProof) ||
        !hasExclusiveNanoHostCleanupOnly(sqlite, current.session)) ||
    !isDeepStrictEqual(getNanoHostRuntimeTarget({ sqlite }, target.targetId), target) ||
    current.session.runtimeTargetId !== target.targetId ||
    current.session.deploymentId !== target.deploymentId ||
    !target.ready ||
    !target.freshEmpty ||
    !target.predecessorFenced ||
    !target.physicalEpoch
  )
    throw new Error('Unused NanoHost cleanup placement changed.');
  const { session, proof } = current;
  const owner = { sqlite };
  const key = { attemptId: attempt.attemptId, now: () => clock.parse(observedAt) };
  const write = (value: CleanupOnlyRecovery) => {
    sqlite
      .prepare('UPDATE worker_backend_sessions SET worker_recovery_json=? WHERE attempt_id=?')
      .run(canonicalJsonText(value), attempt.attemptId);
  };
  if (mutation.kind === 'image') {
    if (
      attempt.deadline !== null ||
      attempt.phase !== 'closing' ||
      !attempt.operationId ||
      proof ||
      session.state !== 'materializing' ||
      session.workspaceHandoffState !== 'pending' ||
      sqlite
        .prepare('SELECT 1 FROM sandbox_runtime_records WHERE sandbox_binding_ref=?')
        .get(session.sandboxBindingRef) ||
      sqlite
        .prepare('SELECT 1 FROM worker_storage_bindings WHERE current_agent_session_id=?')
        .get(session.agentSessionId)
    )
      throw new Error('Image preparation still has a possible Worker effect.');
    transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: 'materializing',
      toState: 'cleanup-pending',
    });
    const settled = transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: 'cleanup-pending',
      toState: 'physical-cleaned',
    });
    write({
      kind: 'cleanup-only',
      version: 1,
      occurrence: null,
      imageDecision: mutation.decision,
      physicalCleanup: {
        connectionGeneration: target.connectionGeneration,
        physicalEpoch: target.physicalEpoch,
        observedAt,
      },
    });
    return settled;
  }
  if (mutation.kind === 'claim') {
    if (
      proof ||
      !['materializing', 'materialized'].includes(session.state) ||
      session.workspaceHandoffState !== (readyBindingProof ? 'complete' : 'pending') ||
      !isDeepStrictEqual(
        prepareNanoHostCleanupOccurrence(session, target, mutation.occurrence.firstOperation),
        mutation.occurrence
      )
    )
      throw new Error('Unused NanoHost cleanup has no first dispatch right.');
    const pending = transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: session.state,
      toState: 'cleanup-pending',
    });
    write({
      kind: 'cleanup-only',
      version: 1,
      occurrence: mutation.occurrence,
      ...(readyBindingProof ? { readyBindingProof } : {}),
    });
    return pending;
  }
  if (mutation.kind === 'failed') {
    if (!proof || session.state !== 'cleanup-pending')
      throw new Error('Unused NanoHost claim changed.');
    return transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: 'cleanup-pending',
      toState: 'cleanup-failed',
    });
  }
  if (mutation.kind === 'finish') {
    if (!proof?.physicalCleanup || session.state !== 'physical-cleaned')
      throw new Error('Unused NanoHost anchor has no original cleanup receipt.');
    if (session.workspaceHandoffState === 'pending')
      markWorkerBackendWorkspaceHandoffComplete(owner, key);
    return transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
    });
  }
  const { result } = mutation;
  const absent =
    result.kind === 'fenced-absence' &&
    result.originPhysicalEpoch === session.originPhysicalEpoch &&
    target.physicalEpoch !== session.originPhysicalEpoch &&
    (!proof?.occurrence ||
      (target.identityId === proof.occurrence.identityId &&
        target.connectionGeneration > proof.occurrence.connectionGeneration));
  const deleted =
    result.kind === 'deleted' &&
    proof?.occurrence &&
    result.requestId === proof.occurrence.deleteRequestId &&
    proof.occurrence.targetId === target.targetId &&
    proof.occurrence.identityId === target.identityId &&
    proof.occurrence.deploymentId === target.deploymentId &&
    target.connectionGeneration >= proof.occurrence.connectionGeneration &&
    proof.occurrence.physicalEpoch === session.originPhysicalEpoch &&
    target.physicalEpoch === session.originPhysicalEpoch;
  if (
    !['cleanup-failed', 'cleanup-pending'].includes(session.state) ||
    proof?.physicalCleanup ||
    (!absent && !deleted)
  )
    throw new Error('Unused NanoHost claim has no original result.');
  if (session.state === 'cleanup-failed')
    transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: 'cleanup-failed',
      toState: 'cleanup-pending',
    });
  const physical = transitionWorkerBackendSessionState(owner, {
    ...key,
    fromState: 'cleanup-pending',
    toState: 'physical-cleaned',
  });
  write({
    kind: 'cleanup-only',
    version: 1,
    occurrence: proof?.occurrence ?? null,
    ...(readyBindingProof ? { readyBindingProof } : {}),
    physicalCleanup: {
      connectionGeneration: deleted
        ? proof!.occurrence!.connectionGeneration
        : target.connectionGeneration,
      physicalEpoch: target.physicalEpoch,
      observedAt,
    },
  });
  return physical;
}

export const NanoHostWorkerRecoveryState = z.strictObject({
  version: z.literal(1),
  sessionCompatibilityKey: z.string().nullable(),
  startupDeadline: clock,
  heartbeatTimeoutMs: z.number().int().positive().safe(),
  heartbeatDeadline: clock,
  lastAcceptedHeartbeatAt: clock.nullable(),
  lastWorkerSequence: z.number().int().nonnegative().safe().nullable(),
  workerProcessKeyHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable(),
  recoveryState: z.enum(['awaiting-reconnect', 'needs-evidence']).nullable(),
  recoveryDeadline: clock.nullable(),
  cleanupOccurrence: NanoHostCleanupOccurrenceSchema.optional(),
  cleanupUnknownAt: clock.optional(),
  physicalCleanup: physicalCleanup.optional(),
});
export type NanoHostWorkerRecoveryState = z.output<typeof NanoHostWorkerRecoveryState>;

export type SubmittedNanoHostGrant = Extract<ExecutionGrant, { readonly deadline: string }>;

export interface NanoHostRecoveryLease {
  readonly grant: SubmittedNanoHostGrant;
  readonly attempt: Omit<
    NanoHostExecutionAttemptRecord,
    | keyof NanoHostWorkerRecoveryState
    | 'workerControlTokenHash'
    | 'workerInferenceTokenHash'
    | 'workerCapabilityTokenHash'
  >;
}

/** Reference the admitted writer resolves in the original pinned Workspace. */
export const NanoHostWorkspaceCleanupProofSchema = z.strictObject({
  kind: z.literal('workspace-cleaned'),
  step: z.strictObject({
    execution: z.strictObject({
      owner: z.strictObject({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema }),
      executionId: z.string().min(1),
    }),
    stepId: z.string().min(1),
  }),
  invocationId: z.string().min(1),
});
export type NanoHostWorkspaceCleanupProof = z.output<typeof NanoHostWorkspaceCleanupProofSchema>;

/** Reads only the original inspection in the caller's pinned Workspace snapshot. */
export function matchesNanoHostCleanupInspection(
  db: WorkspaceDb,
  proof: NanoHostWorkspaceCleanupProof,
  session: WorkerBackendSessionRecord,
  state: 'intent' | 'completed'
): boolean {
  if (
    !db.sqlite.readonly ||
    db.workspaceId !== session.workspaceId ||
    proof.step.execution.owner.workspaceId !== session.workspaceId
  )
    return false;
  const inspection = readExecutionJournalInvocation(db, proof.step);
  const { control, carriage } = inspection;
  return (
    inspection.state === state &&
    control.kind === 'inspect-cleanup' &&
    control.definitionVersion === WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION &&
    control.workId === session.turnId &&
    control.attemptId === session.attemptId &&
    control.invocationId === proof.invocationId &&
    carriage.operation === 'worker.inspect-cleanup' &&
    carriage.bindingRef === session.sandboxBindingRef &&
    control.target?.targetId === session.runtimeTargetId &&
    control.target.backendKind === session.backendKind &&
    control.target.allocationRef === session.sandboxBindingRef &&
    isDeepStrictEqual(control.inputRefs, [session.turnId, session.packageSnapshotId]) &&
    isDeepStrictEqual(control.outputRefs, state === 'completed' ? [session.backendSessionId] : [])
  );
}

/** Readers on the pinned peer openings held through a first Native receipt write. */
export interface NanoHostCleanupProofReaders {
  readonly readIdleDelete?: (
    session: WorkerBackendSessionRecord
  ) => Extract<NanoHostClaimedCleanupResult, { kind: 'idle-deleted' }> | null;
  readonly verifyWorkspaceCleanup?: (
    proof: NanoHostWorkspaceCleanupProof,
    session: WorkerBackendSessionRecord,
    target: NanoHostRuntimeTargetRecord
  ) => boolean;
}

export type NanoHostRecoveryMutation = {
  readonly lease: NanoHostRecoveryLease;
  readonly expectedSession: WorkerBackendSessionRecord;
  readonly expectedRecovery: NanoHostWorkerRecoveryState;
  readonly observedAt: string;
} & (
  | { readonly kind: 'arm-reconnect'; readonly classifiedAt: string }
  | { readonly kind: 'needs-evidence'; readonly failedReadOnlyRestore?: true | undefined }
  | {
      readonly kind: 'transition';
      readonly toState: 'cleanup-pending' | 'cleanup-failed' | 'physical-cleaned';
      readonly target: NanoHostRuntimeTargetRecord;
      /** First claim pins the occurrence. Settlement carries positive evidence from that owner. */
      readonly cleanupOccurrence?: NanoHostCleanupOccurrence | undefined;
      readonly cleanupUnknownRequestId?: string | undefined;
      readonly cleanupResult?:
        | NanoHostClaimedCleanupResult
        | NanoHostWorkspaceCleanupProof
        | undefined;
    }
  | { readonly kind: 'finish-cleanup' }
  | { readonly kind: 'retire-orphan' }
  | { readonly kind: 'workspace-handoff' }
);

/** Identifies a definite recovery authority refusal with a fixed, safe diagnostic. */
export class NanoHostRecoveryRefusal extends Error {
  constructor(readonly reason: 'missing-lease' | 'reconnect-authority' | 'image-outcome-unknown') {
    super(
      {
        'missing-lease': 'NanoHost recovery has no original native lease.',
        'reconnect-authority': 'NanoHost heartbeat has no exact reconnect authority.',
        'image-outcome-unknown': 'NanoHost original image outcome needs evidence.',
      }[reason]
    );
  }
}

export function readNanoHostRecoveryLease(sqlite: Database.Database, lease: NanoHostRecoveryLease) {
  const { grant, attempt } = lease;
  if (
    grant.attemptId !== attempt.attemptId ||
    grant.turnId !== attempt.turnId ||
    grant.operationId !== attempt.operationId ||
    grant.inputRef !== attempt.inputRef ||
    grant.bindingRef !== attempt.bindingRef ||
    grant.deadline !== attempt.deadline ||
    grant.backendId !== attempt.backendId
  )
    throw new Error('NanoHost recovery grant does not cover the original attempt.');
  const native = readNanoHostWorkerLease({ sqlite }, grant, attempt);
  if (!native) throw new NanoHostRecoveryRefusal('missing-lease');
  const json = sqlite
    .prepare('SELECT worker_recovery_json FROM worker_backend_sessions WHERE attempt_id = ?')
    .pluck()
    .get(attempt.attemptId);
  if (typeof json !== 'string')
    throw new Error('NanoHost recovery has no original liveness proof.');
  const proof = NanoHostWorkerRecoveryState.parse(JSON.parse(json));
  if (canonicalJsonText(proof) !== json) throw new Error('NanoHost recovery proof is invalid.');
  const {
    version: _version,
    physicalCleanup: _physicalCleanup,
    cleanupUnknownAt: _cleanupUnknownAt,
    cleanupOccurrence: _cleanupOccurrence,
    ...liveness
  } = proof;
  return {
    session: native.session,
    proof,
    attempt: {
      ...attempt,
      ...liveness,
      workerControlTokenHash: native.binding.control,
      workerInferenceTokenHash: native.binding.inference,
      workerCapabilityTokenHash: native.binding.capability,
    } satisfies NanoHostExecutionAttemptRecord,
  };
}

/** Derives the original commands and pin before posting the Native claim. */
export function prepareNanoHostCleanupOccurrence(
  session: WorkerBackendSessionRecord,
  target: NanoHostRuntimeTargetRecord,
  firstOperation: NanoHostCleanupOccurrence['firstOperation']
): NanoHostCleanupOccurrence {
  const { attemptId } = session;
  const input = {
    attemptId,
    sandboxId: nanoHostSandboxIdFromBackendSessionId(session.backendSessionId),
  };
  return NanoHostCleanupOccurrenceSchema.parse({
    targetId: target.targetId,
    identityId: target.identityId,
    deploymentId: target.deploymentId,
    connectionGeneration: target.connectionGeneration,
    physicalEpoch: target.physicalEpoch,
    firstOperation,
    firstRequestId: createNanoHostEffectRequest(session, attemptId, firstOperation, input)
      .requestId,
    deleteRequestId: createNanoHostEffectRequest(session, attemptId, 'sandbox.delete', input)
      .requestId,
  });
}

/** Consumes the verified original Core submission and the redacted queued turn.start. */
export function applyNanoHostWorkerSubmission(
  sqlite: Database.Database,
  input: {
    readonly lease: NanoHostRecoveryLease;
    readonly placement: NanoHostSubmissionPlacement;
    readonly command: Parameters<typeof bindNanoHostWorkerRoutes>[3];
    readonly observedAt: string;
    readonly sessionCompatibilityKey?: string;
  }
): WorkerBackendSessionRecord {
  assertControlProductWriter(sqlite);
  const { lease, placement } = input;
  const observedAt = clock.parse(input.observedAt);
  const startupDeadline = nanoHostStartupDeadline(lease.attempt);
  if (
    lease.attempt.phase !== 'open' ||
    observedAt < lease.attempt.createdAt ||
    observedAt >= startupDeadline ||
    observedAt >= lease.grant.deadline ||
    placement.workspaceId !== lease.attempt.workspaceId ||
    placement.threadId !== lease.attempt.threadId ||
    placement.agentSessionId !== lease.attempt.agentSessionId
  )
    throw new Error('NanoHost submission has no current original startup authority.');
  // A caught Native refusal may never leave launch, route hashes or liveness partially published.
  return sqlite.transaction(() => {
    const owner = { sqlite };
    const session = getWorkerBackendSession(owner, lease.grant.attemptId);
    if (session?.state !== 'launching') {
      if (!readNanoHostSubmissionPlacement(owner, lease.grant, placement))
        throw new Error('NanoHost submission placement changed.');
      transitionWorkerBackendSessionState(owner, {
        attemptId: lease.grant.attemptId,
        fromState: 'materialized',
        toState: 'launching',
        now: () => observedAt,
      });
    }
    bindNanoHostWorkerRoutes(owner, lease.grant, placement, input.command);
    initializeNanoHostRecoveryLease(sqlite, lease, {
      version: 1,
      sessionCompatibilityKey: input.sessionCompatibilityKey ?? null,
      startupDeadline,
      heartbeatTimeoutMs: NANO_HOST_HEARTBEAT_BUDGET_MS,
      heartbeatDeadline: startupDeadline,
      lastAcceptedHeartbeatAt: null,
      lastWorkerSequence: null,
      workerProcessKeyHash: null,
      recoveryState: null,
      recoveryDeadline: null,
    });
    return readNanoHostRecoveryLease(sqlite, lease).session;
  })();
}

/** Compares the original submit coordinate with the coordinate of the physical result. */
function includesOriginalCleanupGeneration(
  lease: NanoHostRecoveryLease,
  session: WorkerBackendSessionRecord,
  coordinate: { readonly connectionGeneration: number; readonly physicalEpoch: string }
): boolean {
  const generation = Number(lease.grant.generation);
  return (
    Number.isSafeInteger(generation) &&
    generation >= 1 &&
    String(generation) === lease.grant.generation &&
    (generation < coordinate.connectionGeneration ||
      (generation === coordinate.connectionGeneration &&
        coordinate.physicalEpoch === session.originPhysicalEpoch))
  );
}

/** Checks the receipt between the original grant and the admitted target, including equal endpoints. */
function includesCleanupPlacement(
  lease: NanoHostRecoveryLease,
  session: WorkerBackendSessionRecord,
  receipt: z.output<typeof physicalCleanup>,
  target: NanoHostRuntimeTargetRecord
): boolean {
  return (
    includesOriginalCleanupGeneration(lease, session, receipt) &&
    (receipt.connectionGeneration < target.connectionGeneration ||
      (receipt.connectionGeneration === target.connectionGeneration &&
        receipt.physicalEpoch === target.physicalEpoch))
  );
}

/** Checks the non-submitted anchor's original cleanup receipt against the current fenced placement. */
export function verifyNanoHostPreparationCleanupPlacement(
  lease: NanoHostRecoveryLease,
  session: WorkerBackendSessionRecord,
  receipt: z.output<typeof physicalCleanup>,
  target: NanoHostRuntimeTargetRecord
): boolean {
  return (
    session.state === 'cleaned' &&
    session.workspaceHandoffState === 'complete' &&
    receipt.observedAt === session.physicalCleanedAt &&
    target.targetId === session.runtimeTargetId &&
    target.deploymentId === session.deploymentId &&
    target.ready &&
    target.freshEmpty &&
    target.predecessorFenced &&
    target.physicalEpoch !== null &&
    /^[a-f0-9]{64}$/.test(target.physicalEpoch) &&
    includesCleanupPlacement(lease, session, receipt, target)
  );
}

/** Reads the original receipt under the current target pin. Historical carriage also needs the Core submit proof. */
export function readNanoHostPhysicalCleanupReceipt(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  expectedTarget: NanoHostRuntimeTargetRecord,
  verifyOriginalPlacement?: (session: WorkerBackendSessionRecord) => boolean
) {
  const { session, proof, attempt } = readNanoHostRecoveryLease(sqlite, lease);
  const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
  const receipt = proof.physicalCleanup;
  if (
    attempt.phase === 'open' ||
    (session.state !== 'physical-cleaned' && session.state !== 'cleaned') ||
    !receipt ||
    receipt.observedAt !== session.physicalCleanedAt ||
    !target?.ready ||
    !target.freshEmpty ||
    !target.predecessorFenced ||
    !target.physicalEpoch ||
    !/^[a-f0-9]{64}$/.test(target.physicalEpoch) ||
    target.deploymentId !== session.deploymentId ||
    !isDeepStrictEqual(target, expectedTarget)
  )
    return null;
  if (
    !includesCleanupPlacement(lease, session, receipt, target) ||
    (verifyOriginalPlacement
      ? !verifyOriginalPlacement(session)
      : receipt.connectionGeneration !== target.connectionGeneration)
  )
    return null;
  return {
    grant: lease.grant,
    session,
    target,
    cleanup: receipt,
    occurrence: proof.cleanupOccurrence ?? null,
    observedAt: receipt.observedAt,
  };
}

/** Type of the independent Native readback. Cleanup and current target coordinates can differ. */
export type NanoHostPhysicalCleanupReceipt = NonNullable<
  ReturnType<typeof readNanoHostPhysicalCleanupReceipt>
>;

/** The original Core attempt coordinates and Native occurrence consumed by the orphan Audit. */
export function readNanoHostOrphanCleanup(
  sqlite: Database.Database,
  input: Pick<NanoHostRecoveryMutation, 'lease' | 'expectedSession' | 'expectedRecovery'>,
  observationHash: string,
  verifyOriginalPlacement: (session: WorkerBackendSessionRecord) => boolean
): Omit<ControlNanoHostOrphanRetirementInput, 'observedAt'> | null {
  const { lease, expectedSession, expectedRecovery } = input;
  const { session, proof, attempt } = readNanoHostRecoveryLease(sqlite, lease);
  const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
  if (
    attempt.phase !== 'closed' ||
    session.state !== 'physical-cleaned' ||
    session.workspaceHandoffState !== 'complete' ||
    !isDeepStrictEqual(session, expectedSession) ||
    !isDeepStrictEqual(proof, expectedRecovery) ||
    !target
  )
    return null;
  const receipt = readNanoHostPhysicalCleanupReceipt(
    sqlite,
    lease,
    target,
    verifyOriginalPlacement
  );
  if (!receipt) return null;
  return {
    attemptId: attempt.attemptId,
    inputRef: session.packageSnapshotId,
    bindingRef: session.sandboxBindingRef,
    backendSessionId: session.backendSessionId,
    target: {
      targetId: target.targetId,
      identityId: target.identityId,
      deploymentId: target.deploymentId,
      connectionGeneration: receipt.cleanup.connectionGeneration,
      physicalEpoch: receipt.cleanup.physicalEpoch,
    },
    observationHash,
    physicalCleanedAt: receipt.observedAt,
  };
}

/** The original Core Audit acknowledgement authorizes the dependent Native CAS. */
export interface NanoHostOrphanAuditAcknowledgement {
  readonly auditEventId: string;
  readonly requestId: string;
  readonly acceptedAt: string;
}

/** Revalidates the original Audit and physical tuple inside the Native writer's deciding hold. */
export function applyNanoHostAuditedOrphanRetirement(
  sqlite: Database.Database,
  input: Extract<NanoHostRecoveryMutation, { kind: 'retire-orphan' }>,
  expected: NanoHostOrphanAuditAcknowledgement,
  observationHash: string,
  verifyOriginalPlacement: (session: WorkerBackendSessionRecord) => boolean,
  inspectAudit: (
    cleanup: NonNullable<ReturnType<typeof readNanoHostOrphanCleanup>>
  ) => NanoHostOrphanAuditAcknowledgement | null
): WorkerBackendSessionRecord {
  assertControlProductWriter(sqlite);
  const cleanup = readNanoHostOrphanCleanup(
    sqlite,
    input,
    observationHash,
    verifyOriginalPlacement
  );
  if (
    !cleanup ||
    input.observedAt !== expected.acceptedAt ||
    !isDeepStrictEqual(inspectAudit(cleanup), expected)
  )
    throw new Error('NanoHost retirement has no matching original orphan Audit acknowledgement.');
  return transitionWorkerBackendSessionState(
    { sqlite },
    {
      attemptId: input.lease.grant.attemptId,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
      now: () => clock.parse(input.observedAt),
    }
  );
}

/** Proves the original Integration is drained and the exact historical route grant is revoked. */
export function verifyNanoHostTerminalDrainAndRevocation(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  recoveryFenceRef?: string
): boolean {
  const { attempt, grant } = lease;
  const fenceRef = recoveryFenceRef ?? attempt.fenceRef;
  if (
    attempt.phase === 'open' ||
    (recoveryFenceRef === undefined && attempt.phase !== 'closed') ||
    attempt.disposition !== 'accepted' ||
    !fenceRef ||
    (attempt.fenceRef !== null && attempt.fenceRef !== fenceRef) ||
    (attempt.phase === 'closed' && attempt.fenceRef !== fenceRef) ||
    attempt.attemptId !== grant.attemptId ||
    attempt.turnId !== grant.turnId ||
    attempt.backendId !== grant.backendId ||
    attempt.operationId !== grant.operationId ||
    attempt.inputRef !== grant.inputRef ||
    attempt.bindingRef !== grant.bindingRef ||
    attempt.deadline !== grant.deadline
  )
    return false;
  const native = readNanoHostWorkerLease({ sqlite }, grant, attempt);
  if (
    !native ||
    native.session.state !== 'cleaned' ||
    native.session.workspaceHandoffState !== 'complete' ||
    !native.session.physicalCleanedAt ||
    fenceRef !== `worker-backend:${attempt.attemptId}:${native.session.physicalCleanedAt}`
  )
    return false;

  // Historical route hashes remain evidence. Live route authorization requires the current open
  // Core phase and launching Native placement, both revoked for this exact retained tuple.
  if (
    sqlite
      .prepare(`SELECT 1 FROM agent_session_runtime_bindings
        WHERE current_attempt_id = ? OR current_turn_id = ? LIMIT 1`)
      .get(attempt.attemptId, attempt.turnId) ||
    sqlite
      .prepare(`SELECT 1 FROM harness_instance_records WHERE harness_instance_id = ?
        AND operation_id = ? AND operation_state IN ('queued', 'dispatched', 'unknown')`)
      .get(native.binding.harnessInstanceId, native.binding.harnessOperationId)
  )
    return false;
  const resident = sqlite
    .prepare(`SELECT b.schema_version AS bindingVersion, h.schema_version AS harnessVersion,
      (b.workspace_id = @workspaceId AND b.thread_id = @threadId AND
       b.harness_instance_id = @harnessInstanceId AND
       b.current_turn_id IS NULL AND b.current_attempt_id IS NULL AND
       b.lifecycle_state IN ('open', 'closed') AND b.cleanup_state = 'clean' AND
       h.lifecycle_state = 'open' AND h.drain_state = 'accepting' AND
       s.runtime_target_id = @targetId AND s.origin_physical_epoch = @physicalEpoch AND
       s.lifecycle_state = 'open' AND s.health_state = 'ready' AND
       s.drain_state = 'accepting' AND s.cleanup_state = 'clean') AS clean
      FROM agent_session_runtime_bindings b
      LEFT JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
      LEFT JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
      WHERE b.agent_session_id = @agentSessionId`)
    .get({
      workspaceId: attempt.workspaceId,
      threadId: attempt.threadId,
      agentSessionId: attempt.agentSessionId,
      harnessInstanceId: native.binding.harnessInstanceId,
      targetId: native.session.runtimeTargetId,
      physicalEpoch: native.session.originPhysicalEpoch,
    }) as { bindingVersion: unknown; harnessVersion: unknown; clean: number | null } | undefined;
  if (!resident) return true;
  if (resident.clean !== 1) return false;
  return readRetainedV1({ schemaVersion: resident.bindingVersion }, () =>
    readRetainedV1({ schemaVersion: resident.harnessVersion }, () => true)
  );
}

/** The lifecycle writer supplies the first liveness tuple with the original granted route binding.
 * An exact repeat may inspect the retained tuple. It cannot reset an accepted heartbeat or window.
 */
export function initializeNanoHostRecoveryLease(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  liveness: NanoHostWorkerRecoveryState
): void {
  assertControlProductWriter(sqlite);
  const native = readNanoHostWorkerLease({ sqlite }, lease.grant, lease.attempt);
  const state = NanoHostWorkerRecoveryState.parse(liveness);
  if (
    !native ||
    native.session.state !== 'launching' ||
    lease.attempt.phase !== 'open' ||
    state.recoveryState !== null ||
    state.recoveryDeadline !== null ||
    state.lastAcceptedHeartbeatAt !== null ||
    state.lastWorkerSequence !== null ||
    state.workerProcessKeyHash !== null ||
    state.physicalCleanup !== undefined ||
    state.cleanupOccurrence !== undefined ||
    state.heartbeatDeadline !== state.startupDeadline
  )
    throw new Error('NanoHost recovery initialization lacks its first granted placement.');
  const json = canonicalJsonText(state);
  const written = sqlite
    .prepare(`UPDATE worker_backend_sessions SET worker_recovery_json = ?
    WHERE attempt_id = ? AND worker_recovery_json IS NULL`)
    .run(json, lease.grant.attemptId);
  if (
    written.changes === 0 &&
    !isDeepStrictEqual(readNanoHostRecoveryLease(sqlite, lease).proof, state)
  )
    throw new Error('NanoHost recovery initialization already advanced.');
}

/** Applies a recovery decision against the exact Core observation and current Native proof. */
export function applyNanoHostRecoveryMutation(
  sqlite: Database.Database,
  input: NanoHostRecoveryMutation,
  verifyOriginalPlacement?: (session: WorkerBackendSessionRecord) => boolean,
  cleanupReaders?: NanoHostCleanupProofReaders
): WorkerBackendSessionRecord {
  assertControlProductWriter(sqlite);
  const observedAt = clock.parse(input.observedAt);
  const { session, proof, attempt } = readNanoHostRecoveryLease(sqlite, input.lease);
  if (
    !isDeepStrictEqual(session, input.expectedSession) ||
    !isDeepStrictEqual(proof, input.expectedRecovery)
  )
    throw new Error('NanoHost recovery ownership changed.');
  const owner = { sqlite };
  const key = { attemptId: session.attemptId, now: () => observedAt };
  if (input.kind === 'retire-orphan')
    throw new Error('NanoHost orphan retirement requires the original Core Audit decision.');
  if (input.kind === 'finish-cleanup') {
    if (attempt.phase !== 'closing' || session.state !== 'physical-cleaned')
      throw new Error('NanoHost recovery has no completed physical cleanup.');
    if (session.workspaceHandoffState !== 'complete')
      throw new Error('NanoHost recovery Workspace handoff is incomplete.');
    const target = getNanoHostRuntimeTarget(owner, session.runtimeTargetId);
    if (
      !target ||
      !readNanoHostPhysicalCleanupReceipt(sqlite, input.lease, target, verifyOriginalPlacement)
    )
      throw new Error('NanoHost recovery physical cleanup receipt is unavailable.');
    return transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
    });
  }
  if (input.kind === 'transition') {
    const target = getNanoHostRuntimeTarget(owner, session.runtimeTargetId);
    if (
      !target ||
      !isDeepStrictEqual(target, input.target) ||
      !target.ready ||
      !target.freshEmpty ||
      !target.predecessorFenced ||
      !target.physicalEpoch ||
      !/^[a-f0-9]{64}$/.test(target.physicalEpoch) ||
      target.deploymentId !== session.deploymentId ||
      attempt.phase === 'open' ||
      !includesOriginalCleanupGeneration(input.lease, session, {
        connectionGeneration: target.connectionGeneration,
        physicalEpoch: target.physicalEpoch,
      })
    )
      throw new Error('NanoHost recovery placement changed.');
    const occurrence = input.cleanupOccurrence;
    if (
      occurrence &&
      (input.toState !== 'cleanup-pending' ||
        proof.cleanupOccurrence !== undefined ||
        !verifyOriginalPlacement?.(session) ||
        !isDeepStrictEqual(
          prepareNanoHostCleanupOccurrence(session, target, occurrence.firstOperation),
          occurrence
        ))
    )
      throw new Error('NanoHost recovery cleanup occurrence conflicts with its target.');
    // Boot can restore either outstanding claim state. An unknown result records only its clock.
    if (input.cleanupUnknownRequestId !== undefined) {
      const original = proof.cleanupOccurrence;
      if (
        input.toState !== 'cleanup-pending' ||
        (session.state !== 'cleanup-pending' && session.state !== 'cleanup-failed') ||
        occurrence ||
        input.cleanupResult ||
        proof.physicalCleanup ||
        !original ||
        input.cleanupUnknownRequestId !== original.deleteRequestId ||
        observedAt < target.observedAt ||
        !verifyOriginalPlacement?.(session) ||
        !isDeepStrictEqual(
          prepareNanoHostCleanupOccurrence(session, target, original.firstOperation),
          original
        )
      )
        throw new Error('NanoHost unknown cleanup observation conflicts with its original claim.');
      if (proof.cleanupUnknownAt) return session;
      if (observedAt < session.updatedAt)
        throw new Error('NanoHost unknown cleanup observation predates its original claim.');
      return sqlite.transaction(() => {
        const updated = sqlite
          .prepare(
            'UPDATE worker_backend_sessions SET updated_at=? WHERE attempt_id=? AND state=? AND updated_at=?'
          )
          .run(observedAt, session.attemptId, session.state, session.updatedAt);
        if (updated.changes !== 1)
          throw new Error('NanoHost unknown cleanup claim changed before acknowledgement.');
        writeRecovery(sqlite, session, proof, { ...proof, cleanupUnknownAt: observedAt });
        return { ...session, updatedAt: observedAt };
      })();
    }
    if (input.toState === 'physical-cleaned') {
      const original = proof.cleanupOccurrence;
      const result = input.cleanupResult;
      const sameTarget =
        !original ||
        (target.identityId === original.identityId &&
          target.connectionGeneration >= original.connectionGeneration);
      let proved = false;
      switch (result?.kind) {
        case 'deleted':
          proved =
            !!original &&
            result.requestId === original.deleteRequestId &&
            target.physicalEpoch === session.originPhysicalEpoch &&
            isDeepStrictEqual(
              prepareNanoHostCleanupOccurrence(session, target, original.firstOperation),
              original
            );
          break;
        case 'idle-deleted':
          proved =
            attempt.phase === 'closed' &&
            sameTarget &&
            (!original || result.requestId === original.deleteRequestId) &&
            target.physicalEpoch === session.originPhysicalEpoch &&
            result.observedAt === observedAt &&
            isDeepStrictEqual(cleanupReaders?.readIdleDelete?.(session), result);
          break;
        case 'fenced-absence':
          proved =
            sameTarget &&
            result.originPhysicalEpoch === session.originPhysicalEpoch &&
            target.physicalEpoch !== result.originPhysicalEpoch &&
            (!proof.cleanupUnknownAt || target.observedAt > proof.cleanupUnknownAt);
          break;
        case 'workspace-cleaned':
          proved =
            attempt.phase === 'closing' &&
            sameTarget &&
            cleanupReaders?.verifyWorkspaceCleanup?.(result, session, target) === true;
          break;
      }
      if (!proved || !verifyOriginalPlacement?.(session))
        throw new Error('NanoHost recovery cleanup has no exact original physical result.');
    }
    return sqlite.transaction(() => {
      const recovered =
        input.toState === 'physical-cleaned' &&
        input.cleanupResult &&
        session.state === 'cleanup-failed';
      if (recovered)
        transitionWorkerBackendSessionState(owner, {
          ...key,
          fromState: 'cleanup-failed',
          toState: 'cleanup-pending',
        });
      const changed = transitionWorkerBackendSessionState(owner, {
        ...key,
        fromState: recovered ? 'cleanup-pending' : session.state,
        toState: input.toState,
      });
      if (occurrence)
        writeRecovery(sqlite, session, proof, { ...proof, cleanupOccurrence: occurrence });
      if (input.toState === 'physical-cleaned') {
        writeRecovery(sqlite, session, proof, {
          ...proof,
          physicalCleanup: {
            observedAt,
            connectionGeneration: target.connectionGeneration,
            physicalEpoch: target.physicalEpoch!,
          },
        });
      }
      return changed;
    })();
  }
  if (input.kind === 'workspace-handoff') {
    if (attempt.phase === 'open' || !session.physicalCleanedAt)
      throw new Error('NanoHost recovery handoff has no physical result.');
    return markWorkerBackendWorkspaceHandoffComplete(owner, key);
  }
  if (input.kind === 'needs-evidence') {
    // Boot can fence reconnect while Core still owns the open attempt and its exclusion.
    const expectedPhase = input.failedReadOnlyRestore ? 'open' : 'closing';
    if (
      attempt.phase !== expectedPhase ||
      (input.failedReadOnlyRestore &&
        (session.state !== 'launching' || session.workspaceHandoffState !== 'complete'))
    )
      throw new Error('NanoHost evidence hold does not match the observed attempt.');
    writeRecovery(sqlite, session, proof, { ...proof, recoveryState: 'needs-evidence' });
    return session;
  }
  if (input.kind !== 'arm-reconnect') throw new Error('Unknown NanoHost recovery stage.');
  const classifiedAt = clock.parse(input.classifiedAt);
  const recoveryDeadline =
    proof.recoveryDeadline ??
    new Date(
      Math.min(Date.parse(input.lease.grant.deadline), Date.parse(classifiedAt) + 300_000)
    ).toISOString();
  if (
    attempt.phase !== 'open' ||
    session.state !== 'launching' ||
    session.workspaceHandoffState !== 'complete' ||
    proof.lastWorkerSequence === null ||
    proof.lastWorkerSequence < 1 ||
    proof.workerProcessKeyHash === null ||
    proof.recoveryState === 'needs-evidence' ||
    recoveryDeadline > input.lease.grant.deadline ||
    recoveryDeadline <= observedAt
  )
    throw new Error('NanoHost reconnect authority changed.');
  writeRecovery(sqlite, session, proof, {
    ...proof,
    recoveryState: 'awaiting-reconnect',
    recoveryDeadline,
  });
  return session;
}

/** Called inside the accepted Native heartbeat transaction after its original sequence decision. */
export function recordNanoHostRecoveryHeartbeat(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  input: {
    readonly sequence: number;
    readonly acceptedAt: string;
    readonly processKeyHash?: string;
    readonly reconnectProcessKeyHash?: string;
  }
): void {
  assertControlProductWriter(sqlite);
  const { attempt, proof, session } = readNanoHostRecoveryLease(sqlite, lease);
  const acceptedAt = clock.parse(input.acceptedAt);
  if (
    attempt.phase !== 'open' ||
    session.state !== 'launching' ||
    acceptedAt >= lease.grant.deadline ||
    (proof.lastAcceptedHeartbeatAt !== null && acceptedAt < proof.lastAcceptedHeartbeatAt) ||
    (proof.lastWorkerSequence !== null && input.sequence <= proof.lastWorkerSequence) ||
    (input.processKeyHash !== undefined &&
      (input.sequence !== 0 || proof.workerProcessKeyHash !== null))
  )
    throw new Error('NanoHost heartbeat liveness changed.');

  if (proof.recoveryState === 'awaiting-reconnect') {
    const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
    const presented = Buffer.from(input.reconnectProcessKeyHash ?? '');
    const retained = Buffer.from(proof.workerProcessKeyHash ?? '');
    if (
      !proof.recoveryDeadline ||
      proof.recoveryDeadline <= acceptedAt ||
      proof.lastWorkerSequence === null ||
      input.sequence !== proof.lastWorkerSequence + 1 ||
      presented.length !== 43 ||
      retained.length !== 43 ||
      !timingSafeEqual(presented, retained) ||
      session.workspaceHandoffState !== 'complete' ||
      !target ||
      !target.ready ||
      !target.freshEmpty ||
      !target.predecessorFenced ||
      target.deploymentId !== session.deploymentId ||
      target.physicalEpoch !== session.originPhysicalEpoch
    )
      throw new NanoHostRecoveryRefusal('reconnect-authority');
  } else if (
    proof.recoveryState !== null ||
    input.reconnectProcessKeyHash !== undefined ||
    acceptedAt >= proof.heartbeatDeadline
  ) {
    throw new Error('NanoHost heartbeat liveness changed.');
  }

  writeRecovery(
    sqlite,
    session,
    proof,
    NanoHostWorkerRecoveryState.parse({
      ...proof,
      heartbeatDeadline: new Date(Date.parse(acceptedAt) + proof.heartbeatTimeoutMs).toISOString(),
      lastAcceptedHeartbeatAt: acceptedAt,
      lastWorkerSequence: input.sequence,
      workerProcessKeyHash: input.processKeyHash ?? proof.workerProcessKeyHash,
      recoveryState: null,
      recoveryDeadline: null,
    })
  );
}

function writeRecovery(
  sqlite: Database.Database,
  session: WorkerBackendSessionRecord,
  expected: NanoHostWorkerRecoveryState,
  next: NanoHostWorkerRecoveryState
) {
  const changed = sqlite
    .prepare(`UPDATE worker_backend_sessions SET worker_recovery_json = ?
    WHERE attempt_id = ? AND worker_recovery_json = ?`)
    .run(canonicalJsonText(next), session.attemptId, canonicalJsonText(expected));
  if (changed.changes !== 1) throw new Error('NanoHost recovery liveness changed.');
}
