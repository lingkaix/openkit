import { isDeepStrictEqual } from 'node:util';
import { readRetainedV1, responsibleUserIdForActor, writeRetainedV1 } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  currentSchedulerAdmissionWorkspaceAuthority,
  currentWorkerLineageWorkspaceAuthority,
  currentWorkspaceAuthority,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { NotebookError } from '../knowledge/notebook.js';
import {
  type CommandRequestResponse,
  type FsStore,
  quickChatWorkspaceIdForUser,
} from '../lib/store.js';
import { IdempotencyKeyConflictError, OperationError } from '../operation-error.js';
import { readExternalTriggerPollSource } from '../runtime/external-trigger-source.js';
import { GoalCommandError } from '../runtime/goal-error.js';
import { advanceGoalRevision, goalPlanDigest } from '../runtime/goal-owner.js';
import {
  StoredGoalCardTaskV1Schema,
  StoredGoalCardV1Schema,
  StoredGoalPlanVersionV1Schema,
  StoredGoalV1Schema,
} from '../runtime/goal-retained-v1.js';
import { TurnStartValidationError } from '../runtime/orchestrator.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  retryDeniedSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { accessDenied } from '../workspace-sharing-operations.js';
import { applyAutomationDefinitionInDb } from './automation-definition-native.js';
import { parseStoredCommandScope } from './command-request-codecs.js';
import {
  assertCommandRequestDbOwner,
  commandRequestExpiresAt,
  commandRequestKey,
  getCommandRequestRecordFromDb,
  mapCommandRequestRow,
  normalizeCommandRequestResponse,
  recordControlCommandRequestRecordInDb,
  writeCommandRequestRecordInDb,
} from './command-request-records.js';
import {
  AutomationMutationError,
  AutomationRecordNotFoundError,
  type ControlAdmission,
  type ControlAdmissionInput,
  ControlAdmissionInputSchema,
  type ControlAdmissionResult,
  ControlAdmissionSchema,
  type ControlCommandReceiptAdmission,
  ControlCommandReceiptAdmissionSchema,
  type ControlKnowledgeAdmissionInput,
  ControlKnowledgeAdmissionInputSchema,
  type ControlKnowledgeAdmissionResult,
  type CoreSchedulerDraft,
  type CoreSchedulerInput,
  CoreSchedulerInputSchema,
  type CoreSchedulerResult,
  type GoalTaskCitation,
  isSeparateScopedNotebookReceipt,
  SCOPED_NOTEBOOK_SERVER_RECEIPTS,
  SCOPED_NOTEBOOK_USER_RECEIPTS,
} from './control-store-admission-codecs.js';
import { commandInputHash, presentControlFacts } from './control-store-input.js';
import {
  type ControlProductMutation,
  type ControlProductOwner,
  ControlProductPreconditionError,
  decode as decodeControlProduct,
  readProduct,
} from './control-store-product-records.js';
import {
  appendProductEntry,
  applyControlProducts,
  assertControlProductWriter,
  type PreparedControlEntry,
  readPreparedControlEntry,
} from './control-store-products.js';
import {
  type ControlStorePublicationGuard,
  getControlStoreWorkerClient,
} from './control-store-worker-client.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';
import { insertExternalTriggerAdmission } from './external-trigger-admissions.js';
import {
  applyNativeRecurringWork,
  findRecurringAutomationFromDb,
} from './recurring-attempt-native.js';
import { StoredItemV1Schema } from './retained-work-items-v1.js';
import { nativeProductScope } from './workspace-file-records.js';

/** Verifies the actual physical receipt owner, without treating extra resource selectors as new authority. */
function assertReceiptOwner(owner: ControlProductOwner, scope: Record<string, string>): void {
  if (
    scope.userId !== undefined ||
    scope.appId !== undefined ||
    (owner.kind === 'server'
      ? scope.coreId !== 'server' || scope.workspaceId !== undefined
      : scope.workspaceId !== owner.workspaceId || scope.coreId !== undefined)
  )
    throw new ControlProductPreconditionError();
}

/** The native database owner prunes ordinary expired commands; permanent event joins and other physical owners remain untouched. */
export function pruneControlAdmissionReceipts(
  sqlite: Database.Database,
  owner: ControlProductOwner | { readonly kind: 'user'; readonly userId: string },
  referenceTime: string
): void {
  assertControlProductWriter(sqlite);
  z.string().datetime().parse(referenceTime);
  if (owner.kind === 'user') {
    sqlite
      .prepare(
        `DELETE FROM idempotency_requests WHERE schema_version=1 AND expires_at IS NOT NULL AND expires_at<=? AND json_extract(scope_json,'$.userId')=? AND json_extract(scope_json,'$.coreId') IS NULL AND json_extract(scope_json,'$.workspaceId') IS NULL AND json_extract(scope_json,'$.appId') IS NULL`
      )
      .run(referenceTime, owner.userId);
    return;
  }
  const scope =
    owner.kind === 'server'
      ? "json_extract(scope_json,'$.coreId')='server' AND json_extract(scope_json,'$.workspaceId') IS NULL"
      : "json_extract(scope_json,'$.workspaceId')=? AND json_extract(scope_json,'$.coreId') IS NULL";
  sqlite
    .prepare(
      `DELETE FROM idempotency_requests WHERE schema_version=1 AND expires_at IS NOT NULL AND expires_at<=? AND ${scope} AND json_extract(scope_json,'$.userId') IS NULL AND json_extract(scope_json,'$.appId') IS NULL`
    )
    .run(referenceTime, ...(owner.kind === 'workspace' ? [owner.workspaceId] : []));
}

