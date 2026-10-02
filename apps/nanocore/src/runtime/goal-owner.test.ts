import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { checkGoalCommandIntent, executeGoalOperation } from './goal-owner.js';
import { reserveGoalTask } from './goal-task-admission.js';
import { respondRecordedApproval } from './pending-request-flow.js';
import { readPendingRequest } from './pending-requests.js';

describe('Goal durable owner', () => {
  it('creates intent and cards without work and preserves intent history after revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-owner-'));
    const store = new FsStore({ dataRoot: root });
    const ws = store.createWorkspace('Goal test');
    const db = openWorkspaceDb(root, ws.id);
    applyScopedMigrations(db);
    try {
      const context = { actor: { kind: 'local' as const, userId: 'user_local' } };
      const created = await executeGoalOperation(
        'goal.create',
        {
          workspaceId: ws.id,
          requestId: '11111111-1111-4111-8111-111111111111',
          intent: 'Produce a reviewed design',
        },
        context,
        store,
        db
      );
      expect(created.goal?.activePlanVersionId).toBeNull();
      expect(created.tasks).toEqual([]);
      expect(
        new FsStore({ dataRoot: root }).getThread(ws.id, created.goal!.threadId).visibility
      ).toBe('workspace');
      const replayed = await executeGoalOperation(
        'goal.create',
        {
          workspaceId: ws.id,
          requestId: '11111111-1111-4111-8111-111111111111',
          intent: 'Produce a reviewed design',
        },
        context,
        store,
        db
      );
      expect(replayed.goal?.goalId).toBe(created.goal?.goalId);
      expect(store.listThreads(ws.id)).toHaveLength(1);
      const goal = created.goal!;
      const revised = await executeGoalOperation(
        'goal.intent.revise',
        {
          workspaceId: ws.id,
          threadId: goal.threadId,
          goalId: goal.goalId,
          requestId: '22222222-2222-4222-8222-222222222222',
          expectedRevision: 0,
          intent: 'Produce a reviewed design without deployment',
        },
        context,
        store,
        db
      );
      expect(revised.goal?.intentHistory.map((entry) => entry.intent)).toEqual([
        'Produce a reviewed design',
        'Produce a reviewed design without deployment',
      ]);
      await expect(
        executeGoalOperation(
          'goal.intent.revise',
          {
            workspaceId: ws.id,
            threadId: goal.threadId,
            goalId: goal.goalId,
            requestId: '33333333-3333-4333-8333-333333333333',
            expectedRevision: 0,
            intent: 'stale',
          },
          context,
          store,
          db
        )
      ).rejects.toMatchObject({ code: 'revision_conflict' });
    } finally {
      db.sqlite.close();
    }
  });
  it('refuses a private Quick Chat Coordinator Thread before storing a Goal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-audience-'));
    const store = new FsStore({ dataRoot: root });
    const ws = store.ensureQuickChatWorkspace('user_local');
    const db = openWorkspaceDb(root, ws.id);
    applyScopedMigrations(db);
    try {
      await expect(
        executeGoalOperation(
          'goal.create',
          {
            workspaceId: ws.id,
            requestId: '44444444-4444-4444-8444-444444444444',
            intent: 'Produce a shared design',
          },
          { actor: { kind: 'local', userId: 'user_local' } },
          store,
          db
        )
      ).rejects.toThrow('Quick Chat requires its owner-only private audience.');
      expect(new FsStore({ dataRoot: root }).listThreads(ws.id)).toEqual([]);
      expect(db.sqlite.prepare('SELECT * FROM goals').all()).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });
});

