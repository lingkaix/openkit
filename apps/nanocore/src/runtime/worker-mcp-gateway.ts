import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Client,
  InMemoryResponseCacheStore,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import {
  ProtocolErrorCode,
  ProtocolError as ServerProtocolError,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { type ResolvedWorkspaceMcpServer, resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { type ActorRef, responsibleUserIdForActor } from '@openkit/protocol';
import Database from 'better-sqlite3';

import { prepareAuditEvent } from '../audit-events.js';
import type { StartedCapabilityCall } from '../capability/usage-ledger.js';
import { composeWorkspaceMcpCatalog, loadResourceCatalog } from '../catalog/resource-catalog.js';
import { OperationError } from '../operation-error.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { ensureWorkspaceLayout } from '../storage/fs-layout.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { isCurrentServerMcpMaterial } from '../vault/server-mcp-authority.js';
import {
  type VaultBackend,
  VaultBackendError,
  vaultSecretMaterialToString,
} from '../vault/vault-backend.js';
import { getVaultGrant, type VaultGrantRecord } from '../vault/vault-grants.js';
import { getVaultReference } from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import { createVaultInjectionPlan } from '../vault-injection-plans.js';
import type { RegisterWorkerMcpRoutesInput } from '../worker-mcp-routes.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';

/** Maximum complete MCP result or explicit discovery observation, including metadata. */
export const MCP_RESULT_MAX_BYTES = 512 * 1024;
/** Worker-facing oversized-result refusal shared by upstream and built-in MCP tools. */
export const MCP_RESULT_TOO_LARGE_MESSAGE =
  'MCP tool result exceeds the capability response limit. Route bulk output through artifacts or the data plane.';
const MCP_PROTOCOL_RESPONSE_MAX_BYTES = 2 * MCP_RESULT_MAX_BYTES;
const MCP_HEALTH_CHECK_MS = 15_000;
const MCP_SESSION_IDLE_MS = 60_000;
const MCP_CATALOG_CACHE_MS = 10_000;
/** Page cap for one auto-aggregated tools/list. Matches the SDK default and fails closed without a partial list. */
const MCP_TOOL_LIST_MAX_PAGES = 64;
const MCP_STDIO_SUPERVISOR =
  "const{spawn}=require('node:child_process');const reap=()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(71)}};process.on('SIGTERM',reap);process.on('disconnect',reap);if(!process.connected||process.ppid!==Number(process.argv[1]))reap();else{const child=spawn(process.argv[2],process.argv.slice(3),{stdio:'inherit'});child.on('error',reap);child.on('exit',reap)}";

/** Product-safe process-local MCP server health. */
export type WorkerMcpServerHealth = 'inactive' | 'starting' | 'ready' | 'degraded' | 'failed';

/** Upstream effect certainty attached to a failed MCP tool call. */
export type WorkerMcpUpstreamEffect = 'not-contacted' | 'contacted' | 'unknown';

/** Numeric failure facts only; upstream bodies and tool content never enter Audit or logs. */
interface WorkerMcpFailureDiagnostics {
  readonly upstreamHttpStatus?: number;
  readonly refusedResultBytes?: number;
}

/** Typed MCP tool failure carrying the upstream effect boundary result. */
export class WorkerMcpGatewayCallError extends WorkerControlGatewayError {
  /** Whether caller cancellation caused this failure. */
  public readonly cancelled: boolean;
  /** Whether gateway-only credentials definitely reached their configured transport sink. */
  public readonly credentialsMaterialized: boolean;
  /** Whether the tool request crossed the upstream effect boundary. */
  public readonly upstreamEffect: WorkerMcpUpstreamEffect;
  /** Actual upstream HTTP response status, when the SDK observed one. */
  public readonly upstreamHttpStatus?: number;
  /** Exact UTF-8 size of a complete semantic result refused by the result bound. */
  public readonly refusedResultBytes?: number;

  /** Creates one bounded gateway call failure. */
  public constructor(
    code: string,
    message: string,
    status: number,
    upstreamEffect: WorkerMcpUpstreamEffect,
    cancelled = false,
    credentialsMaterialized = false,
    diagnostics: WorkerMcpFailureDiagnostics = {}
  ) {
    super(code, message, status);
    this.name = 'WorkerMcpGatewayCallError';
    this.cancelled = cancelled;
    this.credentialsMaterialized = credentialsMaterialized;
    this.upstreamEffect = upstreamEffect;
    if (diagnostics.upstreamHttpStatus !== undefined)
      this.upstreamHttpStatus = diagnostics.upstreamHttpStatus;
    if (diagnostics.refusedResultBytes !== undefined)
      this.refusedResultBytes = diagnostics.refusedResultBytes;
  }
}

/** Gateway-private credentials resolved for one MCP server connection. */
export interface WorkerMcpGatewayCredentials {
  /** Unchanged HTTP bearer material; serializable for private session identity, never a provider. */
  readonly bearer?: string;
  /** Environment variables visible only to a gateway-owned stdio process. */
  readonly environment?: Readonly<Record<string, string>>;
  /** HTTP headers visible only to a gateway-owned HTTP transport. */
  readonly headers?: Readonly<Record<string, string>>;
  /** HTTP query values visible only to a gateway-owned HTTP transport. */
  readonly query?: Readonly<Record<string, string>>;
}

/** Product-safe live MCP tools captured from one initialized server. */
export interface WorkerMcpLiveTools {
  /** Whether this credentialed invocation exchanged upstream bytes, rather than serving a catalog hit. */
  readonly credentialsMaterialized?: boolean;
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
  /** Stops cached or initializing clients carrying any of the exact revoked grants. */
  closeCredentialGrants?(grantIds: readonly string[]): Promise<void>;
  /** Stops every cached client owned by one Workspace. */
  closeWorkspace(workspaceId: string): Promise<void>;
  /** Stops Server-origin sessions while preserving local bindings with the same id. */
  closeServerScope?(workspaceId?: string, mcpId?: string): Promise<void>;
  /** Returns the current product-safe server health. */
  getServerHealth(input: WorkerMcpGatewayServerInput): WorkerMcpServerHealth;
}

/** One resolved Workspace server selected for a gateway operation. */
export interface WorkerMcpGatewayServerInput {
  /** Gateway-private credentials already authorized for this operation. */
  readonly credentials?: WorkerMcpGatewayCredentials;
  /** Trusted grant identities captured when the credentials were resolved; never public input. */
  readonly credentialGrantIds?: readonly string[];
  /** Invocation-only current authority check; never cached or sent to the native writer. */
  readonly recheckAdmission?: () => void | Promise<void>;
  /** Cancellation signal for this operation only. */
  readonly signal?: AbortSignal;
  /** Current strict catalog entry. */
  readonly server: Pick<
    ResolvedWorkspaceMcpServer,
    'id' | 'scope' | 'transport' | 'timeoutMs' | 'packageRootDigest' | 'catalogDigest'
  >;
  /** Trusted one-off preview paths; never accepted from a Worker or public operation payload. */
  readonly temporaryContext?: { readonly dataDirectory: string; readonly packageRoot?: string };
  /** Consuming Workspace, or the isolated invocation partition for a Server preview. */
  readonly workspaceId: string;
}

/** Trusted administrator preview attribution, supplied only by its admitted native owner. */
export interface McpPreviewAuditContext {
  /** Actual admitted human actor; never a fabricated Worker. */
  readonly actor: ActorRef;
  /** Real affected Workspace, or null for Server-owned configuration. */
  readonly workspaceId: string | null;
  /** Current explicit preview invocation identity. */
  readonly requestId: string;
}

/** Creates the existing MCP SDK supervisor, optionally attributing one isolated administrator preview. */
export function createDefaultWorkerMcpGateway(
  coreDb?: CoreDb,
  previewAudit?: McpPreviewAuditContext
): WorkerMcpGateway {
  return new DefaultWorkerMcpGateway(coreDb, previewAudit);
}

/** Prevents an upstream TTL hint from pinning a stale catalog beyond the Gateway's age bound. */
class BoundedMcpCatalogCache extends InMemoryResponseCacheStore {
  public override set(
    key: Parameters<InMemoryResponseCacheStore['set']>[0],
    entry: Parameters<InMemoryResponseCacheStore['set']>[1]
  ): number {
    return super.set(key, {
      ...entry,
      expiresAt: Math.min(entry.expiresAt ?? 0, Date.now() + MCP_CATALOG_CACHE_MS),
    });
  }
}

/** Process-local MCP SDK client supervisor keyed by Workspace catalog identity. */
class DefaultWorkerMcpGateway implements WorkerMcpGateway {
  private closed = false;
  private readonly activeUses = new Map<string, number>();
  private readonly requests = new WeakMap<
    AbortSignal,
    { method: 'tools/list' | 'tools/call'; requestEntered: boolean }
  >();
  private readonly sessions = new Map<string, Promise<WorkerMcpSession>>();
  private readonly sessionInputs = new Map<string, WorkerMcpGatewayServerInput>();
  // The existing health owner keeps only its projection and one content-free publication tail.
  private readonly health = new Map<
    string,
    {
      published?: WorkerMcpServerHealth;
      pending?: { state: WorkerMcpServerHealth; promise: Promise<void> };
    }
  >();
  private readonly healthTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionTeardowns = new Map<string, () => Promise<void>>();
  private readonly teardowns = new Map<string, Promise<void>>();
  private readonly teardownRequired = new Set<string>();

  public constructor(
    private readonly coreDb?: CoreDb,
    private readonly previewAudit?: McpPreviewAuditContext
  ) {}

  /** Lists live tools, following pagination up to the page cap and the result byte bound. */
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
    const cancellationReason = mcpCancellationReason();
    const cancellation = new AbortController();
    const forwardCancellation = () => cancellation.abort(cancellationReason);
    input.signal?.addEventListener('abort', forwardCancellation, { once: true });
    const operationInput = { ...input, signal: cancellation.signal };
    const key = workerMcpSessionKey(operationInput);
    const pending = this.session(operationInput);
    const requestEvidence = { method: 'tools/list' as const, requestEntered: false };
    this.requests.set(cancellation.signal, requestEvidence);
    let connected = false;
    try {
      const session = await pending;
      connected = true;
      const admission = input.recheckAdmission?.();
      if (admission !== undefined) await admission;
      if (
        this.sessions.get(key) !== pending ||
        this.teardownRequired.has(key) ||
        cancellation.signal.aborted
      )
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server is unavailable.',
          503,
          'not-contacted',
          cancellation.signal.aborted,
          hasCredentials(input)
        );
      let page: Awaited<ReturnType<Client['listTools']>>;
      try {
        page = await session.client.listTools(undefined, {
          ...requestOptions(input.server.timeoutMs, cancellation.signal),
          cacheMode: session.client.getServerCapabilities()?.tools?.listChanged ? 'use' : 'refresh',
        });
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
        const normalized = normalizeMcpListError(error, true);
        throw hasCredentials(input)
          ? new WorkerMcpGatewayCallError(
              normalized.code,
              normalized.message,
              normalized.status,
              mcpUpstreamWasContacted(error) ? 'contacted' : 'unknown',
              false,
              true,
              normalized instanceof WorkerMcpGatewayCallError ? normalized : {}
            )
          : normalized;
      }
      if (this.sessions.get(key) !== pending || this.teardownRequired.has(key)) {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server session closed during tool listing.',
          503,
          'contacted',
          false,
          hasCredentials(input)
        );
      }
      const resultBytes = Buffer.byteLength(JSON.stringify(page.tools), 'utf8');
      if (resultBytes > MCP_RESULT_MAX_BYTES) {
        throw new WorkerMcpGatewayCallError(
          'mcp-result-too-large',
          MCP_RESULT_TOO_LARGE_MESSAGE,
          413,
          'contacted',
          false,
          hasCredentials(input),
          { refusedResultBytes: resultBytes }
        );
      }
      const live = {
        ...(hasCredentials(input)
          ? { credentialsMaterialized: requestEvidence.requestEntered }
          : {}),
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
      await this.transition(input, 'ready');
      return live;
    } catch (error) {
      if (this.sessions.get(key) === pending) {
        await this.transition(input, connected ? 'degraded' : 'failed');
        try {
          await this.discard(key, undefined, pending);
        } catch {
          throw cleanupRecoveryError(error, connected ? 'unknown' : 'not-contacted', input);
        }
      }
      throw normalizeMcpListError(error);
    } finally {
      this.requests.delete(cancellation.signal);
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
    const cancellationReason = mcpCancellationReason();
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
        await this.transition(input, 'failed');
        await this.discard(key, undefined, pending);
      }
      try {
        await this.release(key, pending, true);
      } finally {
        input.signal?.removeEventListener('abort', forwardCancellation);
      }
      throw normalizeMcpCallError(error, 'not-contacted', error === cancellationReason);
    }

    const requestEvidence = { method: 'tools/call' as const, requestEntered: false };
    this.requests.set(cancellation.signal, requestEvidence);
    try {
      try {
        const admission = input.recheckAdmission?.();
        if (admission !== undefined) await admission;
      } catch (error) {
        throw normalizeMcpCallError(error, 'not-contacted', error === cancellationReason);
      }
      if (
        this.sessions.get(key) !== pending ||
        this.teardownRequired.has(key) ||
        cancellation.signal.aborted
      ) {
        const refused = new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call failed.',
          503,
          'not-contacted',
          cancellation.signal.aborted,
          hasCredentials(input)
        );
        // No Tool request was entered, but the original process group can still require recovery.
        if (this.sessions.get(key) === pending && this.teardownRequired.has(key)) {
          const teardown = this.teardowns.get(key);
          if (!teardown) throw cleanupRecoveryError(refused, 'not-contacted', input);
          try {
            await teardown;
          } catch {
            throw cleanupRecoveryError(refused, 'not-contacted', input);
          }
        }
        throw refused;
      }
      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        result = await session.client.callTool(
          { arguments: input.arguments, name: input.toolName },
          requestOptions(input.server.timeoutMs, cancellation.signal)
        );
      } catch (error) {
        const normalized = normalizeMcpCallError(
          error,
          requestEvidence.requestEntered
            ? mcpUpstreamWasContacted(error)
              ? 'contacted'
              : 'unknown'
            : 'not-contacted',
          error === cancellationReason
        );
        const delivered = hasCredentials(input) && normalized.upstreamEffect === 'contacted';
        const failure = delivered
          ? new WorkerMcpGatewayCallError(
              normalized.code,
              normalized.message,
              normalized.status,
              normalized.upstreamEffect,
              normalized.cancelled,
              true,
              normalized
            )
          : normalized;
        if (this.sessions.get(key) === pending) {
          await this.transition(input, 'degraded');
          try {
            await this.discard(key, undefined, pending);
          } catch {
            throw cleanupRecoveryError(failure, failure.upstreamEffect, input);
          }
        }
        throw failure;
      }
      if (this.sessions.get(key) !== pending || this.teardownRequired.has(key)) {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call completed after its session closed.',
          502,
          'contacted',
          false,
          hasCredentials(input)
        );
      }
      const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (resultBytes > MCP_RESULT_MAX_BYTES) {
        throw new WorkerMcpGatewayCallError(
          'mcp-result-too-large',
          MCP_RESULT_TOO_LARGE_MESSAGE,
          413,
          'contacted',
          false,
          hasCredentials(input),
          { refusedResultBytes: resultBytes }
        );
      }
      if (containsCredential(result, input.credentials)) {
        await this.transition(input, 'degraded');
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
      await this.transition(input, 'ready');
      if (result.isError === true) {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call failed.',
          502,
          'contacted',
          false,
          hasCredentials(input)
        );
      }
      return result;
    } finally {
      this.requests.delete(cancellation.signal);
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
    // A concurrent explicit close can publish without a cached transport. Drain that same owner too.
    for (const entry of this.health.values()) {
      while (entry.pending) await entry.pending.promise.catch(() => undefined);
    }
    this.health.clear();
  }

  /** Stops every cached session for one Workspace server authority. */
  public async closeServer(input: WorkerMcpGatewayServerInput): Promise<void> {
    const keys = [...this.sessions.keys()].filter((key) => {
      const cached = this.sessionInputs.get(key);
      return (
        cached?.workspaceId === input.workspaceId &&
        cached.server.id === input.server.id &&
        cached.server.scope === input.server.scope
      );
    });
    await Promise.all(keys.map((key) => this.discard(key, 'inactive')));
    if (keys.length === 0) await this.transition(input, 'inactive');
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
        cached.server.scope === input.server.scope &&
        (this.activeUses.get(key) ?? 0) === 0
      );
    });
    await Promise.all(keys.map((key) => this.discard(key, 'inactive')));
  }

  /** Joins every affected physical teardown, including failures, before reporting revocation. */
  public async closeCredentialGrants(grantIds: readonly string[]): Promise<void> {
    const revoked = new Set(grantIds);
    const keys = [...this.sessionInputs.entries()]
      .filter(([, cached]) => cached.credentialGrantIds?.some((id) => revoked.has(id)))
      .map(([key]) => key);
    const results = await Promise.allSettled(keys.map((key) => this.discard(key, 'inactive')));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
  }

  /** Stops every cached session before its Workspace can be deleted. */
  public async closeWorkspace(workspaceId: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter(
      (key) => this.sessionInputs.get(key)?.workspaceId === workspaceId
    );
    await Promise.all(keys.map((key) => this.discard(key, 'inactive')));
  }

  /** Fences shared sessions across consumers without closing Workspace-origin collisions. */
  public async closeServerScope(workspaceId?: string, mcpId?: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter((key) => {
      const cached = this.sessionInputs.get(key);
      return (
        cached?.server.scope === 'server' &&
        (workspaceId === undefined || cached.workspaceId === workspaceId) &&
        (mcpId === undefined || cached.server.id === mcpId)
      );
    });
    await Promise.all(keys.map((key) => this.discard(key, 'inactive')));
  }

  /** Reads health without contacting the server. */
  public getServerHealth(input: WorkerMcpGatewayServerInput): WorkerMcpServerHealth {
    return this.health.get(workerMcpSessionPrefix(input))?.published ?? 'inactive';
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
      // Register the original pending owner before starting can wait for native evidence.
      pending = Promise.resolve().then(() => this.connect(input));
      this.sessions.set(key, pending);
      const sessionInput = {
        ...input,
        ...(input.credentialGrantIds ? { credentialGrantIds: [...input.credentialGrantIds] } : {}),
      };
      delete sessionInput.recheckAdmission;
      this.sessionInputs.set(key, sessionInput);
      const started = pending;
      void started.then(
        (session) => {
          if (this.sessions.get(key) === started && !this.teardownRequired.has(key)) {
            this.scheduleHealthCheck(key, sessionInput, started, session.client);
          }
        },
        () => undefined
      );
    }
    return pending;
  }

  /**
   * Separates cached catalog reads from actual list exchanges and proves pre-request Tool refusal.
   * Entry alone preserves the existing Tool contacted/unknown classification; it is not send proof.
   */
  private observeRequestEntry(client: Client): void {
    const requests = this.requests;
    // A Proxy preserves both public overloads, the receiver and the original Promise/error.
    client.request = new Proxy(client.request, {
      apply(target, receiver, args: unknown[]) {
        const request = args[0];
        const options = args.length > 1 ? args[args.length - 1] : undefined;
        if (
          typeof request === 'object' &&
          request !== null &&
          'method' in request &&
          (request.method === 'tools/call' || request.method === 'tools/list') &&
          typeof options === 'object' &&
          options !== null &&
          'signal' in options &&
          options.signal instanceof AbortSignal
        ) {
          const evidence = requests.get(options.signal);
          if (evidence?.method === request.method) evidence.requestEntered = true;
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  }

  /** Connects one catalog-declared transport through the official MCP SDK. */
  private async connect(operationInput: WorkerMcpGatewayServerInput): Promise<WorkerMcpSession> {
    // Transport callbacks outlive this invocation; retain no caller admission closure in them.
    const input = { ...operationInput };
    delete input.recheckAdmission;
    if (
      (input.credentials?.bearer !== undefined && input.server.transport.kind !== 'http') ||
      Object.values(input.credentials?.environment ?? {}).some((value) => value.includes('\0'))
    ) {
      throw new WorkerMcpGatewayCallError(
        'mcp-server-unavailable',
        'MCP credential material was rejected.',
        503,
        'not-contacted'
      );
    }
    const headers = input.server.transport.kind === 'http' ? httpHeaders(input) : undefined;
    const key = workerMcpSessionKey(input);
    await this.transition(input, 'starting');
    const admission = operationInput.recheckAdmission?.();
    if (admission !== undefined) await admission;
    if (this.closed || this.teardownRequired.has(key) || input.signal?.aborted) {
      throw new WorkerMcpGatewayCallError(
        'mcp-server-unavailable',
        'MCP server is unavailable.',
        503,
        'not-contacted',
        input.signal?.aborted === true
      );
    }
    const client = new Client(
      { name: 'openkit-nanocore', version: '1.0.0' },
      {
        listMaxPages: MCP_TOOL_LIST_MAX_PAGES,
        versionNegotiation: { mode: 'auto' },
        defaultCacheTtlMs: MCP_CATALOG_CACHE_MS,
        responseCacheStore: new BoundedMcpCatalogCache(),
        listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => undefined } },
      }
    );
    this.observeRequestEntry(client);
    let transportClosed = false;
    client.onclose = () => {
      transportClosed = true;
      if (this.teardownRequired.has(key)) return;
      const pending = this.sessions.get(key);
      if (!pending) return;
      void pending.then(
        async (session) => {
          if (this.sessions.get(key) !== pending || session.client !== client) return;
          await this.transition(input, 'degraded');
          await this.discard(key, undefined, pending).catch(() => this.transition(input, 'failed'));
        },
        () => undefined
      );
    };
    let transport: StdioServerTransport | StreamableHTTPClientTransport;
    let processGroupId: number | null = null;
    if (input.server.transport.kind === 'stdio') {
      const pluginEnvironment = pluginOwnedEnvironment(this.coreDb, input);
      if (pluginEnvironment.PLUGIN_DATA) {
        mkdirSync(pluginEnvironment.PLUGIN_DATA, { recursive: true });
      }
      const cwdSource =
        input.server.transport.cwd ??
        pluginEnvironment.PLUGIN_ROOT ??
        input.temporaryContext?.dataDirectory;
      const child = spawn(
        process.execPath,
        [
          '-e',
          MCP_STDIO_SUPERVISOR,
          String(process.pid),
          input.server.transport.command,
          ...input.server.transport.args.map((argument) =>
            expandPluginPlaceholders(argument, pluginEnvironment)
          ),
        ],
        {
          detached: true,
          env: {
            ...getDefaultEnvironment(),
            ...Object.fromEntries(
              Object.entries(input.server.transport.environmentValues ?? {}).map(
                ([name, value]) => [name, expandPluginPlaceholders(value, pluginEnvironment)]
              )
            ),
            ...pluginEnvironment,
            ...input.credentials?.environment,
          },
          ...(cwdSource ? { cwd: expandPluginPlaceholders(cwdSource, pluginEnvironment) } : {}),
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
        ...(input.credentials?.bearer !== undefined
          ? { authProvider: { token: async () => input.credentials!.bearer } }
          : {}),
        onInsufficientScope: 'throw',
        requestInit: {
          headers: headers!,
        },
      });
    }
    // The SDK's optional sessionId declaration conflicts with exactOptionalPropertyTypes.
    const connection = client.connect(
      transport as Parameters<Client['connect']>[0],
      requestOptions(input.server.timeoutMs, input.signal)
    );
    this.sessionTeardowns.set(key, () =>
      closeMcpSession(client, transport, processGroupId, this.previewAudit !== undefined)
    );
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
        (processGroupId !== null || error instanceof SdkError || mcpUpstreamWasContacted(error))
      ) {
        const normalized = normalizeMcpListError(error);
        const cancelled = input.signal?.aborted && input.signal.reason === error;
        throw new WorkerMcpGatewayCallError(
          normalized.code,
          normalized.message,
          normalized.status,
          mcpUpstreamWasContacted(error) ? 'contacted' : 'unknown',
          cancelled,
          true,
          normalized instanceof WorkerMcpGatewayCallError ? normalized : {}
        );
      }
      throw error;
    }
  }

  /** Fences and closes one cached session, retaining cleanup ownership until closure is proved. */
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
    // The cached promise retains cleanup ownership, but late results must not restore its authority or health.
    this.teardownRequired.add(key);
    const teardown = Promise.resolve().then(async () => {
      // Close the registered transport first: initialization may be waiting on that same child.
      await this.sessionTeardowns.get(key)?.();
      await pending?.catch(() => null);
      // Retain the existing input and teardown fence until the original close publication settles.
      if (input && nextHealth) await this.transition(input, nextHealth);
      // Late failure settlement still belongs to this teardown, not to a detached Audit lifetime.
      if (input) {
        const entry = this.health.get(workerMcpSessionPrefix(input));
        while (entry?.pending) await entry.pending.promise.catch(() => undefined);
      }
      this.sessions.delete(key);
      this.sessionInputs.delete(key);
      this.sessionTeardowns.delete(key);
      this.activeUses.delete(key);
      this.teardownRequired.delete(key);
    });
    this.teardowns.set(key, teardown);
    try {
      await teardown;
    } finally {
      if (this.teardowns.get(key) === teardown) this.teardowns.delete(key);
    }
  }

  /** Probes one still-current live session and degrades it when the upstream disappears. */
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
      await probeMcpSession(client, input.server.timeoutMs);
    } catch {
      if (this.sessions.get(key) !== pending) return;
      await this.transition(input, 'degraded');
      await this.discard(key, undefined, pending);
      return;
    }
    if (this.sessions.get(key) === pending && !this.teardownRequired.has(key)) {
      await this.transition(input, 'ready');
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
    if (hasCredentials(input)) return;
    const previous = this.healthTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      void this.checkHealth(key, input, pending, client).catch(() => {
        if (this.sessions.get(key) === pending) return this.transition(input, 'failed');
      });
    }, MCP_HEALTH_CHECK_MS);
    timer.unref();
    this.healthTimers.set(key, timer);
  }

  /** Reuses idle HTTP clients; credential-bearing stdio processes retain immediate cleanup. */
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
    if (
      input &&
      hasCredentials(input) &&
      input.server.transport.kind === 'stdio' &&
      closeCredentialsNow
    ) {
      try {
        await this.discard(key, 'inactive', pending);
      } catch (error) {
        await this.transition(input, 'failed');
        throw cleanupRecoveryError(error, 'contacted', input);
      }
      return;
    }
    const timer = setTimeout(
      () => {
        void this.discard(key, 'inactive', pending).catch(async () => {
          if (input) await this.transition(input, 'failed');
        });
      },
      input && hasCredentials(input) && input.server.transport.kind === 'stdio'
        ? 0
        : MCP_SESSION_IDLE_MS
    );
    timer.unref();
    this.idleTimers.set(key, timer);
  }

  /** Records changed health under the consuming Workspace or the actual administrator preview actor. */
  private async transition(
    input: WorkerMcpGatewayServerInput,
    state: WorkerMcpServerHealth
  ): Promise<void> {
    const key = workerMcpSessionPrefix(input);
    let entry = this.health.get(key);
    if (!entry) {
      entry = {};
      this.health.set(key, entry);
    }
    let publication = entry.pending;
    if (!publication && entry.published === state) return;
    if (!publication || publication.state !== state) {
      const predecessor = publication?.promise;
      const coreDb = this.coreDb;
      const workspaceId = input.workspaceId;
      const preview = this.previewAudit !== undefined;
      let event: ReturnType<typeof prepareAuditEvent> | undefined;
      let preparationError: unknown;
      try {
        if (!coreDb?.sqlite.open) throw new Error('MCP lifecycle Audit owner is unavailable.');
        event = prepareAuditEvent({
          ...(this.previewAudit ?? { workspaceId }),
          action: `mcp.server.lifecycle.${state}`,
          category: 'capability',
          errorCode: state === 'degraded' || state === 'failed' ? 'mcp-server-unavailable' : null,
          outcome: state === 'degraded' || state === 'failed' ? 'failed' : 'succeeded',
          resource: `mcp-server:${input.server.id}`,
          severity: state === 'degraded' || state === 'failed' ? 'warning' : 'info',
          summary: preview
            ? `Temporary MCP preview server entered ${state}${hasCredentials(input) && state === 'starting' ? ' with gateway-only credentials' : ''}.`
            : `MCP server ${input.server.id} entered ${state}${hasCredentials(input) && state === 'starting' ? ' with gateway-only credentials' : ''}.`,
        });
      } catch (error) {
        preparationError = error;
      }
      // Only adjacent equal states join. Distinct states retain their original order and identity.
      // Observing a predecessor's failure orders this different event; its callers keep that rejection.
      const promise = (predecessor ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if (!coreDb || !event) throw preparationError;
          const preparedEvent = event;
          // This closure retains only the original prepared Audit and storage scope, never input.
          const db = preview ? coreDb : openWorkspaceDb(coreDb.dataRoot, workspaceId);
          try {
            const client = getControlStoreWorkerClient();
            await client.runOperation(() =>
              client.standaloneAudit(db, {
                ...(preview ? {} : { workspaceId }),
                stage: `mcp.server.lifecycle.${state}`,
                event: preparedEvent,
              })
            );
          } finally {
            if (db !== coreDb) db.sqlite.close();
          }
        });
      publication = { state, promise };
      entry.pending = publication;
    }
    try {
      try {
        // The shared promise preserves the raw failure. Each caller applies its own original fence.
        await publication.promise;
      } catch {
        if (state === 'starting' && hasCredentials(input)) {
          throw new WorkerControlGatewayError(
            'mcp-server-unavailable',
            'MCP credential-bearing server start could not be audited.',
            503
          );
        }
      }
      // Best-effort failure retains its original health semantics, but never publishes before settlement.
      if (this.health.get(key) === entry) entry.published = state;
    } finally {
      // Startup retains this same result only through the existing initialization lifetime.
      // A different credential key must not mistake best-effort failed startup for an ACK.
      // The original ready/failed/inactive transition supersedes it; close joins that transition.
      if (entry.pending === publication && state !== 'starting') delete entry.pending;
    }
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
  processGroupId: number | null,
  temporaryPreview: boolean
): Promise<void> {
  if (transport instanceof StreamableHTTPClientTransport) {
    try {
      await transport.terminateSession();
    } catch (error) {
      // A one-off administrator preview must prove its temporary upstream session ended.
      if (temporaryPreview) throw error;
      // Remote session deletion is best effort; local transport closure still owns cleanup proof.
      try {
        console.warn(
          JSON.stringify({
            event: 'worker.mcp.session-termination-failed',
            method: 'DELETE',
            cleanup: 'best-effort',
          })
        );
      } catch {
        // A diagnostic sink failure cannot turn cleanup into a Tool or Turn failure.
      }
    }
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

/** Signals one gateway-owned detached stdio group.
 *
 * A refused group signal is not absence. Only SIGTERM is repeated to the
 * leader, so its handler can reap the group. SIGKILL is never sent to the leader.
 */
function signalMcpProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  const group = deliverMcpSignal(-groupId, signal);
  if (group === 'delivered' || group === 'gone') return;
  if (signal === 'SIGTERM') deliverMcpSignal(groupId, 'SIGTERM');
}

/** Waits for one gateway-owned stdio process group to disappear. */
async function waitForMcpProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mcpProcessGroupExited(groupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return mcpProcessGroupExited(groupId);
}

/** Reports whether the process group is proved gone.
 *
 * Absence is only `kill(-groupId, 0)` returning ESRCH. A refused group signal
 * is not absence. The wait yields between checks, so a zombie-leader refusal
 * can clear to ESRCH once that leader is reaped.
 */
function mcpProcessGroupExited(groupId: number): boolean {
  return deliverMcpSignal(-groupId, 0) === 'gone';
}

type McpSignalDelivery = 'delivered' | 'gone' | 'refused';

/** Delivers one signal. ESRCH means that pid is gone. EPERM is a refusal, not absence. */
function deliverMcpSignal(pid: number, signal: NodeJS.Signals | 0): McpSignalDelivery {
  try {
    process.kill(pid, signal);
    return 'delivered';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'refused';
    throw error;
  }
}

/** Builds the in-memory identity for one exact catalog and credential selection. */
function workerMcpSessionKey(input: WorkerMcpGatewayServerInput): string {
  const credentialDigest = createHash('sha256')
    .update(
      JSON.stringify([input.credentials ?? {}, [...new Set(input.credentialGrantIds ?? [])].sort()])
    )
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

/** Replaces ordinary headers case-insensitively and refuses credential bytes the HTTP sink would alter or reject. */
function httpHeaders(input: WorkerMcpGatewayServerInput): Headers {
  if (input.server.transport.kind !== 'http') throw new Error('Expected HTTP MCP transport.');
  const headers = new Headers(input.server.transport.headers);
  const injected = Object.entries(input.credentials?.headers ?? {});
  const bearer = input.credentials?.bearer;
  if (bearer !== undefined) {
    if (bearer.length === 0) {
      throw new WorkerMcpGatewayCallError(
        'mcp-server-unavailable',
        'MCP credential material was rejected.',
        503,
        'not-contacted'
      );
    }
    // Validate the complete value here; the SDK alone constructs and sends this header.
    injected.push(['Authorization', `Bearer ${bearer}`]);
  }
  for (const [name, value] of injected) {
    try {
      if (new Headers([[name, value]]).get(name) !== value) throw new Error();
    } catch {
      throw new WorkerMcpGatewayCallError(
        'mcp-server-unavailable',
        'MCP credential material was rejected.',
        503,
        'not-contacted'
      );
    }
    if (bearer === undefined || name.toLowerCase() !== 'authorization') headers.set(name, value);
  }
  if (bearer !== undefined) headers.delete('authorization');
  return headers;
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
    const nextInit = { ...init, redirect: 'error' as RequestRedirect };
    const target =
      request instanceof Request ? new Request(request, { redirect: 'error' }) : request;
    if (init?.method !== 'DELETE') {
      const response = await fetch(target, nextInit);
      return boundMcpHttpResponse(response, credentialsMaterialized);
    }
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init?.signal) signals.push(init.signal);
    return fetch(target, { ...nextInit, signal: AbortSignal.any(signals) });
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
  // This set is Gateway-private live memory, never a catalog field or evidence payload.
  const credentialValues = new Set(
    [
      ...(credentials.bearer !== undefined
        ? [credentials.bearer, `Bearer ${credentials.bearer}`]
        : []),
      ...Object.values(credentials.environment ?? {}),
      ...Object.values(credentials.headers ?? {}),
      ...queryValues,
      ...queryValues.map((value) =>
        new URLSearchParams({ credential: value }).toString().slice('credential='.length)
      ),
    ].filter(Boolean)
  );
  const pending: unknown[] = [result];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      for (const credential of credentialValues) {
        if (value.includes(credential)) return true;
      }
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      pending.push(...Object.keys(value), ...Object.values(value));
    }
  }
  return false;
}

