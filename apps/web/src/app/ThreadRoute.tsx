import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { InlineAlert } from '../primitives';
import {
  type ThreadRouteState,
  threadActivityHint,
  useConversationNavigation,
} from '../screens/chat/data';
import { SteerThreadScreen } from '../screens/chat/timeline/steer-screen';
import { GoalScreen } from '../screens/goal';
import { useSurfaceParams } from './route-params';

type ThreadMode = ThreadRouteState['threadActivity'];

/** The Thread route's activity: decided, still resolving, or blocked on a retryable read. */
export type ThreadRouteMode =
  | { mode: ThreadMode; failed?: undefined; retry?: undefined }
  | { mode: null; failed: boolean; retry: () => void };

/**
 * The activity a Thread route visit opens with (ia.md §2: one route, the page adapts).
 *
 * The opener's hint wins (a sidebar row, a redirected `/tasks/` link, a new Goal), then the
 * navigation row. Navigation is paged, so a Thread absent from the loaded rows is looked up on
 * the next pages until it is found or the list ends; only then does the visit open as Chat. A
 * failed read stays retryable and never decides the activity. The mode stays fixed for the
 * visit: a later activity change in navigation does not remount the open Thread, as the old
 * typed routes did not.
 */
export function useThreadRouteMode(workspaceId: string, threadId: string): ThreadRouteMode {
  const { state } = useLocation();
  const navigation = useConversationNavigation(workspaceId || null);
  const key = `${workspaceId}/${threadId}`;
  const [locked, setLocked] = useState<{ key: string; mode: ThreadMode } | null>(null);
  const hint = threadActivityHint(state);
  const row = navigation.data?.find((candidate) => candidate.thread.id === threadId);
  const observed = row && row.activity !== 'unknown' ? row.activity : null;
  const failed = navigation.isError;
  const readMore =
    !hint && !row && navigation.isSuccess && navigation.hasNextPage && locked?.key !== key;
  const { fetchNextPage, isFetchingNextPage } = navigation;
  useEffect(() => {
    if (readMore && !isFetchingNextPage) void fetchNextPage();
  }, [readMore, isFetchingNextPage, fetchNextPage]);
  if (locked?.key === key) return { mode: locked.mode };
  const exhausted = navigation.isSuccess && !navigation.hasNextPage;
  const mode = hint ?? observed ?? (row || exhausted ? 'chat' : null);
  if (mode) {
    setLocked({ key, mode });
    return { mode };
  }
  return {
    mode: null,
    failed,
    retry: () =>
      void (navigation.isFetchNextPageError ? navigation.fetchNextPage() : navigation.refetch()),
  };
}

/** `/w/:workspaceId/t/:threadId`: the Chat, Task or Goal page for one Thread. */
export function ThreadRoute() {
  const { workspaceId = '', threadId = '' } = useSurfaceParams('thread');
  const { mode, failed, retry } = useThreadRouteMode(workspaceId, threadId);
  if (!mode) {
    return failed ? (
      <div className="px-4 py-6">
        <InlineAlert message="Couldn't open this Thread." onRetry={retry} />
      </div>
    ) : (
      <p role="status" className="px-4 py-6 text-sm text-fg-muted">
        Opening Thread…
      </p>
    );
  }
  if (mode === 'goal') return <GoalScreen key="goal" />;
  return <SteerThreadScreen key={mode} mode={mode} />;
}
