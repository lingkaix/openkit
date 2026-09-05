import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedWorkspaceMcpServer } from '@openkit/config-schema';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';

const MCP_RESULT_MAX_BYTES = 512 * 1024;
const MCP_PROTOCOL_RESPONSE_MAX_BYTES = 2 * MCP_RESULT_MAX_BYTES;
const MCP_HEALTH_CHECK_MS = 15_000;
const MCP_SESSION_IDLE_MS = 60_000;
const MCP_STDIO_SUPERVISOR =
  "const{spawn}=require('node:child_process');const reap=()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(71)}};process.on('SIGTERM',reap);process.on('disconnect',reap);if(!process.connected||process.ppid!==Number(process.argv[1]))reap();else{const child=spawn(process.argv[2],process.argv.slice(3),{stdio:'inherit'});child.on('error',reap);child.on('exit',reap)}";

/** Product-safe process-local MCP server health. */
export type WorkerMcpServerHealth = 'inactive' | 'starting' | 'ready' | 'degraded' | 'failed';

/** Upstream effect certainty attached to a failed MCP tool call. */
export type WorkerMcpUpstreamEffect = 'not-contacted' | 'contacted' | 'unknown';

/** Typed MCP tool failure carrying the upstream effect boundary result. */
export class WorkerMcpGatewayCallError extends WorkerControlGatewayError {
  /** Whether caller cancellation caused this failure. */
  public readonly cancelled: boolean;
  /** Whether gateway-only credentials definitely reached their configured transport sink. */
  public readonly credentialsMaterialized: boolean;
  /** Whether the tool request crossed the upstream effect boundary. */
  public readonly upstreamEffect: WorkerMcpUpstreamEffect;

  /** Creates one bounded gateway call failure. */
  public constructor(
    code: string,
    message: string,
    status: number,
    upstreamEffect: WorkerMcpUpstreamEffect,
    cancelled = false,
    credentialsMaterialized = false
  ) {
    super(code, message, status);
    this.name = 'WorkerMcpGatewayCallError';
    this.cancelled = cancelled;
    this.credentialsMaterialized = credentialsMaterialized;
    this.upstreamEffect = upstreamEffect;
  }
}

/** Gateway-private credentials resolved for one MCP server connection. */
export interface WorkerMcpGatewayCredentials {
  /** Environment variables visible only to a gateway-owned stdio process. */
  readonly environment?: Readonly<Record<string, string>>;
  /** HTTP headers visible only to a gateway-owned HTTP transport. */
  readonly headers?: Readonly<Record<string, string>>;
  /** HTTP query values visible only to a gateway-owned HTTP transport. */
  readonly query?: Readonly<Record<string, string>>;
}

/** Product-safe live MCP tools captured from one initialized server. */
export interface WorkerMcpLiveTools {
  /** Product-safe server-reported version when present. */
  readonly serverVersion: string | null;
  /** Live MCP tool declarations. */
  readonly tools: Awaited<ReturnType<Client['listTools']>>['tools'];
}

/** NanoCore-owned MCP client and server lifecycle boundary. */
export interface WorkerMcpGateway {
  /** Lists live tools through one initialized SDK client. */
  listTools(input: WorkerMcpGatewayServerInput): Promise<WorkerMcpLiveTools>;
  /** Calls one tool through one initialized SDK client. */
  callTool(
    input: WorkerMcpGatewayServerInput & {
      readonly arguments: Record<string, unknown>;
      readonly toolName: string;
    }
  ): Promise<Awaited<ReturnType<Client['callTool']>>>;
  /** Stops every gateway-owned MCP client and child process. */
  close(): Promise<void>;
  /** Stops the cached client for one resolved server. */
  closeServer(input: WorkerMcpGatewayServerInput): Promise<void>;
  /** Stops cached clients for one server only when no operation is using them. */
  closeServerIfIdle(input: Omit<WorkerMcpGatewayServerInput, 'credentials'>): Promise<void>;
  /** Stops every cached client owned by one Workspace. */
  closeWorkspace(workspaceId: string): Promise<void>;
  /** Returns the current product-safe server health. */
  getServerHealth(input: WorkerMcpGatewayServerInput): WorkerMcpServerHealth;
}

