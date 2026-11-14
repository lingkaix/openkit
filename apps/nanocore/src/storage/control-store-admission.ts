import { isDeepStrictEqual } from 'node:util';
import { responsibleUserIdForActor } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { NotebookError } from '../knowledge/notebook.js';
import type { CommandRequestResponse } from '../lib/store.js';
import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { IdempotencyKeyConflictError } from '../operation-error.js';
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
  isSeparateScopedNotebookReceipt,
  SCOPED_NOTEBOOK_SERVER_RECEIPTS,
  SCOPED_NOTEBOOK_USER_RECEIPTS,
} from './control-store-admission-codecs.js';
import { commandInputHash } from './control-store-input.js';
import {
  type ControlProductMutation,
  type ControlProductOwner,
  ControlProductPreconditionError,
  decode as decodeControlProduct,
  readProduct,
} from './control-store-product-records.js';
import {
  applyControlProducts,
  assertControlProductWriter,
  type PreparedControlEntry,
  type prepareControlTaskSteerReceipt,
} from './control-store-products.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';

/** Existing target annotations partition the shared judgement operation without changing its retained scope or adding ownership state. */
export const CONTROL_NATIVE_EVALUATION_RECEIPT_SQL = `(command_name='evaluation.judgement-add'
  AND response_kind='evaluation_judgement' AND response_id=request_id
  AND (EXISTS (SELECT 1 FROM artifact_reviews AS review, json_each(review.judgements) AS annotation
    WHERE review.workspace_id=json_extract(idempotency_requests.scope_json,'$.workspaceId')
      AND json_extract(annotation.value,'$.requestId')=idempotency_requests.request_id)
    OR EXISTS (SELECT 1 FROM workspace_material_revisions AS revision, json_each(revision.judgements) AS annotation
    WHERE revision.workspace_id=json_extract(idempotency_requests.scope_json,'$.workspaceId')
      AND json_extract(annotation.value,'$.requestId')=idempotency_requests.request_id)
    OR EXISTS (SELECT 1 FROM evaluation_candidate_sets AS candidate, json_each(candidate.payload_json,'$.judgements') AS annotation
    WHERE candidate.workspace_id=json_extract(idempotency_requests.scope_json,'$.workspaceId')
      AND json_extract(annotation.value,'$.requestId')=idempotency_requests.request_id)))`;

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

export function applyControlAdmission(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  value: ControlAdmission,
  entries: readonly PreparedControlEntry[],
  preparedSteer?: Awaited<ReturnType<typeof prepareControlTaskSteerReceipt>>
): ControlAdmissionResult;
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
    | Extract<ControlAdmissionInput, { kind: 'knowledge-work' }>
    | ControlCommandReceiptAdmission,
  value?: ControlAdmission,
  entries: readonly PreparedControlEntry[] = [],
  preparedSteer?: Awaited<ReturnType<typeof prepareControlTaskSteerReceipt>>
): ControlAdmissionResult | ControlKnowledgeAdmissionResult | null {
  if ('sqlite' in connection) {
    assertControlProductWriter(connection.sqlite);
    const work = ControlAdmissionInputSchema.parse(ownerOrWork);
    if (!('kind' in work)) throw new ControlProductPreconditionError();
    if (work.kind === 'command-receipt') {
      admitCommandReceipt(connection, work);
      return null;
    }
    if (connection.scope === 'user') throw new ControlProductPreconditionError();
    return admitKnowledgeWork(connection, work.input);
  }
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
  if (receipt.command === 'task.steer') {
    const metadata = response.steerMetadata;
    const item = preparedSteer?.item;
    const row = preparedSteer?.row;
    const current = row
      ? (sqlite
          .prepare(
            "SELECT content_json AS contentJson FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
          )
          .get(row.id) as { contentJson: string } | undefined)
      : undefined;
    if (
      owner.kind !== 'workspace' ||
      !metadata ||
      !item ||
      item.type !== 'user-message' ||
      item.actor.kind !== 'user' ||
      response.kind !== 'turn' ||
      response.id !== metadata.turnId ||
      item.turnId !== metadata.turnId ||
      item.id !== metadata.inputItemId ||
      item.threadId !== receipt.scope.threadId ||
      item.actor.id !== receipt.scope.actorId ||
      item.causationId !== `task.steer:${receipt.requestId}` ||
      metadata.inputHash !== receipt.inputHash ||
      receipt.inputHash !==
        commandInputHash({
          workspaceId: owner.workspaceId,
          threadId: item.threadId,
          turnId: item.turnId,
          input: item.text,
        }) ||
      current?.contentJson !== row?.content_json ||
      input.audit.threadId !== item.threadId ||
      input.audit.turnId !== item.turnId ||
      input.audit.itemId !== item.id ||
      input.audit.actor?.kind !== 'user' ||
      input.audit.actor.id !== item.actor.id
    )
      throw new ControlProductPreconditionError();
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
        const selected = sqlite
          .prepare(
            "SELECT id FROM control_threads WHERE json_extract(record_json,'$.visibility')='private' AND json_extract(record_json,'$.entryPath')='conversation' AND json_extract(record_json,'$.privateOwnerUserId')=? ORDER BY julianday(json_extract(record_json,'$.createdAt')),id LIMIT 1"
          )
          .get(candidate.privateOwnerUserId) as { id: string } | undefined;
        if (selected) {
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
      (receipt.command === 'task.steer' && response.steerMetadata?.disposition !== 'accepted'
        ? 'failed'
        : 'succeeded')
  )
    throw new ControlProductPreconditionError();
  pruneControlAdmissionReceipts(sqlite, owner, receipt.createdAt);
  applyControlProducts(sqlite, owner, products, entries);
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
      response.conversationMetadata === undefined && response.steerMetadata === undefined
        ? null
        : JSON.stringify(response.conversationMetadata ?? response.steerMetadata),
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
