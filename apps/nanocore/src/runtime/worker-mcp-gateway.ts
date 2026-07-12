import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { WorkerControlGatewayError } from './worker-control-gateway.js';

const DEFAULT_MCP_RESULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
const MCP_SECRET_FIELD_NAMES = new Set([
  'apiKey',
  'authorization',
  'clientSecret',
  'credential',
  'password',
  'secret',
  'token',
]);

/** AEP-resolved MCP server snapshot visible to the worker capability gateway. */
export type WorkerMcpServerSnapshot = AgentEnvironmentPackage['supply']['mcpServers'][number];

/** Gateway-private credentials resolved for one MCP call. */
export interface WorkerMcpGatewayCredentials {
  /** Environment variables visible only to a stdio MCP server process. */
  environment?: Record<string, string>;
  /** HTTP headers visible only to an HTTP MCP server request. */
  headers?: Record<string, string>;
}

/** Input for one MCP tool call through the NanoCore-owned gateway. */
export interface WorkerMcpToolCallInput {
  /** AEP-resolved MCP server snapshot. */
  server: WorkerMcpServerSnapshot;
  /** MCP tool name to call. */
  toolName: string;
  /** JSON arguments for the MCP tool. */
  arguments: Record<string, unknown>;
  /** Gateway-private credentials resolved by NanoCore for this call. */
  credentials?: WorkerMcpGatewayCredentials | undefined;
  /** Optional sink for product-safe live server-reported schemas observed during the call. */
  liveSchemaSnapshotSink?: ((snapshot: WorkerMcpLiveSchemaSnapshot) => void) | undefined;
}

/** NanoCore-owned worker MCP gateway. */
export interface WorkerMcpGateway {
  /**
   * Calls one MCP tool through the gateway.
   *
   * @param input Tool call input.
   * @returns Product-safe structured tool result.
   */
  callTool(input: WorkerMcpToolCallInput): Promise<Record<string, unknown>>;
  /**
   * Stops gateway-owned live MCP server resources.
   */
  close?(): Promise<void>;
  /**
   * Stops live resources for one server snapshot.
   *
   * @param server AEP-resolved MCP server snapshot.
   */
  closeServer?(server: WorkerMcpServerSnapshot): Promise<void>;
  /**
   * Reads product-safe health for one server snapshot.
   *
   * @param server AEP-resolved MCP server snapshot.
   * @returns Current product-safe health state.
   */
  getServerHealth?(server: WorkerMcpServerSnapshot): WorkerMcpServerHealth;
}

/** Product-safe live MCP tool schema snapshot observed by the gateway. */
export interface WorkerMcpLiveSchemaSnapshot {
  /** Product-safe server identity from initialize when present. */
  serverInfo?: Record<string, unknown> | undefined;
  /** Product-safe tool names and input schemas. */
  tools: Array<{ inputSchema: Record<string, unknown>; name: string }>;
}

/** Product-safe MCP server health state reported through worker capability routes. */
export type WorkerMcpServerHealth = 'ready' | 'degraded' | 'failed';

/** Options for the default worker MCP gateway. */
export interface CreateDefaultWorkerMcpGatewayOptions {
  /** Host environment used to resolve gateway-private credentials. */
  env?: NodeJS.ProcessEnv;
}

/** Creates the default worker MCP gateway. */
export function createDefaultWorkerMcpGateway(
  options: CreateDefaultWorkerMcpGatewayOptions = {}
): WorkerMcpGateway {
  return new DefaultWorkerMcpGateway(options.env ?? process.env);
}

/** Default NanoCore worker MCP gateway with supervised stdio session reuse. */
class DefaultWorkerMcpGateway implements WorkerMcpGateway {
  private readonly stdioSessions = new Map<string, Promise<StdioMcpSession>>();
  private readonly stdioHealth = new Map<string, WorkerMcpServerHealth>();

  /**
   * Creates the default gateway.
   *
   * @param env Host environment used to resolve gateway-private credentials.
   */
  public constructor(private readonly env: NodeJS.ProcessEnv) {}

