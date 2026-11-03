import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import { ContentReferenceSchema, KnowledgeBaseIdSchema, readRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { z } from 'zod';
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
  const rows = statement.all(kind, turnId, after, limit) as {
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
    assertControlProductOwner(
      owner,
      'representation' in content.reference
        ? content.reference.ownerScope
        : content.reference.locator.ownerScope
    );
    return { sequence: row.sequence, id: row.id, revision: row.revision, content };
  });
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
  owner: Extract<ControlProductOwner, { kind: 'workspace' }>
): ControlStoreProductReadHandle {
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

/** Production-owned read handle; construction never opens writable authority or runs migrations. */
export function openControlStoreProductReadHandle(
  path: string,
  owner: ControlProductOwner
): ControlStoreProductReadHandle {
  StoredWorkOwnerV1Schema.parse(owner);
  if (!lstatSync(path).isFile() || realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw new ControlProductPreconditionError();
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  // Only known metadata and entry queries are prepared; no canonical row survives a read.
  const prepared: ProductReadStatements = new Map();
  try {
    sqlite.pragma('busy_timeout = 5');
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
      return readProduct(sqlite, owner, kind, id, prepared);
    },
    /** Materializes at most one bounded page; no cursor or transaction escapes. */
    list(kind: ControlProductKind, afterId = '', limit = CONTROL_PRODUCT_LIMITS.pageRows) {
      return listProducts(sqlite, owner, kind, afterId, limit, prepared);
    },
    /** Reads ordered immutable descriptors, not mutable transcript files or a repair authority. */
    entries(
      turnId: string,
      kind: 'item' | 'event',
      after = 0,
      limit = CONTROL_PRODUCT_LIMITS.pageRows
    ) {
      return readProductEntries(sqlite, owner, turnId, kind, after, limit, prepared);
    },
    /** Releases only this native reader, never a live writer or retained bytes. */
    close() {
      sqlite.close();
    },
  };
}
