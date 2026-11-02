import { isDeepStrictEqual } from 'node:util';
import { abandonCoreImageJournal, settleCoreIdleJournal } from '../runtime/core-journal-records.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import {
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  decodeExecutionJournalIntent,
  encodeExecutionJournalValue,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import { nonClosedSandboxAttempts } from '../runtime/idle-cleanup-records.js';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import { type ControlCoreJournalInput, CoreJournalRefusal } from './core-journal-codecs.js';
import type { CoreDb } from './db.js';

/** Decides one original Core journal tuple against current rows inside its savepoint and FULL commit. */
export function applyControlCoreJournal(db: CoreDb, input: ControlCoreJournalInput): string | null {
  assertControlProductWriter(db.sqlite);
  if (input.kind === 'image-abandon') {
    abandonCoreImageJournal(db, input.ref, input.accepted);
    return null;
  }
  const intent = decodeExecutionJournalIntent(input.intentJson);
  if (intent.execution.ref.owner.kind !== 'server')
    throw new CoreJournalRefusal('Core journal owner conflicts.');
  if (input.kind === 'idle-settle') {
    if (intent.execution.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION)
      throw new CoreJournalRefusal(
        'Core idle cleanup result does not match its admitted invocation.'
      );
    settleCoreIdleJournal(db, intent, input.state, input.resultFingerprint, input.processWitness);
    return null;
  }
  if (input.kind === 'image-intent') {
    const target = getNanoHostRuntimeTarget(db, input.target.targetId);
    const binding = `nanohost-target/v1:${input.target.deploymentId}:${input.target.targetId}:${input.target.connectionGeneration}:${input.target.physicalEpoch}`;
    if (
      !target ||
      !target.predecessorFenced ||
      !target.ready ||
      !target.freshEmpty ||
      target.identityId !== input.target.identityId ||
      target.deploymentId !== input.target.deploymentId ||
      target.connectionGeneration !== input.target.connectionGeneration ||
      target.physicalEpoch !== input.target.physicalEpoch ||
      intent.execution.definitionVersion !== CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION ||
      intent.control.kind !== 'resolve-setup' ||
      intent.carriage.operation !== 'image.acquire' ||
      intent.carriage.bindingRef !== binding ||
      intent.control.target?.targetId !== target.targetId
    )
      throw new CoreJournalRefusal('Image execution provenance is unavailable.');
    if (
      db.sqlite
        .prepare(`SELECT 1 FROM control_execution_steps WHERE json_extract(invocation_json, '$.carriage.operation') = 'image.acquire'
      AND json_extract(invocation_json, '$.carriage.requestId') = ? AND json_extract(control_json, '$.kind') = 'resolve-setup' LIMIT 1`)
        .get(intent.carriage.requestId)
    )
      throw new CoreJournalRefusal(
        'Image intent already exists; only result reconciliation is permitted.'
      );
    return encodeExecutionJournalValue(
      writeExecutionJournalIntent(db, intent, input.processWitness)
    );
  }
  const attempt = requireSchedulerExecutionAttempt(db, input.attemptId);
  const anchor = getWorkerBackendSession(db, input.attemptId);
  const target = getNanoHostRuntimeTarget(db, input.identity.runtimeTargetId);
  const identity = anchor && {
    agentSessionId: anchor.agentSessionId,
    backendKind: 'openshell',
    backendSessionId: anchor.backendSessionId,
    deploymentId: anchor.deploymentId,
    packageSnapshotId: anchor.packageSnapshotId,
    runtimeTargetId: anchor.runtimeTargetId,
    stagingDirectoryRef: anchor.stagingDirectoryRef,
    transientProviderInstanceId: anchor.transientProviderInstanceId,
  };
  if (
    attempt.phase !== 'closed' ||
    !attempt.fenceRef ||
    !anchor ||
    !isDeepStrictEqual(identity, input.identity) ||
    anchor.workspaceId !== attempt.workspaceId ||
    anchor.threadId !== attempt.threadId ||
    anchor.turnId !== attempt.turnId ||
    anchor.agentSessionId !== attempt.agentSessionId ||
    anchor.packageSnapshotId !== attempt.inputRef ||
    anchor.sandboxBindingRef !== attempt.bindingRef ||
    anchor.originPhysicalEpoch !== input.originPhysicalEpoch ||
    !target?.predecessorFenced ||
    !target.ready ||
    !target.freshEmpty ||
    target.physicalEpoch !== input.originPhysicalEpoch ||
    !/^[0-9a-f]{64}$/.test(input.originPhysicalEpoch)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup has no exact closed resident provenance or current Epoch.'
    );
  const admission = requireSchedulerExecutionAttemptAdmissionContext(db, input.attemptId);
  if (
    input.package.workspaceId !== anchor.workspaceId ||
    input.package.threadId !== anchor.threadId ||
    input.package.turnId !== anchor.turnId ||
    input.package.agentSessionId !== anchor.agentSessionId ||
    input.package.snapshotId !== anchor.packageSnapshotId ||
    !isDeepStrictEqual(input.package.triggerActor, admission.triggerActor) ||
    !isDeepStrictEqual(intent.control.actor, admission.triggerActor)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup immutable package actor or physical lineage conflicts.'
    );
  const sandbox = db.sqlite
    .prepare(`SELECT sandbox_runtime_id AS id, origin_physical_epoch AS origin,
    runtime_target_id AS targetId, drain_state AS drainState FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?`)
    .get(input.sandboxBindingRef) as
    | { id: string; origin: string; targetId: string; drainState: string }
    | undefined;
  if (!sandbox)
    throw new CoreJournalRefusal('Core idle cleanup requires a positive resident binding.');
  if (
    sandbox.origin !== input.originPhysicalEpoch ||
    sandbox.targetId !== input.identity.runtimeTargetId ||
    (input.sandboxId !== undefined &&
      input.sandboxId !== nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId)) ||
    (['bridge.close', 'sandbox.delete'].includes(intent.carriage.operation) &&
      sandbox.drainState !== 'draining') ||
    nonClosedSandboxAttempts(
      db,
      input.backendId,
      { scope: input.package, snapshotId: input.package.snapshotId },
      input.identity.runtimeTargetId,
      input.originPhysicalEpoch,
      nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId)
    ).length !== 0 ||
    db.sqlite
      .prepare(`SELECT 1 FROM harness_instance_records WHERE sandbox_runtime_id = ?
      AND (active_turn_count <> 0 OR operation_state IN ('queued', 'dispatched')) LIMIT 1`)
      .get(sandbox.id)
  )
    throw new CoreJournalRefusal('Core idle cleanup resident is stale or has live work.');
  if (
    intent.execution.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION ||
    !['bridge.close', 'sandbox.delete', 'workspace.collect', 'file.export'].includes(
      intent.carriage.operation
    ) ||
    intent.carriage.bindingRef !== input.sandboxBindingRef ||
    intent.control.attemptId !== input.attemptId ||
    intent.control.target?.allocationRef !== input.sandboxBindingRef ||
    intent.control.target?.targetId !== input.identity.runtimeTargetId ||
    intent.control.deadlineUnixNano === null ||
    intent.control.deadlineUnixNano <= BigInt(Date.now()) * 1_000_000n
  )
    throw new CoreJournalRefusal('Core idle cleanup resident is stale or has live work.');
  if (
    db.sqlite
      .prepare('SELECT 1 FROM control_executions WHERE id = ?')
      .get(intent.execution.ref.executionId)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup key already exists; inspect retained result only.',
      'idle_cleanup_result_only'
    );
  if (input.predecessor) {
    const prior = db.sqlite
      .prepare('SELECT revision FROM control_executions WHERE id = ?')
      .get(input.predecessor.ref.execution.executionId) as { revision: number } | undefined;
    if (prior?.revision !== input.predecessor.revision)
      throw new CoreJournalRefusal('Idle cleanup predecessor changed before delete admission.');
  }
  return encodeExecutionJournalValue(writeExecutionJournalIntent(db, intent, input.processWitness));
}
