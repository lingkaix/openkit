import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseJsonc } from 'jsonc-parser';

import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const storyRunnerRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(storyRunnerRoot, '../..');
const coreClientDist = join(repoRoot, 'packages/core-client/dist/index.js');
const mcpClientDist = join(repoRoot, 'mcp/dist/nanocore-client.js');
const mcpRegistryDist = join(repoRoot, 'mcp/dist/registry.js');
const RESULT_FILE = 'goal-mode-real-codex-result.json';
const FAILURE_FILE = 'goal-mode-real-codex-failure.json';
const REDACTION_NOTES_FILE = 'goal-mode-real-codex-redaction-notes.md';
const STORY_TIMEOUT_MESSAGE = 'Real Codex Goal Mode story exceeded its configured deadline.';
const RUNTIME_RESTART_MESSAGE =
  'Real Codex runtime configuration requires a NanoCore restart. Restart NanoCore and rerun the story.';
const SUPERVISED_CHILD_ARG = '--openkit-l6-supervised-child';
const RESTART_REQUIRED_EXIT_CODE = 75;
const CODEX_ACCOUNT_SLOT_ID = 'default';
const CODEX_PROVIDER_ID = 'openai_codex';
const CODEX_PROVIDER_FILE_ID = 'providers/openai-codex.provider.jsonc';
const CODEX_AGENT_FILE_ID = 'agents/codex.agent.jsonc';
const CODEX_AGENT_ID = 'agent_codex_host';
const CODEX_AUTH_SOURCE_HOST = 'a1';
const CODEX_AUTH_SOURCE_PATH = '/home/ubuntu/.codex/auth.json';
const CODEX_AUTH_TRANSFER_TIMEOUT_MS = 30_000;
const CODEX_AUTH_TERMINATION_GRACE_MS = 1_000;
const CODEX_AUTH_PROCESS_EXIT_TIMEOUT_MS = 5_000;
const REAL_CODEX_OPENSHELL_VERSION = '0.0.80';
const REAL_CODEX_WORKER_IMAGE_REF = 'openkit/worker-codex:dev';
const TERMINAL_GOAL_STATUSES = new Set(['completed', 'blocked', 'aborted', 'failed']);

/** Default real Codex Goal Mode story artifact. */
export const DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/goal-mode-real-codex-release.story.md'
);

/** Model used by the real Goal kernel acceptance run. */
export const REAL_CODEX_GOAL_MODEL = 'openai-codex/gpt-5.6-sol';

/** Repository-relative proof file owned by the bounded real Goal story. */
export const REAL_CODEX_GOAL_PROOF_PATH = 'docs/l6-real-goal-proof.md';

/** Exact proof file content accepted by the bounded real Goal story. */
export const REAL_CODEX_GOAL_PROOF_CONTENT = `- Real Goal Mode executed through OpenShell.
- Worker inference stayed behind NanoCore.
- Repository changes remained review-gated.
`;

/** Exact objective submitted to the real Goal kernel. */
export const REAL_CODEX_GOAL_OBJECTIVE = `Create ${REAL_CODEX_GOAL_PROOF_PATH} with exactly these three Markdown bullet lines, in this order:

${REAL_CODEX_GOAL_PROOF_CONTENT}
Do not modify any other file. Do not commit. Run git diff --check. Complete without requesting approval or user input.`;

/**
 * @typedef {object} RealCodexRunnerConfig
 * @property {string} evidenceDir Directory where redacted acceptance evidence is written.
 * @property {string} nanoCoreDataRoot Local data root owned by the target NanoCore deployment.
 * @property {string} nanoCoreUrl Existing NanoCore endpoint.
 * @property {string} repositoryRoot Disposable repository path visible to NanoCore.
 * @property {string} storyPath Story artifact path.
 * @property {string | undefined} token Optional NanoCore bearer token.
 * @property {string} workspaceId Workspace used for the run.
 */

/**
 * @typedef {object} RealCodexPrerequisiteResult
 * @property {RealCodexRunnerConfig} config Resolved runner configuration.
 * @property {boolean} enabled Whether the real Codex path may run.
 * @property {string} reason Skip reason when disabled.
 */

/**
 * Evaluates explicit opt-in and local paths required by the real Goal kernel runner.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, storyPath?: string }} options Evaluation options.
 * @returns {RealCodexPrerequisiteResult} Resolved prerequisite result.
 */
export function evaluateRealCodexRunnerPrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const storyPath = options.storyPath ?? DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH;
  const config = {
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR ?? '',
    nanoCoreDataRoot: env.OPENKIT_L6_NANOCORE_DATA_ROOT ?? '',
    nanoCoreUrl: env.OPENKIT_L6_NANOCORE_URL ?? '',
    repositoryRoot: env.OPENKIT_L6_GOAL_REPO_ROOT ?? '',
    storyPath,
    token: env.OPENKIT_NANOCORE_TOKEN,
    workspaceId: env.OPENKIT_L6_GOAL_WORKSPACE_ID ?? 'ws_demo',
  };

  if (env.OPENKIT_L6_REAL_CODEX !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_REAL_CODEX=1 to opt in to the real Codex L6 runner',
    };
  }

  if (env.OPENKIT_L6_ALLOW_PROVIDER_QUOTA !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 to acknowledge provider usage',
    };
  }

  if (!fileExists(storyPath)) {
    return { config, enabled: false, reason: 'real Codex Goal story artifact is missing' };
  }

  if (!config.nanoCoreUrl) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_NANOCORE_URL' };
  }

  if (!config.nanoCoreDataRoot) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_NANOCORE_DATA_ROOT' };
  }

  if (!fileExists(config.nanoCoreDataRoot)) {
    return { config, enabled: false, reason: 'NanoCore data root does not exist locally' };
  }

  if (!config.repositoryRoot) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_GOAL_REPO_ROOT to a disposable local git repository',
    };
  }

  if (!fileExists(join(config.repositoryRoot, '.git'))) {
    return { config, enabled: false, reason: 'Goal repository is not a git repository' };
  }

  if (!config.evidenceDir) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_EVIDENCE_DIR to a writable evidence directory',
    };
  }

  return { config, enabled: true, reason: '' };
}

/**
 * Streams the A1 Codex auth file directly into a new local OAuth account file.
 *
 * @param {{ env?: Record<string, string | undefined>, killProcess?: typeof process.kill, processExitTimeoutMs?: number, spawnProcess?: typeof spawn, targetPath: string, terminationGraceMs?: number, timeoutMs?: number }} options Transfer options and bounded process-owner seams.
 * @returns {Promise<void>} Completion after a successful 0600 transfer.
 * @throws {Error} When the target cannot be created, the SSH stream fails, or the bounded process cannot exit.
 */
