import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync as writeRawFileSync,
} from 'node:fs';
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

const processFixtureAdapter = vi.hoisted(() => ({
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
    processFixtureLifecycle.collectBarrier = null;
    processFixtureLifecycle.collectResult = null;
    processFixtureLifecycle.finalizeBarrier = null;
    processFixtureLifecycle.markCollectStarted = null;
    processFixtureLifecycle.markFinalizeStarted = null;
    processFixtureLifecycle.prepareFailure = null;
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

  it('validates the direct control mode before completing a dry run', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-dry-run-control-'));
    const packagePath = join(sessionDir, 'package.json');
    writeRawFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
          mode: 'direct-nanocore',
        },
        extensions: { openkit: { turnInput: 'Validate the image.' } },
        llm: { routes: [workerLlmRoute()] },
        runtime: {
          command: {
            argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
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
  });

  it('rejects missing or unsupported direct control modes during a dry run', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-dry-run-mode-'));
    const missingModePath = join(sessionDir, 'missing-mode.json');
    const unsupportedModePath = join(sessionDir, 'unsupported-mode.json');
    writeRawFileSync(
      missingModePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    writeRawFileSync(
      unsupportedModePath,
      JSON.stringify({
        control: { mode: 'sidecar' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', missingModePath, '--dry-run']),
        environment: {},
      })
    ).rejects.toThrow('Worker shim requires control.mode to be direct-nanocore.');
    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', unsupportedModePath, '--dry-run']),
        environment: {},
      })
    ).rejects.toThrow('Worker shim requires control.mode to be direct-nanocore.');
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
            argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
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
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
              stopReason: 'worker-control-readiness-failed',
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
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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

  it('fails closed when a direct-control package has no control base URL', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-control-missing-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    const environment = workerShimEnvironment();
    delete environment.OPENKIT_CONTROL_BASE_URL;
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: { mode: 'direct-nanocore' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment,
        runner,
      })
    ).rejects.toThrow('OPENKIT_CONTROL_BASE_URL');
    expect(runner.calls).toEqual([]);
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
    ).rejects.toThrow('direct-nanocore');
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
        control: { mode: 'direct-nanocore' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    const run = runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...workerShimEnvironment(),
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
              stopReason: 'worker-parent-aborted',
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
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-process' },
          mode: 'direct-nanocore',
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
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
          url: 'https://nanocore.local/api/worker-control/commands/ack',
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            body: expect.objectContaining({
              status: 'interrupted',
              stopReason: 'worker-interrupt-command',
            }),
            operation: 'final_status',
            sequence: terminalRecord.sequence,
          }),
          url: 'https://nanocore.local/api/worker-control/final-status',
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
      expectedStopReason: 'Codex process exited with code 7.',
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
        url: 'https://nanocore.local/api/worker-control/final-status',
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
            stopReason: 'worker-parent-aborted',
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
              stopReason: 'worker-control-runtime-failed',
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
        '{"type":"thread.started","thread_id":"thread-root","label":"café"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
        '',
      ].join('\n'),
      'utf8'
    );
    const firstNewline = primary.indexOf('\n'.charCodeAt(0));
    const utf8Split = primary.indexOf(Buffer.from('é')) + 1;
    const rollout = [
      '{"timestamp":"2026-07-13T00:00:00.000Z","type":"session_meta","payload":{"session_id":"session-root","id":"thread-root","timestamp":"2026-07-13T00:00:00.000Z","cwd":"/workspace/openkit","originator":"codex_cli_rs","cli_version":"0.144.1","source":"exec"}}',
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
        adapterVersion: '0.144.1',
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
        nativeThreadId: 'thread-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0000.jsonl',
      }),
      expect.objectContaining({
        byteOffset: firstNewline + 1,
        eventKind: 'item.completed',
        frameSequence: 1,
        nativeThreadId: 'thread-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0000.jsonl',
      }),
      expect.objectContaining({
        eventKind: 'session_meta',
        frameSequence: 0,
        nativeSessionId: 'session-root',
        nativeThreadId: 'thread-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0001.jsonl',
      }),
      expect.objectContaining({
        eventKind: 'turn_context',
        frameSequence: 1,
        nativeThreadId: 'thread-root',
        nativeTurnId: 'turn-native-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0001.jsonl',
      }),
      expect.objectContaining({
        eventKind: 'response_item',
        frameSequence: 2,
        nativeThreadId: 'thread-root',
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
    const primary = Buffer.from('{"type":"thread.started","thread_id":"thread-root"}\n');
    const rollout = `${JSON.stringify({
      payload: {
        cli_version: '0.144.1',
        cwd: sessionDir,
        id: 'thread-root',
        originator: 'codex_exec',
        session_id: 'session-root',
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
    processFixtureLifecycle.prepareFailure = async (root) => {
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
  });

  it('keeps the CLI control descriptor secret out of the supervisor and native environments', async () => {
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
      OPENKIT_CONTROL_TOKEN_FD: String(controlTokenDescriptor),
      OPENKIT_PARENT_ONLY_SECRET: parentSecret,
      OPENKIT_WORKER_INFERENCE_TOKEN: inferencePlaceholder,
    };
    delete injectedEnvironment.OPENKIT_CONTROL_TOKEN;
    for (const [key, value] of Object.entries(injectedEnvironment)) {
      vi.stubEnv(key, value);
    }

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

    expect(existsSync(join(sessionDir, 'items.jsonl'))).toBe(false);
    expect(transcript).not.toContain(credential);
    expect(terminalRecord.event.data.stopReason).toBe('worker-assistant-output-rejected');
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
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
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
              id: 'github',
              version: '1.0.0',
              sourceRef: 'server:mcp/github',
              allowedTools: ['repos.get'],
              reviewStatus: 'approved',
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

  it('writes a git workspace change manifest after a successful native process', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-workspace-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    let outputPublishedBeforeFinalStatus = false;
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/final-status')) {
        outputPublishedBeforeFinalStatus =
          existsSync(join(sessionDir, 'workspace-changes.json')) &&
          existsSync(join(sessionDir, 'workspace.patch'));
      }
      return new Response(JSON.stringify(workerControlSuccessBody(url)), { status: 200 });
    });
    mkdirSync(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'worker@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Worker'], { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    const runner = new FakeWorkerProcessRunner(
      {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '',
      },
      () => {
        mkdirSync(join(repoDir, 'temp', 'research'), { recursive: true });
        writeFileSync(join(repoDir, 'README.md'), '# Demo\n\nUpdated by worker.\n', 'utf8');
        writeFileSync(
          join(repoDir, 'temp', 'research', 'worker-report.md'),
          '# Worker Report\n',
          'utf8'
        );
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        runtime: {
          command: {
            workingDirectory: repoDir,
          },
        },
        workspace: {
          root: repoDir,
          inputs: [
            {
              access: 'read-write',
              id: 'repo',
              kind: 'directory',
              materialization: {
                changeSetManifestPath: '/openkit/session/workspace-changes.json',
                strategy: 'git',
              },
              source: { kind: 'host-dir', pathRef: 'workspace-root://repo' },
              target: repoDir,
            },
          ],
        },
      }),
      'utf8'
    );

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner,
    });

    const manifest = JSON.parse(readFileSync(join(sessionDir, 'workspace-changes.json'), 'utf8'));
    const patch = readFileSync(join(sessionDir, 'workspace.patch'), 'utf8');

    expect(manifest).toMatchObject({
      base: { commit: baseCommit, contentDigest: null },
      changedPaths: [
        { binary: false, path: 'README.md', status: 'modified' },
        { binary: false, path: 'temp/research/worker-report.md', status: 'added' },
      ],
      evidenceRefs: [{ kind: 'worker', ref: 'turn_codex' }],
      inputSnapshotId: 'wis_pkg_codex_1_repo',
      materializationRecordId: 'wmr_pkg_codex_1_repo',
      patch: {
        bytes: expect.any(Number),
        digest: expect.stringMatching(/^sha256:/),
        ref: 'worker-session://workspace.patch',
      },
      resourceId: 'repo',
      strategy: 'git',
      workspaceId: 'ws_codex',
    });
    expect(outputPublishedBeforeFinalStatus).toBe(true);
    expect(patch.endsWith('\n')).toBe(true);
  });

  it.each([
    {
      after: (credential: string) => Buffer.from(`# After\n${credential}\n`),
      before: Buffer.from('# Before\n'),
      credential: 'multiline-credential-first\nmultiline-credential-second',
      label: 'multiline text',
      path: 'README.md',
    },
    {
      after: (credential: string) =>
        Buffer.concat([
          Buffer.from([0, 255]),
          Buffer.from(credential, 'utf8'),
          Buffer.from([0, 1]),
        ]),
      before: Buffer.from([0, 1]),
      credential: 'binary-credential-秘密-canary',
      label: 'binary',
      path: 'artifact.bin',
    },
  ])('rejects an injected credential in staged $label bytes', async ({
    after,
    before,
    credential,
    path,
  }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-workspace-secret-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { [path]: before });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, path), after(credential))
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...workerShimEnvironment(),
          OPENKIT_WORKER_INFERENCE_TOKEN: credential,
        },
        runner,
      })
    ).rejects.toThrow('Git workspace staged content contains an injected credential.');

    expect(runner.calls[0]?.env.OPENKIT_WORKER_INFERENCE_TOKEN).toBe(credential);
    expect(
      [
        'workspace.patch',
        'workspace.patch.tmp',
        'workspace-changes.json',
        'workspace-changes.json.tmp',
        'workspace-git.index',
        'workspace-git.index.lock',
      ].map((name) => existsSync(join(sessionDir, name)))
    ).toEqual([false, false, false, false, false, false]);
    const transcript = [
      ...readJsonl(join(sessionDir, 'events.jsonl')),
      ...(existsSync(join(sessionDir, 'items.jsonl'))
        ? readJsonl(join(sessionDir, 'items.jsonl'))
        : []),
    ] as Array<{ event?: { data?: { status?: string }; type?: string } }>;
    expect(transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            data: expect.objectContaining({ status: 'failed' }),
            type: 'turn.failed',
          }),
        }),
      ])
    );
    const transcriptText = ['events.jsonl', 'items.jsonl']
      .filter((name) => existsSync(join(sessionDir, name)))
      .map((name) => readFileSync(join(sessionDir, name), 'utf8'))
      .join('\n');
    expect(transcriptText).not.toContain(credential);
    expect(transcriptText).not.toContain(JSON.stringify(credential).slice(1, -1));
  });

  it('writes exact binary blob and chmod metadata for NanoCore review staging', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-git-metadata-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const nextBinary = Buffer.from([0, 1, 2, 3, 255, 254, 253, 0]);
    mkdirSync(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'worker@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Worker'], { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'artifact.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repoDir, 'content.sh'), '#!/bin/sh\necho before\n', 'utf8');
    writeFileSync(join(repoDir, 'deleted.txt'), 'Delete me.\n', 'utf8');
    writeFileSync(join(repoDir, 'rename-before.txt'), 'Rename me.\n', 'utf8');
    writeFileSync(join(repoDir, 'run.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(join(repoDir, 'content.sh'), 0o644);
    chmodSync(join(repoDir, 'run.sh'), 0o644);
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
    const runner = new FakeWorkerProcessRunner(
      {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '',
      },
      () => {
        writeFileSync(join(repoDir, 'artifact.bin'), nextBinary);
        writeFileSync(join(repoDir, 'content.sh'), '#!/bin/sh\necho after\n', 'utf8');
        chmodSync(join(repoDir, 'content.sh'), 0o755);
        unlinkSync(join(repoDir, 'deleted.txt'));
        renameSync(join(repoDir, 'rename-before.txt'), join(repoDir, 'rename-after.txt'));
        chmodSync(join(repoDir, 'run.sh'), 0o755);
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        runtime: { command: { workingDirectory: repoDir } },
        workspace: {
          inputs: [
            {
              access: 'read-write',
              id: 'repo',
              kind: 'directory',
              materialization: {
                changeSetManifestPath: '/openkit/session/workspace-changes.json',
                strategy: 'git',
              },
              source: { kind: 'host-dir', pathRef: 'workspace-root://repo' },
              target: repoDir,
            },
          ],
          root: repoDir,
        },
      }),
      'utf8'
    );

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner,
    });

    const manifest = JSON.parse(readFileSync(join(sessionDir, 'workspace-changes.json'), 'utf8'));
    const digest = `sha256:${createHash('sha256').update(nextBinary).digest('hex')}`;
    expect(manifest.changedPaths).toHaveLength(5);
    expect(manifest.changedPaths).toEqual(
      expect.arrayContaining([
        {
          binary: true,
          binaryReview: {
            bytes: nextBinary.byteLength,
            digest,
            mediaType: 'application/octet-stream',
            mode: 'artifact-only',
            reason: 'binary-path',
            summary: expect.any(String),
          },
          digest,
          path: 'artifact.bin',
          size: nextBinary.byteLength,
          status: 'modified',
        },
        {
          binary: false,
          newPermissions: '0755',
          oldPermissions: '0644',
          path: 'content.sh',
          status: 'modified',
        },
        { binary: false, path: 'deleted.txt', status: 'deleted' },
        {
          binary: false,
          oldPath: 'rename-before.txt',
          path: 'rename-after.txt',
          status: 'renamed',
        },
        {
          binary: false,
          newPermissions: '0755',
          oldPermissions: '0644',
          path: 'run.sh',
          status: 'mode_changed',
        },
      ])
    );
  });

  it('collects worker commits as a complete patch against the captured base', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-committed-workspace-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const baseCommit = initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    let workerCommit = '';
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => {
        writeFileSync(join(repoDir, 'README.md'), '# After worker commit\n', 'utf8');
        execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'worker change'], { cwd: repoDir, stdio: 'ignore' });
        workerCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repoDir,
          encoding: 'utf8',
        }).trim();
      }
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner,
    });

    const manifest = JSON.parse(readFileSync(join(sessionDir, 'workspace-changes.json'), 'utf8'));
    const patch = readFileSync(join(sessionDir, 'workspace.patch'), 'utf8');
    const verificationDir = join(sessionDir, 'verification');
    expect(manifest).toMatchObject({
      base: { commit: baseCommit },
      changedPaths: [{ binary: false, path: 'README.md', status: 'modified' }],
      head: { commit: workerCommit },
    });
    execFileSync('git', ['worktree', 'add', '--detach', verificationDir, baseCommit], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['apply', '--check', '-'], {
      cwd: verificationDir,
      input: patch,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  });

  it('preserves trailing spaces on the final changed patch line', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-trailing-spaces-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'README.md'), '# After   \n', 'utf8')
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner,
    });

    expect(readFileSync(join(sessionDir, 'workspace.patch'), 'utf8')).toContain('+# After   \n');
  });

  it('describes binary changes with canonical Git blob bytes after EOL conversion', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-canonical-binary-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const nextBinary = Buffer.from([0, 98, 13, 10]);
    initializeGitRepository(repoDir, {
      '.gitattributes': 'artifact.bin text eol=lf\n',
      'artifact.bin': Buffer.from([0, 97, 10]),
    });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'artifact.bin'), nextBinary)
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner,
    });

    const objectId = execFileSync(
      'git',
      ['hash-object', '-w', '--path=artifact.bin', 'artifact.bin'],
      { cwd: repoDir, encoding: 'utf8' }
    ).trim();
    const canonicalBlob = execFileSync('git', ['cat-file', 'blob', objectId], { cwd: repoDir });
    const digest = `sha256:${createHash('sha256').update(canonicalBlob).digest('hex')}`;
    const manifest = JSON.parse(readFileSync(join(sessionDir, 'workspace-changes.json'), 'utf8'));
    expect(canonicalBlob.equals(nextBinary)).toBe(false);
    expect(manifest.changedPaths).toEqual([
      expect.objectContaining({
        binary: true,
        binaryReview: expect.objectContaining({ bytes: canonicalBlob.byteLength, digest }),
        digest,
        path: 'artifact.bin',
        size: canonicalBlob.byteLength,
        status: 'modified',
      }),
    ]);
  });

  it('fails closed when a changed path uses a custom Git clean filter', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-clean-filter-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, {
      '.gitattributes': 'artifact.bin filter=openkit-review -text\n',
      'artifact.bin': Buffer.from([0, 1]),
    });
    execFileSync('git', ['config', 'filter.openkit-review.clean', 'cat'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'filter.openkit-review.smudge', 'cat'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'filter.openkit-review.required', 'true'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'artifact.bin'), Buffer.from([0, 2]))
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/filter/i);
  });

  it('rejects a custom clean filter without executing it', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-filter-side-effect-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const markerPath = join(sessionDir, 'filter-ran');
    initializeGitRepository(repoDir, {
      '.gitattributes': 'artifact.bin filter=openkit-review -text\n',
      'artifact.bin': Buffer.from([0, 1]),
    });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => {
        execFileSync('git', ['config', 'filter.openkit-review.clean', 'tee ../filter-ran'], {
          cwd: repoDir,
          stdio: 'ignore',
        });
        execFileSync('git', ['config', 'filter.openkit-review.required', 'true'], {
          cwd: repoDir,
          stdio: 'ignore',
        });
        writeFileSync(join(repoDir, 'artifact.bin'), Buffer.from([0, 2]));
      }
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/filter/i);
    expect(runner.calls).toHaveLength(1);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not execute a clean filter on an unchanged path while collecting another change', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-unchanged-filter-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const markerPath = join(sessionDir, 'filter-ran');
    initializeGitRepository(repoDir, {
      '.gitattributes': 'unchanged.bin filter=openkit-review -text\n',
      'changed.txt': 'Before\n',
      'unchanged.bin': Buffer.from([0, 1]),
    });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => {
        execFileSync('git', ['config', 'filter.openkit-review.clean', 'tee ../filter-ran'], {
          cwd: repoDir,
          stdio: 'ignore',
        });
        execFileSync('git', ['config', 'filter.openkit-review.required', 'true'], {
          cwd: repoDir,
          stdio: 'ignore',
        });
        writeFileSync(join(repoDir, 'changed.txt'), 'After\n', 'utf8');
      }
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(existsSync(markerPath)).toBe(false);
  });

  it('rejects multiple writable Git workspace inputs before starting the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-multiple-git-inputs-'));
    const firstRepoDir = join(sessionDir, 'first');
    const secondRepoDir = join(sessionDir, 'second');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(firstRepoDir, { 'README.md': '# First\n' });
    initializeGitRepository(secondRepoDir, { 'README.md': '# Second\n' });
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, firstRepoDir, [
      { id: 'first', target: firstRepoDir },
      { id: 'second', target: secondRepoDir },
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

  it('rejects an unavailable Git base before starting the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-missing-base-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    mkdirSync(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/base|commit|HEAD/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a dirty writable Git workspace before starting the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-dirty-workspace-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    writeFileSync(join(repoDir, 'README.md'), '# Preexisting change\n', 'utf8');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/clean|dirty|preexisting|uncommitted/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('accepts a clean Git workspace after tar transport changes filesystem metadata', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-transported-git-'));
    const sourceRepoDir = join(sessionDir, 'source-repo');
    const repoDir = join(sessionDir, 'repo');
    const bundlePath = join(sessionDir, 'repo.tar');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(sourceRepoDir, { 'README.md': '# Clean transported repository\n' });
    mkdirSync(repoDir);
    execFileSync('tar', ['-cf', bundlePath, '-C', sourceRepoDir, '.'], { stdio: 'ignore' });
    execFileSync('tar', ['-xf', bundlePath, '-C', repoDir], { stdio: 'ignore' });
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(runner.calls).toHaveLength(1);
  });

  it.each([
    '--assume-unchanged',
    '--skip-worktree',
  ] as const)('rejects dirty workspace state hidden by %s before starting the worker', async (flag) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-hidden-dirty-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    execFileSync('git', ['update-index', flag, 'README.md'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    writeFileSync(join(repoDir, 'README.md'), '# Hidden preexisting change\n', 'utf8');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/clean|hide|index|lineage/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('ignores ambient GIT_DIR when inspecting a writable workspace', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-ambient-git-dir-'));
    const repoDir = join(sessionDir, 'repo');
    const redirectRepoDir = join(sessionDir, 'redirect-repo');
    const packagePath = join(sessionDir, 'package.json');
    const baseCommit = initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    initializeGitRepository(redirectRepoDir, { 'DECOY.md': '# Wrong repository\n' });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'README.md'), '# After\n', 'utf8')
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(redirectRepoDir, '.git');

    try {
      await runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      });
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
    }

    const manifest = JSON.parse(readFileSync(join(sessionDir, 'workspace-changes.json'), 'utf8'));
    expect(manifest.base.commit).toBe(baseCommit);
    expect(runner.calls).toHaveLength(1);
  });

  it('fails closed when the worker changes .gitattributes', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-attributes-change-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, '.gitattributes'), '*.txt text eol=lf\n', 'utf8')
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/gitattributes|attribute/i);
    expect(runner.calls).toHaveLength(1);
  });

  it('removes stale review outputs when a reused session has no changes', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-reused-session-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const patchPath = join(sessionDir, 'workspace.patch');
    const manifestPath = join(sessionDir, 'workspace-changes.json');
    initializeGitRepository(repoDir, { 'README.md': '# Unchanged\n' });
    writeFileSync(patchPath, 'stale patch\n', 'utf8');
    writeFileSync(manifestPath, '{"stale":true}\n', 'utf8');
    const runner = new FakeWorkerProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await runWorkerShim({
      args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: workerShimEnvironment(),
      runner,
    });

    expect([existsSync(patchPath), existsSync(manifestPath)]).toEqual([false, false]);
  });

  it('removes review outputs when manifest publication fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-manifest-failure-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const patchPath = join(sessionDir, 'workspace.patch');
    const manifestPath = join(sessionDir, 'workspace-changes.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    const runner = new FakeWorkerProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => {
        writeFileSync(join(repoDir, 'README.md'), '# After\n', 'utf8');
        mkdirSync(manifestPath);
      }
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: workerShimEnvironment(),
        runner,
      })
    ).rejects.toThrow();
    expect([existsSync(patchPath), existsSync(manifestPath)]).toEqual([false, false]);
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
        cli_version: '0.144.1',
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

