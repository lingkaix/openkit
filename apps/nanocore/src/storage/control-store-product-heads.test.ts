// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId, ItemSchema, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestStore } from '../test-support/store.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { prepareImmutableProductJson, readImmutableProductJson } from './immutable-content.js';
import { nativeProductScope, readNativeProductEntries } from './workspace-file-records.js';

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Establishes real acknowledged Store records before any retained-byte fault. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-product-head-semantics-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Retained Item semantics');
  const thread = await store.createThread(workspace.id, 'Addressed publication');
  const turn = await store.createTurn(workspace.id, thread.id, 'Input', actor);
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: 'Acknowledged original',
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  await expect(store.createItem(item)).resolves.toEqual(item);
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  return { root, store, workspace, thread, turn, item, scope };
}

/** Reads the committed descriptor cut even when unsupported body semantics refuse product history. */
function committedCut(f: Awaited<ReturnType<typeof fixture>>) {
  const reader = openControlStoreProductReadHandle(f.scope.path, f.scope.owner);
  try {
    return {
      turn: reader.get('turn', f.turn.id)!,
      items: reader.entries(f.turn.id, 'item', 0),
      events: reader.entries(f.turn.id, 'event', 0),
    };
  } finally {
    reader.close();
  }
}

/** Publishes exact retained fault bytes through real immutable preparation and native SQL ownership. */
async function appendRetainedItem(
  f: Awaited<ReturnType<typeof fixture>>,
  value: Record<string, unknown>
) {
  const before = committedCut(f);
  const previous = before.items.filter((entry) => entry.id === f.item.id).at(-1)!;
  const prepared = await prepareImmutableProductJson(
    f.scope.contentMount,
    f.scope.owner,
    join(dirname(dirname(f.scope.path)), 'runtime', 'staging'),
    value
  );
  await expect(
    getControlStoreWorkerClient().products(`workspace:${f.scope.path}`, {
      products: [
        { kind: 'turn', expectedRevision: before.turn.revision, record: before.turn.record },
      ],
      entries: [
        {
          kind: 'item',
          turnId: f.turn.id,
          sequence: before.items.at(-1)!.sequence + 1,
          expectedRevision: previous.revision,
          ...prepared,
        },
      ],
    })
  ).resolves.toBeUndefined();
  expect(readImmutableProductJson(f.scope.contentMount, f.scope.owner, prepared.content)).toEqual(
    value
  );
}

/** Uses the public addressed event publisher with the same validated Item as its positive control. */
function publishEvent(f: Awaited<ReturnType<typeof fixture>>, item: typeof f.item) {
  return f.store.persistTurnEvent(f.turn.id, {
    event: 'item.completed',
    workspaceId: f.workspace.id,
    threadId: f.thread.id,
    turnId: f.turn.id,
    requestId: null,
    data: { type: 'item-completed', itemId: item.id, item },
  });
}

describe('addressed retained Item required semantics', () => {
  it.each([
    ['Item revision', ['future-item-authority-v1']],
    ['Item revision', 'future-item-authority-v1'],
    ['addressed event', ['future-item-authority-v1']],
    ['addressed event', 'future-item-authority-v1'],
  ] as const)('refuses %s for requiredFeatures=%j before acknowledging another reference', async (operation, requiredFeatures) => {
    const f = await fixture();
    // Contract Evolution: descriptive additions and an empty required-feature list remain readable.
    const descriptive = {
      ...writeRetainedV1(f.item),
      operatorNote: { purpose: 'descriptive only' },
      requiredFeatures: [],
    };
    await appendRetainedItem(f, descriptive);
    expect(readNativeProductEntries(f.scope, f.turn.id, 'item').at(-1)!.value).toEqual(descriptive);
    const candidate = { ...f.item, text: 'Descriptive revision acknowledged' };
    await expect(f.store.createItem(candidate)).resolves.toEqual({
      ...candidate,
      operatorNote: descriptive.operatorNote,
      requiredFeatures: [],
    });
    await expect(publishEvent(f, candidate)).resolves.toMatchObject({
      event: 'item.completed',
      data: { itemId: candidate.id },
    });

    // Fault injection starts only after both public publication controls have acknowledged success.
    await appendRetainedItem(f, { ...writeRetainedV1(candidate), requiredFeatures });
    const before = committedCut(f);
    // The established complete-history reader supplies an independent refusal control.
    expect(() => readNativeProductEntries(f.scope, f.turn.id, 'item')).toThrow();

    const attempt =
      operation === 'Item revision'
        ? f.store.createItem({ ...candidate, text: 'Must not be acknowledged' })
        : publishEvent(f, candidate);
    const [outcome] = await Promise.allSettled([attempt]);
    // Contract Evolution, Closed Core, Open Extension: unsupported required semantics fail closed.
    expect.soft(outcome!.status).toBe('rejected');
    // Durable Execution, Commit Rule: refusal creates no Item/event reference or Turn revision.
    expect(committedCut(f)).toEqual(before);
  });
});
