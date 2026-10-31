import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { closeTestCoreDb, createTestWorkspaceDb } from './store.js';

/**
 * Selects prepared retained-content corruption in an existing private fixture only.
 * Invalid historical bytes cannot pass normal native publication. This fault changes
 * only the existing SQL-selected commit, creates no Audit or receipt, and advances
 * no Git ref. The caller stops all readers/writers before disposing its private root.
 */
export function corruptTestWorkspaceNotebookCommit(
  dataRoot: string,
  workspaceId: string,
  notebookCommit: string
): void {
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId },
  });
  const workspaceDb = createTestWorkspaceDb(dataRoot, workspaceId);
  try {
    const original = workspaceDb.sqlite
      .prepare('SELECT record_json FROM knowledge_notebook_heads WHERE knowledge_base_id = ?')
      .get(knowledgeBaseId) as { record_json: string } | undefined;
    if (!original) throw new Error('Retained-content corruption requires an existing native head.');
    const changed = workspaceDb.sqlite
      .prepare(
        "UPDATE knowledge_notebook_heads SET record_json = json_set(record_json, '$.notebookCommit', ?) WHERE knowledge_base_id = ? AND record_json = ?"
      )
      .run(notebookCommit, knowledgeBaseId, original.record_json);
    if (changed.changes !== 1) throw new Error('Retained-content corruption lost its exact head.');
  } finally {
    closeTestCoreDb(workspaceDb);
  }
}
