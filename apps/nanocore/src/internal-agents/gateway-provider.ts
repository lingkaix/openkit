import { Buffer } from 'node:buffer';

import {
  finishCapabilityCall,
  type GatewayCallContext,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { LogicalModelRoutesExhaustedError } from '../llm/gateway-execution.js';
import { dispatchLogicalModel, projectGatewayFailure } from '../llm/gateway-routes.js';
import { recordInternalLlmGatewayUsage } from '../llm/gateway-usage.js';
import type { ResolvedLogicalModel } from '../llm/logical-models.js';
import { type ModelCaptureContext, ModelCaptureError } from '../llm/model-capture.js';
import type { OpenAICompatibleResponsesResponse } from '../llm/openai-compatible-client.js';
import { GatewayUnsupportedFeatureError } from '../llm/pi-ai-client.js';
import type { PiAiFailure, PiAiFailureKind } from '../llm/pi-ai-failure.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type {
  AgentAssistantMessage,
  AgentMessage,
  InternalAgentProviderCall,
} from './internal-agent-loop.js';
import { InternalAgentProviderError } from './internal-agent-loop.js';

/** Allowlisted diagnostic phases; stock handoff alone does not establish transport delivery. */
type InternalGatewayFailurePhase =
  | 'pre-transport'
  | 'transport'
  | 'provider-response'
  | 'output-projection';

/** Dependencies that bind the shared internal Agent loop to the existing logical Gateway. */
export interface InternalAgentGatewayProviderOptions {
  /** Exact entry-admitted Turn; internal Agents never use public metadata as authority. */
  readonly capture: Omit<ModelCaptureContext, 'corr'>;
  /** Entry-admitted model retained for pinned identity and context policy checks. */
  readonly logicalModel: ResolvedLogicalModel;
  /** Resolves the pinned ID from the current snapshot and live availability at each Provider call. */
  readonly resolveLogicalModel: (logicalModelId: string) => ResolvedLogicalModel | null;
  /** Entry-owned attribution for each logical model invocation; Turn and database come from admitted capture. */
  readonly callContext?: GatewayCallContext;
  readonly dispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly promptCacheScope: {
    readonly sessionId: string;
    readonly workspaceId: string;
  };
  readonly usageEndpoint: 'quick_chat' | 'responses';
  readonly onDispatch?: (result: { readonly providerId: string; readonly usage?: unknown }) => void;
}

/**
 * Creates the private Gateway projection used by one pinned internal Agent run.
 *
 * Current Gateway adapters do not yet produce an OpenKit Compaction Item. This projection runs only while the complete serialized request is conservatively below the selected threshold and otherwise returns the stable unsupported-compaction failure. Internal cache and usage lineage stay on `promptCacheScope` and `usageEndpoint`; they are not authored onto the provider payload.
 *
 * @param options Existing logical-model routing, provider, cache, and usage context.
 * @returns Effect injected into the role-agnostic loop.
 */
