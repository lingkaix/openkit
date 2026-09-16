import type { ReactNode } from 'react';
import { Avatar } from './Avatar';
import { ChannelTag } from './ChannelTag';
import type { WorkerHue } from './status';

export interface UserMessageProps {
  /** Canonical display name, or the recorded actor id when unavailable. */
  author: string;
  /** True only for the authenticated human account. */
  isSelf: boolean;
  children: ReactNode;
}

/** Human message with a circular identity row and a bubble; only the viewer aligns right. */
export function UserMessage({ author, isSelf, children }: UserMessageProps) {
  return (
    <article
      aria-label={`Message from ${author}${isSelf ? ' (You)' : ''}`}
      className={`flex min-w-0 flex-col gap-2 ${isSelf ? 'items-end' : 'items-start'}`}
    >
      <div
        className={`flex max-w-full items-center gap-2 text-xs text-fg-muted ${isSelf ? 'flex-row-reverse' : ''}`}
      >
        <Avatar
          hue="you"
          initials={Array.from(author).slice(0, 2).join('').toUpperCase()}
          name={author}
          size="sm"
        />
        <span className="min-w-0 font-bold text-fg">{author}</span>
        {isSelf ? <span>You</span> : null}
      </div>
      <div className="max-w-[min(100%,620px)] whitespace-pre-wrap rounded-ok-xl bg-sunken px-4 py-2.5 text-fg">
        {children}
      </div>
    </article>
  );
}

export interface AssistantMessageProps {
  /** Author identity hue (a worker, or "you"). */
  hue: WorkerHue;
  /** Author initials. */
  initials: string;
  /** Author display name. */
  author: string;
  /** Relative time, e.g. "2m ago". */
  time?: string;
  /** Origin channel; renders a quiet "via …" tag when set. */
  via?: string;
  children: ReactNode;
}

/**
 * Assistant message (`ok-msg-assistant`, DESIGN.md §9.1).
 *
 * Calm unboxed flow with a small identity meta row (avatar · author · time ·
 * optional channel tag).
 */
export function AssistantMessage({
  hue,
  initials,
  author,
  time,
  via,
  children,
}: AssistantMessageProps) {
  return (
    <article
      aria-label={`Message from ${author}`}
      className="flex min-w-0 max-w-[680px] flex-col items-start gap-2"
    >
      <div className="flex max-w-full items-center gap-2 text-xs text-fg-muted">
        <Avatar hue={hue} initials={initials} name={author} size="sm" />
        <span className="min-w-0 font-bold text-fg">{author}</span>
        {time ? <span>{time}</span> : null}
        {via ? <ChannelTag channel={via} /> : null}
      </div>
      <div className="max-w-full whitespace-pre-wrap leading-relaxed text-fg">
        {children}
      </div>
    </article>
  );
}
