import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  bindThreadMaterial,
  consumeQueuedThreadMaterialRevision,
  createWorkspaceMaterial,
  excludeThreadMaterial,
  getThreadMaterial,
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  listWorkspaceMaterialRevisions,
  listWorkspaceMaterials,
  restoreThreadMaterial,
  saveWorkspaceMaterialRevision,
  selectQueuedThreadMaterialRevision,
  unbindThreadMaterial,
} from './workspace-materials.js';

/**
 * Computes the S16 digest over exact UTF-8 content bytes.
 *
 * @param content Canonical Material content.
 * @returns Lowercase SHA-256 digest.
 */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Reads the complete three-table Material authority for zero-write assertions.
 *
 * @param workspaceDb Open Workspace database.
 * @returns Stable raw authority snapshot.
 */
function materialAuthoritySnapshot(workspaceDb: WorkspaceDb): unknown {
  return {
    materials: workspaceDb.sqlite.prepare('SELECT * FROM workspace_materials ORDER BY rowid').all(),
    revisions: workspaceDb.sqlite
      .prepare('SELECT * FROM workspace_material_revisions ORDER BY rowid')
      .all(),
    bindings: workspaceDb.sqlite
      .prepare('SELECT * FROM thread_material_bindings ORDER BY rowid')
      .all(),
  };
}

