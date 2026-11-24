/**
 * The callback slot for the owner release edges of the Main selection handoff. Composition adds
 * the listeners. An owner calls it after its edge and awaits nothing, so an owner can call it while
 * it holds the gate that it releases. This leaf imports no module, so a storage or bootstrap owner
 * reports its edge without a runtime import.
 */
export type SchedulerHoldRelease =
  | 'active-preparation'
  | 'agent-work-paused'
  | 'frozen-workspace'
  | 'publication-pending'
  | 'scope-not-admitted';

/** The capacity that refused a queued entry: the original Login close of its Thread, or its backend. */
export type SchedulerCapacityKey =
  | { readonly kind: 'login-close'; readonly workspaceId: string; readonly threadId: string }
  | { readonly kind: 'backend'; readonly backendId: string };

/** A capacity owner edge: a Login close of one Thread cleared, or an acknowledged backend owner change. */
export type SchedulerCapacityChange =
  | Extract<SchedulerCapacityKey, { readonly kind: 'login-close' }>
  | { readonly kind: 'backend-changed' };

export interface SchedulerHoldReleaseListener {
  readonly hold: (hold: SchedulerHoldRelease) => void;
  readonly capacity: (change: SchedulerCapacityChange) => void;
}

const listeners = new Set<SchedulerHoldReleaseListener>();

/** Adds one release listener (one for each dispatch service) and returns its removal. */
export function addSchedulerHoldReleaseListener(
  listener: SchedulerHoldReleaseListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reports one owner release edge. A dispatch defect never fails the owner. */
export function releaseSchedulerHold(hold: SchedulerHoldRelease): void {
  for (const listener of listeners) report(() => listener.hold(hold));
}

/** Reports one capacity owner edge. A dispatch defect never fails the owner. */
export function releaseSchedulerCapacity(change: SchedulerCapacityChange): void {
  for (const listener of listeners) report(() => listener.capacity(change));
}

function report(edge: () => void): void {
  try {
    edge();
  } catch (error) {
    console.error(
      'scheduler_hold_release_failed',
      error instanceof Error ? error.message : 'unknown'
    );
  }
}
