import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertBuilt,
  assertNoPublicSecretLeak,
  prepareEvidenceDirectory,
  waitForChildOrDeadline,
  writeExclusiveEvidenceFile,
} from './_lib/real-codex-support.mjs';

// L3 ownership: docs/specs/20260529-test_strategy.md.
const nanoCoreE2eRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(nanoCoreE2eRoot, '../../..');
const coreClientDist = join(repoRoot, 'packages/core-client/dist/index.js');

const RESULT_FILE = 'worker-responses-relay-real-provider-result.json';
const FAILURE_FILE = 'worker-responses-relay-real-provider-failure.json';
const RELAY_EVIDENCE_FILES = [FAILURE_FILE, RESULT_FILE];
const PUBLIC_FAILURE_REASON = 'Worker Responses relay L3 test failed.';
const RELAY_ASSERTION_ERROR_CODE = 'OPENKIT_WORKER_RESPONSES_RELAY_ASSERTION';
const RELAY_TIMEOUT_ERROR_CODE = 'OPENKIT_WORKER_RESPONSES_RELAY_TIMEOUT';
/** Fixed one-hour deadline for the explicitly opt-in worker Responses relay L3 test. */
const WORKER_RESPONSES_RELAY_TIMEOUT_MS = 3_600_000;
const SUPERVISED_CHILD_ARG = '--openkit-worker-responses-relay-supervised-child';
const RELAY_FAILURE_KIND = Object.freeze({
  assertion: 'assertion',
  timeout: 'timeout',
  unknown: 'unknown',
});
const RELAY_CLEANUP = Object.freeze({
  failed: 'failed',
  succeeded: 'succeeded',
  unknown: 'unknown',
});
const HOST_MANIFEST_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CODEX_AGENT_ID = 'agent_codex_host';
const OPENCODE_AGENT_ID = 'agent_opencode_server';
const ADAPTER_REPORTED_USAGE_PREFIX = 'llm-gateway-adapter-reported:';
const RELAY_TASK_INPUT =
  'Implement one bounded worker proof: write exactly one line to worker-responses-relay-proof.md confirming the inference relay completed. Do not modify any other file. Do not commit.';
const EVIDENCE_ALLOWLIST = Object.freeze([
  'assertions',
  'codexImageRef',
  'hostManifestDigest',
  'model',
  'opencodeImageRef',
  'providerId',
  'status',
]);
const EVIDENCE_ASSERTION_KEYS = Object.freeze(['codexResponsesRelay', 'opencodeResponsesRelay']);
const FORBIDDEN_EVIDENCE_VALUE_PATTERNS = [
  /^file:/i,
  /^[/\\]/,
  /native(?:Thread|Session|Turn|CacheLineage)Id/i,
  /\brto_[a-f0-9]{24}\b/i,
  /\brcl_[a-f0-9]{24}\b/i,
];

/**
 * Evaluates whether the worker Responses relay runner may contact NanoCore.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options] Evaluation options.
 * @returns {{ config: Record<string, string | undefined>, enabled: boolean, reason: string }} Prerequisite result.
 */
export function evaluateWorkerResponsesRelayPrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const config = {
    codexImageRef: env.OPENKIT_L6_WORKER_RESPONSES_CODEX_IMAGE_REF ?? '',
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR ?? '',
    hostManifestDigest: env.OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST ?? '',
    nanoCoreUrl: env.OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL ?? '',
    opencodeImageRef: env.OPENKIT_L6_WORKER_RESPONSES_OPENCODE_IMAGE_REF ?? '',
    sessionCookie: env.OPENKIT_NANOCORE_SESSION_COOKIE,
    token: env.OPENKIT_NANOCORE_TOKEN,
  };

  if (env.OPENKIT_L6_WORKER_RESPONSES_RELAY !== '1') {
    return {
      config,
      enabled: false,
      reason:
        'set OPENKIT_L6_WORKER_RESPONSES_RELAY=1 to opt in to the worker Responses relay test',
    };
  }

  if (env.OPENKIT_L6_ALLOW_PROVIDER_QUOTA !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 to acknowledge provider usage',
    };
  }

  if (!HOST_MANIFEST_DIGEST_PATTERN.test(config.hostManifestDigest)) {
    return {
      config,
      enabled: false,
      reason:
        'set OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST to a 64-lowercase-hex host-manifest digest',
    };
  }

  if (!config.codexImageRef) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_WORKER_RESPONSES_CODEX_IMAGE_REF',
    };
  }

  if (!config.opencodeImageRef) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_WORKER_RESPONSES_OPENCODE_IMAGE_REF',
    };
  }

  if (!config.nanoCoreUrl) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL' };
  }

  if (!isAllowedNanoCoreUrl(config.nanoCoreUrl)) {
    return {
      config,
      enabled: false,
      reason:
        'set OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL to HTTPS, or pathless loopback HTTP, without userinfo',
    };
  }

  if (!config.evidenceDir) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_EVIDENCE_DIR' };
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
 * Asserts one product-safe worker Responses relay observation.
 *
 * @param {Record<string, any>} observation Workspace-selected AEP, capability, usage, and item evidence.
 * @returns {{ model: string, providerId: string }} Observed AEP gateway route identity.
 * @throws {Error} When the observation is not a gateway Responses relay for the selected agent image.
 */
export function assertWorkerResponsesRelay(observation) {
  assert(
    observation?.defaultAgentId === observation?.agentId,
    'Workspace defaultAgentId did not select the relay agent.'
  );
  const turnId = observation.turnId;
  const packageSnapshotId = observation.packageSnapshotId;
  assert(
    typeof turnId === 'string' && turnId.length > 0,
    'Relay observation is missing a turn id.'
  );
  assert(
    typeof packageSnapshotId === 'string' && packageSnapshotId.length > 0,
    'Relay observation is missing an AEP snapshot id.'
  );

  const aepRecord = (observation.aep?.items ?? []).find((item) => item?.turnId === turnId);
  assert(aepRecord, 'AEP snapshot missing for the selected worker turn.');
  assert(
    aepRecord.snapshotId === packageSnapshotId,
    'AEP snapshot id did not match the capability lineage.'
  );
  assert(aepRecord.snapshot?.llm?.mode === 'gateway', 'AEP LLM mode is not gateway.');
  assert(
    aepRecord.snapshot?.runtime?.image?.ref === observation.expectedImageRef,
    'AEP image identity did not match the selected worker image.'
  );
  const route = aepRecord.snapshot?.llm?.routes?.[0];
  assert(
    typeof route?.model === 'string' && route.model.length > 0,
    'AEP gateway route did not observe a model.'
  );
  assert(
    typeof route?.providerInstanceId === 'string' && route.providerInstanceId.length > 0,
    'AEP gateway route did not observe a provider.'
  );

  const calls = (observation.capabilityCalls ?? []).filter(
    (call) =>
      call?.turnId === turnId &&
      call?.capabilityId === 'llm.responses' &&
      call?.operation === 'responses' &&
      call?.serviceRef === 'worker-inference-gateway' &&
      call?.status === 'succeeded' &&
      call?.packageSnapshotId === packageSnapshotId
  );
  assert(
    calls.length >= 1,
    'Succeeded llm.responses worker-inference-gateway call was missing for the turn.'
  );

  const callIds = new Set(calls.map((call) => call.id));
  const usage = (observation.usageRecords ?? []).filter(
    (record) =>
      callIds.has(record?.capabilityCallId) &&
      typeof record?.source === 'string' &&
      record.source.startsWith(ADAPTER_REPORTED_USAGE_PREFIX)
  );
  assert(
    usage.length >= 1,
    'Adapter-reported usage was not linked to the Responses capability call.'
  );

  const assistantItems = (observation.threadItems ?? []).filter(
    (item) =>
      item?.turnId === turnId && item?.type === 'assistant-message' && item?.status === 'completed'
  );
  assert(assistantItems.length === 1, 'Turn did not collapse to one completed assistant message.');
  return { model: route.model, providerId: route.providerInstanceId };
}

