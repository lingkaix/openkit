import type { ReactNode } from 'react';
import { Button } from './Button';
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
 * 18px title in the heading weight, one line of guidance, and a single primary action. First-run onboarding
 * is the app-level case of this pattern.
 */
export function EmptyState({ icon = 'chat', title, hint, action }: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-sunken text-fg-muted">
        <Icon name={icon} size="lg" />
      </span>
      <div>
        <p className="text-lg font-heading text-fg-strong">{title}</p>
        {hint ? <p className="mt-1 text-sm text-fg-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export type InlineAlertVariant = 'neutral' | 'informative' | 'positive' | 'notice' | 'negative';

export interface InlineAlertProps {
  /** Plain-language message: the cause in user words (P13); never a raw stack trace. */
  message: ReactNode;
  /** Optional bold heading above the message. */
  title?: string;
  /** Semantic family; defaults to negative (a failure). */
  variant?: InlineAlertVariant;
  /** Called when the user retries. Renders a "Try again" action when provided. */
  onRetry?: () => void;
  /** Another next step instead of (or beside) Try again, e.g. a Link or Button. */
  action?: ReactNode;
}

const ALERT_BORDER: Record<InlineAlertVariant, string> = {
  neutral: 'border-neutral-fg',
  informative: 'border-info-fg',
  positive: 'border-positive-fg',
  notice: 'border-notice-fg',
  negative: 'border-negative-fg',
};

const ALERT_ICON: Record<InlineAlertVariant, IconName | null> = {
  neutral: null,
  informative: 'info',
  positive: 'check',
  notice: 'alert',
  negative: 'error',
};

const ALERT_INK: Record<InlineAlertVariant, string> = {
  neutral: 'text-neutral-fg',
  informative: 'text-info-fg',
  positive: 'text-positive-fg',
  notice: 'text-notice-fg',
  negative: 'text-negative-fg',
};

/**
 * InlineAlert (S2 InLineAlert, DESIGN.md §9.12; replaced the error banner in WEB-UX A4).
 *
 * A bordered notice in the flow of a surface: a 2px family-colored border on the card
 * surface, the family icon at the end of the first line, the message in default text and
 * one next step. Negative alerts announce as `alert`; the others as `status`. Show one alert
 * per cause on a surface (F28): repeat targets go in the message, not in more alerts.
 */
export function InlineAlert({
  message,
  title,
  variant = 'negative',
  onRetry,
  action,
}: InlineAlertProps) {
  const icon = ALERT_ICON[variant];
  return (
    <div
      role={variant === 'negative' ? 'alert' : 'status'}
      data-variant={variant}
      className={`ok-inline-alert flex flex-col gap-2 rounded-ok-lg border-2 bg-card p-3 text-sm text-fg ${ALERT_BORDER[variant]}`}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {title ? <p className="font-bold text-fg-strong">{title}</p> : null}
          <div className="min-w-0">{message}</div>
        </div>
        {icon ? <Icon name={icon} className={ALERT_INK[variant]} /> : null}
      </div>
      {onRetry || action ? (
        <div className="flex flex-wrap items-center gap-2">
          {onRetry ? (
            <Button variant="secondary" size="sm" onPress={onRetry}>
              Try again
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
