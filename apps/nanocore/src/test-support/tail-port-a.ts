import { canonicalJsonText } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { onTestFinished } from 'vitest';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import {
  NANO_HOST_HEARTBEAT_BUDGET_MS,
  nanoHostStartupDeadline,
} from '../runtime/nanohost-attempt-clocks.js';
import {
  prepareWorkerControlObservation,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';
import { createWorkerControlSequenceRecorder } from '../runtime/worker-control-sequences.js';
import type { CoreSchedulerQueueEntry } from '../scheduler-records.js';
import { type CoreDb, serverStoragePath } from '../storage/db.js';
import { NanoHostWorkerRecoveryState } from '../storage/nanohost-recovery-native.js';
import {
  currentAdmittedTestNanoHostOwner,
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
  reopenAdmittedTestNanoHost,
} from './admitted-nanohost.js';
import { retainPreparedTestNanoHostSubmission } from './nanohost-worker-lease.js';

type AdmittedOwner = NonNullable<ReturnType<typeof currentAdmittedTestNanoHostOwner>>;
type BackendSessionInput = Parameters<AdmittedOwner['backendSession']>[0];

/** The acknowledged Native owner of a fixture root; production writes Native rows only through it. */
export function requireTestNanoHostOwner(coreDb: Pick<CoreDb, 'dataRoot'>): AdmittedOwner {
  const owner = currentAdmittedTestNanoHostOwner(coreDb);
  if (!owner) throw new Error('Fixture root has no admitted NanoHost owner.');
  return owner;
}

/**
 * Commits one original backend-session transition through the admitted NanoHost owner,
 * as the configured Worker lifecycle does after K8. The Core frame refuses this Native table.
 */
export function transitionBackendSessionThroughOwner(
  coreDb: Pick<CoreDb, 'dataRoot'>,
  input: Omit<Extract<BackendSessionInput, { kind: 'transition' }>, 'kind' | 'observedAt'> & {
    readonly now?: () => string;
  }
) {
  const { now, ...facts } = input;
  return requireTestNanoHostOwner(coreDb).backendSession({
    kind: 'transition',
    ...facts,
    ...(now ? { observedAt: now() } : {}),
  });
}

/**
 * Gateway recorders over the admitted NanoHost file: accepted Worker control records and
 * sequence fingerprints live in Native storage after K8, not in the Core frame.
 */
export function admittedWorkerControlRecorders(coreDb: CoreDb) {
  return {
    acceptedRecordRecorder: {
      prepareObservation: (record: Parameters<typeof prepareWorkerControlObservation>[1]) =>
        prepareWorkerControlObservation(coreDb, record),
      record: (input: Parameters<typeof writeWorkerControlAcceptedRecord>[1]) =>
        mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
          writeWorkerControlAcceptedRecord({ sqlite }, input)
        ),
    },
    sequenceRecorder: {
      accept: (
        input: Parameters<ReturnType<typeof createWorkerControlSequenceRecorder>['accept']>[0]
      ) =>
        mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
          createWorkerControlSequenceRecorder({ sqlite }).accept(input)
        ),
    },
  };
}

/**
 * Runs a domain function that refuses by throwing on the admitted NanoHost reader's connection.
 * The reader reports a throw inside its callback as a hold and drops the domain text, so the
 * refusal is carried out of the callback and rethrown unchanged for the test's own assertion.
 */
