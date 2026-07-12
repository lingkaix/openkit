import { describe, expect, it } from 'vitest';

import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
} from '../llm/openai-compatible-client.js';
import type { LLMGatewayDispatchContext } from '../llm/provider-dispatcher.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { QUICK_CHAT_AGENT_DEFINITION } from './quick-chat.js';
import { createDefaultInternalAgentRegistry, QUICK_CHAT_AGENT_ID } from './registry.js';
import {
  type InternalAgentConfigurationError,
  InternalAgentRunner,
  type InternalAgentTimeoutError,
} from './runner.js';
import { WORKER_COORDINATOR_AGENT_ID } from './tools.js';
import type { InternalAgentDefaultProviderUse, InternalAgentLLMClient } from './types.js';

const RESOLVED_PROVIDER = {
  adapterId: 'ollama',
  apiKey: null,
  backend: 'pi-ai',
  baseUrl: 'http://localhost:11434/v1',
  displayName: 'Ollama',
  extraBody: {},
  extraHeaders: {},
  gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
  id: 'ollama',
  requiresApiKey: false,
} satisfies ResolvedLLMProviderConfig;

/**
 * Resolves the test provider used by runner calls.
 *
 * @param _providerId Provider id requested by the runner.
 * @returns Minimal resolved provider fixture.
 */
function resolveProvider(_providerId: string): ResolvedLLMProviderConfig {
  return RESOLVED_PROVIDER;
}

/**
 * Resolves the test provider and model defaults for every internal-agent use.
 *
 * @param _defaultUse Default slot requested by the runner.
 * @returns Test provider and model selection.
 */
function resolveDefaultSelection(_defaultUse: InternalAgentDefaultProviderUse) {
  return { providerId: RESOLVED_PROVIDER.id, model: 'llama3.2' };
}

