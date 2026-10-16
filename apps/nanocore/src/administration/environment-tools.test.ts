import { describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import {
  createAdministrationEnvironmentCandidateTools,
  createAdministrationEnvironmentTools,
} from './environment-tools.js';

const actor = { kind: 'local', userId: 'usr_00000000-0000-768a-8658-44c33d82c1f5' } as const;
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
      candidateTools: [prepareTool, { ...prepareTool, name: 'worker_environment.recover' }],
    });

    await tools[0].execute(
      { workspaceId: 'ws_00000000-0000-7b16-81e5-c0b623c0c636', limit: 20 },
      { callId: 'call_list', signal: new AbortController().signal }
    );

    expect(list).toHaveBeenCalledWith(
      { actor, workspaceId: 'ws_00000000-0000-7b16-81e5-c0b623c0c636' },
      { limit: 20 }
    );
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
      candidateTools: [prepareTool, { ...prepareTool, name: 'worker_environment.recover' }],
    });

    const result = await tools[0].execute(
      { workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580' },
      { callId: 'call_denied', signal: new AbortController().signal }
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('workspace_access_denied');
    expect(JSON.stringify(result.content)).not.toContain('/var/lib/openkit');
    expect(JSON.stringify(result.content)).not.toContain('tenant row');
    expect(JSON.stringify(result.content)).not.toContain('provider payload');
  });

  it('binds recovery to the current private Turn and one stable Tool-call request', async () => {
    const prepare = vi.fn(async () => {
      throw Object.assign(new Error('private detail'), { code: 'recovery_required' });
    });
    const [prepareToolView, tool] = createAdministrationEnvironmentCandidateTools({
      actor,
      administrationThreadId: 'thread_admin',
      administrationTurnId: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c',
      prepare,
    });
    expect(prepareToolView.inputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['configuration', 'declaration', 'target']),
    });
    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['recoverFrom'] });
    const args = {
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
      { actor, administrationTurnId: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c' },
      expect.objectContaining({ ...args, mode: 'recover', administrationThreadId: 'thread_admin' })
    );
    expect(JSON.stringify(result)).toContain('recovery_required');
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  describe.each([
    {
      mode: 'prepare',
      args: {
        configuration: {
          fileId: 'agents/codex.agent.jsonc',
          expectedRevision: `sha256:${'a'.repeat(64)}`,
        },
        declaration: {
          kind: 'reference',
          pullPolicy: 'never',
          ref: `sha256:${'a'.repeat(64)}`,
        },
        target: { kind: 'agent', agentId: 'codex' },
      },
    },
    {
      mode: 'recover',
      args: {
        recoverFrom: {
          artifactId: 'artifact_a',
          artifactVersion: 1,
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
    },
  ] as const)('$mode Tool input admission', ({ mode, args }) => {
    it.each([
      'administrationThreadId',
      'requestId',
    ] as const)('rejects forged %s before calling the owner', async (field) => {
      const prepare = vi.fn(async () => {
        throw Object.assign(new Error('private detail'), { code: 'recovery_required' });
      });
      const tools = createAdministrationEnvironmentCandidateTools({
        actor,
        administrationThreadId: 'thread_admin',
        administrationTurnId: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c',
        prepare,
      });
      const tool = tools[mode === 'prepare' ? 0 : 1];
      const context = { callId: 'call_candidate', signal: new AbortController().signal };

      await tool.execute(args, context);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledWith(
        { actor, administrationTurnId: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c' },
        expect.objectContaining({ ...args, mode, administrationThreadId: 'thread_admin' })
      );

      // A valid UUID ensures only model selection of the bound identity causes refusal.
      const forgedValue = field === 'requestId' ? '11111111-1111-4111-8111-111111111111' : 'forged';
      const result = await tool.execute({ ...args, [field]: forgedValue }, context);
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: 'invalid_request',
              message: 'The Worker environment request is invalid.',
            }),
          },
        ],
        isError: true,
      });
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it('rejects obsolete mode before calling the owner', async () => {
      const prepare = vi.fn(async () => {
        throw Object.assign(new Error('private detail'), { code: 'recovery_required' });
      });
      const tools = createAdministrationEnvironmentCandidateTools({
        actor,
        administrationThreadId: 'thread_admin',
        administrationTurnId: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c',
        prepare,
      });
      const tool = tools[mode === 'prepare' ? 0 : 1];
      const result = await tool.execute(
        { ...args, mode },
        { callId: 'call_obsolete_mode', signal: new AbortController().signal }
      );

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: 'invalid_request',
              message: 'The Worker environment request is invalid.',
            }),
          },
        ],
        isError: true,
      });
      expect(prepare).not.toHaveBeenCalled();
    });
  });
});
