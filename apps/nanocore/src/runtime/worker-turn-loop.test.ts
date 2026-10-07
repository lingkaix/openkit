import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { serializeStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION } from '../lib/store.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import * as attempts from './execution-attempt-records.js';
import { bindNanoHostAttemptPreparation } from './nanohost-attempt-records.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from './nanohost-harness-records.js';
import { TurnStartValidationError } from './orchestrator.js';
import { startProductTurn } from './product-turn-start.js';
import type { TurnStartRuntimeContext } from './types.js';
import {
  clearWorkerCheckpoint,
  getWorkerCheckpoint,
  updateWorkerCheckpoint,
} from './worker-checkpoints.js';
import { resolveInterruptedWorkerRetryDecision } from './worker-recovery.js';
import type { RunWorkerTurnLoopInput, WorkerTurnLoopStartWorkerInput } from './worker-turn-loop.js';
import { bindWorkerCheckpointToPreparedSession, runWorkerTurnLoop } from './worker-turn-loop.js';

/**
 * Opens a migrated Core database for worker-turn loop tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-turn-loop-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  return coreDb;
}

/**
 * Opens a migrated workspace database paired with the Core database.
 *
 * @param coreDb Migrated Core database handles.
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/** Returns the shared prepared worker input used by loop boundary tests. */
function preparedWorkerTurn(reviewRequired: boolean) {
  return {
    delegationRequest: {
      schemaVersion: 1 as const,
      objective: 'Run the selected task.',
      acceptanceCriteria: ['Task passes.'],
      contextRefs: [{ kind: 'workspace', id: 'ws_demo' }],
      resources: [],
      expectedArtifacts: [],
      constraints: { maxContextTokens: 1000, maxWorkerIterations: 1 },
      verification: [{ kind: 'manual', description: 'Inspect the worker result.' }],
      reviewPolicy: {
        required: reviewRequired,
        reviewers: ['human'],
        instructions: 'Review the worker result.',
      },
      escalationConditions: [],
      reviewContext: null,
    },
    contextPackageDigest: 'ctxpkg_sha256_demo',
  };
}

