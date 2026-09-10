import { Buffer } from 'node:buffer';

import { dispatchLogicalModel } from '../llm/gateway-routes.js';
import type { ResolvedLogicalModel } from '../llm/logical-models.js';
import type { OpenAICompatibleResponsesResponse } from '../llm/openai-compatible-client.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type {
  AgentAssistantMessage,
  AgentMessage,
  InternalAgentProviderCall,
} from './internal-agent-loop.js';
import { InternalAgentProviderError } from './internal-agent-loop.js';

/** Dependencies that bind the shared internal Agent loop to the existing logical Gateway. */
export interface InternalAgentGatewayProviderOptions {
  readonly logicalModel: ResolvedLogicalModel;
  readonly dispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly metadata: Readonly<Record<string, unknown>>;
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
 * Current Gateway adapters do not yet produce an OpenKit Compaction Item. This projection runs only while the complete serialized request is conservatively below the selected threshold and otherwise returns the stable unsupported-compaction failure.
 *
 * @param options Existing logical-model routing, provider, cache, and usage context.
 * @returns Effect injected into the role-agnostic loop.
 */
export function createInternalAgentGatewayProvider(
  options: InternalAgentGatewayProviderOptions
): InternalAgentProviderCall {
  return async (request) => {
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
      strict: true,
    }));
    assertBelowUnsupportedCompactionThreshold(
      { instructions: request.systemPrompt, input: providerInput, tools: providerTools },
      request.contextManagement.compactThreshold
    );

    const selected = await dispatchLogicalModel({
      logicalModel: options.logicalModel,
      signal: request.signal,
      resolveGatewayProvider: options.resolveGatewayProvider,
      ...(options.providerSubscriptionAccountManager
        ? { providerSubscriptionAccountManager: options.providerSubscriptionAccountManager }
        : {}),
      attempt: async ({ provider, providerModel, subscriptionModels }) => ({
        providerId: provider.id,
        response: await options.dispatcher.createResponses(
          provider,
          {
            model: providerModel,
            instructions: request.systemPrompt,
            input: providerInput,
            metadata: options.metadata,
            parallel_tool_calls: false,
            tools: providerTools,
          },
          {
            ...(subscriptionModels ? { models: subscriptionModels } : {}),
            promptCacheScope: options.promptCacheScope,
            usageEndpoint: options.usageEndpoint,
            transport: { signal: request.signal },
          }
        ),
      }),
    });
    const message = fromResponses(selected.response);
    options.onDispatch?.({
      providerId: selected.providerId,
      ...(selected.response.usage === undefined ? {} : { usage: selected.response.usage }),
    });
    return { message };
  };
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
