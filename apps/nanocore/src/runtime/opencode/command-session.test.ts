import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CreateAgentSessionInput } from '../types.js';
import { OpenCodeCommandAgentSession } from './command-session.js';

/**
 * Creates a minimal package placeholder for command-session tests.
 *
 * @returns Agent Environment Package placeholder.
 */
function testEnvironmentPackage(): CreateAgentSessionInput['environmentPackage'] {
  return {} as CreateAgentSessionInput['environmentPackage'];
}

describe('OpenCodeCommandAgentSession', () => {
  it('passes turn input as a command message and streams stdout deltas', async () => {
    const session = new OpenCodeCommandAgentSession({
      id: 'as_opencode_command_1',
      environmentPackage: testEnvironmentPackage(),
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      workspaceRoots: [],
      agent: {
        id: 'agent_opencode_host',
        name: 'OpenCode Host Agent',
        kind: 'coder',
        status: 'enabled',
        modelId: 'model_opencode',
        skillIds: [],
        config: {
          adapterType: 'opencode',
          command: 'node -e "process.stdout.write(process.argv.slice(1).join(\' \'))"',
          baseUrl: null,
          workspaceRoot: mkdtempSync(join(tmpdir(), 'openkit-opencode-')),
          environment: {},
          capabilities: ['turns', 'streaming'],
        },
        health: {
          status: 'ready',
          message: null,
          checkedAt: '2026-05-05T00:00:00Z',
        },
      },
    });
    const events = await new Promise<string[]>((resolve) => {
      const deltas: string[] = [];
      session.onEvent((event) => {
        if (event.type === 'agent-message-delta') {
          deltas.push(event.delta);
        }

        if (event.type === 'turn-completed') {
          resolve(deltas);
        }
      });
      void session.startTurn('tu_demo', 'hello from opencode');
    });

    expect(events.join('')).toBe('hello from opencode');
  });

  it('uses the turn workspace cwd while preserving materialized workspace roots', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-opencode-default-'));
    const workspaceCwd = mkdtempSync(join(tmpdir(), 'openkit-opencode-repo-'));
    const workspaceRoots = [
      {
        id: 'root_src',
        sourceKind: 'host-dir' as const,
        sourcePath: 'src',
        workerPath: '/workspace/src',
        access: 'read-write' as const,
      },
    ];
    const session = new OpenCodeCommandAgentSession({
      id: 'as_opencode_command_2',
      environmentPackage: testEnvironmentPackage(),
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      workspaceCwd,
      workspaceRoots,
      agent: {
        id: 'agent_opencode_host',
        name: 'OpenCode Host Agent',
        kind: 'coder',
        status: 'enabled',
        modelId: 'model_opencode',
        skillIds: [],
        config: {
          adapterType: 'opencode',
          command:
            'node -e "process.stdout.write(JSON.stringify({cwd:process.cwd(),roots:JSON.parse(process.env.OPENKIT_WORKSPACE_ROOTS || \'[]\')}))"',
          baseUrl: null,
          workspaceRoot,
          environment: {},
          capabilities: ['turns', 'streaming'],
        },
        health: {
          status: 'ready',
          message: null,
          checkedAt: '2026-05-05T00:00:00Z',
        },
      },
    });
    const payload = await new Promise<{ cwd: string; roots: unknown[] }>((resolve) => {
      const deltas: string[] = [];
      session.onEvent((event) => {
        if (event.type === 'agent-message-delta') {
          deltas.push(event.delta);
        }

        if (event.type === 'turn-completed') {
          resolve(JSON.parse(deltas.join('')) as { cwd: string; roots: unknown[] });
        }
      });
      void session.startTurn('tu_demo', 'inspect cwd');
    });

    expect(payload).toEqual({
      cwd: realpathSync(workspaceCwd),
      roots: workspaceRoots,
    });
  });
});
