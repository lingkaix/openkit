import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import * as attemptActionOwners from './runtime/execution-attempt-records.js';
import {
  acceptNanoHostAttemptHeartbeat,
  requireNanoHostExecutionAttempt,
  resolveNanoHostAttemptTokenBinding,
} from './runtime/nanohost-attempt-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import { runSchedulerRecoveryMaintenance } from './runtime/scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from './runtime/turn-executor-factory.js';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  findNextDispatchableSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  requireSchedulerAdmissionEntry,
  retryDeniedSchedulerAdmissionEntry,
} from './scheduler-records';
import { openCoreDb } from './storage/db';
import { applyMigrations } from './storage/migrate';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates an isolated migrated Core database for scheduler tests.
 *
 * @returns Open Core database handle.
 */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-')));
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  return coreDb;
}

/** Seeds the current physical Epoch required by backend-anchor fixtures. */
function seedBackendRuntimeTarget(coreDb: ReturnType<typeof createMigratedCoreDb>): void {
  if (getNanoHostRuntimeTarget(coreDb, 'runtime-target-test')) return;
  const allocated = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'deployment-test',
    identityId: 'identity-test',
    observedAt: '2026-07-05T00:00:00.000Z',
    targetId: 'runtime-target-test',
  });
  upsertNanoHostRuntimeTarget(coreDb, {
    ...allocated,
    freshEmpty: true,
    observedAt: '2026-07-05T00:00:01.000Z',
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
}

/** Establishes prepared and submitted Native authority for record-owner regressions. */
function createPreparedAttempt(coreDb: ReturnType<typeof createMigratedCoreDb>, attemptId: string) {
  const suffix = attemptId.replace('lease_', '');
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: 'user_local' },
    queueEntryId: `queue_${suffix}`,
    workspaceId: 'ws_demo',
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run Native attempt ${suffix}`,
    requestedAgentId: 'agent_worker',
    now: () => '2026-07-05T00:00:00.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId,
    agentSessionId: `session_${suffix}`,
    inputRef: 'pkg_demo',
    bindingRef: `lease-binding:${attemptId}`,
    sessionCompatibilityKey: `sha256:${suffix}`,
    now: () => '2026-07-05T00:00:02.000Z',
    operationId: `fixture-submit:${attemptId}`,
  });
  return requireNanoHostExecutionAttempt(coreDb, attemptId);
}

/** Observes exact admission and attempt bytes when terminal ownership is contradictory. */
function terminalAccountingSnapshot(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string
): Record<string, unknown> {
  return {
    admission: coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries WHERE queue_entry_id = ?')
      .get(`queue_${suffix}`),
    attempt: observeExecutionAttempts(coreDb).find(
      (attempt) => attempt.attempt_id === `lease_${suffix}`
    ),
  };
}

const terminalAccountingCorruptions: ReadonlyArray<{
  readonly apply: (coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string) => void;
  readonly expectedError: RegExp;
  readonly name: string;
}> = [
  {
    apply: (coreDb, suffix) => {
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_admission_entries WHERE queue_entry_id = ?')
        .run(`queue_${suffix}`);
    },
    expectedError: /admission/i,
    name: 'missing admission',
  },
];

/** Observes the Core attempt phase without projecting the retired grant or physical accounting. */
function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const present = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return present
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Exercises the current attempt closeout owner, never the deleted SessionLease grant action. */
function completeTerminalAttempt(
  coreDb: ReturnType<typeof openCoreDb>,
  turn: {
    readonly id: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly status: string;
  }
) {
  return attemptActionOwners.markSchedulerAttemptForTerminalTurn(coreDb, turn);
}

describe('scheduler records', () => {
  it('retains only the non-secret presented administrator token id across a database reopen', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-token-'));
    const first = openCoreDb(dataRoot);
    applyMigrations(first);
    try {
      const input = {
        backendId: 'nanohost',
        queueEntryId: 'queue_admin_token',
        serverAdminTokenId: 'token_admin_1',
        triggerActor: { kind: 'user' as const, id: 'user_admin' },
        workspaceId: 'ws_1',
        threadId: 'th_1',
        turnId: 'turn_1',
        turnInput: 'Run task',
        requestedAgentId: 'assistant',
      };
      createSchedulerAdmissionEntry(first, input);
      expect(() =>
        createSchedulerAdmissionEntry(first, {
          ...input,
          serverAdminTokenId: 'token_admin_2',
        })
      ).toThrow('conflicts with its retained input');
    } finally {
      first.sqlite.close();
    }
    const reopened = openCoreDb(dataRoot);
    try {
      expect(listQueuedSchedulerAdmissionEntries(reopened)[0]).toMatchObject({
        serverAdminTokenId: 'token_admin_1',
        triggerActor: { kind: 'user', id: 'user_admin' },
      });
      expect(
        reopened.sqlite
          .prepare('SELECT server_admin_token_id FROM scheduler_admission_entries')
          .get()
      ).toEqual({ server_admin_token_id: 'token_admin_1' });
    } finally {
      reopened.sqlite.close();
    }
  });

  it('persists admission queue entries in committed FIFO order without priority policy', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_automation',
        workspaceId: 'ws_b',
        threadId: 'thread_b',
        turnId: 'turn_b',
        turnInput: 'Run automation work',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:02.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_goal_fresh',
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_goal',
        threadId: 'thread_goal',
        turnId: 'turn_goal',
        turnInput: 'Run fresh Goal work',
        requestedAgentId: 'agent_worker',
        workerStorageChoice: {
          goalId: 'goal_fresh',
          kind: 'fresh',
          taskId: 'task_fresh',
        },
        now: () => '2026-07-05T00:00:04.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_interactive',
        triggerActor: {
          kind: 'automation',
          id: 'automation_interactive',
          responsibleUserId: 'user_interactive',
        },
        workspaceId: 'ws_a',
        threadId: 'thread_a',
        turnId: 'turn_a',
        turnInput: 'Run interactive work',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        workspaceCwd: '/workspace/project',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/host/project',
            workerPath: '/workspace/project',
          },
        ],
        workerStorageChoice: {
          adjudicatedThreadIds: ['thread_predecessor'],
          expectedRevision: 7,
          goalId: 'goal_a',
          kind: 'selected',
          purpose: 'work',
          reuseWorkSlotRef: 'wsl_predecessor',
          storageRef: 'wst_selected',
          taskId: 'task_a',
        },
        now: () => '2026-07-05T00:00:03.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_maintenance',
        workspaceId: 'ws_c',
        threadId: 'thread_c',
        turnId: 'turn_c',
        turnInput: 'Run maintenance work',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:01.000Z',
      });

      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_automation', 'queue_goal_fresh', 'queue_interactive', 'queue_maintenance']);
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).find(
          (entry) => entry.queueEntryId === 'queue_interactive'
        )?.turnInput
      ).toBe('Run interactive work');
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).find(
          (entry) => entry.queueEntryId === 'queue_interactive'
        )?.triggerActor
      ).toEqual({
        kind: 'automation',
        id: 'automation_interactive',
        responsibleUserId: 'user_interactive',
      });
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).find(
          (entry) => entry.queueEntryId === 'queue_interactive'
        )?.workspaceCwd
      ).toBe('/workspace/project');
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).find(
          (entry) => entry.queueEntryId === 'queue_interactive'
        )?.workspaceRoots
      ).toEqual([
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: '/host/project',
          workerPath: '/workspace/project',
        },
      ]);
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).find(
          (entry) => entry.queueEntryId === 'queue_interactive'
        )?.workerStorageChoice
      ).toEqual({
        adjudicatedThreadIds: ['thread_predecessor'],
        expectedRevision: 7,
        goalId: 'goal_a',
        kind: 'selected',
        purpose: 'work',
        reuseWorkSlotRef: 'wsl_predecessor',
        storageRef: 'wst_selected',
        taskId: 'task_a',
      });
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).find(
          (entry) => entry.queueEntryId === 'queue_goal_fresh'
        )?.workerStorageChoice
      ).toEqual({ goalId: 'goal_fresh', kind: 'fresh', taskId: 'task_fresh' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects malformed persisted Worker storage choices instead of changing admission intent', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_bad_storage_choice',
        workspaceId: 'ws_demo',
        threadId: 'thread_bad_storage_choice',
        turnId: 'turn_bad_storage_choice',
        turnInput: 'Reject malformed storage choice',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:00.000Z',
      });
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_admission_entries
           SET worker_storage_choice_json = ?
           WHERE queue_entry_id = ?`
        )
        .run(
          JSON.stringify({ kind: 'fresh', storageRef: 'wst_smuggled' }),
          'queue_bad_storage_choice'
        );

      expect(() => listQueuedSchedulerAdmissionEntries(coreDb)).toThrow(
        'Scheduler Worker storage choice is invalid'
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a second non-terminal admission entry for the same turn', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_one',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run first queued turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:00.000Z',
      });

      expect(() =>
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'user_local' },
          queueEntryId: 'queue_two',
          workspaceId: 'ws_demo',
          threadId: 'thread_demo',
          turnId: 'turn_demo',
          turnInput: 'Run duplicate queued turn',
          requestedAgentId: 'agent_worker',
          profileRef: null,
          now: () => '2026-07-05T00:00:01.000Z',
        })
      ).toThrow('conflicts with its retained input');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records typed denials without leaving the entry queued', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_denied',
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:00.000Z',
      });

      const denied = denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_denied',
        denialReason: 'queue-full',
      });

      expect(denied.status).toBe('denied');
      expect(denied.denialReason).toBe('queue-full');
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requeues denied scheduler admissions for explicit retry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_retry_denied',
        triggerActor: { kind: 'user', id: 'user_original_trigger' },
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Run denied turn again',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:00.000Z',
      });
      denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_retry_denied',
        denialReason: 'authority-denied',
      });

      const retried = retryDeniedSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_retry_denied',
        workspaceId: 'ws_demo',
      });

      expect(retried.status).toBe('queued');
      expect(retried.denialReason).toBeNull();
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_retry_denied']);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_demo',
          statuses: ['queued'],
        })
      ).toEqual([
        expect.objectContaining({
          triggerActor: { kind: 'user', id: 'user_original_trigger' },
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('cancels human-actionable scheduler admissions', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_cancel',
        triggerActor: { kind: 'user', id: 'user_original_trigger' },
        workspaceId: 'ws_demo',
        threadId: 'thread_demo',
        turnId: 'turn_demo',
        turnInput: 'Cancel this turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:00.000Z',
      });

      const cancelled = cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_cancel',
        workspaceId: 'ws_demo',
      });

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.denialReason).toBeNull();
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts lease heartbeats and advances heartbeat deadlines', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_heartbeat');

      const lease = acceptNanoHostAttemptHeartbeat(coreDb, {
        attemptId: 'lease_heartbeat',
        workerSequence: 4,
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });

      expect(lease).toMatchObject({
        attemptId: 'lease_heartbeat',
        lastAcceptedHeartbeatAt: '2026-07-05T00:00:10.000Z',
        lastWorkerSequence: 4,
        heartbeatDeadline: '2026-07-05T00:00:40.000Z',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('treats a repeated heartbeat sequence as an idempotent retry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_heartbeat_retry');
      const first = acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: 'lease_heartbeat_retry',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 4,
      });
      const retry = acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: 'lease_heartbeat_retry',
        now: () => '2026-07-05T00:00:20.000Z',
        workerSequence: 4,
      });

      expect(retry).toEqual(first);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('treats a concurrent same-sequence heartbeat winner as an idempotent retry', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_heartbeat_concurrent_retry');
      let winner: ReturnType<typeof acceptNanoHostAttemptHeartbeat> | null = null;
      const retry = acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: 'lease_heartbeat_concurrent_retry',
        now: () => {
          winner = acceptNanoHostAttemptHeartbeat(coreDb, {
            heartbeatTimeoutMs: 30_000,
            attemptId: 'lease_heartbeat_concurrent_retry',
            now: () => '2026-07-05T00:00:10.000Z',
            workerSequence: 4,
          });
          return '2026-07-05T00:00:11.000Z';
        },
        workerSequence: 4,
      });

      expect(retry).toEqual(winner);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('classifies a concurrent newer heartbeat winner as a stale sequence', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_heartbeat_concurrent_newer');

      expect(() =>
        acceptNanoHostAttemptHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          attemptId: 'lease_heartbeat_concurrent_newer',
          now: () => {
            acceptNanoHostAttemptHeartbeat(coreDb, {
              heartbeatTimeoutMs: 30_000,
              attemptId: 'lease_heartbeat_concurrent_newer',
              now: () => '2026-07-05T00:00:10.000Z',
              workerSequence: 5,
            });
            return '2026-07-05T00:00:11.000Z';
          },
          workerSequence: 4,
        })
      ).toThrowError(expect.objectContaining({ reason: 'sequence-stale' }));
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects heartbeat sequences older than the last accepted sequence', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_heartbeat_stale_sequence');
      const accepted = acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: 'lease_heartbeat_stale_sequence',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 4,
      });

      expect(() =>
        acceptNanoHostAttemptHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          attemptId: 'lease_heartbeat_stale_sequence',
          now: () => '2026-07-05T00:00:20.000Z',
          workerSequence: 3,
        })
      ).toThrow();
      expect(
        requireNanoHostExecutionAttempt(coreDb, 'lease_heartbeat_stale_sequence')
      ).toMatchObject({
        heartbeatDeadline: accepted.heartbeatDeadline,
        lastAcceptedHeartbeatAt: accepted.lastAcceptedHeartbeatAt,
        lastWorkerSequence: accepted.lastWorkerSequence,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('advances a lease only for a newer heartbeat sequence', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_heartbeat_newer_sequence');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: 'lease_heartbeat_newer_sequence',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 4,
      });

      expect(
        acceptNanoHostAttemptHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          attemptId: 'lease_heartbeat_newer_sequence',
          now: () => '2026-07-05T00:00:20.000Z',
          workerSequence: 5,
        })
      ).toMatchObject({
        heartbeatDeadline: '2026-07-05T00:00:50.000Z',
        lastAcceptedHeartbeatAt: '2026-07-05T00:00:20.000Z',
        lastWorkerSequence: 5,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not revive a lease that starts releasing before the heartbeat update', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_heartbeat_race');

      expect(() =>
        acceptNanoHostAttemptHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          attemptId: 'lease_heartbeat_race',
          now: () => {
            beginOwnedAttemptCloseout(coreDb, {
              attemptId: 'lease_heartbeat_race',
              firstTerminalCause: 'worker-final-status',
            });
            return '2026-07-05T00:00:10.000Z';
          },
          workerSequence: 4,
        })
      ).toThrow('cannot accept heartbeat');
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_heartbeat_race'
        )?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses expired Native heartbeats without reviving closed attempts or releasing unknown execution', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      createPreparedAttempt(coreDb, 'lease_expired');
      createPreparedAttempt(coreDb, 'lease_terminal');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        attemptId: 'lease_expired',
        heartbeatTimeoutMs: 30_000,
        workerSequence: 1,
        now: () => '2026-07-05T00:00:10.000Z',
      });
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: 'lease_terminal',
        firstTerminalCause: 'turn-completed',
      });
      await releaseModeledAttempt(coreDb, 'lease_terminal');
      expect(resolveAttemptRoute(coreDb, 'lease_expired', '2026-07-05T00:01:00.000Z')).toEqual({
        status: 'rejected',
        reason: 'attempt-not-live',
      });
      expect(
        attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, 'lease_expired')
      ).toMatchObject({
        phase: 'open',
        disposition: 'unknown',
        fenceRef: null,
        operationId: 'fixture-submit:lease_expired',
      });
      expect(
        attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, 'lease_terminal').phase
      ).toBe('closed');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(
    terminalAccountingCorruptions
  )('refuses Native terminal inspection without changing either owner for $name', async ({
    apply,
    expectedError,
    name,
  }) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `terminal_corrupt_${name.replaceAll(' ', '_')}`;

    try {
      createPreparedAttempt(coreDb, `lease_${suffix}`);
      apply(coreDb, suffix);
      const before = terminalAccountingSnapshot(coreDb, suffix);

      const backend = createConfiguredWorkerLifecycleRuntime({ coreDb, env: {} }).turnExecutor
        .executionBackend!;
      await expect(
        backend.inspect(
          attemptActionOwners.schedulerExecutionCorrelation(
            attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`)
          )
        )
      ).rejects.toThrow(expectedError);
      expect(terminalAccountingSnapshot(coreDb, suffix)).toEqual(before);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('blocks attempt closeout until the backend session is durably cleaned', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_cleanup_barrier');
      seedBackendRuntimeTarget(coreDb);
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: 'session_cleanup_barrier',
          backendKind: 'openshell',
          backendSessionId: 'openkit-session_cleanup_barrier',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'pkg_demo',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/pkg_demo',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: 'thread_cleanup_barrier',
          turnId: 'turn_cleanup_barrier',
          workspaceId: 'ws_demo',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: 'lease-binding:lease_cleanup_barrier',
      });

      expect(
        await closeOwnedExecutionAttempt(coreDb, {
          attemptId: 'lease_cleanup_barrier',
          firstTerminalCause: 'turn-failed',
          outcome: 'failed',
        })
      ).toMatchObject({ state: 'pending', fenceRef: null });
      completeTerminalAttempt(coreDb, {
        id: 'turn_cleanup_barrier',
        status: 'failed',
        threadId: 'thread_cleanup_barrier',
        workspaceId: 'ws_demo',
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_cleanup_barrier'
        )?.phase
      );

      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: 'lease_cleanup_barrier',
        toState: 'cleanup-pending',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        attemptId: 'lease_cleanup_barrier',
        toState: 'physical-cleaned',
      });
      completeTerminalAttempt(coreDb, {
        id: 'turn_cleanup_barrier',
        status: 'failed',
        threadId: 'thread_cleanup_barrier',
        workspaceId: 'ws_demo',
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_cleanup_barrier'
        )?.phase
      );
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'physical-cleaned',
        attemptId: 'lease_cleanup_barrier',
        toState: 'cleaned',
      });
      completeTerminalAttempt(coreDb, {
        id: 'turn_cleanup_barrier',
        status: 'failed',
        threadId: 'thread_cleanup_barrier',
        workspaceId: 'ws_demo',
      });
      expect(
        await closeOwnedExecutionAttempt(coreDb, {
          attemptId: 'lease_cleanup_barrier',
          firstTerminalCause: 'turn-failed',
          outcome: 'failed',
        })
      ).toMatchObject({ state: 'released' });
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_cleanup_barrier'
        )?.phase
      ).toBe('closed');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'active',
    'releasing',
  ] as const)('holds exclusion for %s NanoHost observations that are missing their durable backend anchor', async (status) => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, `lease_missing_anchor_${status}`);
      if (status === 'active') {
        acceptNanoHostAttemptHeartbeat(coreDb, {
          heartbeatTimeoutMs: 30_000,
          attemptId: `lease_missing_anchor_${status}`,
          now: () => '2026-07-05T00:00:10.000Z',
          workerSequence: 1,
        });
      } else {
        beginOwnedAttemptCloseout(coreDb, {
          attemptId: `lease_missing_anchor_${status}`,
          now: () => '2026-07-05T00:00:10.000Z',
          firstTerminalCause: 'worker-final-status',
        });
      }

      expect(
        await closeOwnedExecutionAttempt(coreDb, {
          attemptId: `lease_missing_anchor_${status}`,
          firstTerminalCause: 'turn-failed',
          outcome: 'failed',
        })
      ).toMatchObject({ state: 'pending', fenceRef: null });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === `lease_missing_anchor_${status}`
        )?.phase
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves closing exclusion while backend cleanup is incomplete', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_cleanup_grace');
      seedBackendRuntimeTarget(coreDb);
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: 'session_cleanup_grace',
          backendKind: 'openshell',
          backendSessionId: 'openkit-session_cleanup_grace',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'pkg_demo',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/pkg_demo',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: 'thread_cleanup_grace',
          turnId: 'turn_cleanup_grace',
          workspaceId: 'ws_demo',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: 'lease-binding:lease_cleanup_grace',
      });
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: 'lease_cleanup_grace',
        now: () => '2026-07-05T00:00:10.000Z',
        firstTerminalCause: 'worker-final-status',
      });

      await runSchedulerRecoveryMaintenance(coreDb, {
        executionBackend: createConfiguredWorkerLifecycleRuntime({ coreDb, env: {} }).turnExecutor
          .executionBackend!,
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:05:11.000Z',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: 'lease_cleanup_grace',
        toState: 'cleanup-pending',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        attemptId: 'lease_cleanup_grace',
        toState: 'physical-cleaned',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'physical-cleaned',
        attemptId: 'lease_cleanup_grace',
        toState: 'cleaned',
      });
      await runSchedulerRecoveryMaintenance(coreDb, {
        executionBackend: createConfiguredWorkerLifecycleRuntime({ coreDb, env: {} }).turnExecutor
          .executionBackend!,
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:05:12.000Z',
      });
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_cleanup_grace'
        )?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'completed',
    'interrupted',
    'cancelled',
    'failed',
  ] as const)('closes the exact attempt for %s product turns after complete cleanup', async (turnStatus) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `turn_${turnStatus}`;

    try {
      createPreparedAttempt(coreDb, `lease_${suffix}`);
      completeTerminalAttempt(coreDb, {
        id: `turn_${suffix}`,
        workspaceId: 'ws_demo',
        threadId: `thread_${suffix}`,
        status: turnStatus,
      });

      await releaseModeledAttempt(coreDb, `lease_${suffix}`);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closed');
      const first = observeExecutionAttempts(coreDb).find(
        (row) => row.attempt_id === `lease_${suffix}`
      )!;
      expect(first.terminal_cause).toEqual(expect.any(String));
      expect(first.outcome_ref).toBe(`turn:turn_${suffix}:${turnStatus}`);
      /** Projects only closed-core facts; evidence, diagnostics and timestamps may refine. */
      const protectedFacts = (db: typeof coreDb) => {
        const rows = observeExecutionAttempts(db);
        const row = rows.find((candidate) => candidate.attempt_id === first.attempt_id);
        expect(row).toBeDefined();
        expect(row!.disposition).toBe('unknown');
        expect(row!.operation_id).toBe(`fixture-submit:lease_${suffix}`);
        expect(row!.fence_ref).toBe(`self-check:lease_${suffix}`);
        expect(rows.filter((candidate) => candidate.phase !== 'closed')).toEqual([]);
        expect(rows.map((candidate) => candidate.attempt_id)).toEqual([first.attempt_id]);
        return {
          attemptId: row!.attempt_id,
          phase: row!.phase,
          firstTerminalCause: row!.terminal_cause,
          outcomeRef: row!.outcome_ref,
          disposition: row!.disposition,
          fenceRef: row!.fence_ref,
        };
      };
      const protectedFirst = protectedFacts(coreDb);
      // Product closeout replay protects these facts without freezing lawful evidence refinement.
      for (const lateStatus of [turnStatus, turnStatus === 'completed' ? 'failed' : 'completed']) {
        try {
          completeTerminalAttempt(coreDb, {
            id: `turn_${suffix}`,
            workspaceId: 'ws_demo',
            threadId: `thread_${suffix}`,
            status: lateStatus,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        expect(protectedFacts(coreDb)).toEqual(protectedFirst);
      }
      const reopened = openCoreDb(coreDb.dataRoot);
      try {
        for (const lateStatus of [
          turnStatus,
          turnStatus === 'completed' ? 'failed' : 'completed',
        ]) {
          try {
            completeTerminalAttempt(reopened, {
              id: `turn_${suffix}`,
              workspaceId: 'ws_demo',
              threadId: `thread_${suffix}`,
              status: lateStatus,
            });
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
          }
          expect(protectedFacts(reopened)).toEqual(protectedFirst);
        }
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps a non-terminal Turn attempt open', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_turn_running');
      completeTerminalAttempt(coreDb, {
        id: 'turn_turn_running',
        workspaceId: 'ws_demo',
        threadId: 'thread_turn_running',
        status: 'running',
      });

      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_turn_running'
        )?.phase
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('classifies NanoHost startup timeout before any accepted process', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_startup_timeout');

      expect(
        resolveAttemptRoute(coreDb, 'lease_startup_timeout', '2026-07-05T00:26:00.000Z')
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
      expect(
        attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, 'lease_startup_timeout')
      ).toMatchObject({ phase: 'open', disposition: 'unknown', fenceRef: null });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains the native fence when an anchored startup times out', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_anchored_startup_timeout');
      seedBackendRuntimeTarget(coreDb);
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: 'session_anchored_startup_timeout',
          backendKind: 'openshell',
          backendSessionId: 'openkit-session_anchored_startup_timeout',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'pkg_demo',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/pkg_demo',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: 'thread_anchored_startup_timeout',
          turnId: 'turn_anchored_startup_timeout',
          workspaceId: 'ws_demo',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: 'lease-binding:lease_anchored_startup_timeout',
      });

      expect(
        resolveAttemptRoute(coreDb, 'lease_anchored_startup_timeout', '2026-07-05T00:26:00.000Z')
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
      expect(
        attemptActionOwners.requireSchedulerExecutionAttempt(
          coreDb,
          'lease_anchored_startup_timeout'
        )
      ).toMatchObject({ phase: 'open', disposition: 'unknown', fenceRef: null });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not fail startup deadlines after the first heartbeat is accepted', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_started');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        attemptId: 'lease_started',
        workerSequence: 1,
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });

      for (let sequence = 2; sequence <= 78; sequence += 1) {
        acceptNanoHostAttemptHeartbeat(coreDb, {
          attemptId: 'lease_started',
          workerSequence: sequence,
          heartbeatTimeoutMs: 30_000,
          now: () =>
            new Date(
              Date.parse('2026-07-05T00:00:10.000Z') + (sequence - 1) * 20_000
            ).toISOString(),
        });
      }
      expect(
        resolveAttemptRoute(coreDb, 'lease_started', '2026-07-05T00:26:00.000Z')
      ).toMatchObject({ status: 'accepted' });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_started')
          ?.phase
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('revokes a closing attempt without dropping exclusion', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_releasing');

      beginOwnedAttemptCloseout(coreDb, {
        attemptId: 'lease_releasing',
        now: () => '2026-07-05T00:00:10.000Z',
        firstTerminalCause: 'worker-final-status',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_releasing')
          ?.phase
      ).toBe('closing');
      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_releasing',
          lineage: {
            agentSessionId: 'session_releasing',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_releasing',
            turnId: 'turn_releasing',
            workspaceId: 'ws_demo',
          },
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves exclusion for an unanchored closing attempt after Native timeout', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_recovery_stale');
      createPreparedAttempt(coreDb, 'lease_recovery_release');
      createPreparedAttempt(coreDb, 'lease_recovery_startup');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: 'lease_recovery_stale',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      expect(
        resolveAttemptRoute(coreDb, 'lease_recovery_stale', '2026-07-05T00:26:00.000Z')
      ).toMatchObject({ status: 'rejected' });
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: 'lease_recovery_release',
        now: () => '2026-07-05T00:00:10.000Z',
        firstTerminalCause: 'worker-final-status',
      });
      await runSchedulerRecoveryMaintenance(coreDb, {
        executionBackend: createConfiguredWorkerLifecycleRuntime({ coreDb, env: {} }).turnExecutor
          .executionBackend!,
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:26:00.000Z',
      });
      expect(
        resolveAttemptRoute(coreDb, 'lease_recovery_startup', '2026-07-05T00:26:00.000Z')
      ).toMatchObject({ status: 'rejected' });
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_recovery_release'
        )?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('resolves live route credentials through the exact durable attempt', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_binding');

      const resolution = resolveNanoHostAttemptTokenBinding(coreDb, {
        sandboxBindingRef: 'lease-binding:lease_binding',
        now: () => '2026-07-05T00:00:10.000Z',
        lineage: {
          agentSessionId: 'session_binding',
          packageSnapshotId: 'pkg_demo',
          threadId: 'thread_binding',
          turnId: 'turn_binding',
          workspaceId: 'ws_demo',
        },
      });

      expect(resolution).toMatchObject({ status: 'accepted' });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_binding')
      ).toMatchObject({
        phase: 'open',
        turn_id: 'turn_binding',
        agent_session_id: 'session_binding',
        binding_ref: 'lease-binding:lease_binding',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects an expired lease token binding at request time', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_binding_expired');

      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          lineage: {
            agentSessionId: 'session_binding_expired',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_binding_expired',
            turnId: 'turn_binding_expired',
            workspaceId: 'ws_demo',
          },
          now: () => '2026-07-05T02:01:00.000Z',
          sandboxBindingRef: 'lease-binding:lease_binding_expired',
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a lease token binding after its startup deadline', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_binding_startup_timeout');

      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          lineage: {
            agentSessionId: 'session_binding_startup_timeout',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_binding_startup_timeout',
            turnId: 'turn_binding_startup_timeout',
            workspaceId: 'ws_demo',
          },
          now: () => '2026-07-05T00:26:00.000Z',
          sandboxBindingRef: 'lease-binding:lease_binding_startup_timeout',
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a started lease token binding after its heartbeat deadline', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_binding_heartbeat_timeout');
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: 'lease_binding_heartbeat_timeout',
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });

      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          lineage: {
            agentSessionId: 'session_binding_heartbeat_timeout',
            packageSnapshotId: 'pkg_demo',
            threadId: 'thread_binding_heartbeat_timeout',
            turnId: 'turn_binding_heartbeat_timeout',
            workspaceId: 'ws_demo',
          },
          now: () => '2026-07-05T00:00:41.000Z',
          sandboxBindingRef: 'lease-binding:lease_binding_heartbeat_timeout',
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects missing, mismatched, and non-live lease token bindings', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_binding_rejected');
      const lineage = {
        agentSessionId: 'session_binding_rejected',
        packageSnapshotId: 'pkg_demo',
        threadId: 'thread_binding_rejected',
        turnId: 'turn_binding_rejected',
        workspaceId: 'ws_demo',
      };

      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:missing',
          lineage,
        })
      ).toEqual({ status: 'rejected', reason: 'binding-not-found' });
      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_binding_rejected',
          lineage: { ...lineage, threadId: 'thread_other' },
        })
      ).toEqual({ status: 'rejected', reason: 'lineage-mismatch' });

      beginOwnedAttemptCloseout(coreDb, {
        attemptId: 'lease_binding_rejected',
        outcome: 'completed',
        firstTerminalCause: 'completed',
      });

      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          sandboxBindingRef: 'lease-binding:lease_binding_rejected',
          lineage,
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('skips queued entries whose Thread already owns a live attempt', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_thread_first',
        requestId: 'request_first',
        workspaceId: 'ws_demo',
        threadId: 'thread_shared',
        turnId: 'turn_thread_first',
        turnInput: 'Run first shared-thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const first = findNextDispatchableSchedulerAdmissionEntry(coreDb)!;
      expect(first.queueEntryId).toBe('queue_thread_first');
      attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
        entry: first,
        attemptId: 'attempt_thread_first',
        preparationInput: { admission: first },
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_thread_second',
        requestId: 'request_second',
        workspaceId: 'ws_demo',
        threadId: 'thread_shared',
        turnId: 'turn_thread_second',
        turnInput: 'Run second shared-thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:03.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_thread_other',
        workspaceId: 'ws_demo',
        threadId: 'thread_other',
        turnId: 'turn_thread_other',
        turnInput: 'Run other thread turn',
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:04.000Z',
      });

      const second = findNextDispatchableSchedulerAdmissionEntry(coreDb)!;
      expect(second.queueEntryId).toBe('queue_thread_other');
      attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
        entry: second,
        attemptId: 'attempt_thread_other',
        preparationInput: { admission: second },
      });
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_thread_second']);
      expect(findNextDispatchableSchedulerAdmissionEntry(coreDb)).toBeNull();
      expect(requireSchedulerAdmissionEntry(coreDb, 'queue_thread_second').status).toBe('queued');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/** Models settled product barriers and exercises the real Native release consumer over retained physical proof. */
async function closeOwnedExecutionAttempt(
  db: ReturnType<typeof openCoreDb>,
  input: { attemptId: string; firstTerminalCause: string; outcome?: string; now?: () => string }
) {
  const closing = attemptActionOwners.markSchedulerExecutionAttemptClosing(db, {
    attemptId: input.attemptId,
    cause: input.firstTerminalCause,
    ...(input.outcome ? { outcomeRef: input.outcome } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const correlation = attemptActionOwners.schedulerExecutionCorrelation(closing);
  const proof = {
    terminalHandoff: true,
    output: true,
    evidence: true,
    outsideWorkspaceCollection: true,
    integrationDrain: true,
    routesRevoked: true,
  } as const;
  const backend = createConfiguredWorkerLifecycleRuntime({ coreDb: db, env: {} }).turnExecutor
    .executionBackend!;
  const result = await backend.release({ ...correlation, proof });
  if (result.state === 'released')
    attemptActionOwners.closeSchedulerExecutionAttemptWithFence(db, {
      correlation,
      proof,
      fenceRef: result.fenceRef!,
    });
  return result;
}

/** Revokes authority without release; terminal product state does not supply a fence. */
function beginOwnedAttemptCloseout(
  db: ReturnType<typeof openCoreDb>,
  input: { attemptId: string; firstTerminalCause: string; outcome?: string; now?: () => string }
) {
  return attemptActionOwners.markSchedulerExecutionAttemptClosing(db, {
    attemptId: input.attemptId,
    cause: input.firstTerminalCause,
    ...(input.outcome ? { outcomeRef: input.outcome } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

/** Only this explicit simulator fixture owns vacuous output/physical barriers; no Native absence is treated as proof. */
async function releaseModeledAttempt(
  db: ReturnType<typeof openCoreDb>,
  attemptId: string
): Promise<void> {
  const closing = attemptActionOwners.requireSchedulerExecutionAttempt(db, attemptId);
  const correlation = attemptActionOwners.schedulerExecutionCorrelation(closing);
  const proof = {
    terminalHandoff: true,
    output: true,
    evidence: true,
    outsideWorkspaceCollection: true,
    integrationDrain: true,
    routesRevoked: true,
  } as const;
  const result = await new SimulatedTurnExecutor({ coreDb: db }).release({ ...correlation, proof });
  attemptActionOwners.closeSchedulerExecutionAttemptWithFence(db, {
    correlation,
    proof,
    fenceRef: result.fenceRef!,
  });
}

/** Resolves the unchanged private route gate at an exact timestamp without mutating generic Core. */
function resolveAttemptRoute(
  db: ReturnType<typeof openCoreDb>,
  attemptId: string,
  timestamp: string
) {
  const attempt = requireNanoHostExecutionAttempt(db, attemptId);
  return resolveNanoHostAttemptTokenBinding(db, {
    sandboxBindingRef: attempt.bindingRef!,
    now: () => timestamp,
    lineage: {
      workspaceId: attempt.workspaceId,
      threadId: attempt.threadId,
      turnId: attempt.turnId,
      agentSessionId: attempt.agentSessionId!,
      packageSnapshotId: attempt.inputRef!,
    },
  });
}
