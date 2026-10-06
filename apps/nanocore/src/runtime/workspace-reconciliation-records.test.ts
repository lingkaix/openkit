import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  listWorkspaceReconciliationRecords,
  recordWorkspaceReconciliationRecord,
  resolveWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';

const timestamp = '2026-07-08T00:00:00.000Z';

describe('workspace reconciliation records', () => {
  it('preserves retained annotations and unchanged bytes through updates, recovery and reopening', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-reconciliation-extensions-'));
    let db = openWorkspaceDb(dataRoot, 'ws_demo');
    try {
      applyScopedMigrations(db);
      const original = recordWorkspaceReconciliationRecord(db, workspaceReconciliationRecord());
      const extended = {
        ...original,
        futureAnnotation: { note: 'same owner', text: 'retained\nbytes' },
        backendReachability: {
          ...original.backendReachability,
          futureAnnotation: ['retained observation'],
        },
      };
      const payload = JSON.stringify(extended, null, 2);
      db.sqlite
        .prepare('UPDATE workspace_reconciliation_records SET payload_json = ?')
        .run(payload);
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(listWorkspaceReconciliationRecords(db, 'ws_demo')).toEqual([original]);
      recordWorkspaceReconciliationRecord(db, original);
      expect(
        db.sqlite.prepare('SELECT payload_json FROM workspace_reconciliation_records').get()
      ).toEqual({ payload_json: payload });
      const inspected = {
        ...original,
        backendReachability: { ...original.backendReachability, detail: 'Inspected' },
      };
      recordWorkspaceReconciliationRecord(db, inspected);
      const inspectedRow = db.sqlite
        .prepare('SELECT payload_json FROM workspace_reconciliation_records')
        .get() as { payload_json: string };
      expect(JSON.parse(inspectedRow.payload_json)).toEqual({
        ...extended,
        backendReachability: { ...extended.backendReachability, detail: 'Inspected' },
      });
      const recovered = resolveWorkspaceReconciliationRecord({
        workspaceDb: db,
        workspaceId: 'ws_demo',
        reconciliationRecordId: original.id,
        decision: 'resume_collection',
        decidedAt: '2026-07-08T00:10:00.000Z',
        workerOutputManifests: [
          {
            id: 'wom_new',
            workspaceId: 'ws_demo',
            materializationRecordId: 'wmr_1',
            inputSnapshotId: 'wis_1',
            workerSessionId: 'session_1',
            backendKind: 'openshell',
            strategy: 'git',
            changedPaths: [],
            artifactIds: [],
            logRefs: [],
            testOutputRefs: [],
            ignoredOutputs: [],
            evidenceRefs: [],
            collectedAt: timestamp,
          },
        ],
      });
      expect(recovered.stateAfter).toBe('recovered');
      expect(recovered.backendReachability.status).toBe('unknown');
      expect(JSON.stringify(recovered)).not.toContain('futureAnnotation');
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(listWorkspaceReconciliationRecords(db, 'ws_demo')).toEqual([recovered]);
      const row = db.sqlite
        .prepare('SELECT payload_json FROM workspace_reconciliation_records')
        .get() as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toEqual({
        ...extended,
        ...recovered,
        backendReachability: { ...extended.backendReachability, ...recovered.backendReachability },
      });
      for (const change of [
        { stateAfter: 'future' },
        { triggerReason: 'future' },
        { retentionDecision: 'future' },
        { backendReachability: { ...extended.backendReachability, status: 'future' } },
      ]) {
        db.sqlite
          .prepare('UPDATE workspace_reconciliation_records SET payload_json = ?')
          .run(JSON.stringify({ ...extended, ...change }));
        expect(() => listWorkspaceReconciliationRecords(db, 'ws_demo')).toThrow();
        expect(() => recordWorkspaceReconciliationRecord(db, original)).toThrow();
      }
    } finally {
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('records durable reconciliation state transitions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-reconciliation-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      recordWorkspaceReconciliationRecord(workspaceDb, workspaceReconciliationRecord());
      recordWorkspaceReconciliationRecord(workspaceDb, {
        ...workspaceReconciliationRecord(),
        stateAfter: 'recovered',
        finishedAt: timestamp,
      });

      expect(listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo')).toMatchObject([
        {
          id: 'wrr_1',
          workspaceId: 'ws_demo',
          triggerReason: 'restart',
          affectedRecordIds: ['wmr_1', 'bwh_1'],
          backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
          collectedOutputManifestIds: ['wom_1'],
          evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
          stateBefore: 'ready',
          stateAfter: 'recovered',
          retentionDecision: 'teardown-backend',
          finishedAt: timestamp,
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('maps human recovery decisions to terminal state and backend teardown decisions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-reconciliation-decision-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const decidedAt = '2026-07-08T00:05:00.000Z';

    try {
      applyScopedMigrations(workspaceDb);

      recordWorkspaceReconciliationRecord(workspaceDb, {
        ...workspaceReconciliationRecord(),
        id: 'wrr_stage_verified',
        retentionDecision: 'retain-backend',
      });
      recordWorkspaceReconciliationRecord(workspaceDb, {
        ...workspaceReconciliationRecord(),
        id: 'wrr_quarantine',
        retentionDecision: 'retain-backend',
      });
      recordWorkspaceReconciliationRecord(workspaceDb, {
        ...workspaceReconciliationRecord(),
        id: 'wrr_abandon',
        retentionDecision: 'retain-backend',
      });

      expect(
        resolveWorkspaceReconciliationRecord({
          decidedAt,
          decision: 'stage_verified',
          reconciliationRecordId: 'wrr_stage_verified',
          workspaceDb,
          workspaceId: 'ws_demo',
        })
      ).toMatchObject({
        finishedAt: decidedAt,
        requiredHumanDecision: null,
        retentionDecision: 'teardown-backend',
        stateAfter: 'recovered',
        stateBefore: 'requires-human',
      });
      expect(
        resolveWorkspaceReconciliationRecord({
          decidedAt,
          decision: 'quarantine',
          reconciliationRecordId: 'wrr_quarantine',
          workspaceDb,
          workspaceId: 'ws_demo',
        })
      ).toMatchObject({
        finishedAt: decidedAt,
        requiredHumanDecision: null,
        retentionDecision: 'teardown-backend',
        stateAfter: 'quarantined',
        stateBefore: 'requires-human',
      });
      expect(
        resolveWorkspaceReconciliationRecord({
          decidedAt,
          decision: 'abandon',
          reconciliationRecordId: 'wrr_abandon',
          workspaceDb,
          workspaceId: 'ws_demo',
        })
      ).toMatchObject({
        finishedAt: decidedAt,
        requiredHumanDecision: null,
        retentionDecision: 'teardown-backend',
        stateAfter: 'unrecoverable',
        stateBefore: 'requires-human',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('resumes recovery collection from durable output manifests and retained evidence ids', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-reconciliation-resume-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const decidedAt = '2026-07-08T00:10:00.000Z';

    try {
      applyScopedMigrations(workspaceDb);

      recordWorkspaceReconciliationRecord(workspaceDb, {
        ...workspaceReconciliationRecord(),
        collectedOutputManifestIds: [],
        evidenceBundleIds: ['evb_workspace_materialization_wmr_1', 'evb_workspace_review_resume'],
        id: 'wrr_resume',
        retentionDecision: 'retain-backend',
      });

      expect(
        resolveWorkspaceReconciliationRecord({
          decidedAt,
          decision: 'resume_collection',
          reconciliationRecordId: 'wrr_resume',
          workspaceDb,
          workspaceId: 'ws_demo',
          workerOutputManifests: [
            {
              artifactIds: ['ar_resume'],
              backendKind: 'openshell',
              changedPaths: [{ binary: false, path: 'README.md', status: 'modified' }],
              collectedAt: timestamp,
              evidenceRefs: [{ kind: 'worker', ref: 'turn_resume' }],
              id: 'wom_resume',
              ignoredOutputs: [],
              inputSnapshotId: 'wis_1',
              logRefs: [],
              materializationRecordId: 'wmr_1',
              strategy: 'git',
              testOutputRefs: [],
              workerSessionId: 'session_1',
              workspaceId: 'ws_demo',
            },
          ],
        })
      ).toMatchObject({
        backendReachability: {
          detail:
            'Recovered from durable worker output manifests; live backend reachability was not required.',
          status: 'unknown',
        },
        collectedOutputManifestIds: ['wom_resume'],
        evidenceBundleIds: ['evb_workspace_materialization_wmr_1', 'evb_workspace_review_resume'],
        finishedAt: decidedAt,
        requiredHumanDecision: null,
        retentionDecision: 'teardown-backend',
        stateAfter: 'recovered',
        stateBefore: 'requires-human',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects resume collection when no durable output manifest matches the recovery record', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-reconciliation-resume-empty-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceReconciliationRecord(workspaceDb, {
        ...workspaceReconciliationRecord(),
        collectedOutputManifestIds: [],
        id: 'wrr_resume_empty',
      });

      expect(() =>
        resolveWorkspaceReconciliationRecord({
          decidedAt: '2026-07-08T00:15:00.000Z',
          decision: 'resume_collection',
          reconciliationRecordId: 'wrr_resume_empty',
          workspaceDb,
          workspaceId: 'ws_demo',
          workerOutputManifests: [],
        })
      ).toThrow('Workspace recovery collection has no durable output manifest');
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

/** Returns one product-safe workspace reconciliation record. */
function workspaceReconciliationRecord() {
  return {
    id: 'wrr_1',
    workspaceId: 'ws_demo',
    triggerReason: 'restart',
    affectedRecordIds: ['wmr_1', 'bwh_1'],
    backendHandleSummary: {
      backendKind: 'openshell',
      handleId: 'bwh_1',
      workerSessionId: 'session_1',
      cleanupStatus: 'pending',
    },
    backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
    collectedOutputManifestIds: ['wom_1'],
    evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
    stateBefore: 'ready',
    stateAfter: 'requires-human',
    quarantineRefs: [],
    requiredHumanDecision: 'inspect_recovery',
    retentionDecision: 'teardown-backend',
    startedAt: timestamp,
    finishedAt: null,
  };
}
