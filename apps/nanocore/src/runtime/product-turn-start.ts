import { createHash } from 'node:crypto';

import type { SubmitTurnInputRequestSchema } from '@openkit/protocol';
import type { z } from 'zod';

import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import {
  CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS,
  CONFIGURED_WORKER_STARTUP_TIMEOUT_MS,
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  ensureConfiguredSchedulerBaseline,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { resolveModelAgentOverride, TurnStartValidationError } from './orchestrator.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import {
  materializeWorkspaceRootsForTurn,
  resolveWorkspaceRepositoryForTurn,
  workspaceSourceContextForTurn,
} from './turn-workspace-context.js';
import type { TurnExecutor } from './types.js';

/** Product turn inputs needed for scheduler admission and worker startup. */
interface StartProductTurnInput {
  /** Required Core database for durable scheduler admission and placement. */
  readonly coreDb?: CoreDb;
  /** Parsed protocol turn-start request. */
  readonly input: Extract<z.infer<typeof SubmitTurnInputRequestSchema>, { input: string }>;
  /** Runtime config snapshot captured for this turn. */
  readonly snapshot: RuntimeConfigSnapshot;
  /** Scheduler epoch owned by this process. */
  readonly schedulerEpoch: number;
  /** Actor-scoped store. */
  readonly store: FsStore;
  /** Runtime executor used to start worker turns. */
  readonly turnExecutor: TurnExecutor;
  /** Configured disposable Cell placement. */
  readonly workerPlacement: 'local' | 'remote';
  /** Optional worker id selected by an upper-level coordinator. */
  readonly requestedAgentId?: string | null;
  /** Optional turn id reserved by an upper-level worker loop. */
  readonly reservedTurnId?: string;
  /** Whether a synchronous caller should cancel its admission when dispatch is deferred. */
  readonly cancelDeferredAdmission?: boolean;
}

/**
 * Starts a new product turn through the durable scheduler.
 *
 * @param input Product turn startup input.
 * @returns Accepted turn handle.
 * @throws TurnStartValidationError when repository, model, scheduler, or dispatch validation fails.
 */
export async function startProductTurn(input: StartProductTurnInput) {
  const repository = resolveWorkspaceRepositoryForTurn(
    input.coreDb,
    input.input.workspaceId,
    input.store.getUserId()
  );
  const workspaceRoots = materializeWorkspaceRootsForTurn(
    input.snapshot,
    input.store,
    input.input.workspaceId,
    repository
  );
  const workspaceSourceContext = workspaceSourceContextForTurn(
    input.coreDb,
    input.snapshot,
    input.store,
    input.input.workspaceId,
    repository,
    workspaceRoots
  );
  const requestedAgentId =
    input.requestedAgentId ??
    resolveModelAgentOverride(input.store, input.input.workspaceId, input.input.modelId) ??
    input.store.getWorkspace(input.input.workspaceId).defaults?.defaultAgentId ??
    'agent_codex_host';

  if (!input.coreDb) {
    throw new TurnStartValidationError(
      'scheduler_unavailable',
      'Durable scheduler storage is required to start product turns.',
      503
    );
  }

  const suffix = schedulerAdmissionIdSuffix(
    input.store.getUserId(),
    input.input.workspaceId,
    input.input.threadId,
    input.input.requestId,
    input.reservedTurnId
  );
  const queueEntryId = `queue_${input.input.requestId}_${suffix}`;
  const turnId = input.reservedTurnId ?? `turn_${input.input.requestId}_${suffix}`;

  ensureConfiguredSchedulerBaseline(input.coreDb, { placement: input.workerPlacement });
  createSchedulerAdmissionEntry(input.coreDb, {
    priorityClass: 'interactive',
    profileRef: requestedAgentId,
    queueEntryId,
    requestId: input.input.requestId,
    requestedAgentId,
    requiredPoolConstraints: [`openshell.${input.workerPlacement}`],
    threadId: input.input.threadId,
    turnId,
    turnInput: input.input.input,
    userId: input.store.getUserId(),
    workspaceCwd: repository?.localPath ?? null,
    workspaceId: input.input.workspaceId,
    workspaceRoots,
  });

  const dispatch = await runSchedulerDispatchLoop({
    agentConfigs: input.snapshot.agentConfigs,
    agentManifests: input.snapshot.agentManifests,
    coreDb: input.coreDb,
    createAgentSessionId: () => `as_${suffix}`,
    createLeaseId: () => `lease_${suffix}`,
    createPlanId: () => `plan_${suffix}`,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS,
    maxDispatches: 1,
    providerRegistry: input.snapshot.providerRegistry,
    schedulerEpoch: input.schedulerEpoch,
    startupTimeoutMs: CONFIGURED_WORKER_STARTUP_TIMEOUT_MS,
    store: input.store,
    turnExecutor: input.turnExecutor,
    configVersion: input.snapshot.version,
    workspaceCwd: repository?.localPath ?? null,
    workspaceRoots,
    ...(workspaceSourceContext.workspaceDataSourceCatalog
      ? { workspaceDataSourceCatalog: workspaceSourceContext.workspaceDataSourceCatalog }
      : {}),
    ...(workspaceSourceContext.workspaceSourceRefs
      ? { workspaceSourceRefs: workspaceSourceContext.workspaceSourceRefs }
      : {}),
  });
  const started = dispatch.startedTurns.find(
    (turn) => turn.dispatch.entry.queueEntryId === queueEntryId
  );

  if (!started) {
    if (input.cancelDeferredAdmission) {
      cancelSchedulerAdmissionEntry(input.coreDb, {
        queueEntryId,
        userId: input.store.getUserId(),
        workspaceId: input.input.workspaceId,
      });
    }

    throw new TurnStartValidationError(
      'scheduler_admission_deferred',
      'Turn was queued but not dispatched in this scheduler iteration.',
      409
    );
  }

  return started.handle;
}

/**
 * Creates a server-scope scheduler id suffix for one product turn admission.
 *
 * @param userId Actor user id.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Request id.
 * @param reservedTurnId Optional upper-level Turn owner included in scheduler lineage.
 * @returns Stable short id suffix.
 */
function schedulerAdmissionIdSuffix(
  userId: string,
  workspaceId: string,
  threadId: string,
  requestId: string,
  reservedTurnId?: string
): string {
  return createHash('sha256')
    .update(
      `${userId}:${workspaceId}:${threadId}:${requestId}${
        reservedTurnId ? `:${reservedTurnId}` : ''
      }`
    )
    .digest('hex')
    .slice(0, 16);
}
