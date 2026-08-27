import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  assertBuilt,
  assertNoPublicSecretLeak,
  prepareEvidenceDirectory,
  REAL_CODEX_MODEL_ID,
  terminateChildProcessGroup,
  writeExclusiveEvidenceFile,
} from './_lib/real-codex-support.mjs';

// L3 layer owner: docs/specs/20260529-test_strategy.md.
// Lifecycle behavior owner: docs/specs/20260721-provider_subscription_accounts.md.
const nanoCoreE2eRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(nanoCoreE2eRoot, '../../..');
const nanoCoreDist = join(repoRoot, 'apps/nanocore/dist/index.js');

/** Test-owned subscription provider id. */
const SUBSCRIPTION_PROVIDER_ID = 'openai-codex';

/** Test-owned disposable account slot. */
const ACCOUNT_SLOT_ID = 'real-lifecycle-slot';

/** Test-owned custom provider profile id. */
const PROVIDER_PROFILE_ID = 'real-lifecycle-openai-codex';

/** Test-owned Gateway default model, owned by the shared real-Codex support module. */
const MODEL_ID = REAL_CODEX_MODEL_ID;

/** Default number of back-to-back lifecycles required by the test. */
const RUN_COUNT = 2;

/**
 * Expected public post-logout Gateway body required by the test.
 *
 * This is the sole negative oracle for the Gateway-owned local pre-dispatch
 * result, so it is compared by complete structural equality rather than by a
 * status code alone.
 */
const EXPECTED_POST_LOGOUT_BODY = Object.freeze({
  error: {
    code: 'gateway_provider_authentication_failed',
    message: 'Provider authentication failed.',
    type: 'provider_error',
  },
});

const RESULT_FILE = 'provider-subscription-real-lifecycle-result.json';
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 1_000;
const TERMINAL_FAILURE_CODES = new Set([
  'gateway_provider_authentication_failed',
  'gateway_provider_rate_limited',
  'gateway_context_overflow',
  'gateway_provider_request_invalid',
  'gateway_provider_unavailable',
  'gateway_stream_failed',
]);

/**
 * Evaluates whether the prepared-Codex lifecycle runner may consume provider quota.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean }} options Evaluation options.
 * @returns {{ config: Record<string, string | number | undefined>, enabled: boolean, reason: string }} Prerequisite result.
 */
export function evaluateRealLifecyclePrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const config = {
    authSourcePath: env.OPENKIT_E2E_CODEX_AUTH_PATH,
    evidenceDir: env.OPENKIT_E2E_EVIDENCE_DIR,
    port: Number(env.OPENKIT_E2E_LIFECYCLE_PORT ?? '4319'),
  };

  if (env.OPENKIT_E2E_REAL_SUBSCRIPTION_LIFECYCLE !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_E2E_REAL_SUBSCRIPTION_LIFECYCLE=1 to opt in to the real lifecycle test',
    };
  }
  if (env.OPENKIT_E2E_ALLOW_PROVIDER_QUOTA !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_E2E_ALLOW_PROVIDER_QUOTA=1 to acknowledge provider usage',
    };
  }
  for (const [key, value] of Object.entries({
    OPENKIT_E2E_CODEX_AUTH_PATH: config.authSourcePath,
    OPENKIT_E2E_EVIDENCE_DIR: config.evidenceDir,
  })) {
    if (!value) return { config, enabled: false, reason: `set ${key}` };
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    return { config, enabled: false, reason: 'set a valid OPENKIT_E2E_LIFECYCLE_PORT' };
  }
  if (!fileExists(config.authSourcePath)) {
    return { config, enabled: false, reason: 'Codex auth source not found' };
  }
  return { config, enabled: true, reason: '' };
}

/**
 * Runs the fixed prepared-Codex subscription lifecycle sequence.
 *
 * Each run provisions a disposable Data Root, external Vault key file, and one
 * prepared `openai-codex` account, exercises the public lifecycle through the
 * App API and Gateway, then stops the run-owned process and deletes every
 * disposable artifact. SIGINT interrupts the active lifecycle but waits for
 * that same cleanup path. The originating credential source is never modified.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, fileExists?: (path: string) => boolean, killProcess?: typeof process.kill, now?: Date, prepareCredential?: typeof writePreparedCredential, removeTemporaryRoot?: (path: string) => void, spawnProcess?: typeof spawn, stdout?: (message: string) => void, wait?: typeof delay }} options Test options.
 * @returns {Promise<Record<string, unknown>>} Redacted test result.
 * @throws {Error} When interrupted or when lifecycle execution or cleanup fails.
 */
