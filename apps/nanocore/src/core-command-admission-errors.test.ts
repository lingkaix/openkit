import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { feedbackFilePath } from './runtime/feedback.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { disposeTestStore } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const operations = [
  'workspace.read',
  'workspace.update',
  'workspace.dashboard',
  'thread.list',
  'thread.update',
  'thread.archive',
  'turn.start',
  'turn.interrupt',
  'turn.feedback',
] as const;

/** Captures all canonical rows, including other Threads and the actor's Quick Chat Workspace. */
function snapshot(store: Awaited<ReturnType<typeof createDemoStore>>) {
  return {
    workspaces: store.listWorkspaces().map((workspace) => ({
      workspace,
      threads: store.listThreads(workspace.id).map((thread) => ({
        thread,
        turns: store.listThreadTurns(workspace.id, thread.id),
      })),
    })),
    receipts: store.listCommandRequests(),
  };
}

it.each(operations)(
  '%s unexpected admission failure reaches the HTTP error handler without effects or disclosure',
  async (id) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-command-admission-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const store = await createDemoStore({ dataRoot });
      for (const workspace of store.listWorkspaces()) {
        recordWorkspaceOwnerMembership({
          coreDb,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          workspaceId: workspace.id,
        });
      }
      const thread = await store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'Admission sentinel',
        undefined,
        'conversation',
        {
          visibility: 'workspace',
        }
      );
      const turn = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        thread.id,
        'Retained Turn',
        {
          kind: 'user',
          id: 'usr_00000000-0000-7000-8000-000000000001',
        }
      );
      const token = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace',
        workspaceIds: store.listWorkspaces().map((workspace) => workspace.id),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const admission = new WorkspaceMutationAdmission();
      const app = createApp({
        coreDb,
        dataRoot,
        store,
        mode: 'server',
        workspaceMutationAdmission: admission,
      });
      const failure = new Error(`Private unexpected admission sentinel: ${id}`);
      const observed: Error[] = [];
      app.onError((error, context) => {
        observed.push(error);
        return context.text('Internal Server Error', 500);
      });
      // Reads consult the lifecycle close, mutations the full gate; both must propagate.
      for (const gate of ['isClosed', 'isLifecycleClosed'] as const) {
        vi.spyOn(admission, gate).mockImplementation(() => {
          throw failure;
        });
      }
      const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
      const inputs = {
        'workspace.read': { workspaceId },
        'workspace.update': { workspaceId, name: 'Must not rename', requestId: randomUUID() },
        'workspace.dashboard': { workspaceId },
        'thread.list': { workspaceId },
        'thread.update': {
          workspaceId,
          threadId: thread.id,
          name: 'Must not rename',
          requestId: randomUUID(),
        },
        'thread.archive': { workspaceId, threadId: thread.id, requestId: randomUUID() },
        'turn.start': {
          workspaceId,
          threadId: thread.id,
          input: 'Must not start',
          requestId: randomUUID(),
        },
        'turn.interrupt': {
          workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          requestId: randomUUID(),
        },
        'turn.feedback': { turnId: turn.id, rating: 'good', note: 'Must not write' },
      };
      const before = snapshot(store);
      const feedback = feedbackFilePath(store, turn);
      expect(existsSync(feedback)).toBe(false);
      const request = operationRequest(id, {}, { body: JSON.stringify(inputs[id]) });
      const unauthenticated = await app.request(...request);
      expect(unauthenticated.status).toBe(401);
      expect(observed).toEqual([]);
      const headers = new Headers(request[1].headers);
      headers.set('authorization', `Bearer ${token.secret}`);
      const response = await app.request(request[0], { ...request[1], headers });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toBe('Internal Server Error');
      expect(body).not.toContain(failure.message);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(failure);
      expect(snapshot(store)).toEqual(before);
      expect(existsSync(feedback)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
      await disposeTestStore(dataRoot);
    }
  }
);

it.each(['HTTP', 'MCP'] as const)(
  'preserves a recognized Kernel owner conflict through canonical workspace.update %s without Workspace or receipt writes',
  async (projection) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-command-typed-error-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const store = await createDemoStore({ dataRoot });
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const token = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const app = createApp({ coreDb, dataRoot, store, mode: 'server' });
      const errors: Error[] = [];
      app.onError((error, context) => {
        errors.push(error);
        return context.text('Internal Server Error', 500);
      });
      const failure = new KernelCommandError('conflict', 'Owned conflict sentinel.');
      vi.spyOn(store, 'updateWorkspace').mockImplementation(() => {
        throw failure;
      });
      const before = structuredClone({
        workspace: store.getWorkspace('ws_00000000-0000-7000-8000-000000000001'),
        receipts: store.listCommandRequests(),
      });
      const input = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        name: 'Must not rename',
        requestId: randomUUID(),
      };
      const authorization = `Bearer ${token.secret}`;
      if (projection === 'HTTP') {
        const response = await app.request(
          ...operationRequest(
            'workspace.update',
            {},
            {
              headers: { authorization },
              body: JSON.stringify(input),
            }
          )
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: 'conflict',
          message: 'Owned conflict sentinel.',
        });
      } else {
        const response = await app.request('/mcp', {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'openkit_call', arguments: { operation: 'workspace.update', input } },
          }),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.error).toBeUndefined();
        expect(body.result.isError).toBe(true);
        expect(body.result.content).toHaveLength(1);
        expect(body.result.content[0].type).toBe('text');
        expect(JSON.parse(body.result.content[0].text)).toEqual({
          code: 'conflict',
          message: 'Owned conflict sentinel.',
          status: 409,
        });
      }
      expect(errors).toEqual([]);
      expect(store.getWorkspace('ws_00000000-0000-7000-8000-000000000001')).toEqual(
        before.workspace
      );
      expect(store.listCommandRequests()).toEqual(before.receipts);
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
      await disposeTestStore(dataRoot);
    }
  }
);
