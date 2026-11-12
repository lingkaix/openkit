import { QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { timelineCopy } from './copy';
import { anchorFromSearch, type HeldTimeline, type TimelineAnchorRequest } from './window';

/** Honest missing-request state. The current timeline window stays in place. */
export function RequestUnavailableNotice() {
  const client = useContext(QueryClientContext);
  const anchor = anchorFromSearch(typeof window === 'undefined' ? '' : window.location.search);
  if (!client) return null;
  if (
    anchor.kind !== 'approval-request' &&
    anchor.kind !== 'user-input-request' &&
    anchor.kind !== 'item'
  )
    return null;
  const missing = client
    .getQueriesData<HeldTimeline>({ queryKey: ['thread-timeline'] })
    .some(([key, data]) => data?.requestUnavailable === true && sameAnchor(key[3], anchor));
  if (!missing) return null;
  return <p>{timelineCopy.requestUnavailable}</p>;
}

function sameAnchor(value: unknown, anchor: TimelineAnchorRequest): boolean {
  if (!value || typeof value !== 'object') return false;
  return JSON.stringify(value) === JSON.stringify(anchor);
}