/**
 * Asserts that passed relay evidence retains only the secret-safe allowlist.
 *
 * @param {Record<string, unknown>} record Evidence record.
 * @returns {void}
 * @throws {Error} When the record retains extra keys, incomplete assertions, or unsafe values.
 */
export function assertWorkerResponsesRelayEvidence(record) {
  assert(
    record && typeof record === 'object' && !Array.isArray(record),
    'Relay evidence is missing.'
  );
  const keys = Object.keys(record);
  for (const key of keys) {
    assert(EVIDENCE_ALLOWLIST.includes(key), `Relay evidence retained a forbidden key: ${key}`);
  }
  for (const key of EVIDENCE_ALLOWLIST) {
    assert(key in record, `Relay evidence is missing required key: ${key}`);
  }
  assert(record.status === 'passed', 'Relay evidence status is not passed.');
  const assertions = record.assertions;
  assert(
    assertions && typeof assertions === 'object' && !Array.isArray(assertions),
    'Relay assertions are missing.'
  );
  for (const key of Object.keys(assertions)) {
    assert(
      EVIDENCE_ASSERTION_KEYS.includes(key),
      `Relay evidence retained a forbidden assertion: ${key}`
    );
  }
  for (const key of EVIDENCE_ASSERTION_KEYS) {
    assert(assertions[key] === true, `Relay evidence assertion ${key} is not true.`);
  }
  assertNoPublicSecretLeak(record);
  assertSecretSafeEvidenceValues(record);
}

/**
 * Runs the opt-in worker Responses relay L3 test for Codex and OpenCode images.
 *
 * Enabled runs settle all workspace-review cleanup promises, then write one 0600 RESULT or FAILURE file. Cleanup rejection turns an otherwise passed attempt into the fixed generic non-PASS terminal result.
 *
 * @param {{ childEntrypoint?: string, clients?: { admin: Record<string, any>, core: Record<string, any> }, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, killProcess?: typeof process.kill, spawnProcess?: typeof spawn, stdout?: (message: string) => void, timeoutMs?: number }} [options] Runner options.
 * @returns {Promise<Record<string, unknown>>} Skip result or secret-safe passed evidence.
 */
