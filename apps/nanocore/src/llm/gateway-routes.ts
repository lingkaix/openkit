import { randomUUID } from 'node:crypto';
import { constants as zlibConstants, zstdDecompress } from 'node:zlib';
import {
  type AgentEnvironmentPackage,
  WORKER_RUNTIME_PROVENANCE_FEATURE,
} from '@openkit/config-schema';
import {
  type ActorRef,
  type GatewayRouteLineageEntry,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
  ReasoningEffortSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  currentWorkerLineageWorkspaceAuthority,
  currentWorkspaceAuthority,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import {
  finishCapabilityCall,
  type GatewayCallLedgerBinding,
  hasCapabilityCallRequestId,
  recordUsage,
  startCapabilityCall,
  writeGatewayRouteLineage,
} from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import { recordGatewayPolicyDecision } from '../policy/permission-decisions.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import {
  type WorkerControlGateway,
  WorkerControlGatewayError,
} from '../runtime/worker-control-gateway.js';
import { createWorkerRuntimeOriginRef } from '../runtime/worker-runtime-provenance.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { readWorkObservationTurnBinding } from '../storage/work-observations.js';
import {
  executeGatewayPlan,
  type GatewayAttemptContext,
  GatewayAttemptFailure,
  type GatewayClock,
  LogicalModelRoutesExhaustedError,
  planLogicalModel,
} from './gateway-execution.js';
import { GatewayUnsupportedFeatureError } from './pi-ai-client.js';
import type { PiAiFailure, PiAiFailureKind } from './pi-ai-failure.js';

export { LogicalModelRoutesExhaustedError } from './gateway-execution.js';

import { parseUsage } from './gateway-usage.js';
import {
  type ResolvedLogicalModel,
  resolveEffectiveModelMetadata,
  resolveLogicalModel,
  resolveLogicalModelCatalog,
  resolveProviderModelDiagnostic,
} from './logical-models.js';
import type { ModelCaptureContext } from './model-capture.js';
import {
  type OpenAICompatibleChatCompletionRequest,
  type OpenAICompatibleChatCompletionResponse,
  type OpenAICompatibleChatMessage,
  OpenAICompatibleProviderError,
  type OpenAICompatibleResponsesRequest,
  type OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { resolveWorkerPromptCacheKey } from './prompt-cache-key.js';
import {
  type LLMGatewayProviderDispatcher,
  resolveGatewaySubscriptionModels,
} from './provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from './provider-subscription-accounts.js';
import {
  digestLlmSystemPrompt,
  persistLlmCapabilityCallSystemPromptDigest,
} from './system-prompt-digest.js';
import {
  readWorkerInferenceRuntimeHint,
  type WorkerInferenceRuntimeHint,
} from './worker-inference-runtime-hint.js';
import { isWorkerInferenceToolList } from './worker-inference-tool-policy.js';

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
    reasoning_effort: ReasoningEffortSchema.optional(),
  })
  .passthrough();
const GatewayResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]),
    stream: z.boolean().optional(),
    reasoning: z
      .object({ effort: ReasoningEffortSchema.optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const WORKER_INFERENCE_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const WORKER_INFERENCE_HEARTBEAT_INTERVAL_MS = 1000;
const WORKER_INFERENCE_HEARTBEAT_SSE = ': openkit-worker-inference-heartbeat\n\n';

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
  /** AgentSession lineage when available. */
  agentSessionId?: string;
  /** Client-supplied request id used for durable idempotency. */
  requestId?: string;
  /** Workspace source ids attributed to the call. */
  sourceIds?: string[];
}

/** Started durable LLM gateway call with its workspace database handle. */
interface DurableLlmGatewayCall {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Started capability call row. */
  call: ReturnType<typeof startCapabilityCall>;
  /** Whether the capability call and database handle already reached a terminal boundary. */
  finished: boolean;
}

/**
 * Starts one durable public LLM gateway call when the call is attributable.
 *
 * @param input Provider, request, and storage context.
 * @returns Started call or null when durable attribution is unavailable.
 */
function startPublicLlmGatewayCall(input: {
  /** Exact authenticated actor that authorized the workspace call. */
  authorityActor: ActorRef;
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Gateway endpoint family. */
  endpoint: 'chat_completions' | 'responses';
  /** OpenAI-compatible request metadata. */
  metadata: unknown;
  /** Pre-adapter Chat Completions or Responses request. */
  request: unknown;
}): DurableLlmGatewayCall | null {
  if (!input.coreDb) {
    return null;
  }

  const lineage = readPublicLlmGatewayLineage(input.metadata);

  if (!lineage) {
    return null;
  }

  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, lineage.workspaceId);

  try {
    applyScopedMigrations(workspaceDb);

    if (
      lineage.requestId &&
      hasCapabilityCallRequestId(workspaceDb, lineage.workspaceId, lineage.requestId)
    ) {
      throw new GatewayAttemptFailure({ kind: 'invalid_request', settled: true });
    }
    const call = startCapabilityCall({
      agentId: lineage.agentId ?? null,
      agentSessionId: lineage.agentSessionId ?? null,
      authorityActor: input.authorityActor,
      capabilityId: `llm.${input.endpoint}`,
      family: 'llm',
      itemId: lineage.itemId ?? null,
      operation: input.endpoint,
      providerRef: null,
      redactionClass: 'metadata-only',
      requestId: lineage.requestId ?? randomUUID(),
      serviceRef: 'llm-gateway',
      sourceIds: lineage.sourceIds ?? [],
      summary:
        lineage.threadId && lineage.turnId
          ? `Public ${input.endpoint} LLM gateway call.`
          : `Public ${input.endpoint} LLM gateway call. Model capture unavailable: no Turn admission.`,
      threadId: lineage.threadId ?? null,
      turnId: lineage.turnId ?? null,
      workspaceDb,
      workspaceId: lineage.workspaceId,
    });
    persistLlmCapabilityCallSystemPromptDigest({
      callId: call.id,
      systemPromptDigest: digestLlmSystemPrompt({
        endpoint: input.endpoint,
        request: input.request,
      }),
      workspaceDb,
    });

    return {
      call,
      finished: false,
      workspaceDb,
    };
  } catch (error) {
    workspaceDb.sqlite.close();
    throw error;
  }
}

/** Selects capture lineage only after the route has authenticated and authorized the exact owner. */
function captureForCall(
  call: DurableLlmGatewayCall | null,
  corr: string,
  attempt: number
): ModelCaptureContext | undefined {
  const lineage = call?.call.context;
  if (!call || !lineage?.threadId || !lineage.turnId) return undefined;
  return {
    workspaceDb: call.workspaceDb,
    threadId: lineage.threadId,
    turnId: lineage.turnId,
    corr,
    attempt,
    capabilityCallId: call.call.id,
    runtimeOriginRef: lineage.runtimeOriginRef ?? null,
  };
}

/** Reads only the exact persisted admission; current Agent defaults never supply bound inference effort. */
function recordedEffortForCall(call: DurableLlmGatewayCall | null): ReasoningEffort | undefined {
  const lineage = call?.call.context;
  if (!call || !lineage?.threadId || !lineage.turnId) return undefined;
  return readWorkObservationTurnBinding(call.workspaceDb, {
    threadId: lineage.threadId,
    turnId: lineage.turnId,
  }).turn.reasoningEffort;
}

/** Replaces only the endpoint's effort control, preserving other admitted reasoning fields and omission. */
function withGatewayEffort<T extends Record<string, unknown>>(
  request: T,
  endpoint: WorkerInferenceEndpoint,
  effectiveEffort: ReasoningEffort | undefined
): T {
  if (
    effectiveEffort === undefined &&
    (endpoint === 'chat_completions'
      ? request.reasoning_effort === undefined
      : !request.reasoning ||
        typeof request.reasoning !== 'object' ||
        !('effort' in request.reasoning))
  )
    return request;
  const output = { ...request };
  if (endpoint === 'chat_completions') {
    delete output.reasoning_effort;
    if (effectiveEffort !== undefined) Object.assign(output, { reasoning_effort: effectiveEffort });
  } else {
    const reasoning = request.reasoning;
    if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
      const rest = { ...reasoning } as Record<string, unknown>;
      delete rest.effort;
      if (effectiveEffort !== undefined) rest.effort = effectiveEffort;
      if (Object.keys(rest).length) Object.assign(output, { reasoning: rest });
      else delete output.reasoning;
    } else if (effectiveEffort !== undefined)
      Object.assign(output, { reasoning: { effort: effectiveEffort } });
  }
  return output;
}

/** Fits against the existing resolver's member levels; no control means a truthful Provider default. */
function fitGatewayEffort(
  provider: ResolvedLLMProviderConfig,
  model: string,
  effort: { requested?: ReasoningEffort; recorded?: ReasoningEffort }
): Pick<
  Extract<GatewayRouteLineageEntry, { kind: 'attempt' }>,
  'requestedEffort' | 'effectiveEffort' | 'effectiveEffortReason'
> {
  const metadata = resolveProviderModelDiagnostic(
    {
      id: provider.id,
      kind: 'direct',
      displayName: provider.displayName,
      models: [...provider.models],
      ...(provider.vendor ? { vendor: provider.vendor } : {}),
      ...(provider.modelMetadata ? { modelMetadata: provider.modelMetadata } : {}),
    },
    model
  );
  const chosen = effort.requested ?? effort.recorded;
  const requested = effort.requested === undefined ? {} : { requestedEffort: effort.requested };
  if (metadata.reasoning.value !== true)
    return { ...requested, effectiveEffortReason: 'model_without_reasoning' };
  const levels = metadata.reasoningEffortLevels.value;
  if (!levels?.length)
    return { ...requested, effectiveEffortReason: 'provider_default_no_options' };
  if (chosen === undefined)
    return { ...requested, effectiveEffortReason: 'provider_default_no_effort' };
  const effectiveEffort =
    levels.find(
      (level) => REASONING_EFFORT_LEVELS.indexOf(level) >= REASONING_EFFORT_LEVELS.indexOf(chosen)
    ) ?? levels[levels.length - 1]!;
  return { ...requested, effectiveEffort };
}

