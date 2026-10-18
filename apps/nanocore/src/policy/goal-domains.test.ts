import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { FsStore } from '../lib/store.js';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createGoalDomainPolicyService, type GoalDomainStatement } from './goal-domains.js';
import { listServerPermissionDecisions } from './permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from './statements.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Real capture and Goal/Pending commits exercise the service; full preview and product joins have separate Goal-owner regressions. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-domain-policy-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Joint Goal approval');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  cleanup.push(() => {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  const path = join(dataRoot, 'config/server.jsonc');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId,
    workspaceIds: [workspace.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const reload = vi.fn(() => manager.reload({ mode: 'safe', dryRun: false }));
  const service = () =>
    createGoalDomainPolicyService({
      coreDb,
      store,
      files,
      reload,
      currentPolicy: () => manager.current().openKitConfig.policy?.mediation,
      repositoryWorkspaceDb: () => db,
    });
  const created = await executeGoalOperation(
    'goal.create',
    { workspaceId: workspace.id, requestId: randomUUID(), intent: 'Produce a reviewed design' },
    { actor },
    store,
    db,
    { coreDb }
  );
  const key = { workspaceId: workspace.id, goalId: created.goal!.goalId };
  const goalScope = { ...key, threadId: created.goal!.threadId };
  const turn = store.createTurn(
    workspace.id,
    goalScope.threadId,
    'Coordinate',
    { kind: 'user', id: userId },
    null,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const coordinator = { actor, coordinatorTurnId: turn.id };
  const cardView = await executeGoalOperation(
    'goal.card.create',
    { ...goalScope, requestId: randomUUID(), description: 'Review the design', priority: 1 },
    { actor },
    store,
    db,
    { coreDb }
  );
  const card = cardView.cards[0]!;
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...goalScope,
      requestId: randomUUID(),
      expectedRevision: cardView.goal!.changeRevision,
      goalDomain: {
        id: 'design-goal-domain',
        scope: {
          subjects: [{ kind: 'agent', id: 'design-worker' }],
          actions: ['tool.use'],
          resources: [
            { kind: 'mcp-tool', workspaceId: workspace.id, serverId: 'issues', toolName: 'read' },
          ],
        },
        lifetime: {
          anchor: {
            owner: { kind: 'workspace', workspaceId: workspace.id },
            kind: 'goal',
            id: key.goalId,
          },
        },
      },
      commitment: {
        intentBasis: { revision: 0, intent: created.goal!.intent },
        cards: [{ cardId: card.cardId, revision: 0, description: card.description, priority: 1 }],
        permittedAdjustments: 'Refine the design',
        completionEvidence: ['Reviewed design'],
        boundaries: 'No deployment',
      },
    },
    coordinator,
    store,
    db,
    { coreDb }
  );
  const plan = proposed.versions.at(-1)!;
  const request = readPendingRequest(db.sqlite, plan.pendingRequestId)!;
  const { statement } = request.governedIntent!.goalDomain as { statement: GoalDomainStatement };
  async function approve() {
    await executeGoalOperation(
      'goal.plan.approve',
      {
        ...goalScope,
        requestId: randomUUID(),
        pendingRequestId: request.requestId,
        decision: 'granted',
      },
      { actor },
      store,
      db,
      { coreDb }
    );
  }
  async function consume() {
    await executeGoalOperation(
      'goal.plan.approve',
      {
        ...goalScope,
        requestId: randomUUID(),
        pendingRequestId: request.requestId,
        decision: 'granted',
      },
      coordinator,
      store,
      db,
      { coreDb }
    );
  }
  function activate() {
    return service().activate({
      workspaceId: workspace.id,
      requestId: request.requestId,
      expectedPolicyRevision: policyDigest(
        manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT
      ),
    });
  }
  return {
    coreDb,
    db,
    store,
    manager,
    files,
    reload,
    path,
    key,
    actor,
    plan,
    statement,
    request,
    service,
    approve,
    consume,
    activate,
  };
}

