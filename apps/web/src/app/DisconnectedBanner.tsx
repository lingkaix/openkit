import { Icon } from '../primitives';
import { useConnection } from './core-client';

/**
 * Global disconnected affordance (DESIGN.md §9.12 "Disconnected").
 *
 * Because the whole app follows NanoCore read models, an unreachable runtime must
 * be globally legible: a persistent, quiet banner with a retry, shown while
 * per-surface content degrades to its own error/last-known state rather than
 * blanking out. Silent while connected or during the first probe.
 */
export function DisconnectedBanner() {
  const { failed, retry } = useConnection();
  if (!failed) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-separator bg-negative-bg px-4 py-1.5 text-xs font-medium text-negative-fg"
    >
      <Icon name="disconnected" size="sm" />
      <span className="flex-1">Couldn't reach the local runtime.</span>
      <button
        type="button"
        onClick={retry}
        className="rounded-ok px-2 py-0.5 font-bold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        Try again
      </button>
    </div>
  );
}
