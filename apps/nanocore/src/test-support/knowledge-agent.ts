import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { operationToolName } from '@openkit/app-api-schemas';
import { vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { initializeScopedNotebook } from '../knowledge/scoped-notebook-owner.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { serverKnowledgeRoot } from '../storage/fs-layout.js';
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
  const coreDb = options?.coreDb;
  if (!coreDb) throw new Error('Knowledge answer fixture requires current Core authority.');
  // Admitted empty Server Knowledge is available evidence, distinct from missing storage.
  if (!existsSync(serverKnowledgeRoot(coreDb.dataRoot))) {
    initializeScopedNotebook({
      coreDb,
      actor: { kind: 'local', userId: ensureLocalUser(coreDb) },
      target: { kind: 'server' },
      initialization: {
        requestId: randomUUID(),
        instructionReference: 'Initialize empty shared Knowledge for the query fixture.',
      },
    });
  }
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
      output = [
        {
          type: 'function_call',
          call_id: `result-${planIndex}`,
          name: operationToolName('knowledge.result'),
          arguments: text,
        },
      ];
      planIndex += 1;
      step = 0;
    }
    return { id: `response-${planIndex}-${step}`, object: 'response', output };
  });
  const gatewayConfig = createTestGatewayConfig();
  // This answer fixture leaves summary generation to its separate owner tests.
  gatewayConfig.logicalModels[0]!.contextManagement = [
    { type: 'compaction', compactThreshold: 32_000 },
  ];
  const app = createApp({
    ...options,
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Fake transport',
        kind: 'custom',
        baseUrl: 'https://provider.invalid/v1',
        models: ['openai/gpt-5.2'],
        modelMetadata: {
          'openai/gpt-5.2': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
        },
      },
    ]),
    gatewayConfig,
    llmGatewayDispatcher: { createResponses } as unknown as LLMGatewayProviderDispatcher,
  });
  return { app, createResponses };
}
