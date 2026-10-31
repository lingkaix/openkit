import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type ActorRef,
  KnowledgeContentReferenceSchema,
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
  prepareAuditEvent,
  recordServerAuditEvent,
  recordUserAuditEvent,
} from '../audit-events.js';
import {
  initializeDefaultKnowledgeBaseId,
  readDefaultKnowledgeBaseId,
  readKnowledgeMounts,
} from '../config/knowledge-base.js';
import { OperationError } from '../operation-error.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type IdempotentCommandReceipt,
} from '../runtime/idempotent-command.js';
import { prepareWorkspaceKnowledgeSelection } from '../storage/control-store-knowledge.js';
import { ensureCanonicalDirectory, writeFileAtomic } from '../storage/workspace-file-records.js';
import { deriveManagedSourceAccess, type ManagedSourceAdmission } from './managed-source-access.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { initializeNotebook } from './notebook-initialization.js';
import type { NotebookPublicationOwner } from './notebook-publication.js';
import { readWorkspaceNotebookSelection } from './notebook-workspace-selection.js';
import { createDefaultScopeKnowledgeSchemaText } from './okf.js';
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
  readonly producer: ActorRef & { readonly kind: 'user' | 'agent' };
  readonly requestId: string;
  readonly commandInput: unknown;
  readonly captureChannel: string;
  /** Direct registration supplies its original receipt; maintenance already owns its Turn receipt. */
  readonly receipt?: IdempotentCommandReceipt;
  /** The existing semantic owner can refuse with false or throw its original typed refusal. */
  readonly revalidatePublication: (() => void) | (() => boolean);
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
function validateDatabase(input: Pick<SourcePublication, 'owner' | 'database'>): void {
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

/** Checks established capture identities against the sole published pointer tree, without repairing missing content. */
export function readPublishedSourcePointers(
  owner: SourcePointerOwner,
  database: NotebookPublicationOwner
): ReadonlyMap<string, SourcePointer> {
  validateDatabase({ owner, database });
  const db =
    database.kind === 'workspace'
      ? database.workspaceDb
      : database.kind === 'user'
        ? database.userDb
        : database.coreDb;
  const workspaceId = owner.ownerScope.kind === 'workspace' ? owner.ownerScope.workspaceId : null;
  const captures = db.sqlite
    .prepare(
      "SELECT resource FROM audit_events WHERE workspace_id IS ? AND action = 'knowledge.source.register'"
    )
    .all(workspaceId) as { resource: string | null }[];
  const selection =
    database.kind === 'workspace'
      ? readWorkspaceNotebookSelection({
          workspaceDb: database.workspaceDb,
          workspaceRoot: join(owner.dataRoot, 'workspaces', database.workspaceDb.workspaceId),
          knowledgeBaseId: readDefaultKnowledgeBaseId({
            dataRoot: owner.dataRoot,
            scope: owner.ownerScope,
          }),
        })
      : undefined;
  const root = sourceNotebookRoot(owner);
  if (!selection && !lstatSync(join(root, 'notebook.git'), { throwIfNoEntry: false })) {
    if (
      lstatSync(root, { throwIfNoEntry: false }) ||
      captures.length ||
      db.sqlite
        .prepare(
          "SELECT 1 FROM audit_events WHERE workspace_id IS ? AND action = 'knowledge.notebook.initialize' LIMIT 1"
        )
        .get(workspaceId)
    )
      throw new NotebookError('recovery_required');
    return new Map();
  }
  const pointers = readSourcePointers(owner, undefined, selection);
  for (const { resource } of captures)
    if (
      !resource?.startsWith('knowledge-source:') ||
      !pointers.has(resource.slice('knowledge-source:'.length))
    )
      throw new NotebookError('recovery_required');
  return pointers;
}

/** Captures exact managed originals and publishes their sole SourceSummary through the owning scope head and Audit boundary. */
export async function publishCapturedSource(
  input: SourcePublication,
  sourceInput: z.infer<typeof SourceMetadataSchema>,
  bytes: Uint8Array
): Promise<SourcePointer> {
  const release =
    input.owner.ownerScope.kind === 'workspace'
      ? input.access.store?.enterWorkspaceMutation(input.owner.ownerScope.workspaceId)
      : undefined;
  try {
    admit(true);
    validateDatabase(input);
    readPublishedSourcePointers(input.owner, input.database);
    const database =
      input.database.kind === 'workspace'
        ? input.database.workspaceDb
        : input.database.kind === 'user'
          ? input.database.userDb
          : input.database.coreDb;
    const prior = database.sqlite
      .prepare(
        "SELECT notebook_admission_json FROM audit_events WHERE workspace_id IS ? AND request_id = ? AND action = 'knowledge.notebook.admit' AND resource LIKE 'knowledge-source:%' LIMIT 1"
      )
      .get(
        input.owner.ownerScope.kind === 'workspace' ? input.owner.ownerScope.workspaceId : null,
        input.requestId
      ) as { notebook_admission_json: string | null } | undefined;
    // An admitted capture without its command completion is unknown, never a second capture or inferred success.
    if (prior) {
      const evidence = prior.notebook_admission_json
        ? (JSON.parse(prior.notebook_admission_json) as KnowledgeNotebookAdmission)
        : null;
      if (evidence && evidence.inputDigest !== commandInputHash(input.commandInput))
        throw new IdempotencyKeyConflictError();
      throw new NotebookError('recovery_required');
    }
    if (
      !responsibleUserIdForActor(input.access.actor) ||
      responsibleUserIdForActor(input.producer) !== responsibleUserIdForActor(input.access.actor)
    )
      throw new NotebookError('invalid_request');
    const source = SourceMetadataSchema.parse(sourceInput);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== source.contentDigest || bytes.byteLength > STORAGE_LIMITS.contentBytes)
      throw new NotebookError('invalid_request');
    const knowledgeBaseId = (
      input.database.kind === 'workspace'
        ? readDefaultKnowledgeBaseId
        : initializeDefaultKnowledgeBaseId
    )({
      dataRoot: input.owner.dataRoot,
      scope: input.owner.ownerScope,
    });
    const mounts = readKnowledgeMounts({
      dataRoot: input.owner.dataRoot,
      scope: input.owner.ownerScope,
    });
    // The managed capture namespace must not shadow an already declared external mount.
    if (mounts.some((candidate) => !candidate.default && candidate.name === 'sources'))
      throw new NotebookError('invalid_request');
    const mount = mounts.find((candidate) => candidate.default)!;
    // Initial semantic admission precedes private reads; Storage facts are checked once selected below.
    function admit(revalidateOnly: true): void;
    function admit(revalidateOnly?: false): StorageAccess;
    function admit(revalidateOnly = false): StorageAccess | undefined {
      let allowed = input.revalidatePublication() !== false;
      const access =
        allowed && !revalidateOnly
          ? deriveManagedSourceAccess({
              owner: input.owner,
              knowledgeBaseId,
              mount,
              access: input.access,
              consumer: 'native',
              mode: 'staged-write',
              revalidatePublication: () => {
                allowed = input.revalidatePublication() !== false;
              },
            })
          : null;
      if (!allowed || (!revalidateOnly && !access))
        throw new OperationError(
          'workspace_access_denied',
          'Knowledge Source publication denied.',
          403
        );
      if (!revalidateOnly) return access!;
    }
    admit();
    const notebookRoot = sourceNotebookRoot(input.owner);
    const selection =
      input.database.kind === 'workspace'
        ? readWorkspaceNotebookSelection({
            workspaceDb: input.database.workspaceDb,
            workspaceRoot: join(
              input.owner.dataRoot,
              'workspaces',
              input.database.workspaceDb.workspaceId
            ),
            knowledgeBaseId,
          })
        : undefined;
    const notebook =
      selection?.notebook ??
      new KnowledgeNotebook({ repositoryPath: join(notebookRoot, 'notebook.git') });
    if (!selection && !existsSync(join(notebookRoot, 'notebook.git'))) {
      if (existsSync(notebookRoot)) throw new NotebookError('recovery_required');
      const scopeSchemaText = createDefaultScopeKnowledgeSchemaText(new Date().toISOString());
      initializeNotebook({
        notebookRoot,
        owner: input.database,
        initialization: {
          requestId: input.requestId,
          producer: input.access.requestActor
            ? { kind: 'user', id: input.access.requestActor.userId }
            : { kind: 'system', id: 'notebook-initializer', responsibleUserId: null },
          instructionReference: `${input.captureChannel}:${input.requestId}`,
        },
        revalidate: () => {
          admit();
          return {
            scopeSchemaText,
            reviewRequiredPageIds: [],
            registeredSources: new Map(),
            resolvedReferences: new Map(),
          };
        },
      });
    }
    const baseRevision = notebook.publishedRevision();
    if (readSourcePointers(input.owner, baseRevision, selection).has(source.id))
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
        ...(selection ? { workspaceSelection: selection } : {}),
        fields: {
          contentRef: KnowledgeContentReferenceSchema.parse(staged.content.reference),
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
        if (input.database.kind === 'user')
          recordUserAuditEvent({ ...event, userDb: input.database.userDb });
        else if (input.database.kind === 'server')
          recordServerAuditEvent({ ...event, coreDb: input.database.coreDb });
      };
      const workspaceDb =
        input.database.kind === 'workspace' ? input.database.workspaceDb : undefined;
      const nextHead =
        workspaceDb && selection
          ? await prepareWorkspaceKnowledgeSelection({
              db: workspaceDb,
              workspaceRoot: join(input.owner.dataRoot, 'workspaces', workspaceDb.workspaceId),
              notebook,
              knowledgeBaseId,
              notebookCommit: candidateRevision,
              schemaText: selection.scopeSchemaText,
            })
          : undefined;
      admit();
      if (workspaceDb && selection && nextHead) {
        const revalidatePublication = (): void => {
          admit();
          const current = readWorkspaceNotebookSelection({
            workspaceDb,
            workspaceRoot: join(input.owner.dataRoot, 'workspaces', workspaceDb.workspaceId),
            knowledgeBaseId,
          });
          if (
            !isDeepStrictEqual(current.head, selection.head) ||
            current.scopeSchemaText !== selection.scopeSchemaText
          )
            throw new NotebookError('conflict');
        };
        revalidatePublication();
        ensureCanonicalDirectory(dirname(destination));
        writeFileAtomic(destination, Buffer.concat(chunks));
        const receipt = input.receipt;
        const receiptRecord = receipt
          ? {
              key: receipt.key,
              command: receipt.command,
              requestId: receipt.requestId,
              scope: receipt.scope,
              inputHash: receipt.inputHash,
              createdAt: receipt.createdAt,
              expiresAt: receipt.expiresAt,
              response: { kind: receipt.responseKind, id: source.id },
            }
          : undefined;
        if (!input.access.store) throw new NotebookError('recovery_required');
        await input.access.store.commitWorkspaceKnowledge({
          workspaceDb,
          expectedHead: selection.head,
          nextHead,
          audits: ['knowledge.notebook.admit', input.captureChannel].map((action) =>
            prepareAuditEvent({
              workspaceId: workspaceDb.workspaceId,
              requestId: input.requestId,
              actor: input.producer,
              category: 'knowledge',
              action,
              resource: `knowledge-source:${source.id}`,
              outcome: 'succeeded',
              summary: 'Source captured under current Knowledge authority.',
              notebookAdmission: evidence,
            })
          ),
          ...(receiptRecord ? { receipt: receiptRecord } : {}),
          revalidatePublication,
        });
        admit();
        const published = readWorkspaceNotebookSelection({
          workspaceDb,
          workspaceRoot: join(input.owner.dataRoot, 'workspaces', workspaceDb.workspaceId),
          knowledgeBaseId,
        });
        return readSourcePointers(input.owner, undefined, published).get(source.id)!;
      }
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
  } finally {
    release?.();
  }
}
