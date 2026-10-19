import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { RegisterKnowledgeSourceRequestSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, KnowledgeSourceIdSchema, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { OperationError } from '../operation-error.js';
import { runIdempotentCommand } from '../runtime/idempotent-command.js';
import { userDbPath } from '../storage/fs-layout.js';
import { assertCanonicalDirectory } from '../storage/workspace-file-records.js';
import { admitMemoryContext, type MemoryContext, type MemoryWriter } from './memory-lifecycle.js';
import { readMemorySuppressions } from './memory-maintenance.js';
import { NotebookError } from './notebook.js';
import {
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringFrontmatterField,
  stringListFrontmatterField,
} from './okf.js';
import {
  readSourcePointers,
  type SourceMetadataSchema,
  sourceNotebookRoot,
} from './source-pointers.js';
import { publishCapturedSource } from './source-publication.js';
import { readManagedSourceText } from './source-reading.js';

const OPERATION = 'knowledge.source.register';
const RequestSchema = RegisterKnowledgeSourceRequestSchema.pick({
  requestId: true,
  title: true,
  content: true,
})
  .extend({ requestId: RequestIdSchema, kind: z.literal('document') })
  .strict();

/** Trusted self and existing User command owner; no caller selects another scope. */
export type UserKnowledgeSourceWriter = Pick<
  MemoryWriter,
  'coreDb' | 'userDb' | 'actor' | 'store' | 'inflightCommands'
>;
/** Explicit literal document capture through the existing command. */
export type RegisterUserKnowledgeSourceInput = z.infer<typeof RequestSchema>;
/** Existing User API metadata projected from the sole canonical pointer. */
export type UserKnowledgeSource = z.infer<typeof SourceMetadataSchema> & {
  readonly ownerScope: { readonly kind: 'user'; readonly userId: string };
};

/** Fails established canonical storage without exposing bytes or physical paths. */
function unavailable(): never {
  throw new OperationError('recovery_required', 'User Source storage requires recovery.', 503);
}

/** Rechecks actual self and User database before deriving any notebook or byte location. */
function owner(input: MemoryContext) {
  const admitted = admitMemoryContext(input);
  const database = lstatSync(userDbPath(input.coreDb.dataRoot, input.userDb.userId), {
    throwIfNoEntry: false,
  });
  if (!input.userDb.sqlite.open || !database?.isFile() || database.isSymbolicLink()) unavailable();
  assertCanonicalDirectory(join(input.coreDb.dataRoot, 'users', input.userDb.userId));
  return {
    dataRoot: input.coreDb.dataRoot,
    ownerScope: admitted.ownerScope as UserKnowledgeSource['ownerScope'],
  };
}

/** Existing User suppression applies to exact Source versions, including their canonical pointer projection. */
function suppressed(input: MemoryContext): ReadonlySet<string> {
  const scope = owner(input);
  const root = sourceNotebookRoot(scope);
  if (!lstatSync(root, { throwIfNoEntry: false })) return new Set();
  return new Set(
    readMemorySuppressions(root, input.userDb.userId).flatMap(
      ({ payload }) => payload.sourceFingerprints
    )
  );
}

/** Reads the published Source family; a never-created scope is empty and lost established storage is unavailable. */
function pointers(input: MemoryContext) {
  const scope = owner(input);
  const root = sourceNotebookRoot(scope);
  if (!lstatSync(join(root, 'notebook.git'), { throwIfNoEntry: false })) {
    if (
      lstatSync(root, { throwIfNoEntry: false }) ||
      input.userDb.sqlite
        .prepare(
          "SELECT 1 FROM audit_events WHERE action IN ('knowledge.notebook.initialize', 'knowledge.source.register') LIMIT 1"
        )
        .get()
    )
      unavailable();
    return new Map<string, import('./source-pointers.js').SourcePointer>();
  }
  try {
    return readSourcePointers(scope);
  } catch {
    return unavailable();
  }
}

/** Lists current self metadata without byte reads; model delivery excludes forgotten versions. */
export function listUserKnowledgeSources(
  input: MemoryContext,
  delivery: 'human' | 'model' = 'human'
): UserKnowledgeSource[] {
  const scope = owner(input);
  const hidden = delivery === 'model' ? suppressed(input) : new Set<string>();
  return [...pointers(input).values()]
    .filter(({ source }) => !hidden.has(`source:${source.id}@${source.contentDigest}`))
    .map(({ source }) => ({ ...source, ownerScope: scope.ownerScope }));
}

/** Supplies current pointer identities to synchronous notebook validation, without another byte backend. */
export function readUserKnowledgeSourceMetadata(
  input: MemoryContext,
  sourceId: string,
  delivery: 'human' | 'model' = 'human'
): UserKnowledgeSource | null {
  owner(input);
  if (!KnowledgeSourceIdSchema.safeParse(sourceId).success)
    throw new OperationError('invalid_request', 'Invalid Source identity.', 400);
  return listUserKnowledgeSources(input, delivery).find((source) => source.id === sourceId) ?? null;
}

/** Reads exact bounded text through Storage after current self and suppression admission. */
export async function readUserKnowledgeSource(
  input: MemoryContext,
  sourceId: string,
  delivery: 'human' | 'model' = 'human'
): Promise<{ readonly source: UserKnowledgeSource; readonly content: string } | null> {
  const scope = owner(input);
  const source = readUserKnowledgeSourceMetadata(input, sourceId, delivery);
  if (!source) return null;
  const pointer = pointers(input).get(sourceId)!;
  const result = await readManagedSourceText({
    owner: scope,
    pointer,
    access: {
      coreDb: input.coreDb,
      actor: { kind: 'user', id: input.actor!.userId },
      requestActor: input.actor,
    },
  });
  owner(input);
  if (
    readUserKnowledgeSourceMetadata(input, sourceId, delivery)?.contentDigest !==
      source.contentDigest ||
    result.status !== 'ok'
  )
    return null;
  return { source, content: result.value };
}

/** Admits only current self literal Source versions before page disclosure or publication; source-free pages need no Source family. */
export function admitUserMemorySources(
  input: MemoryContext,
  files: Readonly<Record<string, string>>
): { registeredSources: Map<string, string | null>; sourceFingerprints: readonly string[] } {
  admitMemoryContext(input);
  const registeredSources = new Map<string, string | null>();
  const fingerprints = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) throw new NotebookError('invalid_request');
    const references = stringListFrontmatterField(parsed.document, 'source_refs');
    if (references === null) {
      if (!parsed.document.reserved || Object.hasOwn(parsed.document.frontmatter, 'source_refs'))
        throw new NotebookError('invalid_request');
      continue;
    }
    if (
      references.length &&
      (parsed.document.reserved ||
        !['user-authored', 'delegated', 'accepted'].includes(
          stringFrontmatterField(parsed.document, 'review_state') ?? ''
        ))
    )
      throw new NotebookError('invalid_request');
    for (const reference of references) {
      const { targetId } = resolveRegisteredKnowledgeSourceReference(reference, registeredSources);
      if (!targetId) throw new NotebookError('invalid_request');
      if (!registeredSources.has(targetId)) {
        const retained = readUserKnowledgeSourceMetadata(input, targetId);
        if (!retained) throw new NotebookError('invalid_request');
        registeredSources.set(targetId, retained.contentDigest);
      }
      if (!resolveRegisteredKnowledgeSourceReference(reference, registeredSources).resolved)
        throw new NotebookError('invalid_request');
      fingerprints.add(`source:${targetId}@${registeredSources.get(targetId)}`);
    }
  }
  admitMemoryContext(input);
  return { registeredSources, sourceFingerprints: [...fingerprints].sort() };
}

