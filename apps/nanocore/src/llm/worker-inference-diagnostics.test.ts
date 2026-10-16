import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthVariables } from '../auth/middleware.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { registerWorkerInferenceRoutes } from './gateway-routes.js';
import { OpenAICompatibleProviderError } from './openai-compatible-client.js';
import type {
  LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from './provider-dispatcher.js';

// Authorization is outside this diagnostic test. Token parsing, AEP admission, dispatch,
// stream preparation, error projection and durable closeout use their production owners.
vi.mock('../auth/operation-authorizer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/operation-authorizer.js')>()),
  currentWorkerLineageWorkspaceAuthority: () => true,
}));

const roots: string[] = [];
const databases: CoreDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the real worker route with a controlled Provider boundary and real capability storage. */
function fixture(configured = true, nativeStop = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'worker-inference-diagnostics-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Diagnostics');
  const thread = store.createThread(workspace.id, 'Diagnostics');
  const turn = store.createTurn(workspace.id, thread.id, 'Request', {
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
  // This controlled Provider double knows its complete source before public SSE delivery.
  const observedDispatch = (...args: unknown[]) => {
    const boundary = (args[2] as LLMGatewayDispatchContext | undefined)?.transport?.rawOutput;
    const settle = boundary?.sourceStarted();
    boundary?.sourceEvent();
    settle?.();
    return dispatch(...args);
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  registerWorkerInferenceRoutes({
    app,
    coreDb,
    workerControlGateway: gateway,
    ...(nativeStop ? { onRawOutputStop: vi.fn(async () => {}) } : {}),
    llmGatewayDispatcher: {
      createResponses: observedDispatch,
      createChatCompletion: observedDispatch,
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
    turn,
    post: (stream: boolean, endpoint = 'responses') =>
      app.request(`/api/worker-inference/v1/${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'worker-model',
          stream,
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

it.each([
  'responses',
  'chat/completions',
])('logs one safe committed %s failure and preserves closeout', async (endpoint) => {
  const f = fixture();
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
    workspaceId: f.turn.workspaceId,
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
  const f = fixture();
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

it('keeps terminal SSE and durable failure when logging throws', async () => {
  const f = fixture();
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

it('logs selection failure without inventing an attempt or upstream status', async () => {
  const f = fixture(false);
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
  const f = fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers();
  f.dispatch.mockRejectedValue(
    Object.assign(new Error('exception-canary'), {
      failure: { kind: 'provider_unavailable', settled: true, status: 503 },
    })
  );
  const pending = f.post(false);
  await vi.runAllTimersAsync();
  const response = await pending;
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
  const f = fixture();
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
  const f = fixture();
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
  const f = fixture();
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
      const f = fixture();
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
  const f = fixture();
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
  const f = fixture(true, false);
  expect((await f.post(false)).status).toBe(503);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each([
  { endpoint: 'responses', stream: false },
  { endpoint: 'chat/completions', stream: false },
  { endpoint: 'responses', stream: true },
  { endpoint: 'chat/completions', stream: true },
])('returns actionable context overflow without retry or private details: %j', async ({
  endpoint,
  stream,
}) => {
  const f = fixture();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = Object.assign(new Error('private-context-canary'), {
    failure: { kind: 'context_overflow', settled: true, status: 400 },
  });
  if (stream) f.dispatch.mockResolvedValue(failedStream(failure, endpoint));
  else f.dispatch.mockRejectedValue(failure);
  const response = await f.post(stream, endpoint);
  expect(response.status).toBe(stream ? 200 : 400);
  const expected = {
    code: 'gateway_context_overflow',
    type: 'provider_error',
    message: 'Provider context limit exceeded. Reduce input or retrieve a smaller excerpt.',
  };
  if (stream) {
    const body = await response.text();
    const terminal = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
      .find((frame) => frame.error || frame.response?.error);
    expect(terminal?.error ?? terminal?.response?.error).toMatchObject(expected);
    expect(body).toContain('[DONE]');
    expect(body).not.toContain('private-context-canary');
  } else expect(await response.json()).toEqual({ error: expected });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.calls()).toMatchObject([
    {
      status: 'failed',
      error_code: stream ? 'gateway_context_overflow' : 'worker_inference_failed',
    },
  ]);
});
