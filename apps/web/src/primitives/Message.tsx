import MarkdownIt from 'markdown-it';
import { type ReactNode, useMemo } from 'react';
import { Avatar } from './Avatar';
import { ChannelTag } from './ChannelTag';
import type { WorkerHue } from './status';

// Only parser-generated markup reaches the report body: no raw HTML, media, or plugins.
const reportMarkdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
reportMarkdown.validateLink = (url) => /^https?:\/\//i.test(url);
reportMarkdown.renderer.rules.image = (tokens, index) =>
  reportMarkdown.utils.escapeHtml(tokens[index]?.content ?? '');
reportMarkdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]?.attrSet('target', '_blank');
  tokens[index]?.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
for (const rule of ['heading_open', 'heading_close']) {
  reportMarkdown.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    if (token) token.tag = `h${Math.min(6, Number(token.tag.slice(1)) + 2)}`;
    return renderer.renderToken(tokens, index, options);
  };
}
// Native focusable overflow regions keep wide report evidence readable with the keyboard.
for (const rule of ['fence', 'code_block']) {
  const render = reportMarkdown.renderer.rules[rule];
  reportMarkdown.renderer.rules[rule] = (tokens, index, options, env, renderer) =>
    (render?.(tokens, index, options, env, renderer) ?? '').replace(
      '<pre>',
      '<pre tabindex="0" role="group" aria-label="Code block">'
    );
}
reportMarkdown.renderer.rules.table_open = () =>
  '<div class="overflow-x-auto" tabindex="0" role="group" aria-label="Table"><table>';
reportMarkdown.renderer.rules.table_close = () => '</table></div>';

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
  const report = useMemo(
    () => (typeof children === 'string' ? reportMarkdown.render(children) : null),
    [children]
  );
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
      {report === null ? (
        <div className="max-w-full whitespace-pre-wrap leading-relaxed text-fg">{children}</div>
      ) : (
        <div
          className="ok-message-report min-w-0 w-full max-w-full leading-relaxed text-fg"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it generates all markup with raw HTML and media disabled; links are HTTP(S) only.
          dangerouslySetInnerHTML={{ __html: report }}
        />
      )}
    </article>
  );
}
