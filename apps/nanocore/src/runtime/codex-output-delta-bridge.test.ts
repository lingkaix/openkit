import { describe, expect, it, vi } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import type { ResolveAgentEnvironmentBackendInput } from './agent-environment.js';
import { CodexAppServerClient } from './codex/client.js';
import type { JsonRpcTransport, JsonRpcTransportMessage } from './codex/transport.js';
import { CodexAgentSession, CodexHostAdapter } from './host-adapter.js';
import type { AgentSession, AgentSessionFactory, CreateAgentSessionInput } from './types.js';

class FakeJsonRpcTransport implements JsonRpcTransport {
  public readonly sentMessages: JsonRpcTransportMessage[] = [];
  private messageHandler: ((message: JsonRpcTransportMessage) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;

  public async send(message: JsonRpcTransportMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  public onMessage(handler: (message: JsonRpcTransportMessage) => void): void {
    this.messageHandler = handler;
  }

  public onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  public async close(): Promise<void> {}

  public emitMessage(message: JsonRpcTransportMessage): void {
    this.messageHandler?.(message);
  }

  public emitClose(error?: Error): void {
    this.closeHandler?.(error);
  }
}

class FakeCodexAgentSessionFactory implements AgentSessionFactory {
  public readonly transport = new FakeJsonRpcTransport();

  public async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return new CodexAgentSession(
      input.id,
      input.threadId,
      new CodexAppServerClient({ transport: this.transport }),
      'codex_thread_1',
      input.environmentPackage
    );
  }
}

/**
 * Returns the explicit container backend used by legacy host-adapter bridge tests.
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

describe('Codex output delta bridge', () => {
  it('maps command execution outputDelta notifications into protocol item-delta events', async () => {
    const store = createDemoStore();
    const sessionFactory = new FakeCodexAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run tests');

    const startTurnPromise = adapter.startTurn(store, turn.id, 'Run tests');

    await vi.waitFor(() => {
      expect(sessionFactory.transport.sentMessages).toEqual(
        expect.arrayContaining([expect.objectContaining({ method: 'turn/start' })])
      );
    });

    const turnStartRequest = sessionFactory.transport.sentMessages.find(
      (message) => 'method' in message && message.method === 'turn/start'
    );

    expect(turnStartRequest).toMatchObject({ method: 'turn/start' });
    sessionFactory.transport.emitMessage({
      jsonrpc: '2.0',
      id: turnStartRequest?.id,
      result: {
        turn: {
          id: 'codex_turn_1',
          status: 'inProgress',
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      },
    });
    await startTurnPromise;

    sessionFactory.transport.emitMessage({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'codex_thread_1',
        turnId: 'codex_turn_1',
        item: {
          type: 'commandExecution',
          id: 'codex_cmd_1',
          command: 'pnpm test',
          cwd: '/workspace',
          exitCode: null,
          durationMs: null,
        },
      },
    });
    sessionFactory.transport.emitMessage({
      jsonrpc: '2.0',
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'codex_thread_1',
        turnId: 'codex_turn_1',
        itemId: 'codex_cmd_1',
        delta: 'pass\n',
      },
    });

    const itemDeltaEvents = store
      .getTurnEvents(turn.id)
      .filter((event) => event.data.type === 'item-delta');
    const commandItem = store
      .listThreadItems('ws_demo', 'th_demo')
      .find((item) => item.type === 'command-execution' && item.command === 'pnpm test');

    expect(itemDeltaEvents).toHaveLength(1);
    expect(itemDeltaEvents[0]).toMatchObject({
      event: 'item.delta',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      sequence: expect.any(Number),
      data: {
        type: 'item-delta',
        itemId: commandItem?.id,
        deltaKind: 'output-delta',
        itemType: 'command-execution',
        delta: 'pass\n',
      },
    });
    expect(commandItem).toMatchObject({ output: 'pass\n' });
  });
});
