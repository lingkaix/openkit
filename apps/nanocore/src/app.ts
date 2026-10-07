import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type BootReadinessSnapshot, OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  type GatewayConfig,
  type InternalRoleProfilesConfig,
  type ProviderSubscriptionAccountSlotId,
  resolveProviderSubscriptionFamily,
  type SubscriptionProviderId,
} from '@openkit/config-schema';
import type { ActorRef, TurnSchema, WorkspaceRecordSchema } from '@openkit/protocol';
import { isSealedTurnTerminal } from '@openkit/protocol';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import {
  createAdministrationEnvironmentCandidateTools,
  createAdministrationEnvironmentTools,
} from './administration/environment-tools.js';
import { projectAgentCatalogEntries } from './agents/catalog-projection.js';
import type { AgentManifest } from './agents/manifest.js';
import { computeReadiness, isAgentLaunchable } from './agents/readiness.js';
import { resolveAgentSetup } from './agents/setup-resolver.js';
import { asApiError } from './api-errors.js';
import {
  type AppUpdateHostTransport,
  createSshAppUpdateHostTransport,
} from './app-update/host-transport.js';
import { recordWorkspaceAuditEvent } from './audit-events.js';
import {
  resolveSessionDeploymentAdminTokenId,
  verifyOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { type Actor, ensureLocalUser, isDeploymentAdminActor } from './auth/identity.js';
// Actor type used by mode worker turn request credential threading
import {
  type AuthVariables,
  type BetterAuthServer,
  createAuthMiddleware,
  isLoopbackHost,
} from './auth/middleware.js';
import { registerNanoHostTransportAdmissionRoutes } from './auth/nanohost-transport-admission.js';
import {
  createNanoHostTransportSessionAuthority,
  type NanoHostTransportSessionAuthority,
} from './auth/nanohost-transport-session.js';
import {
  authorizeWorkspace,
  isWorkspaceOperationAuthorized,
  registerOperationAccessGuards,
  requireCurrentDeploymentAdmin,
} from './auth/operation-authorizer.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import { createBootReadinessSnapshot } from './bootstrap/readiness.js';
import { createAgentNativeEnvironmentService } from './config/agent-native-environment.js';
import type { CoreMode } from './config/mode.js';
import { loadOpenKitConfig, type OpenKitConfig } from './config/openkit-config.js';
import {
  captureCoverageBindingFromOpenKitConfig,
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  type RuntimeConfigManager,
  type RuntimeConfigSnapshot,
  resolveDefaultAgentId,
} from './config/runtime-config.js';
import {
  RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from './config/runtime-config-files.js';
import { createDiagnosticsSnapshot } from './diagnostics/snapshot.js';
import type { WorkerCoordinatorCandidate } from './internal-agents/worker-coordinator.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import { registerLlmGatewayRoutes, registerWorkerInferenceRoutes } from './llm/gateway-routes.js';
import { GatewayUsageTracker } from './llm/gateway-usage.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { createConversationService, createTaskStartOperation } from './mode-entry-routes.js';
import { APP_OPENAPI_DOCUMENT } from './openapi.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
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
import {
  createProviderCredentialConfigured,
  createVaultProviderCredentialResolver,
  revokeVaultProviderCredential,
} from './providers/vault-credential-resolver.js';
import { registerRemoteMcpRoutes } from './remote-mcp-routes.js';
import {
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  prepareCapturedPendingCall,
} from './runtime/captured-pending-call.js';
import {
  markSchedulerAttemptForTerminalTurn,
  markSchedulerExecutionAttemptClosing,
} from './runtime/execution-attempt-records.js';
import { createGoalCoordinator } from './runtime/goal-coordinator.js';
import {
  advanceGoalForThread,
  checkGoalCommandIntent,
  type GoalOwnerServices,
  goalActor,
  readGoalView,
} from './runtime/goal-owner.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import {
  acceptNanoHostAttemptHeartbeatByBinding,
  adoptNanoHostAttemptReconnect,
  NanoHostAttemptHeartbeatRejectedError,
  resolveNanoHostAttemptTokenBinding,
} from './runtime/nanohost-attempt-records.js';
import { recordNanoHostRuntimeTargetConnectionClose } from './runtime/nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  type NanoHostSessionDispatch,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from './runtime/nanohost-session-dispatch.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { installPendingRequestAdmission } from './runtime/pending-request-flow.js';
import { cancelOwnedQueuedAdmission, startProductTurn } from './runtime/product-turn-start.js';
import { createCoordinatorTaskTool } from './runtime/task-admission.js';
import { waitForWorkerTurnTerminalState } from './runtime/task-turn-wait.js';
import {
  type ConfiguredWorkerLifecycleRuntime,
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './runtime/turn-executor-factory.js';
import type { TurnExecutor } from './runtime/types.js';
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
import { createWorkerEnvironmentRuntimeEffects } from './runtime/worker-environment-runtime-effects.js';
import {
  createDefaultWorkerMcpGateway,
  type WorkerMcpGateway,
} from './runtime/worker-mcp-gateway.js';
import { getWorkerStorageBinding } from './runtime/worker-storage-bindings.js';
import { updateBackendWorkspaceHandleCleanupStatus } from './runtime/workspace-sync-records.js';
import {
  listSchedulerAdmissionEntriesForWorkspace,
  type SchedulerWorkerStorageChoice,
} from './scheduler-records.js';
import { registerServiceRoutes } from './service-routes.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { registerWorkspaceTransferRoutes } from './storage/workspace-transfer-routes.js';
import { createHttpTelemetryMiddleware } from './telemetry.js';
import { registerTurnEventRoutes } from './turn-event-routes.js';
import { interruptProductTurn } from './turn-routes.js';
import { createVaultUnlockState, type VaultUnlockState } from './vault/vault-unlock-state.js';
import {
  createWorkerEnvironmentActivation,
  createWorkerEnvironmentAffectedStorageDeriver,
} from './worker-environments/worker-environment-activation.js';
import { createWorkerEnvironmentOperations } from './worker-environments/worker-environment-operations.js';
import { createWorkerEnvironmentPreparation } from './worker-environments/worker-environment-preparation.js';
import { registerWorkerMcpRoutes } from './worker-mcp-routes.js';
import {
  isTerminalWorkspaceDeletionRequest,
  listAllWorkspaceDeletionRequests,
  writeWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import { ensureUserQuickChatWorkspace } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { getWorkspaceRegistryLifecycleFact } from './workspace-sharing.js';

type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/**
 * Process-local NanoHost transport session authority owned by one Hono app.
 *
 * Connection-generation fencing lives in `nanohost-transport-session.ts`.
 * `createApp` installs the store and registers the production admission routes that
 * verify `nanohost-transport` Tokens and consume `admit` / `fencePredecessor` /
 * `mayCarryWork` without a parallel session framework.
 */
const nanoHostTransportSessionAuthorities = new WeakMap<
  Hono<{ Variables: AuthVariables }>,
  NanoHostTransportSessionAuthority
>();

/**
 * Returns the NanoHost transport session authority installed on one app.
 *
 * @param app Hono app created by `createApp`.
 * @returns Process-local session authority for connection-generation fencing.
 * @throws Error when the app was not created through `createApp`.
 */
export function getNanoHostTransportSessionAuthority(
  app: Hono<{ Variables: AuthVariables }>
): NanoHostTransportSessionAuthority {
  const authority = nanoHostTransportSessionAuthorities.get(app);
  if (!authority) {
    throw new Error('NanoHost transport session authority is not installed on this app.');
  }

  return authority;
}

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
  if (method === 'POST' && path.startsWith('/api/app/operations/')) {
    const id = path.slice('/api/app/operations/'.length);
    if (Object.hasOwn(OPERATION_DEFINITIONS, id)) {
      return OPERATION_DEFINITIONS[id as keyof typeof OPERATION_DEFINITIONS].mutating;
    }
  }

  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/responses')) {
    return true;
  }

  return (
    ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method) &&
    (path.startsWith('/api/workspaces/') || path.startsWith('/api/app/workspaces/'))
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
 * @param defaultAgentId Resolved User, Workspace, or Server Agent preference.
 * @returns Coordinator-visible worker candidates.
 */
function workerCoordinatorCandidates(
  store: FsStore,
  workspaceId: string,
  agentManifests: readonly AgentManifest[],
  defaultAgentId: string | null
): WorkerCoordinatorCandidate[] {
  store.getWorkspace(workspaceId);

  return [...agentManifests]
    .sort((left, right) => {
      const defaultOrder = Number(right.id === defaultAgentId) - Number(left.id === defaultAgentId);
      return defaultOrder || left.id.localeCompare(right.id);
    })
    .map((manifest) => {
      const readiness = computeReadiness(manifest);
      const launchable = isAgentLaunchable(readiness);

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
  /** Process-local gate coordinating ordinary Workspace mutation with deletion. */
  workspaceMutationAdmission?: WorkspaceMutationAdmission;
  turnExecutor?: TurnExecutor;
  /** Optional Pi AI client override for tests and embedded deployments. */
  llmPiAiClient?: PiAiGatewayClient;
  llmGatewayDispatcher?: LLMGatewayProviderDispatcher;
  gatewayUsageTracker?: GatewayUsageTracker;
  /** Loaded operator config used for app diagnostics defaults. */
  openKitConfig?: OpenKitConfig;
  /** Server-scoped logical model catalog and private routes. */
  gatewayConfig?: GatewayConfig;
  /** Server-scoped Internal Role Execution Profiles. */
  internalRoleProfiles?: InternalRoleProfilesConfig;
  providerRegistry?: ProviderRegistry;
  /** Resolver used to check provider profile credential references. */
  providerCredentialResolver?: ProviderCredentialResolver;
  providerDiagnostics?: ProviderDiagnosticsSnapshot;
  runtimeConfigManager?: RuntimeConfigManager;
  /** Provider-neutral subscription account manager override for tests and embedded deployments. */
  providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  automationStore?: AutomationStore;
  /** Process-local worker control gateway used by private Sandbox Integration routes. */
  workerControlGateway?: WorkerControlGateway;
  /** Process-local MCP supervisor used by private worker capability routes. */
  workerMcpGateway?: WorkerMcpGateway;
  /** Scheduler epoch owned by this app instance. */
  /** Configured scheduler placement used for admission. */
  workerPlacement?: 'local' | 'remote';
  agentManifests?: AgentManifest[];
  /** Boot readiness snapshot for this process. */
  bootReadiness?: BootReadinessSnapshot;
  /** Returns the current boot readiness snapshot for request-time admission checks. */
  getBootReadiness?: () => BootReadinessSnapshot;
  /** Process-local vault unlock state used by vault admin routes. */
  vaultUnlockState?: VaultUnlockState;
  /**
   * Optional process-local NanoHost transport session authority.
   *
   * When omitted, `createApp` installs a fresh connection-generation store.
   */
  nanohostTransportSessionAuthority?: NanoHostTransportSessionAuthority;
  /**
   * Optional App-update host transport.
   *
   * Tests inject an in-process transport. When omitted, boot-time `appUpdate` config
   * creates the SSH transport; absence of that config disables the capability.
   */
  appUpdateHostTransport?: AppUpdateHostTransport | null;
  /** Optional dispatcher bound to the same process-local NanoHost session authority. */
  nanoHostSessionDispatch?: NanoHostSessionDispatch;
  /** Shared worker lifecycle runtime that owns Harness continuations and Turn credentials. */
  workerLifecycleRuntime?: ConfiguredWorkerLifecycleRuntime;
}

/**
 * Creates the default worker-control gateway for one app instance.
 *
 * @param coreDb Optional server-scope database used for durable execution attempt binding checks.
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
        adoptNanoHostAttemptReconnect(coreDb, input);
      } catch (error) {
        throwSchedulerHeartbeatGatewayError(error);
      }
    },
    onHeartbeatAccepted: (input) => {
      try {
        acceptNanoHostAttemptHeartbeatByBinding(coreDb, {
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
      const resolution = resolveNanoHostAttemptTokenBinding(coreDb, input);

      if (resolution.status !== 'accepted') {
        // The gateway admitted and persisted exact terminal evidence before this hook. A
        // cancellation-owned closing attempt keeps that evidence without restoring effect authority.
        if (
          resolution.reason === 'attempt-not-live' &&
          resolveWorkerControlFinalStatusTokenBinding(coreDb, input).status === 'accepted'
        )
          return;
        throw new WorkerControlGatewayError(
          'worker_control_lease_not_live',
          'Worker control request lease is not live.',
          403
        );
      }

      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: resolution.attempt.attemptId,
        cause: 'worker-final-status',
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
    resolveTokenBinding: (input) => {
      const resolution = resolveNanoHostAttemptTokenBinding(coreDb, input);
      if (
        resolution.status === 'accepted' &&
        (!resolution.attempt.workerControlTokenHash ||
          !resolution.attempt.workerInferenceTokenHash ||
          !resolution.attempt.workerCapabilityTokenHash)
      ) {
        return { status: 'rejected', reason: 'binding-not-found' };
      }
      return resolution;
    },
    runFinalStatusTransaction: (operation) => coreDb.sqlite.transaction(operation).immediate(),
    runHeartbeatTransaction: (operation) => coreDb.sqlite.transaction(operation)(),
    sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
  });

  rebuildWorkerControlGatewaySessions(coreDb, gateway);
  return gateway;
}

/** Projects scheduler heartbeat rejections into the stable worker-control error surface. */
function throwSchedulerHeartbeatGatewayError(error: unknown): never {
  if (!(error instanceof NanoHostAttemptHeartbeatRejectedError)) {
    throw error;
  }
  if (error.reason === 'sequence-stale') {
    throw new WorkerControlGatewayError(
      'worker_control_sequence_stale',
      'Worker control heartbeat sequence is stale.',
      409
    );
  }
  if (error.reason === 'attempt-changed') {
    throw new WorkerControlGatewayError(
      'worker_control_identity_conflict',
      'Worker control heartbeat identity conflicts with the durable lease binding.',
      409
    );
  }
  if (error.reason === 'reconnect-required') {
    throw new WorkerControlGatewayError(
      'worker_control_reconnect_required',
      'Worker control session must reconnect after NanoCore restart.',
      503
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
  /** NanoCore mode selected for this app. */
  readonly mode: 'local' | 'server';
}

/**
 * Creates the default vault state for the selected Core mode.
 *
 * @param input App mode and data root.
 * @returns Process-local vault state.
 */
export function createDefaultVaultUnlockState(
  input: CreateDefaultVaultUnlockStateInput
): VaultUnlockState {
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
  const workspaceMutationAdmission =
    options.workspaceMutationAdmission ?? new WorkspaceMutationAdmission();
  if (dataRoot) {
    restoreWorkspaceDeletionMutationAdmission({
      dataRoot,
      workspaceMutationAdmission,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    });
  }
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
  sharedStore.setLiveCaptureCoverage(captureCoverageBindingFromOpenKitConfig(startupOpenKitConfig));
  const publicBaseUrl = startupOpenKitConfig.server?.publicBaseUrl;
  const browserCors = createBrowserCors(mode, [
    ...(startupOpenKitConfig.server?.cors?.origins ?? []),
    ...(publicBaseUrl ? [new URL(publicBaseUrl).origin] : []),
  ]);
  const bootReadiness = options.bootReadiness ?? createBootReadinessSnapshot();
  const getBootReadiness = options.getBootReadiness ?? (() => bootReadiness);
  const vaultUnlockState =
    options.vaultUnlockState ??
    (dataRoot
      ? createDefaultVaultUnlockState({
          dataRoot,
          mode,
        })
      : null);
  const providerCredentialResolverFallback: ProviderCredentialResolver = (secretRef) =>
    options.providerCredentialResolver?.(secretRef) ?? resolveEnvSecretRef(secretRef);
  const providerCredentialConfigured = createProviderCredentialConfigured({
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    fallback: providerCredentialResolverFallback,
  });
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
      ? {
          canonicalUserActive: (userId: string) => isCanonicalUserActive(options.coreDb!, userId),
          sessionDeploymentAdmin: (userId: string) =>
            resolveSessionDeploymentAdminTokenId(options.coreDb!, userId),
        }
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
    if (pathname === '/mcp') return 'remote-mcp';
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
    if (pathname === '/mcp') return 'remote-mcp';
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
  const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const llmPiAiClient = options.llmPiAiClient ?? new PiAiGatewayClient();
  const gatewayUsageTracker = options.gatewayUsageTracker ?? new GatewayUsageTracker();
  const providerSubscriptionAccountManager =
    options.providerSubscriptionAccountManager ??
    (options.coreDb && vaultUnlockState
      ? new ProviderSubscriptionAccountManager({
          coreDb: options.coreDb,
          vaultBackend: () => vaultUnlockState.backend(),
        })
      : null);
  const llmGatewayDispatcher =
    options.llmGatewayDispatcher ??
    new LLMGatewayProviderDispatcher({
      piAiClient: llmPiAiClient,
      ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
      usageTracker: gatewayUsageTracker,
    });
  const hasInlineRuntimeConfigInput = Boolean(
    options.openKitConfig ??
      options.providerRegistry ??
      options.providerDiagnostics ??
      options.agentManifests ??
      options.gatewayConfig ??
      options.internalRoleProfiles
  );
  const runtimeConfigManager =
    options.runtimeConfigManager ??
    createRuntimeConfigManager({
      dataRoot,
      captureCoverage: sharedStore,
      providerCredentialConfigured,
      ...(providerSubscriptionAccountManager
        ? { subscriptionAccounts: providerSubscriptionAccountManager }
        : {}),
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
              ...(options.gatewayConfig ? { gatewayConfig: options.gatewayConfig } : {}),
              ...(options.internalRoleProfiles
                ? { internalRoleProfiles: options.internalRoleProfiles }
                : {}),
            }),
          }
        : {}),
    });
  const automationStore = options.automationStore ?? new AutomationStore();
  const workerControlGateway =
    options.workerControlGateway ?? createDefaultWorkerControlGateway(options.coreDb);
  const workerMcpGateway =
    options.workerMcpGateway ?? createDefaultWorkerMcpGateway(options.coreDb);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(createHttpTelemetryMiddleware());
  const nanohostTransportSessionAuthority =
    options.nanohostTransportSessionAuthority ?? createNanoHostTransportSessionAuthority();
  if (options.coreDb && startupOpenKitConfig.nanohost) {
    const coreDb = options.coreDb;
    const targetId = startupOpenKitConfig.nanohost.identityId;
    const closePhysicalConnection = nanohostTransportSessionAuthority.closePhysicalConnection.bind(
      nanohostTransportSessionAuthority
    );
    /** Projects an explicit physical-session close through the existing durable target owner. */
    nanohostTransportSessionAuthority.closePhysicalConnection = (physicalConnection) => {
      const closed = closePhysicalConnection(physicalConnection);
      if (coreDb.sqlite.open && closed.closedGeneration !== null) {
        recordNanoHostRuntimeTargetConnectionClose(coreDb, {
          authoritativeGeneration: closed.authoritativeGeneration,
          closedGeneration: closed.closedGeneration,
          observedAt: new Date().toISOString(),
          targetId,
        });
      }
      return closed;
    };
  }
  const nanoHostSessionDispatch =
    options.nanoHostSessionDispatch ??
    createNanoHostSessionDispatch({
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      sessionAuthority: nanohostTransportSessionAuthority,
    });
  const workerEnvironmentRuntimeEffects =
    createWorkerEnvironmentRuntimeEffects(nanoHostSessionDispatch);
  const workerEnvironmentOperations = options.coreDb
    ? createWorkerEnvironmentOperations({
        coreDb: options.coreDb,
        inflightCommands,
        runtimeEffects: workerEnvironmentRuntimeEffects,
        store: sharedStore,
      })
    : null;
  const workerEnvironmentPreparation = options.coreDb
    ? createWorkerEnvironmentPreparation({
        store: sharedStore,
        inflightCommands,
        runtimeEffects: workerEnvironmentRuntimeEffects,
        configFilesForActor: (actor) => runtimeConfigFileService({ get: () => actor }),
        privateWorkspaceIdForUser: quickChatWorkspaceIdForUser,
        requireCurrentAdministrator: (actor) => {
          requireCurrentDeploymentAdmin(options.coreDb!, actor);
        },
        authorizePrivateHome: ({ actor, workspaceId, threadId, turnId }) => {
          if (workspaceId !== quickChatWorkspaceIdForUser(actor.userId)) return false;
          try {
            const thread = sharedStore.getThread(workspaceId, threadId);
            if (thread.entryPath !== 'administration') return false;
            const turn = sharedStore
              .listThreadTurns(workspaceId, threadId)
              .find((candidate) => candidate.id === turnId);
            // Preparation authorizes its private home before creating the direct Turn.
            return (
              !turn || (turn.triggerActor.kind === 'user' && turn.triggerActor.id === actor.userId)
            );
          } catch {
            return false;
          }
        },
        deriveAffectedStorage: createWorkerEnvironmentAffectedStorageDeriver({
          coreDb: options.coreDb,
          store: sharedStore,
        }),
      })
    : null;
  const workerEnvironmentActivation =
    options.coreDb && workerEnvironmentPreparation
      ? createWorkerEnvironmentActivation({
          coreDb: options.coreDb,
          store: sharedStore,
          preparation: workerEnvironmentPreparation,
          runtimeEffects: workerEnvironmentRuntimeEffects,
          inflightCommands,
          configFilesForActor: (actor) => runtimeConfigFileService({ get: () => actor }),
          requireCurrentAdministrator: (actor) => {
            requireCurrentDeploymentAdmin(options.coreDb!, actor);
          },
          reloadRuntimeConfig: () => runtimeConfigManager.reload({ dryRun: false, mode: 'safe' }),
          replaceResidentWork: async (input) => {
            const { actor, replaceNow, affectedStorage, residentMembers, requestId, target } =
              input;
            const coreDb = options.coreDb!;
            const requireAuthority = () => {
              workerEnvironmentPreparation.readResolved({ actor }, input.resolvedCandidate);
              for (const ref of affectedStorage) {
                const binding = getWorkerStorageBinding(coreDb, { storageRef: ref.storageRef });
                if (
                  !binding ||
                  !binding.contributors.every(
                    (contributor) =>
                      contributor.workspaceId === replaceNow.workspaceId &&
                      contributor.responsibleUserId === actor.userId &&
                      sharedStore.getThread(contributor.workspaceId, contributor.threadId)
                        .workspaceId === replaceNow.workspaceId
                  )
                )
                  throw new Error('Worker source audience changed.');
              }
              requireCurrentDeploymentAdmin(coreDb, actor);
              if (
                !isWorkspaceOperationAuthorized(coreDb, actor, replaceNow.workspaceId, {
                  authentication: 'deployment-admin',
                  mutating: true,
                  policyOperation: 'workspace.configure',
                })
              )
                throw new Error('Worker environment authority changed.');
            };
            requireAuthority();
            if (affectedStorage.length !== 1)
              throw new Error('Resident storage group is unavailable.');
            const expected = affectedStorage[0]!;
            const before = getWorkerStorageBinding(coreDb, { storageRef: expected.storageRef });
            if (!before || before.revision !== expected.expectedRevision)
              throw new Error('Worker storage changed.');
            for (const member of residentMembers) {
              if (!member.turnId) continue;
              requireAuthority();
              const turn = sharedStore.getTurn(
                replaceNow.workspaceId,
                member.threadId,
                member.turnId
              );
              if (isSealedTurnTerminal(turn.status)) continue;
              await interruptProductTurn({
                store: sharedStore,
                coreDb,
                inflightCommands,
                turnExecutor,
                workspaceId: replaceNow.workspaceId,
                threadId: member.threadId,
                turnId: member.turnId,
                requestId,
              });
            }
            for (const member of residentMembers) {
              if (!member.turnId) continue;
              const terminal = await waitForWorkerTurnTerminalState(sharedStore, member.turnId);
              if (!isSealedTurnTerminal(terminal.status))
                throw new Error('Worker still requires human intervention.');
              markSchedulerAttemptForTerminalTurn(coreDb, terminal);
            }
            requireAuthority();
            const released = getWorkerStorageBinding(coreDb, { storageRef: before.storageRef });
            if (
              !released ||
              released.scopeDigest !== before.scopeDigest ||
              released.layoutDigest !== before.layoutDigest ||
              released.attachmentGeneration !== before.attachmentGeneration ||
              !(
                (released.revision === before.revision &&
                  released.state === before.state &&
                  released.currentSandboxBindingRef === before.currentSandboxBindingRef) ||
                (released.revision === before.revision + 1 &&
                  released.state === 'idle' &&
                  released.currentSandboxBindingRef === null)
              )
            )
              throw new Error('Worker storage changed during interruption.');
            // The ordinary scheduler resolves the new AEP and retains queued work until dispatch is eligible.
            await new Promise<void>((resolve, reject) => {
              void startModeWorkerTurn({
                store: sharedStore,
                triggerActor: { kind: 'user', id: actor.userId },
                requestActor: actor,
                workspaceId: replaceNow.workspaceId,
                threadId: replaceNow.threadId,
                prompt: replaceNow.prompt,
                requestedAgentId: target.agentId,
                requestId,
                onTurnCreated: () => resolve(),
                workerStorageChoice: {
                  kind: 'selected',
                  storageRef: before.storageRef,
                  expectedRevision: released.revision,
                  purpose: 'work',
                  goalId: null,
                  taskId: null,
                },
              }).catch(reject);
            });
            requireAuthority();
            const after = getWorkerStorageBinding(coreDb, { storageRef: before.storageRef });
            const image = workerEnvironmentPreparation.readResolved(
              { actor },
              input.resolvedCandidate
            ).resolved.image;
            const sandbox = after?.currentSandboxBindingRef
              ? (coreDb.sqlite
                  .prepare(
                    'SELECT image_digest AS imageDigest, health_state AS health, cleanup_state AS cleanup FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?'
                  )
                  .get(after.currentSandboxBindingRef) as
                  | { imageDigest: string; health: string; cleanup: string }
                  | undefined)
              : undefined;
            const disposition =
              after?.state === 'attached' &&
              after.attachmentGeneration > before.attachmentGeneration &&
              sandbox?.imageDigest === image.digest &&
              sandbox.health === 'ready' &&
              sandbox.cleanup === 'clean'
                ? ('reattached' as const)
                : after?.state === 'idle' && after.currentSandboxBindingRef === null
                  ? ('fenced' as const)
                  : after?.state === 'attached' &&
                      after.currentSandboxBindingRef === before.currentSandboxBindingRef &&
                      after.attachmentGeneration === before.attachmentGeneration
                    ? ('unchanged' as const)
                    : ('unknown' as const);
            return [{ ...expected, disposition }];
          },
        })
      : null;
  nanoHostTransportSessionAuthorities.set(app, nanohostTransportSessionAuthority);
  const configuredWorkerRuntime =
    options.workerLifecycleRuntime ??
    (options.turnExecutor || process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1'
      ? null
      : createConfiguredWorkerLifecycleRuntime({
          readRuntimeConfig: () => runtimeConfigManager.current(),
          coreDb: options.coreDb,
          ...(vaultUnlockState ? { vaultBackend: () => vaultUnlockState.backend() } : {}),
          nanoHostSessionDispatch,
          workerControlGateway,
          workspaceMutationAdmission,
        }));
  const turnExecutor =
    options.turnExecutor ??
    configuredWorkerRuntime?.turnExecutor ??
    createConfiguredTurnExecutor({
      coreDb: options.coreDb,
      workerControlGateway,
      workspaceMutationAdmission,
    });
  const workerPlacement = options.workerPlacement ?? 'local';
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

  sharedStore.setWorkspaceAgentCatalogProjection(() =>
    projectAgentCatalogEntries(runtimeConfig().agentManifests)
  );

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
      resolveDefaultAgentId(snapshot, workspaceId)
    );
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
    readonly requestActor?: Actor;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly profileId?: string | undefined;
    /** Explicit conversation preference admitted with this Turn. */
    readonly reasoningEffort?: z.infer<typeof TurnSchema>['reasoningEffort'];
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
    readonly workerStorageChoice?: SchedulerWorkerStorageChoice;
    readonly onTurnCreated?: (
      turn: z.infer<typeof TurnSchema>,
      agentSessionId: string | null
    ) => void;
  }): Promise<z.infer<typeof TurnSchema>> {
    const snapshot = runtimeConfig();
    const handle = await startProductTurn({
      input: {
        input: input.prompt,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        modelId: input.modelId,
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        requestId: input.requestId,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
      },
      providerCredentialResolver,
      requestedAgentId: input.requestedAgentId,
      ...(input.reservedTurnId ? { reservedTurnId: input.reservedTurnId } : {}),
      ...(input.workerStorageChoice ? { workerStorageChoice: input.workerStorageChoice } : {}),
      ...(input.requestActor ? { requestActor: input.requestActor } : {}),
      snapshot,
      store: input.store,
      triggerActor: input.triggerActor,
      turnExecutor,
      workerPlacement,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      ...(input.onTurnCreated ? { onTurnCreated: input.onTurnCreated } : {}),
    });

    markSchedulerAttemptForTerminalTurn(options.coreDb, handle.turn);
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
      userId: c.get('actor')?.userId ?? LOCAL_USER_ID,
      workspaceIds: store.listWorkspaces().map((workspace) => workspace.id),
      runtimeConfigManager,
      readRuntimeConfigStatus: () => runtimeConfigManager.status(),
      revokeProviderSecret: (secretRef) => {
        if (!options.coreDb || !vaultUnlockState) {
          throw new RuntimeConfigFileServiceError(
            'vault_storage_unavailable',
            'Vault storage is unavailable.',
            503
          );
        }
        revokeVaultProviderCredential(
          { coreDb: options.coreDb, vaultBackend: () => vaultUnlockState.backend() },
          secretRef
        );
      },
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
   * Lists runtime provider ids bound to one provider-subscription account pair.
   *
   * @param pair Provider-subscription account identity.
   * @returns Lexicographically ordered bound provider profile ids.
   */
  function boundProviderIdsForSubscriptionAccount(pair: {
    subscriptionProviderId: SubscriptionProviderId;
    accountSlotId: ProviderSubscriptionAccountSlotId;
  }): string[] {
    return runtimeConfig()
      .providerRegistry.list()
      .filter((profile) => {
        const extension = profile.extensions?.openkit?.subscriptionAccount;
        return (
          extension?.accountSlotId === pair.accountSlotId &&
          resolveProviderSubscriptionFamily(profile) === pair.subscriptionProviderId
        );
      })
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

  app.use('/api/worker-control/*', browserCors);
  registerWorkerControlRoutes({
    app,
    coreDb: options.coreDb,
    workerControlGateway,
  });

  app.use('/api/worker-inference/*', browserCors);
  registerWorkerInferenceRoutes({
    app,
    providerCredentialConfigured,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    llmGatewayDispatcher,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    resolveGatewayProvider,
    runtimeConfig,
    workerControlGateway,
  });

  app.use('/api/worker-capabilities/*', browserCors);
  registerWorkerMcpRoutes({
    ...(configuredWorkerRuntime?.captureArtifact
      ? { captureArtifact: configuredWorkerRuntime.captureArtifact }
      : {}),
    app,
    approvalPolicy: startupOpenKitConfig.policy,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    runtimeConfig,
    store: sharedStore,
    vaultUnlockState,
    workerControlGateway,
    workerMcpGateway,
    workspaceMutationAdmission,
  });

  registerNanoHostSessionSemanticRoutes({
    app,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    dispatch: nanoHostSessionDispatch,
    ...(configuredWorkerRuntime
      ? {
          harnessCommandDispatched: configuredWorkerRuntime.acceptNanoHostHarnessCommand,
          harnessResultSettled: configuredWorkerRuntime.acceptNanoHostHarnessResult,
          harnessCommandDeliveryFailed: configuredWorkerRuntime.failNanoHostHarnessDelivery,
        }
      : {}),
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
  });

  registerNanoHostSessionEffectRoutes({
    app,
    dispatch: nanoHostSessionDispatch,
  });

  app.use('/api/*', browserCors);
  app.use('/api/*', createAuthMiddleware(mode, auth, authMiddlewareOptions));
  app.use('/v1/*', browserCors);
  app.use('/v1/*', createAuthMiddleware(mode, auth, authMiddlewareOptions));
  app.use('/mcp', browserCors);
  app.use('/mcp', createAuthMiddleware(mode, auth, authMiddlewareOptions));

  if (options.coreDb) {
    registerOperationAccessGuards({
      app,
      coreDb: options.coreDb,
      quickChatWorkspaceIdForUser,
      store: sharedStore,
      workspaceMutationAdmission,
    });
  }

  if (auth) {
    app.all('/api/auth/*', (c) => auth.handler(c.req.raw));
  }

  registerNanoHostTransportAdmissionRoutes({
    app,
    coreDb: options.coreDb,
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
    sessionAuthority: nanohostTransportSessionAuthority,
  });

  registerServiceRoutes({ app, mode, turnExecutor });

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

  const diagnosticsServices = {
    runtimeConfig,
    runtimeConfigManager,
    getBootReadiness,
    gatewayUsageTracker,
    turnExecutor,
    providerSubscriptionAccountManager: providerSubscriptionAccountManager ?? undefined,
    providerCredentialConfigured,
    dataRoot,
    mode,
  };

  const appUpdateTransport =
    options.appUpdateHostTransport !== undefined
      ? options.appUpdateHostTransport
      : startupOpenKitConfig.appUpdate
        ? createSshAppUpdateHostTransport(startupOpenKitConfig.appUpdate, dataRoot)
        : null;
  const appUpdateServices = {
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    transport: appUpdateTransport,
  };

  registerWorkspaceTransferRoutes({
    app,
    coreDb: options.coreDb,
    dataRoot,
    requestStore,
  });

  app.get('/api/openapi.json', (c) => c.json(APP_OPENAPI_DOCUMENT));

  const onRuntimeConfigReloadApplied = () =>
    sharedStore.refreshWorkspaceConfigNames(
      runtimeConfigManager.current().workspaceConfigs.map(({ config, workspaceId }) => ({
        name: config.workspace.name,
        workspaceId,
      }))
    );
  const runtimeConfigOperations: NonNullable<
    OperationInvocationDependencies['runtimeConfigOperations']
  > = {
    nativeEnvironment: options.coreDb
      ? createAgentNativeEnvironmentService({
          coreDb: options.coreDb,
          store: sharedStore,
          manager: runtimeConfigManager,
          onReloadApplied: onRuntimeConfigReloadApplied,
          filesForActor: (actor) => runtimeConfigFileService({ get: () => actor }),
        })
      : undefined,
    onReloadApplied: onRuntimeConfigReloadApplied,
    filesForActor: (actor) => runtimeConfigFileService({ get: () => actor }),
    manager: runtimeConfigManager,
  };
  const providerSubscriptionOperations = {
    accountManager: providerSubscriptionAccountManager,
    boundProviderIds: boundProviderIdsForSubscriptionAccount,
  };

  registerLlmGatewayRoutes({
    app,
    providerCredentialConfigured,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    requestStore,
    llmGatewayDispatcher,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    resolveGatewayProvider,
    runtimeConfig,
  });

  const administrationServices: NonNullable<
    OperationInvocationDependencies['administrationServices']
  > = {
    providerCredentialConfigured,
    coreDb: options.coreDb,
    environmentToolsForTurn: (context) => {
      if (!workerEnvironmentOperations || !workerEnvironmentPreparation) {
        throw new Error('Worker environment operations are not configured.');
      }
      return createAdministrationEnvironmentTools({
        actor: context.actor,
        operations: workerEnvironmentOperations,
        candidateTools: createAdministrationEnvironmentCandidateTools({
          actor: context.actor,
          administrationThreadId: context.administrationThreadId,
          administrationTurnId: context.administrationTurnId,
          prepare: workerEnvironmentPreparation.prepare,
        }),
      });
    },
    inflightCommands,
    llmGatewayDispatcher,
    mode,
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    quickChatWorkspaceIdForUser,
    resolveGatewayProvider,
    runtimeConfig,
    reloadRuntimeConfig: () => runtimeConfigManager.reload({ dryRun: false, mode: 'safe' }),
    runtimeConfigFiles: (actor) => runtimeConfigFileService({ get: () => actor }),
  };

  const goalServices = (): GoalOwnerServices => ({
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    inflightCommands,
    wake: (workspaceId, goalId) => goalCoordinator.wake(workspaceId, goalId),
    interrupt: (turn) => {
      void interruptProductTurn({
        store: sharedStore,
        inflightCommands,
        coreDb: options.coreDb,
        turnExecutor,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        requestId: randomUUID(),
      }).catch((error) =>
        console.warn(
          'Linked Task interrupt requires inspection:',
          error instanceof Error ? error.message : 'unknown'
        )
      );
    },
  });
  const goalCoordinator = createGoalCoordinator({
    workspaceMutationAdmission,
    store: sharedStore,
    coreDb: options.coreDb,
    openWorkspace: repositoryWorkspaceDb,
    runtimeConfig,
    llmGatewayDispatcher,
    resolveGatewayProvider,
    providerCredentialConfigured,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    services: goalServices,
    taskTool: (goalId, coordinatorTurnId) =>
      createCoordinatorTaskTool({
        store: sharedStore,
        coreDb: options.coreDb,
        openWorkspace: repositoryWorkspaceDb,
        inflightCommands,
        startWorker: startModeWorkerTurn,
        workspaceMutationAdmission,
        goalId,
        coordinatorTurnId,
      }),
  });
  const goalRequesterAuthority = (
    record: import('./runtime/pending-requests.js').PendingRequestRecord
  ): boolean | undefined => {
    if (record.requesterKind !== 'coordinator') return undefined;
    const db = repositoryWorkspaceDb(record.workspaceId);
    try {
      const goal = readGoalView(sharedStore, db, String(record.governedIntent?.goalId)).goal;
      return Boolean(
        goal &&
          options.coreDb &&
          authorizeWorkspace(options.coreDb, goalActor(goal), goal.workspaceId, {
            policyOperation: 'workspace.write',
            mutating: true,
          })
      );
    } finally {
      db.sqlite.close();
    }
  };
  const goalRequestCommitted = (
    sqlite: import('better-sqlite3').Database,
    record: import('./runtime/pending-requests.js').PendingRequestRecord
  ): void => advanceGoalForThread(sqlite, record.threadId);

  const chatService = createConversationService({
    providerCredentialConfigured,
    assertProjectWorkspace,
    coreDb: options.coreDb,
    inflightCommands,
    workspaceMutationAdmission,
    llmGatewayDispatcher,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    repositoryWorkspaceDb,
    resolveGatewayProvider,
    runtimeConfig,
    startModeWorkerTurn,
    workerCoordinatorCandidates: currentWorkerCoordinatorCandidates,
    goalServices,
  });

  const pendingAssistantDelivery = { startTurn: chatService.acceptPendingInput };

  const taskStart = createTaskStartOperation({
    assertProjectWorkspace,
    coreDb: options.coreDb,
    inflightCommands,
    workspaceMutationAdmission,
    repositoryWorkspaceDb,
    startModeWorkerTurn,
    workerCoordinatorCandidates: currentWorkerCoordinatorCandidates,
  });

  const pendingWorkerDelivery = {
    async startTurn(store: FsStore, turnId: string) {
      const turn = store.getTurnById(turnId);
      if (!turn.agentId) throw new Error('Outcome Turn has no worker Agent.');
      // An existing queued admission belongs to the scheduler dispatch loop after restart.
      if (
        options.coreDb?.sqlite
          .prepare(
            "SELECT 1 FROM scheduler_admission_entries WHERE turn_id = ? AND status = 'queued'"
          )
          .get(turn.id)
      )
        return;
      const identity = createHash('sha256')
        .update(JSON.stringify([turn.workspaceId, turn.threadId, turn.id]))
        .digest('hex');
      const requestId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;

      const handle = await startProductTurn({
        input: {
          input: 'Receive pending request outcomes.',
          requestId,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
        },
        requestedAgentId: turn.agentId,
        reservedTurnId: turn.id,
        providerCredentialResolver,
        snapshot: runtimeConfig(),
        store,
        triggerActor: turn.triggerActor,
        turnExecutor,
        workerPlacement,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      }).catch((error: unknown) => {
        // Only this refused outcome attempt retires its still-queued scheduler ownership.
        if (options.coreDb && error instanceof TurnStartValidationError) {
          const entry = listSchedulerAdmissionEntriesForWorkspace(options.coreDb, {
            workspaceId: turn.workspaceId,
            statuses: ['queued'],
          }).find((candidate) => candidate.turnId === turn.id && candidate.requestId === requestId);
          if (entry)
            cancelOwnedQueuedAdmission(options.coreDb, {
              queueEntryId: entry.queueEntryId,
              workspaceId: turn.workspaceId,
            });
        }
        throw error;
      });
      markSchedulerAttemptForTerminalTurn(options.coreDb, handle.turn);
    },
  };

  if (options.coreDb || sharedStore.getDataRoot())
    installPendingRequestAdmission(sharedStore, {
      agentAuthority: (record) =>
        runtimeConfig().agentManifests.some((manifest) => manifest.id === record.agentId),
      workerDelivery: pendingWorkerDelivery,
      assistantDelivery: pendingAssistantDelivery,
      coordinatorDelivery: goalCoordinator,
      ...(options.coreDb ? { goalTerminal: goalCoordinator.terminal } : {}),
      requesterAuthority: goalRequesterAuthority,
      checkCommandIntent: checkGoalCommandIntent,
      requestCommitted: goalRequestCommitted,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      openWorkspace(workspaceId) {
        if (options.coreDb) return repositoryWorkspaceDb(workspaceId);
        const root = sharedStore.getDataRoot();
        if (!root) throw new Error('Pending requests have no workspace database.');
        const workspaceDb = openWorkspaceDb(root, workspaceId);
        applyScopedMigrations(workspaceDb);
        return workspaceDb;
      },
    });
  const pendingRequestServices: NonNullable<
    OperationInvocationDependencies['pendingRequestServices']
  > = {
    workerDelivery: pendingWorkerDelivery,
    assistantDelivery: pendingAssistantDelivery,
    coordinatorDelivery: goalCoordinator,
    ...(options.coreDb ? { goalTerminal: goalCoordinator.terminal } : {}),
    requesterAuthority: goalRequesterAuthority,
    checkCommandIntent: checkGoalCommandIntent,
    requestCommitted: goalRequestCommitted,
    agentAuthority: (record) =>
      runtimeConfig().agentManifests.some((manifest) => manifest.id === record.agentId),
    coreDb: options.coreDb,
    prepareCapturedCall: (record, workspaceDb) =>
      prepareCapturedPendingCall({
        record,
        workspaceDb,
        coreDb: options.coreDb,
        catalog:
          runtimeConfig().workspaceMcpServerCatalogs.find(
            (entry) => entry.workspaceId === record.workspaceId
          )?.catalog ?? null,
        vaultBackend: vaultUnlockState ? () => vaultUnlockState.backend() : undefined,
        workerMcpGateway,
      }),
    evaluateCapturedCall: (record, sqlite, prepared) => {
      const snapshot = runtimeConfig();
      const manifest = snapshot.agentManifests.find((candidate) => candidate.id === record.agentId);
      const workspaceConfig = snapshot.workspaceConfigs.find(
        (entry) => entry.workspaceId === record.workspaceId
      )?.config;
      const userConfig = snapshot.userConfigs.find(
        (entry) => entry.userId === record.responsibleUserId
      )?.config;
      const setup = manifest
        ? resolveAgentSetup(manifest, {
            gatewayConfig: snapshot.gatewayConfig,
            providerRegistry: snapshot.providerRegistry,
            workspaceId: record.workspaceId,
            ...(workspaceConfig ? { workspaceConfig } : {}),
            ...(userConfig ? { userConfig } : {}),
          }).setup
        : null;
      return evaluateCapturedPendingCall({
        selectedMcpServerIds: setup?.manifest.mcp?.map((server) => server.id) ?? [],
        manifest:
          snapshot.agentManifests.find((manifest) => manifest.id === record.agentId) ?? null,
        catalog:
          snapshot.workspaceMcpServerCatalogs.find(
            (entry) => entry.workspaceId === record.workspaceId
          )?.catalog ?? null,
        coreDb: options.coreDb,
        record,
        sqlite,
        prepared,
      });
    },
    executeCapturedCall: (record, _actor, workspaceDb, prepared, executionCall) => {
      const snapshot = runtimeConfig();
      return executeCapturedPendingCall({
        catalog:
          snapshot.workspaceMcpServerCatalogs.find(
            (entry) => entry.workspaceId === record.workspaceId
          )?.catalog ?? null,
        coreDb: options.coreDb,
        record,
        workerMcpGateway,
        workspaceDb,
        prepared,
        executionCall,
      });
    },
    inflightCommands,
    repositoryWorkspaceDb,
  };

  registerOperationJsonRoutes({
    diagnosticsServices,
    ...(vaultUnlockState ? { vaultUnlockState } : {}),
    administrationServices,
    appUpdateServices,
    workerEnvironmentServices: {
      operations: workerEnvironmentOperations,
      ...(workerEnvironmentPreparation ? { prepare: workerEnvironmentPreparation.prepare } : {}),
      ...(workerEnvironmentActivation ? { activate: workerEnvironmentActivation.activate } : {}),
    },
    closeWorkspaceMcpSessions: (workspaceId) => workerMcpGateway.closeWorkspace(workspaceId),
    ...(dataRoot
      ? {
          afterUserDisabled: (userId: string) =>
            reconcileWorkspaceDeletionMutationAdmissionAfterUserDisabled({
              dataRoot,
              workspaceMutationAdmission,
              ...(options.coreDb ? { coreDb: options.coreDb } : {}),
              userId,
            }),
        }
      : {}),
    turnStartServices: {
      coreDb: options.coreDb,
      inflightCommands,
      providerCredentialResolver,
      runtimeConfig,
      turnExecutor,
      workerPlacement,
    },
    turnExecutor,

    app,
    automationStore,
    conversationService: chatService,
    taskStart,
    pendingRequestServices,
    startModeWorkerTurn,
    coreDb: options.coreDb,
    workspaceMutationAdmission,
    inflightCommands,
    runtimeConfigManager,
    runtimeConfigOperations,
    providerSubscriptionOperations,
    repositoryWorkspaceDb,
    requestStore,
    goalServices: goalServices(),
    mode,
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
    dataRoot,
    nanoHostSessionAuthority: nanohostTransportSessionAuthority,
  });

  registerRemoteMcpRoutes({
    diagnosticsServices,
    ...(vaultUnlockState ? { vaultUnlockState } : {}),
    administrationServices,
    appUpdateServices,
    workerEnvironmentServices: {
      operations: workerEnvironmentOperations,
      ...(workerEnvironmentPreparation ? { prepare: workerEnvironmentPreparation.prepare } : {}),
      ...(workerEnvironmentActivation ? { activate: workerEnvironmentActivation.activate } : {}),
    },
    closeWorkspaceMcpSessions: (workspaceId) => workerMcpGateway.closeWorkspace(workspaceId),
    ...(dataRoot
      ? {
          afterUserDisabled: (userId: string) =>
            reconcileWorkspaceDeletionMutationAdmissionAfterUserDisabled({
              dataRoot,
              workspaceMutationAdmission,
              ...(options.coreDb ? { coreDb: options.coreDb } : {}),
              userId,
            }),
        }
      : {}),
    turnStartServices: {
      coreDb: options.coreDb,
      inflightCommands,
      providerCredentialResolver,
      runtimeConfig,
      turnExecutor,
      workerPlacement,
    },
    turnExecutor,

    app,
    automationStore,
    conversationService: chatService,
    taskStart,
    pendingRequestServices,
    runtimeConfigManager,
    runtimeConfigOperations,
    providerSubscriptionOperations,
    goalServices: goalServices(),
    startModeWorkerTurn,
    repositoryWorkspaceDb,
    getBootReadiness,
    coreDb: options.coreDb,
    store: sharedStore,
    inflightCommands,
    workspaceMutationAdmission,
    mode,
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
    dataRoot,
    nanoHostSessionAuthority: nanohostTransportSessionAuthority,
  });

  registerTurnEventRoutes({
    app,
    requestStore,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
  });

  if (options.coreDb && sharedStore.getDataRoot()) goalCoordinator.boot();
  return app;
}

/** Rebuilds deletion fences from durable requests before any process-owned mutation recovery. */
export function restoreWorkspaceDeletionMutationAdmission(input: {
  coreDb?: CoreDb;
  dataRoot: string;
  workspaceMutationAdmission: WorkspaceMutationAdmission;
}): void {
  if (input.coreDb) {
    const lifecycleRows = input.coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId
         FROM workspace_registry
         WHERE status IN ('deleting', 'deleted')`
      )
      .all() as Array<{ workspaceId: string }>;
    for (const { workspaceId } of lifecycleRows) {
      input.workspaceMutationAdmission.restoreClosed(workspaceId);
    }
  }
  const requestsByWorkspace = new Map<
    string,
    ReturnType<typeof listAllWorkspaceDeletionRequests>
  >();
  for (const request of listAllWorkspaceDeletionRequests(input.dataRoot)) {
    const requests = requestsByWorkspace.get(request.workspaceId) ?? [];
    requests.push(request);
    requestsByWorkspace.set(request.workspaceId, requests);
  }
  for (const [workspaceId, requests] of requestsByWorkspace) {
    const nonterminal = requests.filter((request) => !isTerminalWorkspaceDeletionRequest(request));
    if (nonterminal.length === 0) {
      continue;
    }
    input.workspaceMutationAdmission.restoreClosed(workspaceId);
    if (!input.coreDb || nonterminal.length !== 1) {
      continue;
    }
    const [request] = nonterminal;
    const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, workspaceId);
    if (
      request &&
      ['requested', 'fenced'].includes(request.phase) &&
      registry?.status === 'active' &&
      registry.ownerUserId === request.originalOwnerUserId &&
      registry.registryRevision === request.expectedRegistryRevision &&
      !isCanonicalUserActive(input.coreDb, request.originalOwnerUserId)
    ) {
      writeWorkspaceDeletionRequest(input.dataRoot, { ...request, phase: 'blocked' });
      input.workspaceMutationAdmission.reopen(workspaceId);
    }
  }
}

/** Drains affected gates before a durable user disable blocks and reopens pre-transition requests. */
async function reconcileWorkspaceDeletionMutationAdmissionAfterUserDisabled(input: {
  coreDb?: CoreDb;
  dataRoot: string;
  userId: string;
  workspaceMutationAdmission: WorkspaceMutationAdmission;
}): Promise<void> {
  const workspaceIds = new Set(
    listAllWorkspaceDeletionRequests(input.dataRoot)
      .filter(
        (request) =>
          request.originalOwnerUserId === input.userId &&
          ['requested', 'fenced'].includes(request.phase)
      )
      .map((request) => request.workspaceId)
  );
  await Promise.all(
    [...workspaceIds].map((workspaceId) => input.workspaceMutationAdmission.close(workspaceId))
  );
  restoreWorkspaceDeletionMutationAdmission(input);
}
