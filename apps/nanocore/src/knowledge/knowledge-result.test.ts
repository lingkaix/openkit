import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { createKnowledgeAnswerApp } from '../test-support/knowledge-agent.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from './notebook.js';
import { updateOkfFrontmatter } from './okf.js';

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

// The real KM loop must retain safe owner feedback even when the optional process sink fails.
it.each([
  false,
  true,
])('exposes a safe notebook Tool failure when the log sink throws=%s', async (sinkThrows) => {
  const f = fixture();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const before = notebook.publishedRevision();
  const contentMarker = 'UNPUBLISHED-CONTENT-MARKER';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
    if (sinkThrows) throw new Error('Optional diagnostic sink unavailable.');
  });
  onTestFinished(() => warn.mockRestore());
  let step = 0;
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (++step === 1)
      return call('knowledge.notebook.update', { summary: contentMarker + 'x'.repeat(4096) });
    feedback = latestToolOutput(f);
    // Feedback has reached the next actual model request; no final-answer round trip is needed.
    throw new Error('The deterministic feedback probe is complete.');
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      { workspaceId: DEMO_WORKSPACE_ID },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          instruction: 'Inspect the admitted notebook.',
        }),
      }
    )
  );
  expect(response.status).toBe(200);
  expect(feedback).toContain('invalid_request');
  expect(feedback).not.toContain('The Tool failed without a safe result.');
  expect(feedback).not.toContain(contentMarker);
  expect(feedback).not.toContain(f.dataRoot);
  const diagnostics = warn.mock.calls.flatMap((args) =>
    args.filter((arg) => typeof arg === 'string').map((arg) => JSON.parse(arg))
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'knowledge_notebook_tool_failed',
      operation: 'knowledge.notebook.update',
      exceptionClass: 'NotebookError',
      errorCode: 'invalid_request',
    })
  );
  expect(JSON.stringify(diagnostics)).not.toContain(contentMarker);
  expect(JSON.stringify(diagnostics)).not.toContain(f.dataRoot);
  expect(JSON.stringify(diagnostics)).not.toContain('stack');
  expect(notebook.publishedRevision()).toBe(before);
  expect(f.createResponses).toHaveBeenCalledTimes(2);
});

/** Native calls in one Provider response retain their ordinary sequential execution. */
function calls(entries: Array<[string, unknown]>) {
  const first = call(entries[0]![0], entries[0]![1]);
  return { ...first, output: entries.flatMap(([name, value]) => call(name, value).output) };
}

it('keeps exception text and paths out of model and process failure diagnostics', async () => {
  const f = fixture();
  const marker = 'PRIVATE-EXCEPTION-CONTENT';
  const prepare = vi.spyOn(KnowledgeNotebook.prototype, 'prepare').mockImplementation(() => {
    throw new TypeError(`${marker} ${f.dataRoot}`);
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onTestFinished(() => {
    prepare.mockRestore();
    warn.mockRestore();
  });
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1)
      return calls([
        [
          'knowledge.notebook-workspace.update',
          { script: "printf '\\nSynthetic overview.\\n' >> index.md" },
        ],
        ['knowledge.notebook.update', { summary: 'Submit the synthetic overview.' }],
      ]);
    feedback = latestToolOutput(f);
    throw new Error('The deterministic exception probe is complete.');
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
          instruction: 'Curate the synthetic overview.',
        }),
      }
    )
  );
  expect(response.status).toBe(200);
  expect(prepare).toHaveBeenCalled();
  expect(feedback).toContain('notebook_tool_failed');
  const diagnostics = warn.mock.calls.flatMap((args) =>
    args.filter((arg) => typeof arg === 'string').map((arg) => JSON.parse(arg))
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'knowledge_notebook_tool_failed',
      operation: 'knowledge.notebook.update',
      exceptionClass: 'TypeError',
      errorCode: 'notebook_tool_failed',
    })
  );
  for (const text of [feedback, JSON.stringify(diagnostics)]) {
    expect(text).not.toContain(marker);
    expect(text).not.toContain(f.dataRoot);
    expect(text).not.toContain('stack');
  }
});

