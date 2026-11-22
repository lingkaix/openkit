import type { ReactNode } from 'react';
import { STATUS_CLASS, type StatusTone } from './status';

export interface BadgeProps {
  /** Semantic family (subtle fill) or `accent`. */
  tone?: StatusTone | 'accent';
  children: ReactNode;
}

const TONE: Record<StatusTone | 'accent', string> = {
  ...STATUS_CLASS,
  accent: 'bg-accent text-on-accent',
};

/**
 * Badge (S2 Badge, DESIGN.md §9.3): a short static label or count on a subtle fill, for a
 * category or a number (a backend kind, "3 files"). Not for state: that is a StatusLight.
 */
export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span
      className={`ok-badge inline-flex shrink-0 items-center whitespace-nowrap rounded-ok-sm font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export interface CountBadgeProps {
  /** The count of items needing attention. Nothing renders when 0. */
  count: number;
  /** Accessible label suffix, e.g. "items need you". */
  label?: string;
  /** `notice` (default) draws attention; `neutral` is ambient. */
  tone?: 'notice' | 'neutral' | 'accent';
}

/**
 * Count badge (S2 notification badge, DESIGN.md §9.4).
 *
 * Marks required work outside the right rail, on nav destinations and workspace rows. A
 * compact pill so it fits a nav row; renders nothing at zero so an empty queue stays quiet
 * (D-006).
 */
export function CountBadge({ count, label, tone = 'notice' }: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-eyebrow font-bold ${TONE[tone]}`}
    >
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      {label ? <span className="sr-only">{`${count} ${label}`}</span> : null}
    </span>
  );
}
