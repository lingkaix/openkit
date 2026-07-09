import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import type { WorkspaceRepositoryGitConfig } from '../workspace/repository-store.js';
import {
  executeGitPushAttempt,
  type GitPushCommandRunner,
  runGitPushCommand,
} from './git-push-executor.js';
import { listGitPushRecords } from './git-push-records.js';
import { recordWorkspaceApplyResult } from './workspace-apply-results.js';

const baseGitConfig: WorkspaceRepositoryGitConfig = {
  allowedPushTargets: ['feature/*'],
  authorEmail: null,
  authorName: null,
  commitOnApply: false,
  protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
  requireReviewLinkage: true,
  stagingStrategy: 'staging-root',
  vaultGrantRef: null,
};

/**
 * Opens a migrated workspace database for Git push executor tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-push-executor-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Records one accepted apply result for Git push linkage tests.
 *
 * @param workspaceDb Workspace database handle.
 */
function recordLinkedCommit(workspaceDb: WorkspaceDb): void {
  recordWorkspaceApplyResult(workspaceDb, {
    requestId: '00000000-0000-4000-8000-000000000027',
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
}

/**
 * Records an allowed repo.push decision for Git push executor tests.
 *
 * @param workspaceDb Workspace database handle.
 * @param decisionId Permission decision id.
 * @param targetBranch Push target branch.
 */
function recordRepoPushAllowDecision(
  workspaceDb: WorkspaceDb,
  decisionId: string,
  targetBranch = 'feature/demo'
): void {
  recordProductPermissionDecision({
    workspaceDb,
    action: 'repo.push',
    contextSummary: { requestId: 'req_git_push_test' },
    decisionId,
    enforcementPoint: 'workspace.git.push',
    ownerScope: 'workspace',
    policyEngineVersion: 'nanocore-git-policy:v1',
    policySnapshotId: 'git_push_policy',
    reasonCode: 'repo_push_allowed',
    resourceSummary: {
      kind: 'git-push-target',
      repositoryResourceId: 'repo_default',
      targetBranch,
      workspaceId: 'ws_demo',
    },
    result: 'allow',
    subjectSummary: { id: 'user_1', kind: 'user' },
    workspaceId: 'ws_demo',
    now: new Date('2026-07-05T00:00:00.000Z'),
  });
}

describe('Git push executor', () => {
  it('records preflight refusals without invoking the command runner', async () => {
    const workspaceDb = createWorkspaceDb();
    const runner: GitPushCommandRunner = async () => {
      throw new Error('runner should not be called');
    };

    try {
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: { ...baseGitConfig, allowedPushTargets: [] },
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_1',
          recordId: 'gpr_refused',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000028',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: '/repo',
        remoteName: 'origin',
        runner,
      });

      expect(record).toMatchObject({ id: 'gpr_refused', outcome: 'refused-policy' });
      expect(listGitPushRecords(workspaceDb, 'ws_demo')).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records unsupported provider refusals without invoking the command runner', async () => {
    const workspaceDb = createWorkspaceDb();
    const runner: GitPushCommandRunner = async () => {
      throw new Error('runner should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: baseGitConfig,
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_1',
          recordId: 'gpr_unsupported',
          remoteSummary: 'GitLab repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000031',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: '/repo',
        provider: 'unsupported',
        remoteName: 'origin',
        runner,
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push refused because V1 supports GitHub remotes only.',
        id: 'gpr_unsupported',
        outcome: 'unsupported-provider',
        reviewIds: ['swr_1'],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records policy refusals when the repo.push decision is missing', async () => {
    const workspaceDb = createWorkspaceDb();
    const runner: GitPushCommandRunner = async () => {
      throw new Error('runner should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb);
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: baseGitConfig,
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_missing',
          recordId: 'gpr_policy_missing',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000034',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: '/repo',
        provider: 'github',
        remoteName: 'origin',
        runner,
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push refused because the repo.push policy decision is not allowed.',
        id: 'gpr_policy_missing',
        outcome: 'refused-policy',
        reviewIds: ['swr_1'],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records policy refusals when the repo.push decision targets a different branch', async () => {
    const workspaceDb = createWorkspaceDb();
    const runner: GitPushCommandRunner = async () => {
      throw new Error('runner should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb);
      recordRepoPushAllowDecision(workspaceDb, 'pd_wrong_target', 'feature/other');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: baseGitConfig,
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_wrong_target',
          recordId: 'gpr_policy_target_mismatch',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000035',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: '/repo',
        provider: 'github',
        remoteName: 'origin',
        runner,
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push refused because the repo.push policy decision is not allowed.',
        id: 'gpr_policy_target_mismatch',
        outcome: 'refused-policy',
        policyDecisionId: 'pd_wrong_target',
        reviewIds: ['swr_1'],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records auth failures when push credentials cannot be resolved', async () => {
    const workspaceDb = createWorkspaceDb();
    const runner: GitPushCommandRunner = async () => {
      throw new Error('runner should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: baseGitConfig,
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_1',
          recordId: 'gpr_auth_failed',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000036',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: '/repo',
        provider: 'github',
        remoteName: 'origin',
        resolveEnv: () => {
          throw new Error('vault-locked');
        },
        runner,
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push authentication material could not be resolved.',
        id: 'gpr_auth_failed',
        outcome: 'auth-failed',
        reviewIds: ['swr_1'],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('runs a fixed push command and records successful terminal outcomes', async () => {
    const workspaceDb = createWorkspaceDb();
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    const runner: GitPushCommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0, stderr: '', stdout: 'ok' };
    };

    try {
      recordLinkedCommit(workspaceDb);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: baseGitConfig,
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_1',
          recordId: 'gpr_pushed',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000029',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: '/repo',
        env: { GITHUB_TOKEN: 'secret-token', PATH: '/usr/bin' },
        remoteHeadAfter: 'commit_a',
        remoteHeadBefore: 'commit_0',
        remoteName: 'origin',
        runner,
      });

      expect(calls).toEqual([
        {
          args: ['push', '--porcelain', '--', 'origin', 'HEAD:refs/heads/feature/demo'],
          command: 'git',
          cwd: '/repo',
          env: { GITHUB_TOKEN: 'secret-token', GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin' },
        },
      ]);
      expect(record).toMatchObject({
        id: 'gpr_pushed',
        outcome: 'pushed',
        remoteHeadAfter: 'commit_a',
        remoteHeadBefore: 'commit_0',
        reviewIds: ['swr_1'],
      });
      expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toMatchObject([
        {
          capabilityId: 'workspace.git.push',
          family: 'network',
          operation: 'git.push',
          providerRef: 'github',
          status: 'succeeded',
        },
      ]);
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        {
          category: 'network',
          providerRef: 'github',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000029',
          source: 'git-push-executor',
          unit: 'requests',
          workspaceId: 'ws_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('pushes to a local bare remote through the host runner', async () => {
    const workspaceDb = createWorkspaceDb();
    const repoDir = mkdtempSync(join(tmpdir(), 'openkit-git-push-runner-repo-'));
    const remoteDir = mkdtempSync(join(tmpdir(), 'openkit-git-push-runner-remote-'));

    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir, stdio: 'ignore' });
      execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
        cwd: repoDir,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'OpenKit'], {
        cwd: repoDir,
        stdio: 'ignore',
      });
      execFileSync('git', ['remote', 'add', 'origin', remoteDir], {
        cwd: repoDir,
        stdio: 'ignore',
      });
      writeFileSync(join(repoDir, 'README.md'), 'initial\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
      writeFileSync(join(repoDir, 'README.md'), 'changed\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'change'], { cwd: repoDir, stdio: 'ignore' });
      const commitId = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();

      recordWorkspaceApplyResult(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000032',
        result: {
          appliedAt: '2026-07-05T00:00:00.000Z',
          appliedPaths: ['README.md'],
          changeSetId: 'wcs_2',
          commitIds: [commitId],
          conflictRecords: [],
          id: 'war_2',
          reviewId: 'swr_2',
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId: 'ws_demo',
        },
      });
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');

      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: [commitId],
          git: baseGitConfig,
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_1',
          recordId: 'gpr_local_push',
          remoteSummary: 'Local bare Git remote on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000033',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: repoDir,
        provider: 'github',
        remoteHeadAfter: commitId,
        remoteName: 'origin',
        runner: runGitPushCommand,
      });

      expect(record).toMatchObject({
        commitIds: [commitId],
        id: 'gpr_local_push',
        outcome: 'pushed',
        reviewIds: ['swr_2'],
      });
      expect(
        execFileSync('git', ['rev-parse', 'refs/heads/feature/demo'], {
          cwd: remoteDir,
          encoding: 'utf8',
        }).trim()
      ).toBe(commitId);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records non-fast-forward terminal failures from the command runner', async () => {
    const workspaceDb = createWorkspaceDb();
    const runner: GitPushCommandRunner = async () => ({
      exitCode: 1,
      stderr: '! [rejected] HEAD -> feature/demo (non-fast-forward)',
      stdout: '',
    });

    try {
      recordLinkedCommit(workspaceDb);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId: 'user_1',
          approvalNamesProtectedTarget: false,
          approvalRowId: 'har_1',
          commitIds: ['commit_a'],
          git: baseGitConfig,
          now: () => '2026-07-05T00:00:00.000Z',
          policyDecisionId: 'pd_1',
          recordId: 'gpr_rejected',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          requestId: '00000000-0000-4000-8000-000000000030',
          sourceRef: 'HEAD',
          targetBranch: 'feature/demo',
          workspaceId: 'ws_demo',
        },
        cwd: '/repo',
        remoteName: 'origin',
        runner,
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push rejected because the remote has newer commits.',
        id: 'gpr_rejected',
        outcome: 'rejected-non-fast-forward',
        reviewIds: ['swr_1'],
      });
      expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toMatchObject([
        {
          capabilityId: 'workspace.git.push',
          errorCode: 'rejected-non-fast-forward',
          family: 'network',
          operation: 'git.push',
          providerRef: 'github',
          status: 'failed',
        },
      ]);
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        {
          category: 'network',
          providerRef: 'github',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000030',
          source: 'git-push-executor',
          unit: 'requests',
          workspaceId: 'ws_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
