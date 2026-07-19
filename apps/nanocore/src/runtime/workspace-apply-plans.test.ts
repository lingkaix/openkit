import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  importWorkspaceApplyPlans,
  listWorkspaceApplyPlans,
  recordWorkspaceApplyPlan,
} from './workspace-apply-plans.js';

describe('workspace apply plans', () => {
  it('records apply plans before workspace apply mutation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-plan-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const plan = workspaceApplyPlan();
      const first = recordWorkspaceApplyPlan(workspaceDb, plan);
      const replayed = recordWorkspaceApplyPlan(workspaceDb, plan);

      expect(first).toEqual(plan);
      expect(replayed).toEqual(plan);
      expect(listWorkspaceApplyPlans(workspaceDb, 'ws_demo')).toEqual([plan]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a conflicting same-id apply plan replay and preserves the original', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-plan-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const original = workspaceApplyPlan();
      recordWorkspaceApplyPlan(workspaceDb, original);

      expect(() =>
        importWorkspaceApplyPlans(workspaceDb, [
          { ...original, plannedWrites: ['src/different.ts'] },
        ])
      ).toThrow(/conflict/i);
      expect(listWorkspaceApplyPlans(workspaceDb, 'ws_demo')).toEqual([original]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reuses the first apply-plan timestamp when an accepted decision is retried', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-plan-retry-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
      expect(listWorkspaceApplyPlans(workspaceDb, 'ws_demo')).toEqual([original]);
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
    workspaceId: 'ws_demo',
    reviewId: 'swr_1',
    changeSetId: 'wcs_1',
    strategy: 'git',
    approvalState: 'approved',
    plannedWrites: ['src/file.ts'],
    baselineChecks: [{ command: 'git apply --check', status: 'passed', ref: null }],
    pathConflicts: [],
    binaryRisks: [],
    permissionChanges: [],
    policyChecks: [{ command: 'workspace review accepted', status: 'passed', ref: null }],
    createdAt: '2026-07-05T00:00:00.000Z',
  };
}
