import { createHash } from 'node:crypto';
import { basename } from 'node:path';
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
import { WorkerRuntimeRawStreamManifestSchema } from '@openkit/worker-protocol';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { requireSchedulerSessionLeaseAdmissionContext } from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  fenceNanoHostSandboxRuntime,
  inspectNanoHostAgentSessionContinuity,
  markNanoHostHarnessOperationUnknown,
  type NanoHostAgentSessionContinuityInspection,
  type NanoHostHarnessCommand,
  type NanoHostHarnessOperation,
  type NanoHostHarnessResult,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
  removeNanoHostSandboxRuntimeByBinding,
  removeNanoHostSandboxRuntimeForHarness,
} from './nanohost-harness-records.js';
import type {
  NanoHostEffectOperation,
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import { projectOpenShellWorkerPolicy } from './openshell-policy.js';
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
import type {
  NanoHostContextPackageImport,
  WorkerGovernanceAgentSessionContinuityDisposition,
  WorkerGovernanceAgentSessionContinuityInput,
  WorkerGovernanceBackend,
  WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationContext,
  WorkerGovernanceMaterializationRecord,
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
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';
import type {
  WorkerRuntimeProvenanceCollection,
  WorkerTranscriptPayload,
} from './worker-transcript.js';
import {
  parseWorkspaceChangeSetManifest,
  stageWorkspaceChangeSet,
} from './workspace-materializer.js';

/** Exact V1 maximum for one raw NanoHost file export. */
const NANO_HOST_FILE_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
/** Maximum raw value accepted for one process environment credential. */
const NANO_HOST_RUNTIME_ENV_VALUE_MAX_BYTES = 64 * 1024;
/** Maximum raw value accepted for one runtime credential file. */
const NANO_HOST_RUNTIME_CREDENTIAL_FILE_MAX_BYTES = 1024 * 1024;
const NANO_HOST_RUNTIME_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Existing worker-control outage budget applied to one dispatched private Harness result. */
const NANO_HOST_HARNESS_RESULT_BUDGET_MS = 300_000;

/** Environment variables used by NanoCore turn executor selection. */
export interface TurnExecutorFactoryEnv {
  /** Deterministic internal self-check executor switch used by tests and smoke runs. */
  OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR?: string | undefined;
  /** HTTP port used when deriving the default worker-control upstream. */
  PORT?: string | undefined;
}

/** Options for creating the configured NanoCore turn executor. */
export interface CreateConfiguredTurnExecutorOptions {
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
  /** Binds one dispatch-time private Turn credential pair to the existing semantic gateway. */
  readonly acceptNanoHostHarnessCommand: (command: NanoHostHarnessCommand) => void;
  /** Advances one exact live producer after its durable Harness result settles. */
  readonly acceptNanoHostHarnessResult: (result: NanoHostHarnessResult) => void;
  /** Cleans one exact durable backend identity during restart or online recovery. */
  readonly cleanupBackendSession: (
    identity: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
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
    options.workspaceMutationAdmission
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
  workspaceMutationAdmission?: WorkspaceMutationAdmission | undefined
): ConfiguredWorkerLifecycleRuntime {
  const backend = new NanoHostWorkerGovernanceBackend(
    coreDb,
    nanoHostSessionDispatch,
    workerControlGateway
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
          ...(vaultBackend ? { vaultBackend } : {}),
          ...(workerControlGateway ? { workerControlGateway } : {}),
          ...(workspaceMutationAdmission ? { workspaceMutationAdmission } : {}),
        });

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
    },
    turnExecutor,
  };
}

/** One materialized Turn awaiting operations on the shared private Harness. */
interface NanoHostBackendTurnSession {
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly evidence: WorkerGovernanceEvidenceRecord[];
  readonly agentSessionCompatibilityKey: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly harnessBindingRef: string;
  readonly harnessInstanceId: string;
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  readonly leaseId: string;
  nativeSessionReusable: boolean;
  readonly sharedHarness: NanoHostSharedHarness;
  pendingHarnessOperation: PendingNanoHostHarnessOperation | null;
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
    }
  >;
  readonly adapterId: 'codex' | 'opencode' | 'pi';
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
  readonly sandboxCompatibilityKey: string;
  readonly sandboxIntegrationBindingRef: string;
  readonly sandboxRuntimeId: string;
}

