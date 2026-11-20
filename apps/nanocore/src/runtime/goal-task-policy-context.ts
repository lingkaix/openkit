import { isDeepStrictEqual } from 'node:util';
import { GoalTaskLinkSchema } from '@openkit/app-api-schemas';
import {
  deriveEntityId,
  isSealedTurnTerminal,
  type PolicyResourceV1Schema,
  responsibleUserIdForActor,
  type Turn,
  TurnSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import type { z } from 'zod';
import {
  deriveArtifactReviewFollowUpTurnId,
  deriveArtifactReviewWorkerRequestId,
  listExportableArtifactReviews,
} from '../artifact-reviews.js';
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
import { readProduct } from '../storage/control-store-product-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { findExternalTriggerAdmissionForQueue } from '../storage/external-trigger-admissions.js';
import { findAcceptedRecurringOccurrenceForQueue } from '../storage/recurring-records.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  conversationTaskThreadId,
  conversationTaskTurnId,
  providerChatTurnId,
} from './conversation-identity.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';
import { readExternalTriggerPollSource } from './external-trigger-source.js';
import { goalPlanDigest, readNativeGoalView } from './goal-owner.js';
import { listThreadPendingRequests, pendingRequestSystemActor } from './pending-requests.js';
import { readScheduledAdmissionText } from './scheduler-dispatch-input.js';
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
  /** Original prepared environment manifest revision; never a current catalog or new grant. */
  readonly environmentRevision?: string;
}

/** Canonical Turn content remains required; a metadata-only projection cannot establish Task authority. */
export type GoalTaskPolicyReadPort = Pick<
  FsStore,
  'getTurnMetadata' | 'getThread' | 'getTurn' | 'getThreadItem'
