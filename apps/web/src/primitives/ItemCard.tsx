import type { ReactNode } from 'react';
import { ButtonGroup } from './Button';
import { Icon, type IconName } from './Icon';

/** Item kinds map to the four glyph tones (DESIGN.md §9.1). */
export type ItemKind = 'informative' | 'notice' | 'positive' | 'neutral';

const KIND_ICON: Record<ItemKind, IconName> = {
  informative: 'info',
  notice: 'alert',
  positive: 'check',
  neutral: 'file',
};

/** The status icon is drawn in the family ink; neutral items use subdued text. */
const KIND_INK: Record<ItemKind, string> = {
  informative: 'text-info-fg',
  notice: 'text-notice-fg',
  positive: 'text-positive-fg',
  neutral: 'text-fg-muted',
};

export interface ItemCardProps {
  /** Event kind; sets the status icon and its ink. */
  kind: ItemKind;
  /** Short title of the in-stream system event. */
  title: string;
  /** Optional supporting meta line. */
  meta?: string;
  /** Optional inline actions (approve/skip/reply). */
  actions?: ReactNode;
  /** Optional expanded detail. */
  children?: ReactNode;
  /**
   * A decision that waits for the person (approval, question). Only decisions are boxed:
   * every other item is an unboxed row in the stream (P6, P9).
   */
  decision?: boolean;
}

/**
 * Timeline item (`ok-item-card`, DESIGN.md §9.1).
 *
 * A decision is the one boxed thing in the stream: a layer-1 surface with a 10px radius
 * and no border or shadow. Every other system event (status, tool, file change, plan) is
 * a plain row. Both lead with a 20px status icon in the family ink; titles and metadata
 * wrap without losing long names.
 */
export function ItemCard({
  kind,
  title,
  meta,
  actions,
  children,
  decision = false,
}: ItemCardProps) {
  return (
    <div
      data-item-look={decision ? 'decision' : 'row'}
      className={
        decision ? 'ok-item-card ok-card rounded-ok-lg bg-layer-1 p-4' : 'ok-item-card py-1'
      }
    >
      <div className="flex items-start gap-3">
        <Icon name={KIND_ICON[kind]} className={`mt-px shrink-0 ${KIND_INK[kind]}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-fg-strong">{title}</p>
          {meta ? <p className="mt-0.5 text-xs text-fg-muted">{meta}</p> : null}
          {children ? <div className="mt-2 text-sm text-fg">{children}</div> : null}
        </div>
      </div>
      {actions ? <ButtonGroup className="mt-3 pl-8">{actions}</ButtonGroup> : null}
    </div>
  );
}