/** One resolved Workspace server selected for a gateway operation. */
export interface WorkerMcpGatewayServerInput {
  /** Gateway-private credentials already authorized for this operation. */
  readonly credentials?: WorkerMcpGatewayCredentials;
  /** Cancellation signal for this operation only. */
  readonly signal?: AbortSignal;
  /** Current strict catalog entry. */
  readonly server: ResolvedWorkspaceMcpServer;
  /** Workspace that owns the selected catalog entry. */
  readonly workspaceId: string;
}

/** Creates the default MCP SDK client supervisor. */
export function createDefaultWorkerMcpGateway(coreDb?: CoreDb): WorkerMcpGateway {
  return new DefaultWorkerMcpGateway(coreDb);
}

/** Process-local MCP SDK client supervisor keyed by Workspace catalog identity. */
class DefaultWorkerMcpGateway implements WorkerMcpGateway {
  private closed = false;
  private readonly activeUses = new Map<string, number>();
  private readonly sessions = new Map<string, Promise<WorkerMcpSession>>();
  private readonly sessionInputs = new Map<string, WorkerMcpGatewayServerInput>();
  private readonly health = new Map<string, WorkerMcpServerHealth>();
  private readonly healthTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionTeardowns = new Map<string, () => Promise<void>>();
  private readonly teardowns = new Map<string, Promise<void>>();
  private readonly teardownRequired = new Set<string>();

  public constructor(private readonly coreDb?: CoreDb) {}

