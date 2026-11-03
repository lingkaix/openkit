import { responsibleUserIdForActor } from '@openkit/protocol';
import { NotebookError } from '../knowledge/notebook.js';
import { commandRequestKey, type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import {
  getCommandRequestRecordFromDb,
  normalizeCommandRequestResponse,
  recordControlCommandRequestRecordInDb,
} from './command-request-records.js';
import {
  type ControlMaintenanceAdmissionInput,
  ControlMaintenanceAdmissionInputSchema,
  type ControlMaintenanceAdmissionResult,
} from './control-store-maintenance-codecs.js';
import { decode as decodeControlProduct, readProduct } from './control-store-product-records.js';
import {
  applyControlProducts,
  assertControlProductWriter,
  type ControlProductMutation,
} from './control-store-products.js';
import type { CoreDb, WorkspaceDb } from './db.js';

type Turn = ReturnType<FsStore['getTurnById']>;

// Keep the synchronous native tuple independent of the model, editor and provider orchestration graph.
/**
 * Selects and admits complete Knowledge work against current native scope state in the caller's savepoint.
 *
 * Workspace/User maintenance serializes on its existing notebook Thread. Queries always create a fresh Thread. User Memory receipts remain in User SQLite and cannot join this Workspace transaction. No file effects, callback or commit occurs here. User-home admission reads its Core binding through the existing read-only view; it writes only this scope.
 */
export function applyControlMaintenanceAdmission(
  db: CoreDb | WorkspaceDb,
  value: ControlMaintenanceAdmissionInput
): ControlMaintenanceAdmissionResult {
  assertControlProductWriter(db.sqlite);
  const input = ControlMaintenanceAdmissionInputSchema.parse(value);
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
