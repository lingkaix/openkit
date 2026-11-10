import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readControlKnowledgeHead } from '../storage/control-store-knowledge-heads.js';
import type { WorkspaceDb } from '../storage/db.js';
import { readImmutableContentBytes } from '../storage/immutable-content-read.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { parseScopeKnowledgeSchema, type ScopeKnowledgeSchema } from './okf.js';

/** One exact Workspace SQL head and its verified immutable Git/schema content. */
export interface WorkspaceNotebookSelection {
  readonly workspaceRoot: string;
  readonly head: NonNullable<ReturnType<typeof readControlKnowledgeHead>>;
  readonly notebook: KnowledgeNotebook;
  readonly scopeSchemaText: string;
  readonly scopeSchema: ScopeKnowledgeSchema;
}

/**
 * Selects the current Workspace Notebook and schema from one physical SQL owner.
 *
 * The caller supplies both real private roots under its existing admission. Paths,
 * Git refs and authored YAML never infer authority or replace a missing SQL head.
 */
/** Private-root inputs retained across immutable preparation, never across authority checks. */
export interface WorkspaceNotebookSelectionInput {
  readonly workspaceDb: Pick<WorkspaceDb, 'scope' | 'sqlite' | 'workspaceId'>;
  /** Actual admitted Workspace root; neither a database filename nor Git path may replace it. */
  readonly workspaceRoot: string;
  readonly knowledgeBaseId: string;
  /** Verified immutable facts from this call chain; never a retained admission decision. */
  readonly preparedSelection?: WorkspaceNotebookSelection | undefined;

  /** Final native admission must not fall back to synchronous Git after a changed head. */
  readonly requirePreparedMatch?: boolean;
  /** Additional exact historical revisions consumed by this publication/replay only. */
  readonly revisions?: readonly string[];
  /** Editors prepare only the exact selected body set; full publication leaves this absent. */
  readonly readPaths?: readonly string[];
  readonly sources?: boolean;
}

/** Reads the existing synchronous selection for callers that do not prepare immutable facts. */
export function readWorkspaceNotebookSelection(
  input: WorkspaceNotebookSelectionInput
): WorkspaceNotebookSelection {
  return selectWorkspaceNotebook(input, true);
}

/** Prepares one current immutable selection, with at most one fresh read after a concurrent head change. */
export async function prepareWorkspaceNotebookReads(
  input: WorkspaceNotebookSelectionInput
): Promise<WorkspaceNotebookSelection> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const selection = selectWorkspaceNotebook(
      { ...input, preparedSelection: undefined, requirePreparedMatch: false },
      false
    );
    const notebook = await selection.notebook.withPreparedReadsAsync(
      [...new Set([selection.head.notebookCommit, ...(input.revisions ?? [])])],
      {
        ...(input.readPaths ? { paths: input.readPaths } : {}),
        ...(input.sources !== undefined ? { sources: input.sources } : {}),
      }
    );
    if (
      isDeepStrictEqual(
        readControlKnowledgeHead(input.workspaceDb, input.knowledgeBaseId),
        selection.head
      )
    )
      return { ...selection, notebook };
  }
  throw new NotebookError('conflict');
}

/** Schema/root selection shares the original synchronous checks; only Git scheduling differs. */
function selectWorkspaceNotebook(
  input: WorkspaceNotebookSelectionInput,
  inspect: boolean
): WorkspaceNotebookSelection {
  try {
    const head = readControlKnowledgeHead(input.workspaceDb, input.knowledgeBaseId);
    if (!head) throw new NotebookError('recovery_required');
    if (
      input.preparedSelection?.workspaceRoot === input.workspaceRoot &&
      isDeepStrictEqual(input.preparedSelection.head, head)
    ) {
      // Reuse verified bytes, not the mount/path or Git-root checks of the live readers.
      const contentRoot = join(input.workspaceRoot, 'knowledge', 'content');
      const contentParent = dirname(
        resolve(contentRoot, head.schemaContent.reference.locator.path)
      );
      if (
        realpathSync(contentRoot) !== resolve(contentRoot) ||
        realpathSync(contentParent) !== contentParent
      )
        throw new NotebookError('recovery_required');
      const repository = lstatSync(join(input.workspaceRoot, 'knowledge', 'notebook.git'));
      if (!repository.isDirectory() || repository.isSymbolicLink())
        throw new NotebookError('recovery_required');
      return { ...input.preparedSelection, head };
    }
    if (input.requirePreparedMatch) throw new NotebookError('conflict');
    const owner = { kind: 'workspace' as const, workspaceId: input.workspaceDb.workspaceId };
    const bytes = readImmutableContentBytes(
      {
        root: join(input.workspaceRoot, 'knowledge', 'content'),
        knowledgeBaseId: input.knowledgeBaseId,
        mount: head.schemaContent.reference.locator.mount,
      },
      owner,
      head.schemaContent,
      head.schemaContent.byteLength
    );
    const scopeSchemaText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = parseScopeKnowledgeSchema(scopeSchemaText);
    if (!parsed.ok) throw new NotebookError('recovery_required');
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(input.workspaceRoot, 'knowledge', 'notebook.git'),
      selectedRevision: head.notebookCommit,
    });
    if (inspect) notebook.inspectRevision(head.notebookCommit);
    return {
      workspaceRoot: input.workspaceRoot,
      head,
      notebook,
      scopeSchemaText,
      scopeSchema: parsed.schema,
    };
  } catch (error) {
    if (error instanceof NotebookError) throw error;
    throw new NotebookError('recovery_required');
  }
}