/** NanoHost-backed effect boundary used by the sole production turn executor. */
class NanoHostWorkerGovernanceBackend implements WorkerGovernanceBackend {
  private readonly agentSessionCloseOwners = new Map<string, NanoHostAgentSessionCloseOwner>();
  private readonly cleanupRecoveryResults = new Map<
    string,
    ReturnType<NonNullable<NanoHostSessionDispatch['expectResultOnly']>>
  >();
  private readonly sessions = new Map<string, NanoHostBackendTurnSession>();
  private readonly sharedSandboxes = new Map<string, NanoHostSharedSandbox>();
  private readonly sharedHarnesses = new Map<string, NanoHostSharedHarness>();

  /**
   * Creates the NanoHost backend over the composition root's one session dispatcher.
   *
   * @param coreDb Durable Core database and lineage source.
   * @param sessionDispatch Optional dispatcher; production composition always supplies it.
   * @param workerControlGateway Optional existing semantic worker-control owner.
   */
  public constructor(
    private readonly coreDb: CoreDb,
    private readonly sessionDispatch?: NanoHostSessionDispatch,
    private readonly workerControlGateway?: WorkerControlGateway
  ) {}

  /** Registers one dispatched Turn's exact live route tokens with the existing gateway. */
  public acceptHarnessCommand(command: NanoHostHarnessCommand): void {
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
    if (session && command.adapterId !== session.sharedHarness.adapterId) {
      throw new Error('NanoHost dispatched operation selected the wrong Harness adapter.');
    }
    if (command.operation === 'turn.start') {
      if (!session) {
        throw new Error('NanoHost dispatched Turn has no live producer session.');
      }
      try {
        const leaseId = command.body.leaseId;
        const workerControlToken = command.body.workerControlToken;
        const workerInferenceToken = command.body.inferenceToken;
        if (
          leaseId !== session.leaseId ||
          typeof workerControlToken !== 'string' ||
          typeof workerInferenceToken !== 'string'
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
          workerControlToken,
          workerInferenceToken,
        });
      } catch (error) {
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
    pending.timeout = setTimeout(() => {
      if (
        (session && session.pendingHarnessOperation !== pending) ||
        (closeOwner && closeOwner.pending !== pending)
      ) {
        return;
      }
      if (session) {
        session.pendingHarnessOperation = null;
      }
      if (closeOwner) {
        closeOwner.pending = null;
        this.agentSessionCloseOwners.delete(closeOwner.inspection.agentSessionRuntimeBindingId);
      }
      let timeoutError = new Error('NanoHost Harness result outage budget expired.');
      try {
        markNanoHostHarnessOperationUnknown(this.coreDb, {
          harnessBindingRef,
          operationId: command.operationId,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        timeoutError = new Error('NanoHost Harness result outage cleanup failed.', {
          cause: error,
        });
      }
      pending.reject(timeoutError);
    }, NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    pending.timeout.unref();
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
    pending.reject(
      new Error(
        `NanoHost Harness ${pending.operation} ${result.disposition}: ${typeof reason === 'string' ? reason : 'invalid'}.`
      )
    );
  }

  /** Restores one compatible persisted Sandbox and its single Integration bridge. */
  private restoreSharedSandbox(
    sandboxCompatibilityKey: string,
    runtimeTargetId: string
  ): NanoHostSharedSandbox | null {
    const existing = this.sharedSandboxes.get(sandboxCompatibilityKey);
    if (existing) {
      return existing;
    }
    const row = this.coreDb.sqlite
      .prepare(
        `SELECT sandbox_runtime_id AS sandboxRuntimeId,
                runtime_target_id AS runtimeTargetId,
                sandbox_integration_binding_ref AS sandboxIntegrationBindingRef,
                image_digest AS imageDigest,
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
          readonly runtimeTargetId: string;
          readonly sandboxIntegrationBindingRef: string;
          readonly sandboxRuntimeId: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    if (
      row.runtimeTargetId !== runtimeTargetId ||
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
      sandboxCompatibilityKey,
      sandboxIntegrationBindingRef: row.sandboxIntegrationBindingRef,
      sandboxRuntimeId: row.sandboxRuntimeId,
    };
    this.sharedSandboxes.set(sandboxCompatibilityKey, sandbox);
    return sandbox;
  }

  /** Restores one exact persisted shared Harness without creating a second physical runtime. */
  private restoreSharedHarness(
    sandboxCompatibilityKey: string,
    harnessCompatibilityKey: string,
    runtimeTargetId: string,
    adapterId: 'codex' | 'opencode' | 'pi',
    adapterVersion: string
  ): NanoHostSharedHarness | null {
    const mapKey = nanoHostSharedHarnessMapKey(sandboxCompatibilityKey, harnessCompatibilityKey);
    const existing = this.sharedHarnesses.get(mapKey);
    if (existing) {
      return existing;
    }
    const row = this.coreDb.sqlite
      .prepare(
        `SELECT s.sandbox_runtime_id AS sandboxRuntimeId,
                s.runtime_target_id AS runtimeTargetId,
                s.image_digest AS imageDigest,
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
          readonly runtimeTargetId: string;
          readonly sandboxDrainState: string;
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
      sandboxCompatibilityKey,
      sandboxIntegrationBindingRef: row.sandboxIntegrationBindingRef,
      sandboxRuntimeId: row.sandboxRuntimeId,
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
    const sharedHarness = this.restoreSharedHarness(
      expectedSandboxKey,
      expectedHarnessKey,
      requireNanoHostRuntimeTargetId(identity),
      adapterId,
      environmentPackage.agent.runtimeVersion
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
      nativeSessionReusable: false,
      pendingHarnessOperation: null,
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
    environmentPackage: AgentEnvironmentPackage
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
    return {
      agentSessionId: environmentPackage.scope.agentSessionId,
      backendKind: 'openshell',
      backendSessionId: `nh-${nanoHostSandboxCompatibilityKey(environmentPackage).slice(0, 16)}`,
      deploymentId: target.deploymentId,
      packageSnapshotId: environmentPackage.snapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
      transientProviderInstanceId: null,
    };
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
      throw new Error('The configured NanoHost RuntimeTarget is not ready for admission.');
    }
    const inspection = inspectNanoHostAgentSessionContinuity(this.coreDb, input);
    if (!inspection) {
      return 'absent';
    }
    if (input.reuseAllowed) {
      return inspection.reusable ? 'reusable' : 'replacement-required';
    }
    await this.closeDurableAgentSession(inspection);
    for (const sharedHarness of this.sharedHarnesses.values()) {
      if (sharedHarness.harnessBindingRef === inspection.harnessBindingRef) {
        sharedHarness.bindings.delete(inspection.agentSessionId);
      }
    }
    return 'closed';
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
    const result = this.createCleanupRecoveryResult(identity);
    if (!result) {
      throw new Error('NanoHost result-only cleanup dispatcher is unavailable.');
    }
    this.cleanupRecoveryResults.set(identity.packageSnapshotId, result);
  }

  /** Clears one Turn locally, retaining only a proved reusable shared Harness. */
  public async cleanupSession(identity: WorkerGovernanceBackendSessionIdentity): Promise<void> {
    const leaseId = this.requireLeaseId(identity.packageSnapshotId);
    const session = this.sessions.get(identity.packageSnapshotId);
    const durableSandbox = session ? null : this.findDurableSandboxBinding(identity);
    const durableCleanupFailure =
      session || durableSandbox ? null : this.findDurableBackendCleanupFailure(identity);
    try {
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
          durableSandbox.updatedAt,
          identity.deploymentId
        );
        removeNanoHostSandboxRuntimeByBinding(this.coreDb, durableSandbox.sandboxBindingRef);
        return;
      }
      if (durableCleanupFailure) {
        this.requireLaterFreshRuntimeTarget(
          durableCleanupFailure.runtimeTargetId,
          durableCleanupFailure.updatedAt,
          identity.deploymentId
        );
        return;
      }
      if (session?.turnStarted && session.terminalInspectionComplete) {
        if (!session.nativeSessionReusable) {
          const closed = await this.queueAndWaitForHarnessOperation(session, 'session.close', {
            agentSessionId: session.environmentPackage.scope.agentSessionId,
            agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
          });
          if (
            closed.state !== 'closed' ||
            closed.childState !== 'absent' ||
            closed.privateState !== 'absent'
          ) {
            throw new Error('NanoHost Harness session.close result is incompatible.');
          }
          session.sharedHarness.bindings.delete(session.environmentPackage.scope.agentSessionId);
        }
      } else {
        try {
          const cleanupInput = { leaseId, sandboxId: identity.backendSessionId };
          const recoveryResult = !session
            ? (this.cleanupRecoveryResults.get(identity.packageSnapshotId) ??
              this.createCleanupRecoveryResult(identity))
            : null;
          if (recoveryResult) {
            const retained = await recoveryResult.finally(() =>
              this.cleanupRecoveryResults.delete(identity.packageSnapshotId)
            );
            requireNanoHostResultObject(retained.result);
            if (retained.kind === 'bridge.close') {
              await this.effect(identity, leaseId, 'sandbox.delete', cleanupInput);
            }
          } else {
            if (!session || session.sharedHarness.sandbox.bridgeOpen) {
              await this.effect(identity, leaseId, 'bridge.close', cleanupInput);
            }
            await this.effect(identity, leaseId, 'sandbox.delete', cleanupInput);
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
          }
          if (session) {
            session.nativeSessionReusable = false;
            this.forgetSharedSandbox(session.sharedHarness.sandbox.sandboxCompatibilityKey);
          }
          throw error;
        }
        if (session) {
          removeNanoHostSandboxRuntimeForHarness(this.coreDb, session.harnessInstanceId);
          this.forgetSharedSandbox(session.sharedHarness.sandbox.sandboxCompatibilityKey);
        } else if (durableSandbox) {
          removeNanoHostSandboxRuntimeByBinding(this.coreDb, durableSandbox.sandboxBindingRef);
        }
      }
    } finally {
      for (const stagingPath of session?.retainedStagingPaths ?? []) {
        await removeNanoHostStagedExport(stagingPath).catch(() => undefined);
      }
      this.workerControlGateway?.unregisterSession(identity.packageSnapshotId);
      this.sessions.delete(identity.packageSnapshotId);
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

  /** Acquires or builds the immutable image and creates the exact NanoHost sandbox. */
  public async materialize(
    environmentPackage: AgentEnvironmentPackage,
    context: WorkerGovernanceMaterializationContext = { workspaceRoots: [] }
  ): Promise<WorkerGovernanceMaterializationRecord> {
    const identity = this.planSession(environmentPackage);
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
    if (
      image.kind === 'build' &&
      (image.contextRef !== EMPTY_BUILD_CONTEXT_REF ||
        image.contextDigest !== EMPTY_BUILD_CONTEXT_DIGEST)
    ) {
      throw new Error('NanoHost image build requires the exact V1 empty build-context pair.');
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
    if (!sharedSandbox) {
      const deploymentImageDigest =
        image.kind === 'reference' &&
        image.pullPolicy === 'never' &&
        /^sha256:[0-9a-f]{64}$/.test(image.ref)
          ? image.ref
          : null;
      const imageResult =
        deploymentImageDigest !== null
          ? { digest: deploymentImageDigest, source: 'deployment' }
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
      const imageDigest = requireNanoHostResultString(imageResult, 'digest');
      const sandboxResult = await this.effect(identity, leaseId, 'sandbox.create', {
        environment: runtimeEnvironment,
        imageDigest,
        leaseId,
        policy: projectOpenShellWorkerPolicy({
          additionalFilesystemGrants:
            openShellFilesystemGrantsFromPackagePolicy(environmentPackage),
          additionalNetworkEndpoints:
            openShellNetworkEndpointsFromPackagePolicy(environmentPackage),
        }),
        sandboxId: identity.backendSessionId,
      });
      requireNanoHostResultString(sandboxResult, 'sandboxId');
      const sandboxIdentity = sandboxCompatibilityKey.slice(0, 24);
      sharedSandbox = {
        bridgeOpen: false,
        imageDigest,
        sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: `integration-binding-${sandboxIdentity}`,
        sandboxRuntimeId: `sandbox-runtime-${sandboxIdentity}`,
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
      .update(`${identity.backendSessionId}\0${environmentPackage.scope.agentSessionId}`)
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
      nativeSessionReusable: false,
      pendingHarnessOperation: null,
      retainedStagingPaths: [],
      sharedHarness,
      terminalInspectionComplete: false,
      turnStarted: false,
    });
    const fileInventory = [
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
        sandboxBindingRef:
          context.sandboxBindingRef ?? `sandbox-binding-${sandboxCompatibilityKey.slice(0, 24)}`,
        sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: sharedSandbox.sandboxIntegrationBindingRef,
        sandboxRuntimeId: sharedSandbox.sandboxRuntimeId,
        runtimeTargetId: requireNanoHostRuntimeTargetId(identity),
        timestamp: environmentPackage.createdAt,
      });
      this.sharedSandboxes.set(sandboxCompatibilityKey, sharedSandbox);
      this.sharedHarnesses.set(harnessMapKey, sharedHarness);
    }
    const importResults: Record<string, unknown>[] = [];
    for (const file of fileInventory) {
      const body = file.body;
      const byteLength = file.byteLength;
      const contentDigest = file.contentDigest;
      const relativePath = file.relativePath;
      const slot = file.slot;
      const sha256 = contentDigest;
      importResults.push(
        await this.effect(identity, leaseId, 'reference.import', {
          body,
          byteLength,
          relativePath,
          sandboxId: identity.backendSessionId,
          sha256,
          slot,
        })
      );
    }
    evidence.push(
      ...importResults.map((result) =>
        nanoHostEffectEvidence(environmentPackage.createdAt, result, 'reference-import')
      )
    );
    return {
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

  /** Opens the exact worker bridge after materialization. */
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
    let binding = session.sharedHarness.bindings.get(
      session.environmentPackage.scope.agentSessionId
    );
    if (!binding) {
      openNanoHostAgentSessionBinding(this.coreDb, {
        agentSessionCompatibilityKey: session.agentSessionCompatibilityKey,
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
        effectiveSetupGeneration: 1,
        harnessInstanceId: session.harnessInstanceId,
        threadId: session.environmentPackage.scope.threadId,
        timestamp: new Date().toISOString(),
        workspaceId: session.environmentPackage.scope.workspaceId,
      });
      const opened = await this.queueAndWaitForHarnessOperation(session, 'session.open', {
        adapterId: session.sharedHarness.adapterId,
        agentSessionCompatibilityKey: session.agentSessionCompatibilityKey,
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
        effectiveSetupGeneration: 1,
        threadId: session.environmentPackage.scope.threadId,
        workspaceId: session.environmentPackage.scope.workspaceId,
      });
      if (
        opened.state !== 'open' ||
        opened.nativeHandleState !== 'pending' ||
        opened.nativeHandleDigest !== null ||
        opened.maxActiveTurns !== 1
      ) {
        throw new Error('NanoHost Harness session.open result is incompatible.');
      }
      binding = {
        agentSessionCompatibilityKey: session.agentSessionCompatibilityKey,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
        nativeHandleDigest: null,
        nextTurnSequence: 0,
      };
      session.sharedHarness.bindings.set(session.environmentPackage.scope.agentSessionId, binding);
    } else {
      const inspected = await this.queueAndWaitForHarnessOperation(session, 'session.inspect', {
        agentSessionId: session.environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      });
      if (
        inspected.state !== 'open' ||
        inspected.childState !== 'absent' ||
        inspected.cleanupState !== 'clean' ||
        inspected.nativeHandleState !== 'ready' ||
        inspected.nativeHandleDigest !== binding.nativeHandleDigest
      ) {
        throw new Error('NanoHost retained AgentSession is not ready for exact resume.');
      }
    }
    const lease = this.coreDb.sqlite
      .prepare(
        'SELECT startup_deadline AS startupDeadline FROM scheduler_session_leases WHERE lease_id = ?'
      )
      .get(session.leaseId) as { readonly startupDeadline: string } | undefined;
    if (!lease) {
      throw new Error('NanoHost Harness Turn startup deadline is unavailable.');
    }
    const started = await this.queueAndWaitForHarnessOperation(session, 'turn.start', {
      aepRef: '/openkit/config/package.json',
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      contextPackageId: `context_${session.environmentPackage.scope.turnId}`,
      contextRef: '/openkit/context',
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

  /** Delivers one exact session-continuity interrupt through only the private Harness owner. */
  public async interruptTurn(packageSnapshotId: string): Promise<void> {
    const session = this.requireSession(packageSnapshotId);
    const result = await this.queueAndWaitForHarnessOperation(session, 'turn.interrupt', {
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
      leaseId: session.leaseId,
      turnId: session.environmentPackage.scope.turnId,
    });
    if (result.state !== 'interrupted' || result.childState !== 'absent') {
      throw new Error('NanoHost Harness turn.interrupt result is incompatible.');
    }
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
    // The executor supplies this only after accepted `final_status`; NanoHost
    // still requires its retained monitor to prove `processGroupAbsent` locally.
    const finalStatusAccepted = terminalBarrierProved;
    const processGroupAbsent = terminalBarrierProved;
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
        processGroupAbsent,
        presence: 'required',
        relativePath,
        sandboxId: session.identity.backendSessionId,
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
          processGroupAbsent,
          presence: 'required',
          relativePath,
          sandboxId: session.identity.backendSessionId,
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

  /** Exports the declared workspace manifest and patch after the accepted terminal barrier. */
  public async collectWorkspaceChanges(
    packageSnapshotId: string,
    terminalBarrierProved: true
  ): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    const session = this.requireSession(packageSnapshotId);
    await this.inspectTerminalHarnessSession(session);
    // The executor supplies this only after accepted `final_status`; NanoHost
    // still requires its retained monitor to prove `processGroupAbsent` locally.
    const finalStatusAccepted = terminalBarrierProved;
    const processGroupAbsent = terminalBarrierProved;
    if (session.environmentPackage.workspace.outputs.length === 0) {
      return [];
    }
    const manifestPath = '/openkit/session/workspace-changes.json';
    const { relativePath, slot } = resolveNanoHostExportPath(
      session.environmentPackage,
      manifestPath
    );
    const manifestResult = await this.effect(session.identity, session.leaseId, 'file.export', {
      finalStatusAccepted,
      maxByteLength: NANO_HOST_FILE_EXPORT_MAX_BYTES,
      processGroupAbsent,
      presence: 'optional',
      relativePath,
      sandboxId: session.identity.backendSessionId,
      slot,
      terminalBarrierProved,
    });
    if (Object.keys(manifestResult).length === 1 && manifestResult.state === 'absent') {
      return [];
    }
    requireNanoHostResultString(manifestResult, 'sha256');
    requireNanoHostResultByteLength(manifestResult, 'byteLength');
    const manifestText = (await consumeNanoHostStagedExport(manifestResult)).toString('utf8');
    const changeSet = parseWorkspaceChangeSetManifest(manifestText);
    let patchPayload = null;
    if (changeSet.patch?.ref.startsWith('worker-session://')) {
      const patchName = basename(changeSet.patch.ref.slice('worker-session://'.length));
      if (!patchName || patchName === '.' || patchName === '..') {
        throw new Error('NanoHost workspace patch reference is invalid.');
      }
      const patchPath = `/openkit/session/${patchName}`;
      const patchLocation = resolveNanoHostExportPath(session.environmentPackage, patchPath);
      const patchResult = await this.effect(session.identity, session.leaseId, 'file.export', {
        finalStatusAccepted,
        maxByteLength: NANO_HOST_FILE_EXPORT_MAX_BYTES,
        processGroupAbsent,
        presence: 'required',
        relativePath: patchLocation.relativePath,
        sandboxId: session.identity.backendSessionId,
        slot: patchLocation.slot,
        terminalBarrierProved,
      });
      const sha256 = requireNanoHostResultString(patchResult, 'sha256');
      const byteLength = requireNanoHostResultByteLength(patchResult, 'byteLength');
      if (sha256 !== changeSet.patch.digest || byteLength !== changeSet.patch.bytes) {
        throw new Error('NanoHost workspace patch identity disagrees with its manifest.');
      }
      patchPayload = {
        bytes: byteLength,
        digest: sha256,
        mediaType: 'text/x-diff' as const,
        text: (await consumeNanoHostStagedExport(patchResult)).toString('utf8'),
      };
    }
    const review = stageWorkspaceChangeSet(changeSet, {
      createdAt: new Date().toISOString(),
      patchPayload,
      reviewId: `swr_${changeSet.id}`,
      stagingRef: `staging://workspace/${changeSet.id}`,
    });
    return [{ changeSet, filesystemApply: null, patchPayload, review }];
  }

  /** Dispatches one fixed effect with an identity derived from durable lineage. */
  private async effect(
    identity: WorkerGovernanceBackendSessionIdentity,
    leaseId: string,
    operation: NanoHostEffectOperation,
    input: Readonly<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    if (!this.sessionDispatch) {
      throw new Error('NanoHost fixed-effect dispatcher is not configured.');
    }
    return requireNanoHostResultObject(
      await this.sessionDispatch.effect(
        this.createEffectRequest(identity, leaseId, operation, input)
      )
    );
  }

  /** Re-derives one exact effect request without dispatching it. */
  private createEffectRequest(
    identity: WorkerGovernanceBackendSessionIdentity,
    leaseId: string,
    operation: NanoHostEffectOperation,
    input: Readonly<Record<string, unknown>>
  ): NanoHostSessionEffectRequest {
    const commandInput =
      operation === 'bridge.open'
        ? input
        : {
            backendSessionId: identity.backendSessionId,
            leaseId,
            packageSnapshotId: identity.packageSnapshotId,
            ...input,
          };
    const requestId = createHash('sha256')
      .update(
        stableNanoHostEffectJson({
          backendSessionId: identity.backendSessionId,
          input: commandInput,
          leaseId,
          operation,
          packageSnapshotId: identity.packageSnapshotId,
        })
      )
      .digest('hex');
    return { input: commandInput, kind: operation, requestId };
  }

  /** Creates one bounded cleanup expectation set containing no command or token. */
  private createCleanupRecoveryResult(identity: WorkerGovernanceBackendSessionIdentity) {
    if (!this.sessionDispatch?.expectResultOnly) {
      return null;
    }
    const leaseId = this.requireLeaseId(identity.packageSnapshotId);
    const cleanupInput = { leaseId, sandboxId: identity.backendSessionId };
    const expectations = (['bridge.close', 'sandbox.delete'] as const).map((operation) => {
      const request = this.createEffectRequest(identity, leaseId, operation, cleanupInput);
      return { kind: operation, requestId: request.requestId! };
    });
    return this.sessionDispatch.expectResultOnly(expectations);
  }

  /** Finds the one Sandbox cleanup fence selected by immutable backend or AgentSession lineage. */
  private findDurableSandboxBinding(identity: WorkerGovernanceBackendSessionIdentity): {
    readonly cleanupState: string;
    readonly drainState: string;
    readonly healthState: string;
    readonly lifecycleState: string;
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
        identity.backendSessionId,
        identity.agentSessionId
      ) as Array<{
      readonly cleanupState: string;
      readonly deploymentId: string | null;
      readonly drainState: string;
      readonly healthState: string;
      readonly lifecycleState: string;
      readonly runtimeTargetId: string;
      readonly sandboxBindingRef: string;
      readonly updatedAt: string;
    }>;
    if (rows.length > 1) {
      throw new Error('NanoHost cleanup lineage matches more than one durable Sandbox.');
    }
    const durableSandbox = rows[0] ?? null;
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
      throw new Error('NanoHost cleanup failure does not match the requested backend lineage.');
    }
    return session.state === 'cleanup-failed' ? session : null;
  }

  /** Requires a strictly later fresh coordinator before an unknown cleanup can settle. */
  private requireLaterFreshRuntimeTarget(
    runtimeTargetId: string,
    fencedAt: string,
    deploymentId: string
  ): void {
    const runtimeTarget = this.coreDb.sqlite
      .prepare(
        `SELECT deployment_id AS deploymentId, last_fresh_ready_at AS lastFreshReadyAt
         FROM nanohost_runtime_targets
         WHERE target_id = ?`
      )
      .get(runtimeTargetId) as
      | {
          readonly deploymentId: string;
          readonly lastFreshReadyAt: string | null;
        }
      | undefined;
    if (
      !runtimeTarget ||
      runtimeTarget.deploymentId !== deploymentId ||
      !runtimeTarget.lastFreshReadyAt ||
      runtimeTarget.lastFreshReadyAt <= fencedAt
    ) {
      throw new Error('NanoHost unknown cleanup fence has no later fresh-ready proof.');
    }
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

  /** Queues one exact pre-lease close from durable binding lineage and awaits its settled result. */
  private closeDurableAgentSession(
    inspection: NanoHostAgentSessionContinuityInspection
  ): Promise<void> {
    if (this.agentSessionCloseOwners.has(inspection.agentSessionRuntimeBindingId)) {
      throw new Error('NanoHost AgentSession close already has a live producer.');
    }
    return new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      const owner: NanoHostAgentSessionCloseOwner = {
        inspection,
        pending: {
          operation: 'session.close',
          operationId: null,
          reject,
          resolve,
          timeout: null,
        },
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
      } catch (error) {
        this.agentSessionCloseOwners.delete(inspection.agentSessionRuntimeBindingId);
        owner.pending = null;
        reject(error);
      }
    }).then((closed) => {
      if (
        closed.state !== 'closed' ||
        closed.childState !== 'absent' ||
        closed.privateState !== 'absent'
      ) {
        throw new Error('NanoHost Harness session.close result is incompatible.');
      }
    });
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
    return new Promise((resolve, reject) => {
      session.pendingHarnessOperation = {
        operation,
        operationId: null,
        reject,
        resolve,
        timeout: null,
      };
      try {
        queueNanoHostHarnessOperation(this.coreDb, {
          body,
          harnessInstanceId: session.harnessInstanceId,
          operation,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        session.pendingHarnessOperation = null;
        reject(error);
      }
    });
  }

  /** Proves child absence once before any terminal output export or capacity return. */
  private async inspectTerminalHarnessSession(session: NanoHostBackendTurnSession): Promise<void> {
    if (session.terminalInspectionComplete) {
      return;
    }
    const inspected = await this.queueAndWaitForHarnessOperation(session, 'session.inspect', {
      agentSessionId: session.environmentPackage.scope.agentSessionId,
      agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
    });
    if (
      inspected.state !== 'open' ||
      inspected.childState !== 'absent' ||
      inspected.cleanupState !== 'clean' ||
      !['pending', 'ready'].includes(inspected.nativeHandleState as string) ||
      (inspected.nativeHandleState === 'ready' &&
        (typeof inspected.nativeHandleDigest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(inspected.nativeHandleDigest))) ||
      (inspected.nativeHandleState === 'pending' && inspected.nativeHandleDigest !== null)
    ) {
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
      accepted?.status === 'completed' && inspected.nativeHandleState === 'ready';
    const binding = session.sharedHarness.bindings.get(
      session.environmentPackage.scope.agentSessionId
    );
    if (!binding) {
      throw new Error('NanoHost terminal inspection lost its AgentSession binding.');
    }
    binding.nativeHandleDigest = session.nativeSessionReusable
      ? (inspected.nativeHandleDigest as string)
      : null;
    session.terminalInspectionComplete = true;
  }
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

/** Serializes deterministic request identity input with recursive key ordering. */
function stableNanoHostEffectJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableNanoHostEffectJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableNanoHostEffectJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Validates and projects runtime environment credentials into one private Sandbox effect. */
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
  const paths = new Set<string>();
  return credentials.map((credential) => {
    if (
      !credential.targetPath.startsWith('/sandbox/') ||
      credential.targetPath === '/sandbox/openkit' ||
      credential.targetPath.startsWith('/sandbox/openkit/') ||
      paths.has(credential.targetPath)
    ) {
      throw new Error('NanoHost runtime credential path is invalid.');
    }
    const body = Buffer.from(credential.credentialValue, 'utf8');
    if (body.byteLength > NANO_HOST_RUNTIME_CREDENTIAL_FILE_MAX_BYTES) {
      throw new Error('NanoHost runtime credential file is too large.');
    }
    paths.add(credential.targetPath);
    return {
      body,
      byteLength: body.byteLength,
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      relativePath: credential.targetPath.slice(1),
      slot: 'runtime-credential',
    };
  });
}

/** Hashes only the exact inputs that decide physical Sandbox reuse. */
function nanoHostSandboxCompatibilityKey(environmentPackage: AgentEnvironmentPackage): string {
  const responsibleUserId = responsibleUserIdForActor(environmentPackage.scope.triggerActor);
  return createHash('sha256')
    .update(
      stableNanoHostEffectJson({
        backend: environmentPackage.backend,
        credentials: environmentPackage.credentials,
        policy: environmentPackage.policy,
        responsibleUserTrust: {
          actorKind: environmentPackage.scope.triggerActor.kind,
          responsibleUserId,
        },
        runtimeImage: environmentPackage.runtime.image,
        schemaVersion: environmentPackage.schemaVersion,
        vault: environmentPackage.vault,
        workspace: {
          generatedFiles: environmentPackage.workspace.generatedFiles.map((file) => ({
            access: file.access,
            id: file.id,
            target: file.target,
          })),
          id: environmentPackage.scope.workspaceId,
          inputs: environmentPackage.workspace.inputs.map(nanoHostStaticWorkspaceInput),
          layout: planSessionWorkspaceMaterialization({ environmentPackage }).layout,
          outputs: environmentPackage.workspace.outputs,
        },
      })
    )
    .digest('hex');
}

/** Hashes the process-static adapter and Integration configuration of one Harness. */
function nanoHostHarnessCompatibilityKey(environmentPackage: AgentEnvironmentPackage): string {
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
        extensions: environmentPackage.extensions,
        resources: environmentPackage.resources,
        runtime: {
          binaries: environmentPackage.runtime.binaries,
          command: environmentPackage.runtime.command,
          process: environmentPackage.runtime.process ?? null,
          session: environmentPackage.runtime.session ?? null,
        },
        supply: environmentPackage.supply,
        vault: environmentPackage.vault,
      })
    )
    .digest('hex');
}

/** Selects one adapter already admitted by the static worker registry. */
function nanoHostAdapterId(
  environmentPackage: AgentEnvironmentPackage
): 'codex' | 'opencode' | 'pi' {
  const adapterId = environmentPackage.control.adapter.targetRuntime;
  if (adapterId !== 'codex' && adapterId !== 'opencode' && adapterId !== 'pi') {
    throw new Error(`NanoHost worker adapter is unsupported: ${adapterId}`);
  }
  return adapterId;
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
  input: AgentEnvironmentPackage['workspace']['inputs'][number]
): Record<string, unknown> {
  const { commit: _commit, ...source } = input.source;
  const { contentDigest: _contentDigest, ...materialization } = input.materialization ?? {};
  const isContext = materialization.slotId === 'context' || input.target === '/openkit/context';
  return {
    access: input.access,
    id: isContext ? 'context' : input.id,
    kind: input.kind,
    materialization,
    mount: input.mount ?? null,
    source: isContext ? { kind: source.kind } : source,
    target: input.target,
  };
}

/** Hashes only the exact inputs that decide one AgentSession's native continuity. */
function nanoHostAgentSessionCompatibilityKey(environmentPackage: AgentEnvironmentPackage): string {
  const sessionCompatibilityKey = planSessionWorkspaceMaterialization({ environmentPackage })
    .compatibilityKey.digest;
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
