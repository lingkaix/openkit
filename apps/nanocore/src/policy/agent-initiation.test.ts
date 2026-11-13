import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAccess, type PolicyState } from '@openkit/policy-kernel';
import { allocateEntityId, PolicySubjectV1Schema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateProductAuthorization } from '../auth/operation-authorizer.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createGoalDomainPolicyService } from './goal-domains.js';
import { evaluateGoalTaskAccess } from './goal-task-access.js';
import { PolicyInterception } from './interception.js';
import {
  EMPTY_POLICY_DOCUMENT,
  type PolicyProposal,
  policyDigest,
  preparePolicyDocument,
} from './statements.js';

const agentId = 'design-worker';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** Real storage and process setup; no Worker launch or scheduler admission is claimed. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e10-initiation-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = createTestStore({ dataRoot });
  let workspaceDb: ReturnType<typeof createTestWorkspaceDb> | undefined;
  cleanup.push(() => disposeTestStore(dataRoot, coreDb, ...(workspaceDb ? [workspaceDb] : [])));
  const workspace = await store.createWorkspace('Agent initiation policy unit');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  workspaceDb = createTestWorkspaceDb(dataRoot, workspace.id);
  const thread = await store.createThread(workspace.id, 'Bounded policy effect');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Read the admitted issue',
    { kind: 'user', id: userId },
    null,
    { executorKind: 'worker', agentId }
  );
  const resource = {
    kind: 'mcp-tool' as const,
    workspaceId: workspace.id,
    serverId: 'issues',
    toolName: 'read',
  };
  const subject = PolicySubjectV1Schema.parse({
    principal: { kind: 'agent', id: agentId },
    onBehalfOf: null,
    actor: { kind: 'agent', id: agentId, responsibleUserId: userId },
    process: { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id },
    credentialKind: 'worker-package',
    responsibleHumanId: userId,
  });
  const proposal: PolicyProposal = {
    operation: 'mcp.call-tool',
    workspaceId: workspace.id,
    resource,
    capabilityCallId: allocateEntityId('cap'),
    inputReferences: {
      argumentsDigest: policyDigest({ issue: 1 }),
      schemaDigest: null,
      packageSnapshotId: 'policy-unit',
      catalogRevision: 'policy-unit',
    },
    inputAttributes: {},
    subject,
  };
  const document = preparePolicyDocument({
    current: EMPTY_POLICY_DOCUMENT,
    userId,
    now: new Date().toISOString(),
    proposed: {
      schemaVersion: 1,
      statements: [
        {
          kind: 'agent-principal',
          id: 'explicit-worker-domain',
          state: 'active',
          author: { kind: 'human', id: userId },
          authority: { kind: 'human', userId },
          authoredAt: new Date().toISOString(),
          agentId,
          creator: { kind: 'human', id: userId },
          responsibleHumanId: userId,
          responsibility: { kind: 'human', id: userId },
          scope: {
            subjects: [{ kind: 'agent', id: agentId }],
            actions: ['tool.use'],
            resources: [resource],
          },
          lifetime: {
            anchor: {
              owner: { kind: 'workspace', workspaceId: workspace.id },
              kind: 'workspace',
              id: workspace.id,
            },
          },
        },
      ],
    },
  }).document;
  return {
    dataRoot,
    coreDb,
    actor,
    store,
    workspaceDb,
    workspace,
    resource,
    subject,
    proposal,
    document,
    humanKernel: () =>
      evaluateProductAuthorization(
        coreDb,
        actor,
        { kind: 'workspace', workspaceId: workspace.id },
        'tool.use',
        false
      ),
  };
}

/** An independent explicit grant proves that lack of a grant is not the standalone refusal oracle. */
function grantedKernel(proposal: PolicyProposal) {
  const user = `${proposal.subject.principal.kind}:${proposal.subject.principal.id}`;
  const graph: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: 'granted', kind: 'userAttribute' },
      { id: 'target', kind: 'object' },
      { id: 'resources', kind: 'objectAttribute' },
      { id: 'domain', kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: 'granted' },
      { child: 'granted', parent: 'domain' },
      { child: 'target', parent: 'resources' },
      { child: 'resources', parent: 'domain' },
    ],
    operations: [{ id: 'tool.use', accessRights: ['tool.use'] }],
    associations: [
      {
        id: 'exact-agent-read',
        userAttribute: 'granted',
        targetAttribute: 'resources',
        accessRights: ['tool.use'],
      },
    ],
    ...(proposal.subject.process
      ? { processUsers: [{ process: proposal.subject.process.turnId, user }] }
      : {}),
  };
  return evaluateAccess(graph, { user, target: 'target', operation: 'tool.use' });
}

