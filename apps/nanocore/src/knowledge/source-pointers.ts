import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { KnowledgeSourceSchema } from '@openkit/app-api-schemas';
import {
  ContentReferenceSchema,
  type KnowledgeOwnerScope,
  KnowledgeOwnerScopeSchema,
  KnowledgeSourceIdSchema,
} from '@openkit/protocol';
import { stringify } from 'yaml';
import { z } from 'zod';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  serverKnowledgeRoot,
  userMemoryRoot,
  WorkOwnershipViolationError,
} from '../storage/fs-layout.js';
import { readCanonicalTextFile } from '../storage/workspace-file-records.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import {
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  REQUIRED_SCOPED_KNOWLEDGE_FEATURES,
  validateScopeKnowledgeSchema,
} from './okf.js';

/** Existing Source metadata, projected from the sole Notebook pointer rather than a registry. */
export const SourceMetadataSchema = KnowledgeSourceSchema.omit({ workspaceId: true }).extend({
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

/** Captured Source fields have one serialized meaning across User, Workspace and Server. */
export const SourcePointerFieldsSchema = z.object({
  contentRef: ContentReferenceSchema.refine((reference) => reference.range === null),
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  sourceKind: SourceMetadataSchema.shape.kind,
  uri: SourceMetadataSchema.shape.uri,
  capturedAt: z.iso.datetime({ offset: true }),
  captureChannel: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
  originatingThreadId: SourceMetadataSchema.shape.originatingThreadId,
  originatingTurnId: SourceMetadataSchema.shape.originatingTurnId,
  originatingFileId: SourceMetadataSchema.shape.originatingFileId,
});

/** Current native owner and its canonical Notebook; this locator supplies no authorization. */
export interface SourcePointerOwner {
  readonly dataRoot: string;
  readonly ownerScope: KnowledgeOwnerScope;
}

/** Exact canonical pointer with the existing public metadata projection and original byte descriptor. */
export interface SourcePointer {
  readonly source: z.infer<typeof SourceMetadataSchema>;
  readonly fields: z.infer<typeof SourcePointerFieldsSchema>;
  readonly content: string;
}

/** Derives the existing scope content root without allocating authority or a Knowledge Base. */
export function sourceNotebookRoot(owner: SourcePointerOwner): string {
  const scope = owner.ownerScope;
  return scope.kind === 'workspace'
    ? join(owner.dataRoot, 'workspaces', scope.workspaceId, 'knowledge')
    : scope.kind === 'user'
      ? userMemoryRoot(owner.dataRoot, scope.userId)
      : serverKnowledgeRoot(owner.dataRoot);
}

/** Validates the Source identity, scope, original descriptor and governed profile from exact Git bytes. */
export function parseSourcePointer(
  owner: SourcePointerOwner,
  id: string,
  content: string
): SourcePointer {
  return decodeSourcePointer({
    ownerScope: owner.ownerScope,
    knowledgeBaseId: readDefaultKnowledgeBaseId({
      dataRoot: owner.dataRoot,
      scope: owner.ownerScope,
    }),
    scopeSchemaText: readCanonicalTextFile(
      join(sourceNotebookRoot(owner), 'schema', 'scope-schema.yaml')
    ),
    id,
    content,
  });
}

/** Validates verified import bytes against explicit scope and schema facts, without granting access. */
export function decodeSourcePointer(input: {
  readonly ownerScope: KnowledgeOwnerScope;
  readonly knowledgeBaseId: string;
  readonly scopeSchemaText: string;
  readonly id: string;
  readonly content: string;
}): SourcePointer {
  const { ownerScope, knowledgeBaseId, scopeSchemaText, id, content } = input;
  try {
    KnowledgeSourceIdSchema.parse(id);
    const parsed = parseOkfDocument({ path: `sources/${id}.md`, content });
    if (!parsed.ok || parsed.document.frontmatter.type !== 'SourceSummary')
      throw new NotebookError('recovery_required');
    const schema = parseScopeKnowledgeSchema(scopeSchemaText);
    if (!schema.ok) throw new NotebookError('recovery_required');
    const declaredScope = KnowledgeOwnerScopeSchema.safeParse(parsed.document.frontmatter.scope);
    const profile = validateScopeKnowledgeSchema(
      parsed.document,
      schema.schema,
      declaredScope.success ? declaredScope.data : ownerScope
    );
    if (profile.conformance !== 'scope-schema-valid' || profile.errors.length)
      throw new NotebookError('recovery_required');
    const fields = SourcePointerFieldsSchema.parse(parsed.document.frontmatter);
    const source = SourceMetadataSchema.parse({
      id,
      kind: fields.sourceKind,
      title: parsed.document.frontmatter.title,
      uri: fields.uri,
      contentDigest: fields.contentRef.contentDigest,
      originatingThreadId: fields.originatingThreadId,
      originatingTurnId: fields.originatingTurnId,
      originatingFileId: fields.originatingFileId,
      capturedAt: fields.capturedAt,
      createdAt: parsed.document.frontmatter.created_at,
      updatedAt: parsed.document.frontmatter.updated_at,
    });
    // SourceSummary.scope owns this record; a locator inside its content cannot select that owner.
    if (declaredScope.success && !isDeepStrictEqual(declaredScope.data, ownerScope)) {
      throw new WorkOwnershipViolationError(`SourceSummary ${id}`);
    }
    if (
      !isDeepStrictEqual(fields.contentRef.locator.ownerScope, ownerScope) ||
      fields.contentRef.knowledgeBaseId !== knowledgeBaseId
    )
      throw new NotebookError('recovery_required');
    return { source, fields, content };
  } catch (error) {
    if (error instanceof WorkOwnershipViolationError) throw error;
    throw new NotebookError('recovery_required');
  }
}

/** Serializes native captured facts; descriptions and summary never choose owner, digest or channel. */
export function serializeSourcePointer(input: {
  readonly owner: SourcePointerOwner;
  readonly source: z.infer<typeof SourceMetadataSchema>;
  readonly fields: z.infer<typeof SourcePointerFieldsSchema>;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}): string {
  const source = SourceMetadataSchema.parse(input.source);
  const fields = SourcePointerFieldsSchema.parse(input.fields);
  if (
    fields.contentRef.contentDigest !== source.contentDigest ||
    fields.sourceKind !== source.kind ||
    fields.capturedAt !== source.capturedAt ||
    fields.uri !== source.uri ||
    fields.originatingThreadId !== source.originatingThreadId ||
    fields.originatingTurnId !== source.originatingTurnId ||
    fields.originatingFileId !== source.originatingFileId
  )
    throw new NotebookError('invalid_request');
  const schema = parseScopeKnowledgeSchema(
    readCanonicalTextFile(join(sourceNotebookRoot(input.owner), 'schema', 'scope-schema.yaml'))
  );
  if (!schema.ok) throw new NotebookError('recovery_required');
  const content = `---\n${stringify({
    okf_version: '0.2',
    type: 'SourceSummary',
    title: source.title,
    schema_version: schema.schema.schemaVersion,
    openkit_status: 'active',
    scope: input.owner.ownerScope,
    requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
    source_refs: [],
    review_state: 'user-authored',
    sensitivity: input.owner.ownerScope.kind === 'user' ? 'confidential' : 'internal',
    freshness: 'current',
    created_at: source.createdAt,
    updated_at: source.updatedAt,
    ...fields,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  })}---\n${input.summary ?? ''}`;
  const parsed = parseOkfDocument({ path: `sources/${source.id}.md`, content });
  if (!parsed.ok) throw new NotebookError('invalid_request');
  const profile = validateScopeKnowledgeSchema(
    parsed.document,
    schema.schema,
    input.owner.ownerScope
  );
  if (profile.conformance !== 'scope-schema-valid' || profile.errors.length)
    throw new NotebookError('invalid_request');
  parseSourcePointer(input.owner, source.id, content);
  return content;
}

/** Reads metadata at one published revision; callers must admit current owner/audience before disclosure. */
export function readSourcePointers(
  owner: SourcePointerOwner,
  revision?: string
): ReadonlyMap<string, SourcePointer> {
  const root = lstatSync(sourceNotebookRoot(owner), { throwIfNoEntry: false });
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new NotebookError('recovery_required');
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(sourceNotebookRoot(owner), 'notebook.git'),
  });
  const selected = revision ?? notebook.publishedRevision();
  if (revision !== undefined) notebook.history({ revision, limit: 1 });
  return new Map(
    Object.entries(notebook.readSourcePointers(selected)).map(([id, content]) => [
      id,
      parseSourcePointer(owner, id, content),
    ])
  );
}
