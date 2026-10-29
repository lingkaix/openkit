import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import type { AgentToolResult } from '../internal-agents/internal-agent-loop.js';
import * as knowledgeManager from '../internal-agents/knowledge-manager-agent.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { call, calls, fixture, latestToolOutput } from '../test-support/knowledge-result.js';
import { operationRequest } from '../test-support/operation-request.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from './notebook.js';
import { updateOkfFrontmatter } from './okf.js';

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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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

/** Observes raw isError before transcript projection, while running every native Tool and KM loop. */
function observeNotebookTools() {
  const results: Array<{ name: string; result: AgentToolResult }> = [];
  const run = knowledgeManager.runKnowledgeManagerAgent;
  const observer = vi
    .spyOn(knowledgeManager, 'runKnowledgeManagerAgent')
    .mockImplementation((dependencies, input) =>
      run(dependencies, {
        ...input,
        tools: input.tools.map((tool) => ({
          ...tool,
          execute: async (value, context) => {
            const result = await tool.execute(value, context);
            if (tool.name.startsWith('knowledge.notebook'))
              results.push({ name: tool.name, result });
            return result;
          },
        })),
      })
    );
  onTestFinished(() => observer.mockRestore());
  return results;
}

// meta-silent-refusal RED 1: an unspecified submission refusal must still have one safe category.
it.each([
  'malformed summary',
  'non-admitted Source',
] as const)('diagnostic floor RED 1: categorizes %s without candidate or publication effects', async (failure) => {
  const f = await fixture(true);
  const observed = observeNotebookTools();
  const repositoryPath = join(
    f.dataRoot,
    'workspaces',
    DEMO_WORKSPACE_ID,
    'knowledge',
    'notebook.git'
  );
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const before = notebook.publishedRevision();
  // Include unreachable commits: unchanged refs alone cannot rule out a prepared candidate.
  const commits = () =>
    execFileSync(
      'git',
      ['--git-dir', repositoryPath, 'cat-file', '--batch-all-objects', '--batch-check'],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter((line) => line.split(' ')[1] === 'commit')
      .sort();
  const beforeCommits = commits();
  const marker = 'UNADMITTED-SUBMISSION-CONTENT';
  const sourceReference = `source:ks_00000000-0000-7000-8000-000000000001@sha256:${'a'.repeat(64)}`;
  const content = serializeKnowledgePageFixture(
    {
      title: 'Unadmitted Source fixture',
      content: `${marker} ${f.dataRoot}`,
      sourceReferences: [sourceReference],
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    },
    { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1) {
      // A string over the summary bound passes Tool schema admission and reaches the native refusal.
      if (failure === 'malformed summary')
        return call('knowledge.notebook.update', {
          summary: `${marker} ${f.dataRoot}${'x'.repeat(4096)}`,
        });
      return calls([
        [
          'knowledge.notebook-workspace.update',
          { script: `cat > unadmitted.md <<'PAGE'\n${content}PAGE\n` },
        ],
        ['knowledge.notebook.update', { summary: 'Submit the Source reference fixture.' }],
      ]);
    }
    feedback = latestToolOutput(f);
    throw new Error('The deterministic refusal feedback probe is complete.');
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      { workspaceId: DEMO_WORKSPACE_ID },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          instruction: 'Curate only the admitted notebook and Sources.',
          pageIds: ['index'],
        }),
      }
    )
  );
  const body = (await response.json()) as { turnId: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  const submission = observed.filter(({ name }) => name === 'knowledge.notebook.update');
  expect(submission).toHaveLength(1);
  expect(submission[0]!.result.isError).toBe(true);
  if (failure === 'non-admitted Source')
    expect(observed[0]).toMatchObject({
      name: 'knowledge.notebook-workspace.update',
      result: { content: [{ type: 'text', text: expect.stringContaining('"exitCode":0') }] },
    });
  const detail = JSON.parse(feedback);
  expect(detail.code).toBe('invalid_request');
  expect(detail).not.toHaveProperty('linkDiagnostics');
  expect(notebook.publishedRevision()).toBe(before);
  expect(commits()).toEqual(beforeCommits);
  expect(f.store.listKnowledgeProposals(DEMO_WORKSPACE_ID)).toEqual([]);
  expect(
    f.store
      .getTurnById(body.turnId)
      .items.filter(
        (item) => item.type === 'tool-call' && item.tool === 'knowledge.notebook.update'
      )
  ).toEqual([expect.objectContaining({ status: 'failed' })]);
  for (const text of [feedback, JSON.stringify(body), JSON.stringify(warn.mock.calls)]) {
    for (const forbidden of [marker, f.dataRoot, sourceReference, 'unadmitted.md', 'stack'])
      expect(text).not.toContain(forbidden);
    expect(text).not.toMatch(/(?:SyntaxError|TypeError|NotebookError):|\bat .+:\d+:\d+/);
  }
  // This exact assertion is the expected RED on the unchanged implementation.
  expect(detail.diagnostics).toEqual(['notebook.submission_refused']);
}, 120_000);

