import { isValidElement, type ReactNode, type Ref } from 'react';
import {
  Button as AriaButton,
  ToggleButton as AriaToggleButton,
  type ButtonProps,
  type ToggleButtonProps,
} from 'react-aria-components';
import type { ButtonSize } from './Button';
import { Icon } from './Icon';
import { withTitle } from './Tooltip';

/** Size classes (theme.css components layer, so call-site utilities override them). */
const SIZE: Record<ButtonSize, string> = {
  sm: 'ok-action-sm',
  md: 'ok-action-md',
  lg: 'ok-action-lg',
};

const BASE = [
  'ok-action inline-flex shrink-0 items-center justify-center gap-1.5 rounded-ok font-medium text-fg',
  'outline-none transition-colors [transition-timing-function:var(--ease-ok)]',
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:text-disabled-fg',
].join(' ');

/** True when the only content is one element (an Icon): the control is drawn square. */
function isIconOnly(children: unknown): boolean {
  return isValidElement(children);
}

function look(isQuiet: boolean): string {
  return isQuiet
    ? 'bg-transparent hover:bg-overlay data-[pressed]:bg-overlay-down'
    : 'bg-secondary hover:bg-secondary-hover data-[pressed]:bg-secondary-hover disabled:bg-disabled-bg';
}

function classes(size: ButtonSize, isQuiet: boolean, children: unknown, className: unknown) {
  return [
    BASE,
    SIZE[size],
    isIconOnly(children) ? 'ok-action-icon' : '',
    look(isQuiet),
    typeof className === 'string' ? className : '',
  ].join(' ');
}

export interface ActionButtonProps extends ButtonProps {
  ref?: Ref<HTMLButtonElement>;
  /** No fill until hover: rows, inline commands, headers. Default = gray fill (toolbars). */
  isQuiet?: boolean;
  /** Control size. Defaults to md (32px desktop, 40px touch). */
  size?: ButtonSize;
  /** Visible hover and keyboard-focus hint; give icon-only commands one. */
  title?: string;
  children?: ReactNode;
}

/**
 * Spectrum 2 ActionButton: toolbar, inline and repeated row commands (Copy, Retry, Open,
 * More, composer tools). 8px radius, medium weight; icon-only is square. Not for the main
 * action of a view: that is a Button (P8).
 */
export function ActionButton({
  isQuiet = false,
  size = 'md',
  className,
  title,
  children,
  ...props
}: ActionButtonProps) {
  return withTitle(
    <AriaButton {...props} className={classes(size, isQuiet, children, className)}>
      {children}
    </AriaButton>,
    title
  );
}

export interface OkToggleButtonProps extends ToggleButtonProps {
  ref?: Ref<HTMLButtonElement>;
  isQuiet?: boolean;
  size?: ButtonSize;
  title?: string;
  children?: ReactNode;
}

const SELECTED =
  'data-[selected]:bg-primary data-[selected]:text-on-primary data-[selected]:hover:bg-primary-hover';
/** A quiet toggle in a list (a version, a revision, a target) selects with the row tint. */
const SELECTED_QUIET = 'data-[selected]:bg-selected data-[selected]:text-fg-strong';

/**
 * Spectrum 2 ToggleButton: an ActionButton with a selected state (Pin, Follow, a lens);
 * `aria-pressed` follows `isSelected`.
 */
export function ToggleButton({
  isQuiet = false,
  size = 'md',
  className,
  title,
  children,
  ...props
}: OkToggleButtonProps) {
  return withTitle(
    <AriaToggleButton
      {...props}
      className={`${classes(size, isQuiet, children, className)} ${isQuiet ? SELECTED_QUIET : SELECTED}`}
    >
      {children}
    </AriaToggleButton>,
    title
  );
}

/**
 * Spectrum 2 ActionGroup: related ActionButtons or ToggleButtons in one row, 8px apart.
 * On a coarse pointer small controls sit 14px apart, so their 44px hit areas do not overlap.
 */
export function ActionGroup({
  'aria-label': ariaLabel,
  size = 'md',
  className,
  children,
}: {
  'aria-label': string;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={`m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 ${size === 'sm' ? 'pointer-coarse:gap-3.5' : ''} ${className ?? ''}`}
    >
      {children}
    </fieldset>
  );
}

/**
 * Section disclosure trigger (S2 Disclosure): a quiet, start-aligned ActionButton with a
 * chevron and `aria-expanded`. Replaces full-width pills used as section toggles (F22).
 */
export function DisclosureButton({
  isExpanded,
  onPress,
  children,
}: {
  isExpanded: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <ActionButton
      isQuiet
      aria-expanded={isExpanded}
      onPress={onPress}
      className="self-start px-2 font-bold"
    >
      <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
      <span>{children}</span>
    </ActionButton>
  );
}
