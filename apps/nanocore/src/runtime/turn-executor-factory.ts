import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type AgentEnvironmentPackage,
  type AgentEnvironmentValidationDiagnostic,
  EMPTY_BUILD_CONTEXT_DIGEST,
  EMPTY_BUILD_CONTEXT_REF,
  planSessionWorkspaceMaterialization,
  validateAgentEnvironmentPackageForBackend,
  type WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import { responsibleUserIdForActor } from '@openkit/protocol';
import {
  WorkerRuntimeRawStreamManifestSchema,
  type WorkerStartupFailure,
  WorkerStartupFailureSchema,
  WorkspaceGitBaselineSchema,
  workerSessionInputPaths,
} from '@openkit/worker-protocol';
import { currentWorkerLineageWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isThreadVisible } from '../auth/thread-visibility.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import {
  listSchedulerSessionLeasesForTurn,
  requireSchedulerSessionLeaseAdmissionContext,
  resolveSchedulerLeaseTokenBinding,
  type SchedulerWorkerStorageChoice,
} from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { loadWorkspaceFileRecords } from '../storage/workspace-file-records.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { vaultSecretMaterialToString } from '../vault/vault-backend.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import type { AgentEnvironmentPackagePreview } from './agent-environment.js';
import {
  createNanoHostEffectRequest,
  nanoHostSandboxIdFromBackendSessionId,
  stableNanoHostEffectJson,
} from './nanohost-effect-identity.js';
import {
  copyNanoHostMeasuredHarnessIdentity,
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  drainNanoHostHarnessAdmission,
  expireNanoHostHarnessQueuedOperation,
  fenceNanoHostSandboxRuntime,
  inspectNanoHostAgentSessionContinuity,
  markNanoHostHarnessOperationUnknown,
  NANO_HOST_HARNESS_RESULT_BUDGET_MS,
  type NanoHostAgentSessionContinuityInspection,
  type NanoHostHarnessCommand,
  type NanoHostHarnessOperation,
  type NanoHostHarnessResult,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
  readNanoHostThreadAgentSessionBinding,
  removeNanoHostSandboxRuntimeByBinding,
  removeNanoHostSandboxRuntimeForHarness,
} from './nanohost-harness-records.js';
import { requireStoredNanoHostPhysicalEpoch } from './nanohost-runtime-target.js';
import type {
  NanoHostEffectOperation,
  NanoHostSessionDispatch,
} from './nanohost-session-dispatch.js';
import { projectOpenShellWorkerPolicy } from './openshell-policy.js';
import type { PublicNetworkConfiguration } from './public-network-grants.js';
import type { TurnExecutor } from './types.js';
import {
  getWorkerBackendSession,
  type WorkerBackendSessionRecord,
} from './worker-backend-sessions.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import {
  getWorkerControlAcceptedFinalStatus,
  waitForWorkerControlFinalStatus,
} from './worker-control-records.js';
import { parseNanoHostImageInspection } from './worker-environment-runtime-effects.js';
import type {
  NanoHostContextPackageImport,
  WorkerGovernanceAgentSessionContinuityDisposition,
  WorkerGovernanceAgentSessionContinuityInput,
  WorkerGovernanceBackend,
  WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationContext,
  WorkerGovernanceMaterializationRecord,
  WorkerGovernanceNativeResume,
  WorkerGovernanceRuntimeEnvCredential,
  WorkerGovernanceRuntimeFileCredential,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import {
  consumeNanoHostStagedExport,
  inspectNanoHostStagedExport,
  MAX_RUNTIME_PROVENANCE_MANIFEST_BYTES,
  MAX_WORKER_ARTIFACT_BYTES,
  openShellFilesystemGrantsFromPackagePolicy,
  openShellNetworkEndpointsFromPackagePolicy,
  parseWorkerArtifactDeclarations,
  prepareNanoHostContextPackageImports,
  removeNanoHostStagedExport,
  resolveNanoHostExportPath,
  WorkerGovernanceCapacityUnavailableError,
} from './worker-governance-backend.js';
import {
  agentSessionCompatibilityKeyFromPackage,
  WorkerGovernanceTurnExecutor,
} from './worker-governance-turn-executor.js';
import {
  activateWorkerStorageAttachment,
  admitWorkerStorageContributor,
  authorizeAttachedWorkerStorageReplacement,
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  getWorkerStorageBindingForSandbox,
  listWorkerStorageBindings,
  markWorkerStorageAttachmentUnknown,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  resolveWorkerStorageWorkSlotRef,
  selectWorkerStorageBinding,
  type WorkerStorageBinding,
  type WorkerStorageContributor,
  type WorkerStorageSelectionInput,
  type WorkerStorageTarget,
} from './worker-storage-bindings.js';
import type {
  WorkerRuntimeProvenanceCollection,
  WorkerTranscriptPayload,
} from './worker-transcript.js';
import {
  WorkspaceCollectCommandSchema,
  WorkspaceCollectionError,
} from './workspace-collect-wire.js';
import {
  acceptWorkspaceBaseline,
  acceptWorkspaceCapture,
  authorizeWorkspaceBaselineInitialization,
  readWorkspaceBaselineIdentity,
  readWorkspaceCollection,
  readWorkspaceSnapshotCursor,
  requireWorkspaceBaselineInitialization,
  type WorkspaceCollectionIdentity,
} from './workspace-snapshot-chain.js';

/** Exact V1 maximum for one raw NanoHost file export. */
const NANO_HOST_FILE_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
/** Maximum raw value accepted for one process environment credential. */
const NANO_HOST_RUNTIME_ENV_VALUE_MAX_BYTES = 64 * 1024;
/** Maximum raw value accepted for one runtime credential file. */
const NANO_HOST_RUNTIME_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Environment variables used by NanoCore turn executor selection. */
export interface TurnExecutorFactoryEnv {
  /** Deterministic internal self-check executor switch used by tests and smoke runs. */
  OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR?: string | undefined;
  /** HTTP port used when deriving the default worker-control upstream. */
  PORT?: string | undefined;
}

/** Options for creating the configured NanoCore turn executor. */
export interface CreateConfiguredTurnExecutorOptions {
  /** Reads active configuration for resolution-time public-route admission. */
  readRuntimeConfig?: (() => PublicNetworkConfiguration) | undefined;
  /** Optional Core database for durable workspace synchronization records. */
  coreDb?: CoreDb | undefined;
  /** Environment variables to read. Defaults to `process.env`. */
  env?: TurnExecutorFactoryEnv | undefined;
  /** Worker control gateway shared with NanoCore worker-control routes. */
  workerControlGateway?: WorkerControlGateway | undefined;
  /** Optional vault backend used for grant-derived provider attachments. */
  vaultBackend?: (() => VaultBackend) | undefined;
  /** Optional process-local store shared with the public App API. */
  store?: FsStore | undefined;
  /** Authoritative fixed-effect dispatcher shared with the native NanoHost session. */
  nanoHostSessionDispatch?: NanoHostSessionDispatch | undefined;
  /** Shared Workspace deletion fence for late worker publication. */
  workspaceMutationAdmission?: WorkspaceMutationAdmission | undefined;
}

/** Shared real-worker lifecycle selected from NanoCore runtime configuration. */
export interface ConfiguredWorkerLifecycleRuntime {
  /** Binds private Turn route tokens and returns `session.open` with its ephemeral Vault values. */
  readonly acceptNanoHostHarnessCommand: (
    command: NanoHostHarnessCommand
  ) => NanoHostHarnessCommand;
  /** Advances one exact live producer after its durable Harness result settles. */
  readonly acceptNanoHostHarnessResult: (result: NanoHostHarnessResult) => void;
  /** Cleans one exact durable backend identity during restart or online recovery. */
  readonly cleanupBackendSession: (
    identity: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
  /** Reports live lifecycle ownership before scheduler recovery can take over a Turn. */
  readonly isTurnExecutionActive: (turnId: string) => boolean;
  /** Registers restart cleanup result identities before the transport listener exists. */
  readonly prepareBackendCleanup: (identity: WorkerGovernanceBackendSessionIdentity) => void;
  /** Restores and closes one worker whose final status is already durable. */
  readonly reconcileAcceptedFinalStatus: (session: WorkerBackendSessionRecord) => Promise<{
    readonly status: 'cancelled' | 'completed' | 'failed' | 'interrupted';
    readonly turn: ReturnType<FsStore['getTurnById']>;
  }>;
  /** Sole production runtime target family. */
  readonly runtimeTargetKind: 'nanohost';
  /** Restores read-only access to one exact durable backend session. */
  readonly restoreBackendSession: (session: WorkerBackendSessionRecord) => Promise<void>;
  /** Product turn executor backed by the same cleanup owner. */
  readonly turnExecutor: TurnExecutor;
}

/**
 * Creates the turn executor selected by NanoCore runtime configuration.
 *
 * @param options Environment and shared worker-control gateway.
 * @returns Configured turn executor.
 * @throws Error when runtime, placement, or backend configuration is unsupported.
 */
export function createConfiguredTurnExecutor(
  options: CreateConfiguredTurnExecutorOptions = {}
): TurnExecutor {
  const env = options.env ?? process.env;

  if (env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1') {
    return new SimulatedTurnExecutor({ coreDb: options.coreDb });
  }

  return createConfiguredWorkerLifecycleRuntime(options).turnExecutor;
}

/**
 * Creates one shared physical-backend owner for execution and durable cleanup recovery.
 *
 * @param options Environment, Core database, and shared worker-control gateway.
 * @returns Turn executor and exact cleanup callback backed by one backend instance.
 * @throws Error when runtime configuration is unsupported or Core storage is unavailable.
 */
export function createConfiguredWorkerLifecycleRuntime(
  options: CreateConfiguredTurnExecutorOptions = {}
): ConfiguredWorkerLifecycleRuntime {
  const env = options.env ?? process.env;
  if (!options.coreDb) {
    throw new Error('Real worker execution requires the durable Core database.');
  }
  return createNanoHostWorkerLifecycleRuntime(
    env,
    options.coreDb,
    options.nanoHostSessionDispatch,
    options.workerControlGateway,
    options.vaultBackend,
    options.store,
    options.workspaceMutationAdmission,
    options.readRuntimeConfig
  );
}

/**
 * Creates the sole NanoHost-backed worker lifecycle runtime.
 *
 * @param env Environment variables to read.
 * @param coreDb Durable Core database and deployment identity source.
 * @param nanoHostSessionDispatch Authoritative fixed-effect dispatcher.
 * @param workerControlGateway Existing semantic worker-control owner.
 * @param vaultBackend Optional vault backend used for runtime provider grants.
 * @param sharedStore Optional process-local store shared with the App API.
 * @returns Shared worker lifecycle runtime.
 */
function createNanoHostWorkerLifecycleRuntime(
  env: TurnExecutorFactoryEnv,
  coreDb: CoreDb,
  nanoHostSessionDispatch?: NanoHostSessionDispatch | undefined,
  workerControlGateway?: WorkerControlGateway | undefined,
  vaultBackend?: (() => VaultBackend) | undefined,
  sharedStore?: FsStore | undefined,
  workspaceMutationAdmission?: WorkspaceMutationAdmission | undefined,
  readRuntimeConfig?: (() => PublicNetworkConfiguration) | undefined
): ConfiguredWorkerLifecycleRuntime {
  const backend = new NanoHostWorkerGovernanceBackend(
    coreDb,
    (agentSessionId, digest, retainedStorage) => {
      if (!(turnExecutor instanceof WorkerGovernanceTurnExecutor)) {
        throw new Error('The self-check executor cannot record real native proof.');
      }
      turnExecutor.recordNativeHandleDigest(
        sharedStore ?? new FsStore({ dataRoot: coreDb.dataRoot }),
        agentSessionId,
        digest,
        retainedStorage
      );
    },
    nanoHostSessionDispatch,
    workerControlGateway,
    vaultBackend
  );
  const turnExecutor =
    env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1'
      ? new SimulatedTurnExecutor({ coreDb })
      : new WorkerGovernanceTurnExecutor({
          awaitWorkerCompletion: (environmentPackage, leaseId) =>
            waitForWorkerControlFinalStatus(coreDb, {
              leaseId,
              lineage: {
                agentSessionId: environmentPackage.scope.agentSessionId,
                packageSnapshotId: environmentPackage.snapshotId,
                requestId: environmentPackage.scope.requestId ?? null,
                threadId: environmentPackage.scope.threadId,
                turnId: environmentPackage.scope.turnId,
                workspaceId: environmentPackage.scope.workspaceId,
              },
            }),
          backend,
          coreDb,
          ...(readRuntimeConfig ? { readRuntimeConfig } : {}),
          resolveResidentWorkerStorageWorkSlotRef: (environmentPackage) =>
            backend.resolveResidentWorkerStorageWorkSlotRef(environmentPackage),
          ...(vaultBackend ? { vaultBackend } : {}),
          ...(workerControlGateway ? { workerControlGateway } : {}),
          ...(workspaceMutationAdmission ? { workspaceMutationAdmission } : {}),
        });

  if (turnExecutor instanceof WorkerGovernanceTurnExecutor) {
    backend.setWorkspaceCollectionPublisher((environmentPackage, records) =>
      turnExecutor.publishWorkspaceCollections(
        sharedStore ?? new FsStore({ dataRoot: coreDb.dataRoot }),
        environmentPackage,
        records
      )
    );
  }

  /** Restores the existing immutable package and read-only backend handle. */
  async function restoreDurableSession(
    session: WorkerBackendSessionRecord
  ): Promise<AgentEnvironmentPackage> {
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, session.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;
    try {
      applyScopedMigrations(workspaceDb);
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        session.workspaceId,
        session.packageSnapshotId
      ).snapshot;
    } finally {
      workspaceDb.sqlite.close();
    }
    const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, session.leaseId);
    if (
      !isDeepStrictEqual(environmentPackage.scope.triggerActor, admission.triggerActor) ||
      session.backendKind !== 'openshell' ||
      !sessionMatchesRuntimeImage(session, environmentPackage.runtime.image) ||
      session.workspaceHandoffState !== 'complete'
    ) {
      throw new Error('Restart backend session does not match its immutable runtime package.');
    }
    return environmentPackage;
  }

  return {
    cleanupBackendSession: (identity) => backend.cleanupSession(identity),
    isTurnExecutionActive: (turnId) =>
      turnExecutor instanceof WorkerGovernanceTurnExecutor &&
      turnExecutor.isTurnExecutionActive(turnId),
    prepareBackendCleanup: (identity) => backend.prepareCleanupRecovery(identity),
    acceptNanoHostHarnessCommand: (command) => backend.acceptHarnessCommand(command),
    acceptNanoHostHarnessResult: (result) => backend.acceptHarnessResult(result),
    runtimeTargetKind: 'nanohost',
    reconcileAcceptedFinalStatus: async (session) => {
      if (!(turnExecutor instanceof WorkerGovernanceTurnExecutor)) {
        throw new Error('The self-check executor cannot reconcile a real worker session.');
      }
      const environmentPackage = await restoreDurableSession(session);
      backend.restoreSession(environmentPackage, session.leaseId);
      const store = sharedStore ?? new FsStore({ dataRoot: coreDb.dataRoot });
      const recoveredStatus = await turnExecutor.resumeAcceptedFinalStatus(
        store,
        environmentPackage,
        session
      );
      return { status: recoveredStatus, turn: store.getTurnById(session.turnId) };
    },
    restoreBackendSession: async (session) => {
      const environmentPackage = await restoreDurableSession(session);
      backend.restoreSession(environmentPackage, session.leaseId);
      if (turnExecutor instanceof WorkerGovernanceTurnExecutor) {
        turnExecutor.bindNativeHandleRecorder(
          sharedStore ?? new FsStore({ dataRoot: coreDb.dataRoot }),
          environmentPackage
        );
      }
    },
    turnExecutor,
  };
}

/** One materialized Turn awaiting operations on the shared private Harness. */
interface NanoHostBackendTurnSession {
  /** Verified Turn input bytes awaiting exact session admission; never restored or replayed. */
  pendingImports: NanoHostContextPackageImport[];
  /**
   * Session-static Vault material consumed once at the `session.open` dispatch; never persisted
   * or restored. A Turn that reuses an open binding drops it, because the resident host's
   * environment was fixed when it started.
   */
  runtimeEnvironment: Record<string, string> | null;
  runtimeCheckVersions: Array<{
    targetEnvVarName: string;
    vaultReferenceId: string;
    materialVersion: number;
  }> | null;
  /** Predecessor resume pair for a new binding; null starts a new native conversation. */
  readonly nativeResume: WorkerGovernanceNativeResume | null;
  /** AgentSession owner bound by the executor; receives each accepted ready proof at once. */
  recordNativeHandleDigest:
    | ((digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => void)
    | null;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly evidence: WorkerGovernanceEvidenceRecord[];
  readonly agentSessionCompatibilityKey: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly harnessBindingRef: string;
  readonly harnessInstanceId: string;
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  readonly leaseId: string;
  /** Set when an accepted ready proof could not be written; cleanup must keep this binding row. */
  acceptedProofUnrecorded?: boolean;
  /** Set when a live refusal carried cleanup_required; this owner must widen cleanup. */
  cleanupOwnershipRequired?: boolean;
  nativeSessionReusable: boolean;
  readonly sharedHarness: NanoHostSharedHarness;
  pendingHarnessOperation: PendingNanoHostHarnessOperation | null;
  turnStopSettlement: Promise<void> | null;
  readonly retainedStagingPaths: string[];
  terminalInspectionComplete: boolean;
  turnStarted: boolean;
}

/** One process-local waiter for an exact durable private Harness operation. */
interface PendingNanoHostHarnessOperation {
  readonly operation: NanoHostHarnessOperation;
  operationId: string | null;
  readonly reject: (error: Error) => void;
  readonly resolve: (body: Readonly<Record<string, unknown>>) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

/** Pre-lease close owner reconstructed from one exact durable AgentSession binding. */
interface NanoHostAgentSessionCloseOwner {
  readonly inspection: NanoHostAgentSessionContinuityInspection;
  pending: PendingNanoHostHarnessOperation | null;
}

/** One compatible physical Sandbox and Harness retained across AgentSessions and Turns. */
interface NanoHostSharedHarness {
  readonly bindings: Map<
    string,
    {
      readonly agentSessionCompatibilityKey: string;
      readonly agentSessionRuntimeBindingId: string;
      nativeHandleDigest: string | null;
      nextTurnSequence: number;
      runtimeEnvironment: Record<string, string> | null;
    }
  >;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly harnessBindingRef: string;
  readonly harnessCompatibilityKey: string;
  readonly harnessInstanceId: string;
  readonly sandbox: NanoHostSharedSandbox;
}

/** One compatible physical Sandbox and its single retained Integration bridge. */
interface NanoHostSharedSandbox {
  bridgeOpen: boolean;
  readonly imageDigest: string;
  readonly originPhysicalEpoch: string;
  readonly runtimeTargetId: string;
  readonly sandboxBindingRef: string;
  readonly sandboxId: string;
  readonly sandboxCompatibilityKey: string;
  readonly sandboxIntegrationBindingRef: string;
  readonly sandboxRuntimeId: string;
  workerStorageBinding: WorkerStorageBinding;
}

/** One incompatible resident Sandbox whose complete private occupancy is proved idle. */
interface NanoHostIdleSandboxEviction {
  readonly bindings: Array<
    NanoHostAgentSessionContinuityInspection & { readonly lifecycleState: string }
  >;
  readonly bridgeOpen: boolean;
  readonly closeAgentSessions: boolean;
  readonly originPhysicalEpoch: string;
  readonly physicalAbsent: boolean;
  readonly sandboxBindingRef: string;
  readonly sandboxCompatibilityKey: string;
  readonly sandboxId: string;
  readonly sandboxRuntimeId: string;
}

/** Process-local proof that this attempt created a Sandbox before publishing its session. */
interface LivePartialSandboxMaterialization {
  readonly attachmentGeneration: number;
  readonly expectedRevision: number;
  readonly leaseId: string;
  readonly originPhysicalEpoch: string;
  readonly sandboxId: string;
  readonly storageRef: string;
  deleteDispatched: boolean;
}

/**
 * Returns product guidance for a closed workspace-materialization refusal.
 *
 * @param operation Harness operation that produced the result.
 * @param disposition Harness result disposition.
 * @param reason Harness reason code.
 * @param startup Validated startup failure, when the refusal carried one.
 * @returns Guidance appended to the shared Turn error, or an empty string.
 */
function workspaceMaterializationRefusalExplanation(
  operation: string,
  disposition: string,
  reason: unknown,
  startup: WorkerStartupFailure | null
): string {
  if (
    (operation !== 'turn.start' && operation !== 'session.open') ||
    disposition !== 'refused' ||
    reason !== 'dependency_failed' ||
    startup?.stage !== 'workspace_materialization'
  ) {
    return '';
  }
  if (startup.reason === 'retained_baseline_conflict') {
    return ' The retained checkout and requested commit differ; choose a fresh work environment for the requested commit, or restore the source configuration to the retained checkout’s original commit before reusing it.';
  }
  if (startup.reason === 'git_fetch_commit_unavailable') {
    return ' The configured Git remote does not serve the requested commit; publish that commit or select one the remote serves, then start a new Task. The incomplete slot stays in place.';
  }
  if (startup.reason === 'git_fetch_http_refused') {
    return ` Repository access returned HTTP ${startup.explanation?.httpStatus}; the source of the refusal is not established. Ask an authorized operator to inspect sandbox network policy and upstream access separately, then start a new Task only after cleanup and storage admission allow it. The incomplete slot stays in place.`;
  }
  if (startup.reason === 'git_fetch_tls_failed') {
    return ' The worker could not trust the configured Git remote during fetch. Repair the sandbox trust bundle, then start a new Task. The incomplete slot stays in place.';
  }
  if (startup.reason === 'git_fetch_transport_failed') {
    return ' The worker could not complete the Git fetch transport. This covers a subprocess, timeout, or transport failure and is not proof that the remote lacks the commit. The incomplete slot stays in place.';
  }
  return '';
}

/** NanoHost-backed effect boundary used by the sole production turn executor. */
class NanoHostWorkerGovernanceBackend implements WorkerGovernanceBackend {
  private workspaceCollectionPublisher:
    | ((
        environmentPackage: AgentEnvironmentPackage,
        records: readonly WorkerGovernanceWorkspaceChangeRecord[]
      ) => Promise<void>)
    | null = null;
  /** Binds the existing executor's durable Workspace Sync Review publisher for release captures. */
  public setWorkspaceCollectionPublisher(
    publisher: (
      environmentPackage: AgentEnvironmentPackage,
      records: readonly WorkerGovernanceWorkspaceChangeRecord[]
    ) => Promise<void>
  ): void {
    this.workspaceCollectionPublisher = publisher;
  }
  private readonly agentSessionCloseOwners = new Map<string, NanoHostAgentSessionCloseOwner>();
  private readonly cleanupRecoveryResults = new Map<
    string,
    ReturnType<NonNullable<NanoHostSessionDispatch['expectResultOnly']>>
  >();
  /** Live attempts that failed before Sandbox creation, with any storage reservation rolled back. */
  private readonly failedPreSandboxPreparations = new Set<string>();
  /** Created Sandboxes whose in-memory session was never published in this process. */
  private readonly livePartialMaterializations = new Map<
    string,
    LivePartialSandboxMaterialization
  >();
  private readonly sessions = new Map<string, NanoHostBackendTurnSession>();
  private readonly sharedSandboxes = new Map<string, NanoHostSharedSandbox>();
  private readonly sharedHarnesses = new Map<string, NanoHostSharedHarness>();