// Regressions exercise exact commitments independently of their historical input basis.
describe('Proposed Plan eligibility', () => {
  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'goal-plan-'));
    const store = new FsStore({ dataRoot: root });
    const ws = store.createWorkspace('Plan eligibility');
    const db = openWorkspaceDb(root, ws.id);
    applyScopedMigrations(db);
    const human = { actor: { kind: 'local' as const, userId: 'user_local' } };
    let serial = 10;
    const requestId = () => `00000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`;
    const created = await executeGoalOperation(
      'goal.create',
      { workspaceId: ws.id, requestId: requestId(), intent: 'Produce a design' },
      human,
      store,
      db
    );
    const scope = {
      workspaceId: ws.id,
      threadId: created.goal!.threadId,
      goalId: created.goal!.goalId,
    };
    const turn = store.createTurn(
      ws.id,
      scope.threadId,
      'Coordinate',
      { kind: 'user', id: 'user_local' },
      undefined,
      { executorKind: 'coordinator', agentId: 'goal-coordinator' }
    );
    const coordinator = { ...human, coordinatorTurnId: turn.id };
    const cardView = await executeGoalOperation(
      'goal.card.create',
      { ...scope, requestId: requestId(), description: 'Design the schema', priority: 1 },
      human,
      store,
      db
    );
    const card = cardView.cards[0]!;
    async function propose() {
      const current = await executeGoalOperation('goal.read', scope, human, store, db);
      const view = await executeGoalOperation(
        'goal.plan.propose',
        {
          ...scope,
          requestId: requestId(),
          expectedRevision: current.goal!.changeRevision,
          commitment: {
            intentBasis: { revision: 0, intent: 'Produce a design' },
            cards: [
              {
                cardId: card.cardId,
                revision: 0,
                description: card.description,
                priority: card.priority,
              },
            ],
            permittedAdjustments: 'Refine the design without deployment',
            completionEvidence: ['Reviewed design'],
            boundaries: 'No deployment',
          },
        },
        coordinator,
        store,
        db
      );
      return view.versions.at(-1)!;
    }
    async function resolve(pendingRequestId: string) {
      return executeGoalOperation(
        'goal.plan.approve',
        { ...scope, requestId: requestId(), pendingRequestId, decision: 'granted' },
        human,
        store,
        db
      );
    }
    async function consume(pendingRequestId: string, grantAuthority = () => true) {
      return executeGoalOperation(
        'goal.plan.approve',
        { ...scope, requestId: requestId(), pendingRequestId, decision: 'granted' },
        coordinator,
        store,
        db,
        { grantAuthority }
      );
    }
    return {
      root,
      store,
      db,
      human,
      coordinator,
      scope,
      card,
      requestId,
      propose,
      resolve,
      consume,
    };
  }
  for (const edit of ['intent', 'card'] as const)
    for (const timing of ['before-resolution', 'after-grant'] as const)
      it(`${edit} edit ${timing} preserves exact proposed bytes and eligibility`, async () => {
        const f = await fixture();
        try {
          const plan = await f.propose();
          if (timing === 'after-grant') await f.resolve(plan.pendingRequestId);
          const beforeEdit = await executeGoalOperation(
            'goal.read',
            f.scope,
            f.human,
            f.store,
            f.db
          );
          if (edit === 'intent')
            await executeGoalOperation(
              'goal.intent.revise',
              {
                ...f.scope,
                requestId: f.requestId(),
                expectedRevision: 0,
                intent: 'Produce a design without implementation',
              },
              f.human,
              f.store,
              f.db
            );
          else
            await executeGoalOperation(
              'goal.card.edit',
              {
                ...f.scope,
                requestId: f.requestId(),
                cardId: f.card.cardId,
                expectedRevision: 0,
                description: 'Design the schema with examples',
                priority: 2,
              },
              f.human,
              f.store,
              f.db
            );
          const afterEdit = await executeGoalOperation(
            'goal.read',
            f.scope,
            f.human,
            f.store,
            f.db
          );
          expect(afterEdit.goal!.changeRevision).toBe(beforeEdit.goal!.changeRevision + 1);
          if (timing === 'before-resolution') await f.resolve(plan.pendingRequestId);
          const consumeInput = {
            ...f.scope,
            requestId: f.requestId(),
            pendingRequestId: plan.pendingRequestId,
            decision: 'granted' as const,
          };
          const result = await executeGoalOperation(
            'goal.plan.approve',
            consumeInput,
            f.coordinator,
            f.store,
            f.db,
            { grantAuthority: () => true }
          );
          expect(result.goal!.activePlanVersionId).toBe(plan.planVersionId);
          expect(result.versions[0]!.bytes).toBe(plan.bytes);
          expect(result.versions[0]!.digest).toBe(plan.digest);
          expect(result.tasks).toEqual([]);
          if (edit === 'intent')
            expect(result.goal!.intent).toBe('Produce a design without implementation');
          else expect(result.cards[0]!.description).toBe('Design the schema with examples');
          f.db.sqlite.close();
          f.db = openWorkspaceDb(f.root, f.scope.workspaceId);
          applyScopedMigrations(f.db);
          const restarted = new FsStore({ dataRoot: f.root });
          const replayed = await executeGoalOperation(
            'goal.plan.approve',
            consumeInput,
            f.coordinator,
            restarted,
            f.db,
            { grantAuthority: () => true }
          );
          expect(replayed.goal!.activePlanVersionId).toBe(plan.planVersionId);
          expect(replayed.goal!.changeRevision).toBe(result.goal!.changeRevision);
          expect(replayed.versions[0]!.bytes).toBe(plan.bytes);
          expect(
            replayed.requests.find((request) => request.requestId === plan.pendingRequestId)
          ).toMatchObject({
            claim: 'finished',
            disposition: 'approved-executed',
          });
          expect(replayed.tasks).toEqual([]);
        } finally {
          f.db.sqlite.close();
        }
      });
  for (const surface of ['goal-operation', 'shared-approval'] as const)
    it(`refuses changed Plan bytes through ${surface} before recording a grant`, async () => {
      const f = await fixture();
      try {
        const plan = await f.propose();
        f.db.sqlite
          .prepare('UPDATE goal_plan_versions SET payload_json=? WHERE plan_version_id=?')
          .run(JSON.stringify({ ...plan, bytes: `${plan.bytes} ` }), plan.planVersionId);
        const attempt =
          surface === 'goal-operation'
            ? f.resolve(plan.pendingRequestId)
            : respondRecordedApproval({
                store: f.store,
                sqlite: f.db.sqlite,
                workspaceId: f.scope.workspaceId,
                threadId: f.scope.threadId,
                approvalRequestId: plan.pendingRequestId,
                decision: 'granted',
                actorId: f.human.actor.userId,
                requestActor: f.human.actor,
                dependencies: {
                  openWorkspace: () => f.db,
                  checkCommandIntent: checkGoalCommandIntent,
                },
              });
        await expect(attempt).rejects.toMatchObject({ code: 'approval_conflict' });
        expect(readPendingRequest(f.db.sqlite, plan.pendingRequestId)).toMatchObject({
          state: 'pending',
          resolution: null,
          claim: 'unclaimed',
        });
      } finally {
        f.db.sqlite.close();
      }
    });
  it('refuses Coordinator self-resolution before any human grant', async () => {
    const f = await fixture();
    try {
      const plan = await f.propose();
      await expect(f.consume(plan.pendingRequestId)).rejects.toMatchObject({
        code: 'coordinator_self_approval_denied',
      });
    } finally {
      f.db.sqlite.close();
    }
  });
  it('supersedes only pending P1 when P2 precedes the P1 response', async () => {
    const f = await fixture();
    try {
      const p1 = await f.propose();
      const p2 = await f.propose();
      await expect(f.resolve(p1.pendingRequestId)).rejects.toMatchObject({
        code: 'request_not_pending',
      });
      const view = await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db);
      expect(view.requests.find((r) => r.requestId === p1.pendingRequestId)).toMatchObject({
        state: 'ended',
        reason: 'Superseded by a newer Plan proposal.',
      });
      expect(view.goal!.proposedPlanVersionId).toBe(p2.planVersionId);
    } finally {
      f.db.sqlite.close();
    }
  });
  it('retains a granted P1 across a newer proposal and prevents rollback after P2 activation', async () => {
    const f = await fixture();
    try {
      const p1 = await f.propose();
      await f.resolve(p1.pendingRequestId);
      const p2 = await f.propose();
      const active = await f.consume(p1.pendingRequestId);
      expect(active.goal!.activePlanVersionId).toBe(p1.planVersionId);
      expect(active.goal!.proposedPlanVersionId).toBe(p2.planVersionId);
      await f.resolve(p2.pendingRequestId);
      const later = await f.consume(p2.pendingRequestId);
      expect(later.goal!.activePlanVersionId).toBe(p2.planVersionId);
    } finally {
      f.db.sqlite.close();
    }
  });
  it('records cancellation-before-claim as denied-not-executed and never activates', async () => {
    const f = await fixture();
    try {
      const p1 = await f.propose();
      await f.resolve(p1.pendingRequestId);
      const view = await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db);
      await executeGoalOperation(
        'goal.cancel',
        {
          ...f.scope,
          requestId: f.requestId(),
          expectedRevision: view.goal!.changeRevision,
          reason: 'Stop',
        },
        f.human,
        f.store,
        f.db
      );
      await expect(f.consume(p1.pendingRequestId)).rejects.toMatchObject({
        code: 'grant_conflict',
      });
      const request = f.db.sqlite
        .prepare('SELECT claim,disposition FROM pending_requests WHERE request_id=?')
        .get(p1.pendingRequestId);
      expect(request).toEqual({ claim: 'unclaimed', disposition: 'denied-not-executed' });
    } finally {
      f.db.sqlite.close();
    }
  });
  it('refuses revoked deciding authority before the claim', async () => {
    const f = await fixture();
    try {
      const p1 = await f.propose();
      await f.resolve(p1.pendingRequestId);
      await expect(f.consume(p1.pendingRequestId, () => false)).rejects.toMatchObject({
        code: 'grant_conflict',
      });
      expect(
        f.db.sqlite
          .prepare('SELECT claim,disposition FROM pending_requests WHERE request_id=?')
          .get(p1.pendingRequestId)
      ).toEqual({ claim: 'unclaimed', disposition: 'denied-not-executed' });
    } finally {
      f.db.sqlite.close();
    }
  });
  it('refuses an intent-only prohibition even with an unchanged card, and records exact current citations on later admission', async () => {
    const f = await fixture();
    try {
      const p = await f.propose();
      await f.resolve(p.pendingRequestId);
      await f.consume(p.pendingRequestId);
      const revised = await executeGoalOperation(
        'goal.intent.revise',
        {
          ...f.scope,
          requestId: f.requestId(),
          expectedRevision: 0,
          intent: 'Research only; prohibit implementation',
        },
        f.human,
        f.store,
        f.db
      );
      const thread = f.store.createThread(f.scope.workspaceId, 'Ordinary Task');
      const input = {
        goalId: f.scope.goalId,
        cardId: f.card.cardId,
        planVersionId: p.planVersionId,
        cardRevision: 0,
        intentRevision: revised.goal!.intentRevision,
        withinCurrentIntent: false,
        withinPermittedAdjustments: true,
        rationale: 'Implementation is now prohibited.',
      };
      expect(() =>
        f.db.sqlite.transaction(() => reserveGoalTask(f.store, f.db, input, thread.id))()
      ).toThrow('not authorized');
      expect(() =>
        f.db.sqlite.transaction(() =>
          reserveGoalTask(
            f.store,
            f.db,
            { ...input, intentRevision: 0, withinCurrentIntent: true },
            thread.id
          )
        )()
      ).toThrow('changed before reservation');
      f.db.sqlite.transaction(() =>
        reserveGoalTask(
          f.store,
          f.db,
          { ...input, withinCurrentIntent: true, rationale: 'Research the design only.' },
          thread.id
        )
      )();
      const view = await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db);
      expect(view.tasks[0]).toMatchObject({
        cardRevision: 0,
        planVersionId: p.planVersionId,
        threadId: thread.id,
      });
      expect(view.goal!.disposition).toBeNull();
    } finally {
      f.db.sqlite.close();
    }
  });
  it('admits a current edited card only within permitted adjustments and refuses every cancelled card', async () => {
    const f = await fixture();
    try {
      const plan = await f.propose();
      await f.resolve(plan.pendingRequestId);
      await f.consume(plan.pendingRequestId);
      await executeGoalOperation(
        'goal.card.edit',
        {
          ...f.scope,
          requestId: f.requestId(),
          cardId: f.card.cardId,
          expectedRevision: 0,
          description: 'Design with examples',
          priority: 2,
        },
        f.human,
        f.store,
        f.db
      );
      const task = f.store.createThread(f.scope.workspaceId, 'Task');
      const admission = {
        goalId: f.scope.goalId,
        cardId: f.card.cardId,
        planVersionId: plan.planVersionId,
        cardRevision: 1,
        intentRevision: 0,
        withinCurrentIntent: true,
        withinPermittedAdjustments: true,
        rationale: 'Examples are within the approved refinement.',
      };
      const reserve = (value: typeof admission) =>
        f.db.sqlite.transaction(() => reserveGoalTask(f.store, f.db, value, task.id))();
      expect(() => reserve({ ...admission, cardRevision: 0 })).toThrow(
        'changed before reservation'
      );
      expect(() => reserve({ ...admission, withinPermittedAdjustments: false })).toThrow(
        'not authorized'
      );
      reserve(admission);
      const linked = await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db);
      expect(linked.tasks[0]).toMatchObject({ cardRevision: 1, planVersionId: plan.planVersionId });
      await executeGoalOperation(
        'goal.card.cancel',
        {
          ...f.scope,
          requestId: f.requestId(),
          cardId: f.card.cardId,
          expectedRevision: 1,
          reason: 'Stop this contribution',
        },
        f.human,
        f.store,
        f.db
      );
      const another = f.store.createThread(f.scope.workspaceId, 'Another Task');
      expect(() =>
        f.db.sqlite.transaction(() =>
          reserveGoalTask(f.store, f.db, { ...admission, cardRevision: 2 }, another.id)
        )()
      ).toThrow('has ended');
      expect(
        (await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db)).tasks
      ).toHaveLength(1);
    } finally {
      f.db.sqlite.close();
    }
  });
  it('cancels an open Goal with missing Task history without inventing an interrupt or a result', async () => {
    const f = await fixture();
    try {
      const plan = await f.propose();
      await f.resolve(plan.pendingRequestId);
      await f.consume(plan.pendingRequestId);
      const link = {
        goalId: f.scope.goalId,
        cardId: f.card.cardId,
        threadId: 'th_missing_task',
        planVersionId: plan.planVersionId,
        cardRevision: 0,
        admittedAt: new Date().toISOString(),
      };
      f.db.sqlite
        .prepare('INSERT INTO goal_card_tasks VALUES (?,?,?,?)')
        .run(link.threadId, link.goalId, link.cardId, JSON.stringify(link));
      const before = await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db);
      let interrupts = 0;
      const cancelled = await executeGoalOperation(
        'goal.cancel',
        {
          ...f.scope,
          requestId: f.requestId(),
          expectedRevision: before.goal!.changeRevision,
          reason: 'Stop',
        },
        f.human,
        f.store,
        f.db,
        {
          interrupt: () => {
            interrupts++;
          },
        }
      );
      expect(cancelled.goal!.disposition).toMatchObject({ kind: 'cancelled', reason: 'Stop' });
      expect(cancelled.tasks[0]).toMatchObject({ missing: true, turns: [] });
      expect(interrupts).toBe(0);
    } finally {
      f.db.sqlite.close();
    }
  });
  it('cannot consume an unconsumed older grant after a later Plan becomes active', async () => {
    const f = await fixture();
    try {
      const p1 = await f.propose();
      await f.resolve(p1.pendingRequestId);
      const p2 = await f.propose();
      await f.resolve(p2.pendingRequestId);
      await f.consume(p2.pendingRequestId);
      await expect(f.consume(p1.pendingRequestId)).rejects.toMatchObject({
        code: 'grant_conflict',
      });
      const view = await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db);
      expect(view.goal!.activePlanVersionId).toBe(p2.planVersionId);
    } finally {
      f.db.sqlite.close();
    }
  });
  it('refuses an older grant when the later active Plan record is missing', async () => {
    const f = await fixture();
    try {
      const p1 = await f.propose();
      await f.resolve(p1.pendingRequestId);
      const p2 = await f.propose();
      await f.resolve(p2.pendingRequestId);
      await f.consume(p2.pendingRequestId);
      f.db.sqlite
        .prepare('DELETE FROM goal_plan_versions WHERE plan_version_id=?')
        .run(p2.planVersionId);
      await expect(f.consume(p1.pendingRequestId)).rejects.toMatchObject({
        code: 'grant_conflict',
      });
      const current = await executeGoalOperation('goal.read', f.scope, f.human, f.store, f.db);
      expect(current.goal!.activePlanVersionId).toBe(p2.planVersionId);
      expect(readPendingRequest(f.db.sqlite, p1.pendingRequestId)).toMatchObject({
        claim: 'unclaimed',
        disposition: 'denied-not-executed',
      });
    } finally {
      f.db.sqlite.close();
    }
  });
  it('captures an exact completion candidate without accepting, then accepts only its unchanged current intent', async () => {
    const f = await fixture();
    try {
      const p = await f.propose();
      await f.resolve(p.pendingRequestId);
      await f.consume(p.pendingRequestId);
      const candidate = {
        intentRevision: 0,
        intent: 'Produce a design',
        planVersionId: p.planVersionId,
        evidence: [],
        unresolvedWork: ['No report retained'],
        summary: 'Review unresolved work explicitly.',
      };
      const raised = await executeGoalOperation(
        'goal.completion.accept',
        { ...f.scope, requestId: f.requestId(), candidate },
        f.coordinator,
        f.store,
        f.db
      );
      const request = raised.requests.find((row) => row.operation === 'goal.completion.accept')!;
      expect(raised.goal!.disposition).toBeNull();
      expect(request.exactIntent.candidate).toEqual(candidate);
      await executeGoalOperation(
        'goal.completion.accept',
        {
          ...f.scope,
          requestId: f.requestId(),
          pendingRequestId: request.requestId,
          decision: 'granted',
        },
        f.human,
        f.store,
        f.db
      );
      const ended = await executeGoalOperation(
        'goal.completion.accept',
        {
          ...f.scope,
          requestId: f.requestId(),
          pendingRequestId: request.requestId,
          decision: 'granted',
        },
        f.coordinator,
        f.store,
        f.db
      );
      expect(ended.goal!.disposition).toMatchObject({
        kind: 'accepted',
        candidate,
        actorId: 'user_local',
      });
    } finally {
      f.db.sqlite.close();
    }
  });
});

