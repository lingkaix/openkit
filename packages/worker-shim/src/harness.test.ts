import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkerHarness, WorkerHarness } from './harness.js';
import type { SandboxIntegrationClient } from './integration-client.js';

const loopFixture = vi.hoisted(() => ({
  client: null as SandboxIntegrationClient | null,
  events: [] as string[],
}));

vi.mock('./integration-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./integration-client.js')>()),
  openSandboxIntegration: async () => {
    loopFixture.events.push('listener');
    if (!loopFixture.client) {
      throw new Error('Harness loop fixture is unavailable.');
    }
    return loopFixture.client;
  },
}));

const DIGEST = 'a'.repeat(64);

type RunFileEffect = (input: {
  argv: string[];
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  slotRoots: Record<string, string>;
}) => Promise<number>;

/** Imports one immutable private input through the installed image helper seam. */
async function importWorkerInput(
  runFileEffect: RunFileEffect,
  slotRoots: Record<string, string>,
  slot: 'context' | 'package-config',
  path: string,
  bytes: Buffer
) {
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const exitCode = await runFileEffect({
    argv: [
      'reference.import',
      '--slot',
      slot,
      '--path',
      path,
      '--length',
      String(bytes.length),
      '--sha256',
      digest,
    ],
    stderr,
    stdin: Readable.from([bytes]),
    stdout,
    slotRoots,
  });

  expect(exitCode).toBe(0);
  expect(Buffer.concat(stderrChunks)).toHaveLength(0);
  expect(Buffer.concat(stdoutChunks).toString('utf8')).toBe(`${digest} ${bytes.length}\n`);
}

/** Builds one exact private Harness command for focused lifecycle checks. */
function command(operation: string, sequence: number, body: Readonly<Record<string, unknown>>) {
  return {
    body,
    operation,
    operationId: sequence.toString(16).padStart(64, '0'),
    schemaVersion: 1 as const,
    sequence,
  };
}

/** Builds one accepted Codex session.open body. */
function openBody(bindingId: string, agentSessionId: string) {
  return {
    adapterId: 'codex',
    agentSessionCompatibilityKey: DIGEST,
    agentSessionId,
    agentSessionRuntimeBindingId: bindingId,
    effectiveSetupGeneration: 1,
    threadId: `thread-${agentSessionId}`,
    workspaceId: 'workspace-one',
  };
}

