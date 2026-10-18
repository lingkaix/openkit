import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CancelledNotificationSchema } from '@modelcontextprotocol/core';
import {
  createMcpHandler,
  isLegacyRequest,
  type ListToolsResult,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { operationToolName } from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  OpenKitConfig,
  WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import { resolveWorkspaceMcpServer, WorkspaceMcpToolNameSchema } from '@openkit/config-schema';
import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  type ActorRef,
  allocateEntityId,
  CapabilityCallStatusSchema,
  deriveEntityId,
  ItemSchema,
  isSealedTurnTerminal,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Hono } from 'hono';
import type { AuthVariables } from './auth/middleware.js';
import {
  currentWorkerLineageWorkspaceAuthority,
  currentWorkspaceAuthority,
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import {
  finishCapabilityCall,
  recordUsage,
  type StartedCapabilityCall,
  stampCapabilityCallSchemaSnapshot,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import { composeWorkspaceMcpCatalog } from './catalog/resource-catalog.js';
import type { RuntimeConfigSnapshot } from './config/runtime-config.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { readWorkspaceNotebookAdmission } from './knowledge/notebook-workspace-admission.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  DISPLAY_PROJECTION_REFRESH_FIELDS,
  type FsStore,
} from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { OperationError, projectOperationError } from './operation-error.js';
import { preflightPendingToolRequest } from './pending-request-operations.js';
import { readAdmittedPolicyDocument } from './policy/configuration.js';
import { type InterceptionInput, PolicyInterception } from './policy/interception.js';
import { recordProductPermissionDecision } from './policy/permission-decisions.js';
import { readPermissionDecisionRowV1 } from './policy/retained-records-v1.js';
import { policyDigest, policyProposalDigest, selectPolicyBindings } from './policy/statements.js';
import { findNamedAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import type { PreparedCapturedPendingCall } from './runtime/captured-pending-call.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import {
  mcpToolArgumentsContentDigest,
  mcpToolSchemaContentDigest,
  readCurrentMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
  WorkerCapabilityMcpToolSchema,
} from './runtime/mcp-tool-schema-snapshots.js';
import {
  dispatchOpenkitGenerativeTool,
  OPENKIT_GENERATIVE_CATALOG_DIGEST,
  OPENKIT_GENERATIVE_MCP_ID,
  OPENKIT_GENERATIVE_TOOLS,
} from './runtime/openkit-generative-mcp.js';
import {
  dispatchOpenkitWorkTool,
  OPENKIT_WORK_CATALOG_DIGEST,
  OPENKIT_WORK_MCP_ID,
  OPENKIT_WORK_TOOLS,
  preflightWorkRequestInput,
  workRequestInputIsSecret,
} from './runtime/openkit-work-mcp.js';
import { approvalCardCopy } from './runtime/pending-request-disclosure.js';
import { pendingToolResult, raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import {
  canonicalJsonText,
  executionCallIdForRequest,
  type PendingRequestRecord,
  type RaisePendingRequestInput,
} from './runtime/pending-requests.js';
import {
  type WorkerControlGateway,
  WorkerControlGatewayError,
} from './runtime/worker-control-gateway.js';
import type { WorkerArtifactCapture } from './runtime/worker-governance-backend.js';
import type {
  WorkerMcpGateway,
  WorkerMcpGatewayCredentials,
} from './runtime/worker-mcp-gateway.js';
import { WorkerMcpGatewayCallError } from './runtime/worker-mcp-gateway.js';
import {
  requireWorkerRawOutputAvailable,
  WorkerRawOutputAuthorityError,
  WorkerRawOutputBudgetExceededError,
} from './runtime/worker-raw-output.js';
import {
  type CoreDb,
  listExistingWorkspaceDatabaseScopes,
  openBootVerifiedWorkspaceDb,
  openWorkspaceDb,
  type WorkspaceDb,
} from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { isTargetIssuedEffectAuthority } from './storage/workspace-import-authority.js';
import { isCurrentServerMcpMaterial } from './vault/server-mcp-authority.js';
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
  readonly interception: PolicyInterception;
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
  /** Deterministic pilot participant injected by the native composition or tests. */
  readonly interception?: PolicyInterception;
  readonly automationStore?: OperationInvocationDependencies['automationStore'];
  readonly turnStartServices?: OperationInvocationDependencies['turnStartServices'];
  readonly knowledgeAgent?: OperationInvocationDependencies['knowledgeAgent'];
  /** Existing configured-runtime capture; no secondary backend or registry. */
  readonly captureArtifact?: WorkerArtifactCapture;
  /** Shared Data Root capacity owner for live Artifact capture. */
  readonly fileAdmission?: import('./storage/artifacts/file-admission.js').FileStorageAdmission;
  /** Startup-owned deployment push approval policy. */
  readonly approvalPolicy?: OpenKitConfig['policy'];
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
}

/** Registers the private per-catalog-entry MCP Streamable HTTP endpoint. */
export function registerWorkerMcpRoutes(input: RegisterWorkerMcpRoutesInput): void {
  const interception = input.interception ?? new PolicyInterception();
  const activeRequests = new Map<string, AbortController>();
  const toolCallTails = new Map<string, Promise<void>>();
  const builtinInflight = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
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
      const localCatalog = input
        .runtimeConfig()
        .workspaceMcpServerCatalogs.find(
          (entry) => entry.workspaceId === environmentPackage.scope.workspaceId
        )?.catalog;
      const catalog = composeWorkspaceMcpCatalog({
        dataRoot: input.coreDb.dataRoot,
        workspaceId: environmentPackage.scope.workspaceId,
        workspaceCatalog: localCatalog ?? { schemaVersion: 1, servers: [] },
      });
      workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, environmentPackage.scope.workspaceId);
      applyScopedMigrations(workspaceDb);
      call = startCapabilityCall({
        agentId: environmentPackage.agent.agentId,
        agentSessionId: environmentPackage.scope.agentSessionId,
        authorityActor: environmentPackage.scope.triggerActor,
        callId: allocateEntityId('cap'),
        capabilityId: 'mcp.list-servers',
        family: 'mcp',
        itemId: environmentPackage.scope.itemId ?? null,
        operation: 'mcp.list-servers',
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
        const listedBuiltin = builtinWorkerMcpServer(selected.id);
        if (listedBuiltin) {
          if (selected.catalogDigest !== listedBuiltin.digest) {
            throw unavailableServer();
          }
          return {
            health: 'ready' as const,
            id: selected.id,
            toolNames: [...selected.allowedTools],
            transport: 'stdio' as const,
          };
        }
        if (!catalog) throw unavailableServer();
        const resolved = resolveWorkspaceMcpServer({ catalog, serverId: selected.id });
        if (resolved.catalogDigest !== selected.catalogDigest) throw unavailableServer();
        const snapshot =
          readTurnMcpToolSchemaSnapshot({
            environmentPackage,
            selected,
            workspaceDb: workspaceDb!,
          }) ??
          readCurrentMcpToolSchemaSnapshot({
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
      const builtin = builtinWorkerMcpServer(serverId);
      if (builtin) {
        const workBuiltin = serverId === OPENKIT_WORK_MCP_ID;
        const tools = builtin.tools;
        if (selected.catalogDigest !== builtin.digest) {
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
                mcpActiveRequestKey(
                  environmentPackage,
                  serverId,
                  cancellation.data.params.requestId
                )
              )
              ?.abort(new DOMException('MCP caller cancelled request.', 'AbortError'));
          }
          return new Response(null, { status: 202 });
        }
        const mcp = new Server(
          { name: `openkit-${serverId}`, version: '1.0.0' },
          { capabilities: { tools: {} } }
        );
        server = mcp;
        mcp.setRequestHandler('tools/list', async () => {
          if (!hasCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage)) {
            throw mcpDeniedError();
          }
          requireMcpCapabilityTurnAdmission(input.store, environmentPackage);
          return {
            tools: tools
              .filter(
                (tool) =>
                  selected.allowedTools.includes(tool.name) &&
                  !selected.deniedTools.includes(tool.name)
              )
              .map((tool) => ({
                name: tool.name,
                description:
                  tool.name === 'work_artifact_submit'
                    ? `${tool.description} Eligible roots: ${
                        environmentPackage.workspace.outputs
                          .filter(
                            (output) =>
                              output.registerAsArtifacts && output.retention === 'sync-on-turn-end'
                          )
                          .map((output) => output.path)
                          .join(', ') || 'none'
                      }.`
                    : tool.description,
                inputSchema: tool.inputSchema,
              })),
          } as ListToolsResult;
        });
        mcp.setRequestHandler('tools/call', async (request, ctx) => {
          const execute = async () => {
            if (!hasCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage)) {
              throw mcpDeniedError();
            }
            const toolCancellation = registerMcpActiveRequest(
              activeRequests,
              environmentPackage,
              serverId,
              ctx.mcpReq.id,
              ctx.mcpReq.signal
            );
            const releaseMutation = input.workspaceMutationAdmission.enter(
              environmentPackage.scope.workspaceId
            );
            if (!releaseMutation) {
              toolCancellation.release();
              throw mcpDeniedError();
            }
            let activeWorkspaceDb: WorkspaceDb | null = null;
            try {
              requireMcpCapabilityTurnAdmission(input.store, environmentPackage);
              requireCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage);
              if (
                !selected.allowedTools.includes(request.params.name) ||
                selected.deniedTools.includes(request.params.name)
              ) {
                throw mcpDeniedError();
              }
              if (selected.approvalRequiredTools.includes(request.params.name)) {
                throw mcpDeniedError();
              }
              if (
                workBuiltin &&
                request.params.name === 'work_input_request' &&
                workRequestInputIsSecret(
                  (request.params.arguments ?? {}) as Record<string, unknown>
                )
              ) {
                throw new WorkerControlGatewayError(
                  'secret_input_not_supported',
                  'Secret input is not supported.',
                  400
                );
              }
              activeWorkspaceDb = openWorkspaceDb(
                input.coreDb!.dataRoot,
                environmentPackage.scope.workspaceId
              );
              applyScopedMigrations(activeWorkspaceDb);
              requireRawOutputCapabilityAdmission(activeWorkspaceDb, environmentPackage);
              if (workBuiltin && request.params.name === 'work_input_request') {
                try {
                  const duplicate = preflightWorkRequestInput(
                    environmentPackage,
                    activeWorkspaceDb,
                    request.params.arguments ?? {}
                  );
                  if (duplicate) return mcp.projectCallToolResult(duplicate, undefined);
                } catch (error) {
                  if (error instanceof ProtocolError) throw error;
                  const normalized = normalizeWorkerMcpRouteError(error);
                  throw new ProtocolError(
                    ProtocolErrorCode.InvalidRequest,
                    normalized.message,
                    projectOperationError(normalized) ?? { code: normalized.code }
                  );
                }
              }

              const call = startMcpCapabilityCall({
                capabilityId: `mcp.call-tool.${request.params.name}`,
                environmentPackage,
                itemId: environmentPackage.scope.itemId ?? null,
                operation: 'mcp.call-tool',
                protocolRequestId: ctx.mcpReq.id,
                serverId,
                toolName: request.params.name,
                workspaceDb: activeWorkspaceDb,
              });
              try {
                if (workBuiltin) {
                  const result = await dispatchOpenkitWorkTool(
                    {
                      coreDb: input.coreDb!,
                      environmentPackage,
                      store: input.store,
                      workspaceDb: activeWorkspaceDb,
                      knowledgeAgent: input.knowledgeAgent,
                      automationStore: input.automationStore,
                      turnStartServices: input.turnStartServices,
                      knowledgeCallId: call.id,
                      knowledgePublicationAdmission: (publication) =>
                        readWorkspaceNotebookAdmission({
                          store: input.store,
                          coreDb: input.coreDb!,
                          workspaceDb: activeWorkspaceDb!,
                          request: publication,
                          actor: {
                            kind: 'user',
                            id: responsibleUserIdForActor(environmentPackage.scope.triggerActor)!,
                          },
                          currentAuthority: () => {
                            requireMcpCapabilityTurnAdmission(input.store, environmentPackage);
                            requireCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage);
                            if (
                              !currentWorkerLineageWorkspaceAuthority(
                                input.coreDb!,
                                {
                                  ...environmentPackage.scope,
                                  packageSnapshotId: environmentPackage.snapshotId,
                                },
                                'knowledge.write',
                                true
                              )
                            )
                              throw mcpDeniedError();
                          },
                          notebook: new KnowledgeNotebook({
                            repositoryPath: join(
                              input.coreDb!.dataRoot,
                              'workspaces',
                              environmentPackage.scope.workspaceId,
                              'knowledge',
                              'notebook.git'
                            ),
                          }),
                          runtimeConfigManager: { current: input.runtimeConfig },
                          workspaceMutationAdmission: input.workspaceMutationAdmission,
                        }),
                      ...(input.fileAdmission ? { fileAdmission: input.fileAdmission } : {}),
                      ...(input.captureArtifact ? { captureArtifact: input.captureArtifact } : {}),
                      signal: toolCancellation.signal,
                      requireAdmission: () => {
                        requireMcpCapabilityTurnAdmission(input.store, environmentPackage);
                        requireRawOutputCapabilityAdmission(activeWorkspaceDb!, environmentPackage);
                        requireCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage);
                        if (
                          [
                            operationToolName('knowledge.ask'),
                            operationToolName('knowledge.tell'),
                          ].includes(request.params.name) &&
                          !currentWorkerLineageWorkspaceAuthority(
                            input.coreDb!,
                            {
                              ...environmentPackage.scope,
                              packageSnapshotId: environmentPackage.snapshotId,
                            },
                            request.params.name === operationToolName('knowledge.ask')
                              ? 'knowledge.read'
                              : 'knowledge.write',
                            true
                          )
                        )
                          throw mcpDeniedError();
                        if (request.params.name === 'work_artifact_submit')
                          requireCurrentArtifactWorkspaceAuthority(
                            input.coreDb!,
                            environmentPackage
                          );
                      },
                    },
                    request.params.name,
                    (request.params.arguments ?? {}) as Record<string, unknown>
                  );
                  const delivered = mcp.projectCallToolResult(result, undefined);
                  finishCapabilityCall({
                    callId: call.id,
                    status: 'succeeded',
                    workspaceDb: activeWorkspaceDb,
                    ...(request.params.name === operationToolName('knowledge.ask')
                      ? { deliveredKnowledgeAnswer: JSON.stringify(delivered) }
                      : {}),
                  });
                  return delivered;
                }
                const result = await dispatchOpenkitGenerativeTool(
                  {
                    coreDb: input.coreDb!,
                    ...(input.vaultUnlockState ? { vaultUnlockState: input.vaultUnlockState } : {}),
                    workspaceMutationAdmission: input.workspaceMutationAdmission,
                    packageSnapshotId: environmentPackage.snapshotId,
                    store: input.store,
                    inflightCommands: builtinInflight,
                    dataRoot: input.coreDb!.dataRoot,
                    workspaceId: environmentPackage.scope.workspaceId,
                    actor: environmentPackage.scope.triggerActor,
                    workspaceDb: activeWorkspaceDb,
                    scope: environmentPackage.scope,
                    protocolRequestId: ctx.mcpReq.id,
                  },
                  request.params.name,
                  (request.params.arguments ?? {}) as Record<string, unknown>
                );
                finishCapabilityCall({
                  callId: call.id,
                  status: 'succeeded',
                  workspaceDb: activeWorkspaceDb,
                });
                return mcp.projectCallToolResult(result, undefined);
              } catch (error) {
                throw finishMcpHandlerFailure(error, call, activeWorkspaceDb);
              }
            } finally {
              activeWorkspaceDb?.sqlite.close();
              releaseMutation();
              toolCancellation.release();
            }
          };
          return execute();
        });
        return await serveStatelessWorkerMcp(context.req.raw, protocolMessage, () => {
          if (!server) throw new Error('Worker MCP server was not constructed.');
          return server;
        });
      }
      const localCatalog = input
        .runtimeConfig()
        .workspaceMcpServerCatalogs.find(
          (entry) => entry.workspaceId === environmentPackage.scope.workspaceId
        )?.catalog;
      const catalog = composeWorkspaceMcpCatalog({
        dataRoot: input.coreDb.dataRoot,
        workspaceId: environmentPackage.scope.workspaceId,
        workspaceCatalog: localCatalog ?? { schemaVersion: 1, servers: [] },
      });
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
      const mcp = new Server(
        { name: `openkit-${serverId}`, version: '1.0.0' },
        { capabilities: { tools: {} } }
      );
      server = mcp;
      mcp.setRequestHandler('tools/list', async (_request, ctx) => {
        if (!hasCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage)) {
          throw mcpDeniedError();
        }
        const cancellation = registerMcpActiveRequest(
          activeRequests,
          environmentPackage,
          serverId,
          ctx.mcpReq.id,
          ctx.mcpReq.signal
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
            capabilityId: 'mcp.list-tools',
            environmentPackage,
            itemId: environmentPackage.scope.itemId ?? null,
            operation: 'mcp.list-tools',
            serverId,
            protocolRequestId: ctx.mcpReq.id,
            workspaceDb: activeWorkspaceDb,
          });
          try {
            requireMcpCapabilityTurnAdmission(input.store, environmentPackage);
            requireCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage);
            const current = readTurnMcpToolSchemaSnapshot({
              environmentPackage,
              selected,
              workspaceDb: activeWorkspaceDb,
            });
            if (current) {
              stampCapabilityCallSchemaSnapshot({
                callId: call.id,
                schemaSnapshotId: current.schemaSnapshotId,
                workspaceDb: activeWorkspaceDb,
              });
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
              return result as ListToolsResult;
            }
            const observed = await observeWorkerMcpTools({
              call,
              environmentPackage,
              input,
              operation: 'mcp.list-tools',
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
            return result as ListToolsResult;
          } catch (error) {
            throw finishMcpHandlerFailure(error, call, activeWorkspaceDb);
          }
        } finally {
          activeWorkspaceDb?.sqlite.close();
          releaseMutation();
          cancellation.release();
        }
      });
      mcp.setRequestHandler('tools/call', async (request, ctx) => {
        if (!hasCurrentMcpWorkspaceAuthority(input.coreDb!, environmentPackage)) {
          throw mcpDeniedError();
        }
        const cancellation = registerMcpActiveRequest(
          activeRequests,
          environmentPackage,
          serverId,
          ctx.mcpReq.id,
          ctx.mcpReq.signal
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
              requireRawOutputCapabilityAdmission(activeWorkspaceDb, environmentPackage);
              return await callWorkerMcpTool({
                interception,
                arguments: request.params.arguments ?? {},
                environmentPackage,
                input,
                protocolRequestId: ctx.mcpReq.id,
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
          const result = await (selected.approvalRequiredTools.includes(request.params.name)
            ? serializeMcpToolCall(
                toolCallTails,
                `${environmentPackage.scope.workspaceId}:${environmentPackage.scope.turnId}`,
                call
              )
            : call());
          return mcp.projectCallToolResult(result, undefined);
        } finally {
          cancellation.release();
        }
      });
      return await serveStatelessWorkerMcp(context.req.raw, protocolMessage, () => {
        if (!server) throw new Error('Worker MCP server was not constructed.');
        return server;
      });
    } catch (error) {
      return workerMcpHttpError(error);
    } finally {
      await server?.close().catch(() => undefined);
    }
  });
}