describe('Public Goal command publication', () => {
  it('captures a public Plan proposal for the Coordinator without attributing its caller to the responsible person', async () => {
    const store = new FsStore();
    const ws = store.createWorkspace('Public proposal');
    const db = openWorkspaceDb(mkdtempSync(join(tmpdir(), 'goal-public-plan-')), ws.id);
    applyScopedMigrations(db);
    const person = { actor: { kind: 'local' as const, userId: 'user_local' } };
    const caller = { actor: { kind: 'session' as const, userId: 'another-writer' } };
    try {
      const created = await executeGoalOperation(
        'goal.create',
        { workspaceId: ws.id, requestId: '10000000-0000-4000-8000-000000000001', intent: 'Design' },
        person,
        store,
        db
      );
      const goal = created.goal!;
      const scope = { workspaceId: ws.id, threadId: goal.threadId, goalId: goal.goalId };
      const cards = await executeGoalOperation(
        'goal.card.create',
        {
          ...scope,
          requestId: '10000000-0000-4000-8000-000000000002',
          description: 'Review design',
          priority: 0,
        },
        person,
        store,
        db
      );
      const card = cards.cards[0]!;
      const input = {
        ...scope,
        requestId: '10000000-0000-4000-8000-000000000003',
        expectedRevision: cards.goal!.changeRevision,
        commitment: {
          intentBasis: { revision: 0, intent: goal.intent },
          cards: [{ cardId: card.cardId, revision: 0, description: card.description, priority: 0 }],
          permittedAdjustments: 'Refine design',
          completionEvidence: ['Review'],
          boundaries: 'No deployment',
        },
      };
      const proposed = await executeGoalOperation('goal.plan.propose', input, caller, store, db);
      const request = readPendingRequest(db.sqlite, proposed.versions[0]!.pendingRequestId)!;
      expect(request).toMatchObject({
        requesterKind: 'coordinator',
        agentId: 'goal-coordinator',
        agentSessionId: null,
        responsibleUserId: 'user_local',
        state: 'pending',
      });
      const turn = store.getTurnById(request.raisingTurnId);
      expect(turn).toMatchObject({
        agentId: 'goal-coordinator',
        status: 'completed',
        triggerActor: { kind: 'user', id: 'another-writer' },
      });
      expect(turn.agentSessionId).toBeUndefined();
      const replay = await executeGoalOperation('goal.plan.propose', input, caller, store, db);
      expect(replay.versions).toHaveLength(1);
      expect(store.listThreadTurns(ws.id, goal.threadId)).toHaveLength(1);
      expect(replay.tasks).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });
  it('publishes one replayable origin handoff and never recreates a missing receipted Goal', async () => {
    const store = new FsStore();
    const ws = store.createWorkspace('Origin');
    const origin = store.createThread(ws.id, 'Chat');
    const db = openWorkspaceDb(mkdtempSync(join(tmpdir(), 'goal-origin-')), ws.id);
    applyScopedMigrations(db);
    const context = { actor: { kind: 'local' as const, userId: 'user_local' } };
    const input = {
      workspaceId: ws.id,
      requestId: '10000000-0000-4000-8000-000000000004',
      intent: 'Design',
      originThreadId: origin.id,
    };
    try {
      const created = await executeGoalOperation('goal.create', input, context, store, db);
      await executeGoalOperation('goal.create', input, context, store, db);
      expect(store.listThreadTurns(ws.id, origin.id)).toHaveLength(1);
      expect(store.listThreadItems(ws.id, origin.id)).toHaveLength(1);
      const threads = store.listThreads(ws.id).length;
      db.sqlite.prepare('DELETE FROM goals WHERE goal_id=?').run(created.goal!.goalId);
      const absent = await executeGoalOperation('goal.create', input, context, store, db);
      expect(absent.goal).toBeNull();
      expect(store.listThreads(ws.id)).toHaveLength(threads);
      expect(store.listThreadItems(ws.id, origin.id)).toHaveLength(1);
    } finally {
      db.sqlite.close();
    }
  });
});
