import { canonicalJsonText } from '@openkit/protocol';
import Database from 'better-sqlite3';
import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  readSchedulerSelectionPrefixDigest,
  recordSchedulerExecutionGrantInDb,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import { CORE_SCHEDULER_EXECUTION_DEFINITION } from '../runtime/execution-journal.js';
import type { ExecutionJournalIntent } from '../runtime/execution-step-journal.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import {
  NANO_HOST_HEARTBEAT_BUDGET_MS,
  nanoHostStartupDeadline,
} from '../runtime/nanohost-attempt-clocks.js';
import {
  getNanoHostRuntimeTarget,
  type NanoHostRuntimeTargetRecord,
} from '../runtime/nanohost-runtime-target-records.js';
import type {
  WorkerControlLineage,
  WorkerControlRegistration,
} from '../runtime/worker-control-gateway.js';
import { writeWorkerControlAcceptedRecord } from '../runtime/worker-control-records.js';
import type { CoreSchedulerQueueEntry } from '../scheduler-records.js';
import type { NanoHostOwnerBinding } from '../storage/control-store-worker-client.js';
import { type CoreDb, serverStoragePath } from '../storage/db.js';
import {
  NanoHostWorkerRecoveryState,
  readNanoHostRecoveryLease,
} from '../storage/nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from '../storage/nanohost-submitted-lease.js';
import { mutateAdmittedTestNanoHost, readAdmittedTestNanoHost } from './admitted-nanohost.js';
import { testEntityId } from './entity-ids.js';

/**
 * Retains an already-decided submission for fixtures that start after Core policy admission.
 * Callers own the established preparation and the exact admitted Native RuntimeTarget.
 */
export function retainPreparedTestNanoHostSubmission(
  coreDb: CoreDb,
  input: {
    admission: CoreSchedulerQueueEntry;
    attemptId: string;
    targetId: string;
    generation: string;
    observedAt: string;
    exclusionRefs?: readonly string[];
  }
) {
  const { admission, attemptId, targetId, generation, observedAt: createdAt } = input;
  const { workspaceId, threadId, turnId } = admission;
  const { inputRef, bindingRef } = requireSchedulerExecutionAttempt(coreDb, attemptId);
  if (!inputRef || !bindingRef)
    throw new Error('Fixture submission requires both original coordinates.');
  const operationId = commandInputHash({ attemptId, inputRef, operation: 'submit' });
  const now = () => createdAt;
  const span = {
    traceId: '1'.repeat(32),
    spanId: '1'.repeat(16),
    flags: 1,
    name: 'Worker route fixture submission',
    kind: 'INTERNAL' as const,
    startTimeUnixNano: BigInt(Date.parse(createdAt)) * 1_000_000n,
    endTimeUnixNano: null,
    status: { code: 'UNSET' as const },
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    instrumentationScope: { name: 'test', attributes: [], droppedAttributesCount: 0 },
    resource: { attributes: [], droppedAttributesCount: 0 },
  };
  const proposal: ExecutionJournalIntent = {
    execution: {
      ref: { owner: { kind: 'server' }, executionId: attemptId },
      definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
      workId: turnId,
      fingerprint: admission.inputHash,
      exclusionRefs: input.exclusionRefs ?? [
        `workspace:${workspaceId}`,
        `thread:${threadId}`,
        `turn:${turnId}`,
      ],
      span,
    },
    stepId: 'worker-route-fixture-submit',
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: { operation: 'submit', requestId: operationId, sequence: null, bindingRef },
    control: {
      definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
      kind: 'admit',
      target: { backendKind: 'nanohost', targetId, allocationRef: null },
      workId: turnId,
      operationId,
      attemptId,
      invocationId: operationId,
      actor: admission.triggerActor,
      inputRefs: [inputRef],
      outputRefs: [],
      fingerprint: admission.inputHash,
      permittingDecisionRef: null,
      authorityRefs: [],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: null,
      physicalFenceRefs: [],
    },
    span: { ...span, spanId: '2'.repeat(16), parentSpanId: span.spanId },
  };
  return coreDb.sqlite.transaction(() =>
    recordSchedulerExecutionGrantInDb(
      coreDb,
      { proposal, attemptId, operationId, generation, submission: true, now },
      () => true
    )
  )();
}