>;

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
    // Native Turn metadata and the owning admission are durable even after command pruning.
    // These reads use the caller's existing Workspace/Core views, never another connection.
    const creation = (entry: (typeof entries)[number]) => {
      const snapshot = readProduct(
        db.sqlite,
        { kind: 'workspace', workspaceId: lineage.workspaceId },
        'turn',
        entry.turnId
      );
      if (!snapshot || schedulerAdmissionInputHash(entry) !== entry.inputHash) throw unavailable();
      const turn = TurnSchema.parse({ ...snapshot.record, items: [] });
      if (
        turn.threadId !== entry.threadId ||
        workspaceIdForOwner(turn.owner) !== entry.workspaceId ||
        turn.agentId !== entry.requestedAgentId ||
        !isDeepStrictEqual(turn.triggerActor, entry.triggerActor)
      )
        throw unavailable();
      const taskIdentity =
        entry.requestId !== null &&
        deriveEntityId('tu', {
          command: 'task.start',
          actorId: entry.triggerActor.id,
          workspaceId: entry.workspaceId,
          threadId: entry.threadId,
          requestId: entry.requestId,
        }) === entry.turnId;
      // startProductTurn owns this original input identity; it survives receipt pruning.
      const ordinaryIdentity =
        entry.requestId !== null &&
        deriveEntityId('tu', [
          JSON.stringify(entry.triggerActor),
          entry.workspaceId,
          entry.threadId,
          entry.requestId,
          null,
        ]) === entry.turnId;
      const activationIdentity =
        entry.triggerActor.kind === 'user' &&
        entry.requestId !== null &&
        deriveEntityId('tu', {
          command: 'worker_environment.activate',
          actorId: entry.triggerActor.id,
          workspaceId: entry.workspaceId,
          threadId: entry.threadId,
          requestId: entry.requestId,
        }) === entry.turnId;
      const kind = turn.triggerSource?.kind;
      // The exact Task command identity is a positive Task cause before ordinary-kind checks.
      // Required Task preparation still applies; an absent kind never proves NON-Task.
      if (
        (taskIdentity && kind !== undefined && kind !== 'handoff') ||
        ((ordinaryIdentity || activationIdentity) && kind === 'handoff')
      )
        throw unavailable();
      return {
        turn,
        kind,
        taskIdentity,
        ordinaryIdentity,
        activationIdentity,
        revision: snapshot.revision,
      };
    };
    const originals = entries.filter((entry) => {
      const checkpoint = getWorkerCheckpoint(db, entry.workspaceId, entry.threadId, entry.turnId);
      if (checkpoint?.goalId || checkpoint?.taskId) throw unavailable();
      const source = creation(entry);
      return (
        entry.requestId &&
        responsibleUserIdForActor(entry.triggerActor) &&
        (source.taskIdentity || source.kind === 'handoff')
      );
    });
    const exact = originals.find((entry) => entry.turnId === lineage.turnId);
    if (exact) return exact;
    // Pending owns outcome ancestry; its retained delivery cannot be replaced by a new input.
    const pending = listThreadPendingRequests(db.sqlite, lineage.workspaceId, lineage.threadId);
    const reviews = listExportableArtifactReviews(db);
    let sourceTurnId = lineage.turnId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(sourceTurnId)) throw unavailable();
      visited.add(sourceTurnId);
      const causes = pending.filter(
        (record) =>
          record.deliveryTurnId === sourceTurnId &&
          record.deliveryCause === 'outcome' &&
          record.requesterKind === 'worker'
      );
      const reviewCauses = reviews.filter((review) => review.followUpTurnId === sourceTurnId);
      if (causes.length && reviewCauses.length) throw unavailable();
      const receiving = entries.find((entry) => entry.turnId === sourceTurnId);
      if (!receiving) throw unavailable();
      const source = creation(receiving);
      if (!causes.length && !reviewCauses.length) {
        if (source.kind !== 'user-input' && source.kind !== 'automation') throw unavailable();
        break;
      }
      if (reviewCauses.length) {
        const review = reviewCauses[0]!;
        if (
          reviewCauses.length !== 1 ||
          source.kind !== 'approval-resolution' ||
          (review.decision !== 'redo' && review.decision !== 'needs_refinement') ||
          !review.decisionRequestId ||
          !review.sourceTurnId ||
          review.workspaceId !== receiving.workspaceId ||
          review.sourceThreadId !== receiving.threadId ||
          review.sourceAgentId !== receiving.requestedAgentId ||
          source.turn.triggerActor.kind !== 'user' ||
          review.decisionActorId !== source.turn.triggerActor.id ||
          deriveArtifactReviewWorkerRequestId(review.decisionRequestId) !== receiving.requestId ||
          deriveArtifactReviewFollowUpTurnId(
            review.workspaceId,
            review.artifactId,
            review.artifactVersion,
            review.decisionRequestId
          ) !== receiving.turnId
        )
          throw unavailable();
        const origin = entries.find((entry) => entry.turnId === review.sourceTurnId);
        if (!origin || origin.requestedAgentId !== review.sourceAgentId) throw unavailable();
        sourceTurnId = review.sourceTurnId;
        const original = originals.find((entry) => entry.turnId === sourceTurnId);
        if (original) return original;
        continue;
      }
      const kind = causes.some((record) => record.kind === 'approval')
        ? 'approval-resolution'
        : 'user-input';
      if (
        source.kind !== kind ||
        causes.some(
          (record) =>
            record.agentId !== receiving.requestedAgentId ||
            responsibleUserIdForActor(source.turn.triggerActor) !== record.responsibleUserId
        )
      )
        throw unavailable();
      const sources = new Set(causes.map((record) => record.raisingTurnId));
      if (sources.size !== 1) throw unavailable();
      sourceTurnId = causes[0]!.raisingTurnId;
      const original = originals.find((entry) => entry.turnId === sourceTurnId);
      if (original) return original;
    }
    // Preserve the Task owner's ceiling for an unambiguous continuation on its Thread.
    if (originals.length > 1) throw unavailable();
    if (originals.length === 1) return originals[0]!;
    const entry = entries.find((value) => value.turnId === sourceTurnId);
    if (!entry) throw unavailable();
    const source = creation(entry);
    if (source.kind === 'user-input' && (source.ordinaryIdentity || source.activationIdentity))
      return null;
    if (source.kind === 'automation') {
      const recurring = findAcceptedRecurringOccurrenceForQueue(coreDb, entry.queueEntryId);
      const external = findExternalTriggerAdmissionForQueue(coreDb, entry.queueEntryId);
      if (recurring && !external && recurring.turnId === entry.turnId) return null;
      if (external && !recurring) {
        const poll = readExternalTriggerPollSource(coreDb, external.sourceTurnId);
        const thread = readProduct(
          db.sqlite,
          { kind: 'workspace', workspaceId: lineage.workspaceId },
          'thread',
          entry.threadId
        );
        if (
          entry.triggerActor.kind === 'automation' &&
          entry.triggerActor.id === external.scheduleId &&
          poll.occurrence.scheduleId === external.scheduleId &&
          poll.entry.workspaceId === entry.workspaceId &&
          poll.entry.threadId !== entry.threadId &&
          thread?.record.parentThreadId === poll.entry.threadId &&
          isDeepStrictEqual(poll.entry.triggerActor, entry.triggerActor)
        )
          return null;
      }
    }
    throw unavailable();
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

