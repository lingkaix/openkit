import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { RegisterKnowledgeSourceRequestSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, KnowledgeSourceIdSchema, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { CoreDb } from '../storage/db.js';
import {
  readSourcePointers,
  type SourceMetadataSchema,
  type SourcePointer,
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

/** Current deployment authority, never Workspace membership or stored Source provenance. */
export interface ServerKnowledgeContext {
  readonly coreDb: CoreDb;
  readonly actor: Actor | undefined;
}
/** Existing Server API metadata projected from the common canonical pointer. */
export type ServerKnowledgeSource = z.infer<typeof SourceMetadataSchema> & {
  readonly ownerScope: { readonly kind: 'server' };
};
/** Explicit literal document capture with no model-selected storage location. */
export type RegisterServerKnowledgeSourceInput = z.infer<typeof RequestSchema>;
/** Native current actor plus the existing Core command owner. */
export interface ServerKnowledgeSourceWriter extends ServerKnowledgeContext {
  readonly store: FsStore;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
}

/** Checks current Server authority without inspecting Source content. */
export function admitsServerKnowledge(input: ServerKnowledgeContext): boolean {
  return Boolean(input.actor && isCurrentDeploymentAdministrator(input.coreDb, input.actor));
}
/** Resolves the canonical scope only after current deployment administration admission. */
function owner(input: ServerKnowledgeContext) {
  if (!admitsServerKnowledge(input))
    throw new OperationError('workspace_access_denied', 'Server Knowledge access denied.', 403);
  return { dataRoot: input.coreDb.dataRoot, ownerScope: { kind: 'server' as const } };
}
/** Distinguishes a source-free scope from lost established Notebook authority. */
function pointers(input: ServerKnowledgeContext): ReadonlyMap<string, SourcePointer> {
  const scope = owner(input);
  const root = sourceNotebookRoot(scope);
  if (!lstatSync(join(root, 'notebook.git'), { throwIfNoEntry: false })) {
    if (
      lstatSync(root, { throwIfNoEntry: false }) ||
      input.coreDb.sqlite
        .prepare(
          "SELECT 1 FROM audit_events WHERE workspace_id IS NULL AND action IN ('knowledge.notebook.initialize', 'knowledge.source.register') LIMIT 1"
        )
        .get()
    )
      throw new OperationError(
        'recovery_required',
        'Server Source storage requires recovery.',
        503
      );
    return new Map();
  }
  return readSourcePointers(scope);
}
/** Lists current Server metadata from published pointers; no registry or raw byte scan is used. */
export function listServerKnowledgeSources(input: ServerKnowledgeContext): ServerKnowledgeSource[] {
  const scope = owner(input);
  return [...pointers(input).values()].map(({ source }) => ({
    ...source,
    ownerScope: scope.ownerScope,
  }));
}
/** Supplies pointer identities to synchronous closure checks without starting another byte backend. */
export function readServerKnowledgeSourceMetadata(
  input: ServerKnowledgeContext,
  sourceId: string
): ServerKnowledgeSource | null {
  owner(input);
  if (!KnowledgeSourceIdSchema.safeParse(sourceId).success)
    throw new OperationError('invalid_request', 'Invalid Source identity.', 400);
  return listServerKnowledgeSources(input).find((source) => source.id === sourceId) ?? null;
}
/** Fetches exact bounded text through Storage under current Server Knowledge authority. */
export async function readServerKnowledgeSource(
  input: ServerKnowledgeContext,
  sourceId: string
): Promise<{ source: ServerKnowledgeSource; content: string } | null> {
  const scope = owner(input);
  const source = readServerKnowledgeSourceMetadata(input, sourceId);
  if (!source) return null;
  const result = await readManagedSourceText({
    owner: scope,
    pointer: pointers(input).get(sourceId)!,
    access: {
      coreDb: input.coreDb,
      actor: { kind: 'user', id: input.actor!.userId },
      requestActor: input.actor,
    },
  });
  owner(input);
  return result.status === 'ok' &&
    readServerKnowledgeSourceMetadata(input, sourceId)?.contentDigest === source.contentDigest
    ? { source, content: result.value }
    : null;
}
/** Captures literal Server information through the common managed-byte/Notebook publisher and Core receipts. */
export async function registerServerKnowledgeSource(
  input: ServerKnowledgeSourceWriter,
  request: RegisterServerKnowledgeSourceInput
): Promise<ServerKnowledgeSource> {
  const scope = owner(input);
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success || Buffer.from(parsed.data.content).toString('utf8') !== parsed.data.content)
    throw new OperationError('invalid_request', 'Invalid literal Source request.', 400);
  const command = parsed.data;
  return runIdempotentCommand({
    store: input.store,
    receiptDb: input.coreDb,
    inflightCommands: input.inflightCommands,
    command: OPERATION,
    requestId: command.requestId,
    scope: { coreId: 'server', actorId: input.actor!.userId },
    input: { ownerScope: scope.ownerScope, ...command },
    responseKind: 'knowledge_source',
    responseId: (source) => source.id,
    replay: (receipt) => {
      const source = readServerKnowledgeSourceMetadata(input, receipt.response.id);
      if (!source)
        throw new OperationError(
          'recovery_required',
          'Server Source storage requires recovery.',
          503
        );
      return source;
    },
    execute: async () => {
      const now = new Date().toISOString();
      const pointer = await publishCapturedSource(
        {
          owner: scope,
          database: { kind: 'server', coreDb: input.coreDb },
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
