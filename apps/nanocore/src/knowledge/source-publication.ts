import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  type ActorRef,
  type KnowledgeNotebookAdmission,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import {
  LocalStorage,
  STORAGE_LIMITS,
  type StorageAccess,
  type StorageResult,
} from '@openkit/storage';
import type { z } from 'zod';
import {
  recordServerAuditEvent,
  recordUserAuditEvent,
  recordWorkspaceAuditEvent,
} from '../audit-events.js';
import { initializeDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import { OperationError } from '../operation-error.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { ensureCanonicalDirectory, writeFileAtomic } from '../storage/workspace-file-records.js';
import { deriveManagedSourceAccess, type ManagedSourceAdmission } from './managed-source-access.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { initializeNotebook } from './notebook-initialization.js';
import type { NotebookPublicationOwner } from './notebook-publication.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';
import {
  readSourcePointers,
  SourceMetadataSchema,
  type SourcePointer,
  type SourcePointerOwner,
  serializeSourcePointer,
  sourceNotebookRoot,
} from './source-pointers.js';

/** Existing scoped owners supply current authority, attribution, Audit and the command receipt boundary. */
export interface SourcePublication {
  readonly owner: SourcePointerOwner;
  readonly database: NotebookPublicationOwner;
  readonly access: ManagedSourceAdmission['access'];
  readonly producer: Extract<ActorRef, { kind: 'user' | 'agent' }>;
  readonly requestId: string;
  readonly commandInput: unknown;
  readonly captureChannel: string;
  readonly revalidatePublication: () => void;
}

/** Preserves typed Storage refusal without exposing backend paths or inventing successful bytes. */
function requireStorage<T>(result: StorageResult<T>): T {
  if (result.status === 'ok') return result.value;
  throw new OperationError(
    result.status === 'denied' ? 'workspace_access_denied' : 'knowledge_source_unavailable',
    'Knowledge Source bytes are unavailable.',
    result.status === 'denied' ? 403 : 503
  );
}

/** Resolves the existing scoped database into the exact durable Notebook owner. */
function validateDatabase(input: SourcePublication): void {
  const database =
    input.database.kind === 'workspace'
      ? input.database.workspaceDb
      : input.database.kind === 'user'
        ? input.database.userDb
        : input.database.coreDb;
  const scope = input.owner.ownerScope;
  if (
    resolve(database.dataRoot) !== resolve(input.owner.dataRoot) ||
    input.database.kind !== scope.kind ||
    (scope.kind === 'workspace' &&
      (input.database.kind !== 'workspace' ||
        input.database.workspaceDb.workspaceId !== scope.workspaceId)) ||
    (scope.kind === 'user' &&
      (input.database.kind !== 'user' || input.database.userDb.userId !== scope.userId))
  )
    throw new NotebookError('invalid_request');
}

/** Captures exact managed originals and publishes their sole SourceSummary through the existing Git/Audit boundary. */
export async function publishCapturedSource(
  input: SourcePublication,
  sourceInput: z.infer<typeof SourceMetadataSchema>,
  bytes: Uint8Array
): Promise<SourcePointer> {
  input.revalidatePublication();
  validateDatabase(input);
  if (
    !input.access.requestActor ||
    responsibleUserIdForActor(input.producer) !== input.access.requestActor.userId
  )
    throw new NotebookError('invalid_request');
  const source = SourceMetadataSchema.parse(sourceInput);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== source.contentDigest || bytes.byteLength > STORAGE_LIMITS.contentBytes)
    throw new NotebookError('invalid_request');
  const knowledgeBaseId = initializeDefaultKnowledgeBaseId({
    dataRoot: input.owner.dataRoot,
    scope: input.owner.ownerScope,
  });
  const mount = readKnowledgeMounts({
    dataRoot: input.owner.dataRoot,
    scope: input.owner.ownerScope,
  }).find((candidate) => candidate.default)!;
  const admit = (): StorageAccess => {
    input.revalidatePublication();
    const access = deriveManagedSourceAccess({
      owner: input.owner,
      knowledgeBaseId,
      mount,
      access: input.access,
      consumer: 'native',
      mode: 'staged-write',
      revalidatePublication: input.revalidatePublication,
    });
    if (!access)
      throw new OperationError(
        'workspace_access_denied',
        'Knowledge Source publication denied.',
        403
      );
    return access;
  };
  admit();
  const notebookRoot = sourceNotebookRoot(input.owner);
  const notebook = new KnowledgeNotebook({ repositoryPath: join(notebookRoot, 'notebook.git') });
  if (!existsSync(join(notebookRoot, 'notebook.git'))) {
    if (existsSync(notebookRoot)) throw new NotebookError('recovery_required');
    initializeNotebook({
      notebookRoot,
      owner: input.database,
      initialization: {
        requestId: input.requestId,
        producer: { kind: 'user', id: input.access.requestActor.userId },
        instructionReference: `${input.captureChannel}:${input.requestId}`,
      },
      revalidate: () => {
        admit();
        return {
          scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
          reviewRequiredPageIds: [],
          registeredSources: new Map(),
          resolvedReferences: new Map(),
        };
      },
    });
  }
  const baseRevision = notebook.publishedRevision();
  if (readSourcePointers(input.owner, baseRevision).has(source.id))
    throw new NotebookError('conflict', baseRevision);
  const root = resolve(notebookRoot, mount.root);
  const path = `sources/${source.id}/original`;
  const destination = join(root, path);
  if (existsSync(destination)) throw new NotebookError('conflict', baseRevision);
  const storage = new LocalStorage({
    mounts: [
      {
        knowledgeBaseId,
        ownerScope: input.owner.ownerScope,
        name: mount.name,
        root,
        managed: true,
      },
    ],
    stagingRoot: join(notebookRoot, '.source-staging'),
  });
  try {
    const { handle } = requireStorage(
      await storage.beginStage({
        access: admit(),
        locator: { ownerScope: input.owner.ownerScope, mount: mount.name, path },
        maxByteLength: bytes.byteLength,
      })
    );
    for (let offset = 0; offset < bytes.byteLength; offset += STORAGE_LIMITS.chunkBytes)
      requireStorage(
        await storage.writeStage({
          access: admit(),
          handle,
          data: Buffer.from(bytes.subarray(offset, offset + STORAGE_LIMITS.chunkBytes)).toString(
            'base64'
          ),
        })
      );
    const staged = requireStorage(await storage.finishStage({ access: admit(), handle }));
    if (
      staged.content.reference.contentDigest !== digest ||
      staged.content.byteLength !== bytes.byteLength
    )
      throw new NotebookError('recovery_required');
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += STORAGE_LIMITS.chunkBytes) {
      const result = requireStorage(
        await storage.readStage({
          access: admit(),
          handle,
          offset,
          length: Math.min(STORAGE_LIMITS.chunkBytes, bytes.byteLength - offset),
        })
      );
      chunks.push(Buffer.from(result.data, 'base64'));
    }
    const content = serializeSourcePointer({
      owner: input.owner,
      source,
      fields: {
        contentRef: staged.content.reference,
        byteLength: staged.content.byteLength,
        mediaType: staged.content.mediaType,
        sourceKind: source.kind,
        uri: source.uri,
        capturedAt: source.capturedAt,
        captureChannel: input.captureChannel,
        originatingThreadId: source.originatingThreadId,
        originatingTurnId: source.originatingTurnId,
        originatingFileId: source.originatingFileId,
      },
    });
    const metadata = {
      summary: `Capture Source: ${source.title}`,
      changeRequest: {
        requestId: input.requestId,
        inputDigest: commandInputHash(input.commandInput),
      },
      producer: input.producer,
      authority: {
        kind: 'direct' as const,
        instructionReference: `${input.captureChannel}:${input.requestId}`,
      },
      sourceReferences: [],
    };
    const candidateRevision = notebook.prepareSourcePointers({
      baseRevision,
      changes: { [source.id]: content },
      metadata,
    });
    const evidence: KnowledgeNotebookAdmission = {
      ownerScope: input.owner.ownerScope,
      requestId: input.requestId,
      inputDigest: metadata.changeRequest.inputDigest,
      baseRevision,
      candidateRevision,
      producer: metadata.producer,
      authority: metadata.authority,
      sourceReferences: [],
    };
    const audit = (action: string) => {
      const event = {
        requestId: input.requestId,
        actor: input.producer,
        category: 'knowledge' as const,
        action,
        resource: `knowledge-source:${source.id}`,
        outcome: 'succeeded' as const,
        summary: 'Source captured under current Knowledge authority.',
        notebookAdmission: evidence,
      };
      if (input.database.kind === 'workspace')
        recordWorkspaceAuditEvent({
          ...event,
          workspaceDb: input.database.workspaceDb,
          workspaceId: input.database.workspaceDb.workspaceId,
        });
      else if (input.database.kind === 'user')
        recordUserAuditEvent({ ...event, userDb: input.database.userDb });
      else recordServerAuditEvent({ ...event, coreDb: input.database.coreDb });
    };
    admit();
    ensureCanonicalDirectory(dirname(destination));
    writeFileAtomic(destination, Buffer.concat(chunks));
    audit('knowledge.notebook.admit');
    admit();
    notebook.publish({ baseRevision, candidateRevision });
    audit(input.captureChannel);
    return readSourcePointers(input.owner).get(source.id)!;
  } finally {
    await storage.close();
  }
}
