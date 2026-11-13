import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// RECEIPT-SHAPE step3: reads require a nonempty selector; display and bulk writes do not change.
const root = mkdtempSync(join(tmpdir(), 'receipt-window-required-'));
const coreDb = createTestCoreDb(root);
const store = createTestStore({ dataRoot: root });
let app: ReturnType<typeof createApp>;
let workspaceId: string;
let threadId: string;
const messages: string[] = [];
let ownInput: string;

beforeAll(async () => {
  app = createApp({ coreDb, store });
  const userId = ensureLocalUser(coreDb);
  const workspace = await store.createWorkspace('Required receipt window');
  workspaceId = workspace.id;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  const thread = await store.createThread(workspaceId, 'Receipt selection');
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
  for (let index = 0; index < 4; index++) {
    const id = allocateEntityId('it');
    await store.createItem({ ...base, id, type: 'assistant-message', text: `Reply ${index}` });
    messages.push(id);
  }
  ownInput = allocateEntityId('it');
  await store.createItem({
    ...base,
    id: ownInput,
    type: 'user-message',
    actor: { kind: 'user', id: userId },
    text: 'Own input',
  });
});

afterAll(async () => {
  closeTestCoreDb(coreDb);
  await disposeTestStore(root);
});

/** Sends the public operation envelope without turning omission into an empty array. */
function request(operation: 'thread.read-state' | 'thread.mark-read', itemIds?: string[]) {
  return app.request(
    ...operationRequest(operation, {
      workspaceId,
      threadId,
      ...(itemIds === undefined ? {} : { itemIds }),
    })
  );
}

/** Checks route success before comparing the public response shape. */
async function body(operation: 'thread.read-state' | 'thread.mark-read', itemIds?: string[]) {
  const response = await request(operation, itemIds);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

describe('required receipt read window', () => {
  it('rejects an omitted read selector instead of returning whole-thread history', async () => {
    const response = await request('thread.read-state');
    expect(response.status, await response.clone().text()).toBe(400);
  });

  it('rejects an empty read selector', async () => {
    const response = await request('thread.read-state', []);
    expect(response.status, await response.clone().text()).toBe(400);
  });

  it('keeps selected ordering and real receipt union while preserving both mark response modes', async () => {
    const [first, second, third, unselected] = messages as [string, string, string, string];
    expect(await body('thread.read-state', [unselected])).toEqual({
      scope: 'window',
      readItemIds: [],
      unreadItemIds: [unselected],
    });
    expect(await body('thread.mark-read', [third, first, third])).toEqual({
      scope: 'window',
      acknowledgedItemIds: [third, first],
    });
    // A delayed display from another client must union, not replace, the native receipt.
    expect(await body('thread.mark-read', [second])).toEqual({
      scope: 'window',
      acknowledgedItemIds: [second],
    });
    expect(await body('thread.mark-read', [])).toEqual({
      scope: 'window',
      acknowledgedItemIds: [],
    });
    expect(await body('thread.read-state', [third, ownInput, second, third, first])).toEqual({
      scope: 'window',
      readItemIds: [third, second, first],
      unreadItemIds: [],
    });
    expect(await body('thread.read-state', [unselected, first, unselected])).toEqual({
      scope: 'window',
      readItemIds: [first],
      unreadItemIds: [unselected],
    });
    expect(await body('thread.mark-read')).toEqual({
      scope: 'thread',
      acknowledgedCount: 4,
    });
    expect(await body('thread.read-state', [unselected, second, first, third])).toEqual({
      scope: 'window',
      readItemIds: [unselected, second, first, third],
      unreadItemIds: [],
    });
  });
});
