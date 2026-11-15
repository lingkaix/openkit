import { isDeepStrictEqual } from 'node:util';
import { GoalTaskLinkSchema } from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import {
  deriveEntityId,
  isSealedTurnTerminal,
  type PolicyResourceV1Schema,
  responsibleUserIdForActor,
  workspaceIdForOwner,
} from '@openkit/protocol';
import type { z } from 'zod';
import {
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import type { FsStore } from '../lib/store.js';
import {
  findSchedulerAdmissionForWorkerLineage,
  listSchedulerAdmissionEntriesForWorkspace,
  type SchedulerExecutionLineage,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import {
  commandRequestKey,
  getCommandRequestRecordFromDb,
} from '../storage/command-request-records.js';
import { commandInputHash } from '../storage/control-store-input.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';
import { goalPlanDigest, readNativeGoalView } from './goal-owner.js';
import { listThreadPendingRequests, pendingRequestSystemActor } from './pending-requests.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';

/** Retained native Task selection with optional current Goal bounds; references grant no rights. */
export interface GoalTaskPolicyContext {
  /** Workspace that owns the exact Task. */
  readonly workspaceId: string;
  /** Exact linked Goal, or null for a standalone Task. */
  readonly goalId: string | null;
  /** Ordinary Task Thread identity. */
  readonly taskThreadId: string;
  /** Actual effect Turn, which can follow the original Task request. */
  readonly turnId: string;
  /** Exact active Plan cited at Task reservation, or null without a Goal. */
  readonly planVersionId: string | null;
  /** Actual selected Worker from the effect Turn and scheduler request. */
  readonly agentId: string;
  /** Human responsible for the original Task request. */
  readonly responsibleUserId: string;
  /** Finite native request/manifest selection; an empty set matches nothing. */
  readonly resources: readonly z.infer<typeof PolicyResourceV1Schema>[];
  /** Scheduler's immutable hash of the complete original request and provenance. */
  readonly requestInputHash: string;
}

/** Canonical Turn content remains required; a metadata-only projection cannot establish Task authority. */
export type GoalTaskPolicyReadPort = Pick<FsStore, 'getTurnMetadata' | 'getThread' | 'getTurn'>;

/** Reads the canonical Task link without loading immutable Turn content. */
function readTaskLink(db: WorkspaceDb, threadId: string) {
  const row = db.sqlite
    .prepare('SELECT thread_id,goal_id,card_id,payload_json FROM goal_card_tasks WHERE thread_id=?')
    .get(threadId) as
    | { thread_id: string; goal_id: string; card_id: string; payload_json: string }
    | undefined;
  if (!row) return null;
  const link = GoalTaskLinkSchema.parse(JSON.parse(row.payload_json));
  if (link.threadId !== row.thread_id || link.goalId !== row.goal_id || link.cardId !== row.card_id)
    throw new Error('Goal Task Policy context requires current exact owner facts.');
  return link;
}

/** Selects only the Task owner's original admission; preparation and current reads share this selector. */
export function requiredTaskTurn(input: {
  readonly coreDb: CoreDb;
  readonly db: WorkspaceDb;
  readonly lineage: SchedulerExecutionLineage;
}) {
  const { coreDb, db, lineage } = input;
  const unavailable = () =>
    new Error('Goal Task Policy context requires current exact owner facts.');
  if (db.workspaceId !== lineage.workspaceId) throw unavailable();
  const link = readTaskLink(db, lineage.threadId);
  if (!link) {
    const entries = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
      workspaceId: lineage.workspaceId,
      statuses: ['admitted'],
    }).filter((entry) => entry.threadId === lineage.threadId);
    const current = entries.find((entry) => entry.turnId === lineage.turnId);
    if (!current || schedulerAdmissionInputHash(current) !== current.inputHash) throw unavailable();
    const originals = entries.filter((entry) => {
      const checkpoint = getWorkerCheckpoint(db, entry.workspaceId, entry.threadId, entry.turnId);
      if (checkpoint?.goalId || checkpoint?.taskId) throw unavailable();
      return (
        entry.requestId &&
        responsibleUserIdForActor(entry.triggerActor) &&
        ((checkpoint?.requestId === entry.requestId && checkpoint.contextDigest !== null) ||
          deriveEntityId('tu', {
            command: 'task.start',
            actorId: entry.triggerActor.id,
            workspaceId: entry.workspaceId,
            threadId: entry.threadId,
            requestId: entry.requestId,
          }) === entry.turnId)
      );
    });
    const exact = originals.find((entry) => entry.turnId === lineage.turnId);
    if (exact) return exact;
    // Pending supplies an original source position, never a new selection or authority.
    const pending = listThreadPendingRequests(db.sqlite, lineage.workspaceId, lineage.threadId);
    let sourceTurnId = lineage.turnId;
    const visited = new Set<string>();
    while (!visited.has(sourceTurnId)) {
      visited.add(sourceTurnId);
      const causes = pending.filter(
        (record) =>
          record.deliveryTurnId === sourceTurnId &&
          record.deliveryCause === 'outcome' &&
          record.requesterKind === 'worker'
      );
      if (!causes.length) break;
      const sources = new Set(causes.map((record) => record.raisingTurnId));
      if (sources.size !== 1) throw unavailable();
      sourceTurnId = causes[0]!.raisingTurnId;
      const original = originals.find((entry) => entry.turnId === sourceTurnId);
      if (original) return original;
    }
    if (sourceTurnId !== lineage.turnId) throw unavailable();
    // An ordinary follow-up can inherit one unambiguous native Task on its Thread.
    // Several independent Tasks on a reused Thread require an exact source cause.
    if (originals.length > 1) throw unavailable();
    if (originals.length === 1) return originals[0]!;
    if (getWorkerCheckpoint(db, lineage.workspaceId, lineage.threadId, lineage.turnId))
      throw unavailable();
    return null;
  }
  const goal = readNativeGoalView(db, link.goalId).goal;
  if (!goal || goal.workspaceId !== lineage.workspaceId) throw unavailable();
  const responsibleUserId = goal.responsibleUserId;
  const originals = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
    workspaceId: lineage.workspaceId,
    statuses: ['admitted'],
  }).filter(
    (entry) =>
      entry.threadId === lineage.threadId &&
      entry.requestId &&
      entry.triggerActor.kind === 'user' &&
      entry.triggerActor.id === responsibleUserId &&
      deriveEntityId('th', ['task', entry.requestId]) === lineage.threadId &&
      deriveEntityId('tu', {
        command: 'task.start',
        actorId: responsibleUserId,
        workspaceId: lineage.workspaceId,
        threadId: lineage.threadId,
        requestId: entry.requestId,
      }) === entry.turnId
  );
  const original = originals[0];
  if (!original || originals.length !== 1) throw unavailable();
  return original;
}

