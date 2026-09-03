import { randomUUID } from 'node:crypto';
import type {
  GatewayConfig,
  UserConfig,
  WorkspaceConfig,
  WorkspaceDataSourceCatalog,
  WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import { TurnSchema } from '@openkit/protocol';
import type { AgentManifest } from '../agents/manifest.js';
import { computeReadiness, isAgentLaunchable } from '../agents/readiness.js';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  completeSchedulerTurnLease,
  denySchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  findNextDispatchableSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerSessionLease,
  requireSchedulerSessionLeaseAdmissionContext,
  type SchedulerDispatchResult,
} from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import { resolveAgentSessionCompatibilityKey } from './agent-environment.js';
import {
  type StartTurnDependencies,
  startTurn,
  type TurnHandle,
  TurnStartValidationError,
  workspaceSourceRefsFromAgentManifest,
} from './orchestrator.js';
import { generateUuidV7 } from './session-id.js';
import type {
  PrepareAgentSessionForTurnInput,
  PreparedAgentSessionForTurn,
  TurnExecutor,
} from './types.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';

/** Input for one scheduler dispatch loop run. */
export interface RunSchedulerDispatchLoopInput {
  /** Available agent manifests used by start-turn orchestration. */
  agentManifests: AgentManifest[];
  /** Open Core database handle. */
  coreDb: CoreDb;
  /** Deterministic AgentSession id factory for tests. */
  createAgentSessionId?: () => string;
  /** Deterministic lease id factory for tests. */
  createLeaseId?: () => string;
  /** Deterministic plan id factory for tests. */
  createPlanId?: () => string;
  /** Optional orchestration dependencies. */
  dependencies?: StartTurnDependencies;
  /** Expected worker control mode for placement plans. */
  expectedControlMode: string;
  /** Expected worker data-plane mode for placement plans. */
  expectedDataPlaneMode: string;
  /** Heartbeat interval in milliseconds. */
  heartbeatIntervalMs: number;
  /** Heartbeat timeout in milliseconds. */
  heartbeatTimeoutMs: number;
  /** Lease duration in milliseconds. */
  leaseDurationMs: number;
  /** Maximum turns to dispatch in this loop run. */
  maxDispatches?: number;
  /** Optional deterministic clock. */
  now?: () => string;
  /** Provider registry used by start-turn orchestration. */
  providerRegistry: ProviderRegistry;
  /** Gateway logical model catalog used by setup composition. */
  gatewayConfig: GatewayConfig;
  /** Workspace Agent composition inventory used by setup resolution. */
  workspaceConfigs?: readonly { workspaceId: string; config: WorkspaceConfig }[];
  /** Personal Agent preference inventory used by setup resolution. */
  userConfigs?: readonly { userId: string; config: UserConfig }[];
  /** Scheduler epoch recorded on placement and lease records. */
  schedulerEpoch: number;
  /** Startup timeout in milliseconds. */
  startupTimeoutMs: number;
  /** File-backed product store. */
  store: FsStore;
  /** Runtime executor used to start worker turns. */
  turnExecutor: TurnExecutor;
  /** Runtime config snapshot version captured for started turns. */
  configVersion?: number | null;
  /** Workspace data source catalogs available for queued turns. */
  workspaceDataSourceCatalogs?: readonly {
    readonly workspaceId: string;
    readonly catalog: WorkspaceDataSourceCatalog;
  }[];
  /** Workspace MCP server catalogs available for queued turns. */
  workspaceMcpServerCatalogs?: readonly {
    readonly workspaceId: string;
    readonly catalog: WorkspaceMcpServerCatalog;
  }[];
}

/** One turn started by a scheduler dispatch loop run. */
export interface SchedulerDispatchLoopStartedTurn {
  /** Dispatch result that acquired the lease. */
  dispatch: Extract<SchedulerDispatchResult, { status: 'dispatched' }>;
  /** Start-turn handle returned by the orchestrator. */
  handle: TurnHandle;
}

/** Result of one scheduler dispatch loop run. */
export interface SchedulerDispatchLoopResult {
  /** Started turns in dispatch order. */
  startedTurns: SchedulerDispatchLoopStartedTurn[];
  /** Result that stopped the loop. */
  terminalResult: Exclude<SchedulerDispatchResult, { status: 'dispatched' }> | LoopLimitResult;
}

interface LoopLimitResult {
  /** Loop stopped because it reached maxDispatches. */
  readonly status: 'queued';
  /** Stable loop stop reason. */
  readonly reason: 'max-dispatches';
}