/**
 * Records durable usage for one LLM gateway response.
 *
 * @param input Started call and response usage.
 */
function recordLlmGatewayUsage(input: {
  /** Started durable call. */
  durableCall: DurableLlmGatewayCall | null;
  /** Provider selected for the call. */
  provider: ResolvedLLMProviderConfig;
  /** Model requested by the client. */
  model: string;
  /** Provider usage payload. */
  usage: unknown;
}): string[] {
  if (!input.durableCall || input.durableCall.finished) {
    return [];
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
      quantity: parsed.cacheReadTokens,
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
        (parsed.cacheReadTokens ?? 0) ||
        (parsed.cacheWriteTokens ?? 0)
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
    record.quantity !== undefined &&
    (record.quantity > 0 ||
      record.source === 'llm-gateway-adapter-reported:cache_read' ||
      record.source === 'llm-gateway-adapter-reported:cache_write')
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
    return [];
  }

  return recordUsage({
    call: input.durableCall.call,
    records,
    workspaceDb: input.durableCall.workspaceDb,
  });
}

/**
 * Marks an LLM gateway call terminal and closes its workspace database.
 *
 * @param durableCall Started durable call, when any.
 * @param status Terminal status.
 * @param errorCode Stable error code for non-success calls.
 */
function finishDurableLlmGatewayCall(
  durableCall: DurableLlmGatewayCall | null,
  status: 'succeeded' | 'failed' | 'aborted' | 'timed-out',
  errorCode?: string
): void {
  if (!durableCall || durableCall.finished) {
    return;
  }
  durableCall.finished = true;

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
 * Finalizes a call after SSE headers have started without exposing persistence failures.
 *
 * @param durableCall Durable capability call, when attributable.
 * @param status Terminal capability status.
 * @param errorCode Optional stable failure or cancellation code.
 */
function finishDurableLlmGatewayStreamCall(
  durableCall: DurableLlmGatewayCall | null,
  status: 'succeeded' | 'failed' | 'aborted' | 'timed-out',
  errorCode?: string
): void {
  try {
    finishDurableLlmGatewayCall(durableCall, status, errorCode);
  } catch {
    // Response framing owns the post-header boundary and must remain product-safe.
  }
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
 * Checks current Workspace authority for one explicitly attributed public Gateway call.
 *
 * @param input Authenticated actor, request metadata, and current Core authority.
 * @returns True only when explicit Workspace attribution is present but no longer authorized.
 */
function publicGatewayAuthorityDenied(input: {
  /** Fresh authenticated actor responsible for the pending provider effect. */
  actor: ActorRef;
  /** Optional Core database containing current Workspace authority. */
  coreDb?: CoreDb;
  /** OpenAI-compatible request metadata. */
  metadata: unknown;
  /** Current authenticated store used to enforce the selected Thread audience. */
  store?: FsStore;
}): boolean {
  const lineage = readPublicLlmGatewayLineage(input.metadata);

  return Boolean(
    lineage &&
      (!input.coreDb ||
        !currentWorkspaceAuthority(
          input.coreDb,
          lineage.workspaceId,
          input.actor,
          'llm.gateway.use',
          true
        ) ||
        (lineage.threadId &&
          lineage.turnId &&
          (!input.store ||
            input.actor.kind !== 'user' ||
            !isThreadIdVisible(
              input.store,
              lineage.workspaceId,
              lineage.threadId,
              input.actor.id
            ))))
  );
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

/** Worker-only OpenAI-compatible inference endpoint family. */
type WorkerInferenceEndpoint = 'chat_completions' | 'responses';

/** Authoritative worker inference route carried by one trusted AEP. */
type WorkerInferenceLlmRoute = AgentEnvironmentPackage['llm']['routes'][number];

/** Stable worker inference route error projected without internal gateway details. */
class WorkerInferenceRouteError extends Error {
  /** Machine-readable worker inference error code. */
  public readonly code: string;
  /** HTTP status for the worker-facing response. */
  public readonly status: number;

  /**
   * Creates one worker inference route error.
   *
   * @param code Stable machine-readable code.
   * @param message Product-safe error message.
   * @param status HTTP response status.
   */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'WorkerInferenceRouteError';
    this.code = code;
    this.status = status;
  }
}

/** Stable public Gateway error used when caller cancellation wins provider dispatch. */
class GatewayRequestCancelledError extends Error {
  /** OpenAI-compatible cancellation code. */
  public readonly code = 'gateway_request_cancelled';
  /** HTTP status used by disconnected or explicitly cancelling clients. */
  public readonly status = 499;
  /** OpenAI-compatible error category. */
  public readonly type = 'request_cancelled';

  /** Creates one product-safe Gateway cancellation error. */
  public constructor() {
    super('Gateway request was cancelled.');
    this.name = 'GatewayRequestCancelledError';
  }
}

/**
 * Reads and parses one bounded worker inference JSON request.
 *
 * @param request Worker HTTP request.
 * @returns Parsed JSON value.
 * @throws WorkerInferenceRouteError for unsupported or invalid representations.
 */
async function parseWorkerInferenceJsonRequest(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new WorkerInferenceRouteError(
      'worker_inference_unsupported_media_type',
      'Worker inference requires application/json.',
      415
    );
  }

  const contentEncoding = (request.headers.get('content-encoding') ?? 'identity')
    .trim()
    .toLowerCase();
  if (contentEncoding !== 'identity' && contentEncoding !== 'zstd') {
    throw new WorkerInferenceRouteError(
      'worker_inference_unsupported_content_encoding',
      'Worker inference content encoding is unsupported.',
      415
    );
  }

  const encoded = await readBoundedWorkerInferenceBody(request);
  const decoded =
    contentEncoding === 'zstd' ? await decompressWorkerInferenceBody(encoded) : encoded;
  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw invalidWorkerInferenceRequest();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidWorkerInferenceRequest();
  }
}

/**
 * Reads request bytes without allowing encoded input to exceed the transport limit.
 *
 * @param request Worker HTTP request.
 * @returns Encoded request bytes.
 */
async function readBoundedWorkerInferenceBody(request: Request): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > WORKER_INFERENCE_BODY_LIMIT_BYTES) {
    throw workerInferencePayloadTooLarge();
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      totalBytes += result.value.byteLength;
      if (totalBytes > WORKER_INFERENCE_BODY_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw workerInferencePayloadTooLarge();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

/**
 * Decompresses one bounded Zstd request using Node's native implementation.
 *
 * @param encoded Encoded Zstd bytes.
 * @returns Decoded bytes within the transport limit.
 */
async function decompressWorkerInferenceBody(encoded: Uint8Array): Promise<Uint8Array> {
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      zstdDecompress(
        encoded,
        {
          maxOutputLength: WORKER_INFERENCE_BODY_LIMIT_BYTES,
          params: { [zlibConstants.ZSTD_d_windowLogMax]: 24 },
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw workerInferencePayloadTooLarge();
    }
    throw invalidWorkerInferenceRequest();
  }
}

/**
 * Creates the stable invalid worker representation error.
 *
 * @returns Invalid-request error.
 */
function invalidWorkerInferenceRequest(): WorkerInferenceRouteError {
  return new WorkerInferenceRouteError(
    'worker_inference_invalid_request',
    'Worker inference request is invalid.',
    400
  );
}

/**
 * Creates the stable worker inference size-limit error.
 *
 * @returns Payload-too-large error.
 */
function workerInferencePayloadTooLarge(): WorkerInferenceRouteError {
  return new WorkerInferenceRouteError(
    'worker_inference_payload_too_large',
    'Worker inference request exceeds the size limit.',
    413
  );
}

/**
 * Starts one AEP-attributed worker inference capability call.
 *
 * @param input Trusted package, route, endpoint, and durable storage context.
 * @returns Started durable capability call.
 * @throws WorkerInferenceRouteError when durable attribution cannot be established.
 */
function startWorkerInferenceCall(input: {
  /** Optional Core database used to locate workspace storage. */
  readonly coreDb?: CoreDb;
  /** Authenticated Agent Environment Package. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Worker inference endpoint family. */
  readonly endpoint: WorkerInferenceEndpoint;
  /** AEP-selected provider reference. */
  readonly providerRef: string | null;
  /** Product-safe runtime origin reference when provenance is required. */
  readonly runtimeOriginRef: string | null;
  /** Product-safe runtime cache lineage reference when explicitly reported. */
  readonly runtimeCacheLineageRef: string | null;
  /** Whether this request used request-scoped cache isolation. */
  readonly cacheDegraded: boolean;
  /** Pre-adapter Chat Completions or Responses request. */
  readonly request: unknown;
}): DurableLlmGatewayCall {
  if (!input.coreDb) {
    throw new WorkerInferenceRouteError(
      'worker_inference_unavailable',
      'Worker inference durable attribution is unavailable.',
      503
    );
  }

  const { environmentPackage } = input;
  const { scope } = environmentPackage;

  let workspaceDb: WorkspaceDb | null = null;

  try {
    workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, scope.workspaceId);
    applyScopedMigrations(workspaceDb);

    const call = startCapabilityCall({
      agentId: environmentPackage.agent.agentId,
      agentSessionId: scope.agentSessionId,
      authorityActor: scope.triggerActor,
      capabilityId: `llm.${input.endpoint}`,
      family: 'llm',
      itemId: scope.itemId ?? null,
      operation: input.endpoint,
      packageSnapshotId: environmentPackage.snapshotId,
      providerRef: input.providerRef,
      redactionClass: 'metadata-only',
      requestId: randomUUID(),
      runtimeCacheLineageRef: input.runtimeCacheLineageRef,
      runtimeOriginRef: input.runtimeOriginRef,
      serviceRef: 'worker-inference-gateway',
      sourceIds: [],
      summary: input.cacheDegraded
        ? `Worker ${input.endpoint} inference gateway call with request-scoped cache isolation.`
        : `Worker ${input.endpoint} inference gateway call.`,
      threadId: scope.threadId,
      turnId: scope.turnId,
      workspaceDb,
      workspaceId: scope.workspaceId,
    });
    persistLlmCapabilityCallSystemPromptDigest({
      callId: call.id,
      systemPromptDigest: digestLlmSystemPrompt({
        endpoint: input.endpoint,
        request: input.request,
      }),
      workspaceDb,
    });

    return {
      call,
      finished: false,
      workspaceDb,
    };
  } catch {
    workspaceDb?.sqlite.close();
    throw new WorkerInferenceRouteError(
      'worker_inference_unavailable',
      'Worker inference durable attribution is unavailable.',
      503
    );
  }
}

/** Top-level request fields whose presence would supply private runtime authority. */
const WORKER_INFERENCE_FORBIDDEN_FIELDS = [
  'access_token',
  'agentId',
  'agentSessionId',
  'agent_id',
  'agent_session_id',
  'apiKey',
  'api_key',
  'authorization',
  'automationId',
  'automation_id',
  'background',
  'budget',
  'budgets',
  'cacheKey',
  'cache_key',
  'client_secret',
  'conversation',
  'credential',
  'credentialRef',
  'credential_ref',
  'credentials',
  'lineage',
  'itemId',
  'item_id',
  'modelId',
  'model_id',
  'openkit',
  'organizationId',
  'organization_id',
  'packageId',
  'packageSnapshotId',
  'package_id',
  'package_snapshot_id',
  'policy',
  'policies',
  'policyRef',
  'policySnapshotId',
  'policy_ref',
  'policy_snapshot_id',
  'provider',
  'providerId',
  'providerInstanceId',
  'providerRef',
  'provider_id',
  'provider_instance_id',
  'provider_ref',
  'providerSelection',
  'provider_selection',
  'previous_response_id',
  'requestId',
  'request_id',
  'routeId',
  'route_id',
  'scope',
  'secret',
  'secretRef',
  'secret_ref',
  'secrets',
  'service_tier',
  'sourceId',
  'source_id',
  'sourceIds',
  'source_ids',
  'snapshotId',
  'snapshot_id',
  'threadId',
  'thread_id',
  'token',
  'turnId',
  'turn_id',
  'userId',
  'user_id',
  'vault',
  'vaultGrantId',
  'vault_grant_id',
  'workspaceId',
  'workspace_id',
] as const;

/**
 * Rejects request headers that attempt to supply OpenKit authority.
 *
 * @param headers Worker request headers.
 */
function rejectWorkerInferenceAuthorityHeaders(headers: Headers): void {
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith('x-openkit-')) {
      throw workerInferenceLineageMismatch();
    }
  });
}

