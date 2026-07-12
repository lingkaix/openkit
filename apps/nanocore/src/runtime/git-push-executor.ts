import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitPushRecord } from '@openkit/app-api-schemas';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  assertGitPushCommandShape,
  buildGitPushCommand,
  createGitPushEnvironment,
  type GitPushCommand,
  isGitHubPushTarget,
} from './git-push-command.js';
import {
  type PrepareGitPushAttemptInput,
  prepareGitPushAttempt,
  recordGitPushRecord,
} from './git-push-records.js';

/** Fixed Git push command with execution context. */
export interface GitPushCommandRunnerInput extends GitPushCommand {
  /** Linked repository working directory. */
  readonly cwd: string;
}

/** Result returned by the host-side Git push command runner. */
export interface GitPushCommandRunnerResult {
  /** Process exit code. */
  readonly exitCode: number;
  /** Captured stderr. */
  readonly stderr: string;
  /** Captured stdout. */
  readonly stdout: string;
}

/** Host-side Git push command runner. */
export type GitPushCommandRunner = (
  input: GitPushCommandRunnerInput
) => Promise<GitPushCommandRunnerResult>;

/**
 * Runs one fixed Git push command on the NanoCore host.
 *
 * @param input Fixed command vector and repository working directory.
 * @returns Captured process result.
 */
export async function runGitPushCommand(
  input: GitPushCommandRunnerInput
): Promise<GitPushCommandRunnerResult> {
  return await new Promise<GitPushCommandRunnerResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    });
  });
}

/** Input for executing one Git push attempt through a provider runner. */
export interface ExecuteGitPushAttemptInput {
  /** Preflight and record lineage input. */
  readonly attempt: PrepareGitPushAttemptInput;
  /** Candidate process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Approved repository object directory exposed to the isolated Git view. */
  readonly objectDirectory: string;
  /** Git object format required by the approved repository object database. */
  readonly objectFormat: 'sha1' | 'sha256';
  /** Lazily resolves process environment after preflight and policy checks pass. */
  readonly resolveEnv?: (capabilityCallId: string) => NodeJS.ProcessEnv | undefined;
  /** V1 provider gate result. */
  readonly provider: 'github' | 'unsupported';
  /** Remote name selected by the provider adapter. */
  readonly remoteName: string;
  /** Fixed-command runner. */
  readonly runner: GitPushCommandRunner;
  /** Immutable source commit resolved from the approved source ref. */
  readonly sourceCommit: string;
}

/**
 * Runs a preflighted Git push attempt and records its terminal public outcome.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Push attempt execution input.
 * @returns Durable Git push record.
 */
