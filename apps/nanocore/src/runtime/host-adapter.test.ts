import { describe, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import type { ResolveAgentEnvironmentBackendInput } from './agent-environment.js';
import { CodexHostAdapter } from './host-adapter.js';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionFactory,
  AgentSessionState,
  CreateAgentSessionInput,
} from './types.js';

class FakeAgentSession implements AgentSession {
  public readonly id: string;
  public readonly environmentPackage: CreateAgentSessionInput['environmentPackage'];
  public readonly threadId: string;
  public readonly startTurnCalls: Array<{ turnId: string; input: string }> = [];
  public readonly interruptCalls: string[] = [];
  public startTurnError: Error | null = null;
  public state: AgentSessionState = 'bound';
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(input: CreateAgentSessionInput) {
    this.id = input.id;
    this.environmentPackage = input.environmentPackage;
    this.threadId = input.threadId;
  }

  /**
   * Registers a host-adapter listener.
   */
  public onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts a turn against the fake session.
   */
  public async startTurn(turnId: string, input: string): Promise<void> {
    if (this.startTurnError) {
      throw this.startTurnError;
    }

    this.startTurnCalls.push({ turnId, input });
    this.state = 'running';
  }

  /**
   * Interrupts the fake turn.
   */
  public async interruptTurn(turnId: string): Promise<void> {
    this.interruptCalls.push(turnId);
    this.emit({
      type: 'turn-completed',
      turnId,
      status: 'interrupted',
      stopReason: 'aborted',
      completedAt: new Date().toISOString(),
    });
    this.state = 'bound';
  }

  /**
   * Closes the fake session.
   */
  public async close(): Promise<void> {
    this.state = 'exited';
  }

  /**
   * Returns the current session state.
   */
  public getState(): AgentSessionState {
    return this.state;
  }

  /**
   * Emits a runtime event into the adapter.
   */
  public emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeAgentSessionFactory implements AgentSessionFactory {
  public readonly sessions: FakeAgentSession[] = [];
  public readonly inputs: CreateAgentSessionInput[] = [];

  /**
   * Creates one fake agent session per requested thread.
   */
  public async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const session = new FakeAgentSession(input);
    this.inputs.push(input);
    this.sessions.push(session);
    return session;
  }
}

/**
 * Returns the explicit container backend used by legacy host-adapter unit tests.
 *
 * @returns OpenShell Agent Environment Package target.
 */
function testOpenShellBackend(): ResolveAgentEnvironmentBackendInput {
  return {
    controlRelayUpstream: 'https://nanocore.local/api/worker-control',
    kind: 'openshell',
    sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
  };
}