/**
 * Rejects caller authority aliases and rebuilds a provider request from one trusted AEP.
 *
 * @param input Parsed OpenAI-compatible worker request.
 * @param route AEP-selected provider route.
 * @returns Sanitized request safe to pass to the shared provider dispatcher.
 */
function sanitizeWorkerInferenceRequest(
  input: Record<string, unknown>,
  route: WorkerInferenceLlmRoute
): Record<string, unknown> {
  const request = { ...input };
  if (Object.hasOwn(request, 'model') && request.model !== route.model) {
    throw workerInferenceLineageMismatch();
  }

  if (Object.hasOwn(request, 'store') && request.store !== false) {
    throw workerInferenceLineageMismatch();
  }

  for (const field of WORKER_INFERENCE_FORBIDDEN_FIELDS) {
    if (Object.hasOwn(request, field)) {
      throw workerInferenceLineageMismatch();
    }
  }
  rejectProviderExecutedWorkerTools(request.tools);

  request.metadata = sanitizeWorkerInferenceMetadata(request.metadata);
  if (request.metadata === undefined) {
    delete request.metadata;
  }

  delete request.openkit_runtime_hint;
  delete request.client_metadata;
  delete request.promptCacheKey;
  delete request.prompt_cache_key;
  delete request.safety_identifier;
  delete request.sessionId;
  delete request.session_id;
  delete request.user;
  request.model = route.model;
  request.store = false;
  request.stream = request.stream ?? false;

  return request;
}

/**
 * Rejects provider-executed tools while preserving local function and shell declarations.
 *
 * @param tools OpenAI-compatible tool declarations.
 */
function rejectProviderExecutedWorkerTools(tools: unknown): void {
  if (tools === undefined) {
    return;
  }
  if (!isWorkerInferenceToolList(tools)) {
    throw workerInferenceLineageMismatch();
  }
}

/**
 * Rejects OpenKit authority and preserves ordinary metadata.
 *
 * @param metadata Caller metadata.
 * @returns Metadata without caller authority.
 */
function sanitizeWorkerInferenceMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new WorkerInferenceRouteError(
      'worker_inference_invalid_request',
      'Worker inference metadata must be an object.',
      400
    );
  }

  const sanitized = { ...(metadata as Record<string, unknown>) };
  if (Object.hasOwn(sanitized, 'openkit')) {
    throw workerInferenceLineageMismatch();
  }
  return sanitized;
}

/**
 * Creates the stable error used for caller attempts to override AEP authority.
 *
 * @returns Worker inference lineage mismatch error.
 */
function workerInferenceLineageMismatch(): WorkerInferenceRouteError {
  return new WorkerInferenceRouteError(
    'worker_inference_lineage_mismatch',
    'Worker inference request authority does not match the authenticated package.',
    403
  );
}

/**
 * Requires the trusted relay capability and one AEP-authorized logical model route.
 *
 * @param environmentPackage Authenticated Agent Environment Package.
 * @param logicalModelId Worker-requested logical model id.
 * @returns AEP-owned inference route.
 */
function requireTrustedWorkerInferenceRoute(
  environmentPackage: AgentEnvironmentPackage,
  logicalModelId: string
): WorkerInferenceLlmRoute {
  const trustedRelay = environmentPackage.backend.requiredCapabilities.includes(
    'trusted-worker-inference-relay'
  );

  if (
    !trustedRelay ||
    environmentPackage.llm.mode !== 'gateway' ||
    environmentPackage.llm.routes.length === 0 ||
    environmentPackage.llm.routes.some(
      (route) =>
        route.credentialVisibility !== 'placeholder' ||
        route.endpoint.upstream?.kind !== 'nanocore-gateway'
    )
  ) {
    throw new WorkerInferenceRouteError(
      'worker_inference_unauthorized',
      'Worker inference requires a trusted relay package.',
      401
    );
  }

  const route = environmentPackage.llm.routes.find(
    (candidate) => candidate.model === logicalModelId
  );
  if (!route) throw workerInferenceLineageMismatch();
  return route;
}

/**
 * Converts worker inference failures into stable OpenAI-compatible envelopes.
 *
 * @param error Unknown route or provider failure.
 * @returns Sanitized worker-facing response.
 */
function asWorkerInferenceError(error: unknown): Response {
  if (error instanceof WorkerInferenceRouteError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          type: 'invalid_request_error',
        },
      },
      { status: error.status }
    );
  }

  if (error instanceof WorkerControlGatewayError) {
    return Response.json(
      {
        error: {
          code: 'worker_inference_unauthorized',
          message: 'Worker inference authorization failed.',
          type: 'invalid_request_error',
        },
      },
      { status: error.status === 403 ? 403 : 401 }
    );
  }

  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: {
          code: 'worker_inference_invalid_request',
          message: 'Worker inference request is invalid.',
          type: 'invalid_request_error',
        },
      },
      { status: 400 }
    );
  }

  if (
    error instanceof GatewayAttemptFailure ||
    (error as { failure?: PiAiFailure } | null)?.failure ||
    error instanceof LogicalModelRoutesExhaustedError ||
    error instanceof GatewayUnsupportedFeatureError ||
    error instanceof OpenAICompatibleProviderError
  ) {
    return asOpenAIGatewayError(error);
  }

  return Response.json(
    {
      error: {
        code: 'worker_inference_request_failed',
        message: 'Worker inference request failed.',
        type: 'invalid_request_error',
      },
    },
    { status: 400 }
  );
}

/**
 * Converts gateway dispatch failures into OpenAI-compatible error envelopes.
 * Exhaustion exposes only the final closed kind; selection without an attempt omits cause.
 */
