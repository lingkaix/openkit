import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  AppDiagnosticsResponseSchema,
  type BootReadinessSnapshot,
  SetupDiagnosticsResponseSchema,
} from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  MaterializedWorkspaceRoot as ConfigMaterializedWorkspaceRoot,
} from '@openkit/config-schema';
import type { TurnSchema, WorkspaceRecordSchema } from '@openkit/protocol';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import { registerActionCenterRoutes } from './action-center.js';
import { registerAgentCatalogRoutes } from './agents/catalog-routes.js';
import type { AgentManifest, AuthoredAgentConfig } from './agents/manifest.js';
import { asApiError } from './api-errors.js';
import { registerDashboardRoutes } from './app-dashboard.js';
import { registerApprovalRoutes } from './approval-routes.js';
import { registerArtifactRoutes } from './artifact-routes.js';
import { recordWorkspaceAuditEvent } from './audit-events.js';
import { registerAccessTokenRoutes } from './auth/access-token-routes.js';
import { verifyOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { isDeploymentAdminActor } from './auth/identity.js';
import {
  type AuthVariables,
  type BetterAuthServer,
  createAuthMiddleware,
  isLoopbackHost,
} from './auth/middleware.js';
import { registerAutomationRoutes } from './automation-routes.js';
import { createBootReadinessSnapshot } from './bootstrap/readiness.js';
import type { CoreMode } from './config/mode.js';
import { loadOpenKitConfig, type OpenKitConfig } from './config/openkit-config.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  type RuntimeConfigManager,
  type RuntimeConfigSnapshot,
} from './config/runtime-config.js';
import { RuntimeConfigFileService } from './config/runtime-config-files.js';
import { registerRuntimeConfigRoutes } from './config/runtime-config-routes.js';
import { createSetupDiagnostics } from './diagnostics/setup.js';
import { createDiagnosticsSnapshot } from './diagnostics/snapshot.js';
import { registerGoalRoutes } from './goal-routes.js';
import { registerGovernanceRoutes } from './governance-routes.js';
import { InternalAgentRunner } from './internal-agents/runner.js';
import type {
  InternalAgentDefaultProviderUse,
  InternalAgentDiagnosticsSnapshot,
} from './internal-agents/types.js';
import type { WorkerCoordinatorCandidate } from './internal-agents/worker-coordinator.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import type { CodexOAuthStore } from './llm/codex-oauth.js';
import { CodexOAuthAccountManager } from './llm/codex-oauth-accounts.js';
import {
  registerCodexOAuthAccountRoutes,
  registerCodexOAuthLoginRoutes,
} from './llm/codex-oauth-routes.js';
import { CodexAuthTokenResolver, CodexResponsesClient } from './llm/codex-responses-client.js';
import { registerLlmGatewayRoutes, registerWorkerInferenceRoutes } from './llm/gateway-routes.js';
import { GatewayUsageTracker } from './llm/gateway-usage.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { registerQuickAndChatModeRoutes, registerTaskModeRoute } from './mode-entry-routes.js';
import { APP_OPENAPI_DOCUMENT, registerAppApiRoute } from './openapi.js';
import { readCodexOAuthAccountSlotId } from './providers/codex-oauth-profile.js';
import { resolveDefaultProviderStates } from './providers/default-provider.js';
import type { ProviderDiagnosticsSnapshot } from './providers/diagnostics.js';
import { resolveProviderProfileToLLMConfig } from './providers/llm-config.js';
import {
  type ProviderCredentialResolver,
  type ProviderRegistry,
  resolveEnvSecretRef,
} from './providers/registry.js';
import { createVaultProviderCredentialResolver } from './providers/vault-credential-resolver.js';
import { registerRepositoryRoutes } from './repository-routes.js';
import { registerReviewDecisionRoutes } from './review-decision-routes.js';
import { registerAgentEnvironmentRoutes } from './runtime/agent-environment-routes.js';
import { registerAgentHealthRoutes } from './runtime/agent-health-routes.js';
import { listStaleRuntimeConfigSessions } from './runtime/agent-session-read-model.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { DEFAULT_AGENT_MANIFESTS, TurnStartValidationError } from './runtime/orchestrator.js';
import { startProductTurn } from './runtime/product-turn-start.js';
import { registerSchedulerAdmissionRoutes } from './runtime/scheduler-admission-routes.js';
import { createConfiguredTurnExecutor } from './runtime/turn-executor-factory.js';
import {
  materializeWorkspaceRootsForTurn,
  resolveWorkspaceRepositoryForTurn,
} from './runtime/turn-workspace-context.js';
import type { TurnExecutor } from './runtime/types.js';
import { createWorkerControlCommandDeliveryRecorder } from './runtime/worker-control-commands.js';
import {
  WorkerControlGateway,
  WorkerControlGatewayError,
  type WorkerControlLineage,
} from './runtime/worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './runtime/worker-control-rebuild.js';
import {
  createWorkerControlAcceptedRecordRecorder,
  resolveWorkerControlFinalStatusTokenBinding,
} from './runtime/worker-control-records.js';
import { registerWorkerControlRoutes } from './runtime/worker-control-routes.js';
import { createWorkerControlSequenceRecorder } from './runtime/worker-control-sequences.js';
import { registerWorkerRecoveryRoutes } from './runtime/worker-recovery-routes.js';
import { updateBackendWorkspaceHandleCleanupStatus } from './runtime/workspace-sync-records.js';
import { registerWorkspaceSyncRoutes } from './runtime/workspace-sync-routes.js';
import {
  acceptSchedulerLeaseHeartbeatByBinding,
  completeSchedulerLeaseForTerminalTurn,
  markSchedulerSessionLeaseReleasing,
  resolveSchedulerLeaseTokenBinding,
  SchedulerLeaseHeartbeatRejectedError,
} from './scheduler-records.js';
import { registerSearchRoutes } from './search-routes.js';
import { mapRuntimeCapabilitiesToFlags, registerServiceRoutes } from './service-routes.js';
import { registerDataRootAdminRoutes } from './storage/data-root-admin-routes.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { registerWorkspaceTransferRoutes } from './storage/workspace-transfer-routes.js';
import { registerThreadRoutes } from './thread-routes.js';
import { registerTurnEventRoutes } from './turn-event-routes.js';
import { registerTurnRoutes } from './turn-routes.js';
import { registerVaultAdminRoutes } from './vault/vault-admin-routes.js';
import type { OsKeychainVaultAdapter } from './vault/vault-os-keychain-backend.js';
import { createVaultUnlockState, type VaultUnlockState } from './vault/vault-unlock-state.js';
import { backfillRepositoryDataSourceCatalogs } from './workspace/repository-data-source-catalog.js';
import type { WorkspaceRepositoryResourceRecord } from './workspace/repository-store.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';

