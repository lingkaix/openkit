import { useMutationState } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  ArtifactRow,
  Button,
  Composer,
  type ComposerDraft,
  ContextChip,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  Icon,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { createRequestId, useArtifacts, useImportWorkspaceArtifact } from '../artifacts/data';
import {
  chatKeys,
  taskThreadPath,
  useArchiveThread,
  useConversationTargets,
  useCurrentWorkspaceId,
  useInterruptTurn,
  useRenameThread,
  useSendTurn,
  useSubmitTurnFeedback,
  useThread,
  useThreadDashboard,
  useThreadItems,
  useTurnFeedback,
  useWorkspaces,
} from './data';
import { ThreadStream } from './ThreadStream';

/** Right Side panel — Thread Artifact and file-change index (DESIGN.md §3.3, D-006). */
function SidePanel({ workspaceId, threadId }: { workspaceId: string | null; threadId: string }) {
  const items = useThreadItems(workspaceId, threadId);
  const artifacts = (items.data ?? []).filter(
    (item) => item.type === 'artifact-reference' || item.type === 'file-change'
  );
  return (
    <aside
      aria-label="Side panel"
      className="w-60 shrink-0 border-l border-separator bg-layer-1 p-3"
    >
      <Eyebrow>Side panel</Eyebrow>
      <p className="mt-1 text-xs text-fg-muted">Artifact and file-change index for this Thread.</p>
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
 * an optional Side panel that indexes this Thread's Artifacts and file changes
 * (board 03, DESIGN.md §3.3; not the global Artifact inventory), and the inline
 * approval-card pattern (board 04) handled per-item. Honors the §9.13 states: skeleton stream,
 * inline send-failure banner, and — when the runtime is unreachable — a disabled
 * composer with a stated reason and read-only approvals (the global banner lives
 * in the shell). Rename, archive, and interruption controls project only the
 * authoritative records returned by Core; the active Turn shows its supplied
 * trigger actor without deployment or identity inference.
 */
export function ThreadScreen({ mode }: ThreadScreenProps) {
  const navigate = useNavigate();
  const { workspaceId: routeWorkspaceId = '', threadId = '' } = useParams();
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId(routeWorkspaceId);
  const thread = useThread(workspaceId, threadId);
  const items = useThreadItems(workspaceId, threadId);
  const dashboard = useThreadDashboard(workspaceId, threadId);
  const targets = useConversationTargets(workspaceId, threadId);
  const workspaceArtifacts = useArtifacts(workspaceId);
  const importArtifact = useImportWorkspaceArtifact();
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

  const title = thread.data?.name ?? thread.data?.preview ?? (mode === 'task' ? 'Task' : 'Chat');
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
    send.variables?.workspaceId === workspaceId && send.variables.threadId === threadId;
  const taskDefaultTarget =
    mode === 'task'
      ? (targets.data?.targets.find(
          (target) =>
            target.kind === 'running-worker' &&
            target.threadId === threadId &&
            target.availability === 'available'
        ) ??
        targets.data?.targets.find(
          (target) => target.kind === 'warm-worker' && target.availability === 'available'
        ) ??
        targets.data?.targets.find(
          (target) => target.kind === 'new-task-worker' && target.availability === 'available'
        ))
      : undefined;

  async function importFile(file: File) {
    if (!workspaceId) throw new Error('Workspace is required.');
    const mediaType = file.name.endsWith('.md')
      ? 'text/markdown'
      : file.name.endsWith('.json')
        ? 'application/json'
        : 'text/plain';
    const imported = await importArtifact.mutateAsync({
      workspaceId,
      title: file.name,
      mediaType,
      content: await file.text(),
      requestId: createRequestId(),
    });
    void workspaceArtifacts.refetch();
    return { id: imported.artifactId, version: imported.artifactVersion, label: file.name };
  }

  async function submitConversation(draft: ComposerDraft) {
    const response = await send.mutateAsync({ workspaceId: workspaceId ?? '', threadId, draft });
    if (response.receivingThreadId !== threadId) {
      navigate(taskThreadPath(response.receivingWorkspaceId, response.receivingThreadId));
    }
  }

  if (workspaces.isLoading) {
    return <Skeleton lines={5} className="m-6" />;
  }

  if (workspaces.isError) {
    return (
      <div className="m-6">
        <ErrorBanner
          message="Couldn't verify this Workspace."
          onRetry={() => void workspaces.refetch()}
        />
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <EmptyState
        icon="error"
        title="Workspace unavailable"
        hint="This Thread does not belong to an available Workspace."
      />
    );
  }

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-separator px-6 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {mode === 'task' ? <StatusChip tone="informative">Task</StatusChip> : null}
            <h1 className="min-w-0 truncate text-sm font-bold text-fg-strong">{title}</h1>
            <Button
              size="sm"
              variant="quiet"
              aria-label="Rename thread"
              title="Rename thread"
              className="h-8 w-8 shrink-0 px-0"
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
              <Icon name="edit" />
            </Button>
            <Button
              size="sm"
              variant="quiet"
              aria-label="Archive thread"
              title="Archive thread"
              className="h-8 w-8 shrink-0 px-0"
              isDisabled={
                !workspaceId ||
                archiveState?.status === 'pending' ||
                thread.data?.status === 'archived'
              }
              onPress={() => archive.mutate({ workspaceId: workspaceId ?? '', threadId })}
            >
              <Icon name="archive" />
            </Button>
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
            <Button
              size="sm"
              variant="quiet"
              aria-label={showRail ? 'Hide Side panel' : 'Show Side panel'}
              title={showRail ? 'Hide Side panel' : 'Show Side panel'}
              className="h-8 w-8 px-0"
              onPress={() => setShowRail((v) => !v)}
            >
              <Icon name="view" />
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
        {!renameDraft && renameState?.status === 'error' && renameState.variables ? (
          <div className="border-b border-separator px-6 py-3">
            <ErrorBanner
              message="Couldn't rename this thread."
              onRetry={() => rename.mutate(renameState.variables!)}
            />
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
              targetCatalog={
                taskDefaultTarget && targets.data
                  ? { ...targets.data, defaultTargetRef: taskDefaultTarget.targetRef }
                  : (targets.data ?? null)
              }
              artifacts={(workspaceArtifacts.data ?? []).map((artifact) => ({
                id: artifact.id,
                version: artifact.version,
                label: artifact.title,
              }))}
              onImportFile={importFile}
              disabledReason={
                disconnected
                  ? "Couldn't reach the local runtime."
                  : targets.isError
                    ? "Couldn't load conversation agents."
                    : undefined
              }
              onSubmit={submitConversation}
            />
          </div>
        </div>
      </div>
      {showRail ? <SidePanel workspaceId={workspaceId} threadId={threadId} /> : null}
    </div>
  );
}
