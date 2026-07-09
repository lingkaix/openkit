import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import type { WorkspaceRepositoryGitConfig } from '../workspace/repository-store.js';
import {
  getGitPushRecord,
  listGitPushRecords,
  prepareGitPushAttempt,
  recordGitPushRecord,
} from './git-push-records.js';
import { recordWorkspaceApplyResult } from './workspace-apply-results.js';

const baseGitConfig: WorkspaceRepositoryGitConfig = {
  allowedPushTargets: [],
  authorEmail: null,
  authorName: null,
  commitOnApply: false,
  protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
  requireReviewLinkage: true,
  stagingStrategy: 'staging-root',
  vaultGrantRef: null,
};

describe('Git push records', () => {
  it('records one linked audit event when a Git push record is stored', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-push-record-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      recordGitPushRecord(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000022',
        record: {
          actorId: 'user_1',
          approvalRowId: 'har_1',
          commitIds: ['abc123'],
          createdAt: '2026-07-05T00:00:00.000Z',
          errorSummary: null,
          id: 'gpr_1',
          outcome: 'pushed',
          policyDecisionId: 'pd_1',
          remoteHeadAfter: 'abc123',
          remoteHeadBefore: 'def456',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          reviewIds: ['swr_1'],
          sourceRef: 'HEAD',
          targetBranch: 'main',
          updatedAt: '2026-07-05T00:00:00.000Z',
          workspaceId: 'ws_demo',
        },
      });
      recordGitPushRecord(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000022',
        record: {
          actorId: 'user_1',
          approvalRowId: 'har_1',
          commitIds: ['abc123'],
          createdAt: '2026-07-05T00:00:00.000Z',
          errorSummary: null,
          id: 'gpr_1',
          outcome: 'pushed',
          policyDecisionId: 'pd_1',
          remoteHeadAfter: 'abc123',
          remoteHeadBefore: 'def456',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          reviewIds: ['swr_1'],
          sourceRef: 'HEAD',
          targetBranch: 'main',
          updatedAt: '2026-07-05T00:00:00.000Z',
          workspaceId: 'ws_demo',
        },
      });

      expect(getGitPushRecord(workspaceDb, 'ws_demo', 'gpr_1')).toMatchObject({
        id: 'gpr_1',
        outcome: 'pushed',
        commitIds: ['abc123'],
      });
      expect(listGitPushRecords(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          id: 'gpr_1',
          repositoryResourceId: 'repo_default',
          reviewIds: ['swr_1'],
        }),
      ]);

      const audits = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE resource = ? ORDER BY created_at')
        .all('workspace-repository:repo_default') as Array<Record<string, unknown>>;

      expect(audits).toEqual([
        expect.objectContaining({
          action: 'workspace.git.push.finish',
          category: 'command',
          created_at: '2026-07-05T00:00:00.000Z',
          error_code: null,
          outcome: 'succeeded',
          request_id: '00000000-0000-4000-8000-000000000022',
          resource: 'workspace-repository:repo_default',
          severity: 'info',
          summary: 'Git push pushed: 1 commit, 1 review, target main',
          workspace_id: 'ws_demo',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records preflight refusals before a remote push is attempted', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-push-attempt-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const policyRefusal = prepareGitPushAttempt(workspaceDb, {
        actorId: 'user_1',
        approvalNamesProtectedTarget: false,
        approvalRowId: 'har_1',
        commitIds: ['commit_a'],
        git: baseGitConfig,
        now: () => '2026-07-05T00:00:00.000Z',
        policyDecisionId: 'pd_1',
        recordId: 'gpr_policy',
        remoteSummary: 'GitHub repository openkit on origin',
        repositoryResourceId: 'repo_default',
        requestId: '00000000-0000-4000-8000-000000000023',
        sourceRef: 'HEAD',
        targetBranch: 'feature/demo',
        workspaceId: 'ws_demo',
      });

      expect(policyRefusal).toEqual({
        record: expect.objectContaining({
          errorSummary: 'Git push refused by repository target policy.',
          id: 'gpr_policy',
          outcome: 'refused-policy',
          reviewIds: [],
        }),
        status: 'recorded-refusal',
      });

      const linkageRefusal = prepareGitPushAttempt(workspaceDb, {
        actorId: 'user_1',
        approvalNamesProtectedTarget: false,
        approvalRowId: 'har_2',
        commitIds: ['commit_missing'],
        git: { ...baseGitConfig, allowedPushTargets: ['feature/*'] },
        now: () => '2026-07-05T00:01:00.000Z',
        policyDecisionId: 'pd_2',
        recordId: 'gpr_linkage',
        remoteSummary: 'GitHub repository openkit on origin',
        repositoryResourceId: 'repo_default',
        requestId: '00000000-0000-4000-8000-000000000024',
        sourceRef: 'HEAD',
        targetBranch: 'feature/demo',
        workspaceId: 'ws_demo',
      });

      expect(linkageRefusal).toEqual({
        record: expect.objectContaining({
          errorSummary:
            'Git push refused because commits are not linked to accepted workspace reviews.',
          id: 'gpr_linkage',
          outcome: 'refused-linkage',
          reviewIds: [],
        }),
        status: 'recorded-refusal',
      });

      expect(listGitPushRecords(workspaceDb, 'ws_demo').map((record) => record.id)).toEqual([
        'gpr_linkage',
        'gpr_policy',
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('returns linked review ids for push attempts that pass preflight', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-push-attempt-ready-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      recordWorkspaceApplyResult(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000025',
        result: {
          appliedAt: '2026-07-05T00:00:00.000Z',
          appliedPaths: ['README.md'],
          changeSetId: 'wcs_1',
          commitIds: ['commit_a'],
          conflictRecords: [],
          id: 'war_1',
          reviewId: 'swr_1',
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId: 'ws_demo',
        },
      });

      expect(
        prepareGitPushAttempt(workspaceDb, {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: { ...baseGitConfig, allowedPushTargets: ['feature/*'] },
          now: () => '2026-07-05T00:01:00.000Z',
          policyDecisionId: 'pd_1',
          recordId: 'gpr_ready',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000026',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        })
      ).toEqual({
        protected: false,
        reviewIds: ['swr_1'],
        status: 'ready',
      });
      expect(listGitPushRecords(workspaceDb, 'ws_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
