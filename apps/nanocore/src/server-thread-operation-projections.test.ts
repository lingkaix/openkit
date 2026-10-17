import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it('admits Server history only with current Server authority and never through a Workspace selector', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-thread-api-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Ordinary Workspace');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = store.createServerThread('Private Server maintenance');
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const member = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const app = createApp({ mode: 'server', coreDb, dataRoot, store });
  const read = (secret: string, body: Record<string, unknown> = { threadId: thread.id }) =>
    app.request(
      ...operationRequest(
        'thread.server.read',
        {},
        { headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }
      )
    );
  const allowed = await read(admin.secret);
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({
    thread: { id: thread.id, owner: { kind: 'server' }, visibility: 'server' },
    turns: [],
  });
  const denied = await read(member.secret);
  expect(denied.status).toBe(403);
  expect(JSON.stringify(await denied.json())).not.toContain('Private Server maintenance');
  expect(store.listThreads(workspace.id)).toEqual([]);
  const deniedTell = await app.request(
    ...operationRequest(
      'knowledge.server.tell',
      {},
      {
        headers: { authorization: `Bearer ${member.secret}` },
        body: JSON.stringify({
          requestId: randomUUID(),
          content: 'Workspace authority cannot write Server Knowledge.',
          sources: [],
        }),
      }
    )
  );
  expect(deniedTell.status).toBe(403);
  expect(store.listServerThreadTurns(thread.id)).toEqual([]);

  expect(
    (await read(admin.secret, { threadId: thread.id, workspaceId: workspace.id })).status
  ).toBe(400);
  revokeOpenKitAccessTokenRecord(coreDb, admin.tokenId);
  expect((await read(admin.secret)).status).toBe(401);
});