export async function runProviderSubscriptionRealLifecycleTest(options = {}) {
  const env = options.env ?? process.env;
  const runCountOverride = env.OPENKIT_E2E_LIFECYCLE_RUN_COUNT;
  assert(
    runCountOverride === undefined || runCountOverride === '1',
    'OPENKIT_E2E_LIFECYCLE_RUN_COUNT must be exactly 1 when set.'
  );
  const runCount = runCountOverride === '1' ? 1 : RUN_COUNT;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateRealLifecyclePrerequisites(options);

  if (!prerequisites.enabled) {
    stdout(`SKIP provider-subscription real lifecycle L3 test: ${prerequisites.reason}`);
    return { reason: prerequisites.reason, status: 'skipped' };
  }

  const config = prerequisites.config;
  prepareEvidenceDirectory(config.evidenceDir, [RESULT_FILE]);

  let rejectInterruption;
  const interruption = new Promise((_, reject) => {
    rejectInterruption = reject;
  });
  const onSigint = () => {
    rejectInterruption(new Error('Provider-subscription real lifecycle test interrupted.'));
  };
  const runs = [];
  let authSourceMetadataBefore;
  let authSourceMetadataUnchanged = false;
  let listeningForSigint = false;
  try {
    assertBuilt(nanoCoreDist);
    authSourceMetadataBefore = snapshotAuthSourceMetadata(config.authSourcePath);
    process.on('SIGINT', onSigint);
    listeningForSigint = true;
    for (let index = 1; index <= runCount; index += 1) {
      const outcome = await runOneLifecycle(index, config, options, interruption);
      runs.push(outcome.result);
      if (outcome.failed) throw outcome.error;
    }
  } finally {
    if (listeningForSigint) process.removeListener('SIGINT', onSigint);
    try {
      authSourceMetadataUnchanged =
        authSourceMetadataBefore !== undefined &&
        isDeepStrictEqual(
          authSourceMetadataBefore,
          snapshotAuthSourceMetadata(config.authSourcePath)
        );
    } catch {
      authSourceMetadataUnchanged = false;
    }
    writeRunnerEvidence(config, {
      authSourceMetadataUnchanged,
      generatedAt: (options.now ?? new Date()).toISOString(),
      runs,
      status:
        authSourceMetadataUnchanged &&
        runs.length === runCount &&
        runs.every((run) => run.status === 'passed')
          ? 'passed'
          : 'failed',
    });
  }

  assert(authSourceMetadataUnchanged, 'Codex auth source metadata changed during the lifecycle.');
  stdout(`PASS provider-subscription real lifecycle L3 test evidence: ${config.evidenceDir}`);
  return {
    authSourceMetadataUnchanged,
    evidenceDir: config.evidenceDir,
    runCount: runs.length,
    runs,
    status: 'passed',
  };
}

/**
 * Snapshots write-sensitive auth-source metadata without reading credential content.
 *
 * @param {string} authSourcePath Local Codex auth source.
 * @returns {Record<string, number>} Comparable non-content metadata.
 */
