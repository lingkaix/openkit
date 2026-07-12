import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import {
  type WorkspaceApplyResult,
  WorkspaceApplyResultSchema,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceRepositoryResourceRecord } from '../workspace/repository-store.js';

const SAFE_PROCESS_ENV_KEYS = [
  'COMSPEC',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
] as const;
const REVIEW_BRANCH_PATTERN = /^openkit\/review\/[A-Za-z0-9._-]+$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Process-local serialization tails keyed by canonical Git common directory. */
const repositoryOperationTails = new Map<string, Promise<void>>();

/** Isolated environment and temporary paths for one workspace-review Git operation. */
interface GitOperationContext {
  /** Scrubbed child-process environment. */
  readonly env: NodeJS.ProcessEnv;
  /** Operation-owned temporary root. */
  readonly rootPath: string;
}

/** Validated patch material built in an isolated detached worktree index. */
interface PreparedWorkspaceReviewPatch {
  /** Verified base commit. */
  readonly baseCommit: string;
  /** Tree containing exactly the declared patch changes on top of the base commit. */
  readonly treeId: string;
  /** Exact repository-relative paths touched by the patch, including rename sources. */
  readonly touchedPaths: readonly string[];
}

/**
 * Materializes one pending review as a NanoCore-owned local review branch.
 *
 * The branch is created from an isolated index and published with an expected-absent
 * reference update. The synchronous persistence callback runs while the repository
 * lock is held; a callback failure removes the new reference before surfacing.
 *
 * @param input Linked repository, review, attribution store, and durable head callback.
 * @returns Staged commit id.
 * @throws Error when validation, Git staging, persistence, rollback, or cleanup fails.
 */
