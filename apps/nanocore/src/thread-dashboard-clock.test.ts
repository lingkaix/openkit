import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { disposeTestStore } from './test-support/store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Reads server clock metadata only after the ordinary Thread dashboard admission. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-clock-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Clock correction');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Read the clock', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  async function read(threadId = thread.id) {
    const response = await app.request('/api/app/operations/thread.dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, threadId }),
    });
    return { response, body: await response.json() };
  }
  return { store, turn, read };
}

it('U5 samples current server time on each admitted read without replacing recorded run clocks', async () => {
  const f = await fixture();
  const recorded = f.store.getTurnById(f.turn.id).startedAt;
  vi.useFakeTimers({ toFake: ['Date'] });
  for (const time of ['2026-11-13T12:00:00.000Z', '2026-11-13T12:01:30.000Z']) {
    vi.setSystemTime(time);
    const { response, body } = await f.read();
    expect(response.status).toBe(200);
    expect(body.serverTime).toBe(time);
    expect(body.turns[0].startedAt).toBe(recorded);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(32768);
    expect(f.store.getTurnById(f.turn.id).startedAt).toBe(recorded);
  }
});

it('does not manufacture a dashboard clock response through an unadmitted Thread', async () => {
  const f = await fixture();
  const { response, body } = await f.read(allocateEntityId('th'));
  expect(response.status).toBe(404);
  expect(body).not.toHaveProperty('serverTime');
});
