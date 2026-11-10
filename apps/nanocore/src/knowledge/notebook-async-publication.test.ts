import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import {
  call,
  createOwners,
  currentNotebookRevision,
} from '../test-support/knowledge-proposal-authority.js';
import {
  createTestCoreDb,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { KnowledgeNotebook } from './notebook.js';
import { publishWorkspaceNotebook } from './notebook-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import {
  prepareWorkspaceNotebookReads,
  readWorkspaceNotebookSelection,
  type WorkspaceNotebookSelection,
} from './notebook-workspace-selection.js';

/** Real physical Workspace, original native publication tuple, and current owner admission. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-async-publication-'));
  const store = await createDemoStore({ dataRoot });
  const coreDb = createTestCoreDb(dataRoot);
  const workspaceDb = createTestWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  onTestFinished(() => disposeTestStore(dataRoot, workspaceDb, coreDb));
  const selectionInput = {
    workspaceDb,
    workspaceRoot: join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID),
    knowledgeBaseId: readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
    }),
  };
  let selection = await prepareWorkspaceNotebookReads(selectionInput);
  const initial = selection;
  const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
  const request = {
    workspaceId: DEMO_WORKSPACE_ID,
    requestId: randomUUID(),
    baseRevision: selection.head.notebookCommit,
    summary: 'Explicit native publication',
    changes: [{ path: 'index.md', content: '---\nokf_version: "0.2"\n---\n# Updated\n' }],
  };
  let authorized = true;
  const denied = new Error('Current publication authority revoked');
  const revalidate = (prepared?: WorkspaceNotebookSelection) => {
    if (prepared) selection = prepared;
    return readWorkspaceNotebookAdmission({
      store,
      coreDb,
      workspaceDb,
      actor,
      currentAuthority: () => {
        if (!authorized) throw denied;
      },
      notebook: selection.notebook,
      preparedSelection: selection,
      scopeSchemaText: selection.scopeSchemaText,
      request,
      reviewRequiredPageIds: [],
    });
  };
  return {
    store,
    workspaceDb,
    initial,
    request,
    selectionInput,
    denied,
    revoke: () => {
      authorized = false;
    },
    publish: () =>
      publishWorkspaceNotebook(
        {
          store,
          workspaceDb,
          notebook: selection.notebook,
          producer: actor,
          revalidate,
          inflightCommands: new WeakMap(),
        },
        request
      ),
  };
}

it('publishes through the real native owner without synchronous Git in live Source admission', async () => {
  const f = await fixture();
  const synchronous = vi.spyOn(childProcess, 'execFileSync');
  syncBuiltinESMExports();
  onTestFinished(() => {
    synchronous.mockRestore();
    syncBuiltinESMExports();
  });
  const result = await f.publish();
  expect(result.outcome).toBe('published');
  expect(result.notebookRevision).not.toBe(f.initial.head.notebookCommit);
  expect(synchronous).not.toHaveBeenCalled();
  synchronous.mockRestore();
  syncBuiltinESMExports();
  const current = readWorkspaceNotebookSelection(f.selectionInput);
  expect(current.head.notebookCommit).toBe(result.notebookRevision);
  expect(current.notebook.readRevision(result.notebookRevision).files['index.md']).toBe(
    f.request.changes[0]!.content
  );
});

it('rechecks current authority after native opening and refuses before the deciding publication', async () => {
  const f = await fixture();
  const client = getControlStoreWorkerClient();
  const original = client.open.bind(client);
  const opening = vi.spyOn(client, 'open').mockImplementation(async (...args) => {
    const result = await original(...args);
    f.revoke();
    return result;
  });
  onTestFinished(() => opening.mockRestore());
  await expect(f.publish()).rejects.toBe(f.denied);
  expect(opening).toHaveBeenCalled();
  expect(readWorkspaceNotebookSelection(f.selectionInput).head).toEqual(f.initial.head);
  expect(
    f.store
      .listCommandRequests(DEMO_WORKSPACE_ID)
      .some((row) => row.requestId === f.request.requestId)
  ).toBe(false);
});

it('prepares at most twice when the native selected head changes during immutable I/O', async () => {
  const f = await fixture();
  const original = KnowledgeNotebook.prototype.withPreparedReadsAsync;
  let preparations = 0;
  let publishing = false;
  // Change the real head through the existing native publisher after the first read completes.
  const prepare = vi
    .spyOn(KnowledgeNotebook.prototype, 'withPreparedReadsAsync')
    .mockImplementation(async function (this: KnowledgeNotebook, ...args) {
      const prepared = await original.apply(this, args);
      if (!publishing && ++preparations === 1) {
        publishing = true;
        try {
          await f.publish();
        } finally {
          publishing = false;
        }
      }
      return prepared;
    });
  onTestFinished(() => prepare.mockRestore());
  const selected = await prepareWorkspaceNotebookReads(f.selectionInput);
  expect(preparations).toBe(2);
  expect(selected.head.notebookCommit).not.toBe(f.initial.head.notebookCommit);
  expect(selected.notebook.readRevision(selected.head.notebookCommit).files['index.md']).toBe(
    f.request.changes[0]!.content
  );
});

it('refuses a second real head change after exactly one fresh preparation', async () => {
  const f = await fixture();
  const original = KnowledgeNotebook.prototype.withPreparedReadsAsync;
  let preparations = 0;
  let publishing = false;
  const prepare = vi
    .spyOn(KnowledgeNotebook.prototype, 'withPreparedReadsAsync')
    .mockImplementation(async function (this: KnowledgeNotebook, ...args) {
      const prepared = await original.apply(this, args);
      if (!publishing) {
        preparations++;
        publishing = true;
        try {
          const publication = await f.publish();
          f.request.baseRevision = publication.notebookRevision;
          f.request.requestId = randomUUID();
          f.request.changes[0]!.content += 'A concurrent human change.\n';
        } finally {
          publishing = false;
        }
      }
      return prepared;
    });
  onTestFinished(() => prepare.mockRestore());
  await expect(prepareWorkspaceNotebookReads(f.selectionInput)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(preparations).toBe(2);
});

it('keeps the public Notebook update route asynchronous through real current membership admission', async () => {
  const f = await createOwners();
  const baseRevision = currentNotebookRevision(f);
  const synchronous = vi.spyOn(childProcess, 'execFileSync');
  syncBuiltinESMExports();
  onTestFinished(() => {
    synchronous.mockRestore();
    syncBuiltinESMExports();
  });
  const result = await call(f, 'knowledge.notebook.update', {
    workspaceId: f.workspaceId,
    requestId: randomUUID(),
    baseRevision,
    summary: 'Explicit public update',
    changes: [{ path: 'index.md', content: '---\nokf_version: "0.2"\n---\n# Public update\n' }],
  });
  expect(result).toMatchObject({ outcome: 'published', baseRevision });
  expect(synchronous).not.toHaveBeenCalled();
});
