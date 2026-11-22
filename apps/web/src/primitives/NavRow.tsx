import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button as AriaButton, TooltipTrigger } from 'react-aria-components';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';

/**
 * True below the 800px shell break, where rows span the viewport and a hint on the
 * right has no room. Absent matchMedia stays wide so tests do.
 */
export function useFullWidthRows(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 799px)');
    if (!media) return undefined;
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return narrow;
}

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
 * workspace sub-items: hover = overlay, active = selected tint + strong text +
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
  const fullWidthRows = useFullWidthRows();
  const button = (
    <AriaButton
      type="button"
      aria-describedby={description ? descriptionId : undefined}
      onPress={onPress}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex h-control-md w-full items-center gap-2 rounded-ok pr-2 text-left text-sm outline-none transition-colors',
        'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus',
        INDENT[indent],
        active ? 'bg-selected font-bold text-fg-strong' : 'font-medium text-fg hover:bg-overlay',
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
        placement={fullWidthRows ? 'bottom start' : 'right top'}
        className="flex max-h-[100vh] min-w-0 flex-col overflow-hidden break-all"
      >
        <span className="line-clamp-3 break-all font-bold">{label}</span>
        <span className="break-all">{description}</span>
      </Tooltip>
    </TooltipTrigger>
  ) : (
    button
  );
}
