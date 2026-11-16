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
      JSON.stringify({ p95: 209.361411, baseline: null, limit, mode })
    );
  }
);

it('scales the supplied product budget rather than using a fixed tripwire limit', () => {
  vi.stubEnv('OPENKIT_LATENCY_BUDGET', undefined);
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});

  expect(testBudgetLimit(45, 20)).toBe(40);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    'Test budget',
    JSON.stringify({ p95: 45, baseline: null, limit: 40, mode: 'tripwire' })
  );
});

it.each([
  { p95: 322, baseline: 157, limit: 457, passes: true },
  { p95: 351, baseline: 50, limit: 350, passes: false },
  { p95: 301, baseline: 0, limit: 300, passes: false },
])(
  'uses the interleaved baseline: p95=$p95 baseline=$baseline passes=$passes',
  ({ p95, baseline, limit, passes }) => {
    vi.stubEnv('OPENKIT_LATENCY_BUDGET', undefined);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});

    const chosen = testBudgetLimit(p95, 150, baseline);
    expect(chosen).toBe(limit);
    expect(p95 <= chosen).toBe(passes);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Test budget',
      JSON.stringify({ p95, baseline, limit, mode: 'tripwire' })
    );
  }
);

it('keeps the absolute product limit even when a baseline is supplied', () => {
  vi.stubEnv('OPENKIT_LATENCY_BUDGET', 'product');
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});

  const limit = testBudgetLimit(151, 150, 1000);
  expect(limit).toBe(150);
  expect(151 <= limit).toBe(false);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    'Test budget',
    JSON.stringify({ p95: 151, baseline: 1000, limit: 150, mode: 'product-budget' })
  );
});
