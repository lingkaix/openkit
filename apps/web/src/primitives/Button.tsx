import { Button as AriaButton, type ButtonProps } from 'react-aria-components';

/** Visual variants; map 1:1 to the Spectrum pill buttons in DESIGN.md §9.3. */
export type ButtonVariant = 'accent' | 'outline' | 'quiet' | 'negative' | 'negative-outline';

/** Control heights from DESIGN.md §6 (28 sm · 32 md default). */
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  accent: 'bg-accent text-on-accent hover:bg-accent-hover data-[pressed]:bg-accent-down',
  outline: 'bg-card text-fg border border-border hover:bg-sunken hover:border-border-hover',
  quiet: 'bg-transparent text-fg hover:bg-overlay',
  negative: 'bg-negative-fg text-on-accent hover:opacity-90',
  'negative-outline': 'bg-card text-negative-fg border border-negative-fg hover:bg-negative-bg',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-xs',
  md: 'h-8 px-4 text-sm',
};

export interface OkButtonProps extends ButtonProps {
  /** Visual variant. Defaults to the primary accent pill. */
  variant?: ButtonVariant;
  /** Control height. Defaults to 32px (md). */
  size?: ButtonSize;
}

/**
 * OpenKit button primitive.
 *
 * Wraps React Aria's `Button` (focus, keyboard, and ARIA behavior) and applies
 * Spectrum-tokened Tailwind styling. This is the primitive-tier pattern from the
 * rebuild-stack spec: React Aria behavior + semantic-token styling, never a
 * decorative div. The disabled state uses the disabled bg/content/border tokens
 * (DESIGN.md §9.3).
 */
export function Button({ variant = 'accent', size = 'md', className, ...props }: OkButtonProps) {
  return (
    <AriaButton
      {...props}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-full font-bold',
        'outline-none transition-colors [transition-timing-function:var(--ease-ok)]',
        'focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg disabled:border-disabled-border',
        SIZE[size],
        VARIANT[variant],
        typeof className === 'string' ? className : '',
      ].join(' ')}
    />
  );
}