  /**
   * Creates the NanoHost backend over the composition root's one session dispatcher.
   *
   * @param coreDb Durable Core database and lineage source.
   * @param recordNativeHandleDigest Existing Core recorder for proof on an eviction victim.
   * @param sessionDispatch Optional dispatcher; production composition always supplies it.
   * @param workerControlGateway Optional existing semantic worker-control owner.
   * @param collectionVaultBackend Existing Vault owner for private release snapshots.
   */
  public constructor(
    private readonly coreDb: CoreDb,
    private readonly recordNativeHandleDigest: (
      agentSessionId: string,
      digest: string,
      retainedStorage: { storageRef: string; workSlotRef: string }
    ) => void,
    private readonly sessionDispatch?: NanoHostSessionDispatch,
    private readonly workerControlGateway?: WorkerControlGateway,
    private readonly collectionVaultBackend?: () => VaultBackend
  ) {}

  /** Binds dispatched Turn route tokens and adds Vault values only to private wire bytes. */
  public acceptHarnessCommand(command: NanoHostHarnessCommand): NanoHostHarnessCommand {
    const bindingId = command.body.agentSessionRuntimeBindingId;
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.harnessInstanceId === command.harnessInstanceId &&
        candidate.pendingHarnessOperation?.operation === command.operation &&
        (typeof bindingId !== 'string' || candidate.agentSessionRuntimeBindingId === bindingId)
    );
    const closeOwner =
      !session && typeof bindingId === 'string'
        ? this.agentSessionCloseOwners.get(bindingId)
        : undefined;
    const pending = session?.pendingHarnessOperation ?? closeOwner?.pending;
    if (!pending || pending.operation !== command.operation || pending.operationId) {
      throw new Error('NanoHost dispatched operation does not match its live producer.');
    }
    if (command.operation === 'session.open' && session?.runtimeEnvironment === null) {
      throw new Error('NanoHost AgentSession credential material is unavailable.');
    }
    if (command.operation === 'turn.start') {
      if (!session) {
        throw new Error('NanoHost dispatched Turn has no live producer session.');
      }
      try {
        const leaseId = command.body.leaseId;
        const workerControlToken = command.body.workerControlToken;
        const workerInferenceToken = command.body.inferenceToken;
        const workerCapabilityToken = command.body.capabilityToken;
        if (
          leaseId !== session.leaseId ||
          typeof workerControlToken !== 'string' ||
          typeof workerInferenceToken !== 'string' ||
          typeof workerCapabilityToken !== 'string'
        ) {
          throw new Error('NanoHost dispatched Turn does not match its live producer.');
        }
        if (!this.workerControlGateway) {
          throw new Error('NanoHost dispatched Turn requires the worker-control gateway.');
        }
        const lease = this.coreDb.sqlite
          .prepare(
            'SELECT sandbox_binding_ref AS sandboxBindingRef FROM scheduler_session_leases WHERE lease_id = ?'
          )
          .get(session.leaseId) as { readonly sandboxBindingRef: string } | undefined;
        if (!lease) {
          throw new Error('NanoHost dispatched Turn lease binding is unavailable.');
        }
        this.workerControlGateway.registerSession(session.environmentPackage, {
          sandboxBindingRef: lease.sandboxBindingRef,
          workerCapabilityToken,
          workerControlToken,
          workerInferenceToken,
        });
      } catch (error) {
        if (pending.timeout) clearTimeout(pending.timeout);
        session.pendingHarnessOperation = null;
        let dispatchError = new Error('NanoHost Harness Turn dispatch binding failed.', {
          cause: error,
        });
        try {
          markNanoHostHarnessOperationUnknown(this.coreDb, {
            harnessBindingRef: session.harnessBindingRef,
            operationId: command.operationId,
            timestamp: new Date().toISOString(),
          });
        } catch (cleanupError) {
          dispatchError = new Error('NanoHost Harness Turn dispatch cleanup failed.', {
            cause: cleanupError,
          });
        }
        pending.reject(dispatchError);
        throw dispatchError;
      }
    }
    const harnessBindingRef =
      session?.harnessBindingRef ?? closeOwner?.inspection.harnessBindingRef;
    if (!harnessBindingRef) {
      throw new Error('NanoHost dispatched operation has no exact Harness binding.');
    }
    pending.operationId = command.operationId;
    if (command.operation === 'session.open' && session) {
      const runtimeEnvironment = session.runtimeEnvironment!;
      return Object.keys(runtimeEnvironment).length === 0
        ? command
        : { ...command, body: { ...command.body, runtimeEnvironment } };
    }
    return command;
  }

  /** Resolves only the exact live producer after durable result settlement. */
  public acceptHarnessResult(result: NanoHostHarnessResult): void {
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.harnessInstanceId === result.harnessInstanceId &&
        candidate.pendingHarnessOperation
    );
    const closeOwner = !session
      ? [...this.agentSessionCloseOwners.values()].find(
          (candidate) =>
            candidate.inspection.harnessInstanceId === result.harnessInstanceId && candidate.pending
        )
      : undefined;
    const pending = session?.pendingHarnessOperation ?? closeOwner?.pending;
    if (!pending) {
      return;
    }
    if (pending.operationId !== result.operationId) {
      throw new Error('NanoHost Harness result does not match its live producer.');
    }
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (session) {
      session.pendingHarnessOperation = null;
    }
    if (closeOwner) {
      closeOwner.pending = null;
      this.agentSessionCloseOwners.delete(closeOwner.inspection.agentSessionRuntimeBindingId);
    }
    if (result.disposition === 'succeeded') {
      pending.resolve(result.body);
      return;
    }
    const reason = result.body.reasonCode;
    const startup = WorkerStartupFailureSchema.safeParse(result.body.startupFailure);
    const detail = startup.success ? ` (${startup.data.stage}: ${startup.data.reason})` : '';
    const explanation = workspaceMaterializationRefusalExplanation(
      pending.operation,
      result.disposition,
      reason,
      startup.success ? startup.data : null
    );
    if (session && result.disposition === 'refused' && reason === 'cleanup_required') {
      session.cleanupOwnershipRequired = true;
      drainNanoHostHarnessAdmission(this.coreDb, {
        harnessBindingRef: session.harnessBindingRef,
        timestamp: new Date().toISOString(),
      });
    }
    pending.reject(
      Object.assign(
        new Error(
          `NanoHost Harness ${pending.operation} ${result.disposition}: ${typeof reason === 'string' ? reason : 'invalid'}${detail}.${explanation}`
        ),
        {
          ...(typeof reason === 'string' ? { reasonCode: reason } : {}),
          ...(startup.success && startup.data.explanation
            ? { explanation: startup.data.explanation }
            : {}),
        }
      )
    );
  }

