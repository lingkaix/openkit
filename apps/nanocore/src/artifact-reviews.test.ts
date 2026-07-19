import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createArtifactReview,
  decideArtifactReview,
  getArtifactReview,
  listArtifactReviews,
  replayArtifactReviewDecision,
} from './artifact-reviews.js';
import { openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  excludeThreadMaterial,
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  saveWorkspaceMaterialRevision,
} from './workspace-materials.js';

/** Computes the lowercase S16 digest. @param content Exact UTF-8 content. @returns SHA-256 digest. */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Opens a fresh migrated database. @param workspaceId Workspace id. @returns Open database. */
function openTestWorkspaceDb(workspaceId: string): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(
    mkdtempSync(join(tmpdir(), 'openkit-artifact-reviews-')),
    workspaceId
  );
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/** Reads mutation authority. @param workspaceDb Open database. @returns Stable raw snapshot. */
function authoritySnapshot(workspaceDb: WorkspaceDb): unknown {
  return {
    reviews: workspaceDb.sqlite.prepare('SELECT * FROM artifact_reviews ORDER BY rowid').all(),
    materials: workspaceDb.sqlite.prepare('SELECT * FROM workspace_materials ORDER BY rowid').all(),
    revisions: workspaceDb.sqlite
      .prepare('SELECT * FROM workspace_material_revisions ORDER BY rowid')
      .all(),
    bindings: workspaceDb.sqlite
      .prepare('SELECT * FROM thread_material_bindings ORDER BY rowid')
      .all(),
  };
}

