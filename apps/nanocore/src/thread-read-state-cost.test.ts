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
import { markThreadRead, readThreadReadState } from './thread-read-state.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

// Dispatch acceptance: at most one complete history body traversal per receipt request.
// Exact identities and refusal semantics: User-owned Read Receipts in
// docs/specs/20260628-web_product_surface_projection.md.
const root = mkdtempSync(join(tmpdir(), 'receipt-cost-'));
const coreDb = createTestCoreDb(root);
const userId = ensureLocalUser(coreDb);
const store = createTestStore({ dataRoot: root });
let app: ReturnType<typeof createApp>;
const eligible: string[] = [];
let workspaceId: string;
let threadId: string;

beforeAll(async () => {
  app = createApp({ store, coreDb });
  const workspace = await store.createWorkspace('Receipt cost');
  workspaceId = workspace.id;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  const thread = await store.createThread(workspaceId, 'Receipt cost');
  threadId = thread.id;
  const turn = await store.createTurn(workspaceId, threadId, 'Prompt', {
    kind: 'user',
    id: userId,
  });
  const base = {
    owner: turn.owner,
    threadId,
    turnId: turn.id,
    createdAt: '2026-11-08T17:00:00.000Z',
    completedAt: '2026-11-08T17:00:00.000Z',
    status: 'completed' as const,
  };
  for (let index = 0; index < 12; index++) {
    const id = allocateEntityId('it');
    await store.createItem({ ...base, id, type: 'assistant-message', text: `Reply ${index}` });
    eligible.push(id);
  }
  await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'user-message',
    actor: { kind: 'user', id: userId },
    text: 'Own prompt',
  });
  await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'assistant-message',
    text: '  ',
  });
  await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'assistant-message',
    status: 'in_progress',
    completedAt: null,
    text: 'Streaming',
  });
}, 120_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  closeTestCoreDb(coreDb);
  await disposeTestStore(root);
});

const owner = () => ({ store, coreDb, userId, workspaceId, threadId, itemIds: eligible });
async function request(id: 'thread.read-state' | 'thread.mark-read', itemIds?: string[]) {
  const response = await app.request(
    ...operationRequest(id, { workspaceId, threadId, ...(itemIds ? { itemIds } : {}) })
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
function observeFullTraversals() {
  const original = store.listThreadTurnsSteps.bind(store);
  let completed = 0;
  vi.spyOn(store, 'listThreadTurnsSteps').mockImplementation(function* (...args) {
    const result = yield* original(...args);
    completed++;
    return result;
  });
  return () => completed;
}

describe('receipt cost and current-source preservation', () => {
  it('reads exact eligible identities with at most one complete history traversal', async () => {
    const traversals = observeFullTraversals();
    expect(await request('thread.read-state', eligible)).toEqual({
      scope: 'window',
      readItemIds: [],
      unreadItemIds: eligible,
    });
    expect(
      traversals(),
      'receipt GET repeated the complete canonical body traversal'
    ).toBeLessThanOrEqual(1);
  });

  it('marks one displayed identity with at most one complete history traversal', async () => {
    const traversals = observeFullTraversals();
    expect(await request('thread.mark-read', [eligible[0]!])).toEqual({
      scope: 'window',
      acknowledgedItemIds: [eligible[0]],
    });
    expect(
      traversals(),
      'selected receipt validation repeated the complete canonical body traversal'
    ).toBeLessThanOrEqual(1);
    // The bounded acknowledgement does not return the union; verify it through its read owner.
    expect(await request('thread.read-state', eligible)).toEqual({
      scope: 'window',
      readItemIds: [eligible[0]],
      unreadItemIds: eligible.slice(1),
    });
  });

  it('does not publish a selected target that becomes empty during native opening', async () => {
    const client = getControlStoreWorkerClient();
    const original = client.openInitializedUserReadDb.bind(client);
    const target = eligible[1]!;
    vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
      const db = await original(...args);
      await store.updateItem(target, { text: ' ' });
      return db;
    });
    try {
      await expect(markThreadRead({ ...owner(), itemIds: [target] })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    } finally {
      vi.restoreAllMocks();
      await store.updateItem(target, { text: 'Restored reply' });
    }
    const state = await readThreadReadState(owner());
    expect(state.readItemIds).not.toContain(target);
    expect(new Set([...state.readItemIds, ...state.unreadItemIds])).toEqual(new Set(eligible));
  });

  it('projects current eligibility after an awaited native open', async () => {
    const client = getControlStoreWorkerClient();
    const original = client.openInitializedUserReadDb.bind(client);
    const target = eligible[2]!;
    vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
      const db = await original(...args);
      await store.updateItem(target, { text: ' ' });
      return db;
    });
    try {
      const state = await readThreadReadState(owner());
      expect(new Set([...state.readItemIds, ...state.unreadItemIds])).toEqual(
        new Set(eligible.filter((id) => id !== target))
      );
    } finally {
      vi.restoreAllMocks();
      await store.updateItem(target, { text: 'Restored reply' });
    }
  });

  it('rechecks admission at the last awaited native opening before publication', async () => {
    const client = getControlStoreWorkerClient();
    const initialized = client.openInitializedUserReadDb.bind(client);
    const original = client.open.bind(client);
    let revoked = false;
    vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
      const db = await initialized(...args);
      // Arm only after initialization: a warm User may not need an initial OPEN.
      vi.spyOn(client, 'open').mockImplementation(async (...openArgs) => {
        const result = await original(...openArgs);
        revoked = true;
        return result;
      });
      return db;
    });
    const target = eligible[3]!;
    await expect(
      markThreadRead({
        ...owner(),
        itemIds: [target],
        recheckAdmission: async () => {
          if (revoked) throw new OperationError('forbidden', 'Admission revoked.', 403);
        },
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(revoked, 'fault must occur at the native publication opening').toBe(true);
    vi.restoreAllMocks();
    expect((await readThreadReadState(owner())).readItemIds).not.toContain(target);
  });

  it('rejects a target that loses eligibility at the publication opening', async () => {
    const client = getControlStoreWorkerClient();
    const initialized = client.openInitializedUserReadDb.bind(client);
    const original = client.open.bind(client);
    const target = eligible[4]!;
    let changed = false;
    vi.spyOn(client, 'openInitializedUserReadDb').mockImplementation(async (...args) => {
      const db = await initialized(...args);
      const opening = vi.spyOn(client, 'open').mockImplementation(async (...openArgs) => {
        const result = await original(...openArgs);
        opening.mockRestore();
        await store.updateItem(target, { text: ' ' });
        changed = true;
        return result;
      });
      return db;
    });
    try {
      await expect(markThreadRead({ ...owner(), itemIds: [target] })).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect(changed, 'fault must occur before publication').toBe(true);
    } finally {
      vi.restoreAllMocks();
      await store.updateItem(target, { text: 'Restored reply' });
    }
    expect((await readThreadReadState(owner())).readItemIds).not.toContain(target);
  });
});