export function readAdmittedTestNanoHostRefusing<Value>(
  coreDb: CoreDb,
  query: (sqlite: Database.Database) => Value
): Value {
  const outcome = readAdmittedTestNanoHost(coreDb, (sqlite) => {
    try {
      return { ok: true as const, value: query(sqlite) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Submits an already prepared Core attempt through the original grant and lays down its
 * acknowledged Native launching anchor, as the configured Harness does after K8. The shared
 * submit fixture creates its own attempt; this one keeps the caller's preparation.
 */
export function submitPreparedTestNanoHostLease(
  coreDb: CoreDb,
  input: {
    readonly admission: CoreSchedulerQueueEntry;
    readonly attemptId: string;
    readonly tokens: {
      readonly control: string;
      readonly inference: string;
      readonly capability: string;
    };
    readonly observedAt: string;
  }
) {
  const { admission, attemptId, tokens, observedAt } = input;
  const targetId = `test-target-${admission.turnId}`;
  const { grant } = retainPreparedTestNanoHostSubmission(coreDb, {
    admission,
    attemptId,
    targetId,
    generation: '1',
    observedAt,
  });
  if (!grant.deadline) throw new Error('Prepared fixture has no submitted grant.');
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  const { agentSessionId, inputRef, bindingRef } = attempt;
  if (!agentSessionId || !inputRef || !bindingRef)
    throw new Error('Prepared fixture requires its original coordinates.');
  const deploymentId = 'test-worker-deployment';
  const epoch = 'a'.repeat(64);
  const startupDeadline = nanoHostStartupDeadline({ createdAt: observedAt });
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
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
        observedAt,
        observedAt
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
        admission.workspaceId,
        admission.threadId,
        admission.turnId,
        agentSessionId,
        inputRef,
        deploymentId,
        `fixture-backend-${attemptId}`,
        `fixture-staging-${attemptId}`,
        observedAt,
        observedAt,
        targetId,
        epoch,
        '{"imageRef":"registry.example/worker"}',
        bindingRef,
        canonicalJsonText({
          version: 1,
          operationId: grant.operationId,
          generation: grant.generation,
          deadline: grant.deadline,
          control: tokens.control,
          inference: tokens.inference,
          capability: tokens.capability,
          harnessInstanceId: 'fixture-harness',
          harnessOperationId: 'd'.repeat(64),
          harnessSequence: 1,
        }),
        canonicalJsonText({
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
        })
      );
  });
}

/**
 * Sets recovery facts in the Native recovery proof of an attempt, as boot recovery does after K8.
 * The Core attempt row no longer carries them. An attempt with no Native anchor gets a pre-submit
 * anchor on the admitted RuntimeTarget, the same Worker evidence a recovering Worker would leave.
 */
export function patchTestNanoHostRecoveryProof(
  coreDb: CoreDb,
  attemptId: string,
  patch: { recoveryState?: 'awaiting-reconnect'; recoveryDeadline?: string }
): void {
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  const startupDeadline = nanoHostStartupDeadline(attempt);
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    const row = sqlite
      .prepare(
        'SELECT worker_recovery_json AS proof FROM worker_backend_sessions WHERE attempt_id = ?'
      )
      .get(attemptId) as { proof: string | null } | undefined;
    const previous = row?.proof
      ? NanoHostWorkerRecoveryState.parse(JSON.parse(row.proof))
      : {
          version: 1 as const,
          sessionCompatibilityKey: null,
          startupDeadline,
          heartbeatTimeoutMs: NANO_HOST_HEARTBEAT_BUDGET_MS,
          heartbeatDeadline: startupDeadline,
          lastAcceptedHeartbeatAt: null,
          lastWorkerSequence: null,
          workerProcessKeyHash: null,
          recoveryState: null,
          recoveryDeadline: null,
        };
    const proof = canonicalJsonText(NanoHostWorkerRecoveryState.parse({ ...previous, ...patch }));
    if (row) {
      sqlite
        .prepare('UPDATE worker_backend_sessions SET worker_recovery_json = ? WHERE attempt_id = ?')
        .run(proof, attemptId);
      return;
    }
    const { agentSessionId, inputRef, bindingRef } = attempt;
    const target = sqlite
      .prepare(
        `SELECT target_id AS targetId, deployment_id AS deploymentId, physical_epoch AS epoch
         FROM nanohost_runtime_targets ORDER BY observed_at DESC LIMIT 1`
      )
      .get() as { targetId: string; deploymentId: string; epoch: string } | undefined;
    if (!agentSessionId || !inputRef || !bindingRef || !target)
      throw new Error('Recovery fixture requires its attempt coordinates and a RuntimeTarget.');
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
        agentSessionId,
        inputRef,
        target.deploymentId,
        `fixture-backend-${attemptId}`,
        `fixture-staging-${attemptId}`,
        attempt.createdAt,
        attempt.createdAt,
        target.targetId,
        target.epoch,
        '{"imageRef":"registry.example/worker"}',
        bindingRef,
        proof
      );
  });
}

/** Marks the exact Native anchor as awaiting its Worker's reconnect proof, as boot recovery does. */
export function markTestNanoHostAwaitingReconnect(
  coreDb: CoreDb,
  attemptId: string,
  recoveryDeadline: string
): void {
  patchTestNanoHostRecoveryProof(coreDb, attemptId, {
    recoveryState: 'awaiting-reconnect',
    recoveryDeadline,
  });
}

/**
 * Joins the admitted NanoHost file of a Core fixture root with the surface of the standalone
 * NanoHost fixture owner (`storage`, a file `sqlite`, and `setup`). Receivers whose subject is a
 * production reader of `coreDb.dataRoot` use it so those readers find their acknowledged opening.
 */
export async function admittedRootNanoHostFixture(coreDb: CoreDb): Promise<{
  readonly storage: Awaited<ReturnType<typeof openAdmittedTestNanoHost>>['value'];
  readonly sqlite: Database.Database;
  setup(write: (sqlite: Database.Database) => void): void;
  reopen(): Promise<void>;
}> {
  const opened = await openAdmittedTestNanoHost(coreDb);
  const sqlite = new Database(serverStoragePath(coreDb.dataRoot, 'nanohost'), {
    fileMustExist: true,
  });
  onTestFinished(() => {
    if (sqlite.open) sqlite.close();
  });
  return {
    storage: opened.value,
    sqlite,
    setup: (write: (sqlite: Database.Database) => void): void => {
      mutateAdmittedTestNanoHost(coreDb, write);
    },
    reopen: async (): Promise<void> => {
      await reopenAdmittedTestNanoHost(coreDb);
    },
  };
}