/**
 * Serves one worker MCP POST on both protocol eras.
 * Legacy requests stay JSON and stateless. Modern requests use the SDK's per-request handler.
 * The factory runs once for the era that actually serves the request.
 */
async function serveStatelessWorkerMcp(
  request: Request,
  parsedBody: unknown,
  factory: () => Server
): Promise<Response> {
  const handler = createMcpHandler(() => factory(), {
    legacy: 'reject',
    responseMode: 'json',
  });
  const parsed = parsedBody === null ? undefined : parsedBody;
  try {
    if (await isLegacyRequest(request, parsed)) {
      const server = factory();
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(
          request,
          parsed === undefined ? undefined : { parsedBody: parsed }
        );
      } finally {
        await server.close().catch(() => undefined);
      }
    }
    return await handler.fetch(request, parsed === undefined ? undefined : { parsedBody: parsed });
  } finally {
    await handler.close().catch(() => undefined);
  }
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

/**
 * Returns whether one stored MCP Item matches the ledger-owned decided publication.
 *
 * @param existing Stored Item.
 * @param candidate Ledger reconstruction.
 * @param parentComparable Whether the AEP snapshot supplied the decided `parentItemId`.
 * @returns True when identity, lineage, timestamps, status, tool, server, arguments, result, and error match.
 */
