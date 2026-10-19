import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAccess } from '@openkit/policy-kernel';
import { allocateEntityId, deriveEntityId, PolicyPermissionV1Schema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { FsStore } from '../lib/store.js';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { reserveGoalTask } from '../runtime/goal-task-admission.js';
import { readGoalTaskPolicyContext } from '../runtime/goal-task-policy-context.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { upsertWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import {
  createSchedulerAdmissionEntry,
  type SchedulerExecutionLineage,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { withHumanMcpApproval } from '../test-support/mcp-tool-policy.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createGoalDomainPolicyService } from './goal-domains.js';
import { createGoalTaskPolicyService } from './goal-task-policy.js';
import { PolicyInterception } from './interception.js';
import {
  listServerPermissionDecisions,
  readPolicyStatementUseCount,
} from './permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from './statements.js';
import { evaluateWorkspaceMemberAccess } from './workspace-access.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) close();
});

type Permission = ReturnType<typeof PolicyPermissionV1Schema.parse>;
/** The agreed native seam is optional only so baseline collection can prove its absence. */
type Administer = (input: {
  workspaceDb: WorkspaceDb;
  goalId: string;
  coordinatorTurnId: string;
  taskLineage: SchedulerExecutionLineage;
  expectedPolicyRevision: string;
  grant: {
    id: string;
    scope: Permission['scope'];
    lifetime: Permission['lifetime'];
    rationale: string;
  };
}) => { statement: Permission; policyRevision: string };

