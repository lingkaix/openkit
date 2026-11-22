import type { ReactNode } from 'react';
import type { StatusTone } from './status';

/** Dot ink per status family: the readable family step (>= 3:1 on every surface, A3b). */
const DOT: Record<StatusTone, string> = {
  informative: 'bg-info-fg',
  notice: 'bg-notice-fg',
  positive: 'bg-positive-fg',
  negative: 'bg-negative-fg',
  neutral: 'bg-neutral-fg',
};

export interface StatusLightProps {
  /** Status family; colors the dot only (DESIGN.md §4.2). */
  tone: StatusTone;
  /** `md` (default) 14px text, 10px dot; `sm` 12px text, 8px dot for dense rows. */
  size?: 'sm' | 'md';
  children: ReactNode;
}

/**
 * StatusLight (S2 StatusLight, DESIGN.md §9.3; replaced the filled status chip in WEB-UX A4).
 *
 * A colored dot plus the state in default text color: status is never color alone, and the
 * word MUST come from the family's vocabulary (§4.2). No fill, so a row of states stays calm.
 */
export function StatusLight({ tone, size = 'md', children }: StatusLightProps) {
  return (
    <span
      data-tone={tone}
      className={`ok-status-light ${size === 'sm' ? 'ok-status-light-sm text-xs' : 'text-sm'} inline-flex shrink-0 items-center whitespace-nowrap text-fg`}
    >
      <span className={`ok-status-dot shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
      {children}
    </span>
  );
}
