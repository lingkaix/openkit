import type {
  InitializeParams,
  InitializeResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from './protocol.js';
import type { JsonRpcTransport } from './transport.js';

/**
 * Construction options for the Codex app-server client.
 */
export interface CodexAppServerClientOptions {
  transport: JsonRpcTransport;
}

/**
 * Thin JSON-RPC client for the small Codex app-server surface used by nanocore.
 */
export class CodexAppServerClient {
  private readonly transport: JsonRpcTransport;
  private readonly notificationListeners = new Set<(message: JsonRpcNotification) => void>();
  private readonly requestListeners = new Set<
    (message: JsonRpcRequest) => Promise<unknown> | unknown
  >();
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextRequestId = 1;

  /**
   * Binds the transport handlers.
   */
  public constructor(options: CodexAppServerClientOptions) {
    this.transport = options.transport;
    this.transport.onMessage((message) => {
      this.handleMessage(message as JsonRpcNotification | JsonRpcResponse);
    });
    this.transport.onClose((error) => {
      this.handleClose(error);
    });
  }

  /**
   * Initializes the connection with Codex app-server.
   */
  public async initialize(): Promise<InitializeResponse> {
    const params: InitializeParams = {
      clientInfo: {
        name: 'openkit-nanocore',
        version: '0.1.0',
      },
      capabilities: null,
    };

    const response = await this.request<InitializeResponse>('initialize', params);
    await this.notify('initialized', {});
    return response;
  }

  /**
   * Sends one JSON-RPC request.
   */
  public async request<TResult>(method: string, params: unknown): Promise<TResult> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const response = new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as TResult),
        reject,
      });
    });

    await this.transport.send({
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    });

    return response;
  }

  /**
   * Sends one JSON-RPC notification without expecting a response.
   */
  public async notify(method: string, params: unknown): Promise<void> {
    await this.transport.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  /**
   * Subscribes to transport notifications.
   */
  public onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);

    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /**
   * Subscribes to inbound JSON-RPC requests from Codex app-server.
   */
  public onRequest(listener: (message: JsonRpcRequest) => Promise<unknown> | unknown): () => void {
    this.requestListeners.add(listener);

    return () => {
      this.requestListeners.delete(listener);
    };
  }

  /**
   * Closes the underlying transport.
   */
  public async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * Routes one inbound JSON-RPC payload.
   */
  private handleMessage(message: JsonRpcNotification | JsonRpcResponse): void {
    if ('method' in message && 'id' in message) {
      void this.handleInboundRequest(message as JsonRpcRequest);
      return;
    }

    if ('method' in message) {
      for (const listener of this.notificationListeners) {
        listener(message);
      }
      return;
    }

    const pending = this.pendingRequests.get(message.id);

    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);

    if ('error' in message) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve((message as JsonRpcSuccessResponse).result);
  }

  /**
   * Resolves one inbound app-server request through the registered handler.
   */
  private async handleInboundRequest(message: JsonRpcRequest): Promise<void> {
    const [listener] = this.requestListeners;

    if (!listener) {
      await this.transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unhandled server request: ${message.method}` },
      });
      return;
    }

    try {
      const result = await listener(message);
      await this.transport.send({
        jsonrpc: '2.0',
        id: message.id,
        result,
      });
    } catch (error) {
      await this.transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: (error as Error).message },
      });
    }
  }

  /**
   * Rejects all pending requests on transport shutdown.
   */
  private handleClose(error?: Error): void {
    const failure = error ?? new Error('transport closed');

    for (const [requestId, pending] of this.pendingRequests) {
      this.pendingRequests.delete(requestId);
      pending.reject(failure);
    }
  }
}
