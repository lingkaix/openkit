import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { createKnowledgeAnswerApp } from '../test-support/knowledge-agent.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';

/** Real operation admission, notebooks and runtime; only Provider transport is replaced. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-result-api-'));
  const store = createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const result = createKnowledgeAnswerApp({ dataRoot, store, coreDb }, []);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { ...result, store, dataRoot };
}

/** Submits a real model-visible Tool call through the Gateway projection. */
function call(name: string, value: unknown) {
  return {
    id: randomUUID(),
    object: 'response',
    output: [
      {
        type: 'function_call',
        call_id: randomUUID(),
        name: operationToolName(name),
        arguments: JSON.stringify(value),
      },
    ],
  };
}

/** Deliberately invalid final text, matching the real Provider probe. */
function markdown() {
  return {
    id: randomUUID(),
    object: 'response',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: '**Answer:** Finished.' }] },
    ],
  };
}

it('returns a typed HTTP refusal with the retained KM Turn after one failed repair', async () => {
  const f = fixture();
  f.createResponses.mockImplementation(async () => markdown());
  const response = await f.app.request(
    ...operationRequest('knowledge.ask', {
      workspaceId: DEMO_WORKSPACE_ID,
      question: 'What is documented?',
    })
  );
  expect(response.status).toBe(422);
  const body = (await response.json()) as {
    code: string;
    details: { threadId: string; turnId: string };
  };
  expect(body).toMatchObject({
    code: 'knowledge_query_failed',
    details: { threadId: expect.any(String), turnId: expect.any(String) },
  });
  const turn = f.store.getTurnById(body.details.turnId);
  expect(turn).toMatchObject({
    threadId: body.details.threadId,
    status: 'failed',
    error: { code: 'knowledge_manager_failed' },
  });
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  const db = openWorkspaceDb(f.dataRoot, DEMO_WORKSPACE_ID);
  try {
    const asking = listWorkspaceCapabilityCalls(db, DEMO_WORKSPACE_ID).filter(
      (call) => call.operation === 'knowledge.ask'
    );
    expect(asking).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'knowledge_query_failed' }),
    ]);
    expect(asking[0]!.extensions?.['openkit.knowledge/delivery']).toBeUndefined();
  } finally {
    db.sqlite.close();
  }
});

it('repairs maintenance output without repeating the accepted notebook submission', async () => {
  const f = fixture();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const before = notebook.publishedRevision();
  let step = 0;
  f.createResponses.mockImplementation(async () => {
    if (++step === 1)
      return call('knowledge.notebook.update', { summary: 'No changes are needed.' });
    if (step === 2) return markdown();
    return call('knowledge.result', { summary: 'No changes are needed.' });
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      {
        workspaceId: DEMO_WORKSPACE_ID,
      },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          instruction: 'Inspect the notebook; keep existing content.',
        }),
      }
    )
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as {
    turnId: string;
    outcome: string;
    notebookRevision: string;
  };
  expect(body).toMatchObject({ outcome: 'no-change', notebookRevision: before });
  const turn = f.store.getTurnById(body.turnId);
  expect(turn.status).toBe('completed');
  expect(
    turn.items.filter(
      (item) => item.type === 'tool-call' && item.tool === 'knowledge.notebook.update'
    )
  ).toHaveLength(1);
  expect(turn.items).toContainEqual(
    expect.objectContaining({ type: 'tool-call', tool: 'knowledge.result', status: 'completed' })
  );
  expect(notebook.publishedRevision()).toBe(before);
  expect(f.createResponses).toHaveBeenCalledTimes(3);
});