describe('CodexHostAdapter', () => {
  it('reuses the same session for repeated turns on one thread', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turnA = store.createTurn('ws_demo', 'th_demo', 'First request');

    await adapter.startTurn(store, turnA.id, 'First request');

    const session = sessionFactory.sessions[0];
    session.emit({ type: 'turn-started', turnId: turnA.id, startedAt: turnA.startedAt ?? '' });
    session.emit({ type: 'agent-message-delta', turnId: turnA.id, delta: 'hello ' });
    session.emit({ type: 'agent-message-delta', turnId: turnA.id, delta: 'world' });
    session.emit({
      type: 'turn-completed',
      turnId: turnA.id,
      status: 'completed',
      stopReason: 'completed',
      completedAt: new Date().toISOString(),
    });

    const turnB = store.createTurn('ws_demo', 'th_demo', 'Follow up');
    await adapter.startTurn(store, turnB.id, 'Follow up');

    expect(sessionFactory.sessions).toHaveLength(1);
    expect(session.startTurnCalls).toEqual([
      { turnId: turnA.id, input: 'First request' },
      { turnId: turnB.id, input: 'Follow up' },
    ]);
  });

  it('replaces a reusable session when the session workspace key changes', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turnA = store.createTurn('ws_demo', 'th_demo', 'Use first workspace');

    await adapter.startTurn(store, turnA.id, 'Use first workspace', {
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
          workerPath: '/workspace/openkit',
        },
      ],
    });
    const firstSession = sessionFactory.sessions[0];
    firstSession.state = 'bound';

    const turnB = store.createTurn('ws_demo', 'th_demo', 'Use second workspace');
    await adapter.startTurn(store, turnB.id, 'Use second workspace', {
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
          workerPath: '/workspace/other',
        },
      ],
    });

    expect(firstSession.getState()).toBe('exited');
    expect(sessionFactory.sessions).toHaveLength(2);
    expect(sessionFactory.sessions[1]?.startTurnCalls).toEqual([
      { turnId: turnB.id, input: 'Use second workspace' },
    ]);
  });

  it('passes captured workspace roots to newly created sessions', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use workspace data', 3);

    await adapter.startTurn(store, turn.id, 'Use workspace data', {
      workspaceRoots: [
        {
          id: 'data',
          sourceKind: 'host-dir',
          sourcePath: '/workspace/files/data',
          workerPath: '/workspace/files/data',
          access: 'read-only',
        },
      ],
    });

    expect(sessionFactory.inputs[0]?.workspaceRoots).toEqual([
      expect.objectContaining({ id: 'data', access: 'read-only' }),
    ]);
    expect(sessionFactory.inputs[0]?.environmentPackage).toMatchObject({
      scope: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        agentSessionId: sessionFactory.inputs[0]?.id,
      },
      workspace: {
        inputs: [expect.objectContaining({ id: 'data', access: 'read-only' })],
      },
      backend: {
        preferred: 'openshell',
      },
    });
    expect(store.listThreadAgentSessions('ws_demo', 'th_demo')[0]?.workspaceRoots).toEqual([
      expect.objectContaining({ id: 'data', access: 'read-only' }),
    ]);
    expect(store.listThreadAgentSessions('ws_demo', 'th_demo')[0]?.sessionCompatibilityKey).toMatch(
      /^sha256:[0-9a-f]{64}$/
    );
    expect(
      store.listThreadAgentSessions('ws_demo', 'th_demo')[0]?.environmentPackageSnapshot
    ).toMatchObject({
      scope: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
      },
      backend: {
        preferred: 'openshell',
      },
    });
  });

  it('passes a configured OpenShell package target to newly created sessions', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use OpenShell package', 3);

    await adapter.startTurn(store, turn.id, 'Use OpenShell package', {
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
          workerPath: '/workspace/openkit',
        },
      ],
    });

    expect(sessionFactory.inputs[0]?.environmentPackage).toMatchObject({
      backend: {
        preferred: 'openshell',
      },
      control: {
        endpoint: {
          baseUrl: 'https://control.local/v1/worker-control',
        },
        mode: 'sidecar',
      },
      runtime: {
        image: {
          kind: 'container-image',
          ref: 'ghcr.io/openkit/codex-worker:test',
        },
      },
    });
    expect(
      store.listThreadAgentSessions('ws_demo', 'th_demo')[0]?.environmentPackageSnapshot
    ).toMatchObject({
      backend: {
        preferred: 'openshell',
      },
      control: {
        mode: 'sidecar',
      },
    });
    expect(
      JSON.stringify(
        store.listThreadAgentSessions('ws_demo', 'th_demo')[0]?.environmentPackageSnapshot
      )
    ).not.toContain('/Users/m5pro');
    expect(adapter.getAgentSession(store, 'ws_demo', 'th_demo')).toMatchObject({
      backend: {
        controlMode: 'sidecar',
        health: 'unknown',
        kind: 'openshell',
      },
      sandboxSummary: {
        access: 'read-write',
        workspaceRootRefs: ['repo'],
      },
    });
  });

  it('passes a selected repository cwd to newly created sessions', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use repository cwd', 3);
    const repositoryPath = '/Users/m5pro/work/repository';

    await adapter.startTurn(store, turn.id, 'Use repository cwd', {
      workspaceRoots: [],
      workspaceCwd: repositoryPath,
    });

    expect(sessionFactory.inputs[0]?.workspaceCwd).toBe(repositoryPath);
    expect(store.listThreadAgentSessions('ws_demo', 'th_demo')[0]).not.toHaveProperty(
      'workspaceCwd'
    );
    expect(
      JSON.stringify(
        store.listThreadAgentSessions('ws_demo', 'th_demo')[0]?.environmentPackageSnapshot
      )
    ).not.toContain('/Users/m5pro');
    expect(
      store.listThreadAgentSessions('ws_demo', 'th_demo')[0]?.environmentPackageSnapshot?.runtime
        .command.workingDirectory
    ).toBe('[redacted:host-path]');
  });

  it('maps runtime deltas into protocol-valid turn events', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Ship it');

    await adapter.startTurn(store, turn.id, 'Ship it');

    const session = sessionFactory.sessions[0];
    session.emit({ type: 'turn-started', turnId: turn.id, startedAt: turn.startedAt ?? '' });
    session.emit({ type: 'agent-message-delta', turnId: turn.id, delta: 'Ship ' });
    session.emit({ type: 'agent-message-delta', turnId: turn.id, delta: 'it.' });
    session.emit({
      type: 'turn-completed',
      turnId: turn.id,
      status: 'completed',
      stopReason: 'completed',
      completedAt: new Date().toISOString(),
    });

    const events = store.getTurnEvents(turn.id);

    expect(events.map((event) => event.event)).toContain('turn.started');
    expect(events.map((event) => event.event)).toContain('item.delta');
    expect(events.at(-1)?.event).toBe('turn.completed');
    expect(events.at(-1)?.data).toMatchObject({ type: 'turn-completed', stopReason: 'completed' });
    expect(store.getTurnById(turn.id).status).toBe('completed');
  });

  it('maps runtime item lifecycle events into protocol items', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run tests');

    await adapter.startTurn(store, turn.id, 'Run tests');

    const session = sessionFactory.sessions[0];
    session.emit({ type: 'turn-started', turnId: turn.id, startedAt: turn.startedAt ?? '' });
    session.emit({
      type: 'agent-item-started',
      turnId: turn.id,
      item: {
        kind: 'command-execution',
        itemId: 'cmd_1',
        command: 'pnpm test',
        cwd: '/workspace',
        exitCode: null,
        durationMs: null,
      },
    });
    session.emit({
      type: 'agent-item-completed',
      turnId: turn.id,
      item: {
        kind: 'command-execution',
        itemId: 'cmd_1',
        command: 'pnpm test',
        cwd: '/workspace',
        exitCode: 0,
        durationMs: 1200,
      },
    });
    session.emit({
      type: 'turn-completed',
      turnId: turn.id,
      status: 'completed',
      stopReason: 'completed',
      completedAt: new Date().toISOString(),
    });

    const commandItem = store
      .listThreadItems('ws_demo', 'th_demo')
      .find((item) => item.type === 'command-execution' && item.command === 'pnpm test');

    expect(commandItem).toMatchObject({
      type: 'command-execution',
      status: 'completed',
      exitCode: 0,
      durationMs: 1200,
    });
    expect(store.getTurnEvents(turn.id).map((event) => event.event)).toEqual(
      expect.arrayContaining(['item.created', 'item.completed'])
    );
  });

  it('interrupts the active turn through the bound session', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Interrupt me');

    await adapter.startTurn(store, turn.id, 'Interrupt me');
    await adapter.interruptTurn(store, turn.id);

    const session = sessionFactory.sessions[0];

    expect(session.interruptCalls).toEqual([turn.id]);
    expect(store.getTurnById(turn.id).status).toBe('interrupted');
    expect(store.getTurnEvents(turn.id).at(-1)?.event).toBe('turn.completed');
  });

  it('drops failed sessions so the next turn creates a new one', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turnA = store.createTurn('ws_demo', 'th_demo', 'First');

    await adapter.startTurn(store, turnA.id, 'First');
    sessionFactory.sessions[0]?.emit({
      type: 'session-state-changed',
      state: 'failed',
      reason: 'process exited',
    });

    const turnB = store.createTurn('ws_demo', 'th_demo', 'Second');
    await adapter.startTurn(store, turnB.id, 'Second');

    expect(sessionFactory.sessions).toHaveLength(2);
    expect(store.getAgent('ws_demo', 'agent_codex_host').health).toMatchObject({
      status: 'failed',
      message: 'process exited',
    });
  });

  it('finalizes a running turn when agent start fails before terminal events arrive', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Hit provider rate limit');

    await adapter.startTurn(store, turn.id, 'prime session');
    sessionFactory.sessions[0].state = 'bound';
    sessionFactory.sessions[0].startTurnError = new Error('OpenRouter rate limit exceeded.');

    const failingTurn = store.createTurn('ws_demo', 'th_demo', 'Hit provider rate limit');

    await expect(
      adapter.startTurn(store, failingTurn.id, 'Hit provider rate limit')
    ).rejects.toThrow('OpenRouter rate limit exceeded.');

    expect(store.getTurnById(failingTurn.id)).toMatchObject({
      status: 'failed',
      error: {
        code: 'agent_turn_start_failed',
        message: 'OpenRouter rate limit exceeded.',
      },
    });
    expect(store.getTurnEvents(failingTurn.id).at(-1)?.event).toBe('turn.completed');
  });

  it('normalizes malformed runtime error codes before persisting failed turns', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail with malformed error');

    await adapter.startTurn(store, turn.id, 'Fail with malformed error');
    sessionFactory.sessions[0].emit({
      type: 'turn-completed',
      turnId: turn.id,
      status: 'failed',
      stopReason: 'error',
      completedAt: new Date().toISOString(),
      error: {
        code: undefined as unknown as string,
        message: 'Provider returned 429.',
      },
    });

    expect(store.getTurnById(turn.id).error).toEqual({
      code: 'agent_turn_failed',
      message: 'Provider returned 429.',
    });
  });

  it('reclaims idle bound sessions', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Start and reclaim');

    await adapter.startTurn(store, turn.id, 'Start and reclaim');

    sessionFactory.sessions[0].state = 'idle';

    await expect(adapter.reclaimIdleSessions()).resolves.toBe(1);
    expect(sessionFactory.sessions[0].state).toBe('exited');
    expect(adapter.getSessionDiagnostics()).toEqual([]);
  });

  it('routes OpenCode agents through the OpenCode session factory without protocol changes', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { opencode: sessionFactory },
    });
    store.updateWorkspace('ws_demo', {
      defaults: {
        defaultAgentId: 'agent_opencode_host',
      },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use OpenCode');

    await adapter.startTurn(store, turn.id, 'Use OpenCode');

    const session = sessionFactory.sessions[0];
    session.emit({ type: 'turn-started', turnId: turn.id, startedAt: turn.startedAt ?? '' });
    session.emit({ type: 'agent-message-delta', turnId: turn.id, delta: 'OpenCode result' });
    session.emit({
      type: 'turn-completed',
      turnId: turn.id,
      status: 'completed',
      stopReason: 'completed',
      completedAt: new Date().toISOString(),
    });

    const agentSession = store.getTurnEvents(turn.id).find((event) => {
      return event.data.type === 'agent-session-updated';
    });

    expect(sessionFactory.sessions).toHaveLength(1);
    expect(
      agentSession?.data.type === 'agent-session-updated' && agentSession.data.agentSession.agentId
    ).toBe('agent_opencode_host');
    expect(store.getTurnById(turn.id).status).toBe('completed');
  });

  it('routes OpenCode serve agents through the server session factory without changing protocol', async () => {
    const store = createDemoStore();
    const commandFactory = new FakeAgentSessionFactory();
    const serverFactory = new FakeAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { opencode: commandFactory, opencodeServer: serverFactory },
    });
    const existingAgent = store.getAgent('ws_demo', 'agent_opencode_host');

    store.upsertAgent('ws_demo', {
      ...existingAgent,
      id: 'agent_opencode_server',
      name: 'OpenCode Server Agent',
      config: {
        ...existingAgent.config,
        command: 'opencode serve',
        baseUrl: null,
      },
    });
    store.updateWorkspace('ws_demo', {
      defaults: {
        defaultAgentId: 'agent_opencode_server',
      },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use OpenCode server');

    await adapter.startTurn(store, turn.id, 'Use OpenCode server');

    expect(commandFactory.sessions).toHaveLength(0);
    expect(serverFactory.sessions).toHaveLength(1);
    expect(serverFactory.sessions[0]?.startTurnCalls).toEqual([
      { turnId: turn.id, input: 'Use OpenCode server' },
    ]);
  });
});
