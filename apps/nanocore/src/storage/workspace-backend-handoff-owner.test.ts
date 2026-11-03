import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listStoredWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { listWorkspaceRuntimeEvidence } from '../runtime/runtime-evidence.js';
import { recordWorkspaceBackendHandoff } from '../runtime/workspace-backend-handoff.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from '../runtime/workspace-materializer.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
} from '../runtime/workspace-sync-records.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  type CoreDb,
  openCoreDb,
  openWorkspaceDb,
  openWorkspaceReadDb,
  type WorkspaceDb,
} from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const timestamp = '2026-07-05T00:00:02.000Z';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const roots: string[] = [];
const handles: (CoreDb | WorkspaceDb)[] = [];
const handoffTables = [
  'workspace_input_snapshots',
  'workspace_materialization_records',
  'backend_workspace_handles',
  'evidence_bundles',
  'runtime_evidence',
] as const;

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Opens the existing physical Workspace owner before Main becomes query-only. */
async function openNative(root: string) {
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId });
  await getControlStoreWorkerClient().open({
    database: `workspace:${scope.path}`,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
}

/** Builds both inputs through existing AEP and materializer owners without a physical runtime. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-backend-handoff-owner-'));
  roots.push(root);
  const coreDb = openCoreDb(root);
  handles.push(coreDb);
  applyMigrations(coreDb);
  const db = openWorkspaceDb(root, workspaceId);
  handles.push(db);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  const environmentPackage = await recordTestAgentEnvironmentPackage(db, {
    coreDb,
    suffix: 'backend_handoff_owner',
    triggerActor: { kind: 'user', id: testEntityId('usr', 'backend_handoff_owner') },
    workspaceInputIds: ['repo_primary', 'repo_secondary'],
  });
  const inputSnapshots = buildWorkspaceInputSnapshots({
    backendCapabilities: ['container', 'workspace-sync'],
    backendKind: 'openshell',
    createdAt: timestamp,
    environmentPackage,
  });
  const materializationRecords = buildWorkspaceMaterializationRecords({
    createdAt: timestamp,
    inputSnapshots,
    materialization: {
      backendKind: 'openshell',
      backendStatus: { health: 'ready', version: '0.0.80' },
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
      sandbox: { name: 'sandbox_backend_handoff', state: 'created' },
      workspaceInputs: environmentPackage.workspace.inputs.map(({ id, target }) => ({
        id,
        target,
      })),
    },
  });
  expect(inputSnapshots.map(({ resourceId }) => resourceId)).toEqual([
    'repo_primary',
    'repo_secondary',
  ]);
  expect(materializationRecords).toHaveLength(2);
  await openNative(root);
  db.sqlite.pragma('query_only = ON');
  expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  return { root, db, inputSnapshots, materializationRecords };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Captures exact retained bytes and scalar indexes, including unrelated Audit and receipt rows. */
function rows(db: WorkspaceDb) {
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db.sqlite
        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ])
  );
}

/** Reads the acknowledged database cold without running layout or migration code. */
async function coldReader(f: Fixture) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const db = openWorkspaceReadDb(f.root, workspaceId);
  handles.push(db);
  expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  return db;
}

