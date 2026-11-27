const NANO_HOST_STARTUP_BUDGET_MS = 1_500_000;
export const NANO_HOST_HEARTBEAT_BUDGET_MS = 30_000;

/** Preparation and submission share the first attempt clock across writer queue waits. */
export function nanoHostStartupDeadline(attempt: { readonly createdAt: string }): string {
  return new Date(Date.parse(attempt.createdAt) + NANO_HOST_STARTUP_BUDGET_MS).toISOString();
}