function snapshotAuthSourceMetadata(authSourcePath) {
  const stat = statSync(authSourcePath);
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
 * Runs one complete disposable lifecycle and cleans up unconditionally.
 *
 * @param {number} index One-based run index.
 * @param {Record<string, any>} config Runner configuration.
 * @param {Record<string, any>} options Runner seams.
 * @param {Promise<never>} interruption Rejection that interrupts active lifecycle work.
 * @returns {Promise<{ error: unknown, failed: boolean, result: Record<string, unknown> }>} Settled failure or redacted success observations.
 */
async function runOneLifecycle(index, config, options, interruption) {
  const streamFacts = {
    completed: null,
    errorEvents: null,
    eventsObserved: null,
    outputNonEmpty: null,
    streamHttpStatus: null,
    terminalFailureCode: 'unknown',
  };
  let phase = 'setup';
  let runRoot;
  let owner;
  let observations;
  let lifecycleError;
  let lifecycleFailed = false;
  try {
    runRoot = mkdtempSync(join(tmpdir(), 'openkit-e2e-lifecycle-'));
    const dataRoot = join(runRoot, 'data-root');
    const keyFilePath = join(runRoot, 'vault.key');
    mkdirSync(dataRoot, { mode: 0o700, recursive: true });
    writeFileSync(keyFilePath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    authorRuntimeConfig(dataRoot, keyFilePath);
    phase = 'credential';
    await Promise.race([
      (options.prepareCredential ?? writePreparedCredential)(
        config.authSourcePath,
        dataRoot,
        keyFilePath
      ),
      interruption,
    ]);

    phase = 'runtime';
    owner = startNanoCore(dataRoot, config.port, runRoot, options);
    const fetcher = options.fetchImpl ?? fetch;
    await Promise.race([waitForHealth(fetcher, config.port, options.wait ?? delay), interruption]);
    phase = 'public-lifecycle';
    observations = await Promise.race([
      runPublicSequence(fetcher, config.port, streamFacts),
      interruption,
    ]);
    assertLifecycleOutcomes(observations);
    assertNoPublicSecretLeak(observations, [config.authSourcePath, dataRoot, keyFilePath]);
  } catch (error) {
    lifecycleError = error;
    lifecycleFailed = true;
  }

  let cleanupError;
  let processGroupStopped = true;
  let rootRemovalSettled = true;
  if (owner) {
    try {
      await owner.stop();
    } catch (error) {
      cleanupError = error;
      processGroupStopped = false;
    }
  }
  if (runRoot) {
    try {
      (options.removeTemporaryRoot ?? rmSync)(runRoot, { force: true, recursive: true });
    } catch (error) {
      cleanupError ??= error;
      rootRemovalSettled = false;
    }
  }
  const temporaryRootRemoved = runRoot === undefined || !existsSync(runRoot);
  rootRemovalSettled &&= temporaryRootRemoved;
  const cleanupCompleted = processGroupStopped && rootRemovalSettled;
  if (!cleanupCompleted && cleanupError === undefined) {
    cleanupError = new Error('Disposable lifecycle cleanup did not complete.');
  }

  if (lifecycleFailed || !cleanupCompleted) {
    return {
      error: lifecycleFailed ? lifecycleError : cleanupError,
      failed: true,
      result: {
        runIndex: index,
        phase: lifecycleFailed ? phase : 'cleanup',
        ...streamFacts,
        cleanupCompleted,
        temporaryRootRemoved,
      },
    };
  }

  return {
    error: undefined,
    failed: false,
    result: { index, status: 'passed', ...observations },
  };
}

/**
 * Authors the exact server configuration and one custom provider profile.
 *
 * `openCoreDb` materializes standard templates without overwriting these two
 * files, so authoring them before setup fixes the Gateway defaults the test
 * asserts.
 *
 * @param {string} dataRoot Disposable Data Root.
 * @param {string} keyFilePath External Vault key file path.
 * @returns {void}
 */
function authorRuntimeConfig(dataRoot, keyFilePath) {
  const providersDir = join(dataRoot, 'config', 'providers');
  mkdirSync(providersDir, { mode: 0o700, recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'server.jsonc'),
    `${JSON.stringify(
      {
        defaults: { gatewayModel: MODEL_ID, gatewayProviderId: PROVIDER_PROFILE_ID },
        gateway: { openaiCompatible: { allowedProviderIds: [PROVIDER_PROFILE_ID], enabled: true } },
        mode: 'local',
        schemaVersion: 1,
        vault: { encryptedFile: { keyFilePath } },
      },
      null,
      2
    )}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  writeFileSync(
    join(providersDir, `${PROVIDER_PROFILE_ID}.provider.jsonc`),
    `${JSON.stringify(
      {
        defaultModel: MODEL_ID,
        displayName: 'Real Lifecycle OpenAI Codex',
        extensions: { openkit: { subscriptionAccount: { accountSlotId: ACCOUNT_SLOT_ID } } },
        id: PROVIDER_PROFILE_ID,
        kind: 'oauth',
        models: [MODEL_ID],
        vendor: 'openai-codex',
      },
      null,
      2
    )}\n`,
    { flag: 'wx', mode: 0o600 }
  );
}

/**
 * Reads the Codex auth source exactly once and persists one prepared account.
 *
 * The source is opened once with `O_NOFOLLOW`, validated on that same
 * descriptor, never written, and never persisted in raw form. Account creation
 * and the credential write route through the existing
 * `ProviderSubscriptionAccountManager` and its pair-owned `CredentialStore`.
 *
 * @param {string} authSourcePath Local Codex auth source.
 * @param {string} dataRoot Disposable Data Root.
 * @param {string} keyFilePath External Vault key file path.
 * @returns {Promise<void>} Completion after the credential is bound.
 * @throws {Error} When the source is unsafe, malformed, or expired.
 */
async function writePreparedCredential(authSourcePath, dataRoot, keyFilePath) {
  const credential = readCodexCredential(authSourcePath);
  const nanoCoreModule = (relativePath) =>
    import(pathToFileURL(join(repoRoot, 'apps/nanocore/dist', relativePath)).href);
  const [
    { openCoreDb },
    { applyMigrations },
    { loadEncryptedFileVaultKeyFile },
    { createVaultUnlockState },
    { ProviderSubscriptionAccountManager },
  ] = await Promise.all([
    nanoCoreModule('storage/db.js'),
    nanoCoreModule('storage/migrate.js'),
    nanoCoreModule('vault/vault-key-file.js'),
    nanoCoreModule('vault/vault-unlock-state.js'),
    nanoCoreModule('llm/provider-subscription-accounts.js'),
  ]);

  const pair = { accountSlotId: ACCOUNT_SLOT_ID, subscriptionProviderId: SUBSCRIPTION_PROVIDER_ID };
  const coreDb = openCoreDb(dataRoot);
  let masterKey;
  let vaultState;
  try {
    applyMigrations(coreDb);
    masterKey = loadEncryptedFileVaultKeyFile({ dataRoot, keyFilePath });
    vaultState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    vaultState.unlock({ masterKey });
    const manager = new ProviderSubscriptionAccountManager({
      coreDb,
      vaultBackend: () => vaultState.backend(),
    });
    await manager.createAccount(pair);
    const handle = await manager.getPairHandle(pair);
    await handle.credentials.modify(pair.subscriptionProviderId, async (current) => {
      assert(current === undefined, 'Fresh subscription pair is unexpectedly bound.');
      return credential;
    });
  } finally {
    try {
      vaultState?.lock();
    } finally {
      masterKey?.fill(0);
      coreDb.sqlite.close();
    }
  }
}

/**
 * Validates the local Codex auth source and maps it to a stock OAuth credential.
 *
 * @param {string} authSourcePath Local Codex auth source.
 * @returns {{ accountId: string, access: string, expires: number, refresh: string, type: 'oauth' }} Mapped credential.
 * @throws {Error} When the source is unsafe, malformed, or already expired.
 */
export function readCodexCredential(authSourcePath) {
  assert(
    typeof process.geteuid === 'function' && constants.O_NOFOLLOW > 0,
    'Required secure file primitives are unavailable.'
  );
  const setupTimeMs = Date.now();
  let sourceBytes;
  let fileDescriptor;
  try {
    fileDescriptor = openSync(authSourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Codex auth source could not be opened securely.');
  }
  try {
    const stat = fstatSync(fileDescriptor);
    assert(stat.isFile(), 'Codex auth source is not a regular file.');
    assert(stat.uid === process.geteuid(), 'Codex auth source is not owned by the current user.');
    assert((stat.mode & 0o777) === 0o600, 'Codex auth source must use 0600 permissions.');
    sourceBytes = readFileSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }

  let root;
  try {
    root = JSON.parse(sourceBytes.toString('utf8'));
  } finally {
    sourceBytes.fill(0);
  }
  const tokens = plainObject(root) ? root.tokens : undefined;
  assert(plainObject(tokens), 'Codex auth source tokens are invalid.');
  const { access_token: access, account_id: accountId, refresh_token: refresh } = tokens;
  assert(
    [access, refresh, accountId].every((value) => typeof value === 'string' && value.length > 0),
    'Codex auth source is missing a required token field.'
  );

  const segments = access.split('.');
  assert(
    segments.length === 3 && segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)),
    'Codex access token is not a three-segment JWT.'
  );
  const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  assert(
    plainObject(payload) && Number.isSafeInteger(payload.exp),
    'Codex token payload is invalid.'
  );
  const expires = payload.exp * 1000;
  assert(
    Number.isSafeInteger(expires) && expires > setupTimeMs,
    'Codex credential is already expired.'
  );
  const claims = payload['https://api.openai.com/auth'];
  assert(
    plainObject(claims) && claims.chatgpt_account_id === accountId,
    'Codex token account claim does not match the credential account id.'
  );

  return { access, accountId, expires, refresh, type: 'oauth' };
}

/**
 * Starts one run-owned NanoCore process group under an allowlisted environment.
 *
 * The returned owner retains event-loop ownership until cleanup even when the
 * process-group leader exits before its descendants.
 *
 * @param {string} dataRoot Disposable Data Root.
 * @param {number} port Loopback port.
 * @param {string} runRoot Run-owned temporary root used as `TMPDIR`.
 * @param {Record<string, any>} options Runner seams.
 * @returns {{ stop: () => Promise<void> }} Process owner.
 * @throws {Error} When process startup or process-group cleanup fails.
 */
function startNanoCore(dataRoot, port, runRoot, options) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const killProcess = options.killProcess ?? process.kill;
  const child = spawnProcess(process.execPath, [nanoCoreDist], {
    detached: true,
    env: {
      OPENKIT_BIND_HOST: '127.0.0.1',
      OPENKIT_CORE_MODE: 'local',
      OPENKIT_DATA_ROOT: dataRoot,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      PORT: String(port),
      TMPDIR: runRoot,
    },
    stdio: 'ignore',
  });
  assert(Boolean(child.pid), 'NanoCore did not start.');
  child.ref();
  const ownerKeepAlive = setInterval(() => {}, STOP_TIMEOUT_MS);

  return {
    stop: async () => {
      try {
        await terminateChildProcessGroup(child, STOP_TIMEOUT_MS, killProcess);
      } finally {
        clearInterval(ownerKeepAlive);
      }
    },
  };
}

/**
 * Waits for the public health endpoint to answer before any product call.
 *
 * @param {typeof fetch} fetcher Fetch implementation.
 * @param {number} port Loopback port.
 * @param {typeof delay} wait Delay implementation.
 * @returns {Promise<void>} Completion once health answers.
 * @throws {Error} When health does not answer inside the bounded deadline.
 */
async function waitForHealth(fetcher, port, wait) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/api/health`, { redirect: 'error' });
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline expires.
    }
    await wait(200);
  }
  throw new Error('NanoCore health did not answer before the deadline.');
}

