import { useMutationState } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  ArtifactRow,
  Button,
  Composer,
  ContextChip,
  ErrorBanner,
  Eyebrow,
  StatusChip,
  TextField,
} from '../../primitives';
import {
  chatKeys,
  useArchiveThread,
  useCurrentWorkspaceId,
  useInterruptTurn,
  useRenameThread,
  useSendTurn,
  useSubmitTurnFeedback,
  useThread,
  useThreadDashboard,
  useThreadItems,
  useTurnFeedback,
} from './data';
import { ThreadStream } from './ThreadStream';
import { WorkspaceSelect } from './WorkspaceSelect';

/** Right index rail (board 03) — mirrors the thread's artifacts (§3.3, D-006). */
function IndexRail({ workspaceId, threadId }: { workspaceId: string | null; threadId: string }) {
  const items = useThreadItems(workspaceId, threadId);
  const artifacts = (items.data ?? []).filter(
    (item) => item.type === 'artifact-reference' || item.type === 'file-change'
  );
  return (
    <aside
      aria-label="Artifacts index"
      className="w-60 shrink-0 border-l border-separator bg-layer-1 p-3"
    >
      <Eyebrow>Artifacts</Eyebrow>
      <div className="mt-2 flex flex-col gap-1">
        {artifacts.length === 0 ? (
          <p className="text-xs text-fg-muted">No artifacts yet.</p>
        ) : (
          artifacts.map((item) => (
            <ArtifactRow
              key={item.id}
              name={item.type === 'artifact-reference' ? item.title : item.path}
              icon="file"
            />
          ))
        )}
      </div>
    </aside>
  );
}

export interface ThreadScreenProps {
  /** Chat framing or task framing (board 02/03 vs 04). */
  mode: 'chat' | 'task';
}

/**
 * Thread screen (WP-4) — boards 02/03 (chat) and 04 (task).
 *
 * A centered conversation column with the composer docked at the bottom (D-007),
 * an optional artifacts index rail (board 03, §3.3), and the inline approval-card
 * pattern (board 04) handled per-item. Honors the §9.13 states: skeleton stream,
 * inline send-failure banner, and — when the runtime is unreachable — a disabled
 * composer with a stated reason and read-only approvals (the global banner lives
 * in the shell). Rename, archive, and interruption controls project only the
 * authoritative records returned by Core; the active Turn shows its supplied
 * trigger actor without deployment or identity inference.
 */