export async function stageGitWorkspaceReview(input: {
  /** Linked repository that owns the review branch. */
  readonly repository: WorkspaceRepositoryResourceRecord;
  /** Pending Git workspace review to stage. */
  readonly review: WorkspaceSyncReviewItem;
  /** App-local store used to resolve worker attribution. */
  readonly store: FsStore;
  /** Synchronous durable callback that records the staged commit as change-set head. */
  readonly persistHead: (commitId: string) => void;
}): Promise<string> {
  requireGitReview(input.repository, input.review);
  if (input.repository.git.stagingStrategy !== 'review-branch') {
    throw new Error(`Workspace repository does not use review branches: ${input.review.review.id}`);
  }

  const branchRef = `refs/heads/${requireWorkspaceReviewBranch(input.review)}`;
  const patchText = workspaceReviewPatchText(input.review);
  const baseCommit = requireCommitId(
    input.review.changeSet.base.commit,
    `Workspace review has no safe base commit: ${input.review.review.id}`
  );
  const identity = requireGitIdentity(input.repository, input.review);
  const commitMessage = workspaceReviewCommitMessage(input.store, input.review, true);

  return withLockedRepository(input.repository.localPath, async (context) => {
    const prepared = await prepareWorkspaceReviewPatch(
      context,
      input.repository.localPath,
      input.review,
      baseCommit,
      patchText
    );
    const existingCommit = await readRef(context, input.repository.localPath, branchRef);
    if (existingCommit) {
      await requireMatchingReviewCommit(
        context,
        input.repository.localPath,
        existingCommit,
        prepared,
        commitMessage,
        identity,
        input.review.review.id
      );
      input.persistHead(existingCommit);
      return existingCommit;
    }

    const commitId = await createCommitObject(
      context,
      input.repository.localPath,
      prepared,
      commitMessage,
      identity
    );
    const missingRef = zeroObjectId(commitId);
    let branchCreated = false;

    try {
      await compareAndSwapRef(
        context,
        input.repository.localPath,
        branchRef,
        commitId,
        missingRef,
        `OpenKit staged workspace review ${input.review.review.id}`
      );
      branchCreated = true;
      input.persistHead(commitId);
      return commitId;
    } catch (error) {
      if (!branchCreated) {
        throw error;
      }

      try {
        await compareAndSwapRef(
          context,
          input.repository.localPath,
          branchRef,
          null,
          commitId,
          `OpenKit rolled back workspace review ${input.review.review.id}`
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Workspace review branch persistence and rollback failed: ${input.review.review.id}`
        );
      }
      throw error;
    }
  });
}

/**
 * Applies one accepted Git workspace review to the linked worktree.
 *
 * Target paths must be clean and the checked-out HEAD must still equal the review
 * base. Commit-on-apply publishes a prebuilt exact tree through an expected-old
 * reference update, so unrelated staged paths never enter the OpenKit commit.
 * The synchronous persistence callback runs before the lock is released; any
 * failure restores the review branch, HEAD, index, and worktree.
 *
 * @param input Linked repository, review, attribution store, timestamp, and result callback.
 * @returns Applied workspace result after successful persistence.
 * @throws Error when validation, apply, persistence, rollback, or cleanup fails.
 */
export async function applyGitWorkspaceReview(input: {
  /** Linked repository that should receive the accepted patch. */
  readonly repository: WorkspaceRepositoryResourceRecord;
  /** Accepted Git workspace review source. */
  readonly review: WorkspaceSyncReviewItem;
  /** App-local store used to resolve worker attribution. */
  readonly store: FsStore;
  /** ISO timestamp recorded on the apply result. */
  readonly appliedAt: string;
  /** Synchronous durable callback that atomically records the result and decision. */
  readonly persistResult: (result: WorkspaceApplyResult) => void;
}): Promise<WorkspaceApplyResult> {
  requireGitReview(input.repository, input.review);
  const patchText = workspaceReviewPatchText(input.review);
  const baseCommit = requireCommitId(
    input.review.changeSet.base.commit,
    `Workspace review has no safe base commit: ${input.review.review.id}`
  );
  const reviewedCommitMessage = workspaceReviewCommitMessage(input.store, input.review, false);
  const commitMessage = input.repository.git.commitOnApply ? reviewedCommitMessage : null;
  const identity = input.repository.git.commitOnApply
    ? requireGitIdentity(input.repository, input.review)
    : null;
  const branchRef = input.review.review.staging.branch
    ? `refs/heads/${requireWorkspaceReviewBranch(input.review)}`
    : null;
  const stagedCommit = branchRef
    ? requireCommitId(
        input.review.changeSet.head.commit,
        `Workspace review has no safe staged commit: ${input.review.review.id}`
      )
    : null;

  return withLockedRepository(input.repository.localPath, async (context) => {
    const prepared = await prepareWorkspaceReviewPatch(
      context,
      input.repository.localPath,
      input.review,
      baseCommit,
      patchText
    );
    await requireNoGitFilters(
      context,
      input.repository.localPath,
      prepared.touchedPaths,
      input.review.review.id,
      false
    );
    const currentHead = requireCommitId(
      (await runGit(context, input.repository.localPath, ['rev-parse', '--verify', 'HEAD'])).trim(),
      `Linked repository has no safe HEAD: ${input.review.review.id}`
    );
    await requireVisibleTouchedIndexState(
      context,
      input.repository.localPath,
      prepared.touchedPaths,
      input.review.review.id
    );
    const targetStatus = await runGit(context, input.repository.localPath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      ...prepared.touchedPaths,
    ]);
    const liveStagedCommit = branchRef
      ? await readRef(context, input.repository.localPath, branchRef)
      : null;
    if (
      liveStagedCommit &&
      stagedCommit &&
      liveStagedCommit.toLowerCase() !== stagedCommit.toLowerCase()
    ) {
      throw new Error(`Workspace review branch drifted: ${input.review.review.id}`);
    }
    if (branchRef && liveStagedCommit) {
      await requireReviewBranchNotCheckedOut(
        context,
        input.repository.localPath,
        branchRef,
        input.review.review.id
      );
    }

    let recoveredCommitIds: readonly string[] | null = null;
    let indexedPatchRecovered = false;
    if (currentHead.toLowerCase() !== baseCommit.toLowerCase()) {
      if (!commitMessage || !identity) {
        throw new Error(
          `Workspace review base no longer matches repository HEAD: ${input.review.review.id}`
        );
      }
      await requireMatchingReviewCommit(
        context,
        input.repository.localPath,
        currentHead,
        prepared,
        commitMessage,
        identity,
        input.review.review.id
      );
      const unexpectedIndexPaths = await runGit(context, input.repository.localPath, [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        prepared.treeId,
        '--',
        ...prepared.touchedPaths,
      ]);
      if (
        unexpectedIndexPaths ||
        !(await worktreeMatchesPreparedTree(context, input.repository.localPath, prepared))
      ) {
        throw new Error(`Workspace review target paths are not clean: ${input.review.review.id}`);
      }
      recoveredCommitIds = [currentHead];
    } else if (
      !commitMessage &&
      !(await runGit(context, input.repository.localPath, [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        baseCommit,
        '--',
        ...prepared.touchedPaths,
      ])) &&
      (await worktreeMatchesPreparedTree(context, input.repository.localPath, prepared))
    ) {
      recoveredCommitIds = [];
    } else if (targetStatus) {
      if (commitMessage) {
        const unexpectedIndexPaths = await runGit(context, input.repository.localPath, [
          'diff',
          '--cached',
          '--name-only',
          '-z',
          prepared.treeId,
          '--',
          ...prepared.touchedPaths,
        ]);
        const unexpectedWorktreePaths = await runGit(context, input.repository.localPath, [
          'diff',
          '--name-only',
          '-z',
          '--',
          ...prepared.touchedPaths,
        ]);
        if (unexpectedIndexPaths || unexpectedWorktreePaths) {
          throw new Error(`Workspace review target paths are not clean: ${input.review.review.id}`);
        }
        indexedPatchRecovered = true;
      } else {
        const stagedTargetPaths = await runGit(context, input.repository.localPath, [
          'diff',
          '--cached',
          '--name-only',
          '-z',
          baseCommit,
          '--',
          ...prepared.touchedPaths,
        ]);
        const unexpectedTargetPaths = await runGit(context, input.repository.localPath, [
          'diff',
          '--name-only',
          '-z',
          prepared.treeId,
          '--',
          ...prepared.touchedPaths,
        ]);
        if (stagedTargetPaths || unexpectedTargetPaths) {
          throw new Error(`Workspace review target paths are not clean: ${input.review.review.id}`);
        }
        recoveredCommitIds = [];
      }
    }

    if (recoveredCommitIds) {
      let recoveredBranchDeleted = false;
      try {
        if (branchRef && stagedCommit && liveStagedCommit) {
          await requireReviewBranchNotCheckedOut(
            context,
            input.repository.localPath,
            branchRef,
            input.review.review.id
          );
          await compareAndSwapRef(
            context,
            input.repository.localPath,
            branchRef,
            null,
            stagedCommit,
            `OpenKit completed recovered workspace review ${input.review.review.id}`
          );
          recoveredBranchDeleted = true;
        }
        const result = createWorkspaceReviewApplyResult(
          input.review,
          input.appliedAt,
          prepared.touchedPaths,
          recoveredCommitIds
        );
        input.persistResult(result);
        return result;
      } catch (error) {
        if (!recoveredBranchDeleted || !branchRef || !stagedCommit) {
          throw error;
        }
        try {
          await compareAndSwapRef(
            context,
            input.repository.localPath,
            branchRef,
            stagedCommit,
            zeroObjectId(stagedCommit),
            `OpenKit restored recovered workspace review ${input.review.review.id}`
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Workspace review recovery persistence and rollback failed: ${input.review.review.id}`
          );
        }
        throw error;
      }
    }

    if (branchRef && stagedCommit && !liveStagedCommit) {
      throw new Error(`Workspace review branch is missing: ${input.review.review.id}`);
    }

    const symbolicHead = (
      await runGit(
        context,
        input.repository.localPath,
        ['symbolic-ref', '-q', 'HEAD'],
        '',
        {},
        true
      )
    ).trim();
    if (symbolicHead && !symbolicHead.startsWith('refs/heads/')) {
      throw new Error(`Linked repository HEAD is not a local branch: ${input.review.review.id}`);
    }
    const headRef = symbolicHead || 'HEAD';
    const detachedHead = !symbolicHead;
    const appliedCommit =
      commitMessage && identity
        ? await createCommitObject(
            context,
            input.repository.localPath,
            prepared,
            commitMessage,
            identity
          )
        : null;
    let patchApplied = indexedPatchRecovered;
    let headUpdated = false;
    let branchDeleted = false;

    try {
      if (!indexedPatchRecovered) {
        const applyArgs = input.repository.git.commitOnApply
          ? ['apply', '--index', '--check', '--whitespace=nowarn', '-']
          : ['apply', '--check', '--whitespace=nowarn', '-'];
        await runGit(context, input.repository.localPath, applyArgs, patchText);
        await runGit(
          context,
          input.repository.localPath,
          applyArgs.filter((argument) => argument !== '--check'),
          patchText
        );
        patchApplied = true;
      }

      if (appliedCommit) {
        await compareAndSwapRef(
          context,
          input.repository.localPath,
          headRef,
          appliedCommit,
          baseCommit,
          `OpenKit applied workspace review ${input.review.review.id}`,
          detachedHead
        );
        headUpdated = true;
      }

      if (branchRef && stagedCommit) {
        await requireReviewBranchNotCheckedOut(
          context,
          input.repository.localPath,
          branchRef,
          input.review.review.id
        );
        await compareAndSwapRef(
          context,
          input.repository.localPath,
          branchRef,
          null,
          stagedCommit,
          `OpenKit completed workspace review ${input.review.review.id}`
        );
        branchDeleted = true;
      }

      const result = createWorkspaceReviewApplyResult(
        input.review,
        input.appliedAt,
        prepared.touchedPaths,
        appliedCommit ? [appliedCommit] : []
      );
      input.persistResult(result);
      return result;
    } catch (error) {
      const rollbackErrors = await rollbackAppliedReview({
        baseCommit,
        branchDeleted,
        branchRef,
        context,
        detachedHead,
        headRef,
        headUpdated,
        newHead: appliedCommit,
        patchApplied,
        patchText,
        prepared,
        repositoryPath: input.repository.localPath,
        reviewId: input.review.review.id,
        stagedCommit,
      });
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Workspace review apply and rollback failed: ${input.review.review.id}`
        );
      }
      throw error;
    }
  });
}

/**
 * Builds the canonical durable result for a newly applied or recovered Git review.
 *
 * @param review Applied workspace review.
 * @param appliedAt Apply timestamp.
 * @param appliedPaths Exact reviewed paths, including rename sources.
 * @param commitIds OpenKit-created commits, empty for no-commit application.
 * @returns Validated workspace apply result.
 */
function createWorkspaceReviewApplyResult(
  review: WorkspaceSyncReviewItem,
  appliedAt: string,
  appliedPaths: readonly string[],
  commitIds: readonly string[]
): WorkspaceApplyResult {
  return WorkspaceApplyResultSchema.parse({
    appliedAt,
    appliedPaths,
    changeSetId: review.changeSet.id,
    commitIds,
    conflictRecords: [],
    id: `war_${review.review.id}`,
    reviewId: review.review.id,
    skippedPaths: [],
    status: 'applied',
    verification: [{ command: 'git apply --check', ref: null, status: 'passed' }],
    workspaceId: review.review.workspaceId,
  });
}

/**
 * Deletes a NanoCore-owned review branch for a terminal decision without applying it.
 *
 * The synchronous decision callback runs after an expected-old branch deletion while
 * the repository lock is held. Callback failure restores the exact staged commit.
 *
 * @param input Linked repository, review, and durable decision callback.
 * @throws Error when validation, reference mutation, persistence, rollback, or cleanup fails.
 */
export async function discardGitWorkspaceReview(input: {
  /** Linked repository that owns the review branch. */
  readonly repository: WorkspaceRepositoryResourceRecord;
  /** Terminal Git workspace review being discarded. */
  readonly review: WorkspaceSyncReviewItem;
  /** Synchronous durable callback that records the terminal decision. */
  readonly persistDecision: () => void;
}): Promise<void> {
  requireGitReview(input.repository, input.review);

  const branchRef = `refs/heads/${requireWorkspaceReviewBranch(input.review)}`;
  const stagedCommit = requireCommitId(
    input.review.changeSet.head.commit,
    `Workspace review has no safe staged commit: ${input.review.review.id}`
  );

  await withLockedRepository(input.repository.localPath, async (context) => {
    const liveStagedCommit = await readRef(context, input.repository.localPath, branchRef);
    if (!liveStagedCommit) {
      input.persistDecision();
      return;
    }
    if (liveStagedCommit.toLowerCase() !== stagedCommit.toLowerCase()) {
      throw new Error(`Workspace review branch drifted: ${input.review.review.id}`);
    }
    await requireReviewBranchNotCheckedOut(
      context,
      input.repository.localPath,
      branchRef,
      input.review.review.id
    );

    let branchDeleted = false;
    try {
      await compareAndSwapRef(
        context,
        input.repository.localPath,
        branchRef,
        null,
        stagedCommit,
        `OpenKit discarded workspace review ${input.review.review.id}`
      );
      branchDeleted = true;
      input.persistDecision();
    } catch (error) {
      if (!branchDeleted) {
        throw error;
      }

      try {
        await compareAndSwapRef(
          context,
          input.repository.localPath,
          branchRef,
          stagedCommit,
          zeroObjectId(stagedCommit),
          `OpenKit restored workspace review ${input.review.review.id}`,
          false
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Workspace review discard persistence and rollback failed: ${input.review.review.id}`
        );
      }
      throw error;
    }
  });
}

