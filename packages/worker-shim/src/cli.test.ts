// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync as writeRawFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseWorkerShimArgs,
  runWorkerShimCli,
  runWorkerShim as runWorkerShimImplementation,
  type WorkerProcessRunner,
  type WorkerShimEnvironment,
  type WorkerShimRunOptions,
} from './cli.js';
import type { WorkerControlFetch } from './control-client.js';

type WorkspaceGitModule = typeof import('./workspace-git.js');
type MaterializeWorkspaceGitInputs = WorkspaceGitModule['materializeWorkspaceGitInputs'];
type PublishWorkspaceGitSnapshots = WorkspaceGitModule['publishWorkspaceGitSnapshots'];

/** Optional deterministic barriers used by focused shared-lifecycle tests. */
const processFixtureLifecycle = vi.hoisted(() => ({
  collectBarrier: null as Promise<void> | null,
  collectResult: null as {
    assistantText: string | null;
    diagnostics?: Readonly<Record<string, string>>;
    status: 'completed' | 'failed' | 'interrupted';
    stopReason: string;
  } | null,
  finalizeBarrier: null as Promise<void> | null,
  markCollectStarted: null as (() => void) | null,
  markFinalizeStarted: null as (() => void) | null,
  prepareFailure: null as ((stateRoot: string) => Promise<never>) | null,
}));

/** Deterministic route-readiness barrier for the Sandbox Integration seam. */
const integrationFixtureLifecycle = vi.hoisted(() => ({
  opens: 0,
  ready: null as Promise<void> | null,
}));

/** Optional wrappers around the real workspace-Git owner used by one orchestration test. */
const workspaceGitFixtureLifecycle = vi.hoisted(() => ({
  materialize: null as MaterializeWorkspaceGitInputs | null,
  publish: null as PublishWorkspaceGitSnapshots | null,
}));

const CODEX_TEST_UUID = '0198a0b1-c2d3-74e5-8f60-123456789abc';

const processFixtureAdapter = vi.hoisted(() => ({
  mode: 'bounded-turn' as const,
  /** Returns one fixed native Node command for process-supervisor tests. */
  async prepare(input: {
    childEnvironment: Record<string, string>;
    stateRoot: string;
    turnInput: string;
  }) {
    if (processFixtureLifecycle.prepareFailure) {
      await processFixtureLifecycle.prepareFailure(input.stateRoot);
    }
    return {
      argv: [process.execPath, '-e', input.turnInput],
      captureStdout: false,
      environment: input.childEnvironment,
      finalize: async () => {
        processFixtureLifecycle.markFinalizeStarted?.();
        await processFixtureLifecycle.finalizeBarrier;
      },
    };
  },
  /** Maps the fixed process exit to the shared normalized result. */
  async collect(input: { processResult: { exitCode: number | null; interrupted: boolean } }) {
    processFixtureLifecycle.markCollectStarted?.();
    await processFixtureLifecycle.collectBarrier;
    if (processFixtureLifecycle.collectResult) {
      return processFixtureLifecycle.collectResult;
    }
    const completed = input.processResult.exitCode === 0 && !input.processResult.interrupted;

    return {
      assistantText: null,
      status: completed ? 'completed' : 'failed',
      stopReason: completed ? 'completed' : 'fixture-process-failed',
    };
  },
}));

vi.mock('./adapter-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapter-registry.js')>();

  return {
    ...actual,
    WORKER_ADAPTERS: { ...actual.WORKER_ADAPTERS, 'fixture-process': processFixtureAdapter },
  };
});

vi.mock('./integration-client.js', () => ({
  SANDBOX_INTEGRATION_ROUTE_NAMESPACES: ['/worker-control/', '/inference/', '/capabilities/'],
  // Fixture-only value; the production target is frozen only by loopback shape and cross-projection equality.
  SANDBOX_INTEGRATION_TARGET: '127.0.0.1:17891',
  openSandboxIntegration: async () => {
    integrationFixtureLifecycle.opens += 1;
    return {
      bindTurnRouteTokens: () => undefined,
      clearTurnRouteTokens: () => undefined,
      close: async () => undefined,
      ready: integrationFixtureLifecycle.ready ?? Promise.resolve(),
    };
  },
}));

vi.mock('./workspace-git.js', async (importOriginal) => {
  const actual = await importOriginal<WorkspaceGitModule>();

  return {
    ...actual,
    materializeWorkspaceGitInputs: (
      ...args: Parameters<MaterializeWorkspaceGitInputs>
    ): ReturnType<MaterializeWorkspaceGitInputs> =>
      workspaceGitFixtureLifecycle.materialize
        ? workspaceGitFixtureLifecycle.materialize(...args)
        : actual.materializeWorkspaceGitInputs(...args),
    publishWorkspaceGitSnapshots: (
      ...args: Parameters<PublishWorkspaceGitSnapshots>
    ): ReturnType<PublishWorkspaceGitSnapshots> =>
      workspaceGitFixtureLifecycle.publish
        ? workspaceGitFixtureLifecycle.publish(...args)
        : actual.publishWorkspaceGitSnapshots(...args),
  };
});

