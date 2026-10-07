import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  AgentEnvironmentPackage,
  SessionWorkspaceMaterializationPlan,
} from '@openkit/config-schema';
import type { ActorRef, ApprovalRequestSchema, ItemSchema, ItemType } from '@openkit/protocol';
import {
  ItemDeltaEventSchema,
  isSealedTurnTerminal,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import type { z } from 'zod';
import { createArtifactReview } from '../artifact-reviews.js';
import type { WorkerContextPackageTrace } from '../context/worker-context-package.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  resolveAgentEnvironmentPackage,
  resolveAgentSessionCompatibilityKey,
} from '../runtime/agent-environment.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  finalizeSchedulerExecutionAttemptInput,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import type {
  ExecutionBackend,
  ExecutionBackendCorrelation,
  ExecutionBackendObservation,
  ExecutionReleaseProof,
} from '../runtime/execution-backend.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { bindNanoHostAttemptPreparation } from '../runtime/nanohost-attempt-records.js';
import { dispatchOpenkitWorkTool } from '../runtime/openkit-work-mcp.js';
import { TurnStartValidationError } from '../runtime/orchestrator.js';
import {
  frozenPendingOutcomeInput,
  listThreadPendingRequests,
  pendingRequestSystemActor,
  proveFrozenDelivery,
} from '../runtime/pending-requests.js';
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
import { createLocalSimulatorCredentialCheckValues } from '../runtime/worker-credential-guard.js';
import {
  acceptPreparedWorkerTurnContextPackage,
  prepareWorkerTurnContextPackage,
  workerVisibleWorkspaceCwd,
} from '../runtime/worker-governance-turn-executor.js';
import { preflightArtifactTuple, prepareWorkerArtifact } from '../runtime/worker-transcript.js';
import { bindWorkerCheckpointToPreparedSession } from '../runtime/worker-turn-loop.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from '../runtime/workspace-materializer.js';
import { recordWorkspaceBackendHandoff } from '../runtime/workspace-sync-records.js';
import type { SchedulerWorkerStorageChoice } from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { readWorkObservationTurnBinding } from '../storage/work-observations.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, type FsStore } from './store.js';

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
export class SimulatedTurnExecutor implements TurnExecutor, ExecutionBackend {
  public readonly id = 'nanohost';
  public readonly executionBackend: ExecutionBackend = this;
  public readonly capabilities = SIMULATOR_CAPABILITIES;
  public readonly eventFamilies = SIMULATOR_EVENT_FAMILIES;
  public readonly itemTypes = SIMULATOR_ITEM_TYPES;
  public readonly itemDeltaKinds = SIMULATOR_ITEM_DELTA_KINDS;
  private readonly coreDb: CoreDb | null;

  /**
   * Creates the deterministic executor with optional durable S39 owners for configured self-checks.
   *
   * @param options Optional Core database shared with scheduler admission.
   */
  public constructor(options: { readonly coreDb?: CoreDb | undefined } = {}) {
    this.coreDb = options.coreDb ?? null;
  }

