// Builds a retained Thread through public FsStore producers for the Earlier-page callers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { createAppWithWorkspaceAuthority } from './app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './local-user.js';

/** Retained run headers on the fixture Thread, including the run that owns the Items. */
export const EARLIER_PAGE_HEADERS = 80;
/** Protocol Items written to the newest run. */
export const EARLIER_PAGE_ITEMS = 150;

export interface EarlierPageCorpus {
  app: ReturnType<typeof createAppWithWorkspaceAuthority>;
  store: Awaited<ReturnType<typeof createDemoStore>>;
  workspaceId: string;
  threadId: string;
  /** Every Item id in chronological order. */
  itemIds: string[];
  /** Every run id in admission order, oldest first; the last entry owns the Items. */
  headerIds: string[];
  root: string;
}

/**
 * Persists the fixture Thread with its retained headers and Items. Only public Store producers are
 * used: every header is an owner-created completed Turn and every Item is an owner-created message.
 */
export async function createEarlierPageCorpus(): Promise<EarlierPageCorpus> {
  const root = mkdtempSync(join(tmpdir(), 'timeline-earlier-'));
  const store = await createDemoStore({ dataRoot: root });
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Earlier pager fixture');
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const headerIds: string[] = [];
  for (let index = 0; index < EARLIER_PAGE_HEADERS - 1; index++) {
    const retained = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, `Header ${index}`, actor);
    await store.completeTurn(retained.id, {
      status: 'completed',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    headerIds.push(retained.id);
  }
  const run = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Item owner', actor);
  headerIds.push(run.id);
  const itemIds: string[] = [];
  for (let sequence = 1; sequence <= EARLIER_PAGE_ITEMS; sequence++) {
    const id = allocateEntityId('it');
    await store.createItem({
      id,
      owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
      threadId: thread.id,
      turnId: run.id,
      type: 'assistant-message',
      status: 'completed',
      text: `Earlier pager message ${sequence}`,
      createdAt: '2026-11-08T17:00:00.000Z',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    itemIds.push(id);
  }
  return {
    app,
    store,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    itemIds,
    headerIds,
    root,
  };
}
