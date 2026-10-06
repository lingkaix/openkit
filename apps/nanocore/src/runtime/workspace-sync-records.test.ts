import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schemas from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import { buildWorkspaceMaterializationRecords } from './workspace-materializer.js';
import { parseWorkspaceSyncReviewArtifact } from './workspace-review-application.js';
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
  it('preserves public fixture literals through canonical records, patch Artifacts and reopened public reads', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-sync-public-fixture-'));
    const store = createDemoStore({ dataRoot });
    let db = openWorkspaceDb(dataRoot, 'ws_demo');
    const fixture = workspaceSyncImportFixture();
    const literal = 'ghp_publicFixture sk-Latn hf_publicFixture okt_publicFixture';
    const text = `diff --git a/src/fixture.ts b/src/fixture.ts\n--- a/src/fixture.ts\n+++ b/src/fixture.ts\n@@ -0,0 +1 @@\n+${literal}\n`;
    const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    const bytes = Buffer.byteLength(text);
    fixture.inputSnapshots[0]!.backend.label = literal;
    fixture.materializationRecords[0]!.readinessEvidence[0]!.ref = literal;
    fixture.backendWorkspaceHandles[0]!.transportRefs[0]!.ref = literal;
    fixture.workerOutputManifests[0]!.ignoredOutputs.push({
      path: 'src/ghp_publicFixture.ts',
      reason: literal,
    });
    fixture.changeSets[0]!.redaction.notes.push(literal);
    fixture.changeSets[0]!.patch = { ...fixture.changeSets[0]!.patch!, digest, bytes };
    fixture.stagedReviews[0]!.review.riskSummary = literal;
    fixture.stagedReviews[0]!.review.validation.push({
      command: literal,
      status: 'passed',
      ref: literal,
    });
    fixture.stagedReviews[0]!.patchPayload = { mediaType: 'text/x-diff', text, digest, bytes };
    try {
      applyScopedMigrations(db);
      importWorkspaceSyncRecords(db, fixture);
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, 'ws_demo');
      const read = listExportableWorkspaceSyncRecords(db, 'ws_demo');
      expect(read).toEqual(fixture);
      for (const [schema, records] of [
        [schemas.ListWorkspaceInputSnapshotsResponseSchema, read.inputSnapshots],
        [schemas.ListWorkspaceMaterializationRecordsResponseSchema, read.materializationRecords],
        [schemas.ListBackendWorkspaceHandlesResponseSchema, read.backendWorkspaceHandles],
        [schemas.ListWorkerOutputManifestsResponseSchema, read.workerOutputManifests],
        [schemas.ListWorkspaceChangeSetsResponseSchema, read.changeSets],
      ] as const)
        expect(schema.parse({ items: records })).toEqual({ items: records });
      const item = getWorkspaceSyncReview(db, 'ws_demo', fixture.stagedReviews[0]!.review.id)!;
      expect(
        schemas.ListWorkspaceSyncReviewsResponseSchema.parse({ items: [item] }).items[0]
      ).toEqual(item);
      expect(item.patchPayload).toEqual({ mediaType: 'text/x-diff', text, digest, bytes });
      const body = JSON.stringify(item);
      const artifactDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
      store.createArtifact({
        id: item.artifactId,
        workspaceId: 'ws_demo',
        threadId: null,
        turnId: null,
        kind: 'file',
        title: 'Workspace patch fixture',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'json', body },
        contentDigest: artifactDigest,
        lastMutationRequestId: 'fixture-patch-artifact',
        origin: {
          kind: 'imported',
          sourceKind: 'direct-import',
          sourceId: 'fixture-patch-artifact',
          sourceDigest: artifactDigest,
          actor: { kind: 'user', id: 'user_local' },
          requestId: 'fixture-patch-artifact',
          recordedAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const artifact = new FsStore({ dataRoot }).getArtifact('ws_demo', item.artifactId);
      expect(artifact.content.body).toBe(body);
      expect(artifact.contentDigest).toBe(artifactDigest);
      expect(`sha256:${createHash('sha256').update(artifact.content.body).digest('hex')}`).toBe(
        artifactDigest
      );
      expect(parseWorkspaceSyncReviewArtifact(artifact)).toEqual(item);

      const patchBytes = schemas.workspaceSyncReviewPatchBytes(item.patchPayload!);
      expect(Buffer.from(patchBytes).toString()).toBe(text);
      expect(`sha256:${createHash('sha256').update(patchBytes).digest('hex')}`).toBe(digest);
      importWorkspaceSyncRecords(db, fixture);
      expect(listExportableWorkspaceSyncRecords(db, 'ws_demo')).toEqual(read);
    } finally {
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('reads extended retained payloads, preserves replay bytes and mutable annotations after reopen', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-sync-extensions-'));
    let db = openWorkspaceDb(dataRoot, 'ws_demo');
    const fixture = workspaceSyncImportFixture();
    fixture.inputSnapshots[0]!.generatedFiles.push({ id: 'generated', target: 'generated.txt' });
    fixture.workerOutputManifests[0]!.logRefs.push({
      kind: 'log',
      ref: 'log://one',
      digest: 'sha256:log',
      bytes: 3,
    });
    fixture.workerOutputManifests[0]!.testOutputRefs.push({
      kind: 'test',
      ref: 'test://one',
      digest: 'sha256:test',
      bytes: 4,
    });
    fixture.workerOutputManifests[0]!.ignoredOutputs.push({
      path: 'ignored.txt',
      reason: 'ignored',
    });
    fixture.stagedReviews[0]!.review.validation.push({
      command: 'test',
      status: 'passed',
      ref: null,
    });
    fixture.changeSets[0]!.bundle = { ref: 'bundle://one', digest: 'sha256:bundle', bytes: 5 };
    fixture.changeSets[0]!.changedPaths[0]!.binaryReview = {
      mode: 'artifact-only',
      reason: 'binary-path',
      summary: 'Binary',
      digest: null,
      mediaType: null,
      bytes: null,
    };
    fixture.workerOutputManifests[0]!.changedPaths = fixture.changeSets[0]!.changedPaths;
    const tables = [
      'workspace_input_snapshots',
      'workspace_materialization_records',
      'backend_workspace_handles',
      'worker_output_manifests',
      'workspace_change_sets',
      'staged_workspace_reviews',
    ];
    try {
      applyScopedMigrations(db);
      importWorkspaceSyncRecords(db, fixture);
      const baseline = listExportableWorkspaceSyncRecords(db, 'ws_demo');
      const retained = new Map<string, string>();
      for (const table of tables) {
        const row = db.sqlite.prepare(`SELECT payload_json FROM ${table}`).get() as {
          payload_json: string;
        };
        const json = JSON.stringify(annotateDescriptiveObjects(JSON.parse(row.payload_json)));
        db.sqlite.prepare(`UPDATE ${table} SET payload_json = ?`).run(json);
        retained.set(table, json);
      }
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, 'ws_demo');
      const read = listExportableWorkspaceSyncRecords(db, 'ws_demo');
      expect(JSON.stringify(read)).not.toContain('futureAnnotation');
      expect(read).toEqual(baseline);
      importWorkspaceSyncRecords(db, fixture);
      for (const table of tables) {
        expect(db.sqlite.prepare(`SELECT payload_json FROM ${table}`).get()).toEqual({
          payload_json: retained.get(table),
        });
      }
      updateWorkspaceSyncReviewDecision(db, {
        workspaceId: 'ws_demo',
        reviewId: 'swr_1',
        status: 'accepted',
        requestId: 'decision_extensions',
        updatedAt: '2026-07-05T00:01:00.000Z',
      });
      updateBackendWorkspaceHandleCleanupStatus(
        db,
        'ws_demo',
        'aepsnap_1',
        'retained',
        '2026-07-05T00:01:00.000Z'
      );
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(getWorkspaceSyncReview(db, 'ws_demo', 'swr_1')?.review.status).toBe('accepted');
      expect(listBackendWorkspaceHandles(db, 'ws_demo')[0]?.cleanupStatus).toBe('retained');
      for (const table of ['backend_workspace_handles', 'staged_workspace_reviews']) {
        const row = db.sqlite.prepare(`SELECT payload_json FROM ${table}`).get() as {
          payload_json: string;
        };
        const original = JSON.parse(retained.get(table)!);
        const rewritten = JSON.parse(row.payload_json);
        expect(rewritten).toEqual({
          ...original,
          ...(table === 'staged_workspace_reviews'
            ? { status: 'accepted' }
            : { cleanupStatus: 'retained' }),
          updatedAt: '2026-07-05T00:01:00.000Z',
        });
      }
      expect(JSON.stringify(listExportableWorkspaceSyncRecords(db, 'ws_demo'))).not.toContain(
        'futureAnnotation'
      );
    } finally {
      db.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('refuses corrupted retained patch bytes after normalizing descriptive metadata', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-sync-corrupt-retained-'));
    const db = openWorkspaceDb(dataRoot, 'ws_demo');
    try {
      applyScopedMigrations(db);
      importWorkspaceSyncRecords(db, workspaceSyncImportFixture());
      const row = db.sqlite
        .prepare('SELECT patch_payload_json FROM staged_workspace_reviews')
        .get() as { patch_payload_json: string };
      const patch = JSON.parse(row.patch_payload_json);
      db.sqlite
        .prepare('UPDATE staged_workspace_reviews SET patch_payload_json = ?')
        .run(JSON.stringify({ ...patch, text: `${patch.text}corrupt`, futureAnnotation: true }));
      expect(() => getWorkspaceSyncReview(db, 'ws_demo', 'swr_1')).toThrow(
        /patch integrity conflict/
      );
    } finally {
      db.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects reviews without persisted input snapshot lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-missing-input-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      expect(() => recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() })).toThrow(
        'Workspace synchronization input lineage is missing: wis_1'
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects reviews without persisted materialization lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-missing-lineage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceInputSnapshots(workspaceDb, [workspaceInputSnapshot()]);
      expect(() => recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() })).toThrow(
        'Workspace synchronization materialization lineage is missing: wmr_1'
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records one linked audit event when a staged review is first stored', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-review-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceInputSnapshots(workspaceDb, [workspaceInputSnapshot()]);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);

      const item = recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      expect(item.changeSet.sourceId).toBe('repo_default');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('treats an identical workspace change set replay as a no-op', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-change-set-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
      recordWorkspaceSyncReview(workspaceDb, { item: workspaceReviewItem() });

      expect(() => recordWorkspaceSyncReview(workspaceDb, { item: replay() })).toThrow(/conflict/i);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('preserves a terminal review decision when staging evidence is replayed', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sync-terminal-review-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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

  it('repairs an interrupted materialization handoff on exact replay', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-materialization-replay-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const materialization = productionWorkspaceMaterializationRecord(
        'aepsnap_crash_replay',
        'sandbox_crash_replay'
      );
      workspaceDb.sqlite
        .prepare(
          `INSERT INTO workspace_materialization_records (
            materialization_record_id,
            workspace_id,
            input_snapshot_id,
            package_snapshot_id,
            worker_session_id,
            strategy,
            payload_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          materialization.id,
          materialization.workspaceId,
          materialization.inputSnapshotId,
          materialization.packageSnapshotId,
          materialization.workerSessionId,
          materialization.strategy,
          JSON.stringify(materialization),
          materialization.createdAt,
          materialization.createdAt
        );

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([]);
      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toEqual([]);

      expect(recordWorkspaceMaterializationRecords(workspaceDb, [materialization])).toEqual([
        materialization,
      ]);
      recordWorkspaceMaterializationRecords(workspaceDb, [materialization]);

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          materializationRecordId: materialization.id,
          packageSnapshotId: 'aepsnap_crash_replay',
          workerSessionId: 'sandbox_crash_replay',
        }),
      ]);
      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          agentSessionId: 'sandbox_crash_replay',
          evidenceBundleIds: [`evb_workspace_materialization_${materialization.id}`],
        }),
      ]);
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT evidence_bundle_id
             FROM evidence_bundles
             WHERE evidence_bundle_id = ?`
          )
          .all(`evb_workspace_materialization_${materialization.id}`)
      ).toEqual([{ evidence_bundle_id: `evb_workspace_materialization_${materialization.id}` }]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rolls back the complete materialization handoff when derived evidence fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-materialization-atomic-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const primarySnapshot = workspaceInputSnapshot();
      const materializations = buildWorkspaceMaterializationRecords({
        createdAt: timestamp,
        inputSnapshots: [
          primarySnapshot,
          {
            ...primarySnapshot,
            id: 'wis_atomic_secondary',
            pathScope: ['repo_secondary'],
            resourceId: 'repo_secondary',
            sourceId: 'repo_secondary',
            writableRoots: ['repo_secondary'],
          },
        ],
        materialization: {
          backendKind: 'openshell',
          backendStatus: { health: 'ready', version: '0.0.80' },
          packageSnapshotId: 'aepsnap_atomic_failure',
          requiredCapabilities: ['container', 'workspace-sync'],
          sandbox: { name: 'sandbox_atomic_failure', state: 'created' },
          workspaceInputs: [
            { id: 'repo_default', target: '/workspace/openkit' },
            { id: 'repo_secondary', target: '/workspace/secondary' },
          ],
        },
      });
      expect(materializations).toHaveLength(2);
      workspaceDb.sqlite.exec(
        `CREATE TRIGGER reject_materialization_evidence
         BEFORE INSERT ON evidence_bundles
         WHEN NEW.evidence_bundle_id = 'evb_workspace_materialization_wmr_aepsnap_atomic_failure_repo_secondary'
         BEGIN
           SELECT RAISE(ABORT, 'simulated evidence write failure');
         END`
      );

      expect(() => recordWorkspaceMaterializationRecords(workspaceDb, materializations)).toThrow(
        'simulated evidence write failure'
      );

      expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual([]);
      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([]);
      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records redacted backend workspace handles with materialization records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-backend-handle-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
          packageSnapshotId: 'aepsnap_1',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);

      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        'aepsnap_1',
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
        'aepsnap_1',
        'cleaned',
        '2026-07-05T00:02:00.000Z'
      );
      updateBackendWorkspaceHandleCleanupStatus(
        workspaceDb,
        'ws_demo',
        'aepsnap_1',
        'retained',
        '2026-07-05T00:03:00.000Z'
      );
      recordWorkspaceMaterializationRecords(workspaceDb, [workspaceMaterializationRecord()]);

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          cleanupStatus: 'cleaned',
          updatedAt: '2026-07-05T00:02:00.000Z',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records worker output manifests before workspace change sets are reviewed', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-output-manifest-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
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
          workerSessionId: 'sandbox_test_wmr_1',
          workspaceId: 'ws_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('returns the stored input snapshots and materialization records on exact replay', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-record-return-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReviewItem());
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
 * Builds the trusted input snapshot required by review fixtures.
 *
 * @returns Workspace input snapshot test fixture.
 */
function workspaceInputSnapshot(): Parameters<typeof recordWorkspaceInputSnapshots>[1][number] {
  return {
    backend: {
      capabilitySummary: [],
      kind: 'openshell',
      label: 'test backend',
    },
    base: { commit: 'abc123', contentDigest: null },
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
    packageSnapshotId: 'aepsnap_1',
    policyDigest: 'sha256:policy',
    readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.63' }],
    sourceId: 'repo_default',
    strategy: 'git',
    workerSessionId: 'session_1',
    workspaceId: 'ws_demo',
  };
}

/**
 * Builds one schema-valid materialization through the production record builder.
 *
 * @param packageSnapshotId Package snapshot that owns the materialization.
 * @param workerSessionId Backend sandbox session id.
 * @returns Production-built materialization record.
 * @throws Error when the builder unexpectedly produces no record.
 */
function productionWorkspaceMaterializationRecord(
  packageSnapshotId: string,
  workerSessionId: string
): ReturnType<typeof buildWorkspaceMaterializationRecords>[number] {
  const [materialization] = buildWorkspaceMaterializationRecords({
    createdAt: timestamp,
    inputSnapshots: [workspaceInputSnapshot()],
    materialization: {
      backendKind: 'openshell',
      backendStatus: { health: 'ready', version: '0.0.80' },
      packageSnapshotId,
      requiredCapabilities: ['container', 'workspace-sync'],
      sandbox: { name: workerSessionId, state: 'created' },
      workspaceInputs: [{ id: 'repo_default', target: '/workspace/openkit' }],
    },
  });
  if (!materialization) {
    throw new Error('Expected one production-built materialization record.');
  }
  return materialization;
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
        packageSnapshotId: materializationRecord.packageSnapshotId,
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

/** Adds an inert annotation to every descriptive object in a retained test payload. */
function annotateDescriptiveObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(annotateDescriptiveObjects);
  if (value && typeof value === 'object')
    return Object.fromEntries([
      ...Object.entries(value).map(([key, child]) => [key, annotateDescriptiveObjects(child)]),
      ['futureAnnotation', 'retained'],
    ]);
  return value;
}
