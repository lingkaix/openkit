import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Actor } from '../auth/identity.js';
import { ensureLocalUser } from '../auth/identity.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { createGoalDomainPolicyService } from '../policy/goal-domains.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { projectApprovalEffect } from './pending-request-disclosure.js';
import { readPendingRequest } from './pending-requests.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** Real capture, human decision, Goal commit and config writer; no seeded approval or Policy. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-domain-join-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor: Actor = { kind: 'local', userId };
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Joint domain publication');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  cleanup.push(() => disposeTestStore(dataRoot, db, coreDb));
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  const configPath = join(dataRoot, 'config/server.jsonc');
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot });
  const reload = vi.fn(async () => await manager.reload({ mode: 'safe', dryRun: false }));
  const forActor = (current: Actor) =>
    createGoalDomainPolicyService({
      coreDb,
      store,
      repositoryWorkspaceDb: () => db,
      files: new RuntimeConfigFileService({
        dataRoot,
        userId: current.userId,
        workspaceIds: [workspace.id],
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      }),
      currentPolicy: () => manager.current().openKitConfig.policy?.mediation,
      reload,
    });
  const wake = vi.fn(async () => undefined);
  const services = {
    coreDb,
    wake,
    goalDomain: {
      forActor,
      currentRevision: () =>
        policyDigest(manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT),
    },
  };
  const created = await executeGoalOperation(
    'goal.create',
    {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      intent: 'Review an application',
    },
    { actor },
    store,
    db,
    services
  );
  const goal = created.goal!;
  const scope = { workspaceId: workspace.id, goalId: goal.goalId, threadId: goal.threadId };
  const turn = await store.createTurn(
    workspace.id,
    goal.threadId,
    'Coordinate',
    { kind: 'user', id: userId },
    null,
    {
      executorKind: 'coordinator',
      agentId: 'goal-coordinator',
    }
  );
  const coordinator = { actor, coordinatorTurnId: turn.id };
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: goal.changeRevision,
      commitment: {
        intentBasis: { revision: 0, intent: goal.intent },
        cards: [],
        permittedAdjustments: 'Read only',
        completionEvidence: ['Reviewed application'],
        boundaries: 'No send',
      },
      goalDomain: {
        id: 'application-domain',
        scope: {
          subjects: [{ kind: 'agent', id: 'application-worker' }],
          actions: ['tool.use'],
          resources: [
            {
              kind: 'mcp-tool',
              workspaceId: workspace.id,
              serverId: 'sis',
              toolName: 'application.read',
            },
          ],
        },
        lifetime: {
          anchor: {
            owner: { kind: 'workspace', workspaceId: workspace.id },
            kind: 'goal',
            id: goal.goalId,
          },
        },
      },
    },
    coordinator,
    store,
    db,
    services
  );
  const plan = proposed.versions[0]!;
  const approval = {
    ...scope,
    pendingRequestId: plan.pendingRequestId,
    decision: 'granted' as const,
  };
  const request = readPendingRequest(db.sqlite, plan.pendingRequestId)!;
  const preview = projectApprovalEffect({ record: request, store, actor });
  expect(preview.status).toBe('available');
  if (preview.status !== 'available') throw new Error('Joint preview unavailable.');
  expect(JSON.parse(preview.detail).goalDomain).toEqual(request.governedIntent!.goalDomain);
  await executeGoalOperation(
    'goal.plan.approve',
    { ...approval, requestId: randomUUID() },
    { actor },
    store,
    db,
    services
  );
  expect(forActor(actor).read(scope)).toBeNull();
  const consume = (requestId = randomUUID()) =>
    executeGoalOperation(
      'goal.plan.approve',
      { ...approval, requestId },
      coordinator,
      store,
      db,
      services
    );
  return {
    actor,
    coreDb,
    wake,
    scope,
    db,
    store,
    services,
    manager,
    reload,
    forActor,
    consume,
    plan,
    configPath,
  };
}

it('publishes the jointly previewed domain only after the Goal commit and withdraws it on cancel', async () => {
  const f = await fixture();
  const result = await f.consume();
  const statement = f.forActor(f.actor).read(f.scope);
  expect(statement).toMatchObject({
    state: 'active',
    source: {
      workspaceId: f.scope.workspaceId,
      goalId: f.scope.goalId,
      planVersionId: f.plan.planVersionId,
      approvalRequestId: f.plan.pendingRequestId,
    },
  });
  expect(result.goal!.activePlanVersionId).toBe(f.plan.planVersionId);
  expect(readPendingRequest(f.db.sqlite, f.plan.pendingRequestId)).toMatchObject({
    claim: 'finished',
    disposition: 'approved-executed',
  });
  const config = readFileSync(f.configPath, 'utf8');
  await f.consume();
  expect(readFileSync(f.configPath, 'utf8')).toBe(config);
  expect(f.reload).toHaveBeenCalledTimes(1);
  await executeGoalOperation(
    'goal.cancel',
    {
      ...f.scope,
      requestId: randomUUID(),
      expectedRevision: readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision,
      reason: 'Stop',
    },
    { actor: f.actor },
    f.store,
    f.db,
    f.services
  );
  expect(f.forActor(f.actor).read(f.scope)).toBeNull();
  expect(JSON.parse(readFileSync(f.configPath, 'utf8')).policy.mediation.statements[0].state).toBe(
    'inactive'
  );
});

