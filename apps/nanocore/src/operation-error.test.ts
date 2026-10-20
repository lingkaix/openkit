import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { FsStore } from './lib/store.js';
import { projectOperationError } from './operation-error.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it('frames native writer contention as the same safe HTTP and MCP storage failure', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'operation-contention-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Contention');
  const thread = await store.createThread(workspace.id, 'Before');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const app = createApp({ mode: 'server', coreDb, dataRoot, store });
  const blocker = openWorkspaceDb(dataRoot, workspace.id);
  const input = {
    workspaceId: workspace.id,
    threadId: thread.id,
    requestId: randomUUID(),
    name: 'After',
  };
  try {
    // The lock is a contending writer, never a test transaction around the product command.
    blocker.sqlite.exec('BEGIN IMMEDIATE');
    const http = await app.request(
      ...operationRequest(
        'thread.update',
        {},
        {
          headers: { authorization: `Bearer ${token.secret}` },
          body: JSON.stringify(input),
        }
      )
    );
    const httpText = await http.text();
    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'openkit_call', arguments: { operation: 'thread.update', input } },
      }),
    });
    expect(mcp.status).toBe(200);
    const envelope = await mcp.json();
    expect.soft(http.status).toBe(503);
    expect.soft(httpText).toContain('operation_storage_unavailable');
    expect.soft(envelope.result.isError).toBe(true);
    const failure = JSON.parse(envelope.result.content[0].text);
    expect.soft(failure).toMatchObject({ code: 'operation_storage_unavailable', status: 503 });
    expect.soft(failure.message).toMatch(/inspect.*(original|request|outcome)/i);
    expect
      .soft(httpText + JSON.stringify(failure))
      .not.toMatch(
        /SQLITE|INSERT|DELETE|SELECT|sqlite|not.committed|rolled.back|permission|forbidden/i
      );
    blocker.sqlite.exec('ROLLBACK');
    await getControlStoreWorkerClient().shutdown();
    expect(new FsStore({ dataRoot }).getThread(workspace.id, thread.id).name).toBe('Before');
  } finally {
    if (blocker.sqlite.inTransaction) blocker.sqlite.exec('ROLLBACK');
    await getControlStoreWorkerClient().shutdown();
    blocker.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 30_000);

it('classifies a real SQLITE_LOCKED failure without claiming a rollback', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE native_lock (value INTEGER); INSERT INTO native_lock VALUES (1), (2)');
  sqlite.unsafeMode(true);
  const cursor = sqlite.prepare('SELECT value FROM native_lock').iterate();
  cursor.next();
  try {
    let failure: unknown;
    try {
      sqlite.exec('DROP TABLE native_lock');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'SQLITE_LOCKED' });
    const projected = projectOperationError(failure);
    expect(projected).toMatchObject({ code: 'operation_storage_unavailable', status: 503 });
    expect(projected?.message).toMatch(/inspect.*(original|request|outcome)/i);
    expect(JSON.stringify(projected)).not.toMatch(
      /SQLITE|native_lock|DROP|not.committed|rolled.back/i
    );
  } finally {
    cursor.return?.();
    sqlite.close();
  }
});