function mcpBootDecidedPublicationEqual(
  existing: ReturnType<FsStore['listAllItems']>[number],
  candidate: ReturnType<FsStore['listAllItems']>[number],
  parentComparable: boolean
): boolean {
  const recorded = existing as unknown as Record<string, unknown>;
  const reconstructed = candidate as unknown as Record<string, unknown>;
  return (
    existing.id === candidate.id &&
    existing.workspaceId === candidate.workspaceId &&
    existing.threadId === candidate.threadId &&
    existing.turnId === candidate.turnId &&
    existing.type === candidate.type &&
    existing.status === candidate.status &&
    existing.causationId === candidate.causationId &&
    (!parentComparable ||
      (recorded.parentItemId ?? null) === (reconstructed.parentItemId ?? null)) &&
    existing.createdAt === candidate.createdAt &&
    existing.completedAt === candidate.completedAt &&
    recorded.durationMs === reconstructed.durationMs &&
    recorded.tool === reconstructed.tool &&
    recorded.server === reconstructed.server &&
    isDeepStrictEqual(recorded.arguments, reconstructed.arguments) &&
    recorded.result === reconstructed.result &&
    recorded.error === reconstructed.error
  );
}

/**
 * Resolves the `parentItemId` the decided MCP publication carried, from the AEP snapshot the call row names.
 *
 * Three outcomes, because a row that names no snapshot and a row whose named snapshot is unreadable are
 * not the same fact. A row with no snapshot lineage has nothing to be faithful to and is filled as the
 * earlier reader filled it. A row that names a snapshot the reader cannot open is a publication this boot
 * cannot reconstruct, so the caller leaves it for a later boot rather than publishing an Item that is not
 * the decided one. A snapshot that exists and does not validate still throws, because that is corruption
 * rather than absence.
 *
 * @param workspaceDb Open workspace database that owns the snapshot.
 * @param workspaceId Workspace that owns the call row.
 * @param row Terminal MCP call row with its AgentSession and snapshot lineage.
 * @returns Decided parent, an unnamed snapshot, or a named snapshot that could not be read.
 */
