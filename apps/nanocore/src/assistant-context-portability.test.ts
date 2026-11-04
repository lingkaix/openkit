import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '@openkit/protocol';
import { allocateEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Actor } from './auth/identity.js';
import { createAssistantHistory } from './internal-agents/assistant-history.js';
import { createCompactingInternalAgentProvider } from './internal-agents/compacting-context.js';
import type { AgentMessage } from './internal-agents/internal-agent-loop.js';
import { readInternalContextEvidence } from './internal-agents/internal-context-evidence.js';
import {
  internalContextSourceDigest,
  prepareInternalAgentContext,
} from './internal-agents/rolling-context.js';
import { FsStore } from './lib/store.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { readTurnRetrievalTraces } from './storage/retrieval-traces.js';
import { verifyWorkspaceExportTree } from './storage/workspace-export.js';
import { existingWorkspaceExportRoot } from './storage/workspace-transfer-routes.js';
import { createApp } from './test-support/app.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

type Turn = ReturnType<FsStore['getTurnById']>;
type Summary = Extract<Item, { type: 'context-summary' }>;
const timestamp = '2026-10-16T00:00:00.000Z';
const currentText = 'Continue the unresolved deployment decision.';
const summaryText =
  'Keep the deployment constraint and pending decision. Exact source history remains available.';
const model = {
  logicalModelId: 'portable-context',
  modelFamilyId: null,
  capabilities: ['responses', 'tool-calling'],
};

/** Creates independent real deployment identities, canonical owners and in-process public routes. */
async function deployment() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-context-portability-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Portable context');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
  const app = await createApp({ dataRoot, coreDb, store });
  return { dataRoot, coreDb, store, workspace, app };
}

/** Admits sequential internal Turns with stable source order. */
async function admit(
  f: Awaited<ReturnType<typeof deployment>>,
  workspaceId: string,
  threadId: string
): Promise<Turn> {
  return await f.store.createTurn(
    workspaceId,
    threadId,
    currentText,
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      agentId: 'quick-chat',
      executorKind: 'assistant',
      startedAt: new Date(
        Date.parse(timestamp) + f.store.listThreadTurns(workspaceId, threadId).length
      ).toISOString(),
    }
  );
}

/** Retains accepted user and Assistant messages through the canonical Item writer. */
async function message(
  f: Awaited<ReturnType<typeof deployment>>,
  turn: Turn,
  type: 'user-message' | 'assistant-message',
  text: string
) {
  return await f.store.createItem({
    id: allocateEntityId('it'),
    owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
    threadId: turn.threadId,
    turnId: turn.id,
    type,
    text,
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
    ...(type === 'user-message' ? { actor: { kind: 'user' as const, id: LOCAL_USER_ID } } : {}),
  } as Item);
}

/** Supplies the same role environment with real current source and trace verification. */
function context(f: Awaited<ReturnType<typeof deployment>>, turn: Turn, capacity: number) {
  const actor: Actor = { kind: 'local', userId: LOCAL_USER_ID };
  const owner = {
    store: f.store,
    coreDb: f.coreDb,
    actor,
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    turnId: turn.id,
  };
  const history = createAssistantHistory(owner);
  const required: AgentMessage = { role: 'user', content: [{ type: 'text', text: currentText }] };
  return {
    store: f.store,
    turn,
    systemPrompt: 'Preserve the deployment constraint, source boundaries and pending decision.',
    tools: [history.tool],
    model,
    bounds: { context: capacity, output: 512 },
    requiredMessages: [required],
    limits: { maxModelTurns: 40, maxToolCalls: 3, deadlineMs: 60_000 },
    signal: new AbortController().signal,
    assertCurrent: history.assertCurrent,
    readEvidence: (items: readonly Item[]) => readInternalContextEvidence({ ...owner, items }),
    callProvider: vi.fn(async () => ({
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: summaryText }],
        truncated: false,
      },
    })),
  };
}