  /** Restores one compatible persisted Sandbox and its single Integration bridge. */
  private restoreSharedSandbox(
    sandboxCompatibilityKey: string,
    runtimeTargetId: string
  ): NanoHostSharedSandbox | null {
    const currentPhysicalEpoch = this.requireCurrentPhysicalEpoch(runtimeTargetId);
    const existing = this.sharedSandboxes.get(sandboxCompatibilityKey);
    if (existing) {
      if (existing.originPhysicalEpoch !== currentPhysicalEpoch) {
        throw new Error('NanoHost cached Sandbox belongs to a different physical Epoch.');
      }
      return existing;
    }
    const row = this.coreDb.sqlite
      .prepare(
        `SELECT sandbox_runtime_id AS sandboxRuntimeId,
                runtime_target_id AS runtimeTargetId,
                sandbox_binding_ref AS sandboxBindingRef,
                sandbox_integration_binding_ref AS sandboxIntegrationBindingRef,
                image_digest AS imageDigest,
                origin_physical_epoch AS originPhysicalEpoch,
                lifecycle_state AS lifecycleState,
                health_state AS healthState,
                drain_state AS drainState,
                cleanup_state AS cleanupState
         FROM sandbox_runtime_records WHERE sandbox_compatibility_key = ?`
      )
      .get(sandboxCompatibilityKey) as
      | {
          readonly cleanupState: string;
          readonly drainState: string;
          readonly healthState: string;
          readonly imageDigest: string;
          readonly lifecycleState: string;
          readonly originPhysicalEpoch: string;
          readonly runtimeTargetId: string;
          readonly sandboxBindingRef: string;
          readonly sandboxIntegrationBindingRef: string;
          readonly sandboxRuntimeId: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    if (
      row.runtimeTargetId !== runtimeTargetId ||
      row.originPhysicalEpoch !== currentPhysicalEpoch ||
      row.lifecycleState !== 'open' ||
      row.healthState !== 'ready' ||
      row.drainState !== 'accepting' ||
      row.cleanupState !== 'clean'
    ) {
      throw new Error('NanoHost persisted shared Sandbox is not reusable.');
    }
    const sandbox: NanoHostSharedSandbox = {
      bridgeOpen: true,
      imageDigest: row.imageDigest,
      originPhysicalEpoch: row.originPhysicalEpoch,
      runtimeTargetId: row.runtimeTargetId,
      sandboxBindingRef: row.sandboxBindingRef,
      sandboxId: nanoHostSandboxId(sandboxCompatibilityKey),
      sandboxCompatibilityKey,
      sandboxIntegrationBindingRef: row.sandboxIntegrationBindingRef,
      sandboxRuntimeId: row.sandboxRuntimeId,
      workerStorageBinding: requireAttachedWorkerStorageBinding(
        this.coreDb,
        row.sandboxBindingRef,
        runtimeTargetId
      ),
    };
    this.sharedSandboxes.set(sandboxCompatibilityKey, sandbox);
    return sandbox;
  }

  /** Restores one exact persisted shared Harness without creating a second physical runtime. */
  private restoreSharedHarness(
    sandboxCompatibilityKey: string,
    harnessCompatibilityKey: string,
    runtimeTargetId: string,
    adapterId: string,
    adapterVersion: string,
    durableOriginPhysicalEpoch?: string
  ): NanoHostSharedHarness | null {
    const currentPhysicalEpoch = this.resolveRestorationPhysicalEpoch(
      runtimeTargetId,
      durableOriginPhysicalEpoch
    );
    const mapKey = nanoHostSharedHarnessMapKey(sandboxCompatibilityKey, harnessCompatibilityKey);
    const existing = this.sharedHarnesses.get(mapKey);
    if (existing) {
      if (existing.sandbox.originPhysicalEpoch !== currentPhysicalEpoch) {
        throw new Error('NanoHost cached Harness belongs to a different physical Epoch.');
      }
      return existing;
    }
    const row = this.coreDb.sqlite
      .prepare(
        `SELECT s.sandbox_runtime_id AS sandboxRuntimeId,
                s.runtime_target_id AS runtimeTargetId,
                s.sandbox_binding_ref AS sandboxBindingRef,
                s.image_digest AS imageDigest,
                s.origin_physical_epoch AS originPhysicalEpoch,
                s.sandbox_integration_binding_ref AS sandboxIntegrationBindingRef,
                s.lifecycle_state AS sandboxLifecycleState,
                s.health_state AS healthState,
                s.drain_state AS sandboxDrainState,
                s.cleanup_state AS cleanupState,
                h.harness_instance_id AS harnessInstanceId,
                h.harness_binding_ref AS harnessBindingRef,
                h.harness_compatibility_key AS harnessCompatibilityKey,
                h.adapter_id AS adapterId,
                h.adapter_version AS adapterVersion,
                h.max_open_sessions AS maxOpenSessions,
                h.max_active_turns AS maxActiveTurns,
                h.lifecycle_state AS harnessLifecycleState,
                h.drain_state AS harnessDrainState
         FROM sandbox_runtime_records s
         JOIN harness_instance_records h ON h.sandbox_runtime_id = s.sandbox_runtime_id
         WHERE s.sandbox_compatibility_key = ? AND h.harness_compatibility_key = ?`
      )
      .get(sandboxCompatibilityKey, harnessCompatibilityKey) as
      | {
          readonly adapterId: string;
          readonly adapterVersion: string;
          readonly cleanupState: string;
          readonly harnessBindingRef: string;
          readonly harnessCompatibilityKey: string;
          readonly harnessDrainState: string;
          readonly harnessInstanceId: string;
          readonly harnessLifecycleState: string;
          readonly healthState: string;
          readonly imageDigest: string;
          readonly maxActiveTurns: number;
          readonly maxOpenSessions: number;
          readonly originPhysicalEpoch: string;
          readonly runtimeTargetId: string;
          readonly sandboxDrainState: string;
          readonly sandboxBindingRef: string;
          readonly sandboxLifecycleState: string;
          readonly sandboxIntegrationBindingRef: string;
          readonly sandboxRuntimeId: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    if (
      row.runtimeTargetId !== runtimeTargetId ||
      row.originPhysicalEpoch !== currentPhysicalEpoch ||
      row.adapterId !== adapterId ||
      row.adapterVersion !== adapterVersion ||
      row.maxOpenSessions !== 8 ||
      row.maxActiveTurns !== 1 ||
      row.sandboxLifecycleState !== 'open' ||
      row.harnessLifecycleState !== 'open' ||
      row.healthState !== 'ready' ||
      row.sandboxDrainState !== 'accepting' ||
      row.harnessDrainState !== 'accepting' ||
      row.cleanupState !== 'clean'
    ) {
      throw new Error('NanoHost persisted shared Harness is not reusable.');
    }
    const sandbox = this.sharedSandboxes.get(sandboxCompatibilityKey) ?? {
      bridgeOpen: true,
      imageDigest: row.imageDigest,
      originPhysicalEpoch: row.originPhysicalEpoch,
      runtimeTargetId: row.runtimeTargetId,
      sandboxBindingRef: row.sandboxBindingRef,
      sandboxId: nanoHostSandboxId(sandboxCompatibilityKey),
      sandboxCompatibilityKey,
      sandboxIntegrationBindingRef: row.sandboxIntegrationBindingRef,
      sandboxRuntimeId: row.sandboxRuntimeId,
      workerStorageBinding: requireAttachedWorkerStorageBinding(
        this.coreDb,
        row.sandboxBindingRef,
        runtimeTargetId
      ),
    };
    this.sharedSandboxes.set(sandboxCompatibilityKey, sandbox);
    const sharedHarness: NanoHostSharedHarness = {
      adapterId,
      adapterVersion,
      bindings: new Map(),
      harnessBindingRef: row.harnessBindingRef,
      harnessCompatibilityKey: row.harnessCompatibilityKey,
      harnessInstanceId: row.harnessInstanceId,
      sandbox,
    };
    const bindings = this.coreDb.sqlite
      .prepare(
        `SELECT agent_session_id AS agentSessionId,
                agent_session_runtime_binding_id AS agentSessionRuntimeBindingId,
                agent_session_compatibility_key AS agentSessionCompatibilityKey,
                native_handle_digest AS nativeHandleDigest,
                next_turn_sequence AS nextTurnSequence
         FROM agent_session_runtime_bindings WHERE harness_instance_id = ?`
      )
      .all(row.harnessInstanceId) as Array<{
      readonly agentSessionCompatibilityKey: string;
      readonly agentSessionId: string;
      readonly agentSessionRuntimeBindingId: string;
      readonly nativeHandleDigest: string | null;
      readonly nextTurnSequence: number;
    }>;
    for (const binding of bindings) {
      sharedHarness.bindings.set(binding.agentSessionId, {
        agentSessionCompatibilityKey: binding.agentSessionCompatibilityKey,
        agentSessionRuntimeBindingId: binding.agentSessionRuntimeBindingId,
        nativeHandleDigest: binding.nativeHandleDigest,
        nextTurnSequence: binding.nextTurnSequence,
        runtimeEnvironment: null,
      });
    }
    this.sharedHarnesses.set(mapKey, sharedHarness);
    return sharedHarness;
  }

  /** Restores one exact shared Harness and AgentSession binding from durable private records. */
  public restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void {
    if (this.sessions.has(environmentPackage.snapshotId)) {
      return;
    }
    const expectedSandboxKey = nanoHostSandboxCompatibilityKey(environmentPackage);
    const expectedHarnessKey = nanoHostHarnessCompatibilityKey(environmentPackage);
    const adapterId = nanoHostAdapterId(environmentPackage);
    const expectedSessionKey = nanoHostAgentSessionCompatibilityKey(environmentPackage);
    const identity = this.planSession(environmentPackage);
    const durableSession = this.findDurableBackendSession(identity);
    if (!durableSession || durableSession.leaseId !== leaseId) {
      throw new Error('NanoHost restart backend anchor is missing or incompatible.');
    }
    const sharedHarness = this.restoreSharedHarness(
      expectedSandboxKey,
      expectedHarnessKey,
      requireNanoHostRuntimeTargetId(identity),
      adapterId,
      environmentPackage.agent.runtimeVersion,
      durableSession.originPhysicalEpoch
    );
    const binding = sharedHarness?.bindings.get(environmentPackage.scope.agentSessionId);
    if (!sharedHarness || !binding || binding.agentSessionCompatibilityKey !== expectedSessionKey) {
      throw new Error('NanoHost restart binding is missing or incompatible.');
    }
    this.sessions.set(environmentPackage.snapshotId, {
      agentSessionCompatibilityKey: expectedSessionKey,
      agentSessionRuntimeBindingId: binding.agentSessionRuntimeBindingId,
      environmentPackage,
      evidence: [],
      harnessBindingRef: sharedHarness.harnessBindingRef,
      harnessInstanceId: sharedHarness.harnessInstanceId,
      identity,
      leaseId,
      nativeResume: null,
      nativeSessionReusable: false,
      recordNativeHandleDigest: null,
      pendingImports: [],
      runtimeEnvironment: null,
      runtimeCheckVersions: null,
      pendingHarnessOperation: null,
      turnStopSettlement: null,
      retainedStagingPaths: [],
      sharedHarness,
      terminalInspectionComplete: false,
      turnStarted: true,
    });
  }

  /** Returns the capabilities materialized by the configured NanoHost. */
  public async describeCapabilities(): Promise<WorkerGovernanceBackendCapabilities> {
    return {
      capabilities: [
        'container',
        'filesystem-policy',
        'network-policy',
        'process-policy',
        'transcript-sink',
        'worker-control',
        'sandbox-local-endpoint',
        'nanocore-inference-upstream',
        'trusted-worker-inference-relay',
        'audit-export',
        'file-upload-download',
        'git-materialization',
        'filesystem-materialization',
        'change-set-collection',
      ],
      dynamicCapabilities: [],
      kind: 'openshell',
      version: '0.0.99',
    };
  }

  /** Validates a package against the fixed NanoHost capability declaration. */
  public async validatePackage(
    environmentPackage: AgentEnvironmentPackage
  ): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return validateAgentEnvironmentPackageForBackend(
      environmentPackage,
      await this.describeCapabilities()
    );
  }

  /** Plans a durable identity against the one configured RuntimeTarget without effects. */
  public planSession(
    environmentPackage: AgentEnvironmentPackagePreview
  ): WorkerGovernanceBackendSessionIdentity {
    const target = this.coreDb.sqlite
      .prepare(
        `SELECT target_id AS targetId, deployment_id AS deploymentId
         FROM nanohost_runtime_targets
         LIMIT 1`
      )
      .get() as { readonly deploymentId: string; readonly targetId: string } | undefined;
    if (!target) {
      throw new Error('Configured NanoHost RuntimeTarget is unavailable.');
    }
    const sandboxId = nanoHostSandboxId(nanoHostSandboxCompatibilityKey(environmentPackage));
    const attemptId = createHash('sha256')
      .update(environmentPackage.snapshotId)
      .digest('hex')
      .slice(0, 16);
    return {
      agentSessionId: environmentPackage.scope.agentSessionId,
      backendKind: 'openshell',
      backendSessionId: `${sandboxId}-${attemptId}`,
      deploymentId: target.deploymentId,
      packageSnapshotId: environmentPackage.snapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
      transientProviderInstanceId: null,
    };
  }

  /** Projects the exact selected-storage authorization used before one Sandbox replacement. */
  private workerStorageReplacementSelection(
    environmentPackage: AgentEnvironmentPackagePreview,
    choice: SchedulerWorkerStorageChoice | undefined,
    responsibleUserId: string,
    authorizeContributor: WorkerStorageSelectionInput['authorizeContributor']
  ):
    | (Omit<WorkerStorageSelectionInput, 'layout'> & {
        readonly reuseWorkSlotRef?: string;
      })
    | undefined {
    return choice?.kind === 'selected'
      ? {
          ...(choice.adjudicatedThreadIds
            ? { adjudicatedThreadIds: choice.adjudicatedThreadIds }
            : {}),
          authorizeContributor,
          expectedRevision: choice.expectedRevision,
          ...(choice.goalId === undefined ? {} : { goalId: choice.goalId }),
          purpose: choice.purpose,
          responsibleUserId,
          ...(choice.reuseWorkSlotRef ? { reuseWorkSlotRef: choice.reuseWorkSlotRef } : {}),
          storageRef: choice.storageRef,
          ...(choice.taskId === undefined ? {} : { taskId: choice.taskId }),
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        }
      : undefined;
  }

  /** Validates an explicit selection before effects; attachment admission still performs its own CAS. */
  private validateWorkerStorageSelection(
    environmentPackage: AgentEnvironmentPackagePreview,
    sandboxBindingRef: string,
    selection: Omit<WorkerStorageSelectionInput, 'layout'> & {
      readonly reuseWorkSlotRef?: string;
    }
  ): WorkerStorageBinding {
    const selected = getWorkerStorageBinding(this.coreDb, { storageRef: selection.storageRef });
    if (!selected) throw new Error('Worker storage association was not found.');
    const binding =
      selected.currentSandboxBindingRef === sandboxBindingRef
        ? authorizeAttachedWorkerStorageReplacement(this.coreDb, {
            ...selection,
            sandboxBindingRef,
          })
        : selectWorkerStorageBinding(this.coreDb, { ...selection, layout: selected.layout });
    if (
      resolveWorkerStorageWorkSlotRef(binding, selection) !==
      packageWorkerStorageWorkSlotRef(environmentPackage)
    ) {
      throw new Error('Worker storage work slot changed after package planning.');
    }
    return binding;
  }

  /** Reads the sole native AgentSession occupying one Workspace Thread, if any. */
  public readThreadAgentSessionBinding(input: {
    readonly threadId: string;
    readonly workspaceId: string;
  }): { readonly agentSessionId: string } | null {
    return readNanoHostThreadAgentSessionBinding(this.coreDb, input);
  }

  /** Proves exact retained continuity or closes one durable AgentSession-local binding. */
  public async prepareAgentSessionContinuity(
    input: WorkerGovernanceAgentSessionContinuityInput
  ): Promise<WorkerGovernanceAgentSessionContinuityDisposition> {
    const runtimeTargets = this.coreDb.sqlite
      .prepare(
        `SELECT predecessor_fenced AS predecessorFenced, ready, fresh_empty AS freshEmpty
         FROM nanohost_runtime_targets`
      )
      .all() as Array<{
      readonly freshEmpty: 0 | 1;
      readonly predecessorFenced: 0 | 1;
      readonly ready: 0 | 1;
    }>;
    if (
      runtimeTargets.length !== 1 ||
      runtimeTargets[0]?.predecessorFenced !== 1 ||
      runtimeTargets[0].ready !== 1 ||
      runtimeTargets[0].freshEmpty !== 1
    ) {
      throw new WorkerGovernanceCapacityUnavailableError(
        'The configured NanoHost RuntimeTarget is not ready for admission.'
      );
    }
    const inspection = inspectNanoHostAgentSessionContinuity(this.coreDb, input);
    if (!inspection) {
      return 'absent';
    }
    // Compatibility decides placement, never whether an already-accepted proof survives.
    if (input.recordNativeHandleDigest) {
      this.handoffDurableAgentSessionProof(inspection, input.recordNativeHandleDigest);
    }
    if (
      !this.hasProcessLocalAgentSession(inspection) &&
      input.reuseAllowed &&
      input.environmentPackage !== undefined
    ) {
      this.restoreSameEpochIdleHarness(input.environmentPackage);
    }
    if (!this.hasProcessLocalAgentSession(inspection)) {
      if (input.reuseAllowed) {
        return 'sandbox-replacement-required';
      }
      if (
        !input.environmentPackage ||
        !input.admissionAgentSessionId ||
        !input.admissionLeaseId ||
        input.environmentPackage.scope.agentSessionId !== input.admissionAgentSessionId ||
        this.requireLeaseId(input.environmentPackage.snapshotId) !== input.admissionLeaseId
      ) {
        throw new Error('NanoHost restart-unproved retirement lacks admission package lineage.');
      }
      const responsibleUserId = responsibleUserIdForActor(
        input.environmentPackage.scope.triggerActor
      );
      if (!responsibleUserId) {
        throw new Error('Worker storage requires one responsible user.');
      }
      const releasedBinding = await this.evictIncompatibleIdleSandbox(
        input.environmentPackage,
        this.planSession(input.environmentPackage),
        input.admissionLeaseId,
        true,
        this.workerStorageReplacementSelection(
          input.environmentPackage,
          input.workerStorageChoice,
          responsibleUserId,
          currentWorkerStorageAudienceAuthorizer(this.coreDb, input.environmentPackage)
        )
      );
      return releasedBinding && input.workerStorageChoice?.kind === 'selected'
        ? {
            disposition: 'closed',
            storageRevisionAdvance: {
              attachmentGeneration: releasedBinding.attachmentGeneration,
              previousRevision: input.workerStorageChoice.expectedRevision,
              revision: releasedBinding.revision,
              storageRef: releasedBinding.storageRef,
            },
          }
        : 'closed';
    }
    if (input.reuseAllowed) {
      // SessionCompatibilityKey omits supply; an absent desired package cannot prove the resident Harness still matches.
      if (
        !input.environmentPackage ||
        nanoHostHarnessCompatibilityKey(input.environmentPackage) !==
          inspection.harnessCompatibilityKey
      ) {
        return 'replacement-required';
      }
      return inspection.reusable ? 'reusable' : 'replacement-required';
    }
    if (input.workerStorageChoice?.kind === 'selected') {
      const environmentPackage = input.environmentPackage;
      const responsibleUserId = environmentPackage
        ? responsibleUserIdForActor(environmentPackage.scope.triggerActor)
        : null;
      const sharedHarness = [...this.sharedHarnesses.values()].find(
        (harness) => harness.harnessBindingRef === inspection.harnessBindingRef
      );
      if (!environmentPackage || !responsibleUserId || !sharedHarness) {
        throw new Error('Worker storage selection lacks current AgentSession lineage.');
      }
      this.validateWorkerStorageSelection(
        environmentPackage,
        sharedHarness.sandbox.sandboxBindingRef,
        this.workerStorageReplacementSelection(
          environmentPackage,
          input.workerStorageChoice,
          responsibleUserId,
          currentWorkerStorageAudienceAuthorizer(this.coreDb, environmentPackage)
        )!
      );
    }
    await this.closeDurableAgentSession(inspection);
    for (const sharedHarness of this.sharedHarnesses.values()) {
      if (sharedHarness.harnessBindingRef === inspection.harnessBindingRef) {
        sharedHarness.bindings.delete(inspection.agentSessionId);
      }
    }
    return 'closed';
  }

  /**
   * Rehydrates the exact same-Epoch idle Harness using current package keys and the ready target Epoch.
   *
   * @param environmentPackage Current package whose sandbox and harness keys must match the surviving row.
   * @throws When a matching same-Epoch row exists but cannot restore its attachment or Harness.
   */
  private restoreSameEpochIdleHarness(environmentPackage: AgentEnvironmentPackagePreview): void {
    const sandboxCompatibilityKey = nanoHostSandboxCompatibilityKey(environmentPackage);
    const row = this.coreDb.sqlite
      .prepare(
        `SELECT origin_physical_epoch AS originPhysicalEpoch,
                runtime_target_id AS runtimeTargetId
         FROM sandbox_runtime_records WHERE sandbox_compatibility_key = ?`
      )
      .get(sandboxCompatibilityKey) as
      | { readonly originPhysicalEpoch: string; readonly runtimeTargetId: string }
      | undefined;
    if (!row) {
      return;
    }
    const currentPhysicalEpoch = this.readCurrentPhysicalEpoch(row.runtimeTargetId);
    if (
      currentPhysicalEpoch === null ||
      requireStoredNanoHostPhysicalEpoch(row.originPhysicalEpoch) !== currentPhysicalEpoch
    ) {
      return;
    }
    this.restoreSharedHarness(
      sandboxCompatibilityKey,
      nanoHostHarnessCompatibilityKey(environmentPackage),
      row.runtimeTargetId,
      nanoHostAdapterId(environmentPackage),
      environmentPackage.agent.runtimeVersion
    );
  }

  /** Resolves a retained work slot only from one compatible resident Sandbox attachment. */
  public resolveResidentWorkerStorageWorkSlotRef(
    environmentPackage: AgentEnvironmentPackagePreview
  ): string | null {
    const responsibleUserId = responsibleUserIdForActor(environmentPackage.scope.triggerActor);
    if (!responsibleUserId) return null;
    const sandboxCompatibilityKey = nanoHostSandboxCompatibilityKey(environmentPackage);
    this.restoreSameEpochIdleHarness(environmentPackage);
    const sandbox = this.sharedSandboxes.get(sandboxCompatibilityKey);
    return (
      sandbox?.workerStorageBinding.contributors.findLast(
        (contributor) =>
          contributor.threadId === environmentPackage.scope.threadId &&
          contributor.responsibleUserId === responsibleUserId
      )?.workSlotRef ?? null
    );
  }

  /** Reads whether this backend instance owns the exact live native binding inventory. */
  private hasProcessLocalAgentSession(
    inspection: NanoHostAgentSessionContinuityInspection
  ): boolean {
    const sharedHarness = [...this.sharedHarnesses.values()].find(
      (candidate) => candidate.harnessInstanceId === inspection.harnessInstanceId
    );
    if (!sharedHarness) return false;
    const binding = sharedHarness?.bindings.get(inspection.agentSessionId);
    return (
      binding?.agentSessionRuntimeBindingId === inspection.agentSessionRuntimeBindingId &&
      sharedHarness.sandbox.originPhysicalEpoch ===
        this.readCurrentPhysicalEpoch(sharedHarness.sandbox.runtimeTargetId)
    );
  }

  /** Registers only the two exact cleanup result identities and performs no effect. */
  public prepareCleanupRecovery(identity: WorkerGovernanceBackendSessionIdentity): void {
    if (this.cleanupRecoveryResults.has(identity.packageSnapshotId)) {
      return;
    }
    const durableSandbox = this.sessions.has(identity.packageSnapshotId)
      ? null
      : this.findDurableSandboxBinding(identity);
    const durableCleanupFailure = durableSandbox
      ? null
      : this.findDurableBackendCleanupFailure(identity);
    if (durableSandbox?.cleanupState === 'unknown') {
      if (
        durableSandbox.lifecycleState !== 'failed' ||
        durableSandbox.healthState !== 'unknown' ||
        durableSandbox.drainState !== 'draining'
      ) {
        throw new Error('NanoHost unknown cleanup fence is contradictory.');
      }
      return;
    }
    if (durableCleanupFailure) {
      return;
    }
    const result = this.createCleanupRecoveryResult(
      identity,
      this.requireCleanupOriginPhysicalEpoch(identity, durableSandbox?.originPhysicalEpoch)
    );
    if (!result) {
      throw new Error('NanoHost result-only cleanup dispatcher is unavailable.');
    }
    this.cleanupRecoveryResults.set(identity.packageSnapshotId, result);
  }

  /** Clears one Turn locally, retaining only a proved reusable shared Harness. */
  public async cleanupSession(
    identity: WorkerGovernanceBackendSessionIdentity,
    options?: { readonly failedCloseout: boolean }
  ): Promise<void> {
    const leaseId = this.requireLeaseId(identity.packageSnapshotId);
    const session = this.sessions.get(identity.packageSnapshotId);
    const durableSandbox = session ? null : this.findDurableSandboxBinding(identity);
    const durableBackend =
      session || durableSandbox ? null : this.findDurableBackendSession(identity);
    const durableCleanupFailure =
      durableBackend?.state === 'cleanup-failed' ? durableBackend : null;
    const pendingStorage =
      durableBackend?.state === 'cleanup-pending'
        ? this.findWorkerStorageForFailedMaterialization(durableBackend)
        : null;
    let retainUnrecordedProof = false;
    try {
      if (session?.acceptedProofUnrecorded) {
        // The binding row is the only retained copy. Do not close, delete, or drop this session.
        retainUnrecordedProof = true;
        drainNanoHostHarnessAdmission(this.coreDb, {
          harnessBindingRef: session.harnessBindingRef,
          timestamp: new Date().toISOString(),
        });
        throw new Error(
          'NanoHost accepted native ready proof could not be recorded before cleanup.'
        );
      }
      if (this.failedPreSandboxPreparations.has(identity.packageSnapshotId)) {
        return;
      }
      if (durableSandbox?.cleanupState === 'unknown') {
        if (
          durableSandbox.lifecycleState !== 'failed' ||
          durableSandbox.healthState !== 'unknown' ||
          durableSandbox.drainState !== 'draining'
        ) {
          throw new Error('NanoHost unknown cleanup fence is contradictory.');
        }
        this.requireLaterFreshRuntimeTarget(
          durableSandbox.runtimeTargetId,
          durableSandbox.originPhysicalEpoch,
          identity.deploymentId
        );
        this.releaseWorkerStorageForSandbox(durableSandbox.sandboxBindingRef);
        removeNanoHostSandboxRuntimeByBinding(this.coreDb, durableSandbox.sandboxBindingRef);
        return;
      }
      if (durableCleanupFailure) {
        this.requireLaterFreshRuntimeTarget(
          durableCleanupFailure.runtimeTargetId,
          durableCleanupFailure.originPhysicalEpoch,
          identity.deploymentId
        );
        this.releaseWorkerStorageForFailedMaterialization(
          this.findWorkerStorageForFailedMaterialization(durableCleanupFailure)
        );
        this.livePartialMaterializations.delete(identity.packageSnapshotId);
        return;
      }
      const livePartial = this.livePartialMaterializations.get(identity.packageSnapshotId);
      if (!session && livePartial) {
        await this.cleanupLivePartialMaterialization(identity, livePartial, pendingStorage);
        return;
      }
      const agentSessionId = session?.environmentPackage.scope.agentSessionId;
      const closeUnprovedOwner =
        !!session &&
        session.turnStarted &&
        !session.terminalInspectionComplete &&
        !!session.cleanupOwnershipRequired &&
        !!agentSessionId &&
        session.sharedHarness.bindings.has(agentSessionId);
      const closeInspectedBinding =
        !!session &&
        session.turnStarted &&
        session.terminalInspectionComplete &&
        (!session.nativeSessionReusable || !!options?.failedCloseout) &&
        !!agentSessionId &&
        session.sharedHarness.bindings.has(agentSessionId);
      let widenCleanup = false;
      if ((closeUnprovedOwner || closeInspectedBinding) && session) {
        try {
          await this.collectWorkspaceSnapshot(session, 'release');
          const closed = await this.queueAndWaitForHarnessOperation(session, 'session.close', {
            agentSessionId: session.environmentPackage.scope.agentSessionId,
            agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
          });
          if (closed.state !== 'closed' || closed.privateState !== 'absent') {
            throw new Error('NanoHost Harness session.close result is incompatible.');
          }
          session.sharedHarness.bindings.delete(session.environmentPackage.scope.agentSessionId);
        } catch (error) {
          if (!isCleanupRequiredRefusal(error)) {
            throw error;
          }
          // The still-live owner issues the first wider delete. A conflict stays a refusal.
          widenCleanup = true;
        }
      } else if (!(session?.turnStarted && session.terminalInspectionComplete)) {
        widenCleanup = true;
      }
      if (widenCleanup) {
        try {
          const cleanupInput = {
            leaseId,
            sandboxId:
              session?.sharedHarness.sandbox.sandboxId ??
              nanoHostSandboxIdFromBackendSessionId(identity.backendSessionId),
          };
          const recoveryResult = !session
            ? (this.cleanupRecoveryResults.get(identity.packageSnapshotId) ??
              this.createCleanupRecoveryResult(
                identity,
                this.requireCleanupOriginPhysicalEpoch(
                  identity,
                  durableSandbox?.originPhysicalEpoch
                )
              ))
            : null;
          if (recoveryResult) {
            const retained = await recoveryResult.finally(() =>
              this.cleanupRecoveryResults.delete(identity.packageSnapshotId)
            );
            requireNanoHostResultObject(retained.result);
            if (retained.kind === 'bridge.close') {
              await this.effect(
                identity,
                leaseId,
                'sandbox.delete',
                cleanupInput,
                durableSandbox?.originPhysicalEpoch
              );
            }
          } else {
            await this.deleteSandbox(
              identity,
              cleanupInput,
              !session || session.sharedHarness.sandbox.bridgeOpen,
              durableSandbox?.originPhysicalEpoch
            );
          }
        } catch (error) {
          const fenceInput = session
            ? { harnessBindingRef: session.harnessBindingRef }
            : durableSandbox
              ? { sandboxBindingRef: durableSandbox.sandboxBindingRef }
              : null;
          if (fenceInput) {
            fenceNanoHostSandboxRuntime(this.coreDb, {
              ...fenceInput,
              timestamp: new Date().toISOString(),
            });
            this.fenceWorkerStorageForSandbox(
              session?.sharedHarness.sandbox.sandboxBindingRef ?? durableSandbox!.sandboxBindingRef
            );
          }
          if (session) {
            session.nativeSessionReusable = false;
            this.forgetSharedSandbox(session.sharedHarness.sandbox.sandboxCompatibilityKey);
          }
          throw error;
        }
        if (session) {
          this.releaseWorkerStorageForSandbox(session.sharedHarness.sandbox.sandboxBindingRef);
          removeNanoHostSandboxRuntimeForHarness(this.coreDb, session.harnessInstanceId);
          this.forgetSharedSandbox(session.sharedHarness.sandbox.sandboxCompatibilityKey);
        } else if (durableSandbox) {
          this.releaseWorkerStorageForSandbox(durableSandbox.sandboxBindingRef);
          removeNanoHostSandboxRuntimeByBinding(this.coreDb, durableSandbox.sandboxBindingRef);
        } else {
          this.releaseWorkerStorageForFailedMaterialization(pendingStorage);
        }
      }
    } finally {
      if (!retainUnrecordedProof) {
        for (const stagingPath of session?.retainedStagingPaths ?? []) {
          await removeNanoHostStagedExport(stagingPath).catch(() => undefined);
        }
        this.workerControlGateway?.unregisterSession(identity.packageSnapshotId);
        this.sessions.delete(identity.packageSnapshotId);
      }
      this.failedPreSandboxPreparations.delete(identity.packageSnapshotId);
    }
  }

  /** Widens live cleanup through the bridge and Sandbox without returning capacity early. */
  private async deleteSandbox(
    identity: WorkerGovernanceBackendSessionIdentity,
    cleanupInput: { readonly leaseId: string; readonly sandboxId: string },
    bridgeOpen: boolean,
    retiringSandboxOrigin?: string
  ): Promise<void> {
    if (bridgeOpen) {
      await this.effect(
        identity,
        cleanupInput.leaseId,
        'bridge.close',
        cleanupInput,
        retiringSandboxOrigin
      );
    }
    await this.effect(
      identity,
      cleanupInput.leaseId,
      'sandbox.delete',
      cleanupInput,
      retiringSandboxOrigin
    );
  }

  /** Drops process-local projections after the physical Sandbox was deleted or fenced. */
  private forgetSharedSandbox(sandboxCompatibilityKey: string): void {
    this.sharedSandboxes.delete(sandboxCompatibilityKey);
    for (const [key, harness] of this.sharedHarnesses) {
      if (harness.sandbox.sandboxCompatibilityKey === sandboxCompatibilityKey) {
        this.sharedHarnesses.delete(key);
      }
    }
  }

  /**
   * Deletes one Sandbox this process created but never published, then releases its exact reservation.
   *
   * @param identity Exact backend attempt that owns the partial creation.
   * @param partial Process-local create proof captured before session publication.
   * @param pendingStorage Reservation captured before the delete is awaited.
   * @throws Error when epoch, lineage, deletion, or the storage compare-and-swap is not proved.
   */
  private async cleanupLivePartialMaterialization(
    identity: WorkerGovernanceBackendSessionIdentity,
    partial: LivePartialSandboxMaterialization,
    pendingStorage: WorkerStorageBinding | null
  ): Promise<void> {
    if (partial.deleteDispatched) {
      throw new Error('NanoHost live partial Sandbox deletion is already dispatched.');
    }
    if (
      !pendingStorage ||
      pendingStorage.storageRef !== partial.storageRef ||
      pendingStorage.attachmentGeneration !== partial.attachmentGeneration ||
      pendingStorage.revision !== partial.expectedRevision ||
      pendingStorage.state !== 'reserved' ||
      pendingStorage.currentSandboxBindingRef !== null
    ) {
      throw new Error(
        'NanoHost live partial storage reservation does not match cleanup ownership.'
      );
    }
    this.requireCurrentBackendPhysicalEpoch(identity, partial.originPhysicalEpoch);
    partial.deleteDispatched = true;
    await this.effect(
      identity,
      partial.leaseId,
      'sandbox.delete',
      { leaseId: partial.leaseId, sandboxId: partial.sandboxId },
      partial.originPhysicalEpoch
    );
    this.releaseWorkerStorageForFailedMaterialization(pendingStorage);
    this.livePartialMaterializations.delete(identity.packageSnapshotId);
  }

  /** Releases an existing attachment after writer cleanup proof without reconstructing missing storage. */
  private releaseWorkerStorageForSandbox(sandboxBindingRef: string): WorkerStorageBinding | null {
    const binding = getWorkerStorageBindingForSandbox(this.coreDb, { sandboxBindingRef });
    if (!binding) {
      console.warn(
        'NanoHost Sandbox storage binding is missing after proved writer cleanup; retiring only the runtime projection.'
      );
      return null;
    }
    return releaseWorkerStorageAttachment(this.coreDb, {
      attachmentGeneration: binding.attachmentGeneration,
      cleanupProved: true,
      expectedRevision: binding.revision,
      sandboxBindingRef,
      storageRef: binding.storageRef,
    });
  }

  /** Snapshots the sole active reservation, requiring exact Sandbox ownership for pending cleanup. */
  private findWorkerStorageForFailedMaterialization(
    session: WorkerBackendSessionRecord
  ): WorkerStorageBinding | null {
    const bindings = listWorkerStorageBindings(this.coreDb, {
      authorizeContributor: () => true,
      workspaceId: session.workspaceId,
    }).filter(
      (binding) =>
        (binding.state === 'reserved' ||
          binding.state === 'attached' ||
          binding.state === 'unknown') &&
        binding.currentAgentSessionId === session.agentSessionId &&
        binding.currentThreadId === session.threadId &&
        binding.deploymentId === session.deploymentId &&
        binding.runtimeTargetId === session.runtimeTargetId
    );
    if (bindings.length > 1) {
      throw new Error(
        'NanoHost failed materialization matches more than one Worker storage binding.'
      );
    }
    const binding = bindings[0] ?? null;
    if (
      session.state === 'cleanup-pending' &&
      binding?.currentSandboxBindingRef != null &&
      binding.currentSandboxBindingRef !== session.sandboxBindingRef
    ) {
      throw new Error('Worker storage Sandbox binding contradicts cleanup ownership.');
    }
    return binding;
  }

  /** Releases only the captured attachment generation and revision after writer cleanup proof. */
  private releaseWorkerStorageForFailedMaterialization(
    binding: WorkerStorageBinding | null
  ): WorkerStorageBinding | null {
    if (!binding) return null;
    return releaseWorkerStorageAttachment(this.coreDb, {
      attachmentGeneration: binding.attachmentGeneration,
      cleanupProved: true,
      expectedRevision: binding.revision,
      sandboxBindingRef: binding.currentSandboxBindingRef,
      storageRef: binding.storageRef,
    });
  }

  /** Fences only one retained association after Sandbox cleanup becomes uncertain. */
  private fenceWorkerStorageForSandbox(sandboxBindingRef: string): void {
    const binding = getWorkerStorageBindingForSandbox(this.coreDb, { sandboxBindingRef });
    if (!binding || binding.state === 'unknown') return;
    markWorkerStorageAttachmentUnknown(this.coreDb, {
      attachmentGeneration: binding.attachmentGeneration,
      expectedRevision: binding.revision,
      storageRef: binding.storageRef,
    });
  }

  /** Reports capacity after preserving any retiring binding's proof, without runtime effects. */
  public inspectMaterializationCapacity(
    environmentPackage: AgentEnvironmentPackagePreview
  ): 'available' | 'capacity-saturated' {
    const eviction = this.inspectIncompatibleIdleSandbox(environmentPackage);
    if (eviction === 'capacity-saturated') return 'capacity-saturated';
    for (const binding of eviction?.bindings ?? []) {
      this.handoffDurableAgentSessionProof(binding);
    }
    return 'available';
  }

  /** Finds an idle replacement or a fenced predecessor resident proved absent in a fresh Epoch. */
  private inspectIncompatibleIdleSandbox(
    environmentPackage: AgentEnvironmentPackagePreview,
    forceRetirement = false
  ): NanoHostIdleSandboxEviction | 'capacity-saturated' | null {
    const desiredKey = nanoHostSandboxCompatibilityKey(environmentPackage);
    const runtimeTargetId = requireNanoHostRuntimeTargetId(this.planSession(environmentPackage));
    const sandboxes = this.coreDb.sqlite
      .prepare(
        `SELECT sandbox_runtime_id AS sandboxRuntimeId,
                sandbox_binding_ref AS sandboxBindingRef,
                sandbox_compatibility_key AS sandboxCompatibilityKey,
                origin_physical_epoch AS originPhysicalEpoch,
                lifecycle_state AS lifecycleState, health_state AS healthState,
                drain_state AS drainState, cleanup_state AS cleanupState
         FROM sandbox_runtime_records
         WHERE runtime_target_id = ?
         ORDER BY sandbox_runtime_id`
      )
      .all(runtimeTargetId) as Array<{
      readonly cleanupState: string;
      readonly drainState: string;
      readonly healthState: string;
      readonly lifecycleState: string;
      readonly originPhysicalEpoch: string;
      readonly sandboxBindingRef: string;
      readonly sandboxCompatibilityKey: string;
      readonly sandboxRuntimeId: string;
    }>;
    if (sandboxes.length === 0) {
      return null;
    }
    if (sandboxes.length !== 1) {
      return 'capacity-saturated';
    }
    const sandbox = sandboxes[0]!;
    const currentPhysicalEpoch = this.readCurrentPhysicalEpoch(runtimeTargetId);
    if (!currentPhysicalEpoch) return 'capacity-saturated';
    const sandboxOriginPhysicalEpoch = requireStoredNanoHostPhysicalEpoch(
      sandbox.originPhysicalEpoch
    );
    const physicalAbsent = sandboxOriginPhysicalEpoch !== currentPhysicalEpoch;
    const processLocalSandbox =
      !physicalAbsent &&
      this.sharedSandboxes.get(sandbox.sandboxCompatibilityKey)?.sandboxRuntimeId ===
        sandbox.sandboxRuntimeId;
    if (
      !physicalAbsent &&
      (sandbox.lifecycleState !== 'open' ||
        sandbox.healthState !== 'ready' ||
        sandbox.drainState !== 'accepting' ||
        sandbox.cleanupState !== 'clean')
    ) {
      return 'capacity-saturated';
    }
    const harnesses = this.coreDb.sqlite
      .prepare(
        `SELECT harness_instance_id AS harnessInstanceId,
                harness_binding_ref AS harnessBindingRef,
                lifecycle_state AS lifecycleState, drain_state AS drainState,
                active_turn_count AS activeTurnCount, operation_state AS operationState
         FROM harness_instance_records
         WHERE sandbox_runtime_id = ?
         ORDER BY harness_instance_id`
      )
      .all(sandbox.sandboxRuntimeId) as Array<{
      readonly activeTurnCount: number;
      readonly drainState: string;
      readonly harnessBindingRef: string;
      readonly harnessInstanceId: string;
      readonly lifecycleState: string;
      readonly operationState: string;
    }>;
    if (
      !physicalAbsent &&
      harnesses.some(
        (harness) => harness.lifecycleState !== 'open' || harness.drainState !== 'accepting'
      )
    ) {
      return 'capacity-saturated';
    }
    if (!forceRetirement && sandbox.sandboxCompatibilityKey === desiredKey && processLocalSandbox) {
      return null;
    }
    if (
      (!physicalAbsent &&
        [...this.sessions.values()].some(
          (session) => session.sharedHarness.sandbox.sandboxRuntimeId === sandbox.sandboxRuntimeId
        )) ||
      (harnesses.length === 0 && !physicalAbsent) ||
      harnesses.some(
        (harness) =>
          harness.activeTurnCount !== 0 ||
          (!physicalAbsent && !['idle', 'settled'].includes(harness.operationState))
      )
    ) {
      return 'capacity-saturated';
    }
    if (
      physicalAbsent &&
      this.coreDb.sqlite
        .prepare(
          `SELECT 1 FROM scheduler_session_leases
           WHERE sandbox_binding_ref = ? AND status NOT IN ('released', 'lost', 'failed')
           LIMIT 1`
        )
        .get(sandbox.sandboxBindingRef)
    ) {
      return 'capacity-saturated';
    }
    const bindings = this.coreDb.sqlite
      .prepare(
        `SELECT b.agent_session_id AS agentSessionId,
                b.agent_session_runtime_binding_id AS agentSessionRuntimeBindingId,
                b.harness_instance_id AS harnessInstanceId,
                h.harness_binding_ref AS harnessBindingRef,
                h.harness_compatibility_key AS harnessCompatibilityKey,
                b.lifecycle_state AS lifecycleState,
                b.current_turn_id AS currentTurnId,
                b.current_lease_id AS currentLeaseId,
                b.cleanup_state AS cleanupState,
                b.native_handle_state AS nativeHandleState,
                b.native_handle_digest AS nativeHandleDigest
         FROM agent_session_runtime_bindings b
         JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
         WHERE h.sandbox_runtime_id = ?
         ORDER BY b.agent_session_runtime_binding_id`
      )
      .all(sandbox.sandboxRuntimeId) as Array<{
      readonly agentSessionId: string;
      readonly agentSessionRuntimeBindingId: string;
      readonly cleanupState: string;
      readonly currentLeaseId: string | null;
      readonly currentTurnId: string | null;
      readonly harnessBindingRef: string;
      readonly harnessCompatibilityKey: string;
      readonly harnessInstanceId: string;
      readonly lifecycleState: string;
      readonly nativeHandleState: string;
      readonly nativeHandleDigest: string | null;
    }>;
    if (
      bindings.some(
        (binding) =>
          binding.currentTurnId !== null ||
          binding.currentLeaseId !== null ||
          (!physicalAbsent &&
            binding.lifecycleState !== 'closed' &&
            (binding.lifecycleState !== 'open' ||
              binding.cleanupState !== 'clean' ||
              this.agentSessionCloseOwners.has(binding.agentSessionRuntimeBindingId)))
      )
    ) {
      return 'capacity-saturated';
    }
    if (
      bindings.some((binding) =>
        this.coreDb.sqlite
          .prepare(
            `SELECT 1 FROM scheduler_session_leases
             WHERE agent_session_id = ?
               AND status NOT IN ('released', 'lost', 'failed')
             LIMIT 1`
          )
          .get(binding.agentSessionId)
      )
    ) {
      return 'capacity-saturated';
    }
    if (!forceRetirement && sandbox.sandboxCompatibilityKey === desiredKey && !physicalAbsent) {
      return null;
    }
    return {
      bindings: bindings.map((binding) => ({
        agentSessionId: binding.agentSessionId,
        agentSessionRuntimeBindingId: binding.agentSessionRuntimeBindingId,
        harnessBindingRef: binding.harnessBindingRef,
        harnessCompatibilityKey: binding.harnessCompatibilityKey,
        harnessInstanceId: binding.harnessInstanceId,
        lifecycleState: binding.lifecycleState,
        nativeHandleDigest:
          binding.nativeHandleState === 'ready' ? binding.nativeHandleDigest : null,
        reusable: false,
      })),
      bridgeOpen: this.sharedSandboxes.get(sandbox.sandboxCompatibilityKey)?.bridgeOpen ?? true,
      closeAgentSessions: processLocalSandbox && !forceRetirement,
      originPhysicalEpoch: sandboxOriginPhysicalEpoch,
      physicalAbsent,
      sandboxBindingRef: sandbox.sandboxBindingRef,
      sandboxCompatibilityKey: sandbox.sandboxCompatibilityKey,
      sandboxId: nanoHostSandboxId(sandbox.sandboxCompatibilityKey),
      sandboxRuntimeId: sandbox.sandboxRuntimeId,
    };
  }

  /** Claims and retires one idle or physically absent resident after replacement dispatch. */
  private async evictIncompatibleIdleSandbox(
    environmentPackage: AgentEnvironmentPackagePreview,
    identity: WorkerGovernanceBackendSessionIdentity,
    leaseId: string,
    forceRetirement = false,
    replacementSelection?: Omit<WorkerStorageSelectionInput, 'layout'> & {
      readonly reuseWorkSlotRef?: string;
    }
  ): Promise<WorkerStorageBinding | null> {
    this.coreDb.sqlite.exec('BEGIN IMMEDIATE');
    let eviction: NanoHostIdleSandboxEviction | null = null;
    let authorizedReplacementBinding: WorkerStorageBinding | null = null;
    try {
      const inspected = this.inspectIncompatibleIdleSandbox(environmentPackage, forceRetirement);
      if (inspected === 'capacity-saturated') {
        throw new Error('NanoHost one-Sandbox capacity is occupied or unproved.');
      }
      eviction = inspected;
      if (eviction) {
        if (replacementSelection) {
          const selectedBinding = this.validateWorkerStorageSelection(
            environmentPackage,
            eviction.sandboxBindingRef,
            replacementSelection
          );
          if (selectedBinding.currentSandboxBindingRef === eviction.sandboxBindingRef) {
            authorizedReplacementBinding = selectedBinding;
          }
        }
        // Every row removed by whole-Sandbox retirement must settle proof before drain.
        for (const binding of eviction.bindings) {
          this.handoffDurableAgentSessionProof(binding);
        }
        const timestamp = new Date().toISOString();
        const physicalAbsentFlag = Number(eviction.physicalAbsent);
        const sandboxUpdate = this.coreDb.sqlite
          .prepare(
            `UPDATE sandbox_runtime_records
             SET drain_state = 'draining', updated_at = ?
             WHERE sandbox_runtime_id = ?
               AND (? = 1 OR (lifecycle_state = 'open' AND health_state = 'ready'
                     AND drain_state = 'accepting' AND cleanup_state = 'clean'))`
          )
          .run(timestamp, eviction.sandboxRuntimeId, physicalAbsentFlag);
        const harnessUpdate = this.coreDb.sqlite
          .prepare(
            `UPDATE harness_instance_records
             SET drain_state = 'draining', updated_at = ?
             WHERE sandbox_runtime_id = ? AND active_turn_count = 0
               AND (
                 operation_state IN ('idle', 'settled')
                 OR ? = 1
               )
               AND (? = 1 OR (lifecycle_state = 'open' AND drain_state = 'accepting'))`
          )
          .run(timestamp, eviction.sandboxRuntimeId, physicalAbsentFlag, physicalAbsentFlag);
        if (
          sandboxUpdate.changes !== 1 ||
          (!eviction.physicalAbsent && harnessUpdate.changes < 1)
        ) {
          throw new Error('NanoHost idle Sandbox eviction changed before drain claim.');
        }
      }
      this.coreDb.sqlite.exec('COMMIT');
    } catch (error) {
      this.coreDb.sqlite.exec('ROLLBACK');
      throw error;
    }
    if (!eviction) {
      return null;
    }
    try {
      if (eviction.physicalAbsent) {
        await this.invalidatePhysicallyAbsentSandbox(eviction);
      }
      if (eviction.closeAgentSessions) {
        for (const binding of eviction.bindings) {
          if (binding.lifecycleState === 'closed') continue;
          try {
            await this.closeDurableAgentSession(binding);
          } catch (error) {
            if (!isCleanupRequiredRefusal(error)) throw error;
            // Admission is drained; whole-Sandbox deletion also retires the remaining bindings.
            break;
          }
          for (const sharedHarness of this.sharedHarnesses.values()) {
            if (sharedHarness.harnessInstanceId === binding.harnessInstanceId) {
              sharedHarness.bindings.delete(binding.agentSessionId);
            }
          }
        }
      }
      if (!eviction.physicalAbsent) {
        await this.deleteSandbox(
          identity,
          { leaseId, sandboxId: eviction.sandboxId },
          eviction.bridgeOpen,
          eviction.originPhysicalEpoch
        );
      }
      const releasedBinding = this.releaseWorkerStorageForSandbox(eviction.sandboxBindingRef);
      removeNanoHostSandboxRuntimeByBinding(this.coreDb, eviction.sandboxBindingRef);
      this.forgetSharedSandbox(eviction.sandboxCompatibilityKey);
      return authorizedReplacementBinding &&
        releasedBinding &&
        releasedBinding.storageRef === authorizedReplacementBinding.storageRef &&
        releasedBinding.attachmentGeneration ===
          authorizedReplacementBinding.attachmentGeneration &&
        releasedBinding.revision === authorizedReplacementBinding.revision + 1
        ? releasedBinding
        : null;
    } catch (error) {
      fenceNanoHostSandboxRuntime(this.coreDb, {
        sandboxBindingRef: eviction.sandboxBindingRef,
        timestamp: new Date().toISOString(),
      });
      this.fenceWorkerStorageForSandbox(eviction.sandboxBindingRef);
      this.forgetSharedSandbox(eviction.sandboxCompatibilityKey);
      throw error;
    }
  }

  /** Settles old commands as unknown and rejects waiters after fresh Epoch absence proof. */
  private async invalidatePhysicallyAbsentSandbox(
    eviction: NanoHostIdleSandboxEviction
  ): Promise<void> {
    // Absence proves cleanup, not the outcome of an old command; preserve truthful uncertainty.
    const operations = this.coreDb.sqlite
      .prepare(
        `SELECT harness_binding_ref AS harnessBindingRef, operation_state AS operationState,
                operation_id AS operationId
         FROM harness_instance_records WHERE sandbox_runtime_id = ?`
      )
      .all(eviction.sandboxRuntimeId) as Array<{
      readonly harnessBindingRef: string;
      readonly operationId: string | null;
      readonly operationState: string;
    }>;
    const timestamp = new Date().toISOString();
    for (const operation of operations) {
      if (operation.operationState === 'queued') {
        expireNanoHostHarnessQueuedOperation(this.coreDb, {
          harnessBindingRef: operation.harnessBindingRef,
          timestamp,
        });
      } else if (operation.operationState === 'dispatched') {
        markNanoHostHarnessOperationUnknown(this.coreDb, {
          harnessBindingRef: operation.harnessBindingRef,
          operationId: operation.operationId!,
          timestamp,
        });
      }
    }
    const error = new Error('NanoHost physical Sandbox belongs to a fenced predecessor Epoch.');
    for (const [snapshotId, session] of this.sessions) {
      if (session.sharedHarness.sandbox.sandboxRuntimeId !== eviction.sandboxRuntimeId) continue;
      session.nativeSessionReusable = false;
      if (session.pendingHarnessOperation) {
        if (session.pendingHarnessOperation.timeout) {
          clearTimeout(session.pendingHarnessOperation.timeout);
        }
        session.pendingHarnessOperation.reject(error);
        session.pendingHarnessOperation = null;
      }
      for (const stagingPath of session.retainedStagingPaths) {
        await removeNanoHostStagedExport(stagingPath).catch(() => undefined);
      }
      this.workerControlGateway?.unregisterSession(snapshotId);
      this.sessions.delete(snapshotId);
    }
    for (const binding of eviction.bindings) {
      const closeOwner = this.agentSessionCloseOwners.get(binding.agentSessionRuntimeBindingId);
      if (!closeOwner) continue;
      if (closeOwner.pending?.timeout) clearTimeout(closeOwner.pending.timeout);
      closeOwner.pending?.reject(error);
      closeOwner.pending = null;
      this.agentSessionCloseOwners.delete(binding.agentSessionRuntimeBindingId);
    }
  }

  /** Acquires or builds the immutable image and creates the exact NanoHost sandbox. */
  public async materialize(
    environmentPackage: AgentEnvironmentPackage,
    context: WorkerGovernanceMaterializationContext = { workspaceRoots: [] }
  ): Promise<WorkerGovernanceMaterializationRecord> {
    const identity = this.planSession(environmentPackage);
    this.failedPreSandboxPreparations.delete(identity.packageSnapshotId);
    const leaseId = this.requireLeaseId(environmentPackage.snapshotId);
    const image = environmentPackage.runtime.image;
    const sandboxCompatibilityKey = nanoHostSandboxCompatibilityKey(environmentPackage);
    const harnessCompatibilityKey = nanoHostHarnessCompatibilityKey(environmentPackage);
    const adapterId = nanoHostAdapterId(environmentPackage);
    const adapterVersion = environmentPackage.agent.runtimeVersion;
    const agentSessionCompatibilityKey = nanoHostAgentSessionCompatibilityKey(environmentPackage);
    if ((context.providerCredentials?.length ?? 0) > 0) {
      throw new Error('NanoHost Provider credential materialization is not supported.');
    }
    const runtimeEnvironment = nanoHostRuntimeEnvironment(context.runtimeEnvCredentials ?? []);
    const runtimeCredentialImports = nanoHostRuntimeCredentialImports(
      context.runtimeFileCredentials ?? []
    );
    const responsibleUserId = responsibleUserIdForActor(environmentPackage.scope.triggerActor);
    if (!responsibleUserId) {
      throw new Error('Worker storage requires one responsible user.');
    }
    const choice = context.workerStorageChoice;
    const authorizeContributor = currentWorkerStorageAudienceAuthorizer(
      this.coreDb,
      environmentPackage
    );
    const replacementSelection = this.workerStorageReplacementSelection(
      environmentPackage,
      choice,
      responsibleUserId,
      authorizeContributor
    );
    if (
      image.kind === 'build' &&
      (image.contextRef !== EMPTY_BUILD_CONTEXT_REF ||
        image.contextDigest !== EMPTY_BUILD_CONTEXT_DIGEST)
    ) {
      throw new Error('NanoHost image build requires the exact V1 empty build-context pair.');
    }
    const originPhysicalEpoch = this.requireCurrentBackendPhysicalEpoch(identity);
    if (this.inspectIncompatibleIdleSandbox(environmentPackage) === 'capacity-saturated') {
      throw new Error('NanoHost one-Sandbox capacity is occupied or unproved.');
    }
    let releasedSelectedBinding: WorkerStorageBinding | null;
    try {
      releasedSelectedBinding = await this.evictIncompatibleIdleSandbox(
        environmentPackage,
        identity,
        leaseId,
        false,
        replacementSelection
      );
    } catch (error) {
      // Eviction owns the resident's fence; this incoming attempt created no Sandbox or bridge.
      this.failedPreSandboxPreparations.add(identity.packageSnapshotId);
      throw error;
    }
    let sharedHarness = this.restoreSharedHarness(
      sandboxCompatibilityKey,
      harnessCompatibilityKey,
      requireNanoHostRuntimeTargetId(identity),
      adapterId,
      adapterVersion
    );
    const evidence: WorkerGovernanceEvidenceRecord[] = [];
    let sharedSandbox =
      sharedHarness?.sandbox ??
      this.restoreSharedSandbox(sandboxCompatibilityKey, requireNanoHostRuntimeTargetId(identity));
    const priorSlotBinding =
      choice?.kind === 'fresh'
        ? undefined
        : choice?.kind === 'selected'
          ? getWorkerStorageBinding(this.coreDb, { storageRef: choice.storageRef })
          : sharedSandbox?.workerStorageBinding;
    const initializesNewSlot = !priorSlotBinding?.contributors.some(
      (contributor) =>
        contributor.workSlotRef === packageWorkerStorageWorkSlotRef(environmentPackage)
    );
    const existingContributor = sharedSandbox?.workerStorageBinding.contributors.some(
      (contributor) =>
        contributor.threadId === environmentPackage.scope.threadId &&
        contributor.responsibleUserId === responsibleUserId
    );
    const plannedWorkSlotRef = packageWorkerStorageWorkSlotRef(environmentPackage);
    let replaceSharedSandbox =
      choice?.kind === 'fresh' ||
      (choice?.kind === 'selected'
        ? choice.storageRef !== sharedSandbox?.workerStorageBinding.storageRef
        : !existingContributor);
    if (
      sharedSandbox &&
      choice?.kind === 'selected' &&
      !replaceSharedSandbox &&
      replacementSelection
    ) {
      const selectedBinding = this.validateWorkerStorageSelection(
        environmentPackage,
        sharedSandbox.sandboxBindingRef,
        replacementSelection
      );
      const selectedWorkSlotRef = resolveWorkerStorageWorkSlotRef(
        selectedBinding,
        replacementSelection
      );
      replaceSharedSandbox =
        selectedWorkSlotRef !==
        resolveWorkerStorageWorkSlotRef(selectedBinding, {
          responsibleUserId,
          threadId: environmentPackage.scope.threadId,
        });
      if (!replaceSharedSandbox) {
        sharedSandbox.workerStorageBinding = admitWorkerStorageContributor(this.coreDb, {
          ...replacementSelection,
          layout: sharedSandbox.workerStorageBinding.layout,
        });
      }
    } else if (sharedSandbox && !choice && existingContributor) {
      const residentWorkSlotRef = requireWorkerStorageWorkSlot(
        sharedSandbox.workerStorageBinding,
        environmentPackage.scope.threadId,
        responsibleUserId
      );
      if (plannedWorkSlotRef !== residentWorkSlotRef) {
        throw new Error('Worker storage work slot changed after package planning.');
      }
    }
    if (sharedSandbox && replaceSharedSandbox) {
      releasedSelectedBinding = await this.evictIncompatibleIdleSandbox(
        environmentPackage,
        identity,
        leaseId,
        true,
        replacementSelection
      );
      sharedHarness = null;
      sharedSandbox = null;
    }
    if (!sharedSandbox) {
      const localImageDigest =
        environmentPackage.runtime.environment?.imageDigest ??
        (image.kind === 'reference' &&
        image.pullPolicy === 'never' &&
        /^sha256:[0-9a-f]{64}$/.test(image.ref)
          ? image.ref
          : null);
      let imageResult: Record<string, unknown>;
      let imageDigest: string;
      let imageInspection: ReturnType<typeof parseNanoHostImageInspection>;
      try {
        imageResult = environmentPackage.runtime.environment
          ? await this.effect(identity, leaseId, 'image.acquire', {
              imageReference: environmentPackage.runtime.environment.imageDigest,
            })
          : image.kind === 'reference'
            ? await this.effect(identity, leaseId, 'image.acquire', {
                imageReference: image.ref,
              })
            : await this.effect(identity, leaseId, 'image.build', {
                arguments: image.arguments,
                argumentsDigest: image.argumentsDigest,
                contextDigest: image.contextDigest,
                contextRef: image.contextRef,
                dockerfile: image.input.content,
                dockerfileDigest: image.input.digest,
                egress: image.egress,
                layerLimit: image.layerLimit,
                outputLimitBytes: image.outputLimitBytes,
                timeLimitSeconds: image.timeLimitSeconds,
              });
        imageDigest = requireNanoHostResultString(imageResult, 'digest');
        if (localImageDigest !== null && imageDigest !== localImageDigest) {
          throw new Error('NanoHost local image acquisition returned a different digest.');
        }
        imageInspection = parseNanoHostImageInspection(
          await this.effect(identity, leaseId, 'image.inspect', { imageDigest })
        );
        if (
          imageInspection.imageDigest !== imageDigest ||
          (environmentPackage.runtime.environment &&
            imageInspection.environmentDefaults?.defaultsDigest !==
              environmentPackage.runtime.environment.defaultsDigest)
        ) {
          throw new Error('NanoHost image inspection returned a different digest.');
        }
      } catch (error) {
        this.failedPreSandboxPreparations.add(identity.packageSnapshotId);
        throw error;
      }
      let storageBinding: WorkerStorageBinding;
      try {
        storageBinding = this.coreDb.sqlite.transaction(() =>
          choice?.kind === 'selected'
            ? reserveWorkerStorageAttachment(this.coreDb, {
                ...(choice.adjudicatedThreadIds
                  ? { adjudicatedThreadIds: choice.adjudicatedThreadIds }
                  : {}),
                agentSessionId: environmentPackage.scope.agentSessionId,
                authorizeContributor,
                expectedRevision:
                  releasedSelectedBinding?.storageRef === choice.storageRef &&
                  releasedSelectedBinding.revision === choice.expectedRevision + 1
                    ? releasedSelectedBinding.revision
                    : choice.expectedRevision,
                ...(choice.goalId === undefined ? {} : { goalId: choice.goalId }),
                layout: imageInspection.layout,
                purpose: choice.purpose,
                responsibleUserId,
                ...(choice.reuseWorkSlotRef ? { reuseWorkSlotRef: choice.reuseWorkSlotRef } : {}),
                runtimeTargetId: requireNanoHostRuntimeTargetId(identity),
                storageRef: choice.storageRef,
                ...(choice.taskId === undefined ? {} : { taskId: choice.taskId }),
                threadId: environmentPackage.scope.threadId,
                workspaceId: environmentPackage.scope.workspaceId,
              })
            : reserveWorkerStorageAttachment(this.coreDb, {
                agentSessionId: environmentPackage.scope.agentSessionId,
                authorizeContributor,
                expectedRevision: 1,
                ...(choice?.kind === 'fresh' ? { goalId: choice.goalId } : {}),
                layout: imageInspection.layout,
                purpose: 'work',
                responsibleUserId,
                runtimeTargetId: requireNanoHostRuntimeTargetId(identity),
                storageRef: createWorkerStorageBinding(this.coreDb, {
                  deploymentId: identity.deploymentId,
                  layout: imageInspection.layout,
                  runtimeTargetId: requireNanoHostRuntimeTargetId(identity),
                  workspaceId: environmentPackage.scope.workspaceId,
                }).storageRef,
                ...(choice?.kind === 'fresh' ? { taskId: choice.taskId } : {}),
                threadId: environmentPackage.scope.threadId,
                workspaceId: environmentPackage.scope.workspaceId,
              })
        )();
      } catch (error) {
        this.failedPreSandboxPreparations.add(identity.packageSnapshotId);
        throw error;
      }
      const sandboxId = nanoHostSandboxId(sandboxCompatibilityKey);
      let sandboxResult: Record<string, unknown>;
      try {
        sandboxResult = await this.effect(identity, leaseId, 'sandbox.create', {
          environment: {},
          imageDigest,
          leaseId,
          policy: projectOpenShellWorkerPolicy({
            additionalFilesystemGrants:
              openShellFilesystemGrantsFromPackagePolicy(environmentPackage),
            additionalNetworkEndpoints:
              openShellNetworkEndpointsFromPackagePolicy(environmentPackage),
          }),
          sandboxId,
          storage: {
            attachmentGeneration: storageBinding.attachmentGeneration,
            layoutDigest: storageBinding.layoutDigest,
            scopeDigest: storageBinding.scopeDigest,
            storageRef: storageBinding.storageRef,
            targets: storageBinding.targets
              .filter(({ active }) => active)
              .map(({ target, volumeRef }) => ({ target, volumeRef })),
          },
        });
      } catch (error) {
        markWorkerStorageAttachmentUnknown(this.coreDb, {
          attachmentGeneration: storageBinding.attachmentGeneration,
          expectedRevision: storageBinding.revision,
          storageRef: storageBinding.storageRef,
        });
        throw error;
      }
      this.livePartialMaterializations.set(identity.packageSnapshotId, {
        attachmentGeneration: storageBinding.attachmentGeneration,
        deleteDispatched: false,
        expectedRevision: storageBinding.revision,
        leaseId,
        originPhysicalEpoch,
        sandboxId,
        storageRef: storageBinding.storageRef,
      });
      requireNanoHostResultString(sandboxResult, 'sandboxId');
      this.requireCurrentBackendPhysicalEpoch(identity, originPhysicalEpoch);
      const attachedStorage = activateWorkerStorageAttachment(this.coreDb, {
        attachmentGeneration: storageBinding.attachmentGeneration,
        expectedRevision: storageBinding.revision,
        sandboxBindingRef:
          context.sandboxBindingRef ?? `sandbox-binding-${sandboxCompatibilityKey.slice(0, 24)}`,
        storageRef: storageBinding.storageRef,
        targets: requireNanoHostSandboxStorageProof(sandboxResult, storageBinding),
      });
      const sandboxIdentity = sandboxCompatibilityKey.slice(0, 24);
      sharedSandbox = {
        bridgeOpen: false,
        imageDigest,
        originPhysicalEpoch,
        runtimeTargetId: requireNanoHostRuntimeTargetId(identity),
        sandboxBindingRef:
          context.sandboxBindingRef ?? `sandbox-binding-${sandboxCompatibilityKey.slice(0, 24)}`,
        sandboxId,
        sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: `integration-binding-${sandboxIdentity}`,
        sandboxRuntimeId: `sandbox-runtime-${sandboxIdentity}`,
        workerStorageBinding: attachedStorage,
      };
      evidence.push(
        nanoHostEffectEvidence(environmentPackage.createdAt, imageResult, 'image'),
        nanoHostEffectEvidence(environmentPackage.createdAt, sandboxResult, 'sandbox')
      );
    }
    if (!sharedHarness) {
      const harnessIdentity = createHash('sha256')
        .update(`${sandboxCompatibilityKey}\0${harnessCompatibilityKey}`)
        .digest('hex')
        .slice(0, 24);
      sharedHarness = {
        adapterId,
        adapterVersion,
        bindings: new Map(),
        harnessBindingRef: `harness-binding-${harnessIdentity}`,
        harnessCompatibilityKey,
        harnessInstanceId: `harness-${harnessIdentity}`,
        sandbox: sharedSandbox,
      };
    }
    const privateIdentity = createHash('sha256')
      .update(`${sharedHarness.harnessInstanceId}\0${environmentPackage.scope.agentSessionId}`)
      .digest('hex')
      .slice(0, 24);
    const agentSessionRuntimeBindingId = `session-binding-${privateIdentity}`;
    const existingBinding = sharedHarness.bindings.get(environmentPackage.scope.agentSessionId);
    if (
      existingBinding &&
      (existingBinding.agentSessionCompatibilityKey !== agentSessionCompatibilityKey ||
        existingBinding.agentSessionRuntimeBindingId !== agentSessionRuntimeBindingId)
    ) {
      throw new Error('NanoHost AgentSession is incompatible with its retained native binding.');
    }
    this.sessions.set(environmentPackage.snapshotId, {
      environmentPackage,
      evidence,
      agentSessionCompatibilityKey,
      agentSessionRuntimeBindingId,
      harnessBindingRef: sharedHarness.harnessBindingRef,
      harnessInstanceId: sharedHarness.harnessInstanceId,
      identity,
      leaseId,
      nativeResume: context.nativeResume ?? null,
      nativeSessionReusable: false,
      recordNativeHandleDigest: null,
      pendingImports: [],
      runtimeEnvironment,
      runtimeCheckVersions: (context.runtimeEnvCredentials ?? []).every(
        (item) =>
          item.vaultReferenceId &&
          Number.isSafeInteger(item.materialVersion) &&
          item.materialVersion! > 0
      )
        ? (context.runtimeEnvCredentials ?? []).map((item) => ({
            targetEnvVarName: item.targetEnvVarName,
            vaultReferenceId: item.vaultReferenceId!,
            materialVersion: item.materialVersion!,
          }))
        : null,
      pendingHarnessOperation: null,
      turnStopSettlement: null,
      retainedStagingPaths: [],
      sharedHarness,
      terminalInspectionComplete: false,
      turnStarted: false,
    });
    if (initializesNewSlot) {
      const initializationDb = openWorkspaceDb(
        this.coreDb.dataRoot,
        environmentPackage.scope.workspaceId
      );
      try {
        applyScopedMigrations(initializationDb);
        authorizeWorkspaceBaselineInitialization(
          initializationDb,
          this.workspaceCollectionIdentity(
            this.requireSession(environmentPackage.snapshotId),
            'baseline'
          )
        );
      } finally {
        initializationDb.sqlite.close();
      }
    }
    this.livePartialMaterializations.delete(identity.packageSnapshotId);
    this.requireSession(environmentPackage.snapshotId).pendingImports = [
      ...(await prepareNanoHostContextPackageImports(environmentPackage, context)),
      ...runtimeCredentialImports,
    ];
    const harnessMapKey = nanoHostSharedHarnessMapKey(
      sandboxCompatibilityKey,
      harnessCompatibilityKey
    );
    if (!this.sharedHarnesses.has(harnessMapKey)) {
      createNanoHostHarnessRuntime(this.coreDb, {
        adapterId,
        adapterVersion,
        harnessBindingRef: sharedHarness.harnessBindingRef,
        harnessCompatibilityKey,
        harnessInstanceId: sharedHarness.harnessInstanceId,
        imageDigest: sharedSandbox.imageDigest,
        originPhysicalEpoch: sharedSandbox.originPhysicalEpoch,
        sandboxBindingRef: sharedSandbox.sandboxBindingRef,
        sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: sharedSandbox.sandboxIntegrationBindingRef,
        sandboxRuntimeId: sharedSandbox.sandboxRuntimeId,
        runtimeTargetId: requireNanoHostRuntimeTargetId(identity),
        timestamp: environmentPackage.createdAt,
      });
      this.sharedSandboxes.set(sandboxCompatibilityKey, sharedSandbox);
      this.sharedHarnesses.set(harnessMapKey, sharedHarness);
    }
    if (existingBinding) {
      copyNanoHostMeasuredHarnessIdentity(this.coreDb, {
        agentSessionRuntimeBindingId: existingBinding.agentSessionRuntimeBindingId,
        imageDigest: sharedSandbox.imageDigest,
        timestamp: environmentPackage.createdAt,
      });
    }
    const cursorDb = openWorkspaceDb(this.coreDb.dataRoot, environmentPackage.scope.workspaceId);
    let workspaceBaseCommits: Record<string, string> | undefined;
    try {
      applyScopedMigrations(cursorDb);
      const cursor = readWorkspaceSnapshotCursor(
        cursorDb,
        this.workspaceCollectionIdentity(
          this.requireSession(environmentPackage.snapshotId),
          'materialize'
        )
      );
      if (cursor) {
        const initial = readWorkspaceBaselineIdentity(
          cursorDb,
          this.workspaceCollectionIdentity(
            this.requireSession(environmentPackage.snapshotId),
            'materialize'
          )
        );
        if (!initial)
          throw new WorkspaceCollectionError({
            outcome: 'recovery_required',
            cause: 'accepted_base_unknown',
          });
        const initialPackage = requireAgentEnvironmentPackageSnapshot(
          cursorDb,
          initial.workspaceId,
          initial.packageSnapshotId
        ).snapshot;
        const sourceIdentity = (aep: AgentEnvironmentPackage) =>
          aep.workspace.inputs
            .filter((input) => input.access === 'read-write')
            .map((input) => ({
              id: input.id,
              sourceId: input.source.sourceId,
              kind: input.source.kind,
              ...(input.source.kind === 'git'
                ? { url: input.source.url, commit: input.source.commit }
                : {}),
            }));
        if (!isDeepStrictEqual(sourceIdentity(initialPackage), sourceIdentity(environmentPackage)))
          throw new Error(
            'Workspace retained source/baseline conflicts; explicit reconciliation is required.'
          );
      }

      if (cursor?.acceptedCommit)
        workspaceBaseCommits = Object.fromEntries(
          environmentPackage.workspace.inputs
            .filter((input) => input.access === 'read-write' && input.source.kind === 'git')
            .map((input) => [input.id, cursor.acceptedCommit!])
        );
    } finally {
      cursorDb.sqlite.close();
    }
    return {
      ...(workspaceBaseCommits ? { workspaceBaseCommits } : {}),
      retainedStorage: {
        storageRef: sharedSandbox.workerStorageBinding.storageRef,
        workSlotRef: plannedWorkSlotRef,
      },
      backendKind: 'openshell',
      command: {
        argv: [...environmentPackage.runtime.command.argv],
        workingDirectory: environmentPackage.runtime.command.workingDirectory,
      },
      controlMode: environmentPackage.control.mode,
      packageId: environmentPackage.packageId,
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities: [...environmentPackage.backend.requiredCapabilities],
      sandbox: {
        name: identity.backendSessionId,
        source: sharedSandbox.imageDigest,
        state: 'created',
      },
      workspaceInputs: environmentPackage.workspace.inputs.map((workspaceInput) => ({
        access: workspaceInput.access,
        id: workspaceInput.id,
        kind: workspaceInput.kind,
        target: workspaceInput.target,
      })),
    };
  }

  /** Opens or inspects the exact Session, imports its Turn inputs, then starts the child. */
  public async launch(
    materialization: WorkerGovernanceMaterializationRecord
  ): Promise<WorkerGovernanceEvidenceRecord> {
    const session = this.requireSession(materialization.packageSnapshotId);
    const result = session.sharedHarness.sandbox.bridgeOpen
      ? { accepted: true, integrationReady: true, state: 'open' }
      : await this.effect(session.identity, session.leaseId, 'bridge.open', {
          sandboxIntegrationBindingRef: session.sharedHarness.sandbox.sandboxIntegrationBindingRef,
        });
    if (result.accepted !== true || result.integrationReady !== true || result.state !== 'open') {
      throw new Error('NanoHost bridge did not prove its Sandbox Integration readiness latch.');
    }
    session.sharedHarness.sandbox.bridgeOpen = true;
    const pendingImports = session.pendingImports;
    session.pendingImports = [];
    for (const file of pendingImports) {
      const imported = await this.effect(session.identity, session.leaseId, 'reference.import', {
        body: file.body,
        byteLength: file.byteLength,
        relativePath: file.relativePath,
        sandboxId: session.sharedHarness.sandbox.sandboxId,
        sha256: file.contentDigest,
        slot: file.slot,
      });
      session.evidence.push(
        nanoHostEffectEvidence(session.environmentPackage.createdAt, imported, 'reference-import')
      );
    }
    let binding = session.sharedHarness.bindings.get(
      session.environmentPackage.scope.agentSessionId
    );
    const opensNewBinding = !binding;
    let workspaceGitBaseline: unknown;
    if (!binding) {
      // A resumed open must accept a ready proof, so the recorder is required before that dispatch; a new conversation may stay pending and is checked only once a ready digest is accepted.
      if (session.nativeResume !== null && !session.recordNativeHandleDigest) {
        throw new Error(
          'NanoHost session.open requires its AgentSession recorder before dispatch.'
        );
      }
      openNanoHostAgentSessionBinding(this.coreDb, {
        nativeEnvironment: session.environmentPackage.runtime.environment
          ? {
              agentId: session.environmentPackage.agent.agentId,
              ...session.environmentPackage.runtime.environment,
            }
          : undefined,
        agentSessionCompatibilityKey: session.agentSessionCompatibilityKey,
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
        effectiveSetupGeneration: 1,
        harnessInstanceId: session.harnessInstanceId,
        threadId: session.environmentPackage.scope.threadId,
        timestamp: new Date().toISOString(),
        workspaceId: session.environmentPackage.scope.workspaceId,
      });
      this.coreDb.sqlite
        .prepare(
          'UPDATE agent_session_runtime_bindings SET runtime_env_check_versions_json = ? WHERE agent_session_runtime_binding_id = ?'
        )
        .run(
          session.runtimeCheckVersions === null
            ? null
            : JSON.stringify(session.runtimeCheckVersions),
          session.agentSessionRuntimeBindingId
        );
      const opened = await this.queueAndWaitForHarnessOperation(session, 'session.open', {
        adapterId: session.sharedHarness.adapterId,
        nativeEnvironment: session.environmentPackage.runtime.environment?.values,
        agentSessionCompatibilityKey: session.agentSessionCompatibilityKey,
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
        effectiveSetupGeneration: 1,
        resume: session.nativeResume,
        threadId: session.environmentPackage.scope.threadId,
        workspaceId: session.environmentPackage.scope.workspaceId,
      });
      // A resumed conversation proves the predecessor's exact handle at open; a new one may stay
      // pending until its first Turn creates the conversation.
      const openedReady =
        opened.nativeHandleState === 'ready' &&
        typeof opened.nativeHandleDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(opened.nativeHandleDigest);
      if (
        opened.state !== 'open' ||
        opened.maxActiveTurns !== 1 ||
        !(
          openedReady ||
          (opened.nativeHandleState === 'pending' && opened.nativeHandleDigest === null)
        ) ||
        (session.nativeResume !== null &&
          (!openedReady || opened.nativeHandleDigest !== session.nativeResume.digest))
      ) {
        throw new Error('NanoHost Harness session.open result is incompatible.');
      }
      workspaceGitBaseline = opened.workspaceGitBaseline;
      binding = {
        agentSessionCompatibilityKey: session.agentSessionCompatibilityKey,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
        nativeHandleDigest: openedReady ? (opened.nativeHandleDigest as string) : null,
        nextTurnSequence: 0,
        runtimeEnvironment: session.runtimeEnvironment,
      };
      session.sharedHarness.bindings.set(session.environmentPackage.scope.agentSessionId, binding);
      if (binding.nativeHandleDigest !== null) {
        this.recordAcceptedNativeHandleDigest(session, binding.nativeHandleDigest);
      }
    } else {
      copyNanoHostMeasuredHarnessIdentity(this.coreDb, {
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
        imageDigest: session.sharedHarness.sandbox.imageDigest,
        timestamp: new Date().toISOString(),
      });
      // The resident host fixed its environment at open; resolve its recorded versions for collection.
      session.runtimeEnvironment =
        binding.runtimeEnvironment ?? this.restoreCollectionRuntimeEnvironment(session);
      binding.runtimeEnvironment = session.runtimeEnvironment;
      const inspected = await this.queueAndWaitForHarnessOperation(session, 'session.inspect', {
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      });
      if (
        inspected.state !== 'open' ||
        inspected.cleanupState !== 'clean' ||
        inspected.nativeHandleState !== 'ready' ||
        inspected.nativeHandleDigest !== binding.nativeHandleDigest
      ) {
        throw new Error('NanoHost resident AgentSession is not ready for its next Turn.');
      }
    }
    await this.ensureWorkspaceBaseline(session, opensNewBinding, workspaceGitBaseline);
    const inputPaths = workerSessionInputPaths(session.environmentPackage.scope.agentSessionId);
    const lease = this.coreDb.sqlite
      .prepare(
        'SELECT startup_deadline AS startupDeadline FROM scheduler_session_leases WHERE lease_id = ?'
      )
      .get(session.leaseId) as { readonly startupDeadline: string } | undefined;
    if (!lease) {
      throw new Error('NanoHost Harness Turn startup deadline is unavailable.');
    }
    const started = await this.queueAndWaitForHarnessOperation(session, 'turn.start', {
      aepRef: inputPaths.packagePath,
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      contextPackageId: `ctxpkg_${session.environmentPackage.scope.turnId}`,
      contextRef: inputPaths.contextRoot,
      deadline: lease.startupDeadline,
      leaseId: session.leaseId,
      packageSnapshotId: session.environmentPackage.snapshotId,
      threadId: session.environmentPackage.scope.threadId,
      turnId: session.environmentPackage.scope.turnId,
      turnSequence: binding.nextTurnSequence,
      workspaceId: session.environmentPackage.scope.workspaceId,
    });
    if (
      started.state !== 'started' ||
      started.nativeHandleState !== (binding.nativeHandleDigest ? 'ready' : 'pending') ||
      started.nativeHandleDigest !== binding.nativeHandleDigest
    ) {
      throw new Error('NanoHost Harness turn.start result is incompatible.');
    }
    binding.nextTurnSequence += 1;
    session.turnStarted = true;
    const evidence = nanoHostEffectEvidence(session.environmentPackage.createdAt, result, 'bridge');
    session.evidence.push(evidence);
    return evidence;
  }

  /**
   * Delivers one interrupt through private `turn.interrupt`, the sole interrupt owner. The
   * cancelled Turn leaves the resident binding open; host liveness is not the cancel proof.
   */
  public async interruptTurn(packageSnapshotId: string): Promise<void> {
    const session = this.requireSession(packageSnapshotId);
    const settlement = this.queueAndWaitForHarnessOperation(session, 'turn.interrupt', {
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      leaseId: session.leaseId,
      purpose: 'interrupt',
      turnId: session.environmentPackage.scope.turnId,
    }).then((result) => {
      if (result.state !== 'interrupted') {
        throw new Error('NanoHost Harness turn.interrupt result is incompatible.');
      }
    });
    session.turnStopSettlement = settlement;
    await settlement;
  }

  /**
   * Binds the AgentSession recorder for one live or restored Turn and hands it any ready proof
   * the binding already holds, including one accepted before a NanoCore restart. Restored handoff
   * uses the shared recorder boundary, so a throw keeps that proof's binding row.
   */
  public bindNativeHandleRecorder(
    packageSnapshotId: string,
    record: (digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => void
  ): void {
    const session = this.requireSession(packageSnapshotId);
    session.recordNativeHandleDigest = record;
    const digest = session.sharedHarness.bindings.get(
      session.environmentPackage.scope.agentSessionId
    )?.nativeHandleDigest;
    if (digest) {
      this.recordAcceptedNativeHandleDigest(session, digest);
    }
  }

  /**
   * Hands one ready proof NanoCore just accepted to the AgentSession owner, which keeps it after
   * the binding row closes. The proof is marked unrecorded before the recorder runs and cleared
   * only after that exact digest is handed off, so a throw keeps the binding, the admission fence,
   * and cleanup ownership. The SQLite binding commit precedes this synchronous write, so a crash
   * between them leaves the proof on the binding row for the restart recorder bind to record.
   */
  private recordAcceptedNativeHandleDigest(
    session: NanoHostBackendTurnSession,
    digest: string
  ): void {
    session.acceptedProofUnrecorded = true;
    if (!session.recordNativeHandleDigest) {
      throw new Error('NanoHost accepted native ready proof without its AgentSession recorder.');
    }
    session.recordNativeHandleDigest(digest, {
      storageRef: session.sharedHarness.sandbox.workerStorageBinding.storageRef,
      workSlotRef: packageWorkerStorageWorkSlotRef(session.environmentPackage),
    });
    session.acceptedProofUnrecorded = false;
  }

  /** Validates an immutable update without performing a runtime effect. */
  public async update(
    environmentPackage: AgentEnvironmentPackage
  ): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return this.validatePackage(environmentPackage);
  }

  /** Returns bounded evidence produced by completed fixed NanoHost effects. */
  public async collectEvidence(
    packageSnapshotId: string
  ): Promise<WorkerGovernanceEvidenceRecord[]> {
    return [...this.requireSession(packageSnapshotId).evidence];
  }

  /** Returns no provider refreshes because NanoHost owns no provider authority. */
  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    return [];
  }