describe('worker shim CLI parsing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith('/commands/poll')
            ? { commands: [] }
            : url.endsWith('/events/append') || url.endsWith('/final-status')
              ? { accepted: true, diagnostics: [], schemaVersion: 1 }
              : {}
        ),
        { status: 200 }
      );
    });
  });

  afterEach(() => {
    integrationFixtureLifecycle.opens = 0;
    integrationFixtureLifecycle.ready = null;
    processFixtureLifecycle.collectBarrier = null;
    processFixtureLifecycle.collectResult = null;
    processFixtureLifecycle.finalizeBarrier = null;
    processFixtureLifecycle.markCollectStarted = null;
    processFixtureLifecycle.markFinalizeStarted = null;
    processFixtureLifecycle.prepareFailure = null;
    workspaceGitFixtureLifecycle.materialize = null;
    workspaceGitFixtureLifecycle.publish = null;
    vi.unstubAllGlobals();
  });

  it('parses worker shim arguments', () => {
    expect(
      parseWorkerShimArgs([
        '--package',
        '/openkit/config/package.json',
        '--session-dir',
        '/openkit/session',
        '--dry-run',
      ])
    ).toEqual({
      dryRun: true,
      packagePath: '/openkit/config/package.json',
      sessionDir: '/openkit/session',
    });
  });

  it('prints help without requiring a package or installing signal handlers', async () => {
    const output: string[] = [];
    const signalListeners = {
      interrupt: getEventListeners(process, 'SIGINT').length,
      termination: getEventListeners(process, 'SIGTERM').length,
    };

    await expect(
      runWorkerShimCli(['--help'], (line) => output.push(line))
    ).resolves.toBeUndefined();

    expect(output).toEqual([
      'Usage: openkit-worker-shim --package <path> [--session-dir <path>] [--dry-run]\n',
    ]);
    expect(getEventListeners(process, 'SIGINT')).toHaveLength(signalListeners.interrupt);
    expect(getEventListeners(process, 'SIGTERM')).toHaveLength(signalListeners.termination);
  });

  it('rejects missing required arguments with product-safe errors', () => {
    expect(() => parseWorkerShimArgs(['--session-dir', '/openkit/session'])).toThrow(
      'Missing required --package argument.'
    );
  });

  it('rejects unsupported CLI override flags', () => {
    expect(() =>
      parseWorkerShimArgs([
        '--package',
        '/openkit/config/package.json',
        '--artifact-dir',
        '/tmp/override',
      ])
    ).toThrow('Unsupported worker shim argument: --artifact-dir');
  });

  it('validates the local Integration bootstrap before completing a dry run', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-dry-run-control-'));
    const packagePath = join(sessionDir, 'package.json');
    writeRawFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
          bindings: {
            capabilities: {
              pathPrefix: '/capabilities/',
              tokenRef: 'runtime://openkit/capability-token',
            },
            inference: {
              pathPrefix: '/inference/',
              tokenRef: 'runtime://openkit/inference-token',
            },
            workerControl: {
              pathPrefix: '/worker-control/',
              tokenRef: 'runtime://openkit/worker-control-token',
            },
          },
          mode: 'sandbox-integration',
        },
        extensions: { openkit: { turnInput: 'Validate the image.' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: {
          command: {
            argv: ['openkit-worker-shim'],
            workingDirectory: sessionDir,
          },
        },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs([
          '--package',
          packagePath,
          '--session-dir',
          sessionDir,
          '--dry-run',
        ]),
        environment: { OPENKIT_WORKER_INFERENCE_TOKEN: 'image-smoke-placeholder' },
      })
    ).resolves.toEqual({ exitCode: 0, signal: null, status: 'completed' });
    expect(existsSync(join(sessionDir, 'events.jsonl'))).toBe(false);
    expect(existsSync(join(sessionDir, 'items.jsonl'))).toBe(false);
    expect(existsSync(join(sessionDir, 'artifacts.jsonl'))).toBe(false);
  });

  it('rejects missing, direct NanoCore, or shared Integration credentials', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-dry-run-mode-'));
    const missingModePath = join(sessionDir, 'missing-mode.json');
    const sharedCredentialPath = join(sessionDir, 'shared-credential.json');
    const unsupportedModePath = join(sessionDir, 'unsupported-mode.json');
    writeRawFileSync(
      missingModePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    writeRawFileSync(
      unsupportedModePath,
      JSON.stringify({
        control: { mode: 'direct-nanocore' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    writeRawFileSync(
      sharedCredentialPath,
      JSON.stringify({
        control: {
          bindings: {
            capabilities: {
              pathPrefix: '/capabilities/',
              tokenRef: 'runtime://openkit/shared-token',
            },
            inference: {
              pathPrefix: '/inference/',
              tokenRef: 'runtime://openkit/shared-token',
            },
            workerControl: {
              pathPrefix: '/worker-control/',
              tokenRef: 'runtime://openkit/shared-token',
            },
          },
          mode: 'sandbox-integration',
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', missingModePath, '--dry-run']),
        environment: {},
      })
    ).rejects.toThrow('Worker shim requires control.mode to be sandbox-integration.');
    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', unsupportedModePath, '--dry-run']),
        environment: {},
      })
    ).rejects.toThrow('Worker shim requires control.mode to be sandbox-integration.');
    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', sharedCredentialPath, '--dry-run']),
        environment: {},
      })
    ).rejects.toThrow(/distinct.*token|token.*distinct/i);
  });

  it.each([
    {
      expectedError: /Unknown worker adapter/,
      expectedRunnerCalls: 0,
      name: 'an unknown opaque adapter',
      targetRuntime: 'unknown-runtime',
    },
    {
      expectedError: /exceeds 16777216 bytes/,
      expectedRunnerCalls: 1,
      name: 'native stdout over 16 MiB',
      oversizedStdout: true,
      targetRuntime: 'opencode',
    },
  ])('fails closed on $name', async ({
    expectedError,
    expectedRunnerCalls,
    oversizedStdout = false,
    targetRuntime,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-adapter-preflight-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: oversizedStdout ? 'x'.repeat(16 * 1024 * 1024 + 1) : '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        agent: { runtimeKind: 'codex' },
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime },
        },
        extensions: { openkit: { turnInput: 'Do not launch this input.' } },
        llm: { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: {
          command: {
            argv: ['openkit-worker-shim'],
            workingDirectory: sessionDir,
          },
          image: { ref: 'ghcr.io/openkit/codex-worker:test' },
        },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(expectedError);
    expect(runner.calls).toHaveLength(expectedRunnerCalls);
  });

  it('waits for worker-control readiness before starting the native process', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-control-ready-'));
    const packagePath = join(sessionDir, 'package.json');
    const order: string[] = [];
    const fetch: WorkerControlFetch = async (url) => {
      order.push(
        url.endsWith('/heartbeat')
          ? 'heartbeat'
          : url.endsWith('/events/append')
            ? 'event-append'
            : url.endsWith('/commands/poll')
              ? 'poll'
              : 'final-status'
      );
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(workerControlSuccessBody(url)),
      };
    };
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => order.push('worker')
    );
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...workerShimEnvironment(),
      },
      fetch,
      runner,
    });

    expect(order).toEqual([
      'heartbeat',
      'event-append',
      'poll',
      'worker',
      'event-append',
      'event-append',
      'final-status',
    ]);
    expect(
      readJsonl(join(sessionDir, 'events.jsonl')).map(
        (record) => (record as { sequence: number }).sequence
      )
    ).toEqual([0, 1, 2, 3]);
  });

  it('does not start the native process before the route-bound Integration session is ready', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-integration-ready-'));
    const packagePath = join(sessionDir, 'package.json');
    let releaseIntegration: (() => void) | undefined;
    let releaseWorker: (() => void) | undefined;
    integrationFixtureLifecycle.ready = new Promise<void>((resolve) => {
      releaseIntegration = resolve;
    });
    const workerRelease = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const runnerCalls: Array<Parameters<WorkerProcessRunner['run']>[0]> = [];
    const runner: WorkerProcessRunner = {
      async run(input) {
        runnerCalls.push(input);
        input.onStart?.();
        await workerRelease;
        return { exitCode: 0, signal: null, stderr: '', stdout: '' };
      },
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(workerControlSuccessBody(url)),
      }),
      runner,
    });

    try {
      await vi.waitFor(() => expect(integrationFixtureLifecycle.opens).toBe(1));
      expect(runnerCalls).toEqual([]);
      releaseIntegration?.();
      await vi.waitFor(() => expect(runnerCalls).toHaveLength(1));
      releaseWorker?.();
      await expect(run).resolves.toMatchObject({ status: 'completed' });
    } finally {
      releaseIntegration?.();
      releaseWorker?.();
      await run.catch(() => undefined);
    }
  });

  it('does not start the native process when initial worker-control readiness fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-control-rejected-'));
    const packagePath = join(sessionDir, 'package.json');
    const upstreamSecret = 'upstream-secret-must-not-reach-transcript';
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
        },
        fetch: async () => ({
          ok: false,
          status: 503,
          text: async () =>
            JSON.stringify({
              code: 'worker_control_unavailable',
              message: `private upstream diagnostic ${upstreamSecret}`,
            }),
        }),
        runner,
      })
    ).rejects.toThrow('worker_control_unavailable');
    expect(runner.calls).toEqual([]);
    const eventsPath = join(sessionDir, 'events.jsonl');
    const transcript = existsSync(eventsPath) ? readJsonl(eventsPath) : [];
    expect(transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: {
            data: {
              evidenceManifestDigests: {},
              status: 'failed',
              stopReason: 'error',
            },
            type: 'turn.failed',
          },
        }),
      ])
    );
    expect(JSON.stringify(transcript)).not.toContain(upstreamSecret);
    expect(JSON.stringify(transcript)).not.toContain('private upstream diagnostic');
  });

  it('fails readiness without starting the native process when worker control does not respond', async () => {
    vi.useFakeTimers();
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-control-timeout-'));
    const packagePath = join(sessionDir, 'package.json');
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    try {
      const run = runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
        },
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            markFetchStarted?.();
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
        runner,
      });
      const outcome = run.then(
        () => 'unexpected-success',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      await fetchStarted;
      await vi.advanceTimersByTimeAsync(10_001);

      expect(await outcome).toContain('readiness timed out');
      expect(runner.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a process failure that wins the control shutdown race', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-process-first-'));
    const packagePath = join(sessionDir, 'package.json');
    let heartbeatCount = 0;
    let markPeriodicStarted: (() => void) | undefined;
    let resolvePeriodic: ((response: Awaited<ReturnType<WorkerControlFetch>>) => void) | undefined;
    const periodicStarted = new Promise<void>((resolve) => {
      markPeriodicStarted = resolve;
    });
    const periodicResponse = new Promise<Awaited<ReturnType<WorkerControlFetch>>>((resolve) => {
      resolvePeriodic = resolve;
    });
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
        },
        fetch: async (url) => {
          if (url.endsWith('/heartbeat')) {
            heartbeatCount += 1;
            if (heartbeatCount > 1) {
              markPeriodicStarted?.();
              return periodicResponse;
            }
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(workerControlSuccessBody(url)),
          };
        },
        runner: {
          async run(input) {
            input.onStart?.();
            await periodicStarted;
            resolvePeriodic?.({
              ok: false,
              status: 503,
              text: async () => JSON.stringify({ code: 'control-second' }),
            });
            throw new Error('process-first');
          },
        },
      })
    ).rejects.toThrow('process-first');
  });

  it('preserves a process failure while the sibling control stops from supervisor abort', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-process-abort-first-'));
    const packagePath = join(sessionDir, 'package.json');
    const processError = new Error('process-failed-before-control-abort');
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner: {
          async run() {
            throw processError;
          },
        },
      })
    ).rejects.toBe(processError);
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ type: 'worker.ready' }) }),
      ])
    );
  });

  it('waits for a started native process to stop when worker.ready persistence fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-ready-write-failure-'));
    const packagePath = join(sessionDir, 'package.json');
    const eventsPath = join(sessionDir, 'events.jsonl');
    let processStopped = false;
    const runner: WorkerProcessRunner = {
      async run(input) {
        input.onStart?.();
        renameSync(eventsPath, `${eventsPath}.before-ready`);
        mkdirSync(eventsPath);

        return new Promise((resolve) => {
          input.signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                processStopped = true;
                resolve({ exitCode: null, signal: 'SIGTERM', stderr: '', stdout: '' });
              }, 5);
            },
            { once: true }
          );
        });
      },
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow();
    expect(processStopped).toBe(true);
  });

  it('preserves the primary runtime failure when terminal transcript persistence also fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-primary-failure-'));
    const packagePath = join(sessionDir, 'package.json');
    const eventsPath = join(sessionDir, 'events.jsonl');
    const runtimeError = new Error('primary-runtime-failure');
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner: {
          async run(input) {
            input.onStart?.();
            await vi.waitFor(() =>
              expect(readJsonl(eventsPath)).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    event: expect.objectContaining({ type: 'worker.ready' }),
                  }),
                ])
              )
            );
            expect(readJsonl(eventsPath)).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  event: expect.objectContaining({ type: 'worker.heartbeat' }),
                }),
              ])
            );
            renameSync(eventsPath, `${eventsPath}.ready`);
            mkdirSync(eventsPath);
            throw runtimeError;
          },
        },
      })
    ).rejects.toBe(runtimeError);
  });

  it('does not let a later parent abort take ownership from a control failure', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-control-owner-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    const controlError = new Error('control-failed-before-parent-abort');
    let heartbeatCount = 0;
    let markWorkerAborted: (() => void) | undefined;
    let releaseWorker: (() => void) | undefined;
    const workerAborted = new Promise<void>((resolve) => {
      markWorkerAborted = resolve;
    });
    const workerReleased = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const runner: WorkerProcessRunner = {
      async run(input) {
        input.onStart?.();
        return new Promise((resolve) => {
          const finish = () => {
            markWorkerAborted?.();
            void workerReleased.then(() =>
              resolve({ exitCode: null, signal: 'SIGTERM', stderr: '', stdout: '' })
            );
          };
          if (input.signal?.aborted) {
            finish();
            return;
          }
          input.signal?.addEventListener('abort', finish, { once: true });
        });
      },
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      fetch: async (url) => {
        if (url.endsWith('/heartbeat')) {
          heartbeatCount += 1;
          if (heartbeatCount > 1) {
            throw controlError;
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(workerControlSuccessBody(url)),
        };
      },
      runner,
      signal: controller.signal,
    });

    try {
      await workerAborted;
      controller.abort();
      releaseWorker?.();

      await expect(run).rejects.toBe(controlError);
    } finally {
      controller.abort();
      releaseWorker?.();
      await run.catch(() => undefined);
    }
  });

  it('uses the fixed Integration control origin without a caller base URL', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-control-missing-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    const requests: string[] = [];
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: workerIntegrationControl(),
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        fetch: async (url) => {
          requests.push(url);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(workerControlSuccessBody(url)),
          };
        },
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(runner.calls).toHaveLength(1);
    expect(requests.every((url) => url.startsWith('/worker-control/'))).toBe(true);
  });

  it.each([undefined, 'control-control'])('rejects unsupported control mode %s', async (mode) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-control-mode-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeRawFileSync(
      packagePath,
      JSON.stringify({
        ...(mode ? { control: { mode } } : {}),
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow('sandbox-integration');
    expect(runner.calls).toEqual([]);
  });

  it.each([
    {
      command: {
        approvalRequestId: 'approval_legacy_1',
        commandId: 'approval_result_legacy_1',
        decision: 'approved',
        kind: 'approval-result',
      },
      label: 'an unsupported command kind',
    },
    {
      command: {
        argv: 'not-an-argv-array',
        commandId: 'terminal_malformed_1',
        cwd: '/workspace/openkit',
        kind: 'terminal-command',
      },
      label: 'a malformed retired terminal command',
    },
    {
      command: {
        argv: ['retired-command'],
        commandId: 'terminal_retired_1',
        cwd: null,
        kind: 'terminal-command',
      },
      label: 'a retired terminal command',
    },
  ])('fails closed on $label', async ({ command }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-invalid-command-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        fetch: async (url) => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              url.endsWith('/commands/poll')
                ? { commands: [command] }
                : workerControlSuccessBody(url)
            ),
        }),
        runner,
      })
    ).rejects.toThrow('Unsupported worker control command');
    expect(runner.calls).toEqual([]);
  });

  it('records parent cancellation during control readiness as interrupted', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-readiness-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    const controller = new AbortController();
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: workerIntegrationControl(),
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...workerShimEnvironment(),
      },
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          markFetchStarted?.();
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
      runner,
      signal: controller.signal,
    });
    await fetchStarted;
    controller.abort();

    await expect(run).resolves.toMatchObject({ signal: 'SIGTERM', status: 'interrupted' });
    expect(runner.calls).toEqual([]);
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({
              status: 'interrupted',
              stopReason: 'aborted',
            }),
            type: 'turn.failed',
          }),
        }),
      ])
    );
  });

  it('cancels control and the native process when the parent supervisor aborts', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-parent-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new AbortAwareWorkerProcessRunner();
    const controller = new AbortController();
    const fetch: WorkerControlFetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(workerControlSuccessBody(url)),
    });
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...workerShimEnvironment(),
      },
      fetch,
      runner,
      signal: controller.signal,
    });
    await runner.started;
    controller.abort();

    await expect(run).resolves.toMatchObject({ signal: 'SIGTERM', status: 'interrupted' });
    expect(runner.aborted).toBe(true);
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({ status: 'interrupted' }),
            type: 'turn.failed',
          }),
        }),
      ])
    );
  });

  it('reports starting only for the first heartbeat and running thereafter', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-heartbeat-status-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new AbortAwareWorkerProcessRunner();
    const controller = new AbortController();
    const heartbeats: Array<{ sequence: number; status: string }> = [];
    const fetch: WorkerControlFetch = async (url, init) => {
      if (url.endsWith('/heartbeat')) {
        const body = JSON.parse(init.body) as {
          body: { status: string };
          sequence: number;
        };
        heartbeats.push({ sequence: body.sequence, status: body.body.status });
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(workerControlSuccessBody(url)),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...workerShimEnvironment(),
      },
      fetch,
      runner,
      signal: controller.signal,
    });

    try {
      await runner.started;
      await vi.waitFor(() => expect(heartbeats).toHaveLength(2), { timeout: 2_000 });

      expect(heartbeats).toEqual([
        { sequence: 0, status: 'starting' },
        { sequence: 1, status: 'running' },
      ]);
    } finally {
      controller.abort();
      await run.catch(() => undefined);
    }
  });

  it('terminates the real native process group after TERM and KILL on abort', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-child-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const markerPath = join(sessionDir, 'codex-child.txt');
    const descendantMarkerPath = join(sessionDir, 'codex-descendant.txt');
    const controller = new AbortController();
    const descendantScript = [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(descendantMarkerPath)}, ':term'));`,
      `fs.writeFileSync(${JSON.stringify(descendantMarkerPath)}, String(process.pid));`,
      'setInterval(() => undefined, 1000);',
    ].join('');
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(markerPath)}, ':term'));`,
      `fs.writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));`,
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'inherit' }).unref();`,
      'setInterval(() => undefined, 1000);',
    ].join('');
    let childPid: number | null = null;
    let descendantPid: number | null = null;
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: { adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' } },
        extensions: { openkit: { turnInput: childScript } },
        llm: { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...workerShimEnvironment(),
      },
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(workerControlSuccessBody(url)),
      }),
      signal: controller.signal,
    });

    try {
      await vi.waitFor(() => expect(readFileSync(markerPath, 'utf8')).toMatch(/^\d+$/));
      await vi.waitFor(() => expect(readFileSync(descendantMarkerPath, 'utf8')).toMatch(/^\d+$/));
      childPid = Number.parseInt(readFileSync(markerPath, 'utf8'), 10);
      descendantPid = Number.parseInt(readFileSync(descendantMarkerPath, 'utf8'), 10);
      controller.abort();

      await expect(run).resolves.toMatchObject({ status: 'interrupted' });
      expect(readFileSync(markerPath, 'utf8')).toContain(':term');
      expect(readFileSync(descendantMarkerPath, 'utf8')).toContain(':term');
      expect(processIsRunning(childPid)).toBe(false);
      expect(processIsRunning(descendantPid)).toBe(false);
      const source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
      const termination = source
        .split('async function terminateChildProcess')[1]
        ?.split('function signalProcessGroup')[0];
      expect(termination).toBeDefined();
      expect(termination).toMatch(
        /SIGKILL[\s\S]*waitForProcessGroupExit[\s\S]*(?:throw|return false)/
      );
    } finally {
      controller.abort();
      await run.catch(() => undefined);
      for (const pid of [childPid, descendantPid]) {
        if (pid === null) {
          continue;
        }
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The expected path already reaped the child.
        }
      }
    }
  }, 8_000);

  it('cleans up native descendants after the process leader exits successfully', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-descendant-exit-'));
    const packagePath = join(sessionDir, 'package.json');
    const descendantMarkerPath = join(sessionDir, 'codex-descendant-exit.txt');
    const descendantScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(descendantMarkerPath)}, String(process.pid));`,
      'setInterval(() => undefined, 1000);',
    ].join('');
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'inherit' }).unref();`,
      'const startedAt = Date.now();',
      `const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(descendantMarkerPath)})) { clearInterval(ready); return; } if (Date.now() - startedAt > 1000) { clearInterval(ready); process.exitCode = 2; } }, 5);`,
    ].join('');
    let descendantPid: number | null = null;
    let completed = false;
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          ...workerIntegrationControl('fixture-process'),
        },
        extensions: { openkit: { turnInput: childScript } },
        llm: { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(workerControlSuccessBody(url)),
      }),
    });
    void run.then(
      () => {
        completed = true;
      },
      () => undefined
    );

    try {
      await vi.waitFor(() => expect(readFileSync(descendantMarkerPath, 'utf8')).toMatch(/^\d+$/));
      descendantPid = Number.parseInt(readFileSync(descendantMarkerPath, 'utf8'), 10);
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 3_000 });
      await expect(run).resolves.toMatchObject({ status: 'completed' });
      expect(processIsRunning(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== null) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The expected path already reaped the descendant.
        }
      }
      await run.catch(() => undefined);
    }
  }, 8_000);

  it('does not start the native process when the initial control poll interrupts the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-initial-interrupt-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const fetch: WorkerControlFetch = async (url, init) => {
      requests.push({
        body: JSON.parse(init.body) as Record<string, unknown>,
        url,
      });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith('/commands/poll')
              ? {
                  commands: [{ commandId: 'interrupt_1', kind: 'interrupt', reason: 'user-stop' }],
                }
              : workerControlSuccessBody(url)
          ),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
        },
        fetch,
        runner,
      })
    ).resolves.toMatchObject({ status: 'interrupted' });
    expect(runner.calls).toEqual([]);
    const terminalRecord = readJsonl(join(sessionDir, 'events.jsonl')).find(
      (record) => (record as { event?: { type?: string } }).event?.type === 'turn.failed'
    ) as { sequence: number };
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({ commandId: 'interrupt_1' }),
          url: '/worker-control/commands/ack',
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            body: expect.objectContaining({
              status: 'interrupted',
              stopReason: 'aborted',
            }),
            operation: 'final_status',
            sequence: terminalRecord.sequence,
          }),
          url: '/worker-control/final-status',
        }),
      ])
    );
  });

  it.each([
    {
      exitCode: 0,
      expectedStatus: 'completed' as const,
      expectedStopReason: 'completed',
    },
    {
      exitCode: 7,
      expectedStatus: 'failed' as const,
      expectedStopReason: 'error',
    },
  ])('reports one $expectedStatus final status with the terminal transcript sequence', async ({
    exitCode,
    expectedStatus,
    expectedStopReason,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-final-status-'));
    const packagePath = join(sessionDir, 'package.json');
    const requests: Array<{ body: unknown; url: string }> = [];
    const fetch: WorkerControlFetch = async (url, init) => {
      requests.push({ body: JSON.parse(init.body) as unknown, url });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith('/commands/poll')
              ? { commands: [] }
              : { accepted: true, diagnostics: [], schemaVersion: 1 }
          ),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        fetch,
        runner: new FakeWorkerProcessRunner({
          exitCode,
          signal: null,
          stderr: exitCode === 0 ? '' : 'Product-safe stderr.',
          stdout: exitCode === 0 ? '' : 'Product-safe stdout.',
        }),
      })
    ).resolves.toMatchObject({ status: expectedStatus });

    const eventRecords = readJsonl(join(sessionDir, 'events.jsonl')) as Array<{
      event: { data: Record<string, unknown>; type: string };
      sequence: number;
    }>;
    const records = [
      ...eventRecords,
      ...(existsSync(join(sessionDir, 'items.jsonl'))
        ? readJsonl(join(sessionDir, 'items.jsonl'))
        : []),
    ] as Array<{ event?: { type?: string }; sequence: number }>;
    const terminalRecord = eventRecords.find((record) =>
      ['turn.completed', 'turn.failed'].includes(record.event.type)
    );
    const appendedRecords = requests
      .filter((request) => request.url.endsWith('/events/append'))
      .map((request) => (request.body as { record: (typeof eventRecords)[number] }).record);
    const finalStatusRequests = requests.filter((request) => request.url.endsWith('/final-status'));

    expect(terminalRecord).toBeDefined();
    expect(terminalRecord?.sequence).toBe(Math.max(...records.map((record) => record.sequence)));
    expect(appendedRecords).toEqual(
      eventRecords.filter(
        (record) => !['turn.completed', 'turn.failed'].includes(record.event.type)
      )
    );
    expect(finalStatusRequests).toEqual([
      {
        body: {
          body: terminalRecord?.event.data,
          lineage: {
            agentSessionId: 'as_codex_1',
            packageSnapshotId: 'pkg_codex_1',
            requestId: 'req_codex_1',
            threadId: 'th_codex',
            turnId: 'turn_codex',
            workspaceId: 'ws_codex',
          },
          operation: 'final_status',
          schemaVersion: 1,
          sequence: terminalRecord?.sequence,
        },
        url: '/worker-control/final-status',
      },
    ]);
    expect(terminalRecord?.event.data).toMatchObject({
      evidenceManifestDigests: {},
      status: expectedStatus,
      stopReason: expectedStopReason,
    });
  });

  it('retries a rejected final status without writing a second terminal record', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-final-status-retry-'));
    const packagePath = join(sessionDir, 'package.json');
    const finalStatusBodies: string[] = [];
    const fetch: WorkerControlFetch = async (url, init) => {
      if (url.endsWith('/final-status')) {
        finalStatusBodies.push(init.body);
        if (finalStatusBodies.length === 1) {
          return {
            ok: false,
            status: 503,
            text: async () =>
              JSON.stringify({ code: 'worker_control_unavailable', message: 'Try again.' }),
          };
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith('/commands/poll')
              ? { commands: [] }
              : { accepted: true, diagnostics: [], schemaVersion: 1 }
          ),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        fetch,
        runner: new FakeWorkerProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      })
    ).resolves.toMatchObject({ status: 'completed' });
    const terminalRecords = readJsonl(join(sessionDir, 'events.jsonl')).filter((record) =>
      ['turn.completed', 'turn.failed'].includes(
        (record as { event?: { type?: string } }).event?.type ?? ''
      )
    );

    expect(terminalRecords).toHaveLength(1);
    expect(finalStatusBodies).toHaveLength(2);
    expect(finalStatusBodies[1]).toBe(finalStatusBodies[0]);
  });

  it('keeps heartbeats live until NanoCore accepts final status', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-final-status-heartbeat-'));
    const packagePath = join(sessionDir, 'package.json');
    let heartbeatCount = 0;
    let markFinalStatusStarted: (() => void) | undefined;
    let releaseFinalStatus: (() => void) | undefined;
    const finalStatusStarted = new Promise<void>((resolve) => {
      markFinalStatusStarted = resolve;
    });
    const finalStatusRelease = new Promise<void>((resolve) => {
      releaseFinalStatus = resolve;
    });
    const fetch: WorkerControlFetch = async (url) => {
      if (url.endsWith('/heartbeat')) {
        heartbeatCount += 1;
      }
      if (url.endsWith('/final-status')) {
        markFinalStatusStarted?.();
        await finalStatusRelease;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith('/commands/poll')
              ? { commands: [] }
              : { accepted: true, diagnostics: [], schemaVersion: 1 }
          ),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    let run: ReturnType<typeof runWorkerShim> | undefined;
    try {
      run = runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        fetch,
        runner: new FakeWorkerProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      });
      void run.catch(() => undefined);
      await finalStatusStarted;
      expect(heartbeatCount).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 3300));
      expect(heartbeatCount).toBeGreaterThanOrEqual(4);
      const records = readJsonl(join(sessionDir, 'events.jsonl')) as Array<{
        event?: { type?: string };
        sequence: number;
      }>;
      const terminalRecord = records.find((record) =>
        ['turn.completed', 'turn.failed'].includes(record.event?.type ?? '')
      );

      expect(terminalRecord?.sequence).toBe(Math.max(...records.map((record) => record.sequence)));
      expect(records.at(-1)).toBe(terminalRecord);
      releaseFinalStatus?.();

      await expect(run).resolves.toMatchObject({ status: 'completed' });
    } finally {
      releaseFinalStatus?.();
      await run?.catch(() => undefined);
    }
  });

  it('detaches parent cancellation after terminal classification is sealed', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-terminal-cutoff-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    let markFinalStatusStarted: (() => void) | undefined;
    let releaseFinalStatus: (() => void) | undefined;
    const finalStatusStarted = new Promise<void>((resolve) => {
      markFinalStatusStarted = resolve;
    });
    const finalStatusRelease = new Promise<void>((resolve) => {
      releaseFinalStatus = resolve;
    });
    const fetch: WorkerControlFetch = async (url) => {
      if (url.endsWith('/final-status')) {
        markFinalStatusStarted?.();
        await finalStatusRelease;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(workerControlSuccessBody(url)),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    let run: ReturnType<typeof runWorkerShim> | undefined;

    try {
      run = runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        fetch,
        runner: new FakeWorkerProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
        signal: controller.signal,
      });
      void run.catch(() => undefined);
      await finalStatusStarted;

      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      controller.abort();
      releaseFinalStatus?.();

      await expect(run).resolves.toMatchObject({ status: 'completed' });
      expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: expect.objectContaining({ type: 'turn.completed' }) }),
        ])
      );
    } finally {
      releaseFinalStatus?.();
      await run?.catch(() => undefined);
    }
  });

  it('reports parent cancellation after native exit but before terminal commit as interrupted', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-final-status-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    const requests: Array<{ body: unknown; url: string }> = [];
    const fetch: WorkerControlFetch = async (url, init) => {
      requests.push({ body: JSON.parse(init.body) as unknown, url });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith('/commands/poll')
              ? { commands: [] }
              : { accepted: true, diagnostics: [], schemaVersion: 1 }
          ),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    const result = await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      fetch,
      runner: new FakeWorkerProcessRunner(
        { exitCode: 0, signal: null, stderr: '', stdout: '' },
        () => controller.abort()
      ),
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'interrupted' });
    const terminalRecord = readJsonl(join(sessionDir, 'events.jsonl')).find(
      (record) => (record as { event?: { type?: string } }).event?.type === 'turn.failed'
    ) as { sequence: number };
    expect(requests.filter((request) => request.url.endsWith('/final-status'))).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          body: expect.objectContaining({
            status: 'interrupted',
            stopReason: 'aborted',
          }),
          operation: 'final_status',
          sequence: terminalRecord.sequence,
        }),
      }),
    ]);
  });

  it('lets parent interruption win while adapter collection is in flight', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-collect-interrupt-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    let markCollectStarted: (() => void) | undefined;
    let releaseCollection: (() => void) | undefined;
    const collectStarted = new Promise<void>((resolve) => {
      markCollectStarted = resolve;
    });
    processFixtureLifecycle.markCollectStarted = () => markCollectStarted?.();
    processFixtureLifecycle.collectBarrier = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner: new FakeWorkerProcessRunner({ exitCode: 0, signal: null, stderr: '', stdout: '' }),
      signal: controller.signal,
    });
    await collectStarted;
    controller.abort();
    releaseCollection?.();

    await expect(run).resolves.toMatchObject({ status: 'interrupted' });
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({ status: 'interrupted' }),
            type: 'turn.failed',
          }),
        }),
      ])
    );
  });

  it('lets parent interruption win while adapter finalization is in flight', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-finalize-interrupt-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    let markFinalizeStarted: (() => void) | undefined;
    let releaseFinalization: (() => void) | undefined;
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });
    processFixtureLifecycle.markFinalizeStarted = () => markFinalizeStarted?.();
    processFixtureLifecycle.finalizeBarrier = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner: new FakeWorkerProcessRunner({ exitCode: 0, signal: null, stderr: '', stdout: '' }),
      signal: controller.signal,
    });
    await finalizeStarted;
    controller.abort();
    releaseFinalization?.();

    await expect(run).resolves.toMatchObject({ status: 'interrupted' });
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({ status: 'interrupted' }),
            type: 'turn.failed',
          }),
        }),
      ])
    );
  });

  it('fails closed when worker control fails after native exit during finalization', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-finalize-control-failure-'));
    const packagePath = join(sessionDir, 'package.json');
    let heartbeatCount = 0;
    let markFinalizeStarted: (() => void) | undefined;
    let markPeriodicFailure: (() => void) | undefined;
    let releaseFinalization: (() => void) | undefined;
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });
    const periodicFailure = new Promise<void>((resolve) => {
      markPeriodicFailure = resolve;
    });
    processFixtureLifecycle.markFinalizeStarted = () => markFinalizeStarted?.();
    processFixtureLifecycle.finalizeBarrier = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      fetch: async (url) => {
        if (url.endsWith('/heartbeat')) {
          heartbeatCount += 1;
          if (heartbeatCount === 2) {
            markPeriodicFailure?.();
            return {
              ok: false,
              status: 400,
              text: async () => JSON.stringify({ code: 'post-process-control-failed' }),
            };
          }
        }

        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(workerControlSuccessBody(url)),
        };
      },
      runner: new FakeWorkerProcessRunner({ exitCode: 0, signal: null, stderr: '', stdout: '' }),
    });
    await finalizeStarted;
    await periodicFailure;
    releaseFinalization?.();

    await expect(run).rejects.toThrow('post-process-control-failed');
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({
              status: 'failed',
              stopReason: 'error',
            }),
            type: 'turn.failed',
          }),
        }),
      ])
    );
  });

  it('keeps native argv and turn input out of worker.ready records', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-ready-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: 'Summarize the repository.' } },
        llm: { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: '/workspace/openkit' } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });

    const events = readJsonl(join(sessionDir, 'events.jsonl')) as Array<{
      event: { data: Record<string, unknown>; type: string };
    }>;
    const readyData = events.find((record) => record.event.type === 'worker.ready')?.event.data;

    expect(readyData).toBeDefined();
    expect(readyData).not.toHaveProperty('argv');
    expect(JSON.stringify(readyData)).not.toContain('Summarize the repository.');
  });
  it('captures streamed Codex runtime provenance from the isolated state root', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-provenance-'));
    const codexHome = join(sessionDir, 'native-state');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '13');
    const packagePath = join(sessionDir, 'package.json');
    const primary = Buffer.from(
      [
        `{"type":"thread.started","thread_id":"${CODEX_TEST_UUID}","label":"café"}`,
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
        '',
      ].join('\n'),
      'utf8'
    );
    const firstNewline = primary.indexOf('\n'.charCodeAt(0));
    const utf8Split = primary.indexOf(Buffer.from('é')) + 1;
    const rollout = [
      `{"timestamp":"2026-07-13T00:00:00.000Z","type":"session_meta","payload":{"session_id":"${CODEX_TEST_UUID}","id":"${CODEX_TEST_UUID}","timestamp":"2026-07-13T00:00:00.000Z","cwd":"/workspace/openkit","originator":"codex_cli_rs","cli_version":"0.153.4","source":"exec"}}`,
      '{"timestamp":"2026-07-13T00:00:01.000Z","type":"turn_context","payload":{"turn_id":"turn-native-root"}}',
      '{"timestamp":"2026-07-13T00:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}',
      '',
    ].join('\n');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    }, () => {
      mkdirSync(rolloutDir, { recursive: true });
      writeRawFileSync(
        join(rolloutDir, 'rollout-2026-07-13T00-00-00-thread-root.jsonl'),
        rollout,
        'utf8'
      );
    }, [
      primary.subarray(0, utf8Split),
      primary.subarray(utf8Split, firstNewline),
      primary.subarray(firstNewline, firstNewline + 1),
      primary.subarray(firstNewline + 1),
    ]);
    writeFileSync(
      packagePath,
      JSON.stringify({
        backend: { requiredCapabilities: ['worker.runtime-provenance.v1'] },
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
          transcript: {
            root: '/openkit/session',
            runtimeProvenance: {
              maxStreamCount: 8,
              maxTotalBytes: 1_048_576,
              nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
              rawStreamsRoot: '/openkit/session/runtime/raw',
              streamManifestPath: '/openkit/session/runtime/raw-streams.json',
            },
          },
        },
        extensions: { openkit: { turnInput: 'Capture provenance.' } },
        llm: { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: '/workspace/openkit' } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });

    expect(readFileSync(join(sessionDir, 'runtime', 'raw', 'stream-0000.jsonl'))).toEqual(primary);
    expect(readFileSync(join(sessionDir, 'runtime', 'raw', 'stream-0001.jsonl'), 'utf8')).toBe(
      rollout
    );
    expect(
      JSON.parse(readFileSync(join(sessionDir, 'runtime', 'raw-streams.json'), 'utf8'))
    ).toEqual(
      expect.objectContaining({
        adapterVersion: '0.153.4',
        captureStatus: 'complete',
        lineage: {
          agentSessionId: 'as_codex_1',
          packageSnapshotId: 'pkg_codex_1',
          requestId: 'req_codex_1',
          threadId: 'th_codex',
          turnId: 'turn_codex',
          workspaceId: 'ws_codex',
        },
        primaryStreamRef: 'stream-0000.jsonl',
        runtimeFamily: 'codex',
        streams: [
          expect.objectContaining({
            bytes: primary.length,
            captureStatus: 'complete',
            frameCount: 2,
            sha256: `sha256:${createHash('sha256').update(primary).digest('hex')}`,
            sourceKind: 'primary',
            stableTerminal: true,
            streamRef: 'stream-0000.jsonl',
          }),
          expect.objectContaining({
            bytes: Buffer.byteLength(rollout),
            captureStatus: 'complete',
            frameCount: 3,
            sha256: `sha256:${createHash('sha256').update(rollout).digest('hex')}`,
            sourceKind: 'runtime-thread',
            stableTerminal: true,
            streamRef: 'stream-0001.jsonl',
          }),
        ],
      })
    );
    expect(readJsonl(join(sessionDir, 'runtime', 'native-origin-index.jsonl'))).toEqual([
      expect.objectContaining({
        byteLength: firstNewline + 1,
        byteOffset: 0,
        eventKind: 'thread.started',
        frameSequence: 0,
        nativeThreadId: CODEX_TEST_UUID,
        parseStatus: 'parsed',
        streamRef: 'stream-0000.jsonl',
      }),
      expect.objectContaining({
        byteOffset: firstNewline + 1,
        eventKind: 'item.completed',
        frameSequence: 1,
        nativeThreadId: CODEX_TEST_UUID,
        parseStatus: 'parsed',
        streamRef: 'stream-0000.jsonl',
      }),
      expect.objectContaining({
        eventKind: 'session_meta',
        frameSequence: 0,
        nativeSessionId: CODEX_TEST_UUID,
        nativeThreadId: CODEX_TEST_UUID,
        parseStatus: 'parsed',
        streamRef: 'stream-0001.jsonl',
      }),
      expect.objectContaining({
        eventKind: 'turn_context',
        frameSequence: 1,
        nativeThreadId: CODEX_TEST_UUID,
        nativeTurnId: 'turn-native-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0001.jsonl',
      }),
      expect.objectContaining({
        eventKind: 'response_item',
        frameSequence: 2,
        nativeThreadId: CODEX_TEST_UUID,
        nativeTurnId: 'turn-native-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0001.jsonl',
      }),
    ]);
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          data: { status: 'starting' },
          type: 'worker.heartbeat',
        }),
        sequence: 0,
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: 'worker.ready' }),
        sequence: 1,
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: 'worker.heartbeat' }),
        sequence: 2,
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: 'turn.completed' }),
        sequence: 3,
      }),
    ]);
  });

  it('invalidates a reused provenance manifest before a later capture failure', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-provenance-reused-'));
    const codexHome = join(sessionDir, 'native-state');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '13');
    const packagePath = join(sessionDir, 'package.json');
    const manifestPath = join(sessionDir, 'runtime', 'raw-streams.json');
    const primary = Buffer.from(`{"type":"thread.started","thread_id":"${CODEX_TEST_UUID}"}\n`);
    const rollout = `${JSON.stringify({
      payload: {
        cli_version: '0.153.4',
        cwd: sessionDir,
        id: CODEX_TEST_UUID,
        originator: 'codex_exec',
        session_id: CODEX_TEST_UUID,
        source: 'exec',
        timestamp: '2026-07-13T00:00:00.000Z',
      },
      timestamp: '2026-07-13T00:00:00.000Z',
      type: 'session_meta',
    })}\n`;
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
          transcript: {
            runtimeProvenance: {
              maxStreamCount: 8,
              maxTotalBytes: 1_048_576,
              nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
              rawStreamsRoot: '/openkit/session/runtime/raw',
              streamManifestPath: '/openkit/session/runtime/raw-streams.json',
            },
          },
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    const args = parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]);
    const environment = workerShimEnvironment();

    await runWorkerShim({
      args,
      environment,
      runner: new FakeWorkerProcessRunner({
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: primary.toString('utf8'),
      }, () => {
        mkdirSync(rolloutDir, { recursive: true });
        writeRawFileSync(join(rolloutDir, 'rollout-reused-root.jsonl'), rollout, 'utf8');
      }, [primary]),
    });
    expect(existsSync(manifestPath)).toBe(true);

    const failingRunner: WorkerProcessRunner = {
      async run(input) {
        input.onStart?.();
        mkdirSync(rolloutDir, { recursive: true });
        writeRawFileSync(join(rolloutDir, 'rollout-reused-root.jsonl'), rollout, 'utf8');
        await input.writeStdout?.(primary);
        mkdirSync(`${manifestPath}.tmp`, { recursive: true });
        return { exitCode: 0, signal: null, stderr: '', stdout: primary.toString('utf8') };
      },
    };

    await expect(runWorkerShim({ args, environment, runner: failingRunner })).rejects.toThrow();
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('waits for each streamed stdout sink write before completing the process run', async () => {
    const chunk = Buffer.from('{"type":"thread.started","thread_id":"thread-root"}\n');
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      null,
      [chunk]
    );
    let releaseWrite: (() => void) | undefined;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    let completed = false;
    const run = runner
      .run({
        argv: ['codex', 'exec', '--json'],
        cwd: '/workspace/openkit',
        env: {},
        writeStdout: async () => {
          writeStarted = true;
          await blockedWrite;
        },
      })
      .then((result) => {
        completed = true;
        return result;
      });

    await vi.waitFor(() => expect(writeStarted).toBe(true));
    await Promise.resolve();
    expect(completed).toBe(false);
    releaseWrite?.();
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
  });

  it.each([
    {
      label: 'a path traversal',
      override: { rawStreamsRoot: '/openkit/session/../escape' },
    },
    {
      label: 'a non-positive byte limit',
      override: { maxTotalBytes: 0 },
    },
  ])('rejects runtime provenance declarations containing $label before launch', async ({
    override,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-provenance-invalid-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
          transcript: {
            runtimeProvenance: {
              maxStreamCount: 8,
              maxTotalBytes: 1_048_576,
              nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
              rawStreamsRoot: '/openkit/session/runtime/raw',
              streamManifestPath: '/openkit/session/runtime/raw-streams.json',
              ...override,
            },
          },
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow('Invalid runtime provenance declaration.');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(join(sessionDir, 'escape'))).toBe(false);
  });

  it('starts each adapter with a fresh native state root and removes it after collection', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-fresh-state-'));
    const packagePath = join(sessionDir, 'package.json');
    const stateRoot = join(sessionDir, 'native-state');
    const stalePath = join(stateRoot, 'stale-native-state');
    mkdirSync(stateRoot, { recursive: true });
    writeRawFileSync(stalePath, 'stale', 'utf8');
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner: new FakeWorkerProcessRunner(
        { exitCode: 0, signal: null, stderr: '', stdout: '' },
        () => expect(existsSync(stalePath)).toBe(false)
      ),
    });

    expect(existsSync(stateRoot)).toBe(false);
  });

  it('removes native state created by adapter preparation before preparation fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-prepare-state-failure-'));
    const packagePath = join(sessionDir, 'package.json');
    const stateRoot = join(sessionDir, 'native-state');
    const eventsPath = join(sessionDir, 'events.jsonl');
    const itemsPath = join(sessionDir, 'items.jsonl');
    const artifactsPath = join(sessionDir, 'artifacts.jsonl');
    writeFileSync(eventsPath, 'stale-events-canary\n', 'utf8');
    writeFileSync(itemsPath, 'stale-items-canary\n', 'utf8');
    writeFileSync(artifactsPath, 'stale-artifacts-canary\n', 'utf8');
    processFixtureLifecycle.prepareFailure = async (root) => {
      expect(readFileSync(eventsPath, 'utf8')).toBe('');
      expect(readFileSync(itemsPath, 'utf8')).toBe('');
      expect(readFileSync(artifactsPath, 'utf8')).toBe('');
      mkdirSync(root, { recursive: true });
      writeRawFileSync(join(root, 'partial-state'), 'partial', 'utf8');
      throw new Error('fixture-prepare-failed');
    };
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner: new FakeWorkerProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      })
    ).rejects.toThrow('fixture-prepare-failed');
    expect(existsSync(stateRoot)).toBe(false);
    expect(readFileSync(eventsPath, 'utf8')).toBe('');
    expect(readFileSync(itemsPath, 'utf8')).toBe('');
    expect(readFileSync(artifactsPath, 'utf8')).toBe('');
  });

  it.each([
    {
      missingKey: 'no_proxy',
      proxyEnvironment: { NO_PROXY: 'uppercase.example,localhost' },
      retainedEntries: ['uppercase.example', 'localhost'],
      retainedKey: 'NO_PROXY',
    },
    {
      missingKey: 'NO_PROXY',
      proxyEnvironment: { no_proxy: 'lowercase.example,localhost' },
      retainedEntries: ['lowercase.example', 'localhost'],
      retainedKey: 'no_proxy',
    },
  ])('keeps control secrets out and creates the missing $missingKey loopback proxy exclusion', async ({
    missingKey,
    proxyEnvironment,
    retainedEntries,
    retainedKey,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-supervisor-env-'));
    const packagePath = join(sessionDir, 'package.json');
    const childEnvironmentPath = join(sessionDir, 'child-environment.json');
    const controlTokenPath = join(sessionDir, 'control-token');
    const controlToken = 'test-control-token-parent-proc';
    const parentSecret = 'test-undeclared-parent-secret';
    const inferencePlaceholder = 'openshell:resolve:env:OPENKIT_WORKER_INFERENCE_TOKEN';
    const childScript = [
      "const fs = require('node:fs');",
      "const parentEnvironment = process.platform === 'linux' ? fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8') : '';",
      `fs.writeFileSync(${JSON.stringify(childEnvironmentPath)}, JSON.stringify({ childEnvironment: process.env, parentEnvironment }));`,
    ].join('');
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: childScript } },
        llm: { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    writeRawFileSync(controlTokenPath, controlToken, { mode: 0o600 });
    const controlTokenDescriptor = openSync(controlTokenPath, 'r');
    const injectedEnvironment: Record<string, string> = {
      ...workerShimEnvironment(),
      ...proxyEnvironment,
      OPENKIT_CONTROL_TOKEN_FD: String(controlTokenDescriptor),
      OPENKIT_PARENT_ONLY_SECRET: parentSecret,
      OPENKIT_WORKER_INFERENCE_TOKEN: inferencePlaceholder,
    };
    delete injectedEnvironment.OPENKIT_CONTROL_TOKEN;
    for (const [key, value] of Object.entries(injectedEnvironment)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv(missingKey, undefined);

    try {
      await expect(
        runWorkerShimCli(['--package', packagePath, '--session-dir', sessionDir])
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }

    const captured = JSON.parse(readFileSync(childEnvironmentPath, 'utf8')) as {
      childEnvironment: Record<string, string>;
      parentEnvironment: string;
    };
    expect(captured.childEnvironment).not.toHaveProperty('OPENKIT_CONTROL_TOKEN');
    expect(captured.childEnvironment).not.toHaveProperty('OPENKIT_PARENT_ONLY_SECRET');
    expect(captured.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN).toBe(inferencePlaceholder);
    for (const key of ['NO_PROXY', 'no_proxy']) {
      expect(captured.childEnvironment).toHaveProperty(key);
      expect(captured.childEnvironment[key]?.split(',').map((entry) => entry.trim())).toContain(
        '127.0.0.1'
      );
    }
    for (const entry of retainedEntries) {
      expect(
        captured.childEnvironment[retainedKey]?.split(',').map((value) => value.trim())
      ).toContain(entry);
    }
    if (process.platform === 'linux') {
      expect(captured.parentEnvironment).not.toContain(controlToken);
      expect(captured.parentEnvironment).not.toContain(parentSecret);
    }
  });

  it.each([
    {
      credentialVisibility: 'placeholder' as const,
      expectedProviderCredential: false,
      expectedRelayPlaceholder: true,
    },
    {
      credentialVisibility: 'environment' as const,
      expectedProviderCredential: true,
      expectedRelayPlaceholder: false,
    },
    {
      credentialVisibility: 'none' as const,
      expectedProviderCredential: false,
      expectedRelayPlaceholder: false,
    },
  ])('passes only $credentialVisibility route-authorized credentials to the native process', async ({
    credentialVisibility,
    expectedProviderCredential,
    expectedRelayPlaceholder,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-route-credentials-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        credentials: {
          declarations: [
            {
              targetEnvVarName: 'ANTHROPIC_API_KEY',
              visibility: 'runtime-env',
            },
          ],
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: {
          routes: [
            {
              ...workerLlmRoute(),
              credentialVisibility,
            },
          ],
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...workerShimEnvironment(),
        ANTHROPIC_API_KEY: 'provider-credential-value',
      },
      runner,
    });

    expect(runner.calls[0]?.env).toMatchObject(
      expectedProviderCredential
        ? { ANTHROPIC_API_KEY: 'provider-credential-value' }
        : expectedRelayPlaceholder
          ? { OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value' }
          : {}
    );
    if (expectedProviderCredential) {
      expect(runner.calls[0]?.env.ANTHROPIC_API_KEY).toBe('provider-credential-value');
    } else {
      expect(runner.calls[0]?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    }
    if (expectedRelayPlaceholder) {
      expect(runner.calls[0]?.env.OPENKIT_WORKER_INFERENCE_TOKEN).toBe(
        'openshell-placeholder-value'
      );
    } else {
      expect(runner.calls[0]?.env).not.toHaveProperty('OPENKIT_WORKER_INFERENCE_TOKEN');
    }
  });

  it('redacts the exact relay placeholder from ordinary failed-process diagnostics', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-relay-redaction-'));
    const packagePath = join(sessionDir, 'package.json');
    const relayPlaceholder = 'opaque-relay-placeholder-canary';
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
          OPENKIT_WORKER_INFERENCE_TOKEN: relayPlaceholder,
        },
        runner: new FakeWorkerProcessRunner({
          exitCode: 7,
          signal: null,
          stderr: `stderr ${relayPlaceholder}`,
          stdout: `stdout ${relayPlaceholder}`,
        }),
      })
    ).resolves.toMatchObject({ status: 'failed' });
    const transcript = readFileSync(join(sessionDir, 'events.jsonl'), 'utf8');

    expect(transcript).not.toContain(relayPlaceholder);
    expect(transcript).toContain('[redacted]');
  });

  it.each([
    {
      credentialName: 'OPENKIT_WORKER_INFERENCE_TOKEN',
      credentialVisibility: 'placeholder' as const,
      name: 'relay placeholder',
    },
    {
      credentialName: 'ANTHROPIC_API_KEY',
      credentialVisibility: 'environment' as const,
      name: 'direct-provider credential',
    },
  ])('fails closed before persisting assistant output that echoes an exact $name', async ({
    credentialName,
    credentialVisibility,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-adapter-redaction-'));
    const packagePath = join(sessionDir, 'package.json');
    const credential = `opaque-${credentialVisibility}-credential-canary`;
    const llmRoute =
      credentialVisibility === 'placeholder'
        ? workerLlmRoute()
        : {
            credentialVisibility,
            endpoint: {
              kind: 'provider-compatible',
              upstream: { kind: 'direct-provider' },
            },
            id: 'worker-inference',
            model: 'anthropic/claude-sonnet-4-5',
            providerInstanceId: 'anthropic',
          };
    processFixtureLifecycle.collectResult = {
      assistantText: `unsafe assistant output ${credential}`,
      diagnostics: {
        adapter: `unsafe adapter diagnostic ${credential}`,
        oversized: `${'x'.repeat(1_005)}${credential}`,
      },
      status: 'completed',
      stopReason: 'completed',
    };
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        ...(credentialVisibility === 'environment'
          ? {
              credentials: {
                declarations: [{ targetEnvVarName: credentialName, visibility: 'runtime-env' }],
              },
            }
          : {}),
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: { routes: [llmRoute] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
          [credentialName]: credential,
        },
        runner: new FakeWorkerProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      })
    ).resolves.toMatchObject({ status: 'failed' });

    const transcript = readFileSync(join(sessionDir, 'events.jsonl'), 'utf8');
    const terminalRecord = readJsonl(join(sessionDir, 'events.jsonl')).find(
      (record) => (record as { event?: { type?: string } }).event?.type === 'turn.failed'
    ) as {
      event: {
        data: { diagnostics: Record<string, string>; stopReason: string };
      };
    };

    expect(readFileSync(join(sessionDir, 'items.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(join(sessionDir, 'artifacts.jsonl'), 'utf8')).toBe('');
    expect(transcript).not.toContain(credential);
    expect(terminalRecord.event.data.stopReason).toBe('error');
    expect(terminalRecord.event.data.diagnostics.adapter).toBe(
      'unsafe adapter diagnostic [redacted]'
    );
    expect(terminalRecord.event.data.diagnostics.oversized).toHaveLength(1_000);
  });

  it('rejects multiple runtime-env credentials for the one environment-visible route', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-extra-provider-credential-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        credentials: {
          declarations: [
            { targetEnvVarName: 'ANTHROPIC_API_KEY', visibility: 'runtime-env' },
            { targetEnvVarName: 'GITHUB_TOKEN', visibility: 'runtime-env' },
          ],
        },
        extensions: { openkit: { turnInput: 'void 0' } },
        llm: {
          routes: [
            {
              ...workerLlmRoute(),
              credentialVisibility: 'environment',
            },
          ],
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
          ANTHROPIC_API_KEY: 'provider-credential-value',
          GITHUB_TOKEN: 'unrelated-credential-value',
        },
        runner,
      })
    ).rejects.toThrow('exactly one runtime-env credential');
    expect(runner.calls).toHaveLength(0);
  });

  it('materializes static Skill metadata without materializing executable MCP config', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-supply-'));
    const packagePath = join(sessionDir, 'package.json');
    const skillTargetPath = join(sessionDir, 'skills', 'repo-guidelines');
    const mcpTargetPath = join(sessionDir, 'mcp', 'github.json');
    const runner = new FakeWorkerProcessRunner(
      {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '{"type":"session.completed"}\n',
      },
      () => {
        expect(readFileSync(join(skillTargetPath, 'openkit-supply.json'), 'utf8')).toContain(
          'repo-guidelines'
        );
        expect(existsSync(mcpTargetPath)).toBe(false);
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: {
          openkit: {
            turnInput: 'Summarize the repository.',
          },
        },
        llm: {
          mode: 'gateway',
          routes: [workerLlmRoute()],
        },
        runtime: {
          command: {
            workingDirectory: '/workspace/openkit',
          },
        },
        supply: {
          skills: [
            {
              id: 'repo-guidelines',
              version: '1.0.0',
              sourceRef: 'server:skills/repo-guidelines',
              integrity: { sha256: 'sha256-repo-guidelines-v1' },
              materialization: {
                kind: 'filesystem-copy',
                targetPath: skillTargetPath,
              },
              reviewStatus: 'approved',
              secretRefIds: [],
            },
          ],
          mcpServers: [
            {
              allowedTools: ['repos.get'],
              approvalRequiredTools: [],
              catalogDigest: `sha256:${'a'.repeat(64)}`,
              deniedTools: [],
              id: 'github',
              pinnedSchemaSnapshotId: null,
              schemaPolicy: 'tracking',
            },
          ],
        },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });

    const skillMetadata = readFileSync(join(skillTargetPath, 'openkit-supply.json'), 'utf8');
    expect(skillMetadata).toContain('sha256-repo-guidelines-v1');
    expect(existsSync(mcpTargetPath)).toBe(false);
  });

  it('orders Git materialization, native execution, and publication with one lineage', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-git-orchestration-'));
    const workspaceRoot = join(sessionDir, 'workspace');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const packagePath = join(sessionDir, 'package.json');
    const order: string[] = [];
    const bases = new Map([['repo', '0123456789abcdef0123456789abcdef01234567']]);
    let published: Parameters<PublishWorkspaceGitSnapshots>[0] | null = null;
    workspaceGitFixtureLifecycle.materialize = async () => {
      order.push('materialize');
      return bases;
    };
    workspaceGitFixtureLifecycle.publish = async (input) => {
      order.push('publish');
      published = input;
    };
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => order.push('native')
    );
    writeGitWorkspacePackage(packagePath, workspaceRoot, [
      { id: 'repo', source: remoteGitTestSource('repo'), target },
    ]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });

    expect(order).toEqual(['materialize', 'native', 'publish']);
    expect(published?.bases).toBe(bases);
    expect(published?.inputs).toEqual([expect.objectContaining({ id: 'repo', target })]);
    expect(published?.lineage).toEqual({
      agentSessionId: 'as_codex_1',
      packageSnapshotId: 'pkg_codex_1',
      requestId: 'req_codex_1',
      threadId: 'th_codex',
      turnId: 'turn_codex',
      workspaceId: 'ws_codex',
    });
  });

  it.each([
    { kind: 'query', suffix: '?ref=private-review' },
    { kind: 'fragment', suffix: '#private-review' },
  ])('rejects a $kind-bearing remote Git URL before transport or target writes', async ({
    suffix,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-git-url-boundary-'));
    const workspaceRoot = join(sessionDir, 'workspace');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const packagePath = join(sessionDir, 'package.json');
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Git URL boundary fixture did not bind a TCP port.');
    }
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, workspaceRoot, [
      {
        id: 'repo',
        source: {
          ...remoteGitTestSource('repo'),
          url: `https://127.0.0.1:${address.port}/repository.git${suffix}`,
        },
        target,
      },
    ]);

    try {
      await expect(
        runWorkerShim({
          args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
          environment: workerShimEnvironment(),
          runner,
        })
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(connections).toBe(0);
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it('rejects multiple writable Git workspace inputs before starting the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-multiple-git-inputs-'));
    const workspaceRoot = join(sessionDir, 'workspace');
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, workspaceRoot, [
      {
        id: 'first',
        source: remoteGitTestSource('first'),
        target: join(workspaceRoot, 'worktrees', 'first'),
      },
      {
        id: 'second',
        source: remoteGitTestSource('second'),
        target: join(workspaceRoot, 'worktrees', 'second'),
      },
    ]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/Git.*input|input.*Git/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('attempts the declared HTTPS Git source before requiring a local checkout', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-remote-git-order-'));
    const workspaceRoot = join(sessionDir, 'workspace');
    const repoDir = join(workspaceRoot, 'worktrees', 'main');
    const packagePath = join(sessionDir, 'package.json');
    const commit = '0123456789abcdef0123456789abcdef01234567';
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Remote Git order fixture did not bind a TCP port.');
    }
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, workspaceRoot, [
      {
        id: 'repo',
        source: {
          catalogEntryDigest: `sha256:${'1'.repeat(64)}`,
          commit,
          kind: 'git',
          sensitivity: 'internal',
          sourceId: 'main-repo',
          sourceRef: 'main-repo',
          url: `https://127.0.0.1:${address.port}/repository.git`,
        },
        target: repoDir,
      },
    ]);

    try {
      await expect(
        runWorkerShim({
          args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
          environment: workerShimEnvironment(),
          runner,
        })
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(connections).toBeGreaterThan(0);
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(repoDir)).toBe(false);
  });

  it.each([
    {
      environmentOverride: { OPENKIT_CODEX_COMMAND: '["codex","exec"]' },
      label: 'environment command override',
      packageExtension: {},
    },
    {
      environmentOverride: {},
      label: 'package command override',
      packageExtension: { codexCommand: ['codex', 'exec'] },
    },
  ])('rejects the retired $label', async ({ environmentOverride, packageExtension }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-retired-worker-command-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
        },
        extensions: {
          openkit: { turnInput: 'Do not launch.', ...packageExtension },
        },
        llm: { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: { ...workerShimEnvironment(), ...environmentOverride },
        runner,
      })
    ).rejects.toThrow(/retired worker command override/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('keeps runtime-native ids out of provenance-enabled failure diagnostics', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-provenance-failed-'));
    const codexHome = join(sessionDir, 'native-state');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '13');
    const packagePath = join(sessionDir, 'package.json');
    const nativeThreadId = 'native-thread-canary';
    const nativeSessionId = 'native-session-canary';
    const primary = Buffer.from(
      `${JSON.stringify({ thread_id: nativeThreadId, type: 'thread.started' })}\n`
    );
    const rollout = `${JSON.stringify({
      payload: {
        cli_version: '0.153.4',
        cwd: sessionDir,
        id: nativeThreadId,
        originator: 'codex_exec',
        session_id: nativeSessionId,
        source: 'exec',
        timestamp: '2026-07-13T00:00:00.000Z',
      },
      timestamp: '2026-07-13T00:00:00.000Z',
      type: 'session_meta',
    })}\n`;
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
          transcript: {
            runtimeProvenance: {
              maxStreamCount: 8,
              maxTotalBytes: 1_048_576,
              nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
              rawStreamsRoot: '/openkit/session/runtime/raw',
              streamManifestPath: '/openkit/session/runtime/raw-streams.json',
            },
          },
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    const runner = new FakeWorkerProcessRunner({
      exitCode: 7,
      signal: null,
      stderr: `failed session=${nativeSessionId} thread=${nativeThreadId}\n`,
      stdout: primary.toString('utf8'),
    }, () => {
      mkdirSync(rolloutDir, { recursive: true });
      writeRawFileSync(join(rolloutDir, 'rollout-failed-root.jsonl'), rollout, 'utf8');
    }, [primary]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'failed' });

    const transcript = readFileSync(join(sessionDir, 'events.jsonl'), 'utf8');
    expect(transcript).not.toContain(nativeSessionId);
    expect(transcript).not.toContain(nativeThreadId);
  });
});

