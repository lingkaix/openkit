import { readRetainedV1 } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { nonClosedSandboxAttempts } from '../runtime/idle-cleanup-records.js';
import {
  nanoHostSandboxId,
  readNanoHostWorkspaceCaptureAnchors,
} from '../runtime/nanohost-capture-anchors.js';
import type { NanoHostIdleSandboxAuthority } from '../runtime/nanohost-harness.js';
import * as records from '../runtime/nanohost-harness-records.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-read.js';
import { presentControlFacts } from './control-store-input.js';
import {
  ControlProductPreconditionError,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import {
  type ControlHarnessLifecycleInput,
  ControlHarnessLifecycleInputSchema,
  HarnessLifecycleRefusal,
} from './harness-lifecycle-codecs.js';

/** Applies a Harness tuple on the admitted owner. Mixed decisions require the Core binding. */
export function applyControlHarnessLifecycle(
  owner: CoreDb | { readonly scope?: never; readonly sqlite: Database.Database },
  input: ControlHarnessLifecycleInput,
  admitted?: { readonly coreDb: CoreDb; readonly idleSandbox?: NanoHostIdleSandboxAuthority }
) {
  assertControlProductWriter(owner.sqlite);
  if (
    owner.scope === 'core' &&
    !owner.sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_instance_records'")
      .get()
  )
    throw new ControlProductPreconditionError();
  try {
    switch (input.kind) {
      case 'sandbox.claim-idle-drain':
      case 'sandbox.restore-admission': {
        if (owner.scope === 'core' || !admitted?.idleSandbox) break;
        const authority = admitted.idleSandbox;
        return owner.sqlite.transaction(() => {
          const target = getNanoHostRuntimeTarget(owner, authority.target.targetId);
          if (
            !target?.ready ||
            !target.predecessorFenced ||
            !target.freshEmpty ||
            target.identityId !== authority.target.identityId ||
            target.deploymentId !== authority.target.deploymentId ||
            target.connectionGeneration !== authority.target.connectionGeneration ||
            target.physicalEpoch !== authority.target.physicalEpoch
          ) {
            if (input.kind === 'sandbox.restore-admission') return null;
            throw new Error('NanoHost idle Sandbox eviction changed before drain claim.');
          }
          if (input.kind === 'sandbox.claim-idle-drain') {
            if (input.runtimeTargetId !== target.targetId)
              throw new Error('NanoHost idle Sandbox eviction changed before drain claim.');
            claimIdleSandboxDrain(admitted.coreDb, input, owner);
          } else if (authority.rollback) {
            // Neither Harness arm carries Sandbox rollback authority: a mixed frame restores nothing.
            if (input.harness) return null;
            restoreSandboxAdmission(admitted.coreDb, input.sandboxRuntimeId, owner, authority);
          } else {
            restoreHarnessAdmissionAfterLocalClose(admitted.coreDb, input, owner, authority);
          }
          return null;
        })();
      }
      case 'harness.claim-idle-capture-drain':
        if (owner.scope === 'core' || !admitted) break;
        owner.sqlite.transaction(() => claimIdleCaptureDrain(admitted.coreDb, input, owner))();
        return null;
      case 'operation.queue':
        if (admitted)
          // A replacement close compares its selection and queues in one deciding commit.
          return owner.sqlite.transaction(() =>
            records.queueNanoHostHarnessOperation(admitted.coreDb, input, owner)
          )();
        break;
      case 'operation.dispatch':
        if (admitted)
          return owner.sqlite.transaction(() =>
            records.dispatchNanoHostHarnessOperation(
              admitted.coreDb,
              {
                sandboxIntegrationBindingRef: input.sandboxIntegrationBindingRef,
                ...(input.observedAt === undefined ? {} : { now: () => input.observedAt! }),
              },
              { owner }
            )
          )();
        break;
      case 'operation.settle':
        if (admitted) return records.settleNanoHostHarnessOperation(admitted.coreDb, input, owner);
        break;
      case 'runtime.create':
        records.createNanoHostHarnessRuntime(owner, presentControlFacts(input));
        return null;
      case 'sandbox.remove-for-harness':
        records.removeNanoHostSandboxRuntimeForHarness(owner, input.harnessInstanceId);
        return null;
      case 'sandbox.remove-by-binding':
        records.removeNanoHostSandboxRuntimeByBinding(owner, input.sandboxBindingRef);
        return null;
      case 'harness.drain':
        records.drainNanoHostHarnessAdmission(owner, input);
        return null;
      case 'session-binding.initialize-check-versions':
      case 'session-binding.append-check-version':
        publishRuntimeCheckVersion(owner, input);
        return null;
      case 'sandbox.drain':
        records.drainNanoHostSandboxAdmission(owner, input);
        return null;
      case 'sandbox.fence':
        records.fenceNanoHostSandboxRuntime(owner, presentControlFacts(input));
        return null;
      case 'session-binding.open':
        records.openNanoHostAgentSessionBinding(owner, presentControlFacts(input));
        return null;
      case 'measured-identity.copy':
        records.copyNanoHostMeasuredHarnessIdentity(owner, input);
        return null;
      case 'operation.expire':
        records.expireNanoHostHarnessQueuedOperation(owner, input);
        return null;
      case 'operation.unknown':
        records.markNanoHostHarnessOperationUnknown(owner, input);
        return null;
    }
  } catch (error) {
    refuseHarnessLifecycle(error);
  }

  if (owner.scope !== 'core') throw new ControlProductPreconditionError();
  try {
    switch (input.kind) {
      case 'sandbox.claim-idle-drain':
        claimIdleSandboxDrain(owner, input);
        return null;
      case 'harness.claim-idle-capture-drain':
        claimIdleCaptureDrain(owner, input);
        return null;
      case 'sandbox.restore-admission':
        restoreSandboxAdmission(owner, input.sandboxRuntimeId);
        return null;
      case 'operation.queue':
        return records.queueNanoHostHarnessOperation(owner, input);
      case 'operation.dispatch':
        return records.dispatchNanoHostHarnessOperation(owner, {
          sandboxIntegrationBindingRef: input.sandboxIntegrationBindingRef,
          ...(input.observedAt === undefined ? {} : { now: () => input.observedAt! }),
        });
      case 'operation.settle':
        return records.settleNanoHostHarnessOperation(owner, input);
      case 'result.acknowledge':
        records.acknowledgeNanoHostHarnessResult(owner, input);
        return null;
    }
  } catch (error) {
    refuseHarnessLifecycle(error);
  }
}

function refuseHarnessLifecycle(error: unknown): never {
  // Preserve domain messages and the existing capacity facts, never SQL text or bound values.
  if (error instanceof Error && !('code' in error)) {
    const capacity =
      'reasonCode' in error &&
      error.reasonCode === 'busy' &&
      'exhaustedBound' in error &&
      error.exhaustedBound === 'sandbox.activeTurns';
    throw new HarnessLifecycleRefusal(error.message, capacity ? 'sandbox.activeTurns' : undefined);
  }
  throw error;
}

/** Capture dispositions are observations, never Workspace writes or a retained Main authorization boolean. */
function captureDispositionsRecovered(
  coreDb: CoreDb,
  owner: { readonly sqlite: Database.Database },
  sandboxBindingRef: string
): boolean {
  const anchors = readNanoHostWorkspaceCaptureAnchors(owner, sandboxBindingRef);
  const attempts = new Set(anchors.map((anchor) => anchor.attemptId));
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
        return false;
    } catch {
      // Optional restoration fails closed when its anchored Workspace disposition cannot be read.
      return false;
    } finally {
      reader?.sqlite.close();
    }
  }
  return true;
}