describe('internal agent runner', () => {
  it('resolves the QuickChatAgent provider and model through injected dependencies', async () => {
    const seen: Array<{
      context: LLMGatewayDispatchContext;
      provider: ResolvedLLMProviderConfig;
      request: OpenAICompatibleChatCompletionRequest;
    }> = [];
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async (provider, request, context = {}) => {
        seen.push({ provider, request, context });

        return {
          id: 'chatcmpl_internal_agent',
          object: 'chat.completion',
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from QuickChatAgent.' },
              finish_reason: 'stop',
            },
          ],
        } satisfies OpenAICompatibleChatCompletionResponse;
      },
    };
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: resolveDefaultSelection,
      llmClient,
      providerResolver: resolveProvider,
      registry: createDefaultInternalAgentRegistry(),
    });

    const result = await runner.run({
      agentId: QUICK_CHAT_AGENT_ID,
      messages: [{ role: 'user', content: 'Say hello.' }],
    });

    expect(result).toMatchObject({
      agentId: QUICK_CHAT_AGENT_ID,
      providerId: 'ollama',
      model: 'llama3.2',
      output: { content: 'Hello from QuickChatAgent.' },
      status: 'completed',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.provider.id).toBe('ollama');
    expect(seen[0]?.request.model).toBe('llama3.2');
    expect(seen[0]?.request.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('QuickChatAgent'),
    });
    expect(seen[0]?.request.messages[1]).toEqual({ role: 'user', content: 'Say hello.' });
  });

  it('fails before provider calls when the default provider or model is missing', async () => {
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async () => {
        throw new Error('fake provider should not be called');
      },
    };
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: () => ({ model: null, providerId: null }),
      llmClient,
      providerResolver: resolveProvider,
      registry: createDefaultInternalAgentRegistry(),
    });

    await expect(
      runner.run({
        agentId: QUICK_CHAT_AGENT_ID,
        messages: [{ role: 'user', content: 'Will this run?' }],
      })
    ).rejects.toMatchObject({
      code: 'internal_agent_provider_not_configured',
      name: 'InternalAgentConfigurationError',
    } satisfies Partial<InternalAgentConfigurationError>);
  });

  it('redacts prompts, tokens, account ids, auth headers, and secrets from diagnostics', async () => {
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async () => {
        throw new Error(
          'upstream failed with Authorization: Bearer tok_live_123 account_id=acct_secret token=tok_secret secret=sk-secret hf_secret ghp_secret'
        );
      },
    };
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: resolveDefaultSelection,
      llmClient,
      providerResolver: resolveProvider,
      registry: createDefaultInternalAgentRegistry(),
    });

    await expect(
      runner.run({
        agentId: QUICK_CHAT_AGENT_ID,
        messages: [{ role: 'user', content: 'raw user prompt with private detail' }],
        metadata: {
          accountId: 'acct_secret',
          authorization: 'Bearer tok_live_123',
          nested: {
            secret: 'sk-secret',
            token: 'tok_secret',
          },
        },
      })
    ).rejects.toThrow('upstream failed');

    const diagnostics = JSON.stringify(runner.getDiagnostics());
    const [failure] = runner.getDiagnostics().recentFailures;

    expect(failure).toMatchObject({
      code: 'internal_agent_failed',
      status: 'error',
      stopReason: 'error',
    });
    expect(diagnostics).not.toContain('raw user prompt with private detail');
    expect(diagnostics).not.toContain('tok_live_123');
    expect(diagnostics).not.toContain('tok_secret');
    expect(diagnostics).not.toContain('acct_secret');
    expect(diagnostics).not.toContain('sk-secret');
    expect(diagnostics).not.toContain('hf_secret');
    expect(diagnostics).not.toContain('ghp_secret');
    expect(diagnostics).toContain('[redacted]');
  });

  it('parses structured JSON output for WorkerCoordinatorAgent decisions', async () => {
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async (_provider, request) => ({
        id: 'chatcmpl_worker_coordinator',
        object: 'chat.completion',
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                decision: 'worker_turn',
                confidence: 0.86,
                explanation: 'The user requested a concrete workspace change.',
                selectedWorkerCandidate: {
                  agentId: 'agent_codex_host',
                  displayName: 'Codex Host',
                  runtime: 'codex',
                  readiness: 'ready',
                },
                requiredUserAction: 'confirm_worker_turn',
                delegationDraft: null,
                workerRequest: null,
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
    };
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: resolveDefaultSelection,
      llmClient,
      providerResolver: resolveProvider,
      registry: createDefaultInternalAgentRegistry(),
    });

    await expect(
      runner.run({
        agentId: WORKER_COORDINATOR_AGENT_ID,
        messages: [{ role: 'user', content: 'Implement the dashboard fix.' }],
      })
    ).resolves.toMatchObject({
      agentId: WORKER_COORDINATOR_AGENT_ID,
      output: {
        decision: 'worker_turn',
        confidence: 0.86,
        selectedWorkerCandidate: {
          agentId: 'agent_codex_host',
          runtime: 'codex',
        },
        requiredUserAction: 'confirm_worker_turn',
      },
    });
  });

  it('rejects malformed structured output for WorkerCoordinatorAgent and redacts diagnostics', async () => {
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async (_provider, request) => ({
        id: 'chatcmpl_worker_invalid',
        object: 'chat.completion',
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                decision: 'worker_turn',
                confidence: 2,
                explanation: 'Invalid secret=hf_secret output.',
                selectedWorkerCandidate: null,
                requiredUserAction: 'confirm_worker_turn',
                delegationDraft: null,
                workerRequest: null,
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
    };
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: resolveDefaultSelection,
      llmClient,
      providerResolver: resolveProvider,
      registry: createDefaultInternalAgentRegistry(),
    });

    await expect(
      runner.run({
        agentId: WORKER_COORDINATOR_AGENT_ID,
        messages: [{ role: 'user', content: 'raw prompt with ghp_secret' }],
      })
    ).rejects.toMatchObject({
      code: 'internal_agent_output_invalid',
      name: 'InternalAgentOutputValidationError',
    });

    const diagnostics = JSON.stringify(runner.getDiagnostics());

    expect(diagnostics).not.toContain('raw prompt with ghp_secret');
    expect(diagnostics).not.toContain('hf_secret');
    expect(diagnostics).not.toContain('ghp_secret');
  });

  it('times out bounded internal agent provider calls and records redacted diagnostics', async () => {
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async () =>
        new Promise<OpenAICompatibleChatCompletionResponse>(() => {
          // Keep the fake provider pending so the runner timeout owns completion.
        }),
    };
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: resolveDefaultSelection,
      llmClient,
      providerResolver: resolveProvider,
      registry: createDefaultInternalAgentRegistry([
        {
          ...QUICK_CHAT_AGENT_DEFINITION,
          limits: {
            ...QUICK_CHAT_AGENT_DEFINITION.limits,
            timeoutMs: 1,
          },
        },
      ]),
    });

    await expect(
      runner.run({
        agentId: QUICK_CHAT_AGENT_ID,
        messages: [{ role: 'user', content: 'raw timeout prompt token=ghp_secret' }],
      })
    ).rejects.toMatchObject({
      code: 'internal_agent_timeout',
      name: 'InternalAgentTimeoutError',
    } satisfies Partial<InternalAgentTimeoutError>);

    const diagnostics = JSON.stringify(runner.getDiagnostics());

    expect(diagnostics).toContain('internal_agent_timeout');
    expect(diagnostics).not.toContain('raw timeout prompt');
    expect(diagnostics).not.toContain('ghp_secret');
  });

  it('dispatches loop events to observational hooks without failing the run', async () => {
    const seenEvents: string[] = [];
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async (_provider, request) => ({
        id: 'chatcmpl_internal_agent_hooked',
        object: 'chat.completion',
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello from hooks.' },
            finish_reason: 'stop',
          },
        ],
      }),
    };
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: resolveDefaultSelection,
      hooks: [
        {
          id: 'record-events',
          handleEvent: (event) => {
            seenEvents.push(event.eventType);
          },
        },
        {
          id: 'failing-observer',
          handleEvent: (event) => {
            if (event.eventType === 'message_update') {
              throw new Error('hook failed token=tok_secret');
            }
          },
        },
      ],
      llmClient,
      providerResolver: resolveProvider,
      registry: createDefaultInternalAgentRegistry(),
    });

    await expect(
      runner.run({
        agentId: QUICK_CHAT_AGENT_ID,
        messages: [{ role: 'user', content: 'Say hello.' }],
      })
    ).resolves.toMatchObject({
      output: { content: 'Hello from hooks.' },
      status: 'completed',
    });
    expect(seenEvents).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(runner.getDiagnostics().recentHookFailures).toEqual([
      expect.objectContaining({
        hookId: 'failing-observer',
        eventType: 'message_update',
        mode: 'observational',
        message: 'hook failed token=[redacted]',
      }),
    ]);
  });
});
