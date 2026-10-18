import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListWorkspaceApplyPlansResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  importWorkspaceApplyPlans,
  listExportableWorkspaceApplyPlans,
  listWorkspaceApplyPlans,
  recordWorkspaceApplyPlan,
} from './workspace-apply-plans.js';

describe('workspace apply plans', () => {
  it('records apply plans before workspace apply mutation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-plan-'));
    let workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const plan = workspaceApplyPlan();
      const first = recordWorkspaceApplyPlan(workspaceDb, plan);
      workspaceDb.sqlite.close();
      workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const replayed = recordWorkspaceApplyPlan(workspaceDb, plan);

      expect(first).toEqual(plan);
      expect(replayed).toEqual(plan);
      expect(
        ListWorkspaceApplyPlansResponseSchema.parse({
          items: listWorkspaceApplyPlans(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001'),
        })
      ).toEqual({ items: [plan] });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a conflicting same-id apply plan replay and preserves the original', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-plan-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const original = workspaceApplyPlan();
      recordWorkspaceApplyPlan(workspaceDb, original);

      expect(() =>
        importWorkspaceApplyPlans(workspaceDb, [
          { ...original, plannedWrites: ['src/different.ts'] },
        ])
      ).toThrow(/conflict/i);
      expect(
        listWorkspaceApplyPlans(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([original]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reuses the first apply-plan timestamp when an accepted decision is retried', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-plan-retry-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const original = workspaceApplyPlan();
      recordWorkspaceApplyPlan(workspaceDb, original);

      expect(
        recordWorkspaceApplyPlan(workspaceDb, {
          ...original,
          createdAt: '2026-07-05T00:01:00.000Z',
        })
      ).toEqual(original);
      expect(
        listWorkspaceApplyPlans(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([original]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

/**
 * Builds a schema-valid workspace apply plan fixture.
 *
 * @returns Workspace apply plan fixture.
 */
function workspaceApplyPlan(): Parameters<typeof recordWorkspaceApplyPlan>[1] {
  return {
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
}

/** Creates and cleans one native retained Plan fixture. */
function retainedApplyPlanFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retained-apply-plan-'));
  const plan = workspaceApplyPlan();
  const db = openWorkspaceDb(root, plan.workspaceId);
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  recordWorkspaceApplyPlan(db, plan);
  return { db, plan };
}

describe('retained Workspace Apply Plan SQL format', () => {
  it('writes v1 and reads descriptive additions without replacing retained payloads', () => {
    const { db, plan } = retainedApplyPlanFixture();
    db.sqlite
      .prepare('UPDATE workspace_apply_plans SET payload_json=?')
      .run(JSON.stringify({ ...plan, annotation: 'Retained plan description' }));
    const before = db.sqlite.prepare('SELECT * FROM workspace_apply_plans').get();
    expect(before).toMatchObject({ schema_version: 1 });
    expect(listWorkspaceApplyPlans(db, plan.workspaceId)).toEqual([plan]);
    expect(listExportableWorkspaceApplyPlans(db, plan.workspaceId)[0]).toMatchObject({
      annotation: 'Retained plan description',
    });
    expect(recordWorkspaceApplyPlan(db, plan)).toEqual(plan);
    expect(db.sqlite.prepare('SELECT * FROM workspace_apply_plans').get()).toEqual(before);
  });

  it('refuses an unknown version before malformed JSON decoding or replay replacement', () => {
    const { db, plan } = retainedApplyPlanFixture();
    db.sqlite
      .prepare("UPDATE workspace_apply_plans SET schema_version=2, payload_json='{invalid'")
      .run();
    const before = db.sqlite.prepare('SELECT * FROM workspace_apply_plans').get();
    expect(() => listWorkspaceApplyPlans(db, plan.workspaceId)).toThrow(
      'Unsupported retained record format'
    );
    expect(() => recordWorkspaceApplyPlan(db, plan)).toThrow('Unsupported retained record format');
    expect(db.sqlite.prepare('SELECT * FROM workspace_apply_plans').get()).toEqual(before);
  });
});
