import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSyncReviewItemSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import type { WorkspaceRepositoryResourceRecord } from '../workspace/repository-store.js';
import {
  applyGitWorkspaceReview,
  discardGitWorkspaceReview,
  stageGitWorkspaceReview,
} from './workspace-review-git.js';

/**
 * Runs one Git command in a test repository and returns trimmed stdout.
 *
 * @param cwd Repository working directory.
 * @param args Fixed Git arguments.
 * @returns Trimmed command output.
 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Creates one test commit with explicit tree, parent, message, and attribution.
 *
 * @param cwd Repository working directory.
 * @param treeId Exact tree id.
 * @param parentId Exact parent commit id.
 * @param message Commit message.
 * @param authorName Author and committer name.
 * @param authorEmail Author and committer email.
 * @returns Created commit id.
 */
function commitTree(
  cwd: string,
  treeId: string,
  parentId: string,
  message: string,
  authorName: string,
  authorEmail: string
): string {
  return execFileSync('git', ['commit-tree', treeId, '-p', parentId], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_AUTHOR_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
    },
    input: `${message}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Creates one linked repository, worker lineage, and validated Git review fixture.
 *
 * @param options Fixture behavior overrides.
 * @returns Git review fixture.
 */
function createFixture(
  options: { readonly commitOnApply?: boolean; readonly includeUndeclaredPath?: boolean } = {}
) {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-git-test-'));
  execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
  git(repositoryPath, ['config', 'user.email', 'repository@example.invalid']);
  git(repositoryPath, ['config', 'user.name', 'Repository User']);
  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n', 'utf8');
  writeFileSync(join(repositoryPath, 'secret.txt'), 'unchanged\n', 'utf8');
  git(repositoryPath, ['add', 'README.md', 'secret.txt']);
  git(repositoryPath, ['commit', '-m', 'initial']);
  const baseCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
  const initialBranch = git(repositoryPath, ['branch', '--show-current']);

  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n\nReviewed.\n', 'utf8');
  if (options.includeUndeclaredPath) {
    writeFileSync(join(repositoryPath, 'secret.txt'), 'changed but undeclared\n', 'utf8');
  }
  const patchText = git(repositoryPath, ['diff', '--binary', '--no-ext-diff']);
  git(repositoryPath, ['restore', 'README.md', 'secret.txt']);
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;

  const store = new FsStore();
  const workspace = store.createWorkspace('Git review fixture');
  const thread = store.createThread(workspace.id, 'Review changes');
  const turn = store.createTurn(workspace.id, thread.id, 'Prepare a patch', {
    kind: 'user',
    id: 'user_local',
  });
  const timestamp = '2026-07-11T00:00:00.000Z';
  const review = WorkspaceSyncReviewItemSchema.parse({
    artifactId: 'ar_git_review_1',
    changeSet: {
      artifactIds: ['ar_git_review_1'],
      base: { commit: baseCommit, contentDigest: null },
      bundle: null,
      changedPaths: [{ binary: false, path: 'README.md', status: 'modified' }],
      createdAt: timestamp,
      evidenceRefs: [{ kind: 'worker', ref: turn.id }],
      head: { commit: 'f'.repeat(baseCommit.length), contentDigest: null },
      id: 'wcs_git_review_1',
      inputSnapshotId: 'wis_git_review_1',
      materializationRecordId: 'wmr_git_review_1',
      patch: {
        bytes: Buffer.byteLength(patchText, 'utf8'),
        digest: patchDigest,
        ref: 'worker-session://workspace.patch',
      },
      redaction: { notes: [], status: 'redacted' },
      resourceId: 'repo_default',
      strategy: 'git',
      workspaceId: workspace.id,
    },
    patchPayload: {
      bytes: Buffer.byteLength(patchText, 'utf8'),
      digest: patchDigest,
      mediaType: 'text/x-diff',
      text: patchText,
    },
    review: {
      actionCenterRowId: 'workspace-review:swr_git_review_1',
      changeSetId: 'wcs_git_review_1',
      createdAt: timestamp,
      diffSummary: { additions: 2, deletions: 0, filesChanged: 1 },
      id: 'swr_git_review_1',
      riskSummary: 'One reviewed path.',
      staging: {
        branch: 'openkit/review/swr_git_review_1',
        ref: 'staging://workspace/wcs_git_review_1',
        strategy: 'git_worktree',
      },
      status: 'pending',
      updatedAt: timestamp,
      validation: [],
      workspaceId: workspace.id,
    },
  });
  const repository: WorkspaceRepositoryResourceRecord = {
    createdAt: timestamp,
    diagnosticsStatus: 'ready',
    displayName: 'Git review fixture',
    git: {
      allowedPushTargets: [],
      authorEmail: 'approver@example.invalid',
      authorName: 'Approving Human',
      commitOnApply: options.commitOnApply ?? true,
      protectedBranchPatterns: ['main', 'master'],
      requireReviewLinkage: true,
      stagingStrategy: 'review-branch',
      vaultGrantRef: null,
    },
    localPath: repositoryPath,
    resourceId: 'repo_default',
    type: 'git_repository',
    updatedAt: timestamp,
    workspaceId: workspace.id,
  };

  return { baseCommit, initialBranch, repository, repositoryPath, review, store };
}

describe('workspace review Git operations', () => {
  it('stages a review branch without switching or dirtying the linked worktree', async () => {
    const fixture = createFixture();
    let persistedHead: string | null = null;

    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: (commitId) => {
        persistedHead = commitId;
      },
    });

    expect(persistedHead).toBe(stagedCommit);
    expect(git(fixture.repositoryPath, ['branch', '--show-current'])).toBe(fixture.initialBranch);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
    expect(git(fixture.repositoryPath, ['show', '--pretty=', '--name-only', stagedCommit])).toBe(
      'README.md'
    );
    expect(
      git(fixture.repositoryPath, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
    ).toHaveLength(1);
  });

  it('rejects patches whose actual paths differ from the declared change set', async () => {
    const fixture = createFixture({ includeUndeclaredPath: true });
    let persisted = false;

    await expect(
      stageGitWorkspaceReview({
        repository: fixture.repository,
        review: fixture.review,
        store: fixture.store,
        persistHead: () => {
          persisted = true;
        },
      })
    ).rejects.toThrow('path set');

    expect(persisted).toBe(false);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
    expect(() =>
      git(fixture.repositoryPath, [
        'rev-parse',
        '--verify',
        'refs/heads/openkit/review/swr_git_review_1',
      ])
    ).toThrow();
  });

  it('does not overwrite an existing review branch', async () => {
    const fixture = createFixture();
    git(fixture.repositoryPath, ['branch', 'openkit/review/swr_git_review_1', fixture.baseCommit]);

    await expect(
      stageGitWorkspaceReview({
        repository: fixture.repository,
        review: fixture.review,
        store: fixture.store,
        persistHead: () => {},
      })
    ).rejects.toThrow();

    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(fixture.baseCommit);
  });

  it('adopts an exact reserved branch but rejects conflicting message or attribution', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const treeId = git(fixture.repositoryPath, ['show', '-s', '--format=%T', stagedCommit]);
    const message = git(fixture.repositoryPath, ['show', '-s', '--format=%B', stagedCommit]);
    const attribution = git(fixture.repositoryPath, [
      'show',
      '-s',
      '--format=%an <%ae>|%cn <%ce>',
      stagedCommit,
    ]);
    const wrongMessageCommit = commitTree(
      fixture.repositoryPath,
      treeId,
      fixture.baseCommit,
      `${message}\nConflicting-Review: true`,
      fixture.repository.git.authorName ?? '',
      fixture.repository.git.authorEmail ?? ''
    );
    const wrongAttributionCommit = commitTree(
      fixture.repositoryPath,
      treeId,
      fixture.baseCommit,
      message,
      'Conflicting Author',
      'conflicting@example.invalid'
    );
    let persistedHead: string | null = null;

    expect(git(fixture.repositoryPath, ['show', '-s', '--format=%T', wrongMessageCommit])).toBe(
      treeId
    );
    expect(git(fixture.repositoryPath, ['show', '-s', '--format=%P', wrongMessageCommit])).toBe(
      fixture.baseCommit
    );
    expect(git(fixture.repositoryPath, ['show', '-s', '--format=%B', wrongMessageCommit])).not.toBe(
      message
    );
    expect(
      git(fixture.repositoryPath, [
        'show',
        '-s',
        '--format=%an <%ae>|%cn <%ce>',
        wrongMessageCommit,
      ])
    ).toBe(attribution);
    expect(git(fixture.repositoryPath, ['show', '-s', '--format=%T', wrongAttributionCommit])).toBe(
      treeId
    );
    expect(git(fixture.repositoryPath, ['show', '-s', '--format=%P', wrongAttributionCommit])).toBe(
      fixture.baseCommit
    );
    expect(git(fixture.repositoryPath, ['show', '-s', '--format=%B', wrongAttributionCommit])).toBe(
      message
    );
    expect(
      git(fixture.repositoryPath, [
        'show',
        '-s',
        '--format=%an <%ae>|%cn <%ce>',
        wrongAttributionCommit,
      ])
    ).not.toBe(attribution);

    git(fixture.repositoryPath, [
      'branch',
      '-f',
      'openkit/review/swr_git_review_1',
      wrongMessageCommit,
    ]);
    await expect(
      stageGitWorkspaceReview({
        repository: fixture.repository,
        review: fixture.review,
        store: fixture.store,
        persistHead: (commitId) => {
          persistedHead = commitId;
        },
      })
    ).rejects.toThrow();
    expect(persistedHead).toBeNull();
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(wrongMessageCommit);

    git(fixture.repositoryPath, [
      'branch',
      '-f',
      'openkit/review/swr_git_review_1',
      wrongAttributionCommit,
    ]);
    await expect(
      stageGitWorkspaceReview({
        repository: fixture.repository,
        review: fixture.review,
        store: fixture.store,
        persistHead: (commitId) => {
          persistedHead = commitId;
        },
      })
    ).rejects.toThrow();
    expect(persistedHead).toBeNull();
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(wrongAttributionCommit);

    git(fixture.repositoryPath, ['branch', '-f', 'openkit/review/swr_git_review_1', stagedCommit]);
    await expect(
      stageGitWorkspaceReview({
        repository: fixture.repository,
        review: fixture.review,
        store: fixture.store,
        persistHead: (commitId) => {
          persistedHead = commitId;
        },
      })
    ).resolves.toBe(stagedCommit);
    expect(persistedHead).toBe(stagedCommit);
  });

  it('rejects a linked repository whose core.worktree escapes the configured path', async () => {
    const fixture = createFixture();
    const escapedWorktree = mkdtempSync(join(tmpdir(), 'openkit-worktree-escape-test-'));
    let persisted = false;
    git(fixture.repositoryPath, ['config', 'core.worktree', escapedWorktree]);

    await expect(
      stageGitWorkspaceReview({
        repository: fixture.repository,
        review: fixture.review,
        store: fixture.store,
        persistHead: () => {
          persisted = true;
        },
      })
    ).rejects.toThrow('escapes its configured path');

    expect(persisted).toBe(false);
  });

  it('rejects touched paths with Git clean filters before executing repository commands', async () => {
    const fixture = createFixture();
    const sentinelPath = join(fixture.repositoryPath, '.git', 'filter-executed');
    writeFileSync(
      join(fixture.repositoryPath, '.git', 'info', 'attributes'),
      'README.md filter=host-command\n',
      'utf8'
    );
    git(fixture.repositoryPath, ['config', 'filter.host-command.clean', `tee ${sentinelPath}`]);
    let persisted = false;

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review: fixture.review,
        store: fixture.store,
      })
    ).rejects.toThrow(/filter/i);

    expect(persisted).toBe(false);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it('rolls back the worktree, index, HEAD, and review ref when persistence fails', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    writeFileSync(join(fixture.repositoryPath, 'unrelated.txt'), 'Keep staged.\n', 'utf8');
    git(fixture.repositoryPath, ['add', 'unrelated.txt']);

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T00:01:00.000Z',
        persistResult: () => {
          throw new Error('database failed');
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow('database failed');

    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe('# Demo\n');
    expect(git(fixture.repositoryPath, ['diff', '--cached', '--name-only'])).toBe('unrelated.txt');
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
    expect(
      git(fixture.repositoryPath, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
    ).toHaveLength(1);
  });

  it('persists an exact commit-on-apply retry without reapplying or changing unrelated state', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    const treeId = git(fixture.repositoryPath, ['show', '-s', '--format=%T', stagedCommit]);
    const appliedMessage = git(fixture.repositoryPath, ['show', '-s', '--format=%B', stagedCommit])
      .replace(/^Stage workspace review /, 'Apply workspace review ')
      .replace('\nStaged-By: OpenKit', '');
    const appliedCommit = commitTree(
      fixture.repositoryPath,
      treeId,
      fixture.baseCommit,
      appliedMessage,
      fixture.repository.git.authorName ?? '',
      fixture.repository.git.authorEmail ?? ''
    );
    git(fixture.repositoryPath, ['reset', '--hard', appliedCommit]);
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    writeFileSync(join(fixture.repositoryPath, 'unrelated.txt'), 'Keep staged.\n', 'utf8');
    git(fixture.repositoryPath, ['add', 'unrelated.txt']);
    writeFileSync(join(fixture.repositoryPath, 'local-only.txt'), 'Keep untracked.\n', 'utf8');
    const statusBefore = git(fixture.repositoryPath, ['status', '--short']);
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T00:02:00.000Z',
      persistResult: (value) => {
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(result.commitIds).toEqual([appliedCommit]);
    expect(persistedResult).toEqual(result);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(appliedCommit);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe(statusBefore);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe(
      '# Demo\n\nReviewed.\n'
    );
    expect(readFileSync(join(fixture.repositoryPath, 'unrelated.txt'), 'utf8')).toBe(
      'Keep staged.\n'
    );
    expect(readFileSync(join(fixture.repositoryPath, 'local-only.txt'), 'utf8')).toBe(
      'Keep untracked.\n'
    );
    expect(() =>
      git(fixture.repositoryPath, [
        'rev-parse',
        '--verify',
        'refs/heads/openkit/review/swr_git_review_1',
      ])
    ).toThrow();
  });

  it('rejects a commit-on-apply retry when an ignored path no longer matches its reviewed deletion', async () => {
    const fixture = createFixture();
    git(fixture.repositoryPath, ['rm', 'README.md']);
    const patchText = git(fixture.repositoryPath, [
      'diff',
      '--cached',
      '--binary',
      '--no-ext-diff',
    ]);
    git(fixture.repositoryPath, ['reset', '--hard', fixture.baseCommit]);
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: false,
        oldPermissions: '0644',
        path: 'README.md',
        status: 'deleted',
      },
    ]);
    const stagedCommit = await stageGitWorkspaceReview({
      persistHead: () => {},
      repository: fixture.repository,
      review,
      store: fixture.store,
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...review,
      changeSet: {
        ...review.changeSet,
        head: { ...review.changeSet.head, commit: stagedCommit },
      },
    });
    const treeId = git(fixture.repositoryPath, ['show', '-s', '--format=%T', stagedCommit]);
    const appliedMessage = git(fixture.repositoryPath, ['show', '-s', '--format=%B', stagedCommit])
      .replace(/^Stage workspace review /, 'Apply workspace review ')
      .replace('\nStaged-By: OpenKit', '');
    const appliedCommit = commitTree(
      fixture.repositoryPath,
      treeId,
      fixture.baseCommit,
      appliedMessage,
      fixture.repository.git.authorName ?? '',
      fixture.repository.git.authorEmail ?? ''
    );
    git(fixture.repositoryPath, ['reset', '--hard', appliedCommit]);
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    writeFileSync(join(fixture.repositoryPath, '.git', 'info', 'exclude'), 'README.md\n', 'utf8');
    writeFileSync(join(fixture.repositoryPath, 'README.md'), 'Foreign ignored content.\n', 'utf8');
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
    let persisted = false;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T00:02:15.000Z',
        persistResult: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow(/target paths|reviewed tree|clean/i);

    expect(persisted).toBe(false);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(appliedCommit);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe(
      'Foreign ignored content.\n'
    );
  });

  it('finishes a commit-on-apply retry whose exact patch already reached the index and worktree', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    writeFileSync(join(fixture.repositoryPath, 'unrelated.txt'), 'Keep staged.\n', 'utf8');
    git(fixture.repositoryPath, ['add', 'unrelated.txt']);
    const patchText = fixture.review.patchPayload?.text ?? '';
    execFileSync('git', ['apply', '--index', '--whitespace=nowarn', '-'], {
      cwd: fixture.repositoryPath,
      input: patchText.endsWith('\n') ? patchText : `${patchText}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T00:02:30.000Z',
      persistResult: (value) => {
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(result.commitIds).toHaveLength(1);
    expect(persistedResult).toEqual(result);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(result.commitIds[0]);
    expect(
      Date.parse(
        git(fixture.repositoryPath, ['show', '-s', '--format=%aI', result.commitIds[0] ?? ''])
      )
    ).toBe(Date.parse('2026-07-11T00:02:30Z'));
    expect(git(fixture.repositoryPath, ['diff', '--cached', '--name-only'])).toBe('unrelated.txt');
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe(
      '# Demo\n\nReviewed.\n'
    );
    expect(() =>
      git(fixture.repositoryPath, [
        'rev-parse',
        '--verify',
        'refs/heads/openkit/review/swr_git_review_1',
      ])
    ).toThrow();
  });

  it.each([
    'message',
    'identity',
    'tree',
  ] as const)('rejects an already-applied commit with conflicting %s', async (conflict) => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    const appliedMessage = git(fixture.repositoryPath, ['show', '-s', '--format=%B', stagedCommit])
      .replace(/^Stage workspace review /, 'Apply workspace review ')
      .replace('\nStaged-By: OpenKit', '');
    const conflictingCommit = commitTree(
      fixture.repositoryPath,
      conflict === 'tree'
        ? git(fixture.repositoryPath, ['show', '-s', '--format=%T', fixture.baseCommit])
        : git(fixture.repositoryPath, ['show', '-s', '--format=%T', stagedCommit]),
      fixture.baseCommit,
      conflict === 'message' ? `${appliedMessage}\nConflicting-Review: true` : appliedMessage,
      conflict === 'identity' ? 'Conflicting Author' : (fixture.repository.git.authorName ?? ''),
      conflict === 'identity'
        ? 'conflicting@example.invalid'
        : (fixture.repository.git.authorEmail ?? '')
    );
    git(fixture.repositoryPath, ['reset', '--hard', conflictingCommit]);
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    let persisted = false;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T00:02:00.000Z',
        persistResult: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow();

    expect(persisted).toBe(false);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(conflictingCommit);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
  });

  it('persists a no-commit apply retry when the exact patch is already present', async () => {
    const fixture = createFixture({ commitOnApply: false });
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    const patchText = fixture.review.patchPayload?.text ?? '';
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: fixture.repositoryPath,
      input: patchText.endsWith('\n') ? patchText : `${patchText}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    writeFileSync(join(fixture.repositoryPath, 'unrelated.txt'), 'Keep staged.\n', 'utf8');
    git(fixture.repositoryPath, ['add', 'unrelated.txt']);
    const statusBefore = git(fixture.repositoryPath, ['status', '--short']);
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T00:03:00.000Z',
      persistResult: (value) => {
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(result.commitIds).toEqual([]);
    expect(persistedResult).toEqual(result);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe(statusBefore);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe(
      '# Demo\n\nReviewed.\n'
    );
  });

  it('restores a discarded review branch when decision persistence fails', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });

    await expect(
      discardGitWorkspaceReview({
        persistDecision: () => {
          throw new Error('decision database failed');
        },
        repository: fixture.repository,
        review: stagedReview,
      })
    ).rejects.toThrow('decision database failed');

    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
  });

  it('persists a discard retry when the expected review branch is already absent', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    let persistenceCalls = 0;
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);

    await expect(
      discardGitWorkspaceReview({
        persistDecision: () => {
          persistenceCalls += 1;
        },
        repository: fixture.repository,
        review: stagedReview,
      })
    ).resolves.toBeUndefined();

    expect(persistenceCalls).toBe(1);
    expect(() =>
      git(fixture.repositoryPath, [
        'rev-parse',
        '--verify',
        'refs/heads/openkit/review/swr_git_review_1',
      ])
    ).toThrow();
  });
});

describe('workspace review Git ref ownership safety', () => {
  it.each([
    'apply',
    'discard',
  ] as const)('rejects %s while the review branch is checked out in another worktree', async (operation) => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    const linkedWorktree = mkdtempSync(join(tmpdir(), 'openkit-review-branch-owner-test-'));
    git(fixture.repositoryPath, [
      'worktree',
      'add',
      linkedWorktree,
      'openkit/review/swr_git_review_1',
    ]);
    let persisted = false;

    const decision =
      operation === 'apply'
        ? applyGitWorkspaceReview({
            appliedAt: '2026-07-11T00:04:00.000Z',
            persistResult: () => {
              persisted = true;
            },
            repository: fixture.repository,
            review: stagedReview,
            store: fixture.store,
          })
        : discardGitWorkspaceReview({
            persistDecision: () => {
              persisted = true;
            },
            repository: fixture.repository,
            review: stagedReview,
          });

    await expect(decision).rejects.toThrow(/checked out|worktree/i);

    expect(persisted).toBe(false);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
    expect(git(linkedWorktree, ['rev-parse', 'HEAD'])).toBe(stagedCommit);
    expect(git(linkedWorktree, ['status', '--short'])).toBe('');
    expect(readFileSync(join(linkedWorktree, 'README.md'), 'utf8')).toBe('# Demo\n\nReviewed.\n');
  });

  it('does not reset foreign worktree state after apply rollback loses ref ownership', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    let foreignHead: string | null = null;
    let foreignIndexTree: string | null = null;
    let foreignReadme: string | null = null;
    let foreignStatus: string | null = null;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T00:05:00.000Z',
        persistResult: () => {
          writeFileSync(join(fixture.repositoryPath, 'foreign.txt'), 'Foreign owner.\n', 'utf8');
          git(fixture.repositoryPath, ['add', 'foreign.txt']);
          git(fixture.repositoryPath, ['commit', '-m', 'foreign owner']);
          foreignHead = git(fixture.repositoryPath, ['rev-parse', 'HEAD']);
          git(fixture.repositoryPath, [
            'update-ref',
            'refs/heads/openkit/review/swr_git_review_1',
            foreignHead,
          ]);
          foreignIndexTree = git(fixture.repositoryPath, ['write-tree']);
          foreignReadme = readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8');
          foreignStatus = git(fixture.repositoryPath, ['status', '--short']);
          throw new Error('database failed after foreign takeover');
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow();

    expect(foreignHead).not.toBeNull();
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(foreignHead);
    expect(git(fixture.repositoryPath, ['write-tree'])).toBe(foreignIndexTree);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe(foreignReadme);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe(foreignStatus);
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(foreignHead);
    expect(readFileSync(join(fixture.repositoryPath, 'foreign.txt'), 'utf8')).toBe(
      'Foreign owner.\n'
    );
  });
});

/**
 * Replaces the default fixture patch while preserving its valid worker lineage.
 *
 * @param fixture Base Git review fixture.
 * @param patchText Exact patch payload.
 * @param changedPaths Declared changed-path metadata parsed by the public schema.
 * @returns Validated review item for the replacement patch.
 */
function createStateIntegrityReview(
  fixture: ReturnType<typeof createFixture>,
  patchText: string,
  changedPaths: unknown
) {
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  return WorkspaceSyncReviewItemSchema.parse({
    ...fixture.review,
    changeSet: {
      ...fixture.review.changeSet,
      changedPaths,
      patch: {
        bytes: Buffer.byteLength(patchText, 'utf8'),
        digest: patchDigest,
        ref: 'worker-session://workspace.patch',
      },
    },
    patchPayload: {
      bytes: Buffer.byteLength(patchText, 'utf8'),
      digest: patchDigest,
      mediaType: 'text/x-diff',
      text: patchText,
    },
  });
}

/**
 * Stages one state-integrity fixture and returns the review with its durable staged head.
 *
 * @param fixture Git review fixture.
 * @param review Review item to stage.
 * @returns Staged commit and validated review item.
 */
async function stageStateIntegrityReview(
  fixture: ReturnType<typeof createFixture>,
  review: ReturnType<typeof createStateIntegrityReview>
) {
  const stagedCommit = await stageGitWorkspaceReview({
    repository: fixture.repository,
    review,
    store: fixture.store,
    persistHead: () => {},
  });
  return {
    stagedCommit,
    stagedReview: WorkspaceSyncReviewItemSchema.parse({
      ...review,
      changeSet: {
        ...review.changeSet,
        head: { ...review.changeSet.head, commit: stagedCommit },
      },
    }),
  };
}

describe('workspace review Git no-commit state integrity', () => {
  it('rejects live clean filters before recovery hashes unreviewed worktree bytes', async () => {
    const fixture = createFixture({ commitOnApply: false });
    const { stagedCommit, stagedReview } = await stageStateIntegrityReview(fixture, fixture.review);
    const sentinelPath = join(fixture.repositoryPath, '.git', 'live-filter-executed');
    writeFileSync(
      join(fixture.repositoryPath, '.gitattributes'),
      'README.md filter=host-command\n',
      'utf8'
    );
    git(fixture.repositoryPath, [
      'config',
      'filter.host-command.clean',
      `sed 's/Unreviewed/Reviewed/' | tee ${sentinelPath}`,
    ]);
    writeFileSync(join(fixture.repositoryPath, 'README.md'), '# Demo\n\nUnreviewed.\n', 'utf8');
    let persisted = false;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T00:59:00.000Z',
        persistResult: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow(/filter/i);

    expect(persisted).toBe(false);
    expect(existsSync(sentinelPath)).toBe(false);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toContain(
      'Unreviewed.'
    );
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
  });

  it.each([
    ['assume-unchanged', '--assume-unchanged'],
    ['skip-worktree', '--skip-worktree'],
  ] as const)('rejects a touched path marked %s before applying', async (_label, indexFlag) => {
    const fixture = createFixture({ commitOnApply: false });
    const { stagedCommit, stagedReview } = await stageStateIntegrityReview(fixture, fixture.review);
    git(fixture.repositoryPath, ['update-index', indexFlag, 'README.md']);
    let persisted = false;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T01:00:00.000Z',
        persistResult: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow(/index|flag|state/i);

    expect(persisted).toBe(false);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe('# Demo\n');
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
  });

  it('recovers an already-applied added file after a no-commit persistence crash', async () => {
    const fixture = createFixture({ commitOnApply: false });
    const addedPath = join(fixture.repositoryPath, 'added.txt');
    writeFileSync(addedPath, 'Added by review.\n', 'utf8');
    git(fixture.repositoryPath, ['add', '--intent-to-add', 'added.txt']);
    const patchText = git(fixture.repositoryPath, ['diff', 'HEAD', '--binary', '--no-ext-diff']);
    git(fixture.repositoryPath, ['reset', '--', 'added.txt']);
    git(fixture.repositoryPath, ['clean', '-f', '--', 'added.txt']);
    const review = createStateIntegrityReview(fixture, patchText, [
      { binary: false, path: 'added.txt', status: 'added' },
    ]);
    const { stagedReview } = await stageStateIntegrityReview(fixture, review);
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: fixture.repositoryPath,
      input: `${patchText}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T01:01:00.000Z',
      persistResult: (value) => {
        expect(readFileSync(addedPath, 'utf8')).toBe('Added by review.\n');
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(result.commitIds).toEqual([]);
    expect(persistedResult).toEqual(result);
    expect(readFileSync(addedPath, 'utf8')).toBe('Added by review.\n');
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit);
  });

  it('recovers an already-applied rename destination after a no-commit persistence crash', async () => {
    const fixture = createFixture({ commitOnApply: false });
    git(fixture.repositoryPath, ['mv', 'README.md', 'GUIDE.md']);
    writeFileSync(join(fixture.repositoryPath, 'GUIDE.md'), '# Demo\n\nRenamed.\n', 'utf8');
    const patchText = git(fixture.repositoryPath, ['diff', 'HEAD', '--binary', '--no-ext-diff']);
    git(fixture.repositoryPath, ['reset', '--hard', fixture.baseCommit]);
    const review = createStateIntegrityReview(fixture, patchText, [
      { binary: false, oldPath: 'README.md', path: 'GUIDE.md', status: 'renamed' },
    ]);
    const { stagedReview } = await stageStateIntegrityReview(fixture, review);
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: fixture.repositoryPath,
      input: `${patchText}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T01:02:00.000Z',
      persistResult: (value) => {
        expect(existsSync(join(fixture.repositoryPath, 'README.md'))).toBe(false);
        expect(readFileSync(join(fixture.repositoryPath, 'GUIDE.md'), 'utf8')).toBe(
          '# Demo\n\nRenamed.\n'
        );
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(result.commitIds).toEqual([]);
    expect(result.appliedPaths).toHaveLength(2);
    expect(result.appliedPaths).toEqual(expect.arrayContaining(['README.md', 'GUIDE.md']));
    expect(persistedResult).toEqual(result);
    expect(existsSync(join(fixture.repositoryPath, 'README.md'))).toBe(false);
    expect(readFileSync(join(fixture.repositoryPath, 'GUIDE.md'), 'utf8')).toBe(
      '# Demo\n\nRenamed.\n'
    );
  });

  it('recovers an already-applied ignored addition by exact path state', async () => {
    const fixture = createFixture({ commitOnApply: false });
    const ignoredPath = join(fixture.repositoryPath, 'ignored-output.txt');
    writeFileSync(ignoredPath, 'Ignored review output.\n', 'utf8');
    git(fixture.repositoryPath, ['add', '--intent-to-add', '-f', 'ignored-output.txt']);
    const patchText = git(fixture.repositoryPath, ['diff', '--binary', '--no-ext-diff']);
    git(fixture.repositoryPath, ['reset', '--', 'ignored-output.txt']);
    git(fixture.repositoryPath, ['clean', '-f', '--', 'ignored-output.txt']);
    writeFileSync(
      join(fixture.repositoryPath, '.git', 'info', 'exclude'),
      'ignored-output.txt\n',
      'utf8'
    );
    const review = createStateIntegrityReview(fixture, patchText, [
      { binary: false, path: 'ignored-output.txt', status: 'added' },
    ]);
    const { stagedReview } = await stageStateIntegrityReview(fixture, review);
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: fixture.repositoryPath,
      input: `${patchText}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T01:03:00.000Z',
      persistResult: (value) => {
        expect(readFileSync(ignoredPath, 'utf8')).toBe('Ignored review output.\n');
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(result.commitIds).toEqual([]);
    expect(persistedResult).toEqual(result);
    expect(readFileSync(ignoredPath, 'utf8')).toBe('Ignored review output.\n');
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
  });
});

