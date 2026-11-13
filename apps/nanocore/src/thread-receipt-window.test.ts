import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OperationError } from './operation-error.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  disposeTestStore,
} from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

// RECEIPT-SHAPE step1 operation contract: public routes, real producer and native FULL ACK.
// Gray-box observations call originals; only deliberate authority/source faults are injected.
const root = mkdtempSync(join(tmpdir(), 'receipt-window-'));
const coreDb = createTestCoreDb(root);
const userId = ensureLocalUser(coreDb);
const store = createTestStore({ dataRoot: root });
const app = createApp({ coreDb, store });
const eligible: string[] = [];
const excluded: string[] = [];
let workspaceId: string;
let threadId: string;
let foreignId: string;
let appendHistory: (count: number) => Promise<void>;

beforeAll(async () => {
  const workspace = await store.createWorkspace('Receipt window');
  workspaceId = workspace.id;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  const thread = await store.createThread(workspaceId, 'Selected messages');
  threadId = thread.id;
  const turn = await store.createTurn(workspaceId, threadId, 'Prompt', {
    kind: 'user',
    id: userId,
  });
  const base = {
    owner: turn.owner,
    threadId,
    turnId: turn.id,
    createdAt: '2026-11-14T00:00:00.000Z',
    completedAt: '2026-11-14T00:00:00.000Z',
    status: 'completed' as const,
  };
  appendHistory = async (count) => {
    for (let index = 0; index < count; index++) {
      const id = allocateEntityId('it');
      await store.createItem({ ...base, id, type: 'assistant-message', text: 'Reply '.repeat(40) });
      eligible.push(id);
    }
  };
  await appendHistory(220);
  for (const variant of ['own', 'empty', 'streaming'] as const) {
    const id = allocateEntityId('it');
    excluded.push(id);
    if (variant === 'own') {
      await store.createItem({
        ...base,
        id,
        type: 'user-message',
        actor: { kind: 'user', id: userId },
        text: 'Own input',
      });
    } else {
      await store.createItem({
        ...base,
        id,
        type: 'assistant-message',
        text: variant === 'empty' ? ' ' : 'Writing',
        ...(variant === 'streaming' ? { status: 'in_progress' as const, completedAt: null } : {}),
      });
    }
  }
  const other = await store.createThread(workspaceId, 'Other Thread');
  const otherTurn = await store.createTurn(workspaceId, other.id, 'Other prompt', {
    kind: 'user',
    id: userId,
  });
  foreignId = allocateEntityId('it');
  await store.createItem({
    ...base,
    id: foreignId,
    threadId: other.id,
    turnId: otherTurn.id,
    type: 'assistant-message',
    text: 'Other reply',
  });
}, 120_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  closeTestCoreDb(coreDb);
  await disposeTestStore(root);
});

/** Uses the same public operation envelope as shipped clients, including empty selections. */
function request(operation: 'thread.read-state' | 'thread.mark-read', itemIds?: string[]) {
  return app.request(
    ...operationRequest(operation, {
      workspaceId,
      threadId,
      ...(itemIds === undefined ? {} : { itemIds }),
    })
  );
}
async function body(operation: 'thread.read-state' | 'thread.mark-read', itemIds?: string[]) {
  const response = await request(operation, itemIds);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function full() {
  return body('thread.read-state');
}
/** The original full read is the eligibility/membership oracle, not a copied predicate. */
function restricted(
  state: { readItemIds: string[]; unreadItemIds: string[] },
  selection: string[]
) {
  const unique = [...new Set(selection)];
  return {
    scope: 'window',
    readItemIds: unique.filter((id) => state.readItemIds.includes(id)),
    unreadItemIds: unique.filter((id) => state.unreadItemIds.includes(id)),
  };
}
function observeHistory() {
  // Spies retain the real implementations and their bodies/results.
  return [vi.spyOn(store, 'listThreadTurnsSteps'), vi.spyOn(store, 'listThreadItems')];
}

/** Arms only after User initialization, so the later native OPEN is the publication cut. */
function atPublication(action: () => Promise<void>) {
  const client = getControlStoreWorkerClient();
  const initialized = client.openInitializedUserReadDb.bind(client);
  const open = client.open.bind(client);
  let reached = false;
  vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
    const db = await initialized(...args);
    const spy = vi.spyOn(client, 'open').mockImplementation(async (...opening) => {
      const result = await open(...opening);
      spy.mockRestore();
      reached = true;
      await action();
      return result;
    });
    return db;
  });
  return () => reached;
}

