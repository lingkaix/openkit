import {
  allocateEntityId,
  PolicyPermissionV1Schema,
  PolicyWriteOutcomeV1Schema,
  PolicyWriteProposalV1Schema,
} from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { OPERATION_DEFINITIONS, OPERATION_REGISTRY } from './operation-definitions.js';

const workspaceId = allocateEntityId('ws');
const taskThreadId = allocateEntityId('th');
const digest = `sha256:${'a'.repeat(64)}`;
const grant = {
  id: 'bounded-task-read',
  scope: {
    subjects: [{ kind: 'agent', id: 'issue-worker' }],
    actions: ['tool.use'],
    resources: [{ kind: 'mcp-tool', workspaceId, serverId: 'issues', toolName: 'read' }],
  },
  lifetime: {
    anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'thread', id: taskThreadId },
    uses: 1,
  },
  rationale: 'Read the issue for the assigned Task',
};
const bounded = { taskThreadId, expectedPolicyRevision: digest, grant };
const statement = {
  id: grant.id,
  scope: grant.scope,
  lifetime: grant.lifetime,
  kind: 'permission',
  state: 'active',
  effect: 'allow',
  grant: { kind: 'ordinary' },
  author: { kind: 'agent', id: 'goal-coordinator' },
  authority: { kind: 'delegation', statement: { id: 'approved-domain', digest } },
  authoredAt: '2026-10-19T00:00:00Z',
};

describe('native policy.write bounded Coordinator variant', () => {
  it('remains native without adding a public operation or a second spelling', () => {
    expect(OPERATION_REGISTRY['policy.write'].binding).toBe('native');
    expect(Object.keys(OPERATION_DEFINITIONS)).not.toContain('policy.write');
    expect(Object.keys(OPERATION_REGISTRY).filter((id) => id.startsWith('policy.'))).toEqual([
      'policy.write',
    ]);
  });

  it('preserves the existing closed human proposal and outcome grammars', () => {
    const proposal = {
      schemaVersion: 1,
      proposer: { kind: 'human', id: allocateEntityId('usr') },
      rationale: 'Apply the exact reviewed Policy',
      baseRevision: digest,
      proposed: { schemaVersion: 1, statements: [] },
      validation: 'valid',
    };
    const outcome = {
      candidate: { artifactId: allocateEntityId('ar'), version: 1, digest },
      decider: proposal.proposer,
      decidedAt: '2026-10-19T00:00:00Z',
      approval: { proposalDigest: digest, policyRevision: digest, authorizationRevision: digest },
      validation: 'valid',
      persistedRevision: digest,
      activeRevision: digest,
      outcome: 'active',
    };
    expect(PolicyWriteProposalV1Schema.parse(proposal)).toEqual(proposal);
    expect(PolicyWriteOutcomeV1Schema.parse(outcome)).toEqual(outcome);
    expect(OPERATION_REGISTRY['policy.write'].inputSchema.parse(proposal)).toEqual(proposal);
    expect(OPERATION_REGISTRY['policy.write'].outputSchema.parse(outcome)).toEqual(outcome);
    expect(PolicyWriteProposalV1Schema.safeParse(bounded).success).toBe(false);
    expect(
      PolicyWriteOutcomeV1Schema.safeParse({ statement, policyRevision: digest }).success
    ).toBe(false);
  });

  it('accepts only the bounded Task selector, expected revision and typed grant', () => {
    expect(OPERATION_REGISTRY['policy.write'].inputSchema.safeParse(bounded).success).toBe(true);
    expect(OPERATION_REGISTRY['policy.write'].inputSchema.parse(bounded)).toEqual(bounded);
  });

  it('returns the existing permission and current Policy revision without a human outcome wrapper', () => {
    expect(PolicyPermissionV1Schema.parse(statement)).toEqual(statement);
    const result = { statement, policyRevision: digest };
    expect(OPERATION_REGISTRY['policy.write'].outputSchema.safeParse(result).success).toBe(true);
    expect(OPERATION_REGISTRY['policy.write'].outputSchema.parse(result)).toEqual(result);
    expect(
      OPERATION_REGISTRY['policy.write'].outputSchema.safeParse({ ...result, actor: 'model' })
        .success
    ).toBe(false);
  });

  it('refuses replacement identity, lineage, grant authority and descriptive resource inputs', () => {
    const invalid = [
      ...['goalId', 'workspaceId', 'turnId', 'agentSessionId', 'actor', 'taskLineage'].map(
        (key) => ({
          ...bounded,
          [key]: 'model-selected',
        })
      ),
      { ...bounded, grant: { ...grant, author: { kind: 'agent', id: 'other-worker' } } },
      { ...bounded, grant: { ...grant, effect: 'allow' } },
      { ...bounded, grant: { ...grant, scope: { ...grant.scope, resources: [] } } },
      { ...bounded, grant: { ...grant, scope: { ...grant.scope, resources: ['issues/read'] } } },
      { ...bounded, grant: { ...grant, lifetime: { ...grant.lifetime, uses: 0 } } },
      { ...bounded, grant: { ...grant, rationale: '' } },
      { ...bounded, expectedPolicyRevision: 'the current revision' },
    ];
    for (const value of invalid)
      expect(OPERATION_REGISTRY['policy.write'].inputSchema.safeParse(value).success).toBe(false);
  });
});
