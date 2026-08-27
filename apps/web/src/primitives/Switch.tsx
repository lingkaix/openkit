import type { ReactNode } from 'react';
import { Switch as AriaSwitch, type SwitchProps as AriaSwitchProps } from 'react-aria-components';

export interface SwitchProps extends Omit<AriaSwitchProps, 'children'> {
  /** Visible label; also the accessible name. */
  children: ReactNode;
}

/**
 * Switch (`ok-switch`, DESIGN.md §9.3).
 *
 * React Aria `Switch` (keyboard, ARIA `switch` role, focus) with a Spectrum
 * track + thumb. The track fills accent when selected; focus is always visible.
 */
export function Switch({ children, className, ...props }: SwitchProps) {
  return (
    <AriaSwitch
      {...props}
      className={`group flex items-center gap-2 text-sm text-fg ${typeof className === 'string' ? className : ''}`}
    >
      <span className="flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-sunken p-0.5 transition-colors group-data-[selected]:border-accent group-data-[selected]:bg-accent group-focus-visible:ring-2 group-focus-visible:ring-focus group-focus-visible:ring-offset-2">
        <span className="size-3.5 rounded-full bg-card shadow-ok-card transition-transform group-data-[selected]:translate-x-4" />
      </span>
      {children}
    </AriaSwitch>
  );
}
