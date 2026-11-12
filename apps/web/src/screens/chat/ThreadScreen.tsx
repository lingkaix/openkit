import { ApiCallError } from '@openkit/core-client';
import { useMutationState } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { usePersistentNavigation } from '../../app/AppShell';
import { useConnection, useCoreClient } from '../../app/core-client';
import {
  Button,
  Composer,
  type ComposerDraft,
  EmptyState,
  ErrorBanner,
  Icon,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { useArtifacts, useArtifactVersion } from '../artifacts/data';
import { PartOfGoal } from '../goal/PartOfGoal';
import {
  chatKeys,
  taskThreadPath,
  useArchiveThread,
  useComposerWorkerEnvironments,
  useConversationSubmission,
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
import { timelineCopy } from './timeline/copy';
import { classifySendFailure } from './timeline/degraded';
import { readStoredLens, writeStoredLens } from './timeline/lens-store';
import { contentAdmitted, historyModeForHref, turnIdFromSearch } from './timeline/navigation-state';
import { OwnerRunError } from './timeline/owner-error';
import { useTimelineSheets } from './timeline/PhoneChrome';
import { selectAgentProfile } from './timeline/profiles';
import { SendFailure, SendPending } from './timeline/SendState';
import type { LensName } from './timeline/types';
import { timelineReadAvailable, useTimelineWindow } from './timeline/use-timeline-window';
import {
  anchorFromSearch,
  provisionalOpeningAnchor,
  type TimelineAnchorRequest,
  timelineJump,
  turnHasCompletedAnswer,
  wantsMeasuredOpening,
} from './timeline/window';
import { composerVoice } from './voice';

export interface ThreadScreenProps {
  /** Chat framing or task framing (board 02/03 vs 04). */
  mode: 'chat' | 'task';
}

/**
 * Thread screen (WP-4) — boards 02/03 (chat) and 04 (task).
 *
 * A centered conversation column with the composer docked at the bottom (D-007),
 * an optional Details panel for this Thread's steps, files, reasoning, and outputs
 * (board 03, DESIGN.md §3.3; not the global Artifact inventory), and the inline
 * approval-card pattern (board 04) handled per-item. Honors the §9.13 states: skeleton stream,
 * inline send-failure banner, and — when the runtime is unreachable — a disabled
 * composer with a stated reason and read-only approvals (the global banner lives
 * in the shell). Rename, archive, interruption, and failed-Turn controls project
 * only the authoritative records returned by Core; a failed latest Turn shows its
 * recorded error in the header without retrying work. Earlier failed Turns keep
 * that same error beside their own stream messages. The active Turn shows its supplied
 * trigger actor with authorized participant labels, without deployment or identity inference.
 */
export function ThreadScreen({ mode }: ThreadScreenProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [updatesHost, setUpdatesHost] = useState<HTMLDivElement | null>(null);
  const { workspaceId: routeWorkspaceId = '', threadId = '' } = useParams();
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId(routeWorkspaceId);
  const thread = useThread(workspaceId, threadId);
  const dashboard = useThreadDashboard(workspaceId, threadId, true, true);
  const admissionMount = useRef<{ id: string; at: number; admitted: boolean } | null>(null);
  let admission = admissionMount.current;
  if (admission?.id !== threadId) {
    admission = { id: threadId, at: Date.now(), admitted: false };
    admissionMount.current = admission;
  }
  if (
    contentAdmitted({
      succeeded: dashboard.isSuccess,
      fetching: dashboard.isFetching,
      updatedAt: dashboard.dataUpdatedAt,
      mountedAt: admission.at,
    })
  ) {
    admission.admitted = true;
  }
  // The first successful read of this mount stays visible through later polls.
  const dashboardAdmitted = admission.admitted;
  useEffect(() => {
    if (
      !workspaceId ||
      !threadId ||
      dashboard.isFetching ||
      dashboard.isError ||
      dashboard.isRefetchError ||
      dashboardAdmitted
    ) {
      return;
    }
    void dashboard.refetch();
  }, [
    dashboard.refetch,
    dashboard.isError,
    dashboard.isFetching,
    dashboard.isRefetchError,
    dashboardAdmitted,
    threadId,
    workspaceId,
  ]);
  // Product projection that differs from recovery rewritable: composer liveness follows running only, not pending.
  const activeTurn = dashboard.data?.turns.findLast((turn) => turn.status === 'running');
  // Pending is the open Turn that is not running ("waiting"). It keeps today's 5s
  // items poll. A running Turn stays on the event stream. Terminal Turns do not poll.
  const waitingTurn = dashboard.data?.turns.some((turn) => turn.status === 'pending');
  const client = useCoreClient();
  const timelineOn = timelineReadAvailable(client);
  const explicitAnchor = anchorFromSearch(location.search);
  const openingProfile = selectAgentProfile({
    entryPath: thread.data?.entryPath,
    mode,
    loadFailed:
      thread.isError &&
      (thread.data?.entryPath === 'administration' ||
        thread.data?.entryPath === 'knowledge-manager'),
  });
  const openingProfileId =
    openingProfile.state === 'ready'
      ? openingProfile.profile.id
      : mode === 'task'
        ? 'task'
        : 'assistant';
  const [settledAnchor, setSettledAnchor] = useState<TimelineAnchorRequest | null>(null);
  const [openingThread, setOpeningThread] = useState(threadId);
  const jumpedToLatest = useRef(false);
  if (openingThread !== threadId) {
    setOpeningThread(threadId);
    setSettledAnchor(null);
    jumpedToLatest.current = false;
  }
  if (explicitAnchor.kind !== 'latest') jumpedToLatest.current = false;
  const windowAnchor =
    explicitAnchor.kind !== 'latest'
      ? explicitAnchor
      : jumpedToLatest.current
        ? { kind: 'latest' as const }
        : (settledAnchor ?? provisionalOpeningAnchor(openingProfileId, explicitAnchor));
  const measureOpening =
    explicitAnchor.kind === 'latest' &&
    !jumpedToLatest.current &&
    settledAnchor === null &&
    wantsMeasuredOpening(openingProfileId);
  const timelineWindow = useTimelineWindow({
    workspaceId,
    threadId,
    anchor: windowAnchor,
    enabled: timelineOn,
    running: Boolean(activeTurn),
    pending: Boolean(waitingTurn) && !activeTurn,
  });
  const targets = useConversationTargets(workspaceId, threadId);
  // The skeleton is the first visible paint. Keep the thread mounted so its
  // items observer shares this opening read instead of refetching when the
  // skeleton clears.
  const openingShell = workspaces.isLoading || dashboard.isLoading || targets.isLoading;
  const items = useThreadItems(
    workspaceId,
    threadId,
    Boolean(waitingTurn) && !activeTurn && !timelineOn,
    !timelineOn
  );
  const workerEnvironments = useComposerWorkerEnvironments(workspaceId, threadId);
  const workspaceArtifacts = useArtifacts(workspaceId);
  const send = useSendTurn();
  const submission = useConversationSubmission(workspaceId, threadId);
  // An exact candidate handoff seeds only an unsent input; the existing submission stays immutable.
  const candidateInput = location.state?.candidateInput;
  const hasCandidateInput = candidateInput !== undefined;
  const candidateContextMatches =
    hasCandidateInput &&
    candidateInput?.workspaceId === workspaceId &&
    candidateInput?.threadId === threadId &&
    typeof candidateInput?.artifactId === 'string' &&
    Number.isSafeInteger(candidateInput?.artifactVersion) &&
    candidateInput.artifactVersion > 0 &&
    typeof candidateInput?.contentDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(candidateInput.contentDigest);
  const unfinishedSubmission = submission?.status === 'pending' || submission?.status === 'error';
  const exactCandidate = useArtifactVersion(
    workspaceId ?? '',
    candidateContextMatches ? candidateInput.artifactId : '',
    candidateContextMatches ? candidateInput.artifactVersion : 1,
    candidateContextMatches && !unfinishedSubmission
  );
  // The existing draft and chip consumers read the Artifact projection from this exact response.
  const candidate = { ...exactCandidate, data: exactCandidate.data?.artifact };
  const candidateLoading =
    hasCandidateInput && !unfinishedSubmission && candidateContextMatches && candidate.isPending;
  const candidateUnavailable =
    hasCandidateInput &&
    !unfinishedSubmission &&
    !candidateLoading &&
    (!candidateContextMatches ||
      candidate.isError ||
      candidate.data?.workspaceId !== workspaceId ||
      candidate.data?.id !== candidateInput.artifactId ||
      candidate.data?.status !== 'ready' ||
      candidate.data?.version !== candidateInput.artifactVersion ||
      candidate.data?.contentDigest !== candidateInput.contentDigest);
  const candidateDraft =
    hasCandidateInput && candidateContextMatches && !unfinishedSubmission
      ? {
          artifactRefs: [
            {
              artifactId: candidateInput.artifactId,
              artifactVersion: candidateInput.artifactVersion,
            },
          ],
        }
      : undefined;
  const cancelledRequestId =
    submission?.status === 'error' &&
    submission.variables?.draft.targetRef === 'internal-role:assistant' &&
    submission.error instanceof ApiCallError &&
    submission.error.status === 499 &&
    submission.error.code === 'provider_call_aborted'
      ? submission.variables.draft.requestId
      : undefined;
  useEffect(() => {
    if (
      !submission ||
      !location.state?.submissionRequestId ||
      location.state.submissionRequestId !== submission?.variables?.draft.requestId ||
      submission.status !== 'success' ||
      !submission.data
    )
      return;
    const response = submission.data;
    if (response.receivingThreadId !== threadId || response.receivingWorkspaceId !== workspaceId) {
      navigate(taskThreadPath(response.receivingWorkspaceId, response.receivingThreadId), {
        replace: true,
      });
    } else {
      // Consume this navigation intent so a later visit never replays an old handoff.
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate, submission, threadId, workspaceId]);
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
      // Product projection that differs from sealed terminals: feedback is offered for completed Turns only.
      turn.status === 'completed' &&
      (timelineOn
        ? turnHasCompletedAnswer(timelineWindow.data?.runs ?? [], turn.id)
        : items.data?.some(
            (item) =>
              item.turnId === turn.id &&
              item.type === 'assistant-message' &&
              item.status === 'completed'
          ) === true)
  );
  const feedback = useTurnFeedback(workspaceId ?? '', threadId, feedbackTurn?.id ?? null);
  const submitFeedback = useSubmitTurnFeedback();
  const { failed: disconnected } = useConnection();
  const panelHost = useRef<HTMLDivElement>(null);
  const phone = !usePersistentNavigation();
  const sheets = useTimelineSheets();
  const [lens, setLens] = useState<LensName>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 799px)')?.matches
      ? 'work'
      : readStoredLens()
  );
  const renameButtonRef = useRef<HTMLButtonElement>(null);

  const title = thread.data?.name ?? thread.data?.preview ?? (mode === 'task' ? 'Task' : 'Chat');
  const profile = openingProfile;
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
  /** Header chip and banner stay on the latest Turn, including when it has no Items. */
  // Product projection that differs from sealed terminals: the failed header chip is failed-only.
  const failedTurn = latestTurn?.status === 'failed' ? latestTurn : undefined;
  const failedTurnMessage =
    failedTurn?.error?.message ?? (failedTurn ? timelineCopy.runFailed : null);
  const feedbackOwner =
    submitFeedback.variables?.workspaceId === workspaceId &&
    submitFeedback.variables.threadId === threadId &&
    submitFeedback.variables.turnId === feedbackTurn?.id;
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

  async function submitConversation(draft: ComposerDraft) {
    const result = send.mutateAsync({ workspaceId: workspaceId ?? '', threadId, draft });
    navigate(location.pathname, { replace: true, state: { submissionRequestId: draft.requestId } });
    await result;
  }

  if (workspaces.isError && !openingShell) {
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
    return openingShell ? (
      <Skeleton lines={5} className="m-6" />
    ) : (
      <EmptyState
        icon="error"
        title="Workspace unavailable"
        hint="This Thread does not belong to an available Workspace."
      />
    );
  }

  return (
    <>
      {openingShell ? <Skeleton lines={5} className="m-6" /> : null}
      <div
        hidden={openingShell || undefined}
        className="@container/thread relative isolate flex h-full"
        data-agent-profile={profile.state === 'ready' ? profile.profile.id : 'error'}
      >
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-separator px-6 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {mode === 'task' ? (
                <span className="shrink-0" title="Task">
                  <Icon name="agents" size="lg" label="Task" />
                </span>
              ) : null}
              <h1 className="min-w-0 truncate text-sm font-bold text-fg-strong">{title}</h1>
              {mode === 'task' ? (
                <PartOfGoal
                  workspaceId={workspaceId}
                  threadId={threadId}
                  parentThreadId={thread.data?.parentThreadId}
                />
              ) : null}
              <Button
                ref={renameButtonRef}
                size="sm"
                variant="quiet"
                aria-label="Rename thread"
                title="Rename thread"
                className="h-8 w-8 shrink-0 px-0!"
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
                <Icon name="edit" size="lg" />
              </Button>
              <Button
                size="sm"
                variant="quiet"
                aria-label="Archive thread"
                title="Archive thread"
                className="h-8 w-8 shrink-0 px-0!"
                isDisabled={
                  !workspaceId ||
                  archiveState?.status === 'pending' ||
                  thread.data?.status === 'archived'
                }
                onPress={() => archive.mutate({ workspaceId: workspaceId ?? '', threadId })}
              >
                <Icon name="archive" size="lg" />
              </Button>
              {thread.data?.status === 'archived' ? (
                <StatusChip tone="neutral">Archived</StatusChip>
              ) : null}
              {latestTurn?.status === 'interrupted' ? (
                // Product projection that differs from sealed terminals: the interrupted header chip is interrupted-only.
                <StatusChip tone="neutral">Interrupted</StatusChip>
              ) : null}
              {failedTurn ? <StatusChip tone="negative">Failed</StatusChip> : null}
            </div>
            {/* The phone header is the title only; the trigger line overlapped its icons at 360 px. */}
            {activeTurn && !phone ? (
              <p className="min-w-0 shrink truncate text-xs text-fg-muted">
                Triggered by{' '}
                {dashboard.data?.participants?.find(
                  (participant) =>
                    participant.kind === activeTurn.triggerActor.kind &&
                    participant.id === activeTurn.triggerActor.id
                )?.displayName ?? activeTurn.triggerActor.id}
                {activeTurn.triggerActor.kind === 'user' &&
                activeTurn.triggerActor.id === dashboard.data?.viewerUserId
                  ? ' (You)'
                  : ''}
              </p>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              {activeTurn && !phone ? (
                <div className="flex flex-col items-end gap-1">
                  <p id="stop-consequence">{timelineCopy.stopConsequence}</p>
                  {interruptState?.status === 'pending' ? (
                    <p id="stop-wait" role="status">
                      {timelineCopy.stopping} {timelineCopy.waitForStop}
                    </p>
                  ) : null}
                  <Button
                    size="sm"
                    variant="negative-outline"
                    isDisabled={!workspaceId || interruptState?.status === 'pending'}
                    aria-describedby={
                      interruptState?.status === 'pending' ? 'stop-wait' : 'stop-consequence'
                    }
                    onPress={() =>
                      interrupt.mutate({
                        workspaceId: workspaceId ?? '',
                        threadId,
                        turnId: activeTurn.id,
                      })
                    }
                  >
                    {timelineCopy.stopRun}
                  </Button>
                </div>
              ) : null}
              <fieldset
                aria-label={timelineCopy.lensName}
                className="m-0 flex min-w-0 gap-1 border-0 p-0"
              >
                {(['work', 'full'] as const).map((choice) => (
                  <Button
                    key={choice}
                    size="sm"
                    variant={lens === choice ? 'outline' : 'quiet'}
                    aria-label={
                      choice === 'work' ? timelineCopy.lensWorkName : timelineCopy.lensFullName
                    }
                    aria-pressed={lens === choice}
                    onPress={() => {
                      setLens(choice);
                      writeStoredLens(choice);
                      if (phone && choice === 'full') {
                        const turnId = dashboard.data?.turns.at(-1)?.id;
                        if (turnId) sheets.open('steps', turnId);
                      }
                    }}
                  >
                    {choice === 'work' ? timelineCopy.lensWork : timelineCopy.lensFull}
                  </Button>
                ))}
              </fieldset>
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
                      renameButtonRef.current?.focus();
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
                message={timelineCopy.stopFailed}
                onRetry={() => interrupt.mutate(interruptState.variables!)}
              />
            </div>
          ) : null}
          {failedTurn?.error?.presentation ? (
            <div className="border-b border-separator px-6 py-3">
              <OwnerRunError presentation={failedTurn.error.presentation} />
            </div>
          ) : failedTurnMessage ? (
            <div className="border-b border-separator px-6 py-3">
              <ErrorBanner message={failedTurnMessage} />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto" data-timeline-scroll>
            <div className="mx-auto w-full max-w-[760px] px-6 py-6">
              {dashboard.isError && !dashboardAdmitted ? (
                <ErrorBanner
                  message={timelineCopy.protectedEntryFailed}
                  onRetry={() => void dashboard.refetch()}
                />
              ) : (
                <ThreadStream
                  workspaceId={workspaceId}
                  threadId={threadId}
                  readOnly={disconnected}
                  focusTurnId={turnIdFromSearch(new URLSearchParams(location.search))}
                  focusItemId={new URLSearchParams(location.search).get('item')}
                  anchor={windowAnchor}
                  measureOpening={measureOpening}
                  onOpeningSettle={setSettledAnchor}
                  running={Boolean(activeTurn)}
                  pending={Boolean(waitingTurn) && !activeTurn}
                  holdContent={dashboard.data != null && !dashboardAdmitted}
                  onJumpToLatest={() => {
                    jumpedToLatest.current = true;
                    setSettledAnchor({ kind: 'latest' });
                    const target = timelineJump({
                      pathname: location.pathname,
                      search: location.search,
                      jump: { kind: 'latest' },
                    });
                    navigate(
                      { pathname: target.pathname, search: target.search },
                      { replace: true }
                    );
                  }}
                  onJumpToItem={(itemId) => {
                    const target = timelineJump({
                      pathname: location.pathname,
                      search: location.search,
                      jump: { kind: 'item', itemId },
                    });
                    navigate(
                      { pathname: target.pathname, search: target.search },
                      { replace: true }
                    );
                  }}
                  emptyTitle={mode === 'task' ? 'This task has no activity yet' : 'No messages yet'}
                  panelHost={panelHost}
                  lens={lens}
                  mode={mode}
                  stopPending={interruptState?.status === 'pending'}
                  onOpen={(href) =>
                    navigate(href, {
                      replace: historyModeForHref(location.pathname, href) === 'replace',
                    })
                  }
                  sheets={sheets}
                  updatesHost={updatesHost}
                />
              )}
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

          <div ref={setUpdatesHost} data-new-updates-dock="bar" className="flex justify-center" />

          <div
            data-composer-dock="true"
            className="border-t border-separator bg-layer-1 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            <div className="mx-auto w-full max-w-[760px]">
              {submission?.status === 'pending' ? <SendPending /> : null}
              {submission?.status === 'error' ? (
                cancelledRequestId ? (
                  <p role="alert" className="mb-2 text-xs font-medium text-negative-fg">
                    {timelineCopy.runStopped}
                  </p>
                ) : (
                  <SendFailure
                    error={submission.error}
                    requestId={submission.variables?.draft.requestId}
                    onRetry={() => {
                      const draft = submission.variables?.draft;
                      if (draft) void submitConversation(draft);
                    }}
                    onEdit={() => {
                      document
                        .querySelector<HTMLTextAreaElement>('textarea[name="message"], textarea')
                        ?.focus();
                    }}
                  />
                )
              ) : null}
              {hasCandidateInput && unfinishedSubmission ? (
                <p role="status" className="mb-2 text-sm text-fg-muted">
                  {timelineCopy.candidateNotAdded}
                </p>
              ) : null}
              {candidateUnavailable ? (
                <ErrorBanner
                  message="The selected candidate is unavailable or has changed. Return to its review and select an available candidate."
                  onRetry={candidateContextMatches ? () => void candidate.refetch() : undefined}
                />
              ) : null}
              {candidateLoading ? (
                <p role="status" className="text-sm text-fg-muted">
                  Checking the selected candidate.
                </p>
              ) : (
                <Composer
                  fileWorkspaceLabel={
                    workspaces.data?.find((workspace) => workspace.id === workspaceId)?.name
                  }
                  key={JSON.stringify([workspaceId, threadId])}
                  initialDraft={
                    submission?.status === 'success'
                      ? {
                          targetRef: submission.variables?.draft.targetRef,
                          logicalModelId: submission.variables?.draft.logicalModelId,
                          ...candidateDraft,
                        }
                      : (submission?.variables?.draft ?? candidateDraft)
                  }
                  isSubmitting={submission?.status === 'pending'}
                  lastAdmittedEffort={
                    dashboard.data?.turns.findLast((turn) => turn.reasoningEffort !== undefined)
                      ?.reasoningEffort
                  }
                  cancelledRequestId={cancelledRequestId}
                  completedRequestId={
                    submission?.status === 'success'
                      ? submission.variables?.draft.requestId
                      : undefined
                  }
                  targetCatalog={
                    taskDefaultTarget && targets.data
                      ? { ...targets.data, defaultTargetRef: taskDefaultTarget.targetRef }
                      : (targets.data ?? null)
                  }
                  artifacts={(hasCandidateInput && !unfinishedSubmission
                    ? candidateUnavailable
                      ? []
                      : candidate.data
                        ? [candidate.data]
                        : []
                    : (workspaceArtifacts.data ?? [])
                  ).map((artifact) => ({
                    id: artifact.id,
                    version: artifact.version,
                    label: artifact.title,
                  }))}
                  variant={mode === 'chat' ? 'assistant' : undefined}
                  workerEnvironments={workerEnvironments}
                  disabledReason={
                    disconnected
                      ? 'OpenKit needs a connection.'
                      : submission?.status === 'error' &&
                          classifySendFailure(submission.error) === 'kept' &&
                          (latestTurn?.status === 'running' || latestTurn?.status === 'pending')
                        ? timelineCopy.keepDraft
                        : targets.isError
                          ? "Couldn't load conversation agents."
                          : candidateUnavailable
                            ? 'The selected candidate is unavailable or has changed.'
                            : hasCandidateInput && !unfinishedSubmission && candidate.isFetching
                              ? 'Checking the selected candidate.'
                              : undefined
                  }
                  voice={composerVoice({
                    client,
                    workspaceId,
                    threadId,
                    catalog:
                      taskDefaultTarget && targets.data
                        ? { ...targets.data, defaultTargetRef: taskDefaultTarget.targetRef }
                        : targets.data,
                  })}
                  onSubmit={submitConversation}
                  phoneRun={
                    phone
                      ? {
                          steerReason: timelineCopy.steerUnavailable,
                          stop: activeTurn
                            ? {
                                label: timelineCopy.stopRun,
                                pending: interruptState?.status === 'pending',
                                consequence: timelineCopy.stopConsequence,
                                waitReason: `${timelineCopy.stopping} ${timelineCopy.waitForStop}`,
                                onStop: () =>
                                  interrupt.mutate({
                                    workspaceId: workspaceId ?? '',
                                    threadId,
                                    turnId: activeTurn.id,
                                  }),
                              }
                            : undefined,
                        }
                      : undefined
                  }
                />
              )}
            </div>
          </div>
        </div>
        <div ref={panelHost} className="contents" />
      </div>
    </>
  );
}