/**
 * Creates an isolated environment and serializes one operation by Git common directory.
 *
 * @template Result Operation result type.
 * @param repositoryPath Linked repository working directory.
 * @param operation Operation to execute under the repository queue.
 * @returns Operation result.
 */
async function withLockedRepository<Result>(
  repositoryPath: string,
  operation: (context: GitOperationContext) => Promise<Result>
): Promise<Result> {
  const context = await createGitOperationContext();
  return withCleanup(
    async () => {
      const linkedRoot = await realpath(repositoryPath);
      const topLevel = await realpath(
        (await runGit(context, repositoryPath, ['rev-parse', '--show-toplevel'])).trim()
      );
      const insideWorktree = (
        await runGit(context, repositoryPath, ['rev-parse', '--is-inside-work-tree'])
      ).trim();
      if (insideWorktree !== 'true' || topLevel !== linkedRoot) {
        throw new Error('Linked repository Git worktree escapes its configured path.');
      }

      const commonDirectoryOutput = await runGit(context, repositoryPath, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      const commonDirectory = await realpath(commonDirectoryOutput.trim());
      return serializeRepositoryOperation(commonDirectory, () => operation(context));
    },
    () => rm(context.rootPath, { force: true, recursive: true }),
    'Workspace review Git operation and temporary-root cleanup both failed.'
  );
}

/**
 * Serializes one operation behind the previous operation for the same Git common directory.
 *
 * @template Result Operation result type.
 * @param commonDirectory Canonical Git common directory.
 * @param operation Operation to execute when the queue reaches it.
 * @returns Operation result.
 */
async function serializeRepositoryOperation<Result>(
  commonDirectory: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const previous = repositoryOperationTails.get(commonDirectory) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  repositoryOperationTails.set(commonDirectory, tail);
  await previous.catch(() => {});

  try {
    return await operation();
  } finally {
    release();
    if (repositoryOperationTails.get(commonDirectory) === tail) {
      repositoryOperationTails.delete(commonDirectory);
    }
  }
}

/**
 * Creates one scrubbed Git execution context.
 *
 * @returns Operation context with empty config and hooks roots.
 */
async function createGitOperationContext(): Promise<GitOperationContext> {
  const rootPath = await mkdtemp(join(tmpdir(), 'openkit-workspace-review-git-'));
  const hooksPath = join(rootPath, 'hooks');
  const configPath = join(rootPath, 'empty.gitconfig');

  try {
    await mkdir(hooksPath);
    await writeFile(configPath, '', 'utf8');
  } catch (error) {
    try {
      await rm(rootPath, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Workspace review Git context creation and cleanup both failed.'
      );
    }
    throw error;
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_KEY_2: 'commit.gpgSign',
    GIT_CONFIG_KEY_3: 'core.sparseCheckout',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: configPath,
    GIT_CONFIG_VALUE_0: hooksPath,
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_VALUE_3: 'false',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    HOME: rootPath,
    LANG: 'C',
    LC_ALL: 'C',
    USERPROFILE: rootPath,
    XDG_CONFIG_HOME: rootPath,
  });

  return { env, rootPath };
}