export function ThreadScreen({ mode }: ThreadScreenProps) {
  const { threadId = '' } = useParams();
  const navigate = useNavigate();
  const workspaceId = useCurrentWorkspaceId();
  const thread = useThread(workspaceId, threadId);
  const items = useThreadItems(workspaceId, threadId);
  const dashboard = useThreadDashboard(workspaceId, threadId);
  const activeTurn = dashboard.data?.turns.findLast((turn) => turn.status === 'running');
  const send = useSendTurn();
  const rename = useRenameThread();
  const archive = useArchiveThread();
  const interrupt = useInterruptTurn();
  const renameState = useMutationState({
    filters: { exact: true, mutationKey: chatKeys.renameMutation },
    select: (mutation) => ({
      status: mutation.state.status,
      variables: mutation.state.variables as
        | { workspaceId: string; threadId: string; name: string }
        | undefined,
    }),
  }).findLast(
    (state) => state.variables?.workspaceId === workspaceId && state.variables.threadId === threadId
  );
  const archiveState = useMutationState({
    filters: { exact: true, mutationKey: chatKeys.archiveMutation },
    select: (mutation) => ({
      status: mutation.state.status,
      variables: mutation.state.variables as { workspaceId: string; threadId: string } | undefined,
    }),
  }).findLast(
    (state) => state.variables?.workspaceId === workspaceId && state.variables.threadId === threadId
  );
  const interruptState = useMutationState({
    filters: { exact: true, mutationKey: chatKeys.interruptMutation },
    select: (mutation) => ({
      status: mutation.state.status,
      variables: mutation.state.variables as
        | { workspaceId: string; threadId: string; turnId: string }
        | undefined,
    }),
  }).findLast(
    (state) =>
      state.variables?.workspaceId === workspaceId &&
      state.variables.threadId === threadId &&
      state.variables.turnId === activeTurn?.id
  );
  const feedbackTurn = dashboard.data?.turns.findLast(
    (turn) =>
      turn.status === 'completed' &&
      items.data?.some(
        (item) =>
          item.turnId === turn.id &&
          item.type === 'assistant-message' &&
          item.status === 'completed'
      ) === true
  );
  const feedback = useTurnFeedback(workspaceId ?? '', threadId, feedbackTurn?.id ?? null);
  const submitFeedback = useSubmitTurnFeedback();
  const { failed: disconnected } = useConnection();
  const [showRail, setShowRail] = useState(mode === 'chat');

  const title = thread.data?.name ?? (mode === 'task' ? 'Task' : 'Chat');
  const [renameDrafts, setRenameDrafts] = useState<
    {
      workspaceId: string;
      threadId: string;
      name: string;
    }[]
  >([]);
  const renameDraft = renameDrafts.find(
    (draft) => draft.workspaceId === workspaceId && draft.threadId === threadId
  );
  const latestTurn = dashboard.data?.turns.at(-1);
  const feedbackOwner =
    submitFeedback.variables?.workspaceId === workspaceId &&
    submitFeedback.variables.threadId === threadId &&
    submitFeedback.variables.turnId === feedbackTurn?.id;
  const sendOwner =
    send.variables?.workspaceId === workspaceId &&
    send.variables.threadId === threadId &&
    send.variables.mode === mode;

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-separator px-6 py-3">
          {mode === 'chat' ? <WorkspaceSelect onWorkspaceChange={() => navigate('/chat')} /> : null}
          <div className="flex items-center gap-2">
            {mode === 'task' ? <StatusChip tone="informative">Task</StatusChip> : null}
            <h1 className="text-sm font-bold text-fg-strong">{title}</h1>
            {thread.data?.status === 'archived' ? (
              <StatusChip tone="neutral">Archived</StatusChip>
            ) : null}
            {latestTurn?.status === 'interrupted' ? (
              <StatusChip tone="neutral">Interrupted</StatusChip>
            ) : null}
          </div>
          {activeTurn ? (
            <p className="text-xs text-fg-muted">Triggered by {activeTurn.triggerActor.id}</p>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="quiet"
              isDisabled={!workspaceId}
              onPress={() => {
                rename.reset();
                if (workspaceId) {
                  setRenameDrafts((drafts) => [
                    ...drafts.filter(
                      (draft) => draft.workspaceId !== workspaceId || draft.threadId !== threadId
                    ),
                    { workspaceId, threadId, name: title },
                  ]);
                }
              }}
            >
              Rename thread
            </Button>
            <Button
              size="sm"
              variant="quiet"
              isDisabled={
                !workspaceId ||
                archiveState?.status === 'pending' ||
                thread.data?.status === 'archived'
              }
              onPress={() => archive.mutate({ workspaceId: workspaceId ?? '', threadId })}
            >
              Archive thread
            </Button>
            {activeTurn ? (
              <Button
                size="sm"
                variant="negative-outline"
                isDisabled={!workspaceId || interruptState?.status === 'pending'}
                onPress={() =>
                  interrupt.mutate({
                    workspaceId: workspaceId ?? '',
                    threadId,
                    turnId: activeTurn.id,
                  })
                }
              >
                Stop turn
              </Button>
            ) : null}
            <Button size="sm" variant="quiet" onPress={() => setShowRail((v) => !v)}>
              {showRail ? 'Hide index' : 'Show index'}
            </Button>
          </div>
        </header>
        {renameDraft ? (
          <div className="border-b border-separator bg-layer-1 px-6 py-3">
            <div className="ml-auto flex max-w-xl flex-col gap-2">
              <div className="flex items-end gap-2">
                <TextField
                  label="Thread name"
                  value={renameDraft.name}
                  onChange={(name) =>
                    setRenameDrafts((drafts) =>
                      drafts.map((draft) => (draft === renameDraft ? { ...draft, name } : draft))
                    )
                  }
                />
                <Button
                  size="sm"
                  variant="quiet"
                  onPress={() => {
                    rename.reset();
                    setRenameDrafts((drafts) => drafts.filter((draft) => draft !== renameDraft));
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  isDisabled={
                    renameState?.status === 'pending' || renameDraft.name.trim().length === 0
                  }
                  onPress={() =>
                    rename.mutate({
                      ...renameDraft,
                      name: renameDraft.name.trim(),
                    })
                  }
                >
                  Save
                </Button>
              </div>
              {renameState?.status === 'error' && renameState.variables ? (
                <ErrorBanner
                  message="Couldn't rename this thread."
                  onRetry={() => rename.mutate(renameState.variables!)}
                />
              ) : null}
            </div>
          </div>
        ) : null}
        {archiveState?.status === 'error' && archiveState.variables ? (
          <div className="border-b border-separator px-6 py-3">
            <ErrorBanner
              message="Couldn't archive this thread."
              onRetry={() => archive.mutate(archiveState.variables!)}
            />
          </div>
        ) : null}
        {interruptState?.status === 'error' && interruptState.variables ? (
          <div className="border-b border-separator px-6 py-3">
            <ErrorBanner
              message="Couldn't stop this turn."
              onRetry={() => interrupt.mutate(interruptState.variables!)}
            />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-6 py-6">
            <ThreadStream
              workspaceId={workspaceId}
              threadId={threadId}
              readOnly={disconnected}
              emptyTitle={mode === 'task' ? 'This task has no activity yet' : 'No messages yet'}
            />
            {feedbackTurn ? (
              <div className="mt-5 flex flex-col items-end gap-2 border-t border-separator pt-3">
                <fieldset className="flex items-center gap-2">
                  <legend className="text-xs text-fg-muted">Was this helpful?</legend>
                  {(['good', 'bad'] as const).map((rating) => (
                    <Button
                      key={rating}
                      size="sm"
                      variant={feedback.data?.rating === rating ? 'accent' : 'quiet'}
                      aria-pressed={feedback.data?.rating === rating}
                      isDisabled={feedbackOwner && submitFeedback.isPending}
                      onPress={() =>
                        submitFeedback.mutate({
                          workspaceId: workspaceId ?? '',
                          threadId,
                          turnId: feedbackTurn.id,
                          rating,
                        })
                      }
                    >
                      {rating === 'good' ? 'Good' : 'Bad'}
                    </Button>
                  ))}
                </fieldset>
                {feedbackOwner && submitFeedback.isError ? (
                  <ErrorBanner
                    message="Couldn't save feedback."
                    onRetry={() => submitFeedback.mutate(submitFeedback.variables)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="border-t border-separator px-6 py-3">
          <div className="mx-auto w-full max-w-[760px]">
            {sendOwner && send.isError ? (
              <p className="mb-2 text-xs font-medium text-negative-fg">
                Couldn't send that message. Try again.
              </p>
            ) : null}
            <Composer
              chips={<ContextChip>{title}</ContextChip>}
              disabledReason={disconnected ? "Couldn't reach the local runtime." : undefined}
              onSubmit={(message) =>
                send.mutate({ workspaceId: workspaceId ?? '', threadId, mode, message })
              }
            />
          </div>
        </div>
      </div>
      {showRail ? <IndexRail workspaceId={workspaceId} threadId={threadId} /> : null}
    </div>
  );
}
