import type { ReactNode } from 'react';
import { Avatar } from './Avatar';
import { Badge } from './Badge';
import type { WorkerHue } from './status';

export interface KanbanColumnProps {
  title: string;
  /** Item count shown next to the title. */
  count?: number;
  children: ReactNode;
}

/**
 * Kanban column (`ok-kanban`, DESIGN.md §9.8).
 *
 * A 250px column on `layer-1` with no border; the header is 14px bold text with the
 * count as a neutral Badge. The board is a lens over goal data (D-007), never a parallel
 * world — cards open back into the conversation.
 */
export function KanbanColumn({ title, count, children }: KanbanColumnProps) {
  return (
    <section
      aria-label={title}
      className="flex w-[250px] shrink-0 flex-col gap-2 rounded-ok-lg bg-layer-1 p-2"
    >
      <header className="flex min-h-control-md items-center gap-2 px-2 text-sm font-bold text-fg-strong">
        <span>{title}</span>
        {typeof count === 'number' ? <Badge>{count}</Badge> : null}
      </header>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export interface KanbanCardProps {
  title: string;
  /** Assigned worker identity. */
  hue: WorkerHue;
  initials: string;
  worker: string;
  /** Supporting meta (e.g. step, time). */
  meta?: string;
  /** Opens the card back into the conversation. */
  onOpen?: () => void;
}

/**
 * Kanban card (`ok-kanban` card, DESIGN.md §9.8).
 *
 * 8px-radius card on the card surface with a hairline edge and no shadow: title, worker
 * avatar and meta. Opens back into the thread.
 */
export function KanbanCard({ title, hue, initials, worker, meta, onOpen }: KanbanCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-ok border border-separator bg-card p-3 text-left outline-none hover:border-border-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <span className="text-sm font-medium text-fg">{title}</span>
      <span className="flex items-center gap-2 text-xs text-fg-muted">
        <Avatar hue={hue} initials={initials} name={worker} size="sm" />
        {meta ? <span>{meta}</span> : null}
      </span>
    </button>
  );
}
