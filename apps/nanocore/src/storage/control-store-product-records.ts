import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import {
  ContentReferenceSchema,
  ItemTypeSchema,
  KnowledgeBaseIdSchema,
  readRetainedV1,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { ControlPendingCommandInputSchema } from '../runtime/pending-request-codecs.js';
import { assertWorkspaceWorkOwner } from './fs-layout.js';
import {
  StoredThreadSnapshotV1Schema,
  ThreadRequiredFeaturesV1Schema,
} from './retained-work-events-v1.js';
import {
  StoredAgentSessionV1Schema,
  StoredTurnV1Schema,
  StoredWorkOwnerV1Schema,
  StoredWorkspaceV1Schema,
} from './retained-work-metadata-v1.js';

/** Current finite metadata/page defaults; exact work bodies use inline bytes or immutable Storage objects. */
export const CONTROL_PRODUCT_LIMITS = {
  metadataBytes: 64 * 1024,
  entries: 32,
  pageRows: 128,
  payloadBytes: 1024 * 1024,
  inlineBytes: 65_536,
  // File-backed canonical bodies are separate from bounded control envelopes.
  immutableBodyBytes: 32 * 1024 * 1024,
  bodyPreparationBytes: 64 * 1024 * 1024,
} as const;

/** Admitted transient Storage binding; reference parsing cannot select another Knowledge Base or mount. */
export const ControlProductContentMountSchema = z
  .object({
    root: z.string().min(1),
    knowledgeBaseId: KnowledgeBaseIdSchema.nullable(),
    mount: z.string().min(1),
  })
  .strict()
  .refine(
    (binding) => (binding.knowledgeBaseId === null) === (binding.mount === 'backend-evidence'),
    'Native retained work bytes require their exact null-Knowledge-Base backend-evidence binding.'
  );

export type ControlProductContentMount = z.infer<typeof ControlProductContentMountSchema>;

/** Physical product kinds project existing retained families; they are not new product concepts. */
export const ControlProductKindSchema = z.enum(['workspace', 'thread', 'agent-session', 'turn']);

export type ControlProductKind = z.infer<typeof ControlProductKindSchema>;

/** Existing immutable product owner, independent of execution placement. */
export type ControlProductOwner = z.infer<typeof StoredWorkOwnerV1Schema>;

// The shared file reader tolerates descriptive additions; a required representation tag
// must be dispatched before that reader can strip it and reinterpret it as a file.
const fileReferenceSchema = z.preprocess(
  (value) => (value && typeof value === 'object' && 'representation' in value ? null : value),
  ContentReferenceSchema
);

export const fileContentSchema = z
  .object({
    reference: fileReferenceSchema,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
  })
  .strict();

/** Exact retained work bytes; prior file descriptors remain a current representation. */
export const ControlProductEntrySchema = z
  .object({
    kind: z.enum(['item', 'event']),
    turnId: z.string().min(1),
    sequence: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    publication: z
      .object({
        temporary: z
          .string()
          .regex(
            /^\.[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
          ),
      })
      .strict()
      .optional(),
    content: z
      .object({
        reference: z.union([
          fileReferenceSchema,
          z
            .object({
              representation: z.literal('inline'),
              body: z.string().max(CONTROL_PRODUCT_LIMITS.inlineBytes),
              contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
              ownerScope: StoredWorkOwnerV1Schema,
            })
            .strict(),
        ]),
        byteLength: z.number().int().nonnegative(),
        mediaType: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ControlProductEntry = z.infer<typeof ControlProductEntrySchema>;

/** Conditional replacement of bounded metadata; zero means create, never overwrite. */
export const ControlProductMutationSchema = z
  .object({
    kind: ControlProductKindSchema,
    expectedRevision: z.number().int().nonnegative(),
    record: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ControlProductMutation = z.infer<typeof ControlProductMutationSchema>;

/** Existing non-command lifecycle writes share the native product owner, without inventing a command receipt. */
export const ControlProductTransitionSchema = z
  .object({
    products: z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries),
    entries: z.array(ControlProductEntrySchema).max(CONTROL_PRODUCT_LIMITS.entries),
    journalIntents: z.array(z.string().min(1)).max(CONTROL_PRODUCT_LIMITS.entries).optional(),
    pending: z
      .array(z.lazy(() => ControlPendingCommandInputSchema))
      .max(CONTROL_PRODUCT_LIMITS.entries)
      .optional(),
  })
  .strict()
  .refine((value) => value.products.length + value.entries.length > 0);

/** Whole bounded product transition; terminal candidates still require the complete native terminal path. */
export type ControlProductTransition = z.infer<typeof ControlProductTransitionSchema>;

/** Verifies original inline UTF-8 bytes before decoding; file references keep their existing owner. */
export function inlineControlContentBytes(
  owner: ControlProductOwner,
  content: ControlProductEntry['content']
): Buffer | undefined {
  const reference = content.reference;
  if (!('representation' in reference)) return undefined;
  assertControlProductOwner(owner, reference.ownerScope);
  const bytes = Buffer.from(reference.body, 'utf8');
  if (
    reference.representation !== 'inline' ||
    !Number.isSafeInteger(content.byteLength) ||
    bytes.length !== content.byteLength ||
    bytes.length > CONTROL_PRODUCT_LIMITS.inlineBytes ||
    bytes.toString('utf8') !== reference.body ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== reference.contentDigest
  )
    throw new ControlProductPreconditionError();
  return bytes;
}

/** A rejected tuple, including stale revision or missing native dependency; no caller-supplied diagnostics escape. */
export class ControlProductPreconditionError extends Error {
  constructor() {
    super('Control product transition precondition failed.');
  }
}

export const tables = {
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

/** Checks exact scope relationships without turning a path or native executor into product authority. */
export function assertControlProductOwner(owner: ControlProductOwner, actual: unknown): void {
  const known = StoredWorkOwnerV1Schema.parse(actual);
  // Main admission keeps the shared ownership refusal; native mutations retain their precondition error.
  if (isMainThread && owner.kind === 'workspace')
    assertWorkspaceWorkOwner({ owner: known }, owner.workspaceId);
  if (!isDeepStrictEqual(owner, known)) throw new ControlProductPreconditionError();
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
    (kind === 'thread'
      ? !ThreadRequiredFeaturesV1Schema.safeParse(raw.requiredFeatures).success
      : !Array.isArray(raw.requiredFeatures) || raw.requiredFeatures.length > 0)
  )
    throw new ControlProductPreconditionError();
  if (isMainThread && kind === 'agent-session' && owner.kind === 'workspace')
    assertWorkspaceWorkOwner(
      { owner: { kind: 'workspace', workspaceId: record.workspaceId } },
      owner.workspaceId
    );
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

type ProductReadStatements = Map<ControlProductKind | 'entries', Database.Statement>;

/** Returns only native SQL metadata and its revision, never a file-backed fallback or cache. */
export function readProduct(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  kind: ControlProductKind,
  id: string,
  prepared?: ProductReadStatements
) {
  let statement = prepared?.get(kind);
  if (!statement) {
    statement = sqlite.prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`);
    prepared?.set(kind, statement);
  }
  const row = statement.get(id) as MetadataRow | undefined;
  return row === undefined ? undefined : decodeRow(sqlite, kind, row, owner, prepared);
}

/** Reads one bounded metadata page on the supplied owner connection and its current snapshot. */
export function listProducts(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  kind: ControlProductKind,
  afterId = '',
  limit: number = CONTROL_PRODUCT_LIMITS.pageRows,
  prepared?: ProductReadStatements
): ControlProductSnapshot[] {
  ControlProductKindSchema.parse(kind);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTROL_PRODUCT_LIMITS.pageRows)
    throw new ControlProductPreconditionError();
  const rows = sqlite
    .prepare(`SELECT * FROM ${tables[kind]} WHERE id>? ORDER BY id LIMIT ?`)
    .all(afterId, limit) as MetadataRow[];
  return rows.map((row) => decodeRow(sqlite, kind, row, owner, prepared));
}

/** Turn metadata ordered by its immutable first native admission, independent of start time. */
export interface ControlThreadTurnSnapshot extends ControlProductSnapshot {
  readonly admissionOrder: number;
}

/** Reads only one Thread's indexed metadata; no other Thread is decoded. */
export function listThreadTurnProducts(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  threadId: string,
  afterAdmissionOrder = 0,
  limit: number = CONTROL_PRODUCT_LIMITS.pageRows
): ControlThreadTurnSnapshot[] {
  if (
    !Number.isSafeInteger(afterAdmissionOrder) ||
    afterAdmissionOrder < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONTROL_PRODUCT_LIMITS.pageRows
  )
    throw new ControlProductPreconditionError();
  if (!readProduct(sqlite, owner, 'thread', threadId)) return [];
  const rows = sqlite
    .prepare(
      'SELECT * FROM control_turns WHERE thread_id=? AND admission_order>? ORDER BY admission_order LIMIT ?'
    )
    .all(threadId, afterAdmissionOrder, limit) as (MetadataRow & { admission_order: number })[];
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.admission_order) || row.admission_order <= 0)
      throw new ControlProductPreconditionError();
    return { ...decodeRow(sqlite, 'turn', row, owner), admissionOrder: row.admission_order };
  });
}

/** Selects the current exact Item only after its Turn matches the requested Thread. */
export function readThreadItemEntry(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  threadId: string,
  itemId: string
): (ControlProductEntryView & { readonly turnId: string }) | undefined {
  if (!readProduct(sqlite, owner, 'thread', threadId)) return undefined;
  const row = sqlite
    .prepare(`SELECT e.* FROM control_product_entries e
    JOIN control_turns t ON t.id=e.turn_id
    WHERE e.kind='item' AND e.id=? AND t.thread_id=? ORDER BY e.revision DESC LIMIT 1`)
    .get(itemId, threadId) as (ProductEntryRow & { turn_id: string }) | undefined;
  if (!row) return undefined;
  const turn = readProduct(sqlite, owner, 'turn', row.turn_id);
  if (!turn || turn.record.threadId !== threadId) throw new ControlProductPreconditionError();
  return { ...decodeProductEntry(row, owner), turnId: row.turn_id };
}

/** Counts first Item revisions by immutable kind without opening body bytes or later revisions. */
export function readTurnItemCounts(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  threadId: string,
  turnId: string
): Partial<Record<z.infer<typeof ItemTypeSchema>, number>> | undefined {
  const turn = readProduct(sqlite, owner, 'turn', turnId);
  if (!turn || turn.record.threadId !== threadId) return undefined;
  const rows = sqlite
    .prepare(`SELECT json_extract(identity_json, '$.type') AS type, count(*) AS count
    FROM control_product_entries WHERE kind='item' AND turn_id=? AND revision=1
    GROUP BY json_extract(identity_json, '$.type')`)
    .all(turnId) as { type: unknown; count: number }[];
  const counts: Partial<Record<z.infer<typeof ItemTypeSchema>, number>> = {};
  for (const row of rows) counts[ItemTypeSchema.parse(row.type)] = row.count;
  return counts;
}

/** An original Item position stays fixed when later revisions are appended. */
export interface ThreadItemPosition {
  readonly itemId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly admissionOrder: number;
}

/** Bounded keyset selectors, always subordinate to the supplied owner and Thread. */
export interface ThreadTurnWindow {
  readonly upper: number;
  readonly boundary?: number;
  readonly direction: 'before' | 'after';
  readonly limit: number;
}

/** Uses the Thread/admission index without opening histories or sibling metadata. */
export function readThreadTurnWindow(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  threadId: string,
  window: ThreadTurnWindow
): ControlThreadTurnSnapshot[] {
  if (!readProduct(sqlite, owner, 'thread', threadId)) return [];
  if (
    !Number.isSafeInteger(window.upper) ||
    window.upper < 0 ||
    !Number.isSafeInteger(window.limit) ||
    window.limit < 1 ||
    window.limit > 64 ||
    (window.boundary !== undefined &&
      (!Number.isSafeInteger(window.boundary) || window.boundary < 0))
  )
    throw new ControlProductPreconditionError();
  const before = window.direction === 'before';
  const boundary = window.boundary ?? (before ? Number.MAX_SAFE_INTEGER : 0);
  const rows = sqlite
    .prepare(`SELECT * FROM control_turns WHERE thread_id=? AND admission_order<=?
    AND admission_order ${before ? '<' : '>'} ? ORDER BY admission_order ${before ? 'DESC' : 'ASC'} LIMIT ?`)
    .all(threadId, window.upper, boundary, window.limit) as (MetadataRow & {
    admission_order: number;
  })[];
  return rows.map((row) => ({
    ...decodeRow(sqlite, 'turn', row, owner),
    admissionOrder: row.admission_order,
  }));
}

/** Current active work is independent of later terminal service admissions. */
export function readActiveThreadTurnSnapshot(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  threadId: string
): ControlThreadTurnSnapshot | undefined {
  const row = sqlite
    .prepare(
      "SELECT id FROM control_turns WHERE thread_id=? AND status IN ('pending','running') LIMIT 1"
    )
    .get(threadId) as { id: string } | undefined;
  return row ? readThreadTurnSnapshot(sqlite, owner, threadId, row.id) : undefined;
}

/** Resolves one exact run's indexed metadata within the requested Thread. */
export function readThreadTurnSnapshot(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  threadId: string,
  turnId: string
): ControlThreadTurnSnapshot | undefined {
  const row = sqlite
    .prepare('SELECT * FROM control_turns WHERE id=? AND thread_id=?')
    .get(turnId, threadId) as (MetadataRow & { admission_order: number }) | undefined;
  return row
    ? { ...decodeRow(sqlite, 'turn', row, owner), admissionOrder: row.admission_order }
    : undefined;
}

/** Reads the current immutable run boundary through its covering index. */
export function readThreadAdmissionHead(sqlite: Database.Database, threadId: string): number {
  return (
    sqlite
      .prepare(
        'SELECT coalesce(max(admission_order),0) AS head FROM control_turns WHERE thread_id=?'
      )
      .get(threadId) as { head: number }
  ).head;
}

/** Resolves only minimal source lineage by its indexed identity, before audience or content disclosure. */
export function readItemLineage(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  itemId: string
): { threadId: string; turnId: string } | undefined {
  const row = sqlite
    .prepare(`SELECT e.turn_id AS turnId,t.thread_id AS threadId,e.identity_json AS identity
    FROM control_product_entries e JOIN control_turns t ON t.id=e.turn_id
    WHERE e.kind='item' AND e.id=? AND e.revision=1`)
    .get(itemId) as { threadId: string; turnId: string; identity: string } | undefined;
  if (!row) return undefined;
  const turn = readProduct(sqlite, owner, 'turn', row.turnId);
  const identity = JSON.parse(row.identity);
  if (
    !turn ||
    turn.record.threadId !== row.threadId ||
    identity.threadId !== row.threadId ||
    identity.turnId !== row.turnId
  )
    throw new ControlProductPreconditionError();
  return { threadId: row.threadId, turnId: row.turnId };
}

/** Resolves original identity before opening any body, including for foreign anchors. */
export function readThreadItemPosition(
  sqlite: Database.Database,
  threadId: string,
  itemId: string
): ThreadItemPosition | undefined {
  return sqlite
    .prepare(`SELECT e.id AS itemId,e.turn_id AS turnId,e.sequence,t.admission_order AS admissionOrder
    FROM control_product_entries e JOIN control_turns t ON t.id=e.turn_id
    WHERE e.kind='item' AND e.id=? AND e.revision=1 AND t.thread_id=?`)
    .get(itemId, threadId) as ThreadItemPosition | undefined;
}

/** Selects bounded first-revision positions; current body revisions are resolved separately in the same cut. */
export function readTurnItemPositions(
  sqlite: Database.Database,
  threadId: string,
  turnId: string,
  input: {
    readonly types: readonly string[];
    readonly upper: number;
    readonly boundary?: number;
    readonly direction: 'before' | 'after';
    readonly limit: number;
  }
): ThreadItemPosition[] {
  if (input.types.length === 0) return [];
  const types = input.types.map((type) => ItemTypeSchema.parse(type));
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 64 ||
    !Number.isSafeInteger(input.upper) ||
    input.upper < 0 ||
    (input.boundary !== undefined && (!Number.isSafeInteger(input.boundary) || input.boundary < 0))
  )
    throw new ControlProductPreconditionError();
  const before = input.direction === 'before';
  // Seek each immutable kind independently so a sparse narrative does not scan an unbounded process history.
  const statement =
    sqlite.prepare(`SELECT e.id AS itemId,e.turn_id AS turnId,e.sequence,t.admission_order AS admissionOrder
    FROM control_product_entries e JOIN control_turns t ON t.id=e.turn_id
    WHERE e.kind='item' AND e.revision=1 AND e.turn_id=? AND t.thread_id=? AND e.sequence<=?
    AND e.sequence ${before ? '<' : '>'} ? AND json_extract(e.identity_json,'$.type')=?
    ORDER BY e.sequence ${before ? 'DESC' : 'ASC'} LIMIT ?`);
  const rows = types.flatMap(
    (type) =>
      statement.all(
        turnId,
        threadId,
        input.upper,
        input.boundary ?? (before ? Number.MAX_SAFE_INTEGER : 0),
        type,
        input.limit
      ) as ThreadItemPosition[]
  );
  rows.sort((left, right) =>
    before ? right.sequence - left.sequence : left.sequence - right.sequence
  );
  return rows.slice(0, input.limit);
}

/** Captures the original Item append boundary, excluding revisions of existing Items. */
export function readTurnItemHead(
  sqlite: Database.Database,
  threadId: string,
  turnId: string
): number {
  return (
    sqlite
      .prepare(`SELECT coalesce(max(e.sequence),0) AS head FROM control_product_entries e
    JOIN control_turns t ON t.id=e.turn_id WHERE e.kind='item' AND e.revision=1 AND e.turn_id=? AND t.thread_id=?`)
      .get(turnId, threadId) as { head: number }
  ).head;
}

/** Receipt membership and actor identity select B; neither receipt order nor an identifier substitutes for chronology. */
export function readThreadCatchUpPosition(
  sqlite: Database.Database,
  threadId: string,
  userId: string,
  receiptItemIds: readonly string[]
): ThreadItemPosition | undefined {
  const select = `SELECT e.id AS itemId,e.turn_id AS turnId,e.sequence,t.admission_order AS admissionOrder
    FROM control_product_entries e JOIN control_turns t ON t.id=e.turn_id`;
  const own = sqlite
    .prepare(`${select} WHERE e.kind='item' AND e.revision=1
    AND json_extract(e.identity_json,'$.threadId')=? AND json_extract(e.identity_json,'$.actor.id')=?
    AND t.thread_id=? ORDER BY t.admission_order DESC,e.sequence DESC LIMIT 1`)
    .get(threadId, userId, threadId) as ThreadItemPosition | undefined;
  const seen = receiptItemIds.length
    ? (sqlite
        .prepare(`${select} WHERE e.kind='item' AND e.revision=1
    AND e.id IN (SELECT value FROM json_each(?)) AND t.thread_id=?
    AND json_extract(e.identity_json,'$.type') IN ('user-message','assistant-message')
    ORDER BY t.admission_order DESC,e.sequence DESC LIMIT 1`)
        .get(JSON.stringify(receiptItemIds), threadId) as ThreadItemPosition | undefined)
    : undefined;
  if (!own) return seen;
  if (!seen) return own;
  return own.admissionOrder > seen.admissionOrder ||
    (own.admissionOrder === seen.admissionOrder && own.sequence >= seen.sequence)
    ? own
    : seen;
}

/** Native immutable descriptor fields shared by ordered and addressed reads. */
interface ProductEntryRow {
  readonly schema_version: number;
  readonly sequence: number;
  readonly id: string;
  readonly revision: number;
  readonly content_json: string;
}

/** Checks the original descriptor and scope before any immutable content read. */
function decodeProductEntry(
  row: ProductEntryRow,
  owner: ControlProductOwner
): ControlProductEntryView {
  if (row.schema_version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1)
    throw new ControlProductPreconditionError();
  const content = ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json));
  assertControlProductOwner(
    owner,
    'representation' in content.reference
      ? content.reference.ownerScope
      : content.reference.locator.ownerScope
  );
  return { sequence: row.sequence, id: row.id, revision: row.revision, content };
}

/** Reads ordered immutable descriptors without opening, closing, or advancing the supplied snapshot. */
export function readProductEntries(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  turnId: string,
  kind: 'item' | 'event',
  after = 0,
  limit: number = CONTROL_PRODUCT_LIMITS.pageRows,
  prepared?: ProductReadStatements
): ControlProductEntryView[] {
  if (
    (kind !== 'item' && kind !== 'event') ||
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONTROL_PRODUCT_LIMITS.pageRows
  )
    throw new ControlProductPreconditionError();
  if (!readProduct(sqlite, owner, 'turn', turnId, prepared)) return [];
  let statement = prepared?.get('entries');
  if (!statement) {
    statement = sqlite.prepare(
      'SELECT schema_version,sequence,id,revision,content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence>? ORDER BY sequence LIMIT ?'
    );
    prepared?.set('entries', statement);
  }
  const rows = statement.all(kind, turnId, after, limit) as ProductEntryRow[];
  return rows.map((row) => decodeProductEntry(row, owner));
}

/** Rejects disagreements between indexed SQL authority and its retained metadata view. */
function decodeRow(
  sqlite: Database.Database,
  kind: ControlProductKind,
  row: MetadataRow,
  owner: ControlProductOwner,
  prepared?: ProductReadStatements
) {
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
  if (kind === 'turn' && record.agentSessionId != null) {
    const session = readProduct(
      sqlite,
      owner,
      'agent-session',
      String(record.agentSessionId),
      prepared
    );
    if (!session || session.record.threadId !== record.threadId)
      throw new ControlProductPreconditionError();
  }
  return { revision: row.revision, record };
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

/** Synchronous product reads through an owned query-only connection or the caller's admitted connection. */
export interface ControlStoreProductReadHandle {
  readonly sqlite: Database.Database;
  get(kind: ControlProductKind, id: string): ControlProductSnapshot | undefined;
  list(kind: ControlProductKind, afterId?: string, limit?: number): ControlProductSnapshot[];
  threadTurns(
    threadId: string,
    afterAdmissionOrder?: number,
    limit?: number
  ): ControlThreadTurnSnapshot[];
  threadItem(
    threadId: string,
    itemId: string
  ): (ControlProductEntryView & { readonly turnId: string }) | undefined;
  turnItemCounts(
    threadId: string,
    turnId: string
  ): Partial<Record<z.infer<typeof ItemTypeSchema>, number>> | undefined;
  entries(
    turnId: string,
    kind: 'item' | 'event',
    after?: number,
    limit?: number
  ): ControlProductEntryView[];
  close(): void;
}

const workspaceProductReaders = new Map<
  string,
  {
    owner: Extract<ControlProductOwner, { kind: 'workspace' }>;
    identity: string;
    reader: ControlStoreProductReadHandle;
  }
>();

/** Reuses a Workspace metadata connection and statements, never rows or a SQL snapshot. */
export function getWorkspaceProductReadHandle(
  path: string,
  owner: Extract<ControlProductOwner, { kind: 'workspace' }>,
  borrowed?: Database.Database
): ControlStoreProductReadHandle {
  if (borrowed) return openControlStoreProductReadHandle(path, owner, borrowed);
  path = resolve(path);
  const cached = workspaceProductReaders.get(path);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || realpathSync(dirname(path)) !== dirname(path))
      throw new ControlProductPreconditionError();
    const identity = `${file.dev}:${file.ino}`;
    if (cached) {
      if (!isDeepStrictEqual(cached.owner, owner) || cached.identity !== identity)
        throw new ControlProductPreconditionError();
      return cached.reader;
    }
    const reader = openControlStoreProductReadHandle(path, owner);
    workspaceProductReaders.set(path, { owner: { ...owner }, identity, reader });
    return reader;
  } catch (error) {
    if (cached) closeWorkspaceProductReadHandles(path);
    throw error;
  }
}

/** Releases retained readers before their database or containing root is closed or replaced. */
export function closeWorkspaceProductReadHandles(root?: string): void {
  const selected = root === undefined ? undefined : resolve(root);
  for (const [path, { reader }] of workspaceProductReaders) {
    if (selected !== undefined && path !== selected && !path.startsWith(`${selected}${sep}`))
      continue;
    workspaceProductReaders.delete(path);
    if (reader.sqlite.open) reader.close();
  }
}

/** Reads through an admitted native connection or opens its own query-only connection; never acquires write authority. */
export function openControlStoreProductReadHandle(
  path: string,
  owner: ControlProductOwner,
  borrowed?: Database.Database
): ControlStoreProductReadHandle {
  StoredWorkOwnerV1Schema.parse(owner);
  if (!lstatSync(path).isFile() || realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw new ControlProductPreconditionError();
  if (borrowed && (!borrowed.open || resolve(borrowed.name) !== resolve(path)))
    throw new ControlProductPreconditionError();
  if (
    borrowed &&
    owner.kind === 'workspace' &&
    !readProduct(borrowed, owner, 'workspace', owner.workspaceId)
  )
    throw new ControlProductPreconditionError();
  const sqlite = borrowed ?? new Database(path, { readonly: true, fileMustExist: true });
  // Only known metadata and entry queries are prepared; no canonical row survives a read.
  const prepared: ProductReadStatements = new Map();
  let closed = false;
  const assertReaderOpen = () => {
    if (borrowed && closed) throw new ControlProductPreconditionError();
  };
  if (!borrowed) {
    try {
      sqlite.pragma('busy_timeout = 5');
      sqlite.pragma('query_only = ON');
    } catch (error) {
      sqlite.close();
      throw error;
    }
  }
  return {
    sqlite,
    /** Reads one known metadata view and its native revision without pruning or publication. */
    get(kind: ControlProductKind, id: string) {
      assertReaderOpen();
      ControlProductKindSchema.parse(kind);
      return readProduct(sqlite, owner, kind, id, prepared);
    },
    /** Materializes at most one bounded page; no cursor or transaction escapes. */
    list(kind: ControlProductKind, afterId = '', limit = CONTROL_PRODUCT_LIMITS.pageRows) {
      assertReaderOpen();
      return listProducts(sqlite, owner, kind, afterId, limit, prepared);
    },
    /** Reads a bounded page from the requested Thread's admission index. */
    threadTurns(threadId, afterAdmissionOrder = 0, limit = CONTROL_PRODUCT_LIMITS.pageRows) {
      assertReaderOpen();
      return listThreadTurnProducts(sqlite, owner, threadId, afterAdmissionOrder, limit);
    },
    /** Resolves only the requested Thread's exact Item descriptor. */
    threadItem(threadId, itemId) {
      assertReaderOpen();
      return readThreadItemEntry(sqlite, owner, threadId, itemId);
    },
    /** Counts immutable first revisions in the requested Turn's index. */
    turnItemCounts(threadId, turnId) {
      assertReaderOpen();
      return readTurnItemCounts(sqlite, owner, threadId, turnId);
    },
    /** Reads ordered immutable descriptors, not mutable transcript files or a repair authority. */
    entries(
      turnId: string,
      kind: 'item' | 'event',
      after = 0,
      limit = CONTROL_PRODUCT_LIMITS.pageRows
    ) {
      assertReaderOpen();
      return readProductEntries(sqlite, owner, turnId, kind, after, limit, prepared);
    },
    /** Releases owned read resources; the admitted native connection keeps its original lifetime. */
    close() {
      closed = true;
      prepared.clear();
      if (!borrowed) sqlite.close();
    },
  };
}
