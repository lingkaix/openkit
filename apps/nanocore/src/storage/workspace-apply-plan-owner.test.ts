import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceApplyPlanSchema } from '@openkit/app-api-schemas';
import { afterEach, expect, it } from 'vitest';
import {
  listExportableWorkspaceApplyPlans,
  listWorkspaceApplyPlans,
  recordWorkspaceApplyPlan,
} from '../runtime/workspace-apply-plans.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openWorkspaceDb, openWorkspaceReadDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const roots: string[] = [];
const handles: WorkspaceDb[] = [];
const plan: Parameters<typeof recordWorkspaceApplyPlan>[1] = {
  id: 'wap_swr_1',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  reviewId: 'swr_1',
  changeSetId: 'wcs_1',
  strategy: 'git',
  approvalState: 'approved',
  plannedWrites: ['src/ghp_publicFixture.ts'],
  baselineChecks: [{ command: 'git apply --check', status: 'passed', ref: null }],
  pathConflicts: [],
  binaryRisks: [],
  permissionChanges: [],
  policyChecks: [{ command: 'workspace review accepted', status: 'passed', ref: null }],
  createdAt: '2026-07-05T00:00:00.000Z',
};

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Finishes real migration and native opening before prohibiting writes on Main alone. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-apply-plan-owner-'));
  roots.push(root);
  const db = openWorkspaceDb(root, plan.workspaceId);
  handles.push(db);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: plan.workspaceId });
  await getControlStoreWorkerClient().open({
    database: `workspace:${scope.path}`,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  db.sqlite.pragma('query_only = ON');
  expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  return { root, db };
}

/** Observes all owner rows so refusals cannot hide a partial or unrelated mutation. */
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

/** Closes the real writer and original handle, then reads the same database without migration. */
async function coldReader(f: Awaited<ReturnType<typeof fixture>>) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const db = openWorkspaceReadDb(f.root, plan.workspaceId);
  handles.push(db);
  expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  return db;
}

it('acknowledges the complete native apply plan while Main is query-only and retains it cold', async () => {
  const f = await fixture();
  const before = rows(f.db);
  // Core Storage, SQLite Layers: the complete moved tuple has no Main writer.
  // Expected RED before cutover: the real producer writes through query-only Main.
  expect(await recordWorkspaceApplyPlan(f.db, plan)).toEqual(plan);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  // Workspace Synchronization, Apply Plan: preserve every preflight instruction and index field.
  expect(f.db.sqlite.prepare('SELECT * FROM workspace_apply_plans').all()).toEqual([
    {
      schema_version: 1,
      apply_plan_id: plan.id,
      workspace_id: plan.workspaceId,
      review_id: plan.reviewId,
      change_set_id: plan.changeSetId,
      strategy: plan.strategy,
      approval_state: plan.approvalState,
      payload_json: JSON.stringify(plan),
      created_at: plan.createdAt,
      updated_at: plan.createdAt,
    },
  ]);
  const committed = rows(f.db);
  expect({ ...committed, workspace_apply_plans: [] }).toEqual(before);
  // Durable Execution, Write And Space Budget: publication follows the covering FULL ACK.
  const cold = await coldReader(f);
  expect(rows(cold)).toEqual(committed);
  expect(listWorkspaceApplyPlans(cold, plan.workspaceId)).toEqual([plan]);
  expect(listExportableWorkspaceApplyPlans(cold, plan.workspaceId)).toEqual([plan]);
});

it('preserves all rows on timestamp replay, changed same-id conflict and unsupported retained format', async () => {
  const f = await fixture();
  await recordWorkspaceApplyPlan(f.db, plan);
  // Inject retained descriptive history only after a valid owner publication, with its writer stopped.
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.pragma('query_only = OFF');
  f.db.sqlite
    .prepare('UPDATE workspace_apply_plans SET payload_json = ?')
    .run(JSON.stringify({ ...plan, annotation: 'Retained plan description' }, null, 2));
  f.db.sqlite.pragma('query_only = ON');
  const original = rows(f.db);
  // The accepted move preserves original timestamp and bytes; replay must not normalize history.
  expect(
    await recordWorkspaceApplyPlan(f.db, { ...plan, createdAt: '2026-07-05T00:01:00.000Z' })
  ).toEqual(plan);
  expect(rows(f.db)).toEqual(original);
  await expect(
    recordWorkspaceApplyPlan(f.db, { ...plan, plannedWrites: ['src/changed.ts'] })
  ).rejects.toMatchObject({ code: 'workspace_sync_review_failed', status: 404 });
  expect(rows(f.db)).toEqual(original);
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.pragma('query_only = OFF');
  f.db.sqlite
    .prepare("UPDATE workspace_apply_plans SET schema_version=2, payload_json='{invalid'")
    .run();
  f.db.sqlite.pragma('query_only = ON');
  const unsupported = rows(f.db);
  // Core Storage, Independent Retained Format Markers: reject the version before JSON decoding.
  await expect(recordWorkspaceApplyPlan(f.db, plan)).rejects.toThrow(
    'Unsupported retained record format'
  );
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(rows(f.db)).toEqual(unsupported);
  expect(rows(await coldReader(f))).toEqual(unsupported);
});

it('retains a schema-valid Plan above 1 MiB across ACK, replay and cold read', async () => {
  const f = await fixture();
  const large = {
    ...plan,
    plannedWrites: Array.from(
      { length: 24_000 },
      (_, index) => `src/generated/component-${String(index).padStart(6, '0')}/implementation.ts`
    ),
  };
  expect(WorkspaceApplyPlanSchema.parse(large)).toEqual(large);
  const payload = JSON.stringify(large);
  expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(1024 * 1024);
  expect(await recordWorkspaceApplyPlan(f.db, large)).toEqual(large);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(f.db.sqlite.prepare('SELECT payload_json FROM workspace_apply_plans').all()).toEqual([
    { payload_json: payload },
  ]);
  const committed = rows(f.db);
  expect(
    await recordWorkspaceApplyPlan(f.db, { ...large, createdAt: '2026-07-05T00:01:00.000Z' })
  ).toEqual(large);
  expect(rows(f.db)).toEqual(committed);
  const cold = await coldReader(f);
  expect(rows(cold)).toEqual(committed);
  expect(listWorkspaceApplyPlans(cold, large.workspaceId)).toEqual([large]);
  expect(listExportableWorkspaceApplyPlans(cold, large.workspaceId)).toEqual([large]);
});

it('preserves the original long-id conflict and keeps the native owner usable', async () => {
  const f = await fixture();
  const longIdPlan = { ...plan, id: 'p'.repeat(65_536) };
  expect(WorkspaceApplyPlanSchema.parse(longIdPlan)).toEqual(longIdPlan);
  expect(await recordWorkspaceApplyPlan(f.db, longIdPlan)).toEqual(longIdPlan);
  const committed = rows(f.db);
  // Workspace Synchronization, Apply Plan: the same-tuple move preserves the original refusal.
  await expect(
    recordWorkspaceApplyPlan(f.db, { ...longIdPlan, plannedWrites: ['src/changed.ts'] })
  ).rejects.toMatchObject({
    code: 'workspace_sync_review_failed',
    status: 404,
    message: `Workspace apply plan replay conflict: ${longIdPlan.id}`,
  });
  expect(rows(f.db)).toEqual(committed);
  // Use the real owner again without shutdown or replacement fixture after the domain refusal.
  expect(await recordWorkspaceApplyPlan(f.db, longIdPlan)).toEqual(longIdPlan);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(rows(f.db)).toEqual(committed);
  expect(rows(await coldReader(f))).toEqual(committed);
});
