import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('runs sequential Turns by resuming the exact first Codex UUID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-worker-harness-turns-'));
    const sandboxRoot = join(root, 'openkit');
    const packagePath = join(sandboxRoot, 'config', 'package.json');
    const contextPath = join(sandboxRoot, 'context');
    const outputPath = join(sandboxRoot, 'session');
    mkdirSync(join(sandboxRoot, 'config'), { recursive: true });
    mkdirSync(contextPath, { recursive: true });
    const writePackage = (turn: number, requestId?: unknown) =>
      writeFileSync(
        packagePath,
        JSON.stringify({
          scope: {
            agentSessionId: 'as-a',
            ...(requestId === undefined ? {} : { requestId }),
            threadId: 'thread-as-a',
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
              argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
              workingDirectory: sandboxRoot,
            },
          },
        }),
        'utf8'
      );
    writePackage(1);
    const threadId = '019f0000-0000-7000-8000-000000000001';
    const launches: string[][] = [];
    const boundTokens: Array<{ controlToken: string; inferenceToken: string }> = [];
    const finalStatuses: Array<{ lineage: Record<string, unknown> }> = [];
    const harnessEnvironment: { OPENKIT_REQUEST_ID?: string } = {
      OPENKIT_REQUEST_ID: 'request-harness',
    };
    const integration = {
      bindTurnRouteTokens(tokens: { controlToken: string; inferenceToken: string }) {
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
          launches.push(input.argv);
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
          return { exitCode: 0, signal: null, stderr: '', stdout: '' };
        },
      },
      sandboxRoot,
      turnOutputDirectory: outputPath,
    });
    await harness.handle(command('session.open', 0, openBody('binding-a', 'as-a')));

    const startBody = (turn: number) => ({
      aepRef: packagePath,
      agentSessionId: 'as-a',
      agentSessionRuntimeBindingId: 'binding-a',
      contextPackageId: `context-${turn}`,
      contextRef: contextPath,
      deadline: '2026-08-21T01:00:00.000Z',
      inferenceToken: String(turn).repeat(43),
      leaseId: `lease-${turn}`,
      packageSnapshotId: `package-${turn}`,
      threadId: 'thread-as-a',
      turnId: `turn-${turn}`,
      turnSequence: turn - 1,
      workerControlToken: String(turn + 2).repeat(43),
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

    writePackage(2, 'request-harness');
    await expect(harness.handle(command('turn.start', 3, startBody(2)))).resolves.toMatchObject({
      body: { nativeHandleState: 'ready', state: 'started' },
      disposition: 'succeeded',
    });
    await vi.waitFor(() => expect(finalStatuses).toHaveLength(2));
    expect(launches[0]).not.toContain('resume');
    expect(launches[1]).toContain('resume');
    expect(launches[1]?.at(-2)).toBe(threadId);
    expect(boundTokens).toEqual([
      { controlToken: '3'.repeat(43), inferenceToken: '1'.repeat(43) },
      { controlToken: '4'.repeat(43), inferenceToken: '2'.repeat(43) },
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
    writePackage(3, 'request-aep-only');
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
    harnessEnvironment.OPENKIT_REQUEST_ID = 'request-harness';

    for (const [index, invalidRequestId] of ['different-request', null, '', 17].entries()) {
      const turn = index + 4;
      writePackage(turn, invalidRequestId);
      const launchesBeforeRejection = launches.length;
      const result = await harness.handle(command('turn.start', turn + 1, startBody(turn)));

      expect(
        launches,
        `requestId ${JSON.stringify(invalidRequestId)} reached native start`
      ).toHaveLength(launchesBeforeRejection);
      expect(result).toMatchObject({ disposition: 'refused' });
    }
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
