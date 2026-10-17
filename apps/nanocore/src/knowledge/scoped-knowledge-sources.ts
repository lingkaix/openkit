import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RegisterKnowledgeSourceRequestSchema } from '@openkit/app-api-schemas';
import { parseRecordEnvelope, RecordEnvelopeSchema } from '@openkit/config-schema';
import {
  allocateEntityId,
  KnowledgeSourceIdSchema,
  RequestIdSchema,
  UserIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { recordUserAuditEvent } from '../audit-events.js';
import { OperationError } from '../operation-error.js';
import {
  IdempotencyKeyConflictError,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import { userDbPath } from '../storage/fs-layout.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  KnowledgeSourceRecordSchema,
  readCanonicalFile,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';
import { admitMemoryContext, type MemoryContext, type MemoryWriter } from './memory-lifecycle.js';
import { ScopedNotebookAccessError } from './scoped-notebook-owner.js';

const OPERATION = 'knowledge.source.register';
const FEATURES = ['openkit.knowledge-owner-scope.v1'] as const;
const MetadataSchema = KnowledgeSourceRecordSchema.omit({ workspaceId: true }).extend({
  kind: z.literal('document'),
});
const RequestSchema = RegisterKnowledgeSourceRequestSchema.pick({
  requestId: true,
  title: true,
  content: true,
})
  .extend({ requestId: RequestIdSchema, kind: z.literal('document') })
  .strict();
const PayloadSchema = MetadataSchema.omit({
  id: true,
  capturedAt: true,
  createdAt: true,
  updatedAt: true,
  contentDigest: true,
}).extend({
  uri: z.null(),
  originatingThreadId: z.null(),
  originatingTurnId: z.null(),
  originatingFileId: z.null(),
});
const SourceEnvelopeSchema = RecordEnvelopeSchema.safeExtend({
  schemaVersion: z.literal(1),
  recordType: z.literal('source'),
  id: KnowledgeSourceIdSchema,
  ownerScope: z.literal('user'),
  lineage: z.object({ userId: UserIdSchema, requestId: RequestIdSchema }),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  redactionLevel: z.literal('none'),
  sensitivity: z.literal('confidential'),
  requiredFeatures: z.tuple([z.literal(FEATURES[0])]),
  payload: PayloadSchema,
}).strip();

/** Trusted self authority plus the existing User receipt owner; no caller selects a User or storage path. */
export type UserKnowledgeSourceWriter = Pick<
  MemoryWriter,
  'coreDb' | 'userDb' | 'actor' | 'store' | 'inflightCommands'
>;

/** One explicit literal document capture; location, conversation and file provenance remain unjoined. */
export type RegisterUserKnowledgeSourceInput = z.infer<typeof RequestSchema>;

/** Existing Source metadata projected from one header and payload under the authenticated User owner. */
export type UserKnowledgeSource = z.infer<typeof MetadataSchema> & {
  readonly ownerScope: { readonly kind: 'user'; readonly userId: string };
};

type SourceEnvelope = z.infer<typeof SourceEnvelopeSchema>;

/** Uses a fixed product error rather than exposing paths, decoder details or captured source text. */
function unavailable(): never {
  throw new OperationError('recovery_required', 'User Source storage requires recovery.', 503);
}

/** Hashes exact captured UTF-8 bytes, independently of metadata or descriptive annotations. */
function digest(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Derives actual capture time from this literal producer's single creation event; imported provenance is not inferred. */
function project(row: SourceEnvelope): UserKnowledgeSource {
  return {
    ...MetadataSchema.parse({
      ...row.payload,
      id: row.id,
      contentDigest: row.contentDigest,
      capturedAt: row.createdAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    ownerScope: { kind: 'user', userId: row.lineage.userId },
  };
}

/** Resolves current self before paths and refuses lost established storage instead of creating an empty replacement. */
function sourceRoot(input: MemoryContext, create = false): string {
  const owner = admitMemoryContext(input);
  try {
    const userRoot = dirname(owner.notebookRoot);
    for (const path of [
      input.coreDb.dataRoot,
      join(input.coreDb.dataRoot, 'users'),
      userRoot,
      join(userRoot, 'db'),
    ])
      assertCanonicalDirectory(path);
    const database = lstatSync(userDbPath(input.coreDb.dataRoot, input.userDb.userId));
    if (!database.isFile() || database.isSymbolicLink() || !input.userDb.sqlite.open) unavailable();
    const root = join(userRoot, 'sources');
    if (!lstatSync(root, { throwIfNoEntry: false })) {
      if (
        !create ||
        input.userDb.sqlite
          .prepare('SELECT 1 FROM idempotency_requests WHERE command_name = ? LIMIT 1')
          .get(OPERATION) ||
        input.userDb.sqlite
          .prepare('SELECT 1 FROM audit_events WHERE action = ? LIMIT 1')
          .get(OPERATION)
      )
        unavailable();
      ensureCanonicalDirectory(root);
      ensureCanonicalDirectory(join(root, 'registry'));
      ensureCanonicalDirectory(join(root, 'materials'));
    }
    for (const path of [root, join(root, 'registry'), join(root, 'materials')])
      assertCanonicalDirectory(path);
    return root;
  } catch (error) {
    if (error instanceof OperationError) throw error;
    return unavailable();
  }
}

/** Loads the existing registry family without repair; listing does not load every retained source body. */
function records(input: MemoryContext, root: string): SourceEnvelope[] {
  try {
    const rows = readdirSync(join(root, 'registry'), { withFileTypes: true })
      .filter(
        ({ name }) =>
          name.endsWith('.json') && KnowledgeSourceIdSchema.safeParse(name.slice(0, -5)).success
      )
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map((entry) => {
        if (!entry.isFile()) unavailable();
        const row = SourceEnvelopeSchema.parse(
          parseRecordEnvelope(
            JSON.parse(readCanonicalFile(join(root, 'registry', entry.name)).toString('utf8')),
            { supportedFeatures: FEATURES }
          )
        );
        if (
          entry.name !== `${row.id}.json` ||
          row.lineage.userId !== input.userDb.userId ||
          row.updatedAt !== row.createdAt
        )
          unavailable();
        assertCanonicalDirectory(join(root, 'materials', row.id));
        const file = lstatSync(join(root, 'materials', row.id, 'content.txt'));
        if (!file.isFile() || file.isSymbolicLink()) unavailable();
        return row;
      });
    const ids = new Set(rows.map(({ id }) => id));
    const requests = new Set(rows.map(({ lineage }) => lineage.requestId));
    if (requests.size !== rows.length) unavailable();
    for (const entry of readdirSync(join(root, 'materials'), { withFileTypes: true })) {
      if (
        KnowledgeSourceIdSchema.safeParse(entry.name).success &&
        (!entry.isDirectory() || !ids.has(entry.name))
      )
        unavailable();
    }
    admitMemoryContext(input);
    return rows;
  } catch (error) {
    if (error instanceof ScopedNotebookAccessError) throw error;
    return unavailable();
  }
}

/** Lists only the current self's canonical Source metadata; absent storage is never an empty collection fallback. */
export function listUserKnowledgeSources(input: MemoryContext): UserKnowledgeSource[] {
  return records(input, sourceRoot(input)).map(project);
}

/** Reads exact captured text after current self, closed Source semantics, canonical path and content-digest checks. */
export function readUserKnowledgeSource(
  input: MemoryContext,
  sourceId: string
): { readonly source: UserKnowledgeSource; readonly content: string } | null {
  admitMemoryContext(input);
  if (!KnowledgeSourceIdSchema.safeParse(sourceId).success)
    throw new OperationError('invalid_request', 'Invalid Source identity.', 400);
  const root = sourceRoot(input);
  const row = records(input, root).find(({ id }) => id === sourceId);
  if (!row) return null;
  try {
    const bytes = readCanonicalFile(join(root, 'materials', row.id, 'content.txt'));
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes) || digest(bytes) !== row.contentDigest) unavailable();
    admitMemoryContext(input);
    return { source: project(row), content };
  } catch (error) {
    if (error instanceof ScopedNotebookAccessError) throw error;
    return unavailable();
  }
}

/** Captures one immutable literal Source through existing User command receipts and Audit, without public or model activation. */
export async function registerUserKnowledgeSource(
  input: UserKnowledgeSourceWriter,
  request: RegisterUserKnowledgeSourceInput
): Promise<UserKnowledgeSource> {
  admitMemoryContext(input);
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success || Buffer.from(parsed.data.content).toString('utf8') !== parsed.data.content)
    throw new OperationError('invalid_request', 'Invalid literal Source request.', 400);
  const command = parsed.data;
  const ownerScope = { kind: 'user' as const, userId: input.userDb.userId };
  try {
    // Receipt lookup can prune expired rows, so physical root admission also precedes that existing UserDb write.
    sourceRoot(input, true);
    return await runIdempotentCommand({
      store: input.store,
      receiptDb: input.userDb,
      inflightCommands: input.inflightCommands,
      command: OPERATION,
      requestId: command.requestId,
      scope: { userId: input.userDb.userId, actorId: input.actor!.userId },
      input: { ownerScope, ...command },
      responseKind: 'knowledge_source',
      responseId: (source) => source.id,
      replay: (receipt) => {
        const retained = readUserKnowledgeSource(input, receipt.response.id);
        if (!retained) unavailable();
        return retained.source;
      },
      execute: () => {
        const root = sourceRoot(input, true);
        const previous = records(input, root).find(
          ({ lineage }) => lineage.requestId === command.requestId
        );
        if (previous) {
          if (
            previous.payload.title !== command.title ||
            previous.contentDigest !== digest(command.content)
          )
            throw new IdempotencyKeyConflictError();
          // A retained Source without its command receipt is an unknown completion, never a new capture or inferred success.
          return unavailable();
        }
        const id = allocateEntityId('ks');
        const now = new Date().toISOString();
        const row = SourceEnvelopeSchema.parse({
          schemaVersion: 1,
          recordType: 'source',
          id,
          ownerScope: 'user',
          lineage: { userId: input.userDb.userId, requestId: command.requestId },
          createdAt: now,
          updatedAt: now,
          contentDigest: digest(command.content),
          redactionLevel: 'none',
          sensitivity: 'confidential',
          requiredFeatures: [...FEATURES],
          extensions: {},
          payload: {
            kind: command.kind,
            title: command.title,
            uri: null,
            originatingThreadId: null,
            originatingTurnId: null,
            originatingFileId: null,
          },
        });
        const registry = join(root, 'registry', `${id}.json`);
        const material = join(root, 'materials', id);
        if (
          lstatSync(registry, { throwIfNoEntry: false }) ||
          lstatSync(material, { throwIfNoEntry: false })
        )
          unavailable();
        admitMemoryContext(input);
        ensureCanonicalDirectory(material);
        writeFileAtomic(join(material, 'content.txt'), command.content);
        admitMemoryContext(input);
        writeFileAtomic(registry, `${JSON.stringify(row)}\n`);
        recordUserAuditEvent({
          userDb: input.userDb,
          requestId: command.requestId,
          actor: { kind: 'user', id: input.actor!.userId },
          category: 'knowledge',
          action: OPERATION,
          resource: `knowledge-source:${id}`,
          outcome: 'succeeded',
          summary: 'User Source registered.',
        });
        return project(row);
      },
    });
  } catch (error) {
    if (
      error instanceof OperationError ||
      error instanceof IdempotencyKeyConflictError ||
      error instanceof ScopedNotebookAccessError
    )
      throw error;
    return unavailable();
  }
}
