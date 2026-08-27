import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Agent } from 'undici';
import {
  assertBuilt,
  assertNoPublicSecretLeak,
  prepareEvidenceDirectory,
  REAL_CODEX_MODEL_ID,
  verifyRealCodexRuntime,
  waitForChildOrDeadline,
  writeExclusiveEvidenceFile,
} from './_lib/real-codex-support.mjs';

// L3 layer owner: docs/specs/20260529-test_strategy.md.
// Task and provenance behavior owners: docs/specs/20260704-task_mode_worker_delegation.md and
// docs/specs/20260711-worker_runtime_subagent_provenance.md.
const nanoCoreE2eRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(nanoCoreE2eRoot, '../../..');
const coreClientDist = join(repoRoot, 'packages/core-client/dist/index.js');

/** Undici settings that leave the real Task request deadline to the process supervisor. */
export const TASK_MODE_REAL_WORKER_HTTP_TIMEOUTS = Object.freeze({
  bodyTimeout: 0,
  headersTimeout: 0,
});

const RESULT_FILE = 'task-mode-real-worker-result.json';
const FAILURE_FILE = 'task-mode-real-worker-failure.json';
const REDACTION_NOTES_FILE = 'task-mode-real-worker-redaction-notes.md';
const TASK_EVIDENCE_FILES = [FAILURE_FILE, REDACTION_NOTES_FILE, RESULT_FILE];
const PROVENANCE_SUMMARY_PATTERN =
  /^Worker runtime provenance complete: (\d+) streams, (\d+) frames, (\d+) attributed, (\d+) unattributed, (\d+) roots?, (\d+) children, (\d+)\/(\d+) gateway calls reconciled, gateway complete, bundles \S+ and \S+\.$/;
/** Fixed one-hour deadline for the explicitly opt-in real-worker L3 test. */
const TASK_MODE_REAL_WORKER_TIMEOUT_MS = 3_600_000;
const TASK_TEST_TIMEOUT_MESSAGE = 'Real Task Mode worker test exceeded its deadline.';
const TASK_TEST_FAILURE_MESSAGE = 'Real Task Mode worker test failed.';
const TASK_ASSERTION_ERROR_CODE = 'OPENKIT_TASK_MODE_ASSERTION';
const SUPERVISED_CHILD_ARG = '--openkit-task-l3-supervised-child';
const GIT_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PRODUCT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const HOST_MANIFEST_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TASK_MODE_GIT_SOURCE_ID = 'task-mode-repository';
const taskModeRealWorkerDispatcher = new Agent(TASK_MODE_REAL_WORKER_HTTP_TIMEOUTS);

/** Repository-relative proof file requested by the default task input. */
const TASK_MODE_REAL_WORKER_PROOF_PATH = 'docs/task-mode-runtime-provenance-proof.md';

/**
 * @typedef {object} TaskModeRealWorkerRunnerConfig
 * @property {string} evidenceDir Directory where redacted evidence files are written.
 * @property {string} gitCommit Exact lowercase 40- or 64-hex remote Git commit.
 * @property {string} gitUrl Credential-free HTTPS remote Git URL.
 * @property {string} hostManifestDigest Exact 64-lowercase-hex host-manifest digest.
 * @property {string} nanoCoreUrl Existing NanoCore endpoint.
 * @property {string} productCommit Exact 40-lowercase-hex product commit.
 * @property {string | undefined} sessionCookie Optional Better Auth session cookie.
 * @property {string} taskInput Task Mode input.
 * @property {string | undefined} token Optional NanoCore bearer token.
 * @property {string} workerImageRef Exact A1-built worker image used by the acceptance run.
 */

/**
 * Evaluates whether the real Task Mode runner has explicit opt-in and usable paths.
 *
 * @param {{ env?: Record<string, string | undefined> }} options Evaluation options.
 * @returns {{ config: TaskModeRealWorkerRunnerConfig, enabled: boolean, reason: string }} Prerequisite result.
 */
export function evaluateTaskModeRealWorkerPrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const config = {
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR ?? '',
    gitCommit: env.OPENKIT_L6_TASK_GIT_COMMIT ?? '',
    gitUrl: env.OPENKIT_L6_TASK_GIT_URL ?? '',
    hostManifestDigest: env.OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST ?? '',
    nanoCoreUrl: env.OPENKIT_L6_TASK_NANOCORE_URL ?? '',
    productCommit: env.OPENKIT_L6_TASK_PRODUCT_COMMIT ?? '',
    sessionCookie: env.OPENKIT_NANOCORE_SESSION_COOKIE,
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

  if (!config.nanoCoreUrl) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_TASK_NANOCORE_URL' };
  }

  if (!config.workerImageRef) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_TASK_WORKER_IMAGE_REF' };
  }

  let gitUrl;
  try {
    gitUrl = new URL(config.gitUrl);
  } catch {
    gitUrl = null;
  }
  if (
    gitUrl === null ||
    gitUrl.protocol !== 'https:' ||
    gitUrl.username !== '' ||
    gitUrl.password !== '' ||
    gitUrl.search !== '' ||
    gitUrl.hash !== ''
  ) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_GIT_URL to a credential-free HTTPS Git URL',
    };
  }

  if (!GIT_COMMIT_PATTERN.test(config.gitCommit)) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_GIT_COMMIT to a lowercase 40- or 64-hex Git commit',
    };
  }

  if (!config.evidenceDir) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_EVIDENCE_DIR to a writable evidence directory',
    };
  }

  if (!PRODUCT_COMMIT_PATTERN.test(config.productCommit)) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_PRODUCT_COMMIT to a 40-lowercase-hex product commit',
    };
  }

  if (!HOST_MANIFEST_DIGEST_PATTERN.test(config.hostManifestDigest)) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST to a 64-lowercase-hex host-manifest digest',
    };
  }

  const token = typeof config.token === 'string' ? config.token : undefined;
  const sessionCookie = typeof config.sessionCookie === 'string' ? config.sessionCookie : undefined;
  if (
    (token !== undefined && /[\r\n]/.test(token)) ||
    (sessionCookie !== undefined && /[\r\n]/.test(sessionCookie))
  ) {
    return {
      config,
      enabled: false,
      reason:
        'OPENKIT_NANOCORE_TOKEN and OPENKIT_NANOCORE_SESSION_COOKIE must not contain CR or LF',
    };
  }
  if (
    (token !== undefined && token.trim() === '') ||
    (sessionCookie !== undefined && sessionCookie.trim() === '')
  ) {
    return {
      config,
      enabled: false,
      reason:
        'OPENKIT_NANOCORE_TOKEN and OPENKIT_NANOCORE_SESSION_COOKIE must be nonempty after trimming',
    };
  }
  const tokenProvided = token !== undefined && token.trim().length > 0;
  const sessionCookieProvided = sessionCookie !== undefined && sessionCookie.trim().length > 0;
  if (tokenProvided !== sessionCookieProvided) {
    return {
      config,
      enabled: false,
      reason:
        'set both OPENKIT_NANOCORE_TOKEN and OPENKIT_NANOCORE_SESSION_COOKIE, or omit both for local mode',
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
      transcriptEvidence.backendVersion === '0.0.99',
    'Runtime provenance did not come from the pinned OpenShell 0.0.99 target.'
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
 * Validates the trusted Task worker AEP used by the real provenance test.
 *
 * @param {{ aepRead: Record<string, any>, expectedGitCommit: string, expectedGitUrl: string, expectedImageRef: string, expectedProviderId: string, packageSnapshotId: string, turnId: string }} input AEP assertion input.
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
    route?.providerInstanceId === input.expectedProviderId && route?.model === REAL_CODEX_MODEL_ID,
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
  const workspaceInputs = snapshot?.workspace?.inputs ?? [];
  const workspaceInput = workspaceInputs[0];
  assert(
    snapshot?.workspace?.root === '/workspace/openkit' &&
      workspaceInputs.length === 1 &&
      workspaceInput?.access === 'read-write' &&
      workspaceInput?.id === 'repo_remote' &&
      workspaceInput?.kind === 'directory' &&
      workspaceInput?.target === '/workspace/openkit/worktrees/main' &&
      workspaceInput?.materialization?.strategy === 'git' &&
      workspaceInput?.materialization?.changeSetManifestPath ===
        '/openkit/session/workspace-changes.json',
    'Task Mode AEP workspace root or declared Git worktree is incorrect.'
  );
  assert(
    workspaceInput?.source?.kind === 'git' &&
      workspaceInput?.source?.url === input.expectedGitUrl &&
      workspaceInput?.source?.commit === input.expectedGitCommit &&
      workspaceInput?.source?.sourceId === TASK_MODE_GIT_SOURCE_ID &&
      workspaceInput?.source?.sourceRef === TASK_MODE_GIT_SOURCE_ID,
    'Task Mode AEP Git source is incorrect.'
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
 * Runs the opt-in real OpenShell/Codex Task Mode L3 test.
 *
 * @param {{ clients?: { admin: Record<string, any>, core: Record<string, any> }, configureRuntime?: (admin: Record<string, any>) => Promise<{ providerId: string }>, createClients?: (config: TaskModeRealWorkerRunnerConfig) => Promise<{ admin: Record<string, any>, core: Record<string, any> }>, env?: Record<string, string | undefined>, now?: Date, stdout?: (message: string) => void }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Runner result.
 */
export async function runTaskModeRealWorkerTest(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateTaskModeRealWorkerPrerequisites({
    env,
  });

  if (!prerequisites.enabled) {
    stdout(`SKIP real Task Mode worker L3 test: ${prerequisites.reason}`);
    return {
      config: redactedConfig(prerequisites.config),
      reason: prerequisites.reason,
      status: 'skipped',
    };
  }

  prepareEvidenceDirectory(prerequisites.config.evidenceDir, TASK_EVIDENCE_FILES);

  try {
    const clients =
      options.clients ?? (await (options.createClients ?? createRealClients)(prerequisites.config));
    const runtime = await (options.configureRuntime ?? verifyRealCodexRuntime)(clients.admin);

    return await executeTaskModeRealWorkerTest({
      clients,
      expectedProviderId: runtime.providerId,
      options,
      prerequisites,
      stdout,
    });
  } catch (error) {
    tryWriteTaskModeFailureEvidence(prerequisites.config, error, options.now ?? new Date());
    throw error;
  }
}

/**
 * Executes the real Task test through an injected Core Client.
 *
 * @param {{ clients: { admin: Record<string, any>, core: Record<string, any> }, expectedProviderId: string, options: Record<string, any>, prerequisites: ReturnType<typeof evaluateTaskModeRealWorkerPrerequisites>, stdout: (message: string) => void }} input Execution dependencies.
 * @returns {Promise<Record<string, unknown>>} Redacted test result.
 */
async function executeTaskModeRealWorkerTest({
  clients,
  expectedProviderId,
  options,
  prerequisites,
  stdout,
}) {
  const diagnostics = await clients.admin.app.getDiagnostics();
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

  const catalogCreate = await clients.admin.runtimeConfig.createFile({
    content: `${JSON.stringify(
      {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Task Mode real worker repository',
            id: TASK_MODE_GIT_SOURCE_ID,
            kind: 'git',
            locator: {
              commit: prerequisites.config.gitCommit,
              url: prerequisites.config.gitUrl,
            },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
      null,
      2
    )}\n`,
    id: `workspaces/${workspaceId}/data-sources.jsonc`,
    kind: 'data-source',
  });
  assert(
    catalogCreate?.file?.exists === true && catalogCreate?.diagnostics?.length === 0,
    'Task Mode workspace data source catalog was not created cleanly.'
  );
  const reload = await clients.admin.runtimeConfig.reload({ mode: 'safe' });
  const deferredPaths = reload?.plan?.deferred?.map((change) => change.path);
  assert(
    deferredPaths?.length === 1 &&
      deferredPaths[0] === 'workspaceDataSources' &&
      reload.plan.rejected?.length === 0 &&
      reload.plan.requiresRestart?.length === 0 &&
      reload.runtimeConfig?.pendingRestart?.length === 0,
    'Task Mode workspace data source safe reload did not defer cleanly without restart.'
  );

  const task = await clients.core.app.startTaskMode(workspaceId, threadId, {
    input: prerequisites.config.taskInput,
  });
  const reviewIds = Array.isArray(task.evidence?.reviewIds) ? task.evidence.reviewIds : [];
  let provenance;
  let aep;
  let items = [];
  let assertionsPassed = false;
  let runtimeEvidenceRead = null;
  let runtimeEvidencePromise = null;

  try {
    assert(task.state !== 'escalated-to-goal', 'Task Mode escalated a bounded real-worker task.');
    assert(typeof task.turn?.id === 'string', 'Task Mode response did not include a turn id.');
    assert(task.state === 'completed', `Task Mode returned a non-acceptance state: ${task.state}`);
    runtimeEvidencePromise = clients.core.app.listWorkspaceRuntimeEvidence(workspaceId);
    const [threadResponse, aepRead, usage, runtimeEvidence] = await Promise.all([
      clients.core.core.listThreadItems(workspaceId, threadId),
      clients.core.app.listAgentEnvironmentPackageSnapshots(workspaceId),
      clients.core.app.getCapabilityUsage(workspaceId),
      runtimeEvidencePromise,
    ]);
    runtimeEvidenceRead = runtimeEvidence;
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
      expectedGitCommit: prerequisites.config.gitCommit,
      expectedGitUrl: prerequisites.config.gitUrl,
      expectedImageRef: prerequisites.config.workerImageRef,
      expectedProviderId,
      packageSnapshotId: provenance.packageSnapshotId,
      turnId: task.turn.id,
    });
    assertionsPassed = true;
  } catch (error) {
    if (runtimeEvidenceRead === null && typeof task.turn?.id === 'string') {
      try {
        if (runtimeEvidencePromise === null) {
          runtimeEvidencePromise = clients.core.app.listWorkspaceRuntimeEvidence(workspaceId);
        }
        runtimeEvidenceRead = await runtimeEvidencePromise;
      } catch {}
    }
    tryWriteTaskModeFailureEvidence(
      prerequisites.config,
      error,
      options.now ?? new Date(),
      (runtimeEvidenceRead?.runtimeEvidence ?? []).filter(
        (record) => record?.turnId === task.turn?.id
      )
    );
    throw error;
  } finally {
    const cleanupResults = await Promise.allSettled(
      reviewIds.map((reviewId) =>
        clients.core.app.submitWorkspaceSyncReviewDecision(workspaceId, reviewId, {
          decision: 'rejected',
          requestId: randomUUID(),
        })
      )
    );
    if (assertionsPassed) {
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
    hostManifestDigest: prerequisites.config.hostManifestDigest,
    productCommit: prerequisites.config.productCommit,
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
  const redactionNotes = buildRedactionNotes();
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
 * Runs the real Task test in an isolated Unix process group with a hard deadline.
 *
 * @param {{ childEntrypoint?: string, env?: Record<string, string | undefined>, killProcess?: typeof process.kill, spawnProcess?: typeof spawn, stdout?: (message: string) => void }} options Supervisor options.
 * @returns {Promise<Record<string, unknown>>} Redacted skip or supervised completion result.
 */
async function runTaskModeRealWorkerCli(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateTaskModeRealWorkerPrerequisites({
    env,
  });

  if (!prerequisites.enabled) {
    return runTaskModeRealWorkerTest({ ...options, env, stdout });
  }

  prepareEvidenceDirectory(prerequisites.config.evidenceDir, TASK_EVIDENCE_FILES);
  const childEntrypoint = options.childEntrypoint ?? fileURLToPath(import.meta.url);
  const child = (options.spawnProcess ?? spawn)(
    process.execPath,
    [childEntrypoint, SUPERVISED_CHILD_ARG],
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
    TASK_MODE_REAL_WORKER_TIMEOUT_MS,
    options.killProcess ?? process.kill
  );

  if (outcome.kind === 'timeout') {
    const error = new Error(TASK_TEST_TIMEOUT_MESSAGE);
    tryWriteTaskModeFailureEvidence(prerequisites.config, error, options.now ?? new Date());
    throw error;
  }
  if (outcome.exitCode !== 0) {
    const error = new Error(TASK_TEST_FAILURE_MESSAGE);
    tryWriteTaskModeFailureEvidence(prerequisites.config, error, options.now ?? new Date());
    throw error;
  }

  return { status: 'ok' };
}

/**
 * Writes one structured Task failure record without preserving an untrusted raw error.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Redacted runner configuration source.
 * @param {unknown} error Raw execution failure used only for stable classification.
 * @param {Date} generatedAt Evidence timestamp.
 * @param {unknown[]} [runtimeEvidence] Product-safe evidence for the exact failed Turn.
 */
function writeTaskModeFailureEvidence(config, error, generatedAt, runtimeEvidence = []) {
  const failure = {
    config: redactedConfig(config, null),
    failure: classifyTaskModeRealWorkerFailure(error),
    generatedAt: generatedAt.toISOString(),
    runtimeEvidence,
    status: 'failed',
  };
  const text = JSON.stringify(failure);
  assertNoRuntimeProvenanceLeak(failure);
  assert(
    [config.gitUrl, config.sessionCookie, config.token]
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
 * @param {unknown} error Original failure.
 * @param {Date} generatedAt Evidence timestamp.
 * @param {unknown[]} [runtimeEvidence] Product-safe evidence for the exact failed Turn.
 */
function tryWriteTaskModeFailureEvidence(config, error, generatedAt, runtimeEvidence = []) {
  try {
    writeTaskModeFailureEvidence(config, error, generatedAt, runtimeEvidence);
  } catch {
    // The original failure remains authoritative when exclusive persistence loses a race.
  }
}

/**
 * Maps one raw Task execution failure to a stable secret-free summary.
 *
 * @param {unknown} error Raw execution failure.
 * @returns {{ kind: 'assertion_failure' | 'runtime_failure' | 'timeout', message: string }} Redacted failure summary.
 */
function classifyTaskModeRealWorkerFailure(error) {
  if (error instanceof Error && error.message === TASK_TEST_TIMEOUT_MESSAGE) {
    return { kind: 'timeout', message: TASK_TEST_TIMEOUT_MESSAGE };
  }
  if (
    error instanceof Error &&
    /** @type {Error & { code?: string }} */ (error).code === TASK_ASSERTION_ERROR_CODE
  ) {
    return { kind: 'assertion_failure', message: error.message };
  }

  return { kind: 'runtime_failure', message: TASK_TEST_FAILURE_MESSAGE };
}

/**
 * Creates deployment-admin and product Core Client instances from the built workspace artifact.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner configuration.
 * @param {((options: Record<string, unknown>) => Record<string, any>) | undefined} [createClient] Optional Core Client constructor; defaults to imported createCoreClient.
 * @returns {Promise<{ admin: Record<string, any>, core: Record<string, any> }>} Deployment-admin and product clients.
 */
export async function createRealClients(config, createClient) {
  let construct = createClient;
  if (construct === undefined) {
    assertBuilt(coreClientDist);
    ({ createCoreClient: construct } = await import(pathToFileURL(coreClientDist).href));
  }
  const clientOptions = {
    baseUrl: config.nanoCoreUrl,
    fetch: fetchTaskModeRealWorker,
  };
  if (!config.token && !config.sessionCookie) {
    const client = construct(clientOptions);
    return {
      admin: client,
      core: client,
    };
  }

  return {
    admin: construct({
      ...clientOptions,
      headers: authHeaders(config.token),
    }),
    core: construct({
      ...clientOptions,
      headers: sessionCookieHeaders(config.sessionCookie),
    }),
  };
}

/**
 * Sends one real Task request without adding a transport deadline below the process supervisor.
 *
 * @param {string | URL | Request} input Request target.
 * @param {RequestInit | undefined} init Optional request options.
 * @returns {Promise<Response>} WHATWG response.
 */
export function fetchTaskModeRealWorker(input, init) {
  return fetch(input, { ...init, dispatcher: taskModeRealWorkerDispatcher });
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
 * Creates static Cookie headers for the canonical product-user client.
 *
 * @param {string} sessionCookie Operator-provided Better Auth session cookie.
 * @returns {HeadersInit} Static request headers.
 */
function sessionCookieHeaders(sessionCookie) {
  return {
    cookie: sessionCookie.trim(),
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
    gitSourceConfigured: Boolean(config.gitUrl && config.gitCommit),
    nanoCoreUrl: projectNanoCoreBaseUrl(config.nanoCoreUrl),
    sessionCookieProvided: Boolean(config.sessionCookie),
    tokenProvided: Boolean(config.token),
    workerImageRef: config.workerImageRef,
    workspaceId,
  };
}

/**
 * Projects a NanoCore URL to its origin without user information, paths, queries, or fragments.
 *
 * @param {string} value Raw NanoCore base URL.
 * @returns {string} Product-safe origin, or an empty string when the URL is invalid.
 */
function projectNanoCoreBaseUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/**
 * Builds redaction notes for the evidence bundle.
 *
 * @returns {string} Redaction notes.
 */
function buildRedactionNotes() {
  return `# Task Mode Real Worker Redaction Notes

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
    'Public Task test evidence exposed runtime-native metadata.'
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
    runTaskModeRealWorkerTest().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  } else {
    runTaskModeRealWorkerCli().catch((error) => {
      console.error(classifyTaskModeRealWorkerFailure(error).message);
      process.exitCode = 1;
    });
  }
}