/** Core-owned plugin paths injected after configured env and before Vault, pinned to the resolved package-root digest. */
function pluginOwnedEnvironment(
  coreDb: CoreDb | undefined,
  input: WorkerMcpGatewayServerInput
): Record<string, string> {
  if (input.temporaryContext)
    return {
      PLUGIN_DATA: input.temporaryContext.dataDirectory,
      ...(input.temporaryContext.packageRoot
        ? { PLUGIN_ROOT: input.temporaryContext.packageRoot }
        : {}),
    };
  if (!coreDb) return {};
  const catalog = loadResourceCatalog(
    coreDb.dataRoot,
    input.server.scope === 'server'
      ? { kind: 'server' }
      : { kind: 'workspace', workspaceId: input.workspaceId }
  );
  const binding = catalog.mcp.bindings.find((item) => item.entryId === input.server.id);
  if (!binding) return {};
  const layout = ensureWorkspaceLayout(coreDb.dataRoot, input.workspaceId);
  mkdirSync(join(layout.catalogMcpData, binding.packageDataKey), { recursive: true });
  const environment: Record<string, string> = {
    PLUGIN_DATA: join(layout.catalogMcpData, binding.packageDataKey),
  };
  if (input.server.packageRootDigest && input.server.scope !== 'server') {
    const plugin = catalog.plugins.versions.find(
      (item) => item.digest === input.server.packageRootDigest
    );
    if (plugin) {
      environment.PLUGIN_ROOT = join(
        layout.catalogPluginSnapshots,
        plugin.entryId,
        plugin.digest.slice('sha256:'.length)
      );
    }
  }
  return environment;
}

/** Expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` once in stdio args, env values, and cwd. */
function expandPluginPlaceholders(
  value: string,
  environment: Readonly<Record<string, string>>
): string {
  let expanded = value;
  for (const name of ['PLUGIN_ROOT', 'PLUGIN_DATA'] as const) {
    const replacement = environment[name];
    if (!replacement) continue;
    expanded = expanded.replaceAll(`\${${name}}`, replacement);
  }
  return expanded;
}

/** Returns true when one server operation carries gateway-only credential material. */
function hasCredentials(input: WorkerMcpGatewayServerInput): boolean {
  return (
    input.credentials?.bearer !== undefined ||
    Object.keys(input.credentials?.environment ?? {}).length > 0 ||
    Object.keys(input.credentials?.headers ?? {}).length > 0 ||
    Object.keys(input.credentials?.query ?? {}).length > 0
  );
}

/** Abort reason the SDK rethrows by identity when the caller cancels one in-flight request. */
function mcpCancellationReason(): SdkError {
  return new SdkError(SdkErrorCode.RequestTimeout, 'MCP caller cancelled request.');
}

/** Recognizes protocol/HTTP errors; Tool callers must first exclude proved pre-request failures. */
function mcpUpstreamWasContacted(error: unknown): boolean {
  return error instanceof ProtocolError || error instanceof SdkHttpError;
}