/**
 * Creates and validates one patched tree in a temporary detached worktree index.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param review Workspace review declaring the path set.
 * @param baseCommit Verified base commit id.
 * @param patchText Verified normalized patch text.
 * @returns Prepared patch tree and exact touched paths.
 */
async function prepareWorkspaceReviewPatch(
  context: GitOperationContext,
  repositoryPath: string,
  review: WorkspaceSyncReviewItem,
  baseCommit: string,
  patchText: string
): Promise<PreparedWorkspaceReviewPatch> {
  const touchedPaths = declaredTouchedPaths(review);
  const worktreePath = join(context.rootPath, 'worktree');
  await runGit(context, repositoryPath, [
    'worktree',
    'add',
    '--detach',
    '--no-checkout',
    worktreePath,
    baseCommit,
  ]);

  return withCleanup(
    async () => {
      await runGit(context, worktreePath, ['read-tree', baseCommit]);
      if (
        touchedPaths.some((path) => path === '.gitattributes' || path.endsWith('/.gitattributes'))
      ) {
        throw new Error(`Workspace review cannot modify Git attributes: ${review.review.id}`);
      }
      await requireNoGitFilters(context, worktreePath, touchedPaths, review.review.id, true);
      await runGit(
        context,
        worktreePath,
        ['apply', '--cached', '--check', '--whitespace=nowarn', '-'],
        patchText
      );
      await runGit(
        context,
        worktreePath,
        ['apply', '--cached', '--whitespace=nowarn', '-'],
        patchText
      );
      const actualPaths = (
        await runGit(context, worktreePath, [
          'diff',
          '--cached',
          '--name-only',
          '--no-renames',
          '-z',
          baseCommit,
          '--',
        ])
      )
        .split('\0')
        .filter(Boolean)
        .sort();
      if (
        actualPaths.length !== touchedPaths.length ||
        actualPaths.some((path, index) => path !== touchedPaths[index])
      ) {
        throw new Error(
          `Workspace review patch path set does not match declared changes: ${review.review.id}`
        );
      }

      const rawTokens = (
        await runGit(context, worktreePath, [
          'diff',
          '--cached',
          '--raw',
          '--abbrev=64',
          '--no-renames',
          '-z',
          baseCommit,
          '--',
        ])
      )
        .split('\0')
        .filter(Boolean);
      const numstat = new Map(
        (
          await runGit(context, worktreePath, [
            'diff',
            '--cached',
            '--numstat',
            '--no-renames',
            '-z',
            baseCommit,
            '--',
          ])
        )
          .split('\0')
          .filter(Boolean)
          .map((record) => {
            const [additions, deletions, path] = record.split('\t');
            return [path, additions === '-' && deletions === '-'] as const;
          })
      );
      const actualChanges = new Map<
        string,
        {
          readonly binary: boolean;
          readonly newMode: string;
          readonly newObjectId: string;
          readonly oldMode: string;
          readonly oldObjectId: string;
          readonly status: string;
        }
      >();

      for (let index = 0; index < rawTokens.length; index += 2) {
        const header = rawTokens[index];
        const path = rawTokens[index + 1];
        const match = header?.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/);
        if (!match || !path || !numstat.has(path)) {
          throw new Error(`Workspace review patch metadata is invalid: ${review.review.id}`);
        }
        if (
          !['000000', '100644', '100755'].includes(match[1] ?? '') ||
          !['000000', '100644', '100755'].includes(match[2] ?? '')
        ) {
          throw new Error(
            `Workspace review patch contains unsupported file modes: ${review.review.id}`
          );
        }
        actualChanges.set(path, {
          binary: numstat.get(path) ?? false,
          newMode: match[2] ?? '',
          newObjectId: match[4] ?? '',
          oldMode: match[1] ?? '',
          oldObjectId: match[3] ?? '',
          status: match[5] ?? '',
        });
      }

      for (const declared of review.changeSet.changedPaths) {
        const expected = declared.oldPath
          ? [
              { path: declared.oldPath, status: 'D' },
              { path: declared.path, status: 'A' },
            ]
          : [
              {
                path: declared.path,
                status:
                  declared.status === 'added' ? 'A' : declared.status === 'deleted' ? 'D' : 'M',
              },
            ];

        for (const expectedChange of expected) {
          const actual = actualChanges.get(expectedChange.path);
          if (
            !actual ||
            actual.status !== expectedChange.status ||
            actual.binary !== declared.binary
          ) {
            throw new Error(
              `Workspace review patch metadata does not match declared changes: ${review.review.id}`
            );
          }
        }

        const oldChange = actualChanges.get(declared.oldPath ?? declared.path);
        const newChange = actualChanges.get(declared.path);
        const oldPermissions = gitPermissions(oldChange?.oldMode);
        const newPermissions = gitPermissions(newChange?.newMode);
        const modeChanged = Boolean(
          oldPermissions && newPermissions && oldPermissions !== newPermissions
        );
        const contentChanged = Boolean(
          oldChange?.oldObjectId &&
            newChange?.newObjectId &&
            oldChange.oldObjectId !== newChange.newObjectId
        );
        if (
          (declared.oldPermissions !== undefined && declared.oldPermissions !== oldPermissions) ||
          (declared.newPermissions !== undefined && declared.newPermissions !== newPermissions) ||
          (modeChanged &&
            (declared.oldPermissions !== oldPermissions ||
              declared.newPermissions !== newPermissions)) ||
          (declared.status === 'mode_changed' && (!modeChanged || contentChanged)) ||
          (declared.status === 'modified' && !contentChanged)
        ) {
          throw new Error(
            `Workspace review patch mode metadata does not match declared changes: ${review.review.id}`
          );
        }

        if (!declared.binary && declared.binaryReview) {
          throw new Error(
            `Workspace review binary presentation does not match declared changes: ${review.review.id}`
          );
        }
        if (declared.binary) {
          const blobChange = declared.status === 'deleted' ? oldChange : newChange;
          const blobObjectId =
            declared.status === 'deleted' ? blobChange?.oldObjectId : blobChange?.newObjectId;
          const blob = await inspectGitBlob(context, worktreePath, blobObjectId, review.review.id);
          if (
            declared.size !== blob.bytes ||
            declared.digest !== blob.digest ||
            !declared.binaryReview ||
            declared.binaryReview.mode !== 'artifact-only' ||
            declared.binaryReview.bytes !== blob.bytes ||
            declared.binaryReview.digest !== blob.digest ||
            declared.binaryReview.mediaType !== (declared.mediaType ?? 'application/octet-stream')
          ) {
            throw new Error(
              `Workspace review binary metadata does not match the reviewed blob: ${review.review.id}`
            );
          }
        }
      }

      const treeId = requireCommitId(
        (await runGit(context, worktreePath, ['write-tree'])).trim(),
        `Workspace review produced no safe tree id: ${review.review.id}`
      );
      return { baseCommit, touchedPaths, treeId };
    },
    () =>
      runGit(context, repositoryPath, ['worktree', 'remove', '--force', worktreePath]).then(
        () => {}
      ),
    `Workspace review patch preparation and worktree cleanup both failed: ${review.review.id}`
  );
}