// meta-silent-refusal RED 2: specific script categories must not acquire a submission fallback.
it.each([
  { category: 'notebook.script_syntax_error', script: 'if true; then' },
  { category: 'notebook.script_limit_exceeded', script: `#${'x'.repeat(64 * 1024)}` },
])('diagnostic floor RED 2: preserves $category exactly', async ({ category, script }) => {
  const f = await fixture();
  const observed = observeNotebookTools();
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1)
      return call('knowledge.notebook-workspace.update', { script });
    feedback = latestToolOutput(f);
    throw new Error('The deterministic script category probe is complete.');
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
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  expect(observed).toHaveLength(1);
  expect(observed[0]!.result.isError).toBe(true);
  expect(JSON.parse(feedback)).toMatchObject({
    code: 'invalid_request',
    diagnostics: [category],
  });
  expect(JSON.parse(feedback)).not.toHaveProperty('linkDiagnostics');
  expect(feedback).not.toContain('notebook.submission_refused');
}, 120_000);

it.each([
  'Rule',
  'Effect',
  'Objective',
])('repairs typed %s applicability after an actual submission refusal', async (type) => {
  const f = await fixture();
  const observed = observeNotebookTools();
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const before = notebook.publishedRevision();
  const content = updateOkfFrontmatter({
    path: 'typed.md',
    content: serializeKnowledgePageFixture(
      {
        title: 'Synthetic domain page',
        content: 'UNPUBLISHED-DOMAIN-CONTENT',
        sourceReferences: [],
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
    ),
    updates: {
      type,
      ...(type === 'Effect'
        ? { basis: 'Supplied fixture evidence.', last_checked_at: '2026-10-20T00:00:00Z' }
        : {}),
    },
  });
  const corrected = updateOkfFrontmatter({
    path: 'typed.md',
    content,
    updates: { applies_to: ['step:report-review'] },
  });
  let feedback = '';
  let beforeRepair: { revision: string; proposalCount: number } | undefined;
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1)
      return calls([
        [
          'knowledge.notebook-workspace.update',
          { script: `cat > typed.md <<'PAGE'\n${content}PAGE\n` },
        ],
        ['knowledge.notebook.update', { summary: 'Submit the domain page.' }],
      ]);
    feedback = latestToolOutput(f);
    beforeRepair = {
      revision: notebook.publishedRevision(),
      proposalCount: f.store.listKnowledgeProposals(DEMO_WORKSPACE_ID).length,
    };
    return calls([
      [
        'knowledge.notebook-workspace.update',
        { script: `cat > typed.md <<'PAGE'\n${corrected}PAGE\n` },
      ],
      ['knowledge.notebook.update', { summary: 'Submit the corrected applicability.' }],
      ['knowledge.result', { summary: 'The corrected domain page requires human Review.' }],
    ]);
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      { workspaceId: DEMO_WORKSPACE_ID },
      { body: JSON.stringify({ requestId: randomUUID(), instruction: 'Curate the domain page.' }) }
    )
  );
  const body = (await response.json()) as { outcome: string; turnId: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  expect(beforeRepair).toEqual({ revision: before, proposalCount: 0 });
  const submissions = observed.filter(({ name }) => name === 'knowledge.notebook.update');
  expect(submissions).toHaveLength(2);
  expect(submissions[0]!.result.isError).toBe(true);
  expect(submissions[1]!.result.isError).not.toBe(true);
  expect(feedback).not.toContain('UNPUBLISHED-DOMAIN-CONTENT');
  expect(feedback).not.toContain(f.dataRoot);
  expect(JSON.parse(feedback)).toEqual({
    code: 'invalid_request',
    diagnostics: ['notebook.invalid_page', 'scope_schema.invalid_applies_to'],
    message:
      "Rule, Effect and Objective require applies_to as a nonempty YAML list of nonblank tool or work-step identifiers, for example applies_to: [step:report-review]. Use the supplied work's identifiers. Correct these pages, resubmit with knowledge.notebook.update, then call knowledge.result after a successful submission.",
  });
  expect(body.outcome).toBe('review-required');
  expect(f.store.getTurnById(body.turnId).status).toBe('completed');
  expect(f.store.listKnowledgeProposals(DEMO_WORKSPACE_ID)).toHaveLength(1);
  expect(notebook.publishedRevision()).toBe(before);
}, 120_000);

