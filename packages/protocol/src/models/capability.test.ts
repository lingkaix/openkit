import { describe, expect, it } from 'vitest';

import { CapabilityCallSchema } from './capability.js';

const SYSTEM_PROMPT_DIGEST = `sha256:${'a'.repeat(64)}`;

/**
 * Builds one running capability call used by digest-slot regressions.
 *
 * @returns Protocol capability call fields without family or digest.
 */
function runningCapabilityCall() {
  return {
    agentSessionId: null,
    capabilityId: 'llm.chat_completions',
    completedAt: null,
    errorCode: null,
    id: 'cap_digest_demo',
    startedAt: '2026-09-21T00:00:00.000Z',
    status: 'running' as const,
    summary: 'Public chat_completions LLM gateway call.',
    threadId: null,
    turnId: null,
    workspaceId: 'ws_demo',
  };
}

describe('CapabilityCall system-prompt digest slot', () => {
  it('accepts an absent digest and keeps the digest when present', () => {
    expect(CapabilityCallSchema.parse(runningCapabilityCall()).systemPromptDigest).toBeUndefined();

    expect(
      CapabilityCallSchema.parse({
        ...runningCapabilityCall(),
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).systemPromptDigest
    ).toBe(SYSTEM_PROMPT_DIGEST);
  });

  it('rejects a digest that is not a lowercase sha256 hex', () => {
    expect(
      CapabilityCallSchema.safeParse({
        ...runningCapabilityCall(),
        systemPromptDigest: 'sha256:not-a-digest',
      }).success
    ).toBe(false);
  });

  it('rejects a system-prompt digest on non-llm families and when family is omitted', () => {
    expect(
      CapabilityCallSchema.safeParse({
        ...runningCapabilityCall(),
        capabilityId: 'mcp.call_tool',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityCallSchema.safeParse({
        ...runningCapabilityCall(),
        capabilityId: 'knowledge.answer',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityCallSchema.safeParse({
        ...runningCapabilityCall(),
        capabilityId: 'inference.local.administration',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityCallSchema.safeParse({
        ...runningCapabilityCall(),
        capabilityId: 'inference.local.goal_orchestrator',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityCallSchema.safeParse({
        ...runningCapabilityCall(),
        capabilityId: 'inference.local.quick_chat',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
    expect(
      CapabilityCallSchema.safeParse({
        ...runningCapabilityCall(),
        capabilityId: 'storage.workspace_export',
        systemPromptDigest: SYSTEM_PROMPT_DIGEST,
      }).success
    ).toBe(false);
  });
});