function asOpenAIGatewayError(error: unknown): Response {
  if (error instanceof LogicalModelRoutesExhaustedError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: error.type,
          code: error.code,
          ...(error.cause === undefined ? {} : { cause: error.cause }),
        },
      },
      { status: error.status }
    );
  }

  if (error instanceof GatewayRequestCancelledError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: error.type,
          code: error.code,
        },
      },
      { status: error.status }
    );
  }

  if (error instanceof GatewayUnsupportedFeatureError) {
    return Response.json(
      {
        error: {
          message: 'Requested features are not supported by the Gateway.',
          type: 'invalid_request_error',
          code: error.code,
        },
      },
      { status: error.status }
    );
  }

  if (error instanceof OpenAICompatibleProviderError) {
    if (error.code === 'model_not_configured') {
      return Response.json(
        {
          error: {
            message: 'Requested logical model is not configured.',
            type: 'invalid_request_error',
            code: error.code,
          },
        },
        { status: 400 }
      );
    }
  }

  const failure = (error as { failure?: PiAiFailure } | null)?.failure;
  if (failure) {
    const code = GATEWAY_FAILURE_CODES[failure.kind];
    const status =
      failure.status ??
      (
        {
          auth_rejected: 401,
          quota_exhausted: 429,
          rate_limited: 429,
          provider_unavailable: 503,
          cancelled: 499,
        } as Partial<Record<PiAiFailureKind, number>>
      )[failure.kind] ??
      400;
    return Response.json(
      {
        error: {
          code,
          type: failure.kind === 'unsupported' ? 'invalid_request_error' : 'provider_error',
          message: gatewayProviderFailureMessage(code),
        },
      },
      { status }
    );
  }

  return Response.json(
    {
      error: {
        message: 'Gateway request failed.',
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

/** Terminal behavior owned by one Gateway SSE response wrapper. */
interface GatewayTerminalStreamOptions {
  /** Durable capability call completed with the stream, when attributable. */
  readonly durableCall?: DurableLlmGatewayCall | null;
  /** Stable ledger error code used when downstream consumption is cancelled. */
  readonly cancellationCode?: string;
  /** Envelope ledger error code used as the projection fallback when upstream streaming fails. */
  readonly failureCode?: string;
  /** Optional product-safe SSE message that hides internal provider details. */
  readonly failureMessage?: string;
  /** Optional interval that emits worker-safe SSE comments while the upstream is idle. */
  readonly heartbeatIntervalMs?: number;
  /** Request cancellation signal used to distinguish aborts from provider failures. */
  readonly signal?: AbortSignal;
}

/**
 * Wraps a provider SSE stream so post-start read failures become terminal SSE events.
 *
 * @param stream Upstream or bridged provider SSE stream.
 * @param endpoint Gateway endpoint family being streamed.
 * @param options Durable completion, cancellation, and error-normalization options. Non-cancelled failures store the classified OpenKit code with `failureCode` as the uncoded fallback.
 * @returns Stream that preserves bytes and appends a terminal error event on read failure.
 */
function normalizeGatewayTerminalStream(
  stream: ReadableStream<Uint8Array>,
  endpoint: GatewayStreamingEndpoint,
  options: GatewayTerminalStreamOptions = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = stream.getReader();
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let released = false;
  let terminal = false;
  let terminalFailureCode: string | undefined;
  let frames = '';
  const decoder = new TextDecoder();

  /** Carries an already released terminal failure into logical closeout, without classifying Provider evidence. */
  function observeTerminalFrames(chunk: Uint8Array): void {
    frames += decoder.decode(chunk, { stream: true });
    let boundary = /\r?\n\r?\n/.exec(frames);
    while (boundary?.index !== undefined) {
      const data = frames
        .slice(0, boundary.index)
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      try {
        const event = JSON.parse(data);
        if (
          event?.error ||
          event?.type === 'response.failed' ||
          event?.response?.status === 'failed'
        ) {
          const code = event.error?.code ?? event.response?.error?.code;
          const fallback = options.failureCode ?? 'llm_gateway_stream_failed';
          terminalFailureCode ??=
            typeof code === 'string' &&
            (Object.values(GATEWAY_FAILURE_CODES).includes(code) ||
              isInnerStreamDiagnosticCode(code))
              ? code
              : fallback;
        }
      } catch {
        /* Non-JSON comments and DONE carry no failed outcome. */
      }
      frames = frames.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/.exec(frames);
    }
  }

  /** Releases the upstream reader lock exactly once. */
  function releaseReader(): void {
    if (released) {
      return;
    }
    released = true;
    reader.releaseLock();
  }

  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      if (terminal) {
        return;
      }
      terminal = true;

      try {
        await reader.cancel(reason);
      } finally {
        try {
          finishDurableLlmGatewayStreamCall(
            options.durableCall ?? null,
            terminalFailureCode ? 'failed' : 'aborted',
            terminalFailureCode ?? options.cancellationCode ?? 'llm_gateway_cancelled'
          );
        } finally {
          releaseReader();
        }
      }
    },
    async pull(controller) {
      if (terminal) {
        return;
      }

      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array> | null;
      try {
        pendingRead ??= reader.read();
        result = options.heartbeatIntervalMs
          ? await Promise.race([
              pendingRead,
              new Promise<null>((resolve) => {
                heartbeatTimer = setTimeout(resolve, options.heartbeatIntervalMs, null);
              }),
            ])
          : await pendingRead;
      } catch (error) {
        if (terminal) {
          return;
        }
        terminal = true;
        const cancelled = isGatewayCancellation(error, options.signal);
        const envelopeFailureCode = options.failureCode ?? 'llm_gateway_stream_failed';
        try {
          finishDurableLlmGatewayStreamCall(
            options.durableCall ?? null,
            terminalFailureCode
              ? 'failed'
              : cancelled
                ? 'aborted'
                : isGatewayTimeout(error)
                  ? 'timed-out'
                  : 'failed',
            terminalFailureCode ??
              (cancelled
                ? (options.cancellationCode ?? 'llm_gateway_cancelled')
                : projectGatewayFailure(error, envelopeFailureCode).code)
          );
        } finally {
          releaseReader();
        }
        controller.enqueue(
          encoder.encode(
            createGatewayTerminalErrorSse(
              error,
              endpoint,
              options.failureMessage,
              cancelled ? 'aborted' : 'error',
              cancelled ? (options.cancellationCode ?? 'llm_gateway_cancelled') : undefined
            )
          )
        );
        controller.close();
        return;
      } finally {
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
        }
      }

      if (terminal) {
        return;
      }
      if (result === null) {
        controller.enqueue(encoder.encode(WORKER_INFERENCE_HEARTBEAT_SSE));
        return;
      }
      pendingRead = null;
      if (result.done) {
        terminal = true;
        try {
          finishDurableLlmGatewayStreamCall(
            options.durableCall ?? null,
            terminalFailureCode ? 'failed' : 'succeeded',
            terminalFailureCode
          );
        } finally {
          releaseReader();
        }
        controller.close();
        return;
      }

      observeTerminalFrames(result.value);
      controller.enqueue(result.value);
    },
  });
}

/**
 * Checks whether a provider stream ended because request cancellation won.
 *
 * @param error Upstream stream failure.
 * @param signal Request cancellation signal.
 * @returns True when the failure represents cancellation.
 */
function isGatewayCancellation(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted &&
      (error === signal.reason ||
        (error instanceof GatewayAttemptFailure &&
          error.failure.kind === 'cancelled' &&
          error.cause === signal.reason))
  );
}

/**
 * Completes one non-streaming or pre-response call according to its cancellation signal.
 *
 * @param durableCall Durable capability call, when attributable.
 * @param error Provider or transport failure.
 * @param signal Request cancellation signal.
 * @param failureCode Stable ordinary failure code.
 * @param cancellationCode Stable cancellation code.
 * @returns True when cancellation caused the failure.
 */
function finishDurableLlmGatewayFailure(
  durableCall: DurableLlmGatewayCall | null,
  error: unknown,
  signal: AbortSignal,
  failureCode: string,
  cancellationCode: string
): boolean {
  const cancelled = isGatewayCancellation(error, signal);
  finishDurableLlmGatewayCall(
    durableCall,
    cancelled ? 'aborted' : isGatewayTimeout(error) ? 'timed-out' : 'failed',
    cancelled
      ? cancellationCode
      : error instanceof GatewayUnsupportedFeatureError ||
          (error as { failure?: PiAiFailure } | null)?.failure?.kind === 'unsupported'
        ? 'unsupported_gateway_feature'
        : error instanceof LogicalModelRoutesExhaustedError
          ? error.code
          : failureCode
  );
  return cancelled;
}

/** Returns whether the provider failure proves a timeout rather than a generic failure. */
function isGatewayTimeout(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    (error instanceof OpenAICompatibleProviderError &&
      (error.status === 408 || error.status === 504))
  );
}

/** OpenKit-owned inner stream diagnostics preserved by the fixed failure projection. */
const INNER_STREAM_DIAGNOSTIC_CODES = new Set([
  'provider_stream_truncated',
  'provider_stream_failed',
]);

/**
 * Returns whether one failure code is an allowlisted inner stream diagnostic.
 *
 * @param code Candidate failure code.
 * @returns True when the code must be preserved on durable capability metadata.
 */
function isInnerStreamDiagnosticCode(code: string): boolean {
  return INNER_STREAM_DIAGNOSTIC_CODES.has(code);
}

/**
 * Projects a classified failure onto the fixed public Gateway error vocabulary.
 *
 * @param code Classified durable or public failure code.
 * @param publicFallback Public stream class used when the classified code is inner-only.
 * @returns Code allowed on public JSON or SSE.
 */
function publicGatewayFailureCode(code: string, publicFallback: string): string {
  return isInnerStreamDiagnosticCode(code) ? publicFallback : code;
}

/**
 * Creates an OpenAI-compatible terminal SSE error payload with a stable stop reason.
 *
 * @param error Unknown stream read error.
 * @param endpoint Gateway endpoint family being streamed.
 * @param failureMessage Optional stable worker-facing failure message.
 * @param stopReason Stable terminal stop reason.
 * @param errorCode Optional stable error-code override.
 * @returns Terminal SSE bytes as text.
 */
