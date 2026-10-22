import { randomUUID } from 'node:crypto';
import type { GoalView, ThreadDashboardResponse } from '@openkit/app-api-schemas';
import { isSealedTurnTerminal } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { testGoalDomainProposal } from '../dist/test-support/goal-domain.js';
import {
  type NanoCoreHarness,
  readTurnEventsUntil,
  removeDataRoot,
  startNanoCoreHarness,
} from './_lib/harness.js';

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
    async function operation<T = GoalView>(id: string, input: Record<string, unknown>): Promise<T> {
      const response = await fetch(`${harness!.baseUrl}/api/app/operations/${id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(id === 'goal.read' ? {} : { 'x-openkit-request-id': randomUUID() }),
        },
        body: JSON.stringify(input),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as T;
    }
    const created = await operation('goal.create', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      originThreadId: 'th_00000000-0000-7000-8000-000000000001',
      intent: 'Review a release design',
    });
    const scope = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    const selector = { workspaceId: scope.workspaceId, threadId: scope.threadId };
    let dashboard = await operation<ThreadDashboardResponse>('thread.dashboard', selector);
    let read: GoalView;
    for (;;) {
      const coordinator =
        dashboard.turns.find((turn) => !isSealedTurnTerminal(turn.status)) ??
        dashboard.turns.at(-1);
      expect(coordinator).toMatchObject({ agentId: 'goal-coordinator', threadId: scope.threadId });
      const events = await readTurnEventsUntil(
        harness.baseUrl,
        scope.workspaceId,
        scope.threadId,
        coordinator!.id,
        (event) => event.event === 'turn.completed'
      );
      expect(events.at(-1)).toMatchObject({
        event: 'turn.completed',
        threadId: scope.threadId,
        turnId: coordinator!.id,
        data: { type: 'turn-completed', turn: { id: coordinator!.id } },
      });
      const before = await operation('goal.read', scope);
      dashboard = await operation<ThreadDashboardResponse>('thread.dashboard', selector);
      read = await operation('goal.read', scope);
      if (
        before.goal!.changeRevision === read.goal!.changeRevision &&
        before.goal!.consideredRevision === read.goal!.consideredRevision &&
        read.goal!.consideredRevision === read.goal!.changeRevision &&
        dashboard.turns.every((turn) => isSealedTurnTerminal(turn.status))
      )
        break;
    }
    const proposed = await operation('goal.plan.propose', {
      ...scope,
      expectedRevision: read.goal!.changeRevision,
      goalDomain: testGoalDomainProposal(scope.workspaceId, scope.goalId),
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
      `${harness.baseUrl}/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/${scope.threadId}/goal/step`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    expect(retired.status).toBe(404);
  });
});
