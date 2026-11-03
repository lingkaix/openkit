// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { currentWorkerLineageWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { listStoredWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from '../runtime/filesystem-workspace-sync.js';
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceWorkspaceChangeRecord,
} from '../runtime/worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from '../runtime/worker-governance-turn-executor.js';
import { getFilesystemWorkspaceStagingRoot } from '../runtime/workspace-filesystem-staging.js';
import {
  listWorkerOutputManifests,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
} from '../runtime/workspace-sync-records.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { createTestCoreDb } from '../test-support/store.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openWorkspaceDb, openWorkspaceReadDb, type WorkspaceDb } from './db.js';
import { nativeProductScope } from './workspace-file-records.js';

/** Refuses every external runtime effect; publication must use only its actual Store and SQL owners. */
function unexpectedBackendEffect(): never {
  throw new Error('StageReview publication must not enter the external runtime backend.');
}

// This unused external-effect dependency supplies no review, Artifact, SQL result or authority.
const backend: WorkerGovernanceBackend = {
  id: 'stage-review-unused-backend',
  describeCapabilities: unexpectedBackendEffect,
  validatePackage: unexpectedBackendEffect,
  planSession: unexpectedBackendEffect,
  cleanupSession: unexpectedBackendEffect,
  materialize: unexpectedBackendEffect,
  prepareLaunch: unexpectedBackendEffect,
  update: unexpectedBackendEffect,
  collectEvidence: unexpectedBackendEffect,
  collectTranscript: unexpectedBackendEffect,
  collectWorkspaceChanges: unexpectedBackendEffect,
  submit: unexpectedBackendEffect,
  inspect: unexpectedBackendEffect,
  cancel: unexpectedBackendEffect,
  release: unexpectedBackendEffect,
};

/**
 * Creates real filesystem candidates and admitted owners for the complete public publication seam.
 *
 * @param name Stable isolated case identity.
 * @returns Actual publisher, physical query-only Main intervention and owner readers.
 */