export async function executeGitPushAttempt(
  workspaceDb: WorkspaceDb,
  input: ExecuteGitPushAttemptInput
): Promise<GitPushRecord> {
  const preflight = prepareGitPushAttempt(workspaceDb, input.attempt);

  if (preflight.status === 'recorded-refusal') {
    return preflight.record;
  }

  if (!allowsRepoPush(workspaceDb, input)) {
    return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, {
      errorSummary: 'Git push refused because the repo.push policy decision is not allowed.',
      outcome: 'refused-policy',
      remoteHeadAfter: null,
    });
  }

  if (input.provider !== 'github' || !isGitHubPushTarget(input.remoteName)) {
    return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, {
      errorSummary: 'Git push refused because V1 supports GitHub remotes only.',
      outcome: 'unsupported-provider',
      remoteHeadAfter: null,
    });
  }

  try {
    if (!isGitObjectId(input.sourceCommit, input.objectFormat)) {
      throw new Error('Git source commit does not match the repository object format.');
    }
    assertGitPushCommandShape(input.remoteName, input.sourceCommit, input.attempt.targetBranch);
  } catch {
    return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, {
      errorSummary: 'Git push refused because the approved ref shape is not safe.',
      outcome: 'refused-policy',
      remoteHeadAfter: null,
    });
  }

  let view: ReturnType<typeof createGitPushExecutionView>;
  try {
    view = createGitPushExecutionView(input.objectDirectory, input.objectFormat);
  } catch {
    return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, {
      errorSummary: 'Git push failed before the isolated Git view could be prepared.',
      outcome: 'remote-unreachable',
      remoteHeadAfter: null,
    });
  }

  try {
    const capabilityCallId = `cap_${input.attempt.recordId}`;
    const now = new Date(timestamp(input));
    const call = startCapabilityCall({
      workspaceDb,
      callId: capabilityCallId,
      capabilityId: 'workspace.git.push',
      family: 'network',
      operation: 'git.push',
      providerRef: 'github',
      redactionClass: 'product-safe',
      requestId: input.attempt.requestId,
      serviceRef: input.attempt.repositoryResourceId,
      summary: `Git push to ${input.attempt.targetBranch}`,
      workspaceId: input.attempt.workspaceId,
      now,
    });
    let env: NodeJS.ProcessEnv | undefined;
    try {
      env = input.env ?? input.resolveEnv?.(call.id);
      if (!env?.GITHUB_TOKEN && !env?.GH_TOKEN) {
        throw new Error('GitHub credential is unavailable.');
      }
    } catch {
      finishCapabilityCall({
        workspaceDb,
        callId: call.id,
        errorCode: 'auth-failed',
        status: 'failed',
        now,
      });
      return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, {
        errorSummary: 'Git push authentication material could not be resolved.',
        outcome: 'auth-failed',
        remoteHeadAfter: null,
      });
    }
    const networkEnv = { ...createGitPushEnvironment(env, input.remoteName), ...view.env };
    delete networkEnv.HOME;
    const localEnv = { ...view.env };
    delete localEnv.HOME;
    let networkCalls = 1;
    let runnerFailed = false;
    let outcome: Pick<GitPushRecord, 'errorSummary' | 'outcome' | 'remoteHeadAfter'> | null = null;
    let remoteHeadBefore: string | null = null;
    let remoteResult: GitPushCommandRunnerResult;
    try {
      remoteResult = await input.runner({
        args: [
          'ls-remote',
          '--refs',
          '--heads',
          '--',
          input.remoteName,
          `refs/heads/${input.attempt.targetBranch}`,
        ],
        command: 'git',
        cwd: view.directory,
        env: networkEnv,
      });
    } catch {
      runnerFailed = true;
      remoteResult = { exitCode: 1, stderr: '', stdout: '' };
    }

    if (remoteResult.exitCode !== 0) {
      outcome = failedPush(input, preflight.reviewIds, remoteResult);
    } else {
      const remoteLines = remoteResult.stdout.split(/\r?\n/).filter(Boolean);
      if (remoteLines.length === 1) {
        const [commitId, refName, extra] = remoteLines[0]?.split(/\s+/) ?? [];
        if (
          extra ||
          !commitId ||
          !isGitObjectId(commitId, input.objectFormat) ||
          refName !== `refs/heads/${input.attempt.targetBranch}`
        ) {
          outcome = {
            errorSummary: 'Git push failed because the remote head response was invalid.',
            outcome: 'remote-unreachable',
            remoteHeadAfter: null,
          };
        } else {
          remoteHeadBefore = commitId;
        }
      } else if (remoteLines.length === 0) {
        outcome = {
          errorSummary: 'Git push refused because V1 does not create remote branches.',
          outcome: 'refused-policy',
          remoteHeadAfter: null,
        };
      } else {
        outcome = {
          errorSummary: 'Git push failed because the remote head response was ambiguous.',
          outcome: 'remote-unreachable',
          remoteHeadAfter: null,
        };
      }
    }

    if (!outcome && remoteHeadBefore) {
      let ancestryResult: GitPushCommandRunnerResult;
      try {
        ancestryResult = await input.runner({
          args: ['merge-base', '--is-ancestor', remoteHeadBefore, input.sourceCommit],
          command: 'git',
          cwd: view.directory,
          env: localEnv,
        });
      } catch {
        runnerFailed = true;
        ancestryResult = { exitCode: 1, stderr: '', stdout: '' };
      }

      if (ancestryResult.exitCode !== 0) {
        outcome = {
          errorSummary: 'Git push rejected because the observed remote head is not an ancestor.',
          outcome: 'rejected-non-fast-forward',
          remoteHeadAfter: null,
        };
      }
    }

    if (!outcome && remoteHeadBefore) {
      let rangeResult: GitPushCommandRunnerResult;
      try {
        rangeResult = await input.runner({
          args: [
            'rev-list',
            '--reverse',
            '--topo-order',
            `${remoteHeadBefore}..${input.sourceCommit}`,
          ],
          command: 'git',
          cwd: view.directory,
          env: localEnv,
        });
      } catch {
        runnerFailed = true;
        rangeResult = { exitCode: 1, stderr: '', stdout: '' };
      }

      const outgoingCommitIds = rangeResult.stdout.split(/\r?\n/).filter(Boolean);
      if (
        rangeResult.exitCode !== 0 ||
        outgoingCommitIds.some((commitId) => !isGitObjectId(commitId, input.objectFormat)) ||
        (outgoingCommitIds.length > 0 && outgoingCommitIds.at(-1) !== input.sourceCommit)
      ) {
        outcome = {
          errorSummary: 'Git push rejected because the observed remote head cannot be verified.',
          outcome: 'rejected-non-fast-forward',
          remoteHeadAfter: null,
        };
      } else {
        const approvedCommitIds = new Set(input.attempt.commitIds);
        const outgoingCommitSet = new Set(outgoingCommitIds);
        if (
          approvedCommitIds.size !== input.attempt.commitIds.length ||
          outgoingCommitSet.size !== outgoingCommitIds.length ||
          approvedCommitIds.size !== outgoingCommitSet.size ||
          outgoingCommitIds.some((commitId) => !approvedCommitIds.has(commitId))
        ) {
          outcome = {
            errorSummary:
              'Git push refused because approved commits do not match the outgoing range.',
            outcome: 'refused-linkage',
            remoteHeadAfter: null,
          };
        }
      }
    }

    if (!outcome && remoteHeadBefore) {
      networkCalls = 2;
      const pushCommand = buildGitPushCommand({
        env,
        expectedRemoteHead: remoteHeadBefore,
        remoteName: input.remoteName,
        sourceRef: input.sourceCommit,
        targetBranch: input.attempt.targetBranch,
      });
      let pushResult: GitPushCommandRunnerResult;
      try {
        pushResult = await input.runner({
          ...pushCommand,
          cwd: view.directory,
          env: networkEnv,
        });
      } catch {
        runnerFailed = true;
        pushResult = { exitCode: 1, stderr: '', stdout: '' };
      }
      outcome =
        pushResult.exitCode === 0
          ? successfulPush(input)
          : failedPush(input, preflight.reviewIds, pushResult);
    }

    if (!outcome) {
      outcome = {
        errorSummary: 'Git push failed because the remote head could not be established.',
        outcome: 'remote-unreachable',
        remoteHeadAfter: null,
      };
    }

    recordUsage({
      workspaceDb,
      call,
      records: [
        {
          category: 'network',
          providerRef: 'github',
          quantity: networkCalls,
          source: 'git-push-executor',
          unit: 'requests',
        },
      ],
      now,
    });
    finishCapabilityCall({
      workspaceDb,
      callId: call.id,
      errorCode: runnerFailed
        ? 'git_push_runner_error'
        : outcome.errorSummary
          ? outcome.outcome
          : null,
      status: outcome.errorSummary ? 'failed' : 'succeeded',
      now,
    });

    return recordTerminalPushOutcome(
      workspaceDb,
      input,
      preflight.reviewIds,
      outcome,
      remoteHeadBefore
    );
  } finally {
    rmSync(view.directory, { force: true, recursive: true });
  }
}