/**
 * Executes the public lifecycle sequence and returns redacted observations.
 *
 * Every field read here is a documented App API response property in
 * `apps/nanocore/openapi/app-api.openapi.json`. Its unit test drives this
 * function with schema-shaped fixtures, because a parser that silently reads a
 * property the contract does not have turns into a false product failure.
 *
 * @param {typeof fetch} fetcher Fetch implementation.
 * @param {number} port Loopback port.
 * @param {{ completed: boolean | null, errorEvents: boolean | null, eventsObserved: number | null, outputNonEmpty: boolean | null, streamHttpStatus: number | null, terminalFailureCode: 'gateway_provider_authentication_failed' | 'gateway_provider_rate_limited' | 'gateway_context_overflow' | 'gateway_provider_request_invalid' | 'gateway_provider_unavailable' | 'gateway_stream_failed' | 'unknown' }} streamFacts Mutable redacted failure facts.
 * @returns {Promise<Record<string, any>>} Redacted public observations.
 */
export async function runPublicSequence(fetcher, port, streamFacts) {
  const base = `http://127.0.0.1:${port}`;
  const providerPath = `${base}/api/app/provider-subscriptions/${SUBSCRIPTION_PROVIDER_ID}`;
  const accountPath = `${providerPath}/accounts/${ACCOUNT_SLOT_ID}`;
  const gatewayInit = {
    body: JSON.stringify({
      input: 'Reply with only OK.',
      max_output_tokens: 16,
      model: MODEL_ID,
      stream: true,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  };

  const providers = await fetchJson(fetcher, `${base}/api/app/provider-subscriptions`);
  const accounts = await fetchJson(fetcher, `${providerPath}/accounts`);
  const initialStatus = await fetchJson(fetcher, `${accountPath}/status`);
  const diagnostics = await fetchJson(fetcher, `${base}/api/app/diagnostics`);
  const inferenceResponse = await fetcher(`${base}/v1/responses`, {
    redirect: 'error',
    ...gatewayInit,
  });
  if (streamFacts) streamFacts.streamHttpStatus = inferenceResponse.status;
  const inference = { status: inferenceResponse.status, text: await inferenceResponse.text() };
  const inferenceSummary = summarizeStream(inference.text);
  if (streamFacts) {
    streamFacts.completed = inferenceSummary.completed;
    streamFacts.errorEvents = inferenceSummary.errorEvents > 0;
    streamFacts.eventsObserved = inferenceSummary.eventsObserved;
    streamFacts.outputNonEmpty = inferenceSummary.outputNonEmpty;
    streamFacts.terminalFailureCode = inferenceSummary.terminalFailureCode ?? 'unknown';
  }
  const quota = await fetchJson(fetcher, `${accountPath}/quota`);
  const logout = await fetchJson(fetcher, `${accountPath}/logout`, { method: 'POST' });
  const postLogout = await fetchJson(fetcher, `${base}/v1/responses`, gatewayInit);
  const finalStatus = await fetchJson(fetcher, `${accountPath}/status`);

  return {
    accountListed: (accounts.json?.accounts ?? []).some(
      (account) =>
        account?.subscriptionProviderId === SUBSCRIPTION_PROVIDER_ID &&
        account?.accountSlotId === ACCOUNT_SLOT_ID
    ),
    diagnostics: {
      model: diagnostics.json?.defaults?.gateway?.model ?? null,
      providerId: diagnostics.json?.defaults?.gateway?.providerId ?? null,
      status: diagnostics.status,
    },
    finalStatus: { status: finalStatus.status, value: finalStatus.json?.status ?? null },
    inference: { status: inference.status, ...inferenceSummary },
    initialStatus: { status: initialStatus.status, value: initialStatus.json?.status ?? null },
    logout: { status: logout.status, value: logout.json?.status ?? null },
    postLogout: {
      bodyMatchesExpected: isDeepStrictEqual(postLogout.json, EXPECTED_POST_LOGOUT_BODY),
      errorCode: postLogout.json?.error?.code ?? null,
      status: postLogout.status,
    },
    providerListed: (providers.json?.providers ?? []).some(
      (entry) => entry?.subscriptionProviderId === SUBSCRIPTION_PROVIDER_ID
    ),
    quota: { availability: quota.json?.availability ?? null, status: quota.status },
  };
}

/**
 * Summarizes one Codex Responses SSE body without retaining raw frames.
 *
 * @param {string} text Raw SSE body.
 * @returns {{ completed: boolean, errorEvents: number, eventsObserved: number, outputNonEmpty: boolean, terminalFailureCode?: 'gateway_provider_authentication_failed' | 'gateway_provider_rate_limited' | 'gateway_context_overflow' | 'gateway_provider_request_invalid' | 'gateway_provider_unavailable' | 'gateway_stream_failed' | 'unknown' }} Redacted stream summary with a safe classification only for a top-level terminal error.
 */
export function summarizeStream(text) {
  let completed = false;
  let errorEvents = 0;
  let eventsObserved = 0;
  let output = '';
  let terminalFailureCode;

  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data === '' || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    eventsObserved += 1;
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      output += event.delta;
    }
    if (event?.type === 'response.completed') completed = true;
    const terminalError = plainObject(event?.error);
    if ((typeof event?.type === 'string' && event.type.endsWith('error')) || terminalError) {
      errorEvents += 1;
    }
    if (terminalError) {
      terminalFailureCode = TERMINAL_FAILURE_CODES.has(event.error.code)
        ? event.error.code
        : 'unknown';
    }
  }

  return {
    completed,
    errorEvents,
    eventsObserved,
    outputNonEmpty: output.trim().length > 0,
    ...(terminalFailureCode === undefined ? {} : { terminalFailureCode }),
  };
}

