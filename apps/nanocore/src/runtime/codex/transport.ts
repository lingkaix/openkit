import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './protocol.js';

/**
 * Message shape transported between nanocore and Codex app-server.
 */
export type JsonRpcTransportMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * Transport contract used by the JSON-RPC client.
 */
export interface JsonRpcTransport {
  /**
   * Sends one JSON-RPC message.
   */
  send(message: JsonRpcTransportMessage): Promise<void>;

  /**
   * Registers the inbound message handler.
   */
  onMessage(handler: (message: JsonRpcTransportMessage) => void): void;

  /**
   * Registers the transport close handler.
   */
  onClose(handler: (error?: Error) => void): void;

  /**
   * Closes the transport.
   */
  close(): Promise<void>;
}

/**
 * Options for launching a stdio JSON-RPC agent process.
 */
export interface StdioJsonRpcTransportOptions {
  command?: string;
  cwd: string;
  environment?: Record<string, string>;
}

/**
 * Splits the simple command strings stored in agent configuration.
 */
function splitCommand(command: string): { executable: string; args: string[] } {
  const [executable, ...args] = command.split(' ').filter(Boolean);

  if (!executable) {
    throw new Error('Agent command cannot be empty.');
  }

  return { executable, args };
}

/**
 * Spawns `codex app-server` and exchanges JSON-RPC messages over stdio.
 */
export class StdioJsonRpcTransport implements JsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private messageHandler: ((message: JsonRpcTransportMessage) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;

  /**
   * Starts the Codex app-server process.
   */
  public constructor(options: StdioJsonRpcTransportOptions) {
    const { executable, args } = splitCommand(
      options.command ?? 'codex app-server --listen stdio://'
    );

    this.child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.environment },
      stdio: 'pipe',
    });

    const stdout = createInterface({ input: this.child.stdout });

    stdout.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      this.messageHandler?.(JSON.parse(line) as JsonRpcTransportMessage);
    });

    this.child.once('error', (error) => {
      this.closeHandler?.(error);
    });

    this.child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.closeHandler?.(new Error(`${executable} exited with ${detail}`));
    });
  }

  /**
   * Sends one line-delimited JSON-RPC message.
   */
  public async send(message: JsonRpcTransportMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  /**
   * Registers the inbound message handler.
   */
  public onMessage(handler: (message: JsonRpcTransportMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Registers the close handler.
   */
  public onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  /**
   * Stops the child process.
   */
  public async close(): Promise<void> {
    this.child.kill();
  }
}