type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/**
 * Creates credentialed browser CORS middleware for configured origins.
 *
 * @param mode Resolved Core mode.
 * @param configuredOrigins Exact operator-configured browser origins.
 * @returns Browser CORS middleware that rejects disallowed origins before route handling.
 */
function createBrowserCors(
  mode: CoreMode,
  configuredOrigins: readonly string[]
): ReturnType<typeof cors> {
  const allowedCors = cors({ credentials: true, origin: (origin) => origin });

  return async (context, next) => {
    const origin = context.req.header('origin') ?? '';
    let allowed = configuredOrigins.includes(origin);

    if (!allowed && mode === 'local') {
      try {
        const url = new URL(origin);
        allowed =
          url.origin === origin &&
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          isLoopbackHost(url.hostname);
      } catch {
        allowed = false;
      }
    }

    if (origin && !allowed) {
      return asApiError('Browser origin is not allowed.', 'cors_origin_forbidden', 403);
    }

    if (!origin) {
      return next();
    }

    return allowedCors(context, next);
  };
}

/**
 * Requires deployment-admin authority before collecting deployment diagnostics.
 *
 * @param actor Authenticated request actor.
 * @returns Forbidden response for non-admin actors, otherwise null.
 */
function requireDiagnosticsAdminActor(actor: AuthVariables['actor'] | undefined): Response | null {
  return isDeploymentAdminActor(actor)
    ? null
    : asApiError('Server-admin authority is required.', 'diagnostics_admin_forbidden', 403);
}

/**
 * Checks whether a request would admit new product work.
 *
 * @param method HTTP method.
 * @param path Request path.
 * @returns True when boot readiness should gate the request.
 */
function isProductWorkAdmissionRequest(method: string, path: string): boolean {
  if (
    method === 'POST' &&
    (path === '/api/app/quick-chat' ||
      path === '/api/turns' ||
      path === '/v1/chat/completions' ||
      path === '/v1/responses')
  ) {
    return true;
  }

  return (
    ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method) &&
    (path === '/api/workspaces' ||
      path.startsWith('/api/workspaces/') ||
      path === '/api/app/workspace-imports' ||
      path.startsWith('/api/app/workspaces/'))
  );
}

/**
 * Rejects project-only operations for lightweight Quick Chat workspaces.
 *
 * @param workspace Workspace record selected by the request.
 * @param action Project-only action summary for the user-facing error.
 * @throws TurnStartValidationError when the workspace is Quick Chat.
 */
function assertProjectWorkspace(workspace: WorkspaceRecord, action: string): void {
  if (workspace.kind !== 'quick-chat') {
    return;
  }

  throw new TurnStartValidationError(
    'workspace_kind_not_supported',
    `Quick Chat workspace cannot ${action}. Create or select a project workspace.`
  );
}

/**
 * Projects enabled workspace agents into the Worker Coordinator candidate shape.
 *
 * @param store Store that owns workspace resources.
 * @param workspaceId Workspace whose agents should be projected.
 * @returns Coordinator-visible worker candidates.
 */
function workerCoordinatorCandidates(
  store: FsStore,
  workspaceId: string
): WorkerCoordinatorCandidate[] {
  return store
    .getWorkspaceResources(workspaceId)
    .agents.filter((agent) => agent.status === 'enabled')
    .flatMap((agent) => {
      const runtime = workerRuntimeForAgent(agent.id, agent.name);

      return runtime
        ? [
            {
              agentId: agent.id,
              displayName: agent.name,
              readiness: 'ready' as const,
              runtime,
            },
          ]
        : [];
    });
}

/**
 * Infers the V1 worker runtime family from the current agent catalog naming convention.
 *
 * @param agentId Product agent id.
 * @param agentName Product agent display name.
 * @returns Supported worker runtime family, or null for non-worker/internal agents.
 */
function workerRuntimeForAgent(agentId: string, agentName: string): 'codex' | 'opencode' | null {
  const value = `${agentId} ${agentName}`.toLowerCase();

  if (value.includes('opencode')) {
    return 'opencode';
  }
  if (value.includes('codex')) {
    return 'codex';
  }

  return null;
}

/**
 * Minimal internal agent runner surface used by app routes and diagnostics.
 */
type AppInternalAgentRunner = Pick<InternalAgentRunner, 'run'> & {
  /** Returns safe internal-agent diagnostics without prompts or secrets. */
  getDiagnostics(): InternalAgentDiagnosticsSnapshot;
};

/**
 * Construction options for the Hono app.
 */
