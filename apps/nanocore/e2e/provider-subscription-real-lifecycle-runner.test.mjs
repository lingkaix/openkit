// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertLifecycleOutcomes,
  evaluateRealLifecyclePrerequisites,
  readCodexCredential,
  runProviderSubscriptionRealLifecycleTest,
  runPublicSequence,
  summarizeStream,
} from './provider-subscription-real-lifecycle-runner.mjs';

const MODEL = 'openai-codex/gpt-5.6-sol';
const PROFILE = 'real-lifecycle-openai-codex';
const SLOT = 'real-lifecycle-slot';
const PROVIDER = 'openai-codex';

/**
 * Builds one App API account descriptor with the documented required properties.
 *
 * Shapes come from `apps/nanocore/openapi/app-api.openapi.json`, not from prose.
 *
 * @param {string} status Public account status.
 * @returns {Record<string, unknown>} Account descriptor.
 */
function accountDescriptor(status) {
  return {
    accountLabel: null,
    accountSlotId: SLOT,
    boundProviderIds: [PROFILE],
    createdAt: '2026-07-30T00:00:00.000Z',
    displayName: 'OpenAI Codex',
    planLabel: null,
    status,
    subscriptionProviderId: PROVIDER,
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

const SSE_OK = [
  'data: {"type":"response.output_text.delta","delta":"OK"}',
  '',
  'data: {"type":"response.completed"}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const POST_LOGOUT_BODY = {
  error: {
    code: 'gateway_provider_authentication_failed',
    message: 'Provider authentication failed.',
    type: 'provider_error',
  },
};

/**
 * Builds a fetcher that answers the documented sequence in order.
 *
 * It asserts each request path as it is consumed, so a reordered or extra call
 * fails the test rather than silently reading the wrong response.
 *
 * @param {Array<[string, number, unknown]>} script Ordered path suffix, status, and body.
 * @returns {{ fetcher: typeof fetch, remaining: () => number }} Fetcher and drain check.
 */
function scriptedFetcher(script) {
  let index = 0;
  const fetcher = async (url) => {
    assert.ok(index < script.length, `unexpected extra request: ${url}`);
    const [suffix, status, body] = script[index];
    index += 1;
    assert.ok(String(url).endsWith(suffix), `expected ${suffix}, received ${url}`);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, text: async () => text };
  };
  return { fetcher, remaining: () => script.length - index };
}

const HAPPY_SCRIPT = () => [
  [
    '/api/app/provider-subscriptions',
    200,
    {
      providers: [
        {
          displayName: 'OpenAI Codex',
          loginModes: ['device_code'],
          quotaCapability: 'available',
          subscriptionProviderId: PROVIDER,
        },
      ],
    },
  ],
  [
    `/provider-subscriptions/${PROVIDER}/accounts`,
    200,
    { accounts: [accountDescriptor('logged_in')] },
  ],
  [`/accounts/${SLOT}/status`, 200, accountDescriptor('logged_in')],
  ['/api/app/diagnostics', 200, { gateway: { defaultModelId: MODEL } }],
  ['/v1/responses', 200, SSE_OK],
  [
    `/accounts/${SLOT}/quota`,
    200,
    {
      accountSlotId: SLOT,
      availability: 'available',
      observedAt: '2026-07-30T00:00:00.000Z',
      subscriptionProviderId: PROVIDER,
    },
  ],
  [`/accounts/${SLOT}/logout`, 200, accountDescriptor('logged_out')],
  ['/v1/responses', 401, POST_LOGOUT_BODY],
  [`/accounts/${SLOT}/status`, 200, accountDescriptor('logged_out')],
];

test('keeps the fake real-use provider inventory Codex-only', () => {
  assert.deepEqual(
    HAPPY_SCRIPT()[0][2].providers.map(({ subscriptionProviderId }) => subscriptionProviderId),
    [PROVIDER]
  );
});

const PASSING_OBSERVATIONS = Object.freeze({
  accountListed: true,
  diagnostics: {
    model: 'openai-codex/gpt-5.6-sol',
    status: 200,
  },
  finalStatus: { status: 200, value: 'logged_out' },
  inference: {
    completed: true,
    errorEvents: 0,
    eventsObserved: 2,
    outputNonEmpty: true,
    status: 200,
  },
  initialStatus: { status: 200, value: 'logged_in' },
  logout: { status: 200, value: 'logged_out' },
  postLogout: {
    bodyMatchesExpected: true,
    errorCode: 'gateway_provider_authentication_failed',
    status: 401,
  },
  providerListed: true,
  quota: { availability: 'available', status: 200 },
});

/**
 * Builds a temporary owner-only Codex auth source.
 *
 * @param {Record<string, unknown>} overrides Token overrides.
 * @param {number} expSeconds Token expiry in epoch seconds.
 * @returns {{ cleanup: () => void, path: string }} Temporary source handle.
 */
function writeAuthSource(overrides = {}, expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-e2e-auth-'));
  const path = join(root, 'auth.json');
  const segment = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const accountId = 'acct-123';
  const payload = {
    exp: expSeconds,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  };
  writeFileSync(
    path,
    JSON.stringify({
      tokens: {
        access_token: `${segment({ alg: 'none' })}.${segment(payload)}.${segment('sig')}`,
        account_id: accountId,
        refresh_token: 'refresh-value',
        ...overrides,
      },
    }),
    { mode: 0o600 }
  );
  return { cleanup: () => rmSync(root, { force: true, recursive: true }), path };
}

/**
 * Supplies the accepted L3 environment plus the retired values needed to keep
 * pre-repair runner-path tests focused on their own predicates.
 *
 * @param {string} authSourcePath Temporary fake credential source.
 * @param {string} evidenceDir Temporary evidence directory.
 * @returns {Record<string, string>} Runner environment.
 */
function enabledRunnerEnv(authSourcePath, evidenceDir) {
  return {
    OPENKIT_E2E_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_E2E_CODEX_AUTH_PATH: authSourcePath,
    OPENKIT_E2E_EVIDENCE_DIR: evidenceDir,
    OPENKIT_E2E_LIFECYCLE_PORT: '4319',
    OPENKIT_E2E_REAL_SUBSCRIPTION_LIFECYCLE: '1',
    OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_L6_CODEX_AUTH_PATH: authSourcePath,
    OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
    OPENKIT_L6_LIFECYCLE_PORT: '4319',
    OPENKIT_L6_REAL_SUBSCRIPTION_LIFECYCLE: '1',
  };
}

/**
 * Captures the source identity and write-sensitive metadata without reading a credential value.
 *
 * @param {string} path Temporary fake credential source.
 * @returns {Record<string, number>} Comparable source metadata.
 */
function sourceMetadata(path) {
  const stat = statSync(path);
  return {
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    gid: stat.gid,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    uid: stat.uid,
  };
}

/**
 * Supplies fake HTTP and process-group seams for complete lifecycle runs.
 *
 * @param {Array<[string, number, unknown]>} script Ordered public response script.
 * @returns {{ options: Record<string, unknown>, remaining: () => number, runRoots: string[] }} Fake runner seams.
 */
function passingLifecycleSeams(script) {
  const { fetcher, remaining } = scriptedFetcher(script);
  const runRoots = [];
  let nextPid = 9_700;
  return {
    options: {
      fetchImpl: async (url) =>
        String(url).endsWith('/api/health')
          ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
          : fetcher(url),
      killProcess: (_target, signal) => {
        if (signal === 'SIGTERM') return true;
        if (signal === 0)
          throw Object.assign(new Error('process group not found'), { code: 'ESRCH' });
        throw new Error(`unexpected cleanup signal: ${signal}`);
      },
      prepareCredential: async () => {},
      spawnProcess: (_command, _args, options) => {
        nextPid += 1;
        runRoots.push(options.env.TMPDIR);
        return { pid: nextPid, ref: () => {} };
      },
      stdout: () => {},
    },
    remaining,
    runRoots,
  };
}

/**
 * Builds the contract's exact failed-run evidence shape.
 *
 * @param {Record<string, unknown>} overrides Scenario-specific facts.
 * @returns {Record<string, unknown>} Exact nine-field failed-run summary.
 */
function failedRunSummary(overrides) {
  return {
    cleanupCompleted: true,
    completed: null,
    errorEvents: null,
    eventsObserved: null,
    outputNonEmpty: null,
    phase: 'setup',
    runIndex: 1,
    streamHttpStatus: null,
    temporaryRootRemoved: true,
    terminalFailureCode: 'unknown',
    ...overrides,
  };
}

/**
 * Reads one fake runner's terminal evidence.
 *
 * @param {string} evidenceDir Fake evidence directory.
 * @returns {Record<string, any>} Parsed runner evidence.
 */
function readRunnerEvidence(evidenceDir) {
  return JSON.parse(
    readFileSync(join(evidenceDir, 'provider-subscription-real-lifecycle-result.json'), 'utf8')
  );
}

test('C05 response-text rejection retains the observed HTTP status and null terminal facts', async () => {
  const bodyReadFailure = new Error('response body read failure');
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-response-text-rejection-'));
  const authPlaceholderPath = join(testRoot, 'auth-placeholder');
  const evidenceDir = join(testRoot, 'evidence');
  const { fetcher, remaining } = scriptedFetcher(HAPPY_SCRIPT().slice(0, 4));
  let inferenceRequestCount = 0;
  let runRoot;

  writeFileSync(authPlaceholderPath, 'not credential content', { mode: 0o600 });
  try {
    const outcome = await runProviderSubscriptionRealLifecycleTest({
      env: {
        ...enabledRunnerEnv(authPlaceholderPath, evidenceDir),
        OPENKIT_E2E_LIFECYCLE_RUN_COUNT: '1',
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/api/health')) {
          return { ok: true, status: 200, text: async () => '{"status":"ok"}' };
        }
        if (String(url).endsWith('/v1/responses')) {
          inferenceRequestCount += 1;
          return {
            status: 200,
            text: async () => {
              throw bodyReadFailure;
            },
          };
        }
        return fetcher(url);
      },
      killProcess: (_target, signal) => {
        if (signal === 'SIGTERM') return true;
        if (signal === 0)
          throw Object.assign(new Error('process group not found'), { code: 'ESRCH' });
        throw new Error(`unexpected cleanup signal: ${signal}`);
      },
      prepareCredential: async () => {},
      spawnProcess: (_command, _args, options) => {
        runRoot = options.env.TMPDIR;
        return { pid: 9_903, ref: () => {} };
      },
      stdout: () => {},
    }).then(
      () => ({ error: undefined }),
      (error) => ({ error })
    );
    const evidence = readRunnerEvidence(evidenceDir);

    assert.deepEqual(
      {
        inferenceRequestCount,
        propagatedOriginalError: outcome.error === bodyReadFailure,
        remainingRequests: remaining(),
        runRootRemoved: !existsSync(runRoot),
        summary: evidence.runs[0],
      },
      {
        inferenceRequestCount: 1,
        propagatedOriginalError: true,
        remainingRequests: 0,
        runRootRemoved: true,
        summary: failedRunSummary({
          phase: 'public-lifecycle',
          streamHttpStatus: 200,
        }),
      }
    );
  } finally {
    if (runRoot) rmSync(runRoot, { force: true, recursive: true });
    rmSync(testRoot, { force: true, recursive: true });
  }
});