/**
 * Pings a legacy session.
 * A 2026-07-28 session cannot answer ping. That era's request registry requires
 * `server/discover` and gives it no capability precondition, so the probe sends
 * that request under the same server timeout.
 */
async function probeMcpSession(client: Client, timeoutMs: number): Promise<void> {
  try {
    await client.ping(requestOptions(timeoutMs));
  } catch (error) {
    if (
      error instanceof SdkError &&
      error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion
    ) {
      await client.discover(requestOptions(timeoutMs));
      return;
    }
    throw error;
  }
}

/** Returns whether one SDK failure is a request timeout rather than a caller cancellation identity. */
function isMcpTimeout(error: unknown): boolean {
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
}

/** Returns one hard total timeout for MCP SDK requests. */
function requestOptions(
  timeout: number,
  signal?: AbortSignal
): { maxTotalTimeout: number; signal?: AbortSignal; timeout: number } {
  return { maxTotalTimeout: timeout, ...(signal ? { signal } : {}), timeout };
}

/**
 * Maps native SDK and transport failures of a connect or tool-list request to the worker
 * capability vocabulary. Tool calls use `normalizeMcpCallError`, which also retains upstream
 * effect certainty. Only an actual Tool listing admits the semantic result-size code;
 * an oversized initialization response remains a server-availability failure.
 *
 * @param error Upstream request failure.
 * @param toolList Whether the failed request was tools/list after initialization.
 * @returns Existing typed capability failure.
 */
