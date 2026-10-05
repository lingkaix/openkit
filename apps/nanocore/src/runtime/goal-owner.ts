import { createHash, randomUUID } from 'node:crypto';
import {
  GOAL_OPERATION_DEFINITIONS,
  type GoalCard,
  GoalCardSchema,
  GoalCommitmentSchema,
  GoalCompletionCandidateSchema,
  type GoalPlanVersion,
  GoalPlanVersionSchema,
  type GoalRecord,
  GoalRecordSchema,
  GoalTaskLinkSchema,
  type GoalView,
  type OperationInput,
} from '@openkit/app-api-schemas';
import { isSealedTurnTerminal, type TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { listWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  commandInputHash,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './idempotent-command.js';
import {
  raiseRecordedPendingRequest,
  resolveCommandIntentApproval,
} from './pending-request-flow.js';
import {
  claimCommandIntentGrant,
  finishPendingExecution,
  invalidateGoalPendingRequests,
  listThreadPendingRequests,
  type PendingRequestRecord,
  readPendingRequest,
  refuseCommandIntentGrant,
} from './pending-requests.js';

type Turn = z.infer<typeof TurnSchema>;
type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I
) => void
  ? I
  : never;
type GoalArguments = Intersect<{ [K in GoalOperationId]: OperationInput<K> }[GoalOperationId]>;

/** Exact Goal family ids. */
export type GoalOperationId = keyof typeof GOAL_OPERATION_DEFINITIONS;
/** Trusted authenticated context; the Coordinator identity is bound to its ordinary Turn. */
export interface GoalOwnerContext {
  readonly actor: Actor;
  readonly coordinatorTurnId?: string;
  /** Existing caller-owned Turn receives origin publication without another admission. */
  readonly originTurnId?: string;
}
/** Process and current authority owners; optional callbacks are supplied by app assembly. */
export interface GoalOwnerServices {
  readonly coreDb?: CoreDb;
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly wake?: (workspaceId: string, goalId: string) => void;
  readonly interrupt?: (turn: Turn) => void;
  readonly grantAuthority?: (record: PendingRequestRecord) => boolean;
}
/** Domain-owned outcomes, preserved by every projection. */
export class GoalCommandError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}
const inflight = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
const now = () => new Date().toISOString();
/** Restores a stored non-secret credential identity without undefined optional properties. */
export function goalActor(goal: GoalRecord): Actor {
  const value = goal.responsibleActorContext;
  return {
    userId: value.userId,
    kind: value.kind,
    ...(value.tokenId ? { tokenId: value.tokenId } : {}),
    ...(value.tokenScope ? { tokenScope: value.tokenScope } : {}),
    ...(value.tokenWorkspaceIds ? { tokenWorkspaceIds: value.tokenWorkspaceIds } : {}),
    ...(value.adminTokenId ? { adminTokenId: value.adminTokenId } : {}),
  };
}
/** Fixed-format digest over the exact immutable Plan bytes. */
export function goalPlanDigest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Reads a validated record without using any historical Goal store. */
function readRecord<T>(
  db: Pick<WorkspaceDb, 'sqlite'>,
  table: string,
  key: string,
  id: string,
  schema: z.ZodType<T>
): T | null {
  const row = db.sqlite.prepare(`SELECT payload_json FROM ${table} WHERE ${key} = ?`).get(id) as
    | { payload_json: string }
    | undefined;
  return row ? schema.parse(JSON.parse(row.payload_json)) : null;
}
/** Goal eligibility stays with its effect owner before either public approval surface records a grant. */
export function checkGoalCommandIntent(
  sqlite: WorkspaceDb['sqlite'],
  request: PendingRequestRecord
): void {
  if (request.requesterKind !== 'coordinator') return;
  const db = { sqlite };
  const goal = readRecord(
    db,
    'goals',
    'goal_id',
    String(request.governedIntent?.goalId),
    GoalRecordSchema
  );
  if (
    !goal ||
    goal.disposition ||
    goal.workspaceId !== request.workspaceId ||
    goal.threadId !== request.threadId ||
    goal.responsibleUserId !== request.responsibleUserId
  )
    throw new GoalCommandError('approval_conflict', 'The open Goal command source is unavailable.');
  if (request.governedIntent?.operation === 'goal.plan.approve') {
    const exact = request.governedIntent;
    const plan = readRecord(
      db,
      'goal_plan_versions',
      'plan_version_id',
      String(exact.planVersionId),
      GoalPlanVersionSchema
    );
    const active = goal.activePlanVersionId
      ? readRecord(
          db,
          'goal_plan_versions',
          'plan_version_id',
          goal.activePlanVersionId,
          GoalPlanVersionSchema
        )
      : null;
    if (
      !plan ||
      plan.goalId !== goal.goalId ||
      plan.pendingRequestId !== request.requestId ||
      plan.bytes !== exact.bytes ||
      plan.digest !== exact.digest ||
      goalPlanDigest(plan.bytes) !== plan.digest ||
      JSON.stringify(plan.commitment) !== plan.bytes ||
      (goal.activePlanVersionId && !active) ||
      (active && active.sequence > plan.sequence)
    )
      throw new GoalCommandError(
        'approval_conflict',
        'The exact eligible Plan version is unavailable or changed.'
      );
  } else if (request.governedIntent?.operation !== 'goal.completion.accept')
    throw new GoalCommandError('approval_conflict', 'The captured Goal operation is unavailable.');
}
/** Writes only the already validated owning record. */
function saveGoal(db: WorkspaceDb, goal: GoalRecord): void {
  db.sqlite
    .prepare(
      'INSERT INTO goals VALUES (?, ?, ?) ON CONFLICT(goal_id) DO UPDATE SET payload_json=excluded.payload_json'
    )
    .run(goal.goalId, goal.threadId, JSON.stringify(GoalRecordSchema.parse(goal)));
}
/** Advances the existing two-field marker in the caller's fact transaction. */
export function advanceGoalRevision(db: WorkspaceDb, goalId: string): void {
  const goal = readRecord(db, 'goals', 'goal_id', goalId, GoalRecordSchema);
  if (goal) saveGoal(db, { ...goal, changeRevision: goal.changeRevision + 1, updatedAt: now() });
}
/** Advances Goals addressed by this Thread or linked to its ordinary Task, inside the source commit. */
export function advanceGoalForThread(
  sqlite: import('better-sqlite3').Database,
  threadId: string
): void {
  for (const row of sqlite
    .prepare(
      'SELECT goal_id,payload_json FROM goals WHERE thread_id=? OR goal_id IN (SELECT goal_id FROM goal_card_tasks WHERE thread_id=?)'
    )
    .all(threadId, threadId) as { goal_id: string; payload_json: string }[]) {
    const goal = GoalRecordSchema.parse(JSON.parse(row.payload_json));
    sqlite
      .prepare('UPDATE goals SET payload_json=? WHERE goal_id=?')
      .run(
        JSON.stringify({ ...goal, changeRevision: goal.changeRevision + 1, updatedAt: now() }),
        row.goal_id
      );
  }
}
/** Lists only the new owner records addressing an ordinary Coordinator Thread. */
export function listGoalsForThread(db: WorkspaceDb, threadId: string): GoalRecord[] {
  return (
    db.sqlite.prepare('SELECT payload_json FROM goals WHERE thread_id=?').all(threadId) as {
      payload_json: string;
    }[]
  ).map((row) => GoalRecordSchema.parse(JSON.parse(row.payload_json)));
}
/** Derives admission and state from ordinary Task Turns; retained citations alone prove neither. */
export function readGoalView(store: FsStore, db: WorkspaceDb, goalId: string): GoalView {
  const goal = readRecord(db, 'goals', 'goal_id', goalId, GoalRecordSchema);
  if (!goal) return { goal: null, cards: [], versions: [], tasks: [], requests: [] };
  const rows = (table: string) =>
    (
      db.sqlite.prepare(`SELECT payload_json FROM ${table} WHERE goal_id=?`).all(goalId) as {
        payload_json: string;
      }[]
    ).map((row) => JSON.parse(row.payload_json) as unknown);
  return {
    goal,
    cards: rows('goal_cards').map((row) => GoalCardSchema.parse(row)),
    versions: rows('goal_plan_versions')
      .map((row) => GoalPlanVersionSchema.parse(row))
      .sort((a, b) => a.sequence - b.sequence),
    tasks: rows('goal_card_tasks').map((row) => {
      const link = GoalTaskLinkSchema.parse(row);
      const missing = !store
        .listThreads(goal.workspaceId)
        .some((thread) => thread.id === link.threadId);
      const turns = missing ? [] : store.listThreadTurns(goal.workspaceId, link.threadId);
      return {
        ...link,
        // Historical reservation timestamps are not admission evidence; the Task Turn owns time.
        admittedAt: turns[0]?.startedAt ?? null,
        missing,
        turns: turns.map((turn) => ({
          turnId: turn.id,
          status: turn.status,
          completedAt: turn.completedAt ?? null,
        })),
      };
    }),
    requests: listThreadPendingRequests(db.sqlite, goal.workspaceId, goal.threadId)
      .filter((r) => r.governedIntent?.goalId === goalId)
      .map((r) => ({
        requestId: r.requestId,
        operation: String(r.governedIntent?.operation),
        state: r.state,
        resolution: r.resolution,
        reason: r.invalidatingEvent ?? r.dispositionReason,
        decidingActorId: r.decidingActor?.id ?? null,
        claim: r.claim,
        disposition: r.disposition,
        exactIntent: { ...r.governedIntent },
      })),
  };
}
/** Current record availability and CAS belong to Goal, not the invocation join. */
function requireOpen(goal: GoalRecord | null): GoalRecord {
  if (!goal) throw new GoalCommandError('not_found', 'Goal not found.', 404);
  if (goal.disposition) throw new GoalCommandError('goal_closed', 'The Goal has ended.');
  return goal;
}
/** Rejects a stale owning revision before any mutation. */
function checkRevision(actual: number, expected: number): void {
  if (actual !== expected)
    throw new GoalCommandError(
      'revision_conflict',
      'The record changed; read its current revision.'
    );
}
/** Refuses model-selected Coordinator identity, Thread, actor, or terminal Turn. */
function coordinatorTurn(context: GoalOwnerContext, store: FsStore, goal: GoalRecord): Turn | null {
  if (!context.coordinatorTurnId) return null;
  const turn = store.getTurnById(context.coordinatorTurnId);
  if (
    turn.workspaceId !== goal.workspaceId ||
    turn.threadId !== goal.threadId ||
    turn.agentId !== 'goal-coordinator' ||
    turn.agentSessionId ||
    turn.status !== 'running' ||
    context.actor.userId !== goal.responsibleUserId
  )
    throw new GoalCommandError(
      'coordinator_authority_denied',
      'Coordinator Turn authority is unavailable.',
      403
    );
  return turn;
}
/** Captures one exact command on the ordinary Pending Request owner. */
function raiseIntent(
  store: FsStore,
  db: WorkspaceDb,
  goal: GoalRecord,
  context: GoalOwnerContext,
  exact: Readonly<Record<string, unknown>>,
  requestId: string,
  title: string,
  proposalTurn?: Turn
): void {
  const coordinator = coordinatorTurn(context, store, goal) ?? proposalTurn;
  const turn = coordinator;
  if (!turn)
    throw new GoalCommandError(
      'recovery_required',
      'The proposal request Turn was not admitted.',
      409
    );
  const itemId = `it_${randomUUID()}`;
  raiseRecordedPendingRequest(store, db.sqlite, {
    requestId,
    workspaceId: goal.workspaceId,
    threadId: goal.threadId,
    raisingTurnId: turn.id,
    requestItemId: itemId,
    kind: 'approval',
    requesterKind: 'coordinator',
    agentId: 'goal-coordinator',
    responsibleUserId: goal.responsibleUserId,
    governedIntent: exact,
    approval: { kind: 'permission', title, description: 'Approve the exact captured commitment.' },
    now: now(),
  });
  store.createItem({
    id: itemId,
    workspaceId: goal.workspaceId,
    threadId: goal.threadId,
    turnId: turn.id,
    type: 'approval-request',
    approvalRequestId: requestId,
    kind: 'permission',
    status: 'completed',
    completedAt: now(),
    title,
    description: 'Approve the exact captured commitment.',
    createdAt: now(),
  });
}
/** Re-evaluates exact authority synchronously before CAS, with no Task effect. */
function consumeGrant(
  store: FsStore,
  db: WorkspaceDb,
  goal: GoalRecord,
  request: PendingRequestRecord,
  services: GoalOwnerServices
): GoalRecord {
  let reason: string | null = goal.disposition ? 'The Goal was cancelled or accepted.' : null;
  if (
    request.state !== 'resolved' ||
    request.resolution !== 'granted' ||
    request.claim !== 'unclaimed' ||
    request.disposition ||
    request.governedIntent?.goalId !== goal.goalId
  )
    reason ??= 'The grant is no longer eligible.';
  if (
    (services.grantAuthority && !services.grantAuthority(request)) ||
    (services.coreDb &&
      (!request.decidingActorContext ||
        !authorizeWorkspace(services.coreDb, request.decidingActorContext, goal.workspaceId, {
          policyOperation: 'workspace.write',
          mutating: true,
        })))
  )
    reason ??= 'The deciding actor is no longer authorized.';
  const exact = request.governedIntent;
  let version: GoalPlanVersion | null = null;
  if (exact?.operation === 'goal.plan.approve') {
    version = readRecord(
      db,
      'goal_plan_versions',
      'plan_version_id',
      String(exact.planVersionId),
      GoalPlanVersionSchema
    );
    if (
      !version ||
      version.goalId !== goal.goalId ||
      version.bytes !== exact.bytes ||
      version.pendingRequestId !== request.requestId ||
      version.digest !== exact.digest ||
      goalPlanDigest(version.bytes) !== version.digest ||
      JSON.stringify(version.commitment) !== version.bytes
    )
      reason ??= 'The exact Plan version is unavailable or changed.';
    const active = goal.activePlanVersionId
      ? readRecord(
          db,
          'goal_plan_versions',
          'plan_version_id',
          goal.activePlanVersionId,
          GoalPlanVersionSchema
        )
      : null;
    if (goal.activePlanVersionId && !active)
      reason ??= 'The current active Plan version is unavailable.';
    if (version && active && active.sequence > version.sequence)
      reason ??= 'An obsolete proposal cannot replace a later active version.';
  } else if (exact?.operation === 'goal.completion.accept') {
    const candidate = GoalCompletionCandidateSchema.parse(exact.candidate);
    if (
      candidate.intent !== goal.intent ||
      candidate.intentRevision !== goal.intentRevision ||
      candidate.planVersionId !== goal.activePlanVersionId
    )
      reason ??= 'The completion candidate no longer matches current intent and Plan.';
    for (const evidence of candidate.evidence) {
      let current: unknown;
      try {
        current =
          evidence.kind === 'artifact'
            ? store.getArtifact(goal.workspaceId, evidence.id)
            : evidence.kind === 'capability-call'
              ? listWorkspaceCapabilityCalls(db, goal.workspaceId).find(
                  (row) => row.id === evidence.id
                )
              : evidence.kind === 'evidence-bundle'
                ? listWorkspaceEvidenceBundles(db, goal.workspaceId).find(
                    (row) => row.id === evidence.id
                  )
                : evidence.kind === 'knowledge-source'
                  ? store
                      .listKnowledgeSources(goal.workspaceId)
                      .find((row) => row.id === evidence.id)
                  : store
                      .listThreads(goal.workspaceId)
                      .flatMap((thread) => store.listThreadItems(goal.workspaceId, thread.id))
                      .find((item) => item.id === evidence.id);
      } catch {
        current = undefined;
      }
      const source = current as { workspaceId?: string; threadId?: string } | undefined;
      const actor = request.decidingActorContext;
      if (
        !source ||
        source.workspaceId !== goal.workspaceId ||
        (source.threadId &&
          (!actor ||
            !isThreadIdVisible(
              store,
              goal.workspaceId,
              source.threadId,
              actor.userId,
              Boolean(services.coreDb && isCurrentDeploymentAdministrator(services.coreDb, actor))
            ))) ||
        commandInputHash(current) !== evidence.digest
      )
        reason ??= 'The named evidence is unavailable, unauthorized or changed.';
    }
  } else reason ??= 'The captured Goal operation is unavailable.';
  if (reason) {
    refuseCommandIntentGrant(db.sqlite, request.requestId, reason, now());
    // Return the refusal outside the transaction so its non-execution remains durable.
    throw new GoalCommandError('grant_conflict', reason);
  }
  if (!claimCommandIntentGrant(db.sqlite, request.requestId, now()))
    throw new GoalCommandError('grant_conflict', 'Invalidation won before the claim.');
  const next: GoalRecord =
    exact?.operation === 'goal.plan.approve'
      ? {
          ...goal,
          activePlanVersionId: version!.planVersionId,
          proposedPlanVersionId:
            goal.proposedPlanVersionId === version!.planVersionId
              ? null
              : goal.proposedPlanVersionId,
        }
      : {
          ...goal,
          disposition: {
            kind: 'accepted',
            candidate: GoalCompletionCandidateSchema.parse(exact?.candidate),
            pendingRequestId: request.requestId,
            actorId: request.decidingActor!.id,
            at: now(),
          },
        };
  finishPendingExecution(
    db.sqlite,
    request.requestId,
    'approved-executed',
    null,
    { goalId: goal.goalId },
    now()
  );
  saveGoal(db, next);
  return next;
}
/** Executes the sole ten-operation family with owning receipts and same-commit wake revisions. */
export async function executeGoalOperation<K extends GoalOperationId>(
  id: K,
  value: OperationInput<K>,
  context: GoalOwnerContext,
  store: FsStore,
  db: WorkspaceDb,
  services: GoalOwnerServices = {}
): Promise<GoalView> {
  const input = GOAL_OPERATION_DEFINITIONS[id].inputSchema.parse(value) as GoalArguments;
  const goalId =
    typeof input.goalId === 'string'
      ? input.goalId
      : id === 'goal.read'
        ? (listGoalsForThread(db, input.threadId)[0]?.goalId ?? 'absent')
        : `g_${input.requestId}`;
  let goal = readRecord(db, 'goals', 'goal_id', goalId, GoalRecordSchema);
  if (
    goal &&
    (('threadId' in input && goal.threadId !== input.threadId) ||
      goal.workspaceId !== input.workspaceId)
  )
    throw new GoalCommandError('not_found', 'Goal not found.', 404);
  if (id === 'goal.read') return readGoalView(store, db, goalId);
  if (
    services.coreDb &&
    !authorizeWorkspace(services.coreDb, context.actor, input.workspaceId, {
      policyOperation: 'workspace.write',
      mutating: true,
    })
  )
    throw new GoalCommandError(
      'workspace_access_denied',
      'Current write authority is unavailable.',
      403
    );
  if (context.coordinatorTurnId && (id === 'goal.cancel' || id === 'goal.create'))
    throw new GoalCommandError(
      'coordinator_authority_denied',
      'Only a person may create or cancel a Goal.',
      403
    );
  if (goal) coordinatorTurn(context, store, goal);
  const commandInput = input as Exclude<typeof input, { requestId?: never }> & {
    requestId: string;
  };
  let proposalTurn: Turn | undefined;
  if (
    id === 'goal.plan.propose' &&
    !context.coordinatorTurnId &&
    goal &&
    !store.getCommandRequest(
      'goal.plan.propose',
      commandInput.requestId,
      {
        workspaceId: goal.workspaceId,
        threadId: goal.threadId,
        actorId: context.actor.userId,
      },
      db
    )
  ) {
    requireOpen(goal);
    checkRevision(goal.changeRevision, input.expectedRevision);
    if (
      store
        .listThreadTurns(goal.workspaceId, goal.threadId)
        .some((turn) => !isSealedTurnTerminal(turn.status))
    )
      throw new GoalCommandError('thread_busy', 'The Goal Thread already has a Turn in flight.');
    // Ordinary admission can freeze ready outcomes through its own SQL connection; admit before the Goal transaction.
    proposalTurn = store.createTurn(
      goal.workspaceId,
      goal.threadId,
      'Propose a Goal Plan',
      { kind: 'user', id: context.actor.userId },
      undefined,
      { executorKind: 'coordinator', agentId: 'goal-coordinator' }
    );
  }
  let result: GoalView;
  try {
    result = await runIdempotentCommand({
      store,
      inflightCommands: services.inflightCommands ?? inflight,
      command: id as Exclude<GoalOperationId, 'goal.read'>,
      requestId: commandInput.requestId,
      scope: {
        workspaceId: input.workspaceId,
        actorId: context.actor.userId,
        ...(goal && id !== 'goal.create' ? { threadId: goal.threadId } : {}),
      },
      input,
      responseKind: 'goal',
      responseId: () => goalId,
      workspaceDb: db,
      workspaceTransaction: true,
      execute: () => {
        if (id === 'goal.create' && 'intent' in input) {
          if (goal) throw new GoalCommandError('revision_conflict', 'Goal already exists.');
          const origin = 'originThreadId' in input ? input.originThreadId : undefined;
          if (
            origin &&
            !isThreadIdVisible(
              store,
              input.workspaceId,
              origin,
              context.actor.userId,
              Boolean(
                services.coreDb && isCurrentDeploymentAdministrator(services.coreDb, context.actor)
              )
            )
          )
            throw new GoalCommandError('not_found', 'Origin Thread not found.', 404);
          const thread = store.createThread(
            input.workspaceId,
            input.intent.slice(0, 100),
            `th_goal_${commandInput.requestId}`,
            'conversation',
            { visibility: 'workspace' }
          );
          const at = now();
          goal = {
            goalId,
            workspaceId: input.workspaceId,
            threadId: thread.id,
            responsibleUserId: context.actor.userId,
            responsibleActorContext: context.actor,
            intent: input.intent,
            intentRevision: 0,
            intentHistory: [
              { revision: 0, intent: input.intent, actorId: context.actor.userId, at },
            ],
            proposedPlanVersionId: null,
            activePlanVersionId: null,
            disposition: null,
            changeRevision: 0,
            consideredRevision: 0,
            createdAt: at,
            updatedAt: at,
          };
          saveGoal(db, goal);
        } else if (
          context.coordinatorTurnId &&
          (id === 'goal.plan.approve' || id === 'goal.completion.accept') &&
          input.pendingRequestId
        ) {
          const request = readPendingRequest(db.sqlite, input.pendingRequestId);
          if (!request || !goal)
            throw new GoalCommandError('not_found', 'Exact Goal request not found.', 404);
          if (request.state === 'pending')
            throw new GoalCommandError(
              'coordinator_self_approval_denied',
              'The Coordinator cannot resolve its own approval.',
              403
            );
          goal = consumeGrant(store, db, goal, request, services);
        } else {
          goal = requireOpen(readRecord(db, 'goals', 'goal_id', goalId, GoalRecordSchema));
          if (id === 'goal.intent.revise' && 'intent' in input && 'expectedRevision' in input) {
            checkRevision(goal.intentRevision, input.expectedRevision);
            const at = now();
            goal = {
              ...goal,
              intent: input.intent,
              intentRevision: goal.intentRevision + 1,
              intentHistory: [
                ...goal.intentHistory,
                {
                  revision: goal.intentRevision + 1,
                  intent: input.intent,
                  actorId: context.actor.userId,
                  at,
                },
              ],
            };
            saveGoal(db, goal);
          } else if (id === 'goal.card.create' && 'description' in input && 'priority' in input) {
            const card: GoalCard = {
              cardId: `gc_${commandInput.requestId}`,
              goalId,
              description: input.description,
              priority: input.priority,
              revision: 0,
              cancelled: false,
              cancellationReason: null,
              createdAt: now(),
              updatedAt: now(),
            };
            db.sqlite
              .prepare('INSERT INTO goal_cards VALUES (?,?,?)')
              .run(card.cardId, goalId, JSON.stringify(card));
          } else if ((id === 'goal.card.edit' || id === 'goal.card.cancel') && 'cardId' in input) {
            const card = readRecord(db, 'goal_cards', 'card_id', input.cardId, GoalCardSchema);
            if (!card || card.goalId !== goalId)
              throw new GoalCommandError('not_found', 'Card not found.', 404);
            checkRevision(card.revision, input.expectedRevision);
            if (card.cancelled)
              throw new GoalCommandError('card_cancelled', 'Card has been cancelled.');
            const next =
              id === 'goal.card.cancel'
                ? {
                    ...card,
                    cancelled: true,
                    cancellationReason: input.reason,
                    revision: card.revision + 1,
                    updatedAt: now(),
                  }
                : {
                    ...card,
                    description: input.description,
                    priority: input.priority,
                    revision: card.revision + 1,
                    updatedAt: now(),
                  };
            db.sqlite
              .prepare('UPDATE goal_cards SET payload_json=? WHERE card_id=?')
              .run(JSON.stringify(next), card.cardId);
          } else if (id === 'goal.plan.propose' && 'commitment' in input) {
            checkRevision(goal.changeRevision, input.expectedRevision);
            const commitment = GoalCommitmentSchema.parse(input.commitment);
            const versions = readGoalView(store, db, goalId).versions;
            const bytes = JSON.stringify(commitment);
            const version: GoalPlanVersion = {
              planVersionId: `gp_${commandInput.requestId}`,
              goalId,
              sequence: (versions.at(-1)?.sequence ?? 0) + 1,
              bytes,
              digest: goalPlanDigest(bytes),
              commitment,
              pendingRequestId: `ap_${commandInput.requestId}`,
              createdAt: now(),
            };
            invalidateGoalPendingRequests(
              db.sqlite,
              goalId,
              'Superseded by a newer Plan proposal.',
              { kind: 'user', id: context.actor.userId },
              now(),
              true
            );
            db.sqlite
              .prepare('INSERT INTO goal_plan_versions VALUES (?,?,?)')
              .run(version.planVersionId, goalId, JSON.stringify(version));
            saveGoal(db, { ...goal, proposedPlanVersionId: version.planVersionId });
            raiseIntent(
              store,
              db,
              goal,
              context,
              {
                operation: 'goal.plan.approve',
                goalId,
                planVersionId: version.planVersionId,
                digest: version.digest,
                bytes,
              },
              version.pendingRequestId,
              'Approve Goal Plan',
              proposalTurn
            );
          } else if (id === 'goal.cancel' && 'reason' in input) {
            checkRevision(goal.changeRevision, input.expectedRevision);
            saveGoal(db, {
              ...goal,
              disposition: {
                kind: 'cancelled',
                reason: input.reason,
                actorId: context.actor.userId,
                at: now(),
              },
            });
            invalidateGoalPendingRequests(
              db.sqlite,
              goalId,
              'The Goal was cancelled.',
              { kind: 'user', id: context.actor.userId },
              now()
            );
          } else if (id === 'goal.completion.accept' && 'candidate' in input && input.candidate) {
            if (!coordinatorTurn(context, store, goal))
              throw new GoalCommandError(
                'coordinator_required',
                'A Coordinator captures completion; a person resolves its exact request.',
                403
              );
            raiseIntent(
              store,
              db,
              goal,
              context,
              {
                operation: 'goal.completion.accept',
                goalId,
                candidate: GoalCompletionCandidateSchema.parse(input.candidate),
              },
              `ap_${commandInput.requestId}`,
              'Accept exact Goal completion'
            );
          } else if (
            (id === 'goal.plan.approve' || id === 'goal.completion.accept') &&
            'pendingRequestId' in input &&
            input.pendingRequestId &&
            input.decision
          ) {
            if (context.coordinatorTurnId)
              throw new GoalCommandError(
                'coordinator_self_approval_denied',
                'The Coordinator cannot resolve its own approval.',
                403
              );
            const request = readPendingRequest(db.sqlite, input.pendingRequestId);
            if (
              !request ||
              request.governedIntent?.goalId !== goalId ||
              request.governedIntent.operation !== id
            )
              throw new GoalCommandError('not_found', 'Exact Goal request not found.', 404);
            resolveCommandIntentApproval({
              store,
              sqlite: db.sqlite,
              record: request,
              decision: input.decision,
              actor: context.actor,
              coreDb: services.coreDb,
              checkCommandIntent: checkGoalCommandIntent,
            });
          } else
            throw new GoalCommandError(
              'invalid_request',
              'The operation arguments do not select one valid effect.',
              400
            );
        }
        advanceGoalRevision(db, goalId);
        return readGoalView(store, db, goalId);
      },
      replay: () => readGoalView(store, db, goalId),
    });
  } catch (error) {
    if (
      context.coordinatorTurnId &&
      input.pendingRequestId &&
      error instanceof GoalCommandError &&
      error.code === 'grant_conflict'
    )
      db.sqlite.transaction(() => {
        if (refuseCommandIntentGrant(db.sqlite, input.pendingRequestId, error.message, now()))
          advanceGoalRevision(db, goalId);
      })();
    if (proposalTurn)
      store.updateTurn(proposalTurn.id, {
        status: 'failed',
        completedAt: now(),
        error: {
          code: 'goal_plan_refused',
          message: error instanceof Error ? error.message : 'Plan proposal failed.',
        },
      });
    throw error;
  }
  if (proposalTurn) store.updateTurn(proposalTurn.id, { status: 'completed', completedAt: now() });
  if (id === 'goal.create' && input.originThreadId && result.goal) {
    // The committed Goal is authority; publish its replayable origin snapshot outside SQL admission.
    const origin = input.originThreadId;
    const itemId = `it_goal_handoff_${goalId}`;
    if (!store.listThreadItems(input.workspaceId, origin).some((item) => item.id === itemId)) {
      const turn = context.originTurnId
        ? store.getTurnById(context.originTurnId)
        : store.createTurn(
            input.workspaceId,
            origin,
            'Goal handoff',
            { kind: 'user', id: context.actor.userId },
            undefined,
            { turnId: `tr_goal_handoff_${commandInput.requestId}` }
          );
      if (
        turn.workspaceId !== input.workspaceId ||
        turn.threadId !== origin ||
        turn.triggerActor.id !== context.actor.userId
      )
        throw new GoalCommandError(
          'origin_authority_denied',
          'The origin Turn does not belong to this handoff.',
          403
        );
      const at = now();
      store.createItem({
        id: itemId,
        workspaceId: input.workspaceId,
        threadId: origin,
        turnId: turn.id,
        type: 'assistant-message',
        text: `Goal created: ${goalId} (${result.goal.threadId})`,
        status: 'completed',
        completedAt: at,
        createdAt: at,
      });
      if (!context.originTurnId)
        store.updateTurn(turn.id, { status: 'completed', completedAt: at });
    }
  }

  if (id === 'goal.cancel' || id === 'goal.card.cancel')
    for (const link of result.tasks.filter((task) => !task.missing))
      if (id === 'goal.cancel' || ('cardId' in input && link.cardId === input.cardId))
        for (const turn of store.listThreadTurns(input.workspaceId, link.threadId))
          if (!isSealedTurnTerminal(turn.status)) services.interrupt?.(turn);
  services.wake?.(input.workspaceId, goalId);
  return result;
}
