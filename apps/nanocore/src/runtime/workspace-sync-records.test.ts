import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import {
  getWorkspaceSyncReview,
  importWorkspaceSyncRecords,
  listBackendWorkspaceHandles,
  listExportableWorkspaceSyncRecords,
  listWorkerOutputManifests,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  recordWorkspaceSyncReview,
  updateBackendWorkspaceHandleCleanupStatus,
  updateWorkspaceSyncReviewDecision,
} from './workspace-sync-records.js';

const timestamp = '2026-07-05T00:00:00.000Z';
const workspacePatchText = 'diff --git a/docs/loop.md b/docs/loop.md\n';
const workspacePatchDigest = `sha256:${createHash('sha256').update(workspacePatchText).digest('hex')}`;

describe('workspace sync records', () => {
  it('records one linked audit event when a staged review is first stored', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-review-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      const audits = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE resource = ? ORDER BY created_at')
        .all('workspace-review:swr_1') as Array<Record<string, unknown>>;
      const evidenceBundles = workspaceDb.sqlite
        .prepare(
          `SELECT
            evidence_bundle_id,
            workspace_id,
            source_kind,
            summary,
            redacted_evidence_refs_json,
            content_digests_json,
            retention_class,
            sensitivity_class,
            import_status,
            required_features_json
          FROM evidence_bundles
          WHERE source_kind = 'workspace-sync-review'
          ORDER BY created_at`
        )
        .all() as Array<Record<string, unknown>>;

      expect(audits).toEqual([
        expect.objectContaining({
          action: 'workspace.review.stage',
          category: 'artifact',
          created_at: timestamp,
          error_code: null,
          outcome: 'succeeded',
          resource: 'workspace-review:swr_1',
          severity: 'info',
          summary: 'Workspace review staged: 1 changed path, strategy git',
          workspace_id: 'ws_demo',
        }),
      ]);
      expect(evidenceBundles).toEqual([
        expect.objectContaining({
          evidence_bundle_id: 'evb_workspace_review_swr_1',
          workspace_id: 'ws_demo',
          source_kind: 'workspace-sync-review',
          summary: 'Workspace review staged: 1 changed path, strategy git',
          redacted_evidence_refs_json: JSON.stringify([
            { kind: 'worker', ref: 'turn_1' },
            { kind: 'workspace-sync-patch', ref: 'artifact://patch' },
          ]),
          content_digests_json: JSON.stringify([workspacePatchDigest]),
          retention_class: 'workspace-audit',
          sensitivity_class: 'product-safe',
          import_status: 'promoted',
          required_features_json: JSON.stringify(['evidence.bundle.v1']),
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    {
      field: 'terminal status',
      invalid: () => {
        const item = workspaceReviewItem();
        return { ...item, review: { ...item.review, status: 'accepted' as const } };
      },
    },
    {
      field: 'review workspace',
      invalid: () => {
        const item = workspaceReviewItem();
        return { ...item, review: { ...item.review, workspaceId: 'ws_other' } };
      },
    },
    {
      field: 'review change-set id',
      invalid: () => {
        const item = workspaceReviewItem();
        return { ...item, review: { ...item.review, changeSetId: 'wcs_other' } };
      },
    },
    {
      field: 'patch digest',
      invalid: () => {
        const item = workspaceReviewItem();
        return {
          ...item,
          patchPayload: item.patchPayload
            ? { ...item.patchPayload, digest: `sha256:${'0'.repeat(64)}` }
            : null,
        };
      },
    },
    {
      field: 'patch byte count',
      invalid: () => {
        const item = workspaceReviewItem();
        return {
          ...item,
          patchPayload: item.patchPayload
            ? { ...item.patchPayload, bytes: item.patchPayload.bytes + 1 }
            : null,
        };
      },
    },
  ])('rejects invalid initial workspace review $field before persistence', ({ invalid }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-ingress-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      expect(() => recordWorkspaceSyncReview(workspaceDb, { item: invalid() })).toThrow();
      for (const table of [
        'workspace_input_snapshots',
        'workspace_materialization_records',
        'backend_workspace_handles',
        'worker_output_manifests',
        'workspace_change_sets',
        'staged_workspace_reviews',
      ]) {
        expect(workspaceDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
          count: 0,
        });
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('carries source ids into staged workspace review change sets', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-source-review-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);

      const item = recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      expect(item.changeSet.sourceId).toBe('repo_default');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('treats an identical workspace change set replay as a no-op', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-change-set-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const item = workspaceReviewItem();
      recordWorkspaceSyncReview(workspaceDb, { item });
      const stored = workspaceDb.sqlite
        .prepare('SELECT * FROM workspace_change_sets WHERE change_set_id = ?')
        .get(item.changeSet.id);

      recordWorkspaceSyncReview(workspaceDb, { item });

      expect(
        workspaceDb.sqlite
          .prepare('SELECT * FROM workspace_change_sets WHERE change_set_id = ?')
          .all(item.changeSet.id)
      ).toEqual([stored]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('treats an identical staged workspace review replay as a no-op', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const original = recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });
      const stored = workspaceDb.sqlite
        .prepare('SELECT * FROM staged_workspace_reviews WHERE review_id = ?')
        .get(original.review.id);

      const replayed = recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      expect(replayed).toEqual(original);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT * FROM staged_workspace_reviews WHERE review_id = ?')
          .all(original.review.id)
      ).toEqual([stored]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    {
      field: 'artifactId',
      replay: () => ({ ...workspaceReviewItem(), artifactId: 'ar_other' }),
    },
    {
      field: 'patchPayload',
      replay: () => {
        const item = workspaceReviewItem();

        return {
          ...item,
          patchPayload: item.patchPayload
            ? { ...item.patchPayload, digest: 'sha256:other-patch' }
            : null,
        };
      },
    },
    {
      field: 'review.riskSummary',
      replay: () => {
        const item = workspaceReviewItem();

        return {
          ...item,
          review: { ...item.review, riskSummary: 'Different immutable risk summary.' },
        };
      },
    },
    {
      field: 'review.changeSetId',
      replay: () => {
        const item = workspaceReviewItem();

        return {
          ...item,
          changeSet: { ...item.changeSet, id: 'wcs_2' },
          review: { ...item.review, changeSetId: 'wcs_2' },
        };
      },
    },
  ])('rejects a same-id staged workspace review replay that changes $field', ({ replay }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const original = recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });
      const originalChangeSets = listWorkspaceChangeSets(workspaceDb, 'ws_demo');
      const originalManifests = listWorkerOutputManifests(workspaceDb, 'ws_demo');

      expect(() => recordWorkspaceSyncReview(workspaceDb, { item: replay() })).toThrow(/conflict/i);
      expect(getWorkspaceSyncReview(workspaceDb, 'ws_demo', original.review.id)).toEqual(original);
      expect(listWorkspaceChangeSets(workspaceDb, 'ws_demo')).toEqual(originalChangeSets);
      expect(listWorkerOutputManifests(workspaceDb, 'ws_demo')).toEqual(originalManifests);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    {
      field: 'resourceId',
      replay: () => {
        const item = workspaceReviewItem();
        return { ...item, changeSet: { ...item.changeSet, resourceId: 'repo_other' } };
      },
    },
    {
      field: 'head.commit',
      replay: () => {
        const item = workspaceReviewItem();
        return {
          ...item,
          changeSet: { ...item.changeSet, head: { ...item.changeSet.head, commit: 'fedcba' } },
        };
      },
    },
  ])('rejects a same-id workspace change set replay that changes $field', ({ replay }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-change-set-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      expect(() => recordWorkspaceSyncReview(workspaceDb, { item: replay() })).toThrow(/conflict/i);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('preserves a terminal review decision when staging evidence is replayed', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-terminal-review-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });
      updateWorkspaceSyncReviewDecision(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000001',
        reviewId: 'swr_1',
        status: 'accepted',
        updatedAt: '2026-07-05T00:01:00.000Z',
        workspaceId: 'ws_demo',
      });

      const replayed = recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      expect(replayed.review).toMatchObject({
        id: 'swr_1',
        status: 'accepted',
        updatedAt: '2026-07-05T00:01:00.000Z',
      });
      expect(getWorkspaceSyncReview(workspaceDb, 'ws_demo', 'swr_1')?.review.status).toBe(
        'accepted'
      );
      expect(
        workspaceDb.sqlite
          .prepare("SELECT request_id FROM audit_events WHERE action = 'workspace.review.decide'")
          .get()
      ).toEqual({ request_id: '00000000-0000-4000-8000-000000000001' });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('promotes materialization readiness evidence into the evidence bundle ledger', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-materialization-evidence-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);

      const evidenceBundles = workspaceDb.sqlite
        .prepare(
          `SELECT
            evidence_bundle_id,
            workspace_id,
            source_kind,
            summary,
            redacted_evidence_refs_json,
            content_digests_json,
            retention_class,
            sensitivity_class,
            import_status,
            required_features_json
          FROM evidence_bundles
          ORDER BY created_at`
        )
        .all() as Array<Record<string, unknown>>;

      expect(evidenceBundles).toEqual([
        expect.objectContaining({
          evidence_bundle_id: 'evb_workspace_materialization_wmr_1',
          workspace_id: 'ws_demo',
          source_kind: 'workspace-materialization',
          summary: 'Workspace materialization recorded: strategy git, backend openshell',
          redacted_evidence_refs_json: JSON.stringify([
            { kind: 'backend.ready', ref: 'version:0.0.63' },
          ]),
          content_digests_json: JSON.stringify(['sha256:policy']),
          retention_class: 'workspace-audit',
          sensitivity_class: 'product-safe',
          import_status: 'promoted',
          required_features_json: JSON.stringify(['evidence.bundle.v1']),
        }),
      ]);
      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toMatchObject([
        {
          workspaceId: 'ws_demo',
          backendType: 'openshell',
          backendVersion: '0.0.63',
          placement: 'unknown',
          phase: 'capability-negotiation',
          summary: 'Workspace materialization recorded: strategy git, backend openshell',
          policyDigest: 'sha256:policy',
          capabilitySummary: 'backend.ready',
          outcome: 'succeeded',
          contentDigests: ['sha256:policy'],
          requiredFeatures: ['runtime.evidence.v1'],
          createdAt: timestamp,
          collectedAt: timestamp,
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records redacted backend workspace handles with materialization records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-backend-handle-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        {
          backendKind: 'openshell',
          cleanupStatus: 'pending',
          createdAt: timestamp,
          id: 'bwh_wmr_1',
          materializationRecordId: 'wmr_1',
          retention: 'until-reconciliation',
          transportRefs: [{ kind: 'materialized-root', ref: 'workspace://ws_demo/repo_default' }],
          updatedAt: timestamp,
          workerSessionId: 'session_1',
          workspaceId: 'ws_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('marks backend workspace handles retained from transport events without downgrading cleanup', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-backend-retained-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);

      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        'session_1',
        'retained',
        '2026-07-05T00:01:00.000Z'
      );
      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          cleanupStatus: 'retained',
          updatedAt: '2026-07-05T00:01:00.000Z',
        }),
      ]);

      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        'session_1',
        'cleaned',
        '2026-07-05T00:02:00.000Z'
      );
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        'session_1',
        'retained',
        '2026-07-05T00:03:00.000Z'
      );

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          cleanupStatus: 'cleaned',
          updatedAt: '2026-07-05T00:03:00.000Z',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records worker output manifests before workspace change sets are reviewed', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-output-manifest-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      expect(listWorkerOutputManifests(workspaceDb, 'ws_demo')).toEqual([
        {
          artifactIds: ['ar_workspace_review'],
          backendKind: 'openshell',
          changedPaths: [{ binary: false, path: 'docs/loop.md', status: 'modified' }],
          collectedAt: timestamp,
          evidenceRefs: [{ kind: 'worker', ref: 'turn_1' }],
          id: 'wom_wcs_1',
          ignoredOutputs: [],
          inputSnapshotId: 'wis_1',
          logRefs: [],
          materializationRecordId: 'wmr_1',
          strategy: 'git',
          testOutputRefs: [],
          workerSessionId: 'wmr_1',
          workspaceId: 'ws_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('returns the stored input snapshots and materialization records on exact replay', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-record-return-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });
      const snapshots = listWorkspaceInputSnapshots(workspaceDb, 'ws_demo');
      const materializations = listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo');

      expect(recordWorkspaceInputSnapshots(workspaceDb, snapshots)).toEqual(snapshots);
      expect(recordWorkspaceMaterializationRecords(workspaceDb, materializations)).toEqual(
        materializations
      );
      expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual(snapshots);
      expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual(materializations);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('treats an identical workspace sync import as a no-op', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-import-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });
      const stored = listExportableWorkspaceSyncRecords(workspaceDb, 'ws_demo');

      importWorkspaceSyncRecords(workspaceDb, stored);

      expect(listExportableWorkspaceSyncRecords(workspaceDb, 'ws_demo')).toEqual(stored);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects imported review lineage that does not match its change set before writing', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-import-lineage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const input = workspaceSyncImportFixture();
      const stagedReview = input.stagedReviews[0];
      expect(stagedReview).toBeDefined();

      expect(() =>
        importWorkspaceSyncRecords(workspaceDb, {
          ...input,
          stagedReviews: stagedReview
            ? [
                {
                  ...stagedReview,
                  review: { ...stagedReview.review, changeSetId: 'wcs_other' },
                },
              ]
            : [],
        })
      ).toThrow(/lineage|mismatch|conflict/i);
      expect(listExportableWorkspaceSyncRecords(workspaceDb, 'ws_demo')).toEqual({
        backendWorkspaceHandles: [],
        changeSets: [],
        inputSnapshots: [],
        materializationRecords: [],
        stagedReviews: [],
        workerOutputManifests: [],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    {
      field: 'input snapshot',
      replay: () => {
        const input = workspaceSyncImportFixture();

        return {
          ...input,
          inputSnapshots: input.inputSnapshots.map((snapshot) => ({
            ...snapshot,
            ignoredPaths: ['temp/private'],
          })),
        };
      },
    },
    {
      field: 'materialization record',
      replay: () => {
        const input = workspaceSyncImportFixture();

        return {
          ...input,
          materializationRecords: input.materializationRecords.map((record) => ({
            ...record,
            policyDigest: 'sha256:different-policy',
          })),
        };
      },
    },
    {
      field: 'worker output manifest',
      replay: () => {
        const input = workspaceSyncImportFixture();

        return {
          ...input,
          workerOutputManifests: input.workerOutputManifests.map((manifest) => ({
            ...manifest,
            artifactIds: ['ar_other'],
          })),
        };
      },
    },
    {
      field: 'staged workspace review',
      replay: () => {
        const input = workspaceSyncImportFixture();

        return {
          ...input,
          stagedReviews: input.stagedReviews.map((review) => ({
            ...review,
            artifactId: 'ar_other',
          })),
        };
      },
    },
  ])('rejects a conflicting $field during workspace sync import', ({ replay }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-import-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const original = workspaceSyncImportFixture();
      importWorkspaceSyncRecords(workspaceDb, original);

      expect(() => importWorkspaceSyncRecords(workspaceDb, replay())).toThrow(/conflict/i);
      expect(listExportableWorkspaceSyncRecords(workspaceDb, 'ws_demo')).toEqual(original);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

/**
 * Builds a minimal schema-valid workspace review item.
 *
 * @returns Workspace review item test fixture.
 */
function workspaceReviewItem(): Parameters<typeof recordWorkspaceSyncReview>[1]['item'] {
  return {
    artifactId: 'ar_workspace_review',
    changeSet: {
      artifactIds: ['ar_workspace_review'],
      base: { commit: 'abc123', contentDigest: null },
      bundle: null,
      changedPaths: [{ binary: false, path: 'docs/loop.md', status: 'modified' }],
      createdAt: timestamp,
      evidenceRefs: [{ kind: 'worker', ref: 'turn_1' }],
      head: { commit: 'def456', contentDigest: null },
      id: 'wcs_1',
      inputSnapshotId: 'wis_1',
      materializationRecordId: 'wmr_1',
      patch: {
        bytes: Buffer.byteLength(workspacePatchText, 'utf8'),
        digest: workspacePatchDigest,
        ref: 'artifact://patch',
      },
      redaction: { notes: [], status: 'redacted' },
      resourceId: 'repo_default',
      strategy: 'git',
      workspaceId: 'ws_demo',
    },
    patchPayload: {
      bytes: Buffer.byteLength(workspacePatchText, 'utf8'),
      digest: workspacePatchDigest,
      mediaType: 'text/x-diff',
      text: workspacePatchText,
    },
    review: {
      actionCenterRowId: 'workspace-review:swr_1',
      changeSetId: 'wcs_1',
      createdAt: timestamp,
      diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
      id: 'swr_1',
      riskSummary: '1 changed path staged for human review.',
      staging: {
        branch: 'openkit/review/swr_1',
        ref: 'staging://workspace/wcs_1',
        strategy: 'git_worktree',
      },
      status: 'pending',
      updatedAt: timestamp,
      validation: [],
      workspaceId: 'ws_demo',
    },
  };
}

/**
 * Builds a materialization record carrying catalog source lineage.
 *
 * @returns Workspace materialization record test fixture.
 */
function workspaceMaterializationRecord(): Parameters<
  typeof recordWorkspaceMaterializationRecords
>[1][number] {
  return {
    backendKind: 'openshell',
    base: { commit: 'abc123', contentDigest: null },
    createdAt: timestamp,
    id: 'wmr_1',
    inputSnapshotId: 'wis_1',
    materializedRootRef: 'workspace://ws_demo/repo_default',
    policyDigest: 'sha256:policy',
    readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.63' }],
    sourceId: 'repo_default',
    strategy: 'git',
    workerSessionId: 'session_1',
    workspaceId: 'ws_demo',
  };
}

/**
 * Builds a complete schema-valid workspace synchronization import fixture.
 *
 * @returns Workspace synchronization import fixture.
 */
function workspaceSyncImportFixture(): Parameters<typeof importWorkspaceSyncRecords>[1] {
  const item = workspaceReviewItem();
  const materializationRecord = workspaceMaterializationRecord();

  return {
    backendWorkspaceHandles: [
      {
        backendKind: 'openshell',
        cleanupStatus: 'pending',
        createdAt: timestamp,
        id: 'bwh_wmr_1',
        materializationRecordId: materializationRecord.id,
        retention: 'until-reconciliation',
        transportRefs: [
          { kind: 'materialized-root', ref: materializationRecord.materializedRootRef },
        ],
        updatedAt: timestamp,
        workerSessionId: materializationRecord.workerSessionId,
        workspaceId: 'ws_demo',
      },
    ],
    changeSets: [item.changeSet],
    inputSnapshots: [
      {
        backend: {
          capabilitySummary: [],
          kind: 'openshell',
          label: 'test backend',
        },
        base: item.changeSet.base,
        createdAt: timestamp,
        generatedFiles: [],
        id: 'wis_1',
        ignoredPaths: [],
        pathScope: ['repo_default'],
        resourceId: 'repo_default',
        resourceKind: 'git_repository',
        sourceId: 'repo_default',
        strategy: 'git',
        workspaceId: 'ws_demo',
        writableRoots: ['repo_default'],
      },
    ],
    materializationRecords: [materializationRecord],
    stagedReviews: [
      {
        artifactId: item.artifactId,
        patchPayload: item.patchPayload,
        review: item.review,
      },
    ],
    workerOutputManifests: [
      {
        artifactIds: item.changeSet.artifactIds,
        backendKind: materializationRecord.backendKind,
        changedPaths: item.changeSet.changedPaths,
        collectedAt: timestamp,
        evidenceRefs: item.changeSet.evidenceRefs,
        id: 'wom_wcs_1',
        ignoredOutputs: [],
        inputSnapshotId: 'wis_1',
        logRefs: [],
        materializationRecordId: 'wmr_1',
        strategy: 'git',
        testOutputRefs: [],
        workerSessionId: materializationRecord.workerSessionId,
        workspaceId: 'ws_demo',
      },
    ],
  };
}
