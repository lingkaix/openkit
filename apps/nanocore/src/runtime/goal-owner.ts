import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  GOAL_OPERATION_DEFINITIONS,
  type GoalCard,
  GoalCardSchema,
  type GoalPlanVersion,
  GoalPlanVersionSchema,
  type GoalRecord,
  GoalRecordSchema,
  GoalTaskLinkSchema,
  type GoalView,
  type OperationInput,
} from '@openkit/app-api-schemas';
import {
  ActorRefSchema,
  allocateEntityId,
  type CapabilityCall,
  deriveEntityId,
  type Item,
  ItemSchema,
  isSealedTurnTerminal,
  PolicyDelegationV1Schema,
  PolicyDocumentV1Schema,
  RequestIdSchema,
  readRetainedV1,
  ThreadIdSchema,
  ThreadSchema,
  TurnIdSchema,
  TurnSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  isCurrentDeploymentAdministrator,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { listWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { commandRequestKey, type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { type GoalDomainPolicyService, goalDomainSupportError } from '../policy/goal-domains.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { evaluateWorkspaceResourceAccess } from '../policy/workspace-resource-access.js';
import {
  mapCommandRequestRow,
  readCommandRequestRecordsFromSqlite,
  recordControlCommandRequestRecordInDb,
} from '../storage/command-request-records.js';
import { prepareControlPendingCommands } from '../storage/control-store-pending.js';
import type { ControlContentPreparation } from '../storage/control-store-products.js';
import {
  applyControlProducts,
  assertControlProductWriter,
  type ControlProductContentMount,
  ControlProductEntrySchema,
  type PreparedControlEntry,
  prepareControlEntries,
  prepareRetainedControlEntries,
  readProduct,
} from '../storage/control-store-products.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { prepareImmutableProductJson } from '../storage/immutable-content.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  StoredGoalCardTaskV1Schema,
  StoredGoalCardV1Schema,
  StoredGoalCommitmentV1Schema,
  StoredGoalCompletionCandidateV1Schema,
  StoredGoalPlanVersionV1Schema,
  StoredGoalV1Schema,
  StoredTaskTerminalFactV1Schema,
} from './goal-retained-v1.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type IdempotentCommandReceipt,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './idempotent-command.js';
import { projectApprovalEffect } from './pending-request-disclosure.js';
import {
  applyControlPendingCommand,
  ControlPendingCommandInputSchema,
  claimCommandIntentGrant,
  denyPendingRequest,
  finishPendingExecution,
  grantCommandIntentRequest,
  invalidateGoalPendingRequests,
  isCommandIntentApproval,
  isReadyOutcome,
  listThreadPendingRequests,
  type PendingRequestRecord,
  type PreparedControlPendingCommand,
  projectApprovalRequest,
  raisePendingRequest,
  readPendingRequest,
  refuseCommandIntentGrant,
  validateCanonicalLoad,
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
  /** Receipt-free create bound by the Assistant's frozen, confirmed pending outcome. */
  readonly assistantHandoff?: {
    readonly originThreadId: string;
    readonly originTurnId: string;
    readonly sourceHash: string;
  };
}
/** Process and current authority owners; optional callbacks are supplied by app assembly. */
export interface GoalOwnerServices {
  readonly coreDb?: CoreDb;
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly wake?: (workspaceId: string, goalId: string) => void | Promise<void>;
  readonly interrupt?: (turn: Turn) => void;
  readonly grantAuthority?: (record: PendingRequestRecord) => boolean;
  /** Native publication uses the recorded deciding credential and the caller-owned DB lifetime. */
  readonly goalDomain?: {
    readonly forActor: (actor: Actor, db: WorkspaceDb) => GoalDomainPolicyService;
    readonly currentRevision: () => string;
  };
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
  const row = db.sqlite
    .prepare(`SELECT schema_version AS schemaVersion,payload_json FROM ${table} WHERE ${key} = ?`)
    .get(id) as { schemaVersion: unknown; payload_json: string } | undefined;
  return row ? readRetainedV1(row, () => schema.parse(JSON.parse(row.payload_json))) : null;
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
    StoredGoalV1Schema
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
      StoredGoalPlanVersionV1Schema
    );
    const active = goal.activePlanVersionId
      ? readRecord(
          db,
          'goal_plan_versions',
          'plan_version_id',
          goal.activePlanVersionId,
          StoredGoalPlanVersionV1Schema
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
function saveGoal(db: Pick<WorkspaceDb, 'sqlite'>, goal: GoalRecord): void {
  const previous = readRecord(db, 'goals', 'goal_id', goal.goalId, StoredGoalV1Schema);
  db.sqlite
    .prepare(
      'INSERT INTO goals (goal_id,thread_id,payload_json,schema_version) VALUES (?, ?, ?, ?) ON CONFLICT(goal_id) DO UPDATE SET payload_json=excluded.payload_json,schema_version=excluded.schema_version'
    )
    .run(
      goal.goalId,
      goal.threadId,
      JSON.stringify(StoredGoalV1Schema.parse({ ...previous, ...goal })),
      writeRetainedV1({}).schemaVersion
    );
}
/** Advances the existing two-field marker in the caller's fact transaction. */
export function advanceGoalRevision(db: Pick<WorkspaceDb, 'sqlite'>, goalId: string): void {
  const goal = readRecord(db, 'goals', 'goal_id', goalId, StoredGoalV1Schema);
  if (goal) saveGoal(db, { ...goal, changeRevision: goal.changeRevision + 1, updatedAt: now() });
}
/** Advances Goals addressed by this Thread or linked to its ordinary Task, inside the source commit. */
export function advanceGoalForThread(
  sqlite: import('better-sqlite3').Database,
  threadId: string
): void {
  for (const row of sqlite
    .prepare('SELECT schema_version AS schemaVersion FROM goal_card_tasks WHERE thread_id=?')
    .all(threadId)) {
    readRetainedV1(row, () => undefined);
  }
  for (const row of sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion,goal_id,payload_json FROM goals WHERE thread_id=? OR goal_id IN (SELECT goal_id FROM goal_card_tasks WHERE thread_id=?)'
    )
    .all(threadId, threadId) as {
    schemaVersion: unknown;
    goal_id: string;
    payload_json: string;
  }[]) {
    const goal = readRetainedV1(row, () => StoredGoalV1Schema.parse(JSON.parse(row.payload_json)));
    sqlite
      .prepare('UPDATE goals SET payload_json=?,schema_version=? WHERE goal_id=?')
      .run(
        JSON.stringify({ ...goal, changeRevision: goal.changeRevision + 1, updatedAt: now() }),
        writeRetainedV1({}).schemaVersion,
        row.goal_id
      );
  }
}
/** Lists only the new owner records addressing an ordinary Coordinator Thread. */
export function listGoalsForThread(db: WorkspaceDb, threadId: string): GoalRecord[] {
  return (
    db.sqlite
      .prepare('SELECT schema_version AS schemaVersion,payload_json FROM goals WHERE thread_id=?')
      .all(threadId) as {
      schemaVersion: unknown;
      payload_json: string;
    }[]
  ).map((row) => readRetainedV1(row, () => StoredGoalV1Schema.parse(JSON.parse(row.payload_json))));
}
/** Captures native Goal and Task history for export; an unsupported SQL format never becomes current import input. */
export function listExportableGoalState(db: WorkspaceDb) {
  const readFamily = <T>(table: string, schema: z.ZodType<T>): T[] =>
    (
      db.sqlite
        .prepare(`SELECT schema_version AS schemaVersion,payload_json FROM ${table}`)
        .all() as {
        schemaVersion: unknown;
        payload_json: string;
      }[]
    ).map((row) => readRetainedV1(row, () => schema.parse(JSON.parse(row.payload_json))));
  return {
    goals: readFamily('goals', StoredGoalV1Schema),
    cards: readFamily('goal_cards', StoredGoalCardV1Schema),
    versions: readFamily('goal_plan_versions', StoredGoalPlanVersionV1Schema),
    tasks: readFamily('goal_card_tasks', StoredGoalCardTaskV1Schema),
    terminalFacts: readFamily('task_turn_terminal_facts', StoredTaskTerminalFactV1Schema),
  };
}

/** Projects authoritative SQL products; the retained Store argument is not a read authority. */
export function readGoalView(_store: FsStore, db: WorkspaceDb, goalId: string): GoalView {
  return readNativeGoalView(db, goalId);
}
/** Derives admission and state from ordinary native Task Turns, without file or cache fallback. */
function readNativeGoalView(db: WorkspaceDb, goalId: string): GoalView {
  const goal = readRecord(db, 'goals', 'goal_id', goalId, StoredGoalV1Schema);
  if (!goal) return { goal: null, cards: [], versions: [], tasks: [], requests: [] };
  const rows = <T>(table: string, schema: z.ZodType<T>) =>
    (
      db.sqlite
        .prepare(
          `SELECT schema_version AS schemaVersion,payload_json FROM ${table} WHERE goal_id=?`
        )
        .all(goalId) as {
        schemaVersion: unknown;
        payload_json: string;
      }[]
    ).map((row) => readRetainedV1(row, () => schema.parse(JSON.parse(row.payload_json))));
  return {
    goal: GoalRecordSchema.parse(goal),
    cards: rows('goal_cards', StoredGoalCardV1Schema).map((row) => GoalCardSchema.parse(row)),
    versions: rows('goal_plan_versions', StoredGoalPlanVersionV1Schema)
      .map((row) => GoalPlanVersionSchema.parse(row))
      .sort((a, b) => a.sequence - b.sequence),
    tasks: rows('goal_card_tasks', StoredGoalCardTaskV1Schema).map((row) => {
      const link = GoalTaskLinkSchema.parse(row);
      const missing = !readProduct(
        db.sqlite,
        { kind: 'workspace', workspaceId: goal.workspaceId },
        'thread',
        link.threadId
      );
      const turns = missing ? [] : nativeTurns(db, link.threadId);
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
function coordinatorTurn(
  context: GoalOwnerContext,
  db: WorkspaceDb,
  goal: GoalRecord
): Turn | null {
  if (!context.coordinatorTurnId) return null;
  const turn = nativeTurn(db, context.coordinatorTurnId);
  if (
    workspaceIdForOwner(turn.owner) !== goal.workspaceId ||
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
/** Validates the exact live Coordinator binding before a read can supply shared Goal input. */
export function requireCoordinatorGoal(
  _store: FsStore,
  db: WorkspaceDb,
  binding: { actor: Actor; goalId: string; workspaceId: string; threadId: string; turnId: string }
): GoalRecord {
  const goal = requireOpen(readRecord(db, 'goals', 'goal_id', binding.goalId, StoredGoalV1Schema));
  if (
    goal.workspaceId !== binding.workspaceId ||
    goal.threadId !== binding.threadId ||
    readProduct(
      db.sqlite,
      { kind: 'workspace', workspaceId: goal.workspaceId },
      'thread',
      goal.threadId
    )?.record.visibility !== 'workspace'
  )
    throw new GoalCommandError(
      'coordinator_authority_denied',
      'Coordinator source is unavailable.',
      403
    );
  coordinatorTurn({ actor: binding.actor, coordinatorTurnId: binding.turnId }, db, goal);
  return goal;
}
const GoalActorSchema: z.ZodType<Actor> = z
  .object({
    userId: UserIdSchema,
    kind: z.enum(['local', 'session', 'token']),
    sessionId: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
    adminTokenId: z.string().min(1).optional(),
  })
  .strict()
  .transform(
    (value): Actor => ({
      userId: value.userId,
      kind: value.kind,
      ...(value.sessionId ? { sessionId: value.sessionId } : {}),
      ...(value.tokenId ? { tokenId: value.tokenId } : {}),
      ...(value.tokenScope ? { tokenScope: value.tokenScope } : {}),
      ...(value.tokenWorkspaceIds ? { tokenWorkspaceIds: value.tokenWorkspaceIds } : {}),
      ...(value.adminTokenId ? { adminTokenId: value.adminTokenId } : {}),
    })
  );
const GoalContextSchema = z
  .object({
    actor: GoalActorSchema,
    coordinatorTurnId: z.string().min(1).optional(),
    originTurnId: z.string().min(1).optional(),
    assistantHandoff: z
      .object({
        originThreadId: z.string().min(1),
        originTurnId: z.string().min(1),
        sourceHash: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .transform(
    (value): GoalOwnerContext => ({
      actor: value.actor,
      ...(value.coordinatorTurnId ? { coordinatorTurnId: value.coordinatorTurnId } : {}),
      ...(value.originTurnId ? { originTurnId: value.originTurnId } : {}),
      ...(value.assistantHandoff ? { assistantHandoff: value.assistantHandoff } : {}),
    })
  );
const GoalReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'goal.create',
      'goal.intent.revise',
      'goal.card.create',
      'goal.card.edit',
      'goal.card.cancel',
      'goal.plan.propose',
      'goal.plan.approve',
      'goal.cancel',
      'goal.completion.accept',
    ]),
    requestId: RequestIdSchema,
    scope: z
      .object({
        workspaceId: WorkspaceIdSchema,
        actorId: UserIdSchema,
        threadId: z.string().min(1).optional(),
      })
      .strict()
      .transform((value) => ({
        workspaceId: value.workspaceId,
        actorId: value.actorId,
        ...(value.threadId ? { threadId: value.threadId } : {}),
      })),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.literal('goal'),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
const GoalCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('goal.create'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.create'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.intent.revise'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.intent.revise'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.card.create'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.card.create'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.card.edit'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.card.edit'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.card.cancel'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.card.cancel'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.plan.propose'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.plan.propose'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.plan.approve'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.plan.approve'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.cancel'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.cancel'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.completion.accept'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.completion.accept'].inputSchema.strict(),
    })
    .strict(),
]);
/** Closed transport facts. Core admission and file-owned evidence stay outside Workspace SQL; no authority callback crosses the worker boundary. */
export const ControlGoalCommandInputSchema = z
  .object({
    command: GoalCommandSchema,
    context: GoalContextSchema,
    // The source Workspace is a separate effect domain; admitted source facts must not be looked up in the destination database.
    assistantOrigin: z
      .object({
        workspaceId: WorkspaceIdSchema,
        threadId: ThreadIdSchema,
        turnId: TurnIdSchema,
        triggerActor: ActorRefSchema,
        agentId: z.literal('quick-chat'),
        agentSessionId: z.null(),
        sourceHash: z.string().min(1),
      })
      .strict()
      .optional(),
    receipt: GoalReceiptSchema.nullable(),
    administrator: z
      .object({ userId: UserIdSchema, tokenId: z.string().min(1).nullable() })
      .strict()
      .nullable(),
    resourcePolicy: PolicyDocumentV1Schema,
    grantAdmission: z
      .object({
        requestId: z.string().min(1),
        sourceHash: z.string().min(1),
        failure: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    externalEvidence: z
      .array(
        z
          .object({
            kind: z.enum(['artifact', 'knowledge-source']),
            id: z.string().min(1),
            workspaceId: WorkspaceIdSchema,
            threadId: z.string().min(1).nullable(),
            digest: z.string().min(1),
          })
          .strict()
      )
      .max(200),
    proposalTurnId: z.string().min(1).nullable(),
    captureCoverage: z
      .object({ scope: z.enum(['server', 'workspace', 'task']), value: z.enum(['off', 'on']) })
      .strict()
      .optional(),
    pendingAdmission: z
      .object({
        entries: z.lazy(() => z.array(ControlProductEntrySchema)),
        pending: z.lazy(() => z.array(ControlPendingCommandInputSchema)),
      })
      .strict()
      .optional(),
    pendingItem: z
      .object({ id: z.string().min(1), entry: z.lazy(() => ControlProductEntrySchema) })
      .strict()
      .nullable(),
  })
  .strict();
/** Structured-clone command input; immutable Item bodies are represented only by synchronized references. */
export type ControlGoalCommandInput = z.infer<typeof ControlGoalCommandInputSchema>;
/** Native command outcome. A refused grant is durable but is not a successful command receipt. */
export interface ControlGoalCommandResult {
  readonly view: GoalView;
  readonly replayed: boolean;
  readonly refusal: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
  } | null;
}
/** Native-only preparation. SQL compares each prepared Item's current descriptor before using its bytes. */
export interface PreparedControlGoalCommand {
  readonly pendingAdmission?: PreparedControlPendingCommand;
  readonly entries: readonly PreparedControlEntry[];
  readonly items: readonly {
    readonly item: Item;
    readonly revision: number;
    readonly contentJson: string;
  }[];
}
/** Verifies actual immutable references before the caller enters its SQL savepoint; never runs file I/O inside SQL. */
export async function prepareControlGoalCommand(
  db: WorkspaceDb,
  input: ControlGoalCommandInput,
  mount?: ControlProductContentMount,
  newDirectories?: ControlContentPreparation
): Promise<PreparedControlGoalCommand> {
  if (db.sqlite.inTransaction)
    throw new GoalCommandError('invalid_request', 'Goal content preparation must precede SQL.');
  const owner = { kind: 'workspace', workspaceId: db.workspaceId } as const;
  const args = input.command.arguments as GoalArguments;
  const request = args.pendingRequestId
    ? readPendingRequest(db.sqlite, args.pendingRequestId)
    : null;
  const ids = new Set<string>(request ? [request.requestItemId] : []);
  const candidate =
    request?.governedIntent?.operation === 'goal.completion.accept'
      ? StoredGoalCompletionCandidateV1Schema.parse(request.governedIntent.candidate)
      : null;
  for (const evidence of candidate?.evidence ?? [])
    if (evidence.kind === 'item') ids.add(evidence.id);
  const binding = mount ?? (input.pendingItem || ids.size > 0 ? goalContentMount(db) : undefined);
  const entries = await prepareControlEntries(
    owner,
    binding,
    input.pendingItem ? [input.pendingItem.entry] : [],
    newDirectories
  );
  const items: PreparedControlGoalCommand['items'][number][] = [];
  for (const id of ids) {
    const row = db.sqlite
      .prepare(
        "SELECT turn_id,sequence,revision,content_json FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(id) as
      | { turn_id: string; sequence: number; revision: number; content_json: string }
      | undefined;
    if (!row) continue;
    const entry = ControlProductEntrySchema.parse({
      kind: 'item',
      turnId: row.turn_id,
      sequence: row.sequence,
      expectedRevision: row.revision - 1,
      content: JSON.parse(row.content_json),
    });
    await prepareRetainedControlEntries(db, binding, [entry]);
    if (!binding)
      throw new GoalCommandError('recovery_required', 'Goal Item content mount is unavailable.');
    const fd = await open(
      join(binding.root, entry.content.reference.locator.path),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    let bytes: Buffer;
    try {
      bytes = await fd.readFile();
    } finally {
      await fd.close();
    }
    if (
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
      entry.content.reference.contentDigest
    )
      throw new GoalCommandError(
        'revision_conflict',
        'Goal Item content changed during preparation.'
      );
    const item = readRetainedV1(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      (value) => ItemSchema.parse(value)
    );
    if (item.id !== id)
      throw new GoalCommandError('recovery_required', 'Goal Item identity is contradictory.');
    items.push({ item, revision: row.revision, contentJson: row.content_json });
  }
  let pendingAdmission: PreparedControlPendingCommand | undefined;
  if (input.pendingAdmission) {
    if (
      input.command.operation !== 'goal.plan.propose' ||
      input.context.coordinatorTurnId ||
      !input.proposalTurnId ||
      input.pendingAdmission.pending.some(
        (command) =>
          command.action !== 'freeze' ||
          command.turnId !== input.proposalTurnId ||
          command.workspaceId !== db.workspaceId ||
          command.executor !== 'coordinator' ||
          command.agentId !== 'goal-coordinator'
      )
    )
      throw new GoalCommandError(
        'invalid_request',
        'Pending admission requires the exact proposal Turn.'
      );
    pendingAdmission = await prepareControlPendingCommands(
      db,
      input.pendingAdmission.pending,
      binding,
      input.pendingAdmission.entries,
      undefined,
      newDirectories
    );
  }
  return { entries, items, ...(pendingAdmission ? { pendingAdmission } : {}) };
}
/** Reads one current native Turn without introducing a Store or a second connection. */
function nativeTurn(db: WorkspaceDb, turnId: string, items: readonly Item[] = []): Turn {
  const row = readProduct(
    db.sqlite,
    { kind: 'workspace', workspaceId: db.workspaceId },
    'turn',
    turnId
  );
  if (!row) throw new GoalCommandError('not_found', 'Turn not found.', 404);
  return TurnSchema.parse({ ...row.record, items: items.filter((item) => item.turnId === turnId) });
}
/** Enumerates the selected Thread's native Turns in admitted order. */
function nativeTurns(db: WorkspaceDb, threadId: string, items: readonly Item[] = []): Turn[] {
  return (
    db.sqlite
      .prepare('SELECT id FROM control_turns WHERE thread_id=? ORDER BY rowid')
      .all(threadId) as { id: string }[]
  ).map(({ id }) => nativeTurn(db, id, items));
}
/** Rechecks current scoped audience facts; the admitted configuration is a distinct authority domain. */
function nativeThreadVisible(
  db: WorkspaceDb,
  input: ControlGoalCommandInput,
  threadId: string,
  actor: Actor
): boolean {
  const owner = { kind: 'workspace', workspaceId: db.workspaceId } as const;
  const thread = readProduct(db.sqlite, owner, 'thread', threadId);
  const workspace = readProduct(db.sqlite, owner, 'workspace', db.workspaceId);
  if (!thread || !workspace) return false;
  const administrator = input.administrator?.userId === actor.userId;
  if (
    !administrator &&
    workspace.record.kind === 'personal' &&
    db.workspaceId !== quickChatWorkspaceIdForUser(actor.userId)
  )
    return false;
  if (
    thread.record.visibility === 'private' &&
    !administrator &&
    thread.record.privateOwnerUserId !== actor.userId
  )
    return false;
  return (
    evaluateWorkspaceResourceAccess({
      workspaceId: db.workspaceId,
      actor: { kind: 'user', userId: actor.userId },
      eligible: true,
      resource: { family: 'thread', id: threadId },
      operation: 'thread.read',
      policy:
        thread.record.visibility === 'workspace' ? input.resourcePolicy : EMPTY_POLICY_DOCUMENT,
    }).effect === 'allow'
  );
}
/** Captures the Pending Request and its already-synchronized immutable Item in the same native tuple. */
function raiseIntent(
  db: WorkspaceDb,
  goal: GoalRecord,
  input: ControlGoalCommandInput,
  prepared: PreparedControlGoalCommand,
  exact: Readonly<Record<string, unknown>>,
  requestId: string,
  title: string
): void {
  const turn =
    coordinatorTurn(input.context, db, goal) ??
    (input.proposalTurnId ? nativeTurn(db, input.proposalTurnId) : null);
  if (!turn || !input.pendingItem || prepared.entries.length !== 1)
    throw new GoalCommandError('recovery_required', 'The proposal Item was not prepared.');
  const description =
    exact.operation === 'goal.plan.approve'
      ? 'Approve the exact Plan and typed Goal domain.'
      : 'Approve the exact captured commitment.';
  const at = input.receipt?.createdAt;
  if (!at)
    throw new GoalCommandError('invalid_request', 'A proposal requires its original receipt.');
  const item = ItemSchema.parse({
    id: input.pendingItem.id,
    owner: { kind: 'workspace', workspaceId: goal.workspaceId },
    threadId: goal.threadId,
    turnId: turn.id,
    type: 'approval-request',
    approvalRequestId: requestId,
    kind: 'permission',
    status: 'completed',
    completedAt: at,
    title,
    description,
    createdAt: at,
  });
  const bytes = JSON.stringify(writeRetainedV1(item));
  if (
    input.pendingItem.entry.content.reference.contentDigest !==
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` ||
    prepared.entries[0]?.id !== item.id ||
    !isDeepStrictEqual(prepared.entries[0].input, input.pendingItem.entry)
  )
    throw new GoalCommandError('recovery_required', 'The exact proposal Item is unavailable.');
  raisePendingRequest(db.sqlite, {
    requestId,
    workspaceId: goal.workspaceId,
    threadId: goal.threadId,
    raisingTurnId: turn.id,
    requestItemId: item.id,
    kind: 'approval',
    requesterKind: 'coordinator',
    agentId: 'goal-coordinator',
    responsibleUserId: goal.responsibleUserId,
    governedIntent: exact,
    approval: { kind: 'permission', title, description },
    now: at,
  });
  const last = db.sqlite
    .prepare(
      "SELECT max(sequence) AS sequence FROM control_product_entries WHERE kind='item' AND turn_id=?"
    )
    .get(turn.id) as { sequence: number | null };
  applyControlProducts(
    db.sqlite,
    { kind: 'workspace', workspaceId: goal.workspaceId },
    [],
    [
      {
        ...prepared.entries[0]!,
        input: {
          ...input.pendingItem.entry,
          sequence: (last.sequence ?? 0) + 1,
          expectedRevision: 0,
        },
      },
    ]
  );
}
/** Uses the existing native work-byte owner without inventing a Knowledge grant or changing product retention. */
function goalContentMount(db: WorkspaceDb): ControlProductContentMount {
  return nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId: db.workspaceId })
    .contentMount;
}
/** Publishes the exact pending Item through the existing staged Storage handoff before SQL admission. */
async function publishGoalPendingItem(
  db: WorkspaceDb,
  id: Exclude<GoalOperationId, 'goal.read'>,
  input: GoalArguments,
  context: GoalOwnerContext,
  goal: GoalRecord,
  receipt: IdempotentCommandReceipt,
  proposalTurnId: string | null
): Promise<NonNullable<ControlGoalCommandInput['pendingItem']>> {
  const turnId = context.coordinatorTurnId ?? proposalTurnId;
  if (!turnId)
    throw new GoalCommandError('coordinator_required', 'A Coordinator captures completion.', 403);
  const mount = goalContentMount(db);
  const owner = { kind: 'workspace', workspaceId: goal.workspaceId } as const;
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    owner,
    threadId: goal.threadId,
    turnId,
    type: 'approval-request',
    approvalRequestId: `ap_${input.requestId}`,
    kind: 'permission',
    status: 'completed',
    completedAt: receipt.createdAt,
    title: id === 'goal.plan.propose' ? 'Approve Goal Plan' : 'Accept exact Goal completion',
    description:
      id === 'goal.plan.propose'
        ? 'Approve the exact Plan and typed Goal domain.'
        : 'Approve the exact captured commitment.',
    createdAt: receipt.createdAt,
  });
  const content = await prepareImmutableProductJson(
    mount,
    owner,
    join(db.dataRoot, 'workspaces', db.workspaceId, 'runtime', 'staging'),
    writeRetainedV1(item)
  );
  return {
    id: item.id,
    entry: { kind: 'item', turnId, sequence: 1, expectedRevision: 0, ...content },
  };
}
/** Pins the typed proposal to native Plan lineage before the human sees either effect. */
function captureGoalDomain(
  input: OperationInput<'goal.plan.propose'>['goalDomain'],
  goal: GoalRecord,
  version: GoalPlanVersion,
  context: GoalOwnerContext
): { statement: z.infer<typeof PolicyDelegationV1Schema>; digest: string } {
  const statement = PolicyDelegationV1Schema.parse({
    ...input,
    kind: 'delegation',
    state: 'inactive',
    purpose: 'goal-domain',
    delegate: { kind: 'agent', id: 'goal-coordinator' },
    author: { kind: 'human', id: context.actor.userId },
    authority: { kind: 'human', userId: context.actor.userId },
    authoredAt: version.createdAt,
    source: {
      workspaceId: goal.workspaceId,
      goalId: goal.goalId,
      planVersionId: version.planVersionId,
      planDigest: version.digest,
      approvalRequestId: version.pendingRequestId,
    },
  });
  return { statement, digest: policyDigest(statement) };
}

/** Re-evaluates exact authority synchronously before CAS, with no Task effect. */
function consumeGrant(
  db: WorkspaceDb,
  goal: GoalRecord,
  request: PendingRequestRecord,
  input: ControlGoalCommandInput,
  prepared: PreparedControlGoalCommand
): GoalRecord {
  let reason: string | null = goal.disposition ? 'The Goal was cancelled or accepted.' : null;
  if (
    validateCanonicalLoad(
      request,
      nativeTurns(
        db,
        goal.threadId,
        prepared.items.map((row) => row.item)
      ),
      readCommandRequestRecordsFromSqlite(db.sqlite)
    )
  )
    reason ??= 'The pending request is contradictory.';
  if (
    request.state !== 'resolved' ||
    request.resolution !== 'granted' ||
    request.claim !== 'unclaimed' ||
    request.disposition ||
    request.governedIntent?.goalId !== goal.goalId
  )
    reason ??= 'The grant is no longer eligible.';
  if (
    !input.grantAdmission ||
    input.grantAdmission.requestId !== request.requestId ||
    input.grantAdmission.sourceHash !== commandInputHash(request)
  )
    reason ??= 'The exact deciding credential was not admitted.';
  else reason ??= input.grantAdmission.failure;
  const exact = request.governedIntent;
  let version: GoalPlanVersion | null = null;
  if (exact?.operation === 'goal.plan.approve') {
    version = readRecord(
      db,
      'goal_plan_versions',
      'plan_version_id',
      String(exact.planVersionId),
      StoredGoalPlanVersionV1Schema
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
          StoredGoalPlanVersionV1Schema
        )
      : null;
    if (goal.activePlanVersionId && !active)
      reason ??= 'The current active Plan version is unavailable.';
    if (version && active && active.sequence > version.sequence)
      reason ??= 'An obsolete proposal cannot replace a later active version.';
  } else if (exact?.operation === 'goal.completion.accept') {
    const candidate = StoredGoalCompletionCandidateV1Schema.parse(exact.candidate);
    if (
      candidate.intent !== goal.intent ||
      candidate.intentRevision !== goal.intentRevision ||
      candidate.planVersionId !== goal.activePlanVersionId
    )
      reason ??= 'The completion candidate no longer matches current intent and Plan.';
    for (const evidence of candidate.evidence) {
      const external =
        evidence.kind === 'artifact' || evidence.kind === 'knowledge-source'
          ? input.externalEvidence.find(
              (row) => row.kind === evidence.kind && row.id === evidence.id
            )
          : undefined;
      const current =
        evidence.kind === 'capability-call'
          ? listWorkspaceCapabilityCalls(db, goal.workspaceId).find((row) => row.id === evidence.id)
          : evidence.kind === 'evidence-bundle'
            ? listWorkspaceEvidenceBundles(db, goal.workspaceId).find(
                (row) => row.id === evidence.id
              )
            : evidence.kind === 'item'
              ? prepared.items.find((row) => row.item.id === evidence.id)?.item
              : undefined;
      const sourceWorkspaceId =
        external?.workspaceId ??
        (current &&
          ('owner' in current
            ? workspaceIdForOwner((current as Item | CapabilityCall).owner)
            : current.workspaceId));
      const threadId = external?.threadId ?? current?.threadId;
      const digest = external?.digest ?? (current ? commandInputHash(current) : null);
      const actor = request.decidingActorContext;
      if (
        (!external && !current) ||
        sourceWorkspaceId !== goal.workspaceId ||
        (threadId && (!actor || !nativeThreadVisible(db, input, threadId, actor))) ||
        digest !== evidence.digest
      )
        reason ??= 'The named evidence is unavailable, unauthorized or changed.';
    }
  } else reason ??= 'The captured Goal operation is unavailable.';
  if (reason) {
    if (refuseCommandIntentGrant(db.sqlite, request.requestId, reason, now()))
      advanceGoalRevision(db, goal.goalId);
    // The native caller returns the refusal after commit, without a success receipt.
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
            candidate: StoredGoalCompletionCandidateV1Schema.parse(exact?.candidate),
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
/** Applies Goal-owned mutations only after the original receipt and current native lineage are checked. */
function applyNativeGoalMutation(
  db: WorkspaceDb,
  nativeInput: ControlGoalCommandInput,
  prepared: PreparedControlGoalCommand
): GoalView {
  const id = nativeInput.command.operation;
  const input = nativeInput.command.arguments as GoalArguments;
  const context = nativeInput.context;
  const commandInput = input as GoalArguments & { requestId: string };
  const goalId = typeof input.goalId === 'string' ? input.goalId : `g_${commandInput.requestId}`;
  const owner = { kind: 'workspace', workspaceId: input.workspaceId } as const;
  let goal: GoalRecord | null = readRecord(db, 'goals', 'goal_id', goalId, StoredGoalV1Schema);
  if (id === 'goal.plan.propose' && !context.coordinatorTurnId) {
    goal = requireOpen(goal);
    checkRevision(goal.changeRevision, input.expectedRevision);
    if (
      !nativeInput.proposalTurnId ||
      !nativeInput.captureCoverage ||
      nativeTurns(db, goal.threadId).some((turn) => !isSealedTurnTerminal(turn.status))
    )
      throw new GoalCommandError('thread_busy', 'The Goal Thread already has a Turn in flight.');
    if (
      listThreadPendingRequests(db.sqlite, goal.workspaceId, goal.threadId).some(
        (request) => request.requesterKind === 'coordinator' && isReadyOutcome(request)
      ) &&
      !nativeInput.pendingAdmission?.pending.length
    )
      throw new GoalCommandError(
        'recovery_required',
        'The Coordinator Turn requires complete native pending-outcome admission.'
      );
    applyControlProducts(
      db.sqlite,
      owner,
      [
        {
          kind: 'turn',
          expectedRevision: 0,
          record: writeRetainedV1({
            id: nativeInput.proposalTurnId,
            owner,
            threadId: goal.threadId,
            triggerActor: { kind: 'user', id: context.actor.userId },
            triggerSource: { kind: 'user-input', summary: 'Propose a Goal Plan' },
            agentId: 'goal-coordinator',
            captureCoverage: nativeInput.captureCoverage,
            error: null,
            configVersion: null,
            startedAt: nativeInput.receipt?.createdAt ?? now(),
            completedAt: null,
            durationMs: null,
            status: 'running',
          }),
        },
      ],
      prepared.pendingAdmission?.entries ?? []
    );
    if (nativeInput.pendingAdmission) {
      if (!prepared.pendingAdmission)
        throw new GoalCommandError('recovery_required', 'Pending admission was not prepared.');
      for (const command of nativeInput.pendingAdmission.pending)
        applyControlPendingCommand(db, command, prepared.pendingAdmission);
    }
  }
  if (id === 'goal.create' && 'intent' in input) {
    if (goal) throw new GoalCommandError('revision_conflict', 'Goal already exists.');
    const origin = 'originThreadId' in input ? input.originThreadId : undefined;
    if (origin && !nativeThreadVisible(db, nativeInput, origin, context.actor))
      throw new GoalCommandError('not_found', 'Origin Thread not found.', 404);
    const thread = ThreadSchema.parse({
      id: deriveEntityId('th', ['goal', commandInput.requestId]),
      owner: { kind: 'workspace', workspaceId: input.workspaceId },
      name: input.intent.slice(0, 100),
      preview: input.intent.slice(0, 100),
      status: 'active',
      entryPath: 'conversation',
      threadSource: 'conversation',
      visibility: 'workspace',
      ...(context.assistantHandoff?.originThreadId || origin
        ? { parentThreadId: context.assistantHandoff?.originThreadId ?? origin }
        : {}),
      createdAt: now(),
      updatedAt: now(),
    });
    const workspace = readProduct(db.sqlite, owner, 'workspace', input.workspaceId);
    if (!workspace) throw new GoalCommandError('not_found', 'Workspace not found.', 404);
    applyControlProducts(
      db.sqlite,
      owner,
      [
        {
          kind: 'workspace',
          expectedRevision: workspace.revision,
          record: { ...workspace.record, updatedAt: thread.createdAt },
        },
        { kind: 'thread', expectedRevision: 0, record: writeRetainedV1(thread) },
      ],
      []
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
      intentHistory: [{ revision: 0, intent: input.intent, actorId: context.actor.userId, at }],
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
    if (
      request.governedIntent?.operation !== id ||
      request.governedIntent.goalId !== goal.goalId ||
      request.workspaceId !== goal.workspaceId ||
      request.threadId !== goal.threadId ||
      request.responsibleUserId !== goal.responsibleUserId
    )
      throw new GoalCommandError(
        'approval_conflict',
        'The request does not capture this exact Goal operation.'
      );
    if (request.state === 'pending')
      throw new GoalCommandError(
        'coordinator_self_approval_denied',
        'The Coordinator cannot resolve its own approval.',
        403
      );
    // A new explicit publication attempt uses the committed outcome without consuming the grant again or restoring an obsolete Plan pointer.
    if (
      id === 'goal.plan.approve' &&
      !goal.disposition &&
      goal.activePlanVersionId === request.governedIntent.planVersionId &&
      request.state === 'resolved' &&
      request.resolution === 'granted' &&
      request.claim === 'finished' &&
      request.disposition === 'approved-executed'
    )
      return readNativeGoalView(db, goalId);
    goal = consumeGrant(db, goal, request, nativeInput, prepared);
  } else {
    goal = requireOpen(readRecord(db, 'goals', 'goal_id', goalId, StoredGoalV1Schema));
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
        .prepare(
          'INSERT INTO goal_cards (card_id,goal_id,payload_json,schema_version) VALUES (?,?,?,?)'
        )
        .run(
          card.cardId,
          goalId,
          JSON.stringify(StoredGoalCardV1Schema.parse(card)),
          writeRetainedV1({}).schemaVersion
        );
    } else if ((id === 'goal.card.edit' || id === 'goal.card.cancel') && 'cardId' in input) {
      const card = readRecord(db, 'goal_cards', 'card_id', input.cardId, StoredGoalCardV1Schema);
      if (!card || card.goalId !== goalId)
        throw new GoalCommandError('not_found', 'Card not found.', 404);
      checkRevision(card.revision, input.expectedRevision);
      if (card.cancelled) throw new GoalCommandError('card_cancelled', 'Card has been cancelled.');
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
        .prepare('UPDATE goal_cards SET payload_json=?,schema_version=? WHERE card_id=?')
        .run(
          JSON.stringify(StoredGoalCardV1Schema.parse(next)),
          writeRetainedV1({}).schemaVersion,
          card.cardId
        );
    } else if (id === 'goal.plan.propose' && 'commitment' in input) {
      checkRevision(goal.changeRevision, input.expectedRevision);
      const commitment = StoredGoalCommitmentV1Schema.parse(input.commitment);
      const versions = readNativeGoalView(db, goalId).versions;
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
      // Main validates domain semantics at submission; native-owned references must still be current in this transaction.
      for (const resource of input.goalDomain.scope.resources) {
        if (resource.kind === 'mcp-tool') {
          if (resource.workspaceId !== goal.workspaceId)
            throw new GoalCommandError(
              'invalid_request',
              'Goal domain belongs to another Workspace.',
              400
            );
          continue;
        }
        const container = resource.container;
        let valid =
          container.owner.kind === 'workspace' && container.owner.workspaceId === goal.workspaceId;
        if (valid) {
          if (container.kind === 'goal') valid = container.id === goal.goalId;
          else if (container.kind === 'workspace') valid = container.id === goal.workspaceId;
          else if (container.kind === 'thread')
            valid = nativeThreadVisible(db, nativeInput, container.id, context.actor);
          else if (container.kind === 'turn') {
            try {
              valid = nativeThreadVisible(
                db,
                nativeInput,
                nativeTurn(db, container.id).threadId,
                context.actor
              );
            } catch {
              valid = false;
            }
          } else valid = false;
        }
        if (!valid)
          throw new GoalCommandError(
            'invalid_request',
            'goalDomain.scope.resources.container must reference this Goal, Workspace, or a currently visible Thread or Turn.',
            400
          );
      }
      const goalDomain = captureGoalDomain(input.goalDomain, goal, version, context);
      invalidateGoalPendingRequests(
        db.sqlite,
        goalId,
        'Superseded by a newer Plan proposal.',
        { kind: 'user', id: context.actor.userId },
        now(),
        true
      );
      db.sqlite
        .prepare(
          'INSERT INTO goal_plan_versions (plan_version_id,goal_id,payload_json,schema_version) VALUES (?,?,?,?)'
        )
        .run(
          version.planVersionId,
          goalId,
          JSON.stringify(StoredGoalPlanVersionV1Schema.parse(version)),
          writeRetainedV1({}).schemaVersion
        );
      saveGoal(db, { ...goal, proposedPlanVersionId: version.planVersionId });
      raiseIntent(
        db,
        goal,
        nativeInput,
        prepared,
        {
          operation: 'goal.plan.approve',
          goalId,
          planVersionId: version.planVersionId,
          digest: version.digest,
          bytes,
          goalDomain,
        },
        version.pendingRequestId,
        'Approve Goal Plan'
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
      if (!coordinatorTurn(context, db, goal))
        throw new GoalCommandError(
          'coordinator_required',
          'A Coordinator captures completion; a person resolves its exact request.',
          403
        );
      raiseIntent(
        db,
        goal,
        nativeInput,
        prepared,
        {
          operation: 'goal.completion.accept',
          goalId,
          candidate: StoredGoalCompletionCandidateV1Schema.parse(input.candidate),
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
      resolveNativeGoalApproval(db, nativeInput, prepared, request, input.decision);
    } else
      throw new GoalCommandError(
        'invalid_request',
        'The operation arguments do not select one valid effect.',
        400
      );
  }
  advanceGoalRevision(db, goalId);
  return readNativeGoalView(db, goalId);
}

/** Rechecks the Pending Request's current SQL identity and admitted immutable source Items before granting. */
function resolveNativeGoalApproval(
  db: WorkspaceDb,
  input: ControlGoalCommandInput,
  prepared: PreparedControlGoalCommand,
  request: PendingRequestRecord,
  decision: 'granted' | 'denied'
): void {
  const actor = input.context.actor;
  const turns = nativeTurns(
    db,
    request.threadId,
    prepared.items.map((row) => row.item)
  );
  if (
    !isCommandIntentApproval(request) ||
    validateCanonicalLoad(request, turns, readCommandRequestRecordsFromSqlite(db.sqlite))
  )
    throw new GoalCommandError('recovery_required', 'The pending request is contradictory.');
  if (actor.userId !== request.responsibleUserId && input.administrator?.userId !== actor.userId)
    throw new GoalCommandError('workspace_access_denied', 'Workspace access denied.', 403);
  if (request.state !== 'pending')
    throw new GoalCommandError('request_not_pending', 'The request is no longer pending.');
  if (decision === 'granted') {
    if (
      !nativeThreadVisible(db, input, request.threadId, actor) ||
      !request.governedIntent ||
      Buffer.byteLength(JSON.stringify(request.governedIntent)) > 524288
    )
      throw new GoalCommandError(
        'approval_preview_unavailable',
        'Exact effect unavailable; approval disabled'
      );
    checkGoalCommandIntent(db.sqlite, request);
  }
  const decider = { kind: 'user' as const, id: actor.userId };
  const result =
    decision === 'granted'
      ? grantCommandIntentRequest(db.sqlite, request.requestId, decider, now(), actor)
      : denyPendingRequest(db.sqlite, request.requestId, decider, now(), actor);
  if (!result)
    throw new GoalCommandError('request_not_pending', 'The request is no longer pending.');
}

/**
 * Applies the complete deciding Goal body on the caller's ONE native WorkspaceDb and active savepoint.
 *
 * The worker must call prepareControlGoalCommand before SQL and pass its result for commands that read or create Items. This function performs no file I/O, opens no sibling handle, never commits, and returns only materialized facts. Outer FULL COMMIT acknowledgement remains with the worker.
 */
export function applyControlGoalCommand(
  db: WorkspaceDb,
  value: ControlGoalCommandInput,
  prepared: PreparedControlGoalCommand = { entries: [], items: [] }
): ControlGoalCommandResult {
  assertControlProductWriter(db.sqlite);
  const input = ControlGoalCommandInputSchema.parse(value);
  if (input.assistantOrigin && !input.context.assistantHandoff)
    throw new GoalCommandError(
      'invalid_request',
      'Assistant source facts require their exact handoff.',
      400
    );
  const args = input.command.arguments;
  const goalId = 'goalId' in args ? args.goalId : `g_${args.requestId}`;
  if (db.workspaceId !== args.workspaceId)
    throw new GoalCommandError(
      'invalid_request',
      'Goal command belongs to another Workspace.',
      400
    );
  if (
    input.context.coordinatorTurnId &&
    (input.command.operation === 'goal.create' || input.command.operation === 'goal.cancel')
  )
    throw new GoalCommandError(
      'coordinator_authority_denied',
      'Only a person may create or cancel a Goal.',
      403
    );
  const currentGoal = readRecord(db, 'goals', 'goal_id', goalId, StoredGoalV1Schema);
  if (
    currentGoal &&
    (currentGoal.workspaceId !== args.workspaceId ||
      ('threadId' in args && currentGoal.threadId !== args.threadId))
  )
    throw new GoalCommandError('not_found', 'Goal not found.', 404);
  if (currentGoal) coordinatorTurn(input.context, db, currentGoal);
  const receipt = input.receipt;
  if (receipt && input.context.assistantHandoff)
    throw new GoalCommandError(
      'invalid_request',
      'The Assistant handoff cannot introduce another receipt.',
      400
    );
  if (receipt) {
    const expectedScope = {
      workspaceId: args.workspaceId,
      actorId: input.context.actor.userId,
      ...('threadId' in args ? { threadId: args.threadId } : {}),
    };
    if (
      receipt.command !== input.command.operation ||
      receipt.requestId !== args.requestId ||
      receipt.inputHash !== commandInputHash(args) ||
      !isDeepStrictEqual(receipt.scope, expectedScope) ||
      receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
      receipt.expiresAt <= receipt.createdAt
    )
      throw new GoalCommandError(
        'invalid_request',
        'Original Goal receipt facts are contradictory.',
        400
      );
    const row = db.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,request_key AS key,command_name AS command,request_id AS requestId,scope_json AS scopeJson,input_hash AS inputHash,response_kind AS responseKind,response_id AS responseId,response_json AS responseJson,created_at AS createdAt,expires_at AS expiresAt FROM idempotency_requests WHERE request_key=?'
      )
      .get(receipt.key) as Parameters<typeof mapCommandRequestRow>[0] | undefined;
    if (row && row.expiresAt > receipt.createdAt) {
      const prior = mapCommandRequestRow(row);
      if (
        prior.inputHash !== receipt.inputHash ||
        prior.command !== receipt.command ||
        !isDeepStrictEqual(prior.scope, receipt.scope)
      )
        throw new IdempotencyKeyConflictError();
      if (prior.response.kind !== 'goal' || prior.response.id !== goalId)
        throw new GoalCommandError('recovery_required', 'Goal receipt response is contradictory.');
      return { view: readNativeGoalView(db, goalId), replayed: true, refusal: null };
    }
  } else if (input.command.operation !== 'goal.create' || !input.context.assistantHandoff) {
    throw new GoalCommandError(
      'invalid_request',
      'Only the admitted Assistant handoff is receipt-free.',
      400
    );
  }
  if (input.context.assistantHandoff) {
    const admitted = input.assistantOrigin;
    if (!admitted)
      throw new GoalCommandError(
        'invalid_request',
        'The Assistant source admission is missing.',
        400
      );
    // Recheck local authority locally. A foreign source was checked by its owning producer before this separate destination effect.
    const source =
      admitted.workspaceId === db.workspaceId
        ? nativeTurn(db, input.context.assistantHandoff.originTurnId)
        : admitted;
    if (
      input.command.operation !== 'goal.create' ||
      admitted.threadId !== input.context.assistantHandoff.originThreadId ||
      admitted.turnId !== input.context.assistantHandoff.originTurnId ||
      admitted.sourceHash !== input.context.assistantHandoff.sourceHash ||
      source.threadId !== input.context.assistantHandoff.originThreadId ||
      source.agentSessionId ||
      source.agentId !== 'quick-chat' ||
      source.triggerActor.id !== input.context.actor.userId ||
      !input.context.assistantHandoff.sourceHash
    )
      throw new GoalCommandError(
        'origin_authority_denied',
        'The Assistant handoff source is unavailable.',
        403
      );
  }
  for (const source of prepared.items) {
    const current = db.sqlite
      .prepare(
        "SELECT revision,content_json FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(source.item.id) as { revision: number; content_json: string } | undefined;
    if (
      !current ||
      current.revision !== source.revision ||
      current.content_json !== source.contentJson
    )
      throw new GoalCommandError(
        'revision_conflict',
        'The Goal source Item changed before the native decision.'
      );
  }
  let view: GoalView;
  try {
    view = applyNativeGoalMutation(db, input, prepared);
  } catch (error) {
    if (!(error instanceof GoalCommandError) || error.code !== 'grant_conflict') throw error;
    return {
      view: readNativeGoalView(db, goalId),
      replayed: false,
      refusal: { code: error.code, message: error.message, status: error.status },
    };
  }
  if (receipt) {
    const { responseKind, ...facts } = receipt;
    recordControlCommandRequestRecordInDb(db, {
      ...facts,
      response: { kind: responseKind, id: goalId },
    });
  }
  return { view, replayed: false, refusal: null };
}

/** Executes the public Goal family, admitting external authority before one native Workspace tuple. */
export async function executeGoalOperation<K extends GoalOperationId>(
  id: K,
  value: OperationInput<K>,
  context: GoalOwnerContext,
  store: FsStore,
  db: WorkspaceDb,
  services: GoalOwnerServices = {}
): Promise<GoalView> {
  const parsed = GOAL_OPERATION_DEFINITIONS[id].inputSchema.safeParse(value);
  if (!parsed.success)
    throw new GoalCommandError(
      'invalid_request',
      id === 'goal.plan.propose'
        ? `Invalid ${parsed.error.issues[0]?.path.join('.') || 'input'}. Use registered product actions and exact native Goal, Workspace, Thread or Turn references.`
        : 'Invalid Goal operation input.',
      400
    );
  const input = parsed.data as GoalArguments;
  const goalId =
    typeof input.goalId === 'string'
      ? input.goalId
      : id === 'goal.read'
        ? (listGoalsForThread(db, input.threadId)[0]?.goalId ?? 'absent')
        : `g_${input.requestId}`;
  const goal = readRecord(db, 'goals', 'goal_id', goalId, StoredGoalV1Schema);
  if (
    goal &&
    (goal.workspaceId !== input.workspaceId ||
      ('threadId' in input && goal.threadId !== input.threadId))
  )
    throw new GoalCommandError('not_found', 'Goal not found.', 404);
  if (id === 'goal.read') return readNativeGoalView(db, goalId);
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
  if (goal) coordinatorTurn(context, db, goal);
  const commandInput = input as GoalArguments & { requestId: string };
  const client = getControlStoreWorkerClient();
  const path = workspaceDbPath(db.dataRoot, input.workspaceId);
  const database = `workspace:${path}`;
  const contentMount = goalContentMount(db);
  await client.open({
    database,
    path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: { kind: 'workspace', workspaceId: input.workspaceId },
    contentMount,
  });
  const invoke = async (receipt: IdempotentCommandReceipt | null): Promise<GoalView> => {
    const request = input.pendingRequestId
      ? readPendingRequest(db.sqlite, input.pendingRequestId)
      : null;
    const currentAdministrator = (): ControlGoalCommandInput['administrator'] => {
      const authorityActor =
        context.coordinatorTurnId && request?.decidingActorContext
          ? request.decidingActorContext
          : context.actor;
      return services.coreDb && isCurrentDeploymentAdministrator(services.coreDb, authorityActor)
        ? requireCurrentDeploymentAdmin(services.coreDb, authorityActor)
        : null;
    };
    let administrator = currentAdministrator();
    const externalEvidence: ControlGoalCommandInput['externalEvidence'] = [];
    if (request && context.coordinatorTurnId) {
      if (request.governedIntent?.operation === 'goal.completion.accept')
        for (const evidence of StoredGoalCompletionCandidateV1Schema.parse(
          request.governedIntent.candidate
        ).evidence) {
          if (evidence.kind !== 'artifact' && evidence.kind !== 'knowledge-source') continue;
          try {
            const record =
              evidence.kind === 'artifact'
                ? store.getArtifact(input.workspaceId, evidence.id)
                : store
                    .listKnowledgeSources(input.workspaceId)
                    .find((row) => row.id === evidence.id);
            if (record)
              externalEvidence.push({
                kind: evidence.kind,
                id: evidence.id,
                workspaceId: record.workspaceId,
                threadId: 'threadId' in record ? record.threadId : null,
                digest: commandInputHash(record),
              });
          } catch {
            /* Missing external evidence remains a native grant conflict. */
          }
        }
    } else if (request && input.decision) {
      if (
        services.coreDb &&
        !authorizeWorkspace(services.coreDb, context.actor, input.workspaceId, {
          policyOperation: 'approval.respond',
          mutating: true,
        }) &&
        !administrator
      )
        throw new GoalCommandError('workspace_access_denied', 'Workspace access denied.', 403);
      if (
        input.decision === 'granted' &&
        projectApprovalEffect({
          record: request,
          store,
          coreDb: services.coreDb,
          actor: context.actor,
        }).status !== 'available'
      )
        throw new GoalCommandError(
          'approval_preview_unavailable',
          'Exact effect unavailable; approval disabled'
        );
    }
    const proposalTurnId =
      id === 'goal.plan.propose' && !context.coordinatorTurnId ? allocateEntityId('tu') : null;
    const pendingItem =
      goal &&
      receipt &&
      (id === 'goal.plan.propose' ||
        (id === 'goal.completion.accept' && input.candidate && !input.pendingRequestId))
        ? await publishGoalPendingItem(db, id, input, context, goal, receipt, proposalTurnId)
        : null;
    let assistantOrigin: ControlGoalCommandInput['assistantOrigin'];
    if (context.assistantHandoff) {
      const source = store.getTurnById(context.assistantHandoff.originTurnId);
      if (
        source.owner.kind !== 'workspace' ||
        source.threadId !== context.assistantHandoff.originThreadId ||
        source.agentSessionId ||
        source.agentId !== 'quick-chat' ||
        source.triggerActor.id !== context.actor.userId ||
        !context.assistantHandoff.sourceHash
      )
        throw new GoalCommandError(
          'origin_authority_denied',
          'The Assistant handoff source is unavailable.',
          403
        );
      assistantOrigin = {
        workspaceId: source.owner.workspaceId,
        threadId: source.threadId,
        turnId: source.id,
        triggerActor: source.triggerActor,
        agentId: 'quick-chat',
        agentSessionId: null,
        sourceHash: context.assistantHandoff.sourceHash,
      };
    }
    const pendingAdmission =
      proposalTurnId && goal
        ? await store.prepareNativeTurnPendingAdmission(
            {
              id: proposalTurnId,
              owner: { kind: 'workspace', workspaceId: goal.workspaceId },
              threadId: goal.threadId,
              triggerActor: { kind: 'user', id: context.actor.userId },
              triggerSource: { kind: 'user-input', summary: 'Propose a Goal Plan' },
              agentId: 'goal-coordinator',
              error: null,
              configVersion: null,
              startedAt: receipt?.createdAt ?? now(),
              completedAt: null,
              durationMs: null,
              status: 'running',
              items: [],
            },
            'coordinator'
          )
        : undefined;
    // Main-owned current authority is checked after all preparation, immediately before native submission.
    administrator = currentAdministrator();
    let grantAdmission: ControlGoalCommandInput['grantAdmission'] = null;
    if (request && context.coordinatorTurnId) {
      let failure: string | null = null;
      if (
        (services.grantAuthority && !services.grantAuthority(request)) ||
        (services.coreDb &&
          (!request.decidingActorContext ||
            !authorizeWorkspace(services.coreDb, request.decidingActorContext, input.workspaceId, {
              policyOperation: 'workspace.write',
              mutating: true,
            })))
      )
        failure = 'The deciding actor is no longer authorized.';
      grantAdmission = {
        requestId: request.requestId,
        sourceHash: commandInputHash(request),
        failure,
      };
    }
    if (id === 'goal.plan.propose' && goal) {
      const supportError = goalDomainSupportError({
        statement: input.goalDomain,
        store,
        actor: context.actor,
        workspaceId: goal.workspaceId,
        goalId: goal.goalId,
        administratorEligible: administrator?.userId === context.actor.userId,
      });
      if (supportError) throw new GoalCommandError('invalid_request', supportError, 400);
    }
    const nativeInput = ControlGoalCommandInputSchema.parse({
      command: { operation: id, arguments: input },
      context,
      ...(assistantOrigin ? { assistantOrigin } : {}),
      receipt,
      administrator,
      resourcePolicy: store.getWorkspaceResourceAccess(input.workspaceId),
      grantAdmission,
      externalEvidence,
      proposalTurnId,
      ...(pendingAdmission ? { pendingAdmission } : {}),
      captureCoverage: store.getLiveCaptureCoverage(),
      pendingItem,
    });
    const outcome: ControlGoalCommandResult = await client.goal(database, nativeInput);
    if (outcome.refusal)
      throw new GoalCommandError(
        outcome.refusal.code,
        outcome.refusal.message,
        outcome.refusal.status
      );
    for (const pending of outcome.view.requests) {
      const record = readPendingRequest(db.sqlite, pending.requestId);
      const approval = record ? projectApprovalRequest(record) : null;
      if (approval) {
        try {
          store.getApproval(approval.id);
          store.updateApproval(approval.id, approval);
        } catch {
          store.createApproval(approval);
        }
      }
    }
    if (proposalTurnId && !outcome.replayed)
      await store.updateTurn(proposalTurnId, { status: 'completed', completedAt: now() });
    return outcome.view;
  };
  const result = context.assistantHandoff
    ? await invoke(null)
    : await runIdempotentCommand<GoalView>({
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
        execute: invoke,
        replay: () => readNativeGoalView(db, goalId),
      });
  if (id === 'goal.create' && input.originThreadId && result.goal) {
    // The committed Goal is authority; publish its replayable origin snapshot outside SQL admission.
    const origin = input.originThreadId;
    const itemId = deriveEntityId('it', ['goal_handoff', goalId]);
    if (!store.listThreadItems(input.workspaceId, origin).some((item) => item.id === itemId)) {
      const turn = context.originTurnId
        ? store.getTurnById(context.originTurnId)
        : await store.createTurn(
            input.workspaceId,
            origin,
            'Goal handoff',
            { kind: 'user', id: context.actor.userId },
            undefined,
            { turnId: deriveEntityId('tu', ['goal_handoff', commandInput.requestId]) }
          );
      if (
        workspaceIdForOwner(turn.owner) !== input.workspaceId ||
        turn.threadId !== origin ||
        turn.triggerActor.id !== context.actor.userId
      )
        throw new GoalCommandError(
          'origin_authority_denied',
          'The origin Turn does not belong to this handoff.',
          403
        );
      const at = now();
      await store.createItem({
        id: itemId,
        owner: { kind: 'workspace', workspaceId: input.workspaceId },
        threadId: origin,
        turnId: turn.id,
        type: 'assistant-message',
        text: `Goal created: ${goalId} (${result.goal.threadId})`,
        status: 'completed',
        completedAt: at,
        createdAt: at,
      });
      if (!context.originTurnId)
        await store.updateTurn(turn.id, { status: 'completed', completedAt: at });
    }
  }

  if (id === 'goal.cancel' || id === 'goal.card.cancel')
    for (const link of result.tasks.filter((task) => !task.missing))
      if (id === 'goal.cancel' || ('cardId' in input && link.cardId === input.cardId))
        for (const turn of store.listThreadTurns(input.workspaceId, link.threadId))
          if (!isSealedTurnTerminal(turn.status)) services.interrupt?.(turn);
  if (services.goalDomain && result.goal) {
    try {
      if (result.goal.disposition) {
        services.goalDomain.forActor(context.actor, db).close({
          workspaceId: input.workspaceId,
          goalId,
        });
      } else if (
        id === 'goal.plan.approve' &&
        context.coordinatorTurnId &&
        input.pendingRequestId
      ) {
        const request = readPendingRequest(db.sqlite, input.pendingRequestId);
        if (request?.governedIntent?.planVersionId === result.goal.activePlanVersionId) {
          if (!request.decidingActorContext)
            throw new Error('Goal-domain deciding credential is unavailable.');
          const policy = services.goalDomain.forActor(request.decidingActorContext, db);
          policy.activate({
            workspaceId: input.workspaceId,
            requestId: input.pendingRequestId,
            expectedPolicyRevision: services.goalDomain.currentRevision(),
          });
          if (!policy.read({ workspaceId: input.workspaceId, goalId }))
            throw new Error('Goal domain was not admitted; inspect Policy before retry.');
        }
      }
    } catch (error) {
      throw new GoalCommandError(
        'goal_domain_publication_failed',
        error instanceof Error ? error.message : 'Goal-domain publication failed.'
      );
    }
  }
  await services.wake?.(input.workspaceId, goalId);
  return result;
}
