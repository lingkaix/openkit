import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { listWorkspaceApplyPlans, recordWorkspaceApplyPlan } from './workspace-apply-plans.js';

describe('workspace apply plans', () => {
  it('records apply plans before workspace apply mutation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-plan-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceApplyPlan(workspaceDb, {
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
      });
      recordWorkspaceApplyPlan(workspaceDb, {
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
      });

      expect(listWorkspaceApplyPlans(workspaceDb, 'ws_demo')).toEqual([
        {
          approvalState: 'approved',
          baselineChecks: [{ command: 'git apply --check', status: 'passed', ref: null }],
          binaryRisks: [],
          changeSetId: 'wcs_1',
          createdAt: '2026-07-05T00:00:00.000Z',
          id: 'wap_swr_1',
          pathConflicts: [],
          permissionChanges: [],
          plannedWrites: ['src/file.ts'],
          policyChecks: [{ command: 'workspace review accepted', status: 'passed', ref: null }],
          reviewId: 'swr_1',
          strategy: 'git',
          workspaceId: 'ws_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