/**
 * Creates one temporary bare Git view that can read approved objects without linked-repo config.
 *
 * @param objectDirectory Approved linked-repository object directory.
 * @param objectFormat Git object format used by the approved object database.
 * @returns Temporary Git directory and isolated process environment.
 */
function createGitPushExecutionView(
  objectDirectory: string,
  objectFormat: 'sha1' | 'sha256'
): {
  readonly directory: string;
  readonly env: Record<string, string>;
} {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-git-push-view-'));
  const processEnv = {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };

  try {
    execFileSync(
      'git',
      ['init', '--bare', '--template=', `--object-format=${objectFormat}`, directory],
      {
        env: processEnv,
        stdio: 'ignore',
      }
    );
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }

  return {
    directory,
    env: {
      ...processEnv,
      GIT_DIR: directory,
      GIT_OBJECT_DIRECTORY: objectDirectory,
    },
  };
}

/**
 * Checks whether one object id matches the repository's storage hash format.
 *
 * @param value Candidate Git object id.
 * @param objectFormat Repository object format.
 * @returns True when the id is lowercase hexadecimal with the required length.
 */
function isGitObjectId(value: string, objectFormat: 'sha1' | 'sha256'): boolean {
  return /^[a-f0-9]+$/.test(value) && value.length === (objectFormat === 'sha1' ? 40 : 64);
}

/**
 * Verifies that the selected immutable permission decision allows this push.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Push execution input.
 * @returns True when the decision allows the target push.
 */
function allowsRepoPush(workspaceDb: WorkspaceDb, input: ExecuteGitPushAttemptInput): boolean {
  const decisionId = input.attempt.policyDecisionId;

  if (!decisionId) {
    return false;
  }

  const row = workspaceDb.sqlite
    .prepare(
      `SELECT action, owner_scope, workspace_id, result, resource_summary_json
       FROM permission_decisions
       WHERE decision_id = ?`
    )
    .get(decisionId) as
    | {
        action: string;
        owner_scope: string;
        resource_summary_json: string;
        result: string;
        workspace_id: string | null;
      }
    | undefined;

  if (
    !row ||
    row.action !== 'repo.push' ||
    row.owner_scope !== 'workspace' ||
    row.workspace_id !== input.attempt.workspaceId ||
    row.result !== 'allow'
  ) {
    return false;
  }

  const resource = JSON.parse(row.resource_summary_json) as Record<string, unknown>;
  return (
    resource.kind === 'git-push-target' &&
    resource.repositoryResourceId === input.attempt.repositoryResourceId &&
    resource.targetBranch === input.attempt.targetBranch &&
    resource.workspaceId === input.attempt.workspaceId
  );
}