describe('jointly approved Goal-domain publication', () => {
  it('publishes from one completed request without a separate Policy apply and survives reopen', async () => {
    const f = await fixture();
    await f.approve();
    await f.consume();
    expect(f.service().read(f.key)).toBeNull();
    const result = f.activate();
    const request = readPendingRequest(f.db.sqlite, f.request.requestId)!;
    expect(result.statement).toEqual({
      ...f.statement,
      state: 'active',
      authoredAt: request.decidedAt,
    });
    expect(f.service().read(f.key)).toEqual(result.statement);
    expect(f.db.sqlite.transaction(() => f.service().read(f.key))()).toEqual(result.statement);
    const count = listServerPermissionDecisions(f.coreDb).length;
    expect(f.activate()).toEqual(result);
    expect(listServerPermissionDecisions(f.coreDb)).toHaveLength(count);
    expect(listServerPermissionDecisions(f.coreDb).at(-1)).toMatchObject({
      result: 'allow',
      contextSummary: {
        operation: 'policy.write',
        cause: 'goal-domain.activate',
        requestId: f.request.requestId,
        responsibleUserId: f.actor.userId,
      },
      mediation: {
        subject: { principal: { kind: 'human', id: f.actor.userId } },
        kernel: { effect: 'allow' },
      },
    });
    expect(listServerAuditEvents(f.coreDb).some((event) => event.permissionDecisionId)).toBe(true);
  });

  it('refuses an unfinished grant, in-flight transaction, changed Policy or changed capture before writing', async () => {
    const f = await fixture();
    const original = readFileSync(f.path, 'utf8');
    await f.approve();
    expect(() => f.activate()).toThrow(/completed joint human approval/);
    await f.consume();
    expect(() => f.db.sqlite.transaction(() => f.activate())()).toThrow(
      /committed Goal transaction/
    );
    expect(() =>
      f.service().activate({
        workspaceId: f.key.workspaceId,
        requestId: f.request.requestId,
        expectedPolicyRevision: `sha256:${'0'.repeat(64)}`,
      })
    ).toThrow(/revision changed/);
    const current = readPendingRequest(f.db.sqlite, f.request.requestId)!;
    f.db.sqlite
      .prepare('UPDATE pending_requests SET governed_intent_json=? WHERE request_id=?')
      .run(
        JSON.stringify({
          ...current.governedIntent,
          goalDomain: {
            statement: {
              ...f.statement,
              scope: { ...f.statement.scope, actions: ['workspace.write'] },
            },
            digest: policyDigest(f.statement),
          },
        }),
        f.request.requestId
      );
    expect(() => f.activate()).toThrow(/completed joint human approval/);
    expect(readFileSync(f.path, 'utf8')).toBe(original);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('supplies no domain after the approving human loses authority', async () => {
    const f = await fixture();
    await f.approve();
    await f.consume();
    f.activate();
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.actor.userId))();
    expect(f.service().read(f.key)).toBeNull();
    expect(() => f.activate()).toThrow(/credential.*no longer authorized/);
    expect(f.service().close(f.key).changed).toBe(true);
    expect(f.service().read(f.key)).toBeNull();
  });

  it('withdraws a Goal without its old Plan being current and does not republish on replay', async () => {
    const f = await fixture();
    await f.approve();
    await f.consume();
    f.activate();
    expect(f.service().close({ ...f.key, goalId: 'another-goal' }).changed).toBe(false);
    expect(f.service().close(f.key).changed).toBe(true);
    expect(f.service().read(f.key)).toBeNull();
    expect(f.service().close(f.key).changed).toBe(false);
    expect(() => f.activate()).toThrow(/inactive or changed/);
  });

  it('rechecks the approving credential after configuration validation before publication', async () => {
    const f = await fixture();
    await f.approve();
    await f.consume();
    const before = readFileSync(f.path, 'utf8');
    const validate = f.files.validate.bind(f.files);
    vi.spyOn(f.files, 'validate').mockImplementationOnce((input) => {
      const result = validate(input);
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.actor.userId))();
      return result;
    });
    expect(() => f.activate()).toThrow(/credential.*no longer authorized/);
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('ends authority on Goal closure before the separate Policy withdrawal', async () => {
    const f = await fixture();
    await f.approve();
    await f.consume();
    f.activate();
    const scope = { ...f.key, threadId: f.request.threadId };
    const view = await executeGoalOperation('goal.read', scope, { actor: f.actor }, f.store, f.db, {
      coreDb: f.coreDb,
    });
    await executeGoalOperation(
      'goal.cancel',
      {
        ...scope,
        requestId: randomUUID(),
        expectedRevision: view.goal!.changeRevision,
        reason: 'Stop this Goal',
      },
      { actor: f.actor },
      f.store,
      f.db,
      { coreDb: f.coreDb }
    );
    expect(f.service().read(f.key)).toBeNull();
    expect(f.service().close(f.key).changed).toBe(true);
    expect(() => f.activate()).toThrow(/obsolete or closed/);
  });

  it('keeps an unavailable Workspace read distinct from an absent grant', async () => {
    const f = await fixture();
    await f.approve();
    await f.consume();
    f.activate();
    const prepare = vi.spyOn(f.db.sqlite, 'prepare').mockImplementationOnce(() => {
      throw new Error('Injected Workspace read failure');
    });
    expect(() => f.service().read(f.key)).toThrow('Injected Workspace read failure');
    prepare.mockRestore();
    expect(f.service().read(f.key)).not.toBeNull();
  });

  it('retains truthful saved versus loaded outcomes when reload fails', async () => {
    const f = await fixture();
    await f.approve();
    await f.consume();
    f.reload.mockImplementationOnce(() => {
      throw new Error('Injected reload failure');
    });
    expect(() => f.activate()).toThrow('Injected reload failure');
    expect(JSON.parse(readFileSync(f.path, 'utf8')).policy.mediation.statements[0].state).toBe(
      'active'
    );
    expect(() => f.service().read(f.key)).toThrow(/file and loaded revision differ/);
    f.manager.reload({ mode: 'safe', dryRun: false });
    expect(f.service().read(f.key)).not.toBeNull();
    const original = readFileSync(f.path, 'utf8');
    const update = vi.spyOn(f.files, 'updateFile').mockImplementationOnce(() => {
      throw new Error('Injected CAS conflict');
    });
    expect(() => f.service().close(f.key)).toThrow('Injected CAS conflict');
    expect(readFileSync(f.path, 'utf8')).toBe(original);
    expect(f.service().read(f.key)).not.toBeNull();
    update.mockRestore();
  });
});
