import type { ReactElement, ReactNode } from 'react';
import { Tooltip as AriaTooltip, type TooltipProps, TooltipTrigger } from 'react-aria-components';

/**
 * S2 Tooltip look (DESIGN.md §9.10): the inverted neutral layer (toast tokens), 12px text,
 * 160px wide at most (200 touch), 8px from its trigger.
 */
export function Tooltip({ className, children, ...props }: TooltipProps & { children: ReactNode }) {
  return (
    <AriaTooltip
      offset={8}
      {...props}
      className={`ok-tooltip pointer-events-none z-50 rounded-ok bg-toast-bg px-2 py-1 text-toast-fg shadow-ok-menu ${typeof className === 'string' ? className : ''}`}
    >
      {children}
    </AriaTooltip>
  );
}

/**
 * Projects a `title` as a React Aria tooltip on hover and keyboard focus (the native
 * attribute is filtered and does not appear on focus).
 */
export function withTitle(control: ReactElement, title: string | undefined): ReactElement {
  if (!title) return control;
  return (
    <TooltipTrigger delay={0} closeDelay={0}>
      {control}
      <Tooltip>{title}</Tooltip>
    </TooltipTrigger>
  );
}
