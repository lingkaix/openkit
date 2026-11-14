import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { StoreRecordNotFoundError } from '../lib/store.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { observeRetainedItemBodies } from '../test-support/retained-body-observation.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import {
  prepareControlKnowledgeAuthorityTransfer,
  readControlKnowledgeHead,
} from './control-store-knowledge.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyNativeScopeMigrations, listAppliedNativeMigrationIds } from './migrate.js';
import * as products from './workspace-file-records.js';
import { nativeProductScope } from './workspace-file-records.js';

/**
 * Independent TB1 oracle, fixed from Conversation Timeline TB1/G1/G9 and Core Storage.
 * Admission, not timestamps or identifiers, decides run order. A pending run stays last.
 * Revisions never move admission keys or inflate immutable Item-kind counts.
 * Wrong lineage discloses no Item body; count reads decode no Item body.
 * The scale population is exactly 200 Threads × 250 Turns, then the same target
 * stays at 250 while each of the other 199 Threads grows to 2,500 Turns.
 * Decoded-record isolation is deterministic. Timing is reported as a measurement,
 * with raw samples, rather than accepted through an invented noise tolerance.
 */
describe('TB1 independent Thread-scoped behavior', () => {
  const roots: string[] = [];
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const workspaceId = DEMO_WORKSPACE_ID;

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await disposeTestStore(root);
  });

  /** Creates genuine native scope fixtures; no SQL setup or mocked read owner. */
  async function fixture() {
    const dataRoot = mkdtempSync(join(tmpdir(), 'tb1-behavior-'));
    roots.push(dataRoot);
    const store = await createDemoStore({ dataRoot });
    const thread = store.getThread(workspaceId, DEMO_THREAD_ID);
    return { dataRoot, store, thread };
  }

  it('keeps admission order across reversed start times, pending work, revisions and reopen', async () => {
    const { dataRoot, store, thread } = await fixture();
    const first = await store.createTurn(workspaceId, thread.id, 'First', actor, null, {
      startedAt: '2026-11-08T12:00:00.000Z',
    });
    await store.updateTurn(first.id, { configVersion: 2 });
    await store.updateTurn(first.id, {
      status: 'completed',
      completedAt: '2026-11-08T14:00:00.000Z',
    });
    const second = await store.createTurn(workspaceId, thread.id, 'Second', actor, null, {
      startedAt: '2026-11-08T11:00:00.000Z',
    });
    await store.updateTurn(second.id, {
      status: 'completed',
      completedAt: '2026-11-08T14:00:00.000Z',
    });
    const pending = await store.createTurn(workspaceId, thread.id, 'Pending', actor, null, {
      status: 'pending',
    });
    // The higher Store constructor always sets startedAt. Its native product owner
    // can represent genuine admitted work that has not started, as G9 requires.
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
    const retained = products.readNativeProduct(scope, 'turn', pending.id)!;
    await getControlStoreWorkerClient().products(`workspace:${scope.path}`, {
      products: [
        {
          kind: 'turn',
          expectedRevision: retained.revision,
          record: { ...retained.record, startedAt: null },
        },
      ],
      entries: [],
    });
    const expected = [first.id, second.id, pending.id];
    expect(store.listThreadTurns(workspaceId, thread.id).map((turn) => turn.id)).toEqual(expected);
    await shutdownControlStoreWorkerClient();
    const reopened = createTestStore({ dataRoot });
    expect(reopened.listThreadTurns(workspaceId, thread.id).map((turn) => turn.id)).toEqual(
      expected
    );
    expect(reopened.listThreadTurns(workspaceId, thread.id)[2]?.startedAt).toBeNull();
  });

  it('resumes native pages after an immutable key without reordering revised or appended Turns', async () => {
    const { dataRoot, store, thread } = await fixture();
    const turns = [];
    for (let index = 0; index < 5; index++) {
      const turn = await store.createTurn(workspaceId, thread.id, `Run ${index}`, actor, null);
      turns.push(turn);
      if (index < 4)
        await store.updateTurn(turn.id, {
          status: 'completed',
          completedAt: '2026-11-08T14:00:00.000Z',
        });
    }
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
    const before = [...products.readNativeThreadTurnPages(scope, thread.id)].flat();
    expect(before.map((row) => row.record.id)).toEqual(turns.map((turn) => turn.id));
    const keys = before.map((row) => row.admissionOrder);
    expect(keys.every((key) => Number.isSafeInteger(key) && key > 0)).toBe(true);
    expect(new Set(keys).size).toBe(turns.length);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    await store.updateTurn(turns[4]!.id, { configVersion: 3 });
    await store.updateTurn(turns[4]!.id, {
      status: 'completed',
      completedAt: '2026-11-08T14:00:00.000Z',
    });
    const appended = await store.createTurn(workspaceId, thread.id, 'Appended', actor, null);
    const resumed = [...products.readNativeThreadTurnPages(scope, thread.id, keys[1]!)].flat();
    expect(resumed.map((row) => row.record.id)).toEqual([
      ...turns.slice(2).map((turn) => turn.id),
      appended.id,
    ]);
    const after = [...products.readNativeThreadTurnPages(scope, thread.id)].flat();
    expect(after.slice(0, 5).map((row) => row.admissionOrder)).toEqual(keys);
  });

  it('keeps Server Turn admission order through Core metadata updates and reopen', async () => {
    const { dataRoot, store } = await fixture();
    const thread = await store.createServerThread('Server admission behavior');
    const first = await store.createServerTurn(thread.id, 'First', actor, null, {
      startedAt: '2026-11-08T12:00:00.000Z',
    });
    await store.completeTurn(first.id, {
      status: 'completed',
      completedAt: '2026-11-08T14:00:00.000Z',
    });
    const second = await store.createServerTurn(thread.id, 'Second', actor, null, {
      startedAt: '2026-11-08T11:00:00.000Z',
    });
    const scope = nativeProductScope(dataRoot, { kind: 'server' });
    const before = [...products.readNativeThreadTurnPages(scope, thread.id)].flat();
    await store.updateServerTurn(second.id, { configVersion: 4 });
    await store.completeTurn(second.id, {
      status: 'completed',
      completedAt: '2026-11-08T14:00:00.000Z',
    });
    const pending = await store.createServerTurn(thread.id, 'Pending', actor, null, {
      status: 'pending',
    });
    const retained = products.readNativeProduct(scope, 'turn', pending.id)!;
    await getControlStoreWorkerClient().products(`core:${scope.path}`, {
      products: [
        {
          kind: 'turn',
          expectedRevision: retained.revision,
          record: { ...retained.record, startedAt: null },
        },
      ],
      entries: [],
    });
    const expected = [first.id, second.id, pending.id];
    expect(store.listServerThreadTurns(thread.id).map((turn) => turn.id)).toEqual(expected);
    const after = [...products.readNativeThreadTurnPages(scope, thread.id)].flat();
    expect(after.slice(0, 2).map((row) => row.admissionOrder)).toEqual(
      before.map((row) => row.admissionOrder)
    );
    await shutdownControlStoreWorkerClient();
    const reopened = createTestStore({ dataRoot });
    expect(reopened.listServerThreadTurns(thread.id).map((turn) => turn.id)).toEqual(expected);
    expect(reopened.listServerThreadTurns(thread.id)[2]?.startedAt).toBeNull();
  });

  it('looks up only the supplied Thread Item and refuses other lineage before body disclosure', async () => {
    const { dataRoot, store, thread } = await fixture();
    const other = await store.createThread(workspaceId, 'Other lineage');
    const otherWorkspace = await store.ensureQuickChatWorkspace(actor.id);
    const turn = await store.createTurn(workspaceId, thread.id, 'Item owner', actor, null);
    const item = await store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Retained body. '.repeat(10_000),
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:00.000Z',
    });
    expect(store.getThreadItem(workspaceId, thread.id, item.id)).toEqual(item);
    const observation = { itemIds: new Set([item.id]), bodies: 0 };
    const bodies = observeRetainedItemBodies(observation);
    try {
      const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
      expect(products.readNativeThreadItem(scope, other.id, item.id)).toBeUndefined();
      expect(() => store.getThreadItem(workspaceId, other.id, item.id)).toThrow(
        StoreRecordNotFoundError
      );
      expect(() => store.getThreadItem(workspaceId, allocateEntityId('th'), item.id)).toThrow(
        StoreRecordNotFoundError
      );
      expect(() => store.getThreadItem(workspaceId, thread.id, allocateEntityId('it'))).toThrow(
        StoreRecordNotFoundError
      );
      expect(() => store.getThreadItem(otherWorkspace.id, thread.id, item.id)).toThrow(
        StoreRecordNotFoundError
      );
      expect(observation.bodies).toBe(0);
    } finally {
      bodies.restore();
    }
  });

  it('counts distinct original Items by type without decoding bodies and rejects a foreign Turn', async () => {
    const { dataRoot, store, thread } = await fixture();
    const other = await store.createThread(workspaceId, 'Other counts');
    const turn = await store.createTurn(workspaceId, thread.id, 'Count input', actor, null);
    const empty = await store.createTurn(workspaceId, other.id, 'Empty count input', actor, null);
    const input = await store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      actor,
      status: 'completed',
      text: 'Original input',
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:00.000Z',
    });
    const one = await store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'Large first revision. '.repeat(10_000),
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: null,
    });
    const two = await store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId: thread.id,
      turnId: turn.id,
      type: 'reasoning',
      status: 'completed',
      summary: ['A note'],
      content: ['Note body'],
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:00.000Z',
    });
    const anotherMessage = await store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'A separate message',
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:00.000Z',
    });
    await store.updateItem(one.id, { text: 'Second revision' });
    await store.updateItem(one.id, { text: 'Final revision', status: 'completed' });
    // Later Item revisions add no kind count; raw createTurn publishes no implicit input Item.
    const expected = { 'user-message': 1, 'assistant-message': 2, reasoning: 1 };
    const observation = {
      itemIds: new Set([one.id, two.id, input.id, anotherMessage.id]),
      bodies: 0,
    };
    const bodies = observeRetainedItemBodies(observation);
    try {
      const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
      expect(products.readNativeTurnItemCounts(scope, thread.id, turn.id)).toEqual(expected);
      expect(store.getThreadTurnItemCounts(workspaceId, thread.id, turn.id)).toEqual(expected);
      expect(store.getThreadTurnItemCounts(workspaceId, other.id, empty.id)).toEqual({});
      expect(() => store.getThreadTurnItemCounts(workspaceId, other.id, turn.id)).toThrow(
        StoreRecordNotFoundError
      );
      expect(() =>
        store.getThreadTurnItemCounts(workspaceId, thread.id, allocateEntityId('tu'))
      ).toThrow(StoreRecordNotFoundError);
      expect(observation.bodies).toBe(0);
    } finally {
      bodies.restore();
    }
  });

  it('decodes only 250 target Turns before and after unrelated history grows tenfold', async () => {
    const { dataRoot, store, thread } = await fixture();
    const threads = [thread];
    for (let index = 1; index < 200; index++) {
      threads.push(await store.createThread(workspaceId, `Scale Thread ${index}`));
    }
    const template = await store.createTurn(workspaceId, thread.id, 'Scale template', actor, null);
    await store.updateTurn(template.id, {
      status: 'completed',
      completedAt: '2026-11-08T14:00:00.000Z',
    });
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
    const retained = products.readNativeProduct(scope, 'turn', template.id)!;
    await shutdownControlStoreWorkerClient();
    const targetIds: string[] = [template.id];
    const foreignIds = new Set<string>();
    /**
     * Prepares a real SQLite read fixture from one owner-created terminal record.
     * The native writer is stopped. This storage-owner test does not qualify publication,
     * execution, receipts or sealing; insertion exercises the real admission trigger.
     */
    async function populate(from: number, to: number, includeTarget: boolean) {
      const db = new Database(scope.path, { fileMustExist: true });
      try {
        db.pragma('foreign_keys = ON');
        const insert = db.prepare(
          'INSERT INTO control_turns(id,thread_id,agent_session_id,status,schema_version,revision,record_json) VALUES(?,?,NULL,?,1,1,?)'
        );
        db.transaction(() => {
          for (const [index, entry] of threads.entries()) {
            if (index === 0 && !includeTarget) continue;
            for (let ordinal = from; ordinal < to; ordinal++) {
              if (index === 0 && ordinal === 0) continue;
              const id = allocateEntityId('tu');
              const record = { ...retained.record, id, threadId: entry.id };
              insert.run(id, entry.id, record.status, JSON.stringify(record));
              if (index === 0) targetIds.push(id);
              else foreignIds.add(id);
            }
          }
        })();
      } finally {
        db.close();
      }
    }
    /** Observes actual decoded retained Turn records while preserving every decoder result. */
    function observeSelection() {
      const decoded: string[] = [];
      const original = JSON.parse;
      const observer = vi
        .spyOn(JSON, 'parse')
        .mockImplementation((...args: Parameters<typeof JSON.parse>) => {
          const value = Reflect.apply(original, JSON, args);
          if (
            value &&
            typeof value === 'object' &&
            typeof value.id === 'string' &&
            'threadId' in value &&
            'triggerActor' in value
          ) {
            decoded.push(value.id);
          }
          return value;
        });
      try {
        const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
        const rows = [...products.readNativeThreadTurnPages(scope, thread.id)].flat();
        expect(rows.map((row) => row.record.id)).toEqual(targetIds);
        expect(new Set(decoded)).toEqual(new Set(targetIds));
        expect(decoded.some((id) => foreignIds.has(id))).toBe(false);
      } finally {
        observer.mockRestore();
      }
    }
    /** Measures scoped listing on the already-running Store, excluding unrelated bootstrap. */
    function measure(): number[] {
      const reader = store;
      for (let index = 0; index < 5; index++) reader.listThreadTurns(workspaceId, thread.id);
      const batches: number[] = [];
      for (let batch = 0; batch < 9; batch++) {
        const start = performance.now();
        for (let repetition = 0; repetition < 10; repetition++) {
          expect(reader.listThreadTurns(workspaceId, thread.id).map((turn) => turn.id)).toEqual(
            targetIds
          );
        }
        batches.push((performance.now() - start) / 10);
      }
      return batches;
    }
    await populate(0, 250, true);
    expect(targetIds).toHaveLength(250);
    expect(foreignIds.size).toBe(199 * 250);
    observeSelection();
    const before = measure();
    await populate(250, 2_500, false);
    expect(targetIds).toHaveLength(250);
    expect(foreignIds.size).toBe(199 * 2_500);
    observeSelection();
    const after = measure();
    console.info(
      'TB1 scale measurement',
      JSON.stringify({
        threads: 200,
        targetTurns: 250,
        otherTurnsBefore: 199 * 250,
        otherTurnsAfter: 199 * 2_500,
        millisecondsPerReadBefore: before,
        millisecondsPerReadAfter: after,
      })
    );
  }, 1_800_000);
});
