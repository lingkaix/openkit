import type { ReactNode } from 'react';

export interface TagProps {
  children: ReactNode;
  /** Full text for the hover hint when the label truncates; defaults to string children. */
  title?: string;
}

/**
 * Tag (S2 Tag, DESIGN.md §9.3): a neutral, static label for configuration or attribution
 * (composer context, "via Slack"). 24px (30 touch), 8px radius, gray fill, no status color.
 * Long labels truncate and keep the full text as a hint.
 */
export function Tag({ children, title }: TagProps) {
  return (
    <span className="ok-tag inline-flex min-w-0 max-w-full items-center gap-1 rounded-ok bg-secondary font-medium text-fg">
      <span
        className="min-w-0 truncate"
        title={title ?? (typeof children === 'string' ? children : undefined)}
      >
        {children}
      </span>
    </span>
  );
}