function normalizeMcpListError(
  error: unknown,
  toolList = false
): WorkerControlGatewayError | OperationError {
  // A caller-owned admission refusal is not an SDK failure or evidence of contact.
  if (error instanceof WorkerControlGatewayError || error instanceof OperationError) return error;
  if (error instanceof McpHttpResponseTooLargeError) {
    return new WorkerMcpGatewayCallError(
      toolList ? 'mcp-result-too-large' : 'mcp-server-unavailable',
      toolList ? MCP_RESULT_TOO_LARGE_MESSAGE : 'MCP server is unavailable.',
      toolList ? 413 : 503,
      'contacted',
      false,
      error.credentialsMaterialized
    );
  }
  if (isMcpTimeout(error)) {
    return new WorkerControlGatewayError('mcp-timeout', 'MCP request timed out.', 504);
  }
  const diagnostics = mcpHttpFailureDiagnostics(error);
  if (diagnostics.upstreamHttpStatus !== undefined)
    return new WorkerMcpGatewayCallError(
      'mcp-server-unavailable',
      'MCP server is unavailable.',
      503,
      'not-contacted',
      false,
      false,
      diagnostics
    );
  return new WorkerControlGatewayError('mcp-server-unavailable', 'MCP server is unavailable.', 503);
}

/** Captures the SDK's typed status and logs rate limits even before a Tool Call exists. */
function mcpHttpFailureDiagnostics(error: unknown): WorkerMcpFailureDiagnostics {
  if (error instanceof WorkerMcpGatewayCallError) return error;
  if (
    !(error instanceof SdkHttpError) ||
    !Number.isInteger(error.status) ||
    error.status < 100 ||
    error.status > 599
  )
    return {};
  if (error.status === 429) {
    try {
      console.warn(
        JSON.stringify({
          severityText: 'WARN',
          body: 'MCP upstream rate limit.',
          attributes: {
            'openkit.error.code': 'mcp.upstream_rate_limited',
            'http.response.status_code': 429,
          },
        })
      );
    } catch {
      // A diagnostic sink failure cannot change contact certainty or cause an upstream retry.
    }
  }
  return { upstreamHttpStatus: error.status };
}

