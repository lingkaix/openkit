import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { CallToolResult, Transport } from '@modelcontextprotocol/client';
import { createJiti } from 'jiti';

/*
 * `pi-mcp-adapter/host-managed` 3.3.0 is published only as TypeScript source. Node refuses to
 * strip types under node_modules, and tsc under this repository's configuration would type-check
 * the adapter's own sources, so the module is loaded through jiti (the loader Pi itself uses for
 * TypeScript extensions) and the narrow surface this host uses is typed here. The declarations
 * mirror the pinned 3.3.0 `host-managed.ts`; the host tests exercise the real module, which is
 * what proves they still match. Revisit when the adapter publishes compiled JavaScript or Pi
 * ships official MCP.
 */

/** Event on `pi.events` through which the adapter asks the embedding host to approve a call. */
export const MCP_TOOL_APPROVAL_REQUEST_EVENT = 'pi-mcp-adapter:tool-approval-request';

/** Decision a host approval handler returns. */
export type McpToolApprovalDecision = 'allow_once' | 'allow_for_session' | 'deny' | 'abstain';

/** Approval request the adapter emits once per tool call. */
export interface McpToolApprovalRequest {
  readonly originalToolName: string;
  readonly serverName: string;
  /** Claims the request for one handler; only the first claim is accepted. */
  claim(handler: () => McpToolApprovalDecision | Promise<McpToolApprovalDecision>): boolean;
}

/** One approved tool call handed to the host before it is sent. */
export interface HostManagedMcpToolCall {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly server: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** Sends `tools/call` once and returns the validated result. */
  dispatch(): Promise<CallToolResult>;
}

/** One MCP server whose transport the host owns. */
export interface HostManagedMcpServer {
  /** Returns an unconnected transport; called once by `ready()`. */
  createTransport(context: { server: string; signal: AbortSignal }): Transport | Promise<Transport>;
}

/** Adapter options. */
export interface HostManagedMcpAdapterOptions {
  onToolCall(call: HostManagedMcpToolCall): Promise<CallToolResult>;
  servers: Record<string, HostManagedMcpServer>;
}

/** Adapter instance: connect once, register tools into Pi, close within five seconds. */
export interface HostManagedMcpAdapter {
  close(): Promise<void>;
  readonly extensionFactory: ExtensionFactory;
  ready(): Promise<void>;
}

/** Factory exported by `pi-mcp-adapter/host-managed`. */
export type CreateHostManagedMcpAdapter = (
  options: HostManagedMcpAdapterOptions
) => HostManagedMcpAdapter;

let loaded: Promise<CreateHostManagedMcpAdapter> | null = null;

/**
 * Loads the pinned adapter's host-managed entry once per process.
 *
 * @returns The adapter factory.
 * @throws Error when the module does not export the expected factory.
 */
export function loadHostManagedMcp(): Promise<CreateHostManagedMcpAdapter> {
  loaded ??= createJiti(import.meta.url)
    .import('pi-mcp-adapter/host-managed')
    .then((module) => {
      const factory = (module as { createHostManagedMcpAdapter?: unknown })
        .createHostManagedMcpAdapter;
      if (typeof factory !== 'function') {
        throw new Error('pi-mcp-adapter host-managed entry is missing its factory.');
      }
      return factory as CreateHostManagedMcpAdapter;
    });
  return loaded;
}
