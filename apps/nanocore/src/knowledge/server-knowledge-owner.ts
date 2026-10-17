import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RegisterKnowledgeSourceRequestSchema } from '@openkit/app-api-schemas';
import { parseRecordEnvelope, RecordEnvelopeSchema } from '@openkit/config-schema';
import { allocateEntityId, KnowledgeSourceIdSchema, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { recordServerAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { CoreDb } from '../storage/db.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  KnowledgeSourceRecordSchema,
  readCanonicalFile,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';

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
  ownerScope: z.literal('server'),
  lineage: z.object({ requestId: RequestIdSchema }),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  redactionLevel: z.literal('none'),
  sensitivity: z.literal('internal'),
  requiredFeatures: z.tuple([z.literal(FEATURES[0])]),
  payload: PayloadSchema,
}).strip();
type SourceEnvelope = z.infer<typeof SourceEnvelopeSchema>;

/** Actual current deployment credential; Workspace membership and User ownership grant no Server access. */
export interface ServerKnowledgeContext {
  readonly coreDb: CoreDb;
  readonly actor: Actor | undefined;
}
/** Literal document in the existing Server Source family, without Workspace provenance. */
export type ServerKnowledgeSource = z.infer<typeof MetadataSchema> & {
  readonly ownerScope: { readonly kind: 'server' };
};
/** Explicit source capture, without a model-selected owner, URI or conversation. */
export type RegisterServerKnowledgeSourceInput = z.infer<typeof RequestSchema>;
/** Existing Core receipt and canonical file writer supplied by trusted native assembly. */
export interface ServerKnowledgeSourceWriter extends ServerKnowledgeContext {
  readonly store: FsStore;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
}

