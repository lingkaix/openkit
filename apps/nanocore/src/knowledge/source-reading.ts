import { join, resolve } from 'node:path';
import { LocalStorage, type StorageResult } from '@openkit/storage';
import { readKnowledgeMounts } from '../config/knowledge-base.js';
import { deriveManagedSourceAccess, type ManagedSourceAdmission } from './managed-source-access.js';
import { readSourceText } from './source-bytes.js';
import {
  type SourcePointer,
  type SourcePointerOwner,
  sourceNotebookRoot,
} from './source-pointers.js';

/** Reads one current admitted managed Source with no alternate backend or stored authority. */
export async function readManagedSourceText(input: {
  readonly owner: SourcePointerOwner;
  readonly pointer: SourcePointer;
  readonly access: ManagedSourceAdmission['access'];
}): Promise<StorageResult<string>> {
  const mount = readKnowledgeMounts({
    dataRoot: input.owner.dataRoot,
    scope: input.owner.ownerScope,
  }).find((candidate) => candidate.name === input.pointer.fields.contentRef.locator.mount);
  if (!mount || mount.backend !== 'local')
    return {
      status: 'unavailable',
      reason: 'unsupported',
      reference: input.pointer.fields.contentRef,
    };
  const admit = () =>
    deriveManagedSourceAccess({
      owner: input.owner,
      knowledgeBaseId: input.pointer.fields.contentRef.knowledgeBaseId,
      mount,
      access: input.access,
      consumer: 'native',
      mode: 'read-only',
    });
  if (!admit()) return { status: 'denied' };
  const notebookRoot = sourceNotebookRoot(input.owner);
  const storage = new LocalStorage({
    mounts: [
      {
        name: mount.name,
        knowledgeBaseId: mount.knowledgeBaseId,
        ownerScope: input.owner.ownerScope,
        root: resolve(notebookRoot, mount.root),
        managed: true,
      },
    ],
    stagingRoot: join(notebookRoot, '.source-staging'),
  });
  try {
    return await readSourceText({ pointer: input.pointer, storage, admit });
  } finally {
    await storage.close();
  }
}
