import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthVariables } from '../auth/middleware.js';
import { FsStore } from '../lib/store.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

describe('worker recovery routes', () => {
  it('does not discover or open unauthorized Workspaces', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const listWorkspaces = vi.spyOn(store, 'listWorkspaces').mockImplementation(() => {
      throw new Error('Recovery listing must not discover physical Workspaces.');
    });
    const repositoryWorkspaceDb = vi.fn(() => {
      throw new Error('Recovery listing must not open an unauthorized Workspace.');
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' });
      await next();
    });
    registerOperationJsonRoutes({
      app,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      coreDb,
      repositoryWorkspaceDb,
      requestStore: () => store,
    });

    try {
      const response = await app.request(...operationRequest('recovery.worker-list', {}));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ items: [] });
      expect(listWorkspaces).not.toHaveBeenCalled();
      expect(repositoryWorkspaceDb).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies a cross-Workspace Turn before opening recovery storage while preserving missing behavior', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const localThread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Local recovery thread'
    );
    const foreignWorkspace = await store.createWorkspace('Foreign recovery workspace');
    const foreignThread = await store.createThread(foreignWorkspace.id, 'Foreign recovery thread');
    const foreignTurn = await store.createTurn(
      foreignWorkspace.id,
      foreignThread.id,
      'Foreign recovery turn',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }
    );
    const privateThread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Hidden attempt',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' }
    );
    const privateTurn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      privateThread.id,
      'Protected Turn content',
      {
        kind: 'user',
        id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      }
    );
    const getTurnContent = vi.spyOn(store, 'getTurnById');
    const repositoryWorkspaceDb = vi.fn(() => {
      throw new Error('Cross-Workspace recovery must fail before opening Workspace storage.');
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' });
      c.set('workspaceAccess', {
        isOwner: true,
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      await next();
    });
    registerOperationJsonRoutes({
      app,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      coreDb,
      repositoryWorkspaceDb,
      requestStore: () => store,
    });
    const request = {
      body: JSON.stringify({ requestId: 'req_cross_workspace_retry' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    } as const;

    try {
      const foreign = await app.request(
        ...operationRequest(
          'recovery.checkpoint-retry',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: localThread.id,
            turnId: foreignTurn.id,
          },
          request
        )
      );
      const missing = await app.request(
        ...operationRequest(
          'recovery.checkpoint-retry',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: localThread.id,
            turnId: 'tu_00000000-0000-76d4-be96-fe2dccab50f4',
          },
          {
            ...request,
            body: JSON.stringify({ requestId: 'req_missing_retry' }),
          }
        )
      );

      const wrongThread = await app.request(
        ...operationRequest(
          'recovery.checkpoint-retry',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: localThread.id,
            turnId: privateTurn.id,
          },
          { ...request, body: JSON.stringify({ requestId: 'req_wrong_thread' }) }
        )
      );
      expect(wrongThread.status).toBe(404);
      await expect(wrongThread.json()).resolves.toMatchObject({ code: 'not_found' });
      expect(getTurnContent).not.toHaveBeenCalled();
      expect(missing.status).toBe(400);
      await expect(missing.json()).resolves.toMatchObject({ code: 'recovery_retry_failed' });
      expect(foreign.status).toBe(403);
      await expect(foreign.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(repositoryWorkspaceDb).not.toHaveBeenCalled();
      expect(store.getTurnById(foreignTurn.id)).toMatchObject({
        status: 'running',
        owner: { kind: 'workspace', workspaceId: foreignWorkspace.id },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
