import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentSessionEvent, CreateAgentSessionInput } from '../types.js';
import {
  OpenCodeServerAgentSession,
  type OpenCodeServerClient,
  type OpenCodeServerClientInput,
  type OpenCodeServerProcess,
  type OpenCodeServerSpawnInput,
} from './server-session.js';

class FakeOpenCodeProcess extends EventEmitter implements OpenCodeServerProcess {
  public readonly killedSignals: Array<NodeJS.Signals | undefined> = [];

  /**
   * Records server shutdown attempts.
   */
  public kill(signal?: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }
}

class FakeOpenCodeClient implements OpenCodeServerClient {
  public readonly createdSessions: Array<{ directory: string; title: string }> = [];
  public readonly prompts: Array<{ directory: string; input: string; sessionId: string }> = [];
  public readonly aborts: string[] = [];

  /**
   * Creates one deterministic OpenCode session.
   */
  public async createSession(input: { directory: string; title: string }): Promise<{ id: string }> {
    this.createdSessions.push(input);
    return { id: 'oc_session_1' };
  }

  /**
   * Returns one deterministic assistant message for the submitted prompt.
   */
  public async prompt(input: {
    directory: string;
    input: string;
    sessionId: string;
  }): Promise<{ itemId: string; text: string }> {
    this.prompts.push(input);
    return { itemId: 'oc_message_1', text: 'server answer' };
  }

  /**
   * Records abort requests for active sessions.
   */
  public async abort(sessionId: string): Promise<void> {
    this.aborts.push(sessionId);
  }
}

/**
 * Creates a minimal package placeholder for OpenCode server-session tests.
 *
 * @returns Agent Environment Package placeholder.
 */
function testEnvironmentPackage(): CreateAgentSessionInput['environmentPackage'] {
  return {} as CreateAgentSessionInput['environmentPackage'];
}

/**
 * Builds the agent input shared by the OpenCode server-session tests.
 */
function createSessionInput(workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-opencode-'))): {
  input: CreateAgentSessionInput;
  workspaceRoot: string;
} {
  return {
    input: {
      id: 'as_opencode_server',
      environmentPackage: testEnvironmentPackage(),
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      workspaceRoots: [],
      agent: {
        id: 'agent_opencode_server',
        name: 'OpenCode Server Agent',
        kind: 'coder',
        status: 'enabled',
        modelId: 'model_opencode',
        skillIds: [],
        config: {
          adapterType: 'opencode',
          command: 'opencode serve',
          baseUrl: null,
          workspaceRoot,
          environment: {
            OPENROUTER_API_KEY: 'redacted',
          },
          capabilities: ['turns', 'streaming', 'interrupts'],
        },
        health: {
          status: 'ready',
          message: null,
          checkedAt: '2026-05-18T00:00:00.000Z',
        },
      },
    },
    workspaceRoot,
  };
}

