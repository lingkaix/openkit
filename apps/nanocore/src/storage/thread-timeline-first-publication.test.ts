import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { projectTimelineItem } from '../thread-timeline.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Publishes all canonical facts before app admission hooks are installed. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-first-publication-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Exact intervals');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Work', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: '2026-11-12T08:00:00.000Z',
    completedAt: '2026-11-12T08:00:00.000Z',
  };
  const step = (text: string) =>
    store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'reasoning',
      summary: [],
      content: [text],
    });
  const outsideBefore = await step('Before any active step');
  const plan = await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'plan',
    title: 'Plan',
    summary: null,
    steps: [{ id: 'a', title: 'First', status: 'in_progress' }],
  });
  const first = await step('First publication in A');
  const large = await step('x'.repeat(20_000));
  await store.updateItem(plan.id, {
    steps: [
      { id: 'a', title: 'First', status: 'completed' },
      { id: 'b', title: 'Second', status: 'in_progress' },
    ],
  });
  const second = await step('First publication in B');
  await store.updateItem(first.id, { content: ['Revised after B began'] });
  await store.updateItem(plan.id, {
    steps: [
      { id: 'a', title: 'First', status: 'completed' },
      { id: 'b', title: 'Second', status: 'completed' },
    ],
  });
  const outsideAfter = await step('After all active steps');
  const boundary = await store.createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'assistant-message',
    text: 'Read boundary',
  });
  const positions = await store.readThreadTimelineSnapshot(
    DEMO_WORKSPACE_ID,
    thread.id,
    (snapshot) =>
      Object.fromEntries(
        [outsideBefore, first, large, second, outsideAfter].map((item) => {
          const position = snapshot.position(item.id);
          expect(position?.turnId).toBe(turn.id);
          expect(Number.isSafeInteger(position?.sequence)).toBe(true);
          return [item.id, position!.sequence];
        })
      )
  );
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
  await operation('thread.mark-read', { itemIds: [boundary.id] });
  return {
    store,
    selector,
    turn,
    first,
    large,
    second,
    outsideBefore,
    outsideAfter,
    positions,
    operation,
  };
}

describe('Exact Item first-publication positions', () => {
  it('selects exact step members by native plan append intervals, including previews', async () => {
    const f = await fixture();
    const timeline = await f.operation('thread.timeline');
    const run = timeline.runs.find((row: { id: string }) => row.id === f.turn.id);
    expect(run.planSegments.coverage).toBe('complete');
    const response = await f.operation('thread.timeline', {
      view: 'items',
      turnId: f.turn.id,
      placement: 'step',
    });
    expect(response.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [f.outsideBefore.id, f.first.id, f.large.id, f.second.id, f.outsideAfter.id].sort()
    );
    expect(response.items.find((item: { id: string }) => item.id === f.large.id).detail.kind).toBe(
      'preview'
    );
    for (const item of response.items) {
      expect(item.firstPublicationSequence).toBe(f.positions[item.id]);
      expect(item.firstPublicationSequence).toBeGreaterThan(0);
    }
    // Membership is an exact ID set, never a count or a display-order inference.
    for (const [stepId, ids] of [
      ['a', [f.first.id, f.large.id]],
      ['b', [f.second.id]],
    ] as const) {
      const segment = run.planSegments.segments.find(
        (row: { stepId: string }) => row.stepId === stepId
      );
      expect(segment.endSequence).not.toBeNull();
      const members = response.items.filter(
        (item: { firstPublicationSequence: number }) =>
          item.firstPublicationSequence >= segment.startSequence &&
          item.firstPublicationSequence < segment.endSequence
      );
      expect(members.map((item: { id: string }) => item.id).sort()).toEqual([...ids].sort());
    }
  });

  it('keeps the first position while exposing the current revision after the next interval starts', async () => {
    const f = await fixture();
    const response = await f.operation('thread.timeline', {
      view: 'items',
      turnId: f.turn.id,
      placement: 'step',
    });
    const item = response.items.find((row: { id: string }) => row.id === f.first.id);
    expect(item.detail.value.content).toEqual(['Revised after B began']);
    expect(f.positions[f.first.id]).toBeLessThan(f.positions[f.second.id]);
    expect(item.firstPublicationSequence).toBe(f.positions[f.first.id]);
  });

  it('returns null without an exact snapshot source, even for a real canonical Item', async () => {
    const f = await fixture();
    const projected = projectTimelineItem(f.first, 8192, {
      store: f.store,
      input: f.selector,
      actor: { kind: 'local', userId: FIXTURE_LOCAL_USER_ID },
      administratorEligible: false,
    });
    expect(projected).toMatchObject({ id: f.first.id, firstPublicationSequence: null });
  });
});