  /** Lists one bounded, non-paginated live server tool page. */
  public async listTools(input: WorkerMcpGatewayServerInput): Promise<WorkerMcpLiveTools> {
    if (input.signal?.aborted) {
      throw new WorkerMcpGatewayCallError(
        'mcp-server-unavailable',
        'MCP server is unavailable.',
        503,
        'not-contacted',
        true
      );
    }
    const cancellationReason = new McpError(
      ErrorCode.RequestTimeout,
      'MCP caller cancelled request.'
    );
    const cancellation = new AbortController();
    const forwardCancellation = () => cancellation.abort(cancellationReason);
    input.signal?.addEventListener('abort', forwardCancellation, { once: true });
    const operationInput = { ...input, signal: cancellation.signal };
    const key = workerMcpSessionKey(operationInput);
    const pending = this.session(operationInput);
    let connected = false;
    try {
      const session = await pending;
      connected = true;
      let page: Awaited<ReturnType<Client['listTools']>>;
      try {
        page = await session.client.listTools(
          undefined,
          requestOptions(input.server.timeoutMs, cancellation.signal)
        );
      } catch (error) {
        if (error === cancellationReason) {
          throw new WorkerMcpGatewayCallError(
            'mcp-server-unavailable',
            'MCP server is unavailable.',
            503,
            'unknown',
            true,
            hasCredentials(input)
          );
        }
        const normalized = normalizeMcpError(error, 'list');
        throw hasCredentials(input)
          ? new WorkerMcpGatewayCallError(
              normalized.code,
              normalized.message,
              normalized.status,
              error instanceof McpError && error.code !== ErrorCode.RequestTimeout
                ? 'contacted'
                : 'unknown',
              false,
              true
            )
          : normalized;
      }
      if (this.sessions.get(key) !== pending) {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server session closed during tool listing.',
          503,
          'contacted',
          false,
          hasCredentials(input)
        );
      }
      if (
        page.nextCursor ||
        Buffer.byteLength(JSON.stringify(page.tools), 'utf8') > MCP_RESULT_MAX_BYTES
      ) {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP tool listing exceeds the V1 response bound.',
          503,
          'contacted',
          false,
          hasCredentials(input)
        );
      }
      const live = {
        serverVersion: session.client.getServerVersion()?.version ?? null,
        tools: page.tools,
      };
      if (containsCredential(live, input.credentials)) {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP tool listing was rejected.',
          503,
          'contacted',
          false,
          true
        );
      }
      this.transition(input, 'ready');
      return live;
    } catch (error) {
      if (this.sessions.get(key) === pending) {
        this.transition(input, connected ? 'degraded' : 'failed');
        try {
          await this.discard(key, undefined, pending);
        } catch {
          throw cleanupRecoveryError(error, connected ? 'unknown' : 'not-contacted', input);
        }
      }
      throw normalizeMcpError(error, 'list');
    } finally {
      try {
        await this.release(key, pending);
      } finally {
        input.signal?.removeEventListener('abort', forwardCancellation);
      }
    }
  }

  /** Calls one MCP tool and rejects oversized results without truncation. */
  public async callTool(
    input: WorkerMcpGatewayServerInput & {
      readonly arguments: Record<string, unknown>;
      readonly toolName: string;
    }
  ): Promise<Awaited<ReturnType<Client['callTool']>>> {
    if (input.signal?.aborted) {
      throw new WorkerMcpGatewayCallError(
        'mcp-call-failed',
        'MCP tool call failed.',
        503,
        'not-contacted',
        true
      );
    }
    const cancellationReason = new McpError(
      ErrorCode.RequestTimeout,
      'MCP caller cancelled request.'
    );
    const cancellation = new AbortController();
    const forwardCancellation = () => cancellation.abort(cancellationReason);
    input.signal?.addEventListener('abort', forwardCancellation, { once: true });
    const operationInput = { ...input, signal: cancellation.signal };
    const key = workerMcpSessionKey(operationInput);
    const pending = this.session(operationInput);
    let session: WorkerMcpSession;
    try {
      session = await pending;
    } catch (error) {
      if (this.sessions.get(key) === pending) {
        this.transition(input, 'failed');
        await this.discard(key, undefined, pending);
      }
      try {
        await this.release(key, pending, true);
      } finally {
        input.signal?.removeEventListener('abort', forwardCancellation);
      }
      throw normalizeMcpCallError(error, 'not-contacted', error === cancellationReason);
    }

    try {
      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        result = await session.client.callTool(
          { arguments: input.arguments, name: input.toolName },
          undefined,
          requestOptions(input.server.timeoutMs, cancellation.signal)
        );
      } catch (error) {
        const normalized = normalizeMcpCallError(
          error,
          error instanceof McpError &&
            error.code !== ErrorCode.ConnectionClosed &&
            error.code !== ErrorCode.RequestTimeout
            ? 'contacted'
            : 'unknown',
          error === cancellationReason
        );
        if (this.sessions.get(key) === pending) {
          this.transition(input, 'degraded');
          try {
            await this.discard(key, undefined, pending);
          } catch {
            throw cleanupRecoveryError(normalized, normalized.upstreamEffect, input);
          }
        }
        throw normalized;
      }
      if (this.sessions.get(key) !== pending) {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call completed after its session closed.',
          502,
          'contacted'
        );
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MCP_RESULT_MAX_BYTES) {
        throw new WorkerMcpGatewayCallError(
          'mcp-result-too-large',
          'MCP tool result exceeds the capability response limit.',
          413,
          'contacted'
        );
      }
      if (containsCredential(result, input.credentials)) {
        this.transition(input, 'degraded');
        const rejected = new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool result was rejected.',
          502,
          'contacted',
          false,
          true
        );
        try {
          await this.discard(key, undefined, pending);
        } catch {
          throw cleanupRecoveryError(rejected, 'contacted', input);
        }
        throw rejected;
      }
      this.transition(input, 'ready');
      if (result.isError === true) {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call failed.',
          502,
          'contacted'
        );
      }
      return result;
    } finally {
      try {
        await this.release(key, pending, true);
      } finally {
        input.signal?.removeEventListener('abort', forwardCancellation);
      }
    }
  }

  /** Stops every initialized or initializing session. */
  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((key) => this.discard(key, 'inactive')));
    this.health.clear();
  }

  /** Stops every cached session for one Workspace server authority. */
  public async closeServer(input: WorkerMcpGatewayServerInput): Promise<void> {
    const keys = [...this.sessions.keys()].filter((key) => {
      const cached = this.sessionInputs.get(key);
      return cached?.workspaceId === input.workspaceId && cached.server.id === input.server.id;
    });
    await Promise.all(keys.map((key) => this.discard(key, 'inactive')));
    if (keys.length === 0) this.transition(input, 'inactive');
  }

  /** Stops only idle sessions so one operation cannot terminate another in-flight call. */
  public async closeServerIfIdle(
    input: Omit<WorkerMcpGatewayServerInput, 'credentials'>
  ): Promise<void> {
    const keys = [...this.sessions.keys()].filter((key) => {
      const cached = this.sessionInputs.get(key);
      return (
        cached?.workspaceId === input.workspaceId &&
        cached.server.id === input.server.id &&
        (this.activeUses.get(key) ?? 0) === 0
      );
    });
    await Promise.all(keys.map((key) => this.discard(key, 'inactive')));
  }

  /** Stops every cached session before its Workspace can be deleted. */
  public async closeWorkspace(workspaceId: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter(
      (key) => this.sessionInputs.get(key)?.workspaceId === workspaceId
    );
    await Promise.all(keys.map((key) => this.discard(key, 'inactive')));
  }

  /** Reads health without contacting the server. */
  public getServerHealth(input: WorkerMcpGatewayServerInput): WorkerMcpServerHealth {
    return this.health.get(workerMcpSessionPrefix(input)) ?? 'inactive';
  }

  /** Returns the shared initialized session for one exact resolved server. */
  private session(input: WorkerMcpGatewayServerInput): Promise<WorkerMcpSession> {
    if (this.closed) {
      return Promise.reject(
        new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server is unavailable.',
          503,
          'not-contacted'
        )
      );
    }
    const key = workerMcpSessionKey(input);
    if (this.teardownRequired.has(key)) {
      return Promise.reject(
        new WorkerMcpGatewayCallError(
          'recovery_required',
          'MCP server cleanup recovery is required.',
          409,
          'unknown',
          false,
          hasCredentials(input)
        )
      );
    }
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);
    this.activeUses.set(key, (this.activeUses.get(key) ?? 0) + 1);
    let pending = this.sessions.get(key);
    if (!pending) {
      pending = this.connect(input);
      this.sessions.set(key, pending);
      this.sessionInputs.set(key, input);
      const started = pending;
      void started.then(
        (session) => {
          if (this.sessions.get(key) === started) {
            this.scheduleHealthCheck(key, input, started, session.client);
          }
        },
        () => undefined
      );
    }
    return pending;
  }

  /** Connects one catalog-declared transport through the official MCP SDK. */
  private async connect(input: WorkerMcpGatewayServerInput): Promise<WorkerMcpSession> {
    this.transition(input, 'starting');
    const client = new Client({ name: 'openkit-nanocore', version: '1.0.0' });
    const key = workerMcpSessionKey(input);
    let transportClosed = false;
    client.onclose = () => {
      transportClosed = true;
      if (this.teardownRequired.has(key)) return;
      const pending = this.sessions.get(key);
      if (!pending) return;
      void pending.then(
        (session) => {
          if (this.sessions.get(key) !== pending || session.client !== client) return;
          this.transition(input, 'degraded');
          void this.discard(key, undefined, pending).catch(() => this.transition(input, 'failed'));
        },
        () => undefined
      );
    };
    let transport: StdioServerTransport | StreamableHTTPClientTransport;
    let processGroupId: number | null = null;
    if (input.server.transport.kind === 'stdio') {
      const child = spawn(
        process.execPath,
        [
          '-e',
          MCP_STDIO_SUPERVISOR,
          String(process.pid),
          input.server.transport.command,
          ...input.server.transport.args,
        ],
        {
          detached: true,
          env: { ...getDefaultEnvironment(), ...input.credentials?.environment },
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        }
      );
      processGroupId = child.pid ?? null;
      // The SDK's stream transport is role-neutral; Node owns spawning and process groups.
      const streams = new StdioServerTransport(child.stdout!, child.stdin!, {
        maxBufferSize: MCP_PROTOCOL_RESPONSE_MAX_BYTES,
      });
      /** Settles native termination through the SDK close path at most once. */
      const close = () => {
        if (!transportClosed) void streams.close();
      };
      /** Fences the transport after a child or pipe failure. */
      const fail = (error: Error) => {
        streams.onerror?.(error);
        close();
      };
      child.on('error', fail);
      child.once('exit', close);
      child.stdin!.on('error', fail);
      child.stderr!.on('data', () => undefined);
      child.stderr!.on('error', fail);
      transport = streams;
    } else {
      transport = new StreamableHTTPClientTransport(httpEndpoint(input), {
        fetch: boundedMcpFetch(input.server.timeoutMs, hasCredentials(input)),
        requestInit: input.credentials?.headers ? { headers: input.credentials.headers } : {},
      });
    }
    // The SDK's optional sessionId declaration conflicts with exactOptionalPropertyTypes.
    const connection = client.connect(
      transport as Parameters<Client['connect']>[0],
      requestOptions(input.server.timeoutMs, input.signal)
    );
    this.sessionTeardowns.set(key, () => closeMcpSession(client, transport, processGroupId));
    try {
      await connection;
      return { client };
    } catch (error) {
      if (input.signal?.aborted && input.signal.reason === error) {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server is unavailable.',
          503,
          processGroupId === null ? 'unknown' : 'not-contacted',
          true,
          hasCredentials(input) && processGroupId !== null
        );
      }
      if (
        hasCredentials(input) &&
        (processGroupId !== null ||
          error instanceof McpError ||
          error instanceof StreamableHTTPError)
      ) {
        const normalized = normalizeMcpError(error, 'list');
        const cancelled = input.signal?.aborted && input.signal.reason === error;
        throw new WorkerMcpGatewayCallError(
          normalized.code,
          normalized.message,
          normalized.status,
          error instanceof McpError || error instanceof StreamableHTTPError
            ? 'contacted'
            : 'unknown',
          cancelled,
          true
        );
      }
      throw error;
    }
  }

  /** Removes and closes one cached session, retaining ownership when cleanup fails. */
  private async discard(
    key: string,
    nextHealth?: Extract<WorkerMcpServerHealth, 'inactive'>,
    expected?: Promise<WorkerMcpSession>
  ): Promise<void> {
    const pending = this.sessions.get(key);
    if (expected && pending !== expected) return;
    const activeTeardown = this.teardowns.get(key);
    if (activeTeardown) return activeTeardown;
    const input = this.sessionInputs.get(key);
    const healthTimer = this.healthTimers.get(key);
    if (healthTimer) clearTimeout(healthTimer);
    this.healthTimers.delete(key);
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);
    this.teardownRequired.add(key);
    const teardown = Promise.resolve().then(async () => {
      await pending?.catch(() => null);
      await this.sessionTeardowns.get(key)?.();
      this.sessions.delete(key);
      this.sessionInputs.delete(key);
      this.sessionTeardowns.delete(key);
      this.activeUses.delete(key);
      this.teardownRequired.delete(key);
      if (input && nextHealth) this.transition(input, nextHealth);
    });
    this.teardowns.set(key, teardown);
    try {
      await teardown;
    } finally {
      if (this.teardowns.get(key) === teardown) this.teardowns.delete(key);
    }
  }

  /** Pings one still-current live session and degrades it when the upstream disappears. */
  private async checkHealth(
    key: string,
    input: WorkerMcpGatewayServerInput,
    pending: Promise<WorkerMcpSession>,
    client: Client
  ): Promise<void> {
    if (this.sessions.get(key) !== pending) return;
    if ((this.activeUses.get(key) ?? 0) > 0) {
      this.scheduleHealthCheck(key, input, pending, client);
      return;
    }
    try {
      await client.ping(requestOptions(input.server.timeoutMs));
    } catch {
      if (this.sessions.get(key) !== pending) return;
      this.transition(input, 'degraded');
      await this.discard(key, undefined, pending);
      return;
    }
    if (this.sessions.get(key) === pending) {
      this.transition(input, 'ready');
      this.scheduleHealthCheck(key, input, pending, client);
    }
  }

  /** Schedules the next bounded health check for one exact cached session. */
  private scheduleHealthCheck(
    key: string,
    input: WorkerMcpGatewayServerInput,
    pending: Promise<WorkerMcpSession>,
    client: Client
  ): void {
    const previous = this.healthTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      void this.checkHealth(key, input, pending, client);
    }, MCP_HEALTH_CHECK_MS);
    timer.unref();
    this.healthTimers.set(key, timer);
  }

  /** Releases one active operation and bounds credential sessions to the current request tick. */
  private async release(
    key: string,
    pending: Promise<WorkerMcpSession>,
    closeCredentialsNow = false
  ): Promise<void> {
    if (this.sessions.get(key) !== pending) return;
    const active = (this.activeUses.get(key) ?? 1) - 1;
    if (active > 0) {
      this.activeUses.set(key, active);
      return;
    }
    this.activeUses.delete(key);
    if (this.teardownRequired.has(key)) return;
    const input = this.sessionInputs.get(key);
    if (input && hasCredentials(input) && closeCredentialsNow) {
      try {
        await this.discard(key, 'inactive', pending);
      } catch (error) {
        this.transition(input, 'failed');
        throw cleanupRecoveryError(error, 'contacted', input);
      }
      return;
    }
    const timer = setTimeout(
      () => {
        void this.discard(key, 'inactive', pending).catch(() => {
          if (input) this.transition(input, 'failed');
        });
      },
      input && hasCredentials(input) ? 0 : MCP_SESSION_IDLE_MS
    );
    timer.unref();
    this.idleTimers.set(key, timer);
  }

  /** Records one changed process-local health projection as a redacted Workspace AuditEvent. */
  private transition(input: WorkerMcpGatewayServerInput, state: WorkerMcpServerHealth): void {
    const key = workerMcpSessionPrefix(input);
    if (this.health.get(key) === state) return;
    if (!this.coreDb?.sqlite.open) {
      if (state === 'starting' && hasCredentials(input)) {
        throw new WorkerControlGatewayError(
          'mcp-server-unavailable',
          'MCP credential-bearing server start could not be audited.',
          503
        );
      }
      this.health.set(key, state);
      return;
    }
    try {
      const workspaceDb = openWorkspaceDb(this.coreDb.dataRoot, input.workspaceId);
      try {
        applyScopedMigrations(workspaceDb);
        recordWorkspaceAuditEvent({
          action: `mcp.server.lifecycle.${state}`,
          category: 'capability',
          errorCode: state === 'degraded' || state === 'failed' ? 'mcp-server-unavailable' : null,
          outcome: state === 'degraded' || state === 'failed' ? 'failed' : 'succeeded',
          resource: `mcp-server:${input.server.id}`,
          severity: state === 'degraded' || state === 'failed' ? 'warning' : 'info',
          summary: `MCP server ${input.server.id} entered ${state}${hasCredentials(input) && state === 'starting' ? ' with gateway-only credentials' : ''}.`,
          workspaceDb,
          workspaceId: input.workspaceId,
        });
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch {
      if (state === 'starting' && hasCredentials(input)) {
        throw new WorkerControlGatewayError(
          'mcp-server-unavailable',
          'MCP credential-bearing server start could not be audited.',
          503
        );
      }
    }
    this.health.set(key, state);
  }
}

/** One initialized upstream SDK client. */
interface WorkerMcpSession {
  readonly client: Client;
}

/** Proves one initialized or initializing SDK transport closed before ownership is released. */
async function closeMcpSession(
  client: Client,
  transport: StdioServerTransport | StreamableHTTPClientTransport,
  processGroupId: number | null
): Promise<void> {
  if (transport instanceof StreamableHTTPClientTransport) {
    await transport.terminateSession();
    await client.close();
    return;
  }
  if (processGroupId) {
    await client.close().catch(() => undefined);
    await terminateMcpProcessGroup(processGroupId);
    return;
  }
  await client.close();
}

/** Terminates one gateway-owned detached stdio process group under bounded TERM-to-KILL cleanup. */
async function terminateMcpProcessGroup(groupId: number): Promise<void> {
  signalMcpProcessGroup(groupId, 'SIGTERM');
  if (await waitForMcpProcessGroupExit(groupId, 1_000)) return;
  signalMcpProcessGroup(groupId, 'SIGKILL');
  if (!(await waitForMcpProcessGroupExit(groupId, 1_000))) {
    throw new Error('MCP stdio process group remained addressable after SIGKILL.');
  }
}

/** Signals every process in one gateway-owned detached stdio group. */
function signalMcpProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Waits for one gateway-owned stdio process group to disappear. */
async function waitForMcpProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-groupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return false;
}

