import { join } from 'node:path';
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
export function readWorkspaceNotebookSelection(input: {
  readonly workspaceDb: Pick<WorkspaceDb, 'scope' | 'sqlite' | 'workspaceId'>;
  /** Actual admitted Workspace root; neither a database filename nor Git path may replace it. */
  readonly workspaceRoot: string;
  readonly knowledgeBaseId: string;
}): WorkspaceNotebookSelection {
  try {
    const head = readControlKnowledgeHead(input.workspaceDb, input.knowledgeBaseId);
    if (!head) throw new NotebookError('recovery_required');
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
    notebook.inspectRevision(head.notebookCommit);
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
