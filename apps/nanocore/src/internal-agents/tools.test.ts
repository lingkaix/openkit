import { describe, expect, it } from 'vitest';

import { QUICK_CHAT_AGENT_DEFINITION } from './quick-chat.js';
import {
  createInternalCoreToolRegistry,
  QUICK_CHAT_CORE_TOOL_ALLOWLIST,
  WORKER_COORDINATOR_CORE_TOOL_ALLOWLIST,
} from './tools.js';

describe('internal Core tool allowlists', () => {
  it('defines fixed Core-owned tool allowlists for QuickChatAgent and WorkerCoordinatorAgent', () => {
    const registry = createInternalCoreToolRegistry();

    expect(registry.list().map((tool) => tool.id)).toEqual([
      'readWorkspaceSummary',
      'readThreadSummary',
      'readAgentReadiness',
      'searchWorkspaceItems',
      'searchKnowledge',
      'webSearch',
      'fetchPageText',
      'draftWorkerDelegation',
      'proposeKnowledgeEntry',
      'summarizeArtifacts',
    ]);
    expect(QUICK_CHAT_CORE_TOOL_ALLOWLIST).toEqual([
      'readWorkspaceSummary',
      'readThreadSummary',
      'searchWorkspaceItems',
      'searchKnowledge',
      'webSearch',
      'fetchPageText',
    ]);
    expect(WORKER_COORDINATOR_CORE_TOOL_ALLOWLIST).toEqual([
      'readWorkspaceSummary',
      'readThreadSummary',
      'readAgentReadiness',
      'draftWorkerDelegation',
    ]);
  });

  it('rejects a tool call that is not in the agent allowlist', async () => {
    const registry = createInternalCoreToolRegistry();

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: {},
        threadId: 'th_demo',
        toolId: 'draftWorkerDelegation',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_core_tool_not_allowed',
    });
  });

  it('requires workspace and thread scope for scoped tools', async () => {
    const registry = createInternalCoreToolRegistry();

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: {},
        toolId: 'readThreadSummary',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_core_tool_scope_required',
    });
  });

  it('redacts and bounds tool results before returning them to internal agents', async () => {
    const registry = createInternalCoreToolRegistry({
      handlers: {
        readWorkspaceSummary: () => ({
          authorization: 'Bearer tok_live_123',
          prompt: 'private prompt content',
          nested: {
            accountId: 'acct_secret',
            secret: 'sk-secret',
            token: 'tok_secret',
          },
          longText: 'x'.repeat(500),
        }),
      },
      maxResultBytes: 120,
    });

    const result = await registry.execute({
      agent: QUICK_CHAT_AGENT_DEFINITION,
      input: {},
      toolId: 'readWorkspaceSummary',
      workspaceId: 'ws_demo',
    });
    const serialized = JSON.stringify(result);

    expect(result.truncated).toBe(true);
    expect(serialized.length).toBeLessThan(320);
    expect(serialized).not.toContain('tok_live_123');
    expect(serialized).not.toContain('private prompt content');
    expect(serialized).not.toContain('acct_secret');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('tok_secret');
    expect(serialized).toContain('[redacted]');
  });
});
