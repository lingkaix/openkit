import { randomUUID } from 'node:crypto';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { publishWorkspaceNotebook } from '../knowledge/notebook-publication.js';
import { readWorkspaceNotebookAdmission } from '../knowledge/notebook-workspace-admission.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { closeTestCoreDb, createTestWorkspaceDb } from './store.js';
import { readTestWorkspaceNotebookSelection } from './workspace-notebook.js';

/** Publishes supplied valid bytes through actual current human admission and the native SQL/Audit/receipt tuple. */
export async function publishTestWorkspaceNotebook(input: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly userId: string;
  readonly changes: Readonly<Record<string, string | null>>;
}) {
  const selection = readTestWorkspaceNotebookSelection(input.dataRoot, input.workspaceId);
  const workspaceDb = createTestWorkspaceDb(input.dataRoot, input.workspaceId);
  const actor = { kind: 'user' as const, id: input.userId };
  const request = {
    workspaceId: input.workspaceId,
    requestId: randomUUID(),
    baseRevision: selection.head.notebookCommit,
    changes: Object.entries(input.changes).map(([path, content]) => ({ path, content })),
    summary: 'Publish exact fixture content through the native Workspace owner',
  };
  const authority = {
    store: input.store,
    coreDb: input.coreDb,
    workspaceDb,
    actor,
    requestActor: { kind: 'local' as const, userId: input.userId },
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot: input.dataRoot }),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    notebook: selection.notebook,
    scopeSchemaText: selection.scopeSchemaText,
    request,
  };
  const confirmedRemovals = Object.fromEntries(
    request.changes
      .filter(({ content }) => content === null)
      .map(({ path }) => [
        path,
        selection.notebook.readRevision(request.baseRevision, [path]).files[path]!,
      ])
  );
  try {
    return await publishWorkspaceNotebook(
      {
        store: input.store,
        workspaceDb,
        notebook: selection.notebook,
        producer: actor,
        inflightCommands: new WeakMap(),
        confirmedRemovals,
        revalidate: () => readWorkspaceNotebookAdmission(authority),
      },
      request
    );
  } finally {
    closeTestCoreDb(workspaceDb);
  }
}