test('C05 evidence contract: defaults to two runs and permits only the exact single-run override', async () => {
  for (const [runCount, expectedRunCount, expectedRemainingRequests] of [
    [undefined, 2, 0],
    ['1', 1, HAPPY_SCRIPT().length],
  ]) {
    const source = writeAuthSource();
    const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-run-count-'));
    const evidenceDir = join(testRoot, 'evidence');
    const { options, remaining, runRoots } = passingLifecycleSeams([
      ...HAPPY_SCRIPT(),
      ...HAPPY_SCRIPT(),
    ]);
    let prepareCredentialCount = 0;
    const env = enabledRunnerEnv(source.path, evidenceDir);
    if (runCount !== undefined) env.OPENKIT_E2E_LIFECYCLE_RUN_COUNT = runCount;

    try {
      const result = await runProviderSubscriptionRealLifecycleTest({
        ...options,
        env,
        prepareCredential: async () => {
          prepareCredentialCount += 1;
        },
      });
      assert.equal(result.runCount, expectedRunCount);
      assert.equal(remaining(), expectedRemainingRequests);
      assert.equal(prepareCredentialCount, expectedRunCount);
      assert.equal(runRoots.length, expectedRunCount);
      assert.deepEqual(
        runRoots.map((runRoot) => existsSync(runRoot)),
        Array(expectedRunCount).fill(false)
      );
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
      source.cleanup();
    }
  }
});

