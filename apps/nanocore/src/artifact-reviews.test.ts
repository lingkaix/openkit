import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEntityId, isEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  createArtifactReview,
  decideArtifactReview,
  getArtifactReview,
  listArtifactReviews,
  listExportableArtifactReviews,
  replayArtifactReviewDecision,
  selectArtifactReviewCandidate,
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
    const workspaceDb = openTestWorkspaceDb('ws_00000000-0000-7716-b700-bc790c21df4a');

    try {
      const second = createArtifactReview(workspaceDb, {
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
        artifactVersion: 2,
        contentDigest: contentDigest('version two'),
        sourceThreadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
        sourceTurnId: 'tu_00000000-0000-7b57-ac3a-3174f55981a0',
        sourceAgentId: 'agent_demo',
        materialProposal: null,
        createdAt: '2026-07-19T00:00:02.000Z',
      });
      const firstInput = {
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
        artifactVersion: 1,
        contentDigest: contentDigest('version one'),
        sourceThreadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
        sourceTurnId: 'tu_00000000-0000-720b-b7e3-329cde0924fd',
        sourceAgentId: 'agent_demo',
        materialProposal: null,
        createdAt: '2026-07-19T00:00:01.000Z',
      };
      const first = createArtifactReview(workspaceDb, firstInput);
      const expectedReviewId = deriveEntityId('arev', [
        workspaceDb.workspaceId,
        firstInput.artifactId,
        1,
      ]);

      expect(first).toEqual({
        workspaceId: 'ws_00000000-0000-7716-b700-bc790c21df4a',
        reviewId: expectedReviewId,
        ...firstInput,
        decision: null,
        decisionActorId: null,
        feedback: null,
        rangeFeedback: null,
        candidateSelections: [],
        judgements: [],
        decidedAt: null,
        followUpTurnId: null,
        appliedMaterialRevisionId: null,
      });
      expect(createArtifactReview(workspaceDb, firstInput)).toEqual(first);
      expect(getArtifactReview(workspaceDb, 'ar_00000000-0000-78f7-9fad-58a15c7011af', 1)).toEqual(
        first
      );
      expect(listArtifactReviews(workspaceDb)).toEqual([first, second]);

      expect(() =>
        createArtifactReview(workspaceDb, {
          ...firstInput,
          contentDigest: contentDigest('contradictory bytes'),
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(listArtifactReviews(workspaceDb)).toEqual([first, second]);
      expect(() =>
        getArtifactReview(workspaceDb, 'ar_00000000-0000-78f7-9fad-58a15c7011af', 3)
      ).toThrowError(expect.objectContaining({ code: 'stale' }));
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('enforces first-writer decisions, exact replay, and reserved follow-up identity', () => {
    const workspaceDb = openTestWorkspaceDb('ws_00000000-0000-73bd-8075-86252d2e4777');

    try {
      const acceptedContent = 'accept this output';
      const accepted = createArtifactReview(workspaceDb, {
        artifactId: 'ar_00000000-0000-7d8c-ab2b-b3c252c015ec',
        artifactVersion: 1,
        contentDigest: contentDigest(acceptedContent),
        sourceThreadId: 'th_00000000-0000-776d-8ff9-cd97788667e1',
        sourceTurnId: 'tu_00000000-0000-7556-8814-c40997decfe7',
        sourceAgentId: 'agent_decision',
        materialProposal: null,
        createdAt: '2026-07-19T01:00:00.000Z',
      });
      const acceptedInput = {
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
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
        artifactId: 'ar_00000000-0000-7d8c-ab2b-b3c252c015ec',
        artifactVersion: 2,
        contentDigest: contentDigest(redoContent),
        sourceThreadId: 'th_00000000-0000-776d-8ff9-cd97788667e1',
        sourceTurnId: 'tu_00000000-0000-7556-8814-c40997decfe7',
        sourceAgentId: 'agent_decision',
        materialProposal: null,
        createdAt: '2026-07-19T01:00:02.000Z',
      });
      const redoInput = {
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
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

      expect(redoResponse.followUpTurnId).toBe(
        deriveEntityId('tu', [
          workspaceDb.workspaceId,
          redo.artifactId,
          redo.artifactVersion,
          redoInput.requestId,
        ])
      );
      expect(decideArtifactReview(workspaceDb, redoInput)).toEqual(redoResponse);
      expect(getArtifactReview(workspaceDb, redo.artifactId, 2)).toMatchObject({
        decision: 'redo',
        feedback: redoInput.feedback,
        followUpTurnId: redoResponse.followUpTurnId,
      });

      const unresolvedContent = 'still unresolved';
      createArtifactReview(workspaceDb, {
        artifactId: 'ar_00000000-0000-7d8c-ab2b-b3c252c015ec',
        artifactVersion: 3,
        contentDigest: contentDigest(unresolvedContent),
        sourceThreadId: 'th_00000000-0000-776d-8ff9-cd97788667e1',
        sourceTurnId: 'tu_00000000-0000-7556-8814-c40997decfe7',
        sourceAgentId: 'agent_decision',
        materialProposal: null,
        createdAt: '2026-07-19T01:00:04.000Z',
      });
      const beforeCorruption = authoritySnapshot(workspaceDb);
      expect(() =>
        decideArtifactReview(workspaceDb, {
          actorId: 'usr_00000000-0000-7000-8000-000000000001',
          actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
          artifactContent: 'wrong bytes',
          artifactId: 'ar_00000000-0000-7d8c-ab2b-b3c252c015ec',
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
    const workspaceDb = openTestWorkspaceDb('ws_00000000-0000-7f79-97b4-ff613d9974e0');

    try {
      const material = createWorkspaceMaterial(workspaceDb, {
        acceptedAt: '2026-07-19T02:00:00.000Z',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        kind: 'markdown',
        requestId: 'request_create_material',
        sensitivity: 'internal',
        title: 'Reviewed material',
      });
      const baseContent = '# Base\n';
      const base = saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: '2026-07-19T02:00:01.000Z',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        content: baseContent,
        contentDigest: contentDigest(baseContent),
        expectedRevisionId: null,
        materialId: material.materialId,
        requestId: 'request_save_base',
      });
      for (const [threadId, requestId] of [
        ['th_00000000-0000-7c3a-8a93-566470f07177', 'request_bind_included'],
        ['th_00000000-0000-75cd-a2ad-320e71ddafea', 'request_bind_excluded'],
      ] as const) {
        bindThreadMaterial(workspaceDb, {
          acceptedAt: '2026-07-19T02:00:02.000Z',
          expectedBindingState: 'not_bound',
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
        threadId: 'th_00000000-0000-75cd-a2ad-320e71ddafea',
      });

      const proposalContent = '# Worker proposal\n';
      const proposal = createArtifactReview(workspaceDb, {
        artifactId: 'ar_00000000-0000-7cde-998c-3cd64a150f4d',
        artifactVersion: 1,
        contentDigest: contentDigest(proposalContent),
        sourceThreadId: 'th_00000000-0000-7c3a-8a93-566470f07177',
        sourceTurnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
        sourceAgentId: 'agent_worker',
        materialProposal: {
          materialId: material.materialId,
          baseRevisionId: base.revisionId,
          baseContentDigest: contentDigest(baseContent),
        },
        createdAt: '2026-07-19T02:00:04.000Z',
      });
      const decideInput = {
        actorId: 'usr_00000000-0000-7431-952e-1a295ae9b2ab',
        actor: { kind: 'user' as const, id: 'usr_00000000-0000-7431-952e-1a295ae9b2ab' },
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
        .run('ws_00000000-0000-7f79-97b4-ff613d9974e0', material.materialId, base.revisionId);
      const corruptBase = authoritySnapshot(workspaceDb);
      expect(() => decideArtifactReview(workspaceDb, decideInput)).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(authoritySnapshot(workspaceDb)).toEqual(corruptBase);
      workspaceDb.sqlite
        .prepare(`UPDATE workspace_material_revisions SET content = ?
          WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
        .run(
          baseContent,
          'ws_00000000-0000-7f79-97b4-ff613d9974e0',
          material.materialId,
          base.revisionId
        );

      decideArtifactReview(workspaceDb, decideInput);
      const decided = getArtifactReview(workspaceDb, proposal.artifactId, proposal.artifactVersion);

      expect(isEntityId('mrev', decided.appliedMaterialRevisionId)).toBe(true);
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
        workspaceId: 'ws_00000000-0000-7f79-97b4-ff613d9974e0',
        materialId: material.materialId,
        revisionId: decided.appliedMaterialRevisionId,
        parentRevisionId: base.revisionId,
        mediaType: 'text/markdown',
        contentDigest: contentDigest(proposalContent),
        content: proposalContent,
        judgements: [],
        authorId: 'usr_00000000-0000-7431-952e-1a295ae9b2ab',
        createdAt: decideInput.decidedAt,
      });
      expect(
        workspaceDb.sqlite
          .prepare(`SELECT thread_id AS threadId, latest_queued_revision_id AS revisionId,
            inclusion_state AS inclusionState, last_mutation_request_id AS requestId
            FROM thread_material_bindings ORDER BY inclusion_state`)
          .all()
      ).toEqual([
        {
          threadId: 'th_00000000-0000-75cd-a2ad-320e71ddafea',
          revisionId: decided.appliedMaterialRevisionId,
          inclusionState: 'excluded',
          requestId: decideInput.requestId,
        },
        {
          threadId: 'th_00000000-0000-7c3a-8a93-566470f07177',
          revisionId: decided.appliedMaterialRevisionId,
          inclusionState: 'included',
          requestId: decideInput.requestId,
        },
      ]);
      const conflictingContent = '# Conflicting worker proposal\n';
      const conflictReview = createArtifactReview(workspaceDb, {
        artifactId: 'ar_00000000-0000-733d-b146-d99b3b6a98fd',
        artifactVersion: 1,
        contentDigest: contentDigest(conflictingContent),
        sourceThreadId: 'th_00000000-0000-7c3a-8a93-566470f07177',
        sourceTurnId: 'tu_00000000-0000-7e70-80e3-e496fa0255e3',
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
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        content: userContent,
        contentDigest: contentDigest(userContent),
        expectedRevisionId: decided.appliedMaterialRevisionId,
        materialId: material.materialId,
        requestId: 'request_newer_user_revision',
      });
      const beforeConflict = authoritySnapshot(workspaceDb);

      expect(() =>
        decideArtifactReview(workspaceDb, {
          actorId: 'usr_00000000-0000-7431-952e-1a295ae9b2ab',
          actor: { kind: 'user' as const, id: 'usr_00000000-0000-7431-952e-1a295ae9b2ab' },
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
        artifactId: 'ar_00000000-0000-79f7-bc51-889391f118b2',
        artifactVersion: 1,
        contentDigest: contentDigest(rollbackContent),
        sourceThreadId: 'th_00000000-0000-7c3a-8a93-566470f07177',
        sourceTurnId: 'tu_00000000-0000-72db-a321-0e4588859c6f',
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
          actorId: 'usr_00000000-0000-7431-952e-1a295ae9b2ab',
          actor: { kind: 'user' as const, id: 'usr_00000000-0000-7431-952e-1a295ae9b2ab' },
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

it('chooses an accepted Material candidate after whole-revision apply advances its base', () => {
  const db = openTestWorkspaceDb('ws_00000000-0000-7000-8000-000000000001');
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  const timestamp = '2026-10-17T00:00:00.000Z';
  try {
    const { materialId } = createWorkspaceMaterial(db, {
      actor,
      acceptedAt: timestamp,
      requestId: 'create',
      title: 'Material',
      kind: 'text',
      sensitivity: 'internal',
    });
    const { revisionId } = saveWorkspaceMaterialRevision(db, {
      actor,
      acceptedAt: timestamp,
      requestId: 'base',
      materialId,
      expectedRevisionId: null,
      content: 'Base.',
      contentDigest: contentDigest('Base.'),
    });
    const artifactId = 'ar_00000000-0000-7000-8000-000000000001';
    createArtifactReview(db, {
      artifactId,
      artifactVersion: 1,
      contentDigest: contentDigest('Candidate.'),
      sourceThreadId: null,
      sourceTurnId: null,
      sourceAgentId: null,
      materialProposal: {
        materialId,
        baseRevisionId: revisionId,
        baseContentDigest: contentDigest('Base.'),
      },
      createdAt: timestamp,
    });
    decideArtifactReview(db, {
      actor,
      actorId: actor.id,
      artifactId,
      artifactVersion: 1,
      requestId: 'accept',
      decidedAt: timestamp,
      decision: 'accepted',
      feedback: null,
      artifactContent: 'Candidate.',
      artifactMediaType: 'text/plain',
    });
    const before = getArtifactReview(db, artifactId, 1);
    const materials = db.sqlite.prepare('SELECT * FROM workspace_material_revisions').all();
    const turns = db.sqlite.prepare('SELECT * FROM worker_turn_checkpoints').all();
    const choice = selectArtifactReviewCandidate(db, {
      actorId: actor.id,
      artifactId,
      artifactVersion: 1,
      contentDigest: contentDigest('Candidate.'),
      requestId: 'choose',
      reason: 'Use the accepted candidate.',
      selectedAt: timestamp,
    });
    expect(choice).toMatchObject({
      ...before,
      candidateSelections: [
        {
          actorId: actor.id,
          requestId: 'choose',
          reason: 'Use the accepted candidate.',
          selectedAt: timestamp,
        },
      ],
    });
    expect(db.sqlite.prepare('SELECT * FROM workspace_material_revisions').all()).toEqual(
      materials
    );
    expect(db.sqlite.prepare('SELECT * FROM worker_turn_checkpoints').all()).toEqual(turns);
  } finally {
    db.sqlite.close();
  }
});

/** Opens a temporary SQL-only Review fixture and removes its owned files after the test. */
function retainedReviewFixture(): {
  readonly db: WorkspaceDb;
  readonly input: Parameters<typeof createArtifactReview>[1];
} {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retained-review-'));
  const db = openWorkspaceDb(root, 'ws_00000000-0000-7716-b700-bc790c21df4a');
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  const input = {
    artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
    artifactVersion: 1,
    contentDigest: contentDigest('retained review'),
    sourceThreadId: null,
    sourceTurnId: null,
    sourceAgentId: null,
    materialProposal: null,
    createdAt: '2026-07-19T00:00:00.000Z',
  };
  createArtifactReview(db, input);
  return { db, input };
}

describe('retained Artifact Review SQL format', () => {
  it('writes v1 and retains descriptive choice annotations without rewriting a read', () => {
    const { db, input } = retainedReviewFixture();
    const choices = JSON.stringify([
      {
        actorId: 'reviewer',
        requestId: 'selection',
        reason: null,
        selectedAt: '2026-07-19T00:00:01.000Z',
        note: 'Retained description',
      },
    ]);
    db.sqlite.prepare('UPDATE artifact_reviews SET candidate_selections=?').run(choices);
    const before = db.sqlite.prepare('SELECT * FROM artifact_reviews').get();
    expect(before).toMatchObject({ schema_version: 1 });
    const review = getArtifactReview(db, input.artifactId, input.artifactVersion);
    expect(review.candidateSelections[0]).toMatchObject({
      requestId: 'selection',
    });
    expect(review.candidateSelections[0]).not.toHaveProperty('note');
    expect(listExportableArtifactReviews(db)[0]?.candidateSelections[0]).toMatchObject({
      note: 'Retained description',
    });
    expect(db.sqlite.prepare('SELECT * FROM artifact_reviews').get()).toEqual(before);
    selectArtifactReviewCandidate(db, {
      actorId: 'reviewer',
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      contentDigest: input.contentDigest,
      requestId: 'selection-next',
      selectedAt: '2026-07-19T00:00:02.000Z',
    });
    expect(
      JSON.parse(
        (
          db.sqlite.prepare('SELECT candidate_selections FROM artifact_reviews').get() as {
            candidate_selections: string;
          }
        ).candidate_selections
      )[0]
    ).toMatchObject({ note: 'Retained description' });
  });

  it('refuses an unknown row format before JSON decoding or replacement', () => {
    const { db, input } = retainedReviewFixture();
    db.sqlite
      .prepare("UPDATE artifact_reviews SET schema_version=2, candidate_selections='{invalid'")
      .run();
    const before = db.sqlite.prepare('SELECT * FROM artifact_reviews').get();
    expect(() => getArtifactReview(db, input.artifactId, input.artifactVersion)).toThrow(
      'Unsupported retained record format'
    );
    expect(() => createArtifactReview(db, input)).toThrow('Unsupported retained record format');
    expect(db.sqlite.prepare('SELECT * FROM artifact_reviews').get()).toEqual(before);
  });
});
