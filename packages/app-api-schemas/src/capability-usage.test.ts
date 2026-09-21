import { describe, expect, it } from 'vitest';

import { CapabilityUsageCallSchema } from './capability-usage.js';

const SYSTEM_PROMPT_DIGEST = `sha256:${'a'.repeat(64)}`;

/**
 * Builds one succeeded usage-read capability call without a system-prompt digest.
 *
 * @returns App API capability usage call fields.
 */
function usageCall() {
  return {
    agentId: 'assistant',
    agentSessionId: 'session_demo',
    capabilityId: 'llm.chat_completions',
    completedAt: '2026-09-21T00:00:01.000Z',
    errorCode: null,
    family: 'llm' as const,
    id: 'cap_digest_demo',
    operation: 'chat_completions',
    providerRef: 'openrouter',
    redactionClass: 'metadata-only',
    requestId: '00000000-0000-4000-8000-000000000001',
    serviceRef: 'llm-gateway',
    startedAt: '2026-09-21T00:00:00.000Z',
    status: 'succeeded' as const,
    summary: 'Gateway call completed.',
    threadId: 'th_demo',
    turnId: 'turn_demo',
    workspaceId: 'ws_demo',
  };
}

describe('CapabilityUsageCallSchema system-prompt digest', () => {
  it('accepts a digest on a gateway-entry family llm call and rejects every other family', () => {
    expect(
      CapabilityUsageCallSchema.parse({
        ...usageCall(),
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).systemPromptDigest
    ).toBe(SYSTEM_PROMPT_DIGEST);
    expect(
      CapabilityUsageCallSchema.safeParse({
        ...usageCall(),
        capabilityId: 'mcp.call_tool',
        family: 'mcp',
        operation: 'call_tool',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityUsageCallSchema.safeParse({
        ...usageCall(),
        capabilityId: 'knowledge.answer',
        family: 'knowledge',
        operation: 'answer',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityUsageCallSchema.safeParse({
        ...usageCall(),
        capabilityId: 'inference.local.administration',
        operation: 'administration',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityUsageCallSchema.safeParse({
        ...usageCall(),
        capabilityId: 'inference.local.goal_orchestrator',
        operation: 'goal.plan',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityUsageCallSchema.safeParse({
        ...usageCall(),
        capabilityId: 'inference.local.quick_chat',
        operation: 'quick_chat',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
  });
});