export async function runWorkerResponsesRelayRealProviderTest(options = {}) {
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateWorkerResponsesRelayPrerequisites(options);

  if (!prerequisites.enabled) {
    stdout(`SKIP worker Responses relay L3 test: ${prerequisites.reason}`);
    return {
      reason: prerequisites.reason,
      status: 'skipped',
    };
  }

  const timeoutMs = resolveRelayTimeoutMs(options.timeoutMs);
  prepareEvidenceDirectory(prerequisites.config.evidenceDir, RELAY_EVIDENCE_FILES);
  const clients =
    options.clients ?? (await createRelayClients(prerequisites.config, options.fetchImpl));
  const reviewIds = new Set();
  const effectfulTimeout = { unknown: false };
  let workspaceId = '';
  let passedEvidence = null;
  let runError;

  try {
    const diagnostics = await awaitRelayDeadline(clients.admin.app.getDiagnostics(), timeoutMs);
    assert(
      diagnostics.boot?.acceptingProductWork === true,
      'Target NanoCore is not accepting product work.'
    );

    const workspace = await awaitRelayDeadline(
      clients.core.core.createWorkspace({
        name: 'Worker Responses relay acceptance',
      }),
      timeoutMs,
      effectfulTimeout
    );
    workspaceId = workspace.id;
    assert(
      typeof workspaceId === 'string' && workspaceId.length > 0,
      'Workspace id was not returned.'
    );

    const codex = await runSelectedAgentRelay(clients.core, {
      agentId: CODEX_AGENT_ID,
      effectfulTimeout,
      expectedImageRef: prerequisites.config.codexImageRef,
      reviewIds,
      timeoutMs,
      workspaceId,
    });
    const opencode = await runSelectedAgentRelay(clients.core, {
      agentId: OPENCODE_AGENT_ID,
      effectfulTimeout,
      expectedImageRef: prerequisites.config.opencodeImageRef,
      reviewIds,
      timeoutMs,
      workspaceId,
    });
    assert(
      codex.model === opencode.model && codex.providerId === opencode.providerId,
      'Observed AEP gateway routes did not agree across selected worker images.'
    );

    const evidence = {
      assertions: {
        codexResponsesRelay: true,
        opencodeResponsesRelay: true,
      },
      codexImageRef: prerequisites.config.codexImageRef,
      hostManifestDigest: prerequisites.config.hostManifestDigest,
      model: codex.model,
      opencodeImageRef: prerequisites.config.opencodeImageRef,
      providerId: codex.providerId,
      status: 'passed',
    };
    assertWorkerResponsesRelayEvidence(evidence);
    assertNoPublicSecretLeak(evidence, [
      prerequisites.config.token,
      prerequisites.config.sessionCookie,
    ]);
    passedEvidence = evidence;
  } catch (error) {
    runError = error;
  }

  let cleanup = RELAY_CLEANUP.succeeded;
  if (reviewIds.size > 0) {
    const cleanupRejected = await settleRelayReviewCleanup(clients.core, workspaceId, reviewIds);
    cleanup = cleanupRejected ? RELAY_CLEANUP.failed : RELAY_CLEANUP.succeeded;
  }
  if (effectfulTimeout.unknown || (workspaceId && reviewIds.size === 0)) {
    cleanup = RELAY_CLEANUP.unknown;
  }
  if (!runError && cleanup === RELAY_CLEANUP.succeeded && passedEvidence) {
    writeExclusiveEvidenceFile(
      join(prerequisites.config.evidenceDir, RESULT_FILE),
      `${JSON.stringify(passedEvidence, null, 2)}\n`
    );
    stdout(`PASS worker Responses relay L3 test evidence: ${prerequisites.config.evidenceDir}`);
    return passedEvidence;
  }

  writeRelayFailureEvidence(prerequisites.config, {
    cleanup,
    kind: isRelayAssertionError(runError)
      ? RELAY_FAILURE_KIND.assertion
      : isRelayTimeoutError(runError)
        ? RELAY_FAILURE_KIND.timeout
        : runError
          ? RELAY_FAILURE_KIND.unknown
          : undefined,
  });
  if (isRelayAssertionError(runError)) {
    throw runError;
  }
  throw new Error(PUBLIC_FAILURE_REASON);
}

/**
 * Selects one Workspace default agent and asserts its product-safe Responses relay.
 *
 * @param {Record<string, any>} client Composed Core Client.
 * @param {{ agentId: string, effectfulTimeout: { unknown: boolean }, expectedImageRef: string, reviewIds: Set<string>, timeoutMs: number, workspaceId: string }} input Agent selection.
 * @returns {Promise<{ model: string, providerId: string }>} Observed AEP gateway route identity.
 */
async function runSelectedAgentRelay(client, input) {
  const workspace = await awaitRelayDeadline(
    client.core.updateWorkspace(input.workspaceId, {
      defaults: { defaultAgentId: input.agentId },
    }),
    input.timeoutMs,
    input.effectfulTimeout
  );
  assert(
    workspace.defaults?.defaultAgentId === input.agentId,
    'Workspace defaultAgentId was not updated to the selected relay agent.'
  );

  const thread = await awaitRelayDeadline(
    client.core.createThread({
      name: `Worker Responses relay ${input.agentId}`,
      workspaceId: input.workspaceId,
    }),
    input.timeoutMs,
    input.effectfulTimeout
  );
  const threadId = thread.id;
  assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

  const task = await awaitRelayDeadline(
    client.app.startTaskMode(input.workspaceId, threadId, {
      input: RELAY_TASK_INPUT,
    }),
    input.timeoutMs,
    input.effectfulTimeout
  );
  for (const reviewId of Array.isArray(task.evidence?.reviewIds) ? task.evidence.reviewIds : []) {
    if (typeof reviewId === 'string' && reviewId.length > 0) {
      input.reviewIds.add(reviewId);
    }
  }
  assert(task.state !== 'escalated-to-goal', 'Task Mode escalated a bounded Responses relay task.');
  assert(
    typeof task.turn?.id === 'string' && task.turn.id.length > 0,
    'Task Mode response did not include a turn id.'
  );
  assert(task.state === 'completed', `Task Mode returned a non-acceptance state: ${task.state}`);

  const [threadResponse, aepRead, usage] = await awaitRelayDeadline(
    Promise.all([
      client.core.listThreadItems(input.workspaceId, threadId),
      client.app.listAgentEnvironmentPackageSnapshots(input.workspaceId),
      client.app.getCapabilityUsage(input.workspaceId),
    ]),
    input.timeoutMs
  );
  const aepRecord = (aepRead?.items ?? []).find((item) => item?.turnId === task.turn.id);
  return assertWorkerResponsesRelay({
    aep: aepRead,
    agentId: input.agentId,
    capabilityCalls: usage?.capabilityCalls ?? [],
    defaultAgentId: workspace.defaults.defaultAgentId,
    expectedImageRef: input.expectedImageRef,
    packageSnapshotId: aepRecord?.snapshotId,
    threadItems: threadResponse?.items ?? [],
    turnId: task.turn.id,
    usageRecords: usage?.usageRecords ?? [],
  });
}

