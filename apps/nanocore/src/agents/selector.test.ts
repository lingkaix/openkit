import { describe, expect, it } from 'vitest';

import type { AgentManifest } from './manifest.js';
import { selectAgent } from './selector.js';

/**
 * Creates a minimal agent manifest for selector tests.
 *
 * @param id Agent id.
 * @returns Agent manifest.
 */
function manifest(id: string): AgentManifest {
  return {
    adapter: id,
    deployments: ['local'],
    displayName: id,
    id,
    kind: 'custom',
    runtime: 'node',
    version: '0.0.2',
  };
}

describe('selectAgent', () => {
  it('selects an explicit request override before workspace defaults', () => {
    expect(
      selectAgent({ defaultAgentId: 'agent_default' }, { agentId: 'agent_override' }, [
        manifest('agent_default'),
        manifest('agent_override'),
      ])
    ).toEqual(expect.objectContaining({ id: 'agent_override' }));
  });

  it('selects the resolved scope default without using manifest order as a fallback', () => {
    expect(
      selectAgent({ defaultAgentId: 'agent_default' }, {}, [
        manifest('agent_first'),
        manifest('agent_default'),
      ])
    ).toEqual(expect.objectContaining({ id: 'agent_default' }));
    expect(selectAgent({}, {}, [manifest('agent_first')])).toEqual({
      error: {
        code: 'agent_not_configured',
        message: 'No Agent is selected by request, User, Workspace, or Server configuration.',
      },
    });
  });

  it('returns an error for missing selected manifests', () => {
    expect(selectAgent({ defaultAgentId: 'agent_missing' }, {}, [manifest('agent_a')])).toEqual({
      error: {
        code: 'agent_not_found',
        message: 'Agent manifest not found: agent_missing.',
      },
    });
  });
});
