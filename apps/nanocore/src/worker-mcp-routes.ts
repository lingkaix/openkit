import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { resolveWorkspaceMcpServer, WorkspaceMcpToolNameSchema } from '@openkit/config-schema';
import { responsibleUserIdForActor } from '@openkit/protocol';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Hono } from 'hono';

import type { AuthVariables } from './auth/middleware.js';
import { currentWorkspaceAuthority } from './auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  recordUsage,
  type StartedCapabilityCall,
  stampCapabilityCallSchemaSnapshot,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from './config/runtime-config.js';
import type { FsStore } from './lib/store.js';
import {
  createPolicyApprovalGate,
  isExactMcpApprovalSourceDecision,
  MCP_APPROVAL_TTL_MS,
} from './policy/approval-gates.js';
import {
  listPolicyApprovalSourceDecisions,
  readPolicyApprovalTerminalWinner,
  recordProductPermissionDecision,
} from './policy/permission-decisions.js';
import {
  mcpToolArgumentsContentDigest,
  mcpToolSchemaContentDigest,
  readCurrentMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
  WorkerCapabilityMcpToolSchema,
} from './runtime/mcp-tool-schema-snapshots.js';
import {
  type WorkerControlGateway,
  WorkerControlGatewayError,
} from './runtime/worker-control-gateway.js';
import type {
  WorkerMcpGateway,
  WorkerMcpGatewayCredentials,
} from './runtime/worker-mcp-gateway.js';
import { WorkerMcpGatewayCallError } from './runtime/worker-mcp-gateway.js';
import { classifyClosedWorkerApprovalGate } from './runtime/worker-recovery.js';
import {
  type CoreDb,
  listExistingWorkspaceDatabaseScopes,
  openBootVerifiedWorkspaceDb,
  openWorkspaceDb,
  type WorkspaceDb,
} from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { vaultSecretMaterialToString } from './vault/vault-backend.js';
import { getVaultGrant, type VaultGrantRecord } from './vault/vault-grants.js';
import { getVaultReference } from './vault/vault-references.js';
import type { VaultUnlockState } from './vault/vault-unlock-state.js';
import { createVaultUseAuditedBackend } from './vault/vault-use-audited-backend.js';
import { createVaultInjectionPlan } from './vault-injection-plans.js';
import { createVaultInjectionReceipt } from './vault-injection-receipts.js';
import type { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const toolArgumentValidator = new Ajv2020({ allErrors: false, strict: false });
interface McpApprovalEffect {
  readonly agentId: string;
  readonly argumentsDigest: string;
  readonly catalogEntryRevision: string;
  readonly kind: 'mcp-tool-call';
  readonly responsibleUserId: string;
  readonly schemaSnapshotId: string;
  readonly serverId: string;
  readonly threadId: string;
  readonly toolName: string;
  readonly workspaceId: string;
}

interface GrantedMcpApproval {
  readonly approvalId: string;
  readonly decisionId: string;
  readonly resource: McpApprovalEffect & { readonly expiresAt: string };
}

interface WorkerMcpToolCallInput {
  readonly arguments: Record<string, unknown>;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly input: RegisterWorkerMcpRoutesInput;
  readonly protocolRequestId: string | number;
  readonly resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  readonly selected: AgentEnvironmentPackage['supply']['mcpServers'][number];
  readonly serverId: string;
  readonly signal: AbortSignal;
  readonly toolName: string;
  readonly workspaceDb: WorkspaceDb;
}

/** Dependencies for the private worker-facing Streamable HTTP MCP endpoint. */
export interface RegisterWorkerMcpRoutesInput {
  /** Hono application receiving the private route. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Core database holding current Workspace authority. */
  readonly coreDb?: CoreDb;
  /** Returns the current complete runtime configuration snapshot. */
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  /** Item owner for product-safe tool-call projections. */
  readonly store: FsStore;
  /** Shared gate fencing Workspace writes against deletion. */
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
  /** Worker token and package authority. */
  readonly workerControlGateway: WorkerControlGateway;
  /** NanoCore-owned upstream MCP client supervisor. */
  readonly workerMcpGateway: WorkerMcpGateway;
  /** Process-local Vault state used only at the gateway sink boundary. */
  readonly vaultUnlockState?: VaultUnlockState | null;
  /** Durably queues the existing Codex Harness stop after a Gate and denial are durable. */
  readonly requestHumanGateStop?: ((packageSnapshotId: string) => void) | undefined;
}

/** Registers the private per-catalog-entry MCP Streamable HTTP endpoint. */
export function registerWorkerMcpRoutes(input: RegisterWorkerMcpRoutesInput): void {
  const activeRequests = new Map<string, AbortController>();
  const toolCallTails = new Map<string, Promise<void>>();
  input.app.post('/api/worker-capabilities/mcp/_list-servers', async (context) => {
    let call: StartedCapabilityCall | null = null;
    let releaseMutation: (() => void) | null = null;
    let workspaceDb: WorkspaceDb | null = null;
    try {
      if (!input.coreDb) {
        throw new WorkerControlGatewayError(
          'mcp-server-unavailable',
          'MCP durable authority is unavailable.',
          503
        );
      }
      const body = await context.req.json().catch(() => null);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        throw new WorkerControlGatewayError('mcp-call-failed', 'MCP server listing failed.', 400);
      }
      const environmentPackage = input.workerControlGateway.authenticatePackageToken(
        context.req.header('authorization') ?? null,
        { tokenFamily: 'capability' }
      );
      releaseMutation = input.workspaceMutationAdmission.enter(
        environmentPackage.scope.workspaceId
      );
      if (!releaseMutation) throw unavailableServer();
      requireMcpCapabilityTurnAdmission(input.store, environmentPackage);
      requireCurrentMcpWorkspaceAuthority(input.coreDb, environmentPackage);
      if (environmentPackage.capabilities.mode !== 'enabled') throw unavailableServer();
      const catalog = input
        .runtimeConfig()
        .workspaceMcpServerCatalogs.find(
          (entry) => entry.workspaceId === environmentPackage.scope.workspaceId
        )?.catalog;
      if (!catalog) throw unavailableServer();

      workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, environmentPackage.scope.workspaceId);
      applyScopedMigrations(workspaceDb);
      call = startCapabilityCall({
        agentId: environmentPackage.agent.agentId,
        agentSessionId: environmentPackage.scope.agentSessionId,
        authorityActor: environmentPackage.scope.triggerActor,
        callId: `cap_mcp_${randomUUID()}`,
        capabilityId: 'mcp.list_servers',
        family: 'mcp',
        itemId: environmentPackage.scope.itemId ?? null,
        operation: 'mcp.list_servers',
        packageSnapshotId: environmentPackage.snapshotId,
        redactionClass: 'metadata-only',
        requestId: null,
        serviceRef: 'mcp-gateway',
        sourceIds: [],
        summary: 'MCP server list requested.',
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workspaceDb,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      const servers = environmentPackage.supply.mcpServers.map((selected) => {
        const resolved = resolveWorkspaceMcpServer({ catalog, serverId: selected.id });
        if (resolved.catalogDigest !== selected.catalogDigest) throw unavailableServer();
        const snapshot = readCurrentMcpToolSchemaSnapshot({
          catalogEntryId: selected.id,
          pinnedSchemaSnapshotId: selected.pinnedSchemaSnapshotId,
          workspaceDb: workspaceDb!,
          workspaceId: environmentPackage.scope.workspaceId,
        });
        return {
          health: input.workerMcpGateway.getServerHealth({
            server: resolved,
            workspaceId: environmentPackage.scope.workspaceId,
          }),
          id: selected.id,
          toolNames:
            snapshot?.tools
              .filter(
                (tool) =>
                  selected.allowedTools.includes(tool.name) &&
                  !selected.deniedTools.includes(tool.name)
              )
              .map((tool) => tool.name) ?? [],
          transport: resolved.transport.kind,
        };
      });
      const result = { servers };
      finishCapabilityCall({ callId: call.id, status: 'succeeded', workspaceDb });
      return context.json(result);
    } catch (error) {
      const normalized =
        call && workspaceDb ? finishMcpCallFailure(error, call, workspaceDb) : error;
      return workerMcpHttpError(normalized);
    } finally {
      workspaceDb?.sqlite.close();
      releaseMutation?.();
    }
  });

  input.app.post('/api/worker-capabilities/mcp/:serverId', async (context) => {
    let server: Server | null = null;
    try {
      if (!input.coreDb) {
        throw new WorkerControlGatewayError(
          'mcp-server-unavailable',
          'MCP durable authority is unavailable.',
          503
        );
      }
      const environmentPackage = input.workerControlGateway.authenticatePackageToken(
        context.req.header('authorization') ?? null,
        { tokenFamily: 'capability' }
      );
      const serverId = context.req.param('serverId');
      const selected = requireSelectedMcpServer(environmentPackage, serverId);
      const catalog = input
        .runtimeConfig()
        .workspaceMcpServerCatalogs.find(
          (entry) => entry.workspaceId === environmentPackage.scope.workspaceId
        )?.catalog;
      if (!catalog) {
        throw unavailableServer();
      }
      const resolved = resolveWorkspaceMcpServer({ catalog, serverId });
      if (resolved.catalogDigest !== selected.catalogDigest) {
        throw unavailableServer();
      }

      const protocolMessage = await context.req.raw
        .clone()
        .json()
        .catch(() => null);
      const cancellation = CancelledNotificationSchema.safeParse(protocolMessage);
      if (cancellation.success) {
        if (cancellation.data.params.requestId !== undefined) {
          activeRequests
            .get(
              mcpActiveRequestKey(environmentPackage, serverId, cancellation.data.params.requestId)
            )
            ?.abort(new DOMException('MCP caller cancelled request.', 'AbortError'));
        }
        return new Response(null, { status: 202 });
      }
      server = new Server(
        { name: `openkit-${serverId}`, version: '1.0.0' },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        if (!hasCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage)) {
          throw mcpDeniedError();
        }
        const cancellation = registerMcpActiveRequest(
          activeRequests,
          environmentPackage,
          serverId,
          extra.requestId,
          extra.signal
        );
        const releaseMutation = input.workspaceMutationAdmission.enter(
          environmentPackage.scope.workspaceId
        );
        if (!releaseMutation) {
          cancellation.release();
          throw mcpDeniedError();
        }
        let activeWorkspaceDb: WorkspaceDb | null = null;
        try {
          activeWorkspaceDb = openWorkspaceDb(
            input.coreDb!.dataRoot,
            environmentPackage.scope.workspaceId
          );
          applyScopedMigrations(activeWorkspaceDb);
          const call = startMcpCapabilityCall({
            capabilityId: 'mcp.list_tools',
            environmentPackage,
            itemId: environmentPackage.scope.itemId ?? null,
            operation: 'mcp.list_tools',
            serverId,
            protocolRequestId: extra.requestId,
            workspaceDb: activeWorkspaceDb,
          });
          try {
            requireMcpCapabilityTurnAdmission(input.store, environmentPackage);
            requireCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage);
            const current = readCurrentMcpToolSchemaSnapshot({
              catalogEntryId: serverId,
              pinnedSchemaSnapshotId: selected.pinnedSchemaSnapshotId,
              workspaceDb: activeWorkspaceDb,
              workspaceId: environmentPackage.scope.workspaceId,
            });
            if (current) {
              const result = {
                tools: current.tools.filter(
                  (tool) =>
                    selected.allowedTools.includes(tool.name) &&
                    !selected.deniedTools.includes(tool.name)
                ),
              };
              finishCapabilityCall({
                callId: call.id,
                status: 'succeeded',
                workspaceDb: activeWorkspaceDb,
              });
              return result;
            }
            const observed = await observeWorkerMcpTools({
              call,
              environmentPackage,
              input,
              operation: 'mcp.list_tools',
              resolved,
              selected,
              serverId,
              signal: cancellation.signal,
              workspaceDb: activeWorkspaceDb,
            });
            if (observed.credentials) {
              try {
                await input.workerMcpGateway.closeServerIfIdle({
                  server: resolved,
                  workspaceId: environmentPackage.scope.workspaceId,
                });
              } catch {
                throw new WorkerControlGatewayError(
                  'recovery_required',
                  'MCP credential cleanup recovery is required.',
                  409
                );
              }
            }
            const result = { tools: observed.visibleTools };
            finishCapabilityCall({
              callId: call.id,
              status: 'succeeded',
              workspaceDb: activeWorkspaceDb,
            });
            return result;
          } catch (error) {
            throw finishMcpHandlerFailure(error, call, activeWorkspaceDb);
          }
        } finally {
          activeWorkspaceDb?.sqlite.close();
          releaseMutation();
          cancellation.release();
        }
      });
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (!hasCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage)) {
          throw mcpDeniedError();
        }
        const cancellation = registerMcpActiveRequest(
          activeRequests,
          environmentPackage,
          serverId,
          extra.requestId,
          extra.signal
        );
        try {
          const call = async () => {
            const releaseMutation = input.workspaceMutationAdmission.enter(
              environmentPackage.scope.workspaceId
            );
            if (!releaseMutation) throw mcpDeniedError();
            let activeWorkspaceDb: WorkspaceDb | null = null;
            try {
              activeWorkspaceDb = openWorkspaceDb(
                input.coreDb!.dataRoot,
                environmentPackage.scope.workspaceId
              );
              applyScopedMigrations(activeWorkspaceDb);
              return await callWorkerMcpTool({
                arguments: request.params.arguments ?? {},
                environmentPackage,
                input,
                protocolRequestId: extra.requestId,
                resolved,
                selected,
                serverId,
                signal: cancellation.signal,
                toolName: request.params.name,
                workspaceDb: activeWorkspaceDb,
              });
            } finally {
              activeWorkspaceDb?.sqlite.close();
              releaseMutation();
            }
          };
          return await (selected.approvalRequiredTools.includes(request.params.name)
            ? serializeMcpToolCall(
                toolCallTails,
                `${environmentPackage.scope.workspaceId}:${environmentPackage.scope.turnId}`,
                call
              )
            : call());
        } finally {
          cancellation.release();
        }
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(context.req.raw);
      return response;
    } catch (error) {
      return workerMcpHttpError(error);
    } finally {
      await server?.close().catch(() => undefined);
    }
  });
}