  /** Models submission only for the existing explicit self-check executor; no native effect is inferred. */
  public async submit(
    input: ExecutionBackendCorrelation & { readonly deadline: string }
  ): Promise<ExecutionBackendObservation> {
    if (!this.coreDb) throw new Error('Self-check submission requires Core authority.');
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.attemptId);
    if (
      attempt.phase !== 'open' ||
      attempt.deadline !== input.deadline ||
      commandInputHash(schedulerExecutionCorrelation(attempt)) !==
        commandInputHash({
          attemptId: input.attemptId,
          backendId: input.backendId,
          bindingRef: input.bindingRef,
          inputRef: input.inputRef,
          operationId: input.operationId,
        })
    )
      throw new Error('Self-check submission has no exact authority.');
    return {
      ...input,
      disposition: 'accepted',
      execution: 'pending',
      fenceRef: null,
      outcomeRef: null,
    };
  }
  /** Reads the original modeled owner without replay or a native resource probe. */
  public async inspect(
    input: ExecutionBackendCorrelation
  ): Promise<ExecutionBackendObservation | null> {
    if (!this.coreDb) return null;
    const attempt = requireSchedulerExecutionAttempt(this.coreDb, input.attemptId);
    if (commandInputHash(schedulerExecutionCorrelation(attempt)) !== commandInputHash(input))
      return null;
    return {
      ...input,
      disposition: attempt.disposition,
      execution: attempt.phase === 'closed' ? 'terminal' : 'unknown',
      fenceRef: attempt.fenceRef,
      outcomeRef: attempt.outcomeRef,
    };
  }
  /** Models cancellation acknowledgement without making it a release fence. */
  public async cancel(input: ExecutionBackendCorrelation): Promise<ExecutionBackendObservation> {
    return {
      ...input,
      disposition: 'accepted',
      execution: 'unknown',
      fenceRef: null,
      outcomeRef: null,
    };
  }
  /** Returns the explicit modeled fence after the self-check's ordinary closeout succeeds. */
  public async release(
    input: ExecutionBackendCorrelation & { readonly proof: ExecutionReleaseProof }
  ) {
    const { proof, ...correlation } = input;
    const complete = [
      proof.terminalHandoff,
      proof.output,
      proof.evidence,
      proof.outsideWorkspaceCollection,
      proof.integrationDrain,
      proof.routesRevoked,
    ].every((value) => value === true);
    return {
      ...correlation,
      state: complete ? ('released' as const) : ('pending' as const),
      fenceRef: complete ? `self-check:${input.attemptId}` : null,
    };
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
    const hasActiveTurn = currentTurns.some((turn) => !isSealedTurnTerminal(turn.status));
    const hasActiveLease = this.coreDb
      ? Boolean(
          this.coreDb.sqlite
            .prepare(
              `SELECT 1
               FROM scheduler_execution_attempts
               WHERE agent_session_id = ?
                 AND phase <> 'closed'
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
  ): Promise<SchedulerWorkerStorageChoice | undefined> {
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
      bindNanoHostAttemptPreparation(this.coreDb, {
        attemptId: input.attemptId,
        agentSessionId: input.prepared.agentSessionId,
        inputRef: `aepsnap_${input.preparation.turn.id}_${input.prepared.agentSessionId}`,
        bindingRef: `attempt-binding:${input.attemptId}`,
        sessionCompatibilityKey: input.prepared.sessionCompatibilityKey,
      });
      const lease = this.coreDb.sqlite
        .prepare(
          `SELECT workspace_id AS workspaceId, thread_id AS threadId,
                  agent_session_id AS agentSessionId
           FROM scheduler_execution_attempts
           WHERE attempt_id = ?
             AND phase <> 'closed'`
        )
        .get(input.attemptId) as
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
      .some((turn) => turn.agentSessionId === current.id && !isSealedTurnTerminal(turn.status));
    const hasConflictingLease = this.coreDb
      ? Boolean(
          this.coreDb.sqlite
            .prepare(
              `SELECT 1 FROM scheduler_execution_attempts
               WHERE agent_session_id = ?
                 AND phase <> 'closed'
                 AND attempt_id <> ?
               LIMIT 1`
            )
            .get(current.id, input.attemptId)
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
   * Starts one deterministic simulated Turn that completes normally, with Pending Request answers delivered on later Turns.
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
    if (this.coreDb && context.attemptId)
      context = {
        ...context,
        sandboxBindingRef: requireSchedulerExecutionAttempt(this.coreDb, context.attemptId)
          .bindingRef!,
      };
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
          'The execution attempt SessionCompatibilityKey does not match final launch inputs.',
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
      if (this.coreDb && workspaceDb && context.attemptId && context.agentSessionId)
        bindWorkerCheckpointToPreparedSession({
          coreDb: this.coreDb,
          workspaceDb,
          store,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId,
          requestId: context.requestId ?? null,
          agentSessionId: context.agentSessionId,
          attemptId: context.attemptId,
        });
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
      const captureCoverage = workspaceDb
        ? readWorkObservationTurnBinding(workspaceDb, {
            threadId: turn.threadId,
            turnId: turn.id,
          }).coverage
        : null;
      if (this.coreDb && (!captureCoverage || !context.sandboxBindingRef)) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Simulator capture admission is unavailable.',
          409
        );
      }
      const agentSessionId = context.agentSessionId ?? `session_sim_turn_${turn.id}`;
      const workerInput = workspaceDb
        ? frozenPendingOutcomeInput(workspaceDb.sqlite, turn.id, input)
        : input;
      // Delivery cause owns initiating-request identity; carried outcomes do not replace it.
      const outcomeInitiated = workspaceDb
        ? listThreadPendingRequests(workspaceDb.sqlite, turn.workspaceId, turn.threadId).some(
            (record) => record.deliveryTurnId === turn.id && record.deliveryCause === 'outcome'
          )
        : false;
      const contextRequest = outcomeInitiated ? workerInput : input;
      const preparedContext =
        this.coreDb && workspaceDb && (checkpoint || outcomeInitiated) && context.sandboxBindingRef
          ? prepareWorkerTurnContextPackage(this.coreDb, workspaceDb, store, checkpoint, {
              agentSessionId,
              requestId: context.requestId ?? null,
              threadId: turn.threadId,
              turnId: turn.id,
              workerRequest: contextRequest,
              workspaceId: turn.workspaceId,
            })
          : null;
      const environmentBackend = { kind: 'openshell' } as const;
      const resolvedEnvironmentPackage = captureCoverage
        ? resolveAgentEnvironmentPackage({
            captureCoverage,
            agentSessionId,
            agentSetup: context.agentSetup,
            backend: environmentBackend,
            coreDb: this.coreDb!,
            createdAt: timestamp,
            ...(preparedContext
              ? { preparedContextPackage: preparedContext.preparedContextPackage }
              : {}),
            requestId: context.requestId ?? null,
            turn,
            turnInput: workerInput,
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
          'The final Agent Environment Package changed the execution attempt compatibility key.',
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
        userInputRequestId: randomUUID(),
      };

      this.emitStartedEnvelope(
        store,
        state,
        agentSession,
        contextRequest,
        outcomeInitiated
          ? pendingRequestSystemActor(responsibleUserIdForActor(turn.triggerActor))
          : turn.triggerActor
      );

      if (this.coreDb && workspaceDb && environmentPackage && context.sandboxBindingRef) {
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: timestamp,
          environmentPackage,
        });
        const backendSessionId = `self-check_${environmentPackage.snapshotId}`;
        const backendLineage = workerBackendLineageFromRuntimeImage(
          environmentPackage.runtime.image
        );
        const runtimeTarget = this.coreDb.sqlite
          .prepare(`SELECT target_id AS targetId FROM nanohost_runtime_targets LIMIT 1`)
          .get() as { readonly targetId: string } | undefined;
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
          attemptId: backendSession.attemptId,
          now: () => timestamp,
          toState: 'materialized',
        });
        recordWorkspaceBackendHandoff(workspaceDb, inputSnapshots, materializationRecords);
        markWorkerBackendWorkspaceHandoffComplete(this.coreDb, {
          attemptId: backendSession.attemptId,
          now: () => timestamp,
        });
        if (preparedContext) {
          const acceptedTrace = acceptPreparedWorkerTurnContextPackage({
            coreDb: this.coreDb,
            environmentPackage,
            preparedContext,
            store,
            workspaceDb,
          });
          this.publishMaterialProposals(
            store,
            environmentPackage,
            acceptedTrace,
            workspaceDb,
            timestamp
          );
        }
        if (!context.attemptId) throw new Error('Self-check has no exact attempt identity.');
        finalizeSchedulerExecutionAttemptInput(this.coreDb, {
          attemptId: context.attemptId,
          inputRef: environmentPackage.snapshotId,
          bindingRef: context.sandboxBindingRef,
        });
        const submission = recordSchedulerExecutionOperation(this.coreDb, {
          attemptId: context.attemptId,
          operationId: commandInputHash({
            attemptId: context.attemptId,
            inputRef: environmentPackage.snapshotId,
            operation: 'submit',
          }),
          submission: true,
        });
        acceptSchedulerExecutionObservation(
          this.coreDb,
          await this.submit({
            ...schedulerExecutionCorrelation(submission),
            deadline: submission.deadline!,
          })
        );
        context.onSubmissionSettled?.();
        // This deterministic executor accepts the same frozen input at its modeled native start.
        proveFrozenDelivery(workspaceDb.sqlite, turn.id, timestamp);
        if (workerInput === input) {
          await this.emitUserInputRequest(store, state, environmentPackage, workspaceDb);
        }
        const finalTimestamp = new Date().toISOString();
        recordWorkerControlAcceptedRecord(this.coreDb, {
          acceptedAt: finalTimestamp,
          lineage: {
            agentSessionId,
            packageSnapshotId: environmentPackage.snapshotId,
            requestId: environmentPackage.scope.requestId,
            threadId: turn.threadId,
            turnId: turn.id,
            workspaceId: turn.workspaceId,
          },
          operation: 'final_status',
          record: { sequence: 1, status: 'completed', stopReason: 'completed' },
          recordKey: '1',
          sequence: 1,
        });
        markSchedulerExecutionAttemptClosing(this.coreDb, {
          attemptId: backendSession.attemptId,
          now: () => finalTimestamp,
          cause: 'worker-final-status',
        });
        transitionWorkerBackendSessionState(this.coreDb, {
          fromState: 'materialized',
          attemptId: backendSession.attemptId,
          now: () => finalTimestamp,
          toState: 'cleanup-pending',
        });
        transitionWorkerBackendSessionState(this.coreDb, {
          fromState: 'cleanup-pending',
          attemptId: backendSession.attemptId,
          now: () => finalTimestamp,
          toState: 'physical-cleaned',
        });
        projectWorkerBackendCleanup(workspaceDb, {
          agentSessionId,
          backendSessionId,
          backendType: 'openshell',
          backendVersion: null,
          completedAt: finalTimestamp,
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
          attemptId: backendSession.attemptId,
          now: () => finalTimestamp,
          toState: 'cleaned',
        });
      }

      this.emitAssistant(store, state);
      this.emitReasoning(store, state);
      this.emitCommand(store, state);
      if (workerInput !== input) {
        const outcomes = JSON.parse(workerInput).pendingOutcomes as Array<{
          answers: Record<string, string[]> | null;
        }>;
        const tone = outcomes.find((outcome) => outcome.answers?.tone)?.answers?.tone?.[0];
        if (!state.requestId) throw new Error('Simulator outcome request identity is unavailable.');
        this.emitArtifactAndComplete(store, state, tone ?? 'Concise', state.requestId);
      } else {
        if (!this.coreDb) {
          await this.emitUserInputRequest(store, state, null, null);
        }
        if (state.requestId) {
          this.emitArtifactAndComplete(store, state, 'Concise', state.requestId);
          return;
        }
        const completedAt = new Date().toISOString();
        const idleSession = store.updateAgentSession(state.agentSessionId, {
          status: 'idle',
          message: null,
          updatedAt: completedAt,
        });
        const completedTurn = store.updateTurn(state.turnId, {
          status: 'completed',
          completedAt,
        });
        this.emitTurnUpdated(store, state, completedTurn);
        this.emitAgentSessionUpdated(store, state, idleSession);
        store.emitTurnEvent(
          state.turnId,
          {
            event: 'turn.completed',
            requestId: state.requestId,
            workspaceId: state.workspaceId,
            threadId: state.threadId,
            turnId: state.turnId,
            data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
          },
          ALREADY_DECIDED_PUBLICATION_ADMISSION
        );
      }
    } finally {
      workspaceDb?.sqlite.close();
      context.onSubmissionSettled?.();
      if (
        this.coreDb &&
        context.attemptId &&
        ['completed', 'interrupted', 'cancelled'].includes(store.getTurnById(turnId).status)
      ) {
        const attempt = markSchedulerExecutionAttemptClosing(this.coreDb, {
          attemptId: context.attemptId,
          cause: `turn-${store.getTurnById(turnId).status}`,
        });
        if (attempt.operationId) {
          const correlation = schedulerExecutionCorrelation(attempt);
          const proof = {
            terminalHandoff: true,
            output: true,
            evidence: true,
            outsideWorkspaceCollection: true,
            integrationDrain: true,
            routesRevoked: true,
          } as const;
          const release = await this.release({ ...correlation, proof });
          if (release.state === 'released' && release.fenceRef)
            closeSchedulerExecutionAttemptWithFence(this.coreDb, {
              correlation,
              proof,
              fenceRef: release.fenceRef,
            });
        }
      }
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
      throw new TurnStartValidationError(
        'turn_interrupt_failed',
        `Simulator turn has no assigned AgentSession: ${turnId}`,
        404
      );
    }
    const state = {
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

    store.emitTurnEvent(
      turnId,
      {
        event: 'agent.session.updated',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId,
        data: { type: 'agent-session-updated', agentSession },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    store.emitTurnEvent(
      turnId,
      {
        event: 'turn.completed',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId,
        data: { type: 'turn-completed', stopReason: 'aborted', turn },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
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
      (turn) => !isSealedTurnTerminal(turn.status) && turn.agentSessionId
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

  /** Refuses the obsolete same-Turn response hook; question.answer owns later-Turn delivery. */
  public async respondUserInput(
    _store: FsStore,
    turnId: string,
    _answers: Record<string, [string]>,
    _context: HumanResponseCommandRuntimeContext
  ) {
    throw new Error(`Simulator user-input request is not active for turn: ${turnId}`);
  }

  /**
   * Emits turn-start, retained request input with its author, and AgentSession events.
   */
  private emitStartedEnvelope(
    store: FsStore,
    state: SimulatedTurnState,
    agentSession: ReturnType<FsStore['createAgentSession']>,
    input: string,
    actor: ActorRef
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
      actor,
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
   * Publishes two deterministic same-base Material candidates without transcript declarations.
   *
   * @param store Product store receiving canonical Artifact projections.
   * @param environmentPackage Accepted Agent Environment Package lineage.
   * @param trace Strictly accepted Context Package trace.
   * @param workspaceDb Workspace authority containing Material and Review owners.
   * @param recordedAt Stable simulator timestamp.
   */
  private publishMaterialProposals(
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
    const proposal = {
      baseContentDigest: selection.contentDigest,
      baseRevisionId: selection.revisionId,
      materialId: selection.materialId,
    };
    const candidates = [
      Buffer.from('# Simulator proposal\n\nApply the concise deterministic revision.\n', 'utf8'),
      Buffer.from('# Simulator proposal\n\nApply the detailed deterministic revision.\n', 'utf8'),
    ];
    const checkValues = createLocalSimulatorCredentialCheckValues();
    // Only this process-private, credential-free generator can supply the simulator proof.
    // Worker MCP submission still requires complete original Worker comparison evidence.
    for (const [index, bytes] of candidates.entries()) {
      const requestId = `simulator-material-${environmentPackage.snapshotId}-${index + 1}`;
      const artifactId = `worker-artifact-${createHash('sha256')
        .update(
          JSON.stringify([
            environmentPackage.snapshotId,
            environmentPackage.scope.turnId,
            requestId,
          ])
        )
        .digest('hex')}`;
      const prepared = prepareWorkerArtifact({
        store,
        workspaceDb,
        environmentPackage,
        artifactId,
        requestId,
        recordedAt,
        bytes,
        checkValues,
        contextPackageTrace: trace,
        metadata: {
          kind: 'file',
          title: `Simulator Material proposal ${index + 1}`,
          mediaType: selection.mediaType,
          materialProposal: proposal,
        },
      });
      // Rollback is valid only after all prior authority has been proved absent.
      if (preflightArtifactTuple(store, workspaceDb, prepared.artifact, prepared.reviewInput)) {
        continue;
      }
      try {
        store.createArtifact(prepared.artifact);
        createArtifactReview(workspaceDb, prepared.reviewInput);
      } catch (error) {
        store.rollbackArtifactCreation(artifactId);
        throw error;
      }
    }
  }

  /**
   * Raises the deterministic question through Worker MCP while its backend admission is active.
   *
   * @param store Product store containing the active Turn.
   * @param state Active simulator lineage.
   * @param environmentPackage Accepted worker package, absent only in standalone protocol fixtures.
   * @param workspaceDb Durable request owner, absent only in standalone protocol fixtures.
   * @throws Error when responsibility or durable Worker MCP admission is unavailable.
   */
  private async emitUserInputRequest(
    store: FsStore,
    state: SimulatedTurnState,
    environmentPackage: AgentEnvironmentPackage | null,
    workspaceDb: WorkspaceDb | null
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const responsibleUserId = responsibleUserIdForActor(
      store.getTurnById(state.turnId).triggerActor
    );
    if (responsibleUserId === null) {
      throw new Error('Simulator user-input responsibility is unavailable.');
    }
    const prompt = 'Which summary tone should the simulator use?';
    const questions = [
      {
        id: 'tone',
        header: 'Tone',
        question: prompt,
        options: null,
        isOther: false,
        isSecret: false,
      },
    ];
    let requestItem: RuntimeItem;
    if (this.coreDb) {
      if (!environmentPackage || !workspaceDb)
        throw new Error('Simulator Worker MCP admission is unavailable.');
      const result = await dispatchOpenkitWorkTool(
        {
          environmentPackage,
          coreDb: this.coreDb,
          store,
          workspaceDb,
        },
        'work_request_input',
        { requestId: state.userInputRequestId, prompt, questions }
      );
      state.userInputRequestId = result.structuredContent.requestId as string;
      const recordedItem = store
        .listThreadItems(state.workspaceId, state.threadId)
        .find(
          (item) =>
            item.type === 'user-input-request' &&
            item.userInputRequestId === state.userInputRequestId
        );
      if (!recordedItem) throw new Error('Simulator Worker MCP request Item is unavailable.');
      requestItem = recordedItem;
    } else {
      // Standalone protocol fixtures have no durable product owner or answer command.
      requestItem = store.createItem({
        id: `it_user_input_request_${state.turnId}`,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        type: 'user-input-request',
        status: 'completed',
        responsibleUserId,
        userInputRequestId: state.userInputRequestId,
        prompt,
        questions,
        createdAt: timestamp,
        completedAt: timestamp,
      });
    }
    // A repeated question returns its existing Item without publishing it on another Turn.
    if (requestItem.turnId === state.turnId) {
      this.emitItemCreated(store, state, requestItem);
      this.emitItemCompleted(store, state, requestItem);
    }
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

    store.emitTurnEvent(
      state.turnId,
      {
        event: 'artifact.created',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        data: { type: 'artifact-created', artifact },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
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
    store.emitTurnEvent(
      state.turnId,
      {
        event: 'turn.completed',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        data: { type: 'turn-completed', stopReason: 'completed', turn },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  }

  /**
   * Emits one item creation event.
   */
  private emitItemCreated(
    store: FsStore,
    state: SimulatedTurnState,
    item: ReturnType<FsStore['createItem']>
  ): void {
    store.emitTurnEvent(
      state.turnId,
      {
        event: 'item.created',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        data: { type: 'item-created', item },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
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

    store.emitTurnEvent(
      state.turnId,
      {
        event: 'item.delta',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        data,
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  }

  /**
   * Emits one item completion event.
   */
  private emitItemCompleted(store: FsStore, state: SimulatedTurnState, item: RuntimeItem): void {
    store.emitTurnEvent(
      state.turnId,
      {
        event: 'item.completed',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        data: { type: 'item-completed', itemId: item.id, item },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  }

  /**
   * Emits one turn update event.
   */
  private emitTurnUpdated(
    store: FsStore,
    state: SimulatedTurnState,
    turn: ReturnType<FsStore['updateTurn']>
  ): void {
    store.emitTurnEvent(
      state.turnId,
      {
        event: 'turn.updated',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        data: { type: 'turn-updated', turn },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  }

  /**
   * Emits one AgentSession update event.
   */
  private emitAgentSessionUpdated(
    store: FsStore,
    state: SimulatedTurnState,
    agentSession: ReturnType<FsStore['updateAgentSession']>
  ): void {
    store.emitTurnEvent(
      state.turnId,
      {
        event: 'agent.session.updated',
        requestId: state.requestId,
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        turnId: state.turnId,
        data: { type: 'agent-session-updated', agentSession },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  }
}
