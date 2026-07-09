import { randomUUID } from 'node:crypto';
import {
  type AgentSessionContinuitySelectionResult,
  type LiveSessionCandidate,
  type ResumeHandleCandidate,
  type SnapshotCandidate,
  selectAgentSessionContinuity,
} from '../agent-session-continuity.js';
import type { AgentManifest, AuthoredAgentConfig } from '../agents/manifest.js';
import type { FsStore } from '../lib/store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  completeSchedulerSessionLease,
  dispatchNextSchedulerEntry,
  type SchedulerAdmissionEntryRecord,
  type SchedulerDispatchResult,
} from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { type StartTurnDependencies, startTurn, type TurnHandle } from './orchestrator.js';
import { generateUuidV7 } from './session-id.js';
import type { TurnExecutor } from './types.js';

/** Input for one scheduler dispatch loop run. */
export interface RunSchedulerDispatchLoopInput {
  /** Available agent configs used by start-turn orchestration. */
  agentConfigs?: AuthoredAgentConfig[];
  /** Available agent manifests used by start-turn orchestration. */
  agentManifests: AgentManifest[];
  /** Open Core database handle. */
  coreDb: CoreDb;
  /** Deterministic agent-session id factory for tests. */
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
  /** Scheduler epoch recorded on placement and lease records. */
  schedulerEpoch: number;
  /** Session workspace compatibility digest used by future reuse gates. */
  sessionCompatibilityKey?: string | null;
  /** Optional continuity candidates used by strict V1 session selection. */
  sessionContinuityCandidates?: SchedulerDispatchSessionContinuityCandidates;
  /** Startup timeout in milliseconds. */
  startupTimeoutMs: number;
  /** File-backed product store. */
  store: FsStore;
  /** Optional store selector for multi-user queued admissions. */
  storeForEntry?: (entry: SchedulerAdmissionEntryRecord) => FsStore;
  /** Runtime executor used to start worker turns. */
  turnExecutor: TurnExecutor;
  /** Runtime config snapshot version captured for started turns. */
  configVersion?: number | null;
  /** Materialized workspace roots captured for started turns. */
  workspaceRoots?: Parameters<typeof startTurn>[0]['workspaceRoots'];
  /** Optional workspace data source catalog captured for sourceRef-backed roots. */
  workspaceDataSourceCatalog?: Parameters<typeof startTurn>[0]['workspaceDataSourceCatalog'];
  /** Optional root-id to sourceRef bindings captured for sourceRef-backed roots. */
  workspaceSourceRefs?: Parameters<typeof startTurn>[0]['workspaceSourceRefs'];
  /** Host-local working directory selected for started workers. */
  workspaceCwd?: string | null;
}

/** One turn started by a scheduler dispatch loop run. */
export interface SchedulerDispatchLoopStartedTurn {
  /** Dispatch result that acquired the lease. */
  dispatch: Extract<SchedulerDispatchResult, { status: 'dispatched' }>;
  /** Strict V1 continuity selection used for this dispatch. */
  continuity: AgentSessionContinuitySelectionResult;
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

/** Candidate sets used by strict V1 scheduler session selection. */
export interface SchedulerDispatchSessionContinuityCandidates {
  /** Reusable live session candidates. */
  readonly liveSessions?: readonly LiveSessionCandidate[];
  /** Resume-handle candidates. */
  readonly resumeHandles?: readonly ResumeHandleCandidate[];
  /** Snapshot candidates. */
  readonly snapshots?: readonly SnapshotCandidate[];
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
    const leaseId = (input.createLeaseId ?? createLeaseId)();
    const continuity = selectDispatchContinuity(input);
    const agentSessionId =
      selectedContinuityAgentSessionId(continuity) ??
      (input.createAgentSessionId ?? generateUuidV7)();
    const dispatch = dispatchNextSchedulerEntry(input.coreDb, {
      agentSessionId,
      expectedControlMode: input.expectedControlMode,
      expectedDataPlaneMode: input.expectedDataPlaneMode,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      heartbeatTimeoutMs: input.heartbeatTimeoutMs,
      leaseDurationMs: input.leaseDurationMs,
      leaseId,
      planId: (input.createPlanId ?? createPlanId)(),
      sandboxBindingRef: `lease-binding:${leaseId}`,
      schedulerEpoch: input.schedulerEpoch,
      sessionCompatibilityKey: input.sessionCompatibilityKey ?? null,
      startupTimeoutMs: input.startupTimeoutMs,
      ...(input.now ? { now: input.now } : {}),
    });

