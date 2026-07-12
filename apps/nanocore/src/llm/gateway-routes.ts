import { randomUUID } from 'node:crypto';

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import type { AuthVariables } from '../auth/middleware.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import type { FsStore } from '../lib/store.js';
import { recordGatewayPolicyDecision } from '../policy/permission-decisions.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { GatewayUnsupportedFeatureError } from './gateway-converters.js';
import type { GatewayPolicyStore } from './gateway-policy.js';
import { parseUsage } from './gateway-usage.js';
import {
  type OpenAICompatibleChatCompletionResponse,
  type OpenAICompatibleChatMessage,
  OpenAICompatibleProviderError,
  type OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import type { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

const GatewayChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
            content: z.union([z.string(), z.array(z.unknown()), z.null()]),
            tool_call_id: z.string().optional(),
          })
          .passthrough()
      )
      .min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();
const GatewayResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]),
    stream: z.boolean().optional(),
  })
  .passthrough();

/** Public LLM gateway lineage accepted from `metadata.openkit`. */
interface PublicLlmGatewayLineage {
  /** Workspace that owns the gateway request. */
  workspaceId: string;
  /** Thread lineage when available. */
  threadId?: string;
  /** Turn lineage when available. */
  turnId?: string;
  /** Item lineage when available. */
  itemId?: string;
  /** Agent lineage when available. */
  agentId?: string;
  /** Agent session lineage when available. */
  agentSessionId?: string;
  /** Client-supplied request id used for durable idempotency. */
  requestId?: string;
  /** Workspace source ids attributed to the call. */
  sourceIds?: string[];
}

/** Started public gateway call with its workspace database handle. */
interface PublicLlmGatewayCall {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Started capability call row. */
  call: ReturnType<typeof startCapabilityCall>;
}

/**
 * Starts one durable public LLM gateway call when the call is attributable.
 *
 * @param input Provider, request, and storage context.
 * @returns Started call or null when durable attribution is unavailable.
 */
function startPublicLlmGatewayCall(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Provider selected for the public gateway call. */
  provider: ResolvedLLMProviderConfig;
  /** Gateway endpoint family. */
  endpoint: 'chat_completions' | 'responses';
  /** OpenAI-compatible request metadata. */
  metadata: unknown;
}): PublicLlmGatewayCall | null {
  if (!input.coreDb) {
    return null;
  }

  const lineage = readPublicLlmGatewayLineage(input.metadata);

  if (!lineage) {
    return null;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);

    return {
      call: startCapabilityCall({
        agentId: lineage.agentId ?? null,
        agentSessionId: lineage.agentSessionId ?? null,
        capabilityId: `llm.${input.endpoint}`,
        family: 'llm',
        itemId: lineage.itemId ?? null,
        operation: input.endpoint,
        providerRef: input.provider.id,
        redactionClass: 'metadata-only',
        requestId: lineage.requestId ?? randomUUID(),
        serviceRef: 'llm-gateway',
        sourceIds: lineage.sourceIds ?? [],
        summary: `Public ${input.endpoint} LLM gateway call.`,
        threadId: lineage.threadId ?? null,
        turnId: lineage.turnId ?? null,
        workspaceDb,
        workspaceId: lineage.workspaceId,
      }),
      workspaceDb,
    };
  } catch (error) {
    workspaceDb.sqlite.close();
    throw error;
  }
}

/**
 * Records durable usage for one public LLM gateway response.
 *
 * @param input Started call and response usage.
 */
