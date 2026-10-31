import { lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type KnowledgeNotebook, NotebookError, type NotebookRevision } from './notebook.js';
import type { WorkspaceNotebookSelection } from './notebook-workspace-selection.js';
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
  prepared?: WorkspaceNotebookRead,
  selection?: WorkspaceNotebookSelection
): NotebookIndexSource {
  if (!selection || selection.workspaceRoot !== workspaceRoot)
    throw new NotebookError('recovery_required');
  const notebook = selection.notebook;
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
  readonly notebook: KnowledgeNotebook;
  readonly selection: WorkspaceNotebookSelection;
  /** Exact SQL-selected schema bytes from the same head as the selected Notebook revision. */
  readonly scopeSchemaText: string;
  readonly schemaContentDigest: string;
  readonly current: NotebookRevision & { readonly entries: Readonly<Record<string, string>> };
  readonly selected: NotebookRevision & { readonly entries: Readonly<Record<string, string>> };
  readonly sources?: ReadonlyMap<string, SourcePointer>;
}

/** Reuses current content only while its published head is live; a changed head uses native current readers. */
export function currentWorkspaceNotebookRead(
  prepared: WorkspaceNotebookRead | undefined,
  workspaceRoot: string,
  selection?: WorkspaceNotebookSelection
): WorkspaceNotebookRead | undefined {
  if (!prepared) return undefined;
  if (prepared.workspaceRoot !== workspaceRoot) throw new NotebookError('recovery_required');
  if (!selection || selection.workspaceRoot !== workspaceRoot)
    throw new NotebookError('recovery_required');
  return prepared.current.revision === selection.head.notebookCommit &&
    prepared.schemaContentDigest === selection.head.schemaContent.reference.contentDigest
    ? prepared
    : undefined;
}

/** Loads inventory or exact selected content; neither view grants current authority. */
export async function prepareWorkspaceNotebookRead(input: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly notebookRevision?: string | undefined;
  readonly pageIds?: readonly string[] | undefined;
  readonly selection: WorkspaceNotebookSelection;
}): Promise<WorkspaceNotebookRead> {
  const workspaceRoot = join(input.dataRoot, 'workspaces', input.workspaceId);
  if (input.selection.workspaceRoot !== workspaceRoot) throw new NotebookError('recovery_required');
  const notebook = input.selection.notebook;
  const currentRevision = input.selection.head.notebookCommit;
  const revision = input.notebookRevision ?? currentRevision;
  if (input.notebookRevision !== undefined) await notebook.assertPublishedAncestryAsync(revision);
  const owner = {
    dataRoot: input.dataRoot,
    ownerScope: { kind: 'workspace' as const, workspaceId: input.workspaceId },
  };
  if (input.pageIds === undefined) {
    const root = lstatSync(sourceNotebookRoot(owner), { throwIfNoEntry: false });
    if (!root?.isDirectory() || root.isSymbolicLink()) throw new NotebookError('recovery_required');
  }
  const { sources: selectedSources, ...selected } = await notebook.readRevisionWithSourcesAsync(
    revision,
    {
      ...(input.pageIds !== undefined ? { pageIds: input.pageIds } : {}),
      sources: input.pageIds === undefined && revision === currentRevision,
    }
  );
  // Historical selection grants no permission to prefetch new current Page bodies or refused reference branches.
  let current = selected;
  let sourceContent = selectedSources;
  if (revision !== currentRevision) {
    if (input.pageIds === undefined) {
      const { sources, ...record } = await notebook.readRevisionWithSourcesAsync(currentRevision, {
        pageIds: [],
        sources: true,
      });
      current = record;
      sourceContent = sources;
    } else current = { ...(await notebook.inspectRevisionAsync(currentRevision)), files: {} };
  }
  // Exact selections keep Source metadata lazy, as the native selected reader does.
  const selectedHead = {
    scopeSchemaText: input.selection.scopeSchemaText,
    schemaContentDigest: input.selection.head.schemaContent.reference.contentDigest,
  };
  if (input.pageIds !== undefined)
    return {
      workspaceRoot,
      notebook,
      selection: input.selection,
      current,
      selected,
      ...selectedHead,
    };
  const root = lstatSync(sourceNotebookRoot(owner), { throwIfNoEntry: false });
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new NotebookError('recovery_required');
  if (!sourceContent) throw new NotebookError('recovery_required');
  const sources = new Map(
    Object.entries(sourceContent).map(([id, content]) => [
      id,
      parseSourcePointer(owner, id, content, input.selection),
    ])
  );
  return {
    workspaceRoot,
    notebook,
    selection: input.selection,
    current,
    selected,
    sources,
    ...selectedHead,
  };
}