  /**
   * Calls one MCP tool through a supervised stdio or HTTP path.
   *
   * @param input Tool call input.
   * @returns Product-safe structured tool result.
   */
  public async callTool(input: WorkerMcpToolCallInput): Promise<Record<string, unknown>> {
    const expectedInputSchema = input.server.toolSchemas.find(
      (tool) => tool.name === input.toolName
    )?.inputSchema;

    if (input.server.transport === 'stdio') {
      return this.callStdioTool(input, expectedInputSchema);
    }

    if (input.server.transport === 'http') {
      return callHttpWorkerMcpTool({
        args: input.arguments,
        expectedInputSchema,
        headers: input.credentials?.headers ?? workerMcpCredentialHeaders(input.server, this.env),
        liveSchemaSnapshotSink: input.liveSchemaSnapshotSink,
        toolName: input.toolName,
        url: input.server.url ?? '',
      });
    }

    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      'MCP server transport is not available.',
      503
    );
  }

  /**
   * Reads the current product-safe health state for one MCP server snapshot.
   *
   * @param server AEP-resolved MCP server snapshot.
   * @returns Product-safe health state.
   */
  public getServerHealth(server: WorkerMcpServerSnapshot): WorkerMcpServerHealth {
    if (server.transport !== 'stdio') {
      return 'ready';
    }

    return this.stdioHealth.get(this.stdioServerKey(server)) ?? 'ready';
  }

  /**
   * Stops all cached stdio MCP sessions.
   */
  public async close(): Promise<void> {
    const sessions = await Promise.allSettled(this.stdioSessions.values());
    this.stdioSessions.clear();
    await Promise.all(
      sessions.map((session) => (session.status === 'fulfilled' ? session.value.close() : null))
    );
  }

  /**
   * Stops the cached stdio MCP session for one server snapshot.
   *
   * @param server AEP-resolved MCP server snapshot.
   */
  public async closeServer(server: WorkerMcpServerSnapshot): Promise<void> {
    if (server.transport !== 'stdio') {
      return;
    }

    const serverKey = this.stdioServerKey(server);
    const sessionKeyPrefix = `${serverKey}\n`;
    const sessionPromises = [...this.stdioSessions.entries()]
      .filter(([key]) => key.startsWith(sessionKeyPrefix))
      .map(([key, sessionPromise]) => {
        this.stdioSessions.delete(key);
        return sessionPromise;
      });
    this.stdioHealth.set(serverKey, 'degraded');
    const sessions = await Promise.allSettled(sessionPromises);
    await Promise.all(
      sessions.map((session) => (session.status === 'fulfilled' ? session.value.close() : null))
    );
  }

  /**
   * Calls one stdio MCP tool through a cached supervised session.
   *
   * @param input Tool call input.
   * @param expectedInputSchema Pinned input schema for drift checks.
   * @returns Product-safe structured tool result.
   */
  private async callStdioTool(
    input: WorkerMcpToolCallInput,
    expectedInputSchema: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    const command = input.server.command ?? [];
    const env =
      input.credentials?.environment ?? workerMcpCredentialEnvironment(input.server, this.env);
    const serverKey = this.stdioServerKey(input.server);
    const key = this.stdioSessionKey(input.server, env);
    let sessionPromise = this.stdioSessions.get(key);

    if (!sessionPromise) {
      sessionPromise = Promise.resolve().then(
        () =>
          new StdioMcpSession(command, env, () => {
            if (this.stdioSessions.get(key) === sessionPromise) {
              this.stdioSessions.delete(key);
              this.stdioHealth.set(serverKey, 'degraded');
            }
          })
      );
      this.stdioSessions.set(key, sessionPromise);
    }

    try {
      const session = await sessionPromise;
      const result = await withTimeout(DEFAULT_MCP_CALL_TIMEOUT_MS, () =>
        session.callTool(input, expectedInputSchema)
      );
      if (this.stdioSessions.get(key) === sessionPromise) {
        this.stdioHealth.set(serverKey, 'ready');
      }
      return result;
    } catch (error) {
      if (
        error instanceof WorkerControlGatewayError &&
        (error.code === 'mcp-server-unavailable' || error.code === 'mcp-timeout')
      ) {
        const currentSessionPromise = this.stdioSessions.get(key);
        if (!currentSessionPromise || currentSessionPromise === sessionPromise) {
          if (currentSessionPromise) {
            this.stdioSessions.delete(key);
          }
          this.stdioHealth.set(serverKey, 'degraded');
        }
        if (error.code === 'mcp-timeout') {
          const session = await sessionPromise.catch(() => null);
          await session?.close();
        }
      }
      throw error;
    }
  }

  /**
   * Builds the cache key for one stdio server snapshot and credential environment.
   *
   * @param server AEP-resolved MCP server snapshot.
   * @param env Gateway-private credential environment.
   * @returns Stable cache key for this process configuration.
   */
  private stdioSessionKey(server: WorkerMcpServerSnapshot, env: Record<string, string>): string {
    return `${this.stdioServerKey(server)}\n${canonicalJson({ command: server.command ?? [], env })}`;
  }

  /**
   * Builds the identity key shared by every credential variant of one stdio server.
   *
   * @param server AEP-resolved MCP server snapshot.
   * @returns Stable server identity key.
   */
  private stdioServerKey(server: WorkerMcpServerSnapshot): string {
    return JSON.stringify({ serverId: server.id });
  }
}

