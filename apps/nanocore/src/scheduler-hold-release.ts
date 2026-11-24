import { resolve } from 'node:path';

/**
 * The callback slot for the owner release edges of the Main selection handoff. Composition adds
 * the listeners. An owner calls it after its edge and awaits nothing, so an owner can call it while
 * it holds the gate that it releases. This leaf imports no runtime module, so a storage or bootstrap
 * owner reports its edge without a runtime import. Each edge names the Core data root whose fact
 * changed and reaches only the listeners of that root.
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

/**
 * The capacity refusal that a refused entry carries in process through its settlement (E7): the
 * key of the check that refused it, and that check read again without effects. A refusal with no
 * side-effect-free re-check (`null`) reads as held, so only intake or the timer retries it.
 */
export interface SchedulerCapacityRefusal {
  readonly key: SchedulerCapacityKey;
  readonly stillRefused: (() => boolean) | null;
}

/**
 * A capacity owner edge: a Login close of one Thread cleared, or an acknowledged backend owner
 * change. A backend change names its backend when the owner knows it; only that backend's marks
 * read their refusal again.
 */
export type SchedulerCapacityChange =
  | Extract<SchedulerCapacityKey, { readonly kind: 'login-close' }>
  | { readonly kind: 'backend-changed'; readonly backendId?: string };

export interface SchedulerHoldReleaseListener {
  readonly hold: (hold: SchedulerHoldRelease) => void;
  readonly capacity: (change: SchedulerCapacityChange) => void;
}

const listeners = new Map<string, Set<SchedulerHoldReleaseListener>>();

/** Adds one release listener for one Core data root (one for each dispatch service) and returns its removal. */
export function addSchedulerHoldReleaseListener(
  dataRoot: string,
  listener: SchedulerHoldReleaseListener
): () => void {
  const root = resolve(dataRoot);
  let rootListeners = listeners.get(root);
  if (!rootListeners) {
    rootListeners = new Set();
    listeners.set(root, rootListeners);
  }
  rootListeners.add(listener);
  const added = rootListeners;
  return () => {
    added.delete(listener);
    if (added.size === 0 && listeners.get(root) === added) listeners.delete(root);
  };
}

/** Reports one owner release edge of one Core data root. A dispatch defect never fails the owner. */
export function releaseSchedulerHold(dataRoot: string, hold: SchedulerHoldRelease): void {
  for (const listener of rootListeners(dataRoot)) report(() => listener.hold(hold));
}

/** Reports one capacity owner edge of one Core data root. A dispatch defect never fails the owner. */
export function releaseSchedulerCapacity(dataRoot: string, change: SchedulerCapacityChange): void {
  for (const listener of rootListeners(dataRoot)) report(() => listener.capacity(change));
}

function rootListeners(dataRoot: string): SchedulerHoldReleaseListener[] {
  return [...(listeners.get(resolve(dataRoot)) ?? [])];
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