function recordPublicLlmGatewayUsage(input: {
  /** Started durable call. */
  durableCall: PublicLlmGatewayCall | null;
  /** Provider selected for the call. */
  provider: ResolvedLLMProviderConfig;
  /** Model requested by the client. */
  model: string;
  /** Provider usage payload. */
  usage: unknown;
}): void {
  if (!input.durableCall) {
    return;
  }

  const parsed = parseUsage(input.usage);
  const records = [
    {
      quantity: parsed.inputTokens,
      source: 'llm-gateway-adapter-reported:input',
      unit: 'tokens' as const,
    },
    {
      quantity: parsed.completionTokens,
      source: 'llm-gateway-adapter-reported:output',
      unit: 'tokens' as const,
    },
    {
      quantity: parsed.cachedInputTokens,
      source: 'llm-gateway-adapter-reported:cache_read',
      unit: 'tokens' as const,
    },
    {
      quantity: parsed.cacheWriteTokens,
      source: 'llm-gateway-adapter-reported:cache_write',
      unit: 'tokens' as const,
    },
    {
      quantity:
        parsed.inputTokens ||
        parsed.completionTokens ||
        parsed.cachedInputTokens ||
        parsed.cacheWriteTokens
          ? 0
          : parsed.totalTokens,
      source: 'llm-gateway-adapter-reported:total',
      unit: 'tokens' as const,
    },
    {
      quantity: parsed.costEstimateUsd,
      source: 'llm-gateway-adapter-reported:cost_estimate',
      unit: 'usd' as const,
    },
  ].flatMap((record) =>
    record.quantity > 0
      ? [
          {
            category: 'llm' as const,
            modelId: input.model,
            providerRef: input.provider.id,
            quantity: record.quantity,
            source: record.source,
            unit: record.unit,
          },
        ]
      : []
  );

  if (!records.length) {
    return;
  }

  recordUsage({
    call: input.durableCall.call,
    records,
    workspaceDb: input.durableCall.workspaceDb,
  });
}

/**
 * Marks a public LLM gateway call terminal and closes its workspace database.
 *
 * @param durableCall Started durable call, when any.
 * @param status Terminal status.
 * @param errorCode Stable error code for failed calls.
 */
function finishPublicLlmGatewayCall(
  durableCall: PublicLlmGatewayCall | null,
  status: 'succeeded' | 'failed',
  errorCode?: string
): void {
  if (!durableCall) {
    return;
  }

  try {
    finishCapabilityCall({
      callId: durableCall.call.id,
      ...(errorCode ? { errorCode } : {}),
      status,
      workspaceDb: durableCall.workspaceDb,
    });
  } finally {
    durableCall.workspaceDb.sqlite.close();
  }
}

/**
 * Finishes a durable public LLM gateway call when a response stream is consumed.
 *
 * @param stream Provider SSE stream after usage observation.
 * @param durableCall Started durable call, when any.
 * @returns Stream that preserves original bytes.
 */
