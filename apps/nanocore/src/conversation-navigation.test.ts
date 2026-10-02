import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';

/** Navigation must project current activity rather than creation order or terminal success. */
describe('conversation navigation', () => {
  it('orders working and recently replied conversations, hides private and archived Threads, and preserves unknown activity', async () => {
    const store = createDemoStore();
    store.archiveThread('ws_demo', 'th_demo');
    const older = store.createThread('ws_demo', 'Older conversation');
    const newer = store.createThread('ws_demo', 'Newer conversation');
    const working = store.createThread('ws_demo', 'Working');
    store.createThread('ws_demo', 'Private outsider', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_outsider',
    });
    const archived = store.createThread('ws_demo', 'Archived');
    store.archiveThread('ws_demo', archived.id);
    const olderTurn = store.createTurn(
      'ws_demo',
      older.id,
      'Earlier input',
      { kind: 'user', id: 'user_local' },
      null,
      { startedAt: '2026-09-15T00:00:00.000Z' }
    );
    store.updateTurn(olderTurn.id, { agentId: 'quick-chat' });
    store.createItem({
      id: 'it_late_reply',
      workspaceId: 'ws_demo',
      threadId: older.id,
      turnId: olderTurn.id,
      type: 'assistant-message',
      status: 'completed',
      actor: { kind: 'agent', id: 'assistant' },
      text: 'Later reply',
      createdAt: '2026-09-15T04:00:00.000Z',
      completedAt: '2026-09-15T04:00:00.000Z',
    });
    store.updateTurn(olderTurn.id, {
      status: 'completed',
      completedAt: '2026-09-15T01:00:00.000Z',
    });
    const newerTurn = store.createTurn(
      'ws_demo',
      newer.id,
      'Newer input',
      { kind: 'user', id: 'user_local' },
      null,
      { startedAt: '2026-09-15T02:00:00.000Z' }
    );
    store.updateTurn(newerTurn.id, { agentId: 'agent_codex_host' });
    store.updateTurn(newerTurn.id, {
      status: 'completed',
      completedAt: '2026-09-15T03:00:00.000Z',
    });
    store.createTurn('ws_demo', working.id, 'Unassigned work', { kind: 'user', id: 'user_local' });
    const app = createApp({
      store,
      agentManifests: [createTestAgentSetup().manifest],
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const response = await app.request('/api/app/workspaces/ws_demo/conversations');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items.map((row: { thread: { id: string } }) => row.thread.id)).toEqual([
      working.id,
      older.id,
      newer.id,
    ]);
    expect(result.items[0]).toMatchObject({ activity: 'unknown', state: 'working' });
    expect(result.items[2]).toMatchObject({ activity: 'task', state: 'idle' });
    expect(result.items[1]).toMatchObject({
      activity: 'chat',
      state: 'idle',
      lastActivityAt: '2026-09-15T04:00:00.000Z',
    });
  });
});