/**
 * Replaces one fixture patch and its declared changed-path metadata.
 *
 * @param fixture Existing Git review fixture.
 * @param patchText Exact Git binary patch text.
 * @param changedPaths Declared path metadata for the replacement patch.
 * @returns Parsed review with internally consistent patch references.
 */
function withSecurityMetadataPatch(
  fixture: ReturnType<typeof createFixture>,
  patchText: string,
  changedPaths: ReturnType<typeof createFixture>['review']['changeSet']['changedPaths']
) {
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  const patchBytes = Buffer.byteLength(patchText, 'utf8');
  return WorkspaceSyncReviewItemSchema.parse({
    ...fixture.review,
    changeSet: {
      ...fixture.review.changeSet,
      changedPaths,
      patch: {
        bytes: patchBytes,
        digest: patchDigest,
        ref: 'worker-session://workspace.patch',
      },
    },
    patchPayload: {
      bytes: patchBytes,
      digest: patchDigest,
      mediaType: 'text/x-diff',
      text: patchText,
    },
  });
}

/**
 * Creates a clean fixture plus one actual binary modification patch.
 *
 * @returns Binary content, its digest, the patch, and the restored fixture.
 */
function createBinarySecurityMetadataFixture() {
  const fixture = createFixture();
  const binaryContent = Buffer.from([0, 1, 2, 3, 255, 254, 253, 0]);
  writeFileSync(join(fixture.repositoryPath, 'secret.txt'), binaryContent);
  const patchText = execFileSync('git', ['diff', '--binary', '--no-ext-diff'], {
    cwd: fixture.repositoryPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git(fixture.repositoryPath, ['restore', 'secret.txt']);
  const digest = `sha256:${createHash('sha256').update(binaryContent).digest('hex')}`;
  return { binaryContent, digest, fixture, patchText };
}

describe('workspace review Git declared metadata integrity', () => {
  it.each([
    ['symlink', '120000', 'linked-readme'],
    ['gitlink', '160000', 'linked-repository'],
  ] as const)('rejects an unsupported %s file mode', async (kind, mode, path) => {
    const fixture = createFixture();
    const objectId =
      kind === 'symlink'
        ? execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: fixture.repositoryPath,
            encoding: 'utf8',
            input: 'README.md',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim()
        : fixture.baseCommit;
    git(fixture.repositoryPath, ['update-index', '--add', '--cacheinfo', mode, objectId, path]);
    const patchText = git(fixture.repositoryPath, [
      'diff',
      '--cached',
      '--binary',
      '--no-ext-diff',
    ]);
    git(fixture.repositoryPath, ['reset', '--hard', fixture.baseCommit]);
    const review = withSecurityMetadataPatch(fixture, patchText, [
      { binary: false, path, status: 'added' },
    ]);

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {},
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow(/unsupported file modes/i);
  });

  it.each([
    'zero',
    'multiple',
    'foreign-workspace',
  ] as const)('rejects %s worker lineage before a no-commit apply', async (lineage) => {
    const fixture = createFixture({ commitOnApply: false });
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    let evidenceRefs = fixture.review.changeSet.evidenceRefs;
    if (lineage === 'zero') {
      evidenceRefs = [];
    } else if (lineage === 'multiple') {
      evidenceRefs = [...evidenceRefs, ...evidenceRefs];
    } else {
      const foreignWorkspace = fixture.store.createWorkspace('Foreign workspace');
      const foreignThread = fixture.store.createThread(foreignWorkspace.id, 'Foreign thread');
      const foreignTurn = fixture.store.createTurn(
        foreignWorkspace.id,
        foreignThread.id,
        'Foreign turn',
        { kind: 'user', id: 'user_local' }
      );
      evidenceRefs = [{ kind: 'worker', ref: foreignTurn.id }];
    }
    const review = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        evidenceRefs,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    let persisted = false;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T00:10:00.000Z',
        persistResult: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow();

    expect(persisted).toBe(false);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe('# Demo\n');
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
  });

  it('requires both old and new permissions for a declared mode change', async () => {
    const fixture = createFixture();
    git(fixture.repositoryPath, ['update-index', '--chmod=+x', 'README.md']);
    const patchText = git(fixture.repositoryPath, [
      'diff',
      '--cached',
      '--binary',
      '--no-ext-diff',
    ]);
    git(fixture.repositoryPath, ['reset', '--hard', fixture.baseCommit]);
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: false,
        newPermissions: '0755',
        path: 'README.md',
        status: 'mode_changed',
      },
    ]);
    let persisted = false;

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow();

    expect(persisted).toBe(false);
  });

  it('requires both endpoint permissions when a rename also changes mode', async () => {
    const fixture = createFixture();
    git(fixture.repositoryPath, ['mv', 'README.md', 'GUIDE.md']);
    git(fixture.repositoryPath, ['update-index', '--chmod=+x', 'GUIDE.md']);
    const patchText = git(fixture.repositoryPath, [
      'diff',
      '--cached',
      '--binary',
      '--no-ext-diff',
    ]);
    git(fixture.repositoryPath, ['reset', '--hard', fixture.baseCommit]);
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: false,
        newPermissions: '0755',
        oldPath: 'README.md',
        path: 'GUIDE.md',
        status: 'renamed',
      },
    ]);
    let persisted = false;

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow();

    expect(persisted).toBe(false);
  });

  it('rejects binary metadata that does not match the actual new blob', async () => {
    const { binaryContent, fixture, patchText } = createBinarySecurityMetadataFixture();
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: true,
        binaryReview: {
          bytes: binaryContent.length + 1,
          digest: wrongDigest,
          mediaType: 'application/octet-stream',
          mode: 'artifact-only',
          reason: 'binary-path',
          summary: 'Binary change secret.txt is available for artifact-only review.',
        },
        digest: wrongDigest,
        mediaType: 'application/octet-stream',
        path: 'secret.txt',
        size: binaryContent.length + 1,
        status: 'modified',
      },
    ]);

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {},
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow();
  });

  it('requires artifact-only review metadata for an actual binary patch', async () => {
    const { binaryContent, digest, fixture, patchText } = createBinarySecurityMetadataFixture();
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: true,
        digest,
        mediaType: 'application/octet-stream',
        path: 'secret.txt',
        size: binaryContent.length,
        status: 'modified',
      },
    ]);

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {},
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow();
  });

  it('stages and applies a valid binary review without changing its bytes', async () => {
    const { binaryContent, digest, fixture, patchText } = createBinarySecurityMetadataFixture();
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: true,
        binaryReview: {
          bytes: binaryContent.length,
          digest,
          mediaType: 'application/octet-stream',
          mode: 'artifact-only',
          reason: 'binary-path',
          summary: 'Binary change secret.txt is available for artifact-only review.',
        },
        digest,
        mediaType: 'application/octet-stream',
        path: 'secret.txt',
        size: binaryContent.length,
        status: 'modified',
      },
    ]);
    const stagedCommit = await stageGitWorkspaceReview({
      persistHead: () => {},
      repository: fixture.repository,
      review,
      store: fixture.store,
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...review,
      changeSet: {
        ...review.changeSet,
        head: { ...review.changeSet.head, commit: stagedCommit },
      },
    });
    let persisted = false;

    await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T00:12:00.000Z',
      persistResult: () => {
        persisted = true;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(persisted).toBe(true);
    expect(readFileSync(join(fixture.repositoryPath, 'secret.txt'))).toEqual(binaryContent);
  });

  it('rejects binary review media type that conflicts with the safe default', async () => {
    const { binaryContent, digest, fixture, patchText } = createBinarySecurityMetadataFixture();
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: true,
        binaryReview: {
          bytes: binaryContent.length,
          digest,
          mediaType: 'image/png',
          mode: 'artifact-only',
          reason: 'binary-path',
          summary: 'Binary change secret.txt is available for artifact-only review.',
        },
        digest,
        path: 'secret.txt',
        size: binaryContent.length,
        status: 'modified',
      },
    ]);

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {},
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow();
  });

  it('rejects binary review metadata that disagrees with the declared blob', async () => {
    const { binaryContent, digest, fixture, patchText } = createBinarySecurityMetadataFixture();
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: true,
        binaryReview: {
          bytes: binaryContent.length + 1,
          digest: `sha256:${'1'.repeat(64)}`,
          mediaType: 'application/octet-stream',
          mode: 'artifact-only',
          reason: 'binary-path',
          summary: 'Binary change secret.txt is available for artifact-only review.',
        },
        digest,
        mediaType: 'application/octet-stream',
        path: 'secret.txt',
        size: binaryContent.length,
        status: 'modified',
      },
    ]);

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {},
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow();
  });

  it('applies a staged review while the configured repository has detached HEAD', async () => {
    const fixture = createFixture();
    git(fixture.repositoryPath, ['checkout', '--detach', fixture.baseCommit]);
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T00:11:00.000Z',
      persistResult: (value) => {
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(persistedResult).toEqual(result);
    expect(result.commitIds).toHaveLength(1);
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(result.commitIds[0]);
    expect(git(fixture.repositoryPath, ['branch', '--show-current'])).toBe('');
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
  });
});

