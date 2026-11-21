import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import {
  type BootReadinessSnapshot,
  NON_API_EXPOSURE_DEFINITIONS,
  OPERATION_DEFINITIONS,
  OPERATION_REGISTRY,
  type ReleaseBuildIdentity,
} from '@openkit/app-api-schemas';
import {
  type GatewayConfig,
  type InternalRoleProfilesConfig,
  type ProviderSubscriptionAccountSlotId,
  resolveProviderSubscriptionFamily,
  resolveWorkspaceMcpServer,
  type SubscriptionProviderId,
} from '@openkit/config-schema';
import type { ActorRef, Item, TurnSchema } from '@openkit/protocol';
import {
  allocateEntityId,
  canonicalIdentifierName,
  canonicalJsonText,
  compareCodeUnits,
  deriveEntityId,
  isEntityId,
  isSealedTurnTerminal,
  workspaceIdForOwner,
} from '@openkit/protocol';
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
import { type AgentSetupResolverDependencies, resolveAgentSetup } from './agents/setup-resolver.js';
import { asApiError, asOperationError } from './api-errors.js';
import {
  type AppUpdateHostTransport,
  createSshAppUpdateHostTransport,
} from './app-update/host-transport.js';
import { registerArtifactFileRoutes } from './artifact-file-routes.js';
import { prepareWorkspaceAuditEvent } from './audit-events.js';
import { resolveSessionDeploymentAdminTokenId } from './auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from './auth/access-token-verification.js';
import { auditAuthenticationFromActor } from './auth/audit-attribution.js';
import { type Actor, getLocalUserId, isDeploymentAdminActor } from './auth/identity.js';
import { isLoopbackHost } from './auth/loopback-host.js';
// Actor type used by mode worker turn request credential threading
import {
  type AuthVariables,
  type BetterAuthServer,
  createAuthMiddleware,
} from './auth/middleware.js';
import { registerNanoHostTransportAdmissionRoutes } from './auth/nanohost-transport-admission.js';
import { fenceNanoHostTransportAuthority } from './auth/nanohost-transport-lifecycle.js';
import {
  createNanoHostTransportSessionAuthority,
  type NanoHostTransportSessionAuthority,
} from './auth/nanohost-transport-session.js';
import { listNanoHostTransportTokenRecords } from './auth/nanohost-transport-token-store.js';
import {
  authorizeWorkspace,
  currentWorkspaceAuthority,
  DeploymentAdminRequiredError,
  evaluateOwnedUserOperation,
  evaluateProductAuthorization,
  isCurrentDeploymentAdministrator,
  isCurrentServerPolicyAuthor,
  isUsablePresentedCredential,
  isWorkspaceOperationAuthorized,
  readCurrentWorkspacePolicy,
  requireAdministratorOperation,
} from './auth/operation-authorizer.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import { createBootReadinessSnapshot, scopeAdmissionFailures } from './bootstrap/readiness.js';
import { restoreWorkspaceRetirementAdmission } from './bootstrap/workspace-recovery.js';
import { composeWorkspaceMcpCatalog } from './catalog/resource-catalog.js';
import {
  type ChannelServices,
  createCommunicationChannelServices,
  type DiscordAttentionTransport,
} from './channel-services.js';
import { createDiscordRestTransport } from './channels/discord-rest.js';
import { createAgentNativeEnvironmentService } from './config/agent-native-environment.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
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
import { registerDiscordInteractionRoutes } from './discord-interaction-routes.js';
import { uuidv5 } from './generative-kernel/uuid.js';
import {
  pinKnowledgeManagerExecution,
  runKnowledgeManagerAgent,
  runServerKnowledgeManagerAgent,
} from './internal-agents/knowledge-manager-agent.js';
import type { WorkerCoordinatorCandidate } from './internal-agents/worker-coordinator.js';
import { askKnowledgeAgent } from './knowledge/knowledge-agent.js';
import { prepareKnowledgeMaintenance } from './knowledge/knowledge-agent-maintenance.js';
import { runKnowledgeMaintenanceCommand } from './knowledge/knowledge-maintenance-command.js';
import { scanDailyKnowledgeMaintenance } from './knowledge/knowledge-maintenance-schedule.js';
import { checkMemoryForgetIntent } from './knowledge/memory-forget.js';
import { readWorkspaceNotebookPublicationFacts } from './knowledge/notebook-workspace-owner.js';
import { readWorkspaceNotebookSelection } from './knowledge/notebook-workspace-selection.js';
import {
  currentServerMaintenanceActor,
  prepareServerKnowledgeMaintenance,
  type ServerKnowledgeMaintenanceDependencies,
} from './knowledge/server-knowledge-maintenance.js';
import {
  runUserMemoryMaintenanceCommand,
  type UserMemoryMaintenanceDependencies,
} from './knowledge/user-memory-agent-maintenance.js';
import { scanUserMemoryMaintenance } from './knowledge/user-memory-schedule.js';
import { AutomationStore } from './lib/automation-store.js';
import { type CommandRequestRecord, FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import { registerLlmGatewayRoutes, registerWorkerInferenceRoutes } from './llm/gateway-routes.js';
import { GatewayUsageTracker } from './llm/gateway-usage.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { bindThreadTitleScheduler } from './llm/thread-title-schedule.js';
import { bindTitleGeneration, scheduleThreadTitle } from './llm/title-generation.js';
import { createLocalAiSupervisor } from './local-ai/supervisor.js';
import {
  createConversationService,
  createTaskStartOperation,
  type WorkerCoordinatorCandidateRequest,
} from './mode-entry-routes.js';
import { createAppOpenApiDocument, registerAppApiRoute } from './openapi.js';
import type {
  CommunicationCredentialBinding,
  OperationInvocationDependencies,
} from './operation-composition.js';
import { createOperationInvocation } from './operation-composition.js';
import { OperationError, projectOperationError } from './operation-error.js';
import {
  registerOperationJsonRoutes,
  registerRetainedOperationRoutes,
} from './operation-json-routes.js';
import { createAgentPolicyParticipant } from './policy/agent-gate-provider.js';
import { createGoalDomainPolicyService } from './policy/goal-domains.js';
import {
  createGoalTaskPolicyService,
  type GoalTaskPolicyService,
} from './policy/goal-task-policy.js';
import { type DeterministicPolicyParticipant, PolicyInterception } from './policy/interception.js';
import {
  checkResourcePolicyCommandIntent,
  isResourcePolicyRequest,
  isResourcePolicyRequesterCurrent,
} from './policy/resource-policy-requests.js';
import type { ProviderDiagnosticsSnapshot } from './providers/diagnostics.js';
import { resolveProviderProfileToLLMConfig } from './providers/llm-config.js';
import { isProviderProfileDispatchable } from './providers/profile-capabilities.js';
import {
  type ProviderCredentialUseContext,
  type ProviderRegistry,
  resolveEnvSecretRef,
} from './providers/registry.js';
import {
  createProviderCredentialConfigured,
  createVaultProviderCredentialResolver,
  readVaultReferenceId,
  revokeVaultProviderCredential,
} from './providers/vault-credential-resolver.js';
import { registerRemoteMcpRoutes } from './remote-mcp-routes.js';
import {
  evaluateCapturedPendingCall,
  executeCapturedPendingCall,
  prepareCapturedPendingCall,
} from './runtime/captured-pending-call.js';
import { markSchedulerAttemptForTerminalTurn } from './runtime/execution-attempts.js';
import { createGoalCoordinator, type GoalWorkerCandidate } from './runtime/goal-coordinator.js';
import { advanceGoalForThread } from './runtime/goal-native.js';
import {
  checkGoalCommandIntent,
  type GoalOwnerServices,
  goalActor,
  readGoalView,
} from './runtime/goal-owner.js';
import type {
  IdempotentCommandReceipt,
  InflightIdempotentCommand,
} from './runtime/idempotent-command.js';
import {
  createNanoHostSessionDispatch,
  type NanoHostSessionDispatch,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from './runtime/nanohost-session-dispatch.js';
import {
  assertAgentManifestSupportsModel,
  TurnStartValidationError,
} from './runtime/orchestrator.js';
import {
  admitIfIdle,
  type PendingAdmissionDependencies,
  resumeFrozenPendingDelivery,
  setPendingRequestAttentionObserver,
} from './runtime/pending-request-flow.js';
import { cancelOwnedQueuedAdmission, startProductTurn } from './runtime/product-turn-start.js';
import { PENDING_WORKER_TRIGGER_INPUT } from './runtime/scheduler-dispatch-input.js';
import { createCoordinatorTaskTool } from './runtime/task-admission.js';
import { waitForWorkerTurnTerminalState } from './runtime/task-turn-wait.js';
import {
  type ConfiguredWorkerLifecycleRuntime,
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './runtime/turn-executor-factory.js';
import type { TurnExecutor } from './runtime/types.js';
import { getWorkerBackendSession } from './runtime/worker-backend-session-records.js';
import {
  type WorkerControlFinalStatusAcceptedHook,
  WorkerControlGateway,
  WorkerControlGatewayError,
} from './runtime/worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './runtime/worker-control-rebuild.js';
import { registerWorkerControlRoutes } from './runtime/worker-control-routes.js';
import { createWorkerEnvironmentRuntimeEffects } from './runtime/worker-environment-runtime-effects.js';
import {
  createDefaultWorkerMcpGateway,
  type WorkerMcpGateway,
} from './runtime/worker-mcp-gateway.js';
import { getWorkerStorageBinding } from './runtime/worker-storage-bindings.js';
import {
  listSchedulerAdmissionEntriesForWorkspace,
  type SchedulerWorkerStorageChoice,
} from './scheduler-records.js';
import { registerServiceRoutes } from './service-routes.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { createCommunicationDiscord } from './storage/communication-discord.js';
import { requireChannelStorage } from './storage/communication-inbound.js';
import { readPendingPairingAuditInDb } from './storage/communication-pairing-native.js';
import { relayNextPairingAudit } from './storage/communication-pairing-relay.js';
import {
  CommunicationWriterCommandSchema,
  CommunicationWriterReplySchema,
} from './storage/communication-writer.js';
import { verifyOrdinaryServerGatewayAuthority } from './storage/control-store-server-work-authority.js';
import {
  type CommunicationOwnerBinding,
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { readContainmentEvidenceHandoff } from './storage/core-journal-native.js';
import { type CoreDb, openAdmittedWorkspaceReadDb, type WorkspaceDb } from './storage/db.js';
import { DEFAULT_FILE_RESERVE_BYTES } from './storage/file-reserve.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import { registerKnowledgePackageRoutes } from './storage/knowledge-package/routes.js';
import { createNanoHostCoreReads } from './storage/nanohost-core-reads.js';
import {
  inspectNanoHostRuntimeTargetTransition,
  prepareNanoHostRuntimeTargetTransition,
  readNanoHostEpochInvalidation,
  readPendingNanoHostEpochRetirement,
} from './storage/nanohost-epoch-invalidation-native.js';
import type { AdmittedNanoHostTransportStorage } from './storage/nanohost-transport-owner.js';
import { readServerCallUsageIds } from './storage/server-work-call.js';
import {
  type ServerWorkCommandBinding,
  serverWorkUnavailable,
} from './storage/server-work-command.js';
import {
  inspectServerWorkContainmentEvidence,
  publishContainmentEvidenceHandoff,
} from './storage/server-work-evidence.js';
import {
  isServerWorkPublished,
  readServerWorkIntent,
  readServerWorkLocalReceipt,
  readStagedServerWork,
} from './storage/server-work-intents.js';
import type { StorageResult, StorageUnavailable } from './storage/storage-owner.js';
import { createWorkspaceSnapshotOperationImplementations } from './storage/workspace-backup.js';
import { readFinishedDeletedWorkspaceRecovery } from './storage/workspace-recovery-journal.js';
import { registerWorkspaceTransferRoutes } from './storage/workspace-transfer-routes.js';
import { createHttpTelemetryMiddleware } from './telemetry.js';
import { registerTurnEventRoutes } from './turn-event-routes.js';
import { interruptProductTurn } from './turn-routes.js';
import { closeRevokedCredentialBindings } from './vault/vault-operation-implementations.js';
import { createVaultUnlockState, type VaultUnlockState } from './vault/vault-unlock-state.js';
import {
  createWorkerEnvironmentActivation,
  createWorkerEnvironmentAffectedStorageDeriver,
} from './worker-environments/worker-environment-activation.js';
import {
  createWorkerEnvironmentOperations,
  WorkerEnvironmentOperationError,
} from './worker-environments/worker-environment-operations.js';
import { createWorkerEnvironmentPreparation } from './worker-environments/worker-environment-preparation.js';
import {
  checkMcpDefinitionReviewIntent,
  type RegisterWorkerMcpRoutesInput,
  registerWorkerMcpRoutes,
  reviewCapturedMcpPolicy,
} from './worker-mcp-routes.js';
import {
  isTerminalWorkspaceDeletionRequest,
  listAllWorkspaceDeletionRequests,
  writeWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import { getWorkspaceRegistryLifecycleFact } from './workspace-sharing.js';

/** Main HTTP projection is built once here, not by native workers importing shared route metadata. */
const APP_OPENAPI_DOCUMENT = createAppOpenApiDocument();

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
  const allowedCors = cors({
    credentials: true,
    exposeHeaders: [
      'X-OpenKit-Content-Digest',
      'X-OpenKit-Byte-Length',
      'Retry-After',
      'X-OpenKit-Retry-Context',
    ],
    origin: (origin) => origin,
  });

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
 * @param coreDb Current canonical identity and credential owner.
 * @param actor Authenticated request actor.
 * @returns Unavailable response without Core, forbidden for non-admin actors, otherwise null.
 * @throws The original current-authority dependency error.
 */
function requireDiagnosticsAdminActor(
  coreDb: CoreDb | undefined,
  actor: AuthVariables['actor'] | undefined
): Response | null {
  if (!coreDb)
    return asApiError('Administrator authority is unavailable.', 'recovery_required', 503);
  if (actor) {
    try {
      requireAdministratorOperation(coreDb, actor, 'workspace.read');
      return null;
    } catch (error) {
      if (!(error instanceof DeploymentAdminRequiredError)) throw error;
    }
  }
  return asApiError('Server-admin authority is required.', 'diagnostics_admin_forbidden', 403);
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
 * Projects manifest-owned worker readiness into the Worker Coordinator candidate shape.
 *
 * @param store Store that owns workspace resources.
 * @param workspaceId Workspace whose agents should be projected.
 * @param agentManifests Current file-backed agent manifests.
 * @param defaultAgentId Resolved User, Workspace, or Server Agent preference.
 * @param setupDependencies Current Workspace/User composition and live Provider supply.
 * @returns Coordinator-visible worker candidates.
 */
function workerCoordinatorCandidates(
  store: FsStore,
  workspaceId: string,
  agentManifests: readonly AgentManifest[],
  defaultAgentId: string | null,
  setupDependencies: AgentSetupResolverDependencies
): WorkerCoordinatorCandidate[] {
  store.getWorkspace(workspaceId);

  return [...agentManifests]
    .sort((left, right) => {
      const defaultOrder = Number(right.id === defaultAgentId) - Number(left.id === defaultAgentId);
      return defaultOrder || compareCodeUnits(left.id, right.id);
    })
    .map((manifest) => {
      const readiness = computeReadiness(manifest);
      const resolved = resolveAgentSetup(manifest, setupDependencies);
      const launchable = isAgentLaunchable(readiness) && resolved.setup !== null;
      const reasons = [
        ...readiness.reasons,
        ...resolved.diagnostics.map((diagnostic) => diagnostic.message),
      ];

      return {
        agentId: manifest.id,
        displayName: manifest.displayName,
        readiness: launchable
          ? ('ready' as const)
          : resolved.setup !== null && readiness.status === 'unknown'
            ? ('unknown' as const)
            : ('blocked' as const),
        ...(reasons.length > 0 ? { reasons } : {}),
      };
    });
}

type NanoHostAppStorage = StorageResult<
  'nanohost',
  AdmittedNanoHostTransportStorage & {
    readonly dataRoot: string;
    readonly enrollTransport?: import('./auth/nanohost-operations.js').NanoHostAdministratorEnroll;
  }
>;

/**
 * Construction options for the Hono app.
 */
export interface CreateAppOptions {
  /** One deterministic mediation participant; production has no vendor adapter. */
  policyParticipant?: DeterministicPolicyParticipant;
  /** Optional embedded owner shared with a supplied Worker executor. */
  policyInterception?: PolicyInterception;
  /** Optional private Discord send boundary; deterministic tests supply a fake. */
  discordAttentionTransport?: DiscordAttentionTransport;
  /** Only the qualified startup composition selects this gated destination. */
  communicationStorage?: {
    readonly binding:
      | StorageResult<'communication', CommunicationOwnerBinding>
      | StorageUnavailable<'control-kernel'>;
    readonly listNanoHostTransportTokens?: NonNullable<
      CommunicationCredentialBinding['listNanoHostTransportTokens']
    >;
  };
  /** Boot joins this finite preparation callback to the existing recurring scanner. */
  onKnowledgeMaintenanceReady?: (scan: (instant: string) => Promise<void>) => void;
  /** Explicit canonical identity for an embedded fixture without Core storage; production resolves the recorded local User. */
  localUserId?: string;
  mode?: CoreMode;
  auth?: BetterAuthServer;
  coreDb?: CoreDb;
  dataRoot?: string;
  store?: FsStore;
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
  providerCredentialResolver?: (
    secretRef: string,
    context?: ProviderCredentialUseContext
  ) => string | null;
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
  /** The single acknowledged Native selection shared by boot, App and private transport. */
  nanoHostStorage?: NanoHostAppStorage;
  /** Boot admits public enrollment through the acknowledged Core and Native writers. */
  enableNanoHostEnrollment?: boolean;

  /** Optional dispatcher bound to the same process-local NanoHost session authority. */
  nanoHostSessionDispatch?: NanoHostSessionDispatch;
  /** Shared Data Root capacity owner, also used by the boot-created file dispatcher. */
  fileAdmission?: FileStorageAdmission;
  /** Shared worker lifecycle runtime that owns Harness continuations and Turn credentials. */
  workerLifecycleRuntime?: ConfiguredWorkerLifecycleRuntime;
  /**
   * Release identity read at boot.
   *
   * Omitted callers, including in-process tests, report a non-release build.
   * Production startup passes the file admitted by readReleaseIdentity.
   */
  releaseIdentity?: ReleaseBuildIdentity;
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
  _onFinalStatusCommitted?: WorkerControlFinalStatusAcceptedHook,
  nanoHostStorage?: NanoHostAppStorage
): WorkerControlGateway {
  if (!coreDb) return new WorkerControlGateway();
  const gateway = new HeldWorkerControlGateway();
  if (nanoHostStorage?.state !== 'ready') return gateway;
  const hydration = rebuildWorkerControlGatewaySessions(
    coreDb,
    gateway,
    nanoHostStorage.value.owner.read
  );
  return hydration.state === 'ready' ? gateway : new HeldWorkerControlGateway();
}

/** Native observations may hydrate before the live deciding owner is wired. */
class HeldWorkerControlGateway extends WorkerControlGateway {
  constructor() {
    super({
      resolveTokenBinding: requireWorkerControlStorage,
      resolveFinalStatusTokenBinding: requireWorkerControlStorage,
      publishHeartbeat: requireWorkerControlStorage,
      publishControlOperation: requireWorkerControlStorage,
      publishFinalStatus: requireWorkerControlStorage,
    });
  }

  override registerSession(): never {
    return requireWorkerControlStorage();
  }
}

function requireWorkerControlStorage(): never {
  throw new WorkerControlGatewayError(
    'worker_observation_storage_unavailable',
    'NanoHost Worker control storage is unavailable.',
    503
  );
}

/** Joins the acknowledged Native owner to the existing Core decision worker. */
export async function prepareNanoHostOwner(
  coreDb: CoreDb,
  gate: Parameters<ReturnType<typeof getControlStoreWorkerClient>['bindNanoHostOwner']>[2]
): Promise<NanoHostAppStorage> {
  const writer = getControlStoreWorkerClient();
  const owner = await writer.bindNanoHostOwner(
    coreDb.dataRoot,
    {
      isEnrollmentAdministrator: isCurrentDeploymentAdministrator,
      getWorkerBackendSession,
      inspectNanoHostRuntimeTargetTransition,
      listNanoHostTransportTokenRecords,
      prepareNanoHostRuntimeTargetTransition,
      readNanoHostEpochInvalidation,
      readPendingNanoHostEpochRetirement,
    },
    gate
  );
  return owner.state === 'ready'
    ? {
        state: 'ready',
        value: {
          dataRoot: resolve(coreDb.dataRoot),
          owner: owner.value,
          enrollTransport: owner.value.enrollTransport,
          kernel: writer.nanoHostEpochKernel(coreDb),
        },
      }
    : owner;
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

export { runKernelRepair } from './llm/kernel-repair-composition.js';

/** Supplies the existing native Server owner, exact Core receipts and current Gateway authority. */
export async function prepareServerWorkOwner(
  coreDb: CoreDb,
  currentRuntimeConfig: () => RuntimeConfigSnapshot
) {
  const writer = getControlStoreWorkerClient();
  const kernel = writer.serverWorkKernel(coreDb);
  const binding = await writer.bindServerWorkOwner(
    coreDb.dataRoot,
    {
      inspectServerWorkContainmentEvidence,
      publishContainmentEvidenceHandoff,
      readServerWorkIntent,
      readServerWorkLocalReceipt,
      readServerCallUsageIds,
      readStagedServerWork,
      isServerWorkPublished,
    },
    { inspectServerWork: kernel.inspectServerWork, readContainmentEvidenceHandoff }
  );
  if (binding.state === 'unavailable') return binding;

  const command: ServerWorkCommandBinding = {
    deploymentId: readDataRootLayoutMarker(coreDb.dataRoot).deploymentId,
    owner: binding.value,
    kernel,
    withProducer: async (effect) => {
      const accepted = await binding.value.withProducer(async () => {
        try {
          return { state: 'completed' as const, value: await effect() };
        } catch (error) {
          return { state: 'failed' as const, error };
        }
      });
      if (accepted.state === 'unavailable') throw serverWorkUnavailable();
      if (accepted.value.state === 'failed') throw accepted.value.error;
      return accepted.value.value;
    },
    // Ordinary Gateway Calls have no independent Budget resource in this format.
    callBudgetRef: () => null,
    verifyCallAuthority: ({ target }) => {
      const snapshot = currentRuntimeConfig();
      if (
        target.budgetRef !== null ||
        snapshot.openKitConfig.security?.pauseAgentWork ||
        !snapshot.gatewayConfig.enabled ||
        !snapshot.gatewayConfig.logicalModels.some((model) => model.id === target.routeRef)
      )
        return false;
      if (target.actor.kind === 'system' && target.actor.id === 'knowledge-manager')
        return target.credentialRef === null && target.threadId !== null && target.turnId !== null;
      return verifyOrdinaryServerGatewayAuthority(coreDb, target);
    },
  };
  return { state: 'ready' as const, value: command };
}

type PrepareCommunicationOwner = Omit<
  Parameters<ReturnType<typeof getControlStoreWorkerClient>['bindCommunicationOwner']>[0],
  'dependencies'
> & { readonly mode: CoreMode };

/** Supplies current App authority and destination codecs without making the shared worker client import its callers. */
export function prepareCommunicationOwner(input: PrepareCommunicationOwner) {
  const { coreDb, mode, kernel } = input;
  return getControlStoreWorkerClient().bindCommunicationOwner({
    coreDb,
    ...(kernel ? { kernel } : {}),
    dependencies: {
      observeAuthority: ({ userId, actor }) => {
        if (
          !isCanonicalUserActive(coreDb, userId) ||
          (mode === 'local' && getLocalUserId(coreDb) !== userId) ||
          (actor &&
            (actor.userId !== userId ||
              !isUsablePresentedCredential(coreDb, actor) ||
              evaluateOwnedUserOperation(coreDb, actor, userId, 'api.call', true).effect !==
                'allow'))
        )
          throw new OperationError(
            'channel_authority_unavailable',
            'Current authority unavailable.',
            403
          );
        const administratorAtEvent =
          actor && isDeploymentAdminActor(actor)
            ? evaluateProductAuthorization(coreDb, actor, { kind: 'server' }, 'api.call', true)
                .effect === 'allow'
            : isCurrentServerPolicyAuthor(coreDb, userId);
        return { userId, administratorAtEvent };
      },
      createCommunicationDiscord,
      readPendingPairingAuditInDb,
      relayNextPairingAudit,
      CommunicationWriterCommandSchema,
      CommunicationWriterReplySchema,
    },
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
  const storeDataRoot = sharedStore.getDataRoot();
  const mutationDataRoot = dataRoot ?? options.coreDb?.dataRoot ?? storeDataRoot;
  // Every rooted Workspace writer, including the fallback Store, resolves its native scope from its
  // physical Root; one App shares one Root.
  if (
    mutationDataRoot &&
    [options.coreDb?.dataRoot, storeDataRoot].some(
      (root) => root && resolve(root) !== resolve(mutationDataRoot)
    )
  )
    throw new Error('Application Workspace mutations must use their native scope owner.');
  if (
    options.nanoHostStorage?.state === 'ready' &&
    (!mutationDataRoot || resolve(mutationDataRoot) !== options.nanoHostStorage.value.dataRoot)
  )
    throw new Error('NanoHost App reads must use the application Data Root.');
  const missingNanoHostStorage = {
    state: 'unavailable',
    owner: 'nanohost',
    reason: 'missing',
  } as const;
  const nanoHostStorage = options.nanoHostStorage ?? missingNanoHostStorage;
  const readNanoHostEnvironment: AdmittedNanoHostTransportStorage['owner']['read'] =
    nanoHostStorage.state === 'ready' ? nanoHostStorage.value.owner.read : () => nanoHostStorage;
  if (options.automationStore && options.automationStore.coreDb !== options.coreDb)
    throw new Error(
      'Recurring schedules require the application Core database and Workspace mutation fence.'
    );
  if (dataRoot) {
    createLocalAiSupervisor({ dataRoot });
    restoreWorkspaceDeletionMutationAdmission({
      dataRoot,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    });
  }
  let localUserId: string | undefined;
  if (mode === 'local') {
    localUserId = options.coreDb ? getLocalUserId(options.coreDb) : options.localUserId;
    if (
      !isEntityId('usr', localUserId) ||
      (options.coreDb && options.localUserId !== undefined && options.localUserId !== localUserId)
    ) {
      throw new Error('App construction requires the unique canonical local User authority.');
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
  const providerCredentialResolverFallback: NonNullable<
    CreateAppOptions['providerCredentialResolver']
  > = (secretRef, context) =>
    options.providerCredentialResolver?.(secretRef, context) ?? resolveEnvSecretRef(secretRef);
  const providerCredentialConfigured = createProviderCredentialConfigured({
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    // Managed Vault presence comes only from metadata; an injected resolver may release material.
    fallback: (secretRef) =>
      secretRef.startsWith('vault://') ? null : providerCredentialResolverFallback(secretRef),
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
    ? async (secret: string, request: Request) => {
        const pathname = new URL(request.url).pathname;
        const token = await verifyOpenKitAccessTokenRecord(options.coreDb!, secret, {
          ...(options.runtimeConfigManager
            ? { runtimeConfigManager: options.runtimeConfigManager }
            : {}),
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
    ...(localUserId === undefined ? {} : { localUserId }),
    ...(accessTokenVerifier ? { accessTokenVerifier } : {}),
    ...(options.coreDb
      ? {
          coreDb: options.coreDb,
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
  const providerSubscriptionAccountManager: ProviderSubscriptionAccountManager | null =
    options.providerSubscriptionAccountManager ??
    (options.coreDb && vaultUnlockState
      ? new ProviderSubscriptionAccountManager({
          coreDb: options.coreDb,
          vaultBackend: () => vaultUnlockState.backend(),
          onReferenceRevoked: (referenceId): Promise<void> =>
            closeRevokedCredentialBindings(
              {
                coreDb: options.coreDb,
                store: sharedStore,
                turnExecutor,
                closeMcpCredentialGrants,
              },
              { referenceId }
            ),
        })
      : null);
  const setupProviderSupply = {
    providerCredentialConfigured,
    // A marker is not readiness: advertise only the actually installed private lifecycle.
    supportedRequiredFeatures: options.nanoHostSessionDispatch?.supportsHarnessLogin?.()
      ? ['worker.harness-login.v1']
      : [],
    ...(providerSubscriptionAccountManager
      ? { subscriptionAccounts: providerSubscriptionAccountManager }
      : {}),
  };
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
      ...setupProviderSupply,
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
  if (sharedStore.getDataRoot() && runtimeConfigManager.getDataRoot())
    sharedStore.setWorkspaceConfigurationPublisher(async (workspaceId, name) => {
      if (options.coreDb) await runtimeConfigManager.bindNativePolicyPublication(options.coreDb);
      await runtimeConfigManager.publishWorkspaceConfiguration(workspaceId, name);
    });
  sharedStore.setWorkspaceCaptureCoverageProjection(
    (workspaceId) =>
      runtimeConfigManager
        .current()
        .workspaceConfigs.find((entry) => entry.workspaceId === workspaceId)?.config
  );
  sharedStore.setWorkspaceResourcePolicyProjection((workspaceId) => {
    const loaded = runtimeConfigManager
      .current()
      .workspaceConfigs.find((entry) => entry.workspaceId === workspaceId);
    if (!loaded) return null;
    const policy = loaded.config.workspace.policy?.mediation ?? {
      schemaVersion: 1 as const,
      statements: [],
    };
    if (!policy.statements.length) return policy;
    if (!options.coreDb) throw new Error('Current Workspace Policy authority is unavailable.');
    return readCurrentWorkspacePolicy({ coreDb: options.coreDb, workspaceId, policy });
  });
  const automationStore =
    options.automationStore ?? (options.coreDb ? new AutomationStore(options.coreDb) : undefined);
  const workerControlGateway =
    options.workerControlGateway ??
    createDefaultWorkerControlGateway(options.coreDb, undefined, nanoHostStorage);
  const workerMcpGateway =
    options.workerMcpGateway ?? createDefaultWorkerMcpGateway(options.coreDb);
  /** Joins the unique Gateway owner without treating missing cleanup as success. */
  const closeMcpCredentialGrants = async (grantIds: readonly string[]): Promise<void> => {
    if (!workerMcpGateway.closeCredentialGrants)
      throw new Error('MCP credential cleanup is unavailable.');
    await workerMcpGateway.closeCredentialGrants(grantIds);
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  // Default-on for ordinary Fetch responses and native transport responses sent directly.
  app.use(async (c, next) => {
    const policy = "script-src 'self'; object-src 'none'; base-uri 'self'";
    const outgoing = (c.env as Partial<HttpBindings> | undefined)?.outgoing;
    outgoing?.setHeader?.('Content-Security-Policy', policy);
    await next();
    // Finalized header mutation clones the response; preserve the adapter's already-sent sentinel.
    if (c.res !== RESPONSE_ALREADY_SENT) c.header('Content-Security-Policy', policy);
  });
  app.use(createHttpTelemetryMiddleware());
  const nanohostTransportSessionAuthority =
    options.nanohostTransportSessionAuthority ?? createNanoHostTransportSessionAuthority();
  const nanoHostRestartRequired = runtimeConfigManager.bindNanoHostTransportFence(async () => {
    const identityId = startupOpenKitConfig.nanohost?.identityId;
    if (!identityId) return;
    if (nanoHostStorage.state === 'ready')
      await fenceNanoHostTransportAuthority(
        nanoHostStorage.value,
        nanohostTransportSessionAuthority,
        identityId,
        new Date().toISOString()
      );
    else nanohostTransportSessionAuthority.fenceAuthoritative(identityId);
  });
  const admitNanoHostSession = nanohostTransportSessionAuthority.admit.bind(
    nanohostTransportSessionAuthority
  );
  nanohostTransportSessionAuthority.admit = (input) =>
    nanoHostRestartRequired()
      ? {
          connectionGeneration: input.connectionGeneration,
          identityId: input.identityId,
          role: 'rejected',
        }
      : admitNanoHostSession(input);
  /** Retires only the superseded local entry generation. Active calls use the existing idle cleanup. */
  async function retireWorkspaceMcpSessions(
    previous: RuntimeConfigSnapshot,
    active: RuntimeConfigSnapshot
  ): Promise<void> {
    const activeCatalogs = new Map(
      active.workspaceMcpServerCatalogs.map(({ workspaceId, catalog }) => [workspaceId, catalog])
    );
    for (const { workspaceId, catalog } of previous.workspaceMcpServerCatalogs) {
      const activeServers = new Map(
        activeCatalogs.get(workspaceId)?.servers.map((server) => [server.id, server])
      );
      for (const server of catalog.servers) {
        if (!server.enabled) continue;
        const replacement = activeServers.get(server.id);
        if (replacement && canonicalJsonText(replacement) === canonicalJsonText(server)) continue;
        const superseded = resolveWorkspaceMcpServer({ catalog, serverId: server.id });
        void workerMcpGateway
          .closeServerIfIdle({ workspaceId, server: superseded }, { exactCatalog: true })
          .catch(() =>
            console.warn('Superseded Workspace MCP session cleanup requires inspection.')
          );
      }
    }
  }
  runtimeConfigManager.bindWorkspaceMcpCatalogChange((previous, active) => {
    void retireWorkspaceMcpSessions(previous, active).catch(() =>
      console.warn('Superseded Workspace MCP session cleanup requires inspection.')
    );
  });

  let resumeAgentWork: (() => Promise<void>) | undefined;
  const reloadRuntimeConfig = runtimeConfigManager.reload.bind(runtimeConfigManager);
  runtimeConfigManager.reload = async (input) => {
    const wasPaused = runtimeConfig().openKitConfig.security?.pauseAgentWork === true;
    const pending = reloadRuntimeConfig(input);
    const response = pending instanceof Promise ? await pending : pending;
    if (!input.dryRun && wasPaused && !runtimeConfig().openKitConfig.security?.pauseAgentWork)
      await resumeAgentWork?.();
    return response;
  };
  // An inferred physical root supplies file reserve policy without loading unrelated runtime settings.
  const inferredFileReserveBytes =
    mutationDataRoot &&
    !dataRoot &&
    !options.runtimeConfigManager &&
    options.openKitConfig === undefined
      ? loadOpenKitConfig(mutationDataRoot).server?.fileReserveBytes
      : undefined;
  const fileAdmission =
    options.fileAdmission ??
    new FileStorageAdmission(mutationDataRoot ?? '.', () =>
      BigInt(
        runtimeConfig().openKitConfig.server?.fileReserveBytes ??
          inferredFileReserveBytes ??
          DEFAULT_FILE_RESERVE_BYTES
      )
    );
  if (mutationDataRoot)
    getControlStoreWorkerClient().setFileStorageAdmission(mutationDataRoot, fileAdmission);
  const nanoHostSessionDispatch =
    options.nanoHostSessionDispatch ??
    createNanoHostSessionDispatch({
      fileAdmission,
      nativeStorage: nanoHostStorage,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      sessionAuthority: nanohostTransportSessionAuthority,
    });
  const releaseIdentity = options.releaseIdentity ?? {
    releaseTag: null,
    sourceCommit: null,
  };
  const workerEnvironmentRuntimeEffects = createWorkerEnvironmentRuntimeEffects(
    nanoHostSessionDispatch,
    releaseIdentity
  );
  const workerEnvironmentOperations = options.coreDb
    ? createWorkerEnvironmentOperations({
        coreDb: options.coreDb,
        readNanoHost: readNanoHostEnvironment,
        inflightCommands,
        runtimeEffects: workerEnvironmentRuntimeEffects,
        store: sharedStore,
      })
    : null;
  const workerEnvironmentPreparation = options.coreDb
    ? createWorkerEnvironmentPreparation({
        coreDb: options.coreDb,
        readPolicy: () => runtimeConfigManager.current().openKitConfig.policy?.mediation,
        store: sharedStore,
        inflightCommands,
        runtimeEffects: workerEnvironmentRuntimeEffects,
        configFilesForActor: (actor) => runtimeConfigFileService({ get: () => actor }),
        privateWorkspaceIdForUser: (userId) =>
          quickChatWorkspaceIdForUser(userId, options.coreDb!.dataRoot),
        requireCurrentAdministrator: (actor) => {
          requireAdministratorOperation(options.coreDb!, actor, 'workspace.configure');
        },
        authorizePrivateHome: ({ actor, workspaceId, threadId, turnId }) => {
          if (workspaceId !== quickChatWorkspaceIdForUser(actor.userId, options.coreDb!.dataRoot))
            return false;
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
          readNanoHost: readNanoHostEnvironment,
          store: sharedStore,
        }),
      })
    : null;
  const workerEnvironmentActivation =
    options.coreDb && workerEnvironmentPreparation
      ? createWorkerEnvironmentActivation({
          coreDb: options.coreDb,
          readNanoHost: readNanoHostEnvironment,
          store: sharedStore,
          preparation: workerEnvironmentPreparation,
          runtimeEffects: workerEnvironmentRuntimeEffects,
          inflightCommands,
          configFilesForActor: (actor) => runtimeConfigFileService({ get: () => actor }),
          requireCurrentAdministrator: (actor) => {
            requireAdministratorOperation(options.coreDb!, actor, 'workspace.configure');
          },
          reloadRuntimeConfig: () => runtimeConfigManager.reload({ dryRun: false, mode: 'safe' }),
          replaceResidentWork: async (input) => {
            const { actor, replaceNow, affectedStorage, residentMembers, requestId, target } =
              input;
            const coreDb = options.coreDb!;
            const readResidentBinding = (storageRef: string) => {
              const read =
                nanoHostStorage.state === 'ready'
                  ? nanoHostStorage.value.owner.read((sqlite) =>
                      getWorkerStorageBinding({ sqlite }, { storageRef })
                    )
                  : nanoHostStorage;
              if (read.state !== 'ready')
                throw new WorkerEnvironmentOperationError(
                  'recovery_required',
                  'NanoHost resident storage requires recovery.'
                );
              return read.value;
            };
            const requireAuthority = () => {
              workerEnvironmentPreparation.readResolved({ actor }, input.resolvedCandidate);
              for (const ref of affectedStorage) {
                const binding = readResidentBinding(ref.storageRef);
                if (
                  !binding ||
                  !binding.contributors.every(
                    (contributor) =>
                      contributor.workspaceId === replaceNow.workspaceId &&
                      contributor.responsibleUserId === actor.userId &&
                      workspaceIdForOwner(
                        sharedStore.getThread(contributor.workspaceId, contributor.threadId).owner
                      ) === replaceNow.workspaceId
                  )
                )
                  throw new Error('Worker source audience changed.');
              }
              requireAdministratorOperation(coreDb, actor, 'workspace.configure');
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
            const before = readResidentBinding(expected.storageRef);
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
              await markSchedulerAttemptForTerminalTurn(coreDb, terminal);
            }
            requireAuthority();
            const released = readResidentBinding(before.storageRef);
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
                triggerSource: {
                  kind: 'user-input',
                  summary: 'Worker environment activation input.',
                },
                reservedTurnId: deriveEntityId('tu', {
                  command: 'worker_environment.activate',
                  actorId: actor.userId,
                  workspaceId: replaceNow.workspaceId,
                  threadId: replaceNow.threadId,
                  requestId,
                }),
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
            const after = readResidentBinding(before.storageRef);
            const image = workerEnvironmentPreparation.readResolved(
              { actor },
              input.resolvedCandidate
            ).resolved.image;
            const sandboxBindingRef = after?.currentSandboxBindingRef;
            const sandbox =
              sandboxBindingRef && nanoHostStorage.state === 'ready'
                ? nanoHostStorage.value.owner.read(
                    (sqlite) =>
                      sqlite
                        .prepare(
                          'SELECT image_digest AS imageDigest, health_state AS health, cleanup_state AS cleanup FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?'
                        )
                        .get(sandboxBindingRef) as
                        | { imageDigest: string; health: string; cleanup: string }
                        | undefined
                  )
                : undefined;
            if (sandbox?.state === 'unavailable')
              throw new WorkerEnvironmentOperationError(
                'recovery_required',
                'NanoHost replacement evidence requires recovery.'
              );
            const placement = sandbox?.value;
            const disposition =
              after?.state === 'attached' &&
              after.attachmentGeneration > before.attachmentGeneration &&
              placement?.imageDigest === image.digest &&
              placement.health === 'ready' &&
              placement.cleanup === 'clean'
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
  let policyInterception: PolicyInterception;
  const configuredWorkerRuntime =
    options.workerLifecycleRuntime ??
    (options.turnExecutor || process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1'
      ? null
      : createConfiguredWorkerLifecycleRuntime({
          fileAdmission,
          readRuntimeConfig: () => runtimeConfigManager.current(),
          policyInterception: () => policyInterception,
          goalTaskPolicy,
          releaseIdentity,
          coreDb: options.coreDb,
          ...(vaultUnlockState ? { vaultBackend: () => vaultUnlockState.backend() } : {}),
          nanoHostSessionDispatch,
          nanoHostRecovery: {
            owner:
              nanoHostStorage.state === 'ready'
                ? { state: 'ready', value: nanoHostStorage.value.owner }
                : nanoHostStorage,
          },
          workerControlGateway,
        }));
  const turnExecutor =
    options.turnExecutor ??
    configuredWorkerRuntime?.turnExecutor ??
    createConfiguredTurnExecutor({
      releaseIdentity,
      fileAdmission,
      coreDb: options.coreDb,
      workerControlGateway,
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

  /** Opens the actual caller's User evidence home; native commands own writes. */
  function repositoryUserDb(userId: string) {
    return getControlStoreWorkerClient().openInitializedUserReadDb(
      repositoryCoreDb().dataRoot,
      userId
    );
  }

  /**
   * Opens the workspace-owned repository database for one request.
   *
   * @param workspaceId Workspace id that owns repository resources.
   * @returns Owned readonly handle for the already-admitted Workspace.
   */
  function repositoryWorkspaceDb(workspaceId: string): WorkspaceDb {
    const coreDb = repositoryCoreDb();
    return openAdmittedWorkspaceReadDb(coreDb.dataRoot, workspaceId);
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
   * @param request Initiating User and explicit Agent/model selection.
   * @returns Deterministically ordered opaque worker candidates.
   */
  function currentWorkerCoordinatorCandidates(
    store: FsStore,
    workspaceId: string,
    request: WorkerCoordinatorCandidateRequest
  ): WorkerCoordinatorCandidate[] {
    const snapshot = runtimeConfig();
    const { userId, agentId, modelId } = request;
    const manifests = snapshot.agentManifests.filter(
      (manifest) => agentId === undefined || manifest.id === agentId
    );
    // Keep the existing typed model-override refusal before the setup eligibility gate.
    const selected = agentId === undefined ? undefined : manifests[0];
    if (selected && isAgentLaunchable(computeReadiness(selected))) {
      assertAgentManifestSupportsModel(selected, modelId);
    }
    const workspaceConfig = snapshot.workspaceConfigs.find(
      (entry) => entry.workspaceId === workspaceId
    )?.config;
    const userConfig = snapshot.userConfigs.find((entry) => entry.userId === userId)?.config;
    return workerCoordinatorCandidates(
      store,
      workspaceId,
      manifests,
      resolveDefaultAgentId(snapshot, workspaceId, userId),
      {
        ...setupProviderSupply,
        ...(modelId === undefined ? {} : { requestedLogicalModelId: modelId }),
        gatewayConfig: snapshot.gatewayConfig,
        providerRegistry: snapshot.providerRegistry,
        workspaceId,
        ...(workspaceConfig ? { workspaceConfig } : {}),
        ...(userConfig ? { userConfig } : {}),
      }
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
    /** Original initiating command facts for native Turn admission. */
    readonly commandReceipt?: IdempotentCommandReceipt;
    /** Exact selected Worker conversation response, including its original routing metadata. */
    readonly commandReceiptResponse?: CommandRequestRecord['response'];
    /** Conversation checked the Agent before publishing the origin or pending Worker Turn. */
    readonly agentReadinessCheckedBeforePublication?: true;
    readonly triggerActor: ActorRef;
    /** Native initiating cause supplied by the Turn-creating owner. */
    readonly triggerSource?: z.infer<typeof TurnSchema>['triggerSource'];
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
    readonly fileInputs?: z.infer<typeof TurnSchema>['fileInputs'];
    readonly filePayloadPaths?: readonly string[];
    /** Shared runtime disk owner; never persisted or projected. */
    readonly fileWriteAdmission?: FileStorageAdmission;
    /** Synchronous live file-input admission immediately before publication. */
    readonly assertFileInputAdmission?: () => void;
    readonly onTurnCreated?: (
      turn: z.infer<typeof TurnSchema>,
      agentSessionId: string | null
    ) => void | Promise<void>;
  }): Promise<z.infer<typeof TurnSchema>> {
    const snapshot = runtimeConfig();
    const handle = await startProductTurn({
      agentReadinessCheckedBeforePublication: input.agentReadinessCheckedBeforePublication,
      agentWorkPaused: () => runtimeConfig().openKitConfig.security?.pauseAgentWork === true,
      ...setupProviderSupply,
      ...(input.commandReceipt ? { commandReceipt: input.commandReceipt } : {}),
      ...(input.commandReceiptResponse
        ? { commandReceiptResponse: input.commandReceiptResponse }
        : {}),
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
      ...(input.fileInputs?.length
        ? {
            fileInputs: input.fileInputs,
            filePayloadPaths: input.filePayloadPaths,
            fileWriteAdmission: input.fileWriteAdmission,
            assertFileInputAdmission: input.assertFileInputAdmission,
          }
        : {}),
      ...(input.requestActor ? { requestActor: input.requestActor } : {}),
      snapshot,
      store: input.store,
      triggerActor: input.triggerActor,
      ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
      turnExecutor,
      workerPlacement,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      ...(input.onTurnCreated ? { onTurnCreated: input.onTurnCreated } : {}),
    });

    await markSchedulerAttemptForTerminalTurn(options.coreDb, handle.turn);
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
    const actor = c.get('actor');
    if (!actor) throw new Error('Runtime configuration requires an authenticated canonical User.');
    return new RuntimeConfigFileService({
      ...(options.coreDb
        ? {
            coreDb: options.coreDb,
            onServerConfigUpdate: async (event) => {
              await getControlStoreWorkerClient().standaloneAudit(options.coreDb!, {
                stage: 'server.config.update',
                event,
              });
            },
          }
        : {}),
      actor: { kind: 'user', id: actor.userId },
      dataRoot,
      userId: actor.userId,
      workspaceIds: store.listWorkspaces().map((workspace) => workspace.id),
      runtimeConfigManager,
      readRuntimeConfigStatus: () => runtimeConfigManager.status(),
      revokeProviderSecret: async (secretRef) => {
        if (!options.coreDb || !vaultUnlockState) {
          throw new RuntimeConfigFileServiceError(
            'vault_storage_unavailable',
            'Vault storage is unavailable.',
            503
          );
        }
        const failures: unknown[] = [];
        let revoked = false;
        try {
          await revokeVaultProviderCredential(
            { coreDb: options.coreDb, vaultBackend: () => vaultUnlockState.backend() },
            secretRef
          );
          revoked = true;
        } catch (error) {
          failures.push(error);
        }
        const referenceId = readVaultReferenceId(secretRef);
        if (revoked && referenceId) {
          try {
            await closeRevokedCredentialBindings(
              { coreDb: options.coreDb, store, turnExecutor, closeMcpCredentialGrants },
              { referenceId }
            );
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw failures.length === 1 ? failures[0] : new AggregateError(failures);
      },
      ...(options.coreDb
        ? {
            onCredentialBindingChange: async (change) => {
              const workspaceDb = repositoryWorkspaceDb(change.workspaceId);
              try {
                await getControlStoreWorkerClient().standaloneAudit(workspaceDb, {
                  workspaceId: change.workspaceId,
                  stage: 'workspace.credential-binding.update',
                  event: prepareWorkspaceAuditEvent({
                    workspaceDb,
                    workspaceId: change.workspaceId,
                    category: 'system',
                    action: 'workspace.credential-binding.update',
                    actor: { kind: 'user', id: actor.userId },
                    authentication: auditAuthenticationFromActor(actor),
                    agentId: change.agentId,
                    vaultGrantId: change.nextGrantId,
                    resource: `workspace-credential-binding:${change.agentId}:${change.requirementId}`,
                    outcome: 'succeeded',
                    severity: 'info',
                    // This actor-bound service is reached after Kernel administrator admission.
                    summary: `Preferred credential binding ${change.requirementId} changed from ${change.previousGrantId ?? 'none'} to ${change.nextGrantId ?? 'none'}; Kernel authorization allowed.`,
                  }),
                });
              } finally {
                workspaceDb.sqlite.close();
              }
            },
            onDataSourceAuthorityChange: async (change) => {
              const workspaceDb = repositoryWorkspaceDb(change.workspaceId);
              try {
                await getControlStoreWorkerClient().standaloneAudit(workspaceDb, {
                  workspaceId: change.workspaceId,
                  stage: 'data_source_catalog.authority.update',
                  event: prepareWorkspaceAuditEvent({
                    workspaceDb,
                    workspaceId: change.workspaceId,
                    category: 'system',
                    action: 'data_source_catalog.authority.update',
                    actor: { kind: 'user', id: actor.userId },
                    authentication: auditAuthenticationFromActor(actor),
                    resource: `data-source-catalog:${change.sourceId}`,
                    outcome: 'succeeded',
                    severity: 'info',
                    summary: `Workspace data source catalog authority changed for ${change.sourceId}: ${change.fields.join(', ')}.`,
                  }),
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
   * @param context Current credential-use attribution.
   * @param registry Exact installed registry captured by this Gateway call.
   * @returns Secret-bearing provider config.
   * @throws OpenAICompatibleProviderError when the provider or model cannot be dispatched.
   */
  function resolveGatewayProvider(
    providerId: string,
    model: string,
    context: ProviderCredentialUseContext | undefined,
    registry: ProviderRegistry
  ) {
    const profile = registry.get(providerId);

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

    return resolveProviderProfileToLLMConfig(
      profile,
      (secretRef) => providerCredentialResolver(secretRef, context),
      model
    );
  }

  const knowledgeDependencies = {
    store: sharedStore,
    runtimeConfig,
    dispatcher: llmGatewayDispatcher,
    resolveGatewayProvider,
    openWorkspace: repositoryWorkspaceDb,
    providerCredentialConfigured,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
  };
  const serverKnowledgeMaintenance: ServerKnowledgeMaintenanceDependencies | undefined =
    options.coreDb
      ? {
          store: sharedStore,
          coreDb: options.coreDb,
          runtimeConfigManager,
          inflightCommands,
          pin: async (run) => {
            await pinKnowledgeManagerExecution(knowledgeDependencies, run);
          },
          run: (run) => runServerKnowledgeManagerAgent(knowledgeDependencies, run),
        }
      : undefined;
  const userMemoryDependencies = (
    userDb: import('./storage/db.js').UserDb
  ): UserMemoryMaintenanceDependencies => {
    if (!options.coreDb) throw new Error('Memory storage is unavailable.');
    return {
      store: sharedStore,
      coreDb: options.coreDb,
      userDb,
      runtimeConfigManager,
      openWorkspace: repositoryWorkspaceDb,
      inflightCommands,
      pin: async (run) => {
        await pinKnowledgeManagerExecution(knowledgeDependencies, run);
      },
      run: (run) => runKnowledgeManagerAgent(knowledgeDependencies, run),
    };
  };
  const knowledgeAgent: NonNullable<OperationInvocationDependencies['knowledgeAgent']> = {
    ask: (input) => askKnowledgeAgent(knowledgeDependencies, input),
    maintainMemory: (input, userDb) =>
      runUserMemoryMaintenanceCommand(userMemoryDependencies(userDb), input),
    maintain: (input) => {
      if (!options.coreDb) throw new Error('Knowledge Manager storage is unavailable.');
      return runKnowledgeMaintenanceCommand(
        {
          store: sharedStore,
          coreDb: options.coreDb,
          runtimeConfigManager,
          openWorkspace: repositoryWorkspaceDb,
          inflightCommands,
          pin: async (run) => {
            await pinKnowledgeManagerExecution(knowledgeDependencies, run);
          },
          run: (run) => runKnowledgeManagerAgent(knowledgeDependencies, run),
        },
        input
      );
    },
  };
  options.onKnowledgeMaintenanceReady?.(async (instant) => {
    const coreDb = options.coreDb;
    if (!coreDb) return;
    await scanUserMemoryMaintenance({
      now: instant,
      store: sharedStore,
      coreDb,
      runtimeConfigManager,
      ...(localUserId ? { localUserId } : {}),
      dependencies: userMemoryDependencies,
    });
    await scanDailyKnowledgeMaintenance({
      now: instant,
      scopes: runtimeConfig().workspaceConfigs.map(({ workspaceId, config }) => ({
        ownerScope: { kind: 'workspace' as const, workspaceId },
        schedule: config.workspace.knowledgeMaintenance?.schedule,
      })),
      listTurns: ({ ownerScope }) =>
        sharedStore
          .listThreads(ownerScope.workspaceId)
          .flatMap((thread) => sharedStore.listThreadTurns(ownerScope.workspaceId, thread.id))
          .filter((turn) => turn.startedAt !== null)
          .map((turn) => ({
            startedAt: turn.startedAt!,
            ...(turn.internalExecution?.knowledge
              ? {
                  internalExecution: {
                    roleId: turn.internalExecution.roleId,
                    knowledge: {
                      purpose: turn.internalExecution.knowledge.purpose,
                      ownerScope: turn.internalExecution.knowledge.ownerScope,
                      trigger: turn.internalExecution.knowledge.trigger,
                    },
                  },
                }
              : turn.agentId === 'knowledge-manager' &&
                  turn.triggerSource?.kind === 'automation' &&
                  turn.triggerSource.summary === 'Knowledge Manager scheduled maintenance.'
                ? {
                    internalExecution: {
                      roleId: 'knowledge-manager',
                      knowledge: {
                        purpose: 'maintenance' as const,
                        ownerScope,
                        trigger: 'schedule' as const,
                      },
                    },
                  }
                : {}),
          })),
      prepare: async ({ ownerScope }, startedAt) => {
        const workspaceId = ownerScope.workspaceId;
        const owner = getWorkspaceRegistryLifecycleFact(coreDb, workspaceId)?.ownerUserId;
        if (!owner) throw new Error('Knowledge maintenance Workspace owner is unavailable.');
        const actor = {
          kind: 'system' as const,
          id: 'knowledge-manager',
          responsibleUserId: owner,
        };
        const currentAuthority = () => {
          if (!currentWorkspaceAuthority(coreDb, workspaceId, actor, 'knowledge.write', true))
            throw new Error('Knowledge maintenance scope authority is unavailable.');
        };
        try {
          const prepared = await prepareKnowledgeMaintenance(
            {
              store: sharedStore,
              coreDb,
              runtimeConfigManager,
              openWorkspace: repositoryWorkspaceDb,
              inflightCommands,
              pin: async (run) => {
                await pinKnowledgeManagerExecution(knowledgeDependencies, run);
              },
              run: (run) => runKnowledgeManagerAgent(knowledgeDependencies, run),
            },
            {
              workspaceId,
              requestId: uuidv5(
                JSON.stringify(['knowledge.maintain', ownerScope, startedAt.slice(0, 10)])
              ),
              actor,
              startedAt,
              trigger: 'schedule',
              instructions:
                'Consolidate admitted recent information, preserve human edits and keep the notebook overview current.',
              sources: [],
              signal: new AbortController().signal,
              currentAdmission: (request, preparedSelection) => {
                const db = repositoryWorkspaceDb(workspaceId);
                try {
                  const selection = readWorkspaceNotebookSelection({
                    preparedSelection,
                    requirePreparedMatch: preparedSelection !== undefined,
                    workspaceDb: db,
                    workspaceRoot: join(coreDb.dataRoot, 'workspaces', workspaceId),
                    knowledgeBaseId: readDefaultKnowledgeBaseId({
                      dataRoot: coreDb.dataRoot,
                      scope: { kind: 'workspace', workspaceId },
                    }),
                  });
                  return readWorkspaceNotebookPublicationFacts({
                    store: sharedStore,
                    coreDb,
                    workspaceDb: db,
                    request,
                    actor: { kind: 'user', id: owner },
                    currentAuthority,
                    runtimeConfigManager,
                    notebook: selection.notebook,
                    preparedSelection: preparedSelection ? selection : undefined,
                    scopeSchemaText: selection.scopeSchemaText,
                  });
                } finally {
                  db.sqlite.close();
                }
              },
            }
          );
          return {
            execute: async () => {
              await prepared.execute();
            },
            fail: async () => {
              await prepared.fail();
            },
          };
        } catch {
          const previous = sharedStore
            .listThreads(workspaceId)
            .find((thread) =>
              sharedStore
                .listThreadTurns(workspaceId, thread.id)
                .some(
                  (turn) =>
                    turn.agentId === 'knowledge-manager' &&
                    turn.triggerSource?.summary === 'Knowledge Manager scheduled maintenance.'
                )
            );
          const thread =
            previous ??
            (await sharedStore.createThread(
              workspaceId,
              'Knowledge maintenance',
              undefined,
              'knowledge-manager',
              { visibility: 'workspace' }
            ));
          const completedAt = new Date().toISOString();
          const turn = await sharedStore.createTurn(
            workspaceId,
            thread.id,
            'Scheduled Knowledge maintenance was skipped.',
            actor,
            null,
            {
              agentId: 'knowledge-manager',
              executorKind: 'assistant',
              startedAt,
              triggerSource: {
                kind: 'automation',
                summary: 'Knowledge Manager scheduled maintenance.',
              },
            }
          );
          const resultItem: Item = {
            id: allocateEntityId('it'),
            owner: { kind: 'workspace', workspaceId: workspaceId },
            threadId: thread.id,
            turnId: turn.id,
            type: 'status',
            status: 'failed',
            level: 'error',
            title: 'Knowledge maintenance skipped',
            summary:
              'Scope, notebook or model admission was unavailable. Start a new explicit run after inspection.',
            createdAt: completedAt,
            completedAt,
          };
          await sharedStore.completeTurn(
            turn.id,
            {
              status: 'failed',
              completedAt,
              error: {
                code: 'knowledge_maintenance_unavailable',
                message: 'Scheduled maintenance could not be admitted.',
              },
            },
            { items: [resultItem] }
          );
          return null;
        }
      },
      onError: () => console.warn('Knowledge maintenance requires inspection.'),
    });
    if (serverKnowledgeMaintenance)
      await scanDailyKnowledgeMaintenance({
        now: instant,
        scopes: [
          {
            ownerScope: { kind: 'server' as const },
            schedule: runtimeConfig().openKitConfig.knowledgeMaintenance?.schedule,
          },
        ],
        listTurns: () =>
          sharedStore
            .listServerThreads()
            .flatMap((thread) => sharedStore.listServerThreadTurns(thread.id))
            .filter((turn) => turn.startedAt !== null)
            .map((turn) => ({
              startedAt: turn.startedAt!,
              internalExecution: {
                roleId: turn.agentId ?? '',
                knowledge: turn.internalExecution?.knowledge ?? {
                  purpose: 'maintenance' as const,
                  ownerScope: { kind: 'server' as const },
                  trigger:
                    turn.triggerSource?.kind === 'automation'
                      ? ('schedule' as const)
                      : ('request' as const),
                },
              },
            })),
        prepare: async (_scope, startedAt) => {
          const requestActor = currentServerMaintenanceActor(
            coreDb,
            mode === 'local' ? localUserId : undefined
          );
          const prepared = await prepareServerKnowledgeMaintenance(serverKnowledgeMaintenance, {
            requestId: uuidv5(
              JSON.stringify(['knowledge.server.maintain', startedAt.slice(0, 10)])
            ),
            ...(requestActor ? { requestActor } : {}),
            actor: {
              kind: 'system',
              id: 'knowledge-manager',
              responsibleUserId: requestActor?.userId ?? null,
            },
            startedAt,
            trigger: 'schedule',
            instructions:
              'Organize explicit Server inputs and human notebook edits, preserve them, and keep the overview current. Do not learn from Workspace or User Threads.',
            sources: [],
            signal: new AbortController().signal,
          });
          return {
            execute: async () => {
              await prepared.execute();
            },
            fail: async () => {
              await prepared.fail();
            },
          };
        },
        onError: () => console.warn('Server Knowledge maintenance requires inspection.'),
      });
  });

  app.use('/api/worker-control/credential-helper', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/api/worker-control/*', browserCors);
  registerWorkerControlRoutes({
    app,
    coreDb: options.coreDb,
    exposureAvailable: operationExposureAvailable,
    workerControlGateway,
    ...(configuredWorkerRuntime?.registerCredentialHelperComparisonValues
      ? {
          credentialHelperRegister:
            configuredWorkerRuntime.registerCredentialHelperComparisonValues,
        }
      : {}),
    // Resolve after composition: these are the same live Policy/configuration/admission owners.
    credentialHelperOperations: () => ({
      coreDb: options.coreDb,
      store: sharedStore,
      repositoryWorkspaceDb,
      ...(vaultUnlockState ? { vaultUnlockState } : {}),
      ...(runtimeConfigManager ? { runtimeConfigManager } : {}),
      policyInterception,
      goalTaskPolicy,
      ...(dataRoot ? { dataRoot } : {}),
      mode,
    }),
  });

  app.use('/api/worker-inference/*', browserCors);
  registerWorkerInferenceRoutes({
    exposureAvailable: () =>
      operationExposureAvailable('POST /api/worker-inference/v1/chat/completions'),
    onRawOutputStop: (scope, reason) =>
      turnExecutor.interruptTurn(sharedStore, scope.turnId, {
        requestId: null,
        stopReason: reason,
      }),
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
  policyInterception =
    options.policyInterception ??
    new PolicyInterception(
      options.policyParticipant,
      createAgentPolicyParticipant({
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        store: sharedStore,
        runtimeConfig,
        dispatcher: llmGatewayDispatcher,
        resolveGatewayProvider,
        ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
        providerCredentialConfigured,
      })
    );
  const workerMcpRouteInput: RegisterWorkerMcpRoutesInput = {
    interception: policyInterception,
    goalTaskPolicy,
    goalWake: (workspaceId, goalId) => goalServices().wake?.(workspaceId, goalId),
    ...(automationStore ? { automationStore } : {}),
    turnStartServices: {
      ...setupProviderSupply,
      coreDb: options.coreDb,
      inflightCommands,
      providerCredentialResolver,
      runtimeConfig,
      turnExecutor,
      workerPlacement,
    },
    knowledgeAgent,
    fileAdmission,
    ...(configuredWorkerRuntime?.captureArtifact
      ? { captureArtifact: configuredWorkerRuntime.captureArtifact }
      : {}),
    app,
    approvalPolicy: startupOpenKitConfig.policy,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    runtimeConfig,
    runtimeConfigManager,
    store: sharedStore,
    vaultUnlockState,
    workerControlGateway,
    workerMcpGateway,
  };
  registerWorkerMcpRoutes(workerMcpRouteInput);

  registerNanoHostSessionSemanticRoutes({
    app,
    releaseIdentity,
    nativeStorage: nanoHostStorage,
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
    exposureAvailable: operationExposureAvailable,
  });

  let channelServices: ChannelServices | undefined;
  const communicationStorage = options.communicationStorage;
  const readNanoHostTarget =
    nanoHostStorage.state === 'ready'
      ? createNanoHostCoreReads(nanoHostStorage.value.owner).readTarget
      : () => nanoHostStorage;
  const enrollmentWriter =
    nanoHostStorage.state === 'ready' ? nanoHostStorage.value.enrollTransport : undefined;
  const nanoHostEnrollment: import('./operation-composition.js').OperationInvocationDependencies['nanoHostEnrollment'] =
    options.enableNanoHostEnrollment && enrollmentWriter
      ? {
          storage: nanoHostStorage,
          commitEnroll: (input) => {
            const config = startupOpenKitConfig.nanohost;
            if (
              input.record.deploymentId !== config?.deploymentId ||
              input.record.ownerNanoHostIdentityId !== config.identityId
            )
              throw new ControlStoreWorkerError('precondition', 'not-committed');
            return enrollmentWriter(input);
          },
        }
      : undefined;
  const nanoHostCleanupOwner =
    nanoHostStorage.state === 'ready'
      ? { state: 'ready' as const, value: nanoHostStorage.value.owner }
      : nanoHostStorage;
  let communicationCredentialBinding: CommunicationCredentialBinding = {
    listNanoHostTransportTokens: () => {
      if (nanoHostStorage.state === 'ready')
        return nanoHostStorage.value.owner.read((sqlite) =>
          listNanoHostTransportTokenRecords({ sqlite })
        );
      return (
        (options.nanoHostStorage
          ? undefined
          : communicationStorage?.listNanoHostTransportTokens?.()) ?? nanoHostStorage
      );
    },
  };
  registerDiscordInteractionRoutes({
    app,
    config: startupOpenKitConfig.channels?.discord,
    services: () => channelServices,
    exposureAvailable: () => operationExposureAvailable('POST /api/channels/discord/interactions'),
  });

  // All bearer-authenticated surfaces share this App's bounded physical-source accounting.
  const authMiddleware = createAuthMiddleware(mode, auth, authMiddlewareOptions);
  app.use('/api/*', browserCors);
  app.use('/api/*', authMiddleware);
  app.use('/v1/*', browserCors);
  app.use('/v1/*', authMiddleware);
  app.use('/mcp', browserCors);
  app.use('/mcp', authMiddleware);

  function operationExposureAvailable(operationKey: string): boolean {
    const descriptor = Object.hasOwn(OPERATION_REGISTRY, operationKey)
      ? OPERATION_REGISTRY[operationKey as keyof typeof OPERATION_REGISTRY]
      : Object.hasOwn(NON_API_EXPOSURE_DEFINITIONS, operationKey)
        ? NON_API_EXPOSURE_DEFINITIONS[operationKey as keyof typeof NON_API_EXPOSURE_DEFINITIONS]
        : undefined;
    return PolicyInterception.isExposureAvailable({
      coreDb: options.coreDb,
      policy: runtimeConfig().openKitConfig.policy?.mediation,
      exposure: descriptor?.exposure,
    });
  }

  if (options.coreDb) {
    registerRetainedOperationRoutes({
      app,
      coreDb: options.coreDb,
      operationAvailable: operationExposureAvailable,
      quickChatWorkspaceIdForUser: (userId) =>
        quickChatWorkspaceIdForUser(userId, options.coreDb!.dataRoot),
      store: sharedStore,
    });
  }

  if (auth) {
    app.all('/api/auth/*', (c) => {
      const env = c.env as
        | {
            incoming?: { socket?: { remoteAddress?: string } };
            server?: { incoming?: { socket?: { remoteAddress?: string } } };
          }
        | undefined;
      return auth.handler(
        c.req.raw,
        (env?.incoming ?? env?.server?.incoming)?.socket?.remoteAddress
      );
    });
  }

  registerNanoHostTransportAdmissionRoutes({
    app,
    coreDb: options.coreDb,
    nativeStorage: nanoHostStorage,
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
    sessionAuthority: nanohostTransportSessionAuthority,
  });

  registerServiceRoutes({ app, mode, turnExecutor });

  app.get('/api/diagnostics', (c) => {
    const adminError = requireDiagnosticsAdminActor(options.coreDb, c.get('actor'));
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
        gatewayConfig: runtimeConfig().gatewayConfig,
        providerCredentialConfigured,
        ...(providerSubscriptionAccountManager
          ? { subscriptionAccounts: providerSubscriptionAccountManager }
          : {}),
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
    releaseIdentity,
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

  registerAppApiRoute(app, 'workspace.backup-download', async (c) => {
    try {
      const parsed = OPERATION_DEFINITIONS['workspace.backup-download'].inputSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        throw new OperationError('invalid_request', 'Invalid operation input.', 400);
      const actor = c.get('actor');
      return await createWorkspaceSnapshotOperationImplementations({
        coreDb: options.coreDb,
        dataRoot,
        fileAdmission,
        store: requestStore(c),
        diagnosticsServices,
      })['workspace.backup-download'](parsed.data, {
        kind: 'public',
        actor,
        actorRef: { kind: 'user', id: actor.userId },
        scope: { kind: 'server' },
        delivery: 'human',
        signal: c.req.raw.signal,
      });
    } catch (error) {
      return asOperationError(error, projectOperationError(error));
    }
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
          readNanoHost: readNanoHostEnvironment,
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

  const serverWork = sharedStore.getServerWorkBinding();
  registerLlmGatewayRoutes({
    app,
    exposureAvailable: () => operationExposureAvailable('GET /v1/models'),
    providerCredentialConfigured,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    requestStore,
    llmGatewayDispatcher,
    ...(serverWork ? { serverWork } : {}),
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
    quickChatWorkspaceIdForUser: (userId) =>
      quickChatWorkspaceIdForUser(userId, options.coreDb?.dataRoot),
    resolveGatewayProvider,
    runtimeConfig,
    reloadRuntimeConfig: () => runtimeConfigManager.reload({ dryRun: false, mode: 'safe' }),
    runtimeConfigFiles: (actor) => runtimeConfigFileService({ get: () => actor }),
  };

  /** Standalone Tasks need no Goal/file owner; only a native linked context reads that dependency. */
  function goalTaskPolicy(db: WorkspaceDb, responsibleUserId: string): GoalTaskPolicyService {
    if (!options.coreDb) throw new Error('Goal Task Policy is unavailable.');
    return createGoalTaskPolicyService({
      coreDb: options.coreDb,
      store: sharedStore,
      get domains() {
        const domain = goalServices().goalDomain;
        if (!domain) throw new Error('Goal Task Policy is unavailable.');
        return domain.forActor({ kind: 'session', userId: responsibleUserId }, db);
      },
    });
  }
  const goalServices = (): GoalOwnerServices => ({
    agentWorkPaused: () => runtimeConfig().openKitConfig.security?.pauseAgentWork === true,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    ...(options.coreDb
      ? {
          goalDomain: {
            currentRevision: () =>
              `sha256:${createHash('sha256')
                .update(
                  canonicalIdentifierName(
                    runtimeConfig().openKitConfig.policy?.mediation ?? {
                      schemaVersion: 1,
                      statements: [],
                    }
                  )
                )
                .digest('hex')}`,
            forActor: (actor: Actor, db: WorkspaceDb) =>
              createGoalDomainPolicyService({
                coreDb: options.coreDb!,
                store: sharedStore,
                // Goal operations own and close this same-Workspace connection.
                repositoryWorkspaceDb: (workspaceId) => {
                  if (workspaceId !== db.workspaceId)
                    throw new Error('Goal-domain Workspace context changed.');
                  return db;
                },
                files: runtimeConfigFileService({ get: () => actor }),
                currentPolicy: () => runtimeConfig().openKitConfig.policy?.mediation,
                reload: () => runtimeConfigManager.reload({ dryRun: false, mode: 'safe' }),
              }),
          },
        }
      : {}),
    inflightCommands,
    wake: (workspaceId, goalId) => goalCoordinator.wake(workspaceId, goalId),
    interrupt: (turn) => {
      void interruptProductTurn({
        store: sharedStore,
        inflightCommands,
        coreDb: options.coreDb,
        turnExecutor,
        workspaceId: workspaceIdForOwner(turn.owner),
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
    policyInterception,
    goalTaskPolicy,
    turnExecutor,
    knowledgeAgent,
    store: sharedStore,
    coreDb: options.coreDb,
    openWorkspace: repositoryWorkspaceDb,
    runtimeConfig,
    llmGatewayDispatcher,
    resolveGatewayProvider,
    providerCredentialConfigured,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    services: goalServices,
    workerCandidates: (workspaceId, userId) => {
      const snapshot = runtimeConfig();
      return currentWorkerCoordinatorCandidates(sharedStore, workspaceId, {
        userId,
      }).flatMap<GoalWorkerCandidate>((candidate) => {
        const runtime = snapshot.agentManifests.find(
          (manifest) => manifest.id === candidate.agentId
        )?.runtime.kind;
        if (runtime !== 'codex' && runtime !== 'opencode') return [];
        return [
          {
            agentId: candidate.agentId,
            runtime,
            readiness: candidate.readiness,
            reasons: candidate.readiness === 'ready' ? [] : ['Current Worker setup is not ready.'],
          },
        ];
      });
    },
    taskTool: (goalId, coordinatorTurnId) =>
      createCoordinatorTaskTool({
        store: sharedStore,
        coreDb: options.coreDb,
        openWorkspace: repositoryWorkspaceDb,
        inflightCommands,
        startWorker: startModeWorkerTurn,
        goalId,
        coordinatorTurnId,
        goalTaskPolicy,
      }),
  });
  const currentRequesterAuthority = (
    record: import('./runtime/pending-requests.js').PendingRequestRecord
  ): boolean | undefined => {
    if (isResourcePolicyRequest(record))
      return Boolean(
        options.coreDb &&
          isResourcePolicyRequesterCurrent(
            {
              coreDb: options.coreDb,
              store: sharedStore,
              manager: runtimeConfigManager,
            },
            record
          )
      );
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

  const checkCommandIntent: NonNullable<PendingAdmissionDependencies['checkCommandIntent']> = (
    sqlite,
    record,
    actor
  ) => {
    if (isResourcePolicyRequest(record))
      checkResourcePolicyCommandIntent(
        {
          coreDb: options.coreDb!,
          store: sharedStore,
          workspaceDb: { sqlite },
          manager: runtimeConfigManager,
          files: runtimeConfigFileService({ get: () => actor }),
        },
        record,
        actor
      );
    else if (record.governedIntent?.operation === 'mcp.definition.approve')
      checkMcpDefinitionReviewIntent(
        { coreDb: options.coreDb!, sqlite, catalog: capturedMcpCatalog(record.workspaceId) },
        record,
        actor
      );
    else if (record.governedIntent?.operation === 'memory.forget')
      checkMemoryForgetIntent(sqlite, record, actor, options.coreDb!, sharedStore);
    else checkGoalCommandIntent(sqlite, record);
  };

  bindTitleGeneration({
    runtimeConfig,
    repositoryWorkspaceDb,
    dispatcher: llmGatewayDispatcher,
    resolveGatewayProvider,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    providerCredentialConfigured,
  });
  bindThreadTitleScheduler(scheduleThreadTitle);

  const chatService = createConversationService({
    knowledgeAgent,
    providerCredentialConfigured,
    coreDb: options.coreDb,
    inflightCommands,
    llmGatewayDispatcher,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    repositoryWorkspaceDb,
    resolveGatewayProvider,
    runtimeConfig,
    runtimeConfigManager,
    startModeWorkerTurn,
    workerCoordinatorCandidates: currentWorkerCoordinatorCandidates,
    goalServices,
  });

  const pendingAssistantDelivery = { startTurn: chatService.acceptPendingInput };

  const taskStart = createTaskStartOperation({
    coreDb: options.coreDb,
    inflightCommands,
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
      const workspaceId = workspaceIdForOwner(turn.owner);
      const identity = createHash('sha256')
        .update(JSON.stringify([workspaceId, turn.threadId, turn.id]))
        .digest('hex');
      const requestId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;

      const admitted = Promise.withResolvers<void>();
      const execution = startProductTurn({
        agentWorkPaused: () => runtimeConfig().openKitConfig.security?.pauseAgentWork === true,
        ...setupProviderSupply,
        input: {
          input: PENDING_WORKER_TRIGGER_INPUT,
          requestId,
          workspaceId,
          threadId: turn.threadId,
        },
        frozenOutcomeBatch: true,
        requestedAgentId: turn.agentId,
        reservedTurnId: turn.id,
        onTurnCreated: () => admitted.resolve(),
        providerCredentialResolver,
        snapshot: runtimeConfig(),
        store,
        triggerActor: turn.triggerActor,
        turnExecutor,
        workerPlacement,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      })
        .catch(async (error: unknown) => {
          // Only this refused outcome attempt retires its still-queued scheduler ownership.
          if (
            options.coreDb &&
            error instanceof TurnStartValidationError &&
            error.code !== 'recovery_required'
          ) {
            const entry = listSchedulerAdmissionEntriesForWorkspace(options.coreDb, {
              workspaceId,
              statuses: ['queued'],
            }).find(
              (candidate) => candidate.turnId === turn.id && candidate.requestId === requestId
            );
            if (entry)
              await cancelOwnedQueuedAdmission(options.coreDb, {
                queueEntryId: entry.queueEntryId,
                workspaceId,
              });
          }
          throw error;
        })
        .then((handle) => markSchedulerAttemptForTerminalTurn(options.coreDb, handle.turn));
      // The native producer owns the original durable admission ACK, not future Worker completion.
      // Keep the real execution/terminal bookkeeping observed under its existing Worker owner.
      void execution.catch((error: unknown) => {
        admitted.reject(error);
        console.error(`Pending outcome Worker ${turn.id} failed.`, error);
      });
      await admitted.promise;
    },
  };

  const pendingAdmission: PendingAdmissionDependencies = {
    agentAuthority: (record) =>
      runtimeConfig().agentManifests.some((manifest) => manifest.id === record.agentId),
    agentWorkPaused: () => runtimeConfig().openKitConfig.security?.pauseAgentWork === true,
    workerDelivery: pendingWorkerDelivery,
    assistantDelivery: pendingAssistantDelivery,
    coordinatorDelivery: goalCoordinator,
    ...(options.coreDb ? { goalTerminal: goalCoordinator.terminal } : {}),
    requesterAuthority: currentRequesterAuthority,
    checkCommandIntent,
    requestCommitted: goalRequestCommitted,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    openWorkspace(workspaceId) {
      if (options.coreDb) return repositoryWorkspaceDb(workspaceId);
      const root = sharedStore.getDataRoot();
      if (!root) throw new Error('Pending requests have no workspace database.');
      return openAdmittedWorkspaceReadDb(root, workspaceId);
    },
  };
  if (options.coreDb || sharedStore.getDataRoot())
    sharedStore.startPendingRequestDelivery(pendingAdmission);
  resumeAgentWork = async () => {
    if (!options.coreDb && !sharedStore.getDataRoot()) return;
    resumeFrozenPendingDelivery(sharedStore, pendingAdmission);
    for (const workspace of sharedStore.listWorkspaces())
      for (const thread of sharedStore.listThreads(workspace.id))
        if (thread.status !== 'archived')
          await admitIfIdle(sharedStore, pendingAdmission, workspace.id, thread.id);
    await goalCoordinator.resume();
  };
  /** Uses current canonical shared supply without activating saved but unadmitted local configuration. */
  const capturedMcpCatalog = (workspaceId: string, snapshot = runtimeConfig()) => {
    const local = snapshot.workspaceMcpServerCatalogs.find(
      (entry) => entry.workspaceId === workspaceId
    )?.catalog;
    if (!options.coreDb) return local ?? null;
    const composed = composeWorkspaceMcpCatalog({
      dataRoot: options.coreDb.dataRoot,
      workspaceId,
      workspaceCatalog: local ?? { schemaVersion: 1, servers: [] },
    });
    return local || composed.servers.length ? composed : null;
  };
  const pendingRequestServices: NonNullable<
    OperationInvocationDependencies['pendingRequestServices']
  > = {
    agentWorkPaused: () => runtimeConfig().openKitConfig.security?.pauseAgentWork === true,
    workerDelivery: pendingWorkerDelivery,
    assistantDelivery: pendingAssistantDelivery,
    coordinatorDelivery: goalCoordinator,
    ...(options.coreDb ? { goalTerminal: goalCoordinator.terminal } : {}),
    requesterAuthority: currentRequesterAuthority,
    checkCommandIntent,
    requestCommitted: goalRequestCommitted,
    agentAuthority: (record) =>
      runtimeConfig().agentManifests.some((manifest) => manifest.id === record.agentId),
    coreDb: options.coreDb,
    prepareCapturedCall: async (record, workspaceDb, actor) => {
      if (record.governedIntent?.operation === 'mcp.definition.approve') {
        await reviewCapturedMcpPolicy({
          record,
          actor,
          workspaceDb,
          routes: workerMcpRouteInput,
          catalog: capturedMcpCatalog(record.workspaceId),
          interception: policyInterception,
        });
        return undefined;
      }
      return prepareCapturedPendingCall({
        actor,
        record,
        workspaceDb,
        reviewPolicy: async (captured) => {
          const facts = pendingRequestServices.evaluateCapturedCall?.(captured, workspaceDb.sqlite);
          if (!facts?.agentAuthority || !facts.toolInSupply || !facts.schemaCurrent) return null;
          return reviewCapturedMcpPolicy({
            record: captured,
            actor,
            workspaceDb,
            routes: workerMcpRouteInput,
            catalog: capturedMcpCatalog(captured.workspaceId),
            interception: policyInterception,
          });
        },
        coreDb: options.coreDb,
        catalog: capturedMcpCatalog(record.workspaceId),
        vaultBackend: vaultUnlockState ? () => vaultUnlockState.backend() : undefined,
        workerMcpGateway,
      });
    },
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
            ...setupProviderSupply,
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
        catalog: capturedMcpCatalog(record.workspaceId, snapshot),
        coreDb: options.coreDb,
        record,
        sqlite,
        prepared,
      });
    },
    executeCapturedCall: (record, _actor, workspaceDb, prepared, executionCall, current) => {
      const snapshot = runtimeConfig();
      return executeCapturedPendingCall({
        catalog: capturedMcpCatalog(record.workspaceId, snapshot),
        coreDb: options.coreDb,
        record,
        workerMcpGateway,
        vaultBackend: vaultUnlockState ? () => vaultUnlockState.backend() : undefined,
        workspaceDb,
        prepared,
        executionCall,
        current,
      });
    },
    inflightCommands,
    repositoryWorkspaceDb,
  };

  if (options.coreDb) {
    const discordConfig = startupOpenKitConfig.channels?.discord;
    const botTokenRef = discordConfig?.botTokenRef;
    const transport =
      options.discordAttentionTransport ??
      (botTokenRef && publicBaseUrl
        ? createDiscordRestTransport({
            publicBaseUrl,
            resolveBotToken: async () => resolveEnvSecretRef(botTokenRef),
          })
        : undefined);
    const channelInputs: Parameters<typeof createCommunicationChannelServices>[0] = {
      coreDb: options.coreDb,
      store: sharedStore,
      mode,
      openWorkspace: repositoryWorkspaceDb,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
      ...(discordConfig ? { discordConfig } : {}),
      ...(transport ? { transport } : {}),
      invokePending: (id, value, actor) =>
        createOperationInvocation({
          coreDb: options.coreDb,
          store: sharedStore,
          repositoryWorkspaceDb,
          inflightCommands,
          pendingRequestServices,
          fileAdmission,
          mode,
        })(id, value, { kind: 'public', actor, delivery: 'human' }),
    };
    if (communicationStorage?.binding.state === 'ready') {
      const binding = communicationStorage.binding.value;
      const selected = createCommunicationChannelServices({
        ...channelInputs,
        discordOwners: binding.owners,
      });
      if (selected.state === 'ready') {
        const owned = selected.value;
        const run = async <Value>(effect: () => Promise<Value>): Promise<Value> =>
          requireChannelStorage(await binding.withProducer(effect));
        const discord = owned.discord;
        channelServices = {
          ...owned,
          discord: discord
            ? {
                beginPairing: (actor) => run(() => discord.beginPairing(actor)),
                // The signed route races a response deadline after this producer starts.
                handleVerified: (interaction) => run(() => discord.handleVerified(interaction)),
              }
            : null,
          recoverAttention: () => run(owned.recoverAttention),
        };
        communicationCredentialBinding = {
          ...communicationCredentialBinding,
          communicationCredentials: {
            readBinding: owned.credentials.readBinding,
            unbind: async (input) => {
              if (input.actor.kind === 'token' && input.actor.tokenScope !== 'server-admin')
                throw new OperationError(
                  'channel_authority_unavailable',
                  'Current authority unavailable.',
                  403
                );
              const admitted = await binding.withProducer(() => owned.credentials.unbind(input));
              return admitted.state === 'ready' ? admitted.value : admitted;
            },
          },
        };
        binding.wakePairingAudit();
      }
    }
    if (channelServices) {
      setPendingRequestAttentionObserver(sharedStore, channelServices.attentionRaised);
      void channelServices.recoverAttention().catch(() => undefined);
    }
  }

  registerKnowledgePackageRoutes({
    app,
    coreDb: options.coreDb,
    requestStore,
    repositoryWorkspaceDb,
    inflightCommands,
    dataRoot,
    fileAdmission,
    runtimeConfigManager,
  });

  registerArtifactFileRoutes({
    app,
    coreDb: options.coreDb,
    requestStore,
    repositoryWorkspaceDb,
    inflightCommands,
    dataRoot,
    fileAdmission,
  });

  registerOperationJsonRoutes({
    workerControlGateway,
    policyInterception,
    goalTaskPolicy,
    knowledgeAgent,
    ...(serverKnowledgeMaintenance ? { serverKnowledgeMaintenance } : {}),
    fileAdmission,
    diagnosticsServices,
    ...(vaultUnlockState ? { vaultUnlockState } : {}),
    administrationServices,
    appUpdateServices,
    workerEnvironmentServices: {
      operations: workerEnvironmentOperations,
      ...(workerEnvironmentPreparation ? { prepare: workerEnvironmentPreparation.prepare } : {}),
      ...(workerEnvironmentActivation ? { activate: workerEnvironmentActivation.activate } : {}),
    },
    closeMcpCredentialGrants,
    closeWorkspaceMcpSessions: (workspaceId) => workerMcpGateway.closeWorkspace(workspaceId),
    closeServerMcpSessions: async (workspaceId, mcpId) => {
      if (!workerMcpGateway.closeServerScope)
        throw new Error('Shared MCP session cleanup is unavailable.');
      await workerMcpGateway.closeServerScope(workspaceId, mcpId);
    },
    ...(dataRoot
      ? {
          afterUserDisabled: (userId: string) =>
            reconcileWorkspaceDeletionMutationAdmissionAfterUserDisabled({
              dataRoot,
              ...(options.coreDb ? { coreDb: options.coreDb } : {}),
              userId,
            }),
        }
      : {}),
    turnStartServices: {
      ...setupProviderSupply,
      coreDb: options.coreDb,
      inflightCommands,
      providerCredentialResolver,
      runtimeConfig,
      turnExecutor,
      workerPlacement,
    },
    turnExecutor,

    app,
    ...(automationStore ? { automationStore } : {}),
    conversationService: chatService,
    taskStart,
    pendingRequestServices,
    ...(channelServices ? { channelServices } : {}),
    ...(communicationCredentialBinding ? { communicationCredentialBinding } : {}),
    startModeWorkerTurn,
    coreDb: options.coreDb,
    inflightCommands,
    runtimeConfigManager,
    runtimeConfigOperations,
    providerSubscriptionOperations,
    repositoryWorkspaceDb,
    repositoryUserDb,
    resolveGatewayProvider,
    providerCredentialConfigured,
    ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
    requestStore,
    goalServices: goalServices(),
    mode,
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
    dataRoot,
    nanoHostSessionAuthority: nanohostTransportSessionAuthority,
    readNanoHostTarget,
    ...(nanoHostEnrollment ? { nanoHostEnrollment } : {}),
    nanoHostCleanupOwner,
  });

  registerRemoteMcpRoutes({
    exposureAvailable: () => operationExposureAvailable('ALL /mcp'),
    policyInterception,
    goalTaskPolicy,
    knowledgeAgent,
    ...(serverKnowledgeMaintenance ? { serverKnowledgeMaintenance } : {}),
    fileAdmission,
    diagnosticsServices,
    ...(vaultUnlockState ? { vaultUnlockState } : {}),
    administrationServices,
    appUpdateServices,
    workerEnvironmentServices: {
      operations: workerEnvironmentOperations,
      ...(workerEnvironmentPreparation ? { prepare: workerEnvironmentPreparation.prepare } : {}),
      ...(workerEnvironmentActivation ? { activate: workerEnvironmentActivation.activate } : {}),
    },
    closeMcpCredentialGrants,
    closeWorkspaceMcpSessions: (workspaceId) => workerMcpGateway.closeWorkspace(workspaceId),
    closeServerMcpSessions: async (workspaceId, mcpId) => {
      if (!workerMcpGateway.closeServerScope)
        throw new Error('Shared MCP session cleanup is unavailable.');
      await workerMcpGateway.closeServerScope(workspaceId, mcpId);
    },
    ...(dataRoot
      ? {
          afterUserDisabled: (userId: string) =>
            reconcileWorkspaceDeletionMutationAdmissionAfterUserDisabled({
              dataRoot,
              ...(options.coreDb ? { coreDb: options.coreDb } : {}),
              userId,
            }),
        }
      : {}),
    turnStartServices: {
      ...setupProviderSupply,
      coreDb: options.coreDb,
      inflightCommands,
      providerCredentialResolver,
      runtimeConfig,
      turnExecutor,
      workerPlacement,
    },
    turnExecutor,

    app,
    ...(automationStore ? { automationStore } : {}),
    conversationService: chatService,
    taskStart,
    pendingRequestServices,
    ...(channelServices ? { channelServices } : {}),
    ...(communicationCredentialBinding ? { communicationCredentialBinding } : {}),
    runtimeConfigManager,
    runtimeConfigOperations,
    providerSubscriptionOperations,
    goalServices: goalServices(),
    startModeWorkerTurn,
    repositoryWorkspaceDb,
    repositoryUserDb,
    getBootReadiness,
    coreDb: options.coreDb,
    store: sharedStore,
    inflightCommands,
    mode,
    ...(startupOpenKitConfig.nanohost ? { nanoHostConfig: startupOpenKitConfig.nanohost } : {}),
    dataRoot,
    nanoHostSessionAuthority: nanohostTransportSessionAuthority,
    readNanoHostTarget,
    ...(nanoHostEnrollment ? { nanoHostEnrollment } : {}),
    nanoHostCleanupOwner,
  });

  registerTurnEventRoutes({
    app,
    repositoryWorkspaceDb,
    requestStore,
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
  });

  if (options.coreDb && sharedStore.getDataRoot()) goalCoordinator.boot();
  return app;
}

/** Rebuilds retirement exclusion and deletion fences before content loading or process-owned mutation recovery. */
export function restoreWorkspaceDeletionMutationAdmission(input: {
  coreDb?: CoreDb;
  dataRoot: string;
}): void {
  const deletionRequests = listAllWorkspaceDeletionRequests(input.dataRoot);
  if (input.coreDb) {
    restoreWorkspaceRetirementAdmission({ coreDb: input.coreDb });
    const lifecycleRows = input.coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId
         FROM workspace_registry
         WHERE status IN ('deleting', 'deleted')`
      )
      .all() as Array<{ workspaceId: string }>;
    for (const { workspaceId } of lifecycleRows) {
      if (
        getControlStoreWorkerClient().isWorkspaceMutationClosed(
          input.dataRoot,
          workspaceId,
          'capture'
        )
      )
        continue;
      const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, workspaceId);
      const requests = deletionRequests.filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.phase !== 'blocked' &&
          row.originalOwnerUserId === registry?.ownerUserId &&
          (registry.registryRevision === row.expectedRegistryRevision + 1 ||
            registry.registryRevision === row.expectedRegistryRevision + 2)
      );
      const request = requests.length === 1 ? requests[0] : undefined;
      if (
        request &&
        registry?.ownerUserId === request.originalOwnerUserId &&
        (registry.registryRevision === request.expectedRegistryRevision + 1 ||
          registry.registryRevision === request.expectedRegistryRevision + 2)
      )
        getControlStoreWorkerClient().restoreWorkspaceRecoveryClosed(input.dataRoot, workspaceId, {
          deletionRequestId: request.requestId,
          revision: request.expectedRegistryRevision,
        });
      else
        getControlStoreWorkerClient().restoreWorkspaceMutationsClosed(input.dataRoot, workspaceId);
    }
  }
  const requestsByWorkspace = new Map<
    string,
    ReturnType<typeof listAllWorkspaceDeletionRequests>
  >();
  for (const request of deletionRequests) {
    const requests = requestsByWorkspace.get(request.workspaceId) ?? [];
    requests.push(request);
    requestsByWorkspace.set(request.workspaceId, requests);
  }
  for (const [workspaceId, requests] of requestsByWorkspace) {
    const nonterminal = requests.filter((request) => !isTerminalWorkspaceDeletionRequest(request));
    if (nonterminal.length === 0) {
      continue;
    }
    if (input.coreDb && nonterminal.length === 1) {
      const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, workspaceId);
      if (
        registry?.status === 'active' &&
        readFinishedDeletedWorkspaceRecovery(input.coreDb, nonterminal[0]!)
      )
        continue;
    }
    if (
      !getControlStoreWorkerClient().isWorkspaceMutationClosed(
        input.dataRoot,
        workspaceId,
        'capture'
      )
    ) {
      if (nonterminal.length === 1)
        getControlStoreWorkerClient().restoreWorkspaceRecoveryClosed(input.dataRoot, workspaceId, {
          deletionRequestId: nonterminal[0]!.requestId,
          revision: nonterminal[0]!.expectedRegistryRevision,
        });
      else
        getControlStoreWorkerClient().restoreWorkspaceMutationsClosed(input.dataRoot, workspaceId);
    }
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
      getControlStoreWorkerClient().reopenWorkspaceMutations(
        input.dataRoot,
        workspaceId,
        'capture'
      );
      getControlStoreWorkerClient().reopenWorkspaceMutations(input.dataRoot, workspaceId);
    }
  }
  // Bootstrap owns durable reconstruction; its existing authority refusal also excludes direct producers.
  for (const failure of scopeAdmissionFailures(input.dataRoot)) {
    if (
      failure.scope === 'workspace' &&
      failure.check !== 'index' &&
      // Generic refusal must not replace bootstrap's exact capture/recovery closure.
      (failure.check === 'retired' ||
        !getControlStoreWorkerClient().isWorkspaceMutationClosed(
          input.dataRoot,
          failure.id,
          'capture'
        ))
    )
      getControlStoreWorkerClient().restoreWorkspaceMutationsClosed(
        input.dataRoot,
        failure.id,
        failure.check === 'retired' ? 'ordinary' : 'capture'
      );
  }
}

/** Drains affected gates before a durable user disable blocks and reopens pre-transition requests. */
async function reconcileWorkspaceDeletionMutationAdmissionAfterUserDisabled(input: {
  coreDb?: CoreDb;
  dataRoot: string;
  userId: string;
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
    [...workspaceIds].map((workspaceId) =>
      getControlStoreWorkerClient().closeWorkspaceMutations(input.dataRoot, workspaceId)
    )
  );
  restoreWorkspaceDeletionMutationAdmission(input);
}