/**
 * Dispatches queued scheduler entries and starts their worker turns through the normal orchestrator.
 *
 * @param input Dispatch loop input.
 * @returns Started turns plus the result that stopped this loop run.
 */
export async function runSchedulerDispatchLoop(
  input: RunSchedulerDispatchLoopInput
): Promise<SchedulerDispatchLoopResult> {
  const maxDispatches = input.maxDispatches ?? 1;
  const startedTurns: SchedulerDispatchLoopStartedTurn[] = [];

  while (startedTurns.length < maxDispatches) {
    const queuedEntries = listQueuedSchedulerAdmissionEntries(input.coreDb);
    const staleEntry = queuedEntries.find(
      (entry) =>
        !currentWorkspaceAuthority(
          input.coreDb,
          entry.workspaceId,
          entry.triggerActor,
          'runtime.launch',
          true
        )
    );
    if (staleEntry) {
      return {
        startedTurns,
        terminalResult: {
          status: 'denied',
          entry: denySchedulerAdmissionEntry(input.coreDb, {
            queueEntryId: staleEntry.queueEntryId,
            denialReason: 'policy-cap',
          }),
        },
      };
    }
    const entry = findNextDispatchableSchedulerAdmissionEntry(input.coreDb);
    if (!entry) {
      return {
        startedTurns,
        terminalResult: {
          status: 'queued',
          reason: queuedEntries.length === 0 ? 'no-queued-entry' : 'thread-busy',
        },
      };
    }
    const freshAgentSessionId = (input.createAgentSessionId ?? generateUuidV7)();
    const timestamp = input.now?.() ?? new Date().toISOString();
    const responsibleUserId =
      entry.triggerActor.kind === 'user'
        ? entry.triggerActor.id
        : entry.triggerActor.responsibleUserId;
    const workspaceConfig = input.workspaceConfigs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.config;
    const userConfig = input.userConfigs?.find(
      (candidate) => candidate.userId === responsibleUserId
    )?.config;
    const setup = resolveDispatchAgentSetup(
      input,
      entry.requestedAgentId,
      entry.profileRef,
      entry.modelId,
      entry.workspaceId,
      workspaceConfig,
      userConfig
    );
    const workspaceRoots = entry.workspaceRoots;
    const workspaceDataSourceCatalog = input.workspaceDataSourceCatalogs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.catalog;
    const workspaceMcpServerCatalog = input.workspaceMcpServerCatalogs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.catalog;
    const workspaceSourceRefs = workspaceSourceRefsFromAgentManifest(
      setup.manifest,
      workspaceRoots
    );
    const futureTurn = TurnSchema.parse({
      completedAt: null,
      configVersion: input.configVersion ?? null,
      durationMs: null,
      error: null,
      humanGate: null,
      id: entry.turnId,
      items: [],
      startedAt: timestamp,
      status: 'running',
      threadId: entry.threadId,
      triggerActor: entry.triggerActor,
      workspaceId: entry.workspaceId,
    });
    const prepareInput = {
      agentSetup: setup,
      freshAgentSessionId,
      requestId: entry.requestId,
      turn: futureTurn,
      turnInput: entry.turnInput,
      workspaceCwd: entry.workspaceCwd,
      workspaceRoots,
      ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
      ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
      ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
    };
    const preparedAgentSession = input.turnExecutor.prepareAgentSessionForTurn
      ? await input.turnExecutor.prepareAgentSessionForTurn(input.store, prepareInput)
      : prepareFreshAgentSessionWithoutRuntimeOwner(input, prepareInput);
    const leaseId = (input.createLeaseId ?? createLeaseId)();
    const dispatch = dispatchNextSchedulerEntry(input.coreDb, {
      agentSessionId: preparedAgentSession.agentSessionId,
      expectedControlMode: input.expectedControlMode,
      expectedDataPlaneMode: input.expectedDataPlaneMode,
      expectedQueueEntryId: entry.queueEntryId,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      heartbeatTimeoutMs: input.heartbeatTimeoutMs,
      leaseDurationMs: input.leaseDurationMs,
      leaseId,
      planId: (input.createPlanId ?? createPlanId)(),
      sandboxBindingRef: `lease-binding:${leaseId}`,
      schedulerEpoch: input.schedulerEpoch,
      sessionCompatibilityKey: preparedAgentSession.sessionCompatibilityKey,
      startupTimeoutMs: input.startupTimeoutMs,
      ...(input.now ? { now: input.now } : {}),
    });

    if (dispatch.status !== 'dispatched') {
      return { startedTurns, terminalResult: dispatch };
    }

    const store = input.store;
    try {
      if (
        dispatch.entry.queueEntryId !== entry.queueEntryId ||
        dispatch.lease.agentSessionId !== preparedAgentSession.agentSessionId ||
        dispatch.lease.sessionCompatibilityKey !== preparedAgentSession.sessionCompatibilityKey
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Scheduler dispatch changed the prepared AgentSession lineage.',
          409
        );
      }
      if (input.turnExecutor.commitPreparedAgentSessionForTurn) {
        await input.turnExecutor.commitPreparedAgentSessionForTurn(store, {
          leaseId: dispatch.lease.leaseId,
          prepared: preparedAgentSession,
          preparation: prepareInput,
        });
      } else if (preparedAgentSession.replacementRequired) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The runtime cannot commit prepared AgentSession replacement.',
          409
        );
      }
      const agentSetupWorkspaceDb = openWorkspaceDb(
        input.coreDb.dataRoot,
        dispatch.entry.workspaceId
      );
      applyScopedMigrations(agentSetupWorkspaceDb);
      try {
        const handle = await startTurn({
          agentId: dispatch.entry.requestedAgentId,
          agentManifests: input.agentManifests,
          agentSetupWorkspaceDb,
          agentSessionId: dispatch.lease.agentSessionId,
          gatewayConfig: input.gatewayConfig,
          input: dispatch.entry.turnInput,
          modelId: dispatch.entry.modelId,
          profileId: dispatch.entry.profileRef,
          providerRegistry: input.providerRegistry,
          requestId: dispatch.entry.requestId,
          sandboxBindingRef: dispatch.lease.sandboxBindingRef,
          sessionCompatibilityKey: preparedAgentSession.sessionCompatibilityKey,
          store,
          threadId: dispatch.entry.threadId,
          triggerActor: dispatch.entry.triggerActor,
          turnExecutor: input.turnExecutor,
          turnId: dispatch.entry.turnId,
          workspaceCwd: dispatch.entry.workspaceCwd,
          workspaceId: dispatch.entry.workspaceId,
          ...(workspaceConfig ? { workspaceConfig } : {}),
          ...(userConfig ? { userConfig } : {}),
          workspaceRoots: dispatch.entry.workspaceRoots,
          ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
          ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
          ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
          ...(input.configVersion !== undefined ? { configVersion: input.configVersion } : {}),
          ...(input.dependencies ? { dependencies: input.dependencies } : {}),
        });
        startedTurns.push({ dispatch, handle });
      } finally {
        agentSetupWorkspaceDb.sqlite.close();
      }
    } catch (error) {
      const humanGateFallback = isExactUnavailableHumanGateCloseout(
        input.coreDb,
        dispatch,
        store,
        error
      );
      completeSchedulerTurnLease(input.coreDb, {
        workspaceId: dispatch.entry.workspaceId,
        threadId: dispatch.entry.threadId,
        turnId: dispatch.entry.turnId,
        recoveryState: 'needs-evidence',
        releaseReason: humanGateFallback ? 'worker-human-gate-unavailable' : 'turn-start-failed',
        terminalStatus: humanGateFallback ? 'released' : 'failed',
      });
      throw error;
    }
  }

  return { startedTurns, terminalResult: { status: 'queued', reason: 'max-dispatches' } };
}