/** Gives a route fixture its original Core submission and the matching admitted Native lease. */
export function submitTestNanoHostWorkerLease(
  coreDb: CoreDb,
  admission: CoreSchedulerQueueEntry,
  bindingRef: string,
  registration: Pick<
    WorkerControlRegistration,
    | 'agentSessionId'
    | 'packageSnapshotId'
    | 'workerControlTokenHash'
    | 'workerInferenceTokenHash'
    | 'workerCapabilityTokenHash'
  >,
  fixture: {
    readonly attemptId?: string;
    readonly nativePath?: string;
    readonly observedAt?: string;
    readonly exclusionRefs?: readonly string[];
    /** Reuse a target opened by the real placement producer so its epoch can later retire. */
    readonly readyTarget?: NanoHostRuntimeTargetRecord;
  } = {}
) {
  const readyTarget = fixture.readyTarget;
  if (readyTarget) {
    const current = readAdmittedTestNanoHost(coreDb, (sqlite) =>
      getNanoHostRuntimeTarget({ sqlite }, readyTarget.targetId)
    );
    if (
      !current?.ready ||
      !current.freshEmpty ||
      !current.predecessorFenced ||
      current.connectionGeneration !== readyTarget.connectionGeneration ||
      current.identityId !== readyTarget.identityId ||
      current.deploymentId !== readyTarget.deploymentId ||
      !current.physicalEpoch ||
      current.physicalEpoch !== readyTarget.physicalEpoch
    )
      throw new Error('Worker lease fixture requires its exact acknowledged ready target.');
  }
  const createdAt = fixture.observedAt ?? new Date().toISOString();
  const now = () => createdAt;
  const { workspaceId, threadId, turnId } = admission;
  const { agentSessionId, packageSnapshotId: inputRef } = registration;
  const attemptId = fixture.attemptId ?? testEntityId('attempt', `worker-lease-${turnId}`);
  const targetId = readyTarget?.targetId ?? `test-target-${turnId}`;
  createSchedulerExecutionAttempt(coreDb, {
    entry: admission,
    attemptId,
    preparationInput: {},
    // A fixture claim stands in for Main's selection, which skips every satisfiable predecessor.
    selectionPrefixDigest: readSchedulerSelectionPrefixDigest(coreDb, admission),
    now,
  });
  bindSchedulerExecutionAttemptSession(coreDb, { attemptId, agentSessionId, now });
  finalizeSchedulerExecutionAttemptInput(coreDb, { attemptId, inputRef, bindingRef, now });

  const { grant } = retainPreparedTestNanoHostSubmission(coreDb, {
    admission,
    attemptId,
    targetId,
    generation: String(readyTarget?.connectionGeneration ?? 1),
    observedAt: createdAt,
    ...(fixture.exclusionRefs === undefined ? {} : { exclusionRefs: fixture.exclusionRefs }),
  });
  if (!grant.deadline) throw new Error('Worker route fixture has no submitted grant.');

  const deploymentId = readyTarget?.deploymentId ?? 'test-worker-deployment';
  const epoch = readyTarget?.physicalEpoch ?? 'a'.repeat(64);
  const startupDeadline = nanoHostStartupDeadline({ createdAt });
  const sqlite = new Database(
    fixture.nativePath ?? serverStoragePath(coreDb.dataRoot, 'nanohost'),
    {
      fileMustExist: true,
    }
  );
  try {
    // Lay down the acknowledged result of the Native submission. This fixture exercises
    // Gateway reads. The Harness submission, Workspace handoff and writer gates have their own tests.
    sqlite
      .transaction(() => {
        if (!readyTarget)
          sqlite
            .prepare(`INSERT INTO nanohost_runtime_targets (
          target_id, identity_id, deployment_id, connection_generation, predecessor_fenced,
          ready, fresh_empty, physical_epoch, observed_at, slot_count, last_fresh_ready_at
        ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, 1, ?)`)
            .run(
              targetId,
              targetId,
              deploymentId,
              Number(grant.generation),
              epoch,
              createdAt,
              createdAt
            );
        sqlite
          .prepare(`INSERT INTO worker_backend_sessions (
          attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
          backend_kind, deployment_id, backend_session_id, staging_directory_ref,
          workspace_handoff_state, state, created_at, updated_at, runtime_target_id,
          origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, worker_route_binding_json,
          worker_recovery_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'openshell', ?, ?, ?,
          'complete', 'launching', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            attemptId,
            workspaceId,
            threadId,
            turnId,
            agentSessionId,
            inputRef,
            deploymentId,
            `fixture-backend-${attemptId}`,
            `fixture-staging-${attemptId}`,
            createdAt,
            createdAt,
            targetId,
            epoch,
            '{"imageRef":"registry.example/worker"}',
            bindingRef,
            canonicalJsonText({
              version: 1,
              operationId: grant.operationId,
              generation: grant.generation,
              deadline: grant.deadline,
              control: registration.workerControlTokenHash,
              inference: registration.workerInferenceTokenHash,
              capability: registration.workerCapabilityTokenHash,
              harnessInstanceId: 'fixture-harness',
              harnessOperationId: 'd'.repeat(64),
              harnessSequence: 1,
            }),
            canonicalJsonText({
              version: 1,
              sessionCompatibilityKey: 'shared-mcp-fixture',
              startupDeadline,
              heartbeatTimeoutMs: NANO_HOST_HEARTBEAT_BUDGET_MS,
              heartbeatDeadline: startupDeadline,
              lastAcceptedHeartbeatAt: null,
              lastWorkerSequence: null,
              workerProcessKeyHash: null,
              recoveryState: null,
              recoveryDeadline: null,
            })
          );
      })
      .immediate();
  } finally {
    sqlite.close();
  }
  return requireSchedulerExecutionAttempt(coreDb, attemptId);
}

/** Plants contradictory Worker activity on a failed-start fixture with no submitted operation. */
export function seedTestPreSubmitNativeWorkerEvidence(
  coreDb: CoreDb,
  attemptId: string,
  target: NanoHostRuntimeTargetRecord
): void {
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  if (!attempt.inputRef || !attempt.agentSessionId || !attempt.bindingRef || !target.physicalEpoch)
    throw new Error('Worker evidence fixture requires its exact attempt and target lineage.');
  const startupDeadline = nanoHostStartupDeadline(attempt);
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    sqlite
      .prepare(`INSERT INTO worker_backend_sessions (
        attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
        backend_kind, deployment_id, backend_session_id, staging_directory_ref,
        workspace_handoff_state, state, created_at, updated_at, runtime_target_id,
        origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, worker_recovery_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'openshell', ?, ?, ?, 'pending', 'materializing',
        ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        attemptId,
        attempt.workspaceId,
        attempt.threadId,
        attempt.turnId,
        attempt.agentSessionId,
        attempt.inputRef,
        target.deploymentId,
        `fixture-backend-${attemptId}`,
        `fixture-staging-${attemptId}`,
        attempt.createdAt,
        attempt.createdAt,
        target.targetId,
        target.physicalEpoch,
        '{"imageRef":"registry.example/worker"}',
        attempt.bindingRef,
        canonicalJsonText({
          version: 1,
          sessionCompatibilityKey: null,
          startupDeadline,
          heartbeatTimeoutMs: NANO_HOST_HEARTBEAT_BUDGET_MS,
          heartbeatDeadline: startupDeadline,
          lastAcceptedHeartbeatAt: null,
          lastWorkerSequence: 1,
          workerProcessKeyHash: null,
          recoveryState: null,
          recoveryDeadline: null,
        })
      );
  });
}

/** Retains the handoff already completed by the fixture's modeled backend. */
export function seedTestNanoHostCompletedWorkspaceHandoff(coreDb: CoreDb, attemptId: string): void {
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    const { changes } = sqlite
      .prepare(
        `UPDATE worker_backend_sessions SET workspace_handoff_state = 'complete'
         WHERE attempt_id = ? AND state = 'materialized' AND workspace_handoff_state = 'pending'`
      )
      .run(attemptId);
    if (changes !== 1) throw new Error('Handoff fixture requires its exact materialized session.');
  });
}

