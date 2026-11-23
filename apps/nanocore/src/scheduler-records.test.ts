import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@openkit/protocol/digest';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import * as attemptActionOwners from './runtime/execution-attempt-records.js';
import { runSchedulerRecoveryMaintenance } from './runtime/scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from './runtime/turn-executor-factory.js';
import { recordWorkerBackendSessionMaterializing } from './runtime/worker-backend-sessions.js';
import {
  type CoreSchedulerQueueEntry,
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  findNextDispatchableSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  readQueuedSchedulerAdmissionEntriesInOrder,
  readSchedulerAdmissionPagesForWorkspace,
  requireSchedulerAdmissionEntry,
  retryDeniedSchedulerAdmissionEntry,
} from './scheduler-records';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db';
import { ExecutionAttemptRefusal } from './storage/execution-attempt-codecs.js';
import { applyMigrations } from './storage/migrate';
import { readNanoHostRecoveryLease } from './storage/nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from './storage/nanohost-submitted-lease.js';
import { resolveAdmittedNanoHostWorkerBinding } from './storage/nanohost-worker-binding.js';
import {
  currentAdmittedTestNanoHostOwner,
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
  testNanoHostRecoveryJoins,
} from './test-support/admitted-nanohost.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  postTestNativeWorkerHeartbeat,
  readTestNanoHostWorkerLease,
  removeTestNativeWorkerAnchor,
  seedTestNanoHostHeartbeat,
  submitTestNanoHostWorkerLease,
} from './test-support/nanohost-worker-lease.js';
import { recordTestNativeRuntimeTarget } from './test-support/native-environment.js';
import { TEST_WORKER_RELEASE_IDENTITY } from './test-support/release-identity.js';
import { schedulerFixtureInput as fixtureSchedulerInput } from './test-support/scheduler-admissions.js';
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
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  return coreDb;
}

/** Seeds the current physical Epoch required by backend-anchor fixtures. */
async function seedBackendRuntimeTarget(
  coreDb: ReturnType<typeof createMigratedCoreDb>
): Promise<void> {
  await recordTestNativeRuntimeTarget(coreDb, 'runtime-target-test', {
    deploymentId: 'deployment-test',
    identityId: 'identity-test',
    allocationAt: '2026-07-05T00:00:00.000Z',
    readyAt: '2026-07-05T00:00:01.000Z',
  });
}

/**
 * Establishes prepared and submitted Native authority for record-owner regressions.
 * @param coreDb Database owning the admission and attempt.
 * @param fixtureKey Fixture label used to allocate and retain exact canonical lineage.
 * @returns Prepared attempt with its admitted Native binding.
 */
function createPreparedAttempt(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  fixtureKey: string,
  submitted = true
) {
  const attemptId = testEntityId('attempt', fixtureKey);
  const suffix = fixtureKey.replace('lease_', '');
  const entry = createSchedulerRecordAdmission(coreDb, suffix);
  return recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId,
    agentSessionId: testEntityId('as', `session_${suffix}`),
    inputRef: 'pkg_demo',
    bindingRef: `lease-binding:${attemptId}`,
    sessionCompatibilityKey: `sha256:${suffix}`,
    now: () => '2026-07-05T00:00:02.000Z',
    ...(submitted ? { operationId: `fixture-submit:${attemptId}` } : {}),
  });
}

/** Retains the same scheduler request for either fixture contract. */
function createSchedulerRecordAdmission(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string
) {
  return createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    queueEntryId: `queue_${suffix}`,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: testEntityId('th', `thread_${suffix}`),
    turnId: testEntityId('tu', `turn_${suffix}`),
    inputRef: fixtureSchedulerInput(
      'ws_00000000-0000-7000-8000-000000000001',
      testEntityId('tu', `turn_${suffix}`),
      `Run Native attempt ${suffix}`
    ),
    requestedAgentId: 'agent_worker',
    now: () => '2026-07-05T00:00:00.000Z',
  });
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
      (attempt) => attempt.attempt_id === testEntityId('attempt', `lease_${suffix}`)
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
      coreDb.sqlite.pragma('foreign_keys = OFF');
      try {
        coreDb.sqlite
          .prepare('DELETE FROM scheduler_admission_entries WHERE queue_entry_id = ?')
          .run(`queue_${suffix}`);
      } finally {
        coreDb.sqlite.pragma('foreign_keys = ON');
      }
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
  turn: Parameters<typeof attemptActionOwners.markSchedulerAttemptForTerminalTurn>[1]
) {
  return attemptActionOwners.markSchedulerAttemptForTerminalTurn(coreDb, turn);
}

