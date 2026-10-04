import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it.each([
  'HTTP',
  'MCP',
] as const)('preserves a recognized Kernel owner conflict through canonical workspace.update %s without Workspace or receipt writes', async (projection) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-command-typed-error-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store, mode: 'server' });
    const errors: Error[] = [];
    app.onError((error, context) => {
      errors.push(error);
      return context.text('Internal Server Error', 500);
    });
    const failure = new KernelCommandError('conflict', 'Owned conflict sentinel.');
    const owner = vi.spyOn(store, 'updateWorkspace').mockImplementation(() => {
      throw failure;
    });
    const before = structuredClone({
      workspace: store.getWorkspace('ws_demo'),
      receipts: store.listCommandRequests(),
    });
    const input = { workspaceId: 'ws_demo', name: 'Must not rename', requestId: randomUUID() };
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
      expect(owner).toHaveBeenCalledExactlyOnceWith('ws_demo', {
        name: input.name,
        requestId: input.requestId,
      });
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
          params: { name: 'call', arguments: { operation: 'workspace.update', input } },
        }),
      });
      expect(owner).toHaveBeenCalledExactlyOnceWith('ws_demo', {
        name: input.name,
        requestId: input.requestId,
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
    expect(store.getWorkspace('ws_demo')).toEqual(before.workspace);
    expect(store.listCommandRequests()).toEqual(before.receipts);
  } finally {
    vi.restoreAllMocks();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
