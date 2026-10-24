import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceIdForOwner } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthVariables } from '../auth/middleware.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import {
  readWorkerRawOutput,
  WorkerRawOutputAuthorityError,
  WorkerRawOutputBudgetExceededError,
} from '../runtime/worker-raw-output.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { registerWorkerInferenceRoutes } from './gateway-routes.js';
import { OpenAICompatibleProviderError } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import {
  type LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from './provider-dispatcher.js';

// Authorization is outside this diagnostic test. Token parsing, AEP admission, dispatch,
// stream preparation, error projection and durable closeout use their production owners.
vi.mock('../auth/operation-authorizer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/operation-authorizer.js')>()),
  currentWorkerLineageWorkspaceAuthority: () => true,
}));

const streamWriter = vi.hoisted(() => ({
  commits: undefined as SharedArrayBuffer | undefined,
  holdReply: undefined as ((value: unknown, release: () => void) => boolean) | undefined,
}));

// Count actual outer COMMITs that change raw proof; attribution commits are not raw batches.
// Delay actual replies independently; never manufacture a writer result.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (streamWriter.commits === undefined) {
          super(filename, options);
          return;
        }
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.r1856DatabaseModule);
          const exec = Database.prototype.exec;
          const committedRawProof = new WeakMap();
          const rawProof = (database) => {
            if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'capability_calls'").get())
              return '[]';
            return JSON.stringify(database
              .prepare('SELECT call_id, extensions_json FROM capability_calls ORDER BY call_id')
              .all()
              .flatMap((row) => {
                const proof = JSON.parse(row.extensions_json ?? '{}')?.['openkit.worker/rawOutput'];
                return proof === undefined ? [] : [[row.call_id, proof]];
              }));
          };
          Database.prototype.exec = function(sql) {
            const result = exec.call(this, sql);
            if (/^COMMIT$/i.test(sql)) {
              const proof = rawProof(this);
              const previous = committedRawProof.get(this) ?? '[]';
              committedRawProof.set(this, proof);
              if (proof !== previous && Atomics.load(workerData.r1856Commits, 0) === 1)
                Atomics.add(workerData.r1856Commits, 1, 1);
            }
            return result;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            r1856DatabaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            r1856Commits: new Int32Array(streamWriter.commits),
          },
        });
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          super.emit(event, ...args);
        };
        if (event === 'message' && streamWriter.holdReply?.(args[0], release)) return true;
        return super.emit(event, ...args);
      }
    },
  };
});

const roots: string[] = [];
const databases: CoreDb[] = [];
afterEach(async () => {
  streamWriter.holdReply = undefined;
  streamWriter.commits = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the real worker route with a controlled Provider boundary and real capability storage. */
async function fixture(
  configured = true,
  requestKind?: 'turn' | 'prewarm' | 'compaction',
  nativeStop = true,
  rawSource: 'complete' | 'controlled' = 'complete'
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'worker-inference-diagnostics-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Diagnostics');
  const thread = await store.createThread(workspace.id, 'Diagnostics');
  const turn = await store.createTurn(workspace.id, thread.id, 'Request', {
    kind: 'user',
    id: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const environmentPackage = resolveAgentEnvironmentPackage({
    agentSetup: createTestAgentSetup({
      logicalModelId: 'worker-model',
      privateRoute: { providerProfileId: 'provider', providerModel: 'native-model' },
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }),
    agentSessionId: testEntityId('as', 'as_diagnostics'),
    backend: { kind: 'openshell' },
    captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
    createdAt: new Date().toISOString(),
    requestId: 'req_diagnostics',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    turn,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  const gateway = new WorkerControlGateway({ resolveTokenBinding: () => ({ status: 'accepted' }) });
  const token = 'B'.repeat(43);
  gateway.registerSession(environmentPackage, {
    sandboxBindingRef: 'diagnostics-binding',
    workerCapabilityToken: 'C'.repeat(43),
    workerControlToken: 'A'.repeat(43),
    workerInferenceToken: token,
  });
  const providerRegistry = new ProviderRegistry([
    {
      id: 'provider',
      displayName: 'Provider',
      kind: 'local',
      vendor: 'ollama',
      models: ['native-model'],
      modelMetadata: { 'native-model': { limit: { context: 400_000, output: 32_000 } } },
    },
  ]);
  const dispatch = vi.fn();
  const resolveGatewayProvider = vi.fn(
    (): ResolvedLLMProviderConfig => ({
      id: 'provider',
      displayName: 'Provider',
      backend: 'pi-ai',
      adapterId: 'ollama',
      apiKey: null,
      baseUrl: null,
      models: ['native-model'],
      requiresApiKey: false,
      gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
    })
  );
  // Existing cases know the complete source before delivery. Fault cases own source lifetime.
  const observedDispatch = (...args: unknown[]) => {
    if (rawSource !== 'complete') return dispatch(...args);
    const boundary = (args[2] as LLMGatewayDispatchContext | undefined)?.transport?.rawOutput;
    const settle = boundary?.sourceStarted();
    boundary?.sourceEvent();
    settle?.();
    return Promise.resolve(dispatch(...args)).then((result) => {
      if (!(result instanceof ReadableStream)) return result;
      return result.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            // Bind the original encoded chunk at delivery; the real Gateway awaits its ACK.
            const bind = boundary?.coverAcknowledgement?.();
            bind?.(chunk);
            controller.enqueue(chunk);
          },
        })
      );
    });
  };
  const onRawOutputStop = vi.fn(async () => {});
  const app = new Hono<{ Variables: AuthVariables }>();
  registerWorkerInferenceRoutes({
    app,
    coreDb,
    workerControlGateway: gateway,
    ...(nativeStop ? { onRawOutputStop } : {}),
    llmGatewayDispatcher: {
      createResponses: observedDispatch,
      createResponsesStream: observedDispatch,
      createChatCompletionStream: observedDispatch,
    } as unknown as LLMGatewayProviderDispatcher,
    resolveGatewayProvider,
    runtimeConfig: () =>
      ({
        providerRegistry: configured ? providerRegistry : new ProviderRegistry([]),
        gatewayConfig: {
          schemaVersion: 1,
          enabled: true,
          defaultLogicalModelId: 'worker-model',
          requiredFeatures: [],
          logicalModels: [
            {
              id: 'worker-model',
              displayName: 'Worker',
              routing: { autoFailover: true },
              contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
              routes: [
                { id: 'primary', providerProfileId: 'provider', providerModel: 'native-model' },
              ],
            },
          ],
        },
      }) as RuntimeConfigSnapshot,
  });
  return {
    dispatch,
    resolveGatewayProvider,
    environmentPackage,
    onRawOutputStop,
    turn,
    openWorkspace: () => openWorkspaceDb(dataRoot, workspace.id),
    ledgerCalls: () => {
      const db = openWorkspaceDb(dataRoot, workspace.id);
      try {
        return listWorkspaceCapabilityCalls(db, workspace.id);
      } finally {
        db.sqlite.close();
      }
    },
    rawOutput: () => {
      const db = openWorkspaceDb(dataRoot, workspace.id);
      try {
        return readWorkerRawOutput(db, environmentPackage.scope);
      } finally {
        db.sqlite.close();
      }
    },
    post: (stream: boolean, endpoint = 'responses') =>
      app.request(`/api/worker-inference/v1/${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'worker-model',
          stream,
          ...(requestKind
            ? {
                openkit_runtime_hint: {
                  runtimeFamily: 'codex',
                  nativeSessionId: 'native-session',
                  nativeThreadId: 'native-thread',
                  requestKind,
                },
              }
            : {}),
          ...(endpoint === 'responses'
            ? { input: 'prompt-canary' }
            : { messages: [{ role: 'user', content: 'prompt-canary' }] }),
        }),
      }),
    calls: () => {
      const db = openWorkspaceDb(dataRoot, workspace.id);
      try {
        return db.sqlite
          .prepare('SELECT call_id, request_id, status, error_code FROM capability_calls')
          .all();
      } finally {
        db.sqlite.close();
      }
    },
  };
}

/** Supplies real SSE output before an injected reader failure, without a Provider effect. */
function failedStream(error: unknown, endpoint = 'responses') {
  let emitted = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emitted) {
        emitted = true;
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(
              endpoint === 'responses'
                ? { type: 'response.output_text.delta', delta: 'output-canary' }
                : { choices: [{ delta: { content: 'output-canary' } }] }
            )}\n\n`
          )
        );
      } else controller.error(error);
    },
  });
}

