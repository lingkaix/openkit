import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { serve } from '@hono/node-server';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleProviderError,
  type OpenAICompatibleResponsesRequest,
  type OpenAICompatibleResponsesResponse,
} from './llm/openai-compatible-client.js';
import type {
  LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from './llm/provider-dispatcher.js';
import type { ResolvedLLMProviderConfig } from './providers/llm-config.js';
import { ProviderRegistry } from './providers/registry.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';

interface WorkerInferenceDispatchCall {
  /** Dispatcher context derived by the route. */
  readonly context: LLMGatewayDispatchContext;
  /** Worker request after authority fields are stripped. */
  readonly request: OpenAICompatibleChatCompletionRequest | OpenAICompatibleResponsesRequest;
  /** AEP-selected provider passed to the shared dispatcher. */
  readonly provider: ResolvedLLMProviderConfig;
}

/** Minimal dispatcher fake for worker inference route tests. */
class FakeWorkerInferenceDispatcher {
  /** Chat Completions calls accepted by the fake. */
  public readonly chatCalls: WorkerInferenceDispatchCall[] = [];
  /** Responses calls accepted by the fake. */
  public readonly responseCalls: WorkerInferenceDispatchCall[] = [];
  /** Optional Responses failure raised before a response is returned. */
  public responseError: Error | null = null;
  /** Optional failure raised after the routed request signal is aborted. */
  public responseErrorAfterAbort: Error | 'signal-reason' | null = null;
  /** Optional non-stream Responses value used for serialization failure tests. */
  public responsesResponseOverride: OpenAICompatibleResponsesResponse | null = null;
  /** Whether the Responses stream should fail after its first chunk. */
  public shouldFailResponsesStream = false;
  /** Whether the Responses stream should stay open until its consumer cancels it. */
  public shouldHoldResponsesStream = false;
  /** Cancellation reasons observed by the upstream Responses stream. */
  public readonly responsesStreamCancellations: unknown[] = [];

  /**
   * Returns one deterministic Chat Completions response.
   *
   * @param provider Selected provider.
   * @param request Sanitized worker request.
   * @param context Derived dispatch context.
   * @returns OpenAI-compatible completion fixture.
   */
  public async createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    context: LLMGatewayDispatchContext = {}
  ) {
    this.chatCalls.push({ context, provider, request });
    context.transport?.onCodexTurnState?.('worker-provider-response-state');

    return {
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'worker chat ok', role: 'assistant' as const },
        },
      ],
      created: 1,
      id: 'chatcmpl_worker_inference',
      model: request.model,
      object: 'chat.completion' as const,
    };
  }

  /**
   * Returns one deterministic Chat Completions SSE stream.
   *
   * @param provider Selected provider.
   * @param request Sanitized worker request.
   * @param context Derived dispatch context.
   * @returns OpenAI-compatible SSE bytes.
   */
  public async createChatCompletionStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    this.chatCalls.push({ context, provider, request });
    context.transport?.onCodexTurnState?.('worker-provider-response-state');

    return streamText('data: {"id":"chatcmpl_worker_stream"}\n\ndata: [DONE]\n\n');
  }

  /**
   * Returns one deterministic Responses response.
   *
   * @param provider Selected provider.
   * @param request Sanitized worker request.
   * @param context Derived dispatch context.
   * @returns OpenAI-compatible Responses fixture.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    context: LLMGatewayDispatchContext = {}
  ) {
    this.responseCalls.push({ context, provider, request });
    if (this.responseErrorAfterAbort) {
      const signal = context.transport?.signal;

      if (!signal) {
        throw new Error('Worker inference test expected a routed request signal.');
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
      }
      throw this.responseErrorAfterAbort === 'signal-reason'
        ? signal.reason
        : this.responseErrorAfterAbort;
    }
    if (this.responseError) {
      throw this.responseError;
    }
    context.transport?.onCodexTurnState?.('worker-provider-response-state');
    if (this.responsesResponseOverride) {
      return this.responsesResponseOverride;
    }

    return {
      id: 'resp_worker_inference',
      object: 'response' as const,
      model: request.model,
      output: [],
      status: 'completed' as const,
    };
  }

  /**
   * Returns one deterministic Responses SSE stream.
   *
   * @param provider Selected provider.
   * @param request Sanitized worker request.
   * @param context Derived dispatch context.
   * @returns OpenAI-compatible SSE bytes.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    this.responseCalls.push({ context, provider, request });
    context.transport?.onCodexTurnState?.('worker-provider-response-state');

    if (this.shouldHoldResponsesStream) {
      return new ReadableStream<Uint8Array>({
        cancel: async (reason) => {
          this.responsesStreamCancellations.push(reason);
          await Promise.resolve();
          context.onUsage?.({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
        },
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"response.output_text.delta"}\n\n')
          );
        },
      });
    }

    if (this.shouldFailResponsesStream) {
      let emitted = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
            return;
          }
          controller.error(new Error('private upstream stream failure'));
        },
      });
    }

    return streamText('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n');
  }
}

interface WorkerInferenceRouteFixture {
  /** App serving the worker-only routes. */
  readonly app: ReturnType<typeof createApp>;
  /** Core database backing durable worker inference attribution, when configured. */
  readonly coreDb: CoreDb | undefined;
  /** Dispatcher fake shared with the app. */
  readonly dispatcher: FakeWorkerInferenceDispatcher;
  /** Package bound to the worker token. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Marks the durable worker lease unavailable for request-time revalidation. */
  readonly expireLease: () => void;
  /** Durable worker bearer token. */
  readonly token: string;
  /** Worker-control gateway retaining the authenticated package session. */
  readonly workerControlGateway: WorkerControlGateway;
}