/** Builds the in-memory identity for one exact catalog and credential selection. */
function workerMcpSessionKey(input: WorkerMcpGatewayServerInput): string {
  const credentialDigest = createHash('sha256')
    .update(JSON.stringify(input.credentials ?? {}))
    .digest('hex');
  return `${workerMcpSessionPrefix(input)}${credentialDigest}`;
}

/** Builds the non-secret prefix shared by every credential version of a catalog entry. */
function workerMcpSessionPrefix(input: WorkerMcpGatewayServerInput): string {
  return `${input.workspaceId}:${input.server.id}:${input.server.catalogDigest}:`;
}

/** Builds the credential-bearing HTTP URL only inside the gateway transport boundary. */
function httpEndpoint(input: WorkerMcpGatewayServerInput): URL {
  if (input.server.transport.kind !== 'http') throw new Error('Expected HTTP MCP transport.');
  const endpoint = new URL(input.server.transport.endpoint);
  if (
    hasCredentials(input) &&
    endpoint.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new Error('Credential-bearing remote MCP endpoints must use HTTPS.');
  }
  for (const [name, value] of Object.entries(input.credentials?.query ?? {})) {
    endpoint.searchParams.set(name, value);
  }
  return endpoint;
}

/** Internal marker for an upstream HTTP body that crossed the response byte bound. */
class McpHttpResponseTooLargeError extends Error {
  public constructor(public readonly credentialsMaterialized: boolean) {
    super('MCP HTTP response exceeds the capability response limit.');
    this.name = 'McpHttpResponseTooLargeError';
  }
}