/** Records the modeled launch on its existing Native anchor after the original Core decision. */
export function seedTestNanoHostWorkerLaunch(
  coreDb: CoreDb,
  attemptId: string,
  registration: Pick<
    WorkerControlRegistration,
    | 'agentSessionId'
    | 'packageSnapshotId'
    | 'workerControlTokenHash'
    | 'workerInferenceTokenHash'
    | 'workerCapabilityTokenHash'
  >,
  observedAt: string
): void {
  const original = readRetainedNanoHostSubmission(coreDb, attemptId);
  if (
    !original ||
    original.lease.attempt.agentSessionId !== registration.agentSessionId ||
    original.lease.attempt.inputRef !== registration.packageSnapshotId
  )
    throw new Error('Modeled Worker launch requires its original submitted grant.');
  const { attempt, grant } = original.lease;
  const startupDeadline = nanoHostStartupDeadline(attempt);
  const routes = canonicalJsonText({
    version: 1,
    operationId: grant.operationId,
    generation: grant.generation,
    deadline: grant.deadline,
    control: registration.workerControlTokenHash,
    inference: registration.workerInferenceTokenHash,
    capability: registration.workerCapabilityTokenHash,
    harnessInstanceId: 'fixture-harness',
    harnessOperationId: 'd'.repeat(64),
    harnessSequence: 1,
  });
  const recovery = canonicalJsonText({
    version: 1,
    sessionCompatibilityKey: null,
    startupDeadline,
    heartbeatTimeoutMs: NANO_HOST_HEARTBEAT_BUDGET_MS,
    heartbeatDeadline: startupDeadline,
    lastAcceptedHeartbeatAt: null,
    lastWorkerSequence: null,
    workerProcessKeyHash: null,
    recoveryState: null,
    recoveryDeadline: null,
  });
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    const written = sqlite
      .prepare(`UPDATE worker_backend_sessions
      SET state = 'launching', updated_at = ?, worker_route_binding_json = ?, worker_recovery_json = ?
      WHERE attempt_id = ? AND agent_session_id = ? AND package_snapshot_id = ?
        AND sandbox_binding_ref = ? AND state = 'materialized'
        AND workspace_handoff_state = 'complete' AND physical_cleaned_at IS NULL
        AND worker_route_binding_json IS NULL AND worker_recovery_json IS NULL`)
      .run(
        observedAt,
        routes,
        recovery,
        attemptId,
        attempt.agentSessionId,
        attempt.inputRef,
        attempt.bindingRef
      );
    if (written.changes !== 1)
      throw new Error('Modeled Worker launch requires its exact Native anchor.');
  });
}