it('makes the actual script path refusal actionable with exact native feedback', async () => {
  const f = await fixture();
  const observed = observeNotebookTools();
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1)
      return call('knowledge.notebook-workspace.update', {
        script: 'printf scratch > scratch.sh',
      });
    feedback = latestToolOutput(f);
    throw new Error('The deterministic path refusal probe is complete.');
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
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  expect(observed).toHaveLength(1);
  expect(observed[0]!.result.isError).toBe(true);
  expect(JSON.parse(feedback)).toEqual({
    code: 'invalid_request',
    diagnostics: ['notebook.script_path_refused'],
    message:
      'Writable Page files use bundle-relative lowercase .md paths under the Notebook root. Original Sources and omitted base members are read-only. There are no script, scratch or non-Markdown files. mkdir, remove, copy and move use the same path rule. Correct the path, then submit the accepted pages with knowledge.notebook.update once the synthesis is ready.',
  });
}, 120_000);

it('corrects Claim confidence before result submission through the real KM Tools', async () => {
  const f = await fixture();
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
  expect(JSON.parse(feedback).diagnostics).toEqual([
    'notebook.invalid_page',
    'scope_schema.invalid_confidence',
  ]);
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
}, 120_000);

it('Final-Tree Validation: same-author bounded link feedback permits one repair and publication without omitted referrer disclosure', async () => {
  const f = await fixture(true);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'knowledge', 'notebook.git'),
  });
  const page = (title: string, content: string) =>
    serializeKnowledgePageFixture(
      {
        title,
        content,
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
    );
  const victim = page('Selected target', 'Admitted target bytes.');
  const omitted = page(
    'PRIVATE-UNSELECTED-TITLE',
    'PRIVATE-UNSELECTED-BODY [Keep](/victim.md?PRIVATE-UNSELECTED-TARGET#keep)'
  );
  const imported = notebook.publishedRevision();
  const before = notebook.prepare({
    baseRevision: imported,
    changes: { 'victim.md': victim, 'a-unselected.md': omitted },
    metadata: {
      summary: 'Prepare selected and omitted link fixtures',
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('link fixtures') },
      producer: { kind: 'user', id: f.userId },
      authority: { kind: 'direct', instructionReference: 'Prepare the link fixture.' },
      sourceReferences: [],
    },
  });
  notebook.publish({ baseRevision: imported, candidateRevision: before });
  const targets = [
    '../missing.md?draft=1#first',
    `/${'x'.repeat(270)}.md`,
    '/notebook/missing.md',
    '../missing.md#second',
    '/missing-five.md',
    '/missing-six.md',
    '/missing-seven.md',
    '/missing-eight.md',
    '/missing-nine.md',
    '/missing-ten.md',
  ];
  const badPage = (id: string, links: string[]) =>
    page(id, links.map((target, index) => `[Link ${index}](${target})`).join('\n'));
  const firstScript = [
    'rm victim.md',
    'mkdir -p guide',
    `cat > guide/b.md <<'PAGE'\n${badPage('B', targets.slice(5))}PAGE`,
    `cat > guide/a.md <<'PAGE'\n${badPage('A', targets.slice(0, 5))}PAGE`,
  ].join('\n');
  const correctedA = page('A', '[Selected target](../victim.md#heading)');
  const correctedB = page('B', '[Selected target](/victim.md)');
  const repairScript = [
    `cat > victim.md <<'PAGE'\n${victim}PAGE`,
    `cat > guide/a.md <<'PAGE'\n${correctedA}PAGE`,
    `cat > guide/b.md <<'PAGE'\n${correctedB}PAGE`,
  ].join('\n');
  const expectedLinks = targets.slice(0, 8).map((target, index) => ({
    code: 'notebook.unresolved_page_link',
    pageId: index < 5 ? 'guide/a' : 'guide/b',
    target: target.slice(0, 256),
  }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  // A separate public caller receives the native refusal, without the KM-only feedback fields.
  const publicRefusal = await f.app.request(
    ...operationRequest(
      'knowledge.notebook.update',
      { workspaceId: DEMO_WORKSPACE_ID },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          baseRevision: before,
          changes: [{ path: 'public-bad.md', content: badPage('Public refusal', [targets[0]!]) }],
          summary: 'Check public refusal isolation.',
        }),
      }
    )
  );
  const refusalBody = await publicRefusal.json();
  expect(publicRefusal.status, JSON.stringify(refusalBody)).toBe(400);
  expect(refusalBody).toMatchObject({ code: 'invalid_request' });
  expect(JSON.stringify(refusalBody)).not.toContain('linkDiagnostics');
  expect(JSON.stringify(refusalBody)).not.toContain(targets[0]!);
  expect(notebook.publishedRevision()).toBe(before);
  let feedback = '';
  f.createResponses.mockImplementation(async () => {
    if (f.createResponses.mock.calls.length === 1) {
      return calls([
        ['knowledge.notebook-workspace.update', { script: firstScript }],
        ['knowledge.notebook.update', { summary: 'Submit links for validation.' }],
      ]);
    }
    feedback = latestToolOutput(f);
    const detail = JSON.parse(feedback) as { linkDiagnostics?: unknown };
    // The model fixture can repair only after actual feedback identifies its authored bad links.
    if (!Array.isArray(detail.linkDiagnostics)) throw new Error('Repair feedback is missing.');
    expect(detail.linkDiagnostics).toEqual(expectedLinks);
    expect(notebook.publishedRevision()).toBe(before);
    return calls([
      ['knowledge.notebook-workspace.update', { script: repairScript }],
      ['knowledge.notebook.update', { summary: 'Submit corrected links.' }],
      ['knowledge.result', { summary: 'Published the corrected links.' }],
    ]);
  });
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.maintain',
      { workspaceId: DEMO_WORKSPACE_ID },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          instruction: 'Repair links in the admitted notebook selection.',
          pageIds: ['index', 'victim'],
        }),
      }
    )
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    outcome: string;
    turnId: string;
    notebookRevision: string;
  };
  expect(
    feedback,
    JSON.stringify({
      outcome: body.outcome,
      error: f.store.getTurnById(body.turnId).error,
      providerCalls: f.createResponses.mock.calls.length,
    })
  ).toContain('notebook.unresolved_page_link');
  const detail = JSON.parse(feedback) as { diagnostics: string[]; linkDiagnostics?: unknown };
  // Diagnostic floor RED 2: exact codes, bounded author-only links and successful repair stay intact.
  expect(detail.diagnostics).toEqual(['notebook.unresolved_page_link']);
  const delivered = f.createResponses.mock.calls
    .map((call) => {
      const [, request] = call as unknown as Parameters<
        LLMGatewayProviderDispatcher['createResponses']
      >;
      return JSON.stringify(request.input);
    })
    .join('\n');
  const auditDb = openWorkspaceDb(f.dataRoot, DEMO_WORKSPACE_ID);
  let audit: string;
  try {
    audit = JSON.stringify(listWorkspaceAuditEvents(auditDb, DEMO_WORKSPACE_ID, f.coreDb));
  } finally {
    auditDb.sqlite.close();
  }
  const otherOutputs = [
    JSON.stringify(body),
    JSON.stringify(refusalBody),
    JSON.stringify(warn.mock.calls),
    audit,
  ].join('\n');
  expect(otherOutputs).not.toContain('linkDiagnostics');
  for (const forbidden of ['PRIVATE-UNSELECTED', 'a-unselected', f.dataRoot]) {
    expect(delivered).not.toContain(forbidden);
    expect(otherOutputs).not.toContain(forbidden);
  }
  for (const target of targets) expect(otherOutputs).not.toContain(target);
  expect(detail.linkDiagnostics).toEqual(expectedLinks);
  expect(body.outcome).toBe('published');
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  const after = notebook.readRevision(body.notebookRevision);
  expect(after.parentRevision).toBe(before);
  expect(notebook.publishedRevision()).toBe(after.revision);
  expect(after.files['guide/a.md']).toContain('[Selected target](../victim.md#heading)');
  expect(after.files['guide/b.md']).toContain('[Selected target](/victim.md)');
  expect(after.files['victim.md']).toBe(victim);
  expect(after.files['a-unselected.md']).toBe(omitted);
  expect(f.store.listKnowledgeProposals(DEMO_WORKSPACE_ID)).toEqual([]);
  const turn = f.store.getTurnById(body.turnId);
  expect(turn.status).toBe('completed');
  expect(turn.items.filter((item) => item.type === 'tool-call')).toEqual([
    expect.objectContaining({ tool: 'knowledge.notebook-workspace.update', status: 'completed' }),
    expect.objectContaining({ tool: 'knowledge.notebook.update', status: 'failed' }),
    expect.objectContaining({ tool: 'knowledge.notebook-workspace.update', status: 'completed' }),
    expect.objectContaining({ tool: 'knowledge.notebook.update', status: 'completed' }),
    expect.objectContaining({ tool: 'knowledge.result', status: 'completed' }),
  ]);
  // Retained author Tool feedback is authorized; only the result to the requester is separate.
  const result = turn.items.find(
    (item) => item.type === 'tool-call' && item.tool === 'knowledge.result'
  );
  expect(JSON.stringify(result)).not.toContain('linkDiagnostics');
}, 120_000);

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