function finishPublicLlmGatewayStream(
  stream: ReadableStream<Uint8Array>,
  durableCall: PublicLlmGatewayCall | null
): ReadableStream<Uint8Array> {
  if (!durableCall) {
    return stream;
  }

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const reader = stream.getReader();

      try {
        while (true) {
          const result = await reader.read();

          if (result.done) {
            break;
          }

          controller.enqueue(result.value);
        }

        finishPublicLlmGatewayCall(durableCall, 'succeeded');
        controller.close();
      } catch (error) {
        finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_stream_failed');
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/**
 * Reads public LLM gateway attribution from OpenAI-compatible metadata.
 *
 * @param metadata Request metadata object.
 * @returns Durable lineage when workspace attribution is present.
 */
function readPublicLlmGatewayLineage(metadata: unknown): PublicLlmGatewayLineage | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const openkit = (metadata as Record<string, unknown>).openkit;

  if (!openkit || typeof openkit !== 'object') {
    return null;
  }

  const record = openkit as Record<string, unknown>;
  const workspaceId = readPublicGatewayString(record.workspaceId);

  if (!workspaceId) {
    return null;
  }

  const threadId = readPublicGatewayString(record.threadId);
  const turnId = readPublicGatewayString(record.turnId);
  const itemId = readPublicGatewayString(record.itemId);
  const agentId = readPublicGatewayString(record.agentId);
  const agentSessionId = readPublicGatewayString(record.agentSessionId);
  const requestId = readPublicGatewayString(record.requestId);
  const sourceIds = readPublicGatewayStringArray(record.sourceIds);

  return {
    workspaceId,
    ...(agentId ? { agentId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(sourceIds ? { sourceIds } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

/**
 * Reads a non-empty metadata string.
 *
 * @param value Candidate metadata value.
 * @returns Trimmed string when present.
 */
function readPublicGatewayString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Reads a metadata string array.
 *
 * @param value Candidate metadata value.
 * @returns Trimmed string array when present.
 */
function readPublicGatewayStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.flatMap((item) => {
    const text = readPublicGatewayString(item);

    return text ? [text] : [];
  });

  return values.length ? [...new Set(values)].sort() : undefined;
}

/**
 * Converts gateway dispatch failures into OpenAI-compatible error envelopes.
 */
function asOpenAIGatewayError(error: unknown): Response {
  if (error instanceof GatewayUnsupportedFeatureError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: 'invalid_request_error',
          code: error.code,
        },
      },
      { status: error.status }
    );
  }

  if (error instanceof OpenAICompatibleProviderError) {
    const normalized = classifyGatewayProviderFailure(error, 'provider_error');

    return Response.json(
      {
        error: {
          message: redactInternalAgentText(error.message),
          type: normalized.type,
          code: normalized.code,
        },
      },
      { status: error.status }
    );
  }

  return Response.json(
    {
      error: {
        message: (error as Error).message,
        type: 'invalid_request_error',
        code: 'gateway_request_failed',
      },
    },
    { status: 400 }
  );
}

/**
 * Gateway streaming endpoint family used for terminal SSE normalization.
 */
type GatewayStreamingEndpoint = 'chat_completions' | 'responses';

/**
 * Wraps a provider SSE stream so post-start read failures become terminal SSE events.
 *
 * @param stream Upstream or bridged provider SSE stream.
 * @param endpoint Gateway endpoint family being streamed.
 * @returns Stream that preserves bytes and appends a terminal error event on read failure.
 */
function normalizeGatewayTerminalStream(
  stream: ReadableStream<Uint8Array>,
  endpoint: GatewayStreamingEndpoint
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();

      try {
        while (true) {
          const result = await reader.read();

          if (result.done) {
            break;
          }

          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.enqueue(encoder.encode(createGatewayTerminalErrorSse(error, endpoint)));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

/**
 * Creates an OpenAI-compatible terminal SSE error payload with a stable stop reason.
 *
 * @param error Unknown stream read error.
 * @param endpoint Gateway endpoint family being streamed.
 * @returns Terminal SSE bytes as text.
 */
function createGatewayTerminalErrorSse(error: unknown, endpoint: GatewayStreamingEndpoint): string {
  const normalized = classifyGatewayProviderFailure(error, 'gateway_stream_failed');
  const payload = {
    error: {
      message: redactInternalAgentText(error instanceof Error ? error.message : String(error)),
      type: normalized.type,
      code: normalized.code,
      endpoint,
    },
    stopReason: 'error',
  };

  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
}

/**
 * Normalizes provider failure signal into stable public gateway error identity.
 *
 * @param error Unknown provider or stream failure.
 * @param fallbackCode Stable code used when the failure has no known provider signal.
 * @returns Public gateway error type and code.
 */
function classifyGatewayProviderFailure(error: unknown, fallbackCode: string) {
  const detail = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const status = typeof detail.status === 'number' ? detail.status : undefined;
  const type = typeof detail.type === 'string' ? detail.type : 'provider_error';
  const code = typeof detail.code === 'string' ? detail.code : '';
  const message = error instanceof Error ? error.message : String(error);
  const signal = `${code} ${type} ${message}`.toLowerCase();

  if (code.startsWith('vault-')) {
    return { type, code };
  }
  if (
    status === 401 ||
    status === 403 ||
    /\b(auth|authentication|unauthorized|forbidden)\b/.test(signal)
  ) {
    return { type, code: 'gateway_provider_authentication_failed' };
  }
  if (status === 429 || /\b(rate[_ -]?limit|quota|too many requests)\b/.test(signal)) {
    return { type, code: 'gateway_provider_rate_limited' };
  }
  if (/\b(context|token|input).*\b(overflow|exceed|too long|maximum|max)\b/.test(signal)) {
    return { type, code: 'gateway_context_overflow' };
  }
  if (
    status === 400 ||
    status === 422 ||
    /\b(invalid[_ -]?request|validation|bad request|malformed)\b/.test(signal)
  ) {
    return { type, code: 'gateway_provider_request_invalid' };
  }
  if (
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /\b(unavailable|overloaded|timeout|timed out|server error)\b/.test(signal)
  ) {
    return { type, code: 'gateway_provider_unavailable' };
  }

  return { type, code: fallbackCode };
}

/**
 * Registers the public OpenAI-compatible LLM Gateway routes.
 *
 * @param dependencies Hono app and current Gateway runtime dependencies.
 */
export function registerLlmGatewayRoutes({
  app,
  coreDb,
  gatewayDefaultProviderId,
  gatewayPolicyStore,
  llmGatewayDispatcher,
  requestStore,
  resolveGatewayProvider,
  runtimeConfig,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb?: CoreDb;
  readonly gatewayDefaultProviderId: () => string | null;
  readonly gatewayPolicyStore: GatewayPolicyStore;
  readonly llmGatewayDispatcher: LLMGatewayProviderDispatcher;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly resolveGatewayProvider: (providerId: string) => ResolvedLLMProviderConfig;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
}): void {
  /**
   * Checks whether the Gateway is enabled by runtime config and policy store.
   *
   * @returns True when Gateway routes are enabled.
   */
  function isGatewayEnabled(): boolean {
    return (
      gatewayPolicyStore.getPolicy().enabled &&
      runtimeConfig().openKitConfig.gateway?.openaiCompatible?.enabled !== false
    );
  }

  /**
   * Checks whether a provider id is allowed by runtime config and policy store.
   *
   * @param providerId Provider id to check.
   * @returns True when Gateway routing is allowed.
   */
  function isGatewayProviderAllowed(providerId: string): boolean {
    const runtimeAllowlist =
      runtimeConfig().openKitConfig.gateway?.openaiCompatible?.allowedProviderIds;

    return (
      gatewayPolicyStore.allowsProvider(providerId) &&
      (!runtimeAllowlist || runtimeAllowlist.includes(providerId))
    );
  }

  /**
   * Records an LLM gateway policy decision when durable storage is available.
   *
   * @param input Gateway policy decision details.
   */
  function recordLlmGatewayPolicyDecision(input: {
    action: 'llm.gateway.chat_completions' | 'llm.gateway.responses';
    providerId?: string | null;
    reasonCode: 'gateway_allowed' | 'gateway_disabled' | 'gateway_provider_not_allowed';
    result: 'allow' | 'deny';
    route: '/v1/chat/completions' | '/v1/responses';
  }): void {
    if (!coreDb) {
      return;
    }

    try {
      recordGatewayPolicyDecision({ coreDb, ...input });
    } catch (error) {
      console.warn(
        `Failed to record gateway policy decision: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  app.get('/v1/models', (c) => {
    return c.json({
      object: 'list',
      data: runtimeConfig()
        .providerRegistry.list()
        .flatMap((provider) =>
          provider.models.map((model) => ({
            id: model,
            object: 'model',
            owned_by: provider.id,
          }))
        ),
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    try {
      const input = GatewayChatCompletionRequestSchema.parse(await c.req.json());
      const providerId = gatewayDefaultProviderId();

      if (!isGatewayEnabled()) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.chat_completions',
          providerId,
          reasonCode: 'gateway_disabled',
          result: 'deny',
          route: '/v1/chat/completions',
        });
        return c.json(
          {
            error: {
              message: 'Gateway is disabled by policy.',
              type: 'invalid_request_error',
              code: 'gateway_disabled',
            },
          },
          403
        );
      }

      if (!providerId) {
        return c.json(
          {
            error: {
              message: 'Gateway requires a default provider.',
              type: 'invalid_request_error',
              code: 'gateway_not_configured',
            },
          },
          400
        );
      }

      if (!isGatewayProviderAllowed(providerId)) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.chat_completions',
          providerId,
          reasonCode: 'gateway_provider_not_allowed',
          result: 'deny',
          route: '/v1/chat/completions',
        });
        return c.json(
          {
            error: {
              message: `Gateway policy does not allow provider: ${providerId}`,
              type: 'invalid_request_error',
              code: 'gateway_provider_not_allowed',
            },
          },
          403
        );
      }

      recordLlmGatewayPolicyDecision({
        action: 'llm.gateway.chat_completions',
        providerId,
        reasonCode: 'gateway_allowed',
        result: 'allow',
        route: '/v1/chat/completions',
      });

      const provider = resolveGatewayProvider(providerId);
      const request = {
        ...input,
        messages: input.messages.map((message): OpenAICompatibleChatMessage => {
          const mapped: OpenAICompatibleChatMessage = {
            role: message.role,
            content: message.content,
          };

          return message.tool_call_id ? { ...mapped, tool_call_id: message.tool_call_id } : mapped;
        }),
      };

      if (input.stream) {
        const durableCall = startPublicLlmGatewayCall({
          ...(coreDb ? { coreDb } : {}),
          endpoint: 'chat_completions',
          metadata: (request as { metadata?: unknown }).metadata,
          provider,
          store: requestStore(c),
        });

        try {
          const stream = await llmGatewayDispatcher.createChatCompletionStream(
            provider,
            {
              ...request,
              stream: true,
            },
            {
              onUsage: (usage) =>
                recordPublicLlmGatewayUsage({
                  durableCall,
                  model: request.model,
                  provider,
                  usage,
                }),
            }
          );

          return new Response(
            normalizeGatewayTerminalStream(
              finishPublicLlmGatewayStream(stream, durableCall),
              'chat_completions'
            ),
            {
              headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              },
            }
          );
        } catch (error) {
          finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
          throw error;
        }
      }

      const durableCall = startPublicLlmGatewayCall({
        ...(coreDb ? { coreDb } : {}),
        endpoint: 'chat_completions',
        metadata: (request as { metadata?: unknown }).metadata,
        provider,
        store: requestStore(c),
      });

      try {
        const completion: OpenAICompatibleChatCompletionResponse =
          await llmGatewayDispatcher.createChatCompletion(
            provider,
            {
              ...request,
              stream: false,
            },
            {
              onUsage: (usage) =>
                recordPublicLlmGatewayUsage({
                  durableCall,
                  model: request.model,
                  provider,
                  usage,
                }),
            }
          );
        finishPublicLlmGatewayCall(durableCall, 'succeeded');

        return c.json(completion);
      } catch (error) {
        finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
        throw error;
      }
    } catch (error) {
      return asOpenAIGatewayError(error);
    }
  });

  app.post('/v1/responses', async (c) => {
    try {
      const input = GatewayResponsesRequestSchema.parse(await c.req.json());
      const providerId = gatewayDefaultProviderId();

      if (!isGatewayEnabled()) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.responses',
          providerId,
          reasonCode: 'gateway_disabled',
          result: 'deny',
          route: '/v1/responses',
        });
        return c.json(
          {
            error: {
              message: 'Gateway is disabled by policy.',
              type: 'invalid_request_error',
              code: 'gateway_disabled',
            },
          },
          403
        );
      }

      if (!providerId) {
        return c.json(
          {
            error: {
              message: 'Gateway requires a default provider.',
              type: 'invalid_request_error',
              code: 'gateway_not_configured',
            },
          },
          400
        );
      }

      if (!isGatewayProviderAllowed(providerId)) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.responses',
          providerId,
          reasonCode: 'gateway_provider_not_allowed',
          result: 'deny',
          route: '/v1/responses',
        });
        return c.json(
          {
            error: {
              message: `Gateway policy does not allow provider: ${providerId}`,
              type: 'invalid_request_error',
              code: 'gateway_provider_not_allowed',
            },
          },
          403
        );
      }

      recordLlmGatewayPolicyDecision({
        action: 'llm.gateway.responses',
        providerId,
        reasonCode: 'gateway_allowed',
        result: 'allow',
        route: '/v1/responses',
      });

      const provider = resolveGatewayProvider(providerId);
      const request = {
        ...input,
        stream: input.stream ?? false,
      };

      if (input.stream) {
        const durableCall = startPublicLlmGatewayCall({
          ...(coreDb ? { coreDb } : {}),
          endpoint: 'responses',
          metadata: (request as { metadata?: unknown }).metadata,
          provider,
          store: requestStore(c),
        });

        try {
          const stream = await llmGatewayDispatcher.createResponsesStream(
            provider,
            {
              ...request,
              stream: true,
            },
            {
              onUsage: (usage) =>
                recordPublicLlmGatewayUsage({
                  durableCall,
                  model: request.model,
                  provider,
                  usage,
                }),
            }
          );

          return new Response(
            normalizeGatewayTerminalStream(
              finishPublicLlmGatewayStream(stream, durableCall),
              'responses'
            ),
            {
              headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              },
            }
          );
        } catch (error) {
          finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
          throw error;
        }
      }

      const durableCall = startPublicLlmGatewayCall({
        ...(coreDb ? { coreDb } : {}),
        endpoint: 'responses',
        metadata: (request as { metadata?: unknown }).metadata,
        provider,
        store: requestStore(c),
      });

      try {
        const response: OpenAICompatibleResponsesResponse =
          await llmGatewayDispatcher.createResponses(provider, request, {
            onUsage: (usage) =>
              recordPublicLlmGatewayUsage({
                durableCall,
                model: request.model,
                provider,
                usage,
              }),
          });
        finishPublicLlmGatewayCall(durableCall, 'succeeded');

        return c.json(response);
      } catch (error) {
        finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
        throw error;
      }
    } catch (error) {
      return asOpenAIGatewayError(error);
    }
  });
}