/** Applies the response byte bound and catalog timeout to SDK HTTP effects. */
function boundedMcpFetch(timeoutMs: number, credentialsMaterialized: boolean): typeof fetch {
  return async (request, init) => {
    if (init?.method !== 'DELETE') {
      const response = await fetch(request, init);
      return boundMcpHttpResponse(response, credentialsMaterialized);
    }
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init?.signal) signals.push(init.signal);
    return fetch(request, { ...init, signal: AbortSignal.any(signals) });
  };
}

/** Returns one response whose body fails before buffering more than the MCP byte bound. */
function boundMcpHttpResponse(response: Response, credentialsMaterialized: boolean): Response {
  if (!response.body) return response;
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MCP_PROTOCOL_RESPONSE_MAX_BYTES) {
    void response.body.cancel();
    throw new McpHttpResponseTooLargeError(credentialsMaterialized);
  }
  let observedBytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedBytes += chunk.byteLength;
        if (observedBytes > MCP_PROTOCOL_RESPONSE_MAX_BYTES) {
          controller.error(new McpHttpResponseTooLargeError(credentialsMaterialized));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Rejects a whole result containing a credential or its query sink's serialized wire value. */
function containsCredential(result: unknown, credentials?: WorkerMcpGatewayCredentials): boolean {
  if (!credentials) return false;
  const queryValues = Object.values(credentials.query ?? {});
  const credentialValues = [
    ...Object.values(credentials.environment ?? {}),
    ...Object.values(credentials.headers ?? {}),
    ...queryValues,
    ...queryValues.map((value) =>
      new URLSearchParams({ credential: value }).toString().slice('credential='.length)
    ),
  ].filter(Boolean);
  const pending: unknown[] = [result];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (credentialValues.some((credential) => value.includes(credential))) return true;
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      pending.push(...Object.keys(value), ...Object.values(value));
    }
  }
  return false;
}

