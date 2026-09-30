// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkerAdapterResult,
  WorkerNativeHandle,
  WorkerResidentAdapter,
  WorkerResidentOpenInput,
  WorkerResidentTurnInput,
} from './adapter-registry.js';
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

/** Delegate behind the static-registry fixture entry, set by the registry test. */
const registryFixture = vi.hoisted(() => ({
  adapter: null as import('./adapter-registry.js').WorkerResidentAdapter | null,
}));

vi.mock('./adapter-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapter-registry.js')>();
  return {
    ...actual,
    WORKER_ADAPTERS: {
      ...actual.WORKER_ADAPTERS,
      'fixture-fourth': {
        openSession: (input: WorkerResidentOpenInput) => {
          if (!registryFixture.adapter) throw new Error('Registry fixture is unavailable.');
          return registryFixture.adapter.openSession(input);
        },
      },
    },
  };
});

const ADAPTER = 'fake';
const DIGEST = 'a'.repeat(64);

/** A distinct 43-character base64url credential derived from a seed. */
function credential(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url');
}

/** SHA-256 hex of one byte string. */
function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Scripted behavior of one native Turn in the fake resident runtime. */
type TurnScript =
  | { readonly kind: 'complete'; readonly text?: string }
  | { readonly kind: 'fail' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'reject' }
  /** Keeps working: its interrupt rejects and it never settles. */
  | { readonly kind: 'stuck' };

/** One opened fake resident binding with its observable state. */
interface FakeResident {
  closed: boolean;
  closeFails: boolean;
  completedTurns: number;
  /** Ends the resident host on its own. */
  exit(): void;
  /** Overrides the reported handle; null reports the default. */
  handleOverride: WorkerNativeHandle | null;
  readonly input: WorkerResidentOpenInput;
  interrupts: number;
  readonly turns: WorkerResidentTurnInput[];
}

/**
 * A deterministic resident adapter. A new conversation reports `pending` until one Turn completed
 * and then `ready` with `reference-<agentSessionId>`; a resumed one reports the predecessor bytes.
 */
function fakeAdapter(
  options: {
    closeFails?: boolean;
    initialHandle?: WorkerNativeHandle;
    openFails?: boolean;
    readyAtOpen?: boolean;
    resumeHandle?: WorkerNativeHandle;
  } = {}
) {
  const residents: FakeResident[] = [];
  const script: TurnScript[] = [];
  const adapter: WorkerResidentAdapter = {
    async openSession(input) {
      if (options.openFails) throw new Error('resident host failed to start');
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => {
        exit = resolve;
      });
      const resident: FakeResident = {
        closed: false,
        closeFails: options.closeFails ?? false,
        completedTurns: 0,
        exit,
        handleOverride: options.initialHandle ?? null,
        input,
        interrupts: 0,
        turns: [],
      };
      residents.push(resident);
      return {
        exited,
        childState: () => (resident.closed ? 'absent' : 'running'),
        async close() {
          if (resident.closeFails) throw new Error('close failed');
          resident.closed = true;
        },
        async nativeHandle() {
          if (resident.handleOverride) return resident.handleOverride;
          if (input.resumeReference) {
            return options.resumeHandle ?? { reference: input.resumeReference, state: 'ready' };
          }
          return options.readyAtOpen || resident.completedTurns > 0
            ? { reference: Buffer.from(`reference-${input.agentSessionId}`), state: 'ready' }
            : { state: 'pending' };
        },
        async startTurn(turnInput) {
          resident.turns.push(turnInput);
          const next = script.shift() ?? { kind: 'complete' };
          if (next.kind === 'reject') throw new Error('native turn refused');
          let interrupt!: () => void;
          const interrupted = new Promise<WorkerAdapterResult>((resolve) => {
            interrupt = () =>
              resolve({ assistantText: null, status: 'interrupted', stopReason: 'aborted' });
          });
          if (next.kind === 'stuck') {
            return {
              async interrupt() {
                resident.interrupts += 1;
                throw new Error('native interrupt failed');
              },
              settled: new Promise<WorkerAdapterResult>(() => undefined),
            };
          }
          const settled: Promise<WorkerAdapterResult> =
            next.kind === 'hold'
              ? interrupted
              : Promise.resolve(
                  next.kind === 'fail'
                    ? { assistantText: null, status: 'failed', stopReason: 'error' }
                    : {
                        assistantText: next.text ?? `answer-${turnInput.turnId}`,
                        status: 'completed',
                        stopReason: 'completed',
                      }
                );
          void settled.then((result) => {
            if (result.status === 'completed') resident.completedTurns += 1;
          });
          return {
            async interrupt() {
              resident.interrupts += 1;
              interrupt();
              await settled;
            },
            settled,
          };
        },
      };
    },
  };
  return { adapter, residents, script };
}

