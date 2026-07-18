import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseJsonc } from 'jsonc-parser';

const ACCOUNT_SLOT_ID = 'default';
const AGENT_FILE_ID = 'agents/codex.agent.jsonc';
const AGENT_ID = 'agent_codex_host';
const AUTH_SOURCE_HOST = 'a1';
const AUTH_SOURCE_PATH = '/home/ubuntu/.codex/auth.json';
const AUTH_TRANSFER_TIMEOUT_MS = 30_000;
const AUTH_TERMINATION_GRACE_MS = 1_000;
const AUTH_PROCESS_EXIT_TIMEOUT_MS = 5_000;
const MODEL_ID = 'openai-codex/gpt-5.6-sol';
const PROVIDER_FILE_ID = 'providers/openai-codex.provider.jsonc';
const PROVIDER_ID = 'openai_codex';
const RESTART_REQUIRED_MESSAGE =
  'Real Codex runtime configuration requires a NanoCore restart. Restart NanoCore and rerun the story.';

/**
 * Streams the A1 Codex auth file directly into a new local OAuth account file.
 *
 * @param {{ env?: Record<string, string | undefined>, killProcess?: typeof process.kill, processExitTimeoutMs?: number, spawnProcess?: typeof spawn, targetPath: string, terminationGraceMs?: number, timeoutMs?: number }} options Transfer options and bounded process-owner seams.
 * @returns {Promise<void>} Completion after a successful owner-only transfer.
 * @throws {Error} When the target cannot be created, SSH fails, or the bounded process cannot exit.
 */
