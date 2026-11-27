import { isDeepStrictEqual } from 'node:util';
import { readRetainedV1 } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import {
  agentSessionCompatibilityKeyFromPackage,
  findNamedAgentEnvironmentPackageSnapshot,
} from '../runtime/aep-snapshot-ledger.js';
import {
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
} from '../runtime/execution-attempt-records.js';
import {
  decodeExecutionJournalSpan,
  inspectKernelExecutionEvidence,
  readExecutionJournalInvocation,
  readExecutionJournalLinkedInspections,
  readExecutionJournalRoot,
  WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
} from '../runtime/execution-journal.js';
import type { ExecutionJournalSettlement } from '../runtime/execution-step-journal.js';
import { nanoHostSandboxId } from '../runtime/nanohost-capture-anchors.js';
import {
  nanoHostHarnessCompatibilityKey,
  nanoHostSandboxCompatibilityKey,
} from '../runtime/nanohost-compatibility.js';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import { deriveNanoHostAgentSessionCompatibilityKey } from '../runtime/nanohost-harness-records.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import { getWorkerStorageBindingForSandbox } from '../runtime/worker-storage-binding-records.js';
import { readProduct } from './control-store-product-records.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import {
  readNanoHostCleanupOnly,
  verifyNanoHostTerminalDrainAndRevocation,
} from './nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from './nanohost-submitted-lease.js';
import { storageRequestId } from './storage-owner.js';
import { AgentSessionRecordSchema } from './workspace-file-records.js';
import { requireCompleteBackendWorkspaceHandleHandoff } from './workspace-handoff-read.js';

/** Reads the one Workspace journal for the original Turn without projecting a new obligation. */
function readPreparationJournal(workspace: WorkspaceDb, attempt: SchedulerExecutionAttemptRecord) {
  const roots = workspace.sqlite
    .prepare('SELECT id FROM control_executions WHERE work_id=? LIMIT 2')
    .all(attempt.turnId) as Array<{ id: string }>;
  if (roots.length !== 1) return;
  const execution = {
    owner: { kind: 'workspace' as const, workspaceId: workspace.workspaceId },
    executionId: roots[0]!.id,
  };
  const root = readExecutionJournalRoot(workspace, execution);
  if (root.definitionVersion !== WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION) return;
  const steps = (
    workspace.sqlite
      .prepare('SELECT step_id AS stepId FROM control_execution_steps WHERE execution_id=?')
      .all(execution.executionId) as Array<{ stepId: string }>
  ).map(({ stepId }) => readExecutionJournalInvocation(workspace, { execution, stepId }));
  const releases = steps.filter((step) => step.carriage.operation === 'worker.release');
  const materializations = steps.filter((step) => step.carriage.operation === 'worker.materialize');
  if (
    releases.length !== 1 ||
    materializations.length !== 1 ||
    steps.some(
      (step) =>
        step.control.attemptId !== attempt.attemptId || step.control.workId !== attempt.turnId
    )
  )
    return;
  const release = releases[0]!;
  const materialize = materializations[0]!;
  if (
    release.control.kind !== 'release' ||
    materialize.control.kind !== 'materialize' ||
    [release, materialize].some(
      (step) =>
        step.carriage.bindingRef !== attempt.bindingRef ||
        step.control.target?.allocationRef !== attempt.bindingRef ||
        !isDeepStrictEqual(step.control.inputRefs, [attempt.turnId, attempt.inputRef])
    )
  )
    return;
  return { root, steps, release, materialize };
}

/** A completed read-only invocation needs its acknowledged original result consumption. */
function hasPreparationInspectionReceipt(
  workspace: WorkspaceDb,
  step: ReturnType<typeof readExecutionJournalInvocation>
) {
  if (step.state !== 'completed' || step.control.outputRefs.length !== 1) return false;
  const linked = readExecutionJournalLinkedInspections(workspace, step.ref);
  return (
    linked.length === 1 &&
    linked.some(
      ({ inspection }) =>
        inspection.state === 'completed' &&
        inspection.control.kind === 'consume-receipt' &&
        inspection.control.operationId === step.control.operationId &&
        isDeepStrictEqual(inspection.control.outputRefs, step.control.outputRefs)
    )
  );
}

