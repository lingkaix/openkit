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
import { commandInputHash } from './runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from './workspace-materials.js';
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
  it('keeps opaque target misses stale after path authorization and rejects them without writes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-material-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const localThread = store.createThread('ws_demo', 'Authorized Material Thread');
    const foreignWorkspace = store.createWorkspace('Foreign Material Workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign Material Thread');
    const localDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(localDb);
    const localMaterial = createWorkspaceMaterial(localDb, {
      acceptedAt: '2026-07-19T00:00:00.000Z',
      actorId: 'user_local',
      kind: 'markdown',
      requestId: 'local-material-create',
      sensitivity: 'internal',
      title: 'Authorized Material',
    });
    const localContent = '# Authorized Material\n';
    saveWorkspaceMaterialRevision(localDb, {
      acceptedAt: '2026-07-19T00:00:01.000Z',
      actorId: 'user_local',
      content: localContent,
      contentDigest: contentDigest(localContent),
      expectedRevisionId: null,
      materialId: localMaterial.materialId,
      requestId: 'local-material-save',
    });
    localDb.sqlite.close();
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
    const foreignContent = '# Foreign Material\n';
    const foreignRevision = saveWorkspaceMaterialRevision(foreignDb, {
      acceptedAt: '2026-07-19T00:00:01.000Z',
      actorId: 'user_local',
      content: foreignContent,
      contentDigest: contentDigest(foreignContent),
      expectedRevisionId: null,
      materialId: foreignMaterial.materialId,
      requestId: 'foreign-material-save',
    });
    foreignDb.sqlite.close();
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const stalePaths = [
        '/api/app/workspaces/ws_demo/materials/material_missing',
        `/api/app/workspaces/ws_demo/materials/${foreignMaterial.materialId}`,
        `/api/app/workspaces/ws_demo/materials/${localMaterial.materialId}/revisions/revision_missing`,
        `/api/app/workspaces/ws_demo/materials/${localMaterial.materialId}/revisions/${foreignRevision.revisionId}`,
        '/api/app/workspaces/ws_demo/threads/thread_missing/material',
        `/api/app/workspaces/ws_demo/threads/${foreignThread.id}/material`,
      ];

      for (const path of stalePaths) {
        const response = await app.request(path);
        const body = (await response.json()) as { readonly code?: unknown };
        expect.soft({ status: response.status, code: body.code }, path).toEqual({
          status: 409,
          code: 'stale',
        });
      }

      const deniedPath = await app.request(
        `/api/app/workspaces/${foreignWorkspace.id}/materials/${foreignMaterial.materialId}`
      );
      expect(deniedPath.status).toBe(403);
      await expect(deniedPath.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });

      for (const [requestId, materialId] of [
        ['bind-unknown-material', 'material_missing'],
        ['bind-foreign-material', foreignMaterial.materialId],
      ] as const) {
        const response = await app.request(
          `/api/app/workspaces/ws_demo/threads/${localThread.id}/materials/${materialId}/bind`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, expectedBindingState: 'not_bound' }),
          }
        );
        const body = (await response.json()) as { readonly code?: unknown };
        expect.soft({ status: response.status, code: body.code }, requestId).toEqual({
          status: 409,
          code: 'stale',
        });
      }

      const inspectionDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(inspectionDb);
      try {
        expect(
          inspectionDb.sqlite
            .prepare(`SELECT
              (SELECT COUNT(*) FROM workspace_materials) AS materials,
              (SELECT COUNT(*) FROM workspace_material_revisions) AS revisions,
              (SELECT COUNT(*) FROM thread_material_bindings) AS bindings,
              (SELECT COUNT(*) FROM idempotency_requests) AS receipts`)
            .get()
        ).toEqual({ materials: 1, revisions: 1, bindings: 0, receipts: 0 });
      } finally {
        inspectionDb.sqlite.close();
      }
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
      const bindRequest = { requestId: 'material-bind-1', expectedBindingState: 'not_bound' };
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

      const bindReceiptDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(bindReceiptDb);
      try {
        expect(
          bindReceiptDb.sqlite
            .prepare(
              `SELECT input_hash FROM idempotency_requests
               WHERE command_name = 'material.bind' AND request_id = ?`
            )
            .pluck()
            .get(bindRequest.requestId)
        ).toBe(commandInputHash({ expectedBindingState: 'not_bound' }));
      } finally {
        bindReceiptDb.sqlite.close();
      }

      const exactBindReplay = await app.request(bindPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bindRequest),
      });
      expect(exactBindReplay.status).toBe(200);
      expect(BindThreadMaterialResponseSchema.parse(await exactBindReplay.json())).toEqual({
        materialId: created.materialId,
        threadId: thread.id,
        outcome: 'bound',
      });

      for (const removedLiteral of ['absent', 'unbound']) {
        const removedLiteralResponse = await app.request(bindPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: `material-bind-removed-${removedLiteral}`,
            expectedBindingState: removedLiteral,
          }),
        });
        expect(removedLiteralResponse.status).toBe(400);
        await expect(removedLiteralResponse.json()).resolves.toMatchObject({
          code: 'invalid_request',
        });
      }

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

      const excludeResponse = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/materials/${created.materialId}/exclude`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'material-exclude-before-rebind',
            expectedBindingState: 'bound',
            expectedInclusionState: 'included',
            expectedQueuedRevisionId: secondSaved.revisionId,
          }),
        }
      );
      expect(excludeResponse.status).toBe(200);

      const unbindResponse = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/materials/${created.materialId}/unbind`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'material-unbind-before-rebind',
            expectedBindingState: 'bound',
          }),
        }
      );
      expect(unbindResponse.status).toBe(200);

      const unboundThreadResponse = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/material`
      );
      expect(unboundThreadResponse.status).toBe(200);
      expect(GetThreadMaterialResponseSchema.parse(await unboundThreadResponse.json())).toEqual({
        material: null,
      });

      const rebindResponse = await app.request(bindPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'material-rebind-after-refresh',
          expectedBindingState: 'not_bound',
        }),
      });
      expect(rebindResponse.status).toBe(200);

      const reboundThreadResponse = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/material`
      );
      expect(reboundThreadResponse.status).toBe(200);
      expect(
        GetThreadMaterialResponseSchema.parse(await reboundThreadResponse.json())
      ).toMatchObject({
        material: {
          inclusionState: 'included',
          latestQueuedRevisionId: secondSaved.revisionId,
          resource: { materialId: created.materialId },
        },
      });

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
