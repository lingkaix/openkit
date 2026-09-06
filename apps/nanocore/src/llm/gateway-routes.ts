import { randomUUID } from 'node:crypto';
import { constants as zlibConstants, zstdDecompress } from 'node:zlib';

import {
  type AgentEnvironmentPackage,
  WORKER_RUNTIME_PROVENANCE_FEATURE,
} from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { recordGatewayPolicyDecision } from '../policy/permission-decisions.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import {
  type WorkerControlGateway,
  WorkerControlGatewayError,
} from '../runtime/worker-control-gateway.js';
import { createWorkerRuntimeOriginRef } from '../runtime/worker-runtime-provenance.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { GatewayUnsupportedFeatureError } from './gateway-converters.js';
import { parseUsage } from './gateway-usage.js';
import {
  type ResolvedLogicalModel,
  resolveLogicalModel,
  resolveLogicalModelCatalog,
} from './logical-models.js';
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
  })
  .passthrough();
const GatewayResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]),
    stream: z.boolean().optional(),
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
  /** Provider selected for the public gateway call. */
  provider: ResolvedLLMProviderConfig;
  /** Gateway endpoint family. */
  endpoint: 'chat_completions' | 'responses';
  /** OpenAI-compatible request metadata. */
  metadata: unknown;
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

    return {
      call: startCapabilityCall({
        agentId: lineage.agentId ?? null,
        agentSessionId: lineage.agentSessionId ?? null,
        authorityActor: input.authorityActor,
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
      finished: false,
      workspaceDb,
    };
  } catch (error) {
    workspaceDb.sqlite.close();
    throw error;
  }
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
}): void {
  if (!input.durableCall || input.durableCall.finished) {
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
    return;
  }

  recordUsage({
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
        ))
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
  readonly providerRef: string;
  /** Product-safe runtime origin reference when provenance is required. */
  readonly runtimeOriginRef: string | null;
  /** Product-safe runtime cache lineage reference when explicitly reported. */
  readonly runtimeCacheLineageRef: string | null;
  /** Whether this request used request-scoped cache isolation. */
  readonly cacheDegraded: boolean;
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

    return {
      call: startCapabilityCall({
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
      }),
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
 */
function asOpenAIGatewayError(error: unknown): Response {
  if (error instanceof LogicalModelRoutesExhaustedError) {
    return Response.json(
      { error: { message: error.message, type: error.type, code: error.code } },
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
          message: error.message,
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
    const normalized = classifyGatewayProviderFailure(error, 'provider_error');

    return Response.json(
      {
        error: {
          message: gatewayProviderFailureMessage(normalized.code),
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
  /** Stable ledger error code used when upstream streaming fails. */
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
 * @param options Durable completion, cancellation, and error-normalization options.
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
            'aborted',
            options.cancellationCode ?? 'llm_gateway_cancelled'
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
        try {
          finishDurableLlmGatewayStreamCall(
            options.durableCall ?? null,
            cancelled ? 'aborted' : isGatewayTimeout(error) ? 'timed-out' : 'failed',
            cancelled
              ? (options.cancellationCode ?? 'llm_gateway_cancelled')
              : (options.failureCode ?? 'llm_gateway_stream_failed')
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
          finishDurableLlmGatewayStreamCall(options.durableCall ?? null, 'succeeded');
        } finally {
          releaseReader();
        }
        controller.close();
        return;
      }

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
  return Boolean(signal?.aborted && error === signal.reason);
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
    cancelled ? cancellationCode : failureCode
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
  const normalized = classifyGatewayProviderFailure(error, 'gateway_stream_failed');
  const payload = {
    error: {
      message: failureMessage ?? gatewayProviderFailureMessage(errorCode ?? normalized.code),
      type: normalized.type,
      code: errorCode ?? normalized.code,
      endpoint,
    },
    stopReason,
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
  const code = typeof detail.code === 'string' ? detail.code : '';
  const providerType = typeof detail.type === 'string' ? detail.type : '';
  const message = error instanceof Error ? error.message : String(error);
  const signal = `${code} ${providerType} ${message}`.toLowerCase();
  const type = 'provider_error';

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
    status === 423 ||
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
 * Projects one normalized provider failure code onto a fixed public message.
 *
 * @param code Stable OpenKit provider failure code.
 * @returns Generic public message that contains no upstream text.
 */
function gatewayProviderFailureMessage(code: string): string {
  switch (code) {
    case 'gateway_provider_authentication_failed':
      return 'Provider authentication failed.';
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
 * Registers token-only worker inference routes backed by AEP authority.
 *
 * @param dependencies Hono app, worker identity gateway, dispatcher, and durable storage.
 */
export function registerWorkerInferenceRoutes({
  app,
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
          c.req.raw.headers,
          input,
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
      const runtimeOriginRef =
        provenanceRequired && runtimeHint
          ? createWorkerRuntimeOriginRef(environmentPackage.snapshotId, runtimeHint.nativeThreadId)
          : null;
      if (
        !coreDb ||
        !currentWorkspaceAuthority(
          coreDb,
          environmentPackage.scope.workspaceId,
          environmentPackage.scope.triggerActor,
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
          route.model
        );
      } catch {
        logicalModel = null;
      }
      if (!logicalModel) {
        const unavailableCall = startWorkerInferenceCall({
          ...(coreDb ? { coreDb } : {}),
          cacheDegraded: false,
          endpoint,
          environmentPackage,
          providerRef: route.model,
          runtimeCacheLineageRef: null,
          runtimeOriginRef,
        });
        finishDurableLlmGatewayCall(
          unavailableCall,
          'failed',
          'worker_inference_provider_unavailable'
        );
        throw new WorkerInferenceRouteError(
          'worker_inference_provider_unavailable',
          'Worker inference provider is unavailable.',
          503
        );
      }
      return await dispatchLogicalModel<Response>({
        logicalModel,
        ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
        resolveGatewayProvider,
        signal: c.req.raw.signal,
        attempt: async ({ provider, providerModel, subscriptionModels }) => {
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
          const requestBody = { ...sanitized, prompt_cache_key: cache.promptCacheKey };
          let durableCall: DurableLlmGatewayCall | null;
          try {
            durableCall = startWorkerInferenceCall({
              ...(coreDb ? { coreDb } : {}),
              cacheDegraded: cache.degraded,
              endpoint,
              environmentPackage,
              providerRef: provider.id,
              runtimeCacheLineageRef: cache.runtimeCacheLineageRef,
              runtimeOriginRef,
            });
          } catch {
            throw new WorkerInferenceRouteError(
              'worker_inference_unavailable',
              'Worker inference durable attribution is unavailable.',
              503
            );
          }
          let responseTurnState: string | undefined;
          const requestTurnState = c.req.header('x-codex-turn-state');
          const dispatchContext = {
            onUsage: (usage: unknown) =>
              recordLlmGatewayUsage({
                durableCall,
                model: logicalModel.id,
                provider,
                usage,
              }),
            ...(subscriptionModels ? { models: subscriptionModels } : {}),
            transport: {
              ...(requestTurnState ? { codexTurnState: requestTurnState } : {}),
              onCodexTurnState: (value: string) => {
                responseTurnState = value;
              },
              signal: c.req.raw.signal,
            },
          };

          try {
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
                  rewriteGatewayStreamModel(stream, logicalModel.id),
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
              finishDurableLlmGatewayCall(durableCall, 'succeeded');
              return workerResponse;
            }

            const responsesInput = input as z.infer<typeof GatewayResponsesRequestSchema>;
            const tools = sanitized.tools;
            const messageAnchoredTools = Array.isArray(tools) && tools.length > 0;
            const request: OpenAICompatibleResponsesRequest = {
              ...requestBody,
              input: messageAnchoredTools
                ? [
                    { role: 'developer', tools, type: 'additional_tools' },
                    ...(Array.isArray(responsesInput.input)
                      ? responsesInput.input
                      : [{ content: responsesInput.input, role: 'user' }]),
                  ]
                : responsesInput.input,
              model: providerModel,
              stream: responsesInput.stream ?? false,
              ...(messageAnchoredTools ? { tools: [] } : {}),
            };
            if (request.stream) {
              const stream = await llmGatewayDispatcher.createResponsesStream(
                provider,
                { ...request, stream: true },
                dispatchContext
              );
              return workerInferenceStreamResponse(
                rewriteGatewayStreamModel(stream, logicalModel.id),
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
            finishDurableLlmGatewayCall(durableCall, 'succeeded');
            return workerResponse;
          } catch (error) {
            const cancelled = finishDurableLlmGatewayFailure(
              durableCall,
              error,
              c.req.raw.signal,
              'worker_inference_failed',
              'worker_inference_cancelled'
            );
            if (cancelled) {
              throw new WorkerInferenceRouteError(
                'worker_inference_cancelled',
                'Worker inference request was cancelled.',
                499
              );
            }
            throw error;
          }
        },
      });
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

/** Stable error returned after every eligible private route fails before output starts. */
export class LogicalModelRoutesExhaustedError extends Error {
  public readonly code = 'gateway_logical_model_unavailable';
  public readonly status = 503;
  public readonly type = 'provider_error';

  public constructor() {
    super('Logical model is temporarily unavailable.');
    this.name = 'LogicalModelRoutesExhaustedError';
  }
}

/** Returns whether one pre-output failure permits trying the next ordered route member. */
function isLogicalModelFallbackEligible(error: unknown): boolean {
  if (error instanceof WorkerInferenceRouteError) return false;
  const code = classifyGatewayProviderFailure(error, 'provider_error').code;
  return (
    code === 'gateway_provider_authentication_failed' ||
    code === 'gateway_provider_rate_limited' ||
    code === 'gateway_provider_unavailable'
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

/** Dispatches one logical model through its ordered private routes before output starts. */
export async function dispatchLogicalModel<T>(input: {
  logicalModel: ResolvedLogicalModel;
  signal: AbortSignal;
  resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  attempt: (route: {
    provider: ResolvedLLMProviderConfig;
    providerModel: string;
    subscriptionModels: Awaited<ReturnType<typeof resolveGatewaySubscriptionModels>>;
  }) => Promise<T>;
}): Promise<T> {
  for (const [index, route] of input.logicalModel.routes.entries()) {
    try {
      const provider = input.resolveGatewayProvider(route.providerProfileId, route.providerModel);
      assertGatewayModelAuthorized(provider, route.providerModel);
      const subscriptionModels = await resolveGatewaySubscriptionModels(
        provider,
        input.providerSubscriptionAccountManager
      );
      return await input.attempt({
        provider,
        providerModel: route.providerModel,
        subscriptionModels,
      });
    } catch (error) {
      if (input.signal.aborted || !isLogicalModelFallbackEligible(error)) throw error;
      if (index === input.logicalModel.routes.length - 1) {
        throw new LogicalModelRoutesExhaustedError();
      }
    }
  }
  throw new LogicalModelRoutesExhaustedError();
}

/**
 * Registers the public OpenAI-compatible LLM Gateway routes.
 *
 * @param dependencies Hono app and current Gateway runtime dependencies.
 */
export function registerLlmGatewayRoutes({
  app,
  coreDb,
  llmGatewayDispatcher,
  providerSubscriptionAccountManager,
  resolveGatewayProvider,
  runtimeConfig,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb?: CoreDb;
  readonly llmGatewayDispatcher: LLMGatewayProviderDispatcher;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
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
        logicalModelId
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
        snapshot.providerRegistry
      ).map((model) => ({
        id: model.id,
        object: 'model',
        owned_by: 'openkit',
        display_name: model.displayName,
        capabilities: model.capabilities,
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
          const mapped: OpenAICompatibleChatMessage = {
            role: message.role,
            content: message.content,
          };

          return message.tool_call_id ? { ...mapped, tool_call_id: message.tool_call_id } : mapped;
        }),
      };

      return await dispatchLogicalModel<Response>({
        logicalModel,
        ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
        resolveGatewayProvider,
        signal: c.req.raw.signal,
        attempt: async ({ provider, providerModel, subscriptionModels }) => {
          const durableCall = startPublicLlmGatewayCall({
            ...(coreDb ? { coreDb } : {}),
            authorityActor,
            endpoint: 'chat_completions',
            metadata: (request as { metadata?: unknown }).metadata,
            provider,
          });
          try {
            if (input.stream) {
              const stream = await llmGatewayDispatcher.createChatCompletionStream(
                provider,
                { ...request, model: providerModel, stream: true },
                {
                  onUsage: (usage) =>
                    recordLlmGatewayUsage({
                      durableCall,
                      model: logicalModel.id,
                      provider,
                      usage,
                    }),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: { signal: c.req.raw.signal },
                }
              );
              return new Response(
                normalizeGatewayTerminalStream(
                  rewriteGatewayStreamModel(stream, logicalModel.id),
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
                { ...request, model: providerModel, stream: false },
                {
                  onUsage: (usage) =>
                    recordLlmGatewayUsage({
                      durableCall,
                      model: logicalModel.id,
                      provider,
                      usage,
                    }),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: { signal: c.req.raw.signal },
                }
              );
            finishDurableLlmGatewayCall(durableCall, 'succeeded');
            return c.json({ ...completion, model: logicalModel.id });
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
        },
      });
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

      return await dispatchLogicalModel<Response>({
        logicalModel,
        ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
        resolveGatewayProvider,
        signal: c.req.raw.signal,
        attempt: async ({ provider, providerModel, subscriptionModels }) => {
          const durableCall = startPublicLlmGatewayCall({
            ...(coreDb ? { coreDb } : {}),
            authorityActor,
            endpoint: 'responses',
            metadata: (request as { metadata?: unknown }).metadata,
            provider,
          });
          try {
            if (input.stream) {
              const stream = await llmGatewayDispatcher.createResponsesStream(
                provider,
                { ...request, model: providerModel, stream: true },
                {
                  onUsage: (usage) =>
                    recordLlmGatewayUsage({
                      durableCall,
                      model: logicalModel.id,
                      provider,
                      usage,
                    }),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: { signal: c.req.raw.signal },
                }
              );
              return new Response(
                normalizeGatewayTerminalStream(
                  rewriteGatewayStreamModel(stream, logicalModel.id),
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
                { ...request, model: providerModel },
                {
                  onUsage: (usage) =>
                    recordLlmGatewayUsage({
                      durableCall,
                      model: logicalModel.id,
                      provider,
                      usage,
                    }),
                  ...(subscriptionModels ? { models: subscriptionModels } : {}),
                  transport: { signal: c.req.raw.signal },
                }
              );
            finishDurableLlmGatewayCall(durableCall, 'succeeded');
            return c.json({ ...response, model: logicalModel.id });
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
        },
      });
    } catch (error) {
      return asOpenAIGatewayError(error);
    }
  });
}