describe('Workspace Material authority', () => {
  it('owns one linear revision graph and one explicit Material binding per Thread', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-materials-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_materials');

    try {
      applyScopedMigrations(workspaceDb);

      const firstCreatedAt = '2026-07-18T00:00:00.000Z';
      const secondCreatedAt = firstCreatedAt;
      const firstCreate = {
        acceptedAt: firstCreatedAt,
        actorId: 'user_local',
        kind: 'markdown' as const,
        requestId: 'request_create_first',
        sensitivity: 'internal' as const,
        title: 'First material',
      };
      let reservedMaterialId = '';

      expect(() =>
        workspaceDb.sqlite.transaction(() => {
          reservedMaterialId = createWorkspaceMaterial(workspaceDb, firstCreate).materialId;
          throw new Error('roll back reserved Material');
        })()
      ).toThrow('roll back reserved Material');

      const first = createWorkspaceMaterial(workspaceDb, firstCreate);
      const second = createWorkspaceMaterial(workspaceDb, {
        acceptedAt: secondCreatedAt,
        actorId: 'user_local',
        kind: 'text',
        requestId: 'request_create_second',
        sensitivity: 'public',
        title: 'Second material',
      });

      expect(first).toEqual({ materialId: expect.any(String) });
      expect(first.materialId).toBe(reservedMaterialId);
      expect(second).toEqual({ materialId: expect.any(String) });
      expect(second.materialId).not.toBe(first.materialId);
      expect(listWorkspaceMaterials(workspaceDb).map((material) => material.materialId)).toEqual(
        [first.materialId, second.materialId].sort()
      );
      expect(getWorkspaceMaterial(workspaceDb, first.materialId)).toEqual({
        workspaceId: 'ws_materials',
        materialId: first.materialId,
        title: 'First material',
        kind: 'markdown',
        currentRevisionId: null,
        sensitivity: 'internal',
        createdAt: firstCreatedAt,
        updatedAt: firstCreatedAt,
      });

      expect(() =>
        createWorkspaceMaterial(workspaceDb, {
          ...firstCreate,
          acceptedAt: '2026-07-18T00:00:02.000Z',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(listWorkspaceMaterials(workspaceDb)).toHaveLength(2);

      expect(() =>
        saveWorkspaceMaterialRevision(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:03.000Z',
          actorId: 'user_local',
          content: 'first revision',
          contentDigest: `sha256:${'0'.repeat(64)}`,
          expectedRevisionId: null,
          materialId: first.materialId,
          requestId: 'request_bad_digest',
        })
      ).toThrowError(expect.objectContaining({ code: 'source_digest_mismatch' }));
      expect(listWorkspaceMaterialRevisions(workspaceDb, first.materialId)).toEqual([]);
      expect(getWorkspaceMaterial(workspaceDb, first.materialId).currentRevisionId).toBeNull();

      const firstContent = 'first revision';
      const firstRevisionAt = '2026-07-18T00:00:04.000Z';
      const firstSave = {
        acceptedAt: firstRevisionAt,
        actorId: 'user_local',
        content: firstContent,
        contentDigest: contentDigest(firstContent),
        expectedRevisionId: null,
        materialId: first.materialId,
        requestId: 'request_save_first',
      };
      let reservedRevisionId = '';

      expect(() =>
        workspaceDb.sqlite.transaction(() => {
          reservedRevisionId = saveWorkspaceMaterialRevision(workspaceDb, firstSave).revisionId;
          throw new Error('roll back reserved revision');
        })()
      ).toThrow('roll back reserved revision');

      const firstRevision = saveWorkspaceMaterialRevision(workspaceDb, firstSave);

      expect(firstRevision).toEqual({
        materialId: first.materialId,
        revisionId: expect.any(String),
      });
      expect(firstRevision.revisionId).toBe(reservedRevisionId);
      expect(() => saveWorkspaceMaterialRevision(workspaceDb, firstSave)).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(listWorkspaceMaterialRevisions(workspaceDb, first.materialId)).toHaveLength(1);

      workspaceDb.sqlite
        .prepare(
          'UPDATE workspace_materials SET current_revision_id = ? WHERE workspace_id = ? AND material_id = ?'
        )
        .run('missing_revision', 'ws_materials', first.materialId);
      const corruptPointer = materialAuthoritySnapshot(workspaceDb);
      expect(() =>
        saveWorkspaceMaterialRevision(workspaceDb, {
          ...firstSave,
          acceptedAt: '2026-07-18T00:00:04.500Z',
          expectedRevisionId: 'missing_revision',
          requestId: 'request_corrupt_parent',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(materialAuthoritySnapshot(workspaceDb)).toEqual(corruptPointer);
      workspaceDb.sqlite
        .prepare(
          'UPDATE workspace_materials SET current_revision_id = ? WHERE workspace_id = ? AND material_id = ?'
        )
        .run(firstRevision.revisionId, 'ws_materials', first.materialId);

      expect(
        bindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:05.000Z',
          expectedBindingState: 'absent',
          materialId: first.materialId,
          requestId: 'request_bind_one',
          threadId: 'thread_one',
        })
      ).toEqual({ materialId: first.materialId, threadId: 'thread_one', outcome: 'bound' });
      expect(
        bindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:06.000Z',
          expectedBindingState: 'absent',
          materialId: first.materialId,
          requestId: 'request_bind_two',
          threadId: 'thread_two',
        })
      ).toEqual({ materialId: first.materialId, threadId: 'thread_two', outcome: 'bound' });
      expect(() =>
        bindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:07.000Z',
          expectedBindingState: 'absent',
          materialId: second.materialId,
          requestId: 'request_competing_bind',
          threadId: 'thread_one',
        })
      ).toThrowError(expect.objectContaining({ code: 'conflict' }));
      expect(getThreadMaterial(workspaceDb, 'thread_one')?.resource.materialId).toBe(
        first.materialId
      );

      workspaceDb.sqlite
        .prepare(
          'UPDATE thread_material_bindings SET latest_queued_revision_id = ? WHERE workspace_id = ? AND thread_id = ? AND material_id = ?'
        )
        .run('missing_revision', 'ws_materials', 'thread_one', first.materialId);
      const corruptQueue = materialAuthoritySnapshot(workspaceDb);
      expect(() =>
        excludeThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:07.500Z',
          expectedBindingState: 'bound',
          expectedInclusionState: 'included',
          expectedQueuedRevisionId: 'missing_revision',
          materialId: first.materialId,
          requestId: 'request_corrupt_queue',
          threadId: 'thread_one',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(materialAuthoritySnapshot(workspaceDb)).toEqual(corruptQueue);
      workspaceDb.sqlite
        .prepare(
          'UPDATE thread_material_bindings SET latest_queued_revision_id = ? WHERE workspace_id = ? AND thread_id = ? AND material_id = ?'
        )
        .run(firstRevision.revisionId, 'ws_materials', 'thread_one', first.materialId);

      expect(() =>
        excludeThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:08.000Z',
          expectedBindingState: 'bound',
          expectedInclusionState: 'included',
          expectedQueuedRevisionId: 'revision_not_queued',
          materialId: first.materialId,
          requestId: 'request_exclude_wrong_queue',
          threadId: 'thread_one',
        })
      ).toThrowError(expect.objectContaining({ code: 'conflict' }));
      expect(
        excludeThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:09.000Z',
          expectedBindingState: 'bound',
          expectedInclusionState: 'included',
          expectedQueuedRevisionId: firstRevision.revisionId,
          materialId: first.materialId,
          requestId: 'request_exclude_one',
          threadId: 'thread_one',
        })
      ).toEqual({ materialId: first.materialId, threadId: 'thread_one', outcome: 'excluded' });

      const secondContent = 'second revision';
      const secondRevisionAt = firstRevisionAt;
      const secondRevision = saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: secondRevisionAt,
        actorId: 'user_local',
        content: secondContent,
        contentDigest: contentDigest(secondContent),
        expectedRevisionId: firstRevision.revisionId,
        materialId: first.materialId,
        requestId: 'request_save_second',
      });
      const revisions = listWorkspaceMaterialRevisions(workspaceDb, first.materialId);

      expect(revisions.map((revision) => revision.revisionId)).toEqual(
        [firstRevision.revisionId, secondRevision.revisionId].sort()
      );
      expect(
        getWorkspaceMaterialRevision(workspaceDb, first.materialId, firstRevision.revisionId)
      ).toMatchObject({
        content: firstContent,
        contentDigest: contentDigest(firstContent),
        mediaType: 'text/markdown',
      });
      expect(
        getWorkspaceMaterialRevision(workspaceDb, first.materialId, secondRevision.revisionId)
      ).toMatchObject({
        content: secondContent,
        contentDigest: contentDigest(secondContent),
        mediaType: 'text/markdown',
        parentRevisionId: firstRevision.revisionId,
      });
      expect(getThreadMaterial(workspaceDb, 'thread_one')).toMatchObject({
        workspaceId: 'ws_materials',
        threadId: 'thread_one',
        inclusionState: 'excluded',
        latestQueuedRevisionId: secondRevision.revisionId,
        lastWorkerSeenRevisionId: null,
        currentTurnRevisionId: null,
        activeDelivery: null,
        resource: { currentRevisionId: secondRevision.revisionId },
        currentRevision: { revisionId: secondRevision.revisionId },
      });
      expect(getThreadMaterial(workspaceDb, 'thread_two')).toMatchObject({
        inclusionState: 'included',
        latestQueuedRevisionId: secondRevision.revisionId,
      });

      workspaceDb.sqlite
        .prepare(
          'UPDATE thread_material_bindings SET latest_queued_revision_id = ? WHERE workspace_id = ? AND thread_id = ? AND material_id = ?'
        )
        .run(firstRevision.revisionId, 'ws_materials', 'thread_one', first.materialId);
      const historicalQueue = materialAuthoritySnapshot(workspaceDb);
      expect(() =>
        restoreThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:10.500Z',
          expectedBindingState: 'bound',
          expectedInclusionState: 'excluded',
          materialId: first.materialId,
          requestId: 'request_historical_queue',
          threadId: 'thread_one',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(materialAuthoritySnapshot(workspaceDb)).toEqual(historicalQueue);
      workspaceDb.sqlite
        .prepare(
          'UPDATE thread_material_bindings SET latest_queued_revision_id = ? WHERE workspace_id = ? AND thread_id = ? AND material_id = ?'
        )
        .run(secondRevision.revisionId, 'ws_materials', 'thread_one', first.materialId);

      const rejectedContent = 'must not branch';
      const beforeConflict = materialAuthoritySnapshot(workspaceDb);
      expect(() =>
        saveWorkspaceMaterialRevision(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:11.000Z',
          actorId: 'user_local',
          content: rejectedContent,
          contentDigest: contentDigest(rejectedContent),
          expectedRevisionId: firstRevision.revisionId,
          materialId: first.materialId,
          requestId: 'request_stale_save',
        })
      ).toThrowError(expect.objectContaining({ code: 'conflict' }));
      expect(materialAuthoritySnapshot(workspaceDb)).toEqual(beforeConflict);

      expect(
        restoreThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:12.000Z',
          expectedBindingState: 'bound',
          expectedInclusionState: 'excluded',
          materialId: first.materialId,
          requestId: 'request_restore_one',
          threadId: 'thread_one',
        })
      ).toEqual({ materialId: first.materialId, threadId: 'thread_one', outcome: 'included' });
      expect(() =>
        restoreThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:13.000Z',
          expectedBindingState: 'bound',
          expectedInclusionState: 'excluded',
          materialId: first.materialId,
          requestId: 'request_restore_again',
          threadId: 'thread_one',
        })
      ).toThrowError(expect.objectContaining({ code: 'conflict' }));
      expect(
        unbindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:14.000Z',
          expectedBindingState: 'bound',
          materialId: first.materialId,
          requestId: 'request_unbind_one',
          threadId: 'thread_one',
        })
      ).toEqual({ materialId: first.materialId, threadId: 'thread_one', outcome: 'unbound' });
      expect(getThreadMaterial(workspaceDb, 'thread_one')).toBeNull();
      expect(() =>
        unbindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:15.000Z',
          expectedBindingState: 'bound',
          materialId: first.materialId,
          requestId: 'request_unbind_again',
          threadId: 'thread_one',
        })
      ).toThrowError(expect.objectContaining({ code: 'conflict' }));

      expect(
        bindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:16.000Z',
          expectedBindingState: 'absent',
          materialId: second.materialId,
          requestId: 'request_bind_second',
          threadId: 'thread_one',
        })
      ).toEqual({ materialId: second.materialId, threadId: 'thread_one', outcome: 'bound' });
      expect(getThreadMaterial(workspaceDb, 'thread_one')).toMatchObject({
        inclusionState: 'included',
        latestQueuedRevisionId: null,
        resource: { materialId: second.materialId },
      });
      expect(
        unbindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:17.000Z',
          expectedBindingState: 'bound',
          materialId: second.materialId,
          requestId: 'request_unbind_second',
          threadId: 'thread_one',
        })
      ).toEqual({ materialId: second.materialId, threadId: 'thread_one', outcome: 'unbound' });
      expect(
        bindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T00:00:18.000Z',
          expectedBindingState: 'unbound',
          materialId: first.materialId,
          requestId: 'request_rebind_first',
          threadId: 'thread_one',
        })
      ).toEqual({ materialId: first.materialId, threadId: 'thread_one', outcome: 'bound' });
      expect(getThreadMaterial(workspaceDb, 'thread_one')).toMatchObject({
        inclusionState: 'included',
        latestQueuedRevisionId: secondRevision.revisionId,
        resource: { materialId: first.materialId },
      });

      workspaceDb.sqlite.exec(`
        CREATE TRIGGER fail_material_queue_update
        BEFORE UPDATE OF latest_queued_revision_id ON thread_material_bindings
        WHEN NEW.last_mutation_request_id = 'request_rollback_save'
        BEGIN
          SELECT RAISE(ABORT, 'forced Material queue failure');
        END
      `);
      const rollbackContent = 'transaction must roll back';
      const beforeRollback = materialAuthoritySnapshot(workspaceDb);

      expect(() =>
        workspaceDb.sqlite.transaction(() =>
          saveWorkspaceMaterialRevision(workspaceDb, {
            acceptedAt: '2026-07-18T00:00:19.000Z',
            actorId: 'user_local',
            content: rollbackContent,
            contentDigest: contentDigest(rollbackContent),
            expectedRevisionId: secondRevision.revisionId,
            materialId: first.materialId,
            requestId: 'request_rollback_save',
          })
        )()
      ).toThrow(/forced Material queue failure/);
      workspaceDb.sqlite.exec('DROP TRIGGER fail_material_queue_update');

      expect(materialAuthoritySnapshot(workspaceDb)).toEqual(beforeRollback);

      const plainContent = 'plain text';
      const plainRevision = saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: '2026-07-18T00:00:20.000Z',
        actorId: 'user_local',
        content: plainContent,
        contentDigest: contentDigest(plainContent),
        expectedRevisionId: null,
        materialId: second.materialId,
        requestId: 'request_save_plain',
      });
      expect(
        getWorkspaceMaterialRevision(workspaceDb, second.materialId, plainRevision.revisionId)
          .mediaType
      ).toBe('text/plain');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('selects and consumes only the exact bound queued revision proof', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-material-handoff-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_handoff');

    try {
      applyScopedMigrations(workspaceDb);
      const content = '# Exact queued revision\n';
      const material = createWorkspaceMaterial(workspaceDb, {
        acceptedAt: '2026-07-18T01:00:00.000Z',
        actorId: 'user_local',
        kind: 'markdown',
        requestId: 'request_create_handoff',
        sensitivity: 'internal',
        title: 'Handoff material',
      });
      const revision = saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: '2026-07-18T01:00:01.000Z',
        actorId: 'user_local',
        content,
        contentDigest: contentDigest(content),
        expectedRevisionId: null,
        materialId: material.materialId,
        requestId: 'request_save_handoff',
      });
      bindThreadMaterial(workspaceDb, {
        acceptedAt: '2026-07-18T01:00:02.000Z',
        expectedBindingState: 'absent',
        materialId: material.materialId,
        requestId: 'request_bind_handoff',
        threadId: 'thread_handoff',
      });

      const expectedSelection = {
        bindingMutationRequestId: 'request_bind_handoff',
        content,
        contentDigest: contentDigest(content),
        inclusionReason: 'thread_binding',
        inclusionState: 'included' as const,
        materialId: material.materialId,
        mediaType: 'text/markdown',
        parentRevisionId: null,
        revisionId: revision.revisionId,
        sensitivity: 'internal',
      };
      expect(selectQueuedThreadMaterialRevision(workspaceDb, 'thread_handoff')).toEqual(
        expectedSelection
      );

      const setRevision = workspaceDb.sqlite.prepare(`UPDATE workspace_material_revisions SET
        parent_revision_id = @parentRevisionId, media_type = @mediaType, content = @content
        WHERE workspace_id = @workspaceId AND material_id = @materialId
          AND revision_id = @revisionId`);
      const revisionOwner = {
        materialId: material.materialId,
        revisionId: revision.revisionId,
        workspaceId: 'ws_handoff',
      };
      const invalidRevisionCases = [
        {
          content: 'corrupt',
          mediaType: 'text/markdown',
          name: 'digest mismatch',
          parentRevisionId: null,
        },
        {
          content,
          mediaType: 'text/plain',
          name: 'kind-mismatched media type',
          parentRevisionId: null,
        },
        {
          content,
          mediaType: 'text/markdown',
          name: 'missing parent revision',
          parentRevisionId: 'mrev_missing',
        },
        {
          content,
          mediaType: 'text/markdown',
          name: 'self parent revision',
          parentRevisionId: revision.revisionId,
        },
      ] as const;

      for (const { name, ...state } of invalidRevisionCases) {
        setRevision.run({ ...revisionOwner, ...state });
        expect(
          () => selectQueuedThreadMaterialRevision(workspaceDb, 'thread_handoff'),
          name
        ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      }
      setRevision.run({
        ...revisionOwner,
        content,
        mediaType: 'text/markdown',
        parentRevisionId: null,
      });

      const bindingOwner = {
        materialId: material.materialId,
        threadId: 'thread_handoff',
        workspaceId: 'ws_handoff',
      };
      const setBinding = workspaceDb.sqlite.prepare(`UPDATE thread_material_bindings SET
        binding_state = @bindingState, latest_queued_revision_id = @queuedRevisionId,
        inclusion_state = @inclusionState, last_mutation_request_id = @lastMutationRequestId,
        updated_at = @updatedAt
        WHERE workspace_id = @workspaceId AND thread_id = @threadId
          AND material_id = @materialId`);
      const readBinding = workspaceDb.sqlite.prepare(`SELECT
        binding_state AS bindingState, latest_queued_revision_id AS latestQueuedRevisionId,
        inclusion_state AS inclusionState, last_mutation_request_id AS lastMutationRequestId,
        created_at AS createdAt, updated_at AS updatedAt
        FROM thread_material_bindings
        WHERE workspace_id = @workspaceId AND thread_id = @threadId
          AND material_id = @materialId`);
      const selectionCases = [
        {
          bindingState: 'bound',
          expected: {
            ...expectedSelection,
            bindingMutationRequestId: 'request_excluded',
            inclusionState: 'excluded',
          },
          inclusionState: 'excluded',
          lastMutationRequestId: 'request_excluded',
          name: 'excluded queue',
          queuedRevisionId: revision.revisionId,
        },
        {
          bindingState: 'bound',
          expected: null,
          inclusionState: 'included',
          lastMutationRequestId: 'request_empty',
          name: 'empty queue',
          queuedRevisionId: null,
        },
        {
          bindingState: 'unbound',
          expected: null,
          inclusionState: 'included',
          lastMutationRequestId: 'request_unbound',
          name: 'unbound history',
          queuedRevisionId: null,
        },
      ] as const;

      for (const { expected, name, ...state } of selectionCases) {
        setBinding.run({ ...bindingOwner, ...state, updatedAt: '2026-07-18T01:00:03.000Z' });
        expect(selectQueuedThreadMaterialRevision(workspaceDb, 'thread_handoff'), name).toEqual(
          expected
        );
      }

      const consumptionCases = [
        {
          bindingState: 'bound',
          expected: 'consumed',
          expectedQueue: null,
          inclusionState: 'included',
          lastMutationRequestId: 'request_bind_handoff',
          name: 'exact queued proof',
          queuedRevisionId: revision.revisionId,
        },
        {
          bindingState: 'bound',
          expected: 'consumed',
          expectedQueue: null,
          inclusionState: 'included',
          lastMutationRequestId: 'request_bind_handoff',
          name: 'already-cleared exact proof',
          queuedRevisionId: null,
        },
        {
          bindingState: 'bound',
          expected: 'superseded',
          expectedQueue: revision.revisionId,
          inclusionState: 'included',
          lastMutationRequestId: 'request_later_save',
          name: 'later same-revision queue proof',
          queuedRevisionId: revision.revisionId,
        },
      ] as const;

      for (const { expected, expectedQueue, name, ...state } of consumptionCases) {
        setBinding.run({ ...bindingOwner, ...state, updatedAt: '2026-07-18T01:00:04.000Z' });
        expect(
          consumeQueuedThreadMaterialRevision(
            workspaceDb,
            'thread_handoff',
            material.materialId,
            revision.revisionId,
            'request_bind_handoff'
          ),
          name
        ).toBe(expected);
        expect(readBinding.get(bindingOwner), name).toEqual({
          bindingState: state.bindingState,
          latestQueuedRevisionId: expectedQueue,
          inclusionState: state.inclusionState,
          lastMutationRequestId: state.lastMutationRequestId,
          createdAt: '2026-07-18T01:00:02.000Z',
          updatedAt: '2026-07-18T01:00:04.000Z',
        });
      }

      const contradictoryCases = [
        {
          bindingState: 'bound',
          inclusionState: 'excluded',
          lastMutationRequestId: 'request_bind_handoff',
          name: 'same-proof cleared excluded state',
          queuedRevisionId: null,
        },
        {
          bindingState: 'bound',
          inclusionState: 'excluded',
          lastMutationRequestId: 'request_bind_handoff',
          name: 'same-proof excluded state',
          queuedRevisionId: revision.revisionId,
        },
        {
          bindingState: 'bound',
          inclusionState: 'included',
          lastMutationRequestId: 'request_bind_handoff',
          name: 'same-proof different queue',
          queuedRevisionId: 'mrev_contradictory',
        },
      ] as const;

      workspaceDb.sqlite.exec('PRAGMA ignore_check_constraints = ON');
      for (const { name, ...state } of contradictoryCases) {
        setBinding.run({ ...bindingOwner, ...state, updatedAt: '2026-07-18T01:00:05.000Z' });
        const before = materialAuthoritySnapshot(workspaceDb);
        expect(
          () =>
            consumeQueuedThreadMaterialRevision(
              workspaceDb,
              'thread_handoff',
              material.materialId,
              revision.revisionId,
              'request_bind_handoff'
            ),
          name
        ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
        expect(materialAuthoritySnapshot(workspaceDb), name).toEqual(before);
      }
      workspaceDb.sqlite.exec('PRAGMA ignore_check_constraints = OFF');

      workspaceDb.sqlite
        .prepare(
          'DELETE FROM thread_material_bindings WHERE workspace_id = ? AND thread_id = ? AND material_id = ?'
        )
        .run(bindingOwner.workspaceId, bindingOwner.threadId, bindingOwner.materialId);
      expect(() =>
        consumeQueuedThreadMaterialRevision(
          workspaceDb,
          'thread_handoff',
          material.materialId,
          revision.revisionId,
          'request_bind_handoff'
        )
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