/** Maps one failed tool request while retaining its upstream effect certainty. */
function normalizeMcpCallError(
  error: unknown,
  upstreamEffect: WorkerMcpUpstreamEffect,
  cancelled = false
): WorkerMcpGatewayCallError {
  const diagnostics = mcpHttpFailureDiagnostics(error);
  if (cancelled) {
    return new WorkerMcpGatewayCallError(
      'mcp-call-failed',
      'MCP tool call failed.',
      503,
      upstreamEffect,
      true,
      false,
      diagnostics
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
      MCP_RESULT_TOO_LARGE_MESSAGE,
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
  if (isMcpTimeout(error)) {
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
    cancelled,
    false,
    diagnostics
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
      : hasCredentials(input) && fallbackEffect !== 'not-contacted',
    error instanceof WorkerMcpGatewayCallError ? error : {}
  );
}

/** Returns the closed worker-visible denial for a consumed or ambiguous Approval. */
export function mcpDeniedError(): ServerProtocolError {
  return new ServerProtocolError(ProtocolErrorCode.InvalidRequest, 'MCP tool call was denied.', {
    code: 'mcp-denied',
  });
}

/** Keeps trusted private failure identity separate from public denial and cleanup, without exception content. */
function reportMcpCredentialFailure(error: unknown, stage: 'resolve' | 'cleanup'): void {
  try {
    const cause =
      error instanceof Database.SqliteError
        ? { errorClass: 'SqliteError', code: error.code }
        : error instanceof ControlStoreWorkerError
          ? { errorClass: 'ControlStoreWorkerError', code: error.code }
          : error instanceof VaultBackendError
            ? { errorClass: 'VaultBackendError', code: error.code }
            : { errorClass: error instanceof OperationError ? 'OperationError' : 'other' };
    console.error(JSON.stringify({ event: 'worker.mcp.credential-failure', stage, ...cause }));
  } catch {
    // Diagnostic sink failure cannot change credential denial or cleanup certainty.
  }
}

/** Resolves every current Vault grant into the exact catalog-declared transport sink. */
export async function resolveWorkerMcpCredentials(input: {
  /** Rechecks the caller's existing live or captured authority after the Main writer hold settles. */
  readonly current?: () => boolean;
  readonly call: Pick<StartedCapabilityCall, 'id'>;
  readonly environmentPackage: {
    readonly snapshotId: string;
    readonly scope: {
      readonly workspaceId: string;
      readonly agentSessionId: string;
      readonly triggerActor?: ActorRef;
    };
    readonly agent: { readonly agentId: string };
  };
  readonly input: Pick<
    RegisterWorkerMcpRoutesInput,
    'coreDb' | 'workerMcpGateway' | 'vaultUnlockState'
  > & { readonly vaultBackend?: () => VaultBackend };
  readonly operation: 'mcp.list-tools' | 'mcp.call-tool';
  readonly resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  readonly workspaceDb: WorkspaceDb;
}): Promise<{
  credentials?: WorkerMcpGatewayCredentials;
  injections: PendingMcpVaultInjection[];
}> {
  assertCurrentSharedMcpBinding(input);
  if (input.resolved.credentialBindings.length === 0) return { injections: [] };
  if (
    input.resolved.scope === 'server' &&
    (!input.environmentPackage.scope.triggerActor ||
      !responsibleUserIdForActor(input.environmentPackage.scope.triggerActor))
  ) {
    throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
  }
  const coreDb = input.input.coreDb!;
  const environment: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  let bearer: string | undefined;
  const injections: PendingMcpVaultInjection[] = [];

  try {
    if (!input.input.vaultUnlockState && !input.input.vaultBackend)
      throw new Error('Vault is unavailable.');
    if (input.current?.() === false) throw mcpDeniedError();
    assertCurrentSharedMcpBinding(input);
    for (const binding of input.resolved.credentialBindings) {
      const grant = getVaultGrant(coreDb, binding.vaultGrantId);
      const reference = grant ? getVaultReference(coreDb, grant.vaultReferenceId) : null;
      assertCurrentMcpVaultAuthority(input, grant, reference);
      const planId = mcpVaultRecordId('plan', input, binding.slot, grant!.grantId);
      const receiptId = mcpVaultRecordId('receipt', input, binding.slot, grant!.grantId);
      const now = new Date().toISOString();
      await createVaultInjectionPlan(coreDb, {
        backendCapabilityRequirement: `mcp-gateway:${input.resolved.transport.kind}`,
        capabilityId: input.operation,
        expirationBehavior: grant!.expiresAt ? `expires-at:${grant!.expiresAt}` : 'grant-lifetime',
        grantId: grant!.grantId,
        injectionVisibility: 'gateway-only',
        packageSnapshotId: input.environmentPackage.snapshotId,
        planId,
        redactionRule: 'exact-resolved-material',
        revocationBehavior: 'close-gateway-session',
        now: () => now,
      });
      if (input.current?.() === false) throw mcpDeniedError();
      assertCurrentSharedMcpBinding(input);
      assertCurrentMcpVaultAuthority(
        input,
        getVaultGrant(coreDb, binding.vaultGrantId),
        getVaultReference(coreDb, reference!.referenceId)
      );
      const backend = input.input.vaultBackend?.() ?? input.input.vaultUnlockState!.backend();
      if (
        reference!.backendKind !== backend.kind ||
        (input.resolved.scope === 'server' && !isCurrentServerMcpMaterial(backend, reference!))
      )
        throw new Error('Vault backend mismatch.');
      const material = await createVaultUseAuditedBackend({
        agentSessionId: input.environmentPackage.scope.agentSessionId,
        backend,
        capabilityCallId: input.call.id,
        db: input.resolved.scope === 'server' ? coreDb : input.workspaceDb,
        grantId: grant!.grantId,
        ownerScope: input.resolved.scope === 'server' ? 'server' : 'workspace',
        planId,
        resolvingPath: 'grant',
        ...(input.resolved.scope === 'server'
          ? {
              consumerWorkspaceId: input.environmentPackage.scope.workspaceId,
              ...(input.environmentPackage.scope.triggerActor
                ? { actor: input.environmentPackage.scope.triggerActor }
                : {}),
            }
          : { workspaceId: input.environmentPackage.scope.workspaceId }),
      }).resolve({
        referenceId: reference!.referenceId,
        version: reference!.currentVersion,
      });
      if (input.current?.() === false) throw mcpDeniedError();
      assertCurrentSharedMcpBinding(input);
      assertCurrentMcpVaultAuthority(
        input,
        getVaultGrant(coreDb, binding.vaultGrantId),
        getVaultReference(coreDb, reference!.referenceId)
      );
      if (
        getVaultReference(coreDb, reference!.referenceId)?.currentVersion !==
        reference!.currentVersion
      )
        throw new Error('MCP Vault authority is not current.');
      const value = vaultSecretMaterialToString(material);
      if (binding.presentation === 'bearer') {
        if (value.length === 0) throw new Error('Empty MCP bearer credential.');
        bearer = value;
      }
      if (binding.sink.kind === 'env') environment[binding.sink.name] = value;
      if (binding.sink.kind === 'header' && binding.presentation !== 'bearer') {
        headers[binding.sink.name] = value;
      }
      if (binding.sink.kind === 'query') query[binding.sink.name] = value;
      injections.push({
        backendSummary: `mcp-gateway:${input.resolved.transport.kind}:${binding.sink.kind}`,
        grant,
        injectedAt: now,
        planId,
        receiptId,
        referenceVersion: reference!.currentVersion,
      });
    }
  } catch (error) {
    reportMcpCredentialFailure(error, 'resolve');
    try {
      await input.input.workerMcpGateway.closeServer({
        server: input.resolved,
        workspaceId: input.environmentPackage.scope.workspaceId,
      });
    } catch (cleanupError) {
      reportMcpCredentialFailure(cleanupError, 'cleanup');
      throw new WorkerControlGatewayError(
        'recovery_required',
        'MCP server cleanup recovery is required.',
        409
      );
    }
    throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
  }

  return {
    credentials: {
      ...(bearer !== undefined ? { bearer } : {}),
      ...(Object.keys(environment).length ? { environment } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(query).length ? { query } : {}),
    },
    injections,
  };
}

/** Re-derives Server origin and exact selection from canonical catalogs at credential and effect boundaries. */
export function assertCurrentSharedMcpBinding(input: {
  readonly input: { readonly coreDb?: CoreDb };
  readonly resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  readonly environmentPackage: { readonly scope: { readonly workspaceId: string } };
}): void {
  if (input.resolved.scope !== 'server') return;
  if (!input.input.coreDb) throw new Error('Server catalog authority is unavailable.');
  const catalog = composeWorkspaceMcpCatalog({
    dataRoot: input.input.coreDb.dataRoot,
    workspaceId: input.environmentPackage.scope.workspaceId,
  });
  const current = resolveWorkspaceMcpServer({ catalog, serverId: input.resolved.id });
  if (
    current.scope !== 'server' ||
    !current.enabled ||
    current.catalogDigest !== input.resolved.catalogDigest
  ) {
    throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
  }
}

/** Verifies current grant, reference, scope, target, path, and lifetime authority. */
export function assertCurrentMcpVaultAuthority(
  input: {
    readonly environmentPackage: {
      readonly snapshotId: string;
      readonly scope: {
        readonly workspaceId: string;
        readonly agentSessionId: string;
        readonly triggerActor?: ActorRef;
      };
      readonly agent: { readonly agentId: string };
    };
    readonly operation: 'mcp.list-tools' | 'mcp.call-tool';
    readonly resolved?: { readonly scope?: 'server' | undefined };
  },
  grant: VaultGrantRecord | null,
  reference: ReturnType<typeof getVaultReference>
): asserts grant is VaultGrantRecord {
  const workspaceId = input.environmentPackage.scope.workspaceId;
  const shared = input.resolved?.scope === 'server';
  const expiresAt = grant?.expiresAt ?? null;
  const expiry = expiresAt ? Date.parse(expiresAt) : null;
  const expired =
    expiry !== null &&
    (!Number.isFinite(expiry) ||
      new Date(expiry).toISOString() !== expiresAt ||
      expiry <= Date.now());
  if (
    !grant ||
    !reference ||
    grant.issuance !== 'target' ||
    (grant.approvalId !== null &&
      (!isTargetIssuedEffectAuthority(grant.approvalId) || grant.policyDecisionId === null)) ||
    grant.status !== 'active' ||
    !isTargetIssuedEffectAuthority(grant.grantId) ||
    (grant.approvalId !== null &&
      (!isTargetIssuedEffectAuthority(grant.approvalId) || grant.policyDecisionId === null)) ||
    expired ||
    grant.ownerScope !== (shared ? 'server' : 'workspace') ||
    grant.workspaceId !== (shared ? null : workspaceId) ||
    (shared &&
      (grant.userId !== null ||
        grant.lifetime !== 'server' ||
        grant.allowedInjectionPaths.length !== 1)) ||
    !grant.allowedInjectionPaths.includes('gateway-only') ||
    (grant.targetAgentId !== null &&
      grant.targetAgentId !== input.environmentPackage.agent.agentId) ||
    (grant.targetAgentSessionId !== null &&
      grant.targetAgentSessionId !== input.environmentPackage.scope.agentSessionId) ||
    (grant.targetCapabilityId !== null && grant.targetCapabilityId !== input.operation) ||
    reference.status !== 'active' ||
    reference.ownerScope !== (shared ? 'server' : 'workspace') ||
    reference.workspaceId !== (shared ? null : workspaceId) ||
    (shared && (reference.userId !== null || reference.secretKind !== 'mcp-credential'))
  ) {
    throw new Error('MCP Vault authority is not current.');
  }
}

/** Creates receipts only after a successful credential-bearing upstream exchange. */
export async function completeMcpVaultInjections(
  coreDb: CoreDb,
  call: StartedCapabilityCall,
  injections: readonly PendingMcpVaultInjection[]
): Promise<void> {
  await getControlStoreWorkerClient().vault(coreDb, 'mcp-receipts-complete', {
    receipts: injections.map((injection) => ({
      agentSessionId: call.context.agentSessionId ?? null,
      backendSummary: injection.backendSummary,
      capabilityCallId: call.id,
      expiresAt: injection.grant.expiresAt,
      grantId: injection.grant.grantId,
      injectedAt: injection.injectedAt,
      planId: injection.planId,
      receiptId: injection.receiptId,
      revocationStatus: 'active' as const,
    })),
  });
}

/** Non-secret receipt metadata retained until an upstream sink succeeds. */
export interface PendingMcpVaultInjection {
  readonly backendSummary: string;
  readonly grant: VaultGrantRecord;
  readonly injectedAt: string;
  readonly planId: string;
  readonly receiptId: string;
  /** Exact material version observed before asynchronous discovery; this grants no grace for stale use. */
  readonly referenceVersion: number;
}

/** Builds a target-issued deterministic Vault record id for one binding and call. */
function mcpVaultRecordId(
  kind: 'plan' | 'receipt',
  input: {
    readonly call: Pick<StartedCapabilityCall, 'id'>;
    readonly environmentPackage: { readonly snapshotId: string };
    readonly operation: string;
    readonly resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  },
  slot: string,
  grantId: string
): string {
  return `${kind}_mcp_${createHash('sha256')
    .update(
      `${input.environmentPackage.snapshotId}\n${input.resolved.id}\n${input.operation}\n${input.call.id}\n${slot}\n${grantId}`
    )
    .digest('hex')
    .slice(0, 24)}`;
}
