import { describe, expect, it } from 'vitest';
import { evaluateAccess, type PolicyState } from './index.js';

const baselinePolicy: PolicyState = {
  elements: [
    { id: 'user:alice', kind: 'user' },
    { id: 'ua:workspace-member', kind: 'userAttribute' },
    { id: 'object:report', kind: 'object' },
    { id: 'oa:workspace-artifacts', kind: 'objectAttribute' },
    { id: 'pc:workspace', kind: 'policyClass' },
  ],
  assignments: [
    { child: 'user:alice', parent: 'ua:workspace-member' },
    { child: 'object:report', parent: 'oa:workspace-artifacts' },
    { child: 'ua:workspace-member', parent: 'pc:workspace' },
    { child: 'oa:workspace-artifacts', parent: 'pc:workspace' },
  ],
  operations: [{ id: 'artifact.read', accessRights: ['read'] }],
  associations: [
    {
      id: 'assoc:artifact-read',
      userAttribute: 'ua:workspace-member',
      accessRights: ['read'],
      targetAttribute: 'oa:workspace-artifacts',
    },
  ],
};

describe('evaluateAccess', () => {
  it('allows an operation when the user holds every required access right through NGAC assignment and association', () => {
    const decision = evaluateAccess(baselinePolicy, {
      user: 'user:alice',
      operation: 'artifact.read',
      target: 'object:report',
    });

    expect(decision.effect).toBe('allow');
    expect(decision.reasons).toEqual([
      { code: 'association-grant', associationId: 'assoc:artifact-read' },
    ]);
    expect(decision.trace.userClosure).toContain('ua:workspace-member');
    expect(decision.trace.targetClosure).toContain('oa:workspace-artifacts');
    expect(decision.trace.requiredAccessRights).toEqual(['read']);
  });

  it('denies when no association grants the required NGAC access right', () => {
    const decision = evaluateAccess(
      { ...baselinePolicy, operations: [{ id: 'artifact.write', accessRights: ['write'] }] },
      {
        user: 'user:alice',
        operation: 'artifact.write',
        target: 'object:report',
      }
    );

    expect(decision.effect).toBe('deny');
    expect(decision.reasons).toEqual([{ code: 'missing-privilege', accessRight: 'write' }]);
    expect(decision.trace.matchedAssociations).toEqual([]);
  });

  it('requires every access right needed by an operation', () => {
    const decision = evaluateAccess(
      {
        ...baselinePolicy,
        operations: [{ id: 'artifact.review', accessRights: ['read', 'annotate'] }],
        associations: [
          ...baselinePolicy.associations,
          {
            id: 'assoc:artifact-annotate',
            userAttribute: 'ua:workspace-member',
            accessRights: ['annotate'],
            targetAttribute: 'oa:workspace-artifacts',
          },
        ],
      },
      {
        user: 'user:alice',
        operation: 'artifact.review',
        target: 'object:report',
      }
    );

    expect(decision.effect).toBe('allow');
    expect(decision.trace.requiredAccessRights).toEqual(['read', 'annotate']);
    expect(decision.trace.matchedAssociations).toEqual([
      'assoc:artifact-read',
      'assoc:artifact-annotate',
    ]);
  });

  it('requires privileges under every policy class containing the target', () => {
    const decision = evaluateAccess(
      {
        ...baselinePolicy,
        elements: [
          ...baselinePolicy.elements,
          { id: 'oa:regulated-artifacts', kind: 'objectAttribute' },
          { id: 'pc:regulated', kind: 'policyClass' },
        ],
        assignments: [
          ...baselinePolicy.assignments,
          { child: 'object:report', parent: 'oa:regulated-artifacts' },
          { child: 'oa:regulated-artifacts', parent: 'pc:regulated' },
        ],
      },
      {
        user: 'user:alice',
        operation: 'artifact.read',
        target: 'object:report',
      }
    );

    expect(decision.effect).toBe('deny');
    expect(decision.reasons).toEqual([{ code: 'missing-privilege', accessRight: 'read' }]);
    expect(decision.trace.policyClasses).toEqual(['pc:regulated', 'pc:workspace']);
  });

  it('uses process-to-user mapping without modeling processes as policy elements', () => {
    const policy: PolicyState = {
      ...baselinePolicy,
      processUsers: [{ process: 'process:agent-turn', user: 'user:alice' }],
    };

    const decision = evaluateAccess(policy, {
      process: 'process:agent-turn',
      operation: 'artifact.read',
      target: 'object:report',
    });

    expect(decision.effect).toBe('allow');
    expect(decision.trace.user).toBe('user:alice');
    expect(policy.elements.some((element) => element.kind === 'process')).toBe(false);
  });

  it('supports association targets that are NGAC attributes, including user attributes', () => {
    const policy: PolicyState = {
      elements: [
        { id: 'user:admin', kind: 'user' },
        { id: 'ua:admin', kind: 'userAttribute' },
        { id: 'ua:workspace-member', kind: 'userAttribute' },
        { id: 'pc:workspace', kind: 'policyClass' },
      ],
      assignments: [
        { child: 'user:admin', parent: 'ua:admin' },
        { child: 'ua:admin', parent: 'pc:workspace' },
        { child: 'ua:workspace-member', parent: 'pc:workspace' },
      ],
      operations: [{ id: 'membership.assign', accessRights: ['assign-to'] }],
      associations: [
        {
          id: 'assoc:assign-member',
          userAttribute: 'ua:admin',
          accessRights: ['assign-to'],
          targetAttribute: 'ua:workspace-member',
        },
      ],
    };

    const decision = evaluateAccess(policy, {
      user: 'user:admin',
      operation: 'membership.assign',
      target: 'ua:workspace-member',
    });

    expect(decision.effect).toBe('allow');
    expect(decision.trace.matchedAssociations).toEqual(['assoc:assign-member']);
  });

  it('denies invalid assignment relations instead of evaluating a non-NGAC graph', () => {
    const decision = evaluateAccess(
      {
        ...baselinePolicy,
        assignments: [
          ...baselinePolicy.assignments,
          { child: 'ua:workspace-member', parent: 'object:report' },
        ],
      },
      {
        user: 'user:alice',
        operation: 'artifact.read',
        target: 'object:report',
      }
    );

    expect(decision.effect).toBe('deny');
    expect(decision.reasons).toEqual([
      {
        code: 'invalid-policy',
        message: 'Invalid NGAC assignment ua:workspace-member -> object:report.',
      },
    ]);
  });

  it('applies a matching NGAC process prohibition range after a privilege is found', () => {
    const policy: PolicyState = {
      ...baselinePolicy,
      processUsers: [{ process: 'process:agent-turn', user: 'user:alice' }],
      prohibitions: [
        {
          id: 'deny:agent-report-read',
          kind: 'process',
          subject: 'process:agent-turn',
          accessRights: ['read'],
          range: { type: 'disjunctive', include: ['oa:workspace-artifacts'] },
        },
      ],
    };

    const decision = evaluateAccess(policy, {
      process: 'process:agent-turn',
      operation: 'artifact.read',
      target: 'object:report',
    });

    expect(decision.effect).toBe('deny');
    expect(decision.reasons).toEqual([
      { code: 'restriction', prohibitionId: 'deny:agent-report-read' },
    ]);
    expect(decision.trace.matchedProhibitions).toEqual(['deny:agent-report-read']);
  });
});
