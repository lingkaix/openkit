import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';

import type { AuthVariables } from '../auth/middleware.js';
import { FsStore } from '../lib/store.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { commandInputHash } from './idempotent-command.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

describe('worker recovery routes', () => {
  it.each([
    'JSON',
    'schema',
  ] as const)('classifies corrupt retained snapshot %s during retry receipt replay without logging decoder content', async (corruption) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-read-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Recovery read refusal');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const thread = store.createThread(workspace.id, 'Interrupted retry');
    const turn = store.createTurn(workspace.id, thread.id, 'Retry interrupted worker', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { status: 'interrupted', completedAt: new Date().toISOString() });
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(workspaceDb);
    const scope = { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id };
    const requestId = 'req_retained_read_retry';
    upsertWorkerCheckpoint(workspaceDb, {
      ...scope,
      requestId: 'req_original',
      requestInputHash: 'sha256:fixture',
      stage: 'aborted',
      stopReason: 'aborted',
      iteration: 1,
    });
    store.recordCommandRequest(
      {
        command: 'worker.recovery.retry',
        requestId,
        scope,
        inputHash: commandInputHash({}),
        response: { kind: 'turn', id: turn.id },
      },
      workspaceDb
    );
    // Exact receipt replay still reads the inventory before deleting the aborted checkpoint.
    const snapshotsRoot = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'runtime',
      'agent-sessions',
      'as_corrupt',
      'aep-snapshots'
    );
    mkdirSync(snapshotsRoot, { recursive: true });
    const marker = 'ROW_SECRET_X9';
    writeFileSync(
      join(snapshotsRoot, 'aepsnap_corrupt.json'),
      corruption === 'JSON' ? marker : JSON.stringify(marker)
    );
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'user_local' });
      await next();
    });
    registerOperationJsonRoutes({
      app,
      coreDb,
      requestStore: () => store,
      repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const loggedErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app.request('/api/app/operations/recovery.checkpoint-retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
        body: JSON.stringify({ ...scope, requestId }),
      });
      expect.soft(response.status).toBe(400);
      expect.soft(inspect(loggedErrors.mock.calls)).not.toContain(marker);
      expect.soft(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({
        code: 'recovery_retry_failed',
        message: 'The retained record could not be read.',
      });
      expect(getWorkerCheckpoint(workspaceDb, workspace.id, thread.id, turn.id)).toMatchObject({
        stage: 'aborted',
      });
      expect(store.getTurnById(turn.id).status).toBe('interrupted');
    } finally {
      loggedErrors.mockRestore();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

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
      c.set('actor', { kind: 'session', userId: 'user_local' });
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
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const localThread = store.createThread('ws_demo', 'Local recovery thread');
    const foreignWorkspace = store.createWorkspace('Foreign recovery workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign recovery thread');
    const foreignTurn = store.createTurn(
      foreignWorkspace.id,
      foreignThread.id,
      'Foreign recovery turn',
      { kind: 'user', id: 'user_local' }
    );
    const privateThread = store.createThread(
      'ws_demo',
      'Hidden attempt',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_other' }
    );
    const privateTurn = store.createTurn('ws_demo', privateThread.id, 'Protected Turn content', {
      kind: 'user',
      id: 'user_other',
    });
    const getTurnContent = vi.spyOn(store, 'getTurnById');
    const repositoryWorkspaceDb = vi.fn(() => {
      throw new Error('Cross-Workspace recovery must fail before opening Workspace storage.');
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'user_local' });
      c.set('workspaceAccess', {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_demo',
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
          { workspaceId: 'ws_demo', threadId: localThread.id, turnId: foreignTurn.id },
          request
        )
      );
      const missing = await app.request(
        ...operationRequest(
          'recovery.checkpoint-retry',
          { workspaceId: 'ws_demo', threadId: localThread.id, turnId: 'turn_missing' },
          {
            ...request,
            body: JSON.stringify({ requestId: 'req_missing_retry' }),
          }
        )
      );

      const wrongThread = await app.request(
        ...operationRequest(
          'recovery.checkpoint-retry',
          { workspaceId: 'ws_demo', threadId: localThread.id, turnId: privateTurn.id },
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
        workspaceId: foreignWorkspace.id,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
