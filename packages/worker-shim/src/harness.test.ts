// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { setTimeout as delay } from 'node:timers/promises';

import { HarnessSuccessBodySchemas } from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkerAdapterResult,
  WorkerNativeHandle,
  WorkerResidentAdapter,
  WorkerResidentOpenInput,
  WorkerResidentTurnInput,
} from './adapter-registry.js';
import { WorkerControlClient, type WorkerControlFetch } from './control-client.js';
import { runWorkerHarness, WorkerHarness } from './harness.js';
import type { SandboxIntegrationClient } from './integration-client.js';
import { WorkerTranscriptWriter } from './transcript.js';
import { initializeSessionWorkspace, runResidentTurn } from './turn.js';
import { TURN_TIMELINE_LABELS, TurnTimeline } from './turn-timeline.js';

const loopFixture = vi.hoisted(() => ({
  client: null as SandboxIntegrationClient | null,
  events: [] as string[],
}));

const schedulingClock = vi.hoisted(() => ({ controlled: false }));

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: <T>(ms: number, value: T, options?: { signal?: AbortSignal }) => {
      if (!schedulingClock.controlled) return actual.setTimeout(ms, value, options);
      return new Promise<T>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
});

/** Explicit request-entry or release observation, independent of scheduling time. */
function observation() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Controls the real heartbeat/retry intervals while filesystem and native-fixture setup remain asynchronous. */
function controlSchedulingTime() {
  schedulingClock.controlled = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  return {
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    restore: () => {
      schedulingClock.controlled = false;
      vi.useRealTimers();
    },
  };
}

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
  | { readonly kind: 'reject'; readonly error?: unknown }
  | { readonly kind: 'reject-settlement'; readonly stopProved: boolean }
  | { readonly kind: 'interrupt-race'; readonly status: 'completed' | 'failed' }
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
          const next = script.shift() ?? { kind: 'complete' };
          if (next.kind === 'reject') throw next.error ?? new Error('native turn refused');
          resident.turns.push(turnInput);
          let interrupt!: () => void;
          const interrupted = new Promise<WorkerAdapterResult>((resolve) => {
            interrupt = () =>
              resolve({ assistantText: null, status: 'interrupted', stopReason: 'aborted' });
          });
          if (next.kind === 'reject-settlement') {
            return {
              async interrupt() {
                resident.interrupts += 1;
                if (!next.stopProved) throw new Error('native stop unproved');
              },
              settled: new Promise<WorkerAdapterResult>((_resolve, reject) => {
                setTimeout(() => reject(new Error('native settlement unproved')), 10);
              }),
            };
          }
          if (next.kind === 'interrupt-race') {
            let settle!: (result: WorkerAdapterResult) => void;
            const settled = new Promise<WorkerAdapterResult>((resolve) => {
              settle = resolve;
            });
            return {
              async interrupt() {
                resident.interrupts += 1;
                settle(
                  next.status === 'completed'
                    ? {
                        assistantText: 'raced answer',
                        status: 'completed',
                        stopReason: 'completed',
                      }
                    : { assistantText: null, status: 'failed', stopReason: 'error' }
                );
                await settled;
              },
              settled,
            };
          }
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
  const finalStatuses: Array<{
    body: { status: string; diagnostics?: Record<string, string> };
    lineage: { turnId: string };
  }> = [];
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
      initialPackage?: boolean;
      runtimeEnvironment?: Record<string, string>;
      nativeEnvironment?: Record<string, string>;
      threadId?: string;
    } = {}
  ) => {
    if (extra.initialPackage !== false && !existsSync(packagePath(agentSessionId)))
      writePackage(agentSessionId, 'initial', {
        threadId: extra.threadId,
        runtimeEnvNames: Object.keys(extra.runtimeEnvironment ?? {}),
      });
    return send('session.open', {
      ...selector(agentSessionId),
      adapterId,
      agentSessionCompatibilityKey: DIGEST,
      capabilityLoopbackCredential: credential(`capability-${agentSessionId}`),
      effectiveSetupGeneration: 1,
      inferenceLoopbackCredential: credential(`inference-${agentSessionId}`),
      resume: extra.resume ?? null,
      ...(extra.runtimeEnvironment ? { runtimeEnvironment: extra.runtimeEnvironment } : {}),
      ...(extra.nativeEnvironment ? { nativeEnvironment: extra.nativeEnvironment } : {}),
      threadId: extra.threadId ?? 'thread-one',
      workspaceId: 'workspace-one',
    });
  };
  const packagePath = (agentSessionId: string) =>
    join(sandboxRoot, 'sessions', agentSessionId, 'config', 'package.json');
  const contextRoot = (agentSessionId: string) =>
    join(sandboxRoot, 'sessions', agentSessionId, 'context');
  /** Materializes the Turn's AEP where the owner would. */
  const writePackage = (
    agentSessionId: string,
    turnId: string,
    extra: {
      allowedModels?: readonly string[];
      runtimeEnvNames?: readonly string[];
      threadId?: string;
    } = {}
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
        extensions: {
          openkit: {
            turnInput: `input for ${turnId}`,
            sessionWorkspace: {
              layout: {
                slots: [
                  {
                    kind: 'worktree',
                    access: 'read-write',
                    path: join(sandboxRoot, 'worktrees', agentSessionId),
                  },
                ],
              },
            },
          },
        },
        llm: {
          mode: 'gateway',
          preferredLogicalModelId: 'model-a',
          routes: (extra.allowedModels ?? ['model-a']).map((model, index) => ({
            credentialVisibility: 'placeholder',
            endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
            id: `worker-inference-${index}`,
            model,
            providerInstanceId: 'provider-a',
          })),
        },
        observability: { captureCoverage: { scope: 'server', value: 'off' } },
        runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: sandboxRoot } },
        scope: {
          agentSessionId,
          threadId: extra.threadId ?? 'thread-one',
          turnId,
          workspaceId: 'workspace-one',
        },
        workspace: { root: sandboxRoot, inputs: [] },
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
    extra: {
      allowedModels?: readonly string[];
      leaseId?: string;
      runtimeEnvNames?: readonly string[];
    } = {}
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

