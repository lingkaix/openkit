import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertBuilt,
  assertNoPublicSecretLeak,
  configureRealCodexRuntime,
  prepareEvidenceDirectory,
  streamCodexAuthFromSsh,
  waitForChildOrDeadline,
  writeExclusiveEvidenceFile,
} from './real-codex-goal-mode-runner.mjs';
import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const storyRunnerRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(storyRunnerRoot, '../..');
const coreClientDist = join(repoRoot, 'packages/core-client/dist/index.js');

/** Default real-worker Task Mode story artifact. */
export const DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/task-mode-real-worker-release.story.md'
);

const RESULT_FILE = 'task-mode-real-worker-result.json';
const FAILURE_FILE = 'task-mode-real-worker-failure.json';
const REDACTION_NOTES_FILE = 'task-mode-real-worker-redaction-notes.md';
const TASK_EVIDENCE_FILES = [FAILURE_FILE, REDACTION_NOTES_FILE, RESULT_FILE];
const PROVENANCE_SUMMARY_PATTERN =
  /^Worker runtime provenance complete: (\d+) streams, (\d+) frames, (\d+) attributed, (\d+) unattributed, (\d+) roots?, (\d+) children, (\d+)\/(\d+) gateway calls reconciled, gateway complete, bundles \S+ and \S+\.$/;
const TASK_MODE_PROVIDER_ID = 'openai_codex';
const TASK_MODE_MODEL_ID = 'openai-codex/gpt-5.6-sol';
const TASK_STORY_TIMEOUT_MESSAGE = 'Real Task Mode worker story exceeded its configured deadline.';
const TASK_STORY_FAILURE_MESSAGE = 'Real Task Mode worker story failed.';
const TASK_RUNTIME_RESTART_MESSAGE =
  'Real Codex runtime configuration requires a NanoCore restart. Restart NanoCore and rerun the story.';
const TASK_ASSERTION_ERROR_CODE = 'OPENKIT_TASK_MODE_ASSERTION';
const SUPERVISED_CHILD_ARG = '--openkit-task-l6-supervised-child';
const RESTART_REQUIRED_EXIT_CODE = 75;

/** Repository-relative proof file requested by the default task input. */
const TASK_MODE_REAL_WORKER_PROOF_PATH = 'docs/task-mode-runtime-provenance-proof.md';

/**
 * @typedef {object} TaskModeRealWorkerRunnerConfig
 * @property {string} evidenceDir Directory where redacted evidence files are written.
 * @property {string} nanoCoreDataRoot Local data root owned by the target NanoCore process.
 * @property {string} nanoCoreUrl Existing NanoCore endpoint.
 * @property {string} repositoryRoot Disposable repository path visible to NanoCore.
 * @property {string} storyPath Story artifact path.
 * @property {string} taskInput Task Mode input.
 * @property {string | undefined} token Optional NanoCore bearer token.
 * @property {string} workerImageRef Exact A1-built worker image used by the acceptance run.
 */

/**
 * Evaluates whether the real Task Mode runner has explicit opt-in and usable paths.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, storyPath?: string }} options Evaluation options.
 * @returns {{ config: TaskModeRealWorkerRunnerConfig, enabled: boolean, reason: string }} Prerequisite result.
 */
export function evaluateTaskModeRealWorkerPrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const storyPath = options.storyPath ?? DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH;
  const config = {
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR ?? '',
    nanoCoreDataRoot: env.OPENKIT_L6_NANOCORE_DATA_ROOT ?? '',
    nanoCoreUrl: env.OPENKIT_L6_TASK_NANOCORE_URL ?? '',
    repositoryRoot: env.OPENKIT_L6_TASK_REPO_ROOT ?? '',
    storyPath,
    taskInput:
      env.OPENKIT_L6_TASK_INPUT ??
      `Delegate two independent repository inspections to exactly two Codex sub-agents, then create ${TASK_MODE_REAL_WORKER_PROOF_PATH} with exactly three bullet points summarizing the root and child findings. Do not modify any other file. Do not commit.`,
    token: env.OPENKIT_NANOCORE_TOKEN,
    workerImageRef: env.OPENKIT_L6_TASK_WORKER_IMAGE_REF ?? '',
  };

  if (env.OPENKIT_L6_TASK_REAL_WORKER !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_REAL_WORKER=1 to opt in to the real Task Mode runner',
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
    return { config, enabled: false, reason: `story artifact not found: ${storyPath}` };
  }

  if (!config.nanoCoreUrl) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_TASK_NANOCORE_URL' };
  }

  if (!config.nanoCoreDataRoot) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_NANOCORE_DATA_ROOT' };
  }

  if (!fileExists(join(config.nanoCoreDataRoot, 'server', 'db', 'core.sqlite'))) {
    return {
      config,
      enabled: false,
      reason: `NanoCore database not found under data root: ${config.nanoCoreDataRoot}`,
    };
  }

  if (!config.workerImageRef) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_TASK_WORKER_IMAGE_REF' };
  }

  if (!config.repositoryRoot) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_REPO_ROOT to a disposable git repository',
    };
  }

  if (!fileExists(join(config.repositoryRoot, '.git'))) {
    return {
      config,
      enabled: false,
      reason: `repository is not a git repository: ${config.repositoryRoot}`,
    };
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
 * Asserts the public provenance evidence produced by one real Task Mode worker turn.
 *
 * @param {{ capabilityCalls: Array<Record<string, any>>, runtimeEvidence: Array<Record<string, any>>, threadItems: Array<Record<string, any>>, turnId: string, usageRecords: Array<Record<string, any>> }} input Public read models for the completed turn.
 * @returns {{ backendType: string, backendVersion: string, cacheLineageCount: number, cachedInputTokens: number, capabilityCallCount: number, childOriginCount: number, packageSnapshotId: string, runtimeOriginCount: number, runtimeRootCount: number, streamCount: number }} Product-safe assertion summary.
 */
export function assertTaskModeRuntimeProvenance(input) {
  assertNoRuntimeProvenanceLeak(input);
  const transcriptEvidence = input.runtimeEvidence.find(
    (record) =>
      record.turnId === input.turnId &&
      record.phase === 'transcript-collection' &&
      record.requiredFeatures?.includes('worker.runtime-provenance.v1')
  );
  assert(transcriptEvidence, 'Task Mode did not produce runtime provenance evidence.');
  assert(
    transcriptEvidence.outcome === 'succeeded',
    'Task Mode runtime provenance evidence did not succeed.'
  );
  assert(
    transcriptEvidence.backendType === 'openshell' &&
      transcriptEvidence.backendVersion === '0.0.80',
    'Runtime provenance did not come from the pinned OpenShell 0.0.80 target.'
  );
  const summary = PROVENANCE_SUMMARY_PATTERN.exec(transcriptEvidence.summary ?? '');
  assert(summary, 'Task Mode runtime provenance summary was incomplete.');
  const [
    streamCount,
    frameCount,
    attributedFrameCount,
    unattributedFrameCount,
    runtimeRootCount,
    childOriginCount,
    reconciledCallCount,
    gatewayCallCount,
  ] = summary.slice(1, 9).map(Number);
  assert(streamCount >= 4, 'Runtime provenance did not retain primary, root, and child streams.');
  assert(
    attributedFrameCount + unattributedFrameCount === frameCount,
    'Runtime provenance frame accounting was inconsistent.'
  );
  assert(
    runtimeRootCount === 1 && childOriginCount === 2,
    'Runtime provenance did not contain exactly one root and two children.'
  );
  assert(
    gatewayCallCount >= 3 && reconciledCallCount === gatewayCallCount,
    'Runtime provenance did not reconcile every root and child Gateway call.'
  );

  const calls = input.capabilityCalls.filter(
    (call) =>
      call.turnId === input.turnId &&
      call.family === 'llm' &&
      call.serviceRef === 'worker-inference-gateway' &&
      call.packageSnapshotId
  );
  assert(
    calls.length === gatewayCallCount,
    'Capability ledger did not match reconciled Gateway calls.'
  );
  assert(
    calls.every((call) => call.status === 'succeeded' || call.status === 'cancelled'),
    'A worker Gateway call ended in an unsupported terminal status.'
  );
  assert(
    calls.every(
      (call) =>
        /^rto_[a-f0-9]{24}$/.test(call.runtimeOriginRef ?? '') &&
        /^rcl_[a-f0-9]{24}$/.test(call.runtimeCacheLineageRef ?? '')
    ),
    'A worker Gateway call lacked trusted product-safe provenance or cache attribution.'
  );
  const succeededCalls = calls.filter((call) => call.status === 'succeeded');
  assert(
    new Set(calls.map((call) => call.packageSnapshotId)).size === 1,
    'Worker Gateway calls did not share one authoritative AEP snapshot.'
  );
  const packageSnapshotId = calls[0]?.packageSnapshotId;
  assert(
    typeof packageSnapshotId === 'string' && packageSnapshotId.length > 0,
    'Worker Gateway calls did not identify their authoritative AEP snapshot.'
  );
  assert(
    calls.every(
      (call) =>
        call.threadId === transcriptEvidence.threadId &&
        call.agentSessionId === transcriptEvidence.agentSessionId
    ),
    'Worker Gateway calls did not match the authoritative runtime evidence lineage.'
  );
  assert(
    calls.every((call) => typeof call.requestId === 'string' && call.requestId.length > 0) &&
      new Set(calls.map((call) => call.requestId)).size === calls.length,
    'Worker Gateway calls reused a request id.'
  );
  const runtimeOriginCount = new Set(calls.map((call) => call.runtimeOriginRef)).size;
  const cacheLineageCount = new Set(calls.map((call) => call.runtimeCacheLineageRef)).size;
  assert(
    runtimeOriginCount === 3,
    'Root and child Gateway calls did not retain exactly three distinct origins.'
  );
  assert(
    new Set(succeededCalls.map((call) => call.runtimeOriginRef)).size === 3,
    'Every root and child origin did not complete a successful Gateway call.'
  );
  assert(cacheLineageCount >= 2, 'Sibling Gateway calls collapsed onto one cache lineage.');

  const callIds = new Set(calls.map((call) => call.id));
  assert(
    succeededCalls.every((call) =>
      input.usageRecords.some((record) => record.capabilityCallId === call.id)
    ),
    'Successful worker Gateway calls were missing linked usage records.'
  );
  const cacheReadRows = input.usageRecords.filter(
    (record) =>
      callIds.has(record.capabilityCallId) &&
      record.source === 'llm-gateway-adapter-reported:cache_read'
  );
  assert(
    cacheReadRows.every((record) => typeof record.quantity === 'number' && record.quantity >= 0),
    'Cached-input token telemetry was invalid.'
  );
  const cachedInputTokens = cacheReadRows.reduce(
    (total, record) => total + (record.quantity ?? 0),
    0
  );
  const completedAssistantItems = input.threadItems.filter(
    (item) =>
      item.turnId === input.turnId &&
      item.type === 'assistant-message' &&
      item.status === 'completed'
  );
  assert(
    completedAssistantItems.length === 1,
    'Runtime-internal children did not collapse to one canonical outer assistant result.'
  );
  return {
    backendType: transcriptEvidence.backendType,
    backendVersion: transcriptEvidence.backendVersion,
    cacheLineageCount,
    cachedInputTokens,
    capabilityCallCount: calls.length,
    childOriginCount,
    packageSnapshotId,
    runtimeOriginCount,
    runtimeRootCount,
    streamCount,
  };
}

/**
 * Validates the trusted Task worker AEP used by the real provenance story.
 *
 * @param {{ aepRead: Record<string, any>, expectedImageRef: string, packageSnapshotId: string, turnId: string }} input AEP assertion input.
 * @returns {{ agentSessionId: string, backendKind: string, controlMode: string, imageRef: string, modelId: string, providerId: string, runtimeKind: string, snapshotId: string }} Product-safe AEP summary.
 */
export function assertTaskModeAgentEnvironment(input) {
  assertNoRuntimeProvenanceLeak(input.aepRead);
  const records = (input.aepRead?.items ?? []).filter((record) => record.turnId === input.turnId);
  assert(records.length === 1, 'Task Mode did not produce exactly one AEP snapshot for the turn.');
  const record = records[0];
  const snapshot = record.snapshot;
  const routes = snapshot?.llm?.routes ?? [];
  const route = routes[0];

  assert(record.snapshotId === input.packageSnapshotId, 'Task Mode AEP lineage is inconsistent.');
  assert(record.backendKind === 'openshell', 'Task Mode worker did not use OpenShell.');
  assert(record.runtimeKind === 'codex', 'Task Mode worker did not use Codex.');
  assert(
    snapshot?.control?.mode === 'direct-nanocore',
    'Task Mode control is not direct NanoCore.'
  );
  assert(
    snapshot?.runtime?.image?.ref === input.expectedImageRef,
    'Task Mode worker did not use the acceptance image.'
  );
  assert(
    snapshot?.llm?.mode === 'gateway' && routes.length === 1,
    'Task Mode AEP route is not singular Gateway inference.'
  );
  assert(
    route?.providerInstanceId === TASK_MODE_PROVIDER_ID && route?.model === TASK_MODE_MODEL_ID,
    'Task Mode AEP provider or model selection is incorrect.'
  );
  assert(
    route?.credentialVisibility === 'placeholder' &&
      route?.endpoint?.upstream?.kind === 'nanocore-gateway',
    'Task Mode AEP inference bypassed the trusted NanoCore placeholder route.'
  );
  assert(snapshot?.credentials?.declarations?.length === 0, 'Task Mode AEP declared credentials.');
  assert(snapshot?.providers?.attachments?.length === 0, 'Task Mode AEP attached providers.');
  assert(
    snapshot?.vault?.references?.length === 0 && snapshot?.vault?.grants?.length === 0,
    'Task Mode AEP projected vault material.'
  );
  assert(snapshot?.policy?.secrets?.visibility === 'none', 'Task Mode AEP exposed secrets.');
  assert(
    snapshot?.backend?.requiredCapabilities?.includes('trusted-worker-inference-relay') &&
      snapshot?.backend?.requiredCapabilities?.includes('worker.runtime-provenance.v1'),
    'Task Mode AEP did not require trusted inference and runtime provenance.'
  );
  return {
    agentSessionId: record.agentSessionId,
    backendKind: record.backendKind,
    controlMode: snapshot.control.mode,
    imageRef: snapshot.runtime.image.ref,
    modelId: route.model,
    providerId: route.providerInstanceId,
    runtimeKind: record.runtimeKind,
    snapshotId: record.snapshotId,
  };
}

/**
 * Runs the opt-in real OpenShell/Codex Task Mode Core Client story.
 *
 * @param {{ clients?: { core: Record<string, any> }, configureRuntime?: (core: Record<string, any>, config: TaskModeRealWorkerRunnerConfig) => Promise<Record<string, any>>, createClients?: (config: TaskModeRealWorkerRunnerConfig) => Promise<{ core: Record<string, any> }>, env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, now?: Date, stdout?: (message: string) => void, storyPath?: string }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Runner result.
 */
export async function runTaskModeRealWorkerStory(options = {}) {
  const env = options.env ?? process.env;
  const storyPath = options.storyPath ?? DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateTaskModeRealWorkerPrerequisites({
    env,
    fileExists: options.fileExists,
    storyPath,
  });

  if (!prerequisites.enabled) {
    stdout(`SKIP real Task Mode worker runner: ${prerequisites.reason}`);
    return {
      config: redactedConfig(prerequisites.config),
      reason: prerequisites.reason,
      status: 'skipped',
    };
  }

  const { story } = readTaskModeStory(prerequisites.config.storyPath);
  prepareEvidenceDirectory(prerequisites.config.evidenceDir, TASK_EVIDENCE_FILES);

  try {
    const clients =
      options.clients ?? (await (options.createClients ?? createRealClients)(prerequisites.config));
    await (options.configureRuntime ?? configureTaskModeCodexRuntime)(
      clients.core,
      prerequisites.config
    );

    return await executeTaskModeRealWorkerStory({
      clients,
      options,
      prerequisites,
      stdout,
      story,
    });
  } catch (error) {
    if (classifyTaskModeRealWorkerFailure(error).kind !== 'restart_required') {
      tryWriteTaskModeFailureEvidence(
        prerequisites.config,
        story,
        error,
        options.now ?? new Date()
      );
    }
    throw error;
  }
}

/**
 * Executes the real Task story through an injected Core Client.
 *
 * @param {{ clients: { core: Record<string, any> }, options: Record<string, any>, prerequisites: ReturnType<typeof evaluateTaskModeRealWorkerPrerequisites>, stdout: (message: string) => void, story: ReturnType<typeof parseStoryDocument> }} input Execution dependencies.
 * @returns {Promise<Record<string, unknown>>} Redacted story result.
 */
async function executeTaskModeRealWorkerStory({ clients, options, prerequisites, stdout, story }) {
  const diagnostics = await clients.core.app.getDiagnostics();
  assert(
    diagnostics.boot?.acceptingProductWork === true,
    'Target NanoCore is not accepting product work.'
  );
  const acceptanceWorkspace = await clients.core.core.createWorkspace({
    name: 'Task Mode real worker acceptance',
  });
  const workspaceId = acceptanceWorkspace.id;
  assert(
    typeof workspaceId === 'string' && workspaceId.length > 0,
    'Workspace id was not returned.'
  );
  const thread = await clients.core.core.createThread({
    name: 'Task Mode real worker release',
    workspaceId,
  });
  const threadId = thread.id;

  assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

  await clients.core.repositories.setDefault(workspaceId, {
    displayName: 'Task Mode real worker repository',
    localPath: prerequisites.config.repositoryRoot,
  });

  const task = await clients.core.app.startTaskMode(workspaceId, threadId, {
    input: prerequisites.config.taskInput,
  });
  const reviewIds = Array.isArray(task.evidence?.reviewIds) ? task.evidence.reviewIds : [];
  let provenance;
  let aep;
  let items = [];
  let storyChecksPassed = false;

  try {
    assert(task.state !== 'escalated-to-goal', 'Task Mode escalated a bounded real-worker task.');
    assert(typeof task.turn?.id === 'string', 'Task Mode response did not include a turn id.');
    assert(task.state === 'completed', `Task Mode returned a non-acceptance state: ${task.state}`);
    const [threadResponse, aepRead, usage, runtimeEvidence] = await Promise.all([
      clients.core.core.listThreadItems(workspaceId, threadId),
      clients.core.app.listAgentEnvironmentPackageSnapshots(workspaceId),
      clients.core.app.getCapabilityUsage(workspaceId),
      clients.core.app.listWorkspaceRuntimeEvidence(workspaceId),
    ]);
    items = threadResponse.items ?? [];
    assert(items.length > 0, 'Task Mode thread did not include visible items.');
    provenance = assertTaskModeRuntimeProvenance({
      capabilityCalls: usage.capabilityCalls ?? [],
      runtimeEvidence: runtimeEvidence.runtimeEvidence ?? [],
      threadItems: items,
      turnId: task.turn.id,
      usageRecords: usage.usageRecords ?? [],
    });
    aep = assertTaskModeAgentEnvironment({
      aepRead,
      expectedImageRef: prerequisites.config.workerImageRef,
      packageSnapshotId: provenance.packageSnapshotId,
      turnId: task.turn.id,
    });
    storyChecksPassed = true;
  } finally {
    const cleanupResults = await Promise.allSettled(
      reviewIds.map((reviewId) =>
        clients.core.app.submitWorkspaceSyncReviewDecision(workspaceId, reviewId, {
          decision: 'rejected',
          requestId: randomUUID(),
        })
      )
    );
    if (storyChecksPassed) {
      assert(
        cleanupResults.every(
          (result, index) =>
            result.status === 'fulfilled' &&
            result.value?.review?.id === reviewIds[index] &&
            result.value.review.status === 'rejected'
        ),
        'Task Mode workspace review cleanup failed.'
      );
    }
  }

  const result = {
    aep,
    cleanup: {
      rejectedReviewCount: reviewIds.length,
    },
    config: redactedConfig(prerequisites.config, workspaceId),
    generatedAt: (options.now ?? new Date()).toISOString(),
    story: {
      id: story.metadata.id,
      title: story.metadata.title,
    },
    task: {
      state: task.state,
      turnId: task.turn.id,
    },
    thread: {
      completedAssistantItemCount: 1,
      itemCount: items.length,
      threadId,
    },
    provenance,
    status: 'ok',
  };
  const redactionNotes = buildRedactionNotes(story.metadata);
  assertNoRuntimeProvenanceLeak({ redactionNotes, result });

  writeExclusiveEvidenceFile(
    join(prerequisites.config.evidenceDir, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`
  );
  writeExclusiveEvidenceFile(
    join(prerequisites.config.evidenceDir, REDACTION_NOTES_FILE),
    redactionNotes
  );
  stdout(JSON.stringify(result, null, 2));

  return result;
}

/**
 * Runs the real Task story in an isolated Unix process group with a hard deadline.
 *
 * @param {{ childEntrypoint?: string, env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, killProcess?: typeof process.kill, spawnProcess?: typeof spawn, stdout?: (message: string) => void, storyPath?: string }} options Supervisor options.
 * @returns {Promise<Record<string, unknown>>} Redacted skip or supervised completion result.
 */
async function runTaskModeRealWorkerCli(options = {}) {
  const env = options.env ?? process.env;
  const storyPath = options.storyPath ?? DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateTaskModeRealWorkerPrerequisites({
    env,
    fileExists: options.fileExists,
    storyPath,
  });

  if (!prerequisites.enabled) {
    return runTaskModeRealWorkerStory({ ...options, env, storyPath, stdout });
  }

  const { story, timeoutMs } = readTaskModeStory(storyPath);
  prepareEvidenceDirectory(prerequisites.config.evidenceDir, TASK_EVIDENCE_FILES);
  const childEntrypoint = options.childEntrypoint ?? fileURLToPath(import.meta.url);
  const child = (options.spawnProcess ?? spawn)(
    process.execPath,
    [childEntrypoint, SUPERVISED_CHILD_ARG, storyPath],
    {
      detached: true,
      env,
      shell: false,
      stdio: 'inherit',
    }
  );
  assert(typeof child.pid === 'number', 'Real Task Mode worker child process did not start.');
  const outcome = await waitForChildOrDeadline(
    child,
    timeoutMs,
    options.killProcess ?? process.kill
  );

  if (outcome.kind === 'timeout') {
    const error = new Error(TASK_STORY_TIMEOUT_MESSAGE);
    tryWriteTaskModeFailureEvidence(prerequisites.config, story, error, options.now ?? new Date());
    throw error;
  }
  if (outcome.exitCode === RESTART_REQUIRED_EXIT_CODE) {
    throw new Error(TASK_RUNTIME_RESTART_MESSAGE);
  }
  if (outcome.exitCode !== 0) {
    const error = new Error(TASK_STORY_FAILURE_MESSAGE);
    tryWriteTaskModeFailureEvidence(prerequisites.config, story, error, options.now ?? new Date());
    throw error;
  }

  return { status: 'ok' };
}

/**
 * Reads and validates the positive timeout declared by one Task story.
 *
 * @param {string} storyPath Task story source path.
 * @returns {{ story: ReturnType<typeof parseStoryDocument>, timeoutMs: number }} Parsed story and positive deadline.
 */
function readTaskModeStory(storyPath) {
  const story = parseStoryDocument(readFileSync(storyPath, 'utf8'), storyPath);
  validateStoryMetadata(story.metadata, storyPath);
  assertRealTaskModeStory(story.metadata, storyPath);
  const timeoutSeconds = story.metadata.timeout_seconds;
  assert(
    Number.isInteger(timeoutSeconds) && timeoutSeconds > 0,
    'Task story must declare a positive integer timeout_seconds.'
  );
  return { story, timeoutMs: timeoutSeconds * 1000 };
}

/**
 * Writes one structured Task failure record without preserving an untrusted raw error.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Redacted runner configuration source.
 * @param {ReturnType<typeof parseStoryDocument>} story Parsed story metadata.
 * @param {unknown} error Raw execution failure used only for stable classification.
 * @param {Date} generatedAt Evidence timestamp.
 */
function writeTaskModeFailureEvidence(config, story, error, generatedAt) {
  const failure = {
    config: redactedConfig(config, null),
    failure: classifyTaskModeRealWorkerFailure(error),
    generatedAt: generatedAt.toISOString(),
    status: 'failed',
    story: { id: story.metadata.id, title: story.metadata.title },
  };
  const text = JSON.stringify(failure);
  assertNoRuntimeProvenanceLeak(failure);
  assert(
    [config.nanoCoreDataRoot, config.repositoryRoot, config.token]
      .filter((value) => typeof value === 'string' && value.length >= 8)
      .every((value) => !text.includes(value)),
    'Task failure evidence exposed private runner configuration.'
  );
  writeExclusiveEvidenceFile(
    join(config.evidenceDir, FAILURE_FILE),
    `${JSON.stringify(failure, null, 2)}\n`
  );
}

/**
 * Attempts one exclusive Task failure write without hiding the original failure.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner configuration.
 * @param {ReturnType<typeof parseStoryDocument>} story Parsed story.
 * @param {unknown} error Original failure.
 * @param {Date} generatedAt Evidence timestamp.
 */
function tryWriteTaskModeFailureEvidence(config, story, error, generatedAt) {
  try {
    writeTaskModeFailureEvidence(config, story, error, generatedAt);
  } catch {
    // The original failure remains authoritative when exclusive persistence loses a race.
  }
}

/**
 * Maps one raw Task execution failure to a stable secret-free summary.
 *
 * @param {unknown} error Raw execution failure.
 * @returns {{ kind: 'assertion_failure' | 'restart_required' | 'runtime_failure' | 'timeout', message: string }} Redacted failure summary.
 */
function classifyTaskModeRealWorkerFailure(error) {
  if (error instanceof Error && error.message === TASK_STORY_TIMEOUT_MESSAGE) {
    return { kind: 'timeout', message: TASK_STORY_TIMEOUT_MESSAGE };
  }
  if (error instanceof Error && error.message === TASK_RUNTIME_RESTART_MESSAGE) {
    return { kind: 'restart_required', message: TASK_RUNTIME_RESTART_MESSAGE };
  }
  if (
    error instanceof Error &&
    /** @type {Error & { code?: string }} */ (error).code === TASK_ASSERTION_ERROR_CODE
  ) {
    return { kind: 'assertion_failure', message: error.message };
  }

  return { kind: 'runtime_failure', message: TASK_STORY_FAILURE_MESSAGE };
}

/**
 * Configures A1-backed Codex OAuth and the exact provider and agent selection before quota use.
 *
 * @param {Record<string, any>} core Public Core Client.
 * @param {TaskModeRealWorkerRunnerConfig} config Real Task runner configuration.
 * @returns {Promise<Record<string, any>>} Redacted OAuth and runtime configuration summary.
 */
async function configureTaskModeCodexRuntime(core, config) {
  return configureRealCodexRuntime(core, config, ({ targetPath }) =>
    streamCodexAuthFromSsh({ env: process.env, targetPath })
  );
}

/**
 * Creates one real Core Client instance from the built workspace artifact.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner configuration.
 * @returns {Promise<{ core: Record<string, any> }>} Runtime client.
 */
async function createRealClients(config) {
  assertBuilt(coreClientDist);
  const { createCoreClient } = await import(pathToFileURL(coreClientDist).href);
  const clientOptions = {
    baseUrl: config.nanoCoreUrl,
    ...(config.token ? { headers: authHeaders(config.token) } : {}),
  };

  return {
    core: createCoreClient(clientOptions),
  };
}

/**
 * Validates that the story explicitly opts in to real provider and Codex usage.
 *
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Story metadata.
 * @param {string} storyPath Story source path for diagnostics.
 */
function assertRealTaskModeStory(metadata, storyPath) {
  if (metadata.requires_real_provider !== true || metadata.requires_real_codex !== true) {
    throw new Error(`${storyPath} must require real provider and real Codex execution.`);
  }
}

/**
 * Creates redacted NanoCore auth headers.
 *
 * @param {string} token OpenKit bearer token.
 * @returns {HeadersInit} Static request headers.
 */
function authHeaders(token) {
  return {
    authorization: `Bearer ${token.trim()}`,
    'x-openkit-client-channel': 'core-client',
    'x-openkit-client-source': 'desktop-agent',
  };
}

/**
 * Removes secret-bearing values from the runner config before evidence is written.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner config.
 * @param {string | null} workspaceId Acceptance workspace id when creation succeeded.
 * @returns {Record<string, unknown>} Redacted config.
 */
function redactedConfig(config, workspaceId = null) {
  return {
    evidenceDirectoryConfigured: Boolean(config.evidenceDir),
    nanoCoreDataRootConfigured: Boolean(config.nanoCoreDataRoot),
    nanoCoreUrl: config.nanoCoreUrl,
    repositoryConfigured: Boolean(config.repositoryRoot),
    storyPath: config.storyPath,
    tokenProvided: Boolean(config.token),
    workerImageRef: config.workerImageRef,
    workspaceId,
  };
}

/**
 * Builds redaction notes for the evidence bundle.
 *
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Story metadata.
 * @returns {string} Redaction notes.
 */
function buildRedactionNotes(metadata) {
  return `# Task Mode Real Worker Redaction Notes

Story: ${metadata.id}

## Required Redaction Checks

- Do not preserve raw OAuth tokens, bearer tokens, API keys, cookie values, authorization headers, or Codex auth JSON content.
- Preserve product-safe ids, counts, state names, and worker target summaries only.
- Replace accidental secret-like values with \`[REDACTED]\` before preserving evidence.
- Record every scanned evidence source in the final acceptance report.
`;
}

/**
 * Fails when public provenance evidence contains runtime-native or secret-bearing fields.
 *
 * @param {unknown} value Public response or written evidence to scan.
 */
function assertNoRuntimeProvenanceLeak(value) {
  assertNoPublicSecretLeak(value);
  const text = JSON.stringify(value);
  const patterns = [
    /native(?:Thread|Session|Turn|CacheLineage)Id/i,
    /parentNativeThreadId/i,
    /prompt_cache_key/i,
    /x-codex-turn-metadata/i,
    /\b(?:thread_id|parent_thread_id|sender_thread_id|receiver_thread_ids)\b/i,
  ];
  assert(
    patterns.every((pattern) => !pattern.test(text)),
    'Public Task story evidence exposed runtime-native metadata.'
  );
}

/**
 * Ensures one condition is truthy.
 *
 * @param {unknown} condition Condition to assert.
 * @param {string} message Failure message.
 */
function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = TASK_ASSERTION_ERROR_CODE;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === SUPERVISED_CHILD_ARG) {
    runTaskModeRealWorkerStory({ storyPath: process.argv[3] }).then(
      () => process.exit(0),
      (error) =>
        process.exit(
          classifyTaskModeRealWorkerFailure(error).kind === 'restart_required'
            ? RESTART_REQUIRED_EXIT_CODE
            : 1
        )
    );
  } else {
    runTaskModeRealWorkerCli().catch((error) => {
      console.error(classifyTaskModeRealWorkerFailure(error).message);
      process.exitCode = 1;
    });
  }
}
