import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import {
  listBackendWorkspaceHandles,
  listWorkerOutputManifests,
  recordWorkspaceMaterializationRecords,
  recordWorkspaceSyncReview,
  updateBackendWorkspaceHandleCleanupStatus,
} from './workspace-sync-records.js';

const timestamp = '2026-07-05T00:00:00.000Z';

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
            import_status
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
          content_digests_json: JSON.stringify(['sha256:patch']),
          import_status: 'promoted',
        }),
      ]);
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
            import_status
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
          import_status: 'promoted',
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
      patch: { bytes: 42, digest: 'sha256:patch', ref: 'artifact://patch' },
      redaction: { notes: [], status: 'redacted' },
      resourceId: 'repo_default',
      strategy: 'git',
      workspaceId: 'ws_demo',
    },
    patchPayload: {
      bytes: 42,
      digest: 'sha256:patch',
      mediaType: 'text/x-diff',
      text: 'diff --git a/docs/loop.md b/docs/loop.md\n',
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