/** Rechecks both effect owners before the admitted Workspace writer cancels the unused release. */
export function readUntouchedNanoHostPreparation(
  core: CoreDb,
  native: Database.Database,
  workspace: WorkspaceDb,
  input: { readonly attemptId: string; readonly turnId: string }
): ExecutionJournalSettlement | 'cancelled' | undefined {
  const attempt = requireSchedulerExecutionAttempt(core, input.attemptId);
  if (
    attempt.workspaceId !== workspace.workspaceId ||
    attempt.turnId !== input.turnId ||
    attempt.backendId !== 'nanohost' ||
    attempt.phase !== 'closed' ||
    attempt.disposition !== 'not_accepted' ||
    attempt.terminalCause !== 'turn-start-failed' ||
    attempt.operationId !== null ||
    attempt.deadline !== null ||
    attempt.fenceRef !== null ||
    !attempt.inputRef ||
    !attempt.bindingRef ||
    core.sqlite.prepare('SELECT 1 FROM control_executions WHERE id=?').get(attempt.attemptId)
  )
    return;
  const original = readNanoHostCleanupOnly(native, attempt);
  if (
    !original ||
    original.proof ||
    original.session.state !== 'materialized' ||
    original.session.workspaceHandoffState !== 'complete' ||
    original.session.physicalCleanedAt !== null
  )
    return;
  const { session } = original;
  const journal = readPreparationJournal(workspace, attempt);
  if (
    !journal ||
    journal.materialize.state !== 'completed' ||
    !isDeepStrictEqual(journal.materialize.control.outputRefs, [session.backendSessionId]) ||
    journal.release.control.operationId !== null ||
    journal.release.control.physicalFenceRefs.length ||
    journal.release.control.outputRefs.length
  )
    return;

  const pkg = findNamedAgentEnvironmentPackageSnapshot(
    workspace,
    attempt.workspaceId,
    session.agentSessionId,
    session.packageSnapshotId
  )?.snapshot;
  if (
    !pkg ||
    pkg.scope.turnId !== attempt.turnId ||
    pkg.scope.threadId !== attempt.threadId ||
    pkg.scope.agentSessionId !== session.agentSessionId ||
    pkg.backend.preferred !== session.backendKind
  )
    return;
  // All other invocations must either publish the planned terminal outcome or be acknowledged reads.
  const reads = journal.steps.filter(
    (step) =>
      step.control.kind === 'validate-setup' &&
      ['image.inspect', 'storage.inspect'].includes(step.carriage.operation)
  );
  if (
    reads.some((step) => !hasPreparationInspectionReceipt(workspace, step)) ||
    journal.steps.some(
      (step) =>
        step !== journal.materialize &&
        step !== journal.release &&
        !(
          step.control.kind === 'terminal-publication' &&
          step.carriage.operation === 'worker.terminal-publication' &&
          ['intent', 'completed'].includes(step.state)
        ) &&
        !reads.includes(step) &&
        !(
          step.control.kind === 'consume-receipt' &&
          reads.some((read) =>
            readExecutionJournalLinkedInspections(workspace, read.ref).some(({ inspection }) =>
              isDeepStrictEqual(inspection.ref, step.ref)
            )
          )
        )
    )
  )
    return;
  requireCompleteBackendWorkspaceHandleHandoff(workspace, pkg, {
    backendKind: session.backendKind,
    backendVersion: session.backendVersion,
    workerSessionId: session.backendSessionId,
  });
  // An acknowledged cancellation is the original obligation's durable readback.
  if (journal.release.state === 'cancelled') return 'cancelled';
  if (journal.release.state !== 'intent') return;

  const resident = native
    .prepare(`SELECT b.schema_version AS bindingVersion,
      h.schema_version AS harnessVersion,
      b.native_handle_digest AS digest, b.agent_session_compatibility_key AS agentKey,
      h.harness_compatibility_key AS harnessKey, h.harness_binding_ref AS harnessBindingRef,
      s.sandbox_binding_ref AS bindingRef, s.sandbox_compatibility_key AS sandboxKey
    FROM agent_session_runtime_bindings b
    JOIN harness_instance_records h ON h.harness_instance_id=b.harness_instance_id
    JOIN sandbox_runtime_records s ON s.sandbox_runtime_id=h.sandbox_runtime_id
    WHERE b.agent_session_id=? AND b.workspace_id=? AND b.thread_id=?
      AND b.lifecycle_state='open' AND b.cleanup_state='clean' AND b.native_handle_state='ready'
      AND s.image_digest=b.image_digest
      AND b.current_attempt_id IS NULL AND b.current_turn_id IS NULL
      AND h.active_turn_count=0 AND h.lifecycle_state='open' AND h.drain_state='accepting'
      AND h.operation_state IN ('idle','settled')
      AND s.lifecycle_state='open' AND s.health_state='ready' AND s.cleanup_state='clean'
      AND s.drain_state='accepting' AND s.runtime_target_id=? AND s.origin_physical_epoch=?`)
    .get(
      session.agentSessionId,
      session.workspaceId,
      session.threadId,
      session.runtimeTargetId,
      session.originPhysicalEpoch
    ) as
    | {
        bindingVersion: unknown;
        harnessVersion: unknown;
        digest: string;
        agentKey: string;
        harnessKey: string;
        sandboxKey: string;
        bindingRef: string;
        harnessBindingRef: string;
      }
    | undefined;
  const target = getNanoHostRuntimeTarget({ sqlite: native }, session.runtimeTargetId);
  if (
    !resident ||
    !target?.ready ||
    !target.predecessorFenced ||
    target.deploymentId !== session.deploymentId ||
    target.physicalEpoch !== session.originPhysicalEpoch ||
    resident.bindingRef === attempt.bindingRef ||
    resident.agentKey !==
      deriveNanoHostAgentSessionCompatibilityKey({
        adapterId: pkg.control.adapter.targetRuntime,
        adapterVersion: pkg.agent.runtimeVersion,
        harnessCompatibilityKey: resident.harnessKey,
        sessionCompatibilityKey: agentSessionCompatibilityKeyFromPackage(pkg),
        threadId: pkg.scope.threadId,
      }) ||
    resident.harnessKey !== nanoHostHarnessCompatibilityKey(pkg) ||
    resident.sandboxKey !== nanoHostSandboxCompatibilityKey(pkg) ||
    nanoHostSandboxIdFromBackendSessionId(session.backendSessionId) !==
      nanoHostSandboxId(resident.sandboxKey) ||
    native
      .prepare(`SELECT 1 FROM sandbox_runtime_records WHERE sandbox_binding_ref=?
        UNION ALL SELECT 1 FROM worker_storage_bindings WHERE current_sandbox_binding_ref=? LIMIT 1`)
      .get(attempt.bindingRef, attempt.bindingRef)
  )
    return;
  for (const schemaVersion of [resident.bindingVersion, resident.harnessVersion])
    readRetainedV1({ schemaVersion }, () => undefined);
  if (
    core.sqlite
      .prepare(`SELECT 1 FROM scheduler_execution_attempts WHERE attempt_id<>?
      AND phase<>'closed' AND (agent_session_id=? OR binding_ref IN (?,?)) LIMIT 1`)
      .get(attempt.attemptId, session.agentSessionId, resident.bindingRef, attempt.bindingRef)
  )
    return;

  const previous = core.sqlite
    .prepare(`SELECT attempt_id AS id FROM scheduler_execution_attempts
      WHERE attempt_id<>? AND workspace_id=? AND thread_id=? AND agent_session_id=?
        AND phase='closed' AND disposition='accepted'
      ORDER BY rowid DESC LIMIT 1`)
    .get(attempt.attemptId, session.workspaceId, session.threadId, session.agentSessionId) as
    | { id: string }
    | undefined;
  const lease = previous && readRetainedNanoHostSubmission(core, previous.id)?.lease;
  const predecessor = lease && getWorkerBackendSession({ sqlite: native }, lease.grant.attemptId);
  if (
    !lease ||
    !predecessor ||
    predecessor.state !== 'cleaned' ||
    predecessor.runtimeTargetId !== session.runtimeTargetId ||
    predecessor.deploymentId !== session.deploymentId ||
    predecessor.originPhysicalEpoch !== session.originPhysicalEpoch ||
    nanoHostSandboxIdFromBackendSessionId(predecessor.backendSessionId) !==
      nanoHostSandboxId(resident.sandboxKey) ||
    !lease.attempt.fenceRef ||
    !verifyNanoHostTerminalDrainAndRevocation(native, lease)
  )
    return;
  const releaseId = 'worker-terminal-release';
  if (
    !core.sqlite
      .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
      .get(lease.grant.execution.executionId, releaseId)
  )
    return;
  const fenceStepId = storageRequestId({
    deploymentId: predecessor.deploymentId,
    sourceOwner: 'nanohost',
    verb: 'apply-execution-proof',
    occurrenceKey: `worker-terminal-release:${lease.grant.operationId}:fence`,
  });
  if (
    !core.sqlite
      .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
      .get(lease.grant.execution.executionId, fenceStepId)
  )
    return;
  const fence = readExecutionJournalInvocation(core, {
    execution: lease.grant.execution,
    stepId: fenceStepId,
  });
  const fenceEvidence = fence.carriage.kernelEvidence;
  if (
    fence.state !== 'completed' ||
    fenceEvidence?.kind !== 'fence' ||
    !isDeepStrictEqual(fenceEvidence.intent.target, lease.grant) ||
    fenceEvidence.proof.fence.ref !== lease.attempt.fenceRef ||
    inspectKernelExecutionEvidence(core, fenceEvidence.intent, false).state !== 'settled'
  )
    return;
  const released = readExecutionJournalInvocation(core, {
    execution: lease.grant.execution,
    stepId: releaseId,
  });
  const releasedRoot = readExecutionJournalRoot(core, lease.grant.execution);
  const previousJournal = readPreparationJournal(workspace, lease.attempt);
  if (
    releasedRoot.phase !== 'closed' ||
    releasedRoot.exclusionRefs.length !== 0 ||
    released.state !== 'completed' ||
    released.control.kind !== 'release' ||
    released.control.attemptId !== lease.grant.attemptId ||
    released.control.operationId !== lease.grant.operationId ||
    released.carriage.bindingRef !== lease.grant.bindingRef ||
    previousJournal?.release.state !== 'completed' ||
    !isDeepStrictEqual(previousJournal.release.control.outputRefs, [lease.attempt.fenceRef]) ||
    !previousJournal.steps.some(
      (step) =>
        step.carriage.operation === 'turn.start' &&
        step.control.kind === 'deliver-start' &&
        step.carriage.bindingRef === resident.harnessBindingRef &&
        hasPreparationInspectionReceipt(workspace, step)
    )
  )
    return;

  const owner = { kind: 'workspace' as const, workspaceId: workspace.workspaceId };
  const row = readProduct(workspace.sqlite, owner, 'agent-session', session.agentSessionId);
  const product = row && AgentSessionRecordSchema.parse(row.record);
  const storage = getWorkerStorageBindingForSandbox(
    { sqlite: native },
    { sandboxBindingRef: resident.bindingRef }
  );
  const retained = product?.retainedStorage;
  const workSlot = (
    pkg.extensions.openkit as { workerStorage?: { workSlotRef?: string } } | undefined
  )?.workerStorage?.workSlotRef;
  if (
    !product ||
    product.workspaceId !== session.workspaceId ||
    product.threadId !== session.threadId ||
    product.nativeHandleDigest !== resident.digest ||
    !storage ||
    !retained?.attachmentGeneration ||
    !workSlot ||
    retained.workSlotRef !== workSlot ||
    storage.currentWorkSlotRef !== workSlot ||
    storage.state !== 'attached' ||
    storage.workspaceId !== session.workspaceId ||
    storage.runtimeTargetId !== session.runtimeTargetId ||
    storage.deploymentId !== session.deploymentId ||
    storage.currentAgentSessionId !== session.agentSessionId ||
    storage.currentThreadId !== session.threadId ||
    storage.storageRef !== retained.storageRef ||
    storage.attachmentGeneration !== retained.attachmentGeneration ||
    !storage.contributors.some(
      (entry) =>
        entry.workspaceId === session.workspaceId &&
        entry.threadId === session.threadId &&
        entry.workSlotRef === workSlot
    )
  )
    return;

  // The physical allocator's immutable request pins the original attachment generation.
  const allocated = native
    .prepare(`SELECT attempt_id AS id FROM worker_backend_sessions
    WHERE sandbox_binding_ref=? AND origin_physical_epoch=? AND runtime_target_id=? LIMIT 2`)
    .all(resident.bindingRef, session.originPhysicalEpoch, session.runtimeTargetId) as Array<{
    id: string;
  }>;
  if (allocated.length !== 1) return;
  const allocation = requireSchedulerExecutionAttempt(core, allocated[0]!.id);
  const allocationJournal = readPreparationJournal(workspace, allocation);
  if (
    !allocationJournal?.steps.some(
      (step) =>
        step.carriage.operation === 'sandbox.create' &&
        step.control.kind === 'materialize' &&
        step.carriage.bindingRef === resident.bindingRef &&
        step.control.inputRefs.length === 7 &&
        isDeepStrictEqual(step.control.inputRefs.slice(0, 5), [
          allocation.turnId,
          allocation.inputRef,
          retained.storageRef,
          String(retained.attachmentGeneration),
          target.identityId,
        ]) &&
        step.control.inputRefs[6] === session.originPhysicalEpoch &&
        hasPreparationInspectionReceipt(workspace, step)
    )
  )
    return;

  const span = workspace.sqlite
    .prepare('SELECT span_json FROM control_execution_steps WHERE execution_id=? AND step_id=?')
    .pluck()
    .get(journal.release.ref.execution.executionId, journal.release.ref.stepId);
  if (typeof span !== 'string') return;
  const canClose = journal.root.openSteps.every(
    (open) => open.stepId === journal.release.ref.stepId
  );
  const start = decodeExecutionJournalSpan(JSON.parse(span));
  const end = BigInt(Date.now()) * 1_000_000n;
  return {
    ref: journal.release.ref,
    expectedExecutionRevision: journal.root.revision,
    state: 'cancelled',
    outputRefs: [],
    span: {
      ...start,
      endTimeUnixNano: end > start.startTimeUnixNano ? end : start.startTimeUnixNano,
      status: { code: 'ERROR' },
    },
    nextPhase: canClose ? 'closed' : journal.root.phase,
    terminalCause: journal.root.terminalCause,
    exclusionRefs: canClose ? [] : journal.root.exclusionRefs,
  };
}