/**
 * Records one terminal push outcome after preflight has produced review linkage.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Push execution input.
 * @param reviewIds Review ids linked by preflight.
 * @param outcome Terminal outcome fields.
 * @param remoteHeadBefore Remote target head observed before mutation.
 * @returns Durable Git push record.
 */
function recordTerminalPushOutcome(
  workspaceDb: WorkspaceDb,
  input: ExecuteGitPushAttemptInput,
  reviewIds: readonly string[],
  outcome: Pick<GitPushRecord, 'errorSummary' | 'outcome' | 'remoteHeadAfter'>,
  remoteHeadBefore: string | null = null
): GitPushRecord {
  const now = timestamp(input);

  return recordGitPushRecord(workspaceDb, {
    record: {
      actorId: input.attempt.actorId,
      approvalRowId: input.attempt.approvalRowId,
      commitIds: [...input.attempt.commitIds],
      createdAt: now,
      errorSummary: outcome.errorSummary,
      id: input.attempt.recordId,
      outcome: outcome.outcome,
      policyDecisionId: input.attempt.policyDecisionId,
      remoteHeadAfter: outcome.remoteHeadAfter,
      remoteHeadBefore,
      remoteSummary: input.attempt.remoteSummary,
      repositoryResourceId: input.attempt.repositoryResourceId,
      reviewIds: [...reviewIds],
      sourceRef: input.attempt.sourceRef,
      targetBranch: input.attempt.targetBranch,
      updatedAt: now,
      workspaceId: input.attempt.workspaceId,
    },
    requestId: input.attempt.requestId,
  });
}

/**
 * Builds a successful pushed outcome.
 *
 * @param input Push execution input.
 * @returns Public terminal outcome fields.
 */
function successfulPush(input: ExecuteGitPushAttemptInput): {
  readonly errorSummary: null;
  readonly outcome: 'pushed';
  readonly remoteHeadAfter: string | null;
} {
  return {
    errorSummary: null,
    outcome: 'pushed',
    remoteHeadAfter: input.sourceCommit,
  };
}

/**
 * Classifies a failed Git push result into the public outcome vocabulary.
 *
 * @param input Push execution input.
 * @param reviewIds Linked review ids.
 * @param result Command runner result.
 * @returns Public terminal outcome fields.
 */
function failedPush(
  input: ExecuteGitPushAttemptInput,
  reviewIds: readonly string[],
  result: GitPushCommandRunnerResult
): {
  readonly errorSummary: string;
  readonly outcome: Exclude<
    GitPushRecord['outcome'],
    'pushed' | 'refused-linkage' | 'refused-policy' | 'unsupported-provider'
  >;
  readonly remoteHeadAfter: null;
} {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();

  if (
    output.includes('non-fast-forward') ||
    output.includes('fetch first') ||
    output.includes('stale info')
  ) {
    return {
      errorSummary: 'Git push rejected because the remote has newer commits.',
      outcome: 'rejected-non-fast-forward',
      remoteHeadAfter: null,
    };
  }

  if (output.includes('protected branch') || output.includes('branch is protected')) {
    return {
      errorSummary: 'Git push rejected by remote branch protection.',
      outcome: 'rejected-protected',
      remoteHeadAfter: null,
    };
  }

  if (
    output.includes('authentication failed') ||
    output.includes('permission denied') ||
    output.includes('could not read username')
  ) {
    return {
      errorSummary: 'Git push failed because remote authentication was rejected.',
      outcome: 'auth-failed',
      remoteHeadAfter: null,
    };
  }

  return {
    errorSummary:
      reviewIds.length > 0
        ? 'Git push failed before the remote head could be updated.'
        : `Git push failed for target ${input.attempt.targetBranch}.`,
    outcome: 'remote-unreachable',
    remoteHeadAfter: null,
  };
}

/**
 * Resolves the deterministic record timestamp for one attempt.
 *
 * @param input Push execution input.
 * @returns ISO timestamp.
 */
function timestamp(input: ExecuteGitPushAttemptInput): string {
  return input.attempt.now?.() ?? new Date().toISOString();
}
