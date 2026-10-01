import { randomUUID } from 'node:crypto';
import type {
  GatewayConfig,
  UserConfig,
  WorkspaceConfig,
  WorkspaceDataSourceCatalog,
  WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import { TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { AgentManifest } from '../agents/manifest.js';
import { computeReadiness, isAgentLaunchable } from '../agents/readiness.js';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  cancelSchedulerAdmissionEntry,
  completeSchedulerTurnLease,
  denySchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  findNextDispatchableSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  type SchedulerDispatchResult,
} from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import { resolveAgentSessionCompatibilityKey } from './agent-environment.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
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
import { WorkerGovernanceCapacityUnavailableError } from './worker-governance-backend.js';

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
  /**
   * Optional callback after Turn and resolved setup are durable and before executor start.
   *
   * Product callers must filter this to the exact requested admission Turn.
   */
  onTurnCreated?: (turn: z.infer<typeof TurnSchema>) => void;
  /** Reports the admission owning subsequent failures, or null during shared acquisition. */
  onDispatchAttribution?: (queueEntryId: string | null) => void;
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
 * @throws DeterministicAgentPreparationError after cancelling the exact pre-lease admission; capacity and transient dependency failures leave it queued.
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
        !currentSchedulerAdmissionWorkspaceAuthority(input.coreDb, entry, 'runtime.launch', true)
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
    input.onDispatchAttribution?.(entry.queueEntryId);
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
    const workspaceRoots = entry.workspaceRoots;
    const workspaceDataSourceCatalog = input.workspaceDataSourceCatalogs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.catalog;
    const workspaceMcpServerCatalog = input.workspaceMcpServerCatalogs?.find(
      (candidate) => candidate.workspaceId === entry.workspaceId
    )?.catalog;
    let futureTurn = TurnSchema.parse({
      completedAt: null,
      configVersion: input.configVersion ?? null,
      durationMs: null,
      error: null,
      id: entry.turnId,
      items: [],
      startedAt: timestamp,
      status: 'running',
      threadId: entry.threadId,
      triggerActor: entry.triggerActor,
      workspaceId: entry.workspaceId,
    });
    let workspaceSourceRefs: ReturnType<typeof workspaceSourceRefsFromAgentManifest>;
    let prepareInput: PrepareAgentSessionForTurnInput;
    let preparedAgentSession: PreparedAgentSessionForTurn;
    try {
      const setup = resolveDispatchAgentSetup(
        input,
        entry.requestedAgentId,
        entry.profileRef,
        entry.modelId,
        entry.workspaceId,
        workspaceConfig,
        userConfig
      );
      const reasoningEffort = entry.reasoningEffort ?? setup.manifest.models.reasoningEffort;
      futureTurn = TurnSchema.parse({
        ...futureTurn,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
      workspaceSourceRefs = workspaceSourceRefsFromAgentManifest(setup.manifest, workspaceRoots);
      prepareInput = {
        agentSetup: setup,
        freshAgentSessionId,
        requestId: entry.requestId,
        turn: futureTurn,
        turnInput: entry.turnInput,
        ...(entry.workerStorageChoice ? { workerStorageChoice: entry.workerStorageChoice } : {}),
        workspaceCwd: entry.workspaceCwd,
        workspaceRoots,
        ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
        ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
        ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
      };
      preparedAgentSession = input.turnExecutor.prepareAgentSessionForTurn
        ? await input.turnExecutor.prepareAgentSessionForTurn(input.store, prepareInput)
        : prepareFreshAgentSessionWithoutRuntimeOwner(input, prepareInput);
    } catch (error) {
      if (error instanceof WorkerGovernanceCapacityUnavailableError) {
        return {
          startedTurns,
          terminalResult: { status: 'queued', reason: 'capacity-saturated' },
        };
      }
      if (error instanceof DeterministicAgentPreparationError) {
        cancelSchedulerAdmissionEntry(input.coreDb, {
          queueEntryId: entry.queueEntryId,
          workspaceId: entry.workspaceId,
        });
      }
      throw error;
    }
    if (!currentSchedulerAdmissionWorkspaceAuthority(input.coreDb, entry, 'runtime.launch', true)) {
      return {
        startedTurns,
        terminalResult: {
          status: 'denied',
          entry: denySchedulerAdmissionEntry(input.coreDb, {
            queueEntryId: entry.queueEntryId,
            denialReason: 'policy-cap',
          }),
        },
      };
    }
    const leaseId = (input.createLeaseId ?? createLeaseId)();
    input.onDispatchAttribution?.(null);
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
    input.onDispatchAttribution?.(entry.queueEntryId);

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
      let workerStorageChoice = dispatch.entry.workerStorageChoice ?? undefined;
      if (input.turnExecutor.commitPreparedAgentSessionForTurn) {
        const committed = await input.turnExecutor.commitPreparedAgentSessionForTurn(store, {
          leaseId: dispatch.lease.leaseId,
          prepared: preparedAgentSession,
          preparation: prepareInput,
        });
        if (committed) {
          workerStorageChoice = committed;
        }
      } else if (preparedAgentSession.replacementRequired) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The runtime cannot commit prepared AgentSession replacement.',
          409
        );
      }
      if (
        !currentSchedulerAdmissionWorkspaceAuthority(
          input.coreDb,
          dispatch.entry,
          'runtime.launch',
          true
        )
      ) {
        throw new TurnStartValidationError(
          'workspace_access_denied',
          'Workspace access denied.',
          403
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
          ...(futureTurn.reasoningEffort !== undefined
            ? { reasoningEffort: futureTurn.reasoningEffort }
            : {}),
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
          ...(workerStorageChoice ? { workerStorageChoice } : {}),
          workspaceId: dispatch.entry.workspaceId,
          ...(workspaceConfig ? { workspaceConfig } : {}),
          ...(userConfig ? { userConfig } : {}),
          workspaceRoots: dispatch.entry.workspaceRoots,
          ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
          ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
          ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
          ...(input.configVersion !== undefined ? { configVersion: input.configVersion } : {}),
          ...(input.dependencies ? { dependencies: input.dependencies } : {}),
          ...(input.onTurnCreated ? { onTurnCreated: input.onTurnCreated } : {}),
        });
        startedTurns.push({ dispatch, handle });
      } finally {
        agentSetupWorkspaceDb.sqlite.close();
      }
    } catch (error) {
      completeSchedulerTurnLease(input.coreDb, {
        workspaceId: dispatch.entry.workspaceId,
        threadId: dispatch.entry.threadId,
        turnId: dispatch.entry.turnId,
        recoveryState: 'needs-evidence',
        releaseReason: 'turn-start-failed',
        terminalStatus: 'failed',
      });
      throw error;
    }
  }

  return { startedTurns, terminalResult: { status: 'queued', reason: 'max-dispatches' } };
}

/**
 * Resolves the exact authored setup needed by pre-lease static AEP planning.
 *
 * @throws DeterministicAgentPreparationError for input-bound composition diagnostics; missing model-catalog dependencies retain the existing retry behavior.
 */
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
    const message =
      resolved.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ||
      `Agent ${requestedAgentId} setup is unavailable.`;
    // Classify only known input-bound diagnostics; new or missing dependency failures stay queued.
    if (
      resolved.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'agent_setup.invalid_default_profile' ||
          diagnostic.code === 'agent_setup.duplicate_credential_requirement' ||
          diagnostic.code === 'agent_setup.missing_credential_binding' ||
          diagnostic.code === 'agent_setup.logical_model_not_allowed' ||
          diagnostic.code === 'agent_setup.unsupported_required_feature'
      )
    ) {
      throw new DeterministicAgentPreparationError(message, 'agent_not_ready', 409);
    }
    throw new TurnStartValidationError('agent_not_ready', message, 409);
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
