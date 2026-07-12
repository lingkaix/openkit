import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema, TurnSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { FsStore } from './lib/store.js';
import type {
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './runtime/types.js';
import type { CoreDb } from './storage/db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

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
 * @returns App, stores, databases, and repository fixture.
 */
async function createSchedulerFixture(executor: RecordingTurnExecutor, slug: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-turn-routes-${slug}-`));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore();
  const app = createApp({ coreDb, store, turnExecutor: executor });
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
 * @param userId Store owner id.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Turn-start request id.
 * @returns Scheduler-owned turn id.
 */
function schedulerTurnId(
  userId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const suffix = createHash('sha256')
    .update(`${userId}:${workspaceId}:${threadId}:${requestId}`)
    .digest('hex')
    .slice(0, 16);

  return `turn_${requestId}_${suffix}`;
}

describe('generic turn routes', () => {
  it('reads one turn through its owning workspace and thread path', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Read this turn');
    const app = createApp({ store, turnExecutor: new RecordingTurnExecutor() });

    const response = await app.request(`/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}`);

    expect(response.status).toBe(200);
    expect(TurnSchema.parse(await response.json())).toEqual(turn);
  });

  it('does not read a turn through a different workspace or thread path', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Keep this turn scoped');
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
    const turn = store.createTurn('ws_demo', 'th_demo', 'Do not interrupt across scopes');
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
    const turn = store.createTurn('ws_demo', 'th_demo', 'Unsupported interrupt');
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
    const created = store.createTurn('ws_demo', 'th_demo', 'Already complete');
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
    const turnId = schedulerTurnId(fixture.store.getUserId(), 'ws_demo', threadId, requestId);
    const sourceCatalogPath = join(
      fixture.coreDb.dataRoot,
      'users',
      fixture.store.getUserId(),
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
