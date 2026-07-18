import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import {
  assertBuilt,
  assertNoPublicSecretLeak,
  configureRealCodexRuntime,
  prepareEvidenceDirectory,
  streamCodexAuthFromSsh,
  waitForChildOrDeadline,
  writeExclusiveEvidenceFile,
} from './real-codex-support.mjs';

const fakeSecret = 'support-secret-canary-value';
const modelId = 'openai-codex/gpt-5.6-sol';

test('streams A1 auth into a new 0600 file without secret-bearing argv or env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-auth-stream-'));
  const targetPath = join(root, 'default/codex-home/auth.json');
  const calls = [];
  try {
    await streamCodexAuthFromSsh({
      env: { HOME: '/tmp/home', OPENKIT_NANOCORE_TOKEN: fakeSecret, PATH: '/usr/bin' },
      spawnProcess: fakeSshSpawn(fakeSecret, calls),
      targetPath,
    });
    assert.equal(readFileSync(targetPath, 'utf8'), fakeSecret);
    assert.equal(statSync(targetPath).mode & 0o777, 0o600);
    assert.equal(calls[0].command, '/usr/bin/ssh');
    assert.equal(calls[0].options.env.OPENKIT_NANOCORE_TOKEN, undefined);
    assert.equal(JSON.stringify(calls).includes(fakeSecret), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('removes a partial account file when the SSH source fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-auth-partial-'));
  const targetPath = join(root, 'auth.json');
  try {
    await assert.rejects(
      streamCodexAuthFromSsh({ spawnProcess: fakeSshSpawn('partial', [], 23), targetPath }),
      /exit code 23/
    );
    assert.equal(existsSync(targetPath), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('terminates and kills a hung SSH auth stream inside its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-auth-timeout-'));
  const targetPath = join(root, 'auth.json');
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const signals = [];
  child.pid = 41_317;
  child.stdout = stdout;
  stdout.write(fakeSecret);
  try {
    await assert.rejects(
      streamCodexAuthFromSsh({
        killProcess: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === 'SIGKILL') {
            stdout.destroy();
            queueMicrotask(() => child.emit('close', null, signal));
          }
        },
        processExitTimeoutMs: 100,
        spawnProcess: () => child,
        targetPath,
        terminationGraceMs: 5,
        timeoutMs: 10,
      }),
      /timed out/
    );
    assert.deepEqual(signals, [
      [-41_317, 'SIGTERM'],
      [-41_317, 'SIGKILL'],
    ]);
    assert.equal(existsSync(targetPath), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('rejects an indirect OAuth path before contacting NanoCore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-auth-path-'));
  const dataRoot = join(root, 'data');
  const outside = join(root, 'outside');
  mkdirSync(join(dataRoot, 'server'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(dataRoot, 'server/files'));
  try {
    await assert.rejects(
      configureRealCodexRuntime({}, { nanoCoreDataRoot: dataRoot }, async () => {}),
      /secure OAuth account path/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('writes canonical runtime config then stops for the required restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-runtime-restart-'));
  const state = runtimeCore({
    agentContent: agentConfig('openai', 'gpt-5.1'),
    providerContent: null,
    reloads: [restartReload()],
  });
  try {
    await assert.rejects(
      configureRealCodexRuntime(state.core, { nanoCoreDataRoot: root }, async ({ targetPath }) => {
        writeFileSync(targetPath, '{}\n', { flag: 'wx', mode: 0o600 });
      }),
      /requires a NanoCore restart/
    );
    assert.equal(JSON.parse(state.providerContent()).defaultModel, modelId);
    assert.deepEqual(JSON.parse(state.agentContent()).provider, {
      model: modelId,
      ref: 'openai_codex',
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('accepts canonical JSONC and only the bounded workspace-data-source deferral', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-runtime-noop-'));
  const authPath = join(
    root,
    'server/files/oauth/openai-codex/accounts/default/codex-home/auth.json'
  );
  mkdirSync(join(authPath, '..'), { recursive: true });
  writeFileSync(authPath, '{}\n', { mode: 0o600 });
  const state = runtimeCore({
    agentContent: asJsonc(agentConfig('openai_codex', modelId)),
    providerContent: asJsonc(JSON.stringify(providerConfig())),
    reloads: [workspaceDeferral('dry-run'), workspaceDeferral('applied'), noOpReload()],
  });
  let syncCalls = 0;
  try {
    const result = await configureRealCodexRuntime(
      state.core,
      { nanoCoreDataRoot: root },
      async () => {
        syncCalls += 1;
      }
    );
    assert.equal(syncCalls, 0);
    assert.equal(result.runtimeConfig.reloadStatus, 'dry-run');
    assert.deepEqual(state.reloadCalls, [
      { dryRun: true, mode: 'strict' },
      { dryRun: false, mode: 'strict' },
      { dryRun: true, mode: 'strict' },
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('keeps process, evidence, build, and redaction guards focused', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.pid = 73;
  const outcome = await waitForChildOrDeadline(child, 1, (pid, signal) => {
    signals.push([pid, signal]);
    queueMicrotask(() => child.emit('close', null, signal));
  });
  assert.deepEqual(outcome, { kind: 'timeout' });
  assert.deepEqual(signals, [[-73, 'SIGKILL']]);

  const root = await mkdtemp(join(tmpdir(), 'openkit-support-evidence-'));
  const output = join(root, 'result.json');
  try {
    prepareEvidenceDirectory(root, ['result.json']);
    writeExclusiveEvidenceFile(output, '{}\n');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeExclusiveEvidenceFile(output, '{}\n'), /EEXIST/);
    assert.doesNotThrow(() => assertBuilt(output));
    assert.throws(() => assertBuilt(join(root, 'missing')), /Required build output/);
    assert.throws(
      () => assertNoPublicSecretLeak({ authorization: `Bearer ${fakeSecret}` }),
      /exposed/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * Returns a fake SSH launcher that emits one stdout payload and exit code.
 *
 * @param {string} content Fake remote stdout.
 * @param {Array<Record<string, any>>} calls Captured spawn calls.
 * @param {number} exitCode Fake child exit code.
 * @returns {(command: string, args: string[], options: Record<string, any>) => import('node:child_process').ChildProcess} Spawn substitute.
 */
function fakeSshSpawn(content, calls, exitCode = 0) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 41_316;
    child.stdout = Readable.from([content]);
    calls.push({ args, command, options });
    queueMicrotask(() => child.emit('close', exitCode, null));
    return child;
  };
}

/**
 * Returns the canonical provider config used by real Codex runs.
 *
 * @returns {Record<string, any>} Provider fixture.
 */
function providerConfig() {
  return {
    defaultModel: modelId,
    displayName: 'OpenAI Codex',
    extensions: { openkit: { codexOAuth: { accountSlotId: 'default' } } },
    id: 'openai_codex',
    kind: 'oauth',
    models: [modelId],
    vendor: 'openai_codex',
  };
}

/**
 * Returns a minimal Codex agent JSON document.
 *
 * @param {string} ref Provider reference.
 * @param {string} model Provider model.
 * @returns {string} Serialized agent fixture.
 */
function agentConfig(ref, model) {
  return JSON.stringify({ id: 'agent_codex_host', provider: { model, ref }, schemaVersion: 1 });
}

/**
 * Adds JSONC syntax that must compare semantically rather than byte-for-byte.
 *
 * @param {string} content JSON object source.
 * @returns {string} Equivalent JSONC source.
 */
function asJsonc(content) {
  return content.replace('{', '{\n// retained comment\n').replace(/}$/, ',\n}');
}

/**
 * Returns a strict provider-and-agent restart rejection.
 *
 * @returns {Record<string, any>} Restart rejection fixture.
 */
function restartReload() {
  const requiresRestart = ['providers', 'agents'].map((path) => ({
    action: 'requires-restart',
    category: 'restart-required',
    path,
  }));
  return {
    plan: {
      applied: [],
      deferred: [],
      rejected: requiresRestart.map((change) => ({
        ...change,
        action: 'rejected',
        category: 'rejected',
      })),
      requiresRestart,
      warnings: [],
    },
    status: 'rejected',
  };
}

/**
 * Returns the strict no-op response required after restart.
 *
 * @returns {Record<string, any>} No-op reload fixture.
 */
function noOpReload() {
  return {
    plan: {
      applied: [],
      deferred: [],
      nextVersion: 2,
      previousVersion: 1,
      rejected: [],
      requiresRestart: [],
      warnings: [],
    },
    runtimeConfig: { pendingRestart: [], staleSessions: [] },
    status: 'dry-run',
  };
}

/**
 * Returns the only accepted lazy workspace data-source deferral.
 *
 * @param {'applied' | 'dry-run'} status Reload response status.
 * @returns {Record<string, any>} Workspace deferral fixture.
 */
function workspaceDeferral(status) {
  return {
    plan: {
      applied: [],
      deferred: [{ action: 'deferred', category: 'session-scoped', path: 'workspaceDataSources' }],
      nextVersion: 2,
      previousVersion: 1,
      rejected: [],
      requiresRestart: [],
      warnings: [],
    },
    runtimeConfig: { pendingRestart: [], staleSessions: [] },
    status,
  };
}

/**
 * Creates the smallest Core Client substitute needed by runtime configuration support.
 *
 * @param {{ agentContent: string, providerContent: string | null, reloads: Array<Record<string, any>> }} input Mutable runtime fixture state.
 * @returns {{ agentContent: () => string, core: Record<string, any>, providerContent: () => string | null, reloadCalls: Array<Record<string, any>> }} Core substitute and observable state.
 */
function runtimeCore(input) {
  let agentContent = input.agentContent;
  let providerContent = input.providerContent;
  const reloadCalls = [];
  const status = {
    boundProviderIds: ['openai_codex'],
    status: 'logged_in',
  };
  return {
    agentContent: () => agentContent,
    core: {
      oauth: {
        openaiCodex: {
          getAccountStatus: async () => status,
          listAccounts: async () => ({
            accounts: [{ accountSlotId: 'default' }],
            defaultAccountSlotId: 'default',
          }),
        },
      },
      runtimeConfig: {
        createFile: async (write) => {
          providerContent = write.content;
          return { diagnostics: [], file: { revision: 'provider-1' } };
        },
        getFile: async (id) => ({
          content: id.startsWith('providers/') ? providerContent : agentContent,
          file: { revision: id.startsWith('providers/') ? 'provider-1' : 'agent-1' },
        }),
        listFiles: async () => ({
          files: [
            { id: 'agents/codex.agent.jsonc' },
            ...(providerContent ? [{ id: 'providers/openai-codex.provider.jsonc' }] : []),
          ],
        }),
        reload: async (request) => {
          reloadCalls.push(request);
          return input.reloads.shift();
        },
        updateFile: async (write) => {
          if (write.id.startsWith('providers/')) providerContent = write.content;
          else agentContent = write.content;
          return { diagnostics: [], file: { revision: 'updated-1' } };
        },
      },
    },
    providerContent: () => providerContent,
    reloadCalls,
  };
}