describe('worker turn loop', () => {
  it('runs one worker turn and persists its checkpoint', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });

    try {
      const prepareCalls: unknown[][] = [];
      const result = await runWorkerTurnLoop({
        store,
        coreDb,
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_worker_1',
        requestInputHash: 'sha256:worker_1',
        reviewRequired: true,
        remainingWorkerIterations: 1,
        prepare: (...args) => {
          prepareCalls.push(args);
          return preparedWorkerTurn(true);
        },
        reservedTurnId: 'turn_worker_1',
        reserveTurn: () => ({ turnId: 'turn_worker_1' }),
        startWorker: admittedWorker(coreDb, store, 'req_worker_1', 'session_worker_1'),
        awaitWorker: () => ({
          stopReason: 'completed',
          itemIds: ['it_done'],
          artifactIds: ['art_done'],
        }),
      });

      expect(prepareCalls).toEqual([[]]);
      expect(result).not.toHaveProperty('queues');
      expect(result).toMatchObject({
        turnId: 'turn_worker_1',
        workerSessionId: 'session_worker_1',
        stopDecision: {
          outcome: 'review',
          shouldStop: true,
          stopReason: 'completed',
        },
        evidence: {
          itemIds: ['it_done'],
          artifactIds: ['art_done'],
        },
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_worker_1')).toMatchObject(
        {
          goalId: 'goal_demo',
          taskId: 'task_demo',
          stage: 'completed',
          workerSessionId: 'session_worker_1',
          contextDigest: 'ctxpkg_sha256_demo',
          stopReason: 'completed',
        }
      );
      expect(latestPermissionDecision(workspaceDb)).toMatchObject({
        action: 'runtime.launch',
        enforcement_point: 'runtime.worker_turn_loop.start',
        reason_code: 'worker_turn_start_allowed',
        result: 'allow',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records a redacted failed checkpoint when the worker boundary throws', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });

    try {
      await expect(
        runWorkerTurnLoop({
          store,
          coreDb,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          requestId: 'req_worker_error',
          requestInputHash: 'sha256:worker_error',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(true),
          reservedTurnId: 'turn_worker_error',
          reserveTurn: () => ({ turnId: 'turn_worker_error' }),
          startWorker: () => {
            throw new Error('Worker failed Authorization: Bearer live_secret');
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toThrow('Worker failed');

      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_worker_error')
      ).toMatchObject({
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: 'Worker failed Authorization: Bearer [redacted]',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps the preparing checkpoint when product recovery is required after worker cleanup', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });

    try {
      await expect(
        runWorkerTurnLoop({
          store,
          coreDb,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          requestId: 'req_worker_human_gate',
          requestInputHash: 'sha256:worker_human_gate',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(false),
          reservedTurnId: 'turn_worker_human_gate',
          reserveTurn: () => ({ turnId: 'turn_worker_human_gate' }),
          startWorker: () => {
            throw new TurnStartValidationError(
              'recovery_required',
              'Worker requested human input without an exact product Gate.',
              409
            );
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });

      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_worker_human_gate')
      ).toMatchObject({
        stage: 'preparing',
        stopReason: null,
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects removed authority before reservation, decision, checkpoint, or worker effects', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const timestamp = '2026-07-19T00:00:00.000Z';
    const now = Date.parse(timestamp);
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind
        ) VALUES ('user_removed_worker', 'Removed Worker', 'removed-worker@example.com', false, ?, ?, 'human')`
      )
      .run(now, now);
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES ('ws_demo', 'user_removed_worker', 'removed', 'editor', NULL, ?, ?, 2, ?, ?)`
      )
      .run(timestamp, timestamp, timestamp, timestamp);
    let reserveCalls = 0;
    let workerCalls = 0;

    try {
      await expect(
        runWorkerTurnLoop({
          store,
          coreDb,
          triggerActor: { kind: 'user', id: 'user_removed_worker' },
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: 'req_worker_removed_authority',
          requestInputHash: 'sha256:worker_removed_authority',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(false),
          reservedTurnId: 'turn_worker_removed_authority',
          reserveTurn: () => {
            reserveCalls += 1;
            return { turnId: 'turn_worker_removed_authority' };
          },
          startWorker: () => {
            workerCalls += 1;
            return { workerSessionId: 'session_worker_removed_authority' };
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });

      expect(reserveCalls).toBe(0);
      expect(workerCalls).toBe(0);
      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_worker_removed_authority')
      ).toBeNull();
      expect(
        (
          workspaceDb.sqlite
            .prepare('SELECT COUNT(*) AS count FROM permission_decisions')
            .get() as {
            count: number;
          }
        ).count
      ).toBe(0);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('admits usable presented server-admin bearer for runtime.launch without membership', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES ('user_admin_worker', 'Admin Worker', 'admin-worker@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_admin_worker',
      scope: 'server-admin',
      tokenId: 'token_admin_worker',
      workspaceIds: [],
    });
    let reserveCalls = 0;
    let workerCalls = 0;

    try {
      const result = await runWorkerTurnLoop({
        store,
        coreDb,
        triggerActor: { kind: 'user', id: 'user_admin_worker' },
        requestActor: {
          kind: 'token',
          tokenId: 'token_admin_worker',
          tokenScope: 'server-admin',
          tokenWorkspaceIds: [],
          userId: 'user_admin_worker',
        },
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_worker_admin_authority',
        requestInputHash: 'sha256:worker_admin_authority',
        reviewRequired: false,
        remainingWorkerIterations: 0,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'turn_worker_admin_authority',
        reserveTurn: () => {
          reserveCalls += 1;
          return { turnId: 'turn_worker_admin_authority' };
        },
        startWorker: async (input) => {
          workerCalls += 1;
          return admittedWorker(
            coreDb,
            store,
            'req_worker_admin_authority',
            'session_worker_admin_authority',
            'user_admin_worker',
            {
              kind: 'token',
              tokenId: 'token_admin_worker',
              tokenScope: 'server-admin',
              tokenWorkspaceIds: [],
              userId: 'user_admin_worker',
            }
          )(input);
        },
        awaitWorker: () => ({ stopReason: 'completed' }),
      });

      expect(result.turnId).toBe('turn_worker_admin_authority');
      expect(reserveCalls).toBe(1);
      expect(workerCalls).toBe(1);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/**
 * Reads the newest permission decision row from a workspace database.
 *
 * @param workspaceDb Workspace database handle.
 * @returns Newest permission decision row.
 */
function latestPermissionDecision(workspaceDb: WorkspaceDb): {
  action: string;
  enforcement_point: string;
  reason_code: string;
  result: string;
} {
  return workspaceDb.sqlite
    .prepare(
      `SELECT action, enforcement_point, reason_code, result
       FROM permission_decisions
       ORDER BY created_at DESC, decision_id DESC
       LIMIT 1`
    )
    .get() as {
    action: string;
    enforcement_point: string;
    reason_code: string;
    result: string;
  };
}

it('bounds quoting worker errors in the loop checkpoint before rethrowing', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const error = new SyntaxError('ROW_SECRET_X9');
  try {
    await expect(
      runWorkerTurnLoop({
        store,
        coreDb,
        workspaceDb,
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_publication',
        requestInputHash: 'sha256:publication',
        reviewRequired: false,
        remainingWorkerIterations: 0,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_publication',
        reserveTurn: () => ({ turnId: 'tu_publication' }),
        startWorker: () => {
          throw error;
        },
        awaitWorker: () => ({ stopReason: 'completed' }),
      })
    ).rejects.toBe(error);
    const checkpoint = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_publication');
    expect(checkpoint).toMatchObject({
      stage: 'failed',
      stopReason: 'error',
      diagnosticsSummary: 'The record could not be processed.',
    });
    expect(JSON.stringify(checkpoint)).not.toContain('ROW_SECRET_X9');
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

/** Starts a real scheduler admission with a bounded in-process executor. */
function admittedWorker(
  coreDb: CoreDb,
  store: import('../lib/store.js').FsStore,
  requestId: string,
  agentSessionId: string,
  actorId = 'user_local',
  requestActor?: import('../auth/identity.js').Actor,
  hooks: {
    execute?: (turnId: string) => Promise<void>;
    prepare?: () => void;
    observe?: WorkerTurnLoopStartWorkerInput['onAdmitted'];
  } = {}
) {
  return async ({ turnId, prepared, onAdmitted }: WorkerTurnLoopStartWorkerInput) => {
    const manifest = createTestAgentSetup().manifest;
    admitTestNativeEnvironment(coreDb, manifest);
    recordTestNativeRuntimeTarget(coreDb);
    const executor = new SimulatedTurnExecutor({ coreDb });
    let workerFailure: unknown;
    let workerCompletion: Promise<void> | undefined;
    const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    executor.prepareAgentSessionForTurn = async () => {
      hooks.prepare?.();
      return {
        agentSessionId,
        sessionCompatibilityKey: 'sha256:fixture',
        currentAgentSession: null,
        replacementRequired: false,
      };
    };
    executor.commitPreparedAgentSessionForTurn = async (_store, input) => {
      bindNanoHostAttemptPreparation(coreDb, {
        attemptId: input.attemptId,
        agentSessionId,
        inputRef: `aepsnap_${turnId}_${agentSessionId}`,
        bindingRef: `worker-loop:${input.attemptId}`,
        sessionCompatibilityKey: input.prepared.sessionCompatibilityKey,
      });
      return undefined;
    };
    executor.startTurn = (_store, id, prompt, context?: TurnStartRuntimeContext) => {
      workerCompletion = (async () => {
        const turn = store.getTurnById(id);
        bindWorkerCheckpointToPreparedSession({
          coreDb,
          workspaceDb: db,
          store,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId: id,
          requestId,
          agentSessionId,
          attemptId: context!.attemptId!,
        });
        hooks.observe?.(store.getTurnById(id), agentSessionId);
        const environmentPackage = resolveAgentEnvironmentPackage({
          coreDb,
          agentSessionId,
          agentSetup: context!.agentSetup!,
          backend: { kind: 'openshell' },
          createdAt: new Date().toISOString(),
          requestId,
          turn,
          turnInput: prompt,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        });
        recordAgentEnvironmentPackageSnapshot(db, {
          environmentPackage,
          createdAt: new Date().toISOString(),
        });
        const submitted = attempts.recordSchedulerExecutionOperation(coreDb, {
          attemptId: context!.attemptId!,
          operationId: `worker-loop:${id}`,
          submission: true,
        });
        attempts.acceptSchedulerExecutionObservation(
          coreDb,
          await executor.submit({
            ...attempts.schedulerExecutionCorrelation(submitted),
            deadline: submitted.deadline!,
          })
        );
        context!.onSubmissionSettled?.();
        try {
          await hooks.execute?.(id);
        } catch (error) {
          workerFailure = error;
          throw error;
        }
        const existing = store
          .listThreadAgentSessions(turn.workspaceId, turn.threadId)
          .find((session) => session.id === agentSessionId);
        if (!existing)
          store.createAgentSession({
            id: agentSessionId,
            agentId: manifest.id,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            status: 'idle',
            message: null,
            sessionCompatibilityKey: context!.sessionCompatibilityKey!,
            environmentPackageSnapshotId: environmentPackage.snapshotId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        const terminal = store.updateTurn(id, {
          status: 'completed',
          agentSessionId,
          completedAt: new Date().toISOString(),
        });
        store.emitTurnEvent(
          id,
          {
            event: 'turn.completed',
            requestId,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: id,
            data: { type: 'turn-completed', stopReason: 'completed', turn: terminal },
          },
          ALREADY_DECIDED_PUBLICATION_ADMISSION
        );
        // This controlled executor owns no physical process or additional output/collection streams.
        const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
          attemptId: submitted.attemptId,
          cause: 'turn-completed',
        });
        const proof = {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        } as const;
        const correlation = attempts.schedulerExecutionCorrelation(closing);
        const released = await executor.release({ ...correlation, proof });
        attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
          correlation,
          proof,
          fenceRef: released.fenceRef!,
        });
      })();
      return workerCompletion;
    };
    try {
      const completed = await startProductTurn({
        coreDb,
        store,
        triggerActor: { kind: 'user', id: actorId },
        requestActor,
        snapshot: createInMemoryRuntimeConfigSnapshot({
          agentManifests: [manifest],
          dataRoot: null,
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Fixture',
              kind: 'local',
              baseUrl: 'http://127.0.0.1:11434/v1',
              defaultModel: 'openai/gpt-5.2',
              models: ['openai/gpt-5.2'],
              modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
            },
          ]),
        }),
        providerCredentialResolver: () => null,
        reservedTurnId: turnId,
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          agentId: manifest.id,
          requestId,
          input: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
        },
        onTurnCreated: (created, sessionId) => {
          expect(sessionId).toBeNull();
          onAdmitted(created, sessionId);
          store.recordCommandRequest({
            command: 'turn.start',
            requestId,
            inputHash: `fixture:${requestId}`,
            scope: { actorId, workspaceId: created.workspaceId, threadId: created.threadId },
            response: { kind: 'turn', id: created.id },
          });
        },
        turnExecutor: executor,
      });
      if (workerCompletion) await workerCompletion;
      if (workerFailure) throw workerFailure;
      expect(completed.turn.status, JSON.stringify(completed.turn.error)).toBe('completed');
    } finally {
      db.sqlite.close();
    }
    return { workerSessionId: agentSessionId };
  };
}

/** Admission tests hold real dispatch at its executor boundary without external runtime effects. */
it.each([
  'fresh',
  'reused',
] as const)('binds the exact %s lease before executor entry and acknowledgement', async (kind) => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const sessionId = kind === 'reused' ? 'as_existing' : 'as_fresh';
  const at = '2026-10-06T00:00:00.000Z';
  if (kind === 'reused')
    store.createAgentSession({
      id: sessionId,
      sessionCompatibilityKey: 'sha256:fixture',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      agentId: createTestAgentSetup().manifest.id,
      status: 'idle',
      message: null,
      createdAt: at,
      updatedAt: at,
    });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const running = runWorkerTurnLoop({
    coreDb,
    store,
    workspaceDb,
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    triggerActor: { kind: 'user', id: 'user_local' },
    requestId: 'req_held',
    requestInputHash: 'sha256:held',
    reviewRequired: false,
    prepare: () => preparedWorkerTurn(false),
    reservedTurnId: 'tu_held',
    reserveTurn: () => ({ turnId: 'tu_held' }),
    startWorker: admittedWorker(coreDb, store, 'req_held', sessionId, 'user_local', undefined, {
      observe: () => {
        expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_held')).toMatchObject({
          stage: 'running_worker',
          workerSessionId: sessionId,
          stopReason: null,
        });
      },
      execute: async () => {
        entered.resolve();
        await release.promise;
      },
    }),
    awaitWorker: () => ({ stopReason: 'aborted' }),
  });
  try {
    await Promise.race([entered.promise, running]);
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_held')).toMatchObject({
      stage: 'running_worker',
      workerSessionId: sessionId,
    });
    release.resolve();
    await running;
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_held')).toMatchObject({
      stage: 'aborted',
      stopReason: 'aborted',
      workerSessionId: sessionId,
    });
  } finally {
    release.resolve();
    await running.catch(() => {});
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it.each([
  'authority-denial',
  'restart-cleanup',
  'incomplete-lease',
] as const)('preserves admitted interruption through %s and reopened classification without a second launch', async (failure) => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const error = new TurnStartValidationError(
    'workspace_access_denied',
    'Workspace access denied.',
    403
  );
  let launches = 0;
  const sessionId = 'as_interrupted';
  try {
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        triggerActor: { kind: 'user', id: 'user_local' },
        requestId: 'req_interrupted',
        requestInputHash: 'sha256:interrupted',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_interrupted',
        reserveTurn: () => ({ turnId: 'tu_interrupted' }),
        startWorker: admittedWorker(
          coreDb,
          store,
          'req_interrupted',
          sessionId,
          'user_local',
          undefined,
          {
            execute: async (turnId) => {
              launches++;
              const at = new Date().toISOString();
              store.createAgentSession({
                id: sessionId,
                workspaceId: 'ws_demo',
                threadId: 'th_demo',
                agentId: createTestAgentSetup().manifest.id,
                status: 'interrupted',
                message: null,
                createdAt: at,
                updatedAt: at,
              });
              const terminal = store.updateTurn(turnId, {
                status: 'interrupted',
                agentSessionId: sessionId,
                completedAt: at,
              });
              store.emitTurnEvent(
                turnId,
                {
                  event: 'turn.completed',
                  requestId: 'req_interrupted',
                  workspaceId: 'ws_demo',
                  threadId: 'th_demo',
                  turnId,
                  data: { type: 'turn-completed', stopReason: 'aborted', turn: terminal },
                },
                ALREADY_DECIDED_PUBLICATION_ADMISSION
              );
              throw error;
            },
          }
        ),
        awaitWorker: () => ({ stopReason: 'completed' }),
      })
    ).rejects.toBe(error);
    const checkpoint = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_interrupted')!;
    expect(checkpoint).toMatchObject({
      stage: 'running_worker',
      stopReason: null,
      workerSessionId: sessionId,
    });
    if (failure !== 'authority-denial') {
      const row = attempts.listSchedulerExecutionAttemptsForTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: checkpoint.turnId,
      })[0]!;
      const correlation = attempts.schedulerExecutionCorrelation(row);
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      const released = await new SimulatedTurnExecutor({ coreDb }).release({
        ...correlation,
        proof,
      });
      attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation,
        proof,
        fenceRef: released.fenceRef!,
      });
    }
    if (failure === 'incomplete-lease')
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET agent_session_id=? WHERE turn_id=?')
        .run('as_wrong', checkpoint.turnId);
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    const reopenedCore = openCoreDb(coreDb.dataRoot);
    const reopenedWorkspace = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    try {
      const reopenedStore = createDemoStore({ dataRoot: coreDb.dataRoot });
      expect(
        getWorkerCheckpoint(reopenedWorkspace, 'ws_demo', 'th_demo', checkpoint.turnId)
      ).toEqual(checkpoint);
      expect(
        resolveInterruptedWorkerRetryDecision(
          reopenedCore,
          reopenedStore,
          reopenedWorkspace,
          checkpoint
        ).status
      ).toBe(
        failure === 'restart-cleanup'
          ? 'eligible'
          : failure === 'authority-denial'
            ? 'stale'
            : 'recovery-required'
      );
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb: reopenedCore,
          store: reopenedStore,
          workspaceDb: reopenedWorkspace,
          checkpoint,
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(
        getWorkerCheckpoint(reopenedWorkspace, 'ws_demo', 'th_demo', checkpoint.turnId)
      ).toEqual(checkpoint);
      expect(launches).toBe(1);
    } finally {
      reopenedWorkspace.sqlite.close();
      reopenedCore.sqlite.close();
    }
  } finally {
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  }
});

