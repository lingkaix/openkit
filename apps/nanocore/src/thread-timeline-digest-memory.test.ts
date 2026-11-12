import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { readThreadTimeline } from './thread-timeline.js';

// The in-memory Store implements the same snapshot contract, without native fixture handles.
describe('in-memory timeline digest snapshot', () => {
  it('keeps original positions across revisions and applies the historical body bound', async () => {
    const store = await createDemoStore();
    const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Memory digest');
    const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Input', actor);
    const base = {
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      status: 'completed' as const,
      createdAt: '2026-11-08T17:00:00.000Z',
      completedAt: '2026-11-08T17:00:00.000Z',
    };
    const plan = await store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'plan',
      title: 'Plan',
      summary: null,
      steps: [{ id: 'verify', title: 'Verify', status: 'pending' }],
    });
    await store.updateItem(plan.id, {
      steps: [{ id: 'verify', title: 'Verify', status: 'completed' }],
    });
    const note = await store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'assistant-message',
      text: 'Small note',
    });
    await store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'assistant-message',
      text: 'x'.repeat(70_000),
    });
    const response = readThreadTimeline({
      store,
      actor: { userId: FIXTURE_LOCAL_USER_ID, kind: 'local' },
      administratorEligible: true,
      input: { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id },
    });
    expect(response.digest.coverage).toBe('partial');
    expect(
      Object.fromEntries(response.digest.lines.map((line) => [line.kind, line.count]))
    ).toEqual({ 'plan-steps-finished': 1, 'new-messages': 1 });
    expect(response.digest.lines.find((line) => line.kind === 'new-messages')?.anchor).toEqual({
      kind: 'item',
      itemId: note.id,
    });
    store.readThreadTimelineSnapshot(DEMO_WORKSPACE_ID, thread.id, (snapshot) => {
      expect(snapshot.position(plan.id)?.sequence).toBe(1);
      expect(snapshot.position(note.id)?.sequence).toBe(3);
      expect(snapshot.revisionHead(turn.id)).toBe(4);
    });
  });

  it('counts the same recorded tool error in failure statistics and digest problems', async () => {
    const store = await createDemoStore();
    const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Recorded tool error');
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Input', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    await store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'tool-call',
      status: 'completed',
      tool: 'fixture.read',
      server: null,
      arguments: {},
      result: null,
      error: 'Recorded failure',
      durationMs: 1,
      createdAt: '2026-11-12T05:30:00.000Z',
      completedAt: '2026-11-12T05:30:00.000Z',
    });
    const response = readThreadTimeline({
      store,
      actor: { userId: FIXTURE_LOCAL_USER_ID, kind: 'local' },
      administratorEligible: true,
      input: { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id },
    });
    expect(response.runs[0]?.statistics.failedStepCount).toBe(1);
    expect(response.digest.lines.find((line) => line.kind === 'problems')?.count).toBe(1);
  });
});