describe('scheduler records', () => {
  it('retains v1 admission and only the non-secret presented administrator token id across reopen', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-token-'));
    onTestFinished(() => rmSync(dataRoot, { force: true, recursive: true }));
    const first = openCoreDb(dataRoot);
    let retainedRow: unknown;
    try {
      applyMigrations(first);
      const input = {
        backendId: 'nanohost',
        queueEntryId: 'queue_admin_token',
        serverAdminTokenId: 'token_admin_1',
        triggerActor: { kind: 'user' as const, id: 'usr_00000000-0000-768a-8658-44c33d82c1f5' },
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        threadId: 'th_00000000-0000-7267-800d-a65e1b6a22d7',
        turnId: testEntityId('tu', 'turn_1'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-73c3-900f-8d310e4ba201',
          testEntityId('tu', 'turn_1'),
          'Run task'
        ),
        requestedAgentId: 'assistant',
        workspaceRoots: [
          {
            id: 'repo',
            sourceKind: 'host-dir' as const,
            sourcePath: '/host/project',
            workerPath: '/workspace/project',
            access: 'read-write' as const,
          },
        ],
      };
      createSchedulerAdmissionEntry(first, input);
      expect(
        first.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM scheduler_admission_entries')
          .get()
      ).toEqual({ schemaVersion: 1 });
      first.sqlite
        .prepare(`UPDATE scheduler_admission_entries
        SET trigger_actor_json = ?, workspace_roots_json = ? WHERE queue_entry_id = ?`)
        .run(
          JSON.stringify({ ...input.triggerActor, description: 'Retained actor annotation.' }),
          JSON.stringify(
            input.workspaceRoots.map((root) => ({
              ...root,
              description: 'Retained root annotation.',
            }))
          ),
          input.queueEntryId
        );
      retainedRow = first.sqlite
        .prepare(`SELECT schema_version AS schemaVersion,
        trigger_actor_json, workspace_roots_json FROM scheduler_admission_entries`)
        .get();
      expect(createSchedulerAdmissionEntry(first, input)).toMatchObject({
        triggerActor: input.triggerActor,
        workspaceRoots: input.workspaceRoots,
      });
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
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-768a-8658-44c33d82c1f5' },
        workspaceRoots: [
          {
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/host/project',
            workerPath: '/workspace/project',
            access: 'read-write',
          },
        ],
      });
      expect(listQueuedSchedulerAdmissionEntries(reopened)[0]?.triggerActor).not.toHaveProperty(
        'description'
      );
      expect(
        listQueuedSchedulerAdmissionEntries(reopened)[0]?.workspaceRoots[0]
      ).not.toHaveProperty('description');
      expect(
        reopened.sqlite
          .prepare(`SELECT schema_version AS schemaVersion,
        trigger_actor_json, workspace_roots_json FROM scheduler_admission_entries`)
          .get()
      ).toEqual(retainedRow);
      expect(
        reopened.sqlite
          .prepare('SELECT server_admin_token_id FROM scheduler_admission_entries')
          .get()
      ).toEqual({ server_admin_token_id: 'token_admin_1' });
    } finally {
      reopened.sqlite.close();
    }
  });

  it('refuses an unknown admission version before JSON decode, replay or status changes', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-version-'));
    onTestFinished(() => rmSync(dataRoot, { force: true, recursive: true }));
    const coreDb = openCoreDb(dataRoot);
    const input = {
      backendId: 'nanohost',
      queueEntryId: 'queue_unknown_version',
      triggerActor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: testEntityId('th', 'thread_unknown_version'),
      turnId: testEntityId('tu', 'turn_unknown_version'),
      inputRef: fixtureSchedulerInput(
        'ws_00000000-0000-7000-8000-000000000001',
        testEntityId('tu', 'turn_unknown_version'),
        'Keep retained admission unchanged'
      ),
      requestedAgentId: 'assistant',
    };
    try {
      applyMigrations(coreDb);
      createSchedulerAdmissionEntry(coreDb, input);
      coreDb.sqlite
        .prepare(`UPDATE scheduler_admission_entries
        SET schema_version = 2, trigger_actor_json = '{', workspace_roots_json = '{'
        WHERE queue_entry_id = ?`)
        .run(input.queueEntryId);

      expect(() => requireSchedulerAdmissionEntry(coreDb, input.queueEntryId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => listQueuedSchedulerAdmissionEntries(coreDb)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        createSchedulerAdmissionEntry(coreDb, {
          ...input,
          inputRef: { ...input.inputRef, digest: sha256Hex('Changed input') },
        })
      ).toThrow('Unsupported retained record format.');
      expect(() =>
        denySchedulerAdmissionEntry(coreDb, {
          queueEntryId: input.queueEntryId,
          denialReason: 'invalid-request',
        })
      ).toThrow('Unsupported retained record format.');
      expect(() => cancelSchedulerAdmissionEntry(coreDb, input)).toThrow(
        'Unsupported retained record format.'
      );
      expect(
        coreDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, status,
        trigger_actor_json, workspace_roots_json FROM scheduler_admission_entries`)
          .get()
      ).toEqual({
        schemaVersion: 2,
        status: 'queued',
        trigger_actor_json: '{',
        workspace_roots_json: '{',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('persists admission queue entries in committed FIFO order without priority policy', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_automation',
        workspaceId: 'ws_00000000-0000-7b97-bc3d-37f962735158',
        threadId: testEntityId('th', 'thread_b'),
        turnId: testEntityId('tu', 'turn_b'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7b97-bc3d-37f962735158',
          testEntityId('tu', 'turn_b'),
          'Run automation work'
        ),
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:02.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_goal_fresh',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        workspaceId: 'ws_00000000-0000-7509-8702-098e8909b075',
        threadId: testEntityId('th', 'thread_goal'),
        turnId: testEntityId('tu', 'turn_goal'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7509-8702-098e8909b075',
          testEntityId('tu', 'turn_goal'),
          'Run fresh Goal work'
        ),
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
          id: 'auto_00000000-0000-7618-af97-ff26fae216d4',
          responsibleUserId: 'usr_00000000-0000-7852-8b54-762f114b9c0a',
        },
        workspaceId: 'ws_00000000-0000-7159-b04f-df2eaa9abaf0',
        threadId: testEntityId('th', 'thread_a'),
        turnId: testEntityId('tu', 'turn_a'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7159-b04f-df2eaa9abaf0',
          testEntityId('tu', 'turn_a'),
          'Run interactive work'
        ),
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
          adjudicatedThreadIds: [testEntityId('th', 'thread_predecessor')],
          expectedRevision: 7,
          goalId: 'goal_a',
          kind: 'selected',
          purpose: 'work',
          reuseWorkSlotRef: 'wsl_predecessor',
          storageRef: 'wst_00000000-0000-77ec-b7e9-3fa6a72e99a1',
          taskId: 'task_a',
        },
        now: () => '2026-07-05T00:00:03.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_maintenance',
        workspaceId: 'ws_00000000-0000-7700-9168-e31a19301e5a',
        threadId: testEntityId('th', 'thread_c'),
        turnId: testEntityId('tu', 'turn_c'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7700-9168-e31a19301e5a',
          testEntityId('tu', 'turn_c'),
          'Run maintenance work'
        ),
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
        )?.inputRef.digest
      ).toBe(sha256Hex('Run interactive work'));
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).find(
          (entry) => entry.queueEntryId === 'queue_interactive'
        )?.triggerActor
      ).toEqual({
        kind: 'automation',
        id: 'auto_00000000-0000-7618-af97-ff26fae216d4',
        responsibleUserId: 'usr_00000000-0000-7852-8b54-762f114b9c0a',
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
        adjudicatedThreadIds: [testEntityId('th', 'thread_predecessor')],
        expectedRevision: 7,
        goalId: 'goal_a',
        kind: 'selected',
        purpose: 'work',
        reuseWorkSlotRef: 'wsl_predecessor',
        storageRef: 'wst_00000000-0000-77ec-b7e9-3fa6a72e99a1',
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
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_bad_storage_choice',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_bad_storage_choice'),
        turnId: testEntityId('tu', 'turn_bad_storage_choice'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_bad_storage_choice'),
          'Reject malformed storage choice'
        ),
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
          JSON.stringify({ kind: 'fresh', storageRef: 'wst_00000000-0000-74af-9710-256527cd7cc8' }),
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
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_one',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_demo'),
        turnId: testEntityId('tu', 'turn_demo'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_demo'),
          'Run first queued turn'
        ),
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:00.000Z',
      });

      expect(() =>
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          queueEntryId: 'queue_two',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: testEntityId('th', 'thread_demo'),
          turnId: testEntityId('tu', 'turn_demo'),
          inputRef: fixtureSchedulerInput(
            'ws_00000000-0000-7000-8000-000000000001',
            testEntityId('tu', 'turn_demo'),
            'Run duplicate queued turn'
          ),
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
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_denied',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_demo'),
        turnId: testEntityId('tu', 'turn_demo'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_demo'),
          'Run denied turn'
        ),
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
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7814-ae85-578d000c895b' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_demo'),
        turnId: testEntityId('tu', 'turn_demo'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_demo'),
          'Run denied turn again'
        ),
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      expect(retried.status).toBe('queued');
      expect(retried.denialReason).toBeNull();
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_retry_denied']);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          statuses: ['queued'],
        })
      ).toEqual([
        expect.objectContaining({
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7814-ae85-578d000c895b' },
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
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7814-ae85-578d000c895b' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_demo'),
        turnId: testEntityId('tu', 'turn_demo'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_demo'),
          'Cancel this turn'
        ),
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:00.000Z',
      });

      const cancelled = cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_cancel',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.denialReason).toBeNull();
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(terminalAccountingCorruptions)(
    'refuses Native terminal inspection without changing either owner for $name',
    async ({ apply, expectedError, name }) => {
      const coreDb = createMigratedCoreDb();
      const suffix = `terminal_corrupt_${name.replaceAll(' ', '_')}`;

      try {
        const original = createPreparedAttempt(coreDb, `lease_${suffix}`);
        const correlation = attemptActionOwners.schedulerExecutionCorrelation(original);
        apply(coreDb, suffix);
        const before = terminalAccountingSnapshot(coreDb, suffix);

        const backend = createConfiguredWorkerLifecycleRuntime({
          releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
          coreDb,
          env: {},
        }).turnExecutor.executionBackend!;
        await expect(backend.inspect(correlation)).rejects.toThrow(expectedError);
        expect(terminalAccountingSnapshot(coreDb, suffix)).toEqual(before);
      } finally {
        coreDb.sqlite.close();
      }
    }
  );

  it('blocks attempt closeout until the backend session is durably cleaned', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      const {
        value: { owner },
      } = await openAdmittedTestNanoHost(coreDb);
      const entry = createSchedulerRecordAdmission(coreDb, 'cleanup_barrier');
      const attemptId = testEntityId('attempt', 'lease_cleanup_barrier');
      const prepared = submitTestNanoHostWorkerLease(
        coreDb,
        entry,
        `lease-binding:${attemptId}`,
        {
          agentSessionId: testEntityId('as', 'session_cleanup_barrier'),
          packageSnapshotId: 'pkg_demo',
          workerControlTokenHash: 'a'.repeat(64),
          workerInferenceTokenHash: 'b'.repeat(64),
          workerCapabilityTokenHash: 'c'.repeat(64),
        },
        { attemptId, observedAt: '2026-07-05T00:00:02.000Z' }
      );
      const placement = owner.readRuntimeTarget(`test-target-${entry.turnId}`);
      if (placement.state !== 'ready' || !placement.value)
        throw new Error('Fixture has no admitted RuntimeTarget.');
      const target = placement.value;

      expect(
        await closeOwnedExecutionAttempt(coreDb, {
          attemptId: testEntityId('attempt', 'lease_cleanup_barrier'),
          firstTerminalCause: 'turn-failed',
          outcome: 'failed',
        })
      ).toMatchObject({ state: 'pending', fenceRef: null });
      completeTerminalAttempt(coreDb, {
        id: testEntityId('tu', 'turn_cleanup_barrier'),
        status: 'failed',
        threadId: testEntityId('th', 'thread_cleanup_barrier'),
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_cleanup_barrier')
        )?.phase
      );

      const commitCleanupStage = async (
        toState: 'cleanup-pending' | 'physical-cleaned',
        observedAt: string
      ) => {
        const { lease } = readRetainedNanoHostSubmission(coreDb, prepared.attemptId)!;
        const { session, proof } = readAdmittedTestNanoHost(coreDb, (sqlite) =>
          readNanoHostRecoveryLease(sqlite, lease)
        );
        const result = await owner.classifyRecovery({
          kind: 'transition',
          lease,
          target,
          expectedSession: session,
          expectedRecovery: proof,
          toState,
          observedAt,
        });
        if (result.state !== 'ready')
          throw new Error(`Native cleanup ${toState} was not acknowledged: ${result.reason}`);
      };
      await commitCleanupStage('cleanup-pending', '2026-07-05T00:00:10.000Z');
      await commitCleanupStage('physical-cleaned', '2026-07-05T00:00:11.000Z');
      completeTerminalAttempt(coreDb, {
        id: testEntityId('tu', 'turn_cleanup_barrier'),
        status: 'failed',
        threadId: testEntityId('th', 'thread_cleanup_barrier'),
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_cleanup_barrier')
        )?.phase
      );
      await owner.backendSession({
        kind: 'transition',
        fromState: 'physical-cleaned',
        attemptId: testEntityId('attempt', 'lease_cleanup_barrier'),
        toState: 'cleaned',
      });
      completeTerminalAttempt(coreDb, {
        id: testEntityId('tu', 'turn_cleanup_barrier'),
        status: 'failed',
        threadId: testEntityId('th', 'thread_cleanup_barrier'),
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      });
      expect(
        await closeOwnedExecutionAttempt(coreDb, {
          attemptId: testEntityId('attempt', 'lease_cleanup_barrier'),
          firstTerminalCause: 'turn-failed',
          outcome: 'failed',
        })
      ).toMatchObject({ state: 'released' });
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_cleanup_barrier')
        )?.phase
      ).toBe('closed');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(['releasing'] as const)(
    'holds exclusion for %s NanoHost observations that are missing their durable backend anchor',
    async (status) => {
      const coreDb = createMigratedCoreDb();

      try {
        await openAdmittedTestNanoHost(coreDb);
        createPreparedAttempt(coreDb, `lease_missing_anchor_${status}`);
        beginOwnedAttemptCloseout(coreDb, {
          attemptId: testEntityId('attempt', `lease_missing_anchor_${status}`),
          now: () => '2026-07-05T00:00:10.000Z',
          firstTerminalCause: 'worker-final-status',
        });

        expect(
          await closeOwnedExecutionAttempt(coreDb, {
            attemptId: testEntityId('attempt', `lease_missing_anchor_${status}`),
            firstTerminalCause: 'turn-failed',
            outcome: 'failed',
          })
        ).toMatchObject({ state: 'pending', fenceRef: null });
        expect(['open', 'closing']).toContain(
          observeExecutionAttempts(coreDb).find(
            (attempt) =>
              attempt.attempt_id === testEntityId('attempt', `lease_missing_anchor_${status}`)
          )?.phase
        );
      } finally {
        coreDb.sqlite.close();
      }
    }
  );

  it('preserves closing exclusion while backend cleanup is incomplete', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      const prepared = createPreparedAttempt(coreDb, 'lease_cleanup_grace', false);
      await seedBackendRuntimeTarget(coreDb);
      const {
        value: { owner },
      } = await openAdmittedTestNanoHost(coreDb);
      await recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId: testEntityId('as', 'session_cleanup_grace'),
          backendKind: 'openshell',
          backendSessionId: 'openkit-session_cleanup_grace',
          deploymentId: 'deployment-test',
          packageSnapshotId: 'pkg_demo',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/pkg_demo',
          transientProviderInstanceId: null,
        },
        lineage: {
          threadId: testEntityId('th', 'thread_cleanup_grace'),
          turnId: testEntityId('tu', 'turn_cleanup_grace'),
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
        now: () => '2026-07-05T00:00:03.000Z',
        sandboxBindingRef: `lease-binding:${testEntityId('attempt', 'lease_cleanup_grace')}`,
      });
      attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
        attemptId: prepared.attemptId,
        operationId: `fixture-submit:${prepared.attemptId}`,
        submission: true,
        now: () => '2026-07-05T00:00:02.000Z',
      });
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: testEntityId('attempt', 'lease_cleanup_grace'),
        now: () => '2026-07-05T00:00:10.000Z',
        firstTerminalCause: 'worker-final-status',
      });

      await runSchedulerRecoveryMaintenance(coreDb, {
        executionBackend: createConfiguredWorkerLifecycleRuntime({
          releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
          coreDb,
          env: {},
          nanoHostRecovery: testNanoHostRecoveryJoins({ value: { owner } }),
        }).turnExecutor.executionBackend!,
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:05:11.000Z',
      });
      await owner.backendSession({
        kind: 'transition',
        fromState: 'materializing',
        attemptId: testEntityId('attempt', 'lease_cleanup_grace'),
        toState: 'cleanup-pending',
      });
      await owner.backendSession({
        kind: 'transition',
        fromState: 'cleanup-pending',
        attemptId: testEntityId('attempt', 'lease_cleanup_grace'),
        toState: 'physical-cleaned',
      });
      await owner.backendSession({
        kind: 'transition',
        fromState: 'physical-cleaned',
        attemptId: testEntityId('attempt', 'lease_cleanup_grace'),
        toState: 'cleaned',
      });
      await runSchedulerRecoveryMaintenance(coreDb, {
        executionBackend: createConfiguredWorkerLifecycleRuntime({
          releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
          coreDb,
          env: {},
          nanoHostRecovery: testNanoHostRecoveryJoins({ value: { owner } }),
        }).turnExecutor.executionBackend!,
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:05:12.000Z',
      });
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_cleanup_grace')
        )?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each(['completed', 'interrupted', 'cancelled', 'failed'] as const)(
    'closes the exact attempt for %s product turns after complete cleanup',
    async (turnStatus) => {
      const coreDb = createMigratedCoreDb();
      const suffix = `turn_${turnStatus}`;

      try {
        createPreparedAttempt(coreDb, `lease_${suffix}`);
        completeTerminalAttempt(coreDb, {
          id: testEntityId('tu', `turn_${suffix}`),
          owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          threadId: testEntityId('th', `thread_${suffix}`),
          status: turnStatus,
        });

        await releaseModeledAttempt(coreDb, testEntityId('attempt', `lease_${suffix}`));
        const attemptId = testEntityId('attempt', `lease_${suffix}`);
        // The terminal product outcome and fence are projected from the Core lifecycle steps
        // (`execution-attempt-records.ts`); the attempt row no longer carries them.
        const first = attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, attemptId);
        expect(first.phase).toBe('closed');
        expect(first.terminalCause).toEqual(expect.any(String));
        expect(first.outcomeRef).toBe(`turn:${testEntityId('tu', `turn_${suffix}`)}:${turnStatus}`);
        /** Projects only closed-core facts; evidence, diagnostics and timestamps may refine. */
        const protectedFacts = (db: typeof coreDb) => {
          const row = attemptActionOwners.requireSchedulerExecutionAttempt(db, attemptId);
          expect(row.disposition).toBe('unknown');
          expect(row.operationId).toBe(`fixture-submit:${attemptId}`);
          expect(row.fenceRef).toBe(`self-check:${attemptId}`);
          const rows = observeExecutionAttempts(db);
          expect(rows.filter((candidate) => candidate.phase !== 'closed')).toEqual([]);
          expect(rows.map((candidate) => candidate.attempt_id)).toEqual([attemptId]);
          return {
            attemptId: row.attemptId,
            phase: row.phase,
            firstTerminalCause: row.terminalCause,
            outcomeRef: row.outcomeRef,
            disposition: row.disposition,
            fenceRef: row.fenceRef,
          };
        };
        const protectedFirst = protectedFacts(coreDb);
        // Product closeout replay protects these facts without freezing lawful evidence refinement.
        for (const lateStatus of [
          turnStatus,
          turnStatus === 'completed' ? 'failed' : 'completed',
        ]) {
          try {
            completeTerminalAttempt(coreDb, {
              id: testEntityId('tu', `turn_${suffix}`),
              owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
              threadId: testEntityId('th', `thread_${suffix}`),
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
                id: testEntityId('tu', `turn_${suffix}`),
                owner: {
                  kind: 'workspace',
                  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                },
                threadId: testEntityId('th', `thread_${suffix}`),
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
    }
  );

  it('keeps a non-terminal Turn attempt open', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createPreparedAttempt(coreDb, 'lease_turn_running');
      completeTerminalAttempt(coreDb, {
        id: testEntityId('tu', 'turn_turn_running'),
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: testEntityId('th', 'thread_turn_running'),
        status: 'running',
      });

      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_turn_running')
        )?.phase
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('skips queued entries whose Thread already owns a live attempt', () => {
    const coreDb = createMigratedCoreDb();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_thread_first',
        requestId: 'request_first',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_shared'),
        turnId: testEntityId('tu', 'turn_thread_first'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_thread_first'),
          'Run first shared-thread turn'
        ),
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const first = findNextDispatchableSchedulerAdmissionEntry(coreDb)!;
      expect(first.queueEntryId).toBe('queue_thread_first');
      attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
        entry: first,
        attemptId: 'attempt_00000000-0000-7fb6-b1e2-8a89e0747cd8',
        preparationInput: { admission: first },
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_thread_second',
        requestId: 'request_second',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_shared'),
        turnId: testEntityId('tu', 'turn_thread_second'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_thread_second'),
          'Run second shared-thread turn'
        ),
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:03.000Z',
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: 'queue_thread_other',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: testEntityId('th', 'thread_other'),
        turnId: testEntityId('tu', 'turn_thread_other'),
        inputRef: fixtureSchedulerInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', 'turn_thread_other'),
          'Run other thread turn'
        ),
        requestedAgentId: 'agent_worker',
        profileRef: null,
        now: () => '2026-07-05T00:00:04.000Z',
      });

      const second = findNextDispatchableSchedulerAdmissionEntry(coreDb)!;
      expect(second.queueEntryId).toBe('queue_thread_other');
      // The first claim has not submitted, so it holds its original Workspace (preparation
      // exclusion). The other Thread's claim commits nothing until a proved close releases it.
      expect(() =>
        attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
          entry: second,
          attemptId: 'attempt_00000000-0000-7513-9184-4604f787d87e',
          preparationInput: { admission: second },
        })
      ).toThrow('Execution placement has an unresolved writer.');
      expect(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)
      ).toEqual(['queue_thread_second', 'queue_thread_other']);
      expect(findNextDispatchableSchedulerAdmissionEntry(coreDb)?.queueEntryId).toBe(
        'queue_thread_other'
      );
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
  const owner = currentAdmittedTestNanoHostOwner(db);
  const backend = createConfiguredWorkerLifecycleRuntime({
    releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    coreDb: db,
    env: {},
    ...(owner ? { nanoHostRecovery: testNanoHostRecoveryJoins({ value: { owner } }) } : {}),
  }).turnExecutor.executionBackend!;
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

describe('bounded original scheduler authority readers', () => {
  it('keeps the original admission snapshot when a queued storage reference moves behind the read cursor', () => {
    const coreDb = createMigratedCoreDb();
    const writer = openCoreDb(coreDb.dataRoot);
    onTestFinished(() => {
      writer.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    });
    expect(coreDb.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(writer.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const storageRef = 'storage_snapshot_survivor';
    const admissionInput = {
      backendId: 'nanohost',
      triggerActor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      workspaceId,
      requestedAgentId: 'agent_worker',
      now: () => '2026-07-05T00:00:01.000Z',
    };
    const fillers: ReturnType<typeof requireSchedulerAdmissionEntry>[] = [];
    for (let index = 0; index < 128; index += 1) {
      const entry = createSchedulerAdmissionEntry(coreDb, {
        ...admissionInput,
        queueEntryId: `queue_snapshot_f${String(index).padStart(3, '0')}`,
        threadId: testEntityId('th', `snapshot-filler-${index}`),
        turnId: testEntityId('tu', `snapshot-filler-${index}`),
        inputRef: fixtureSchedulerInput(
          workspaceId,
          testEntityId('tu', `snapshot-filler-${index}`),
          'Retain the selected storage.'
        ),
      });
      // Real attempt admission avoids queued accumulation without bypassing the queue cap.
      attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
        entry,
        attemptId: testEntityId('attempt', `snapshot-filler-${index}`),
        preparationInput: { admission: entry },
      });
      // The claim holds its Workspace until a proved close. The real no-effect close releases
      // that preparation exclusion and keeps the admission admitted.
      attemptActionOwners.closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
        attemptId: testEntityId('attempt', `snapshot-filler-${index}`),
        noOutstandingEffects: true,
        cause: 'fixture-filler',
      });
      fillers.push(requireSchedulerAdmissionEntry(coreDb, entry.queueEntryId));
    }
    const selectedInput = {
      ...admissionInput,
      workerStorageChoice: {
        expectedRevision: 1,
        goalId: null,
        kind: 'selected' as const,
        purpose: 'work' as const,
        storageRef,
        taskId: null,
      },
    };
    const original = createSchedulerAdmissionEntry(coreDb, {
      ...selectedInput,
      queueEntryId: 'queue_snapshot_z',
      threadId: testEntityId('th', 'snapshot-original'),
      turnId: testEntityId('tu', 'snapshot-original'),
      inputRef: fixtureSchedulerInput(
        workspaceId,
        testEntityId('tu', 'snapshot-original'),
        'Retain the selected storage.'
      ),
    });
    const replacementId = 'queue_snapshot_a';
    let crossed = false;
    const prepare = coreDb.sqlite.prepare.bind(coreDb.sqlite);
    // Delegate every SQL operation and its exact result. Only schedule a real WAL commit
    // after the first inventory SELECT finishes, independent of LIMIT or page API shape.
    const observation = vi.spyOn(coreDb.sqlite, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (
        sql.includes('FROM scheduler_admission_entries') &&
        sql.includes('ORDER BY enqueued_at ASC, queue_entry_id ASC')
      ) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
          const rows = all(...parameters);
          if (!crossed) {
            crossed = true;
            writer.sqlite
              .transaction(() => {
                const replacement = createSchedulerAdmissionEntry(writer, {
                  ...selectedInput,
                  queueEntryId: replacementId,
                  threadId: testEntityId('th', 'snapshot-replacement'),
                  turnId: testEntityId('tu', 'snapshot-replacement'),
                  inputRef: fixtureSchedulerInput(
                    workspaceId,
                    testEntityId('tu', 'snapshot-replacement'),
                    'Retain the selected storage.'
                  ),
                });
                expect(replacement.status).toBe('queued');
                expect(requireSchedulerAdmissionEntry(writer, original.queueEntryId).status).toBe(
                  'queued'
                );
                cancelSchedulerAdmissionEntry(writer, {
                  queueEntryId: original.queueEntryId,
                  workspaceId,
                });
              })
              .immediate();
          }
          return rows;
        });
      }
      return statement;
    });
    let observed: ReturnType<typeof listSchedulerAdmissionEntriesForWorkspace>;
    try {
      observed = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId,
        statuses: ['queued', 'denied', 'admitted'],
      });
    } finally {
      observation.mockRestore();
    }
    expect(crossed).toBe(true);
    expect(requireSchedulerAdmissionEntry(writer, replacementId)).toMatchObject({
      status: 'queued',
      workerStorageChoice: { kind: 'selected', storageRef },
    });
    expect(requireSchedulerAdmissionEntry(writer, original.queueEntryId).status).toBe('cancelled');
    // Persistent Worker Volumes, Purge: no surviving references. The real purge caller
    // treats any queued selected-storage row as a refusal; a mixed absence is not proof.
    expect(
      observed
        .filter(
          (entry) =>
            entry.status === 'queued' &&
            entry.workerStorageChoice?.kind === 'selected' &&
            entry.workerStorageChoice.storageRef === storageRef
        )
        .map((entry) => entry.queueEntryId)
    ).toEqual([original.queueEntryId]);
    expect(observed).toEqual([...fillers, original]);
  });

  it('reads all admitted enqueue/id ties across three pages and keeps the original decoder refusal', () => {
    const coreDb = createMigratedCoreDb();
    onTestFinished(() => {
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const expected: ReturnType<typeof requireSchedulerAdmissionEntry>[] = [];
    for (let index = 0; index < 257; index += 1) {
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        queueEntryId: `queue_page_${String(256 - index).padStart(3, '0')}`,
        workspaceId,
        threadId: testEntityId('th', `page-thread-${index}`),
        turnId: testEntityId('tu', `page-turn-${index}`),
        inputRef: fixtureSchedulerInput(
          workspaceId,
          testEntityId('tu', `page-turn-${index}`),
          `Original admission ${index}`
        ),
        requestedAgentId: 'agent_worker',
        now: () =>
          index === 0
            ? '2026-07-05T00:00:02.000Z'
            : index === 256
              ? '2026-07-05T00:00:00.000Z'
              : '2026-07-05T00:00:01.000Z',
      });
      // The actual admission/attempt owners leave no queued accumulation or queue-cap bypass.
      attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
        entry,
        attemptId: testEntityId('attempt', `page-attempt-${index}`),
        preparationInput: { admission: entry },
      });
      // The claim holds its Workspace until a proved close. The real no-effect close releases
      // that preparation exclusion and keeps the admission admitted.
      attemptActionOwners.closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
        attemptId: testEntityId('attempt', `page-attempt-${index}`),
        noOutstandingEffects: true,
        cause: 'fixture-filler',
      });
      expected.push(requireSchedulerAdmissionEntry(coreDb, entry.queueEntryId));
    }
    expected.sort((left, right) =>
      left.enqueuedAt < right.enqueuedAt
        ? -1
        : left.enqueuedAt > right.enqueuedAt
          ? 1
          : left.queueEntryId < right.queueEntryId
            ? -1
            : 1
    );
    const input = { workspaceId, statuses: ['admitted'] as const };
    const before = coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries ORDER BY queue_entry_id')
      .all();
    const pages: Array<typeof expected> = [];
    for (const page of readSchedulerAdmissionPagesForWorkspace(coreDb, input)) {
      expect(coreDb.sqlite.inTransaction).toBe(false);
      pages.push([...page]);
    }
    expect(pages.map((page) => page.length)).toEqual([128, 128, 1]);
    expect(pages.flat()).toEqual(expected);
    expect(listSchedulerAdmissionEntriesForWorkspace(coreDb, input)).toEqual(expected);
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM scheduler_admission_entries ORDER BY queue_entry_id')
        .all()
    ).toEqual(before);
    const closing = readSchedulerAdmissionPagesForWorkspace(coreDb, input);
    expect(closing.next().done).toBe(false);
    expect(coreDb.sqlite.inTransaction).toBe(false);
    expect(coreDb.sqlite.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
      expect.objectContaining({ busy: 0 }),
    ]);
    closing.return(undefined);
    expect(coreDb.sqlite.inTransaction).toBe(false);
    expect(coreDb.sqlite.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
      expect.objectContaining({ busy: 0 }),
    ]);

    // Declared post-setup corruption of the last real row: retained version refusal must
    // precede JSON decoding, including when only the third page contains that row.
    const last = expected.at(-1)!;
    coreDb.sqlite
      .prepare(
        'UPDATE scheduler_admission_entries SET schema_version=2, trigger_actor_json=? WHERE queue_entry_id=?'
      )
      .run('{', last.queueEntryId);
    const corrupt = coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries WHERE queue_entry_id=?')
      .get(last.queueEntryId);
    const failed = readSchedulerAdmissionPagesForWorkspace(coreDb, input);
    expect(failed.next().value).toHaveLength(128);
    expect(failed.next().value).toHaveLength(128);
    expect(() => failed.next()).toThrow('Unsupported retained record format');
    expect(() => listSchedulerAdmissionEntriesForWorkspace(coreDb, input)).toThrow(
      'Unsupported retained record format'
    );
    expect(coreDb.sqlite.inTransaction).toBe(false);
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM scheduler_admission_entries WHERE queue_entry_id=?')
        .get(last.queueEntryId)
    ).toEqual(corrupt);
  });
});

const schedulerStart = '2026-07-05T00:00:02.000Z';
const schedulerHeartbeatOne = '2026-07-05T00:00:10.000Z';
const schedulerHeartbeatTwo = '2026-07-05T00:00:20.000Z';
const schedulerPastStartup = '2026-07-05T00:26:00.000Z';
const staleAdmittedHeartbeat = {
  domain: { code: 'worker_control_sequence_stale' },
};

async function admittedSchedulerCase() {
  const coreDb = createMigratedCoreDb();
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(coreDb.dataRoot, { recursive: true, force: true });
  });
  const storage = await openAdmittedTestNanoHost(coreDb);
  const { owner } = storage.value;
  const runtime = createConfiguredWorkerLifecycleRuntime({
    releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    coreDb,
    env: {},
    nanoHostRecovery: { owner: { state: 'ready', value: owner } },
  });
  const submit = (fixtureKey: string, packageSnapshotId = 'pkg_demo') => {
    const suffix = fixtureKey.replace('lease_', '');
    const admission = createSchedulerRecordAdmission(coreDb, suffix);
    const attemptId = testEntityId('attempt', fixtureKey);
    const sandboxBindingRef = `lease-binding:${attemptId}`;
    const agentSessionId = testEntityId('as', `session_${suffix}`);
    const tokenHash = 'a'.repeat(64);
    const original = submitTestNanoHostWorkerLease(
      coreDb,
      admission,
      sandboxBindingRef,
      {
        agentSessionId,
        packageSnapshotId,
        workerControlTokenHash: tokenHash,
        workerInferenceTokenHash: 'b'.repeat(64),
        workerCapabilityTokenHash: 'c'.repeat(64),
      },
      {
        attemptId,
        observedAt: schedulerStart,
        exclusionRefs: [`thread:${admission.threadId}`, `turn:${admission.turnId}`],
      }
    );
    const lineage = {
      workspaceId: admission.workspaceId,
      threadId: admission.threadId,
      turnId: admission.turnId,
      agentSessionId,
      packageSnapshotId,
    };
    const read = () => readTestNanoHostWorkerLease(coreDb, attemptId);
    const postHeartbeat = (sequence: number, observedAt: string) =>
      postTestNativeWorkerHeartbeat(owner, {
        sandboxBindingRef,
        lineage,
        tokenHash,
        sequence,
        observedAt,
      });
    return {
      attemptId,
      original,
      read,
      postHeartbeat,
      async heartbeat(sequence: number, observedAt: string) {
        const ack = await postHeartbeat(sequence, observedAt);
        return { ack, attempt: read() };
      },
      resolve(now: string, altered: { sandboxBindingRef?: string; threadId?: string } = {}) {
        const input = {
          sandboxBindingRef: altered.sandboxBindingRef ?? sandboxBindingRef,
          lineage: { ...lineage, threadId: altered.threadId ?? lineage.threadId },
        };
        return readAdmittedTestNanoHost(coreDb, (sqlite) =>
          resolveAdmittedNanoHostWorkerBinding(coreDb, sqlite, input, now)
        );
      },
      close(cause: string) {
        return beginOwnedAttemptCloseout(coreDb, {
          attemptId,
          firstTerminalCause: cause,
          now: () => schedulerHeartbeatOne,
        });
      },
      core: () => attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, attemptId),
    };
  };
  const executionBackend = runtime.turnExecutor.executionBackend!;
  return {
    coreDb,
    submit,
    executionBackend,
    release(attempt: ReturnType<typeof beginOwnedAttemptCloseout>) {
      return executionBackend.release({
        ...attemptActionOwners.schedulerExecutionCorrelation(attempt),
        proof: {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        },
      });
    },
  };
}

describe('admitted NanoHost scheduler replacements', () => {
  it('R01 accepts lease heartbeats and advances heartbeat deadlines', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_heartbeat');
    const { attempt } = await f.heartbeat(4, schedulerHeartbeatOne);
    expect(attempt).toMatchObject({
      attemptId: testEntityId('attempt', 'lease_heartbeat'),
      lastAcceptedHeartbeatAt: schedulerHeartbeatOne,
      lastWorkerSequence: 4,
      heartbeatDeadline: '2026-07-05T00:00:40.000Z',
    });
  });

  it('R02 treats a repeated heartbeat sequence as an idempotent retry', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_heartbeat_retry');
    const first = await f.heartbeat(4, schedulerHeartbeatOne);
    const retry = await f.heartbeat(4, schedulerHeartbeatTwo);
    expect(retry.ack.duplicate).toBe(true);
    expect(retry.attempt).toEqual(first.attempt);
  });

  it('R03 treats a concurrent same-sequence heartbeat winner as an idempotent retry', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_heartbeat_concurrent_retry');
    // The contender is pending while the competing observation is acknowledged.
    const { promise, resolve } = Promise.withResolvers<void>();
    const retry = promise.then(() => f.postHeartbeat(4, '2026-07-05T00:00:11.000Z'));
    const winner = await f.postHeartbeat(4, schedulerHeartbeatOne);
    expect(winner.duplicate).toBe(false);
    resolve();
    await expect(retry).resolves.toMatchObject({ duplicate: true });
    expect(f.read()).toMatchObject({
      lastAcceptedHeartbeatAt: schedulerHeartbeatOne,
      heartbeatDeadline: '2026-07-05T00:00:40.000Z',
      lastWorkerSequence: 4,
    });
  });

  it('R04 classifies a concurrent newer heartbeat winner as a stale sequence', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_heartbeat_concurrent_newer');
    const { promise, resolve } = Promise.withResolvers<void>();
    const stale = promise.then(() => f.postHeartbeat(4, '2026-07-05T00:00:11.000Z'));
    await expect(f.postHeartbeat(5, schedulerHeartbeatOne)).resolves.toMatchObject({
      duplicate: false,
    });
    resolve();
    await expect(stale).rejects.toMatchObject(staleAdmittedHeartbeat);
    expect(f.read().lastWorkerSequence).toBe(5);
  });

  it('R05 rejects heartbeat sequences older than the last accepted sequence', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_heartbeat_stale_sequence');
    const { attempt: accepted } = await f.heartbeat(4, schedulerHeartbeatOne);
    await expect(f.heartbeat(3, schedulerHeartbeatTwo)).rejects.toMatchObject(
      staleAdmittedHeartbeat
    );
    expect(f.read()).toMatchObject({
      heartbeatDeadline: accepted.heartbeatDeadline,
      lastAcceptedHeartbeatAt: accepted.lastAcceptedHeartbeatAt,
      lastWorkerSequence: accepted.lastWorkerSequence,
    });
  });

  it('R06 advances a lease only for a newer heartbeat sequence', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_heartbeat_newer_sequence');
    await f.heartbeat(4, schedulerHeartbeatOne);
    expect((await f.heartbeat(5, schedulerHeartbeatTwo)).attempt).toMatchObject({
      heartbeatDeadline: '2026-07-05T00:00:50.000Z',
      lastAcceptedHeartbeatAt: schedulerHeartbeatTwo,
      lastWorkerSequence: 5,
    });
  });

  it('R07 does not revive a lease that starts releasing before the heartbeat update', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_heartbeat_race');
    f.close('worker-final-status');
    await expect(f.heartbeat(4, schedulerHeartbeatOne)).rejects.toMatchObject({
      domain: { code: 'worker_control_lease_not_live' },
    });
    expect(f.core().phase).toBe('closing');
  });

  it('R08 refuses expired Native heartbeats without reviving closed attempts or releasing unknown execution', async () => {
    const { coreDb, submit } = await admittedSchedulerCase();
    const expired = submit('lease_expired');
    const terminal = submit('lease_terminal', 'pkg_terminal');
    await expired.heartbeat(1, schedulerHeartbeatOne);
    terminal.close('turn-completed');
    await releaseModeledAttempt(coreDb, terminal.attemptId);
    expect(expired.resolve('2026-07-05T00:01:00.000Z')).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
    expect(expired.core()).toMatchObject({
      phase: 'open',
      disposition: 'unknown',
      fenceRef: null,
      operationId: expired.original.operationId,
    });
    expect(terminal.core().phase).toBe('closed');
  });

  it('R09 holds exclusion for active NanoHost observations that are missing their durable backend anchor', async () => {
    const fixture = await admittedSchedulerCase();
    const f = fixture.submit('lease_missing_anchor_active');
    await f.heartbeat(1, schedulerHeartbeatOne);
    removeTestNativeWorkerAnchor(fixture.coreDb, f.attemptId);
    await expect(fixture.release(f.close('turn-failed'))).resolves.toMatchObject({
      state: 'pending',
      fenceRef: null,
    });
    expect(['open', 'closing']).toContain(f.core().phase);
  });

  it('R10 classifies NanoHost startup timeout before any accepted process', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_startup_timeout');
    expect(f.resolve(schedulerPastStartup)).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
    expect(f.core()).toMatchObject({ phase: 'open', disposition: 'unknown', fenceRef: null });
  });

  it('R11 retains the native fence when an anchored startup times out', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_anchored_startup_timeout');
    expect(f.resolve(schedulerPastStartup)).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
    expect(f.core()).toMatchObject({ phase: 'open', disposition: 'unknown', fenceRef: null });
  });

  it('R12 does not fail startup deadlines after the first heartbeat is accepted', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_started');
    await f.heartbeat(1, schedulerHeartbeatOne);
    for (let sequence = 2; sequence <= 78; sequence += 1) {
      await f.heartbeat(
        sequence,
        new Date(Date.parse(schedulerHeartbeatOne) + (sequence - 1) * 20_000).toISOString()
      );
    }
    expect(f.resolve(schedulerPastStartup)).toMatchObject({ status: 'accepted' });
    expect(['open', 'closing']).toContain(f.core().phase);
  });

  it('R13 revokes a closing attempt without dropping exclusion', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_releasing');
    f.close('worker-final-status');
    expect(f.core().phase).toBe('closing');
    expect(f.resolve('2026-07-05T00:00:11.000Z')).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
  });

  it('R14 preserves exclusion for an unanchored closing attempt after Native timeout', async () => {
    const fixture = await admittedSchedulerCase();
    const { coreDb, submit, executionBackend } = fixture;
    const stale = submit('lease_recovery_stale');
    const release = submit('lease_recovery_release', 'pkg_release');
    const startup = submit('lease_recovery_startup', 'pkg_startup');
    await stale.heartbeat(1, schedulerHeartbeatOne);
    expect(stale.resolve(schedulerPastStartup)).toMatchObject({ status: 'rejected' });
    removeTestNativeWorkerAnchor(coreDb, release.attemptId);
    const closing = release.close('worker-final-status');
    await runSchedulerRecoveryMaintenance(coreDb, {
      executionBackend,
      projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      now: () => schedulerPastStartup,
    });
    expect(startup.resolve(schedulerPastStartup)).toMatchObject({ status: 'rejected' });
    expect(release.core().phase).toBe('closing');
    await expect(fixture.release(closing)).resolves.toMatchObject({
      state: 'pending',
      fenceRef: null,
    });
  });

  it('R15 resolves live route credentials through the exact durable attempt', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_binding');
    expect(f.resolve(schedulerHeartbeatOne)).toMatchObject({ status: 'accepted' });
    expect(f.core()).toMatchObject({
      phase: 'open',
      turnId: testEntityId('tu', 'turn_binding'),
      agentSessionId: testEntityId('as', 'session_binding'),
      bindingRef: `lease-binding:${testEntityId('attempt', 'lease_binding')}`,
    });
  });

  it('R16 rejects an expired lease token binding at request time', async () => {
    const { coreDb, submit } = await admittedSchedulerCase();
    const f = submit('lease_binding_expired');
    expect(f.resolve('2026-07-05T02:01:00.000Z')).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
    // The retained heartbeat is still live across this boundary. The original grant cannot renew.
    seedTestNanoHostHeartbeat(coreDb, {
      attemptId: f.attemptId,
      heartbeatTimeoutMs: 30_000,
      workerSequence: 1,
      now: () => '2026-07-05T01:59:59.000Z',
    });
    expect(f.resolve('2026-07-05T02:00:01.000Z')).toMatchObject({ status: 'accepted' });
    expect(f.resolve('2026-07-05T02:00:02.000Z')).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
  });

  it('R17 rejects a lease token binding after its startup deadline', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_binding_startup_timeout');
    expect(f.resolve(schedulerPastStartup)).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
  });

  it('R18 rejects a started lease token binding after its heartbeat deadline', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_binding_heartbeat_timeout');
    await f.heartbeat(1, schedulerHeartbeatOne);
    expect(f.resolve('2026-07-05T00:00:41.000Z')).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
  });

  it('R19 rejects missing, mismatched, and non-live lease token bindings', async () => {
    const f = (await admittedSchedulerCase()).submit('lease_binding_rejected');
    expect(
      f.resolve(schedulerHeartbeatOne, { sandboxBindingRef: 'lease-binding:missing' })
    ).toEqual({ status: 'rejected', reason: 'binding-not-found' });
    expect(
      f.resolve(schedulerHeartbeatOne, { threadId: testEntityId('th', 'thread_other') })
    ).toEqual({ status: 'rejected', reason: 'lineage-mismatch' });
    f.close('completed');
    expect(f.resolve('2026-07-05T00:00:11.000Z')).toEqual({
      status: 'rejected',
      reason: 'attempt-not-live',
    });
  });
});

/** FIFO class closure: the Core claim transaction decides order, preparation and exclusion. */
describe('scheduler FIFO class closure at the Core claim', () => {
  const owner = 'usr_00000000-0000-7000-8000-000000000001';
  const workspace = (index: number) =>
    `ws_00000000-0000-7000-8000-00000000f${String(index).padStart(3, '0')}`;
  /** Admits one Core-satisfiable entry with its own Thread and Turn in a Workspace it owns. */
  const admit = (
    coreDb: ReturnType<typeof createMigratedCoreDb>,
    label: string,
    workspaceId: string,
    storageRef?: string
  ) => {
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: owner });
    const turnId = testEntityId('tu', `turn_fifo_${label}`);
    return createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: owner },
      queueEntryId: `queue_fifo_${label}`,
      workspaceId,
      threadId: testEntityId('th', `thread_fifo_${label}`),
      turnId,
      inputRef: fixtureSchedulerInput(workspaceId, turnId, `Run FIFO ${label}`),
      requestedAgentId: 'agent_worker',
      ...(storageRef
        ? {
            workerStorageChoice: {
              expectedRevision: 1,
              goalId: null,
              kind: 'selected' as const,
              purpose: 'work' as const,
              storageRef,
              taskId: null,
            },
          }
        : {}),
      now: () => '2026-07-05T00:00:00.000Z',
    });
  };
  /** Claims through the real create transaction with the prefix that the caller observed. */
  const claim = (
    coreDb: ReturnType<typeof createMigratedCoreDb>,
    entry: ReturnType<typeof admit>,
    selectionPrefixDigest = attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, entry)
  ) =>
    attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
      entry,
      attemptId: testEntityId('attempt', `attempt_${entry.queueEntryId}`),
      preparationInput: { admission: entry },
      selectionPrefixDigest,
    });
  const refusal = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionAttemptRefusal);
      return {
        message: (error as Error).message,
        reason: (error as InstanceType<typeof ExecutionAttemptRefusal>).reason,
      };
    }
    throw new Error('The claim was not refused.');
  };
  const attemptsFor = (
    coreDb: ReturnType<typeof createMigratedCoreDb>,
    entry: ReturnType<typeof admit>
  ) => attemptActionOwners.listSchedulerExecutionAttemptsForTurn(coreDb, entry);
  const releaseWithoutEffects = (
    coreDb: ReturnType<typeof createMigratedCoreDb>,
    entry: ReturnType<typeof admit>,
    requeue = false
  ) =>
    attemptActionOwners.closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
      attemptId: testEntityId('attempt', `attempt_${entry.queueEntryId}`),
      noOutstandingEffects: true,
      cause: 'fixture-no-effect',
      requeue,
    });
  const selectionChanged = {
    message: 'The scheduler selection changed before the claim.',
    reason: 'selection-changed',
  };
  const placementHeld = {
    message: 'Execution placement has an unresolved writer.',
    reason: 'placement-held',
  };

  it('refuses a younger claim when an older skipped Task becomes satisfiable before the commit, and keeps a committed claim', () => {
    const coreDb = createMigratedCoreDb();
    try {
      // A prepares in Workspace 1. B shares that Workspace, so the selector skips B. C is disjoint.
      const a = admit(coreDb, 'release-a', workspace(1));
      claim(coreDb, a);
      const b = admit(coreDb, 'release-b', workspace(1));
      const c = admit(coreDb, 'release-c', workspace(2));
      expect(attemptActionOwners.schedulerClaimBlocked(coreDb, b)).toBe(true);
      const observed = attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, c);
      expect(observed).toBe(attemptActionOwners.createSchedulerSelectionPrefix().digest());
      // A's proved no-effect close commits after C's selection and before C's claim.
      releaseWithoutEffects(coreDb, a);
      expect(refusal(() => claim(coreDb, c, observed))).toEqual(selectionChanged);
      expect(attemptsFor(coreDb, c)).toEqual([]);
      expect(requireSchedulerAdmissionEntry(coreDb, c.queueEntryId).status).toBe('queued');
      // The fresh scan gives B the first claim.
      expect(claim(coreDb, b)).toMatchObject({ turnId: b.turnId, phase: 'open', deadline: null });
      // After the commit a later release cannot undo it: D commits, then E's holder releases.
      const holder = admit(coreDb, 'release-holder', workspace(3));
      claim(coreDb, holder);
      const e = admit(coreDb, 'release-e', workspace(3));
      const d = admit(coreDb, 'release-d', workspace(4));
      const committed = claim(coreDb, d);
      releaseWithoutEffects(coreDb, holder);
      expect(
        attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, committed.attemptId)
      ).toMatchObject({ turnId: d.turnId, phase: 'open' });
      expect(requireSchedulerAdmissionEntry(coreDb, e.queueEntryId).status).toBe('queued');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses a younger claim on another Thread when the older Task on the submitted holder Thread becomes satisfiable before the commit', () => {
    const coreDb = createMigratedCoreDb();
    try {
      // A is submitted on Thread 1, so its preparation exclusion is gone and only its Thread is held.
      const a = admit(coreDb, 'thread-a', workspace(5));
      const submitted = recordTestExecutionAttempt(coreDb, {
        entry: a,
        attemptId: testEntityId('attempt', `attempt_${a.queueEntryId}`),
        agentSessionId: testEntityId('as', 'session_fifo_thread_a'),
        inputRef: 'pkg_demo',
        bindingRef: 'lease-binding:fifo-thread-a',
        now: () => '2026-07-05T00:00:02.000Z',
        operationId: 'fixture-submit:fifo-thread-a',
      });
      expect(submitted.deadline).not.toBeNull();
      // B is the next Turn on A's Thread. C is on another Thread in the same Workspace.
      const bTurnId = testEntityId('tu', 'turn_fifo_thread-b');
      const b = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: owner },
        queueEntryId: 'queue_fifo_thread-b',
        workspaceId: a.workspaceId,
        threadId: a.threadId,
        turnId: bTurnId,
        inputRef: fixtureSchedulerInput(a.workspaceId, bTurnId, 'Run FIFO thread-b'),
        requestedAgentId: 'agent_worker',
        now: () => '2026-07-05T00:00:00.000Z',
      });
      const c = admit(coreDb, 'thread-c', workspace(5));
      expect(attemptActionOwners.schedulerClaimBlocked(coreDb, b)).toBe(true);
      expect(attemptActionOwners.schedulerClaimBlocked(coreDb, c)).toBe(false);
      const observed = attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, c);
      expect(observed).toBe(attemptActionOwners.createSchedulerSelectionPrefix().digest());
      // A's exact release commits after C's selection and before C's claim.
      releaseWithoutEffects(coreDb, a);
      expect(attemptActionOwners.schedulerClaimBlocked(coreDb, b)).toBe(false);
      expect(refusal(() => claim(coreDb, c, observed))).toEqual(selectionChanged);
      expect(attemptsFor(coreDb, c)).toEqual([]);
      expect(requireSchedulerAdmissionEntry(coreDb, c.queueEntryId).status).toBe('queued');
      // The fresh scan gives B the first claim, and C then waits behind B's preparation.
      expect(claim(coreDb, b)).toMatchObject({ turnId: b.turnId, phase: 'open', deadline: null });
      expect(refusal(() => claim(coreDb, c))).toEqual(placementHeld);
      expect(attemptsFor(coreDb, c)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps an in-place retry at its original position and refuses an equal-count replacement', () => {
    const coreDb = createMigratedCoreDb();
    try {
      // Retry in place: B is denied after C's selection and retried before C's claim.
      const b = admit(coreDb, 'retry-b', workspace(1));
      const c = admit(coreDb, 'retry-c', workspace(2));
      denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: b.queueEntryId,
        denialReason: 'queue-full',
      });
      const beforeRetry = attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, c);
      retryDeniedSchedulerAdmissionEntry(coreDb, {
        queueEntryId: b.queueEntryId,
        workspaceId: b.workspaceId,
      });
      expect([...schedulerRecordsInOrder(coreDb)].map((entry) => entry.queueEntryId)).toEqual([
        b.queueEntryId,
        c.queueEntryId,
      ]);
      expect(refusal(() => claim(coreDb, c, beforeRetry))).toEqual(selectionChanged);
      expect(attemptsFor(coreDb, c)).toEqual([]);
      // A later ticket cannot invert FIFO: the retried B claims first on the fresh scan.
      expect(claim(coreDb, b)).toMatchObject({ turnId: b.turnId });
      // Equal count: the observed prefix names C and X1. X1 cancels and X2 becomes satisfiable.
      const holder = admit(coreDb, 'equal-holder', workspace(3));
      claim(coreDb, holder);
      const x1 = admit(coreDb, 'equal-x1', workspace(4));
      const x2 = admit(coreDb, 'equal-x2', workspace(3));
      const d = admit(coreDb, 'equal-d', workspace(5));
      const observed = createPrefix([c, x1]);
      expect(attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, d)).toBe(observed);
      cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: x1.queueEntryId,
        workspaceId: x1.workspaceId,
      });
      releaseWithoutEffects(coreDb, holder);
      // One satisfiable predecessor before and after, so a count cannot see the change.
      expect(attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, d)).toBe(
        createPrefix([c, x2])
      );
      expect(refusal(() => claim(coreDb, d, observed))).toEqual(selectionChanged);
      expect(attemptsFor(coreDb, d)).toEqual([]);
      expect(requireSchedulerAdmissionEntry(coreDb, d.queueEntryId).status).toBe('queued');
      // Retry after commit: E is denied, F claims, then E retries in place. F's claim stands.
      const e = admit(coreDb, 'retry-e', workspace(6));
      const f = admit(coreDb, 'retry-f', workspace(7));
      denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: e.queueEntryId,
        denialReason: 'queue-full',
      });
      const committed = claim(coreDb, f);
      retryDeniedSchedulerAdmissionEntry(coreDb, {
        queueEntryId: e.queueEntryId,
        workspaceId: e.workspaceId,
      });
      expect(
        attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, committed.attemptId)
      ).toMatchObject({ turnId: f.turnId, phase: 'open' });
      expect([...schedulerRecordsInOrder(coreDb)].map((entry) => entry.queueEntryId)).toEqual([
        c.queueEntryId,
        x2.queueEntryId,
        d.queueEntryId,
        e.queueEntryId,
      ]);
      // A row enqueued after G's selection is younger, so it does not change G's prefix.
      const g = admit(coreDb, 'retry-g', workspace(8));
      const gObserved = attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, g);
      expect(gObserved).toBe(createPrefix([c, x2, d, e]));
      const h = admit(coreDb, 'retry-h', workspace(9));
      expect(claim(coreDb, g, gObserved)).toMatchObject({ turnId: g.turnId, phase: 'open' });
      expect(requireSchedulerAdmissionEntry(coreDb, h.queueEntryId).status).toBe('queued');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lets a Task pass an older Task held only on selected storage, and gives the older Task priority after the exact release', () => {
    const storageRef = 'wst_00000000-0000-77ec-b7e9-3fa6a72e9fa1';
    const coreDb = createMigratedCoreDb();
    try {
      // H prepares with selected storage S in Workspace 1. B selects S in Workspace 2.
      const h = admit(coreDb, 'storage-h', workspace(1), storageRef);
      claim(coreDb, h);
      const b = admit(coreDb, 'storage-b', workspace(2), storageRef);
      const c = admit(coreDb, 'storage-c', workspace(2));
      const d = admit(coreDb, 'storage-d', workspace(3));
      expect(attemptActionOwners.schedulerClaimBlocked(coreDb, b)).toBe(true);
      expect(attemptActionOwners.schedulerClaimBlocked(coreDb, c)).toBe(false);
      // The exact release of S commits after D's selection and before D's claim: B has priority.
      const observed = attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, d);
      expect(observed).toBe(createPrefix([c]));
      releaseWithoutEffects(coreDb, h);
      expect(refusal(() => claim(coreDb, d, observed))).toEqual(selectionChanged);
      expect(attemptsFor(coreDb, d)).toEqual([]);
      expect(claim(coreDb, b)).toMatchObject({ turnId: b.turnId });
    } finally {
      coreDb.sqlite.close();
    }
    const permitted = createMigratedCoreDb();
    try {
      // Without the release, C in B's Workspace claims while B waits only on S.
      const h = admit(permitted, 'storage-h', workspace(1), storageRef);
      claim(permitted, h);
      const b = admit(permitted, 'storage-b', workspace(2), storageRef);
      const c = admit(permitted, 'storage-c', workspace(2));
      expect(claim(permitted, c)).toMatchObject({ turnId: c.turnId, phase: 'open' });
      expect(attemptsFor(permitted, b)).toEqual([]);
      expect(requireSchedulerAdmissionEntry(permitted, b.queueEntryId).status).toBe('queued');
    } finally {
      permitted.sqlite.close();
    }
  });

  it('refuses a claim on a new hold, and keeps preparation held while closing, after image intent and after a rolled-back submit', () => {
    const coreDb = createMigratedCoreDb();
    try {
      // A new hold on C's Workspace commits after C's selection: C commits nothing.
      const c = admit(coreDb, 'hold-c', workspace(1));
      const n = admit(coreDb, 'hold-n', workspace(1));
      const observed = attemptActionOwners.readSchedulerSelectionPrefixDigest(coreDb, c);
      claim(coreDb, n);
      expect(refusal(() => claim(coreDb, c, observed))).toEqual(placementHeld);
      expect(attemptsFor(coreDb, c)).toEqual([]);
      const nAttempt = testEntityId('attempt', `attempt_${n.queueEntryId}`);
      // Image or preparation operation intent alone does not clear the exclusion.
      attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
        attemptId: nAttempt,
        operationId: 'fixture-image-intent',
      });
      expect(attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, nAttempt)).toMatchObject({
        operationId: 'fixture-image-intent',
        deadline: null,
      });
      expect(refusal(() => claim(coreDb, c))).toEqual(placementHeld);
      // A submit that rolls back leaves the deadline unset and preparation held.
      const p = admit(coreDb, 'hold-p', workspace(2));
      const q = admit(coreDb, 'hold-q', workspace(2));
      claim(coreDb, p);
      const pAttempt = testEntityId('attempt', `attempt_${p.queueEntryId}`);
      expect(() =>
        attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
          attemptId: pAttempt,
          operationId: 'fixture-rolled-back-submit',
          submission: true,
        })
      ).toThrow('Submission has no finalized package or assigned binding.');
      expect(attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, pAttempt)).toMatchObject({
        operationId: null,
        deadline: null,
      });
      expect(refusal(() => claim(coreDb, q))).toEqual(placementHeld);
      // A close in progress still holds. Only the proved no-effect close releases.
      attemptActionOwners.markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: pAttempt,
        cause: 'turn-cancelled',
      });
      expect(attemptActionOwners.requireSchedulerExecutionAttempt(coreDb, pAttempt).phase).toBe(
        'closing'
      );
      expect(refusal(() => claim(coreDb, q))).toEqual(placementHeld);
      expect(attemptsFor(coreDb, q)).toEqual([]);
      releaseWithoutEffects(coreDb, p);
      expect(claim(coreDb, q)).toMatchObject({ turnId: q.turnId, phase: 'open' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses a vanished proposal and lets a direct claim attest only the empty prefix', () => {
    const coreDb = createMigratedCoreDb();
    try {
      const b = admit(coreDb, 'direct-b', workspace(1));
      const c = admit(coreDb, 'direct-c', workspace(2));
      // A direct create without Main's skip evidence attests the empty prefix.
      expect(
        refusal(() =>
          attemptActionOwners.createSchedulerExecutionAttempt(coreDb, {
            entry: c,
            preparationInput: { admission: c },
          })
        )
      ).toEqual(selectionChanged);
      cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId: c.queueEntryId,
        workspaceId: c.workspaceId,
      });
      expect(refusal(() => claim(coreDb, c, createPrefix([b])))).toEqual({
        message: 'The exact queued admission is no longer dispatchable.',
        reason: 'selection-changed',
      });
      expect(attemptsFor(coreDb, c)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/** Streams the Core queue in insertion order, in bounded batches. */
function schedulerRecordsInOrder(coreDb: ReturnType<typeof createMigratedCoreDb>) {
  return readQueuedSchedulerAdmissionEntriesInOrder(coreDb);
}

/** Builds the selection prefix digest of the given ordered predecessors. */
function createPrefix(entries: readonly CoreSchedulerQueueEntry[]): string {
  const prefix = attemptActionOwners.createSchedulerSelectionPrefix();
  for (const entry of entries) prefix.add(entry);
  return prefix.digest();
}
