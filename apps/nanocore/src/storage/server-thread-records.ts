import { isDeepStrictEqual } from 'node:util';
import type { Item, ServerTurnEventEnvelope, Thread, Turn } from '@openkit/protocol';
import type { z } from 'zod';
import {
  StoredThreadSnapshotV1Schema,
  StoredTurnPayloadV1Schema,
} from './retained-work-events-v1.js';
import { StoredTurnV1Schema } from './retained-work-metadata-v1.js';
import {
  assertImmutableItemAttribution,
  type CaptureCoverageBindingSchema,
  listNativeProducts,
  nativeProductMetadataScope,
  nativeProductScope,
  readNativeProduct,
  readNativeTurnEvents,
  readNativeTurnHistory,
} from './workspace-file-records.js';

/** Reads Server metadata from its actual Core SQLite authority without Item body disclosure. */
export function readServerTurnRecord(
  dataRoot: string,
  threadId: string,
  turnId: string
): z.infer<typeof StoredTurnPayloadV1Schema> {
  const snapshot = readNativeProduct(
    nativeProductMetadataScope(dataRoot, { kind: 'server' }),
    'turn',
    turnId
  );
  if (!snapshot || snapshot.record.threadId !== threadId)
    throw new Error(`Server Turn is unavailable: ${turnId}.`);
  return StoredTurnPayloadV1Schema.parse(StoredTurnV1Schema.parse(snapshot.record));
}

/** Complete Server history projected from native metadata and immutable Storage bodies. */
export interface ServerThreadRecords {
  threads: Thread[];
  turns: Turn[];
  itemRevisions: Item[];
  turnEvents: Map<string, ServerTurnEventEnvelope[]>;
  turnCaptureCoverage: Map<string, z.infer<typeof CaptureCoverageBindingSchema>>;
}

/** Loads native Server history without file fallback, repair, or execution replay. */
export function loadServerThreadRecords(dataRoot: string): ServerThreadRecords {
  const metadataScope = nativeProductMetadataScope(dataRoot, { kind: 'server' });
  const records: ServerThreadRecords = {
    threads: [],
    turns: [],
    itemRevisions: [],
    turnEvents: new Map(),
    turnCaptureCoverage: new Map(),
  };
  records.threads = listNativeProducts(metadataScope, 'thread').map((row) =>
    StoredThreadSnapshotV1Schema.parse(row.record)
  );
  const threads = new Set(records.threads.map((thread) => thread.id));
  const itemIds = new Set<string>();
  const active = new Set<string>();
  const turns = listNativeProducts(metadataScope, 'turn');
  if (turns.length === 0) return records;
  const scope = nativeProductScope(dataRoot, { kind: 'server' });
  for (const row of turns) {
    const history = readNativeTurnHistory(scope, row.record.id as string)!;
    const turn = history.turn;
    if (!threads.has(turn.threadId))
      throw new Error('Server Turn Thread lineage is recovery_required.');
    if (turn.status === 'pending' || turn.status === 'running') {
      if (active.has(turn.threadId))
        throw new Error('Server Thread single-flight is recovery_required.');
      active.add(turn.threadId);
    }
    for (const item of turn.items) {
      if (itemIds.has(item.id)) throw new Error('Server Item identity is recovery_required.');
      itemIds.add(item.id);
    }
    records.turns.push(turn);
    records.itemRevisions.push(...history.itemRevisions);
    if (history.captureCoverage) records.turnCaptureCoverage.set(turn.id, history.captureCoverage);
    records.turnEvents.set(turn.id, readServerTurnEvents(dataRoot, turn));
  }
  return records;
}

/** Reads every ordered Server event with exact content and owner proof. */
export function readServerTurnEvents(dataRoot: string, turn: Turn): ServerTurnEventEnvelope[] {
  const events = readNativeTurnEvents(
    nativeProductScope(dataRoot, { kind: 'server' }),
    turn
  ) as ServerTurnEventEnvelope[];
  for (const event of events) assertServerTurnEventLineage(event, turn);
  return events;
}

/** Refuses changes to immutable Item identity and attribution across Server revisions. */
export function assertServerItemRevision(previous: Item, next: Item): void {
  if (
    previous.id !== next.id ||
    previous.type !== next.type ||
    previous.createdAt !== next.createdAt ||
    !isDeepStrictEqual(previous.owner, next.owner) ||
    previous.threadId !== next.threadId ||
    previous.turnId !== next.turnId
  )
    throw new Error(`Server Item immutable identity cannot change: ${previous.id}.`);
  assertImmutableItemAttribution(previous, next);
}

/** Checks Server transcript lineage without granting authority from nested snapshots. */
export function assertServerTurnEventLineage(event: ServerTurnEventEnvelope, turn: Turn): void {
  if (
    event.owner.kind !== 'server' ||
    turn.owner.kind !== 'server' ||
    event.threadId !== turn.threadId ||
    event.turnId !== turn.id ||
    event.event !== event.data.type.replaceAll('-', '.')
  )
    throw new Error('Server event has invalid Turn lineage.');
  const data = event.data;
  const validTurn = (candidate: Turn) =>
    candidate.owner.kind === 'server' &&
    candidate.id === turn.id &&
    candidate.threadId === turn.threadId &&
    candidate.items.every(
      (item) =>
        item.owner.kind === 'server' && item.threadId === turn.threadId && item.turnId === turn.id
    );
  if (
    ('turnId' in data && data.turnId !== turn.id) ||
    ('thread' in data &&
      (data.thread.owner.kind !== 'server' || data.thread.id !== turn.threadId)) ||
    ('item' in data &&
      (data.item.owner.kind !== 'server' ||
        data.item.threadId !== turn.threadId ||
        data.item.turnId !== turn.id ||
        !turn.items.some((item) => item.id === data.item.id))) ||
    ('itemId' in data && !turn.items.some((item) => item.id === data.itemId)) ||
    ('turn' in data && !validTurn(data.turn))
  )
    throw new Error('Server event payload has invalid lineage.');
}
