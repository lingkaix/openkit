import { useNavigate } from 'react-router-dom';
import {
  ActionButton,
  EmptyState,
  InlineAlert,
  NavRow,
  Page,
  PageHeader,
  Skeleton,
} from '../../primitives';
import { threadPath, useCurrentWorkspaceId, useRestoreThread, useThreads } from '../chat/data';

/**
 * Archived threads for the selected Workspace (DESIGN.md §3.1 compact row).
 *
 * The active Conversations list excludes archived rows. This surface lists
 * only archived Threads and restores through the existing Thread update.
 */
export function ArchivedThreadsScreen() {
  const navigate = useNavigate();
  const workspaceId = useCurrentWorkspaceId();
  const threads = useThreads(workspaceId);
  const restore = useRestoreThread();
  const archived = (threads.data ?? []).filter((thread) => thread.status === 'archived');
  const failedRestore = restore.isError ? restore.variables : undefined;

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Archived threads"
        subtitle="Archived conversations for this Workspace."
      />

      {!workspaceId || threads.isLoading ? (
        <Skeleton lines={4} />
      ) : threads.isError ? (
        <InlineAlert
          message="Couldn't load archived threads."
          onRetry={() => void threads.refetch()}
        />
      ) : archived.length === 0 ? (
        <EmptyState
          icon="archive"
          title="No archived threads"
          hint="Archived conversations for this Workspace will show up here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {failedRestore && failedRestore.workspaceId === workspaceId ? (
            <InlineAlert
              message="Couldn't restore that thread."
              onRetry={() => restore.mutate(failedRestore)}
            />
          ) : null}
          <section className="flex flex-col gap-1">
            {archived.map((thread) => (
              <div key={thread.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <NavRow
                    icon="chat"
                    label={thread.name ?? thread.preview}
                    onPress={() => workspaceId && navigate(threadPath(workspaceId, thread.id))}
                  />
                </div>
                <ActionButton
                  size="sm"
                  isQuiet
                  isDisabled={!workspaceId || restore.isPending}
                  onPress={() =>
                    restore.mutate({ workspaceId: workspaceId ?? '', threadId: thread.id })
                  }
                >
                  Restore
                </ActionButton>
              </div>
            ))}
          </section>
        </div>
      )}
    </Page>
  );
}