/** Correlates MCP cancellation notifications across stateless HTTP requests. */
function registerMcpActiveRequest(
  activeRequests: Map<string, AbortController>,
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  requestId: string | number,
  sdkSignal: AbortSignal
): { readonly release: () => void; readonly signal: AbortSignal } {
  const key = mcpActiveRequestKey(environmentPackage, serverId, requestId);
  if (activeRequests.has(key)) throw mcpDeniedError();
  const controller = new AbortController();
  const forwardSdkCancellation = () => controller.abort(sdkSignal.reason);
  if (sdkSignal.aborted) forwardSdkCancellation();
  else sdkSignal.addEventListener('abort', forwardSdkCancellation, { once: true });
  activeRequests.set(key, controller);
  return {
    release: () => {
      sdkSignal.removeEventListener('abort', forwardSdkCancellation);
      if (activeRequests.get(key) === controller) activeRequests.delete(key);
    },
    signal: controller.signal,
  };
}

/** Exact process-local identity for one in-flight MCP protocol request. */
function mcpActiveRequestKey(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  requestId: string | number
): string {
  return JSON.stringify([environmentPackage.snapshotId, serverId, requestId]);
}

/** Serializes same-Turn approval effects so the one-shot winner crosses upstream first. */
async function serializeMcpToolCall<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  call: () => Promise<T>
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, current);
  await previous;
  try {
    return await call();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}

