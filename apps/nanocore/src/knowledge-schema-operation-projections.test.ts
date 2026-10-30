import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createApp } from './test-support/app.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it('admits only a current human writer and refuses a stale schema preview base without effects', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'schema-preview-operation-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Public schema preview');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const app = createApp({ mode: 'server', coreDb, dataRoot, store });
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const schemaPath = join(root, 'schema', 'scope-schema.yaml');
  const schemaText = readFileSync(schemaPath, 'utf8');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const baseRevision = notebook.publishedRevision();
  const writer = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const reader = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace-readonly',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const call = (operation: string, token: string, input: Record<string, unknown>) => {
    const requestId = randomUUID();
    return app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-openkit-request-id': requestId,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        ...input,
        ...(operation === 'knowledge.schema.preview' ? { requestId } : {}),
      }),
    });
  };
  const input = { baseRevision, schemaText };
  const preview = await call('knowledge.schema.preview', writer.secret, input);
  expect(preview.status, await preview.clone().text()).toBe(200);
  expect(await preview.json()).toMatchObject({
    workspaceId: workspace.id,
    notebookRevision: baseRevision,
    coverage: 'notebook',
    completeMigration: false,
  });
  expect(notebook.publishedRevision()).toBe(baseRevision);
  expect((await call('knowledge.schema.preview', reader.secret, input)).status).toBe(403);
  const content = serializeKnowledgePageFixture(
    {
      title: 'Later page',
      content: 'Actual concurrent publication.',
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
    },
    { kind: 'workspace', workspaceId: workspace.id }
  );
  const changed = await call('knowledge.notebook.create', writer.secret, {
    baseRevision,
    path: 'later.md',
    content,
    summary: 'Change the real base.',
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
  const current = notebook.publishedRevision();
  expect(current).not.toBe(baseRevision);
  expect((await call('knowledge.schema.preview', writer.secret, input)).status).toBe(409);
  revokeOpenKitAccessTokenRecord(coreDb, writer.tokenId);
  expect(
    (await call('knowledge.schema.preview', writer.secret, { baseRevision: current, schemaText }))
      .status
  ).toBe(401);
  expect(notebook.publishedRevision()).toBe(current);
  expect(readFileSync(schemaPath, 'utf8')).toBe(schemaText);
});
