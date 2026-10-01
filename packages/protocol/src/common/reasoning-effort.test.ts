import { expect, it } from 'vitest';
import * as protocol from '../index.js';

it('exports the exact ordered Core reasoning-effort vocabulary', () => {
  expect(protocol).toHaveProperty('REASONING_EFFORT_LEVELS', [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});