/**
 * Creates one executable Git wrapper that injects test code before forwarding.
 *
 * @param beforeForward JavaScript executed with `args`, `realGit`, and `run` in scope.
 * @returns Directory to prepend to PATH for the wrapped operation.
 */
function createGitCommandWrapper(beforeForward: string): string {
  const wrapperRoot = mkdtempSync(join(tmpdir(), 'openkit-git-command-wrapper-'));
  const wrapperPath = join(wrapperRoot, 'git');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    wrapperPath,
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
const run = (cwd, commandArgs) => {
  const result = spawnSync(realGit, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'injected Git command failed');
  }
  return result.stdout.trim();
};
${beforeForward}
const result = spawnSync(realGit, args, { env: process.env, stdio: 'inherit' });
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
`,
    'utf8'
  );
  execFileSync('chmod', ['+x', wrapperPath]);
  return wrapperRoot;
}

describe('workspace review Git remaining integrity boundaries', () => {
  it('rejects no-commit recovery through a symlinked parent inside the repository', async () => {
    const fixture = createFixture({ commitOnApply: false });
    const reviewedDirectory = join(fixture.repositoryPath, 'reviewed');
    mkdirSync(reviewedDirectory);
    writeFileSync(join(reviewedDirectory, 'output.txt'), 'Reviewed output.\n', 'utf8');
    git(fixture.repositoryPath, ['add', '--intent-to-add', 'reviewed/output.txt']);
    const patchText = git(fixture.repositoryPath, ['diff', 'HEAD', '--binary', '--no-ext-diff']);
    git(fixture.repositoryPath, ['reset', '--', 'reviewed/output.txt']);
    git(fixture.repositoryPath, ['clean', '-fd', '--', 'reviewed']);
    const review = createStateIntegrityReview(fixture, patchText, [
      { binary: false, path: 'reviewed/output.txt', status: 'added' },
    ]);
    const { stagedCommit, stagedReview } = await stageStateIntegrityReview(fixture, review);
    const aliasedDirectory = join(fixture.repositoryPath, 'aliased');
    mkdirSync(aliasedDirectory);
    writeFileSync(join(aliasedDirectory, 'output.txt'), 'Reviewed output.\n', 'utf8');
    symlinkSync('aliased', reviewedDirectory, 'dir');
    let persisted = false;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T02:00:00.000Z',
        persistResult: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow(/symlink|target paths|clean/i);

    expect(persisted).toBe(false);
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
    expect(readFileSync(join(reviewedDirectory, 'output.txt'), 'utf8')).toBe('Reviewed output.\n');
  });

  it('preserves a foreign HEAD, index, and worktree takeover before the apply ref CAS', async () => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    const statePath = join(
      mkdtempSync(join(tmpdir(), 'openkit-pre-cas-takeover-state-')),
      'state.json'
    );
    const wrapperRoot = createGitCommandWrapper(`