function createGatewayTerminalErrorSse(
  error: unknown,
  endpoint: GatewayStreamingEndpoint,
  failureMessage?: string,
  stopReason: 'error' | 'aborted' = 'error',
  errorCode?: string
): string {
  const normalized = projectGatewayFailure(error, 'gateway_stream_failed');
  const publicCode =
    errorCode ?? publicGatewayFailureCode(normalized.code, 'gateway_stream_failed');
  const payload = {
    error: {
      message: failureMessage ?? gatewayProviderFailureMessage(publicCode),
      type: normalized.type,
      code: publicCode,
      endpoint,
    },
    stopReason,
  };

  const event =
    endpoint === 'responses'
      ? {
          type: 'response.failed',
          response: { status: 'failed', error: payload.error },
          stopReason,
        }
      : payload;
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

/**
 * Projects the boundary failure value into stable public Gateway error identity.
 *
 * Allowlisted inner stream diagnostic codes are preserved for durable capability
 * metadata. Public JSON and SSE still project the fixed Gateway class.
 *
 * @param error Unknown provider or stream failure.
 * @param fallbackCode Stable code used when the boundary reports an unknown kind.
 * @returns Public gateway error type and code.
 */
export function projectGatewayFailure(error: unknown, fallbackCode: string) {
  if (error instanceof LogicalModelRoutesExhaustedError)
    return { type: error.type, code: error.code };
  const failure = (error as { failure?: PiAiFailure } | null)?.failure;
  const type = 'provider_error';
  if (failure)
    return {
      type: failure.kind === 'unsupported' ? 'invalid_request_error' : type,
      code: failure.kind === 'unknown' ? fallbackCode : GATEWAY_FAILURE_CODES[failure.kind],
    };
  if (error instanceof GatewayUnsupportedFeatureError)
    return { type, code: 'gateway_provider_request_invalid' };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && isInnerStreamDiagnosticCode(code)) return { type, code };
  return { type, code: fallbackCode };
}

/** Fixed public identities project the accepted closed kinds; they never classify upstream evidence. */
const GATEWAY_FAILURE_CODES: Record<PiAiFailureKind, string> = {
  auth_rejected: 'gateway_provider_authentication_failed',
  quota_exhausted: 'gateway_provider_quota_exhausted',
  rate_limited: 'gateway_provider_rate_limited',
  provider_unavailable: 'gateway_provider_unavailable',
  context_overflow: 'gateway_context_overflow',
  unsupported: 'unsupported_gateway_feature',
  output_limit: 'gateway_output_limit',
  refused: 'gateway_provider_refused',
  invalid_request: 'gateway_provider_request_invalid',
  cancelled: 'gateway_request_cancelled',
  unknown: 'provider_error',
};

/**
 * Projects one normalized provider failure code onto a fixed public message.
 *
 * @param code Stable OpenKit provider failure code.
 * @returns Generic public message that contains no upstream text.
 */
function gatewayProviderFailureMessage(code: string): string {
  switch (code) {
    case 'gateway_provider_authentication_failed':
      return 'Provider authentication failed.';
    case 'gateway_provider_quota_exhausted':
      return 'Provider quota is exhausted.';
    case 'gateway_provider_refused':
      return 'Provider refused the request.';
    case 'gateway_output_limit':
      return 'Requested output limit is not supported.';
    case 'unsupported_gateway_feature':
      return 'Requested features are not supported by the Gateway.';
    case 'gateway_request_cancelled':
      return 'Request was cancelled.';
    case 'gateway_provider_rate_limited':
      return 'Provider rate limit exceeded.';
    case 'gateway_context_overflow':
      return 'Provider context limit exceeded.';
    case 'gateway_provider_request_invalid':
      return 'Provider rejected the request.';
    case 'gateway_provider_unavailable':
      return 'Provider is unavailable.';
    case 'gateway_stream_failed':
      return 'Provider stream failed.';
    case 'llm_gateway_cancelled':
    case 'worker_inference_cancelled':
      return 'Request was cancelled.';
    default:
      return 'Provider request failed.';
  }
}

/**
 * Registers token-only worker inference routes backed by AEP authority, with current candidates constrained by the owning Turn's admitted model limits.
 *
 * @param dependencies Hono app, worker identity gateway, dispatcher, and durable storage.
 */
export function registerWorkerInferenceRoutes({
  app,
  providerCredentialConfigured,
  coreDb,
  llmGatewayDispatcher,
  providerSubscriptionAccountManager,
  resolveGatewayProvider,
  runtimeConfig,
  workerControlGateway,
}: {
  /** Hono application receiving the internal routes. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Optional Core database used for durable capability attribution. */
  readonly coreDb?: CoreDb;
  /** Shared provider dispatcher. */
  readonly llmGatewayDispatcher: LLMGatewayProviderDispatcher;
  /** Optional subscription-account supply used by private Gateway routes. */
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  /** Live API-key presence without Vault material resolution. */
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
  /** Resolves a private Provider route selected by the current Gateway config. */
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  /** Returns the current hot-reloadable Gateway configuration snapshot. */
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  /** Worker token and durable lease authority. */
  readonly workerControlGateway: WorkerControlGateway;
}): void {
  /**
   * Handles one authenticated worker inference request.
   *
   * @param c Hono request context.
   * @param endpoint OpenAI-compatible endpoint family.
   * @returns Provider response or stable worker inference error.
   */
  async function handleWorkerInferenceRequest(
    c: Context<{ Variables: AuthVariables }>,
    endpoint: WorkerInferenceEndpoint
  ): Promise<Response> {
    try {
      const workerInferenceTokenHashAuthentication = {
        tokenFamily: 'inference',
      } as const;
      const environmentPackage = workerControlGateway.authenticatePackageToken(
        c.req.header('authorization') ?? null,
        workerInferenceTokenHashAuthentication
      );

      rejectWorkerInferenceAuthorityHeaders(c.req.raw.headers);
      const json = await parseWorkerInferenceJsonRequest(c.req.raw);
      const input =
        endpoint === 'chat_completions'
          ? GatewayChatCompletionRequestSchema.parse(json)
          : GatewayResponsesRequestSchema.parse(json);
      const route = requireTrustedWorkerInferenceRoute(environmentPackage, input.model);
      let runtimeHint: WorkerInferenceRuntimeHint | undefined;
      try {
        runtimeHint = readWorkerInferenceRuntimeHint(
          input.openkit_runtime_hint,
          environmentPackage.control.adapter.targetRuntime
        );
      } catch {
        throw invalidWorkerInferenceRequest();
      }
      const provenanceRequired = environmentPackage.backend.requiredCapabilities.includes(
        WORKER_RUNTIME_PROVENANCE_FEATURE
      );
      if (provenanceRequired && !runtimeHint) {
        throw invalidWorkerInferenceRequest();
      }
      const sanitized = sanitizeWorkerInferenceRequest(input, route);
      const runtimeOriginRef = runtimeHint
        ? createWorkerRuntimeOriginRef(environmentPackage.snapshotId, runtimeHint.nativeThreadId)
        : null;
      if (
        !coreDb ||
        !currentWorkerLineageWorkspaceAuthority(
          coreDb,
          {
            workspaceId: environmentPackage.scope.workspaceId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            agentSessionId: environmentPackage.scope.agentSessionId,
            packageSnapshotId: environmentPackage.snapshotId,
            triggerActor: environmentPackage.scope.triggerActor,
          },
          'llm.gateway.use',
          true
        )
      ) {
        throw new WorkerInferenceRouteError(
          'worker_inference_unavailable',
          'Worker inference durable attribution is unavailable.',
          503
        );
      }
      let logicalModel: ResolvedLogicalModel | null = null;
      try {
        const snapshot = runtimeConfig();
        logicalModel = resolveLogicalModel(
          snapshot.gatewayConfig,
          snapshot.providerRegistry,
          route.model,
          providerSubscriptionAccountManager,
          providerCredentialConfigured
        );
      } catch {
        logicalModel = null;
      }
      const durableCall = startWorkerInferenceCall({
        ...(coreDb ? { coreDb } : {}),
        cacheDegraded: false,
        endpoint,
        environmentPackage,
        providerRef: null,
        request: sanitized,
        runtimeCacheLineageRef: null,
        runtimeOriginRef,
      });
      try {
        if (!logicalModel) {
          throw new WorkerInferenceRouteError(
            'worker_inference_provider_unavailable',
            'Worker inference provider is unavailable.',
            503
          );
        }
        const requestedEffort =
          endpoint === 'chat_completions'
            ? (input as z.infer<typeof GatewayChatCompletionRequestSchema>).reasoning_effort
            : (input as z.infer<typeof GatewayResponsesRequestSchema>).reasoning?.effort;
        const recordedEffort = environmentPackage.llm.reasoningEffort;
        const result = await dispatchLogicalModel<Response>({
          ledger: durableCall,
          reasoningEffort: {
            ...(requestedEffort === undefined ? {} : { requested: requestedEffort }),
            ...(recordedEffort === undefined ? {} : { recorded: recordedEffort }),
          },
          logicalModel,
          ...(route.modelParameters
            ? {
                pinnedLimits: {
                  context: route.modelParameters.contextWindow,
                  output: route.modelParameters.maxOutputTokens,
                },
              }
            : {}),
          requiredCapabilities: endpoint === 'responses' ? ['responses'] : ['chat-completions'],
          ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
          resolveGatewayProvider,
          signal: c.req.raw.signal,
          attempt: async ({
            provider,
            providerModel,
            subscriptionModels,
            corr,
            attempt,
            execution,
            effectiveEffort,
          }) => {
            const cache = resolveWorkerPromptCacheKey({
              accountSlotId: provider.accountSlotId ?? null,
              model: providerModel,
              ...(runtimeHint?.nativeCacheLineageId
                ? { nativeCacheLineageId: runtimeHint.nativeCacheLineageId }
                : {}),
              providerId: provider.id,
              runtimeFamily:
                runtimeHint?.runtimeFamily ?? environmentPackage.control.adapter.targetRuntime,
              subscriptionProviderId: provider.subscriptionProviderId ?? null,
              workspaceId: environmentPackage.scope.workspaceId,
            });
            const requestBody = withGatewayEffort(
              { ...sanitized, prompt_cache_key: cache.promptCacheKey },
              endpoint,
              effectiveEffort
            );
            durableCall.workspaceDb.sqlite
              .prepare(
                'UPDATE capability_calls SET runtime_cache_lineage_ref = ?, summary = ? WHERE call_id = ?'
              )
              .run(
                cache.runtimeCacheLineageRef,
                cache.degraded
                  ? `Worker ${endpoint} inference gateway call with request-scoped cache isolation.`
                  : `Worker ${endpoint} inference gateway call.`,
                durableCall.call.id
              );
            let responseTurnState: string | undefined;
            const requestTurnState = c.req.header('x-codex-turn-state');
            const dispatchContext = {
              capture: captureForCall(durableCall, corr, attempt),
              onUsage: (usage: unknown) =>
                execution.addUsageRecordIds(
                  recordLlmGatewayUsage({
                    durableCall,
                    model: logicalModel.id,
                    provider,
                    usage,
                  })
                ),
              ...(subscriptionModels ? { models: subscriptionModels } : {}),
              transport: {
                deadline: execution.deadline,
                ...(execution.onProviderHandoff
                  ? { onProviderHandoff: execution.onProviderHandoff }
                  : {}),
                ...(requestTurnState ? { codexTurnState: requestTurnState } : {}),
                onCodexTurnState: (value: string) => {
                  responseTurnState = value;
                },
                signal: c.req.raw.signal,
              },
            };

            if (endpoint === 'chat_completions') {
              const chatInput = input as z.infer<typeof GatewayChatCompletionRequestSchema>;
              const request: OpenAICompatibleChatCompletionRequest = {
                ...requestBody,
                messages: chatInput.messages.map((message): OpenAICompatibleChatMessage => {
                  const { tool_call_id: toolCallId, ...rest } = message;
                  return toolCallId ? { ...rest, tool_call_id: toolCallId } : rest;
                }),
                model: providerModel,
                stream: chatInput.stream ?? false,
              };
              if (request.stream) {
                const stream = await llmGatewayDispatcher.createChatCompletionStream(
                  provider,
                  { ...request, stream: true },
                  dispatchContext
                );
                return workerInferenceStreamResponse(
                  rewriteGatewayStreamModel(await execution.prepareStream(stream), logicalModel.id),
                  durableCall,
                  endpoint,
                  c.req.raw.signal,
                  responseTurnState
                );
              }
              const response = await llmGatewayDispatcher.createChatCompletion(
                provider,
                { ...request, stream: false },
                dispatchContext
              );
              const workerResponse = Response.json(
                { ...response, model: logicalModel.id },
                responseTurnState
                  ? { headers: { 'x-codex-turn-state': responseTurnState } }
                  : undefined
              );
              return workerResponse;
            }

            const responsesInput = input as z.infer<typeof GatewayResponsesRequestSchema>;
            const request: OpenAICompatibleResponsesRequest = {
              ...requestBody,
              input: responsesInput.input,
              model: providerModel,
              stream: responsesInput.stream ?? false,
            };
            if (request.stream) {
              const stream = await llmGatewayDispatcher.createResponsesStream(
                provider,
                { ...request, stream: true },
                dispatchContext
              );
              return workerInferenceStreamResponse(
                rewriteGatewayStreamModel(await execution.prepareStream(stream), logicalModel.id),
                durableCall,
                endpoint,
                c.req.raw.signal,
                responseTurnState
              );
            }
            const response = await llmGatewayDispatcher.createResponses(
              provider,
              { ...request, stream: false },
              dispatchContext
            );
            const workerResponse = Response.json(
              { ...response, model: logicalModel.id },
              responseTurnState
                ? { headers: { 'x-codex-turn-state': responseTurnState } }
                : undefined
            );
            return workerResponse;
          },
        });
        if (!input.stream) finishDurableLlmGatewayCall(durableCall, 'succeeded');
        return result;
      } catch (error) {
        const cancelled = finishDurableLlmGatewayFailure(
          durableCall,
          error,
          c.req.raw.signal,
          'worker_inference_failed',
          'worker_inference_cancelled'
        );
        if (cancelled)
          throw new WorkerInferenceRouteError(
            'worker_inference_cancelled',
            'Worker inference request was cancelled.',
            499
          );
        throw error;
      }
    } catch (error) {
      return asWorkerInferenceError(error);
    }
  }

  app.post('/api/worker-inference/v1/chat/completions', (c) =>
    handleWorkerInferenceRequest(c, 'chat_completions')
  );
  app.post('/api/worker-inference/v1/responses', (c) =>
    handleWorkerInferenceRequest(c, 'responses')
  );
}