/**
 * Creates Core Clients that use the injected fetch seam.
 *
 * @param {Record<string, string | undefined>} config Enabled runner config.
 * @param {typeof fetch | undefined} fetchImpl Optional fetch injection.
 * @returns {Promise<{ admin: Record<string, any>, core: Record<string, any> }>} Deployment-admin and product clients.
 */
async function createRelayClients(config, fetchImpl) {
  assertBuilt(coreClientDist);
  const { createCoreClient } = await import(pathToFileURL(coreClientDist).href);
  const clientOptions = {
    baseUrl: config.nanoCoreUrl,
    fetch: fetchImpl ?? fetch,
  };
  if (!config.token && !config.sessionCookie) {
    const client = createCoreClient(clientOptions);
    return { admin: client, core: client };
  }

  return {
    admin: createCoreClient({
      ...clientOptions,
      headers: authHeaders(config.token),
    }),
    core: createCoreClient({
      ...clientOptions,
      headers: sessionCookieHeaders(config.sessionCookie),
    }),
  };
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
 * Returns whether a NanoCore URL is an origin-only HTTPS or pathless loopback HTTP target.
 *
 * @param {string} value Candidate NanoCore base URL.
 * @returns {boolean} True when remote credential transport is HTTPS and loopback HTTP has no userinfo, path, query, or fragment.
 */
function isAllowedNanoCoreUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.search !== '' || url.hash !== '') {
    return false;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return false;
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]';
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && loopback;
}

/**
 * Recursively rejects host paths, file URLs, native ids, and secret-shaped strings in evidence values.
 *
 * @param {unknown} value Evidence value.
 * @returns {void}
 * @throws {Error} When a forbidden value is present.
 */
function assertSecretSafeEvidenceValues(value) {
  if (typeof value === 'string') {
    assert(
      FORBIDDEN_EVIDENCE_VALUE_PATTERNS.every((pattern) => !pattern.test(value)),
      'Relay evidence retained a host path, file URL, native id, or secret-shaped value.'
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertSecretSafeEvidenceValues(entry);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      assertSecretSafeEvidenceValues(entry);
    }
  }
}

/**
 * Writes one secret-safe failure record with fixed public attribution.
 *
 * Kind is present only when a product lifecycle failure exists. Cleanup is recorded independently. Cleanup-only failures omit kind. Timeout uses kind timeout. A timed-out effectful NanoCore request whose response is unavailable records cleanup unknown.
 *
 * @param {Record<string, string | undefined>} config Enabled runner config.
 * @param {{ cleanup: 'failed' | 'succeeded' | 'unknown', kind?: 'assertion' | 'timeout' | 'unknown' }} attribution Fixed public attribution.
 * @returns {void}
 */
