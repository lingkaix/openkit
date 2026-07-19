import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BindThreadMaterialResponseSchema,
  CreateWorkspaceMaterialResponseSchema,
  GetThreadMaterialResponseSchema,
  GetWorkspaceMaterialResponseSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createWorkspaceMaterial } from './workspace-materials.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Computes the contract digest over exact UTF-8 Material content.
 *
 * @param content Canonical Material content.
 * @returns Lowercase SHA-256 digest.
 */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

describe('Workspace Material app API', () => {
  it('denies a Material whose scoped owner is outside the authorized path Workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-material-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const foreignWorkspace = store.createWorkspace('Foreign Material Workspace');
    const foreignDb = openWorkspaceDb(dataRoot, foreignWorkspace.id);
    applyScopedMigrations(foreignDb);
    const foreignMaterial = createWorkspaceMaterial(foreignDb, {
      acceptedAt: '2026-07-19T00:00:00.000Z',
      actorId: 'user_local',
      kind: 'markdown',
      requestId: 'foreign-material-create',
      sensitivity: 'internal',
      title: 'Foreign Material',
    });
    foreignDb.sqlite.close();
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await app.request(
        `/api/app/workspaces/ws_demo/materials/${foreignMaterial.materialId}`
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps thin route behavior receipt-backed while storage owns the lifecycle', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-material-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Material route thread');
    const app = createApp({ coreDb, dataRoot, store });
    const createRequest = {
      requestId: 'material-create-1',
      title: 'Release notes',
      kind: 'markdown',
      sensitivity: 'internal',
    };

    try {
      const missingThread = await app.request(
        '/api/app/workspaces/ws_demo/threads/thread_missing/material'
      );
      expect(missingThread.status).toBe(403);
      await expect(missingThread.json()).resolves.toMatchObject({
        code: 'workspace_access_denied',
      });

      const createResponse = await app.request('/api/app/workspaces/ws_demo/materials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createRequest),
      });
      expect(createResponse.status).toBe(201);
      const created = CreateWorkspaceMaterialResponseSchema.parse(await createResponse.json());

      const exactCreateReplay = await app.request('/api/app/workspaces/ws_demo/materials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createRequest),
      });
      expect(exactCreateReplay.status).toBe(201);
      expect(CreateWorkspaceMaterialResponseSchema.parse(await exactCreateReplay.json())).toEqual(
        created
      );
      const revisionsPath = `/api/app/workspaces/ws_demo/materials/${created.materialId}/revisions`;

      const conflictingCreate = await app.request('/api/app/workspaces/ws_demo/materials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createRequest, title: 'Changed input' }),
      });
      expect(conflictingCreate.status).toBe(409);
      await expect(conflictingCreate.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      const firstContent = '# Release notes\n';
      const firstSaveRequest = {
        requestId: 'material-save-1',
        expectedRevisionId: null,
        contentDigest: contentDigest(firstContent),
        content: firstContent,
      };
      const firstSaveResponse = await app.request(revisionsPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(firstSaveRequest),
      });
      expect(firstSaveResponse.status).toBe(201);
      const firstSaved = SaveWorkspaceMaterialRevisionResponseSchema.parse(
        await firstSaveResponse.json()
      );

      const bindPath = `/api/app/workspaces/ws_demo/threads/${thread.id}/materials/${created.materialId}/bind`;
      const bindRequest = { requestId: 'material-bind-1', expectedBindingState: 'absent' };
      const bindResponse = await app.request(bindPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bindRequest),
      });
      expect(bindResponse.status).toBe(200);
      expect(BindThreadMaterialResponseSchema.parse(await bindResponse.json())).toEqual({
        materialId: created.materialId,
        threadId: thread.id,
        outcome: 'bound',
      });

      const threadResponse = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/material`
      );
      expect(threadResponse.status).toBe(200);
      expect(GetThreadMaterialResponseSchema.parse(await threadResponse.json())).toMatchObject({
        material: {
          resource: { materialId: created.materialId },
          currentRevision: {
            revisionId: firstSaved.revisionId,
            contentDigest: firstSaveRequest.contentDigest,
          },
          inclusionState: 'included',
          latestQueuedRevisionId: firstSaved.revisionId,
        },
      });

      const materialResponse = await app.request(
        `/api/app/workspaces/ws_demo/materials/${created.materialId}`
      );
      expect(materialResponse.status).toBe(200);
      expect(GetWorkspaceMaterialResponseSchema.parse(await materialResponse.json())).toMatchObject(
        {
          material: {
            materialId: created.materialId,
            currentRevisionId: firstSaved.revisionId,
          },
        }
      );

      const secondContent = '# Updated release notes\n';
      const secondSaveResponse = await app.request(revisionsPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'material-save-2',
          expectedRevisionId: firstSaved.revisionId,
          contentDigest: contentDigest(secondContent),
          content: secondContent,
        }),
      });
      expect(secondSaveResponse.status).toBe(201);
      const secondSaved = SaveWorkspaceMaterialRevisionResponseSchema.parse(
        await secondSaveResponse.json()
      );
      expect(secondSaved.revisionId).not.toBe(firstSaved.revisionId);

      const receiptDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(receiptDb);
      try {
        const changeReceiptTarget = receiptDb.sqlite.prepare(`UPDATE idempotency_requests
          SET response_id = ? WHERE command_name = 'material.save' AND request_id = ?`);
        expect(
          changeReceiptTarget.run(secondSaved.revisionId, firstSaveRequest.requestId).changes
        ).toBe(1);
        const corruptedReplay = await app.request(revisionsPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(firstSaveRequest),
        });
        expect(corruptedReplay.status).toBe(409);
        await expect(corruptedReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
        expect(
          changeReceiptTarget.run(firstSaved.revisionId, firstSaveRequest.requestId).changes
        ).toBe(1);
      } finally {
        receiptDb.sqlite.close();
      }

      const historicalReplay = await app.request(revisionsPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(firstSaveRequest),
      });
      expect(historicalReplay.status).toBe(201);
      expect(
        SaveWorkspaceMaterialRevisionResponseSchema.parse(await historicalReplay.json())
      ).toEqual(firstSaved);

      const tamperedReplay = await app.request(revisionsPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...firstSaveRequest, content: 'tampered bytes' }),
      });
      expect(tamperedReplay.status).toBe(400);
      await expect(tamperedReplay.json()).resolves.toMatchObject({
        code: 'source_digest_mismatch',
      });

      const corruptTraceTurn = store.createTurn(
        'ws_demo',
        thread.id,
        'Create a corrupt trace candidate.',
        { kind: 'user', id: 'user_local' }
      );
      store.updateTurn(corruptTraceTurn.id, {
        status: 'completed',
        completedAt: '2026-07-18T00:00:00.000Z',
        durationMs: 0,
      });
      writeFileSync(
        join(
          dataRoot,
          'workspaces',
          'ws_demo',
          'threads',
          thread.id,
          'turns',
          corruptTraceTurn.id,
          'context-package.json'
        ),
        '{}',
        'utf8'
      );
      const corruptProjection = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/material`
      );
      expect(corruptProjection.status).toBe(409);
      await expect(corruptProjection.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const ownerDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(ownerDb);
      try {
        expect(
          ownerDb.sqlite
            .prepare('DELETE FROM workspace_materials WHERE workspace_id = ? AND material_id = ?')
            .run('ws_demo', created.materialId).changes
        ).toBe(1);
      } finally {
        ownerDb.sqlite.close();
      }
      const ownerlessBindingReplay = await app.request(bindPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bindRequest),
      });
      expect(ownerlessBindingReplay.status).toBe(409);
      await expect(ownerlessBindingReplay.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