/** Input for one HTTP MCP tool call. */
export interface HttpWorkerMcpToolCallInput {
  /** HTTP MCP endpoint URL. */
  url: string;
  /** Gateway-private headers for the MCP server request. */
  headers?: Record<string, string>;
  /** MCP tool name to call. */
  toolName: string;
  /** JSON arguments for the tool. */
  args: Record<string, unknown>;
  /** Pinned input schema expected for this tool. */
  expectedInputSchema?: Record<string, unknown> | undefined;
  /** Optional sink for live server-reported schemas observed during the call. */
  liveSchemaSnapshotSink?: ((snapshot: WorkerMcpLiveSchemaSnapshot) => void) | undefined;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum serialized structured result size in bytes. */
  maxResultBytes?: number;
}

type JsonRpcResponse =
  | {
      error: { code: number; message: string };
      id: number;
      jsonrpc: '2.0';
    }
  | {
      id: number;
      jsonrpc: '2.0';
      result: unknown;
    };

/** Calls one HTTP MCP server using request/response JSON-RPC. */
export async function callHttpWorkerMcpTool(
  input: HttpWorkerMcpToolCallInput
): Promise<Record<string, unknown>> {
  if (!input.url) {
    throw mcpServerUnavailableError();
  }

  return withTimeout(input.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS, async () => {
    const client = new HttpJsonRpcClient(input.url, input.headers ?? {});

    const initializeResult = await client.request('initialize', {
      capabilities: {},
      clientInfo: { name: 'openkit-nanocore', version: '0.1.0' },
      protocolVersion: '2025-06-18',
    });

    if (input.expectedInputSchema) {
      const liveTools = extractLiveToolSchemas(await client.request('tools/list', {}));
      enforcePinnedToolSchema(liveTools, input.toolName, input.expectedInputSchema);
      input.liveSchemaSnapshotSink?.({
        serverInfo: extractServerInfo(initializeResult),
        tools: liveTools,
      });
    }

    return toolResultPayload(
      await client.request('tools/call', {
        arguments: input.args,
        name: input.toolName,
      }),
      input.maxResultBytes ?? DEFAULT_MCP_RESULT_MAX_BYTES
    );
  });
}

/** One initialized stdio MCP server session owned by the default gateway. */
class StdioMcpSession {
  private chain = Promise.resolve();
  private initializeResult: unknown;
  private initialized = false;
  private readonly client: StdioJsonRpcClient;

  /**
   * Creates one supervised stdio MCP session.
   *
   * @param command Command argv used to start the MCP server.
   * @param env Gateway-private environment variables for the MCP server process.
   * @param onClosed Callback fired when the child process closes or errors.
   */
  public constructor(command: string[], env: Record<string, string>, onClosed: () => void) {
    this.client = new StdioJsonRpcClient(command, env, onClosed);
  }

