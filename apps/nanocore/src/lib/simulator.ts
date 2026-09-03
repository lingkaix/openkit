import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  AgentEnvironmentPackage,
  SessionWorkspaceMaterializationPlan,
} from '@openkit/config-schema';
import type { ApprovalRequestSchema, ItemSchema, ItemType } from '@openkit/protocol';
import { ItemDeltaEventSchema, responsibleUserIdForActor } from '@openkit/protocol';
import type { z } from 'zod';
import type { WorkerContextPackageTrace } from '../context/worker-context-package.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  resolveAgentEnvironmentPackage,
  resolveAgentSessionCompatibilityKey,
} from '../runtime/agent-environment.js';
import { TurnStartValidationError } from '../runtime/orchestrator.js';
import type {
  AgentSessionReadModel,
  ApprovalDecision,
  CommitPreparedAgentSessionForTurnInput,
  HumanResponseCommandRuntimeContext,
  PrepareAgentSessionForTurnInput,
  PreparedAgentSessionForTurn,
  PreparedCurrentAgentSession,
  RuntimeCapabilities,
  RuntimeEventFamily,
  RuntimeItemDeltaKind,
  RuntimeItemType,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from '../runtime/types.js';
import { projectWorkerBackendCleanup } from '../runtime/worker-backend-cleanup-projection.js';
import {
  listWorkerBackendSessions,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  workerBackendImageIdentity,
  workerBackendLineageFromRuntimeImage,
} from '../runtime/worker-backend-sessions.js';
import { getWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import { recordWorkerControlAcceptedRecord } from '../runtime/worker-control-records.js';
import {
  acceptPreparedWorkerTurnContextPackage,
  prepareWorkerTurnContextPackage,
  workerVisibleWorkspaceCwd,
} from '../runtime/worker-governance-turn-executor.js';
import { importWorkerTranscript } from '../runtime/worker-transcript.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from '../runtime/workspace-materializer.js';
import { recordWorkspaceBackendHandoff } from '../runtime/workspace-sync-records.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import type { FsStore } from './store.js';

type RuntimeItem = z.infer<typeof ItemSchema>;

interface SimulatedTurnState {
  workspaceId: string;
  threadId: string;
  turnId: string;
  agentSessionId: string;
  requestId: string | null;
  userInputRequestId: string;
}

/**
 * Capability flags supported by the deterministic simulator.
 */
export const SIMULATOR_CAPABILITIES: RuntimeCapabilities = {
  approvals: false,
  interrupts: true,
  artifacts: true,
  workspaceConfig: true,
  workspaceKnowledgeEditing: true,
  questions: true,
};

/**
 * SSE event families emitted by the deterministic simulator.
 */
export const SIMULATOR_EVENT_FAMILIES: readonly RuntimeEventFamily[] = [
  'workspace.updated',
  'thread.created',
  'thread.updated',
  'turn.started',
  'turn.updated',
  'item.created',
  'item.delta',
  'item.completed',
  'agent.session.updated',
  'artifact.created',
  'artifact.updated',
  'turn.completed',
  'error',
];

/**
 * Protocol item types emitted by the deterministic simulator.
 */
export const SIMULATOR_ITEM_TYPES: readonly RuntimeItemType[] = [
  'user-message',
  'assistant-message',
  'reasoning',
  'command-execution',
  'user-input-request',
  'user-input-response',
  'artifact-reference',
];

/**
 * Protocol delta kinds emitted by the deterministic simulator.
 */
export const SIMULATOR_ITEM_DELTA_KINDS: readonly RuntimeItemDeltaKind[] = [
  'text-delta',
  'indexed-text-delta',
  'output-delta',
  'artifact-updated',
];

/** Captures immutable current AgentSession fields for post-dispatch compare-and-set validation. */
function simulatorCurrentAgentSessionSnapshot(
  agentSession: ReturnType<FsStore['getAgentSession']>
): PreparedCurrentAgentSession {
  return {
    agentId: agentSession.agentId,
    id: agentSession.id,
    policySnapshotId: agentSession.policySnapshotId,
    sessionCompatibilityKey: agentSession.sessionCompatibilityKey,
    stale: agentSession.stale,
    status: agentSession.status,
    updatedAt: agentSession.updatedAt,
  };
}

/**
 * Deterministic no-Codex turn executor used for local UI and e2e development.
 */
export class SimulatedTurnExecutor implements TurnExecutor {
  public readonly capabilities = SIMULATOR_CAPABILITIES;
  public readonly eventFamilies = SIMULATOR_EVENT_FAMILIES;
  public readonly itemTypes = SIMULATOR_ITEM_TYPES;
  public readonly itemDeltaKinds = SIMULATOR_ITEM_DELTA_KINDS;
  private readonly pendingByTurnId = new Map<string, SimulatedTurnState>();
  private readonly coreDb: CoreDb | null;

  /**
   * Creates the deterministic executor with optional durable S39 owners for configured self-checks.
   *
   * @param options Optional Core database shared with scheduler admission.
   */
  public constructor(options: { readonly coreDb?: CoreDb | undefined } = {}) {
    this.coreDb = options.coreDb ?? null;
  }

  /** Previews one exact simulator AgentSession decision without Store or backend effects. */
  public async prepareAgentSessionForTurn(
    store: FsStore,
    input: PrepareAgentSessionForTurnInput
  ): Promise<PreparedAgentSessionForTurn> {
    const currentSessions = store
      .listThreadAgentSessions(input.turn.workspaceId, input.turn.threadId)
      .filter((candidate) => isCurrentAgentSessionStatus(candidate.status));
    if (currentSessions.length > 1) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The Thread has multiple current AgentSessions.',
        409
      );
    }
    const current = currentSessions[0];
    const compatibilityKeyFor = (agentSessionId: string) =>
      resolveAgentSessionCompatibilityKey({
        agentSessionId,
        agentSetup: input.agentSetup,
        backend: { kind: 'openshell' },
        ...(this.coreDb ? { coreDb: this.coreDb } : {}),
        requestId: input.requestId,
        turn: input.turn,
        turnInput: input.turnInput,
        triggerActor: input.turn.triggerActor,
        workspaceCwd: input.workspaceCwd,
        workspaceRoots: input.workspaceRoots,
        ...(input.workspaceDataSourceCatalog
          ? { workspaceDataSourceCatalog: input.workspaceDataSourceCatalog }
          : {}),
        ...(input.workspaceMcpServerCatalog
          ? { workspaceMcpServerCatalog: input.workspaceMcpServerCatalog }
          : {}),
        ...(input.workspaceSourceRefs ? { workspaceSourceRefs: input.workspaceSourceRefs } : {}),
      });
    if (!current) {
      return {
        agentSessionId: input.freshAgentSessionId,
        currentAgentSession: null,
        replacementRequired: false,
        sessionCompatibilityKey: compatibilityKeyFor(input.freshAgentSessionId),
      };
    }
    const currentCompatibilityKey = compatibilityKeyFor(current.id);
    const currentTurns = current
      ? store
          .listThreadTurns(input.turn.workspaceId, input.turn.threadId)
          .filter((turn) => turn.agentSessionId === current.id)
      : [];
    const hasActiveTurn = currentTurns.some(
      (turn) => !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)
    );
    const hasActiveLease = this.coreDb
      ? Boolean(
          this.coreDb.sqlite
            .prepare(
              `SELECT 1
               FROM scheduler_session_leases
               WHERE agent_session_id = ?
                 AND status NOT IN ('released', 'lost', 'failed')
               LIMIT 1`
            )
            .get(current.id)
        )
      : false;
    const backendSessions = this.coreDb
      ? listWorkerBackendSessions(this.coreDb).filter(
          (session) => session.agentSessionId === current.id
        )
      : [];
    const runtimeReady =
      !this.coreDb ||
      (backendSessions.length > 0 &&
        backendSessions.every((session) => session.state === 'cleaned') &&
        !hasActiveLease);
    if (
      current.status === 'idle' &&
      !current.stale &&
      current.agentId === input.agentSetup.manifest.id &&
      current.sessionCompatibilityKey === currentCompatibilityKey &&
      !hasActiveTurn &&
      runtimeReady
    ) {
      return {
        agentSessionId: current.id,
        currentAgentSession: simulatorCurrentAgentSessionSnapshot(current),
        replacementRequired: false,
        sessionCompatibilityKey: currentCompatibilityKey,
      };
    }

    return {
      agentSessionId: input.freshAgentSessionId,
      currentAgentSession: simulatorCurrentAgentSessionSnapshot(current),
      replacementRequired: true,
      sessionCompatibilityKey: compatibilityKeyFor(input.freshAgentSessionId),
    };
  }

  /** Revalidates a simulator preview after dispatch and terminalizes an exact predecessor. */
  public async commitPreparedAgentSessionForTurn(
    store: FsStore,
    input: CommitPreparedAgentSessionForTurnInput
  ): Promise<void> {
    const { prepared, preparation } = input;
    const currentSessions = store
      .listThreadAgentSessions(preparation.turn.workspaceId, preparation.turn.threadId)
      .filter((candidate) => isCurrentAgentSessionStatus(candidate.status));
    const compatibilityKeyFor = (agentSessionId: string) =>
      resolveAgentSessionCompatibilityKey({
        agentSessionId,
        agentSetup: preparation.agentSetup,
        backend: { kind: 'openshell' },
        ...(this.coreDb ? { coreDb: this.coreDb } : {}),
        requestId: preparation.requestId,
        turn: preparation.turn,
        turnInput: preparation.turnInput,
        triggerActor: preparation.turn.triggerActor,
        workspaceCwd: preparation.workspaceCwd,
        workspaceRoots: preparation.workspaceRoots,
        ...(preparation.workspaceDataSourceCatalog
          ? { workspaceDataSourceCatalog: preparation.workspaceDataSourceCatalog }
          : {}),
        ...(preparation.workspaceMcpServerCatalog
          ? { workspaceMcpServerCatalog: preparation.workspaceMcpServerCatalog }
          : {}),
        ...(preparation.workspaceSourceRefs
          ? { workspaceSourceRefs: preparation.workspaceSourceRefs }
          : {}),
      });
    if (this.coreDb) {
      const lease = this.coreDb.sqlite
        .prepare(
          `SELECT workspace_id AS workspaceId, thread_id AS threadId,
                  agent_session_id AS agentSessionId
           FROM scheduler_session_leases
           WHERE lease_id = ?
             AND status NOT IN ('released', 'lost', 'failed')`
        )
        .get(input.leaseId) as
        | {
            readonly agentSessionId: string;
            readonly threadId: string;
            readonly workspaceId: string;
          }
        | undefined;
      if (
        !lease ||
        lease.workspaceId !== preparation.turn.workspaceId ||
        lease.threadId !== preparation.turn.threadId ||
        lease.agentSessionId !== prepared.agentSessionId
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The simulator admission lease changed before commit.',
          409
        );
      }
    }
    if (!prepared.currentAgentSession) {
      if (
        prepared.replacementRequired ||
        currentSessions.length !== 0 ||
        compatibilityKeyFor(prepared.agentSessionId) !== prepared.sessionCompatibilityKey
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Fresh simulator AgentSession admission changed after dispatch.',
          409
        );
      }
      return;
    }

    const current = currentSessions[0];
    if (
      currentSessions.length !== 1 ||
      !current ||
      !isDeepStrictEqual(
        simulatorCurrentAgentSessionSnapshot(current),
        prepared.currentAgentSession
      ) ||
      current.status !== 'idle' ||
      current.stale
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The simulator predecessor changed after dispatch.',
        409
      );
    }
    const hasActiveTurn = store
      .listThreadTurns(preparation.turn.workspaceId, preparation.turn.threadId)
      .some(
        (turn) =>
          turn.agentSessionId === current.id &&
          !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)
      );
    const hasConflictingLease = this.coreDb
      ? Boolean(
          this.coreDb.sqlite
            .prepare(
              `SELECT 1 FROM scheduler_session_leases
               WHERE agent_session_id = ?
                 AND status NOT IN ('released', 'lost', 'failed')
                 AND lease_id <> ?
               LIMIT 1`
            )
            .get(current.id, input.leaseId)
        )
      : false;
    const backendSessions = this.coreDb
      ? listWorkerBackendSessions(this.coreDb).filter(
          (session) => session.agentSessionId === current.id
        )
      : [];
    if (
      hasActiveTurn ||
      hasConflictingLease ||
      (this.coreDb &&
        (backendSessions.length === 0 ||
          backendSessions.some((session) => session.state !== 'cleaned')))
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The simulator predecessor runtime changed after dispatch.',
        409
      );
    }

    if (!prepared.replacementRequired) {
      if (
        prepared.agentSessionId !== current.id ||
        compatibilityKeyFor(current.id) !== prepared.sessionCompatibilityKey ||
        current.agentId !== preparation.agentSetup.manifest.id ||
        current.sessionCompatibilityKey !== prepared.sessionCompatibilityKey
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Reusable simulator AgentSession admission changed after dispatch.',
          409
        );
      }
      return;
    }
    if (
      prepared.agentSessionId !== preparation.freshAgentSessionId ||
      compatibilityKeyFor(prepared.agentSessionId) !== prepared.sessionCompatibilityKey
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Replacement simulator AgentSession admission changed after dispatch.',
        409
      );
    }
    store.updateAgentSession(current.id, {
      message: 'Replaced before a Turn with incompatible static runtime inputs.',
      status: 'closed',
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Starts one deterministic simulated turn and pauses on a non-secret user-input Gate.
   *
   * @throws When launch did not supply the selected agent setup or its manifest does not match the
   * turn.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = {
      requestId: null,
      triggerActor: { kind: 'system', id: 'simulator', responsibleUserId: null },
      workspaceRoots: [],
    }
  ): Promise<void> {
    const turn = store.getTurnById(turnId);
    if (!context.agentSetup) {
      throw new Error('Simulator execution requires one resolved agent setup.');
    }
    if (!turn.agentId) {
      throw new Error(`Simulator turn has no assigned agent: ${turn.id}`);
    }
    const manifest = context.agentSetup.manifest;
    if (turn.agentId !== manifest.id) {
      throw new Error(
        `Simulator turn agent ${turn.agentId} does not match resolved agent setup ${manifest.id}.`
      );
    }
    if (context.sessionCompatibilityKey) {
      const launchCompatibilityKey = resolveAgentSessionCompatibilityKey({
        agentSessionId: context.agentSessionId ?? `session_sim_turn_${turn.id}`,
        agentSetup: context.agentSetup,
        backend: { kind: 'openshell' },
        ...(this.coreDb ? { coreDb: this.coreDb } : {}),
        requestId: context.requestId ?? null,
        turn,
        turnInput: input,
        triggerActor: context.triggerActor,
        workspaceCwd: workerVisibleWorkspaceCwd(context, { kind: 'openshell' }),
        workspaceRoots: context.workspaceRoots,
        ...(context.workspaceDataSourceCatalog
          ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
          : {}),
        ...(context.workspaceMcpServerCatalog
          ? { workspaceMcpServerCatalog: context.workspaceMcpServerCatalog }
          : {}),
        ...(context.workspaceSourceRefs
          ? { workspaceSourceRefs: context.workspaceSourceRefs }
          : {}),
      });
      if (context.sessionCompatibilityKey !== launchCompatibilityKey) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The scheduler lease SessionCompatibilityKey does not match final launch inputs.',
          409
        );
      }
    }
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const workspaceDb = this.coreDb
      ? openWorkspaceDb(this.coreDb.dataRoot, turn.workspaceId)
      : null;

    try {
      if (workspaceDb) {
        applyScopedMigrations(workspaceDb);
      }
      const checkpoint = workspaceDb
        ? getWorkerCheckpoint(workspaceDb, turn.workspaceId, turn.threadId, turn.id)
        : null;
      if (checkpoint && !context.sandboxBindingRef) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Worker Context Package scheduler binding is unavailable.',
          409
        );
      }
      const preparedContext =
        this.coreDb && workspaceDb && checkpoint && context.sandboxBindingRef
          ? prepareWorkerTurnContextPackage(this.coreDb, workspaceDb, store, checkpoint, {
              requestId: context.requestId ?? null,
              threadId: turn.threadId,
              turnId: turn.id,
              workerRequest: input,
              workspaceId: turn.workspaceId,
            })
          : null;
      const agentSessionId = context.agentSessionId ?? `session_sim_turn_${turn.id}`;
      const environmentBackend = { kind: 'openshell' } as const;
      const resolvedEnvironmentPackage = preparedContext
        ? resolveAgentEnvironmentPackage({
            agentSessionId,
            agentSetup: context.agentSetup,
            backend: environmentBackend,
            coreDb: this.coreDb!,
            createdAt: timestamp,
            preparedContextPackage: preparedContext.preparedContextPackage,
            requestId: context.requestId ?? null,
            turn,
            turnInput: input,
            triggerActor: context.triggerActor,
            workspaceCwd: workerVisibleWorkspaceCwd(context, environmentBackend),
            workspaceRoots: context.workspaceRoots,
            ...(context.workspaceDataSourceCatalog
              ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
              : {}),
            ...(context.workspaceMcpServerCatalog
              ? { workspaceMcpServerCatalog: context.workspaceMcpServerCatalog }
              : {}),
            ...(context.workspaceSourceRefs
              ? { workspaceSourceRefs: context.workspaceSourceRefs }
              : {}),
          })
        : null;
      const environmentPackage: AgentEnvironmentPackage | null = resolvedEnvironmentPackage
        ? {
            ...resolvedEnvironmentPackage,
            scope: { ...resolvedEnvironmentPackage.scope, itemId: `it_user_${turnId}` },
          }
        : null;
      const sessionWorkspace = environmentPackage
        ? (
            environmentPackage.extensions.openkit as {
              sessionWorkspace: SessionWorkspaceMaterializationPlan;
            }
          ).sessionWorkspace
        : null;
      if (
        context.sessionCompatibilityKey &&
        sessionWorkspace &&
        sessionWorkspace.compatibilityKey.digest !== context.sessionCompatibilityKey
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The final Agent Environment Package changed the scheduler lease compatibility key.',
          409
        );
      }
      let existingAgentSession: ReturnType<FsStore['getAgentSession']> | undefined;
      try {
        existingAgentSession = store.getAgentSession(agentSessionId);
      } catch {
        existingAgentSession = undefined;
      }
      const conflictingCurrentAgentSession = store
        .listThreadAgentSessions(turn.workspaceId, turn.threadId)
        .find(
          (candidate) =>
            candidate.id !== agentSessionId && isCurrentAgentSessionStatus(candidate.status)
        );
      if (conflictingCurrentAgentSession) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The Thread already has another current AgentSession.',
          409
        );
      }
      if (
        existingAgentSession &&
        (!environmentPackage ||
          existingAgentSession.workspaceId !== turn.workspaceId ||
          existingAgentSession.threadId !== turn.threadId ||
          existingAgentSession.agentId !== manifest.id ||
          existingAgentSession.status !== 'idle' ||
          existingAgentSession.stale ||
          existingAgentSession.sessionCompatibilityKey !==
            sessionWorkspace?.compatibilityKey.digest ||
          existingAgentSession.policySnapshotId !== WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID)
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The selected AgentSession is not reusable for this Turn.',
          409
        );
      }
      const agentSession = existingAgentSession
        ? store.updateAgentSession(existingAgentSession.id, {
            configVersion: turn.configVersion,
            environmentPackageSnapshotId: environmentPackage!.snapshotId,
            message: null,
            status: 'initializing',
            updatedAt: timestamp,
          })
        : store.createAgentSession({
            id: agentSessionId,
            agentId: manifest.id,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            status: 'created',
            message: null,
            configVersion: turn.configVersion,
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(environmentPackage
              ? {
                  environmentPackageSnapshotId: environmentPackage.snapshotId,
                  policySnapshotId: WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
                  sessionCompatibilityKey: sessionWorkspace!.compatibilityKey.digest,
                  workspaceRoots: context.workspaceRoots,
                }
              : {}),
          });
      const selectedProfileId =
        environmentPackage?.agent.profileId ??
        manifest.defaultProfileId ??
        manifest.profiles?.[0]?.id ??
        null;

      store.updateTurn(turnId, {
        agentProfileId: selectedProfileId,
        agentSessionId: agentSession.id,
      });
      const state: SimulatedTurnState = {
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId,
        agentSessionId: agentSession.id,
        requestId: context.requestId ?? null,
        userInputRequestId: `ui_${turnId}`,
      };

      this.emitStartedEnvelope(store, state, agentSession, input);

      if (
        this.coreDb &&
        workspaceDb &&
        preparedContext &&
        environmentPackage &&
        context.sandboxBindingRef
      ) {
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: timestamp,
          environmentPackage,
        });
        const backendSessionId = `self-check_${environmentPackage.snapshotId}`;
        const backendLineage = workerBackendLineageFromRuntimeImage(
          environmentPackage.runtime.image
        );
        const runtimeTarget = this.coreDb.sqlite
          .prepare(
            `SELECT target_id AS targetId
             FROM scheduler_session_leases
             WHERE sandbox_binding_ref = ?`
          )
          .get(context.sandboxBindingRef) as { readonly targetId: string } | undefined;
        if (!runtimeTarget) {
          throw new Error('Internal self-check scheduler RuntimeTarget is unavailable.');
        }
        const backendSession = recordWorkerBackendSessionMaterializing(this.coreDb, {
          backendLineage,
          backendVersion: null,
          identity: {
            agentSessionId,
            backendKind: 'openshell',
            backendSessionId,
            deploymentId: readDataRootLayoutMarker(this.coreDb.dataRoot).deploymentId,
            packageSnapshotId: environmentPackage.snapshotId,
            runtimeTargetId: runtimeTarget.targetId,
            stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
            transientProviderInstanceId: null,
          },
          lineage: {
            threadId: turn.threadId,
            turnId: turn.id,
            workspaceId: turn.workspaceId,
          },
          now: () => timestamp,
          sandboxBindingRef: context.sandboxBindingRef,
        });
        const inputSnapshots = buildWorkspaceInputSnapshots({
          backendCapabilities: [],
          backendKind: 'openshell',
          createdAt: timestamp,
          environmentPackage,
        });
        const materializationRecords = buildWorkspaceMaterializationRecords({
          createdAt: timestamp,
          inputSnapshots,
          materialization: {
            backendKind: 'openshell',
            backendStatus: { health: 'ready', version: null },
            packageSnapshotId: environmentPackage.snapshotId,
            requiredCapabilities: environmentPackage.backend.requiredCapabilities,
            sandbox: { name: backendSessionId, state: 'created' },
            workspaceInputs: environmentPackage.workspace.inputs.map((workspaceInput) => ({
              id: workspaceInput.id,
              target: workspaceInput.target,
            })),
          },
        });
        transitionWorkerBackendSessionState(this.coreDb, {
          fromState: 'materializing',
          leaseId: backendSession.leaseId,
          now: () => timestamp,
          toState: 'materialized',
        });
        recordWorkspaceBackendHandoff(workspaceDb, inputSnapshots, materializationRecords);
        markWorkerBackendWorkspaceHandoffComplete(this.coreDb, {
          leaseId: backendSession.leaseId,
          now: () => timestamp,
        });
        const acceptedTrace = acceptPreparedWorkerTurnContextPackage({
          coreDb: this.coreDb,
          environmentPackage,
          preparedContext,
          store,
          workspaceDb,
        });
        this.importMaterialProposals(
          store,
          environmentPackage,
          acceptedTrace,
          workspaceDb,
          timestamp
        );
        recordWorkerControlAcceptedRecord(this.coreDb, {
          acceptedAt: timestamp,
          lineage: {
            agentSessionId,
            packageSnapshotId: environmentPackage.snapshotId,
            requestId: environmentPackage.scope.requestId,
            threadId: turn.threadId,
            turnId: turn.id,
            workspaceId: turn.workspaceId,
          },
          operation: 'final_status',
          record: { sequence: 1, status: 'blocked', stopReason: 'ask_user' },
          recordKey: '1',
          sequence: 1,
        });
        transitionWorkerBackendSessionState(this.coreDb, {
          fromState: 'materialized',
          leaseId: backendSession.leaseId,
          now: () => timestamp,
          toState: 'cleanup-pending',
        });
        transitionWorkerBackendSessionState(this.coreDb, {
          fromState: 'cleanup-pending',
          leaseId: backendSession.leaseId,
          now: () => timestamp,
          toState: 'physical-cleaned',
        });
        projectWorkerBackendCleanup(workspaceDb, {
          agentSessionId,
          backendSessionId,
          backendType: 'openshell',
          backendVersion: null,
          completedAt: timestamp,
          environmentPackage,
          outcome: 'succeeded',
          packageSnapshotId: environmentPackage.snapshotId,
          placement: 'local',
          threadId: turn.threadId,
          turnId: turn.id,
          workerImage: workerBackendImageIdentity(backendLineage),
          workspaceHandoffState: 'complete',
          workspaceId: turn.workspaceId,
        });
        transitionWorkerBackendSessionState(this.coreDb, {
          fromState: 'physical-cleaned',
          leaseId: backendSession.leaseId,
          now: () => timestamp,
          toState: 'cleaned',
        });
      }

      this.emitAssistant(store, state);
      this.emitReasoning(store, state);
      this.emitCommand(store, state);
      this.emitUserInputRequest(store, state);
    } finally {
      workspaceDb?.sqlite.close();
    }
  }

  /**
   * Interrupts one simulated turn and emits a terminal interrupted state.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    const turnRecord = store.getTurnById(turnId);
    if (!turnRecord.agentSessionId) {
      throw new Error(`Simulator turn has no assigned AgentSession: ${turnId}`);
    }
    const state = this.pendingByTurnId.get(turnId) ?? {
      workspaceId: turnRecord.workspaceId,
      threadId: turnRecord.threadId,
      turnId,
      agentSessionId: turnRecord.agentSessionId,
      requestId: context.requestId,
      userInputRequestId: `ui_${turnId}`,
    };
    state.requestId = context.requestId;
    const completedAt = new Date().toISOString();
    const agentSession = store.updateAgentSession(state.agentSessionId, {
      status: 'failed',
      message: 'The simulator turn was interrupted.',
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(turnId, {
      status: 'interrupted',
      completedAt,
    });

    store.emitTurnEvent(turnId, {
      event: 'agent.session.updated',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'aborted', turn },
    });
    this.pendingByTurnId.delete(turnId);
  }

  /**
   * Rejects approval resolution because the simulator exposes no permission policy.
   *
   * @param _store Product store supplied by the runtime contract.
   * @param approvalRequestId Unsupported approval request identity.
   * @param _decision Unsupported approval decision.
   * @param _context Human response context supplied by the runtime contract.
   * @throws Error for every call because simulator approvals are unsupported.
   */
  public async respondApproval(
    _store: FsStore,
    approvalRequestId: string,
    _decision: ApprovalDecision,
    _context: HumanResponseCommandRuntimeContext
  ): Promise<z.infer<typeof ApprovalRequestSchema>> {
    throw new Error(`Simulator approval requests are unsupported: ${approvalRequestId}`);
  }

  /**
   * Returns the deterministic simulator session bound to one thread.
   */
  public getAgentSession(
    store: FsStore,
    workspaceId: string,
    threadId: string
  ): AgentSessionReadModel {
    const sessions = store.listThreadAgentSessions(workspaceId, threadId);
    const turns = store.listThreadTurns(workspaceId, threadId);
    const activeSessionId = turns.findLast(
      (turn) =>
        !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status) &&
        turn.agentSessionId
    )?.agentSessionId;
    const latestSessionId = turns.findLast((turn) => turn.agentSessionId)?.agentSessionId;
    const storedSession =
      sessions.find((session) => session.id === activeSessionId) ??
      sessions.find((session) => session.id === latestSessionId);

    return {
      id: storedSession?.id ?? `session_sim_${threadId}`,
      status: storedSession?.status ?? 'ready',
      message: null,
      configVersion: storedSession?.configVersion ?? null,
      workspaceRoots: storedSession?.workspaceRoots ?? [],
      stale: false,
      sandboxSummary: storedSession?.sandboxSummary ?? null,
      backend: {
        kind: 'unknown',
        health: 'not-applicable',
        controlMode: null,
        control: null,
        runtimeTargetId: null,
        sandboxBindingRef: null,
        version: null,
      },
    };
  }

  /**
   * Resolves the simulator question, emits an artifact update, and completes the turn.
   */
  public async respondUserInput(
    store: FsStore,
    turnId: string,
    answers: Record<string, [string]>,
    context: HumanResponseCommandRuntimeContext
  ) {
    const state = this.pendingByTurnId.get(turnId);

    if (!state) {
      throw new Error(`Simulator user-input request is not active for turn: ${turnId}`);
    }

    const requestId = context.requestId;
    if (!requestId) {
      throw new Error('Simulator Artifact creation requires the current request identity.');
    }
    state.requestId = requestId;
    const input = Object.values(answers)[0]?.[0];
    if (!input) {
      throw new Error('Simulator user-input response has no answer.');
    }
    const timestamp = new Date().toISOString();
    const responseItem = store.createItem({
      id: `it_user_input_response_${turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId,
      type: 'user-input-response',
      status: 'completed',
      actor: context.actor,
      causationId: requestId,
      userInputRequestId: state.userInputRequestId,
      answers,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const runningTurn = store.updateTurn(turnId, { status: 'running', humanGate: null });
    const runningAgentSession = store.updateAgentSession(state.agentSessionId, {
      status: 'busy',
    });

    this.emitItemCreated(store, state, responseItem);
    this.emitItemCompleted(store, state, responseItem);
    this.emitTurnUpdated(store, state, runningTurn);
    this.emitAgentSessionUpdated(store, state, runningAgentSession);
    this.emitArtifactAndComplete(store, state, input, requestId);
    this.pendingByTurnId.delete(turnId);
    return store.getTurnById(turnId);
  }

  /**
   * Emits the shared turn-start, user item, and AgentSession events.
   */
  private emitStartedEnvelope(
    store: FsStore,
    state: SimulatedTurnState,
    agentSession: ReturnType<FsStore['createAgentSession']>,
    input: string
  ): void {
    const turn = store.getTurnById(state.turnId);
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const userItem = store.createItem({
      id: `it_user_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'user-message',
      status: 'completed',
      actor: turn.triggerActor,
      text: input,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    store.emitTurnEvent(state.turnId, {
      event: 'turn.started',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'turn-started', turnId: state.turnId, status: 'running' },
    });
    this.emitItemCreated(store, state, userItem);
    this.emitItemCompleted(store, state, userItem);
    this.emitAgentSessionUpdated(store, state, agentSession);
  }

  /**
   * Emits an assistant message with text deltas.
   */
  private emitAssistant(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const assistantItem = store.createItem({
      id: `it_assistant_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: timestamp,
      completedAt: null,
    });

    this.emitItemCreated(store, state, assistantItem);
    this.emitItemDelta(
      store,
      state,
      assistantItem.id,
      'text-delta',
      'Reviewing workspace context. ',
      'assistant-message'
    );
    this.emitItemDelta(
      store,
      state,
      assistantItem.id,
      'text-delta',
      'Preparing a deterministic plan.',
      'assistant-message'
    );
    const completedAssistantItem = store.updateItem(assistantItem.id, {
      status: 'completed',
      text: 'Reviewing workspace context. Preparing a deterministic plan.',
      completedAt: timestamp,
    });
    this.emitItemCompleted(store, state, completedAssistantItem);
  }

  /**
   * Emits a reasoning item with indexed text deltas.
   */
  private emitReasoning(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const reasoningItem = store.createItem({
      id: `it_reasoning_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'reasoning',
      status: 'in_progress',
      summary: [],
      content: [],
      createdAt: timestamp,
      completedAt: null,
    });

    this.emitItemCreated(store, state, reasoningItem);
    this.emitItemDelta(
      store,
      state,
      reasoningItem.id,
      'indexed-text-delta',
      'Check simulator branch coverage.',
      'reasoning'
    );
    const completedReasoningItem = store.updateItem(reasoningItem.id, {
      status: 'completed',
      summary: ['Simulator path covered.'],
      content: ['Check simulator branch coverage.'],
      completedAt: timestamp,
    });
    this.emitItemCompleted(store, state, completedReasoningItem);
  }

  /**
   * Emits a command-execution item with output deltas.
   */
  private emitCommand(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const commandItem = store.createItem({
      id: `it_command_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'command-execution',
      status: 'in_progress',
      command: 'pnpm verify --simulated',
      cwd: process.cwd(),
      output: '',
      exitCode: null,
      durationMs: null,
      createdAt: timestamp,
      completedAt: null,
    });

    this.emitItemCreated(store, state, commandItem);
    this.emitItemDelta(
      store,
      state,
      commandItem.id,
      'output-delta',
      'simulator: ok',
      'command-execution'
    );
    store.updateItem(commandItem.id, { output: 'simulator: ok' });
    const completedCommandItem = store.updateItem(commandItem.id, {
      status: 'completed',
      exitCode: 0,
      durationMs: 12,
      completedAt: timestamp,
    });
    this.emitItemCompleted(store, state, completedCommandItem);
  }

  /**
   * Imports two deterministic same-base Material proposals through the canonical transcript owner.
   *
   * @param store Product store receiving canonical Artifact projections.
   * @param environmentPackage Accepted Agent Environment Package lineage.
   * @param trace Strictly accepted Context Package trace.
   * @param workspaceDb Workspace authority containing Material and Review owners.
   * @param recordedAt Stable simulator timestamp.
   */
  private importMaterialProposals(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    trace: WorkerContextPackageTrace,
    workspaceDb: WorkspaceDb,
    recordedAt: string
  ): void {
    const selection = trace.materialSelections[0];
    if (!selection) {
      return;
    }
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: trace.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const proposal = {
      baseContentDigest: selection.contentDigest,
      baseRevisionId: selection.revisionId,
      materialId: selection.materialId,
    };
    const candidates = [
      Buffer.from('# Simulator proposal\n\nApply the concise deterministic revision.\n', 'utf8'),
      Buffer.from('# Simulator proposal\n\nApply the detailed deterministic revision.\n', 'utf8'),
    ];
    const artifactsJsonl = candidates
      .map((_, index) =>
        JSON.stringify({
          artifact: {
            kind: 'file',
            materialProposal: proposal,
            mediaType: selection.mediaType,
            path: `/workspace/output/material-proposal-${index + 1}.md`,
            title: `Simulator Material proposal ${index + 1}`,
          },
          kind: 'artifact',
          lineage,
          schemaVersion: 1,
          sequence: index + 1,
        })
      )
      .join('\n');
    const result = importWorkerTranscript(
      store,
      environmentPackage,
      {
        artifactsJsonl: `${artifactsJsonl}\n`,
        artifactFiles: candidates.map((bytes, index) => ({ bytes, sequence: index + 1 })),
      },
      { contextPackageTrace: trace, recordedAt, workspaceDb }
    );
    if (result.artifactIds.length !== candidates.length || result.diagnostics.length > 0) {
      throw new Error('Simulator Material proposal import failed.');
    }
  }

  /**
   * Emits the deterministic non-secret user-input request and pauses the turn.
   *
   * @param store Product store containing the active Turn.
   * @param state Active simulator lineage.
   * @throws Error when the triggering actor has no responsible user.
   */
  private emitUserInputRequest(store: FsStore, state: SimulatedTurnState): void {
    const timestamp = new Date().toISOString();
    const responsibleUserId = responsibleUserIdForActor(
      store.getTurnById(state.turnId).triggerActor
    );
    if (responsibleUserId === null) {
      throw new Error('Simulator user-input responsibility is unavailable.');
    }
    const requestItem = store.createItem({
      id: `it_user_input_request_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId,
      userInputRequestId: state.userInputRequestId,
      prompt: 'Which summary tone should the simulator use?',
      questions: [
        {
          id: 'tone',
          header: 'Tone',
          question: 'Which summary tone should the simulator use?',
          options: null,
          isOther: false,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const agentSession = store.updateAgentSession(state.agentSessionId, { status: 'suspended' });
    const turn = store.updateTurn(state.turnId, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: state.userInputRequestId,
        itemId: requestItem.id,
      },
    });

    this.pendingByTurnId.set(state.turnId, state);
    this.emitItemCreated(store, state, requestItem);
    this.emitItemCompleted(store, state, requestItem);
    this.emitTurnUpdated(store, state, turn);
    this.emitAgentSessionUpdated(store, state, agentSession);
  }

  /**
   * Emits one final synthetic Artifact and terminal Turn events.
   *
   * @param store Store that owns the Turn.
   * @param state Active simulator lineage.
   * @param input Accepted user answer.
   * @param requestId Request proof validated before any response mutation.
   */
  private emitArtifactAndComplete(
    store: FsStore,
    state: SimulatedTurnState,
    input: string,
    requestId: string
  ): void {
    const timestamp = new Date().toISOString();
    const body = `Simulator answer: ${input}`;
    const artifact = store.createArtifact({
      id: `ar_${state.turnId}`,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      kind: 'summary',
      title: 'Simulated protocol summary',
      status: 'ready',
      summary: 'Deterministic simulator artifact ready.',
      version: 1,
      content: {
        format: 'markdown',
        body,
      },
      contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
      lastMutationRequestId: requestId,
      origin: {
        kind: 'turn-output',
        requestId,
        threadId: state.threadId,
        turnId: state.turnId,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const artifactItem = store
      .listThreadItems(state.workspaceId, state.threadId)
      .find(
        (item) =>
          item.type === 'artifact-reference' &&
          item.artifactId === artifact.id &&
          item.artifactVersion === artifact.version
      );
    if (!artifactItem) {
      throw new Error(`Artifact reference was not persisted: ${artifact.id}`);
    }
    const completedAt = new Date().toISOString();
    const agentSession = store.updateAgentSession(state.agentSessionId, {
      status: 'idle',
      message: null,
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(state.turnId, {
      status: 'completed',
      completedAt,
    });

    store.emitTurnEvent(state.turnId, {
      event: 'artifact.created',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'artifact-created', artifact },
    });
    this.emitItemCreated(store, state, artifactItem);
    this.emitItemDelta(
      store,
      state,
      artifactItem.id,
      'artifact-updated',
      artifact.id,
      'artifact-reference'
    );
    this.emitItemCompleted(store, state, artifactItem);
    this.emitAgentSessionUpdated(store, state, agentSession);
    store.emitTurnEvent(state.turnId, {
      event: 'turn.completed',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'turn-completed', stopReason: 'completed', turn },
    });
  }

  /**
   * Emits one item creation event.
   */
  private emitItemCreated(
    store: FsStore,
    state: SimulatedTurnState,
    item: ReturnType<FsStore['createItem']>
  ): void {
    store.emitTurnEvent(state.turnId, {
      event: 'item.created',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'item-created', item },
    });
  }

  /**
   * Emits one item delta event.
   */
  private emitItemDelta(
    store: FsStore,
    state: SimulatedTurnState,
    itemId: string,
    deltaKind:
      | 'text-delta'
      | 'indexed-text-delta'
      | 'output-delta'
      | 'interaction-delta'
      | 'artifact-updated',
    delta: string,
    itemType: ItemType
  ): void {
    const base = {
      type: 'item-delta' as const,
      itemId,
      itemType,
    };
    const data = ItemDeltaEventSchema.parse(
      deltaKind === 'indexed-text-delta'
        ? { ...base, deltaKind, partId: 'default', delta }
        : deltaKind === 'artifact-updated'
          ? { ...base, deltaKind, artifactId: delta, summary: null }
          : { ...base, deltaKind, delta }
    );

    store.emitTurnEvent(state.turnId, {
      event: 'item.delta',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data,
    });
  }

  /**
   * Emits one item completion event.
   */
  private emitItemCompleted(store: FsStore, state: SimulatedTurnState, item: RuntimeItem): void {
    store.emitTurnEvent(state.turnId, {
      event: 'item.completed',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'item-completed', itemId: item.id, item },
    });
  }

  /**
   * Emits one turn update event.
   */
  private emitTurnUpdated(
    store: FsStore,
    state: SimulatedTurnState,
    turn: ReturnType<FsStore['updateTurn']>
  ): void {
    store.emitTurnEvent(state.turnId, {
      event: 'turn.updated',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'turn-updated', turn },
    });
  }

  /**
   * Emits one AgentSession update event.
   */
  private emitAgentSessionUpdated(
    store: FsStore,
    state: SimulatedTurnState,
    agentSession: ReturnType<FsStore['updateAgentSession']>
  ): void {
    store.emitTurnEvent(state.turnId, {
      event: 'agent.session.updated',
      requestId: state.requestId,
      workspaceId: state.workspaceId,
      threadId: state.threadId,
      turnId: state.turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
  }
}
