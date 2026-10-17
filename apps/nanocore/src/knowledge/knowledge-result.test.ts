import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { createKnowledgeAnswerApp } from '../test-support/knowledge-agent.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from './notebook.js';

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
  return { ...result, store, dataRoot, userId };
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

/** Reads only delivered feedback; the dispatcher's private context contains a live database. */
function latestToolOutput(f: ReturnType<typeof fixture>): string {
  const [, request] = f.createResponses.mock.calls.at(-1) as unknown as Parameters<
    LLMGatewayProviderDispatcher['createResponses']
  >;
  const input = request.input as Array<{ type?: string; output?: string }>;
  const latest = input.findLast((entry) => entry.type === 'function_call_output');
  expect(latest?.output).toEqual(expect.any(String));
  return latest!.output!;
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

// Real Git publication and the bounded role use the existing 120-second execution budget.
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
}, 120_000);

// The Provider first omits the native no-change outcome, then uses actual Tool feedback to repair it.
it('repairs a premature maintenance result with one native no-change submission', async () => {
  const f = fixture();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const before = notebook.publishedRevision();
  let step = 0;
  f.createResponses.mockImplementation(async () => {
    if (++step === 2) {
      expect(latestToolOutput(f)).toContain(
        'Call knowledge.notebook.update({summary: ...}) first, including when no changes are needed. Then call knowledge.result.'
      );
      return call('knowledge.notebook.update', { summary: 'No changes are needed.' });
    }
    return call('knowledge.result', { summary: 'No changes are needed.' });
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      { workspaceId: DEMO_WORKSPACE_ID },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          instruction: 'Inspect the notebook; keep existing content.',
        }),
      }
    )
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { turnId: string; outcome: string };
  expect(body.outcome).toBe('no-change');
  const turn = f.store.getTurnById(body.turnId);
  expect(turn.status).toBe('completed');
  expect(
    turn.items.filter(
      (item) => item.type === 'tool-call' && item.tool === 'knowledge.notebook.update'
    )
  ).toEqual([expect.objectContaining({ status: 'completed' })]);
  expect(
    turn.items.filter((item) => item.type === 'tool-call' && item.tool === 'knowledge.result')
  ).toEqual([
    expect.objectContaining({ status: 'failed' }),
    expect.objectContaining({ status: 'completed' }),
  ]);
  expect(
    turn.items.some(
      (item) => item.type === 'tool-call' && item.tool === 'knowledge.notebook-workspace.update'
    )
  ).toBe(false);
  expect(notebook.publishedRevision()).toBe(before);
  expect(f.createResponses).toHaveBeenCalledTimes(3);
}, 120_000);

// A repair may finish after a refused duplicate, but cannot repeat the native submission.
it('refuses a duplicate notebook submission during maintenance result repair', async () => {
  const f = fixture();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const before = notebook.publishedRevision();
  let step = 0;
  f.createResponses.mockImplementation(async () => {
    if (++step === 1 || step === 3)
      return call('knowledge.notebook.update', { summary: 'No changes are needed.' });
    if (step === 2) return markdown();
    expect(latestToolOutput(f)).toContain(
      'Repair cannot repeat notebook effects. Start a new request.'
    );
    return call('knowledge.result', { summary: 'No changes are needed.' });
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      { workspaceId: DEMO_WORKSPACE_ID },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          instruction: 'Inspect the notebook; keep existing content.',
        }),
      }
    )
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { turnId: string; outcome: string };
  expect(body.outcome).toBe('no-change');
  const turn = f.store.getTurnById(body.turnId);
  expect(turn.status).toBe('completed');
  expect(
    turn.items.filter(
      (item) => item.type === 'tool-call' && item.tool === 'knowledge.notebook.update'
    )
  ).toEqual([
    expect.objectContaining({ status: 'completed' }),
    expect.objectContaining({ status: 'failed' }),
  ]);
  expect(turn.items).toContainEqual(
    expect.objectContaining({ type: 'tool-call', tool: 'knowledge.result', status: 'completed' })
  );
  expect(notebook.publishedRevision()).toBe(before);
  expect(f.createResponses).toHaveBeenCalledTimes(4);
}, 120_000);

// Organizing an empty overview is a separate editing run; the existing human fact must keep its bytes.
it('organizes the initial root index around an existing human fact through the real editor and publisher', async () => {
  const f = fixture();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  // Demo import creates an overview; this case needs an empty index beside the existing fact.
  const imported = notebook.publishedRevision();
  const before = notebook.prepare({
    baseRevision: imported,
    changes: { 'index.md': DEFAULT_NOTEBOOK_INDEX },
    metadata: {
      summary: 'Prepare empty overview',
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('empty overview') },
      producer: { kind: 'user', id: f.userId },
      authority: { kind: 'direct', instructionReference: 'Prepare the maintenance fixture.' },
      sourceReferences: [],
    },
  });
  notebook.publish({ baseRevision: imported, candidateRevision: before });
  const initial = notebook.readRevision(before).files;
  expect(initial['index.md']).toBe(DEFAULT_NOTEBOOK_INDEX);
  expect(initial['mem_project.md']).toContain(
    'Drive the workspace protocol through a real Codex-backed local agent adapter.'
  );
  let step = 0;
  f.createResponses.mockImplementation(async () => {
    if (++step === 1)
      return call('knowledge.notebook-workspace.update', {
        script: "printf '\\n[Product focus](mem_project.md)\\n' >> index.md",
      });
    if (step === 2)
      return call('knowledge.notebook.update', { summary: 'Link the existing product focus.' });
    return call('knowledge.result', { summary: 'Linked the existing product focus.' });
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      { workspaceId: DEMO_WORKSPACE_ID },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          instruction:
            'Organize the empty root index with a link to the existing product focus. Preserve the human fact.',
        }),
      }
    )
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as {
    turnId: string;
    outcome: string;
    notebookRevision: string;
    candidateRevision?: string;
  };
  expect(['published', 'review-required']).toContain(body.outcome);
  const revision = body.outcome === 'published' ? body.notebookRevision : body.candidateRevision!;
  const organized = notebook.readRevision(revision);
  expect(organized.parentRevision).toBe(before);
  expect(organized.files['index.md']).toBe(
    `${DEFAULT_NOTEBOOK_INDEX}\n[Product focus](mem_project.md)\n`
  );
  expect(organized.files['mem_project.md']).toBe(initial['mem_project.md']);
  if (body.outcome === 'review-required') expect(notebook.publishedRevision()).toBe(before);
  const turn = f.store.getTurnById(body.turnId);
  expect(turn.status).toBe('completed');
  expect(turn.items.filter((item) => item.type === 'tool-call')).toEqual([
    expect.objectContaining({ tool: 'knowledge.notebook-workspace.update', status: 'completed' }),
    expect.objectContaining({ tool: 'knowledge.notebook.update', status: 'completed' }),
    expect.objectContaining({ tool: 'knowledge.result', status: 'completed' }),
  ]);
  expect(f.createResponses).toHaveBeenCalledTimes(3);
}, 120_000);