if (
  args[0] === 'update-ref' &&
  args.includes('OpenKit applied workspace review swr_git_review_1') &&
  !existsSync(${JSON.stringify(statePath)})
) {
  const repositoryPath = ${JSON.stringify(fixture.repositoryPath)};
  run(repositoryPath, ['reset', '--hard', ${JSON.stringify(fixture.baseCommit)}]);
  writeFileSync(join(repositoryPath, 'README.md'), '# Foreign committed.\\n', 'utf8');
  writeFileSync(join(repositoryPath, 'foreign.txt'), 'Foreign commit.\\n', 'utf8');
  run(repositoryPath, ['add', 'README.md', 'foreign.txt']);
  run(repositoryPath, ['commit', '-m', 'foreign owner before OpenKit CAS']);
  writeFileSync(join(repositoryPath, 'foreign-index.txt'), 'Foreign staged.\\n', 'utf8');
  run(repositoryPath, ['add', 'foreign-index.txt']);
  writeFileSync(join(repositoryPath, 'README.md'), '# Foreign dirty.\\n', 'utf8');
  writeFileSync(
    ${JSON.stringify(statePath)},
    JSON.stringify({
      head: run(repositoryPath, ['rev-parse', 'HEAD']),
      indexTree: run(repositoryPath, ['write-tree']),
      readme: readFileSync(join(repositoryPath, 'README.md'), 'utf8'),
      status: run(repositoryPath, ['status', '--short']),
    }),
    'utf8'
  );
}`);
    const originalPath = process.env.PATH;
    process.env.PATH = `${wrapperRoot}:${originalPath ?? ''}`;

    try {
      await expect(
        applyGitWorkspaceReview({
          appliedAt: '2026-07-11T02:00:00.000Z',
          persistResult: () => {
            throw new Error('persistence must not run after lost HEAD ownership');
          },
          repository: fixture.repository,
          review: stagedReview,
          store: fixture.store,
        })
      ).rejects.toThrow();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }

    const expected = JSON.parse(readFileSync(statePath, 'utf8')) as {
      head: string;
      indexTree: string;
      readme: string;
      status: string;
    };
    expect(git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).toBe(expected.head);
    expect(git(fixture.repositoryPath, ['write-tree'])).toBe(expected.indexTree);
    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe(expected.readme);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe(expected.status);
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
  });

  it.each([
    ['assume-unchanged', '--assume-unchanged'],
    ['skip-worktree', '--skip-worktree'],
  ] as const)('does not reset or reverse a touched path after rollback sees %s', async (_label, flag) => {
    const fixture = createFixture();
    const stagedCommit = await stageGitWorkspaceReview({
      repository: fixture.repository,
      review: fixture.review,
      store: fixture.store,
      persistHead: () => {},
    });
    const stagedReview = WorkspaceSyncReviewItemSchema.parse({
      ...fixture.review,
      changeSet: {
        ...fixture.review.changeSet,
        head: { ...fixture.review.changeSet.head, commit: stagedCommit },
      },
    });
    let flaggedIndexEntry: string | null = null;
    let flaggedPathEntry: string | null = null;

    await expect(
      applyGitWorkspaceReview({
        appliedAt: '2026-07-11T02:00:30.000Z',
        persistResult: () => {
          git(fixture.repositoryPath, ['update-index', flag, 'README.md']);
          flaggedIndexEntry = git(fixture.repositoryPath, [
            'ls-files',
            '--stage',
            '--',
            'README.md',
          ]);
          flaggedPathEntry = git(fixture.repositoryPath, ['ls-files', '-v', '--', 'README.md']);
          throw new Error('database failed after hidden index takeover');
        },
        repository: fixture.repository,
        review: stagedReview,
        store: fixture.store,
      })
    ).rejects.toThrow();

    expect(readFileSync(join(fixture.repositoryPath, 'README.md'), 'utf8')).toBe(
      '# Demo\n\nReviewed.\n'
    );
    expect(git(fixture.repositoryPath, ['ls-files', '--stage', '--', 'README.md'])).toBe(
      flaggedIndexEntry
    );
    expect(git(fixture.repositoryPath, ['ls-files', '-v', '--', 'README.md'])).toBe(
      flaggedPathEntry
    );
    expect(
      git(fixture.repositoryPath, ['rev-parse', 'refs/heads/openkit/review/swr_git_review_1'])
    ).toBe(stagedCommit);
  });

  it('rejects content and permission changes declared as mode-only', async () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.repositoryPath, 'README.md'),
      '# Demo\n\nContent and mode.\n',
      'utf8'
    );
    git(fixture.repositoryPath, ['add', 'README.md']);
    git(fixture.repositoryPath, ['update-index', '--chmod=+x', 'README.md']);
    const patchText = git(fixture.repositoryPath, [
      'diff',
      '--cached',
      '--binary',
      '--no-ext-diff',
    ]);
    git(fixture.repositoryPath, ['reset', '--hard', fixture.baseCommit]);
    const review = withSecurityMetadataPatch(fixture, patchText, [
      {
        binary: false,
        newPermissions: '0755',
        oldPermissions: '0644',
        path: 'README.md',
        status: 'mode_changed',
      },
    ]);
    let persisted = false;

    await expect(
      stageGitWorkspaceReview({
        persistHead: () => {
          persisted = true;
        },
        repository: fixture.repository,
        review,
        store: fixture.store,
      })
    ).rejects.toThrow(/metadata|mode/i);

    expect(persisted).toBe(false);
  });

  it('recovers an ignored CRLF worktree file through its canonical filtered blob', async () => {
    const fixture = createFixture({ commitOnApply: false });
    const ignoredPath = join(fixture.repositoryPath, 'ignored-eol.txt');
    writeFileSync(
      join(fixture.repositoryPath, '.git', 'info', 'attributes'),
      'ignored-eol.txt text eol=crlf\n',
      'utf8'
    );
    writeFileSync(ignoredPath, 'Reviewed with EOL.\n', 'utf8');
    git(fixture.repositoryPath, ['add', '--intent-to-add', '-f', 'ignored-eol.txt']);
    const patchText = git(fixture.repositoryPath, ['diff', '--binary', '--no-ext-diff']);
    git(fixture.repositoryPath, ['reset', '--', 'ignored-eol.txt']);
    git(fixture.repositoryPath, ['clean', '-f', '--', 'ignored-eol.txt']);
    writeFileSync(
      join(fixture.repositoryPath, '.git', 'info', 'exclude'),
      'ignored-eol.txt\n',
      'utf8'
    );
    const review = createStateIntegrityReview(fixture, patchText, [
      { binary: false, path: 'ignored-eol.txt', status: 'added' },
    ]);
    const { stagedReview } = await stageStateIntegrityReview(fixture, review);
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: fixture.repositoryPath,
      input: `${patchText}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    writeFileSync(ignoredPath, 'Reviewed with EOL.\r\n', 'utf8');
    git(fixture.repositoryPath, ['branch', '-D', 'openkit/review/swr_git_review_1']);
    expect(git(fixture.repositoryPath, ['status', '--short'])).toBe('');
    let persistedResult: unknown = null;

    const result = await applyGitWorkspaceReview({
      appliedAt: '2026-07-11T02:01:00.000Z',
      persistResult: (value) => {
        persistedResult = value;
      },
      repository: fixture.repository,
      review: stagedReview,
      store: fixture.store,
    });

    expect(result.commitIds).toEqual([]);
    expect(persistedResult).toEqual(result);
    expect(readFileSync(ignoredPath, 'utf8')).toBe('Reviewed with EOL.\r\n');
  });

  it('rejects a signal-killed missing-ref probe instead of treating it as exit one', async () => {
    const fixture = createFixture();
    const wrapperRoot = createGitCommandWrapper(`
if (
  args[0] === 'rev-parse' &&
  args.includes('refs/heads/openkit/review/swr_git_review_1^{commit}')
) {
  process.kill(process.pid, 'SIGTERM');
}`);
    const originalPath = process.env.PATH;
    process.env.PATH = `${wrapperRoot}:${originalPath ?? ''}`;
    let persisted = false;

    try {
      await expect(
        stageGitWorkspaceReview({
          persistHead: () => {
            persisted = true;
          },
          repository: fixture.repository,
          review: fixture.review,
          store: fixture.store,
        })
      ).rejects.toThrow(/failed|signal|terminated/i);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }

    expect(persisted).toBe(false);
    expect(() =>
      git(fixture.repositoryPath, [
        'rev-parse',
        '--verify',
        'refs/heads/openkit/review/swr_git_review_1',
      ])
    ).toThrow();
  });
});
