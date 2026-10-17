import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseRecordEnvelope } from '@openkit/config-schema';
import {
  GitFailureExplanationReaderSchema,
  type ServerItem,
  ServerItemSchema,
  type ServerThread,
  ServerThreadSchema,
  type ServerTurn,
  type ServerTurnEventEnvelope,
  ServerTurnEventEnvelopeSchema,
  ServerTurnSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  ActorRefReaderSchema,
  appendCanonicalTextFile,
  assertCanonicalDirectory,
  assertImmutableItemAttribution,
  CaptureCoverageBindingSchema,
  ensureCanonicalDirectory,
  listDirectoryNames,
  preserveDescriptiveRecord,
  publishNewRecordDirectory,
  readCanonicalJsonLines,
  readCanonicalTextFile,
  writeFileAtomic,
  writeOwnedDescriptiveJson,
} from './workspace-file-records.js';

const SERVER_THREAD_FEATURE = 'openkit.server-threads.v1';

/** Retained actor additions are descriptive; actor kind and attribution remain closed. */
const ServerItemReaderSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || !('actor' in value)) return value;
  return { ...value, actor: ActorRefReaderSchema.parse(value.actor) };
}, ServerItemSchema);

/** Canonical Server Turn metadata including the existing immutable capture declaration. */
export const ServerTurnReaderSchema = ServerTurnSchema.safeExtend({
  triggerActor: ActorRefReaderSchema,
  error: ServerTurnSchema.shape.error
    .unwrap()
    .extend({ explanation: GitFailureExplanationReaderSchema.optional() })
    .nullable(),
  captureCoverage: CaptureCoverageBindingSchema.optional(),
  requiredFeatures: z.array(z.literal('openkit.work-observations.v1')).optional(),
});

/** Normalizes retained Item attribution before the exact Server Turn snapshot validator. */
const ServerTurnSnapshotReaderSchema = z.preprocess((value) => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('items' in value) ||
    !Array.isArray(value.items)
  )
    return value;
  return { ...value, items: value.items.map((item) => ServerItemReaderSchema.parse(item)) };
}, ServerTurnReaderSchema);

/** Reads canonical Server Turn metadata for current capture and recovery owners. */
export function readServerTurnRecord(
  dataRoot: string,
  threadId: string,
  turnId: string
): z.infer<typeof ServerTurnReaderSchema> {
  ThreadIdSchema.parse(threadId);
  TurnIdSchema.parse(turnId);
  const value: unknown = JSON.parse(
    readCanonicalTextFile(
      join(dataRoot, 'server', 'threads', threadId, 'turns', turnId, 'turn.json')
    )
  );
  const turn = ServerTurnReaderSchema.parse(value);
  if (turn.id !== turnId || turn.threadId !== threadId || turn.items.length)
    throw new Error(`Server Turn has invalid lineage: ${turnId}.`);
  return turn;
}

/** Canonical Server history loaded into the existing FsStore; no separate storage authority. */
export interface ServerThreadRecords {
  threads: ServerThread[];
  turns: ServerTurn[];
  itemRevisions: ServerItem[];
  turnEvents: Map<string, ServerTurnEventEnvelope[]>;
  turnCaptureCoverage: Map<string, z.infer<typeof CaptureCoverageBindingSchema>>;
}