/** In-memory native process runner used by worker shim supervisor tests. */
class FakeWorkerProcessRunner implements WorkerProcessRunner {
  public readonly calls: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];

  private readonly result: Awaited<ReturnType<WorkerProcessRunner['run']>>;

  private readonly onRun: (() => void) | null;

  private readonly stdoutChunks: readonly Uint8Array[];

  /**
   * Creates one deterministic native process run.
   *
   * @param result Completed process result returned after all chunks are accepted.
   * @param onRun Optional process-start side effect.
   * @param stdoutChunks Ordered stdout chunks streamed through the supplied sink.
   */
  public constructor(
    result: Awaited<ReturnType<WorkerProcessRunner['run']>>,
    onRun: (() => void) | null = null,
    stdoutChunks: readonly Uint8Array[] = []
  ) {
    this.result = result;
    this.onRun = onRun;
    this.stdoutChunks = stdoutChunks;
  }

  /**
   * Streams configured stdout chunks with backpressure before returning the process result.
   *
   * @param input Process command and optional stdout sink.
   * @returns Configured process result after every stdout sink write resolves.
   */
  public async run(input: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    onStart?: (() => void) | undefined;
    writeStdout?: ((chunk: Uint8Array) => Promise<void>) | undefined;
  }): Promise<Awaited<ReturnType<WorkerProcessRunner['run']>>> {
    this.calls.push(input);
    input.onStart?.();
    this.onRun?.();
    for (const chunk of this.stdoutChunks) {
      await input.writeStdout?.(chunk);
    }

    return this.result;
  }
}

