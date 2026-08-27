import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { STATUS_CLASS } from './status';

/** Item-card kinds map to the four glyph tones (DESIGN.md §9.1). */
export type ItemKind = 'informative' | 'notice' | 'positive' | 'neutral';

const KIND_ICON: Record<ItemKind, IconName> = {
  informative: 'info',
  notice: 'alert',
  positive: 'check',
  neutral: 'file',
};

export interface ItemCardProps {
  /** Event kind; badges the glyph and never renders louder than needed. */
  kind: ItemKind;
  /** Short title of the in-stream system event. */
  title: string;
  /** Optional supporting meta line. */
  meta?: string;
  /** Optional inline actions (approve/skip/reply). */
  actions?: ReactNode;
  /** Optional expanded detail. */
  children?: ReactNode;
}

/**
 * Item card (`ok-item-card`, DESIGN.md §9.1).
 *
 * A soft 10px card for in-stream system events — mode transitions, task status,
 * approvals, results. The leading glyph (`ok-item-glyph`) badges its kind.
 */
export function ItemCard({ kind, title, meta, actions, children }: ItemCardProps) {
  return (
    <div className="rounded-ok-lg border border-separator bg-card p-3 shadow-ok-card">
      <div className="flex items-start gap-3">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-ok-sm ${STATUS_CLASS[kind]}`}
          aria-hidden
        >
          <Icon name={KIND_ICON[kind]} size="sm" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-fg-strong">{title}</p>
          {meta ? <p className="mt-0.5 text-xs text-fg-muted">{meta}</p> : null}
          {children ? <div className="mt-2 text-sm text-fg">{children}</div> : null}
        </div>
      </div>
      {actions ? <div className="mt-3 flex flex-wrap gap-2 pl-9">{actions}</div> : null}
    </div>
  );
}