export function createInternalAgentGatewayProvider(
  options: InternalAgentGatewayProviderOptions
): InternalAgentProviderCall {
  return async (request) => {
    if (!options.capture) throw new ModelCaptureError();
    if (request.model.logicalModelId !== options.logicalModel.id) {
      throw new Error('Internal Agent logical model changed after admission.');
    }
    if (
      !options.logicalModel.contextManagement ||
      options.logicalModel.contextManagement.type !== request.contextManagement.type ||
      options.logicalModel.contextManagement.compactThreshold !==
        request.contextManagement.compactThreshold
    ) {
      throw new InternalAgentProviderError(
        'context_compaction_unavailable',
        'The selected logical model has no matching admitted context policy.'
      );
    }

    const providerInput = request.messages.flatMap(toResponsesInput);
    const providerTools = request.tools.map(({ name, description, inputSchema }) => ({
      type: 'function',
      name,
      description,
      parameters: inputSchema,
      // The loop validates the original schema before execution; stock strict generation rewrites optional fields and rejects valid Tool schemas such as task_start's tuple prefixItems.
      strict: false,
    }));
    assertBelowUnsupportedCompactionThreshold(
      { instructions: request.systemPrompt, input: providerInput, tools: providerTools },
      request.contextManagement.compactThreshold
    );

    const workspaceDb = options.capture.workspaceDb;
    const call = options.callContext
      ? startCapabilityCall({
          ...options.callContext,
          workspaceDb,
          providerRef: null,
          threadId: options.capture.threadId,
          turnId: options.capture.turnId,
        })
      : undefined;
    let callFinished = false;
    let failurePhase: InternalGatewayFailurePhase = 'pre-transport';
    let observedStatus: number | undefined;
    let dispatchCorrelation: { corr: string; attempt: number } | undefined;
    try {
      const logicalModel = options.resolveLogicalModel(options.logicalModel.id);
      if (!logicalModel) throw new LogicalModelRoutesExhaustedError();
      const selected = await dispatchLogicalModel({
        ...(call ? { ledger: { workspaceDb, call } } : {}),
        logicalModel,
        requiredCapabilities: request.model.capabilities,
        ...(options.logicalModel.contract ? { pinnedLimits: options.logicalModel.contract } : {}),
        signal: request.signal,
        onAttemptStart: (correlation) => {
          // Resolution can fail before the producer runs; evidence belongs to this member only.
          failurePhase = 'pre-transport';
          observedStatus = undefined;
          dispatchCorrelation = correlation;
        },
        resolveGatewayProvider: options.resolveGatewayProvider,
        ...(options.providerSubscriptionAccountManager
          ? { providerSubscriptionAccountManager: options.providerSubscriptionAccountManager }
          : {}),
        attempt: async ({
          provider,
          providerModel,
          subscriptionModels,
          corr,
          attempt,
          execution,
        }) => {
          const response = await options.dispatcher
            .createResponses(
              provider,
              {
                model: providerModel,
                instructions: request.systemPrompt,
                input: providerInput,
                parallel_tool_calls: false,
                tools: providerTools,
              },
              {
                ...(subscriptionModels ? { models: subscriptionModels } : {}),
                capture: {
                  ...options.capture,
                  ...(call ? { capabilityCallId: call.id } : {}),
                  corr,
                  attempt,
                },
                promptCacheScope: options.promptCacheScope,
                usageEndpoint: options.usageEndpoint,
                onUsage: (usage) => {
                  if (call && !callFinished)
                    execution.addUsageRecordIds(
                      recordInternalLlmGatewayUsage({
                        workspaceDb,
                        call,
                        logicalModelId: options.logicalModel.id,
                        providerId: provider.id,
                        usage,
                        succeeded: false,
                      })
                    );
                },
                transport: {
                  signal: execution.signal,
                  deadline: execution.deadline,
                  onModelEvent: (event) => {
                    // Stock completion precedes adapter output conversion, which can still reject Tool output.
                    if (event.type === 'done') failurePhase = 'output-projection';
                  },
                  onProviderHandoff: () => {
                    failurePhase = 'transport';
                    execution.onProviderHandoff?.();
                  },
                },
              }
            )
            .catch((error: unknown) => {
              const failure = (error as { failure?: PiAiFailure } | null)?.failure;
              const status = failure?.status;
              observedStatus =
                typeof status === 'number' &&
                Number.isInteger(status) &&
                status >= 100 &&
                status <= 599
                  ? status
                  : undefined;
              // pi-ai 0.99.2 flattens this local serializer rejection into terminal text after stock handoff.
              // Recognize only its fixed signature for diagnostics; never use it for routing or emit the Tool name, schema or exception text.
              if (
                error instanceof Error &&
                /^Tool "[^"]+" requires JSON-schema constrained sampling, but prefixItems schemas are unsupported\.$/.test(
                  error.message
                )
              ) {
                failurePhase = 'pre-transport';
                observedStatus = undefined;
              } else if (observedStatus !== undefined) {
                failurePhase = 'provider-response';
              }
              throw error;
            });
          failurePhase = 'output-projection';
          const message = fromResponses(response);
          if (call)
            execution.addUsageRecordIds(
              recordInternalLlmGatewayUsage({
                workspaceDb,
                call,
                logicalModelId: options.logicalModel.id,
                providerId: provider.id,
                usage: response.usage,
                succeeded: true,
              })
            );
          execution.commit();
          return { providerId: provider.id, response, message };
        },
      });
      callFinished = true;
      if (call) finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
      const message = selected.message;
      options.onDispatch?.({
        providerId: selected.providerId,
        ...(selected.response.usage === undefined ? {} : { usage: selected.response.usage }),
      });
      return { message };
    } catch (error) {
      callFinished = true;
      if (call)
        finishCapabilityCall({
          workspaceDb,
          callId: call.id,
          status: 'failed',
          errorCode: projectGatewayFailure(error, 'internal_inference_failed').code,
        });
      try {
        console.warn(
          JSON.stringify({
            code: 'internal_gateway_call_failed',
            message: 'Internal Gateway logical call failed.',
            phase: failurePhase,
            failureKind: internalGatewayFailureKind(error),
            ...(observedStatus === undefined ? {} : { httpStatus: observedStatus }),
            ...(call?.context.requestId ? { requestId: call.context.requestId } : {}),
            workspaceId: workspaceDb.workspaceId,
            threadId: options.capture.threadId,
            turnId: options.capture.turnId,
            ...(call ? { capabilityCallId: call.id } : {}),
            ...dispatchCorrelation,
          })
        );
      } catch {
        // Optional diagnostics must preserve the original product failure and closeout.
      }
      throw error;
    }
  };
}

