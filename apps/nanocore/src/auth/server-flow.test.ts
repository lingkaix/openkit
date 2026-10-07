import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import type {
  ExecutionBackendCorrelation,
  ExecutionReleaseProof,
} from '../runtime/execution-backend.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import type { TurnStartRuntimeContext } from '../runtime/types.js';
import { openCoreDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { seedWritableGitRepository } from '../test-support/git-repository.js';
import { operationRequest } from '../test-support/operation-request.js';
import { importUnboundWorkspaceVaultReference } from '../vault/vault-references.js';
import { ensureUserQuickChatWorkspace } from '../workspace-membership.js';
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
class DelayedServerTurnExecutor extends SimulatedTurnExecutor {
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
   * Releases the modeled closeout fence for both accepted Turns.
   */
  public releaseCloseout(): void {
    this.releaseStart?.();
  }

  /**
   * Starts one Turn whose release fence remains held by the fixture.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    _input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startedTurnIds.push(turnId);
    await super.startTurn(store, turnId, _input, context);
  }

  /** Holds only the post-submission modeled fence, allowing the preparation claim to settle. */
  public override async release(
    input: ExecutionBackendCorrelation & { readonly proof: ExecutionReleaseProof }
  ) {
    await this.startGate;
    return super.release(input);
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
  const workspaceRes = await app.request(
    ...operationRequest(
      'workspace.create',
      {},
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Server Flow Workspace',
          requestId: randomUUID(),
        }),
      }
    )
  );
  const workspaceBody = (await workspaceRes.json()) as { id?: string };
  const workspaceId = workspaceBody.id;

  if (!workspaceId) {
    throw new Error('Expected project workspace to be created.');
  }

  const threadRes = await ((requestId: string) =>
    ((input: Record<string, unknown>) =>
      app.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: {
          ...{
            ...{ cookie, 'content-type': 'application/json' },
            'content-type': 'application/json',
            'x-openkit-request-id': requestId,
          },
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      }))({
      ...{
        name: 'Server Flow Thread',
        requestId,
        visibility: 'workspace',
      },
      workspaceId: workspaceId,
    }))(randomUUID());
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
      const store = new FsStore({ dataRoot });
      expect(store.listWorkspaces()).toEqual([]);
      const app = createApp({
        auth: createBetterAuth(coreDb, {
          onActiveUserSession: (userId) => ensureUserQuickChatWorkspace({ coreDb, store, userId }),
        }),
        coreDb,
        dataRoot,
        mode: 'server',
        store,
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
      const firstUser = coreDb.sqlite
        .prepare('SELECT id FROM users WHERE email = ?')
        .get('first@example.com') as { id: string };
      const firstQuickChatId = quickChatWorkspaceIdForUser(firstUser.id);
      const initialWorkspaceList = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { cookie: firstCookie },
        },
        method: 'POST',
        headers: { ...{ cookie: firstCookie }, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(initialWorkspaceList.status).toBe(200);
      expect(
        (await initialWorkspaceList.json()) as { items: Array<{ workspace: { id: string } }> }
      ).toMatchObject({
        items: [
          expect.objectContaining({
            workspace: expect.objectContaining({ id: firstQuickChatId, kind: 'quick-chat' }),
          }),
        ],
      });

      const createWorkspace = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: { cookie: firstCookie, 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000401',
              name: 'First private workspace',
            }),
          }
        )
      );

      expect(createWorkspace.status).toBe(201);

      const firstWorkspace = (await createWorkspace.json()) as { id: string; name: string };
      const firstList = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { cookie: firstCookie },
        },
        method: 'POST',
        headers: { ...{ cookie: firstCookie }, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(firstList.status).toBe(200);
      expect(
        (await firstList.json()) as { items: Array<{ workspace: { id: string } }> }
      ).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            workspace: expect.objectContaining({ id: firstWorkspace.id }),
          }),
        ]),
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
      const crossUserGet = await app.request(
        ...operationRequest(
          'workspace.read',
          { workspaceId: firstWorkspace.id },
          {
            headers: { cookie: secondCookie },
          }
        )
      );

      expect(crossUserGet.status).toBe(403);
      await expect(crossUserGet.json()).resolves.toMatchObject({
        code: 'workspace_access_denied',
      });

      importUnboundWorkspaceVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'First user private reference',
        referenceId: 'vault_first_user_private',
        secretKind: 'api-token',
        workspaceId: firstWorkspace.id,
      });
      const crossUserVaultReferences = await app.request(
        ...operationRequest(
          'vault.reference-list',
          { workspaceId: firstWorkspace.id },
          { headers: { cookie: secondCookie } }
        )
      );

      expect(crossUserVaultReferences.status).toBe(403);
      await expect(crossUserVaultReferences.json()).resolves.toMatchObject({
        code: 'workspace_access_denied',
      });

      const restartedApp = createApp({
        auth: createBetterAuth(coreDb),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const persistedSessionList = await restartedApp.request(
        '/api/app/operations/workspace.list',
        {
          ...{
            headers: { cookie: firstCookie },
          },
          method: 'POST',
          headers: { ...{ cookie: firstCookie }, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(persistedSessionList.status).toBe(200);

      const signOut = await restartedApp.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { cookie: firstCookie },
      });

      expect(signOut.status).toBe(200);

      const afterSignOut = await restartedApp.request('/api/app/operations/workspace.list', {
        ...{
          headers: { cookie: firstCookie },
        },
        method: 'POST',
        headers: { ...{ cookie: firstCookie }, 'content-type': 'application/json' },
        body: JSON.stringify({}),
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

      const create = async (scope: typeof firstScope, cookie: string, id: string) =>
        app.request('/api/app/operations/goal.create', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', 'x-openkit-request-id': id },
          body: JSON.stringify({
            workspaceId: scope.workspaceId,
            intent: 'Review design',
            originThreadId: scope.threadId,
          }),
        });
      const firstGoal = await create(
        firstScope,
        firstCookie,
        '11111111-1111-4111-8111-111111111111'
      );
      const secondGoal = await create(
        secondScope,
        secondCookie,
        '22222222-2222-4222-8222-222222222222'
      );
      expect(firstGoal.status).toBe(200);
      expect(secondGoal.status).toBe(200);
      const first = await firstGoal.json();
      const second = await secondGoal.json();
      expect(first.goal.workspaceId).not.toBe(second.goal.workspaceId);
      const denied = await app.request('/api/app/operations/goal.read', {
        method: 'POST',
        headers: { cookie: secondCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: first.goal.workspaceId,
          threadId: first.goal.threadId,
          goalId: first.goal.goalId,
        }),
      });
      expect(denied.status).toBe(403);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps concurrent idempotency collapse scoped to each server-mode user', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-inflight-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      identityId: 'identity_server_fixture',
      observedAt: new Date().toISOString(),
      targetId: 'target_server_fixture',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...target,
      freshEmpty: true,
      observedAt: new Date().toISOString(),
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });

    try {
      const executor = new DelayedServerTurnExecutor({ coreDb });
      const store = new FsStore({ dataRoot });
      const app = createApp({
        agentManifests: [createTestAgentSetup().manifest],
        auth: createBetterAuth(coreDb),
        coreDb,
        dataRoot,
        mode: 'server',
        providerRegistry: new ProviderRegistry([
          {
            displayName: 'Agent OpenRouter',
            id: 'agent-openrouter',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        turnExecutor: executor,
        store,
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

      seedWritableGitRepository(firstRepositoryPath);
      seedWritableGitRepository(secondRepositoryPath);

      const firstRequest = app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            headers: { cookie: sessionCookie(firstSignUp), 'content-type': 'application/json' },
            body: JSON.stringify({ ...requestBody, ...firstScope }),
          }
        )
      );

      await waitForStartCount(executor, 1);

      const secondRequest = app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            headers: { cookie: sessionCookie(secondSignUp), 'content-type': 'application/json' },
            body: JSON.stringify({ ...requestBody, ...secondScope }),
          }
        )
      );

      await waitForStartCount(executor, 2);
      executor.releaseCloseout();

      const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
      const firstTurn = (await firstResponse.json()) as { id: string };
      const secondTurn = (await secondResponse.json()) as { id: string };

      expect(firstResponse.status).toBe(202);
      expect(secondResponse.status).toBe(202);
      expect(executor.startedTurnIds).toHaveLength(2);
      expect(new Set(executor.startedTurnIds)).toEqual(new Set([firstTurn.id, secondTurn.id]));
      await vi.waitFor(() => {
        expect(
          coreDb.sqlite
            .prepare('SELECT phase FROM scheduler_execution_attempts ORDER BY rowid')
            .all()
        ).toEqual([{ phase: 'closed' }, { phase: 'closed' }]);
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