/**
 * Reads retained native Task bounds; live and captured-call entry owners check their own liveness.
 * @param input Exact authenticated Worker package lineage and its existing stores.
 * @returns Current finite Task context, or null for an admitted non-Task execution.
 * @throws Error when Task source facts contradict or required Task/Goal authority is unavailable.
 */
export function readGoalTaskPolicyContext(input: {
  readonly coreDb: CoreDb;
  readonly store: GoalTaskPolicyReadPort;
  readonly db: WorkspaceDb;
  readonly lineage: SchedulerExecutionLineage;
}): GoalTaskPolicyContext | null {
  const { coreDb, store, db, lineage } = input;
  const unavailable = () =>
    new Error('Goal Task Policy context requires current exact owner facts.');
  if (db.workspaceId !== lineage.workspaceId) throw unavailable();
  const addressedTurn = store.getTurnMetadata(
    lineage.workspaceId,
    lineage.threadId,
    lineage.turnId
  );
  if (
    workspaceIdForOwner(addressedTurn.owner) !== lineage.workspaceId ||
    addressedTurn.threadId !== lineage.threadId
  )
    throw unavailable();
  const link = readTaskLink(db, lineage.threadId);
  const original = requiredTaskTurn({ coreDb, db, lineage });
  if (!original) return null;
  const view = link ? readNativeGoalView(db, link.goalId) : null;
  const goal = view?.goal ?? null;
  const card = view?.cards.find((value) => value.cardId === link?.cardId);
  const plan = view?.versions.find((value) => value.planVersionId === link?.planVersionId);
  if (
    link &&
    (!goal ||
      goal.goalId !== link.goalId ||
      goal.workspaceId !== lineage.workspaceId ||
      goal.disposition ||
      !card ||
      card.goalId !== goal.goalId ||
      card.cancelled ||
      !plan ||
      plan.goalId !== goal.goalId ||
      goal.activePlanVersionId !== plan.planVersionId ||
      goalPlanDigest(plan.bytes) !== plan.digest ||
      JSON.stringify(plan.commitment) !== plan.bytes ||
      store.getThread(lineage.workspaceId, lineage.threadId).visibility !== 'workspace')
  )
    throw unavailable();
  const responsibleUserId =
    goal?.responsibleUserId ?? responsibleUserIdForActor(original.triggerActor);
  if (!responsibleUserId) throw unavailable();
  // Card edits do not steer a running Task. Cancellation and active Plan replacement do end use.
  // Later Turns have their own Worker/package and can have a different human trigger.
  // Native Pending cause identifies system-authored frozen input; it supplies no Task scope.
  const pending = listThreadPendingRequests(db.sqlite, lineage.workspaceId, lineage.threadId);
  const readWorkerSource = (scope: SchedulerExecutionLineage) => {
    const admission = findSchedulerAdmissionForWorkerLineage(coreDb, scope);
    const turn = store.getTurn(scope.workspaceId, scope.threadId, scope.turnId);
    if (
      !admission ||
      admission.status !== 'admitted' ||
      !admission.requestId ||
      schedulerAdmissionInputHash(admission) !== admission.inputHash
    )
      throw unavailable();
    const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, scope).filter(
      (attempt) =>
        attempt.queueEntryId === admission.queueEntryId &&
        attempt.agentSessionId === scope.agentSessionId &&
        attempt.inputRef === scope.packageSnapshotId
    );
    const attempt = attempts[0];
    const checkpoint = getWorkerCheckpoint(db, scope.workspaceId, scope.threadId, scope.turnId);
    const outcomeInitiated = pending.some(
      (record) =>
        record.deliveryTurnId === turn.id &&
        record.deliveryCause === 'outcome' &&
        record.requesterKind === 'worker' &&
        record.agentId === admission.requestedAgentId
    );
    // Direct Task checkpoints hash the original entry request before its structured expansion.
    // Exact structured bytes and their canonical context digest are checked below.
    const initiatingItem = turn.items.find(
      (item) => item.id === deriveEntityId('it', ['task-user', turn.id])
    );
    if (
      !attempt ||
      attempts.length !== 1 ||
      attempt.backendId !== admission.backendId ||
      (isSealedTurnTerminal(turn.status) && attempt.disposition !== 'accepted') ||
      (attempt.phase === 'closed' && attempt.disposition === 'not_accepted') ||
      turn.agentSessionId !== scope.agentSessionId ||
      turn.agentId !== admission.requestedAgentId ||
      !isDeepStrictEqual(turn.triggerActor, admission.triggerActor) ||
      !initiatingItem ||
      initiatingItem.type !== 'user-message' ||
      initiatingItem.status !== 'completed' ||
      workspaceIdForOwner(initiatingItem.owner) !== scope.workspaceId ||
      initiatingItem.threadId !== scope.threadId ||
      initiatingItem.turnId !== scope.turnId ||
      !isDeepStrictEqual(
        initiatingItem.actor,
        outcomeInitiated
          ? pendingRequestSystemActor(responsibleUserIdForActor(turn.triggerActor))
          : turn.triggerActor
      ) ||
      (!outcomeInitiated && initiatingItem.text !== admission.turnInput) ||
      (checkpoint
        ? checkpoint.requestId !== admission.requestId ||
          (link &&
            checkpoint.requestInputHash !== commandInputHash({ input: admission.turnInput })) ||
          (checkpoint.workerSessionId !== null &&
            checkpoint.workerSessionId !== scope.agentSessionId)
        : isSealedTurnTerminal(turn.status) &&
          (attempt.phase !== 'closed' || attempt.disposition !== 'accepted' || !attempt.fenceRef))
    )
      throw unavailable();
    return { admission, turn, checkpoint };
  };
  const current = readWorkerSource(lineage);
  // The Task owner declares these exact Thread and Turn names. Match that native source,
  // never the first parseable JSON or a later request that resembles a delegation.
  const originalTurn = store.getTurn(lineage.workspaceId, lineage.threadId, original.turnId);
  const originalAttempts = listSchedulerExecutionAttemptsForTurn(coreDb, original).filter(
    (attempt) =>
      attempt.queueEntryId === original.queueEntryId &&
      attempt.agentSessionId === originalTurn.agentSessionId &&
      attempt.inputRef
  );
  const originalAttempt = originalAttempts[0];
  if (
    !originalAttempt ||
    originalAttempts.length !== 1 ||
    !originalAttempt.agentSessionId ||
    !originalAttempt.inputRef
  )
    throw unavailable();
  const source = readWorkerSource({
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    turnId: original.turnId,
    agentSessionId: originalAttempt.agentSessionId,
    packageSnapshotId: originalAttempt.inputRef,
  });
  const request = StructuredWorkerDelegationRequestSchema.parse(
    JSON.parse(source.admission.turnInput)
  );
  // Only the original Task preparation owns this required checkpoint and structured digest.
  if (
    serializeStructuredWorkerDelegationRequest(request) !== source.admission.turnInput ||
    (source.checkpoint
      ? source.checkpoint.contextDigest !== commandInputHash(request)
      : !isSealedTurnTerminal(source.turn.status))
  )
    throw unavailable();
  const resources = request.resources.flatMap((value) =>
    value.kind === 'policy' ? [value.resource] : []
  );
  if (
    !link &&
    resources.length === 0 &&
    source.checkpoint &&
    source.checkpoint.requestInputHash !== commandInputHash({ input: source.admission.turnInput })
  ) {
    // Only the original direct Task command can select its prepared credential supply.
    // An explicitly structured empty selection stays empty, even with a credential manifest.
    const receipt = getCommandRequestRecordFromDb(
      db,
      commandRequestKey('task.start', source.admission.requestId!, {
        actorId: source.admission.triggerActor.id,
        workspaceId: lineage.workspaceId,
        threadId: lineage.threadId,
      }),
      new Date().toISOString()
    );
    if (
      !receipt ||
      receipt.inputHash !== source.checkpoint.requestInputHash ||
      receipt.response.kind !== 'turn' ||
      receipt.response.id !== original.turnId
    )
      throw unavailable();
    // The existing Vault owner still checks the exact declaration, target grant and version.
    const prepared = JSON.parse(originalAttempt.preparationInputJson) as { manifest?: unknown };
    if (prepared.manifest !== undefined) {
      const manifest = AuthoredAgentConfigSchema.parse(prepared.manifest);
      if (manifest.id !== source.admission.requestedAgentId) throw unavailable();
      if ((manifest.sandbox?.credentialDeclarations.length ?? 0) > 0)
        resources.push({
          kind: 'container',
          container: {
            owner: { kind: 'workspace', workspaceId: lineage.workspaceId },
            kind: 'workspace',
            id: lineage.workspaceId,
          },
        });
    }
  }
  return {
    workspaceId: lineage.workspaceId,
    goalId: goal?.goalId ?? null,
    taskThreadId: lineage.threadId,
    turnId: lineage.turnId,
    planVersionId: plan?.planVersionId ?? null,
    agentId: current.admission.requestedAgentId,
    responsibleUserId,
    resources,
    requestInputHash: source.admission.inputHash,
  };
}
