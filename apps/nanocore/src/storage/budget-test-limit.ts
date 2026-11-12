// Opt in with OPENKIT_LATENCY_BUDGET=product for quiet-host checks or package 7 qualification.
// Shared local and hosted runs use a 2x tripwire until the product budgets are calibrated.

/** Logs the measured p95 and returns the limit for the current test environment. */
export function testBudgetLimit(p95: number, productBudgetMs: number): number {
  const product = process.env.OPENKIT_LATENCY_BUDGET === 'product';
  const limit = product ? productBudgetMs : 2 * productBudgetMs;
  const mode = product ? 'product-budget' : 'tripwire';
  console.info('Test budget', JSON.stringify({ p95, limit, mode }));
  return limit;
}
