import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, RetrievalTraceReference } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { type Actor, ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { readRetrievalTrace } from '../storage/retrieval-traces.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  assertConversationRetrievalTraceReadable,
  createAssistantHistory,
} from './assistant-history.js';
import type { AgentToolResult } from './internal-agent-loop.js';
import { internalContextSourceDigest } from './rolling-context.js';

const timestamp = '2026-10-16T00:00:00.000Z';
const privateText = 'RETAINED_PRIVATE_RANGE_DETAIL';
type MessageItem = Extract<Item, { type: 'user-message' }>;
type Cursor = { itemId: string; offset: number };
interface RangeResult {
  hits: Array<{
    reference: { workspaceId: string; threadId: string; turnId: string; itemId: string };
    revision: string;
    digest: string;
    snippet: string;
    offset: number;
    nextOffset: number;
  }>;
  complete: boolean;
  next?: Cursor;
  retrievalTraceRef: RetrievalTraceReference;
}

/** Composes the real canonical record, identity, membership and query-owned trace owners. */
function fixture(
  texts = [`${privateText} 😀漢e\u0301`.repeat(500), 'The unresolved decision is retained.']
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-history-range-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Exact source-bound history');
  // The querying member must be removable without violating canonical owner continuity.
  const ownerUserId = randomUUID();
  coreDb.sqlite
    .prepare(`INSERT INTO users
    (id, display_name, email, email_verified, created_at, updated_at, kind, status)
    VALUES (?, 'History owner', ?, 0, ?, ?, 'human', 'active')`)
    .run(ownerUserId, `${ownerUserId}@history.invalid`, Date.now(), Date.now());
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId });
  coreDb.sqlite
    .prepare(`INSERT INTO workspace_members
    (workspace_id, user_id, status, access_level, joined_at, revision, created_at, updated_at)
    VALUES (?, ?, 'active', 'editor', ?, 1, ?, ?)`)
    .run(workspace.id, LOCAL_USER_ID, timestamp, timestamp, timestamp);
  const audience = { visibility: 'private' as const, privateOwnerUserId: LOCAL_USER_ID };
  const source = store.createThread(
    workspace.id,
    'Past source',
    undefined,
    'conversation',
    audience
  );
  const destination = store.createThread(
    workspace.id,
    'Current conversation',
    undefined,
    'conversation',
    audience
  );
  const sourceTurn = store.createTurn(workspace.id, source.id, 'Retained source.', {
    kind: 'user',
    id: LOCAL_USER_ID,
  });
  const items = texts.map((text) => message(store, sourceTurn, text));
  const turn = store.createTurn(
    workspace.id,
    destination.id,
    'Read exact source history.',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    { agentId: 'quick-chat', executorKind: 'assistant' }
  );
  const actor: Actor = { kind: 'local', userId: LOCAL_USER_ID };
  const context = {
    store,
    coreDb,
    actor,
    workspaceId: workspace.id,
    threadId: destination.id,
    turnId: turn.id,
  };
  return {
    dataRoot,
    coreDb,
    store,
    workspace,
    source,
    sourceTurn,
    items,
    turn,
    context,
    history: createAssistantHistory(context),
  };
}

/** Creates an accepted source message through the existing Item owner. */
function message(
  store: FsStore,
  turn: ReturnType<FsStore['getTurnById']>,
  text: string
): MessageItem {
  return store.createItem({
    id: randomUUID(),
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'user-message',
    actor: { kind: 'user', id: LOCAL_USER_ID },
    text,
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
  }) as MessageItem;
}

/** Binds the requested fixture range through its actual source-digest producer. */
function range(f: ReturnType<typeof fixture>, items: readonly Item[] = f.items) {
  return {
    threadId: items[0]!.threadId,
    firstItemId: items[0]!.id,
    lastItemId: items.at(-1)!.id,
    sourceDigest: internalContextSourceDigest(f.store, items),
  };
}