export async function streamCodexAuthFromSsh(options) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const killProcess = options.killProcess ?? process.kill;
  const timeoutMs = requireTimeout(
    options.timeoutMs,
    AUTH_TRANSFER_TIMEOUT_MS,
    'SSH auth transfer timeout'
  );
  const terminationGraceMs = requireTimeout(
    options.terminationGraceMs,
    AUTH_TERMINATION_GRACE_MS,
    'SSH auth transfer termination grace',
    0
  );
  const processExitTimeoutMs = requireTimeout(
    options.processExitTimeoutMs,
    AUTH_PROCESS_EXIT_TIMEOUT_MS,
    'SSH auth transfer process-exit timeout'
  );
  let fileDescriptor;

  try {
    mkdirSync(dirname(options.targetPath), { mode: 0o700, recursive: true });
    fileDescriptor = openSync(options.targetPath, 'wx', 0o600);
  } catch {
    throw new Error('Local Codex OAuth account file could not be created securely.');
  }

  const writer = createWriteStream(options.targetPath, { autoClose: true, fd: fileDescriptor });
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
        AUTH_SOURCE_HOST,
        'cat',
        AUTH_SOURCE_PATH,
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
      await terminateSshProcess({
        child,
        detached,
        exit,
        killProcess,
        processExitTimeoutMs,
        terminationGraceMs,
      });
      throw new Error('SSH auth transfer did not expose a readable stream.');
    }
    const exitCode = await waitForSshTransfer({
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
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

/**
 * Configures the default server OAuth slot, provider profile, and Codex agent selection.
 *
 * @param {Record<string, any>} core Public composed Core Client.
 * @param {{ nanoCoreDataRoot: string }} config Runner configuration.
 * @param {(input: { targetPath: string }) => Promise<void>} syncCodexAuth Auth stream implementation.
 * @returns {Promise<{ oauth: Record<string, any>, publicSurfaces: unknown[], runtimeConfig: Record<string, any> }>} Redacted setup summary and public responses.
 * @throws {Error} When credentials, config, or strict reload state is unsafe.
 */
export async function configureRealCodexRuntime(core, config, syncCodexAuth) {
  const targetPath = join(
    config.nanoCoreDataRoot,
    'server/files/oauth/openai-codex/accounts/default/codex-home/auth.json'
  );
  const metadataPath = join(dirname(dirname(targetPath)), 'account.json');
  prepareSecureAuthPath(config.nanoCoreDataRoot, targetPath);
  assertSecureMetadataPath(metadataPath);
  const accounts = await core.oauth.openaiCodex.listAccounts();
  assert(
    accounts.defaultAccountSlotId === ACCOUNT_SLOT_ID &&
      accounts.accounts?.some((account) => account.accountSlotId === ACCOUNT_SLOT_ID),
    'NanoCore did not expose the default Codex OAuth account slot.'
  );
  prepareSecureAuthPath(config.nanoCoreDataRoot, targetPath);
  assertSecureMetadataPath(metadataPath);
  if (!pathEntryExists(targetPath)) await syncCodexAuth({ targetPath });
  assertSecureAuthTarget(targetPath);

  const initialAccountStatus = await core.oauth.openaiCodex.getAccountStatus(ACCOUNT_SLOT_ID);
  assert(initialAccountStatus.status === 'logged_in', 'Codex OAuth account is not logged in.');
  const publicSurfaces = [accounts, initialAccountStatus];
  const runtimeFiles = await core.runtimeConfig.listFiles();
  publicSurfaces.push(runtimeFiles);
  const desiredProvider = providerConfig();
  const desiredProviderContent = `${JSON.stringify(desiredProvider, null, 2)}\n`;
  const providerExists = runtimeFiles.files?.some((file) => file.id === PROVIDER_FILE_ID);
  let runtimeChanged = false;

  if (providerExists) {
    const providerRead = await core.runtimeConfig.getFile(PROVIDER_FILE_ID);
    publicSurfaces.push(providerRead);
    if (
      !isDeepStrictEqual(
        parseConfig(providerRead.content, 'Codex provider config'),
        desiredProvider
      )
    ) {
      assert(
        typeof providerRead.file?.revision === 'string',
        'Codex provider config does not have a revision.'
      );
      const write = await core.runtimeConfig.updateFile({
        content: desiredProviderContent,
        expectedRevision: providerRead.file.revision,
        id: PROVIDER_FILE_ID,
        kind: 'provider',
      });
      assertNoConfigErrors(write, PROVIDER_FILE_ID);
      publicSurfaces.push(write);
      runtimeChanged = true;
    }
  } else {
    const write = await core.runtimeConfig.createFile({
      content: desiredProviderContent,
      id: PROVIDER_FILE_ID,
      kind: 'provider',
    });
    assertNoConfigErrors(write, PROVIDER_FILE_ID);
    publicSurfaces.push(write);
    runtimeChanged = true;
  }

  const agentRead = await core.runtimeConfig.getFile(AGENT_FILE_ID);
  publicSurfaces.push(agentRead);
  const agent = parseConfig(agentRead.content, 'Codex agent config');
  if (agent.provider?.model !== MODEL_ID || agent.provider?.ref !== PROVIDER_ID) {
    assert(
      typeof agentRead.file?.revision === 'string',
      'Codex agent config does not have a revision.'
    );
    agent.provider = { model: MODEL_ID, ref: PROVIDER_ID };
    const write = await core.runtimeConfig.updateFile({
      content: `${JSON.stringify(agent, null, 2)}\n`,
      expectedRevision: agentRead.file.revision,
      id: AGENT_FILE_ID,
      kind: 'agent',
    });
    assertNoConfigErrors(write, AGENT_FILE_ID);
    publicSurfaces.push(write);
    runtimeChanged = true;
  }

  let reload = await core.runtimeConfig.reload({ dryRun: !runtimeChanged, mode: 'strict' });
  publicSurfaces.push(reload);
  if (isExpectedRestart(reload)) throw new Error(RESTART_REQUIRED_MESSAGE);
  if (!runtimeChanged && isWorkspaceDataSourceDeferral(reload, 'dry-run')) {
    const applied = await core.runtimeConfig.reload({ dryRun: false, mode: 'strict' });
    publicSurfaces.push(applied);
    assert(
      isWorkspaceDataSourceDeferral(applied, 'applied'),
      'Strict runtime config apply changed more than the lazy workspace data-source catalog.'
    );
    reload = await core.runtimeConfig.reload({ dryRun: true, mode: 'strict' });
    publicSurfaces.push(reload);
  }
  assert(
    !runtimeChanged && isStrictNoOp(reload),
    'Strict runtime config verification did not return the expected no-op after restart.'
  );

  const accountStatus = await core.oauth.openaiCodex.getAccountStatus(ACCOUNT_SLOT_ID);
  publicSurfaces.push(accountStatus);
  assert(accountStatus.status === 'logged_in', 'Codex OAuth account is not logged in.');
  assert(
    accountStatus.boundProviderIds?.includes(PROVIDER_ID),
    'Default Codex OAuth account is not bound to openai_codex.'
  );
  return {
    oauth: {
      accountSlotId: ACCOUNT_SLOT_ID,
      boundProviderIds: [PROVIDER_ID],
      status: accountStatus.status,
    },
    publicSurfaces,
    runtimeConfig: {
      agentId: AGENT_ID,
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      reloadStatus: reload.status,
    },
  };
}

/**
 * Creates and probes an owner-only evidence directory before a real run.
 *
 * @param {string} evidenceDir Evidence directory selected for the run.
 * @param {string[]} outputFiles Fixed evidence file names owned by the caller.
 * @returns {void}
 * @throws {Error} When the directory is indirect, occupied, or not writable.
 */
export function prepareEvidenceDirectory(evidenceDir, outputFiles) {
  const probePath = join(evidenceDir, `.openkit-write-probe-${randomUUID()}`);
  let fileDescriptor;
  try {
    mkdirSync(evidenceDir, { mode: 0o700, recursive: true });
    assertDirectDirectory(evidenceDir, 'Story evidence directory must be a direct directory.');
    for (const fileName of outputFiles) {
      assert(
        !pathEntryExists(join(evidenceDir, fileName)),
        'Story evidence output already exists.'
      );
    }
    fileDescriptor = openSync(probePath, 'wx', 0o600);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    rmSync(probePath, { force: true });
  } catch (error) {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    try {
      rmSync(probePath, { force: true });
    } catch {
      // Preserve the stable path-free error below.
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
 * Waits for one supervised child or kills its Unix process group at the deadline.
 *
 * @param {import('node:child_process').ChildProcess} child Supervised process-group leader.
 * @param {number} timeoutMs Positive deadline in milliseconds.
 * @param {typeof process.kill} killProcess Process signaling implementation.
 * @returns {Promise<{ kind: 'close', exitCode: number | null } | { kind: 'timeout' }>} Terminal outcome.
 * @throws {Error} When child supervision or process-group termination fails.
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
    if (timer !== undefined) clearTimeout(timer);
    throw error;
  }
  if (winner.kind === 'close') {
    if (timer !== undefined) clearTimeout(timer);
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
 * Rejects credential material and account-file paths from public responses.
 *
 * @param {unknown} value Public responses or evidence.
 * @param {Array<string | undefined>} prohibitedValues Additional local secret-bearing values.
 * @returns {void}
 * @throws {Error} When a protected value is present.
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
 * Creates one owner-only evidence file without replacing an existing entry.
 *
 * @param {string} filePath Evidence file path.
 * @param {string} content Complete evidence content.
 * @returns {void}
 * @throws {Error} When the exclusive owner-only file cannot be created.
 */
export function writeExclusiveEvidenceFile(filePath, content) {
  writeFileSync(filePath, content, { flag: 'wx', mode: 0o600 });
}

/**
 * Fails when a required built artifact is missing.
 *
 * @param {string} filePath Build artifact path.
 * @returns {void}
 * @throws {Error} When the path does not exist.
 */
export function assertBuilt(filePath) {
  if (!existsSync(filePath)) throw new Error(`Required build output is missing: ${filePath}`);
}

/**
 * Returns the exact trusted Codex OAuth provider profile.
 *
 * @returns {Record<string, any>} Canonical provider configuration.
 */
function providerConfig() {
  return {
    defaultModel: MODEL_ID,
    displayName: 'OpenAI Codex',
    extensions: { openkit: { codexOAuth: { accountSlotId: ACCOUNT_SLOT_ID } } },
    id: PROVIDER_ID,
    kind: 'oauth',
    models: [MODEL_ID],
    vendor: PROVIDER_ID,
  };
}

/**
 * Validates an existing server-owned OAuth account file.
 *
 * @param {string} targetPath Expected account-file path.
 * @returns {void}
 * @throws {Error} When the target is absent, indirect, permissive, or foreign-owned.
 */
function assertSecureAuthTarget(targetPath) {
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
 * Rejects linked or foreign OAuth account metadata.
 *
 * @param {string} metadataPath Optional account-metadata path.
 * @returns {void}
 * @throws {Error} When existing metadata is indirect or foreign-owned.
 */
function assertSecureMetadataPath(metadataPath) {
  if (!pathEntryExists(metadataPath)) return;
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
 * Creates missing direct OAuth directories while rejecting indirect path components.
 *
 * @param {string} dataRoot NanoCore data root.
 * @param {string} targetPath Expected account-file path.
 * @returns {void}
 * @throws {Error} When the target leaves the root or a path component is indirect.
 */
function prepareSecureAuthPath(dataRoot, targetPath) {
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
      if (!pathEntryExists(current)) mkdirSync(current, { mode: 0o700 });
      assertDirectDirectory(current, message);
    }
  } catch {
    throw new Error(message);
  }
}

/**
 * Parses one trusted JSONC runtime config without echoing rejected content.
 *
 * @param {string} content Runtime config JSONC source.
 * @param {string} label Safe diagnostic label.
 * @returns {Record<string, any>} Parsed config object.
 * @throws {Error} When the source is invalid or is not an object.
 */
function parseConfig(content, label) {
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
 * Recognizes a strict provider-or-agent restart rejection.
 *
 * @param {Record<string, any>} reload Strict reload response.
 * @returns {boolean} Whether only provider or agent restart changes were rejected.
 */
function isExpectedRestart(reload) {
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
    Array.isArray(plan.applied) &&
    plan.applied.length === 0 &&
    Array.isArray(plan.deferred) &&
    plan.deferred.length === 0 &&
    Array.isArray(plan.warnings) &&
    plan.warnings.length === 0
  );
}

/**
 * Recognizes the sole lazy workspace data-source config deferral.
 *
 * @param {Record<string, any>} reload Strict reload response.
 * @param {'applied' | 'dry-run'} status Expected response status.
 * @returns {boolean} Whether exactly one workspace data-source change was deferred.
 */
function isWorkspaceDataSourceDeferral(reload, status) {
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
 * Recognizes the strict dry-run no-op required after restart.
 *
 * @param {Record<string, any>} reload Strict reload response.
 * @returns {boolean} Whether the response is an exact safe no-op.
 */
function isStrictNoOp(reload) {
  const plan = reload?.plan;
  return (
    reload?.status === 'dry-run' &&
    Number.isInteger(plan?.previousVersion) &&
    plan.nextVersion === plan.previousVersion + 1 &&
    ['applied', 'deferred', 'requiresRestart', 'rejected', 'warnings'].every(
      (key) => Array.isArray(plan[key]) && plan[key].length === 0
    ) &&
    Array.isArray(reload.runtimeConfig?.pendingRestart) &&
    reload.runtimeConfig.pendingRestart.length === 0 &&
    Array.isArray(reload.runtimeConfig?.staleSessions) &&
    reload.runtimeConfig.staleSessions.length === 0
  );
}

/**
 * Requires one path to be a direct directory.
 *
 * @param {string} directoryPath Directory path.
 * @param {string} message Stable failure message.
 * @returns {void}
 * @throws {Error} When the path is missing, indirect, or not a directory.
 */
function assertDirectDirectory(directoryPath, message) {
  assert(lstatSync(directoryPath).isDirectory(), message);
}

/**
 * Returns whether a filesystem entry exists without following links.
 *
 * @param {string} entryPath Filesystem path.
 * @returns {boolean} Whether the path has a directory entry.
 * @throws {Error} When filesystem inspection fails for a reason other than absence.
 */
function pathEntryExists(entryPath) {
  try {
    lstatSync(entryPath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Returns a minimal environment for SSH agent access.
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
 * Waits for one direct-to-file SSH transfer under a bounded deadline.
 *
 * @param {{ child: import('node:child_process').ChildProcess, detached: boolean, exit: Promise<number | null>, killProcess: typeof process.kill, processExitTimeoutMs: number, terminationGraceMs: number, timeoutMs: number, transfer: Promise<void> }} input Owned SSH process and transfer policy.
 * @returns {Promise<number | null>} SSH exit code after stdout is written.
 * @throws {Error} When transfer, process exit, or deadline enforcement fails.
 */
async function waitForSshTransfer(input) {
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
    await terminateSshProcess(input);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (outcome.kind === 'done') return outcome.exitCode;
  await terminateSshProcess(input);
  throw new Error('SSH auth transfer from a1 timed out.');
}

/**
 * Terminates one owned SSH process with bounded TERM-to-KILL escalation.
 *
 * @param {{ child: import('node:child_process').ChildProcess, detached: boolean, exit: Promise<number | null>, killProcess: typeof process.kill, processExitTimeoutMs: number, terminationGraceMs: number }} input Owned SSH process and termination policy.
 * @returns {Promise<void>} Completion after process exit.
 * @throws {Error} When signaling fails or the process survives SIGKILL.
 */
async function terminateSshProcess(input) {
  signalSshProcess(input, 'SIGTERM');
  if (await promiseSettledWithin(input.exit, input.terminationGraceMs)) return;
  signalSshProcess(input, 'SIGKILL');
  if (!(await promiseSettledWithin(input.exit, input.processExitTimeoutMs))) {
    throw new Error('SSH auth transfer from a1 did not exit after SIGKILL.');
  }
}

/**
 * Signals one SSH process group while accepting an already-vanished process.
 *
 * @param {{ child: import('node:child_process').ChildProcess, detached: boolean, killProcess: typeof process.kill }} input Owned SSH child and signaling seam.
 * @param {NodeJS.Signals} signal Signal to deliver.
 * @returns {void}
 * @throws {Error} When signaling fails for a live process.
 */
function signalSshProcess(input, signal) {
  try {
    if (input.detached) input.killProcess(-input.child.pid, signal);
    else input.child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/**
 * Returns whether one promise settles inside a bounded duration.
 *
 * @param {Promise<unknown>} promise Promise to observe.
 * @param {number} timeoutMs Non-negative observation deadline.
 * @returns {Promise<boolean>} Whether the promise settled before the deadline.
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
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Waits for one spawned child to close without preserving stderr.
 *
 * @param {import('node:child_process').ChildProcess} child Spawned SSH child.
 * @returns {Promise<number | null>} Child exit code.
 * @throws {Error} When the child cannot start.
 */
function waitForChildExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', () => rejectExit(new Error('SSH auth transfer from a1 could not start.')));
    child.once('close', (code) => resolveExit(code));
  });
}

/**
 * Resolves when one supervised child closes.
 *
 * @param {import('node:child_process').ChildProcess} child Supervised child.
 * @returns {Promise<{ exitCode: number | null }>} Child close outcome.
 * @throws {Error} When the child emits a start error.
 */
function waitForChildClose(child) {
  return new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (exitCode) => resolveClose({ exitCode }));
  });
}

/**
 * Returns a validated whole-millisecond timeout.
 *
 * @param {number | undefined} value Optional override.
 * @param {number} fallback Default timeout.
 * @param {string} name Safe input label.
 * @param {number} minimum Minimum accepted value.
 * @returns {number} Validated timeout.
 * @throws {Error} When the value is not a safe integer at least as large as the minimum.
 */
function requireTimeout(value, fallback, name, minimum = 1) {
  const timeout = value ?? fallback;
  assert(
    Number.isSafeInteger(timeout) && timeout >= minimum,
    `${name} must be a whole number of at least ${minimum} milliseconds.`
  );
  return timeout;
}

/**
 * Fails when a runtime config write returned an error diagnostic.
 *
 * @param {Record<string, any>} writeResult Runtime config write response.
 * @param {string} fileId Safe config file identifier.
 * @returns {void}
 * @throws {Error} When the response contains an error diagnostic.
 */
function assertNoConfigErrors(writeResult, fileId) {
  assert(
    !writeResult.diagnostics?.some((diagnostic) => diagnostic.severity === 'error'),
    `Runtime config file has error diagnostics: ${fileId}.`
  );
}

/**
 * Throws one stable support error when a condition is false.
 *
 * @param {unknown} condition Condition to require.
 * @param {string} message Stable failure message.
 * @returns {void}
 * @throws {Error} When the condition is falsy.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