export interface CreateAppOptions {
  mode?: CoreMode;
  auth?: BetterAuthServer;
  coreDb?: CoreDb;
  dataRoot?: string;
  store?: FsStore;
  storeFactory?: (userId: string) => FsStore;
  turnExecutor?: TurnExecutor;
  /** Optional Pi AI client override for tests and embedded deployments. */
  llmPiAiClient?: PiAiGatewayClient;
  llmCodexResponsesClient?: CodexResponsesClient;
  llmGatewayDispatcher?: LLMGatewayProviderDispatcher;
  /** Optional internal agent runner override for tests. */
  internalAgentRunner?: AppInternalAgentRunner;
  gatewayUsageTracker?: GatewayUsageTracker;
  /** Loaded operator config used for app diagnostics defaults. */
  openKitConfig?: OpenKitConfig;
  providerRegistry?: ProviderRegistry;
  /** Resolver used to check provider profile credential references. */
  providerCredentialResolver?: ProviderCredentialResolver;
  providerDiagnostics?: ProviderDiagnosticsSnapshot;
  runtimeConfigManager?: RuntimeConfigManager;
  codexOAuthAccountManager?: CodexOAuthAccountManager;
  codexOAuthStore?: CodexOAuthStore;
  automationStore?: AutomationStore;
  /** Process-local worker control gateway used by direct sandbox workers. */
  workerControlGateway?: WorkerControlGateway;
  /** Scheduler epoch owned by this app instance. */
  schedulerEpoch?: number;
  agentConfigs?: AuthoredAgentConfig[];
  agentManifests?: AgentManifest[];
  /** Boot readiness snapshot for this process. */
  bootReadiness?: BootReadinessSnapshot;
  /** Returns the current boot readiness snapshot for request-time admission checks. */
  getBootReadiness?: () => BootReadinessSnapshot;
  /** Process-local vault unlock state used by vault admin routes. */
  vaultUnlockState?: VaultUnlockState;
  /** Optional os-keychain adapter override used by tests and embedded local deployments. */
  vaultOsKeychainAdapter?: OsKeychainVaultAdapter;
}

/**
 * Creates the default worker-control gateway for one app instance.
 *
 * @param coreDb Optional server-scope database used for durable scheduler lease binding checks.
 * @returns Worker-control gateway.
 */
export function createDefaultWorkerControlGateway(coreDb?: CoreDb): WorkerControlGateway {
  if (!coreDb) {
    return new WorkerControlGateway();
  }

  const gateway = new WorkerControlGateway({
    acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
    commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
    onHeartbeatAccepted: (input) => {
      try {
        acceptSchedulerLeaseHeartbeatByBinding(coreDb, {
          acceptedAt: input.heartbeat.lastHeartbeatAt,
          lineage: input.lineage,
          sandboxBindingRef: input.sandboxBindingRef,
          workerSequence: input.heartbeat.sequence,
        });
      } catch (error) {
        if (error instanceof SchedulerLeaseHeartbeatRejectedError) {
          if (error.reason === 'sequence-stale') {
            throw new WorkerControlGatewayError(
              'worker_control_sequence_stale',
              'Worker control heartbeat sequence is stale.',
              409
            );
          }

          throw new WorkerControlGatewayError(
            'worker_control_lease_not_live',
            'Worker control request lease is not live.',
            403
          );
        }
        throw error;
      }
    },
    onFinalStatusAccepted: (input) => {
      const resolution = resolveSchedulerLeaseTokenBinding(coreDb, input);

      if (resolution.status !== 'accepted') {
        throw new WorkerControlGatewayError(
          'worker_control_lease_not_live',
          'Worker control request lease is not live.',
          403
        );
      }

      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: resolution.lease.leaseId,
        releaseReason: 'worker-final-status',
      });
    },
    onFinalStatusCommitted: (input) => {
      const workspaceDb = openWorkspaceDb(
        coreDb.dataRoot,
        LOCAL_USER_ID,
        input.lineage.workspaceId
      );
      try {
        applyScopedMigrations(workspaceDb);
        updateBackendWorkspaceHandleCleanupStatus(
          workspaceDb,
          input.lineage.workspaceId,
          input.lineage.packageSnapshotId,
          'retained',
          new Date().toISOString()
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    },
    resolveFinalStatusTokenBinding: (input) =>
      resolveWorkerControlFinalStatusTokenBinding(coreDb, input),
    resolveTokenBinding: (input) => resolveSchedulerLeaseTokenBinding(coreDb, input),
    runFinalStatusTransaction: (operation) => coreDb.sqlite.transaction(operation)(),
    runHeartbeatTransaction: (operation) => coreDb.sqlite.transaction(operation)(),
    sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
  });

  rebuildWorkerControlGatewaySessions(coreDb, gateway);
  return gateway;
}

/** Input used to create the default process vault backend for an app instance. */
interface CreateDefaultVaultUnlockStateInput {
  /** Data root used by encrypted-file vault storage. */
  readonly dataRoot: string;
  /** Local-mode vault backend selected from operator config. */
  readonly localDefaultBackend?: 'os-keychain' | 'encrypted-file';
  /** NanoCore mode selected for this app. */
  readonly mode: 'local' | 'server';
  /** Optional os-keychain adapter override. */
  readonly osKeychainAdapter?: OsKeychainVaultAdapter;
}

/**
 * Creates the default vault state for the selected Core mode.
 *
 * @param input App mode, data root, and optional keychain adapter.
 * @returns Process-local vault state.
 */
export function createDefaultVaultUnlockState(
  input: CreateDefaultVaultUnlockStateInput
): VaultUnlockState {
  if (input.mode === 'local' && input.localDefaultBackend !== 'encrypted-file') {
    return createVaultUnlockState({
      ...(input.osKeychainAdapter ? { adapter: input.osKeychainAdapter } : {}),
      backendKind: 'os-keychain',
      deploymentId: 'local',
    });
  }

  return createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(input.dataRoot, 'server', 'vault'),
  });
}

