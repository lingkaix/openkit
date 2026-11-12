import { timelineCopy } from './copy';
import { anchorFromSearch } from './window';

/**
 * Honest missing-request state for the current address.
 * The window owner passes the flag. This does not search other timeline queries.
 */
export function RequestUnavailableNotice({ unavailable = false }: { unavailable?: boolean }) {
  const anchor = anchorFromSearch(typeof window === 'undefined' ? '' : window.location.search);
  if (!unavailable) return null;
  if (
    anchor.kind !== 'approval-request' &&
    anchor.kind !== 'user-input-request' &&
    anchor.kind !== 'item'
  )
    return null;
  return <p>{timelineCopy.requestUnavailable}</p>;
}
