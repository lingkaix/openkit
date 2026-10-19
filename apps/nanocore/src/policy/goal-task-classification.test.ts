import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import {
  type PolicyBindingV1,
  PolicyDelegationV1Schema,
  type PolicyDocumentV1,
  PolicyPermissionV1Schema,
} from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { withHumanMcpApproval } from '../test-support/mcp-tool-policy.js';
import { evaluateGoalTaskAccess, type GoalTaskAccessInput } from './goal-task-access.js';
import { PolicyInterception } from './interception.js';
import {
  listExportableWorkspacePermissionDecisions,
  readPolicyStatementUseCount,
} from './permission-decisions.js';
import { type PolicyProposal, policyDigest } from './statements.js';

const workspaceId = testEntityId('ws', 'goal-classification');
const humanId = testEntityId('usr', 'goal-classification');
const resource = { kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' };
const domain = PolicyDelegationV1Schema.parse({
  id: 'goal-domain',
  kind: 'delegation',
  purpose: 'goal-domain',
  state: 'active',
  author: { kind: 'human', id: humanId },
  authority: { kind: 'human', userId: humanId },
  authoredAt: '2026-10-18T00:00:00Z',
  delegate: { kind: 'agent', id: 'goal-coordinator' },
  source: {
    workspaceId,
    goalId: 'goal',
    planVersionId: 'plan',
    planDigest: policyDigest('plan'),
    approvalRequestId: 'approval',
  },
  scope: {
    subjects: [{ kind: 'agent', id: 'task-worker' }],
    actions: ['tool.use'],
    resources: [resource],
  },
  lifetime: {
    anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'goal', id: 'goal' },
    uses: 1,
  },
});
const proposal: PolicyProposal = {
  operation: 'mcp.call-tool',
  workspaceId,
  serverId: resource.serverId,
  toolName: resource.toolName,
  catalogRevision: 'current-catalog',
  packageDigest: 'current-package',
  argumentsDigest: policyDigest({ issue: 1 }),
  schemaDigest: null,
  capabilityCallId: testEntityId('cap', 'goal-classification'),
  subject: {
    principal: { kind: 'agent', id: 'task-worker' },
    actor: { kind: 'agent', id: 'task-worker', responsibleUserId: humanId },
    onBehalfOf: null,
    responsibleHumanId: humanId,
    credentialKind: 'worker-package',
    process: {
      workspaceId,
      threadId: testEntityId('th', 'goal-classification'),
      turnId: testEntityId('tu', 'goal-classification'),
    },
  },
};
const destination = {
  kind: 'coordinator',
  workspaceId,
  goalId: 'goal',
  agentId: 'goal-coordinator',
};
const version = policyDigest('reviewer');
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** Uses the actual Kernel to distinguish missing human authority from a prohibition. */
function humanKernel(effect: 'allow' | 'missing' | 'prohibited' = 'allow'): PolicyDecision {
  const state: PolicyState = {
    elements: [
      { id: 'human', kind: 'user' },
      { id: 'ua', kind: 'userAttribute' },
      { id: 'target', kind: 'object' },
      { id: 'oa', kind: 'objectAttribute' },
      { id: 'pc', kind: 'policyClass' },
    ],
    assignments: [
      { child: 'human', parent: 'ua' },
      { child: 'ua', parent: 'pc' },
      { child: 'target', parent: 'oa' },
      { child: 'oa', parent: 'pc' },
    ],
    operations: [{ id: 'tool.use', accessRights: ['tool-use'] }],
    associations:
      effect === 'missing'
        ? []
        : [
            {
              id: 'human-grant',
              userAttribute: 'ua',
              targetAttribute: 'oa',
              accessRights: ['tool-use'],
            },
          ],
    prohibitions:
      effect === 'prohibited'
        ? [
            {
              id: 'human-prohibition',
              kind: 'user',
              subject: 'human',
              accessRights: ['tool-use'],
              range: { type: 'disjunctive', include: ['oa'] },
            },
          ]
        : [],
  };
  return evaluateAccess(state, { user: 'human', operation: 'tool.use', target: 'target' });
}

/** Represents already admitted native Goal facts; the test does not replace their evaluator. */
function accessInput(changes: Partial<GoalTaskAccessInput> = {}): GoalTaskAccessInput {
  return {
    domain,
    subject: proposal.subject,
    responsibleHumanId: humanId,
    resources: [],
    operation: 'tool.use',
    resource,
    humanKernel: humanKernel(),
    ...changes,
  };
}