/** Native runner that completes only after its supervisor aborts the process. */
class AbortAwareWorkerProcessRunner implements WorkerProcessRunner {
  public aborted = false;

  public readonly started: Promise<void>;

  private markStarted: (() => void) | null = null;

  /** Creates a pending process and its deterministic start notification. */
  public constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  /**
   * Waits until the supplied abort signal terminates the fake native process.
   *
   * @param input Process input carrying the supervisor abort signal.
   * @returns Signal-terminated process result.
   */
  public async run(
    input: Parameters<WorkerProcessRunner['run']>[0]
  ): Promise<Awaited<ReturnType<WorkerProcessRunner['run']>>> {
    const signal = (input as typeof input & { signal?: AbortSignal }).signal;
    input.onStart?.();
    this.markStarted?.();

    return new Promise((resolve) => {
      const abort = () => {
        this.aborted = true;
        resolve({ exitCode: null, signal: 'SIGTERM', stderr: '', stdout: '' });
      };

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

/** Creates one exact credential-free remote Git source fixture. */
function remoteGitTestSource(sourceId: string): Readonly<Record<string, unknown>> {
  return {
    catalogEntryDigest: `sha256:${'1'.repeat(64)}`,
    commit: '0123456789abcdef0123456789abcdef01234567',
    kind: 'git',
    sensitivity: 'internal',
    sourceId,
    sourceRef: sourceId,
    url: `https://git.example.test/${sourceId}.git`,
  };
}

/**
 * Writes the minimal package manifest used by Git workspace tests.
 *
 * @param packagePath Package manifest path.
 * @param workspaceRoot Worker working directory.
 * @param inputs Writable Git workspace inputs.
 */
function writeGitWorkspacePackage(
  packagePath: string,
  workspaceRoot: string,
  inputs: ReadonlyArray<{
    readonly id: string;
    readonly source: Readonly<Record<string, unknown>>;
    readonly target: string;
  }>
): void {
  writeFileSync(
    packagePath,
    JSON.stringify({
      runtime: { command: { workingDirectory: workspaceRoot } },
      workspace: {
        inputs: inputs.map((input) => ({
          access: 'read-write',
          id: input.id,
          kind: 'directory',
          materialization: {
            changeSetManifestPath: '/openkit/session/workspace-changes.json',
            strategy: 'git',
          },
          source: input.source,
          target: input.target,
        })),
        root: workspaceRoot,
      },
    }),
    'utf8'
  );
}

/**
 * Creates the single already resolved LLM route consumed by worker adapter tests.
 *
 * @returns Worker-visible route with no adapter-owned selection or fallback.
 */
function workerLlmRoute(): Record<string, unknown> {
  return {
    credentialVisibility: 'placeholder',
    endpoint: {
      kind: 'openai-compatible',
      upstream: {
        kind: 'nanocore-gateway',
      },
    },
    id: 'worker-inference',
    model: 'gpt-5',
    providerInstanceId: 'provider_openai',
  };
}

/** Creates the fixed local Integration control projection used by shim fixtures. */
function workerIntegrationControl(targetRuntime = 'fixture-process'): Record<string, unknown> {
  return {
    adapter: { kind: 'openkit-worker-shim', targetRuntime },
    bindings: {
      capabilities: {
        pathPrefix: '/capabilities/',
        tokenRef: 'runtime://openkit/capability-token',
      },
      inference: {
        pathPrefix: '/inference/',
        tokenRef: 'runtime://openkit/inference-token',
      },
      workerControl: {
        pathPrefix: '/worker-control/',
        tokenRef: 'runtime://openkit/worker-control-token',
      },
    },
    mode: 'sandbox-integration',
  };
}

/**
 * Creates a sandbox environment fixture for worker supervision tests.
 *
 * @returns Worker-control environment variables plus optional adapter configuration.
 */
function workerShimEnvironment(): WorkerShimEnvironment {
  return {
    OPENKIT_AGENT_SESSION_ID: 'as_codex_1',
    OPENKIT_PACKAGE_SNAPSHOT_ID: 'pkg_codex_1',
    OPENKIT_REQUEST_ID: 'req_codex_1',
    OPENKIT_THREAD_ID: 'th_codex',
    OPENKIT_TURN_ID: 'turn_codex',
    OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value',
    OPENKIT_WORKSPACE_ID: 'ws_codex',
  };
}

/**
 * Builds the successful response body for one worker-control test endpoint.
 *
 * @param url Worker-control request URL.
 * @returns Endpoint-specific successful response body.
 */
function workerControlSuccessBody(url: string): Record<string, unknown> {
  if (url.endsWith('/commands/poll')) {
    return { commands: [] };
  }
  if (url.endsWith('/events/append') || url.endsWith('/final-status')) {
    return { accepted: true, diagnostics: [], schemaVersion: 1 };
  }

  return {};
}

/**
 * Runs the shim with the standard out-of-environment control credential used by tests.
 *
 * @param options Worker shim options under test.
 * @returns Supervised worker outcome.
 */
function runWorkerShim(options: WorkerShimRunOptions) {
  return runWorkerShimImplementation({ controlToken: 'token_codex_1', ...options });
}

/**
 * Writes test files while making valid minimal worker fixtures explicit direct-control packages.
 *
 * @param path Test file path.
 * @param data File content.
 * @param encoding Optional text encoding.
 */
function writeFileSync(path: string, data: string | Buffer, encoding?: BufferEncoding): void {
  if (typeof data === 'string' && path.endsWith('package.json')) {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.runtime) {
      const control =
        parsed.control && typeof parsed.control === 'object' && !Array.isArray(parsed.control)
          ? (parsed.control as Record<string, unknown>)
          : {};
      const command = (parsed.runtime as { command?: Record<string, unknown> }).command ?? {};
      const extensions =
        parsed.extensions &&
        typeof parsed.extensions === 'object' &&
        !Array.isArray(parsed.extensions)
          ? (parsed.extensions as Record<string, unknown>)
          : {};
      const openkit =
        extensions.openkit &&
        typeof extensions.openkit === 'object' &&
        !Array.isArray(extensions.openkit)
          ? (extensions.openkit as Record<string, unknown>)
          : {};
      data = JSON.stringify({
        ...parsed,
        control: {
          ...control,
          adapter: control.adapter ?? {
            kind: 'openkit-worker-shim',
            targetRuntime: 'fixture-process',
          },
          bindings: workerIntegrationControl().bindings,
          mode: 'sandbox-integration',
        },
        extensions: {
          ...extensions,
          openkit: { turnInput: 'void 0', ...openkit },
        },
        llm: parsed.llm ?? { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: {
          ...(parsed.runtime as Record<string, unknown>),
          command: {
            argv: ['openkit-worker-shim'],
            ...command,
          },
        },
      });
    }
  }

  writeRawFileSync(path, data, encoding);
}

/**
 * Checks whether one operating-system process still exists.
 *
 * @param pid Process identifier.
 * @returns True while signal zero can still address the process.
 */
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads JSONL records from a transcript file.
 *
 * @param path Transcript file path.
 * @returns Parsed JSONL records.
 */
function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
