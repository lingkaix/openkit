import { basename, join } from 'node:path';
import { KnowledgeNotebook } from './notebook.js';

/** Request-local content input for rebuildable indexes; it carries no read or mutation grant. */
export interface NotebookIndexSource {
  readonly notebookRevision: string;
  readonly pages: ReadonlyMap<string, string>;
}

/**
 * Reads a single current or retained published revision from the canonical Git content owner.
 * Index maintenance has no caller disclosure effect. Retrieval must separately admit the
 * current actor and source audience before using any indexed identity or page bytes.
 */
export function readWorkspaceNotebookIndexSource(
  workspaceRoot: string,
  revision?: string
): NotebookIndexSource {
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  const notebookRevision = revision ?? notebook.publishedRevision();
  if (revision !== undefined) notebook.history({ revision, limit: 1 });
  const { files } = notebook.readRevision(notebookRevision);
  return {
    notebookRevision,
    pages: new Map(Object.entries(files)
      .filter(([path]) => !['index.md', 'log.md'].includes(basename(path)))
      .map(([path, content]) => [path.slice(0, -3), content])),
  };
}