/**
 * Releases one Harness's idle capture latch on an accepting Sandbox in the authorized target Epoch,
 * after its proved local close or its close refused as unsent stale (`close` arm), or for its own
 * claim before any queue commit and at the cold quiescent exit (`claim` arm).
 * The Harness row must still carry that write: the close's settle clock retained by its Core
 * consumption, or the claim's own revision. G3: the row must also hold the frame's claim
 * generation, and the release clears it, so a retry or a late duplicate of the frame changes no
 * row. A frame without a generation restores nothing. A later claim, queue or drain on that
 * Harness, another Harness's latch and any other close outcome keep their drain.
 */
function restoreHarnessAdmissionAfterLocalClose(
  coreDb: CoreDb,
  input: Extract<ControlHarnessLifecycleInput, { kind: 'sandbox.restore-admission' }>,
  owner: { readonly sqlite: Database.Database },
  authority: NanoHostIdleSandboxAuthority
): void {
  const scoped = input.harness;
  if (!scoped) return;
  const sandbox = owner.sqlite
    .prepare(`SELECT sandbox_binding_ref AS binding FROM sandbox_runtime_records
      WHERE sandbox_runtime_id=? AND runtime_target_id=? AND origin_physical_epoch=?
      AND drain_state='accepting' AND lifecycle_state='open' AND health_state='ready'
      AND cleanup_state='clean'`)
    .get(input.sandboxRuntimeId, authority.target.targetId, authority.target.physicalEpoch) as
    | { binding: string }
    | undefined;
  if (!sandbox || !captureDispositionsRecovered(coreDb, owner, sandbox.binding)) return;
  const harness = owner.sqlite
    .prepare(`SELECT operation, operation_id AS operationId, operation_sequence AS sequence,
      operation_state AS state, result_fingerprint AS resultFingerprint, updated_at AS revision
      FROM harness_instance_records WHERE harness_instance_id=? AND harness_binding_ref=?
      AND sandbox_runtime_id=? AND lifecycle_state='open' AND drain_state='draining'`)
    .get(scoped.harnessInstanceId, scoped.harnessBindingRef, input.sandboxRuntimeId) as
    | {
        operation: string | null;
        operationId: string | null;
        sequence: number | null;
        state: string;
        resultFingerprint: string | null;
        revision: string;
      }
    | undefined;
  if (!harness || scoped.generation === undefined) return;
  // The close's settle clock, retained by its Core consumption, proves no later Harness write.
  // The claim arm carries the claim's own revision.
  const revision =
    'close' in scoped
      ? records.readNanoHostSettledIdleCloseConsumedAt(
          coreDb,
          owner,
          scoped.harnessInstanceId,
          scoped.close
        )
      : scoped.claim.revision;
  if (revision === null || harness.revision !== revision) return;
  owner.sqlite
    .prepare(`UPDATE harness_instance_records SET drain_state='accepting', claim_generation=NULL
    WHERE harness_instance_id=? AND harness_binding_ref=? AND sandbox_runtime_id=? AND updated_at=?
      AND claim_generation=? AND lifecycle_state='open' AND drain_state='draining'
      AND operation_state IN ('idle','settled') AND (operation IS NULL OR (operation<>'harness.drain'
      AND (operation<>'session.close' OR json_extract(result_json, '$.disposition')='succeeded'
        OR (json_extract(result_json, '$.disposition')='refused'
          AND json_extract(result_json, '$.body.reasonCode')='stale'))))`)
    .run(
      scoped.harnessInstanceId,
      scoped.harnessBindingRef,
      input.sandboxRuntimeId,
      revision,
      scoped.generation
    );
}