async function createNativeStageReviewFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `openkit-stage-review-${name}-`));
  const handles: (CoreDb | WorkspaceDb)[] = [];
  let restoreMain: (() => void) | undefined;
  onTestFinished(async () => {
    restoreMain?.();
    await shutdownControlStoreWorkerClient();
    for (const db of handles) if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { force: true, recursive: true });
  });
  const timestamp = '2026-07-05T00:00:02.000Z';
  const coreDb = createTestCoreDb(root);
  handles.push(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const workspaceDb = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  handles.push(workspaceDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: LOCAL_USER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  const actor = { kind: 'user', id: LOCAL_USER_ID } as const;
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    DEMO_THREAD_ID,
    `Stage review ${name}`,
    actor,
    null,
    {
      turnId: testEntityId('tu', `turn_${name}`),
    }
  );
  const assignedTurn = await store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
  const requestId = '00000000-0000-4000-8000-000000000260';
  const agentSetup = createTestAgentSetup();
  admitTestNativeEnvironment(coreDb, agentSetup.manifest);
  const environmentPackage = await resolveAgentEnvironmentPackage({
    coreDb,
    captureCoverage: { scope: 'server', value: 'off' },
    agentSetup,
    agentSessionId: testEntityId('as', `stage_review_${name}`),
    triggerActor: actor,
    backend: { kind: 'openshell' },
    requestId,
    turn: assignedTurn,
    turnInput: `Stage review ${name}`,
    workspaceCwd: null,
    workspaceRoots: [],
  });
  await recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    environmentPackage,
    createdAt: timestamp,
  });
  expect(environmentPackage.scope.turnId).toBe(turn.id);
  expect(environmentPackage.scope.requestId).toBe(requestId);
  expect(environmentPackage.workspace.inputs).toEqual([]);
  await recordTestNativeRuntimeTarget(coreDb, 'runtime-target-test');
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    now: () => timestamp,
    profileRef: 'profile_worker',
    queueEntryId: `queue_${turn.id}`,
    requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: DEMO_THREAD_ID,
    triggerActor: actor,
    turnId: turn.id,
    turnInput: `Stage review ${name}`,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', `stage_review_${name}`),
    agentSessionId: environmentPackage.scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: `stage-review:${name}`,
    sessionCompatibilityKey: 'fixture-stage-review',
    now: () => timestamp,
  });
  for (const operation of ['workspace.write', 'artifact.write']) {
    expect(
      currentWorkerLineageWorkspaceAuthority(
        coreDb,
        {
          ...environmentPackage.scope,
          packageSnapshotId: environmentPackage.snapshotId,
        },
        operation,
        true
      )
    ).not.toBeNull();
  }
  const originalApply = {
    targetRootPath: join(root, 'target'),
    stagingRootPath: join(root, 'staging'),
  };
  const workerRoot = join(root, 'worker');
  for (const path of [originalApply.targetRootPath, originalApply.stagingRootPath, workerRoot])
    mkdirSync(path);
  writeFileSync(join(originalApply.targetRootPath, 'README.md'), 'original target\n');
  writeFileSync(join(workerRoot, 'README.md'), 'reviewed candidate\n');
  chmodSync(join(originalApply.targetRootPath, 'README.md'), 0o644);
  chmodSync(join(workerRoot, 'README.md'), 0o644);
  const before = await createFilesystemSnapshotManifest({
    createdAt: timestamp,
    resourceId: 'repo',
    rootPath: originalApply.targetRootPath,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  const after = await createFilesystemSnapshotManifest({
    createdAt: timestamp,
    resourceId: 'repo',
    rootPath: workerRoot,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  const changeSet = buildFilesystemWorkspaceChangeSet({
    after,
    before,
    changeSetId: `wcs_stage_review_${name}`,
    createdAt: timestamp,
    inputSnapshotId: `wis_stage_review_${name}`,
    materializationRecordId: `wmr_stage_review_${name}`,
  });
  const reviewId = `swr_stage_review_${name}`;
  const record: WorkerGovernanceWorkspaceChangeRecord = {
    changeSet: { ...changeSet, evidenceRefs: [{ kind: 'worker', ref: turn.id }] },
    filesystemApply: { ...originalApply, before },
    patchPayload: null,
    review: {
      actionCenterRowId: `workspace-review:${reviewId}`,
      changeSetId: changeSet.id,
      createdAt: timestamp,
      diffSummary: { additions: 1, deletions: 1, filesChanged: 1 },
      id: reviewId,
      riskSummary: 'One changed file awaits human review.',
      staging: {
        branch: null,
        ref: `filesystem-staging://${reviewId}`,
        strategy: 'filesystem_staging',
      },
      status: 'pending',
      updatedAt: timestamp,
      validation: [],
      workspaceId: DEMO_WORKSPACE_ID,
    },
  };
  const fixture = {
    artifactId: deriveEntityId('ar', ['workspace_changes', turn.id, reviewId]),
    environmentPackage,
    requestId,
    reviewId,
    store,
    storeDataRoot: root,
    timestamp,
    workspaceDb,
    workspaceId: DEMO_WORKSPACE_ID,
  };
  await stageFilesystemWorkspaceChanges({
    changeSet: record.changeSet,
    sourceRoot: workerRoot,
    stagingRoot: originalApply.stagingRootPath,
  });
  await recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
    artifactId: fixture.artifactId,
    changeSet: record.changeSet,
    patchPayload: record.patchPayload,
    review: record.review,
  });
  const executor = new WorkerGovernanceTurnExecutor({
    backend,
    coreDb,
    environmentBackend: { kind: 'openshell' },
    fileAdmission: new FileStorageAdmission(fixture.storeDataRoot, () => 0n),
    now: () => fixture.timestamp,
  });
  // Publish the actual earlier Artifact stage through its owner, without fabricating its receipt or rows.
  const body = JSON.stringify(
    { changeSet: record.changeSet, patchPayload: record.patchPayload, review: record.review },
    null,
    2
  );
  const artifact = await fixture.store.createArtifact({
    content: { body, format: 'json' },
    contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
    createdAt: fixture.timestamp,
    id: fixture.artifactId,
    kind: 'diff',
    lastMutationRequestId: fixture.requestId,
    origin: {
      kind: 'turn-output',
      requestId: fixture.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
    },
    status: 'ready',
    summary: record.review.riskSummary,
    threadId: environmentPackage.scope.threadId,
    title: 'Workspace changes ready for review',
    turnId: environmentPackage.scope.turnId,
    updatedAt: fixture.timestamp,
    version: 1,
    workspaceId: fixture.workspaceId,
  });
  const referenceItems = () =>
    fixture.store
      .listThreadItems(fixture.workspaceId, environmentPackage.scope.threadId)
      .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifact.id);
  const artifactItems = referenceItems();
  expect(artifactItems).toHaveLength(1);

  /** Opens the genuine native writer with its original physical binding and current journal. */
  async function openNative() {
    const scope = nativeProductScope(fixture.storeDataRoot, {
      kind: 'workspace',
      workspaceId: fixture.workspaceId,
    });
    await getControlStoreWorkerClient().open({
      database: `workspace:${scope.path}`,
      path: scope.path,
      dataRoot: fixture.storeDataRoot,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
  }
  await openNative();
  const physical = {
    stagingRootIdentity: rootIdentity(originalApply.stagingRootPath),
    targetRootIdentity: rootIdentity(originalApply.targetRootPath),
  };
  /** Requires retained physical candidates to survive both publication and refusal unchanged. */
  function expectUnchanged() {
    expect(rootIdentity(originalApply.targetRootPath)).toBe(physical.targetRootIdentity);
    expect(rootIdentity(originalApply.stagingRootPath)).toBe(physical.stagingRootIdentity);
    expect(readFileSync(join(originalApply.targetRootPath, 'README.md'), 'utf8')).toBe(
      'original target\n'
    );
    expect(readFileSync(join(originalApply.stagingRootPath, 'README.md'), 'utf8')).toBe(
      'reviewed candidate\n'
    );
  }

  /** Sets query-only on actual Main handles; every SQL statement still runs through SQLite. */
  function armQueryOnlyMain() {
    restoreMain?.();
    const sqlitePrototype = Object.getPrototypeOf(fixture.workspaceDb.sqlite) as {
      prepare: typeof fixture.workspaceDb.sqlite.prepare;
      pragma: typeof fixture.workspaceDb.sqlite.pragma;
    };
    const prepare = sqlitePrototype.prepare;
    const pragma = sqlitePrototype.pragma;
    const guard = vi.spyOn(sqlitePrototype, 'prepare').mockImplementation(function (
      this: WorkspaceDb['sqlite'],
      sql: string
    ) {
      if (this.name === fixture.workspaceDb.sqlite.name) {
        pragma.call(this, 'query_only = ON');
      }
      return prepare.call(this, sql);
    });
    fixture.workspaceDb.sqlite.pragma('query_only = ON');
    restoreMain = () => guard.mockRestore();
  }

  /** Reads the six original families through their real owners, scoped to this candidate. */
  function tuple(db = fixture.workspaceDb) {
    return {
      stagingRoot: getFilesystemWorkspaceStagingRoot(db, fixture.workspaceId, record.review.id),
      manifests: listWorkerOutputManifests(db, fixture.workspaceId).filter(
        (item) => item.materializationRecordId === record.changeSet.materializationRecordId
      ),
      changeSets: listWorkspaceChangeSets(db, fixture.workspaceId).filter(
        (item) => item.id === record.changeSet.id
      ),
      reviews: listWorkspaceSyncReviews(db, fixture.workspaceId).filter(
        (item) => item.review.id === record.review.id
      ),
      audits: listWorkspaceAuditEvents(db, fixture.workspaceId).filter(
        (item) =>
          item.action === 'workspace.review.stage' &&
          item.resource === `workspace-review:${record.review.id}`
      ),
      evidence: listStoredWorkspaceEvidenceBundles(db, fixture.workspaceId).filter(
        (item) => item.id === `evb_workspace_review_${record.review.id}`
      ),
    };
  }

  /** Requires every original family and its governing producer/candidate lineage after acknowledgement. */
  function expectPublished(db = fixture.workspaceDb) {
    const actual = tuple(db);
    expect(actual.stagingRoot).toMatchObject({
      before,
      changeSetId: record.changeSet.id,
      createdAt: fixture.timestamp,
      reviewId: record.review.id,
      stagingRootPath: realpathSync(originalApply.stagingRootPath),
      targetRootPath: realpathSync(originalApply.targetRootPath),
      updatedAt: fixture.timestamp,
      workspaceId: fixture.workspaceId,
    });
    expect(actual.stagingRoot?.stagingRootIdentity).toBe(physical.stagingRootIdentity);
    expect(actual.stagingRoot?.targetRootIdentity).toBe(physical.targetRootIdentity);
    expect(actual.manifests).toEqual([
      {
        artifactIds: record.changeSet.artifactIds,
        backendKind: 'openshell',
        changedPaths: record.changeSet.changedPaths,
        collectedAt: fixture.timestamp,
        evidenceRefs: record.changeSet.evidenceRefs,
        id: `wom_${record.changeSet.id}`,
        ignoredOutputs: [],
        inputSnapshotId: record.changeSet.inputSnapshotId,
        logRefs: [],
        materializationRecordId: record.changeSet.materializationRecordId,
        strategy: 'filesystem',
        testOutputRefs: [],
        workerSessionId: `sandbox_test_${record.changeSet.materializationRecordId}`,
        workspaceId: fixture.workspaceId,
      },
    ]);
    expect(actual.changeSets).toEqual([record.changeSet]);
    expect(actual.reviews).toEqual([
      {
        artifactId: artifact.id,
        changeSet: record.changeSet,
        patchPayload: null,
        review: record.review,
      },
    ]);
    expect(actual.audits).toEqual([
      expect.objectContaining({
        action: 'workspace.review.stage',
        actor: {
          kind: 'agent',
          id: environmentPackage.agent.agentId,
          responsibleUserId:
            environmentPackage.scope.triggerActor.kind === 'user'
              ? environmentPackage.scope.triggerActor.id
              : environmentPackage.scope.triggerActor.responsibleUserId,
        },
        agentId: environmentPackage.agent.agentId,
        agentSessionId: environmentPackage.scope.agentSessionId,
        requestId: fixture.requestId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        outcome: 'succeeded',
        resource: `workspace-review:${record.review.id}`,
        workspaceId: fixture.workspaceId,
      }),
    ]);
    expect(actual.evidence).toEqual([
      {
        id: `evb_workspace_review_${record.review.id}`,
        workspaceId: fixture.workspaceId,
        threadId: null,
        goalId: null,
        turnId: null,
        agentSessionId: null,
        backendType: null,
        sourceKind: 'workspace-sync-review',
        summary: `Workspace review staged: ${record.changeSet.changedPaths.length} changed path, strategy filesystem`,
        rawEvidenceRefs: [],
        redactedEvidenceRefs: record.changeSet.evidenceRefs,
        contentDigests: [],
        retentionClass: 'workspace-audit',
        sensitivityClass: 'product-safe',
        importStatus: 'promoted',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: fixture.timestamp,
      },
    ]);
    expect(fixture.store.getArtifact(fixture.workspaceId, artifact.id)).toEqual(artifact);
    expect(referenceItems()).toEqual(artifactItems);
    expectUnchanged();
  }

  /** Captures physical identity without manufacturing a durable staging record. */
  function rootIdentity(path: string) {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  }

  /** Injects or removes only the final Evidence insertion fault under native writer exclusion. */
  async function setLateFault(enabled: boolean) {
    restoreMain?.();
    await shutdownControlStoreWorkerClient();
    fixture.workspaceDb.sqlite.pragma('query_only = OFF');
    if (enabled) {
      // Deliberate post-setup storage fault, not success-state construction or a TEMP connection trigger.
      const evidenceId = `evb_workspace_review_${record.review.id}`.replaceAll("'", "''");
      fixture.workspaceDb.sqlite.exec(`CREATE TRIGGER reject_stage_review_evidence BEFORE INSERT ON evidence_bundles
        WHEN NEW.evidence_bundle_id = '${evidenceId}'
        BEGIN SELECT RAISE(ABORT, 'stage review late evidence fault'); END`);
    } else {
      fixture.workspaceDb.sqlite.exec('DROP TRIGGER reject_stage_review_evidence');
    }
    await openNative();
    return armQueryOnlyMain();
  }

  return {
    ...fixture,
    artifact,
    artifactItems,
    armQueryOnlyMain,
    expectPublished,
    expectUnchanged,
    record,
    referenceItems,
    setLateFault,
    tuple,
    stage: () => executor.publishWorkspaceCollections(fixture.store, environmentPackage, [record]),
    lineage: () => ({
      inputs: listWorkspaceInputSnapshots(fixture.workspaceDb, fixture.workspaceId),
      materializations: listWorkspaceMaterializationRecords(
        fixture.workspaceDb,
        fixture.workspaceId
      ),
    }),
    async cold() {
      await shutdownControlStoreWorkerClient();
      const db = openWorkspaceReadDb(fixture.storeDataRoot, fixture.workspaceId);
      handles.push(db);
      expect(db.sqlite.readonly).toBe(true);
      expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
      return db;
    },
  };
}

it('publishes the whole filesystem review tuple with query-only Main and exact duplicate replay', async () => {
  const fixture = await createNativeStageReviewFixture('native_stage_review_complete');
  const before = fixture.tuple();
  const lineage = fixture.lineage();
  expect(before).toEqual({
    stagingRoot: null,
    manifests: [],
    changeSets: [],
    reviews: [],
    audits: [],
    evidence: [],
  });
  fixture.armQueryOnlyMain();
  // Core Storage, SQLite Layers: expected current RED is a body SQLITE_READONLY at the staging-root INSERT.
  await expect(fixture.stage()).resolves.toBeUndefined();
  fixture.expectPublished();
  const committed = fixture.tuple();
  await expect(Promise.all([fixture.stage(), fixture.stage()])).resolves.toEqual([
    undefined,
    undefined,
  ]);
  expect(fixture.tuple()).toEqual(committed);
  expect(fixture.lineage()).toEqual(lineage);
  expect(fixture.workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
  const cold = await fixture.cold();
  expect(fixture.tuple(cold)).toEqual(committed);
  fixture.expectPublished(cold);
});

it('rolls back the whole filesystem review tuple on late Evidence refusal and retains the original Artifact', async () => {
  const fixture = await createNativeStageReviewFixture('native_stage_review_rollback');
  const before = fixture.tuple();
  const lineage = fixture.lineage();
  expect(before).toEqual({
    stagingRoot: null,
    manifests: [],
    changeSets: [],
    reviews: [],
    audits: [],
    evidence: [],
  });
  await fixture.setLateFault(true);
  // Expected current RED is SQLITE_READONLY before the final native constraint can execute.
  await expect(fixture.stage()).rejects.toMatchObject({
    code: 'constraint',
    commit: 'not-committed',
  });
  expect(fixture.tuple()).toEqual(before);
  fixture.expectUnchanged();
  expect(fixture.lineage()).toEqual(lineage);
  expect(fixture.workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId)).toEqual(
    fixture.artifact
  );
  expect(fixture.referenceItems()).toEqual(fixture.artifactItems);
  const refusedCold = await fixture.cold();
  expect(fixture.tuple(refusedCold)).toEqual(before);
  expect(
    new FsStore({ dataRoot: fixture.storeDataRoot }).getArtifact(
      fixture.workspaceId,
      fixture.artifactId
    )
  ).toEqual(fixture.artifact);
  refusedCold.sqlite.close();
  await fixture.setLateFault(false);
  // Explicit retry after proved non-commit removes only the test fault; it creates no product retry policy.
  await expect(fixture.stage()).resolves.toBeUndefined();
  fixture.expectPublished();
  expect(fixture.lineage()).toEqual(lineage);
  const committed = fixture.tuple();
  const cold = await fixture.cold();
  expect(fixture.tuple(cold)).toEqual(committed);
  fixture.expectPublished(cold);
});