describe('session.open workspace initialization', () => {
  it('resumes after Sandbox recreation only on the retained native root', async () => {
    const first = harnessFixture();
    expect(await first.open('as-recreate-predecessor')).toMatchObject({ disposition: 'succeeded' });
    expect(await first.start('as-recreate-predecessor', 'turn-recreate-1')).toMatchObject({
      disposition: 'succeeded',
    });
    await first.settle('as-recreate-predecessor');
    expect(
      await first.send('session.close', first.selector('as-recreate-predecessor'))
    ).toMatchObject({ disposition: 'succeeded' });
    const reference = readFileSync(first.referencePath('as-recreate-predecessor'));
    const resume = { digest: sha256(reference), locator: 'as-recreate-predecessor' };
    // Sandbox deletion removes disposable roots but retains the complete data mount.
    rmSync(first.privateRoot, { force: true, recursive: true });
    rmSync(first.sandboxRoot, { force: true, recursive: true });
    const reattached = harnessFixture({ root: first.root });
    expect(await reattached.open('as-recreate-reattached', { resume })).toMatchObject({
      body: { nativeHandleDigest: resume.digest, nativeHandleState: 'ready', state: 'open' },
      disposition: 'succeeded',
    });
    expect(Buffer.from(reattached.fake.residents[0]!.input.resumeReference!)).toEqual(reference);
    expect(
      await reattached.send('session.close', reattached.selector('as-recreate-reattached'))
    ).toMatchObject({ disposition: 'succeeded' });
    // A fresh association can use the same logical Thread while mounting different bytes.
    const fresh = harnessFixture();
    expect(await fresh.open('as-recreate-fresh', { resume })).toMatchObject({
      body: { reasonCode: 'missing' },
      disposition: 'refused',
    });
    expect(fresh.fake.residents).toHaveLength(0);
    expect(fresh.integration.loopbacks.size).toBe(0);
    expect(readFileSync(first.referencePath(resume.locator))).toEqual(reference);
    writeFileSync(first.referencePath(resume.locator), 'corrupt reference');
    const corrupt = harnessFixture({ root: first.root });
    expect(await corrupt.open('as-recreate-corrupt', { resume })).toMatchObject({
      body: { reasonCode: 'conflict' },
      disposition: 'refused',
    });
    expect(corrupt.fake.residents).toHaveLength(0);
    expect(corrupt.integration.loopbacks.size).toBe(0);
  });

  it('initializes the source-less empty work slot before the native runtime opens', async () => {
    const fixture = harnessFixture();
    fixture.writePackage('session-empty', 'initial');
    const path = join(fixture.sandboxRoot, 'worktrees', 'session-empty');
    expect(existsSync(path)).toBe(false);
    const nativeEnvironment = { HELLO_NATIVE: 'hello', EMPTY_NATIVE: '' };
    const packagePath = fixture.packagePath('session-empty');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    manifest.runtime.environment = {
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: `sha256:${'b'.repeat(64)}`,
      values: nativeEnvironment,
    };
    writeFileSync(packagePath, JSON.stringify(manifest));
    const openSession = fixture.fake.adapter.openSession.bind(fixture.fake.adapter);
    const boundary = vi
      .spyOn(fixture.fake.adapter, 'openSession')
      .mockImplementation(async (input) => {
        expect(existsSync(path)).toBe(true);
        expect(readdirSync(path)).toEqual([]);
        expect(input.environment).toMatchObject(nativeEnvironment);
        return await openSession(input);
      });
    const result = await fixture.open('session-empty', { nativeEnvironment });
    expect(result.disposition).toBe('succeeded');
    expect(boundary).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(path)).toEqual([]);
    expect(fixture.fake.residents).toHaveLength(1);
  });
  it.each([
    'scope',
    'root',
    'slots',
    'slot-path',
    'supply',
  ])('refuses incompatible initial %s before native open', async (part) => {
    const fixture = harnessFixture();
    fixture.writePackage('session-invalid', 'initial');
    const path = join(fixture.sandboxRoot, 'sessions', 'session-invalid', 'config', 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (part === 'scope') manifest.scope.threadId = 'foreign';
    if (part === 'root') delete manifest.workspace.root;
    if (part === 'slots') delete manifest.extensions.openkit.sessionWorkspace.layout.slots;
    if (part === 'slot-path')
      manifest.extensions.openkit.sessionWorkspace.layout.slots[0].path = 42;
    if (part === 'supply')
      manifest.supply = {
        skills: [
          {
            id: 'missing',
            materialization: {
              kind: 'filesystem-copy',
              targetPath: join(fixture.root, 'missing-skill'),
            },
          },
        ],
      };
    writeFileSync(path, JSON.stringify(manifest));
    const invariantError = (
      {
        root: 'Initial workspace root is unavailable',
        slots: 'Initial workspace slots are unavailable',
        'slot-path': 'Initial workspace slot is invalid',
      } as Record<string, string>
    )[part];
    if (invariantError)
      await expect(
        initializeSessionWorkspace(path, join(fixture.sandboxRoot, 'sessions', 'session-invalid'), {
          agentSessionId: 'session-invalid',
          threadId: 'thread-one',
          workspaceId: 'workspace-one',
        })
      ).rejects.toThrow(invariantError);
    const result = await fixture.open('session-invalid');
    expect(result.disposition).toBe('refused');
    expect(result.body).toMatchObject({ startupFailure: { stage: 'workspace_materialization' } });
    expect(fixture.fake.residents).toHaveLength(0);
  });
  it('returns a workspace materialization fetch refusal before native open', async () => {
    const fixture = harnessFixture();
    fixture.writePackage('session-git-refusal', 'initial');
    const path = join(
      fixture.sandboxRoot,
      'sessions',
      'session-git-refusal',
      'config',
      'package.json'
    );
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.workspace.inputs = [
      {
        id: 'repo',
        kind: 'repository',
        access: 'read-write',
        target: manifest.extensions.openkit.sessionWorkspace.layout.slots[0].path,
        source: {
          kind: 'git',
          url: 'https://example.invalid/refused.git',
          commit: 'a'.repeat(40),
          catalogEntryDigest: `sha256:${'b'.repeat(64)}`,
          sensitivity: 'internal',
          sourceId: 'repo',
          sourceRef: 'source-ref',
        },
        materialization: { strategy: 'git' },
      },
    ];
    writeFileSync(path, JSON.stringify(manifest));
    const bin = join(fixture.root, 'git-bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!${process.execPath}\nif (process.argv.includes('fetch')) { process.stderr.write('fatal: The requested URL returned error: 401\\n'); process.exit(1); }\nprocess.exit(0);\n`
    );
    chmodSync(join(bin, 'git'), 0o755);
    const previous = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previous}`;
      const result = await fixture.open('session-git-refusal');
      expect(result.disposition).toBe('refused');
      expect(result.body).toMatchObject({
        startupFailure: { stage: 'workspace_materialization', reason: 'git_fetch_http_refused' },
      });
      expect(fixture.fake.residents).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
  it('refuses a missing initial AEP before opening the native runtime', async () => {
    const fixture = harnessFixture();
    const result = await fixture.open('session-missing', { initialPackage: false });
    expect(result.disposition).toBe('refused');
    expect(result.body).toMatchObject({
      reasonCode: 'dependency_failed',
      startupFailure: { stage: 'workspace_materialization', reason: 'missing_file' },
    });
    expect(fixture.fake.residents).toHaveLength(0);
  });
});

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

    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow(
      'fixture-complete'
    );
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
      await expect(run).rejects.toThrow('cadence-complete');
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
      { ...command('harness.drain', 0, {}), harnessInstanceId: 'harness-one', note: 'ignored' },
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

    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow(
      'fixture-complete'
    );
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

  it.each([
    'collected',
    'text',
  ] as const)('retries an abandoned %s command without parsing or handling it', async (phase) => {
    const controller = new AbortController();
    const handle = vi.spyOn(WorkerHarness.prototype, 'handle');
    let requestSignal: AbortSignal;
    /** Resolves on the actual exchange abort, even when the transport supplies a complete body. */
    const abandoned = () =>
      new Promise<void>((resolve) =>
        requestSignal.addEventListener('abort', () => resolve(), { once: true })
      );
    const text = vi.fn(async () => {
      if (phase === 'text') await abandoned();
      return JSON.stringify({
        ...command('harness.drain', 0, {}),
        harnessInstanceId: 'harness-one',
      });
    });
    const requests: Array<{
      path: string;
      body: string;
      method: string;
      headers: Record<string, string>;
    }> = [];
    loopFixture.client = {
      ready: Promise.resolve(),
      close: async () => undefined,
      harnessControlFetch: async (path, init) => {
        requests.push({ path, body: init.body, method: init.method, headers: init.headers });
        if (requests.length !== 1) return { ok: false, status: 404, text: async () => '' };
        requestSignal = init.signal!;
        if (phase === 'collected') await abandoned();
        return { ok: true, status: 200, text };
      },
    } as SandboxIntegrationClient;
    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toEqual({
      path: '/worker-control/harness/poll',
      body: '{"schemaVersion":2}',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    if (phase === 'collected') expect(text).not.toHaveBeenCalled();
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

    // Aborting during the second result response abandons that acknowledgment as well.
    await expect(runWorkerHarness({ signal: controller.signal })).rejects.toThrow(
      'fixture-complete'
    );
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
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let attempts = 0;
    loopFixture.client = {
      close: async () => undefined,
      harnessControlFetch: async () => {
        attempts += 1;
        clock += 100_000;
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
  it('registers the bound adapter inference mapping with its loopback credentials', async () => {
    const fake = fakeAdapter();
    const mapping = { headers: [], bodyFields: [], map: () => undefined };
    Object.assign(fake.adapter, { inferenceRuntimeHintMapping: mapping });
    const f = harnessFixture({ adapter: fake });
    expect(await f.open('as-mapping')).toMatchObject({ disposition: 'succeeded' });
    expect(f.integration.loopbacks.get('as-mapping')).toMatchObject({
      inferenceRuntimeHintMapping: mapping,
    });
    expect(await f.send('session.close', f.selector('as-mapping'))).toMatchObject({
      disposition: 'succeeded',
    });
  });

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

  it('delivers the exact admitted logical-model routes and rejects duplicate core models', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    expect(
      await f.start('as-a', 'turn-1', { allowedModels: ['model-a', 'model-b'] })
    ).toMatchObject({ disposition: 'succeeded' });
    expect(f.fake.residents[0]?.turns[0]).toMatchObject({
      llmRoute: { model: 'model-a' },
      allowedLlmRoutes: [{ model: 'model-a' }, { model: 'model-b' }],
    });
    await f.settle('as-a');
    expect(
      await f.start('as-a', 'turn-2', { allowedModels: ['model-a', 'model-a'] })
    ).toMatchObject({ disposition: 'refused' });
    expect(f.fake.residents[0]?.turns).toHaveLength(1);
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
      llmRoute: { id: 'worker-inference-0', model: 'model-a' },
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

  it.each([
    'settlement',
    'drain',
    'terminal',
  ] as const)('keeps advancing lease heartbeats through a quiet Turn and delayed %s acceptance', async (stage) => {
    const clock = controlSchedulingTime();
    const integration = fakeIntegration();
    const fetch = integration.client.workerControlFetch;
    const heartbeats: number[] = [];
    let lastAcceptedAt = Date.now();
    let authorityLive = true;
    const started = observation();
    const firstEvent = observation();
    const blocked = observation();
    const release = observation();
    const cleared = observation();
    const clear = integration.client.clearTurnRouteTokens.bind(integration.client);
    vi.spyOn(integration.client, 'clearTurnRouteTokens').mockImplementation((id) => {
      clear(id);
      cleared.resolve();
    });
    vi.spyOn(integration.client, 'workerControlFetch').mockImplementation((async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/heartbeat')) {
        if (!authorityLive || Date.now() - lastAcceptedAt > 2500) {
          authorityLive = false;
          return {
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ code: 'worker_control_lease_not_live' }),
          };
        }
        expect(body.sequence).toBe(heartbeats.length);
        heartbeats.push(body.sequence);
        lastAcceptedAt = Date.now();
      }
      if (body.record?.event.data.status === 'turn.started') started.resolve();
      if (body.record?.event.data.status === 'running') firstEvent.resolve();
      if (
        (stage === 'settlement' && body.record?.event.data.status === 'turn.settled') ||
        (stage === 'terminal' && url.endsWith('/final-status'))
      ) {
        blocked.resolve();
        await release.promise;
      }
      const result = await fetch(url, init);
      if (url.endsWith('/final-status')) authorityLive = false;
      return result;
    }) satisfies WorkerControlFetch);
    if (stage === 'drain')
      vi.spyOn(integration.client, 'drainTurn').mockImplementation(async () => {
        blocked.resolve();
        await release.promise;
        return 0;
      });
    const f = harnessFixture({ integration });
    f.fake.script.push({ kind: 'hold' });
    let interruption: ReturnType<typeof f.send> | undefined;
    try {
      await f.open('as-a');
      await f.start('as-a', 'turn-1');
      await started.promise;
      await clock.advance(1000);
      await firstEvent.promise;
      await clock.advance(0);
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      interruption = f.send('turn.interrupt', {
        ...f.selector('as-a'),
        turnId: 'turn-1',
        leaseId: 'lease-turn-1',
        purpose: 'interrupt',
      });
      await blocked.promise;
      const before = heartbeats.length;
      // Controlled scheduling crosses the same injected deadline without relying on CI wall time.
      await clock.advance(3200);
      expect(authorityLive).toBe(true);
      expect(heartbeats.length).toBeGreaterThanOrEqual(before + 3);
      expect(integration.finalStatuses).toHaveLength(0);
    } finally {
      release.resolve();
      await interruption;
      await cleared.promise;
      const accepted = heartbeats.length;
      await clock.advance(1100);
      expect(heartbeats).toHaveLength(accepted);
      clock.restore();
      await f.settle('as-a');
    }
    expect(integration.finalStatuses.at(-1)?.body.status).toBe('interrupted');
  });

  it('keeps lease heartbeats independent of an unanswered event through timeout and retry during quiet native work', async () => {
    const clock = controlSchedulingTime();
    const integration = fakeIntegration();
    const fetch = integration.client.workerControlFetch;
    const heartbeats: number[] = [];
    const attempts: string[] = [];
    const acceptedEvents: number[] = [];
    let lastAcceptedAt = Date.now();
    let retrySequence: number | undefined;
    let timeoutReason: unknown;
    const started = observation();
    const blocked = observation();
    const retried = observation();
    const cleared = observation();
    const clear = integration.client.clearTurnRouteTokens.bind(integration.client);
    vi.spyOn(integration.client, 'clearTurnRouteTokens').mockImplementation((id) => {
      clear(id);
      cleared.resolve();
    });
    vi.spyOn(integration.client, 'workerControlFetch').mockImplementation((async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/heartbeat')) {
        expect(Date.now() - lastAcceptedAt).toBeLessThan(2500);
        expect(body.sequence).toBe(heartbeats.length);
        heartbeats.push(body.sequence);
        lastAcceptedAt = Date.now();
      }
      if (url.endsWith('/events/append')) {
        const record = body.record;
        if (record.event.data.status === 'turn.started') started.resolve();
        if (retrySequence === undefined && record.event.data.status === 'running') {
          retrySequence = record.sequence;
          attempts.push(init.body);
          blocked.resolve();
          // No response is supplied, even under controlled time; only the real request deadline cancels it.
          await new Promise<never>((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                timeoutReason = init.signal?.reason;
                reject(timeoutReason);
              },
              { once: true }
            );
          });
        }
        if (record.sequence === retrySequence) {
          attempts.push(init.body);
          retried.resolve();
        }
        acceptedEvents.push(record.sequence);
      }
      return fetch(url, init);
    }) satisfies WorkerControlFetch);
    const f = harnessFixture({ integration });
    f.fake.script.push({ kind: 'hold' });
    try {
      await f.open('as-a');
      await f.start('as-a', 'turn-1');
      await started.promise;
      await clock.advance(1000);
      await blocked.promise;
      const before = heartbeats.length;
      const earlierEvents = [...acceptedEvents];
      await clock.advance(3200);
      expect(heartbeats.length).toBeGreaterThanOrEqual(before + 3);
      expect(acceptedEvents).toEqual(earlierEvents);
      expect(attempts).toHaveLength(1);
      expect(integration.finalStatuses).toHaveLength(0);
      // Advance through the unchanged ten-second deadline and 250 ms immutable retry interval.
      await clock.advance(7050);
      await retried.promise;
      expect(timeoutReason).toMatchObject({ code: 'worker_control_request_timeout' });
      expect(heartbeats.length).toBeGreaterThanOrEqual(before + 9);
      expect(integration.finalStatuses).toHaveLength(0);
    } finally {
      // Also release the unanswered base-code counterfactual after its deciding assertion failed.
      await clock.advance(10_250);
      await f.send('turn.interrupt', {
        ...f.selector('as-a'),
        turnId: 'turn-1',
        leaseId: 'lease-turn-1',
        purpose: 'interrupt',
      });
      await cleared.promise;
      clock.restore();
      await f.settle('as-a');
    }
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    const events = readFileSync(join(f.sandboxRoot, 'session', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      events
        .filter((record) => record.event.type !== 'turn.failed')
        .map((record) => record.sequence)
    ).toEqual(acceptedEvents);
    expect(new Set(acceptedEvents).size).toBe(acceptedEvents.length);
    expect(integration.finalStatuses.at(-1)?.body.status).toBe('interrupted');
  });

  it('stops lease heartbeats when authority is rejected during Integration drain', async () => {
    const clock = controlSchedulingTime();
    const integration = fakeIntegration();
    const fetch = integration.client.workerControlFetch;
    let heartbeatAttempts = 0;
    let authorityLost = false;
    const draining = observation();
    const release = observation();
    const cleared = observation();
    const clear = integration.client.clearTurnRouteTokens.bind(integration.client);
    vi.spyOn(integration.client, 'clearTurnRouteTokens').mockImplementation((id) => {
      clear(id);
      cleared.resolve();
    });
    vi.spyOn(integration.client, 'drainTurn').mockImplementation(async () => {
      draining.resolve();
      await release.promise;
      return 0;
    });
    vi.spyOn(integration.client, 'workerControlFetch').mockImplementation((async (url, init) => {
      if (url.endsWith('/heartbeat')) {
        heartbeatAttempts += 1;
        if (heartbeatAttempts === 3) authorityLost = true;
      }
      if (authorityLost)
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ code: 'worker_control_lease_not_live' }),
        };
      return fetch(url, init);
    }) satisfies WorkerControlFetch);
    const f = harnessFixture({ integration });
    try {
      await f.open('as-a');
      await f.start('as-a', 'turn-1');
      await draining.promise;
      await clock.advance(2000);
      expect(authorityLost).toBe(true);
      await cleared.promise;
      const stopped = heartbeatAttempts;
      await clock.advance(1100);
      expect(heartbeatAttempts).toBe(stopped);
      expect(integration.finalStatuses).toHaveLength(0);
      const events = readFileSync(join(f.sandboxRoot, 'session', 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.at(-1).event).toMatchObject({
        type: 'turn.failed',
        data: { status: 'failed' },
      });
    } finally {
      release.resolve();
      clock.restore();
      await f.settle('as-a');
    }
  });

  it.each([
    'accepted',
    'authority-lost',
  ] as const)('drains a delayed live event before failing-drain publication when delivery is %s', async (delivery) => {
    const clock = controlSchedulingTime();
    const integration = fakeIntegration();
    const fetch = integration.client.workerControlFetch;
    const draining = observation();
    const failDrain = observation();
    const eventEntered = observation();
    const releaseEvent = observation();
    const terminalWritten = observation();
    const cleared = observation();
    const acceptedEvents: number[] = [];
    const finalSequences: number[] = [];
    const publicationOrder: boolean[] = [];
    const heartbeats: number[] = [];
    let lastAcceptedAt = Date.now();
    let eventPending = false;
    const writeTerminal = WorkerTranscriptWriter.prototype.writeTerminalOutcome;
    const terminalSpy = vi
      .spyOn(WorkerTranscriptWriter.prototype, 'writeTerminalOutcome')
      .mockImplementation(async function (this: WorkerTranscriptWriter, input) {
        const record = await writeTerminal.call(this, input);
        terminalWritten.resolve();
        return record;
      });
    const clear = integration.client.clearTurnRouteTokens.bind(integration.client);
    vi.spyOn(integration.client, 'clearTurnRouteTokens').mockImplementation((id) => {
      clear(id);
      cleared.resolve();
    });
    vi.spyOn(integration.client, 'drainTurn').mockImplementation(async () => {
      draining.resolve();
      await failDrain.promise;
      throw new Error('Integration drain failed.');
    });
    vi.spyOn(integration.client, 'workerControlFetch').mockImplementation((async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/heartbeat')) {
        expect(Date.now() - lastAcceptedAt).toBeLessThan(2500);
        expect(body.sequence).toBe(heartbeats.length);
        heartbeats.push(body.sequence);
        lastAcceptedAt = Date.now();
      }
      if (url.endsWith('/events/append')) {
        if (body.record.event.data.status === 'running') {
          eventPending = true;
          eventEntered.resolve();
          await releaseEvent.promise;
          eventPending = false;
          if (delivery === 'authority-lost')
            return {
              ok: false,
              status: 403,
              text: async () => JSON.stringify({ code: 'worker_control_lease_not_live' }),
            };
        }
        acceptedEvents.push(body.record.sequence);
      }
      if (url.endsWith('/final-status')) {
        finalSequences.push(body.sequence);
        publicationOrder.push(
          !eventPending &&
            acceptedEvents.length === body.sequence &&
            acceptedEvents.every((sequence, index) => sequence === index)
        );
      }
      return fetch(url, init);
    }) satisfies WorkerControlFetch);
    const f = harnessFixture({ integration });
    try {
      await f.open('as-a');
      await f.start('as-a', 'turn-1');
      await draining.promise;
      await clock.advance(1000);
      await eventEntered.promise;
      failDrain.resolve();
      await terminalWritten.promise;
      await clock.advance(0);
      expect(eventPending).toBe(true);
      expect(finalSequences).toHaveLength(0);
      expect(integration.calls).not.toContain('clear:as-a');
      const before = heartbeats.length;
      await clock.advance(3200);
      expect(heartbeats.length).toBeGreaterThanOrEqual(before + 3);
      expect(finalSequences).toHaveLength(0);
    } finally {
      failDrain.resolve();
      releaseEvent.resolve();
      await cleared.promise;
      terminalSpy.mockRestore();
      clock.restore();
      await f.settle('as-a');
    }
    const terminal = readFileSync(join(f.sandboxRoot, 'session', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .at(-1);
    expect(terminal.event).toMatchObject({
      type: 'turn.failed',
      data: { status: 'failed', diagnostics: { native: 'Integration drain failed.' } },
    });
    expect(finalSequences).toEqual(delivery === 'accepted' ? [terminal.sequence] : []);
    expect(publicationOrder).toEqual(delivery === 'accepted' ? [true] : []);
  });

  it.each([
    'readiness',
    'heartbeat',
    'final-status',
  ] as const)('joins the losing %s request before clearing Turn routes', async (kind) => {
    const clock = controlSchedulingTime();
    const integration = fakeIntegration();
    const fetch = integration.client.workerControlFetch;
    const started = observation();
    const eventEntered = observation();
    const rejectEvent = observation();
    const requestEntered = observation();
    const requestAborted = observation();
    const releaseJoin = observation();
    const terminalWritten = observation();
    const cleared = observation();
    let heartbeatCalls = 0;
    let requestSettled = false;
    let terminalStarted = false;
    const recordHeartbeat = WorkerControlClient.prototype.recordHeartbeat;
    const recordFinalStatus = WorkerControlClient.prototype.recordFinalStatus;
    const heartbeatSpy = vi
      .spyOn(WorkerControlClient.prototype, 'recordHeartbeat')
      .mockImplementation(async function (this: WorkerControlClient, input, signal) {
        const joining =
          kind !== 'final-status' && ++heartbeatCalls === (kind === 'readiness' ? 1 : 3);
        try {
          return await recordHeartbeat.call(this, input, signal);
        } finally {
          if (joining) {
            requestAborted.resolve();
            await releaseJoin.promise;
            requestSettled = true;
          }
        }
      });
    const finalSpy = vi
      .spyOn(WorkerControlClient.prototype, 'recordFinalStatus')
      .mockImplementation(async function (this: WorkerControlClient, input, signal) {
        try {
          return await recordFinalStatus.call(this, input, signal);
        } finally {
          if (kind === 'final-status') {
            requestAborted.resolve();
            await releaseJoin.promise;
            requestSettled = true;
          }
        }
      });
    const writeTerminal = WorkerTranscriptWriter.prototype.writeTerminalOutcome;
    const terminalSpy = vi
      .spyOn(WorkerTranscriptWriter.prototype, 'writeTerminalOutcome')
      .mockImplementation(async function (this: WorkerTranscriptWriter, input) {
        terminalStarted = true;
        const record = await writeTerminal.call(this, input);
        terminalWritten.resolve();
        return record;
      });
    const clear = integration.client.clearTurnRouteTokens.bind(integration.client);
    vi.spyOn(integration.client, 'clearTurnRouteTokens').mockImplementation((id) => {
      clear(id);
      cleared.resolve();
    });
    vi.spyOn(integration.client, 'workerControlFetch').mockImplementation((async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.record?.event.data.status === 'turn.started') started.resolve();
      if (kind === 'heartbeat' && body.record?.event.data.status === 'running') {
        eventEntered.resolve();
        await rejectEvent.promise;
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ code: 'worker_control_lease_not_live' }),
        };
      }
      if (kind === 'final-status' && url.endsWith('/heartbeat') && body.sequence > 0)
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ code: 'worker_control_lease_not_live' }),
        };
      if (
        (kind === 'readiness' && url.endsWith('/heartbeat') && body.sequence === 0) ||
        (kind === 'heartbeat' && url.endsWith('/heartbeat') && body.sequence === 2) ||
        (kind === 'final-status' && url.endsWith('/final-status'))
      ) {
        requestEntered.resolve();
        return new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return fetch(url, init);
    }) satisfies WorkerControlFetch);
    const f = harnessFixture({ integration });
    if (kind === 'heartbeat') f.fake.script.push({ kind: 'hold' });
    let start: ReturnType<typeof f.start> | undefined;
    try {
      await f.open('as-a');
      start = f.start('as-a', 'turn-1');
      if (kind === 'readiness') {
        await requestEntered.promise;
        await clock.advance(10_000);
      } else if (kind === 'heartbeat') {
        await start;
        await started.promise;
        await clock.advance(1000);
        await eventEntered.promise;
        await clock.advance(1000);
        await requestEntered.promise;
        rejectEvent.resolve();
      } else {
        await start;
        await started.promise;
        await requestEntered.promise;
        await clock.advance(1000);
      }
      await requestAborted.promise;
      await clock.advance(0);
      if (kind === 'readiness') expect(terminalStarted).toBe(false);
      else {
        await terminalWritten.promise;
        await clock.advance(0);
      }
      expect(requestSettled).toBe(false);
      expect(integration.calls).not.toContain('clear:as-a');
    } finally {
      rejectEvent.resolve();
      releaseJoin.resolve();
      await cleared.promise;
      await start;
      heartbeatSpy.mockRestore();
      finalSpy.mockRestore();
      terminalSpy.mockRestore();
      clock.restore();
      await f.settle('as-a');
    }
    expect(requestSettled).toBe(true);
  });

  it('does not cancel live heartbeat append during the successful Turn barrier', async () => {
    const integration = fakeIntegration();
    const fetch = integration.client.workerControlFetch;
    const acceptedSequences: number[] = [];
    vi.spyOn(integration.client, 'workerControlFetch').mockImplementation((async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/events/append')) {
        const record = body.record;
        // Force a heartbeat written during drain to outlive the drain's completion.
        if (record.event.data.status === 'running') {
          await delay(300, undefined, { signal: init.signal });
        }
        acceptedSequences.push(record.sequence);
      }
      return fetch(url, init);
    }) satisfies WorkerControlFetch);
    vi.spyOn(integration.client, 'drainTurn').mockImplementation(async () => {
      // The periodic heartbeat starts at 1000 ms while the native Turn is already settled.
      await delay(1100);
      return 0;
    });
    const f = harnessFixture({ integration });
    await f.open('as-a');
    expect(await f.start('as-a', 'turn-1')).toMatchObject({ disposition: 'succeeded' });
    await f.settle('as-a');
    const events = readFileSync(join(f.sandboxRoot, 'session', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(integration.finalStatuses.at(-1)?.body.status).toBe('completed');
    expect(
      events
        .filter((record) => record.event.type !== 'turn.completed')
        .map((record) => record.sequence)
    ).toEqual(acceptedSequences);
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

  it.each([false, true])('handles rejected settlement with stop proof %s', async (stopProved) => {
    const f = harnessFixture();
    await f.open('as-a');
    f.fake.script.push({ kind: 'reject-settlement', stopProved });
    expect(await f.start('as-a', 'turn-1')).toMatchObject({ disposition: 'succeeded' });
    await vi.waitFor(() => expect(f.fake.residents[0]?.interrupts).toBe(1));
    // Interrupt invocation precedes asynchronous input cleanup; await the owned outcome.
    await vi.waitFor(async () => {
      expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
        body: stopProved
          ? { cleanupState: 'clean', state: 'open' }
          : { cleanupState: 'unknown', state: 'failed' },
      });
    });
    expect(
      f.integration.finalStatuses.find((status) => status.lineage.turnId === 'turn-1')
    ).toMatchObject({
      body: { status: 'failed', diagnostics: { native: 'native settlement unproved' } },
    });
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: stopProved ? 0 : 1, openSessions: 1 },
    });
    if (!stopProved) {
      expect(await f.start('as-a', 'turn-2')).toMatchObject({ disposition: 'refused' });
      expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
        body: { reasonCode: 'cleanup_required' },
        disposition: 'refused',
      });
    }
  });

  it.each([
    'completed',
    'failed',
  ] as const)('keeps native %s when interrupt races settlement', async (status) => {
    const f = harnessFixture({ adapter: fakeAdapter({ readyAtOpen: true }) });
    await f.open('as-a');
    f.fake.script.push({ kind: 'interrupt-race', status });
    expect(await f.start('as-a', 'turn-1')).toMatchObject({ disposition: 'succeeded' });
    expect(
      await f.send('turn.interrupt', {
        ...f.selector('as-a'),
        leaseId: 'lease-turn-1',
        purpose: 'interrupt',
        turnId: 'turn-1',
      })
    ).toMatchObject({ disposition: 'succeeded' });
    expect(f.integration.finalStatuses.at(-1)).toMatchObject({ body: { status } });
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

  it('keeps a pending binding non-reusable after a refused first native Turn', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    f.fake.script.push({ kind: 'reject' });
    expect(await f.start('as-a', 'turn-1')).toMatchObject({
      body: {
        reasonCode: 'dependency_failed',
        startupFailure: { reason: 'failed', stage: 'native_spawn' },
      },
      disposition: 'refused',
    });
    await f.settle('as-a');
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: {
        childState: 'running',
        cleanupState: 'clean',
        nativeHandleState: 'pending',
        nativeHandleDigest: null,
        state: 'open',
      },
    });
    expect(f.fake.residents[0]?.turns).toHaveLength(0);
    expect(
      f.integration.finalStatuses.find((status) => status.lineage.turnId === 'turn-1')
    ).toMatchObject({ body: { status: 'failed' } });
    expect(f.integration.calls).toContain('clear:as-a');
    expect(existsSync(f.packagePath('as-a'))).toBe(false);
    expect(await f.start('as-a', 'turn-2')).toMatchObject({
      body: { reasonCode: 'conflict' },
      disposition: 'refused',
    });
    expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
      body: { state: 'closed', privateState: 'absent' },
      disposition: 'succeeded',
    });
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: 0, openSessions: 0 },
    });
  });

  it('retains a bounded redacted first-Turn refusal cause in final-status diagnostics', async () => {
    const f = harnessFixture();
    const runtimeSecret = 'private-vault-value';
    await f.open('as-a', { runtimeEnvironment: { FIXTURE_SECRET: runtimeSecret } });
    const secrets = [
      runtimeSecret,
      credential('inference-as-a'),
      credential('capability-as-a'),
      credential('control-token-turn-1'),
      credential('inference-token-turn-1'),
      credential('capability-token-turn-1'),
    ];
    const prefix = `Codex setup rejected: ${secrets.join(' ')} Authorization: Bearer unknown-bearer api_key=unknown-key ghp_unknown`;
    f.fake.script.push({ kind: 'reject', error: new Error(`${prefix} ${'界'.repeat(20_000)}`) });
    const result = await f.start('as-a', 'turn-1', { runtimeEnvNames: ['FIXTURE_SECRET'] });
    expect(result).toMatchObject({
      body: {
        reasonCode: 'dependency_failed',
        startupFailure: { stage: 'native_spawn', reason: 'failed' },
      },
      disposition: 'refused',
    });
    expect(Object.keys(result.body).sort()).toEqual(['reasonCode', 'startupFailure']);
    expect(result.body.startupFailure).toEqual({ stage: 'native_spawn', reason: 'failed' });
    await f.settle('as-a');
    const final = f.integration.finalStatuses.find((status) => status.lineage.turnId === 'turn-1');
    expect(final).toMatchObject({
      body: {
        status: 'failed',
        diagnostics: { native: expect.stringContaining('Codex setup rejected:') },
      },
    });
    const diagnostic = final?.body.diagnostics?.native ?? '';
    expect(diagnostic.length).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    for (const secret of [...secrets, 'unknown-bearer', 'unknown-key', 'ghp_unknown']) {
      expect(JSON.stringify(final)).not.toContain(secret);
      expect(
        readFileSync(join(f.root, 'openkit', 'session', 'events.jsonl'), 'utf8')
      ).not.toContain(secret);
    }
    expect(diagnostic).toContain('[redacted]');
    await f.send('session.close', f.selector('as-a'));
  });

  it('keeps an established binding usable and resumable after a refused later native Turn', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    expect(await f.start('as-a', 'turn-established')).toMatchObject({ disposition: 'succeeded' });
    await f.settle('as-a');
    const digest = sha256('reference-as-a');
    const before = f.fake.residents[0]?.turns.length ?? 0;
    f.fake.script.push({ kind: 'reject' });
    expect(await f.start('as-a', 'turn-refused')).toMatchObject({
      body: {
        reasonCode: 'dependency_failed',
        startupFailure: { stage: 'native_spawn', reason: 'failed' },
      },
      disposition: 'refused',
    });
    await f.settle('as-a');
    expect(f.fake.residents[0]?.turns).toHaveLength(before);
    expect(f.fake.residents[0]?.interrupts).toBe(0);
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: {
        childState: 'running',
        cleanupState: 'clean',
        nativeHandleState: 'ready',
        nativeHandleDigest: digest,
        state: 'open',
      },
    });
    expect(f.integration.calls.at(-1)).toBe('clear:as-a');
    expect(existsSync(f.packagePath('as-a'))).toBe(false);
    expect(existsSync(f.contextRoot('as-a'))).toBe(false);
    expect(
      f.integration.finalStatuses.find((status) => status.lineage.turnId === 'turn-refused')
    ).toMatchObject({ body: { status: 'failed' } });
    // The next original-supply Turn requires free occupancy and an undrained Harness.
    expect(await f.start('as-a', 'turn-reused')).toMatchObject({ disposition: 'succeeded' });
    await f.settle('as-a');
    expect(
      f.integration.finalStatuses.find((status) => status.lineage.turnId === 'turn-reused')
    ).toMatchObject({ body: { status: 'completed' } });
    expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
      body: { state: 'closed', privateState: 'absent' },
      disposition: 'succeeded',
    });
    expect(readFileSync(f.referencePath('as-a'), 'utf8')).toBe('reference-as-a');
    expect(await f.open('as-b', { resume: { locator: 'as-a', digest } })).toMatchObject({
      disposition: 'succeeded',
      body: { nativeHandleState: 'ready', nativeHandleDigest: digest },
    });
    expect(f.fake.residents[1]?.input.resumeReference).toEqual(
      new Uint8Array(Buffer.from('reference-as-a'))
    );
    expect(await f.start('as-b', 'turn-successor')).toMatchObject({ disposition: 'succeeded' });
    await f.settle('as-b');
    expect(
      f.integration.finalStatuses.find((status) => status.lineage.turnId === 'turn-successor')
    ).toMatchObject({ body: { status: 'completed' } });
    expect(await f.send('session.inspect', f.selector('as-b'))).toMatchObject({
      body: { cleanupState: 'clean', nativeHandleState: 'ready', nativeHandleDigest: digest },
    });
    expect(readFileSync(f.referencePath('as-b'), 'utf8')).toBe('reference-as-a');
    expect(await f.send('session.close', f.selector('as-b'))).toMatchObject({
      disposition: 'succeeded',
    });
    expect(await f.send('harness.drain', {})).toMatchObject({
      body: { activeTurns: 0, openSessions: 0 },
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
      'SHELL',
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

  it('contains throwing fact getters at the shared recorder boundary', () => {
    const timeline = new TurnTimeline();
    expect(() =>
      timeline.record({
        get label(): 'host_exit' {
          throw new Error('fact getter fault');
        },
      })
    ).not.toThrow();
    timeline.record({ label: 'untrusted-native-value' as never });
    timeline.record({
      label: 'host_exit',
      code: 17,
      reason: 'untrusted-native-value' as never,
      signal: 'untrusted-native-value' as never,
    });
    const snapshot = timeline.seal();
    expect(snapshot).not.toContain('untrusted-native-value');
    expect(JSON.parse(snapshot).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'host_exit', code: 17 })])
    );
  });

  it.each([
    'completed',
    'failed',
  ] as const)('publishes %s terminal evidence despite a throwing timeline snapshot', async (status) => {
    const snapshot = vi.spyOn(TurnTimeline.prototype, 'seal').mockImplementation(() => {
      throw new Error('snapshot fault');
    });
    const f = harnessFixture();
    if (status === 'failed') f.fake.script.push({ kind: 'fail' });
    try {
      await f.open('as-a');
      await f.start('as-a', 'turn-1');
      await f.settle('as-a');
      expect(f.integration.finalStatuses).toHaveLength(1);
      expect(f.integration.finalStatuses[0]?.body.status).toBe(status);
      expect(f.integration.finalStatuses[0]?.body.diagnostics?.timeline).toBeUndefined();
      expect(snapshot).toHaveBeenCalledTimes(status === 'failed' ? 1 : 0);
      const events = readFileSync(join(f.sandboxRoot, 'session', 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.at(-1).event.data.status).toBe(status);
    } finally {
      snapshot.mockRestore();
    }
  });

  it('admits only primitive vocabulary values from changing fact getters', () => {
    const timeline = new TurnTimeline();
    let reads = 0;
    timeline.record({
      label: 'native_stop',
      get reason() {
        return (++reads <= 2 ? 'proved' : 'untrusted-native-value') as 'proved';
      },
    });
    timeline.record({
      label: 'host_exit',
      signal: {
        credential: 'untrusted-native-value',
        [Symbol.toPrimitive]: () => 'SIGKILL',
      } as never,
    });
    const snapshot = timeline.seal();
    expect(snapshot).not.toContain('untrusted-native-value');
    expect(
      JSON.parse(snapshot).entries.every(
        (entry: { reason?: string; signal?: unknown }) =>
          (entry.reason === undefined || entry.reason === 'proved') &&
          (entry.signal === undefined || typeof entry.signal === 'string')
      )
    ).toBe(true);
  });

  it('preserves JSON and publication when a numeric credential collides with an exit code', async () => {
    const f = harnessFixture();
    await f.open('as-a', { runtimeEnvironment: { VENDOR_TOKEN: '17' } });
    f.fake.script.push({ kind: 'hold' });
    await f.start('as-a', 'turn-1', { runtimeEnvNames: ['VENDOR_TOKEN'] });
    const resident = f.fake.residents[0]!;
    resident.turns[0]!.recordLifecycleFact!({ label: 'host_exit', code: 17 });
    resident.exit();
    await vi.waitFor(() => expect(f.integration.finalStatuses).toHaveLength(1));
    await f.settle('as-a');
    expect(f.integration.finalStatuses).toHaveLength(1);
    expect(f.integration.finalStatuses[0]?.body.status).toBe('failed');
    const timeline = JSON.parse(f.integration.finalStatuses[0]!.body.diagnostics!.timeline!);
    expect(timeline.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'host_exit', code: 17 })])
    );
  });

  it('publishes a bounded failure timeline after heartbeats and host exit, but none on success', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    await f.start('as-a', 'turn-1');
    await f.settle('as-a');
    expect(f.integration.finalStatuses[0]?.body.diagnostics?.timeline).toBeUndefined();
    const clock = controlSchedulingTime();
    const started = observation();
    const cleared = observation();
    const fetch = f.integration.client.workerControlFetch;
    const clear = f.integration.client.clearTurnRouteTokens.bind(f.integration.client);
    let heartbeats = 0;
    vi.spyOn(f.integration.client, 'workerControlFetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/heartbeat')) heartbeats += 1;
      if (url.endsWith('/final-status')) {
        // Publication is after sealing: even an observation here must stay outside the payload.
        f.fake.residents[0]!.turns[1]!.recordLifecycleFact?.({ label: 'interrupt' });
      }
      const result = await fetch(url, init);
      if (body.record?.event.data.status === 'turn.started') started.resolve();
      return result;
    });
    vi.spyOn(f.integration.client, 'clearTurnRouteTokens').mockImplementation((id) => {
      clear(id);
      cleared.resolve();
    });
    f.fake.script.push({ kind: 'hold' });
    try {
      await f.start('as-a', 'turn-2');
      await started.promise;
      const record = f.fake.residents[0]!.turns[1]!.recordLifecycleFact!;
      record({ label: 'native_event' });
      await clock.advance(180_000);
      expect(heartbeats).toBeGreaterThan(30);
      record({ label: 'native_event' });
      // Even a malformed native contribution cannot copy arbitrary values into the snapshot.
      record(
        Object.assign(
          {
            label: 'host_exit' as const,
            code: 17,
            signal: 'SIGKILL' as const,
            reason: credential('inference-as-a') as never,
          },
          { payload: credential('inference-as-a') }
        )
      );
      f.fake.residents[0]?.exit();
      await cleared.promise;
    } finally {
      clock.restore();
      await f.settle('as-a');
    }
    const diagnostics = f.integration.finalStatuses[1]?.body.diagnostics;
    expect(diagnostics?.timeline).toEqual(expect.any(String));
    const timeline = JSON.parse(diagnostics!.timeline!);
    expect(new Date(timeline.startedAt).toISOString()).toBe(timeline.startedAt);
    expect(timeline.dropped).toBeGreaterThan(0);
    expect(timeline.entries[0]).toMatchObject({ label: 'turn_start', ms: 0 });
    expect(timeline.entries.at(-1)).toMatchObject({ label: 'sealed' });
    expect(timeline.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'heartbeat', reason: 'accepted' }),
        expect.objectContaining({ label: 'host_exit', code: 17, signal: 'SIGKILL' }),
        expect.objectContaining({ label: 'native_last', count: 2 }),
        expect.objectContaining({ label: 'terminal', reason: 'failed' }),
        expect.objectContaining({ label: 'transcript', count: expect.any(Number) }),
      ])
    );
    const offsets = timeline.entries.map((entry: { label: string; ms: number }) => {
      expect(TURN_TIMELINE_LABELS).toContain(entry.label);
      return entry.ms;
    });
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(timeline.entries.some((entry: { label: string }) => entry.label === 'interrupt')).toBe(
      false
    );
    expect(
      timeline.entries.filter((entry: { label: string }) => entry.label === 'heartbeat')
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'attempt' }),
        expect.objectContaining({ reason: 'accepted', durationMs: expect.any(Number) }),
      ])
    );
    expect(
      Buffer.byteLength(JSON.stringify({ timeline: diagnostics!.timeline }))
    ).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThan(16 * 1024);
    expect(JSON.stringify(diagnostics)).not.toContain(credential('inference-as-a'));
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
    // Failed-binding admission rejects before AEP reads; writing new inputs would race the cleanup owner.
    expect(await f.send('turn.start', f.startBody('as-a', 'turn-3'))).toEqual(
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

  it('fences a rejected resident close even when the child is already absent', async () => {
    const f = harnessFixture();
    expect(await f.open('as-a')).toMatchObject({ disposition: 'succeeded' });
    const resident = f.fake.residents[0] as FakeResident;
    resident.closed = true;
    resident.closeFails = true;
    expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
      body: { reasonCode: 'cleanup_required' },
    });
    expect(await f.send('session.inspect', f.selector('as-a'))).toMatchObject({
      body: { cleanupState: 'unknown', state: 'failed' },
    });
    expect(await f.open('as-b', { threadId: 'thread-two' })).toMatchObject({
      body: { reasonCode: 'busy' },
    });
  });
});

describe('N4b immediate exceptional settlement', () => {
  it.each([
    false,
    true,
  ])('handles immediate settlement rejection with event writing held %s', async (holdEvent) => {
    let releaseEvent!: () => void;
    let eventPending = false;
    let rejectSettlement!: (error: Error) => void;
    const eventGate = new Promise<void>((resolve) => {
      releaseEvent = resolve;
    });
    const originalWrite = WorkerTranscriptWriter.prototype.writeAndAppendEvent;
    const write = vi
      .spyOn(WorkerTranscriptWriter.prototype, 'writeAndAppendEvent')
      .mockImplementation(async function (this: WorkerTranscriptWriter, event) {
        if (holdEvent && event.type === 'worker.ready') {
          eventPending = true;
          await eventGate;
        }
        return originalWrite.call(this, event);
      });
    const fake = fakeAdapter({ readyAtOpen: true });
    const originalOpen = fake.adapter.openSession;
    fake.adapter.openSession = async (input) => {
      const resident = await originalOpen(input);
      return {
        ...resident,
        async startTurn() {
          return {
            settled: holdEvent
              ? new Promise<WorkerAdapterResult>((_resolve, reject) => {
                  rejectSettlement = reject;
                })
              : Promise.reject<WorkerAdapterResult>(new Error('N4b immediate settlement loss')),
            async interrupt() {},
          };
        },
      };
    };
    const f = harnessFixture({ adapter: fake });
    await f.open('as-a');
    await f.start('as-a', 'turn-1');
    if (holdEvent) {
      await vi.waitFor(() => expect(eventPending).toBe(true));
      rejectSettlement(new Error('N4b settlement loss during event writing'));
      // Cross a process rejection-reporting turn while the writer is still pending.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.integration.finalStatuses).toHaveLength(0);
    }
    releaseEvent();
    write.mockRestore();
    await vi.waitFor(() =>
      expect(f.integration.finalStatuses.at(-1)).toMatchObject({ body: { status: 'failed' } })
    );
    await f.settle('as-a');
    expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
      disposition: 'succeeded',
    });
  });
});

/** Mutable JSON fixture at the shim's untrusted package boundary. */
interface RouteProbePackage {
  llm: {
    routes: Array<Record<string, unknown> & { endpoint: Record<string, unknown> }>;
    mode: string;
  };
}

describe('N4b independent route admission probes', () => {
  it.each([
    [
      'duplicate route identity',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].id = pkg.llm.routes[0].id;
      },
    ],
    [
      'empty route identity',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].id = '';
      },
    ],
    [
      'empty provider identity',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].providerInstanceId = '';
      },
    ],
    [
      'malformed upstream reference',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.upstream = { kind: 'nanocore-gateway', baseUrlRef: 12 };
      },
    ],
    [
      'empty upstream reference',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.upstream = { kind: 'nanocore-gateway', baseUrlRef: '' };
      },
    ],
    [
      'missing upstream',
      (pkg: RouteProbePackage) => {
        delete pkg.llm.routes[1].endpoint.upstream;
      },
    ],
    [
      'coerced upstream kind',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.upstream = { kind: ['nanocore-gateway'] };
      },
    ],
    [
      'wrong mode credential',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].credentialVisibility = 'environment';
      },
    ],
    [
      'wrong mode endpoint',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.kind = 'provider-compatible';
      },
    ],
    [
      'wrong mode upstream',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.upstream = { kind: 'direct-provider' };
      },
    ],
    [
      'forbidden worker URL',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.workerBaseUrl = 'https://example.invalid/v1';
      },
    ],
    [
      'non-gateway multiple routes',
      (pkg: RouteProbePackage) => {
        pkg.llm.mode = 'backend-local';
      },
    ],
    [
      'invalid context window',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 0,
          maxOutputTokens: 50,
          inputModalities: ['text'],
          reasoning: false,
        };
      },
    ],
    [
      'fractional context window',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 1.5,
          maxOutputTokens: 50,
          inputModalities: ['text'],
          reasoning: false,
        };
      },
    ],
    [
      'invalid output tokens',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 100,
          maxOutputTokens: -1,
          inputModalities: ['text'],
          reasoning: false,
        };
      },
    ],
    [
      'fractional output tokens',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 100,
          maxOutputTokens: 1.5,
          inputModalities: ['text'],
          reasoning: false,
        };
      },
    ],
    [
      'non-array modalities',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 100,
          maxOutputTokens: 50,
          inputModalities: 'text',
          reasoning: false,
        };
      },
    ],
    [
      'coerced modality',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 100,
          maxOutputTokens: 50,
          inputModalities: [['text']],
          reasoning: false,
        };
      },
    ],
    [
      'non-boolean reasoning',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 100,
          maxOutputTokens: 50,
          inputModalities: ['text'],
          reasoning: 'false',
        };
      },
    ],
    [
      'duplicate non-preferred model',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes.push({ ...pkg.llm.routes[1], id: 'duplicate-b' });
      },
    ],
    [
      'coerced endpoint kind',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.kind = ['openai-compatible'];
      },
    ],
    [
      'coerced credential visibility',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].credentialVisibility = ['placeholder'];
      },
    ],
    [
      'unknown model parameter modality',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 100,
          maxOutputTokens: 50,
          inputModalities: ['future'],
          reasoning: false,
        };
      },
    ],
    [
      'missing required model parameter',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].modelParameters = {
          contextWindow: 100,
          maxOutputTokens: 50,
          inputModalities: ['text'],
        };
      },
    ],
    [
      'empty model id',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].model = '';
      },
    ],
    [
      'malformed optional worker URL',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.workerBaseUrl = 12;
      },
    ],
    [
      'unknown endpoint kind',
      (pkg: RouteProbePackage) => {
        pkg.llm.routes[1].endpoint.kind = 'future';
      },
    ],
  ])('refuses %s before native start', async (_label, corrupt) => {
    const f = harnessFixture();
    await f.open('as-a');
    f.writePackage('as-a', 'turn-1', { allowedModels: ['model-a', 'model-b'] });
    const pkg = JSON.parse(readFileSync(f.packagePath('as-a'), 'utf8'));
    pkg.llm.routes.forEach((route: RouteProbePackage['llm']['routes'][number], i: number) => {
      route.id = `route-${i}`;
    });
    (corrupt as (pkg: RouteProbePackage) => void)(pkg);
    writeFileSync(f.packagePath('as-a'), JSON.stringify(pkg));
    const result = await f.send('turn.start', f.startBody('as-a', 'turn-1'));
    await f.settle('as-a');
    expect({
      disposition: result.disposition,
      nativeStarts: f.fake.residents[0]?.turns.length,
    }).toEqual({ disposition: 'refused', nativeStarts: 0 });
  });
  it.each([
    'gateway',
    'backend-local',
    'direct-external',
  ] as const)('admits the complete %s mode route', async (mode) => {
    const f = harnessFixture();
    await f.open('as-a');
    f.writePackage('as-a', 'turn-1');
    const pkg = JSON.parse(readFileSync(f.packagePath('as-a'), 'utf8'));
    pkg.llm.mode = mode;
    const route = pkg.llm.routes[0];
    const authority =
      mode === 'gateway'
        ? ['placeholder', 'openai-compatible', 'nanocore-gateway']
        : mode === 'backend-local'
          ? ['none', 'backend-local', 'backend-local']
          : ['environment', 'provider-compatible', 'direct-provider'];
    route.credentialVisibility = authority[0];
    route.endpoint = { kind: authority[1], upstream: { kind: authority[2] } };
    route.modelParameters = {
      contextWindow: 100,
      maxOutputTokens: 50,
      inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
      reasoning: true,
    };
    writeFileSync(f.packagePath('as-a'), JSON.stringify(pkg));
    expect(await f.send('turn.start', f.startBody('as-a', 'turn-1'))).toMatchObject({
      disposition: 'succeeded',
    });
    await f.settle('as-a');
    expect(f.fake.residents[0]?.turns[0]?.allowedLlmRoutes).toEqual([route]);
  });
  it.each([
    ['contextWindow', 9007199254740992, 'refused'],
    ['maxOutputTokens', 9007199254740992, 'refused'],
    ['contextWindow', 9007199254740991, 'succeeded'],
    ['maxOutputTokens', 9007199254740991, 'succeeded'],
  ] as const)('enforces safe-integer %s limit %s (%s)', async (field, limit, disposition) => {
    const f = harnessFixture();
    await f.open('as-a');
    f.writePackage('as-a', 'turn-1', { allowedModels: ['model-a', 'model-b'] });
    const pkg = JSON.parse(readFileSync(f.packagePath('as-a'), 'utf8'));
    const parameters = {
      contextWindow: 100,
      maxOutputTokens: 50,
      inputModalities: ['text'],
      reasoning: false,
      [field]: limit,
    };
    pkg.llm.routes[1].modelParameters = { ...parameters, futureOptional: 'ignored' };
    writeFileSync(f.packagePath('as-a'), JSON.stringify(pkg));
    const result = await f.send('turn.start', f.startBody('as-a', 'turn-1'));
    await f.settle('as-a');
    expect({
      disposition: result.disposition,
      nativeStarts: f.fake.residents[0]?.turns.length,
    }).toEqual({ disposition, nativeStarts: disposition === 'refused' ? 0 : 1 });
    if (disposition === 'succeeded') {
      expect(f.fake.residents[0]?.turns[0]?.allowedLlmRoutes[1]?.modelParameters).toEqual(
        parameters
      );
    }
  });

  it('omits an unknown additive route field from the adapter input', async () => {
    const f = harnessFixture();
    await f.open('as-a');
    f.writePackage('as-a', 'turn-1', { allowedModels: ['model-a', 'model-b'] });
    const pkg = JSON.parse(readFileSync(f.packagePath('as-a'), 'utf8'));
    pkg.llm.routes[1].futureOptional = 'ignored';
    pkg.llm.routes[1].endpoint.futureOptional = 'ignored';
    pkg.llm.routes[1].endpoint.upstream = {
      kind: 'nanocore-gateway',
      baseUrlRef: 'provider-ref',
      futureOptional: 'ignored',
    };
    pkg.llm.routes[1].modelParameters = {
      contextWindow: 100,
      maxOutputTokens: 50,
      inputModalities: ['text'],
      reasoning: false,
      futureOptional: 'ignored',
    };
    writeFileSync(f.packagePath('as-a'), JSON.stringify(pkg));
    expect(await f.send('turn.start', f.startBody('as-a', 'turn-1'))).toMatchObject({
      disposition: 'succeeded',
    });
    await f.settle('as-a');
    expect(f.fake.residents[0]?.turns[0]?.allowedLlmRoutes[1]).toEqual({
      id: 'worker-inference-1',
      model: 'model-b',
      providerInstanceId: 'provider-a',
      credentialVisibility: 'placeholder',
      endpoint: {
        kind: 'openai-compatible',
        upstream: { kind: 'nanocore-gateway', baseUrlRef: 'provider-ref' },
      },
      modelParameters: {
        contextWindow: 100,
        maxOutputTokens: 50,
        inputModalities: ['text'],
        reasoning: false,
      },
    });
  });
});

describe('N4c local input cleanup proof', () => {
  it.each([
    'reject',
    'complete',
  ] as const)('retains occupancy and fences siblings after %s with failed input cleanup', async (outcome) => {
    const f = harnessFixture({ adapter: fakeAdapter({ readyAtOpen: true }) });
    await f.open('as-a');
    await f.open('as-b', { threadId: 'thread-two' });
    f.fake.script.push({ kind: outcome });
    f.writePackage('as-a', 'turn-cleanup');
    const inputRoot = join(f.sandboxRoot, 'sessions', 'as-a');
    const mode = statSync(inputRoot).mode & 0o777;
    let result: Awaited<ReturnType<typeof f.send>>;
    let inspection: Awaited<ReturnType<typeof f.send>>;
    try {
      // The slots stay writable internally, but their parent cannot unlink them.
      chmodSync(inputRoot, 0o500);
      result = await f.send('turn.start', f.startBody('as-a', 'turn-cleanup'));
      await f.settle('as-a');
      inspection = await f.send('session.inspect', f.selector('as-a'));
    } finally {
      chmodSync(inputRoot, mode);
    }
    f.writePackage('as-b', 'turn-sibling', { threadId: 'thread-two' });
    const sibling = await f.send('turn.start', {
      ...f.startBody('as-b', 'turn-sibling'),
      threadId: 'thread-two',
    });
    await f.settle('as-b');
    const newSession = await f.open('as-c', { threadId: 'thread-three' });
    const drain = await f.send('harness.drain', {});
    expect(result).toMatchObject(
      outcome === 'reject'
        ? {
            disposition: 'refused',
            body: {
              reasonCode: 'dependency_failed',
              startupFailure: { stage: 'native_spawn', reason: 'failed' },
            },
          }
        : { disposition: 'succeeded' }
    );
    expect(f.fake.residents[0]?.turns).toHaveLength(outcome === 'reject' ? 0 : 1);
    expect({
      inspection,
      sibling,
      activeTurns: drain.body.activeTurns,
      nativeSiblingStarts: f.fake.residents[1]?.turns.length,
    }).toMatchObject({
      inspection: {
        body: {
          state: 'failed',
          cleanupState: 'unknown',
          childState: 'running',
          nativeHandleState: 'ready',
          nativeHandleDigest: sha256('reference-as-a'),
        },
      },
      sibling: { disposition: 'refused', body: { reasonCode: 'busy' } },
      activeTurns: 1,
      nativeSiblingStarts: 0,
    });
    expect(
      f.integration.finalStatuses.find((status) => status.lineage.turnId === 'turn-cleanup')
    ).toMatchObject({ body: { status: outcome === 'reject' ? 'failed' : 'completed' } });
    expect(newSession).toMatchObject({ disposition: 'refused', body: { reasonCode: 'busy' } });
    expect(f.integration.calls).toContain('clear:as-a');
    expect(await f.send('session.close', f.selector('as-a'))).toMatchObject({
      disposition: 'refused',
      body: { reasonCode: 'cleanup_required' },
    });
  });
});

describe('shared lifecycle evidence and deadlines', () => {
  it('preserves separate native proofs in the Turn result without inferring close from exit', async () => {
    const f = harnessFixture();
    f.writePackage('as-evidence', 'turn-evidence');
    const nativeEvidence = {
      nativeTerminal: true,
      processExited: true,
      pipesDrained: false,
      persistencePreservingClose: false,
    };
    const result = await runResidentTurn({
      adapterId: ADAPTER,
      credentialValues: [],
      environment: {},
      integration: f.integration.client,
      lineage: {
        agentSessionId: 'as-evidence',
        packageSnapshotId: 'package-turn-evidence',
        threadId: 'thread-one',
        turnId: 'turn-evidence',
        workspaceId: 'workspace-one',
      },
      onStarted() {},
      packagePath: f.packagePath('as-evidence'),
      resident: {
        exited: new Promise(() => undefined),
        childState: () => 'absent',
        close: async () => {
          throw new Error('Retaining close is unproved.');
        },
        nativeHandle: async () => ({ state: 'unknown' }),
        startTurn: async () => ({
          interrupt: async () => undefined,
          settled: Promise.resolve({
            assistantText: null,
            status: 'failed',
            stopReason: 'native-failure',
            nativeEvidence,
          }),
        }),
      },
      runtimeEnvironmentNames: new Set(),
      nativeEnvironment: null,
      sessionDir: join(f.sandboxRoot, 'session'),
      signal: new AbortController().signal,
      tokens: {
        controlToken: 'control',
        inferenceToken: 'inference',
        capabilityToken: 'capability',
      },
      turnDirectory: join(f.privateRoot, 'turn-evidence'),
    });
    expect(result).toEqual({ status: 'failed', nativeEvidence });
    expect(f.integration.finalStatuses.at(-1)?.body).not.toHaveProperty('nativeEvidence');
    expect(f.integration.finalStatuses.at(-1)?.body.diagnostics).not.toHaveProperty(
      'nativeEvidence'
    );
  });

  it('keeps binding evidence local while inspection obeys its wire schema', async () => {
    const f = harnessFixture({ adapter: fakeAdapter({ closeFails: true }) });
    const nativeEvidence = {
      processExited: true,
      pipesDrained: true,
      persistencePreservingClose: false,
    };
    const open = f.fake.adapter.openSession;
    vi.spyOn(f.fake.adapter, 'openSession').mockImplementation(async (input) => ({
      ...(await open(input)),
      childState: () => 'absent',
      nativeEvidence: () => nativeEvidence,
    }));
    await f.open('as-binding-evidence');
    const inspection = await f.send('session.inspect', f.selector('as-binding-evidence'));
    expect(inspection).toMatchObject({
      body: { childState: 'absent' },
    });
    expect(HarnessSuccessBodySchemas['session.inspect'].safeParse(inspection.body).success).toBe(
      true
    );
    expect(inspection.body).not.toHaveProperty('nativeEvidence');
    expect(await f.send('session.close', f.selector('as-binding-evidence'))).toMatchObject({
      disposition: 'refused',
      body: { reasonCode: 'cleanup_required' },
    });
    const failedInspection = await f.send('session.inspect', f.selector('as-binding-evidence'));
    expect(failedInspection).toMatchObject({
      body: { cleanupState: 'unknown', state: 'failed' },
    });
    expect(
      HarnessSuccessBodySchemas['session.inspect'].safeParse(failedInspection.body).success
    ).toBe(true);
    expect(failedInspection.body).not.toHaveProperty('nativeEvidence');
  });

  it('passes one stop deadline with a reserved cleanup tail to the adapter', async () => {
    const f = harnessFixture();
    const entered = observation();
    let deadline: import('./lifecycle-deadline.js').LifecycleDeadline | undefined;
    let finish!: () => void;
    const open = f.fake.adapter.openSession;
    vi.spyOn(f.fake.adapter, 'openSession').mockImplementation(async (input) => {
      const binding = await open(input);
      return {
        ...binding,
        startTurn: async (input) => {
          const turn = await binding.startTurn(input);
          return {
            ...turn,
            interrupt: async (enclosing) => {
              deadline = enclosing;
              entered.resolve();
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
              await turn.interrupt(enclosing);
            },
          };
        },
      };
    });
    await f.open('as-stop');
    f.fake.script.push({ kind: 'hold' });
    const clock = controlSchedulingTime();
    let interruption: ReturnType<typeof f.send> | undefined;
    try {
      await f.start('as-stop', 'turn-stop');
      interruption = f.send('turn.interrupt', {
        ...f.selector('as-stop'),
        leaseId: 'lease-turn-stop',
        purpose: 'interrupt',
        turnId: 'turn-stop',
      });
      await entered.promise;
      expect(deadline).toBeDefined();
      expect(deadline!.remainingMs()).toBe(10_000);
      expect(deadline!.workRemainingMs()).toBe(6_000);
      await clock.advance(6_000);
      expect(deadline!.workRemainingMs()).toBe(0);
      expect(deadline!.remainingMs()).toBe(4_000);
      await clock.advance(4_000);
      await interruption;
      expect(await f.send('session.inspect', f.selector('as-stop'))).toMatchObject({
        body: { cleanupState: 'unknown', state: 'failed' },
      });
      expect(deadline!.remainingMs()).toBe(0);
    } finally {
      finish?.();
      await clock.advance(10_000);
      if (interruption) await interruption;
      clock.restore();
    }
  });

  it('caps worker-control recovery requests by the same remaining outage budget', async () => {
    const clock = controlSchedulingTime();
    const failed = observation();
    const held = observation();
    const controller = new AbortController();
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let requests = 0;
    const client = new WorkerControlClient({
      baseUrl: '/worker-control',
      lineage: {
        agentSessionId: 'as-tail',
        packageSnapshotId: 'package-tail',
        requestId: null,
        threadId: 'thread-one',
        turnId: 'turn-tail',
        workspaceId: 'workspace-one',
      },
      token: 'control',
      fetch: async (_url, init) => {
        requests += 1;
        if (requests === 1) {
          failed.resolve();
          return { ok: false, status: 503, text: async () => '{}' };
        }
        held.resolve();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    client.enablePostLaunchRecovery();
    let finished = false;
    const outcome = client
      .recordHeartbeat({ status: 'running' }, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        finished = true;
      });
    try {
      await failed.promise;
      // Let the retry owner record its first failure at the original clock anchor.
      await clock.advance(0);
      time = 299_750;
      await clock.advance(250);
      await held.promise;
      time = 300_000;
      await clock.advance(250);
      expect(finished).toBe(true);
      expect(requests).toBe(2);
    } finally {
      controller.abort(new Error('fixture-complete'));
      await outcome;
      vi.restoreAllMocks();
      clock.restore();
    }
  });

  it('caps each private request by the enclosing outage deadline instead of restarting its timeout', async () => {
    const clock = controlSchedulingTime();
    const controller = new AbortController();
    const firstRequest = observation();
    const secondRequest = observation();
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let requests = 0;
    loopFixture.client = {
      ready: Promise.resolve(),
      close: async () => undefined,
      harnessControlFetch: async (_path: string, init: { signal: AbortSignal }) => {
        requests += 1;
        if (requests === 1) {
          time = 299_500;
          firstRequest.resolve();
          return { ok: false, status: 503, text: async () => '' };
        }
        time = 299_750;
        secondRequest.resolve();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      },
    } as unknown as SandboxIntegrationClient;
    let finished = false;
    const run = runWorkerHarness({ signal: controller.signal });
    const outcome = run
      .catch(() => undefined)
      .finally(() => {
        finished = true;
      });
    try {
      await firstRequest.promise;
      // Controlled elapsed time leaves just one retry interval and a partial request window.
      time = 299_750;
      await clock.advance(250);
      await secondRequest.promise;
      expect(performance.now()).toBe(299_750);
      time = 300_000;
      await clock.advance(250);
      expect(finished).toBe(true);
      expect(requests).toBe(2);
    } finally {
      controller.abort(new Error('fixture-complete'));
      await outcome;
      vi.restoreAllMocks();
      clock.restore();
    }
  });
});

describe('session-static public native environment', () => {
  // Exact child bootstrap names from pinned OpenShell child_env.rs; use distinct CA paths.
  const managedBootstrap = {
    ALL_PROXY: 'http://10.200.0.1:3128',
    HTTP_PROXY: 'http://10.200.0.1:3128',
    HTTPS_PROXY: 'http://10.200.0.1:3128',
    NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: 'http://10.200.0.1:3128',
    https_proxy: 'http://10.200.0.1:3128',
    no_proxy: '127.0.0.1,localhost,::1',
    grpc_proxy: 'http://10.200.0.1:3128',
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: '/etc/openshell-tls/openshell-ca.pem',
    DENO_CERT: '/etc/openshell-tls/openshell-ca.pem',
    SSL_CERT_FILE: '/etc/openshell-tls/ca-bundle.pem',
    REQUESTS_CA_BUNDLE: '/etc/openshell-tls/ca-bundle.pem',
    CURL_CA_BUNDLE: '/etc/openshell-tls/ca-bundle.pem',
    GIT_SSL_CAINFO: '/etc/openshell-tls/ca-bundle.pem',
  };

  it.each([
    {},
    { HELLO_NATIVE: 'hello', EMPTY_NATIVE: '' },
  ])('preserves every managed proxy/TLS bootstrap value with public map %j', async (nativeEnvironment) => {
    const f = harnessFixture({
      environment: { ...managedBootstrap, UNRELATED_HOST_SETTING: 'host-only' },
    });
    expect(await f.open('as-bootstrap', { nativeEnvironment })).toMatchObject({
      disposition: 'succeeded',
    });
    const environment = f.fake.residents[0]!.input.environment;
    for (const [name, value] of Object.entries(managedBootstrap))
      expect.soft(environment[name], name).toBe(value);
    expect(environment).toMatchObject(nativeEnvironment);
    expect(environment).not.toHaveProperty('UNRELATED_HOST_SETTING');
  });

  it.each(
    Object.keys(managedBootstrap)
  )('refuses public and runtime-env override of managed bootstrap %s before child creation', async (name) => {
    for (const extra of [
      { nativeEnvironment: { [name]: 'untrusted' } },
      { runtimeEnvironment: { [name]: 'untrusted' } },
    ]) {
      const f = harnessFixture({ environment: managedBootstrap });
      expect(await f.open('as-bootstrap-conflict', extra)).toMatchObject({
        disposition: 'refused',
        body: { reasonCode: 'unsupported' },
      });
      expect(f.fake.residents).toHaveLength(0);
      expect(f.integration.loopbacks.size).toBe(0);
    }
  });

  it.each([
    { nativeEnvironment: { HOME: '/user' } },
    { nativeEnvironment: { OPENKIT_ROUTE: 'user' } },
    { nativeEnvironment: { SETTING: 'public' }, runtimeEnvironment: { SETTING: 'credential' } },
  ])('refuses protected or credential-colliding public delivery before child creation: %j', async (extra) => {
    const f = harnessFixture();
    expect(await f.open('as-public', extra)).toMatchObject({ disposition: 'refused' });
    expect(f.fake.residents).toHaveLength(0);
  });

  it.each([
    'missing',
    'different',
    'extra',
    'omitted-package',
  ] as const)('refuses %s session/AEP public delivery before native work', async (variant) => {
    const f = harnessFixture();
    await f.open(
      'as-public',
      variant === 'missing' ? {} : { nativeEnvironment: { SETTING: 'session' } }
    );
    f.writePackage('as-public', 'turn-public');
    const pkg = JSON.parse(readFileSync(f.packagePath('as-public'), 'utf8'));
    if (variant !== 'omitted-package')
      pkg.runtime.environment = {
        imageDigest: `sha256:${'a'.repeat(64)}`,
        defaultsDigest: `sha256:${'b'.repeat(64)}`,
        values:
          variant === 'different'
            ? { SETTING: 'changed' }
            : variant === 'extra'
              ? { SETTING: 'session', EXTRA: '' }
              : { SETTING: 'session' },
      };
    writeFileSync(f.packagePath('as-public'), JSON.stringify(pkg));
    expect(await f.send('turn.start', f.startBody('as-public', 'turn-public'))).toMatchObject({
      disposition: 'refused',
    });
    expect(f.fake.residents[0]?.turns).toHaveLength(0);
  });

  it('checks exact values on every Turn and never mutates an already resident map', async () => {
    const f = harnessFixture();
    await f.open('as-public', { nativeEnvironment: { SETTING: 'session', EMPTY: '' } });
    f.writePackage('as-public', 'turn-public');
    const pkg = JSON.parse(readFileSync(f.packagePath('as-public'), 'utf8'));
    pkg.runtime.environment = {
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: `sha256:${'b'.repeat(64)}`,
      values: { EMPTY: '', SETTING: 'session' },
      inertMetadata: true,
    };
    writeFileSync(f.packagePath('as-public'), JSON.stringify(pkg));
    expect(await f.send('turn.start', f.startBody('as-public', 'turn-public'))).toMatchObject({
      disposition: 'succeeded',
    });
    await f.settle('as-public');
    f.writePackage('as-public', 'turn-changed');
    const changed = JSON.parse(readFileSync(f.packagePath('as-public'), 'utf8'));
    changed.runtime.environment = {
      ...pkg.runtime.environment,
      values: { SETTING: 'changed', EMPTY: '' },
    };
    writeFileSync(f.packagePath('as-public'), JSON.stringify(changed));
    expect(await f.send('turn.start', f.startBody('as-public', 'turn-changed'))).toMatchObject({
      disposition: 'refused',
    });
    expect(f.fake.residents[0]?.input.environment.SETTING).toBe('session');
    expect(f.fake.residents[0]?.turns).toHaveLength(1);
  });

  it('applies benign and empty values only to the addressed child', async () => {
    const f = harnessFixture();
    const opened = await f.open('as-public', {
      nativeEnvironment: { HELLO_NATIVE: 'hello', EMPTY_NATIVE: '' },
    });
    expect(opened.disposition).toBe('succeeded');
    await f.open('as-sibling', { threadId: 'thread-sibling' });
    expect(f.fake.residents[0]?.input.environment.HELLO_NATIVE).toBe('hello');
    expect(f.fake.residents[0]?.input.environment.EMPTY_NATIVE).toBe('');
    expect(f.fake.residents[1]?.input.environment.HELLO_NATIVE).toBeUndefined();
    expect(process.env.HELLO_NATIVE).toBeUndefined();
  });
});

it('projects canonical effort and empty advertised levels while parsing a per-Turn package', async () => {
  const f = harnessFixture();
  await f.open('as-a');
  f.writePackage('as-a', 'turn-1');
  const pkg = JSON.parse(readFileSync(f.packagePath('as-a'), 'utf8'));
  pkg.llm.reasoningEffort = 'none';
  pkg.llm.routes[0].reasoningEffortLevels = [];
  writeFileSync(f.packagePath('as-a'), JSON.stringify(pkg));
  expect(await f.send('turn.start', f.startBody('as-a', 'turn-1'))).toMatchObject({
    disposition: 'succeeded',
  });
  await f.settle('as-a');
  expect(f.fake.residents[0]?.turns).toHaveLength(1);
  expect(f.fake.residents[0]?.turns[0]?.reasoningEffort).toBe('none');
  expect(f.fake.residents[0]?.turns[0]?.allowedLlmRoutes[0]?.reasoningEffortLevels).toEqual([]);
});

it.each([
  'turn',
  'route',
])('rejects an unknown %s effort before native Turn effects', async (where) => {
  const f = harnessFixture();
  await f.open('as-a');
  f.writePackage('as-a', 'turn-1');
  const pkg = JSON.parse(readFileSync(f.packagePath('as-a'), 'utf8'));
  if (where === 'turn') pkg.llm.reasoningEffort = 'ultra';
  else pkg.llm.routes[0].reasoningEffortLevels = ['ultra'];
  writeFileSync(f.packagePath('as-a'), JSON.stringify(pkg));
  await f.send('turn.start', f.startBody('as-a', 'turn-1'));
  await f.settle('as-a');
  expect(f.fake.residents[0]?.turns).toHaveLength(0);
});