/**
 * Applies the test's assertions to one run's observations.
 *
 * @param {Record<string, any>} observations Redacted public observations.
 * @returns {void}
 * @throws {Error} When any lifecycle assertion is unmet.
 */
export function assertLifecycleOutcomes(observations) {
  assert(
    observations.providerListed,
    'Public provider inventory did not list the subscription provider.'
  );
  assert(observations.accountListed, 'Public account inventory did not list the prepared account.');
  assert(
    observations.initialStatus.status === 200 && observations.initialStatus.value === 'logged_in',
    'Prepared account did not report logged_in before inference.'
  );
  assert(
    observations.diagnostics.status === 200 &&
      observations.diagnostics.providerId === PROVIDER_PROFILE_ID &&
      observations.diagnostics.model === MODEL_ID,
    'Public diagnostics did not report the authored Gateway defaults.'
  );
  assert(observations.inference.status === 200, 'Real Codex inference did not return HTTP 200.');
  assert(observations.inference.completed, 'Real Codex stream did not reach response.completed.');
  assert(observations.inference.errorEvents === 0, 'Real Codex stream reported an error event.');
  assert(observations.inference.outputNonEmpty, 'Real Codex stream produced no assistant output.');
  assert(
    observations.quota.status === 200 &&
      ['available', 'temporarily_unavailable'].includes(observations.quota.availability),
    'Public quota read did not report an accepted availability.'
  );
  assert(
    observations.logout.status === 200 && observations.logout.value === 'logged_out',
    'Public logout did not report logged_out.'
  );
  assert(
    observations.postLogout.status === 401,
    'Post-logout inference did not fail with HTTP 401.'
  );
  assert(
    observations.postLogout.bodyMatchesExpected,
    'Post-logout public body did not equal the expected provider-authentication error object.'
  );
  assert(
    observations.finalStatus.status === 200 && observations.finalStatus.value === 'logged_out',
    'Final account status did not report logged_out.'
  );
}