test('C05 evidence contract: rejects every non-1 explicit run count before auth content, fetch, or spawn', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-invalid-run-count-'));
  const source = writeAuthSource();
  const observed = [];
  for (const runCount of ['', '0', '01', '1 ', '2', '-1', 'true']) {
    const evidenceDir = join(testRoot, `evidence-${observed.length}`);
    let fetchCount = 0;
    let prepareCredentialCount = 0;
    let spawnCount = 0;

    const outcome = await runProviderSubscriptionRealLifecycleTest({
      env: {
        ...enabledRunnerEnv(source.path, evidenceDir),
        OPENKIT_E2E_LIFECYCLE_RUN_COUNT: runCount,
      },
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error('fetch must not run');
      },
      prepareCredential: async () => {
        prepareCredentialCount += 1;
        throw new Error('credential preparation must not run');
      },
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('spawn must not run');
      },
      stdout: () => {},
    }).then(
      () => ({ rejected: false }),
      () => ({ rejected: true })
    );
    observed.push({
      fetchCount,
      prepareCredentialCount,
      rejected: outcome.rejected,
      runCount,
      spawnCount,
    });
  }

  try {
    assert.deepEqual(
      observed,
      ['', '0', '01', '1 ', '2', '-1', 'true'].map((runCount) => ({
        fetchCount: 0,
        prepareCredentialCount: 0,
        rejected: true,
        runCount,
        spawnCount: 0,
      }))
    );
  } finally {
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('C05 evidence contract: preserves the first lifecycle failure after cleanup and writes one exact redacted summary', async () => {
  const lifecycleErrorCanary = 'first-lifecycle-error-canary';
  const cleanupErrorCanary = 'later-cleanup-error-canary';
  const lifecycleFailure = new Error(lifecycleErrorCanary);
  const cleanupFailure = new Error(cleanupErrorCanary);
  const rawSseCanary = 'raw-sse-canary';
  const providerPrivateCanary = 'provider-private-canary';
  const durableRecordCanary = 'durable-record-canary';
  const rawResponseCanary = 'raw-response-canary';
  const source = writeAuthSource();
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-failure-summary-'));
  const evidenceDir = join(testRoot, 'evidence');
  const resultPath = join(evidenceDir, 'provider-subscription-real-lifecycle-result.json');
  const script = HAPPY_SCRIPT();
  script[0][2].providers[0].providerPrivate = providerPrivateCanary;
  script[1][2].accounts[0].durableRecord = durableRecordCanary;
  script[4][2] = [
    `data: {"type":"response.output_text.delta","delta":"${rawSseCanary}"}`,
    '',
    'data: {"type":"response.completed"}',
    '',
  ].join('\n');
  script[5][2].rawProviderResponse = rawResponseCanary;
  const { fetcher } = scriptedFetcher(script);
  let runRoot;
  let statusReads = 0;

  try {
    const outcome = await runProviderSubscriptionRealLifecycleTest({
      env: enabledRunnerEnv(source.path, evidenceDir),
      fetchImpl: async (url) => {
        if (String(url).endsWith('/api/health')) {
          return { ok: true, status: 200, text: async () => '{"status":"ok"}' };
        }
        if (String(url).endsWith(`/accounts/${SLOT}/status`)) {
          statusReads += 1;
          if (statusReads === 2) throw lifecycleFailure;
        }
        return fetcher(url);
      },
      killProcess: (_target, signal) => {
        if (signal === 'SIGTERM') throw cleanupFailure;
        throw new Error(`unexpected cleanup signal: ${signal}`);
      },
      prepareCredential: async () => {},
      spawnProcess: (_command, _args, options) => {
        runRoot = options.env.TMPDIR;
        return { pid: 9_801, ref: () => {} };
      },
      stdout: () => {},
    }).then(
      () => ({ error: undefined }),
      (error) => ({ error })
    );
    const evidenceText = readFileSync(resultPath, 'utf8');
    const evidence = JSON.parse(evidenceText);

    assert.deepEqual(
      {
        evidenceMode: statSync(resultPath).mode & 0o777,
        propagatedFirstFailure: outcome.error === lifecycleFailure,
        runRootRemoved: !existsSync(runRoot),
        summary: evidence.runs[0],
      },
      {
        evidenceMode: 0o600,
        propagatedFirstFailure: true,
        runRootRemoved: true,
        summary: failedRunSummary({
          cleanupCompleted: false,
          completed: true,
          errorEvents: false,
          eventsObserved: 2,
          outputNonEmpty: true,
          phase: 'public-lifecycle',
          streamHttpStatus: 200,
        }),
      }
    );
    for (const prohibited of [
      lifecycleErrorCanary,
      cleanupErrorCanary,
      rawSseCanary,
      providerPrivateCanary,
      durableRecordCanary,
      rawResponseCanary,
      'Reply with only OK.',
      'refresh-value',
      'acct-123',
      source.path,
      runRoot,
    ]) {
      assert.equal(evidenceText.includes(prohibited), false, `evidence retained ${prohibited}`);
    }
  } finally {
    if (runRoot) rmSync(runRoot, { force: true, recursive: true });
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('C05 evidence contract: reports credential and cleanup-first phase semantics', async () => {
  const credentialSource = writeAuthSource({ access_token: 'credential-secret-canary' });
  const credentialRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-credential-phase-'));
  const credentialEvidenceDir = join(credentialRoot, 'evidence');
  const cleanupSource = writeAuthSource();
  const cleanupRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-cleanup-phase-'));
  const cleanupEvidenceDir = join(cleanupRoot, 'evidence');
  const cleanupErrorCanary = 'cleanup-first-error-canary';
  const cleanupFailure = new Error(cleanupErrorCanary);
  const { options } = passingLifecycleSeams(HAPPY_SCRIPT());
  let cleanupRunRoot;

  try {
    const credentialOutcome = await runProviderSubscriptionRealLifecycleTest({
      env: enabledRunnerEnv(credentialSource.path, credentialEvidenceDir),
      stdout: () => {},
    }).then(
      () => ({ rejected: false }),
      () => ({ rejected: true })
    );
    const cleanupOutcome = await runProviderSubscriptionRealLifecycleTest({
      ...options,
      env: enabledRunnerEnv(cleanupSource.path, cleanupEvidenceDir),
      killProcess: (_target, signal) => {
        if (signal === 'SIGTERM') throw cleanupFailure;
        throw new Error(`unexpected cleanup signal: ${signal}`);
      },
      spawnProcess: (_command, _args, spawnOptions) => {
        cleanupRunRoot = spawnOptions.env.TMPDIR;
        return { pid: 9_901, ref: () => {} };
      },
    }).then(
      () => ({ error: undefined }),
      (error) => ({ error })
    );
    const credentialEvidence = readRunnerEvidence(credentialEvidenceDir);
    const cleanupEvidence = readRunnerEvidence(cleanupEvidenceDir);

    assert.deepEqual(
      {
        cleanup: {
          propagatedCleanupFailure: cleanupOutcome.error === cleanupFailure,
          rootRemoved: !existsSync(cleanupRunRoot),
          summary: cleanupEvidence.runs[0],
        },
        credential: {
          rejected: credentialOutcome.rejected,
          summary: credentialEvidence.runs[0],
        },
      },
      {
        cleanup: {
          propagatedCleanupFailure: true,
          rootRemoved: true,
          summary: failedRunSummary({
            cleanupCompleted: false,
            completed: true,
            errorEvents: false,
            eventsObserved: 2,
            outputNonEmpty: true,
            phase: 'cleanup',
            streamHttpStatus: 200,
          }),
        },
        credential: {
          rejected: true,
          summary: failedRunSummary({
            phase: 'credential',
          }),
        },
      }
    );
  } finally {
    if (cleanupRunRoot) rmSync(cleanupRunRoot, { force: true, recursive: true });
    rmSync(credentialRoot, { force: true, recursive: true });
    rmSync(cleanupRoot, { force: true, recursive: true });
    credentialSource.cleanup();
    cleanupSource.cleanup();
  }
});

test('C05 evidence contract: reports setup, runtime, and negative-stream facts', async () => {
  const setupSource = writeAuthSource();
  const runtimeSource = writeAuthSource();
  const streamSource = writeAuthSource();
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-remaining-facts-'));
  const setupEvidenceDir = join(testRoot, 'setup-evidence');
  const runtimeEvidenceDir = join(testRoot, 'runtime-evidence');
  const streamEvidenceDir = join(testRoot, 'stream-evidence');
  const missingTempParent = join(testRoot, 'missing-temp-parent');
  const priorTempDir = process.env.TMPDIR;
  const runtimeFailure = new Error('runtime-failure-canary');
  let setupFetchCount = 0;
  let setupSpawnCount = 0;
  let runtimeFetchCount = 0;
  let runtimeRunRoot;

  try {
    process.env.TMPDIR = missingTempParent;
    const setupOutcome = await runProviderSubscriptionRealLifecycleTest({
      env: {
        ...enabledRunnerEnv(setupSource.path, setupEvidenceDir),
        OPENKIT_E2E_LIFECYCLE_RUN_COUNT: '1',
      },
      fetchImpl: async () => {
        setupFetchCount += 1;
        throw new Error('fetch must not run');
      },
      prepareCredential: async () => {},
      spawnProcess: () => {
        setupSpawnCount += 1;
        throw new Error('spawn must not run');
      },
      stdout: () => {},
    }).then(
      () => ({ rejected: false }),
      () => ({ rejected: true })
    );
    if (priorTempDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTempDir;

    const runtimeOutcome = await runProviderSubscriptionRealLifecycleTest({
      env: {
        ...enabledRunnerEnv(runtimeSource.path, runtimeEvidenceDir),
        OPENKIT_E2E_LIFECYCLE_RUN_COUNT: '1',
      },
      fetchImpl: async () => {
        runtimeFetchCount += 1;
        throw new Error('fetch must not run');
      },
      prepareCredential: async () => {},
      spawnProcess: (_command, _args, options) => {
        runtimeRunRoot = options.env.TMPDIR;
        throw runtimeFailure;
      },
      stdout: () => {},
    }).then(
      () => ({ error: undefined }),
      (error) => ({ error })
    );

    const streamScript = HAPPY_SCRIPT();
    streamScript[4][1] = 502;
    streamScript[4][2] =
      'data: {"error":{"code":"gateway_provider_unavailable","message":"raw-error-canary","misc":"private-error-canary"},"stopReason":"error","providerPrivate":"private-payload-canary"}\n\n';
    const {
      options: streamOptions,
      remaining: remainingStreamRequests,
      runRoots: streamRunRoots,
    } = passingLifecycleSeams(streamScript);
    const streamOutcome = await runProviderSubscriptionRealLifecycleTest({
      ...streamOptions,
      env: {
        ...enabledRunnerEnv(streamSource.path, streamEvidenceDir),
        OPENKIT_E2E_LIFECYCLE_RUN_COUNT: '1',
      },
    }).then(
      () => ({ rejected: false }),
      () => ({ rejected: true })
    );

    const setupEvidence = readRunnerEvidence(setupEvidenceDir);
    const runtimeEvidence = readRunnerEvidence(runtimeEvidenceDir);
    const streamEvidence = readRunnerEvidence(streamEvidenceDir);

    assert.deepEqual(
      {
        runtime: {
          fetchCount: runtimeFetchCount,
          propagatedFailure: runtimeOutcome.error === runtimeFailure,
          rootRemoved: !existsSync(runtimeRunRoot),
          summary: runtimeEvidence.runs[0],
        },
        setup: {
          fetchCount: setupFetchCount,
          rejected: setupOutcome.rejected,
          spawnCount: setupSpawnCount,
          summary: setupEvidence.runs[0],
        },
        stream: {
          rejected: streamOutcome.rejected,
          remainingRequests: remainingStreamRequests(),
          rootRemoved: streamRunRoots.every((runRoot) => !existsSync(runRoot)),
          summary: streamEvidence.runs[0],
        },
      },
      {
        runtime: {
          fetchCount: 0,
          propagatedFailure: true,
          rootRemoved: true,
          summary: failedRunSummary({
            phase: 'runtime',
          }),
        },
        setup: {
          fetchCount: 0,
          rejected: true,
          spawnCount: 0,
          summary: failedRunSummary({}),
        },
        stream: {
          rejected: true,
          remainingRequests: 0,
          rootRemoved: true,
          summary: failedRunSummary({
            completed: false,
            errorEvents: true,
            eventsObserved: 1,
            outputNonEmpty: false,
            phase: 'public-lifecycle',
            streamHttpStatus: 502,
            terminalFailureCode: 'gateway_provider_unavailable',
          }),
        },
      }
    );
  } finally {
    if (priorTempDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTempDir;
    if (runtimeRunRoot) rmSync(runtimeRunRoot, { force: true, recursive: true });
    rmSync(testRoot, { force: true, recursive: true });
    setupSource.cleanup();
    runtimeSource.cleanup();
    streamSource.cleanup();
  }
});

test('C05 evidence contract: reports deterministic temporary-root removal failure', async () => {
  const source = writeAuthSource();
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-root-removal-'));
  const evidenceDir = join(testRoot, 'evidence');
  const removalFailure = new Error('temporary-root-removal-failure-canary');
  const { options, runRoots } = passingLifecycleSeams([...HAPPY_SCRIPT(), ...HAPPY_SCRIPT()]);
  let removalAttemptCount = 0;
  let removalTarget;

  try {
    const outcome = await runProviderSubscriptionRealLifecycleTest({
      ...options,
      env: {
        ...enabledRunnerEnv(source.path, evidenceDir),
        OPENKIT_E2E_LIFECYCLE_RUN_COUNT: '1',
      },
      removeTemporaryRoot: (target) => {
        removalAttemptCount += 1;
        removalTarget = target;
        throw removalFailure;
      },
    }).then(
      () => ({ error: undefined }),
      (error) => ({ error })
    );
    const evidence = readRunnerEvidence(evidenceDir);

    assert.deepEqual(
      {
        propagatedRemovalFailure: outcome.error === removalFailure,
        removalAttemptCount,
        removalTargetMatchesRun: removalTarget === runRoots[0],
        rootStillPresent: existsSync(runRoots[0]),
        summary: evidence.runs[0],
      },
      {
        propagatedRemovalFailure: true,
        removalAttemptCount: 1,
        removalTargetMatchesRun: true,
        rootStillPresent: true,
        summary: failedRunSummary({
          cleanupCompleted: false,
          completed: true,
          errorEvents: false,
          eventsObserved: 2,
          outputNonEmpty: true,
          phase: 'cleanup',
          streamHttpStatus: 200,
          temporaryRootRemoved: false,
        }),
      }
    );
  } finally {
    for (const runRoot of runRoots) rmSync(runRoot, { force: true, recursive: true });
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('accepts only the L3 E2E environment interface', () => {
  const source = writeAuthSource();
  const evidenceDir = join(dirname(source.path), 'evidence');
  try {
    assert.equal(
      evaluateRealLifecyclePrerequisites({
        env: {
          OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
          OPENKIT_L6_CODEX_AUTH_PATH: source.path,
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          OPENKIT_L6_LIFECYCLE_PORT: '4319',
          OPENKIT_L6_REAL_SUBSCRIPTION_LIFECYCLE: '1',
        },
      }).enabled,
      false
    );
    assert.equal(
      evaluateRealLifecyclePrerequisites({
        env: {
          OPENKIT_E2E_ALLOW_PROVIDER_QUOTA: '1',
          OPENKIT_E2E_CODEX_AUTH_PATH: source.path,
          OPENKIT_E2E_EVIDENCE_DIR: evidenceDir,
          OPENKIT_E2E_LIFECYCLE_PORT: '4319',
          OPENKIT_E2E_REAL_SUBSCRIPTION_LIFECYCLE: '1',
        },
      }).enabled,
      true
    );
  } finally {
    source.cleanup();
  }
});

test('skips without the real-subscription and provider-quota opt-ins', () => {
  assert.equal(evaluateRealLifecyclePrerequisites({ env: {} }).enabled, false);
  assert.match(
    evaluateRealLifecyclePrerequisites({ env: {} }).reason,
    /REAL_SUBSCRIPTION_LIFECYCLE/
  );
  assert.match(
    evaluateRealLifecyclePrerequisites({
      env: {
        OPENKIT_E2E_REAL_SUBSCRIPTION_LIFECYCLE: '1',
        OPENKIT_L6_REAL_SUBSCRIPTION_LIFECYCLE: '1',
      },
    }).reason,
    /ALLOW_PROVIDER_QUOTA/
  );
});

test('requires the auth source, evidence directory, and a valid port', () => {
  const base = {
    OPENKIT_E2E_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_E2E_REAL_SUBSCRIPTION_LIFECYCLE: '1',
    OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_L6_REAL_SUBSCRIPTION_LIFECYCLE: '1',
  };
  assert.match(evaluateRealLifecyclePrerequisites({ env: base }).reason, /CODEX_AUTH_PATH/);
  assert.match(
    evaluateRealLifecyclePrerequisites({
      env: {
        ...base,
        OPENKIT_E2E_CODEX_AUTH_PATH: '/tmp/auth.json',
        OPENKIT_L6_CODEX_AUTH_PATH: '/tmp/auth.json',
      },
    }).reason,
    /EVIDENCE_DIR/
  );
  assert.match(
    evaluateRealLifecyclePrerequisites({
      env: {
        ...base,
        OPENKIT_E2E_CODEX_AUTH_PATH: '/tmp/auth.json',
        OPENKIT_E2E_EVIDENCE_DIR: '/tmp/evidence',
        OPENKIT_E2E_LIFECYCLE_PORT: '0',
        OPENKIT_L6_CODEX_AUTH_PATH: '/tmp/auth.json',
        OPENKIT_L6_EVIDENCE_DIR: '/tmp/evidence',
        OPENKIT_L6_LIFECYCLE_PORT: '0',
      },
      fileExists: () => true,
    }).reason,
    /LIFECYCLE_PORT/
  );
});

test('returns a skipped result without touching the environment', async () => {
  const messages = [];
  const result = await runProviderSubscriptionRealLifecycleTest({
    env: {},
    stdout: (message) => messages.push(message),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(messages.length, 1);
});

test('reports unchanged auth-source metadata after a completed fake run', async () => {
  const source = writeAuthSource();
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-source-integrity-'));
  const evidenceDir = join(testRoot, 'evidence');
  const resultPath = join(evidenceDir, 'provider-subscription-real-lifecycle-result.json');
  const before = sourceMetadata(source.path);
  const { fetcher, remaining } = scriptedFetcher([...HAPPY_SCRIPT(), ...HAPPY_SCRIPT()]);
  let nextPid = 9300;

  try {
    const result = await runProviderSubscriptionRealLifecycleTest({
      env: enabledRunnerEnv(source.path, evidenceDir),
      fetchImpl: async (url) =>
        String(url).endsWith('/api/health')
          ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
          : fetcher(url),
      killProcess: (_target, signal) => {
        if (signal === 'SIGTERM') return true;
        if (signal === 0)
          throw Object.assign(new Error('process group not found'), { code: 'ESRCH' });
        throw new Error(`unexpected cleanup signal: ${signal}`);
      },
      now: new Date('2026-07-30T00:00:00.000Z'),
      spawnProcess: () => {
        nextPid += 1;
        return { pid: nextPid, ref: () => {} };
      },
      stdout: () => {},
    });
    const evidence = JSON.parse(readFileSync(resultPath, 'utf8'));

    assert.deepEqual(sourceMetadata(source.path), before);
    assert.equal(remaining(), 0);
    assert.equal(result.status, 'passed');
    assert.equal(result.authSourceMetadataUnchanged, true);
    assert.equal(evidence.authSourceMetadataUnchanged, true);
  } finally {
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('writes redacted failure evidence when the fake auth source fails before process start', async () => {
  const secretCanary = 'fake-pre-run-secret-canary';
  const source = writeAuthSource({ access_token: secretCanary });
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-pre-run-failure-'));
  const evidenceDir = join(testRoot, 'evidence');
  const resultPath = join(evidenceDir, 'provider-subscription-real-lifecycle-result.json');
  let fetchCount = 0;
  let spawnCount = 0;

  try {
    await assert.rejects(
      runProviderSubscriptionRealLifecycleTest({
        env: enabledRunnerEnv(source.path, evidenceDir),
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error('fetch must not run');
        },
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error('spawn must not run');
        },
        stdout: () => {},
      }),
      /three-segment JWT/
    );

    assert.equal(fetchCount, 0);
    assert.equal(spawnCount, 0);
    assert.equal(existsSync(resultPath), true, 'pre-run failure evidence was not written');
    const evidenceText = readFileSync(resultPath, 'utf8');
    assert.equal(evidenceText.includes(secretCanary), false);
    assert.equal(evidenceText.includes(source.path), false);
    assert.equal(JSON.parse(evidenceText).status, 'failed');
  } finally {
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('fails closed with redacted evidence when fake auth metadata changes after baseline', async () => {
  const source = writeAuthSource();
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-source-mutation-'));
  const evidenceDir = join(testRoot, 'evidence');
  const resultPath = join(evidenceDir, 'provider-subscription-real-lifecycle-result.json');
  const before = sourceMetadata(source.path);
  const { fetcher, remaining } = scriptedFetcher([...HAPPY_SCRIPT(), ...HAPPY_SCRIPT()]);
  let metadataMutated = false;
  let nextPid = 9400;

  try {
    const outcome = await runProviderSubscriptionRealLifecycleTest({
      env: enabledRunnerEnv(source.path, evidenceDir),
      fetchImpl: async (url) => {
        if (String(url).endsWith('/api/health')) {
          if (!metadataMutated) {
            const changedAt = new Date(before.mtimeMs + 60_000);
            utimesSync(source.path, changedAt, changedAt);
            metadataMutated = true;
          }
          return { ok: true, status: 200, text: async () => '{"status":"ok"}' };
        }
        return fetcher(url);
      },
      killProcess: (_target, signal) => {
        if (signal === 'SIGTERM') return true;
        if (signal === 0)
          throw Object.assign(new Error('process group not found'), { code: 'ESRCH' });
        throw new Error(`unexpected cleanup signal: ${signal}`);
      },
      now: new Date('2026-07-30T00:00:00.000Z'),
      spawnProcess: () => {
        nextPid += 1;
        return { pid: nextPid, ref: () => {} };
      },
      stdout: () => {},
    }).then(
      (result) => ({ error: undefined, result }),
      (error) => ({ error, result: undefined })
    );
    const evidenceText = readFileSync(resultPath, 'utf8');
    const evidence = JSON.parse(evidenceText);

    assert.equal(metadataMutated, true);
    assert.notDeepEqual(sourceMetadata(source.path), before);
    assert.equal(remaining(), 0);
    assert.deepEqual(
      {
        evidenceStatus: evidence.status,
        failedClosed: outcome.error instanceof Error,
        returnedStatus: outcome.result?.status,
      },
      {
        evidenceStatus: 'failed',
        failedClosed: true,
        returnedStatus: undefined,
      }
    );
    assert.equal(evidenceText.includes(source.path), false);
    assert.equal(evidenceText.includes('refresh-value'), false);
    assert.equal(evidenceText.includes('acct-123'), false);
  } finally {
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('writes exclusive redacted failure evidence when the build artifact is missing', async () => {
  const source = writeAuthSource();
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-missing-build-'));
  const mirrorE2eRoot = join(testRoot, 'apps/nanocore/e2e');
  const evidenceDir = join(testRoot, 'evidence');
  const runnerPath = join(mirrorE2eRoot, 'provider-subscription-real-lifecycle-runner.mjs');
  const resultPath = join(evidenceDir, 'provider-subscription-real-lifecycle-result.json');
  mkdirSync(join(mirrorE2eRoot, '_lib'), { recursive: true });
  mkdirSync(evidenceDir, { mode: 0o700 });
  copyFileSync(
    fileURLToPath(new URL('./provider-subscription-real-lifecycle-runner.mjs', import.meta.url)),
    runnerPath
  );
  symlinkSync(
    fileURLToPath(new URL('./_lib/real-codex-support.mjs', import.meta.url)),
    join(mirrorE2eRoot, '_lib/real-codex-support.mjs')
  );

  try {
    const isolatedRunner = await import(`${pathToFileURL(runnerPath).href}?missing-build`);
    await assert.rejects(
      isolatedRunner.runProviderSubscriptionRealLifecycleTest({
        env: enabledRunnerEnv(source.path, evidenceDir),
        stdout: () => {},
      }),
      /Required build output is missing/
    );

    assert.deepEqual(readdirSync(evidenceDir), [
      'provider-subscription-real-lifecycle-result.json',
    ]);
    const evidenceText = readFileSync(resultPath, 'utf8');
    assert.equal(JSON.parse(evidenceText).status, 'failed');
    assert.equal(evidenceText.includes(testRoot), false);
    assert.equal(evidenceText.includes(source.path), false);
    assert.equal(evidenceText.includes('refresh-value'), false);
    assert.equal(evidenceText.includes('acct-123'), false);
  } finally {
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('bounds macOS EPERM to the first post-TERM liveness probe', async () => {
  for (const scenario of [
    {
      expected: {
        activeProcessGroupCount: 0,
        errorCode: undefined,
        remainingRequests: 0,
        runCount: 2,
        runRootsExist: [false, false],
        signalCalls: [
          [-9101, 'SIGTERM'],
          [-9101, 0],
          [-9102, 'SIGTERM'],
          [-9102, 0],
        ],
        status: 'passed',
      },
      name: 'first probe reports EPERM',
      pidBase: 9100,
      probeOutcomes: ['EPERM'],
    },
    {
      expected: {
        activeProcessGroupCount: 1,
        errorCode: 'EPERM',
        remainingRequests: 9,
        runCount: undefined,
        runRootsExist: [false],
        signalCalls: [
          [-9201, 'SIGTERM'],
          [-9201, 0],
          [-9201, 0],
        ],
        status: undefined,
      },
      name: 'one live probe precedes EPERM',
      pidBase: 9200,
      probeOutcomes: ['alive', 'EPERM'],
    },
  ]) {
    const source = writeAuthSource();
    const testRoot = mkdtempSync(join(tmpdir(), 'openkit-c05-eperm-cleanup-'));
    const evidenceDir = join(testRoot, 'evidence');
    const { fetcher, remaining } = scriptedFetcher([...HAPPY_SCRIPT(), ...HAPPY_SCRIPT()]);
    const activeProcessGroups = new Set();
    const probeCounts = new Map();
    const runRoots = [];
    const signalCalls = [];
    let nextPid = scenario.pidBase;

    try {
      const outcome = await runProviderSubscriptionRealLifecycleTest({
        env: enabledRunnerEnv(source.path, evidenceDir),
        fetchImpl: async (url) =>
          String(url).endsWith('/api/health')
            ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
            : fetcher(url),
        killProcess: (target, signal) => {
          signalCalls.push([target, signal]);
          const groupId = -target;
          assert.equal(activeProcessGroups.has(groupId), true);
          if (signal === 'SIGTERM') return true;
          if (signal !== 0) throw new Error(`unexpected cleanup signal: ${signal}`);

          const probeIndex = probeCounts.get(groupId) ?? 0;
          probeCounts.set(groupId, probeIndex + 1);
          const probeOutcome = scenario.probeOutcomes[probeIndex];
          if (probeOutcome === 'alive') return true;
          if (probeOutcome === 'EPERM') {
            if (probeIndex === 0) activeProcessGroups.delete(groupId);
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
          }
          throw new Error(`unexpected liveness probe ${probeIndex + 1}`);
        },
        now: new Date('2026-07-30T00:00:00.000Z'),
        spawnProcess: (_command, _args, options) => {
          nextPid += 1;
          activeProcessGroups.add(nextPid);
          runRoots.push(options.env.TMPDIR);
          return { pid: nextPid, ref: () => {} };
        },
        stdout: () => {},
      }).then(
        (result) => ({ error: undefined, result }),
        (error) => ({ error, result: undefined })
      );

      assert.deepEqual(
        {
          activeProcessGroupCount: activeProcessGroups.size,
          errorCode: outcome.error?.code,
          remainingRequests: remaining(),
          runCount: outcome.result?.runCount,
          runRootsExist: runRoots.map((runRoot) => existsSync(runRoot)),
          signalCalls,
          status: outcome.result?.status,
        },
        scenario.expected,
        scenario.name
      );
    } finally {
      activeProcessGroups.clear();
      for (const runRoot of runRoots) rmSync(runRoot, { force: true, recursive: true });
      rmSync(testRoot, { force: true, recursive: true });
      source.cleanup();
    }
  }
});

test('cleans a SIGTERM-ignoring same-group descendant after its leader exits before SIGINT', async () => {
  const source = writeAuthSource();
  const testRoot = mkdtempSync('/tmp/openkit-c05-');
  const leaderMarkerPath = join(testRoot, 'leader.json');
  const markerPath = join(testRoot, 'detached-process.json');
  const socketPath = join(testRoot, 'descendant.sock');
  const runnerUrl = new URL('./provider-subscription-real-lifecycle-runner.mjs', import.meta.url);
  let descendantPid;
  let groupLeaderPid;
  let runRoot;
  let stderr = '';
  const childSource = `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { runProviderSubscriptionRealLifecycleTest } from ${JSON.stringify(runnerUrl.href)};
    await runProviderSubscriptionRealLifecycleTest({
      env: process.env,
      fetchImpl: async () => new Promise(() => {}),
      spawnProcess: (_command, _args, options) => {
        const descendantSource = ${JSON.stringify(`
          import { writeFileSync } from 'node:fs';
          import { createServer } from 'node:net';
          process.on('SIGTERM', () => {});
          const server = createServer((socket) => socket.end());
          server.listen(${JSON.stringify(socketPath)}, () => {
            writeFileSync(
              ${JSON.stringify(markerPath)},
              JSON.stringify({
                dataRoot: process.env.OPENKIT_DATA_ROOT,
                descendantPid: process.pid,
                groupLeaderPid: process.ppid,
              }),
              { flag: 'wx' },
            );
          });
          setInterval(() => {}, 1000);
        `)};
        const leaderSource = \`
          const { spawn } = require('node:child_process');
          spawn(process.execPath, ['--input-type=module', '-e', \${JSON.stringify(descendantSource)}], {
            env: process.env,
            stdio: ['ignore', 'ignore', 'inherit'],
          });
          setTimeout(() => process.exit(13), 250);
        \`;
        const child = spawn(process.execPath, ['-e', leaderSource], {
          detached: true,
          env: options.env,
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        writeFileSync(
          ${JSON.stringify(leaderMarkerPath)},
          JSON.stringify({ dataRoot: options.env.OPENKIT_DATA_ROOT, pid: child.pid }),
          { flag: 'wx' },
        );
        child.unref();
        return child;
      },
      stdout: () => {},
    });
  `;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    env: {
      ...process.env,
      ...enabledRunnerEnv(source.path, join(testRoot, 'evidence')),
      OPENKIT_TEST_INTERRUPT_MARKER: markerPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const runnerExit = once(runner, 'exit');
  runner.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const markerDeadline = Date.now() + 10_000;
    while (!existsSync(markerPath) && runner.exitCode === null && Date.now() < markerDeadline) {
      await delay(20);
    }
    assert.equal(existsSync(markerPath), true, `detached process did not start: ${stderr}`);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    descendantPid = marker.descendantPid;
    groupLeaderPid = marker.groupLeaderPid;
    runRoot = dirname(marker.dataRoot);

    const leaderExitDeadline = Date.now() + 2_000;
    let groupLeaderAlive = true;
    while (groupLeaderAlive && Date.now() < leaderExitDeadline) {
      try {
        process.kill(groupLeaderPid, 0);
        await delay(20);
      } catch (error) {
        if (error?.code === 'ESRCH') groupLeaderAlive = false;
        else throw error;
      }
    }
    assert.equal(groupLeaderAlive, false, 'detached group leader did not exit before SIGINT');
    runner.kill('SIGINT');
    await Promise.race([
      runnerExit,
      delay(2_000).then(() => {
        throw new Error('interrupted lifecycle runner did not exit');
      }),
    ]);
    await delay(100);

    let descendantProcessAlive = true;
    try {
      process.kill(descendantPid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') descendantProcessAlive = false;
      else throw error;
    }
    const listenerReachable = await new Promise((resolve) => {
      const socket = createConnection(socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(250, () => {
        socket.destroy();
        resolve(false);
      });
    });
    assert.deepEqual(
      {
        descendantProcessAlive,
        disposableCredentialRootExists: existsSync(runRoot),
        listenerReachable,
      },
      {
        descendantProcessAlive: false,
        disposableCredentialRootExists: false,
        listenerReachable: false,
      }
    );
  } finally {
    if (runner.exitCode === null) runner.kill('SIGKILL');
    if (!groupLeaderPid && existsSync(leaderMarkerPath)) {
      const leaderMarker = JSON.parse(readFileSync(leaderMarkerPath, 'utf8'));
      groupLeaderPid = leaderMarker.pid;
      runRoot = runRoot ?? dirname(leaderMarker.dataRoot);
    }
    if (groupLeaderPid) {
      try {
        process.kill(-groupLeaderPid, 'SIGKILL');
      } catch {}
    }
    if (runRoot) rmSync(runRoot, { force: true, recursive: true });
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('does not print a symlink credential source path when secure opening fails', async () => {
  const source = writeAuthSource();
  const testRoot = mkdtempSync(join(tmpdir(), 'openkit-e2e-symlink-source-'));
  const symlinkPath = join(testRoot, 'credential-source-path-canary.json');
  const evidenceDir = join(testRoot, 'evidence');
  symlinkSync(source.path, symlinkPath);
  const runnerPath = fileURLToPath(
    new URL('./provider-subscription-real-lifecycle-runner.mjs', import.meta.url)
  );
  const runner = spawn(process.execPath, [runnerPath], {
    env: {
      ...process.env,
      ...enabledRunnerEnv(symlinkPath, evidenceDir),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  runner.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const [exitCode] = await once(runner, 'exit');
    assert.notEqual(exitCode, 0);
    assert.deepEqual(
      {
        sourcePathExposed: stderr.includes(source.path),
        symlinkPathExposed: stderr.includes(symlinkPath),
      },
      {
        sourcePathExposed: false,
        symlinkPathExposed: false,
      }
    );
  } finally {
    if (runner.exitCode === null) runner.kill('SIGKILL');
    rmSync(testRoot, { force: true, recursive: true });
    source.cleanup();
  }
});

test('reads and maps one current Codex credential from an owner-only source', () => {
  const source = writeAuthSource();
  try {
    const credential = readCodexCredential(source.path);
    assert.deepEqual(Object.keys(credential).sort(), [
      'access',
      'accountId',
      'expires',
      'refresh',
      'type',
    ]);
    assert.equal(credential.type, 'oauth');
    assert.equal(credential.accountId, 'acct-123');
    assert.equal(credential.refresh, 'refresh-value');
    assert.ok(credential.expires > Date.now());
  } finally {
    source.cleanup();
  }
});

test('rejects an expired credential before any effect', () => {
  const source = writeAuthSource({}, Math.floor(Date.now() / 1000) - 60);
  try {
    assert.throws(() => readCodexCredential(source.path), /already expired/);
  } finally {
    source.cleanup();
  }
});

test('rejects a credential whose account claim does not match', () => {
  const source = writeAuthSource({ account_id: 'other-account' });
  try {
    assert.throws(() => readCodexCredential(source.path), /account claim/);
  } finally {
    source.cleanup();
  }
});

test('rejects a non-JWT access token', () => {
  const source = writeAuthSource({ access_token: 'not-a-jwt' });
  try {
    assert.throws(() => readCodexCredential(source.path), /three-segment JWT/);
  } finally {
    source.cleanup();
  }
});

test('summarizes a completed Codex stream without retaining raw frames', () => {
  const summary = summarizeStream(
    [
      'data: {"type":"response.output_text.delta","delta":"O"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"K"}',
      '',
      'data: {"type":"response.completed"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
  );
  assert.deepEqual(summary, {
    completed: true,
    errorEvents: 0,
    eventsObserved: 3,
    outputNonEmpty: true,
  });
});

test('counts stream error events and an unterminated tail as incomplete', () => {
  const summary = summarizeStream('data: {"type":"response.error"}\n\ndata: {"type":"respon');
  assert.deepEqual(summary, {
    completed: false,
    errorEvents: 1,
    eventsObserved: 1,
    outputNonEmpty: false,
  });
});

test('separates a stream that carried no event from one that failed after events', () => {
  assert.deepEqual(summarizeStream(''), {
    completed: false,
    errorEvents: 0,
    eventsObserved: 0,
    outputNonEmpty: false,
  });

  const afterEvents = summarizeStream(
    [
      'data: {"type":"response.created"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"O"}',
      '',
      `data: ${JSON.stringify({ error: { code: 'gateway_stream_failed' } })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n')
  );
  assert.deepEqual(afterEvents, {
    completed: false,
    errorEvents: 1,
    eventsObserved: 3,
    outputNonEmpty: true,
    terminalFailureCode: 'gateway_stream_failed',
  });
});

test('classifies terminal Gateway error codes without retaining other payload values', () => {
  for (const [error, terminalFailureCode] of [
    [
      {
        code: 'gateway_provider_rate_limited',
        message: 'raw-error-message-canary',
        misc: 'private-error-canary',
      },
      'gateway_provider_rate_limited',
    ],
    [{ message: 'missing-code-canary' }, 'unknown'],
    [{ code: 429, message: 'non-string-code-canary' }, 'unknown'],
    [{ code: 'provider_private_error', message: 'unrecognized-code-canary' }, 'unknown'],
  ]) {
    const summary = summarizeStream(
      [
        `data: ${JSON.stringify({ error, providerPrivate: 'private-payload-canary' })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n')
    );
    assert.deepEqual(summary, {
      completed: false,
      errorEvents: 1,
      eventsObserved: 1,
      outputNonEmpty: false,
      terminalFailureCode,
    });
  }
});

test('parses the documented App API response shapes into passing observations', async () => {
  const { fetcher, remaining } = scriptedFetcher(HAPPY_SCRIPT());
  const observations = await runPublicSequence(fetcher, 4319);

  assert.equal(remaining(), 0);
  assert.equal(observations.providerListed, true);
  assert.equal(observations.accountListed, true);
  assert.deepEqual(observations.diagnostics, { model: MODEL, status: 200 });
  assert.deepEqual(observations.inference, {
    completed: true,
    errorEvents: 0,
    eventsObserved: 2,
    outputNonEmpty: true,
    status: 200,
  });
  assert.deepEqual(observations.quota, { availability: 'available', status: 200 });
  assert.equal(observations.postLogout.bodyMatchesExpected, true);
  assert.deepEqual(observations.finalStatus, { status: 200, value: 'logged_out' });
  assert.doesNotThrow(() => assertLifecycleOutcomes(observations));
});

test('rejects a provider inventory that omits the subscription provider', async () => {
  const script = HAPPY_SCRIPT();
  script[0][2] = { providers: [{ subscriptionProviderId: 'other-provider' }] };
  const { fetcher } = scriptedFetcher(script);

  const observations = await runPublicSequence(fetcher, 4319);
  assert.equal(observations.providerListed, false);
  assert.throws(() => assertLifecycleOutcomes(observations), /provider inventory/);
});

test('reads the provider inventory by its documented property name', async () => {
  const script = HAPPY_SCRIPT();
  script[0][2] = { providers: [{ id: PROVIDER }] };
  const { fetcher } = scriptedFetcher(script);

  const observations = await runPublicSequence(fetcher, 4319);
  assert.equal(
    observations.providerListed,
    false,
    'an entry keyed by id must not satisfy the inventory assertion; the contract property is subscriptionProviderId'
  );
});

test('accepts one complete passing lifecycle', () => {
  assert.doesNotThrow(() => assertLifecycleOutcomes(structuredClone(PASSING_OBSERVATIONS)));
});

test('accepts typed Codex quota unavailability after successful inference', () => {
  const observations = structuredClone(PASSING_OBSERVATIONS);
  observations.quota = { availability: 'temporarily_unavailable', status: 200 };

  assert.doesNotThrow(() => assertLifecycleOutcomes(observations));
});

test('rejects each individually falsified lifecycle assertion', () => {
  const falsifiers = [
    [{ providerListed: false }, /provider inventory/],
    [{ accountListed: false }, /account inventory/],
    [{ initialStatus: { status: 200, value: 'logged_out' } }, /logged_in/],
    [{ diagnostics: { model: 'other', status: 200 } }, /logical-model default/],
    [
      { inference: { completed: true, errorEvents: 0, outputNonEmpty: true, status: 500 } },
      /HTTP 200/,
    ],
    [
      { inference: { completed: false, errorEvents: 0, outputNonEmpty: true, status: 200 } },
      /response\.completed/,
    ],
    [
      { inference: { completed: true, errorEvents: 1, outputNonEmpty: true, status: 200 } },
      /error event/,
    ],
    [
      { inference: { completed: true, errorEvents: 0, outputNonEmpty: false, status: 200 } },
      /no assistant output/,
    ],
    [{ quota: { availability: 'unsupported', status: 200 } }, /quota/],
    [{ logout: { status: 200, value: 'logged_in' } }, /logout/],
    [{ postLogout: { bodyMatchesExpected: true, errorCode: null, status: 200 } }, /HTTP 401/],
    [
      { postLogout: { bodyMatchesExpected: false, errorCode: 'other', status: 401 } },
      /expected provider-authentication error object/,
    ],
    [{ finalStatus: { status: 200, value: 'logged_in' } }, /Final account status/],
  ];

  for (const [override, pattern] of falsifiers) {
    assert.throws(
      () => assertLifecycleOutcomes({ ...structuredClone(PASSING_OBSERVATIONS), ...override }),
      pattern
    );
  }
});
