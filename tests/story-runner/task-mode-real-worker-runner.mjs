import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';

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
const REDACTION_NOTES_FILE = 'task-mode-real-worker-redaction-notes.md';
const PROVENANCE_SUMMARY_PATTERN =
  /^Worker runtime provenance complete: (\d+) streams, (\d+) frames, (\d+) attributed, (\d+) unattributed, (\d+) roots?, (\d+) children, (\d+)\/(\d+) gateway calls reconciled, gateway complete, bundles (\S+) and (\S+)\.$/;
const TASK_MODE_WORKER_IMAGE_REF = 'openkit/worker-codex:dev';
const TASK_MODE_PROVIDER_ID = 'openai_codex';
const TASK_MODE_MODEL_ID = 'openai-codex/gpt-5.5';

/** Repository-relative proof file owned by the bounded real Task story. */
export const TASK_MODE_REAL_WORKER_PROOF_PATH = 'docs/task-mode-runtime-provenance-proof.md';

/**
 * @typedef {object} TaskModeRealWorkerRunnerConfig
 * @property {string} evidenceDir Directory where redacted evidence files are written.
 * @property {string} nanoCoreDataRoot Existing NanoCore data root on the runner host.
 * @property {string} nanoCoreUrl Existing NanoCore endpoint.
 * @property {string} repositoryRoot Disposable repository path visible to NanoCore.
 * @property {string} storyPath Story artifact path.
 * @property {string} taskInput Task Mode input.
 * @property {string | undefined} token Optional NanoCore bearer token.
 * @property {string} workspaceId Workspace to use for the run.
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
    nanoCoreDataRoot: env.OPENKIT_L6_TASK_NANOCORE_DATA_ROOT ?? '',
    nanoCoreUrl: env.OPENKIT_L6_TASK_NANOCORE_URL ?? '',
    repositoryRoot: env.OPENKIT_L6_TASK_REPO_ROOT ?? '',
    storyPath,
    taskInput:
      env.OPENKIT_L6_TASK_INPUT ??
      `Delegate two independent repository inspections to exactly two Codex sub-agents, then create ${TASK_MODE_REAL_WORKER_PROOF_PATH} with exactly three bullet points summarizing the root and child findings. Do not modify any other file. Do not commit.`,
    token: env.OPENKIT_NANOCORE_TOKEN,
    workspaceId: env.OPENKIT_L6_TASK_WORKSPACE_ID ?? 'ws_demo',
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
    return { config, enabled: false, reason: 'set OPENKIT_L6_TASK_NANOCORE_DATA_ROOT' };
  }

  if (!fileExists(join(config.nanoCoreDataRoot, 'server', 'db', 'core.sqlite'))) {
    return {
      config,
      enabled: false,
      reason: `NanoCore database not found under data root: ${config.nanoCoreDataRoot}`,
    };
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
 * @param {{ auditEvents: Array<Record<string, any>>, capabilityCalls: Array<Record<string, any>>, evidenceBundles: Array<Record<string, any>>, runtimeEvidence: Array<Record<string, any>>, threadItems: Array<Record<string, any>>, turnId: string, usageRecords: Array<Record<string, any>> }} input Public read models for the completed turn.
 * @returns {{ auditEventCount: number, backendType: string, backendVersion: string, cacheLineageCount: number, cachedInputTokens: number, capabilityCallCount: number, childOriginCount: number, indexBundleId: string, packageSnapshotId: string, positiveCacheReadObserved: boolean, rawBundleId: string, runtimeOriginCount: number, runtimeRootCount: number, streamCount: number, teardownEvidenceCount: number }} Product-safe assertion summary.
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
  const rawBundleId = summary[9];
  const indexBundleId = summary[10];
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

  const rawBundle = input.evidenceBundles.find((bundle) => bundle.id === rawBundleId);
  const indexBundle = input.evidenceBundles.find((bundle) => bundle.id === indexBundleId);
  assert(
    rawBundle?.turnId === input.turnId &&
      rawBundle.sourceKind === 'worker-runtime-provenance-raw' &&
      rawBundle.retentionClass === 'restricted-raw' &&
      rawBundle.sensitivityClass === 'restricted' &&
      rawBundle.importStatus === 'promoted' &&
      rawBundle.rawEvidenceRefs?.length === 0 &&
      rawBundle.redactedEvidenceRefs?.length === 0,
    'Restricted runtime provenance bundle was missing or exposed raw refs.'
  );
  assert(
    indexBundle?.turnId === input.turnId &&
      indexBundle.sourceKind === 'worker-runtime-provenance-index' &&
      indexBundle.retentionClass === 'turn-evidence' &&
      indexBundle.sensitivityClass === 'product-safe' &&
      indexBundle.importStatus === 'promoted' &&
      indexBundle.rawEvidenceRefs?.length === 0 &&
      indexBundle.redactedEvidenceRefs?.length === 1 &&
      indexBundle.redactedEvidenceRefs[0]?.kind === 'worker-runtime-provenance-index' &&
      indexBundle.redactedEvidenceRefs[0]?.ref === 'runtime-origin-index.jsonl',
    'Product-safe runtime provenance index bundle was missing.'
  );
  assert(
    transcriptEvidence.evidenceBundleIds?.length === 2 &&
      transcriptEvidence.evidenceBundleIds?.includes(rawBundleId) &&
      transcriptEvidence.evidenceBundleIds?.includes(indexBundleId),
    'RuntimeEvidence did not link both automatic provenance bundles.'
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
    calls.every(
      (call) =>
        call.status === 'succeeded' &&
        /^rto_[a-f0-9]{24}$/.test(call.runtimeOriginRef ?? '') &&
        /^rcl_[a-f0-9]{24}$/.test(call.runtimeCacheLineageRef ?? '')
    ),
    'A worker Gateway call lacked trusted product-safe provenance or cache attribution.'
  );
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
  assert(cacheLineageCount >= 2, 'Sibling Gateway calls collapsed onto one cache lineage.');

  const callIds = new Set(calls.map((call) => call.id));
  assert(
    calls.every((call) => input.usageRecords.some((record) => record.capabilityCallId === call.id)),
    'Worker Gateway calls were missing linked usage records.'
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
  const linkedAuditEvents = input.auditEvents.filter((event) =>
    callIds.has(event.capabilityCallId)
  );
  assert(
    calls.every((call) =>
      linkedAuditEvents.some(
        (event) =>
          event.action === 'capability.finish' &&
          event.capabilityCallId === call.id &&
          event.outcome === 'succeeded'
      )
    ),
    'Worker Gateway calls were missing successful audit linkage.'
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
  const teardownEvidence = input.runtimeEvidence.filter(
    (record) =>
      record.turnId === input.turnId &&
      record.agentSessionId === transcriptEvidence.agentSessionId &&
      record.phase === 'teardown' &&
      record.outcome === 'succeeded' &&
      record.stopReason === 'completed'
  );
  assert(
    teardownEvidence.length === 1,
    'Task Mode did not preserve one successful terminal teardown record.'
  );

  return {
    auditEventCount: linkedAuditEvents.length,
    backendType: transcriptEvidence.backendType,
    backendVersion: transcriptEvidence.backendVersion,
    cacheLineageCount,
    cachedInputTokens,
    capabilityCallCount: calls.length,
    childOriginCount,
    indexBundleId,
    packageSnapshotId,
    positiveCacheReadObserved: cacheReadRows.length > 0,
    rawBundleId,
    runtimeOriginCount,
    runtimeRootCount,
    streamCount,
    teardownEvidenceCount: teardownEvidence.length,
  };
}

/**
 * Validates the trusted Task worker AEP and its immutable repository base.
 *
 * @param {{ aepRead: Record<string, any>, initialHead: string, packageSnapshotId: string, turnId: string }} input AEP assertion input.
 * @returns {{ agentSessionId: string, backendKind: string, controlMode: string, imageRef: string, modelId: string, providerId: string, runtimeKind: string, snapshotId: string, sourceCommitMatched: true }} Product-safe AEP summary.
 */