/** Simulates loss of the exact physical anchor while retaining the original Core grant. */
export function removeTestNativeWorkerAnchor(coreDb: CoreDb, attemptId: string): void {
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    const removed = sqlite
      .prepare('DELETE FROM worker_backend_sessions WHERE attempt_id = ?')
      .run(attemptId);
    if (removed.changes !== 1) throw new Error('The fixture lost a different Native anchor.');
  });
}

/** Reads the native liveness facts by their acknowledged Core submission. */
export function readTestNanoHostWorkerLease(coreDb: CoreDb, attemptId: string) {
  const original = readRetainedNanoHostSubmission(coreDb, attemptId);
  if (!original) throw new Error('Fixture has no original submitted Worker grant.');
  return readAdmittedTestNanoHost(
    coreDb,
    (sqlite) => readNanoHostRecoveryLease(sqlite, original.lease).attempt
  );
}

/** Reads the exact attempt and retained proofs for failed-start inspection in tests. */
export function readTestNativeAttemptEvidence(coreDb: CoreDb, attemptId: string) {
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  return readAdmittedTestNanoHost(coreDb, (sqlite) => {
    const session = sqlite
      .prepare(
        `SELECT worker_recovery_json AS recovery, worker_route_binding_json AS route
         FROM worker_backend_sessions WHERE attempt_id = ?`
      )
      .get(attemptId) as { recovery: string | null; route: string | null } | undefined;
    const recovery = session?.recovery
      ? NanoHostWorkerRecoveryState.parse(JSON.parse(session.recovery))
      : null;
    const route: { control: string; inference: string; capability: string } | null = session?.route
      ? JSON.parse(session.route)
      : null;
    return {
      ...attempt,
      sessionCompatibilityKey: recovery?.sessionCompatibilityKey ?? null,
      startupDeadline: recovery?.startupDeadline ?? null,
      heartbeatTimeoutMs: recovery?.heartbeatTimeoutMs ?? null,
      heartbeatDeadline: recovery?.heartbeatDeadline ?? null,
      lastAcceptedHeartbeatAt: recovery?.lastAcceptedHeartbeatAt ?? null,
      lastWorkerSequence: recovery?.lastWorkerSequence ?? null,
      workerProcessKeyHash: recovery?.workerProcessKeyHash ?? null,
      recoveryState: recovery?.recoveryState ?? null,
      recoveryDeadline: recovery?.recoveryDeadline ?? null,
      workerControlTokenHash: route?.control ?? null,
      workerInferenceTokenHash: route?.inference ?? null,
      workerCapabilityTokenHash: route?.capability ?? null,
    };
  });
}

