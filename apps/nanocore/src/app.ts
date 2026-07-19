import { join } from 'node:path';

import {
  AppDiagnosticsResponseSchema,
  type BootReadinessSnapshot,
  SetupDiagnosticsResponseSchema,
} from '@openkit/app-api-schemas';
import type { MaterializedWorkspaceRoot as ConfigMaterializedWorkspaceRoot } from '@openkit/config-schema';
import type { ActorRef, TurnSchema, WorkspaceRecordSchema } from '@openkit/protocol';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import { registerActionCenterRoutes } from './action-center.js';
import { registerAgentCatalogRoutes } from './agents/catalog-routes.js';
import type { AgentManifest } from './agents/manifest.js';
import { computeReadiness, isAgentLaunchable } from './agents/readiness.js';
import { asApiError } from './api-errors.js';
import { registerDashboardRoutes } from './app-dashboard.js';
import { registerApprovalRoutes } from './approval-routes.js';
import { registerArtifactRoutes } from './artifact-routes.js';
import { recordWorkspaceAuditEvent } from './audit-events.js';
import { registerAccessTokenRoutes } from './auth/access-token-routes.js';
import { verifyOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser, isDeploymentAdminActor } from './auth/identity.js';
import {
  type AuthVariables,
  type BetterAuthServer,
  createAuthMiddleware,
  isLoopbackHost,
} from './auth/middleware.js';
import { registerOperationAccessGuards } from './auth/operation-authorizer.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
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
import type { WorkerCoordinatorCandidate } from './internal-agents/worker-coordinator.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import type { CodexOAuthStore } from './llm/codex-oauth.js';
import { CodexOAuthAccountManager } from './llm/codex-oauth-accounts.js';
import {
  registerCodexOAuthAccountRoutes,
  registerCodexOAuthLoginRoutes,
} from './llm/codex-oauth-routes.js';
import { CodexAuthTokenResolver, CodexResponsesClient } from './llm/codex-responses-client.js';
import { registerLlmGatewayRoutes, registerWorkerInferenceRoutes } from './llm/gateway-routes.js';
import { GatewayUsageTracker } from './llm/gateway-usage.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { registerMaterialRoutes } from './material-routes.js';
import { registerQuickAndChatModeRoutes, registerTaskModeRoute } from './mode-entry-routes.js';
import { APP_OPENAPI_DOCUMENT, registerAppApiRoute } from './openapi.js';
import { readCodexOAuthAccountSlotId } from './providers/codex-oauth-profile.js';
import { resolveDefaultProviderStates } from './providers/default-provider.js';
import type { ProviderDiagnosticsSnapshot } from './providers/diagnostics.js';
import {
  isProviderProfileDispatchable,
  resolveProviderProfileToLLMConfig,
} from './providers/llm-config.js';
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
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { startProductTurn } from './runtime/product-turn-start.js';
import { registerSchedulerAdmissionRoutes } from './runtime/scheduler-admission-routes.js';
import {
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './runtime/turn-executor-factory.js';
import {
  materializeWorkspaceRootsForTurn,
  resolveWorkspaceRepositoryForTurn,
} from './runtime/turn-workspace-context.js';
import type { TurnExecutor } from './runtime/types.js';
import { createWorkerControlCommandDeliveryRecorder } from './runtime/worker-control-commands.js';
import {
  type WorkerControlFinalStatusAcceptedHook,
  WorkerControlGateway,
  WorkerControlGatewayError,
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
  adoptSchedulerLeaseReconnect,
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
import { ensureUserQuickChatWorkspace, resolveWorkspaceRole } from './workspace-membership.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { registerWorkspaceSharingRoutes } from './workspace-sharing-routes.js';

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
 * Projects manifest-owned worker readiness into the Worker Coordinator candidate shape.
 *
 * @param store Store that owns workspace resources.
 * @param workspaceId Workspace whose agents should be projected.
 * @param agentManifests Current file-backed agent manifests.
 * @param providerRegistry Current provider registry.
 * @param providerCredentialResolver Resolver used to prove provider credentials.
 * @returns Coordinator-visible worker candidates.
 */
function workerCoordinatorCandidates(
  store: FsStore,
  workspaceId: string,
  agentManifests: readonly AgentManifest[],
  providerRegistry: ProviderRegistry,
  providerCredentialResolver: ProviderCredentialResolver
): WorkerCoordinatorCandidate[] {
  const workspace = store.getWorkspace(workspaceId);

  return [...agentManifests]
    .sort((left, right) => {
      const defaultOrder =
        Number(right.id === workspace.defaults?.defaultAgentId) -
        Number(left.id === workspace.defaults?.defaultAgentId);
      return defaultOrder || left.id.localeCompare(right.id);
    })
    .map((manifest) => {
      const dependencies = { providerCredentialResolver };
      const readiness = computeReadiness(manifest, providerRegistry, dependencies);
      const launchable = isAgentLaunchable(readiness, manifest, providerRegistry, dependencies);

      return {
        agentId: manifest.id,
        displayName: manifest.displayName,
        readiness: launchable
          ? ('ready' as const)
          : readiness.status === 'unknown'
            ? ('unknown' as const)
            : ('blocked' as const),
        ...(readiness.reasons.length > 0 ? { reasons: readiness.reasons } : {}),
      };
    });
}

/**
 * Construction options for the Hono app.
 */
export interface CreateAppOptions {
  mode?: CoreMode;
  auth?: BetterAuthServer;
  coreDb?: CoreDb;
  dataRoot?: string;
  store?: FsStore;
  turnExecutor?: TurnExecutor;
  /** Optional Pi AI client override for tests and embedded deployments. */
  llmPiAiClient?: PiAiGatewayClient;
  llmCodexResponsesClient?: CodexResponsesClient;
  llmGatewayDispatcher?: LLMGatewayProviderDispatcher;
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
  /** Configured disposable Cell placement used for scheduler admission. */
  workerPlacement?: 'local' | 'remote';
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
 * @param onFinalStatusCommitted Optional restart-only closeout observer.
 * @returns Worker-control gateway.
 */
export function createDefaultWorkerControlGateway(
  coreDb?: CoreDb,
  onFinalStatusCommitted?: WorkerControlFinalStatusAcceptedHook
): WorkerControlGateway {
  if (!coreDb) {
    return new WorkerControlGateway();
  }

  const gateway = new WorkerControlGateway({
    acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
    authorizeReconnectHeartbeat: (input) => {
      try {
        adoptSchedulerLeaseReconnect(coreDb, input);
      } catch (error) {
        throwSchedulerHeartbeatGatewayError(error);
      }
    },
    commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
    onHeartbeatAccepted: (input) => {
      try {
        acceptSchedulerLeaseHeartbeatByBinding(coreDb, {
          acceptedAt: input.heartbeat.lastHeartbeatAt,
          lineage: input.lineage,
          sandboxBindingRef: input.sandboxBindingRef,
          ...(input.workerProcessKeyHash
            ? { workerProcessKeyHash: input.workerProcessKeyHash }
            : {}),
          workerSequence: input.heartbeat.sequence,
        });
      } catch (error) {
        throwSchedulerHeartbeatGatewayError(error);
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
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, input.lineage.workspaceId);
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
      onFinalStatusCommitted?.(input);
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

/** Projects scheduler heartbeat rejections into the stable worker-control error surface. */
function throwSchedulerHeartbeatGatewayError(error: unknown): never {
  if (!(error instanceof SchedulerLeaseHeartbeatRejectedError)) {
    throw error;
  }
  if (error.reason === 'sequence-stale') {
    throw new WorkerControlGatewayError(
      'worker_control_sequence_stale',
      'Worker control heartbeat sequence is stale.',
      409
    );
  }
  if (error.reason === 'lease-changed') {
    throw new WorkerControlGatewayError(
      'worker_control_identity_conflict',
      'Worker control heartbeat identity conflicts with the durable lease binding.',
      409
    );
  }
  throw new WorkerControlGatewayError(
    'worker_control_lease_not_live',
    'Worker control request lease is not live.',
    403
  );
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
  const sharedStore =
    options.store ?? new FsStore(options.dataRoot ? { dataRoot: options.dataRoot } : {});
  if (mode === 'local') {
    if (options.coreDb) {
      ensureLocalUser(options.coreDb);
      ensureUserQuickChatWorkspace({
        coreDb: options.coreDb,
        store: sharedStore,
        userId: LOCAL_USER_ID,
      });
    } else {
      sharedStore.ensureQuickChatWorkspace(LOCAL_USER_ID);
    }
  }
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
  const authMiddlewareOptions = {
    ...(accessTokenVerifier ? { accessTokenVerifier } : {}),
    ...(options.coreDb
      ? { canonicalUserActive: (userId: string) => isCanonicalUserActive(options.coreDb!, userId) }
      : {}),
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
  if (options.coreDb) {
    backfillRepositoryDataSourceCatalogs(options.coreDb);
  }
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
              agentManifests: options.agentManifests ?? [],
            }),
          }
        : {}),
    });
  const automationStore = options.automationStore ?? new AutomationStore();
  const workerControlGateway =
    options.workerControlGateway ?? createDefaultWorkerControlGateway(options.coreDb);
  const schedulerEpoch = options.schedulerEpoch ?? 1;
  const configuredWorkerRuntime =
    options.turnExecutor || process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1'
      ? null
      : createConfiguredWorkerLifecycleRuntime({
          coreDb: options.coreDb,
          ...(vaultUnlockState ? { vaultBackend: () => vaultUnlockState.backend() } : {}),
          workerControlGateway,
        });
  const turnExecutor =
    options.turnExecutor ??
    configuredWorkerRuntime?.turnExecutor ??
    createConfiguredTurnExecutor({ workerControlGateway });
  const workerPlacement = configuredWorkerRuntime?.placement ?? options.workerPlacement ?? 'local';
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
   * Returns the process-local shared Workspace store for the current request.
   *
   * @param c Hono context carrying the actor variable after auth middleware.
   * @returns Shared Workspace store.
   * @throws Error when server-mode routing reaches storage without an authenticated actor.
   */
  function requestStore(c: { get: (key: 'actor') => AuthVariables['actor'] | undefined }): FsStore {
    const actor = c.get('actor');

    if (!actor && mode === 'server') {
      throw new Error('Authenticated actor is unavailable for the request store.');
    }

    return sharedStore;
  }

  /**
   * Returns the Workspace candidates already admitted by the central operation guard.
   *
   * @param c Request context carrying one central authorization result.
   * @returns Authorized Workspace ids without physical Workspace discovery.
   * @throws Error when a Core-backed request reaches a Workspace route without authorization.
   */
  function authorizedWorkspaceIds(c: {
    get: (key: 'workspaceAccess') => AuthVariables['workspaceAccess'];
  }): readonly string[] {
    const access = c.get('workspaceAccess');
    if (access?.kind === 'workspace') {
      return [access.workspaceId];
    }
    if (access?.kind === 'workspace-set') {
      return access.workspaceIds;
    }
    if (!options.coreDb && mode === 'local') {
      return sharedStore.listWorkspaces().map((workspace) => workspace.id);
    }
    throw new Error('Central Workspace authorization is unavailable for this request.');
  }

  /**
   * Checks the internally consistent active Workspace role required by membership-gated callers.
   *
   * @param userId Canonical user id.
   * @param workspaceId Workspace id.
   * @returns True when the user is an active workspace member.
   */
  function isActiveWorkspaceMember(userId: string, workspaceId: string): boolean {
    if (!options.coreDb) {
      return false;
    }
    return resolveWorkspaceRole(options.coreDb, workspaceId, userId) !== null;
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
   * @param workspaceId Workspace id that owns repository resources.
   * @returns Migrated workspace database handle.
   */
  function repositoryWorkspaceDb(workspaceId: string): WorkspaceDb {
    const coreDb = repositoryCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
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
   * Projects current file-backed manifests into request-scoped worker candidates.
   *
   * @param store Store that owns the workspace read models.
   * @param workspaceId Workspace whose worker candidates should be projected.
   * @returns Deterministically ordered opaque worker candidates.
   */
  function currentWorkerCoordinatorCandidates(
    store: FsStore,
    workspaceId: string
  ): WorkerCoordinatorCandidate[] {
    const snapshot = runtimeConfig();
    return workerCoordinatorCandidates(
      store,
      workspaceId,
      snapshot.agentManifests,
      snapshot.providerRegistry,
      providerCredentialResolver
    );
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
      repository = resolveWorkspaceRepositoryForTurn(options.coreDb, workspaceId);
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
    readonly triggerActor: ActorRef;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
  }): Promise<z.infer<typeof TurnSchema>> {
    const snapshot = runtimeConfig();
    const handle = await startProductTurn({
      input: {
        input: input.prompt,
        modelId: input.modelId,
        requestId: input.requestId,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
      },
      cancelDeferredAdmission: true,
      providerCredentialResolver,
      requestedAgentId: input.requestedAgentId,
      ...(input.reservedTurnId ? { reservedTurnId: input.reservedTurnId } : {}),
      schedulerEpoch,
      snapshot,
      store: input.store,
      triggerActor: input.triggerActor,
      turnExecutor,
      workerPlacement,
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
              const workspaceDb = repositoryWorkspaceDb(change.workspaceId);
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
   * Resolves the Internal Core Role default provider id from runtime config.
   *
   * @returns Core provider id or null.
   */
  function coreDefaultProviderId(): string | null {
    return runtimeConfig().openKitConfig.defaults?.coreProviderId ?? null;
  }

  /**
   * Resolves the Internal Core Role default model from runtime config.
   *
   * @returns Core model or null.
   */
  function coreDefaultModel(): string | null {
    return runtimeConfig().openKitConfig.defaults?.coreModel ?? null;
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
   * @param model Model selected for the pending dispatch.
   * @returns Secret-bearing provider config.
   * @throws OpenAICompatibleProviderError when the provider or model cannot be dispatched.
   */
  function resolveGatewayProvider(providerId: string, model: string) {
    const profile = runtimeConfig().providerRegistry.get(providerId);

    if (!profile) {
      throw new OpenAICompatibleProviderError({
        code: 'provider_not_configured',
        message: 'Configured provider is unavailable.',
        status: 400,
        type: 'provider_error',
      });
    }
    if (!isProviderProfileDispatchable(profile)) {
      throw new OpenAICompatibleProviderError({
        code: 'provider_not_dispatchable',
        message: 'Configured provider is not dispatchable.',
        status: 503,
        type: 'provider_error',
      });
    }
    if (!profile.models.includes(model)) {
      throw new OpenAICompatibleProviderError({
        code: 'model_not_configured',
        message: 'Requested model is not configured for this provider.',
        status: 400,
        type: 'invalid_request_error',
      });
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
        providerId: coreDefaultProviderId(),
        model: coreDefaultModel(),
      },
      gateway: {
        providerId: gatewayDefaultProviderId(),
        model: gatewayDefaultModel(),
      },
    };
  }

  app.use('/api/worker-control/*', browserCors);
  registerWorkerControlRoutes({
    app,
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

  if (options.coreDb) {
    registerOperationAccessGuards({
      app,
      automationStore,
      coreDb: options.coreDb,
      quickChatWorkspaceIdForUser,
      store: sharedStore,
    });
  }

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
    resolveGatewayProvider,
    runtimeConfig,
  });

  registerQuickAndChatModeRoutes({
    app,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    coreDefaultModel,
    coreDefaultProviderId,
    inflightCommands,
    llmGatewayDispatcher,
    repositoryWorkspaceDb,
    requestStore,
    resolveGatewayProvider,
    runtimeConfig,
    startModeWorkerTurn,
    workerCoordinatorCandidates: currentWorkerCoordinatorCandidates,
  });

  registerThreadRoutes({ app, inflightCommands, requestStore });

  registerMaterialRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    openWorkspaceDb: repositoryWorkspaceDb,
    requestStore,
  });

  registerAutomationRoutes({ app, authorizedWorkspaceIds, automationStore, requestStore });

  registerSearchRoutes({ app, authorizedWorkspaceIds, requestStore });

  registerAgentCatalogRoutes({ app, authorizedWorkspaceIds, requestStore });

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
    coreDb: options.coreDb,
    requestStore,
    runtimeConfigManager,
    turnExecutor,
    workerControlGateway,
  });

  registerTaskModeRoute({
    app,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    inflightCommands,
    repositoryWorkspaceDb,
    requestStore,
    startModeWorkerTurn,
    workerCoordinatorCandidates: currentWorkerCoordinatorCandidates,
  });

  registerGoalRoutes({
    app,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    inflightCommands,
    mode,
    repositoryWorkspaceDb,
    requestStore,
    startModeWorkerTurn,
    turnExecutor,
    workerCoordinatorCandidates: currentWorkerCoordinatorCandidates,
  });

  registerWorkerRecoveryRoutes({
    app,
    coreDb: options.coreDb,
    repositoryWorkspaceDb,
    requestStore,
    authorizedWorkspaceIds,
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
    authorizedWorkspaceIds,
  });

  registerWorkspaceSharingRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    requestStore,
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
    providerCredentialResolver,
    requestStore,
    repositoryWorkspaceDb,
    runtimeConfig,
    schedulerEpoch,
    turnExecutor,
    workerPlacement,
  });

  registerApprovalRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    repositoryWorkspaceDb,
    requestStore,
  });

  registerArtifactRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    openWorkspaceDb: repositoryWorkspaceDb,
    requestStore,
    startModeWorkerTurn,
  });

  registerWorkspaceSyncRoutes({
    app,
    coreDb: options.coreDb,
    inflightCommands,
    repositoryWorkspaceDb,
    requestStore,
  });

  registerAgentEnvironmentRoutes({ app, repositoryWorkspaceDb });

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
