import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { readWorkspaceNotebookAdmission } from '../knowledge/notebook-workspace-admission.js';
import { publishCapturedSource } from '../knowledge/source-publication.js';
import type { FsStore, KnowledgeSourceRecord } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

/** Publishes exact fixture bytes under an already-authorized real User; it creates no principal or grant. */
export async function captureWorkspaceSourceFixture(input: {
  readonly dataRoot: string;
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly userId: string;
  readonly source: KnowledgeSourceRecord;
  readonly content: string | Uint8Array;
}): Promise<KnowledgeSourceRecord> {
  const { dataRoot, coreDb, store, userId, source } = input;
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  const workspaceDb = openWorkspaceDb(dataRoot, source.workspaceId);
  applyScopedMigrations(workspaceDb);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', source.workspaceId, 'knowledge', 'notebook.git'),
  });
  const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const requestId = randomUUID();
  try {
    await publishCapturedSource(
      {
        owner: { dataRoot, ownerScope: { kind: 'workspace', workspaceId: source.workspaceId } },
        database: { kind: 'workspace', workspaceDb },
        access: { store, coreDb, actor, requestActor },
        producer: actor,
        requestId,
        commandInput: source,
        captureChannel: 'knowledge.source.register',
        revalidatePublication: () => {
          readWorkspaceNotebookAdmission({
            store,
            coreDb,
            workspaceDb,
            notebook,
            actor,
            requestActor,
            request: {
              workspaceId: source.workspaceId,
              requestId,
              baseRevision: notebook.publishedRevision(),
              changes: [],
              summary: 'Capture explicit fixture evidence.',
            },
            runtimeConfigManager: { current: () => snapshot },
            workspaceMutationAdmission,
          });
        },
      },
      source,
      typeof input.content === 'string' ? Buffer.from(input.content) : input.content
    );
    return store.getKnowledgeSource(source.workspaceId, source.id);
  } finally {
    workspaceDb.sqlite.close();
  }
}
