import { randomUUID } from 'node:crypto';
import type { FsStore } from '../lib/store.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { FIXTURE_LOCAL_USER_ID } from './local-user.js';

/** Creates current authored notebook bytes and explicit attribution for a synthetic import fixture. */
export function notebookImportFixture(input: {
  readonly workspaceId: string;
  readonly knowledge: readonly Parameters<typeof serializeUserAuthoredKnowledgePage>[0][];
  readonly userId?: string;
}): Pick<
  Parameters<FsStore['importWorkspaceSnapshot']>[0],
  'notebookInitialization' | 'initialNotebookFiles'
> {
  return {
    notebookInitialization: {
      requestId: randomUUID(),
      producer: { kind: 'user', id: input.userId ?? FIXTURE_LOCAL_USER_ID },
      instructionReference: 'test-fixture:workspace-import',
    },
    initialNotebookFiles: Object.fromEntries(
      input.knowledge.map((entry) => [
        `${entry.id}.md`,
        serializeUserAuthoredKnowledgePage(entry, {
          kind: 'workspace',
          workspaceId: input.workspaceId,
        }),
      ])
    ),
  };
}