/**
 * Creates a byte-preserving SSE response that completes its durable call on consumption.
 *
 * @param stream Provider SSE stream.
 * @param durableCall Started capability call, when storage is available.
 * @param endpoint Worker inference endpoint family.
 * @param signal Worker request cancellation signal.
 * @param codexTurnState Optional final Codex turn state returned by the provider.
 * @returns OpenAI-compatible SSE response.
 */
function workerInferenceStreamResponse(
  stream: ReadableStream<Uint8Array>,
  durableCall: DurableLlmGatewayCall | null,
  endpoint: WorkerInferenceEndpoint,
  signal: AbortSignal,
  codexTurnState?: string
): Response {
  return new Response(
    normalizeGatewayTerminalStream(stream, endpoint, {
      cancellationCode: 'worker_inference_cancelled',
      durableCall,
      failureCode: 'worker_inference_stream_failed',
      failureMessage: 'Worker inference stream failed.',
      heartbeatIntervalMs: WORKER_INFERENCE_HEARTBEAT_INTERVAL_MS,
      signal,
    }),
    {
      headers: {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        ...(codexTurnState ? { 'x-codex-turn-state': codexTurnState } : {}),
      },
    }
  );
}

/** Rewrites provider-native model fields in one JSON SSE payload to the public logical ID. */
function rewriteGatewaySseEventModel(event: string, logicalModelId: string): string {
  return event
    .split(/(\r?\n)/)
    .map((line) => {
      const match = /^data:\s*(.+)$/.exec(line);
      if (!match || match[1] === '[DONE]') return line;
      try {
        const payload = JSON.parse(match[1]!) as Record<string, unknown>;
        if (typeof payload.model === 'string') payload.model = logicalModelId;
        if (payload.response && typeof payload.response === 'object') {
          const response = payload.response as Record<string, unknown>;
          if (typeof response.model === 'string') response.model = logicalModelId;
        }
        return `data: ${JSON.stringify(payload)}`;
      } catch {
        return line;
      }
    })
    .join('');
}

/** Hides provider-native model fields in an OpenAI-compatible SSE stream. */
function rewriteGatewayStreamModel(
  stream: ReadableStream<Uint8Array>,
  logicalModelId: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = /\r?\n\r?\n/.exec(buffer);
        while (boundary?.index !== undefined) {
          const end = boundary.index + boundary[0].length;
          controller.enqueue(
            encoder.encode(
              `${rewriteGatewaySseEventModel(buffer.slice(0, boundary.index), logicalModelId)}${boundary[0]}`
            )
          );
          buffer = buffer.slice(end);
          boundary = /\r?\n\r?\n/.exec(buffer);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer)
          controller.enqueue(encoder.encode(rewriteGatewaySseEventModel(buffer, logicalModelId)));
      },
    })
  );
}

/**
 * Requires authored provider authority for a public Gateway model before subscription work.
 *
 * @param provider Resolved provider selected by the route.
 * @param model Requested model id.
 * @throws OpenAICompatibleProviderError when the model is not authored on the profile.
 */
function assertGatewayModelAuthorized(provider: ResolvedLLMProviderConfig, model: string): void {
  if (!provider.models.includes(model)) {
    throw new OpenAICompatibleProviderError({
      code: 'model_not_configured',
      message: 'Requested model is not configured for this provider.',
      status: 400,
      type: 'invalid_request_error',
    });
  }
}

/**
 * Plans and executes a logical request with shared retry, certainty and commit rules. Known current member limits must meet optional entry-admitted minimums; unknown limits add no restriction and ineligible members use the existing pinned-capability selection reason.
 * @param input Current tier, pinned capabilities and optional limits, cancellation and validated consumer effect.
 * @returns The selected result; authority and retention errors remain terminal.
 */