/** Returns true when one server operation carries gateway-only credential material. */
function hasCredentials(input: WorkerMcpGatewayServerInput): boolean {
  return (
    Object.keys(input.credentials?.environment ?? {}).length > 0 ||
    Object.keys(input.credentials?.headers ?? {}).length > 0 ||
    Object.keys(input.credentials?.query ?? {}).length > 0
  );
}

/** Returns one hard total timeout for MCP SDK requests. */
function requestOptions(
  timeout: number,
  signal?: AbortSignal
): { maxTotalTimeout: number; signal?: AbortSignal; timeout: number } {
  return { maxTotalTimeout: timeout, ...(signal ? { signal } : {}), timeout };
}

/** Maps native SDK and transport failures to the worker capability vocabulary. */
function normalizeMcpError(error: unknown, operation: 'call' | 'list'): WorkerControlGatewayError {
  if (error instanceof WorkerControlGatewayError) return error;
  if (error instanceof McpHttpResponseTooLargeError) {
    return new WorkerMcpGatewayCallError(
      operation === 'call' ? 'mcp-result-too-large' : 'mcp-server-unavailable',
      operation === 'call'
        ? 'MCP tool result exceeds the capability response limit.'
        : 'MCP server is unavailable.',
      operation === 'call' ? 413 : 503,
      'contacted',
      false,
      error.credentialsMaterialized
    );
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new WorkerControlGatewayError('mcp-timeout', 'MCP request timed out.', 504);
  }
  return new WorkerControlGatewayError(
    operation === 'call' ? 'mcp-call-failed' : 'mcp-server-unavailable',
    operation === 'call' ? 'MCP tool call failed.' : 'MCP server is unavailable.',
    503
  );
}

