import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Composer,
  ContextChip,
  EmptyState,
  ErrorBanner,
  ListRow,
  Skeleton,
  StatusChip,
} from '../../primitives';
import { useCreateThread, useCurrentWorkspaceId, useThreads } from './data';

/**
 * Chat starter (WP-4, board 01) — the usable workbench first screen.
 *
 * Composer-first: describe what you need and a thread opens. Recent threads sit
 * below for quick re-entry. No landing page (DESIGN.md §1). Honors the §9.13
 * states: skeleton while recent threads load, a calm empty block on first use, an
 * inline banner if creating a chat fails, and a disabled composer with a stated
 * reason when the runtime is unreachable.
 */
export function ChatStarter() {
  const navigate = useNavigate();
  const workspaceId = useCurrentWorkspaceId();
  const threads = useThreads(workspaceId);
  const create = useCreateThread();
  const { failed: disconnected } = useConnection();
  const createOwner = create.variables?.workspaceId === workspaceId;

  useEffect(() => {
    if (createOwner && create.data) navigate(`/chat/${create.data.id}`);
  }, [create.data, createOwner, navigate]);

  /**
   * Starts a chat in the current workspace.
   *
   * @param message - The submitted first message.
   */
  function start(message: string) {
    if (workspaceId) create.mutate({ workspaceId, firstMessage: message });
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

      <Composer
        size="starter"
        chips={<ContextChip>New chat</ContextChip>}
        disabledReason={disconnected ? "Couldn't reach the local runtime." : undefined}
        onSubmit={start}
      />

      <section className="flex flex-col gap-2">
        <p className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">Recent</p>
        {threads.isLoading ? (
          <Skeleton lines={3} />
        ) : threads.isError ? (
          <ErrorBanner
            message="Couldn't load recent chats."
            onRetry={() => void threads.refetch()}
          />
        ) : (threads.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon="chat"
            title="Start a chat"
            hint="Your recent chats will show up here."
          />
        ) : (
          threads.data?.map((thread) => (
            <ListRow key={thread.id}>
              <button
                type="button"
                onClick={() => navigate(`/chat/${thread.id}`)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-ok px-2 py-1 text-left outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {thread.name ?? thread.preview}
                </span>
                {thread.status === 'archived' ? (
                  <StatusChip tone="neutral">Archived</StatusChip>
                ) : null}
              </button>
            </ListRow>
          ))
        )}
      </section>
    </div>
  );
}