function writeRelayFailureEvidence(config, attribution) {
  const failure = {
    cleanup: attribution.cleanup,
    reason: PUBLIC_FAILURE_REASON,
    status: 'failed',
  };
  if (
    attribution.kind === RELAY_FAILURE_KIND.assertion ||
    attribution.kind === RELAY_FAILURE_KIND.timeout ||
    attribution.kind === RELAY_FAILURE_KIND.unknown
  ) {
    failure.kind = attribution.kind;
  }
  assertNoPublicSecretLeak(failure, [config.token, config.sessionCookie]);
  assertSecretSafeEvidenceValues(failure);
  writeExclusiveEvidenceFile(
    join(config.evidenceDir, FAILURE_FILE),
    `${JSON.stringify(failure, null, 2)}\n`
  );
}

/**
 * Settles Task Mode review cleanup and reports whether any attempt rejected.
 *
 * @param {Record<string, any>} client Composed Core Client.
 * @param {string} workspaceId Workspace that owns the reviews.
 * @param {Set<string>} reviewIds Unique review ids observed during the run.
 * @returns {Promise<boolean>} True when at least one cleanup promise rejected.
 */
async function settleRelayReviewCleanup(client, workspaceId, reviewIds) {
  if (!workspaceId || reviewIds.size === 0) {
    return false;
  }
  const outcomes = await Promise.allSettled(
    [...reviewIds].map((reviewId) =>
      client.app.submitWorkspaceSyncReviewDecision(workspaceId, reviewId, {
        decision: 'rejected',
        requestId: randomUUID(),
      })
    )
  );
  return outcomes.some((outcome) => outcome.status === 'rejected');
}

/**
 * Resolves the injected or fixed relay deadline.
 *
 * @param {unknown} timeoutMs Injected deadline.
 * @returns {number} Positive deadline in milliseconds.
 */
function resolveRelayTimeoutMs(timeoutMs) {
  if (typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  return WORKER_RESPONSES_RELAY_TIMEOUT_MS;
}

/**
 * Bounds one diagnostics, workspace, thread, Task, or readback wait.
 *
 * Cleanup is not raced; the CLI process supervisor owns the outer bound for a hung review rejection. Effectful NanoCore requests whose response never arrives mark cleanup unknown because an external write may already exist.
 *
 * @param {Promise<T>} work Wait to bound.
 * @param {number} timeoutMs Positive deadline.
 * @param {{ unknown: boolean }} [effectfulTimeout] Attribution bag for timed-out effectful requests.
 * @returns {Promise<T>} Settled work.
 * @throws {Error} When the deadline expires first.
 * @template T
 */
async function awaitRelayDeadline(work, timeoutMs, effectfulTimeout) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error(PUBLIC_FAILURE_REASON);
          error.code = RELAY_TIMEOUT_ERROR_CODE;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut && effectfulTimeout) {
      effectfulTimeout.unknown = true;
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Runs the real worker Responses relay test in an isolated Unix process group with a hard deadline.
 *
 * @param {{ childEntrypoint?: string, env?: Record<string, string | undefined>, killProcess?: typeof process.kill, spawnProcess?: typeof spawn, stdout?: (message: string) => void, timeoutMs?: number }} [options] Supervisor options.
 * @returns {Promise<Record<string, unknown>>} Skip result or supervised completion.
 */
export async function runWorkerResponsesRelayCli(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateWorkerResponsesRelayPrerequisites({ env });
  if (!prerequisites.enabled) {
    return runWorkerResponsesRelayRealProviderTest({ ...options, env, stdout });
  }

  prepareEvidenceDirectory(prerequisites.config.evidenceDir, RELAY_EVIDENCE_FILES);
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
  assert(typeof child.pid === 'number', 'Worker Responses relay child process did not start.');
  const outcome =
    typeof options.timeoutMs === 'number' &&
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs > 0
      ? await waitForChildOrDeadline(child, options.timeoutMs, options.killProcess ?? process.kill)
      : await waitForChildOrDeadline(
          child,
          WORKER_RESPONSES_RELAY_TIMEOUT_MS,
          options.killProcess ?? process.kill
        );

  if (outcome.kind === 'timeout') {
    normalizeParentRelayFailure(prerequisites.config, {
      cleanup: RELAY_CLEANUP.unknown,
      kind: RELAY_FAILURE_KIND.timeout,
    });
    throw new Error(PUBLIC_FAILURE_REASON);
  }
  if (outcome.exitCode !== 0) {
    normalizeParentRelayFailure(prerequisites.config, {
      cleanup: RELAY_CLEANUP.unknown,
      kind: RELAY_FAILURE_KIND.unknown,
    });
    throw new Error(PUBLIC_FAILURE_REASON);
  }

  const resultPath = join(prerequisites.config.evidenceDir, RESULT_FILE);
  try {
    if (!existsSync(resultPath) || (statSync(resultPath).mode & 0o777) !== 0o600) {
      throw new Error(PUBLIC_FAILURE_REASON);
    }
    const record = JSON.parse(readFileSync(resultPath, 'utf8'));
    assertWorkerResponsesRelayEvidence(record);
    assertNoPublicSecretLeak(record, [
      prerequisites.config.token,
      prerequisites.config.sessionCookie,
    ]);
  } catch {
    normalizeParentRelayFailure(prerequisites.config, {
      cleanup: RELAY_CLEANUP.unknown,
      kind: RELAY_FAILURE_KIND.unknown,
    });
    throw new Error(PUBLIC_FAILURE_REASON);
  }
  return { status: 'passed' };
}

/**
 * Removes the exact attempt RESULT, then exclusively creates or preserves FAILURE.
 *
 * @param {Record<string, string | undefined>} config Enabled runner config.
 * @param {{ cleanup: 'failed' | 'succeeded' | 'unknown', kind?: 'assertion' | 'timeout' | 'unknown' }} attribution Fixed public attribution.
 * @returns {void}
 */
function normalizeParentRelayFailure(config, attribution) {
  const resultPath = join(config.evidenceDir, RESULT_FILE);
  try {
    unlinkSync(resultPath);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
      // Still normalize to FAILURE; do not recurse or touch other files.
    }
  }
  tryWriteParentRelayFailureEvidence(config, attribution);
}