describe('OpenCodeServerAgentSession', () => {
  it('spawns a protected loopback server, waits for readiness, and maps output events', async () => {
    const { input, workspaceRoot } = createSessionInput();
    const fakeProcess = new FakeOpenCodeProcess();
    const fakeClient = new FakeOpenCodeClient();
    const spawnInputs: OpenCodeServerSpawnInput[] = [];
    const clientInputs: OpenCodeServerClientInput[] = [];
    const readinessRequests: Array<{ authorization: string | null; url: string }> = [];
    const events: AgentSessionEvent[] = [];
    const session = new OpenCodeServerAgentSession(input, {
      allocatePort: () => 45731,
      createClient: (clientInput) => {
        clientInputs.push(clientInput);
        return fakeClient;
      },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        readinessRequests.push({
          authorization: headers.get('authorization'),
          url: String(url),
        });
        return new Response('ok', { status: 200 });
      },
      generateCredentials: () => ({ password: 'secret-password', username: 'openkit' }),
      now: () => '2026-05-18T00:00:00.000Z',
      spawnServer: (spawnInput) => {
        spawnInputs.push(spawnInput);
        return fakeProcess;
      },
    });

    session.onEvent((event) => {
      events.push(event);
    });
    await session.startTurn('tu_demo', 'hello from opencode');

    expect(spawnInputs).toHaveLength(1);
    expect(spawnInputs[0]).toMatchObject({
      command: 'opencode serve',
      cwd: workspaceRoot,
      hostname: '127.0.0.1',
      port: 45731,
    });
    expect(spawnInputs[0]?.environment).toMatchObject({
      OPENCODE_SERVER_PASSWORD: 'secret-password',
      OPENCODE_SERVER_USERNAME: 'openkit',
      OPENKIT_THREAD_ID: 'th_demo',
      OPENKIT_WORKSPACE_ID: 'ws_demo',
      OPENROUTER_API_KEY: 'redacted',
    });
    expect(readinessRequests[0]).toEqual({
      authorization: `Basic ${Buffer.from('openkit:secret-password').toString('base64')}`,
      url: 'http://127.0.0.1:45731/global/health',
    });
    expect(clientInputs).toEqual([
      {
        baseUrl: 'http://127.0.0.1:45731',
        credentials: { password: 'secret-password', username: 'openkit' },
        directory: workspaceRoot,
      },
    ]);
    expect(fakeClient.createdSessions).toEqual([
      { directory: workspaceRoot, title: 'OpenKit th_demo' },
    ]);
    expect(fakeClient.prompts).toEqual([
      { directory: workspaceRoot, input: 'hello from opencode', sessionId: 'oc_session_1' },
    ]);
    expect(events).toEqual([
      { type: 'turn-started', turnId: 'tu_demo', startedAt: '2026-05-18T00:00:00.000Z' },
      {
        type: 'agent-message-delta',
        turnId: 'tu_demo',
        itemId: 'oc_message_1',
        delta: 'server answer',
      },
      {
        type: 'turn-completed',
        turnId: 'tu_demo',
        status: 'completed',
        stopReason: 'completed',
        completedAt: '2026-05-18T00:00:00.000Z',
      },
    ]);
  });

  it('uses the turn workspace cwd while preserving materialized workspace roots', async () => {
    const { input, workspaceRoot } = createSessionInput();
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
    const fakeClient = new FakeOpenCodeClient();
    const spawnInputs: OpenCodeServerSpawnInput[] = [];
    const clientInputs: OpenCodeServerClientInput[] = [];
    const session = new OpenCodeServerAgentSession(
      {
        ...input,
        workspaceCwd,
        workspaceRoots,
      },
      {
        allocatePort: () => 45735,
        createClient: (clientInput) => {
          clientInputs.push(clientInput);
          return fakeClient;
        },
        fetch: async () => new Response('ok', { status: 200 }),
        generateCredentials: () => ({ password: 'secret-password', username: 'openkit' }),
        now: () => '2026-05-18T00:00:00.000Z',
        spawnServer: (spawnInput) => {
          spawnInputs.push(spawnInput);
          return new FakeOpenCodeProcess();
        },
      }
    );

    await session.startTurn('tu_demo', 'hello from opencode');

    expect(spawnInputs[0]).toMatchObject({
      cwd: workspaceCwd,
      environment: {
        OPENKIT_THREAD_ID: 'th_demo',
        OPENKIT_WORKSPACE_ID: 'ws_demo',
        OPENKIT_WORKSPACE_ROOTS: JSON.stringify(workspaceRoots),
        OPENROUTER_API_KEY: 'redacted',
      },
    });
    expect(clientInputs).toEqual([
      {
        baseUrl: 'http://127.0.0.1:45735',
        credentials: { password: 'secret-password', username: 'openkit' },
        directory: workspaceCwd,
      },
    ]);
    expect(fakeClient.createdSessions).toEqual([
      { directory: workspaceCwd, title: 'OpenKit th_demo' },
    ]);
    expect(fakeClient.prompts).toEqual([
      { directory: workspaceCwd, input: 'hello from opencode', sessionId: 'oc_session_1' },
    ]);
    expect(workspaceCwd).not.toBe(workspaceRoot);
  });

  it('reuses one supervised server and OpenCode session across repeated turns', async () => {
    const { input } = createSessionInput();
    const fakeClient = new FakeOpenCodeClient();
    const spawnInputs: OpenCodeServerSpawnInput[] = [];
    const session = new OpenCodeServerAgentSession(input, {
      allocatePort: () => 45732,
      createClient: () => fakeClient,
      fetch: async () => new Response('ok', { status: 200 }),
      generateCredentials: () => ({ password: 'secret-password', username: 'openkit' }),
      now: () => '2026-05-18T00:00:00.000Z',
      spawnServer: (spawnInput) => {
        spawnInputs.push(spawnInput);
        return new FakeOpenCodeProcess();
      },
    });

    await session.startTurn('tu_first', 'first');
    await session.startTurn('tu_second', 'second');

    expect(spawnInputs).toHaveLength(1);
    expect(fakeClient.createdSessions).toHaveLength(1);
    expect(fakeClient.prompts.map((prompt) => prompt.input)).toEqual(['first', 'second']);
  });

  it('shuts down the supervised server when the agent session closes', async () => {
    const { input } = createSessionInput();
    const fakeProcess = new FakeOpenCodeProcess();
    const session = new OpenCodeServerAgentSession(input, {
      allocatePort: () => 45733,
      createClient: () => new FakeOpenCodeClient(),
      fetch: async () => new Response('ok', { status: 200 }),
      generateCredentials: () => ({ password: 'secret-password', username: 'openkit' }),
      spawnServer: () => fakeProcess,
    });

    await session.startTurn('tu_demo', 'close after this');
    await session.close();

    expect(fakeProcess.killedSignals).toEqual(['SIGTERM']);
    expect(session.getState()).toBe('exited');
  });

  it('fails the active turn and kills the child process when readiness never succeeds', async () => {
    const { input } = createSessionInput();
    const fakeProcess = new FakeOpenCodeProcess();
    const events: AgentSessionEvent[] = [];
    const session = new OpenCodeServerAgentSession(input, {
      allocatePort: () => 45734,
      createClient: () => new FakeOpenCodeClient(),
      fetch: async () => new Response('not ready', { status: 503 }),
      generateCredentials: () => ({ password: 'secret-password', username: 'openkit' }),
      readinessTimeoutMs: 0,
      spawnServer: () => fakeProcess,
    });

    session.onEvent((event) => {
      events.push(event);
    });
    await session.startTurn('tu_demo', 'will fail readiness');

    expect(fakeProcess.killedSignals).toEqual(['SIGTERM']);
    expect(events.at(-1)).toMatchObject({
      type: 'turn-completed',
      turnId: 'tu_demo',
      status: 'failed',
      stopReason: 'error',
      error: {
        code: 'opencode_server_not_ready',
      },
    });
    expect(session.getState()).toBe('failed');
  });
});