  /** Exports declared transcript and Artifact files only after the accepted terminal barrier. */
  public async collectTranscript(
    packageSnapshotId: string,
    terminalBarrierProved: true
  ): Promise<WorkerTranscriptPayload> {
    const session = this.requireSession(packageSnapshotId);
    await this.inspectTerminalHarnessSession(session);
    // Accepted final_status permits export while the resident Harness remains running.
    const finalStatusAccepted = terminalBarrierProved;
    const transcript = session.environmentPackage.control.transcript;
    if (!transcript) {
      return {};
    }
    /** Exports and consumes one exact declared transcript or Artifact file. */
    const exportTranscriptFile = async (workerPath: string): Promise<Buffer> => {
      const { relativePath, slot } = resolveNanoHostExportPath(
        session.environmentPackage,
        workerPath
      );
      const result = await this.effect(session.identity, session.leaseId, 'file.export', {
        finalStatusAccepted,
        maxByteLength: NANO_HOST_FILE_EXPORT_MAX_BYTES,
        presence: 'required',
        relativePath,
        sandboxId: session.sharedHarness.sandbox.sandboxId,
        slot,
        terminalBarrierProved,
      });
      requireNanoHostResultString(result, 'sha256');
      requireNanoHostResultByteLength(result, 'byteLength');
      return consumeNanoHostStagedExport(result);
    };
    const eventsBytes = await exportTranscriptFile(transcript.eventsPath);
    const itemsBytes = await exportTranscriptFile(transcript.itemsPath);
    const artifactsBytes = await exportTranscriptFile(transcript.artifactsPath);
    const artifactsJsonl = artifactsBytes.toString('utf8');
    const artifactFiles: Array<{ bytes: Buffer; sequence: number }> = [];
    let remainingArtifactBytes = MAX_WORKER_ARTIFACT_BYTES;
    for (const declaration of parseWorkerArtifactDeclarations(
      session.environmentPackage,
      artifactsJsonl
    )) {
      const bytes = await exportTranscriptFile(declaration.artifact.path);
      remainingArtifactBytes -= bytes.byteLength;
      if (bytes.byteLength === 0 || remainingArtifactBytes < 0) {
        throw new Error('NanoHost Worker Artifact payload violates its canonical byte bound.');
      }
      artifactFiles.push({ bytes, sequence: declaration.sequence });
    }
    let runtimeProvenance: WorkerRuntimeProvenanceCollection | null = null;
    if (transcript.runtimeProvenance) {
      const declaration = transcript.runtimeProvenance;
      /** Exports and retains one restricted provenance file through canonical import. */
      const retainProvenanceFile = async (workerPath: string) => {
        const { relativePath, slot } = resolveNanoHostExportPath(
          session.environmentPackage,
          workerPath
        );
        const result = await this.effect(session.identity, session.leaseId, 'file.export', {
          finalStatusAccepted,
          maxByteLength: NANO_HOST_FILE_EXPORT_MAX_BYTES,
          presence: 'required',
          relativePath,
          sandboxId: session.sharedHarness.sandbox.sandboxId,
          slot,
          terminalBarrierProved,
        });
        const sha256 = requireNanoHostResultString(result, 'sha256');
        const byteLength = requireNanoHostResultByteLength(result, 'byteLength');
        const staged = await inspectNanoHostStagedExport(result);
        session.retainedStagingPaths.push(staged.path);
        return { ...staged, byteLength, sha256 };
      };
      const manifest = await retainProvenanceFile(declaration.streamManifestPath);
      if (manifest.byteLength > MAX_RUNTIME_PROVENANCE_MANIFEST_BYTES) {
        throw new Error('NanoHost runtime provenance manifest exceeds its canonical bound.');
      }
      const parsedManifest = WorkerRuntimeRawStreamManifestSchema.parse(
        JSON.parse(manifest.bytes.toString('utf8')) as unknown
      );
      if (
        parsedManifest.streams.length > declaration.maxStreamCount ||
        parsedManifest.streams.reduce((total, stream) => total + stream.bytes, 0) >
          declaration.maxTotalBytes
      ) {
        throw new Error('NanoHost runtime provenance manifest exceeds its declared limits.');
      }
      const rawStreamPaths: Record<string, string> = {};
      for (const stream of parsedManifest.streams) {
        const raw = await retainProvenanceFile(`${declaration.rawStreamsRoot}/${stream.streamRef}`);
        if (raw.byteLength !== stream.bytes || raw.sha256 !== stream.sha256) {
          throw new Error('NanoHost runtime provenance stream identity disagrees.');
        }
        rawStreamPaths[stream.streamRef] = raw.path;
      }
      const nativeOriginIndex = await retainProvenanceFile(declaration.nativeOriginIndexPath);
      runtimeProvenance = {
        diagnostics: [],
        manifestPath: manifest.path,
        missingPaths: [],
        nativeOriginIndexPath: nativeOriginIndex.path,
        rawStreamPaths,
      };
    }
    return {
      artifactsJsonl,
      eventsJsonl: eventsBytes.toString('utf8'),
      itemsJsonl: itemsBytes.toString('utf8'),
      ...(artifactFiles.length > 0 ? { artifactFiles } : {}),
      ...(runtimeProvenance ? { runtimeProvenance } : {}),
    };
  }

