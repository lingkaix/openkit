import { useLayoutEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ErrorBanner } from '../primitives';
import {
  chatThreadPath,
  useConversationNavigation,
  useCurrentWorkspaceId,
} from '../screens/chat/data';
import { OverviewScreen } from '../screens/workspace/OverviewScreen';

/**
 * Home address, also the host for Action Center.
 *
 * Until this Workspace has an Assistant timeline, `/` opens Action Center.
 * Once a chat-classified thread exists, `/` opens that timeline.
 * `/attention` stays on this same frame. Necessity: the decisions screen has to
 * subscribe to the workspace list in the shell's first commit. Ablation: a
 * `<Navigate>` mounts that screen later and reads the list a second time.
 */
export function AssistantHome() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const workspaceId = useCurrentWorkspaceId();
  const navigation = useConversationNavigation(workspaceId);
  const chats = (navigation.data ?? []).filter((item) => item.activity === 'chat');
  const assistant = chats.find((item) => item.thread.name === 'Assistant') ?? chats[0];
  const pending = !workspaceId || navigation.isPending;

  useLayoutEffect(() => {
    if (pathname !== '/') return;
    if (pending || navigation.isError || !workspaceId) return;
    if (!assistant) {
      navigate('/attention', { replace: true });
      return;
    }
    navigate(chatThreadPath(workspaceId, assistant.thread.id), { replace: true });
  }, [assistant, navigate, navigation.isError, pathname, pending, workspaceId]);

  if (pathname === '/' && navigation.isError) {
    return (
      <div className="px-4 py-6">
        <ErrorBanner message="Couldn't open Assistant." onRetry={() => void navigation.refetch()} />
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
