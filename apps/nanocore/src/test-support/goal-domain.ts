import type { OperationInput } from '@openkit/app-api-schemas';

/** Supplies an explicit read-only synthetic domain; it grants no current Policy authority. */
export function testGoalDomainProposal(
  workspaceId: string,
  goalId: string
): OperationInput<'goal.plan.propose'>['goalDomain'] {
  return {
    id: 'test-goal-domain',
    scope: {
      subjects: [{ kind: 'agent', id: 'test-worker' }],
      actions: ['tool.use'],
      resources: [{ kind: 'mcp-tool', workspaceId, serverId: 'test-sis', toolName: 'read' }],
    },
    lifetime: {
      anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'goal', id: goalId },
    },
  };
}
