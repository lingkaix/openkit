import { canonicalJsonText } from '@openkit/protocol';
import Database from 'better-sqlite3';
import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
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
import type { WorkerControlRegistration } from '../runtime/worker-control-gateway.js';
import type { CoreSchedulerQueueEntry } from '../scheduler-records.js';
import { type CoreDb, serverStoragePath } from '../storage/db.js';
import { testEntityId } from './entity-ids.js';

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
  fixture: { readonly attemptId?: string; readonly nativePath?: string } = {}
) {
  const createdAt = new Date().toISOString();
  const now = () => createdAt;
  const { workspaceId, threadId, turnId } = admission;
  const { agentSessionId, packageSnapshotId: inputRef } = registration;
  const attemptId = fixture.attemptId ?? testEntityId('attempt', `worker-lease-${turnId}`);
  const targetId = `test-target-${turnId}`;
  const operationId = commandInputHash({ attemptId, inputRef, operation: 'submit' });
  createSchedulerExecutionAttempt(coreDb, {
    entry: admission,
    attemptId,
    preparationInput: {},
    now,
  });
  bindSchedulerExecutionAttemptSession(coreDb, { attemptId, agentSessionId, now });
  finalizeSchedulerExecutionAttemptInput(coreDb, { attemptId, inputRef, bindingRef, now });

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
      exclusionRefs: [`workspace:${workspaceId}`, `thread:${threadId}`, `turn:${turnId}`],
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
  const { grant } = coreDb.sqlite.transaction(() =>
    recordSchedulerExecutionGrantInDb(
      coreDb,
      { proposal, attemptId, operationId, generation: '1', submission: true, now },
      () => true
    )
  )();
  if (!grant.deadline) throw new Error('Worker route fixture has no submitted grant.');

  const deploymentId = 'test-worker-deployment';
  const epoch = 'a'.repeat(64);
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
