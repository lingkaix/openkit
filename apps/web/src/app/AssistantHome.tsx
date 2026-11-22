import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InlineAlert } from '../primitives';
import {
  threadPath,
  threadRouteState,
  useConversationNavigation,
  useCurrentWorkspaceId,
} from '../screens/chat/data';
import { OverviewScreen } from '../screens/workspace/OverviewScreen';

/**
 * Home address, also the host for Needs you.
 *
 * Until this Workspace has an Assistant timeline, `/` opens Needs you.
 * Once a chat-classified thread exists, `/` opens that timeline.
 * `/needs-you` stays on this same frame, and the retired `/attention` is replaced by
 * `/needs-you` on it without a remount. Necessity: the decisions screen has to
 * subscribe to the workspace list in the shell's first commit. Ablation: a
 * `<Navigate>` mounts that screen later and reads the list a second time.
 *
 * Needs you shows Needs you only. The Personal Assistant opens from its own row and
 * the phone Assistant section, both `/assistant`.
 */
export function AssistantHome() {
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();
  const workspaceId = useCurrentWorkspaceId();
  const navigation = useConversationNavigation(workspaceId);
  const chats = (navigation.data ?? []).filter((item) => item.activity === 'chat');
  const assistant = chats.find((item) => item.thread.name === 'Assistant') ?? chats[0];
  const pending = !workspaceId || navigation.isPending;
  // Phone chat unmounts this frame, so the navigation cache can still be the pre-create miss.
  // A miss counts only after a read that started on this visit. Necessity: `/` must open the
  // timeline that already exists. Ablation: redirecting on the cached miss sends the bar to Needs you.
  const sawVisitFetch = useRef(false);
  if (pathname !== '/') sawVisitFetch.current = false;
  else if (navigation.isFetching) sawVisitFetch.current = true;

  useLayoutEffect(() => {
    if (pathname === '/attention') navigate(`/needs-you${search}${hash}`, { replace: true });
  }, [hash, navigate, pathname, search]);

  useLayoutEffect(() => {
    if (pathname !== '/') return;
    // BrowserRouter writes history before React applies that location. This effect
    // can still observe `/` after a click has already moved history, and its replace
    // would discard the click.
    if (window.location.pathname !== '/') return;
    if (pending || navigation.isError || !workspaceId) return;
    if (assistant) {
      navigate(threadPath(workspaceId, assistant.thread.id), {
        replace: true,
        state: threadRouteState('chat'),
      });
      return;
    }
    if (!sawVisitFetch.current || navigation.isFetching) return;
    navigate('/needs-you', { replace: true });
  }, [
    assistant,
    navigate,
    navigation.isError,
    navigation.isFetching,
    pathname,
    pending,
    workspaceId,
  ]);

  if (pathname === '/' && navigation.isError) {
    return (
      <div className="px-4 py-6">
        <InlineAlert message="Couldn't open Assistant." onRetry={() => void navigation.refetch()} />
      </div>
    );
  }

  if (pathname === '/' && !pending && assistant) {
    return (
      <p role="status" className="px-4 py-6 text-sm text-fg-muted">
        Loading Assistant…
      </p>
    );
  }

  return (
    <>
      {pathname === '/' && pending ? (
        <p role="status" className="px-4 py-6 text-sm text-fg-muted">
          Loading Assistant…
        </p>
      ) : null}
      <OverviewScreen />
    </>
  );
}