/**
 * Rejects Git clean filters before reviewed bytes are hashed or applied.
 *
 * @param context Git operation context.
 * @param repositoryPath Git worktree whose attributes must be checked.
 * @param touchedPaths Exact reviewed path set.
 * @param reviewId Review id used in diagnostics.
 * @param cached Whether to inspect only index attributes.
 */
async function requireNoGitFilters(
  context: GitOperationContext,
  repositoryPath: string,
  touchedPaths: readonly string[],
  reviewId: string,
  cached: boolean
): Promise<void> {
  const filterAttributes = (
    await runGit(context, repositoryPath, [
      'check-attr',
      ...(cached ? ['--cached'] : []),
      '-z',
      'filter',
      '--',
      ...touchedPaths,
    ])
  ).split('\0');
  filterAttributes.pop();
  if (
    filterAttributes.length !== touchedPaths.length * 3 ||
    filterAttributes.some(
      (value, index) => index % 3 === 2 && value !== 'unspecified' && value !== 'unset'
    )
  ) {
    throw new Error(`Workspace review touched paths cannot use Git filters: ${reviewId}`);
  }
}

/**
 * Converts one raw Git tree mode to the public permission summary.
 *
 * @param mode Six-digit raw Git mode, or absent.
 * @returns Four-digit permission summary for regular files, or undefined.
 */
function gitPermissions(mode: string | undefined): string | undefined {
  return !mode || mode === '000000' ? undefined : `0${mode.slice(-3)}`;
}

/**
 * Streams one validated blob into its exact byte count and SHA-256 digest.
 *
 * @param context Git operation context.
 * @param repositoryPath Git worktree used to resolve the object database.
 * @param objectId Candidate full blob id.
 * @param reviewId Review id used in diagnostics.
 * @returns Exact blob byte count and digest without buffering the complete blob.
 */