/** Real joint approval, linked Task and prepared scheduler package; no backend execution is claimed. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-domain-admin-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Bounded Goal administration');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(root, workspace.id);
  cleanups.push(() => {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'config'), { recursive: true });
  const path = join(root, 'config/server.jsonc');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot: root });
  const files = new RuntimeConfigFileService({
    dataRoot: root,
    userId,
    workspaceIds: [workspace.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const reload = vi.fn(() => manager.reload({ mode: 'safe', dryRun: false }));
  const domains = createGoalDomainPolicyService({
    coreDb,
    store,
    files,
    reload,
    currentPolicy: () => manager.current().openKitConfig.policy?.mediation,
    repositoryWorkspaceDb: () => db,
  });
  const human = { actor };
  const goal = (
    await executeGoalOperation(
      'goal.create',
      {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        intent: 'Review an issue',
      },
      human,
      store,
      db,
      { coreDb }
    )
  ).goal!;
  const scope = { workspaceId: workspace.id, threadId: goal.threadId, goalId: goal.goalId };
  const coordinatorTurn = store.createTurn(
    workspace.id,
    goal.threadId,
    'Coordinate',
    { kind: 'user', id: userId },
    null,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const coordinator = { actor, coordinatorTurnId: coordinatorTurn.id };
  const cards = await executeGoalOperation(
    'goal.card.create',
    {
      ...scope,
      requestId: randomUUID(),
      description: 'Review issue',
      priority: 1,
    },
    human,
    store,
    db,
    { coreDb }
  );
  const card = cards.cards[0]!;
  const resource = {
    kind: 'mcp-tool' as const,
    workspaceId: workspace.id,
    serverId: 'issues',
    toolName: 'read',
  };
  const domainExpiry = new Date(Date.now() + 3_600_000).toISOString();
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: cards.goal!.changeRevision,
      goalDomain: {
        id: 'issue-goal-domain',
        scope: {
          subjects: [{ kind: 'agent', id: 'issue-worker' }],
          actions: ['tool.use'],
          resources: [resource],
        },
        lifetime: {
          anchor: {
            owner: { kind: 'workspace', workspaceId: workspace.id },
            kind: 'goal',
            id: goal.goalId,
          },
          notAfter: domainExpiry,
        },
      },
      commitment: {
        intentBasis: { revision: 0, intent: goal.intent },
        cards: [{ cardId: card.cardId, revision: 0, description: card.description, priority: 1 }],
        permittedAdjustments: 'Refine the review',
        completionEvidence: ['Reviewed issue'],
        boundaries: 'No deployment',
      },
    },
    coordinator,
    store,
    db,
    { coreDb }
  );
  const plan = proposed.versions[0]!;
  for (const context of [human, coordinator])
    await executeGoalOperation(
      'goal.plan.approve',
      {
        ...scope,
        requestId: randomUUID(),
        pendingRequestId: plan.pendingRequestId,
        decision: 'granted',
      },
      context,
      store,
      db,
      { coreDb }
    );
  const activation = domains.activate({
    workspaceId: workspace.id,
    requestId: plan.pendingRequestId,
    expectedPolicyRevision: policyDigest(EMPTY_POLICY_DOCUMENT),
  });

  const requestId = randomUUID();
  const thread = store.createThread(
    workspace.id,
    'Issue review',
    deriveEntityId('th', ['task', requestId]),
    'conversation',
    { visibility: 'workspace', threadSource: 'worker' }
  );
  db.sqlite.transaction(() =>
    reserveGoalTask(
      store,
      db,
      {
        goalId: goal.goalId,
        cardId: card.cardId,
        planVersionId: plan.planVersionId,
        cardRevision: 0,
        intentRevision: 0,
        withinCurrentIntent: true,
        withinPermittedAdjustments: true,
        rationale: 'Review the issue',
      },
      thread.id
    )
  )();
  // Missing typed Task resources is the real safe gap; the immutable request must remain unchanged.
  const request = createStructuredWorkerDelegationRequest({
    objective: 'Review issue',
    acceptanceCriteria: ['Review complete'],
    contextRefs: [
      { kind: 'workspace', id: workspace.id },
      { kind: 'thread', id: thread.id },
    ],
    resources: [],
    expectedArtifacts: [],
    constraints: { maxContextTokens: 12_000, maxWorkerIterations: 1 },
    verification: [{ kind: 'manual', description: 'Inspect review' }],
    reviewPolicy: { required: false, reviewers: ['human'], instructions: 'Inspect review' },
    escalationConditions: [],
    reviewContext: null,
  });
  const turnInput = serializeStructuredWorkerDelegationRequest(request);
  const agentSessionId = allocateEntityId('as');
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    turnInput,
    { kind: 'user', id: userId },
    null,
    {
      executorKind: 'worker',
      agentId: 'issue-worker',
      agentSessionId,
      turnId: deriveEntityId('tu', {
        command: 'task.start',
        actorId: userId,
        workspaceId: workspace.id,
        threadId: thread.id,
        requestId,
      }),
    }
  );
  store.createItem({
    id: deriveEntityId('it', ['task-user', turn.id]),
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor: turn.triggerActor,
    text: turnInput,
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${requestId}`,
    requestId,
    triggerActor: turn.triggerActor,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    turnInput,
    requestedAgentId: 'issue-worker',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: allocateEntityId('attempt'),
    agentSessionId,
    inputRef: 'issue-package',
    bindingRef: `issue-binding:${requestId}`,
    sessionCompatibilityKey: 'issue-review',
    now: () => new Date().toISOString(),
  });
  upsertWorkerCheckpoint(db, {
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    requestId,
    requestInputHash: commandInputHash({ input: turnInput }),
    stage: 'running_worker',
    iteration: 0,
    workerSessionId: agentSessionId,
    contextDigest: commandInputHash(request),
  });
  const taskLineage: SchedulerExecutionLineage = {
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    agentSessionId,
    packageSnapshotId: 'issue-package',
  };
  const subject = {
    principal: { kind: 'agent' as const, id: 'issue-worker' },
    onBehalfOf: null,
    actor: { kind: 'agent' as const, id: 'issue-worker', responsibleUserId: userId },
    process: { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id },
    credentialKind: 'worker-package' as const,
    responsibleHumanId: userId,
  };
  const tasks = createGoalTaskPolicyService({ coreDb, store, domains });
  const effect = {
    workspaceDb: db,
    lineage: taskLineage,
    subject,
    operation: 'tool.use',
    resource,
    humanKernel: evaluateWorkspaceMemberAccess({ operation: 'tool.use' }),
  };
  const grant: Parameters<Administer>[0]['grant'] = {
    id: 'issue-task-extension',
    scope: { subjects: [subject.principal], actions: ['tool.use'], resources: [resource] },
    lifetime: {
      anchor: {
        owner: { kind: 'workspace', workspaceId: workspace.id },
        kind: 'thread',
        id: thread.id,
      },
      notAfter: new Date(Date.now() + 1_800_000).toISOString(),
    },
    rationale: 'Allow the assigned Worker to read this issue for its review',
  };
  const input: Parameters<Administer>[0] = {
    workspaceDb: db,
    goalId: goal.goalId,
    coordinatorTurnId: coordinatorTurn.id,
    taskLineage,
    expectedPolicyRevision: activation.policyRevision,
    grant,
  };
  const context = () => readGoalTaskPolicyContext({ coreDb, store, db, lineage: taskLineage });
  function administer(changes: Partial<Parameters<Administer>[0]> = {}) {
    const callable = (domains as typeof domains & { administer?: Administer }).administer;
    expect(
      callable,
      'GoalDomainPolicyService must expose the native bounded administer writer'
    ).toBeTypeOf('function');
    return callable!({ ...input, ...changes });
  }
  function pipeline() {
    const evaluation = tasks.evaluateTask(effect)!;
    return {
      workspaceDb: db,
      document: manager.current().openKitConfig.policy!.mediation!,
      proposal: {
        operation: 'mcp.call-tool' as const,
        workspaceId: workspace.id,
        serverId: 'issues',
        toolName: 'read',
        argumentsDigest: policyDigest({ issue: 1 }),
        schemaDigest: null,
        capabilityCallId: allocateEntityId('cap'),
        packageDigest: 'issue-package',
        catalogRevision: 'issue-catalog',
        subject,
      },
      authorizationRevision: evaluation.authorizationRevision,
      authorizationUses: evaluation.authorizationUses,
      authorCurrent: () => domains.read(scope) !== null,
      anchorCurrent: () =>
        domains.read(scope) !== null && store.getTurnById(turn.id).status === 'running',
      participantAuthorized: () => false,
      stillCurrent: () =>
        tasks.evaluateTask(effect)?.authorizationRevision === evaluation.authorizationRevision,
      finalKernel: () => tasks.evaluateTask(effect)!.kernel,
    };
  }
  return {
    coreDb,
    db,
    store,
    manager,
    files,
    path,
    reload,
    domains,
    tasks,
    effect,
    grant,
    input,
    scope,
    plan,
    context,
    activation,
    actor,
    coordinatorTurn,
    turn,
    administer,
    pipeline,
    domainExpiry,
  };
}

/** A real Kernel prohibition supplies an independent mandatory human-deny decision. */
function prohibitedHumanKernel() {
  return evaluateAccess(
    {
      elements: [
        { id: 'human', kind: 'user' },
        { id: 'ua', kind: 'userAttribute' },
        { id: 'tool', kind: 'object' },
        { id: 'oa', kind: 'objectAttribute' },
        { id: 'pc', kind: 'policyClass' },
      ],
      assignments: [
        { child: 'human', parent: 'ua' },
        { child: 'ua', parent: 'pc' },
        { child: 'tool', parent: 'oa' },
        { child: 'oa', parent: 'pc' },
      ],
      operations: [{ id: 'tool.use', accessRights: ['tool-use'] }],
      associations: [
        {
          id: 'human-tool',
          userAttribute: 'ua',
          targetAttribute: 'oa',
          accessRights: ['tool-use'],
        },
      ],
      prohibitions: [
        {
          id: 'human-prohibition',
          kind: 'user',
          subject: 'human',
          accessRights: ['tool-use'],
          range: { type: 'disjunctive', include: ['oa'] },
        },
      ],
    },
    { user: 'human', operation: 'tool.use', target: 'tool' }
  );
}