/** Maps one failed tool request while retaining its upstream effect certainty. */
function normalizeMcpCallError(
  error: unknown,
  upstreamEffect: WorkerMcpUpstreamEffect,
  cancelled = false
): WorkerMcpGatewayCallError {
  if (cancelled) {
    return new WorkerMcpGatewayCallError(
      'mcp-call-failed',
      'MCP tool call failed.',
      503,
      upstreamEffect,
      true
    );
  }
  if (error instanceof McpHttpResponseTooLargeError) {
    if (upstreamEffect === 'not-contacted') {
      return new WorkerMcpGatewayCallError(
        'mcp-server-unavailable',
        'MCP server is unavailable.',
        503,
        'not-contacted',
        false,
        error.credentialsMaterialized
      );
    }
    return new WorkerMcpGatewayCallError(
      'mcp-result-too-large',
      'MCP tool result exceeds the capability response limit.',
      413,
      'contacted',
      false,
      error.credentialsMaterialized
    );
  }
  if (error instanceof WorkerMcpGatewayCallError) return error;
  if (error instanceof WorkerControlGatewayError) {
    return new WorkerMcpGatewayCallError(
      error.code,
      error.message,
      error.status,
      upstreamEffect,
      cancelled
    );
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new WorkerMcpGatewayCallError(
      'mcp-timeout',
      'MCP request timed out.',
      504,
      upstreamEffect,
      cancelled
    );
  }
  return new WorkerMcpGatewayCallError(
    upstreamEffect === 'not-contacted' ? 'mcp-server-unavailable' : 'mcp-call-failed',
    upstreamEffect === 'not-contacted' ? 'MCP server is unavailable.' : 'MCP tool call failed.',
    503,
    upstreamEffect,
    cancelled
  );
}

/** Preserves known effect and credential certainty when session teardown itself is unresolved. */
function cleanupRecoveryError(
  error: unknown,
  fallbackEffect: WorkerMcpUpstreamEffect,
  input: WorkerMcpGatewayServerInput
): WorkerMcpGatewayCallError {
  return new WorkerMcpGatewayCallError(
    'recovery_required',
    'MCP server cleanup recovery is required.',
    409,
    error instanceof WorkerMcpGatewayCallError ? error.upstreamEffect : fallbackEffect,
    false,
    error instanceof WorkerMcpGatewayCallError
      ? error.credentialsMaterialized
      : hasCredentials(input) && fallbackEffect !== 'not-contacted'
  );
}
