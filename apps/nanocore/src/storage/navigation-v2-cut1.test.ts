import { randomUUID } from 'node:crypto';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { readScopedHumanAttention } from '../action-center.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { executeGoalOperation, readGoalAttentionScope } from '../runtime/goal-owner.js';
import { StoredGoalCardTaskV1Schema } from '../runtime/goal-retained-v1.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { operationRequest } from '../test-support/operation-request.js';
import { openWorkspaceDb } from './db.js';

/** Real Goal/Pending producers plus a labelled retained Task-link topology counterfault exercise the existing 33-row scope. */
it('refuses navigation when an ineligible canonical scope prefix hides an actionable linked tail', async () => {
  const f = await navigationFixture();
  const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
  const human = { actor: { kind: 'local' as const, userId: f.actor.id } };
  try {
    const created = await executeGoalOperation(
      'goal.create',
      { workspaceId: f.workspaceId, requestId: randomUUID(), intent: 'Review bounded child work' },
      human,
      f.store,
      db
    );
    const goal = created.goal!;
    const scope = { workspaceId: f.workspaceId, threadId: goal.threadId, goalId: goal.goalId };
    const cardView = await executeGoalOperation(
      'goal.card.create',
      { ...scope, requestId: randomUUID(), description: 'Inspect child work', priority: 1 },
      human,
      f.store,
      db
    );
    const card = cardView.cards[0]!;
    const proposed = await executeGoalOperation(
      'goal.plan.propose',
      {
        ...scope,
        requestId: randomUUID(),
        expectedRevision: cardView.goal!.changeRevision,
        goalDomain: testGoalDomainProposal(f.workspaceId, goal.goalId),
        commitment: {
          intentBasis: { revision: goal.intentRevision, intent: goal.intent },
          cards: [
            {
              cardId: card.cardId,
              revision: card.revision,
              description: card.description,
              priority: card.priority,
            },
          ],
          permittedAdjustments: 'Inspect locally',
          completionEvidence: ['Review'],
          boundaries: 'No external effects',
        },
      },
      human,
      f.store,
      db
    );
    const version = proposed.versions[0]!;
    await executeGoalOperation(
      'goal.plan.approve',
      {
        ...scope,
        requestId: randomUUID(),
        pendingRequestId: version.pendingRequestId,
        decision: 'granted',
      },
      human,
      f.store,
      db
    );
    const foreignUser = allocateEntityId('usr');
    const threads: string[] = [];
    for (let i = 0; i < 34; i++) {
      const thread = await f.store.createThread(f.workspaceId, `Scoped child ${i}`);
      threads.push(thread.id);
      const turn = await f.store.createTurn(f.workspaceId, thread.id, 'Child request', {
        kind: 'user',
        id: i < 33 ? foreignUser : f.actor.id,
      });
      // Deliberate topology counterfault: real source identities and real retained Plan/card citations,
      // but no claim of actual Task admission or worker execution. The exact existing reader validates the shape.
      const link = StoredGoalCardTaskV1Schema.parse({
        goalId: goal.goalId,
        cardId: card.cardId,
        threadId: thread.id,
        planVersionId: version.planVersionId,
        cardRevision: card.revision,
      });
      db.sqlite
        .prepare(
          'INSERT INTO goal_card_tasks (schema_version,thread_id,goal_id,card_id,payload_json) VALUES (1,?,?,?,?)'
        )
        .run(thread.id, goal.goalId, card.cardId, JSON.stringify(link));
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId: `ap_scope_${String(i).padStart(3, '0')}`,
        workspaceId: f.workspaceId,
        threadId: thread.id,
        raisingTurnId: turn.id,
        requestItemId: allocateEntityId('it'),
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: i < 33 ? foreignUser : f.actor.id,
        governedIntent: { operation: 'fixture', scenario: 'clipped-attention' },
        approval: {
          kind: 'permission',
          title: 'Inspect child result',
          description: 'No external effects.',
        },
        now: `2026-09-15T03:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
    const selected = readGoalAttentionScope(db, goal.threadId);
    expect(selected.more).toBe(true);
    expect(selected.threadIds).toContain(threads[0]);
    expect(selected.threadIds).not.toContain(threads[33]);
    const actor = { kind: 'local' as const, userId: f.actor.id };
    const prefix = readScopedHumanAttention({
      store: f.store,
      coreDb: f.coreDb,
      workspaceDb: db,
      workspaceId: f.workspaceId,
      threadIds: selected.threadIds,
      actor,
      administratorEligible: false,
    });
    expect(prefix.items).toEqual([]);
    const tail = readScopedHumanAttention({
      store: f.store,
      coreDb: f.coreDb,
      workspaceDb: db,
      workspaceId: f.workspaceId,
      threadIds: [threads[33]!],
      actor,
      administratorEligible: false,
    });
    expect(tail.items).toHaveLength(1);
    expect(tail.items[0]!.kind).toBe('approval');
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.actor.id,
      scope: 'workspace',
      workspaceIds: [f.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
    const response = await f.app.request(
      ...operationRequest(
        'conversation.navigation',
        { workspaceId: f.workspaceId },
        { headers: { authorization: `Bearer ${token}` } }
      )
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).not.toHaveProperty('items');
  } finally {
    db.sqlite.close();
  }
}, 60000);
