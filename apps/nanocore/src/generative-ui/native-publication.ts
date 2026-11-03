import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { deriveEntityId, type Item, ItemSchema, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { prepareAuditEvent, prepareAuditEventStatement } from '../audit-events.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { commandRequestKey } from '../lib/store.js';
import { IdempotencyKeyConflictError } from '../operation-error.js';
import {
  getCommandRequestRecordFromDb,
  recordControlCommandRequestRecordInDb,
} from '../storage/command-request-records.js';
import {
  type ControlProductContentMount,
  ControlProductPreconditionError,
  readProduct,
} from '../storage/control-store-product-records.js';
import {
  applyControlProducts,
  assertControlProductWriter,
  type ControlContentPreparation,
  prepareControlEntries,
  prepareControlItemAppend,
} from '../storage/control-store-products.js';
import type { WorkspaceDb } from '../storage/db.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { prepareRetainedProductJson } from '../storage/immutable-content.js';
import {
  ControlGenerativePresentationSchema,
  type ControlGenerativePresentationWire,
} from './native-publication-codecs.js';

/** Prepares only the admitted presentation tuple; files are durable before its existing native savepoint. */
export async function prepareControlGenerativePresentation(
  db: WorkspaceDb,
  envelope: ControlGenerativePresentationWire,
  content: ArrayBuffer | undefined,
  mount: ControlProductContentMount | undefined,
  directories: ControlContentPreparation
) {
  if (
    !mount ||
    !content ||
    content.byteLength !== envelope.byteLength ||
    envelope.workspaceId !== db.workspaceId
  )
    throw new ControlProductPreconditionError();
  const input = ControlGenerativePresentationSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
  );
  const { presentation: p, receipt, answer, sourceItem } = input;
  if (
    p.workspaceId !== db.workspaceId ||
    p.turnId !== envelope.turnId ||
    p.requestId !== receipt.requestId ||
    p.actor.id !== receipt.scope.actorId ||
    receipt.scope.workspaceId !== db.workspaceId ||
    receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
    receipt.expiresAt <= receipt.createdAt ||
    p.originRequestId !== null
  )
    throw new ControlProductPreconditionError();
  const original = getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt);
  if (original) {
    if (
      original.inputHash !== receipt.inputHash ||
      original.command !== receipt.command ||
      !isDeepStrictEqual(original.scope, receipt.scope) ||
      original.response.kind !== 'generative_presentation'
    )
      throw new IdempotencyKeyConflictError();
    return { input, original, entries: [] };
  }
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  const head = readProduct(db.sqlite, owner, 'turn', p.turnId);
  const thread = readProduct(db.sqlite, owner, 'thread', p.threadId);
  const workspace = readProduct(db.sqlite, owner, 'workspace', db.workspaceId);
  if (
    !head ||
    head.record.threadId !== p.threadId ||
    !['pending', 'running'].includes(String(head.record.status)) ||
    !thread ||
    thread.record.status === 'archived' ||
    workspace?.record.status !== 'active'
  )
    throw new ControlProductPreconditionError();
  const messages = JSON.stringify(p.messages);
  if (`sha256:${sha256Hex(messages)}` !== p.contentDigest)
    throw new ControlProductPreconditionError();
  if (
    db.sqlite
      .prepare('SELECT 1 FROM generative_presentations WHERE workspace_id=? AND request_id=?')
      .get(db.workspaceId, receipt.requestId)
  )
    throw new KernelCommandError(
      'recovery_required',
      'Interrupted presentation publication requires recovery.'
    );
  let sourceRevision: number | undefined;
  if (p.source.kind === 'item') {
    const source = answer ?? sourceItem;
    const text =
      source?.type === 'assistant-message'
        ? source.text
        : source?.type === 'tool-call'
          ? source.result
          : null;
    if (
      !source ||
      source.id !== p.source.itemId ||
      source.owner.kind !== 'workspace' ||
      source.owner.workspaceId !== db.workspaceId ||
      source.status !== 'completed' ||
      text === null ||
      text === undefined ||
      `sha256:${sha256Hex(text)}` !== p.source.contentDigest
    )
      throw new ControlProductPreconditionError();
    if (
      answer &&
      (answer.type !== 'assistant-message' ||
        answer.turnId !== p.turnId ||
        answer.threadId !== p.threadId ||
        answer.causationId !== receipt.requestId ||
        answer.id !==
          deriveEntityId('it', [
            'generative-ui.publish',
            db.workspaceId,
            receipt.scope.actorId,
            receipt.requestId,
            'answer-source',
          ]) ||
        sourceItem !== null)
    )
      throw new ControlProductPreconditionError();
    if (!answer) {
      const verified = await prepareControlItemAppend(db, { item: source }, mount);
      if (!verified.previous || !isDeepStrictEqual(ItemSchema.parse(verified.previous), source))
        throw new ControlProductPreconditionError();
      sourceRevision = verified.revision;
    }
  } else if (answer !== null || sourceItem !== null) throw new ControlProductPreconditionError();
  const item: Item = {
    id: p.itemId,
    owner,
    threadId: p.threadId,
    turnId: p.turnId,
    type: 'generative-ui-reference',
    status: 'completed',
    presentationId: p.id,
    title: p.title,
    fallbackText: p.fallbackText,
    createdAt: p.createdAt,
    completedAt: p.createdAt,
    causationId: p.requestId,
  };
  const entries = [];
  for (const [offset, body] of (answer ? [answer, item] : [item]).entries()) {
    const plan = await prepareControlItemAppend(db, { item: body }, mount);
    if (plan.revision !== 0 || plan.replay)
      throw new KernelCommandError(
        'recovery_required',
        'Interrupted answer publication requires recovery.'
      );
    const bytes = await prepareRetainedProductJson(
      mount,
      owner,
      join(dirname(dirname(workspaceDbPath(db.dataRoot, db.workspaceId))), 'runtime', 'staging'),
      writeRetainedV1(body)
    );
    entries.push({
      kind: 'item' as const,
      turnId: p.turnId,
      sequence: plan.sequence + offset,
      expectedRevision: plan.revision,
      ...bytes,
    });
  }
  return {
    input,
    original: null,
    head,
    sourceRevision,
    entries: await prepareControlEntries(owner, mount, entries, directories),
  };
}
/** Exact independently durable preparation, retained only by its existing FIFO slot. */
export type PreparedControlGenerativePresentation = Awaited<
  ReturnType<typeof prepareControlGenerativePresentation>