function decidedMcpParentItemId(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  row: { readonly agent_session_id: string | null; readonly package_snapshot_id: string | null }
):
  | { readonly kind: 'decided'; readonly parentItemId: string | null }
  | { readonly kind: 'no-snapshot-named' }
  | { readonly kind: 'snapshot-unreadable' } {
  if (!row.agent_session_id || !row.package_snapshot_id) {
    return { kind: 'no-snapshot-named' };
  }
  if (!isAddressableSnapshotLineage(row.agent_session_id, row.package_snapshot_id)) {
    return { kind: 'snapshot-unreadable' };
  }
  let snapshot: ReturnType<typeof findNamedAgentEnvironmentPackageSnapshot>;
  try {
    snapshot = findNamedAgentEnvironmentPackageSnapshot(
      workspaceDb,
      workspaceId,
      row.agent_session_id,
      row.package_snapshot_id
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    // This caller defers unavailable publication inputs; the shared proof reader stays strict.
    if (
      error instanceof Error &&
      typeof failure.errno === 'number' &&
      ['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE'].includes(failure.code ?? '') &&
      ['lstat', 'open', 'read'].includes(failure.syscall ?? '')
    ) {
      return { kind: 'snapshot-unreadable' };
    }
    throw error;
  }
  return snapshot
    ? { kind: 'decided', parentItemId: snapshot.snapshot.scope.itemId ?? null }
    : { kind: 'snapshot-unreadable' };
}

/**
 * Returns whether a stored lineage pair can address a snapshot file at all.
 *
 * A lineage that is not a single path segment cannot name a file, so it reads as unreadable rather
 * than throwing out of the path assertion inside the finder.
 *
 * @param agentSessionId Stored AgentSession lineage.
 * @param snapshotId Stored AEP snapshot lineage.
 * @returns True when both values are single path segments.
 */
function isAddressableSnapshotLineage(agentSessionId: string, snapshotId: string): boolean {
  const addressable = (value: string): boolean =>
    value !== '.' && value !== '..' && !/[/\\\0]/.test(value);
  return addressable(agentSessionId) && addressable(snapshotId);
}

/** Ledger fields that own the product-safe terminal MCP Item publication. */
interface DecidedMcpPublicationRow {
  agent_id: string | null;
  agent_session_id: string | null;
  call_id: string;
  completed_at: string;
  error_code: string | null;
  item_id: string;
  package_snapshot_id: string | null;
  provider_ref: string;
  service_ref: string;
  started_at: string | null;
  status: string;
  thread_id: string;
  turn_id: string;
  workspace_id: string;
}

/**
 * Reconstructs the ledger-owned publication used by boot and terminal recovery.
 *
 * @param workspaceId Owning Workspace.
 * @param row Terminal MCP call with complete publication fields.
 * @param parentItemId Parent established by the call's immutable AEP snapshot.
 * @returns Validated product-safe MCP Item.
 */
function decidedMcpPublicationItem(
  workspaceId: string,
  row: DecidedMcpPublicationRow,
  parentItemId: string | null
): ReturnType<FsStore['listAllItems']>[number] {
  return ItemSchema.parse({
    arguments: null,
    causationId: row.call_id,
    completedAt: row.completed_at,
    createdAt: row.completed_at,
    durationMs: row.started_at
      ? Math.max(0, Date.parse(row.completed_at) - Date.parse(row.started_at))
      : 0,
    error: row.status === 'succeeded' ? null : row.error_code,
    id: row.item_id,
    ...(parentItemId ? { parentItemId } : {}),
    result: null,
    server: row.provider_ref,
    status:
      row.status === 'succeeded' ? 'completed' : row.status === 'denied' ? 'declined' : 'failed',
    threadId: row.thread_id,
    tool: row.service_ref.slice('mcp-tool:'.length),
    turnId: row.turn_id,
    type: 'tool-call',
    workspaceId,
  });
}

/**
 * Proves an additional terminal-Turn Item completes its pre-terminal MCP decision.
 *
 * This is read-only: the admission marker alone is not evidence of a decided call.
 * Missing canonical lineage or a decision after terminalization cannot authorize repair.
 *
 * @param workspaceDb Existing Workspace capability ledger.
 * @param environmentPackage Exact package already validated by the recovery owner.
 * @param item Additional current Item absent from the older terminal event.
 * @param completedAt Immutable Turn completion time.
 * @returns True only for the exact decided publication, apart from admitted display fields.
 */
export function isAlreadyDecidedWorkerMcpItem(
  workspaceDb: WorkspaceDb,
  environmentPackage: AgentEnvironmentPackage,
  item: ReturnType<FsStore['listAllItems']>[number],
  completedAt: string | null
): boolean {
  if (item.type !== 'tool-call' || !item.causationId || !completedAt) return false;
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT * FROM capability_calls WHERE call_id = ?
       AND family = 'mcp' AND capability_id = 'mcp.call-tool' AND operation = 'mcp.call-tool'
       AND status NOT IN ('queued', 'running')
       AND item_id IS NOT NULL AND provider_ref IS NOT NULL
       AND service_ref LIKE 'mcp-tool:%' AND completed_at IS NOT NULL`
    )
    .get(item.causationId) as DecidedMcpPublicationRow | undefined;
  const scope = environmentPackage.scope;
  if (
    !row ||
    !CapabilityCallStatusSchema.safeParse(row.status).success ||
    row.workspace_id !== scope.workspaceId ||
    row.thread_id !== scope.threadId ||
    row.turn_id !== scope.turnId ||
    row.agent_id !== environmentPackage.agent.agentId ||
    row.agent_session_id !== scope.agentSessionId ||
    row.package_snapshot_id !== environmentPackage.snapshotId ||
    row.item_id !== item.id ||
    !row.started_at ||
    !(Date.parse(row.started_at) <= Date.parse(row.completed_at)) ||
    !(Date.parse(row.completed_at) <= Date.parse(completedAt))
  )
    return false;
  const parent = decidedMcpParentItemId(workspaceDb, scope.workspaceId, row);
  if (parent.kind !== 'decided') return false;
  const candidate = decidedMcpPublicationItem(scope.workspaceId, row, parent.parentItemId);
  // Keep repair equality separate from the Store's display refresh admission.
  const decidedFields = (value: ReturnType<FsStore['listAllItems']>[number]) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([field]) => !DISPLAY_PROJECTION_REFRESH_FIELDS.some((allowed) => allowed === field)
      )
    );
  return isDeepStrictEqual(decidedFields(item), decidedFields(candidate));
}

/** Recreates missing product-safe MCP Items from terminal durable CapabilityCalls at boot. */
export function reconcileWorkerMcpItems(dataRoot: string, store: FsStore): number {
  let recovered = 0;
  for (const { workspaceId } of listExistingWorkspaceDatabaseScopes(dataRoot)) {
    const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
    try {
      const rows = workspaceDb.sqlite
        .prepare(
          `SELECT
             agent_id,
             agent_session_id,
             call_id,
             completed_at,
             error_code,
             item_id,
             package_snapshot_id,
             provider_ref,
             service_ref,
             started_at,
             status,
             thread_id,
             turn_id,
             workspace_id
           FROM capability_calls
           WHERE family = 'mcp'
             AND capability_id = 'mcp.call-tool'
             AND operation = 'mcp.call-tool'
             AND status NOT IN ('queued', 'running')
             AND item_id IS NOT NULL
             AND provider_ref IS NOT NULL
             AND service_ref LIKE 'mcp-tool:%'
             AND thread_id IS NOT NULL
             AND turn_id IS NOT NULL
             AND completed_at IS NOT NULL
           ORDER BY completed_at, call_id`
        )
        .all() as DecidedMcpPublicationRow[];
      const storedItems = new Map(store.listAllItems().map((item) => [item.id, item]));
      for (const row of rows) {
        const decidedParent = decidedMcpParentItemId(workspaceDb, workspaceId, row);
        const parentItemId = decidedParent.kind === 'decided' ? decidedParent.parentItemId : null;
        const parsed = decidedMcpPublicationItem(workspaceId, row, parentItemId);
        const existing = storedItems.get(row.item_id);
        if (existing) {
          if (!mcpBootDecidedPublicationEqual(existing, parsed, decidedParent.kind === 'decided')) {
            throw new Error(
              `MCP boot backfill conflicts with already-decided Item: ${row.item_id}`
            );
          }
          continue;
        }
        if (decidedParent.kind === 'snapshot-unreadable') {
          // This row names a snapshot that cannot be opened, so the decided publication cannot be
          // rebuilt. Publishing an Item without its parent would substitute a different record for
          // the one the grid admits filling. Leave the row for a later boot instead.
          continue;
        }
        storedItems.set(parsed.id, store.createItem(parsed, ALREADY_DECIDED_PUBLICATION_ADMISSION));
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
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'MCP tool is unavailable.', {
      code: 'mcp-tool-not-found',
    });
  }
  const available =
    input.selected.allowedTools.includes(input.toolName) &&
    !input.selected.deniedTools.includes(input.toolName);
  const approvalRequired =
    available && input.selected.approvalRequiredTools.includes(input.toolName);
  const currentSnapshot = approvalRequired
    ? (readTurnMcpToolSchemaSnapshot(input) ??
      readCurrentMcpToolSchemaSnapshot({
        catalogEntryId: input.serverId,
        pinnedSchemaSnapshotId: input.selected.pinnedSchemaSnapshotId,
        workspaceDb: input.workspaceDb,
        workspaceId: input.environmentPackage.scope.workspaceId,
      }))
    : null;
  const itemId = workerMcpItemId(
    input.environmentPackage,
    input.serverId,
    input.toolName,
    input.protocolRequestId
  );
  const requestCallId = deriveEntityId(
    'cap',
    mcpRequestName(
      input.environmentPackage,
      input.serverId,
      'mcp.call-tool',
      input.protocolRequestId
    )
  );
  const now = new Date().toISOString();
  const identity = createHash('sha256').update(requestCallId).digest('hex').slice(0, 24);
  const { title, description } = approvalCardCopy(
    `Approve MCP tool ${input.serverId}/${input.toolName}`,
    `Allow one ${input.serverId}/${input.toolName} MCP tool call.`
  );
  const canonicalArgumentsJson = canonicalJsonText(input.arguments);
  const capturedInput = (
    snapshot: NonNullable<ReturnType<typeof readCurrentMcpToolSchemaSnapshot>>,
    policyDecisionId: string | null
  ): RaisePendingRequestInput => {
    const effect = mcpApprovalEffect(input, snapshot.schemaSnapshotId);
    return {
      requestId: `ap_mcp_${identity}`,
      workspaceId: effect.workspaceId,
      threadId: effect.threadId,
      raisingTurnId: input.environmentPackage.scope.turnId,
      requestItemId: deriveEntityId('it', [`ap_mcp_${identity}`, 'request']),
      kind: 'approval',
      requesterKind: 'worker',
      agentId: effect.agentId,
      agentSessionId: input.environmentPackage.scope.agentSessionId,
      responsibleUserId: effect.responsibleUserId,
      call: {
        serverId: input.serverId,
        catalogRevision: effect.catalogEntryRevision,
        schemaSnapshotId: snapshot.schemaSnapshotId,
        toolName: input.toolName,
        canonicalArgumentsJson,
        argumentsDigest: effect.argumentsDigest,
        packageDigest: input.environmentPackage.snapshotId,
        policyDecisionId,
        authorizationContext: {
          threadId: effect.threadId,
          turnId: input.environmentPackage.scope.turnId,
          agentSessionId: input.environmentPackage.scope.agentSessionId,
          agentId: effect.agentId,
          responsibleUserId: effect.responsibleUserId,
          packageDigest: input.environmentPackage.snapshotId,
          policyDecisionId,
        },
      },
      approval: { kind: 'permission', title, description },
      now,
    };
  };
  const pendingInput =
    approvalRequired && currentSnapshot ? capturedInput(currentSnapshot, null) : null;
  if (
    pendingInput &&
    hasCurrentMcpWorkspaceAuthority(input.input.coreDb!, input.environmentPackage) &&
    hasMcpCapabilityTurnAdmission(input.input.store, input.environmentPackage)
  ) {
    assertValidMcpToolArguments(currentSnapshot!.tools, input.toolName, input.arguments);
    try {
      // Returning an existing request releases no effect; its human response reruns Policy.
      const duplicate = preflightPendingToolRequest(input.workspaceDb.sqlite, pendingInput);
      if (duplicate) return pendingToolResult('pending-approval', duplicate.requestId);
    } catch (error) {
      if (error instanceof OperationError)
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, error.message, {
          code: error.code,
        });
      throw error;
    }
  }
  const startedAt = Date.now();
  const startCall = (callId?: string) =>
    startMcpCapabilityCall({
      ...(callId ? { callId } : {}),
      capabilityId: 'mcp.call-tool',
      environmentPackage: input.environmentPackage,
      itemId,
      operation: 'mcp.call-tool',
      protocolRequestId: input.protocolRequestId,
      serverId: input.serverId,
      summary: `MCP tool call ${input.serverId}/${input.toolName}.`,
      toolName: input.toolName,
      workspaceDb: input.workspaceDb,
    });
  let call: StartedCapabilityCall | null = null;
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
          capability_id: 'mcp.call-tool',
          family: 'mcp',
          item_id: replay.item_id,
          operation: 'mcp.call-tool',
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
  let terminalCommitted = false;
  let upstreamEffect: 'not-contacted' | 'contacted' | 'unknown' = 'not-contacted';
  let usageAttempted = false;
  let usageRecoveryRequired = false;
  let cancelled = false;
  let publishTerminalItem = true;
  let observedCredentials: WorkerMcpGatewayCredentials | undefined;
  let policyInput: InterceptionInput | undefined;

  try {
    if (
      !hasCurrentMcpWorkspaceAuthority(input.input.coreDb!, input.environmentPackage, true) ||
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
      if (!currentSnapshot)
        throw new WorkerControlGatewayError(
          'mcp-schema-drift',
          'MCP tool schema is unavailable.',
          409
        );
      assertValidMcpToolArguments(currentSnapshot.tools, input.toolName, input.arguments);
    }
    policyInput = mcpInterceptionInput(input, call);
    const policyDecision = await input.interception.decide(policyInput);
    if (
      policyDecision.result === 'require_escalation' ||
      policyDecision.result === 'require_approval'
    ) {
      const snapshot = await currentMcpEscalationSnapshot(input);
      if (!policyInput.stillCurrent())
        throw new WorkerControlGatewayError(
          'mcp-policy-stale',
          'MCP Policy changed before human review capture.',
          409
        );
      assertValidMcpToolArguments(snapshot.tools, input.toolName, input.arguments);
      stampCapabilityCallSchemaSnapshot({
        callId: call.id,
        schemaSnapshotId: snapshot.schemaSnapshotId,
        workspaceDb: input.workspaceDb,
      });
      const capture = capturedInput(snapshot, policyDecision.decisionId);
      const duplicate = preflightPendingToolRequest(input.workspaceDb.sqlite, capture);
      if (duplicate?.policyDecisionId) {
        const oldRow = input.workspaceDb.sqlite
          .prepare('SELECT * FROM permission_decisions WHERE decision_id = ?')
          .get(duplicate.policyDecisionId);
        const previous = oldRow ? readPermissionDecisionRowV1(oldRow).mediation : undefined;
        if (
          !previous ||
          previous.proposalDigest !== policyDecision.proposalDigest ||
          previous.policyRevision !== policyDecision.policyRevision ||
          previous.authorizationRevision !== policyDecision.authorizationRevision
        )
          throw new WorkerControlGatewayError(
            'mcp-policy-stale',
            'The existing human review has stale Policy facts; inspect or withdraw it.',
            409
          );
      }
      const raised =
        duplicate ??
        raiseRecordedPendingRequest(input.input.store, input.workspaceDb.sqlite, capture);
      if (!input.input.store.listAllItems().some((item) => item.id === raised.requestItemId))
        input.input.store.createItem({
          id: raised.requestItemId,
          workspaceId: raised.workspaceId,
          threadId: raised.threadId,
          turnId: raised.raisingTurnId,
          status: 'completed',
          createdAt: now,
          completedAt: now,
          type: 'approval-request',
          approvalRequestId: raised.requestId,
          title,
          description,
          kind: 'permission',
        });
      publishTerminalItem = false;
      finishCapabilityCall({
        callId: call.id,
        errorCode:
          policyDecision.result === 'require_approval'
            ? 'policy_requires_approval'
            : 'policy_requires_escalation',
        status: 'denied',
        workspaceDb: input.workspaceDb,
      });
      terminalCommitted = true;
      status = 'declined';
      return pendingToolResult('pending-approval', raised.requestId);
    }
    if (policyDecision.result !== 'allow') {
      publishTerminalItem = false;
      throw new WorkerControlGatewayError(
        policyDecision.result === 'deny' ? 'mcp-denied' : 'mcp-policy-unavailable',
        'MCP Policy did not allow the call.',
        policyDecision.result === 'deny' ? 403 : 503
      );
    }
    const observed = await observeWorkerMcpTools({
      call,
      environmentPackage: input.environmentPackage,
      input: input.input,
      operation: 'mcp.call-tool',
      resolved: input.resolved,
      selected: input.selected,
      serverId: input.serverId,
      signal: input.signal,
      workspaceDb: input.workspaceDb,
    });
    observedCredentials = observed.credentials;
    assertValidMcpToolArguments(observed.snapshotTools, input.toolName, input.arguments);
    if (!hasCurrentMcpWorkspaceAuthority(input.input.coreDb!, input.environmentPackage, true)) {
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
    if (observed.credentials || input.resolved.scope === 'server') {
      try {
        assertCurrentMcpVaultBindings(input, observed.injections);
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
    if (!policyInput.stillCurrent())
      throw new WorkerControlGatewayError(
        'mcp-policy-stale',
        'MCP Policy or current authority changed before dispatch.',
        409
      );
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
    if (policyInput) {
      // A failed completed observation must not rewrite the settled upstream call.
      try {
        await input.interception.observe(policyInput);
      } catch {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'MCP call completed; observation evidence is unavailable.',
          { code: 'policy_evidence_unavailable' }
        );
      }
    }
    return result;
  } catch (error) {
    // A completed Tool effect stays completed when later observation evidence fails.
    if (terminalCommitted && status === 'completed') throw error;
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
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        'MCP tool call recovery is required.',
        {
          code: 'recovery_required',
        }
      );
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
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'MCP tool call recovery is required.',
          {
            code: 'recovery_required',
          }
        );
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
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        'MCP tool call recovery is required.',
        {
          code: 'recovery_required',
        }
      );
    }
    terminalCommitted = true;
    status = terminalStatus === 'denied' ? 'declined' : 'failed';
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, normalized.message, {
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
          workspaceDb: input.workspaceDb,
        });
      } catch {}
    }
  }
}

/** Separately admits discovery only when first-use human review has no exact Turn schema. */
async function currentMcpEscalationSnapshot(input: WorkerMcpToolCallInput) {
  const current = readTurnMcpToolSchemaSnapshot(input);
  if (current) return current;
  if (
    !hasCurrentMcpWorkspaceAuthority(input.input.coreDb!, input.environmentPackage, true) ||
    !hasMcpCapabilityTurnAdmission(input.input.store, input.environmentPackage)
  )
    throw mcpDeniedError();
  const discovery = startMcpCapabilityCall({
    capabilityId: 'mcp.list-tools',
    environmentPackage: input.environmentPackage,
    itemId: null,
    operation: 'mcp.list-tools',
    protocolRequestId: input.protocolRequestId,
    serverId: input.serverId,
    workspaceDb: input.workspaceDb,
  });
  if (!discovery.inserted)
    throw new WorkerControlGatewayError(
      'recovery_required',
      'MCP discovery has an existing result; inspect it.',
      409
    );
  try {
    const observed = await observeWorkerMcpTools({
      ...input,
      call: discovery,
      input: input.input,
      operation: 'mcp.list-tools',
    });
    if (observed.credentials)
      await input.input.workerMcpGateway.closeServerIfIdle({
        server: input.resolved,
        workspaceId: input.environmentPackage.scope.workspaceId,
      });
    if (!hasCurrentMcpWorkspaceAuthority(input.input.coreDb!, input.environmentPackage, true))
      throw mcpDeniedError();
    finishCapabilityCall({
      callId: discovery.id,
      status: 'succeeded',
      workspaceDb: input.workspaceDb,
    });
    return { schemaSnapshotId: observed.snapshotId, tools: observed.snapshotTools };
  } catch (error) {
    throw finishMcpHandlerFailure(error, discovery, input.workspaceDb);
  }
}

/** Re-evaluates one exact human response through the pilot before credential preparation. */
export async function reviewCapturedMcpPolicy(input: {
  readonly record: PendingRequestRecord;
  readonly actor: Pick<import('./auth/identity.js').Actor, 'userId'>;
  readonly workspaceDb: WorkspaceDb;
  readonly routes: RegisterWorkerMcpRoutesInput;
  readonly catalog: WorkspaceMcpServerCatalog | null;
  readonly interception: PolicyInterception;
}): Promise<NonNullable<PreparedCapturedPendingCall['mediation']> | null> {
  const { record, workspaceDb } = input;
  if (
    !record.policyDecisionId ||
    !record.serverId ||
    !record.toolName ||
    !record.packageDigest ||
    !record.agentSessionId ||
    !record.canonicalArgumentsJson ||
    !input.catalog
  )
    return null;
  const row = workspaceDb.sqlite
    .prepare('SELECT * FROM permission_decisions WHERE decision_id = ?')
    .get(record.policyDecisionId);
  if (!row) return null;
  const source = readPermissionDecisionRowV1(row);
  if (
    !['require_escalation', 'require_approval'].includes(source.result) ||
    source.mediation?.role !== 'final' ||
    source.mediation.operation !== 'mcp.call-tool'
  )
    return null;
  const snapshot = findNamedAgentEnvironmentPackageSnapshot(
    workspaceDb,
    record.workspaceId,
    record.agentSessionId,
    record.packageDigest
  );
  if (!snapshot) return null;
  const environmentPackage = snapshot.snapshot;
  const selected = environmentPackage.supply.mcpServers.find(
    (server) => server.id === record.serverId
  );
  if (!selected) return null;
  const resolved = resolveWorkspaceMcpServer({ catalog: input.catalog, serverId: record.serverId });
  if (resolved.catalogDigest !== record.catalogRevision) return null;
  const argumentsValue = JSON.parse(record.canonicalArgumentsJson) as Record<string, unknown>;
  const proposalInput = mcpInterceptionInput(
    {
      arguments: argumentsValue,
      environmentPackage,
      input: input.routes,
      interception: input.interception,
      protocolRequestId: record.requestId,
      resolved,
      selected,
      serverId: record.serverId,
      signal: new AbortController().signal,
      toolName: record.toolName,
      workspaceDb,
    },
    { id: executionCallIdForRequest(record.requestId) },
    () => input.routes.store.getThread(record.workspaceId, record.threadId).status !== 'archived'
  );
  if (
    policyProposalDigest(proposalInput.proposal) !== source.mediation.proposalDigest ||
    policyDigest(proposalInput.document) !== source.policySnapshotId ||
    proposalInput.authorizationRevision !== source.mediation.authorizationRevision ||
    policyDigest(proposalInput.proposal.subject) !== policyDigest(source.mediation.subject)
  )
    return null;
  const decision = await input.interception.decide({
    ...proposalInput,
    humanApproval: {
      requestId: record.requestId,
      sourceDecisionId: source.decisionId,
      deciderId: input.actor.userId,
      binding: {
        proposalDigest: source.mediation.proposalDigest,
        policyRevision: source.policySnapshotId,
        authorizationRevision: source.mediation.authorizationRevision,
      },
    },
  });
  if (decision.result !== 'allow') return null;
  return {
    decisionId: decision.decisionId,
    current: proposalInput.stillCurrent,
    observe: () => input.interception.observe(proposalInput),
  };
}

/** Captures actual current Kernel facts through the existing Worker admission owner. */
function currentMcpPolicyAuthority(input: WorkerMcpToolCallInput) {
  let evaluated: { decision: PolicyDecision; facts: unknown } | null = null;
  currentWorkerLineageWorkspaceAuthority(
    input.input.coreDb!,
    { ...input.environmentPackage.scope, packageSnapshotId: input.environmentPackage.snapshotId },
    'tool.use',
    true,
    {
      dependencyFailure: 'throw',
      onEvaluation: (event) => {
        evaluated = event;
      },
    }
  );
  const captured = evaluated as { decision: PolicyDecision; facts: unknown } | null;
  if (!captured) throw new Error('Current MCP authority was unavailable before Kernel evaluation.');
  return { kernel: captured.decision, revision: policyDigest(captured) };
}

/** Human binding authority uses current native owners, never its retained historical decision. */
function currentMcpBindingAuthor(
  input: WorkerMcpToolCallInput,
  userId: string,
  discloseInput = false
): boolean {
  let requestActor: import('./auth/identity.js').Actor | undefined;
  try {
    const administrator = requireCurrentDeploymentAdmin(input.input.coreDb!, {
      kind: 'session',
      userId,
    });
    if (administrator.tokenId)
      requestActor = {
        kind: 'token',
        userId,
        tokenId: administrator.tokenId,
        tokenScope: 'server-admin',
      };
  } catch (error) {
    if (!(error instanceof DeploymentAdminRequiredError)) throw error;
  }
  const authority = currentWorkspaceAuthority(
    input.input.coreDb!,
    input.environmentPackage.scope.workspaceId,
    { kind: 'user', id: userId },
    'tool.use',
    true,
    requestActor,
    { dependencyFailure: 'throw' }
  );
  return (
    Boolean(authority) &&
    (!discloseInput ||
      isThreadVisible(
        input.input.store,
        input.input.store.getThread(
          input.environmentPackage.scope.workspaceId,
          input.environmentPackage.scope.threadId
        ),
        userId,
        authority === 'administrator'
      ))
  );
}

/** Pins schema-independent Tool facts before any credentialed discovery or upstream contact. */
function mcpInterceptionInput(
  input: WorkerMcpToolCallInput,
  call: Pick<StartedCapabilityCall, 'id'>,
  lifecycleCurrent = () =>
    hasMcpCapabilityTurnAdmission(input.input.store, input.environmentPackage)
): InterceptionInput {
  const scope = input.environmentPackage.scope;
  const responsibleHumanId = responsibleUserIdForActor(scope.triggerActor);
  if (!responsibleHumanId) throw new Error('MCP responsible human is unavailable.');
  const authority = currentMcpPolicyAuthority(input);
  const document = readAdmittedPolicyDocument(
    input.input.coreDb!,
    input.input.runtimeConfig().openKitConfig.policy?.mediation
  );
  const policyRevision = policyDigest(document);
  const proposal = {
    operation: 'mcp.call-tool' as const,
    workspaceId: scope.workspaceId,
    serverId: input.serverId,
    toolName: input.toolName,
    argumentsDigest: policyDigest(input.arguments),
    catalogRevision: input.resolved.catalogDigest,
    packageDigest: input.environmentPackage.snapshotId,
    // This pilot's contract is schema-independent. The exact Turn schema remains
    // a mandatory post-allow dispatch precondition under its existing owner.
    schemaDigest: null,
    capabilityCallId: call.id,
    subject: {
      principal: { kind: 'human' as const, id: responsibleHumanId },
      onBehalfOf: null,
      actor: {
        kind: 'agent' as const,
        id: input.environmentPackage.agent.agentId,
        responsibleUserId: responsibleHumanId,
      },
      process: { workspaceId: scope.workspaceId, threadId: scope.threadId, turnId: scope.turnId },
      credentialKind: 'worker-package' as const,
      responsibleHumanId,
    },
  };
  const authorCurrent = (userId: string) => currentMcpBindingAuthor(input, userId);
  const anchorCurrent: InterceptionInput['anchorCurrent'] = (anchor) => {
    if (anchor.kind === 'workspace') return anchor.id === scope.workspaceId;
    if (anchor.kind !== 'turn') return false;
    return !isSealedTurnTerminal(input.input.store.getTurnById(anchor.id).status);
  };
  const currentCatalogRevision = () => {
    const local = input.input
      .runtimeConfig()
      .workspaceMcpServerCatalogs.find((entry) => entry.workspaceId === scope.workspaceId)?.catalog;
    const catalog = composeWorkspaceMcpCatalog({
      dataRoot: input.input.coreDb!.dataRoot,
      workspaceId: scope.workspaceId,
      workspaceCatalog: local ?? { schemaVersion: 1, servers: [] },
    });
    return resolveWorkspaceMcpServer({ catalog, serverId: input.serverId }).catalogDigest;
  };
  const currentBindingRefs = () =>
    selectPolicyBindings({ document, proposal, authorCurrent, anchorCurrent, now: Date.now() }).map(
      (binding) => ({ id: binding.id, digest: policyDigest(binding) })
    );
  const authorizationRevision = policyDigest({
    caller: authority.revision,
    bindings: currentBindingRefs(),
  });
  return {
    workspaceDb: input.workspaceDb,
    document,
    proposal,
    authorizationRevision,
    requiresHumanApproval: input.resolved.approvalRequiredTools.includes(input.toolName),
    authorCurrent,
    anchorCurrent,
    participantAuthorized: (binding) =>
      binding.author.kind === 'human' && currentMcpBindingAuthor(input, binding.author.id, true),
    finalKernel: () => currentMcpPolicyAuthority(input).kernel,
    stillCurrent: () =>
      !input.signal.aborted &&
      lifecycleCurrent() &&
      currentCatalogRevision() === proposal.catalogRevision &&
      policyDigest({
        caller: currentMcpPolicyAuthority(input).revision,
        bindings: currentBindingRefs(),
      }) === authorizationRevision &&
      policyDigest(
        readAdmittedPolicyDocument(
          input.input.coreDb!,
          input.input.runtimeConfig().openKitConfig.policy?.mediation
        )
      ) === policyRevision &&
      policyDigest(input.arguments) === proposal.argumentsDigest,
  };
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
    decisionId: allocateEntityId('pd'),
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

/** Returns the closed worker-visible denial for a consumed or ambiguous Approval. */
function mcpDeniedError(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidRequest, 'MCP tool call was denied.', {
    code: 'mcp-denied',
  });
}

/** Reads the exact live schema already selected for this Turn through its capability calls. */
function readTurnMcpToolSchemaSnapshot(input: {
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly selected: AgentEnvironmentPackage['supply']['mcpServers'][number];
  readonly workspaceDb: WorkspaceDb;
}): ReturnType<typeof readCurrentMcpToolSchemaSnapshot> {
  const scope = input.environmentPackage.scope;
  const bound = input.workspaceDb.sqlite
    .prepare(`
    SELECT schema_snapshot_id FROM capability_calls
    WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
      AND agent_session_id = ? AND package_snapshot_id = ?
      AND family = 'mcp' AND provider_ref = ?
      AND operation IN ('mcp.list-tools', 'mcp.call-tool')
      AND schema_snapshot_id IS NOT NULL
    ORDER BY started_at, call_id LIMIT 1
  `)
    .get(
      scope.workspaceId,
      scope.threadId,
      scope.turnId,
      scope.agentSessionId,
      input.environmentPackage.snapshotId,
      input.selected.id
    ) as { schema_snapshot_id: string } | undefined;
  if (!bound) return null;
  const snapshot = readCurrentMcpToolSchemaSnapshot({
    catalogEntryId: input.selected.id,
    pinnedSchemaSnapshotId: bound.schema_snapshot_id,
    workspaceDb: input.workspaceDb,
    workspaceId: scope.workspaceId,
  });
  if (
    !snapshot ||
    (input.selected.schemaPolicy === 'pinned' &&
      snapshot.schemaSnapshotId !== input.selected.pinnedSchemaSnapshotId)
  ) {
    throw new WorkerControlGatewayError(
      'mcp-schema-drift',
      'MCP Turn tool schema is unavailable.',
      409
    );
  }
  return snapshot;
}

/** Discovers live tools while retaining the exact schema already selected for the Turn. */
async function observeWorkerMcpTools(input: {
  readonly call: StartedCapabilityCall;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly input: RegisterWorkerMcpRoutesInput;
  readonly operation: 'mcp.list-tools' | 'mcp.call-tool';
  readonly resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  readonly selected: AgentEnvironmentPackage['supply']['mcpServers'][number];
  readonly serverId: string;
  readonly signal: AbortSignal;
  readonly workspaceDb: WorkspaceDb;
}): Promise<{
  credentials?: WorkerMcpGatewayCredentials;
  injections: readonly PendingMcpVaultInjection[];
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
  // Keep selection and stamping synchronous: concurrent discoveries must reuse the first binding.
  const bound = readTurnMcpToolSchemaSnapshot(input);
  // Approval re-evaluation needs the latest live observation even when the Worker stays on its Turn schema.
  const liveSnapshotId = recordMcpToolSchemaSnapshot({
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
  const snapshotId = bound?.schemaSnapshotId ?? liveSnapshotId;
  if (
    input.selected.schemaPolicy === 'pinned' &&
    input.selected.pinnedSchemaSnapshotId !== liveSnapshotId
  ) {
    throw new WorkerControlGatewayError(
      'mcp-schema-drift',
      'MCP tool schema changed from its pinned snapshot.',
      409
    );
  }
  stampCapabilityCallSchemaSnapshot({
    callId: input.call.id,
    schemaSnapshotId: snapshotId,
    workspaceDb: input.workspaceDb,
  });
  snapshotTools = bound?.tools ?? snapshotTools;
  return {
    ...(resolvedCredentials.credentials ? { credentials: resolvedCredentials.credentials } : {}),
    injections: resolvedCredentials.injections,
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
export async function resolveWorkerMcpCredentials(input: {
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
  > & { readonly vaultBackend?: () => import('./vault/vault-backend.js').VaultBackend };
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
      const backend = input.input.vaultBackend?.() ?? input.input.vaultUnlockState!.backend();
      if (
        reference!.backendKind !== backend.kind ||
        (input.resolved.scope === 'server' && !isCurrentServerMcpMaterial(backend, reference!))
      )
        throw new Error('Vault backend mismatch.');
      const material = createVaultUseAuditedBackend({
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
      ...(bearer !== undefined ? { bearer } : {}),
      ...(Object.keys(environment).length ? { environment } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(query).length ? { query } : {}),
    },
    injections,
  };
}

/** Re-derives Server origin and exact selection from canonical catalogs at credential and effect boundaries. */
function assertCurrentSharedMcpBinding(input: {
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

/** Rechecks every credential binding immediately before the tool effect boundary. */
function assertCurrentMcpVaultBindings(
  input: WorkerMcpToolCallInput,
  injections: readonly PendingMcpVaultInjection[]
): void {
  assertCurrentSharedMcpBinding(input);
  for (const binding of input.resolved.credentialBindings) {
    const grant = getVaultGrant(input.input.coreDb!, binding.vaultGrantId);
    const reference = grant ? getVaultReference(input.input.coreDb!, grant.vaultReferenceId) : null;
    assertCurrentMcpVaultAuthority(
      {
        environmentPackage: input.environmentPackage,
        operation: 'mcp.call-tool',
        resolved: input.resolved,
      },
      grant,
      reference
    );
    if (input.resolved.scope === 'server') {
      const observed = injections.find((item) => item.grant.grantId === grant.grantId);
      const backend = input.input.vaultUnlockState?.backend();
      if (
        !reference ||
        !backend ||
        !observed ||
        observed.grant.vaultReferenceId !== reference.referenceId ||
        observed.referenceVersion !== reference.currentVersion ||
        !isCurrentServerMcpMaterial(backend, reference)
      )
        throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call was denied.', 403);
    }
  }
}

/** Creates receipts only after a successful credential-bearing upstream exchange. */
export function completeMcpVaultInjections(
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

/** Finishes one list handler failure and returns its bounded SDK error. */
function finishMcpHandlerFailure(
  error: unknown,
  call: StartedCapabilityCall,
  workspaceDb: WorkspaceDb
): ProtocolError {
  const normalized = finishMcpCallFailure(error, call, workspaceDb);
  return new ProtocolError(
    ProtocolErrorCode.InvalidRequest,
    normalized.message,
    projectOperationError(normalized) ?? { code: normalized.code }
  );
}

/** Safely terminalizes one MCP handler failure or returns a recovery-required result. */
function finishMcpCallFailure(
  error: unknown,
  call: StartedCapabilityCall,
  workspaceDb: WorkspaceDb
): WorkerControlGatewayError | OperationError {
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
  const name = mcpRequestName(
    input.environmentPackage,
    input.serverId,
    input.operation,
    input.protocolRequestId
  );
  return startCapabilityCall({
    agentId: input.environmentPackage.agent.agentId,
    agentSessionId: input.environmentPackage.scope.agentSessionId,
    authorityActor: input.environmentPackage.scope.triggerActor,
    callId: input.callId ?? deriveEntityId('cap', name),
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

/**
 * Publishes one terminal product-safe tool-call Item after the ledger winner.
 * Timestamps and duration are copied from the capability_calls row so boot reconstruction can compare them.
 */
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
  readonly workspaceDb: WorkspaceDb;
}): void {
  const ledger = input.workspaceDb.sqlite
    .prepare(`SELECT started_at, completed_at FROM capability_calls WHERE call_id = ?`)
    .get(input.call.id) as { completed_at: string | null; started_at: string | null } | undefined;
  const completedAt = ledger?.completed_at ?? new Date().toISOString();
  const durationMs = ledger?.started_at
    ? Math.max(0, Date.parse(completedAt) - Date.parse(ledger.started_at))
    : input.durationMs;
  input.store.createItem(
    {
      arguments: null,
      causationId: input.call.id,
      completedAt,
      createdAt: completedAt,
      durationMs,
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
    },
    ALREADY_DECIDED_PUBLICATION_ADMISSION
  );
}

/** Resolves the exact AEP-selected server without caller-supplied topology. */
function builtinWorkerMcpServer(serverId: string): {
  readonly digest: string;
  readonly tools: ReadonlyArray<{
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly name: string;
  }>;
} | null {
  if (serverId === OPENKIT_GENERATIVE_MCP_ID) {
    return { digest: OPENKIT_GENERATIVE_CATALOG_DIGEST, tools: OPENKIT_GENERATIVE_TOOLS };
  }
  if (serverId === OPENKIT_WORK_MCP_ID) {
    return { digest: OPENKIT_WORK_CATALOG_DIGEST, tools: OPENKIT_WORK_TOOLS };
  }
  return null;
}

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

/** Rechecks Artifact publication authority before capture and each publication boundary. */
function requireCurrentArtifactWorkspaceAuthority(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackage
): void {
  if (
    !currentWorkerLineageWorkspaceAuthority(
      coreDb,
      { ...environmentPackage.scope, packageSnapshotId: environmentPackage.snapshotId },
      'artifact.write',
      true
    )
  )
    throw mcpDeniedError();
}

/** Returns whether current Workspace authority still permits this AEP actor to use tools. */
function hasCurrentMcpWorkspaceAuthority(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackage,
  strict = false
): boolean {
  return Boolean(
    currentWorkerLineageWorkspaceAuthority(
      coreDb,
      {
        workspaceId: environmentPackage.scope.workspaceId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        agentSessionId: environmentPackage.scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        triggerActor: environmentPackage.scope.triggerActor,
      },
      'tool.use',
      true,
      strict ? { dependencyFailure: 'throw' } : undefined
    )
  );
}

/** No new capability effect may pass a proved exhausted or unmeasurable Worker output bound. */
function requireRawOutputCapabilityAdmission(
  workspaceDb: WorkspaceDb,
  environmentPackage: AgentEnvironmentPackage
): void {
  try {
    requireWorkerRawOutputAvailable(workspaceDb, environmentPackage.scope);
  } catch (error) {
    if (
      error instanceof WorkerRawOutputBudgetExceededError ||
      error instanceof WorkerRawOutputAuthorityError
    )
      throw new WorkerControlGatewayError(
        'worker_raw_output_unavailable',
        'Worker output admission is unavailable.',
        503
      );
    throw error;
  }
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
    turn.workspaceId === environmentPackage.scope.workspaceId &&
    turn.threadId === environmentPackage.scope.threadId &&
    turn.status === 'running'
  );
}

/** Builds a stable Item id for one product-visible tool call. */
function workerMcpItemId(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  toolName: string,
  protocolRequestId: string | number
): string {
  return deriveEntityId(
    'it',
    mcpRequestName(environmentPackage, serverId, toolName, protocolRequestId)
  );
}

/** Returns one deterministic identity for a request inside its immutable AEP lineage. */
function mcpRequestName(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  operation: string,
  protocolRequestId: string | number
): readonly unknown[] {
  return ['mcp', environmentPackage.snapshotId, serverId, operation, protocolRequestId];
}

/** Returns the stable unavailable-server failure without catalog disclosure. */
function unavailableServer(): WorkerControlGatewayError {
  return new WorkerControlGatewayError('mcp-server-unavailable', 'MCP server is unavailable.', 503);
}

/** Maps one private route failure to the closed worker-visible vocabulary. */
function normalizeWorkerMcpRouteError(error: unknown): WorkerControlGatewayError | OperationError {
  if (error instanceof WorkerControlGatewayError || error instanceof OperationError) return error;
  return new WorkerControlGatewayError('mcp-call-failed', 'MCP tool call failed.', 503);
}

/** Returns one bounded JSON-RPC failure for pre-protocol request rejection. */
function workerMcpHttpError(error: unknown): Response {
  const normalized = normalizeWorkerMcpRouteError(error);
  return Response.json(
    {
      error: {
        code: ProtocolErrorCode.InvalidRequest,
        data: projectOperationError(normalized) ?? { code: normalized.code },
        message: normalized.message,
      },
      id: null,
      jsonrpc: '2.0',
    },
    { status: normalized.status }
  );
}
