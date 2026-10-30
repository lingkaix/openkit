import type { PreviewKnowledgeSchemaResponse } from '@openkit/app-api-schemas';
import { compareCodeUnits, parseReferenceScope } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { type KnowledgeNotebook, NotebookError } from './notebook.js';
import {
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  validateScopeKnowledgeSchema,
} from './okf.js';
import { decodeSourcePointer } from './source-pointers.js';

/** Checks every current Notebook member without preparing content, rebuilding indexes or writing history. */
export function previewNotebookSchema(input: {
  readonly workspaceId: string;
  readonly notebook: KnowledgeNotebook;
  readonly scopeSchemaText: string;
  readonly candidateSchemaText: string;
  readonly pageScopeId: string;
  readonly registeredSources: ReadonlyMap<string, string | null>;
  /** Native current read/write and complete Source admission; this check supplies no authority. */
  readonly revalidate: () => void;
}): PreviewKnowledgeSchemaResponse {
  input.revalidate();
  const revision = input.notebook.publishedRevision();
  const files = input.notebook.readContent(revision);
  const ownerScope = { kind: 'workspace' as const, workspaceId: input.workspaceId };
  const scope = parseReferenceScope(input.pageScopeId);
  if (
    scope?.family !== 'page' ||
    scope.kind !== 'workspace' ||
    scope.workspaceId !== input.workspaceId
  )
    throw new NotebookError('invalid_request');
  if (!parseScopeKnowledgeSchema(input.scopeSchemaText).ok)
    throw new NotebookError('recovery_required');
  const schema = parseScopeKnowledgeSchema(input.candidateSchemaText);
  const diagnostics = (errors: readonly { code: string; field?: string }[]) =>
    errors.map(({ code, field }) => ({ code, ...(field === undefined ? {} : { field }) }));
  const records: PreviewKnowledgeSchemaResponse['records'] = [];
  for (const path of Object.keys(files).sort(compareCodeUnits)) {
    const content = files[path]!;
    const parsed = parseOkfDocument({ path, content });
    const errors: { code: string; field?: string }[] = [];
    if (!parsed.ok) errors.push(...diagnostics(parsed.errors));
    else if (parsed.document.reserved) {
      if (path === 'index.md' && parsed.document.frontmatter.okf_version !== '0.2')
        errors.push({ code: 'notebook.invalid_document' });
    } else {
      if (path.startsWith('@sources/')) {
        // Captured identity must already be sound under the current owner before inspecting a new schema.
        const id = path.slice('@sources/'.length, -3);
        const pointer = decodeSourcePointer({
          ownerScope,
          knowledgeBaseId: scope.knowledgeBaseId,
          scopeSchemaText: input.scopeSchemaText,
          id,
          content,
        });
        if (input.registeredSources.get(id) !== pointer.source.contentDigest)
          throw new NotebookError('recovery_required');
      }
      errors.push(
        ...diagnostics(
          schema.ok
            ? validateScopeKnowledgeSchema(parsed.document, schema.schema, ownerScope).errors
            : schema.errors
        )
      );
    }
    const state = parsed.ok ? parsed.document.frontmatter.openkit_status : undefined;
    records.push({
      path,
      status:
        errors.length === 0
          ? 'valid'
          : state === 'draft' || state === 'invalid'
            ? 'invalid-draft'
            : 'needs-review',
      diagnostics: errors,
    });
  }
  input.revalidate();
  if (input.notebook.publishedRevision() !== revision) throw new NotebookError('conflict');
  return {
    workspaceId: input.workspaceId,
    notebookRevision: revision,
    baseSchemaDigest: `sha256:${sha256Hex(input.scopeSchemaText)}`,
    candidateSchemaDigest: `sha256:${sha256Hex(input.candidateSchemaText)}`,
    coverage: 'notebook',
    completeMigration: false,
    schemaDiagnostics: diagnostics(schema.errors),
    records,
  };
}
