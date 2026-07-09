import { spawn } from 'node:child_process';
import type { GitPushRecord } from '@openkit/app-api-schemas';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { WorkspaceDb } from '../storage/db.js';
import { buildGitPushCommand, type GitPushCommand } from './git-push-command.js';
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
  /** Linked repository working directory. */
  readonly cwd: string;
  /** Candidate process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Lazily resolves process environment after preflight and policy checks pass. */
  readonly resolveEnv?: () => NodeJS.ProcessEnv | undefined;
  /** Remote head after a successful push, when already observed by the caller. */
  readonly remoteHeadAfter?: string | null;
  /** Remote head before the push, when already observed by the caller. */
  readonly remoteHeadBefore?: string | null;
  /** V1 provider gate result. */
  readonly provider?: 'github' | 'unsupported';
  /** Remote name selected by the provider adapter. */
  readonly remoteName: string;
  /** Fixed-command runner. */
  readonly runner: GitPushCommandRunner;
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

  if (input.provider === 'unsupported') {
    return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, {
      errorSummary: 'Git push refused because V1 supports GitHub remotes only.',
      outcome: 'unsupported-provider',
      remoteHeadAfter: null,
    });
  }

  let env: NodeJS.ProcessEnv | undefined;
  try {
    env = input.env ?? input.resolveEnv?.();
  } catch {
    return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, {
      errorSummary: 'Git push authentication material could not be resolved.',
      outcome: 'auth-failed',
      remoteHeadAfter: null,
    });
  }
  const command = buildGitPushCommand({
    remoteName: input.remoteName,
    sourceRef: input.attempt.sourceRef,
    targetBranch: input.attempt.targetBranch,
    ...(env ? { env } : {}),
  });
  const now = new Date(timestamp(input));
  const call = startCapabilityCall({
    workspaceDb,
    callId: `cap_${input.attempt.recordId}`,
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
  let result: GitPushCommandRunnerResult;
  try {
    result = await input.runner({ ...command, cwd: input.cwd });
  } catch (error) {
    finishCapabilityCall({
      workspaceDb,
      callId: call.id,
      errorCode: 'git_push_runner_error',
      status: 'failed',
      now,
    });
    throw error;
  }
  recordUsage({
    workspaceDb,
    call,
    records: [
      {
        category: 'network',
        providerRef: 'github',
        quantity: 1,
        source: 'git-push-executor',
        unit: 'requests',
      },
    ],
    now,
  });
  const outcome =
    result.exitCode === 0 ? successfulPush(input) : failedPush(input, preflight.reviewIds, result);
  finishCapabilityCall({
    workspaceDb,
    callId: call.id,
    errorCode: outcome.errorSummary ? outcome.outcome : null,
    status: outcome.errorSummary ? 'failed' : 'succeeded',
    now,
  });

  return recordTerminalPushOutcome(workspaceDb, input, preflight.reviewIds, outcome);
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
 * @returns Durable Git push record.
 */
function recordTerminalPushOutcome(
  workspaceDb: WorkspaceDb,
  input: ExecuteGitPushAttemptInput,
  reviewIds: readonly string[],
  outcome: {
    readonly errorSummary: string | null;
    readonly outcome: GitPushRecord['outcome'];
    readonly remoteHeadAfter: string | null;
  }
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
      remoteHeadBefore: input.remoteHeadBefore ?? null,
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
    remoteHeadAfter: input.remoteHeadAfter ?? null,
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

  if (output.includes('non-fast-forward') || output.includes('fetch first')) {
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