export async function dispatchLogicalModel<T>(input: {
  /** Already-opened attributed logical invocation; absence retains the blind coverage gap. */
  ledger?: GatewayCallLedgerBinding;
  logicalModel: ResolvedLogicalModel;
  signal: AbortSignal;
  requiredCapabilities?: readonly string[];
  /** Native request evidence and immutable bound-Turn fallback; absence leaves internal producers unchanged. */
  reasoningEffort?: { requested?: ReasoningEffort; recorded?: ReasoningEffort };
  /** Entry-admitted coherent minimums; absent or unknown limits constrain nothing. */
  pinnedLimits?: Pick<NonNullable<ResolvedLogicalModel['contract']>, 'context' | 'output'>;
  clock?: GatewayClock;
  resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  /** Private diagnostic observer before member resolution, including failures that never reach the producer. */
  onAttemptStart?: (context: { corr: string; attempt: number }) => void;
  attempt: (route: {
    provider: ResolvedLLMProviderConfig;
    providerModel: string;
    subscriptionModels: Awaited<ReturnType<typeof resolveGatewaySubscriptionModels>>;
    corr: string;
    attempt: number;
    execution: GatewayAttemptContext;
    /** Member-fitted control; absent when dropped or left to the Provider default. */
    effectiveEffort?: ReasoningEffort;
  }) => Promise<T>;
}): Promise<T> {
  const corr = randomUUID();
  const providers = new Map<string, ResolvedLLMProviderConfig>();
  const resolutionFailures = new Map<string, unknown>();
  const selections = planLogicalModel(
    input.logicalModel,
    input.requiredCapabilities ?? [],
    (route, required) => {
      if (
        required.length === 0 &&
        input.pinnedLimits?.context == null &&
        input.pinnedLimits?.output == null
      )
        return true;
      let provider: ResolvedLLMProviderConfig;
      try {
        provider = input.resolveGatewayProvider(route.providerProfileId, route.providerModel);
      } catch (error) {
        resolutionFailures.set(route.id, error);
        return true;
      } // The first owned failure is consumed once, without a second credential read during selection.
      providers.set(route.id, provider);
      const metadata = resolveEffectiveModelMetadata(
        {
          id: provider.id,
          kind: 'direct',
          displayName: provider.displayName,
          models: [...provider.models],
          ...(provider.vendor ? { vendor: provider.vendor } : {}),
          ...(provider.modelMetadata ? { modelMetadata: provider.modelMetadata } : {}),
        },
        route.providerModel
      );
      if (
        (input.pinnedLimits?.context != null &&
          metadata.limit?.context != null &&
          metadata.limit.context < input.pinnedLimits.context) ||
        (input.pinnedLimits?.output != null &&
          metadata.limit?.output != null &&
          metadata.limit.output < input.pinnedLimits.output)
      )
        return false;
      return required.every((capability) => {
        if (capability === 'responses')
          return provider.gatewayCapabilities.responses !== 'unsupported';
        if (capability === 'chat-completions')
          return provider.gatewayCapabilities.chatCompletions !== 'unsupported';
        if (capability === 'tool-calling') return metadata.tool_call === true;
        if (capability === 'reasoning') return metadata.reasoning === true;
        if (capability === 'attachment') return metadata.attachment === true;
        if (capability === 'temperature') return metadata.temperature === true;
        if (capability.startsWith('input:'))
          return metadata.modalities?.input?.includes(capability.slice(6)) === true;
        if (capability.startsWith('output:'))
          return metadata.modalities?.output?.includes(capability.slice(7)) === true;
        return false;
      });
    }
  );
  const writeEntry = (
    entry: import('@openkit/protocol').GatewayRouteLineageEntry,
    entryIndex?: number
  ) =>
    input.ledger
      ? writeGatewayRouteLineage({
          ...input.ledger,
          logicalModelId: input.logicalModel.id,
          entry,
          ...(entryIndex === undefined ? {} : { entryIndex }),
        })
      : undefined;
  for (const selection of selections) {
    if (!selection.selected)
      writeEntry({
        kind: 'unavailable',
        routeMemberId: selection.route.id,
        ...(providers.get(selection.route.id)
          ? {
              providerProfileId: providers.get(selection.route.id)!.id,
              providerModel: selection.route.providerModel,
            }
          : {}),
        selectionReason: selection.reason,
        failureKind:
          selection.reason === 'pinned_capability_unavailable'
            ? 'unsupported'
            : selection.reason === 'provider_api_key_missing'
              ? 'auth_rejected'
              : 'provider_unavailable',
        unavailableReason: selection.reason,
      });
  }
  return executeGatewayPlan({
    selections,
    autoFailover: input.logicalModel.autoFailover,
    signal: input.signal,
    ...(input.clock ? { clock: input.clock } : {}),
    attempt: async (selection, execution) => {
      input.onAttemptStart?.({ corr, attempt: execution.attemptOrder });
      const route = selection.route;
      let provider: ResolvedLLMProviderConfig;
      let subscriptionModels: Awaited<ReturnType<typeof resolveGatewaySubscriptionModels>>;
      try {
        if (resolutionFailures.has(route.id)) {
          const error = resolutionFailures.get(route.id);
          resolutionFailures.delete(route.id);
          throw error;
        }
        provider =
          providers.get(route.id) ??
          input.resolveGatewayProvider(route.providerProfileId, route.providerModel);
        providers.set(route.id, provider);
        assertGatewayModelAuthorized(provider, route.providerModel);
        subscriptionModels = await resolveGatewaySubscriptionModels(
          provider,
          input.providerSubscriptionAccountManager
        );
      } catch (error) {
        const code = error instanceof OpenAICompatibleProviderError ? error.code : 'unknown';
        const unavailable = [
          'gateway_provider_unavailable',
          'provider_not_configured',
          'provider_not_dispatchable',
          'vault-locked',
          'backend-unavailable',
        ].includes(code);
        const authentication = [
          'gateway_provider_authentication_failed',
          'reference-not-found',
          'reference-revoked',
          'version-expired',
        ].includes(code);
        writeEntry({
          kind: 'unavailable',
          routeMemberId: route.id,
          ...(providers.get(route.id)
            ? { providerProfileId: providers.get(route.id)!.id, providerModel: route.providerModel }
            : {}),
          selectionReason: selection.reason,
          failureKind: authentication
            ? 'auth_rejected'
            : unavailable
              ? 'provider_unavailable'
              : code === 'model_not_configured'
                ? 'invalid_request'
                : 'unknown',
          unavailableReason:
            unavailable || authentication || code === 'model_not_configured'
              ? code
              : 'provider_unavailable',
        });
        // Only this resolver owns these pre-dispatch mappings; no text/status reclassification.
        if (error instanceof OpenAICompatibleProviderError) {
          if (unavailable || authentication) {
            // These local resolver outcomes have no Provider effect. Their HTTP values are
            // Error Contract projections, never claimed as exposed upstream HTTP status.
            throw new GatewayAttemptFailure(
              { kind: unavailable ? 'provider_unavailable' : 'auth_rejected', settled: true },
              error,
              true
            );
          }
        }
        throw error;
      }
      const effort = input.reasoningEffort
        ? fitGatewayEffort(provider, route.providerModel, input.reasoningEffort)
        : {};
      const entry: Extract<
        import('@openkit/protocol').GatewayRouteLineageEntry,
        { kind: 'attempt' }
      > = {
        kind: 'attempt',
        routeMemberId: route.id,
        providerProfileId: provider.id,
        providerModel: route.providerModel,
        selectionReason: selection.reason,
        attemptOrder: execution.attemptOrder,
        retryIndex: execution.retryIndex,
        outputBegan: false,
        terminalResult: 'unknown',
        ...(effort.requestedEffort === undefined
          ? {}
          : { requestedEffort: effort.requestedEffort }),
      };
      const entryIndex = writeEntry(entry);
      const retain = () => {
        entry.outputBegan = execution.outputBegan;
        writeEntry(entry, entryIndex);
      };
      const observedExecution: GatewayAttemptContext = {
        ...execution,
        onProviderHandoff: () => {
          if (!input.reasoningEffort) return;
          Object.assign(entry, effort);
          retain();
        },
        get outputBegan() {
          return execution.outputBegan;
        },
        get streamPrepared() {
          return execution.streamPrepared;
        },
        addUsageRecordIds: (ids) => {
          if (!ids.length) return;
          entry.usageRecordIds = [...new Set([...(entry.usageRecordIds ?? []), ...ids])];
          retain();
        },
        prepareStream: (stream) =>
          execution.prepareStream(stream, (state, error) => {
            if (state === 'completed' && entry.terminalResult === 'unknown')
              entry.terminalResult = 'succeeded';
            else if (state === 'incomplete') entry.terminalResult = 'incomplete';
            else if (state === 'failed') {
              entry.terminalResult = 'failed';
              entry.failureKind =
                (error as { failure?: PiAiFailure } | null)?.failure?.kind ?? 'unknown';
            } else if (state === 'unknown' || state === 'interrupted') entry.terminalResult = state;
            retain();
          }),
      };
      try {
        const result = await input.attempt({
          provider,
          providerModel: route.providerModel,
          subscriptionModels,
          corr,
          attempt: execution.attemptOrder,
          execution: observedExecution,
          ...(effort.effectiveEffort === undefined
            ? {}
            : { effectiveEffort: effort.effectiveEffort }),
        });
        if (!execution.streamPrepared) {
          execution.commit();
          entry.terminalResult = 'succeeded';
          retain();
        }
        return result;
      } catch (original) {
        const error =
          original instanceof GatewayUnsupportedFeatureError
            ? new GatewayAttemptFailure({ kind: 'unsupported', settled: true }, original)
            : original;
        const failure = (error as { failure?: PiAiFailure } | null)?.failure;
        entry.failureKind =
          failure?.kind ??
          (input.signal.aborted && error === input.signal.reason ? 'cancelled' : 'unknown');
        entry.terminalResult = 'failed';
        retain();
        throw error;
      }
    },
  });
}

/**
 * Registers the public OpenAI-compatible LLM Gateway routes.
 *
 * @param dependencies Hono app and current Gateway runtime dependencies.
 */
