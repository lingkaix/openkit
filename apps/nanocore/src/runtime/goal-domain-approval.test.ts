import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { policyDigest } from '../policy/statements.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { executeGoalOperation } from './goal-owner.js';
import { projectApprovalEffect } from './pending-request-disclosure.js';
import { readPendingRequest } from './pending-requests.js';

it('captures the exact typed Goal domain and Plan in one human approval preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-domain-approval-'));
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Goal domain');
  const db = openWorkspaceDb(root, workspace.id);
  applyScopedMigrations(db);
  const context = {
    actor: { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' },
  };
  try {
    const created = await executeGoalOperation(
      'goal.create',
      { workspaceId: workspace.id, requestId: randomUUID(), intent: 'Review an application' },
      context,
      store,
      db
    );
    const goal = created.goal!;
    const goalDomain = {
      id: 'admissions-goal-domain',
      scope: {
        subjects: [{ kind: 'agent' as const, id: 'admissions-worker' }],
        actions: ['tool.use'],
        resources: [
          {
            kind: 'mcp-tool' as const,
            workspaceId: workspace.id,
            serverId: 'sis',
            toolName: 'application.read',
          },
        ],
      },
      lifetime: {
        anchor: {
          owner: { kind: 'workspace' as const, workspaceId: workspace.id },
          kind: 'goal',
          id: goal.goalId,
        },
      },
    };
    const commitment = {
      intentBasis: { revision: 0, intent: goal.intent },
      cards: [],
      permittedAdjustments: 'Read the application without sending a message',
      completionEvidence: ['Reviewed application'],
      boundaries: 'No email effect',
    };
    const input = {
      workspaceId: workspace.id,
      threadId: goal.threadId,
      goalId: goal.goalId,
      requestId: randomUUID(),
      expectedRevision: goal.changeRevision,
      commitment,
      goalDomain,
    };
    const proposed = await executeGoalOperation('goal.plan.propose', input, context, store, db);
    const plan = proposed.versions[0]!;
    const request = readPendingRequest(db.sqlite, plan.pendingRequestId)!;
    const captured = request.governedIntent!.goalDomain as {
      statement: Record<string, unknown>;
      digest: string;
    };
    expect(captured.statement).toMatchObject({
      ...goalDomain,
      kind: 'delegation',
      state: 'inactive',
      purpose: 'goal-domain',
      delegate: { kind: 'agent', id: 'goal-coordinator' },
      author: { kind: 'human', id: context.actor.userId },
      authority: { kind: 'human', userId: context.actor.userId },
      source: {
        workspaceId: workspace.id,
        goalId: goal.goalId,
        planVersionId: plan.planVersionId,
        planDigest: plan.digest,
        approvalRequestId: request.requestId,
      },
    });
    expect(captured.digest).toBe(policyDigest(captured.statement));
    expect(plan.commitment).toEqual(commitment);
    expect(JSON.parse(plan.bytes)).toEqual(commitment);
    expect(proposed.requests).toHaveLength(1);
    expect(proposed.goal!.activePlanVersionId).toBeNull();
    await expect(
      executeGoalOperation(
        'goal.plan.propose',
        {
          ...input,
          goalDomain: { ...goalDomain, scope: { ...goalDomain.scope, actions: ['tool.grant'] } },
        },
        context,
        store,
        db
      )
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    const preview = projectApprovalEffect({ record: request, store, actor: context.actor });
    expect(preview.status).toBe('available');
    if (preview.status !== 'available') throw new Error('Exact approval preview is unavailable.');
    expect(JSON.parse(preview.detail)).toMatchObject({
      bytes: plan.bytes,
      digest: plan.digest,
      goalDomain: captured,
    });
    const reopened = new FsStore({ dataRoot: root });
    expect(
      projectApprovalEffect({
        record: readPendingRequest(db.sqlite, request.requestId)!,
        store: reopened,
        actor: context.actor,
      })
    ).toEqual(preview);
  } finally {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
