import { afterEach, expect, it, vi } from 'vitest';
import { testBudgetLimit } from './budget-test-limit.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { latencyBudget: undefined, limit: 300, mode: 'tripwire' },
  { latencyBudget: '', limit: 300, mode: 'tripwire' },
  { latencyBudget: 'false', limit: 300, mode: 'tripwire' },
  { latencyBudget: 'PRODUCT', limit: 300, mode: 'tripwire' },
  { latencyBudget: 'product', limit: 150, mode: 'product-budget' },
])(
  'selects and logs the limit for OPENKIT_LATENCY_BUDGET=$latencyBudget',
  ({ latencyBudget, limit, mode }) => {
    vi.stubEnv('OPENKIT_LATENCY_BUDGET', latencyBudget);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});

    expect(testBudgetLimit(209.361411, 150)).toBe(limit);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Test budget',
      JSON.stringify({ p95: 209.361411, limit, mode })
    );
  }
);

it('scales the supplied product budget rather than using a fixed tripwire limit', () => {
  vi.stubEnv('OPENKIT_LATENCY_BUDGET', undefined);
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});

  expect(testBudgetLimit(45, 20)).toBe(40);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    'Test budget',
    JSON.stringify({ p95: 45, limit: 40, mode: 'tripwire' })
  );
});