export function assertTaskModeAgentEnvironment(input) {
  assertNoRuntimeProvenanceLeak(input.aepRead);
  const records = (input.aepRead?.items ?? []).filter((record) => record.turnId === input.turnId);
  assert(records.length === 1, 'Task Mode did not produce exactly one AEP snapshot for the turn.');
  const record = records[0];
  const snapshot = record.snapshot;
  const routes = snapshot?.llm?.routes ?? [];
  const route = routes[0];
  const writableInputs = (snapshot?.workspace?.inputs ?? []).filter(
    (workspaceInput) => workspaceInput.access === 'read-write'
  );

  assert(record.snapshotId === input.packageSnapshotId, 'Task Mode AEP lineage is inconsistent.');
  assert(record.backendKind === 'openshell', 'Task Mode worker did not use OpenShell.');
  assert(record.runtimeKind === 'codex', 'Task Mode worker did not use Codex.');
  assert(
    snapshot?.control?.mode === 'direct-nanocore',
    'Task Mode control is not direct NanoCore.'
  );
  assert(
    snapshot?.runtime?.image?.ref === TASK_MODE_WORKER_IMAGE_REF,
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
  assert(
    writableInputs.length === 1 &&
      writableInputs[0]?.materialization?.strategy === 'git' &&
      writableInputs[0]?.source?.commit === input.initialHead,
    'Task Mode AEP did not bind the exact repository base.'
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
    sourceCommitMatched: true,
  };
}

/**
 * Validates one exact review-gated proof change and its completed backend cleanup.
 *
 * @param {{ backendHandles: Array<Record<string, any>>, initialHead: string, review: Record<string, any>, taskEvidence: Record<string, any> }} input Workspace assertion input.
 * @returns {{ backendHandleCount: number, changedPaths: string[], reviewId: string }} Product-safe workspace summary.
 */
export function assertTaskModeWorkspaceProof(input) {
  assertNoRuntimeProvenanceLeak(input);
  const reviewId = input.review?.review?.id;
  assert(
    typeof reviewId === 'string' &&
      JSON.stringify(input.taskEvidence?.reviewIds ?? []) === JSON.stringify([reviewId]),
    'Task Mode did not expose exactly one durable workspace review.'
  );
  assert(input.review.review.status === 'pending', 'Task Mode workspace review is not pending.');
  assert(
    input.taskEvidence?.artifactIds?.includes(input.review.artifactId),
    'Task Mode workspace review is not linked to returned evidence.'
  );
  const changedPaths = input.review.changeSet?.changedPaths ?? [];
  assert(
    changedPaths.length === 1 &&
      changedPaths[0]?.path === TASK_MODE_REAL_WORKER_PROOF_PATH &&
      changedPaths[0]?.status === 'added',
    'Task Mode workspace review changed paths outside the exact proof file.'
  );
  assert(
    input.review.changeSet?.base?.commit === input.initialHead,
    'Task Mode workspace review did not preserve the repository base.'
  );
  assert(
    input.review.review?.diffSummary?.filesChanged === 1 &&
      input.review.review?.diffSummary?.additions === 3 &&
      input.review.review?.diffSummary?.deletions === 0,
    'Task Mode proof review did not contain exactly three added lines.'
  );
  const patchText = input.review.patchPayload?.text;
  const addedLines =
    typeof patchText === 'string'
      ? patchText.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      : [];
  assert(
    typeof patchText === 'string' &&
      patchText.includes(`+++ b/${TASK_MODE_REAL_WORKER_PROOF_PATH}`) &&
      addedLines.length === 3 &&
      addedLines.every((line) => /^\+- .+/.test(line)),
    'Task Mode proof patch did not contain exactly three Markdown bullet lines.'
  );
  const backendHandles = input.backendHandles.filter(
    (handle) => handle.materializationRecordId === input.review.changeSet.materializationRecordId
  );
  assert(
    backendHandles.length === 1 && backendHandles[0]?.cleanupStatus === 'cleaned',
    'Task Mode backend workspace cleanup did not complete.'
  );

  return {
    backendHandleCount: backendHandles.length,
    changedPaths: changedPaths.map((changedPath) => changedPath.path),
    reviewId,
  };
}

/**
 * Runs the opt-in real OpenShell/Codex Task Mode Core Client story.
 *
 * @param {{ clients?: { core: Record<string, any> }, createClients?: (config: TaskModeRealWorkerRunnerConfig, timeoutMs: number, deadlineSignal: AbortSignal) => Promise<{ close: () => Promise<void>, core: Record<string, any> }>, createDeadlineSignal?: (timeoutMs: number) => AbortSignal, env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, now?: Date, stdout?: (message: string) => void, storyPath?: string }} options Runner options.
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

  const storyText = await import('node:fs/promises').then((fs) =>
    fs.readFile(prerequisites.config.storyPath, 'utf8')
  );
  const story = parseStoryDocument(storyText, prerequisites.config.storyPath);

  validateStoryMetadata(story.metadata, prerequisites.config.storyPath);
  assertRealTaskModeStory(story.metadata, prerequisites.config.storyPath);
  const timeoutMs = story.metadata.timeout_seconds * 1_000;
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'Real Task Mode story timeout must be a positive whole number of seconds.'
  );
  const deadlineSignal = (options.createDeadlineSignal ?? AbortSignal.timeout)(timeoutMs);
  const initialHead = assertInitialTaskRepository(prerequisites.config.repositoryRoot);
  const createdClients = options.clients
    ? null
    : await (options.createClients ?? createRealClients)(
        prerequisites.config,
        timeoutMs,
        deadlineSignal
      );
  const clients = options.clients ?? createdClients;

  try {
    return await runWithinStoryDeadline(
      () =>
        executeTaskModeRealWorkerStory({
          clients,
          initialHead,
          options,
          prerequisites,
          stdout,
          story,
        }),
      deadlineSignal,
      timeoutMs
    );
  } finally {
    await createdClients?.close();
  }
}

/**
 * Runs one story operation within its absolute execution budget.
 *
 * @param {() => Promise<Record<string, unknown>>} execute Starts the story operation.
 * @param {AbortSignal} deadlineSignal Absolute story deadline signal.
 * @param {number} timeoutMs Story execution budget in milliseconds.
 * @returns {Promise<Record<string, unknown>>} Story result before the deadline.
 * @throws {Error} When the absolute story deadline expires first.
 */
function runWithinStoryDeadline(execute, deadlineSignal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rejectForDeadline = () => {
      deadlineSignal.removeEventListener('abort', rejectForDeadline);
      reject(new Error(`Real Task Mode story exceeded its ${timeoutMs} ms execution budget.`));
    };

    if (deadlineSignal.aborted) {
      rejectForDeadline();
      return;
    }

    deadlineSignal.addEventListener('abort', rejectForDeadline, { once: true });
    Promise.resolve()
      .then(execute)
      .then(
        (result) => {
          deadlineSignal.removeEventListener('abort', rejectForDeadline);
          resolve(result);
        },
        (error) => {
          deadlineSignal.removeEventListener('abort', rejectForDeadline);
          reject(error);
        }
      );
  });
}