/** Seeds a real summary chain with nonempty dependent range traces, including a byte cursor. */
async function seed() {
  const f = await deployment();
  const thread = await f.store.createThread(
    f.workspace.id,
    'Retained Assistant history',
    undefined,
    'conversation',
    { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
  );
  const originals: Item[] = [];
  let traceTurn: Turn | undefined;
  // Keep the same history Items under pressure with the local bytes/3 estimate.
  for (let index = 0; index < 8; index += 1) {
    const turn = await admit(f, f.workspace.id, thread.id);
    originals.push(
      await message(
        f,
        turn,
        'user-message',
        index === 0
          ? `Exact Unicode source: ${'😀漢'.repeat(800)}`
          : `Question ${index}: ${'q'.repeat(3600)}`
      )
    );
    if (index === 1) {
      traceTurn = turn;
      const tool = createAssistantHistory({
        store: f.store,
        coreDb: f.coreDb,
        actor: { kind: 'local', userId: LOCAL_USER_ID },
        workspaceId: f.workspace.id,
        threadId: thread.id,
        turnId: turn.id,
      });
      const range = {
        threadId: thread.id,
        firstItemId: originals[0]!.id,
        lastItemId: originals[1]!.id,
        sourceDigest: internalContextSourceDigest(f.store, originals.slice(0, 2)),
      };
      const first = await tool.tool.execute(
        { range, limit: 1 },
        { callId: randomUUID(), signal: new AbortController().signal }
      );
      expect(first.isError).not.toBe(true);
      if (first.content[0]?.type !== 'text') throw new Error('Missing source history result.');
      const output = JSON.parse(first.content[0].text) as {
        next: { itemId: string; offset: number };
      };
      expect(output.next.offset).toBeGreaterThan(0);
      const next = await tool.tool.execute(
        { range, cursor: output.next, limit: 1 },
        { callId: randomUUID(), signal: new AbortController().signal }
      );
      expect(next.isError).not.toBe(true);
    }
    originals.push(
      await message(f, turn, 'assistant-message', `Decision ${index}: ${'a'.repeat(3600)}`)
    );
    await f.store.updateTurn(turn.id, { status: 'completed', completedAt: turn.startedAt });
  }
  const producer = await admit(f, f.workspace.id, thread.id);
  originals.push(await message(f, producer, 'user-message', currentText));
  const request = context(f, producer, 14_000);
  await prepareInternalAgentContext(request);
  const summaries = f.store
    .listThreadItems(f.workspace.id, thread.id)
    .filter((item): item is Summary => item.type === 'context-summary');
  expect(summaries.length).toBeGreaterThan(1);
  expect(summaries.at(-1)!.sourceRange.itemCount).toBeGreaterThan(4);
  expect(summaries.at(-1)!.sourceRange.evidenceDigest).not.toBe(
    sha(JSON.stringify({ version: 1, entries: [] }))
  );
  originals.push(await message(f, producer, 'assistant-message', 'The decision remains pending.'));
  await f.store.updateTurn(producer.id, { status: 'completed', completedAt: producer.startedAt });
  const traces = readTurnRetrievalTraces(
    join(f.dataRoot, 'workspaces', f.workspace.id),
    f.workspace.id,
    thread.id,
    traceTurn!.id
  );
  expect(traces).toHaveLength(2);
  expect(
    traces.some(
      ({ trace }) =>
        'sourceKind' in trace &&
        trace.retrievalParameters.mode === 'range' &&
        trace.retrievalParameters.cursor !== undefined
    )
  ).toBe(true);
  const { exportId, verified } = await exportHistory(f);
  return {
    ...f,
    thread,
    originals,
    summaries,
    traces,
    traceTurn: f.store.getTurnById(traceTurn!.id),
    exportId,
    verified,
  };
}

/** Exports canonical history through the real producer and verifies its consumed bytes. */
async function exportHistory(f: Awaited<ReturnType<typeof deployment>>) {
  const exported = await f.app.request(
    ...operationRequest('workspace.export', { workspaceId: f.workspace.id })
  );
  expect(exported.status, await exported.clone().text()).toBe(200);
  const { exportId } = (await exported.json()) as { exportId: string };
  const verified = verifyWorkspaceExportTree({
    exportRoot: existingWorkspaceExportRoot(f.dataRoot, f.workspace.id, exportId),
  });
  return { exportId, verified };
}

/** Computes expected selected body and canonical revision digests independently. */
function sha(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('Assistant conversation context portability', () => {
  it('exports a current-run compaction summary and its later exact-history trace without resuming the run', async () => {
    const source = await deployment();
    const thread = await source.store.createThread(
      source.workspace.id,
      'Bounded Knowledge run',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
    );
    const past = await admit(source, source.workspace.id, thread.id);
    const pastItem = await message(source, past, 'user-message', 'The prior decision is pending.');
    await source.store.updateTurn(past.id, { status: 'completed', completedAt: timestamp });
    const turn = await source.store.createTurn(
      source.workspace.id,
      thread.id,
      'Maintain the notebook.',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { agentId: 'knowledge-manager', startedAt: timestamp }
    );
    // Preserve real compaction pressure under the local bytes/3 estimate.
    const original = await message(
      source,
      turn,
      'user-message',
      `Keep the decision pending. ${'source '.repeat(4_800)}`
    );
    const owner = {
      store: source.store,
      coreDb: source.coreDb,
      actor: { kind: 'local' as const, userId: LOCAL_USER_ID },
      workspaceId: source.workspace.id,
      threadId: thread.id,
      turnId: turn.id,
    };
    const history = createAssistantHistory(owner);
    const priorRead = await history.tool.execute(
      {
        range: {
          threadId: thread.id,
          firstItemId: pastItem.id,
          lastItemId: pastItem.id,
          sourceDigest: internalContextSourceDigest(source.store, [pastItem]),
        },
      },
      { callId: randomUUID(), signal: new AbortController().signal }
    );
    expect(priorRead.isError).not.toBe(true);
    const tool = await source.store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId: source.workspace.id },
      threadId: thread.id,
      turnId: turn.id,
      type: 'tool-call',
      status: 'completed',
      tool: 'thread.history.read',
      server: null,
      arguments: {},
      result: JSON.stringify(priorRead.content),
      error: null,
      durationMs: 1,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const provider = vi.fn(async () => ({
      message: {
        role: 'assistant' as const,
        truncated: false,
        content: [{ type: 'text' as const, text: summaryText }],
      },
    }));
    await createCompactingInternalAgentProvider({
      store: source.store,
      turn,
      compactThreshold: 10_000,
      limits: { maxModelTurns: 3, maxToolCalls: 3, deadlineMs: 60_000 },
      assertCurrent: history.assertCurrent,
      readEvidence: (items) =>
        readInternalContextEvidence({ ...owner, items, strategy: 'compaction' }),
      commitMessages: () => [original, tool],
      callProvider: provider,
    })({
      systemPrompt: 'Preserve current constraints.',
      tools: [],
      model,
      signal: new AbortController().signal,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: original.type === 'user-message' ? original.text : '' }],
        },
      ],
    });
    const summary = source.store
      .getTurnById(turn.id)
      .items.find((item) => item.type === 'context-summary')!;
    const read = await history.tool.execute(
      {
        range: {
          threadId: thread.id,
          firstItemId: original.id,
          lastItemId: tool.id,
          sourceDigest: summary.sourceRange.sourceDigest,
        },
        limit: 1,
      },
      { callId: randomUUID(), signal: new AbortController().signal }
    );
    expect(read.isError).not.toBe(true);
    await source.store.updateTurn(turn.id, { status: 'completed', completedAt: timestamp });
    const originals = source.store
      .listThreadItems(source.workspace.id, thread.id)
      .filter((item) => item.type !== 'context-summary');
    const { verified } = await exportHistory(source);
    const exportedSummaries = verified.fileContents
      .get('records/item-revisions.jsonl')!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Item)
      .filter((item): item is Summary => item.type === 'context-summary');
    const sourceSummaries = source.store
      .listThreadItems(source.workspace.id, thread.id)
      .filter((item): item is Summary => item.type === 'context-summary');
    expect(exportedSummaries.map((item) => item.text)).toEqual(
      sourceSummaries.map((item) => item.text)
    );
    expect(exportedSummaries.map((item) => item.text)).toContain(summaryText);
    expect(exportedSummaries.map((item) => item.sourceRange.itemCount)).toEqual(
      sourceSummaries.map((item) => item.sourceRange.itemCount)
    );
    expect(exportedSummaries.map((item) => item.previousSummary?.digest ?? null)).toEqual(
      sourceSummaries.map((item) => item.previousSummary?.digest ?? null)
    );
    expect(
      source.store
        .listThreadItems(source.workspace.id, thread.id)
        .filter((item) => item.type !== 'context-summary')
    ).toEqual(originals);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  // Real archive export and a source restart retain the summary chain in this fixture budget.
  it('exports real archive bytes and reuses the summary chain after source restart', async () => {
    const source = await seed();
    const archive = await source.app.request(
      `/api/app/workspaces/${source.workspace.id}/exports/${source.exportId}/archive`
    );
    expect(archive.status, await archive.clone().text()).toBe(200);
    expect(
      source.store
        .listThreadItems(source.workspace.id, source.thread.id)
        .filter((item) => item.type !== 'context-summary')
    ).toEqual(source.originals);
    source.store = new FsStore({ dataRoot: source.dataRoot });
    const turn = await admit(source, source.workspace.id, source.thread.id);
    await message(source, turn, 'user-message', currentText);
    const request = context(source, turn, 16_000);
    const prepared = await prepareInternalAgentContext(request);
    expect(request.callProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(prepared.messages)).toContain(summaryText);
    expect(prepared.messages.at(-1)).toEqual(request.requiredMessages[0]);
  }, 60_000);
});
