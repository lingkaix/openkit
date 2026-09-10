import { describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import {
  createAdministrationEnvironmentPrepareTool,
  createAdministrationEnvironmentTools,
} from './environment-tools.js';

const actor = { kind: 'local', userId: 'user_admin' } as const;
const prepareTool: AgentTool = {
  name: 'worker_environment.prepare',
  description: 'Prepare.',
  inputSchema: { type: 'object' },
  execute: async () => ({ content: [] }),
};

describe('administration Worker environment Tools', () => {
  it('passes an explicit target Workspace to the existing operation owner', async () => {
    const list = vi.fn(() => ({ items: [], nextCursor: null }));
    const status = vi.fn();
    const tools = createAdministrationEnvironmentTools({
      actor,
      operations: { list, status },
      prepareTool,
    });

    await tools[0].execute(
      { workspaceId: 'ws_target', limit: 20 },
      { callId: 'call_list', signal: new AbortController().signal }
    );

    expect(list).toHaveBeenCalledWith({ actor, workspaceId: 'ws_target' }, { limit: 20 });
  });

  it('returns the operation owner denial as a typed Tool result', async () => {
    const denied = Object.assign(
      new Error('private /var/lib/openkit tenant row provider payload'),
      {
        code: 'workspace_access_denied',
      }
    );
    const tools = createAdministrationEnvironmentTools({
      actor,
      operations: {
        list: () => {
          throw denied;
        },
        status: vi.fn(),
      },
      prepareTool,
    });

    const result = await tools[0].execute(
      { workspaceId: 'ws_other' },
      { callId: 'call_denied', signal: new AbortController().signal }
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('workspace_access_denied');
    expect(JSON.stringify(result.content)).not.toContain('/var/lib/openkit');
    expect(JSON.stringify(result.content)).not.toContain('tenant row');
    expect(JSON.stringify(result.content)).not.toContain('provider payload');
  });

  it('binds preparation to the current private Turn and one stable Tool-call request', async () => {
    const prepare = vi.fn(async () => {
      throw Object.assign(new Error('private detail'), { code: 'recovery_required' });
    });
    const tool = createAdministrationEnvironmentPrepareTool({
      actor,
      administrationThreadId: 'thread_admin',
      administrationTurnId: 'turn_admin',
      prepare,
    });
    const args = {
      mode: 'recover',
      recoverFrom: {
        artifactId: 'artifact_a',
        artifactVersion: 1,
        contentDigest: `sha256:${'a'.repeat(64)}`,
      },
    };
    const context = { callId: 'call_prepare', signal: new AbortController().signal };
    const result = await tool.execute(args, context);
    await tool.execute(args, context);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]).toEqual(prepare.mock.calls[1]);
    expect(prepare).toHaveBeenCalledWith(
      { actor, administrationTurnId: 'turn_admin' },
      expect.objectContaining({ ...args, administrationThreadId: 'thread_admin' })
    );
    expect(JSON.stringify(result)).toContain('recovery_required');
    expect(JSON.stringify(result)).not.toContain('private detail');
    await tool.execute({ ...args, administrationThreadId: 'forged' }, context);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
