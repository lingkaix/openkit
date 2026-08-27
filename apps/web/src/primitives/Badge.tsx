export interface CountBadgeProps {
  /** The count of items needing attention. Nothing renders when 0. */
  count: number;
  /** Accessible label suffix, e.g. "items need you". */
  label?: string;
  /** `notice` (default) draws attention; `neutral` is ambient. */
  tone?: 'notice' | 'neutral' | 'accent';
}

const TONE = {
  notice: 'bg-notice-bg text-notice-fg',
  neutral: 'bg-neutral-bg text-neutral-fg',
  accent: 'bg-accent text-on-accent',
} as const;

/**
 * Count badge (`ok-nav-count`, DESIGN.md §9.4).
 *
 * Marks required work outside the right rail — on nav destinations and workspace
 * rows. Renders nothing at zero so an empty queue stays quiet (D-006).
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
