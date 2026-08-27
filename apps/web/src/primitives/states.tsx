import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * System-state primitives (DESIGN.md §9.12) — first-class, not afterthoughts.
 * Every data-backed surface uses these for its non-happy states; all tint from
 * semantic tokens only.
 */

export interface SkeletonProps {
  /** Number of placeholder lines. */
  lines?: number;
  className?: string;
}

/**
 * Loading skeleton (`ok-skeleton`). Neutral placeholder bars on
 * `--surface-skeleton`, shaped like the content they precede. No spinner as the
 * primary loading device.
 */
export function Skeleton({ lines = 3, className }: SkeletonProps) {
  return (
    <div
      className={`flex flex-col gap-2 ${className ?? ''}`}
      role="status"
      aria-label="Loading"
      aria-live="polite"
    >
      {Array.from({ length: lines }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static placeholder bars
          key={i}
          className={`h-3 rounded bg-skeleton ${i === lines - 1 ? 'w-1/2' : i % 2 ? 'w-3/4' : 'w-full'}`}
        />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  /** Glyph shown in the soft round badge. */
  icon?: IconName;
  title: string;
  /** One line of plain guidance. */
  hint?: string;
  /** A single primary action (e.g. a Button). */
  action?: ReactNode;
}

/**
 * Empty state (`ok-empty`). A calm centered block: a soft round glyph, a short
 * title, one line of guidance, and a single primary action. First-run onboarding
 * is the app-level case of this pattern.
 */
export function EmptyState({ icon = 'chat', title, hint, action }: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-sunken text-fg-muted">
        <Icon name={icon} size="lg" />
      </span>
      <div>
        <p className="text-sm font-bold text-fg-strong">{title}</p>
        {hint ? <p className="mt-1 text-sm text-fg-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export interface ErrorBannerProps {
  /** Plain-language message; never a raw stack trace in the main flow. */
  message: string;
  /** Called when the user retries. Renders a "Try again" action when provided. */
  onRetry?: () => void;
}

/**
 * Error banner (`ok-error`). An inline negative-family banner with a plain
 * message and an optional Try again action. Errors are recoverable and stated in
 * plain language.
 */
export function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-ok bg-negative-bg px-3 py-2 text-sm font-medium text-negative-fg"
    >
      <Icon name="error" />
      <span className="flex-1">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-ok px-2 py-0.5 text-xs font-bold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