/**
 * Proves the bounded AEP fallback from existing Product, scheduler, backend, and worker owners.
 *
 * @param coreDb Open Core database handle.
 * @param dispatch Exact admission, plan, and lease dispatched by this loop iteration.
 * @param store Shared product store containing the dispatched Turn.
 * @param error Typed recovery failure returned after Product interruption.
 * @returns Whether scheduler capacity can be released without claiming recoverable completion.
 */
function isExactUnavailableHumanGateCloseout(
  coreDb: CoreDb,
  dispatch: Extract<SchedulerDispatchResult, { status: 'dispatched' }>,
  store: FsStore,
  error: unknown
): boolean {
  if (
    !(error instanceof TurnStartValidationError) ||
    error.code !== 'recovery_required' ||
    error.status !== 409
  ) {
    return false;
  }

  try {
    const lease = requireSchedulerSessionLease(coreDb, dispatch.lease.leaseId);
    const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, lease.leaseId);
    const backendSession = getWorkerBackendSession(coreDb, lease.leaseId);
    const accepted = getWorkerControlAcceptedFinalStatus(coreDb, {
      agentSessionId: lease.agentSessionId,
      packageSnapshotId: lease.packageSnapshotId,
      requestId: admission.requestId,
      threadId: lease.threadId,
      turnId: lease.turnId,
      workspaceId: lease.workspaceId,
    });
    const turn = store.getTurnById(lease.turnId);
    const agentSession = store.getAgentSession(lease.agentSessionId);

    return (
      lease.planId === dispatch.plan.planId &&
      lease.workspaceId === dispatch.entry.workspaceId &&
      lease.threadId === dispatch.entry.threadId &&
      lease.turnId === dispatch.entry.turnId &&
      lease.agentSessionId === dispatch.lease.agentSessionId &&
      lease.packageSnapshotId === dispatch.lease.packageSnapshotId &&
      lease.status === 'releasing' &&
      lease.releaseReason === 'worker-final-status' &&
      admission.requestId === dispatch.entry.requestId &&
      turn.workspaceId === lease.workspaceId &&
      turn.threadId === lease.threadId &&
      turn.agentSessionId === lease.agentSessionId &&
      turn.status === 'interrupted' &&
      turn.error?.code === 'worker_human_gate_unavailable' &&
      turn.error.message === error.message &&
      agentSession.workspaceId === lease.workspaceId &&
      agentSession.threadId === lease.threadId &&
      agentSession.status === 'interrupted' &&
      agentSession.message === error.message &&
      backendSession?.leaseId === lease.leaseId &&
      backendSession.workspaceId === lease.workspaceId &&
      backendSession.threadId === lease.threadId &&
      backendSession.turnId === lease.turnId &&
      backendSession.agentSessionId === lease.agentSessionId &&
      backendSession.packageSnapshotId === lease.packageSnapshotId &&
      backendSession.state === 'cleaned' &&
      accepted?.status === 'blocked' &&
      accepted.stopReason === 'ask_user'
    );
  } catch {
    return false;
  }
}

