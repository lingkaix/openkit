// openkit-test-platform-divergence
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
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import type { WorkspaceRepositoryGitConfig } from '../workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  executeGitPushAttempt,
  type GitPushCommandRunner,
  runGitPushCommand,
} from './git-push-executor.js';
import { listGitPushRecords, type PrepareGitPushAttemptInput } from './git-push-records.js';
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
const BASE_COMMIT = '0'.repeat(40);
const SOURCE_COMMIT = 'a'.repeat(40);

/**
 * Creates the common approved push attempt used by executor tests.
 *
 * @param overrides Fields that differ in one scenario.
 * @returns Complete push preflight and record lineage input.
 */
function gitPushAttempt(
  overrides: Partial<PrepareGitPushAttemptInput> = {}
): PrepareGitPushAttemptInput {
  return {
    actorId: 'user_1',
    approvalNamesProtectedTarget: false,
    approvalRowId: 'har_1',
    commitIds: ['commit_a'],
    git: baseGitConfig,
    now: () => '2026-07-05T00:00:00.000Z',
    policyDecisionId: 'pd_1',
    recordId: 'gpr_test',
    remoteSummary: 'GitHub repository openkit on origin',
    repositoryResourceId: 'repo_default',
    requestId: '00000000-0000-4000-8000-000000000001',
    sourceRef: 'HEAD',
    targetBranch: 'feature/demo',
    workspaceId: 'ws_demo',
    ...overrides,
  };
}

/**
 * Opens a migrated workspace database for Git push executor tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb & { readonly coreDb: CoreDb } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-push-executor-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const now = Date.parse('2026-07-05T00:00:00.000Z');

  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind
      ) VALUES ('user_1', 'Git Push User', 'git-push@example.invalid', false, ?, ?, 'human')`
    )
    .run(now, now);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_1',
    workspaceId: 'ws_demo',
    now: new Date(now),
  });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return Object.assign(workspaceDb, { coreDb });
}

/**
 * Creates an empty Git repository for executor fixtures.
 *
 * @param objectFormat Git object format used by the repository.
 * @returns Repository path and object database path.
 */
function createGitRepository(objectFormat: 'sha1' | 'sha256' = 'sha1'): {
  readonly objectDirectory: string;
  readonly path: string;
} {
  const path = mkdtempSync(join(tmpdir(), 'openkit-git-push-repo-'));
  execFileSync('git', ['init', `--object-format=${objectFormat}`], { cwd: path, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
    cwd: path,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: path, stdio: 'ignore' });

  return {
    objectDirectory: execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
      { cwd: path, encoding: 'utf8' }
    ).trim(),
    path,
  };
}

/**
 * Commits one README revision and returns its immutable commit id.
 *
 * @param repositoryPath Fixture repository path.
 * @param content README content.
 * @param message Commit message.
 * @returns New commit id.
 */
function commitReadme(repositoryPath: string, content: string, message: string): string {
  writeFileSync(join(repositoryPath, 'README.md'), content);
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: repositoryPath, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryPath,
    encoding: 'utf8',
  }).trim();
}

/**
 * Records one accepted apply result for Git push linkage tests.
 *
 * @param workspaceDb Workspace database handle.
 * @param commitIds Applied commit ids linked to the review.
 */