describe('bounded native Goal-domain administration', () => {
  it('establishes completed real approval and exact Task lineage before testing the writer', async () => {
    const f = await fixture();
    expect(readPendingRequest(f.db.sqlite, f.plan.pendingRequestId)).toMatchObject({
      state: 'resolved',
      resolution: 'granted',
      claim: 'finished',
      disposition: 'approved-executed',
      decidingActorContext: f.actor,
    });
    expect(f.domains.read(f.scope)).toEqual(f.activation.statement);
    expect(f.context()).toMatchObject({
      goalId: f.scope.goalId,
      agentId: 'issue-worker',
      resources: [],
      turnId: f.turn.id,
      taskThreadId: f.turn.threadId,
      responsibleUserId: f.actor.userId,
    });
    expect(f.coordinatorTurn.id).not.toBe(f.input.taskLineage.turnId);
    expect(f.store.getTurnById(f.coordinatorTurn.id).status).toBe('running');
    expect(f.store.getTurnExecutor(f.coordinatorTurn.id)).toBe('coordinator');
    const missing = f.tasks.evaluateTask(f.effect)!;
    expect(missing.inGoalEnvelope).toBe(true);
    expect(missing.kernel.effect).toBe('deny');
    expect(missing.kernel.reasons[0]?.code).toBe('missing-privilege');
  });

  it('publishes one agent-authored delegated allow through native CAS, reload, decision and Audit', async () => {
    const f = await fixture();
    const before = f.tasks.evaluateTask(f.effect)!;
    const writes = vi.spyOn(f.files, 'updateFile');
    const decisionCount = listServerPermissionDecisions(f.coreDb).length;
    const result = f.administer();
    expect(result.statement).toMatchObject({
      id: f.grant.id,
      kind: 'permission',
      state: 'active',
      effect: 'allow',
      grant: { kind: 'ordinary' },
      author: { kind: 'agent', id: 'goal-coordinator' },
      authority: {
        kind: 'delegation',
        statement: { id: f.activation.statement.id, digest: policyDigest(f.activation.statement) },
      },
      scope: f.grant.scope,
      lifetime: f.grant.lifetime,
    });
    expect(PolicyPermissionV1Schema.parse(result.statement)).toEqual(result.statement);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[0]).toMatchObject({
      id: 'server.jsonc',
      expectedRevision: expect.any(String),
    });
    expect(f.reload).toHaveBeenCalledTimes(2);
    const current = f.manager.current().openKitConfig.policy!.mediation!;
    expect(result.policyRevision).toBe(policyDigest(current));
    expect(current.statements).toContainEqual(result.statement);
    expect(current.statements).toContainEqual(f.activation.statement);
    const decisions = listServerPermissionDecisions(f.coreDb);
    expect(decisions).toHaveLength(decisionCount + 1);
    expect(decisions.at(-1)).toMatchObject({
      result: 'allow',
      contextSummary: { operation: 'policy.write' },
      mediation: {
        subject: {
          principal: { kind: 'agent', id: 'goal-coordinator' },
          responsibleHumanId: f.actor.userId,
        },
        kernel: { effect: 'allow' },
      },
    });
    expect(
      listServerAuditEvents(f.coreDb).find(
        (event) => event.permissionDecisionId === decisions.at(-1)!.decisionId
      )
    ).toMatchObject({
      actor: { kind: 'agent', id: 'goal-coordinator', responsibleUserId: f.actor.userId },
    });
    const after = f.tasks.evaluateTask(f.effect)!;
    expect(after.kernel.effect).toBe('allow');
    expect(after.authorizationRevision).not.toBe(before.authorizationRevision);
    expect(after.kernel.trace.matchedAssociations).toContain('goal-envelope');
    expect(f.context()!.resources).toEqual([]);
    expect(() => f.administer()).toThrow(/revision|stale/i);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('refuses scope, lifetime, identity and stale-revision widening before a file effect', async () => {
    const f = await fixture();
    // Check availability outside toThrow: an absent method must never pass a refusal oracle.
    expect((f.domains as typeof f.domains & { administer?: Administer }).administer).toBeTypeOf(
      'function'
    );
    const original = readFileSync(f.path, 'utf8');
    const writes = vi.spyOn(f.files, 'updateFile');
    const reloads = f.reload.mock.calls.length;
    const variants: Partial<Parameters<Administer>[0]>[] = [
      { expectedPolicyRevision: `sha256:${'0'.repeat(64)}` },
      { coordinatorTurnId: f.turn.id },
      {
        grant: {
          ...f.grant,
          scope: { ...f.grant.scope, subjects: [{ kind: 'agent', id: 'goal-coordinator' }] },
        },
      },
      {
        grant: {
          ...f.grant,
          scope: { ...f.grant.scope, resources: [{ ...f.effect.resource, toolName: 'delete' }] },
        },
      },
      { grant: { ...f.grant, scope: { ...f.grant.scope, actions: ['workspace.write'] } } },
      {
        grant: {
          ...f.grant,
          lifetime: {
            ...f.grant.lifetime,
            notAfter: new Date(Date.parse(f.domainExpiry) + 1).toISOString(),
          },
        },
      },
      {
        grant: { ...f.grant, lifetime: { ...f.grant.lifetime, notAfter: '2000-01-01T00:00:00Z' } },
      },
      {
        grant: {
          ...f.grant,
          lifetime: { anchor: { owner: { kind: 'server' }, kind: 'server', id: 'server' } },
        },
      },
    ];
    for (const variant of variants) {
      expect(() => f.administer(variant)).toThrow();
      expect(readFileSync(f.path, 'utf8')).toBe(original);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(f.reload).toHaveBeenCalledTimes(reloads);
  });

  it.each([
    'ended-coordinator',
    'missing-credential',
    'disabled-human',
    'withdrawn-domain',
  ] as const)('refuses current authority loss: %s', async (reason) => {
    const f = await fixture();
    expect((f.domains as typeof f.domains & { administer?: Administer }).administer).toBeTypeOf(
      'function'
    );
    if (reason === 'ended-coordinator')
      f.store.updateTurn(f.coordinatorTurn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    if (reason === 'missing-credential')
      f.db.sqlite
        .prepare('UPDATE pending_requests SET deciding_actor_context_json=NULL WHERE request_id=?')
        .run(f.plan.pendingRequestId);
    if (reason === 'disabled-human')
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.actor.userId))();
    if (reason === 'withdrawn-domain') f.domains.close(f.scope);
    const original = readFileSync(f.path, 'utf8');
    const writes = vi.spyOn(f.files, 'updateFile');
    const reloads = f.reload.mock.calls.length;
    expect(() =>
      f.administer({
        expectedPolicyRevision: policyDigest(f.manager.current().openKitConfig.policy!.mediation!),
      })
    ).toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe(original);
    expect(writes).not.toHaveBeenCalled();
    expect(f.reload).toHaveBeenCalledTimes(reloads);
  });

  it('rereads human authority after validation and preserves bytes on lost authority or CAS failure', async () => {
    const f = await fixture();
    expect((f.domains as typeof f.domains & { administer?: Administer }).administer).toBeTypeOf(
      'function'
    );
    const original = readFileSync(f.path, 'utf8');
    const write = vi.spyOn(f.files, 'updateFile').mockImplementationOnce(() => {
      throw new Error('Injected administration CAS conflict');
    });
    expect(() => f.administer()).toThrow('Injected administration CAS conflict');
    expect(write).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.path, 'utf8')).toBe(original);
    write.mockRestore();
    const validate = f.files.validate.bind(f.files);
    vi.spyOn(f.files, 'validate').mockImplementationOnce((input) => {
      const validation = validate(input);
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.actor.userId))();
      return validation;
    });
    const writes = vi.spyOn(f.files, 'updateFile');
    expect(() => f.administer()).toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe(original);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it('keeps root scope, the current human Kernel, prohibitions and a human-only gate mandatory', async () => {
    const f = await fixture();
    f.administer();
    expect(f.tasks.evaluateTask(f.effect)!.kernel.effect).toBe('allow');
    const outside = f.tasks.evaluateTask({
      ...f.effect,
      resource: { ...f.effect.resource, toolName: 'delete' },
    })!;
    expect(outside.inGoalEnvelope).toBe(false);
    expect(outside.kernel.effect).toBe('deny');
    const humanKernel = prohibitedHumanKernel();
    expect(humanKernel.effect).toBe('deny');
    expect(humanKernel.trace.matchedProhibitions).toContain('human-prohibition');
    expect(f.tasks.evaluateTask({ ...f.effect, humanKernel })!.kernel).toEqual(humanKernel);
    const decision = await new PolicyInterception().decide({
      ...f.pipeline(),
      document: withHumanMcpApproval(f.pipeline()),
    });
    expect(decision.result).toBe('require_approval');
    expect(f.tasks.evaluateTask(f.effect)!.kernel.effect).toBe('allow');
  });

  it('accounts finite grant use once and recognizes only the same final decision with linked Audit', async () => {
    const f = await fixture();
    const result = f.administer({
      grant: { ...f.grant, lifetime: { ...f.grant.lifetime, uses: 1 } },
    });
    const reference = { id: result.statement.id, digest: policyDigest(result.statement) };
    const evaluation = f.tasks.evaluateTask(f.effect)!;
    expect(evaluation.authorizationUses).toContainEqual({ statement: reference, limit: 1 });
    const pending = await new PolicyInterception().decide({
      ...f.pipeline(),
      document: withHumanMcpApproval(f.pipeline()),
    });
    expect(pending.result).toBe('require_approval');
    expect(readPolicyStatementUseCount(f.db, reference)).toBe(0);
    const decision = await new PolicyInterception().decide(f.pipeline());
    expect(decision.result).toBe('allow');
    expect(readPolicyStatementUseCount(f.db, reference)).toBe(1);
    expect(f.tasks.evaluateTask(f.effect)!.kernel.effect).toBe('deny');
    const current = f.tasks.readTaskDecision({ ...f.effect, decision })!;
    expect(current.kernel.effect).toBe('allow');
    expect(current.authorizationRevision).toBe(decision.authorizationRevision);
    expect(
      f.tasks.readTaskDecision({
        ...f.effect,
        decision: { ...decision, proposalDigest: policyDigest('different-effect') },
      })!.kernel.effect
    ).toBe('deny');
    f.db.sqlite
      .prepare('DELETE FROM audit_events WHERE permission_decision_id=?')
      .run(decision.decisionId);
    expect(f.tasks.readTaskDecision({ ...f.effect, decision })!.kernel.effect).toBe('deny');
    expect(readPolicyStatementUseCount(f.db, reference)).toBe(1);
  });

  it('ends grants on expiry and domain withdrawal and refuses a closed Worker context', async () => {
    const f = await fixture();
    f.administer({
      grant: {
        ...f.grant,
        lifetime: {
          anchor: {
            owner: { kind: 'workspace', workspaceId: f.scope.workspaceId },
            kind: 'turn',
            id: f.turn.id,
          },
          notAfter: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    expect(f.tasks.evaluateTask(f.effect)!.kernel.effect).toBe('allow');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    expect(f.tasks.evaluateTask(f.effect)!.kernel.effect).toBe('deny');
    clock.mockRestore();
    expect(f.tasks.evaluateTask(f.effect)!.kernel.effect).toBe('allow');
    f.domains.close(f.scope);
    expect(f.tasks.evaluateTask(f.effect)!.kernel.effect).toBe('deny');
    expect(f.domains.read(f.scope)).toBeNull();
    f.store.updateTurn(f.turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    expect(() => f.tasks.evaluateTask(f.effect)).toThrow(/current exact owner facts/);
  });
});