it('withholds a native stream delta until its raw position commits after Workspace contention', async () => {
  const f = await fixture(true, undefined, true, 'controlled');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient() });
  f.resolveGatewayProvider.mockReturnValue({
    id: 'provider',
    displayName: 'Provider',
    adapterId: 'contention-fixture',
    apiKey: 'synthetic',
    baseUrl: 'https://provider.invalid/v1',
    models: ['native-model'],
    requiresApiKey: true,
    gatewayCapabilities: { responses: 'bridged', chatCompletions: 'native' },
    modelMetadata: { 'native-model': { limit: { context: 400_000, output: 32_000 } } },
  });
  let inferenceSignal: AbortSignal | undefined;
  f.dispatch.mockImplementation((provider, request, context: LLMGatewayDispatchContext) => {
    inferenceSignal = context.transport?.signal;
    return dispatcher.createChatCompletionStream(provider, request, context);
  });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          source = controller;
        },
        cancel: () => {
          sourceCancelled = true;
        },
      }),
      {
        headers: { 'content-type': 'text/event-stream' },
      }
    )
  );
  const emit = (content: string, finishReason: string | null = null) =>
    source.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: 'chat_contention',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'native-model',
          choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
        })}\n\n`
      )
    );
  const prefix = 'before-lock';
  const suffix = 'after-lock-\u03bb';
  const firstDelivery = Promise.withResolvers<void>();
  let body = '';
  let durableAtDelivery: unknown;
  emit(prefix);
  const response = await f.post(true, 'chat/completions');
  const reading = (async () => {
    const reader = response.body!.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += new TextDecoder().decode(next.value);
      if (body.includes(prefix)) firstDelivery.resolve();
      if (body.includes(suffix) && durableAtDelivery === undefined)
        durableAtDelivery = f.rawOutput();
    }
  })().then(
    () => undefined,
    (error: unknown) => error
  );
  await firstDelivery.promise;
  expect(f.rawOutput()).toEqual({ rawOutputBytes: Buffer.byteLength(prefix), exhausted: false });
  const blocker = f.openWorkspace();
  let deliveredWhileLocked = false;
  let proofWhileLocked: unknown;
  let heldMs = 0;
  // Fault injection only: valid state was created through owners; this connection changes no records.
  blocker.sqlite.exec('BEGIN IMMEDIATE');
  const lockStart = performance.now();
  const released = new Promise<void>((resolve) => {
    setTimeout(() => {
      deliveredWhileLocked = body.includes(suffix);
      proofWhileLocked = f.ledgerCalls()[0]?.extensions?.['openkit.worker/rawOutput'];
      heldMs = performance.now() - lockStart;
      blocker.sqlite.exec('ROLLBACK');
      resolve();
    }, 50);
  });
  try {
    emit(suffix);
    await released;
    if (!sourceCancelled) {
      emit('', 'stop');
      source.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      source.close();
    }
    const readFailure = await reading;
    // Reliability Raw-Output Accounting: commit before delivery, without losing or double-counting bytes.
    expect.soft(heldMs).toBeGreaterThan(5);
    expect.soft(deliveredWhileLocked).toBe(false);
    expect.soft(proofWhileLocked).toMatchObject({ byteLength: Buffer.byteLength(prefix) });
    expect.soft(readFailure).toBeUndefined();
    expect.soft(body).toContain(suffix);
    expect.soft(durableAtDelivery).toEqual({
      rawOutputBytes: Buffer.byteLength(prefix + suffix),
      exhausted: false,
    });
    expect.soft(inferenceSignal?.aborted).toBe(false);
    expect.soft(f.onRawOutputStop).not.toHaveBeenCalled();
    expect.soft(f.ledgerCalls()[0]).toMatchObject({
      status: 'succeeded',
      extensions: {
        'openkit.worker/rawOutput': {
          byteLength: Buffer.byteLength(prefix + suffix),
          coverage: 'complete',
        },
      },
    });
    expect
      .soft(warn.mock.calls.map(([message]) => JSON.parse(message)))
      .not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'worker_raw_output_stopped' })])
      );
  } finally {
    await released;
    if (blocker.sqlite.inTransaction) blocker.sqlite.exec('ROLLBACK');
    blocker.sqlite.close();
  }
});

it('measures stock source progression while Worker response consumption is paused', async () => {
  const f = await fixture(true, undefined, true, 'controlled');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient() });
  f.resolveGatewayProvider.mockReturnValue({
    id: 'provider',
    displayName: 'Provider',
    adapterId: 'capacity-fixture',
    apiKey: 'synthetic',
    baseUrl: 'https://provider.invalid/v1',
    models: ['native-model'],
    requiresApiKey: true,
    gatewayCapabilities: { responses: 'bridged', chatCompletions: 'native' },
    modelMetadata: { 'native-model': { limit: { context: 400_000, output: 32_000 } } },
  });
  f.dispatch.mockImplementation((provider, request, context: LLMGatewayDispatchContext) =>
    dispatcher.createChatCompletionStream(provider, request, context)
  );
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  );
  const emit = (content: string, finishReason: string | null = null) =>
    source.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: 'chat_capacity',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'native-model',
          choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
        })}\n\n`
      )
    );
  const chunk = 'x'.repeat(1024);
  emit(chunk);
  const response = await f.post(true, 'chat/completions');
  const observations: unknown[] = [];
  let offered = 1;
  try {
    for (const dose of [8, 16]) {
      while (offered < dose) {
        emit(chunk);
        offered += 1;
      }
      // Positive owner evidence only; failure to reach this frontier is an unresolved probe.
      await vi.waitFor(() => expect(f.rawOutput().rawOutputBytes).toBe(dose * chunk.length));
      const call = f.ledgerCalls()[0]!;
      observations.push({
        offeredDeltas: dose,
        canonicalRawBytes: f.rawOutput().rawOutputBytes,
        publicBodyUsed: response.bodyUsed,
        callStatus: call.status,
        rawCoverage: (call.extensions?.['openkit.worker/rawOutput'] as { coverage?: string })
          ?.coverage,
      });
    }
  } finally {
    emit('', 'stop');
    source.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    source.close();
    const body = await response.text();
    const deliveredText = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(deliveredText).toBe(chunk.repeat(offered));
    expect(f.ledgerCalls()[0]).toMatchObject({ status: 'succeeded' });
    expect(f.onRawOutputStop).not.toHaveBeenCalled();
    process.stdout.write(
      JSON.stringify({
        probe: 'R1843-source-harness-feasibility',
        observations,
        drainedBytes: deliveredText.length,
        finalRawBytes: f.rawOutput().rawOutputBytes,
        nativeStopRequests: f.onRawOutputStop.mock.calls.length,
      }) + '\n'
    );
  }
});