/**
 * Creates one committed Git repository for worker workspace tests.
 *
 * @param repoDir Repository directory.
 * @param files Initial file contents keyed by repository-relative path.
 * @returns Initial commit id.
 */
function initializeGitRepository(
  repoDir: string,
  files: Readonly<Record<string, string | Buffer>>
): string {
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'worker@example.com'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Worker'], { cwd: repoDir, stdio: 'ignore' });
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repoDir, path), content);
  }
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
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
  inputs: ReadonlyArray<{ readonly id: string; readonly target: string }>
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
          source: { kind: 'host-dir', pathRef: `workspace-root://${input.id}` },
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
        baseUrlRef: 'runtime://nanocore/worker-inference/v1',
        kind: 'nanocore-gateway',
      },
      workerBaseUrl: 'https://nanocore.local/api/worker-inference/v1',
    },
    id: 'worker-inference',
    model: 'gpt-5',
    providerInstanceId: 'provider_openai',
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
    OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
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
          adapter: control.adapter ?? { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
          mode: 'direct-nanocore',
        },
        extensions: {
          ...extensions,
          openkit: { turnInput: 'void 0', ...openkit },
        },
        llm: parsed.llm ?? { mode: 'gateway', routes: [workerLlmRoute()] },
        runtime: {
          ...(parsed.runtime as Record<string, unknown>),
          command: {
            argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
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