/** Hashes the known Thread core; descriptive additions retain their existing bytes. */
function threadDigest(thread: ServerThread): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(thread)).digest('hex')}`;
}

/** Reads and verifies one Server Thread envelope before admitting its owner. */
function readThread(path: string): ServerThread {
  const raw: unknown = JSON.parse(readCanonicalTextFile(path));
  const envelope = parseRecordEnvelope(raw, { supportedFeatures: [SERVER_THREAD_FEATURE] });
  const thread = ServerThreadSchema.parse(raw);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.recordType !== 'thread' ||
    envelope.ownerScope !== 'server' ||
    envelope.id !== thread.id ||
    envelope.lineage.threadId !== thread.id ||
    envelope.lineage.workspaceId !== undefined ||
    !envelope.requiredFeatures.includes(SERVER_THREAD_FEATURE) ||
    envelope.contentDigest !== threadDigest(thread)
  )
    throw new Error(`Server Thread envelope is recovery_required: ${thread.id}.`);
  return thread;
}

/** Loads canonical Server history without changing retained records or replaying execution. */
export function loadServerThreadRecords(dataRoot: string): ServerThreadRecords {
  const records: ServerThreadRecords = {
    threads: [],
    turns: [],
    itemRevisions: [],
    turnEvents: new Map(),
    turnCaptureCoverage: new Map(),
  };
  const threadsRoot = join(dataRoot, 'server', 'threads');
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const threadId of listDirectoryNames(threadsRoot)) {
    const root = join(threadsRoot, threadId);
    const thread = readThread(join(root, 'thread.json'));
    if (thread.id !== threadId) throw new Error(`Server Thread has invalid lineage: ${threadId}.`);
    records.threads.push(thread);
    let activeTurns = 0;
    for (const turnId of listDirectoryNames(join(root, 'turns'))) {
      const turnRoot = join(root, 'turns', turnId);
      const turn = readServerTurnRecord(dataRoot, threadId, turnId);
      if (turn.captureCoverage) records.turnCaptureCoverage.set(turn.id, turn.captureCoverage);
      if (
        turn.id !== turnId ||
        turn.threadId !== threadId ||
        turnIds.has(turnId) ||
        turn.items.length
      )
        throw new Error(`Server Turn has invalid lineage: ${turnId}.`);
      turnIds.add(turnId);
      if (turn.status === 'pending' || turn.status === 'running') activeTurns++;
      const items = new Map<string, ServerItem>();
      for (const value of readCanonicalJsonLines(join(turnRoot, 'items.jsonl'))) {
        const item = ServerItemReaderSchema.parse(value);
        if (item.turnId !== turn.id || item.threadId !== thread.id)
          throw new Error(`Server Item has invalid lineage: ${item.id}.`);
        const previous = items.get(item.id);
        if (previous) assertServerItemRevision(previous, item);
        else if (itemIds.has(item.id)) throw new Error(`Duplicate Server Item: ${item.id}.`);
        itemIds.add(item.id);
        items.set(item.id, item);
        records.itemRevisions.push(item);
      }
      const completeTurn = ServerTurnReaderSchema.parse({ ...turn, items: [...items.values()] });
      records.turns.push(ServerTurnSchema.parse(completeTurn));
      const events = readServerTurnEvents(dataRoot, completeTurn);
      records.turnEvents.set(turn.id, events);
    }
    if (activeTurns > 1)
      throw new Error(`Server Thread has multiple Turns in flight: ${thread.id}.`);
  }
  return records;
}

/** Reads a complete retained Server transcript for an already admitted Turn. */
export function readServerTurnEvents(
  dataRoot: string,
  turn: ServerTurn
): ServerTurnEventEnvelope[] {
  ThreadIdSchema.parse(turn.threadId);
  TurnIdSchema.parse(turn.id);
  return readCanonicalJsonLines(
    join(dataRoot, 'server', 'threads', turn.threadId, 'turns', turn.id, 'runtime', 'events.jsonl')
  ).map((value, index) => {
    const raw = value as { data?: Record<string, unknown> };
    const data = raw?.data;
    const normalized =
      data && 'item' in data
        ? { ...data, item: ServerItemReaderSchema.parse(data.item) }
        : data && 'turn' in data
          ? { ...data, turn: ServerTurnSnapshotReaderSchema.parse(data.turn) }
          : data;
    const event = ServerTurnEventEnvelopeSchema.parse({ ...(value as object), data: normalized });
    assertServerTurnEventLineage(event, turn);
    if (event.sequence !== index + 1)
      throw new Error(`Server Turn event sequence is recovery_required: ${turn.id}.`);
    return event;
  });
}

/** Writes Server Thread metadata through the shared durable directory and atomic-file publisher. */
export function writeServerThreadRecord(dataRoot: string, thread: ServerThread): void {
  const ownerRoot = join(dataRoot, 'server');
  const root = join(ownerRoot, 'threads', thread.id);
  ensureCanonicalDirectory(join(ownerRoot, 'threads'));
  const write = (directory: string) => {
    const path = join(directory, 'thread.json');
    const previous = existsSync(path) ? JSON.parse(readCanonicalTextFile(path)) : {};
    const old = existsSync(path) ? readThread(path) : undefined;
    if (old) {
      if (
        old.id !== thread.id ||
        old.entryPath !== thread.entryPath ||
        old.threadSource !== thread.threadSource ||
        old.parentThreadId !== thread.parentThreadId ||
        old.createdAt !== thread.createdAt
      )
        throw new Error(`Server Thread immutable identity cannot change: ${thread.id}.`);
    }
    writeFileAtomic(
      path,
      `${JSON.stringify(
        {
          ...(preserveDescriptiveRecord(previous, old, thread) as Record<string, unknown>),
          schemaVersion: 1,
          recordType: 'thread',
          ownerScope: 'server',
          lineage: { threadId: thread.id },
          contentDigest: threadDigest(thread),
          redactionLevel: 'none',
          sensitivity: 'server',
          requiredFeatures: [SERVER_THREAD_FEATURE],
          extensions: previous.extensions ?? {},
        },
        null,
        2
      )}\n`
    );
    ensureCanonicalDirectory(join(directory, 'turns'));
  };
  if (existsSync(root)) {
    assertCanonicalDirectory(root);
    write(root);
  } else publishNewRecordDirectory(join(ownerRoot, 'threads'), root, write);
}

/** Writes Turn metadata without replacing append-only Item or transcript history. */
export function writeServerTurnRecord(
  dataRoot: string,
  turn: z.infer<typeof ServerTurnReaderSchema>
): void {
  const ownerRoot = join(dataRoot, 'server');
  const turnsRoot = join(ownerRoot, 'threads', turn.threadId, 'turns');
  assertCanonicalDirectory(turnsRoot);
  const root = join(turnsRoot, turn.id);
  const write = (directory: string) => {
    const path = join(directory, 'turn.json');
    const previous = existsSync(path)
      ? ServerTurnReaderSchema.parse(JSON.parse(readCanonicalTextFile(path)))
      : undefined;
    if (
      previous?.captureCoverage &&
      turn.captureCoverage &&
      !isDeepStrictEqual(previous.captureCoverage, turn.captureCoverage)
    )
      throw new Error(`Server Turn capture coverage is recovery_required: ${turn.id}.`);
    writeOwnedDescriptiveJson(
      path,
      {
        ...turn,
        items: [],
        ...(previous?.captureCoverage ? { captureCoverage: previous.captureCoverage } : {}),
        ...(previous?.requiredFeatures ? { requiredFeatures: previous.requiredFeatures } : {}),
      },
      ServerTurnReaderSchema
    );

    if (!existsSync(join(directory, 'items.jsonl')))
      writeFileAtomic(join(directory, 'items.jsonl'), '');
    ensureCanonicalDirectory(join(directory, 'runtime'));
  };
  if (existsSync(root)) {
    assertCanonicalDirectory(root);
    write(root);
  } else publishNewRecordDirectory(join(ownerRoot, 'threads'), root, write);
}

/** Rejects an Item revision that changes immutable identity, lineage or human attribution. */
export function assertServerItemRevision(previous: ServerItem, next: ServerItem): void {
  if (
    previous.id !== next.id ||
    previous.threadId !== next.threadId ||
    previous.turnId !== next.turnId ||
    previous.type !== next.type ||
    previous.createdAt !== next.createdAt ||
    !isDeepStrictEqual(previous.owner, next.owner)
  )
    throw new Error(`Server Item immutable identity cannot change: ${next.id}.`);
  assertImmutableItemAttribution(previous, next);
}

/** Appends a validated Server record through the existing fsync and disk-admission boundary. */
export function appendServerThreadRecord(
  dataRoot: string,
  record: ServerItem | ServerTurnEventEnvelope
): void {
  const turnRoot = join(dataRoot, 'server', 'threads', record.threadId, 'turns', record.turnId);
  const parts = [
    join(dataRoot, 'server'),
    join(dataRoot, 'server', 'threads'),
    join(dataRoot, 'server', 'threads', record.threadId),
    join(dataRoot, 'server', 'threads', record.threadId, 'turns'),
    turnRoot,
  ];
  for (const path of parts) assertCanonicalDirectory(path);
  if ('event' in record) assertCanonicalDirectory(join(turnRoot, 'runtime'));
  const path =
    'event' in record ? join(turnRoot, 'runtime', 'events.jsonl') : join(turnRoot, 'items.jsonl');
  appendCanonicalTextFile(path, `${JSON.stringify(record)}\n`);
}

/** Enforces the same containing Turn lineage on Server transcript payloads and their envelope. */
export function assertServerTurnEventLineage(
  event: ServerTurnEventEnvelope,
  turn: ServerTurn
): void {
  if (
    event.turnId !== turn.id ||
    event.threadId !== turn.threadId ||
    event.event !== event.data.type.replaceAll('-', '.')
  )
    throw new Error(`Server Turn event has invalid lineage: ${turn.id}.`);
  const data = event.data;
  if (
    ('turnId' in data && data.turnId !== turn.id) ||
    ('turn' in data && (data.turn.id !== turn.id || data.turn.threadId !== turn.threadId)) ||
    ('thread' in data && data.thread.id !== turn.threadId) ||
    ('item' in data &&
      (data.item.turnId !== turn.id ||
        data.item.threadId !== turn.threadId ||
        !turn.items.some((item) => item.id === data.item.id))) ||
    ('itemId' in data && !turn.items.some((item) => item.id === data.itemId))
  )
    throw new Error(`Server Turn event payload has invalid lineage: ${turn.id}.`);
}