    if (dispatch.status !== 'dispatched') {
      return { startedTurns, terminalResult: dispatch };
    }

    try {
      const store = input.storeForEntry?.(dispatch.entry) ?? input.store;
      const agentSetupWorkspaceDb = input.agentConfigs
        ? openWorkspaceDb(input.coreDb.dataRoot, dispatch.entry.userId, dispatch.entry.workspaceId)
        : null;
      if (agentSetupWorkspaceDb) {
        applyScopedMigrations(agentSetupWorkspaceDb);
      }
      try {
        const handle = await startTurn({
          agentId: dispatch.entry.requestedAgentId,
          agentManifests: input.agentManifests,
          ...(agentSetupWorkspaceDb ? { agentSetupWorkspaceDb } : {}),
          agentSessionId: dispatch.lease.agentSessionId,
          input: dispatch.entry.turnInput,
          providerRegistry: input.providerRegistry,
          requestId: dispatch.entry.requestId,
          sandboxBindingRef: dispatch.lease.sandboxBindingRef,
          store,
          threadId: dispatch.entry.threadId,
          turnExecutor: input.turnExecutor,
          turnId: dispatch.entry.turnId,
          workspaceCwd: dispatch.entry.workspaceCwd ?? input.workspaceCwd ?? null,
          workspaceId: dispatch.entry.workspaceId,
          workspaceRoots:
            dispatch.entry.workspaceRoots.length > 0
              ? dispatch.entry.workspaceRoots
              : (input.workspaceRoots ?? []),
          ...(input.workspaceDataSourceCatalog
            ? { workspaceDataSourceCatalog: input.workspaceDataSourceCatalog }
            : {}),
          ...(input.workspaceSourceRefs ? { workspaceSourceRefs: input.workspaceSourceRefs } : {}),
          ...(input.agentConfigs ? { agentConfigs: input.agentConfigs } : {}),
          ...(input.configVersion !== undefined ? { configVersion: input.configVersion } : {}),
          ...(input.dependencies ? { dependencies: input.dependencies } : {}),
        });
        startedTurns.push({ continuity, dispatch, handle });
      } finally {
        agentSetupWorkspaceDb?.sqlite.close();
      }
    } catch (error) {
      completeSchedulerSessionLease(input.coreDb, {
        leaseId: dispatch.lease.leaseId,
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
 * Selects continuity for one dispatch attempt.
 *
 * @param input Dispatch loop input.
 * @returns Strict V1 continuity selection.
 */
function selectDispatchContinuity(
  input: RunSchedulerDispatchLoopInput
): AgentSessionContinuitySelectionResult {
  if (!input.sessionCompatibilityKey) {
    return { rejectedCandidates: [], selected: { kind: 'fresh-session' } };
  }

  return selectAgentSessionContinuity({
    liveSessions: input.sessionContinuityCandidates?.liveSessions ?? [],
    now: input.now?.() ?? new Date().toISOString(),
    requestedCompatibilityKey: input.sessionCompatibilityKey,
    resumeHandles: input.sessionContinuityCandidates?.resumeHandles ?? [],
    snapshots: input.sessionContinuityCandidates?.snapshots ?? [],
  });
}

/**
 * Returns the selected reusable agent session id, when the selected path reuses one.
 *
 * @param continuity Continuity selection result.
 * @returns Existing agent session id or null when a new session is required.
 */
function selectedContinuityAgentSessionId(
  continuity: AgentSessionContinuitySelectionResult
): string | null {
  if (continuity.selected.kind === 'live-session' || continuity.selected.kind === 'resume-handle') {
    return continuity.selected.agentSessionId;
  }
  return null;
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
