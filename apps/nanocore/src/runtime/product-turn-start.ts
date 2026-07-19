import { createHash } from 'node:crypto';

import type { ActorRef, SubmitTurnInputRequestSchema } from '@openkit/protocol';
import type { z } from 'zod';
import { selectAgent } from '../agents/selector.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type { ProviderCredentialResolver } from '../providers/registry.js';
import {
  CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS,
  CONFIGURED_WORKER_STARTUP_TIMEOUT_MS,
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  ensureConfiguredSchedulerBaseline,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import {
  assertAgentManifestSupportsModel,
  resolveModelAgentOverride,
  TurnStartValidationError,
} from './orchestrator.js';
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
  /** Exact actor that triggered this scheduler admission. */
  readonly triggerActor: ActorRef;
  /** Resolver used to prove provider profile credentials before worker admission. */
  readonly providerCredentialResolver: ProviderCredentialResolver;
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
  if (!input.coreDb) {
    throw new TurnStartValidationError(
      'scheduler_unavailable',
      'Durable scheduler storage is required to start product turns.',
      503
    );
  }

  const canonicalTriggerActor: ActorRef =
    input.triggerActor.kind === 'user'
      ? { kind: 'user', id: input.triggerActor.id }
      : {
          kind: input.triggerActor.kind,
          id: input.triggerActor.id,
          responsibleUserId: input.triggerActor.responsibleUserId,
        };
  if (
    !currentWorkspaceAuthority(
      input.coreDb,
      input.input.workspaceId,
      canonicalTriggerActor,
      'runtime.launch',
      true
    )
  ) {
    throw new TurnStartValidationError('workspace_access_denied', 'Workspace access denied.', 403);
  }

  const repository = resolveWorkspaceRepositoryForTurn(input.coreDb, input.input.workspaceId);
  const workspaceRoots = materializeWorkspaceRootsForTurn(
    input.snapshot,
    input.store,
    input.input.workspaceId,
    repository
  );
  const workspaceSourceContext = workspaceSourceContextForTurn(
    input.coreDb,
    input.snapshot,
    input.input.workspaceId,
    repository,
    workspaceRoots
  );
  const workspace = input.store.getWorkspace(input.input.workspaceId);
  const modelAgentId = resolveModelAgentOverride(
    input.snapshot.agentManifests,
    input.snapshot.providerRegistry,
    workspace.defaults?.defaultAgentId ?? null,
    input.input.modelId,
    { providerCredentialResolver: input.providerCredentialResolver }
  );
  const requestedAgentOverride = input.requestedAgentId ?? modelAgentId;
  const selectedAgent = selectAgent(
    { defaultAgentId: workspace.defaults?.defaultAgentId ?? null },
    requestedAgentOverride ? { agentId: requestedAgentOverride } : {},
    input.snapshot.agentManifests
  );

  if (!('id' in selectedAgent)) {
    throw new TurnStartValidationError(selectedAgent.error.code, selectedAgent.error.message, 409);
  }
  assertAgentManifestSupportsModel(
    selectedAgent,
    input.snapshot.providerRegistry,
    input.input.modelId
  );

  const requestedAgentId = selectedAgent.id;

  const suffix = schedulerAdmissionIdSuffix(
    JSON.stringify(canonicalTriggerActor),
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
    triggerActor: canonicalTriggerActor,
    workspaceCwd: repository?.localPath ?? null,
    workspaceId: input.input.workspaceId,
    workspaceRoots,
  });

  const dispatch = await runSchedulerDispatchLoop({
    agentManifests: input.snapshot.agentManifests,
    coreDb: input.coreDb,
    createAgentSessionId: () => `as_${suffix}`,
    createLeaseId: () => `lease_${suffix}`,
    createPlanId: () => `plan_${suffix}`,
    dependencies: { providerCredentialResolver: input.providerCredentialResolver },
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
 * @param canonicalActorRef Canonical serialized trigger ActorRef.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Request id.
 * @param reservedTurnId Optional upper-level Turn owner included in scheduler lineage.
 * @returns Stable short id suffix.
 */
function schedulerAdmissionIdSuffix(
  canonicalActorRef: string,
  workspaceId: string,
  threadId: string,
  requestId: string,
  reservedTurnId?: string
): string {
  return createHash('sha256')
    .update(
      `${canonicalActorRef}:${workspaceId}:${threadId}:${requestId}${
        reservedTurnId ? `:${reservedTurnId}` : ''
      }`
    )
    .digest('hex')
    .slice(0, 16);
}
