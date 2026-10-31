import type { KnowledgeNotebook } from './notebook.js';
import { NotebookError } from './notebook-error.js';
import { previewNotebookSchemaContent } from './scope-schema-impact.js';

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
}): ReturnType<typeof previewNotebookSchemaContent> {
  input.revalidate();
  const revision = input.notebook.publishedRevision();
  const files = input.notebook.readContent(revision);
  const report = previewNotebookSchemaContent({
    workspaceId: input.workspaceId,
    notebookRevision: revision,
    files,
    scopeSchemaText: input.scopeSchemaText,
    candidateSchemaText: input.candidateSchemaText,
    pageScopeId: input.pageScopeId,
    registeredSources: input.registeredSources,
  });
  input.revalidate();
  if (input.notebook.publishedRevision() !== revision) throw new NotebookError('conflict');
  return report;
}
