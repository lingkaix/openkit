import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { JsonRpcHandler, JsonRpcRequest } from './mcp-protocol.js';

/** Options for serving JSON-RPC over newline-delimited stdio. */
export interface ServeStdioOptions {
  /** Readable JSON-RPC input stream. */
  input: Readable;
  /** Writable JSON-RPC output stream. */
  output: Writable;
  /** Writable diagnostic stream. */
  error: Writable;
  /** Request handler. */
  handler: JsonRpcHandler;
}

/** Serves a minimal MCP JSON-RPC transport over newline-delimited stdio. */
export async function serveStdio(options: ServeStdioOptions): Promise<void> {
  const lines = createInterface({ input: options.input });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const request = JSON.parse(trimmed) as JsonRpcRequest;
      const response = await options.handler(request);
      if (response) {
        options.output.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      options.error.write(`${message}\n`);
    }
  }
}
