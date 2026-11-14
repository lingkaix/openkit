import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import type { ThreadTimelineSnapshot } from './workspace-file-records.js';

const roots: string[] = [];
const time = '2026-11-12T08:00:00.000Z';
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-segments-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Plan intervals');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Work', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: time,
    completedAt: time,
  };
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  async function operation(name: string, input: object = {}) {
    const response = await app.request(`/api/app/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...selector, ...input }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return JSON.parse(text);
  }
  return {
    store,
    turn,
    base,
    plan: (
      steps: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>
    ) =>
      store.createItem({
        ...base,
        id: allocateEntityId('it'),
        type: 'plan',
        title: 'Plan',
        summary: null,
        steps,
      }),
    step: (text = 'Recorded reasoning') =>
      store.createItem({
        ...base,
        id: allocateEntityId('it'),
        type: 'reasoning',
        summary: [],
        content: [text],
      }),
    read: async () => {
      const boundary = await store.createItem({
        ...base,
        id: allocateEntityId('it'),
        type: 'assistant-message',
        text: 'Displayed',
      });
      await operation('thread.mark-read', { itemIds: [boundary.id] });
      const body = await operation('thread.timeline');
      return body.runs.find((row: { id: string }) => row.id === turn.id).planSegments;
    },
  };
}

describe('Recorded plan segment counts', () => {
  it('counts original steps between exact retained plan transitions, not equal timestamps or revisions', async () => {
    const f = await fixture();
    const plan = await f.plan([{ id: 'a', title: 'First', status: 'in_progress' }]);
    const first = await f.step();
    await f.store.updateItem(first.id, { content: ['Revised, same identity'] });
    await f.step();
    await f.store.updateItem(plan.id, {
      steps: [
        { id: 'a', title: 'First', status: 'completed' },
        { id: 'b', title: 'Second', status: 'in_progress' },
      ],
    });
    await f.step();
    await f.store.updateItem(plan.id, {
      steps: [
        { id: 'a', title: 'First', status: 'completed' },
        { id: 'b', title: 'Second', status: 'completed' },
      ],
    });
    await f.step('Outside every active plan step');
    const result = await f.read();
    expect(result).toMatchObject({
      coverage: 'complete',
      segments: [
        { planItemId: plan.id, stepId: 'a', steps: 2, endSequence: expect.any(Number) },
        { planItemId: plan.id, stepId: 'b', steps: 1, endSequence: expect.any(Number) },
      ],
    });
  });

  it('has no segments without a recorded plan', async () => {
    const f = await fixture();
    await f.step();
    expect(await f.read()).toEqual({ segments: [], coverage: 'complete' });
  });

  it('does not split an unchanged active step when its title changes', async () => {
    const f = await fixture();
    const plan = await f.plan([{ id: 'a', title: 'Original', status: 'in_progress' }]);
    await f.step();
    await f.store.updateItem(plan.id, {
      steps: [{ id: 'a', title: 'Renamed', status: 'in_progress' }],
    });
    await f.step();
    const result = await f.read();
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ stepId: 'a', steps: 2, endSequence: null });
  });

  it('bounds retained plan observations and reports partial coverage instead of inventing a total', async () => {
    const f = await fixture();
    const plan = await f.plan([{ id: 'step0', title: 'Step0', status: 'in_progress' }]);
    for (let index = 1; index < 13; index++) {
      await f.step();
      await f.store.updateItem(plan.id, {
        steps: [{ id: `step${index}`, title: `Step${index}`, status: 'in_progress' }],
      });
    }
    const result = await f.read();
    expect(result.coverage).toBe('partial');
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.segments.length).toBeLessThanOrEqual(8);
  });

  it('counts large step identities without opening their bodies', async () => {
    const f = await fixture();
    await f.plan([{ id: 'a', title: 'First', status: 'in_progress' }]);
    const step = await f.step('x'.repeat(90_000));
    /** Observes real snapshot reads on both public projection paths without replacing results. */
    const observeSnapshot = (snapshot: ThreadTimelineSnapshot) =>
      new Proxy(snapshot, {
        get(target, key, receiver) {
          if (key === 'item')
            return (id: string) => {
              expect(id, 'Segment counts must not materialize step bodies').not.toBe(step.id);
              return target.item(id);
            };
          return Reflect.get(target, key, receiver);
        },
      });
    const actual = f.store.readThreadTimelineSnapshot.bind(f.store);
    vi.spyOn(f.store, 'readThreadTimelineSnapshot').mockImplementation(
      (workspaceId, threadId, read) =>
        actual(workspaceId, threadId, (snapshot) => read(observeSnapshot(snapshot)))
    );
    const actualCooperative = f.store.readThreadTimelineSnapshotCooperative.bind(f.store);
    vi.spyOn(f.store, 'readThreadTimelineSnapshotCooperative').mockImplementation(
      (workspaceId, threadId, read, signal) =>
        actualCooperative(
          workspaceId,
          threadId,
          (snapshot) => read(observeSnapshot(snapshot)),
          signal
        )
    );
    expect((await f.read()).segments[0].steps).toBe(1);
  });
});