  /** Collects the outside snapshot chain after accepted final status and waits before another Turn. */
  public async collectWorkspaceChanges(
    packageSnapshotId: string,
    _terminalBarrierProved: true
  ): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    const session = this.requireSession(packageSnapshotId);
    await this.inspectTerminalHarnessSession(session);
    return await this.collectWorkspaceSnapshot(session, 'turn-end');
  }

  /** Re-resolves the exact binding versions after restart; current Vault material is never substituted. */
  private restoreCollectionRuntimeEnvironment(
    session: NanoHostBackendTurnSession
  ): Record<string, string> {
    const row = this.coreDb.sqlite
      .prepare(
        'SELECT runtime_env_check_versions_json AS versions FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
      )
      .get(session.agentSessionRuntimeBindingId) as { versions: string | null } | undefined;
    try {
      const versions = JSON.parse(row?.versions ?? 'null') as Array<{
        targetEnvVarName: string;
        vaultReferenceId: string;
        materialVersion: number;
      }>;
      const declared = session.environmentPackage.credentials.declarations
        .filter((item) => item.visibility === 'runtime-env')
        .map((item) => item.targetEnvVarName)
        .sort();
      if (
        !Array.isArray(versions) ||
        !isDeepStrictEqual(versions.map((item) => item.targetEnvVarName).sort(), declared)
      )
        throw new WorkspaceCollectionError({
          outcome: 'recovery_required',
          cause: 'check_values_unavailable',
        });
      return nanoHostRuntimeEnvironment(
        versions.map((item) => {
          if (
            !item.vaultReferenceId ||
            !Number.isSafeInteger(item.materialVersion) ||
            item.materialVersion <= 0 ||
            !this.collectionVaultBackend
          )
            throw new Error('Unavailable Vault version.');
          const backend = this.collectionVaultBackend();
          if (backend.health().state !== 'available') throw new Error('Unavailable Vault backend.');
          return {
            targetEnvVarName: item.targetEnvVarName,
            credentialValue: vaultSecretMaterialToString(
              backend.resolve({ referenceId: item.vaultReferenceId, version: item.materialVersion })
            ),
          };
        })
      );
    } catch {
      throw new WorkspaceCollectionError({
        outcome: 'recovery_required',
        cause: 'check_values_unavailable',
      });
    }
  }

  /** Names one collection against the exact current admitted attachment and stable slot. */
  private workspaceCollectionIdentity(
    session: NanoHostBackendTurnSession,
    collectionId: string
  ): WorkspaceCollectionIdentity {
    const storage = session.sharedHarness.sandbox.workerStorageBinding;
    const current = getWorkerStorageBinding(this.coreDb, { storageRef: storage.storageRef });
    if (
      !current ||
      current.state !== 'attached' ||
      current.workspaceId !== session.environmentPackage.scope.workspaceId ||
      !current.contributors.some(
        (item) =>
          item.workSlotRef === packageWorkerStorageWorkSlotRef(session.environmentPackage) &&
          item.threadId === session.environmentPackage.scope.threadId &&
          item.attachmentGeneration === storage.attachmentGeneration
      ) ||
      current.scopeDigest !== storage.scopeDigest ||
      current.attachmentGeneration !== storage.attachmentGeneration ||
      current.currentSandboxBindingRef !== session.sharedHarness.sandbox.sandboxBindingRef
    )
      throw new Error('Workspace collection attachment association is unavailable.');
    return {
      workspaceId: session.environmentPackage.scope.workspaceId,
      storageRef: storage.storageRef,
      scopeDigest: storage.scopeDigest,
      attachmentGeneration: storage.attachmentGeneration,
      sandboxId: session.sharedHarness.sandbox.sandboxId,
      workSlot: packageWorkerStorageWorkSlotRef(session.environmentPackage),
      collectionId,
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      threadId: session.environmentPackage.scope.threadId,
      turnId: session.environmentPackage.scope.turnId,
      packageSnapshotId: session.environmentPackage.snapshotId,
    };
  }

  /** Constructs the complete bounded credential-check command; it never truncates the check set. */
  private workspaceCollectionCommand(
    session: NanoHostBackendTurnSession,
    identity: WorkspaceCollectionIdentity,
    mode: 'baseline' | 'capture',
    cursor: ReturnType<typeof readWorkspaceSnapshotCursor>
  ) {
    const digests = this.coreDb.sqlite
      .prepare(
        'SELECT inference_loopback_credential_digest AS inference, capability_loopback_credential_digest AS capability FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
      )
      .get(session.agentSessionRuntimeBindingId) as
      | { inference: string | null; capability: string | null }
      | undefined;
    const values = session.runtimeEnvironment ?? this.restoreCollectionRuntimeEnvironment(session);
    let command: ReturnType<typeof WorkspaceCollectCommandSchema.parse>;
    try {
      command = WorkspaceCollectCommandSchema.parse({
        ...identity,
        requestId: '0'.repeat(64),
        mode,
        acceptedBase: mode === 'baseline' ? null : cursor?.acceptedBase,
        previousHead: mode === 'baseline' ? null : cursor?.head,
        checkValues: {
          runtimeEnv: Object.values(values).filter((value) => value.length > 0),
          loopbackDigests: [digests?.inference, digests?.capability],
        },
      });
    } catch {
      throw new WorkspaceCollectionError({
        outcome: 'recovery_required',
        cause: 'check_values_unavailable',
      });
    }
    if (Buffer.byteLength(JSON.stringify(command)) > 512 * 1024)
      throw new WorkspaceCollectionError({
        outcome: 'recovery_required',
        cause: 'command_too_large',
      });
    const { requestId: _requestId, ...input } = command;
    return input;
  }

  /**
   * Accepts the first verified snapshot before any Turn; retained slots never fall back to baseline.
   * A new Git checkout is proved by the Sandbox client's HEAD and tree, without a host repository read.
   *
   * @param session Admitted native session and immutable source package.
   * @param opensNewBinding Whether launch opened a new native binding.
   * @param gitBaseline Sandbox Git evidence returned by this binding's session.open.
   * @throws WorkspaceCollectionError when the source tree or collected baseline cannot be accepted.
   */
  private async ensureWorkspaceBaseline(
    session: NanoHostBackendTurnSession,
    opensNewBinding: boolean,
    gitBaseline?: unknown
  ): Promise<void> {
    const identity = this.workspaceCollectionIdentity(session, 'baseline');
    const db = openWorkspaceDb(this.coreDb.dataRoot, identity.workspaceId);
    try {
      applyScopedMigrations(db);
      if (readWorkspaceSnapshotCursor(db, identity)) {
        if (opensNewBinding) await this.collectWorkspaceSnapshot(session, 'successor');
        else {
          const previous = this.coreDb.sqlite
            .prepare(
              'SELECT lease_id AS leaseId, package_snapshot_id AS packageSnapshotId FROM worker_backend_sessions WHERE agent_session_id = ? AND package_snapshot_id <> ? ORDER BY created_at DESC, lease_id DESC LIMIT 1'
            )
            .get(identity.agentSessionId, identity.packageSnapshotId) as
            | { leaseId: string; packageSnapshotId: string }
            | undefined;
          if (previous) {
            const prior = requireAgentEnvironmentPackageSnapshot(
              db,
              identity.workspaceId,
              previous.packageSnapshotId
            ).snapshot;
            const priorSession = {
              ...session,
              environmentPackage: prior,
              identity: this.planSession(prior),
              leaseId: previous.leaseId,
            };
            const records = await this.collectWorkspaceSnapshot(priorSession, 'turn-end');
            if (records.length) {
              if (!this.workspaceCollectionPublisher)
                throw new Error('Workspace collection review publisher is unavailable.');
              await this.workspaceCollectionPublisher(prior, records);
            }
          }
        }
        return;
      }
      requireWorkspaceBaselineInitialization(db, identity);
      const sources = session.environmentPackage.workspace.inputs.filter(
        (input) => input.access === 'read-write'
      );
      let expected: string | null = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      if (sources.length) {
        const source = sources[0]!;
        const reported = WorkspaceGitBaselineSchema.safeParse(gitBaseline);
        if (
          sources.length !== 1 ||
          source.source.kind !== 'git' ||
          typeof source.source.commit !== 'string' ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.source.commit) ||
          !reported.success
        )
          throw new WorkspaceCollectionError({
            outcome: 'recovery_required',
            cause: 'baseline_source_unavailable',
          });
        if (reported.data.commit !== source.source.commit)
          throw new WorkspaceCollectionError({
            outcome: 'recovery_required',
            cause: 'baseline_mismatch',
          });
        // Git identity is the source pin; its object format need not match the private SHA-1 scan store.
        expected = null;
      }
      const result = await this.effect(session.identity, session.leaseId, 'workspace.collect', {
        ...this.workspaceCollectionCommand(session, identity, 'baseline', null),
        attemptNonce: randomBytes(16).toString('hex'),
      });
      if (result.outcome !== 'baseline')
        throw new WorkspaceCollectionError({
          outcome:
            result.outcome === 'recovery_required' || result.outcome === 'credential_hit'
              ? result.outcome
              : 'effect_failed',
          cause: result.cause,
        });
      acceptWorkspaceBaseline(
        db,
        identity,
        result.head as { tree: string; manifest: string },
        expected,
        sources[0]?.source.kind === 'git' ? (sources[0].source.commit ?? null) : null
      );
    } finally {
      db.sqlite.close();
    }
  }

  /** Captures once per lifecycle boundary; committed receipts replay without another native scan. */
  private async collectWorkspaceSnapshot(
    session: NanoHostBackendTurnSession,
    boundary: 'turn-end' | 'release' | 'successor'
  ): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    const identity = this.workspaceCollectionIdentity(
      session,
      `${boundary}-${createHash('sha256').update(session.environmentPackage.snapshotId).digest('hex')}`
    );
    const db = openWorkspaceDb(this.coreDb.dataRoot, identity.workspaceId);
    try {
      applyScopedMigrations(db);
      let receipt = readWorkspaceCollection(db, identity);
      if (!receipt) {
        const cursor = readWorkspaceSnapshotCursor(db, identity);
        if (!cursor)
          throw new WorkspaceCollectionError({
            outcome: 'recovery_required',
            cause: 'accepted_base_unknown',
          });
        const result = await this.effect(session.identity, session.leaseId, 'workspace.collect', {
          ...this.workspaceCollectionCommand(session, identity, 'capture', cursor),
          attemptNonce: randomBytes(16).toString('hex'),
        });
        if (!['candidate', 'empty', 'no_new_head'].includes(String(result.outcome)))
          throw new WorkspaceCollectionError({
            outcome:
              result.outcome === 'recovery_required' || result.outcome === 'credential_hit'
                ? result.outcome
                : 'effect_failed',
            cause: result.cause,
          });
        let candidate: Buffer | null = null;
        if (result.outcome === 'candidate') candidate = await consumeNanoHostStagedExport(result);
        const { stagingPath: _stagingPath, ...durable } = result;
        receipt = acceptWorkspaceCapture(db, identity, durable, candidate);
      }
      // Captured Sandbox bytes remain evidence; no NanoCore host repository is an apply target.
      return [];
    } finally {
      db.sqlite.close();
    }
  }

  /** Dispatches one fixed effect with an identity derived from durable lineage. */
  private async effect(
    identity: WorkerGovernanceBackendSessionIdentity,
    leaseId: string,
    operation: NanoHostEffectOperation,
    input: Readonly<Record<string, unknown>>,
    retiringSandboxOrigin?: string
  ): Promise<Record<string, unknown>> {
    if (!this.sessionDispatch) {
      throw new Error('NanoHost fixed-effect dispatcher is not configured.');
    }
    if (retiringSandboxOrigin === undefined) {
      this.requireCurrentBackendPhysicalEpoch(identity);
    } else if (
      this.requireCurrentPhysicalEpoch(identity.runtimeTargetId) !== retiringSandboxOrigin
    ) {
      throw new Error('NanoHost retiring Sandbox physical Epoch is no longer current.');
    }
    return requireNanoHostResultObject(
      await this.sessionDispatch.effect(
        createNanoHostEffectRequest(identity, leaseId, operation, input)
      )
    );
  }

  /** Creates one bounded cleanup expectation set containing no command or token. */
  private createCleanupRecoveryResult(
    identity: WorkerGovernanceBackendSessionIdentity,
    originPhysicalEpoch: string
  ) {
    if (!this.sessionDispatch?.expectResultOnly) {
      return null;
    }
    requireStoredNanoHostPhysicalEpoch(originPhysicalEpoch);
    const leaseId = this.requireLeaseId(identity.packageSnapshotId);
    const cleanupInput = {
      leaseId,
      sandboxId: nanoHostSandboxIdFromBackendSessionId(identity.backendSessionId),
    };
    const expectations = (['bridge.close', 'sandbox.delete'] as const).map((operation) => {
      const request = createNanoHostEffectRequest(identity, leaseId, operation, cleanupInput);
      return { kind: operation, originPhysicalEpoch, requestId: request.requestId! };
    });
    return this.sessionDispatch.expectResultOnly(expectations);
  }

  /** Finds the one Sandbox cleanup fence selected by immutable backend or AgentSession lineage. */
  private findDurableSandboxBinding(identity: WorkerGovernanceBackendSessionIdentity): {
    readonly cleanupState: string;
    readonly drainState: string;
    readonly healthState: string;
    readonly lifecycleState: string;
    readonly originPhysicalEpoch: string;
    readonly runtimeTargetId: string;
    readonly sandboxBindingRef: string;
    readonly updatedAt: string;
  } | null {
    const rows = this.coreDb.sqlite
      .prepare(
        `SELECT DISTINCT s.sandbox_binding_ref AS sandboxBindingRef,
                s.runtime_target_id AS runtimeTargetId,
                t.deployment_id AS deploymentId,
                s.lifecycle_state AS lifecycleState,
                s.health_state AS healthState,
                s.drain_state AS drainState,
                s.cleanup_state AS cleanupState,
                s.origin_physical_epoch AS originPhysicalEpoch,
                s.updated_at AS updatedAt
         FROM sandbox_runtime_records s
         LEFT JOIN nanohost_runtime_targets t ON t.target_id = s.runtime_target_id
         LEFT JOIN harness_instance_records h ON h.sandbox_runtime_id = s.sandbox_runtime_id
         LEFT JOIN agent_session_runtime_bindings b ON b.harness_instance_id = h.harness_instance_id
         LEFT JOIN worker_backend_sessions w
           ON w.package_snapshot_id = ? AND w.runtime_target_id = s.runtime_target_id
         WHERE (('nh-' || substr(s.sandbox_compatibility_key, 1, 16)) = ?
           OR s.sandbox_binding_ref = w.sandbox_binding_ref
           OR b.agent_session_id = ?)`
      )
      .all(
        identity.packageSnapshotId,
        nanoHostSandboxIdFromBackendSessionId(identity.backendSessionId),
        identity.agentSessionId
      ) as Array<{
      readonly cleanupState: string;
      readonly deploymentId: string | null;
      readonly drainState: string;
      readonly healthState: string;
      readonly lifecycleState: string;
      readonly originPhysicalEpoch: string;
      readonly runtimeTargetId: string;
      readonly sandboxBindingRef: string;
      readonly updatedAt: string;
    }>;
    if (rows.length > 1) {
      throw new Error('NanoHost cleanup lineage matches more than one durable Sandbox.');
    }
    const durableSandbox = rows[0] ?? null;
    if (durableSandbox) {
      requireStoredNanoHostPhysicalEpoch(durableSandbox.originPhysicalEpoch);
    }
    if (
      durableSandbox &&
      (durableSandbox.runtimeTargetId !== identity.runtimeTargetId ||
        durableSandbox.deploymentId !== identity.deploymentId)
    ) {
      throw new Error('NanoHost cleanup lineage does not match the requested runtime owner.');
    }
    return durableSandbox;
  }

  /** Finds one exact failed cleanup whose Sandbox projection was never durably created. */
  private findDurableBackendCleanupFailure(
    identity: WorkerGovernanceBackendSessionIdentity
  ): WorkerBackendSessionRecord | null {
    const session = this.findDurableBackendSession(identity);
    return session?.state === 'cleanup-failed' ? session : null;
  }

  /** Reads one exact durable backend anchor without choosing its cleanup target. */
  private findDurableBackendSession(
    identity: WorkerGovernanceBackendSessionIdentity
  ): WorkerBackendSessionRecord | null {
    const session = getWorkerBackendSession(
      this.coreDb,
      this.requireLeaseId(identity.packageSnapshotId)
    );
    if (!session) {
      return null;
    }
    if (
      session.agentSessionId !== identity.agentSessionId ||
      session.backendKind !== identity.backendKind ||
      session.backendSessionId !== identity.backendSessionId ||
      session.deploymentId !== identity.deploymentId ||
      session.packageSnapshotId !== identity.packageSnapshotId ||
      session.runtimeTargetId !== identity.runtimeTargetId ||
      session.stagingDirectoryRef !== identity.stagingDirectoryRef ||
      session.transientProviderInstanceId !== identity.transientProviderInstanceId
    ) {
      throw new Error('NanoHost cleanup does not match the requested backend lineage.');
    }
    return session;
  }

  /** Selects the immutable origin of the Sandbox being cleaned, or its pre-Sandbox anchor. */
  private requireCleanupOriginPhysicalEpoch(
    identity: WorkerGovernanceBackendSessionIdentity,
    sandboxOriginPhysicalEpoch?: string
  ): string {
    if (sandboxOriginPhysicalEpoch !== undefined) {
      return requireStoredNanoHostPhysicalEpoch(sandboxOriginPhysicalEpoch);
    }
    const backendSession = this.findDurableBackendSession(identity);
    if (!backendSession) {
      throw new Error('NanoHost cleanup physical Epoch anchor is unavailable.');
    }
    return requireStoredNanoHostPhysicalEpoch(backendSession.originPhysicalEpoch);
  }

  /** Requires a different fresh physical Epoch before an unknown cleanup can settle. */
  private requireLaterFreshRuntimeTarget(
    runtimeTargetId: string,
    originPhysicalEpoch: string,
    deploymentId: string
  ): void {
    requireStoredNanoHostPhysicalEpoch(originPhysicalEpoch);
    const runtimeTarget = this.coreDb.sqlite
      .prepare(
        `SELECT deployment_id AS deploymentId, predecessor_fenced AS predecessorFenced,
                ready, fresh_empty AS freshEmpty, physical_epoch AS physicalEpoch
         FROM nanohost_runtime_targets
         WHERE target_id = ?`
      )
      .get(runtimeTargetId) as
      | {
          readonly deploymentId: string;
          readonly freshEmpty: number;
          readonly physicalEpoch: string | null;
          readonly predecessorFenced: number;
          readonly ready: number;
        }
      | undefined;
    if (
      !runtimeTarget ||
      runtimeTarget.deploymentId !== deploymentId ||
      runtimeTarget.predecessorFenced !== 1 ||
      runtimeTarget.ready !== 1 ||
      runtimeTarget.freshEmpty !== 1 ||
      !runtimeTarget.physicalEpoch ||
      !/^[0-9a-f]{64}$/.test(runtimeTarget.physicalEpoch) ||
      runtimeTarget.physicalEpoch === originPhysicalEpoch
    ) {
      throw new Error(
        'NanoHost unknown cleanup fence has no different fresh physical Epoch proof.'
      );
    }
  }

  /** Reads one exact current authenticated physical Epoch. */
  private requireCurrentPhysicalEpoch(runtimeTargetId: string): string {
    const physicalEpoch = this.readCurrentPhysicalEpoch(runtimeTargetId);
    if (!physicalEpoch) {
      throw new Error('NanoHost current physical Epoch authority is unavailable.');
    }
    return physicalEpoch;
  }

  /** Resolves a durable restore origin without treating it as current effect authority. */
  private resolveRestorationPhysicalEpoch(
    runtimeTargetId: string,
    durableOriginPhysicalEpoch?: string
  ): string {
    if (durableOriginPhysicalEpoch === undefined) {
      return this.requireCurrentPhysicalEpoch(runtimeTargetId);
    }
    const durableOrigin = requireStoredNanoHostPhysicalEpoch(durableOriginPhysicalEpoch);
    const currentPhysicalEpoch = this.readCurrentPhysicalEpoch(runtimeTargetId);
    if (currentPhysicalEpoch !== null && currentPhysicalEpoch !== durableOrigin) {
      throw new Error('NanoHost restart backend belongs to a different physical Epoch.');
    }
    return durableOrigin;
  }

  /** Reads current authenticated Epoch authority without changing admission state. */
  private readCurrentPhysicalEpoch(runtimeTargetId: string): string | null {
    const target = this.coreDb.sqlite
      .prepare(
        `SELECT predecessor_fenced AS predecessorFenced, ready,
                fresh_empty AS freshEmpty, physical_epoch AS physicalEpoch
         FROM nanohost_runtime_targets WHERE target_id = ?`
      )
      .get(runtimeTargetId) as
      | {
          readonly freshEmpty: number;
          readonly physicalEpoch: string | null;
          readonly predecessorFenced: number;
          readonly ready: number;
        }
      | undefined;
    if (
      !target ||
      target.predecessorFenced !== 1 ||
      target.ready !== 1 ||
      target.freshEmpty !== 1 ||
      !target.physicalEpoch ||
      !/^[0-9a-f]{64}$/.test(target.physicalEpoch)
    ) {
      return null;
    }
    return target.physicalEpoch;
  }

  /** Requires one backend attempt's immutable origin to remain current. */
  private requireCurrentBackendPhysicalEpoch(
    identity: WorkerGovernanceBackendSessionIdentity,
    expectedOrigin?: string
  ): string {
    const session = getWorkerBackendSession(
      this.coreDb,
      this.requireLeaseId(identity.packageSnapshotId)
    );
    if (!session || session.packageSnapshotId !== identity.packageSnapshotId) {
      throw new Error('NanoHost backend physical Epoch anchor is unavailable.');
    }
    const current = this.requireCurrentPhysicalEpoch(identity.runtimeTargetId);
    if (
      session.originPhysicalEpoch !== current ||
      (expectedOrigin !== undefined && session.originPhysicalEpoch !== expectedOrigin)
    ) {
      throw new Error('NanoHost backend physical Epoch changed during materialization.');
    }
    return session.originPhysicalEpoch;
  }

  /** Reads the exact scheduler lease that owns one immutable package snapshot. */
  private requireLeaseId(packageSnapshotId: string): string {
    const row = this.coreDb.sqlite
      .prepare(
        `SELECT lease_id AS leaseId
         FROM scheduler_session_leases
         WHERE package_snapshot_id = ?
         ORDER BY acquired_at DESC, lease_id DESC
         LIMIT 1`
      )
      .get(packageSnapshotId) as { readonly leaseId: string } | undefined;
    if (!row) {
      throw new Error('NanoHost effect lineage has no durable scheduler lease.');
    }
    return row.leaseId;
  }

  /** Reads the live backend session retained after successful materialization. */
  private requireSession(packageSnapshotId: string) {
    const session = this.sessions.get(packageSnapshotId);
    if (!session) {
      throw new Error('NanoHost materialized session is unavailable.');
    }
    return session;
  }

  /** Reads the immutable prior package and lease shared by proof handoff and local close. */
  private readDurableAgentSession(inspection: NanoHostAgentSessionContinuityInspection): {
    environmentPackage: AgentEnvironmentPackage;
    leaseId: string;
  } {
    const latest = this.coreDb.sqlite
      .prepare(
        'SELECT lease_id AS leaseId, workspace_id AS workspaceId, package_snapshot_id AS packageSnapshotId FROM worker_backend_sessions WHERE agent_session_id = ? ORDER BY created_at DESC, lease_id DESC LIMIT 1'
      )
      .get(inspection.agentSessionId) as
      | { leaseId: string; workspaceId: string; packageSnapshotId: string }
      | undefined;
    if (!latest) throw new Error('Workspace release collection lineage is unavailable.');
    const workspaceDb = openWorkspaceDb(this.coreDb.dataRoot, latest.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;
    try {
      applyScopedMigrations(workspaceDb);
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        latest.workspaceId,
        latest.packageSnapshotId
      ).snapshot;
    } finally {
      workspaceDb.sqlite.close();
    }
    return { environmentPackage, leaseId: latest.leaseId };
  }

  /** Restores a temporary Turn handle only for collection and local close. */
  private restoreDurableAgentSession(
    inspection: NanoHostAgentSessionContinuityInspection
  ): NanoHostBackendTurnSession {
    const { environmentPackage, leaseId } = this.readDurableAgentSession(inspection);
    this.restoreSession(environmentPackage, leaseId);
    return this.requireSession(environmentPackage.snapshotId);
  }

  /**
   * Joins exact persisted binding proof and attachment through the existing Core recorder. Proof-only inspection needs no Turn handle or live Harness, including in an old physical Epoch. A recorder refusal leaves the binding and its cleanup ownership untouched.
   */
  private handoffDurableAgentSessionProof(
    inspection: NanoHostAgentSessionContinuityInspection,
    record?: (digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => void
  ): void {
    const digest = inspection.nativeHandleDigest;
    if (!digest) return;
    const liveSession = [...this.sessions.values()].find(
      (session) => session.agentSessionRuntimeBindingId === inspection.agentSessionRuntimeBindingId
    );
    if (liveSession) liveSession.acceptedProofUnrecorded = true;
    const { environmentPackage, leaseId } = this.readDurableAgentSession(inspection);
    const identity = this.planSession(environmentPackage);
    const anchor = this.findDurableBackendSession(identity);
    const attachment = this.coreDb.sqlite
      .prepare(
        `SELECT s.sandbox_binding_ref AS sandboxBindingRef, s.runtime_target_id AS runtimeTargetId,
                s.origin_physical_epoch AS originPhysicalEpoch
         FROM agent_session_runtime_bindings b
         JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
         JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
         WHERE b.agent_session_runtime_binding_id = ? AND b.agent_session_id = ?
           AND h.harness_instance_id = ? AND h.harness_binding_ref = ?
           AND h.harness_compatibility_key = ? AND b.native_handle_state = 'ready'
           AND b.native_handle_digest = ? AND b.workspace_id = ? AND b.thread_id = ?
           AND b.agent_session_compatibility_key = ? AND s.sandbox_compatibility_key = ?`
      )
      .get(
        inspection.agentSessionRuntimeBindingId,
        inspection.agentSessionId,
        inspection.harnessInstanceId,
        inspection.harnessBindingRef,
        inspection.harnessCompatibilityKey,
        digest,
        environmentPackage.scope.workspaceId,
        environmentPackage.scope.threadId,
        nanoHostAgentSessionCompatibilityKey(environmentPackage),
        nanoHostSandboxCompatibilityKey(environmentPackage)
      ) as
      | { sandboxBindingRef: string; runtimeTargetId: string; originPhysicalEpoch: string }
      | undefined;
    if (
      !anchor ||
      anchor.leaseId !== leaseId ||
      !attachment ||
      environmentPackage.scope.agentSessionId !== inspection.agentSessionId ||
      attachment.runtimeTargetId !== identity.runtimeTargetId ||
      attachment.originPhysicalEpoch !== anchor.originPhysicalEpoch ||
      inspection.harnessCompatibilityKey !== nanoHostHarnessCompatibilityKey(environmentPackage)
    ) {
      throw new Error('NanoHost native proof does not match its durable package and attachment.');
    }
    // A fenced attachment still proves where accepted native bytes belong; only reuse needs attached state.
    const storage = getWorkerStorageBindingForSandbox(this.coreDb, {
      sandboxBindingRef: attachment.sandboxBindingRef,
    });
    if (!storage || storage.runtimeTargetId !== attachment.runtimeTargetId) {
      throw new Error('NanoHost native proof has no exact retained-storage association.');
    }
    const retainedStorage = {
      storageRef: storage.storageRef,
      workSlotRef: packageWorkerStorageWorkSlotRef(environmentPackage),
    };
    const recorder =
      record ??
      liveSession?.recordNativeHandleDigest ??
      ((digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => {
        this.recordNativeHandleDigest(inspection.agentSessionId, digest, retainedStorage);
      });
    if (liveSession) {
      if (
        liveSession.sharedHarness.sandbox.workerStorageBinding.storageRef !==
          retainedStorage.storageRef ||
        packageWorkerStorageWorkSlotRef(liveSession.environmentPackage) !==
          retainedStorage.workSlotRef
      ) {
        throw new Error('NanoHost live proof attachment disagrees with its durable binding.');
      }
      liveSession.recordNativeHandleDigest = recorder;
      // The durable result may precede the volatile cache handoff; record exactly the inspected proof.
      this.recordAcceptedNativeHandleDigest(liveSession, digest);
      const cachedBinding = liveSession.sharedHarness.bindings.get(inspection.agentSessionId);
      if (cachedBinding?.agentSessionRuntimeBindingId === inspection.agentSessionRuntimeBindingId) {
        cachedBinding.nativeHandleDigest = digest;
      }
    } else {
      recorder(digest, retainedStorage);
    }
  }

  /** Queues one exact pre-lease close from durable binding lineage and awaits its settled result. */
  private async closeDurableAgentSession(
    inspection: NanoHostAgentSessionContinuityInspection
  ): Promise<void> {
    if (this.agentSessionCloseOwners.has(inspection.agentSessionRuntimeBindingId)) {
      throw new Error('NanoHost AgentSession close already has a live producer.');
    }
    const session = this.restoreDurableAgentSession(inspection);
    const packageSnapshotId = session.environmentPackage.snapshotId;
    try {
      await this.collectWorkspaceSnapshot(session, 'successor');
      await new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
        const pending: PendingNanoHostHarnessOperation = {
          operation: 'session.close',
          operationId: null,
          reject,
          resolve,
          timeout: null,
        };
        const owner: NanoHostAgentSessionCloseOwner = {
          inspection,
          pending,
        };
        this.agentSessionCloseOwners.set(inspection.agentSessionRuntimeBindingId, owner);
        try {
          queueNanoHostHarnessOperation(this.coreDb, {
            body: {
              agentSessionId: inspection.agentSessionId,
              agentSessionRuntimeBindingId: inspection.agentSessionRuntimeBindingId,
            },
            harnessInstanceId: inspection.harnessInstanceId,
            operation: 'session.close',
            timestamp: new Date().toISOString(),
          });
          this.armHarnessOperationTimeout(
            pending,
            inspection.harnessBindingRef,
            () => owner.pending === pending,
            () => {
              owner.pending = null;
              this.agentSessionCloseOwners.delete(inspection.agentSessionRuntimeBindingId);
            }
          );
        } catch (error) {
          this.agentSessionCloseOwners.delete(inspection.agentSessionRuntimeBindingId);
          owner.pending = null;
          reject(error);
        }
      }).then((closed) => {
        if (closed.state !== 'closed' || closed.privateState !== 'absent') {
          throw new Error('NanoHost Harness session.close result is incompatible.');
        }
      });
    } finally {
      // Idle close restores a Turn handle only for collection and close, not active occupancy.
      // Sandbox identities repeat on later compatible creation, so retaining it can block admission.
      this.sessions.delete(packageSnapshotId);
    }
  }

  /** Queues one typed Harness operation and awaits only its exact settled result. */
  private queueAndWaitForHarnessOperation(
    session: NanoHostBackendTurnSession,
    operation: NanoHostHarnessOperation,
    body: Readonly<Record<string, unknown>>
  ): Promise<Readonly<Record<string, unknown>>> {
    if (session.pendingHarnessOperation) {
      throw new Error('NanoHost Harness producer already has an unsettled operation.');
    }
    let resolveResult!: (body: Readonly<Record<string, unknown>>) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const pending: PendingNanoHostHarnessOperation = {
      operation,
      operationId: null,
      reject: rejectResult,
      resolve: resolveResult,
      timeout: null,
    };
    session.pendingHarnessOperation = pending;
    try {
      queueNanoHostHarnessOperation(this.coreDb, {
        body,
        harnessInstanceId: session.harnessInstanceId,
        operation,
        timestamp: new Date().toISOString(),
      });
      this.armHarnessOperationTimeout(
        pending,
        session.harnessBindingRef,
        () => session.pendingHarnessOperation === pending,
        () => {
          session.pendingHarnessOperation = null;
        }
      );
    } catch (error) {
      session.pendingHarnessOperation = null;
      throw error;
    }
    return result;
  }

  /** Starts the one non-resetting enqueue-to-result budget for a Harness command. */
  private armHarnessOperationTimeout(
    pending: PendingNanoHostHarnessOperation,
    harnessBindingRef: string,
    isCurrent: () => boolean,
    clearOwner: () => void
  ): void {
    pending.timeout = setTimeout(() => {
      if (!isCurrent()) return;
      clearOwner();
      const phase = pending.operationId ? 'dispatched-awaiting-result' : 'never-dispatched';
      let timeoutError = new Error(
        `NanoHost Harness ${pending.operation} result outage budget expired: ${phase}.`
      );
      try {
        if (pending.operationId) {
          markNanoHostHarnessOperationUnknown(this.coreDb, {
            harnessBindingRef,
            operationId: pending.operationId,
            timestamp: new Date().toISOString(),
          });
        } else {
          expireNanoHostHarnessQueuedOperation(this.coreDb, {
            harnessBindingRef,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        timeoutError = new Error(
          `NanoHost Harness ${pending.operation} result outage cleanup failed: ${phase}.`,
          { cause: error }
        );
      }
      pending.reject(timeoutError);
    }, NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    pending.timeout.unref();
  }

  /**
   * Proves the Turn barrier once before any terminal output export or capacity return, and decides
   * whether the resident binding stays reusable. A binding is reusable only when it is open with
   * clean disposable state and proves one exact ready handle: the digest accepted earlier, or, for
   * a binding whose first Turn created the conversation, a new digest only when that Turn completed.
   * A failed binding is never reusable. Any agreeing ready proof, including one on a failed or
   * nonterminal inspection, is recorded before that decision. The recorder must already be bound;
   * a recording failure keeps the binding row. A crash between the SQLite binding commit and the
   * AgentSession write can leave the proof only on that row until this exact binding is restored.
   */
  private async inspectTerminalHarnessSession(session: NanoHostBackendTurnSession): Promise<void> {
    if (session.terminalInspectionComplete) {
      return;
    }
    if (!session.recordNativeHandleDigest) {
      throw new Error(
        'NanoHost terminal inspection requires its AgentSession recorder before dispatch.'
      );
    }
    await session.turnStopSettlement;
    const inspected = await this.queueAndWaitForHarnessOperation(session, 'session.inspect', {
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
    });
    const binding = session.sharedHarness.bindings.get(
      session.environmentPackage.scope.agentSessionId
    );
    if (!binding) {
      throw new Error('NanoHost terminal inspection lost its AgentSession binding.');
    }
    const readyDigest =
      inspected.nativeHandleState === 'ready' && typeof inspected.nativeHandleDigest === 'string'
        ? inspected.nativeHandleDigest
        : null;
    const carriedResumeDigest = session.nativeResume?.digest ?? null;
    const previousDigest = binding.nativeHandleDigest;
    const digestAgrees =
      readyDigest !== null &&
      (previousDigest === null || readyDigest === previousDigest) &&
      (carriedResumeDigest === null || readyDigest === carriedResumeDigest);
    if (digestAgrees && readyDigest !== null) {
      binding.nativeHandleDigest = readyDigest;
      this.recordAcceptedNativeHandleDigest(session, readyDigest);
    }
    const barrierReached =
      (inspected.state === 'open' && inspected.cleanupState === 'clean') ||
      inspected.state === 'failed';
    if (!barrierReached) {
      throw new Error('NanoHost Harness terminal session inspection is incompatible.');
    }
    const accepted = getWorkerControlAcceptedFinalStatus(this.coreDb, {
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      packageSnapshotId: session.environmentPackage.snapshotId,
      requestId: session.environmentPackage.scope.requestId ?? null,
      threadId: session.environmentPackage.scope.threadId,
      turnId: session.environmentPackage.scope.turnId,
      workspaceId: session.environmentPackage.scope.workspaceId,
    });
    session.nativeSessionReusable =
      inspected.state === 'open' &&
      inspected.cleanupState === 'clean' &&
      digestAgrees &&
      (previousDigest !== null || accepted?.status === 'completed');
    session.terminalInspectionComplete = true;
  }
}

/** Whether a Harness refusal asked the live owner to widen cleanup. */
function isCleanupRequiredRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    'reasonCode' in error &&
    (error as { readonly reasonCode?: unknown }).reasonCode === 'cleanup_required'
  );
}

/** Reads an operation result object from the fixed result envelope. */
function requireNanoHostResultObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NanoHost effect result must be an object.');
  }
  const envelope = value as Record<string, unknown>;
  const result = 'result' in envelope ? envelope.result : envelope;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('NanoHost effect result payload must be an object.');
  }
  return result as Record<string, unknown>;
}