/** Checks every original handoff descendant and exact snapshot/materialization storage. */
function expectCompleteHandoff(db: WorkspaceDb, f: Fixture) {
  const expectedSnapshots = f.inputSnapshots
    .map((snapshot) => ({
      schema_version: 1,
      input_snapshot_id: snapshot.id,
      workspace_id: workspaceId,
      resource_id: snapshot.resourceId,
      strategy: snapshot.strategy,
      payload_json: JSON.stringify(snapshot),
      created_at: timestamp,
      updated_at: timestamp,
    }))
    .sort((a, b) => a.input_snapshot_id.localeCompare(b.input_snapshot_id));
  const expectedMaterializations = f.materializationRecords
    .map((record) => ({
      schema_version: 1,
      materialization_record_id: record.id,
      workspace_id: workspaceId,
      input_snapshot_id: record.inputSnapshotId,
      package_snapshot_id: record.packageSnapshotId,
      worker_session_id: record.workerSessionId,
      strategy: record.strategy,
      payload_json: JSON.stringify(record),
      created_at: timestamp,
      updated_at: timestamp,
    }))
    .sort((a, b) => a.materialization_record_id.localeCompare(b.materialization_record_id));
  // Workspace Synchronization, Testing Strategy: exact stored payload bytes and indexes survive replay.
  expect(
    db.sqlite.prepare('SELECT * FROM workspace_input_snapshots ORDER BY input_snapshot_id').all()
  ).toEqual(expectedSnapshots);
  expect(
    db.sqlite
      .prepare('SELECT * FROM workspace_materialization_records ORDER BY materialization_record_id')
      .all()
  ).toEqual(expectedMaterializations);
  expect(listWorkspaceInputSnapshots(db, workspaceId)).toEqual([...f.inputSnapshots].reverse());
  expect(listWorkspaceMaterializationRecords(db, workspaceId)).toEqual(
    [...f.materializationRecords].reverse()
  );
  const expectedHandles = f.materializationRecords.map((record) => ({
    id: `bwh_${record.id}`,
    workspaceId,
    materializationRecordId: record.id,
    backendKind: 'openshell',
    packageSnapshotId: record.packageSnapshotId,
    workerSessionId: record.workerSessionId,
    transportRefs: [{ kind: 'materialized-root', ref: record.materializedRootRef }],
    cleanupStatus: 'pending',
    retention: 'until-reconciliation',
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  expect(listBackendWorkspaceHandles(db, workspaceId)).toEqual([...expectedHandles].reverse());
  expect(
    db.sqlite
      .prepare('SELECT * FROM backend_workspace_handles ORDER BY backend_workspace_handle_id')
      .all()
  ).toEqual(
    expectedHandles
      .map((handle) => ({
        schema_version: 1,
        backend_workspace_handle_id: handle.id,
        workspace_id: workspaceId,
        materialization_record_id: handle.materializationRecordId,
        backend_kind: handle.backendKind,
        package_snapshot_id: handle.packageSnapshotId,
        worker_session_id: handle.workerSessionId,
        payload_json: JSON.stringify(handle),
        created_at: timestamp,
        updated_at: timestamp,
      }))
      .sort((a, b) => a.backend_workspace_handle_id.localeCompare(b.backend_workspace_handle_id))
  );
  // Workspace Synchronization, Evidence: promotion includes the original general bundle and runtime evidence.
  expect(
    listStoredWorkspaceEvidenceBundles(db, workspaceId).filter(
      (bundle) => bundle.sourceKind === 'workspace-materialization'
    )
  ).toEqual(
    f.materializationRecords
      .map((record) => ({
        id: `evb_workspace_materialization_${record.id}`,
        workspaceId,
        threadId: null,
        goalId: null,
        turnId: null,
        agentSessionId: null,
        backendType: 'openshell',
        sourceKind: 'workspace-materialization',
        summary: 'Workspace materialization recorded: strategy git, backend openshell',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'backend.ready', ref: 'version:0.0.80' },
          { kind: 'sandbox.created', ref: 'sandbox_backend_handoff' },
        ],
        contentDigests: [record.policyDigest],
        retentionClass: 'workspace-audit',
        sensitivityClass: 'product-safe',
        importStatus: 'promoted',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: timestamp,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  );
  expect(listWorkspaceRuntimeEvidence(db, workspaceId)).toEqual(
    f.materializationRecords
      .map((record) => ({
        id: `rte_${createHash('sha256').update(record.id).digest('hex').slice(0, 24)}`,
        workspaceId,
        threadId: null,
        turnId: null,
        goalId: null,
        taskId: null,
        agentSessionId: null,
        backendType: 'openshell',
        backendVersion: '0.0.80',
        placement: 'unknown',
        phase: 'capability-negotiation',
        summary: 'Workspace materialization recorded: strategy git, backend openshell',
        policyDigest: record.policyDigest,
        workerImage: null,
        sandboxSummary: `materialized root ${record.materializedRootRef}`,
        capabilitySummary: 'backend.ready, sandbox.created',
        uploadManifest: [],
        downloadManifest: [],
        transcriptSummary: null,
        workspaceChangeSummary: null,
        controlSummary: null,
        outcome: 'succeeded',
        exitCode: null,
        signal: null,
        stopReason: null,
        errorCode: null,
        errorMessage: null,
        redactedStdoutSummary: null,
        redactedStderrSummary: null,
        evidenceBundleIds: [`evb_workspace_materialization_${record.id}`],
        contentDigests: [record.policyDigest],
        requiredFeatures: ['runtime.evidence.v1'],
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        collectedAt: timestamp,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  );
}

it('publishes the complete backend handoff with Main query-only, exact replay and cold reads', async () => {
  const f = await fixture();
  const before = rows(f.db);
  const command = () =>
    recordWorkspaceBackendHandoff(f.db, f.inputSnapshots, f.materializationRecords);
  // Core Storage, SQLite Layers: expected RED before the move is SQLITE_READONLY on Main's first INSERT.
  expect(await command()).toEqual({
    inputSnapshots: f.inputSnapshots,
    materializationRecords: f.materializationRecords,
  });
  expectCompleteHandoff(f.db, f);
  const committed = rows(f.db);
  const unrelated = { ...committed };
  for (const table of handoffTables) unrelated[table] = before[table]!;
  expect(unrelated).toEqual(before);
  expect(await command()).toEqual({
    inputSnapshots: f.inputSnapshots,
    materializationRecords: f.materializationRecords,
  });
  expect(rows(f.db)).toEqual(committed);
  // Existing replay predicates compare complete known content, including the raw input lineage.
  await expect(async () =>
    recordWorkspaceBackendHandoff(
      f.db,
      [
        {
          ...f.inputSnapshots[0]!,
          backend: { ...f.inputSnapshots[0]!.backend, label: 'changed input' },
        },
        f.inputSnapshots[1]!,
      ],
      f.materializationRecords
    )
  ).rejects.toThrow('Workspace input snapshot replay conflict');
  expect(rows(f.db)).toEqual(committed);
  await expect(async () =>
    recordWorkspaceBackendHandoff(f.db, f.inputSnapshots, [
      f.materializationRecords[0]!,
      { ...f.materializationRecords[1]!, materializedRootRef: '/workspace/changed' },
    ])
  ).rejects.toThrow('Workspace materialization replay conflict');
  expect(rows(f.db)).toEqual(committed);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  const cold = await coldReader(f);
  expect(rows(cold)).toEqual(committed);
  expectCompleteHandoff(cold, f);
});

it('rolls back every handoff row on the final runtime evidence fault and succeeds after only that fault is removed', async () => {
  const f = await fixture();
  // Deliberate storage fault only: stop the native writer before changing this test-owned trigger.
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.pragma('query_only = OFF');
  const finalId = `rte_${createHash('sha256').update(f.materializationRecords[1]!.id).digest('hex').slice(0, 24)}`;
  f.db.sqlite.exec(`CREATE TRIGGER reject_final_handoff_runtime BEFORE INSERT ON runtime_evidence
    WHEN NEW.runtime_evidence_id = '${finalId}'
    BEGIN SELECT RAISE(ABORT, 'final handoff runtime evidence fault'); END`);
  await openNative(f.root);
  f.db.sqlite.pragma('query_only = ON');
  const before = rows(f.db);
  const command = () =>
    recordWorkspaceBackendHandoff(f.db, f.inputSnapshots, f.materializationRecords);
  // Expected RED before the move: SQLITE_READONLY occurs before this real late native fault.
  await expect(async () => command()).rejects.toMatchObject({
    code: 'constraint',
    commit: 'not-committed',
    message: 'Control database writer operation failed.',
  });
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(rows(f.db)).toEqual(before);
  for (const table of handoffTables)
    expect(f.db.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.pragma('query_only = OFF');
  f.db.sqlite.exec('DROP TRIGGER reject_final_handoff_runtime');
  await openNative(f.root);
  f.db.sqlite.pragma('query_only = ON');
  expect(rows(f.db)).toEqual(before);
  expect(await command()).toEqual({
    inputSnapshots: f.inputSnapshots,
    materializationRecords: f.materializationRecords,
  });
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expectCompleteHandoff(f.db, f);
  const committed = rows(f.db);
  const cold = await coldReader(f);
  expect(rows(cold)).toEqual(committed);
  expectCompleteHandoff(cold, f);
});