const ownedCoreDatabases: CoreDb[] = [];
/** Request body limit shared with the worker inference transport contract. */
const WORKER_INFERENCE_TEST_BODY_LIMIT = 16 * 1024 * 1024;

afterEach(() => {
  for (const coreDb of ownedCoreDatabases.splice(0)) {
    coreDb.sqlite.close();
  }
});

/**
 * Creates one live trusted worker inference session and app.
 *
 * @param trustedRelay Whether the AEP requires the trusted relay capability.
 * @param coreDb Optional shared Core database.
 * @param durableStorage Whether the app receives durable storage.
 * @param includeWorkerProvider Whether the AEP-selected provider is available.
 * @param runtimeProvenance Whether the AEP requires runtime provenance.
 * @returns Route fixture.
 */
function createWorkerInferenceRouteFixture(
  trustedRelay = true,
  coreDb?: CoreDb,
  durableStorage = true,
  includeWorkerProvider = true,
  runtimeProvenance = false
): WorkerInferenceRouteFixture {
  const appCoreDb =
    coreDb ??
    (durableStorage
      ? openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-inference-route-')))
      : undefined);
  if (appCoreDb && !coreDb) {
    applyMigrations(appCoreDb);
    ownedCoreDatabases.push(appCoreDb);
  }
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Call worker inference');
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent: store.getAgent('ws_demo', 'agent_codex_host'),
      agentSessionId: trustedRelay ? 'as_worker_inference_1' : 'as_direct_worker_1',
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      ...(trustedRelay
        ? {
            backendRequirements: {
              allowedKinds: ['openshell' as const],
              preferred: 'openshell' as const,
              requiredCapabilities: [
                'trusted-worker-inference-relay' as const,
                ...(runtimeProvenance ? (['worker.runtime-provenance.v1'] as const) : []),
              ],
            },
          }
        : {}),
      createdAt: '2026-07-13T00:00:00.000Z',
      providerSelection: {
        model: 'openai/gpt-5.2',
        providerId: 'agent-openrouter',
      },
      requestId: 'req_worker_inference_outer_1',
      turn,
      userId: 'user_local',
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  const token = trustedRelay ? 'lease-binding:worker_inference_1' : 'lease-binding:direct_worker_1';
  let leaseLive = true;
  const workerControlGateway = new WorkerControlGateway({
    resolveTokenBinding: () =>
      leaseLive ? { status: 'accepted' } : { reason: 'lease-not-live', status: 'rejected' },
  });
  const dispatcher = new FakeWorkerInferenceDispatcher();

  workerControlGateway.registerSession(environmentPackage, { sandboxBindingRef: token });

  return {
    app: createApp({
      ...(appCoreDb ? { coreDb: appCoreDb } : {}),
      llmGatewayDispatcher: dispatcher as unknown as LLMGatewayProviderDispatcher,
      mode: 'server',
      openKitConfig: {
        defaults: {
          gatewayModel: 'public-model',
          gatewayProviderId: 'public-default',
        },
      },
      providerRegistry: new ProviderRegistry([
        ...(includeWorkerProvider
          ? [
              {
                defaultModel: 'openai/gpt-5.2',
                displayName: 'Agent OpenRouter',
                id: 'agent-openrouter',
                kind: 'gateway' as const,
                models: ['openai/gpt-5.2'],
                vendor: 'openrouter' as const,
              },
            ]
          : []),
        {
          defaultModel: 'public-model',
          displayName: 'Public Default',
          id: 'public-default',
          kind: 'local',
          models: ['public-model'],
          vendor: 'ollama',
        },
      ]),
      store,
      workerControlGateway,
    }),
    coreDb: appCoreDb,
    dispatcher,
    environmentPackage,
    expireLease: () => {
      leaseLive = false;
    },
    token,
    workerControlGateway,
  };
}

/**
 * Creates one byte-preserving text stream.
 *
 * @param value Text to emit once.
 * @returns Readable UTF-8 stream.
 */
function streamText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

/**
 * Reads durable capability calls owned by one worker inference fixture.
 *
 * @param fixture Worker inference route fixture.
 * @returns Capability call rows in creation order.
 */