/** Internal reservation entry, not an additional wire producer or authority. */
export function applyControlAdmission(
  db: WorkspaceDb,
  citation: { readonly goalTaskCitation: GoalTaskCitation; readonly threadId: string },
  threads: Pick<FsStore, 'getThread' | 'listThreads'>
): void;
export function applyControlAdmission(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  value: ControlAdmission,
  entries: readonly PreparedControlEntry[]
): ControlAdmissionResult;
export function applyControlAdmission(
  db: CoreDb,
  work: Extract<ControlAdmissionInput, { kind: 'scheduler-work' }>
): CoreSchedulerResult;
export function applyControlAdmission(
  db: CoreDb | WorkspaceDb,
  work: Extract<ControlAdmissionInput, { kind: 'knowledge-work' }>
): ControlKnowledgeAdmissionResult;
export function applyControlAdmission(
  db: CoreDb | WorkspaceDb | UserDb,
  input: ControlCommandReceiptAdmission
): null;
/** Uses the actual operation's physical connection and original savepoint; scoped work also needs its canonical root binding. */
export function applyControlAdmission(
  connection: Database.Database | CoreDb | WorkspaceDb | UserDb,
  ownerOrWork:
    | ControlProductOwner
    | Extract<ControlAdmissionInput, { kind: 'scheduler-work' }>
    | Extract<ControlAdmissionInput, { kind: 'knowledge-work' }>
    | ControlCommandReceiptAdmission
    | { readonly goalTaskCitation: GoalTaskCitation; readonly threadId: string },
  value?: ControlAdmission | Pick<FsStore, 'getThread' | 'listThreads'>,
  entries: readonly PreparedControlEntry[] = []
):
  | ControlAdmissionResult
  | ControlKnowledgeAdmissionResult
  | CoreSchedulerResult
  | null
  | undefined {
  if ('sqlite' in connection && 'goalTaskCitation' in ownerOrWork) {
    const db = connection;
    if (db.scope !== 'workspace') throw new ControlProductPreconditionError();
    const store = value as Pick<FsStore, 'getThread' | 'listThreads'>;
    const input = ownerOrWork.goalTaskCitation;
    const threadId = ownerOrWork.threadId;
    if (!db.sqlite.inTransaction)
      throw new Error('Goal Task citation requires the ordinary reservation transaction.');
    const load = (table: string, key: string, id: string) =>
      db.sqlite
        .prepare(`SELECT schema_version AS schemaVersion,payload_json FROM ${table} WHERE ${key}=?`)
        .get(id) as { schemaVersion: unknown; payload_json: string } | undefined;
    const goalRow = load('goals', 'goal_id', input.goalId);
    const cardRow = load('goal_cards', 'card_id', input.cardId);
    const planRow = load('goal_plan_versions', 'plan_version_id', input.planVersionId);
    if (!goalRow || !cardRow || !planRow)
      throw new GoalCommandError('not_found', 'Goal admission records are unavailable.', 404);
    const goal = readRetainedV1(goalRow, () =>
      StoredGoalV1Schema.parse(JSON.parse(goalRow.payload_json))
    );
    const card = readRetainedV1(cardRow, () =>
      StoredGoalCardV1Schema.parse(JSON.parse(cardRow.payload_json))
    );
    const plan = readRetainedV1(planRow, () =>
      StoredGoalPlanVersionV1Schema.parse(JSON.parse(planRow.payload_json))
    );
    if (
      goalPlanDigest(plan.bytes) !== plan.digest ||
      JSON.stringify(plan.commitment) !== plan.bytes
    )
      throw new GoalCommandError(
        'admission_conflict',
        'The immutable Plan bytes or digest are inconsistent.'
      );
    if (goal.disposition || card.cancelled)
      throw new GoalCommandError('goal_cancelled', 'Goal or card has ended.');
    if (
      goal.workspaceId !== db.workspaceId ||
      card.goalId !== goal.goalId ||
      plan.goalId !== goal.goalId ||
      goal.activePlanVersionId !== plan.planVersionId ||
      card.revision !== input.cardRevision ||
      goal.intentRevision !== input.intentRevision
    )
      throw new GoalCommandError(
        'admission_conflict',
        'Current intent, card or Plan changed before reservation.'
      );
    if (!input.withinCurrentIntent || !input.withinPermittedAdjustments || !input.rationale.trim())
      throw new GoalCommandError(
        'new_plan_required',
        'The contemplated work is not authorized by current intent and permitted adjustments.'
      );
    const thread = store.getThread(db.workspaceId, threadId);
    if (thread.visibility !== 'workspace')
      throw new GoalCommandError(
        'shared_thread_required',
        'Task admission requires an ordinary shared Thread.'
      );
    const missing = (
      db.sqlite
        .prepare(
          'SELECT schema_version AS schemaVersion,thread_id FROM goal_card_tasks WHERE card_id=?'
        )
        .all(card.cardId) as {
        schemaVersion: unknown;
        thread_id: string;
      }[]
    ).some((link) =>
      readRetainedV1(
        link,
        () => !store.listThreads(db.workspaceId).some((t) => t.id === link.thread_id)
      )
    );
    if (missing)
      throw new GoalCommandError(
        'missing_task',
        'A missing linked Task remains unresolved; it cannot authorize a duplicate.'
      );
    const link = StoredGoalCardTaskV1Schema.parse({
      goalId: goal.goalId,
      cardId: card.cardId,
      threadId,
      planVersionId: plan.planVersionId,
      cardRevision: card.revision,
    });
    db.sqlite
      .prepare(
        'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json,schema_version) VALUES (?,?,?,?,?)'
      )
      .run(
        threadId,
        goal.goalId,
        card.cardId,
        JSON.stringify(link),
        writeRetainedV1({}).schemaVersion
      );
    advanceGoalRevision(db, goal.goalId);
    return;
  }
  if ('sqlite' in connection) {
    assertControlProductWriter(connection.sqlite);
    const work = ControlAdmissionInputSchema.parse(ownerOrWork);
    if (!('kind' in work)) throw new ControlProductPreconditionError();
    if (work.kind === 'command-receipt') {
      admitCommandReceipt(connection, work);
      return null;
    }
    if (work.kind === 'scheduler-work') {
      if (connection.scope !== 'core') throw new ControlProductPreconditionError();
      return admitCoreSchedulerWork(connection, work.input);
    }
    if (connection.scope === 'user') throw new ControlProductPreconditionError();
    return admitKnowledgeWork(connection, work.input);
  }
  if ('goalTaskCitation' in ownerOrWork) throw new ControlProductPreconditionError();
  const sqlite = connection;
  assertControlProductWriter(sqlite);
  if ('kind' in ownerOrWork && ownerOrWork.kind !== 'workspace' && ownerOrWork.kind !== 'server')
    throw new ControlProductPreconditionError();
  const owner = ownerOrWork;
  const input = ControlAdmissionSchema.parse(value);
  const receipt = input.receipt;
  assertReceiptOwner(owner, receipt.scope);
  if (
    receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
    receipt.expiresAt <= receipt.createdAt
  )
    throw new ControlProductPreconditionError();
  let response = normalizeCommandRequestResponse(
    receipt.command,
    receipt.response as CommandRequestResponse
  );
  const prior = sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion,request_key AS key,command_name AS command,request_id AS requestId,scope_json AS scopeJson,input_hash AS inputHash,response_kind AS responseKind,response_id AS responseId,response_json AS responseJson,created_at AS createdAt,expires_at AS expiresAt FROM idempotency_requests WHERE request_key=?'
    )
    .get(receipt.key) as Parameters<typeof mapCommandRequestRow>[0] | undefined;
  if (prior && (prior.expiresAt === null || prior.expiresAt > receipt.createdAt)) {
    // Retained descriptive additions use the frozen reader, never the stricter current writer parser.
    const retained = mapCommandRequestRow(prior);
    if (
      retained.command !== receipt.command ||
      retained.requestId !== receipt.requestId ||
      !isDeepStrictEqual(retained.scope, receipt.scope) ||
      retained.inputHash !== receipt.inputHash
    )
      throw new ControlProductPreconditionError();
    return { replayed: true, response: retained.response };
  }
  const steerEntry = receipt.command === 'task.steer' ? entries[0] : undefined;
  const steerItem = steerEntry
    ? StoredItemV1Schema.parse(readPreparedControlEntry(steerEntry))
    : undefined;
  const disposition = steerItem?.type === 'user-message' ? steerItem.steerDisposition : undefined;
  if (receipt.command === 'task.steer') {
    const previous = steerEntry?.previousItem;
    if (
      owner.kind !== 'workspace' ||
      input.products.length !== 0 ||
      entries.length !== 1 ||
      (input.pending?.length ?? 0) !== 0 ||
      !steerEntry ||
      steerEntry.input.kind !== 'item' ||
      !steerItem ||
      steerItem.type !== 'user-message' ||
      steerItem.actor.kind !== 'user' ||
      !previous ||
      previous.type !== 'user-message' ||
      !disposition ||
      response.kind !== 'turn' ||
      response.id !== steerItem.turnId ||
      steerItem.threadId !== receipt.scope.threadId ||
      steerItem.actor.id !== receipt.scope.actorId ||
      steerItem.causationId !== `task.steer:${receipt.requestId}` ||
      disposition.inputHash !== receipt.inputHash ||
      receipt.inputHash !==
        commandInputHash({
          workspaceId: owner.workspaceId,
          threadId: steerItem.threadId,
          turnId: steerItem.turnId,
          input: steerItem.text,
        }) ||
      !isDeepStrictEqual(
        { ...steerItem, steerDisposition: undefined },
        { ...previous, steerDisposition: undefined }
      ) ||
      input.audit.threadId !== steerItem.threadId ||
      input.audit.turnId !== steerItem.turnId ||
      input.audit.itemId !== steerItem.id ||
      input.audit.actor?.kind !== 'user' ||
      input.audit.actor.id !== steerItem.actor.id
    )
      throw new ControlProductPreconditionError();
    if (previous.steerDisposition) {
      if (!isDeepStrictEqual(previous.steerDisposition, disposition))
        throw new ControlProductPreconditionError();
      return { replayed: true, response };
    }
  }
  let products = input.products;
  let event = input.audit;
  if (receipt.command === 'thread.create' && owner.kind === 'workspace') {
    const threads = input.products.filter((product) => product.kind === 'thread');
    if (threads.length === 1) {
      const candidate = decodeControlProduct('thread', threads[0]!.record, owner);
      if (candidate.visibility === 'private' && candidate.entryPath === 'conversation') {
        if (
          threads[0]!.expectedRevision !== 0 ||
          typeof candidate.privateOwnerUserId !== 'string' ||
          input.entries.length > 0 ||
          input.products.some(
            (product) => product.kind !== 'thread' && product.kind !== 'workspace'
          )
        )
          throw new ControlProductPreconditionError();
        for (const product of input.products)
          decodeControlProduct(product.kind, product.record, owner);
        let selected = sqlite
          .prepare(
            "SELECT id FROM control_threads WHERE json_extract(record_json,'$.visibility')='private' AND json_extract(record_json,'$.entryPath')='conversation' AND json_extract(record_json,'$.privateOwnerUserId')=? ORDER BY julianday(json_extract(record_json,'$.createdAt')),id LIMIT 1"
          )
          .get(candidate.privateOwnerUserId) as { id: string } | undefined;
        if (selected) {
          const visited = new Set<string>();
          for (;;) {
            if (visited.has(selected.id)) throw new ControlProductPreconditionError();
            visited.add(selected.id);
            const current = readProduct(sqlite, owner, 'thread', selected.id)!;
            const successors = sqlite
              .prepare(
                "SELECT id FROM control_threads WHERE json_extract(record_json,'$.parentThreadId')=? AND json_extract(record_json,'$.segment')=?"
              )
              .all(selected.id, Number(current.record.segment ?? 0) + 1) as { id: string }[];
            if (successors.length > 1) throw new ControlProductPreconditionError();
            if (!successors[0]) break;
            selected = successors[0];
          }
          // Selection is native and preserves existing, including archived, history even when fresh commands race.
          const existing = readProduct(sqlite, owner, 'thread', selected.id);
          if (!existing) throw new ControlProductPreconditionError();
          response = { kind: 'thread', id: selected.id };
          products = [];
          event = { ...event, threadId: selected.id, resource: `thread:${selected.id}` };
        }
      }
    }
  }
  if (
    event.action !== receipt.command ||
    event.requestId !== receipt.requestId ||
    event.workspaceId !== (owner.kind === 'workspace' ? owner.workspaceId : null) ||
    event.outcome !==
      (receipt.command === 'task.steer' && disposition?.disposition !== 'accepted'
        ? 'failed'
        : 'succeeded')
  )
    throw new ControlProductPreconditionError();
  pruneControlAdmissionReceipts(sqlite, owner, receipt.createdAt);
  if (steerEntry) {
    // Item-only disposition does not run received-influence or any Turn-head projection.
    const next = (
      sqlite
        .prepare(
          "SELECT coalesce(max(sequence),0)+1 AS sequence FROM control_product_entries WHERE kind='item' AND turn_id=?"
        )
        .get(steerEntry.input.turnId) as { sequence: number }
    ).sequence;
    appendProductEntry(sqlite, { ...steerEntry, input: { ...steerEntry.input, sequence: next } });
  } else applyControlProducts(sqlite, owner, products, entries);
  const targetKind =
    response.kind === 'thread' ? 'thread' : response.kind === 'turn' ? 'turn' : null;
  if (
    !targetKind ||
    !sqlite
      .prepare(
        `SELECT 1 FROM ${targetKind === 'thread' ? 'control_threads' : 'control_turns'} WHERE id=?`
      )
      .get(response.id)
  )
    throw new ControlProductPreconditionError();
  sqlite
    .prepare(
      'INSERT INTO idempotency_requests (schema_version,request_key,command_name,request_id,scope_json,input_hash,response_kind,response_id,response_json,created_at,expires_at) VALUES (1,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      receipt.key,
      receipt.command,
      receipt.requestId,
      JSON.stringify(receipt.scope),
      receipt.inputHash,
      response.kind,
      response.id,
      response.conversationMetadata === undefined
        ? null
        : JSON.stringify(response.conversationMetadata),
      receipt.createdAt,
      receipt.expiresAt
    );
  // Same retained Audit shape, but a separate logical row-family owner; no call through a main-thread writer or fake Store.
  const audit = {
    schema_version: 1,
    audit_event_id: event.id,
    workspace_id: event.workspaceId,
    protocol_version: event.protocolVersion ?? null,
    thread_id: event.threadId,
    turn_id: event.turnId,
    item_id: event.itemId,
    capability_call_id: event.capabilityCallId,
    permission_decision_id: event.permissionDecisionId,
    vault_grant_id: event.vaultGrantId,
    request_id: event.requestId,
    actor_json: event.actor === null ? null : JSON.stringify(event.actor),
    authentication_json:
      event.authentication === undefined ? null : JSON.stringify(event.authentication),
    subject_json: event.subject === null ? null : JSON.stringify(event.subject),
    agent_id: event.agentId,
    agent_session_id: event.agentSessionId,
    category: event.category,
    action: event.action,
    resource: event.resource,
    resource_revision: event.resourceRevision,
    notebook_admission_json:
      event.notebookAdmission === undefined ? null : JSON.stringify(event.notebookAdmission),
    policy_invocation_json:
      event.policyInvocation === undefined ? null : JSON.stringify(event.policyInvocation),
    policy_write_outcome_json:
      event.policyWriteOutcome === undefined ? null : JSON.stringify(event.policyWriteOutcome),
    outcome: event.outcome,
    severity: event.severity,
    summary: event.summary,
    error_code: event.errorCode,
    created_at: event.createdAt,
    occurred_at: event.occurredAt,
  };
  const columns = Object.keys(audit);
  sqlite
    .prepare(
      `INSERT INTO audit_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    .run(...Object.values(audit));
  return { replayed: false, response };
}

/** Preserves each original receipt's exact physical owner and its atomic or post-ACK maintenance boundary. */
function admitCommandReceipt(
  db: CoreDb | WorkspaceDb | UserDb,
  input: ControlCommandReceiptAdmission
): void {
  if (!db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const scope: Readonly<Record<string, string>> =
    input.stage === 'record' ? parseStoredCommandScope(input.receipt.scope) : input.scope;
  assertCommandRequestDbOwner(db, scope);
  const owner =
    db.scope === 'core'
      ? { kind: 'server' as const }
      : db.scope === 'user'
        ? { kind: 'user' as const, userId: db.userId }
        : { kind: 'workspace' as const, workspaceId: db.workspaceId };
  if (input.stage === 'maintenance') {
    pruneControlAdmissionReceipts(db.sqlite, owner, input.referenceTime);
    return;
  }
  const record = { ...input.receipt, scope };
  const notebook = record.command.startsWith('knowledge.');
  if (
    record.key !== commandRequestKey(record.command, record.requestId, record.scope) ||
    (!notebook && record.expiresAt !== commandRequestExpiresAt(record.createdAt)) ||
    (notebook &&
      !(
        db.scope === 'user'
          ? SCOPED_NOTEBOOK_USER_RECEIPTS
          : db.scope === 'core'
            ? SCOPED_NOTEBOOK_SERVER_RECEIPTS
            : []
      ).some((name) => name === record.command)) ||
    (record.command === 'workspace.update' &&
      (db.scope !== 'workspace' || record.response.id !== db.workspaceId)) ||
    (record.command === 'worker_environment.purge' &&
      record.response.id !== record.scope.storageRef) ||
    (record.command === 'workspace_sync.review.decide' &&
      record.response.id !== record.scope.reviewId) ||
    ((record.response.kind === 'skill_catalog' || record.response.kind === 'light_app_catalog') &&
      (db.scope !== 'workspace' || record.response.id !== db.workspaceId)) ||
    ((record.command === 'artifact.version-commit' ||
      record.command === 'artifact.version-file-commit') &&
      record.response.id !== record.scope.artifactId) ||
    (record.command === 'catalog.skill-candidate-submit' &&
      record.scope.candidateId !== undefined) ||
    ((record.command === 'catalog.skill-candidate-decide' ||
      record.command === 'catalog.skill-candidate-withdraw') &&
      record.scope.candidateId !== record.response.id)
  )
    throw new ControlProductPreconditionError();
  writeCommandRequestRecordInDb(db, record);
  if (
    notebook &&
    db.scope !== 'workspace' &&
    !isSeparateScopedNotebookReceipt(db.scope, record.command)
  )
    pruneControlAdmissionReceipts(db.sqlite, owner, record.createdAt);
}

type Turn = ReturnType<FsStore['getTurnById']>;

// Keep the synchronous native tuple independent of the model, editor and provider orchestration graph.
/**
 * Selects and admits complete Knowledge work against current native scope state in the caller's savepoint.
 *
 * Workspace/User maintenance serializes on its existing notebook Thread. Queries always create a fresh Thread. User Memory receipts remain in User SQLite and cannot join this Workspace transaction. No file effects, callback or commit occurs here. User-home admission reads its Core binding through the existing read-only view; it writes only this scope.
 */
function admitKnowledgeWork(
  db: CoreDb | WorkspaceDb,
  value: ControlKnowledgeAdmissionInput
): ControlKnowledgeAdmissionResult {
  assertControlProductWriter(db.sqlite);
  const input = ControlKnowledgeAdmissionInputSchema.parse(value);
  const userId = responsibleUserIdForActor(input.actor);
  // Preserve a denied Server daily outcome without borrowing a responsible User.
  if (
    !userId &&
    !(
      input.purpose === 'maintenance' &&
      input.ownerScope.kind === 'server' &&
      input.trigger === 'schedule' &&
      input.actor.kind === 'system' &&
      input.actor.id === 'knowledge-manager' &&
      input.receipt === undefined
    )
  )
    throw new NotebookError('invalid_request');
  const owner =
    db.scope === 'core'
      ? { kind: 'server' as const }
      : { kind: 'workspace' as const, workspaceId: db.workspaceId };
  if (
    (input.ownerScope.kind === 'server') !== (db.scope === 'core') ||
    (input.ownerScope.kind === 'workspace' &&
      (db.scope !== 'workspace' || input.ownerScope.workspaceId !== db.workspaceId)) ||
    (input.ownerScope.kind === 'user' &&
      (input.ownerScope.userId !== userId ||
        db.scope !== 'workspace' ||
        (input.purpose === 'maintenance' &&
          db.workspaceId !== quickChatWorkspaceIdForUser(userId, db.dataRoot)))) ||
    (input.purpose === 'query' && (db.scope !== 'workspace' || input.trigger !== 'request')) ||
    (input.purpose === 'maintenance' && input.outputThreadId !== undefined)
  )
    throw new NotebookError('invalid_request');
  const receipt = input.receipt;
  if (receipt) {
    if (
      input.purpose !== 'maintenance' ||
      input.ownerScope.kind === 'user' ||
      receipt.requestId !== input.requestId ||
      receipt.scope.actorId !== input.actor.id ||
      receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
      receipt.expiresAt <= receipt.createdAt ||
      (owner.kind === 'server'
        ? !('coreId' in receipt.scope) ||
          receipt.scope.coreId !== 'server' ||
          !receipt.command.startsWith('knowledge.server.')
        : !('workspaceId' in receipt.scope) ||
          receipt.scope.workspaceId !== owner.workspaceId ||
          receipt.command.startsWith('knowledge.server.'))
    )
      throw new NotebookError('invalid_request');
    const prior = getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt);
    if (prior) {
      if (
        prior.command !== receipt.command ||
        prior.requestId !== receipt.requestId ||
        commandRequestKey(prior.command, prior.requestId, prior.scope) !== receipt.key
      )
        throw new NotebookError('recovery_required');
      if (prior.inputHash !== receipt.inputHash) throw new IdempotencyKeyConflictError();
      const turn = readProduct(db.sqlite, owner, 'turn', prior.response.id);
      if (!turn || prior.response.kind !== 'turn') throw new NotebookError('recovery_required');
      return {
        threadId: turn.record.threadId as string,
        turnId: prior.response.id,
        busy: false,
        replayed: true,
      };
    }
  }
  const workspace =
    owner.kind === 'workspace'
      ? readProduct(db.sqlite, owner, 'workspace', owner.workspaceId)
      : undefined;
  if (
    (owner.kind === 'workspace' && workspace?.record.status !== 'active') ||
    (input.ownerScope.kind === 'user' &&
      input.purpose === 'maintenance' &&
      workspace?.record.kind !== 'personal')
  )
    throw new NotebookError('invalid_request');
  // Decode every candidate through the retained owner. Unknown core semantics must not disappear from selection.
  const threads =
    input.purpose === 'query'
      ? []
      : (
          db.sqlite.prepare('SELECT id FROM control_threads ORDER BY id').all() as { id: string }[]
        ).map(({ id }) => readProduct(db.sqlite, owner, 'thread', id)!);
  const turns =
    input.purpose === 'query'
      ? []
      : (
          db.sqlite.prepare('SELECT id FROM control_turns ORDER BY id').all() as { id: string }[]
        ).map(({ id }) => readProduct(db.sqlite, owner, 'turn', id)!);
  const summary =
    input.purpose === 'query'
      ? 'Knowledge question.'
      : input.ownerScope.kind === 'user'
        ? 'User Memory maintenance.'
        : input.trigger === 'schedule'
          ? 'Knowledge Manager scheduled maintenance.'
          : 'Knowledge maintenance.';
  const priorRuns =
    input.purpose === 'query'
      ? []
      : turns.filter(({ record }) => {
          const knowledge = (record.internalExecution as Turn['internalExecution'])?.knowledge;
          if (knowledge?.purpose === 'maintenance') {
            const scope = knowledge.ownerScope;
            return (
              scope.kind === input.ownerScope.kind &&
              (scope.kind === 'workspace'
                ? input.ownerScope.kind === 'workspace' &&
                  scope.workspaceId === input.ownerScope.workspaceId
                : scope.kind === 'user'
                  ? input.ownerScope.kind === 'user' && scope.userId === input.ownerScope.userId
                  : true)
            );
          }
          const trigger = record.triggerSource as Turn['triggerSource'];
          return (
            record.agentId === 'knowledge-manager' &&
            (input.ownerScope.kind === 'user'
              ? trigger?.summary === 'User Memory maintenance.'
              : trigger?.summary === 'Knowledge maintenance.' ||
                trigger?.summary === 'Knowledge Manager scheduled maintenance.')
          );
        });
  const ids = new Set(priorRuns.map(({ record }) => record.threadId as string));
  if (input.ownerScope.kind === 'server' && input.purpose === 'maintenance')
    for (const thread of threads)
      if (thread.record.entryPath === 'knowledge-manager') ids.add(thread.record.id as string);
  if (ids.size > 1) throw new NotebookError('recovery_required');
  const existingId = [...ids][0];
  const existing = existingId ? threads.find(({ record }) => record.id === existingId) : undefined;
  if (existingId && !existing) throw new NotebookError('recovery_required');
  let visibility: 'private' | 'workspace' | 'server' =
    owner.kind === 'server' ? 'server' : 'workspace';
  if (input.ownerScope.kind === 'user' || input.purpose === 'query') visibility = 'private';
  if (input.outputThreadId) {
    const parent = readProduct(db.sqlite, owner, 'thread', input.outputThreadId);
    if (
      !parent ||
      (parent.record.visibility === 'private' && parent.record.privateOwnerUserId !== userId)
    )
      throw new NotebookError('invalid_request');
    if (input.ownerScope.kind !== 'user' && parent.record.visibility === 'workspace')
      visibility = 'workspace';
  }
  // Exact retained maintenance scope owns Thread selection; older runs can use a conversation entry path.
  if (
    existing &&
    (existing.record.status !== 'active' ||
      existing.record.visibility !== visibility ||
      (visibility === 'private' && existing.record.privateOwnerUserId !== userId))
  )
    throw new NotebookError('recovery_required');
  // Daily occurrence selection belongs to the scanner; only the original command receipt can replay a request.
  const threadId = existingId ?? input.threadId;
  const busy =
    input.purpose === 'maintenance' &&
    turns.some(
      ({ record }) =>
        record.threadId === threadId && (record.status === 'running' || record.status === 'pending')
    );
  const title =
    input.purpose === 'query'
      ? 'Knowledge question'
      : input.ownerScope.kind === 'user'
        ? 'Memory maintenance'
        : owner.kind === 'server'
          ? 'Server Knowledge maintenance'
          : 'Knowledge maintenance';
  const products: ControlProductMutation[] = [];
  if (workspace)
    products.push({
      kind: 'workspace',
      expectedRevision: workspace.revision,
      record: { ...workspace.record, updatedAt: input.startedAt },
    });
  products.push({
    kind: 'thread',
    expectedRevision: existing?.revision ?? 0,
    record: {
      ...(existing?.record ?? {
        schemaVersion: 1,
        id: threadId,
        owner,
        name: title,
        status: 'active',
        entryPath: 'knowledge-manager',
        threadSource: 'conversation',
        visibility,
        ...(visibility === 'private' ? { privateOwnerUserId: userId } : {}),
        createdAt: input.startedAt,
      }),
      schemaVersion: 1,
      preview: input.instructions.slice(0, 160),
      updatedAt: input.startedAt,
    },
  });
  products.push({
    kind: 'turn',
    expectedRevision: 0,
    record: {
      schemaVersion: 1,
      id: input.turnId,
      owner,
      threadId,
      triggerActor: input.actor,
      status: 'running',
      error: null,
      configVersion: null,
      startedAt: input.startedAt,
      completedAt: null,
      durationMs: null,
      agentId: 'knowledge-manager',
      triggerSource: {
        kind: input.trigger === 'schedule' ? 'automation' : 'system-input',
        summary,
      },
      captureCoverage: input.captureCoverage,
    },
  });
  if (busy) {
    // A skipped service Turn owns no execution or external effects. It must be born terminal so the existing single-flight index keeps the active run excluded.
    const skipped = products.pop()!;
    const record = {
      ...skipped.record,
      items: [],
      status: 'completed',
      completedAt: input.startedAt,
      durationMs: 0,
    };
    decodeControlProduct('turn', record, owner);
    applyControlProducts(db.sqlite, owner, products, []);
    db.sqlite
      .prepare(
        'INSERT INTO control_turns (id,schema_version,revision,record_json,thread_id,agent_session_id,status) VALUES (?,1,1,?,?,NULL,?)'
      )
      .run(input.turnId, JSON.stringify(record), threadId, 'completed');
  } else {
    applyControlProducts(db.sqlite, owner, products, []);
  }
  if (receipt) {
    const response = normalizeCommandRequestResponse(receipt.command, {
      kind: 'turn',
      id: input.turnId,
    });
    recordControlCommandRequestRecordInDb(db, { ...receipt, response });
  }
  return { threadId, turnId: input.turnId, busy, replayed: false };
}

/** Original Core policy/queue/source tuple, decided only by its owning native savepoint. */
function admitCoreSchedulerWork(db: CoreDb, raw: CoreSchedulerInput): CoreSchedulerResult {
  assertControlProductWriter(db.sqlite);
  const input = CoreSchedulerInputSchema.parse(raw);
  if (input.mode === 'definition') {
    if (
      input.actor &&
      (input.actor.userId !== input.userId ||
        !isWorkspaceOperationAuthorized(db, presentControlFacts(input.actor), input.workspaceId, {
          mutating: true,
          policyOperation: 'workspace.configure',
        }))
    )
      throw accessDenied();
    try {
      const actualWorkspace =
        input.mutation.action === 'create'
          ? input.mutation.input.workspaceId
          : findRecurringAutomationFromDb(db, input.mutation.id)?.workspaceId;
      if (actualWorkspace !== input.workspaceId)
        throw new AutomationRecordNotFoundError(`Automation not found: ${input.mutation.id}`);
      return {
        kind: 'definition',
        record: applyAutomationDefinitionInDb(db, input.userId, input.mutation, input.timestamp),
      };
    } catch (error) {
      if (error instanceof AutomationMutationError)
        throw new OperationError('automation_conflict', error.message, 409, { cause: error });
      if (error instanceof AutomationRecordNotFoundError)
        throw new OperationError(
          input.mutation.action === 'delete'
            ? 'automation_delete_failed'
            : 'automation_update_failed',
          error.message,
          404,
          { cause: error }
        );
      throw error;
    }
  }
  if (input.mode === 'recurring-attempt' || input.mode === 'recurring-publication')
    return { kind: 'occurrence', occurrence: applyNativeRecurringWork(db, input) };
  if (input.mode === 'create') {
    if (input.external) {
      const { source, scheduleId } = input.external;
      const schedule = findRecurringAutomationFromDb(db, scheduleId);
      const { occurrence } = readExternalTriggerPollSource(db, source.turnId);
      if (
        !schedule ||
        schedule.status !== 'active' ||
        schedule.workspaceId !== source.workspaceId ||
        occurrence.scheduleId !== scheduleId ||
        occurrence.snapshot.threadId !== source.threadId ||
        !isDeepStrictEqual(schedule.actor, source.triggerActor) ||
        !isDeepStrictEqual(occurrence.snapshot.actor, source.triggerActor) ||
        !isDeepStrictEqual(input.entry.triggerActor, source.triggerActor) ||
        input.entry.workspaceId !== source.workspaceId ||
        !currentWorkerLineageWorkspaceAuthority(db, source, 'turn.run', true) ||
        !currentWorkerLineageWorkspaceAuthority(db, source, 'runtime.launch', true)
      )
        throw new OperationError(
          'external_event_denied',
          'Scheduled poll admission was denied.',
          403
        );
    } else if (
      !currentSchedulerAdmissionWorkspaceAuthority(
        db,
        {
          ...input.entry,
          serverAdminTokenId: input.entry.serverAdminTokenId ?? null,
          credentialRef: input.entry.credentialRef ?? null,
        },
        'runtime.launch',
        true
      )
    )
      throw accessDenied();
    if (
      db.sqlite
        .prepare(
          "SELECT 1 FROM scheduler_admission_entries WHERE workspace_id = ? AND thread_id = ? AND turn_id <> ? AND status = 'queued' LIMIT 1"
        )
        .get(input.entry.workspaceId, input.entry.threadId, input.entry.turnId)
    )
      throw new OperationError('thread_busy', 'Thread already has a nonterminal Turn.', 409);
    const entry = createSchedulerAdmissionEntry(
      db,
      presentControlFacts({
        ...input.entry,
        ...(input.entry.timestamp ? { now: () => input.entry.timestamp! } : {}),
      })
    );
    if (!input.external) return { kind: 'queue', entry };
    const external = insertExternalTriggerAdmission(db, {
      scheduleId: input.external.scheduleId,
      eventKey: input.external.eventKey,
      sourceTurnId: input.external.source.turnId,
      queueEntryId: entry.queueEntryId,
    });
    if (external.queueEntryId !== entry.queueEntryId)
      throw new OperationError(
        'recovery_required',
        'Accepted external event work requires inspection.',
        409
      );
    return { kind: 'queue', entry, external };
  }
  if (
    (input.mode === 'retry' || input.mode === 'cancel') &&
    input.actor &&
    !('userId' in input.actor
      ? isWorkspaceOperationAuthorized(db, presentControlFacts(input.actor), input.workspaceId, {
          mutating: true,
          policyOperation: 'turn.run',
        })
      : input.lineage &&
        input.lineage.workspaceId === input.workspaceId &&
        currentWorkerLineageWorkspaceAuthority(
          db,
          { ...input.lineage, triggerActor: input.actor },
          'turn.run',
          true
        ) &&
        currentWorkspaceAuthority(db, input.workspaceId, input.actor, 'turn.run', true))
  )
    throw accessDenied();
  // Denial may come from the live policy owner; it grants no execution authority.
  const entry =
    input.mode === 'deny'
      ? denySchedulerAdmissionEntry(db, input)
      : input.mode === 'retry'
        ? retryDeniedSchedulerAdmissionEntry(db, input)
        : cancelSchedulerAdmissionEntry(db, input);
  return { kind: 'queue', entry };
}

/** Original complete Core scheduler business admission; preparation still follows native open. */
export async function admitCoreScheduler<I extends CoreSchedulerDraft>(
  db: CoreDb,
  input: I,
  prepare?: (input: I) => I | CoreSchedulerInput | Promise<I | CoreSchedulerInput>,
  publicationGuard?: ControlStorePublicationGuard
): Promise<CoreSchedulerResult> {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const prepared = prepare ? await prepare(snapshot) : snapshot;
  const ready = CoreSchedulerInputSchema.parse(
    prepared.mode === 'create'
      ? {
          ...prepared,
          entry: {
            ...prepared.entry,
            timestamp: prepared.entry.timestamp ?? new Date().toISOString(),
          },
        }
      : prepared
  );
  try {
    return await client.transition(
      database,
      { kind: 'scheduler-work', input: ready },
      ...(publicationGuard ? ([publicationGuard] as const) : [])
    );
  } catch (error) {
    if (input.mode === 'definition' && error instanceof OperationError) {
      if (error.code === 'automation_conflict') throw new AutomationMutationError(error.message);
      if (error.code === 'automation_update_failed' || error.code === 'automation_delete_failed')
        throw new AutomationRecordNotFoundError(error.message);
    }
    if (input.mode === 'create' && error instanceof OperationError)
      throw new TurnStartValidationError(error.code, error.message, error.status);
    throw error;
  }
}
