import type { ReactNode } from 'react';
import { STATUS_CLASS, type StatusTone } from './status';

export interface StatusChipProps {
  /** Status family; drives the tint (DESIGN.md §4.2). */
  tone: StatusTone;
  /** Show the leading status dot. */
  dot?: boolean;
  children: ReactNode;
}

/**
 * Status chip (`ok-chip`, DESIGN.md §9.3).
 *
 * A 20px pill that states a point-in-time status as text + semantic color, with
 * an optional leading dot. The word MUST come from the family's vocabulary
 * (§4.2) — status is never color alone.
 */
export function StatusChip({ tone, dot = false, children }: StatusChipProps) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold ${STATUS_CLASS[tone]}`}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

export interface ContextChipProps {
  children: ReactNode;
}

/**
 * Context chip (`ok-ctx-chip`, DESIGN.md §9.3).
 *
 * A quiet sunken pill for composer context (workspace, mode, model). Neutral by
 * design — it carries configuration, not status.
 */
export function ContextChip({ children }: ContextChipProps) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sunken px-2.5 text-xs font-medium text-fg-muted">
      {children}
    </span>
  );
}