function readWorkerInferenceCapabilityCalls(
  fixture: WorkerInferenceRouteFixture
): Array<Record<string, unknown>> {
  const workspaceDb = openWorkspaceDb(
    fixture.coreDb!.dataRoot,
    'user_local',
    fixture.environmentPackage.scope.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    return workspaceDb.sqlite
      .prepare(
        `SELECT status, error_code AS errorCode, provider_ref AS providerRef, summary,
                package_snapshot_id AS packageSnapshotId,
                runtime_origin_ref AS runtimeOriginRef,
                runtime_cache_lineage_ref AS runtimeCacheLineageRef
         FROM capability_calls
         ORDER BY started_at ASC, call_id ASC`
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Posts one JSON request to the worker Responses route.
 *
 * @param fixture Worker route fixture.
 * @param body Request body.
 * @param headers Optional extra headers.
 * @returns Route response.
 */
function postWorkerResponses(
  fixture: WorkerInferenceRouteFixture,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fixture.app.request('/api/worker-inference/v1/responses', {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });
}

/**
 * Posts raw bytes to the worker Responses route.
 *
 * @param fixture Worker route fixture.
 * @param body Encoded request body.
 * @param headers Request representation headers.
 * @returns Route response.
 */
function postRawWorkerResponses(
  fixture: WorkerInferenceRouteFixture,
  body: BodyInit,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fixture.app.request('/api/worker-inference/v1/responses', {
    body,
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });
}

describe('worker inference routes', () => {
  it('dispatches canonical Responses through the AEP provider', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const response = await postWorkerResponses(
      fixture,
      {
        client_metadata: { private: true },
        input: 'Hello from the worker',
        metadata: {
          trace: 'preserve-me',
        },
        model: 'openai/gpt-5.2',
        prompt_cache_key: 'raw-worker-cache-key',
        prompt_cache_retention: '24h',
        user: 'caller-controlled-user',
      },
      {
        'x-codex-turn-state': 'worker-request-state',
        'x-request-id': 'private-provider-request-id',
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-codex-turn-state')).toBe('worker-provider-response-state');
    expect(response.headers.get('x-request-id')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ id: 'resp_worker_inference' });
    expect(fixture.dispatcher.responseCalls).toHaveLength(1);
    expect(fixture.dispatcher.responseCalls[0]?.provider.id).toBe('agent-openrouter');
    expect(fixture.dispatcher.responseCalls[0]?.request).toEqual(
      expect.objectContaining({
        input: 'Hello from the worker',
        metadata: { trace: 'preserve-me' },
        model: 'openai/gpt-5.2',
        prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
        prompt_cache_retention: '24h',
        store: false,
        stream: false,
      })
    );
    expect(fixture.dispatcher.responseCalls[0]?.context.transport).toMatchObject({
      codexTurnState: 'worker-request-state',
    });
    expect(JSON.stringify(fixture.dispatcher.responseCalls[0]?.context.transport)).not.toContain(
      'private-provider-request-id'
    );
    expect(JSON.stringify(fixture.dispatcher.responseCalls[0])).not.toContain(
      'raw-worker-cache-key'
    );
    expect(JSON.stringify(fixture.dispatcher.responseCalls[0])).not.toContain(fixture.token);
    expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([
      expect.objectContaining({
        packageSnapshotId: fixture.environmentPackage.snapshotId,
        runtimeCacheLineageRef: null,
        runtimeOriginRef: null,
        summary: expect.stringMatching(/request-scoped cache isolation/i),
      }),
    ]);
  });

  it('dispatches Chat Completions through the AEP provider and model', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const response = await fixture.app.request('/api/worker-inference/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'openai/gpt-5.2',
      }),
      headers: {
        authorization: `Bearer ${fixture.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'chatcmpl_worker_inference' });
    expect(fixture.dispatcher.chatCalls[0]).toMatchObject({
      provider: { id: 'agent-openrouter' },
      request: { model: 'openai/gpt-5.2', stream: false },
    });
  });

  it('consumes canonical Codex runtime hints before shared provider dispatch', async () => {
    const fixture = createWorkerInferenceRouteFixture(true, undefined, true, true, true);
    const turnMetadata = {
      parent_thread_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e04',
      request_kind: 'turn',
      session_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e01',
      subagent_kind: 'thread_spawn',
      thread_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e02',
      turn_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e03',
    };
    const encodedMetadata = JSON.stringify(turnMetadata);
    const response = await postWorkerResponses(
      fixture,
      {
        client_metadata: {
          session_id: turnMetadata.session_id,
          thread_id: turnMetadata.thread_id,
          turn_id: turnMetadata.turn_id,
          'x-codex-parent-thread-id': turnMetadata.parent_thread_id,
          'x-codex-turn-metadata': encodedMetadata,
          'x-openai-subagent': 'collab_spawn',
        },
        input: 'Hello from a Codex child',
        model: 'openai/gpt-5.2',
        prompt_cache_key: 'private-runtime-cache-lineage',
      },
      {
        'session-id': turnMetadata.session_id,
        'thread-id': turnMetadata.thread_id,
        'x-client-request-id': turnMetadata.thread_id,
        'x-codex-parent-thread-id': turnMetadata.parent_thread_id,
        'x-codex-turn-metadata': encodedMetadata,
        'x-openai-subagent': 'collab_spawn',
      }
    );

    expect(response.status).toBe(200);
    expect(fixture.dispatcher.responseCalls[0]?.request).toEqual(
      expect.objectContaining({
        input: 'Hello from a Codex child',
        model: 'openai/gpt-5.2',
        prompt_cache_key: expect.stringMatching(/^openkit:responses:[a-f0-9]{32}$/),
        store: false,
        stream: false,
      })
    );
    expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([
      expect.objectContaining({
        packageSnapshotId: fixture.environmentPackage.snapshotId,
        runtimeCacheLineageRef: expect.stringMatching(/^rcl_[a-f0-9]{24}$/),
        runtimeOriginRef: expect.stringMatching(/^rto_[a-f0-9]{24}$/),
      }),
    ]);
    expect(JSON.stringify(fixture.dispatcher.responseCalls[0])).not.toContain(
      turnMetadata.thread_id
    );
    expect(JSON.stringify(fixture.dispatcher.responseCalls[0])).not.toContain(
      'private-runtime-cache-lineage'
    );
    for (const nativeValue of [
      turnMetadata.session_id,
      turnMetadata.turn_id,
      turnMetadata.parent_thread_id,
      'collab_spawn',
    ]) {
      expect(JSON.stringify(fixture.dispatcher.responseCalls[0])).not.toContain(nativeValue);
      expect(JSON.stringify(readWorkerInferenceCapabilityCalls(fixture))).not.toContain(
        nativeValue
      );
    }
    expect(JSON.stringify(readWorkerInferenceCapabilityCalls(fixture))).not.toContain(
      turnMetadata.thread_id
    );
  });

  it('requires canonical runtime hints for provenance-required packages', async () => {
    const fixture = createWorkerInferenceRouteFixture(true, undefined, true, true, true);
    const response = await postWorkerResponses(fixture, {
      input: 'Missing provenance hint',
      model: 'openai/gpt-5.2',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'worker_inference_invalid_request' },
    });
    expect(fixture.dispatcher.responseCalls).toEqual([]);
    expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([]);
  });

  it('rejects conflicting canonical Codex runtime hints before provider dispatch', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const turnMetadata = {
      request_kind: 'turn',
      session_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e01',
      thread_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e02',
      turn_id: '018f2f55-7f6d-7d95-a4d0-5f4b6f2b5e03',
    };
    const encodedMetadata = JSON.stringify(turnMetadata);
    const response = await postWorkerResponses(
      fixture,
      {
        client_metadata: {
          session_id: turnMetadata.session_id,
          thread_id: turnMetadata.thread_id,
          turn_id: turnMetadata.turn_id,
          'x-codex-turn-metadata': encodedMetadata,
        },
        input: 'Hello',
        model: 'openai/gpt-5.2',
      },
      {
        'session-id': turnMetadata.session_id,
        'thread-id': turnMetadata.thread_id,
        'x-client-request-id': 'spoofed-runtime-thread',
        'x-codex-turn-metadata': encodedMetadata,
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'worker_inference_invalid_request' },
    });
    expect(fixture.dispatcher.responseCalls).toEqual([]);
  });

  it('rejects present malformed canonical Codex metadata before provider dispatch', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const response = await postWorkerResponses(fixture, {
      client_metadata: {
        'x-codex-turn-metadata': { thread_id: 'nested-object' },
      },
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'worker_inference_invalid_request' },
    });
    expect(fixture.dispatcher.responseCalls).toEqual([]);
  });

  it('preserves provider-compatible Chat Completions message fields', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const toolCalls = [
      {
        function: { arguments: '{"path":"README.md"}', name: 'read_file' },
        id: 'call_worker_1',
        type: 'function',
      },
    ];
    const response = await fixture.app.request('/api/worker-inference/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: null, role: 'assistant', tool_calls: toolCalls }],
        model: 'openai/gpt-5.2',
        tools: [{ function: { name: 'read_file' }, type: 'function' }],
      }),
      headers: {
        authorization: `Bearer ${fixture.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(fixture.dispatcher.chatCalls[0]?.request).toMatchObject({
      messages: [{ content: null, role: 'assistant', tool_calls: toolCalls }],
      tools: [{ function: { name: 'read_file' }, type: 'function' }],
    });
  });

  it('preserves Chat Completions and Responses SSE bytes', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const cases = [
      {
        body: { input: 'Hello', model: 'openai/gpt-5.2', stream: true },
        expected: 'data: {"type":"response.completed"}\n\ndata: [DONE]\n\n',
        path: '/api/worker-inference/v1/responses',
      },
      {
        body: {
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'openai/gpt-5.2',
          stream: true,
        },
        expected: 'data: {"id":"chatcmpl_worker_stream"}\n\ndata: [DONE]\n\n',
        path: '/api/worker-inference/v1/chat/completions',
      },
    ];

    for (const testCase of cases) {
      const response = await fixture.app.request(testCase.path, {
        body: JSON.stringify(testCase.body),
        headers: {
          authorization: `Bearer ${fixture.token}`,
          'content-type': 'application/json',
          'x-codex-turn-state': 'worker-stream-request-state',
          'x-request-id': 'private-worker-stream-request-id',
        },
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('x-codex-turn-state')).toBe('worker-provider-response-state');
      expect(response.headers.get('x-request-id')).toBeNull();
      await expect(response.text()).resolves.toBe(testCase.expected);
    }

    expect(fixture.dispatcher.responseCalls[0]?.context.transport).toMatchObject({
      codexTurnState: 'worker-stream-request-state',
    });
    expect(fixture.dispatcher.chatCalls[0]?.context.transport).toMatchObject({
      codexTurnState: 'worker-stream-request-state',
    });
  });

  it('cancels worker inference streams once and preserves one cancelled ledger outcome', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    fixture.dispatcher.shouldHoldResponsesStream = true;
    const request = new Request('http://localhost/api/worker-inference/v1/responses', {
      body: JSON.stringify({
        input: 'Wait for cancellation',
        model: 'openai/gpt-5.2',
        stream: true,
      }),
      headers: {
        authorization: `Bearer ${fixture.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const response = await fixture.app.fetch(request);
    const dispatchSignal = (
      fixture.dispatcher.responseCalls[0]?.context.transport as
        | { readonly signal?: AbortSignal }
        | undefined
    )?.signal;
    const reader = response.body!.getReader();

    expect(response.status).toBe(200);
    expect(dispatchSignal).toBe(request.signal);
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel('consumer disconnected');

    expect(fixture.dispatcher.responsesStreamCancellations).toEqual(['consumer disconnected']);
    expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([
      expect.objectContaining({
        errorCode: 'worker_inference_cancelled',
        status: 'cancelled',
      }),
    ]);
    expect(() =>
      fixture.dispatcher.responseCalls[0]?.context.onUsage?.({
        input_tokens: 99,
        output_tokens: 99,
        total_tokens: 198,
      })
    ).not.toThrow();

    const workspaceDb = openWorkspaceDb(
      fixture.coreDb!.dataRoot,
      'user_local',
      fixture.environmentPackage.scope.workspaceId
    );
    try {
      applyScopedMigrations(workspaceDb);
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT outcome, error_code AS errorCode
             FROM audit_events
             WHERE action = 'capability.finish'
             ORDER BY created_at ASC`
          )
          .all()
      ).toEqual([{ errorCode: 'worker_inference_cancelled', outcome: 'cancelled' }]);
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT quantity, source, unit
             FROM usage_records
             ORDER BY source ASC`
          )
          .all()
      ).toEqual([
        {
          quantity: 3,
          source: 'llm-gateway-adapter-reported:input',
          unit: 'tokens',
        },
        {
          quantity: 1,
          source: 'llm-gateway-adapter-reported:output',
          unit: 'tokens',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('emits a bounded SSE heartbeat while worker inference is idle', async () => {
    vi.useFakeTimers();
    const fixture = createWorkerInferenceRouteFixture();
    fixture.dispatcher.shouldHoldResponsesStream = true;
    const response = await postWorkerResponses(fixture, {
      input: 'Wait through one idle interval',
      model: 'openai/gpt-5.2',
      stream: true,
    });
    const reader = response.body!.getReader();

    try {
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      let heartbeat: ReadableStreamReadResult<Uint8Array> | null = null;
      void reader.read().then((result) => {
        heartbeat = result;
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(heartbeat).toEqual({
        done: false,
        value: new TextEncoder().encode(': openkit-worker-inference-heartbeat\n\n'),
      });
    } finally {
      await reader.cancel('heartbeat test completed');
      vi.useRealTimers();
    }
  });

  it('cancels the upstream stream when a real HTTP consumer disconnects', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    fixture.dispatcher.shouldHoldResponsesStream = true;
    const server = serve({ fetch: fixture.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Worker inference network test did not bind a TCP address.');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/worker-inference/v1/responses`,
        {
          body: JSON.stringify({
            input: 'Wait for network cancellation',
            model: 'openai/gpt-5.2',
            stream: true,
          }),
          headers: {
            authorization: `Bearer ${fixture.token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        }
      );
      const reader = response.body!.getReader();

      expect(response.status).toBe(200);
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      await reader.cancel('network consumer disconnected');
      await vi.waitFor(() => {
        expect(fixture.dispatcher.responsesStreamCancellations).toHaveLength(1);
      });
      expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([
        expect.objectContaining({
          errorCode: 'worker_inference_cancelled',
          status: 'cancelled',
        }),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    {
      caseName: 'request-signal cancellation',
      error: 'signal-reason' as const,
      expectedCode: 'worker_inference_cancelled',
      expectedLedgerCode: 'worker_inference_cancelled',
      expectedStatus: 499,
      expectedLedgerStatus: 'cancelled',
    },
    {
      caseName: 'independent provider failure after request abort',
      error: new Error('private independent provider failure'),
      expectedCode: 'worker_inference_request_failed',
      expectedLedgerCode: 'worker_inference_failed',
      expectedStatus: 400,
      expectedLedgerStatus: 'failed',
    },
  ])('classifies $caseName by the thrown error cause', async (testCase) => {
    const fixture = createWorkerInferenceRouteFixture();
    const abortController = new AbortController();
    fixture.dispatcher.responseErrorAfterAbort = testCase.error;
    const responsePromise = fixture.app.fetch(
      new Request('http://localhost/api/worker-inference/v1/responses', {
        body: JSON.stringify({ input: 'Wait for abort', model: 'openai/gpt-5.2' }),
        headers: {
          authorization: `Bearer ${fixture.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: abortController.signal,
      })
    );

    await expect.poll(() => fixture.dispatcher.responseCalls.length).toBe(1);
    abortController.abort(new DOMException('Worker request cancelled.', 'AbortError'));
    const response = await responsePromise;

    expect(response.status).toBe(testCase.expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: testCase.expectedCode },
    });
    expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([
      expect.objectContaining({
        errorCode: testCase.expectedLedgerCode,
        status: testCase.expectedLedgerStatus,
      }),
    ]);
  });

  it('preserves sanitized terminal SSE when durable finish audit insertion fails', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const workspaceDb = openWorkspaceDb(
      fixture.coreDb!.dataRoot,
      'user_local',
      fixture.environmentPackage.scope.workspaceId
    );

    try {
      applyScopedMigrations(workspaceDb);
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER reject_worker_inference_finish_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'capability.finish'
        BEGIN
          SELECT RAISE(ABORT, 'private capability finish audit trigger failure');
        END
      `);
    } finally {
      workspaceDb.sqlite.close();
    }

    const response = await postWorkerResponses(fixture, {
      input: 'Finish despite audit failure',
      model: 'openai/gpt-5.2',
      stream: true,
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('data: {"type":"response.completed"}');
    expect(body).toContain('data: [DONE]');
    expect(body).not.toContain('private capability finish audit trigger failure');
  });

  it('records a fresh durable capability request for every worker call', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-inference-ledger-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const fixture = createWorkerInferenceRouteFixture(true, coreDb);

      await postWorkerResponses(fixture, {
        input: 'First sibling call',
        model: 'openai/gpt-5.2',
      });
      await postWorkerResponses(fixture, {
        input: 'Second sibling call',
        model: 'openai/gpt-5.2',
      });

      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_demo');
      try {
        applyScopedMigrations(workspaceDb);
        const calls = workspaceDb.sqlite
          .prepare(
            `SELECT request_id AS requestId, workspace_id AS workspaceId,
                    thread_id AS threadId, turn_id AS turnId, agent_id AS agentId,
                    agent_session_id AS agentSessionId, provider_ref AS providerRef,
                    capability_id AS capabilityId, operation, status
             FROM capability_calls
             ORDER BY started_at ASC, call_id ASC`
          )
          .all() as Array<Record<string, unknown>>;

        expect(calls).toHaveLength(2);
        expect(new Set(calls.map((call) => call.requestId)).size).toBe(2);
        expect(calls.map((call) => call.requestId)).not.toContain(
          fixture.environmentPackage.scope.requestId
        );
        expect(calls).toEqual([
          expect.objectContaining({
            agentId: fixture.environmentPackage.agent.agentId,
            agentSessionId: fixture.environmentPackage.scope.agentSessionId,
            capabilityId: 'llm.responses',
            operation: 'responses',
            providerRef: 'agent-openrouter',
            status: 'succeeded',
            threadId: fixture.environmentPackage.scope.threadId,
            turnId: fixture.environmentPackage.scope.turnId,
            workspaceId: fixture.environmentPackage.scope.workspaceId,
          }),
          expect.objectContaining({ status: 'succeeded' }),
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects missing, invalid, and non-relay worker identity', async () => {
    const trusted = createWorkerInferenceRouteFixture();
    const direct = createWorkerInferenceRouteFixture(false);
    const requests = [
      trusted.app.request('/api/worker-inference/v1/responses', {
        body: JSON.stringify({ input: 'Hello', model: 'openai/gpt-5.2' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      trusted.app.request('/api/worker-inference/v1/responses', {
        body: JSON.stringify({ input: 'Hello', model: 'openai/gpt-5.2' }),
        headers: { authorization: 'Bearer okt_product_token', 'content-type': 'application/json' },
        method: 'POST',
      }),
      postWorkerResponses(direct, { input: 'Hello', model: 'openai/gpt-5.2' }),
    ];

    for (const pending of requests) {
      const response = await pending;

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_unauthorized' },
      });
    }
    expect(trusted.dispatcher.responseCalls).toEqual([]);
    expect(direct.dispatcher.responseCalls).toEqual([]);
  });

  it('rejects caller authority conflicts before provider dispatch', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const conflicts = [
      { model: 'other-model' },
      { model_id: 'other-model' },
      { providerId: 'public-default' },
      { provider_ref: 'public-default' },
      { workspaceId: 'ws_other' },
      { metadata: { openkit: { requestId: 'req_other' } } },
      { policy: { mode: 'allow' } },
    ];

    for (const conflict of conflicts) {
      const response = await postWorkerResponses(fixture, {
        input: 'Hello',
        model: 'openai/gpt-5.2',
        ...conflict,
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_lineage_mismatch' },
      });
    }

    const headerConflict = await postWorkerResponses(
      fixture,
      { input: 'Hello', model: 'openai/gpt-5.2' },
      { 'x-openkit-workspace-id': 'ws_demo' }
    );

    expect(headerConflict.status).toBe(403);
    expect(fixture.dispatcher.responseCalls).toEqual([]);
  });

  it('rejects caller authority aliases even when they match trusted AEP authority', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const scope = fixture.environmentPackage.scope;
    const aliases = [
      { provider_id: 'agent-openrouter' },
      { workspaceId: scope.workspaceId },
      { agent_session_id: scope.agentSessionId },
      { package_snapshot_id: fixture.environmentPackage.snapshotId },
      { request_id: scope.requestId },
      { metadata: { openkit: { routeId: 'nanocore-gateway' } } },
    ];

    for (const alias of aliases) {
      const response = await postWorkerResponses(fixture, {
        input: 'Hello',
        model: 'openai/gpt-5.2',
        ...alias,
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_lineage_mismatch' },
      });
    }
    expect(fixture.dispatcher.responseCalls).toEqual([]);
  });

  it('fails closed when the durable lease dies or a restored session has no AEP', async () => {
    const deadLease = createWorkerInferenceRouteFixture();
    deadLease.expireLease();
    const deadLeaseResponse = await postWorkerResponses(deadLease, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });

    expect(deadLeaseResponse.status).toBe(403);
    await expect(deadLeaseResponse.json()).resolves.toMatchObject({
      error: { code: 'worker_inference_unauthorized' },
    });
    expect(deadLease.dispatcher.responseCalls).toEqual([]);

    const unhydrated = createWorkerInferenceRouteFixture();
    const scope = unhydrated.environmentPackage.scope;
    unhydrated.workerControlGateway.unregisterSession(unhydrated.environmentPackage.snapshotId);
    unhydrated.workerControlGateway.restoreSession({
      lineage: {
        agentSessionId: scope.agentSessionId,
        packageSnapshotId: unhydrated.environmentPackage.snapshotId,
        requestId: scope.requestId ?? null,
        threadId: scope.threadId,
        turnId: scope.turnId,
        workspaceId: scope.workspaceId,
      },
      registeredAt: '2026-07-13T00:00:01.000Z',
      token: unhydrated.token,
    });
    const unhydratedResponse = await postWorkerResponses(unhydrated, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });

    expect(unhydratedResponse.status).toBe(401);
    await expect(unhydratedResponse.json()).resolves.toMatchObject({
      error: { code: 'worker_inference_unauthorized' },
    });
    expect(unhydrated.dispatcher.responseCalls).toEqual([]);
  });

  it('strips cache hints and rejects provider-side state authority', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const scope = fixture.environmentPackage.scope;
    const accepted = await postWorkerResponses(fixture, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
      prompt_cache_key: 'runtime-private-cache-key',
      safety_identifier: 'caller-safety-id',
      sessionId: 'runtime-cache-session',
      store: false,
    });

    expect(accepted.status).toBe(200);
    expect(fixture.dispatcher.responseCalls[0]?.request).toEqual({
      input: 'Hello',
      model: 'openai/gpt-5.2',
      prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
      store: false,
      stream: false,
    });

    const conflicts = [
      { store: true },
      { previous_response_id: 'resp_shared_provider_state' },
      { conversation: 'conv_shared_provider_state' },
      { background: true },
      { service_tier: 'priority' },
      { openkit: { workspaceId: scope.workspaceId } },
      { lineage: { workspaceId: scope.workspaceId } },
      { scope: { workspaceId: scope.workspaceId } },
      { access_token: 'caller-token' },
      { client_secret: 'caller-secret' },
      { sourceId: 'source-caller' },
      { tools: [{ server_url: 'https://attacker.example/mcp', type: 'mcp' }] },
      { tools: [{ type: 'web_search_preview' }] },
      { tools: [{}] },
      { tools: [{ type: 7 }] },
    ];

    for (const conflict of conflicts) {
      const response = await postWorkerResponses(fixture, {
        input: 'Hello',
        model: 'openai/gpt-5.2',
        ...conflict,
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_lineage_mismatch' },
      });
    }
    expect(fixture.dispatcher.responseCalls).toHaveLength(1);
  });

  it('rejects worker inference when durable capability storage is unavailable', async () => {
    const fixture = createWorkerInferenceRouteFixture(true, undefined, false);
    const response = await postWorkerResponses(fixture, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'worker_inference_unavailable' },
    });
    expect(fixture.dispatcher.responseCalls).toEqual([]);
  });

  it('projects durable workspace failures as worker inference unavailability', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const originalDataRoot = fixture.coreDb!.dataRoot;
    const blockedParent = mkdtempSync(join(tmpdir(), 'openkit-worker-inference-blocked-'));
    const blockedDataRoot = join(blockedParent, 'not-a-directory');
    writeFileSync(blockedDataRoot, 'blocked');
    fixture.coreDb!.dataRoot = blockedDataRoot;

    try {
      const response = await postWorkerResponses(fixture, {
        input: 'Hello',
        model: 'openai/gpt-5.2',
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_unavailable' },
      });
      expect(fixture.dispatcher.responseCalls).toEqual([]);
    } finally {
      fixture.coreDb!.dataRoot = originalDataRoot;
      rmSync(blockedParent, { force: true, recursive: true });
    }
  });

  it('marks dispatch and response serialization failures in the durable ledger', async () => {
    const dispatchFailure = createWorkerInferenceRouteFixture();
    dispatchFailure.dispatcher.responseError = new Error('private provider failure');
    const rejected = await postWorkerResponses(dispatchFailure, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });

    expect(rejected.status).toBe(400);
    expect(readWorkerInferenceCapabilityCalls(dispatchFailure)).toEqual([
      expect.objectContaining({ errorCode: 'worker_inference_failed', status: 'failed' }),
    ]);

    const serializationFailure = createWorkerInferenceRouteFixture();
    const cyclicResponse: Record<string, unknown> = {
      id: 'resp_cyclic',
      object: 'response',
      output: [],
      status: 'completed',
    };
    cyclicResponse.self = cyclicResponse;
    serializationFailure.dispatcher.responsesResponseOverride =
      cyclicResponse as OpenAICompatibleResponsesResponse;
    const unserializable = await postWorkerResponses(serializationFailure, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });

    expect(unserializable.status).toBe(400);
    expect(readWorkerInferenceCapabilityCalls(serializationFailure)).toEqual([
      expect.objectContaining({ errorCode: 'worker_inference_failed', status: 'failed' }),
    ]);
  });

  it('projects typed provider request failures as redacted worker errors', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    fixture.dispatcher.responseError = new OpenAICompatibleProviderError({
      code: 'model_not_supported',
      message: 'Unsupported model token=tok_secret',
      status: 400,
      type: 'provider_error',
    });

    const response = await postWorkerResponses(fixture, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });
    const body = await response.json();
    const calls = readWorkerInferenceCapabilityCalls(fixture);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'gateway_provider_request_invalid',
        message: 'Unsupported model token=[redacted]',
        type: 'provider_error',
      },
    });
    expect(calls).toEqual([
      expect.objectContaining({ errorCode: 'worker_inference_failed', status: 'failed' }),
    ]);
    expect(JSON.stringify({ body, calls })).not.toContain('tok_secret');
  });

  it('marks post-start stream read failures before emitting terminal SSE', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    fixture.dispatcher.shouldFailResponsesStream = true;
    const response = await postWorkerResponses(fixture, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
      stream: true,
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('gateway_stream_failed');
    expect(body).not.toContain('private upstream stream failure');
    expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([
      expect.objectContaining({
        errorCode: 'worker_inference_stream_failed',
        status: 'failed',
      }),
    ]);
  });

  it('records provider registry drift as a failed capability call without fallback', async () => {
    const fixture = createWorkerInferenceRouteFixture(true, undefined, true, false);
    const response = await postWorkerResponses(fixture, {
      input: 'Hello',
      model: 'openai/gpt-5.2',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'worker_inference_provider_unavailable' },
    });
    expect(fixture.dispatcher.responseCalls).toEqual([]);

    expect(readWorkerInferenceCapabilityCalls(fixture)).toEqual([
      expect.objectContaining({
        errorCode: 'worker_inference_provider_unavailable',
        packageSnapshotId: fixture.environmentPackage.snapshotId,
        providerRef: 'agent-openrouter',
        runtimeCacheLineageRef: null,
        runtimeOriginRef: null,
        status: 'failed',
      }),
    ]);
  });

  it('decodes identity and Zstd JSON into the same provider request', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const body = JSON.stringify({ input: 'Compressed worker input', model: 'openai/gpt-5.2' });
    const identity = await postRawWorkerResponses(fixture, body);
    const compressed = await postRawWorkerResponses(fixture, zstdCompressSync(body), {
      'content-encoding': 'zstd',
    });

    expect(identity.status).toBe(200);
    expect(compressed.status).toBe(200);
    expect(fixture.dispatcher.responseCalls).toHaveLength(2);
    for (const call of fixture.dispatcher.responseCalls) {
      expect(call.request).toEqual(
        expect.objectContaining({
          input: 'Compressed worker input',
          model: 'openai/gpt-5.2',
          prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
          store: false,
          stream: false,
        })
      );
    }
    expect(fixture.dispatcher.responseCalls[1]?.request.prompt_cache_key).not.toBe(
      fixture.dispatcher.responseCalls[0]?.request.prompt_cache_key
    );
  });

  it('rejects unsupported representations and malformed worker JSON', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const cases = [
      {
        body: JSON.stringify({ input: 'Hello', model: 'openai/gpt-5.2' }),
        code: 'worker_inference_unsupported_media_type',
        headers: { 'content-type': 'text/plain' },
        status: 415,
      },
      {
        body: JSON.stringify({ input: 'Hello', model: 'openai/gpt-5.2' }),
        code: 'worker_inference_unsupported_content_encoding',
        headers: { 'content-encoding': 'gzip' },
        status: 415,
      },
      {
        body: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff]),
        code: 'worker_inference_invalid_request',
        headers: { 'content-encoding': 'zstd' },
        status: 400,
      },
      {
        body: Buffer.from([0xff]),
        code: 'worker_inference_invalid_request',
        headers: {},
        status: 400,
      },
      {
        body: '{',
        code: 'worker_inference_invalid_request',
        headers: {},
        status: 400,
      },
    ];

    for (const testCase of cases) {
      const response = await postRawWorkerResponses(fixture, testCase.body, testCase.headers);

      expect(response.status).toBe(testCase.status);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: testCase.code },
      });
    }
    expect(fixture.dispatcher.responseCalls).toEqual([]);
  });

  it('rejects encoded and decoded worker bodies above the fixed limit', async () => {
    const fixture = createWorkerInferenceRouteFixture();
    const encodedOverflow = await postRawWorkerResponses(
      fixture,
      Buffer.alloc(WORKER_INFERENCE_TEST_BODY_LIMIT + 1, 0x20)
    );
    const decodedBody = JSON.stringify({
      input: 'x'.repeat(WORKER_INFERENCE_TEST_BODY_LIMIT),
      model: 'openai/gpt-5.2',
    });
    const decodedOverflow = await postRawWorkerResponses(fixture, zstdCompressSync(decodedBody), {
      'content-encoding': 'zstd',
    });

    for (const response of [encodedOverflow, decodedOverflow]) {
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_payload_too_large' },
      });
    }
    expect(fixture.dispatcher.responseCalls).toEqual([]);
  });
});
