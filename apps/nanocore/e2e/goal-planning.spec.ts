import { randomUUID } from 'node:crypto';
import type { GoalView } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;
afterEach(async () => {
  if (harness) {
    await harness.stop();
    await removeDataRoot(harness.dataRoot);
    harness = null;
  }
});
describe('Goal atomic cutover e2e', () => {
  it('uses derived commands for one continuous intent, exact proposed Plan, human resolution, cards and cancellation', async () => {
    harness = await startNanoCoreHarness({ useSimulator: false });
    async function operation(id: string, input: Record<string, unknown>): Promise<GoalView> {
      const response = await fetch(`${harness!.baseUrl}/api/app/operations/${id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(id === 'goal.read' ? {} : { 'x-openkit-request-id': randomUUID() }),
        },
        body: JSON.stringify(input),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as GoalView;
    }
    const created = await operation('goal.create', {
      workspaceId: 'ws_demo',
      originThreadId: 'th_demo',
      intent: 'Review a release design',
    });
    const scope = {
      workspaceId: 'ws_demo',
      threadId: created.goal!.threadId,
      goalId: created.goal!.goalId,
    };
    expect(created.tasks).toEqual([]);
    expect(created.goal!.activePlanVersionId).toBeNull();
    const cards = await operation('goal.card.create', {
      ...scope,
      description: 'Design schema',
      priority: 1,
    });
    const card = cards.cards[0]!;
    await operation('goal.card.edit', {
      ...scope,
      cardId: card.cardId,
      expectedRevision: 0,
      description: 'Design schema with examples',
      priority: 2,
    });
    const read = await operation('goal.read', scope);
    const proposed = await operation('goal.plan.propose', {
      ...scope,
      expectedRevision: read.goal!.changeRevision,
      commitment: {
        intentBasis: { revision: 0, intent: created.goal!.intent },
        cards: [
          {
            cardId: card.cardId,
            revision: 1,
            description: 'Design schema with examples',
            priority: 2,
          },
        ],
        permittedAdjustments: 'Research without implementation',
        completionEvidence: ['Reviewed report'],
        boundaries: 'No external publication',
      },
    });
    const version = proposed.versions[0]!;
    await operation('goal.intent.revise', {
      ...scope,
      expectedRevision: 0,
      intent: 'Review a release design without implementation',
    });
    const granted = await operation('goal.plan.approve', {
      ...scope,
      pendingRequestId: version.pendingRequestId,
      decision: 'granted',
    });
    expect(
      granted.requests.find((request) => request.requestId === version.pendingRequestId)
    ).toMatchObject({ resolution: 'granted', claim: 'unclaimed' });
    expect(granted.goal!.activePlanVersionId).toBeNull();
    expect(granted.versions[0]!.bytes).toBe(version.bytes);
    expect(granted.tasks).toEqual([]);
    const ended = await operation('goal.cancel', {
      ...scope,
      expectedRevision: granted.goal!.changeRevision,
      reason: 'Person stops the outcome',
    });
    expect(ended.goal!.disposition?.kind).toBe('cancelled');
    expect((await operation('goal.read', scope)).goal!.intentHistory).toHaveLength(2);
    const retired = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/threads/${scope.threadId}/goal/step`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    expect(retired.status).toBe(404);
  });
});