/**
 * Executes the real Task story with an already-created client lifetime.
 *
 * @param {{ clients: { core: Record<string, any> }, initialHead: string, options: Record<string, any>, prerequisites: ReturnType<typeof evaluateTaskModeRealWorkerPrerequisites>, stdout: (message: string) => void, story: ReturnType<typeof parseStoryDocument> }} input Execution dependencies.
 * @returns {Promise<Record<string, unknown>>} Redacted story result.
 */
async function executeTaskModeRealWorkerStory({
  clients,
  initialHead,
  options,
  prerequisites,
  stdout,
  story,
}) {
  const diagnostics = await clients.core.app.getDiagnostics();
  assert(
    diagnostics.boot?.acceptingProductWork === true,
    'Target NanoCore is not accepting product work.'
  );

  const thread = await clients.core.core.createThread({
    name: 'Task Mode real worker release',
    workspaceId: prerequisites.config.workspaceId,
  });
  const threadId = thread.id;

  assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

  await clients.core.repositories.setDefault(prerequisites.config.workspaceId, {
    displayName: 'Task Mode real worker repository',
    localPath: prerequisites.config.repositoryRoot,
  });

  const task = await clients.core.app.startTaskMode(prerequisites.config.workspaceId, threadId, {
    input: prerequisites.config.taskInput,
  });

  assert(task.state !== 'escalated-to-goal', 'Task Mode escalated a bounded real-worker task.');
  assert(typeof task.turn?.id === 'string', 'Task Mode response did not include a turn id.');
  assert(task.decision?.mode === 'task', 'Task Mode response did not include a task decision.');
  const acceptedStates = new Set(['completed', 'needs-review']);
  assert(
    acceptedStates.has(task.state),
    `Task Mode returned a non-acceptance state: ${task.state}`
  );
  const schedulerLease = assertTaskModeSchedulerLease({
    dataRoot: prerequisites.config.nanoCoreDataRoot,
    turnId: task.turn.id,
  });

  const workspaceReviewList = await clients.core.app.listWorkspaceSyncReviews(
    prerequisites.config.workspaceId
  );
  const reviewIds = task.evidence?.reviewIds ?? [];
  const workspaceReviews = (workspaceReviewList.items ?? []).filter((item) =>
    reviewIds.includes(item.review?.id)
  );
  assert(
    workspaceReviews.length === 1,
    'Task Mode evidence did not map to exactly one durable workspace review.'
  );
  const workspaceReview = workspaceReviews[0];

  let workspace;
  let cleanupDecision;
  let threadRead;
  let actionCenter;
  let reconciliation;
  let provenance;
  let aep;

  try {
    const [
      backendHandles,
      reconciliationRecords,
      threadResponse,
      actionCenterResponse,
      aepRead,
      usage,
      evidenceResource,
      runtimeEvidenceResource,
      auditResource,
    ] = await Promise.all([
      clients.core.app.listBackendWorkspaceHandles(prerequisites.config.workspaceId),
      clients.core.app.listWorkspaceReconciliationRecords(prerequisites.config.workspaceId),
      clients.core.core.listThreadItems(prerequisites.config.workspaceId, threadId),
      clients.core.actionCenter.listHumanAttention(prerequisites.config.workspaceId),
      clients.core.app.listAgentEnvironmentPackageSnapshots(prerequisites.config.workspaceId),
      clients.core.app.getCapabilityUsage(prerequisites.config.workspaceId),
      clients.core.app.listWorkspaceEvidenceBundles(prerequisites.config.workspaceId),
      clients.core.app.listWorkspaceRuntimeEvidence(prerequisites.config.workspaceId),
      clients.core.app.listWorkspaceAuditEvents(prerequisites.config.workspaceId),
    ]);
    threadRead = threadResponse;
    actionCenter = actionCenterResponse;
    reconciliation = assertTaskModeWorkspaceReconciliation(reconciliationRecords.items ?? []);
    const items = threadRead.items ?? [];
    assert(items.length > 0, 'Task Mode thread did not include visible items.');
    const completedAssistantItems = items.filter(
      (item) => item.type === 'assistant-message' && item.status === 'completed'
    );
    assert(
      completedAssistantItems.length === 1,
      'Task Mode thread did not include one canonical outer assistant message.'
    );
    const evidence = evidenceResource;
    const runtimeEvidence = runtimeEvidenceResource;
    const audit = auditResource;
    provenance = assertTaskModeRuntimeProvenance({
      auditEvents: audit.auditEvents ?? [],
      capabilityCalls: usage.capabilityCalls ?? [],
      evidenceBundles: evidence.evidenceBundles ?? [],
      runtimeEvidence: runtimeEvidence.runtimeEvidence ?? [],
      threadItems: items,
      turnId: task.turn.id,
      usageRecords: usage.usageRecords ?? [],
    });
    aep = assertTaskModeAgentEnvironment({
      aepRead,
      initialHead,
      packageSnapshotId: provenance.packageSnapshotId,
      turnId: task.turn.id,
    });
    workspace = assertTaskModeWorkspaceProof({
      backendHandles: backendHandles.items ?? [],
      initialHead,
      review: workspaceReview,
      taskEvidence: task.evidence ?? {},
    });
    assertNoRuntimeProvenanceLeak({
      actionCenter,
      aepRead,
      audit,
      backendHandles,
      evidence,
      reconciliationRecords,
      runtimeEvidence,
      threadRead,
      usage,
      workspaceReviewList,
    });
  } finally {
    cleanupDecision = await clients.core.app.submitWorkspaceSyncReviewDecision(
      prerequisites.config.workspaceId,
      workspaceReview.review.id,
      { decision: 'rejected', requestId: randomUUID() }
    );
  }

  assert(
    cleanupDecision?.review?.status === 'rejected',
    'Task Mode workspace review cleanup was not recorded.'
  );
  const gitSummary = assertFinalTaskRepository(prerequisites.config.repositoryRoot, initialHead);
  const items = threadRead.items ?? [];
  const completedAssistantItems = items.filter(
    (item) => item.type === 'assistant-message' && item.status === 'completed'
  );

  const result = {
    aep,
    cleanup: {
      backendHandleCount: workspace.backendHandleCount,
      reconciliationRecordCount: reconciliation.recordCount,
      reviewDecision: cleanupDecision.review.status,
      schedulerCapacityInUseCount: schedulerLease.capacityInUseCount,
      schedulerLeaseReleaseReason: schedulerLease.releaseReason,
      schedulerLeaseStatus: schedulerLease.status,
      teardownEvidenceCount: provenance.teardownEvidenceCount,
    },
    config: redactedConfig(prerequisites.config),
    generatedAt: (options.now ?? new Date()).toISOString(),
    story: {
      id: story.metadata.id,
      title: story.metadata.title,
    },
    task: {
      artifactIds: task.evidence?.artifactIds ?? [],
      itemIds: task.evidence?.itemIds ?? [],
      reviewIds: task.evidence?.reviewIds ?? [],
      state: task.state,
      turnId: task.turn.id,
      worker: task.decision.worker,
    },
    thread: {
      completedAssistantItemCount: completedAssistantItems.length,
      itemCount: items.length,
      threadId,
    },
    actionCenter: {
      itemCount: actionCenter.items?.length ?? 0,
    },
    git: gitSummary,
    provenance,
    status: 'ok',
    workspace,
  };
  const redactionNotes = buildRedactionNotes(prerequisites.config, story.metadata);
  assertNoRuntimeProvenanceLeak({ redactionNotes, result });

  mkdirSync(prerequisites.config.evidenceDir, { recursive: true });
  writeFileSync(
    join(prerequisites.config.evidenceDir, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`
  );
  writeFileSync(join(prerequisites.config.evidenceDir, REDACTION_NOTES_FILE), redactionNotes);
  stdout(JSON.stringify(result, null, 2));

  return result;
}

/**
 * Creates one real Core Client instance from the built workspace artifact.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner configuration.
 * @param {number} timeoutMs Story deadline applied to response headers and body progress.
 * @param {AbortSignal} deadlineSignal Absolute story execution deadline.
 * @returns {Promise<{ close: () => Promise<void>, core: Record<string, any> }>} Runtime client and its transport cleanup.
 */
async function createRealClients(config, timeoutMs, deadlineSignal) {
  assertBuilt(coreClientDist);
  const { createCoreClient } = await import(pathToFileURL(coreClientDist).href);
  const dispatcher = new Agent({ bodyTimeout: timeoutMs, headersTimeout: timeoutMs });
  /**
   * Sends one runner request through the story-owned long-running dispatcher.
   *
   * @param {RequestInfo | URL} input Request URL or request object.
   * @param {RequestInit | undefined} init Optional request initialization.
   * @returns {Promise<Response>} NanoCore response.
   */
  const fetchWithDispatcher = async (input, init) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const signal = requestSignal
      ? AbortSignal.any([deadlineSignal, requestSignal])
      : deadlineSignal;
    return undiciFetch(input, { ...init, dispatcher, signal });
  };
  const clientOptions = {
    baseUrl: config.nanoCoreUrl,
    fetch: fetchWithDispatcher,
    ...(config.token ? { headers: authHeaders(config.token) } : {}),
  };
  /**
   * Closes the story-owned transport after success or failure.
   *
   * @returns {Promise<void>} Completion after every dispatcher resource closes.
   */
  const close = async () => {
    await dispatcher.close();
  };

  return {
    close,
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
 * @returns {Record<string, unknown>} Redacted config.
 */
function redactedConfig(config) {
  return {
    evidenceDir: config.evidenceDir,
    nanoCoreDataRoot: config.nanoCoreDataRoot,
    nanoCoreUrl: config.nanoCoreUrl,
    repositoryRoot: config.repositoryRoot,
    storyPath: config.storyPath,
    tokenProvided: Boolean(config.token),
    workspaceId: config.workspaceId,
  };
}

/**
 * Verifies that the exact Task turn released its sole scheduler lease normally.
 *
 * @param {{ dataRoot: string, turnId: string }} input NanoCore data root and completed turn id.
 * @returns {{ capacityInUseCount: 0, releaseReason: 'turn-completed', status: 'released' }} Product-safe lease summary.
 */
function assertTaskModeSchedulerLease({ dataRoot, turnId }) {
  const database = new DatabaseSync(join(dataRoot, 'server', 'db', 'core.sqlite'), {
    readOnly: true,
  });

  try {
    const leases = database
      .prepare(
        `SELECT leases.status,
                leases.release_reason AS releaseReason,
                capacity.in_use_count AS capacityInUseCount
           FROM scheduler_session_leases AS leases
           JOIN scheduler_capacity_records AS capacity
             ON capacity.target_id = leases.target_id
          WHERE leases.turn_id = ?`
      )
      .all(turnId);
    assert(
      leases.length === 1 &&
        leases[0]?.status === 'released' &&
        leases[0]?.releaseReason === 'turn-completed',
      'Task Mode scheduler lease was not released with turn-completed.'
    );
    assert(leases[0]?.capacityInUseCount === 0, 'Task Mode scheduler capacity was not released.');
    const finalStatus = database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM worker_control_records
          WHERE turn_id = ? AND operation = 'final_status'`
      )
      .get(turnId);
    assert(
      finalStatus?.count === 1,
      'Task Mode did not preserve exactly one accepted final_status record.'
    );
    return { capacityInUseCount: 0, releaseReason: 'turn-completed', status: 'released' };
  } finally {
    database.close();
  }
}