it('coalesces a pending same-call burst and releases only each immutable covered prefix', async () => {
  streamWriter.commits = new SharedArrayBuffer(8);
  const commits = new Int32Array(streamWriter.commits);
  const f = await fixture(true, undefined, true, 'controlled');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient() });
  f.resolveGatewayProvider.mockReturnValue({
    id: 'provider',
    displayName: 'Provider',
    adapterId: 'covering-ack-fixture',
    apiKey: 'synthetic',
    baseUrl: 'https://provider.invalid/v1',
    models: ['native-model'],
    requiresApiKey: true,
    gatewayCapabilities: { responses: 'bridged', chatCompletions: 'native' },
    modelMetadata: { 'native-model': { limit: { context: 400_000, output: 32_000 } } },
  });
  const observed: number[] = [];
  let firstChunkBound = false;
  f.dispatch.mockImplementation((provider, request, context: LLMGatewayDispatchContext) => {
    const raw = context.transport!.rawOutput!;
    const coverAcknowledgement = raw.coverAcknowledgement!.bind(raw);
    vi.spyOn(raw, 'coverAcknowledgement').mockImplementation(() => {
      const bind = coverAcknowledgement();
      return (chunk) => {
        bind(chunk);
        if (new TextDecoder().decode(chunk).includes(first)) firstChunkBound = true;
      };
    });
    const observe = raw.observe;
    vi.spyOn(raw, 'observe').mockImplementation((position) => {
      Atomics.store(commits, 0, 1);
      observed.push(position.bytePosition);
      return observe(position);
    });
    return dispatcher.createChatCompletionStream(provider, request, context);
  });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          source = controller;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  );
  const emit = (content: string, finishReason: string | null = null) =>
    source.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: 'chat_covering_ack',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'native-model',
          choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
        })}\n\n`
      )
    );
  const first = 'first-λ';
  const burst = Array.from({ length: 8 }, (_, index) => `burst-${index}-λ;`);
  const firstBytes = Buffer.byteLength(first);
  const allText = first + burst.join('');
  const finalBytes = Buffer.byteLength(allText);
  const held: { frontier: number; release: () => void }[] = [];
  streamWriter.holdReply = (value, release) => {
    const reply = value as { status?: unknown; operation?: unknown };
    if (reply.status !== 'ok' || reply.operation !== 'capability') return false;
    const frontier = f.rawOutput().rawOutputBytes;
    if (frontier <= (held.at(-1)?.frontier ?? 0)) return false;
    held.push({ frontier, release });
    return true;
  };
  let body = '';
  const delivered: string[] = [];
  const reading = f.post(true, 'chat/completions').then(async (response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = decoder.decode(next.value, { stream: true });
        body += chunk;
        pending += chunk;
        for (;;) {
          const end = pending.indexOf('\n\n');
          if (end < 0) break;
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (!frame.startsWith('data: {')) continue;
          const content = JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content) delivered.push(content);
        }
      }
    } finally {
      reader.releaseLock();
    }
  });
  const settled = reading.then(
    () => undefined,
    (error: unknown) => error
  );
  try {
    emit(first);
    // Raw COMMIT precedes stock conversion; wait for the real first encoded chunk binding too.
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
      expect(firstChunkBound).toBe(true);
    });
    // Reliability Raw-Output Accounting and R1842: a native commit alone is no delivered ACK.
    expect(held[0]!.frontier).toBe(firstBytes);
    expect(Atomics.load(commits, 1)).toBe(1);
    expect(delivered).toEqual([]);
    for (const content of burst) emit(content);
    await vi.waitFor(() => expect(observed.at(-1)).toBe(finalBytes));
    // COORD07:3x/R1842: native hooks can advance while the first same-call ACK is held.
    expect(observed).toHaveLength(1 + burst.length);
    expect(held).toHaveLength(1);
    expect(f.rawOutput().rawOutputBytes).toBe(firstBytes);
    held[0]!.release();
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]!.frontier).toBe(finalBytes);
    // All eight pending same-part observations share one maximum, after the first isolated commit.
    expect(Atomics.load(commits, 1)).toBe(2);
    await vi.waitFor(() => expect(delivered).toEqual([first]));
    // R1842: new arrivals cannot move the first captured target or mutate its encoded content.
    expect(body).not.toContain(burst[0]!);
    expect(f.rawOutput()).toEqual({ rawOutputBytes: finalBytes, exhausted: false });
    held[1]!.release();
    await vi.waitFor(() => expect(delivered.join('')).toBe(allText));
  } finally {
    streamWriter.holdReply = undefined;
    for (const reply of held) reply.release();
    Atomics.store(commits, 0, 0);
    emit('', 'stop');
    source.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    source.close();
    await settled;
  }
  expect(await settled).toBeUndefined();
  expect(delivered.join('')).toBe(allText);
  expect(f.rawOutput()).toEqual({ rawOutputBytes: finalBytes, exhausted: false });
  expect(f.ledgerCalls()[0]).toMatchObject({
    status: 'succeeded',
    extensions: { 'openkit.worker/rawOutput': { byteLength: finalBytes, coverage: 'complete' } },
  });
  expect(f.onRawOutputStop).not.toHaveBeenCalled();
});

it('flushes the exact crossing prefix before native stop and rejects the next source field', async () => {
  streamWriter.commits = new SharedArrayBuffer(8);
  const commits = new Int32Array(streamWriter.commits);
  const f = await fixture(true, undefined, true, 'controlled');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient() });
  f.resolveGatewayProvider.mockReturnValue({
    id: 'provider',
    displayName: 'Provider',
    adapterId: 'crossing-ack-fixture',
    apiKey: 'synthetic',
    baseUrl: 'https://provider.invalid/v1',
    models: ['native-model'],
    requiresApiKey: true,
    gatewayCapabilities: { responses: 'bridged', chatCompletions: 'native' },
    modelMetadata: { 'native-model': { limit: { context: 400_000, output: 32_000 } } },
  });
  const observed: number[] = [];
  f.dispatch.mockImplementation((provider, request, context: LLMGatewayDispatchContext) => {
    const raw = context.transport!.rawOutput!;
    const observe = raw.observe;
    vi.spyOn(raw, 'observe').mockImplementation((position) => {
      Atomics.store(commits, 0, 1);
      observed.push(position.bytePosition);
      return observe(position);
    });
    return dispatcher.createChatCompletionStream(provider, request, context);
  });
  // Reliability fixes the ceiling at 16,777,216 UTF-8 bytes; this source emits its first excess byte.
  const crossingBytes = 16_777_217;
  const crossing = 'x'.repeat(crossingBytes);
  const tail = 'must-not-be-accounted-after-crossing';
  const wire =
    [crossing, tail]
      .map(
        (content) =>
          `data: ${JSON.stringify({
            id: 'chat_crossing_ack',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'native-model',
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`
      )
      .join('') + 'data: [DONE]\n\n';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
  );
  const held: (() => void)[] = [];
  const crossingReply = Promise.withResolvers<void>();
  streamWriter.holdReply = (value, release) => {
    const reply = value as { status?: unknown; operation?: unknown };
    if (reply.status !== 'ok' || reply.operation !== 'capability' || held.length) return false;
    const proof = f.ledgerCalls()[0]?.extensions?.['openkit.worker/rawOutput'] as
      | { byteLength?: number }
      | undefined;
    if (proof?.byteLength !== crossingBytes) return false;
    held.push(release);
    crossingReply.resolve();
    return true;
  };
  let proofAtStop: unknown;
  f.onRawOutputStop.mockImplementation(async () => {
    proofAtStop = structuredClone(f.ledgerCalls()[0]?.extensions?.['openkit.worker/rawOutput']);
  });
  const request = f.post(true, 'chat/completions').then((response) => response.text());
  const settled = request.then(
    () => undefined,
    (error: unknown) => error
  );
  try {
    await Promise.race([crossingReply.promise, request]);
    expect(held).toHaveLength(1);
    // COORD07:5x: crossing is durable, but a held native ACK cannot authorize dependent stop yet.
    expect(Atomics.load(commits, 1)).toBeGreaterThan(0);
    expect(f.onRawOutputStop).not.toHaveBeenCalled();
    expect(observed).toEqual([crossingBytes]);
  } finally {
    streamWriter.holdReply = undefined;
    for (const release of held) release();
    Atomics.store(commits, 0, 0);
    await settled;
  }
  expect(await settled).toBeUndefined();
  expect(f.onRawOutputStop).toHaveBeenCalledTimes(1);
  expect(proofAtStop).toMatchObject({ byteLength: crossingBytes });
  expect(observed).toEqual([crossingBytes]);
  expect(await request).not.toContain(tail);
});

it('keeps a pending sibling alive when a non-admission failure has no raw source', async () => {
  const f = await fixture(true, undefined, true, 'controlled');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const enteredA = Promise.withResolvers<LLMGatewayDispatchContext>();
  const releaseA = Promise.withResolvers<void>();
  f.dispatch
    .mockImplementationOnce(async (_provider, _request, context: LLMGatewayDispatchContext) => {
      enteredA.resolve(context);
      await releaseA.promise;
      const settle = context.transport!.rawOutput!.sourceStarted();
      context.transport!.rawOutput!.sourceEvent();
      settle();
      return { id: 'response-a', object: 'response', status: 'completed', output: [] };
    })
    .mockRejectedValueOnce(
      Object.assign(new TypeError('exception-message-canary'), {
        name: 'exception-name-canary',
        code: 'exception-code-canary',
      })
    );
  const pendingA = f.post(false);
  const contextA = await enteredA.promise;
  const callA = f.ledgerCalls()[0]!;
  try {
    const responseB = await f.post(false);
    const callB = f.ledgerCalls().find((call) => call.id !== callA.id)!;

    // Reliability: no reached native source and no public output is complete-empty proof.
    expect.soft(contextA.transport!.signal!.aborted).toBe(false);
    expect.soft(f.onRawOutputStop).not.toHaveBeenCalled();
    expect.soft(callB).toMatchObject({ status: 'failed', errorCode: 'worker_inference_failed' });
    expect.soft(callB.extensions?.['openkit.worker/rawOutput']).toMatchObject({
      byteLength: 0,
      coverage: 'complete',
    });
    expect.soft(responseB.status).toBe(400);
    const bodyB = await responseB.json();
    expect.soft(bodyB).toMatchObject({
      error: { code: expect.any(String), message: expect.any(String) },
    });
    expect.soft(bodyB.error.code).not.toMatch(/^worker_raw_output_(?:unavailable|exhausted)$/);
    expect.soft(JSON.stringify(bodyB)).not.toContain('canary');
    const diagnostics = warn.mock.calls.map(([message]) => JSON.parse(message));
    expect
      .soft(diagnostics.filter((entry) => entry.code === 'worker_raw_output_stopped'))
      .toEqual([]);
    // Item 3d: the trusted exception class survives unknown dispatch classification.
    expect.soft(diagnostics.find((entry) => entry.capabilityCallId === callB.id)).toMatchObject({
      code: 'worker_inference_failed',
      phase: 'dispatch',
      failureKind: 'unknown',
      outputBegan: false,
      exceptionClass: 'type_error',
    });
    expect.soft(JSON.stringify(diagnostics)).not.toContain('canary');
  } finally {
    releaseA.resolve();
    await (await pendingA).text();
  }
  expect(f.ledgerCalls().find((call) => call.id === callA.id)).toMatchObject({
    status: 'succeeded',
  });
  expect(f.rawOutput()).toEqual({ rawOutputBytes: 0, exhausted: false });
});

it.each([
  { failure: 'incomplete settlement', stage: 'settlement', causeCode: 'raw_source_incomplete' },
  { failure: 'explicit raw failure', stage: 'source', causeCode: 'raw_authority_unavailable' },
] as const)('retains B as the first raw-stop origin after $failure', async ({
  failure,
  stage,
  causeCode,
}) => {
  const f = await fixture(true, undefined, true, 'controlled');
  const enteredA = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const loggedA = Promise.withResolvers<void>();
  let callAId: string | undefined;
  let originAtAbort: unknown;
  const warn = vi.spyOn(console, 'warn').mockImplementation((message) => {
    const diagnostic = JSON.parse(message);
    if (diagnostic.code === 'worker_inference_failed' && diagnostic.capabilityCallId === callAId)
      loggedA.resolve();
  });
  f.dispatch
    .mockImplementationOnce(async (_provider, _request, context: LLMGatewayDispatchContext) => {
      const raw = context.transport!.rawOutput!;
      const settle = raw.sourceStarted();
      const aborted = Promise.withResolvers<never>();
      const signal = context.transport!.signal!;
      signal.addEventListener(
        'abort',
        () => {
          originAtAbort = warn.mock.calls
            .map(([message]) => JSON.parse(message))
            .find((entry) => entry.code === 'worker_raw_output_stopped');
          aborted.reject(signal.reason);
        },
        { once: true }
      );
      enteredA.resolve();
      try {
        await Promise.race([releaseA.promise, aborted.promise]);
      } finally {
        settle();
      }
      throw new Error('unexpected-release-canary');
    })
    .mockImplementationOnce(async (_provider, _request, context: LLMGatewayDispatchContext) => {
      // A reached source with zero hooks is unknown even after it settles.
      const raw = context.transport!.rawOutput!;
      const settle = raw.sourceStarted();
      settle();
      if (failure === 'explicit raw failure') {
        let rawFailure: unknown;
        try {
          await raw.fail(new WorkerRawOutputAuthorityError());
        } catch (error) {
          rawFailure = error;
        }
        // Force the sibling to report first, independently of the origin record.
        await loggedA.promise;
        throw rawFailure;
      }
      throw new TypeError('exception-message-canary');
    });
  const pendingA = f.post(false);
  await enteredA.promise;
  callAId = f.ledgerCalls()[0]!.id;
  try {
    const responseB = await f.post(false);
    await responseB.text();
    await (await pendingA).text();
    const callB = f.ledgerCalls().find((call) => call.id !== callAId)!;
    const origin = {
      code: 'worker_raw_output_stopped',
      capabilityCallId: callB.id,
      phase: 'dispatch',
      stage,
      causeCode,
    };

    // Item 3d requires the first origin before abort can create sibling failures.
    expect.soft(originAtAbort).toMatchObject(origin);
    const diagnostics = warn.mock.calls.map(([message]) => JSON.parse(message));
    const stops = diagnostics.filter((entry) => entry.code === 'worker_raw_output_stopped');
    expect.soft(stops).toHaveLength(1);
    expect.soft(stops[0]).toMatchObject(origin);
    if (failure === 'explicit raw failure') {
      // W-LEASE-2 diagnostics keep the trusted coarse refusal class.
      expect.soft(stops[0]).toMatchObject({
        errorClass: 'raw-authority',
      });
      const failures = diagnostics.filter((entry) => entry.code === 'worker_inference_failed');
      expect.soft(failures[0]?.capabilityCallId).toBe(callAId);
    }
    expect.soft(f.onRawOutputStop).toHaveBeenCalledTimes(1);
    expect.soft(f.onRawOutputStop).toHaveBeenCalledWith(f.environmentPackage.scope, 'error');
    expect.soft(f.ledgerCalls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: callAId, errorCode: 'worker_raw_output_unavailable' }),
        expect.objectContaining({
          id: callB.id,
          status: 'failed',
          errorCode: 'worker_raw_output_unavailable',
        }),
      ])
    );
    expect.soft(() => f.rawOutput()).toThrow(WorkerRawOutputAuthorityError);
    expect.soft(JSON.stringify(diagnostics)).not.toContain('canary');
  } finally {
    releaseA.resolve();
    await pendingA;
  }
});

it.each([
  'responses',
  'chat/completions',
])('logs one safe committed %s failure and preserves closeout', async (endpoint) => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockResolvedValue(
    failedStream(
      Object.assign(new Error('exception-canary'), {
        failure: {
          kind: 'provider_unavailable',
          settled: false,
          status: 502,
          providerCode: 'credential-canary',
        },
        body: 'body-canary',
      }),
      endpoint
    )
  );
  const response = await f.post(true, endpoint);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('output-canary');
  expect(body).toContain('gateway_provider_unavailable');
  expect(body).toContain('[DONE]');
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  const [call] = f.calls() as { call_id: string; request_id: string }[];
  expect(f.calls()).toMatchObject([
    { status: 'failed', error_code: 'gateway_provider_unavailable' },
  ]);
  expect(warn).toHaveBeenCalledTimes(1);
  const diagnostic = JSON.parse(warn.mock.calls[0]![0]);
  expect(diagnostic).toEqual({
    code: 'worker_inference_failed',
    message: 'Worker inference call failed.',
    phase: 'stream-read',
    failureKind: 'provider_unavailable',
    httpStatus: 502,
    elapsedMs: expect.any(Number),
    outputBegan: true,
    requestId: call!.request_id,
    capabilityCallId: call!.call_id,
    workspaceId: workspaceIdForOwner(f.turn.owner),
    threadId: f.turn.threadId,
    turnId: f.turn.id,
    corr: expect.any(String),
    attempt: 0,
  });
  expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(diagnostic)).not.toMatch(
    /(?:exception|body|prompt|output|credential)-canary/
  );
});

it.each([
  'dispatch',
  'stream-prepare',
] as const)('logs a pre-output %s failure without inventing status', async (phase) => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = Object.assign(new Error('exception-canary'), {
    failure: { kind: 'unknown', settled: false },
  });
  f.dispatch.mockImplementation(async (_provider, _request, context: LLMGatewayDispatchContext) => {
    context.transport?.onProviderHandoff?.();
    if (phase === 'dispatch') throw error;
    return new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    });
  });
  const response = await f.post(phase === 'stream-prepare');
  expect(response.status, await response.clone().text()).toBe(400);
  expect(await response.text()).not.toContain('exception-canary');
  expect(f.calls()).toMatchObject([{ status: 'failed', error_code: 'worker_inference_failed' }]);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(warn.mock.calls[0]![0])).toMatchObject({
    code: 'worker_inference_failed',
    phase,
    failureKind: 'unknown',
    outputBegan: false,
    elapsedMs: expect.any(Number),
    attempt: 0,
  });
  expect(JSON.parse(warn.mock.calls[0]![0])).not.toHaveProperty('httpStatus');
});

it('retains bounded provider rejection details without changing the public failure', async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = Object.assign(new Error('exception-canary'), {
    failure: { kind: 'unknown', settled: false },
  });
  const details = {
    type: 'invalid_request_error',
    code: 'bad_parameter',
    param: 'max_output_tokens',
    message: 'M'.repeat(250),
    body: 'body-canary',
    unknown: 'unknown-canary',
  };
  f.dispatch.mockImplementation(async (_provider, _request, context: LLMGatewayDispatchContext) => {
    context.transport?.onProviderHandoff?.();
    context.transport?.onProviderHttpRejection?.(422, details);
    throw error;
  });
  const response = await f.post(true);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: 'provider_error',
      type: 'provider_error',
      message: 'Provider request failed.',
    },
  });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.calls()).toMatchObject([{ status: 'failed', error_code: 'worker_inference_failed' }]);
  expect(warn).toHaveBeenCalledTimes(1);
  const diagnostic = JSON.parse(warn.mock.calls[0]![0]);
  expect(diagnostic).toMatchObject({
    failureKind: 'unknown',
    httpStatus: 422,
    phase: 'dispatch',
    outputBegan: false,
    attempt: 0,
  });
  expect(diagnostic.providerError).toEqual({
    type: 'invalid_request_error',
    code: 'bad_parameter',
    param: 'max_output_tokens',
    message: 'M'.repeat(200),
  });
  expect(JSON.stringify(diagnostic)).not.toContain('canary');
  expect(error.failure).toEqual({ kind: 'unknown', settled: false });
});

it('keeps terminal SSE and durable failure when logging throws', async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('sink unavailable');
  });
  f.dispatch.mockResolvedValue(failedStream(new Error('exception-canary')));
  const response = await f.post(true);
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain('gateway_stream_failed');
  expect(body).toContain('[DONE]');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(warn.mock.calls[0]![0])).not.toHaveProperty('httpStatus');
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.calls()).toMatchObject([
    { status: 'failed', error_code: 'worker_inference_stream_failed' },
  ]);
});

it('clears observed rejection before a retry with no HTTP evidence', async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch
    .mockImplementationOnce(async (_provider, _request, context: LLMGatewayDispatchContext) => {
      context.transport?.onProviderHttpRejection?.(429, {
        code: 'prior-attempt-code',
        message: 'prior-attempt-message',
      });
      throw Object.assign(new Error('first-exception-canary'), {
        failure: { kind: 'rate_limited', settled: true, status: 429 },
      });
    })
    .mockImplementationOnce(async () => {
      throw Object.assign(new Error('second-exception-canary'), {
        failure: { kind: 'unknown', settled: false },
      });
    });
  // Real native handoffs and the original retry backoff share the unchanged test deadline.
  const response = await f.post(false);
  expect(response.status).toBe(400);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(warn.mock.calls[0]![0])).toMatchObject({
    failureKind: 'unknown',
    attempt: 1,
  });
  expect(JSON.parse(warn.mock.calls[0]![0])).not.toHaveProperty('httpStatus');
  expect(JSON.parse(warn.mock.calls[0]![0])).not.toHaveProperty('providerError');
});

it('logs selection failure without inventing an attempt or upstream status', async () => {
  const f = await fixture(false);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const response = await f.post(false);
  expect(response.status).toBe(503);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.calls()).toMatchObject([
    { status: 'failed', error_code: 'gateway_logical_model_unavailable' },
  ]);
  expect(warn).toHaveBeenCalledTimes(1);
  const diagnostic = JSON.parse(warn.mock.calls[0]![0]);
  expect(diagnostic).toMatchObject({
    phase: 'selection',
    failureKind: 'unknown',
    outputBegan: false,
  });
  expect(diagnostic).not.toHaveProperty('httpStatus');
  expect(diagnostic).not.toHaveProperty('corr');
  expect(diagnostic).not.toHaveProperty('attempt');
});

it('logs only the final exhausted attempt with its observed upstream status', async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockRejectedValue(
    Object.assign(new Error('exception-canary'), {
      failure: { kind: 'provider_unavailable', settled: true, status: 503 },
    })
  );
  // Real native handoffs and the original retry backoffs share the unchanged test deadline.
  const response = await f.post(false);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: 'gateway_logical_model_unavailable', cause: 'provider_unavailable' },
  });
  expect(f.dispatch).toHaveBeenCalledTimes(4);
  expect(f.calls()).toMatchObject([
    { status: 'failed', error_code: 'gateway_logical_model_unavailable' },
  ]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(warn.mock.calls[0]![0])).toMatchObject({
    phase: 'dispatch',
    failureKind: 'provider_unavailable',
    httpStatus: 503,
    attempt: 3,
    outputBegan: false,
  });
});

it('omits local envelope status and unclassified error details', async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockRejectedValue(
    Object.assign(new Error('exception-canary'), {
      status: 400,
      code: 'credential-canary',
      body: 'body-canary',
    })
  );
  const response = await f.post(false);
  expect(response.status).toBe(400);
  expect(warn).toHaveBeenCalledTimes(1);
  const diagnostic = JSON.parse(warn.mock.calls[0]![0]);
  expect(diagnostic).toMatchObject({
    phase: 'dispatch',
    failureKind: 'unknown',
    outputBegan: false,
  });
  expect(diagnostic).not.toHaveProperty('httpStatus');
  expect(JSON.stringify(diagnostic)).not.toMatch(/canary/);
});

it.each([
  'failed-frame',
  'iterator-end',
])('logs pre-output %s without inferring a cause', async (ending) => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockResolvedValue(
    new ReadableStream({
      start(controller) {
        if (ending === 'failed-frame')
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"body-canary"}}}\n\n'
            )
          );
        controller.close();
      },
    })
  );
  const response = await f.post(true);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toMatch(/body-canary|response.failed/);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.calls()).toMatchObject([{ status: 'failed', error_code: 'worker_inference_failed' }]);
  expect(warn).toHaveBeenCalledTimes(1);
  const diagnostic = JSON.parse(warn.mock.calls[0]![0]);
  expect(diagnostic).toMatchObject({
    phase: 'stream-prepare',
    failureKind: 'unknown',
    outputBegan: false,
  });
  expect(diagnostic).not.toHaveProperty('httpStatus');
  expect(JSON.stringify(diagnostic)).not.toContain('canary');
});

it('retains a final local authentication failure kind without an upstream status', async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.resolveGatewayProvider.mockImplementation(() => {
    throw new OpenAICompatibleProviderError({
      code: 'gateway_provider_authentication_failed',
      message: 'credential-canary',
      status: 401,
      type: 'provider_error',
    });
  });
  const response = await f.post(false);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: 'gateway_logical_model_unavailable', cause: 'auth_rejected' },
  });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.resolveGatewayProvider).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  const diagnostic = JSON.parse(warn.mock.calls[0]![0]);
  expect(diagnostic).toMatchObject({
    phase: 'selection',
    failureKind: 'auth_rejected',
    attempt: 0,
    outputBegan: false,
  });
  expect(diagnostic).not.toHaveProperty('httpStatus');
  expect(JSON.stringify(diagnostic)).not.toContain('canary');
});

it.each([
  'responses',
  'chat/completions',
])('logs one safe committed %s failure frame', async (endpoint) => {
  for (const ending of ['close', 'read-error', 'cancel'] as const) {
    for (const code of ['gateway_provider_unavailable', 'private-code-canary']) {
      const f = await fixture();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const encoder = new TextEncoder();
      const output = `data: ${JSON.stringify(
        endpoint === 'responses'
          ? { type: 'response.output_text.delta', delta: 'output-canary' }
          : { choices: [{ delta: { content: 'output-canary' } }] }
      )}\n\n`;
      const failure = `data: ${JSON.stringify(
        endpoint === 'responses'
          ? {
              type: 'response.failed',
              response: { status: 'failed', error: { code, message: 'body-canary', status: 503 } },
            }
          : { error: { code, message: 'body-canary', status: 503 } }
      )}\n\n`;
      // Split the terminal frame across chunks to exercise the existing SSE observer.
      const chunks = [output, failure.slice(0, 19), failure.slice(19), failure];
      f.dispatch.mockResolvedValue(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
            else if (ending === 'read-error') controller.error(new Error('exception-canary'));
            else if (ending === 'close') controller.close();
            // Keep the source open for consumer cancellation after the failure frame.
          },
        })
      );
      const response = await f.post(true, endpoint);
      expect(response.status).toBe(200);
      let body = '';
      if (ending === 'cancel') {
        const reader = response.body!.getReader();
        while (!body.includes(failure)) {
          const next = await reader.read();
          expect(next.done).toBe(false);
          body += new TextDecoder().decode(next.value);
        }
        await reader.cancel();
      } else body = await response.text();
      expect(body.startsWith(output + failure)).toBe(true);
      if (ending === 'close') expect(body).toBe(output + failure + failure);
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(f.calls()).toMatchObject([
        {
          status: 'failed',
          error_code: code === 'private-code-canary' ? 'worker_inference_stream_failed' : code,
        },
      ]);
      expect(warn, `${endpoint}/${ending}/${code}`).toHaveBeenCalledTimes(1);
      const diagnostic = JSON.parse(warn.mock.calls[0]![0]);
      expect(diagnostic).toMatchObject({
        code: 'worker_inference_failed',
        message: 'Worker inference call failed.',
        phase: 'stream-read',
        failureKind: code === 'private-code-canary' ? 'unknown' : 'provider_unavailable',
        outputBegan: true,
        attempt: 0,
        capabilityCallId: expect.any(String),
      });
      expect(diagnostic).not.toHaveProperty('httpStatus');
      expect(JSON.stringify(diagnostic)).not.toContain('canary');
      warn.mockRestore();
    }
  }
});

it.each([
  'responses',
  'chat/completions',
])('does not log successful %s streams', async (endpoint) => {
  const f = await fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockResolvedValue(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            endpoint === 'responses'
              ? 'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
              : 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
          )
        );
        controller.close();
      },
    })
  );
  const response = await f.post(true, endpoint);
  await response.text();
  expect(warn).not.toHaveBeenCalled();
  expect(f.calls()).toMatchObject([{ status: 'succeeded' }]);
});

it('blocks Provider access before execution when native stop coverage is absent', async () => {
  const f = await fixture(true, undefined, false);
  expect((await f.post(false)).status).toBe(503);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('preserves raw-output exhaustion before native compaction commits', async () => {
  const f = await fixture(true, 'compaction');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockImplementation(async (_provider, _request, context: LLMGatewayDispatchContext) => {
    await context.transport!.rawOutput!.fail(new WorkerRawOutputBudgetExceededError());
  });
  const response = await f.post(true);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: 'worker_raw_output_exhausted' },
  });
  expect(f.calls()).toMatchObject([
    { status: 'failed', error_code: 'worker_raw_output_exhausted' },
  ]);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  const stop = warn.mock.calls
    .map(([message]) => JSON.parse(message))
    .find((entry) => entry.code === 'worker_raw_output_stopped');
  expect(stop).toMatchObject({ causeCode: 'budget_exhausted', errorClass: 'budget' });
  expect(stop).not.toHaveProperty('reasonCode');
});

it('maps a confirmed pre-output native compaction failure to the owned envelope', async () => {
  const f = await fixture(true, 'compaction');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockRejectedValue(
    Object.assign(new Error('private-provider-canary'), {
      failure: { kind: 'unknown', settled: false },
    })
  );
  const response = await f.post(true);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: 'context_compaction_unavailable',
      message: 'Context compaction is unavailable.',
      type: 'provider_error',
    },
  });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it('maps unavailable routes for confirmed compaction without inventing a Provider attempt', async () => {
  const f = await fixture(false, 'compaction');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const response = await f.post(false);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: 'context_compaction_unavailable',
      message: 'Context compaction is unavailable.',
      type: 'provider_error',
    },
  });
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('keeps an indistinguishable ordinary native failure in its existing category', async () => {
  const f = await fixture(true, 'turn');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockRejectedValue(
    Object.assign(new Error('private-provider-canary'), {
      failure: { kind: 'unknown', settled: false },
    })
  );
  const response = await f.post(true);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: 'provider_error',
      message: 'Provider request failed.',
      type: 'provider_error',
    },
  });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it('returns one actionable redacted context overflow after output begins', async () => {
  const f = await fixture();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.dispatch.mockResolvedValue(
    failedStream(
      Object.assign(new Error('private-context-canary'), {
        failure: { kind: 'context_overflow', settled: true, status: 400 },
      })
    )
  );

  const response = await f.post(true);
  const body = await response.text();
  const terminal = body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((frame) => frame.error || frame.response?.error);
  expect(terminal).toHaveLength(1);
  expect(terminal[0]?.error ?? terminal[0]?.response?.error).toMatchObject({
    code: 'gateway_context_overflow',
    message: 'Provider context limit exceeded. Reduce input or retrieve a smaller excerpt.',
  });
  expect(body).not.toContain('private-context-canary');
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.calls()).toMatchObject([{ status: 'failed', error_code: 'gateway_context_overflow' }]);
});