describe('Artifact Review authority', () => {
  it('owns deterministic immutable Review history by exact Artifact version', () => {
    const workspaceDb = openTestWorkspaceDb('ws_review_history');

    try {
      const second = createArtifactReview(workspaceDb, {
        artifactId: 'artifact_demo',
        artifactVersion: 2,
        contentDigest: contentDigest('version two'),
        sourceThreadId: 'thread_demo',
        sourceTurnId: 'turn_two',
        sourceAgentId: 'agent_demo',
        materialProposal: null,
        createdAt: '2026-07-19T00:00:02.000Z',
      });
      const firstInput = {
        artifactId: 'artifact_demo',
        artifactVersion: 1,
        contentDigest: contentDigest('version one'),
        sourceThreadId: 'thread_demo',
        sourceTurnId: 'turn_one',
        sourceAgentId: 'agent_demo',
        materialProposal: null,
        createdAt: '2026-07-19T00:00:01.000Z',
      };
      const first = createArtifactReview(workspaceDb, firstInput);
      const expectedReviewId = `arev_${createHash('sha256')
        .update(JSON.stringify(['ws_review_history', 'artifact_demo', 1]))
        .digest('hex')
        .slice(0, 24)}`;

      expect(first).toEqual({
        workspaceId: 'ws_review_history',
        reviewId: expectedReviewId,
        ...firstInput,
        decision: null,
        decisionActorId: null,
        feedback: null,
        decidedAt: null,
        followUpTurnId: null,
        appliedMaterialRevisionId: null,
      });
      expect(createArtifactReview(workspaceDb, firstInput)).toEqual(first);
      expect(getArtifactReview(workspaceDb, 'artifact_demo', 1)).toEqual(first);
      expect(listArtifactReviews(workspaceDb)).toEqual([first, second]);

      expect(() =>
        createArtifactReview(workspaceDb, {
          ...firstInput,
          contentDigest: contentDigest('contradictory bytes'),
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(listArtifactReviews(workspaceDb)).toEqual([first, second]);
      expect(() => getArtifactReview(workspaceDb, 'artifact_demo', 3)).toThrowError(
        expect.objectContaining({ code: 'stale' })
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('enforces first-writer decisions, exact replay, and reserved follow-up identity', () => {
    const workspaceDb = openTestWorkspaceDb('ws_review_decisions');

    try {
      const acceptedContent = 'accept this output';
      const accepted = createArtifactReview(workspaceDb, {
        artifactId: 'artifact_decision',
        artifactVersion: 1,
        contentDigest: contentDigest(acceptedContent),
        sourceThreadId: 'thread_decision',
        sourceTurnId: 'turn_decision',
        sourceAgentId: 'agent_decision',
        materialProposal: null,
        createdAt: '2026-07-19T01:00:00.000Z',
      });
      const acceptedInput = {
        actorId: 'user_local',
        artifactContent: acceptedContent,
        artifactId: accepted.artifactId,
        artifactMediaType: 'text/plain' as const,
        artifactVersion: accepted.artifactVersion,
        decidedAt: '2026-07-19T01:00:01.000Z',
        decision: 'accepted' as const,
        feedback: null,
        requestId: 'request_accept_review',
      };
      const acceptedResponse = decideArtifactReview(workspaceDb, acceptedInput);

      expect(acceptedResponse).toEqual({
        reviewId: accepted.reviewId,
        artifactId: accepted.artifactId,
        artifactVersion: 1,
        decision: 'accepted',
        followUpTurnId: null,
      });
      const acceptedReplayInput = {
        actorId: acceptedInput.actorId,
        artifactId: acceptedInput.artifactId,
        artifactVersion: acceptedInput.artifactVersion,
        decision: acceptedInput.decision,
        feedback: acceptedInput.feedback,
        requestId: acceptedInput.requestId,
      };
      expect(replayArtifactReviewDecision(workspaceDb, acceptedReplayInput)).toEqual(
        acceptedResponse
      );
      expect(() =>
        replayArtifactReviewDecision(workspaceDb, {
          ...acceptedReplayInput,
          feedback: 'changed replay',
        })
      ).toThrowError(expect.objectContaining({ code: 'idempotency_key_conflict' }));
      expect(() =>
        decideArtifactReview(workspaceDb, {
          ...acceptedInput,
          requestId: 'request_competing_decision',
        })
      ).toThrowError(expect.objectContaining({ code: 'stale' }));

      const redoContent = 'redo this output';
      const redo = createArtifactReview(workspaceDb, {
        artifactId: 'artifact_decision',
        artifactVersion: 2,
        contentDigest: contentDigest(redoContent),
        sourceThreadId: 'thread_decision',
        sourceTurnId: 'turn_decision',
        sourceAgentId: 'agent_decision',
        materialProposal: null,
        createdAt: '2026-07-19T01:00:02.000Z',
      });
      const redoInput = {
        actorId: 'user_local',
        artifactContent: redoContent,
        artifactId: redo.artifactId,
        artifactMediaType: 'text/plain' as const,
        artifactVersion: redo.artifactVersion,
        decidedAt: '2026-07-19T01:00:03.000Z',
        decision: 'redo' as const,
        feedback: 'Use the current brief.',
        requestId: 'request_redo_review',
      };
      const redoResponse = decideArtifactReview(workspaceDb, redoInput);

      expect(redoResponse.followUpTurnId).toMatch(/^tu_artifact_review_[a-f0-9]{24}$/);
      expect(decideArtifactReview(workspaceDb, redoInput)).toEqual(redoResponse);
      expect(getArtifactReview(workspaceDb, redo.artifactId, 2)).toMatchObject({
        decision: 'redo',
        feedback: redoInput.feedback,
        followUpTurnId: redoResponse.followUpTurnId,
      });

      const unresolvedContent = 'still unresolved';
      createArtifactReview(workspaceDb, {
        artifactId: 'artifact_decision',
        artifactVersion: 3,
        contentDigest: contentDigest(unresolvedContent),
        sourceThreadId: 'thread_decision',
        sourceTurnId: 'turn_decision',
        sourceAgentId: 'agent_decision',
        materialProposal: null,
        createdAt: '2026-07-19T01:00:04.000Z',
      });
      const beforeCorruption = authoritySnapshot(workspaceDb);
      expect(() =>
        decideArtifactReview(workspaceDb, {
          actorId: 'user_local',
          artifactContent: 'wrong bytes',
          artifactId: 'artifact_decision',
          artifactMediaType: 'text/plain',
          artifactVersion: 3,
          decidedAt: '2026-07-19T01:00:05.000Z',
          decision: 'rejected',
          feedback: null,
          requestId: 'request_corrupt_review',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(authoritySnapshot(workspaceDb)).toEqual(beforeCorruption);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('atomically applies an accepted proposal and preserves conflict state', () => {
    const workspaceDb = openTestWorkspaceDb('ws_review_apply');

    try {
      const material = createWorkspaceMaterial(workspaceDb, {
        acceptedAt: '2026-07-19T02:00:00.000Z',
        actorId: 'user_local',
        kind: 'markdown',
        requestId: 'request_create_material',
        sensitivity: 'internal',
        title: 'Reviewed material',
      });
      const baseContent = '# Base\n';
      const base = saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: '2026-07-19T02:00:01.000Z',
        actorId: 'user_local',
        content: baseContent,
        contentDigest: contentDigest(baseContent),
        expectedRevisionId: null,
        materialId: material.materialId,
        requestId: 'request_save_base',
      });
      for (const [threadId, requestId] of [
        ['thread_included', 'request_bind_included'],
        ['thread_excluded', 'request_bind_excluded'],
      ] as const) {
        bindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-19T02:00:02.000Z',
          expectedBindingState: 'absent',
          materialId: material.materialId,
          requestId,
          threadId,
        });
      }
      excludeThreadMaterial(workspaceDb, {
        acceptedAt: '2026-07-19T02:00:03.000Z',
        expectedBindingState: 'bound',
        expectedInclusionState: 'included',
        expectedQueuedRevisionId: base.revisionId,
        materialId: material.materialId,
        requestId: 'request_exclude_binding',
        threadId: 'thread_excluded',
      });

      const proposalContent = '# Worker proposal\n';
      const proposal = createArtifactReview(workspaceDb, {
        artifactId: 'artifact_material_proposal',
        artifactVersion: 1,
        contentDigest: contentDigest(proposalContent),
        sourceThreadId: 'thread_included',
        sourceTurnId: 'turn_worker',
        sourceAgentId: 'agent_worker',
        materialProposal: {
          materialId: material.materialId,
          baseRevisionId: base.revisionId,
          baseContentDigest: contentDigest(baseContent),
        },
        createdAt: '2026-07-19T02:00:04.000Z',
      });
      const decideInput = {
        actorId: 'reviewer',
        artifactContent: proposalContent,
        artifactId: proposal.artifactId,
        artifactMediaType: 'text/markdown' as const,
        artifactVersion: proposal.artifactVersion,
        decidedAt: '2026-07-19T02:00:05.000Z',
        decision: 'accepted' as const,
        feedback: 'Approved.',
        requestId: 'request_apply_proposal',
      };

      workspaceDb.sqlite
        .prepare(`UPDATE workspace_material_revisions SET content = 'corrupt base'
          WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
        .run('ws_review_apply', material.materialId, base.revisionId);
      const corruptBase = authoritySnapshot(workspaceDb);
      expect(() => decideArtifactReview(workspaceDb, decideInput)).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(authoritySnapshot(workspaceDb)).toEqual(corruptBase);
      workspaceDb.sqlite
        .prepare(`UPDATE workspace_material_revisions SET content = ?
          WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
        .run(baseContent, 'ws_review_apply', material.materialId, base.revisionId);

      decideArtifactReview(workspaceDb, decideInput);
      const decided = getArtifactReview(workspaceDb, proposal.artifactId, proposal.artifactVersion);

      expect(decided.appliedMaterialRevisionId).toMatch(/^mrev_[a-f0-9]{24}$/);
      expect(getWorkspaceMaterial(workspaceDb, material.materialId).currentRevisionId).toBe(
        decided.appliedMaterialRevisionId
      );
      expect(
        getWorkspaceMaterialRevision(
          workspaceDb,
          material.materialId,
          decided.appliedMaterialRevisionId ?? ''
        )
      ).toEqual({
        workspaceId: 'ws_review_apply',
        materialId: material.materialId,
        revisionId: decided.appliedMaterialRevisionId,
        parentRevisionId: base.revisionId,
        mediaType: 'text/markdown',
        contentDigest: contentDigest(proposalContent),
        content: proposalContent,
        authorId: 'reviewer',
        createdAt: decideInput.decidedAt,
      });
      expect(
        workspaceDb.sqlite
          .prepare(`SELECT thread_id AS threadId, latest_queued_revision_id AS revisionId,
            inclusion_state AS inclusionState, last_mutation_request_id AS requestId
            FROM thread_material_bindings ORDER BY thread_id`)
          .all()
      ).toEqual([
        {
          threadId: 'thread_excluded',
          revisionId: decided.appliedMaterialRevisionId,
          inclusionState: 'excluded',
          requestId: decideInput.requestId,
        },
        {
          threadId: 'thread_included',
          revisionId: decided.appliedMaterialRevisionId,
          inclusionState: 'included',
          requestId: decideInput.requestId,
        },
      ]);
      const conflictingContent = '# Conflicting worker proposal\n';
      const conflictReview = createArtifactReview(workspaceDb, {
        artifactId: 'artifact_material_conflict',
        artifactVersion: 1,
        contentDigest: contentDigest(conflictingContent),
        sourceThreadId: 'thread_included',
        sourceTurnId: 'turn_worker_two',
        sourceAgentId: 'agent_worker',
        materialProposal: {
          materialId: material.materialId,
          baseRevisionId: decided.appliedMaterialRevisionId ?? '',
          baseContentDigest: contentDigest(proposalContent),
        },
        createdAt: '2026-07-19T02:00:06.000Z',
      });
      const userContent = '# Newer user revision\n';
      saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: '2026-07-19T02:00:07.000Z',
        actorId: 'user_local',
        content: userContent,
        contentDigest: contentDigest(userContent),
        expectedRevisionId: decided.appliedMaterialRevisionId,
        materialId: material.materialId,
        requestId: 'request_newer_user_revision',
      });
      const beforeConflict = authoritySnapshot(workspaceDb);

      expect(() =>
        decideArtifactReview(workspaceDb, {
          actorId: 'reviewer',
          artifactContent: conflictingContent,
          artifactId: conflictReview.artifactId,
          artifactMediaType: 'text/markdown',
          artifactVersion: conflictReview.artifactVersion,
          decidedAt: '2026-07-19T02:00:08.000Z',
          decision: 'accepted',
          feedback: null,
          requestId: 'request_conflicting_apply',
        })
      ).toThrowError(expect.objectContaining({ code: 'conflict' }));
      expect(authoritySnapshot(workspaceDb)).toEqual(beforeConflict);

      const rollbackContent = '# Roll back all rows\n';
      const currentRevisionId = getWorkspaceMaterial(
        workspaceDb,
        material.materialId
      ).currentRevisionId;
      const current = getWorkspaceMaterialRevision(
        workspaceDb,
        material.materialId,
        currentRevisionId ?? ''
      );
      const rollbackReview = createArtifactReview(workspaceDb, {
        artifactId: 'artifact_material_rollback',
        artifactVersion: 1,
        contentDigest: contentDigest(rollbackContent),
        sourceThreadId: 'thread_included',
        sourceTurnId: 'turn_worker_three',
        sourceAgentId: 'agent_worker',
        materialProposal: {
          materialId: material.materialId,
          baseRevisionId: current.revisionId,
          baseContentDigest: current.contentDigest,
        },
        createdAt: '2026-07-19T02:00:09.000Z',
      });
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER fail_review_queue_update
        BEFORE UPDATE OF latest_queued_revision_id ON thread_material_bindings
        WHEN NEW.last_mutation_request_id = 'request_rollback_apply'
        BEGIN
          SELECT RAISE(ABORT, 'forced Review queue failure');
        END
      `);
      const beforeRollback = authoritySnapshot(workspaceDb);

      expect(() =>
        decideArtifactReview(workspaceDb, {
          actorId: 'reviewer',
          artifactContent: rollbackContent,
          artifactId: rollbackReview.artifactId,
          artifactMediaType: 'text/markdown',
          artifactVersion: rollbackReview.artifactVersion,
          decidedAt: '2026-07-19T02:00:10.000Z',
          decision: 'accepted',
          feedback: null,
          requestId: 'request_rollback_apply',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      workspaceDb.sqlite.exec('DROP TRIGGER fail_review_queue_update');
      expect(authoritySnapshot(workspaceDb)).toEqual(beforeRollback);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