/** Supplies only model query data; all identity and audience inputs stay in trusted assembly. */
function execute(f: ReturnType<typeof fixture>, query: unknown) {
  return f.history.tool.execute(query, {
    callId: randomUUID(),
    signal: new AbortController().signal,
  });
}

/** Parses only a completed Tool envelope and checks the whole serialized 64KiB boundary. */
function result(envelope: AgentToolResult): RangeResult {
  expect(envelope.isError).not.toBe(true);
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(64 * 1024);
  expect(envelope.content).toHaveLength(1);
  expect(envelope.content[0]!.type).toBe('text');
  if (envelope.content[0]!.type !== 'text') throw new Error('Expected a history text envelope.');
  return JSON.parse(envelope.content[0]!.text) as RangeResult;
}

/** Computes expected source body and revision digests without the summary implementation. */
function sha(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Reads actual immutable query trace bytes instead of treating a returned reference as proof. */
function traces(f: ReturnType<typeof fixture>) {
  const directory = join(
    f.dataRoot,
    'workspaces',
    f.workspace.id,
    'threads',
    f.context.threadId,
    'turns',
    f.turn.id,
    'retrieval-traces'
  );
  return existsSync(directory)
    ? readdirSync(directory)
        .sort()
        .map((name) => ({ name, bytes: readFileSync(join(directory, name), 'utf8') }))
    : [];
}

/** Fixes the exact refusal projection before examining any inaccessible source. */
function expectUnavailable(envelope: AgentToolResult) {
  expect(envelope.isError).toBe(true);
  expect(envelope.content).toEqual([
    {
      type: 'text',
      text: JSON.stringify({
        code: 'history_unavailable',
        message: 'Conversation history is unavailable under current source and audience checks.',
      }),
    },
  ]);
  expect(JSON.stringify(envelope)).not.toContain(privateText);
  expect(JSON.stringify(envelope)).not.toContain('retrievalTraceRef');
}

describe('Assistant exact source-bound history ranges', () => {
  it('returns failed Tool evidence as inert canonical JSON without changing its source Item', async () => {
    const f = fixture([]);
    const item = f.store.createItem({
      id: randomUUID(),
      workspaceId: f.workspace.id,
      threadId: f.source.id,
      turnId: f.sourceTurn.id,
      type: 'tool-call',
      tool: 'effect.operation',
      server: null,
      arguments: { instruction: 'A retained argument grants no effect authority.' },
      result: null,
      error: 'No confirmed result.',
      durationMs: null,
      status: 'failed',
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const before = f.store.listThreadItems(f.workspace.id, f.source.id);
    const output = result(await execute(f, { range: range(f, [item]) }));
    expect(output.complete).toBe(true);
    expect(output.hits).toHaveLength(1);
    expect(output.hits[0]!.snippet).toBe(JSON.stringify(item));
    expect(output.hits[0]!.digest).toBe(sha(JSON.stringify(item)));
    expect(f.store.listThreadItems(f.workspace.id, f.source.id)).toEqual(before);
  });

  it('traverses Unicode byte chunks and bounded pages without losing or repeating any source bytes', async () => {
    const unicode = `${privateText} 😀漢e\u0301`.repeat(500);
    const bodies = [
      unicode,
      ...Array.from({ length: 20 }, (_, index) => `Exact entry ${index}: ${'x'.repeat(4_050)}`),
    ];
    const f = fixture(bodies);
    const requestedRange = range(f);
    const chunks = new Map(f.items.map((item) => [item.id, [] as Buffer[]]));
    const offsets = new Map(f.items.map((item) => [item.id, 0]));
    const references: RetrievalTraceReference[] = [];
    const encountered: string[] = [];
    let cursor: Cursor | undefined;
    let sawByteContinuation = false;
    let sawEnvelopeContinuation = false;
    let complete = false;
    for (let page = 0; page < 40 && !complete; page += 1) {
      const output = result(
        await execute(f, { range: requestedRange, ...(cursor ? { cursor } : {}), limit: 20 })
      );
      references.push(output.retrievalTraceRef);
      expect(output.hits.length).toBeGreaterThan(0);
      expect(output.hits.length).toBeLessThanOrEqual(20);
      for (const hit of output.hits) {
        const item = f.items.find((candidate) => candidate.id === hit.reference.itemId);
        expect(item).toBeDefined();
        if (!item) throw new Error('Unexpected source reference.');
        expect(hit.reference).toEqual({
          workspaceId: f.workspace.id,
          threadId: f.source.id,
          turnId: item.turnId,
          itemId: item.id,
        });
        expect(hit.revision).toBe(sha(JSON.stringify(item)));
        expect(hit.digest).toBe(sha(item.text));
        expect(hit.offset).toBe(offsets.get(item.id));
        const bytes = Buffer.from(hit.snippet);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.length).toBeLessThanOrEqual(4096);
        expect(bytes).toEqual(Buffer.from(item.text).subarray(hit.offset, hit.nextOffset));
        expect(hit.nextOffset).toBe(hit.offset + bytes.length);
        if (hit.offset > 0) sawByteContinuation = true;
        if (hit.offset === 0) encountered.push(item.id);
        offsets.set(item.id, hit.nextOffset);
        chunks.get(item.id)!.push(bytes);
      }
      complete = output.complete;
      if (complete) expect(output.next).toBeUndefined();
      else {
        expect(output.next).toBeDefined();
        expect(output.next).not.toEqual(cursor);
        if (
          output.hits.length < 20 &&
          output.hits.at(-1)!.nextOffset ===
            Buffer.byteLength(
              f.items.find((item) => item.id === output.hits.at(-1)!.reference.itemId)!.text
            )
        )
          sawEnvelopeContinuation = true;
      }
      cursor = output.next;
      const trace = readRetrievalTrace(
        join(f.dataRoot, 'workspaces', f.workspace.id),
        output.retrievalTraceRef,
        'conversation'
      );
      expect(trace?.selected).toEqual(
        output.hits.map(({ reference, revision, digest }) => ({ reference, revision, digest }))
      );
      expect(trace?.retrievalParameters).toMatchObject({ mode: 'range', range: requestedRange });
      expect(() =>
        assertConversationRetrievalTraceReadable({
          ...f.context,
          retrievalTraceRef: output.retrievalTraceRef,
        })
      ).not.toThrow();
    }
    expect(complete).toBe(true);
    expect(sawByteContinuation).toBe(true);
    expect(sawEnvelopeContinuation).toBe(true);
    expect(encountered).toEqual(f.items.map((item) => item.id));
    for (const item of f.items)
      expect(Buffer.concat(chunks.get(item.id)!)).toEqual(Buffer.from(item.text));
    expect(new Set(references.map((reference) => reference.objectId)).size).toBe(references.length);
    expect(traces(f)).toHaveLength(references.length);
    for (const trace of traces(f)) {
      expect(trace.bytes).not.toContain(privateText);
      expect(trace.bytes).not.toContain('snippet');
    }
    expect(() => f.history.assertCurrent()).not.toThrow();
  });

  it.each([
    'foreign private',
    'cross Workspace',
    'digest mismatch',
    'hidden reasoning',
    'hidden summary',
    'incomplete message',
    'unknown cursor',
    'cursor past end',
    'cursor inside Unicode',
    'negative cursor',
  ] as const)('refuses %s without source bytes or a new trace', async (fault) => {
    const f = fixture();
    let requestedRange = range(f);
    let cursor: Cursor | undefined;
    if (fault === 'foreign private' || fault === 'cross Workspace') {
      const workspace =
        fault === 'cross Workspace' ? f.store.createWorkspace('Other Workspace') : f.workspace;
      if (fault === 'cross Workspace')
        recordWorkspaceOwnerMembership({
          coreDb: f.coreDb,
          workspaceId: workspace.id,
          ownerUserId: LOCAL_USER_ID,
        });
      const source = f.store.createThread(
        workspace.id,
        'Inaccessible source',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: fault === 'foreign private' ? randomUUID() : LOCAL_USER_ID,
        }
      );
      const turn = f.store.createTurn(workspace.id, source.id, 'Private source.', {
        kind: 'user',
        id: LOCAL_USER_ID,
      });
      requestedRange = range(f, [message(f.store, turn, privateText)]);
    } else if (fault === 'digest mismatch')
      requestedRange = { ...requestedRange, sourceDigest: `sha256:${'0'.repeat(64)}` };
    else if (fault === 'hidden reasoning' || fault === 'hidden summary') {
      const base = {
        id: randomUUID(),
        workspaceId: f.workspace.id,
        threadId: f.source.id,
        turnId: f.sourceTurn.id,
        status: 'completed' as const,
        createdAt: timestamp,
        completedAt: timestamp,
      };
      const hidden = f.store.createItem(
        fault === 'hidden reasoning'
          ? { ...base, type: 'reasoning', summary: [], content: [privateText] }
          : {
              ...base,
              type: 'context-summary',
              text: privateText,
              environmentDigest: sha('environment'),
              sourceRange: {
                ...requestedRange,
                itemCount: f.items.length,
                evidenceDigest: sha('evidence'),
              },
            }
      );
      requestedRange = range(f, [hidden]);
    } else if (fault === 'incomplete message') {
      const item = f.store.updateItem(f.items[0]!.id, { status: 'in_progress' });
      requestedRange = range(f, [item]);
    } else {
      cursor = {
        itemId: fault === 'unknown cursor' ? randomUUID() : f.items[0]!.id,
        offset:
          fault === 'cursor past end'
            ? Buffer.byteLength(f.items[0]!.text) + 1
            : fault === 'negative cursor'
              ? -1
              : fault === 'cursor inside Unicode'
                ? Buffer.byteLength(`${privateText} `) + 1
                : 0,
      };
    }
    const before = traces(f);
    expectUnavailable(await execute(f, { range: requestedRange, ...(cursor ? { cursor } : {}) }));
    expect(traces(f)).toEqual(before);
  });

  it.each([
    'selected source revision',
    'unread range revision',
    'membership removal',
  ] as const)('denies publication and retained trace reads after %s while preserving trace bytes', async (fault) => {
    const f = fixture();
    const output = result(await execute(f, { range: range(f), limit: 1 }));
    expect(output.hits).toHaveLength(1);
    expect(output.hits[0]!.reference.itemId).toBe(f.items[0]!.id);
    const guard = () =>
      assertConversationRetrievalTraceReadable({
        ...f.context,
        retrievalTraceRef: output.retrievalTraceRef,
      });
    expect(() => f.history.assertCurrent()).not.toThrow();
    expect(guard).not.toThrow();
    const before = traces(f);
    if (fault === 'membership removal') {
      f.coreDb.sqlite
        .prepare(
          "UPDATE workspace_members SET status = 'removed', removed_at = ?, revision = revision + 1 WHERE workspace_id = ? AND user_id = ?"
        )
        .run(timestamp, f.workspace.id, LOCAL_USER_ID);
    } else
      f.store.updateItem(f.items[fault === 'selected source revision' ? 0 : 1]!.id, {
        text: 'Source revision changed after observation.',
      });
    expect(() => f.history.assertCurrent()).toThrow(
      expect.objectContaining({ code: 'history_unavailable' })
    );
    expect(guard).toThrow(expect.objectContaining({ code: 'history_unavailable' }));
    expect(traces(f)).toEqual(before);
    expectUnavailable(await execute(f, { range: range(f) }));
    expect(traces(f)).toEqual(before);
  });
});