describe('bounded receipt public operation contract', () => {
  it('accepts a window and exactly matches legacy membership and eligibility in request order', async () => {
    await body('thread.mark-read', [eligible[0]!, eligible[2]!]);
    const legacy = await full();
    expect(legacy.unreadItemIds.length).toBeGreaterThan(200);
    const selection = [
      eligible[2]!,
      excluded[0]!,
      eligible[1]!,
      eligible[0]!,
      excluded[1]!,
      excluded[2]!,
      eligible[2]!,
    ];
    const scans = observeHistory();
    expect(await body('thread.read-state', selection)).toEqual(restricted(legacy, selection));
    for (const scan of scans) expect(scan).not.toHaveBeenCalled();
  });

  it('validates only selected canonical identities on both sides of native User opening', async () => {
    const selection = [eligible[40]!, excluded[0]!, eligible[41]!];
    const legacy = await full();
    const lookup = vi.spyOn(store, 'getThreadItem');
    const client = getControlStoreWorkerClient();
    const open = client.openInitializedUserReadDb.bind(client);
    let beforeOpening: string[] = [];
    let openingCalls = 0;
    vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
      beforeOpening = lookup.mock.calls.map((call) => call[2]);
      openingCalls = lookup.mock.calls.length;
      return open(...args);
    });
    expect(await body('thread.read-state', selection)).toEqual(restricted(legacy, selection));
    expect(beforeOpening).toEqual(expect.arrayContaining(selection));
    const afterOpening = lookup.mock.calls.slice(openingCalls).map((call) => call[2]);
    expect(afterOpening).toEqual(expect.arrayContaining(selection));
    expect(lookup.mock.calls.every((call) => selection.includes(call[2]))).toBe(true);
  });

  it('keeps selected body bytes identical after unrelated history doubles, with zero full-body traversals', async () => {
    const selection = eligible.slice(20, 220).reverse();
    const before = await full();
    const firstScans = observeHistory();
    const firstResponse = await request('thread.read-state', selection);
    const firstBytes = await firstResponse.text();
    expect(firstResponse.status, firstBytes).toBe(200);
    const first = JSON.parse(firstBytes);
    for (const scan of firstScans) expect(scan).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await appendHistory(220);
    const after = await full();
    expect(after.readItemIds.length + after.unreadItemIds.length).toBe(440);
    expect(after.unreadItemIds.length).toBeGreaterThan(before.unreadItemIds.length);
    const secondScans = observeHistory();
    const secondResponse = await request('thread.read-state', selection);
    const secondBytes = await secondResponse.text();
    expect(secondResponse.status, secondBytes).toBe(200);
    const second = JSON.parse(secondBytes);
    expect(second).toEqual(restricted(after, selection));
    expect(second).toEqual(first);
    expect(Buffer.byteLength(secondBytes)).toBe(Buffer.byteLength(firstBytes));
    expect(Buffer.byteLength(secondBytes)).toBeLessThan(16 * 1024);
    for (const scan of secondScans) expect(scan).not.toHaveBeenCalled();
  }, 120_000);

  it('accepts an empty read window, deduplicates first occurrence, and enforces the 200 input bound', async () => {
    expect(await body('thread.read-state', [])).toEqual({
      scope: 'window',
      readItemIds: [],
      unreadItemIds: [],
    });
    const selection = [eligible[8]!, eligible[6]!, eligible[8]!, eligible[7]!];
    expect(await body('thread.read-state', selection)).toEqual(restricted(await full(), selection));
    expect((await request('thread.read-state', eligible.slice(0, 200))).status).toBe(200);
    expect((await request('thread.read-state', Array(201).fill(eligible[0]!))).status).toBe(400);
    expect((await request('thread.mark-read', Array(201).fill(eligible[0]!))).status).toBe(400);
  });

  it('refuses missing and foreign selections without changing the real retained union', async () => {
    const before = await full();
    for (const invalid of [allocateEntityId('it'), foreignId]) {
      expect((await request('thread.read-state', [eligible[5]!, invalid])).status).toBe(400);
      expect((await request('thread.mark-read', [eligible[5]!, invalid])).status).toBe(400);
    }
    expect((await request('thread.mark-read', [eligible[5]!, excluded[0]!])).status).toBe(400);
    expect(await full()).toEqual(before);
  });

  it('returns a bounded deduplicated display ACK, preserving native union across delayed devices', async () => {
    const first = [eligible[12]!, eligible[10]!, eligible[12]!];
    const scans = observeHistory();
    expect(await body('thread.mark-read', first)).toEqual({
      scope: 'window',
      acknowledgedItemIds: [eligible[12], eligible[10]],
    });
    for (const scan of scans) expect(scan).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await body('thread.mark-read', [eligible[11]!])).toEqual({
      scope: 'window',
      acknowledgedItemIds: [eligible[11]],
    });
    expect(await body('thread.mark-read', first)).toEqual({
      scope: 'window',
      acknowledgedItemIds: [eligible[12], eligible[10]],
    });
    const state = await full();
    expect(state.readItemIds).toEqual(
      expect.arrayContaining([eligible[10], eligible[11], eligible[12]])
    );
    expect(state.unreadItemIds).not.toContain(eligible[10]);
  });

  it('empty marking neither publishes membership nor traverses history', async () => {
    const before = await full();
    const membership = vi.spyOn(getControlStoreWorkerClient(), 'threadReadMembership');
    const scans = observeHistory();
    expect(await body('thread.mark-read', [])).toEqual({
      scope: 'window',
      acknowledgedItemIds: [],
    });
    expect(membership).not.toHaveBeenCalled();
    for (const scan of scans) expect(scan).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await full()).toEqual(before);
  });

  it('filters a selected message that loses eligibility during real native read opening', async () => {
    const target = eligible[30]!;
    const client = getControlStoreWorkerClient();
    const open = client.openInitializedUserReadDb.bind(client);
    let reached = false;
    vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
      const db = await open(...args);
      await store.updateItem(target, { text: ' ' });
      reached = true;
      return db;
    });
    try {
      expect(await body('thread.read-state', [target, eligible[31]!])).toEqual({
        scope: 'window',
        readItemIds: [],
        unreadItemIds: [eligible[31]],
      });
      expect(reached).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await store.updateItem(target, { text: 'Restored reply' });
    }
  });

  it('refuses the whole display union when one target loses eligibility at publication OPEN', async () => {
    const before = await full();
    const target = eligible[32]!;
    const reached = atPublication(async () => {
      await store.updateItem(target, { text: ' ' });
    });
    try {
      expect((await request('thread.mark-read', [eligible[33]!, target])).status).toBe(400);
      expect(reached()).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await store.updateItem(target, { text: 'Restored reply' });
    }
    expect(await full()).toEqual(before);
  });

  for (const operation of ['thread.read-state', 'thread.mark-read'] as const) {
    it(`rechecks current Thread admission after native opening for ${operation}`, async () => {
      const before = await full();
      const client = getControlStoreWorkerClient();
      const open = client.openInitializedUserReadDb.bind(client);
      const getThread = store.getThread.bind(store);
      let revoked = false;
      let refused = false;
      // Inject a current source-authority refusal, after valid producer setup. Never fake a native ACK.
      vi.spyOn(store, 'getThread').mockImplementation((...args) => {
        const result = getThread(...args);
        if (revoked && args[0] === workspaceId && args[1] === threadId) {
          refused = true;
          throw new OperationError('forbidden', 'Admission revoked by test fault.', 403);
        }
        return result;
      });
      vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
        const db = await open(...args);
        revoked = true;
        return db;
      });
      // Current admission may hide an inaccessible Thread as not found.
      expect([403, 404]).toContain((await request(operation, [eligible[34]!])).status);
      expect(refused).toBe(true);
      vi.restoreAllMocks();
      expect(await full()).toEqual(before);
    });
  }

  it('rechecks current admission at final native publication OPEN with no partial union', async () => {
    const before = await full();
    const getThread = store.getThread.bind(store);
    let revoked = false;
    let refused = false;
    vi.spyOn(store, 'getThread').mockImplementation((...args) => {
      const result = getThread(...args);
      if (revoked && args[0] === workspaceId && args[1] === threadId) {
        refused = true;
        throw new OperationError('forbidden', 'Admission revoked by test fault.', 403);
      }
      return result;
    });
    const reached = atPublication(async () => {
      revoked = true;
    });
    expect([403, 404]).toContain(
      (await request('thread.mark-read', [eligible[35]!, eligible[36]!])).status
    );
    expect(reached()).toBe(true);
    expect(refused).toBe(true);
    vi.restoreAllMocks();
    expect(await full()).toEqual(before);
  });

  it('acknowledges the full 200-identity display boundary without returning unrelated history', async () => {
    const selection = eligible.slice(0, 200).reverse();
    const ack = await body('thread.mark-read', selection);
    expect(ack).toEqual({ scope: 'window', acknowledgedItemIds: selection });
    expect(Buffer.byteLength(JSON.stringify(ack))).toBeLessThan(16 * 1024);
    const state = await full();
    expect(state.readItemIds).toEqual(expect.arrayContaining(selection));
  });

  it('bulk marking returns a count of all selected identities, including previously recorded ones', async () => {
    const before = await full();
    expect(before.readItemIds.length).toBeGreaterThan(0);
    const count = before.readItemIds.length + before.unreadItemIds.length;
    const ack = await body('thread.mark-read');
    expect(ack).toEqual({ scope: 'thread', acknowledgedCount: count });
    expect(Buffer.byteLength(JSON.stringify(ack))).toBeLessThan(100);
    const after = await full();
    expect(after).toEqual({
      scope: 'thread',
      readItemIds: [...before.readItemIds, ...before.unreadItemIds].sort(
        (a, b) => eligible.indexOf(a) - eligible.indexOf(b)
      ),
      unreadItemIds: [],
    });
    expect(await body('thread.mark-read')).toEqual({ scope: 'thread', acknowledgedCount: count });
  }, 120_000);
});