/** Restores the exact two-table admission tuple while its current Core proof remains inside the native savepoint. */
function restoreSandboxAdmission(
  coreDb: CoreDb,
  sandboxRuntimeId: string,
  owner: { readonly sqlite: Database.Database } = coreDb,
  authority?: NanoHostIdleSandboxAuthority
): void {
  const sandbox = owner.sqlite
    .prepare(`SELECT sandbox_binding_ref AS binding, runtime_target_id AS targetId,
      origin_physical_epoch AS epoch, drain_state AS drain, updated_at AS updatedAt
      FROM sandbox_runtime_records WHERE sandbox_runtime_id=?`)
    .get(sandboxRuntimeId) as
    | { binding: string; targetId: string; epoch: string; drain: string; updatedAt: string }
    | undefined;
  if (
    !sandbox ||
    (authority &&
      (sandbox.targetId !== authority.target.targetId ||
        sandbox.epoch !== authority.target.physicalEpoch ||
        sandbox.binding !== authority.rollback?.sandboxBindingRef ||
        sandbox.updatedAt !== authority.rollback.claimedAt ||
        sandbox.drain !== 'draining'))
  )
    return;
  if (!captureDispositionsRecovered(coreDb, owner, sandbox.binding)) return;
  const restored = owner.sqlite
    .prepare(`UPDATE sandbox_runtime_records SET drain_state = 'accepting'
    WHERE sandbox_runtime_id = ? AND lifecycle_state = 'open' AND health_state = 'ready'
      AND cleanup_state = 'clean' AND NOT EXISTS (
        SELECT 1 FROM harness_instance_records WHERE sandbox_runtime_id = ?
          AND (lifecycle_state <> 'open' OR operation_state IN ('queued', 'dispatched', 'unknown')
            OR (?=1 AND (active_turn_count<>0 OR drain_state<>'draining')))
      ) AND (?=0 OR NOT EXISTS (
        SELECT 1 FROM agent_session_runtime_bindings b
        JOIN harness_instance_records h ON h.harness_instance_id=b.harness_instance_id
        WHERE h.sandbox_runtime_id=? AND (b.current_attempt_id IS NOT NULL OR b.current_turn_id IS NOT NULL)
      ))`)
    .run(
      sandboxRuntimeId,
      sandboxRuntimeId,
      Number(!!authority),
      Number(!!authority),
      sandboxRuntimeId
    );
  if (restored.changes === 1)
    owner.sqlite
      .prepare(`UPDATE harness_instance_records
    SET drain_state = 'accepting', claim_generation = NULL
    WHERE sandbox_runtime_id = ? AND lifecycle_state = 'open'`)
      .run(sandboxRuntimeId);
}

