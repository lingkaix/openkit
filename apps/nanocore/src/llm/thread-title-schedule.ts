/**
 * Gateway-free title schedule.
 * The control-store worker bundles the create sites, and the worker build rejects Gateway modules.
 * App startup binds the real producer. An unbound process does not call.
 */
let schedule: ((input: never) => void) | undefined;

/** Installs the process title producer. */
export function bindThreadTitleScheduler<Input>(fn: (input: Input) => void): void {
  schedule = fn as (input: never) => void;
}

/** Queues one title after a fresh create. No binder means no call. */
export function scheduleThreadTitle<Input>(input: Input): void {
  schedule?.(input as never);
}
