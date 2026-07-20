import { describe, expect, it, vi } from 'vitest';

import { KnowledgePageValidationError } from './knowledge/okf.js';

const CONTEXT_PACKAGE_DIGEST = `ctxpkg_sha256_${'a'.repeat(64)}`;
const THREAD_ID = 'th_imported_history';
const TURN_ID = 'tu_imported_history';
const ITEM_ID = 'it_imported_history';
const WORKSPACE_ID = 'ws_imported_history';

vi.mock('./context/worker-context-package.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./context/worker-context-package.js')>();
  return {
    ...original,
    readPortableWorkerContextPackageTrace: vi.fn(() => ({
      trace: {
        contextPackageDigest: CONTEXT_PACKAGE_DIGEST,
        goalId: null,
        knowledgeSelectionInput: { query: 'Imported history is read-only evidence.' },
        taskId: null,
      },
      verification: 'imported-history',
    })),
  };
});

import { verifyKnowledgeProposalWorkHistory } from './knowledge-manager.js';

/** Builds the minimum existing owners required before S39 branch classification. */
function importedHistoryFixture() {
  const dataRoot = '/tmp/openkit-imported-knowledge-history';
  const store = {
    getDataRoot: () => dataRoot,
    getWorkspace: () => ({ id: WORKSPACE_ID }),
    getTurnById: () => ({
      id: TURN_ID,
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      status: 'completed',
    }),
    listThreadItems: () => [
      {
        id: ITEM_ID,
        turnId: TURN_ID,
        type: 'assistant-message',
        status: 'completed',
      },
    ],
  };
  return {
    coreDb: { dataRoot },
    sourceReferences: [
      `turn:${TURN_ID}`,
      `item:${ITEM_ID}`,
      `context-package:${TURN_ID}@${CONTEXT_PACKAGE_DIGEST}`,
    ],
    store,
    workspaceDb: { dataRoot, workspaceId: WORKSPACE_ID },
    workspaceId: WORKSPACE_ID,
  };
}

describe('Knowledge proposal completed-work authority', () => {
  it('rejects imported history as new local completed worker output', () => {
    const fixture = importedHistoryFixture();

    expect(() =>
      verifyKnowledgeProposalWorkHistory({
        ...fixture,
        store: fixture.store as never,
        coreDb: fixture.coreDb as never,
        workspaceDb: fixture.workspaceDb as never,
      })
    ).toThrow(KnowledgePageValidationError);
  });

  it('retains an explicit read-only allowance for imported accepted Page proof', () => {
    const fixture = importedHistoryFixture();

    expect(
      verifyKnowledgeProposalWorkHistory({
        ...fixture,
        allowImportedHistory: true,
        store: fixture.store as never,
        coreDb: fixture.coreDb as never,
        workspaceDb: fixture.workspaceDb as never,
      })
    ).toEqual({ verifiedExternalReferences: fixture.sourceReferences });
  });
});