  /**
   * Calls one tool after initializing the session once.
   *
   * @param input Tool call input.
   * @param expectedInputSchema Pinned input schema for drift checks.
   * @returns Product-safe structured tool result.
   */
  public async callTool(
    input: WorkerMcpToolCallInput,
    expectedInputSchema: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    const run = this.chain.then(() => this.callToolSerial(input, expectedInputSchema));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Stops the supervised MCP server process.
   */
  public async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Runs one serialized MCP tool call on the child process.
   *
   * @param input Tool call input.
   * @param expectedInputSchema Pinned input schema for drift checks.
   * @returns Product-safe structured tool result.
   */
  private async callToolSerial(
    input: WorkerMcpToolCallInput,
    expectedInputSchema: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    if (!this.initialized) {
      this.initializeResult = await this.client.request('initialize', {
        capabilities: {},
        clientInfo: { name: 'openkit-nanocore', version: '0.1.0' },
        protocolVersion: '2025-06-18',
      });
      await this.client.notify('initialized', {});
      this.initialized = true;
    }

    if (expectedInputSchema) {
      const liveTools = extractLiveToolSchemas(await this.client.request('tools/list', {}));
      enforcePinnedToolSchema(liveTools, input.toolName, expectedInputSchema);
      input.liveSchemaSnapshotSink?.({
        serverInfo: extractServerInfo(this.initializeResult),
        tools: liveTools,
      });
    }

    return toolResultPayload(
      await this.client.request('tools/call', {
        arguments: input.arguments,
        name: input.toolName,
      }),
      DEFAULT_MCP_RESULT_MAX_BYTES
    );
  }
}

class StdioJsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
    }
  >();
  private nextId = 1;

  public constructor(
    command: string[],
    env: Record<string, string>,
    onClosed: () => void = () => undefined
  ) {
    const executable = command[0];
    const args = command.slice(1);
    const safeEnv = process.env.PATH ? { PATH: process.env.PATH, ...env } : env;

    if (!executable) {
      throw mcpServerUnavailableError();
    }

    this.child = spawn(executable, args, {
      env: safeEnv,
      stdio: 'pipe',
    });

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.handleLine(line);
    });

    this.child.once('error', () => {
      this.rejectAll(mcpServerUnavailableError());
      onClosed();
    });
    this.child.once('exit', () => {
      this.rejectAll(mcpServerUnavailableError());
      onClosed();
    });
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
    // Child process failures can reject before stdin write completes.
    void response.catch(() => undefined);

    try {
      await this.write({ id, jsonrpc: '2.0', method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    return response;
  }

  public async notify(method: string, params: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', method, params });
  }

  public async close(): Promise<void> {
    this.child.kill();
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let response: JsonRpcResponse;

    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.rejectAll(new Error('MCP server returned invalid JSON-RPC.'));
      return;
    }

    const pending = this.pending.get(response.id);

    if (!pending) {
      return;
    }

    this.pending.delete(response.id);

    if ('error' in response) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(mcpServerUnavailableError());
          return;
        }

        resolve();
      });
    });
  }
}

class HttpJsonRpcClient {
  private nextId = 1;

  public constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {}
  ) {}

  public async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    let response: Response;

    try {
      response = await fetch(this.url, {
        body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...this.headers,
        },
        method: 'POST',
      });
    } catch {
      throw mcpServerUnavailableError();
    }

    if (!response.ok) {
      throw mcpServerUnavailableError();
    }

    return parseJsonRpcResponse(await response.json(), id);
  }
}

/**
 * Resolves gateway-private environment variables for one MCP server.
 *
 * @param server AEP-resolved MCP server snapshot.
 * @param env Host environment candidate.
 * @returns Scrubbed environment variables for the child process.
 */
