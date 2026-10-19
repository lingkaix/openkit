import { randomUUID } from 'node:crypto';
import type { KnowledgeNotebookPageSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import { FIXTURE_LOCAL_USER_ID } from './local-user.js';

/** Creates current authored notebook bytes and explicit attribution for a synthetic import fixture. */
export function notebookImportFixture(input: {
  readonly workspaceId: string;
  readonly knowledge: readonly z.infer<typeof KnowledgeNotebookPageSchema>[];
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
      input.knowledge.map((page) => [page.path, page.content])
    ),
  };
}
