import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import type { PolicyDocumentV1, PolicyPermissionV1Schema } from '@openkit/protocol';
import type { z } from 'zod';
import { type PolicyProposal, policyDigest } from './statements.js';

/** Exact, current human-authored Tool conditions; supply and baseline authority remain separate. */
export function selectMcpToolPermissions(input: {
  readonly document: PolicyDocumentV1;
  readonly proposal: {
    readonly workspaceId: string;
    readonly serverId: string;
    readonly toolName: string;
    readonly subject: PolicyProposal['subject'];
  };
  readonly authorCurrent: (userId: string) => boolean;
  readonly now?: number;
}): z.infer<typeof PolicyPermissionV1Schema>[] {
  const now = input.now ?? Date.now();
  return input.document.statements.filter(
    (statement): statement is z.infer<typeof PolicyPermissionV1Schema> => {
      if (
        statement.kind !== 'permission' ||
        statement.state !== 'active' ||
        statement.grant.kind !== 'ordinary' ||
        statement.authority.kind !== 'human' ||
        statement.author.kind !== 'human' ||
        !['prohibit', 'require_approval'].includes(statement.effect)
      )
        return false;
      const anchor = statement.lifetime.anchor;
      if (
        anchor.owner.kind !== 'workspace' ||
        anchor.owner.workspaceId !== input.proposal.workspaceId ||
        anchor.kind !== 'workspace' ||
        anchor.id !== input.proposal.workspaceId ||
        (statement.lifetime.notAfter && Date.parse(statement.lifetime.notAfter) <= now)
      )
        return false;
      if (
        !statement.scope.subjects.some(
          (subject) => policyDigest(subject) === policyDigest(input.proposal.subject.principal)
        ) ||
        !statement.scope.actions.includes('tool.use') ||
        !statement.scope.resources.some(
          (resource) =>
            resource.kind === 'mcp-tool' &&
            resource.workspaceId === input.proposal.workspaceId &&
            resource.serverId === input.proposal.serverId &&
            resource.toolName === input.proposal.toolName
        )
      )
        return false;
      // Lost author authority cannot silently turn a mandatory restriction into permission.
      if (!input.authorCurrent(statement.author.id))
        throw new Error('MCP Policy author no longer has current authority.');
      return true;
    }
  );
}

/** Adds exact prohibitions to the mandatory Kernel without supplying any new baseline grant. */
export function applyMcpToolProhibitions(
  kernel: PolicyDecision,
  permissions: readonly z.infer<typeof PolicyPermissionV1Schema>[]
): PolicyDecision {
  const prohibitions = permissions.filter((statement) => statement.effect === 'prohibit');
  if (
    prohibitions.length === 0 ||
    kernel.reasons.some(({ code }) =>
      ['invalid-policy', 'invalid-request', 'missing-operation'].includes(code)
    )
  )
    return kernel;
  const policy: PolicyState = {
    elements: [
      { id: 'caller', kind: 'user' },
      { id: 'eligible', kind: 'userAttribute' },
      { id: 'tool', kind: 'object' },
      { id: 'tools', kind: 'objectAttribute' },
      { id: 'mcp', kind: 'policyClass' },
    ],
    assignments: [
      { child: 'caller', parent: 'eligible' },
      { child: 'eligible', parent: 'mcp' },
      { child: 'tool', parent: 'tools' },
      { child: 'tools', parent: 'mcp' },
    ],
    operations: [{ id: 'tool.use', accessRights: ['use'] }],
    associations:
      kernel.effect === 'allow'
        ? [
            {
              id: 'current-native-authority',
              userAttribute: 'eligible',
              targetAttribute: 'tools',
              accessRights: ['use'],
            },
          ]
        : [],
    prohibitions: prohibitions.map((statement) => ({
      id: statement.id,
      kind: 'user',
      subject: 'caller',
      accessRights: ['use'],
      range: { type: 'disjunctive', include: ['tools'] },
    })),
  };
  const decision = evaluateAccess(policy, {
    user: 'caller',
    operation: 'tool.use',
    target: 'tool',
  });
  return {
    ...decision,
    trace: {
      ...decision.trace,
      matchedAssociations: kernel.trace.matchedAssociations,
      matchedProhibitions: [
        ...kernel.trace.matchedProhibitions,
        ...decision.trace.matchedProhibitions,
      ],
    },
  };
}
