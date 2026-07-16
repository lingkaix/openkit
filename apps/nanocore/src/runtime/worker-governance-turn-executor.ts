import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  WorkspaceInputSnapshot,
  WorkspaceMaterializationRecord,
  WorkspaceSynchronizationBackendKind,
} from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  SessionWorkspaceMaterializationPlan,
  WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import type { FsStore } from '../lib/store.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { getWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  type ResolveAgentEnvironmentBackendInput,
  type ResolvedAgentEnvironmentProviderCredential,
  type ResolvedAgentEnvironmentRuntimeEnvCredential,
  type ResolvedAgentEnvironmentRuntimeFileCredential,
  resolveAgentEnvironmentPackage,
} from './agent-environment.js';
import { generateUuidV7 } from './session-id.js';
import type {
  AgentSessionReadModel,
  RuntimeCapabilities,
  RuntimeEventFamily,
  RuntimeItemType,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './types.js';
import { projectWorkerBackendCleanup } from './worker-backend-cleanup-projection.js';
import {
  markWorkerBackendSessionLaunching,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
} from './worker-backend-sessions.js';
import {
  type AcceptedWorkerFinalStatus,
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
} from './worker-control-records.js';
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';
import { importWorkerTranscript } from './worker-transcript.js';
import { terminalizeGovernedWorkerTurnFailure } from './worker-turn-failure.js';
import { recordFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import { stageGitWorkspaceReview } from './workspace-review-git.js';
import {
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  recordWorkspaceBackendHandoff,
  recordWorkspaceSyncReview,
} from './workspace-sync-records.js';

/** Mutable exact-backend lifecycle retained while one turn executes and cleans up. */
interface WorkerTurnBackendLifecycle {
  /** Pure physical identity used for every cleanup attempt. */
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  /** Durable Core lifecycle record when the turn is scheduler-owned. */
  session: WorkerBackendSessionRecord | null;
  /** Stable successful cleanup timestamp retained across workspace projection retries. */
  physicalCleanedAt: string | null;
  /** Whether the atomic workspace handoff transaction committed. */
  workspaceHandoffState: 'pending' | 'complete';
}

/**
 * Options for the worker-governance-backed turn executor.
 */
export interface WorkerGovernanceTurnExecutorOptions {
  /** Optional durable completion barrier used after a detached backend launch. */
  awaitWorkerCompletion?:
    | ((
        environmentPackage: AgentEnvironmentPackage,
        leaseId: string
      ) => Promise<AcceptedWorkerFinalStatus>)
    | undefined;
  /** Backend that materializes, launches, collects, and tears down worker sessions. */
  backend: WorkerGovernanceBackend;
  /** Optional Core database used to persist workspace synchronization records. */
  coreDb?: CoreDb | undefined;
  /** Backend target used when resolving the Agent Environment Package. */
  environmentBackend: ResolveAgentEnvironmentBackendInput;
  /** Optional deterministic agent-session id factory for tests. */
  createAgentSessionId?: (() => string) | undefined;
  /** Optional clock for deterministic tests. */
  now?: (() => string) | undefined;
  /** Optional deterministic runtime provenance importer for tests. */
  runtimeProvenanceImporter?: typeof importWorkerRuntimeProvenance | undefined;
  /** Optional vault backend used for grant-derived provider attachments. */
  vaultBackend?: (() => VaultBackend) | undefined;
}

/**
 * Turn executor that runs one worker through a WorkerGovernanceBackend.
 */
export class WorkerGovernanceTurnExecutor implements TurnExecutor {
  public readonly capabilities: RuntimeCapabilities = {
    approvals: false,
    artifacts: true,
    interrupts: false,
    questions: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: false,
  };

  public readonly eventFamilies: readonly RuntimeEventFamily[] = [
    'turn.started',
    'turn.updated',
    'item.created',
    'item.completed',
    'artifact.created',
    'agent.session.updated',
    'turn.completed',
    'error',
  ];

  public readonly itemTypes: readonly RuntimeItemType[] = [
    'user-message',
    'assistant-message',
    'artifact-reference',
    'status',
  ];

  private readonly awaitWorkerCompletion:
    | ((
        environmentPackage: AgentEnvironmentPackage,
        leaseId: string
      ) => Promise<AcceptedWorkerFinalStatus>)
    | null;
  private readonly backend: WorkerGovernanceBackend;
  private readonly coreDb: CoreDb | null;
  private readonly createAgentSessionId: () => string;
  private readonly environmentBackend: ResolveAgentEnvironmentBackendInput;
  private readonly now: () => string;
  private readonly runtimeProvenanceImporter: typeof importWorkerRuntimeProvenance;
  private readonly vaultBackend: (() => VaultBackend) | null;

  /**
   * Creates the governance-backed turn executor.
   *
   * @param options Backend, package target, and optional deterministic factories.
   */
  public constructor(options: WorkerGovernanceTurnExecutorOptions) {
    this.awaitWorkerCompletion = options.awaitWorkerCompletion ?? null;
    this.backend = options.backend;
    this.coreDb = options.coreDb ?? null;
    this.environmentBackend = options.environmentBackend;
    this.createAgentSessionId = options.createAgentSessionId ?? (() => generateUuidV7());
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeProvenanceImporter =
      options.runtimeProvenanceImporter ?? importWorkerRuntimeProvenance;
    this.vaultBackend = options.vaultBackend ?? null;
  }

  /**
   * Polls provider refresh status for active backend sessions.
   *
   * @returns Product-safe refresh status evidence records.
   */
  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    return this.backend.collectProviderRefreshStatuses();
  }

  /**
   * Starts and completes one backend-governed worker turn.
   *
   * @param store Store that owns the workspace and thread.
   * @param turnId Turn id to execute.
   * @param input User-facing turn input.
   * @param context Runtime context with request id and workspace roots.
   * @returns Promise that resolves after transcript import and teardown.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    const turn = store.getTurnById(turnId);
    const requestId = context.requestId ?? null;
    let agentSessionId: string | null = context.agentSessionId ?? null;
    let workspaceDb: WorkspaceDb | null = null;
    let backendCapabilities: WorkerGovernanceBackendCapabilities | null = null;
    let backendLifecycle: WorkerTurnBackendLifecycle | null = null;
    let backendCleanupRequired = false;
    let closeoutAt: string | null = null;
    let environmentPackage: AgentEnvironmentPackage | null = null;
    let workerFinalStatus: AcceptedWorkerFinalStatus | null = null;
    let primaryFailed = false;
    let primaryError: unknown;

    try {
      if (!turn.agentId) {
        throw new Error(`Worker turn has no assigned agent: ${turn.id}`);
      }
      const agent = store.getAgent(turn.workspaceId, turn.agentId);
      const resolvedAgentSessionId = agentSessionId ?? this.createAgentSessionId();
      agentSessionId = resolvedAgentSessionId;
      const providerCredentials: ResolvedAgentEnvironmentProviderCredential[] = [];
      const runtimeEnvCredentials: ResolvedAgentEnvironmentRuntimeEnvCredential[] = [];
      const runtimeFileCredentials: ResolvedAgentEnvironmentRuntimeFileCredential[] = [];
      environmentPackage = resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: resolvedAgentSessionId,
        backend: this.environmentBackend,
        ...(context.backendRequirements
          ? { backendRequirements: context.backendRequirements }
          : {}),
        ...(this.coreDb ? { coreDb: this.coreDb } : {}),
        providerCredentialSink: (credential) => providerCredentials.push(credential),
        ...(context.providerSelection ? { providerSelection: context.providerSelection } : {}),
        requestId,
        runtimeEnvCredentialSink: (credential) => runtimeEnvCredentials.push(credential),
        runtimeFileCredentialSink: (credential) => runtimeFileCredentials.push(credential),
        ...(context.sandboxAccess ? { sandboxAccess: context.sandboxAccess } : {}),
        turn,
        turnInput: input,
        userId: store.getUserId(),
        ...(this.vaultBackend ? { vaultBackend: this.vaultBackend } : {}),
        ...(context.workspaceDataSourceCatalog
          ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
          : {}),
        workspaceCwd: workerVisibleWorkspaceCwd(context, this.environmentBackend),
        workspaceRoots: context.workspaceRoots,
        ...(context.workspaceSourceRefs
          ? { workspaceSourceRefs: context.workspaceSourceRefs }
          : {}),
      });
      const sessionWorkspace = (
        environmentPackage.extensions.openkit as {
          sessionWorkspace: SessionWorkspaceMaterializationPlan;
        }
      ).sessionWorkspace;
      const timestamp = this.now();
      const agentSession = store.createAgentSession({
        agentId: agent.id,
        configVersion: turn.configVersion,
        createdAt: timestamp,
        environmentPackageSnapshotId: environmentPackage.snapshotId,
        id: resolvedAgentSessionId,
        message: null,
        policySnapshotId: WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
        sessionCompatibilityKey: sessionWorkspace.compatibilityKey.digest,
        status: 'created',
        threadId: turn.threadId,
        updatedAt: timestamp,
        workspaceId: turn.workspaceId,
        workspaceRoots: context.workspaceRoots,
      });
      store.updateTurn(turnId, {
        agentProfileId: environmentPackage.agent.profileId,
        agentSessionId: agentSession.id,
      });
      const userItem = store.createItem({
        completedAt: timestamp,
        createdAt: timestamp,
        id: `it_user_${turnId}`,
        status: 'completed',
        text: input,
        threadId: turn.threadId,
        turnId,
        type: 'user-message',
        workspaceId: turn.workspaceId,
      });

      this.emitTurnStarted(store, environmentPackage, requestId);
      this.emitItemCreatedAndCompleted(store, environmentPackage, requestId, userItem);
      this.emitAgentSession(store, environmentPackage, requestId, agentSession);

      workspaceDb = this.openWorkspaceDb(store.getUserId(), turn.workspaceId);
      if (workspaceDb) {
        applyScopedMigrations(workspaceDb);
      }

      if (workspaceDb) {
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: this.now(),
          environmentPackage,
        });
      }

      backendCapabilities = await this.backend.describeCapabilities();
      const backendKind = toWorkspaceSynchronizationBackendKind(backendCapabilities.kind);
      const inputSnapshots = workspaceDb
        ? buildWorkspaceInputSnapshots({
            backendCapabilities: backendCapabilities.capabilities,
            backendKind,
            createdAt: this.now(),
            environmentPackage,
          })
        : [];
      backendLifecycle = {
        identity: this.backend.planSession(environmentPackage),
        physicalCleanedAt: null,
        session: null,
        workspaceHandoffState: 'pending',
      };
      if (this.coreDb && context.sandboxBindingRef) {
        backendLifecycle.session = recordWorkerBackendSessionMaterializing(this.coreDb, {
          backendVersion: backendCapabilities.version ?? null,
          identity: backendLifecycle.identity,
          lineage: {
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            workspaceId: environmentPackage.scope.workspaceId,
          },
          now: this.now,
          sandboxBindingRef: context.sandboxBindingRef,
          workerImage: environmentPackage.runtime.image.ref,
        });
      }
      backendCleanupRequired = true;
      const materialization = await this.backend.materialize(environmentPackage, {
        providerCredentials,
        runtimeEnvCredentials,
        runtimeFileCredentials,
        ...(context.sandboxBindingRef ? { sandboxBindingRef: context.sandboxBindingRef } : {}),
        workspaceRoots: context.workspaceRoots,
      });
      if (backendLifecycle.session) {
        backendLifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
          fromState: 'materializing',
          leaseId: backendLifecycle.session.leaseId,
          now: this.now,
          toState: 'materialized',
        });
      }

      const builtMaterializationRecords = workspaceDb
        ? buildWorkspaceMaterializationRecords({
            createdAt: this.now(),
            inputSnapshots,
            materialization: { ...materialization, backendKind },
          })
        : [];
      const handoff = workspaceDb
        ? recordWorkspaceBackendHandoff(workspaceDb, inputSnapshots, builtMaterializationRecords)
        : { inputSnapshots, materializationRecords: builtMaterializationRecords };
      const materializationRecords = handoff.materializationRecords;
      backendLifecycle.workspaceHandoffState = workspaceDb ? 'complete' : 'pending';
      if (backendLifecycle.session) {
        backendLifecycle.session = markWorkerBackendWorkspaceHandoffComplete(this.coreDb!, {
          leaseId: backendLifecycle.session.leaseId,
          now: this.now,
        });
        backendLifecycle.workspaceHandoffState = backendLifecycle.session.workspaceHandoffState;
      }

      const busySession = store.updateAgentSession(agentSession.id, {
        message: null,
        status: 'busy',
        updatedAt: this.now(),
      });
      this.emitAgentSession(store, environmentPackage, requestId, busySession);
      if (backendLifecycle.session) {
        backendLifecycle.session = markWorkerBackendSessionLaunching(this.coreDb!, {
          leaseId: backendLifecycle.session.leaseId,
          now: this.now,
        });
      }
      const completionLeaseId = this.awaitWorkerCompletion
        ? backendLifecycle.session?.leaseId
        : null;
      if (this.awaitWorkerCompletion && !completionLeaseId) {
        throw new Error('Detached worker completion requires a durable scheduler lease.');
      }
      await this.backend.launch(materialization);
      if (this.awaitWorkerCompletion && completionLeaseId) {
        workerFinalStatus = await this.awaitWorkerCompletion(environmentPackage, completionLeaseId);
        closeoutAt = workerFinalStatus.acceptedAt;
      }
      closeoutAt ??= this.now();
      await this.finishLaunchedTurn(
        store,
        environmentPackage,
        requestId,
        backendCapabilities,
        backendLifecycle,
        workspaceDb,
        inputSnapshots,
        materializationRecords,
        closeoutAt
      );
      backendCleanupRequired = false;
      if (workerFinalStatus && workerFinalStatus.status !== 'completed') {
        throw new Error(`Worker reported terminal status: ${workerFinalStatus.status}.`);
      }
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }

    const errors: unknown[] = primaryFailed ? [primaryError] : [];
    if (backendCleanupRequired) {
      if (!backendLifecycle || !environmentPackage || !backendCapabilities) {
        errors.push(new Error('Backend cleanup is missing its durable runtime lineage.'));
      } else {
        try {
          await this.cleanupBackendLifecycle(
            backendLifecycle,
            workspaceDb,
            environmentPackage,
            backendCapabilities
          );
          backendCleanupRequired = false;
        } catch (error) {
          errors.push(error);
        }
      }
    }
    try {
      workspaceDb?.sqlite.close();
    } catch (error) {
      errors.push(error);
    }

    let completedTerminalObserved = false;
    if (errors.length === 0) {
      if (!agentSessionId) {
        errors.push(new Error('The governed worker turn is missing its agent session id.'));
      } else {
        try {
          this.completeTurn(store, turn, agentSessionId, requestId);
        } catch (error) {
          errors.push(error);
          completedTerminalObserved = store
            .getTurnEvents(turn.id)
            .some(
              (event) =>
                event.event === 'turn.completed' &&
                event.data.type === 'turn-completed' &&
                event.data.stopReason === 'completed'
            );
          if (completedTerminalObserved) {
            try {
              store.updateTurn(turn.id, {});
            } catch (persistError) {
              errors.push(persistError);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      const error =
        errors.length === 1
          ? errors[0]
          : new AggregateError(
              errors,
              `Worker execution and backend cleanup failed${
                primaryError instanceof Error ? `: ${primaryError.message}` : '.'
              }`
            );
      if (!completedTerminalObserved) {
        try {
          this.failTurn(store, turn, agentSessionId, requestId, error);
        } catch (failureError) {
          throw new AggregateError(
            [error, failureError],
            'Worker execution failed and the failed turn could not be persisted.'
          );
        }
      }
      throw error;
    }
  }

  /**
   * Resumes the existing post-launch closeout path for one durable accepted final status.
   *
   * @param store Product store that owns the turn.
   * @param environmentPackage Immutable package restored from the workspace ledger.
   * @param session Exact durable backend session restored by the lifecycle runtime.
   * @returns Product terminal status established by closeout.
   */
  public async resumeAcceptedFinalStatus(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    session: WorkerBackendSessionRecord
  ): Promise<'completed' | 'failed'> {
    if (!this.coreDb || store.getUserId() !== environmentPackage.scope.userId) {
      throw new Error('Restart closeout requires the exact durable Core and store owner.');
    }
    assertRestoredSession(
      environmentPackage,
      session,
      this.backend.planSession(environmentPackage)
    );
    const turn = store.getTurnById(environmentPackage.scope.turnId);
    const accepted = getWorkerControlAcceptedFinalStatus(this.coreDb, {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
    if (!accepted) {
      throw new Error('Restart closeout requires the exact durable final status.');
    }
    const status = accepted.status;
    const recoveredStatus = status === 'completed' ? 'completed' : 'failed';
    const workspaceDb = this.openWorkspaceDb(
      store.getUserId(),
      environmentPackage.scope.workspaceId
    );
    if (!workspaceDb) {
      throw new Error('Restart closeout requires durable workspace storage.');
    }
    applyScopedMigrations(workspaceDb);
    const backendCapabilities = await this.backend.describeCapabilities();
    const lifecycle: WorkerTurnBackendLifecycle = {
      identity: this.backend.planSession(environmentPackage),
      physicalCleanedAt: session.physicalCleanedAt,
      session,
      workspaceHandoffState: session.workspaceHandoffState,
    };
    const collectDurableOutput =
      session.state !== 'physical-cleaned' && session.state !== 'cleaned';

    try {
      if (collectDurableOutput) {
        await this.finishLaunchedTurn(
          store,
          environmentPackage,
          environmentPackage.scope.requestId ?? null,
          backendCapabilities,
          lifecycle,
          workspaceDb,
          listWorkspaceInputSnapshots(workspaceDb, environmentPackage.scope.workspaceId),
          listWorkspaceMaterializationRecords(workspaceDb, environmentPackage.scope.workspaceId),
          accepted.acceptedAt
        );
      } else if (session.state !== 'cleaned') {
        await this.cleanupBackendLifecycle(
          lifecycle,
          workspaceDb,
          environmentPackage,
          backendCapabilities
        );
      }

      if (turn.status === recoveredStatus) {
        return recoveredStatus;
      }

      if (status === 'completed') {
        this.completeTurn(
          store,
          turn,
          environmentPackage.scope.agentSessionId,
          environmentPackage.scope.requestId ?? null
        );
      } else {
        this.failTurn(
          store,
          turn,
          environmentPackage.scope.agentSessionId,
          environmentPackage.scope.requestId ?? null,
          new Error(`Worker reported terminal status: ${status}.`)
        );
      }
      return recoveredStatus;
    } finally {
      workspaceDb.sqlite.close();
    }
  }

  /**
   * Interrupt is unsupported for the initial one-shot backend executor.
   *
   * @param _store Store that owns the turn.
   * @param _turnId Turn id to interrupt.
   * @param _context Runtime command context.
   * @returns Promise that always rejects because the backend cannot interrupt turns.
   * @throws Error Always, because interrupting a governed worker is unsupported.
   */
  public async interruptTurn(
    _store: FsStore,
    _turnId: string,
    _context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    throw new Error('The worker governance executor does not support turn interruption.');
  }

  /**
   * Returns the latest persisted agent session for one thread.
   *
   * @param store Store that owns the thread.
   * @param workspaceId Workspace id.
   * @param threadId Thread id.
   * @returns Agent session read model, or null.
   */
  public getAgentSession(
    store: FsStore,
    workspaceId: string,
    threadId: string
  ): AgentSessionReadModel | null {
    const session = store
      .listThreadAgentSessions(workspaceId, threadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    if (!session) {
      return null;
    }

    return {
      backend: null,
      configVersion: session.configVersion,
      id: session.id,
      message: session.message,
      sandboxSummary: session.sandboxSummary ?? null,
      stale: session.stale,
      status: session.status,
      workspaceRoots: session.workspaceRoots,
    };
  }

  /** Runs the single transcript, workspace, artifact, and backend closeout path. */
  private async finishLaunchedTurn(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    backendCapabilities: WorkerGovernanceBackendCapabilities,
    backendLifecycle: WorkerTurnBackendLifecycle,
    workspaceDb: WorkspaceDb | null,
    inputSnapshots: readonly WorkspaceInputSnapshot[],
    materializationRecords: readonly WorkspaceMaterializationRecord[],
    recordedAt: string
  ): Promise<void> {
    await this.backend.collectEvidence(environmentPackage.snapshotId);
    const transcript = await this.backend.collectTranscript(environmentPackage.snapshotId);
    if (environmentPackage.control.transcript?.runtimeProvenance) {
      if (!workspaceDb) {
        throw new Error('Runtime provenance collection requires durable workspace storage.');
      }
      const collection = transcript.runtimeProvenance;
      const firstRawStreamPath = Object.values(collection?.rawStreamPaths ?? {})[0];
      const rawStreamsRoot = firstRawStreamPath
        ? dirname(firstRawStreamPath)
        : collection?.manifestPath
          ? join(dirname(collection.manifestPath), 'raw')
          : collection?.nativeOriginIndexPath
            ? join(dirname(collection.nativeOriginIndexPath), 'raw')
            : '';
      const provenance = await this.runtimeProvenanceImporter({
        backend: {
          kind: backendCapabilities.kind,
          placement: this.environmentBackend.placement ?? 'local',
          version: backendCapabilities.version ?? null,
        },
        capture: {
          nativeOriginIndexPath: collection?.nativeOriginIndexPath ?? null,
          rawStreamsRoot,
          streamManifestPath: collection?.manifestPath ?? null,
        },
        collectedAt: this.now(),
        environmentPackage,
        workspaceDb,
        workspaceRoot: join(
          workspaceDb.dataRoot,
          'users',
          workspaceDb.userId,
          'workspaces',
          workspaceDb.workspaceId
        ),
      });
      if (!provenance.complete) {
        throw new Error('Required worker runtime provenance verification failed.');
      }
    }
    const acceptedLiveEvents = this.coreDb
      ? listWorkerControlAcceptedEvents(this.coreDb, {
          agentSessionId: environmentPackage.scope.agentSessionId,
          packageSnapshotId: environmentPackage.snapshotId,
          requestId: environmentPackage.scope.requestId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
          workspaceId: environmentPackage.scope.workspaceId,
        })
      : [];
    const importResult = importWorkerTranscript(store, environmentPackage, transcript, {
      acceptedLiveEvents,
      recordedAt,
    });
    if (
      importResult.rejectedEventSequences.length > 0 ||
      importResult.diagnostics.some((diagnostic) => diagnostic.path.startsWith('$.events'))
    ) {
      throw new Error('Worker transcript event reconciliation failed.');
    }
    await this.createWorkspaceChangeArtifacts(
      store,
      environmentPackage,
      await this.backend.collectWorkspaceChanges(environmentPackage.snapshotId),
      workspaceDb,
      inputSnapshots,
      materializationRecords,
      recordedAt
    );
    await this.backend.collectArtifacts(environmentPackage.snapshotId);
    await this.cleanupBackendLifecycle(
      backendLifecycle,
      workspaceDb,
      environmentPackage,
      backendCapabilities
    );
    this.emitImportedRecords(store, environmentPackage, requestId, importResult);
  }

  /**
   * Physically cleans one exact backend identity and atomically projects only proven success.
   *
   * @param lifecycle Exact physical identity and optional durable Core state.
   * @param workspaceDb Optional product workspace projection target.
   * @param environmentPackage Immutable package that owns the session.
   * @param backendCapabilities Backend identity captured before materialization.
   * @returns Promise settled after physical cleanup and durable projection.
   * @throws Error when physical cleanup, lifecycle transition, or workspace projection fails.
   */
  private async cleanupBackendLifecycle(
    lifecycle: WorkerTurnBackendLifecycle,
    workspaceDb: WorkspaceDb | null,
    environmentPackage: AgentEnvironmentPackage,
    backendCapabilities: WorkerGovernanceBackendCapabilities
  ): Promise<void> {
    if (lifecycle.session?.state === 'cleaned') {
      return;
    }

    if (!lifecycle.physicalCleanedAt) {
      if (lifecycle.session) {
        const session = lifecycle.session;
        if (session.state !== 'cleanup-pending') {
          lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
            fromState: session.state,
            leaseId: session.leaseId,
            now: this.now,
            toState: 'cleanup-pending',
          });
        }
      }

      try {
        await this.backend.cleanupSession(lifecycle.identity);
      } catch (error) {
        if (lifecycle.session?.state === 'cleanup-pending') {
          lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
            fromState: 'cleanup-pending',
            leaseId: lifecycle.session.leaseId,
            now: this.now,
            toState: 'cleanup-failed',
          });
        }
        throw error;
      }

      lifecycle.physicalCleanedAt = this.now();
      if (lifecycle.session?.state === 'cleanup-pending') {
        lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
          fromState: 'cleanup-pending',
          leaseId: lifecycle.session.leaseId,
          now: () => lifecycle.physicalCleanedAt!,
          toState: 'physical-cleaned',
        });
        lifecycle.physicalCleanedAt = lifecycle.session.physicalCleanedAt;
      }
    }

    if (workspaceDb) {
      const projection = projectWorkerBackendCleanup(workspaceDb, {
        agentSessionId: environmentPackage.scope.agentSessionId,
        backendSessionId: lifecycle.identity.backendSessionId,
        backendType: backendCapabilities.kind,
        backendVersion: backendCapabilities.version ?? null,
        completedAt: lifecycle.physicalCleanedAt!,
        environmentPackage,
        outcome: 'succeeded',
        packageSnapshotId: environmentPackage.snapshotId,
        placement: lifecycle.identity.backendTarget.placement,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workerImage: environmentPackage.runtime.image.ref,
        workspaceHandoffState: lifecycle.workspaceHandoffState,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      if (
        lifecycle.session?.workspaceHandoffState === 'pending' &&
        projection.workspaceHandoffComplete
      ) {
        lifecycle.session = markWorkerBackendWorkspaceHandoffComplete(this.coreDb!, {
          leaseId: lifecycle.session.leaseId,
          now: this.now,
        });
      }
    }

    if (lifecycle.session?.state === 'physical-cleaned' && workspaceDb) {
      lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
        fromState: 'physical-cleaned',
        leaseId: lifecycle.session.leaseId,
        now: this.now,
        toState: 'cleaned',
      });
    }
  }

  /**
   * Emits the start event for one governed turn.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   */
  private emitTurnStarted(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null
  ): void {
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { status: 'running', turnId: environmentPackage.scope.turnId, type: 'turn-started' },
      event: 'turn.started',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }

  /**
   * Creates reviewable artifacts for worker-produced workspace change sets.
   *
   * @param store Store that owns the workspace.
   * @param environmentPackage Package lineage for the worker turn.
   * @param records Workspace change records returned by the backend.
   * @param workspaceDb Optional durable workspace database.
   * @param inputSnapshots Trusted input snapshots for the current worker package.
   * @param materializationRecords Trusted materializations for the current worker package.
   * @param recordedAt Stable durable final-status timestamp used by exact replay.
   */
  private async createWorkspaceChangeArtifacts(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    records: readonly WorkerGovernanceWorkspaceChangeRecord[],
    workspaceDb: WorkspaceDb | null,
    inputSnapshots: readonly WorkspaceInputSnapshot[],
    materializationRecords: readonly WorkspaceMaterializationRecord[],
    recordedAt: string
  ): Promise<void> {
    for (const record of records) {
      const workerTurnRefs = record.changeSet.evidenceRefs
        .filter((reference) => reference.kind === 'worker')
        .map((reference) => reference.ref);
      const inputSnapshot = inputSnapshots.find(
        (snapshot) => snapshot.id === record.changeSet.inputSnapshotId
      );
      const materializationRecord = materializationRecords.find(
        (materialization) => materialization.id === record.changeSet.materializationRecordId
      );
      if (
        record.changeSet.workspaceId !== environmentPackage.scope.workspaceId ||
        record.review.workspaceId !== environmentPackage.scope.workspaceId ||
        record.review.changeSetId !== record.changeSet.id ||
        workerTurnRefs.length !== 1 ||
        workerTurnRefs[0] !== environmentPackage.scope.turnId ||
        (workspaceDb &&
          (!inputSnapshot ||
            inputSnapshot.resourceId !== record.changeSet.resourceId ||
            !materializationRecord ||
            materializationRecord.inputSnapshotId !== inputSnapshot.id ||
            materializationRecord.workspaceId !== environmentPackage.scope.workspaceId))
      ) {
        throw new Error(`Workspace review lineage mismatch: ${record.review.id}`);
      }

      const timestamp = recordedAt;
      const artifactId = `ar_workspace_changes_${environmentPackage.scope.turnId}_${record.review.id}`;
      const repository = workspaceDb
        ? getWorkspaceRepositoryResource(
            workspaceDb,
            environmentPackage.scope.workspaceId,
            record.changeSet.resourceId
          )
        : null;
      const patchDigest = record.patchPayload
        ? `sha256:${createHash('sha256').update(record.patchPayload.text).digest('hex')}`
        : null;
      const gitPatchIsValid =
        record.changeSet.strategy !== 'git' ||
        Boolean(
          record.changeSet.patch &&
            record.patchPayload &&
            record.changeSet.patch.digest === record.patchPayload.digest &&
            record.changeSet.patch.bytes === record.patchPayload.bytes &&
            patchDigest === record.patchPayload.digest &&
            Buffer.byteLength(record.patchPayload.text, 'utf8') === record.patchPayload.bytes
        );
      const filesystemApplyIsValid =
        record.changeSet.strategy !== 'filesystem' ||
        Boolean(
          record.filesystemApply &&
            record.filesystemApply.before.workspaceId === record.changeSet.workspaceId &&
            record.filesystemApply.before.resourceId === record.changeSet.resourceId &&
            record.filesystemApply.before.contentDigest === record.changeSet.base.contentDigest
        );
      const actionabilityFailures = [
        record.review.status !== 'pending' ? 'review_not_pending' : null,
        record.changeSet.strategy === 'git' && record.review.staging.strategy !== 'git_worktree'
          ? 'git_staging_invalid'
          : null,
        record.changeSet.strategy === 'git' && workspaceDb && !repository
          ? 'git_repository_missing'
          : null,
        record.changeSet.strategy === 'git' && record.filesystemApply !== null
          ? 'git_filesystem_apply_present'
          : null,
        record.changeSet.strategy === 'filesystem' &&
        record.review.staging.strategy !== 'filesystem_staging'
          ? 'filesystem_staging_invalid'
          : null,
        record.changeSet.strategy === 'filesystem' && record.review.staging.branch !== null
          ? 'filesystem_branch_present'
          : null,
        record.changeSet.strategy === 'filesystem' && record.patchPayload !== null
          ? 'filesystem_patch_payload_present'
          : null,
        record.changeSet.strategy === 'filesystem' && record.changeSet.patch !== null
          ? 'filesystem_patch_reference_present'
          : null,
        workspaceDb && inputSnapshot?.strategy !== record.changeSet.strategy
          ? 'input_strategy_mismatch'
          : null,
        workspaceDb && materializationRecord?.strategy !== record.changeSet.strategy
          ? 'materialization_strategy_mismatch'
          : null,
        workspaceDb && !isDeepStrictEqual(inputSnapshot?.base, record.changeSet.base)
          ? 'input_base_mismatch'
          : null,
        workspaceDb && !isDeepStrictEqual(materializationRecord?.base, record.changeSet.base)
          ? 'materialization_base_mismatch'
          : null,
        !gitPatchIsValid ? 'git_patch_invalid' : null,
        !filesystemApplyIsValid ? 'filesystem_apply_invalid' : null,
      ].filter((reason): reason is string => reason !== null);
      if (actionabilityFailures.length > 0) {
        throw new Error(
          `Workspace review is not actionable (${actionabilityFailures.join(', ')}): ${record.review.id}`
        );
      }
      const item = {
        artifactId,
        changeSet: record.changeSet,
        patchPayload: record.patchPayload,
        review:
          record.changeSet.strategy === 'git' && repository?.git.stagingStrategy !== 'review-branch'
            ? {
                ...record.review,
                staging: { ...record.review.staging, branch: null },
              }
            : record.review,
      };
      /** Persists one staged record to artifact and durable workspace storage. */
      const persistRecord = (stagedItem: typeof item): void => {
        let artifactWriteAttempted = false;
        const persist = (): void => {
          if (record.filesystemApply && workspaceDb) {
            recordFilesystemWorkspaceStagingRoot(workspaceDb, {
              before: record.filesystemApply.before,
              changeSetId: stagedItem.changeSet.id,
              createdAt: timestamp,
              reviewId: stagedItem.review.id,
              stagingRootPath: record.filesystemApply.stagingRootPath,
              targetRootPath: record.filesystemApply.targetRootPath,
              workspaceId: stagedItem.review.workspaceId,
            });
          }
          if (workspaceDb) {
            recordWorkspaceSyncReview(workspaceDb, { item: stagedItem });
          }

          const artifact = {
            id: artifactId,
            workspaceId: environmentPackage.scope.workspaceId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            kind: 'diff',
            title: 'Workspace changes ready for review',
            status: 'ready',
            summary: stagedItem.review.riskSummary,
            version: 1,
            content: {
              format: 'json',
              body: JSON.stringify(
                {
                  changeSet: stagedItem.changeSet,
                  patchPayload: stagedItem.patchPayload,
                  review: stagedItem.review,
                },
                null,
                2
              ),
            },
            createdAt: timestamp,
            updatedAt: timestamp,
          } as const;
          const existingArtifact = store
            .listArtifacts(environmentPackage.scope.workspaceId)
            .find((candidate) => candidate.id === artifactId);
          if (existingArtifact) {
            if (!isDeepStrictEqual(existingArtifact, artifact)) {
              throw new Error(`Workspace review artifact replay conflict: ${artifactId}`);
            }
          } else {
            artifactWriteAttempted = true;
            store.createArtifact(artifact);
          }
        };

        try {
          if (workspaceDb) {
            workspaceDb.sqlite.transaction(persist)();
          } else {
            persist();
          }
        } catch (error) {
          if (!artifactWriteAttempted) {
            throw error;
          }
          try {
            store.deleteArtifact(environmentPackage.scope.workspaceId, artifactId);
          } catch (compensationError) {
            throw new AggregateError(
              [error, compensationError],
              `Workspace review persistence and artifact compensation failed: ${record.review.id}`
            );
          }
          throw error;
        }
      };
      if (
        repository?.git.stagingStrategy === 'review-branch' &&
        record.changeSet.strategy === 'git'
      ) {
        await stageGitWorkspaceReview({
          persistHead: (commitId) => {
            persistRecord({
              ...item,
              changeSet: {
                ...item.changeSet,
                head: { ...item.changeSet.head, commit: commitId },
              },
            });
          },
          repository,
          review: item,
          store,
        });
      } else {
        persistRecord(item);
      }
    }
  }

  /**
   * Opens the workspace-scoped database used by workspace synchronization records.
   *
   * @param userId Store owner that owns the workspace database.
   * @param workspaceId Workspace id that owns the records.
   * @returns Workspace database handle, or null when durable storage is disabled.
   */
  private openWorkspaceDb(userId: string, workspaceId: string): WorkspaceDb | null {
    if (!this.coreDb) {
      return null;
    }

    return openWorkspaceDb(this.coreDb.dataRoot, userId, workspaceId);
  }

  /**
   * Emits created and completed events for one item.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param item Item to emit.
   */
  private emitItemCreatedAndCompleted(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    item: ReturnType<FsStore['createItem']>
  ): void {
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { item, type: 'item-created' },
      event: 'item.created',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { item, itemId: item.id, type: 'item-completed' },
      event: 'item.completed',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }

  /**
   * Emits an agent-session update event.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param agentSession Agent session record.
   */
  private emitAgentSession(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    agentSession: ReturnType<FsStore['createAgentSession']>
  ): void {
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { agentSession, type: 'agent-session-updated' },
      event: 'agent.session.updated',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }

  /**
   * Emits events for records imported from worker transcript files.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param importResult Imported canonical record ids.
   */
  private emitImportedRecords(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    importResult: { itemIds: string[]; artifactIds: string[] }
  ): void {
    const threadItems = store.listThreadItems(
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.threadId
    );

    for (const itemId of importResult.itemIds) {
      const item = threadItems.find((candidate) => candidate.id === itemId);

      if (item) {
        this.emitItemCreatedAndCompleted(store, environmentPackage, requestId, item);
      }
    }

    for (const artifactId of importResult.artifactIds) {
      const artifact = store.getArtifact(environmentPackage.scope.workspaceId, artifactId);
      store.emitTurnEvent(environmentPackage.scope.turnId, {
        data: { artifact, type: 'artifact-created' },
        event: 'artifact.created',
        requestId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workspaceId: environmentPackage.scope.workspaceId,
      });
    }
  }

  /**
   * Completes one turn after successful transcript import.
   *
   * @param store Store that owns the turn.
   * @param turnScope Turn whose ids scope the terminal records.
   * @param agentSessionId Agent session completed by the turn.
   * @param requestId Request id.
   */
  private completeTurn(
    store: FsStore,
    turnScope: ReturnType<FsStore['getTurnById']>,
    agentSessionId: string,
    requestId: string | null
  ): void {
    const completedAt = this.now();
    const agentSession = store.updateAgentSession(agentSessionId, {
      message: null,
      status: 'idle',
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(turnScope.id, {
      completedAt,
      error: null,
      status: 'completed',
    });

    store.emitTurnEvent(turnScope.id, {
      data: { agentSession, type: 'agent-session-updated' },
      event: 'agent.session.updated',
      requestId,
      threadId: turnScope.threadId,
      turnId: turnScope.id,
      workspaceId: turnScope.workspaceId,
    });
    store.emitTurnEvent(turnScope.id, {
      data: { stopReason: 'completed', turn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId,
      threadId: turnScope.threadId,
      turnId: turnScope.id,
      workspaceId: turnScope.workspaceId,
    });
  }

  /**
   * Marks one governed turn as failed.
   *
   * @param store Store that owns the turn.
   * @param turnScope Turn whose ids scope the terminal records.
   * @param agentSessionId Optional agent session created before the failure.
   * @param requestId Request id.
   * @param error Failure reason.
   * @throws AggregateError when one or more terminal writes report a partial failure.
   */
  private failTurn(
    store: FsStore,
    turnScope: ReturnType<FsStore['getTurnById']>,
    agentSessionId: string | null,
    requestId: string | null,
    error: unknown
  ): void {
    const message = error instanceof Error ? error.message : 'The governed worker turn failed.';
    terminalizeGovernedWorkerTurnFailure({
      agentSessionId,
      completedAt: this.now(),
      errorCode: 'worker_governance_turn_failed',
      message,
      requestId,
      store,
      turnId: turnScope.id,
    });
  }
}

/** Verifies that the restored package, Core session, and backend plan have one authority lineage. */
function assertRestoredSession(
  environmentPackage: AgentEnvironmentPackage,
  session: WorkerBackendSessionRecord,
  identity: WorkerGovernanceBackendSessionIdentity
): void {
  const scope = environmentPackage.scope;
  if (
    session.workspaceId !== scope.workspaceId ||
    session.threadId !== scope.threadId ||
    session.turnId !== scope.turnId ||
    session.agentSessionId !== scope.agentSessionId ||
    session.packageSnapshotId !== environmentPackage.snapshotId ||
    session.backendKind !== identity.backendKind ||
    session.backendSessionId !== identity.backendSessionId ||
    session.deploymentId !== identity.deploymentId ||
    session.stagingDirectoryRef !== identity.stagingDirectoryRef ||
    session.transientProviderInstanceId !== identity.transientProviderInstanceId ||
    !isDeepStrictEqual(session.backendTarget, identity.backendTarget)
  ) {
    throw new Error('Restart closeout backend session does not match its immutable lineage.');
  }
}

/**
 * Converts backend capability kinds into the public workspace synchronization vocabulary.
 *
 * @param kind Backend capability kind.
 * @returns Workspace synchronization backend kind.
 */
function toWorkspaceSynchronizationBackendKind(kind: string): WorkspaceSynchronizationBackendKind {
  if (
    kind === 'host' ||
    kind === 'openshell' ||
    kind === 'docker' ||
    kind === 'managed-sandbox' ||
    kind === 'remote-vm'
  ) {
    return kind;
  }

  if (kind === 'vm') {
    return 'remote-vm';
  }

  return 'managed-sandbox';
}

/**
 * Maps NanoCore's selected workspace cwd to the matching worker-visible path.
 *
 * @param context Turn startup context captured by NanoCore.
 * @param backend Backend selected for the Agent Environment Package.
 * @returns Worker-visible cwd when a backend path mapping exists, otherwise the original cwd.
 */
function workerVisibleWorkspaceCwd(
  context: TurnStartRuntimeContext,
  backend: ResolveAgentEnvironmentBackendInput
): string | null {
  const workspaceCwd = context.workspaceCwd ?? null;

  if (backend.kind !== 'openshell' || !workspaceCwd) {
    return workspaceCwd;
  }

  return (
    context.workspaceRoots.find((root) => root.sourcePath === workspaceCwd)?.workerPath ??
    workspaceCwd
  );
}