function recordLinkedCommit(workspaceDb: WorkspaceDb, commitIds = ['commit_a']): void {
  recordWorkspaceApplyResult(workspaceDb, {
    requestId: '00000000-0000-4000-8000-000000000027',
    result: {
      appliedAt: '2026-07-05T00:00:00.000Z',
      appliedPaths: ['README.md'],
      changeSetId: 'wcs_1',
      commitIds,
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
 * @param approvalId Approval identity linked to the decision.
 */
function recordRepoPushAllowDecision(
  workspaceDb: WorkspaceDb,
  decisionId: string,
  targetBranch = 'feature/demo',
  approvalId: string | null = 'ap_repo_push_target'
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
    approvalId,
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
        attempt: gitPushAttempt({
          git: { ...baseGitConfig, allowedPushTargets: [] },
          recordId: 'gpr_refused',
          requestId: '00000000-0000-4000-8000-000000000028',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: '/repo',
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: '/repo/.git/objects',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'origin',
        runner,
        sourceCommit: 'commit_a',
      });

      expect(record).toMatchObject({ id: 'gpr_refused', outcome: 'refused-policy' });
      expect(listGitPushRecords(workspaceDb, 'ws_demo')).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('refuses missing current repo.push authority before credential or runner effects', async () => {
    const workspaceDb = createWorkspaceDb();
    const repository = createGitRepository();
    let resolverCalls = 0;
    let runnerCalls = 0;

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      workspaceDb.coreDb.sqlite
        .prepare(
          `UPDATE users
           SET status = 'disabled', disabled_at = ?, updated_at = ?
           WHERE id = 'user_1'`
        )
        .run('2026-07-05T00:00:01.000Z', '2026-07-05T00:00:01.000Z');

      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_current_authority_refused',
          requestId: '00000000-0000-4000-8000-000000000050',
        }),
        coreDb: workspaceDb.coreDb,
        objectDirectory: repository.objectDirectory,
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        resolveEnv: () => {
          resolverCalls += 1;
          return { GITHUB_TOKEN: 'secret-token' };
        },
        runner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stderr: '', stdout: '' };
        },
        sourceCommit: SOURCE_COMMIT,
      });

      expect(record).toMatchObject({
        id: 'gpr_current_authority_refused',
        outcome: 'refused-policy',
      });
      expect({ resolverCalls, runnerCalls }).toEqual({ resolverCalls: 0, runnerCalls: 0 });
      expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      workspaceDb.coreDb.sqlite.close();
    }
  });

  it('rechecks repo.push authority after reads and before the mutating push', async () => {
    const workspaceDb = createWorkspaceDb();
    const repository = createGitRepository();
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    const runner: GitPushCommandRunner = async (command) => {
      calls.push(command);
      if (calls.length === 1) {
        return {
          exitCode: 0,
          stderr: '',
          stdout: `${BASE_COMMIT}\trefs/heads/feature/demo\n`,
        };
      }
      if (calls.length === 2) {
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      if (calls.length === 3) {
        workspaceDb.coreDb.sqlite
          .prepare(
            `UPDATE users
             SET status = 'disabled', disabled_at = ?, updated_at = ?
             WHERE id = 'user_1'`
          )
          .run('2026-07-05T00:00:02.000Z', '2026-07-05T00:00:02.000Z');
        return { exitCode: 0, stderr: '', stdout: `${SOURCE_COMMIT}\n` };
      }
      throw new Error('push must not run after current authority is removed');
    };

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_authority_removed_after_read',
          requestId: '00000000-0000-4000-8000-000000000051',
        }),
        coreDb: workspaceDb.coreDb,
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: repository.objectDirectory,
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit: SOURCE_COMMIT,
      });

      expect(calls).toHaveLength(3);
      expect(record).toMatchObject({
        errorSummary: 'Git push refused because current repo.push authority was removed.',
        outcome: 'refused-policy',
        remoteHeadAfter: null,
        remoteHeadBefore: BASE_COMMIT,
      });
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        { quantity: 1, unit: 'requests' },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      workspaceDb.coreDb.sqlite.close();
    }
  });

  it('records unsupported, missing, or untrusted provider refusals without invoking the command runner', async () => {
    const workspaceDb = createWorkspaceDb();
    const runner: GitPushCommandRunner = async () => {
      throw new Error('runner should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      for (const [recordId, provider, remoteName, requestId] of [
        [
          'gpr_unsupported',
          'unsupported',
          'https://github.com/openkit/openkit.git',
          '00000000-0000-4000-8000-000000000031',
        ],
        [
          'gpr_missing_provider',
          undefined,
          'https://github.com/openkit/openkit.git',
          '00000000-0000-4000-8000-000000000037',
        ],
        ['gpr_untrusted_target', 'github', 'origin', '00000000-0000-4000-8000-000000000039'],
      ] as const) {
        const record = await executeGitPushAttempt(workspaceDb, {
          attempt: gitPushAttempt({
            recordId,
            remoteSummary: 'GitLab repository openkit on origin',
            requestId,
          }),
          coreDb: workspaceDb.coreDb,
          cwd: '/repo',
          objectFormat: 'sha1',
          provider: provider as 'github' | 'unsupported',
          remoteName,
          runner,
          sourceCommit: 'commit_a',
        });

        expect(record).toMatchObject({
          errorSummary: 'Git push refused because V1 supports GitHub remotes only.',
          id: recordId,
          outcome: 'unsupported-provider',
          reviewIds: ['swr_1'],
        });
      }
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
        attempt: gitPushAttempt({
          policyDecisionId: 'pd_missing',
          recordId: 'gpr_policy_missing',
          requestId: '00000000-0000-4000-8000-000000000034',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: '/repo',
        objectDirectory: '/repo/.git/objects',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit: 'commit_a',
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

  it('keeps imported repo.push decisions readable but refuses imported or unlinked authority', async () => {
    const workspaceDb = createWorkspaceDb();
    let runnerCalls = 0;
    const runner: GitPushCommandRunner = async () => {
      runnerCalls += 1;
      throw new Error('runner should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb);
      recordRepoPushAllowDecision(
        workspaceDb,
        'pd_imported_allow',
        'feature/demo',
        'apr_imported_ws_demo_1'
      );
      recordRepoPushAllowDecision(workspaceDb, 'pd_unlinked_allow', 'feature/demo', null);
      recordRepoPushAllowDecision(workspaceDb, 'pd_empty_allow', 'feature/demo', '');

      for (const [decisionId, recordId, requestId] of [
        ['pd_imported_allow', 'gpr_imported_authority', '00000000-0000-4000-8000-000000000047'],
        ['pd_unlinked_allow', 'gpr_unlinked_authority', '00000000-0000-4000-8000-000000000048'],
        ['pd_empty_allow', 'gpr_empty_authority', '00000000-0000-4000-8000-000000000049'],
      ] as const) {
        const record = await executeGitPushAttempt(workspaceDb, {
          attempt: gitPushAttempt({ policyDecisionId: decisionId, recordId, requestId }),
          coreDb: workspaceDb.coreDb,
          objectDirectory: '/unused',
          objectFormat: 'sha1',
          provider: 'github',
          remoteName: 'origin',
          runner,
          sourceCommit: 'commit_a',
        });

        expect(record).toMatchObject({
          id: recordId,
          outcome: 'refused-policy',
          policyDecisionId: decisionId,
        });
      }
      expect(runnerCalls).toBe(0);
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT approval_id AS approvalId, result
             FROM permission_decisions
             WHERE decision_id = ?`
          )
          .get('pd_imported_allow')
      ).toEqual({ approvalId: 'apr_imported_ws_demo_1', result: 'allow' });
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
        attempt: gitPushAttempt({
          policyDecisionId: 'pd_wrong_target',
          recordId: 'gpr_policy_target_mismatch',
          requestId: '00000000-0000-4000-8000-000000000035',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: '/repo',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit: 'commit_a',
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
    let resolvedCapabilityCallId: string | undefined;
    const runner: GitPushCommandRunner = async () => {
      throw new Error('runner should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_auth_failed',
          requestId: '00000000-0000-4000-8000-000000000036',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: '/repo',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        resolveEnv: (capabilityCallId) => {
          resolvedCapabilityCallId = capabilityCallId;
          throw new Error('vault-locked');
        },
        runner,
        sourceCommit: SOURCE_COMMIT,
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push authentication material could not be resolved.',
        id: 'gpr_auth_failed',
        outcome: 'auth-failed',
        reviewIds: ['swr_1'],
      });
      const calls = listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo');
      expect(resolvedCapabilityCallId).toBe(calls[0]?.id);
      expect(calls).toMatchObject([
        {
          capabilityId: 'workspace.git.push',
          errorCode: 'auth-failed',
          status: 'failed',
        },
      ]);
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects an unsafe source commit before resolving credentials', async () => {
    const workspaceDb = createWorkspaceDb();
    let resolvedCredentials = false;

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_unsafe_source',
          requestId: '00000000-0000-4000-8000-000000000040',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: '/repo',
        objectDirectory: '/repo/.git/objects',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        resolveEnv: () => {
          resolvedCredentials = true;
          return { GITHUB_TOKEN: 'secret-token' };
        },
        runner: async () => {
          throw new Error('runner should not be called');
        },
        sourceCommit: '+commit_a',
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push refused because the approved ref shape is not safe.',
        id: 'gpr_unsafe_source',
        outcome: 'refused-policy',
      });
      expect(resolvedCredentials).toBe(false);
      expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toEqual([]);
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('refuses to create a missing remote branch in V1', async () => {
    const workspaceDb = createWorkspaceDb();
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    const runner: GitPushCommandRunner = async (command) => {
      calls.push(command);
      if (calls.length === 1) {
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      throw new Error('missing remote branches must not reach local range checks or push');
    };

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_missing_remote_branch',
          requestId: '00000000-0000-4000-8000-000000000042',
        }),
        coreDb: workspaceDb.coreDb,
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: '/repo/.git/objects',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit: SOURCE_COMMIT,
      });

      expect(calls).toHaveLength(1);
      expect(record).toMatchObject({
        errorSummary: 'Git push refused because V1 does not create remote branches.',
        outcome: 'refused-policy',
        remoteHeadAfter: null,
        remoteHeadBefore: null,
      });
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        { quantity: 1, unit: 'requests' },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a remote head that is not an ancestor of the approved source', async () => {
    const workspaceDb = createWorkspaceDb();
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    const runner: GitPushCommandRunner = async (command) => {
      calls.push(command);
      return calls.length === 1
        ? {
            exitCode: 0,
            stderr: '',
            stdout: `${BASE_COMMIT}\trefs/heads/feature/demo\n`,
          }
        : { exitCode: 1, stderr: '', stdout: '' };
    };

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_divergent_remote_head',
          requestId: '00000000-0000-4000-8000-000000000043',
        }),
        coreDb: workspaceDb.coreDb,
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: '/repo/.git/objects',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit: SOURCE_COMMIT,
      });

      expect(calls.map((call) => call.args)).toEqual([
        [
          'ls-remote',
          '--refs',
          '--heads',
          '--',
          'https://github.com/openkit/openkit.git',
          'refs/heads/feature/demo',
        ],
        ['merge-base', '--is-ancestor', BASE_COMMIT, SOURCE_COMMIT],
      ]);
      expect(record).toMatchObject({
        outcome: 'rejected-non-fast-forward',
        remoteHeadAfter: null,
        remoteHeadBefore: BASE_COMMIT,
      });
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        { quantity: 1, unit: 'requests' },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('runs a fixed push command and records successful terminal outcomes', async () => {
    const workspaceDb = createWorkspaceDb();
    const repository = createGitRepository();
    const repositoryPath = repository.path;
    execFileSync('git', ['config', 'credential.helper', '!echo helper-should-not-run'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'http.sslVerify', 'false'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      ['config', 'url.file:///tmp/openkit-attacker/.insteadOf', 'https://github.com/'],
      { cwd: repositoryPath, stdio: 'ignore' }
    );
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    const results = [
      {
        exitCode: 0,
        stderr: '',
        stdout: `${BASE_COMMIT}\trefs/heads/feature/demo\n`,
      },
      { exitCode: 0, stderr: '', stdout: '' },
      { exitCode: 0, stderr: '', stdout: `${SOURCE_COMMIT}\n` },
      { exitCode: 0, stderr: '', stdout: 'ok' },
    ];
    const runner: GitPushCommandRunner = async (command) => {
      expect(command.cwd).not.toBe(repositoryPath);
      expect(command.env).toMatchObject({
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_DIR: command.cwd,
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OBJECT_DIRECTORY: repository.objectDirectory,
      });
      expect(command.env).not.toHaveProperty('HOME');
      expect(JSON.stringify(command)).not.toContain('secret-token');
      for (const args of [
        ['config', '--get-all', 'credential.helper'],
        ['config', '--get', 'http.sslVerify'],
        ['config', '--get-regexp', '^url\\.'],
      ]) {
        expect(() =>
          execFileSync('git', args, {
            cwd: command.cwd,
            env: command.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        ).toThrow();
      }
      calls.push(command);
      const result = results[calls.length - 1];
      if (!result) {
        throw new Error('unexpected Git command');
      }
      return result;
    };

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_pushed',
          requestId: '00000000-0000-4000-8000-000000000029',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: repositoryPath,
        env: { GITHUB_TOKEN: 'secret-token', PATH: '/usr/bin' },
        objectDirectory: repository.objectDirectory,
        objectFormat: 'sha1',
        remoteName: 'https://github.com/openkit/openkit.git',
        provider: 'github',
        runner,
        sourceCommit: SOURCE_COMMIT,
      });

      expect(calls).toHaveLength(4);
      expect(calls.map((call) => call.args)).toEqual([
        [
          'ls-remote',
          '--refs',
          '--heads',
          '--',
          'https://github.com/openkit/openkit.git',
          'refs/heads/feature/demo',
        ],
        ['merge-base', '--is-ancestor', BASE_COMMIT, SOURCE_COMMIT],
        ['rev-list', '--reverse', '--topo-order', `${BASE_COMMIT}..${SOURCE_COMMIT}`],
        [
          'push',
          '--porcelain',
          '--no-verify',
          `--force-with-lease=refs/heads/feature/demo:${BASE_COMMIT}`,
          '--',
          'https://github.com/openkit/openkit.git',
          `${SOURCE_COMMIT}:refs/heads/feature/demo`,
        ],
      ]);
      expect(record).toMatchObject({
        id: 'gpr_pushed',
        outcome: 'pushed',
        remoteHeadAfter: SOURCE_COMMIT,
        remoteHeadBefore: BASE_COMMIT,
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
          quantity: 2,
          requestId: '00000000-0000-4000-8000-000000000029',
          responsibleUserId: 'user_1',
          source: 'git-push-executor',
          unit: 'requests',
          workspaceId: 'ws_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('matches the isolated Git view to a SHA-256 repository object format', async () => {
    const workspaceDb = createWorkspaceDb();
    const repository = createGitRepository('sha256');
    const baseCommit = commitReadme(repository.path, 'base\n', 'base');
    const sourceCommit = commitReadme(repository.path, 'source\n', 'source');
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    const observedFormats: string[] = [];
    const runner: GitPushCommandRunner = async (command) => {
      calls.push(command);
      observedFormats.push(
        execFileSync('git', ['rev-parse', '--show-object-format'], {
          cwd: command.cwd,
          encoding: 'utf8',
          env: command.env,
        }).trim()
      );
      if (command.args[0] === 'ls-remote') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: `${baseCommit}\trefs/heads/feature/demo\n`,
        };
      }
      if (command.args[0] === 'push') {
        return { exitCode: 0, stderr: '', stdout: 'ok' };
      }
      return runGitPushCommand(command);
    };

    try {
      recordLinkedCommit(workspaceDb, [sourceCommit]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [sourceCommit],
          recordId: 'gpr_sha256',
          requestId: '00000000-0000-4000-8000-000000000044',
        }),
        coreDb: workspaceDb.coreDb,
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: repository.objectDirectory,
        objectFormat: 'sha256',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit,
      });

      expect(calls).toHaveLength(4);
      expect(observedFormats).toEqual(['sha256', 'sha256', 'sha256', 'sha256']);
      expect(record).toMatchObject({
        outcome: 'pushed',
        remoteHeadAfter: sourceCommit,
        remoteHeadBefore: baseCommit,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('refuses an unapproved commit hidden by a replace ref on an existing remote branch', async () => {
    const workspaceDb = createWorkspaceDb();
    const repository = createGitRepository();
    const repositoryPath = repository.path;
    const baseCommit = commitReadme(repositoryPath, 'base\n', 'base');
    const hiddenCommit = commitReadme(repositoryPath, 'hidden\n', 'hidden');
    const sourceCommit = commitReadme(repositoryPath, 'source\n', 'source');
    execFileSync('git', ['replace', '--graft', sourceCommit, baseCommit], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    expect(
      execFileSync('git', ['rev-list', '--reverse', `${baseCommit}..${sourceCommit}`], {
        cwd: repositoryPath,
        encoding: 'utf8',
      }).trim()
    ).toBe(sourceCommit);
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    let observedOutgoing: string[] = [];
    const runner: GitPushCommandRunner = async (command) => {
      calls.push(command);
      if (calls.length === 1) {
        return {
          exitCode: 0,
          stderr: '',
          stdout: `${baseCommit}\trefs/heads/feature/demo\n`,
        };
      }
      if (calls.length === 2 || calls.length === 3) {
        expect(command.env).not.toHaveProperty('GIT_CONFIG_VALUE_1');
        const result = await runGitPushCommand(command);
        if (calls.length === 3) {
          observedOutgoing = result.stdout.trim().split(/\r?\n/);
        }
        return result;
      }
      throw new Error('push should not be called');
    };

    try {
      recordLinkedCommit(workspaceDb, [sourceCommit]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [sourceCommit],
          recordId: 'gpr_hidden_ancestor',
          requestId: '00000000-0000-4000-8000-000000000041',
        }),
        coreDb: workspaceDb.coreDb,
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: repository.objectDirectory,
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit,
      });

      expect(observedOutgoing).toEqual([hiddenCommit, sourceCommit]);
      expect(calls).toHaveLength(3);
      expect(record).toMatchObject({
        errorSummary: 'Git push refused because approved commits do not match the outgoing range.',
        id: 'gpr_hidden_ancestor',
        outcome: 'refused-linkage',
        remoteHeadAfter: null,
        remoteHeadBefore: baseCommit,
      });
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        { quantity: 1, unit: 'requests' },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a push when the remote head changes after outgoing commits are checked', async () => {
    const workspaceDb = createWorkspaceDb();
    const repository = createGitRepository();
    const repositoryPath = repository.path;
    const remotePath = mkdtempSync(join(tmpdir(), 'openkit-git-push-cas-remote-'));
    execFileSync('git', ['init', '--bare'], { cwd: remotePath, stdio: 'ignore' });
    const baseCommit = commitReadme(repositoryPath, 'base\n', 'base');
    execFileSync('git', ['push', remotePath, `${baseCommit}:refs/heads/feature/demo`], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    const intermediateCommit = commitReadme(repositoryPath, 'intermediate\n', 'intermediate');
    execFileSync('git', ['push', remotePath, `${intermediateCommit}:refs/heads/staging`], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['update-ref', '-d', 'refs/heads/staging'], {
      cwd: remotePath,
      stdio: 'ignore',
    });
    const sourceCommit = commitReadme(repositoryPath, 'source\n', 'source');
    const canonicalRemote = 'https://github.com/openkit/openkit.git';
    const calls: Parameters<GitPushCommandRunner>[0][] = [];
    const runner: GitPushCommandRunner = async (command) => {
      calls.push(command);
      if (command.args[0] === 'push') {
        execFileSync(
          'git',
          ['update-ref', 'refs/heads/feature/demo', intermediateCommit, baseCommit],
          { cwd: remotePath, stdio: 'ignore' }
        );
      }
      return runGitPushCommand({
        ...command,
        args: command.args.map((arg) => (arg === canonicalRemote ? remotePath : arg)),
      });
    };

    try {
      recordLinkedCommit(workspaceDb, [intermediateCommit, sourceCommit]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [intermediateCommit, sourceCommit],
          recordId: 'gpr_cas_race',
          requestId: '00000000-0000-4000-8000-000000000045',
        }),
        coreDb: workspaceDb.coreDb,
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: repository.objectDirectory,
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: canonicalRemote,
        runner,
        sourceCommit,
      });

      expect(calls).toHaveLength(4);
      expect(calls.at(-1)?.args).toContain(
        `--force-with-lease=refs/heads/feature/demo:${baseCommit}`
      );
      expect(record).toMatchObject({
        outcome: 'rejected-non-fast-forward',
        remoteHeadAfter: null,
        remoteHeadBefore: baseCommit,
      });
      expect(
        execFileSync('git', ['rev-parse', 'refs/heads/feature/demo'], {
          cwd: remotePath,
          encoding: 'utf8',
        }).trim()
      ).toBe(intermediateCommit);
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        { quantity: 2, unit: 'requests' },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('runs one fixed Git command against a local bare remote', async () => {
    const repository = createGitRepository();
    const repoDir = repository.path;
    const remoteDir = mkdtempSync(join(tmpdir(), 'openkit-git-push-runner-remote-'));

    execFileSync('git', ['init', '--bare'], { cwd: remoteDir, stdio: 'ignore' });
    const commitId = commitReadme(repoDir, 'changed\n', 'change');

    const result = await runGitPushCommand({
      args: ['push', '--porcelain', '--', remoteDir, `${commitId}:refs/heads/feature/demo`],
      command: 'git',
      cwd: repoDir,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });

    expect(result.exitCode).toBe(0);
    expect(
      execFileSync('git', ['rev-parse', 'refs/heads/feature/demo'], {
        cwd: remoteDir,
        encoding: 'utf8',
      }).trim()
    ).toBe(commitId);
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
        attempt: gitPushAttempt({
          recordId: 'gpr_rejected',
          requestId: '00000000-0000-4000-8000-000000000030',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: '/repo',
        env: { GITHUB_TOKEN: 'secret-token' },
        objectDirectory: '/repo/.git/objects',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        runner,
        sourceCommit: SOURCE_COMMIT,
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

  it('records a terminal failure when the command runner throws', async () => {
    const workspaceDb = createWorkspaceDb();
    let resolvedCapabilityCallId: string | undefined;
    const runner: GitPushCommandRunner = async () => {
      throw new Error('spawn exposed a secret');
    };

    try {
      recordLinkedCommit(workspaceDb, [SOURCE_COMMIT]);
      recordRepoPushAllowDecision(workspaceDb, 'pd_1');
      const record = await executeGitPushAttempt(workspaceDb, {
        attempt: gitPushAttempt({
          commitIds: [SOURCE_COMMIT],
          recordId: 'gpr_runner_failure',
          requestId: '00000000-0000-4000-8000-000000000038',
        }),
        coreDb: workspaceDb.coreDb,
        cwd: '/repo',
        objectDirectory: '/repo/.git/objects',
        objectFormat: 'sha1',
        provider: 'github',
        remoteName: 'https://github.com/openkit/openkit.git',
        resolveEnv: (capabilityCallId) => {
          resolvedCapabilityCallId = capabilityCallId;
          return { GITHUB_TOKEN: 'secret-token' };
        },
        runner,
        sourceCommit: SOURCE_COMMIT,
      });

      expect(record).toMatchObject({
        errorSummary: 'Git push failed before the remote head could be updated.',
        id: 'gpr_runner_failure',
        outcome: 'remote-unreachable',
        reviewIds: ['swr_1'],
      });
      expect(JSON.stringify(record)).not.toContain('spawn exposed a secret');
      expect(listGitPushRecords(workspaceDb, 'ws_demo')).toEqual([record]);
      const calls = listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo');
      expect(resolvedCapabilityCallId).toBe(calls[0]?.id);
      expect(calls).toMatchObject([
        {
          capabilityId: 'workspace.git.push',
          errorCode: 'git_push_runner_error',
          status: 'failed',
        },
      ]);
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        {
          category: 'network',
          providerRef: 'github',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000038',
          source: 'git-push-executor',
          unit: 'requests',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
