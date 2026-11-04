import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, useCoreClient } from '../../app/core-client';
import {
  Composer,
  type ComposerDraft,
  EmptyState,
  ErrorBanner,
  ListRow,
  Skeleton,
} from '../../primitives';
import { useArtifacts } from '../artifacts/data';
import {
  chatThreadPath,
  conversationThreadPath,
  useComposerWorkerEnvironments,
  useConversationNavigation,
  useConversationTargets,
  useCreateThread,
  useCurrentWorkspaceId,
  useSendTurn,
  useWorkspaces,
} from './data';

/**
 * Chat starter (WP-4, board 01) — the usable workbench first screen.
 *
 * Composer-first: describe what you need and a thread opens. Recent conversations
 * reuse the authorized conversation-navigation projection for the current
 * Workspace. No landing page (DESIGN.md §1). Honors the §9.13 states: skeleton
 * while discovery and recent conversations load, an empty block only after a successful read, an inline
 * banner if creating a chat fails, and a disabled composer with a stated reason
 * when the runtime is unreachable.
 */
export function ChatStarter() {
  const navigate = useNavigate();
  const workspaceId = useCurrentWorkspaceId();
  const workspaces = useWorkspaces();
  const navigation = useConversationNavigation(workspaceId);
  const targets = useConversationTargets(workspaceId);
  const artifacts = useArtifacts(workspaceId);
  const create = useCreateThread();
  const send = useSendTurn();
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const mounted = useRef(true);
  const workerEnvironments = useComposerWorkerEnvironments(workspaceId, null);
  const client = useCoreClient();
  const [routeError, setRouteError] = useState<string | null>(null);
  const pendingRoute = useRef<{
    receivingWorkspaceId: string;
    receivingThreadId: string;
  } | null>(null);
  const { failed: disconnected, retry: retryConnection } = useConnection();
  const createOwner = create.variables?.workspaceId === workspaceId;
  const conversations = navigation.data ?? [];
  // Retry the read that prevented authorized Workspace resolution, never navigation with a null ID.
  const recentRead = workspaces.isError ? workspaces : navigation;
  const workspaceUnavailable = !workspaceId && workspaces.isSuccess;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Starts a chat in the current workspace.
   *
   * @param draft - The exact first-message request retained for visible retry.
   */
  async function openReceivingThread(receivingWorkspaceId: string, receivingThreadId: string) {
    const listed = await client.operations['conversation.navigation']({
      workspaceId: receivingWorkspaceId,
    });
    if (!mounted.current || currentWorkspace.current !== workspaceId) return false;
    const item = listed.items.find((row) => row.thread.id === receivingThreadId);
    if (!item) {
      pendingRoute.current = { receivingWorkspaceId, receivingThreadId };
      setRouteError('The server did not classify that thread.');
      throw new Error('The server did not classify that thread.');
    }
    pendingRoute.current = null;
    setRouteError(null);
    navigate(conversationThreadPath(receivingWorkspaceId, receivingThreadId, item.activity));
    return true;
  }

  async function retryClassification() {
    const pending = pendingRoute.current;
    if (!pending) return;
    try {
      await openReceivingThread(pending.receivingWorkspaceId, pending.receivingThreadId);
    } catch {
      // The classification error stays visible. This retry does not submit again.
    }
  }

  async function start(draft: ComposerDraft) {
    if (!workspaceId) return;
    // A missing or failed navigation read is not proof that the Workspace has no Assistant.
    if (!navigation.isSuccess) {
      throw new Error('Assistant navigation is not ready.');
    }
    const assistant = navigation.data.find((row) => row.activity === 'chat');
    if (assistant) {
      const response = await send.mutateAsync({
        workspaceId,
        threadId: assistant.thread.id,
        draft,
      });
      if (!mounted.current || currentWorkspace.current !== workspaceId) return;
      await openReceivingThread(response.receivingWorkspaceId, response.receivingThreadId);
      return;
    }
    const thread = await create.mutateAsync({ workspaceId, draft });
    const submission = send.mutateAsync({ workspaceId, threadId: thread.id, draft });
    if (mounted.current && currentWorkspace.current === workspaceId) {
      navigate(chatThreadPath(workspaceId, thread.id), {
        state: { submissionRequestId: draft.requestId },
      });
    }
    // Keep failure observable through the mutation cache after this Composer unmounts.
    await submission;
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-title font-extrabold text-fg-strong">What can we get done?</h1>
        <p className="mt-1 text-fg-muted">
          Describe what you need — from a quick question to a whole project.
        </p>
      </div>

      {createOwner && create.isError ? (
        <ErrorBanner
          message="Couldn't start that chat. Try again."
          onRetry={() => create.reset()}
        />
      ) : null}
      {routeError ? (
        <ErrorBanner message={routeError} onRetry={() => void retryClassification()} />
      ) : null}

      <Composer
        variant="assistant"
        holdSubmit={
          !workspaceId || disconnected || targets.isError
            ? undefined
            : navigation.isSuccess
              ? undefined
              : navigation.isError
                ? "Couldn't load the Assistant."
                : 'Checking the Assistant.'
        }
        fileWorkspaceLabel={
          workspaces.data?.find((workspace) => workspace.id === workspaceId)?.name
        }
        targetCatalog={targets.data ?? null}
        artifacts={(artifacts.data ?? []).map((artifact) => ({
          id: artifact.id,
          version: artifact.version,
          label: artifact.title,
        }))}
        workerEnvironments={workerEnvironments}
        disabledReason={
          disconnected
            ? "Couldn't reach the local runtime."
            : targets.isError
              ? "Couldn't load conversation agents."
              : undefined
        }
        onSubmit={start}
      />

      <section className="flex flex-col gap-2">
        <p className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">Recent</p>
        {disconnected ? (
          <ErrorBanner message="Couldn't reach the local runtime." onRetry={retryConnection} />
        ) : recentRead.isError || workspaceUnavailable ? (
          <ErrorBanner
            message={
              workspaceUnavailable ? 'No workspace is available.' : "Couldn't load recent chats."
            }
            onRetry={() => void (workspaceUnavailable ? workspaces : recentRead).refetch()}
          />
        ) : !workspaceId || !navigation.isSuccess ? (
          <Skeleton lines={3} />
        ) : conversations.length === 0 ? (
          <EmptyState
            icon="chat"
            title="Start a chat"
            hint="Your recent chats will show up here."
          />
        ) : (
          conversations.map(({ thread, activity }) => (
            <ListRow key={thread.id}>
              <button
                type="button"
                onClick={() =>
                  navigate(
                    conversationThreadPath(
                      thread.owner.kind === 'workspace' ? thread.owner.workspaceId : '',
                      thread.id,
                      activity
                    )
                  )
                }
                className="flex min-w-0 flex-1 items-center gap-3 rounded-ok px-2 py-1 text-left outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {thread.name ?? thread.preview}
                </span>
              </button>
            </ListRow>
          ))
        )}
      </section>
    </div>
  );
}