/** Records every Integration effect the Harness requests. */
function fakeIntegration(options: { readyAppendStatus?: number; registerFails?: boolean } = {}) {
  const calls: string[] = [];
  const loopbacks = new Map<
    string,
    { capabilityCredential: string; inferenceCredential: string }
  >();
  const finalStatuses: Array<{ body: { status: string }; lineage: { turnId: string } }> = [];
  const boundTokens: unknown[] = [];
  const client = {
    ready: Promise.resolve(),
    registerSessionLoopback(
      agentSessionId: string,
      credentials: { capabilityCredential: string; inferenceCredential: string }
    ) {
      if (options.registerFails || loopbacks.has(agentSessionId)) {
        throw new Error('loopback conflict');
      }
      loopbacks.set(agentSessionId, credentials);
      calls.push(`register:${agentSessionId}`);
    },
    destroySessionLoopback(agentSessionId: string) {
      loopbacks.delete(agentSessionId);
      calls.push(`destroy:${agentSessionId}`);
    },
    bindTurnRouteTokens(agentSessionId: string, tokens: unknown) {
      boundTokens.push(tokens);
      calls.push(`bind:${agentSessionId}`);
    },
    clearTurnRouteTokens(agentSessionId: string) {
      calls.push(`clear:${agentSessionId}`);
    },
    async drainTurn(agentSessionId: string) {
      calls.push(`drain:${agentSessionId}`);
      return 0;
    },
    workerControlFetch: async (url: string, init: { body: string }) => {
      if (url.endsWith('/final-status')) {
        finalStatuses.push(JSON.parse(init.body) as (typeof finalStatuses)[number]);
      }
      if (
        options.readyAppendStatus &&
        url.endsWith('/events/append') &&
        init.body.includes('"worker.ready"')
      ) {
        return {
          ok: false,
          status: options.readyAppendStatus,
          text: async () => JSON.stringify({ code: 'conflict' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
      };
    },
  } as unknown as SandboxIntegrationClient;
  return { boundTokens, calls, client, finalStatuses, loopbacks };
}

/** One temporary Sandbox layout, a fake adapter and Integration, and command helpers. */
function harnessFixture(
  options: {
    adapter?: ReturnType<typeof fakeAdapter>;
    /** Uses the production registry instead of injecting the fake under this id. */
    registryAdapterId?: string;
    environment?: Record<string, string>;
    integration?: ReturnType<typeof fakeIntegration>;
    root?: string;
  } = {}
) {
  const adapterId = options.registryAdapterId ?? ADAPTER;
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'openkit-worker-harness-'));
  const sandboxRoot = join(root, 'openkit');
  const nativeRoot = join(root, 'sandbox', 'native');
  const privateRoot = join(root, 'private');
  const fake = options.adapter ?? fakeAdapter();
  const integration = options.integration ?? fakeIntegration();
  const harness = new WorkerHarness({
    ...(options.registryAdapterId ? {} : { adapters: { [ADAPTER]: fake.adapter } }),
    environment: options.environment ?? {},
    integration: integration.client,
    nativeDataRootDirectory: nativeRoot,
    rootDirectory: privateRoot,
    sandboxRoot,
    turnOutputDirectory: join(sandboxRoot, 'session'),
  });
  let sequence = 0;
  const send = (operation: string, body: Readonly<Record<string, unknown>>) =>
    harness.handle({
      body,
      harnessInstanceId: 'harness-one',
      operation: operation as never,
      operationId: sha256(`${root}:${sequence}`),
      schemaVersion: 2,
      sequence: sequence++,
    });
  const selector = (agentSessionId: string) => ({
    agentSessionId,
    agentSessionRuntimeBindingId: `binding-${agentSessionId}`,
  });
  const open = (
    agentSessionId: string,
    extra: {
      resume?: { digest: string; locator: string } | null;
      runtimeEnvironment?: Record<string, string>;
      threadId?: string;
    } = {}
  ) =>
    send('session.open', {
      ...selector(agentSessionId),
      adapterId,
      agentSessionCompatibilityKey: DIGEST,
      capabilityLoopbackCredential: credential(`capability-${agentSessionId}`),
      effectiveSetupGeneration: 1,
      inferenceLoopbackCredential: credential(`inference-${agentSessionId}`),
      resume: extra.resume ?? null,
      ...(extra.runtimeEnvironment ? { runtimeEnvironment: extra.runtimeEnvironment } : {}),
      threadId: extra.threadId ?? 'thread-one',
      workspaceId: 'workspace-one',
    });
  const packagePath = (agentSessionId: string) =>
    join(sandboxRoot, 'sessions', agentSessionId, 'config', 'package.json');
  const contextRoot = (agentSessionId: string) =>
    join(sandboxRoot, 'sessions', agentSessionId, 'context');
  /** Materializes the Turn's AEP where the owner would. */
  const writePackage = (
    agentSessionId: string,
    turnId: string,
    extra: { runtimeEnvNames?: readonly string[]; threadId?: string } = {}
  ) => {
    mkdirSync(join(sandboxRoot, 'sessions', agentSessionId, 'config'), { recursive: true });
    writeFileSync(
      packagePath(agentSessionId),
      JSON.stringify({
        capabilities: {
          mode: 'enabled',
          protocol: 'openkit-worker-capability-v1',
          routes: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
        },
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: adapterId },
          bindings: {
            capabilities: {
              pathPrefix: '/capabilities/',
              tokenRef: 'runtime://openkit/capability-token',
            },
            inference: { pathPrefix: '/inference/', tokenRef: 'runtime://openkit/inference-token' },
            workerControl: {
              pathPrefix: '/worker-control/',
              tokenRef: 'runtime://openkit/worker-control-token',
            },
          },
          mode: 'sandbox-integration',
        },
        credentials: {
          declarations: (extra.runtimeEnvNames ?? []).map((name) => ({
            targetEnvVarName: name,
            visibility: 'runtime-env',
          })),
        },
        extensions: { openkit: { turnInput: `input for ${turnId}` } },
        llm: {
          mode: 'gateway',
          preferredLogicalModelId: 'model-a',
          routes: [
            {
              credentialVisibility: 'placeholder',
              endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
              id: 'worker-inference',
              model: 'model-a',
              providerInstanceId: 'provider-a',
            },
          ],
        },
        observability: { captureCoverage: { scope: 'server', value: 'off' } },
        runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: sandboxRoot } },
        scope: {
          agentSessionId,
          threadId: extra.threadId ?? 'thread-one',
          turnId,
          workspaceId: 'workspace-one',
        },
        snapshotId: `package-${turnId}`,
        supply: { mcpServers: [{ id: 'echo' }] },
      })
    );
  };
  const startBody = (agentSessionId: string, turnId: string, leaseId = `lease-${turnId}`) => ({
    ...selector(agentSessionId),
    aepRef: packagePath(agentSessionId),
    capabilityToken: credential(`capability-token-${turnId}`),
    contextPackageId: `ctxpkg_${turnId}`,
    contextRef: contextRoot(agentSessionId),
    deadline: '2099-01-01T00:00:00.000Z',
    inferenceToken: credential(`inference-token-${turnId}`),
    leaseId,
    packageSnapshotId: `package-${turnId}`,
    threadId: 'thread-one',
    turnId,
    turnSequence: 0,
    workerControlToken: credential(`control-token-${turnId}`),
    workspaceId: 'workspace-one',
  });
  /** Materializes and starts one Turn. */
  const start = (
    agentSessionId: string,
    turnId: string,
    extra: { leaseId?: string; runtimeEnvNames?: readonly string[] } = {}
  ) => {
    writePackage(agentSessionId, turnId, extra);
    return send('turn.start', startBody(agentSessionId, turnId, extra.leaseId));
  };
  /** Waits until the binding no longer reports an active Turn. */
  const settle = async (agentSessionId: string) => {
    await vi.waitFor(
      async () => {
        const inspected = await send('session.inspect', selector(agentSessionId));
        expect(inspected.body.state).not.toBe('active');
      },
      { interval: 10, timeout: 5_000 }
    );
  };
  const referencePath = (agentSessionId: string) =>
    join(nativeRoot, 'agent-session-references', agentSessionId);
  return {
    contextRoot,
    fake,
    harness,
    integration,
    nativeRoot,
    open,
    packagePath,
    privateRoot,
    referencePath,
    root,
    sandboxRoot,
    selector,
    send,
    settle,
    start,
    startBody,
    writePackage,
  };
}