/** Captures one literal Source through the common managed-byte and Notebook publisher, retaining native receipts. */
export async function registerUserKnowledgeSource(
  input: UserKnowledgeSourceWriter,
  request: RegisterUserKnowledgeSourceInput
): Promise<UserKnowledgeSource> {
  const scope = owner(input);
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success || Buffer.from(parsed.data.content).toString('utf8') !== parsed.data.content)
    throw new OperationError('invalid_request', 'Invalid literal Source request.', 400);
  const command = parsed.data;
  return runIdempotentCommand({
    store: input.store,
    receiptDb: input.userDb,
    inflightCommands: input.inflightCommands,
    command: OPERATION,
    requestId: command.requestId,
    scope: { userId: input.userDb.userId, actorId: input.actor!.userId },
    input: { ownerScope: scope.ownerScope, ...command },
    responseKind: 'knowledge_source',
    responseId: (source) => source.id,
    replay: (receipt) => {
      const retained = readUserKnowledgeSourceMetadata(input, receipt.response.id);
      if (!retained) unavailable();
      return retained;
    },
    execute: async () => {
      const now = new Date().toISOString();
      const pointer = await publishCapturedSource(
        {
          owner: scope,
          database: { kind: 'user', userDb: input.userDb },
          access: {
            coreDb: input.coreDb,
            actor: { kind: 'user', id: input.actor!.userId },
            requestActor: input.actor,
          },
          producer: { kind: 'user', id: input.actor!.userId },
          requestId: command.requestId,
          commandInput: { ownerScope: scope.ownerScope, ...command },
          captureChannel: OPERATION,
          revalidatePublication: () => {
            owner(input);
          },
        },
        {
          id: allocateEntityId('ks'),
          kind: command.kind,
          title: command.title,
          uri: null,
          contentDigest: `sha256:${createHash('sha256').update(command.content).digest('hex')}`,
          originatingThreadId: null,
          originatingTurnId: null,
          originatingFileId: null,
          capturedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        Buffer.from(command.content)
      );
      return { ...pointer.source, ownerScope: scope.ownerScope };
    },
  });
}
