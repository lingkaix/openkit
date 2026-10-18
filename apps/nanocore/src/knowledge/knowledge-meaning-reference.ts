import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  type KnowledgeOwnerScope,
  parseReferenceScope,
  parseReferenceUri,
} from '@openkit/protocol';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  admitKnowledgeRetrieval,
  admitServerKnowledgeRetrieval,
  type KnowledgeRetrievalAccess,
  knowledgePageDelegated,
  readAuthorizedServerNotebookPages,
  readAuthorizedWorkspaceNotebookPages,
} from '../retrieval-knowledge-adapter.js';
import { readCanonicalTextFile } from '../storage/workspace-file-records.js';
import { KnowledgeNotebook, validateNotebookFiles } from './notebook.js';
import {
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  stringFrontmatterField,
  validateScopeKnowledgeSchema,
} from './okf.js';

/** One request-local exact meaning read; it grants neither publication nor execution authority. */
export type KnowledgeMeaningResolution =
  | {
      readonly status: 'available';
      readonly reference: string;
      readonly notebookRevision: string;
      readonly contentDigest: string;
      readonly content: string;
    }
  | { readonly status: 'unavailable'; readonly reference: string };

/**
 * Resolves a pinned page URI through its current owner and bounded published ancestry.
 *
 * The Native caller supplies existing access, never a request-selected owner or filesystem path. Exact inspection can retain archived/superseded context, but grants no active-fact, publication or execution authority. Raw content remains unavailable until its Storage/Source reader is activated; it is never treated as page or legacy registry content.
 */
export function resolveKnowledgeMeaningReference(input: {
  readonly workspaceId: string;
  readonly reference: string;
  readonly access: KnowledgeRetrievalAccess;
}): KnowledgeMeaningResolution {
  const unavailable = { status: 'unavailable' as const, reference: input.reference };
  try {
    const parsed = parseReferenceUri(input.reference);
    const scope = parsed && parseReferenceScope(parsed.reference.scopeId);
    const dataRoot = input.access.store.getDataRoot();
    if (
      !parsed?.contentDigest ||
      !scope ||
      scope.family !== 'page' ||
      scope.kind === 'user' ||
      !dataRoot ||
      !input.access.coreDb ||
      (scope.kind === 'workspace' && scope.workspaceId !== input.workspaceId)
    )
      return unavailable;
    const server = scope.kind === 'server';
    const target = { dataRoot, workspaceId: input.workspaceId, access: input.access };
    if (server) admitServerKnowledgeRetrieval(target);
    else admitKnowledgeRetrieval(target);
    const ownerScope: KnowledgeOwnerScope = server
      ? { kind: 'server' }
      : { kind: 'workspace', workspaceId: input.workspaceId };
    const binding = () => readDefaultKnowledgeBaseId({ dataRoot, scope: ownerScope });
    if (binding() !== scope.knowledgeBaseId) return unavailable;
    const id = parsed.reference.objectId;
    const path = `${id}.md`;
    // Reuse the Notebook's path and exact UTF-8 delivery bounds before any selected Git read.
    validateNotebookFiles({ [path]: '' }, true);
    const notebookRoot = server
      ? join(dataRoot, 'server', 'knowledge')
      : join(dataRoot, 'workspaces', input.workspaceId, 'knowledge');
    const currentSchema = () =>
      parseScopeKnowledgeSchema(
        readCanonicalTextFile(join(notebookRoot, 'schema', 'scope-schema.yaml'))
      );
    const read = (notebookRevision?: string) =>
      (server ? readAuthorizedServerNotebookPages : readAuthorizedWorkspaceNotebookPages)({
        ...target,
        pageIds: [id],
        ...(notebookRevision === undefined ? {} : { notebookRevision }),
      });
    const valid = (selected: ReturnType<typeof read>) => {
      const schema = currentSchema();
      if (!schema.ok) return false;
      const page = selected.pages[0];
      if (!page || page.id !== id) return false;
      validateNotebookFiles({ [path]: page.content }, true);
      const doc = parseOkfDocument({ path, content: page.content });
      if (!doc.ok) return false;
      const report = validateScopeKnowledgeSchema(doc.document, schema.schema, ownerScope);
      const sensitivity = stringFrontmatterField(doc.document, 'sensitivity');
      const state = stringFrontmatterField(doc.document, 'openkit_status');
      const review = stringFrontmatterField(doc.document, 'review_state');
      return (
        report.conformance === 'scope-schema-valid' &&
        report.errors.length === 0 &&
        sensitivity !== 'restricted' &&
        sensitivity !== 'confidential' &&
        state !== 'invalid' &&
        state !== 'deleted' &&
        (review === 'user-authored' ||
          ((review === 'accepted' ||
            (review === 'delegated' &&
              knowledgePageDelegated(
                { ...target, notebookRevision: selected.notebookRevision },
                id,
                page.content,
                server ? 'server' : 'workspace'
              ))) &&
            selected.referenceProofs.has(id)))
      );
    };
    const current = read();
    if (!valid(current)) return unavailable;
    const hash = (content: string) =>
      `sha256:${createHash('sha256').update(content).digest('hex')}`;
    let selected = current;
    if (hash(current.pages[0]!.content) !== parsed.contentDigest) {
      const notebook = new KnowledgeNotebook({
        repositoryPath: join(notebookRoot, 'notebook.git'),
      });
      let revision: string | null = current.notebookRevision;
      let previousBlob: string | undefined;
      let match: string | undefined;
      // The existing history boundary permits at most 100 published records per request.
      for (let count = 0; revision && count < 100; count++) {
        const record = notebook.inspectRevision(revision);
        const blob = record.entries[path];
        if (blob && blob !== previousBlob) {
          const content = notebook.readRevision(revision, [path]).files[path]!;
          if (hash(content) === parsed.contentDigest) {
            match = revision;
            break;
          }
        }
        previousBlob = blob;
        revision = record.parentRevision;
      }
      if (!match) return unavailable;
      selected = read(match);
    }
    if (!valid(selected) || hash(selected.pages[0]!.content) !== parsed.contentDigest)
      return unavailable;
    // Historical bytes do not retain permission when the current page, Source or actor changes.
    if (binding() !== scope.knowledgeBaseId || !valid(read())) return unavailable;
    return {
      status: 'available',
      reference: input.reference,
      notebookRevision: selected.notebookRevision,
      contentDigest: parsed.contentDigest,
      content: selected.pages[0]!.content,
    };
  } catch {
    // Scope existence, denied metadata and internal storage errors share the same bounded result.
    return unavailable;
  }
}
