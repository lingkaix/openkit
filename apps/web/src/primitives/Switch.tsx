import type { ReactNode } from 'react';
import { Switch as AriaSwitch, type SwitchProps as AriaSwitchProps } from 'react-aria-components';

export interface SwitchProps extends Omit<AriaSwitchProps, 'children'> {
  /** Visible label; also the accessible name. */
  children: ReactNode;
}

/**
 * Switch (S2 Switch, DESIGN.md §9.3).
 *
 * React Aria `Switch` (keyboard, ARIA `switch` role, focus). S2 medium sizes: a 26x16
 * track (34x20 touch) with a 2px outline and a small handle when off; filled accent with a
 * larger on-accent handle when on. The label sits beside it in body text.
 */
export function Switch({ children, className, ...props }: SwitchProps) {
  return (
    <AriaSwitch
      {...props}
      className={`group flex min-h-control-md items-center gap-2 text-sm text-fg outline-none data-[disabled]:text-disabled-fg ${typeof className === 'string' ? className : ''}`}
    >
      {({ isSelected }) => (
        <>
          <span
            className={`ok-switch-track flex shrink-0 items-center rounded-full border-2 px-[2px] transition-colors group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-solid group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus ${
              isSelected
                ? 'ok-switch-selected justify-end border-accent bg-accent group-hover:border-accent-hover group-hover:bg-accent-hover'
                : 'border-fg-muted bg-transparent group-hover:border-fg-strong'
            } group-data-[disabled]:border-disabled-border group-data-[disabled]:bg-disabled-bg`}
          >
            <span
              className={`ok-switch-handle rounded-full transition-all ${isSelected ? 'bg-on-accent' : 'bg-fg-muted group-hover:bg-fg-strong'} group-data-[disabled]:bg-disabled-fg`}
            />
          </span>
          {children}
        </>
      )}
    </AriaSwitch>
  );
}
