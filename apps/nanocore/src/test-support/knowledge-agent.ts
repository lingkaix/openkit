import { operationToolName } from '@openkit/app-api-schemas';
import { vi } from 'vitest';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createTestGatewayConfig } from './agent-environment.js';
import { createApp } from './app.js';

/** Only the external transport is fake; native query Tools and Gateway own each answer. */
export function createKnowledgeAnswerApp(
  options: Parameters<typeof createApp>[0],
  plans: Array<{
    query: string;
    pageId?: string;
    answer: string;
    uncertainty: string | null;
  }>,
  failMessage?: string
) {
  let planIndex = 0;
  let step = 0;
  const createResponses = vi.fn(async () => {
    if (failMessage) throw new Error(failMessage);
    const plan = plans[planIndex]!;
    const text = JSON.stringify({
      answer: plan.answer,
      citationIds: plan.pageId ? [plan.pageId] : [],
      uncertainty: plan.uncertainty,
    });
    let output: unknown[];
    if (step === 0 || (plan.pageId && step === 1)) {
      const search = step++ === 0;
      output = [
        {
          type: 'function_call',
          call_id: `call-${planIndex}-${step}`,
          name: operationToolName(search ? 'knowledge.retrieval' : 'knowledge.page.read'),
          arguments: JSON.stringify(search ? { query: plan.query } : { pageId: plan.pageId }),
        },
      ];
    } else {
      output = [{ type: 'message', content: [{ type: 'output_text', text }] }];
      planIndex += 1;
      step = 0;
    }
    return { id: `response-${planIndex}-${step}`, object: 'response', output };
  });
  const app = createApp({
    ...options,
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        adapter: 'openai-compatible',
        displayName: 'Fake transport',
        kind: 'custom',
        enabled: true,
        baseUrl: 'https://provider.invalid/v1',
        models: ['openai/gpt-5.2'],
        credential: { kind: 'none' },
        capabilities: { llm: { responses: 'supported', chatCompletions: 'supported' } },
        modelMetadata: {
          'openai/gpt-5.2': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
        },
      },
    ]),
    gatewayConfig: createTestGatewayConfig(),
    llmGatewayDispatcher: { createResponses } as unknown as LLMGatewayProviderDispatcher,
  });
  return { app, createResponses };
}
