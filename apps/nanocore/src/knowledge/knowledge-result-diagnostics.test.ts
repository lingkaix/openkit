import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { call, calls, fixture, latestToolOutput } from '../test-support/knowledge-result.js';
import { operationRequest } from '../test-support/operation-request.js';
import { KnowledgeNotebook } from './notebook.js';
import { updateOkfFrontmatter } from './okf.js';

// The real KM loop must retain safe owner feedback even when the optional process sink fails.
it.each([
  false,
  true,
])('exposes a safe notebook Tool failure when the log sink throws=%s', async (sinkThrows) => {
  const f = await fixture();
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

it('keeps exception text and paths out of model and process failure diagnostics', async () => {
  const f = await fixture();
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
  // Diagnostic floor RED 2: preserve both native schema codes without adding the fallback.
  expect(JSON.parse(feedback).diagnostics).toEqual([
    'notebook.invalid_page',
    'scope_schema.invalid_confidence',
  ]);
  expect(JSON.parse(feedback)).not.toHaveProperty('linkDiagnostics');
  expect(feedback).not.toContain('UNPUBLISHED-CLAIM-CONTENT');
  expect(notebook.publishedRevision()).toBe(before);
  expect(f.store.listKnowledgeProposals(DEMO_WORKSPACE_ID)).toEqual([]);
  expect(f.createResponses).toHaveBeenCalledTimes(2);
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
