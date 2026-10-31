import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListWorkspaceReconciliationRecordsResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { nanoHostSandboxIdFromBackendSessionId } from './nanohost-effect-identity.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import { recordWorkerBackendSessionMaterializing } from './worker-backend-sessions.js';
import { workerStorageScopeDigest } from './worker-storage-bindings.js';
import {
  completeWorkspaceCaptureRecovery,
  importWorkspaceReconciliationRecords,
  listWorkspaceReconciliationRecords,
  recordWorkspaceCaptureRecovery,
  recordWorkspaceReconciliationRecord,
  resolveWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';
import {
  acceptWorkspaceBaseline,
  acceptWorkspaceCapture,
  authorizeWorkspaceBaselineInitialization,
  type RawWorkspaceCapture,
  readWorkspaceCollection,
  type WorkspaceCollectionIdentity,
} from './workspace-snapshot-chain.js';

const timestamp = '2026-07-08T00:00:00.000Z';

describe('workspace reconciliation records', () => {
  it.each([
    'conflicting',
    'matching',
    'empty',
  ] as const)('resolves absent-source capture recovery only from an exact receipt (%s)', (receiptKind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-receipt-'));
    const coreDb = openCoreDb(dataRoot);
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      applyMigrations(coreDb);
      applyScopedMigrations(db, undefined, 'pre-knowledge');
      const packageSnapshotId = 'package';
      const packageDigest = createHash('sha256').update(packageSnapshotId).digest('hex');
      const backendSessionId = `nh-${'1'.repeat(16)}-${packageDigest.slice(0, 16)}`;
      const identity: WorkspaceCollectionIdentity = {
        workspaceId: db.workspaceId,
        threadId: testEntityId('th', 'capture-receipt'),
        turnId: testEntityId('tu', 'capture-receipt'),
        agentSessionId: testEntityId('as', 'capture-receipt'),
        storageRef: testEntityId('wst', 'capture-receipt'),
        scopeDigest: workerStorageScopeDigest(db.workspaceId),
        attachmentGeneration: 1,
        sandboxId: nanoHostSandboxIdFromBackendSessionId(backendSessionId),
        workSlot: 'slot',
        packageSnapshotId,
        collectionId: `turn-end-${packageDigest}`,
      };
      const userId = ensureLocalUser(coreDb);
      recordWorkspaceOwnerMembership({ coreDb, workspaceId: db.workspaceId, ownerUserId: userId });
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: userId },
        profileRef: 'profile_worker',
        queueEntryId: 'queue_capture_receipt',
        requestedAgentId: 'agent_codex_host',
        turnInput: 'Collect work',
        workspaceId: db.workspaceId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        now: () => timestamp,
      });
      recordTestExecutionAttempt(coreDb, {
        entry,
        attemptId: testEntityId('attempt', 'capture-receipt'),
        agentSessionId: identity.agentSessionId,
        inputRef: identity.packageSnapshotId,
        bindingRef: 'lease-binding:capture-receipt',
        sessionCompatibilityKey: 'fixture',
        now: () => timestamp,
      });
      const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        targetId: 'runtime-target-test',
        observedAt: timestamp,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...target,
        freshEmpty: true,
        ready: true,
        predecessorFenced: true,
        physicalEpoch: 'a'.repeat(64),
        observedAt: timestamp,
      });
      const anchor = recordWorkerBackendSessionMaterializing(coreDb, {
        backendVersion: '0.0.99',
        backendLineage: { kind: 'reference', imageRef: 'worker:test' },
        identity: {
          agentSessionId: identity.agentSessionId,
          packageSnapshotId: identity.packageSnapshotId,
          backendKind: 'openshell',
          backendSessionId,
          deploymentId: 'deployment-test',
          runtimeTargetId: 'runtime-target-test',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/package',
          transientProviderInstanceId: null,
        },
        lineage: identity,
        sandboxBindingRef: 'lease-binding:capture-receipt',
        now: () => timestamp,
      });
      const base = { tree: '1'.repeat(40), manifest: '2'.repeat(40) };
      const head = { tree: '3'.repeat(40), manifest: '4'.repeat(40) };
      const candidate = Buffer.from('original captured work');
      const source: RawWorkspaceCapture = {
        identity,
        candidate,
        result: {
          outcome: 'candidate',
          head,
          previousHead: base,
          acceptedBase: base,
          unstable: false,
          sha256: `sha256:${createHash('sha256').update(candidate).digest('hex')}`,
          byteLength: candidate.length,
          collectedAt: timestamp,
        },
      };
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      const before = recordWorkspaceCaptureRecovery(
        db,
        anchor,
        identity,
        receiptKind === 'empty' ? null : source
      );
      expect(before.stateAfter).toBe('requires-human');
      const receipt =
        receiptKind === 'empty'
          ? acceptWorkspaceCapture(db, identity, { outcome: 'no_new_head', unstable: false }, null)
          : acceptWorkspaceCapture(
              db,
              identity,
              {
                outcome: 'candidate',
                head,
                previousHead: base,
                acceptedBase: base,
                unstable: false,
              },
              receiptKind === 'matching' ? candidate : Buffer.from('different captured work')
            );
      // Recovery preserves the original source; a different accepted capture cannot replace it.
      if (receiptKind === 'conflicting') {
        expect(receipt.result.sha256).not.toBe(source.result.sha256);
        expect(() => completeWorkspaceCaptureRecovery(db, anchor, identity, null)).toThrow();
        expect(listWorkspaceReconciliationRecords(db, db.workspaceId)).toEqual([before]);
      } else {
        if (receiptKind === 'matching') expect(receipt.result.sha256).toBe(source.result.sha256);
        const completed = completeWorkspaceCaptureRecovery(db, anchor, identity, null);
        expect(completed).toMatchObject({ id: before.id, stateAfter: 'recovered' });
        expect(listWorkspaceReconciliationRecords(db, db.workspaceId)).toEqual([completed]);
      }
      expect(readWorkspaceCollection(db, identity)).toEqual(receipt);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('writes v1 and preserves retained annotations and unchanged bytes through recovery', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-reconciliation-extensions-'));
    let db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      applyScopedMigrations(db, undefined, 'pre-knowledge');
      const original = recordWorkspaceReconciliationRecord(db, {
        ...workspaceReconciliationRecord(),
        backendReachability: {
          ...workspaceReconciliationRecord().backendReachability,
          detail: 'Public fixture hf_publicFixture',
        },
      });
      expect(
        db.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM workspace_reconciliation_records')
          .get()
      ).toEqual({ schemaVersion: 1 });
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
      db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(
        ListWorkspaceReconciliationRecordsResponseSchema.parse({
          items: listWorkspaceReconciliationRecords(db, 'ws_00000000-0000-7000-8000-000000000001'),
        })
      ).toEqual({ items: [original] });
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        reconciliationRecordId: original.id,
        decision: 'resume_collection',
        decidedAt: '2026-07-08T00:10:00.000Z',
        workerOutputManifests: [
          {
            id: 'wom_new',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      expect(
        listWorkspaceReconciliationRecords(db, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([recovered]);
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
        expect(() =>
          listWorkspaceReconciliationRecords(db, 'ws_00000000-0000-7000-8000-000000000001')
        ).toThrow();
        expect(() => recordWorkspaceReconciliationRecord(db, original)).toThrow();
      }
    } finally {
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses an unknown reconciliation version before malformed JSON or replacement', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-reconciliation-version-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      applyScopedMigrations(db, undefined, 'pre-knowledge');
      const record = recordWorkspaceReconciliationRecord(db, workspaceReconciliationRecord());
      db.sqlite
        .prepare('UPDATE workspace_reconciliation_records SET schema_version=2,payload_json=?')
        .run('{');

      expect(() => listWorkspaceReconciliationRecords(db, db.workspaceId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => recordWorkspaceReconciliationRecord(db, record)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => importWorkspaceReconciliationRecords(db, [record])).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        resolveWorkspaceReconciliationRecord({
          workspaceDb: db,
          workspaceId: db.workspaceId,
          reconciliationRecordId: record.id,
          decision: 'quarantine',
          decidedAt: timestamp,
        })
      ).toThrow('Unsupported retained record format.');
      expect(
        db.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion,payload_json FROM workspace_reconciliation_records'
          )
          .get()
      ).toEqual({ schemaVersion: 2, payload_json: '{' });
    } finally {
      db.sqlite.close();
    }
  });

  it('records durable reconciliation state transitions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-reconciliation-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

      recordWorkspaceReconciliationRecord(workspaceDb, workspaceReconciliationRecord());
      recordWorkspaceReconciliationRecord(workspaceDb, {
        ...workspaceReconciliationRecord(),
        stateAfter: 'recovered',
        finishedAt: timestamp,
      });

      expect(
        listWorkspaceReconciliationRecords(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toMatchObject([
        {
          id: 'wrr_1',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const decidedAt = '2026-07-08T00:05:00.000Z';

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const decidedAt = '2026-07-08T00:10:00.000Z';

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          workerOutputManifests: [
            {
              artifactIds: ['ar_00000000-0000-7a55-a9de-2210835b8c8a'],
              backendKind: 'openshell',
              changedPaths: [{ binary: false, path: 'README.md', status: 'modified' }],
              collectedAt: timestamp,
              evidenceRefs: [{ kind: 'worker', ref: 'tu_00000000-0000-7cd5-99a8-a01fc47c5224' }],
              id: 'wom_resume',
              ignoredOutputs: [],
              inputSnapshotId: 'wis_1',
              logRefs: [],
              materializationRecordId: 'wmr_1',
              strategy: 'git',
              testOutputRefs: [],
              workerSessionId: 'session_1',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