it('makes the actual Claim confidence refusal actionable without publishing', async () => {
  const f = fixture();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const before = notebook.publishedRevision();
  const content = updateOkfFrontmatter({
    path: 'claim.md',
    content: serializeKnowledgePageFixture(
      {
        title: 'Synthetic claim',
        content: 'UNPUBLISHED-CLAIM-CONTENT',
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
    ),
    updates: { type: 'Claim' },
  });
  const script = `cat > claim.md <<'PAGE'\n${content}PAGE\n`;
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1)
      return calls([
        ['knowledge.notebook-workspace.update', { script }],
        ['knowledge.notebook.update', { summary: 'Submit the synthetic candidate.' }],
      ]);
    feedback = latestToolOutput(f);
    throw new Error('The deterministic refusal probe is complete.');
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
          instruction: 'Curate the synthetic candidate.',
        }),
      }
    )
  );
  expect(response.status).toBe(200);
  expect(feedback).toContain('scope_schema.invalid_confidence');
  expect(feedback).toContain('finite number from zero through one');
  expect(feedback).not.toContain('UNPUBLISHED-CLAIM-CONTENT');
  expect(notebook.publishedRevision()).toBe(before);
  expect(f.store.listKnowledgeProposals(DEMO_WORKSPACE_ID)).toEqual([]);
  expect(f.createResponses).toHaveBeenCalledTimes(2);
});

it('corrects Claim confidence before result submission through the real KM Tools', async () => {
  const f = fixture();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const before = notebook.publishedRevision();
  const content = updateOkfFrontmatter({
    path: 'claim.md',
    content: serializeKnowledgePageFixture(
      {
        title: 'Synthetic claim',
        content: 'Synthetic evidence for confidence correction.',
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
    ),
    updates: { type: 'Claim' },
  });
  const corrected = updateOkfFrontmatter({
    path: 'claim.md',
    content,
    updates: { confidence: 0.5 },
  });
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1)
      return calls([
        [
          'knowledge.notebook-workspace.update',
          { script: `cat > claim.md <<'PAGE'\n${content}PAGE\n` },
        ],
        ['knowledge.notebook.update', { summary: 'Submit the synthetic candidate.' }],
      ]);
    if (!feedback) feedback = latestToolOutput(f);
    return calls([
      [
        'knowledge.notebook-workspace.update',
        { script: `cat > claim.md <<'PAGE'\n${corrected}PAGE\n` },
      ],
      ['knowledge.notebook.update', { summary: 'Submit the corrected Claim.' }],
      ['knowledge.result', { summary: 'Submitted the corrected Claim.' }],
    ]);
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
          instruction: 'Curate the synthetic Claim.',
        }),
      }
    )
  );
  const body = (await response.json()) as {
    outcome: string;
    turnId: string;
    notebookRevision: string;
    candidateRevision?: string;
  };
  expect(response.status).toBe(200);
  expect(feedback).toContain('scope_schema.invalid_confidence');
  expect(
    ['published', 'review-required'],
    JSON.stringify(
      f.store
        .getTurnById(body.turnId)
        .items.filter((item) => item.type === 'tool-call')
        .map((item) => ({ tool: item.tool, status: item.status, result: item.result }))
    )
  ).toContain(body.outcome);
  const revision = body.outcome === 'published' ? body.notebookRevision : body.candidateRevision!;
  const after = notebook.readRevision(revision);
  expect(after.parentRevision).toBe(before);
  expect(after.files['claim.md']).toContain('confidence: 0.5');
  const beforeFiles = notebook.readRevision(before).files;
  expect(
    Object.keys(after.files).filter((path) => after.files[path] !== beforeFiles[path])
  ).toHaveLength(1);
  const turn = f.store.getTurnById(body.turnId);
  expect(turn.status).toBe('completed');
  expect(
    turn.items
      .filter((item) => item.type === 'tool-call' && item.tool === 'knowledge.notebook.update')
      .map((item) => item.status)
  ).toEqual(['failed', 'completed']);
  expect(
    turn.items.filter((item) => item.type === 'tool-call' && item.tool === 'knowledge.result')
  ).toHaveLength(1);
  expect(f.createResponses).toHaveBeenCalledTimes(2);
});