describe('shared Worker Harness', () => {
  afterEach(() => {
    loopFixture.client = null;
    loopFixture.events.length = 0;
    vi.restoreAllMocks();
  });

  it('emits the entry marker only after the Integration listener exists', async () => {
    const controller = new AbortController();
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      expect(Buffer.from(chunk).toString('ascii')).toBe('OPENKIT_WORKER_SHIM_ENTRY_V1\n');
      loopFixture.events.push('marker');
      return true;
    }) as typeof process.stdout.write);
    loopFixture.client = {
      close: async () => {
        loopFixture.events.push('close');
      },
      harnessControlFetch: async () => {
        loopFixture.events.push('poll');
        controller.abort(new Error('fixture-complete'));
        return { ok: true, status: 204, text: async () => '' };
      },
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;

    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(loopFixture.events).toEqual(['listener', 'marker', 'poll', 'close']);
  });

  it('routes one Integration poll loop to two independent Harness instances', async () => {
    const controller = new AbortController();
    const results: Array<Record<string, unknown>> = [];
    const commands = [
      {
        ...command('harness.drain', 0, {}),
        adapterId: 'codex',
        harnessInstanceId: 'harness-codex',
      },
      {
        ...command('harness.drain', 0, {}),
        adapterId: 'opencode',
        harnessInstanceId: 'harness-opencode',
      },
    ];
    loopFixture.client = {
      close: async () => undefined,
      harnessControlFetch: async (path: string, init: { body: string }) => {
        if (path.endsWith('/result')) {
          results.push(JSON.parse(init.body) as Record<string, unknown>);
          return { ok: true, status: 204, text: async () => '' };
        }
        const next = commands.shift();
        if (!next) {
          controller.abort(new Error('fixture-complete'));
          return { ok: true, status: 204, text: async () => '' };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(next) };
      },
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;

    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(results).toMatchObject([
      { disposition: 'succeeded', harnessInstanceId: 'harness-codex', sequence: 0 },
      { disposition: 'succeeded', harnessInstanceId: 'harness-opencode', sequence: 0 },
    ]);
  });

  it('runs sequential Turns by resuming the exact first Codex UUID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-worker-harness-turns-'));
    const sandboxRoot = join(root, 'openkit');
    const packagePath = join(sandboxRoot, 'sessions', 'as-a', 'config', 'package.json');
    const contextPath = join(sandboxRoot, 'sessions', 'as-a', 'context');
    const outputPath = join(sandboxRoot, 'session');
    const fileEffectPath = fileURLToPath(
      new URL('../../../containers/workers/openkit-file-effect', import.meta.url)
    );
    const { runFileEffect } = (await import(pathToFileURL(fileEffectPath).href)) as {
      runFileEffect: RunFileEffect;
    };
    const slotRoots = {
      context: join(sandboxRoot, 'sessions'),
      'package-config': join(sandboxRoot, 'sessions'),
    };
    const packageBytes = (turn: number, requestId?: unknown, agentSessionId = 'as-a') =>
      Buffer.from(
        JSON.stringify({
          capabilities: {
            mode: 'enabled',
            protocol: 'openkit-worker-capability-v1',
            routes: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
          },
          scope: {
            agentSessionId,
            ...(requestId === undefined ? {} : { requestId }),
            threadId: `thread-${agentSessionId}`,
            turnId: `turn-${turn}`,
            workspaceId: 'workspace-one',
          },
          snapshotId: `package-${turn}`,
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
          extensions: { openkit: { turnInput: 'Continue the exact conversation.' } },
          llm: {
            routes: [
              {
                credentialVisibility: 'placeholder',
                endpoint: {
                  kind: 'openai-compatible',
                  upstream: { kind: 'nanocore-gateway' },
                },
                id: 'worker-inference',
                model: 'gpt-5',
                providerInstanceId: 'provider-openai',
              },
            ],
          },
          runtime: {
            command: {
              argv: ['openkit-worker-shim'],
              workingDirectory: sandboxRoot,
            },
          },
          supply: { mcpServers: [{ id: 'echo' }] },
        })
      );
    const importPackage = async (turn: number, requestId?: unknown, agentSessionId = 'as-a') =>
      importWorkerInput(
        runFileEffect,
        slotRoots,
        'package-config',
        `${agentSessionId}/config/package.json`,
        packageBytes(turn, requestId, agentSessionId)
      );
    const importContext = async (agentSessionId: string, path: string, bytes: string) =>
      importWorkerInput(
        runFileEffect,
        slotRoots,
        'context',
        `${agentSessionId}/context/${path}`,
        Buffer.from(bytes)
      );
    const threadId = '019f0000-0000-7000-8000-000000000001';
    const launches: string[][] = [];
    const observedContextFiles: string[][] = [];
    const boundTokens: Array<{
      capabilityToken?: string;
      controlToken: string;
      inferenceToken: string;
    }> = [];
    const finalStatuses: Array<{
      body: { status: string; stopReason: string };
      lineage: Record<string, unknown>;
    }> = [];
    let holdNextRun = false;
    let nativeAbortCount = 0;
    let runningAgentSessionId = 'as-a';
    const harnessEnvironment: { OPENKIT_REQUEST_ID?: string } = {
      OPENKIT_REQUEST_ID: 'request-harness',
    };
    const integration = {
      bindTurnRouteTokens(tokens: {
        capabilityToken?: string;
        controlToken: string;
        inferenceToken: string;
      }) {
        boundTokens.push(tokens);
      },
      clearTurnRouteTokens() {},
      ready: Promise.resolve(),
      workerControlFetch: async (url: string, init: { body: string }) => {
        if (url.endsWith('/final-status')) {
          finalStatuses.push(JSON.parse(init.body) as { lineage: Record<string, unknown> });
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              url.endsWith('/commands/poll')
                ? { commands: [] }
                : url.endsWith('/events/append') || url.endsWith('/final-status')
                  ? { accepted: true, diagnostics: [], schemaVersion: 1 }
                  : {}
            ),
        };
      },
    } as unknown as SandboxIntegrationClient;
    const harness = new WorkerHarness({
      environment: harnessEnvironment,
      integration,
      rootDirectory: join(root, 'private'),
      runner: {
        async run(input) {
          const holdUntilInterrupted = holdNextRun;
          holdNextRun = false;
          launches.push(input.argv);
          observedContextFiles.push(
            readdirSync(join(sandboxRoot, 'sessions', runningAgentSessionId, 'context')).sort()
          );
          input.onStart?.();
          const codexHome = input.env.CODEX_HOME as string;
          const rolloutDirectory = join(codexHome, 'sessions', '2026', '08', '21');
          mkdirSync(rolloutDirectory, { recursive: true });
          const rolloutPath = join(rolloutDirectory, `rollout-${threadId}.jsonl`);
          if (!existsSync(rolloutPath)) {
            writeFileSync(
              rolloutPath,
              `${JSON.stringify({
                payload: {
                  cli_version: '0.144.1',
                  cwd: sandboxRoot,
                  id: threadId,
                  originator: 'codex_exec',
                  session_id: threadId,
                  source: 'exec',
                  timestamp: '2026-08-21T00:00:00.000Z',
                },
                timestamp: '2026-08-21T00:00:00.000Z',
                type: 'session_meta',
              })}\n`,
              'utf8'
            );
          }
          const finalPath = input.argv[input.argv.indexOf('--output-last-message') + 1];
          writeFileSync(finalPath as string, `Answer ${launches.length}.`, 'utf8');
          await input.writeStdout?.(
            Buffer.from(`${JSON.stringify({ thread_id: threadId, type: 'thread.started' })}\n`)
          );
          if (holdUntilInterrupted) {
            await new Promise<void>((resolve) => {
              if (input.signal.aborted) {
                nativeAbortCount += 1;
                resolve();
                return;
              }
              input.signal.addEventListener(
                'abort',
                () => {
                  nativeAbortCount += 1;
                  resolve();
                },
                { once: true }
              );
            });
            return { exitCode: null, signal: 'SIGTERM', stderr: '', stdout: '' };
          }
          return { exitCode: 0, signal: null, stderr: '', stdout: '' };
        },
      },
      sandboxRoot,
      turnOutputDirectory: outputPath,
    });
    await harness.handle(command('session.open', 0, openBody('binding-a', 'as-a')));
    await harness.handle(command('session.open', 0, openBody('binding-b', 'as-b')));
    await expect(
      harness.handle(command('session.open', 0, openBody('binding-duplicate', 'as-a')))
    ).resolves.toMatchObject({ body: { reasonCode: 'conflict' }, disposition: 'refused' });
    await importPackage(1);
    await importContext('as-a', 'current.txt', 'AgentSession A Turn 1\n');
    await importContext('as-a', 'turn-one-only.txt', 'Removed before Turn 2\n');
    await importPackage(9, undefined, 'as-b');
    await importContext('as-b', 'current.txt', 'AgentSession B private bytes\n');
    expect(readFileSync(join(contextPath, 'current.txt'), 'utf8')).toBe('AgentSession A Turn 1\n');
    expect(readFileSync(packagePath)).not.toEqual(
      readFileSync(join(sandboxRoot, 'sessions', 'as-b', 'config', 'package.json'))
    );
    expect(
      readFileSync(join(sandboxRoot, 'sessions', 'as-b', 'context', 'current.txt'), 'utf8')
    ).toBe('AgentSession B private bytes\n');

    const token = (value: number) =>
      (value < 10 ? String(value) : String.fromCharCode(87 + value)).repeat(43);
    const startBody = (
      turn: number,
      agentSessionId = 'as-a',
      bindingId = 'binding-a',
      turnSequence = turn - 1
    ) => ({
      aepRef: join(sandboxRoot, 'sessions', agentSessionId, 'config', 'package.json'),
      agentSessionId,
      agentSessionRuntimeBindingId: bindingId,
      contextPackageId: `ctxpkg_turn-${turn}`,
      contextRef: join(sandboxRoot, 'sessions', agentSessionId, 'context'),
      deadline: '2026-08-21T01:00:00.000Z',
      capabilityToken: token(turn + 4),
      inferenceToken: token(turn),
      leaseId: `lease-${turn}`,
      packageSnapshotId: `package-${turn}`,
      threadId: `thread-${agentSessionId}`,
      turnId: `turn-${turn}`,
      turnSequence,
      workerControlToken: token(turn + 2),
      workspaceId: 'workspace-one',
    });
    await expect(harness.handle(command('turn.start', 1, startBody(1)))).resolves.toMatchObject({
      body: { nativeHandleState: 'pending', state: 'started' },
      disposition: 'succeeded',
    });
    await vi.waitFor(async () => {
      const inspected = await harness.handle(
        command('session.inspect', 2, {
          agentSessionId: 'as-a',
          agentSessionRuntimeBindingId: 'binding-a',
        })
      );
      expect(inspected).toMatchObject({
        body: { childState: 'absent', nativeHandleState: 'ready', state: 'open' },
        disposition: 'succeeded',
      });
    });
    expect(observedContextFiles[0]).toEqual(['current.txt', 'turn-one-only.txt']);
    expect(existsSync(packagePath)).toBe(false);
    expect(existsSync(join(contextPath, 'turn-one-only.txt'))).toBe(false);
    expect(
      readFileSync(join(sandboxRoot, 'sessions', 'as-b', 'context', 'current.txt'), 'utf8')
    ).toBe('AgentSession B private bytes\n');

    await importPackage(2, 'request-harness');
    await importContext('as-a', 'current.txt', 'AgentSession A Turn 2\n');
    expect(existsSync(join(contextPath, 'turn-one-only.txt'))).toBe(false);
    await expect(harness.handle(command('turn.start', 3, startBody(2)))).resolves.toMatchObject({
      body: { nativeHandleState: 'ready', state: 'started' },
      disposition: 'succeeded',
    });
    await vi.waitFor(() => expect(finalStatuses).toHaveLength(2));
    expect(launches[0]).not.toContain('resume');
    expect(launches[1]).toContain('resume');
    expect(launches[1]?.at(-2)).toBe(threadId);
    expect(observedContextFiles[1]).toEqual(['current.txt']);
    expect(boundTokens).toEqual([
      {
        capabilityToken: '5'.repeat(43),
        controlToken: '3'.repeat(43),
        inferenceToken: '1'.repeat(43),
      },
      {
        capabilityToken: '6'.repeat(43),
        controlToken: '4'.repeat(43),
        inferenceToken: '2'.repeat(43),
      },
    ]);
    expect(finalStatuses.map((status) => status.lineage)).toEqual([
      {
        agentSessionId: 'as-a',
        packageSnapshotId: 'package-1',
        requestId: 'request-harness',
        threadId: 'thread-as-a',
        turnId: 'turn-1',
        workspaceId: 'workspace-one',
      },
      {
        agentSessionId: 'as-a',
        packageSnapshotId: 'package-2',
        requestId: 'request-harness',
        threadId: 'thread-as-a',
        turnId: 'turn-2',
        workspaceId: 'workspace-one',
      },
    ]);

    delete harnessEnvironment.OPENKIT_REQUEST_ID;
    await vi.waitFor(async () => {
      const inspected = await harness.handle(
        command('session.inspect', 4, {
          agentSessionId: 'as-a',
          agentSessionRuntimeBindingId: 'binding-a',
        })
      );
      expect(inspected.body.cleanupState).toBe('clean');
    });
    await importPackage(3, 'request-aep-only');
    await importContext('as-a', 'current.txt', 'AgentSession A Turn 3\n');
    await expect(harness.handle(command('turn.start', 4, startBody(3)))).resolves.toMatchObject({
      body: { nativeHandleState: 'ready', state: 'started' },
      disposition: 'succeeded',
    });
    await vi.waitFor(() => expect(finalStatuses).toHaveLength(3));
    expect(finalStatuses[2]?.lineage).toEqual({
      agentSessionId: 'as-a',
      packageSnapshotId: 'package-3',
      requestId: 'request-aep-only',
      threadId: 'thread-as-a',
      turnId: 'turn-3',
      workspaceId: 'workspace-one',
    });
    await vi.waitFor(async () => {
      const inspected = await harness.handle(
        command('session.inspect', 5, {
          agentSessionId: 'as-a',
          agentSessionRuntimeBindingId: 'binding-a',
        })
      );
      expect(inspected.body.cleanupState).toBe('clean');
    });
    harnessEnvironment.OPENKIT_REQUEST_ID = 'request-harness';

    for (const [index, invalidRequestId] of ['different-request', null, '', 17].entries()) {
      const turn = index + 4;
      const agentSessionId = `as-invalid-${index}`;
      const bindingId = `binding-invalid-${index}`;
      await harness.handle(command('session.open', turn + 1, openBody(bindingId, agentSessionId)));
      await importPackage(turn, invalidRequestId, agentSessionId);
      const launchesBeforeRejection = launches.length;
      const result = await harness.handle(
        command('turn.start', turn + 1, startBody(turn, agentSessionId, bindingId))
      );

      expect(
        launches,
        `requestId ${JSON.stringify(invalidRequestId)} reached native start`
      ).toHaveLength(launchesBeforeRejection);
      expect(result).toMatchObject({ disposition: 'refused' });
      await expect(
        harness.handle(
          command('session.close', turn + 1, {
            agentSessionId,
            agentSessionRuntimeBindingId: bindingId,
          })
        )
      ).resolves.toMatchObject({ disposition: 'succeeded' });
    }

    const launchesBeforeCrossSessionRef = launches.length;
    await expect(
      harness.handle(
        command('turn.start', 19, {
          ...startBody(8, 'as-a', 'binding-a', 3),
          aepRef: join(sandboxRoot, 'sessions', 'as-b', 'config', 'package.json'),
          contextRef: join(sandboxRoot, 'sessions', 'as-b', 'context'),
        })
      )
    ).resolves.toMatchObject({ body: { reasonCode: 'stale' }, disposition: 'refused' });
    expect(launches).toHaveLength(launchesBeforeCrossSessionRef);

    await importPackage(8);
    await importContext('as-a', 'current.txt', 'AgentSession A held Turn\n');
    holdNextRun = true;
    await expect(
      harness.handle(command('turn.start', 20, startBody(8, 'as-a', 'binding-a', 3)))
    ).resolves.toMatchObject({
      disposition: 'succeeded',
    });
    await expect(
      harness.handle(
        command('turn.start', 20, {
          ...startBody(9, 'as-b', 'binding-b', 0),
          aepRef: packagePath,
          contextRef: contextPath,
        })
      )
    ).resolves.toMatchObject({ body: { reasonCode: 'busy' }, disposition: 'refused' });
    const interruptBody = {
      agentSessionId: 'as-a',
      agentSessionRuntimeBindingId: 'binding-a',
      leaseId: 'lease-8',
      turnId: 'turn-8',
    };
    for (const invalidBody of [
      interruptBody,
      { ...interruptBody, purpose: 'unknown' },
      { ...interruptBody, extra: 'forbidden', purpose: 'interrupt' },
    ]) {
      await expect(
        harness.handle(command('turn.interrupt', 21, invalidBody))
      ).resolves.toMatchObject({ disposition: 'refused' });
      expect(nativeAbortCount).toBe(0);
    }
    await expect(
      harness.handle(command('turn.interrupt', 21, { ...interruptBody, purpose: 'interrupt' }))
    ).resolves.toMatchObject({
      body: { childState: 'absent', state: 'interrupted' },
      disposition: 'succeeded',
    });
    await vi.waitFor(() => expect(finalStatuses).toHaveLength(4));
    expect(finalStatuses.at(-1)).toMatchObject({
      body: { status: 'interrupted', stopReason: 'aborted' },
    });

    await expect(
      harness.handle(
        command('session.close', 22, {
          agentSessionId: 'as-a',
          agentSessionRuntimeBindingId: 'binding-a',
        })
      )
    ).resolves.toMatchObject({ disposition: 'succeeded' });
    expect(existsSync(join(sandboxRoot, 'sessions', 'as-a'))).toBe(false);
    expect(
      readFileSync(join(sandboxRoot, 'sessions', 'as-b', 'context', 'current.txt'), 'utf8')
    ).toBe('AgentSession B private bytes\n');
    runningAgentSessionId = 'as-b';
    holdNextRun = true;
    await expect(
      harness.handle(command('turn.start', 24, startBody(9, 'as-b', 'binding-b', 0)))
    ).resolves.toMatchObject({ disposition: 'succeeded' });
    expect(observedContextFiles.at(-1)).toEqual(['current.txt']);
    expect(
      readFileSync(join(sandboxRoot, 'sessions', 'as-b', 'context', 'current.txt'), 'utf8')
    ).toBe('AgentSession B private bytes\n');
    await expect(
      harness.handle(
        command('turn.interrupt', 25, {
          agentSessionId: 'as-b',
          agentSessionRuntimeBindingId: 'binding-b',
          leaseId: 'lease-9',
          purpose: 'human-gate',
          turnId: 'turn-9',
        })
      )
    ).resolves.toMatchObject({ disposition: 'succeeded' });
    await vi.waitFor(() => expect(finalStatuses).toHaveLength(5));
    expect(finalStatuses.at(-1)).toMatchObject({
      body: { status: 'blocked', stopReason: 'ask_user' },
    });
  });

  it('keeps two Codex Sessions isolated and closes only the exact named private root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-worker-harness-'));
    const harness = new WorkerHarness({
      integration: {} as SandboxIntegrationClient,
      rootDirectory: root,
      sandboxRoot: root,
    });

    const first = await harness.handle(command('session.open', 0, openBody('binding-a', 'as-a')));
    const second = await harness.handle(command('session.open', 1, openBody('binding-b', 'as-b')));
    expect(first.disposition).toBe('succeeded');
    expect(first.body).toEqual({
      maxActiveTurns: 1,
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
      state: 'open',
    });
    expect(second.disposition).toBe('succeeded');

    const inspected = await harness.handle(
      command('session.inspect', 2, {
        agentSessionId: 'as-b',
        agentSessionRuntimeBindingId: 'binding-b',
      })
    );
    expect(inspected).toMatchObject({
      body: { childState: 'absent', nativeHandleState: 'pending', state: 'open' },
      disposition: 'succeeded',
    });

    const closed = await harness.handle(
      command('session.close', 3, {
        agentSessionId: 'as-a',
        agentSessionRuntimeBindingId: 'binding-a',
      })
    );
    expect(closed).toMatchObject({
      body: { childState: 'absent', privateState: 'absent', state: 'closed' },
      disposition: 'succeeded',
    });
    expect(existsSync(root)).toBe(true);
    await expect(
      harness.handle(
        command('session.inspect', 4, {
          agentSessionId: 'as-b',
          agentSessionRuntimeBindingId: 'binding-b',
        })
      )
    ).resolves.toMatchObject({ disposition: 'succeeded' });
  });

  it('binds one Harness instance to a non-Codex registry adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-worker-harness-opencode-'));
    const harness = new WorkerHarness({
      adapterId: 'opencode',
      integration: {} as SandboxIntegrationClient,
      rootDirectory: root,
      sandboxRoot: root,
    });

    const opened = await harness.handle(
      command('session.open', 0, {
        ...openBody('binding-opencode', 'as-opencode'),
        adapterId: 'opencode',
      })
    );
    expect(opened).toMatchObject({
      body: { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'open' },
      disposition: 'succeeded',
    });
    await expect(
      harness.handle(
        command('session.close', 1, {
          agentSessionId: 'as-opencode',
          agentSessionRuntimeBindingId: 'binding-opencode',
        })
      )
    ).resolves.toMatchObject({
      body: { childState: 'absent', privateState: 'absent', state: 'closed' },
      disposition: 'succeeded',
    });
  });

  it('rejects unknown operations and executable fields before any Turn effect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-worker-harness-'));
    let runs = 0;
    const harness = new WorkerHarness({
      integration: {} as SandboxIntegrationClient,
      rootDirectory: root,
      runner: {
        async run() {
          runs += 1;
          return { exitCode: 0, signal: null, stderr: '', stdout: '' };
        },
      },
      sandboxRoot: root,
    });
    await harness.handle(command('session.open', 0, openBody('binding-a', 'as-a')));

    await expect(harness.handle(command('shell.exec', 1, {}))).resolves.toMatchObject({
      body: { reasonCode: 'unsupported' },
      disposition: 'refused',
    });
    await expect(
      harness.handle(
        command('turn.start', 2, {
          aepRef: join(root, 'aep.json'),
          agentSessionId: 'as-a',
          agentSessionRuntimeBindingId: 'binding-a',
          argv: ['sh', '-c', 'unsafe'],
          contextPackageId: 'context-a',
          contextRef: join(root, 'context'),
          deadline: '2026-08-21T01:00:00.000Z',
          capabilityToken: 'p'.repeat(43),
          inferenceToken: 'i'.repeat(43),
          leaseId: 'lease-a',
          packageSnapshotId: 'package-a',
          threadId: 'thread-as-a',
          turnId: 'turn-a',
          turnSequence: 0,
          workerControlToken: 'c'.repeat(43),
          workspaceId: 'workspace-one',
        })
      )
    ).resolves.toMatchObject({ body: { reasonCode: 'unsupported' }, disposition: 'refused' });
    expect(runs).toBe(0);
  });
});