>;

/** Commits the presentation, both Items, Audit and original receipt in the worker's covering FULL transaction. */
export function applyControlGenerativePresentation(
  db: WorkspaceDb,
  prepared: PreparedControlGenerativePresentation
): string {
  assertControlProductWriter(db.sqlite);
  const {
    input: { presentation: p, receipt },
    original,
    head,
    entries,
  } = prepared;
  if (original) return original.response.id;
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  if (!head || readProduct(db.sqlite, owner, 'turn', p.turnId)?.revision !== head.revision)
    throw new ControlProductPreconditionError();
  if (prepared.sourceRevision !== undefined && p.source.kind === 'item') {
    const row = db.sqlite
      .prepare(
        "SELECT revision FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(p.source.itemId) as { revision: number } | undefined;
    if (row?.revision !== prepared.sourceRevision) throw new ControlProductPreconditionError();
  }
  db.sqlite
    .prepare(`INSERT INTO generative_presentations (
    schema_version,presentation_id,workspace_id,thread_id,turn_id,item_id,created_at,actor_json,
    request_id,origin_request_id,semantic_input_hash,title,fallback_text,protocol_version,catalog_id,
    messages_json,content_digest,source_json,actions_json,observed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      1,
      p.id,
      p.workspaceId,
      p.threadId,
      p.turnId,
      p.itemId,
      p.createdAt,
      JSON.stringify(p.actor),
      p.requestId,
      p.originRequestId,
      p.semanticInputHash,
      p.title,
      p.fallbackText,
      p.protocolVersion,
      p.catalogId,
      JSON.stringify(p.messages),
      p.contentDigest,
      JSON.stringify(p.source),
      JSON.stringify(p.actions),
      p.observedAt
    );
  applyControlProducts(
    db.sqlite,
    owner,
    [{ kind: 'turn', expectedRevision: head.revision, record: head.record }],
    entries
  );
  const audit = prepareAuditEvent({
    workspaceId: db.workspaceId,
    threadId: p.threadId,
    turnId: p.turnId,
    itemId: p.itemId,
    actor: p.actor,
    requestId: receipt.requestId,
    category: 'system',
    action: 'generative-ui.publish',
    resource: `generative-presentation:${p.id}`,
    outcome: 'succeeded',
    summary: 'generative-ui.publish',
    now: new Date(p.createdAt),
  });
  const statement = prepareAuditEventStatement(audit);
  db.sqlite.prepare(statement.sql).run(...statement.parameters);
  recordControlCommandRequestRecordInDb(db, {
    ...receipt,
    response: { kind: receipt.responseKind, id: p.id },
  });
  return p.id;
}