/** Reads one required string from a fixed NanoHost effect result. */
function requireNanoHostResultString(result: Record<string, unknown>, name: string): string {
  const value = result[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`NanoHost effect result ${name} is required.`);
  }
  return value;
}

/** Requires one attached storage association for a restored durable Sandbox. */
function requireAttachedWorkerStorageBinding(
  coreDb: CoreDb,
  sandboxBindingRef: string,
  runtimeTargetId: string
): WorkerStorageBinding {
  const binding = getWorkerStorageBindingForSandbox(coreDb, { sandboxBindingRef });
  if (!binding || binding.state !== 'attached' || binding.runtimeTargetId !== runtimeTargetId) {
    throw new Error('NanoHost persisted Sandbox storage binding is missing or fenced.');
  }
  return binding;
}

/** Rechecks exact live Worker authority and every retained contributor's current Thread audience. */
function currentWorkerStorageAudienceAuthorizer(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackagePreview
): (contributor: WorkerStorageContributor) => boolean {
  const { scope } = environmentPackage;
  const requesterUserId = responsibleUserIdForActor(scope.triggerActor);
  const lineage = {
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    agentSessionId: scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    triggerActor: scope.triggerActor,
  };
  return (contributor) => {
    if (
      !requesterUserId ||
      contributor.workspaceId !== scope.workspaceId ||
      contributor.responsibleUserId !== requesterUserId ||
      !currentWorkerLineageWorkspaceAuthority(coreDb, lineage, 'runtime.launch', true)
    )
      return false;
    const leases = listSchedulerSessionLeasesForTurn(coreDb, lineage).filter(
      (lease) =>
        lease.agentSessionId === scope.agentSessionId &&
        lease.packageSnapshotId === environmentPackage.snapshotId
    );
    const lease = leases.length === 1 ? leases[0] : null;
    const liveLease =
      lease &&
      resolveSchedulerLeaseTokenBinding(coreDb, {
        sandboxBindingRef: lease.sandboxBindingRef,
        lineage,
      });
    if (
      !liveLease ||
      liveLease.status !== 'accepted' ||
      liveLease.lease.leaseId !== lease?.leaseId
    ) {
      return false;
    }
    const records = loadWorkspaceFileRecords(coreDb.dataRoot).find(
      (records) => records.workspace.id === scope.workspaceId
    );
    const thread = records?.threads.find((thread) => thread.id === contributor.threadId);
    return (
      !!records &&
      !!thread &&
      thread.workspaceId === scope.workspaceId &&
      isThreadVisible({ getWorkspace: () => records.workspace }, thread, requesterUserId)
    );
  };
}

