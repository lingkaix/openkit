import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  linkSync,
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
import { describe, it } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import {
  classifyRealCodexRunnerFailure,
  DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH,
  evaluateRealCodexRunnerPrerequisites,
  REAL_CODEX_GOAL_MODEL,
  REAL_CODEX_GOAL_OBJECTIVE,
  REAL_CODEX_GOAL_PROOF_CONTENT,
  REAL_CODEX_GOAL_PROOF_PATH,
  runRealCodexGoalModeCli,
  runRealCodexGoalModeStory,
  streamCodexAuthFromSsh,
} from './real-codex-goal-mode-runner.mjs';

const fakeSecret = 'fake-access-token-that-must-not-leak';

describe('real Codex Goal Mode L6 runner', () => {
  it('pins the acceptance run to the current ChatGPT-backed Codex model', () => {
    assert.equal(REAL_CODEX_GOAL_MODEL, 'openai-codex/gpt-5.6-sol');
  });

  it('preserves only the safe restart instruction in CLI failure classification', () => {
    const restartMessage =
      'Real Codex runtime configuration requires a NanoCore restart. Restart NanoCore and rerun the story.';

    assert.deepEqual(classifyRealCodexRunnerFailure(new Error(restartMessage)), {
      kind: 'restart_required',
      message: restartMessage,
    });
    assert.deepEqual(
      classifyRealCodexRunnerFailure(new Error(`provider failed with ${fakeSecret}`)),
      {
        kind: 'runtime_failure',
        message: 'Real Codex Goal Mode story failed.',
      }
    );
  });

  it('requires explicit quota opt-in and an existing NanoCore deployment', () => {
    const skipped = evaluateRealCodexRunnerPrerequisites({ env: {}, fileExists: () => false });

    assert.equal(skipped.enabled, false);
    assert.match(skipped.reason, /OPENKIT_L6_REAL_CODEX=1/);

    const missingDeployment = evaluateRealCodexRunnerPrerequisites({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_REAL_CODEX: '1',
      },
      fileExists: () => true,
    });

    assert.equal(missingDeployment.enabled, false);
    assert.match(missingDeployment.reason, /OPENKIT_L6_NANOCORE_URL/);
  });

  it('streams A1 auth directly into a new 0600 account file without secret-bearing argv or env', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-auth-'));
    const targetPath = join(tempRoot, 'default', 'codex-home', 'auth.json');
    const calls = [];
    const spawnProcess = createFakeSshSpawn(
      `${JSON.stringify({ tokens: { access_token: fakeSecret } })}\n`,
      calls
    );

    await streamCodexAuthFromSsh({
      env: {
        HOME: '/tmp/home',
        OPENKIT_NANOCORE_TOKEN: fakeSecret,
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      },
      spawnProcess,
      targetPath,
    });

    assert.equal(readFileSync(targetPath, 'utf8').includes(fakeSecret), true);
    assert.equal(statSync(targetPath).mode & 0o777, 0o600);
    assert.deepEqual(calls[0].args, [
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
      'a1',
      'cat',
      '/home/ubuntu/.codex/auth.json',
    ]);
    assert.equal(calls[0].command, '/usr/bin/ssh');
    assert.equal(calls[0].options.detached, process.platform !== 'win32');
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.env.OPENKIT_NANOCORE_TOKEN, undefined);
    assert.equal(JSON.stringify(calls).includes(fakeSecret), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('removes a partial account file when the SSH source fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-auth-failure-'));
    const targetPath = join(tempRoot, 'default', 'codex-home', 'auth.json');
    const spawnProcess = createFakeSshSpawn('partial secret material', [], 23);

    await assert.rejects(
      () => streamCodexAuthFromSsh({ spawnProcess, targetPath }),
      /SSH auth transfer from a1 failed with exit code 23/
    );
    assert.equal(existsSync(targetPath), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('terminates and then kills a hung SSH auth stream inside its own deadline', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-auth-timeout-'));
    const targetPath = join(tempRoot, 'default', 'codex-home', 'auth.json');
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const signals = [];
    const pid = 41_317;
    child.pid = pid;
    child.stdout = stdout;
    stdout.write(fakeSecret);

    await assert.rejects(
      () =>
        streamCodexAuthFromSsh({
          killProcess: (targetPid, signal) => {
            signals.push({ signal, targetPid });
            if (signal === 'SIGKILL') {
              stdout.destroy();
              queueMicrotask(() => child.emit('close', null, signal));
            }
            return true;
          },
          processExitTimeoutMs: 100,
          spawnProcess: () => child,
          targetPath,
          terminationGraceMs: 5,
          timeoutMs: 10,
        }),
      /SSH auth transfer from a1 timed out/
    );
    assert.deepEqual(signals, [
      { signal: 'SIGTERM', targetPid: -pid },
      { signal: 'SIGKILL', targetPid: -pid },
    ]);
    assert.equal(existsSync(targetPath), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects an auth parent symlink before streaming A1 credentials', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-auth-parent-link-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const outsideRoot = join(tempRoot, 'outside');
    const authParent = join(
      dataRoot,
      'server/files/oauth/openai-codex/accounts/default/codex-home'
    );
    let authSyncCalls = 0;

    initializeRepository(repositoryRoot);
    mkdirSync(join(authParent, '..'), { recursive: true });
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, authParent, 'dir');

    await assert.rejects(
      () =>
        runRealCodexGoalModeStory({
          clients: authPreflightClients(),
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
          syncCodexAuth: async ({ targetPath }) => {
            authSyncCalls += 1;
            writeFileSync(targetPath, fakeSecret, { flag: 'wx', mode: 0o600 });
          },
        }),
      /secure OAuth account path/i
    );
    assert.equal(authSyncCalls, 0);
    assert.equal(existsSync(join(outsideRoot, 'auth.json')), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects a symlinked account slot before NanoCore can materialize it', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-account-slot-link-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const outsideRoot = join(tempRoot, 'outside');
    const accountRoot = join(dataRoot, 'server/files/oauth/openai-codex/accounts/default');
    let listAccountsCalls = 0;

    initializeRepository(repositoryRoot);
    mkdirSync(join(accountRoot, '..'), { recursive: true });
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, accountRoot, 'dir');

    await assert.rejects(
      () =>
        runRealCodexGoalModeStory({
          clients: {
            core: {
              oauth: {
                openaiCodex: {
                  listAccounts: async () => {
                    listAccountsCalls += 1;
                    mkdirSync(join(accountRoot, 'codex-home'), { recursive: true });
                    writeFileSync(join(accountRoot, 'account.json'), 'unexpected external write');
                    return {
                      accounts: [{ accountSlotId: 'default' }],
                      defaultAccountSlotId: 'default',
                    };
                  },
                },
              },
            },
            registry: {},
          },
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
          syncCodexAuth: async () => {
            throw new Error('Auth sync must not run for an unsafe account slot.');
          },
        }),
      /secure OAuth account path/i
    );
    assert.equal(listAccountsCalls, 0);
    assert.equal(existsSync(join(outsideRoot, 'account.json')), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects a linked account metadata file before NanoCore can write it', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-account-metadata-link-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const outsideMetadata = join(tempRoot, 'outside-account.json');
    const metadataPath = join(
      dataRoot,
      'server/files/oauth/openai-codex/accounts/default/account.json'
    );
    let listAccountsCalls = 0;

    initializeRepository(repositoryRoot);
    mkdirSync(join(metadataPath, '..'), { recursive: true });
    symlinkSync(outsideMetadata, metadataPath, 'file');

    await assert.rejects(
      () =>
        runRealCodexGoalModeStory({
          clients: {
            core: {
              oauth: {
                openaiCodex: {
                  listAccounts: async () => {
                    listAccountsCalls += 1;
                    writeFileSync(metadataPath, 'unexpected external write');
                    return {
                      accounts: [{ accountSlotId: 'default' }],
                      defaultAccountSlotId: 'default',
                    };
                  },
                },
              },
            },
            registry: {},
          },
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
          syncCodexAuth: async () => {
            throw new Error('Auth sync must not run for unsafe account metadata.');
          },
        }),
      /secure OAuth account metadata path/i
    );
    assert.equal(listAccountsCalls, 0);
    assert.equal(existsSync(outsideMetadata), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects symlinked and multiply linked auth files', async () => {
    for (const linkKind of ['hard-link', 'symbolic-link']) {
      const tempRoot = await mkdtemp(join(tmpdir(), `openkit-real-codex-auth-${linkKind}-`));
      const dataRoot = join(tempRoot, 'data');
      const evidenceDir = join(tempRoot, 'evidence');
      const repositoryRoot = join(tempRoot, 'repo');
      const outsideAuth = join(tempRoot, 'outside-auth.json');
      const authTarget = join(
        dataRoot,
        'server/files/oauth/openai-codex/accounts/default/codex-home/auth.json'
      );

      initializeRepository(repositoryRoot);
      mkdirSync(join(authTarget, '..'), { recursive: true });
      writeFileSync(outsideAuth, fakeSecret, { mode: 0o600 });
      chmodSync(outsideAuth, 0o600);
      if (linkKind === 'hard-link') {
        linkSync(outsideAuth, authTarget);
      } else {
        symlinkSync(outsideAuth, authTarget, 'file');
      }

      await assert.rejects(
        () =>
          runRealCodexGoalModeStory({
            clients: authPreflightClients(),
            env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
            stdout: () => {},
            syncCodexAuth: async () => {
              throw new Error('Existing auth files must not be replaced.');
            },
          }),
        /secure regular 0600 file/i
      );

      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects an unwritable evidence path before contacting NanoCore', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-evidence-preflight-'));
    const dataRoot = join(tempRoot, 'data');
    const evidencePath = join(tempRoot, 'evidence-file');
    const repositoryRoot = join(tempRoot, 'repo');
    let contactedNanoCore = false;

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(evidencePath, 'not a directory');

    await assert.rejects(
      () =>
        runRealCodexGoalModeStory({
          clients: {
            core: {
              oauth: {
                openaiCodex: {
                  listAccounts: async () => {
                    contactedNanoCore = true;
                    return {};
                  },
                },
              },
            },
            registry: {},
          },
          env: realRunnerEnv({ dataRoot, evidenceDir: evidencePath, repositoryRoot }),
          stdout: () => {},
        }),
      /evidence directory is not writable/i
    );
    assert.equal(contactedNanoCore, false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects an indirect evidence directory before contacting NanoCore', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-evidence-link-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const evidenceTarget = join(tempRoot, 'evidence-target');
    const repositoryRoot = join(tempRoot, 'repo');
    let contactedNanoCore = false;

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(evidenceTarget);
    symlinkSync(evidenceTarget, evidenceDir, 'dir');

    await assert.rejects(
      () =>
        runRealCodexGoalModeStory({
          clients: contactTrackingClients(() => {
            contactedNanoCore = true;
          }),
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
        }),
      /evidence directory must be a direct directory/i
    );
    assert.equal(contactedNanoCore, false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects every stale fixed evidence output before contacting NanoCore', async () => {
    for (const fileName of [
      'goal-mode-real-codex-failure.json',
      'goal-mode-real-codex-redaction-notes.md',
      'goal-mode-real-codex-result.json',
    ]) {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-evidence-stale-'));
      const dataRoot = join(tempRoot, 'data');
      const evidenceDir = join(tempRoot, 'evidence');
      const repositoryRoot = join(tempRoot, 'repo');
      let contactedNanoCore = false;

      initializeRepository(repositoryRoot);
      mkdirSync(dataRoot, { recursive: true });
      mkdirSync(evidenceDir);
      writeFileSync(join(evidenceDir, fileName), 'stale evidence');

      await assert.rejects(
        () =>
          runRealCodexGoalModeStory({
            clients: contactTrackingClients(() => {
              contactedNanoCore = true;
            }),
            env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
            stdout: () => {},
          }),
        /evidence output already exists/i
      );
      assert.equal(contactedNanoCore, false);

      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects a dangling fixed-output symlink before contacting NanoCore', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-evidence-dangling-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    let contactedNanoCore = false;

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(evidenceDir);
    symlinkSync(
      join(tempRoot, 'missing-result.json'),
      join(evidenceDir, 'goal-mode-real-codex-result.json'),
      'file'
    );

    await assert.rejects(
      () =>
        runRealCodexGoalModeStory({
          clients: contactTrackingClients(() => {
            contactedNanoCore = true;
          }),
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
        }),
      /evidence output already exists/i
    );
    assert.equal(contactedNanoCore, false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('does not follow a failure-evidence symlink created after CLI preflight', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-evidence-race-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const outsideFile = join(tempRoot, 'outside.txt');
    const childEntrypoint = join(tempRoot, 'race-child.mjs');

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(outsideFile, 'outside must remain unchanged');
    writeFileSync(
      childEntrypoint,
      `import { symlinkSync } from 'node:fs';
symlinkSync(${JSON.stringify(outsideFile)}, ${JSON.stringify(
        join(evidenceDir, 'goal-mode-real-codex-failure.json')
      )}, 'file');
process.exit(1);
`
    );

    await assert.rejects(() =>
      runRealCodexGoalModeCli({
        childEntrypoint,
        env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
        stdout: () => {},
      })
    );
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside must remain unchanged');

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('writes structured redacted failure evidence for a failed supervised child', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-failure-evidence-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const childEntrypoint = join(tempRoot, 'failure-child.mjs');

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(childEntrypoint, 'process.exit(1);\n');

    await assert.rejects(() =>
      runRealCodexGoalModeCli({
        childEntrypoint,
        env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
        now: new Date('2026-07-13T10:00:00.000Z'),
        stdout: () => {},
      })
    );

    const failure = readFileSync(join(evidenceDir, 'goal-mode-real-codex-failure.json'), 'utf8');
    assert.equal(failure.includes(fakeSecret), false);
    assert.equal(failure.includes(dataRoot), false);
    assert.deepEqual(JSON.parse(failure), {
      config: {
        nanoCoreConfigured: true,
        repositoryConfigured: true,
        tokenProvided: true,
        workspaceId: 'ws_demo',
      },
      failure: {
        kind: 'runtime_failure',
        message: 'Real Codex Goal Mode story failed.',
      },
      generatedAt: '2026-07-13T10:00:00.000Z',
      status: 'failed',
      story: {
        id: 'story-goal-mode-real-codex-release',
        title: 'Complete a real Codex Goal kernel run through MCP',
      },
    });
    assert.equal(
      statSync(join(evidenceDir, 'goal-mode-real-codex-failure.json')).mode & 0o777,
      0o600
    );

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('kills the supervised process group at the story deadline', { timeout: 5_000 }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-timeout-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const storyPath = join(tempRoot, 'timeout.story.md');
    const childEntrypoint = join(tempRoot, 'hanging-child.mjs');
    const pidFile = join(tempRoot, 'child-pids.json');

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(
      storyPath,
      readFileSync(DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH, 'utf8').replace(
        'timeout_seconds: 1800',
        'timeout_seconds: 1'
      )
    );
    writeFileSync(
      childEntrypoint,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, descendant: descendant.pid }));
setInterval(() => {}, 1000);
`
    );

    await assert.rejects(
      () =>
        runRealCodexGoalModeCli({
          childEntrypoint,
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          storyPath,
          stdout: () => {},
        }),
      /configured deadline/i
    );
    const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    await waitForProcessExit(pids.child);
    await waitForProcessExit(pids.descendant);
    const failure = JSON.parse(
      readFileSync(join(evidenceDir, 'goal-mode-real-codex-failure.json'), 'utf8')
    );
    assert.equal(failure.failure.kind, 'timeout');
    assert.equal(JSON.stringify(failure).includes(dataRoot), false);
    assert.equal(existsSync(join(evidenceDir, 'goal-mode-real-codex-result.json')), false);
    assert.equal(existsSync(join(evidenceDir, 'goal-mode-real-codex-redaction-notes.md')), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('preserves restart-required child exit without failure evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-restart-child-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const childEntrypoint = join(tempRoot, 'restart-child.mjs');

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(childEntrypoint, 'process.exit(75);\n');

    await assert.rejects(
      () =>
        runRealCodexGoalModeCli({
          childEntrypoint,
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
        }),
      /requires a NanoCore restart/i
    );
    assert.equal(existsSync(join(evidenceDir, 'goal-mode-real-codex-failure.json')), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('stops before MCP execution when provider and agent changes require a NanoCore restart', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-restart-required-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const authTarget = join(
      dataRoot,
      'server/files/oauth/openai-codex/accounts/default/codex-home/auth.json'
    );
    const calls = [];
    const state = { goalResolved: false, workspaceApplied: false };
    const runtimeConfig = {
      agentContent: codexAgentContent({ model: 'gpt-5.1', ref: 'openai' }),
      providerContent: null,
      reloadResults: [restartRequiredReload(['providers', 'agents'])],
    };

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    const clients = createFakeGoalClients({
      authTarget,
      calls,
      repositoryRoot,
      runtimeConfig,
      state,
    });

    await assert.rejects(
      () =>
        runRealCodexGoalModeStory({
          clients,
          env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
          syncCodexAuth: async ({ targetPath }) => {
            assert.equal(targetPath, authTarget);
            writeFileSync(targetPath, '{}\n', { flag: 'wx', mode: 0o600 });
          },
        }),
      new Error(
        'Real Codex runtime configuration requires a NanoCore restart. Restart NanoCore and rerun the story.'
      )
    );

    const expectedModel = 'openai-codex/gpt-5.6-sol';
    const providerConfig = JSON.parse(runtimeConfig.providerContent);

    assert.equal(runtimeConfig.providerContent, canonicalCodexProviderContent());
    assert.equal(providerConfig.defaultModel, expectedModel);
    assert.deepEqual(providerConfig.models, [expectedModel]);
    assert.equal(JSON.parse(runtimeConfig.agentContent).provider.model, expectedModel);
    assert.deepEqual(
      calls.filter((call) => call.surface.startsWith('core-config-')).map((call) => call.surface),
      [
        'core-config-list',
        'core-config-create',
        'core-config-read',
        'core-config-update',
        'core-config-reload',
      ]
    );
    assert.equal(
      calls.some((call) => call.surface === 'mcp'),
      false
    );
    assert.equal(existsSync(join(evidenceDir, 'goal-mode-real-codex-result.json')), false);
    assert.equal(existsSync(join(evidenceDir, 'goal-mode-real-codex-failure.json')), false);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('consumes only the safe workspace data-source deferral before the post-restart rerun', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-goal-'));
    const dataRoot = join(tempRoot, 'data');
    const evidenceDir = join(tempRoot, 'evidence');
    const repositoryRoot = join(tempRoot, 'repo');
    const authTarget = join(
      dataRoot,
      'server/files/oauth/openai-codex/accounts/default/codex-home/auth.json'
    );
    const calls = [];
    const state = { goalResolved: false, workspaceApplied: false };
    const existingAuthSecret = 'existing-server-auth-that-must-not-leak';
    let authSyncCalls = 0;

    initializeRepository(repositoryRoot);
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(join(authTarget, '..'), { recursive: true });
    writeFileSync(authTarget, existingAuthSecret, { mode: 0o600 });
    const clients = createFakeGoalClients({
      authTarget,
      calls,
      repositoryRoot,
      runtimeConfig: {
        agentContent: codexAgentJsoncContent({
          model: REAL_CODEX_GOAL_MODEL,
          ref: 'openai_codex',
        }),
        providerContent: canonicalCodexProviderJsoncContent(),
        reloadResults: [
          workspaceDataSourcesDeferredReload('dry-run'),
          workspaceDataSourcesDeferredReload('applied'),
          noOpReload(2),
        ],
      },
      state,
    });

    const result = await runRealCodexGoalModeStory({
      clients,
      env: realRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
      now: new Date('2026-07-13T10:00:00.000Z'),
      stdout: () => {},
      syncCodexAuth: async () => {
        authSyncCalls += 1;
      },
    });

    assert.equal(authSyncCalls, 0);
    assert.equal(readFileSync(authTarget, 'utf8'), existingAuthSecret);
    assert.equal(statSync(authTarget).mode & 0o777, 0o600);
    assert.equal(
      calls.some((call) => call.surface === 'core-config-create'),
      false
    );
    assert.equal(
      calls.some((call) => call.surface === 'core-config-update'),
      false
    );
    assert.equal(calls.filter((call) => call.surface === 'core-oauth-status').length >= 1, true);
    assert.deepEqual(
      calls.filter((call) => call.surface === 'core-config-reload').map((call) => call.input),
      [
        { dryRun: true, mode: 'strict' },
        { dryRun: false, mode: 'strict' },
        { dryRun: true, mode: 'strict' },
      ]
    );
    assert.equal(state.workspaceApplied, true);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.goal, {
      completedTaskCount: 1,
      goalId: 'goal_1',
      status: 'completed',
      turnId: 'turn_1',
    });
    assert.equal(result.git.statusShort, `?? ${REAL_CODEX_GOAL_PROOF_PATH}`);
    assert.equal(
      readFileSync(join(repositoryRoot, REAL_CODEX_GOAL_PROOF_PATH), 'utf8'),
      REAL_CODEX_GOAL_PROOF_CONTENT
    );
    assert.equal(result.aep.controlMode, 'direct-nanocore');
    assert.equal(result.aep.imageRef, 'openkit/worker-codex:dev');
    assert.equal(result.inference.backendType, 'openshell');
    assert.equal(result.inference.backendVersion, '0.0.80');
    assert.equal(result.inference.providerRef, 'openai_codex');
    assert.equal(result.inference.modelId, REAL_CODEX_GOAL_MODEL);
    assert.deepEqual(result.runtime, {
      capabilityCallCount: 1,
      usageRecordCount: 1,
    });
    assert.equal(result.reviews.workspaceApplyStatus, 'applied');
    assert.equal(result.reviews.goalAdvanceOutcome, 'complete_goal');
    assert.equal(existsSync(join(evidenceDir, 'goal-mode-real-codex-result.json')), true);
    assert.equal(existsSync(join(evidenceDir, 'goal-mode-real-codex-redaction-notes.md')), true);
    assert.equal(
      statSync(join(evidenceDir, 'goal-mode-real-codex-result.json')).mode & 0o777,
      0o600
    );
    assert.equal(
      statSync(join(evidenceDir, 'goal-mode-real-codex-redaction-notes.md')).mode & 0o777,
      0o600
    );

    const serializedResult = JSON.stringify(result);
    assert.equal(serializedResult.includes(fakeSecret), false);
    assert.equal(serializedResult.includes(existingAuthSecret), false);
    assert.equal(serializedResult.includes('private-user@example.test'), false);
    assert.equal(serializedResult.includes(dataRoot), false);
    assert.equal(serializedResult.includes(authTarget), false);
    assert.equal(
      readFileSync(join(evidenceDir, 'goal-mode-real-codex-result.json'), 'utf8').includes(
        existingAuthSecret
      ),
      false
    );
    assert.deepEqual(
      calls.filter((call) => call.surface === 'mcp').map((call) => call.name),
      [
        'openkit.read_status',
        'openkit.read_runtime_diagnostics',
        'openkit.link_repository',
        'openkit.read_repositories',
        'openkit.create_thread',
        'openkit.start_goal',
        'openkit.read_goal',
        'openkit.draft_goal_plan',
        'openkit.approve_goal_plan',
        'openkit.step_goal',
        'openkit.read_action_center',
        'openkit.resolve_action_center_item',
        'openkit.read_goal',
        'openkit.read_thread',
        'openkit.read_agent_environment_package_snapshots',
        'openkit.read_capability_usage',
      ]
    );

    const startGoalCall = calls.find((call) => call.name === 'openkit.start_goal');
    assert.equal(startGoalCall.input.objective, REAL_CODEX_GOAL_OBJECTIVE);
    const goalReviewCall = calls.find((call) => call.name === 'openkit.resolve_action_center_item');
    assert.equal(goalReviewCall.input.actionId, 'accept_review');
    assert.equal(goalReviewCall.input.decision, 'accept');

    rmSync(tempRoot, { force: true, recursive: true });
  });
});

/**
 * Builds complete opt-in environment input for one test deployment.
 *
 * @param {{ dataRoot: string, evidenceDir: string, repositoryRoot: string }} input Local test paths.
 * @returns {Record<string, string>} Runner environment.
 */
function realRunnerEnv(input) {
  return {
    OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_L6_EVIDENCE_DIR: input.evidenceDir,
    OPENKIT_L6_GOAL_REPO_ROOT: input.repositoryRoot,
    OPENKIT_L6_NANOCORE_DATA_ROOT: input.dataRoot,
    OPENKIT_L6_NANOCORE_URL: 'http://127.0.0.1:54001',
    OPENKIT_L6_REAL_CODEX: '1',
    OPENKIT_NANOCORE_TOKEN: fakeSecret,
  };
}

/**
 * Builds the public OAuth surface needed to reach auth-path validation.
 *
 * @returns {{ core: Record<string, any>, registry: Record<string, any> }} Minimal clients.
 */
function authPreflightClients() {
  return {
    core: {
      oauth: {
        openaiCodex: {
          getAccountStatus: async () => ({ status: 'logged_in' }),
          listAccounts: async () => ({
            accounts: [{ accountSlotId: 'default' }],
            defaultAccountSlotId: 'default',
          }),
        },
      },
    },
    registry: {},
  };
}

/**
 * Builds a client substitute that records the first NanoCore contact.
 *
 * @param {() => void} onContact Contact callback.
 * @returns {{ core: Record<string, any>, registry: Record<string, any> }} Minimal clients.
 */
function contactTrackingClients(onContact) {
  return {
    core: {
      oauth: {
        openaiCodex: {
          listAccounts: async () => {
            onContact();
            return {};
          },
        },
      },
    },
    registry: {},
  };
}

/**
 * Waits briefly for one killed test process to disappear from the process table.
 *
 * @param {number} pid Process id.
 */
async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await wait(25);
  }
  assert.fail(`Process ${pid} remained alive after the supervised deadline.`);
}

/**
 * Creates a deterministic child-process substitute for the SSH auth stream.
 *
 * @param {string} content Fake remote stdout content.
 * @param {Array<Record<string, any>>} calls Spawn call ledger.
 * @param {number} exitCode Fake process exit code.
 * @returns {Function} Spawn substitute.
 */
function createFakeSshSpawn(content, calls, exitCode = 0) {
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
 * Initializes a clean disposable repository with one baseline commit.
 *
 * @param {string} repositoryRoot Repository root.
 */
function initializeRepository(repositoryRoot) {
  mkdirSync(repositoryRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, 'README.md'), '# Disposable L6 Repository\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot });
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=OpenKit L6',
      '-c',
      'user.email=l6@example.test',
      'commit',
      '--quiet',
      '-m',
      'chore: initialize disposable repository',
    ],
    { cwd: repositoryRoot }
  );
}

/**
 * Creates public MCP and Core Client substitutes for one successful real Goal flow.
 *
 * @param {{ authTarget: string, calls: Array<Record<string, any>>, repositoryRoot: string, runtimeConfig: { agentContent: string, providerContent: string | null, reloadResults: Array<Record<string, any>> }, state: { goalResolved: boolean, workspaceApplied: boolean } }} input Fixture inputs.
 * @returns {{ core: Record<string, any>, registry: Record<string, any> }} Fake clients.
 */
function createFakeGoalClients(input) {
  const plan = goalPlanFixture();
  const finalGoal = completedGoalFixture();
  const workspaceRow = {
    artifactId: 'artifact_workspace_1',
    id: 'workspace-review:swr_1',
    kind: 'workspace_review',
    source: { artifactId: 'artifact_workspace_1', type: 'artifact' },
  };
  const goalReviewRow = {
    id: 'goal-review:review_1',
    kind: 'artifact_review',
    source: {
      goalId: 'goal_1',
      reviewId: 'review_1',
      taskId: 'task_1',
      threadId: 'th_1',
      type: 'goal_review',
      verdict: 'accept',
    },
    actions: [{ kind: 'accept_review' }],
  };
  const registry = {
    listTools: () => [
      { name: 'openkit.start_goal' },
      { name: 'openkit.step_goal' },
      { name: 'openkit.resolve_action_center_item' },
    ],
    callTool: async (name, toolInput) => {
      input.calls.push({ input: toolInput, name, surface: 'mcp' });

      switch (name) {
        case 'openkit.read_status':
          return { raw: { meta: { mode: 'server', status: 'ready' } } };
        case 'openkit.read_runtime_diagnostics':
          return {
            raw: {
              boot: { acceptingProductWork: true },
              providers: {
                diagnostics: [],
                registry: [{ id: 'openai_codex' }],
              },
            },
          };
        case 'openkit.link_repository':
          return { raw: { id: 'repo_1', status: 'ready' } };
        case 'openkit.read_repositories':
          return {
            raw: {
              diagnostics: { defaultResource: { ready: true } },
              repositories: {
                defaultResource: { diagnosticsStatus: 'ready', resourceId: 'repo_1' },
                items: [{ diagnosticsStatus: 'ready', resourceId: 'repo_1' }],
              },
            },
          };
        case 'openkit.create_thread':
          return { raw: { id: 'th_1' } };
        case 'openkit.start_goal':
          return { raw: { goal: planningGoalFixture() } };
        case 'openkit.read_goal':
          return { raw: { goal: input.state.goalResolved ? finalGoal : planningGoalFixture() } };
        case 'openkit.draft_goal_plan':
          return {
            raw: {
              goal: { ...planningGoalFixture(), status: 'awaiting_plan_approval' },
              plan,
              planItemId: 'it_plan_1',
              status: 'awaiting_plan_approval',
            },
          };
        case 'openkit.approve_goal_plan':
          return {
            raw: {
              goal: { ...planningGoalFixture(), status: 'running' },
              readyTasks: [{ status: 'ready', taskId: 'task_1' }],
              startsWorkerTurn: false,
            },
          };
        case 'openkit.step_goal':
          return {
            raw: {
              decision: { outcome: 'review', stopReason: 'completed' },
              goal: { ...planningGoalFixture(), status: 'reviewing' },
              pendingAttention: { kind: 'review' },
              worker: {
                checkpointStage: 'completed',
                evidence: { artifactIds: ['artifact_1'], itemIds: ['it_assistant_1'] },
                stopReason: 'completed',
                turnId: 'turn_1',
                workerSessionId: 'as_1',
              },
            },
          };
        case 'openkit.read_action_center':
          return { raw: { items: [workspaceRow, goalReviewRow] } };
        case 'openkit.resolve_action_center_item':
          input.state.goalResolved = true;
          return {
            raw: {
              advance: { outcome: 'complete_goal' },
              review: { resolvedAt: '2026-07-13T10:00:00.000Z' },
            },
          };
        case 'openkit.read_thread':
          return {
            raw: {
              items: {
                items: [
                  {
                    id: 'it_assistant_1',
                    status: 'completed',
                    turnId: 'turn_1',
                    type: 'assistant-message',
                  },
                ],
              },
              thread: { id: 'th_1' },
            },
          };
        case 'openkit.read_agent_environment_package_snapshots':
          return { raw: { items: [aepFixture()] } };
        case 'openkit.read_capability_usage':
          return { raw: capabilityUsageFixture() };
        default:
          throw new Error(`Unexpected MCP tool: ${name}`);
      }
    },
    readResource: async (uri) => {
      input.calls.push({ surface: 'resource', uri });

      if (uri.endsWith('/evidence-bundles')) {
        return { text: JSON.stringify({ evidenceBundles: [{ id: 'ev_1', turnId: 'turn_1' }] }) };
      }
      if (uri.endsWith('/runtime-evidence')) {
        return {
          text: JSON.stringify({
            runtimeEvidence: [
              {
                backendType: 'openshell',
                backendVersion: '0.0.80',
                evidenceBundleIds: ['ev_1'],
                id: 'runtime_ev_1',
                outcome: 'succeeded',
                turnId: 'turn_1',
              },
            ],
          }),
        };
      }
      if (uri.endsWith('/audit/events')) {
        return {
          text: JSON.stringify({
            auditEvents: [
              {
                action: 'capability.finish',
                capabilityCallId: 'cap_1',
                outcome: 'succeeded',
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected resource: ${uri}`);
    },
  };
  const core = {
    app: {
      listWorkspaceSyncReviews: async () => ({
        items: [
          {
            artifactId: 'artifact_workspace_1',
            review: { id: 'swr_1', status: 'pending' },
          },
        ],
      }),
      submitWorkspaceSyncReviewDecision: async (workspaceId, reviewId, decision) => {
        input.calls.push({ decision, reviewId, surface: 'core-workspace-review', workspaceId });
        assert.equal(input.state.goalResolved, false);
        input.state.workspaceApplied = true;
        mkdirSync(join(input.repositoryRoot, 'docs'), { recursive: true });
        writeFileSync(
          join(input.repositoryRoot, REAL_CODEX_GOAL_PROOF_PATH),
          REAL_CODEX_GOAL_PROOF_CONTENT
        );
        return {
          review: { id: reviewId, status: 'accepted' },
          workspaceApplyResult: {
            appliedPaths: [REAL_CODEX_GOAL_PROOF_PATH],
            status: 'applied',
          },
        };
      },
    },
    oauth: {
      openaiCodex: {
        getAccountStatus: async () => {
          input.calls.push({ surface: 'core-oauth-status' });
          return {
            accountLabel: 'private-user@example.test',
            accountSlotId: 'default',
            boundProviderIds: ['openai_codex'],
            isDefault: true,
            providerId: 'openai_codex',
            status: 'logged_in',
          };
        },
        listAccounts: async () => {
          mkdirSync(join(input.authTarget, '..'), { recursive: true });
          return {
            accounts: [
              {
                accountSlotId: 'default',
                boundProviderIds: ['openai_codex'],
                isDefault: true,
                providerId: 'openai_codex',
                status: 'logged_out',
              },
            ],
            defaultAccountSlotId: 'default',
          };
        },
      },
    },
    runtimeConfig: {
      createFile: async (runtimeInput) => {
        input.calls.push({ input: runtimeInput, surface: 'core-config-create' });
        input.runtimeConfig.providerContent = runtimeInput.content;
        return { diagnostics: [], file: { id: runtimeInput.id, revision: 'provider_rev_1' } };
      },
      getFile: async (id) => {
        input.calls.push({ id, surface: 'core-config-read' });
        const provider = id === 'providers/openai-codex.provider.jsonc';
        const content = provider
          ? input.runtimeConfig.providerContent
          : input.runtimeConfig.agentContent;
        assert.equal(typeof content, 'string');
        return {
          content,
          file: {
            id,
            kind: provider ? 'provider' : 'agent',
            revision: provider ? 'provider_rev_1' : 'agent_rev_1',
          },
        };
      },
      listFiles: async () => {
        input.calls.push({ surface: 'core-config-list' });
        return {
          files: [
            { id: 'agents/codex.agent.jsonc' },
            ...(input.runtimeConfig.providerContent
              ? [{ id: 'providers/openai-codex.provider.jsonc' }]
              : []),
          ],
        };
      },
      reload: async (runtimeInput) => {
        input.calls.push({ input: runtimeInput, surface: 'core-config-reload' });
        const result = input.runtimeConfig.reloadResults.shift();
        assert(result, 'Fake runtime config reload response is missing.');
        return result;
      },
      updateFile: async (runtimeInput) => {
        input.calls.push({ input: runtimeInput, surface: 'core-config-update' });
        const provider = runtimeInput.id === 'providers/openai-codex.provider.jsonc';

        if (provider) {
          input.runtimeConfig.providerContent = runtimeInput.content;
        } else {
          input.runtimeConfig.agentContent = runtimeInput.content;
        }

        return {
          diagnostics: [],
          file: {
            id: runtimeInput.id,
            revision: provider ? 'provider_rev_2' : 'agent_rev_2',
          },
        };
      },
    },
  };

  return { core, registry };
}

/**
 * Returns the canonical provider file content used by the real story.
 *
 * @returns {string} Canonical provider JSON source.
 */
function canonicalCodexProviderContent() {
  return `${JSON.stringify(
    {
      defaultModel: REAL_CODEX_GOAL_MODEL,
      displayName: 'OpenAI Codex',
      extensions: { openkit: { codexOAuth: { accountSlotId: 'default' } } },
      id: 'openai_codex',
      kind: 'oauth',
      models: [REAL_CODEX_GOAL_MODEL],
      vendor: 'openai_codex',
    },
    null,
    2
  )}\n`;
}

/** Returns semantically canonical provider JSONC with comments and a trailing comma. */
function canonicalCodexProviderJsoncContent() {
  return canonicalCodexProviderContent()
    .replace('{\n', '{\n  // The runner must compare JSONC semantically.\n')
    .replace('\n}', ',\n}');
}

/**
 * Returns a Codex agent file with the requested provider selection.
 *
 * @param {{ model: string, ref: string }} provider Provider selection.
 * @returns {string} Agent JSON source.
 */
function codexAgentContent(provider) {
  return `${JSON.stringify(
    {
      id: 'agent_codex_host',
      provider,
      runtime: { adapter: 'codex-app-server', kind: 'codex', version: '0.0.2' },
      schemaVersion: 1,
    },
    null,
    2
  )}\n`;
}

/**
 * Returns a semantically canonical Codex agent JSONC source.
 *
 * @param {{ model: string, ref: string }} provider Provider selection.
 * @returns {string} Agent JSONC source.
 */
function codexAgentJsoncContent(provider) {
  return codexAgentContent(provider)
    .replace('{\n', '{\n  // Existing comments must not force a rewrite.\n')
    .replace('\n}', ',\n}');
}

/**
 * Returns the strict reload response produced before a required restart.
 *
 * @param {string[]} paths Restart-required config paths.
 * @returns {Record<string, any>} Rejected reload response.
 */
function restartRequiredReload(paths) {
  const requiresRestart = paths.map((path) => ({
    action: 'requires-restart',
    category: 'restart-required',
    path,
    summary: `${path} require restart.`,
  }));

  return {
    plan: {
      applied: [],
      deferred: [],
      nextVersion: 2,
      previousVersion: 1,
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
 * Returns the exact strict dry-run no-op shape expected after restart.
 *
 * @param {number} previousVersion Current runtime config version.
 * @returns {Record<string, any>} Applied reload response.
 */
function noOpReload(previousVersion = 1) {
  return {
    plan: {
      applied: [],
      deferred: [],
      nextVersion: previousVersion + 1,
      previousVersion,
      rejected: [],
      requiresRestart: [],
      warnings: [],
    },
    runtimeConfig: { pendingRestart: [], staleSessions: [] },
    status: 'dry-run',
  };
}

/**
 * Returns the only lazy workspace config response the runner may safely consume.
 *
 * @param {'applied' | 'dry-run'} status Reload status.
 * @returns {Record<string, any>} Reload response with one workspace data-source deferral.
 */
function workspaceDataSourcesDeferredReload(status) {
  return {
    plan: {
      applied: [],
      deferred: [
        {
          action: 'deferred',
          category: 'session-scoped',
          path: 'workspaceDataSources',
          summary: 'Workspace data source catalog changed for future sessions.',
        },
      ],
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
 * Returns one planning Goal read model fixture.
 *
 * @returns {Record<string, any>} Goal fixture.
 */
function planningGoalFixture() {
  return {
    goalId: 'goal_1',
    objective: REAL_CODEX_GOAL_OBJECTIVE,
    status: 'planning',
    taskCounts: { completed: 0 },
  };
}

/**
 * Returns one completed Goal read model fixture.
 *
 * @returns {Record<string, any>} Goal fixture.
 */
function completedGoalFixture() {
  return {
    goalId: 'goal_1',
    objective: REAL_CODEX_GOAL_OBJECTIVE,
    status: 'completed',
    taskCounts: { completed: 1 },
    terminalState: { status: 'completed', stopReason: 'completed' },
    terminalSummary: {
      artifactIds: ['artifact_1'],
      blockedTaskIds: [],
      completedTaskIds: ['task_1'],
      risks: [],
      skippedTaskIds: [],
      suggestedNextWork: [],
      verificationEvidence: [
        {
          command: 'git diff --check',
          status: 'passed',
          summary: 'The proof file passed verification.',
        },
      ],
    },
  };
}

/**
 * Returns the exact one-task reviewable Goal plan fixture.
 *
 * @returns {Record<string, any>} Goal plan fixture.
 */
function goalPlanFixture() {
  return {
    assumptions: [],
    goalSummary: 'Write the bounded L6 proof file.',
    questions: [],
    risks: [],
    schemaVersion: 1,
    tasks: [
      {
        acceptanceCriteria: ['Only the exact proof file is changed.'],
        contextBudgetTokens: 12_000,
        dependsOnTaskIds: [],
        escalationConditions: [],
        expectedArtifacts: [{ description: 'The exact proof file.', kind: 'document' }],
        objective: REAL_CODEX_GOAL_OBJECTIVE,
        resources: [],
        reviewPolicy: {
          instructions: 'Require explicit human acceptance.',
          required: true,
          reviewers: ['human'],
        },
        taskId: 'task_1',
        title: 'Create the L6 proof file',
        verificationChecks: [
          {
            command: 'git diff --check',
            description: 'Check the resulting diff.',
            kind: 'command',
          },
        ],
      },
    ],
    verificationApproach: 'Run git diff --check and review the exact file.',
  };
}

/**
 * Returns one product-safe trusted-inference AEP fixture.
 *
 * @returns {Record<string, any>} AEP fixture.
 */
function aepFixture() {
  return {
    backendKind: 'openshell',
    runtimeKind: 'codex',
    snapshot: {
      backend: {
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      },
      control: { mode: 'direct-nanocore' },
      credentials: { declarations: [] },
      llm: {
        mode: 'gateway',
        routes: [
          {
            credentialVisibility: 'placeholder',
            endpoint: { upstream: { kind: 'nanocore-gateway' } },
            model: REAL_CODEX_GOAL_MODEL,
            providerInstanceId: 'openai_codex',
          },
        ],
      },
      policy: { secrets: { visibility: 'none' } },
      providers: { attachments: [] },
      runtime: {
        image: {
          kind: 'container-image',
          pullPolicy: 'if-not-present',
          ref: 'openkit/worker-codex:dev',
        },
      },
      vault: { grants: [], references: [] },
    },
    turnId: 'turn_1',
  };
}

/**
 * Returns linked worker-inference and terminal runtime usage fixtures.
 *
 * @returns {Record<string, any>} Capability usage fixture.
 */
function capabilityUsageFixture() {
  return {
    capabilityCalls: [
      {
        family: 'llm',
        id: 'cap_1',
        packageSnapshotId: 'aepsnap_1',
        providerRef: 'openai_codex',
        serviceRef: 'worker-inference-gateway',
        status: 'succeeded',
        turnId: 'turn_1',
      },
      {
        capabilityId: 'runtime.worker_turn',
        family: 'runtime',
        id: 'cap_runtime_1',
        operation: 'worker.checkpoint.terminal',
        providerRef: 'nanocore-runtime',
        serviceRef: 'worker-checkpoint',
        status: 'succeeded',
        turnId: 'turn_1',
      },
    ],
    usageRecords: [
      {
        capabilityCallId: 'cap_1',
        category: 'llm',
        modelId: REAL_CODEX_GOAL_MODEL,
        providerRef: 'openai_codex',
        quantity: 128,
        turnId: 'turn_1',
        unit: 'tokens',
      },
      {
        capabilityCallId: 'cap_runtime_1',
        category: 'runtime',
        providerRef: 'nanocore-runtime',
        quantity: 1,
        source: 'worker-checkpoint-terminal',
        turnId: 'turn_1',
        unit: 'sandbox_sessions',
      },
    ],
  };
}
