import { PolicyDelegationV1Schema, type PolicySubjectV1Schema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { testEntityId } from '../test-support/entity-ids.js';
import { evaluateGoalTaskAccess, type GoalTaskAccessInput } from './goal-task-access.js';
import { evaluateWorkspaceMemberAccess } from './workspace-access.js';

const workspaceId = testEntityId('ws', 'goal-task-kernel');
const humanId = testEntityId('usr', 'goal-task-human');
const resource = { kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' };
const domain = PolicyDelegationV1Schema.parse({
  id: 'goal-domain',
  kind: 'delegation',
  state: 'active',
  purpose: 'goal-domain',
  author: { kind: 'human', id: humanId },
  authority: { kind: 'human', userId: humanId },
  authoredAt: '2026-10-18T00:00:00Z',
  delegate: { kind: 'agent', id: 'goal-coordinator' },
  source: {
    workspaceId,
    goalId: 'goal',
    planVersionId: 'plan',
    planDigest: `sha256:${'1'.repeat(64)}`,
    approvalRequestId: 'approval',
  },
  scope: {
    subjects: [{ kind: 'agent', id: 'design-worker' }],
    actions: ['tool.use'],
    resources: [resource],
  },
  lifetime: { anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'goal', id: 'goal' } },
});
const subject: z.infer<typeof PolicySubjectV1Schema> = {
  principal: { kind: 'agent', id: 'design-worker' },
  onBehalfOf: null,
  actor: { kind: 'agent', id: 'design-worker', responsibleUserId: humanId },
  process: {
    workspaceId,
    threadId: testEntityId('th', 'goal-task'),
    turnId: testEntityId('tu', 'goal-task'),
  },
  credentialKind: 'worker-package',
  responsibleHumanId: humanId,
};
function input(changes: Partial<GoalTaskAccessInput> = {}): GoalTaskAccessInput {
  return {
    domain,
    subject,
    resources: [resource],
    operation: 'tool.use',
    resource,
    humanKernel: evaluateWorkspaceMemberAccess({ operation: 'tool.use' }),
    ...changes,
  };
}

describe('Goal Task native Kernel projection', () => {
  it('requires both Goal and exact Task associations in the existing Kernel', () => {
    const result = evaluateGoalTaskAccess(input());
    expect(result.kernel.effect).toBe('allow');
    expect(result.kernel.trace.user).toBe('agent:design-worker');
    expect([...result.kernel.trace.matchedAssociations].sort()).toEqual([
      'goal-envelope',
      'goal-task',
    ]);
    expect(result.inGoalEnvelope).toBe(true);
  });
  it('keeps a missing Task grant distinct from outside the Goal envelope', () => {
    const missing = evaluateGoalTaskAccess(input({ resources: [] }));
    expect(missing.kernel.effect).toBe('deny');
    expect(missing.kernel.reasons[0]?.code).toBe('missing-privilege');
    expect(missing.inGoalEnvelope).toBe(true);
    const outside = evaluateGoalTaskAccess(input({ resource: { ...resource, toolName: 'write' } }));
    expect(outside.kernel.effect).toBe('deny');
    expect(outside.inGoalEnvelope).toBe(false);
    expect(outside.authorizationRevision).not.toBe(missing.authorizationRevision);
  });
  it('does not substitute the human or a different Worker for the admitted agent', () => {
    for (const principal of [
      { kind: 'human' as const, id: humanId },
      { kind: 'agent' as const, id: 'other-worker' },
    ]) {
      const result = evaluateGoalTaskAccess(input({ subject: { ...subject, principal } }));
      expect(result.kernel.effect).toBe('deny');
      expect(result.inGoalEnvelope).toBe(false);
    }
    expect(evaluateGoalTaskAccess(input({ domain: null })).kernel.effect).toBe('deny');
  });
  it('does not use the responsible human or a mismatched process as agent authority', () => {
    for (const invalid of [
      { ...subject, responsibleHumanId: testEntityId('usr', 'other-human') },
      {
        ...subject,
        process: { ...subject.process!, workspaceId: testEntityId('ws', 'other-workspace') },
      },
      {
        ...subject,
        actor: { kind: 'agent' as const, id: 'other-worker', responsibleUserId: humanId },
      },
    ])
      expect(evaluateGoalTaskAccess(input({ subject: invalid })).kernel.effect).toBe('deny');
  });
  it('never overrides a current mandatory human Kernel refusal', () => {
    const humanKernel = evaluateWorkspaceMemberAccess({ operation: 'deployment.recover' });
    expect(humanKernel.effect).toBe('deny');
    expect(evaluateGoalTaskAccess(input({ humanKernel })).kernel).toEqual(humanKernel);
  });
});
