import { createHash } from 'node:crypto';

import type { ActorRef, SubmitTurnInputRequestSchema, TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import { computeReadiness } from '../agents/readiness.js';
import { selectAgent } from '../agents/selector.js';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import type { Actor } from '../auth/identity.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { type RuntimeConfigSnapshot, resolveDefaultAgentId } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type { ProviderCredentialResolver } from '../providers/registry.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
  SchedulerAdmissionTransitionError,
  type SchedulerWorkerStorageChoice,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';
import { assertAgentManifestSupportsModel, TurnStartValidationError } from './orchestrator.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from './scheduler-dispatch-loop.js';
import { materializeWorkspaceRootsForTurn } from './turn-workspace-context.js';
import type { TurnExecutor } from './types.js';

/** Product turn inputs needed for scheduler admission and worker startup. */
interface StartProductTurnInput {
  /** Required Core database for durable scheduler admission. */
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
  /** Actor-scoped store. */
  readonly store: FsStore;
  /** Runtime executor used to start worker turns. */
  readonly turnExecutor: TurnExecutor;
  /** Deployment placement is descriptive and never selects a backend identity. */
  readonly workerPlacement: 'local' | 'remote';
  /** Optional worker id selected by an upper-level coordinator. */
  readonly requestedAgentId?: string | null;
  /** Optional turn id reserved by an upper-level worker loop. */
  readonly reservedTurnId?: string;
  /** Explicit retained-storage choice captured with scheduler admission. */
  readonly workerStorageChoice?: SchedulerWorkerStorageChoice;
  /**
   * Optional callback once this admission's Turn and resolved setup are durable, carrying its nullable AgentSession while queued acceptance remains independent of execution.
   *
   * The initiating entry invokes this once after its pending Turn and exact admission are durable, before dispatch eligibility.
   */
  readonly onTurnCreated?: (
    turn: z.infer<typeof TurnSchema>,
    agentSessionId: string | null
  ) => void;
}

/**
 * Accepts the exact pending product Turn before independent preparation and execution; receipt publication remains with the initiating command owner.
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
  // Product pending state is real nonterminal ownership, before any backend acquisition.
  if (
    input.store
      .listThreadTurns(input.input.workspaceId, input.input.threadId)
      .some(
        (turn) => turn.id !== turnId && (turn.status === 'pending' || turn.status === 'running')
      ) ||
    input.coreDb.sqlite
      .prepare(
        "SELECT 1 FROM scheduler_admission_entries WHERE workspace_id = ? AND thread_id = ? AND turn_id <> ? AND status = 'queued' LIMIT 1"
      )
      .get(input.input.workspaceId, input.input.threadId, turnId)
  )
    throw new TurnStartValidationError(
      'thread_busy',
      'Thread already has a nonterminal Turn.',
      409
    );

  const backend = input.turnExecutor.executionBackend;
  if (!backend)
    throw new TurnStartValidationError(
      'scheduler_unavailable',
      'Configured execution backend is required.',
      503
    );
  const setup = resolveAgentSetup(selectedAgent, {
    gatewayConfig: input.snapshot.gatewayConfig,
    providerRegistry: input.snapshot.providerRegistry,
    selectedProfileId: input.input.profileId ?? null,
    requestedLogicalModelId: input.input.modelId ?? null,
    workspaceId: input.input.workspaceId,
    ...(input.snapshot.workspaceConfigs.find(
      (record) => record.workspaceId === input.input.workspaceId
    )?.config
      ? {
          workspaceConfig: input.snapshot.workspaceConfigs.find(
            (record) => record.workspaceId === input.input.workspaceId
          )!.config,
        }
      : {}),
    ...(input.snapshot.userConfigs.find((record) => record.userId === responsibleUserId)?.config
      ? {
          userConfig: input.snapshot.userConfigs.find(
            (record) => record.userId === responsibleUserId
          )!.config,
        }
      : {}),
  });
  if (!setup.setup || setup.diagnostics.length)
    throw new TurnStartValidationError(
      'agent_not_ready',
      setup.diagnostics.map((diagnostic) => diagnostic.message).join(' '),
      409
    );
  const reasoningEffort =
    input.input.reasoningEffort ?? setup.setup.manifest.models.reasoningEffort;
  try {
    createSchedulerAdmissionEntry(input.coreDb, {
      backendId: backend.id,
      modelId: input.input.modelId ?? null,
      ...(input.input.reasoningEffort !== undefined
        ? { reasoningEffort: input.input.reasoningEffort }
        : {}),
      profileRef: input.input.profileId ?? null,
      queueEntryId,
      requestId: input.input.requestId,
      requestedAgentId,
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
  } catch (error) {
    if (error instanceof SchedulerAdmissionTransitionError)
      throw new TurnStartValidationError('scheduler_admission_denied', error.message, 409);
    throw error;
  }
  const existing = input.store
    .listThreadTurns(input.input.workspaceId, input.input.threadId)
    .find((turn) => turn.id === turnId);
  const turn =
    existing ??
    input.store.createTurn(
      input.input.workspaceId,
      input.input.threadId,
      input.input.input,
      canonicalTriggerActor,
      input.snapshot.version,
      {
        turnId,
        status: 'pending',
        agentId: requestedAgentId,
        executorKind: 'worker',
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      }
    );
  // This listener observes the existing product owner; it grants neither execution nor recovery.
  // Durable admission/checkpoint classification remains usable without this HTTP invocation.
  let unsubscribe: () => void = () => {};
  const completion = new Promise<import('./orchestrator.js').TurnHandle>((resolve, reject) => {
    const observe = () => {
      const current = input.store.getTurnById(turnId);
      if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(current.status)) return;
      const invocation = getSchedulerPreparationClaims(input.coreDb!).get(queueEntryId);
      if (invocation) {
        unsubscribe();
        void invocation.then((result) => {
          const started = result.startedTurns.find(
            (start) => start.dispatch.entry.turnId === turnId
          );
          if (started) resolve(started.handle);
          else reject(new Error('The original worker invocation has no completed Turn handle.'));
        }, reject);
        return;
      }
      // A restarted or cancelled invocation has no live owner to join. Its canonical
      // terminal event and closed attempt must already establish the lifecycle result.
      const attempts = listSchedulerExecutionAttemptsForTurn(input.coreDb!, {
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId,
      });
      if (
        attempts.some((attempt) => attempt.phase !== 'closed') ||
        !input.store.getTurnEvents(turnId).some((event) => event.event === 'turn.completed')
      )
        return;
      unsubscribe();
      resolve({
        turn: current,
        modelId: setup.setup!.logicalModels.preferredLogicalModelId ?? null,
        readiness: computeReadiness(selectedAgent),
        agent: selectedAgent,
        agentSetup: setup.setup,
        agentSetupRecordId: null,
        agentSetupDiagnostics: setup.diagnostics,
      });
    };
    unsubscribe = input.store.addTurnListener(turnId, observe);
    observe();
  });
  // Observe rejection even if admission publication is still awaiting its caller; the original completion promise still rejects for its lifecycle owner.
  void completion.catch(() => undefined);
  // Let the existing observation owner install its closeout before signalling durable acceptance.
  await Promise.resolve();
  input.onTurnCreated?.(turn, turn.agentSessionId ?? null);
  // The command owner writes its receipt in the current microtask turn. Dispatch also checks it
  // durably, so a crash or partial cross-store publication cannot authorize preparation effects.
  await new Promise<void>((resolve) => setImmediate(resolve));
  void runSchedulerDispatchLoop({
    agentManifests: input.snapshot.agentManifests,
    coreDb: input.coreDb,
    callerQueueEntryId: queueEntryId,
    dependencies: { providerCredentialResolver: input.providerCredentialResolver },
    executionBackend: backend,
    maxDispatches: 1,
    providerRegistry: input.snapshot.providerRegistry,
    gatewayConfig: input.snapshot.gatewayConfig,
    workspaceConfigs: input.snapshot.workspaceConfigs,
    userConfigs: input.snapshot.userConfigs,
    store: input.store,
    turnExecutor: input.turnExecutor,
    configVersion: input.snapshot.version,
    workspaceDataSourceCatalogs: input.snapshot.workspaceDataSourceCatalogs,
    workspaceMcpServerCatalogs: input.snapshot.workspaceMcpServerCatalogs,
  }).catch((error: unknown) =>
    console.error(
      'scheduler_dispatch_failed_after_admission',
      error instanceof Error ? error.message : 'unknown'
    )
  );
  return completion;
}

/**
 * Cancels one exact synchronous caller admission only while it remains queued or denied.
 *
 * Dispatch may fail after external work has already been admitted. Re-reading the durable entry before cancellation prevents this cleanup from cancelling dispatched or active work. Cleanup races preserve the original dispatch failure instead of replacing it with a cancellation error.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact admission owner.
 */
export function cancelOwnedQueuedAdmission(
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
 * @returns The validated Turn, attempt, and scheduler admission.
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
    const attempts = listSchedulerExecutionAttemptsForTurn(input.coreDb, input);
    const held = attempts.filter((attempt) => attempt.phase !== 'closed');
    const attempt = held[0] ?? null;
    const row = input.coreDb.sqlite
      .prepare(
        'SELECT queue_entry_id AS queueEntryId FROM scheduler_admission_entries WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?'
      )
      .get(input.workspaceId, input.threadId, input.turnId) as { queueEntryId: string } | undefined;
    if (!row) throw new Error('Live Turn has no exact scheduler admission.');
    const admission = requireSchedulerAdmissionEntry(input.coreDb, row.queueEntryId, input);
    if (
      !['pending', 'running'].includes(turn.status) ||
      turn.triggerActor.kind !== 'user' ||
      turn.triggerActor.id !== input.actorId ||
      held.length > 1 ||
      (attempt &&
        (attempt.queueEntryId !== admission.queueEntryId ||
          attempt.backendId !== admission.backendId ||
          (turn.agentSessionId && turn.agentSessionId !== attempt.agentSessionId))) ||
      admission.workspaceId !== input.workspaceId ||
      admission.threadId !== input.threadId ||
      admission.turnId !== input.turnId ||
      admission.requestId !== input.requestId ||
      !['queued', 'admitted'].includes(admission.status) ||
      admission.triggerActor.kind !== 'user' ||
      admission.triggerActor.id !== input.actorId ||
      admission.requestedAgentId !== turn.agentId ||
      (!attempt && admission.status !== 'queued')
    )
      throw new Error('Live Turn admission contradicts its exact request or attempt.');
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
    return { turn, attempt, admission };
  } catch {
    throw new TurnStartValidationError(
      'recovery_required',
      'The live Turn admission owner tuple requires recovery.',
      409
    );
  }
}