/** Rechecks current physical residency, occupancy and exact handed-off bindings before the original reversible two-table claim. */
function claimIdleSandboxDrain(
  coreDb: CoreDb,
  input: Extract<ControlHarnessLifecycleInput, { kind: 'sandbox.claim-idle-drain' }>,
  owner: { readonly sqlite: Database.Database } = coreDb
): void {
  function refuse(): never {
    throw new Error('NanoHost idle Sandbox eviction changed before drain claim.');
  }
  const targets = owner.sqlite
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
  const target = owner.sqlite
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
  if (
    nonClosedSandboxAttempts(
      coreDb,
      input.incoming.backendId,
      { scope: input.incoming, snapshotId: input.incoming.packageSnapshotId },
      input.runtimeTargetId,
      input.originPhysicalEpoch,
      nanoHostSandboxId(input.sandboxCompatibilityKey),
      owner
    ).length > 0
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
  const bindings = owner.sqlite
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
        .prepare(`SELECT 1 FROM scheduler_execution_attempts a
      LEFT JOIN scheduler_admission_entries q ON q.queue_entry_id=a.queue_entry_id
        AND q.workspace_id=a.workspace_id AND q.thread_id=a.thread_id AND q.turn_id=a.turn_id
      WHERE a.agent_session_id=? AND a.phase<>'closed'
      AND NOT (a.workspace_id=? AND a.thread_id=? AND a.turn_id=? AND q.backend_id IS ?
        AND a.phase='open' AND a.operation_id IS NULL) LIMIT 1`)
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
  const harnesses = owner.sqlite
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
    !owner.sqlite
      .prepare('SELECT 1 FROM worker_storage_bindings WHERE storage_ref=? AND revision=?')
      .get(input.replacementStorage.storageRef, input.replacementStorage.revision)
  )
    refuse();
  const absent = Number(input.physicalAbsent);
  const sandboxUpdate = owner.sqlite
    .prepare(`UPDATE sandbox_runtime_records SET drain_state='draining',updated_at=?
    WHERE sandbox_runtime_id=? AND (?=1 OR (lifecycle_state='open' AND health_state='ready' AND drain_state='accepting' AND cleanup_state='clean'))`)
    .run(input.timestamp, input.sandboxRuntimeId, absent);
  const harnessUpdate = owner.sqlite
    .prepare(`UPDATE harness_instance_records SET drain_state='draining',updated_at=?,
    claim_generation=NULL WHERE sandbox_runtime_id=? AND active_turn_count=0 AND (operation_state IN ('idle','settled') OR ?=1)
    AND (?=1 OR (lifecycle_state='open' AND drain_state='accepting') OR (lifecycle_state='failed' AND drain_state='draining'
    AND operation='session.close' AND operation_state='settled' AND json_extract(result_json,'$.disposition')='refused'
    AND json_extract(result_json,'$.body.reasonCode')='cleanup_required'))`)
    .run(input.timestamp, input.sandboxRuntimeId, absent, absent);
  if (sandboxUpdate.changes !== 1 || (!input.physicalAbsent && harnessUpdate.changes < 1)) refuse();
}