export function registerLlmGatewayRoutes({
  app,
  providerCredentialConfigured,
  coreDb,
  requestStore,
  llmGatewayDispatcher,
  providerSubscriptionAccountManager,
  resolveGatewayProvider,
  runtimeConfig,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb?: CoreDb;
  readonly requestStore?: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly llmGatewayDispatcher: LLMGatewayProviderDispatcher;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  /** Live API-key presence without Vault material resolution. */
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
}): void {
  /**
   * Checks whether the Gateway is enabled by runtime config.
   *
   * @returns True when Gateway routes are enabled.
   */
  function isGatewayEnabled(): boolean {
    return runtimeConfig().gatewayConfig.enabled;
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

  function requireLogicalModel(logicalModelId: string): ResolvedLogicalModel {
    try {
      const snapshot = runtimeConfig();
      const logicalModel = resolveLogicalModel(
        snapshot.gatewayConfig,
        snapshot.providerRegistry,
        logicalModelId,
        providerSubscriptionAccountManager,
        providerCredentialConfigured
      );
      if (logicalModel) return logicalModel;
    } catch {
      throw new OpenAICompatibleProviderError({
        code: 'gateway_not_configured',
        message: 'Gateway logical model configuration is unavailable.',
        status: 503,
        type: 'provider_error',
      });
    }
    throw new OpenAICompatibleProviderError({
      code: 'model_not_configured',
      message: 'Requested logical model is not configured.',
      status: 400,
      type: 'invalid_request_error',
    });
  }

  app.get('/v1/models', async (c) => {
    if (!isGatewayEnabled()) {
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

    try {
      const snapshot = runtimeConfig();
      const data = resolveLogicalModelCatalog(
        snapshot.gatewayConfig,
        snapshot.providerRegistry,
        providerSubscriptionAccountManager,
        providerCredentialConfigured
      )
        .filter((model) => model.routes.some((route) => route.available))
        .map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: 'openkit',
          display_name: model.displayName,
          capabilities: model.capabilities,
          ...(model.reasoningEffortLevels === undefined
            ? {}
            : { reasoningEffortLevels: model.reasoningEffortLevels }),
        }));
      return c.json({ object: 'list', data });
    } catch {
      return asOpenAIGatewayError(
        new OpenAICompatibleProviderError({
          code: 'gateway_not_configured',
          message: 'Gateway logical model configuration is unavailable.',
          status: 503,
          type: 'provider_error',
        })
      );
    }
  });

  app.post('/v1/chat/completions', async (c) => {
    try {
      const input = GatewayChatCompletionRequestSchema.parse(await c.req.json());

      if (!isGatewayEnabled()) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.chat_completions',
          providerId: null,
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

      const authorityActor = { kind: 'user', id: c.get('actor').userId } as const;
      if (
        publicGatewayAuthorityDenied({
          actor: authorityActor,
          ...(coreDb ? { coreDb } : {}),
          metadata: (input as { metadata?: unknown }).metadata,
          ...(requestStore ? { store: requestStore(c) } : {}),
        })
      ) {
        return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
      }

      const logicalModel = requireLogicalModel(input.model);

      recordLlmGatewayPolicyDecision({
        action: 'llm.gateway.chat_completions',
        providerId: logicalModel.routes[0]?.providerProfileId ?? null,
        reasonCode: 'gateway_allowed',
        result: 'allow',
        route: '/v1/chat/completions',
      });

      const request = {
        ...input,
        messages: input.messages.map((message): OpenAICompatibleChatMessage => {
          const { tool_call_id, ...rest } = message;
          return { ...rest, ...(tool_call_id === undefined ? {} : { tool_call_id }) };
        }),
      };

      const durableCall = startPublicLlmGatewayCall({
        ...(coreDb ? { coreDb } : {}),
        authorityActor,
        endpoint: 'chat_completions',
        metadata: (request as { metadata?: unknown }).metadata,
        request,
      });
      try {
        const recordedEffort = recordedEffortForCall(durableCall);
        const result = await dispatchLogicalModel<Response>({
          ...(durableCall ? { ledger: durableCall } : {}),
          reasoningEffort: {
            ...(input.reasoning_effort === undefined ? {} : { requested: input.reasoning_effort }),
            ...(recordedEffort === undefined ? {} : { recorded: recordedEffort }),
          },
          logicalModel,
          requiredCapabilities: ['chat-completions'],
          ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
          resolveGatewayProvider,
          signal: c.req.raw.signal,
          attempt: async ({
            provider,
            providerModel,
            subscriptionModels,
            corr,
            attempt,
            execution,
            effectiveEffort,
          }) => {
            const fittedRequest = withGatewayEffort(request, 'chat_completions', effectiveEffort);
            if (input.stream) {
              const stream = await llmGatewayDispatcher.createChatCompletionStream(
                provider,
                { ...fittedRequest, model: providerModel, stream: true },
                {
                  capture: captureForCall(durableCall, corr, attempt),
                  onUsage: (usage) =>
                    execution.addUsageRecordIds(
                      recordLlmGatewayUsage({
                        durableCall,
                        model: logicalModel.id,
                        provider,
                        usage,
                      })
                    ),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: {
                    signal: c.req.raw.signal,
                    deadline: execution.deadline,
                    ...(execution.onProviderHandoff
                      ? { onProviderHandoff: execution.onProviderHandoff }
                      : {}),
                  },
                }
              );
              return new Response(
                normalizeGatewayTerminalStream(
                  rewriteGatewayStreamModel(await execution.prepareStream(stream), logicalModel.id),
                  'chat_completions',
                  { durableCall, signal: c.req.raw.signal }
                ),
                {
                  headers: {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                  },
                }
              );
            }

            const completion: OpenAICompatibleChatCompletionResponse =
              await llmGatewayDispatcher.createChatCompletion(
                provider,
                { ...fittedRequest, model: providerModel, stream: false },
                {
                  capture: captureForCall(durableCall, corr, attempt),
                  onUsage: (usage) =>
                    execution.addUsageRecordIds(
                      recordLlmGatewayUsage({
                        durableCall,
                        model: logicalModel.id,
                        provider,
                        usage,
                      })
                    ),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: {
                    signal: c.req.raw.signal,
                    deadline: execution.deadline,
                    ...(execution.onProviderHandoff
                      ? { onProviderHandoff: execution.onProviderHandoff }
                      : {}),
                  },
                }
              );
            return c.json({ ...completion, model: logicalModel.id });
          },
        });
        if (!input.stream) finishDurableLlmGatewayCall(durableCall, 'succeeded');
        return result;
      } catch (error) {
        const cancelled = finishDurableLlmGatewayFailure(
          durableCall,
          error,
          c.req.raw.signal,
          'llm_gateway_failed',
          'llm_gateway_cancelled'
        );
        if (cancelled) throw new GatewayRequestCancelledError();
        throw error;
      }
    } catch (error) {
      return asOpenAIGatewayError(error);
    }
  });

  app.post('/v1/responses', async (c) => {
    try {
      const input = GatewayResponsesRequestSchema.parse(await c.req.json());

      if (!isGatewayEnabled()) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.responses',
          providerId: null,
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

      const authorityActor = { kind: 'user', id: c.get('actor').userId } as const;
      if (
        publicGatewayAuthorityDenied({
          actor: authorityActor,
          ...(coreDb ? { coreDb } : {}),
          metadata: (input as { metadata?: unknown }).metadata,
          ...(requestStore ? { store: requestStore(c) } : {}),
        })
      ) {
        return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
      }

      const logicalModel = requireLogicalModel(input.model);

      recordLlmGatewayPolicyDecision({
        action: 'llm.gateway.responses',
        providerId: logicalModel.routes[0]?.providerProfileId ?? null,
        reasonCode: 'gateway_allowed',
        result: 'allow',
        route: '/v1/responses',
      });

      const request = {
        ...input,
        stream: input.stream ?? false,
      };

      const durableCall = startPublicLlmGatewayCall({
        ...(coreDb ? { coreDb } : {}),
        authorityActor,
        endpoint: 'responses',
        metadata: (request as { metadata?: unknown }).metadata,
        request,
      });
      try {
        const recordedEffort = recordedEffortForCall(durableCall);
        const result = await dispatchLogicalModel<Response>({
          ...(durableCall ? { ledger: durableCall } : {}),
          reasoningEffort: {
            ...(input.reasoning?.effort === undefined
              ? {}
              : { requested: input.reasoning?.effort }),
            ...(recordedEffort === undefined ? {} : { recorded: recordedEffort }),
          },
          logicalModel,
          requiredCapabilities: ['responses'],
          ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
          resolveGatewayProvider,
          signal: c.req.raw.signal,
          attempt: async ({
            provider,
            providerModel,
            subscriptionModels,
            corr,
            attempt,
            execution,
            effectiveEffort,
          }) => {
            const fittedRequest = withGatewayEffort(request, 'responses', effectiveEffort);
            if (input.stream) {
              const stream = await llmGatewayDispatcher.createResponsesStream(
                provider,
                { ...fittedRequest, model: providerModel, stream: true },
                {
                  capture: captureForCall(durableCall, corr, attempt),
                  onUsage: (usage) =>
                    execution.addUsageRecordIds(
                      recordLlmGatewayUsage({
                        durableCall,
                        model: logicalModel.id,
                        provider,
                        usage,
                      })
                    ),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: {
                    signal: c.req.raw.signal,
                    deadline: execution.deadline,
                    ...(execution.onProviderHandoff
                      ? { onProviderHandoff: execution.onProviderHandoff }
                      : {}),
                  },
                }
              );
              return new Response(
                normalizeGatewayTerminalStream(
                  rewriteGatewayStreamModel(await execution.prepareStream(stream), logicalModel.id),
                  'responses',
                  { durableCall, signal: c.req.raw.signal }
                ),
                {
                  headers: {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                  },
                }
              );
            }

            const response: OpenAICompatibleResponsesResponse =
              await llmGatewayDispatcher.createResponses(
                provider,
                { ...fittedRequest, model: providerModel },
                {
                  capture: captureForCall(durableCall, corr, attempt),
                  onUsage: (usage) =>
                    execution.addUsageRecordIds(
                      recordLlmGatewayUsage({
                        durableCall,
                        model: logicalModel.id,
                        provider,
                        usage,
                      })
                    ),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: {
                    signal: c.req.raw.signal,
                    deadline: execution.deadline,
                    ...(execution.onProviderHandoff
                      ? { onProviderHandoff: execution.onProviderHandoff }
                      : {}),
                  },
                }
              );
            return c.json({ ...response, model: logicalModel.id });
          },
        });
        if (!input.stream) finishDurableLlmGatewayCall(durableCall, 'succeeded');
        return result;
      } catch (error) {
        const cancelled = finishDurableLlmGatewayFailure(
          durableCall,
          error,
          c.req.raw.signal,
          'llm_gateway_failed',
          'llm_gateway_cancelled'
        );
        if (cancelled) throw new GatewayRequestCancelledError();
        throw error;
      }
    } catch (error) {
      return asOpenAIGatewayError(error);
    }
  });
}