/** Resolves the exact authored setup needed by pre-lease static AEP planning. */
function resolveDispatchAgentSetup(
  input: RunSchedulerDispatchLoopInput,
  requestedAgentId: string,
  profileId: string | null,
  modelId: string | null,
  workspaceId: string,
  workspaceConfig: WorkspaceConfig | undefined,
  userConfig: UserConfig | undefined
) {
  const manifest = input.agentManifests.find((candidate) => candidate.id === requestedAgentId);
  if (!manifest) {
    throw new TurnStartValidationError(
      'agent_not_found',
      `Agent not found: ${requestedAgentId}.`,
      409
    );
  }
  const readiness = computeReadiness(manifest);
  if (!isAgentLaunchable(readiness)) {
    throw new TurnStartValidationError(
      'agent_not_ready',
      `Agent ${requestedAgentId} readiness is ${readiness.status}.`,
      409
    );
  }
  const resolved = resolveAgentSetup(manifest, {
    gatewayConfig: input.gatewayConfig,
    providerRegistry: input.providerRegistry,
    selectedProfileId: profileId,
    requestedLogicalModelId: modelId,
    workspaceId,
    ...(workspaceConfig ? { workspaceConfig } : {}),
    ...(userConfig ? { userConfig } : {}),
  });
  if (!resolved.setup || resolved.diagnostics.length > 0) {
    throw new TurnStartValidationError(
      'agent_not_ready',
      resolved.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ||
        `Agent ${requestedAgentId} setup is unavailable.`,
      409
    );
  }
  return resolved.setup;
}

/**
 * Prepares a fresh AgentSession only when no current runtime-owned continuity needs inspection.
 */
function prepareFreshAgentSessionWithoutRuntimeOwner(
  input: RunSchedulerDispatchLoopInput,
  preparation: PrepareAgentSessionForTurnInput
): PreparedAgentSessionForTurn {
  const current = input.store
    .listThreadAgentSessions(preparation.turn.workspaceId, preparation.turn.threadId)
    .find((candidate) => isCurrentAgentSessionStatus(candidate.status));
  if (current) {
    throw new TurnStartValidationError(
      'recovery_required',
      'The current AgentSession requires runtime-owned reuse or replacement preparation.',
      409
    );
  }
  return {
    agentSessionId: preparation.freshAgentSessionId,
    currentAgentSession: null,
    replacementRequired: false,
    sessionCompatibilityKey: resolveAgentSessionCompatibilityKey({
      agentSessionId: preparation.freshAgentSessionId,
      agentSetup: preparation.agentSetup,
      backend: { kind: 'openshell' },
      coreDb: input.coreDb,
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
    }),
  };
}

/**
 * Creates a placement plan id.
 *
 * @returns Stable plan id.
 */
function createPlanId(): string {
  return `plan_${randomUUID()}`;
}

/**
 * Creates a scheduler lease id.
 *
 * @returns Stable lease id.
 */
function createLeaseId(): string {
  return `lease_${randomUUID()}`;
}
