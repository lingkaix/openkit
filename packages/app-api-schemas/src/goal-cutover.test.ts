import { ProductOperationSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { GoalDomainProposalSchema } from './goal.js';
import {
  operationHttpPath,
  operationToolName,
  PRODUCT_OPERATION_DEFINITIONS,
} from './operation-definitions.js';

describe('Goal atomic cutover projections', () => {
  it('publishes exactly the ten accepted operations through the shared table', () => {
    const ids = Object.keys(PRODUCT_OPERATION_DEFINITIONS).filter((id) => id.startsWith('goal.'));
    expect(ids.sort()).toEqual(
      [
        'goal.create',
        'goal.intent.revise',
        'goal.card.create',
        'goal.card.edit',
        'goal.card.cancel',
        'goal.plan.propose',
        'goal.plan.approve',
        'goal.cancel',
        'goal.completion.accept',
        'goal.read',
      ].sort()
    );
    for (const id of ids) {
      expect(operationHttpPath(id)).toBe(`/api/app/operations/${id}`);
      expect(operationToolName(id)).toBe(id.replaceAll('.', '_'));
    }
  });
});

it.each([
  'read',
  'propose',
  'knowledge-candidate',
])('rejects the nonnative Goal proposal action %s without aliases', (action) => {
  const owner = { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' };
  const input = {
    id: 'domain',
    scope: {
      subjects: [{ kind: 'agent', id: 'worker' }],
      actions: [action],
      resources: [
        { kind: 'container', container: { owner, kind: 'workspace', id: owner.workspaceId } },
      ],
    },
    lifetime: { anchor: { owner, kind: 'goal', id: 'goal' } },
  };
  expect(ProductOperationSchema.safeParse(action).success).toBe(false);
  for (const registered of ProductOperationSchema.options) {
    expect(
      GoalDomainProposalSchema.safeParse({
        ...input,
        scope: { ...input.scope, actions: [registered] },
      }).success,
      registered
    ).toBe(true);
  }
  expect(GoalDomainProposalSchema.safeParse(input).success).toBe(false);
});