async function inspectGitBlob(
  context: GitOperationContext,
  repositoryPath: string,
  objectId: string | undefined,
  reviewId: string
): Promise<{ readonly bytes: number; readonly digest: string }> {
  if (!objectId || !GIT_OBJECT_ID_PATTERN.test(objectId) || /^0+$/.test(objectId)) {
    throw new Error(`Workspace review binary blob is invalid: ${reviewId}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  await runGitBytes(
    context,
    repositoryPath,
    ['cat-file', 'blob', objectId],
    '',
    {},
    false,
    (chunk) => {
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
  );
  return { bytes, digest: `sha256:${hash.digest('hex')}` };
}

/**
 * Rejects touched tracked paths hidden from ordinary status output by index flags.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param touchedPaths Exact reviewed path set.
 * @param reviewId Review id used in diagnostics.
 */
async function requireVisibleTouchedIndexState(
  context: GitOperationContext,
  repositoryPath: string,
  touchedPaths: readonly string[],
  reviewId: string
): Promise<void> {
  const entries = (
    await runGit(context, repositoryPath, ['ls-files', '-v', '-z', '--', ...touchedPaths])
  )
    .split('\0')
    .filter(Boolean);
  if (entries.some((entry) => entry.startsWith('S ') || /^[a-z] /.test(entry))) {
    throw new Error(`Workspace review target index state is hidden: ${reviewId}`);
  }
}

/**
 * Checks whether every reviewed worktree path exactly matches the prepared tree.
 *
 * This probe includes ignored and untracked files, which porcelain diff commands can
 * omit during recovery after a no-commit apply.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param prepared Exact prepared review tree and path set.
 * @returns True only when all reviewed paths match the prepared tree exactly.
 */
async function worktreeMatchesPreparedTree(
  context: GitOperationContext,
  repositoryPath: string,
  prepared: PreparedWorkspaceReviewPatch
): Promise<boolean> {
  const expectedEntries = new Map<string, { readonly mode: string; readonly objectId: string }>();
  const records = (
    await runGit(context, repositoryPath, [
      'ls-tree',
      '-z',
      prepared.treeId,
      '--',
      ...prepared.touchedPaths,
    ])
  )
    .split('\0')
    .filter(Boolean);
  for (const record of records) {
    const separator = record.indexOf('\t');
    const fields = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    if (
      separator < 0 ||
      fields.length !== 3 ||
      fields[1] !== 'blob' ||
      !['100644', '100755'].includes(fields[0] ?? '') ||
      !GIT_OBJECT_ID_PATTERN.test(fields[2] ?? '') ||
      !prepared.touchedPaths.includes(path)
    ) {
      throw new Error('Workspace review prepared tree contains invalid entries.');
    }
    expectedEntries.set(path, { mode: fields[0] ?? '', objectId: fields[2] ?? '' });
  }

  const canonicalRoot = await realpath(repositoryPath);
  for (const path of prepared.touchedPaths) {
    const expected = expectedEntries.get(path);
    const absolutePath = join(canonicalRoot, path);
    let checkedPath = canonicalRoot;
    for (const segment of path.split('/')) {
      checkedPath = join(checkedPath, segment);
      try {
        if ((await lstat(checkedPath)).isSymbolicLink()) {
          throw new Error(`Workspace review target path uses a symlink: ${path}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          break;
        }
        throw error;
      }
    }
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (expected) {
          return false;
        }
        continue;
      }
      throw error;
    }
    if (!expected || !stats.isFile()) {
      return false;
    }
    const canonicalPath = await realpath(absolutePath);
    const pathFromRoot = relative(canonicalRoot, canonicalPath);
    if (canonicalPath !== absolutePath) {
      throw new Error(`Workspace review target path uses a symlink: ${path}`);
    }
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      return false;
    }
    const mode = stats.mode & 0o111 ? '100755' : '100644';
    const objectId = (
      await runGit(context, canonicalRoot, ['hash-object', `--path=${path}`, '--', path])
    ).trim();
    if (mode !== expected.mode || objectId.toLowerCase() !== expected.objectId.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * Creates one commit object from an already validated tree without hooks or signing.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param prepared Validated patch tree.
 * @param message Lineage-bearing commit message.
 * @param identity Configured human Git identity.
 * @returns New commit object id.
 */
async function createCommitObject(
  context: GitOperationContext,
  repositoryPath: string,
  prepared: PreparedWorkspaceReviewPatch,
  message: string,
  identity: { readonly email: string; readonly name: string }
): Promise<string> {
  return requireCommitId(
    (
      await runGit(
        context,
        repositoryPath,
        ['commit-tree', prepared.treeId, '-p', prepared.baseCommit],
        message,
        {
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_AUTHOR_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
        }
      )
    ).trim(),
    'Git did not return a safe workspace review commit id.'
  );
}

/**
 * Reads one exact Git ref without accepting revision expressions.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param ref Full ref name.
 * @returns Referenced commit id, or null when the ref is absent.
 */
async function readRef(
  context: GitOperationContext,
  repositoryPath: string,
  ref: string
): Promise<string | null> {
  const output = (
    await runGit(
      context,
      repositoryPath,
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      '',
      {},
      true
    )
  ).trim();
  return output ? requireCommitId(output, `Git ref has no safe commit id: ${ref}`) : null;
}

/**
 * Rejects deleting a review branch that any linked worktree currently owns.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param branchRef Exact full review branch ref.
 * @param reviewId Review id used in diagnostics.
 */
async function requireReviewBranchNotCheckedOut(
  context: GitOperationContext,
  repositoryPath: string,
  branchRef: string,
  reviewId: string
): Promise<void> {
  const worktrees = await runGit(context, repositoryPath, ['worktree', 'list', '--porcelain']);
  if (worktrees.split('\n').includes(`branch ${branchRef}`)) {
    throw new Error(`Workspace review branch is checked out in a linked worktree: ${reviewId}`);
  }
}

/**
 * Requires one existing commit to match the exact review tree, parent, message, and identity.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param commitId Existing reserved branch commit.
 * @param prepared Validated patch tree and base.
 * @param message Expected review commit message.
 * @param identity Expected author and committer identity.
 * @param reviewId Workspace review id used in diagnostics.
 */
async function requireMatchingReviewCommit(
  context: GitOperationContext,
  repositoryPath: string,
  commitId: string,
  prepared: PreparedWorkspaceReviewPatch,
  message: string,
  identity: { readonly email: string; readonly name: string },
  reviewId: string
): Promise<void> {
  const fields = (
    await runGit(context, repositoryPath, [
      'show',
      '-s',
      '--format=%T%x00%P%x00%B%x00%an%x00%ae%x00%cn%x00%ce',
      commitId,
    ])
  ).split('\0');
  const [treeId, parents, commitMessage, authorName, authorEmail, committerName, committerEmail] =
    fields;
  if (
    fields.length !== 7 ||
    treeId?.trim() !== prepared.treeId ||
    parents?.trim() !== prepared.baseCommit ||
    commitMessage?.trimEnd() !== message.trimEnd() ||
    authorName !== identity.name ||
    authorEmail !== identity.email ||
    committerName !== identity.name ||
    committerEmail?.trimEnd() !== identity.email
  ) {
    throw new Error(`Git commit conflicts with expected workspace review: ${reviewId}`);
  }
}

/**
 * Rolls back every completed apply effect while collecting all failures.
 *
 * @param input Completed effect flags and immutable rollback material.
 * @returns Rollback failures; empty means the original state was restored.
 */
async function rollbackAppliedReview(input: {
  readonly baseCommit: string;
  readonly branchDeleted: boolean;
  readonly branchRef: string | null;
  readonly context: GitOperationContext;
  readonly detachedHead: boolean;
  readonly headRef: string;
  readonly headUpdated: boolean;
  readonly newHead: string | null;
  readonly patchApplied: boolean;
  readonly patchText: string;
  readonly prepared: PreparedWorkspaceReviewPatch;
  readonly repositoryPath: string;
  readonly reviewId: string;
  readonly stagedCommit: string | null;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  let ownsAppliedState = true;

  if (input.headUpdated && input.newHead) {
    try {
      await compareAndSwapRef(
        input.context,
        input.repositoryPath,
        input.headRef,
        input.baseCommit,
        input.newHead,
        'OpenKit rolled back workspace review apply',
        input.detachedHead
      );
    } catch (error) {
      failures.push(error);
      ownsAppliedState = false;
    }
  }

  if (input.patchApplied && ownsAppliedState) {
    try {
      ownsAppliedState = await workspaceReviewApplyStateIsOwned({
        baseCommit: input.baseCommit,
        context: input.context,
        detachedHead: input.detachedHead,
        headRef: input.headRef,
        indexTreeId: input.newHead ? input.prepared.treeId : input.baseCommit,
        prepared: input.prepared,
        repositoryPath: input.repositoryPath,
        reviewId: input.reviewId,
      });
      if (!ownsAppliedState) {
        failures.push(new Error('Workspace review apply rollback lost repository ownership.'));
      }
    } catch (error) {
      failures.push(error);
      ownsAppliedState = false;
    }
  }

  if (input.patchApplied && input.newHead && ownsAppliedState) {
    try {
      await runGit(input.context, input.repositoryPath, [
        'reset',
        input.baseCommit,
        '--',
        ...input.prepared.touchedPaths,
      ]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (input.patchApplied && ownsAppliedState) {
    try {
      await runGit(
        input.context,
        input.repositoryPath,
        ['apply', '--reverse', '--whitespace=nowarn', '-'],
        input.patchText
      );
    } catch (error) {
      failures.push(error);
    }
  }

  if (input.branchDeleted && input.branchRef && input.stagedCommit) {
    try {
      await compareAndSwapRef(
        input.context,
        input.repositoryPath,
        input.branchRef,
        input.stagedCommit,
        zeroObjectId(input.stagedCommit),
        'OpenKit restored workspace review branch',
        false
      );
    } catch (error) {
      failures.push(error);
    }
  }

  return failures;
}

/**
 * Checks that HEAD, index, and worktree still contain the exact OpenKit-applied state.
 *
 * @param input Expected branch, commits, prepared tree, and repository context.
 * @returns True only while destructive rollback still owns every reviewed path.
 */
async function workspaceReviewApplyStateIsOwned(input: {
  readonly baseCommit: string;
  readonly context: GitOperationContext;
  readonly detachedHead: boolean;
  readonly headRef: string;
  readonly indexTreeId: string;
  readonly prepared: PreparedWorkspaceReviewPatch;
  readonly repositoryPath: string;
  readonly reviewId: string;
}): Promise<boolean> {
  const currentHead = (
    await runGit(input.context, input.repositoryPath, ['rev-parse', '--verify', 'HEAD'])
  ).trim();
  const symbolicHead = (
    await runGit(input.context, input.repositoryPath, ['symbolic-ref', '-q', 'HEAD'], '', {}, true)
  ).trim();
  if (
    currentHead.toLowerCase() !== input.baseCommit.toLowerCase() ||
    (input.detachedHead ? symbolicHead !== '' : symbolicHead !== input.headRef)
  ) {
    return false;
  }
  await requireVisibleTouchedIndexState(
    input.context,
    input.repositoryPath,
    input.prepared.touchedPaths,
    input.reviewId
  );
  const indexDrift = await runGit(input.context, input.repositoryPath, [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    input.indexTreeId,
    '--',
    ...input.prepared.touchedPaths,
  ]);
  return (
    indexDrift === '' &&
    (await worktreeMatchesPreparedTree(input.context, input.repositoryPath, input.prepared))
  );
}

/**
 * Validates repository and review ownership for Git operations.
 *
 * @param repository Linked repository resource.
 * @param review Workspace review candidate.
 */
function requireGitReview(
  repository: WorkspaceRepositoryResourceRecord,
  review: WorkspaceSyncReviewItem
): void {
  if (review.changeSet.strategy !== 'git') {
    throw new Error(`Workspace review is not Git-backed: ${review.review.id}`);
  }
  if (review.review.staging.strategy !== 'git_worktree') {
    throw new Error(`Workspace review does not use Git worktree staging: ${review.review.id}`);
  }
  if (review.review.status !== 'pending') {
    throw new Error(`Workspace review is not pending: ${review.review.id}`);
  }
  if (
    review.changeSet.resourceId !== repository.resourceId ||
    review.changeSet.workspaceId !== repository.workspaceId ||
    review.review.workspaceId !== repository.workspaceId ||
    review.review.changeSetId !== review.changeSet.id
  ) {
    throw new Error(`Workspace review does not match linked repository: ${review.review.id}`);
  }
}

/**
 * Returns the configured Git identity required for OpenKit-created commits.
 *
 * @param repository Linked repository resource.
 * @param review Workspace review used in diagnostics.
 * @returns Configured human Git identity.
 */
function requireGitIdentity(
  repository: WorkspaceRepositoryResourceRecord,
  review: WorkspaceSyncReviewItem
): { readonly email: string; readonly name: string } {
  if (!repository.git.authorName || !repository.git.authorEmail) {
    throw new Error(`Workspace repository has no Git identity: ${review.review.id}`);
  }
  return { email: repository.git.authorEmail, name: repository.git.authorName };
}

/**
 * Reads the exact reserved local branch name for one workspace review.
 *
 * @param review Workspace review candidate.
 * @returns Safe NanoCore-owned branch name.
 */
function requireWorkspaceReviewBranch(review: WorkspaceSyncReviewItem): string {
  const branch = review.review.staging.branch;
  const expected = `openkit/review/${review.review.id}`;
  if (branch !== expected || !REVIEW_BRANCH_PATTERN.test(branch)) {
    throw new Error(`Workspace review branch is not safe: ${review.review.id}`);
  }
  return branch;
}

/**
 * Validates one full Git object id.
 *
 * @param value Candidate object id.
 * @param message Error message for invalid values.
 * @returns Safe full object id.
 */
function requireCommitId(value: string | null, message: string): string {
  if (!value || !GIT_OBJECT_ID_PATTERN.test(value)) {
    throw new Error(message);
  }
  return value;
}

/**
 * Returns every exact path owned by a change set, including rename sources.
 *
 * @param review Workspace review with declared changes.
 * @returns Stable declared path set.
 */
function declaredTouchedPaths(review: WorkspaceSyncReviewItem): string[] {
  if (
    review.changeSet.changedPaths.some(
      (entry) => (entry.status === 'renamed') !== Boolean(entry.oldPath)
    )
  ) {
    throw new Error(`Workspace review has invalid rename metadata: ${review.review.id}`);
  }
  const paths = review.changeSet.changedPaths.flatMap((entry) =>
    entry.oldPath ? [entry.oldPath, entry.path] : [entry.path]
  );
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`Workspace review has an invalid declared path set: ${review.review.id}`);
  }
  return [...paths].sort();
}

/**
 * Verifies patch payload integrity and normalizes its trailing newline for Git.
 *
 * @param review Workspace review with patch payload and reference.
 * @returns Git-apply-ready patch text.
 */
function workspaceReviewPatchText(review: WorkspaceSyncReviewItem): string {
  const payload = review.patchPayload;
  const reference = review.changeSet.patch;
  if (!payload || !reference) {
    throw new Error(`Workspace review has no patch payload: ${review.review.id}`);
  }
  const digest = `sha256:${createHash('sha256').update(payload.text).digest('hex')}`;
  const bytes = Buffer.byteLength(payload.text, 'utf8');
  if (
    reference.digest !== payload.digest ||
    reference.bytes !== payload.bytes ||
    digest !== payload.digest ||
    bytes !== payload.bytes
  ) {
    throw new Error(
      `Workspace review patch payload failed integrity validation: ${review.review.id}`
    );
  }
  return payload.text.length > 0 && !payload.text.endsWith('\n')
    ? `${payload.text}\n`
    : payload.text;
}

/**
 * Builds one lineage-bearing staged or applied commit message.
 *
 * @param store App-local store that owns worker lineage.
 * @param review Workspace review being committed.
 * @param staged Whether this is an ephemeral review-branch commit.
 * @returns Git commit message.
 */
function workspaceReviewCommitMessage(
  store: FsStore,
  review: WorkspaceSyncReviewItem,
  staged: boolean
): string {
  const workerRefs = review.changeSet.evidenceRefs.filter((ref) => ref.kind === 'worker');
  if (workerRefs.length !== 1) {
    throw new Error(`Workspace review has invalid worker turn lineage: ${review.review.id}`);
  }
  const turnId = workerRefs[0]?.ref ?? '';
  const turn = store.getTurnById(turnId);
  if (turn.workspaceId !== review.review.workspaceId) {
    throw new Error(
      `Workspace review worker turn belongs to another workspace: ${review.review.id}`
    );
  }
  const agentId = turn.agentId ?? store.resolveTurnAgentId(turn);
  const agent = agentId ? store.getAgent(review.review.workspaceId, agentId) : null;
  const safeAgentId = (agent?.id ?? 'unknown-agent').replace(/[^A-Za-z0-9._+-]/g, '-');
  const workerName =
    (agent?.name ?? 'Unknown OpenKit Agent')
      .replace(/[<>\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown OpenKit Agent';
  return [
    `${staged ? 'Stage' : 'Apply'} workspace review ${review.review.id}`,
    '',
    review.review.riskSummary,
    '',
    `OpenKit-Review-Id: ${review.review.id}`,
    `OpenKit-Turn-Id: ${turnId}`,
    `OpenKit-Workspace-Id: ${review.review.workspaceId}`,
    ...(staged ? ['Staged-By: OpenKit'] : []),
    `Co-Authored-By: ${workerName} <${safeAgentId}@agents.openkit.invalid>`,
    '',
  ].join('\n');
}

/**
 * Creates, updates, or deletes one Git ref with an expected old object id.
 *
 * @param context Git operation context.
 * @param repositoryPath Linked repository working directory.
 * @param ref Full ref name or detached HEAD.
 * @param newObjectId New object id, or null to delete the ref.
 * @param expectedObjectId Required current object id.
 * @param reason Reflog reason.
 * @param noDeref Whether a detached HEAD must be updated directly.
 */
async function compareAndSwapRef(
  context: GitOperationContext,
  repositoryPath: string,
  ref: string,
  newObjectId: string | null,
  expectedObjectId: string,
  reason: string,
  noDeref = false
): Promise<void> {
  await runGit(context, repositoryPath, [
    'update-ref',
    ...(noDeref ? ['--no-deref'] : []),
    '-m',
    reason,
    ...(newObjectId ? [] : ['-d']),
    ref,
    ...(newObjectId ? [newObjectId] : []),
    expectedObjectId,
  ]);
}

/**
 * Returns the all-zero old-object sentinel for an object format.
 *
 * @param objectId Full object id whose length identifies the format.
 * @returns All-zero object id of the same length.
 */
function zeroObjectId(objectId: string): string {
  return '0'.repeat(objectId.length);
}

/**
 * Executes one operation and one mandatory cleanup while preserving both failures.
 *
 * @template Result Operation result type.
 * @param operation Main operation.
 * @param cleanup Mandatory cleanup.
 * @param aggregateMessage Message used when both fail.
 * @returns Main operation result.
 */
async function withCleanup<Result>(
  operation: () => Promise<Result>,
  cleanup: () => Promise<void>,
  aggregateMessage: string
): Promise<Result> {
  let result: Result | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await cleanup();
  } catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError([operationError, cleanupError], aggregateMessage);
    }
    throw cleanupError;
  }
  if (operationFailed) {
    throw operationError;
  }
  return result as Result;
}

/**
 * Runs one fixed Git command and requires a zero exit status.
 *
 * @param context Git operation context.
 * @param cwd Git working directory.
 * @param args Fixed Git argument vector.
 * @param stdin Optional standard input.
 * @param extraEnv Optional controlled author and committer variables.
 * @param allowExitOne Whether a probe may use exit status one to mean absent.
 * @returns Captured standard output.
 */
async function runGit(
  context: GitOperationContext,
  cwd: string,
  args: readonly string[],
  stdin = '',
  extraEnv: Readonly<Record<string, string>> = {},
  allowExitOne = false
): Promise<string> {
  return (await runGitBytes(context, cwd, args, stdin, extraEnv, allowExitOne)).toString('utf8');
}

/**
 * Runs one fixed Git command and returns raw standard output bytes.
 *
 * @param context Git operation context.
 * @param cwd Git working directory.
 * @param args Fixed Git argument vector.
 * @param stdin Optional standard input.
 * @param extraEnv Optional controlled author and committer variables.
 * @param allowExitOne Whether a probe may use exit status one to mean absent.
 * @param consumeStdout Optional streaming consumer that disables output buffering.
 * @returns Captured standard output bytes.
 */
async function runGitBytes(
  context: GitOperationContext,
  cwd: string,
  args: readonly string[],
  stdin: string | Buffer = '',
  extraEnv: Readonly<Record<string, string>> = {},
  allowExitOne = false,
  consumeStdout?: (chunk: Buffer) => void
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...context.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    let finished = false;
    const finish = (callback: () => void): void => {
      if (!finished) {
        finished = true;
        callback();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (consumeStdout) {
        consumeStdout(chunk);
      } else {
        stdoutChunks.push(chunk);
      }
    });
    child.stderr?.resume();
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        finish(() => reject(new Error(`Git ${args[0] ?? 'command'} input failed.`)));
      }
    });
    child.on('error', () =>
      finish(() => reject(new Error(`Git ${args[0] ?? 'command'} could not start.`)))
    );
    child.on('close', (exitCode, signal) => {
      const stdout = Buffer.concat(stdoutChunks);
      if (exitCode === 0 || (allowExitOne && exitCode === 1)) {
        finish(() => resolve(stdout));
        return;
      }
      const failure = signal
        ? `was terminated by signal ${signal}`
        : `failed with exit code ${exitCode ?? 'unknown'}`;
      finish(() => reject(new Error(`Git ${args[0] ?? 'command'} ${failure}.`)));
    });
    child.stdin.end(stdin);
  });
}