/** Isolates the existing durable decision owner and its atomic finite-use accounting. */
function fixture(bindings: PolicyBindingV1[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-goal-classification-'));
  const workspaceDb = openWorkspaceDb(root, workspaceId);
  cleanup.push(() => {
    workspaceDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(workspaceDb);
  const document: PolicyDocumentV1 = { schemaVersion: 1, statements: [domain, ...bindings] };
  const statement = { id: domain.id, digest: policyDigest(domain) };
  return {
    workspaceDb,
    document,
    proposal,
    authorizationRevision: policyDigest('current-authorization'),
    authorizationUses: [{ statement, limit: 1 }],
    authorCurrent: () => true,
    anchorCurrent: () => true,
    participantAuthorized: () => true,
    stillCurrent: () => true,
  };
}

/** Keeps the pre-existing human failure destination observable at the real interception seam. */
function binding(): PolicyBindingV1 {
  return {
    id: 'required-review',
    kind: 'binding',
    state: 'active',
    author: { kind: 'human', id: humanId },
    authority: { kind: 'human', userId: humanId },
    authoredAt: '2026-10-18T00:00:00Z',
    scope: domain.scope,
    inputDisclosure: domain.scope,
    lifetime: {
      anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId },
    },
    operation: 'mcp.call-tool',
    stage: 'decide',
    mode: 'gate',
    participant: { kind: 'deterministic', id: 'reviewer', version },
    order: 0,
    timeoutMs: 100,
    failure: 'escalate-to-human',
    circuit: { failures: 1, recoveryAfterMs: 60_000 },
  };
}

/**
 * Carries the real producer result without replacing the current Kernel interface.
 * The Kernel fields let the unmodified consumer reach the actual denial for RED.
 */
function evaluate(changes: Partial<GoalTaskAccessInput> = {}) {
  const evaluation = evaluateGoalTaskAccess(accessInput(changes));
  return { ...evaluation.kernel, ...evaluation };
}

describe('Goal Task classification at the final Policy interception seam', () => {
  it('retains the genuine missing-association denial but requests its current Coordinator without spending a use', async () => {
    const input = fixture();
    const final = evaluate();
    expect(final.kernel.effect).toBe('deny');
    expect(final.kernel.reasons[0]?.code).toBe('missing-privilege');
    expect(final.inGoalEnvelope).toBe(true);
    const decision = await new PolicyInterception().decide({ ...input, finalKernel: () => final });
    const row = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).find(
      (value) => value.decisionId === decision.decisionId
    );
    expect(row).toMatchObject({
      contextSummary: {
        kernelTrace: {
          matchedAssociations: final.kernel.trace.matchedAssociations,
          matchedProhibitions: final.kernel.trace.matchedProhibitions,
        },
      },
      mediation: {
        kernel: { effect: 'deny', reason: 'missing-privilege' },
        invocations: [],
        consumedStatements: [],
      },
    });
    expect(
      readPolicyStatementUseCount(input.workspaceDb, input.authorizationUses[0]!.statement)
    ).toBe(0);
    expect(decision.result).toBe('require_escalation');
    expect(decision).toMatchObject({ escalation: destination });
    expect(row).toMatchObject({ result: 'require_escalation', reasonCode: 'require_approval' });
  });

  it.each([
    'task',
    'no-goal',
  ] as const)('keeps the ordinary %s allow path and final use unchanged', async (mode) => {
    const input = fixture();
    const decision = await new PolicyInterception().decide({
      ...input,
      authorizationUses: mode === 'task' ? input.authorizationUses : [],
      finalKernel: () => (mode === 'task' ? evaluate({ resources: [resource] }) : humanKernel()),
    });
    expect(decision.result).toBe('allow');
    expect(decision).not.toHaveProperty('escalation');
    expect(
      readPolicyStatementUseCount(input.workspaceDb, input.authorizationUses[0]!.statement)
    ).toBe(mode === 'task' ? 1 : 0);
  });

  it.each([
    ['missing domain', { domain: null }],
    ['inactive domain', { domain: { ...domain, state: 'inactive' as const } }],
    ['outside resource', { resource: { ...resource, toolName: 'write' } }],
    ['outside operation', { operation: 'workspace.read' }],
    ['missing process', { subject: { ...proposal.subject, process: null } }],
    [
      'contradictory Worker',
      {
        subject: {
          ...proposal.subject,
          actor: { kind: 'agent' as const, id: 'other-worker', responsibleUserId: humanId },
        },
      },
    ],
    [
      'contradictory responsibility',
      { responsibleHumanId: testEntityId('usr', 'different-human') },
    ],
    [
      'contradictory Workspace',
      {
        subject: {
          ...proposal.subject,
          process: {
            ...proposal.subject.process!,
            workspaceId: testEntityId('ws', 'different-workspace'),
          },
        },
      },
    ],
  ] satisfies [
    string,
    Partial<GoalTaskAccessInput>,
  ][])('does not route %s to the Coordinator', async (_name, changes) => {
    const input = fixture();
    const final = evaluate(changes);
    expect(final.inGoalEnvelope).toBe(false);
    const decision = await new PolicyInterception().decide({ ...input, finalKernel: () => final });
    expect(decision.result).toBe('deny');
    expect(decision).not.toHaveProperty('escalation');
    expect(
      readPolicyStatementUseCount(input.workspaceDb, input.authorizationUses[0]!.statement)
    ).toBe(0);
  });

  it.each([
    'missing',
    'prohibited',
  ] as const)('preserves the current human %s refusal and its real Kernel evidence', async (effect) => {
    const input = fixture();
    const currentHuman = humanKernel(effect);
    expect(currentHuman.effect).toBe('deny');
    const final = evaluate({ humanKernel: currentHuman });
    expect(final.inGoalEnvelope).toBe(true);
    expect(final.kernel).toEqual(currentHuman);
    const decision = await new PolicyInterception().decide({ ...input, finalKernel: () => final });
    expect(decision.result).toBe('deny');
    expect(decision).not.toHaveProperty('escalation');
    const row = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).find(
      (value) => value.decisionId === decision.decisionId
    );
    expect(row).toMatchObject({
      reasonCode: effect === 'prohibited' ? 'prohibited' : 'not_granted',
      contextSummary: {
        kernelTrace: { matchedProhibitions: effect === 'prohibited' ? ['human-prohibition'] : [] },
      },
    });
  });

  it('keeps a human-only approval condition as the destination of the same missing Task association', async () => {
    const input = fixture();
    const decision = await new PolicyInterception().decide({
      ...input,
      document: withHumanMcpApproval(input),
      finalKernel: () => evaluate(),
    });
    expect(decision.result).toBe('require_approval');
    expect(decision).not.toHaveProperty('escalation');
    expect(
      readPolicyStatementUseCount(input.workspaceDb, input.authorizationUses[0]!.statement)
    ).toBe(0);
  });

  it.each([
    'deny',
    'failure',
  ] as const)('keeps participant %s ahead of Coordinator routing and evaluates the real Kernel last', async (outcome) => {
    const input = fixture([binding()]);
    const order: string[] = [];
    const pipeline = new PolicyInterception({
      id: 'reviewer',
      version,
      invoke: async () => {
        order.push('participant');
        if (outcome === 'failure') throw new Error('required participant unavailable');
        return { decision: 'deny' };
      },
    });
    const decision = await pipeline.decide({
      ...input,
      finalKernel: () => {
        order.push('kernel');
        return evaluate();
      },
    });
    expect(order).toEqual(['participant', 'kernel']);
    expect(decision).not.toHaveProperty('escalation');
    const rows = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId);
    const gate = rows.find((value) => value.mediation?.role === 'gate');
    expect(gate).toMatchObject({
      result: outcome === 'deny' ? 'deny' : 'require_escalation',
    });
    expect(
      listWorkspaceAuditEvents(input.workspaceDb, workspaceId).find(
        (event) => event.permissionDecisionId === gate?.decisionId
      )
    ).toMatchObject({
      policyInvocation: { outcome: outcome === 'deny' ? 'completed' : 'error' },
    });
    expect(rows.find((value) => value.decisionId === decision.decisionId)).toMatchObject({
      mediation: {
        kernel: { effect: 'deny', reason: 'missing-privilege' },
        invocations: [{ kind: 'decision' }],
        consumedStatements: [],
      },
    });
    expect(decision.result).toBe(outcome === 'deny' ? 'deny' : 'require_escalation');
  });

  it.each([
    'unknown-operation',
    'stale',
    'unavailable',
  ] as const)('fails closed on %s instead of requesting a Coordinator', async (fault) => {
    const input = fixture();
    const decision = await new PolicyInterception().decide({
      ...input,
      stillCurrent: () => fault !== 'stale',
      finalKernel: () => {
        if (fault === 'unavailable') throw new Error('current Goal read unavailable');
        return evaluate(fault === 'unknown-operation' ? { operation: 'unknown.operation' } : {});
      },
    });
    expect(decision.result).toBe('error');
    expect(decision).not.toHaveProperty('escalation');
    expect(
      readPolicyStatementUseCount(input.workspaceDb, input.authorizationUses[0]!.statement)
    ).toBe(0);
  });

  it('requires a new current evaluation after a Coordinator grant before any finite use is spent', async () => {
    const input = fixture();
    const pipeline = new PolicyInterception();
    const missing = await pipeline.decide({ ...input, finalKernel: () => evaluate() });
    expect.soft(missing.result).toBe('require_escalation');
    expect.soft(missing).toMatchObject({ escalation: destination });
    expect(
      readPolicyStatementUseCount(input.workspaceDb, input.authorizationUses[0]!.statement)
    ).toBe(0);
    const permission = PolicyPermissionV1Schema.parse({
      id: 'task-extension',
      kind: 'permission',
      state: 'active',
      effect: 'allow',
      grant: { kind: 'ordinary' },
      author: domain.delegate,
      authority: { kind: 'delegation', statement: { id: domain.id, digest: policyDigest(domain) } },
      authoredAt: '2026-10-18T00:00:00Z',
      scope: domain.scope,
      lifetime: domain.lifetime,
    });
    const current = await pipeline.decide({
      ...input,
      finalKernel: () => evaluate({ permissions: [permission] }),
    });
    expect(current.result).toBe('allow');
    expect(current).not.toHaveProperty('escalation');
    expect(
      readPolicyStatementUseCount(input.workspaceDb, input.authorizationUses[0]!.statement)
    ).toBe(1);
  });
});
