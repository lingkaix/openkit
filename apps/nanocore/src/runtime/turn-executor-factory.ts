import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type AgentEnvironmentPackage,
  type AgentEnvironmentValidationDiagnostic,
  EMPTY_BUILD_CONTEXT_DIGEST,
  EMPTY_BUILD_CONTEXT_REF,
  planSessionWorkspaceMaterialization,
  sessionStaticControl,
  validateAgentEnvironmentPackageForBackend,
  type WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import {
  isSealedTurnTerminal,
  readRetainedV1,
  responsibleUserIdForActor,
  workspaceIdForOwner,
} from '@openkit/protocol';
import {
  HARNESS_DEFAULT_MAX_ACTIVE_TURNS,
  parseHarnessResultBody,
  WORKER_OBSERVATION_SOURCE_MAX_BYTES,
  WorkerRuntimeRawStreamManifestSchema,
  type WorkerStartupFailure,
  WorkerStartupFailureSchema,
  WorkspaceGitBaselineSchema,
  workerObservationSourceRelativePath,
  workerSessionInputPaths,
} from '@openkit/worker-protocol';
import {
  currentScheduledTurnWorkspaceAuthority,
  currentWorkerLineageWorkspaceAuthority,
  readCurrentWorkspacePolicy,
} from '../auth/operation-authorizer.js';
import { canDiscloseThreadToAudience, isThreadVisible } from '../auth/thread-visibility.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ArtifactAuthorityError, FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { EMPTY_POLICY_DOCUMENT } from '../policy/statements.js';
import {
  requireSchedulerExecutionAttemptAdmissionContext,
  type SchedulerWorkerStorageChoice,
} from '../scheduler-records.js';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { controlStoreFor } from '../storage/control-store.js';
import {
  decode as decodeControlProduct,
  openControlStoreProductReadHandle,
} from '../storage/control-store-products.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  bindWorkspaceSqlite,
  type CoreDb,
  openBootVerifiedWorkspaceDb,
  openWorkspaceDb,
  type WorkspaceDb,
} from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { readWorkObservations } from '../storage/work-observations.js';
import {
  AgentSessionRecordSchema,
  assertCanonicalDirectory,
  nativeProductMetadataScope,
  readCanonicalTextFile,
  readNativeProduct,
} from '../storage/workspace-file-records.js';
import { withLifecycleStageTelemetry } from '../telemetry.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { vaultSecretMaterialToString } from '../vault/vault-backend.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  type AgentEnvironmentPackageSnapshotReadRecord,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import type { AgentEnvironmentPackagePreview } from './agent-environment.js';
import { assertCurrentWorkerCredentialAuthority } from './agent-environment.js';
import {
  acceptSchedulerExecutionObservation,
  isSchedulerExecutionBusyRefusal,
  listSchedulerExecutionAttemptsForTurn,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import type {
  ExecutionBackendCorrelation,
  ExecutionBackendObservation,
  ExecutionReleaseProof,
} from './execution-backend.js';
import {
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  createExecutionStepJournalReader,
  decodeExecutionJournalIntent,
  type ExecutionCandidate,
  encodeExecutionJournalValue,
  hasIdleCleanupExecution,
  readExecutionJournalRoot,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from './execution-journal.js';
import { ExecutionReconciler, type IdleCleanupSelection } from './execution-reconciler.js';
import type {
  ExecutionJournalIntent,
  ExecutionStepJournalReader,
} from './execution-step-journal.js';
import { commandInputHash } from './idempotent-command.js';
import {
  requireNanoHostExecutionAttempt,
  resolveNanoHostAttemptTokenBinding,
} from './nanohost-attempt-records.js';
import {
  createNanoHostEffectRequest,
  nanoHostSandboxIdFromBackendSessionId,
  stableNanoHostEffectJson,
} from './nanohost-effect-identity.js';
import {
  acknowledgeNanoHostHarnessResult,
  copyNanoHostMeasuredHarnessIdentity,
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  drainNanoHostHarnessAdmission,
  drainNanoHostSandboxAdmission,
  expireNanoHostHarnessQueuedOperation,
  fenceNanoHostSandboxRuntime,
  hasConsumedNanoHostHarnessResult,
  inspectNanoHostAgentSessionContinuity,
  markNanoHostHarnessOperationUnknown,
  NANO_HOST_HARNESS_RESULT_BUDGET_MS,
  type NanoHostAgentSessionContinuityInspection,
  type NanoHostHarnessCommand,
  type NanoHostHarnessOperation,
  type NanoHostHarnessResult,
  openNanoHostAgentSessionBinding,
  type PreparedNanoHostHarnessOperation,
  prepareNanoHostHarnessOperation,
  queueNanoHostHarnessOperation,
  readNanoHostIdleCloseConsumerReceipt,
  readNanoHostThreadAgentSessionBinding,
  removeNanoHostSandboxRuntimeByBinding,
} from './nanohost-harness-records.js';
import {
  NanoHostCleanupFencePendingError,
  requireStoredNanoHostPhysicalEpoch,
} from './nanohost-runtime-target.js';
import {
  NanoHostEffectNotEnqueuedError,
  type NanoHostEffectOperation,
  type NanoHostSessionDispatch,
} from './nanohost-session-dispatch.js';
import type { PublicNetworkConfiguration } from './public-network-grants.js';
import type { TurnExecutor } from './types.js';
import {
  getWorkerBackendSession,
  type WorkerBackendSessionRecord,
} from './worker-backend-sessions.js';
import { hashWorkerRouteToken, type WorkerControlGateway } from './worker-control-gateway.js';
import {
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
  waitForWorkerControlFinalStatus,
  workerObservationRecordId,
} from './worker-control-records.js';
import {
  requireWorkerCredentialCheckValues,
  type WorkerCredentialCheckValues,
} from './worker-credential-guard.js';
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
  openNanoHostStagedExport,
  openShellFilesystemGrantsFromPackagePolicy,
  openShellNetworkEndpointsFromPackagePolicy,
  prepareNanoHostContextPackageImports,
  removeNanoHostStagedExport,
  resolveNanoHostExportPath,
  validateWorkerArtifactPath,
  type WorkerArtifactCapture,
  WorkerGovernanceCapacityUnavailableError,
  WorkerNativeProofValidationError,
} from './worker-governance-backend.js';
import {
  agentSessionCompatibilityKeyFromPackage,
  beginWorkerTurnJournalStep,
  endWorkerTurnJournalStep,
  hasCompletedWorkerTurnCollection,
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
  WorkerStorageBindingError,
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
  completeWorkspaceCaptureRecovery,
  hasPendingWorkspaceCapture,
  listWorkspaceReconciliationRecords,
  recordWorkspaceCaptureRecovery,
} from './workspace-reconciliation-records.js';
import {
  acceptWorkspaceBaseline,
  acceptWorkspaceCapture,
  authorizeWorkspaceBaselineInitialization,
  preserveRawWorkspaceCapture,
  type RawWorkspaceCapture,
  readWorkspaceBaselineIdentity,
  readWorkspaceCollection,
  readWorkspaceSnapshotCursor,
  requireWorkspaceBaselineInitialization,
  WorkspaceCaptureRecoveryRequired,
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
  /** Shared file capacity owner used by self-check Artifact publication. */
  fileAdmission?: FileStorageAdmission | undefined;
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
  /** Same selected Core next-step owner used by normal cleanup, boot and maintenance. */
  readonly executionReconciler: ExecutionReconciler;
  /** Advances only the selected physical leaf; it never re-enters normal cleanup classification. */
  readonly advanceIdleCleanup: (selection: IdleCleanupSelection) => Promise<void>;
  /** Captures a bounded file using this same configured backend and original evidence. */
  readonly captureArtifact?: WorkerArtifactCapture;
  /** Binds private Turn route tokens and returns `session.open` with its ephemeral Vault values. */
  readonly acceptNanoHostHarnessCommand: (
    command: NanoHostHarnessCommand
  ) => Promise<NanoHostHarnessCommand>;
  /** Advances one exact live producer after its durable Harness result settles. */
  readonly acceptNanoHostHarnessResult: (result: NanoHostHarnessResult) => Promise<void>;
  /** Rejects the exact live waiter after its dispatched response is durably fenced as incomplete. */
  readonly failNanoHostHarnessDelivery: (
    command: Pick<NanoHostHarnessCommand, 'harnessInstanceId' | 'operationId'>,
    failure?: unknown
  ) => void;
  /** Cleans one exact durable backend identity during restart or online recovery. */
  readonly cleanupBackendSession: (
    identity: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
  /** Reports live lifecycle ownership before scheduler recovery can take over a Turn. */
  readonly isTurnExecutionActive: (turnId: string) => boolean;
  /** Prepares original results and reports exact Core idle ownership without physical contact. */
  readonly prepareBackendCleanup: (identity: WorkerGovernanceBackendSessionIdentity) => boolean;
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
    return new SimulatedTurnExecutor({
      coreDb: options.coreDb,
      fileAdmission: options.fileAdmission,
    });
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
    options.readRuntimeConfig,
    options.fileAdmission
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
 * @param fileAdmission Existing shared file reserve; no second simulator capacity owner is created.
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
  readRuntimeConfig?: (() => PublicNetworkConfiguration) | undefined,
  fileAdmission?: FileStorageAdmission | undefined
): ConfiguredWorkerLifecycleRuntime {
  let executionReconciler: ExecutionReconciler;
  const backend = new NanoHostWorkerGovernanceBackend(
    coreDb,
    async (agentSessionId, digest, retainedStorage) => {
      if (!(turnExecutor instanceof WorkerGovernanceTurnExecutor)) {
        throw new Error('The self-check executor cannot record real native proof.');
      }
      await turnExecutor.recordNativeHandleDigest(
        sharedStore ?? new FsStore({ dataRoot: coreDb.dataRoot }),
        agentSessionId,
        digest,
        retainedStorage
      );
    },
    {
      onCommit: () => executionReconciler.wake(),
      join: (identity) => executionReconciler.reconcileIdleCleanup(identity),
    },
    nanoHostSessionDispatch,
    workerControlGateway,
    vaultBackend,
    readRuntimeConfig,
    sharedStore,
    fileAdmission
  );
  executionReconciler = new ExecutionReconciler({
    coreDb,
    advanceIdleCleanup: (selection) => backend.advanceIdleCleanup(selection),
  });
  const turnExecutor =
    env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1'
      ? new SimulatedTurnExecutor({ coreDb, fileAdmission })
      : new WorkerGovernanceTurnExecutor({
          fileAdmission,
          awaitWorkerCompletion: (environmentPackage, attemptId) =>
            waitForWorkerControlFinalStatus(coreDb, {
              attemptId: attemptId,
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
    const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, session.attemptId);
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
    executionReconciler,
    advanceIdleCleanup: (selection) => backend.advanceIdleCleanup(selection),
    captureArtifact: (input) => backend.captureArtifact(input),
    cleanupBackendSession: (identity) => backend.cleanupSession(identity),
    isTurnExecutionActive: (turnId) =>
      turnExecutor instanceof WorkerGovernanceTurnExecutor &&
      turnExecutor.isTurnExecutionActive(turnId),
    prepareBackendCleanup: (identity) => backend.prepareCleanupRecovery(identity),
    acceptNanoHostHarnessCommand: (command) => backend.acceptHarnessCommand(command),
    acceptNanoHostHarnessResult: (result) => backend.acceptHarnessResult(result),
    failNanoHostHarnessDelivery: (command, failure) =>
      backend.failHarnessDelivery(command, failure),
    runtimeTargetKind: 'nanohost',
    reconcileAcceptedFinalStatus: async (session) => {
      if (!(turnExecutor instanceof WorkerGovernanceTurnExecutor)) {
        throw new Error('The self-check executor cannot reconcile a real worker session.');
      }
      const environmentPackage = await restoreDurableSession(session);
      const store = sharedStore ?? new FsStore({ dataRoot: coreDb.dataRoot });
      let captureDisposed = false;
      let collected = false;
      const db = openWorkspaceDb(coreDb.dataRoot, session.workspaceId);
      try {
        if (await hasPendingWorkspaceCapture(coreDb, db, session, environmentPackage, store)) {
          const turn = store.getTurnById(session.turnId);
          if (
            turn.status === 'completed' ||
            turn.status === 'failed' ||
            turn.status === 'cancelled' ||
            turn.status === 'interrupted'
          )
            return { status: turn.status, turn };
          throw new WorkspaceCaptureRecoveryRequired(
            'Original Workspace capture requires durable recovery disposition.'
          );
        }
        captureDisposed = listWorkspaceReconciliationRecords(db, session.workspaceId).some(
          (record) =>
            record.id.startsWith('wrr_capture_') &&
            record.stateAfter === 'unrecoverable' &&
            record.backendHandleSummary.attemptId === session.attemptId
        );
        collected = await hasCompletedWorkerTurnCollection(db, session);
      } finally {
        db.sqlite.close();
      }
      // Cleaned closeout uses durable cleanup and release without restoring an obsolete live binding.
      if (session.state !== 'cleaned' && !captureDisposed && !collected)
        backend.restoreSession(environmentPackage, session.attemptId);
      const recoveredStatus = await turnExecutor.resumeAcceptedFinalStatus(
        store,
        environmentPackage,
        session
      );
      return { status: recoveredStatus, turn: store.getTurnById(session.turnId) };
    },
    restoreBackendSession: async (session) => {
      const environmentPackage = await restoreDurableSession(session);
      backend.restoreSession(environmentPackage, session.attemptId);
      if (turnExecutor instanceof WorkerGovernanceTurnExecutor) {
        await turnExecutor.bindNativeHandleRecorder(
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
   * Original session-static Vault material used at open and collection; never persisted.
   * Reuse and restart collection resolve the binding's recorded versions, because the resident host's environment was fixed when it started.
   */
  runtimeEnvironment: Record<string, string> | null;
  /** Original dispatch tokens retained only until closeout; restart uses their durable hashes. */
  liveRouteTokens: [string, string, string] | null;
  runtimeCheckVersions: Array<{
    targetEnvVarName: string;
    vaultReferenceId: string;
    materialVersion: number;
  }> | null;
  /** Predecessor resume pair for a new binding; null starts a new native conversation. */
  readonly nativeResume: WorkerGovernanceNativeResume | null;
  /** AgentSession owner bound by the executor; receives each accepted ready proof at once. */
  recordNativeHandleDigest:
    | ((
        digest: string,
        retainedStorage: { storageRef: string; workSlotRef: string; attachmentGeneration: number }
      ) => void | Promise<void>)
    | null;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly evidence: WorkerGovernanceEvidenceRecord[];
  readonly agentSessionCompatibilityKey: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly harnessBindingRef: string;
  readonly harnessInstanceId: string;
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  readonly attemptId: string;
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
  /** Exact durable sequence returned by enqueue; null while waiting for the command slot. */
  sequence: number | null;
  readonly operation: NanoHostHarnessOperation;
  operationId: string | null;
  readonly reject: (error: Error) => void;
  readonly resolve: (body: Readonly<Record<string, unknown>>) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  /** Original caller cap includes parent admission and the existing Harness slot wait. */
  readonly admittedUnixMs: number;
  deadlineUnixMs: number;
  deadlineMonotonicMs: number;
  /** Positive Core idle binding owner; it does not authorize active or closing Turn cleanup. */
  coreIdleClose?: { readonly consumerReceipt: string; prepared?: PreparedNanoHostHarnessOperation };
  /** Original native descriptors and raw carriage stay with this existing live waiter. */
  journal?: {
    readonly store: FsStore;
    readonly workspaceDb: WorkspaceDb;
    parent: ExecutionJournalIntent;
    child?: ExecutionJournalIntent;
    prepared?: PreparedNanoHostHarnessOperation;
    reader?: ExecutionStepJournalReader;
    consume?: ExecutionJournalIntent;
    resultFingerprint?: string;
    consumerReceipt?: string;
    settlement?: Promise<void>;
  };
}

/** Pre-lease close owner reconstructed from one exact durable AgentSession binding. */
interface NanoHostAgentSessionCloseOwner {
  readonly inspection: NanoHostAgentSessionContinuityInspection;
  pending: PendingNanoHostHarnessOperation | null;
}

/** One compatible physical Sandbox and Harness retained across AgentSessions and Turns. */
interface NanoHostSharedHarness {
  /** Immutable operating declaration consumed by every session.open on this Harness. */
  readonly maxActiveTurns: number;
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
  /** Live-instance deletion proof shared with sibling closeout; never restored or set on uncertainty. */
  writerCleanupProved: boolean;
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

/** Core identity projection only; optional historical backend metadata is read after capture presence. */
type NanoHostCaptureAnchorHint = Pick<
  WorkerBackendSessionRecord,
  | 'attemptId'
  | 'workspaceId'
  | 'packageSnapshotId'
  | 'backendSessionId'
  | 'runtimeTargetId'
  | 'originPhysicalEpoch'
  | 'agentSessionId'
  | 'sandboxBindingRef'
>;

/** One incompatible resident Sandbox whose complete private occupancy is proved idle. */
interface NanoHostIdleSandboxEviction {
  readonly bindings: Array<
    NanoHostAgentSessionContinuityInspection & { readonly lifecycleState: string }
  >;
  readonly bridgeOpen: boolean;
  readonly closeAgentSessions: boolean;
  /** A settled exact local-close refusal requires wider cleanup rather than reuse or replay. */
  readonly closeCleanupRequired: boolean;
  readonly originPhysicalEpoch: string;
  readonly physicalAbsent: boolean;
  readonly sandboxBindingRef: string;
  readonly sandboxCompatibilityKey: string;
  readonly sandboxId: string;
  readonly sandboxRuntimeId: string;
  /** Exact retained resident owner for wider cleanup; never the incoming Turn. */
  readonly retirementOwner: WorkerBackendSessionRecord | null;
}

/** Process-local proof that this attempt created a Sandbox before publishing its session. */
interface LivePartialSandboxMaterialization {
  readonly attachmentGeneration: number;
  readonly expectedRevision: number;
  readonly attemptId: string;
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
  /** Configured identity is shared by admission, effects and observations; deployment placement adds no target. */
  public readonly id = 'nanohost';
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
  /** Serializes live producers onto each Harness's single durable command cell; never replays effects. */
  private readonly harnessOperationSettlements = new Map<string, Promise<void>>();

  /**
   * Creates the NanoHost backend over the composition root's one session dispatcher.
   *
   * @param coreDb Durable Core database and lineage source.
   * @param recordNativeHandleDigest Existing Core recorder for proof on an eviction victim.
   * @param idleCleanup Non-awaiting commit wake and selected completion join, never physical authority.
   * @param sessionDispatch Optional dispatcher; production composition always supplies it.
   * @param workerControlGateway Optional existing semantic worker-control owner.
   * @param collectionVaultBackend Existing Vault owner for private release snapshots.
   * @param readRuntimeConfig Current authored Sandbox capacity configuration.
   * @param sharedStore Existing AgentSession authority for already-completed proof handoff.
   * @param fileAdmission Shared existing file reserve for retained capture metadata.
   */
  public constructor(
    private readonly coreDb: CoreDb,
    private readonly recordNativeHandleDigest: (
      agentSessionId: string,
      digest: string,
      retainedStorage: { storageRef: string; workSlotRef: string; attachmentGeneration: number }
    ) => void | Promise<void>,
    private readonly idleCleanup: {
      readonly onCommit: () => void;
      readonly join: (identity: WorkerGovernanceBackendSessionIdentity) => Promise<void>;
    },
    private readonly sessionDispatch?: NanoHostSessionDispatch,
    private readonly workerControlGateway?: WorkerControlGateway,
    private readonly collectionVaultBackend?: () => VaultBackend,
    private readonly readRuntimeConfig?: () => PublicNetworkConfiguration,
    private readonly sharedStore?: FsStore,
    private readonly fileAdmission?: FileStorageAdmission
  ) {}

  /** Reads the authored aggregate bound; invalid current configuration fails closed. */
  private configuredActiveTurnCapacity(): number {
    const capacity =
      this.readRuntimeConfig?.().openKitConfig.nanohost?.maxActiveTurnsPerSandbox ??
      HARNESS_DEFAULT_MAX_ACTIVE_TURNS;
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('NanoHost active-Turn capacity is invalid.');
    return capacity;
  }

  /** Binds dispatched Turn route tokens and adds Vault values only to private wire bytes. */
  public async acceptHarnessCommand(
    command: NanoHostHarnessCommand
  ): Promise<NanoHostHarnessCommand> {
    const bindingId = command.body.agentSessionRuntimeBindingId;
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.harnessInstanceId === command.harnessInstanceId &&
        candidate.pendingHarnessOperation?.operation === command.operation &&
        candidate.pendingHarnessOperation.sequence === command.sequence &&
        (typeof bindingId !== 'string' || candidate.agentSessionRuntimeBindingId === bindingId)
    );
    const closeOwner =
      !session && typeof bindingId === 'string'
        ? this.agentSessionCloseOwners.get(bindingId)
        : undefined;
    const pending = session?.pendingHarnessOperation ?? closeOwner?.pending;
    if (
      !pending ||
      pending.sequence !== command.sequence ||
      pending.operation !== command.operation ||
      (pending.operationId !== null && pending.operationId !== command.operationId)
    ) {
      throw new Error('NanoHost dispatched operation does not match its live producer.');
    }
    if (pending.coreIdleClose) {
      const prepared = pending.coreIdleClose.prepared;
      if (
        command.operation !== 'session.close' ||
        !prepared ||
        !isDeepStrictEqual(prepared.command, command) ||
        !session
      )
        throw new Error('NanoHost idle close command conflicts with its exact Core producer.');
      pending.operationId = command.operationId;
      const currentReceipt = readNanoHostIdleCloseConsumerReceipt(this.coreDb, {
        harnessInstanceId: command.harnessInstanceId,
        harnessBindingRef: session.harnessBindingRef,
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      });
      const dispatched = this.coreDb.sqlite
        .prepare(`SELECT schema_version AS schemaVersion FROM harness_instance_records
          WHERE harness_instance_id = ? AND harness_binding_ref = ? AND operation = 'session.close'
            AND operation_state = 'dispatched' AND operation_id = ? AND operation_sequence = ?`)
        .get(
          command.harnessInstanceId,
          session.harnessBindingRef,
          command.operationId,
          command.sequence
        );
      if (
        !dispatched ||
        currentReceipt !== pending.coreIdleClose.consumerReceipt ||
        session.pendingHarnessOperation !== pending ||
        this.sessions.get(session.environmentPackage.snapshotId) !== session ||
        Date.now() < pending.admittedUnixMs ||
        Date.now() >= pending.deadlineUnixMs ||
        performance.now() >= pending.deadlineMonotonicMs
      )
        throw new Error(
          'NanoHost idle close Core binding or original cleanup allowance is unavailable.'
        );
      readRetainedV1(dispatched, () => dispatched);
      return { ...command, body: prepared.wireBody };
    }
    const journal = pending.journal;
    if (!journal?.child || !journal.prepared)
      throw new Error('NanoHost dispatched operation has no exact admitted native child.');
    const runtimeEnvironment = session?.runtimeEnvironment;
    const expectedWire = {
      ...journal.prepared.command,
      body:
        command.operation === 'session.open' &&
        runtimeEnvironment &&
        Object.keys(runtimeEnvironment).length > 0
          ? { ...journal.prepared.wireBody, runtimeEnvironment }
          : journal.prepared.wireBody,
    };
    if (
      !isDeepStrictEqual(journal.prepared.command, command) &&
      !isDeepStrictEqual(expectedWire, command)
    )
      throw new Error('NanoHost dispatched command conflicts with its exact prepared carriage.');
    // Core has already committed its redacted dispatch. Retain that fact even if proof fails.
    pending.operationId = command.operationId;
    const started = performance.now();
    const invocation = await journal.store.writeWorkspaceExecutionJournalIntent(
      journal.workspaceDb.workspaceId,
      journal.child
    );
    const remaining = Math.min(
      invocation.remainingMs - (performance.now() - started),
      pending.deadlineUnixMs - Date.now(),
      pending.deadlineMonotonicMs - performance.now()
    );
    if (
      remaining <= 0 ||
      Date.now() < pending.admittedUnixMs ||
      (session?.pendingHarnessOperation !== pending && closeOwner?.pending !== pending) ||
      (session && this.sessions.get(session.environmentPackage.snapshotId) !== session)
    ) {
      throw new Error(
        'NanoHost original native invocation allowance or current producer is unavailable.'
      );
    }
    if (session && (command.operation === 'turn.start' || command.operation === 'session.open')) {
      // Native journal admission can yield after resolution; current Vault authority still owns contact.
      assertCurrentWorkerCredentialAuthority(this.coreDb, session.environmentPackage);
      const attempt = requireNanoHostExecutionAttempt(this.coreDb, session.attemptId);
      if (
        session.turnStopSettlement !== null ||
        attempt.phase !== 'open' ||
        (attempt.deadline !== null && Date.parse(attempt.deadline) <= Date.now())
      )
        throw new Error('NanoHost dispatched execution no longer has its live attempt.');
      if (
        command.operation === 'turn.start' &&
        (attempt.workerControlTokenHash !== journal.prepared.command.body.workerControlTokenHash ||
          attempt.workerInferenceTokenHash !== journal.prepared.command.body.inferenceTokenHash ||
          attempt.workerCapabilityTokenHash !== journal.prepared.command.body.capabilityTokenHash)
      )
        throw new Error('NanoHost dispatched Turn credential binding changed during native proof.');
    }
    const currentBinding = this.coreDb.sqlite
      .prepare(`SELECT h.schema_version AS schemaVersion, b.schema_version AS bindingSchemaVersion,
        h.lifecycle_state AS harnessState,
        h.drain_state AS harnessDrain, s.lifecycle_state AS sandboxState,
        s.health_state AS sandboxHealth, s.drain_state AS sandboxDrain, s.cleanup_state AS sandboxCleanup
        FROM harness_instance_records h JOIN agent_session_runtime_bindings b
          ON b.harness_instance_id = h.harness_instance_id
        JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
        WHERE h.harness_instance_id = ? AND h.harness_binding_ref = ? AND h.operation_id = ? AND h.operation_sequence = ?
          AND h.operation_state = 'dispatched' AND b.agent_session_runtime_binding_id = ?
          AND b.agent_session_id = ?`)
      .get(
        command.harnessInstanceId,
        journal.child.carriage.bindingRef,
        command.operationId,
        command.sequence,
        journal.prepared.command.body.agentSessionRuntimeBindingId,
        journal.prepared.command.body.agentSessionId
      ) as
      | {
          schemaVersion: unknown;
          bindingSchemaVersion: unknown;
          harnessState: string;
          harnessDrain: string;
          sandboxState: string;
          sandboxHealth: string;
          sandboxDrain: string;
          sandboxCleanup: string;
        }
      | undefined;
    if (!currentBinding) throw new Error('NanoHost command binding changed during native proof.');
    readRetainedV1(currentBinding, () => currentBinding);
    readRetainedV1({ schemaVersion: currentBinding.bindingSchemaVersion }, () => currentBinding);
    if (
      (command.operation === 'session.open' || command.operation === 'turn.start') &&
      (currentBinding.harnessState !== 'open' ||
        currentBinding.harnessDrain !== 'accepting' ||
        currentBinding.sandboxState !== 'open' ||
        currentBinding.sandboxHealth !== 'ready' ||
        currentBinding.sandboxDrain !== 'accepting' ||
        currentBinding.sandboxCleanup !== 'clean')
    )
      throw new Error('NanoHost dispatched execution no longer has current resident admission.');
    command = { ...command, body: journal.prepared.wireBody };
    if (command.operation === 'session.open' && session?.runtimeEnvironment === null) {
      throw new Error('NanoHost AgentSession credential material is unavailable.');
    }
    if (command.operation === 'turn.start') {
      if (!session) {
        throw new Error('NanoHost dispatched Turn has no live producer session.');
      }
      try {
        const attemptId = command.body.leaseId;
        const workerControlToken = command.body.workerControlToken;
        const workerInferenceToken = command.body.inferenceToken;
        const workerCapabilityToken = command.body.capabilityToken;
        if (
          attemptId !== session.attemptId ||
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
            'SELECT binding_ref AS sandboxBindingRef FROM scheduler_execution_attempts WHERE attempt_id = ?'
          )
          .get(session.attemptId) as { readonly sandboxBindingRef: string } | undefined;
        if (!lease) {
          throw new Error('NanoHost dispatched Turn lease binding is unavailable.');
        }
        const tokens: [string, string, string] = [
          workerControlToken,
          workerInferenceToken,
          workerCapabilityToken,
        ];
        if (session.liveRouteTokens !== null && !isDeepStrictEqual(session.liveRouteTokens, tokens))
          throw new Error('NanoHost repeated delivery conflicts with live route-token binding.');
        if (session.liveRouteTokens === null) {
          this.workerControlGateway.registerSession(session.environmentPackage, {
            sandboxBindingRef: lease.sandboxBindingRef,
            workerCapabilityToken,
            workerControlToken,
            workerInferenceToken,
          });
          session.liveRouteTokens = tokens;
        }
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

  /** Releases an exact durably fenced delivery into ordinary failure cleanup, never replay. */
  public failHarnessDelivery(
    command: Pick<NanoHostHarnessCommand, 'harnessInstanceId' | 'operationId'>,
    failure?: unknown
  ): void {
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.harnessInstanceId === command.harnessInstanceId &&
        candidate.pendingHarnessOperation?.operationId === command.operationId
    );
    const closeOwner = !session
      ? [...this.agentSessionCloseOwners.values()].find(
          (candidate) =>
            candidate.inspection.harnessInstanceId === command.harnessInstanceId &&
            candidate.pending?.operationId === command.operationId
        )
      : undefined;
    const pending = session?.pendingHarnessOperation ?? closeOwner?.pending;
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    if (session?.pendingHarnessOperation === pending) session.pendingHarnessOperation = null;
    if (closeOwner?.pending === pending) {
      closeOwner.pending = null;
      if (
        this.agentSessionCloseOwners.get(closeOwner.inspection.agentSessionRuntimeBindingId) ===
        closeOwner
      )
        this.agentSessionCloseOwners.delete(closeOwner.inspection.agentSessionRuntimeBindingId);
    }
    pending.reject(
      new Error(`NanoHost Harness ${pending.operation} delivery incomplete: outcome unknown.`, {
        cause: failure,
      })
    );
  }

  /** Acknowledges actual native consumption before resolving the live producer or slot. */
  public async acceptHarnessResult(result: NanoHostHarnessResult): Promise<void> {
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.harnessInstanceId === result.harnessInstanceId &&
        candidate.pendingHarnessOperation?.operationId === result.operationId
    );
    const closeOwner = !session
      ? [...this.agentSessionCloseOwners.values()].find(
          (candidate) =>
            candidate.inspection.harnessInstanceId === result.harnessInstanceId &&
            candidate.pending?.operationId === result.operationId
        )
      : undefined;
    const pending = session?.pendingHarnessOperation ?? closeOwner?.pending;
    if (!pending) {
      if (hasConsumedNanoHostHarnessResult(this.coreDb, result)) return;
      throw new Error('NanoHost Harness result has no available exact consumer.');
    }
    if (pending.coreIdleClose) {
      if (
        pending.operation !== 'session.close' ||
        pending.sequence !== result.sequence ||
        pending.coreIdleClose.prepared?.command.operationId !== result.operationId ||
        !session
      )
        throw new Error('NanoHost idle close result has no exact Core consumer.');
      result = { ...result, body: parseHarnessResultBody(pending.operation, result) };
      // This is replay validation only: the deciding Core transaction already consumed the result.
      acknowledgeNanoHostHarnessResult(this.coreDb, {
        result,
        harnessBindingRef: session.harnessBindingRef,
        consumerReceipt: pending.coreIdleClose.consumerReceipt,
        timestamp: new Date().toISOString(),
      });
    } else {
      const journal = pending.journal;
      if (pending.sequence !== result.sequence || !journal?.child || !journal.reader)
        throw new Error('NanoHost Harness result does not match its native consumer.');
      result = { ...result, body: parseHarnessResultBody(pending.operation, result) };
      const fingerprint = commandInputHash(result).slice('sha256:'.length);
      if (journal.resultFingerprint !== undefined && journal.resultFingerprint !== fingerprint)
        throw new Error('NanoHost Harness consumer result replay conflicts.');
      journal.resultFingerprint = fingerprint;
      // Retained result evidence permits replay, but an unavailable consumer cannot
      // turn the original bounded producer wait into an unbounded live invocation.
      const binding = session?.harnessBindingRef ?? closeOwner!.inspection.harnessBindingRef;
      // Concurrent identical HTTP replays share only this existing waiter's current consumption.
      journal.settlement ??= this.consumeHarnessResult(pending, result, binding).catch((error) => {
        delete journal.settlement;
        throw error;
      });
      await journal.settlement;
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    if (session?.pendingHarnessOperation === pending) session.pendingHarnessOperation = null;
    if (closeOwner?.pending === pending) {
      closeOwner.pending = null;
      if (
        this.agentSessionCloseOwners.get(closeOwner.inspection.agentSessionRuntimeBindingId) ===
        closeOwner
      )
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

  /** Builds local receipt progress from the exact native child, without admitting another effect. */
  private harnessConsumptionIntent(
    child: ExecutionJournalIntent,
    fingerprint: string
  ): ExecutionJournalIntent {
    return {
      ...child,
      stepId: randomUUID(),
      parentStepId: null,
      parent: null,
      inspectedStep: { execution: child.execution.ref, stepId: child.stepId },
      control: {
        ...child.control,
        kind: 'consume-receipt',
        target: null,
        invocationId: randomUUID(),
        inputRefs: [fingerprint],
        outputRefs: [],
        fingerprint: commandInputHash({ child: child.control.fingerprint, result: fingerprint }),
        deadlineUnixNano: null,
      },
      span: {
        ...child.span,
        spanId: randomBytes(8).toString('hex'),
        parentSpanId: child.execution.span.spanId,
        startTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
        name: 'worker.consume-receipt',
        links: [
          {
            traceId: child.span.traceId,
            spanId: child.span.spanId,
            flags: child.span.flags,
            attributes: [],
            droppedAttributesCount: 0,
          },
        ],
      },
    };
  }

  /** Completes the existing Core/Workspace handoff; replay inspects immutable native outcomes. */
  private async consumeHarnessResult(
    pending: PendingNanoHostHarnessOperation,
    result: NanoHostHarnessResult,
    harnessBindingRef: string
  ): Promise<void> {
    const journal = pending.journal!;
    const child = journal.child!;
    const fingerprint = journal.resultFingerprint!;
    journal.consume ??= this.harnessConsumptionIntent(child, fingerprint);
    const consume = journal.consume;
    const state =
      result.disposition === 'succeeded'
        ? 'completed'
        : result.disposition === 'refused'
          ? 'failed'
          : 'unknown';
    const childRef = { execution: child.execution.ref, stepId: child.stepId };
    const original = await journal.reader!.readInvocation(childRef);
    if (original.state === 'intent') {
      await endWorkerTurnJournalStep(
        journal.store,
        journal.workspaceDb,
        child,
        state,
        [fingerprint],
        consume
      );
    } else {
      if (
        original.state !== state ||
        !isDeepStrictEqual(original.control.outputRefs, [fingerprint])
      )
        throw new Error('NanoHost Harness native outcome replay conflicts.');
      // The original atomic companion must already exist; replay must not repair a missing tuple.
      const retained = await journal.reader!.readInvocation({
        execution: consume.execution.ref,
        stepId: consume.stepId,
      });
      if (retained.state === 'intent')
        await journal.store.writeWorkspaceExecutionJournalIntent(
          journal.workspaceDb.workspaceId,
          consume
        );
      else if (
        retained.state !== 'completed' ||
        !isDeepStrictEqual(retained.control.outputRefs, [fingerprint])
      )
        throw new Error('NanoHost Harness retained consumption replay conflicts.');
    }
    const receipt = JSON.stringify({
      workspaceId: journal.workspaceDb.workspaceId,
      turnId: child.execution.workId,
      executionId: child.execution.ref.executionId,
      stepId: consume.stepId,
    });
    acknowledgeNanoHostHarnessResult(this.coreDb, {
      result,
      harnessBindingRef,
      consumerReceipt: receipt,
      timestamp: new Date().toISOString(),
    });
    const consumed = await journal.reader!.readInvocation({
      execution: consume.execution.ref,
      stepId: consume.stepId,
    });
    if (consumed.state === 'intent') {
      await endWorkerTurnJournalStep(journal.store, journal.workspaceDb, consume, 'completed', [
        fingerprint,
      ]);
    } else if (
      consumed.state !== 'completed' ||
      !isDeepStrictEqual(consumed.control.outputRefs, [fingerprint])
    ) {
      throw new Error('NanoHost Harness receipt consumption replay conflicts.');
    }
    journal.consumerReceipt = receipt;
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
      writerCleanupProved: false,
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
      row.maxOpenSessions !== Math.max(8, row.maxActiveTurns) ||
      !Number.isSafeInteger(row.maxActiveTurns) ||
      row.maxActiveTurns < 1 ||
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
      writerCleanupProved: false,
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
      maxActiveTurns: row.maxActiveTurns,
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
  public restoreSession(environmentPackage: AgentEnvironmentPackage, attemptId: string): void {
    if (this.sessions.has(environmentPackage.snapshotId)) {
      return;
    }
    const provenance = this.requireDurableAgentSessionProvenance(environmentPackage, attemptId);
    const expectedSandboxKey = provenance.sandboxCompatibilityKey;
    const expectedHarnessKey = provenance.harnessCompatibilityKey;
    const expectedSessionKey = provenance.agentSessionCompatibilityKey;
    const adapterId = nanoHostAdapterId(environmentPackage);
    const durableSession = provenance.anchor;
    const identity = this.durableBackendSessionIdentity(durableSession);
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
      attemptId: attemptId,
      nativeResume: null,
      nativeSessionReusable: false,
      recordNativeHandleDigest: null,
      pendingImports: [],
      runtimeEnvironment: null,
      liveRouteTokens: null,
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
    environmentPackage: AgentEnvironmentPackagePreview
  ): Promise<AgentEnvironmentValidationDiagnostic[]> {
    const diagnostics = validateAgentEnvironmentPackageForBackend(
      environmentPackage,
      await this.describeCapabilities()
    );
    if (
      environmentPackage.credentials.declarations.some(
        (declaration) => declaration.visibility !== 'runtime-env'
      )
    )
      diagnostics.push({
        code: 'backend_missing_required_capability',
        path: '$.credentials.declarations',
        message: 'NanoHost persistent Worker images admit only runtime-env credentials.',
      });
    return diagnostics;
  }

  /** Plans a durable identity against the one configured RuntimeTarget without effects. */
  public planSession(
    environmentPackage: AgentEnvironmentPackagePreview
  ): WorkerGovernanceBackendSessionIdentity {
    const restored = this.sessions.get(environmentPackage.snapshotId);
    if (restored) return restored.identity;
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

  /** Proves retained continuity or closes the local binding, widening a settled refusal to Sandbox retirement. */
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
    const retirement = input.environmentPackage
      ? this.inspectIncompatibleIdleSandbox(input.environmentPackage)
      : null;
    const widerRetirement =
      retirement && retirement !== 'capacity-saturated' && retirement.closeCleanupRequired;
    const replacesRequestedBinding =
      widerRetirement &&
      retirement.bindings.some((binding) => binding.agentSessionId === input.agentSessionId);
    if (widerRetirement) {
      if (!input.reuseAllowed || (!replacesRequestedBinding && input.admissionAttemptId)) {
        if (!input.admissionAttemptId || !input.admissionAgentSessionId) {
          throw new Error('NanoHost AgentSession retirement lacks admission lineage.');
        }
        const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.admissionAttemptId);
        if (
          attempt.phase !== 'open' ||
          attempt.operationId !== null ||
          attempt.backendId !== this.id ||
          attempt.turnId !== input.environmentPackage!.scope.turnId ||
          attempt.agentSessionId !== input.admissionAgentSessionId ||
          attempt.workspaceId !== input.workspaceId ||
          attempt.threadId !== input.threadId ||
          input.environmentPackage!.scope.agentSessionId !== input.admissionAgentSessionId ||
          input.environmentPackage!.scope.workspaceId !== input.workspaceId ||
          input.environmentPackage!.scope.threadId !== input.threadId
        ) {
          throw new Error(
            'NanoHost AgentSession retirement admission lineage changed concurrently.'
          );
        }
      }
      // Preserve read-only continuity inspection. Only the subsequent retirement may delete.
      for (const binding of retirement.bindings) {
        await this.handoffDurableAgentSessionProof(
          binding,
          binding.agentSessionId === input.agentSessionId
            ? input.recordNativeHandleDigest
            : undefined
        );
      }
      // Shared residency does not imply this Thread has a predecessor.
      // Fresh admission retires the resident through the existing eviction below only after acquiring its attempt.
      if (input.reuseAllowed && replacesRequestedBinding) return 'sandbox-replacement-required';
    }
    const inspection = replacesRequestedBinding
      ? null
      : inspectNanoHostAgentSessionContinuity(this.coreDb, input);
    if (!inspection) {
      if (input.environmentPackage && input.admissionAttemptId) {
        const responsibleUserId = responsibleUserIdForActor(
          input.environmentPackage.scope.triggerActor
        );
        if (!responsibleUserId) throw new Error('Idle retirement lacks requester authority.');
        try {
          const released = await this.evictIncompatibleIdleSandbox(
            input.environmentPackage,
            false,
            this.workerStorageReplacementSelection(
              input.environmentPackage,
              input.workerStorageChoice,
              responsibleUserId,
              currentWorkerStorageAudienceAuthorizer(
                this.coreDb,
                input.environmentPackage,
                this.readRuntimeConfig,
                this.sharedStore ?? new FsStore({ dataRoot: this.coreDb.dataRoot })
              )
            )
          );
          if (released && input.workerStorageChoice?.kind === 'selected')
            return {
              disposition: 'closed',
              storageRevisionAdvance: {
                attachmentGeneration: released.attachmentGeneration,
                previousRevision: input.workerStorageChoice.expectedRevision,
                revision: released.revision,
                storageRef: released.storageRef,
              },
            };
        } catch (error) {
          // A settled local refusal permits one no-effect deferral; failed wider cleanup must terminate it.
          if (widerRetirement) throw error;
          // This retirement is owned exclusively by the old resident. The incoming Turn has no Session or backend effect yet.
          if (
            this.inspectIncompatibleIdleSandbox(input.environmentPackage) === 'capacity-saturated'
          )
            throw new WorkerGovernanceCapacityUnavailableError(
              'Resident retirement awaits definite cleanup or predecessor Epoch fencing and fresh readiness.'
            );
          throw error;
        }
      }
      return 'absent';
    }
    // Compatibility decides placement, never whether an already-accepted proof survives.
    if (input.recordNativeHandleDigest) {
      await this.handoffDurableAgentSessionProof(inspection, input.recordNativeHandleDigest);
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
        !input.admissionAttemptId ||
        input.environmentPackage.scope.agentSessionId !== input.admissionAgentSessionId ||
        this.requireAttemptId(input.environmentPackage.snapshotId) !== input.admissionAttemptId
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
        true,
        this.workerStorageReplacementSelection(
          input.environmentPackage,
          input.workerStorageChoice,
          responsibleUserId,
          currentWorkerStorageAudienceAuthorizer(
            this.coreDb,
            input.environmentPackage,
            this.readRuntimeConfig,
            this.sharedStore ?? new FsStore({ dataRoot: this.coreDb.dataRoot })
          )
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
          currentWorkerStorageAudienceAuthorizer(
            this.coreDb,
            environmentPackage,
            this.readRuntimeConfig,
            this.sharedStore ?? new FsStore({ dataRoot: this.coreDb.dataRoot })
          )
        )!
      );
    }
    try {
      await this.closeDurableAgentSession(inspection);
    } catch (error) {
      if (input.environmentPackage && input.admissionAttemptId && input.admissionAgentSessionId) {
        const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.admissionAttemptId);
        const retirement = this.inspectIncompatibleIdleSandbox(input.environmentPackage);
        if (
          attempt.phase === 'open' &&
          attempt.disposition === 'not_accepted' &&
          attempt.operationId === null &&
          attempt.deadline === null &&
          attempt.backendId === this.id &&
          attempt.agentSessionId === input.admissionAgentSessionId &&
          attempt.workspaceId === input.workspaceId &&
          attempt.threadId === input.threadId &&
          attempt.turnId === input.environmentPackage.scope.turnId &&
          input.environmentPackage.scope.agentSessionId === input.admissionAgentSessionId &&
          input.environmentPackage.scope.workspaceId === input.workspaceId &&
          input.environmentPackage.scope.threadId === input.threadId &&
          retirement &&
          retirement !== 'capacity-saturated' &&
          retirement.closeCleanupRequired &&
          retirement.bindings.some(
            (binding) =>
              binding.agentSessionRuntimeBindingId === inspection.agentSessionRuntimeBindingId &&
              binding.harnessInstanceId === inspection.harnessInstanceId
          )
        ) {
          // Only the predecessor close had effects. Requeue the same Turn so its next placement owns wider cleanup.
          throw new WorkerGovernanceCapacityUnavailableError(
            'The idle predecessor requires whole-Sandbox retirement before admission.'
          );
        }
      }
      throw error;
    }
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

  /** Reports exact Core idle ownership or prepares original results; performs no effect. */
  public prepareCleanupRecovery(identity: WorkerGovernanceBackendSessionIdentity): boolean {
    const anchor = getWorkerBackendSession(
      this.coreDb,
      this.requireAttemptId(identity.packageSnapshotId)
    );
    if (
      anchor &&
      requireSchedulerExecutionAttempt(this.coreDb, anchor.attemptId).phase === 'closed'
    ) {
      if (!hasIdleCleanupExecution(this.coreDb, anchor)) return false;
      this.idleCleanup.onCommit();
      return true;
    }
    if (this.cleanupRecoveryResults.has(identity.packageSnapshotId)) {
      return false;
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
      return false;
    }
    if (durableCleanupFailure) {
      return false;
    }
    const result = this.createCleanupRecoveryResult(
      identity,
      this.requireCleanupOriginPhysicalEpoch(identity, durableSandbox?.originPhysicalEpoch)
    );
    if (!result) {
      throw new Error('NanoHost result-only cleanup dispatcher is unavailable.');
    }
    this.cleanupRecoveryResults.set(identity.packageSnapshotId, result);
    return false;
  }

  /** Projects a correlated physical deletion to every live owner of that exact instance. */
  private markProvedSandboxDeletion(bindingRef: string, originPhysicalEpoch: string): void {
    const scopes = new Set([
      ...this.sharedSandboxes.values(),
      ...[...this.sessions.values()].map((session) => session.sharedHarness.sandbox),
    ]);
    for (const scope of scopes) {
      if (
        scope.sandboxBindingRef === bindingRef &&
        scope.originPhysicalEpoch === originPhysicalEpoch
      ) {
        scope.writerCleanupProved = true;
        scope.bridgeOpen = false;
      }
    }
  }

  /** Transfers every sole ready proof before a Sandbox-wide binding cascade, including idle siblings. */
  private async handoffSandboxAgentSessionProofs(
    bindingRef: string,
    retirement?: Pick<
      NanoHostIdleSandboxEviction,
      'originPhysicalEpoch' | 'physicalAbsent' | 'sandboxBindingRef'
    >
  ): Promise<void> {
    const bindings = this.coreDb.sqlite
      .prepare(`
      SELECT b.agent_session_id AS agentSessionId,
        b.agent_session_runtime_binding_id AS agentSessionRuntimeBindingId,
        h.harness_instance_id AS harnessInstanceId, h.harness_binding_ref AS harnessBindingRef,
        h.harness_compatibility_key AS harnessCompatibilityKey, b.native_handle_digest AS nativeHandleDigest
      FROM agent_session_runtime_bindings b JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
      JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
      WHERE s.sandbox_binding_ref = ? AND b.native_handle_state = 'ready'
    `)
      .all(bindingRef) as Array<Omit<NanoHostAgentSessionContinuityInspection, 'reusable'>>;
    for (const binding of bindings) {
      const candidates = [...this.sessions.values()].filter(
        (session) =>
          session.agentSessionRuntimeBindingId === binding.agentSessionRuntimeBindingId &&
          session.harnessBindingRef === binding.harnessBindingRef
      );
      const live =
        candidates.find((session) => session.acceptedProofUnrecorded) ??
        candidates.find((session) => session.recordNativeHandleDigest);
      // The recorder already acknowledged this immutable ready proof in this process.
      if (live?.acceptedProofUnrecorded === false) continue;
      if (live?.recordNativeHandleDigest && binding.nativeHandleDigest) {
        await this.recordAcceptedNativeHandleDigest(live, binding.nativeHandleDigest);
      } else {
        await this.handoffDurableAgentSessionProof(
          { ...binding, reusable: false },
          undefined,
          retirement
        );
      }
    }
  }

  /** Completes Core handoff after known physical deletion; a failed transfer retains and fences its rows. */
  private async finishProvedSandboxCleanup(scope: NanoHostSharedSandbox): Promise<void> {
    try {
      await this.handoffSandboxAgentSessionProofs(scope.sandboxBindingRef);
      if (
        getWorkerStorageBindingForSandbox(this.coreDb, {
          sandboxBindingRef: scope.sandboxBindingRef,
        })
      )
        this.releaseWorkerStorageForSandbox(scope.sandboxBindingRef);
      removeNanoHostSandboxRuntimeByBinding(this.coreDb, scope.sandboxBindingRef);
      if (
        this.sharedSandboxes.get(scope.sandboxCompatibilityKey)?.sandboxBindingRef ===
        scope.sandboxBindingRef
      )
        this.forgetSharedSandbox(scope.sandboxCompatibilityKey);
    } catch (error) {
      fenceNanoHostSandboxRuntime(this.coreDb, {
        sandboxBindingRef: scope.sandboxBindingRef,
        timestamp: new Date().toISOString(),
      });
      this.fenceWorkerStorageForSandbox(scope.sandboxBindingRef);
      throw error;
    }
  }

  /** Clears Turn staging and retains its inspected cleanup handle through the release fence. */
  public async cleanupSession(
    identity: WorkerGovernanceBackendSessionIdentity,
    options?: { readonly failedCloseout: boolean; readonly wholeSandbox?: boolean }
  ): Promise<void> {
    const attemptId = this.requireAttemptId(identity.packageSnapshotId);
    const session = this.sessions.get(identity.packageSnapshotId);
    const anchor = getWorkerBackendSession(this.coreDb, attemptId);
    if (
      anchor &&
      requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase === 'closed' &&
      hasIdleCleanupExecution(this.coreDb, anchor)
    ) {
      await this.idleCleanup.join(identity);
      this.workerControlGateway?.unregisterSession(identity.packageSnapshotId);
      this.sessions.delete(identity.packageSnapshotId);
      return;
    }
    const durableSandbox = this.findDurableSandboxBinding(identity);
    const durableBackend =
      session || durableSandbox ? null : this.findDurableBackendSession(identity);
    const durableCleanupFailure =
      durableBackend?.state === 'cleanup-failed' ? durableBackend : null;
    const pendingStorage =
      durableBackend?.state === 'cleanup-pending'
        ? this.findWorkerStorageForFailedMaterialization(durableBackend)
        : null;
    const disposedCaptures = await this.assertWorkspaceCaptureSettled(
      session?.sharedHarness.sandbox.sandboxBindingRef ??
        durableSandbox?.sandboxBindingRef ??
        durableBackend?.sandboxBindingRef ??
        null
    );
    const abandonedCapture = disposedCaptures.has(attemptId);
    let retainUnrecordedProof = false;
    try {
      const epoch =
        session?.sharedHarness.sandbox.originPhysicalEpoch ??
        durableSandbox?.originPhysicalEpoch ??
        (
          this.coreDb.sqlite
            .prepare(
              'SELECT origin_physical_epoch AS epoch FROM worker_backend_sessions WHERE attempt_id = ?'
            )
            .get(attemptId) as { epoch: string } | undefined
        )?.epoch;
      const provedScope = [
        session?.sharedHarness.sandbox,
        ...[...this.sessions.values()].map((candidate) => candidate.sharedHarness.sandbox),
      ].find(
        (scope) =>
          scope?.writerCleanupProved &&
          scope.runtimeTargetId === identity.runtimeTargetId &&
          scope.originPhysicalEpoch === epoch &&
          scope.sandboxId === nanoHostSandboxIdFromBackendSessionId(identity.backendSessionId)
      );
      if (provedScope) {
        try {
          await this.finishProvedSandboxCleanup(provedScope);
        } catch (error) {
          retainUnrecordedProof = !!session;
          throw error;
        }
        return;
      }
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
      // A no-effect closing attempt has no authority to clean a shared resident or its idle AS.
      const untouchedResident =
        (session || durableSandbox) &&
        this.coreDb.sqlite
          .prepare(`
        SELECT 1 FROM scheduler_execution_attempts a WHERE a.attempt_id = ?
          AND a.backend_id = ? AND a.agent_session_id = ? AND a.input_ref = ?
          AND a.phase IN ('closing', 'closed') AND a.disposition IN ('unknown', 'not_accepted')
          AND a.operation_id IS NULL AND a.deadline IS NULL
          AND a.last_accepted_heartbeat_at IS NULL AND a.last_worker_sequence IS NULL
          AND a.worker_process_key_hash IS NULL AND a.worker_control_token_hash IS NULL
          AND a.worker_inference_token_hash IS NULL AND a.worker_capability_token_hash IS NULL
          AND NOT EXISTS (SELECT 1 FROM agent_session_runtime_bindings b
            WHERE b.current_attempt_id = a.attempt_id)
        `)
          .get(attemptId, this.id, identity.agentSessionId, identity.packageSnapshotId);
      if (this.failedPreSandboxPreparations.has(identity.packageSnapshotId) || untouchedResident)
        return;
      if (
        durableSandbox &&
        nanoHostSandboxIdFromBackendSessionId(identity.backendSessionId) !==
          nanoHostSandboxId(durableSandbox.sandboxCompatibilityKey)
      )
        throw new Error('NanoHost cleanup identity contradicts its physical Sandbox.');
      // A retained idle invocation can consume its actual result without renewed contact.
      // Missing result evidence still requires the existing later-Epoch absence proof.
      if (
        !session &&
        durableSandbox &&
        (durableSandbox.cleanupState === 'unknown' ||
          (durableSandbox.drainState === 'draining' &&
            requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase === 'closed' &&
            this.readCurrentPhysicalEpoch(identity.runtimeTargetId) !==
              durableSandbox.originPhysicalEpoch))
      ) {
        if (
          durableSandbox.cleanupState === 'unknown' &&
          (durableSandbox.lifecycleState !== 'failed' ||
            durableSandbox.healthState !== 'unknown' ||
            durableSandbox.drainState !== 'draining')
        ) {
          throw new Error('NanoHost unknown cleanup fence is contradictory.');
        }
        const resultOnly =
          requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase === 'closed' &&
          this.readCurrentPhysicalEpoch(identity.runtimeTargetId) ===
            durableSandbox.originPhysicalEpoch
            ? (this.cleanupRecoveryResults.get(identity.packageSnapshotId) ??
              this.createCleanupRecoveryResult(identity, durableSandbox.originPhysicalEpoch))
            : null;
        if (resultOnly) {
          this.cleanupRecoveryResults.set(identity.packageSnapshotId, resultOnly);
        } else {
          this.requireLaterFreshRuntimeTarget(
            durableSandbox.runtimeTargetId,
            durableSandbox.originPhysicalEpoch,
            identity.deploymentId
          );
          // Physical absence does not erase accepted native proof or its immutable storage lineage.
          await this.handoffSandboxAgentSessionProofs(durableSandbox.sandboxBindingRef);
          this.releaseWorkerStorageForSandbox(durableSandbox.sandboxBindingRef);
          removeNanoHostSandboxRuntimeByBinding(this.coreDb, durableSandbox.sandboxBindingRef);
          this.forgetSharedSandbox(durableSandbox.sandboxCompatibilityKey);
          return;
        }
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
      // Draining forbids retaining reusable residency: close this binding through its own proof,
      // so its ordinary attempt can release without deleting under an unsettled sibling.
      const closeInspectedBinding =
        !!session &&
        session.turnStarted &&
        session.terminalInspectionComplete &&
        (!session.nativeSessionReusable ||
          !!options?.failedCloseout ||
          this.findDurableSandboxBinding(identity)?.drainState === 'draining') &&
        !!agentSessionId &&
        session.sharedHarness.bindings.has(agentSessionId);
      let widenCleanup = abandonedCapture || options?.wholeSandbox === true;
      if (!widenCleanup && (closeUnprovedOwner || closeInspectedBinding) && session) {
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
        let awaitingCleanupResult = false;
        try {
          const cleanupInput = {
            attemptId: attemptId,
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
            awaitingCleanupResult = true;
            const retained = await recoveryResult.finally(() =>
              this.cleanupRecoveryResults.delete(identity.packageSnapshotId)
            );
            requireNanoHostResultObject(retained.result);
            awaitingCleanupResult = false;
            if (retained.kind === 'sandbox.delete' && durableSandbox)
              this.markProvedSandboxDeletion(
                durableSandbox.sandboxBindingRef,
                durableSandbox.originPhysicalEpoch
              );
            if (retained.kind === 'bridge.close') {
              if (durableSandbox)
                drainNanoHostSandboxAdmission(this.coreDb, {
                  sandboxBindingRef: durableSandbox.sandboxBindingRef,
                  originPhysicalEpoch: durableSandbox.originPhysicalEpoch,
                });
              await this.effect(
                identity,
                attemptId,
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
          // A result-only wait accounts for a previously uncertain dispatch, never a new cleanup effect.
          if (awaitingCleanupResult && durableSandbox) {
            fenceNanoHostSandboxRuntime(this.coreDb, {
              sandboxBindingRef: durableSandbox.sandboxBindingRef,
              timestamp: new Date().toISOString(),
            });
            this.fenceWorkerStorageForSandbox(durableSandbox.sandboxBindingRef);
          }
          if (session) {
            session.nativeSessionReusable = false;
            this.forgetSharedSandbox(session.sharedHarness.sandbox.sandboxCompatibilityKey);
          }
          throw error;
        }
        if (session) {
          try {
            await this.finishProvedSandboxCleanup(session.sharedHarness.sandbox);
          } catch (error) {
            retainUnrecordedProof = true;
            throw error;
          }
        } else if (durableSandbox) {
          await this.handoffSandboxAgentSessionProofs(durableSandbox.sandboxBindingRef);
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
        // The same Turn still owns its retained binding until its real release fence. A drain
        // can arrive during journal/projection publication after this cleanup returns.
        const retainForRelease =
          session?.turnStarted &&
          session.terminalInspectionComplete &&
          requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase !== 'closed';
        if (!retainForRelease) this.sessions.delete(identity.packageSnapshotId);
      }
      this.failedPreSandboxPreparations.delete(identity.packageSnapshotId);
    }
  }

  /** Joins per-attempt bindings to the current physical binding lifetime or exact retiring owner. */
  private workspaceCaptureAnchors(sandboxBindingRef: string): NanoHostCaptureAnchorHint[] {
    const anchors = this.coreDb.sqlite
      .prepare(`SELECT schema_version AS schemaVersion, attempt_id AS attemptId,
      workspace_id AS workspaceId, package_snapshot_id AS packageSnapshotId,
      backend_session_id AS backendSessionId, runtime_target_id AS runtimeTargetId,
      origin_physical_epoch AS originPhysicalEpoch, agent_session_id AS agentSessionId,
      sandbox_binding_ref AS sandboxBindingRef FROM worker_backend_sessions ORDER BY attempt_id`)
      .all() as Array<NanoHostCaptureAnchorHint & { schemaVersion: unknown }>;
    for (const anchor of anchors) {
      readRetainedV1(anchor, () => anchor);
      requireStoredNanoHostPhysicalEpoch(anchor.originPhysicalEpoch);
      if (
        Object.entries(anchor).some(
          ([key, value]) => key !== 'schemaVersion' && (typeof value !== 'string' || !value)
        )
      )
        throw new Error('Workspace capture backend identity is invalid.');
    }
    const original = anchors.find((anchor) => anchor.sandboxBindingRef === sandboxBindingRef);
    const residents = this.coreDb.sqlite
      .prepare(`SELECT sandbox_runtime_id AS id,
      sandbox_binding_ref AS binding, runtime_target_id AS target,
      origin_physical_epoch AS epoch, sandbox_compatibility_key AS compatibility
      FROM sandbox_runtime_records WHERE sandbox_binding_ref=?
        OR (runtime_target_id=? AND origin_physical_epoch=?)`)
      .all(
        sandboxBindingRef,
        original?.runtimeTargetId ?? null,
        original?.originPhysicalEpoch ?? null
      ) as Array<{
      id: string;
      binding: string;
      target: string;
      epoch: string;
      compatibility: string;
    }>;
    const resident = residents.find(
      (row) =>
        row.binding === sandboxBindingRef ||
        (original &&
          nanoHostSandboxId(row.compatibility) ===
            nanoHostSandboxIdFromBackendSessionId(original.backendSessionId))
    );
    if (!resident && !original) return [];
    const target = resident?.target ?? original!.runtimeTargetId;
    const epoch = resident?.epoch ?? original!.originPhysicalEpoch;
    const sandboxId = resident
      ? nanoHostSandboxId(resident.compatibility)
      : nanoHostSandboxIdFromBackendSessionId(original!.backendSessionId);
    const sessions = resident
      ? new Set(
          (
            this.coreDb.sqlite
              .prepare(`SELECT b.agent_session_id AS id
      FROM agent_session_runtime_bindings b JOIN harness_instance_records h
        ON h.harness_instance_id=b.harness_instance_id WHERE h.sandbox_runtime_id=?`)
              .all(resident.id) as Array<{ id: string }>
          ).map((row) => row.id)
        )
      : null;
    // Attempt bindings differ across current siblings; proved deletion removes their runtime
    // bindings, so an old abandoned source cannot gate a later same-name Sandbox incarnation.
    return anchors.filter(
      (anchor) =>
        anchor.runtimeTargetId === target &&
        anchor.originPhysicalEpoch === epoch &&
        nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId) === sandboxId &&
        (!sessions ||
          sessions.has(anchor.agentSessionId) ||
          anchor.attemptId === original?.attemptId)
    );
  }

  /** Checks exact durable backend keys, never a filesystem inventory or a replacement attachment. */
  private async assertWorkspaceCaptureSettled(
    sandboxBindingRef: string | null
  ): Promise<Set<string>> {
    const disposed = new Set<string>();
    if (!sandboxBindingRef) return disposed;
    for (const anchor of this.workspaceCaptureAnchors(sandboxBindingRef)) {
      const admitted = isScopeAdmitted(this.coreDb.dataRoot, 'workspace', anchor.workspaceId);
      const db = admitted
        ? openWorkspaceDb(this.coreDb.dataRoot, anchor.workspaceId)
        : this.openRetiringWorkspaceDb(anchor.workspaceId);
      try {
        if (admitted) applyScopedMigrations(db);
        if (
          await hasPendingWorkspaceCapture(
            this.coreDb,
            db,
            anchor,
            undefined,
            admitted ? this.sharedStore : undefined
          )
        )
          throw new WorkspaceCaptureRecoveryRequired(
            'Original Workspace capture requires durable recovery disposition.'
          );
        if (
          listWorkspaceReconciliationRecords(db, anchor.workspaceId).some(
            (record) =>
              record.id.startsWith('wrr_capture_') &&
              record.stateAfter === 'unrecoverable' &&
              record.backendHandleSummary.attemptId === anchor.attemptId
          )
        )
          disposed.add(anchor.attemptId);
      } catch (error) {
        throw new WorkspaceCaptureRecoveryRequired(
          'Original Workspace capture proof is unavailable; recovery is required.',
          { cause: error }
        );
      } finally {
        db.sqlite.close();
      }
    }
    return disposed;
  }

  /** Retains only the physical producer in the existing result map, never its later reconcile join. */
  private async idleCleanupEffect(
    identity: WorkerGovernanceBackendSessionIdentity,
    attemptId: string,
    operation: 'bridge.close' | 'sandbox.delete',
    input: Readonly<Record<string, unknown>>,
    originPhysicalEpoch?: string,
    predecessor?: ExecutionCandidate
  ): Promise<void> {
    const request = createNanoHostEffectRequest(identity, attemptId, operation, input);
    const result = this.effect(
      identity,
      attemptId,
      operation,
      input,
      originPhysicalEpoch,
      undefined,
      predecessor
    ).then((result) => ({ kind: operation, result }));
    this.cleanupRecoveryResults.set(identity.packageSnapshotId, result);
    try {
      await result;
    } finally {
      if (this.cleanupRecoveryResults.get(identity.packageSnapshotId) === result) {
        this.cleanupRecoveryResults.delete(identity.packageSnapshotId);
        // Clearing a posted original can expose its committed continuation. A pre-intent
        // refusal has no commit to rediscover and must not schedule its own retry.
        if (
          this.coreDb.sqlite.open &&
          this.coreDb.sqlite
            .prepare('SELECT 1 FROM control_executions WHERE id = ?')
            .get(`idle-cleanup:${request.requestId}`)
        )
          this.idleCleanup.onCommit();
      }
    }
  }

  /** Executes exactly one selected leaf, with no normal cleanup classifier or recursive join. */
  public async advanceIdleCleanup(selection: IdleCleanupSelection): Promise<void> {
    const { identity, candidate, originPhysicalEpoch, sandboxBindingRef } = selection;
    // This includes the original first delivery and registered result-only waiters.
    if (this.cleanupRecoveryResults.has(identity.packageSnapshotId)) return;
    const attemptId = this.requireAttemptId(identity.packageSnapshotId);
    const anchor = getWorkerBackendSession(this.coreDb, attemptId);
    const resident = this.findDurableSandboxBinding(identity);
    if (
      !anchor ||
      !resident ||
      !isDeepStrictEqual(this.durableBackendSessionIdentity(anchor), identity) ||
      resident.sandboxBindingRef !== sandboxBindingRef ||
      resident.originPhysicalEpoch !== originPhysicalEpoch ||
      requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase !== 'closed'
    )
      throw new Error('Selected idle cleanup has no exact current resident.');
    await this.assertWorkspaceCaptureSettled(sandboxBindingRef);
    const root = readExecutionJournalRoot(this.coreDb, candidate.ref.execution);
    if (
      root.revision !== candidate.revision ||
      root.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION
    )
      throw new Error('Selected idle cleanup revision changed.');
    // A producer can become visible during the capture await; it keeps its original delivery.
    if (this.cleanupRecoveryResults.has(identity.packageSnapshotId)) return;
    const sameEpoch =
      this.readCurrentPhysicalEpoch(identity.runtimeTargetId) === originPhysicalEpoch;
    if (selection.action === 'delete' || (selection.action === 'release' && sameEpoch)) {
      const reader = createExecutionStepJournalReader(this.coreDb, { kind: 'server' });
      const original = await reader.readInvocation(candidate.ref);
      const linked = await reader.readLinkedInspections(candidate.ref);
      if (
        original.state !== 'completed' ||
        original.carriage.operation !==
          (selection.action === 'delete' ? 'bridge.close' : 'sandbox.delete') ||
        original.control.outputRefs.length !== 1 ||
        !/^sha256:[0-9a-f]{64}$/.test(original.control.outputRefs[0]!) ||
        !linked.some(
          ({ inspection }) =>
            inspection.state === 'completed' &&
            inspection.control.kind === 'consume-receipt' &&
            inspection.ref.execution.executionId === candidate.ref.execution.executionId &&
            inspection.ref.stepId === `${candidate.ref.stepId}:consume` &&
            inspection.control.operationId === original.carriage.requestId &&
            isDeepStrictEqual(inspection.control.inputRefs, original.control.outputRefs) &&
            isDeepStrictEqual(inspection.control.outputRefs, original.control.outputRefs)
        )
      )
        throw new Error('Selected idle cleanup has no exact consumed physical proof.');
    }
    if (selection.action === 'delete') {
      await this.idleCleanupEffect(
        identity,
        attemptId,
        'sandbox.delete',
        {
          attemptId,
          sandboxId: nanoHostSandboxIdFromBackendSessionId(identity.backendSessionId),
        },
        originPhysicalEpoch,
        candidate
      );
      return;
    }
    if (selection.action === 'result-only') {
      if (!this.sessionDispatch?.expectResultOnly)
        throw new Error('NanoHost result-only cleanup dispatcher is unavailable.');
      const row = this.coreDb.sqlite
        .prepare(`SELECT schema_version AS schemaVersion,
        parent_step_id AS parentStepId, control_json AS controlJson,
        invocation_json AS invocationJson, span_json AS spanJson
        FROM control_execution_steps WHERE execution_id = ? AND step_id = ?`)
        .get(candidate.ref.execution.executionId, candidate.ref.stepId) as {
        schemaVersion: number;
        parentStepId: string | null;
        controlJson: string;
        invocationJson: string;
        spanJson: string;
      };
      readRetainedV1(row, () => row);
      const invocation = JSON.parse(row.invocationJson);
      const control = JSON.parse(row.controlJson);
      const operation = invocation.carriage.operation;
      if (operation !== 'bridge.close' && operation !== 'sandbox.delete')
        throw new Error('Selected idle cleanup result kind is invalid.');
      const intent = decodeExecutionJournalIntent(
        encodeExecutionJournalValue({
          execution: {
            ref: root.ref,
            definitionVersion: root.definitionVersion,
            workId: root.workId,
            fingerprint: root.fingerprint,
            exclusionRefs: root.exclusionRefs,
            span: { ...root.span, endTimeUnixNano: null, status: { code: 'UNSET' } },
          },
          stepId: candidate.ref.stepId,
          parentStepId: row.parentStepId,
          parent: invocation.parent,
          carriage: invocation.carriage,
          inspectedStep: null,
          control: { ...control, outputRefs: [] },
          span: { ...JSON.parse(row.spanJson), endTimeUnixNano: null, status: { code: 'UNSET' } },
        })
      );
      const result = this.sessionDispatch.expectResultOnly([
        {
          kind: operation,
          originPhysicalEpoch,
          requestId: intent.carriage.requestId,
          consumeResult: async (value) => {
            const { resourceSummary: _diagnostic, stagingPath: _temporary, ...core } = value;
            await this.settleIdleCleanupJournal(
              intent,
              value.failureCode === 'effect_failed' ? 'failed' : 'completed',
              commandInputHash(core)
            );
          },
        },
      ]);
      this.cleanupRecoveryResults.set(identity.packageSnapshotId, result);
      void result
        .then(
          () => {
            if (this.cleanupRecoveryResults.get(identity.packageSnapshotId) === result)
              this.cleanupRecoveryResults.delete(identity.packageSnapshotId);
            this.idleCleanup.onCommit();
          },
          () => {
            if (this.cleanupRecoveryResults.get(identity.packageSnapshotId) !== result) return;
            this.cleanupRecoveryResults.delete(identity.packageSnapshotId);
            if (!this.coreDb.sqlite.open) return;
            fenceNanoHostSandboxRuntime(this.coreDb, {
              sandboxBindingRef,
              timestamp: new Date().toISOString(),
            });
            this.fenceWorkerStorageForSandbox(sandboxBindingRef);
          }
        )
        .catch(() => {});
      return;
    }
    if (this.readCurrentPhysicalEpoch(identity.runtimeTargetId) !== originPhysicalEpoch)
      this.requireLaterFreshRuntimeTarget(
        identity.runtimeTargetId,
        originPhysicalEpoch,
        identity.deploymentId
      );
    else this.markProvedSandboxDeletion(sandboxBindingRef, originPhysicalEpoch);
    try {
      await this.handoffSandboxAgentSessionProofs(sandboxBindingRef, {
        sandboxBindingRef,
        originPhysicalEpoch,
        physicalAbsent: !sameEpoch,
      });
      this.releaseWorkerStorageForSandbox(sandboxBindingRef);
      removeNanoHostSandboxRuntimeByBinding(this.coreDb, sandboxBindingRef);
      this.forgetSharedSandbox(resident.sandboxCompatibilityKey);
    } catch (error) {
      fenceNanoHostSandboxRuntime(this.coreDb, {
        sandboxBindingRef,
        timestamp: new Date().toISOString(),
      });
      this.fenceWorkerStorageForSandbox(sandboxBindingRef);
      throw error;
    }
  }

  /** Widens live cleanup through the bridge and Sandbox without returning capacity early. */
  private async deleteSandbox(
    identity: WorkerGovernanceBackendSessionIdentity,
    cleanupInput: { readonly attemptId: string; readonly sandboxId: string },
    bridgeOpen: boolean,
    retiringSandboxOrigin?: string
  ): Promise<void> {
    const anchor = getWorkerBackendSession(this.coreDb, cleanupInput.attemptId);
    const resident = this.findDurableSandboxBinding(identity);
    await this.assertWorkspaceCaptureSettled(
      resident?.sandboxBindingRef ?? anchor?.sandboxBindingRef ?? null
    );
    const origin = retiringSandboxOrigin ?? anchor?.originPhysicalEpoch;
    if (
      anchor &&
      requireSchedulerExecutionAttempt(this.coreDb, cleanupInput.attemptId).phase === 'closed'
    ) {
      if (!hasIdleCleanupExecution(this.coreDb, anchor))
        await this.idleCleanupEffect(
          identity,
          cleanupInput.attemptId,
          bridgeOpen ? 'bridge.close' : 'sandbox.delete',
          cleanupInput,
          origin
        );
      await this.idleCleanup.join(identity);
      return;
    }
    for (const operation of [
      ...(bridgeOpen ? ['bridge.close' as const] : []),
      'sandbox.delete' as const,
    ]) {
      await this.effect(
        identity,
        cleanupInput.attemptId,
        operation,
        cleanupInput,
        retiringSandboxOrigin
      );
    }
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
      partial.attemptId,
      'sandbox.delete',
      { attemptId: partial.attemptId, sandboxId: partial.sandboxId },
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

  /** Finds canonical nonclosed owners across per-Turn routes, excluding only this no-effect preparation. */
  private nonClosedSandboxAttempts(
    environmentPackage: {
      readonly scope: Pick<
        AgentEnvironmentPackagePreview['scope'],
        'workspaceId' | 'threadId' | 'turnId'
      >;
      readonly snapshotId: string;
    },
    runtimeTargetId: string,
    originPhysicalEpoch: string,
    sandboxId: string
  ): Array<{ attemptId: string; deadline: string | null }> {
    return (
      this.coreDb.sqlite
        .prepare(`
      SELECT a.attempt_id AS attemptId, w.backend_session_id AS backendSessionId, a.deadline
      FROM scheduler_execution_attempts a JOIN worker_backend_sessions w ON w.attempt_id = a.attempt_id
      WHERE a.backend_id = ? AND w.runtime_target_id = ? AND w.origin_physical_epoch = ? AND a.phase <> 'closed'
        AND NOT (a.phase = 'open' AND a.operation_id IS NULL AND a.deadline IS NULL
          AND a.workspace_id = ? AND a.thread_id = ? AND a.turn_id = ? AND a.input_ref = ?)
    `)
        .all(
          this.id,
          runtimeTargetId,
          originPhysicalEpoch,
          environmentPackage.scope.workspaceId,
          environmentPackage.scope.threadId,
          environmentPackage.scope.turnId,
          environmentPackage.snapshotId
        ) as Array<{
        attemptId: string;
        backendSessionId: string;
        deadline: string | null;
      }>
    ).filter(
      (attempt) => nanoHostSandboxIdFromBackendSessionId(attempt.backendSessionId) === sandboxId
    );
  }

  /** Reports capacity after preserving any retiring binding's proof, without runtime effects. */
  public async inspectMaterializationCapacity(
    environmentPackage: AgentEnvironmentPackagePreview
  ): Promise<'available' | 'capacity-saturated'> {
    // Compatible live residents share only the authored aggregate capacity. Closing Turns
    // retain their live reservation through output collection and the complete handoff.
    const eviction = this.inspectIncompatibleIdleSandbox(environmentPackage);
    if (eviction === 'capacity-saturated') return 'capacity-saturated';
    for (const binding of eviction?.bindings ?? []) {
      await this.handoffDurableAgentSessionProof(binding, undefined, eviction!);
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
                drain_state AS drainState, cleanup_state AS cleanupState,
                max_active_turns AS maxActiveTurns
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
      readonly maxActiveTurns: number;
    }>;
    const currentPhysicalEpoch = this.readCurrentPhysicalEpoch(runtimeTargetId);
    if (!currentPhysicalEpoch) return 'capacity-saturated';
    if (sandboxes.length === 0) {
      // A known delete does not permit the same physical name to alias pending Core closeouts.
      return this.nonClosedSandboxAttempts(
        environmentPackage,
        runtimeTargetId,
        currentPhysicalEpoch,
        nanoHostSandboxId(desiredKey)
      ).length > 0
        ? 'capacity-saturated'
        : null;
    }
    if (sandboxes.length !== 1) {
      return 'capacity-saturated';
    }
    const sandbox = sandboxes[0]!;
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
                active_turn_count AS activeTurnCount, operation_state AS operationState,
                harness_compatibility_key AS harnessCompatibilityKey,
                max_active_turns AS maxActiveTurns,
                open_session_count AS openSessionCount, max_open_sessions AS maxOpenSessions,
                (lifecycle_state = 'failed' AND drain_state = 'draining'
                 AND operation = 'session.close' AND operation_state = 'settled'
                 AND json_extract(result_json, '$.disposition') = 'refused'
                 AND json_extract(result_json, '$.body.reasonCode') = 'cleanup_required'
                 AND EXISTS (
                   SELECT 1 FROM agent_session_runtime_bindings b
                   WHERE b.harness_instance_id = harness_instance_records.harness_instance_id
                     AND b.agent_session_id = json_extract(command_body_json, '$.agentSessionId')
                     AND b.agent_session_runtime_binding_id = json_extract(command_body_json, '$.agentSessionRuntimeBindingId')
                 )) AS closeCleanupRequired
         FROM harness_instance_records
         WHERE sandbox_runtime_id = ?
         ORDER BY harness_instance_id`
      )
      .all(sandbox.sandboxRuntimeId) as Array<{
      readonly activeTurnCount: number;
      readonly harnessCompatibilityKey: string;
      readonly maxActiveTurns: number;
      readonly openSessionCount: number;
      readonly maxOpenSessions: number;
      readonly closeCleanupRequired: number | null;
      readonly drainState: string;
      readonly harnessBindingRef: string;
      readonly harnessInstanceId: string;
      readonly lifecycleState: string;
      readonly operationState: string;
    }>;
    if (
      !physicalAbsent &&
      harnesses.some(
        (harness) =>
          (harness.lifecycleState !== 'open' || harness.drainState !== 'accepting') &&
          harness.closeCleanupRequired !== 1
      )
    ) {
      return 'capacity-saturated';
    }
    // A settled refused local close is cleanup work, never spare residency capacity.
    // Retire its complete idle Sandbox through the old resident's deletion owner without replay.
    const widenCleanup =
      !physicalAbsent && harnesses.some((harness) => harness.closeCleanupRequired === 1);
    const liveSessions = [...this.sessions.values()].filter(
      (session) =>
        session.sharedHarness.sandbox.sandboxBindingRef === sandbox.sandboxBindingRef &&
        (requireSchedulerExecutionAttempt(this.coreDb, session.attemptId).phase !== 'closed' ||
          !!session.acceptedProofUnrecorded ||
          !!session.pendingHarnessOperation ||
          (session.turnStarted && !session.terminalInspectionComplete))
    );
    const domainAttempts = this.nonClosedSandboxAttempts(
      environmentPackage,
      runtimeTargetId,
      sandboxOriginPhysicalEpoch,
      nanoHostSandboxId(sandbox.sandboxCompatibilityKey)
    );
    if (
      !forceRetirement &&
      !widenCleanup &&
      sandbox.sandboxCompatibilityKey === desiredKey &&
      processLocalSandbox
    ) {
      const activeBindings = this.coreDb.sqlite
        .prepare(`
        SELECT b.current_attempt_id AS attemptId, b.agent_session_runtime_binding_id AS bindingId
        FROM agent_session_runtime_bindings b JOIN harness_instance_records h
          ON h.harness_instance_id = b.harness_instance_id
        WHERE h.sandbox_runtime_id = ? AND b.lifecycle_state = 'active'
      `)
        .all(sandbox.sandboxRuntimeId) as Array<{ attemptId: string; bindingId: string }>;
      const nativeActive = harnesses.reduce((count, harness) => count + harness.activeTurnCount, 0);
      // An unowned/unknown active attempt is a fence, not evidence of a free operating slot.
      if (
        activeBindings.length !== nativeActive ||
        activeBindings.some(
          (binding) =>
            !liveSessions.some(
              (session) =>
                session.attemptId === binding.attemptId &&
                session.agentSessionRuntimeBindingId === binding.bindingId &&
                session.liveRouteTokens !== null
            )
        )
      ) {
        return 'capacity-saturated';
      }
      const submittedAttempts = domainAttempts.filter((attempt) => attempt.deadline !== null);
      // Native inspection and local session removal do not release the Core output/revocation
      // barrier. Count each exact owner once until its submitted attempt is closed.
      const heldAttempts = new Set([
        ...liveSessions.map((session) => session.attemptId),
        ...submittedAttempts.map((attempt) => attempt.attemptId),
        ...activeBindings.map((binding) => binding.attemptId),
      ]);
      const capacity = Math.min(sandbox.maxActiveTurns, this.configuredActiveTurnCapacity());
      if (heldAttempts.size >= capacity) return 'capacity-saturated';
      const selectedHarness = harnesses.find(
        (harness) =>
          harness.harnessCompatibilityKey === nanoHostHarnessCompatibilityKey(environmentPackage)
      );
      if (selectedHarness) {
        if (selectedHarness.activeTurnCount >= selectedHarness.maxActiveTurns)
          return 'capacity-saturated';
        const retainedThread = this.coreDb.sqlite
          .prepare(`
          SELECT 1 FROM agent_session_runtime_bindings
          WHERE harness_instance_id = ? AND workspace_id = ? AND thread_id = ? AND lifecycle_state <> 'closed'
        `)
          .get(
            selectedHarness.harnessInstanceId,
            environmentPackage.scope.workspaceId,
            environmentPackage.scope.threadId
          );
        if (!retainedThread && selectedHarness.openSessionCount >= selectedHarness.maxOpenSessions)
          return 'capacity-saturated';
      }
      return null;
    }
    if (
      (!physicalAbsent && liveSessions.length > 0) ||
      domainAttempts.length > 0 ||
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
          "SELECT 1 FROM scheduler_execution_attempts WHERE binding_ref = ? AND phase <> 'closed' LIMIT 1"
        )
        .get(sandbox.sandboxBindingRef)
    )
      return 'capacity-saturated';
    const bindings = this.coreDb.sqlite
      .prepare(
        `SELECT b.agent_session_id AS agentSessionId,
                b.agent_session_runtime_binding_id AS agentSessionRuntimeBindingId,
                b.harness_instance_id AS harnessInstanceId,
                h.harness_binding_ref AS harnessBindingRef,
                h.harness_compatibility_key AS harnessCompatibilityKey,
                b.lifecycle_state AS lifecycleState,
                b.current_turn_id AS currentTurnId,
                b.current_attempt_id AS currentAttemptId,
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
      readonly currentAttemptId: string | null;
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
          binding.currentAttemptId !== null ||
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
            `SELECT 1 FROM scheduler_execution_attempts
             WHERE agent_session_id = ?
               AND phase <> 'closed'
               AND NOT (workspace_id = ? AND thread_id = ? AND turn_id = ?
                 AND backend_id = ? AND phase = 'open' AND operation_id IS NULL)
             LIMIT 1`
          )
          .get(
            binding.agentSessionId,
            environmentPackage.scope.workspaceId,
            environmentPackage.scope.threadId,
            environmentPackage.scope.turnId,
            this.id
          )
      )
    ) {
      return 'capacity-saturated';
    }
    if (
      !forceRetirement &&
      !widenCleanup &&
      sandbox.sandboxCompatibilityKey === desiredKey &&
      !physicalAbsent
    ) {
      return null;
    }
    const retainedOwner = this.coreDb.sqlite
      .prepare(
        `SELECT attempt_id AS attemptId FROM worker_backend_sessions
       WHERE sandbox_binding_ref = ? AND runtime_target_id = ? AND origin_physical_epoch = ?
       ORDER BY created_at DESC, attempt_id DESC LIMIT 1`
      )
      .get(sandbox.sandboxBindingRef, runtimeTargetId, sandboxOriginPhysicalEpoch) as
      | { attemptId: string }
      | undefined;
    const retirementOwner = retainedOwner
      ? getWorkerBackendSession(this.coreDb, retainedOwner.attemptId)
      : null;
    if (
      (!retirementOwner && !physicalAbsent) ||
      (retirementOwner !== null &&
        nanoHostSandboxIdFromBackendSessionId(retirementOwner.backendSessionId) !==
          nanoHostSandboxId(sandbox.sandboxCompatibilityKey))
    ) {
      // A missing owner cannot authorize a synthetic idle execution or a guessed delete.
      return 'capacity-saturated';
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
      closeAgentSessions: processLocalSandbox && !forceRetirement && !widenCleanup,
      closeCleanupRequired: widenCleanup,
      originPhysicalEpoch: sandboxOriginPhysicalEpoch,
      retirementOwner,
      physicalAbsent,
      sandboxBindingRef: sandbox.sandboxBindingRef,
      sandboxCompatibilityKey: sandbox.sandboxCompatibilityKey,
      sandboxId: nanoHostSandboxId(sandbox.sandboxCompatibilityKey),
      sandboxRuntimeId: sandbox.sandboxRuntimeId,
    };
  }

  /** Retires an incompatible idle resident through its own exact cleanup lineage, widening uncertain close to Sandbox/Epoch proof. */
  private async evictIncompatibleIdleSandbox(
    environmentPackage: AgentEnvironmentPackagePreview,
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
        throw new WorkerGovernanceCapacityUnavailableError(
          'NanoHost one-Sandbox capacity is occupied or unproved.'
        );
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
          await this.handoffDurableAgentSessionProof(binding, undefined, eviction);
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
               AND (? = 1 OR (lifecycle_state = 'open' AND drain_state = 'accepting')
                 OR (lifecycle_state = 'failed' AND drain_state = 'draining'
                   AND operation = 'session.close' AND operation_state = 'settled'
                   AND json_extract(result_json, '$.disposition') = 'refused'
                   AND json_extract(result_json, '$.body.reasonCode') = 'cleanup_required'))`
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
      await this.assertWorkspaceCaptureSettled(eviction.sandboxBindingRef);
      if (eviction.physicalAbsent) {
        await this.invalidatePhysicallyAbsentSandbox(eviction);
      }
      // An excluded package cannot be restored for local close; the exact wider delete below owns cleanup.
      if (
        eviction.closeAgentSessions &&
        eviction.retirementOwner &&
        isScopeAdmitted(this.coreDb.dataRoot, 'workspace', eviction.retirementOwner.workspaceId)
      ) {
        for (const binding of eviction.bindings) {
          if (binding.lifecycleState === 'closed') continue;
          try {
            await this.closeDurableAgentSession(binding);
          } catch (error) {
            const unknownClose = this.coreDb.sqlite
              .prepare(
                `SELECT operation_id AS operationId FROM harness_instance_records
               WHERE harness_instance_id = ? AND harness_binding_ref = ?
                 AND operation = 'session.close' AND operation_state = 'unknown'
                 AND operation_id IS NOT NULL
                 AND json_extract(command_body_json, '$.agentSessionId') = ?
                 AND json_extract(command_body_json, '$.agentSessionRuntimeBindingId') = ?`
              )
              .get(
                binding.harnessInstanceId,
                binding.harnessBindingRef,
                binding.agentSessionId,
                binding.agentSessionRuntimeBindingId
              );
            if (!isCleanupRequiredRefusal(error) && !unknownClose) throw error;
            // Preserve the unknown operation. The resident's wider delete is a distinct owned effect,
            // not a repeat of session.close or an outcome on the incoming Turn.
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
        if (!eviction.retirementOwner)
          throw new Error('Resident deletion has no exact retained owner.');
        await this.deleteSandbox(
          this.durableBackendSessionIdentity(eviction.retirementOwner),
          { attemptId: eviction.retirementOwner.attemptId, sandboxId: eviction.sandboxId },
          eviction.bridgeOpen,
          eviction.originPhysicalEpoch
        );
      }
      const releasedBinding = getWorkerStorageBindingForSandbox(this.coreDb, {
        sandboxBindingRef: eviction.sandboxBindingRef,
      })
        ? this.releaseWorkerStorageForSandbox(eviction.sandboxBindingRef)
        : authorizedReplacementBinding
          ? getWorkerStorageBinding(this.coreDb, {
              storageRef: authorizedReplacementBinding.storageRef,
            })
          : null;
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
      // A drain claim is reversible when no uncertain cleanup or failed Harness owns a fence.
      // The effect owner fences its exact target after dispatch; a pre-dispatch failure cannot.
      if (!(error instanceof WorkspaceCaptureRecoveryRequired))
        this.restoreSandboxAdmissionIfSafe(eviction.sandboxRuntimeId);
      this.forgetSharedSandbox(eviction.sandboxCompatibilityKey);
      throw error;
    }
  }

  /** Restores only a healthy resident with no unsettled operation or failed Harness. */
  private restoreSandboxAdmissionIfSafe(sandboxRuntimeId: string): void {
    this.coreDb.sqlite
      .transaction(() => {
        const sandbox = this.coreDb.sqlite
          .prepare(
            'SELECT sandbox_binding_ref AS binding FROM sandbox_runtime_records WHERE sandbox_runtime_id=?'
          )
          .get(sandboxRuntimeId) as { binding: string } | undefined;
        if (!sandbox) return;
        // This synchronous observation and restoration cannot interleave with another Main
        // preclaim. A sibling's successful close never settles the other capture's fence.
        const anchors = this.workspaceCaptureAnchors(sandbox.binding);
        const attempts = new Set(anchors.map((anchor) => anchor.attemptId));
        for (const workspaceId of new Set(anchors.map((anchor) => anchor.workspaceId))) {
          let db: ReturnType<typeof openWorkspaceDb> | undefined;
          try {
            db = openWorkspaceDb(this.coreDb.dataRoot, workspaceId);
            if (
              listWorkspaceReconciliationRecords(db, workspaceId).some(
                (record) =>
                  record.id.startsWith('wrr_capture_') &&
                  attempts.has(String(record.backendHandleSummary.attemptId)) &&
                  record.stateAfter !== 'recovered'
              )
            )
              return;
          } catch {
            // Optional admission restoration requires readable capture disposition.
            return;
          } finally {
            db?.sqlite.close();
          }
        }
        const restored = this.coreDb.sqlite
          .prepare(`UPDATE sandbox_runtime_records SET drain_state = 'accepting'
          WHERE sandbox_runtime_id = ? AND lifecycle_state = 'open' AND health_state = 'ready'
            AND cleanup_state = 'clean' AND NOT EXISTS (
              SELECT 1 FROM harness_instance_records WHERE sandbox_runtime_id = ?
                AND (lifecycle_state <> 'open' OR operation_state IN ('queued', 'dispatched', 'unknown'))
            )`)
          .run(sandboxRuntimeId, sandboxRuntimeId);
        if (restored.changes === 1)
          this.coreDb.sqlite
            .prepare(`UPDATE harness_instance_records
          SET drain_state = 'accepting' WHERE sandbox_runtime_id = ? AND lifecycle_state = 'open'`)
            .run(sandboxRuntimeId);
      })
      .immediate();
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
    const attemptId = this.requireAttemptId(environmentPackage.snapshotId);
    if (requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase !== 'open')
      throw new WorkerStorageBindingError(
        'authorization_denied',
        'Worker materialization requires its current open admission.'
      );
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
      environmentPackage,
      this.readRuntimeConfig,
      this.sharedStore ?? new FsStore({ dataRoot: this.coreDb.dataRoot })
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
    let preparedImports: NanoHostContextPackageImport[];
    try {
      // Verify and retain the complete incoming collection before any resident eviction or Sandbox effect.
      preparedImports = await prepareNanoHostContextPackageImports(environmentPackage, context);
    } catch (error) {
      this.failedPreSandboxPreparations.add(identity.packageSnapshotId);
      throw error;
    }
    // An existing anchor still owns its exact origin; a not-yet-published incoming anchor must use this same Epoch.
    const capacityPhysicalEpoch =
      context.beforeMaterialization && !getWorkerBackendSession(this.coreDb, attemptId)
        ? this.requireCurrentPhysicalEpoch(identity.runtimeTargetId)
        : this.requireCurrentBackendPhysicalEpoch(identity);
    if (this.inspectIncompatibleIdleSandbox(environmentPackage) === 'capacity-saturated') {
      throw new WorkerGovernanceCapacityUnavailableError(
        'NanoHost one-Sandbox capacity is occupied or unproved.'
      );
    }
    let releasedSelectedBinding: WorkerStorageBinding | null;
    try {
      releasedSelectedBinding = await this.evictIncompatibleIdleSandbox(
        environmentPackage,
        false,
        replacementSelection
      );
    } catch (error) {
      // Eviction owns the resident's fence; this incoming attempt created no Sandbox or bridge.
      this.failedPreSandboxPreparations.add(identity.packageSnapshotId);
      if (error instanceof WorkerStorageBindingError) throw error;
      throw new WorkerGovernanceCapacityUnavailableError(
        'Incompatible resident cleanup requires exact deletion or Epoch fence proof.'
      );
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
        true,
        replacementSelection
      );
      sharedHarness = null;
      sharedSandbox = null;
    }
    // Both resident refusal routes precede publication.
    // Every incoming reservation or effect requires its durable Core AgentSession, checkpoint, package and backend anchor.
    await context.beforeMaterialization?.();
    const originPhysicalEpoch = this.requireCurrentBackendPhysicalEpoch(
      identity,
      capacityPhysicalEpoch
    );
    if (sharedSandbox && choice?.kind === 'selected' && replacementSelection) {
      sharedSandbox.workerStorageBinding = admitWorkerStorageContributor(this.coreDb, {
        ...replacementSelection,
        layout: sharedSandbox.workerStorageBinding.layout,
      });
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
          ? await this.effect(identity, attemptId, 'image.acquire', {
              imageReference: environmentPackage.runtime.environment.imageDigest,
            })
          : image.kind === 'reference'
            ? await this.effect(identity, attemptId, 'image.acquire', {
                imageReference: image.ref,
              })
            : await this.effect(identity, attemptId, 'image.build', {
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
          await this.effect(identity, attemptId, 'image.inspect', { imageDigest })
        );
        if (!imageInspection.layout.targets.some((target) => target.target === '/openkit/threads'))
          throw new Error(
            'NanoHost Worker image has no declared retained /openkit/threads target.'
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
        sandboxResult = await this.effect(identity, attemptId, 'sandbox.create', {
          environment: {},
          imageDigest,
          attemptId: attemptId,
          policyIntent: {
            additionalFilesystemGrants:
              openShellFilesystemGrantsFromPackagePolicy(environmentPackage),
            additionalNetworkEndpoints:
              openShellNetworkEndpointsFromPackagePolicy(environmentPackage),
          },
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
        attemptId: attemptId,
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
        writerCleanupProved: false,
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
        maxActiveTurns: this.configuredActiveTurnCapacity(),
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
      attemptId: attemptId,
      nativeResume: context.nativeResume ?? null,
      nativeSessionReusable: false,
      recordNativeHandleDigest: null,
      pendingImports: [],
      runtimeEnvironment,
      liveRouteTokens: null,
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
        const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
          `workspace:${initializationDb.sqlite.name}`
        );
        try {
          authorizeWorkspaceBaselineInitialization(
            initializationDb,
            this.workspaceCollectionIdentity(
              this.requireSession(environmentPackage.snapshotId),
              'baseline'
            )
          );
        } finally {
          resume();
        }
      } finally {
        initializationDb.sqlite.close();
      }
    }
    this.livePartialMaterializations.delete(identity.packageSnapshotId);
    this.requireSession(environmentPackage.snapshotId).pendingImports = [
      ...preparedImports,
      ...runtimeCredentialImports,
    ];
    const harnessMapKey = nanoHostSharedHarnessMapKey(
      sandboxCompatibilityKey,
      harnessCompatibilityKey
    );
    if (!this.sharedHarnesses.has(harnessMapKey)) {
      createNanoHostHarnessRuntime(this.coreDb, {
        maxActiveTurns: sharedHarness.maxActiveTurns,
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
        attachmentGeneration: sharedSandbox.workerStorageBinding.attachmentGeneration,
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

  /** Opens or inspects the exact Session, imports its Turn inputs, and accepts its baseline before the submission port. */
  public async prepareLaunch(
    materialization: WorkerGovernanceMaterializationRecord
  ): Promise<void> {
    const session = this.requireSession(materialization.packageSnapshotId);
    const result = session.sharedHarness.sandbox.bridgeOpen
      ? { accepted: true, integrationReady: true, state: 'open' }
      : await this.effect(session.identity, session.attemptId, 'bridge.open', {
          sandboxIntegrationBindingRef: session.sharedHarness.sandbox.sandboxIntegrationBindingRef,
        });
    if (result.accepted !== true || result.integrationReady !== true || result.state !== 'open') {
      throw new Error('NanoHost bridge did not prove its Sandbox Integration readiness latch.');
    }
    session.sharedHarness.sandbox.bridgeOpen = true;
    const pendingImports = session.pendingImports;
    session.pendingImports = [];
    for (const file of pendingImports) {
      const imported = await this.effect(session.identity, session.attemptId, 'reference.import', {
        entryKind: file.entryKind,
        relativePath: file.relativePath,
        sandboxId: session.sharedHarness.sandbox.sandboxId,
        slot: file.slot,
        ...(file.entryKind === 'file'
          ? {
              ...(file.source ? { source: file.source } : { body: file.body }),
              byteLength: file.byteLength,
              executable: file.executable,
              sha256: file.contentDigest,
            }
          : {}),
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
      const retainedBinding = this.coreDb.sqlite
        .prepare(
          'SELECT schema_version AS schemaVersion FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
        )
        .get(session.agentSessionRuntimeBindingId);
      if (retainedBinding) readRetainedV1(retainedBinding, () => retainedBinding);
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
      const { opened, openedReady } = await withLifecycleStageTelemetry(
        {
          ...session.environmentPackage.scope,
          packageSnapshotId: session.environmentPackage.snapshotId,
          workerKind: session.environmentPackage.agent.runtimeKind,
          stage: 'session.open.inspect',
          rejectionOutcome: 'unknown',
        },
        async () => {
          const opened = await this.queueAndWaitForHarnessOperation(session, 'session.open', {
            adapterId: session.sharedHarness.adapterId,
            maxActiveTurns: session.sharedHarness.maxActiveTurns,
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
            opened.maxActiveTurns !== session.sharedHarness.maxActiveTurns ||
            !(
              openedReady ||
              (opened.nativeHandleState === 'pending' && opened.nativeHandleDigest === null)
            ) ||
            (session.nativeResume !== null &&
              (!openedReady || opened.nativeHandleDigest !== session.nativeResume.digest))
          ) {
            throw new Error('NanoHost Harness session.open result is incompatible.');
          }
          return { opened, openedReady };
        }
      );
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
        await this.recordAcceptedNativeHandleDigest(session, binding.nativeHandleDigest);
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
      await withLifecycleStageTelemetry(
        {
          ...session.environmentPackage.scope,
          packageSnapshotId: session.environmentPackage.snapshotId,
          workerKind: session.environmentPackage.agent.runtimeKind,
          stage: 'session.open.inspect',
          rejectionOutcome: 'unknown',
        },
        async () => {
          const inspected = await this.queueAndWaitForHarnessOperation(session, 'session.inspect', {
            agentSessionId: session.environmentPackage.scope.agentSessionId,
            agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
          });
          if (
            inspected.state !== 'open' ||
            inspected.cleanupState !== 'clean' ||
            inspected.nativeHandleState !== 'ready' ||
            inspected.nativeHandleDigest !== binding!.nativeHandleDigest
          ) {
            throw new Error('NanoHost resident AgentSession is not ready for its next Turn.');
          }
        }
      );
    }
    await this.ensureWorkspaceBaseline(session, opensNewBinding, workspaceGitBaseline);
    session.evidence.push(
      nanoHostEffectEvidence(session.environmentPackage.createdAt, result, 'bridge')
    );
  }

  /** Submits once at native turn.start after finalized package, accepted baseline and current authority. */
  public async submit(
    input: ExecutionBackendCorrelation & { readonly deadline: string }
  ): Promise<ExecutionBackendObservation> {
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.attemptId);
    if (
      attempt.backendId !== this.id ||
      commandInputHash(schedulerExecutionCorrelation(attempt)) !==
        commandInputHash(inputCorrelation(input)) ||
      attempt.deadline !== input.deadline ||
      attempt.phase !== 'open' ||
      Date.parse(input.deadline) <= Date.now()
    )
      throw new Error('Native submit has no current exact attempt authority.');
    const session = this.requireSession(input.inputRef!);
    if (
      session.attemptId !== attempt.attemptId ||
      session.environmentPackage.scope.agentSessionId !== attempt.agentSessionId
    )
      throw new Error('Native submit binding contradicts its attempt.');
    this.requireDurableAgentSessionProvenance(session.environmentPackage, attempt.attemptId);
    this.requireCurrentBackendPhysicalEpoch(session.identity);
    const workspaceDb = openWorkspaceDb(this.coreDb.dataRoot, attempt.workspaceId);
    try {
      const retained = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        attempt.workspaceId,
        input.inputRef!
      ).snapshot;
      const baseline = readWorkspaceBaselineIdentity(
        workspaceDb,
        this.workspaceCollectionIdentity(session, 'baseline')
      );
      const baselinePackage =
        baseline &&
        requireAgentEnvironmentPackageSnapshot(
          workspaceDb,
          baseline.workspaceId,
          baseline.packageSnapshotId
        ).snapshot;
      if (
        !baseline ||
        !baselinePackage ||
        baseline.workspaceId !== attempt.workspaceId ||
        baselinePackage.scope.workspaceId !== baseline.workspaceId ||
        baselinePackage.scope.threadId !== baseline.threadId ||
        baselinePackage.scope.turnId !== baseline.turnId ||
        baselinePackage.scope.agentSessionId !== baseline.agentSessionId
      ) {
        throw new Error(
          'Native submit lacks accepted baseline provenance; explicit reconciliation is required.'
        );
      }
      if (
        !isDeepStrictEqual(retained, session.environmentPackage) ||
        !readWorkspaceSnapshotCursor(
          workspaceDb,
          this.workspaceCollectionIdentity(session, 'baseline')
        )
      )
        throw new Error('Native submit lacks the immutable package or accepted baseline.');
    } finally {
      workspaceDb.sqlite.close();
    }
    const binding = session.sharedHarness.bindings.get(
      session.environmentPackage.scope.agentSessionId
    );
    if (!binding) throw new Error('Native submit has no prepared AgentSession binding.');
    const inputPaths = workerSessionInputPaths(session.environmentPackage.scope.agentSessionId);
    const native = requireNanoHostExecutionAttempt(this.coreDb, session.attemptId);
    const livenessDeadline =
      native.lastAcceptedHeartbeatAt === null ? native.startupDeadline : native.heartbeatDeadline;
    if (
      !livenessDeadline ||
      livenessDeadline <= new Date().toISOString() ||
      native.recoveryState !== null
    )
      throw new Error('Native submission liveness or adoption proof is unavailable.');
    await withLifecycleStageTelemetry(
      {
        ...session.environmentPackage.scope,
        packageSnapshotId: session.environmentPackage.snapshotId,
        workerKind: session.environmentPackage.agent.runtimeKind,
        stage: 'turn.start.delivery',
        rejectionOutcome: 'unknown',
      },
      async () => {
        const started = await this.queueAndWaitForHarnessOperation(session, 'turn.start', {
          aepRef: inputPaths.packagePath,
          agentSessionId: session.environmentPackage.scope.agentSessionId,
          agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
          contextPackageId: `ctxpkg_${session.environmentPackage.scope.turnId}`,
          contextRef: inputPaths.contextRoot,
          deadline: input.deadline,
          leaseId: session.attemptId,
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
      }
    );
    binding.nextTurnSequence += 1;
    session.turnStarted = true;
    return {
      ...input,
      disposition: 'accepted',
      execution: 'pending',
      fenceRef: null,
      outcomeRef: null,
    };
  }

  /** Reads original native evidence without create, resume, replay or new execution authority. */
  public async inspect(
    input: ExecutionBackendCorrelation
  ): Promise<ExecutionBackendObservation | null> {
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.attemptId);
    if (
      attempt.backendId !== this.id ||
      commandInputHash(schedulerExecutionCorrelation(attempt)) !== commandInputHash(input)
    )
      return null;
    const anchor = getWorkerBackendSession(this.coreDb, attempt.attemptId);
    const submissionId = commandInputHash({
      attemptId: attempt.attemptId,
      inputRef: attempt.inputRef,
      operation: 'submit',
    });
    // Active binding ownership outlives the shared command cell, which siblings may already use.
    const native =
      attempt.operationId === submissionId && anchor
        ? (this.coreDb.sqlite
            .prepare(`
        SELECT s.sandbox_compatibility_key AS sandboxCompatibilityKey
        FROM agent_session_runtime_bindings b
        JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
        JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
        JOIN nanohost_runtime_targets r ON r.target_id = s.runtime_target_id
        JOIN worker_backend_sessions w ON w.attempt_id = b.current_attempt_id
        WHERE b.agent_session_id = ? AND b.current_attempt_id = ? AND b.current_turn_id = ?
          AND b.workspace_id = ? AND b.thread_id = ? AND b.lifecycle_state = 'active'
          AND w.package_snapshot_id = ? AND w.agent_session_id = b.agent_session_id
          AND w.workspace_id = b.workspace_id AND w.thread_id = b.thread_id AND w.turn_id = b.current_turn_id
          AND s.runtime_target_id = ? AND s.origin_physical_epoch = ?
          AND r.physical_epoch = s.origin_physical_epoch AND r.ready = 1
          AND h.lifecycle_state = 'open' AND h.active_turn_count > 0 AND s.lifecycle_state = 'open'
      `)
            .get(
              attempt.agentSessionId,
              attempt.attemptId,
              attempt.turnId,
              attempt.workspaceId,
              attempt.threadId,
              attempt.inputRef,
              anchor.runtimeTargetId,
              anchor.originPhysicalEpoch
            ) as { sandboxCompatibilityKey: string } | undefined)
        : undefined;
    const nativeAccepted =
      !!native &&
      !!anchor &&
      nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId) ===
        nanoHostSandboxId(native.sandboxCompatibilityKey);
    const final =
      attempt.agentSessionId && attempt.inputRef
        ? getWorkerControlAcceptedFinalStatus(this.coreDb, {
            agentSessionId: attempt.agentSessionId,
            packageSnapshotId: attempt.inputRef,
            requestId: requireSchedulerExecutionAttemptAdmissionContext(
              this.coreDb,
              attempt.attemptId
            ).requestId,
            workspaceId: attempt.workspaceId,
            threadId: attempt.threadId,
            turnId: attempt.turnId,
          })
        : null;
    return {
      ...input,
      disposition: final || nativeAccepted ? 'accepted' : attempt.disposition,
      execution: final
        ? 'terminal'
        : anchor?.state === 'launching' && nativeAccepted
          ? 'running'
          : 'unknown',
      fenceRef: attempt.fenceRef,
      outcomeRef: attempt.outcomeRef,
    };
  }

  /** Cancels only the same revoked attempt; late native acceptance cannot reopen it. */
  public async cancel(input: ExecutionBackendCorrelation): Promise<ExecutionBackendObservation> {
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.attemptId);
    if (
      attempt.phase !== 'closing' ||
      attempt.backendId !== this.id ||
      commandInputHash(schedulerExecutionCorrelation(attempt)) !== commandInputHash(input)
    )
      throw new Error('Native cancellation has no exact revoked owner.');
    const session = attempt.inputRef ? this.sessions.get(attempt.inputRef) : null;
    if (session?.turnStarted) await this.interruptTurn(session.environmentPackage.snapshotId);
    return {
      ...input,
      disposition: session?.turnStarted ? 'accepted' : 'unknown',
      execution: 'unknown',
      fenceRef: null,
      outcomeRef: attempt.outcomeRef,
    };
  }

  /** Proves safe residency or completed private cleanup after all supplied Core handoff barriers. */
  public async release(
    input: ExecutionBackendCorrelation & { readonly proof: ExecutionReleaseProof }
  ) {
    const correlation = inputCorrelation(input);
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.attemptId);
    if (
      attempt.phase !== 'closing' ||
      attempt.backendId !== this.id ||
      commandInputHash(schedulerExecutionCorrelation(attempt)) !== commandInputHash(correlation)
    )
      throw new Error('Native release has no exact closing owner.');
    if (
      !input.proof.terminalHandoff ||
      !input.proof.output ||
      !input.proof.evidence ||
      !input.proof.outsideWorkspaceCollection ||
      !input.proof.integrationDrain ||
      !input.proof.routesRevoked
    )
      return { ...correlation, state: 'pending' as const, fenceRef: null };
    const anchor = getWorkerBackendSession(this.coreDb, attempt.attemptId);
    if (!anchor || anchor.state !== 'cleaned' || !anchor.physicalCleanedAt)
      return { ...correlation, state: 'pending' as const, fenceRef: null };
    const identity = this.durableBackendSessionIdentity(anchor);
    const session = this.sessions.get(anchor.packageSnapshotId);
    if (session && this.findDurableSandboxBinding(identity)?.drainState === 'draining') {
      // Close our own retained resident if the drain began after ordinary cleanup. Other
      // owners keep their collection and release; shared deletion stays behind their join.
      await this.cleanupSession(identity, { failedCloseout: true });
    }
    const resident = this.coreDb.sqlite
      .prepare(`SELECT b.lifecycle_state AS lifecycleState, b.cleanup_state AS cleanupState,
      b.current_turn_id AS turnId, b.current_attempt_id AS attemptId, h.lifecycle_state AS harnessState,
      h.drain_state AS drainState, s.cleanup_state AS sandboxCleanup
      FROM agent_session_runtime_bindings b JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
      JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id WHERE b.agent_session_id = ?`)
      .get(attempt.agentSessionId) as
      | {
          lifecycleState: string;
          cleanupState: string;
          turnId: string | null;
          attemptId: string | null;
          harnessState: string;
          drainState: string;
          sandboxCleanup: string;
        }
      | undefined;
    if (
      resident &&
      (!['open', 'closed'].includes(resident.lifecycleState) ||
        resident.cleanupState !== 'clean' ||
        resident.turnId !== null ||
        resident.attemptId !== null ||
        resident.harnessState !== 'open' ||
        resident.drainState !== 'accepting' ||
        resident.sandboxCleanup !== 'clean')
    )
      return { ...correlation, state: 'unknown' as const, fenceRef: null };
    this.sessions.delete(anchor.packageSnapshotId);
    return {
      ...correlation,
      state: 'released' as const,
      fenceRef: `worker-backend:${anchor.attemptId}:${anchor.physicalCleanedAt}`,
    };
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
      leaseId: session.attemptId,
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
  public async bindNativeHandleRecorder(
    packageSnapshotId: string,
    record: (
      digest: string,
      retainedStorage: { storageRef: string; workSlotRef: string; attachmentGeneration: number }
    ) => void | Promise<void>
  ): Promise<void> {
    const session = this.requireSession(packageSnapshotId);
    session.recordNativeHandleDigest = record;
    const digest = session.sharedHarness.bindings.get(
      session.environmentPackage.scope.agentSessionId
    )?.nativeHandleDigest;
    if (digest) {
      await this.recordAcceptedNativeHandleDigest(session, digest);
    }
  }

  /**
   * Hands one ready proof NanoCore just accepted to the AgentSession owner, which keeps it after
   * the binding row closes. The proof is marked unrecorded before the recorder runs and cleared
   * only after that exact digest is handed off, so a throw keeps the binding, the admission fence,
   * and cleanup ownership. The SQLite binding commit precedes this acknowledged write, so a crash
   * between them leaves the proof on the binding row for the restart recorder bind to record.
   */
  private async recordAcceptedNativeHandleDigest(
    session: NanoHostBackendTurnSession,
    digest: string
  ): Promise<void> {
    session.acceptedProofUnrecorded = true;
    if (!session.recordNativeHandleDigest) {
      throw new Error('NanoHost accepted native ready proof without its AgentSession recorder.');
    }
    await session.recordNativeHandleDigest(digest, {
      storageRef: session.sharedHarness.sandbox.workerStorageBinding.storageRef,
      workSlotRef: packageWorkerStorageWorkSlotRef(session.environmentPackage),
      attachmentGeneration: session.sharedHarness.sandbox.workerStorageBinding.attachmentGeneration,
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

  /** Captures one eligible live output using the existing exact session/effect owner. @param input Core-derived identity, path, bound and cancellation. @returns Verified bytes and original private evidence. */
  public readonly captureArtifact: WorkerArtifactCapture = async (input) => {
    const session = this.requireSession(input.packageSnapshotId);
    validateWorkerArtifactPath(session.environmentPackage, input.path);
    const scope = session.environmentPackage.scope;
    const lineage = { ...scope, packageSnapshotId: input.packageSnapshotId };
    const requireLive = () => {
      input.signal?.throwIfAborted();
      const resolution = resolveNanoHostAttemptTokenBinding(this.coreDb, {
        lineage,
        sandboxBindingRef:
          listSchedulerExecutionAttemptsForTurn(this.coreDb, scope).find(
            (lease) => lease.attemptId === session.attemptId
          )?.bindingRef ?? '',
      });
      if (
        resolution.status !== 'accepted' ||
        resolution.attempt.attemptId !== session.attemptId ||
        getWorkerControlAcceptedFinalStatus(this.coreDb, lineage)
      )
        throw new OperationError(
          'turn_not_active',
          'The original capture lease no longer admits this Turn.',
          409
        );
    };
    input.signal?.throwIfAborted();
    let credentialCheckValues: WorkerCredentialCheckValues;
    try {
      credentialCheckValues = this.transcriptCredentialCheckValues(session);
    } catch (error) {
      try {
        await this.cleanupSession(session.identity, { failedCloseout: true });
      } catch (cleanupError) {
        const recovery = new ArtifactAuthorityError(
          'recovery_required',
          'Worker credential evidence and backend cleanup require recovery.'
        );
        recovery.cause = new AggregateError([error, cleanupError]);
        throw recovery;
      }
      throw error;
    }
    requireLive();
    const { slot, relativePath } = resolveNanoHostExportPath(
      session.environmentPackage,
      input.path
    );
    const result = await this.effect(
      session.identity,
      session.attemptId,
      'file.export',
      {
        purpose: 'artifact-submission',
        submissionRequestId: input.requestId,
        turnId: scope.turnId,
        agentSessionId: scope.agentSessionId,
        maxByteLength: input.maxByteLength,
        presence: 'optional',
        relativePath,
        slot,
        sandboxId: session.sharedHarness.sandbox.sandboxId,
      },
      undefined,
      input.signal
    );
    // Always dispose a complete private copy even if cancellation/sealing won while the effect ran.
    if (result.state === 'absent')
      throw new OperationError(
        'artifact_file_missing',
        'The submitted file is missing. Finish writing it and use a new request.',
        400
      );
    if (result.state === 'refused')
      throw new OperationError(
        'artifact_file_not_regular',
        'Submit one regular file with no other hard links.',
        400
      );
    const captured = await openNanoHostStagedExport(result, input.signal);
    try {
      requireLive();
      return { ...captured, credentialCheckValues };
    } catch (error) {
      await captured.remove();
      throw error;
    }
  };

  /** Exports transcript and evidence files only after the accepted terminal barrier. */
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
    /** Exports and consumes one exact declared transcript file. */
    const exportTranscriptFile = async (workerPath: string): Promise<Buffer> => {
      const { relativePath, slot } = resolveNanoHostExportPath(
        session.environmentPackage,
        workerPath
      );
      // Artifact output slots are valid exports, but never transcript capture sources.
      if (slot !== 'session')
        throw new Error('NanoHost transcript export is outside its exact admitted Turn capture.');
      const result = await this.effect(session.identity, session.attemptId, 'file.export', {
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
    const observationSources: NonNullable<WorkerTranscriptPayload['observationSources']> = [];
    const lineage = { ...session.environmentPackage.scope, packageSnapshotId };
    const observationDb = openWorkspaceDb(this.coreDb.dataRoot, lineage.workspaceId);
    let publications: Set<string>;
    try {
      publications = new Set(
        readWorkObservations(observationDb, lineage)
          .filter((row) => row.type === 'content.published')
          .map((row) => row.id)
      );
    } finally {
      observationDb.sqlite.close();
    }
    for (const metadata of listWorkerControlAcceptedEvents(this.coreDb, lineage)) {
      // Ordinary transcript reconciliation separately verifies these original accepted envelopes.
      if (
        metadata.event.type !== 'observation.recorded' ||
        metadata.event.data.content.state !== 'expected' ||
        publications.has(
          `${workerObservationRecordId(packageSnapshotId, metadata.event.data.observationId)}:publication`
        )
      )
        continue;
      const { relativePath, slot } = resolveNanoHostExportPath(
        session.environmentPackage,
        `${transcript.root}/${workerObservationSourceRelativePath(metadata.sequence)}`
      );
      if (slot !== 'session')
        throw new Error('Observation source is outside its admitted Turn capture.');
      const result = await this.effect(session.identity, session.attemptId, 'file.export', {
        finalStatusAccepted,
        maxByteLength: NANO_HOST_FILE_EXPORT_MAX_BYTES,
        presence: 'optional',
        relativePath,
        sandboxId: session.sharedHarness.sandbox.sandboxId,
        slot,
        terminalBarrierProved,
      });
      if (result.state === 'absent') continue; // Expected but unpublished remains an explicit content gap.
      const sourcePath = requireNanoHostResultString(result, 'stagingPath');
      session.retainedStagingPaths.push(sourcePath);
      if (
        requireNanoHostResultByteLength(result, 'byteLength') > WORKER_OBSERVATION_SOURCE_MAX_BYTES
      )
        throw new Error('Observation source exceeds its existing transport-derived bound.');
      await inspectNanoHostStagedExport(result);
      observationSources.push({ metadata, sourcePath });
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
        if (slot !== 'session')
          throw new Error('NanoHost provenance export is outside its exact admitted Turn capture.');
        const result = await this.effect(session.identity, session.attemptId, 'file.export', {
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
      credentialCheckValues: itemsBytes.toString('utf8').trim()
        ? this.transcriptCredentialCheckValues(session)
        : null,
      eventsJsonl: eventsBytes.toString('utf8'),
      itemsJsonl: itemsBytes.toString('utf8'),
      ...(observationSources.length ? { observationSources } : {}),
      ...(runtimeProvenance ? { runtimeProvenance } : {}),
    };
  }

  /** Reconstructs complete private admission evidence without requiring the old serving lease to remain live. */
  private transcriptCredentialCheckValues(
    session: NanoHostBackendTurnSession
  ): WorkerCredentialCheckValues {
    try {
      const scope = session.environmentPackage.scope;
      const leases = listSchedulerExecutionAttemptsForTurn(this.coreDb, scope)
        .filter(
          (lease) =>
            lease.attemptId === session.attemptId &&
            lease.agentSessionId === scope.agentSessionId &&
            lease.inputRef === session.environmentPackage.snapshotId
        )
        .filter((attempt) => !isSchedulerExecutionBusyRefusal(attempt));
      const lease =
        leases.length === 1
          ? requireNanoHostExecutionAttempt(this.coreDb, leases[0]!.attemptId)
          : null;
      if (!lease || !lease.bindingRef)
        throw new Error('Original lease association is unavailable.');
      const runtime = this.collectionRuntimeCheckValues(session);
      const evidence = requireWorkerCredentialCheckValues({
        sensitiveValues: [
          ...runtime.runtimeEnv,
          lease.bindingRef,
          ...(session.liveRouteTokens ?? []),
        ],
        loopbackDigests: runtime.loopbackDigests,
        routeTokenHashes: {
          workerControl: lease.workerControlTokenHash,
          inference: lease.workerInferenceTokenHash,
          capability: lease.workerCapabilityTokenHash,
        },
      });
      if (
        session.liveRouteTokens &&
        !isDeepStrictEqual(session.liveRouteTokens.map(hashWorkerRouteToken), [
          lease.workerControlTokenHash,
          lease.workerInferenceTokenHash,
          lease.workerCapabilityTokenHash,
        ])
      )
        throw new Error('Original route-token evidence is contradictory.');
      return evidence;
    } catch {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'Original worker credential comparison evidence is unavailable or contradictory.'
      );
    }
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
        'SELECT schema_version AS schemaVersion, runtime_env_check_versions_json AS versions FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
      )
      .get(session.agentSessionRuntimeBindingId) as
      | { schemaVersion: unknown; versions: string | null }
      | undefined;
    if (row) readRetainedV1(row, () => row);
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

  /** Loads the original session environment and loopback evidence for both collection consumers. */
  private collectionRuntimeCheckValues(session: NanoHostBackendTurnSession) {
    const digests = this.coreDb.sqlite
      .prepare(
        `SELECT inference_loopback_credential_digest AS inference, capability_loopback_credential_digest AS capability
         FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?
           AND harness_instance_id = ? AND agent_session_id = ? AND workspace_id = ? AND thread_id = ?`
      )
      .get(
        session.agentSessionRuntimeBindingId,
        session.harnessInstanceId,
        session.environmentPackage.scope.agentSessionId,
        session.environmentPackage.scope.workspaceId,
        session.environmentPackage.scope.threadId
      ) as { inference: string | null; capability: string | null } | undefined;
    const values = session.runtimeEnvironment ?? this.restoreCollectionRuntimeEnvironment(session);
    return {
      runtimeEnv: Object.values(values).filter((value) => value.length > 0),
      loopbackDigests: [digests?.inference, digests?.capability],
    };
  }

  /** Constructs the complete bounded credential-check command; it never truncates the check set. */
  private workspaceCollectionCommand(
    session: NanoHostBackendTurnSession,
    identity: WorkspaceCollectionIdentity,
    mode: 'baseline' | 'capture',
    cursor: ReturnType<typeof readWorkspaceSnapshotCursor>
  ) {
    const checkValues = this.collectionRuntimeCheckValues(session);
    let command: ReturnType<typeof WorkspaceCollectCommandSchema.parse>;
    try {
      command = WorkspaceCollectCommandSchema.parse({
        ...identity,
        requestId: '0'.repeat(64),
        mode,
        acceptedBase: mode === 'baseline' ? null : cursor?.acceptedBase,
        previousHead: mode === 'baseline' ? null : cursor?.head,
        checkValues,
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
    await this.assertWorkspaceCaptureSettled(session.sharedHarness.sandbox.sandboxBindingRef);
    const identity = this.workspaceCollectionIdentity(session, 'baseline');
    const db = openWorkspaceDb(this.coreDb.dataRoot, identity.workspaceId);
    try {
      applyScopedMigrations(db);
      if (readWorkspaceSnapshotCursor(db, identity)) {
        if (opensNewBinding) await this.collectWorkspaceSnapshot(session, 'successor');
        else {
          const previous = this.coreDb.sqlite
            .prepare(
              'SELECT attempt_id AS attemptId, package_snapshot_id AS packageSnapshotId FROM worker_backend_sessions WHERE agent_session_id = ? AND package_snapshot_id <> ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1'
            )
            .get(identity.agentSessionId, identity.packageSnapshotId) as
            | { attemptId: string; packageSnapshotId: string }
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
              identity: this.durableBackendSessionIdentity(
                this.requireDurableAgentSessionProvenance(prior, previous.attemptId).anchor
              ),
              attemptId: previous.attemptId,
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
      const result = await this.effect(session.identity, session.attemptId, 'workspace.collect', {
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
      const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
        `workspace:${db.sqlite.name}`
      );
      try {
        acceptWorkspaceBaseline(
          db,
          identity,
          result.head as { tree: string; manifest: string },
          expected,
          sources[0]?.source.kind === 'git' ? (sources[0].source.commit ?? null) : null
        );
      } finally {
        resume();
      }
    } finally {
      db.sqlite.close();
    }
  }

  /** Captures once per lifecycle boundary; committed receipts replay without another native scan. */
  private async collectWorkspaceSnapshot(
    session: NanoHostBackendTurnSession,
    boundary: 'turn-end' | 'release' | 'successor'
  ): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    const disposedCaptures = await this.assertWorkspaceCaptureSettled(
      session.sharedHarness.sandbox.sandboxBindingRef
    );
    const identity = this.workspaceCollectionIdentity(
      session,
      `${boundary}-${createHash('sha256').update(session.environmentPackage.snapshotId).digest('hex')}`
    );
    const db = openWorkspaceDb(this.coreDb.dataRoot, identity.workspaceId);
    try {
      applyScopedMigrations(db);
      let receipt = readWorkspaceCollection(db, identity);
      // Exact disposition was verified above. Retained A is never replaced by a release scan of B.
      if (disposedCaptures.has(session.attemptId)) return [];
      if (!receipt) {
        const cursor = readWorkspaceSnapshotCursor(db, identity);
        if (!cursor)
          throw new WorkspaceCollectionError({
            outcome: 'recovery_required',
            cause: 'accepted_base_unknown',
          });
        const command = this.workspaceCollectionCommand(session, identity, 'capture', cursor);
        const idleAnchor =
          requireSchedulerExecutionAttempt(this.coreDb, session.attemptId).phase === 'closed'
            ? getWorkerBackendSession(this.coreDb, session.attemptId)
            : null;
        if (idleAnchor) {
          const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
            `workspace:${db.sqlite.name}`
          );
          try {
            const original = (
              this.sharedStore ?? new FsStore({ dataRoot: this.coreDb.dataRoot })
            ).getAgentSession(identity.agentSessionId).retainedStorage;
            if (
              !original ||
              original.storageRef !== identity.storageRef ||
              original.workSlotRef !== identity.workSlot ||
              original.attachmentGeneration !== identity.attachmentGeneration
            )
              throw new WorkspaceCaptureRecoveryRequired(
                'Idle capture lacks its original attachment generation.'
              );
            db.sqlite
              .transaction(() => {
                if (
                  listWorkspaceReconciliationRecords(db, identity.workspaceId).some(
                    (record) => record.id === `wrr_capture_${identity.collectionId}`
                  )
                )
                  throw new WorkspaceCaptureRecoveryRequired(
                    'Idle capture already has its original continuation.'
                  );
                recordWorkspaceCaptureRecovery(db, idleAnchor, identity, null);
              })
              .immediate();
          } finally {
            resume();
          }
          // Workspace acknowledgement precedes Core drain; neither permits dispatch on partial failure.
          this.coreDb.sqlite
            .transaction(() => {
              const harness = this.coreDb.sqlite
                .prepare(`UPDATE harness_instance_records
              SET drain_state='draining' WHERE harness_binding_ref=? AND lifecycle_state='open'
              AND operation_state IN ('idle','settled') AND sandbox_runtime_id IN (
                SELECT sandbox_runtime_id FROM sandbox_runtime_records
                WHERE sandbox_binding_ref=? AND origin_physical_epoch=?
                  AND lifecycle_state='open' AND health_state='ready' AND cleanup_state='clean')`)
                .run(
                  session.harnessBindingRef,
                  session.sharedHarness.sandbox.sandboxBindingRef,
                  session.sharedHarness.sandbox.originPhysicalEpoch
                );
              if (harness.changes !== 1)
                throw new WorkspaceCaptureRecoveryRequired('Idle capture drain ownership changed.');
            })
            .immediate();
        }
        const result = await this.effect(session.identity, session.attemptId, 'workspace.collect', {
          ...command,
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
        let preserved: RawWorkspaceCapture | undefined;
        try {
          let candidate: Buffer | null = null;
          const { stagingPath: _stagingPath, ...durable } = result;
          if (result.outcome === 'candidate') {
            const staged = await inspectNanoHostStagedExport(result);
            session.retainedStagingPaths.push(staged.path);
            preserved = await preserveRawWorkspaceCapture({
              dataRoot: this.coreDb.dataRoot,
              identity,
              result: durable,
              staged,
              admission: this.fileAdmission,
            });
            session.retainedStagingPaths.splice(
              session.retainedStagingPaths.indexOf(staged.path),
              1
            );
            candidate = preserved.candidate;
          }
          const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
            `workspace:${db.sqlite.name}`
          );
          try {
            receipt = db.sqlite.transaction(() => {
              if (
                idleAnchor &&
                !listWorkspaceReconciliationRecords(db, identity.workspaceId).some(
                  (record) =>
                    record.id === `wrr_capture_${identity.collectionId}` &&
                    record.stateAfter === 'requires-human'
                )
              )
                throw new WorkspaceCaptureRecoveryRequired(
                  'Idle capture disposition changed during collection.'
                );
              const accepted = acceptWorkspaceCapture(db, identity, durable, candidate, preserved);
              if (idleAnchor)
                completeWorkspaceCaptureRecovery(db, idleAnchor, identity, preserved ?? null);
              return accepted;
            })();
          } finally {
            resume();
          }
        } catch (error) {
          // Even an idle scan has an existing positive drain; raw absence grants no later scan.
          drainNanoHostSandboxAdmission(this.coreDb, {
            sandboxBindingRef: session.sharedHarness.sandbox.sandboxBindingRef,
            originPhysicalEpoch: session.sharedHarness.sandbox.originPhysicalEpoch,
          });
          try {
            const anchor = getWorkerBackendSession(this.coreDb, session.attemptId);
            if (!anchor) throw new Error('Workspace capture lost its original backend anchor.');
            const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
              `workspace:${db.sqlite.name}`
            );
            try {
              recordWorkspaceCaptureRecovery(db, anchor, identity, preserved ?? null);
            } finally {
              resume();
            }
          } catch {
            console.error(
              'Workspace capture recovery publication is incomplete; backend remains drained.'
            );
          }
          throw error;
        }
      }
      // Captured Sandbox bytes remain evidence; no NanoCore host repository is an apply target.
      return [];
    } finally {
      db.sqlite.close();
    }
  }

  /**
   * Admits one exact idle physical operation under COORD 23:5x, never an ended Turn.
   * The closed attempt and immutable package supply provenance; the current resident/Epoch
   * supplies physical authority. A repeated key is result-only and cannot renew contact.
   */
  private beginIdleCleanupJournal(
    identity: WorkerGovernanceBackendSessionIdentity,
    attemptId: string,
    operation: NanoHostEffectOperation,
    input: Readonly<Record<string, unknown>>,
    originPhysicalEpoch: string,
    deadlineUnixMs: number,
    predecessor?: ExecutionCandidate
  ): ExecutionJournalIntent {
    if (!['bridge.close', 'sandbox.delete', 'workspace.collect', 'file.export'].includes(operation))
      throw new Error('Core idle cleanup has no admitted physical producer.');
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, attemptId);
    const anchor = getWorkerBackendSession(this.coreDb, attemptId);
    if (
      attempt.phase !== 'closed' ||
      !attempt.fenceRef ||
      !anchor ||
      !isDeepStrictEqual(this.durableBackendSessionIdentity(anchor), identity) ||
      anchor.workspaceId !== attempt.workspaceId ||
      anchor.threadId !== attempt.threadId ||
      anchor.turnId !== attempt.turnId ||
      anchor.agentSessionId !== attempt.agentSessionId ||
      anchor.packageSnapshotId !== attempt.inputRef ||
      anchor.sandboxBindingRef !== attempt.bindingRef ||
      anchor.originPhysicalEpoch !== originPhysicalEpoch ||
      this.requireCurrentPhysicalEpoch(identity.runtimeTargetId) !== originPhysicalEpoch
    )
      throw new Error(
        'Core idle cleanup has no exact closed resident provenance or current Epoch.'
      );
    const resident = this.findDurableSandboxBinding(identity);
    if (!resident || resident.originPhysicalEpoch !== originPhysicalEpoch)
      throw new Error('Core idle cleanup requires its exact physical resident and Epoch.');
    const workspaceDb = this.openRetiringWorkspaceDb(anchor.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;
    try {
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        anchor.workspaceId,
        anchor.packageSnapshotId
      ).snapshot;
    } finally {
      workspaceDb.sqlite.close();
    }
    const admission = requireSchedulerExecutionAttemptAdmissionContext(this.coreDb, attemptId);
    if (
      environmentPackage.scope.workspaceId !== anchor.workspaceId ||
      environmentPackage.scope.threadId !== anchor.threadId ||
      environmentPackage.scope.turnId !== anchor.turnId ||
      environmentPackage.scope.agentSessionId !== anchor.agentSessionId ||
      environmentPackage.snapshotId !== anchor.packageSnapshotId ||
      !isDeepStrictEqual(environmentPackage.scope.triggerActor, admission.triggerActor)
    )
      throw new Error('Core idle cleanup immutable package actor or physical lineage conflicts.');
    const request = createNanoHostEffectRequest(identity, attemptId, operation, input);
    const requestId = request.requestId!;
    const started = Date.now();
    if (
      !Number.isSafeInteger(deadlineUnixMs) ||
      deadlineUnixMs <= started ||
      deadlineUnixMs > started + NANO_HOST_HARNESS_RESULT_BUDGET_MS
    )
      throw new Error('Core idle cleanup requires its original bounded cleanup allowance.');
    const fingerprint = commandInputHash({
      definition: CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
      requestId,
      operation,
      identity,
      attemptId,
      originPhysicalEpoch,
      sandboxBindingRef: resident.sandboxBindingRef,
    });
    const span: ExecutionJournalIntent['span'] = {
      traceId: randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
      flags: 0,
      name: 'nanohost.idle-cleanup',
      kind: 'INTERNAL',
      startTimeUnixNano: BigInt(started) * 1_000_000n,
      endTimeUnixNano: null,
      status: { code: 'UNSET' },
      attributes: [],
      droppedAttributesCount: 0,
      events: [],
      droppedEventsCount: 0,
      links: [],
      droppedLinksCount: 0,
      instrumentationScope: {
        name: 'openkit.nanocore.runtime',
        attributes: [],
        droppedAttributesCount: 0,
      },
      resource: { attributes: [], droppedAttributesCount: 0 },
    };
    const intent: ExecutionJournalIntent = {
      execution: {
        ref: { owner: { kind: 'server' }, executionId: `idle-cleanup:${requestId}` },
        definitionVersion: CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
        workId: requestId,
        fingerprint,
        exclusionRefs: [resident.sandboxBindingRef, originPhysicalEpoch],
        span,
      },
      stepId: `effect:${requestId}`,
      parentStepId: null,
      parent: null,
      inspectedStep: null,
      control: {
        definitionVersion: CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
        kind:
          operation === 'workspace.collect' || operation === 'file.export'
            ? 'collect'
            : operation === 'sandbox.delete'
              ? 'release'
              : 'inspect-cleanup',
        target: {
          backendKind: identity.backendKind,
          targetId: identity.runtimeTargetId,
          allocationRef: resident.sandboxBindingRef,
        },
        workId: requestId,
        operationId: requestId,
        attemptId,
        invocationId: randomUUID(),
        actor: environmentPackage.scope.triggerActor,
        inputRefs: [
          anchor.packageSnapshotId,
          anchor.agentSessionId,
          anchor.sandboxBindingRef,
          resident.sandboxBindingRef,
          originPhysicalEpoch,
          commandInputHash(input),
        ],
        outputRefs: [],
        fingerprint,
        permittingDecisionRef: null,
        authorityRefs: [
          anchor.packageSnapshotId,
          anchor.sandboxBindingRef,
          resident.sandboxBindingRef,
          originPhysicalEpoch,
        ],
        retryDeclarationRef: null,
        retryPermitted: false,
        deadlineUnixNano: BigInt(deadlineUnixMs) * 1_000_000n,
        physicalFenceRefs: [originPhysicalEpoch],
      },
      carriage: { operation, requestId, sequence: null, bindingRef: resident.sandboxBindingRef },
      span: {
        ...span,
        spanId: randomBytes(8).toString('hex'),
        parentSpanId: span.spanId,
        name: operation,
      },
    };
    controlStoreFor(this.coreDb.sqlite).write((sqlite) => {
      // Journal primitives use only this supplied SQLite connection; no sibling writer participates.
      const coreDb = sqlite === this.coreDb.sqlite ? this.coreDb : { ...this.coreDb, sqlite };
      const sandbox = sqlite
        .prepare(`SELECT sandbox_runtime_id AS id,
        origin_physical_epoch AS origin, runtime_target_id AS targetId, drain_state AS drainState
        FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?`)
        .get(resident.sandboxBindingRef) as
        | { id: string; origin: string; targetId: string; drainState: string }
        | undefined;
      if (!sandbox) throw new Error('Core idle cleanup requires a positive resident binding.');
      if (
        sandbox.origin !== originPhysicalEpoch ||
        sandbox.targetId !== identity.runtimeTargetId ||
        (input.sandboxId !== undefined &&
          input.sandboxId !== nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId)) ||
        (['bridge.close', 'sandbox.delete'].includes(operation) &&
          sandbox.drainState !== 'draining') ||
        this.nonClosedSandboxAttempts(
          environmentPackage,
          identity.runtimeTargetId,
          originPhysicalEpoch,
          nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId)
        ).length !== 0 ||
        sqlite
          .prepare(`SELECT 1 FROM harness_instance_records WHERE sandbox_runtime_id = ?
            AND (active_turn_count <> 0 OR operation_state IN ('queued', 'dispatched')) LIMIT 1`)
          .get(sandbox.id)
      )
        throw new Error('Core idle cleanup resident is stale or has live work.');
      if (
        sqlite
          .prepare('SELECT 1 FROM control_executions WHERE id = ?')
          .get(intent.execution.ref.executionId)
      )
        throw Object.assign(
          new Error('Core idle cleanup key already exists; inspect retained result only.'),
          {
            reasonCode: 'idle_cleanup_result_only',
            executionRef: intent.execution.ref,
          }
        );
      const prior =
        predecessor &&
        (sqlite
          .prepare('SELECT revision FROM control_executions WHERE id = ?')
          .get(predecessor.ref.execution.executionId) as { revision: number } | undefined);
      if (predecessor && prior?.revision !== predecessor.revision)
        throw new Error('Idle cleanup predecessor changed before delete admission.');
      writeExecutionJournalIntent(coreDb, intent);
    });
    this.idleCleanup.onCommit();
    return intent;
  }

  /**
   * Consumes a real keyed result with its effect outcome in one existing Core FULL transaction.
   * The fingerprint comes from the actual receiver result. Unknown keeps its original exclusion;
   * closing a completed operation root does not prove wider Sandbox absence or prior work success.
   */
  private async settleIdleCleanupJournal(
    intent: ExecutionJournalIntent,
    state: 'completed' | 'failed' | 'unknown',
    resultFingerprint?: string
  ): Promise<void> {
    const reader = createExecutionStepJournalReader(this.coreDb, { kind: 'server' });
    const ref = { execution: intent.execution.ref, stepId: intent.stepId };
    const original = await reader.readInvocation(ref);
    if (
      !isDeepStrictEqual({ ...original.control, outputRefs: [] }, intent.control) ||
      !isDeepStrictEqual(original.carriage, intent.carriage)
    )
      throw new Error('Core idle cleanup result does not match its admitted invocation.');
    // A transport unknown without a receiver result remains immutable. A later real result
    // adds only linked consumption evidence and never releases that original exclusion.
    const lateResult =
      original.state === 'unknown' &&
      original.control.outputRefs.length === 0 &&
      resultFingerprint !== undefined;
    const consumeControl =
      resultFingerprint === undefined
        ? undefined
        : {
            ...intent.control,
            kind: 'consume-receipt' as const,
            target: null,
            invocationId: `${intent.control.invocationId}:consume`,
            inputRefs: [resultFingerprint],
            outputRefs: [],
            fingerprint: commandInputHash({
              operation: intent.carriage.requestId,
              resultFingerprint,
            }),
            deadlineUnixNano: null,
          };
    if (original.state !== 'intent') {
      if (
        !lateResult &&
        (original.state !== state ||
          !isDeepStrictEqual(
            original.control.outputRefs,
            resultFingerprint === undefined ? [] : [resultFingerprint]
          ))
      )
        throw new Error('Core idle cleanup result replay conflicts.');
      if (resultFingerprint === undefined) return;
      const present = this.coreDb.sqlite
        .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
        .get(ref.execution.executionId, `${intent.stepId}:consume`);
      if (present) {
        const consumed = await reader.readInvocation({
          execution: ref.execution,
          stepId: `${intent.stepId}:consume`,
        });
        const linked = await reader.readLinkedInspections(ref);
        if (
          consumed.state !== 'completed' ||
          !isDeepStrictEqual({ ...consumed.control, outputRefs: [] }, consumeControl) ||
          !isDeepStrictEqual(consumed.carriage, intent.carriage) ||
          !isDeepStrictEqual(consumed.control.outputRefs, [resultFingerprint]) ||
          !linked.some((entry) => entry.inspection.ref.stepId === consumed.ref.stepId)
        )
          throw new Error('Core idle cleanup retained consumption conflicts.');
        return;
      }
      if (!lateResult) throw new Error('Core idle cleanup atomic consumption is missing.');
    }
    const now = BigInt(Date.now()) * 1_000_000n;
    const endedAt = now < intent.span.startTimeUnixNano ? intent.span.startTimeUnixNano : now;
    const status = { code: state === 'completed' ? ('OK' as const) : ('ERROR' as const) };
    const consume: ExecutionJournalIntent | undefined =
      consumeControl === undefined
        ? undefined
        : {
            ...intent,
            stepId: `${intent.stepId}:consume`,
            parentStepId: null,
            parent: null,
            inspectedStep: ref,
            control: consumeControl,
            span: {
              ...intent.span,
              spanId: createHash('sha256')
                .update(`${intent.span.spanId}:consume`)
                .digest('hex')
                .slice(0, 16),
              parentSpanId: intent.execution.span.spanId,
              name: 'nanohost.idle-cleanup.consume-receipt',
              startTimeUnixNano: endedAt,
              links: [
                {
                  traceId: intent.span.traceId,
                  spanId: intent.span.spanId,
                  flags: intent.span.flags,
                  attributes: [],
                  droppedAttributesCount: 0,
                },
              ],
            },
          };
    controlStoreFor(this.coreDb.sqlite).write((sqlite) => {
      const coreDb = sqlite === this.coreDb.sqlite ? this.coreDb : { ...this.coreDb, sqlite };
      let root = readExecutionJournalRoot(coreDb, ref.execution);
      if (!lateResult) {
        settleExecutionJournalStep(coreDb, {
          ref,
          expectedExecutionRevision: root.revision,
          state,
          outputRefs: resultFingerprint === undefined ? [] : [resultFingerprint],
          span: { ...intent.span, endTimeUnixNano: endedAt, status },
          nextPhase: 'closing',
          terminalCause: state === 'completed' ? null : `idle-${state}`,
          exclusionRefs: root.exclusionRefs,
        });
      }
      if (consume !== undefined) {
        writeExecutionJournalIntent(coreDb, consume);
        root = readExecutionJournalRoot(coreDb, ref.execution);
        settleExecutionJournalStep(coreDb, {
          ref: { execution: ref.execution, stepId: consume.stepId },
          expectedExecutionRevision: root.revision,
          state: 'completed',
          outputRefs: [resultFingerprint!],
          span: { ...consume.span, endTimeUnixNano: endedAt, status: { code: 'OK' } },
          nextPhase: state === 'completed' && !lateResult ? 'closed' : 'closing',
          terminalCause: state === 'completed' && !lateResult ? null : root.terminalCause,
          exclusionRefs: state === 'completed' && !lateResult ? [] : root.exclusionRefs,
        });
      }
    });
    this.idleCleanup.onCommit();
  }

  /** Dispatches one fixed effect with an identity derived from durable lineage. */
  private async effect(
    identity: WorkerGovernanceBackendSessionIdentity,
    attemptId: string,
    operation: NanoHostEffectOperation,
    input: Readonly<Record<string, unknown>>,
    retiringSandboxOrigin?: string,
    signal?: AbortSignal,
    predecessor?: ExecutionCandidate
  ): Promise<Record<string, unknown>> {
    if (!this.sessionDispatch) {
      throw new Error('NanoHost fixed-effect dispatcher is not configured.');
    }
    const originPhysicalEpoch =
      retiringSandboxOrigin ?? this.requireCurrentBackendPhysicalEpoch(identity);
    if (
      retiringSandboxOrigin !== undefined &&
      this.requireCurrentPhysicalEpoch(identity.runtimeTargetId) !== retiringSandboxOrigin
    ) {
      throw new Error('NanoHost retiring Sandbox physical Epoch is no longer current.');
    }
    const request = createNanoHostEffectRequest(identity, attemptId, operation, input);
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, attemptId);
    const tracksPreparation =
      attempt.phase === 'open' &&
      attempt.deadline === null &&
      !['image.inspect', 'storage.inspect'].includes(operation);
    const recorded = tracksPreparation
      ? recordSchedulerExecutionOperation(this.coreDb, {
          attemptId: attemptId,
          operationId: request.requestId!,
        })
      : null;
    const cleanupTarget =
      operation === 'bridge.close' || operation === 'sandbox.delete'
        ? (this.coreDb.sqlite
            .prepare(`SELECT sandbox_binding_ref AS sandboxBindingRef
        FROM sandbox_runtime_records WHERE ('nh-' || substr(sandbox_compatibility_key, 1, 16)) = ?
          AND origin_physical_epoch = ? AND runtime_target_id = ?`)
            .get(input.sandboxId, originPhysicalEpoch, identity.runtimeTargetId) as
            | { sandboxBindingRef: string }
            | undefined)
        : undefined;
    const store = this.sharedStore ?? new FsStore({ dataRoot: this.coreDb.dataRoot });
    const workspaceDb =
      attempt.phase === 'closed'
        ? null
        : openWorkspaceDb(this.coreDb.dataRoot, attempt.workspaceId);
    const deadlineUnixMs = Math.min(
      Date.now() +
        (operation === 'image.acquire' || operation === 'image.build' ? 900_000 : 300_000),
      attempt.phase === 'open' && attempt.deadline !== null
        ? Date.parse(attempt.deadline)
        : Infinity
    );
    const cleanup =
      attempt.phase !== 'open' || operation === 'bridge.close' || operation === 'sandbox.delete';
    let journal: ExecutionJournalIntent;
    try {
      journal = workspaceDb
        ? await beginWorkerTurnJournalStep(
            store,
            workspaceDb,
            attempt.turnId,
            cleanup
              ? 'inspect-cleanup'
              : operation === 'workspace.collect' || operation === 'file.export'
                ? 'collect'
                : operation === 'image.acquire' || operation === 'image.build'
                  ? 'resolve-setup'
                  : operation === 'image.inspect' || operation === 'storage.inspect'
                    ? 'validate-setup'
                    : 'materialize',
            {
              operation,
              requestId: request.requestId!,
              sequence: null,
              bindingRef: attempt.bindingRef,
            },
            { operationId: request.requestId!, deadline: new Date(deadlineUnixMs).toISOString() }
          )
        : this.beginIdleCleanupJournal(
            identity,
            attemptId,
            operation,
            input,
            originPhysicalEpoch,
            deadlineUnixMs,
            predecessor
          );
    } catch (error) {
      workspaceDb?.sqlite.close();
      throw error;
    }
    const reader = createExecutionStepJournalReader(
      workspaceDb ?? this.coreDb,
      journal.execution.ref.owner
    );
    const ref = { execution: journal.execution.ref, stepId: journal.stepId };
    const effectSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(Math.max(1, deadlineUnixMs - Date.now())),
    ]);
    const beforeDelivery = async () => {
      effectSignal.throwIfAborted();
      const started = performance.now();
      const current = workspaceDb
        ? await store.writeWorkspaceExecutionJournalIntent(workspaceDb.workspaceId, journal)
        : await reader.readInvocation(ref);
      effectSignal.throwIfAborted();
      this.requireCurrentBackendPhysicalEpoch(identity, originPhysicalEpoch);
      // Closing retains exclusion, but completed collection and terminal handoff permit the
      // existing shared cleanup owner to fence the host. Never infer collection from phase.
      if (cleanupTarget) {
        const others = () =>
          this.nonClosedSandboxAttempts(
            {
              scope: attempt,
              snapshotId: identity.packageSnapshotId,
            },
            identity.runtimeTargetId,
            originPhysicalEpoch,
            String(input.sandboxId)
          ).filter((other) => other.attemptId !== attemptId);
        const collected = new Map<string, WorkerBackendSessionRecord>();
        for (const other of others()) {
          const anchor = getWorkerBackendSession(this.coreDb, other.attemptId);
          if (!anchor) throw new Error('NanoHost sibling cleanup lineage is unavailable.');
          const db = openWorkspaceDb(this.coreDb.dataRoot, anchor.workspaceId);
          try {
            if (!(await hasCompletedWorkerTurnCollection(db, anchor)))
              throw new Error('NanoHost wider cleanup requires acknowledged sibling collection.');
          } finally {
            db.sqlite.close();
          }
          collected.set(other.attemptId, anchor);
        }
        await this.assertWorkspaceCaptureSettled(cleanupTarget.sandboxBindingRef);
        // Core, native-operation and binding facts can change during the journal reads.
        for (const other of others()) {
          const anchor = getWorkerBackendSession(this.coreDb, other.attemptId);
          const sibling = requireSchedulerExecutionAttempt(this.coreDb, other.attemptId);
          const live = anchor && this.sessions.get(anchor.packageSnapshotId);
          const binding =
            anchor &&
            this.coreDb.sqlite
              .prepare(`SELECT 1
            FROM agent_session_runtime_bindings b JOIN harness_instance_records h
              ON h.harness_instance_id=b.harness_instance_id
            JOIN sandbox_runtime_records s ON s.sandbox_runtime_id=h.sandbox_runtime_id
            WHERE b.agent_session_id=? AND b.workspace_id=? AND b.thread_id=?
              AND s.runtime_target_id=? AND s.origin_physical_epoch=?
              AND s.sandbox_binding_ref=? AND b.lifecycle_state IN ('open','closed')
              AND b.cleanup_state='clean' AND b.current_turn_id IS NULL
              AND b.current_attempt_id IS NULL AND h.operation_state IN ('idle','settled')`)
              .get(
                anchor.agentSessionId,
                anchor.workspaceId,
                anchor.threadId,
                identity.runtimeTargetId,
                originPhysicalEpoch,
                cleanupTarget.sandboxBindingRef
              );
          // This exact live owner's map removal follows acknowledged session.close. A missing
          // SQL row alone supplies no close proof; keep this handle through its release fence.
          const detached =
            anchor &&
            live?.attemptId === other.attemptId &&
            live.terminalInspectionComplete &&
            !live.sharedHarness.bindings.has(anchor.agentSessionId);
          if (
            !anchor ||
            !isDeepStrictEqual(anchor, collected.get(other.attemptId)) ||
            sibling.phase !== 'closing' ||
            sibling.inputRef !== anchor.packageSnapshotId ||
            sibling.agentSessionId !== anchor.agentSessionId ||
            sibling.turnId !== anchor.turnId ||
            sibling.workspaceId !== anchor.workspaceId ||
            sibling.threadId !== anchor.threadId ||
            anchor.state !== 'cleaned' ||
            !anchor.physicalCleanedAt ||
            anchor.workspaceHandoffState !== 'complete' ||
            !isSealedTurnTerminal(store.getTurnById(anchor.turnId).status) ||
            (!binding && !detached) ||
            live?.pendingHarnessOperation ||
            live?.acceptedProofUnrecorded
          )
            throw new Error('NanoHost wider cleanup requires every sibling handoff to settle.');
        }
        effectSignal.throwIfAborted();
        this.requireCurrentBackendPhysicalEpoch(identity, originPhysicalEpoch);
      }
      if (current.state !== 'intent' || current.remainingMs - (performance.now() - started) <= 0)
        throw new Error('NanoHost fixed-effect original native allowance is unavailable.');
      if (!cleanup && requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase !== 'open')
        throw new Error('NanoHost fixed-effect execution is no longer admitted.');
    };
    let fingerprint: string | undefined;
    let consumption: Promise<void> | undefined;
    let consumeIntent: ExecutionJournalIntent | undefined;
    const consumeResult = async (value: Readonly<Record<string, unknown>>) => {
      const { resourceSummary: _diagnostic, stagingPath: _temporary, ...core } = value;
      const actual = commandInputHash(core);
      if (fingerprint !== undefined && fingerprint !== actual)
        throw new Error('NanoHost fixed-effect result replay conflicts with its original receipt.');
      fingerprint = actual;
      consumption ??= (async () => {
        const outcome = value.failureCode === 'effect_failed' ? 'failed' : 'completed';
        if (!workspaceDb) {
          await this.settleIdleCleanupJournal(journal, outcome, actual);
          return;
        }
        consumeIntent ??= this.harnessConsumptionIntent(journal, actual);
        const consume = consumeIntent;
        // Stable within the existing pending operation; no second receipt queue or effect retry.
        const prior = await reader.readInvocation(ref);
        if (prior.state === 'intent') {
          await endWorkerTurnJournalStep(store, workspaceDb, journal, outcome, [actual], consume);
        } else if (prior.state === 'unknown' && prior.control.outputRefs.length === 0) {
          await store.writeWorkspaceExecutionJournalIntent(workspaceDb.workspaceId, consume);
        } else if (
          prior.state !== outcome ||
          !isDeepStrictEqual(prior.control.outputRefs, [actual])
        ) {
          throw new Error('NanoHost fixed-effect native outcome conflicts.');
        }
        const consumed = await reader.readInvocation({
          execution: consume.execution.ref,
          stepId: consume.stepId,
        });
        if (consumed.state === 'intent')
          await endWorkerTurnJournalStep(store, workspaceDb, consume, 'completed', [actual]);
        else if (
          consumed.state !== 'completed' ||
          !isDeepStrictEqual(consumed.control.outputRefs, [actual])
        )
          throw new Error('NanoHost fixed-effect consumption conflicts.');
      })().catch((error) => {
        consumption = undefined;
        throw error;
      });
      await consumption;
    };
    let result: Record<string, unknown>;
    try {
      await beforeDelivery();
      result = requireNanoHostResultObject(
        await this.sessionDispatch.effect({
          ...request,
          signal: effectSignal,
          beforeDelivery,
          consumeResult,
        })
      );
      // Explicit physical peers can return directly; the production dispatcher awaits this same consumer before ACK.
      await consumeResult(result);
    } catch (error) {
      const notEnqueued =
        error instanceof NanoHostEffectNotEnqueuedError &&
        error.operation === operation &&
        error.requestId === request.requestId;
      if (!notEnqueued && cleanupTarget) {
        fenceNanoHostSandboxRuntime(this.coreDb, {
          sandboxBindingRef: cleanupTarget.sandboxBindingRef,
          timestamp: new Date().toISOString(),
        });
        this.fenceWorkerStorageForSandbox(cleanupTarget.sandboxBindingRef);
      }
      // Only the dispatch owner's correlated pre-enqueue refusal proves this operation absent.
      // Earlier effects still require the ordinary cleanup fence; arbitrary failures stay unknown.
      if (fingerprint === undefined) {
        const prior = await reader.readInvocation(ref);
        if (prior.state === 'intent') {
          if (workspaceDb)
            await endWorkerTurnJournalStep(
              store,
              workspaceDb,
              journal,
              notEnqueued ? 'failed' : 'unknown'
            );
          else await this.settleIdleCleanupJournal(journal, notEnqueued ? 'failed' : 'unknown');
        }
      }
      if (recorded && notEnqueued)
        acceptSchedulerExecutionObservation(this.coreDb, {
          ...schedulerExecutionCorrelation(recorded),
          disposition: 'not_accepted',
          execution: 'unknown',
          fenceRef: null,
          outcomeRef: null,
        });
      throw error;
    } finally {
      workspaceDb?.sqlite.close();
    }
    if (cleanupTarget && operation === 'sandbox.delete')
      this.markProvedSandboxDeletion(cleanupTarget.sandboxBindingRef, originPhysicalEpoch);
    if (cleanupTarget)
      drainNanoHostSandboxAdmission(this.coreDb, {
        sandboxBindingRef: cleanupTarget.sandboxBindingRef,
        originPhysicalEpoch,
      });
    if (recorded)
      acceptSchedulerExecutionObservation(this.coreDb, {
        ...schedulerExecutionCorrelation(recorded),
        disposition: 'accepted',
        execution: 'pending',
        fenceRef: null,
        outcomeRef: null,
      });
    return result;
  }

  /** Restores only original cleanup result consumers; retained completion never authorizes contact. */
  private createCleanupRecoveryResult(
    identity: WorkerGovernanceBackendSessionIdentity,
    originPhysicalEpoch: string
  ) {
    if (!this.sessionDispatch?.expectResultOnly) {
      return null;
    }
    requireStoredNanoHostPhysicalEpoch(originPhysicalEpoch);
    const attemptId = this.requireAttemptId(identity.packageSnapshotId);
    const cleanupInput = {
      attemptId: attemptId,
      sandboxId: nanoHostSandboxIdFromBackendSessionId(identity.backendSessionId),
    };
    if (requireSchedulerExecutionAttempt(this.coreDb, attemptId).phase === 'closed') return null;
    return this.sessionDispatch.expectResultOnly(
      (['bridge.close', 'sandbox.delete'] as const).map((operation) => {
        const request = createNanoHostEffectRequest(identity, attemptId, operation, cleanupInput);
        return { kind: operation, originPhysicalEpoch, requestId: request.requestId! };
      })
    );
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
    readonly sandboxCompatibilityKey: string;
    readonly updatedAt: string;
  } | null {
    const rows = this.coreDb.sqlite
      .prepare(
        `SELECT DISTINCT s.sandbox_binding_ref AS sandboxBindingRef,
                s.sandbox_compatibility_key AS sandboxCompatibilityKey,
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
      readonly sandboxCompatibilityKey: string;
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
      this.requireAttemptId(identity.packageSnapshotId)
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
      // Only coherent same-Epoch exclusion is an expected wait; every other proof refusal stays ordinary.
      if (
        runtimeTarget?.deploymentId === deploymentId &&
        runtimeTarget.predecessorFenced === 1 &&
        runtimeTarget.ready === 1 &&
        runtimeTarget.freshEmpty === 1 &&
        runtimeTarget.physicalEpoch &&
        /^[0-9a-f]{64}$/.test(runtimeTarget.physicalEpoch) &&
        runtimeTarget.physicalEpoch === originPhysicalEpoch
      )
        throw new NanoHostCleanupFencePendingError();
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
      this.requireAttemptId(identity.packageSnapshotId)
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

  /** Reads the exact execution attempt that owns one immutable package snapshot. */
  private requireAttemptId(packageSnapshotId: string): string {
    const row = this.coreDb.sqlite
      .prepare(
        `SELECT attempt_id AS attemptId
         FROM scheduler_execution_attempts
         WHERE input_ref = ?
         ORDER BY created_at DESC, attempt_id DESC
         LIMIT 1`
      )
      .get(packageSnapshotId) as { readonly attemptId: string } | undefined;
    if (!row) {
      throw new Error('NanoHost effect lineage has no durable execution attempt.');
    }
    return row.attemptId;
  }

  /** Reads the live backend session retained after successful materialization. */
  private requireSession(packageSnapshotId: string) {
    const session = this.sessions.get(packageSnapshotId);
    if (!session) {
      throw new Error('NanoHost materialized session is unavailable.');
    }
    return session;
  }

  /** Projects an already-validated original backend identity without reminting package-derived names. */
  private durableBackendSessionIdentity(
    anchor: WorkerBackendSessionRecord
  ): WorkerGovernanceBackendSessionIdentity {
    return {
      agentSessionId: anchor.agentSessionId,
      backendKind: 'openshell',
      backendSessionId: anchor.backendSessionId,
      deploymentId: anchor.deploymentId,
      packageSnapshotId: anchor.packageSnapshotId,
      runtimeTargetId: anchor.runtimeTargetId,
      stagingDirectoryRef: anchor.stagingDirectoryRef,
      transientProviderInstanceId: anchor.transientProviderInstanceId,
    };
  }

  /** Validates original admitted keys against verified retained JSON and exact package, lease and binding provenance. */
  private requireDurableAgentSessionProvenance(
    environmentPackage: AgentEnvironmentPackage,
    attemptId: string,
    historical?: AgentEnvironmentPackageSnapshotReadRecord
  ) {
    const anchor = getWorkerBackendSession(this.coreDb, attemptId);
    const workspaceDb = historical
      ? null
      : openWorkspaceDb(this.coreDb.dataRoot, environmentPackage.scope.workspaceId);
    let retainedSnapshot: AgentEnvironmentPackage;
    let normalizedSnapshot: AgentEnvironmentPackage;
    try {
      const record =
        historical ??
        requireAgentEnvironmentPackageSnapshot(
          workspaceDb!,
          environmentPackage.scope.workspaceId,
          environmentPackage.snapshotId
        );
      retainedSnapshot = record.retainedSnapshot;
      normalizedSnapshot = record.snapshot;
    } finally {
      workspaceDb?.sqlite.close();
    }
    const attachment = this.coreDb.sqlite
      .prepare(
        `SELECT b.agent_session_runtime_binding_id AS agentSessionRuntimeBindingId,
              b.agent_session_compatibility_key AS agentSessionCompatibilityKey,
              b.workspace_id AS workspaceId, b.thread_id AS threadId,
              b.native_handle_state AS nativeHandleState, b.native_handle_digest AS nativeHandleDigest,
              h.harness_instance_id AS harnessInstanceId, h.harness_binding_ref AS harnessBindingRef,
              h.harness_compatibility_key AS harnessCompatibilityKey,
              s.sandbox_compatibility_key AS sandboxCompatibilityKey,
              s.sandbox_binding_ref AS sandboxBindingRef, s.runtime_target_id AS runtimeTargetId,
              s.origin_physical_epoch AS originPhysicalEpoch,
              t.deployment_id AS deploymentId
       FROM agent_session_runtime_bindings b
       JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
       JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
       JOIN nanohost_runtime_targets t ON t.target_id = s.runtime_target_id
       WHERE b.agent_session_id = ?`
      )
      .get(environmentPackage.scope.agentSessionId) as
      | {
          agentSessionRuntimeBindingId: string;
          agentSessionCompatibilityKey: string;
          workspaceId: string;
          threadId: string;
          nativeHandleState: string;
          nativeHandleDigest: string | null;
          harnessInstanceId: string;
          harnessBindingRef: string;
          harnessCompatibilityKey: string;
          sandboxCompatibilityKey: string;
          sandboxBindingRef: string;
          runtimeTargetId: string;
          originPhysicalEpoch: string;
          deploymentId: string;
        }
      | undefined;
    const scope = environmentPackage.scope;
    const lease = this.coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
              agent_session_id AS agentSessionId, input_ref AS inputRef,
              binding_ref AS bindingRef
       FROM scheduler_execution_attempts WHERE attempt_id = ?`
      )
      .get(attemptId) as
      | {
          workspaceId: string;
          threadId: string;
          turnId: string;
          agentSessionId: string;
          inputRef: string;
          bindingRef: string;
        }
      | undefined;
    const admission = lease
      ? requireSchedulerExecutionAttemptAdmissionContext(this.coreDb, attemptId)
      : undefined;
    // First refusal wins in source order; only fixed predicate names enter App diagnostics.
    const reject: (failedCheck: WorkerNativeProofValidationError['failedCheck']) => never = (
      failedCheck
    ) => {
      throw new WorkerNativeProofValidationError(failedCheck, {
        proofAgentSessionId: scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        attemptId: attemptId,
        originPhysicalEpoch:
          anchor && /^[0-9a-f]{64}$/.test(anchor.originPhysicalEpoch)
            ? anchor.originPhysicalEpoch
            : null,
        attachmentPhysicalEpoch:
          attachment && /^[0-9a-f]{64}$/.test(attachment.originPhysicalEpoch)
            ? attachment.originPhysicalEpoch
            : null,
      });
    };
    if (!anchor) reject('package-binding-lineage/anchor-missing');
    if (!attachment) reject('package-binding-lineage/attachment-missing');
    if (!lease) reject('package-binding-lineage/lease-missing');
    if (!admission) reject('package-binding-lineage/admission-missing');
    if (!isDeepStrictEqual(environmentPackage, normalizedSnapshot))
      reject('package-binding-lineage/normalized-package');
    if (attachment.harnessCompatibilityKey !== nanoHostHarnessCompatibilityKey(retainedSnapshot))
      reject('package-binding-lineage/harness-key');
    if (
      attachment.agentSessionCompatibilityKey !==
      nanoHostAgentSessionCompatibilityKey(retainedSnapshot)
    )
      reject('package-binding-lineage/agent-session-key');
    if (attachment.sandboxCompatibilityKey !== nanoHostSandboxCompatibilityKey(retainedSnapshot))
      reject('package-binding-lineage/sandbox-key');
    if (!isDeepStrictEqual(scope.triggerActor, admission.triggerActor))
      reject('package-binding-lineage/actor');
    if (scope.requestId !== admission.requestId) reject('package-binding-lineage/request');
    if (this.requireAttemptId(environmentPackage.snapshotId) !== attemptId)
      reject('package-binding-lineage/snapshot-lease');
    if (anchor.workspaceId !== scope.workspaceId)
      reject('package-binding-lineage/anchor-workspace');
    if (anchor.threadId !== scope.threadId) reject('package-binding-lineage/anchor-thread');
    if (anchor.turnId !== scope.turnId) reject('package-binding-lineage/anchor-turn');
    if (anchor.agentSessionId !== scope.agentSessionId)
      reject('package-binding-lineage/anchor-agent-session');
    if (anchor.packageSnapshotId !== environmentPackage.snapshotId)
      reject('package-binding-lineage/anchor-snapshot');
    if (lease.workspaceId !== scope.workspaceId) reject('package-binding-lineage/lease-workspace');
    if (lease.threadId !== scope.threadId) reject('package-binding-lineage/lease-thread');
    if (lease.turnId !== scope.turnId) reject('package-binding-lineage/lease-turn');
    if (lease.agentSessionId !== scope.agentSessionId)
      reject('package-binding-lineage/lease-agent-session');
    if (lease.inputRef !== environmentPackage.snapshotId)
      reject('package-binding-lineage/lease-snapshot');
    if (lease.bindingRef !== anchor.sandboxBindingRef)
      reject('package-binding-lineage/lease-sandbox-binding');
    if (attachment.workspaceId !== scope.workspaceId)
      reject('package-binding-lineage/attachment-workspace');
    if (attachment.threadId !== scope.threadId) reject('package-binding-lineage/attachment-thread');
    if (attachment.runtimeTargetId !== anchor.runtimeTargetId)
      reject('package-binding-lineage/attachment-target');
    if (attachment.deploymentId !== anchor.deploymentId)
      reject('package-binding-lineage/attachment-deployment');
    if (attachment.originPhysicalEpoch !== anchor.originPhysicalEpoch)
      reject('package-binding-lineage/attachment-epoch');
    if (anchor.backendKind !== 'openshell') reject('package-binding-lineage/backend-kind');
    if (!sessionMatchesRuntimeImage(anchor, environmentPackage.runtime.image))
      reject('package-binding-lineage/backend-image');
    if (
      anchor.backendSessionId !==
      `${nanoHostSandboxId(attachment.sandboxCompatibilityKey)}-${createHash('sha256').update(environmentPackage.snapshotId).digest('hex').slice(0, 16)}`
    )
      reject('package-binding-lineage/backend-session');
    if (
      anchor.stagingDirectoryRef !==
      `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`
    )
      reject('package-binding-lineage/staging-directory');
    if (anchor.transientProviderInstanceId !== null)
      reject('package-binding-lineage/transient-provider');
    return { ...attachment, anchor };
  }

  /** Opens exact retained authority read-only for cleanup, without migration or executable scope admission. */
  private openRetiringWorkspaceDb(workspaceId: string) {
    const scope = nativeProductMetadataScope(this.coreDb.dataRoot, {
      kind: 'workspace',
      workspaceId,
    });
    const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
    return bindWorkspaceSqlite(reader.sqlite, this.coreDb.dataRoot, workspaceId);
  }

  /** Reads the immutable prior package and lease; retirement selects only a read-only historical owner. */
  private readDurableAgentSession(
    inspection: NanoHostAgentSessionContinuityInspection,
    retirement?: Pick<
      NanoHostIdleSandboxEviction,
      'originPhysicalEpoch' | 'physicalAbsent' | 'sandboxBindingRef'
    >
  ): {
    environmentPackage: AgentEnvironmentPackage;
    attemptId: string;
    historical: AgentEnvironmentPackageSnapshotReadRecord;
    ownerAdmitted: boolean;
  } {
    const latest = this.coreDb.sqlite
      .prepare(
        `SELECT attempt_id AS attemptId, workspace_id AS workspaceId,
                package_snapshot_id AS packageSnapshotId,
                (SELECT status FROM workspace_registry r
                 WHERE r.workspace_id = worker_backend_sessions.workspace_id) AS workspaceStatus
         FROM worker_backend_sessions WHERE agent_session_id = ?
         ORDER BY created_at DESC, attempt_id DESC LIMIT 1`
      )
      .get(inspection.agentSessionId) as
      | {
          attemptId: string;
          workspaceId: string;
          packageSnapshotId: string;
          workspaceStatus: string | null;
        }
      | undefined;
    if (!latest) throw new Error('Workspace release collection lineage is unavailable.');
    if (latest.workspaceStatus === 'deleted') {
      throw new WorkerNativeProofValidationError('package-binding-lineage/workspace-deleted');
    }
    // Inspection must preserve a missing Workspace rather than recreate canonical storage.
    const workspaceDb = retirement
      ? this.openRetiringWorkspaceDb(latest.workspaceId)
      : openBootVerifiedWorkspaceDb(this.coreDb.dataRoot, latest.workspaceId);
    let historical: AgentEnvironmentPackageSnapshotReadRecord;
    try {
      historical = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        latest.workspaceId,
        latest.packageSnapshotId
      );
    } finally {
      workspaceDb.sqlite.close();
    }
    const ownerAdmitted =
      latest.workspaceStatus === 'active' &&
      isScopeAdmitted(this.coreDb.dataRoot, 'workspace', latest.workspaceId);
    return {
      environmentPackage: historical.snapshot,
      attemptId: latest.attemptId,
      historical,
      ownerAdmitted,
    };
  }

  /** Restores a temporary Turn handle only for collection and local close. */
  private restoreDurableAgentSession(
    inspection: NanoHostAgentSessionContinuityInspection
  ): NanoHostBackendTurnSession {
    const { environmentPackage, attemptId } = this.readDurableAgentSession(inspection);
    this.restoreSession(environmentPackage, attemptId);
    return this.requireSession(environmentPackage.snapshotId);
  }

  /** Recognizes completed handoff from existing authorities without admitting the historical package. */
  private hasRecordedRetiringProof(
    inspection: NanoHostAgentSessionContinuityInspection,
    retirement: Pick<NanoHostIdleSandboxEviction, 'originPhysicalEpoch' | 'sandboxBindingRef'>,
    workSlotRef?: string
  ): boolean {
    if (!inspection.nativeHandleDigest) return false;
    const latest = this.coreDb.sqlite
      .prepare(`
      SELECT workspace_id AS workspaceId, thread_id AS threadId,
        package_snapshot_id AS packageSnapshotId, sandbox_binding_ref AS sandboxBindingRef,
        runtime_target_id AS runtimeTargetId, origin_physical_epoch AS originPhysicalEpoch,
        (SELECT status FROM workspace_registry r
         WHERE r.workspace_id = worker_backend_sessions.workspace_id) AS workspaceStatus
      FROM worker_backend_sessions WHERE agent_session_id = ?
      ORDER BY created_at DESC, attempt_id DESC LIMIT 1
    `)
      .get(inspection.agentSessionId) as
      | {
          workspaceId: string;
          threadId: string;
          packageSnapshotId: string;
          sandboxBindingRef: string;
          runtimeTargetId: string;
          originPhysicalEpoch: string;
          workspaceStatus: string | null;
        }
      | undefined;
    if (!latest) return false;
    // The cleanup owner already knows the exact Workspace; opaque executable discovery excludes it.
    const scope = nativeProductMetadataScope(this.coreDb.dataRoot, {
      kind: 'workspace',
      workspaceId: latest.workspaceId,
    });
    const row = readNativeProduct(scope, 'agent-session', inspection.agentSessionId);
    const ownerAdmitted =
      latest.workspaceStatus === 'active' &&
      isScopeAdmitted(this.coreDb.dataRoot, 'workspace', latest.workspaceId);
    if (!row && ownerAdmitted) return false;
    let session: ReturnType<typeof AgentSessionRecordSchema.parse>;
    if (row) session = AgentSessionRecordSchema.parse(row.record);
    else {
      // Only this exact non-admitted cleanup owner can read retained-only metadata; never migrate it.
      const workspaceRoot = join(this.coreDb.dataRoot, 'workspaces', latest.workspaceId);
      const runtimeRoot = join(workspaceRoot, 'runtime');
      const sessionsRoot = join(runtimeRoot, 'agent-sessions');
      const sessionRoot = join(sessionsRoot, inspection.agentSessionId);
      try {
        for (const directory of [workspaceRoot, runtimeRoot, sessionsRoot, sessionRoot])
          assertCanonicalDirectory(directory);
        const value = JSON.parse(readCanonicalTextFile(join(sessionRoot, 'session.json')));
        try {
          // The existing family decoder checks required semantics before projecting retained V1.
          session = AgentSessionRecordSchema.parse(
            decodeControlProduct('agent-session', value, scope.owner)
          );
        } catch {
          throw new WorkerNativeProofValidationError('retiring-proof-handoff/lineage-conflict');
        }
      } catch (cause) {
        if (cause instanceof WorkerNativeProofValidationError) throw cause;
        const missing =
          cause instanceof SyntaxError ||
          (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT');
        throw new WorkerNativeProofValidationError(
          missing
            ? 'retiring-proof-handoff/missing-proof'
            : 'retiring-proof-handoff/owner-discovery-refused'
        );
      }
    }
    if (
      session.id !== inspection.agentSessionId ||
      session.nativeHandleDigest !== inspection.nativeHandleDigest ||
      !session.retainedStorage ||
      (workSlotRef !== undefined && session.retainedStorage.workSlotRef !== workSlotRef)
    )
      return false;
    if (
      session.environmentPackageSnapshotId !== latest.packageSnapshotId ||
      session.workspaceId !== latest.workspaceId ||
      session.threadId !== latest.threadId ||
      latest.sandboxBindingRef !== retirement.sandboxBindingRef ||
      latest.originPhysicalEpoch !== retirement.originPhysicalEpoch
    )
      return false;
    const storage = getWorkerStorageBindingForSandbox(this.coreDb, {
      sandboxBindingRef: retirement.sandboxBindingRef,
    });
    return (
      storage !== null &&
      storage.runtimeTargetId === latest.runtimeTargetId &&
      storage.storageRef === session.retainedStorage.storageRef &&
      (session.retainedStorage.attachmentGeneration === undefined ||
        storage.attachmentGeneration === session.retainedStorage.attachmentGeneration) &&
      storage.workspaceId === session.workspaceId &&
      storage.contributors.some(
        (contributor) =>
          contributor.workSlotRef === session.retainedStorage!.workSlotRef &&
          contributor.threadId === session.threadId &&
          contributor.workspaceId === session.workspaceId
      )
    );
  }

  /**
   * Joins accepted proof to original persisted identities and compatibility keys reproduced from digest-verified retained JSON before normalization. Proof-only inspection needs no Turn handle or live Harness, including in an old physical Epoch. A recorder refusal leaves the binding and its cleanup ownership untouched.
   */
  private async handoffDurableAgentSessionProof(
    inspection: NanoHostAgentSessionContinuityInspection,
    record?: (
      digest: string,
      retainedStorage: { storageRef: string; workSlotRef: string; attachmentGeneration: number }
    ) => void | Promise<void>,
    retirement?: Pick<
      NanoHostIdleSandboxEviction,
      'originPhysicalEpoch' | 'physicalAbsent' | 'sandboxBindingRef'
    >
  ): Promise<void> {
    const digest = inspection.nativeHandleDigest;
    if (!digest) return;
    // Physical retirement is not executable admission. Keep the accepted historical proof and bytes.
    if (retirement?.physicalAbsent && this.hasRecordedRetiringProof(inspection, retirement)) return;
    const liveSession = [...this.sessions.values()].find(
      (session) => session.agentSessionRuntimeBindingId === inspection.agentSessionRuntimeBindingId
    );
    if (liveSession) liveSession.acceptedProofUnrecorded = true;
    const { environmentPackage, attemptId, historical, ownerAdmitted } =
      this.readDurableAgentSession(inspection, retirement);
    const attachment = this.requireDurableAgentSessionProvenance(
      environmentPackage,
      attemptId,
      retirement ? historical : undefined
    );
    const diagnostic = {
      proofAgentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      attemptId: attemptId,
      originPhysicalEpoch: attachment.anchor.originPhysicalEpoch,
      attachmentPhysicalEpoch: attachment.originPhysicalEpoch,
    };
    if (
      attachment.agentSessionRuntimeBindingId !== inspection.agentSessionRuntimeBindingId ||
      attachment.harnessInstanceId !== inspection.harnessInstanceId ||
      attachment.harnessBindingRef !== inspection.harnessBindingRef ||
      attachment.harnessCompatibilityKey !== inspection.harnessCompatibilityKey ||
      attachment.nativeHandleState !== 'ready' ||
      attachment.nativeHandleDigest !== digest ||
      environmentPackage.scope.agentSessionId !== inspection.agentSessionId
    ) {
      throw new WorkerNativeProofValidationError('accepted-ready-binding', diagnostic);
    }
    // A fenced attachment still proves where accepted native bytes belong; only reuse needs attached state.
    const storage = getWorkerStorageBindingForSandbox(this.coreDb, {
      sandboxBindingRef: attachment.sandboxBindingRef,
    });
    if (!storage || storage.runtimeTargetId !== attachment.runtimeTargetId) {
      throw new WorkerNativeProofValidationError('retained-storage-association', diagnostic);
    }
    const retainedStorage = {
      storageRef: storage.storageRef,
      workSlotRef: packageWorkerStorageWorkSlotRef(environmentPackage),
      attachmentGeneration: storage.attachmentGeneration,
    };
    const recorded =
      retirement &&
      this.hasRecordedRetiringProof(inspection, retirement, retainedStorage.workSlotRef);
    if (!ownerAdmitted) {
      // Proof recognition is read-only; no recorder can write a non-admitted Workspace.
      if (!recorded)
        throw new WorkerNativeProofValidationError(
          'retiring-proof-handoff/lineage-conflict',
          diagnostic
        );
      if (liveSession) liveSession.acceptedProofUnrecorded = false;
      return;
    }
    const recorder =
      record ??
      liveSession?.recordNativeHandleDigest ??
      ((
        digest: string,
        retainedStorage: { storageRef: string; workSlotRef: string; attachmentGeneration: number }
      ) => this.recordNativeHandleDigest(inspection.agentSessionId, digest, retainedStorage));
    if (liveSession) {
      if (
        liveSession.sharedHarness.sandbox.workerStorageBinding.storageRef !==
          retainedStorage.storageRef ||
        liveSession.sharedHarness.sandbox.workerStorageBinding.attachmentGeneration !==
          retainedStorage.attachmentGeneration ||
        packageWorkerStorageWorkSlotRef(liveSession.environmentPackage) !==
          retainedStorage.workSlotRef
      ) {
        throw new WorkerNativeProofValidationError('live-storage-association', diagnostic);
      }
      if (recorded) {
        liveSession.acceptedProofUnrecorded = false;
        return;
      }
      liveSession.recordNativeHandleDigest = recorder;
      // The durable result may precede the volatile cache handoff; record exactly the inspected proof.
      await this.recordAcceptedNativeHandleDigest(liveSession, digest);
      const cachedBinding = liveSession.sharedHarness.bindings.get(inspection.agentSessionId);
      if (cachedBinding?.agentSessionRuntimeBindingId === inspection.agentSessionRuntimeBindingId) {
        cachedBinding.nativeHandleDigest = digest;
      }
    } else if (!recorded) {
      await recorder(digest, retainedStorage);
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
    const closeOwner: NanoHostAgentSessionCloseOwner = { inspection, pending: null };
    const packageSnapshotId = session.environmentPackage.snapshotId;
    const sandbox = this.coreDb.sqlite
      .prepare(`SELECT sandbox_runtime_id AS id,
      drain_state AS drainState FROM sandbox_runtime_records WHERE sandbox_binding_ref=?`)
      .get(session.sharedHarness.sandbox.sandboxBindingRef) as
      | { id: string; drainState: string }
      | undefined;
    this.agentSessionCloseOwners.set(inspection.agentSessionRuntimeBindingId, closeOwner);
    try {
      await this.collectWorkspaceSnapshot(session, 'successor');
      const closed = await this.queueAndWaitForHarnessOperation(session, 'session.close', {
        agentSessionId: inspection.agentSessionId,
        agentSessionRuntimeBindingId: inspection.agentSessionRuntimeBindingId,
      });
      if (closed.state !== 'closed' || closed.privateState !== 'absent')
        throw new Error('NanoHost Harness session.close result is incompatible.');
      if (sandbox?.drainState === 'accepting') this.restoreSandboxAdmissionIfSafe(sandbox.id);
    } finally {
      // Idle close restores a Turn handle only for collection and close, not active occupancy.
      // Sandbox identities repeat on later compatible creation, so retaining it can block admission.
      this.agentSessionCloseOwners.delete(inspection.agentSessionRuntimeBindingId);
      this.sessions.delete(packageSnapshotId);
    }
  }

  /** Acquires the existing single command cell, releasing it only after its owner's settlement. */
  private async withHarnessOperationSlot<T>(
    harnessInstanceId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const predecessor = this.harnessOperationSettlements.get(harnessInstanceId);
    let release!: () => void;
    const settlement = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.harnessOperationSettlements.set(harnessInstanceId, settlement);
    try {
      if (predecessor) await predecessor;
      return await action();
    } finally {
      release();
      if (this.harnessOperationSettlements.get(harnessInstanceId) === settlement) {
        this.harnessOperationSettlements.delete(harnessInstanceId);
      }
    }
  }

  /** Holds the original allowance through slot wait, exact child admission and both receipt ACKs. */
  private async queueAndWaitForHarnessOperation(
    session: NanoHostBackendTurnSession,
    operation: NanoHostHarnessOperation,
    body: Readonly<Record<string, unknown>>
  ): Promise<Readonly<Record<string, unknown>>> {
    if (session.pendingHarnessOperation)
      throw new Error('NanoHost Harness producer already has an unsettled operation.');
    const recorded =
      operation === 'session.open'
        ? recordSchedulerExecutionOperation(this.coreDb, {
            attemptId: session.attemptId,
            operationId: commandInputHash({ attemptId: session.attemptId, operation, body }),
          })
        : null;
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, session.attemptId);
    const admittedUnixMs = Date.now();
    const deadlineUnixMs = Math.min(
      admittedUnixMs + NANO_HOST_HARNESS_RESULT_BUDGET_MS,
      (operation === 'session.open' || operation === 'turn.start') && attempt.deadline !== null
        ? Date.parse(attempt.deadline)
        : Infinity
    );
    let resolveResult!: (body: Readonly<Record<string, unknown>>) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // The timer can reject while an earlier producer owns the slot; preserve that rejection.
    void result.catch(() => {});
    const pending: PendingNanoHostHarnessOperation = {
      operation,
      sequence: null,
      operationId: null,
      reject: rejectResult,
      resolve: resolveResult,
      timeout: null,
      admittedUnixMs,
      deadlineUnixMs,
      deadlineMonotonicMs: performance.now() + Math.max(0, deadlineUnixMs - admittedUnixMs),
    };
    const closeOwner = this.agentSessionCloseOwners.get(session.agentSessionRuntimeBindingId);
    if (operation === 'session.close' && attempt.phase === 'closed') {
      const identity = {
        harnessInstanceId: session.harnessInstanceId,
        harnessBindingRef: session.harnessBindingRef,
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      };
      const consumerReceipt = readNanoHostIdleCloseConsumerReceipt(this.coreDb, identity);
      if (consumerReceipt === null)
        throw new Error('NanoHost durable idle close has no positive idle Core binding authority.');
      pending.coreIdleClose = { consumerReceipt };
      session.pendingHarnessOperation = pending;
      if (closeOwner) closeOwner.pending = pending;
      try {
        this.armHarnessOperationTimeout(
          pending,
          session.harnessBindingRef,
          () => session.pendingHarnessOperation === pending,
          () => {
            session.pendingHarnessOperation = null;
            if (closeOwner?.pending === pending) closeOwner.pending = null;
          }
        );
        return await this.withHarnessOperationSlot(session.harnessInstanceId, async () => {
          if (
            session.pendingHarnessOperation !== pending ||
            Date.now() < admittedUnixMs ||
            Date.now() >= deadlineUnixMs ||
            performance.now() >= pending.deadlineMonotonicMs ||
            readNanoHostIdleCloseConsumerReceipt(this.coreDb, identity) !== consumerReceipt
          )
            throw new Error(
              'NanoHost idle Core binding or cleanup allowance changed before queue.'
            );
          const prepared = prepareNanoHostHarnessOperation(this.coreDb, {
            body,
            harnessInstanceId: session.harnessInstanceId,
            operation,
            timestamp: new Date().toISOString(),
          });
          pending.coreIdleClose!.prepared = prepared;
          pending.sequence = queueNanoHostHarnessOperation(this.coreDb, {
            prepared,
            body,
            harnessInstanceId: session.harnessInstanceId,
            operation,
            timestamp: new Date().toISOString(),
          });
          return await result;
        });
      } finally {
        if (pending.timeout) clearTimeout(pending.timeout);
        if (session.pendingHarnessOperation === pending) session.pendingHarnessOperation = null;
        if (closeOwner?.pending === pending) closeOwner.pending = null;
      }
    }
    const workspaceDb = openWorkspaceDb(
      this.coreDb.dataRoot,
      session.environmentPackage.scope.workspaceId
    );
    const store = this.sharedStore ?? new FsStore({ dataRoot: this.coreDb.dataRoot });
    session.pendingHarnessOperation = pending;
    if (closeOwner) closeOwner.pending = pending;
    const kind =
      operation === 'session.open'
        ? 'open-session'
        : operation === 'session.inspect'
          ? 'inspect-session'
          : operation === 'turn.start'
            ? 'deliver-start'
            : operation === 'session.close'
              ? 'inspect-cleanup'
              : 'cancel';
    let parent: ExecutionJournalIntent | undefined;
    try {
      parent = await beginWorkerTurnJournalStep(
        store,
        workspaceDb,
        session.environmentPackage.scope.turnId,
        kind,
        {
          operation: `worker.${operation}.wait`,
          requestId:
            session.environmentPackage.scope.requestId ?? session.environmentPackage.scope.turnId,
          sequence: null,
          bindingRef: session.harnessBindingRef,
        },
        { operationId: null, deadline: new Date(deadlineUnixMs).toISOString() }
      );
      if (parent.control.deadlineUnixNano !== null) {
        pending.deadlineUnixMs = Math.min(
          deadlineUnixMs,
          Number(parent.control.deadlineUnixNano / 1_000_000n)
        );
        pending.deadlineMonotonicMs = Math.min(
          pending.deadlineMonotonicMs,
          performance.now() + Math.max(0, pending.deadlineUnixMs - Date.now())
        );
      }
      pending.journal = { store, workspaceDb, parent };
      this.armHarnessOperationTimeout(
        pending,
        session.harnessBindingRef,
        () => session.pendingHarnessOperation === pending,
        () => {
          session.pendingHarnessOperation = null;
          if (closeOwner) closeOwner.pending = null;
        }
      );
      const observation = await this.withHarnessOperationSlot(
        session.harnessInstanceId,
        async () => {
          if (
            session.pendingHarnessOperation !== pending ||
            Date.now() < admittedUnixMs ||
            Date.now() >= pending.deadlineUnixMs ||
            performance.now() >= pending.deadlineMonotonicMs
          )
            throw new Error('NanoHost original Harness allowance ended before queue admission.');
          const prepared = prepareNanoHostHarnessOperation(this.coreDb, {
            body,
            harnessInstanceId: session.harnessInstanceId,
            operation,
            timestamp: new Date().toISOString(),
          });
          pending.journal!.prepared = prepared;
          const command = prepared.command;
          const child = await beginWorkerTurnJournalStep(
            store,
            workspaceDb,
            session.environmentPackage.scope.turnId,
            kind,
            {
              operation,
              requestId: command.operationId,
              sequence: command.sequence,
              bindingRef: session.harnessBindingRef,
            },
            {
              operationId: command.operationId,
              deadline: new Date(pending.deadlineUnixMs).toISOString(),
              parent: pending.journal!.parent,
            }
          );
          pending.journal!.child = child;
          pending.journal!.reader = createExecutionStepJournalReader(
            workspaceDb,
            child.execution.ref.owner
          );
          if (
            session.pendingHarnessOperation !== pending ||
            Date.now() < admittedUnixMs ||
            Date.now() >= pending.deadlineUnixMs ||
            performance.now() >= pending.deadlineMonotonicMs
          )
            throw new Error('NanoHost original Harness allowance ended before queue publication.');
          pending.sequence = queueNanoHostHarnessOperation(this.coreDb, {
            prepared,
            body,
            harnessInstanceId: session.harnessInstanceId,
            operation,
            timestamp: new Date().toISOString(),
          });
          return await result;
        }
      );
      await endWorkerTurnJournalStep(
        store,
        workspaceDb,
        parent,
        'completed',
        pending.operationId ? [pending.operationId] : []
      );
      if (recorded)
        acceptSchedulerExecutionObservation(this.coreDb, {
          ...schedulerExecutionCorrelation(recorded),
          disposition: 'accepted',
          execution: 'pending',
          fenceRef: null,
          outcomeRef: null,
        });
      return observation;
    } catch (error) {
      const child = pending.journal?.child;
      if (child && !pending.journal?.consumerReceipt) {
        const current = await pending.journal!.reader!.readInvocation({
          execution: child.execution.ref,
          stepId: child.stepId,
        });
        if (current.state === 'intent')
          await endWorkerTurnJournalStep(
            store,
            workspaceDb,
            child,
            pending.operationId ? 'unknown' : session.turnStopSettlement ? 'cancelled' : 'failed'
          );
      }
      if (parent)
        await endWorkerTurnJournalStep(
          store,
          workspaceDb,
          parent,
          pending.journal?.consumerReceipt
            ? 'completed'
            : pending.operationId
              ? 'unknown'
              : session.turnStopSettlement
                ? 'cancelled'
                : 'failed'
        );
      throw error;
    } finally {
      if (pending.timeout) clearTimeout(pending.timeout);
      if (session.pendingHarnessOperation === pending) session.pendingHarnessOperation = null;
      if (closeOwner?.pending === pending) closeOwner.pending = null;
      workspaceDb.sqlite.close();
    }
  }

  /** Starts the one non-resetting enqueue-to-result budget for a Harness command. */
  private armHarnessOperationTimeout(
    pending: PendingNanoHostHarnessOperation,
    harnessBindingRef: string,
    isCurrent: () => boolean,
    clearOwner: () => void
  ): void {
    pending.timeout = setTimeout(
      () => {
        if (!isCurrent()) return;
        clearOwner();
        const retainedResult = pending.journal?.resultFingerprint !== undefined;
        const phase = retainedResult
          ? 'awaiting-durable-consumption'
          : pending.operationId
            ? 'dispatched-awaiting-result'
            : 'never-dispatched';
        let timeoutError = new Error(
          `NanoHost Harness ${pending.operation} result outage budget expired: ${phase}.`
        );
        try {
          if (retainedResult) {
            // The exact Core result stays available for result-only recovery. Expiry
            // ends this caller's wait; it cannot turn observed execution into non-execution.
          } else if (pending.operationId) {
            markNanoHostHarnessOperationUnknown(this.coreDb, {
              harnessBindingRef,
              operationId: pending.operationId,
              timestamp: new Date().toISOString(),
            });
          } else if (pending.sequence !== null) {
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
      },
      Math.max(
        0,
        Math.min(
          pending.deadlineUnixMs - Date.now(),
          pending.deadlineMonotonicMs - performance.now()
        )
      )
    );
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
      await this.recordAcceptedNativeHandleDigest(session, readyDigest);
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
  environmentPackage: AgentEnvironmentPackagePreview,
  readRuntimeConfig: (() => PublicNetworkConfiguration) | undefined,
  store: FsStore
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
      !currentScheduledTurnWorkspaceAuthority(coreDb, lineage, 'runtime.launch', true)
    )
      return false;
    const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, lineage).filter(
      (attempt) => attempt.phase !== 'closed'
    );
    const attempt = attempts.length === 1 ? attempts[0] : null;
    if (
      !attempt ||
      attempt.phase !== 'open' ||
      attempt.disposition === 'unknown' ||
      (attempt.agentSessionId !== null && attempt.agentSessionId !== scope.agentSessionId) ||
      (attempt.inputRef !== null && attempt.inputRef !== environmentPackage.snapshotId)
    )
      return false;
    if (attempt.deadline === null) {
      // Selected old-resident retirement precedes binding; incoming storage preparation precedes
      // submission. Both use exact current admission, never a not-yet-issued worker route token.
      if (attempt.agentSessionId !== null) {
        const native = requireNanoHostExecutionAttempt(coreDb, attempt.attemptId);
        if (native.startupDeadline <= new Date().toISOString() || native.recoveryState !== null)
          return false;
      }
    } else {
      if (!currentWorkerLineageWorkspaceAuthority(coreDb, lineage, 'runtime.launch', true))
        return false;
      const native = requireNanoHostExecutionAttempt(coreDb, attempt.attemptId);
      const live = resolveNanoHostAttemptTokenBinding(coreDb, {
        sandboxBindingRef: native.bindingRef,
        lineage,
      });
      if (live.status !== 'accepted' || live.attempt.attemptId !== native.attemptId) return false;
    }
    // These Store readers recheck committed metadata without reconstructing unrelated content.
    const workspace = store.getWorkspace(scope.workspaceId);
    const threads = store.listThreads(scope.workspaceId);
    const thread = threads.find((thread) => thread.id === contributor.threadId);
    if (!thread || workspaceIdForOwner(thread.owner) !== scope.workspaceId) return false;
    const audienceOwner = {
      getDataRoot: () => store.getDataRoot(),
      getWorkspace: () => workspace,
      getWorkspaceResourceAccess: (workspaceId: string) => {
        if (!readRuntimeConfig) throw new Error('Current Workspace Policy is unavailable.');
        const loaded = readRuntimeConfig().workspaceConfigs.find(
          (entry) => entry.workspaceId === workspaceId
        );
        if (!loaded) throw new Error('Current Workspace Policy is unavailable.');
        return readCurrentWorkspacePolicy({
          coreDb,
          workspaceId,
          policy: loaded.config.workspace.policy?.mediation ?? EMPTY_POLICY_DOCUMENT,
        });
      },
    };
    return (
      isThreadVisible(audienceOwner, thread, requesterUserId, false, 'thread.read', {
        kind: 'agent',
        userId: requesterUserId,
        agentId: environmentPackage.agent.agentId,
        processId: scope.agentSessionId,
      }) &&
      canDiscloseThreadToAudience(
        audienceOwner,
        thread,
        threads.find((candidate) => candidate.id === scope.threadId) ?? null
      )
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
  const {
    root: sessionRoot,
    contextRoot,
    packagePath,
  } = workerSessionInputPaths(environmentPackage.scope.agentSessionId);
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
            // Private disposable namespaces vary by AgentSession inside one physical Sandbox.
            slots: layout.slots.map((slot) =>
              slot.id === 'context'
                ? { ...slot, path: 'agent-session-context' }
                : slot.id === 'main-worktree'
                  ? { ...slot, path: 'worker-storage-worktree' }
                  : slot.id === 'turn-output'
                    ? { ...slot, path: 'agent-session-output' }
                    : slot
            ),
            control: { ...layout.control, contextRoot: 'agent-session-context' },
          },
          outputs: environmentPackage.workspace.outputs.map((output) =>
            output.id === 'turn-output-root' && output.path === `${sessionRoot}/outputs`
              ? { ...output, path: 'agent-session-output' }
              : output.path === mainWorktreePath
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
        control: sessionStaticControl({
          transcript: environmentPackage.control.transcript ?? null,
        }),
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

/** Selects only durable operation correlation from a submit or release payload. */
function inputCorrelation(input: ExecutionBackendCorrelation): ExecutionBackendCorrelation {
  return {
    attemptId: input.attemptId,
    backendId: input.backendId,
    inputRef: input.inputRef,
    bindingRef: input.bindingRef,
    operationId: input.operationId,
  };
}