/** The public Goal and Pending owners produce and activate the actual human-approved domain. */
async function approveGoalDomain(f: Awaited<ReturnType<typeof fixture>>) {
  mkdirSync(join(f.dataRoot, 'config'), { recursive: true });
  writeFileSync(join(f.dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot: f.dataRoot,
    userId: f.actor.userId,
    workspaceIds: [f.workspace.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const service = createGoalDomainPolicyService({
    coreDb: f.coreDb,
    store: f.store,
    files,
    reload: () => manager.reload({ mode: 'safe', dryRun: false }),
    currentPolicy: () => manager.current().openKitConfig.policy?.mediation,
    repositoryWorkspaceDb: () => f.workspaceDb,
  });
  const created = await executeGoalOperation(
    'goal.create',
    { workspaceId: f.workspace.id, requestId: randomUUID(), intent: 'Produce a reviewed design' },
    { actor: f.actor },
    f.store,
    f.workspaceDb,
    { coreDb: f.coreDb }
  );
  const key = { workspaceId: f.workspace.id, goalId: created.goal!.goalId };
  const scope = { ...key, threadId: created.goal!.threadId };
  const coordinatorTurn = await f.store.createTurn(
    f.workspace.id,
    scope.threadId,
    'Coordinate',
    { kind: 'user', id: f.actor.userId },
    null,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const coordinator = { actor: f.actor, coordinatorTurnId: coordinatorTurn.id };
  const cards = await executeGoalOperation(
    'goal.card.create',
    { ...scope, requestId: randomUUID(), description: 'Review the design', priority: 1 },
    { actor: f.actor },
    f.store,
    f.workspaceDb,
    { coreDb: f.coreDb }
  );
  const card = cards.cards[0]!;
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: cards.goal!.changeRevision,
      goalDomain: {
        id: 'design-goal-domain',
        scope: {
          subjects: [{ kind: 'agent', id: agentId }],
          actions: ['tool.use'],
          resources: [f.resource],
        },
        lifetime: {
          anchor: {
            owner: { kind: 'workspace', workspaceId: f.workspace.id },
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
    f.store,
    f.workspaceDb,
    { coreDb: f.coreDb }
  );
  const pendingRequestId = proposed.versions.at(-1)!.pendingRequestId;
  const approval = { ...scope, pendingRequestId, decision: 'granted' as const };
  await executeGoalOperation(
    'goal.plan.approve',
    { ...approval, requestId: randomUUID() },
    { actor: f.actor },
    f.store,
    f.workspaceDb,
    { coreDb: f.coreDb }
  );
  await executeGoalOperation(
    'goal.plan.approve',
    { ...approval, requestId: randomUUID() },
    coordinator,
    f.store,
    f.workspaceDb,
    { coreDb: f.coreDb }
  );
  await service.activate({
    ...key,
    requestId: pendingRequestId,
    expectedPolicyRevision: policyDigest(
      manager.current().openKitConfig.policy?.mediation ?? EMPTY_POLICY_DOCUMENT
    ),
  });
  return { service, key, document: manager.current().openKitConfig.policy!.mediation! };
}

/** Current external facts are explicit inputs; the deciding Kernel and decision writer stay real. */
function interceptionFacts(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    workspaceDb: f.workspaceDb,
    document: f.document,
    proposal: f.proposal,
    authorizationRevision: policyDigest({ workspaceId: f.workspace.id, userId: f.actor.userId }),
    authorCurrent: () => true,
    anchorCurrent: () => true,
    participantAuthorized: () => false,
    stillCurrent: () => f.humanKernel().effect === 'allow',
  };
}

describe('E10 initiation at the final mandatory Kernel boundary', () => {
  it('refuses a standalone agent without an initiator despite its own explicit Kernel grant', async () => {
    const f = await fixture();
    const interception = new PolicyInterception();
    const ordinaryProposal: PolicyProposal = {
      ...f.proposal,
      subject: PolicySubjectV1Schema.parse({
        ...f.subject,
        principal: { kind: 'human', id: f.actor.userId },
      }),
    };
    // The ordinary Task representation has a human principal and actual agent Actor; do not relabel it.
    expect(
      (
        await interception.decide({
          ...interceptionFacts(f),
          proposal: ordinaryProposal,
          finalKernel: () => f.humanKernel(),
        })
      ).result
    ).toBe('allow');
    expect(f.subject.onBehalfOf).toBeNull();
    expect(grantedKernel(f.proposal).effect).toBe('allow');
    // E10 Self-initiated work: neither a trigger definition nor a delegated Goal result exists here.
    const result = await interception
      .decide({ ...interceptionFacts(f), finalKernel: ({ proposal }) => grantedKernel(proposal) })
      .then(
        (decision) => decision.result,
        () => 'refused'
      );
    expect(result).not.toBe('allow');
  });

  it('preserves a real human-approved Goal domain with the complete Goal/Task Kernel result', async () => {
    const f = await fixture();
    const goal = await approveGoalDomain(f);
    const finalKernel = () =>
      evaluateGoalTaskAccess({
        domain: goal.service.read(goal.key),
        subject: f.subject,
        responsibleHumanId: f.actor.userId,
        resources: [f.resource],
        operation: 'tool.use',
        resource: f.resource,
        humanKernel: f.humanKernel(),
      });
    expect(goal.service.read(goal.key)).not.toBeNull();
    expect(finalKernel().inGoalEnvelope).toBe(true);
    expect(finalKernel().kernel.effect).toBe('allow');
    expect(f.subject.onBehalfOf).toBeNull();
    const decision = await new PolicyInterception().decide({
      ...interceptionFacts(f),
      document: goal.document,
      finalKernel,
      stillCurrent: () => goal.service.read(goal.key) !== null,
    });
    // E10 preserves the Goal/Task delegated envelope; a blanket null-initiator ban is defective.
    expect(decision.result).toBe('allow');
  });
});