/** Cheap current authority check; it performs no notebook, Source or index read. */
export function admitsServerKnowledge(input: ServerKnowledgeContext): boolean {
  return Boolean(input.actor && isCurrentDeploymentAdministrator(input.coreDb, input.actor));
}
/** Rechecks the existing Server owner before every file disclosure or write. */
function requireOwner(input: ServerKnowledgeContext): void {
  if (!admitsServerKnowledge(input))
    throw new OperationError('workspace_access_denied', 'Server Knowledge access denied.', 403);
}
/** Reports incomplete canonical storage without exposing paths or source text. */
function unavailable(): never {
  throw new OperationError('recovery_required', 'Server Source storage requires recovery.', 503);
}
/** Exact captured UTF-8 identity, independent of descriptive Source metadata. */
function digest(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
/** Projects one literal producer's actual creation event as its capture time. */
function project(row: SourceEnvelope): ServerKnowledgeSource {
  return {
    ...MetadataSchema.parse({
      ...row.payload,
      id: row.id,
      contentDigest: row.contentDigest,
      capturedAt: row.createdAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    ownerScope: { kind: 'server' },
  };
}
/** Reuses the assigned Server Sources root; a lost established family is never recreated. */
function sourceRoot(input: ServerKnowledgeContext, create = false): string | null {
  requireOwner(input);
  try {
    const server = join(input.coreDb.dataRoot, 'server');
    assertCanonicalDirectory(input.coreDb.dataRoot);
    assertCanonicalDirectory(server);
    const root = join(server, 'sources');
    if (!lstatSync(root, { throwIfNoEntry: false })) {
      if (
        input.coreDb.sqlite
          .prepare('SELECT 1 FROM idempotency_requests WHERE command_name = ? LIMIT 1')
          .get(OPERATION) ||
        input.coreDb.sqlite
          .prepare('SELECT 1 FROM audit_events WHERE action = ? LIMIT 1')
          .get(OPERATION)
      )
        unavailable();
      if (!create) return null;
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
/** Reads the existing envelope registry without repairing or importing another scope's records. */
function records(input: ServerKnowledgeContext, root: string): SourceEnvelope[] {
  try {
    const rows = readdirSync(join(root, 'registry'), { withFileTypes: true })
      .filter(
        ({ name }) =>
          name.endsWith('.json') && KnowledgeSourceIdSchema.safeParse(name.slice(0, -5)).success
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        if (!entry.isFile()) unavailable();
        const row = SourceEnvelopeSchema.parse(
          parseRecordEnvelope(
            JSON.parse(readCanonicalFile(join(root, 'registry', entry.name)).toString('utf8')),
            { supportedFeatures: FEATURES }
          )
        );
        if (entry.name !== `${row.id}.json` || row.updatedAt !== row.createdAt) unavailable();
        return row;
      });
    const ids = new Set(rows.map((row) => row.id));
    if (new Set(rows.map((row) => row.lineage.requestId)).size !== rows.length) unavailable();
    for (const entry of readdirSync(join(root, 'materials'), { withFileTypes: true }))
      if (
        KnowledgeSourceIdSchema.safeParse(entry.name).success &&
        (!entry.isDirectory() || !ids.has(entry.name))
      )
        unavailable();
    requireOwner(input);
    return rows;
  } catch (error) {
    if (error instanceof OperationError) throw error;
    return unavailable();
  }
}
/** Lists Server Source metadata only after current deployment admission. */
export function listServerKnowledgeSources(input: ServerKnowledgeContext): ServerKnowledgeSource[] {
  const root = sourceRoot(input);
  return root === null ? [] : records(input, root).map(project);
}
/** Reads one exact Server literal Source; Workspace Source identities never fall through to another registry. */
export function readServerKnowledgeSource(
  input: ServerKnowledgeContext,
  sourceId: string
): { source: ServerKnowledgeSource; content: string } | null {
  requireOwner(input);
  if (!KnowledgeSourceIdSchema.safeParse(sourceId).success)
    throw new OperationError('invalid_request', 'Invalid Source identity.', 400);
  const root = sourceRoot(input);
  if (root === null) return null;
  const row = records(input, root).find((candidate) => candidate.id === sourceId);
  if (!row) return null;
  try {
    assertCanonicalDirectory(join(root, 'materials', row.id));
    const bytes = readCanonicalFile(join(root, 'materials', row.id, 'content.txt'));
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes) || digest(bytes) !== row.contentDigest) unavailable();
    requireOwner(input);
    return { source: project(row), content };
  } catch (error) {
    if (error instanceof OperationError) throw error;
    return unavailable();
  }
}
/** Registers one explicit immutable document through existing Core receipts and Audit. */
export async function registerServerKnowledgeSource(
  input: ServerKnowledgeSourceWriter,
  request: RegisterServerKnowledgeSourceInput
): Promise<ServerKnowledgeSource> {
  requireOwner(input);
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success || Buffer.from(parsed.data.content).toString('utf8') !== parsed.data.content)
    throw new OperationError('invalid_request', 'Invalid literal Source request.', 400);
  const command = parsed.data;
  sourceRoot(input, true);
  return runIdempotentCommand({
    store: input.store,
    receiptDb: input.coreDb,
    inflightCommands: input.inflightCommands,
    command: OPERATION,
    requestId: command.requestId,
    scope: { coreId: 'server', actorId: input.actor!.userId },
    input: { ownerScope: { kind: 'server' }, ...command },
    responseKind: 'knowledge_source',
    responseId: (source) => source.id,
    replay: (receipt) => {
      const retained = readServerKnowledgeSource(input, receipt.response.id);
      if (!retained) unavailable();
      return retained.source;
    },
    execute: () => {
      const root = sourceRoot(input, true)!;
      const previous = records(input, root).find(
        (row) => row.lineage.requestId === command.requestId
      );
      if (previous) {
        if (
          previous.payload.title !== command.title ||
          previous.contentDigest !== digest(command.content)
        )
          throw new IdempotencyKeyConflictError();
        return unavailable();
      }
      const id = allocateEntityId('ks');
      const now = new Date().toISOString();
      const row = SourceEnvelopeSchema.parse({
        schemaVersion: 1,
        recordType: 'source',
        id,
        ownerScope: 'server',
        lineage: { requestId: command.requestId },
        createdAt: now,
        updatedAt: now,
        contentDigest: digest(command.content),
        redactionLevel: 'none',
        sensitivity: 'internal',
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
      const material = join(root, 'materials', id);
      if (
        lstatSync(material, { throwIfNoEntry: false }) ||
        lstatSync(join(root, 'registry', `${id}.json`), { throwIfNoEntry: false })
      )
        unavailable();
      requireOwner(input);
      ensureCanonicalDirectory(material);
      writeFileAtomic(join(material, 'content.txt'), command.content);
      requireOwner(input);
      writeFileAtomic(join(root, 'registry', `${id}.json`), `${JSON.stringify(row)}\n`);
      recordServerAuditEvent({
        coreDb: input.coreDb,
        requestId: command.requestId,
        actor: { kind: 'user', id: input.actor!.userId },
        category: 'knowledge',
        action: OPERATION,
        resource: `knowledge-source:${id}`,
        outcome: 'succeeded',
        summary: 'Server Source registered.',
      });
      return project(row);
    },
  });
}
