import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from './client.js';

interface TransportMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class FakeJsonRpcTransport {
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
   * Emits a transport message into the client.
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
}

describe('CodexAppServerClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends initialize over JSON-RPC and resolves the response', async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new CodexAppServerClient({ transport });
    const initializePromise = client.initialize();

    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toMatchObject({
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'openkit-nanocore',
          version: '0.1.0',
        },
      },
    });

    transport.emitMessage({
      id: transport.sentMessages[0]?.id,
      result: {
        userAgent: 'codex/test',
        codexHome: '/tmp/codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    await expect(initializePromise).resolves.toMatchObject({
      userAgent: 'codex/test',
      codexHome: '/tmp/codex',
    });
  });

  it('sends initialized after initialize resolves', async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new CodexAppServerClient({ transport });
    const initializePromise = client.initialize();

    transport.emitMessage({
      id: transport.sentMessages[0]?.id,
      result: {
        userAgent: 'codex/test',
        codexHome: '/tmp/codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    await initializePromise;

    expect(transport.sentMessages[1]).toMatchObject({
      method: 'initialized',
      params: {},
    });
    expect(transport.sentMessages[1]?.id).toBeUndefined();
  });

  it('fans out notifications to subscribers', async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new CodexAppServerClient({ transport });
    const listener = vi.fn();

    client.onNotification(listener);
    transport.emitMessage({
      method: 'turn/completed',
      params: {
        threadId: 'thread_1',
        turn: {
          id: 'turn_1',
          items: [],
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
        },
      },
    });

    expect(listener).toHaveBeenCalledWith({
      method: 'turn/completed',
      params: expect.objectContaining({
        threadId: 'thread_1',
      }),
    });
  });

  it('responds to inbound server requests through the request handler', async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new CodexAppServerClient({ transport });

    client.onRequest(async (message) => {
      expect(message.method).toBe('execCommandApproval');
      return { decision: 'approved' };
    });

    transport.emitMessage({
      id: 42,
      method: 'execCommandApproval',
      params: { callId: 'call_1' },
    });

    await vi.waitFor(() => {
      expect(transport.sentMessages).toContainEqual({
        jsonrpc: '2.0',
        id: 42,
        result: { decision: 'approved' },
      });
    });
  });

  it('rejects pending requests when the transport closes', async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new CodexAppServerClient({ transport });
    const initializePromise = client.initialize();

    transport.emitClose(new Error('transport closed'));

    await expect(initializePromise).rejects.toThrow('transport closed');
  });
});
