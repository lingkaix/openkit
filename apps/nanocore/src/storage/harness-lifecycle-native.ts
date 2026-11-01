import { readRetainedV1 } from '@openkit/protocol';
import {
  nanoHostSandboxId,
  readNanoHostWorkspaceCaptureAnchors,
} from '../runtime/nanohost-capture-anchors.js';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import * as records from '../runtime/nanohost-harness-records.js';
import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-read.js';
import { presentControlFacts } from './control-store-input.js';
import {
  assertControlProductWriter,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import type { CoreDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import {
  type ControlHarnessLifecycleInput,
  HarnessLifecycleRefusal,
  RetainedRuntimeEnvCheckVersionSchema,
} from './harness-lifecycle-codecs.js';

/** Applies one complete existing Harness tuple inside its native transition savepoint and covering FULL commit. */
export function applyControlHarnessLifecycle(db: CoreDb, input: ControlHarnessLifecycleInput) {
  assertControlProductWriter(db.sqlite);
  try {
    switch (input.kind) {
      case 'runtime.create':
        records.createNanoHostHarnessRuntime(db, presentControlFacts(input));
        return null;
      case 'sandbox.remove-for-harness':
        records.removeNanoHostSandboxRuntimeForHarness(db, input.harnessInstanceId);
        return null;
      case 'sandbox.remove-by-binding':
        records.removeNanoHostSandboxRuntimeByBinding(db, input.sandboxBindingRef);
        return null;
      case 'harness.drain':
        records.drainNanoHostHarnessAdmission(db, input);
        return null;
      case 'sandbox.claim-idle-drain':
        claimIdleSandboxDrain(db, input);
        return null;
      case 'harness.claim-idle-capture-drain':
        claimIdleCaptureDrain(db, input);
        return null;
      case 'session-binding.initialize-check-versions':
      case 'session-binding.append-check-version':
        publishRuntimeCheckVersion(db, input);
        return null;
      case 'sandbox.restore-admission':
        restoreSandboxAdmission(db, input.sandboxRuntimeId);
        return null;
      case 'sandbox.drain':
        records.drainNanoHostSandboxAdmission(db, input);
        return null;
      case 'sandbox.fence':
        records.fenceNanoHostSandboxRuntime(db, presentControlFacts(input));
        return null;
      case 'session-binding.open':
        records.openNanoHostAgentSessionBinding(db, presentControlFacts(input));
        return null;
      case 'measured-identity.copy':
        records.copyNanoHostMeasuredHarnessIdentity(db, input);
        return null;
      case 'operation.queue':
        return records.queueNanoHostHarnessOperation(db, input);
      case 'operation.dispatch':
        return records.dispatchNanoHostHarnessOperation(db, {
          sandboxIntegrationBindingRef: input.sandboxIntegrationBindingRef,
          ...(input.observedAt === undefined ? {} : { now: () => input.observedAt! }),
        });
      case 'operation.expire':
        records.expireNanoHostHarnessQueuedOperation(db, input);
        return null;
      case 'operation.settle':
        return records.settleNanoHostHarnessOperation(db, input);
      case 'operation.unknown':
        records.markNanoHostHarnessOperationUnknown(db, input);
        return null;
      case 'result.acknowledge':
        records.acknowledgeNanoHostHarnessResult(db, input);
        return null;
    }
  } catch (error) {
    // Preserve domain messages and the existing capacity facts, never SQL text or bound values.
    if (error instanceof Error && !('code' in error)) {
      const capacity =
        'reasonCode' in error &&
        error.reasonCode === 'busy' &&
        'exhaustedBound' in error &&
        error.exhaustedBound === 'sandbox.activeTurns';
      throw new HarnessLifecycleRefusal(
        error.message,
        capacity ? 'sandbox.activeTurns' : undefined
      );
    }
    throw error;
  }
}

/** Restores the exact two-table admission tuple while its current Core proof remains inside the native savepoint. */
function restoreSandboxAdmission(coreDb: CoreDb, sandboxRuntimeId: string): void {
  const sandbox = coreDb.sqlite
    .prepare(
      'SELECT sandbox_binding_ref AS binding FROM sandbox_runtime_records WHERE sandbox_runtime_id=?'
    )
    .get(sandboxRuntimeId) as { binding: string } | undefined;
  if (!sandbox) return;
  const anchors = readNanoHostWorkspaceCaptureAnchors(coreDb, sandbox.binding);
  const attempts = new Set(anchors.map((anchor) => anchor.attemptId));
  // Capture dispositions are observations, never Workspace writes or a retained Main authorization boolean.
  for (const workspaceId of new Set(anchors.map((anchor) => anchor.workspaceId))) {
    let reader: ReturnType<typeof openControlStoreProductReadHandle> | undefined;
    try {
      reader = openControlStoreProductReadHandle(workspaceDbPath(coreDb.dataRoot, workspaceId), {
        kind: 'workspace',
        workspaceId,
      });
      if (
        listWorkspaceReconciliationRecords(reader, workspaceId).some(
          (record) =>
            record.id.startsWith('wrr_capture_') &&
            attempts.has(String(record.backendHandleSummary.attemptId)) &&
            record.stateAfter !== 'recovered'
        )
      )
        return;
    } catch {
      // Optional restoration fails closed when its anchored Workspace disposition cannot be read.
      return;
    } finally {
      reader?.sqlite.close();
    }
  }
  const restored = coreDb.sqlite
    .prepare(`UPDATE sandbox_runtime_records SET drain_state = 'accepting'
    WHERE sandbox_runtime_id = ? AND lifecycle_state = 'open' AND health_state = 'ready'
      AND cleanup_state = 'clean' AND NOT EXISTS (
        SELECT 1 FROM harness_instance_records WHERE sandbox_runtime_id = ?
          AND (lifecycle_state <> 'open' OR operation_state IN ('queued', 'dispatched', 'unknown'))
      )`)
    .run(sandboxRuntimeId, sandboxRuntimeId);
  if (restored.changes === 1)
    coreDb.sqlite
      .prepare(`UPDATE harness_instance_records
    SET drain_state = 'accepting' WHERE sandbox_runtime_id = ? AND lifecycle_state = 'open'`)
      .run(sandboxRuntimeId);
}

/** Rechecks current physical residency, occupancy and exact handed-off bindings before the original reversible two-table claim. */
function claimIdleSandboxDrain(
  coreDb: CoreDb,
  input: Extract<ControlHarnessLifecycleInput, { kind: 'sandbox.claim-idle-drain' }>
): void {
  function refuse(): never {
    throw new Error('NanoHost idle Sandbox eviction changed before drain claim.');
  }
  const targets = coreDb.sqlite
    .prepare(`SELECT sandbox_runtime_id AS id, sandbox_binding_ref AS binding,
    sandbox_compatibility_key AS compatibility, origin_physical_epoch AS epoch
    FROM sandbox_runtime_records WHERE runtime_target_id=?`)
    .all(input.runtimeTargetId) as Array<{
    id: string;
    binding: string;
    compatibility: string;
    epoch: string;
  }>;
  const sandbox = targets[0];
  const target = coreDb.sqlite
    .prepare(`SELECT predecessor_fenced AS fenced, ready, fresh_empty AS fresh,
    physical_epoch AS epoch FROM nanohost_runtime_targets WHERE target_id=?`)
    .get(input.runtimeTargetId) as
    | { fenced: number; ready: number; fresh: number; epoch: string | null }
    | undefined;
  if (
    targets.length !== 1 ||
    !sandbox ||
    sandbox.id !== input.sandboxRuntimeId ||
    sandbox.binding !== input.sandboxBindingRef ||
    sandbox.compatibility !== input.sandboxCompatibilityKey ||
    sandbox.epoch !== input.originPhysicalEpoch ||
    !target ||
    target.fenced !== 1 ||
    target.ready !== 1 ||
    target.fresh !== 1 ||
    !target.epoch ||
    !/^[0-9a-f]{64}$/.test(target.epoch) ||
    (target.epoch !== sandbox.epoch) !== input.physicalAbsent
  )
    refuse();
  const domainAttempts = coreDb.sqlite
    .prepare(`SELECT w.backend_session_id AS session FROM scheduler_execution_attempts a
    JOIN worker_backend_sessions w ON w.attempt_id=a.attempt_id WHERE a.backend_id=? AND w.runtime_target_id=?
    AND w.origin_physical_epoch=? AND a.phase<>'closed' AND NOT (a.phase='open' AND a.operation_id IS NULL
    AND a.deadline IS NULL AND a.workspace_id=? AND a.thread_id=? AND a.turn_id=? AND a.input_ref=?)`)
    .all(
      input.incoming.backendId,
      input.runtimeTargetId,
      input.originPhysicalEpoch,
      input.incoming.workspaceId,
      input.incoming.threadId,
      input.incoming.turnId,
      input.incoming.packageSnapshotId
    ) as Array<{ session: string }>;
  if (
    domainAttempts.some(
      (row) =>
        nanoHostSandboxIdFromBackendSessionId(row.session) ===
        nanoHostSandboxId(input.sandboxCompatibilityKey)
    )
  )
    refuse();
  if (
    input.physicalAbsent &&
    coreDb.sqlite
      .prepare(
        "SELECT 1 FROM scheduler_execution_attempts WHERE binding_ref=? AND phase<>'closed' LIMIT 1"
      )
      .get(input.sandboxBindingRef)
  )
    refuse();
  const bindings = coreDb.sqlite
    .prepare(`SELECT b.agent_session_id AS agentSessionId,
    b.agent_session_runtime_binding_id AS agentSessionRuntimeBindingId, b.harness_instance_id AS harnessInstanceId,
    h.harness_binding_ref AS harnessBindingRef,h.harness_compatibility_key AS harnessCompatibilityKey,
    b.lifecycle_state AS lifecycleState,b.current_turn_id AS currentTurnId,b.current_attempt_id AS currentAttemptId,
    b.cleanup_state AS cleanupState,b.native_handle_state AS nativeHandleState,b.native_handle_digest AS nativeHandleDigest
    FROM agent_session_runtime_bindings b JOIN harness_instance_records h ON h.harness_instance_id=b.harness_instance_id
    WHERE h.sandbox_runtime_id=?`)
    .all(input.sandboxRuntimeId) as Array<{
    agentSessionId: string;
    agentSessionRuntimeBindingId: string;
    harnessInstanceId: string;
    harnessBindingRef: string;
    harnessCompatibilityKey: string;
    lifecycleState: string;
    currentTurnId: string | null;
    currentAttemptId: string | null;
    cleanupState: string;
    nativeHandleState: string;
    nativeHandleDigest: string | null;
  }>;
  if (
    bindings.length !== input.bindings.length ||
    new Set(input.bindings.map((b) => b.agentSessionRuntimeBindingId)).size !== bindings.length
  )
    refuse();
  for (const binding of bindings) {
    const expected = input.bindings.find(
      (row) => row.agentSessionRuntimeBindingId === binding.agentSessionRuntimeBindingId
    );
    if (
      !expected ||
      expected.agentSessionId !== binding.agentSessionId ||
      expected.harnessInstanceId !== binding.harnessInstanceId ||
      expected.harnessBindingRef !== binding.harnessBindingRef ||
      expected.harnessCompatibilityKey !== binding.harnessCompatibilityKey ||
      expected.lifecycleState !== binding.lifecycleState ||
      expected.nativeHandleDigest !==
        (binding.nativeHandleState === 'ready' ? binding.nativeHandleDigest : null) ||
      binding.currentTurnId !== null ||
      binding.currentAttemptId !== null ||
      (!input.physicalAbsent &&
        binding.lifecycleState !== 'closed' &&
        (binding.lifecycleState !== 'open' || binding.cleanupState !== 'clean'))
    )
      refuse();
    if (
      coreDb.sqlite
        .prepare(`SELECT 1 FROM scheduler_execution_attempts WHERE agent_session_id=? AND phase<>'closed'
      AND NOT (workspace_id=? AND thread_id=? AND turn_id=? AND backend_id=? AND phase='open' AND operation_id IS NULL) LIMIT 1`)
        .get(
          binding.agentSessionId,
          input.incoming.workspaceId,
          input.incoming.threadId,
          input.incoming.turnId,
          input.incoming.backendId
        )
    )
      refuse();
  }
  const harnesses = coreDb.sqlite
    .prepare(`SELECT active_turn_count AS active,operation_state AS operationState,
    lifecycle_state AS lifecycle,drain_state AS drain,
    (lifecycle_state='failed' AND drain_state='draining' AND operation='session.close' AND operation_state='settled'
    AND json_extract(result_json,'$.disposition')='refused' AND json_extract(result_json,'$.body.reasonCode')='cleanup_required'
    AND EXISTS(SELECT 1 FROM agent_session_runtime_bindings b WHERE b.harness_instance_id=harness_instance_records.harness_instance_id
    AND b.agent_session_id=json_extract(command_body_json,'$.agentSessionId')
    AND b.agent_session_runtime_binding_id=json_extract(command_body_json,'$.agentSessionRuntimeBindingId'))) AS cleanup
    FROM harness_instance_records WHERE sandbox_runtime_id=?`)
    .all(input.sandboxRuntimeId) as Array<{
    active: number;
    operationState: string;
    lifecycle: string;
    drain: string;
    cleanup: number | null;
  }>;
  if (
    (!input.physicalAbsent && harnesses.length === 0) ||
    harnesses.some(
      (h) =>
        h.active !== 0 ||
        (!input.physicalAbsent &&
          (!['idle', 'settled'].includes(h.operationState) ||
            ((h.lifecycle !== 'open' || h.drain !== 'accepting') && h.cleanup !== 1)))
    )
  )
    refuse();
  if (
    input.replacementStorage &&
    !coreDb.sqlite
      .prepare('SELECT 1 FROM worker_storage_bindings WHERE storage_ref=? AND revision=?')
      .get(input.replacementStorage.storageRef, input.replacementStorage.revision)
  )
    refuse();
  const absent = Number(input.physicalAbsent);
  const sandboxUpdate = coreDb.sqlite
    .prepare(`UPDATE sandbox_runtime_records SET drain_state='draining',updated_at=?
    WHERE sandbox_runtime_id=? AND (?=1 OR (lifecycle_state='open' AND health_state='ready' AND drain_state='accepting' AND cleanup_state='clean'))`)
    .run(input.timestamp, input.sandboxRuntimeId, absent);
  const harnessUpdate = coreDb.sqlite
    .prepare(`UPDATE harness_instance_records SET drain_state='draining',updated_at=?
    WHERE sandbox_runtime_id=? AND active_turn_count=0 AND (operation_state IN ('idle','settled') OR ?=1)
    AND (?=1 OR (lifecycle_state='open' AND drain_state='accepting') OR (lifecycle_state='failed' AND drain_state='draining'
    AND operation='session.close' AND operation_state='settled' AND json_extract(result_json,'$.disposition')='refused'
    AND json_extract(result_json,'$.body.reasonCode')='cleanup_required'))`)
    .run(input.timestamp, input.sandboxRuntimeId, absent, absent);
  if (sandboxUpdate.changes !== 1 || (!input.physicalAbsent && harnessUpdate.changes < 1)) refuse();
}

/** Retains the original Workspace-first, Core-second idle capture drain with its current healthy physical binding checks. */
function claimIdleCaptureDrain(
  coreDb: CoreDb,
  input: Extract<ControlHarnessLifecycleInput, { kind: 'harness.claim-idle-capture-drain' }>
): void {
  const changed = coreDb.sqlite
    .prepare(`UPDATE harness_instance_records SET drain_state='draining'
    WHERE harness_binding_ref=? AND harness_instance_id=? AND lifecycle_state='open' AND operation_state IN ('idle','settled')
    AND EXISTS (SELECT 1 FROM agent_session_runtime_bindings b JOIN scheduler_execution_attempts a
      ON a.agent_session_id=b.agent_session_id AND a.workspace_id=b.workspace_id AND a.thread_id=b.thread_id
      WHERE b.harness_instance_id=harness_instance_records.harness_instance_id
      AND b.agent_session_runtime_binding_id=? AND b.agent_session_id=?
      AND b.current_attempt_id IS NULL AND b.current_turn_id IS NULL AND a.attempt_id=? AND a.phase='closed')
    AND sandbox_runtime_id IN (SELECT sandbox_runtime_id FROM sandbox_runtime_records
    WHERE sandbox_binding_ref=? AND origin_physical_epoch=? AND lifecycle_state='open' AND health_state='ready' AND cleanup_state='clean')`)
    .run(
      input.harnessBindingRef,
      input.harnessInstanceId,
      input.agentSessionRuntimeBindingId,
      input.agentSessionId,
      input.attemptId,
      input.sandboxBindingRef,
      input.originPhysicalEpoch
    );
  if (changed.changes !== 1) throw new Error('Idle capture drain ownership changed.');
}

/** Retains the two original environment-lineage stages, exact current value and original binding identities inside the native deciding section. */
function publishRuntimeCheckVersion(
  coreDb: CoreDb,
  input: Extract<
    ControlHarnessLifecycleInput,
    { kind: 'session-binding.initialize-check-versions' | 'session-binding.append-check-version' }
  >
): void {
  const row = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion,runtime_env_check_versions_json AS versions
    FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id=? AND harness_instance_id=? AND agent_session_id=?`)
    .get(input.agentSessionRuntimeBindingId, input.harnessInstanceId, input.agentSessionId) as
    | { schemaVersion: unknown; versions: string | null }
    | undefined;
  if (!row || row.versions !== input.expectedVersionsJson)
    throw new Error('Original credential binding lineage is unavailable.');
  readRetainedV1(row, () => row);
  let next: string | null;
  if (input.kind === 'session-binding.initialize-check-versions') {
    next = input.versions === null ? null : JSON.stringify(input.versions);
  } else {
    let versions: unknown;
    try {
      versions = JSON.parse(row.versions!);
      if (!Array.isArray(versions)) throw new Error('Invalid comparison lineage.');
      for (const version of versions) RetainedRuntimeEnvCheckVersionSchema.parse(version);
    } catch {
      throw new Error('Original credential binding lineage is unavailable.');
    }
    if (!Array.isArray(versions))
      throw new Error('Original credential binding lineage is unavailable.');
    versions.push(input.version);
    next = JSON.stringify(versions);
  }
  const changed = coreDb.sqlite
    .prepare(`UPDATE agent_session_runtime_bindings SET runtime_env_check_versions_json=?
    WHERE agent_session_runtime_binding_id=? AND harness_instance_id=? AND agent_session_id=? AND runtime_env_check_versions_json IS ?`)
    .run(
      next,
      input.agentSessionRuntimeBindingId,
      input.harnessInstanceId,
      input.agentSessionId,
      input.expectedVersionsJson
    );
  if (changed.changes !== 1) throw new Error('Credential replacement lineage changed.');
}
