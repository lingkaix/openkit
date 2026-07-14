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
  type CodexProcessRunner,
  type CodexShimEnvironment,
  type CodexShimRunOptions,
  parseCodexShimArgs,
  runCodexShimCli,
  runCodexShim as runCodexShimImplementation,
  type WorkerControlCommandRunner,
} from './cli.js';
import type { WorkerControlFetch } from './control-client.js';

describe('worker shim CLI parsing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      return new Response(JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}), {
        status: 200,
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses Codex shim arguments', () => {
    expect(
      parseCodexShimArgs([
        '--package',
        '/openkit/config/package.json',
        '--session-dir',
        '/openkit/session',
        '--artifact-dir',
        '/openkit/artifacts',
        '--dry-run',
      ])
    ).toEqual({
      artifactDir: '/openkit/artifacts',
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

    await expect(runCodexShimCli(['--help'], (line) => output.push(line))).resolves.toBeUndefined();

    expect(output).toEqual([
      'Usage: openkit-codex-shim --package <path> [--session-dir <path>] [--artifact-dir <path>] [--dry-run]\n',
    ]);
    expect(getEventListeners(process, 'SIGINT')).toHaveLength(signalListeners.interrupt);
    expect(getEventListeners(process, 'SIGTERM')).toHaveLength(signalListeners.termination);
  });

  it('rejects missing required arguments with product-safe errors', () => {
    expect(() => parseCodexShimArgs(['--session-dir', '/openkit/session'])).toThrow(
      'Missing required --package argument.'
    );
  });

  it('validates the direct control mode before completing a dry run', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-dry-run-control-'));
    const packagePath = join(sessionDir, 'package.json');
    writeRawFileSync(
      packagePath,
      JSON.stringify({
        control: { mode: 'direct-nanocore' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--dry-run']),
        environment: {},
      })
    ).resolves.toEqual({ exitCode: 0, signal: null, status: 'completed' });
  });

  it('rejects missing or unsupported direct control modes during a dry run', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-dry-run-mode-'));
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', missingModePath, '--dry-run']),
        environment: {},
      })
    ).rejects.toThrow('Codex shim requires control.mode to be direct-nanocore.');
    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', unsupportedModePath, '--dry-run']),
        environment: {},
      })
    ).rejects.toThrow('Codex shim requires control.mode to be direct-nanocore.');
  });

  it('executes terminal commands returned by NanoCore and reports terminal results', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-control-terminal-'));
    const packagePath = join(sessionDir, 'package.json');
    const commandRunner = new FakeControlCommandRunner({
      durationMs: 4,
      exitCode: 0,
      stderr: '',
      stdout: '/workspace/openkit\n',
    });
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    const requests: Array<{ body: unknown; headers: Record<string, string>; url: string }> = [];
    let pollCount = 0;
    const fetch: WorkerControlFetch = async (url, init) => {
      requests.push({
        body: JSON.parse(String(init.body)) as unknown,
        headers: Object.fromEntries(
          Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value])
        ),
        url,
      });

      if (url.endsWith('/commands/poll') && pollCount++ === 0) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              commands: [
                {
                  argv: ['pwd'],
                  commandId: 'term_control_1',
                  cwd: '/workspace/openkit',
                  kind: 'terminal-command',
                },
              ],
            }),
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      commandRunner,
      environment: codexShimEnvironment(),
      fetch,
      runner,
    });

    expect(commandRunner.calls).toEqual([
      expect.objectContaining({
        argv: ['pwd'],
        cwd: '/workspace/openkit',
        signal: expect.any(AbortSignal),
      }),
    ]);
    expect(commandRunner.calls[0]?.env).not.toHaveProperty('OPENKIT_CONTROL_TOKEN');
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            exitCode: 0,
            stdout: '/workspace/openkit\n',
            terminalCommandId: 'term_control_1',
          }),
          url: 'https://nanocore.local/api/worker-control/terminal-results',
        }),
      ])
    );
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: {
            data: {
              status: 'starting',
            },
            type: 'worker.heartbeat',
          },
          sequence: 0,
        }),
        expect.objectContaining({
          event: {
            data: {
              commandId: 'term_control_1',
              exitCode: 0,
              status: 'command.terminal_result',
            },
            type: 'worker.heartbeat',
          },
          sequence: 1,
        }),
      ])
    );
  });

  it('keeps ambient control tokens out of real terminal command processes', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-control-terminal-env-'));
    const packagePath = join(sessionDir, 'package.json');
    const terminalResults: unknown[] = [];
    let pollCount = 0;
    const fetch: WorkerControlFetch = async (url, init) => {
      if (url.endsWith('/commands/poll') && pollCount++ === 0) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              commands: [
                {
                  argv: [
                    process.execPath,
                    '-e',
                    "process.stdout.write(process.env.OPENKIT_CONTROL_TOKEN ?? 'missing')",
                  ],
                  commandId: 'term_control_env_1',
                  cwd: sessionDir,
                  kind: 'terminal-command',
                },
              ],
            }),
        };
      }
      if (url.endsWith('/terminal-results')) {
        terminalResults.push(JSON.parse(init.body) as unknown);
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    vi.stubEnv('OPENKIT_CONTROL_TOKEN', 'ambient_control_token');

    try {
      await runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        fetch,
        runner: new FakeCodexProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(terminalResults).toEqual([
      expect.objectContaining({ stdout: 'missing', terminalCommandId: 'term_control_env_1' }),
    ]);
  });

  it('waits for worker-control readiness before starting Codex', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-control-ready-'));
    const packagePath = join(sessionDir, 'package.json');
    const order: string[] = [];
    const fetch: WorkerControlFetch = async (url) => {
      order.push(
        url.endsWith('/heartbeat')
          ? 'heartbeat'
          : url.endsWith('/commands/poll')
            ? 'poll'
            : 'final-status'
      );
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
      };
    };
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => order.push('codex')
    );
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...codexShimEnvironment(),
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
      },
      fetch,
      runner,
    });

    expect(order).toEqual(['heartbeat', 'poll', 'codex', 'final-status']);
    expect(
      readJsonl(join(sessionDir, 'events.jsonl')).map(
        (record) => (record as { sequence: number }).sequence
      )
    ).toEqual([0, 1, 2, 3]);
  });

  it('does not start Codex when initial worker-control readiness fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-control-rejected-'));
    const packagePath = join(sessionDir, 'package.json');
    const upstreamSecret = 'upstream-secret-must-not-reach-transcript';
    const runner = new FakeCodexProcessRunner({
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
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
              reason: 'worker-control-readiness-failed',
              status: 'failed',
            },
            type: 'turn.failed',
          },
        }),
      ])
    );
    expect(JSON.stringify(transcript)).not.toContain(upstreamSecret);
    expect(JSON.stringify(transcript)).not.toContain('private upstream diagnostic');
  });

  it('fails readiness without starting Codex when worker control does not respond', async () => {
    vi.useFakeTimers();
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-control-timeout-'));
    const packagePath = join(sessionDir, 'package.json');
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const runner = new FakeCodexProcessRunner({
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
      const run = runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
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

  it('does not apply the readiness deadline to an accepted initial terminal command', async () => {
    vi.useFakeTimers();
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-ready-terminal-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    let markCommandStarted: (() => void) | undefined;
    let releaseCommand: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const commandRunner: WorkerControlCommandRunner = {
      async run() {
        markCommandStarted?.();
        return new Promise((resolve) => {
          releaseCommand = () =>
            resolve({ durationMs: 10_001, exitCode: 0, stderr: '', stdout: 'ready\n' });
        });
      },
    };
    let pollCount = 0;
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: { mode: 'direct-nanocore' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      commandRunner,
      environment: codexShimEnvironment(),
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith('/commands/poll') && pollCount++ === 0
              ? {
                  commands: [
                    {
                      argv: ['long-initial-command'],
                      commandId: 'term_initial_long_1',
                      cwd: sessionDir,
                      kind: 'terminal-command',
                    },
                  ],
                }
              : { commands: [] }
          ),
      }),
      runner,
    });
    let outcome: 'rejected' | 'resolved' | null = null;
    void run.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      }
    );

    try {
      await commandStarted;
      await vi.advanceTimersByTimeAsync(10_001);
      expect(outcome).toBeNull();
      releaseCommand?.();
      await expect(run).resolves.toMatchObject({ status: 'completed' });
    } finally {
      releaseCommand?.();
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('cancels Codex when the live worker-control fails', async () => {
    vi.useFakeTimers();
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-control-failed-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new AbortAwareCodexProcessRunner();
    let heartbeatCount = 0;
    const fetch: WorkerControlFetch = async (url) => {
      if (url.endsWith('/heartbeat')) {
        heartbeatCount += 1;
        if (heartbeatCount > 1) {
          return {
            ok: false,
            status: 503,
            text: async () => JSON.stringify({ code: 'worker_control_unavailable' }),
          };
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    try {
      const run = runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
        },
        fetch,
        runner,
      });
      await runner.started;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(run).rejects.toThrow('worker_control_unavailable');
      expect(runner.aborted).toBe(true);
      expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              data: expect.objectContaining({ reason: 'worker-control-runtime-failed' }),
              type: 'turn.failed',
            }),
          }),
        ])
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a process failure that wins the control shutdown race', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-process-first-'));
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
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
            text: async () =>
              JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
          };
        },
        runner: {
          async run() {
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-process-abort-first-'));
    const packagePath = join(sessionDir, 'package.json');
    const processError = new Error('process-failed-before-control-abort');
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner: {
          async run() {
            throw processError;
          },
        },
      })
    ).rejects.toBe(processError);
  });

  it('preserves the primary runtime failure when terminal transcript persistence also fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-primary-failure-'));
    const packagePath = join(sessionDir, 'package.json');
    const eventsPath = join(sessionDir, 'events.jsonl');
    const runtimeError = new Error('primary-runtime-failure');
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner: {
          async run() {
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-control-owner-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    const controlError = new Error('control-failed-before-parent-abort');
    let heartbeatCount = 0;
    let markCodexAborted: (() => void) | undefined;
    let releaseCodex: (() => void) | undefined;
    const codexAborted = new Promise<void>((resolve) => {
      markCodexAborted = resolve;
    });
    const codexReleased = new Promise<void>((resolve) => {
      releaseCodex = resolve;
    });
    const runner: CodexProcessRunner = {
      async run(input) {
        return new Promise((resolve) => {
          const finish = () => {
            markCodexAborted?.();
            void codexReleased.then(() =>
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
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
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
          text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
        };
      },
      runner,
      signal: controller.signal,
    });

    try {
      await codexAborted;
      controller.abort();
      releaseCodex?.();

      await expect(run).rejects.toBe(controlError);
    } finally {
      controller.abort();
      releaseCodex?.();
      await run.catch(() => undefined);
    }
  });

  it('removes heartbeat-delay listeners after immediate terminal commands', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-terminal-listeners-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    const commands = Array.from({ length: 20 }, (_, index) => ({
      argv: ['true'],
      commandId: `term_listener_${index}`,
      cwd: sessionDir,
      kind: 'terminal-command',
    }));
    let pollCount = 0;
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    try {
      await runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        commandRunner: {
          async run() {
            return { durationMs: 0, exitCode: 0, stderr: '', stdout: '' };
          },
        },
        environment: codexShimEnvironment(),
        fetch: async (url) => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              url.endsWith('/commands/poll') && pollCount++ === 0 ? { commands } : { commands: [] }
            ),
        }),
        runner: new FakeCodexProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
        signal: controller.signal,
      });

      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      controller.abort();
    }
  });

  it('fails closed when a direct-control package has no control base URL', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-control-missing-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    const environment = codexShimEnvironment();
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment,
        runner,
      })
    ).rejects.toThrow('OPENKIT_CONTROL_BASE_URL');
    expect(runner.calls).toEqual([]);
  });

  it.each([undefined, 'control-control'])('rejects unsupported control mode %s', async (mode) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-control-mode-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
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
      label: 'a malformed supported command',
    },
  ])('fails closed on $label', async ({ command }) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-invalid-command-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        fetch: async (url) => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(url.endsWith('/commands/poll') ? { commands: [command] } : {}),
        }),
        runner,
      })
    ).rejects.toThrow('Unsupported worker control command');
    expect(runner.calls).toEqual([]);
  });

  it('records parent cancellation during control readiness as interrupted', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-readiness-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
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

    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...codexShimEnvironment(),
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
              reason: 'worker-parent-aborted',
              status: 'interrupted',
            }),
            type: 'turn.failed',
          }),
        }),
      ])
    );
  });

  it('cancels the control and Codex process when the parent supervisor aborts', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-parent-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new AbortAwareCodexProcessRunner();
    const controller = new AbortController();
    const fetch: WorkerControlFetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
    });
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...codexShimEnvironment(),
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-heartbeat-status-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new AbortAwareCodexProcessRunner();
    const controller = new AbortController();
    const heartbeats: Array<{ sequence: number; status: string }> = [];
    const fetch: WorkerControlFetch = async (url, init) => {
      if (url.endsWith('/heartbeat')) {
        const body = JSON.parse(init.body) as { sequence: number; status: string };
        heartbeats.push({ sequence: body.sequence, status: body.status });
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...codexShimEnvironment(),
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

  it('fails closed when a periodic worker-control request exceeds ten seconds', async () => {
    vi.useFakeTimers();
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-periodic-timeout-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new AbortAwareCodexProcessRunner();
    const controller = new AbortController();
    let heartbeatCount = 0;
    let markPeriodicFetchStarted: (() => void) | undefined;
    const periodicFetchStarted = new Promise<void>((resolve) => {
      markPeriodicFetchStarted = resolve;
    });
    const fetch: WorkerControlFetch = async (url, init) => {
      if (url.endsWith('/heartbeat')) {
        heartbeatCount += 1;
        if (heartbeatCount > 1) {
          markPeriodicFetchStarted?.();
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...codexShimEnvironment(),
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
      },
      fetch,
      runner,
      signal: controller.signal,
    });

    try {
      await runner.started;
      await vi.advanceTimersByTimeAsync(1_000);
      await periodicFetchStarted;
      const outcome = run.then(
        () => 'unexpected-success',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      await vi.advanceTimersByTimeAsync(10_001);

      expect(await outcome).toContain('Worker control request timed out');
      expect(runner.aborted).toBe(true);
    } finally {
      controller.abort();
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('continues polling and delivers interrupts while a terminal command is running', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-terminal-heartbeat-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new AbortAwareCodexProcessRunner();
    const controller = new AbortController();
    const heartbeatSequences: number[] = [];
    let pollCount = 0;
    let markCommandStarted: (() => void) | undefined;
    let commandAborted = false;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const commandRunner: WorkerControlCommandRunner = {
      async run(input) {
        markCommandStarted?.();
        return new Promise((resolve) => {
          const finish = () => {
            commandAborted = true;
            resolve({ durationMs: 1, exitCode: 143, stderr: '', stdout: '' });
          };
          if (input.signal.aborted) {
            finish();
            return;
          }
          input.signal.addEventListener('abort', finish, { once: true });
        });
      },
    };
    const fetch: WorkerControlFetch = async (url, init) => {
      if (url.endsWith('/heartbeat')) {
        heartbeatSequences.push((JSON.parse(init.body) as { sequence: number }).sequence);
      }
      if (url.endsWith('/commands/poll')) {
        pollCount += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              commands:
                pollCount === 2
                  ? [
                      {
                        argv: ['long-command'],
                        commandId: 'term_long_1',
                        cwd: sessionDir,
                        kind: 'terminal-command',
                      },
                    ]
                  : pollCount === 3
                    ? [
                        {
                          commandId: 'interrupt_during_terminal_1',
                          kind: 'interrupt',
                          reason: 'user-stop',
                        },
                      ]
                    : [],
            }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      commandRunner,
      environment: {
        ...codexShimEnvironment(),
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
      },
      fetch,
      runner,
      signal: controller.signal,
    });

    try {
      await runner.started;
      await commandStarted;
      await vi.waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(3), { timeout: 4_000 });
      await expect(run).resolves.toMatchObject({ status: 'interrupted' });
      expect(commandAborted).toBe(true);
      expect(runner.aborted).toBe(true);
      expect(heartbeatSequences).toEqual([0, 1, 2]);
    } finally {
      controller.abort();
      await run.catch(() => undefined);
    }
  });

  it('cancels a running terminal command before waiting for interrupt acknowledgement', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-terminal-interrupt-ack-'));
    const packagePath = join(sessionDir, 'package.json');
    const controller = new AbortController();
    let pollCount = 0;
    let commandAborted = false;
    let markCommandStarted: (() => void) | undefined;
    let markAckStarted: (() => void) | undefined;
    let releaseAck: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const ackStarted = new Promise<void>((resolve) => {
      markAckStarted = resolve;
    });
    const commandRunner: WorkerControlCommandRunner = {
      async run(input) {
        markCommandStarted?.();
        return new Promise((resolve) => {
          /** Completes the fake terminal process after supervisor cancellation. */
          const finish = () => {
            commandAborted = true;
            resolve({ durationMs: 1, exitCode: 143, stderr: '', stdout: '' });
          };
          if (input.signal.aborted) {
            finish();
            return;
          }
          input.signal.addEventListener('abort', finish, { once: true });
        });
      },
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      commandRunner,
      environment: codexShimEnvironment(),
      fetch: async (url) => {
        if (url.endsWith('/commands/poll')) {
          pollCount += 1;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                commands:
                  pollCount === 1
                    ? [
                        {
                          argv: ['long-command'],
                          commandId: 'term_ack_block_1',
                          cwd: sessionDir,
                          kind: 'terminal-command',
                        },
                      ]
                    : pollCount === 2
                      ? [
                          {
                            commandId: 'interrupt_ack_block_1',
                            kind: 'interrupt',
                            reason: 'user-stop',
                          },
                        ]
                      : [],
              }),
          };
        }
        if (url.endsWith('/commands/ack')) {
          markAckStarted?.();
          return new Promise((resolve) => {
            releaseAck = () => resolve({ ok: true, status: 200, text: async () => '{}' });
          });
        }
        return { ok: true, status: 200, text: async () => '{}' };
      },
      runner: new FakeCodexProcessRunner({
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '',
      }),
      signal: controller.signal,
    });

    try {
      await commandStarted;
      await ackStarted;
      expect(commandAborted).toBe(true);
      releaseAck?.();
      await expect(run).resolves.toMatchObject({ status: 'interrupted' });
    } finally {
      releaseAck?.();
      controller.abort();
      await run.catch(() => undefined);
    }
  });

  it('queues later terminal commands exactly once while another command is running', async () => {
    vi.useFakeTimers();
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-terminal-queue-'));
    const packagePath = join(sessionDir, 'package.json');
    const commandIds: string[] = [];
    const terminalResultIds: string[] = [];
    let pollCount = 0;
    let markCommandStarted: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const commandRunner: WorkerControlCommandRunner = {
      async run(input) {
        const commandId = input.argv[0] ?? '';
        commandIds.push(commandId);
        if (commandId === 'command-a') {
          markCommandStarted?.();
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        return { durationMs: 1, exitCode: 0, stderr: '', stdout: `${commandId}\n` };
      },
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      commandRunner,
      environment: codexShimEnvironment(),
      fetch: async (url, init) => {
        if (url.endsWith('/commands/poll')) {
          pollCount += 1;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                commands: [
                  {
                    argv: ['command-a'],
                    commandId: 'term_queue_a',
                    cwd: sessionDir,
                    kind: 'terminal-command',
                  },
                  ...(pollCount > 1
                    ? [
                        {
                          argv: ['command-b'],
                          commandId: 'term_queue_b',
                          cwd: sessionDir,
                          kind: 'terminal-command',
                        },
                      ]
                    : []),
                ],
              }),
          };
        }
        if (url.endsWith('/terminal-results')) {
          terminalResultIds.push(
            (JSON.parse(init.body) as { terminalCommandId: string }).terminalCommandId
          );
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({}) };
      },
      runner: new FakeCodexProcessRunner({
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '',
      }),
    });

    try {
      await commandStarted;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(run).resolves.toMatchObject({ status: 'completed' });
      expect(commandIds).toEqual(['command-a', 'command-b']);
      expect(terminalResultIds).toEqual(['term_queue_a', 'term_queue_b']);
    } finally {
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('terminates the real Codex process group after TERM and KILL on abort', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-child-abort-'));
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
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...codexShimEnvironment(),
        OPENKIT_CODEX_COMMAND: JSON.stringify([process.execPath, '-e', childScript]),
        OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
      },
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
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

  it('cleans up Codex descendants after the process leader exits successfully', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-descendant-exit-'));
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
        control: { mode: 'direct-nanocore' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: {
        ...codexShimEnvironment(),
        OPENKIT_CODEX_COMMAND: JSON.stringify([process.execPath, '-e', childScript]),
      },
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
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

  it('terminates a real terminal-command process group on parent abort', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-terminal-child-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const markerPath = join(sessionDir, 'terminal-child.txt');
    const descendantMarkerPath = join(sessionDir, 'terminal-descendant.txt');
    const controller = new AbortController();
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
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
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'inherit' });`,
      'setInterval(() => undefined, 1000);',
    ].join('');
    let childPid: number | null = null;
    let descendantPid: number | null = null;
    let pollCount = 0;
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: { mode: 'direct-nanocore' },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    const run = runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith('/commands/poll') && pollCount++ === 0
              ? {
                  commands: [
                    {
                      argv: [process.execPath, '-e', childScript],
                      commandId: 'term_abort_1',
                      cwd: sessionDir,
                      kind: 'terminal-command',
                    },
                  ],
                }
              : { commands: [] }
          ),
      }),
      runner,
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
      expect(runner.calls).toEqual([]);
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

  it('prioritizes an interrupt over earlier terminal commands from the same poll', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-initial-interrupt-priority-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    const commandRunner = new FakeControlCommandRunner({
      durationMs: 1,
      exitCode: 0,
      stderr: '',
      stdout: 'must-not-run\n',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        commandRunner,
        environment: codexShimEnvironment(),
        fetch: async (url) => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              url.endsWith('/commands/poll')
                ? {
                    commands: [
                      {
                        argv: ['must-not-run'],
                        commandId: 'term_before_interrupt_1',
                        cwd: sessionDir,
                        kind: 'terminal-command',
                      },
                      {
                        commandId: 'interrupt_after_terminal_1',
                        kind: 'interrupt',
                        reason: 'user-stop',
                      },
                    ],
                  }
                : {}
            ),
        }),
        runner,
      })
    ).resolves.toMatchObject({ status: 'interrupted' });
    expect(commandRunner.calls).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('does not start Codex when the initial control poll interrupts the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-initial-interrupt-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
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
              : {}
          ),
      };
    };
    writeFileSync(
      packagePath,
      JSON.stringify({ runtime: { command: { workingDirectory: sessionDir } } }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
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
            body: {
              status: 'interrupted',
              stopReason: 'worker-interrupt-command',
            },
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-final-status-'));
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        fetch,
        runner: new FakeCodexProcessRunner({
          exitCode,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      })
    ).resolves.toMatchObject({ status: expectedStatus });

    const records = [
      ...readJsonl(join(sessionDir, 'events.jsonl')),
      ...(existsSync(join(sessionDir, 'items.jsonl'))
        ? readJsonl(join(sessionDir, 'items.jsonl'))
        : []),
    ] as Array<{ event?: { type?: string }; sequence: number }>;
    const terminalRecord = records.find((record) =>
      ['turn.completed', 'turn.failed'].includes(record.event?.type ?? '')
    );
    const finalStatusRequests = requests.filter((request) => request.url.endsWith('/final-status'));

    expect(terminalRecord).toBeDefined();
    expect(terminalRecord?.sequence).toBe(Math.max(...records.map((record) => record.sequence)));
    expect(finalStatusRequests).toEqual([
      {
        body: {
          body: {
            status: expectedStatus,
            stopReason: expectedStopReason,
          },
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
  });

  it('keeps heartbeats live until NanoCore accepts final status', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-final-status-heartbeat-'));
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
    try {
      const run = runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        fetch,
        runner: new FakeCodexProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      });
      await finalStatusStarted;
      expect(heartbeatCount).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(heartbeatCount).toBe(2);
      releaseFinalStatus?.();

      await expect(run).resolves.toMatchObject({ status: 'completed' });
    } finally {
      releaseFinalStatus?.();
    }
  });

  it('reports parent cancellation after Codex exit but before terminal commit as interrupted', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-final-status-abort-'));
    const packagePath = join(sessionDir, 'package.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
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
    writeFileSync(finalMessagePath, 'x'.repeat(16 * 1024 * 1024), 'utf8');
    writeFileSync(
      packagePath,
      JSON.stringify({
        extensions: { openkit: { resultMessagePath: finalMessagePath } },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    const result = await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
      fetch,
      runner: new FakeCodexProcessRunner(
        { exitCode: 0, signal: null, stderr: '', stdout: '' },
        () => setTimeout(() => controller.abort(), 5)
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
          body: {
            status: 'interrupted',
            stopReason: 'worker-parent-aborted',
          },
          operation: 'final_status',
          sequence: terminalRecord.sequence,
        }),
      }),
    ]);
  });

  it('fails closed when the Codex final message exceeds the bounded transcript size', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-final-message-oversized-'));
    const packagePath = join(sessionDir, 'package.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
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
    writeFileSync(finalMessagePath, 'x'.repeat(16 * 1024 * 1024 + 1), 'utf8');
    writeFileSync(
      packagePath,
      JSON.stringify({
        extensions: { openkit: { resultMessagePath: finalMessagePath } },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        fetch,
        runner: new FakeCodexProcessRunner({
          exitCode: 0,
          signal: null,
          stderr: '',
          stdout: '',
        }),
      })
    ).rejects.toThrow('Codex final message exceeds 16777216 bytes.');
    expect(requests.filter((request) => request.url.endsWith('/final-status'))).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          body: {
            status: 'failed',
            stopReason: 'worker-final-message-collection-failed',
          },
          operation: 'final_status',
        }),
      }),
    ]);
  });

  it('supervises a configured Codex process and writes transcript lifecycle records', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-session-'));
    const packagePath = join(sessionDir, 'package.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
    const runner = new FakeCodexProcessRunner(
      {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '{"type":"session.completed"}\n',
      },
      () => {
        writeFileSync(finalMessagePath, 'Codex worker completed the task.\n', 'utf8');
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        extensions: {
          openkit: {
            codexCommand: [
              'codex',
              'exec',
              '--json',
              '--output-last-message',
              finalMessagePath,
              'Summarize the repository.',
            ],
            resultMessagePath: finalMessagePath,
          },
        },
        runtime: {
          command: {
            workingDirectory: '/workspace/openkit',
          },
        },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs([
          '--package',
          packagePath,
          '--session-dir',
          sessionDir,
          '--artifact-dir',
          join(sessionDir, 'artifacts'),
        ]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).resolves.toEqual({
      exitCode: 0,
      signal: null,
      status: 'completed',
    });

    expect(runner.calls).toEqual([
      expect.objectContaining({
        argv: [
          'codex',
          'exec',
          '--json',
          '--output-last-message',
          finalMessagePath,
          'Summarize the repository.',
        ],
        cwd: '/workspace/openkit',
      }),
    ]);
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual([
      expect.objectContaining({
        event: {
          data: { status: 'starting' },
          type: 'worker.heartbeat',
        },
        kind: 'event',
        sequence: 0,
      }),
      expect.objectContaining({
        event: {
          data: {
            argv: [
              'codex',
              'exec',
              '--json',
              '--output-last-message',
              finalMessagePath,
              'Summarize the repository.',
            ],
            cwd: '/workspace/openkit',
            runtime: 'codex',
          },
          type: 'worker.ready',
        },
        kind: 'event',
        sequence: 1,
      }),
      expect.objectContaining({
        event: {
          data: {
            exitCode: 0,
            runtime: 'codex',
            signal: null,
            status: 'process.exited',
          },
          type: 'worker.heartbeat',
        },
        kind: 'event',
        sequence: 2,
      }),
      expect.objectContaining({
        event: {
          data: {
            status: 'completed',
          },
          type: 'turn.completed',
        },
        kind: 'event',
        sequence: 4,
      }),
    ]);
    expect(readJsonl(join(sessionDir, 'items.jsonl'))).toEqual([
      expect.objectContaining({
        item: {
          status: 'completed',
          text: 'Codex worker completed the task.',
          type: 'assistant-message',
        },
        kind: 'item',
        sequence: 3,
      }),
    ]);
  });

  it('captures streamed Codex runtime provenance from HOME when CODEX_HOME is empty', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-provenance-'));
    const home = join(sessionDir, 'home');
    const codexHome = join(home, '.codex');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '13');
    const packagePath = join(sessionDir, 'package.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
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
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(finalMessagePath, 'Codex provenance captured.\n', 'utf8'),
      [
        primary.subarray(0, utf8Split),
        primary.subarray(utf8Split, firstNewline),
        primary.subarray(firstNewline, firstNewline + 1),
        primary.subarray(firstNewline + 1),
      ]
    );
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, 'rollout-2026-07-13T00-00-00-thread-root.jsonl'),
      rollout,
      'utf8'
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        backend: { requiredCapabilities: ['worker.runtime-provenance.v1'] },
        control: {
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
        extensions: {
          openkit: {
            codexCommand: ['codex', 'exec', '--json', '--output-last-message', finalMessagePath],
            resultMessagePath: finalMessagePath,
          },
        },
        runtime: { command: { workingDirectory: '/workspace/openkit' } },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: { ...codexShimEnvironment(), CODEX_HOME: '', HOME: home },
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
        sequence: 4,
      }),
    ]);
    expect(readJsonl(join(sessionDir, 'items.jsonl'))).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ text: 'Codex provenance captured.' }),
        sequence: 3,
      }),
    ]);
  });

  it('invalidates a reused provenance manifest before a later capture failure', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-provenance-reused-'));
    const codexHome = join(sessionDir, 'codex-home');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '13');
    const packagePath = join(sessionDir, 'package.json');
    const rawRoot = join(sessionDir, 'runtime', 'raw');
    const manifestPath = join(sessionDir, 'runtime', 'raw-streams.json');
    const primary = Buffer.from('{"type":"thread.started","thread_id":"thread-root"}\n');
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, 'rollout-reused-root.jsonl'),
      `${JSON.stringify({
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
      })}\n`,
      'utf8'
    );
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
    const args = parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]);
    const environment = {
      ...codexShimEnvironment(),
      CODEX_HOME: codexHome,
      OPENKIT_CODEX_COMMAND: '["codex","exec","--json"]',
    };

    await runCodexShim({
      args,
      environment,
      runner: new FakeCodexProcessRunner(
        { exitCode: 0, signal: null, stderr: '', stdout: primary.toString('utf8') },
        null,
        [primary]
      ),
    });
    expect(existsSync(manifestPath)).toBe(true);

    const failingRunner: CodexProcessRunner = {
      async run(input) {
        await input.writeStdout?.(primary);
        renameSync(rawRoot, `${rawRoot}-inflight`);
        writeFileSync(rawRoot, 'blocks rollout publication', 'utf8');
        return { exitCode: 0, signal: null, stderr: '', stdout: primary.toString('utf8') };
      },
    };

    await expect(runCodexShim({ args, environment, runner: failingRunner })).rejects.toThrow();
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('waits for each streamed stdout sink write before completing the process run', async () => {
    const chunk = Buffer.from('{"type":"thread.started","thread_id":"thread-root"}\n');
    const runner = new FakeCodexProcessRunner(
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-provenance-invalid-'));
    const codexHome = join(sessionDir, 'codex-home');
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
          CODEX_HOME: codexHome,
          OPENKIT_CODEX_COMMAND: '["codex","exec","--json"]',
        },
        runner,
      })
    ).rejects.toThrow('Invalid runtime provenance declaration.');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(join(sessionDir, 'escape'))).toBe(false);
  });

  it('keeps the CLI control descriptor secret out of the supervisor and Codex environments', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-supervisor-env-'));
    const packagePath = join(sessionDir, 'package.json');
    const childEnvironmentPath = join(sessionDir, 'child-environment.json');
    const controlTokenPath = join(sessionDir, 'control-token');
    const controlToken = 'test-control-token-parent-proc';
    const parentSecret = 'test-undeclared-parent-secret';
    const inferencePlaceholder = 'openshell:resolve:env:OPENKIT_WORKER_INFERENCE_TOKEN';
    const childScript = [
      "const fs = require('node:fs');",
      "const parentEnvironment = process.platform === 'linux' ? fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8') : '';",
      'fs.writeFileSync(process.argv[1], JSON.stringify({ childEnvironment: process.env, parentEnvironment }));',
    ].join('');
    writeFileSync(
      packagePath,
      JSON.stringify({
        extensions: {
          openkit: {
            codexCommand: [process.execPath, '-e', childScript, childEnvironmentPath],
          },
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    writeRawFileSync(controlTokenPath, controlToken, { mode: 0o600 });
    const controlTokenDescriptor = openSync(controlTokenPath, 'r');
    const injectedEnvironment: Record<string, string> = {
      ...codexShimEnvironment(),
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
        runCodexShimCli(['--package', packagePath, '--session-dir', sessionDir])
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

  it('isolates control and parent secrets from the Codex child environment', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-env-'));
    const codexHome = join(sessionDir, 'codex-home');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '13');
    const packagePath = join(sessionDir, 'package.json');
    const childEnvironmentPath = join(sessionDir, 'child-environment.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
    const inferencePlaceholder = 'openshell:resolve:env:OPENKIT_WORKER_INFERENCE_TOKEN';
    const proxyEnvironment = {
      ALL_PROXY: 'socks5://proxy.example:1080',
      HTTP_PROXY: 'http://proxy.example:3128',
      HTTPS_PROXY: 'http://proxy.example:3128',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'localhost,127.0.0.1',
      http_proxy: 'http://proxy.example:3128',
      https_proxy: 'http://proxy.example:3128',
      no_proxy: 'localhost,127.0.0.1',
    };
    const childScript = [
      "const fs = require('node:fs');",
      'fs.writeFileSync(process.argv[1], JSON.stringify(process.env));',
      "fs.writeFileSync(process.argv[2], 'Codex environment captured.\\n');",
      'process.stdout.write(\'{"type":"thread.started","thread_id":"thread-production-root"}\\n\');',
    ].join(' ');
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, 'rollout-production-root.jsonl'),
      `${JSON.stringify({
        payload: {
          cli_version: '0.144.1',
          cwd: sessionDir,
          id: 'thread-production-root',
          originator: 'codex_exec',
          session_id: 'session-production-root',
          source: 'exec',
          timestamp: '2026-07-13T00:00:00.000Z',
        },
        timestamp: '2026-07-13T00:00:00.000Z',
        type: 'session_meta',
      })}\n`,
      'utf8'
    );

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
        extensions: {
          openkit: {
            codexCommand: [
              process.execPath,
              '-e',
              childScript,
              childEnvironmentPath,
              finalMessagePath,
            ],
            resultMessagePath: finalMessagePath,
          },
        },
        runtime: { command: { workingDirectory: sessionDir } },
      }),
      'utf8'
    );
    vi.stubEnv('OPENKIT_PARENT_ONLY_SECRET', 'parent-only-secret');

    try {
      await expect(
        runCodexShim({
          args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
          environment: {
            ...codexShimEnvironment(),
            ...proxyEnvironment,
            CODEX_HOME: codexHome,
            OPENKIT_WORKER_INFERENCE_TOKEN: inferencePlaceholder,
          },
        })
      ).resolves.toMatchObject({ status: 'completed' });
    } finally {
      vi.unstubAllEnvs();
    }

    const childEnvironment = JSON.parse(readFileSync(childEnvironmentPath, 'utf8')) as Record<
      string,
      string
    >;

    expect(childEnvironment).not.toHaveProperty('OPENKIT_CONTROL_TOKEN');
    expect(childEnvironment).not.toHaveProperty('OPENKIT_PARENT_ONLY_SECRET');
    expect(childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN).toBe(inferencePlaceholder);
    expect(childEnvironment).toEqual(expect.objectContaining(proxyEnvironment));
    expect(readFileSync(join(sessionDir, 'runtime', 'raw', 'stream-0000.jsonl'), 'utf8')).toBe(
      '{"type":"thread.started","thread_id":"thread-production-root"}\n'
    );
    expect(
      JSON.parse(readFileSync(join(sessionDir, 'runtime', 'raw-streams.json'), 'utf8'))
    ).toMatchObject({ captureStatus: 'complete' });
  });

  it('materializes catalog-resolved Skill and MCP supply before Codex runs', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-supply-'));
    const packagePath = join(sessionDir, 'package.json');
    const skillTargetPath = join(sessionDir, 'skills', 'repo-guidelines');
    const mcpTargetPath = join(sessionDir, 'mcp', 'github.json');
    const runner = new FakeCodexProcessRunner(
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
        expect(readFileSync(mcpTargetPath, 'utf8')).toContain('github-mcp-server');
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        extensions: {
          openkit: {
            codexCommand: ['codex', 'exec', 'Summarize the repository.'],
          },
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
              transport: 'stdio',
              command: ['github-mcp-server'],
              allowedTools: ['repos.get'],
              materialization: {
                kind: 'generated-config',
                targetPath: mcpTargetPath,
              },
              providerInstanceIds: ['provider_github_read'],
              vaultGrantIds: ['grant_github_read'],
              secretRefIds: ['vault_github_read'],
              token: 'GITHUB_TOKEN',
            },
          ],
        },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });

    const skillMetadata = readFileSync(join(skillTargetPath, 'openkit-supply.json'), 'utf8');
    const mcpConfig = readFileSync(mcpTargetPath, 'utf8');
    expect(skillMetadata).toContain('sha256-repo-guidelines-v1');
    expect(mcpConfig).toContain('vault_github_read');
    expect(mcpConfig).not.toContain('GITHUB_TOKEN');
  });

  it('writes a git workspace change manifest after a successful Codex process', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-workspace-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
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
    const runner = new FakeCodexProcessRunner(
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
        writeFileSync(finalMessagePath, 'Updated the repository.\n', 'utf8');
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

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
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
    expect(patch.endsWith('\n')).toBe(true);
  });

  it('writes exact binary blob and chmod metadata for NanoCore review staging', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-git-metadata-'));
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
    const runner = new FakeCodexProcessRunner(
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

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-committed-workspace-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const baseCommit = initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    let workerCommit = '';
    const runner = new FakeCodexProcessRunner(
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

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-trailing-spaces-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'README.md'), '# After   \n', 'utf8')
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
      runner,
    });

    expect(readFileSync(join(sessionDir, 'workspace.patch'), 'utf8')).toContain('+# After   \n');
  });

  it('describes binary changes with canonical Git blob bytes after EOL conversion', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-canonical-binary-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const nextBinary = Buffer.from([0, 98, 13, 10]);
    initializeGitRepository(repoDir, {
      '.gitattributes': 'artifact.bin text eol=lf\n',
      'artifact.bin': Buffer.from([0, 97, 10]),
    });
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'artifact.bin'), nextBinary)
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-clean-filter-'));
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
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'artifact.bin'), Buffer.from([0, 2]))
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/filter/i);
  });

  it('rejects a custom clean filter without executing it', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-filter-side-effect-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const markerPath = join(sessionDir, 'filter-ran');
    initializeGitRepository(repoDir, {
      '.gitattributes': 'artifact.bin filter=openkit-review -text\n',
      'artifact.bin': Buffer.from([0, 1]),
    });
    const runner = new FakeCodexProcessRunner(
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/filter/i);
    expect(runner.calls).toHaveLength(1);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not execute a clean filter on an unchanged path while collecting another change', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-unchanged-filter-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const markerPath = join(sessionDir, 'filter-ran');
    initializeGitRepository(repoDir, {
      '.gitattributes': 'unchanged.bin filter=openkit-review -text\n',
      'changed.txt': 'Before\n',
      'unchanged.bin': Buffer.from([0, 1]),
    });
    const runner = new FakeCodexProcessRunner(
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(existsSync(markerPath)).toBe(false);
  });

  it('rejects multiple writable Git workspace inputs before starting the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-multiple-git-inputs-'));
    const firstRepoDir = join(sessionDir, 'first');
    const secondRepoDir = join(sessionDir, 'second');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(firstRepoDir, { 'README.md': '# First\n' });
    initializeGitRepository(secondRepoDir, { 'README.md': '# Second\n' });
    const runner = new FakeCodexProcessRunner({
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
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/Git.*input|input.*Git/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects an unavailable Git base before starting the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-missing-base-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    mkdirSync(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/base|commit|HEAD/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a dirty writable Git workspace before starting the worker', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-dirty-workspace-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    writeFileSync(join(repoDir, 'README.md'), '# Preexisting change\n', 'utf8');
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/clean|dirty|preexisting|uncommitted/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('accepts a clean Git workspace after tar transport changes filesystem metadata', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-transported-git-'));
    const sourceRepoDir = join(sessionDir, 'source-repo');
    const repoDir = join(sessionDir, 'repo');
    const bundlePath = join(sessionDir, 'repo.tar');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(sourceRepoDir, { 'README.md': '# Clean transported repository\n' });
    mkdirSync(repoDir);
    execFileSync('tar', ['-cf', bundlePath, '-C', sourceRepoDir, '.'], { stdio: 'ignore' });
    execFileSync('tar', ['-xf', bundlePath, '-C', repoDir], { stdio: 'ignore' });
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(runner.calls).toHaveLength(1);
  });

  it.each([
    '--assume-unchanged',
    '--skip-worktree',
  ] as const)('rejects dirty workspace state hidden by %s before starting the worker', async (flag) => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-hidden-dirty-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    execFileSync('git', ['update-index', flag, 'README.md'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    writeFileSync(join(repoDir, 'README.md'), '# Hidden preexisting change\n', 'utf8');
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/clean|hide|index|lineage/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('ignores ambient GIT_DIR when inspecting a writable workspace', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-ambient-git-dir-'));
    const repoDir = join(sessionDir, 'repo');
    const redirectRepoDir = join(sessionDir, 'redirect-repo');
    const packagePath = join(sessionDir, 'package.json');
    const baseCommit = initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    initializeGitRepository(redirectRepoDir, { 'DECOY.md': '# Wrong repository\n' });
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, 'README.md'), '# After\n', 'utf8')
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(redirectRepoDir, '.git');

    try {
      await runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
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
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-attributes-change-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => writeFileSync(join(repoDir, '.gitattributes'), '*.txt text eol=lf\n', 'utf8')
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow(/gitattributes|attribute/i);
    expect(runner.calls).toHaveLength(1);
  });

  it('removes stale review outputs when a reused session has no changes', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-reused-session-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const patchPath = join(sessionDir, 'workspace.patch');
    const manifestPath = join(sessionDir, 'workspace-changes.json');
    initializeGitRepository(repoDir, { 'README.md': '# Unchanged\n' });
    writeFileSync(patchPath, 'stale patch\n', 'utf8');
    writeFileSync(manifestPath, '{"stale":true}\n', 'utf8');
    const runner = new FakeCodexProcessRunner({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: '',
    });
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
      runner,
    });

    expect([existsSync(patchPath), existsSync(manifestPath)]).toEqual([false, false]);
  });

  it('removes review outputs when manifest publication fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-manifest-failure-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const patchPath = join(sessionDir, 'workspace.patch');
    const manifestPath = join(sessionDir, 'workspace-changes.json');
    initializeGitRepository(repoDir, { 'README.md': '# Before\n' });
    const runner = new FakeCodexProcessRunner(
      { exitCode: 0, signal: null, stderr: '', stdout: '' },
      () => {
        writeFileSync(join(repoDir, 'README.md'), '# After\n', 'utf8');
        mkdirSync(manifestPath);
      }
    );
    writeGitWorkspacePackage(packagePath, repoDir, [{ id: 'repo', target: repoDir }]);

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).rejects.toThrow();
    expect([existsSync(patchPath), existsSync(manifestPath)]).toEqual([false, false]);
  });

  it('uses OPENKIT_CODEX_COMMAND and records failed Codex exits', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-failed-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
      exitCode: 7,
      signal: null,
      stderr: 'failed with token=tok_live and Authorization: Bearer live_secret\n',
      stdout: 'stdout mentions sk-openkit-secret\n',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        runtime: {
          command: {
            workingDirectory: '/workspace/openkit',
          },
        },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
          OPENKIT_CODEX_COMMAND: '["codex","--bad-flag"]',
        },
        runner,
      })
    ).resolves.toEqual({
      exitCode: 7,
      signal: null,
      status: 'failed',
    });

    expect(runner.calls[0]?.argv).toEqual(['codex', '--bad-flag']);
    expect(readJsonl(join(sessionDir, 'events.jsonl')).at(-1)).toEqual(
      expect.objectContaining({
        event: {
          data: {
            diagnostics: {
              stderr: 'failed with token=[redacted] and Authorization: Bearer [redacted]',
              stdout: 'stdout mentions [redacted]',
            },
            reason: 'Codex process exited with code 7.',
            status: 'failed',
          },
          type: 'turn.failed',
        },
      })
    );
    expect(readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')).not.toContain(
      'sk-openkit-secret'
    );
    expect(readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')).not.toContain('tok_live');
    expect(readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')).not.toContain('live_secret');
  });

  it('keeps runtime-native ids out of provenance-enabled failure diagnostics', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-provenance-failed-'));
    const codexHome = join(sessionDir, 'codex-home');
    const rolloutDir = join(codexHome, 'sessions', '2026', '07', '13');
    const packagePath = join(sessionDir, 'package.json');
    const nativeThreadId = 'native-thread-canary';
    const nativeSessionId = 'native-session-canary';
    const primary = Buffer.from(
      `${JSON.stringify({ thread_id: nativeThreadId, type: 'thread.started' })}\n`
    );
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, 'rollout-failed-root.jsonl'),
      `${JSON.stringify({
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
      })}\n`,
      'utf8'
    );
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
    const runner = new FakeCodexProcessRunner(
      {
        exitCode: 7,
        signal: null,
        stderr: `failed session=${nativeSessionId} thread=${nativeThreadId}\n`,
        stdout: primary.toString('utf8'),
      },
      null,
      [primary]
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
          CODEX_HOME: codexHome,
          OPENKIT_CODEX_COMMAND: '["codex","exec","--json"]',
        },
        runner,
      })
    ).resolves.toMatchObject({ status: 'failed' });

    const transcript = readFileSync(join(sessionDir, 'events.jsonl'), 'utf8');
    expect(transcript).not.toContain(nativeSessionId);
    expect(transcript).not.toContain(nativeThreadId);
  });
});

/** In-memory Codex runner used by shim supervisor tests. */
class FakeCodexProcessRunner implements CodexProcessRunner {
  public readonly calls: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];

  private readonly result: Awaited<ReturnType<CodexProcessRunner['run']>>;

  private readonly onRun: (() => void) | null;

  private readonly stdoutChunks: readonly Uint8Array[];

  /**
   * Creates one deterministic Codex process run.
   *
   * @param result Completed process result returned after all chunks are accepted.
   * @param onRun Optional process-start side effect.
   * @param stdoutChunks Ordered stdout chunks streamed through the supplied sink.
   */
  public constructor(
    result: Awaited<ReturnType<CodexProcessRunner['run']>>,
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
    writeStdout?: ((chunk: Uint8Array) => Promise<void>) | undefined;
  }): Promise<Awaited<ReturnType<CodexProcessRunner['run']>>> {
    this.calls.push(input);
    this.onRun?.();
    for (const chunk of this.stdoutChunks) {
      await input.writeStdout?.(chunk);
    }

    return this.result;
  }
}

/** Codex runner that completes only after its supervisor aborts the process. */
class AbortAwareCodexProcessRunner implements CodexProcessRunner {
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
   * Waits until the supplied abort signal terminates the fake Codex process.
   *
   * @param input Process input carrying the supervisor abort signal.
   * @returns Signal-terminated process result.
   */
  public async run(
    input: Parameters<CodexProcessRunner['run']>[0]
  ): Promise<Awaited<ReturnType<CodexProcessRunner['run']>>> {
    const signal = (input as typeof input & { signal?: AbortSignal }).signal;
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

class FakeControlCommandRunner implements WorkerControlCommandRunner {
  public readonly calls: Array<{
    argv: string[];
    cwd: string | null;
    env: Record<string, string>;
  }> = [];

  private readonly result: Awaited<ReturnType<WorkerControlCommandRunner['run']>>;

  public constructor(result: Awaited<ReturnType<WorkerControlCommandRunner['run']>>) {
    this.result = result;
  }

  public async run(input: {
    argv: string[];
    cwd: string | null;
    env: Record<string, string>;
  }): Promise<Awaited<ReturnType<WorkerControlCommandRunner['run']>>> {
    this.calls.push(input);

    return this.result;
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
 * Creates a sandbox environment fixture for Codex supervision tests.
 *
 * @returns Worker control environment variables plus Codex command configuration.
 */
function codexShimEnvironment(): CodexShimEnvironment & { OPENKIT_CODEX_COMMAND?: string } {
  return {
    OPENKIT_AGENT_SESSION_ID: 'as_codex_1',
    OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
    OPENKIT_PACKAGE_SNAPSHOT_ID: 'pkg_codex_1',
    OPENKIT_REQUEST_ID: 'req_codex_1',
    OPENKIT_THREAD_ID: 'th_codex',
    OPENKIT_TURN_ID: 'turn_codex',
    OPENKIT_WORKSPACE_ID: 'ws_codex',
  };
}

/**
 * Runs the shim with the standard out-of-environment control credential used by tests.
 *
 * @param options Worker shim options under test.
 * @returns Supervised worker outcome.
 */
function runCodexShim(options: CodexShimRunOptions) {
  return runCodexShimImplementation({ controlToken: 'token_codex_1', ...options });
}

/**
 * Writes test files while making valid minimal Codex package fixtures explicit direct-control packages.
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
      data = JSON.stringify({ ...parsed, control: { ...control, mode: 'direct-nanocore' } });
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
