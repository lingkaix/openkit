import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface NavRowProps {
  /** Leading glyph. */
  icon?: IconName;
  label: string;
  /** Active/current state: selected tint + accent text + bold. */
  active?: boolean;
  /** Trailing content, e.g. a CountBadge. */
  trailing?: ReactNode;
  /** Indentation depth for nested workspace/thread rows. */
  indent?: 0 | 1 | 2;
  onPress?: () => void;
}

const INDENT = ['pl-3', 'pl-7', 'pl-10'] as const;

/**
 * Nav row (DESIGN.md §9.4).
 *
 * One quiet row grammar shared by nav items, workspace rows, thread rows, and
 * workspace sub-items: hover = overlay, active = selected tint + accent text +
 * bold. Count badges mark required work outside the rail.
 */
export function NavRow({
  icon,
  label,
  active = false,
  trailing,
  indent = 0,
  onPress,
}: NavRowProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex w-full items-center gap-2 rounded-ok py-1.5 pr-2 text-left text-sm outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-focus',
        INDENT[indent],
        active
          ? 'bg-selected font-bold text-accent-content'
          : 'font-medium text-fg hover:bg-overlay',
      ].join(' ')}
    >
      {icon ? <Icon name={icon} /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}
