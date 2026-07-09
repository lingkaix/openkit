import type { WorkspaceSynchronizationBackendKind } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { redactAgentEnvironmentPackageSnapshot } from '@openkit/config-schema';
import type { FsStore } from '../lib/store.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import type { VaultBackend } from '../vault-backend.js';
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
import { importWorkerTranscript } from './worker-transcript.js';
import { recordFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
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
    const agent = store.getAgentForThread(turn.workspaceId, turn.threadId);
    const agentSessionId = context.agentSessionId ?? this.createAgentSessionId();
    const providerCredentials: ResolvedAgentEnvironmentProviderCredential[] = [];
    const runtimeEnvCredentials: ResolvedAgentEnvironmentRuntimeEnvCredential[] = [];
    const runtimeFileCredentials: ResolvedAgentEnvironmentRuntimeFileCredential[] = [];
    const environmentPackage = resolveAgentEnvironmentPackage({
      agent,
      agentSessionId,
      backend: this.environmentBackend,
      ...(context.backendRequirements ? { backendRequirements: context.backendRequirements } : {}),
      ...(this.coreDb ? { coreDb: this.coreDb } : {}),
      providerCredentialSink: (credential) => providerCredentials.push(credential),
      requestId: context.requestId ?? null,
      runtimeEnvCredentialSink: (credential) => runtimeEnvCredentials.push(credential),
      runtimeFileCredentialSink: (credential) => runtimeFileCredentials.push(credential),
      ...(context.sandboxAccess ? { sandboxAccess: context.sandboxAccess } : {}),
      turn,
      turnInput: input,
      ...(this.vaultBackend ? { vaultBackend: this.vaultBackend } : {}),
      ...(context.workspaceDataSourceCatalog
        ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
        : {}),
      workspaceCwd: workerVisibleWorkspaceCwd(context, this.environmentBackend),
      workspaceRoots: context.workspaceRoots,
      ...(context.workspaceSourceRefs ? { workspaceSourceRefs: context.workspaceSourceRefs } : {}),
    });
    const timestamp = this.now();
    const agentSession = store.createAgentSession({
      agentId: agent.id,
      configVersion: turn.configVersion,
      createdAt: timestamp,
      environmentPackageSnapshot: redactAgentEnvironmentPackageSnapshot(environmentPackage),
      id: agentSessionId,
      message: null,
      policySnapshotId: WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
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

    this.emitTurnStarted(store, environmentPackage, context.requestId ?? null);
    this.emitItemCreatedAndCompleted(
      store,
      environmentPackage,
      context.requestId ?? null,
      userItem
    );
    this.emitAgentSession(store, environmentPackage, context.requestId ?? null, agentSession);

    const workspaceDb = this.openWorkspaceDb(turn.workspaceId);

    try {
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

      if (workspaceDb && inputSnapshots.length > 0) {
        recordWorkspaceMaterializationRecords(
          workspaceDb,
          buildWorkspaceMaterializationRecords({
            createdAt: this.now(),
            inputSnapshots,
            materialization: { ...materialization, backendKind },
          })
        );
      }

      const busySession = store.updateAgentSession(agentSession.id, {
        message: null,
        status: 'busy',
        updatedAt: this.now(),
      });
      this.emitAgentSession(store, environmentPackage, context.requestId ?? null, busySession);
      await this.backend.launch(materialization);
      await this.backend.collectEvidence(environmentPackage.snapshotId);
      const transcript = await this.backend.collectTranscript(environmentPackage.snapshotId);
      const importResult = importWorkerTranscript(store, environmentPackage, transcript);
      const workspaceChanges = await this.backend.collectWorkspaceChanges(
        environmentPackage.snapshotId
      );

      this.createWorkspaceChangeArtifacts(store, environmentPackage, workspaceChanges, workspaceDb);
      await this.backend.collectArtifacts(environmentPackage.snapshotId);
      try {
        await this.backend.teardown(environmentPackage.snapshotId);
        this.markBackendWorkspaceHandlesCleanupStatus(
          workspaceDb,
          turn.workspaceId,
          environmentPackage.snapshotId,
          'cleaned'
        );
      } catch (error) {
        this.markBackendWorkspaceHandlesCleanupStatus(
          workspaceDb,
          turn.workspaceId,
          environmentPackage.snapshotId,
          'failed'
        );
        throw error;
      }
      this.emitImportedRecords(store, environmentPackage, context.requestId ?? null, importResult);
      this.completeTurn(store, environmentPackage, context.requestId ?? null, 'completed');
    } catch (error) {
      this.failTurn(store, environmentPackage, context.requestId ?? null, error);
      throw error;
    } finally {
      workspaceDb?.sqlite.close();
    }
  }

  /**
   * Interrupt is unsupported for the initial one-shot backend executor.
   *
   * @param store Store that owns the turn.
   * @param turnId Turn id to interrupt.
   * @param context Runtime command context.
   * @returns Promise that resolves after marking the turn interrupted.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    const turn = store.updateTurn(turnId, {
      completedAt: this.now(),
      status: 'interrupted',
    });

    store.emitTurnEvent(turnId, {
      data: { stopReason: 'aborted', turn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId: context.requestId ?? null,
      threadId: turn.threadId,
      turnId,
      workspaceId: turn.workspaceId,
    });
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
   */
  private createWorkspaceChangeArtifacts(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    records: readonly WorkerGovernanceWorkspaceChangeRecord[],
    workspaceDb: WorkspaceDb | null
  ): void {
    for (const record of records) {
      const timestamp = this.now();

      store.createArtifact({
        id: `ar_workspace_changes_${environmentPackage.scope.turnId}_${record.review.id}`,
        workspaceId: environmentPackage.scope.workspaceId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        kind: 'diff',
        title: 'Workspace changes ready for review',
        status: 'ready',
        summary: record.review.riskSummary,
        version: 1,
        content: {
          format: 'json',
          body: JSON.stringify(
            {
              changeSet: record.changeSet,
              patchPayload: record.patchPayload,
              review: record.review,
            },
            null,
            2
          ),
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      if (this.coreDb) {
        if (record.filesystemApply && workspaceDb) {
          recordFilesystemWorkspaceStagingRoot(workspaceDb, {
            before: record.filesystemApply.before,
            changeSetId: record.changeSet.id,
            createdAt: timestamp,
            reviewId: record.review.id,
            stagingRootPath: record.filesystemApply.stagingRootPath,
            targetRootPath: record.filesystemApply.targetRootPath,
            workspaceId: record.review.workspaceId,
          });
        }

        if (workspaceDb) {
          recordWorkspaceSyncReview(workspaceDb, {
            item: {
              artifactId: `ar_workspace_changes_${environmentPackage.scope.turnId}_${record.review.id}`,
              changeSet: record.changeSet,
              patchPayload: record.patchPayload,
              review: record.review,
            },
          });
        }
      }
    }
  }

  /**
   * Opens the workspace-scoped database used by workspace synchronization records.
   *
   * @param workspaceId Workspace id that owns the records.
   * @returns Workspace database handle, or null when durable storage is disabled.
   */
  private openWorkspaceDb(workspaceId: string): WorkspaceDb | null {
    if (!this.coreDb) {
      return null;
    }

    const workspaceDb = openWorkspaceDb(this.coreDb.dataRoot, LOCAL_USER_ID, workspaceId);
    applyScopedMigrations(workspaceDb);
    return workspaceDb;
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
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param status Terminal turn status.
   */
  private completeTurn(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    status: 'completed'
  ): void {
    const completedAt = this.now();
    const agentSession = store.updateAgentSession(environmentPackage.scope.agentSessionId, {
      message: null,
      status: 'idle',
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(environmentPackage.scope.turnId, {
      completedAt,
      error: null,
      status,
    });

    this.emitAgentSession(store, environmentPackage, requestId, agentSession);
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { stopReason: 'completed', turn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }

  /**
   * Marks one governed turn as failed.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param error Failure reason.
   */
  private failTurn(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    error: unknown
  ): void {
    const completedAt = this.now();
    const message = error instanceof Error ? error.message : 'The governed worker turn failed.';
    const agentSession = store.updateAgentSession(environmentPackage.scope.agentSessionId, {
      message,
      status: 'failed',
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(environmentPackage.scope.turnId, {
      completedAt,
      error: {
        code: 'worker_governance_turn_failed',
        message,
      },
      status: 'failed',
    });

    this.emitAgentSession(store, environmentPackage, requestId, agentSession);
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { stopReason: 'error', turn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
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