/**
 * Rejects false human recovery rows left by an otherwise successful Task turn.
 *
 * @param {Array<Record<string, any>>} records Workspace reconciliation records.
 * @returns {{ recordCount: number }} Product-safe reconciliation summary.
 */
function assertTaskModeWorkspaceReconciliation(records) {
  assert(
    !records.some(
      (record) =>
        record.triggerReason === 'backend_takeover' && record.stateAfter === 'requires-human'
    ),
    'Task Mode left a requires-human backend_takeover workspace reconciliation record.'
  );
  return { recordCount: records.length };
}

/**
 * Reads a short git status from the disposable repository.
 *
 * @param {string} repositoryRoot Repository root.
 * @returns {string} Short git status output.
 */
function git(repositoryRoot, args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Validates the disposable Task repository before NanoCore mutation.
 *
 * @param {string} repositoryRoot Repository root.
 * @returns {string} Initial commit id.
 */
function assertInitialTaskRepository(repositoryRoot) {
  assert(
    git(repositoryRoot, ['status', '--short', '--untracked-files=all']) === '',
    'Task Mode repository is not initially clean.'
  );
  assert(
    !existsSync(join(repositoryRoot, TASK_MODE_REAL_WORKER_PROOF_PATH)),
    'Task Mode proof file already exists.'
  );
  git(repositoryRoot, ['diff', '--check']);
  const head = git(repositoryRoot, ['rev-parse', 'HEAD']);
  assert(head.length > 0, 'Task Mode repository does not have a baseline commit.');
  return head;
}

/**
 * Validates that review cleanup left the disposable repository unchanged.
 *
 * @param {string} repositoryRoot Repository root.
 * @param {string} initialHead Initial commit id.
 * @returns {{ headUnchanged: true, statusShort: string }} Product-safe Git summary.
 */
function assertFinalTaskRepository(repositoryRoot, initialHead) {
  git(repositoryRoot, ['diff', '--check']);
  const statusShort = git(repositoryRoot, ['status', '--short', '--untracked-files=all']);
  assert(statusShort === '', 'Task Mode review cleanup left repository changes behind.');
  assert(
    git(repositoryRoot, ['rev-parse', 'HEAD']) === initialHead,
    'Task Mode worker changed the repository commit.'
  );
  return { headUnchanged: true, statusShort };
}

/**
 * Fails the runner when a required build output is missing.
 *
 * @param {string} filePath Build output path.
 */
function assertBuilt(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required build output is missing: ${filePath}`);
  }
}

/**
 * Builds redaction notes for the evidence bundle.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner config.
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Story metadata.
 * @returns {string} Redaction notes.
 */
function buildRedactionNotes(config, metadata) {
  return `# Task Mode Real Worker Redaction Notes

Story: ${metadata.id}

Evidence directory: ${config.evidenceDir}

Repository root: ${config.repositoryRoot}

## Required Redaction Checks

- Do not preserve raw OAuth tokens, bearer tokens, API keys, cookie values, authorization headers, or Codex auth JSON content.
- Preserve product-safe ids, counts, state names, worker target summaries, and git status only.
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
  const text = JSON.stringify(value);
  const patterns = [
    /native(?:Thread|Session|Turn|CacheLineage)Id/i,
    /parentNativeThreadId/i,
    /prompt_cache_key/i,
    /x-codex-turn-metadata/i,
    /\b(?:thread_id|parent_thread_id|sender_thread_id|receiver_thread_ids)\b/i,
    /"(?:access_token|refresh_token|api_?key|client_?secret|authorization|cookie)"\s*:/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  ];
  assert(
    patterns.every((pattern) => !pattern.test(text)),
    'Public story evidence exposed runtime-native metadata or credential material.'
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
    throw new Error(message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTaskModeRealWorkerStory().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
