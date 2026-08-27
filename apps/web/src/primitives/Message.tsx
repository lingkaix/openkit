import type { ReactNode } from 'react';
import { Avatar } from './Avatar';
import { ChannelTag } from './ChannelTag';
import type { WorkerHue } from './status';

export interface UserMessageProps {
  children: ReactNode;
}

/**
 * User message (`ok-msg-user`, DESIGN.md §9.1).
 *
 * Right-aligned soft sunken bubble, 16px radius.
 */
export function UserMessage({ children }: UserMessageProps) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[620px] rounded-ok-xl bg-sunken px-4 py-2.5 text-fg">{children}</div>
    </div>
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
    <div className="flex max-w-[680px] flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <Avatar hue={hue} initials={initials} name={author} size="sm" />
        <span className="font-bold text-fg">{author}</span>
        {time ? <span>{time}</span> : null}
        {via ? <ChannelTag channel={via} /> : null}
      </div>
      <div className="leading-relaxed text-fg">{children}</div>
    </div>
  );
}
