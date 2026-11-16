// Opt in with OPENKIT_LATENCY_BUDGET=product for quiet-host checks or package 7 qualification.
// Shared runs use a 2x tripwire, optionally above an interleaved ablation baseline.

/** Logs the p95, optional baseline, limit and mode; product mode always uses the absolute budget. */
export function testBudgetLimit(p95: number, productBudgetMs: number, baseline?: number): number {
  const product = process.env.OPENKIT_LATENCY_BUDGET === 'product';
  const tripwire = 2 * productBudgetMs;
  const limit = product ? productBudgetMs : Math.max(tripwire, (baseline ?? 0) + tripwire);
  const mode = product ? 'product-budget' : 'tripwire';
  console.info('Test budget', JSON.stringify({ p95, baseline: baseline ?? null, limit, mode }));
  return limit;
}
