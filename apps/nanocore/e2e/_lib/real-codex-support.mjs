import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { parse as parseJsonc } from 'jsonc-parser';

const AGENT_FILE_ID = 'agents/codex.agent.jsonc';
const AGENT_ID = 'agent_codex_host';
const SUBSCRIPTION_PROVIDER_ID = 'openai-codex';

/** Maximum percent-decoding passes before suspicious nesting fails closed. */
const MAX_PERCENT_NORMALIZATION_PASSES = 8;

/** Fatal UTF-8 decoder for complete percent-encoded code points. */
const UTF8_PERCENT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Stable path-free failure for public secret normalization and detection. */
const PUBLIC_SECRET_LEAK_ERROR =
  'Public test evidence exposed credential material or an account-file path.';

/** Required model identity for prepared real Codex verification. */
export const REAL_CODEX_MODEL_ID = 'openai-codex/gpt-5.6-sol';

/**
 * Verifies the prepared Codex subscription account, provider profile, agent selection, and reload state.
 *
 * @param {Record<string, any>} core Public composed Core Client.
 * @returns {Promise<{ providerId: string }>} Provider identity derived from the selected agent.
 * @throws {Error} When the subscription account, runtime profile, agent, model, or reload state differs.
 */
export async function verifyRealCodexRuntime(core) {
  const agentRead = await core.runtimeConfig.getFile(AGENT_FILE_ID);
  const agent = parseConfig(agentRead.content, 'Codex agent profile');
  const providerRef = agent.provider?.ref;
  assert(
    agent.id === AGENT_ID &&
      typeof providerRef === 'string' &&
      providerRef.length > 0 &&
      isDeepStrictEqual(agent.provider, {
        model: REAL_CODEX_MODEL_ID,
        ref: providerRef,
      }),
    'Prepared Codex agent or model selection is incorrect.'
  );

  const providerRead = await core.runtimeConfig.getFile(`providers/${providerRef}.provider.jsonc`);
  const provider = parseConfig(providerRead.content, 'Codex provider profile');
  const accountSlotId = provider.extensions?.openkit?.subscriptionAccount?.accountSlotId;
  assert(
    provider.id === providerRef &&
      provider.vendor === SUBSCRIPTION_PROVIDER_ID &&
      provider.kind === 'oauth' &&
      provider.defaultModel === REAL_CODEX_MODEL_ID &&
      isDeepStrictEqual(provider.models, [REAL_CODEX_MODEL_ID]) &&
      typeof accountSlotId === 'string' &&
      accountSlotId.length > 0,
    'Prepared Codex provider profile does not match the required subscription configuration.'
  );

  const accounts = await core.providerSubscriptions.listAccounts(SUBSCRIPTION_PROVIDER_ID);
  assert(
    accounts.accounts?.some(
      (account) =>
        account.subscriptionProviderId === SUBSCRIPTION_PROVIDER_ID &&
        account.accountSlotId === accountSlotId &&
        account.status === 'logged_in'
    ),
    'Prepared Codex subscription account is not logged in.'
  );

  const account = await core.providerSubscriptions.getAccountStatus(
    SUBSCRIPTION_PROVIDER_ID,
    accountSlotId
  );
  assert(
    account.subscriptionProviderId === SUBSCRIPTION_PROVIDER_ID &&
      account.accountSlotId === accountSlotId &&
      account.status === 'logged_in',
    'Prepared Codex subscription account is not logged in.'
  );

  const reload = await core.runtimeConfig.reload({ dryRun: true, mode: 'strict' });
  assert(isStrictNoOp(reload), 'Strict runtime config reload verification did not return a no-op.');
  return { providerId: provider.id };
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
  const ownerOnlyError = 'Real-provider evidence directory must use owner-only 0700 permissions.';
  let fileDescriptor;
  try {
    mkdirSync(evidenceDir, { mode: 0o700, recursive: true });
    const directoryStat = assertDirectDirectory(
      evidenceDir,
      'Real-provider evidence directory must be a direct directory.'
    );
    assert((directoryStat.mode & 0o777) === 0o700, ownerOnlyError);
    for (const fileName of outputFiles) {
      assert(
        !pathEntryExists(join(evidenceDir, fileName)),
        'Real-provider evidence output already exists.'
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
      (error.message === 'Real-provider evidence directory must be a direct directory.' ||
        error.message === ownerOnlyError ||
        error.message === 'Real-provider evidence output already exists.')
    ) {
      throw error;
    }
    throw new Error('Real-provider evidence directory is not writable.');
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
  if (!signalProcessGroup(child.pid, 'SIGKILL', killProcess)) {
    const completed = await closed;
    return { exitCode: completed.exitCode, kind: 'close' };
  }
  await closed;
  return { kind: 'timeout' };
}

/**
 * Terminates every member of one detached child process group under a bounded TERM-to-KILL policy.
 *
 * Group liveness, rather than leader liveness, owns completion so descendants
 * remain supervised after the leader exits.
 *
 * @param {import('node:child_process').ChildProcess} child Detached process-group leader.
 * @param {number} timeoutMs Maximum wait after each process-group signal.
 * @param {typeof process.kill} killProcess Process signaling implementation.
 * @returns {Promise<void>} Completion after the process group no longer exists.
 * @throws {Error} When process-group inspection, signaling, or termination fails.
 */
export async function terminateChildProcessGroup(child, timeoutMs, killProcess) {
  assert(
    typeof child.pid === 'number' && child.pid > 0,
    'Detached process group does not have a valid leader.'
  );
  const termWasDelivered = signalProcessGroup(child.pid, 'SIGTERM', killProcess);
  if (await waitForProcessGroupExit(child.pid, timeoutMs, killProcess, termWasDelivered)) return;

  signalProcessGroup(child.pid, 'SIGKILL', killProcess);
  assert(
    await waitForProcessGroupExit(child.pid, timeoutMs, killProcess, false),
    'Detached process group did not terminate before the cleanup deadline.'
  );
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
  const text = JSON.stringify(value) ?? '';
  const normalizedText = normalizePublicSecretText(text);
  const normalizedProhibitedValues = prohibitedValues
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => normalizePublicSecretText(JSON.stringify(entry).slice(1, -1)));
  const patterns = [
    /"(?:access_?token|refresh(?:_?token)?|token|api_?key|client_?secret|authorization|cookie|credential|secret(?:_?(?:reference|ref)(?:_?id)?)?)"\s*:/i,
    /"vault_?(?:reference|ref)(?:_?id)?"\s*:/i,
    /[?&#](?:access(?:_?token)?|refresh(?:_?token)?|token|api_?key|client_?secret|authorization|cookie|credential|secret(?:_?(?:reference|ref)(?:_?id)?)?|vault_?(?:reference|ref)(?:_?id)?)=/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
    /\/\.codex\/auth\.json\b/i,
    /\/codex-(?:home)\/auth\.json\b/i,
    /\/provider-subscriptions\/[^/]+\/accounts\/[^/"]+/i,
    /\/account\.json\b/i,
  ];
  assert(
    patterns.every((pattern) => !pattern.test(normalizedText)) &&
      normalizedProhibitedValues.every((entry) => !normalizedText.includes(entry)),
    PUBLIC_SECRET_LEAK_ERROR
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
 * Parses one runtime configuration document.
 *
 * @param {string} content JSONC document.
 * @param {string} label Safe source label.
 * @returns {Record<string, any>} Parsed configuration.
 * @throws {Error} When the document is invalid or not an object.
 */
function parseConfig(content, label) {
  const errors = [];
  const parsed = parseJsonc(content, errors);
  assert(
    errors.length === 0 && parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    `${label} is invalid.`
  );
  return parsed;
}

/**
 * Returns whether one strict runtime reload is a complete dry-run no-op.
 *
 * @param {Record<string, any>} reload Runtime reload response.
 * @returns {boolean} Whether the response proves no runtime mutation is pending or applied.
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
    reload.runtimeConfig.pendingRestart.length === 0
  );
}

/**
 * Requires one path to be a direct directory.
 *
 * @param {string} directoryPath Directory path.
 * @param {string} message Stable failure message.
 * @returns {import('node:fs').Stats} Direct directory metadata.
 * @throws {Error} When the path is missing, indirect, or not a directory.
 */
function assertDirectDirectory(directoryPath, message) {
  const directoryStat = lstatSync(directoryPath);
  assert(directoryStat.isDirectory(), message);
  return directoryStat;
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
 * Sends one signal to a detached process group and accepts an already-absent group.
 *
 * @param {number} groupId Detached process-group id.
 * @param {NodeJS.Signals} signal Signal delivered to every group member.
 * @param {typeof process.kill} killProcess Process signaling implementation.
 * @returns {boolean} Whether the process group existed when signaled.
 * @throws {Error} When process-group signaling fails for a reason other than absence.
 */
function signalProcessGroup(groupId, signal, killProcess) {
  try {
    killProcess(-groupId, signal);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Waits until one detached process group has no addressable members.
 *
 * @param {number} groupId Detached process-group id.
 * @param {number} timeoutMs Maximum wait in milliseconds.
 * @param {typeof process.kill} killProcess Process signaling implementation.
 * @param {boolean} allowFirstProbePermissionError Whether the first post-TERM EPERM is terminal.
 * @returns {Promise<boolean>} Whether the process group disappeared before the deadline.
 * @throws {Error} When inspection fails outside absence or the allowed first-probe permission loss.
 */
async function waitForProcessGroupExit(
  groupId,
  timeoutMs,
  killProcess,
  allowFirstProbePermissionError
) {
  const deadline = Date.now() + timeoutMs;
  let firstProbe = true;
  while (processGroupExists(groupId, killProcess, allowFirstProbePermissionError && firstProbe)) {
    firstProbe = false;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return true;
}

/**
 * Returns whether one detached process group has an addressable member.
 *
 * @param {number} groupId Detached process-group id.
 * @param {typeof process.kill} killProcess Process signaling implementation.
 * @param {boolean} allowPermissionError Whether EPERM means supervision ended for this probe.
 * @returns {boolean} Whether signal zero can address the process group.
 * @throws {Error} When inspection fails outside absence or the allowed permission loss.
 */
function processGroupExists(groupId, killProcess, allowPermissionError) {
  try {
    killProcess(-groupId, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error.code === 'ESRCH' || (allowPermissionError && error.code === 'EPERM'))
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Normalizes public evidence text through bounded percent decoding.
 *
 * Malformed escapes remain unchanged. Excessively nested valid escapes fail
 * closed instead of leaving an encoded layer available to bypass detection.
 *
 * @param {string} text Serialized public evidence or prohibited value.
 * @returns {string} Stably normalized public evidence text.
 * @throws {Error} When normalization still changes after the fixed bound.
 */
function normalizePublicSecretText(text) {
  let normalizedText = text;
  for (let decodePass = 0; decodePass < MAX_PERCENT_NORMALIZATION_PASSES; decodePass += 1) {
    const nextText = normalizePublicSecretTextPass(normalizedText);
    if (nextText === normalizedText) return normalizedText.replaceAll('\\', '/');
    normalizedText = nextText;
  }
  if (normalizePublicSecretTextPass(normalizedText) === normalizedText) {
    return normalizedText.replaceAll('\\', '/');
  }
  throw new Error(PUBLIC_SECRET_LEAK_ERROR);
}

/**
 * Applies one percent-decoding and standard JSON-escape normalization pass.
 *
 * @param {string} text Serialized public evidence text.
 * @returns {string} Text after one bounded normalization pass.
 */
function normalizePublicSecretTextPass(text) {
  return decodePercentEncodedUtf8(text).replace(
    /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g,
    (jsonEscape) => JSON.parse(`"${jsonEscape}"`)
  );
}

/**
 * Decodes valid UTF-8 byte sequences from percent runs while preserving malformed bytes.
 *
 * @param {string} text Text that may contain percent-encoded bytes.
 * @returns {string} Text with complete valid UTF-8 sequences decoded.
 */
function decodePercentEncodedUtf8(text) {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (encodedRun) => {
    const encodedBytes = encodedRun.match(/%[0-9a-f]{2}/gi) ?? [];
    let decodedRun = '';

    for (let index = 0; index < encodedBytes.length; ) {
      const firstByte = Number.parseInt(encodedBytes[index].slice(1), 16);
      if (firstByte < 0x80) {
        decodedRun += String.fromCharCode(firstByte);
        index += 1;
        continue;
      }

      const sequenceLength =
        firstByte >= 0xc2 && firstByte <= 0xdf
          ? 2
          : firstByte >= 0xe0 && firstByte <= 0xef
            ? 3
            : firstByte >= 0xf0 && firstByte <= 0xf4
              ? 4
              : 0;
      if (sequenceLength > 0 && index + sequenceLength <= encodedBytes.length) {
        const sequence = Uint8Array.from(
          encodedBytes.slice(index, index + sequenceLength),
          (encodedByte) => Number.parseInt(encodedByte.slice(1), 16)
        );
        try {
          decodedRun += UTF8_PERCENT_DECODER.decode(sequence);
          index += sequenceLength;
          continue;
        } catch {
          // Preserve the malformed leading byte and continue scanning this run.
        }
      }

      decodedRun += encodedBytes[index];
      index += 1;
    }

    return decodedRun;
  });
}

/**
 * Resolves when one supervised child closes.
 *
 * @param {import('node:child_process').ChildProcess} child Supervised child.
 * @returns {Promise<{ exitCode: number | null }>} Child close result.
 */
function waitForChildClose(child) {
  return new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (exitCode) => resolveClose({ exitCode }));
  });
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