/** Projects only the existing closed Gateway kind; private codes and exception text stay private. */
function internalGatewayFailureKind(error: unknown): PiAiFailureKind {
  const kind =
    error instanceof LogicalModelRoutesExhaustedError
      ? error.cause
      : (error as { failure?: PiAiFailure } | null)?.failure?.kind;
  switch (kind) {
    case 'auth_rejected':
    case 'quota_exhausted':
    case 'rate_limited':
    case 'provider_unavailable':
    case 'context_overflow':
    case 'unsupported':
    case 'output_limit':
    case 'refused':
    case 'invalid_request':
    case 'cancelled':
      return kind;
    default:
      return error instanceof GatewayUnsupportedFeatureError ? 'unsupported' : 'unknown';
  }
}

function toResponsesInput(message: AgentMessage): readonly Record<string, unknown>[] {
  if (message.role === 'user') {
    return [
      {
        role: 'user',
        content: message.content.map((part) =>
          part.type === 'image'
            ? { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` }
            : { type: 'input_text', text: part.text }
        ),
      },
    ];
  }
  if (message.role === 'tool') {
    if (message.content.some((part) => part.type === 'image')) {
      throw new InternalAgentProviderError(
        'tool_image_content_unavailable',
        'The current Responses adapter cannot preserve Tool image content.'
      );
    }
    return [
      {
        type: 'function_call_output',
        call_id: message.callId,
        output: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      },
    ];
  }
  return message.content.map((part) =>
    part.type === 'text'
      ? { role: 'assistant', content: [{ type: 'output_text', text: part.text }] }
      : {
          type: 'function_call',
          call_id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.arguments),
        }
  );
}

function fromResponses(response: OpenAICompatibleResponsesResponse): AgentAssistantMessage {
  if (!Array.isArray(response.output)) {
    throw new Error('Gateway returned an invalid internal Agent response.');
  }
  const content: AgentAssistantMessage['content'][number][] = [];
  let truncated = response.status === 'incomplete';
  for (const output of response.output) {
    if (output.type === 'message') {
      if (!Array.isArray(output.content)) {
        throw new Error('Gateway returned invalid message content.');
      }
      for (const rawPart of output.content) {
        const part = record(rawPart);
        if (part?.type !== 'output_text' || typeof part.text !== 'string') {
          throw new Error('Gateway returned unsupported message content.');
        }
        content.push({ type: 'text', text: part.text });
      }
      truncated ||= output.status === 'incomplete';
      continue;
    }
    if (output.type === 'function_call') {
      if (
        typeof output.call_id !== 'string' ||
        !output.call_id ||
        typeof output.name !== 'string' ||
        !output.name ||
        typeof output.arguments !== 'string'
      ) {
        throw new Error('Gateway returned invalid Tool calls.');
      }
      let args: unknown;
      try {
        args = JSON.parse(output.arguments);
      } catch {
        throw new Error('Gateway returned invalid Tool arguments.');
      }
      content.push({
        type: 'toolCall',
        callId: output.call_id,
        name: output.name,
        arguments: args,
      });
      continue;
    }
    if (output.type === 'compaction') {
      throw new InternalAgentProviderError(
        'context_compaction_unavailable',
        'The Gateway returned compaction output without an admitted OpenKit checkpoint adapter.'
      );
    }
  }
  if (content.length === 0) throw new Error('Gateway returned empty internal Agent content.');
  return { role: 'assistant', content, truncated };
}

function assertBelowUnsupportedCompactionThreshold(value: unknown, compactThreshold: number): void {
  const conservativeTokenUpperBound = Buffer.byteLength(JSON.stringify(value), 'utf8') + 4_096;
  if (conservativeTokenUpperBound >= compactThreshold) {
    throw new InternalAgentProviderError(
      'context_compaction_unavailable',
      'The active context reached a threshold that requires unsupported compaction.'
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
