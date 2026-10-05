import { createHash } from 'node:crypto';

import type { ActorRef, SubmitTurnInputRequestSchema, TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import { selectAgent } from '../agents/selector.js';
import type { Actor } from '../auth/identity.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { type RuntimeConfigSnapshot, resolveDefaultAgentId } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type { ProviderCredentialResolver } from '../providers/registry.js';
import {
  CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS,
  CONFIGURED_WORKER_STARTUP_TIMEOUT_MS,
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  ensureConfiguredSchedulerBaseline,
  listSchedulerSessionLeasesForTurn,
  requireSchedulerAdmissionEntry,
  type SchedulerWorkerStorageChoice,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { assertAgentManifestSupportsModel, TurnStartValidationError } from './orchestrator.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import { materializeWorkspaceRootsForTurn } from './turn-workspace-context.js';
import type { TurnExecutor } from './types.js';

/** Product turn inputs needed for scheduler admission and worker startup. */
interface StartProductTurnInput {
  /** Required Core database for durable scheduler admission and placement. */
  readonly coreDb?: CoreDb;
  /** Parsed protocol turn-start request. */
  readonly input: Extract<z.infer<typeof SubmitTurnInputRequestSchema>, { input: string }>;
  /** Exact actor that triggered this scheduler admission. */
  readonly triggerActor: ActorRef;
  /** Authenticating request actor when the caller still holds the HTTP credential context. */
  readonly requestActor?: Actor;
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
  /** Configured scheduler placement. */
  readonly workerPlacement: 'local' | 'remote';
  /** Optional worker id selected by an upper-level coordinator. */
  readonly requestedAgentId?: string | null;
  /** Optional turn id reserved by an upper-level worker loop. */
  readonly reservedTurnId?: string;
  /** Explicit retained-storage choice captured with scheduler admission. */
  readonly workerStorageChoice?: SchedulerWorkerStorageChoice;
  /** Whether to cancel deferred, denied, or unattributed shared-acquisition outcomes; own dispatch failures always cancel a still-queued admission. */
  readonly cancelDeferredAdmission?: boolean;
  /**
   * Optional callback once this admission's Turn and resolved setup are durable, carrying the exact validated lease AgentSession before executor entry.
   *
   * The dispatch loop invokes this only for this admission, including when joining another dispatcher; a late join observes the already-created Turn immediately.
   */
  readonly onTurnCreated?: (turn: z.infer<typeof TurnSchema>, agentSessionId: string) => void;
}

/**
 * Starts a new product turn through the durable scheduler, cancelling its still-queued admission on its own dispatch failure while preserving the original error.
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
  const presentedServerAdminTokenId =
    input.requestActor?.kind === 'token' && input.requestActor.tokenScope === 'server-admin'
      ? (input.requestActor.tokenId ?? null)
      : null;
  if (
    !currentWorkspaceAuthority(
      input.coreDb,
      input.input.workspaceId,
      canonicalTriggerActor,
      'runtime.launch',
      true,
      input.requestActor
    )
  ) {
    throw new TurnStartValidationError('workspace_access_denied', 'Workspace access denied.', 403);
  }

  input.store.getWorkspace(input.input.workspaceId);
  const responsibleUserId =
    canonicalTriggerActor.kind === 'user'
      ? canonicalTriggerActor.id
      : canonicalTriggerActor.responsibleUserId;
  const defaultAgentId = resolveDefaultAgentId(
    input.snapshot,
    input.input.workspaceId,
    responsibleUserId ?? undefined
  );
  const requestedAgentOverride = input.requestedAgentId ?? input.input.agentId;
  const selectedAgent = selectAgent(
    { defaultAgentId },
    requestedAgentOverride ? { agentId: requestedAgentOverride } : {},
    input.snapshot.agentManifests
  );

  if (!('id' in selectedAgent)) {
    throw new TurnStartValidationError(selectedAgent.error.code, selectedAgent.error.message, 409);
  }
  assertAgentManifestSupportsModel(selectedAgent, input.input.modelId);

  const workspaceRoots = materializeWorkspaceRootsForTurn(
    input.snapshot,
    input.store,
    input.input.workspaceId,
    selectedAgent
  );
  const workspaceCwd =
    workspaceRoots.find((root) => root.sourceKind === 'remote-git')?.workerPath ?? null;

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
    modelId: input.input.modelId ?? null,
    ...(input.input.reasoningEffort !== undefined
      ? { reasoningEffort: input.input.reasoningEffort }
      : {}),
    profileRef: input.input.profileId ?? null,
    queueEntryId,
    requestId: input.input.requestId,
    requestedAgentId,
    requiredPoolConstraints: [`openshell.${input.workerPlacement}`],
    threadId: input.input.threadId,
    turnId,
    turnInput: input.input.input,
    ...(input.workerStorageChoice ? { workerStorageChoice: input.workerStorageChoice } : {}),
    triggerActor: canonicalTriggerActor,
    serverAdminTokenId: presentedServerAdminTokenId,
    workspaceCwd,
    workspaceId: input.input.workspaceId,
    workspaceRoots,
  });

  let cancelAdmission = input.cancelDeferredAdmission;
  try {
    let attributedQueueEntryId: string | null = null;
    const dispatch = await runSchedulerDispatchLoop({
      agentManifests: input.snapshot.agentManifests,
      coreDb: input.coreDb,
      callerQueueEntryId: queueEntryId,
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
      onDispatchAttribution: (queueEntryId) => {
        attributedQueueEntryId = queueEntryId;
      },
      providerRegistry: input.snapshot.providerRegistry,
      gatewayConfig: input.snapshot.gatewayConfig,
      workspaceConfigs: input.snapshot.workspaceConfigs,
      userConfigs: input.snapshot.userConfigs,
      schedulerEpoch: input.schedulerEpoch,
      startupTimeoutMs: CONFIGURED_WORKER_STARTUP_TIMEOUT_MS,
      store: input.store,
      turnExecutor: input.turnExecutor,
      configVersion: input.snapshot.version,
      ...(input.onTurnCreated
        ? {
            onTurnCreated: (created, agentSessionId) => {
              if (
                created.id !== turnId ||
                created.workspaceId !== input.input.workspaceId ||
                created.threadId !== input.input.threadId
              ) {
                return;
              }
              input.onTurnCreated?.(created, agentSessionId);
            },
          }
        : {}),
      workspaceDataSourceCatalogs: input.snapshot.workspaceDataSourceCatalogs,
      workspaceMcpServerCatalogs: input.snapshot.workspaceMcpServerCatalogs,
    }).catch((error: unknown) => {
      // Shared acquisition has no attribution; only this caller's attributed errors escape.
      if (attributedQueueEntryId === queueEntryId) {
        cancelAdmission = true;
        throw error;
      }
      return null;
    });
    const started = dispatch?.startedTurns.find(
      (turn) => turn.dispatch.entry.queueEntryId === queueEntryId
    );

    if (!started) {
      if (
        dispatch?.terminalResult.status === 'denied' &&
        dispatch.terminalResult.entry.queueEntryId === queueEntryId
      ) {
        throw new TurnStartValidationError(
          'scheduler_admission_denied',
          `Scheduler denied this turn: ${dispatch.terminalResult.entry.denialReason}.`,
          409
        );
      }
      throw new TurnStartValidationError(
        'scheduler_admission_deferred',
        'Turn was queued but not dispatched in this scheduler iteration.',
        409
      );
    }

    return started.handle;
  } catch (error) {
    if (cancelAdmission) {
      cancelOwnedDeferredAdmission(input.coreDb, {
        queueEntryId,
        workspaceId: input.input.workspaceId,
      });
    }
    throw error;
  }
}

/**
 * Cancels one exact synchronous caller admission only while it remains queued or denied.
 *
 * Dispatch may fail after external work has already been admitted. Re-reading the durable entry before cancellation prevents this cleanup from cancelling dispatched or active work. Cleanup races preserve the original dispatch failure instead of replacing it with a cancellation error.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact admission owner.
 */
export function cancelOwnedDeferredAdmission(
  coreDb: CoreDb,
  input: { readonly queueEntryId: string; readonly workspaceId: string }
): void {
  try {
    const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, {
      workspaceId: input.workspaceId,
    });
    if (entry.status !== 'queued' && entry.status !== 'denied') {
      return;
    }
    cancelSchedulerAdmissionEntry(coreDb, input);
  } catch {
    // The dispatch failure remains authoritative when concurrent admission progress blocks cleanup.
  }
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

/**
 * Observes one worker execution without making response delivery own its closeout.
 *
 * Callers validate their durable family-specific tuple before signalling admission. The scheduler execution retains its database handle; the supplied closeout and settlement callbacks retain additional family-owned handles until settlement.
 *
 * @param input Existing execution, closeout, and resource owners.
 * @returns Admission, full execution, and observed closeout promises.
 */
export function observeTurnAdmission<T>(input: {
  readonly execute: (admit: (turn: z.infer<typeof TurnSchema>) => void) => Promise<T>;
  readonly closeout?: (result: T) => Promise<void> | void;
  readonly settled: () => void;
  readonly failed: () => void;
}) {
  let resolveAdmission!: (turn: z.infer<typeof TurnSchema>) => void;
  const admission = new Promise<z.infer<typeof TurnSchema>>((resolve) => {
    resolveAdmission = resolve;
  });
  let admitted = false;
  const execution = input.execute((turn) => {
    admitted = true;
    resolveAdmission(turn);
  });
  const closeout = execution.then(input.closeout).finally(input.settled);
  // Observe every rejection, including pre-admission failures that escape through accepted.
  void closeout.catch(() => {
    if (admitted) input.failed();
  });
  const accepted = Promise.race([
    admission,
    execution.then(() => {
      if (!admitted)
        throw new TurnStartValidationError(
          'recovery_required',
          'Worker execution has no durable Turn admission signal.',
          409
        );
      return admission;
    }),
  ]);
  return { accepted, execution, closeout };
}

/**
 * Validates the common live Turn, scheduler, and optional initiating Item owners.
 *
 * Family-specific request hashes and checkpoint context remain with their command owner.
 *
 * @param input Exact human command and admitted Turn lineage.
 * @returns The validated Turn, lease, and scheduler admission.
 * @throws TurnStartValidationError when live ownership is missing or contradictory.
 */
export function validateLiveProductTurnAdmission(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly turnId: string;
}) {
  try {
    const turn = input.store.getTurn(input.workspaceId, input.threadId, input.turnId);
    const leases = listSchedulerSessionLeasesForTurn(input.coreDb, input);
    const lease = leases[0];
    if (
      !['pending', 'running'].includes(turn.status) ||
      turn.triggerActor.kind !== 'user' ||
      turn.triggerActor.id !== input.actorId ||
      leases.length !== 1 ||
      !lease ||
      !['acquired', 'starting', 'active', 'idle'].includes(lease.status) ||
      lease.recoveryState !== null ||
      (turn.agentSessionId && turn.agentSessionId !== lease.agentSessionId)
    )
      throw new Error('Live Turn lease contradicts command admission.');
    const plan = input.coreDb.sqlite
      .prepare(
        "SELECT queue_entry_id AS queueEntryId FROM scheduler_placement_plans WHERE plan_id = ? AND workspace_id = ? AND thread_id = ? AND turn_id = ? AND status = 'executing' AND selected_pool_id = ? AND selected_target_id = ?"
      )
      .get(
        lease.planId,
        input.workspaceId,
        input.threadId,
        input.turnId,
        lease.poolId,
        lease.targetId
      ) as { queueEntryId: string } | undefined;
    if (!plan) throw new Error('Live Turn has no exact scheduler plan.');
    const admission = requireSchedulerAdmissionEntry(input.coreDb, plan.queueEntryId, input);
    if (
      admission.workspaceId !== input.workspaceId ||
      admission.threadId !== input.threadId ||
      admission.turnId !== input.turnId ||
      admission.requestId !== input.requestId ||
      admission.status !== 'admitted' ||
      admission.triggerActor.kind !== 'user' ||
      admission.triggerActor.id !== input.actorId ||
      admission.requestedAgentId !== turn.agentId
    )
      throw new Error('Live Turn admission contradicts command identity.');
    const initiatingItem = turn.items.find((item) => item.id === `it_user_${turn.id}`);
    if (
      initiatingItem &&
      (initiatingItem.type !== 'user-message' ||
        initiatingItem.status !== 'completed' ||
        initiatingItem.workspaceId !== input.workspaceId ||
        initiatingItem.threadId !== input.threadId ||
        initiatingItem.turnId !== input.turnId ||
        initiatingItem.text !== admission.turnInput)
    )
      throw new Error('Live Turn input Item contradicts scheduler admission.');
    return { turn, lease, admission };
  } catch {
    throw new TurnStartValidationError(
      'recovery_required',
      'The live Turn admission owner tuple requires recovery.',
      409
    );
  }
}
