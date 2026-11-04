import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { FsStore } from './lib/store.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';

interface ReplayItem {
  id: string;
  text?: string;
}

interface ReplayPage {
  items: ReplayItem[];
  nextCursor: string | null;
}

interface ReplayResult {
  status: number;
  text: string;
  page: ReplayPage | null;
}

/** Reads one durable Thread page through the public App operation over real HTTP JSON. */
async function requestThreadItems(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>
): Promise<ReplayResult> {
  const response = await app.request('/api/app/operations/thread.items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, page: parseReplayPage(text) };
}

/** Keeps the test oracle on the public response shape without importing a private projection. */
function parseReplayPage(text: string): ReplayPage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const nextCursor =
    record.nextCursor === null
      ? null
      : typeof record.nextCursor === 'string'
        ? record.nextCursor
        : undefined;
  if (nextCursor === undefined) return null;
  if (!Array.isArray(record.items)) return null;
  const items: ReplayItem[] = [];
  for (const raw of record.items) {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string') return null;
    items.push({ id: item.id, ...(typeof item.text === 'string' ? { text: item.text } : {}) });
  }
  return { items, nextCursor };
}

/** Creates retained Items through the actual Thread, Turn and Item owners. */
async function createThreadWithItems(
  store: FsStore,
  workspaceId: string,
  name: string,
  count: number,
  audience?: { visibility: 'private'; privateOwnerUserId: string }
) {
  const thread = await store.createThread(workspaceId, name, undefined, 'conversation', audience);
  const turn = await store.createTurn(workspaceId, thread.id, name, {
    kind: 'user',
    id: audience?.privateOwnerUserId ?? FIXTURE_LOCAL_USER_ID,
  });
  const items: Item[] = [];
  for (let index = 0; index < count; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 4, 6, 0, 0, index)).toISOString();
    if (index % 2 === 0) {
      items.push(
        await store.createItem({
          id: allocateEntityId('it'),
          owner: { kind: 'workspace', workspaceId },
          threadId: thread.id,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          actor: turn.triggerActor,
          text: `${name} item ${index}`,
          createdAt: timestamp,
          completedAt: timestamp,
        })
      );
    } else {
      items.push(
        await store.createItem({
          id: allocateEntityId('it'),
          owner: { kind: 'workspace', workspaceId },
          threadId: thread.id,
          turnId: turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: `${name} item ${index}`,
          createdAt: timestamp,
          completedAt: timestamp,
        })
      );
    }
  }
  return { thread, items };
}

function expectPage(result: ReplayResult): ReplayPage {
  expect(result.status).toBe(200);
  expect(result.page).not.toBeNull();
  return result.page!;
}

async function withFixture(
  run: (context: {
    store: FsStore;
    app: ReturnType<typeof createApp>;
    workspaceId: string;
  }) => Promise<void>
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'thread-items-pagination-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = await createDemoStore({ dataRoot });
  const app = createApp({ store });
  await run({ store, app, workspaceId: DEMO_WORKSPACE_ID });
}