export async function streamCodexAuthFromSsh(options) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const killProcess = options.killProcess ?? process.kill;
  const timeoutMs = requireTransferTimeout(
    options.timeoutMs,
    CODEX_AUTH_TRANSFER_TIMEOUT_MS,
    'SSH auth transfer timeout'
  );
  const terminationGraceMs = requireTransferTimeout(
    options.terminationGraceMs,
    CODEX_AUTH_TERMINATION_GRACE_MS,
    'SSH auth transfer termination grace',
    0
  );
  const processExitTimeoutMs = requireTransferTimeout(
    options.processExitTimeoutMs,
    CODEX_AUTH_PROCESS_EXIT_TIMEOUT_MS,
    'SSH auth transfer process-exit timeout'
  );
  let fileDescriptor;

  try {
    mkdirSync(dirname(options.targetPath), { mode: 0o700, recursive: true });
    fileDescriptor = openSync(options.targetPath, 'wx', 0o600);
  } catch {
    throw new Error('Local Codex OAuth account file could not be created securely.');
  }

  const writer = createWriteStream(options.targetPath, {
    autoClose: true,
    fd: fileDescriptor,
  });
  fileDescriptor = undefined;

  try {
    const detached = process.platform !== 'win32';
    const child = spawnProcess(
      '/usr/bin/ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ForwardX11=no',
        '-o',
        'PermitLocalCommand=no',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=10',
        '-o',
        'ServerAliveCountMax=2',
        CODEX_AUTH_SOURCE_HOST,
        'cat',
        CODEX_AUTH_SOURCE_PATH,
      ],
      {
        detached,
        env: sshEnvironment(options.env ?? process.env),
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    assert(
      Number.isSafeInteger(child.pid) && child.pid > 0,
      'SSH auth transfer did not expose a process owner.'
    );
    const exit = waitForChildExit(child);
    if (!child.stdout) {
      await terminateSshAuthProcess({
        child,
        detached,
        exit,
        killProcess,
        processExitTimeoutMs,
        terminationGraceMs,
      });
      throw new Error('SSH auth transfer did not expose a readable stream.');
    }
    const exitCode = await waitForBoundedSshAuthTransfer({
      child,
      detached,
      exit,
      killProcess,
      processExitTimeoutMs,
      terminationGraceMs,
      timeoutMs,
      transfer: pipeline(child.stdout, writer),
    });

    if (exitCode !== 0) {
      throw new Error(`SSH auth transfer from a1 failed with exit code ${exitCode}.`);
    }

    chmodSync(options.targetPath, 0o600);
  } catch (error) {
    writer.destroy();
    rmSync(options.targetPath, { force: true });
    throw error instanceof Error && error.message.startsWith('SSH auth transfer from a1')
      ? error
      : new Error('SSH auth transfer from a1 failed securely.');
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

/**
 * Runs the opt-in real Codex Goal Mode story through public MCP and Core Client surfaces.
 *
 * @param {{ clients?: { core: Record<string, any>, registry: Record<string, any> }, delay?: (milliseconds: number) => Promise<void>, env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, now?: Date, storyPath?: string, stdout?: (message: string) => void, syncCodexAuth?: (input: { targetPath: string }) => Promise<void> }} options Runner options.
 * @returns {Promise<Record<string, any>>} Redacted story result or skip result.
 * @throws {Error} When any runtime, review, evidence, security, or repository assertion fails.
 */
export async function runRealCodexGoalModeStory(options = {}) {
  const env = options.env ?? process.env;
  const storyPath = options.storyPath ?? DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateRealCodexRunnerPrerequisites({
    env,
    fileExists: options.fileExists,
    storyPath,
  });

  if (!prerequisites.enabled) {
    stdout(`SKIP real Codex Goal Mode L6 runner: ${prerequisites.reason}`);
    return {
      config: redactedConfig(prerequisites.config),
      reason: prerequisites.reason,
      status: 'skipped',
    };
  }

  const config = prerequisites.config;
  const { story } = readRealCodexStory(config);
  prepareEvidenceDirectory(config.evidenceDir);
  return executeRealCodexGoalModeStory({ config, env, options, stdout, story });
}

/**
 * Runs the real Goal story in an isolated Unix process group with a hard deadline.
 *
 * @param {{ childEntrypoint?: string, env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, killProcess?: typeof process.kill, now?: Date, spawnProcess?: typeof spawn, storyPath?: string, stdout?: (message: string) => void }} options Supervisor options.
 * @returns {Promise<Record<string, any>>} Redacted skip or supervised completion result.
 * @throws {Error} When the child fails, requires restart, or exceeds the story deadline.
 */
export async function runRealCodexGoalModeCli(options = {}) {
  const env = options.env ?? process.env;
  const storyPath = options.storyPath ?? DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateRealCodexRunnerPrerequisites({
    env,
    fileExists: options.fileExists,
    storyPath,
  });

  if (!prerequisites.enabled) {
    return runRealCodexGoalModeStory({ ...options, env, storyPath, stdout });
  }

  const config = prerequisites.config;
  const { story, timeoutMs } = readRealCodexStory(config);
  prepareEvidenceDirectory(config.evidenceDir);
  const childEntrypoint = options.childEntrypoint ?? fileURLToPath(import.meta.url);
  const child = (options.spawnProcess ?? spawn)(
    process.execPath,
    [childEntrypoint, SUPERVISED_CHILD_ARG, config.storyPath],
    {
      detached: true,
      env,
      shell: false,
      stdio: 'inherit',
    }
  );
  assert(typeof child.pid === 'number', 'Real Codex Goal Mode child process did not start.');
  const outcome = await waitForChildOrDeadline(
    child,
    timeoutMs,
    options.killProcess ?? process.kill
  );

  if (outcome.kind === 'timeout') {
    const error = new Error(STORY_TIMEOUT_MESSAGE);
    tryWriteFailureEvidence(config, story, error, options.now ?? new Date());
    throw error;
  }
  if (outcome.exitCode === RESTART_REQUIRED_EXIT_CODE) {
    throw new Error(RUNTIME_RESTART_MESSAGE);
  }
  if (outcome.exitCode !== 0) {
    const error = new Error('Real Codex Goal Mode story failed.');
    tryWriteFailureEvidence(config, story, error, options.now ?? new Date());
    throw error;
  }

  return { status: 'ok' };
}

/**
 * Reads and validates the selected real Goal story plus its process deadline.
 *
 * @param {RealCodexRunnerConfig} config Enabled runner configuration.
 * @returns {{ story: ReturnType<typeof parseStoryDocument>, timeoutMs: number }} Parsed story and deadline.
 */
function readRealCodexStory(config) {
  const story = parseStoryDocument(readFileSync(config.storyPath, 'utf8'), config.storyPath);
  validateStoryMetadata(story.metadata, config.storyPath);
  assertRealCodexMcpStory(story.metadata, config.storyPath);
  const timeoutMs = story.metadata.timeout_seconds * 1_000;
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'Real Codex Goal Mode story timeout must be a positive whole number of seconds.'
  );
  return { story, timeoutMs };
}

/**
 * Executes one preflighted real Codex Goal Mode story.
 *
 * @param {{ config: RealCodexRunnerConfig, env: Record<string, string | undefined>, options: Record<string, any>, stdout: (message: string) => void, story: ReturnType<typeof parseStoryDocument> }} input Execution inputs.
 * @returns {Promise<Record<string, any>>} Redacted successful story result.
 */
async function executeRealCodexGoalModeStory({ config, env, options, stdout, story }) {
  const initialHead = assertInitialRepository(config.repositoryRoot);
  const clients = options.clients ?? (await createRealClients(config));
  const syncCodexAuth =
    options.syncCodexAuth ??
    ((input) => streamCodexAuthFromSsh({ env, targetPath: input.targetPath }));
  const runtimeSetup = await configureRealCodexRuntime(clients.core, config, syncCodexAuth);

  assertRequiredMcpTools(clients.registry);
  const publicSurfaces = [...runtimeSetup.publicSurfaces];
  const [status, diagnostics] = await Promise.all([
    clients.registry.callTool('openkit.read_status', { workspaceId: config.workspaceId }),
    clients.registry.callTool('openkit.read_runtime_diagnostics', {}),
  ]);
  publicSurfaces.push(status, diagnostics);
  assertRuntimeReady(diagnostics.raw);

  const linkedRepository = await clients.registry.callTool('openkit.link_repository', {
    displayName: 'Real Codex Goal kernel repository',
    localPath: config.repositoryRoot,
    requestId: randomUUID(),
    workspaceId: config.workspaceId,
  });
  const repositories = await clients.registry.callTool('openkit.read_repositories', {
    workspaceId: config.workspaceId,
  });
  publicSurfaces.push(linkedRepository, repositories);
  assertRepositoryReady(repositories.raw);

  const thread = await clients.registry.callTool('openkit.create_thread', {
    requestId: randomUUID(),
    title: 'L6 Goal Mode real Codex kernel',
    workspaceId: config.workspaceId,
  });
  const threadId = thread.raw?.id;
  assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

  const start = await clients.registry.callTool('openkit.start_goal', {
    objective: REAL_CODEX_GOAL_OBJECTIVE,
    requestId: randomUUID(),
    threadId,
    workspaceId: config.workspaceId,
  });
  const planning = await clients.registry.callTool('openkit.read_goal', {
    threadId,
    workspaceId: config.workspaceId,
  });
  publicSurfaces.push(thread, start, planning);
  const goalId = start.raw?.goal?.goalId;
  assert(typeof goalId === 'string' && goalId.length > 0, 'Goal id was not returned.');
  assert(planning.raw?.goal?.status === 'planning', 'Goal did not enter planning state.');

  const draft = await clients.registry.callTool('openkit.draft_goal_plan', {
    requestId: randomUUID(),
    threadId,
    workspaceId: config.workspaceId,
  });
  publicSurfaces.push(draft);
  assert(draft.raw?.status === 'awaiting_plan_approval', 'Goal plan was not reviewable.');
  assert(typeof draft.raw?.planItemId === 'string', 'Goal plan item id was not returned.');
  assert(draft.raw?.plan?.tasks?.length === 1, 'Real Goal plan must contain exactly one task.');
  assert(
    (draft.raw?.plan?.tasks?.[0]?.verificationChecks?.length ?? 0) > 0,
    'Real Goal plan must contain a verification check.'
  );

  const approval = await clients.registry.callTool('openkit.approve_goal_plan', {
    plan: draft.raw.plan,
    planItemId: draft.raw.planItemId,
    requestId: randomUUID(),
    threadId,
    workspaceId: config.workspaceId,
  });
  publicSurfaces.push(approval);
  assert(approval.raw?.startsWorkerTurn === false, 'Plan approval started worker execution.');
  assert(approval.raw?.readyTasks?.length === 1, 'Approved plan did not expose one ready task.');

  const step = await clients.registry.callTool('openkit.step_goal', {
    requestId: randomUUID(),
    threadId,
    workspaceId: config.workspaceId,
  });
  publicSurfaces.push(step);
  const turnId = step.raw?.worker?.turnId;
  assert(typeof turnId === 'string' && turnId.length > 0, 'Goal step did not start a real turn.');
  assert(
    typeof step.raw?.worker?.workerSessionId === 'string',
    'Goal step did not return a worker session.'
  );
  assert(
    step.raw?.worker?.stopReason === 'completed',
    'Goal worker did not complete successfully.'
  );
  assert(
    step.raw?.worker?.checkpointStage === 'completed',
    'Goal worker checkpoint was not terminal.'
  );
  assert(step.raw?.decision?.outcome === 'review', 'Goal worker did not stop for explicit review.');

  const actionCenter = await clients.registry.callTool('openkit.read_action_center', {
    limit: 20,
    workspaceId: config.workspaceId,
  });
  publicSurfaces.push(actionCenter);
  const rows = actionCenter.raw?.items ?? [];
  assertNoWorkerHumanGate(rows);
  const workspaceRows = rows.filter((row) => row.kind === 'workspace_review');
  const goalReviewRows = rows.filter((row) => row.source?.type === 'goal_review');
  assert(workspaceRows.length === 1, 'Goal turn did not produce exactly one workspace review.');
  assert(goalReviewRows.length === 1, 'Goal turn did not produce exactly one Goal review.');

  const workspaceReview = workspaceRows[0];
  const workspaceReviewList = await clients.core.app.listWorkspaceSyncReviews(config.workspaceId);
  publicSurfaces.push(workspaceReviewList);
  const pendingWorkspaceReviews = (workspaceReviewList.items ?? []).filter(
    (item) =>
      item.review?.status === 'pending' &&
      (workspaceReview.source?.type === 'workspace_review'
        ? item.review.id === workspaceReview.source.reviewId
        : item.artifactId === workspaceReview.artifactId)
  );
  assert(
    pendingWorkspaceReviews.length === 1,
    'Action Center workspace review did not map to exactly one durable review.'
  );
  const durableWorkspaceReview = pendingWorkspaceReviews[0];
  const workspaceDecision = await clients.core.app.submitWorkspaceSyncReviewDecision(
    config.workspaceId,
    durableWorkspaceReview.review.id,
    { decision: 'accepted', requestId: randomUUID() }
  );
  publicSurfaces.push(workspaceDecision);
  assert(
    workspaceDecision.workspaceApplyResult?.status === 'applied',
    'Accepted workspace review was not applied.'
  );
  assert(
    JSON.stringify(workspaceDecision.workspaceApplyResult.appliedPaths) ===
      JSON.stringify([REAL_CODEX_GOAL_PROOF_PATH]),
    'Workspace review applied paths outside the exact proof file.'
  );

  const goalReview = goalReviewRows[0];
  assert(
    goalReview.actions?.some((action) => action.kind === 'accept_review'),
    'Goal review did not expose the accepted verdict action.'
  );
  const goalDecision = await clients.registry.callTool('openkit.resolve_action_center_item', {
    actionId: 'accept_review',
    decision: 'accept',
    requestId: randomUUID(),
    rowId: goalReview.id,
    workspaceId: config.workspaceId,
  });
  publicSurfaces.push(goalDecision);
  assert(
    goalDecision.raw?.advance?.outcome === 'complete_goal',
    'Accepted Goal review did not complete the one-task goal.'
  );

  const finalGoalRead = await waitForCompletedGoal(
    clients.registry,
    config.workspaceId,
    threadId,
    options.delay
  );
  publicSurfaces.push(finalGoalRead);
  const finalGoal = finalGoalRead.raw.goal;
  assert(finalGoal.taskCounts?.completed === 1, 'Final Goal did not complete exactly one task.');
  assert(
    finalGoal.terminalState?.status === 'completed',
    'Final Goal terminal state is incomplete.'
  );
  assert(finalGoal.terminalSummary, 'Final Goal terminal summary is missing.');
  assert(
    finalGoal.terminalSummary.completedTaskIds?.length === 1,
    'Final Goal terminal summary does not contain one completed task.'
  );

  const [threadRead, aepRead, usageRead, evidenceResource, runtimeEvidenceResource, auditResource] =
    await Promise.all([
      clients.registry.callTool('openkit.read_thread', {
        threadId,
        workspaceId: config.workspaceId,
      }),
      clients.registry.callTool('openkit.read_agent_environment_package_snapshots', {
        workspaceId: config.workspaceId,
      }),
      clients.registry.callTool('openkit.read_capability_usage', {
        workspaceId: config.workspaceId,
      }),
      clients.registry.readResource(`openkit://workspaces/${config.workspaceId}/evidence-bundles`),
      clients.registry.readResource(`openkit://workspaces/${config.workspaceId}/runtime-evidence`),
      clients.registry.readResource(`openkit://workspaces/${config.workspaceId}/audit/events`),
    ]);
  const evidence = parseResource(evidenceResource, 'EvidenceBundle');
  const runtimeEvidence = parseResource(runtimeEvidenceResource, 'RuntimeEvidence');
  const audit = parseResource(auditResource, 'audit');
  publicSurfaces.push(threadRead, aepRead, usageRead, evidence, runtimeEvidence, audit);

  const threadSummary = assertCanonicalOuterResult(threadRead.raw, turnId);
  const aepSummary = assertTrustedInferenceAep(aepRead.raw, turnId);
  const inferenceSummary = assertInferenceEvidence({
    audit,
    evidence,
    runtimeEvidence,
    turnId,
    usage: usageRead.raw,
  });
  const runtimeSummary = assertTerminalRuntimeUsage({ turnId, usage: usageRead.raw });
  assertNoPublicSecretLeak(publicSurfaces, [config.nanoCoreDataRoot, config.token]);

  const gitSummary = assertFinalRepository(config.repositoryRoot, initialHead);
  const result = {
    aep: aepSummary,
    config: redactedConfig(config),
    generatedAt: (options.now ?? new Date()).toISOString(),
    git: gitSummary,
    goal: {
      completedTaskCount: finalGoal.taskCounts.completed,
      goalId,
      status: finalGoal.status,
      turnId,
    },
    inference: inferenceSummary,
    oauth: runtimeSetup.oauth,
    reviews: {
      goalAdvanceOutcome: goalDecision.raw.advance.outcome,
      workspaceApplyStatus: workspaceDecision.workspaceApplyResult.status,
    },
    runtime: runtimeSummary,
    runtimeConfig: runtimeSetup.runtimeConfig,
    status: 'ok',
    story: { id: story.metadata.id, title: story.metadata.title },
    thread: { completedAssistantItemCount: threadSummary.completedAssistantItemCount, threadId },
  };
  assertNoEvidenceLeak(result, config);

  writeExclusiveEvidenceFile(join(config.evidenceDir, REDACTION_NOTES_FILE), buildRedactionNotes());
  writeExclusiveEvidenceFile(
    join(config.evidenceDir, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`
  );
  stdout(JSON.stringify(result, null, 2));

  return result;
}

/**
 * Configures the default server OAuth slot, provider profile, and Codex agent selection.
 *
 * @param {Record<string, any>} core Public composed Core Client.
 * @param {{ nanoCoreDataRoot: string }} config Runner configuration.
 * @param {(input: { targetPath: string }) => Promise<void>} syncCodexAuth Auth stream implementation.
 * @returns {Promise<{ oauth: Record<string, any>, publicSurfaces: unknown[], runtimeConfig: Record<string, any> }>} Redacted setup summary and scannable public responses.
 */
export async function configureRealCodexRuntime(core, config, syncCodexAuth) {
  const targetPath = join(
    config.nanoCoreDataRoot,
    'server/files/oauth/openai-codex/accounts/default/codex-home/auth.json'
  );
  const metadataPath = join(dirname(dirname(targetPath)), 'account.json');
  prepareSecureCodexAuthPath(config.nanoCoreDataRoot, targetPath);
  assertSecureCodexAccountMetadataPath(metadataPath);
  const accounts = await core.oauth.openaiCodex.listAccounts();
  assert(
    accounts.defaultAccountSlotId === CODEX_ACCOUNT_SLOT_ID &&
      accounts.accounts?.some((account) => account.accountSlotId === CODEX_ACCOUNT_SLOT_ID),
    'NanoCore did not expose the default Codex OAuth account slot.'
  );
  prepareSecureCodexAuthPath(config.nanoCoreDataRoot, targetPath);
  assertSecureCodexAccountMetadataPath(metadataPath);
  if (!pathEntryExists(targetPath)) {
    await syncCodexAuth({ targetPath });
  }
  assertSecureCodexAuthTarget(targetPath);

  const initialAccountStatus = await core.oauth.openaiCodex.getAccountStatus(CODEX_ACCOUNT_SLOT_ID);
  assert(initialAccountStatus.status === 'logged_in', 'Codex OAuth account is not logged in.');
  const publicSurfaces = [accounts, initialAccountStatus];
  const runtimeFiles = await core.runtimeConfig.listFiles();
  publicSurfaces.push(runtimeFiles);
  const desiredProviderConfig = realCodexProviderConfig();
  const desiredProviderContent = `${JSON.stringify(desiredProviderConfig, null, 2)}\n`;
  const providerExists = runtimeFiles.files?.some((file) => file.id === CODEX_PROVIDER_FILE_ID);
  let runtimeChanged = false;

  if (providerExists) {
    const providerRead = await core.runtimeConfig.getFile(CODEX_PROVIDER_FILE_ID);
    publicSurfaces.push(providerRead);
    const providerConfig = parseRuntimeConfigJson(providerRead.content, 'Codex provider config');
    if (!isDeepStrictEqual(providerConfig, desiredProviderConfig)) {
      assert(
        typeof providerRead.file?.revision === 'string',
        'Codex provider config does not have a revision.'
      );
      const providerWrite = await core.runtimeConfig.updateFile({
        content: desiredProviderContent,
        expectedRevision: providerRead.file.revision,
        id: CODEX_PROVIDER_FILE_ID,
        kind: 'provider',
      });
      assertNoConfigErrors(providerWrite, CODEX_PROVIDER_FILE_ID);
      publicSurfaces.push(providerWrite);
      runtimeChanged = true;
    }
  } else {
    const providerWrite = await core.runtimeConfig.createFile({
      content: desiredProviderContent,
      id: CODEX_PROVIDER_FILE_ID,
      kind: 'provider',
    });
    assertNoConfigErrors(providerWrite, CODEX_PROVIDER_FILE_ID);
    publicSurfaces.push(providerWrite);
    runtimeChanged = true;
  }

  const agentRead = await core.runtimeConfig.getFile(CODEX_AGENT_FILE_ID);
  publicSurfaces.push(agentRead);
  const agentConfig = parseRuntimeConfigJson(agentRead.content, 'Codex agent config');
  if (
    agentConfig.provider?.model !== REAL_CODEX_GOAL_MODEL ||
    agentConfig.provider?.ref !== CODEX_PROVIDER_ID
  ) {
    assert(
      typeof agentRead.file?.revision === 'string',
      'Codex agent config does not have a revision.'
    );
    agentConfig.provider = { model: REAL_CODEX_GOAL_MODEL, ref: CODEX_PROVIDER_ID };
    const agentWrite = await core.runtimeConfig.updateFile({
      content: `${JSON.stringify(agentConfig, null, 2)}\n`,
      expectedRevision: agentRead.file.revision,
      id: CODEX_AGENT_FILE_ID,
      kind: 'agent',
    });
    assertNoConfigErrors(agentWrite, CODEX_AGENT_FILE_ID);
    publicSurfaces.push(agentWrite);
    runtimeChanged = true;
  }

  let reload = await core.runtimeConfig.reload({ dryRun: !runtimeChanged, mode: 'strict' });
  publicSurfaces.push(reload);
  if (isExpectedCodexRestartRejection(reload)) {
    throw new Error(RUNTIME_RESTART_MESSAGE);
  }
  if (!runtimeChanged && isWorkspaceDataSourcesDeferredReload(reload, 'dry-run')) {
    const appliedDeferred = await core.runtimeConfig.reload({ dryRun: false, mode: 'strict' });
    publicSurfaces.push(appliedDeferred);
    assert(
      isWorkspaceDataSourcesDeferredReload(appliedDeferred, 'applied'),
      'Strict runtime config apply changed more than the lazy workspace data-source catalog.'
    );
    reload = await core.runtimeConfig.reload({ dryRun: true, mode: 'strict' });
    publicSurfaces.push(reload);
  }
  assert(
    !runtimeChanged && isStrictNoOpReload(reload),
    'Strict runtime config verification did not return the expected no-op after restart.'
  );
  const accountStatus = await core.oauth.openaiCodex.getAccountStatus(CODEX_ACCOUNT_SLOT_ID);
  publicSurfaces.push(accountStatus);
  assert(accountStatus.status === 'logged_in', 'Codex OAuth account is not logged in.');
  assert(
    accountStatus.boundProviderIds?.includes(CODEX_PROVIDER_ID),
    'Default Codex OAuth account is not bound to openai_codex.'
  );

  return {
    oauth: {
      accountSlotId: CODEX_ACCOUNT_SLOT_ID,
      boundProviderIds: [CODEX_PROVIDER_ID],
      status: accountStatus.status,
    },
    publicSurfaces,
    runtimeConfig: {
      agentId: CODEX_AGENT_ID,
      modelId: REAL_CODEX_GOAL_MODEL,
      providerId: CODEX_PROVIDER_ID,
      reloadStatus: reload.status,
    },
  };
}

/**
 * Requires an existing server-owned auth target to be a regular owner-only file.
 *
 * @param {string} targetPath Server-owned OAuth account file path.
 * @throws {Error} When the target is missing, indirect, permissive, or owned by another user.
 */
function assertSecureCodexAuthTarget(targetPath) {
  let target;

  try {
    target = lstatSync(targetPath);
  } catch {
    throw new Error('Codex OAuth account file is not a secure regular 0600 file.');
  }

  assert(
    target.isFile() &&
      target.nlink === 1 &&
      (target.mode & 0o777) === 0o600 &&
      typeof process.getuid === 'function' &&
      target.uid === process.getuid(),
    'Codex OAuth account file is not a secure regular 0600 file.'
  );
}

/**
 * Rejects linked or foreign account metadata before NanoCore can read or write through it.
 *
 * @param {string} metadataPath Server-owned OAuth account metadata path.
 * @throws {Error} When an existing metadata entry is indirect or owned by another user.
 */
function assertSecureCodexAccountMetadataPath(metadataPath) {
  if (!pathEntryExists(metadataPath)) {
    return;
  }

  const metadata = lstatSync(metadataPath);
  assert(
    metadata.isFile() &&
      metadata.nlink === 1 &&
      typeof process.getuid === 'function' &&
      metadata.uid === process.getuid(),
    'Codex auth target does not have a secure OAuth account metadata path.'
  );
}

/**
 * Creates missing OAuth account directories and rejects every indirect path component.
 *
 * @param {string} dataRoot NanoCore data root.
 * @param {string} targetPath Expected OAuth account file path.
 * @throws {Error} When the target leaves the root or any directory is indirect.
 */
function prepareSecureCodexAuthPath(dataRoot, targetPath) {
  const root = resolve(dataRoot);
  const parent = dirname(resolve(targetPath));
  const relativeParent = relative(root, parent);
  const message = 'Codex auth target does not have a secure OAuth account path.';

  try {
    assert(
      relativeParent.length > 0 && !relativeParent.startsWith('..') && !isAbsolute(relativeParent),
      message
    );
    assertDirectDirectory(root, message);
    let current = root;
    for (const segment of relativeParent.split('/')) {
      current = join(current, segment);
      if (!pathEntryExists(current)) {
        mkdirSync(current, { mode: 0o700 });
      }
      assertDirectDirectory(current, message);
    }
  } catch {
    throw new Error(message);
  }
}

/**
 * Parses one trusted runtime config source without echoing rejected content.
 *
 * @param {string} content Runtime config JSON source.
 * @param {string} label Safe config label used in errors.
 * @returns {Record<string, any>} Parsed config object.
 * @throws {Error} When the source is not a JSON object.
 */
function parseRuntimeConfigJson(content, label) {
  const errors = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });

  assert(errors.length === 0, `${label} is not valid JSONC.`);

  assert(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    `${label} must be an object.`
  );
  return parsed;
}

/**
 * Recognizes the sole safe first-phase restart response for provider and agent changes.
 *
 * @param {Record<string, any>} reload Strict reload response.
 * @returns {boolean} Whether only provider or agent restart-required changes were rejected.
 */
function isExpectedCodexRestartRejection(reload) {
  const plan = reload?.plan;
  const requiresRestart = plan?.requiresRestart;
  const rejected = plan?.rejected;
  const allowedPaths = new Set(['providers', 'agents']);

  return (
    reload?.status === 'rejected' &&
    Array.isArray(requiresRestart) &&
    requiresRestart.length > 0 &&
    requiresRestart.every(
      (change) =>
        allowedPaths.has(change.path) &&
        change.category === 'restart-required' &&
        change.action === 'requires-restart'
    ) &&
    Array.isArray(rejected) &&
    rejected.length === requiresRestart.length &&
    rejected.every(
      (change) =>
        allowedPaths.has(change.path) &&
        change.category === 'rejected' &&
        change.action === 'rejected' &&
        requiresRestart.some((restartChange) => restartChange.path === change.path)
    ) &&
    requiresRestart.every((change) =>
      rejected.some((rejectedChange) => rejectedChange.path === change.path)
    ) &&
    Array.isArray(plan.applied) &&
    plan.applied.length === 0 &&
    Array.isArray(plan.deferred) &&
    plan.deferred.length === 0 &&
    Array.isArray(plan.warnings) &&
    plan.warnings.length === 0
  );
}

/**
 * Recognizes the sole lazy workspace config change safe to apply before story execution.
 *
 * @param {Record<string, any>} reload Strict reload response.
 * @param {'applied' | 'dry-run'} status Required reload status.
 * @returns {boolean} Whether the response contains only one workspace data-source deferral.
 */
function isWorkspaceDataSourcesDeferredReload(reload, status) {
  const plan = reload?.plan;
  const deferred = plan?.deferred;

  return (
    reload?.status === status &&
    Number.isInteger(plan?.previousVersion) &&
    plan.nextVersion === plan.previousVersion + 1 &&
    Array.isArray(plan.applied) &&
    plan.applied.length === 0 &&
    Array.isArray(deferred) &&
    deferred.length === 1 &&
    deferred[0]?.path === 'workspaceDataSources' &&
    deferred[0]?.category === 'session-scoped' &&
    deferred[0]?.action === 'deferred' &&
    Array.isArray(plan.requiresRestart) &&
    plan.requiresRestart.length === 0 &&
    Array.isArray(plan.rejected) &&
    plan.rejected.length === 0 &&
    Array.isArray(plan.warnings) &&
    plan.warnings.length === 0 &&
    Array.isArray(reload.runtimeConfig?.pendingRestart) &&
    reload.runtimeConfig.pendingRestart.length === 0 &&
    Array.isArray(reload.runtimeConfig?.staleSessions) &&
    reload.runtimeConfig.staleSessions.length === 0
  );
}

/**
 * Recognizes the strict dry-run no-op returned after NanoCore restarts on canonical config.
 *
 * @param {Record<string, any>} reload Strict dry-run response.
 * @returns {boolean} Whether the reload is the exact safe no-op shape.
 */
function isStrictNoOpReload(reload) {
  const plan = reload?.plan;

  return (
    reload?.status === 'dry-run' &&
    Number.isInteger(plan?.previousVersion) &&
    plan.nextVersion === plan.previousVersion + 1 &&
    Array.isArray(plan.applied) &&
    plan.applied.length === 0 &&
    Array.isArray(plan.deferred) &&
    plan.deferred.length === 0 &&
    Array.isArray(plan.requiresRestart) &&
    plan.requiresRestart.length === 0 &&
    Array.isArray(plan.rejected) &&
    plan.rejected.length === 0 &&
    Array.isArray(plan.warnings) &&
    plan.warnings.length === 0 &&
    Array.isArray(reload.runtimeConfig?.pendingRestart) &&
    reload.runtimeConfig.pendingRestart.length === 0 &&
    Array.isArray(reload.runtimeConfig?.staleSessions) &&
    reload.runtimeConfig.staleSessions.length === 0
  );
}

/**
 * Creates real MCP and Core Client instances from built workspace artifacts.
 *
 * @param {RealCodexRunnerConfig} config Runner configuration.
 * @returns {Promise<{ core: Record<string, any>, registry: Record<string, any> }>} Runtime clients.
 */
async function createRealClients(config) {
  assertBuilt(coreClientDist);
  assertBuilt(mcpClientDist);
  assertBuilt(mcpRegistryDist);
  const [{ createCoreClient }, { createNanoCoreClient }, { createOpenKitAiInterface }] =
    await Promise.all([
      import(pathToFileURL(coreClientDist).href),
      import(pathToFileURL(mcpClientDist).href),
      import(pathToFileURL(mcpRegistryDist).href),
    ]);
  const clientOptions = {
    baseUrl: config.nanoCoreUrl,
    ...(config.token ? { headers: authHeaders(config.token) } : {}),
  };
  const core = createCoreClient(clientOptions);
  const registry = createOpenKitAiInterface({
    nanoCore: createNanoCoreClient(clientOptions),
  });

  return { core, registry };
}

/**
 * Returns the exact trusted Codex OAuth provider profile for this story.
 *
 * @returns {Record<string, any>} Provider config source model.
 */
function realCodexProviderConfig() {
  return {
    defaultModel: REAL_CODEX_GOAL_MODEL,
    displayName: 'OpenAI Codex',
    extensions: { openkit: { codexOAuth: { accountSlotId: CODEX_ACCOUNT_SLOT_ID } } },
    id: CODEX_PROVIDER_ID,
    kind: 'oauth',
    models: [REAL_CODEX_GOAL_MODEL],
    vendor: CODEX_PROVIDER_ID,
  };
}

/**
 * Validates that the selected story is an opt-in MCP-first real Codex story.
 *
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Parsed story metadata.
 * @param {string} storyPath Story source path for diagnostics.
 */
function assertRealCodexMcpStory(metadata, storyPath) {
  if (metadata.requires_real_provider !== true || metadata.requires_real_codex !== true) {
    throw new Error(`${storyPath} must require real provider and real Codex execution.`);
  }
  if (metadata.entrypoint !== 'mcp' || metadata.default_tool !== 'mcp_stdio') {
    throw new Error(`${storyPath} must declare the MCP-first runtime entrypoint.`);
  }
}

/**
 * Validates the pivotal Goal and review tools before consuming provider quota.
 *
 * @param {Record<string, any>} registry MCP registry.
 */
function assertRequiredMcpTools(registry) {
  const names = new Set(registry.listTools().map((tool) => tool.name));

  for (const name of [
    'openkit.start_goal',
    'openkit.step_goal',
    'openkit.resolve_action_center_item',
  ]) {
    assert(names.has(name), `MCP tools/list did not include ${name}.`);
  }
}

/**
 * Creates and probes the redacted evidence directory before contacting NanoCore.
 *
 * @param {string} evidenceDir Evidence directory selected for the run.
 * @param {string[]} [outputFiles] Fixed evidence file names owned by the runner.
 * @throws {Error} When the directory cannot be created or written securely.
 */
export function prepareEvidenceDirectory(
  evidenceDir,
  outputFiles = [FAILURE_FILE, REDACTION_NOTES_FILE, RESULT_FILE]
) {
  const probePath = join(evidenceDir, `.openkit-write-probe-${randomUUID()}`);
  let fileDescriptor;

  try {
    mkdirSync(evidenceDir, { mode: 0o700, recursive: true });
    assertDirectDirectory(evidenceDir, 'Story evidence directory must be a direct directory.');
    for (const fileName of outputFiles) {
      assertPathAbsent(join(evidenceDir, fileName), 'Story evidence output already exists.');
    }
    fileDescriptor = openSync(probePath, 'wx', 0o600);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    rmSync(probePath, { force: true });
  } catch (error) {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
    try {
      rmSync(probePath, { force: true });
    } catch {
      // The stable preflight error below must not expose the rejected local path.
    }
    if (
      error instanceof Error &&
      (error.message === 'Story evidence directory must be a direct directory.' ||
        error.message === 'Story evidence output already exists.')
    ) {
      throw error;
    }
    throw new Error('Story evidence directory is not writable.');
  }
}

/**
 * Requires one path to be a real directory rather than a symbolic link or another file type.
 *
 * @param {string} directoryPath Directory path.
 * @param {string} message Stable rejection message.
 * @throws {Error} When the path is not a direct directory.
 */
function assertDirectDirectory(directoryPath, message) {
  const entry = lstatSync(directoryPath);
  assert(entry.isDirectory(), message);
}

/**
 * Returns whether one filesystem entry exists without following symbolic links.
 *
 * @param {string} entryPath Filesystem path.
 * @returns {boolean} Whether the path has a directory entry.
 */
function pathEntryExists(entryPath) {
  try {
    lstatSync(entryPath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Requires one filesystem path to have no entry, including no dangling symbolic link.
 *
 * @param {string} entryPath Filesystem path.
 * @param {string} message Stable rejection message.
 */
function assertPathAbsent(entryPath, message) {
  assert(!pathEntryExists(entryPath), message);
}

/**
 * Validates the disposable repository before any runtime mutation.
 *
 * @param {string} repositoryRoot Repository root.
 * @returns {string} Initial commit id.
 */
function assertInitialRepository(repositoryRoot) {
  assert(
    git(repositoryRoot, ['status', '--short', '--untracked-files=all']) === '',
    'Goal repository is not initially clean.'
  );
  assert(
    !existsSync(join(repositoryRoot, REAL_CODEX_GOAL_PROOF_PATH)),
    'Goal proof file already exists.'
  );
  git(repositoryRoot, ['diff', '--check']);
  const head = git(repositoryRoot, ['rev-parse', 'HEAD']);
  assert(head.length > 0, 'Goal repository does not have a baseline commit.');
  return head;
}

/**
 * Validates exact proof content, diff health, commit identity, and final git status.
 *
 * @param {string} repositoryRoot Repository root.
 * @param {string} initialHead Initial commit id.
 * @returns {{ headUnchanged: true, statusShort: string }} Product-safe git summary.
 */
function assertFinalRepository(repositoryRoot, initialHead) {
  const proof = readFileSync(join(repositoryRoot, REAL_CODEX_GOAL_PROOF_PATH), 'utf8');
  assert(proof === REAL_CODEX_GOAL_PROOF_CONTENT, 'Goal proof file content is not exact.');
  git(repositoryRoot, ['diff', '--check']);
  const statusShort = git(repositoryRoot, ['status', '--short', '--untracked-files=all']);
  assert(
    statusShort === `?? ${REAL_CODEX_GOAL_PROOF_PATH}`,
    'Goal repository contains changes outside the exact proof file.'
  );
  assert(
    git(repositoryRoot, ['rev-parse', 'HEAD']) === initialHead,
    'Goal worker created a commit.'
  );

  return { headUnchanged: true, statusShort };
}

/**
 * Validates NanoCore boot and provider diagnostics after strict config reload.
 *
 * @param {Record<string, any>} diagnostics App diagnostics response.
 */
function assertRuntimeReady(diagnostics) {
  assert(
    diagnostics?.boot?.acceptingProductWork === true,
    'NanoCore is not accepting product work.'
  );
  assert(
    diagnostics?.providers?.registry?.some((provider) => provider.id === CODEX_PROVIDER_ID),
    'NanoCore provider registry does not contain openai_codex.'
  );
  assert(
    !diagnostics?.providers?.diagnostics?.some((entry) => entry.status === 'blocked'),
    'NanoCore provider diagnostics contain a blocking entry.'
  );
}

/**
 * Validates repository readiness after public App API linking.
 *
 * @param {Record<string, any>} repositories MCP repository read model.
 */
function assertRepositoryReady(repositories) {
  assert(
    repositories?.repositories?.defaultResource?.diagnosticsStatus === 'ready',
    'Linked repository resource is not ready.'
  );
  assert(
    repositories?.diagnostics?.defaultResource?.ready === true,
    'Linked repository diagnostics are not ready.'
  );
}

/**
 * Rejects approval and question gates from the intentionally self-contained worker turn.
 *
 * @param {Array<Record<string, any>>} rows Action Center rows.
 */
function assertNoWorkerHumanGate(rows) {
  assert(
    !rows.some(
      (row) =>
        row.kind === 'approval' ||
        row.kind === 'question' ||
        (row.source?.type === 'protocol_item' && row.source?.itemType === 'user-input-request')
    ),
    'Goal worker requested approval or user input.'
  );
}

/**
 * Waits for one supervised child or kills its entire Unix process group at the deadline.
 *
 * @param {import('node:child_process').ChildProcess} child Supervised process-group leader.
 * @param {number} timeoutMs Positive deadline in milliseconds.
 * @param {typeof process.kill} killProcess Process signaling implementation.
 * @returns {Promise<{ kind: 'close', exitCode: number | null } | { kind: 'timeout' }>} Terminal outcome.
 */
export async function waitForChildOrDeadline(child, timeoutMs, killProcess) {
  const closed = waitForChildClose(child);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let winner;

  try {
    winner = await Promise.race([
      closed.then(({ exitCode }) => ({ exitCode, kind: 'close' })),
      new Promise((resolveWinner) => {
        timer = setTimeout(() => resolveWinner({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    throw error;
  }

  if (winner.kind === 'close') {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return winner;
  }

  try {
    killProcess(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') {
      const completed = await closed;
      return { exitCode: completed.exitCode, kind: 'close' };
    }
    throw error;
  }
  await closed;
  return { kind: 'timeout' };
}

/**
 * Resolves when one child closes and rejects when it cannot start.
 *
 * @param {import('node:child_process').ChildProcess} child Spawned child.
 * @returns {Promise<{ exitCode: number | null }>} Child close result.
 */
function waitForChildClose(child) {
  return new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (exitCode) => resolveClose({ exitCode }));
  });
}

/**
 * Polls the public Goal read model until it reaches a terminal state.
 *
 * @param {Record<string, any>} registry MCP registry.
 * @param {string} workspaceId Workspace id.
 * @param {string} threadId Thread id.
 * @param {(milliseconds: number) => Promise<void> | undefined} delay Optional test delay.
 * @returns {Promise<Record<string, any>>} Completed Goal tool response.
 */
async function waitForCompletedGoal(registry, workspaceId, threadId, delay) {
  const wait =
    delay ??
    ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await registry.callTool('openkit.read_goal', { threadId, workspaceId });
    const goal = response.raw?.goal;
    assert(goal, 'Goal read model disappeared before completion.');

    if (goal.status === 'completed') {
      return response;
    }
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
      throw new Error(`Goal ended in non-success terminal state: ${goal.status}.`);
    }
    await wait(1_000);
  }

  throw new Error('Goal did not reach a terminal state within 30 seconds.');
}

/**
 * Validates one canonical completed outer assistant result for the worker turn.
 *
 * @param {Record<string, any>} threadRead MCP thread read model.
 * @param {string} turnId Worker turn id.
 * @returns {{ completedAssistantItemCount: number }} Result summary.
 */
function assertCanonicalOuterResult(threadRead, turnId) {
  const items = threadRead?.items?.items ?? threadRead?.items ?? [];
  const completedAssistantItems = items.filter(
    (item) =>
      item.turnId === turnId && item.type === 'assistant-message' && item.status === 'completed'
  );
  assert(
    completedAssistantItems.length === 1,
    'Goal worker did not collapse to one completed outer assistant message.'
  );
  return { completedAssistantItemCount: completedAssistantItems.length };
}

/**
 * Validates trusted worker inference boundaries in the turn's redacted AEP snapshot.
 *
 * @param {Record<string, any>} aepRead MCP AEP list read model.
 * @param {string} turnId Worker turn id.
 * @returns {{ backendKind: string, controlMode: string, imageRef: string, runtimeKind: string, snapshotId: string }} AEP summary.
 */
function assertTrustedInferenceAep(aepRead, turnId) {
  const records = aepRead?.items ?? [];
  const record = records.find((candidate) => candidate.turnId === turnId);
  assert(record, 'Goal worker AEP snapshot is missing.');
  const snapshot = record.snapshot;
  const route = snapshot?.llm?.routes?.[0];
  assert(record.backendKind === 'openshell', 'Goal worker did not use OpenShell.');
  assert(record.runtimeKind === 'codex', 'Goal worker did not use the Codex runtime.');
  assert(snapshot?.control?.mode === 'direct-nanocore', 'AEP control is not direct NanoCore.');
  assert(
    snapshot?.runtime?.image?.ref === REAL_CODEX_WORKER_IMAGE_REF,
    'AEP worker image is not the A1-built acceptance image.'
  );
  assert(snapshot?.llm?.mode === 'gateway', 'AEP inference is not Gateway mode.');
  assert(route?.providerInstanceId === CODEX_PROVIDER_ID, 'AEP provider selection is incorrect.');
  assert(route?.model === REAL_CODEX_GOAL_MODEL, 'AEP model selection is incorrect.');
  assert(route?.credentialVisibility === 'placeholder', 'AEP exposed provider credentials.');
  assert(
    route?.endpoint?.upstream?.kind === 'nanocore-gateway',
    'AEP inference does not route through NanoCore.'
  );
  assert(snapshot?.credentials?.declarations?.length === 0, 'AEP declared direct credentials.');
  assert(snapshot?.providers?.attachments?.length === 0, 'AEP attached a provider to the worker.');
  assert(
    snapshot?.vault?.references?.length === 0 && snapshot?.vault?.grants?.length === 0,
    'AEP projected vault material into the worker.'
  );
  assert(snapshot?.policy?.secrets?.visibility === 'none', 'AEP secret visibility is not none.');
  assert(
    snapshot?.backend?.requiredCapabilities?.includes('trusted-worker-inference-relay'),
    'AEP does not require the trusted worker inference relay.'
  );

  return {
    backendKind: record.backendKind,
    controlMode: snapshot.control.mode,
    imageRef: snapshot.runtime.image.ref,
    runtimeKind: record.runtimeKind,
    snapshotId: record.snapshotId,
  };
}

/**
 * Validates worker-inference capability, usage, audit, and evidence linkage.
 *
 * @param {{ audit: Record<string, any>, evidence: Record<string, any>, runtimeEvidence: Record<string, any>, turnId: string, usage: Record<string, any> }} input Public evidence inputs.
 * @returns {Record<string, any>} Product-safe evidence counts and route summary.
 */
function assertInferenceEvidence(input) {
  const calls = (input.usage?.capabilityCalls ?? []).filter(
    (call) =>
      call.turnId === input.turnId &&
      call.family === 'llm' &&
      call.serviceRef === 'worker-inference-gateway' &&
      call.providerRef === CODEX_PROVIDER_ID &&
      call.status === 'succeeded'
  );
  assert(calls.length > 0, 'Goal turn has no successful worker-inference Gateway call.');
  const callIds = new Set(calls.map((call) => call.id));
  const usageRecords = (input.usage?.usageRecords ?? []).filter(
    (record) =>
      callIds.has(record.capabilityCallId) &&
      record.providerRef === CODEX_PROVIDER_ID &&
      record.modelId === REAL_CODEX_GOAL_MODEL
  );
  assert(usageRecords.length > 0, 'Goal worker Gateway calls have no linked usage records.');
  const auditEvents = (input.audit?.auditEvents ?? []).filter(
    (event) =>
      callIds.has(event.capabilityCallId) &&
      event.action === 'capability.finish' &&
      event.outcome === 'succeeded'
  );
  assert(auditEvents.length > 0, 'Goal worker Gateway calls have no successful audit linkage.');
  const evidenceBundles = (input.evidence?.evidenceBundles ?? []).filter(
    (bundle) => bundle.turnId === input.turnId
  );
  assert(evidenceBundles.length > 0, 'Goal turn has no EvidenceBundle.');
  const bundleIds = new Set(evidenceBundles.map((bundle) => bundle.id));
  const runtimeEvidence = (input.runtimeEvidence?.runtimeEvidence ?? []).filter(
    (record) =>
      record.turnId === input.turnId &&
      record.outcome === 'succeeded' &&
      record.evidenceBundleIds?.some((bundleId) => bundleIds.has(bundleId))
  );
  assert(runtimeEvidence.length > 0, 'Goal turn has no linked successful RuntimeEvidence.');
  const openshellEvidence = runtimeEvidence.filter(
    (record) =>
      record.backendType === 'openshell' && record.backendVersion === REAL_CODEX_OPENSHELL_VERSION
  );
  assert(
    openshellEvidence.length > 0,
    'Goal turn has no linked RuntimeEvidence for the expected A1 OpenShell version.'
  );

  return {
    auditEventCount: auditEvents.length,
    backendType: 'openshell',
    backendVersion: REAL_CODEX_OPENSHELL_VERSION,
    capabilityCallCount: calls.length,
    evidenceBundleCount: evidenceBundles.length,
    modelId: REAL_CODEX_GOAL_MODEL,
    providerRef: CODEX_PROVIDER_ID,
    runtimeEvidenceCount: runtimeEvidence.length,
    serviceRef: 'worker-inference-gateway',
    usageRecordCount: usageRecords.length,
  };
}

/**
 * Validates the terminal worker runtime CapabilityCall and measured session usage.
 *
 * @param {{ turnId: string, usage: Record<string, any> }} input Public usage evidence.
 * @returns {{ capabilityCallCount: number, usageRecordCount: number }} Product-safe counts.
 */
function assertTerminalRuntimeUsage(input) {
  const calls = (input.usage?.capabilityCalls ?? []).filter(
    (call) =>
      call.turnId === input.turnId &&
      call.capabilityId === 'runtime.worker_turn' &&
      call.family === 'runtime' &&
      call.operation === 'worker.checkpoint.terminal' &&
      call.providerRef === 'nanocore-runtime' &&
      call.serviceRef === 'worker-checkpoint' &&
      call.status === 'succeeded'
  );
  assert(calls.length === 1, 'Goal turn does not have exactly one successful runtime checkpoint.');
  const usageRecords = (input.usage?.usageRecords ?? []).filter(
    (record) =>
      record.capabilityCallId === calls[0].id &&
      record.category === 'runtime' &&
      record.providerRef === 'nanocore-runtime' &&
      record.quantity === 1 &&
      record.source === 'worker-checkpoint-terminal' &&
      record.unit === 'sandbox_sessions'
  );
  assert(
    usageRecords.length === 1,
    'Goal runtime checkpoint does not have exactly one linked sandbox-session measurement.'
  );

  return {
    capabilityCallCount: calls.length,
    usageRecordCount: usageRecords.length,
  };
}

/**
 * Parses a public MCP resource payload.
 *
 * @param {{ text?: string }} resource MCP resource response.
 * @param {string} label Resource label for diagnostics.
 * @returns {Record<string, any>} Parsed payload.
 */
function parseResource(resource, label) {
  assert(typeof resource?.text === 'string', `${label} resource did not return text.`);

  try {
    return JSON.parse(resource.text);
  } catch {
    throw new Error(`${label} resource did not return valid JSON.`);
  }
}

/**
 * Rejects raw credential material and account-file paths from public read models.
 *
 * @param {unknown} value Public responses and resources.
 * @param {Array<string | undefined>} [prohibitedValues] Local secret-bearing values.
 */
export function assertNoPublicSecretLeak(value, prohibitedValues = []) {
  const text = JSON.stringify(value);
  const patterns = [
    /"(?:access_token|refresh_token|api_?key|client_?secret|authorization|cookie)"\s*:/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
    /\/home\/ubuntu\/\.codex\/auth\.json/i,
    /\/server\/files\/oauth\/openai-codex\/accounts\//i,
  ];
  assert(
    patterns.every((pattern) => !pattern.test(text)) &&
      prohibitedValues
        .filter((entry) => typeof entry === 'string' && entry.length >= 8)
        .every((entry) => !text.includes(entry)),
    'Public story evidence exposed credential material or an account-file path.'
  );
}

/**
 * Rejects private account metadata and local secret-bearing values from preserved evidence.
 *
 * @param {Record<string, any>} result Story result.
 * @param {RealCodexRunnerConfig} config Runner configuration.
 */
function assertNoEvidenceLeak(result, config) {
  assertNoPublicSecretLeak(result, [config.nanoCoreDataRoot, config.token]);
  assert(
    !JSON.stringify(result).includes('accountLabel'),
    'Evidence preserved a private account label.'
  );
}

/**
 * Writes one structured failure record without preserving the raw error.
 *
 * @param {RealCodexRunnerConfig} config Redacted runner configuration source.
 * @param {ReturnType<typeof parseStoryDocument>} story Parsed story metadata.
 * @param {unknown} error Raw execution failure used only for stable classification.
 * @param {Date} generatedAt Evidence timestamp.
 */
function writeFailureEvidence(config, story, error, generatedAt) {
  const failure = {
    config: redactedConfig(config),
    failure: classifyRealCodexRunnerFailure(error),
    generatedAt: generatedAt.toISOString(),
    status: 'failed',
    story: { id: story.metadata.id, title: story.metadata.title },
  };
  assertNoEvidenceLeak(failure, config);
  writeExclusiveEvidenceFile(
    join(config.evidenceDir, FAILURE_FILE),
    `${JSON.stringify(failure, null, 2)}\n`
  );
}

/**
 * Attempts one exclusive parent-owned failure write without hiding the original failure.
 *
 * @param {RealCodexRunnerConfig} config Runner configuration.
 * @param {ReturnType<typeof parseStoryDocument>} story Parsed story.
 * @param {unknown} error Original failure.
 * @param {Date} generatedAt Evidence timestamp.
 */
function tryWriteFailureEvidence(config, story, error, generatedAt) {
  try {
    writeFailureEvidence(config, story, error, generatedAt);
  } catch {
    // The original supervised failure remains authoritative when exclusive persistence loses a race.
  }
}

/**
 * Creates one owner-only evidence file without following or replacing an existing entry.
 *
 * @param {string} filePath Evidence file path.
 * @param {string} content Complete evidence content.
 */
export function writeExclusiveEvidenceFile(filePath, content) {
  writeFileSync(filePath, content, { flag: 'wx', mode: 0o600 });
}

/**
 * Maps any raw execution failure to a stable secret-free summary.
 *
 * @param {unknown} error Raw execution failure.
 * @returns {{ kind: 'restart_required' | 'runtime_failure' | 'timeout', message: string }} Redacted failure summary.
 */
export function classifyRealCodexRunnerFailure(error) {
  if (error instanceof Error && error.message === STORY_TIMEOUT_MESSAGE) {
    return { kind: 'timeout', message: STORY_TIMEOUT_MESSAGE };
  }
  if (error instanceof Error && error.message === RUNTIME_RESTART_MESSAGE) {
    return { kind: 'restart_required', message: RUNTIME_RESTART_MESSAGE };
  }

  return { kind: 'runtime_failure', message: 'Real Codex Goal Mode story failed.' };
}

/**
 * Returns only non-secret runner configuration facts for evidence.
 *
 * @param {RealCodexRunnerConfig} config Runner configuration.
 * @returns {Record<string, any>} Redacted config.
 */
function redactedConfig(config) {
  return {
    nanoCoreConfigured: Boolean(config.nanoCoreUrl),
    repositoryConfigured: Boolean(config.repositoryRoot),
    tokenProvided: Boolean(config.token),
    workspaceId: config.workspaceId,
  };
}

/**
 * Builds the committed evidence-bundle redaction checklist.
 *
 * @returns {string} Markdown redaction notes.
 */
function buildRedactionNotes() {
  return `# Real Codex Goal Mode Redaction Notes

- The A1 Codex auth file was streamed directly into a new 0600 NanoCore OAuth account file.
- No OAuth content, bearer token, private account label, authorization header, account-file path, or NanoCore data-root path is preserved.
- Public MCP results, Core Client decisions, AEP snapshots, CapabilityCall and usage rows, audit events, EvidenceBundles, RuntimeEvidence, thread items, and final git state were scanned before evidence was written.
`;
}

/**
 * Returns a minimal environment for SSH agent access without inheriting application secrets.
 *
 * @param {Record<string, string | undefined>} env Parent process environment.
 * @returns {Record<string, string>} Sanitized SSH environment.
 */
function sshEnvironment(env) {
  return Object.fromEntries(
    ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SSH_AUTH_SOCK']
      .filter((key) => typeof env[key] === 'string')
      .map((key) => [key, env[key]])
  );
}

/**
 * Waits for one direct-to-file SSH transfer under a shorter local deadline.
 *
 * @param {{ child: import('node:child_process').ChildProcess, detached: boolean, exit: Promise<number | null>, killProcess: typeof process.kill, processExitTimeoutMs: number, terminationGraceMs: number, timeoutMs: number, transfer: Promise<void> }} input Owned SSH process and bounded transfer policy.
 * @returns {Promise<number | null>} SSH exit code after its stdout is fully written.
 * @throws {Error} When the transfer, process, or local deadline fails.
 */
async function waitForBoundedSshAuthTransfer(input) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let outcome;

  try {
    outcome = await Promise.race([
      Promise.all([input.exit, input.transfer]).then(([exitCode]) => ({ exitCode, kind: 'done' })),
      new Promise((resolveOutcome) => {
        timer = setTimeout(() => resolveOutcome({ kind: 'timeout' }), input.timeoutMs);
      }),
    ]);
  } catch (error) {
    await terminateSshAuthProcess(input);
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  if (outcome.kind === 'done') {
    return outcome.exitCode;
  }

  await terminateSshAuthProcess(input);
  throw new Error('SSH auth transfer from a1 timed out.');
}

/**
 * Terminates one owned SSH process group with bounded TERM-to-KILL escalation.
 *
 * @param {{ child: import('node:child_process').ChildProcess, detached: boolean, exit: Promise<number | null>, killProcess: typeof process.kill, processExitTimeoutMs: number, terminationGraceMs: number }} input Owned process and termination policy.
 * @returns {Promise<void>} Completion after the SSH process closes.
 * @throws {Error} When the process remains alive after SIGKILL.
 */
async function terminateSshAuthProcess(input) {
  signalSshAuthProcess(input, 'SIGTERM');
  if (await promiseSettledWithin(input.exit, input.terminationGraceMs)) {
    return;
  }

  signalSshAuthProcess(input, 'SIGKILL');
  if (!(await promiseSettledWithin(input.exit, input.processExitTimeoutMs))) {
    throw new Error('SSH auth transfer from a1 did not exit after SIGKILL.');
  }
}

/**
 * Signals one SSH process group while treating an already-vanished process as success.
 *
 * @param {{ child: import('node:child_process').ChildProcess, detached: boolean, killProcess: typeof process.kill }} input Owned SSH child and signaling seam.
 * @param {NodeJS.Signals} signal Signal to deliver.
 * @returns {void}
 */
function signalSshAuthProcess(input, signal) {
  try {
    if (input.detached) {
      input.killProcess(-input.child.pid, signal);
    } else {
      input.child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Returns whether one promise settles inside a non-negative duration.
 *
 * @param {Promise<unknown>} promise Promise to observe without cancelling.
 * @param {number} timeoutMs Non-negative observation deadline.
 * @returns {Promise<boolean>} True when the promise settled before the timer.
 */
async function promiseSettledWithin(promise, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise((resolveSettled) => {
        timer = setTimeout(() => resolveSettled(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Waits for one spawned child process to close without preserving stderr.
 *
 * @param {import('node:child_process').ChildProcess} child Spawned process.
 * @returns {Promise<number | null>} Exit code.
 */
function waitForChildExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', () => rejectExit(new Error('SSH auth transfer from a1 could not start.')));
    child.once('close', (code) => resolveExit(code));
  });
}

/**
 * Returns a validated whole-millisecond timeout.
 *
 * @param {number | undefined} value Optional timeout override.
 * @param {number} fallback Default timeout.
 * @param {string} name Input name used in validation errors.
 * @param {number} [minimum=1] Minimum accepted value.
 * @returns {number} Validated timeout.
 */
function requireTransferTimeout(value, fallback, name, minimum = 1) {
  const timeout = value ?? fallback;
  assert(
    Number.isSafeInteger(timeout) && timeout >= minimum,
    `${name} must be a whole number of at least ${minimum} milliseconds.`
  );
  return timeout;
}

/**
 * Creates authenticated public client headers without exposing them in evidence.
 *
 * @param {string} token NanoCore bearer token.
 * @returns {HeadersInit} Static request headers.
 */
function authHeaders(token) {
  return {
    authorization: `Bearer ${token.trim()}`,
    'x-openkit-client-channel': 'mcp',
    'x-openkit-client-source': 'desktop-agent',
  };
}

/**
 * Executes one read-only git command in the disposable repository.
 *
 * @param {string} repositoryRoot Repository root.
 * @param {string[]} args Git arguments.
 * @returns {string} Trimmed stdout.
 */
function git(repositoryRoot, args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Fails when a required built artifact is missing.
 *
 * @param {string} filePath Build artifact path.
 */
export function assertBuilt(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required build output is missing: ${filePath}`);
  }
}

/**
 * Fails when a runtime config write returned an error diagnostic.
 *
 * @param {Record<string, any>} writeResult Runtime config write result.
 * @param {string} fileId Runtime config file id.
 */
function assertNoConfigErrors(writeResult, fileId) {
  assert(
    !writeResult.diagnostics?.some((diagnostic) => diagnostic.severity === 'error'),
    `Runtime config file has error diagnostics: ${fileId}.`
  );
}

/**
 * Asserts one condition and throws a stable runner error when it is false.
 *
 * @param {unknown} condition Condition to assert.
 * @param {string} message Failure message.
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === SUPERVISED_CHILD_ARG) {
    runRealCodexGoalModeStory({ storyPath: process.argv[3] }).then(
      () => process.exit(0),
      (error) =>
        process.exit(
          classifyRealCodexRunnerFailure(error).kind === 'restart_required'
            ? RESTART_REQUIRED_EXIT_CODE
            : 1
        )
    );
  } else {
    runRealCodexGoalModeCli().catch((error) => {
      console.error(classifyRealCodexRunnerFailure(error).message);
      process.exitCode = 1;
    });
  }
}
