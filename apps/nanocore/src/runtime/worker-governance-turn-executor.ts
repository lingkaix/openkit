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
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';
import { importWorkerTranscript } from './worker-transcript.js';
import { recordFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import { stageGitWorkspaceReview } from './workspace-review-git.js';
import {
  getWorkspaceSyncReview,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  recordWorkspaceSyncReview,
  updateBackendWorkspaceHandleCleanupStatus,
} from './workspace-sync-records.js';

/**
 * Options for the worker-governance-backed turn executor.
 */
export interface WorkerGovernanceTurnExecutorOptions {
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
    let backendActive = false;
    let backendSnapshotId: string | null = null;
    let primaryFailed = false;
    let primaryError: unknown;

    try {
      const agent = store.getAgentForThread(turn.workspaceId, turn.threadId);
      const resolvedAgentSessionId = agentSessionId ?? this.createAgentSessionId();
      agentSessionId = resolvedAgentSessionId;
      const providerCredentials: ResolvedAgentEnvironmentProviderCredential[] = [];
      const runtimeEnvCredentials: ResolvedAgentEnvironmentRuntimeEnvCredential[] = [];
      const runtimeFileCredentials: ResolvedAgentEnvironmentRuntimeFileCredential[] = [];
      const environmentPackage = resolveAgentEnvironmentPackage({
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

      const backendCapabilities = await this.backend.describeCapabilities();
      const backendKind = toWorkspaceSynchronizationBackendKind(backendCapabilities.kind);
      const inputSnapshots = workspaceDb
        ? recordWorkspaceInputSnapshots(
            workspaceDb,
            buildWorkspaceInputSnapshots({
              backendCapabilities: backendCapabilities.capabilities,
              backendKind,
              createdAt: this.now(),
              environmentPackage,
            })
          )
        : [];
      const materialization = await this.backend.materialize(environmentPackage, {
        providerCredentials,
        runtimeEnvCredentials,
        runtimeFileCredentials,
        ...(context.sandboxBindingRef ? { sandboxBindingRef: context.sandboxBindingRef } : {}),
        workspaceRoots: context.workspaceRoots,
      });
      backendSnapshotId = environmentPackage.snapshotId;
      backendActive = true;

      const materializationRecords =
        workspaceDb && inputSnapshots.length > 0
          ? recordWorkspaceMaterializationRecords(
              workspaceDb,
              buildWorkspaceMaterializationRecords({
                createdAt: this.now(),
                inputSnapshots,
                materialization: { ...materialization, backendKind },
              })
            )
          : [];

      const busySession = store.updateAgentSession(agentSession.id, {
        message: null,
        status: 'busy',
        updatedAt: this.now(),
      });
      this.emitAgentSession(store, environmentPackage, requestId, busySession);
      await this.backend.launch(materialization);
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
      const importResult = importWorkerTranscript(store, environmentPackage, transcript);
      const workspaceChanges = await this.backend.collectWorkspaceChanges(
        environmentPackage.snapshotId
      );

      await this.createWorkspaceChangeArtifacts(
        store,
        environmentPackage,
        workspaceChanges,
        workspaceDb,
        inputSnapshots,
        materializationRecords
      );
      await this.backend.collectArtifacts(environmentPackage.snapshotId);
      try {
        await this.backend.teardown(environmentPackage.snapshotId);
      } catch (error) {
        try {
          this.markBackendWorkspaceHandlesCleanupStatus(
            workspaceDb,
            turn.workspaceId,
            environmentPackage.snapshotId,
            'failed'
          );
        } catch (statusError) {
          throw new AggregateError(
            [error, statusError],
            'Backend teardown and cleanup status persistence failed.'
          );
        }
        throw error;
      }
      backendActive = false;
      this.markBackendWorkspaceHandlesCleanupStatus(
        workspaceDb,
        turn.workspaceId,
        environmentPackage.snapshotId,
        'cleaned'
      );
      this.emitImportedRecords(store, environmentPackage, requestId, importResult);
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }

    const errors: unknown[] = primaryFailed ? [primaryError] : [];
    if (backendActive) {
      let cleanupStatus: 'cleaned' | 'failed' = 'failed';
      if (!backendSnapshotId) {
        errors.push(new Error('The active governed worker is missing its backend snapshot id.'));
      } else {
        try {
          await this.backend.teardown(backendSnapshotId);
          backendActive = false;
          cleanupStatus = 'cleaned';
        } catch (error) {
          errors.push(error);
        }
        try {
          this.markBackendWorkspaceHandlesCleanupStatus(
            workspaceDb,
            turn.workspaceId,
            backendSnapshotId,
            cleanupStatus
          );
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

  /**
   * Updates persisted backend workspace handles after teardown.
   *
   * @param workspaceDb Optional workspace database handle.
   * @param workspaceId Workspace id.
   * @param workerSessionId Worker session id stored on backend handles.
   * @param cleanupStatus Cleanup outcome.
   */
  private markBackendWorkspaceHandlesCleanupStatus(
    workspaceDb: WorkspaceDb | null,
    workspaceId: string,
    workerSessionId: string,
    cleanupStatus: 'cleaned' | 'failed'
  ): void {
    if (!workspaceDb) {
      return;
    }

    updateBackendWorkspaceHandleCleanupStatus(
      workspaceDb,
      workspaceId,
      workerSessionId,
      cleanupStatus,
      this.now()
    );
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
   */
  private async createWorkspaceChangeArtifacts(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    records: readonly WorkerGovernanceWorkspaceChangeRecord[],
    workspaceDb: WorkspaceDb | null,
    inputSnapshots: readonly WorkspaceInputSnapshot[],
    materializationRecords: readonly WorkspaceMaterializationRecord[]
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

      const timestamp = this.now();
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
      if (
        record.review.status !== 'pending' ||
        (record.changeSet.strategy === 'git' &&
          (record.review.staging.strategy !== 'git_worktree' ||
            (workspaceDb && !repository) ||
            record.filesystemApply !== null)) ||
        (record.changeSet.strategy === 'filesystem' &&
          (record.review.staging.strategy !== 'filesystem_staging' ||
            record.review.staging.branch !== null ||
            record.patchPayload !== null ||
            record.changeSet.patch !== null)) ||
        (workspaceDb &&
          (inputSnapshot?.strategy !== record.changeSet.strategy ||
            materializationRecord?.strategy !== record.changeSet.strategy ||
            JSON.stringify(inputSnapshot?.base) !== JSON.stringify(record.changeSet.base) ||
            JSON.stringify(materializationRecord?.base) !==
              JSON.stringify(record.changeSet.base))) ||
        !gitPatchIsValid ||
        !filesystemApplyIsValid
      ) {
        throw new Error(`Workspace review is not actionable: ${record.review.id}`);
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
      if (
        workspaceDb &&
        getWorkspaceSyncReview(workspaceDb, environmentPackage.scope.workspaceId, record.review.id)
      ) {
        throw new Error(`Workspace review already exists: ${record.review.id}`);
      }

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
    if (
      store
        .getTurnEvents(turnScope.id)
        .some(
          (event) =>
            event.event === 'turn.completed' &&
            event.data.type === 'turn-completed' &&
            event.data.stopReason === 'completed'
        )
    ) {
      return;
    }

    const completedAt = this.now();
    const message = error instanceof Error ? error.message : 'The governed worker turn failed.';
    const stepErrors: unknown[] = [];
    const sessionPatch = {
      message,
      status: 'failed',
      updatedAt: completedAt,
    } as const;
    const turnPatch = {
      completedAt,
      error: {
        code: 'worker_governance_turn_failed',
        message,
      },
      status: 'failed',
    } as const;
    let agentSession: ReturnType<FsStore['createAgentSession']> | null = null;

    if (agentSessionId) {
      try {
        agentSession = store.getAgentSession(agentSessionId);
      } catch {
        agentSession = null;
      }
      if (
        agentSession &&
        (agentSession.status !== sessionPatch.status ||
          agentSession.message !== sessionPatch.message)
      ) {
        try {
          agentSession = store.updateAgentSession(agentSessionId, sessionPatch);
        } catch (sessionError) {
          stepErrors.push(sessionError);
          try {
            agentSession = store.getAgentSession(agentSessionId);
          } catch {
            agentSession = null;
          }
          if (
            !agentSession ||
            agentSession.status !== sessionPatch.status ||
            agentSession.message !== sessionPatch.message
          ) {
            try {
              agentSession = store.updateAgentSession(agentSessionId, sessionPatch);
            } catch (retryError) {
              stepErrors.push(retryError);
              try {
                agentSession = store.getAgentSession(agentSessionId);
              } catch {
                agentSession = null;
              }
            }
          }
        }
      }
    }

    let failedTurn = store.getTurnById(turnScope.id);
    if (
      failedTurn.status !== turnPatch.status ||
      failedTurn.error?.code !== turnPatch.error.code ||
      failedTurn.error.message !== turnPatch.error.message
    ) {
      try {
        failedTurn = store.updateTurn(turnScope.id, turnPatch);
      } catch (turnError) {
        stepErrors.push(turnError);
        failedTurn = store.getTurnById(turnScope.id);
        if (
          failedTurn.status !== turnPatch.status ||
          failedTurn.error?.code !== turnPatch.error.code ||
          failedTurn.error.message !== turnPatch.error.message
        ) {
          try {
            failedTurn = store.updateTurn(turnScope.id, turnPatch);
          } catch (retryError) {
            stepErrors.push(retryError);
            failedTurn = store.getTurnById(turnScope.id);
          }
        }
      }
    }

    let sessionEventObserved = Boolean(
      agentSession &&
        store
          .getTurnEvents(turnScope.id)
          .some(
            (event) =>
              event.event === 'agent.session.updated' &&
              event.data.type === 'agent-session-updated' &&
              event.data.agentSession.id === agentSessionId &&
              event.data.agentSession.status === 'failed'
          )
    );
    if (agentSession?.status === 'failed' && !sessionEventObserved) {
      const sessionEvent = {
        data: { agentSession, type: 'agent-session-updated' },
        event: 'agent.session.updated',
        requestId,
        threadId: turnScope.threadId,
        turnId: turnScope.id,
        workspaceId: turnScope.workspaceId,
      } as const;
      try {
        store.emitTurnEvent(turnScope.id, sessionEvent);
        sessionEventObserved = true;
      } catch (sessionEventError) {
        stepErrors.push(sessionEventError);
        sessionEventObserved = store
          .getTurnEvents(turnScope.id)
          .some(
            (event) =>
              event.event === 'agent.session.updated' &&
              event.data.type === 'agent-session-updated' &&
              event.data.agentSession.id === agentSessionId &&
              event.data.agentSession.status === 'failed'
          );
        if (!sessionEventObserved) {
          try {
            store.emitTurnEvent(turnScope.id, sessionEvent);
            sessionEventObserved = true;
          } catch (retryError) {
            stepErrors.push(retryError);
            sessionEventObserved = store
              .getTurnEvents(turnScope.id)
              .some(
                (event) =>
                  event.event === 'agent.session.updated' &&
                  event.data.type === 'agent-session-updated' &&
                  event.data.agentSession.id === agentSessionId &&
                  event.data.agentSession.status === 'failed'
              );
          }
        }
        if (sessionEventObserved) {
          try {
            store.updateTurn(turnScope.id, {});
          } catch (persistError) {
            stepErrors.push(persistError);
          }
        }
      }
    }

    let terminalEventObserved = store
      .getTurnEvents(turnScope.id)
      .some((event) => event.event === 'turn.completed' && event.data.type === 'turn-completed');
    if (failedTurn.status === 'failed' && !terminalEventObserved) {
      const terminalEvent = {
        data: { stopReason: 'error', turn: failedTurn, type: 'turn-completed' },
        event: 'turn.completed',
        requestId,
        threadId: turnScope.threadId,
        turnId: turnScope.id,
        workspaceId: turnScope.workspaceId,
      } as const;
      try {
        store.emitTurnEvent(turnScope.id, terminalEvent);
        terminalEventObserved = true;
      } catch (terminalEventError) {
        stepErrors.push(terminalEventError);
        terminalEventObserved = store
          .getTurnEvents(turnScope.id)
          .some(
            (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
          );
        if (!terminalEventObserved) {
          try {
            store.emitTurnEvent(turnScope.id, terminalEvent);
            terminalEventObserved = true;
          } catch (retryError) {
            stepErrors.push(retryError);
            terminalEventObserved = store
              .getTurnEvents(turnScope.id)
              .some(
                (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
              );
          }
        }
        if (terminalEventObserved) {
          try {
            store.updateTurn(turnScope.id, {});
          } catch (persistError) {
            stepErrors.push(persistError);
          }
        }
      }
    }

    if (stepErrors.length > 0) {
      throw new AggregateError(
        stepErrors,
        'Failed turn terminalization encountered partial persistence errors.'
      );
    }
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
