import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema, TurnSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import type {
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './runtime/types.js';
import { upsertWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import type { CoreDb } from './storage/db.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const LOCAL_ACTOR = { kind: 'user', id: 'user_local' } as const;

/** Minimal turn executor that records route calls and applies deterministic turn transitions. */
class RecordingTurnExecutor implements TurnExecutor {
  public readonly capabilities: TurnExecutor['capabilities'];
  public readonly eventFamilies: TurnExecutor['eventFamilies'] = [];
  public interruptCalls = 0;
  public startCalls = 0;
  private readonly completeStarts: boolean;

  /**
   * Creates a route-level executor with explicit start and interrupt behavior.
   *
   * @param options Whether starts complete synchronously and interrupts are supported.
   */
  public constructor(
    options: { readonly completeStarts?: boolean; readonly interrupts?: boolean } = {}
  ) {
    this.capabilities = {
      approvals: false,
      artifacts: false,
      interrupts: options.interrupts ?? true,
      questions: false,
      workspaceConfig: true,
      workspaceKnowledgeEditing: false,
    };
    this.completeStarts = options.completeStarts ?? true;
  }

  /**
   * Records one start and optionally completes the created turn synchronously.
   *
   * @param store Store that owns the turn.
   * @param turnId Turn selected by the scheduler.
   * @param _input User input accepted for the turn.
   * @param _context Scheduler-owned runtime context.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    _input: string,
    _context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startCalls += 1;

    if (this.completeStarts) {
      store.updateTurn(turnId, {
        completedAt: new Date().toISOString(),
        status: 'completed',
      });
    }
  }

  /**
   * Records one interrupt and marks the selected turn interrupted.
   *
   * @param store Store that owns the turn.
   * @param turnId Turn selected by the route.
   * @param _context Request correlation context.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    _context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    this.interruptCalls += 1;
    store.updateTurn(turnId, {
      completedAt: new Date().toISOString(),
      status: 'interrupted',
    });
  }
}

/**
 * Creates a scheduler-backed app with one ready repository.
 *
 * @param executor Turn executor installed in the app.
 * @param slug Stable temporary-directory label.
 * @param workerPlacement Configured worker Cell placement.
 * @returns App, stores, databases, and repository fixture.
 */
async function createSchedulerFixture(
  executor: RecordingTurnExecutor,
  slug: string,
  workerPlacement: 'local' | 'remote' = 'local'
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-turn-routes-${slug}-`));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore();
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  const app = createApp({
    agentManifests: [createTestAgentSetup({ provider: null, requiredCapabilities: [] }).manifest],
    coreDb,
    store,
    turnExecutor: executor,
    workerPlacement,
  });
  const repositoryPath = mkdtempSync(join(tmpdir(), `openkit-turn-repository-${slug}-`));
  mkdirSync(join(repositoryPath, '.git'));

  const link = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
    method: 'PUT',
    body: JSON.stringify({
      displayName: `Turn route repository ${slug}`,
      localPath: repositoryPath,
    }),
    headers: { 'content-type': 'application/json' },
  });

  if (link.status !== 200) {
    coreDb.sqlite.close();
    throw new Error(`Failed to link the turn route repository: ${await link.text()}`);
  }

  return { app, coreDb, repositoryPath, store };
}

/** Creates session authentication from one test-only user header. */
function createHeaderAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) => {
        const userId = headers.get('x-user-id');
        return userId ? { session: { id: `session_${userId}` }, user: { id: userId } } : null;
      },
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/** Creates a server-mode scheduler fixture with an owner and an editor in one Workspace. */
async function createSharedSchedulerFixture(executor: RecordingTurnExecutor, slug: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-turn-routes-shared-${slug}-`));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind
      ) VALUES ('user_other', 'Other User', 'other@example.com', false, ?, ?, 'human')`
    )
    .run(now, now);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES ('ws_demo', 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(timestamp, timestamp, timestamp);

  const store = createDemoStore();
  const app = createApp({
    agentManifests: [createTestAgentSetup({ provider: null, requiredCapabilities: [] }).manifest],
    auth: createHeaderAuthStub(),
    coreDb,
    mode: 'server',
    store,
    turnExecutor: executor,
  });
  const repositoryPath = mkdtempSync(join(tmpdir(), `openkit-turn-shared-repository-${slug}-`));
  mkdirSync(join(repositoryPath, '.git'));
  const link = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
    method: 'PUT',
    body: JSON.stringify({
      displayName: 'Shared Turn route repository',
      localPath: repositoryPath,
    }),
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_local' },
  });
  if (link.status !== 200) {
    coreDb.sqlite.close();
    throw new Error(`Failed to link the shared turn route repository: ${await link.text()}`);
  }

  return { app, coreDb, dataRoot, repositoryPath, store };
}

/**
 * Reads the scheduler lease that owns one product turn.
 *
 * @param coreDb Open Core database.
 * @param turnId Product turn id.
 * @returns Stored lease status and release reason, when present.
 */
function readTurnLease(coreDb: CoreDb, turnId: string) {
  return coreDb.sqlite
    .prepare(
      `SELECT status, release_reason AS releaseReason
       FROM scheduler_session_leases
       WHERE turn_id = ?
       ORDER BY acquired_at DESC
       LIMIT 1`
    )
    .get(turnId) as { readonly releaseReason: string | null; readonly status: string } | undefined;
}

/**
 * Reproduces the scheduler-owned deterministic turn id for failed-start orphan checks.
 *
 * @param canonicalActorRef Canonical serialized trigger ActorRef.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Turn-start request id.
 * @returns Scheduler-owned turn id.
 */
function schedulerTurnId(
  canonicalActorRef: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const suffix = createHash('sha256')
    .update(`${canonicalActorRef}:${workspaceId}:${threadId}:${requestId}`)
    .digest('hex')
    .slice(0, 16);

  return `turn_${requestId}_${suffix}`;
}

describe('generic turn routes', () => {
  it('reads one turn through its owning workspace and thread path', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Read this turn', LOCAL_ACTOR);
    const app = createApp({ store, turnExecutor: new RecordingTurnExecutor() });

    const response = await app.request(`/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}`);

    expect(response.status).toBe(200);
    expect(TurnSchema.parse(await response.json())).toEqual(turn);
  });

  it('does not read a turn through a different workspace or thread path', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Keep this turn scoped', LOCAL_ACTOR);
    const app = createApp({ store, turnExecutor: new RecordingTurnExecutor() });

    for (const path of [
      `/api/workspaces/ws_quick_chat/threads/th_demo/turns/${turn.id}`,
      `/api/workspaces/ws_demo/threads/th_missing/turns/${turn.id}`,
    ]) {
      const response = await app.request(path);

      expect(response.status).toBe(404);
      expect(ApiErrorSchema.parse(await response.json()).code).toBe('not_found');
    }
  });

  it('rejects an interrupt scope mismatch before executor or store mutation', async () => {
    const store = createDemoStore();
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Do not interrupt across scopes',
      LOCAL_ACTOR
    );
    const executor = new RecordingTurnExecutor();
    const app = createApp({ store, turnExecutor: executor });

    const response = await app.request(
      `/api/workspaces/ws_demo/threads/th_missing/turns/${turn.id}/interrupt`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000306',
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const payload = (await response.json()) as { readonly code?: string };

    expect({
      commandRecords: store.listCommandRequests().length,
      executorCalls: executor.interruptCalls,
      responseCode: payload.code,
      responseStatus: response.status,
      turnStatus: store.getTurn(turn.workspaceId, turn.threadId, turn.id).status,
    }).toEqual({
      commandRecords: 0,
      executorCalls: 0,
      responseCode: 'turn_interrupt_failed',
      responseStatus: 404,
      turnStatus: 'running',
    });
  });

  it('returns typed unsupported without mutating when the executor cannot interrupt', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Unsupported interrupt', LOCAL_ACTOR);
    const executor = new RecordingTurnExecutor({ interrupts: false });
    const app = createApp({ store, turnExecutor: executor });

    const response = await app.request(
      `/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}/interrupt`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000307',
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const payload = (await response.json()) as { readonly code?: string };

    expect({
      commandRecords: store.listCommandRequests().length,
      executorCalls: executor.interruptCalls,
      responseCode: payload.code,
      responseStatus: response.status,
      turnStatus: store.getTurn(turn.workspaceId, turn.threadId, turn.id).status,
    }).toEqual({
      commandRecords: 0,
      executorCalls: 0,
      responseCode: 'interrupts_not_supported',
      responseStatus: 501,
      turnStatus: 'running',
    });
  });

  it('does not rewrite a terminal turn through a new interrupt command', async () => {
    const store = createDemoStore();
    const created = store.createTurn('ws_demo', 'th_demo', 'Already complete', LOCAL_ACTOR);
    const turn = store.updateTurn(created.id, {
      completedAt: '2026-07-12T00:00:00.000Z',
      status: 'completed',
    });
    const executor = new RecordingTurnExecutor();
    const app = createApp({ store, turnExecutor: executor });

    const response = await app.request(
      `/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}/interrupt`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000308',
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const payload = (await response.json()) as { readonly code?: string };
    const storedTurn = store.getTurn(turn.workspaceId, turn.threadId, turn.id);

    expect({
      commandRecords: store.listCommandRequests().length,
      completedAtUnchanged: storedTurn.completedAt === turn.completedAt,
      executorCalls: executor.interruptCalls,
      responseCode: payload.code,
      responseStatus: response.status,
      turnStatus: storedTurn.status,
    }).toEqual({
      commandRecords: 0,
      completedAtUnchanged: true,
      executorCalls: 0,
      responseCode: 'turn_not_interruptible',
      responseStatus: 409,
      turnStatus: 'completed',
    });
  });

  it('rejects a UserInput Gate response from a different Workspace editor', async () => {
    const executor = new RecordingTurnExecutor({ completeStarts: false });
    const fixture = await createSharedSchedulerFixture(executor, 'responsible-user');
    const startRequestId = '00000000-0000-4000-8000-000000000410';

    try {
      const startResponse = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          input: 'Pause for the responsible user.',
          requestId: startRequestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_local' },
      });
      expect(startResponse.status, await startResponse.clone().text()).toBe(202);
      const turn = TurnSchema.parse(await startResponse.json());
      const acceptedAt = turn.startedAt ?? new Date().toISOString();
      const requestItem = fixture.store.createItem({
        id: `it_responsible_user_${turn.id}`,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'user-input-request',
        status: 'completed',
        responsibleUserId: 'user_local',
        userInputRequestId: `ui_responsible_user_${turn.id}`,
        prompt: 'Only the responsible user may answer.',
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Continue?',
            options: null,
            isOther: false,
            isSecret: false,
          },
        ],
        createdAt: acceptedAt,
        completedAt: acceptedAt,
      });
      fixture.store.updateTurn(turn.id, {
        status: 'awaiting_human',
        humanGate: {
          kind: 'user-input',
          userInputRequestId: requestItem.userInputRequestId,
          itemId: requestItem.id,
        },
      });
      const lease = fixture.coreDb.sqlite
        .prepare(
          `SELECT agent_session_id AS agentSessionId
           FROM scheduler_session_leases
           WHERE turn_id = ?`
        )
        .get(turn.id) as { readonly agentSessionId: string } | undefined;
      if (!lease) {
        throw new Error('Expected one scheduler lease for the responsible-user fixture.');
      }
      const workspaceDb = openWorkspaceDb(fixture.dataRoot, 'ws_demo');
      try {
        applyScopedMigrations(workspaceDb);
        upsertWorkerCheckpoint(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          requestId: startRequestId,
          requestInputHash: 'sha256:responsible-user-fixture',
          stage: 'waiting_for_user',
          iteration: 1,
          workerSessionId: lease.agentSessionId,
          stopReason: 'ask_user',
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const response = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          answers: { choice: ['Continue'] },
          requestId: '00000000-0000-4000-8000-000000000411',
          threadId: 'th_demo',
          turnId: turn.id,
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_other' },
      });

      expect(response.status, await response.clone().text()).toBe(403);
      expect(ApiErrorSchema.parse(await response.json()).code).toBe('workspace_access_denied');
      expect(fixture.store.getTurn('ws_demo', 'th_demo', turn.id).status).toBe('awaiting_human');
      expect(
        fixture.store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.type === 'user-input-response')
      ).toEqual([]);
    } finally {
      fixture.coreDb.sqlite.close();
      rmSync(fixture.repositoryPath, { force: true, recursive: true });
    }
  });

  it('releases the scheduler lease when a new turn completes synchronously', async () => {
    const executor = new RecordingTurnExecutor();
    const fixture = await createSchedulerFixture(executor, 'completed-lease');

    try {
      const response = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          input: 'Complete synchronously',
          requestId: '00000000-0000-4000-8000-000000000301',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = TurnSchema.parse(await response.json());

      expect(response.status).toBe(202);
      expect(turn.status).toBe('completed');
      expect(readTurnLease(fixture.coreDb, turn.id)).toEqual({
        releaseReason: 'turn-completed',
        status: 'released',
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('admits a remote product turn into the configured remote Cell target', async () => {
    const executor = new RecordingTurnExecutor();
    const fixture = await createSchedulerFixture(executor, 'remote-placement', 'remote');

    try {
      const response = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          input: 'Run in the remote Cell',
          requestId: '00000000-0000-4000-8000-000000000309',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const admission = fixture.coreDb.sqlite
        .prepare(
          `SELECT required_pool_constraints_json AS requiredPoolConstraints
           FROM scheduler_admission_entries
           WHERE request_id = ?`
        )
        .get('00000000-0000-4000-8000-000000000309') as {
        readonly requiredPoolConstraints: string;
      };
      const placementPlan = fixture.coreDb.sqlite
        .prepare(
          `SELECT selected_pool_id AS selectedPoolId, selected_target_id AS selectedTargetId
           FROM scheduler_placement_plans
           WHERE queue_entry_id = (
             SELECT queue_entry_id FROM scheduler_admission_entries WHERE request_id = ?
           )`
        )
        .get('00000000-0000-4000-8000-000000000309');
      const pool = fixture.coreDb.sqlite
        .prepare(
          `SELECT allowed_placements_json AS allowedPlacements,
                  max_concurrent_sessions AS maxConcurrentSessions
           FROM scheduler_worker_pools
           WHERE pool_id = 'pool_remote'`
        )
        .get() as { readonly allowedPlacements: string; readonly maxConcurrentSessions: number };
      const target = fixture.coreDb.sqlite
        .prepare(
          `SELECT capacity.capacity_class AS capacityClass,
                  capacity.concurrency_ceiling AS concurrencyCeiling,
                  health.health_state AS healthState
           FROM scheduler_capacity_records AS capacity
           JOIN scheduler_target_health_records AS health USING (target_id)
           WHERE capacity.target_id = 'target_remote'`
        )
        .get();
      const leaseTiming = fixture.coreDb.sqlite
        .prepare(
          `SELECT acquired_at AS acquiredAt,
                  expires_at AS expiresAt,
                  startup_deadline AS startupDeadline
           FROM scheduler_session_leases
           WHERE plan_id = (
             SELECT plan_id FROM scheduler_placement_plans
             WHERE queue_entry_id = (
               SELECT queue_entry_id FROM scheduler_admission_entries WHERE request_id = ?
             )
           )`
        )
        .get('00000000-0000-4000-8000-000000000309') as {
        readonly acquiredAt: string;
        readonly expiresAt: string;
        readonly startupDeadline: string;
      };

      expect({
        admissionConstraint: JSON.parse(admission.requiredPoolConstraints),
        allowedPlacements: JSON.parse(pool.allowedPlacements),
        executorStarts: executor.startCalls,
        leaseDurationMs: Date.parse(leaseTiming.expiresAt) - Date.parse(leaseTiming.acquiredAt),
        placementPlan,
        poolConcurrency: pool.maxConcurrentSessions,
        responseStatus: response.status,
        startupTimeoutMs:
          Date.parse(leaseTiming.startupDeadline) - Date.parse(leaseTiming.acquiredAt),
        target,
      }).toEqual({
        admissionConstraint: ['openshell.remote'],
        allowedPlacements: ['remote'],
        executorStarts: 1,
        leaseDurationMs: 2_400_000,
        placementPlan: { selectedPoolId: 'pool_remote', selectedTargetId: 'target_remote' },
        poolConcurrency: 1,
        responseStatus: 202,
        startupTimeoutMs: 1_500_000,
        target: { capacityClass: 'remote', concurrencyCeiling: 1, healthState: 'healthy' },
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('releases the scheduler lease after a supported interrupt', async () => {
    const executor = new RecordingTurnExecutor({ completeStarts: false });
    const fixture = await createSchedulerFixture(executor, 'interrupt-lease');

    try {
      const startResponse = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          input: 'Keep running until interrupted',
          requestId: '00000000-0000-4000-8000-000000000302',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const startedTurn = TurnSchema.parse(await startResponse.json());
      const interruptResponse = await fixture.app.request(
        `/api/workspaces/ws_demo/threads/th_demo/turns/${startedTurn.id}/interrupt`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000303',
            threadId: 'th_demo',
            turnId: startedTurn.id,
            workspaceId: 'ws_demo',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );
      const interruptedTurn = TurnSchema.parse(await interruptResponse.json());

      expect({
        interruptCalls: executor.interruptCalls,
        interruptStatus: interruptResponse.status,
        lease: readTurnLease(fixture.coreDb, startedTurn.id),
        startStatus: startResponse.status,
        turnStatus: interruptedTurn.status,
      }).toEqual({
        interruptCalls: 1,
        interruptStatus: 200,
        lease: { releaseReason: 'turn-interrupted', status: 'released' },
        startStatus: 202,
        turnStatus: 'interrupted',
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('replays a successful turn start before revalidating mutable repository state', async () => {
    const executor = new RecordingTurnExecutor();
    const fixture = await createSchedulerFixture(executor, 'repository-replay');
    const body = {
      input: 'Replay this completed turn',
      requestId: '00000000-0000-4000-8000-000000000304',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    };

    try {
      const firstResponse = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      const firstTurn = TurnSchema.parse(await firstResponse.json());
      rmSync(join(fixture.repositoryPath, '.git'), { force: true, recursive: true });

      const replayResponse = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      const replayPayload = (await replayResponse.json()) as { readonly id?: string };

      expect({
        executorStarts: executor.startCalls,
        firstStatus: firstResponse.status,
        replayedTurnId: replayPayload.id,
        replayStatus: replayResponse.status,
      }).toEqual({
        executorStarts: 1,
        firstStatus: 202,
        replayedTurnId: firstTurn.id,
        replayStatus: 202,
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('rejects an invalid thread before scheduler, store, or source-context side effects', async () => {
    const executor = new RecordingTurnExecutor({ completeStarts: false });
    const fixture = await createSchedulerFixture(executor, 'invalid-thread');
    const requestId = '00000000-0000-4000-8000-000000000305';
    const threadId = 'th_missing';
    const turnId = schedulerTurnId(
      JSON.stringify({ kind: 'user', id: 'user_local' }),
      'ws_demo',
      threadId,
      requestId
    );
    const sourceCatalogPath = join(
      fixture.coreDb.dataRoot,
      'workspaces',
      'ws_demo',
      'config',
      'data-sources.jsonc'
    );
    rmSync(sourceCatalogPath, { force: true });

    try {
      const response = await fixture.app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          input: 'Do not admit an invalid thread',
          requestId,
          threadId,
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const payload = (await response.json()) as { readonly code?: string };
      const admissionCount = (
        fixture.coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries WHERE request_id = ?')
          .get(requestId) as { readonly count: number }
      ).count;
      const leaseCount = (
        fixture.coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases WHERE turn_id = ?')
          .get(turnId) as { readonly count: number }
      ).count;
      let orphanTurnExists = true;
      try {
        fixture.store.getTurnById(turnId);
      } catch {
        orphanTurnExists = false;
      }

      expect({
        admissionCount,
        commandRecords: fixture.store.listCommandRequests().length,
        executorStarts: executor.startCalls,
        leaseCount,
        orphanTurnExists,
        responseCode: payload.code,
        responseStatus: response.status,
        sourceCatalogExists: existsSync(sourceCatalogPath),
      }).toEqual({
        admissionCount: 0,
        commandRecords: 0,
        executorStarts: 0,
        leaseCount: 0,
        orphanTurnExists: false,
        responseCode: 'turn_start_failed',
        responseStatus: 404,
        sourceCatalogExists: false,
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });
});
