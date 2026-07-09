import { z } from 'zod';
import type { OpenKitAiInterfaceRegistry, OpenKitPromptName, OpenKitToolName } from './registry.js';

/** JSON-RPC request id supported by MCP. */
export type JsonRpcId = string | number | null;

/** JSON-RPC request or notification accepted by the MCP adapter. */
export interface JsonRpcRequest {
  /** JSON-RPC protocol marker. */
  jsonrpc: '2.0';
  /** Optional id. Missing id means notification. */
  id?: JsonRpcId;
  /** JSON-RPC method. */
  method: string;
  /** Optional method parameters. */
  params?: unknown;
}

/** JSON-RPC response returned by the MCP adapter. */
export interface JsonRpcResponse {
  /** JSON-RPC protocol marker. */
  jsonrpc: '2.0';
  /** Request id. */
  id: JsonRpcId;
  /** Successful result payload. */
  result?: unknown;
  /** Error result payload. */
  error?: {
    /** JSON-RPC error code. */
    code: number;
    /** User-facing error message. */
    message: string;
  };
}

/** Async JSON-RPC handler function. */
export type JsonRpcHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>;

/** Creates a minimal MCP JSON-RPC handler backed by the OpenKit registry. */
export function createJsonRpcHandler(registry: OpenKitAiInterfaceRegistry): JsonRpcHandler {
  return async (request) => {
    if (request.id === undefined) {
      return null;
    }

    try {
      return {
        id: request.id,
        jsonrpc: '2.0',
        result: await dispatch(registry, request),
      };
    } catch (error: unknown) {
      return {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
        id: request.id,
        jsonrpc: '2.0',
      };
    }
  };
}

/** Dispatches one MCP JSON-RPC request to the registry. */
async function dispatch(
  registry: OpenKitAiInterfaceRegistry,
  request: JsonRpcRequest
): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        capabilities: { prompts: {}, resources: {}, tools: {} },
        protocolVersion: protocolVersion(request.params),
        serverInfo: { name: '@openkit/mcp', version: '0.0.0' },
      };
    case 'tools/list':
      return {
        tools: registry.listTools().map((tool) => ({
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.inputSchema),
          name: tool.name,
        })),
      };
    case 'tools/call': {
      const params = callToolParams(request.params);
      const result = await registry.callTool(params.name, params.arguments ?? {});
      return {
        content: [{ text: JSON.stringify(result, null, 2), type: 'text' }],
        structuredContent: result,
      };
    }
    case 'resources/list':
      return {
        resources: registry.listResources().map((resource) => ({
          description: resource.description,
          mimeType: 'application/json',
          name: resource.uri,
          uri: resource.uri,
        })),
      };
    case 'resources/templates/list':
      return {
        resourceTemplates: registry.listResources().map((resource) => ({
          description: resource.description,
          mimeType: 'application/json',
          name: resource.uri,
          uriTemplate: resource.uri,
        })),
      };
    case 'resources/read': {
      const resource = await registry.readResource(readResourceParams(request.params).uri);
      return {
        contents: [
          {
            mimeType: resource.mimeType,
            text: resource.text,
            uri: resource.uri,
          },
        ],
      };
    }
    case 'prompts/list':
      return {
        prompts: registry.listPrompts().map((prompt) => ({
          arguments: [],
          description: prompt.description,
          name: prompt.name,
        })),
      };
    case 'prompts/get': {
      const params = getPromptParams(request.params);
      const prompt = registry.getPrompt(params.name, params.arguments ?? {});
      return {
        messages: prompt.messages.map((message) => ({
          content: { text: message.content, type: 'text' },
          role: message.role,
        })),
      };
    }
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

/** Extracts the requested MCP protocol version when supplied. */
function protocolVersion(params: unknown): string {
  if (params && typeof params === 'object' && 'protocolVersion' in params) {
    const value = (params as { protocolVersion?: unknown }).protocolVersion;
    if (typeof value === 'string' && value) {
      return value;
    }
  }

  return '2025-06-18';
}

/** Parses `tools/call` parameters. */
function callToolParams(params: unknown): { arguments?: unknown; name: OpenKitToolName } {
  if (!params || typeof params !== 'object') {
    throw new Error('tools/call params are required.');
  }

  const record = params as { arguments?: unknown; name?: unknown };
  if (typeof record.name !== 'string') {
    throw new Error('tools/call name is required.');
  }

  return { arguments: record.arguments, name: record.name as OpenKitToolName };
}

/** Parses `resources/read` parameters. */
function readResourceParams(params: unknown): { uri: string } {
  if (!params || typeof params !== 'object') {
    throw new Error('resources/read params are required.');
  }

  const uri = (params as { uri?: unknown }).uri;
  if (typeof uri !== 'string' || !uri) {
    throw new Error('resources/read uri is required.');
  }

  return { uri };
}

/** Parses `prompts/get` parameters. */
function getPromptParams(params: unknown): { arguments?: unknown; name: OpenKitPromptName } {
  if (!params || typeof params !== 'object') {
    throw new Error('prompts/get params are required.');
  }

  const record = params as { arguments?: unknown; name?: unknown };
  if (typeof record.name !== 'string') {
    throw new Error('prompts/get name is required.');
  }

  return { arguments: record.arguments, name: record.name as OpenKitPromptName };
}