/**
 * Writes the exclusive runner evidence file after a final redaction scan.
 *
 * @param {Record<string, any>} config Runner configuration.
 * @param {Record<string, unknown>} result Redacted result payload.
 * @returns {void}
 */
function writeRunnerEvidence(config, result) {
  assertNoPublicSecretLeak(result, [config.authSourcePath]);
  writeExclusiveEvidenceFile(
    join(config.evidenceDir, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`
  );
}

/**
 * Fetches and parses one JSON response.
 *
 * @param {typeof fetch} fetcher Fetch implementation.
 * @param {string} url URL to fetch.
 * @param {RequestInit} init Request options.
 * @returns {Promise<{ json: any, status: number }>} Parsed response.
 */
async function fetchJson(fetcher, url, init = {}) {
  const { status, text } = await fetchText(fetcher, url, init);
  try {
    return { json: text ? JSON.parse(text) : null, status };
  } catch {
    return { json: null, status };
  }
}

/**
 * Fetches one text response.
 *
 * @param {typeof fetch} fetcher Fetch implementation.
 * @param {string} url URL to fetch.
 * @param {RequestInit} init Request options.
 * @returns {Promise<{ status: number, text: string }>} Text response.
 */
async function fetchText(fetcher, url, init = {}) {
  const response = await fetcher(url, { redirect: 'error', ...init });
  return { status: response.status, text: await response.text() };
}

/**
 * Returns whether a value is a plain object.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} Whether the value is a non-null, non-array object.
 */
function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Throws one stable runner error when a condition is false.
 *
 * @param {unknown} condition Condition to require.
 * @param {string} message Stable failure message.
 * @returns {void}
 * @throws {Error} When the condition is falsy.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProviderSubscriptionRealLifecycleTest().then(
    (result) => {
      if (result.status === 'skipped') process.exitCode = 0;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
