import type { ReactNode } from 'react';
import { Avatar } from './Avatar';
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
 * A 250px column on `layer-1`. The board is a lens over goal data (D-007), never
 * a parallel world — cards open back into the conversation.
 */
export function KanbanColumn({ title, count, children }: KanbanColumnProps) {
  return (
    <section className="flex w-[250px] shrink-0 flex-col gap-2 rounded-ok-lg bg-layer-1 p-2">
      <header className="flex items-center gap-2 px-1 py-1 text-xs font-bold text-fg-muted">
        <span className="uppercase tracking-wide">{title}</span>
        {typeof count === 'number' ? <span className="text-fg-muted">{count}</span> : null}
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
 * 8px-radius card with title + worker avatar + meta. Opens back into the thread.
 */
export function KanbanCard({ title, hue, initials, worker, meta, onOpen }: KanbanCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-ok border border-separator bg-card p-2.5 text-left shadow-ok-card outline-none hover:border-border-hover focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="text-sm font-medium text-fg">{title}</span>
      <span className="flex items-center gap-2 text-xs text-fg-muted">
        <Avatar hue={hue} initials={initials} name={worker} size="sm" />
        {meta ? <span>{meta}</span> : null}
      </span>
    </button>
  );
}