/** Proves an original conversation Task from the retained native handoff and both Turn identities. */
function hasCollectedConversationTaskOrigin(input: {
  readonly workspaceId: string;
  readonly store: GoalTaskPolicyReadPort;
  readonly turn: Turn;
  readonly requestId: string;
}): boolean {
  const { workspaceId, store, turn, requestId } = input;
  const { threadId, triggerActor } = turn;
  const originThreadId = store.getThread(workspaceId, threadId).parentThreadId;
  if (
    !originThreadId ||
    originThreadId === threadId ||
    conversationTaskThreadId(triggerActor, workspaceId, originThreadId, requestId) !== threadId ||
    conversationTaskTurnId(triggerActor, workspaceId, originThreadId, threadId, requestId) !==
      turn.id
  )
    return false;

  const originTurnId = providerChatTurnId(triggerActor, workspaceId, originThreadId, requestId);
  const origin = store.getTurnMetadata(workspaceId, originThreadId, originTurnId);
  if (
    origin.id !== originTurnId ||
    origin.status !== 'completed' ||
    workspaceIdForOwner(origin.owner) !== workspaceId ||
    origin.threadId !== originThreadId ||
    !isDeepStrictEqual(origin.triggerActor, triggerActor)
  )
    return false;

  // The conversation producer commits this exact link before admitting the receiving Worker.
  const reference = store.getThreadItem(
    workspaceId,
    originThreadId,
    deriveEntityId('it', ['chat-worker-handoff', originTurnId])
  );
  return (
    reference.type === 'status' &&
    reference.status === 'completed' &&
    workspaceIdForOwner(reference.owner) === workspaceId &&
    reference.threadId === originThreadId &&
    reference.turnId === originTurnId &&
    reference.causationId === turn.id
  );
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
    const turnInput = readScheduledAdmissionText(coreDb, admission);
    if (turnInput === null) throw unavailable();
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
      (!outcomeInitiated && initiatingItem.text !== turnInput) ||
      (checkpoint
        ? checkpoint.requestId !== admission.requestId ||
          (link && checkpoint.requestInputHash !== commandInputHash({ input: turnInput })) ||
          (checkpoint.workerSessionId !== null &&
            checkpoint.workerSessionId !== scope.agentSessionId)
        : isSealedTurnTerminal(turn.status) &&
          (attempt.phase !== 'closed' || attempt.disposition !== 'accepted' || !attempt.fenceRef))
    )
      throw unavailable();
    return { admission, turn, checkpoint, turnInput };
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
  const request = StructuredWorkerDelegationRequestSchema.parse(JSON.parse(source.turnInput));
  // Only the original Task preparation owns this required checkpoint and structured digest.
  if (
    serializeStructuredWorkerDelegationRequest(request) !== source.turnInput ||
    (source.checkpoint
      ? source.checkpoint.contextDigest !== commandInputHash(request)
      : !isSealedTurnTerminal(source.turn.status))
  )
    throw unavailable();
  const selected = request.resources.flatMap((value) =>
    value.kind === 'policy' ? [value.resource] : []
  );
  const structuredInputHash = commandInputHash({ input: source.turnInput });
  const nativeSelection =
    !link && selected.length === 0 && source.checkpoint?.requestInputHash !== structuredInputHash;
  const originalCommand = nativeSelection
    ? getCommandRequestRecordFromDb(
        db,
        commandRequestKey('task.start', source.admission.requestId!, {
          actorId: source.admission.triggerActor.id,
          workspaceId: lineage.workspaceId,
          threadId: lineage.threadId,
        }),
        new Date().toISOString()
      )
    : null;
  // The original source above already proves a closed, accepted and fenced attempt
  // when the terminal checkpoint is absent.
  const conversationSelection =
    nativeSelection &&
    !source.checkpoint &&
    !originalCommand &&
    source.turn.triggerSource?.kind === 'handoff' &&
    hasCollectedConversationTaskOrigin({
      workspaceId: lineage.workspaceId,
      store,
      turn: source.turn,
      requestId: source.admission.requestId!,
    });
  const naturalSelection =
    nativeSelection &&
    (originalCommand
      ? originalCommand.inputHash !== structuredInputHash
      : Boolean(source.checkpoint) || conversationSelection);
  const environmentRecord =
    naturalSelection || selected.some((resource) => resource.kind === 'mcp-tool')
      ? requireAgentEnvironmentPackageSnapshot(db, lineage.workspaceId, originalAttempt.inputRef)
      : null;
  const environment = environmentRecord?.snapshot;
  if (
    environment &&
    (environment.scope.workspaceId !== lineage.workspaceId ||
      environment.scope.threadId !== lineage.threadId ||
      environment.scope.turnId !== original.turnId ||
      environment.scope.agentSessionId !== originalAttempt.agentSessionId ||
      environment.agent.agentId !== source.admission.requestedAgentId ||
      (conversationSelection &&
        (environment.scope.requestId !== source.admission.requestId ||
          !isDeepStrictEqual(environment.scope.triggerActor, source.turn.triggerActor))))
  )
    throw unavailable();
  // Resolved credentials belong to the validated immutable AEP, not the authored grammar,
  // which intentionally refuses direct runtime-token grants before native resolution.
  const selectsCredentials = (environment?.credentials.declarations.length ?? 0) > 0;
  if (
    (nativeSelection &&
      (source.checkpoint || conversationSelection) &&
      (!environment || selectsCredentials) &&
      !originalCommand) ||
    (originalCommand &&
      (originalCommand.response.kind !== 'turn' ||
        originalCommand.response.id !== original.turnId ||
        (source.checkpoint && originalCommand.inputHash !== source.checkpoint.requestInputHash)))
  )
    throw unavailable();
  // Native preparation already records this finite manifest and its environment revision.
  // It is a Task ceiling only: no caller, credential, approval or Thread authority comes from supply.
  const declaredTools = (environment?.supply.mcpServers ?? []).flatMap((server) =>
    server.allowedTools
      .filter((toolName) => toolName !== '*')
      .map((toolName) => ({
        kind: 'mcp-tool' as const,
        workspaceId: lineage.workspaceId,
        serverId: server.id,
        toolName,
      }))
  );
  const resources = selected.filter(
    (resource) =>
      resource.kind !== 'mcp-tool' ||
      declaredTools.some((declared) => commandInputHash(declared) === commandInputHash(resource))
  );
  if (naturalSelection) {
    // Native conversation Task preparation can select Tools without a task.start command.
    // Credential selection still requires that exact direct Task receipt, as above.
    // Explicit structured empty selections enter neither path.
    resources.push(...declaredTools);
    // The existing Vault owner still checks the exact declaration, target grant and version.
    if (selectsCredentials)
      resources.push({
        kind: 'container',
        container: {
          owner: { kind: 'workspace', workspaceId: lineage.workspaceId },
          kind: 'workspace',
          id: lineage.workspaceId,
        },
      });
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
    ...(environmentRecord ? { environmentRevision: environmentRecord.contentDigest } : {}),
  };
}