/** Retains the original Workspace-first, Core-second idle capture drain with its current healthy physical binding checks. */
function claimIdleCaptureDrain(
  coreDb: CoreDb,
  input: Extract<ControlHarnessLifecycleInput, { kind: 'harness.claim-idle-capture-drain' }>,
  owner: { readonly sqlite: Database.Database } = coreDb
): void {
  // The binding is Native and the closed attempt is Core: compare both inside the deciding commit.
  const binding = owner.sqlite
    .prepare(`SELECT workspace_id AS workspaceId, thread_id AS threadId FROM agent_session_runtime_bindings
    WHERE agent_session_runtime_binding_id=? AND agent_session_id=? AND harness_instance_id=?
    AND current_attempt_id IS NULL AND current_turn_id IS NULL`)
    .get(input.agentSessionRuntimeBindingId, input.agentSessionId, input.harnessInstanceId) as
    | { workspaceId: string; threadId: string }
    | undefined;
  const closed =
    binding &&
    coreDb.sqlite
      .prepare(`SELECT 1 FROM scheduler_execution_attempts WHERE attempt_id=? AND phase='closed'
      AND agent_session_id=? AND workspace_id=? AND thread_id=?`)
      .get(input.attemptId, input.agentSessionId, binding.workspaceId, binding.threadId);
  // The claim's clock is this Harness's new revision; an older or equal clock refuses. Only an
  // accepting Harness on an accepting Sandbox can be claimed (CLOSE-LC RC3, CL3): a drain that
  // another owner holds, or an earlier claim, keeps the latch. G3: the same CAS writes the fresh
  // generation of this acquisition.
  const changed = closed
    ? owner.sqlite
        .prepare(`UPDATE harness_instance_records SET drain_state='draining', updated_at=?,
    claim_generation=?
    WHERE harness_binding_ref=? AND harness_instance_id=? AND lifecycle_state='open' AND operation_state IN ('idle','settled')
    AND drain_state='accepting' AND updated_at < ?
    AND EXISTS (SELECT 1 FROM agent_session_runtime_bindings b
      WHERE b.harness_instance_id=harness_instance_records.harness_instance_id
      AND b.agent_session_runtime_binding_id=? AND b.agent_session_id=?
      AND b.current_attempt_id IS NULL AND b.current_turn_id IS NULL)
    AND sandbox_runtime_id IN (SELECT sandbox_runtime_id FROM sandbox_runtime_records
    WHERE sandbox_binding_ref=? AND origin_physical_epoch=? AND lifecycle_state='open' AND health_state='ready' AND cleanup_state='clean'
    AND drain_state='accepting')`)
        .run(
          input.claimedAt,
          input.claimGeneration,
          input.harnessBindingRef,
          input.harnessInstanceId,
          input.claimedAt,
          input.agentSessionRuntimeBindingId,
          input.agentSessionId,
          input.sandboxBindingRef,
          input.originPhysicalEpoch
        )
    : undefined;
  if (changed?.changes !== 1) throw new Error('Idle capture drain ownership changed.');
}

/** Retains the two original environment-lineage stages, exact current value and original binding identities inside the native deciding section. */
function publishRuntimeCheckVersion(
  owner: { readonly sqlite: Database.Database },
  input: Extract<
    ControlHarnessLifecycleInput,
    { kind: 'session-binding.initialize-check-versions' | 'session-binding.append-check-version' }
  >
): void {
  const row = owner.sqlite
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
      for (const version of versions)
        ControlHarnessLifecycleInputSchema.retainedRuntimeEnvCheckVersion.parse(version);
    } catch {
      throw new Error('Original credential binding lineage is unavailable.');
    }
    if (!Array.isArray(versions))
      throw new Error('Original credential binding lineage is unavailable.');
    versions.push(input.version);
    next = JSON.stringify(versions);
  }
  const changed = owner.sqlite
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