describe('thread.items pagination', () => {
  it('honors the exact limit and returns a real continuation when more Items exist', async () => {
    await withFixture(async ({ store, app, workspaceId }) => {
      const { thread } = await createThreadWithItems(store, workspaceId, 'Limited thread', 5);
      const baseline = store.listThreadItems(workspaceId, thread.id).map((item) => item.id);
      expect(baseline).toHaveLength(5);

      const result = await requestThreadItems(app, {
        workspaceId,
        threadId: thread.id,
        limit: 2,
      });
      const page = expectPage(result);

      expect(page.items.map((item) => item.id)).toEqual(baseline.slice(0, 2));
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(page.nextCursor).not.toBe('');
    });
  });

  it('consumes the complete durable log by cursor without duplicates or holes', async () => {
    await withFixture(async ({ store, app, workspaceId }) => {
      const { thread } = await createThreadWithItems(store, workspaceId, 'Paged thread', 5);
      const baseline = store.listThreadItems(workspaceId, thread.id).map((item) => item.id);
      expect(baseline).toHaveLength(5);

      const consumed: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const result = await requestThreadItems(app, {
          workspaceId,
          threadId: thread.id,
          limit: 2,
          ...(cursor === null ? {} : { cursor }),
        });
        const page = expectPage(result);
        consumed.push(...page.items.map((item) => item.id));
        pages += 1;
        if (pages === 1) expect(page.nextCursor).not.toBeNull();
        if (page.nextCursor === null) break;
        expect(page.nextCursor).not.toBe('');
        expect(page.items).toHaveLength(2);
        cursor = page.nextCursor;
        if (pages > 10) throw new Error('Thread Item pagination did not terminate.');
      }

      expect(pages).toBe(3);
      expect(consumed).toEqual(baseline);
      expect(new Set(consumed).size).toBe(baseline.length);
    });
  });

  it('returns the complete terminal page and an empty page', async () => {
    await withFixture(async ({ store, app, workspaceId }) => {
      const { thread } = await createThreadWithItems(store, workspaceId, 'Terminal thread', 5);
      const baseline = store.listThreadItems(workspaceId, thread.id).map((item) => item.id);

      const terminal = expectPage(
        await requestThreadItems(app, { workspaceId, threadId: thread.id, limit: 10 })
      );
      expect(terminal.items.map((item) => item.id)).toEqual(baseline);
      expect(terminal.nextCursor).toBeNull();

      const empty = await store.createThread(workspaceId, 'Empty thread');
      const emptyPage = expectPage(
        await requestThreadItems(app, { workspaceId, threadId: empty.id, limit: 10 })
      );
      expect(emptyPage.items).toEqual([]);
      expect(emptyPage.nextCursor).toBeNull();
    });
  });

  it('does not disclose another Thread through a cross-Thread cursor', async () => {
    await withFixture(async ({ store, app, workspaceId }) => {
      const first = await createThreadWithItems(store, workspaceId, 'First thread', 3);
      const second = await createThreadWithItems(store, workspaceId, 'Second thread', 3);
      const firstIds = new Set(first.items.map((item) => item.id));
      const secondIds = new Set(second.items.map((item) => item.id));

      const firstPage = expectPage(
        await requestThreadItems(app, { workspaceId, threadId: first.thread.id, limit: 1 })
      );
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();
      const cursor = firstPage.nextCursor!;

      const crossing = await requestThreadItems(app, {
        workspaceId,
        threadId: second.thread.id,
        cursor,
        limit: 2,
      });

      if (crossing.status === 200) {
        const page = expectPage(crossing);
        expect(page.items).toHaveLength(2);
        for (const item of page.items) {
          expect(firstIds.has(item.id)).toBe(false);
          expect(secondIds.has(item.id)).toBe(true);
        }
      } else {
        expect(crossing.status).toBeGreaterThanOrEqual(400);
        expect(crossing.status).toBeLessThan(500);
        for (const id of firstIds) expect(crossing.text).not.toContain(id);
      }
    });
  });

  it('keeps the addressed-Thread Workspace refusal bound without disclosing Items', async () => {
    await withFixture(async ({ store, app, workspaceId }) => {
      const { thread, items } = await createThreadWithItems(store, workspaceId, 'Scoped thread', 1);
      const item = items[0]!;
      const otherWorkspace = store
        .listWorkspaces()
        .find((workspace) => workspace.id !== workspaceId);
      expect(otherWorkspace).toBeDefined();

      const result = await requestThreadItems(app, {
        workspaceId: otherWorkspace!.id,
        threadId: thread.id,
      });

      expect(result.status).toBe(404);
      expect(result.page).toBeNull();
      expect(result.text).not.toContain(item.id);
      expect(result.text).not.toContain('Scoped thread item 0');
    });
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