/** Builds one exact private Harness command for the loop tests. */
function command(operation: string, sequence: number, body: Readonly<Record<string, unknown>>) {
  return {
    body,
    operation,
    operationId: sequence.toString(16).padStart(64, '0'),
    schemaVersion: 2 as const,
    sequence,
  };
}

describe('Worker Harness loop', () => {
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
      harnessControlFetch: async (path: string, init: { body: string }) => {
        expect(path).toBe('/worker-control/harness/poll');
        expect(JSON.parse(init.body)).toEqual({ schemaVersion: 2 });
        loopFixture.events.push('poll');
        controller.abort(new Error('fixture-complete'));
        return { ok: true, status: 204, text: async () => '' };
      },
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;

    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(loopFixture.events).toEqual(['listener', 'marker', 'poll', 'close']);
  });

  it('keeps empty private Harness polls between 250 and 1000 milliseconds', async () => {
    const controller = new AbortController();
    const performanceNow = vi.spyOn(performance, 'now');
    let pollCount = 0;
    const harnessControlFetch = vi.fn(async () => {
      pollCount += 1;
      if (pollCount === 4) controller.abort(new Error('cadence-complete'));
      return { ok: true, status: 204, text: async () => '' };
    });
    loopFixture.client = {
      close: async () => undefined,
      harnessControlFetch,
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;
    const run = runWorkerHarness({ signal: controller.signal });
    try {
      await expect(run).rejects.toThrow(/abort/iu);
      // Observe the poll-start sample before synchronous request preparation.
      const pollStarts = harnessControlFetch.mock.invocationCallOrder.map((invocationOrder) => {
        const sampleIndex = performanceNow.mock.invocationCallOrder.findLastIndex(
          (sampleOrder) => sampleOrder < invocationOrder
        );
        const sample = performanceNow.mock.results[sampleIndex];
        expect(sample?.type).toBe('return');
        return Number(sample?.value);
      });
      const intervals = pollStarts.slice(1).map((time, index) => time - pollStarts[index]!);

      expect(Math.min(...intervals)).toBeGreaterThanOrEqual(250);
      expect(Math.max(...intervals)).toBeLessThanOrEqual(1_000);
    } finally {
      controller.abort();
      await run.catch(() => undefined);
    }
  });

  it('routes one Integration poll loop to independent Harness instances by instance id', async () => {
    const controller = new AbortController();
    const results: Array<Record<string, unknown>> = [];
    const commands = [
      { ...command('harness.drain', 0, {}), harnessInstanceId: 'harness-one' },
      { ...command('harness.drain', 0, {}), harnessInstanceId: 'harness-two' },
      {
        ...command('session.inspect', 1, {
          agentSessionId: 'as-a',
          agentSessionRuntimeBindingId: 'b',
        }),
        harnessInstanceId: 'harness-one',
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
    expect(results).toEqual([
      {
        body: { activeTurns: 0, openSessions: 0, state: 'draining' },
        disposition: 'succeeded',
        harnessInstanceId: 'harness-one',
        operationId: '0'.repeat(64),
        schemaVersion: 2,
        sequence: 0,
      },
      {
        body: { activeTurns: 0, openSessions: 0, state: 'draining' },
        disposition: 'succeeded',
        harnessInstanceId: 'harness-two',
        operationId: '0'.repeat(64),
        schemaVersion: 2,
        sequence: 0,
      },
      {
        body: { reasonCode: 'missing' },
        disposition: 'refused',
        harnessInstanceId: 'harness-one',
        operationId: `${'0'.repeat(63)}1`,
        schemaVersion: 2,
        sequence: 1,
      },
    ]);
  });

  it('retries a retryable poll and resends the identical result after a retryable refusal', async () => {
    const controller = new AbortController();
    const polls: number[] = [];
    const results: string[] = [];
    let served = false;
    loopFixture.client = {
      close: async () => undefined,
      harnessControlFetch: async (path: string, init: { body: string }) => {
        if (path.endsWith('/result')) {
          results.push(init.body);
          if (results.length === 1) return { ok: false, status: 503, text: async () => '' };
          controller.abort(new Error('fixture-complete'));
          return { ok: true, status: 204, text: async () => '' };
        }
        polls.push(polls.length);
        if (polls.length === 1) return { ok: false, status: 500, text: async () => '' };
        if (polls.length === 2) return { ok: false, status: 429, text: async () => '' };
        if (served) return { ok: true, status: 204, text: async () => '' };
        served = true;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ...command('harness.drain', 0, {}),
              harnessInstanceId: 'harness-one',
            }),
        };
      },
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;

    // The loop ends at its next iteration once the accepted result sets the stop signal.
    await expect(runWorkerHarness({ signal: controller.signal })).resolves.toBeUndefined();
    expect(polls).toHaveLength(3);
    expect(results).toHaveLength(2);
    expect(results[1]).toBe(results[0]);
    expect(JSON.parse(results[0] as string)).toMatchObject({
      body: { state: 'draining' },
      sequence: 0,
    });
  });

  it('ends on a nonretryable status and when the monotonic outage budget is spent', async () => {
    loopFixture.client = {
      close: async () => undefined,
      harnessControlFetch: async () => ({ ok: false, status: 404, text: async () => '' }),
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;
    await expect(runWorkerHarness()).rejects.toThrow(/Harness poll failed with HTTP 404/u);

    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 100_000;
      return clock;
    });
    let attempts = 0;
    loopFixture.client = {
      close: async () => undefined,
      harnessControlFetch: async () => {
        attempts += 1;
        return { ok: false, status: 502, text: async () => '' };
      },
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;
    await expect(runWorkerHarness()).rejects.toThrow(/retryable HTTP 502/u);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(5);
  });

  it('stops on a command whose sequence is not the next one for its instance', async () => {
    const controller = new AbortController();
    loopFixture.client = {
      close: async () => undefined,
      harnessControlFetch: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ ...command('harness.drain', 1, {}), harnessInstanceId: 'harness-one' }),
      }),
      ready: Promise.resolve(),
    } as unknown as SandboxIntegrationClient;
    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow(
      /stale or future sequence/u
    );
  });
});

