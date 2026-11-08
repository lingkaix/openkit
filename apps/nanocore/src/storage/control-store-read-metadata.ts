import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readRetainedV1 } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { ControlProductEntrySchema } from './control-store-product-records.js';
import { readImmutableProductJson } from './immutable-content.js';
import { StoredServerEventV1Schema } from './retained-server-work-v1.js';
import { StoredEventV1Schema } from './retained-work-events-v1.js';
import { StoredItemV1Schema } from './retained-work-items-v1.js';
import { StoredWorkOwnerV1Schema } from './retained-work-metadata-v1.js';

function readEvent(value: unknown) {
  return readRetainedV1(value, () =>
    value && typeof value === 'object' && 'workspaceId' in value
      ? StoredEventV1Schema.parse(value)
      : StoredServerEventV1Schema.parse(value)
  );
}

/** Derived seek facts only; every selected body still uses its original verified descriptor. */
export function prepareControlReadMetadata(kind: 'item' | 'event', value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'requiredFeatures' in value &&
    (!Array.isArray(value.requiredFeatures) || value.requiredFeatures.length > 0)
  )
    throw new TypeError('Unsupported retained product read features.');
  if (kind === 'event') {
    const event = readEvent(value);
    return JSON.stringify({ timestamp: event.timestamp });
  }
  const item = readRetainedV1(value, StoredItemV1Schema.parse);
  return JSON.stringify({
    status: item.status,
    createdAt: item.createdAt,
    completedAt: item.completedAt,
    requestId:
      'approvalRequestId' in item
        ? item.approvalRequestId
        : 'userInputRequestId' in item
          ? item.userInputRequestId
          : null,
  });
}

/** One-way verified carry inside the original native migration transaction, before its ledger row. */
export function backfillControlReadMetadata(sqlite: Database.Database): void {
  if (!sqlite.inTransaction)
    throw new TypeError('Product read carry requires its migration transaction.');
  const select = sqlite.prepare(`SELECT e.rowid AS rowId,e.kind,e.id,e.turn_id AS turnId,
    e.content_json AS contentJson,e.identity_json AS identityJson,e.sequence,e.schema_version AS schemaVersion,t.thread_id AS threadId,t.record_json AS turnJson
    FROM control_product_entries e LEFT JOIN control_turns t ON t.id=e.turn_id
    WHERE e.read_metadata_json IS NULL AND e.rowid>? ORDER BY e.rowid LIMIT 128`);
  type CarryRow = {
    rowId: number;
    kind: 'item' | 'event';
    id: string;
    turnId: string;
    contentJson: string;
    identityJson: string;
    sequence: number;
    schemaVersion: number;
    threadId: string;
    turnJson: string;
  };
  const update = sqlite.prepare(
    'UPDATE control_product_entries SET read_metadata_json=? WHERE rowid=?'
  );
  const mount = {
    root: join(dirname(dirname(sqlite.name)), 'evidence', 'backend'),
    mount: 'backend-evidence' as const,
    knowledgeBaseId: null,
  };
  let cursor = 0;
  while (true) {
    const rows = select.all(cursor) as CarryRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.rowId;
      if (row.schemaVersion !== 1) throw new TypeError('Unsupported product read carry marker.');
      const identity = JSON.parse(row.identityJson);
      const owner = StoredWorkOwnerV1Schema.parse(JSON.parse(row.turnJson).owner);
      const value = readImmutableProductJson(
        mount,
        owner,
        ControlProductEntrySchema.shape.content.parse(JSON.parse(row.contentJson))
      );
      if (row.kind === 'item') {
        const item = readRetainedV1(value, StoredItemV1Schema.parse);
        const expectedIdentity = {
          id: item.id,
          type: item.type,
          owner: item.owner,
          threadId: item.threadId,
          turnId: item.turnId,
          actor: 'actor' in item ? item.actor : null,
          responsibleUserId: 'responsibleUserId' in item ? item.responsibleUserId : null,
          causationId: item.causationId ?? null,
        };
        if (
          !Object.entries(expectedIdentity).every(([key, value]) =>
            isDeepStrictEqual(identity[key], value)
          )
        )
          throw new TypeError('Product read carry identity mismatch.');

        if (
          item.id !== row.id ||
          item.turnId !== row.turnId ||
          item.threadId !== row.threadId ||
          !isDeepStrictEqual(item.owner, owner)
        )
          throw new TypeError('Product read carry lineage mismatch.');
      } else {
        const event = readEvent(value);
        if (
          row.id !== `${row.turnId}:${row.sequence}` ||
          event.sequence !== row.sequence ||
          identity.threadId !== row.threadId ||
          identity.turnId !== row.turnId ||
          event.turnId !== row.turnId ||
          event.threadId !== row.threadId ||
          (owner.kind === 'workspace' &&
            (!('workspaceId' in event) || event.workspaceId !== owner.workspaceId)) ||
          (owner.kind === 'server' && (!('owner' in event) || event.owner.kind !== 'server'))
        )
          throw new TypeError('Product event read carry lineage mismatch.');
      }
      if (update.run(prepareControlReadMetadata(row.kind, value), row.rowId).changes !== 1)
        throw new TypeError('Product read carry lost its selected row.');
    }
  }
}
