import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { FsStore } from '../lib/store.js';
import type { TurnExecutor, TurnStartRuntimeContext } from '../runtime/types.js';
import {
  ensureLocalhostSchedulerBaseline,
  upsertSchedulerCapacityRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { importUnboundWorkspaceVaultReference } from '../vault/vault-references.js';
import { createBetterAuth } from './better-auth.js';

/**
 * Extracts the first cookie pair from a Set-Cookie header.
 *
 * @param response Response carrying a Set-Cookie header.
 * @returns Cookie header value for follow-up requests.
 */
function sessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');

  if (!setCookie) {
    throw new Error('Expected response to set a session cookie.');
  }

  return setCookie.split(';')[0] ?? '';
}

/**
 * Server-flow test executor that keeps accepted turns in flight until released.
 */
class DelayedServerTurnExecutor implements TurnExecutor {
  /** Product-visible capabilities for server scoping tests. */
  public readonly capabilities = {
    approvals: false,
    interrupts: false,
    artifacts: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
    questions: false,
  };

  /** Event families exposed by this minimal executor. */
  public readonly eventFamilies = ['turn.started', 'turn.completed'] as const;

  /** Stores each accepted turn id so tests can verify per-user execution. */
  public readonly startedTurnIds: string[] = [];

  private releaseStart: (() => void) | null = null;
  private readonly startGate = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });

  /**
   * Releases all blocked turn starts.
   */
  public release(): void {
    this.releaseStart?.();
  }

  /**
   * Starts one delayed turn.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    _input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startedTurnIds.push(turnId);
    const turn = store.getTurnById(turnId);
    store.emitTurnEvent(turnId, {
      event: 'turn.started',
      requestId: context.requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-started', turnId, status: 'running' },
    });
    await this.startGate;
    const completedTurn = store.updateTurn(turnId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId: context.requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
    });
  }

  /**
   * No-op interrupt implementation for the test executor contract.
   */
  public async interruptTurn(): Promise<void> {
    return;
  }
}

/**
 * Waits briefly for the delayed executor to accept a target number of starts.
 *
 * @param executor Executor being observed.
 * @param count Expected number of starts.
 * @returns Promise that settles after the target count or timeout.
 */
async function waitForStartCount(
  executor: DelayedServerTurnExecutor,
  count: number
): Promise<void> {
  const deadline = Date.now() + 50;

  while (executor.startedTurnIds.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Configures local scheduler capacity for concurrent server-mode user tests.
 *
 * @param coreDb Migrated Core database handles.
 * @param capacity Concurrent local lease capacity.
 */
function configureLocalSchedulerCapacity(coreDb: CoreDb, capacity: number): void {
  ensureLocalhostSchedulerBaseline(coreDb);
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 0,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: capacity,
    poolId: 'pool_local',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: capacity,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: new Date().toISOString(),
    poolId: 'pool_local',
    queueDepth: 0,
    targetId: 'target_local',
  });
}

/**
 * Reads the first workspace and first thread visible to a server-mode session.
 *
 * @param app NanoCore app under test.
 * @param cookie Session cookie.
 * @returns Default workspace and thread ids for that actor.
 */
async function readDefaultScope(
  app: ReturnType<typeof createApp>,
  cookie: string
): Promise<{ workspaceId: string; threadId: string }> {
  const workspaceRes = await app.request('/api/workspaces', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Server Flow Workspace',
      requestId: randomUUID(),
    }),
  });
  const workspaceBody = (await workspaceRes.json()) as { id?: string };
  const workspaceId = workspaceBody.id;

  if (!workspaceId) {
    throw new Error('Expected project workspace to be created.');
  }

  const threadRes = await app.request(`/api/workspaces/${workspaceId}/threads`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Server Flow Thread',
      requestId: randomUUID(),
    }),
  });
  const threadBody = (await threadRes.json()) as { id?: string };
  const threadId = threadBody.id;

  if (!threadId) {
    throw new Error('Expected project thread to be created.');
  }

  return { workspaceId, threadId };
}

