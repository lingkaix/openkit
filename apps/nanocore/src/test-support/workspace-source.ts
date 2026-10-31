import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { readWorkspaceNotebookAdmission } from '../knowledge/notebook-workspace-admission.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { readSourcePointers } from '../knowledge/source-pointers.js';
import { publishCapturedSource } from '../knowledge/source-publication.js';
import { readManagedSourceText } from '../knowledge/source-reading.js';
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
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  const workspaceRoot = join(dataRoot, 'workspaces', source.workspaceId);
  const selection = readWorkspaceNotebookSelection({
    workspaceDb,
    workspaceRoot,
    knowledgeBaseId: readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: source.workspaceId },
    }),
  });
  const notebook = selection.notebook;
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
              baseRevision: selection.head.notebookCommit,
              changes: [],
              summary: 'Capture explicit fixture evidence.',
            },
            runtimeConfigManager: { current: () => snapshot },
            workspaceMutationAdmission,
            scopeSchemaText: selection.scopeSchemaText,
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

/** Reads the current canonical pointer through the real asynchronous Storage and authority boundary. */
export async function readWorkspaceSourceFixture(input: {
  readonly dataRoot: string;
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly userId: string;
  readonly workspaceId: string;
  readonly sourceId: string;
}) {
  const owner = {
    dataRoot: input.dataRoot,
    ownerScope: { kind: 'workspace' as const, workspaceId: input.workspaceId },
  };
  const workspaceDb = openWorkspaceDb(input.dataRoot, input.workspaceId);
  try {
    const selection = readWorkspaceNotebookSelection({
      workspaceDb,
      workspaceRoot: join(input.dataRoot, 'workspaces', input.workspaceId),
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot: input.dataRoot,
        scope: { kind: 'workspace', workspaceId: input.workspaceId },
      }),
    });
    const pointer = readSourcePointers(owner, undefined, selection).get(input.sourceId);
    if (!pointer) throw new Error('Fixture Source pointer is unavailable.');
    return readManagedSourceText({
      owner,
      pointer,
      access: {
        store: input.store,
        coreDb: input.coreDb,
        actor: { kind: 'user', id: input.userId },
        requestActor: { kind: 'local', userId: input.userId },
      },
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}
