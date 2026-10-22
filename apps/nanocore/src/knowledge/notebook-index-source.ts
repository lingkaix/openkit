import { lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { KnowledgeNotebook, NotebookError, type NotebookRevision } from './notebook.js';
import { parseSourcePointer, type SourcePointer, sourceNotebookRoot } from './source-pointers.js';

/** Request-local content input for rebuildable indexes; it carries no read or mutation grant. */
export interface NotebookIndexSource {
  readonly notebookRevision: string;
  readonly pages: ReadonlyMap<string, string>;
}

/**
 * Reads a single current or retained published revision from the canonical Git content owner.
 * Index maintenance has no caller disclosure effect. Retrieval must separately admit the
 * current actor and source audience before using any indexed identity or page bytes.
 * An explicit page selection loads only present selected blobs; missing pages remain absent.
 */
export function readWorkspaceNotebookIndexSource(
  workspaceRoot: string,
  revision?: string,
  pageIds?: readonly string[],
  prepared?: WorkspaceNotebookRead
): NotebookIndexSource {
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  if (prepared && prepared.workspaceRoot !== workspaceRoot)
    throw new NotebookError('recovery_required');
  const notebookRevision = revision ?? prepared?.current.revision ?? notebook.publishedRevision();
  if (!prepared && revision !== undefined) notebook.history({ revision, limit: 1 });
  const record =
    prepared &&
    (notebookRevision === prepared.current.revision ? prepared.current : prepared.selected);
  if (record && record.revision !== notebookRevision) throw new NotebookError('recovery_required');
  const paths = pageIds?.map((id) => `${id}.md`);
  const entries = paths
    ? (record?.entries ?? notebook.inspectRevision(notebookRevision).entries)
    : undefined;
  const present = paths ? paths.filter((path) => Object.hasOwn(entries!, path)) : undefined;
  const files = record
    ? Object.fromEntries(
        Object.entries(record.files).filter(([path]) => !present || present.includes(path))
      )
    : notebook.readRevision(notebookRevision, present).files;
  return {
    notebookRevision,
    pages: new Map(
      Object.entries(files)
        .filter(([path]) => !['index.md', 'log.md'].includes(basename(path)))
        .map(([path, content]) => [path.slice(0, -3), content])
    ),
  };
}

/** One content-only request selection; live authority must be checked after its asynchronous load. */
export interface WorkspaceNotebookRead {
  readonly workspaceRoot: string;
  readonly current: NotebookRevision & { readonly entries: Readonly<Record<string, string>> };
  readonly selected: NotebookRevision & { readonly entries: Readonly<Record<string, string>> };
  readonly sources: ReadonlyMap<string, SourcePointer>;
}

/** Reuses current content only while its published head is live; a changed head uses native current readers. */
export function currentWorkspaceNotebookRead(
  prepared: WorkspaceNotebookRead | undefined,
  workspaceRoot: string
): WorkspaceNotebookRead | undefined {
  if (!prepared) return undefined;
  if (prepared.workspaceRoot !== workspaceRoot) throw new NotebookError('recovery_required');
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  return notebook.publishedRevision() === prepared.current.revision ? prepared : undefined;
}

/** Loads the existing complete query inventory once; no permission or current-head grant survives I/O. */
export async function prepareWorkspaceNotebookRead(input: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly notebookRevision?: string | undefined;
}): Promise<WorkspaceNotebookRead> {
  const workspaceRoot = join(input.dataRoot, 'workspaces', input.workspaceId);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  const currentRevision = await notebook.publishedRevisionAsync();
  const revision = input.notebookRevision ?? currentRevision;
  if (input.notebookRevision !== undefined) await notebook.assertPublishedAncestryAsync(revision);
  const record = await notebook.inspectRevisionAsync(revision);
  const paths = Object.keys(record.entries).filter(
    (path) => !['index.md', 'log.md'].includes(basename(path))
  );
  const selected = { ...record, files: (await notebook.readRevisionAsync(revision, paths)).files };
  // Historical selection grants no permission to prefetch new current Page bodies or refused reference branches.
  const current =
    revision === currentRevision
      ? selected
      : { ...(await notebook.inspectRevisionAsync(currentRevision)), files: {} };
  const owner = {
    dataRoot: input.dataRoot,
    ownerScope: { kind: 'workspace' as const, workspaceId: input.workspaceId },
  };
  const root = lstatSync(sourceNotebookRoot(owner), { throwIfNoEntry: false });
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new NotebookError('recovery_required');
  const sources = new Map(
    Object.entries(await notebook.readSourcePointersAsync(currentRevision)).map(([id, content]) => [
      id,
      parseSourcePointer(owner, id, content),
    ])
  );
  return { workspaceRoot, current, selected, sources };
}