describe('server auth flow', () => {
  it('signs up, signs in, scopes workspaces per user, persists sessions, and signs out', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-flow-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    try {
      const app = createApp({
        auth: createBetterAuth(coreDb),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const firstSignUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'first@example.com',
          name: 'First User',
          password: 'password123456',
        }),
      });

      expect(firstSignUp.status).toBe(200);

      const firstCookie = sessionCookie(firstSignUp);
      const createWorkspace = await app.request('/api/workspaces', {
        method: 'POST',
        headers: { cookie: firstCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000401',
          name: 'First private workspace',
        }),
      });

      expect(createWorkspace.status).toBe(201);

      const firstWorkspace = (await createWorkspace.json()) as { id: string; name: string };
      const firstList = await app.request('/api/workspaces', {
        headers: { cookie: firstCookie },
      });

      expect(firstList.status).toBe(200);
      expect((await firstList.json()) as { items: Array<{ id: string }> }).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({ id: firstWorkspace.id })]),
      });

      const secondSignUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'second@example.com',
          name: 'Second User',
          password: 'password123456',
        }),
      });

      expect(secondSignUp.status).toBe(200);

      const secondCookie = sessionCookie(secondSignUp);
      const crossUserGet = await app.request(`/api/workspaces/${firstWorkspace.id}`, {
        headers: { cookie: secondCookie },
      });

      expect(crossUserGet.status).toBe(403);
      await expect(crossUserGet.json()).resolves.toMatchObject({
        code: 'core.auth.scope_forbidden',
      });

      importUnboundWorkspaceVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'First user private reference',
        referenceId: 'vault_first_user_private',
        secretKind: 'api-token',
        workspaceId: firstWorkspace.id,
      });
      const crossUserVaultReferences = await app.request(
        `/api/app/workspaces/${firstWorkspace.id}/vault/references`,
        { headers: { cookie: secondCookie } }
      );

      expect(crossUserVaultReferences.status).toBe(403);
      await expect(crossUserVaultReferences.json()).resolves.toMatchObject({
        code: 'core.auth.scope_forbidden',
      });

      const userRoots = readdirSync(join(dataRoot, 'users')).sort();

      expect(userRoots).toContain('user_local');
      expect(userRoots.filter((userId) => userId !== 'user_local')).toHaveLength(2);

      const restartedApp = createApp({
        auth: createBetterAuth(coreDb),
        dataRoot,
        mode: 'server',
      });
      const persistedSessionList = await restartedApp.request('/api/workspaces', {
        headers: { cookie: firstCookie },
      });

      expect(persistedSessionList.status).toBe(200);

      const signOut = await restartedApp.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { cookie: firstCookie },
      });

      expect(signOut.status).toBe(200);

      const afterSignOut = await restartedApp.request('/api/workspaces', {
        headers: { cookie: firstCookie },
      });

      expect(afterSignOut.status).toBe(401);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps default Goal Mode scopes isolated across server-mode users', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-goal-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    try {
      const app = createApp({
        auth: createBetterAuth(coreDb),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const firstSignUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'goal-scope-first@example.com',
          name: 'Goal Scope First',
          password: 'password123456',
        }),
      });
      const secondSignUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'goal-scope-second@example.com',
          name: 'Goal Scope Second',
          password: 'password123456',
        }),
      });
      const firstCookie = sessionCookie(firstSignUp);
      const secondCookie = sessionCookie(secondSignUp);
      const firstScope = await readDefaultScope(app, firstCookie);
      const secondScope = await readDefaultScope(app, secondCookie);

      expect(firstScope).not.toEqual(secondScope);

      const firstGoal = await app.request(
        `/api/app/workspaces/${firstScope.workspaceId}/threads/${firstScope.threadId}/goal`,
        {
          method: 'POST',
          headers: { cookie: firstCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ objective: 'First user goal.' }),
        }
      );
      const secondGoal = await app.request(
        `/api/app/workspaces/${secondScope.workspaceId}/threads/${secondScope.threadId}/goal`,
        {
          method: 'POST',
          headers: { cookie: secondCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ objective: 'Second user goal.' }),
        }
      );

      expect(firstGoal.ok).toBe(true);
      expect(secondGoal.ok).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps concurrent idempotency collapse scoped to each server-mode user', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-inflight-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    configureLocalSchedulerCapacity(coreDb, 2);

    try {
      const executor = new DelayedServerTurnExecutor();
      const app = createApp({
        auth: createBetterAuth(coreDb),
        coreDb,
        dataRoot,
        mode: 'server',
        turnExecutor: executor,
      });
      const firstSignUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'inflight-first@example.com',
          name: 'Inflight First',
          password: 'password123456',
        }),
      });
      const secondSignUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'inflight-second@example.com',
          name: 'Inflight Second',
          password: 'password123456',
        }),
      });
      const firstScope = await readDefaultScope(app, sessionCookie(firstSignUp));
      const secondScope = await readDefaultScope(app, sessionCookie(secondSignUp));
      const firstRepositoryPath = mkdtempSync(join(tmpdir(), 'openkit-server-first-repo-'));
      const secondRepositoryPath = mkdtempSync(join(tmpdir(), 'openkit-server-second-repo-'));
      const requestBody = {
        requestId: '0190f4c8-0000-7000-8000-000000000402',
        input: 'Run the same request for two users.',
      };

      mkdirSync(join(firstRepositoryPath, '.git'));
      mkdirSync(join(secondRepositoryPath, '.git'));
      await app.request(`/api/app/workspaces/${firstScope.workspaceId}/repositories/default`, {
        method: 'PUT',
        headers: { cookie: sessionCookie(firstSignUp), 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'First user repository',
          localPath: firstRepositoryPath,
        }),
      });
      await app.request(`/api/app/workspaces/${secondScope.workspaceId}/repositories/default`, {
        method: 'PUT',
        headers: { cookie: sessionCookie(secondSignUp), 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Second user repository',
          localPath: secondRepositoryPath,
        }),
      });

      const firstRequest = app.request('/api/turns', {
        method: 'POST',
        headers: { cookie: sessionCookie(firstSignUp), 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody, ...firstScope }),
      });

      await waitForStartCount(executor, 1);

      const secondRequest = app.request('/api/turns', {
        method: 'POST',
        headers: { cookie: sessionCookie(secondSignUp), 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody, ...secondScope }),
      });

      await waitForStartCount(executor, 2);
      executor.release();

      const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
      const firstTurn = (await firstResponse.json()) as { id: string };
      const secondTurn = (await secondResponse.json()) as { id: string };

      expect(firstResponse.status).toBe(202);
      expect(secondResponse.status).toBe(202);
      expect(executor.startedTurnIds).toHaveLength(2);
      expect(new Set(executor.startedTurnIds)).toEqual(new Set([firstTurn.id, secondTurn.id]));
    } finally {
      coreDb.sqlite.close();
    }
  });
});
