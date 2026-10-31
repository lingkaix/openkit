import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { type FileHandle, link, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import {
  AuditEventSchema,
  ContentReferenceSchema,
  ItemSchema,
  KnowledgeBaseIdSchema,
  PROTOCOL_VERSION,
  RequestIdSchema,
  readRetainedV1,
  responsibleUserIdForActor,
  SseEventEnvelopeSchema,
  WorkOwnerSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import type { StorageContent } from '@openkit/storage';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { CommandRequestName, CommandRequestResponse } from '../lib/store.js';
import {
  createExecutionStepJournalReader,
  settleExecutionJournalStep,
} from '../runtime/execution-journal.js';
import type { ExecutionJournalSettlement } from '../runtime/execution-step-journal.js';
import type { PreparedControlPendingCommand } from '../runtime/pending-requests.js';
import {
  applyControlPendingCommand,
  ControlPendingCommandInputSchema,
} from '../runtime/pending-requests.js';
import { StoredRuntimeEvidenceV1Schema } from '../runtime/runtime-evidence-v1.js';
import { prepareControlPendingCommands } from './control-store-pending.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import { assertWorkspaceWorkOwner } from './fs-layout.js';
import { StoredServerEventV1Schema } from './retained-server-work-v1.js';
import {
  StoredEventV1Schema,
  StoredThreadSnapshotV1Schema,
  StoredTurnSnapshotV1Schema,
  THREAD_REQUIRED_FEATURES,
  ThreadRequiredFeaturesV1Schema,
} from './retained-work-events-v1.js';
import { StoredItemPayloadV1Schema, StoredItemV1Schema } from './retained-work-items-v1.js';
import {
  StoredAgentSessionV1Schema,
  StoredTurnV1Schema,
  StoredWorkOwnerV1Schema,
  StoredWorkspaceV1Schema,
} from './retained-work-metadata-v1.js';
import { assertServerTurnEventLineage } from './server-thread-records.js';
import {
  assertImmutableItemAttribution,
  assertTurnEventPayloadLineage,
  preserveDescriptiveRecord,
} from './workspace-file-records.js';

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
/** Conditional replacement of bounded metadata; zero means create, never overwrite. */
export const ControlProductMutationSchema = z
  .object({
    kind: ControlProductKindSchema,
    expectedRevision: z.number().int().nonnegative(),
    record: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ControlProductMutation = z.infer<typeof ControlProductMutationSchema>;
// The shared file reader tolerates descriptive additions; a required representation tag
// must be dispatched before that reader can strip it and reinterpret it as a file.
const fileReferenceSchema = z.preprocess(
  (value) => (value && typeof value === 'object' && 'representation' in value ? null : value),
  ContentReferenceSchema
);
const fileContentSchema = z
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

/** Counts descriptor metadata separately from bounded inline entry bodies; actual queue bytes stay charged. */
export function controlProductMetadataJson(value: {
  entries?: readonly ControlProductEntry[];
  terminal?: { entries?: readonly ControlProductEntry[] };
  admission?: { entries?: readonly ControlProductEntry[] };
  pendingItem?: { entry: ControlProductEntry } | null;
  pendingAdmission?: { entries?: readonly ControlProductEntry[] };
  transition?: { entries?: readonly ControlProductEntry[] };
}): string {
  const entryMetadata = (entry: ControlProductEntry) => {
    const reference = entry.content.reference;
    return 'representation' in reference
      ? { ...entry, content: { ...entry.content, reference: { ...reference, body: '' } } }
      : entry;
  };
  const entriesMetadata = (input: { entries?: readonly ControlProductEntry[] }) => ({
    ...input,
    ...(input.entries && {
      entries: input.entries.map(entryMetadata),
    }),
  });
  return JSON.stringify({
    ...entriesMetadata(value),
    // Existing compound owners carry bounded bodies at these fixed packet paths.
    ...(value.terminal && { terminal: entriesMetadata(value.terminal) }),
    ...(value.admission && { admission: entriesMetadata(value.admission) }),
    ...(value.pendingItem && {
      pendingItem: { ...value.pendingItem, entry: entryMetadata(value.pendingItem.entry) },
    }),
    ...(value.pendingAdmission && { pendingAdmission: entriesMetadata(value.pendingAdmission) }),
    ...(value.transition && { transition: entriesMetadata(value.transition) }),
  });
}
/** One shared publication stays live until every admitted preparation or queued reference releases it. */
export interface ControlContentPublication {
  readonly result: Promise<{ bytes: Buffer; changedDirectory: boolean }>;
  references: number;
  directorySynchronized: boolean;
}
/** Native-local preparation obligations; shared publications live only until their selected batch or refusal. */
export interface ControlContentPreparation {
  readonly db: CoreDb | WorkspaceDb | undefined;
  readonly directories: Set<string>;
  readonly publications: Map<string, ControlContentPublication>;
  readonly published: Set<string>;
}
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

// Prepared values are native-local capabilities, not trusted descriptors supplied over transport.
const preparedPayloads = new WeakMap<PreparedControlEntry, unknown>();
// Exact publication equality also preserves descriptive fields omitted by the known-core decoder.
const preparedOriginals = new WeakMap<PreparedControlEntry, unknown>();

/** Reads only an actual native-prepared payload so dependent SQL owners can validate its exact tuple before writing. */
export function readPreparedControlEntry(entry: PreparedControlEntry): unknown {
  if (isMainThread || !preparedPayloads.has(entry)) throw new ControlProductPreconditionError();
  return preparedPayloads.get(entry);
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
/** Only absent decided fields can be filled after sealing; identity and populated outcomes never change. */
const terminalFillableFields = new Set([
  'error',
  'completedAt',
  'durationMs',
  'agentId',
  'agentProfileId',
  'agentSessionId',
  'triggerSource',
  'configVersion',
]);

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

/** Returns only native SQL metadata and its revision, never a file-backed fallback or cache. */
export function readProduct(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  kind: ControlProductKind,
  id: string,
  prepared?: Map<ControlProductKind, Database.Statement>
) {
  let statement = prepared?.get(kind);
  if (!statement) {
    statement = sqlite.prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`);
    prepared?.set(kind, statement);
  }
  const row = statement.get(id) as MetadataRow | undefined;
  return row === undefined ? undefined : decodeRow(sqlite, kind, row, owner, prepared);
}

/** Rejects disagreements between indexed SQL authority and its retained metadata view. */
function decodeRow(
  sqlite: Database.Database,
  kind: ControlProductKind,
  row: MetadataRow,
  owner: ControlProductOwner,
  prepared?: Map<ControlProductKind, Database.Statement>
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

/** Preserves immutable identity and keeps terminal admission private to the complete SQL owner. */
function checkReplacement(
  kind: ControlProductKind,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  terminalTurnId?: string
): void {
  if (
    kind === 'turn' &&
    after.id !== terminalTurnId &&
    after.status !== 'pending' &&
    after.status !== 'running'
  )
    throw new ControlProductPreconditionError();
  if (!before) return;
  if (
    kind === 'turn' &&
    before.id !== terminalTurnId &&
    !['pending', 'running'].includes(String(before.status))
  )
    throw new ControlProductPreconditionError();
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
  applyProducts(sqlite, owner, mutations, entries);
}

/** Shared SQL mechanics; only the complete terminal owner supplies its exact terminal identity. */
function applyProducts(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  mutations: readonly ControlProductMutation[],
  entries: readonly PreparedControlEntry[],
  terminalTurnId?: string
): void {
  assertControlProductWriter(sqlite);
  if (owner.kind === 'workspace' && !mutations.some((input) => input.kind === 'workspace')) {
    const createdThreads = mutations
      .filter((input) => input.kind === 'thread')
      .map((input) => decode('thread', input.record, owner))
      .filter((record) => !readProduct(sqlite, owner, 'thread', record.id as string));
    if (createdThreads.length > 0) {
      const workspace = readProduct(sqlite, owner, 'workspace', owner.workspaceId);
      if (!workspace) throw new ControlProductPreconditionError();
      // Independent Thread admissions derive their incidental parent touch inside the deciding transaction.
      const updatedAt = createdThreads.reduce(
        (latest, thread) => (String(thread.createdAt) > latest ? String(thread.createdAt) : latest),
        String(workspace.record.updatedAt)
      );
      mutations = [
        {
          kind: 'workspace',
          expectedRevision: workspace.revision,
          record: writeRetainedV1({ ...workspace.record, updatedAt }),
        },
        ...mutations,
      ];
    }
  }
  const terminalBefore = terminalTurnId
    ? readProduct(sqlite, owner, 'turn', terminalTurnId)
    : undefined;
  const terminalWasSealed =
    terminalBefore !== undefined &&
    !['pending', 'running'].includes(String(terminalBefore.record.status));
  const seen = new Set<string>();
  for (const kind of ['workspace', 'thread', 'agent-session', 'turn'] as const) {
    for (const input of mutations.filter((value) => value.kind === kind)) {
      const record = decode(kind, input.record, owner);
      const id = record.id as string;
      const key = `${kind}:${id}`;
      if (seen.has(key)) throw new ControlProductPreconditionError();
      seen.add(key);
      const previous = readProduct(sqlite, owner, kind, id);
      const terminalReplay =
        kind === 'turn' &&
        id === terminalTurnId &&
        previous &&
        !['pending', 'running'].includes(String(previous.record.status));
      if ((previous?.revision ?? 0) !== input.expectedRevision && !terminalReplay)
        throw new ControlProductPreconditionError();
      if (terminalReplay) {
        const candidate = { ...record };
        if (
          candidate.requiredFeatures === undefined &&
          previous.record.requiredFeatures !== undefined
        )
          candidate.requiredFeatures = previous.record.requiredFeatures;
        // An exact replay can fill missing references without advancing metadata or the Goal marker.
        if (isDeepStrictEqual(previous.record, candidate)) continue;
        if (
          input.expectedRevision !== previous.revision ||
          Object.keys({ ...previous.record, ...candidate }).some(
            (field) =>
              !isDeepStrictEqual(previous.record[field], candidate[field]) &&
              !(terminalFillableFields.has(field) && previous.record[field] == null)
          )
        )
          throw new ControlProductPreconditionError();
      }
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
      checkReplacement(kind, previous?.record, record, terminalTurnId);
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
      ) as Record<string, unknown>;
      if (
        terminalReplay &&
        replacement.requiredFeatures === undefined &&
        previous.record.requiredFeatures !== undefined
      )
        replacement.requiredFeatures = previous.record.requiredFeatures;
      if (kind === 'thread') replacement.requiredFeatures = [...THREAD_REQUIRED_FEATURES];
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
      if (
        !thread ||
        (input.expectedRevision === 0 &&
          (record.id !== terminalTurnId || !terminalWasSealed) &&
          thread.record.status !== 'active')
      )
        throw new ControlProductPreconditionError();
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
          (record.id !== terminalTurnId &&
            (session.record.status === 'closed' || session.record.status === 'failed'))
        )
          throw new ControlProductPreconditionError();
      }
    }
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
    if (
      !turn ||
      JSON.parse(entry.identityJson).threadId !== turn.record.threadId ||
      (input.turnId !== terminalTurnId &&
        !['pending', 'running'].includes(String(turn.record.status)))
    )
      throw new ControlProductPreconditionError();
    if (input.turnId === terminalTurnId) {
      const replay = sqlite
        .prepare(
          'SELECT id,revision,content_json,identity_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=?'
        )
        .get(input.kind, input.turnId, input.sequence) as
        | { id: string; revision: number; content_json: string; identity_json: string }
        | undefined;
      if (replay) {
        if (
          replay.id !== entry.id ||
          replay.revision !== input.expectedRevision + 1 ||
          replay.identity_json !== entry.identityJson ||
          !isDeepStrictEqual(JSON.parse(replay.content_json), input.content)
        )
          throw new ControlProductPreconditionError();
        continue;
      }
    }
    if (
      input.turnId === terminalTurnId &&
      terminalWasSealed &&
      sqlite
        .prepare('SELECT 1 FROM control_product_entries WHERE kind=? AND id=?')
        .get(input.kind, entry.id)
    )
      throw new ControlProductPreconditionError();
    appendProductEntry(sqlite, entry);
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

/** Appends an already-admitted immutable reference with the original identity, revision and sequence CAS. */
function appendProductEntry(sqlite: Database.Database, entry: PreparedControlEntry): void {
  const input = entry.input;
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

/** Verifies and synchronizes actual immutable bytes BEFORE SQL; no boolean durability claim is accepted. */
export async function prepareControlEntries(
  owner: ControlProductOwner,
  contentMount: ControlProductContentMount | undefined,
  entries: readonly ControlProductEntry[],
  newDirectories?: ControlContentPreparation
): Promise<PreparedControlEntry[]> {
  return prepareEntries(owner, contentMount, entries, undefined, undefined, newDirectories);
}

/** Reads exact committed dependencies without repeating their first-publication sync; SQL must still recheck their descriptors. */
export async function prepareRetainedControlEntries(
  db: CoreDb | WorkspaceDb,
  mount: ControlProductContentMount | undefined,
  entries: readonly ControlProductEntry[],
  terminal?: Record<string, unknown>,
  sealedTurn?: Record<string, unknown>
): Promise<PreparedControlEntry[]> {
  if (isMainThread || db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const owner: ControlProductOwner =
    db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId };
  const rows = entries.map((entry) => {
    const row = db.sqlite
      .prepare(
        'SELECT id,schema_version,content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=? AND revision=?'
      )
      .get(entry.kind, entry.turnId, entry.sequence, entry.expectedRevision + 1) as
      | { id: string; schema_version: number; content_json: string }
      | undefined;
    if (
      !row ||
      row.schema_version !== 1 ||
      !isDeepStrictEqual(
        ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
        entry.content
      )
    )
      throw new ControlProductPreconditionError();
    return row;
  });
  const prepared = await prepareEntries(owner, mount, entries, terminal, sealedTurn, null);
  if (prepared.some((entry, index) => entry.id !== rows[index]!.id))
    throw new ControlProductPreconditionError();
  return prepared;
}

/** Verifies one actual inode before either first publication or SQL-proved reuse. */
async function readControlContentFile(file: FileHandle, content: StorageContent): Promise<Buffer> {
  const metadata = await file.stat();
  if (!metadata.isFile() || metadata.size !== content.byteLength)
    throw new ControlProductPreconditionError();
  const bytes = Buffer.alloc(content.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!read.bytesRead) throw new ControlProductPreconditionError();
    offset += read.bytesRead;
  }
  if (
    (await file.stat()).size !== content.byteLength ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== content.reference.contentDigest
  )
    throw new ControlProductPreconditionError();
  return bytes;
}

/** An existing canonical name is reusable only when this database proves its completed descriptor. */
async function hasCommittedControlContent(
  db: CoreDb | WorkspaceDb | undefined,
  entry: ControlProductEntry,
  bytes: Buffer
): Promise<boolean> {
  if (!db) return false;
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const id =
    entry.kind === 'item'
      ? readRetainedV1(value, () => StoredItemV1Schema.parse(value)).id
      : `${entry.turnId}:${entry.sequence}`;
  // Close each bounded indexed read before yielding; new canonical names never scan history.
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = db.sqlite
      .prepare(
        'SELECT revision,schema_version,content_json FROM control_product_entries WHERE kind=? AND id=? AND revision<=? ORDER BY revision DESC LIMIT ?'
      )
      .all(entry.kind, id, before, CONTROL_PRODUCT_LIMITS.pageRows) as {
      revision: number;
      schema_version: number;
      content_json: string;
    }[];
    for (const row of rows) {
      if (row.schema_version !== 1) throw new ControlProductPreconditionError();
      if (
        isDeepStrictEqual(
          ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
          entry.content
        )
      )
        return true;
    }
    if (rows.length < CONTROL_PRODUCT_LIMITS.pageRows) return false;
    before = rows.at(-1)!.revision - 1;
    await new Promise<void>((done) => setImmediate(done));
  }
}

/** Consumes only the digest-bound private basename; no Main flag can declare a completed barrier. */
async function preparePrivateControlContent(
  path: string,
  root: string,
  content: StorageContent,
  entry: ControlProductEntry,
  preparation: ControlContentPreparation
): Promise<Buffer> {
  const name = entry.publication!.temporary;
  if (!name.startsWith(`.${content.reference.contentDigest.slice('sha256:'.length)}.`))
    throw new ControlProductPreconditionError();
  const temporary = join(root, name);
  const retained = preparation.db?.sqlite
    .prepare(
      'SELECT schema_version,content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=? AND revision=?'
    )
    .get(entry.kind, entry.turnId, entry.sequence, entry.expectedRevision + 1) as
    | { schema_version: number; content_json: string }
    | undefined;
  if (
    retained &&
    retained.schema_version === 1 &&
    isDeepStrictEqual(
      ControlProductEntrySchema.shape.content.parse(JSON.parse(retained.content_json)),
      content
    )
  ) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await readControlContentFile(file, content);
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return bytes;
    } finally {
      await file.close();
    }
  }
  const staged = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await readControlContentFile(staged, content);
    let publication = preparation.publications.get(path);
    if (!publication) {
      const result = (async () => {
        let winner: FileHandle | undefined;
        try {
          winner = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (winner) {
          try {
            const bytes = await readControlContentFile(winner, content);
            if (await hasCommittedControlContent(preparation.db, entry, bytes))
              return { bytes, changedDirectory: false };
            await winner.sync();
            return { bytes, changedDirectory: true };
          } finally {
            await winner.close();
          }
        }
        // This owner alone publishes a new inode. Equal in-flight digests join this promise.
        await staged.sync();
        await link(temporary, path);
        return { bytes: await readControlContentFile(staged, content), changedDirectory: true };
      })();
      publication = { result, references: 0, directorySynchronized: false };
      preparation.publications.set(path, publication);
    }
    if (!preparation.published.has(path)) {
      preparation.published.add(path);
      publication.references += 1;
    }
    const result = await publication.result;
    if (result.changedDirectory && !publication.directorySynchronized)
      preparation.directories.add(dirname(path));
    await unlink(temporary);
    return result.bytes;
  } finally {
    await staged.close();
  }
}

/** Verifies scoped bytes; only native SQL-proved dependencies omit sync, and Worker cohorts may defer parent sync until their batch. */
async function synchronizeControlContent(
  owner: ControlProductOwner,
  contentMount: ControlProductContentMount | undefined,
  content: ControlProductEntry['content'],
  newDirectories?: ControlContentPreparation | null,
  entry?: ControlProductEntry
): Promise<Buffer> {
  if (isMainThread || !contentMount || content.byteLength > CONTROL_PRODUCT_LIMITS.payloadBytes)
    throw new ControlProductPreconditionError();
  const inline = inlineControlContentBytes(owner, content);
  if (inline) {
    if (entry?.publication) throw new ControlProductPreconditionError();
    return inline;
  }
  const reference = content.reference;
  if ('representation' in reference) throw new ControlProductPreconditionError();
  const fileContent = { ...content, reference };
  assertControlProductOwner(owner, reference.locator.ownerScope);
  if (
    reference.range !== null ||
    reference.availability !== 'available' ||
    reference.knowledgeBaseId !== contentMount.knowledgeBaseId ||
    reference.locator.mount !== contentMount.mount
  )
    throw new ControlProductPreconditionError();
  const root = await realpath(contentMount.root);
  const path = resolve(root, reference.locator.path);
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel) || (await realpath(dirname(path))) !== dirname(path))
    throw new ControlProductPreconditionError();
  if (entry?.publication && newDirectories !== null) {
    if (
      !newDirectories ||
      reference.locator.path !== `sha256/${reference.contentDigest.slice('sha256:'.length)}`
    )
      throw new ControlProductPreconditionError();
    return preparePrivateControlContent(path, root, fileContent, entry, newDirectories);
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    bytes = await readControlContentFile(fd, fileContent);
    if (newDirectories !== null) await fd.sync();
  } finally {
    await fd.close();
  }
  if (newDirectories === null) return bytes;
  if (newDirectories) {
    newDirectories.directories.add(dirname(path));
    return bytes;
  }
  const directory = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return bytes;
}

/** Reads and synchronizes immutable content before SQL; the terminal identity is private to complete preparation. */
async function prepareEntries(
  owner: ControlProductOwner,
  contentMount: ControlProductContentMount | undefined,
  entries: readonly ControlProductEntry[],
  terminal?: Record<string, unknown>,
  sealedTurn?: Record<string, unknown>,
  newDirectories?: ControlContentPreparation | null,
  retainedDb?: CoreDb | WorkspaceDb
): Promise<PreparedControlEntry[]> {
  if (isMainThread) throw new ControlProductPreconditionError();
  const result: PreparedControlEntry[] = [];
  const prepare = async (input: ControlProductEntry): Promise<PreparedControlEntry> => {
    if (
      sealedTurn &&
      retainedDb &&
      retainedDb.sqlite
        .prepare(
          'SELECT 1 FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=? AND revision=?'
        )
        .get(input.kind, input.turnId, input.sequence, input.expectedRevision + 1)
    )
      return (
        await prepareRetainedControlEntries(retainedDb, contentMount, [input], terminal, sealedTurn)
      )[0]!;
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await synchronizeControlContent(owner, contentMount, input.content, newDirectories, input)
      )
    );
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
      const prepared = { input, id: item.id, identityJson: JSON.stringify(identity) };
      preparedPayloads.set(prepared, item);
      preparedOriginals.set(prepared, value);
      return prepared;
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
    const terminalEvent =
      data.type === 'turn-completed' ||
      ('turn' in data && data.turn.status !== 'pending' && data.turn.status !== 'running') ||
      (data.type === 'turn-started' && data.status !== 'pending' && data.status !== 'running');
    if (
      terminalEvent &&
      (!terminal ||
        terminal.id !== input.turnId ||
        !('turn' in data) ||
        data.turn.status !== terminal.status ||
        !terminalSnapshotFieldMatches('error', data.turn.error, terminal.error, sealedTurn) ||
        !terminalSnapshotFieldMatches(
          'completedAt',
          data.turn.completedAt,
          terminal.completedAt,
          sealedTurn
        ) ||
        (data.type === 'turn-completed' &&
          !terminalStopReasonMatches(data.stopReason, terminal.status)))
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
    const prepared = {
      input,
      id: `${input.turnId}:${event.sequence}`,
      identityJson: JSON.stringify({ threadId: event.threadId, turnId: input.turnId }),
      referencedItemIds: [...referencedItemIds],
    };
    preparedPayloads.set(prepared, event);
    preparedOriginals.set(prepared, value);
    return prepared;
  };
  for (let offset = 0; offset < entries.length; offset += 4) {
    const cohort = await Promise.allSettled(entries.slice(offset, offset + 4).map(prepare));
    const failure = cohort.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
    for (const entry of cohort) if (entry.status === 'fulfilled') result.push(entry.value);
  }
  return result;
}

/** Closed existing Item/event admissions; each category keeps its accepted equality rule. */
export const ControlPublicationInputSchema = z
  .object({
    category: z.enum([
      'already-decided-publication',
      'display-projection-refresh',
      'configuration-apply-pending-delayed-user-input',
    ]),
    turnId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    entries: z.array(ControlProductEntrySchema).min(1).max(CONTROL_PRODUCT_LIMITS.entries),
  })
  .strict();
/** Entry-only publication; no metadata or outcome mutation is admitted. */
export type ControlPublicationInput = z.infer<typeof ControlPublicationInputSchema>;

/** Complete addressed Item intent; heads and durable bytes are resolved by the native owner. */
export const ControlItemAppendSchema = z
  .object({
    item: ItemSchema,
    category: ControlPublicationInputSchema.shape.category.optional(),
  })
  .strict();
export type ControlItemAppend = z.infer<typeof ControlItemAppendSchema>;

/** Carries an existing Store validation refusal, never a native SQL or filesystem diagnostic. */
export class ControlItemAppendError extends Error {}

/** Shares original Item identity, human attribution and post-terminal rules between native and in-memory Stores. */
export function checkControlItemAppend(
  item: z.infer<typeof ItemSchema>,
  turn: Pick<
    z.infer<typeof StoredTurnV1Schema>,
    'id' | 'status' | 'threadId' | 'triggerActor' | 'owner'
  >,
  previous: z.infer<typeof ItemSchema> | undefined,
  stored: readonly z.infer<typeof ItemSchema>[],
  category?: ControlItemAppend['category']
): boolean {
  if (
    !isDeepStrictEqual(item.owner, turn.owner) ||
    item.threadId !== turn.threadId ||
    item.turnId !== turn.id
  )
    throw new ControlItemAppendError(`Item has invalid turn lineage: ${item.id}`);
  const sealed = !['pending', 'running'].includes(turn.status);
  if (
    item.type === 'user-input-request' &&
    item.responsibleUserId !== responsibleUserIdForActor(turn.triggerActor)
  )
    throw new ControlItemAppendError(`User-input request has invalid responsible user: ${item.id}`);
  if (item.type === 'user-input-response') {
    const request = stored.find(
      (value) =>
        value.type === 'user-input-request' && value.userInputRequestId === item.userInputRequestId
    );
    if (request?.type === 'user-input-request' && request.responsibleUserId !== item.actor.id)
      throw new ControlItemAppendError(
        `User-input response has invalid responsible user: ${item.id}`
      );
  }
  if (sealed && previous && isDeepStrictEqual(previous, item)) return true;
  if (
    sealed &&
    (previous ||
      !(
        category === 'already-decided-publication' ||
        category === 'configuration-apply-pending-delayed-user-input' ||
        (category === 'display-projection-refresh' && item.type === 'status')
      ))
  )
    throw new ControlItemAppendError(
      previous
        ? `Turn ${item.turnId} is terminal and the publication conflicts with the already-decided record.`
        : `Turn ${item.turnId} is terminal and does not admit this write.`
    );
  if (previous) {
    if (
      !isDeepStrictEqual(previous.owner, item.owner) ||
      previous.threadId !== item.threadId ||
      previous.turnId !== item.turnId ||
      previous.type !== item.type ||
      previous.createdAt !== item.createdAt
    )
      throw new ControlItemAppendError(`Item immutable identity cannot change: ${item.id}`);
    try {
      assertImmutableItemAttribution(previous, item);
    } catch {
      throw new ControlItemAppendError(`Item attribution cannot change: ${item.id}.`);
    }
  }
  return false;
}

/** Verifies the existing Item revision log before a sealed replay can use its history. */
async function readControlItemHistory(
  db: WorkspaceDb,
  mount: ControlProductContentMount | undefined,
  turn: z.infer<typeof StoredTurnV1Schema>,
  rows: {
    id: string;
    turn_id: string;
    sequence: number;
    revision: number;
    schema_version: number;
    content_json: string;
  }[],
  fullHistory: boolean
) {
  const owner: ControlProductOwner = { kind: 'workspace', workspaceId: db.workspaceId };
  const items = new Map<string, z.infer<typeof ItemSchema>>();
  const revisions = new Map<string, number>();
  let previousSequence = 0;
  for (const row of rows) {
    if (row.schema_version !== 1 || (fullHistory && row.sequence !== previousSequence + 1))
      throw new ControlProductPreconditionError();
    previousSequence = row.sequence;
    const [entry] = await prepareRetainedControlEntries(db, mount, [
      {
        kind: 'item',
        turnId: row.turn_id,
        sequence: row.sequence,
        expectedRevision: row.revision - 1,
        content: ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
      },
    ]);
    if (!entry) throw new ControlProductPreconditionError();
    const { schemaVersion: _version, ...raw } = preparedOriginals.get(entry) as Record<
      string,
      unknown
    >;
    if (
      raw.requiredFeatures !== undefined &&
      (!Array.isArray(raw.requiredFeatures) || raw.requiredFeatures.length > 0)
    )
      throw new ControlProductPreconditionError();
    const parsed = StoredItemPayloadV1Schema.parse(raw);
    if (
      parsed.turnId !== turn.id ||
      parsed.threadId !== turn.threadId ||
      parsed.id !== row.id ||
      entry.id !== row.id ||
      (fullHistory && row.revision !== (revisions.get(row.id) ?? 0) + 1) ||
      !isDeepStrictEqual(parsed.owner, owner)
    )
      throw new ControlProductPreconditionError();
    const preceding = items.get(row.id);
    if (preceding && (preceding.type !== parsed.type || preceding.createdAt !== parsed.createdAt))
      throw new ControlProductPreconditionError();
    if (preceding) assertImmutableItemAttribution(preceding, parsed);
    if (
      fullHistory &&
      parsed.type === 'user-input-request' &&
      parsed.responsibleUserId !== responsibleUserIdForActor(turn.triggerActor)
    )
      throw new ControlProductPreconditionError();
    if (fullHistory && parsed.type === 'user-input-response') {
      const request = [...items.values()].find(
        (value) =>
          value.type === 'user-input-request' &&
          value.userInputRequestId === parsed.userInputRequestId
      );
      if (request?.type === 'user-input-request' && request.responsibleUserId !== parsed.actor.id)
        throw new ControlProductPreconditionError();
    }
    items.set(row.id, preserveDescriptiveRecord(raw, parsed, parsed) as z.infer<typeof ItemSchema>);
    revisions.set(row.id, row.revision);
  }
  return [...items.values()];
}

/** Selects the addressed retained head for both Item revision and event dependency validation. */
function readControlItemHead(db: WorkspaceDb, item: { id: string }) {
  return db.sqlite
    .prepare(
      "SELECT id,turn_id,sequence,revision,schema_version,content_json FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
    )
    .get(item.id) as Parameters<typeof readControlItemHistory>[3][number] | undefined;
}

/** Resolves current native heads and original Item bytes before preparation, without a Main read round trip. */
export async function prepareControlItemAppend(
  db: WorkspaceDb,
  input: ControlItemAppend,
  mount: ControlProductContentMount | undefined
) {
  if (isMainThread || db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const item = ItemSchema.parse(input.item);
  const owner: ControlProductOwner = { kind: 'workspace', workspaceId: db.workspaceId };
  assertControlProductOwner(owner, item.owner);
  const head = readProduct(db.sqlite, owner, 'turn', item.turnId);
  if (!head) throw new ControlProductPreconditionError();
  const turn = StoredTurnV1Schema.parse(head.record);
  const sealed = !['pending', 'running'].includes(String(head.record.status));
  const prior = readControlItemHead(db, item);
  if (prior && prior.turn_id !== item.turnId)
    throw new ControlItemAppendError(`Item already exists: ${item.id}`);
  const rows =
    item.type === 'user-input-response' || (sealed && prior)
      ? (db.sqlite
          .prepare(
            "SELECT id,turn_id,sequence,revision,schema_version,content_json FROM control_product_entries WHERE kind='item' AND turn_id=? ORDER BY sequence"
          )
          .all(item.turnId) as NonNullable<typeof prior>[])
      : prior
        ? [prior]
        : [];
  const stored = await readControlItemHistory(
    db,
    mount,
    turn,
    rows,
    item.type === 'user-input-response' || (sealed && prior !== undefined)
  );
  const previous = stored.find((value) => value.id === item.id);
  if (checkControlItemAppend(item, turn, previous, stored, input.category))
    return { item: previous!, head, sequence: 0, revision: prior!.revision, replay: true };
  const sequence =
    (
      db.sqlite
        .prepare(
          "SELECT max(sequence) AS sequence FROM control_product_entries WHERE kind='item' AND turn_id=?"
        )
        .get(item.turnId) as { sequence: number | null }
    ).sequence ?? 0;
  return {
    item: previous
      ? (preserveDescriptiveRecord(
          previous,
          StoredItemPayloadV1Schema.parse(previous),
          item
        ) as z.infer<typeof ItemSchema>)
      : item,
    head,
    sequence: sequence + 1,
    revision: prior?.revision ?? 0,
    replay: false,
  };
}
/** Complete event intent; native preparation owns its sequence and retained dependencies. */
export const ControlEventAppendSchema = z
  .object({
    turnId: z.string().min(1),
    event: SseEventEnvelopeSchema.omit({ protocolVersion: true, sequence: true, timestamp: true }),
    timestamp: SseEventEnvelopeSchema.shape.timestamp,
    category: ControlPublicationInputSchema.shape.category.optional(),
  })
  .strict();
export type ControlEventAppend = z.infer<typeof ControlEventAppendSchema>;
/** Acknowledged event envelope, including its native allocated sequence. */
export type ControlEventAppendResult = z.infer<typeof SseEventEnvelopeSchema>;
type EventTurn = Pick<
  z.infer<typeof StoredTurnV1Schema>,
  'id' | 'owner' | 'threadId' | 'status' | 'error'
>;

/**
 * Returns whether an event payload is the sealed Turn's missing terminal publication.
 *
 * @param turn Sealed Turn.
 * @param event Candidate event input.
 * @returns True when the event publishes that Turn's sealed outcome, not merely names it.
 */
export function eventAgreesWithSealedTurnOutcome(
  turn: EventTurn,
  event: Pick<ControlEventAppend['event'], 'data'>
): boolean {
  const data = event.data as {
    type?: unknown;
    stopReason?: unknown;
    turn?: {
      id?: unknown;
      owner?: unknown;
      threadId?: unknown;
      status?: unknown;
      error?: unknown;
    };
  };
  if (data.type !== 'turn-completed' && data.type !== 'turn-updated') {
    return false;
  }
  const carried = data.turn;
  if (!carried || typeof carried !== 'object') {
    return false;
  }
  const owner = WorkOwnerSchema.safeParse(carried.owner);
  if (
    !owner.success ||
    !isDeepStrictEqual(owner.data, turn.owner) ||
    carried.id !== turn.id ||
    carried.threadId !== turn.threadId ||
    carried.status !== turn.status
  ) {
    return false;
  }
  if (
    carried.error !== undefined &&
    !isDeepStrictEqual(carried.error ?? null, turn.error ?? null)
  ) {
    return false;
  }
  if (data.stopReason !== undefined && !terminalStopReasonMatches(data.stopReason, turn.status)) {
    return false;
  }
  return true;
}

/**
 * Returns whether an event payload names this Turn but disagrees with its decided outcome.
 *
 * @param turn Sealed Turn.
 * @param event Candidate event input.
 * @returns True when the event identifies this Turn and contradicts its sealed status, error, or stopReason.
 */
export function eventConflictsWithSealedTurnOutcome(
  turn: EventTurn,
  event: Pick<ControlEventAppend['event'], 'data'>
): boolean {
  const data = event.data as {
    stopReason?: unknown;
    turn?: { id?: unknown; status?: unknown; error?: unknown };
  };
  const carried = data.turn;
  if (!carried || typeof carried !== 'object' || carried.id !== turn.id) {
    return false;
  }
  if (carried.status !== undefined && carried.status !== turn.status) {
    return true;
  }
  if (
    carried.error !== undefined &&
    !isDeepStrictEqual(carried.error ?? null, turn.error ?? null)
  ) {
    return true;
  }
  if (data.stopReason !== undefined && !terminalStopReasonMatches(data.stopReason, turn.status)) {
    return true;
  }
  return false;
}

/** Resolves event replay, current lineage and sequence from the owning database before SQL. */
export async function prepareControlEventAppend(
  db: WorkspaceDb,
  input: ControlEventAppend,
  mount: ControlProductContentMount | undefined
) {
  if (isMainThread || db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const owner: ControlProductOwner = { kind: 'workspace', workspaceId: db.workspaceId };
  const head = readProduct(db.sqlite, owner, 'turn', input.turnId);
  if (!head) throw new ControlProductPreconditionError();
  const turn = StoredTurnV1Schema.parse(head.record);
  const sealed = !['pending', 'running'].includes(turn.status);
  const census = db.sqlite
    .prepare(
      "SELECT count(*) AS count,max(sequence) AS sequence FROM control_product_entries WHERE kind='event' AND turn_id=?"
    )
    .get(input.turnId) as { count: number; sequence: number | null };
  if (sealed) {
    const items = await readControlItemHistory(
      db,
      mount,
      turn,
      db.sqlite
        .prepare(
          "SELECT id,turn_id,sequence,revision,schema_version,content_json FROM control_product_entries WHERE kind='item' AND turn_id=? ORDER BY sequence"
        )
        .all(input.turnId) as Parameters<typeof readControlItemHistory>[3],
      true
    );
    const itemIds = new Set(items.map((item) => item.id));
    let replay: z.infer<typeof SseEventEnvelopeSchema> | undefined;
    let sequence = 0;
    while (sequence < (census.sequence ?? 0)) {
      const rows = db.sqlite
        .prepare(
          "SELECT sequence,revision,schema_version,content_json FROM control_product_entries WHERE kind='event' AND turn_id=? AND sequence>? ORDER BY sequence LIMIT ?"
        )
        .all(input.turnId, sequence, CONTROL_PRODUCT_LIMITS.pageRows) as {
        sequence: number;
        revision: number;
        schema_version: number;
        content_json: string;
      }[];
      if (!rows.length) throw new ControlProductPreconditionError();
      for (const row of rows) {
        if (row.sequence !== sequence + 1 || row.revision !== 1 || row.schema_version !== 1)
          throw new ControlProductPreconditionError();
        sequence = row.sequence;
        const [entry] = await prepareRetainedControlEntries(
          db,
          mount,
          [
            {
              kind: 'event',
              turnId: input.turnId,
              sequence,
              expectedRevision: 0,
              content: ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
            },
          ],
          turn,
          turn
        );
        if (!entry) throw new ControlProductPreconditionError();
        const { schemaVersion: _version, ...raw } = preparedOriginals.get(entry) as Record<
          string,
          unknown
        >;
        const recorded = StoredEventV1Schema.parse({ schemaVersion: 1, ...raw });
        if (recorded.threadId !== turn.threadId) throw new ControlProductPreconditionError();
        const { schemaVersion: _recordVersion, ...event } = recorded;
        assertTurnEventPayloadLineage(event, db.workspaceId, turn.threadId, turn.id, itemIds);
        if (
          event.event === input.event.event &&
          event.workspaceId === input.event.workspaceId &&
          event.threadId === input.event.threadId &&
          event.turnId === input.event.turnId &&
          event.requestId === input.event.requestId &&
          isDeepStrictEqual(event.data, input.event.data)
        )
          replay = preserveDescriptiveRecord(raw, event, event) as z.infer<
            typeof SseEventEnvelopeSchema
          >;
      }
    }
    if (census.count !== sequence) throw new ControlProductPreconditionError();
    if (replay) return { event: replay, head, replay: true };
    if (eventConflictsWithSealedTurnOutcome(turn, input.event))
      throw new ControlItemAppendError(
        `Turn ${turn.id} is terminal and the publication conflicts with the already-decided record.`
      );
    if (
      input.category !== 'already-decided-publication' &&
      !eventAgreesWithSealedTurnOutcome(turn, input.event)
    )
      throw new ControlItemAppendError(
        `Turn ${turn.id} is terminal and does not admit this write.`
      );
  }
  const event = SseEventEnvelopeSchema.parse({
    ...input.event,
    protocolVersion: PROTOCOL_VERSION,
    sequence: (census.sequence ?? 0) + 1,
    timestamp: input.timestamp,
  });
  if (
    event.workspaceId !== db.workspaceId ||
    event.threadId !== turn.threadId ||
    event.turnId !== turn.id
  )
    throw new ControlItemAppendError(
      `Turn event ${event.event} has invalid lineage for ${input.turnId}.`
    );
  const addressedItem =
    'item' in event.data
      ? event.data.item
      : 'itemId' in event.data
        ? { id: event.data.itemId }
        : undefined;
  if (!sealed && addressedItem) {
    const prior = readControlItemHead(db, addressedItem);
    // Contract Evolution: an ID witness cannot replace validation of required retained semantics.
    if (prior) await readControlItemHistory(db, mount, turn, [prior], false);
  }
  const ids = db.sqlite
    .prepare("SELECT DISTINCT id FROM control_product_entries WHERE kind='item' AND turn_id=?")
    .all(input.turnId) as { id: string }[];
  assertTurnEventPayloadLineage(
    event,
    db.workspaceId,
    turn.threadId,
    turn.id,
    new Set(ids.map((row) => row.id))
  );
  return { event, head, replay: false };
}
/** Native-local proof; immutable preparation cannot be supplied over the wire. */
export interface PreparedControlPublication {
  readonly turnId: string;
}
const publicationPreparations = new WeakMap<
  PreparedControlPublication,
  {
    sqlite: Database.Database;
    input: ControlPublicationInput;
    owner: ControlProductOwner;
    entries: PreparedControlEntry[];
    dependencies: { entry: PreparedControlEntry; revision: number; contentJson: string }[];
    eventCensus: { count: number; sequence: number | null };
    hasCompletion: boolean;
  }
>();

/** Verifies entry bytes and retained Item dependencies before the deciding savepoint. */
export async function prepareControlPublication(
  db: CoreDb | WorkspaceDb,
  value: ControlPublicationInput,
  mount: ControlProductContentMount | undefined,
  newDirectories?: ControlContentPreparation
): Promise<PreparedControlPublication> {
  if (isMainThread || db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const input = ControlPublicationInputSchema.parse(value);
  const owner: ControlProductOwner =
    db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId };
  terminalOwner(db, owner);
  const turn = readProduct(db.sqlite, owner, 'turn', input.turnId);
  if (
    !turn ||
    turn.revision !== input.expectedRevision ||
    ['pending', 'running'].includes(String(turn.record.status))
  )
    throw new ControlProductPreconditionError();
  const entries = await prepareEntries(
    owner,
    mount,
    input.entries,
    turn.record,
    turn.record,
    newDirectories
  );
  if (entries.some((entry) => entry.input.turnId !== input.turnId))
    throw new ControlProductPreconditionError();
  const ids = new Set(
    entries.filter((entry) => entry.input.kind === 'item').map((entry) => entry.id)
  );
  for (const entry of entries) for (const id of entry.referencedItemIds ?? []) ids.add(id);
  const hasSnapshot = entries.some(
    (entry) =>
      entry.input.kind === 'event' &&
      'turn' in (preparedPayloads.get(entry) as { data: Record<string, unknown> }).data
  );
  if (hasSnapshot) {
    const rows = db.sqlite
      .prepare("SELECT DISTINCT id FROM control_product_entries WHERE kind='item' AND turn_id=?")
      .all(input.turnId) as { id: string }[];
    for (const row of rows) ids.add(row.id);
  }
  const dependencies: { entry: PreparedControlEntry; revision: number; contentJson: string }[] = [];
  for (const id of ids) {
    const row = db.sqlite
      .prepare(
        "SELECT turn_id,sequence,revision,schema_version,content_json FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(id) as
      | {
          turn_id: string;
          sequence: number;
          revision: number;
          schema_version: number;
          content_json: string;
        }
      | undefined;
    if (!row) continue;
    if (row.turn_id !== input.turnId || row.schema_version !== 1 || row.revision < 1)
      throw new ControlProductPreconditionError();
    const [entry] = await prepareRetainedControlEntries(
      db,
      mount,
      [
        {
          kind: 'item',
          turnId: row.turn_id,
          sequence: row.sequence,
          expectedRevision: row.revision - 1,
          content: ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
        },
      ],
      turn.record,
      turn.record
    );
    if (!entry || entry.id !== id) throw new ControlProductPreconditionError();
    dependencies.push({ entry, revision: row.revision, contentJson: row.content_json });
  }
  const eventCensus = db.sqlite
    .prepare(
      "SELECT count(*) AS count,max(sequence) AS sequence FROM control_product_entries WHERE kind='event' AND turn_id=?"
    )
    .get(input.turnId) as { count: number; sequence: number | null };
  let hasCompletion = false;
  if (
    entries.some(
      (entry) =>
        entry.input.kind === 'event' &&
        (preparedPayloads.get(entry) as { data: { type: string } }).data.type === 'turn-completed'
    )
  ) {
    // End each bounded read before I/O; SQL rechecks this finite immutable sequence census.
    let sequence = 0;
    while (!hasCompletion && sequence < (eventCensus.sequence ?? 0)) {
      const rows = db.sqlite
        .prepare(
          "SELECT sequence,schema_version,content_json FROM control_product_entries WHERE kind='event' AND turn_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?"
        )
        .all(input.turnId, sequence, eventCensus.sequence, CONTROL_PRODUCT_LIMITS.entries) as {
        sequence: number;
        schema_version: number;
        content_json: string;
      }[];
      if (!rows.length) break;
      for (const row of rows) {
        sequence = row.sequence;
        if (row.schema_version !== 1) throw new ControlProductPreconditionError();
        // This bounded completed SQL read proves the descriptor's earlier durable publication.
        const bytes = await synchronizeControlContent(
          owner,
          mount,
          ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
          null
        );
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const event = readRetainedV1(value, () =>
          owner.kind === 'server'
            ? StoredServerEventV1Schema.parse(value)
            : StoredEventV1Schema.parse(value)
        );
        if (event.data.type === 'turn-completed') {
          hasCompletion = true;
          break;
        }
      }
    }
  }
  const token = Object.freeze({ turnId: input.turnId });
  publicationPreparations.set(token, {
    sqlite: db.sqlite,
    input: structuredClone(input),
    owner,
    entries,
    dependencies,
    eventCensus,
    hasCompletion,
  });
  return token;
}

/** Removes only the retained envelope marker when comparing a public Item projection. */
function publicationItemPayload(entry: PreparedControlEntry): Record<string, unknown> {
  const original = preparedOriginals.get(entry) as Record<string, unknown> | undefined;
  if (!original) throw new ControlProductPreconditionError();
  const { schemaVersion: _schemaVersion, ...payload } = original;
  return payload;
}

/** Applies only admitted references against the actual sealed Turn, without reopening or changing its decided tuple. */
export function applyControlPublication(
  db: CoreDb | WorkspaceDb,
  value: ControlPublicationInput,
  prepared: PreparedControlPublication
): void {
  assertControlProductWriter(db.sqlite);
  const input = ControlPublicationInputSchema.parse(value);
  const proof = publicationPreparations.get(prepared);
  if (!proof || proof.sqlite !== db.sqlite || !isDeepStrictEqual(proof.input, input))
    throw new ControlProductPreconditionError();
  terminalOwner(db, proof.owner);
  const turn = readProduct(db.sqlite, proof.owner, 'turn', input.turnId);
  if (
    !turn ||
    turn.revision !== input.expectedRevision ||
    ['pending', 'running'].includes(String(turn.record.status))
  )
    throw new ControlProductPreconditionError();
  const census = db.sqlite
    .prepare(
      "SELECT count(*) AS count,max(sequence) AS sequence FROM control_product_entries WHERE kind='event' AND turn_id=?"
    )
    .get(input.turnId);
  if (!isDeepStrictEqual(census, proof.eventCensus)) throw new ControlProductPreconditionError();
  const items = new Map<string, PreparedControlEntry>();
  for (const dependency of proof.dependencies) {
    const row = db.sqlite
      .prepare(
        "SELECT revision,content_json FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(dependency.entry.id) as { revision: number; content_json: string } | undefined;
    if (!row || row.revision !== dependency.revision || row.content_json !== dependency.contentJson)
      throw new ControlProductPreconditionError();
    items.set(dependency.entry.id, dependency.entry);
  }
  const writes: PreparedControlEntry[] = [];
  const seen = new Set<string>();
  for (const entry of proof.entries) {
    if (entry.input.kind !== 'item') continue;
    if (JSON.parse(entry.identityJson).threadId !== turn.record.threadId)
      throw new ControlProductPreconditionError();
    if (seen.has(entry.id)) throw new ControlProductPreconditionError();
    seen.add(entry.id);
    const before = items.get(entry.id);
    if (input.category === 'configuration-apply-pending-delayed-user-input' && before)
      throw new ControlProductPreconditionError();
    const next = publicationItemPayload(entry);
    if (input.category === 'display-projection-refresh' && next.type !== 'status')
      throw new ControlProductPreconditionError();
    if (before) {
      const exactReplay =
        entry.input.sequence === before.input.sequence &&
        entry.input.expectedRevision === before.input.expectedRevision &&
        isDeepStrictEqual(entry.input.content, before.input.content);
      if (input.category === 'already-decided-publication') {
        if (!exactReplay || !isDeepStrictEqual(publicationItemPayload(before), next))
          throw new ControlProductPreconditionError();
        continue;
      }
      const previous = publicationItemPayload(before);
      if (
        previous.type !== 'status' ||
        Object.keys({ ...previous, ...next }).some(
          (field) =>
            !['level', 'title', 'summary'].includes(field) &&
            !isDeepStrictEqual(previous[field], next[field])
        )
      )
        throw new ControlProductPreconditionError();
      if (exactReplay) continue;
      if (entry.input.expectedRevision !== before.input.expectedRevision + 1)
        throw new ControlProductPreconditionError();
      if (isDeepStrictEqual(previous, next)) continue;
    } else if (entry.input.expectedRevision !== 0) throw new ControlProductPreconditionError();
    items.set(entry.id, entry);
    writes.push(entry);
  }
  const existingIds = (
    db.sqlite
      .prepare(
        "SELECT id,min(sequence) AS sequence FROM control_product_entries WHERE kind='item' AND turn_id=? GROUP BY id ORDER BY sequence"
      )
      .all(input.turnId) as { id: string; sequence: number }[]
  ).map((row) => row.id);
  const orderedIds = [
    ...existingIds,
    ...writes
      .filter((entry) => !existingIds.includes(entry.id))
      .sort((a, b) => a.input.sequence - b.input.sequence)
      .map((entry) => entry.id),
  ];
  let newCompletion = false;
  const sessionProjections = new Map<string, ReturnType<typeof readProduct>>();
  for (const entry of proof.entries) {
    if (entry.input.kind !== 'event') continue;
    if (input.category !== 'already-decided-publication')
      throw new ControlProductPreconditionError();
    const recorded = db.sqlite
      .prepare(
        "SELECT id,revision,content_json,identity_json FROM control_product_entries WHERE kind='event' AND turn_id=? AND sequence=?"
      )
      .get(input.turnId, entry.input.sequence) as
      | { id: string; revision: number; content_json: string; identity_json: string }
      | undefined;
    if (recorded) {
      if (
        recorded.id !== entry.id ||
        recorded.revision !== entry.input.expectedRevision + 1 ||
        recorded.identity_json !== entry.identityJson ||
        !isDeepStrictEqual(JSON.parse(recorded.content_json), entry.input.content)
      )
        throw new ControlProductPreconditionError();
      continue;
    }
    const event = preparedOriginals.get(entry) as { data: Record<string, unknown> };
    const data = event.data;
    if (
      (data.type === 'item-created' || data.type === 'item-completed') &&
      data.item &&
      typeof data.item === 'object'
    ) {
      const item = data.item as Record<string, unknown>;
      const actual = items.get(String(item.id));
      if (
        !actual ||
        !isDeepStrictEqual(item, publicationItemPayload(actual)) ||
        (data.type === 'item-completed' && data.itemId !== item.id)
      )
        throw new ControlProductPreconditionError();
    } else if (
      (data.type === 'turn-completed' || data.type === 'turn-updated') &&
      data.turn &&
      typeof data.turn === 'object'
    ) {
      const snapshot = data.turn as Record<string, unknown> & { items: Record<string, unknown>[] };
      if (
        !isDeepStrictEqual(
          StoredTurnSnapshotV1Schema.parse({ ...snapshot, items: [] }),
          StoredTurnSnapshotV1Schema.parse({ ...turn.record, items: [] })
        ) ||
        !isDeepStrictEqual(
          snapshot.items.map((item) => item.id),
          orderedIds
        ) ||
        snapshot.items.some(
          (item) =>
            !items.has(String(item.id)) ||
            !isDeepStrictEqual(item, publicationItemPayload(items.get(String(item.id))!))
        )
      )
        throw new ControlProductPreconditionError();
      if (data.type === 'turn-completed') {
        if (proof.hasCompletion || newCompletion) throw new ControlProductPreconditionError();
        newCompletion = true;
      }
    } else if (
      data.type === 'agent-session-updated' &&
      data.agentSession &&
      typeof data.agentSession === 'object'
    ) {
      const snapshot = data.agentSession as Record<string, unknown>;
      const session = readProduct(db.sqlite, proof.owner, 'agent-session', String(snapshot.id));
      if (
        proof.owner.kind !== 'workspace' ||
        !session ||
        session.record.workspaceId !== proof.owner.workspaceId ||
        session.record.threadId !== turn.record.threadId ||
        !isDeepStrictEqual(
          StoredEventV1Schema.parse({
            ...(preparedPayloads.get(entry) as object),
            data: { ...data, agentSession: session.record },
          }).data,
          data
        )
      )
        throw new ControlProductPreconditionError();
      sessionProjections.set(String(snapshot.id), session);
    } else throw new ControlProductPreconditionError();
    writes.push(entry);
  }
  if (input.category !== 'display-projection-refresh')
    applyProducts(db.sqlite, proof.owner, [], writes, input.turnId);
  else for (const entry of writes) appendProductEntry(db.sqlite, entry);
  // Session notifications publish the actual same-Thread native projection and cannot move it through a trigger.
  for (const [id, session] of sessionProjections)
    if (!isDeepStrictEqual(readProduct(db.sqlite, proof.owner, 'agent-session', id), session))
      throw new ControlProductPreconditionError();
  // The decided tuple must still name the verified bytes after every local SQL effect.
  const written = new Set(
    writes.filter((entry) => entry.input.kind === 'item').map((entry) => entry.id)
  );
  for (const entry of [
    ...proof.dependencies
      .filter((dependency) => !written.has(dependency.entry.id))
      .map((dependency) => dependency.entry),
    ...writes,
  ]) {
    const row = db.sqlite
      .prepare(
        'SELECT revision,content_json FROM control_product_entries WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1'
      )
      .get(entry.input.kind, entry.id) as { revision: number; content_json: string } | undefined;
    if (
      !row ||
      row.revision !== entry.input.expectedRevision + 1 ||
      !isDeepStrictEqual(JSON.parse(row.content_json), entry.input.content)
    )
      throw new ControlProductPreconditionError();
  }
}

/** Closed original command partitions whose terminal publication can own their receipt. */
const terminalReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'conversation.submit',
      'task.start',
      'turn.start',
      'turn.input.submit',
      'turn.interrupt',
      'knowledge.tell',
      'knowledge.maintain',
      'knowledge.server.tell',
      'knowledge.server.maintain',
    ] satisfies readonly CommandRequestName[]),
    requestId: RequestIdSchema,
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    response: z
      .object({
        kind: z.string().min(1),
        id: z.string().min(1),
        conversationMetadata: z.unknown().optional(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

const terminalCommandSchema = z
  .object({
    receipt: terminalReceiptSchema,
    audit: AuditEventSchema.extend({
      createdAt: z.string().datetime(),
      occurredAt: z.string().datetime(),
    }),
  })
  .strict();

/** Complete local terminal tuple. Null execution means no native execution, not proof of release. */
export const ControlTerminalTransitionSchema = z
  .object({
    owner: z.union([
      StoredWorkOwnerV1Schema.options[0].strict(),
      StoredWorkOwnerV1Schema.options[1].strict(),
    ]),
    turn: ControlProductMutationSchema.extend({ kind: z.literal('turn') }),
    products: z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries),
    entries: z.array(ControlProductEntrySchema).min(1).max(CONTROL_PRODUCT_LIMITS.entries),
    pending: z
      .array(z.lazy(() => ControlPendingCommandInputSchema))
      .max(CONTROL_PRODUCT_LIMITS.entries)
      .optional(),
    reap: z.object({ reason: z.string().min(1), inferredBy: z.string().min(1) }).strict(),
    evidence: z.array(StoredRuntimeEvidenceV1Schema).max(CONTROL_PRODUCT_LIMITS.entries),
    evidenceContent: z.array(fileContentSchema).max(CONTROL_PRODUCT_LIMITS.entries),
    command: terminalCommandSchema.nullable(),
    // Only the waiting internal Stop may converge with the original submission.
    interruptCommand: terminalCommandSchema
      .refine((command) => command.receipt.command === 'turn.interrupt')
      .optional(),
    execution: z
      .object({
        executionId: z.string().min(1),
        terminalStepId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
        cleanupStepId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** Parsed complete native terminal input; it carries facts and references, never executable callbacks. */
export type ControlTerminalTransition = z.infer<typeof ControlTerminalTransitionSchema>;

/** Native-local preparation token. It cannot be serialized or substituted with a transport descriptor. */
export interface PreparedControlTerminal {
  readonly turnId: string;
}
/** Bounded materialized facts; the caller must not publish them until its outer FULL COMMIT succeeds. */
export interface ControlTerminalResult {
  readonly turnId: string;
  readonly revision: number;
  readonly replayed: boolean;
  readonly reap: { readonly id: string; readonly sequence: number } | null;
  readonly response: CommandRequestResponse | null;
  readonly execution: {
    readonly executionId: string;
    readonly revision: number;
    readonly phase: 'closing' | 'closed';
  } | null;
}

// Load the existing domain owners during preparation to avoid their Store/admission import cycle.
// No import or asynchronous work occurs in the deciding body.
let terminalOwners:
  | {
      store: typeof import('../lib/store.js');
      requests: typeof import('./command-request-records.js');
      audit: typeof import('../audit-events.js');
      task: typeof import('../runtime/task-terminal-fact.js');
      evidence: typeof import('../runtime/runtime-evidence.js');
      observations: typeof import('./work-observations.js');
    }
  | undefined;

const terminalPreparations = new WeakMap<
  PreparedControlTerminal,
  {
    sqlite: Database.Database;
    input: ControlTerminalTransition;
    entries: PreparedControlEntry[];
    pending: PreparedControlPendingCommand | undefined;
    dependencies: { entry: PreparedControlEntry; contentJson: string; revision: number }[];
    evidenceBundles: { id: string; rowJson: string }[];
    executionSnapshot: { rootJson: string; terminalJson: string; cleanupJson: string } | null;
  }
>();

/** A sealed snapshot remains immutable when an absent field is later filled in canonical metadata. */
function terminalSnapshotFieldMatches(
  field: string,
  actual: unknown,
  expected: unknown,
  sealedTurn: Record<string, unknown> | undefined
): boolean {
  return (
    isDeepStrictEqual(actual, expected) ||
    (sealedTurn !== undefined && terminalFillableFields.has(field) && actual == null)
  );
}

/** Keeps the existing sealed outcome mapping, including bounded successful stopping conditions. */
function terminalStopReasonMatches(reason: unknown, status: unknown): boolean {
  if (status === 'completed')
    return ['completed', 'length', 'budget_exhausted'].includes(String(reason));
  if (status === 'failed') return reason === 'error';
  return (status === 'cancelled' || status === 'interrupted') && reason === 'aborted';
}

/** Resolves the physical SQL owner from the supplied same-connection domain handle. */
function terminalOwner(db: CoreDb | WorkspaceDb, owner: ControlProductOwner): void {
  assertControlProductOwner(
    db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId },
    owner
  );
  // Drizzle exposes the bound client. A sibling ORM must never join this tuple by implication.
  if (!('$client' in db.db) || db.db.$client !== db.sqlite)
    throw new ControlProductPreconditionError();
}

/** Synchronizes actual immutable terminal bodies and captures dependencies outside SQL, never on Main. */
export async function prepareControlTerminal(
  db: CoreDb | WorkspaceDb,
  value: ControlTerminalTransition,
  contentMount: ControlProductContentMount | undefined,
  newDirectories?: ControlContentPreparation
): Promise<PreparedControlTerminal> {
  if (isMainThread || db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  if (!terminalOwners) {
    const [store, requests, audit, task, evidence, observations] = await Promise.all([
      import('../lib/store.js'),
      import('./command-request-records.js'),
      import('../audit-events.js'),
      import('../runtime/task-terminal-fact.js'),
      import('../runtime/runtime-evidence.js'),
      import('./work-observations.js'),
    ]);
    terminalOwners = { store, requests, audit, task, evidence, observations };
  }
  if (db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const input = ControlTerminalTransitionSchema.parse(value);
  terminalOwner(db, input.owner);
  const turn = decode('turn', input.turn.record, input.owner);
  if (
    ['pending', 'running'].includes(String(turn.status)) ||
    !turn.completedAt ||
    input.products.some((product) => product.kind === 'turn') ||
    input.products.length + input.entries.length + 1 > CONTROL_PRODUCT_LIMITS.entries ||
    Buffer.byteLength(controlProductMetadataJson(input)) > CONTROL_PRODUCT_LIMITS.metadataBytes
  )
    throw new ControlProductPreconditionError();
  for (const content of input.evidenceContent)
    await synchronizeControlContent(input.owner, contentMount, content, newDirectories);
  const before = readProduct(db.sqlite, input.owner, 'turn', String(turn.id));
  const sealedTurn =
    before && !['pending', 'running'].includes(String(before.record.status))
      ? before.record
      : undefined;
  const entries = await prepareEntries(
    input.owner,
    contentMount,
    input.entries,
    turn,
    sealedTurn,
    newDirectories,
    db
  );
  if (entries.some((entry) => entry.input.turnId !== turn.id))
    throw new ControlProductPreconditionError();
  const terminalEvents = entries.filter((entry) => {
    const event = preparedPayloads.get(entry) as { data?: { type?: string } };
    return event.data?.type === 'turn-completed';
  });
  if (terminalEvents.length !== 1) throw new ControlProductPreconditionError();
  const snapshot = (
    preparedPayloads.get(terminalEvents[0]!) as {
      data: { turn: { items: Record<string, unknown>[] } };
    }
  ).data.turn;
  // Transcript snapshots deliberately omit capture declarations; use that family's existing projection.
  const snapshotMetadata = StoredTurnSnapshotV1Schema.parse({ ...snapshot, items: [] });
  const terminalMetadata = StoredTurnSnapshotV1Schema.parse({ ...turn, items: [] });
  if (
    Object.keys({ ...snapshotMetadata, ...terminalMetadata }).some(
      (field) =>
        !terminalSnapshotFieldMatches(
          field,
          snapshotMetadata[field as keyof typeof snapshotMetadata],
          terminalMetadata[field as keyof typeof terminalMetadata],
          sealedTurn
        )
    ) ||
    terminalEvents[0]!.input.sequence !==
      Math.max(
        ...entries
          .filter((entry) => entry.input.kind === 'event')
          .map((entry) => entry.input.sequence)
      )
  )
    throw new ControlProductPreconditionError();
  const supplied = new Map(
    entries.filter((entry) => entry.input.kind === 'item').map((entry) => [entry.id, entry])
  );
  const dependencies: { entry: PreparedControlEntry; contentJson: string; revision: number }[] = [];
  if (sealedTurn) {
    const retained = db.sqlite
      .prepare(
        "SELECT schema_version,sequence,revision,content_json FROM control_product_entries WHERE kind='event' AND turn_id=? ORDER BY sequence"
      )
      .all(turn.id) as {
      schema_version: number;
      sequence: number;
      revision: number;
      content_json: string;
    }[];
    const original = terminalEvents[0]!;
    let hasCompletion = false;
    for (const row of retained) {
      if (row.schema_version !== 1) throw new ControlProductPreconditionError();
      const [entry] = await prepareRetainedControlEntries(
        db,
        contentMount,
        [
          {
            kind: 'event',
            turnId: String(turn.id),
            sequence: row.sequence,
            expectedRevision: row.revision - 1,
            content: ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
          },
        ],
        turn,
        sealedTurn
      );
      if (!entry) throw new ControlProductPreconditionError();
      if (
        (preparedPayloads.get(entry) as { data: { type: string } }).data.type === 'turn-completed'
      ) {
        if (
          hasCompletion ||
          row.sequence !== original.input.sequence ||
          !isDeepStrictEqual(JSON.parse(row.content_json), original.input.content)
        )
          throw new ControlProductPreconditionError();
        hasCompletion = true;
      }
      dependencies.push({ entry, contentJson: row.content_json, revision: row.revision });
    }
    // Retained partial terminal metadata can lack its event. Fill only the exact next original completion.
    if (!hasCompletion && original.input.sequence !== (retained.at(-1)?.sequence ?? 0) + 1)
      throw new ControlProductPreconditionError();
  }
  const ids = new Set<string>();
  for (const item of snapshot.items) {
    const id = (item as { id: string }).id;
    if (ids.has(id)) throw new ControlProductPreconditionError();
    ids.add(id);
    let prepared = supplied.get(id);
    if (!prepared) {
      const row = db.sqlite
        .prepare(
          "SELECT sequence,revision,content_json FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=? ORDER BY revision DESC LIMIT 1"
        )
        .get(turn.id, id) as
        | { sequence: number; revision: number; content_json: string }
        | undefined;
      if (!row) throw new ControlProductPreconditionError();
      const [entry] = await prepareRetainedControlEntries(
        db,
        contentMount,
        [
          {
            kind: 'item',
            turnId: String(turn.id),
            sequence: row.sequence,
            expectedRevision: row.revision - 1,
            content: ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
          },
        ],
        turn
      );
      prepared = entry!;
      dependencies.push({ entry: prepared, contentJson: row.content_json, revision: row.revision });
    }
    if (
      !isDeepStrictEqual(
        preparedPayloads.get(prepared),
        StoredItemV1Schema.parse({ ...item, schemaVersion: 1 })
      )
    )
      throw new ControlProductPreconditionError();
  }
  if ([...supplied.keys()].some((id) => !ids.has(id))) throw new ControlProductPreconditionError();
  const bundleIds = [...new Set(input.evidence.flatMap((record) => record.evidenceBundleIds))];
  if (bundleIds.length > CONTROL_PRODUCT_LIMITS.entries)
    throw new ControlProductPreconditionError();
  const evidenceBundles = bundleIds.map((id) => {
    const row = db.sqlite
      .prepare('SELECT * FROM evidence_bundles WHERE evidence_bundle_id=?')
      .get(id) as Record<string, unknown> | undefined;
    if (
      !row ||
      row.schema_version !== 1 ||
      input.owner.kind !== 'workspace' ||
      row.workspace_id !== input.owner.workspaceId ||
      row.thread_id !== turn.threadId ||
      row.turn_id !== turn.id ||
      row.agent_session_id !== (turn.agentSessionId ?? null) ||
      z
        .array(z.string())
        .parse(JSON.parse(String(row.required_features_json)))
        .some(
          (feature) =>
            ![
              'runtime.evidence.v1',
              'worker.runtime-provenance.v1',
              'openkit.work-observations.v1',
            ].includes(feature)
        )
    )
      throw new ControlProductPreconditionError();
    const rowJson = JSON.stringify(row);
    if (Buffer.byteLength(rowJson) > CONTROL_PRODUCT_LIMITS.metadataBytes)
      throw new ControlProductPreconditionError();
    return { id, rowJson };
  });
  let executionSnapshot: { rootJson: string; terminalJson: string; cleanupJson: string } | null =
    null;
  if (input.execution) {
    const ref = { owner: input.owner, executionId: input.execution.executionId };
    const reader = createExecutionStepJournalReader(db, input.owner);
    const snapshot = readTerminalExecutionSnapshot(db.sqlite, input.execution);
    // Decode through the existing journal owner outside SQL, then recheck its exact bytes in the deciding body.
    await Promise.all([
      reader.readExecution(ref),
      reader.readInvocation({ execution: ref, stepId: input.execution.terminalStepId }),
      reader.readInvocation({ execution: ref, stepId: input.execution.cleanupStepId }),
    ]);
    if (
      db.sqlite.inTransaction ||
      !isDeepStrictEqual(snapshot, readTerminalExecutionSnapshot(db.sqlite, input.execution))
    )
      throw new ControlProductPreconditionError();
    executionSnapshot = snapshot;
  }
  const token = Object.freeze({ turnId: String(turn.id) });
  terminalPreparations.set(token, {
    sqlite: db.sqlite,
    input: structuredClone(input),
    entries,
    pending:
      db.scope === 'workspace' && input.pending?.length
        ? await prepareControlPendingCommands(
            db,
            input.pending,
            contentMount,
            input.entries,
            entries,
            newDirectories
          )
        : undefined,
    dependencies,
    evidenceBundles,
    executionSnapshot,
  });
  return token;
}

/** Checks and retains the original receipt; an earlier admission receipt does not skip terminal publication. */
function applyTerminalReceipt(
  db: CoreDb | WorkspaceDb,
  input: ControlTerminalTransition,
  command = input.command
): CommandRequestResponse | null {
  if (!command) return null;
  const { receipt, audit } = command;
  if (!terminalOwners) throw new ControlProductPreconditionError();
  const { commandRequestKey } = terminalOwners.store;
  const {
    mapCommandRequestRow,
    normalizeCommandRequestResponse,
    recordControlCommandRequestRecordInDb,
  } = terminalOwners.requests;
  const { recordServerAuditEvent, recordWorkspaceAuditEvent } = terminalOwners.audit;
  const owner = input.owner;
  if (
    receipt.scope.userId !== undefined ||
    receipt.scope.appId !== undefined ||
    (owner.kind === 'server'
      ? receipt.scope.coreId !== 'server' || receipt.scope.workspaceId !== undefined
      : receipt.scope.workspaceId !== owner.workspaceId || receipt.scope.coreId !== undefined) ||
    receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
    receipt.expiresAt <= receipt.createdAt ||
    audit.action !== receipt.command ||
    audit.requestId !== receipt.requestId ||
    audit.outcome !== 'succeeded' ||
    audit.workspaceId !== (owner.kind === 'server' ? null : owner.workspaceId) ||
    audit.threadId !== input.turn.record.threadId ||
    audit.turnId !== input.turn.record.id
  )
    throw new ControlProductPreconditionError();
  const response = normalizeCommandRequestResponse(
    receipt.command,
    receipt.response as CommandRequestResponse
  );
  // This owner admits Turn-producing commands, never a receipt for an unrelated product.
  if (response.kind !== 'turn' || response.id !== input.turn.record.id)
    throw new ControlProductPreconditionError();
  const row = db.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion,request_key AS key,command_name AS command,request_id AS requestId,scope_json AS scopeJson,input_hash AS inputHash,response_kind AS responseKind,response_id AS responseId,response_json AS responseJson,created_at AS createdAt,expires_at AS expiresAt FROM idempotency_requests WHERE request_key=?'
    )
    .get(receipt.key) as Parameters<typeof mapCommandRequestRow>[0] | undefined;
  if (row) {
    const prior = mapCommandRequestRow(row);
    if (
      prior.command !== receipt.command ||
      prior.requestId !== receipt.requestId ||
      prior.inputHash !== receipt.inputHash ||
      !isDeepStrictEqual(prior.scope, receipt.scope) ||
      !isDeepStrictEqual(prior.response, response)
    )
      throw new ControlProductPreconditionError();
    const localAudit = db.sqlite
      .prepare(
        'SELECT schema_version FROM audit_events WHERE action=? AND request_id=? AND workspace_id IS ? AND thread_id=? AND turn_id=? AND outcome=? LIMIT 1'
      )
      .get(
        receipt.command,
        receipt.requestId,
        audit.workspaceId,
        audit.threadId,
        audit.turnId,
        'succeeded'
      ) as { schema_version: number } | undefined;
    if (localAudit?.schema_version !== 1) throw new ControlProductPreconditionError();
    return prior.response;
  }
  // The existing native receipt owner also owns its disjoint operation/scope maintenance partition.
  recordControlCommandRequestRecordInDb(db, { ...receipt, response });
  const {
    id,
    createdAt,
    occurredAt,
    workspaceId: _workspaceId,
    protocolVersion,
    authentication,
    notebookAdmission,
    policyInvocation,
    policyWriteOutcome,
    ...facts
  } = audit;
  const event = {
    ...facts,
    auditEventId: id,
    now: new Date(createdAt),
    occurredAt: new Date(occurredAt),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(authentication === undefined ? {} : { authentication }),
    ...(notebookAdmission === undefined ? {} : { notebookAdmission }),
    ...(policyInvocation === undefined ? {} : { policyInvocation }),
    ...(policyWriteOutcome === undefined ? {} : { policyWriteOutcome }),
  };
  if (db.scope === 'core') recordServerAuditEvent({ ...event, coreDb: db });
  else recordWorkspaceAuditEvent({ ...event, workspaceDb: db, workspaceId: db.workspaceId });
  return response;
}

/** Captures exact local journal descriptors for a recheck after asynchronous preparation and inside SQL. */
function readTerminalExecutionSnapshot(
  sqlite: Database.Database,
  execution: NonNullable<ControlTerminalTransition['execution']>
) {
  const root = sqlite
    .prepare('SELECT * FROM control_executions WHERE id=?')
    .get(execution.executionId);
  const terminal = sqlite
    .prepare('SELECT * FROM control_execution_steps WHERE execution_id=? AND step_id=?')
    .get(execution.executionId, execution.terminalStepId);
  const cleanup = sqlite
    .prepare('SELECT * FROM control_execution_steps WHERE execution_id=? AND step_id=?')
    .get(execution.executionId, execution.cleanupStepId);
  if (!root || !terminal || !cleanup) throw new ControlProductPreconditionError();
  return {
    rootJson: JSON.stringify(root),
    terminalJson: JSON.stringify(terminal),
    cleanupJson: JSON.stringify(cleanup),
  };
}

/** Ends only the actual terminal-publication step and preserves the already-admitted cleanup intent and exclusion. */
function applyTerminalExecution(
  db: CoreDb | WorkspaceDb,
  input: ControlTerminalTransition
): ControlTerminalResult['execution'] {
  const execution = input.execution;
  const turn = input.turn.record;
  const tableExists = db.sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_executions'")
    .get();
  const roots = tableExists
    ? (db.sqlite.prepare('SELECT * FROM control_executions WHERE work_id=?').all(turn.id) as {
        id: string;
        schema_version: number;
        owner_json: string;
        definition_version: string;
        phase: string;
        revision: number;
        exclusion_refs_json: string;
        terminal_cause: string | null;
      }[])
    : [];
  if (!execution) {
    if (roots.length || turn.agentSessionId != null) throw new ControlProductPreconditionError();
    return null;
  }
  const root = roots.find((row) => row.id === execution.executionId);
  if (
    !root ||
    roots.length !== 1 ||
    root.schema_version !== 1 ||
    !Number.isSafeInteger(root.revision) ||
    root.revision < 1 ||
    db.scope !== 'workspace' ||
    root.definition_version !== 'workspace-worker-turn/v1' ||
    (!['failed', 'cancelled', 'interrupted'].includes(String(turn.status)) &&
      !input.evidence.length) ||
    !isDeepStrictEqual(JSON.parse(root.owner_json), input.owner)
  )
    throw new ControlProductPreconditionError();
  const step = db.sqlite
    .prepare(
      'SELECT schema_version,state,control_json,span_json FROM control_execution_steps WHERE execution_id=? AND step_id=?'
    )
    .get(root.id, execution.terminalStepId) as
    | { schema_version: number; state: string; control_json: string; span_json: string }
    | undefined;
  const cleanup = db.sqlite
    .prepare(
      'SELECT schema_version,state,control_json FROM control_execution_steps WHERE execution_id=? AND step_id=?'
    )
    .get(root.id, execution.cleanupStepId) as
    | { schema_version: number; state: string; control_json: string }
    | undefined;
  if (
    !step ||
    step.schema_version !== 1 ||
    JSON.parse(step.control_json).kind !== 'terminal-publication' ||
    !cleanup ||
    cleanup.schema_version !== 1 ||
    !['intent', 'completed', 'failed', 'unknown', 'cancelled'].includes(cleanup.state) ||
    !['inspect-cleanup', 'fence', 'release'].includes(JSON.parse(cleanup.control_json).kind)
  )
    throw new ControlProductPreconditionError();
  const outputRefs = input.entries.map((entry) => entry.content.reference.contentDigest);
  if ((root.phase === 'closing' || root.phase === 'closed') && step.state === 'completed') {
    if (!isDeepStrictEqual(JSON.parse(step.control_json).outputRefs, outputRefs))
      throw new ControlProductPreconditionError();
    return { executionId: root.id, revision: root.revision, phase: root.phase };
  }
  if (cleanup.state !== 'intent') throw new ControlProductPreconditionError();
  const exclusionRefs = z
    .array(z.string().min(1))
    .min(1)
    .parse(JSON.parse(root.exclusion_refs_json));
  const span = JSON.parse(step.span_json) as ExecutionJournalSettlement['span'];
  // Native decoding validates this retained span; no diagnostic field supplies control authority.
  const settled: ExecutionJournalSettlement = {
    ref: {
      execution: { owner: input.owner, executionId: root.id },
      stepId: execution.terminalStepId,
    },
    expectedExecutionRevision: execution.expectedRevision,
    state: 'completed',
    outputRefs,
    span: {
      ...span,
      status: { code: 'OK' },
      // Publication ends now; the product's earlier completion time is not this local step's clock.
      endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
    },
    nextPhase: 'closing',
    terminalCause: root.terminal_cause ?? String(turn.status),
    exclusionRefs,
  };
  // Workspace qualification requires the owner-qualified journal primitive and Workspace0012, not a cast or alternate SQL writer.
  settleExecutionJournalStep(db, settled);
  const after = db.sqlite
    .prepare('SELECT revision FROM control_executions WHERE id=?')
    .get(root.id) as { revision: number };
  return { executionId: root.id, revision: after.revision, phase: 'closing' };
}

/** Applies the complete terminal tuple in its caller's active savepoint. It never commits, publishes or acknowledges. */
export function applyControlTerminal(
  db: CoreDb | WorkspaceDb,
  value: ControlTerminalTransition,
  prepared: PreparedControlTerminal
): ControlTerminalResult {
  assertControlProductWriter(db.sqlite);
  const input = ControlTerminalTransitionSchema.parse(value);
  terminalOwner(db, input.owner);
  const preparation = terminalPreparations.get(prepared);
  if (
    !preparation ||
    preparation.sqlite !== db.sqlite ||
    !isDeepStrictEqual(input, preparation.input)
  )
    throw new ControlProductPreconditionError();
  if (
    input.execution &&
    (!preparation.executionSnapshot ||
      !isDeepStrictEqual(
        preparation.executionSnapshot,
        readTerminalExecutionSnapshot(db.sqlite, input.execution)
      ))
  )
    throw new ControlProductPreconditionError();
  const turn = decode('turn', input.turn.record, input.owner);
  const previous = readProduct(db.sqlite, input.owner, 'turn', String(turn.id));
  // Manual Artifact publication creates an already-completed Core-local Turn only on an idle Thread.
  // Check the actual native rows in this transaction; a Main preflight cannot exclude a competing admission.
  if (
    !previous &&
    preparation.entries.some(
      (entry) =>
        entry.input.kind === 'item' &&
        (preparedPayloads.get(entry) as { type?: string }).type === 'artifact-reference'
    ) &&
    db.sqlite
      .prepare("SELECT 1 FROM control_turns WHERE thread_id=? AND status IN ('pending','running')")
      .get(turn.threadId)
  )
    throw new ControlProductPreconditionError();
  if (previous) {
    for (const field of ['startedAt', 'captureCoverage', 'fileInputs', 'internalExecution']) {
      if (
        previous.record[field] !== undefined &&
        previous.record[field] !== null &&
        !isDeepStrictEqual(previous.record[field], turn[field])
      )
        throw new ControlProductPreconditionError();
    }
  } else if (!turn.captureCoverage) throw new ControlProductPreconditionError();
  for (const dependency of preparation.dependencies) {
    const row = db.sqlite
      .prepare(
        'SELECT revision,content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND id=? ORDER BY revision DESC LIMIT 1'
      )
      .get(dependency.entry.input.kind, turn.id, dependency.entry.id) as
      | { revision: number; content_json: string }
      | undefined;
    if (!row || row.revision !== dependency.revision || row.content_json !== dependency.contentJson)
      throw new ControlProductPreconditionError();
  }
  for (const bundle of preparation.evidenceBundles) {
    if (
      JSON.stringify(
        db.sqlite
          .prepare('SELECT * FROM evidence_bundles WHERE evidence_bundle_id=?')
          .get(bundle.id)
      ) !== bundle.rowJson
    )
      throw new ControlProductPreconditionError();
  }
  // A decided replay must not rewind companion projections changed by later ordinary commands.
  // Pending archive publishes this exact Core-local closeout before archiving its Thread.
  const closeout = input.pending?.length === 1 ? input.pending[0] : undefined;
  const archives = input.products.filter(
    (product) =>
      !previous &&
      turn.status === 'completed' &&
      turn.agentId == null &&
      turn.agentSessionId == null &&
      input.owner.kind === 'workspace' &&
      closeout?.action === 'closeout' &&
      closeout.workspaceId === input.owner.workspaceId &&
      closeout.threadId === turn.threadId &&
      closeout.closeoutTurnId === turn.id &&
      product.kind === 'thread' &&
      product.record.id === turn.threadId &&
      product.record.status === 'archived'
  );
  if (
    archives.length &&
    input.products.filter(
      (product) => product.kind === 'thread' && product.record.id === turn.threadId
    ).length !== 1
  )
    throw new ControlProductPreconditionError();
  applyProducts(
    db.sqlite,
    input.owner,
    previous && !['pending', 'running'].includes(String(previous.record.status))
      ? [input.turn]
      : [...input.products.filter((product) => !archives.includes(product)), input.turn],
    preparation.entries,
    String(turn.id)
  );
  const terminalEvent = preparation.entries.find(
    (entry) =>
      (preparedPayloads.get(entry) as { data?: { type?: string } }).data?.type === 'turn-completed'
  )!;
  if (
    db.sqlite
      .prepare(
        "SELECT 1 FROM control_product_entries WHERE kind='item' AND turn_id=? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1"
      )
      .get(turn.id, JSON.stringify(terminalEvent.referencedItemIds ?? []))
  )
    throw new ControlProductPreconditionError();
  if (!terminalOwners) throw new ControlProductPreconditionError();
  if (db.scope === 'workspace')
    terminalOwners.task.recordTaskTerminalFact(db, {
      ...StoredTurnV1Schema.parse(turn),
      items: [],
    });
  for (const record of input.evidence) {
    if (
      input.owner.kind !== 'workspace' ||
      record.workspaceId !== input.owner.workspaceId ||
      record.threadId !== turn.threadId ||
      record.turnId !== turn.id ||
      record.agentSessionId !== (turn.agentSessionId ?? null) ||
      record.requiredFeatures.some(
        (feature) => !['runtime.evidence.v1', 'worker.runtime-provenance.v1'].includes(feature)
      )
    )
      throw new ControlProductPreconditionError();
  }
  terminalOwners.evidence.importWorkspaceRuntimeEvidence(db, input.evidence);
  const reap = terminalOwners.observations.applyControlTurnReap(db.sqlite, input.owner, {
    threadId: String(turn.threadId),
    turnId: String(turn.id),
    ...input.reap,
  });
  if (input.pending?.length) {
    if (db.scope !== 'workspace') throw new ControlProductPreconditionError();
    for (const command of input.pending)
      applyControlPendingCommand(
        db,
        command,
        preparation.pending ?? { entries: [], dependencies: [] }
      );
  }
  if (archives.length) applyControlProducts(db.sqlite, input.owner, archives, []);
  if (
    input.interruptCommand &&
    (!['interrupted', 'cancelled'].includes(String(turn.status)) ||
      input.interruptCommand.receipt.scope.threadId !== turn.threadId ||
      input.interruptCommand.receipt.scope.turnId !== turn.id ||
      (input.command && input.command.receipt.command !== 'conversation.submit'))
  )
    throw new ControlProductPreconditionError();
  const response = applyTerminalReceipt(db, input);
  // Both original receipts and Audits share the outer terminal transaction, including refusal.
  const interruptResponse = applyTerminalReceipt(db, input, input.interruptCommand ?? null);
  const execution = applyTerminalExecution(db, input);
  const current = readProduct(db.sqlite, input.owner, 'turn', String(turn.id));
  if (!current) throw new ControlProductPreconditionError();
  return {
    turnId: String(turn.id),
    revision: current.revision,
    replayed:
      previous !== undefined && !['pending', 'running'].includes(String(previous.record.status)),
    reap: reap ? { id: reap.id, sequence: reap.seq } : null,
    response: response ?? interruptResponse,
    execution,
  };
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
  // Only the closed metadata-kind set is prepared; no canonical row survives a read.
  const prepared = new Map<ControlProductKind, Database.Statement>();
  let entriesStatement: Database.Statement | undefined;
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
      return readProduct(sqlite, owner, kind, id, prepared);
    },
    /** Materializes at most one bounded page; no cursor or transaction escapes. */
    list(kind: ControlProductKind, afterId = '', limit = CONTROL_PRODUCT_LIMITS.pageRows) {
      ControlProductKindSchema.parse(kind);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTROL_PRODUCT_LIMITS.pageRows)
        throw new ControlProductPreconditionError();
      const rows = sqlite
        .prepare(`SELECT * FROM ${tables[kind]} WHERE id>? ORDER BY id LIMIT ?`)
        .all(afterId, limit) as MetadataRow[];
      return rows.map((row) => decodeRow(sqlite, kind, row, owner, prepared));
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
      if (!readProduct(sqlite, owner, 'turn', turnId, prepared)) return [];
      entriesStatement ??= sqlite.prepare(
        'SELECT schema_version,sequence,id,revision,content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence>? ORDER BY sequence LIMIT ?'
      );
      const rows = entriesStatement.all(kind, turnId, after, limit) as {
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