/** Recreates missing product-safe MCP Items from terminal durable CapabilityCalls at boot. */
export function reconcileWorkerMcpItems(dataRoot: string, store: FsStore): number {
  const existingItemIds = new Set(store.listAllItems().map((item) => item.id));
  let recovered = 0;
  for (const { workspaceId } of listExistingWorkspaceDatabaseScopes(dataRoot)) {
    const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
    try {
      const rows = workspaceDb.sqlite
        .prepare(
          `SELECT
             call_id,
             completed_at,
             error_code,
             item_id,
             provider_ref,
             service_ref,
             started_at,
             status,
             thread_id,
             turn_id
           FROM capability_calls
           WHERE family = 'mcp'
             AND operation = 'mcp.call_tool'
             AND status NOT IN ('queued', 'running')
             AND item_id IS NOT NULL
             AND provider_ref IS NOT NULL
             AND service_ref LIKE 'mcp-tool:%'
             AND thread_id IS NOT NULL
             AND turn_id IS NOT NULL
             AND completed_at IS NOT NULL
           ORDER BY completed_at, call_id`
        )
        .all() as Array<{
        call_id: string;
        completed_at: string;
        error_code: string | null;
        item_id: string;
        provider_ref: string;
        service_ref: string;
        started_at: string | null;
        status: string;
        thread_id: string;
        turn_id: string;
      }>;
      for (const row of rows) {
        if (existingItemIds.has(row.item_id)) continue;
        store.createItem({
          arguments: null,
          causationId: row.call_id,
          completedAt: row.completed_at,
          createdAt: row.completed_at,
          durationMs: row.started_at
            ? Math.max(0, Date.parse(row.completed_at) - Date.parse(row.started_at))
            : 0,
          error: row.status === 'succeeded' ? null : row.error_code,
          id: row.item_id,
          result: null,
          server: row.provider_ref,
          status:
            row.status === 'succeeded'
              ? 'completed'
              : row.status === 'denied'
                ? 'declined'
                : 'failed',
          threadId: row.thread_id,
          tool: row.service_ref.slice('mcp-tool:'.length),
          turnId: row.turn_id,
          type: 'tool-call',
          workspaceId,
        });
        existingItemIds.add(row.item_id);
        recovered += 1;
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  }
  return recovered;
}

/** Executes one governed tool call and writes its existing durable projections. */
async function callWorkerMcpTool(input: WorkerMcpToolCallInput) {
  const parsedToolName = WorkspaceMcpToolNameSchema.safeParse(input.toolName);
  if (!parsedToolName.success || parsedToolName.data !== input.toolName) {
    throw new McpError(ErrorCode.InvalidRequest, 'MCP tool is unavailable.', {
      code: 'mcp-tool-not-found',
    });
  }
  const available =
    input.selected.allowedTools.includes(input.toolName) &&
    !input.selected.deniedTools.includes(input.toolName);
  const approvalRequired =
    available && input.selected.approvalRequiredTools.includes(input.toolName);
  const currentSnapshot = approvalRequired
    ? readCurrentMcpToolSchemaSnapshot({
        catalogEntryId: input.serverId,
        pinnedSchemaSnapshotId: input.selected.pinnedSchemaSnapshotId,
        workspaceDb: input.workspaceDb,
        workspaceId: input.environmentPackage.scope.workspaceId,
      })
    : null;
  const approvalEffect = currentSnapshot
    ? mcpApprovalEffect(input, currentSnapshot.schemaSnapshotId)
    : null;
  let grantedApproval = approvalEffect
    ? findGrantedMcpApproval(input.workspaceDb, approvalEffect, input.input.store)
    : null;
  const itemId = workerMcpItemId(
    input.environmentPackage,
    input.serverId,
    input.toolName,
    input.protocolRequestId
  );
  const requestCallId = `cap_mcp_${mcpRequestIdentity(
    input.environmentPackage,
    input.serverId,
    'mcp.call_tool',
    input.protocolRequestId
  )}`;
  const startedAt = Date.now();
  const startCall = (callId?: string) =>
    startMcpCapabilityCall({
      ...(callId ? { callId } : {}),
      capabilityId: 'mcp.call_tool',
      environmentPackage: input.environmentPackage,
      itemId,
      operation: 'mcp.call_tool',
      protocolRequestId: input.protocolRequestId,
      serverId: input.serverId,
      summary: `MCP tool call ${input.serverId}/${input.toolName}.`,
      toolName: input.toolName,
      workspaceDb: input.workspaceDb,
    });
  let call: StartedCapabilityCall | null = null;
  if (grantedApproval) {
    const approvalCallId = mcpApprovalCapabilityCallId(grantedApproval.approvalId);
    try {
      const claimed = startCall(approvalCallId);
      if (claimed.inserted) call = claimed;
    } catch (error) {
      const raced = input.workspaceDb.sqlite
        .prepare('SELECT 1 FROM capability_calls WHERE call_id = ? LIMIT 1')
        .get(approvalCallId);
      if (!raced) throw error;
    }
    if (!call) grantedApproval = null;
  }
  if (!call) {
    const replay = input.workspaceDb.sqlite
      .prepare(
        `SELECT
           workspace_id, thread_id, turn_id, item_id, agent_id, agent_session_id,
           package_snapshot_id, capability_id, family, operation, provider_ref, service_ref, status
         FROM capability_calls
         WHERE call_id = ?`
      )
      .get(requestCallId) as
      | {
          agent_id: string;
          agent_session_id: string;
          capability_id: string;
          family: string;
          item_id: string | null;
          operation: string;
          package_snapshot_id: string;
          provider_ref: string | null;
          service_ref: string | null;
          status: string;
          thread_id: string | null;
          turn_id: string | null;
          workspace_id: string;
        }
      | undefined;
    if (replay) {
      if (
        (replay.item_id !== itemId && !(replay.item_id === null && replay.status === 'denied')) ||
        !isDeepStrictEqual(replay, {
          agent_id: input.environmentPackage.agent.agentId,
          agent_session_id: input.environmentPackage.scope.agentSessionId,
          capability_id: 'mcp.call_tool',
          family: 'mcp',
          item_id: replay.item_id,
          operation: 'mcp.call_tool',
          package_snapshot_id: input.environmentPackage.snapshotId,
          provider_ref: input.serverId,
          service_ref: `mcp-tool:${input.toolName}`,
          status: replay.status,
          thread_id: input.environmentPackage.scope.threadId,
          turn_id: input.environmentPackage.scope.turnId,
          workspace_id: input.environmentPackage.scope.workspaceId,
        })
      ) {
        throw new WorkerControlGatewayError(
          'recovery_required',
          'MCP capability recovery is required.',
          409
        );
      }
      throw mcpDeniedError();
    }
    call = startCall(requestCallId);
  }
  if (!call.inserted) throw mcpDeniedError();
  let status: 'completed' | 'declined' | 'failed' = 'failed';
  let errorCode: string | null = null;
  let humanGateStopRequired = false;
  let terminalCommitted = false;
  let upstreamEffect: 'not-contacted' | 'contacted' | 'unknown' = 'not-contacted';
  let usageAttempted = false;
  let usageRecoveryRequired = false;
  let cancelled = false;
  let publishTerminalItem = true;
  let observedCredentials: WorkerMcpGatewayCredentials | undefined;

  try {
    if (
      !hasCurrentMcpWorkspaceAuthority(input.input.coreDb!, input.environmentPackage) ||
      !hasMcpCapabilityTurnAdmission(input.input.store, input.environmentPackage)
    ) {
      recordMcpToolUseDecision(input, call, 'deny', null);
      publishTerminalItem = false;
      throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
    }
    if (!available) {
      throw new WorkerControlGatewayError('mcp-tool-not-found', 'MCP tool is unavailable.', 404);
    }
    if (approvalRequired) {
      if (!currentSnapshot || !approvalEffect) {
        throw new WorkerControlGatewayError(
          'mcp-schema-drift',
          'MCP tool schema is unavailable.',
          409
        );
      }
      stampCapabilityCallSchemaSnapshot({
        callId: call.id,
        schemaSnapshotId: currentSnapshot.schemaSnapshotId,
        workspaceDb: input.workspaceDb,
      });
      assertValidMcpToolArguments(currentSnapshot.tools, input.toolName, input.arguments);
      if (!grantedApproval) {
        createMcpToolApprovalGate(input, call, approvalEffect);
        humanGateStopRequired = true;
        throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
      }
    }
    const observed = await observeWorkerMcpTools({
      call,
      environmentPackage: input.environmentPackage,
      input: input.input,
      operation: 'mcp.call_tool',
      resolved: input.resolved,
      selected: input.selected,
      serverId: input.serverId,
      signal: input.signal,
      workspaceDb: input.workspaceDb,
    });
    observedCredentials = observed.credentials;
    if (grantedApproval && observed.snapshotId !== grantedApproval.resource.schemaSnapshotId) {
      throw new WorkerControlGatewayError(
        'mcp-schema-drift',
        'MCP tool schema changed after approval.',
        409
      );
    }
    assertValidMcpToolArguments(observed.snapshotTools, input.toolName, input.arguments);
    if (!hasCurrentMcpWorkspaceAuthority(input.input.coreDb!, input.environmentPackage)) {
      recordMcpToolUseDecision(input, call, 'deny', null);
      publishTerminalItem = false;
      if (observed.credentials) {
        try {
          await input.input.workerMcpGateway.closeServer({
            server: input.resolved,
            workspaceId: input.environmentPackage.scope.workspaceId,
          });
        } catch {
          throw new WorkerControlGatewayError(
            'recovery_required',
            'MCP credential cleanup recovery is required.',
            409
          );
        }
      }
      throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
    }
    if (!hasMcpCapabilityTurnAdmission(input.input.store, input.environmentPackage)) {
      recordMcpToolUseDecision(input, call, 'deny', null);
      publishTerminalItem = false;
      throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
    }
    if (observed.credentials) {
      try {
        assertCurrentMcpVaultBindings(input);
      } catch {
        publishTerminalItem = false;
        try {
          await input.input.workerMcpGateway.closeServer({
            server: input.resolved,
            workspaceId: input.environmentPackage.scope.workspaceId,
          });
        } catch {
          throw new WorkerControlGatewayError(
            'recovery_required',
            'MCP credential cleanup recovery is required.',
            409
          );
        }
        throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
      }
    }
    recordMcpToolUseDecision(input, call, 'allow', grantedApproval);
    const dispatchCredentials = observedCredentials;
    const result = await input.input.workerMcpGateway.callTool({
      arguments: input.arguments,
      ...(dispatchCredentials ? { credentials: dispatchCredentials } : {}),
      server: input.resolved,
      signal: input.signal,
      toolName: input.toolName,
      workspaceId: input.environmentPackage.scope.workspaceId,
    });
    observedCredentials = undefined;
    upstreamEffect = 'contacted';
    usageAttempted = true;
    try {
      recordMcpToolCallUsage(call, input.workspaceDb);
    } catch (error) {
      usageRecoveryRequired = true;
      throw error;
    }
    try {
      finishCapabilityCall({
        callId: call.id,
        status: 'succeeded',
        workspaceDb: input.workspaceDb,
      });
    } catch {
      upstreamEffect = 'unknown';
      throw new WorkerControlGatewayError('mcp-call-failed', 'MCP tool call failed.', 503);
    }
    terminalCommitted = true;
    status = 'completed';
    return result;
  } catch (error) {
    if (error instanceof WorkerMcpGatewayCallError) {
      upstreamEffect = error.upstreamEffect;
      cancelled = error.cancelled;
    }
    let failure = error;
    if (observedCredentials) {
      try {
        await input.input.workerMcpGateway.closeServerIfIdle({
          server: input.resolved,
          workspaceId: input.environmentPackage.scope.workspaceId,
        });
      } catch {
        failure = new WorkerControlGatewayError(
          'recovery_required',
          'MCP credential cleanup recovery is required.',
          409
        );
      }
    }
    if (usageRecoveryRequired) {
      throw new McpError(ErrorCode.InternalError, 'MCP tool call recovery is required.', {
        code: 'recovery_required',
      });
    }
    if (failure instanceof WorkerMcpGatewayCallError) {
      upstreamEffect = failure.upstreamEffect;
      cancelled = failure.cancelled;
    }
    if (upstreamEffect !== 'not-contacted' && !usageAttempted) {
      usageAttempted = true;
      try {
        recordMcpToolCallUsage(call, input.workspaceDb);
      } catch {
        throw new McpError(ErrorCode.InternalError, 'MCP tool call recovery is required.', {
          code: 'recovery_required',
        });
      }
    }
    const normalized = normalizeWorkerMcpRouteError(failure);
    errorCode = normalized.code;
    const terminalStatus = cancelled
      ? 'aborted'
      : normalized.code === 'mcp-timeout'
        ? 'timed-out'
        : upstreamEffect === 'unknown'
          ? 'unknown'
          : normalized.code === 'mcp-denied'
            ? 'denied'
            : 'failed';
    try {
      if (!publishTerminalItem) {
        input.workspaceDb.sqlite
          .prepare(
            `UPDATE capability_calls
             SET item_id = NULL
             WHERE call_id = ? AND status = 'running'`
          )
          .run(call.id);
      }
      finishCapabilityCall({
        callId: call.id,
        errorCode: normalized.code,
        status: terminalStatus,
        workspaceDb: input.workspaceDb,
      });
    } catch {
      throw new McpError(ErrorCode.InternalError, 'MCP tool call recovery is required.', {
        code: 'recovery_required',
      });
    }
    terminalCommitted = true;
    status = terminalStatus === 'denied' ? 'declined' : 'failed';
    if (humanGateStopRequired) {
      try {
        if (!input.input.requestHumanGateStop) {
          throw new Error('The production Worker Gate stop owner is unavailable.');
        }
        input.input.requestHumanGateStop(input.environmentPackage.snapshotId);
      } catch {
        throw new McpError(ErrorCode.InvalidRequest, 'Worker Gate recovery is required.', {
          code: 'recovery_required',
        });
      }
    }
    throw new McpError(ErrorCode.InvalidRequest, normalized.message, {
      code: normalized.code,
    });
  } finally {
    if (terminalCommitted && publishTerminalItem) {
      try {
        publishWorkerMcpItem({
          call,
          durationMs: Date.now() - startedAt,
          environmentPackage: input.environmentPackage,
          errorCode,
          itemId,
          serverId: input.serverId,
          status,
          store: input.input.store,
          toolName: input.toolName,
        });
      } catch {}
    }
  }
}

/** Records the one tool-call quantity after the upstream effect boundary is crossed. */
function recordMcpToolCallUsage(call: StartedCapabilityCall, workspaceDb: WorkspaceDb): void {
  recordUsage({
    call,
    records: [
      {
        category: 'tool',
        quantity: 1,
        source: 'mcp-gateway-request-dispatched',
        unit: 'tool_calls',
      },
    ],
    workspaceDb,
  });
}

/** Creates the AgentSession-independent exact effect used by one MCP Approval. */
function mcpApprovalEffect(
  input: WorkerMcpToolCallInput,
  schemaSnapshotId: string
): McpApprovalEffect {
  const responsibleUserId = responsibleUserIdForActor(input.environmentPackage.scope.triggerActor);
  if (!responsibleUserId) {
    throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
  }
  return {
    agentId: input.environmentPackage.agent.agentId,
    argumentsDigest: mcpToolArgumentsContentDigest(input.arguments),
    catalogEntryRevision: input.resolved.catalogDigest,
    kind: 'mcp-tool-call',
    responsibleUserId,
    schemaSnapshotId,
    serverId: input.serverId,
    threadId: input.environmentPackage.scope.threadId,
    toolName: input.toolName,
    workspaceId: input.environmentPackage.scope.workspaceId,
  };
}

/** Finds the sole usable exact-match Approval without trusting a caller-supplied id. */
function findGrantedMcpApproval(
  workspaceDb: WorkspaceDb,
  effect: McpApprovalEffect,
  store: FsStore
): GrantedMcpApproval | null {
  const approvalIds = workspaceDb.sqlite
    .prepare(
      `SELECT DISTINCT approval_id
       FROM permission_decisions
       WHERE owner_scope = 'workspace'
         AND workspace_id = ?
         AND action = 'tool.use'
         AND result = 'require_approval'
         AND approval_id IS NOT NULL
       ORDER BY approval_id`
    )
    .all(effect.workspaceId) as Array<{ approval_id: string }>;
  const matches = approvalIds.flatMap(({ approval_id: approvalId }) => {
    let sources: ReturnType<typeof listPolicyApprovalSourceDecisions>;
    try {
      sources = listPolicyApprovalSourceDecisions(workspaceDb, effect.workspaceId, approvalId);
    } catch {
      return [];
    }
    const source = sources[0];
    if (sources.length !== 1 || source?.action !== 'tool.use') return [];
    const sourceContext = source.contextSummary;
    const sourceResource = source.resourceSummary;
    if (
      !sourceResource ||
      typeof sourceResource !== 'object' ||
      Array.isArray(sourceResource) ||
      !sourceContext ||
      typeof sourceContext !== 'object' ||
      Array.isArray(sourceContext) ||
      !('expiresAt' in sourceResource) ||
      typeof sourceResource.expiresAt !== 'string' ||
      Object.keys(sourceResource).length !== Object.keys(effect).length + 1 ||
      !isMcpApprovalExpiryActive(sourceResource.expiresAt)
    ) {
      return [];
    }
    const { expiresAt, ...candidateEffect } = sourceResource;
    if (!isDeepStrictEqual(candidateEffect, effect)) return [];
    const context = sourceContext as Record<string, unknown>;
    let approval: ReturnType<FsStore['getApproval']>;
    try {
      approval = store.getApproval(approvalId);
    } catch {
      return [];
    }
    if (
      typeof context.agentSessionId !== 'string' ||
      typeof context.turnId !== 'string' ||
      context.workspaceId !== effect.workspaceId ||
      context.threadId !== effect.threadId ||
      !isExactMcpApprovalSourceDecision({
        approvalCreatedAt: approval.createdAt,
        source,
        threadId: effect.threadId,
        turnId: context.turnId,
        workspaceDb,
        workspaceId: effect.workspaceId,
      })
    ) {
      return [];
    }
    try {
      const sourceTurn = store.getTurn(effect.workspaceId, effect.threadId, context.turnId);
      const sourceSession = store.getAgentSession(context.agentSessionId);
      const closedGate = classifyClosedWorkerApprovalGate(store, sourceTurn);
      const winner = readPolicyApprovalTerminalWinner(
        workspaceDb,
        effect.workspaceId,
        approvalId,
        effect.threadId,
        context.turnId
      );
      if (
        closedGate?.stopReason !== 'completed' ||
        closedGate.responseRequestId !== winner?.requestId ||
        sourceTurn.agentSessionId !== sourceSession.id ||
        sourceSession.status !== 'closed' ||
        !winner ||
        winner.action !== 'tool.use' ||
        winner.result !== 'allow' ||
        winner.requiredApprovalKind !== 'permission' ||
        winner.actor.id !== effect.responsibleUserId ||
        !isDeepStrictEqual(winner.resourceSummary, sourceResource) ||
        !isDeepStrictEqual(winner.subjectSummary, source.subjectSummary) ||
        approval.status !== 'granted' ||
        approval.resolvedAt !== winner.decidedAt
      ) {
        return [];
      }
      const consumed = workspaceDb.sqlite
        .prepare('SELECT 1 FROM capability_calls WHERE call_id = ? LIMIT 1')
        .get(mcpApprovalCapabilityCallId(approvalId));
      return consumed
        ? []
        : [
            {
              approvalId,
              decisionId: winner.decisionId,
              resource: sourceResource as McpApprovalEffect & { expiresAt: string },
            },
          ];
    } catch {
      return [];
    }
  });

  if (matches.length > 1) throw mcpDeniedError();
  return matches[0] ?? null;
}

/** Opens one existing human-attention Gate for an exact MCP proposed effect. */
function createMcpToolApprovalGate(
  input: WorkerMcpToolCallInput,
  call: StartedCapabilityCall,
  effect: McpApprovalEffect
): void {
  const identity = createHash('sha256').update(call.id).digest('hex').slice(0, 24);
  const now = new Date();
  createPolicyApprovalGate({
    action: 'tool.use',
    approvalId: `ap_mcp_${identity}`,
    approvalItemId: `it_mcp_approval_${identity}`,
    contextSummary: {
      agentSessionId: input.environmentPackage.scope.agentSessionId,
      capabilityCallId: call.id,
      packageSnapshotId: input.environmentPackage.snapshotId,
      threadId: input.environmentPackage.scope.threadId,
      turnId: input.environmentPackage.scope.turnId,
      workspaceId: input.environmentPackage.scope.workspaceId,
    },
    decisionId: `pd_mcp_required_${identity}`,
    description: `Allow one ${input.serverId}/${input.toolName} MCP tool call.`,
    reasonCode: 'mcp_tool_approval_required',
    resourceSummary: {
      ...effect,
      expiresAt: new Date(now.getTime() + MCP_APPROVAL_TTL_MS).toISOString(),
    },
    store: input.input.store,
    subjectSummary: {
      agentId: effect.agentId,
      responsibleUserId: effect.responsibleUserId,
    },
    title: `Approve MCP tool ${input.serverId}/${input.toolName}`,
    turnId: input.environmentPackage.scope.turnId,
    workspaceDb: input.workspaceDb,
    workspaceId: input.environmentPackage.scope.workspaceId,
    now,
  });
}

/** Records the current tool.use decision, with prior Approval lineage only in context. */
function recordMcpToolUseDecision(
  input: WorkerMcpToolCallInput,
  call: StartedCapabilityCall,
  result: 'allow' | 'deny',
  grantedApproval: GrantedMcpApproval | null
): void {
  recordProductPermissionDecision({
    action: 'tool.use',
    auditActor: input.environmentPackage.scope.triggerActor,
    contextSummary: {
      agentSessionId: input.environmentPackage.scope.agentSessionId,
      capabilityCallId: call.id,
      ...(grantedApproval ? { grantedPermissionDecisionId: grantedApproval.decisionId } : {}),
      packageSnapshotId: input.environmentPackage.snapshotId,
      threadId: input.environmentPackage.scope.threadId,
      turnId: input.environmentPackage.scope.turnId,
      workspaceId: input.environmentPackage.scope.workspaceId,
    },
    decisionId: `pd_${randomUUID()}`,
    enforcementPoint: 'worker_capability.mcp.call_tool',
    ownerScope: 'workspace',
    policyEngineVersion: 'nanocore-workspace-role-policy:v1',
    policySnapshotId: input.environmentPackage.policy.snapshotId,
    reasonCode:
      result === 'deny'
        ? 'mcp_call_denied'
        : grantedApproval
          ? 'mcp_approval_grant_reauthorized'
          : 'workspace_role_allows_tool_use',
    resourceSummary: grantedApproval?.resource ?? {
      serverId: input.serverId,
      toolName: input.toolName,
    },
    result,
    subjectSummary: {
      responsibleUserId: responsibleUserIdForActor(input.environmentPackage.scope.triggerActor),
    },
    workspaceDb: input.workspaceDb,
    workspaceId: input.environmentPackage.scope.workspaceId,
  });
}

/** Validates one tool call against a durable or newly observed schema snapshot. */
function assertValidMcpToolArguments(
  tools: Array<{ inputSchema: Record<string, unknown>; name: string }>,
  toolName: string,
  argumentsValue: Record<string, unknown>
): void {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new WorkerControlGatewayError('mcp-tool-not-found', 'MCP tool is unavailable.', 404);
  }
  if (!toolArgumentValidator.compile(tool.inputSchema)(argumentsValue)) {
    throw new WorkerControlGatewayError(
      'mcp-invalid-arguments',
      'MCP tool arguments are invalid.',
      400
    );
  }
}

/** Derives the durable one-shot CapabilityCall identity from its Approval id. */
function mcpApprovalCapabilityCallId(approvalId: string): string {
  return `cap_mcp_approval_${createHash('sha256').update(approvalId).digest('hex').slice(0, 24)}`;
}

/** Returns the closed worker-visible denial for a consumed or ambiguous Approval. */
function mcpDeniedError(): McpError {
  return new McpError(ErrorCode.InvalidRequest, 'MCP tool call was denied.', {
    code: 'mcp-denied',
  });
}

/** Returns whether one Approval expiry is valid and still in the future. */
export function isMcpApprovalExpiryActive(expiresAt: string, now = Date.now()): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

/** Captures the full live schema and returns only the AEP-visible tool projection. */
async function observeWorkerMcpTools(input: {
  readonly call: StartedCapabilityCall;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly input: RegisterWorkerMcpRoutesInput;
  readonly operation: 'mcp.list_tools' | 'mcp.call_tool';
  readonly resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  readonly selected: AgentEnvironmentPackage['supply']['mcpServers'][number];
  readonly serverId: string;
  readonly signal: AbortSignal;
  readonly workspaceDb: WorkspaceDb;
}): Promise<{
  credentials?: WorkerMcpGatewayCredentials;
  snapshotId: string;
  snapshotTools: Array<{ inputSchema: Record<string, unknown>; name: string }>;
  visibleTools: Array<{ inputSchema: Record<string, unknown>; name: string }>;
}> {
  const resolvedCredentials = await resolveWorkerMcpCredentials(input);
  const gatewayInput = {
    ...(resolvedCredentials.credentials ? { credentials: resolvedCredentials.credentials } : {}),
    server: input.resolved,
    signal: input.signal,
    workspaceId: input.environmentPackage.scope.workspaceId,
  };
  const completeInjections = async () => {
    try {
      completeMcpVaultInjections(input.input.coreDb!, input.call, resolvedCredentials.injections);
    } catch {
      await input.input.workerMcpGateway.closeServer(gatewayInput).catch(() => undefined);
      throw new WorkerControlGatewayError(
        'recovery_required',
        'MCP credential receipt recovery is required.',
        409
      );
    }
  };
  let live: Awaited<ReturnType<WorkerMcpGateway['listTools']>>;
  try {
    live = await input.input.workerMcpGateway.listTools(gatewayInput);
  } catch (error) {
    if (error instanceof WorkerMcpGatewayCallError && error.credentialsMaterialized) {
      await completeInjections();
    }
    if (error instanceof WorkerMcpGatewayCallError) {
      throw new WorkerMcpGatewayCallError(
        error.code,
        error.message,
        error.status,
        'not-contacted',
        error.cancelled,
        error.credentialsMaterialized
      );
    }
    throw error;
  }
  await completeInjections();
  let snapshotTools: Array<{ inputSchema: Record<string, unknown>; name: string }>;
  try {
    snapshotTools = live.tools
      .map((tool) =>
        WorkerCapabilityMcpToolSchema.parse({ inputSchema: tool.inputSchema, name: tool.name })
      )
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    if (new Set(snapshotTools.map((tool) => tool.name)).size !== snapshotTools.length) {
      throw new Error('Duplicate MCP tool names.');
    }
  } catch {
    try {
      await input.input.workerMcpGateway.closeServerIfIdle(gatewayInput);
    } catch {
      throw new WorkerControlGatewayError(
        'recovery_required',
        'MCP server cleanup recovery is required.',
        409
      );
    }
    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      'MCP tool listing is invalid.',
      503
    );
  }
  const snapshotDigest = mcpToolSchemaContentDigest(snapshotTools);
  const snapshotId = recordMcpToolSchemaSnapshot({
    capabilityCallId: input.call.id,
    environmentPackage: input.environmentPackage,
    schemaSnapshotId: `mcpsnap_${input.serverId}_${snapshotDigest}`,
    serverId: input.serverId,
    serverVersion: live.serverVersion,
    source: 'live',
    tools: snapshotTools,
    workspaceDb: input.workspaceDb,
    workspaceId: input.environmentPackage.scope.workspaceId,
  });
  if (
    input.selected.schemaPolicy === 'pinned' &&
    input.selected.pinnedSchemaSnapshotId !== snapshotId
  ) {
    throw new WorkerControlGatewayError(
      'mcp-schema-drift',
      'MCP tool schema changed from its pinned snapshot.',
      409
    );
  }
  if (input.operation === 'mcp.call_tool') {
    stampCapabilityCallSchemaSnapshot({
      callId: input.call.id,
      schemaSnapshotId: snapshotId,
      workspaceDb: input.workspaceDb,
    });
  }
  return {
    ...(resolvedCredentials.credentials ? { credentials: resolvedCredentials.credentials } : {}),
    snapshotId,
    snapshotTools,
    visibleTools: snapshotTools.filter(
      (tool) =>
        input.selected.allowedTools.includes(tool.name) &&
        !input.selected.deniedTools.includes(tool.name)
    ),
  };
}