/**
 * Creates the Hono app for tests and runtime startup.
 */
export function createApp(options: CreateAppOptions = {}): Hono<{ Variables: AuthVariables }> {
  const mode = options.mode ?? 'local';
  const auth = options.auth;
  const dataRoot = options.dataRoot ?? null;
  const startupOpenKitConfig =
    options.runtimeConfigManager?.current().openKitConfig ??
    options.openKitConfig ??
    (dataRoot ? loadOpenKitConfig(dataRoot) : {});
  const publicBaseUrl = startupOpenKitConfig.server?.publicBaseUrl;
  const browserCors = createBrowserCors(mode, [
    ...(startupOpenKitConfig.server?.cors?.origins ?? []),
    ...(publicBaseUrl ? [new URL(publicBaseUrl).origin] : []),
  ]);
  const bootReadiness = options.bootReadiness ?? createBootReadinessSnapshot();
  const getBootReadiness = options.getBootReadiness ?? (() => bootReadiness);
  const localDefaultBackend = startupOpenKitConfig.vault?.localDefaultBackend;
  const vaultUnlockState =
    options.vaultUnlockState ??
    (dataRoot
      ? createDefaultVaultUnlockState({
          dataRoot,
          ...(localDefaultBackend ? { localDefaultBackend } : {}),
          mode,
          ...(options.vaultOsKeychainAdapter
            ? { osKeychainAdapter: options.vaultOsKeychainAdapter }
            : {}),
        })
      : null);
  const providerCredentialResolverFallback: ProviderCredentialResolver = (secretRef) =>
    options.providerCredentialResolver?.(secretRef) ?? resolveEnvSecretRef(secretRef);
  const providerCredentialResolver =
    options.coreDb && vaultUnlockState
      ? createVaultProviderCredentialResolver({
          coreDb: options.coreDb,
          vaultBackend: () => vaultUnlockState.backend(),
          fallback: providerCredentialResolverFallback,
        })
      : providerCredentialResolverFallback;
  const accessTokenVerifier = options.coreDb
    ? (secret: string, request: Request) => {
        const pathname = new URL(request.url).pathname;
        const token = verifyOpenKitAccessTokenRecord(options.coreDb!, secret, {
          channel: requestAuditChannel(request, pathname),
          source: requestAuditSource(request, pathname),
        });
        return token
          ? {
              actor: {
                userId: token.ownerUserId,
                kind: 'token' as const,
                tokenId: token.tokenId,
                tokenScope: token.scope,
                tokenWorkspaceIds: token.workspaceIds,
              },
              tokenId: token.tokenId,
            }
          : null;
      }
    : undefined;
  const workspaceMembershipVerifier = options.coreDb
    ? (actor: AuthVariables['actor'], workspaceId: string) => {
        if (actor.kind === 'session') {
          try {
            storeForUserId(actor.userId).getWorkspace(workspaceId);
          } catch {
            return false;
          }
        }

        return isActiveWorkspaceMember(actor.userId, workspaceId);
      }
    : undefined;
  const authMiddlewareOptions = {
    ...(accessTokenVerifier ? { accessTokenVerifier } : {}),
    ...(workspaceMembershipVerifier ? { workspaceMembershipVerifier } : {}),
  };

  /**
   * Returns the redacted client channel label for token last-use summaries.
   *
   * @param request Authenticated request.
   * @param pathname Request pathname.
   * @returns Client channel label.
   */
  function requestAuditChannel(request: Request, pathname: string): string {
    return (
      normalizeRequestAuditLabel(request.headers.get('x-openkit-client-channel')) ??
      (pathname.startsWith('/api/app/') ? 'app-api' : 'core-api')
    );
  }

  /**
   * Returns the redacted client source label for token last-use summaries.
   *
   * @param request Authenticated request.
   * @param pathname Request pathname.
   * @returns Client source label.
   */
  function requestAuditSource(request: Request, pathname: string): string {
    return normalizeRequestAuditLabel(request.headers.get('x-openkit-client-source')) ?? pathname;
  }

  /**
   * Normalizes a caller-supplied audit label without accepting secret-shaped material.
   *
   * @param value Header value.
   * @returns Safe label or null.
   */
  function normalizeRequestAuditLabel(value: string | null): string | null {
    const label = value?.trim();
    if (!label || label.includes('okt_')) {
      return null;
    }
    return label.slice(0, 80);
  }
  const localStore =
    options.store ?? new FsStore(options.dataRoot ? { dataRoot: options.dataRoot } : {});
  if (options.coreDb) {
    backfillRepositoryDataSourceCatalogs(options.coreDb);
  }
  const storesByUserId = new Map<string, FsStore>();
  const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const llmPiAiClient = options.llmPiAiClient ?? new PiAiGatewayClient();
  const gatewayUsageTracker = options.gatewayUsageTracker ?? new GatewayUsageTracker();
  const codexOAuthAccountManager =
    options.codexOAuthAccountManager ??
    new CodexOAuthAccountManager({
      dataRoot,
      resolveBoundProviderIds: (accountSlotId) => codexProviderIdsForSlot(accountSlotId),
      resolveDefaultAccountSlotId: () => defaultCodexAccountSlotId(),
    });
  const llmCodexResponsesClient =
    options.llmCodexResponsesClient ??
    new CodexResponsesClient({
      tokenResolverForProvider: (provider) =>
        new CodexAuthTokenResolver({
          accountStore: codexOAuthAccountManager.tokenResolutionStore(
            requireCodexOAuthAccountSlotId(provider.codexOAuthAccountSlotId)
          ),
        }),
    });
  const llmGatewayDispatcher =
    options.llmGatewayDispatcher ??
    new LLMGatewayProviderDispatcher({
      codexResponsesClient: llmCodexResponsesClient,
      piAiClient: llmPiAiClient,
      usageTracker: gatewayUsageTracker,
    });
  const hasInlineRuntimeConfigInput = Boolean(
    options.openKitConfig ??
      options.providerRegistry ??
      options.providerDiagnostics ??
      options.agentConfigs ??
      options.agentManifests
  );
  const runtimeConfigManager =
    options.runtimeConfigManager ??
    createRuntimeConfigManager({
      dataRoot,
      ...(!dataRoot || hasInlineRuntimeConfigInput
        ? {
            initialSnapshot: createInMemoryRuntimeConfigSnapshot({
              dataRoot,
              openKitConfig: startupOpenKitConfig,
              ...(options.providerRegistry ? { providerRegistry: options.providerRegistry } : {}),
              ...(options.providerDiagnostics
                ? { providerDiagnostics: options.providerDiagnostics }
                : {}),
              agentConfigs: options.agentConfigs ?? [],
              agentManifests: options.agentManifests ?? DEFAULT_AGENT_MANIFESTS,
            }),
          }
        : {}),
    });
  const automationStore = options.automationStore ?? new AutomationStore();
  const workerControlGateway =
    options.workerControlGateway ?? createDefaultWorkerControlGateway(options.coreDb);
  const schedulerEpoch = options.schedulerEpoch ?? 1;
  const turnExecutor =
    options.turnExecutor ??
    createConfiguredTurnExecutor({
      coreDb: options.coreDb,
      ...(vaultUnlockState ? { vaultBackend: () => vaultUnlockState.backend() } : {}),
      workerControlGateway,
    });
  let internalAgentRunner = options.internalAgentRunner ?? null;
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(async (c, next) => {
    if (
      !getBootReadiness().acceptingProductWork &&
      isProductWorkAdmissionRequest(c.req.method, c.req.path)
    ) {
      return asApiError(
        'NanoCore is not accepting product work during the current boot readiness state.',
        'product_work_unavailable',
        503
      );
    }

    await next();
  });

  /**
   * Returns the store owned by one authenticated user.
   *
   * @param userId Authenticated store owner.
   * @returns Store scoped to the owner.
   */
  function storeForUserId(userId: string): FsStore {
    if (mode === 'local' || options.store) {
      return localStore;
    }

    const cachedStore = storesByUserId.get(userId);

    if (cachedStore) {
      return cachedStore;
    }

    const nextStore =
      options.storeFactory?.(userId) ??
      new FsStore(options.dataRoot ? { dataRoot: options.dataRoot, userId } : { userId });

    if (nextStore.getUserId() !== userId) {
      throw new WorkerControlGatewayError(
        'worker_control_package_owner_mismatch',
        'Worker session package owner does not match the resolved store owner.',
        409
      );
    }

    storesByUserId.set(userId, nextStore);

    return nextStore;
  }

  /**
   * Returns the store scoped to the current request actor.
   *
   * @param c Hono context carrying the actor variable after auth middleware.
   * @returns Actor-scoped store.
   * @throws Error when server-mode routing reaches storage without an authenticated actor.
   */
  function requestStore(c: { get: (key: 'actor') => AuthVariables['actor'] | undefined }): FsStore {
    const actor = c.get('actor');

    if (!actor && mode === 'server') {
      throw new Error('Authenticated actor is unavailable for the request store.');
    }

    return storeForUserId(actor?.userId ?? 'user_local');
  }

  /**
   * Authenticates one worker package request and resolves its owner-scoped store.
   *
   * @param input Sandbox authorization and package lineage.
   * @returns Authenticated package and owner-scoped store.
   * @throws WorkerControlGatewayError when package supply or user ownership is unavailable.
   */
  function authenticateWorkerPackageOwner(input: {
    readonly authorization: string | null;
    readonly lineage: WorkerControlLineage;
  }): { readonly environmentPackage: AgentEnvironmentPackage; readonly store: FsStore } {
    const environmentPackage = workerControlGateway.authenticatePackageRequest(input);
    const userId = environmentPackage.scope.userId;

    if (!userId) {
      throw new WorkerControlGatewayError(
        'worker_control_package_owner_unavailable',
        'Worker session package has no user store owner.',
        409
      );
    }

    const store = storeForUserId(userId);

    if (store.getUserId() !== userId) {
      throw new WorkerControlGatewayError(
        'worker_control_package_owner_mismatch',
        'Worker session package owner does not match the resolved store owner.',
        409
      );
    }

    return { environmentPackage, store };
  }

  /**
   * Filters workspace collection reads by active membership and token binding.
   *
   * @param actor Authenticated actor.
   * @param items Workspace records from the actor-scoped store.
   * @returns Workspace records visible to the actor.
   */
  function visibleWorkspacesForActor(
    actor: AuthVariables['actor'] | undefined,
    items: ReturnType<FsStore['listWorkspaces']>
  ): ReturnType<FsStore['listWorkspaces']> {
    if (
      mode === 'local' ||
      actor?.kind === 'local' ||
      (actor?.kind === 'token' && actor.tokenScope === 'server-admin')
    ) {
      return items;
    }

    if (!actor) {
      return [];
    }

    const active = items.filter((workspace) => isActiveWorkspaceMember(actor.userId, workspace.id));

    if (actor.kind === 'session') {
      return active;
    }

    const allowed = new Set(actor.tokenWorkspaceIds ?? []);
    return active.filter((workspace) => allowed.has(workspace.id));
  }

  /**
   * Checks the minimal server-side workspace membership fact.
   *
   * @param userId Canonical user id.
   * @param workspaceId Workspace id.
   * @returns True when the user is an active workspace member.
   */
  function isActiveWorkspaceMember(userId: string, workspaceId: string): boolean {
    if (!options.coreDb) {
      return false;
    }

    return Boolean(
      options.coreDb.sqlite
        .prepare(
          `SELECT 1
           FROM workspace_members
           WHERE workspace_id = ? AND user_id = ? AND status = 'active'
           LIMIT 1`
        )
        .get(workspaceId, userId)
    );
  }

  /**
   * Returns the configured Core database for repository App API routes.
   *
   * @returns Core database handles.
   * @throws Error when repository storage has not been configured for this app instance.
   */
  function repositoryCoreDb(): CoreDb {
    if (!options.coreDb) {
      throw new Error('Repository storage is unavailable for this NanoCore instance.');
    }

    return options.coreDb;
  }

  /**
   * Opens the workspace-owned repository database for one request.
   *
   * @param store Request store that owns the current actor identity.
   * @param workspaceId Workspace id that owns repository resources.
   * @returns Migrated workspace database handle.
   */
  function repositoryWorkspaceDb(store: FsStore, workspaceId: string): WorkspaceDb {
    const coreDb = repositoryCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), workspaceId);
    applyScopedMigrations(workspaceDb);
    return workspaceDb;
  }

  /**
   * Returns the current runtime config snapshot for one request operation.
   */
  function runtimeConfig(): RuntimeConfigSnapshot {
    return runtimeConfigManager.current();
  }

  /**
   * Materializes current workspace roots for explicit context package root-file reads.
   *
   * @param store Request store that owns the workspace.
   * @param workspaceId Workspace id that owns the context request.
   * @returns Current materialized roots, including a ready default repository root when available.
   */
  function workspaceRootsForContextPackage(
    store: FsStore,
    workspaceId: string
  ): ConfigMaterializedWorkspaceRoot[] {
    let repository: WorkspaceRepositoryResourceRecord | null = null;

    try {
      repository = resolveWorkspaceRepositoryForTurn(
        options.coreDb,
        workspaceId,
        store.getUserId()
      );
    } catch {
      repository = null;
    }

    return materializeWorkspaceRootsForTurn(runtimeConfig(), store, workspaceId, repository);
  }

  /**
   * Starts one mode-selected worker turn through app-owned runtime composition.
   *
   * @param input Worker selection and turn input.
   * @returns Started turn read model.
   */
  async function startModeWorkerTurn(input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId?: string | undefined;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
  }): Promise<z.infer<typeof TurnSchema>> {
    const snapshot = runtimeConfig();
    const handle = await startProductTurn({
      input: {
        input: input.prompt,
        modelId: input.modelId,
        requestId: input.requestId ?? randomUUID(),
        threadId: input.threadId,
        workspaceId: input.workspaceId,
      },
      cancelDeferredAdmission: true,
      requestedAgentId: input.requestedAgentId,
      ...(input.reservedTurnId ? { reservedTurnId: input.reservedTurnId } : {}),
      schedulerEpoch,
      snapshot,
      store: input.store,
      turnExecutor,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    });

    completeSchedulerLeaseForTerminalTurn(options.coreDb, handle.turn);
    return handle.turn;
  }

  /**
   * Creates a runtime config file service for the current actor context.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Runtime config file service.
   */
  function runtimeConfigFileService(c: {
    get: (key: 'actor') => AuthVariables['actor'] | undefined;
  }): RuntimeConfigFileService {
    const store = requestStore(c);

    return new RuntimeConfigFileService({
      dataRoot,
      userId: store.getUserId(),
      workspaceIds: store.listWorkspaces().map((workspace) => workspace.id),
      runtimeConfigManager,
      readRuntimeConfigStatus: () =>
        runtimeConfigManager.status(
          listStaleRuntimeConfigSessions(
            turnExecutor,
            store,
            runtimeConfig().version,
            workerControlGateway
          )
        ),
      ...(options.coreDb
        ? {
            onDataSourceAuthorityChange: (change) => {
              const workspaceDb = repositoryWorkspaceDb(store, change.workspaceId);
              try {
                recordWorkspaceAuditEvent({
                  workspaceDb,
                  workspaceId: change.workspaceId,
                  category: 'system',
                  action: 'data_source_catalog.authority.update',
                  resource: `data-source-catalog:${change.sourceId}`,
                  outcome: 'succeeded',
                  severity: 'info',
                  summary: `Workspace data source catalog authority changed for ${change.sourceId}: ${change.fields.join(', ')}.`,
                });
              } finally {
                workspaceDb.sqlite.close();
              }
            },
          }
        : {}),
    });
  }

  /**
   * Resolves the Gateway default provider id from runtime config and provider defaults.
   *
   * @returns Gateway provider id or null.
   */
  function gatewayDefaultProviderId(): string | null {
    return runtimeConfig().openKitConfig.defaults?.gatewayProviderId ?? null;
  }

  /**
   * Resolves the Gateway default model from runtime config and provider defaults.
   *
   * @returns Gateway model or null.
   */
  function gatewayDefaultModel(): string | null {
    const providerId = gatewayDefaultProviderId();
    const runtimeProfile = providerId ? runtimeConfig().providerRegistry.get(providerId) : null;

    return (
      runtimeConfig().openKitConfig.defaults?.gatewayModel ?? runtimeProfile?.defaultModel ?? null
    );
  }

  /**
   * Resolves the default Codex account slot from the current Gateway provider binding.
   *
   * @returns Account slot id, or null when the default provider is not Codex.
   */
  function defaultCodexAccountSlotId(): string | null {
    const providerId = gatewayDefaultProviderId();
    const profile = providerId ? runtimeConfig().providerRegistry.get(providerId) : null;

    return profile ? readCodexOAuthAccountSlotId(profile) : null;
  }

  /**
   * Requires a Codex OAuth provider account slot before resolving token storage.
   *
   * @param accountSlotId Account slot id from the resolved provider config.
   * @returns Account slot id when present.
   * @throws Error when a Codex OAuth provider omits its account slot.
   */
  function requireCodexOAuthAccountSlotId(accountSlotId: string | null | undefined): string {
    if (!accountSlotId) {
      throw new Error('Codex OAuth provider requires extensions.openkit.codexOAuth.accountSlotId.');
    }

    return accountSlotId;
  }

  /**
   * Lists runtime provider ids bound to one Codex account slot.
   *
   * @param accountSlotId Account slot id.
   * @returns Provider ids bound to the account slot.
   */
  function codexProviderIdsForSlot(accountSlotId: string): string[] {
    return runtimeConfig()
      .providerRegistry.list()
      .filter((profile) => readCodexOAuthAccountSlotId(profile) === accountSlotId)
      .map((profile) => profile.id);
  }

  /**
   * Resolves a provider config for Gateway dispatch.
   *
   * @param providerId Provider id selected by Gateway defaults.
   * @returns Secret-bearing provider config.
   */
  function resolveGatewayProvider(providerId: string) {
    const profile = runtimeConfig().providerRegistry.get(providerId);

    if (!profile) {
      throw new Error(`LLM provider is not configured: ${providerId}`);
    }

    return resolveProviderProfileToLLMConfig(profile, providerCredentialResolver);
  }

  /**
   * Returns app-diagnostics default provider and model selections.
   *
   * @returns Default provider/model selections for diagnostics.
   */
  function diagnosticsProviderDefaults() {
    return {
      quickChat: {
        providerId: gatewayDefaultProviderId(),
        model: gatewayDefaultModel(),
      },
      internalTasks: {
        providerId: runtimeConfig().openKitConfig.defaults?.coreProviderId ?? null,
        model: runtimeConfig().openKitConfig.defaults?.coreModel ?? null,
      },
      gateway: {
        providerId: gatewayDefaultProviderId(),
        model: gatewayDefaultModel(),
      },
    };
  }

  /**
   * Resolves provider and model defaults for internal agents.
   *
   * @param defaultUse Internal agent provider default slot.
   * @returns Provider id and model selected for the requested slot.
   */
  function internalAgentDefaultSelection(defaultUse: InternalAgentDefaultProviderUse) {
    if (defaultUse === 'quickChat') {
      return {
        providerId: gatewayDefaultProviderId(),
        model: gatewayDefaultModel(),
      };
    }

    return {
      providerId: runtimeConfig().openKitConfig.defaults?.coreProviderId ?? null,
      model: runtimeConfig().openKitConfig.defaults?.coreModel ?? null,
    };
  }

  /**
   * Returns the app-local internal agent runner.
   *
   * @returns Internal agent runner backed by current provider defaults and Gateway dispatcher.
   */
  function getInternalAgentRunner(): AppInternalAgentRunner {
    internalAgentRunner ??= new InternalAgentRunner({
      defaultSelectionResolver: internalAgentDefaultSelection,
      llmClient: llmGatewayDispatcher,
      providerResolver: resolveGatewayProvider,
    });

    return internalAgentRunner;
  }

  app.use('/api/worker-control/*', browserCors);
  registerWorkerControlRoutes({
    app,
    authenticateWorkerPackageOwner,
    coreDb: options.coreDb,
    workerControlGateway,
  });

  app.use('/api/worker-inference/*', browserCors);
  registerWorkerInferenceRoutes({
    app,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    llmGatewayDispatcher,
    resolveGatewayProvider,
    workerControlGateway,
  });

  app.use('/api/*', browserCors);
  app.use('/api/*', createAuthMiddleware(mode, auth, authMiddlewareOptions));
  app.use('/v1/*', browserCors);
  app.use('/v1/*', createAuthMiddleware(mode, auth, authMiddlewareOptions));

  if (auth) {
    app.all('/api/auth/*', (c) => auth.handler(c.req.raw));
  }

  registerAccessTokenRoutes({
    app,
    coreDb: options.coreDb,
    isActiveWorkspaceMember,
    mode,
  });

  registerServiceRoutes({ app, mode, turnExecutor });

  registerVaultAdminRoutes({
    app,
    coreDb: options.coreDb,
    repositoryWorkspaceDb,
    requestStore,
    vaultUnlockState,
  });
  registerCodexOAuthAccountRoutes(app, codexOAuthAccountManager);

  app.get('/api/diagnostics', (c) => {
    const adminError = requireDiagnosticsAdminActor(c.get('actor'));
    if (adminError) {
      return adminError;
    }

    return c.json(
      createDiagnosticsSnapshot({
        actor: c.get('actor'),
        dataRoot,
        mode,
        providerRegistry: runtimeConfig().providerRegistry,
        agentManifests: runtimeConfig().agentManifests,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      })
    );
  });

  registerCodexOAuthLoginRoutes(app, codexOAuthAccountManager);

  registerAppApiRoute(app, 'getAppDiagnostics', async (c) => {
    const adminError = requireDiagnosticsAdminActor(c.get('actor'));
    if (adminError) {
      return adminError;
    }

    const openaiCodexAccounts = await codexOAuthAccountManager.listAccounts();

    return c.json(
      AppDiagnosticsResponseSchema.parse({
        service: 'nanocore',
        boot: getBootReadiness(),
        gateway: {
          status: 'ok',
          endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
          usage: gatewayUsageTracker.snapshot(),
        },
        providers: {
          diagnostics: runtimeConfig().providerDiagnostics.summaries,
          registry: runtimeConfig().providerRegistry.summarize(),
        },
        defaultProviders: resolveDefaultProviderStates(
          runtimeConfig().openKitConfig,
          runtimeConfig().providerRegistry,
          providerCredentialResolver
        ),
        defaults: diagnosticsProviderDefaults(),
        oauth: {
          openaiCodexAccounts,
        },
        // Diagnostics mirrors protocol-visible capabilities for one consistent app surface.
        capabilities: mapRuntimeCapabilitiesToFlags(turnExecutor.capabilities),
        runtimeConfig: runtimeConfigManager.status(
          listStaleRuntimeConfigSessions(
            turnExecutor,
            requestStore(c),
            runtimeConfig().version,
            workerControlGateway
          )
        ),
        internalAgents: getInternalAgentRunner().getDiagnostics(),
      })
    );
  });

  registerAppApiRoute(app, 'getSetupDiagnostics', (c) => {
    const adminError = requireDiagnosticsAdminActor(c.get('actor'));
    if (adminError) {
      return adminError;
    }

    return c.json(
      SetupDiagnosticsResponseSchema.parse(
        createSetupDiagnostics({
          dataRoot,
          mode,
          openKitConfig: runtimeConfig().openKitConfig,
          providerRegistry: runtimeConfig().providerRegistry,
          providerCredentialResolver,
          agentConfigs: runtimeConfig().agentConfigs,
          agentManifests: runtimeConfig().agentManifests,
          runtimeConfig: runtimeConfigManager.status(
            listStaleRuntimeConfigSessions(
              turnExecutor,
              requestStore(c),
              runtimeConfig().version,
              workerControlGateway
            )
          ),
        })
      )
    );
  });

  registerDataRootAdminRoutes({
    app,
    dataRoot,
  });

  registerWorkspaceTransferRoutes({
    app,
    coreDb: options.coreDb,
    dataRoot,
    ...(mode === 'server' ? { isActiveWorkspaceMember } : {}),
    repositoryWorkspaceDb,
    requestStore,
  });
  app.get('/api/openapi.json', (c) => c.json(APP_OPENAPI_DOCUMENT));

  registerRuntimeConfigRoutes({
    app,
    requestStore,
    runtimeConfigFileService,
    runtimeConfigManager,
  });

  registerLlmGatewayRoutes({
    app,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    gatewayDefaultProviderId,
    llmGatewayDispatcher,
    requestStore,
    resolveGatewayProvider,
    runtimeConfig,
  });

  registerQuickAndChatModeRoutes({
    app,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    gatewayDefaultModel,
    gatewayDefaultProviderId,
    getInternalAgentRunner,
    repositoryWorkspaceDb,
    requestStore,
    runtimeConfig,
    startModeWorkerTurn,
    workerCoordinatorCandidates,
  });

  registerThreadRoutes({ app, inflightCommands, requestStore });

  registerAutomationRoutes({ app, automationStore, requestStore, visibleWorkspacesForActor });

  registerSearchRoutes({ app, requestStore, visibleWorkspacesForActor });

  registerAgentCatalogRoutes({ app, requestStore, visibleWorkspacesForActor });

  registerRepositoryRoutes({
    app,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    inflightCommands,
    repositoryWorkspaceDb,
    requestStore,
    vaultBackend: vaultUnlockState ? () => vaultUnlockState.backend() : undefined,
  });

  registerActionCenterRoutes({
    app,
    coreDb: options.coreDb,
    repositoryWorkspaceDb,
    requestStore,
  });

  registerSchedulerAdmissionRoutes({
    app,
    coreDb: options.coreDb,
    repositoryWorkspaceDb,
    requestStore,
  });

  registerGovernanceRoutes({
    app,
    coreDb: options.coreDb,
    repositoryWorkspaceDb,
    requestStore,
  });
  registerDashboardRoutes({
    app,
    requestStore,
    runtimeConfigManager,
    turnExecutor,
    workerControlGateway,
  });

  registerTaskModeRoute({
    app,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    repositoryWorkspaceDb,
    requestStore,
    startModeWorkerTurn,
    workerCoordinatorCandidates,
  });

  registerGoalRoutes({
    app,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    mode,
    repositoryWorkspaceDb,
    requestStore,
    startModeWorkerTurn,
    turnExecutor,
    workerCoordinatorCandidates,
  });

  registerWorkerRecoveryRoutes({
    app,
    coreDb: options.coreDb,
    repositoryWorkspaceDb,
    requestStore,
    turnExecutor,
    visibleWorkspacesForActor,
  });

  registerAgentHealthRoutes({
    app,
    requestStore,
    runtimeConfigVersion: () => runtimeConfig().version,
    turnExecutor,
  });

  registerWorkspaceRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    requestStore,
    visibleWorkspacesForActor,
  });

  registerKnowledgeRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    requestStore,
    workspaceRootsForContextPackage,
  });
  registerTurnRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    requestStore,
    runtimeConfig,
    schedulerEpoch,
    turnExecutor,
  });

  registerApprovalRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    repositoryWorkspaceDb,
    requestStore,
    turnExecutor,
  });

  registerArtifactRoutes({ app, inflightCommands, requestStore });

  registerWorkspaceSyncRoutes({ app, inflightCommands, repositoryWorkspaceDb, requestStore });

  registerAgentEnvironmentRoutes({ app, repositoryWorkspaceDb, requestStore });

  registerReviewDecisionRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    repositoryWorkspaceDb,
    requestStore,
  });

  registerTurnEventRoutes({ app, requestStore });

  return app;
}
