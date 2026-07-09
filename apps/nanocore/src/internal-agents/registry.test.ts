import { describe, expect, it } from 'vitest';

import {
  createDefaultInternalAgentRegistry,
  DEFAULT_INTERNAL_AGENT_DEFINITIONS,
  QUICK_CHAT_AGENT_ID,
} from './registry.js';

describe('internal agent registry', () => {
  it('registers QuickChatAgent metadata first', () => {
    const registry = createDefaultInternalAgentRegistry();
    const definitions = registry.list();

    expect(DEFAULT_INTERNAL_AGENT_DEFINITIONS[0]?.id).toBe(QUICK_CHAT_AGENT_ID);
    expect(definitions[0]).toMatchObject({
      id: QUICK_CHAT_AGENT_ID,
      displayName: 'QuickChatAgent',
      category: 'conversation',
      supportedModes: ['chat'],
      defaultProviderUse: 'quickChat',
      allowedTools: [
        'readWorkspaceSummary',
        'readThreadSummary',
        'searchWorkspaceItems',
        'searchKnowledge',
        'webSearch',
        'fetchPageText',
      ],
    });
  });

  it('rejects duplicate internal agent identifiers', () => {
    const [quickChatDefinition] = DEFAULT_INTERNAL_AGENT_DEFINITIONS;

    expect(() =>
      createDefaultInternalAgentRegistry([quickChatDefinition, quickChatDefinition])
    ).toThrow('Duplicate internal agent id: quick-chat');
  });
});
