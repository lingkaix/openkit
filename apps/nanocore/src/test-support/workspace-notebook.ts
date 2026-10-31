import { join } from 'node:path';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { closeTestCoreDb, createTestWorkspaceDb } from './store.js';

/** Reads one real admitted Workspace SQL selection; creates no schema, content or authority. */
export function readTestWorkspaceNotebookSelection(dataRoot: string, workspaceId: string) {
  const workspaceDb = createTestWorkspaceDb(dataRoot, workspaceId);
  try {
    return readWorkspaceNotebookSelection({
      workspaceDb,
      workspaceRoot: join(dataRoot, 'workspaces', workspaceId),
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot,
        scope: { kind: 'workspace', workspaceId },
      }),
    });
  } finally {
    closeTestCoreDb(workspaceDb);
  }
}
