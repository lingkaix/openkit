import type { PreviewKnowledgeSchemaResponse } from '@openkit/app-api-schemas';
import { canonicalJsonText, compareCodeUnits, parseReferenceScope } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { NotebookError } from './notebook-error.js';
import { projectWorkspaceKnowledgeIndexes } from './notebook-index-projection.js';
import {
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  validateScopeKnowledgeSchema,
} from './okf.js';
import { decodeSourcePointer } from './source-pointers.js';

/** Exact Notebook facts; this result supplies neither selection nor publication authority. */
type NotebookSchemaPreview = Omit<
  PreviewKnowledgeSchemaResponse,
  'coverage' | 'dependencyInventory' | 'inventoryComplete'
> & { readonly coverage: 'notebook' };

/** Classifies every exact Page and Source against a candidate without reading or changing an owner. */
export function previewNotebookSchemaContent(input: {
  readonly workspaceId: string;
  readonly notebookRevision: string;
  readonly files: Readonly<Record<string, string>>;
  readonly scopeSchemaText: string;
  readonly candidateSchemaText: string;
  readonly pageScopeId: string;
  readonly registeredSources: ReadonlyMap<string, string | null>;
}): NotebookSchemaPreview {
  const { files, notebookRevision: revision } = input;
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

/** Checks complete candidate-tree bytes without selecting a Proposal, current head or authority. */
export function schemaCandidateTreeNeedsReview(input: {
  readonly workspaceId: string;
  readonly files: Readonly<Record<string, string>>;
  readonly candidateSchemaText: string;
}): boolean {
  const candidate = parseScopeKnowledgeSchema(input.candidateSchemaText);
  return Object.entries(input.files).some(([path, content]) => {
    const parsed = parseOkfDocument({ path, content });
    return (
      !parsed.ok ||
      (!parsed.document.reserved &&
        (!candidate.ok ||
          validateScopeKnowledgeSchema(parsed.document, candidate.schema, {
            kind: 'workspace',
            workspaceId: input.workspaceId,
          }).errors.length > 0))
    );
  });
}

/** Compares exact content-derived indexes without reading or publishing their sidecar files. */
export function previewSchemaIndexImpact(input: {
  readonly files: Readonly<Record<string, string>>;
  readonly scopeSchemaText: string;
  readonly candidateSchemaText: string;
  readonly pageScopeId: string;
  readonly registeredSources: ReadonlyMap<string, string | null>;
}): Array<{
  readonly id: 'validation' | 'source-references' | 'links';
  readonly needsReview: boolean;
  readonly before: readonly unknown[];
  readonly after: readonly unknown[];
}> {
  const candidate = parseScopeKnowledgeSchema(input.candidateSchemaText);
  const pages = new Map(
    Object.entries(input.files)
      .filter(([path]) => !path.startsWith('@sources/'))
      .map(([path, text]) => [path.slice(0, -3), text])
  );
  const projection = (scopeSchemaText: string) =>
    projectWorkspaceKnowledgeIndexes({
      pages,
      pageScopeId: input.pageScopeId,
      scopeSchemaText,
      registeredSources: input.registeredSources,
    });
  const currentIndexes = projection(input.scopeSchemaText);
  const proposedIndexes = projection(input.candidateSchemaText);
  const digest = (value: unknown) => `sha256:${sha256Hex(canonicalJsonText(value))}`;
  const indexChanged = digest(currentIndexes.records) !== digest(proposedIndexes.records);
  return (
    [
      ['validation', currentIndexes.records, proposedIndexes.records],
      ['source-references', currentIndexes.references, proposedIndexes.references],
      ['links', currentIndexes.edges, proposedIndexes.edges],
    ] as const
  ).map(([id, before, after]) => ({
    id,
    needsReview: !candidate.ok || indexChanged || digest(before) !== digest(after),
    before,
    after,
  }));
}
