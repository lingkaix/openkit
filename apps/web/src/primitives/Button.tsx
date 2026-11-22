import type { ReactNode, Ref } from 'react';
import { Button as AriaButton, type ButtonProps } from 'react-aria-components';
import { withTitle } from './Tooltip';

/**
 * Spectrum 2 Button roles (DESIGN.md §9.3, design-system.md §4): `accent` is the one main
 * action of a view; `primary` a strong neutral action; `secondary` Cancel / Not now / Back;
 * `negative` only in the confirmation step of a destructive action. Toolbar, inline and
 * repeated row commands are not Buttons: use ActionButton.
 */
export type ButtonVariant = 'accent' | 'primary' | 'secondary' | 'negative';

/** Fill or outline. Secondary defaults to outline (P8); the others default to fill. */
export type ButtonFillStyle = 'fill' | 'outline';

/**
 * Spectrum 2 sizes (DESIGN.md §6), desktop/touch: sm 24/30 for dense rows (card actions,
 * inline approvals), md 32/40 by default, lg 40/50 for a rare emphasized CTA.
 */
export type ButtonSize = 'sm' | 'md' | 'lg';

const LOOK: Record<`${ButtonVariant}-${ButtonFillStyle}`, string> = {
  'accent-fill': 'bg-accent text-on-accent hover:bg-accent-hover data-[pressed]:bg-accent-down',
  'accent-outline':
    'border border-accent-content bg-transparent text-accent-content hover:bg-overlay',
  'primary-fill': 'bg-primary text-on-primary hover:bg-primary-hover',
  'primary-outline': 'border border-fg-strong bg-transparent text-fg-strong hover:bg-overlay',
  'secondary-fill': 'bg-secondary text-fg hover:bg-secondary-hover',
  'secondary-outline':
    'border border-border bg-card text-fg hover:border-border-hover hover:bg-sunken',
  'negative-fill': 'bg-negative text-on-negative hover:bg-negative-hover',
  'negative-outline': 'border border-negative-fg bg-card text-negative-fg hover:bg-negative-bg',
};

/** Size classes (theme.css components layer, so call-site utilities override them). */
const SIZE: Record<ButtonSize, string> = {
  sm: 'ok-button-sm',
  md: 'ok-button-md',
  lg: 'ok-button-lg',
};

/**
 * True for a plain-text label. Only text pills take the width floor (3 x the height,
 * `ok-button-text`), so a one- or two-word label never nears a circle; buttons with an
 * icon keep their own layout.
 */
function isTextLabel(children: ButtonProps['children']): boolean {
  const parts: ReactNode[] = Array.isArray(children) ? children : [children];
  return (
    parts.length > 0 && parts.every((part) => typeof part === 'string' || typeof part === 'number')
  );
}

export interface OkButtonProps extends ButtonProps {
  /** Native control reference for restoring focus after a related surface closes. */
  ref?: Ref<HTMLButtonElement>;
  /** Role. Defaults to accent: keep at most one accent per view (P8). */
  variant?: ButtonVariant;
  /** Fill or outline; defaults per variant (secondary = outline). */
  fillStyle?: ButtonFillStyle;
  /** Control size. Defaults to md (32px desktop, 40px touch). */
  size?: ButtonSize;
  /** Visible hover and keyboard-focus hint. */
  title?: string;
}

/**
 * OpenKit Button: a Spectrum 2 pill for the actions of a view or dialog.
 *
 * React Aria `Button` behavior with semantic-token styling. The disabled state uses the
 * disabled bg/content/border tokens. `data-variant` exposes the role for the
 * one-accent-per-view check (P8).
 */
export function Button({
  variant = 'accent',
  fillStyle,
  size = 'md',
  className,
  title,
  ...props
}: OkButtonProps) {
  const fill = fillStyle ?? (variant === 'secondary' ? 'outline' : 'fill');
  return withTitle(
    <AriaButton
      {...props}
      data-variant={variant}
      className={[
        'ok-button inline-flex items-center justify-center gap-2 rounded-full font-bold',
        'outline-none transition-colors [transition-timing-function:var(--ease-ok)]',
        'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg disabled:border-disabled-border',
        SIZE[size],
        isTextLabel(props.children) ? 'ok-button-text' : '',
        LOOK[`${variant}-${fill}`],
        typeof className === 'string' ? className : '',
      ].join(' ')}
    />,
    title
  );
}

/** Spectrum 2 ButtonGroup: Buttons 16px apart, wrapping; `align="end"` for dialog footers. */
export function ButtonGroup({
  align = 'start',
  className,
  children,
}: {
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-4 ${align === 'end' ? 'justify-end' : ''} ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
