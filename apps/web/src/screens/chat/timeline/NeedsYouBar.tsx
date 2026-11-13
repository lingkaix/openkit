import type { HumanAttentionRow } from '@openkit/app-api-schemas';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCoreClient } from '../../../app/core-client';
import { accountGeneration } from '../../account/generation';
import { openHrefForRow } from '../../workspace/data';
import { timelineCopy } from './copy';
import {
  focusGoalCard,
  focusTimelineItem,
  type NeedsYouRow,
  needsYouActivation,
  needsYouSummary,
  orderNeedsYou,
  scopeNeedsYou,
  toNeedsYouRow,
} from './needs-you';
import { RequestUnavailableNotice } from './request-anchor';
import { TimelineTime } from './TimelineTime';
import { formatAgeSeconds, useReducedMotion } from './time';
import { IDLE_POLL_MS } from './window';

/**
 * Attention rows for the timeline. The same query Action Center uses.
 * A missing operation yields an empty bar so a partial test client stays quiet.
 */
export function useTimelineAttention(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ['attention', workspaceId ?? ''],
    queryFn: async () => {
      const generation = accountGeneration();
      const list = client.operations['attention.list'];
      if (typeof list !== 'function') return [] as HumanAttentionRow[];
      const page = await list({ workspaceId: workspaceId as string });
      if (generation !== accountGeneration()) {
        throw new Error('Discarded an earlier account response.');
      }
      return page.items;
    },
    enabled: Boolean(workspaceId),
    retry: false,
    refetchInterval: IDLE_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

function rowAge(row: NeedsYouRow, now?: number) {
  if (row.ageSeconds != null) {
    return (
      <time dateTime={row.createdAt} title={row.createdAt}>
        {formatAgeSeconds(row.ageSeconds)}
      </time>
    );
  }
  return <TimelineTime iso={row.createdAt} now={now} />;
}

/**
 * Pinned Needs you bar. Several rows collapse. A row leaves only when the
 * caller drops it, which is when the authoritative outcome arrives.
 */
export function NeedsYouBar({
  rows,
  threadId,
  emphasize,
  reducedMotion,
  now,
  onOpen,
  resolveAnchor,
  unavailable = false,
}: {
  rows: readonly NeedsYouRow[];
  threadId?: string;
  emphasize: boolean;
  reducedMotion: boolean;
  now?: number;
  onOpen?: (href: string) => void;
  /** Goal cards and other anchors that are not timeline items. True means the row was handled. */
  resolveAnchor?: (row: NeedsYouRow) => boolean;
  /** The current timeline window kept its body after a missing request or Item anchor. */
  unavailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [fade, setFade] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = rows.map((row) => row.id);
    if (seen.current == null) {
      seen.current = new Set(ids);
      return;
    }
    const arrived = ids.some((id) => !seen.current?.has(id));
    seen.current = new Set(ids);
    if (!arrived || reducedMotion) return;
    setFade(true);
    const timer = setTimeout(() => setFade(false), 200);
    return () => clearTimeout(timer);
  }, [reducedMotion, rows]);
  if (rows.length === 0) return <RequestUnavailableNotice unavailable={unavailable} />;
  const ordered = orderNeedsYou(rows);
  const summary = needsYouSummary(ordered);

  function activate(row: NeedsYouRow) {
    if (resolveAnchor?.(row)) return;
    const action = needsYouActivation(row);
    if (
      action.type === 'anchor' &&
      action.threadId === threadId &&
      focusTimelineItem(action.itemId)
    )
      return;
    if (action.type === 'anchor' && row.surfaceHref) {
      const href = `${row.surfaceHref}${row.surfaceHref.includes('?') ? '&' : '?'}item=${encodeURIComponent(action.itemId)}`;
      onOpen?.(href);
      return;
    }
    if (action.type === 'surface') onOpen?.(action.href);
  }

  function rowButton(row: NeedsYouRow) {
    return (
      <button type="button" className="text-left" onClick={() => activate(row)}>
        <span>{row.title}</span>
        {row.blocking ? <span> · {timelineCopy.workIsWaiting}</span> : null}
        {row.taskLabel ? <span> · {row.taskLabel}</span> : null}
        <span> · </span>
        {rowAge(row, now)}
      </button>
    );
  }

  return (
    <>
      <RequestUnavailableNotice unavailable={unavailable} />
      <section
        aria-label={timelineCopy.needsYouRegion}
        className={`ok-needs-you ${emphasize ? 'text-accent' : ''} ${fade ? 'ok-decision-arrive' : ''}`}
        {...(emphasize ? { 'data-emphasis': 'true' } : {})}
      >
        {ordered.length > 1 && !open ? (
          <button type="button" onClick={() => setOpen(true)}>
            {summary}
          </button>
        ) : (
          <ul className="flex flex-col gap-1">
            {ordered.map((row) => (
              <li key={row.id}>{rowButton(row)}</li>
            ))}
            {ordered.length > 1 ? (
              <li>
                <button type="button" onClick={() => setOpen(false)}>
                  {timelineCopy.showLess}
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </section>
    </>
  );
}

/** Goal and its linked Tasks. The board strip stays above this bar. */
export function GoalNeedsYou({
  workspaceId,
  threadIds,
  taskLabels,
  cardByThread,
  onFocusCard,
}: {
  workspaceId: string;
  threadIds: readonly string[];
  taskLabels: ReadonlyMap<string, string>;
  cardByThread?: ReadonlyMap<string, string>;
  onFocusCard?: (cardId: string) => void;
}) {
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const attention = useTimelineAttention(workspaceId);
  const rows = orderNeedsYou(scopeNeedsYou(attention.data ?? [], threadIds)).map((row) =>
    toNeedsYouRow(row, openHrefForRow(row), row.threadId ? taskLabels.get(row.threadId) : undefined)
  );
  if (rows.length === 0) return null;
  return (
    <NeedsYouBar
      rows={rows}
      emphasize
      reducedMotion={reducedMotion}
      onOpen={(href) => navigate(href)}
      resolveAnchor={(row) => {
        const cardId = row.threadId ? cardByThread?.get(row.threadId) : undefined;
        if (!cardId || !focusGoalCard(cardId)) return false;
        onFocusCard?.(cardId);
        return true;
      }}
    />
  );
}
