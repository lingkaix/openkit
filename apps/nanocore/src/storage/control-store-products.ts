import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import { ContentReferenceSchema, KnowledgeBaseIdSchema, readRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { StoredServerEventV1Schema } from './retained-server-work-v1.js';
import { StoredEventV1Schema, StoredThreadSnapshotV1Schema } from './retained-work-events-v1.js';
import { StoredItemV1Schema } from './retained-work-items-v1.js';
import {
  StoredAgentSessionV1Schema,
  StoredTurnV1Schema,
  StoredWorkOwnerV1Schema,
  StoredWorkspaceV1Schema,
} from './retained-work-metadata-v1.js';
import { assertServerTurnEventLineage } from './server-thread-records.js';
import {
  assertTurnEventPayloadLineage,
  preserveDescriptiveRecord,
} from './workspace-file-records.js';

/** Current finite metadata/page defaults; payloads use synchronized immutable Storage objects. */
export const CONTROL_PRODUCT_LIMITS = {
  metadataBytes: 64 * 1024,
  entries: 32,
  pageRows: 128,
  payloadBytes: 1024 * 1024,
} as const;

/** Admitted transient Storage binding; reference parsing cannot select another Knowledge Base or mount. */
export const ControlProductContentMountSchema = z
  .object({
    root: z.string().min(1),
    knowledgeBaseId: KnowledgeBaseIdSchema,
    mount: z.string().min(1),
  })
  .strict();
export type ControlProductContentMount = z.infer<typeof ControlProductContentMountSchema>;

/** Physical product kinds project existing retained families; they are not new product concepts. */
export const ControlProductKindSchema = z.enum(['workspace', 'thread', 'agent-session', 'turn']);
export type ControlProductKind = z.infer<typeof ControlProductKindSchema>;
/** Existing immutable product owner, independent of execution placement. */
export type ControlProductOwner = z.infer<typeof StoredWorkOwnerV1Schema>;
/** Conditional replacement of bounded metadata; zero means create, never overwrite. */
export const ControlProductMutationSchema = z
  .object({
    kind: ControlProductKindSchema,
    expectedRevision: z.number().int().nonnegative(),
    record: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ControlProductMutation = z.infer<typeof ControlProductMutationSchema>;
/** Exact immutable content descriptor prepared before its SQL reference can commit. */
export const ControlProductEntrySchema = z
  .object({
    kind: z.enum(['item', 'event']),
    turnId: z.string().min(1),
    sequence: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    content: z
      .object({
        reference: ContentReferenceSchema,
        byteLength: z.number().int().nonnegative(),
        mediaType: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ControlProductEntry = z.infer<typeof ControlProductEntrySchema>;
/** Existing non-command lifecycle writes share the native product owner, without inventing a command receipt. */
export const ControlProductTransitionSchema = z
  .object({
    products: z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries),
    entries: z.array(ControlProductEntrySchema).max(CONTROL_PRODUCT_LIMITS.entries),
  })
  .strict()
  .refine((value) => value.products.length + value.entries.length > 0);
/** Whole bounded product transition; terminal candidates still require the complete native terminal path. */
export type ControlProductTransition = z.infer<typeof ControlProductTransitionSchema>;
/** Native prepared bytes never cross an awaited callback or require file I/O inside SQL. */
export interface PreparedControlEntry {
  readonly input: ControlProductEntry;
  readonly id: string;
  readonly identityJson: string;
  /** Bounded event dependencies checked against the completed native graph, without retaining payloads or file I/O in SQL. */
  readonly referencedItemIds?: readonly string[];
}
/** A rejected tuple, including stale revision or missing native dependency; no caller-supplied diagnostics escape. */
export class ControlProductPreconditionError extends Error {
  constructor() {
    super('Control product transition precondition failed.');
  }
}

const tables = {
  workspace: 'control_workspaces',
  thread: 'control_threads',
  'agent-session': 'control_agent_sessions',
  turn: 'control_turns',
} as const;
const schemas = {
  workspace: StoredWorkspaceV1Schema,
  thread: StoredThreadSnapshotV1Schema,
  'agent-session': StoredAgentSessionV1Schema,
  turn: StoredTurnV1Schema,
} as const;
type MetadataRow = {
  id: string;
  schema_version: number;
  revision: number;
  record_json: string;
  workspace_id?: string | null;
  thread_id?: string | null;
  agent_session_id?: string | null;
  status?: string;
};

/** Refuses direct main-thread use of native product writers without disabling unrelated legacy writable handles. */
export function assertControlProductWriter(sqlite: Database.Database): void {
  if (isMainThread || !sqlite.inTransaction || sqlite.readonly)
    throw new ControlProductPreconditionError();
}

/** Checks exact scope relationships without turning a path or native executor into product authority. */
export function assertControlProductOwner(owner: ControlProductOwner, actual: unknown): void {
  if (!isDeepStrictEqual(owner, StoredWorkOwnerV1Schema.parse(actual)))
    throw new ControlProductPreconditionError();
}

/** Decodes the frozen family's known view while callers retain the original JSON bytes unchanged. */
export function decode(
  kind: ControlProductKind,
  value: unknown,
  owner: ControlProductOwner
): Record<string, unknown> {
  const record = readRetainedV1(value, () => schemas[kind].parse(value)) as Record<string, unknown>;
  const raw = value as Record<string, unknown>;
  if (
    raw.requiredFeatures !== undefined &&
    kind !== 'turn' &&
    (!Array.isArray(raw.requiredFeatures) || raw.requiredFeatures.length > 0)
  )
    throw new ControlProductPreconditionError();
  if (kind === 'thread' || kind === 'turn') assertControlProductOwner(owner, record.owner);
  else if (
    owner.kind !== 'workspace' ||
    (kind === 'workspace' ? record.id : record.workspaceId) !== owner.workspaceId
  )
    throw new ControlProductPreconditionError();
  if (Buffer.byteLength(JSON.stringify(value)) > CONTROL_PRODUCT_LIMITS.metadataBytes)
    throw new ControlProductPreconditionError();
  return record;
}

/** Returns only native SQL metadata and its revision, never a file-backed fallback or cache. */
export function readProduct(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  kind: ControlProductKind,
  id: string
) {
  const row = sqlite.prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`).get(id) as
    | MetadataRow
    | undefined;
  return row === undefined ? undefined : decodeRow(kind, row, owner);
}

/** Rejects disagreements between indexed SQL authority and its retained metadata view. */
function decodeRow(kind: ControlProductKind, row: MetadataRow, owner: ControlProductOwner) {
  if (row.schema_version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1)
    throw new ControlProductPreconditionError();
  const record = decode(kind, JSON.parse(row.record_json), owner);
  if (
    record.id !== row.id ||
    (kind !== 'workspace' && row.status !== record.status) ||
    (kind === 'thread' &&
      row.workspace_id !== (owner.kind === 'workspace' ? owner.workspaceId : null)) ||
    (kind === 'agent-session' &&
      (row.workspace_id !== record.workspaceId || row.thread_id !== record.threadId)) ||
    (kind === 'turn' &&
      (row.thread_id !== record.threadId ||
        row.agent_session_id !== (record.agentSessionId ?? null)))
  )
    throw new ControlProductPreconditionError();
  return { revision: row.revision, record };
}

/** Preserves immutable identity and refuses terminal work whose complete native tuple is not prepared in B1. */
function checkReplacement(
  kind: ControlProductKind,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>
): void {
  if (kind === 'turn' && after.status !== 'pending' && after.status !== 'running')
    throw new ControlProductPreconditionError();
  if (!before) return;
  if (
    kind === 'agent-session' &&
    (before.status === 'closed' || before.status === 'failed') &&
    after.status !== before.status
  )
    throw new ControlProductPreconditionError();
  const fixed =
    kind === 'workspace'
      ? ['id', 'createdAt']
      : kind === 'thread'
        ? [
            'id',
            'owner',
            'createdAt',
            'entryPath',
            'visibility',
            'privateOwnerUserId',
            'parentThreadId',
            'threadSource',
          ]
        : kind === 'turn'
          ? ['id', 'owner', 'threadId', 'triggerActor']
          : ['id', 'workspaceId', 'agentId', 'createdAt'];
  if (fixed.some((key) => !isDeepStrictEqual(before[key], after[key])))
    throw new ControlProductPreconditionError();
  if (
    (kind === 'turn' || kind === 'agent-session') &&
    before.threadId !== null &&
    before.threadId !== undefined &&
    before.threadId !== after.threadId
  )
    throw new ControlProductPreconditionError();
  if (
    kind === 'turn' &&
    before.agentSessionId != null &&
    before.agentSessionId !== after.agentSessionId
  )
    throw new ControlProductPreconditionError();
  if (
    kind === 'agent-session' &&
    before.retainedStorage != null &&
    !isDeepStrictEqual(before.retainedStorage, after.retainedStorage)
  )
    throw new ControlProductPreconditionError();
}

/** Applies metadata in foreign-key order inside the worker's existing savepoint, without committing or publishing. */
export function applyControlProducts(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  mutations: readonly ControlProductMutation[],
  entries: readonly PreparedControlEntry[]
): void {
  assertControlProductWriter(sqlite);
  const seen = new Set<string>();
  for (const kind of ['workspace', 'thread', 'agent-session', 'turn'] as const) {
    for (const input of mutations.filter((value) => value.kind === kind)) {
      const record = decode(kind, input.record, owner);
      const id = record.id as string;
      const key = `${kind}:${id}`;
      if (seen.has(key)) throw new ControlProductPreconditionError();
      seen.add(key);
      const previous = readProduct(sqlite, owner, kind, id);
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw new ControlProductPreconditionError();
      if (
        kind === 'thread' &&
        !previous &&
        owner.kind === 'workspace' &&
        record.visibility === 'private' &&
        record.entryPath === 'conversation' &&
        sqlite
          .prepare(
            "SELECT 1 FROM control_threads WHERE json_extract(record_json,'$.visibility')='private' AND json_extract(record_json,'$.entryPath')='conversation' AND json_extract(record_json,'$.privateOwnerUserId')=? LIMIT 1"
          )
          .get(record.privateOwnerUserId as string)
      )
        throw new ControlProductPreconditionError();
      checkReplacement(kind, previous?.record, record);
      const retained = previous
        ? (sqlite.prepare(`SELECT record_json FROM ${tables[kind]} WHERE id=?`).get(id) as {
            record_json: string;
          })
        : undefined;
      // Preserve the same descriptive extensions as the retired file owner, inside the deciding native transaction.
      const replacement = preserveDescriptiveRecord(
        retained ? JSON.parse(retained.record_json) : undefined,
        previous?.record,
        input.record
      );
      decode(kind, replacement, owner);
      const columns: Record<string, string | number | null> = {
        id,
        schema_version: 1,
        revision: input.expectedRevision + 1,
        record_json: JSON.stringify(replacement),
      };
      if (kind === 'thread') {
        columns.workspace_id = owner.kind === 'workspace' ? owner.workspaceId : null;
        columns.status = record.status as string;
      }
      if (kind === 'agent-session') {
        columns.workspace_id = record.workspaceId as string;
        columns.thread_id = record.threadId as string | null;
        columns.status = record.status as string;
      }
      if (kind === 'turn') {
        columns.thread_id = record.threadId as string;
        columns.agent_session_id = (record.agentSessionId as string | null) ?? null;
        columns.status = record.status as string;
      }
      if (previous) {
        const names = Object.keys(columns).filter((name) => name !== 'id');
        const result = sqlite
          .prepare(
            `UPDATE ${tables[kind]} SET ${names.map((name) => `${name}=?`).join(',')} WHERE id=? AND revision=?`
          )
          .run(...names.map((name) => columns[name]!), id, input.expectedRevision);
        if (result.changes !== 1) throw new ControlProductPreconditionError();
      } else {
        const names = Object.keys(columns);
        sqlite
          .prepare(
            `INSERT INTO ${tables[kind]} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`
          )
          .run(...Object.values(columns));
      }
    }
  }
  // Validate the completed graph after all metadata replacements, not a stale pre-queue main read.
  for (const input of mutations) {
    const record = decode(input.kind, input.record, owner);
    if (input.kind === 'turn') {
      const thread = readProduct(sqlite, owner, 'thread', record.threadId as string);
      if (thread?.record.status !== 'active') throw new ControlProductPreconditionError();
      if (record.agentSessionId != null) {
        const session = readProduct(
          sqlite,
          owner,
          'agent-session',
          record.agentSessionId as string
        );
        if (
          !session ||
          session.record.threadId !== record.threadId ||
          session.record.status === 'closed' ||
          session.record.status === 'failed'
        )
          throw new ControlProductPreconditionError();
      }
    }
    if (
      input.kind === 'thread' &&
      record.status === 'archived' &&
      sqlite
        .prepare(
          "SELECT 1 FROM control_turns WHERE thread_id=? AND status IN ('pending','running')"
        )
        .get(record.id)
    )
      throw new ControlProductPreconditionError();
    if (
      input.kind === 'agent-session' &&
      (record.status === 'closed' || record.status === 'failed') &&
      sqlite
        .prepare(
          "SELECT 1 FROM control_turns WHERE agent_session_id=? AND status IN ('pending','running')"
        )
        .get(record.id)
    )
      throw new ControlProductPreconditionError();
  }
  for (const entry of entries) {
    const input = entry.input;
    const turn = readProduct(sqlite, owner, 'turn', input.turnId);
    if (!turn || JSON.parse(entry.identityJson).threadId !== turn.record.threadId)
      throw new ControlProductPreconditionError();
    const last = sqlite
      .prepare(
        'SELECT max(sequence) AS sequence FROM control_product_entries WHERE kind=? AND turn_id=?'
      )
      .get(input.kind, input.turnId) as { sequence: number | null };
    const previous = sqlite
      .prepare(
        'SELECT revision,identity_json FROM control_product_entries WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1'
      )
      .get(input.kind, entry.id) as { revision: number; identity_json: string } | undefined;
    if (
      input.sequence !== (last.sequence ?? 0) + 1 ||
      input.expectedRevision !== (previous?.revision ?? 0) ||
      (previous && previous.identity_json !== entry.identityJson)
    )
      throw new ControlProductPreconditionError();
    sqlite
      .prepare(
        'INSERT INTO control_product_entries (kind,turn_id,sequence,id,revision,schema_version,content_json,identity_json) VALUES (?,?,?,?,?,1,?,?)'
      )
      .run(
        input.kind,
        input.turnId,
        input.sequence,
        entry.id,
        input.expectedRevision + 1,
        JSON.stringify(input.content),
        entry.identityJson
      );
  }
  // Cross-kind input order is not authority: all referenced Items must exist in the completed local tuple.
  for (const entry of entries) {
    const ids = entry.referencedItemIds ?? [];
    // A bounded snapshot can name many Items; one set predicate avoids one statement per Item.
    if (
      ids.length > 0 &&
      sqlite
        .prepare(
          "SELECT 1 FROM json_each(?) AS wanted WHERE NOT EXISTS (SELECT 1 FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=wanted.value) LIMIT 1"
        )
        .get(JSON.stringify(ids), entry.input.turnId)
    )
      throw new ControlProductPreconditionError();
  }
}

/** Verifies and synchronizes actual immutable bytes BEFORE SQL; no boolean durability claim is accepted. */
export function prepareControlEntries(
  owner: ControlProductOwner,
  contentMount: ControlProductContentMount | undefined,
  entries: readonly ControlProductEntry[]
): PreparedControlEntry[] {
  if (isMainThread) throw new ControlProductPreconditionError();
  return entries.map((input) => {
    if (!contentMount || input.content.byteLength > CONTROL_PRODUCT_LIMITS.payloadBytes)
      throw new ControlProductPreconditionError();
    const reference = input.content.reference;
    assertControlProductOwner(owner, reference.locator.ownerScope);
    if (
      reference.range !== null ||
      reference.availability !== 'available' ||
      reference.knowledgeBaseId !== contentMount.knowledgeBaseId ||
      reference.locator.mount !== contentMount.mount
    )
      throw new ControlProductPreconditionError();
    const root = realpathSync(contentMount.root);
    const path = resolve(root, reference.locator.path);
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel) || realpathSync(dirname(path)) !== dirname(path))
      throw new ControlProductPreconditionError();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
      const metadata = fstatSync(fd);
      if (!metadata.isFile() || metadata.size !== input.content.byteLength)
        throw new ControlProductPreconditionError();
      const bytes = readFileSync(fd);
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== reference.contentDigest)
        throw new ControlProductPreconditionError();
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    if (input.kind === 'item') {
      const item = readRetainedV1(value, () => StoredItemV1Schema.parse(value));
      assertControlProductOwner(owner, item.owner);
      if (item.turnId !== input.turnId) throw new ControlProductPreconditionError();
      const identity = {
        id: item.id,
        type: item.type,
        owner: item.owner,
        threadId: item.threadId,
        turnId: item.turnId,
        actor: 'actor' in item ? item.actor : null,
        responsibleUserId: 'responsibleUserId' in item ? item.responsibleUserId : null,
        causationId: item.causationId ?? null,
      };
      return { input, id: item.id, identityJson: JSON.stringify(identity) };
    }
    const event = readRetainedV1(value, () =>
      owner.kind === 'server'
        ? StoredServerEventV1Schema.parse(value)
        : StoredEventV1Schema.parse(value)
    );
    if (
      event.turnId !== input.turnId ||
      event.sequence !== input.sequence ||
      event.event !== event.data.type.replaceAll('-', '.') ||
      (owner.kind === 'workspace' &&
        (!('workspaceId' in event) || event.workspaceId !== owner.workspaceId))
    )
      throw new ControlProductPreconditionError();
    if (input.expectedRevision !== 0 || !event.threadId)
      throw new ControlProductPreconditionError();
    const data = event.data;
    if (
      data.type === 'turn-completed' ||
      ('turn' in data && data.turn.status !== 'pending' && data.turn.status !== 'running') ||
      (data.type === 'turn-started' && data.status !== 'pending' && data.status !== 'running')
    )
      throw new ControlProductPreconditionError();
    const referencedItemIds = new Set<string>();
    if ('item' in data) referencedItemIds.add(data.item.id);
    if ('itemId' in data) referencedItemIds.add(data.itemId);
    if ('turn' in data)
      for (const item of data.turn.items) {
        assertControlProductOwner(owner, item.owner);
        if (item.threadId !== event.threadId || item.turnId !== input.turnId)
          throw new ControlProductPreconditionError();
        referencedItemIds.add(item.id);
      }
    // Reuse the existing pure predicates on retained identity fields, not current wire parsers.
    // This envelope projection checks nested lineage only; actual Turn/Item existence is checked in SQL.
    if (owner.kind === 'server') {
      assertServerTurnEventLineage(
        event as Parameters<typeof assertServerTurnEventLineage>[0],
        {
          id: input.turnId,
          threadId: event.threadId,
          owner,
          items: [...referencedItemIds].map((id) => ({ id })),
        } as unknown as Parameters<typeof assertServerTurnEventLineage>[1]
      );
    } else {
      assertTurnEventPayloadLineage(
        event as Parameters<typeof assertTurnEventPayloadLineage>[0],
        owner.workspaceId,
        event.threadId,
        input.turnId,
        referencedItemIds
      );
    }
    return {
      input,
      id: `${input.turnId}:${event.sequence}`,
      identityJson: JSON.stringify({ threadId: event.threadId, turnId: input.turnId }),
      referencedItemIds: [...referencedItemIds],
    };
  });
}

/** A known retained metadata view; the SQL revision remains separate from descriptive payload fields. */
export interface ControlProductSnapshot {
  readonly revision: number;
  readonly record: Record<string, unknown>;
}
/** Ordered immutable descriptor, not a mutable payload or executable continuation. */
export interface ControlProductEntryView {
  readonly sequence: number;
  readonly id: string;
  readonly revision: number;
  readonly content: ControlProductEntry['content'];
}
/** Native synchronous product reader; its actual connection is read-only and query-only for its entire lifetime. */
export interface ControlStoreProductReadHandle {
  readonly sqlite: Database.Database;
  get(kind: ControlProductKind, id: string): ControlProductSnapshot | undefined;
  list(kind: ControlProductKind, afterId?: string, limit?: number): ControlProductSnapshot[];
  entries(
    turnId: string,
    kind: 'item' | 'event',
    after?: number,
    limit?: number
  ): ControlProductEntryView[];
  close(): void;
}

/** Production-owned read handle; construction never opens writable authority or runs migrations. */
export function openControlStoreProductReadHandle(
  path: string,
  owner: ControlProductOwner
): ControlStoreProductReadHandle {
  StoredWorkOwnerV1Schema.parse(owner);
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma('query_only = ON');
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return {
    sqlite,
    /** Reads one known metadata view and its native revision without pruning or publication. */
    get(kind: ControlProductKind, id: string) {
      ControlProductKindSchema.parse(kind);
      return readProduct(sqlite, owner, kind, id);
    },
    /** Materializes at most one bounded page; no cursor or transaction escapes. */
    list(kind: ControlProductKind, afterId = '', limit = CONTROL_PRODUCT_LIMITS.pageRows) {
      ControlProductKindSchema.parse(kind);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTROL_PRODUCT_LIMITS.pageRows)
        throw new ControlProductPreconditionError();
      const rows = sqlite
        .prepare(`SELECT * FROM ${tables[kind]} WHERE id>? ORDER BY id LIMIT ?`)
        .all(afterId, limit) as MetadataRow[];
      return rows.map((row) => decodeRow(kind, row, owner));
    },
    /** Reads ordered immutable descriptors, not mutable transcript files or a repair authority. */
    entries(
      turnId: string,
      kind: 'item' | 'event',
      after = 0,
      limit = CONTROL_PRODUCT_LIMITS.pageRows
    ) {
      if (
        (kind !== 'item' && kind !== 'event') ||
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > CONTROL_PRODUCT_LIMITS.pageRows
      )
        throw new ControlProductPreconditionError();
      if (!readProduct(sqlite, owner, 'turn', turnId)) return [];
      const rows = sqlite
        .prepare(
          'SELECT schema_version,sequence,id,revision,content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence>? ORDER BY sequence LIMIT ?'
        )
        .all(kind, turnId, after, limit) as {
        schema_version: number;
        sequence: number;
        id: string;
        revision: number;
        content_json: string;
      }[];
      return rows.map((row) => {
        if (row.schema_version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1)
          throw new ControlProductPreconditionError();
        const content = ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json));
        assertControlProductOwner(owner, content.reference.locator.ownerScope);
        return {
          sequence: row.sequence,
          id: row.id,
          revision: row.revision,
          content,
        };
      });
    },
    /** Releases only this native reader, never a live writer or retained bytes. */
    close() {
      sqlite.close();
    },
  };
}