it('refuses mismatched callback lineage before acknowledgement or executor effects', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  let acknowledgements = 0;
  let launches = 0;
  try {
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        triggerActor: { kind: 'user', id: 'user_local' },
        requestId: 'req_mismatch',
        requestInputHash: 'sha256:mismatch',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_mismatch',
        reserveTurn: () => ({ turnId: 'tu_mismatch' }),
        startWorker: ({ onAdmitted, ...input }) =>
          admittedWorker(coreDb, store, 'req_mismatch', 'as_exact', 'user_local', undefined, {
            observe: () => {
              acknowledgements++;
            },
            execute: async () => {
              launches++;
            },
          })({ ...input, onAdmitted: (turn, _session) => onAdmitted(turn, 'as_wrong') }),
        awaitWorker: () => ({ stopReason: 'completed' }),
      })
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(acknowledgements).toBe(0);
    expect(launches).toBe(0);
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_mismatch')).toMatchObject({
      stage: 'preparing',
      workerSessionId: null,
      stopReason: null,
    });
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('late admission callbacks cannot erase or recreate a terminal checkpoint binding', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  let callback!: WorkerTurnLoopStartWorkerInput['onAdmitted'];
  try {
    await runWorkerTurnLoop({
      coreDb,
      store,
      workspaceDb,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_local' },
      requestId: 'req_late',
      requestInputHash: 'sha256:late',
      reviewRequired: false,
      prepare: () => preparedWorkerTurn(false),
      reservedTurnId: 'tu_late',
      reserveTurn: () => ({ turnId: 'tu_late' }),
      startWorker: (input) => {
        callback = input.onAdmitted;
        return admittedWorker(coreDb, store, 'req_late', 'as_late')(input);
      },
      awaitWorker: () => ({ stopReason: 'completed' }),
    });
    const before = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_late');
    expect(before).toMatchObject({
      stage: 'completed',
      stopReason: 'completed',
      workerSessionId: 'as_late',
    });
    expect(() => callback(store.getTurnById('tu_late'), 'as_late')).toThrow(
      TurnStartValidationError
    );
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_late')).toEqual(before);
    clearWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_late');
    expect(() => callback(store.getTurnById('tu_late'), 'as_late')).toThrow(
      TurnStartValidationError
    );
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_late')).toBeNull();
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('a late completion error preserves an already terminal checkpoint and its exact session', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const error = new Error('Late completion failure');
  let terminal: ReturnType<typeof getWorkerCheckpoint>;
  try {
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        triggerActor: { kind: 'user', id: 'user_local' },
        requestId: 'req_terminal',
        requestInputHash: 'sha256:terminal',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_terminal',
        reserveTurn: () => ({ turnId: 'tu_terminal' }),
        startWorker: admittedWorker(coreDb, store, 'req_terminal', 'as_terminal'),
        awaitWorker: () => {
          terminal = updateWorkerCheckpoint(workspaceDb, {
            authorityActor: { kind: 'user', id: 'user_local' },
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'tu_terminal',
            stage: 'completed',
            stopReason: 'completed',
          });
          throw error;
        },
      })
    ).rejects.toBe(error);
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_terminal')).toEqual(
      terminal!
    );
    expect(terminal!).toMatchObject({
      stage: 'completed',
      stopReason: 'completed',
      workerSessionId: 'as_terminal',
    });
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('removes only its live never-leased cancelled preparation and retains cancellation before refusal', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  try {
    const independent = await runWorkerTurnLoop({
      coreDb,
      store,
      workspaceDb,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_local' },
      requestId: 'req_independent',
      requestInputHash: 'sha256:independent',
      reviewRequired: false,
      prepare: () => preparedWorkerTurn(false),
      reservedTurnId: 'tu_independent',
      reserveTurn: () => ({ turnId: 'tu_independent' }),
      startWorker: () => {
        throw new TurnStartValidationError('recovery_required', 'Retain preparation.', 409);
      },
      awaitWorker: () => ({ stopReason: 'completed' }),
    }).catch(() => getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_independent'));
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        triggerActor: { kind: 'user', id: 'user_local' },
        requestId: 'req_cancelled',
        requestInputHash: 'sha256:cancelled',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_cancelled',
        reserveTurn: () => ({ turnId: 'tu_cancelled' }),
        startWorker: cancelledWorker(coreDb, 'req_cancelled'),
        awaitWorker: () => {
          throw new Error('No worker outcome exists.');
        },
      })
    ).rejects.toThrow('Controlled pre-admission preparation refusal.');
    expect(
      coreDb.sqlite
        .prepare('SELECT status FROM scheduler_admission_entries WHERE request_id=?')
        .get('req_cancelled')
    ).toEqual({ status: 'cancelled' });
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_cancelled')).toBeNull();
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_independent')).toEqual(
      independent
    );
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    for (const table of ['worker_backend_sessions', 'worker_control_records'])
      expect(coreDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    expect(
      workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM runtime_evidence').get()
    ).toEqual({ count: 0 });
    expect(
      workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM permission_decisions').get()
    ).toEqual({ count: 2 });
    expect(store.listCommandRequests()).toEqual([]);
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

/** Cancels exact never-attempted intent before product publication; no Native effects exist. */
function cancelledWorker(coreDb: CoreDb, requestId: string) {
  return ({ turnId, prepared }: WorkerTurnLoopStartWorkerInput): never => {
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue_cancel_${turnId}`,
      requestId,
      turnId,
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
      requestedAgentId: createTestAgentSetup().manifest.id,
      triggerActor: { kind: 'user', id: 'user_local' },
      turnInput: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
    });
    cancelSchedulerAdmissionEntry(coreDb, {
      queueEntryId: entry.queueEntryId,
      workspaceId: entry.workspaceId,
    });
    throw new Error('Controlled pre-admission preparation refusal.');
  };
}

/**
 * Builds a real loop, scheduler and storage invocation with one controlled pre-admission preparation refusal.
 * @param coreDb Core admission owner.
 * @param workspaceDb Workspace checkpoint owner.
 * @param store Canonical product history owner.
 * @param mutate Fault injected after cancellation and before the loop receives the refusal.
 * @returns Invocation using the production admission and dispatch path.
 */
function cancelledLoopInput(
  coreDb: CoreDb,
  workspaceDb: WorkspaceDb,
  store: import('../lib/store.js').FsStore,
  mutate: () => void = () => {}
): RunWorkerTurnLoopInput {
  return {
    coreDb,
    workspaceDb,
    store,
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    triggerActor: { kind: 'user', id: 'user_local' },
    requestId: 'req_refusal',
    requestInputHash: 'sha256:refusal',
    reviewRequired: false,
    prepare: () => preparedWorkerTurn(false),
    reservedTurnId: 'tu_refusal',
    reserveTurn: () => ({ turnId: 'tu_refusal' }),
    startWorker: async (input) => {
      try {
        return cancelledWorker(coreDb, 'req_refusal')(input);
      } catch (error) {
        mutate();
        throw error;
      }
    },
    awaitWorker: () => {
      throw new Error('A refused preparation has no worker outcome.');
    },
  };
}

it.each([
  'lease',
  'turn',
  'global-turn',
  'input',
  'session',
  'backend',
  'control',
  'runtime-evidence',
  'changed-checkpoint',
  'changed-admission',
  'cancellation-failed',
  'rollback',
] as const)('preserves cancelled preparation when %s defeats the no-execution proof', async (kind) => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const at = '2026-10-06T00:00:00.000Z';
  let before: ReturnType<typeof getWorkerCheckpoint>;
  if (kind === 'cancellation-failed')
    coreDb.sqlite.exec(`CREATE TRIGGER refuse_cancel
      BEFORE UPDATE OF status ON scheduler_admission_entries WHEN NEW.status='cancelled'
      BEGIN SELECT RAISE(ABORT, 'Cancellation storage failure'); END`);
  const input = cancelledLoopInput(coreDb, workspaceDb, store, () => {
    if (kind === 'lease') {
      const row = coreDb.sqlite
        .prepare('SELECT queue_entry_id AS id FROM scheduler_admission_entries WHERE turn_id=?')
        .get('tu_refusal') as { id: string };
      coreDb.sqlite
        .prepare("UPDATE scheduler_admission_entries SET status='queued' WHERE queue_entry_id=?")
        .run(row.id);
      recordTestExecutionAttempt(coreDb, {
        entry: requireSchedulerAdmissionEntry(coreDb, row.id),
        attemptId: 'attempt_refusal',
        agentSessionId: 'as_refusal',
        inputRef: 'aepsnap_refusal',
        bindingRef: 'attempt-binding:refusal',
        sessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
        now: () => at,
      });
      coreDb.sqlite
        .prepare("UPDATE scheduler_admission_entries SET status='cancelled' WHERE queue_entry_id=?")
        .run(row.id);
    }
    if (kind === 'turn' || kind === 'global-turn') {
      const threadId =
        kind === 'global-turn' ? store.createThread('ws_demo', 'Other owner').id : 'th_demo';
      store.createTurn(
        'ws_demo',
        threadId,
        'Contradictory execution',
        { kind: 'user', id: 'user_local' },
        undefined,
        { turnId: 'tu_refusal' }
      );
    }
    if (kind === 'input') {
      const root = join(coreDb.dataRoot, 'workspaces/ws_demo/threads/th_demo/turns/tu_refusal');
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, 'items.jsonl'),
        JSON.stringify({ id: 'it_user_tu_refusal', type: 'user-message', text: 'Accepted input' })
      );
    }
    if (kind === 'session') {
      coreDb.sqlite
        .prepare(`INSERT INTO nanohost_runtime_targets (
        target_id, identity_id, deployment_id, connection_generation, predecessor_fenced,
        ready, fresh_empty, physical_epoch, observed_at, slot_count
      ) VALUES ('nanohost', 'identity', 'deployment', 1, 1, 1, 1, ?, ?, 1)`)
        .run('e'.repeat(64), at);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: 'e'.repeat(64),
        sandboxBindingRef: 'sandbox-binding',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding',
        sandboxRuntimeId: 'sandbox',
        runtimeTargetId: 'nanohost',
        timestamp: at,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'as_refusal',
        agentSessionRuntimeBindingId: 'as-binding',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness',
        threadId: 'th_demo',
        timestamp: at,
        workspaceId: 'ws_demo',
      });
      coreDb.sqlite
        .prepare('UPDATE agent_session_runtime_bindings SET current_turn_id=?')
        .run('tu_refusal');
    }
    if (kind === 'backend')
      coreDb.sqlite
        .prepare(`INSERT INTO worker_backend_sessions (
        attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, backend_kind, deployment_id,
        backend_session_id, staging_directory_ref, workspace_handoff_state, state, created_at, updated_at, origin_physical_epoch
        ) VALUES ('lease_refusal', 'ws_demo', 'th_demo', 'tu_refusal', 'as_refusal', 'aepsnap_refusal', 'openshell', 'deployment',
        'backend', 'staging', 'pending', 'materializing', ?, ?, ?)`)
        .run(at, at, 'e'.repeat(64));
    if (kind === 'control')
      coreDb.sqlite
        .prepare(`INSERT INTO worker_control_records (
        workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, request_id, operation, record_key, sequence, record_json, accepted_at
        ) VALUES ('ws_demo', 'th_demo', 'tu_refusal', 'as_refusal', 'aepsnap_refusal', 'req_refusal', 'observe', 'key', 1, '{}', ?)`)
        .run(at);
    if (kind === 'runtime-evidence')
      workspaceDb.sqlite
        .prepare(`INSERT INTO runtime_evidence (
        runtime_evidence_id, workspace_id, thread_id, turn_id, placement, phase, summary, upload_manifest_json, download_manifest_json,
        outcome, evidence_bundle_ids_json, content_digests_json, required_features_json, created_at
        ) VALUES ('rte_refusal', 'ws_demo', 'th_demo', 'tu_refusal', 'local', 'checkpoint', 'Contradiction', '[]', '[]', 'unknown', '[]', '[]', '[]', ?)`)
        .run(at);
    if (kind === 'changed-checkpoint')
      workspaceDb.sqlite
        .prepare(
          "UPDATE worker_turn_checkpoints SET request_input_hash='sha256:changed' WHERE turn_id='tu_refusal'"
        )
        .run();
    if (kind === 'changed-admission')
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_admission_entries SET turn_input='changed' WHERE turn_id='tu_refusal'"
        )
        .run();
    if (kind === 'rollback')
      workspaceDb.sqlite.exec(`CREATE TRIGGER refuse_removal
        BEFORE DELETE ON worker_turn_checkpoints BEGIN SELECT RAISE(ABORT, 'Workspace removal failure'); END`);
    before = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_refusal');
  });
  try {
    if (kind === 'rollback')
      await expect(runWorkerTurnLoop(input)).rejects.toThrow('Workspace removal failure');
    else await expect(runWorkerTurnLoop(input)).rejects.toThrow();
    if (kind === 'lease') {
      // Retained execution contradicts the cancelled admission's no-execution claim.
      // Placement plans have no successor relation; keep the exact attempt/admission link.
      const exists = coreDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
        )
        .get();
      expect(exists, 'This fault must positively retain execution evidence.').toBeDefined();
      expect(
        coreDb.sqlite
          .prepare('SELECT turn_id FROM scheduler_execution_attempts WHERE turn_id = ?')
          .all('tu_refusal')
      ).toEqual([{ turn_id: 'tu_refusal' }]);
    }
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_refusal')).toEqual(before!);
    expect(before!).toMatchObject({ stage: 'preparing', workerSessionId: null, stopReason: null });
    expect(
      coreDb.sqlite
        .prepare('SELECT status FROM scheduler_admission_entries WHERE request_id=?')
        .get('req_refusal')
    ).toEqual({ status: kind === 'cancellation-failed' ? 'queued' : 'cancelled' });
    if (kind === 'rollback') {
      const reopenedCore = openCoreDb(coreDb.dataRoot);
      const reopenedWorkspace = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        const residual = getWorkerCheckpoint(reopenedWorkspace, 'ws_demo', 'th_demo', 'tu_refusal');
        expect(residual).toEqual(before!);
        await expect(
          classifyDirectTaskCheckpointAfterSchedulerRecovery({
            coreDb: reopenedCore,
            store,
            workspaceDb: reopenedWorkspace,
            checkpoint: residual!,
          })
        ).rejects.toMatchObject({ code: 'recovery_required' });
        expect(getWorkerCheckpoint(reopenedWorkspace, 'ws_demo', 'th_demo', 'tu_refusal')).toEqual(
          before!
        );
      } finally {
        reopenedWorkspace.sqlite.close();
        reopenedCore.sqlite.close();
      }
    }
    if (!['plan', 'lease', 'session', 'global-turn', 'input', 'turn'].includes(kind)) {
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb,
          store,
          workspaceDb,
          checkpoint: before!,
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_refusal')).toEqual(before!);
    }
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('cancelled request replay cannot prepare or launch again after checkpoint removal, including reopened storage', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  await expect(runWorkerTurnLoop(cancelledLoopInput(coreDb, workspaceDb, store))).rejects.toThrow();
  workspaceDb.sqlite.close();
  coreDb.sqlite.close();
  const reopenedCore = openCoreDb(coreDb.dataRoot);
  const reopenedWorkspace = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  try {
    const replay = cancelledLoopInput(
      reopenedCore,
      reopenedWorkspace,
      createDemoStore({ dataRoot: coreDb.dataRoot })
    );
    const prepare = vi.fn(replay.prepare);
    const startWorker = vi.fn(replay.startWorker);
    await expect(runWorkerTurnLoop({ ...replay, prepare, startWorker })).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
    expect(getWorkerCheckpoint(reopenedWorkspace, 'ws_demo', 'th_demo', 'tu_refusal')).toBeNull();
    expect(
      reopenedCore.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
    ).toEqual({ count: 1 });
  } finally {
    reopenedWorkspace.sqlite.close();
    reopenedCore.sqlite.close();
  }
});

it.each([
  'user_other',
  'user_local',
])('an unrelated admission with the same request ID does not block or erase this reserved Turn (%s)', async (actorId) => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  try {
    // Request UUID alone is not command identity: actor and Thread scope remain exact.
    const unrelated = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_other',
      requestId: 'req_refusal',
      turnId: 'tu_other',
      threadId: actorId === 'user_local' ? 'th_other' : 'th_demo',
      workspaceId: 'ws_demo',
      requestedAgentId: createTestAgentSetup().manifest.id,
      triggerActor: { kind: 'user', id: actorId },
      turnInput: serializeStructuredWorkerDelegationRequest(
        preparedWorkerTurn(false).delegationRequest
      ),
    });
    cancelSchedulerAdmissionEntry(coreDb, {
      queueEntryId: unrelated.queueEntryId,
      workspaceId: unrelated.workspaceId,
    });
    const other = coreDb.sqlite
      .prepare("SELECT * FROM scheduler_admission_entries WHERE turn_id='tu_other'")
      .get();
    await expect(
      runWorkerTurnLoop(cancelledLoopInput(coreDb, workspaceDb, store))
    ).rejects.toThrow();
    expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_refusal')).toBeNull();
    expect(
      coreDb.sqlite
        .prepare("SELECT * FROM scheduler_admission_entries WHERE turn_id='tu_other'")
        .get()
    ).toEqual(other);
    expect(
      coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
    ).toEqual({ count: 2 });
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('process loss after durable cancellation leaves preparation for fail-closed restart inspection', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const input = cancelledLoopInput(coreDb, workspaceDb, store);
  let signalCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    signalCancellation = resolve;
  });
  // Abandon the live invocation after Core commits, before its refusal returns to the loop. No cleanup callback survives this simulated process-loss boundary.
  void runWorkerTurnLoop({
    ...input,
    startWorker: async (start) => {
      try {
        return await input.startWorker(start);
      } catch {
        signalCancellation();
        return new Promise<never>(() => {});
      }
    },
  });
  await cancellation;
  const before = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_refusal');
  expect(before).toMatchObject({ stage: 'preparing', workerSessionId: null, stopReason: null });
  expect(
    coreDb.sqlite
      .prepare("SELECT status FROM scheduler_admission_entries WHERE turn_id='tu_refusal'")
      .get()
  ).toEqual({ status: 'cancelled' });
  workspaceDb.sqlite.close();
  coreDb.sqlite.close();
  const reopenedCore = openCoreDb(coreDb.dataRoot);
  const reopenedWorkspace = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  try {
    await expect(
      classifyDirectTaskCheckpointAfterSchedulerRecovery({
        coreDb: reopenedCore,
        store,
        workspaceDb: reopenedWorkspace,
        checkpoint: before!,
      })
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(getWorkerCheckpoint(reopenedWorkspace, 'ws_demo', 'th_demo', 'tu_refusal')).toEqual(
      before
    );

    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
  } finally {
    reopenedWorkspace.sqlite.close();
    reopenedCore.sqlite.close();
  }
});

it('a changed reservation cannot overwrite the declared command Turn identity', async () => {
  const coreDb = createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  try {
    const input = cancelledLoopInput(coreDb, workspaceDb, store);
    const startWorker = vi.fn(input.startWorker);
    await expect(
      runWorkerTurnLoop({ ...input, startWorker, reserveTurn: () => ({ turnId: 'tu_changed' }) })
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(startWorker).not.toHaveBeenCalled();
    expect(
      workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_turn_checkpoints').get()
    ).toEqual({ count: 0 });
    expect(
      coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
    ).toEqual({ count: 0 });
  } finally {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});