/** Resolves every current Vault grant into the exact catalog-declared transport sink. */
async function resolveWorkerMcpCredentials(input: {
  readonly call: StartedCapabilityCall;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly input: RegisterWorkerMcpRoutesInput;
  readonly operation: 'mcp.list_tools' | 'mcp.call_tool';
  readonly resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  readonly workspaceDb: WorkspaceDb;
}): Promise<{
  credentials?: WorkerMcpGatewayCredentials;
  injections: PendingMcpVaultInjection[];
}> {
  if (input.resolved.credentialBindings.length === 0) return { injections: [] };
  const coreDb = input.input.coreDb!;
  const environment: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  const injections: PendingMcpVaultInjection[] = [];

  try {
    if (!input.input.vaultUnlockState) throw new Error('Vault is unavailable.');
    for (const binding of input.resolved.credentialBindings) {
      const grant = getVaultGrant(coreDb, binding.vaultGrantId);
      const reference = grant ? getVaultReference(coreDb, grant.vaultReferenceId) : null;
      assertCurrentMcpVaultAuthority(input, grant, reference);
      const planId = mcpVaultRecordId('plan', input, binding.slot, grant!.grantId);
      const receiptId = mcpVaultRecordId('receipt', input, binding.slot, grant!.grantId);
      const now = new Date().toISOString();
      createVaultInjectionPlan(coreDb, {
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
      const backend = input.input.vaultUnlockState.backend();
      if (reference!.backendKind !== backend.kind) throw new Error('Vault backend mismatch.');
      const material = createVaultUseAuditedBackend({
        agentSessionId: input.environmentPackage.scope.agentSessionId,
        backend,
        capabilityCallId: input.call.id,
        db: input.workspaceDb,
        grantId: grant!.grantId,
        ownerScope: 'workspace',
        planId,
        resolvingPath: 'grant',
        workspaceId: input.environmentPackage.scope.workspaceId,
      }).resolve({
        referenceId: reference!.referenceId,
        version: reference!.currentVersion,
      });
      const value = vaultSecretMaterialToString(material);
      if (binding.sink.kind === 'env') environment[binding.sink.name] = value;
      if (binding.sink.kind === 'header') headers[binding.sink.name] = value;
      if (binding.sink.kind === 'query') query[binding.sink.name] = value;
      injections.push({
        backendSummary: `mcp-gateway:${input.resolved.transport.kind}:${binding.sink.kind}`,
        grant,
        injectedAt: now,
        planId,
        receiptId,
      });
    }
  } catch {
    try {
      await input.input.workerMcpGateway.closeServer({
        server: input.resolved,
        workspaceId: input.environmentPackage.scope.workspaceId,
      });
    } catch {
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
      ...(Object.keys(environment).length ? { environment } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(query).length ? { query } : {}),
    },
    injections,
  };
}

/** Verifies current grant, reference, scope, target, path, and lifetime authority. */
function assertCurrentMcpVaultAuthority(
  input: {
    readonly environmentPackage: AgentEnvironmentPackage;
    readonly operation: 'mcp.list_tools' | 'mcp.call_tool';
  },
  grant: VaultGrantRecord | null,
  reference: ReturnType<typeof getVaultReference>
): asserts grant is VaultGrantRecord {
  const workspaceId = input.environmentPackage.scope.workspaceId;
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
    grant.status !== 'active' ||
    expired ||
    grant.ownerScope !== 'workspace' ||
    grant.workspaceId !== workspaceId ||
    !grant.allowedInjectionPaths.includes('gateway-only') ||
    (grant.targetAgentId !== null &&
      grant.targetAgentId !== input.environmentPackage.agent.agentId) ||
    (grant.targetAgentSessionId !== null &&
      grant.targetAgentSessionId !== input.environmentPackage.scope.agentSessionId) ||
    (grant.targetCapabilityId !== null &&
      grant.targetCapabilityId !== 'mcp' &&
      grant.targetCapabilityId !== input.operation) ||
    reference.status !== 'active' ||
    reference.ownerScope !== 'workspace' ||
    reference.workspaceId !== workspaceId
  ) {
    throw new Error('MCP Vault authority is not current.');
  }
}

/** Rechecks every credential binding immediately before the tool effect boundary. */
function assertCurrentMcpVaultBindings(input: WorkerMcpToolCallInput): void {
  for (const binding of input.resolved.credentialBindings) {
    const grant = getVaultGrant(input.input.coreDb!, binding.vaultGrantId);
    assertCurrentMcpVaultAuthority(
      { environmentPackage: input.environmentPackage, operation: 'mcp.call_tool' },
      grant,
      grant ? getVaultReference(input.input.coreDb!, grant.vaultReferenceId) : null
    );
  }
}

/** Creates receipts only after a successful credential-bearing upstream exchange. */
function completeMcpVaultInjections(
  coreDb: CoreDb,
  call: StartedCapabilityCall,
  injections: readonly PendingMcpVaultInjection[]
): void {
  coreDb.sqlite
    .transaction(() => {
      for (const injection of injections) {
        createVaultInjectionReceipt(coreDb, {
          agentSessionId: call.context.agentSessionId ?? null,
          backendSummary: injection.backendSummary,
          capabilityCallId: call.id,
          expiresAt: injection.grant.expiresAt,
          grantId: injection.grant.grantId,
          injectedAt: injection.injectedAt,
          planId: injection.planId,
          receiptId: injection.receiptId,
          revocationStatus: 'active',
        });
      }
    })
    .immediate();
}

/** Non-secret receipt metadata retained until an upstream sink succeeds. */
interface PendingMcpVaultInjection {
  readonly backendSummary: string;
  readonly grant: VaultGrantRecord;
  readonly injectedAt: string;
  readonly planId: string;
  readonly receiptId: string;
}

/** Builds a target-issued deterministic Vault record id for one binding and call. */
function mcpVaultRecordId(
  kind: 'plan' | 'receipt',
  input: {
    readonly call: StartedCapabilityCall;
    readonly environmentPackage: AgentEnvironmentPackage;
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

/** Finishes one list handler failure and returns its bounded SDK error. */
function finishMcpHandlerFailure(
  error: unknown,
  call: StartedCapabilityCall,
  workspaceDb: WorkspaceDb
): McpError {
  const normalized = finishMcpCallFailure(error, call, workspaceDb);
  return new McpError(ErrorCode.InvalidRequest, normalized.message, { code: normalized.code });
}

/** Safely terminalizes one MCP handler failure or returns a recovery-required result. */
function finishMcpCallFailure(
  error: unknown,
  call: StartedCapabilityCall,
  workspaceDb: WorkspaceDb
): WorkerControlGatewayError {
  const normalized = normalizeWorkerMcpRouteError(error);
  try {
    finishCapabilityCall({
      callId: call.id,
      errorCode: normalized.code,
      status:
        error instanceof WorkerMcpGatewayCallError && error.cancelled
          ? 'aborted'
          : normalized.code === 'mcp-denied'
            ? 'denied'
            : normalized.code === 'mcp-timeout'
              ? 'timed-out'
              : 'failed',
      workspaceDb,
    });
    return normalized;
  } catch {
    return new WorkerControlGatewayError(
      'recovery_required',
      'MCP capability recovery is required.',
      409
    );
  }
}

/** Starts one attributable MCP call through the shared durable ledger. */
function startMcpCapabilityCall(input: {
  readonly callId?: string;
  readonly capabilityId: string;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly itemId: string | null;
  readonly operation: string;
  readonly protocolRequestId: string | number;
  readonly serverId: string;
  readonly summary?: string;
  readonly toolName?: string;
  readonly workspaceDb: WorkspaceDb;
}): StartedCapabilityCall {
  const identity = mcpRequestIdentity(
    input.environmentPackage,
    input.serverId,
    input.operation,
    input.protocolRequestId
  );
  return startCapabilityCall({
    agentId: input.environmentPackage.agent.agentId,
    agentSessionId: input.environmentPackage.scope.agentSessionId,
    authorityActor: input.environmentPackage.scope.triggerActor,
    callId: input.callId ?? `cap_mcp_${identity}`,
    capabilityId: input.capabilityId,
    family: 'mcp',
    itemId: input.itemId,
    operation: input.operation,
    packageSnapshotId: input.environmentPackage.snapshotId,
    providerRef: input.serverId,
    redactionClass: 'metadata-only',
    requestId: null,
    serviceRef: input.toolName ? `mcp-tool:${input.toolName}` : 'mcp-gateway',
    sourceIds: [],
    summary: input.summary ?? `MCP ${input.operation} for ${input.serverId}.`,
    threadId: input.environmentPackage.scope.threadId,
    turnId: input.environmentPackage.scope.turnId,
    workspaceDb: input.workspaceDb,
    workspaceId: input.environmentPackage.scope.workspaceId,
  });
}

/** Publishes one terminal product-safe tool-call Item after the ledger winner. */
function publishWorkerMcpItem(input: {
  readonly call: StartedCapabilityCall;
  readonly durationMs: number;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly errorCode: string | null;
  readonly itemId: string;
  readonly serverId: string;
  readonly status: 'completed' | 'declined' | 'failed';
  readonly store: FsStore;
  readonly toolName: string;
}): void {
  const completedAt = new Date().toISOString();
  input.store.createItem({
    arguments: null,
    causationId: input.call.id,
    completedAt,
    createdAt: completedAt,
    durationMs: input.durationMs,
    error: input.errorCode,
    id: input.itemId,
    ...(input.environmentPackage.scope.itemId
      ? { parentItemId: input.environmentPackage.scope.itemId }
      : {}),
    result: null,
    server: input.serverId,
    status: input.status,
    threadId: input.environmentPackage.scope.threadId,
    tool: input.toolName,
    turnId: input.environmentPackage.scope.turnId,
    type: 'tool-call',
    workspaceId: input.environmentPackage.scope.workspaceId,
  });
}

/** Resolves the exact AEP-selected server without caller-supplied topology. */
function requireSelectedMcpServer(environmentPackage: AgentEnvironmentPackage, serverId: string) {
  if (environmentPackage.capabilities.mode !== 'enabled') throw unavailableServer();
  const server = environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === serverId
  );
  if (!server) throw unavailableServer();
  return server;
}

/** Rejects a stale or unauthorized AEP actor before opening Workspace effect state. */
function requireCurrentMcpWorkspaceAuthority(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackage
): void {
  if (!hasCurrentMcpWorkspaceAuthority(coreDb, environmentPackage)) {
    throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
  }
}

/** Returns whether current Workspace authority still permits this AEP actor to use tools. */
function hasCurrentMcpWorkspaceAuthority(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackage
): boolean {
  return Boolean(
    currentWorkspaceAuthority(
      coreDb,
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.triggerActor,
      'tool.use',
      true
    )
  );
}

/** Rejects every capability admission after an exact same-Turn Gate becomes durable. */
function requireMcpCapabilityTurnAdmission(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage
): void {
  if (!hasMcpCapabilityTurnAdmission(store, environmentPackage)) {
    throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
  }
}

/** Returns whether the exact same Turn still admits another worker capability request. */
function hasMcpCapabilityTurnAdmission(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage
): boolean {
  const turn = store.getTurnById(environmentPackage.scope.turnId);
  return (
    (turn.workspaceId !== environmentPackage.scope.workspaceId ||
      turn.threadId !== environmentPackage.scope.threadId ||
      turn.status !== 'running' ||
      turn.humanGate !== null) === false
  );
}

/** Builds a stable Item id for one product-visible tool call. */
function workerMcpItemId(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  toolName: string,
  protocolRequestId: string | number
): string {
  return `it_mcp_${mcpRequestIdentity(environmentPackage, serverId, toolName, protocolRequestId)}`;
}

/** Returns one deterministic identity for a request inside its immutable AEP lineage. */
function mcpRequestIdentity(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  operation: string,
  protocolRequestId: string | number
): string {
  return createHash('sha256')
    .update(
      `${environmentPackage.snapshotId}\n${serverId}\n${operation}\n${JSON.stringify(protocolRequestId)}`
    )
    .digest('hex')
    .slice(0, 24);
}

/** Returns the stable unavailable-server failure without catalog disclosure. */
function unavailableServer(): WorkerControlGatewayError {
  return new WorkerControlGatewayError('mcp-server-unavailable', 'MCP server is unavailable.', 503);
}

/** Maps one private route failure to the closed worker-visible vocabulary. */
function normalizeWorkerMcpRouteError(error: unknown): WorkerControlGatewayError {
  if (error instanceof WorkerControlGatewayError) return error;
  return new WorkerControlGatewayError('mcp-call-failed', 'MCP tool call failed.', 503);
}

/** Returns one bounded JSON-RPC failure for pre-protocol request rejection. */
function workerMcpHttpError(error: unknown): Response {
  const normalized = normalizeWorkerMcpRouteError(error);
  return Response.json(
    {
      error: {
        code: ErrorCode.InvalidRequest,
        data: { code: normalized.code },
        message: normalized.message,
      },
      id: null,
      jsonrpc: '2.0',
    },
    { status: normalized.status }
  );
}
