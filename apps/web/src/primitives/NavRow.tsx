import { type ReactNode, useId } from 'react';
import { Button as AriaButton, Tooltip, TooltipTrigger } from 'react-aria-components';
import { Icon, type IconName } from './Icon';

export interface NavRowProps {
  /** Leading glyph. */
  icon?: IconName;
  label: string;
  /** Human-readable detail for the hover/focus hint and assistive technology. */
  description?: string;
  /** Small supplementary mark positioned on the leading icon. */
  iconBadge?: ReactNode;
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
  description,
  iconBadge,
  active = false,
  trailing,
  indent = 0,
  onPress,
}: NavRowProps) {
  const descriptionId = useId();
  const button = (
    <AriaButton
      type="button"
      aria-describedby={description ? descriptionId : undefined}
      onPress={onPress}
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
      {icon ? (
        <span className="relative shrink-0">
          <Icon name={icon} />
          {iconBadge}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {description ? (
        <span id={descriptionId} hidden>
          {description}
        </span>
      ) : null}
    </AriaButton>
  );
  return description ? (
    <TooltipTrigger delay={0} closeDelay={0}>
      {button}
      <Tooltip
        placement="right top"
        className="pointer-events-none z-50 flex max-h-[100vh] max-w-[min(20rem,100vw)] flex-col overflow-hidden rounded-ok border border-border bg-elevated px-2 py-1 text-xs text-fg shadow-ok-menu"
      >
        <span className="line-clamp-3 break-words">{label}</span>
        <span className="break-words">{description}</span>
      </Tooltip>
    </TooltipTrigger>
  ) : (
    button
  );
}