/** Selects the stable private work slot admitted for one exact Thread and responsible user. */
function requireWorkerStorageWorkSlot(
  binding: WorkerStorageBinding,
  threadId: string,
  responsibleUserId: string | null
): string {
  const contributor = binding.contributors.findLast(
    (candidate) =>
      candidate.threadId === threadId && candidate.responsibleUserId === responsibleUserId
  );
  if (!contributor) {
    throw new Error('Worker storage work slot is missing.');
  }
  return contributor.workSlotRef;
}

/** Reads the exact work slot already validated into one Agent Environment Package. */
function packageWorkerStorageWorkSlotRef(
  environmentPackage: AgentEnvironmentPackagePreview
): string {
  return (
    environmentPackage.extensions.openkit as {
      workerStorage: { workSlotRef: string };
    }
  ).workerStorage.workSlotRef;
}

/** Parses and matches the host-proved storage attachment returned by sandbox.create. */
function requireNanoHostSandboxStorageProof(
  result: Record<string, unknown>,
  binding: WorkerStorageBinding
): WorkerStorageTarget[] {
  const storage = result.storage;
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
    throw new Error('NanoHost Sandbox storage proof is required.');
  }
  const record = storage as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'attachmentGeneration,layoutDigest,scopeDigest,storageRef,targets' ||
    record.storageRef !== binding.storageRef ||
    record.attachmentGeneration !== binding.attachmentGeneration ||
    record.scopeDigest !== binding.scopeDigest ||
    record.layoutDigest !== binding.layoutDigest ||
    !Array.isArray(record.targets)
  ) {
    throw new Error('NanoHost Sandbox storage proof does not match admission.');
  }
  return record.targets.map((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error('NanoHost Sandbox storage target proof is invalid.');
    }
    const entry = target as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(',') !== 'initialized,target,volumeRef' ||
      typeof entry.initialized !== 'boolean' ||
      typeof entry.target !== 'string' ||
      typeof entry.volumeRef !== 'string'
    ) {
      throw new Error('NanoHost Sandbox storage target proof is invalid.');
    }
    return {
      active: true,
      initialized: entry.initialized,
      target: entry.target,
      volumeRef: entry.volumeRef,
    };
  });
}

