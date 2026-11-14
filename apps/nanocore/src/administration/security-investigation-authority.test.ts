import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { PolicySubjectV1Schema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { PolicyProposal } from '../policy/statements.js';
import { evaluateSecurityInvestigationOperation } from './security-investigation-authority.js';

// NEW-only unit oracle. The imported adapter does not exist on the frozen OLD SHA.
// Intended placement: apps/nanocore/src/administration/security-investigation-authority.test.ts.
// Runtime Security E7 fixes this grant; Tool supply and native entry need separate proof.
const allowed = [
  'administration.configuration.read',
  'administration.schema.read',
  'administration.configuration.propose',
  'worker-environment.list',
  'worker-environment.status',
  'nanohost.runtime-target',
] as const;
const forbidden = [
  'administration.configuration.dispatch',
  'worker-environment.prepare',
  'worker-environment.recover',
  'unknown.operation',
] as const;
const userId = 'usr_00000000-0000-7000-8000-000000000001';
const subject: PolicyProposal['subject'] = PolicySubjectV1Schema.parse({
  principal: { kind: 'agent', id: 'security-investigation' },
  onBehalfOf: userId,
  actor: { kind: 'agent', id: 'security-investigation', responsibleUserId: userId },
  process: {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-7000-8000-000000000001',
  },
  credentialKind: 'session',
  responsibleHumanId: userId,
});

/** Real broad human Kernel grant; it cannot replace the investigation ceiling. */
function humanPolicy(): PolicyState {
  return {
    elements: [
      { id: userId, kind: 'user' },
      { id: 'administrators', kind: 'userAttribute' },
      { id: 'administration', kind: 'object' },
      { id: 'server', kind: 'objectAttribute' },
      { id: 'domain', kind: 'policyClass' },
    ],
    assignments: [
      { child: userId, parent: 'administrators' },
      { child: 'administrators', parent: 'domain' },
      { child: 'administration', parent: 'server' },
      { child: 'server', parent: 'domain' },
    ],
    operations: [...allowed, ...forbidden].map((id) => ({ id, accessRights: ['administer'] })),
    associations: [
      {
        id: 'broad-human-authority',
        userAttribute: 'administrators',
        targetAttribute: 'server',
        accessRights: ['administer'],
      },
    ],
  };
}

/** Uses the real NGAC evaluator for every upstream authority control. */
function humanAuthority(operation: string, policy = humanPolicy()): PolicyDecision {
  return evaluateAccess(policy, { user: userId, operation, target: 'administration' });
}

describe('E7 fixed investigation grant (NEW-only)', () => {
  it.each(allowed)('allows %s only within current human authority', (operation) => {
    const human = humanAuthority(operation);
    expect(human.effect).toBe('allow');
    expect(evaluateSecurityInvestigationOperation(operation, subject, human).effect).toBe('allow');
  });

  it.each(forbidden)('does not borrow broad human authority for %s', (operation) => {
    const human = humanAuthority(operation);
    expect(human.effect).toBe('allow');
    const result = evaluateSecurityInvestigationOperation(operation, subject, human);
    expect(result.effect).toBe('deny');
    // Kernel vocabulary is missing-privilege; the product refusal maps it to not_granted.
    expect(result.reasons.map((reason) => reason.code)).toContain('missing-privilege');
    expect(result.reasons.every((reason) => reason.code !== 'restriction')).toBe(true);
  });

  it.each([
    { principal: { kind: 'human' as const, id: userId } },
    { principal: { kind: 'agent' as const, id: 'assistant' } },
    { onBehalfOf: null },
  ])('does not grant a different or uninitiated Subject: %j', (change) => {
    const unrelated = PolicySubjectV1Schema.parse({ ...subject, ...change });
    for (const operation of allowed) {
      expect(
        evaluateSecurityInvestigationOperation(operation, unrelated, humanAuthority(operation))
          .effect
      ).toBe('deny');
    }
  });

  it.each(['missing-privilege', 'invalid-policy', 'missing-operation'] as const)(
    'does not replace the current human %s refusal',
    (reason) => {
      for (const operation of allowed) {
        const policy = humanPolicy();
        if (reason === 'missing-privilege') policy.associations = [];
        if (reason === 'invalid-policy')
          policy.elements = [...policy.elements, policy.elements[0]!];
        if (reason === 'missing-operation') policy.operations = [];
        const human = humanAuthority(operation, policy);
        expect(human.effect).toBe('deny');
        expect(human.reasons.map((entry) => entry.code)).toContain(reason);
        expect(evaluateSecurityInvestigationOperation(operation, subject, human)).toEqual(human);
      }
    }
  );
});
