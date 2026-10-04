import { composeOperationTables } from '@openkit/app-api-schemas';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { createAdministrationOperationImplementations } from './administration/administration-operations.js';
import { createAgentOperationImplementations } from './agents/agent-operations.js';
import { createWorkerOperationImplementations } from './agents/workspace-workers.js';
import { createAppSearchOperationImplementations } from './app-search-operation-implementations.js';
import { createAppUpdateOperationImplementations } from './app-update/app-update-operations.js';
import { createArtifactOperationImplementations } from './artifact-operations.js';
import { createAccessTokenOperationImplementations } from './auth/access-token-operations.js';
import { createNanoHostOperationImplementations } from './auth/nanohost-operations.js';
import type { NanoHostTransportSessionAuthority } from './auth/nanohost-transport-session.js';
import { createAutomationOperationImplementations } from './automation-operations.js';
import { createCatalogOperationImplementations } from './catalog/catalog-operations.js';
import type { CoreMode } from './config/mode.js';
import type { RuntimeConfigManager } from './config/runtime-config.js';
import { createRuntimeConfigOperationImplementations } from './config/runtime-config-operation-implementations.js';
import { createTaskConversationOperationImplementations } from './conversation-operation-implementations.js';
import {
  createGenerativeUiOperationImplementations,
  createRemainingKernelOperationImplementations,
} from './generative-operations.js';
import { createGoalOperationImplementations } from './goal-operation-implementations.js';
import { createGovernanceOperationImplementations } from './governance-operation-implementations.js';
import { createKernelOperationImplementations } from './kernel-operation-implementations.js';
import { createKnowledgeOperationImplementations } from './knowledge-operations.js';
import type { AutomationStore } from './lib/automation-store.js';
import type { FsStore } from './lib/store.js';
import { createProviderSubscriptionOperationImplementations } from './llm/provider-subscription-operation-implementations.js';
import { createMaterialOperationImplementations } from './material-operation-implementations.js';
import type { createConversationService, createTaskStartOperation } from './mode-entry-routes.js';
import type { OperationImplementations } from './operation-contract.js';
import { createOperationEngine } from './operation-invocation.js';
import { createPendingRequestOperationImplementations } from './pending-request-operations.js';
import { createEnvironmentOperationImplementations } from './runtime/environment-operation-implementations.js';
import type { GoalOwnerServices } from './runtime/goal-owner.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { createSchedulerAdmissionOperationImplementations } from './runtime/scheduler-admission-operations.js';
import type { TurnExecutor } from './runtime/types.js';
import { createRecoveryOperationImplementations } from './runtime/worker-recovery-operations.js';
import { createWorkspaceSyncOperationImplementations } from './runtime/workspace-sync-operations.js';
import { createDataRootAdminOperationImplementations } from './storage/data-root-admin-operations.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { createWorkspaceTransferOperationImplementations } from './storage/workspace-transfer-operations.js';
import { createThreadOperationImplementations } from './thread-operation-implementations.js';
import { createTurnOperationImplementations } from './turn-operation-implementations.js';
import type { TurnStartDependencies } from './turn-routes.js';
import { createVaultOperationImplementations } from './vault/vault-operation-implementations.js';
import type { VaultUnlockState } from './vault/vault-unlock-state.js';
import { createWorkerEnvironmentOperationImplementations } from './worker-environments/worker-environment-operation-implementations.js';
import { createWorkspaceDeletionOperationImplementations } from './workspace-deletion-operations.js';
import type { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { createWorkspaceOperationImplementations } from './workspace-operation-implementations.js';
import { createWorkspaceSharingOperationImplementations } from './workspace-sharing-operations.js';
/** Existing process and record owners used by native invocation. */
export interface OperationInvocationDependencies {
  readonly coreDb: CoreDb | undefined;
  /** Existing deployment configuration family services. */
  readonly runtimeConfigOperations?: Parameters<
    typeof createRuntimeConfigOperationImplementations
  >[0];
  /** Existing pair-scoped subscription account and observation services. */
  readonly providerSubscriptionOperations?: Parameters<
    typeof createProviderSubscriptionOperationImplementations
  >[0];
  /** Boot-bound owners for public Worker environment commands. */
  readonly workerEnvironmentServices?: Parameters<
    typeof createWorkerEnvironmentOperationImplementations
  >[0];
  /** Private administration tools and configuration services; invocation supplies its store. */
  readonly administrationServices?: Omit<
    Parameters<typeof createAdministrationOperationImplementations>[0],
    'store'
  >;
  /** Restricted App-update host adapter and audit database. */
  readonly appUpdateServices?: Parameters<typeof createAppUpdateOperationImplementations>[0];

  /** Existing process-local automation owner, shared across public projections. */
  readonly automationStore?: AutomationStore;
  /** Closes existing Worker MCP sessions when deletion fences a Workspace. */
  readonly closeWorkspaceMcpSessions?: (workspaceId: string) => Promise<void>;
  /** Reconciles existing deletion fences after canonical user disable commits. */
  readonly afterUserDisabled?: (userId: string) => Promise<void> | void;
  /** Existing conversation owner, including process-local interruption handles. */
  readonly conversationService?: ReturnType<typeof createConversationService>;
  /** Existing native worker Turn admission inputs. */
  readonly turnStartServices?: TurnStartDependencies;
  /** Existing interrupt executor; invocation creates no lifecycle. */
  readonly turnExecutor?: TurnExecutor;
  /** Existing bounded Task admission command. */
  readonly taskStart?: ReturnType<typeof createTaskStartOperation>;
  /** Existing captured-call and pending outcome delivery dependencies. */
  readonly pendingRequestServices?: Omit<
    Parameters<typeof createPendingRequestOperationImplementations>[0],
    'store'
  >;
  readonly goalServices?: GoalOwnerServices;
  readonly runtimeConfigManager?: RuntimeConfigManager;
  /** Existing app-owned process-local Vault backend unlock state. */
  readonly vaultUnlockState?: VaultUnlockState;
  readonly repositoryWorkspaceDb?: (workspaceId: string) => WorkspaceDb;
  readonly store?: FsStore;
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly workspaceMutationAdmission?: WorkspaceMutationAdmission;
  /** Existing app-owned worker starter used only by Artifact Review refinement and redo. */
  readonly startModeWorkerTurn?: (input: {
    readonly store: FsStore;
    readonly triggerActor: ActorRef;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
  }) => Promise<ReturnType<FsStore['getTurnById']>>;
  /** Existing NanoHost lifecycle and configured RuntimeTarget observation owner inputs. */
  readonly mode?: CoreMode;
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'> &
    Partial<OpenKitNanoHostConfig>;
  /** Trusted deployment storage path and process-local transport fencing owner. */
  readonly dataRoot?: string | null;
  readonly nanoHostSessionAuthority?: NanoHostTransportSessionAuthority;
}
/** Supplies only executable bindings, with no repeated declarative contract facts. */
export function createOperationImplementations(dependencies: OperationInvocationDependencies) {
  return composeOperationTables(
    createMaterialOperationImplementations({
      coreDb: dependencies.coreDb,
      store: dependencies.store!,
      inflightCommands: dependencies.inflightCommands!,
      repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
    }),
    createAccessTokenOperationImplementations({
      coreDb: dependencies.coreDb,
      mode: dependencies.mode ?? 'local',
    }),
    createRuntimeConfigOperationImplementations(dependencies.runtimeConfigOperations),
    createProviderSubscriptionOperationImplementations(dependencies.providerSubscriptionOperations),
    createAgentOperationImplementations(dependencies),
    createWorkerOperationImplementations(dependencies),
    createCatalogOperationImplementations(dependencies),
    createVaultOperationImplementations(dependencies),
    createAppSearchOperationImplementations(dependencies),
    createEnvironmentOperationImplementations(dependencies),
    createGovernanceOperationImplementations(dependencies),
    createWorkerEnvironmentOperationImplementations(
      dependencies.workerEnvironmentServices ?? { operations: null }
    ),
    createAdministrationOperationImplementations({
      ...dependencies.administrationServices!,
      store: dependencies.store!,
    }),
    createAppUpdateOperationImplementations(dependencies.appUpdateServices ?? { transport: null }),
    createAutomationOperationImplementations(dependencies),
    createSchedulerAdmissionOperationImplementations(dependencies),
    createRecoveryOperationImplementations(dependencies),
    createWorkspaceSyncOperationImplementations({
      coreDb: dependencies.coreDb,
      store: dependencies.store!,
      inflightCommands: dependencies.inflightCommands!,
      repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
    }),
    createKernelOperationImplementations(dependencies),
    createRemainingKernelOperationImplementations(dependencies),
    createGenerativeUiOperationImplementations(dependencies),
    createWorkspaceOperationImplementations(dependencies),
    createWorkspaceTransferOperationImplementations(dependencies),
    createWorkspaceSharingOperationImplementations(dependencies),
    createWorkspaceDeletionOperationImplementations(dependencies),
    createThreadOperationImplementations(dependencies),
    createTurnOperationImplementations(dependencies),
    createKnowledgeOperationImplementations(dependencies),
    createArtifactOperationImplementations(dependencies),
    createGoalOperationImplementations(dependencies),
    createTaskConversationOperationImplementations(dependencies),
    createPendingRequestOperationImplementations({
      ...dependencies.pendingRequestServices!,
      store: dependencies.store!,
    }),
    createNanoHostOperationImplementations({
      coreDb: dependencies.coreDb,
      mode: dependencies.mode ?? 'local',
      ...(dependencies.nanoHostConfig ? { nanoHostConfig: dependencies.nanoHostConfig } : {}),
      ...(dependencies.nanoHostSessionAuthority
        ? { sessionAuthority: dependencies.nanoHostSessionAuthority }
        : {}),
    }),
    createDataRootAdminOperationImplementations(dependencies.dataRoot ?? null)
  ) satisfies OperationImplementations;
}

/** Composes at the caller's existing store lifetime; request status, cancellation and delivery travel only in entry context. */
export function createOperationInvocation(dependencies: OperationInvocationDependencies) {
  return createOperationEngine(createOperationImplementations(dependencies), dependencies);
}
