import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '@openkit/protocol';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Actor } from './auth/identity.js';
import {
  assertConversationRetrievalTraceReadable,
  createAssistantHistory,
} from './internal-agents/assistant-history.js';
import { createCompactingInternalAgentProvider } from './internal-agents/compacting-context.js';
import type { AgentMessage } from './internal-agents/internal-agent-loop.js';
import { readInternalContextEvidence } from './internal-agents/internal-context-evidence.js';
import {
  internalContextItems,
  internalContextSourceDigest,
  prepareInternalAgentContext,
} from './internal-agents/rolling-context.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { readTurnRetrievalTraces, retrievalTraceRelativePath } from './storage/retrieval-traces.js';
import { verifyWorkspaceExportTree } from './storage/workspace-export.js';
import {
  existingWorkspaceExportRoot,
  importVerifiedWorkspace,
} from './storage/workspace-transfer-routes.js';
import { createApp } from './test-support/app.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { notebookImportFixture } from './test-support/notebook-import.js';
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
function deployment() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-context-portability-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Portable context');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
  const app = createApp({ dataRoot, coreDb, store });
  return { dataRoot, coreDb, store, workspace, app };
}

/** Admits sequential internal Turns with stable source order across portable identity remints. */
function admit(f: ReturnType<typeof deployment>, workspaceId: string, threadId: string): Turn {
  return f.store.createTurn(
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
function message(
  f: ReturnType<typeof deployment>,
  turn: Turn,
  type: 'user-message' | 'assistant-message',
  text: string
) {
  return f.store.createItem({
    id: allocateEntityId('it'),
    workspaceId: turn.workspaceId,
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
function context(f: ReturnType<typeof deployment>, turn: Turn, capacity: number) {
  const actor: Actor = { kind: 'local', userId: LOCAL_USER_ID };
  const owner = {
    store: f.store,
    coreDb: f.coreDb,
    actor,
    workspaceId: turn.workspaceId,
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
  const f = deployment();
  const thread = f.store.createThread(
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
    const turn = admit(f, f.workspace.id, thread.id);
    originals.push(
      message(
        f,
        turn,
        'user-message',
        index === 0
          ? `Exact Unicode source: ${'😀漢'.repeat(800)}`
          : `Question ${index}: ${'q'.repeat(3_600)}`
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
      message(f, turn, 'assistant-message', `Decision ${index}: ${'a'.repeat(3_600)}`)
    );
    f.store.updateTurn(turn.id, { status: 'completed', completedAt: turn.startedAt });
  }
  const producer = admit(f, f.workspace.id, thread.id);
  originals.push(message(f, producer, 'user-message', currentText));
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
  originals.push(message(f, producer, 'assistant-message', 'The decision remains pending.'));
  f.store.updateTurn(producer.id, { status: 'completed', completedAt: producer.startedAt });
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
async function exportHistory(f: ReturnType<typeof deployment>) {
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

/** Creates valid original proofs whose tied Turn order changes under index-based import identities. */
async function seedTiedOrderSummaryChain() {
  const f = deployment();
  const thread = f.store.createThread(
    f.workspace.id,
    'Tied source order',
    undefined,
    'conversation',
    {
      visibility: 'private',
      privateOwnerUserId: LOCAL_USER_ID,
    }
  );
  const originals: Item[] = [];
  const summaries: Summary[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const turn = f.store.createTurn(
      f.workspace.id,
      thread.id,
      currentText,
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      {
        turnId: `tu_00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        agentId: 'quick-chat',
        executorKind: 'assistant',
        startedAt: timestamp,
      }
    );
    if (index <= 10) {
      originals.push(message(f, turn, 'user-message', `Tied source ${index}`));
    } else {
      const covered = originals.slice(0, index === 11 ? 4 : 10);
      const previous = summaries.at(-1);
      const summary = f.store.createItem({
        id: allocateEntityId('it'),
        workspaceId: f.workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        type: 'context-summary',
        strategy: 'rolling',
        logicalModelId: model.logicalModelId,
        status: 'completed',
        text: summaryText,
        environmentDigest: sha('tied-order role environment'),
        sourceRange: {
          firstItemId: covered[0]!.id,
          lastItemId: covered.at(-1)!.id,
          itemCount: covered.length,
          sourceDigest: internalContextSourceDigest(f.store, covered),
          evidenceDigest: sha(JSON.stringify({ version: 1, entries: [] })),
        },
        ...(previous
          ? { previousSummary: { itemId: previous.id, digest: sha(JSON.stringify(previous)) } }
          : {}),
        createdAt: timestamp,
        completedAt: timestamp,
      });
      if (summary.type !== 'context-summary') throw new Error('Missing source summary.');
      summaries.push(summary);
    }
    f.store.updateTurn(turn.id, { status: 'completed', completedAt: timestamp });
  }
  return { ...f, thread, originals, summaries, ...(await exportHistory(f)) };
}

/** Computes expected selected body and canonical revision digests independently. */
function sha(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('Assistant conversation context portability', () => {
  it('remints a current-run compaction summary and its later exact-history trace without resuming the run', async () => {
    const source = deployment();
    const thread = source.store.createThread(
      source.workspace.id,
      'Bounded Knowledge run',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
    );
    const past = admit(source, source.workspace.id, thread.id);
    const pastItem = message(source, past, 'user-message', 'The prior decision is pending.');
    source.store.updateTurn(past.id, { status: 'completed', completedAt: timestamp });
    const turn = source.store.createTurn(
      source.workspace.id,
      thread.id,
      'Maintain the notebook.',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { agentId: 'knowledge-manager', executorKind: 'assistant', startedAt: timestamp }
    );
    // Preserve real compaction pressure under the local bytes/3 estimate.
    const original = message(
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
    const tool = source.store.createItem({
      id: allocateEntityId('it'),
      workspaceId: source.workspace.id,
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
    source.store.updateTurn(turn.id, { status: 'completed', completedAt: timestamp });
    const { verified } = await exportHistory(source);
    const target = deployment();
    const imported = importVerifiedWorkspace({
      authorityUserId: LOCAL_USER_ID,
      coreDb: target.coreDb,
      dataRoot: target.dataRoot,
      requestId: randomUUID(),
      store: target.store,
      verified,
    });
    target.store = new FsStore({ dataRoot: target.dataRoot });
    const importedThread = target.store
      .listThreads(imported.importedWorkspaceId)
      .find((entry) => entry.name === thread.name)!;
    const importedTurn = target.store
      .listThreadTurns(imported.importedWorkspaceId, importedThread.id)
      .find((entry) => entry.agentId === 'knowledge-manager')!;
    const importedItems = target.store.getTurnById(importedTurn.id).items;
    const importedSource = importedItems.find((item) => item.type === 'user-message')!;
    const importedTool = importedItems.find((item) => item.type === 'tool-call')!;
    const importedSummary = importedItems.find((item) => item.type === 'context-summary')!;
    expect(importedSummary).toMatchObject({
      strategy: 'compaction',
      logicalModelId: model.logicalModelId,
      text: summaryText,
      sourceRange: {
        firstItemId: importedSource.id,
        lastItemId: importedTool.id,
        itemCount: 2,
        sourceDigest: internalContextSourceDigest(
          target.store,
          [importedSource, importedTool],
          'compaction'
        ),
        evidenceDigest: readInternalContextEvidence({
          store: target.store,
          coreDb: target.coreDb,
          actor: { kind: 'local', userId: LOCAL_USER_ID },
          workspaceId: imported.importedWorkspaceId,
          threadId: importedThread.id,
          items: [importedSource, importedTool],
          strategy: 'compaction',
        }),
      },
    });
    expect(importedSummary.sourceRange.sourceDigest).not.toBe(summary.sourceRange.sourceDigest);
    const traces = readTurnRetrievalTraces(
      join(target.dataRoot, 'workspaces', imported.importedWorkspaceId),
      imported.importedWorkspaceId,
      importedThread.id,
      importedTurn.id
    );
    expect(traces).toHaveLength(2);
    const trace = traces.find(
      ({ trace }) =>
        'sourceKind' in trace &&
        trace.retrievalParameters.mode === 'range' &&
        trace.retrievalParameters.range.firstItemId === importedSource.id
    )!;
    expect(importedTool.result).toContain(
      `retrieval-trace/turn/${imported.importedWorkspaceId}/${importedThread.id}/${importedTurn.id}`
    );
    expect(trace.trace).toMatchObject({
      retrievalParameters: {
        mode: 'range',
        range: {
          firstItemId: importedSource.id,
          lastItemId: importedTool.id,
          sourceDigest: importedSummary.sourceRange.sourceDigest,
        },
      },
    });
    expect(() =>
      assertConversationRetrievalTraceReadable({
        store: target.store,
        coreDb: target.coreDb,
        actor: { kind: 'local', userId: LOCAL_USER_ID },
        workspaceId: imported.importedWorkspaceId,
        retrievalTraceRef: trace!.reference,
      })
    ).not.toThrow();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  // This fixture creates three real deployments and imports durable history twice.
  it('rejects a corrupt original predecessor before publication when tied source order changes on import', async () => {
    const source = await seedTiedOrderSummaryChain();
    const control = deployment();
    // Control only clock and entropy; import validation and canonical publication stay real.
    const importReordered = (input: Parameters<typeof importVerifiedWorkspace>[0]) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(timestamp));
      let ordinal = 0;
      const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
        if (!array) throw new Error('Missing UUID entropy target.');
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        bytes.fill(0);
        ordinal += 1;
        const turn = ordinal - 1; // One imported Thread precedes the twelve Turn allocations.
        bytes[15] = turn === 10 ? 2 : turn >= 2 && turn <= 9 ? turn + 1 : turn > 0 ? turn : ordinal;
        return array;
      });
      try {
        return importVerifiedWorkspace(input);
      } finally {
        entropy.mockRestore();
        vi.useRealTimers();
      }
    };
    const imported = importReordered({
      authorityUserId: LOCAL_USER_ID,
      coreDb: control.coreDb,
      dataRoot: control.dataRoot,
      requestId: randomUUID(),
      store: control.store,
      verified: source.verified,
    });
    const targetThread = control.store.listThreads(imported.importedWorkspaceId)[0]!;
    const targetTurns = control.store.listThreadTurns(
      imported.importedWorkspaceId,
      targetThread.id
    );
    const targetSummary = control.store
      .listThreadItems(imported.importedWorkspaceId, targetThread.id)
      .find(
        (item): item is Summary =>
          item.type === 'context-summary' && item.sourceRange.itemCount === 10
      )!;
    const targetHistory = internalContextItems(
      control.store,
      targetTurns.find((turn) => turn.id === targetSummary.turnId)!
    );
    expect(targetHistory.map((item) => ('text' in item ? item.text : ''))).toEqual(
      [1, 10, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => `Tied source ${index}`)
    );
    expect(targetSummary.sourceRange.sourceDigest).toBe(
      source.summaries[1]!.sourceRange.sourceDigest
    );
    expect(targetSummary.sourceRange.sourceDigest).not.toBe(
      internalContextSourceDigest(control.store, targetHistory)
    );
    expect(source.summaries[1]!.previousSummary!.digest).toBe(
      sha(JSON.stringify(source.summaries[0]))
    );

    const target = deployment();
    const inventory = readdirSync(join(target.dataRoot, 'workspaces')).sort();
    const registry = target.coreDb.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const fileContents = new Map(source.verified.fileContents);
    const corrupt = (item: Item): Item =>
      item.id === source.summaries[1]!.id && item.type === 'context-summary'
        ? {
            ...item,
            previousSummary: { ...item.previousSummary!, digest: `sha256:${'0'.repeat(64)}` },
          }
        : item;
    // Both canonical representations carry the same single corrupt proof at the consumed-byte seam.
    for (const path of ['records/item-revisions.jsonl', 'records/turns.jsonl']) {
      const records = fileContents
        .get(path)!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      fileContents.set(
        path,
        `${records
          .map((record) =>
            JSON.stringify(
              path.includes('turns')
                ? { ...record, items: record.items.map(corrupt) }
                : corrupt(record)
            )
          )
          .join('\n')}\n`
      );
    }
    expect
      .soft(() =>
        importReordered({
          authorityUserId: LOCAL_USER_ID,
          coreDb: target.coreDb,
          dataRoot: target.dataRoot,
          requestId: randomUUID(),
          store: target.store,
          verified: { ...source.verified, fileContents },
        })
      )
      .toThrow(/summary predecessor is contradictory/);
    expect.soft(readdirSync(join(target.dataRoot, 'workspaces')).sort()).toEqual(inventory);
    expect
      .soft(
        target.coreDb.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
      )
      .toEqual(registry);
  }, 60_000);

  // Real archive export, import and restart retain all canonical writes in this fixture budget.
  it('exports and imports real archive bytes, remints source evidence, and reuses the summary chain after target restart', async () => {
    const source = await seed();
    const target = deployment();
    // P14 uses independent Workspace identities; explicitly occupy the exported id to test reminting.
    target.store.importWorkspaceSnapshot({
      ...notebookImportFixture({ workspaceId: source.workspace.id, knowledge: [] }),
      workspace: source.workspace,
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    });
    recordWorkspaceOwnerMembership({
      coreDb: target.coreDb,
      workspaceId: source.workspace.id,
      ownerUserId: LOCAL_USER_ID,
    });
    const archive = await source.app.request(
      `/api/app/workspaces/${source.workspace.id}/exports/${source.exportId}/archive`
    );
    expect(archive.status, await archive.clone().text()).toBe(200);
    const imported = await target.app.request('/api/app/workspace-archives/import', {
      method: 'POST',
      body: new Blob([await archive.arrayBuffer()]),
      headers: {
        'content-type': archive.headers.get('content-type')!,
        'x-openkit-request-id': randomUUID(),
      },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
    const { importedWorkspaceId } = (await imported.json()) as { importedWorkspaceId: string };
    expect(importedWorkspaceId).not.toBe(source.workspace.id);
    target.store = new FsStore({ dataRoot: target.dataRoot });
    const thread = target.store
      .listThreads(importedWorkspaceId)
      .find((candidate) => candidate.name === source.thread.name)!;
    expect(thread.id).not.toBe(source.thread.id);
    const items = target.store.listThreadItems(importedWorkspaceId, thread.id);
    const targetSource = items.filter(
      (item) => item.type === 'user-message' || item.type === 'assistant-message'
    );
    expect(targetSource).toHaveLength(source.originals.length);
    expect(
      targetSource.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), 0)
    ).toBeGreaterThan(16_000);
    const reminted = new Map(
      source.originals.map((original) => [
        original.id,
        targetSource.find(
          (candidate) =>
            'text' in candidate && 'text' in original && candidate.text === original.text
        )!,
      ])
    );
    for (const original of source.originals) {
      const item = reminted.get(original.id)!;
      expect(item).toBeDefined();
      expect(item.id).not.toBe(original.id);
      expect(item).toMatchObject({
        type: original.type,
        ...('text' in original ? { text: original.text } : {}),
      });
    }
    const query = target.store
      .listThreadTurns(importedWorkspaceId, thread.id)
      .find((turn) =>
        turn.items.some((item) => item.id === reminted.get(source.traceTurn.items[0]!.id)?.id)
      )!;
    const traces = readTurnRetrievalTraces(
      join(target.dataRoot, 'workspaces', importedWorkspaceId),
      importedWorkspaceId,
      thread.id,
      query.id
    );
    expect(traces).toHaveLength(2);
    for (const { reference, trace } of traces) {
      expect('sourceKind' in trace).toBe(true);
      if (!('sourceKind' in trace)) throw new Error('Missing conversation trace.');
      const original = source.traces.find(
        (entry) => entry.reference.objectId === reference.objectId
      )!;
      expect(reference.scopeId).not.toBe(original.reference.scopeId);
      expect(trace.queryContext).toMatchObject({
        serverId: readDataRootLayoutMarker(target.dataRoot).deploymentId,
        workspaceId: importedWorkspaceId,
        threadId: thread.id,
        turnId: query.id,
      });
      for (const selection of trace.selected) {
        const item = items.find((candidate) => candidate.id === selection.reference.itemId)!;
        expect(selection.reference).toEqual({
          workspaceId: importedWorkspaceId,
          threadId: thread.id,
          turnId: item.turnId,
          itemId: item.id,
        });
        expect(selection.revision).toBe(sha(JSON.stringify(item)));
        expect(selection.digest).toBe(sha('text' in item ? item.text : JSON.stringify(item)));
      }
      expect(trace.retrievalParameters.mode).toBe('range');
      if (
        trace.retrievalParameters.mode !== 'range' ||
        !('sourceKind' in original.trace) ||
        original.trace.retrievalParameters.mode !== 'range'
      )
        throw new Error('Missing portable exact range.');
      expect(trace.retrievalParameters.range).toEqual({
        threadId: thread.id,
        firstItemId: reminted.get(source.originals[0]!.id)!.id,
        lastItemId: reminted.get(source.originals[1]!.id)!.id,
        sourceDigest: internalContextSourceDigest(target.store, [
          reminted.get(source.originals[0]!.id)!,
          reminted.get(source.originals[1]!.id)!,
        ]),
      });
      if (original.trace.retrievalParameters.cursor)
        expect(trace.retrievalParameters.cursor).toEqual({
          itemId: reminted.get(original.trace.retrievalParameters.cursor.itemId)!.id,
          offset: original.trace.retrievalParameters.cursor.offset,
        });
      expect(() =>
        assertConversationRetrievalTraceReadable({
          store: target.store,
          coreDb: target.coreDb,
          actor: { kind: 'local', userId: LOCAL_USER_ID },
          workspaceId: importedWorkspaceId,
          retrievalTraceRef: reference,
        })
      ).not.toThrow();
    }
    const summaries = items.filter((item): item is Summary => item.type === 'context-summary');
    expect(summaries).toHaveLength(source.summaries.length);
    for (const summary of summaries) {
      const original = source.summaries.find(
        (candidate) => candidate.sourceRange.itemCount === summary.sourceRange.itemCount
      )!;
      expect(summary.sourceRange.firstItemId).toBe(
        reminted.get(original.sourceRange.firstItemId)!.id
      );
      expect(summary.sourceRange.lastItemId).toBe(
        reminted.get(original.sourceRange.lastItemId)!.id
      );
      const covered = source.originals
        .slice(0, original.sourceRange.itemCount)
        .map((item) => reminted.get(item.id)!);
      expect(summary.sourceRange.sourceDigest).toBe(
        internalContextSourceDigest(target.store, covered)
      );
      expect(summary.sourceRange.evidenceDigest).toBe(
        readInternalContextEvidence({
          store: target.store,
          coreDb: target.coreDb,
          actor: { kind: 'local', userId: LOCAL_USER_ID },
          workspaceId: importedWorkspaceId,
          threadId: thread.id,
          items: covered,
        })
      );
      if (summary.previousSummary)
        expect(summary.previousSummary.digest).toBe(
          sha(
            JSON.stringify(
              summaries.find((candidate) => candidate.id === summary.previousSummary!.itemId)
            )
          )
        );
    }
    const turn = admit(target, importedWorkspaceId, thread.id);
    message(target, turn, 'user-message', currentText);
    const request = context(target, turn, 16_000);
    const prepared = await prepareInternalAgentContext(request);
    expect(request.callProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(prepared.messages)).toContain(summaryText);
    expect(prepared.messages.at(-1)).toEqual(request.requiredMessages[0]);
    expect(
      source.store
        .listThreadItems(source.workspace.id, source.thread.id)
        .filter((item) => item.type !== 'context-summary')
    ).toEqual(source.originals);
  }, 60_000);

  it('rejects contradictory selected bytes, exact ranges and summary proof at the verified-byte import seam before publication', async () => {
    const source = await seed();
    const target = deployment();
    const inventory = readdirSync(join(target.dataRoot, 'workspaces')).sort();
    const registry = target.coreDb.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    for (const fault of ['selected digest', 'range digest', 'summary proof'] as const) {
      // Transport verification is proved above. This fault enters the existing consumed-byte seam.
      const fileContents = new Map(source.verified.fileContents);
      if (fault === 'summary proof') {
        const id = source.summaries[0]!.id;
        const corrupt = (item: Item) =>
          item.id === id && item.type === 'context-summary'
            ? {
                ...item,
                sourceRange: {
                  ...item.sourceRange,
                  sourceDigest: sha('contradictory summary source'),
                },
              }
            : item;
        for (const path of ['records/item-revisions.jsonl', 'records/turns.jsonl']) {
          const records = fileContents
            .get(path)!
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          fileContents.set(
            path,
            `${records
              .map((record) =>
                JSON.stringify(
                  path.includes('turns')
                    ? { ...record, items: record.items.map(corrupt) }
                    : corrupt(record)
                )
              )
              .join('\n')}\n`
          );
        }
      } else {
        const path = `workspace-files/${retrievalTraceRelativePath(source.traces[0]!.reference)}`;
        const trace = JSON.parse(fileContents.get(path)!);
        if (fault === 'selected digest')
          trace.selected[0].digest = sha('contradictory selected bytes');
        else trace.retrievalParameters.range.sourceDigest = sha('contradictory range');
        fileContents.set(path, JSON.stringify(trace));
      }
      expect(
        () =>
          importVerifiedWorkspace({
            authorityUserId: LOCAL_USER_ID,
            coreDb: target.coreDb,
            dataRoot: target.dataRoot,
            requestId: randomUUID(),
            store: target.store,
            verified: { ...source.verified, fileContents },
          }),
        fault
      ).toThrow(
        fault === 'selected digest'
          ? /conversation trace does not match its canonical Item/
          : fault === 'range digest'
            ? /exact history range is contradictory/
            : /summary source proof is contradictory/
      );
      expect(readdirSync(join(target.dataRoot, 'workspaces')).sort(), fault).toEqual(inventory);
      expect(
        target.coreDb.sqlite
          .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
          .all(),
        fault
      ).toEqual(registry);
    }
  });
});
