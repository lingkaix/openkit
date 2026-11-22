import {
  type ThreadRouteState,
  threadActivityHint,
  useConversationNavigation,
} from '../screens/chat/data';

/**
 * The activity of the Thread at a path, for chrome outside the route (the phone section bar).
 * Null off a Thread route. Reads the opener hint, then the cached navigation row, then Chat.
 */
export function useThreadActivityAt(
  pathname: string,
  state: unknown
): ThreadRouteState['threadActivity'] | null {
  const match = /^\/w\/([^/]+)\/t\/([^/]+)/.exec(pathname);
  const workspaceId = match?.[1] ? decodeURIComponent(match[1]) : null;
  const threadId = match?.[2] ? decodeURIComponent(match[2]) : null;
  const navigation = useConversationNavigation(workspaceId);
  if (!threadId) return null;
  const row = navigation.data?.find((candidate) => candidate.thread.id === threadId);
  const observed = row && row.activity !== 'unknown' ? row.activity : null;
  return threadActivityHint(state) ?? observed ?? 'chat';
}