/**
 * Writes parent FAILURE evidence only when the supervised child did not already persist one.
 *
 * @param {Record<string, string | undefined>} config Enabled runner config.
 * @param {{ cleanup: 'failed' | 'succeeded' | 'unknown', kind?: 'assertion' | 'timeout' | 'unknown' }} attribution Fixed public attribution.
 * @returns {void}
 */
function tryWriteParentRelayFailureEvidence(config, attribution) {
  try {
    writeRelayFailureEvidence(config, attribution);
  } catch {
    // The child-owned exclusive file remains authoritative.
  }
}

/**
 * Fails when a relay invariant is falsy.
 *
 * @param {unknown} condition Condition that must be truthy.
 * @param {string} message Product-safe failure message.
 * @returns {void}
 * @throws {Error} When the condition is falsy.
 */
function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = RELAY_ASSERTION_ERROR_CODE;
    throw error;
  }
}

/**
 * Returns whether a failure is a product-safe relay assertion the caller may observe.
 *
 * @param {unknown} error Caught failure.
 * @returns {error is Error} True when the error is a coded relay assertion.
 */
function isRelayAssertionError(error) {
  return Boolean(error) && error instanceof Error && error.code === RELAY_ASSERTION_ERROR_CODE;
}

/**
 * Returns whether a failure is the bounded relay deadline.
 *
 * @param {unknown} error Caught failure.
 * @returns {error is Error} True when the error is the coded relay timeout.
 */
function isRelayTimeoutError(error) {
  return Boolean(error) && error instanceof Error && error.code === RELAY_TIMEOUT_ERROR_CODE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === SUPERVISED_CHILD_ARG) {
    runWorkerResponsesRelayRealProviderTest().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  } else {
    runWorkerResponsesRelayCli().catch((error) => {
      const message = isRelayAssertionError(error) ? error.message : PUBLIC_FAILURE_REASON;
      try {
        assertNoPublicSecretLeak(message);
        console.error(message);
      } catch {
        console.error(PUBLIC_FAILURE_REASON);
      }
      process.exitCode = 1;
    });
  }
}
