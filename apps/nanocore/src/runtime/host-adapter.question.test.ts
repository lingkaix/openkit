import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import type { ResolveAgentEnvironmentBackendInput } from './agent-environment.js';
import { CodexAppServerClient } from './codex/client.js';
import { CodexAgentSession, CodexHostAdapter } from './host-adapter.js';
import type { AgentSession, AgentSessionFactory, CreateAgentSessionInput } from './types.js';

interface TransportMessage {
  jsonrpc?: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class QuestionJsonRpcTransport {
  public readonly sentMessages: TransportMessage[] = [];
  private messageHandler: ((message: TransportMessage) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;

  /**
   * Records an outgoing JSON-RPC message.
   */
  public async send(message: TransportMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  /**
   * Registers the inbound message handler.
   */
  public onMessage(handler: (message: TransportMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Registers the close handler.
   */
  public onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  /**
   * Emits one inbound JSON-RPC message.
   */
  public emitMessage(message: TransportMessage): void {
    this.messageHandler?.(message);
  }

  /**
   * Simulates transport shutdown.
   */
  public emitClose(error?: Error): void {
    this.closeHandler?.(error);
  }

  /**
   * Closes the fake transport.
   */
  public async close(): Promise<void> {}
}

class QuestionSessionFactory implements AgentSessionFactory {
  public readonly transport = new QuestionJsonRpcTransport();
  public readonly client = new CodexAppServerClient({ transport: this.transport });
  public session: CodexAgentSession | null = null;

  /**
   * Returns the test Codex session.
   */
  public async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    this.session = new CodexAgentSession(
      input.id,
      input.threadId,
      this.client,
      'codex_thread_1',
      input.environmentPackage
    );
    return this.session;
  }
}

/**
 * Returns the explicit container backend used by legacy host-adapter question tests.
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

describe('CodexHostAdapter questions', () => {
  it('bridges a Codex user-input request through /api/turns and responds over JSON-RPC', async () => {
    const store = createDemoStore();
    const sessionFactory = new QuestionSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const app = createApp({ store, turnExecutor: adapter });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Ask a follow-up');
    const startPromise = adapter.startTurn(store, turn.id, 'Ask a follow-up');

    await vi.waitFor(() => {
      expect(sessionFactory.transport.sentMessages).toEqual(
        expect.arrayContaining([expect.objectContaining({ method: 'turn/start' })])
      );
    });
    const turnStartRequest = sessionFactory.transport.sentMessages.find(
      (message) => message.method === 'turn/start'
    );
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
    await startPromise;

    sessionFactory.transport.emitMessage({
      jsonrpc: '2.0',
      id: 99,
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'question_item_1',
        threadId: 'codex_thread_1',
        turnId: 'codex_turn_1',
        questions: [
          {
            id: 'branch',
            header: 'Branch',
            question: 'Which branch should I use?',
            options: null,
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(store.getTurnById(turn.id)).toMatchObject({
        status: 'awaiting_human',
        humanGate: {
          kind: 'user-input',
          userInputRequestId: 'question_item_1',
          itemId: 'it_user_input_request_question_item_1',
        },
      });
    });
    expect(store.listThreadItems('ws_demo', 'th_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user-input-request',
          userInputRequestId: 'question_item_1',
          prompt: 'Which branch should I use?',
        }),
      ])
    );

    const response = await app.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        requestId: '0190f4c8-0000-7000-8000-000000000501',
        input: 'main',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(202);
    expect(store.getTurnById(turn.id).status).toBe('running');
    expect(store.listThreadItems('ws_demo', 'th_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user-input-response',
          userInputRequestId: 'question_item_1',
          answers: { branch: ['main'] },
        }),
      ])
    );
    await vi.waitFor(() => {
      expect(sessionFactory.transport.sentMessages).toContainEqual({
        jsonrpc: '2.0',
        id: 99,
        result: {
          answers: {
            branch: {
              answers: ['main'],
            },
          },
        },
      });
    });
  });
});