/** Reads the RuntimeTarget identity already proved by NanoHost session planning. */
function requireNanoHostRuntimeTargetId(identity: WorkerGovernanceBackendSessionIdentity): string {
  if (!identity.runtimeTargetId) {
    throw new Error('NanoHost backend session has no RuntimeTarget identity.');
  }
  return identity.runtimeTargetId;
}

/** Reads one required nonnegative safe byte length from a fixed NanoHost effect result. */
/**
 * Reads one required nonnegative safe byte length from a fixed NanoHost effect result.
 *
 * @param result Fixed-effect result object.
 * @param name Required byte-length field name.
 * @returns Exact nonnegative safe integer.
 * @throws Error when the named result field is not a valid byte length.
 */
function requireNanoHostResultByteLength(result: Record<string, unknown>, name: string): number {
  const value = result[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`NanoHost effect result ${name} is required.`);
  }
  return value as number;
}

/** Projects one completed bounded effect result into existing backend evidence. */
function nanoHostEffectEvidence(
  timestamp: string,
  data: Record<string, unknown>,
  kind: string
): WorkerGovernanceEvidenceRecord {
  return { data, kind, timestamp };
}

/** Validates runtime environment credentials retained only until exact private Turn dispatch. */
function nanoHostRuntimeEnvironment(
  credentials: readonly WorkerGovernanceRuntimeEnvCredential[]
): Record<string, string> {
  if (credentials.length > 128) {
    throw new Error('NanoHost runtime environment credential count is invalid.');
  }
  const environment: Record<string, string> = {};
  for (const credential of credentials) {
    if (
      !NANO_HOST_RUNTIME_ENV_NAME_PATTERN.test(credential.targetEnvVarName) ||
      credential.credentialValue.length === 0 ||
      credential.credentialValue.includes('\0') ||
      Buffer.byteLength(credential.credentialValue) > NANO_HOST_RUNTIME_ENV_VALUE_MAX_BYTES ||
      credential.targetEnvVarName in environment
    ) {
      throw new Error('NanoHost runtime environment credential is invalid.');
    }
    environment[credential.targetEnvVarName] = credential.credentialValue;
  }
  return environment;
}

/** Projects runtime credential files into the existing private reference-import effect. */
function nanoHostRuntimeCredentialImports(
  credentials: readonly WorkerGovernanceRuntimeFileCredential[]
): NanoHostContextPackageImport[] {
  if (credentials.length > 0) {
    throw new Error(
      'NanoHost persistent Worker images do not admit runtime-file credential materialization.'
    );
  }
  return [];
}

/** Hashes only the exact inputs that decide physical Sandbox reuse. */
function nanoHostSandboxCompatibilityKey(
  environmentPackage: AgentEnvironmentPackagePreview
): string {
  const responsibleUserId = responsibleUserIdForActor(environmentPackage.scope.triggerActor);
  const { contextRoot, packagePath } = workerSessionInputPaths(
    environmentPackage.scope.agentSessionId
  );
  const { layout, materialization } = planSessionWorkspaceMaterialization({ environmentPackage });
  const mainWorktreePath = layout.slots.find((slot) => slot.id === 'main-worktree')?.path;
  const filesystem = environmentPackage.policy.filesystem;
  return createHash('sha256')
    .update(
      stableNanoHostEffectJson({
        backend: environmentPackage.backend,
        credentials: environmentPackage.credentials,
        policy: {
          ...environmentPackage.policy,
          ...(filesystem
            ? {
                filesystem: {
                  ...filesystem,
                  rules: filesystem.rules.map((rule) => {
                    if (
                      !rule ||
                      typeof rule !== 'object' ||
                      Array.isArray(rule) ||
                      !('workerPath' in rule)
                    ) {
                      return rule;
                    }
                    if (
                      'id' in rule &&
                      rule.id === 'openkit-context-package' &&
                      rule.workerPath === contextRoot
                    ) {
                      return { ...rule, workerPath: 'agent-session-context' };
                    }
                    return rule.workerPath === mainWorktreePath
                      ? { ...rule, workerPath: 'worker-storage-worktree' }
                      : rule;
                  }),
                },
              }
            : {}),
        },
        responsibleUserTrust: {
          actorKind: environmentPackage.scope.triggerActor.kind,
          responsibleUserId,
        },
        resources: environmentPackage.resources,
        runtimeImage: environmentPackage.runtime.image,
        runtimeProcess: environmentPackage.runtime.process ?? null,
        schemaVersion: environmentPackage.schemaVersion,
        vault: environmentPackage.vault,
        workspace: {
          generatedFiles: environmentPackage.workspace.generatedFiles.map((file) => ({
            access: file.access,
            id: file.id,
            target:
              file.id === 'agent-environment-package' && file.target === packagePath
                ? 'agent-session-package'
                : file.target,
          })),
          id: environmentPackage.scope.workspaceId,
          // Generated context files are Turn-dynamic inside the declared context slot.
          inputs: environmentPackage.workspace.inputs.flatMap((input, index) =>
            materialization.inputs[index]?.slotId === 'context'
              ? []
              : [nanoHostStaticWorkspaceInput(input, materialization.inputs[index]?.slotId)]
          ),
          layout: {
            ...layout,
            layoutId: 'worker-storage-layout',
            workingDirectory:
              layout.workingDirectory === mainWorktreePath
                ? 'worker-storage-worktree'
                : layout.workingDirectory,
            slots: layout.slots.map((slot) =>
              slot.id === 'context'
                ? { ...slot, path: 'agent-session-context' }
                : slot.id === 'main-worktree'
                  ? { ...slot, path: 'worker-storage-worktree' }
                  : slot
            ),
            control: { ...layout.control, contextRoot: 'agent-session-context' },
          },
          outputs: environmentPackage.workspace.outputs.map((output) =>
            output.path === mainWorktreePath
              ? { ...output, path: 'worker-storage-worktree' }
              : output
          ),
        },
      })
    )
    .digest('hex');
}

/** Derives the NanoHost-facing physical Sandbox identity from its reuse key. */
function nanoHostSandboxId(sandboxCompatibilityKey: string): string {
  return `nh-${sandboxCompatibilityKey.slice(0, 16)}`;
}

/** Hashes the process-static adapter and Integration configuration of one Harness. */
function nanoHostHarnessCompatibilityKey(
  environmentPackage: AgentEnvironmentPackagePreview
): string {
  const { openkit, ...extensions } = environmentPackage.extensions ?? {};
  const openkitRecord =
    openkit && typeof openkit === 'object' && !Array.isArray(openkit)
      ? (openkit as Record<string, unknown>)
      : null;
  const {
    turnInput: _turnInput,
    sessionWorkspace: _sessionWorkspace,
    workerStorage: _workerStorage,
    ...staticOpenkit
  } = openkitRecord ?? {};
  return createHash('sha256')
    .update(
      stableNanoHostEffectJson({
        adapter: environmentPackage.control.adapter,
        agentRuntime: {
          kind: environmentPackage.agent.runtimeKind,
          version: environmentPackage.agent.runtimeVersion,
        },
        control: {
          transcript: environmentPackage.control.transcript ?? null,
        },
        credentials: environmentPackage.credentials,
        extensions: { ...extensions, openkit: openkitRecord ? staticOpenkit : openkit },
        resources: environmentPackage.resources,
        runtime: {
          binaries: environmentPackage.runtime.binaries,
          command: {
            ...environmentPackage.runtime.command,
            workingDirectory: 'worker-storage-worktree',
          },
          process: environmentPackage.runtime.process ?? null,
          session: environmentPackage.runtime.session ?? null,
        },
        supply: environmentPackage.supply,
        vault: environmentPackage.vault,
      })
    )
    .digest('hex');
}

/**
 * Reads the package's opaque adapter identity. NanoCore carries it without an enum; the Harness's
 * static adapter registry refuses an identity it does not register.
 */
function nanoHostAdapterId(environmentPackage: AgentEnvironmentPackagePreview): string {
  return environmentPackage.control.adapter.targetRuntime;
}

/** Derives one process-local map key without creating another durable identity. */
function nanoHostSharedHarnessMapKey(
  sandboxCompatibilityKey: string,
  harnessCompatibilityKey: string
): string {
  return `${sandboxCompatibilityKey}:${harnessCompatibilityKey}`;
}

/** Removes Turn content lineage while retaining one input's static isolation envelope. */
function nanoHostStaticWorkspaceInput(
  input: AgentEnvironmentPackage['workspace']['inputs'][number],
  slotId: string | undefined
): Record<string, unknown> {
  const { commit: _commit, ...source } = input.source;
  const { contentDigest: _contentDigest, ...materialization } = input.materialization ?? {};
  return {
    access: input.access,
    id: slotId === 'context' ? 'context' : input.id,
    kind: input.kind,
    materialization,
    mount: input.mount ?? null,
    source: slotId === 'context' ? { kind: source.kind } : source,
    target:
      slotId === 'context'
        ? 'agent-session-context'
        : slotId === 'main-worktree'
          ? 'worker-storage-worktree'
          : input.target,
  };
}

/** Hashes only the exact inputs that decide one AgentSession's native continuity. */
function nanoHostAgentSessionCompatibilityKey(
  environmentPackage: AgentEnvironmentPackagePreview
): string {
  // AEP policy paths are already materialized; only its embedded key preserves the admitted inputs.
  const sessionCompatibilityKey = agentSessionCompatibilityKeyFromPackage(environmentPackage);
  return deriveNanoHostAgentSessionCompatibilityKey({
    adapterId: nanoHostAdapterId(environmentPackage),
    adapterVersion: environmentPackage.agent.runtimeVersion,
    harnessCompatibilityKey: nanoHostHarnessCompatibilityKey(environmentPackage),
    sessionCompatibilityKey,
    threadId: environmentPackage.scope.threadId,
  });
}

/** Checks the immutable reference/build inputs against persisted backend lineage. */
function sessionMatchesRuntimeImage(
  session: WorkerBackendSessionRecord,
  image: AgentEnvironmentPackage['runtime']['image']
): boolean {
  if (image.kind === 'reference') {
    return 'imageRef' in session.backendLineage && session.backendLineage.imageRef === image.ref;
  }
  return (
    'buildArgumentsDigest' in session.backendLineage &&
    session.backendLineage.buildArgumentsDigest === image.argumentsDigest &&
    session.backendLineage.buildContextDigest === image.contextDigest &&
    session.backendLineage.buildInputDigest === image.input.digest
  );
}
