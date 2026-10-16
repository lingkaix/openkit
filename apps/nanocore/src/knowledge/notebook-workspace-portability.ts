import { join } from 'node:path';
import { KnowledgeOwnerScopeSchema } from '@openkit/protocol';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { parseOkfDocument, stringListFrontmatterField, updateOkfFrontmatter } from './okf.js';

/** Reads all exact pages from one published commit, including reserved navigation. */
export function readPortableWorkspaceNotebookPages(workspaceRoot: string): {
  readonly notebookRevision: string;
  readonly nativeKnowledgePages: ReadonlyMap<string, string>;
} {
  const notebook = new KnowledgeNotebook({ repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git') });
  const revision = notebook.publishedRevision();
  const snapshot = notebook.readRevision(revision);
  return { notebookRevision: revision, nativeKnowledgePages: new Map(Object.entries(snapshot.files).map(([path, content]) => [`knowledge/pages/${path}`, content])) };
}

/** Remints only owned scope and source fields; authored Markdown and other metadata remain intact. */
export function remintPortableWorkspaceNotebookPage(input: {
  readonly path: string;
  readonly content: string;
  readonly sourceWorkspaceId: string;
  readonly targetWorkspaceId: string;
  readonly rewriteReferences: (references: readonly string[]) => readonly string[];
}): string {
  const parsed = parseOkfDocument({ path: input.path, content: input.content });
  if (!parsed.ok) throw new NotebookError('invalid_request');
  if (parsed.document.reserved) return input.content;
  const sourceReferences = stringListFrontmatterField(parsed.document, 'source_refs');
  if (sourceReferences === null) throw new NotebookError('invalid_request');
  const scope = KnowledgeOwnerScopeSchema.safeParse(parsed.document.frontmatter.scope);
  if (!scope.success || scope.data.kind !== 'workspace' || scope.data.workspaceId !== input.sourceWorkspaceId)
    throw new NotebookError('invalid_request');
  const rewritten = input.rewriteReferences(sourceReferences);
  const scopeChanged = input.sourceWorkspaceId !== input.targetWorkspaceId;
  const sourcesChanged = rewritten.some((reference, index) => reference !== sourceReferences[index]);
  if (!scopeChanged && !sourcesChanged) return input.content;
  return updateOkfFrontmatter({
    path: input.path,
    content: input.content,
    updates: {
      ...(scopeChanged ? { scope: { kind: 'workspace', workspaceId: input.targetWorkspaceId } } : {}),
      ...(sourcesChanged ? { source_refs: [...rewritten] } : {}),
    },
  });
}

/** Converts the existing archive page map into the new target Notebook's initial tree. */
export function importedWorkspaceNotebookFiles(pages: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  for (const [path, content] of pages) {
    if (!path.startsWith('knowledge/pages/')) throw new NotebookError('invalid_request');
    files[path.slice('knowledge/pages/'.length)] = content;
  }
  return files;
}