it('keeps failed publication non-authorizing and retries from the completed request without consuming it again', async () => {
  const f = await fixture();
  f.reload.mockImplementationOnce(() => {
    throw new Error('Injected reload failure');
  });
  await expect(f.consume()).rejects.toThrow('Injected reload failure');
  const request = readPendingRequest(f.db.sqlite, f.plan.pendingRequestId)!;
  expect(request).toMatchObject({ claim: 'finished', disposition: 'approved-executed' });
  expect(readGoalView(f.store, f.db, f.scope.goalId).goal!.activePlanVersionId).toBe(
    f.plan.planVersionId
  );
  expect(() => f.forActor(f.actor).read(f.scope)).toThrow(/loaded revision differ/);
  await f.manager.reload({ mode: 'safe', dryRun: false });
  const revision = readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision;
  await f.consume();
  expect(f.forActor(f.actor).read(f.scope)).toMatchObject({ state: 'active' });
  expect(readPendingRequest(f.db.sqlite, f.plan.pendingRequestId)).toEqual(request);
  expect(readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision).toBe(revision);
});

it('retains the committed Goal, finished Pending and original receipt when Core Policy publication refuses and performs no wake', async () => {
  const f = await fixture();
  const original = readFileSync(f.configPath, 'utf8');
  const wakes = f.wake.mock.calls.length;
  const requestId = randomUUID();
  // Deliberate post-setup SQL fault at the real Core publication crossing. Goal writes stay writable.
  f.coreDb.sqlite.exec(`
    CREATE TRIGGER refuse_goal_policy_publication BEFORE INSERT ON permission_decisions
    WHEN NEW.owner_scope = 'server'
      AND json_extract(NEW.mediation_json, '$.operation') = 'policy.write'
      AND json_extract(NEW.mediation_json, '$.stage') = 'decide'
      AND json_extract(NEW.context_summary_json, '$.cause') = 'goal-domain.activate'
    BEGIN SELECT RAISE(ABORT, 'synthetic Goal Core publication refusal'); END;
  `);
  await expect(f.consume(requestId)).rejects.toMatchObject({
    code: 'goal_domain_publication_failed',
  });
  const request = readPendingRequest(f.db.sqlite, f.plan.pendingRequestId)!;
  expect(request).toMatchObject({ claim: 'finished', disposition: 'approved-executed' });
  expect(readGoalView(f.store, f.db, f.scope.goalId).goal!.activePlanVersionId).toBe(
    f.plan.planVersionId
  );
  const receipt = f.store.getCommandRequest('goal.plan.approve', requestId, {
    actorId: f.actor.userId,
    workspaceId: f.scope.workspaceId,
    threadId: f.scope.threadId,
  });
  expect(receipt).not.toBeNull();
  expect(receipt).toMatchObject({ response: { kind: 'goal', id: f.scope.goalId } });
  expect(readFileSync(f.configPath, 'utf8')).toBe(original);
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.wake).toHaveBeenCalledTimes(wakes);
  expect(f.forActor(f.actor).read(f.scope)).toBeNull();
  expect(listServerPermissionDecisions(f.coreDb)).toEqual([]);
  const revision = readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision;
  // Remove only the deliberate fault, then explicitly retry the same recorded command.
  // Success distinguishes that crossing fault from a missing native form or fixture setup failure.
  f.coreDb.sqlite.exec('DROP TRIGGER refuse_goal_policy_publication');
  await f.consume(requestId);
  expect(
    f.store.getCommandRequest('goal.plan.approve', requestId, {
      actorId: f.actor.userId,
      workspaceId: f.scope.workspaceId,
      threadId: f.scope.threadId,
    })
  ).toEqual(receipt);
  expect(readPendingRequest(f.db.sqlite, f.plan.pendingRequestId)).toEqual(request);
  expect(readGoalView(f.store, f.db, f.scope.goalId).goal!.changeRevision).toBe(revision);
  expect(f.forActor(f.actor).read(f.scope)).toMatchObject({ state: 'active' });
  expect(listServerPermissionDecisions(f.coreDb)).toHaveLength(1);
  expect(f.wake).toHaveBeenCalledTimes(wakes + 1);
});