function workerMcpCredentialEnvironment(
  server: WorkerMcpServerSnapshot,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  if (!server.providerInstanceIds.includes('provider_github_read')) {
    return {};
  }

  return Object.fromEntries(
    ['GITHUB_TOKEN', 'GH_TOKEN']
      .map((key) => [key, env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
  );
}

/**
 * Resolves gateway-private HTTP headers for one MCP server.
 *
 * @param server AEP-resolved MCP server snapshot.
 * @param env Host environment candidate.
 * @returns Scrubbed HTTP headers for MCP JSON-RPC requests.
 */
function workerMcpCredentialHeaders(
  server: WorkerMcpServerSnapshot,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  if (!server.providerInstanceIds.includes('provider_github_read')) {
    return {};
  }

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Returns the stable worker-visible error for unreachable MCP servers. */
function mcpServerUnavailableError(): WorkerControlGatewayError {
  return new WorkerControlGatewayError('mcp-server-unavailable', 'MCP server is unavailable.', 503);
}

function parseJsonRpcResponse(response: unknown, id: number): unknown {
  if (
    !response ||
    typeof response !== 'object' ||
    (response as { id?: unknown }).id !== id ||
    (response as { jsonrpc?: unknown }).jsonrpc !== '2.0'
  ) {
    throw new Error('MCP server returned invalid JSON-RPC.');
  }

  if ('error' in response) {
    throw new Error('MCP server returned a JSON-RPC error.');
  }

  return (response as { result?: unknown }).result;
}

async function withTimeout<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new WorkerControlGatewayError('mcp-timeout', 'MCP tool call timed out.', 504));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof WorkerControlGatewayError) {
      throw error;
    }

    throw new WorkerControlGatewayError('mcp-call-failed', 'MCP tool call failed.', 502);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toolResultPayload(result: unknown, maxResultBytes: number): Record<string, unknown> {
  if (result && typeof result === 'object') {
    const structuredContent = (result as { structuredContent?: unknown }).structuredContent;

    if (structuredContent && typeof structuredContent === 'object') {
      const redacted = redactMcpResult(structuredContent);
      enforceResultSize(redacted, maxResultBytes);
      return redacted as Record<string, unknown>;
    }

    const redacted = redactMcpResult(result);
    enforceResultSize(redacted, maxResultBytes);
    return redacted as Record<string, unknown>;
  }

  throw new WorkerControlGatewayError('mcp-call-failed', 'MCP tool call failed.', 502);
}

function redactMcpResult(value: unknown, fieldName?: string): unknown {
  if (fieldName && MCP_SECRET_FIELD_NAMES.has(fieldName)) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactMcpResult(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactMcpResult(nested, key)])
    );
  }

  return value;
}

function enforcePinnedToolSchema(
  tools: WorkerMcpLiveSchemaSnapshot['tools'],
  toolName: string,
  expectedInputSchema: Record<string, unknown>
): void {
  const tool = tools.find((candidate) => candidate.name === toolName);

  if (!tool || canonicalJson(tool.inputSchema ?? null) !== canonicalJson(expectedInputSchema)) {
    throw new WorkerControlGatewayError('mcp-schema-drift', 'MCP tool schema drift detected.', 409);
  }
}

function extractLiveToolSchemas(listResult: unknown): WorkerMcpLiveSchemaSnapshot['tools'] {
  if (
    !listResult ||
    typeof listResult !== 'object' ||
    !Array.isArray((listResult as { tools?: unknown }).tools)
  ) {
    throw new WorkerControlGatewayError('mcp-schema-drift', 'MCP tool schema drift detected.', 409);
  }

  return (listResult as { tools: Array<{ inputSchema?: unknown; name?: unknown }> }).tools.map(
    (tool) => {
      if (typeof tool.name !== 'string' || !isRecord(tool.inputSchema)) {
        throw new WorkerControlGatewayError(
          'mcp-schema-drift',
          'MCP tool schema drift detected.',
          409
        );
      }

      return {
        inputSchema: tool.inputSchema,
        name: tool.name,
      };
    }
  );
}

function extractServerInfo(initializeResult: unknown): Record<string, unknown> | undefined {
  if (!initializeResult || typeof initializeResult !== 'object') {
    return undefined;
  }

  const serverInfo = (initializeResult as { serverInfo?: unknown }).serverInfo;
  return isRecord(serverInfo) ? serverInfo : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJsonValue(nested)])
    );
  }

  return value;
}

function enforceResultSize(result: unknown, maxResultBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxResultBytes) {
    throw new WorkerControlGatewayError(
      'mcp-result-too-large',
      'MCP tool result exceeds the gateway payload limit.',
      413
    );
  }
}