/** Seeds a prior accepted heartbeat for tests whose subject starts at recovery. */
export function seedTestNanoHostHeartbeat(
  coreDb: CoreDb,
  input: {
    attemptId: string;
    heartbeatTimeoutMs: number;
    workerSequence: number;
    workerProcessKeyHash?: string;
    now?: () => string;
  }
): void {
  const attempt = requireSchedulerExecutionAttempt(coreDb, input.attemptId);
  const observedAt = input.now?.() ?? new Date().toISOString();
  const startupDeadline = nanoHostStartupDeadline(attempt);
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    const row = sqlite
      .prepare(
        'SELECT worker_recovery_json AS proof FROM worker_backend_sessions WHERE attempt_id = ?'
      )
      .get(input.attemptId) as { proof: string | null } | undefined;
    if (!row) throw new Error('A fixture heartbeat requires its existing Native anchor.');
    const previous = row.proof ? NanoHostWorkerRecoveryState.parse(JSON.parse(row.proof)) : null;
    const proof = NanoHostWorkerRecoveryState.parse({
      version: 1,
      sessionCompatibilityKey: previous?.sessionCompatibilityKey ?? null,
      startupDeadline,
      heartbeatTimeoutMs: input.heartbeatTimeoutMs,
      heartbeatDeadline: new Date(Date.parse(observedAt) + input.heartbeatTimeoutMs).toISOString(),
      lastAcceptedHeartbeatAt: observedAt,
      lastWorkerSequence: input.workerSequence,
      workerProcessKeyHash: input.workerProcessKeyHash ?? previous?.workerProcessKeyHash ?? null,
      recoveryState: previous?.recoveryState ?? null,
      recoveryDeadline: previous?.recoveryDeadline ?? null,
    });
    sqlite
      .prepare('UPDATE worker_backend_sessions SET worker_recovery_json = ? WHERE attempt_id = ?')
      .run(canonicalJsonText(proof), input.attemptId);
  });
}

/** Seeds a retained response for fixtures whose first subject is the consumer of that response. */
export function seedTestWorkerControlReceipt(
  coreDb: CoreDb,
  input: Parameters<typeof writeWorkerControlAcceptedRecord>[1]
): void {
  mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
    writeWorkerControlAcceptedRecord({ sqlite }, input)
  );
}

/** Posts the deterministic observation without changing its original timing or sequence. */
export function postTestNativeWorkerHeartbeat(
  owner: Pick<NanoHostOwnerBinding, 'workerControlHeartbeat'>,
  input: {
    readonly lineage: WorkerControlLineage;
    readonly sandboxBindingRef: string;
    readonly tokenHash: string;
    readonly sequence: number;
    readonly observedAt: string;
    readonly processKeyHash?: string;
  }
) {
  const { lineage, sandboxBindingRef, tokenHash, sequence, observedAt, processKeyHash } = input;
  return owner.workerControlHeartbeat({
    sandboxBindingRef,
    lineage,
    tokenHash,
    payload: {
      acceptedAt: observedAt,
      request: {
        schemaVersion: 2,
        operation: 'heartbeat',
        sequence,
        lineage,
        body: processKeyHash ? { status: 'starting', processKeyHash } : { status: 'running' },
      },
    },
  });
}
