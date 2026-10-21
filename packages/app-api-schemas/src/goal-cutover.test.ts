import { describe, expect, it } from 'vitest';
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