describe('Worker Harness resident AgentSessions', () => {
  it('runs a further runtime through one static registry entry and the unchanged Harness', async () => {
    const fake = fakeAdapter();
    registryFixture.adapter = fake.adapter;
    try {
      const f = harnessFixture({ adapter: fake, registryAdapterId: 'fixture-fourth' });
      expect(await f.open('as-a')).toMatchObject({ disposition: 'succeeded' });
      expect(fake.residents[0]?.input.stateRoot).toBe(
        join(f.nativeRoot, 'fixture-fourth', 'threads', sha256('thread-one'))
      );
      await f.start('as-a', 'turn-1');
      await f.settle('as-a');
      expect(f.integration.finalStatuses).toMatchObject([{ body: { status: 'completed' } }]);
      expect(readFileSync(join(f.sandboxRoot, 'session', 'items.jsonl'), 'utf8')).toContain(
        'answer-turn-1'
      );
      expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
        disposition: 'succeeded',
      });
      // An id without a registry entry is unsupported.
      const unregistered = harnessFixture({ registryAdapterId: 'fixture-fifth' });
      expect(await unregistered.open('as-c')).toEqual(
        expect.objectContaining({ body: { reasonCode: 'unsupported' } })
      );
    } finally {
      registryFixture.adapter = null;
    }
  });

  it('runs two Turns on one resident binding and stores the first ready reference', async () => {
    const f = harnessFixture({
      environment: { GITHUB_TOKEN: 'harness-only', HOME: '/home/worker', NO_PROXY: 'internal' },
    });
    expect(
      await f.open('as-a', { runtimeEnvironment: { VENDOR_TOKEN: 'vendor-secret' } })
    ).toMatchObject({
      body: {
        maxActiveTurns: 1,
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'open',
      },
      disposition: 'succeeded',
    });
    const [resident] = f.fake.residents;
    expect(resident?.input).toMatchObject({
      agentSessionId: 'as-a',
      loopback: {
        capabilityBaseUrl: 'http://127.0.0.1:17892/capabilities',
        capabilityCredential: credential('capability-as-a'),
        inferenceBaseUrl: 'http://127.0.0.1:17892/inference/v1',
        inferenceCredential: credential('inference-as-a'),
      },
      resumeReference: null,
      stateRoot: join(f.nativeRoot, ADAPTER, 'threads', sha256('thread-one')),
    });
    expect(resident?.input.controlRoot.startsWith(f.privateRoot)).toBe(true);
    expect(resident?.input.environment).toMatchObject({
      HOME: '/home/worker',
      NO_PROXY: 'internal,127.0.0.1',
      TMPDIR: '/tmp/openkit-bootstrap',
      VENDOR_TOKEN: 'vendor-secret',
    });
    expect(resident?.input.environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(JSON.stringify(resident?.input.environment)).not.toContain(
      credential('capability-as-a')
    );

    expect(await f.start('as-a', 'turn-1', { runtimeEnvNames: ['VENDOR_TOKEN'] })).toMatchObject({
      body: { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'started' },
      disposition: 'succeeded',
    });
    await f.settle('as-a');
    expect(resident?.turns[0]).toMatchObject({
      mcpServerIds: ['echo'],
      llmRoute: { id: 'worker-inference', model: 'model-a' },
      turnId: 'turn-1',
      turnInput: 'input for turn-1',
      workingDirectory: f.sandboxRoot,
    });
    const digest = sha256('reference-as-a');
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: {
        childState: 'running',
        cleanupState: 'clean',
        nativeHandleDigest: digest,
        nativeHandleState: 'ready',
        state: 'open',
      },
    });
    expect(readFileSync(f.referencePath('as-a'), 'utf8')).toBe('reference-as-a');
    expect(statSync(f.referencePath('as-a')).mode & 0o777).toBe(0o600);
    expect(existsSync(f.packagePath('as-a'))).toBe(false);

    expect(await f.start('as-a', 'turn-2', { runtimeEnvNames: ['VENDOR_TOKEN'] })).toMatchObject({
      body: { nativeHandleDigest: digest, nativeHandleState: 'ready', state: 'started' },
    });
    await f.settle('as-a');
    expect(
      f.integration.finalStatuses.map((status) => [status.lineage.turnId, status.body.status])
    ).toEqual([
      ['turn-1', 'completed'],
      ['turn-2', 'completed'],
    ]);
    expect(f.integration.boundTokens).toEqual([
      {
        capabilityToken: credential('capability-token-turn-1'),
        controlToken: credential('control-token-turn-1'),
        inferenceToken: credential('inference-token-turn-1'),
      },
      {
        capabilityToken: credential('capability-token-turn-2'),
        controlToken: credential('control-token-turn-2'),
        inferenceToken: credential('inference-token-turn-2'),
      },
    ]);

    expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
      body: { childState: 'absent', privateState: 'absent', state: 'closed' },
      disposition: 'succeeded',
    });
    expect(f.integration.calls).toEqual([
      'register:as-a',
      'bind:as-a',
      'drain:as-a',
      'clear:as-a',
      'bind:as-a',
      'drain:as-a',
      'clear:as-a',
      'destroy:as-a',
    ]);
    expect(resident?.closed).toBe(true);
    expect(existsSync(join(f.sandboxRoot, 'sessions', 'as-a'))).toBe(false);
    expect(existsSync(resident?.input.controlRoot as string)).toBe(false);
    expect(readFileSync(f.referencePath('as-a'), 'utf8')).toBe('reference-as-a');
  });

  it('resumes a successor from the stored reference and refuses a missing or changed one', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    await f.start('as-a', 'turn-1');
    await f.settle('as-a');
    await f.send('session.close', f.selector('as-a'));
    const digest = sha256('reference-as-a');

    expect(await f.open('as-b', { resume: { digest, locator: 'as-a' } })).toMatchObject({
      body: { nativeHandleDigest: digest, nativeHandleState: 'ready', state: 'open' },
      disposition: 'succeeded',
    });
    expect(Buffer.from(f.fake.residents[1]?.input.resumeReference ?? []).toString()).toBe(
      'reference-as-a'
    );
    expect(readFileSync(f.referencePath('as-b'), 'utf8')).toBe('reference-as-a');
    // A proved predecessor makes the successor established before its first Turn, so a failed
    // first Turn leaves it able to take the next one.
    f.fake.script.push({ kind: 'fail' });
    await f.start('as-b', 'turn-2');
    await f.settle('as-b');
    expect(await f.start('as-b', 'turn-3')).toMatchObject({ disposition: 'succeeded' });
    await f.settle('as-b');
    await f.send('session.close', f.selector('as-b'));

    const opened = f.fake.residents.length;
    expect(await f.open('as-c', { resume: { digest, locator: 'as-missing' } })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'missing' }, disposition: 'refused' })
    );
    writeFileSync(f.referencePath('as-a'), 'reference-tampered');
    expect(await f.open('as-c', { resume: { digest, locator: 'as-a' } })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(f.fake.residents).toHaveLength(opened);
    expect(f.integration.loopbacks.size).toBe(0);
    // The Thread was released by each refusal.
    expect(await f.open('as-c')).toMatchObject({ disposition: 'succeeded' });
  });

  it('refuses a resumed open whose runtime does not prove the predecessor reference', async () => {
    const first = harnessFixture();
    await first.open('as-a');
    await first.start('as-a', 'turn-1');
    await first.settle('as-a');
    await first.send('session.close', first.selector('as-a'));
    const f = harnessFixture({
      adapter: fakeAdapter({ resumeHandle: { state: 'pending' } }),
      root: first.root,
    });
    expect(
      await f.open('as-b', { resume: { digest: sha256('reference-as-a'), locator: 'as-a' } })
    ).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(f.fake.residents[0]?.closed).toBe(true);
    expect(f.integration.calls).toEqual(['register:as-b', 'destroy:as-b']);
    expect(existsSync(f.referencePath('as-b'))).toBe(false);
  });

  it('refuses a resumed open whose runtime proves a different ready conversation', async () => {
    const first = harnessFixture();
    await first.open('as-a');
    await first.start('as-a', 'turn-1');
    await first.settle('as-a');
    await first.send('session.close', first.selector('as-a'));
    const f = harnessFixture({
      adapter: fakeAdapter({
        resumeHandle: { reference: Buffer.from('wrong-native-conversation'), state: 'ready' },
      }),
      root: first.root,
    });
    expect(
      await f.open('as-b', { resume: { digest: sha256('reference-as-a'), locator: 'as-a' } })
    ).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(f.fake.residents[0]?.closed).toBe(true);
    expect(existsSync(f.referencePath('as-b'))).toBe(false);
    expect(readFileSync(f.referencePath('as-a'), 'utf8')).toBe('reference-as-a');
  });

  it('keeps the Thread and fences the Harness when a refused open cannot close its host', async () => {
    const f = harnessFixture({
      adapter: fakeAdapter({ closeFails: true, initialHandle: { state: 'unknown' } }),
    });
    expect(await f.open('as-a')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'cleanup_required' }, disposition: 'refused' })
    );
    expect(f.fake.residents[0]?.closed).toBe(false);
    // Routes are revoked, but the possibly live host keeps its Thread reserved.
    expect(f.integration.loopbacks.size).toBe(0);
    const sibling = harnessFixture({ root: f.root });
    expect(await sibling.open('as-b')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(sibling.fake.residents).toHaveLength(0);
    expect(await f.open('as-c', { threadId: 'thread-two' })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'busy' }, disposition: 'refused' })
    );
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: 0, openSessions: 1, state: 'draining' },
    });
  });

  it('keeps a Turn whose native stop was not proved and fences its binding', async () => {
    const f = harnessFixture({ integration: fakeIntegration({ readyAppendStatus: 409 }) });
    await f.open('as-a');
    f.fake.script.push({ kind: 'stuck' });
    expect(await f.start('as-a', 'turn-1')).toMatchObject({ disposition: 'succeeded' });
    await vi.waitFor(async () => {
      expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
        body: { cleanupState: 'unknown', state: 'failed' },
      });
    });
    expect(f.fake.residents[0]?.interrupts).toBe(1);
    expect(await f.start('as-a', 'turn-2')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(await f.send('session.close', f.selector('as-a'))).toEqual(
      expect.objectContaining({ body: { reasonCode: 'cleanup_required' }, disposition: 'refused' })
    );
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: 1, openSessions: 1, state: 'draining' },
    });
    expect(f.fake.residents[0]?.turns).toHaveLength(1);
  });

  it('refuses an interrupt whose native stop was not proved', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    f.fake.script.push({ kind: 'stuck' });
    await f.start('as-a', 'turn-1');
    expect(
      await f.send('turn.interrupt', {
        ...f.selector('as-a'),
        leaseId: 'lease-turn-1',
        purpose: 'interrupt',
        turnId: 'turn-1',
      })
    ).toEqual(
      expect.objectContaining({ body: { reasonCode: 'cleanup_required' }, disposition: 'refused' })
    );
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { cleanupState: 'unknown', state: 'failed' },
    });
    expect(await f.send('harness.drain', {})).toMatchObject({ body: { activeTurns: 1 } });
  });

  it('keeps one current binding per Thread across Harness instances and fixes the adapter', async () => {
    const one = harnessFixture();
    const two = harnessFixture({ root: one.root });
    expect(await one.open('as-a')).toMatchObject({ disposition: 'succeeded' });
    expect(await two.open('as-b')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(await one.open('as-a', { threadId: 'thread-two' })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(
      await one.send('session.open', {
        agentSessionCompatibilityKey: DIGEST,
        adapterId: 'other',
        agentSessionId: 'as-x',
        agentSessionRuntimeBindingId: 'binding-as-x',
        capabilityLoopbackCredential: credential('cx'),
        effectiveSetupGeneration: 1,
        inferenceLoopbackCredential: credential('ix'),
        resume: null,
        threadId: 'thread-x',
        workspaceId: 'workspace-one',
      })
    ).toEqual(expect.objectContaining({ body: { reasonCode: 'unsupported' } }));
    expect(await one.open('as.dotted', { threadId: 'thread-y' })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'unsupported' } })
    );
    await one.send('session.close', one.selector('as-a'));
    expect(await two.open('as-b')).toMatchObject({ disposition: 'succeeded' });
    await two.send('session.close', two.selector('as-b'));
  });

  it('keeps a binding whose runtime created a ready handle at open after a failed first Turn', async () => {
    const f = harnessFixture({ adapter: fakeAdapter({ readyAtOpen: true }) });
    const digest = sha256('reference-as-a');
    expect(await f.open('as-a')).toMatchObject({
      body: { nativeHandleDigest: digest, nativeHandleState: 'ready', state: 'open' },
    });
    f.fake.script.push({ kind: 'fail' });
    expect(await f.start('as-a', 'turn-1')).toMatchObject({ disposition: 'succeeded' });
    await f.settle('as-a');
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { nativeHandleDigest: digest, nativeHandleState: 'ready', state: 'open' },
    });
    expect(await f.start('as-a', 'turn-2')).toMatchObject({ disposition: 'succeeded' });
    await f.settle('as-a');
    await f.send('session.close', f.selector('as-a'));
  });

  it('fences a binding whose first Turn did not complete', async () => {
    for (const outcome of ['fail', 'interrupt'] as const) {
      const f = harnessFixture();
      await f.open('as-a');
      if (outcome === 'interrupt') {
        f.fake.script.push({ kind: 'hold' });
        expect(await f.start('as-a', 'turn-1')).toMatchObject({ disposition: 'succeeded' });
        expect(
          await f.send('turn.interrupt', {
            ...f.selector('as-a'),
            leaseId: 'lease-turn-1',
            purpose: 'interrupt',
            turnId: 'turn-1',
          })
        ).toMatchObject({ body: { state: 'interrupted' }, disposition: 'succeeded' });
      } else {
        f.fake.script.push({ kind: outcome });
        const started = await f.start('as-a', 'turn-1');
        expect(started.disposition).toBe('succeeded');
        await f.settle('as-a');
      }
      expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
        body: { nativeHandleDigest: null, nativeHandleState: 'pending' },
      });
      expect(await f.start('as-a', 'turn-2'), outcome).toEqual(
        expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
      );
      expect(existsSync(f.referencePath('as-a'))).toBe(false);
      expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
        disposition: 'succeeded',
      });
    }
  });

  it('fences a binding when native Turn acceptance is not proved', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    f.fake.script.push({ kind: 'reject' });
    expect(await f.start('as-a', 'turn-1')).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          reasonCode: 'dependency_failed',
          startupFailure: expect.objectContaining({ reason: 'failed', stage: 'native_spawn' }),
        }),
        disposition: 'refused',
      })
    );
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { cleanupState: 'unknown', state: 'failed' },
    });
    expect(await f.start('as-a', 'turn-2')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' }, disposition: 'refused' })
    );
    expect(await f.send('session.close', f.selector('as-a'))).toEqual(
      expect.objectContaining({ body: { reasonCode: 'cleanup_required' }, disposition: 'refused' })
    );
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: 1, openSessions: 1, state: 'draining' },
    });
  });

  it('interrupts only the exact active Turn, answers after it settled, and keeps the binding', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    await f.start('as-a', 'turn-1');
    await f.settle('as-a');
    f.fake.script.push({ kind: 'hold' });
    expect(await f.start('as-a', 'turn-2')).toMatchObject({ disposition: 'succeeded' });
    const interrupt = (turnId: string, leaseId: string) =>
      f.send('turn.interrupt', { ...f.selector('as-a'), leaseId, purpose: 'interrupt', turnId });

    expect(await f.start('as-a', 'turn-3')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'busy' } })
    );
    expect(await f.send('session.close', f.selector('as-a'))).toEqual(
      expect.objectContaining({ body: { reasonCode: 'busy' } })
    );
    expect(await interrupt('turn-2', 'lease-other')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'stale' } })
    );
    expect(await interrupt('turn-1', 'lease-turn-2')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'stale' } })
    );
    expect(await interrupt('turn-2', 'lease-turn-2')).toMatchObject({
      body: { childState: 'running', state: 'interrupted' },
      disposition: 'succeeded',
    });
    expect(f.fake.residents[0]?.interrupts).toBe(1);
    expect(f.integration.finalStatuses.at(-1)).toMatchObject({
      body: { status: 'interrupted' },
      lineage: { turnId: 'turn-2' },
    });
    expect(await interrupt('turn-2', 'lease-turn-2')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'stale' } })
    );
    expect(await f.start('as-a', 'turn-3')).toMatchObject({
      body: { nativeHandleDigest: sha256('reference-as-a'), nativeHandleState: 'ready' },
      disposition: 'succeeded',
    });
    await f.settle('as-a');
    expect(f.integration.finalStatuses.at(-1)).toMatchObject({ body: { status: 'completed' } });
  });

  it('drains by refusing new work while existing bindings still close', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    await f.start('as-a', 'turn-1');
    await f.settle('as-a');
    f.fake.script.push({ kind: 'hold' });
    await f.start('as-a', 'turn-2');
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: 1, openSessions: 1, state: 'draining' },
      disposition: 'succeeded',
    });
    expect(await f.open('as-b', { threadId: 'thread-two' })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'busy' } })
    );
    await f.send('turn.interrupt', {
      ...f.selector('as-a'),
      leaseId: 'lease-turn-2',
      purpose: 'interrupt',
      turnId: 'turn-2',
    });
    expect(await f.start('as-a', 'turn-3')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'busy' } })
    );
    expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
      disposition: 'succeeded',
    });
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: 0, openSessions: 0, state: 'draining' },
    });
  });

  it('refuses malformed bodies, reserved runtime names, and excess sessions before any effect', async () => {
    const f = harnessFixture();
    const baseOpen = {
      ...f.selector('as-a'),
      adapterId: ADAPTER,
      agentSessionCompatibilityKey: DIGEST,
      capabilityLoopbackCredential: credential('c'),
      effectiveSetupGeneration: 1,
      inferenceLoopbackCredential: credential('i'),
      resume: null,
      threadId: 'thread-one',
      workspaceId: 'workspace-one',
    };
    for (const body of [
      { ...baseOpen, storageRef: 'retired' },
      { ...baseOpen, inferenceLoopbackCredential: credential('c') },
      { ...baseOpen, capabilityLoopbackCredential: 'short' },
      { ...baseOpen, resume: undefined },
    ]) {
      expect(await f.send('session.open', body)).toEqual(
        expect.objectContaining({ body: { reasonCode: 'unsupported' }, disposition: 'refused' })
      );
    }
    for (const name of [
      'PATH',
      'HOME',
      'NODE_OPTIONS',
      'OPENKIT_ROUTE',
      'npm_config_nodedir',
      'TMPDIR',
    ]) {
      expect(await f.open('as-a', { runtimeEnvironment: { [name]: 'value' } }), name).toEqual(
        expect.objectContaining({ body: { reasonCode: 'unsupported' } })
      );
    }
    expect(f.fake.residents).toHaveLength(0);
    expect(f.integration.calls).toEqual([]);

    await f.open('as-a');
    const { turnSequence: _omitted, ...missing } = f.startBody('as-a', 'turn-1');
    f.writePackage('as-a', 'turn-1');
    expect(await f.send('turn.start', missing)).toEqual(
      expect.objectContaining({ body: { reasonCode: 'unsupported' } })
    );
    expect(
      await f.send('turn.start', {
        ...f.startBody('as-a', 'turn-1'),
        contextPackageId: 'ctxpkg_other',
      })
    ).toEqual(expect.objectContaining({ body: { reasonCode: 'stale' } }));
    expect(
      await f.send('turn.start', {
        ...f.startBody('as-a', 'turn-1'),
        agentSessionRuntimeBindingId: 'binding-other',
      })
    ).toEqual(expect.objectContaining({ body: { reasonCode: 'missing' } }));
    expect(
      await f.send('turn.start', { ...f.startBody('as-a', 'turn-1'), agentSessionId: 'as-other' })
    ).toEqual(expect.objectContaining({ body: { reasonCode: 'conflict' } }));
    expect(
      await f.send('turn.interrupt', { ...f.selector('as-a'), leaseId: 'l', turnId: 't' })
    ).toEqual(expect.objectContaining({ body: { reasonCode: 'unsupported' } }));
    expect(f.fake.residents[0]?.turns).toHaveLength(0);

    for (let index = 1; index < 8; index += 1) {
      expect(await f.open(`as-${index}`, { threadId: `thread-${index}` })).toMatchObject({
        disposition: 'succeeded',
      });
    }
    expect(await f.open('as-9', { threadId: 'thread-9' })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'busy' } })
    );
  });

  it.each([
    'missing_file',
    'invalid_json',
  ] as const)('reports a value-free startup failure for the package: %s', async (reason) => {
    const f = harnessFixture();
    await f.open('as-a');
    f.writePackage('as-a', 'turn-1');
    if (reason === 'missing_file') {
      rmSync(f.packagePath('as-a'));
    } else {
      writeFileSync(f.packagePath('as-a'), '{ secret-canary-that-must-not-escape');
    }
    const result = await f.send('turn.start', f.startBody('as-a', 'turn-1'));
    expect(result).toMatchObject({
      body: {
        reasonCode: 'dependency_failed',
        startupFailure: { reason, stage: 'package_validation' },
      },
      disposition: 'refused',
    });
    expect(Object.keys(result.body).sort()).toEqual(['reasonCode', 'startupFailure']);
    expect(JSON.stringify(result)).not.toContain('secret-canary');
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(f.fake.residents[0]?.turns).toHaveLength(0);
    expect(existsSync(f.packagePath('as-a'))).toBe(false);
  });

  it('refuses a Turn whose runtime environment declaration differs from the session', async () => {
    const f = harnessFixture();
    await f.open('as-a', { runtimeEnvironment: { VENDOR_TOKEN: 'vendor-secret' } });
    for (const names of [[], ['VENDOR_TOKEN', 'OTHER_TOKEN'], ['OTHER_TOKEN']]) {
      const g = names.length === 0 ? f : harnessFixture();
      if (g !== f) await g.open('as-a', { runtimeEnvironment: { VENDOR_TOKEN: 'vendor-secret' } });
      expect(
        await g.start('as-a', 'turn-1', { runtimeEnvNames: names }),
        names.join()
      ).toMatchObject({
        body: {
          reasonCode: 'dependency_failed',
          startupFailure: { reason: 'failed', stage: 'package_validation' },
        },
      });
      expect(g.fake.residents[0]?.turns).toHaveLength(0);
    }
  });

  it('fails a Turn whose assistant output carries a session credential or runtime value', async () => {
    for (const leaked of [
      credential('capability-as-a'),
      credential('inference-as-a'),
      'vendor-secret',
    ]) {
      const f = harnessFixture();
      await f.open('as-a', { runtimeEnvironment: { VENDOR_TOKEN: 'vendor-secret' } });
      f.fake.script.push({ kind: 'complete', text: `here it is: ${leaked}` });
      await f.start('as-a', 'turn-1', { runtimeEnvNames: ['VENDOR_TOKEN'] });
      await f.settle('as-a');
      expect(f.integration.finalStatuses).toMatchObject([{ body: { status: 'failed' } }]);
      expect(readFileSync(join(f.sandboxRoot, 'session', 'events.jsonl'), 'utf8')).not.toContain(
        leaked
      );
      expect(await f.start('as-a', 'turn-2', { runtimeEnvNames: ['VENDOR_TOKEN'] })).toEqual(
        expect.objectContaining({ body: { reasonCode: 'conflict' } })
      );
    }
  });

  it('fails the binding when its resident host ends on its own', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    await f.start('as-a', 'turn-1');
    await f.settle('as-a');
    f.fake.script.push({ kind: 'hold' });
    await f.start('as-a', 'turn-2');
    f.fake.residents[0]?.exit();
    await vi.waitFor(() => expect(f.integration.finalStatuses).toHaveLength(2));
    expect(f.integration.finalStatuses[1]).toMatchObject({
      body: { status: 'failed' },
      lineage: { turnId: 'turn-2' },
    });
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { childState: 'running', state: 'failed' },
    });
    // The ended host proves its native work stopped, so no native interrupt is needed.
    expect(f.fake.residents[0]?.interrupts).toBe(0);
    expect(await f.start('as-a', 'turn-3')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' } })
    );
    // Close answers busy until the failed Turn finished its cleanup.
    await vi.waitFor(async () => {
      expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
        disposition: 'succeeded',
      });
    });
  });

  it('reports a changed native handle as unknown and never replaces the stored reference', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    await f.start('as-a', 'turn-1');
    await f.settle('as-a');
    const resident = f.fake.residents[0] as FakeResident;
    resident.handleOverride = { reference: Buffer.from('reference-changed'), state: 'ready' };
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { nativeHandleDigest: null, nativeHandleState: 'unknown' },
    });
    resident.handleOverride = { state: 'pending' };
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { nativeHandleDigest: null, nativeHandleState: 'unknown' },
    });
    expect(readFileSync(f.referencePath('as-a'), 'utf8')).toBe('reference-as-a');
  });

  it('cleans up an open that fails and reports close failure as cleanup required', async () => {
    const failing = harnessFixture({ adapter: fakeAdapter({ openFails: true }) });
    expect(await failing.open('as-a')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'dependency_failed' } })
    );
    expect(failing.integration.calls).toEqual(['register:as-a', 'destroy:as-a']);
    expect(existsSync(failing.privateRoot) ? readdirSync(failing.privateRoot) : []).toEqual([]);

    const conflicting = harnessFixture({
      integration: fakeIntegration({ registerFails: true }),
      root: failing.root,
    });
    expect(await conflicting.open('as-a')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' } })
    );
    // Both refusals released the Thread.
    const f = harnessFixture({ root: failing.root });
    expect(await f.open('as-a')).toMatchObject({ disposition: 'succeeded' });
    (f.fake.residents[0] as FakeResident).closeFails = true;
    expect(await f.send('session.close', f.selector('as-a'))).toEqual(
      expect.objectContaining({ body: { reasonCode: 'cleanup_required' } })
    );
    // A failed close leaves an explicit non-reusable binding and a fenced Harness.
    expect(f.integration.loopbacks.size).toBe(0);
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { cleanupState: 'unknown', state: 'failed' },
    });
    expect(await f.start('as-a', 'turn-1')).toEqual(
      expect.objectContaining({ body: { reasonCode: 'conflict' } })
    );
    expect(await f.open('as-b', { threadId: 'thread-two' })).toEqual(
      expect.objectContaining({ body: { reasonCode: 'busy' } })
    );
  });
});
