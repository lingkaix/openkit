import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { openWorkspaceDb } from './db.js';

/** Cut 1 owns bounded activity and attention; unread may still own a history read. */
describe('navigation cut 1 independent oracle', () => {
  it('allows full Turn enumeration only inside the remaining unread Item read', async () => {
    const f = await navigationFixture();
    const originalItems = f.store.listThreadItems.bind(f.store);
    const originalTurns = f.store.listThreadTurns.bind(f.store);
    let unreadDepth = 0;
    const outside: string[] = [];
    const items = vi.spyOn(f.store, 'listThreadItems').mockImplementation((...args) => {
      unreadDepth++;
      try {
        return originalItems(...args);
      } finally {
        unreadDepth--;
      }
    });
    const turns = vi.spyOn(f.store, 'listThreadTurns').mockImplementation((...args) => {
      if (unreadDepth === 0) outside.push(args[1]);
      return originalTurns(...args);
    });
    try {
      expect((await f.request()).status).toBe(200);
      expect(outside).toEqual([]);
    } finally {
      items.mockRestore();
      turns.mockRestore();
    }
  });

  it('keeps startedAt selection and tie order independent of admission, plus the maximum Item timestamp', async () => {
    const f = await navigationFixture();
    await f.message('A later reply on the earlier Turn.');
    await f.store.updateTurn(f.turn.id, {
      agentId: 'quick-chat',
      status: 'completed',
      completedAt: '2026-09-15T01:00:00.000Z',
    });
    const second = await f.store.createTurn(
      f.workspaceId,
      f.thread.id,
      'Tied later admission',
      f.actor,
      null,
      { startedAt: '2026-09-15T00:00:00.000Z' }
    );
    await f.store.updateTurn(second.id, {
      agentId: 'unrecognized-oracle-agent',
      status: 'completed',
      completedAt: '2026-09-15T02:00:00.000Z',
    });
    const olderAdmission = await f.store.createTurn(
      f.workspaceId,
      f.thread.id,
      'Later admission with older start',
      f.actor,
      null,
      { startedAt: '2026-09-14T00:00:00.000Z' }
    );
    await f.store.updateTurn(olderAdmission.id, {
      agentId: 'quick-chat',
      status: 'completed',
      completedAt: '2026-09-15T00:00:00.000Z',
    });
    expect(await f.row()).toMatchObject({
      activity: 'unknown',
      state: 'idle',
      lastActivityAt: '2026-09-15T04:00:00.000Z',
      unreadCount: 1,
    });
  });

  it('selects active work before a newer-started completed predecessor', async () => {
    const f = await navigationFixture();
    await f.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: '2026-09-15T01:00:00.000Z',
    });
    const active = await f.store.createTurn(
      f.workspaceId,
      f.thread.id,
      'Active older start',
      f.actor,
      null,
      { startedAt: '2026-09-14T00:00:00.000Z' }
    );
    await f.store.updateTurn(active.id, { agentId: 'quick-chat' });
    expect(await f.row()).toMatchObject({
      activity: 'chat',
      state: 'working',
      lastActivityAt: '2026-09-15T01:00:00.000Z',
    });
  });

  it('uses the real Pending owner for exact viewer-eligible attention', async () => {
    const f = await navigationFixture();
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId: 'ap_navigation_oracle',
        workspaceId: f.workspaceId,
        threadId: f.thread.id,
        raisingTurnId: f.turn.id,
        requestItemId: allocateEntityId('it'),
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: f.actor.id,
        governedIntent: { operation: 'fixture', scenario: 'navigation-oracle' },
        approval: {
          kind: 'permission',
          title: 'Review this action',
          description: 'No external effect.',
        },
        now: '2026-09-15T03:00:00.000Z',
      });
      expect(await f.row()).toMatchObject({ state: 'needs-you' });
    } finally {
      db.sqlite.close();
    }
  });

  it('fails explicitly when canonical attention evidence is unavailable', async () => {
    const f = await navigationFixture();
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      const requestItemId = allocateEntityId('it');
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId: 'ap_navigation_large',
        workspaceId: f.workspaceId,
        threadId: f.thread.id,
        raisingTurnId: f.turn.id,
        requestItemId,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: f.actor.id,
        governedIntent: { operation: 'fixture', scenario: 'navigation-large-proof' },
        approval: {
          kind: 'permission',
          title: 'Large canonical request',
          description: 'x'.repeat(70_000),
        },
        now: '2026-09-15T03:00:00.000Z',
      });
      // Deliberate loss after valid owner publication makes canonical proof impossible.
      const files = (directory: string): string[] =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? files(join(directory, entry.name))
            : entry.isFile()
              ? [join(directory, entry.name)]
              : []
        );
      const bodies = files(f.dataRoot)
        .filter((path) => !/\.(?:sqlite|db)(?:-|$)/.test(path))
        .filter((path) => {
          const bytes = readFileSync(path);
          return (
            bytes.length > 70_000 &&
            bytes.includes(Buffer.from(requestItemId)) &&
            bytes.includes(Buffer.from('approval-request'))
          );
        });
      expect(bodies.length).toBeGreaterThan(0);
      for (const path of bodies) unlinkSync(path);
      const response = await f.request();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.json()).not.toHaveProperty('items');
    } finally {
      db.sqlite.close();
    }
  });

  it('projects an actionable Goal plan review with no running Turn as needs-you', async () => {
    const f = await navigationFixture();
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    const human = { actor: { kind: 'local' as const, userId: f.actor.id } };
    try {
      const created = await executeGoalOperation(
        'goal.create',
        { workspaceId: f.workspaceId, requestId: randomUUID(), intent: 'Review a design' },
        human,
        f.store,
        db
      );
      const goal = created.goal!;
      const scope = { workspaceId: f.workspaceId, threadId: goal.threadId, goalId: goal.goalId };
      const cards = await executeGoalOperation(
        'goal.card.create',
        { ...scope, requestId: randomUUID(), description: 'Design schema', priority: 1 },
        human,
        f.store,
        db
      );
      const card = cards.cards[0]!;
      await executeGoalOperation(
        'goal.plan.propose',
        {
          ...scope,
          requestId: randomUUID(),
          expectedRevision: cards.goal!.changeRevision,
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
            permittedAdjustments: 'Refine design',
            completionEvidence: ['Reviewed design'],
            boundaries: 'No external effects',
          },
        },
        human,
        f.store,
        db
      );
      const response = await f.request();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(
        body.items.find((entry: { thread: { id: string } }) => entry.thread.id === goal.threadId)
      ).toMatchObject({ activity: 'goal', state: 'needs-you' });
    } finally {
      db.sqlite.close();
    }
  });

  it('reports running Goal context as working even without a running Turn', async () => {
    const f = await navigationFixture();
    await f.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: '2026-09-15T01:00:00.000Z',
    });
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      const view = await executeGoalOperation(
        'goal.create',
        {
          workspaceId: f.workspaceId,
          requestId: randomUUID(),
          intent: 'Prepare an independent review',
        },
        { actor: { kind: 'local', userId: f.actor.id } },
        f.store,
        db,
        { coreDb: f.coreDb }
      );
      expect(view.goal).toMatchObject({ disposition: null });
      const response = await f.request();
      expect(response.status).toBe(200);
      const body = await response.json();
      const row = body.items.find(
        (entry: { thread: { id: string } }) => entry.thread.id === view.goal!.threadId
      );
      expect(row).toMatchObject({ activity: 'goal', state: 'working' });
    } finally {
      db.sqlite.close();
    }
  });
});
