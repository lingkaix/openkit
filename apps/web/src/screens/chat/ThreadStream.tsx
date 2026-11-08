import { createRequestId } from '@openkit/core-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../../app/core-client';
import { useGenerativeSourceGroups } from '../../generative/source-groups';
import { Button, EmptyState, ErrorBanner, Skeleton, TurnSeparator } from '../../primitives';
import {
  isTimelineDetail,
  type ThreadItem,
  useLiveThreadItems,
  useLoadEarlierItems,
  useRespondApproval,
  useSubmitTurnAnswers,
  useThreadItemCursor,
  useThreadItems,
  useWithdrawPendingRequest,
} from './data';
import { GenerativePresentationView } from './GenerativePresentationView';
import { ItemView } from './ItemView';
import { ThreadReadReceipts } from './ThreadReadReceipts';
import { selectedRunLabel, timelineCopy } from './timeline/copy';
import { resolveRender } from './timeline/lens';
import {
  captureCopy,
  coverageCopy,
  omittedActivityCopy,
  projectTimeline,
  runSeparatorCopy,
} from './timeline/source';

/** Seconds since a running Turn started. Zero when the timestamp cannot be read. */
function elapsedSeconds(startedAt: string): number {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
}

/** The latest tool call that is still running, if this Turn has one. */
function latestRunningStep(
  items: readonly ThreadItem[]
): Extract<ThreadItem, { type: 'tool-call' }> | undefined {
  return items.findLast(
    (item): item is Extract<ThreadItem, { type: 'tool-call' }> =>
      item.type === 'tool-call' && item.status !== 'completed' && item.status !== 'failed'
  );
}

export interface ThreadStreamProps {
  workspaceId: string | null;
  threadId: string;
  /** When true (runtime disconnected), inline approval and input actions are read-only. */
  readOnly?: boolean;
  /** Empty-state title when the thread has no items yet. */
  emptyTitle?: string;
  /** Exact retained Turn selected by a link; lookup never starts or repairs work. */
  focusTurnId?: string | null;
  /** Opens the Full rail and scrolls to this run's steps. */
  lens?: 'work' | 'full';
  onShowSteps?: (turnId: string) => void;
}

/**
 * Thread item stream (WP-4) — the conversation column (DESIGN.md §3.2).
 *
 * Renders every applicable §9.13 state: a skeleton while the read model is in
 * flight, an inline error with retry, a calm empty block, or the populated stream
 * grouped by Turn (Thread → Turn → Item). Each durable failed Turn that is not the
 * latest keeps its recorded dashboard error beside that Turn, including Turns with no
 * Items. Authorized runtime activity appears once at each Turn's final Item group, or an empty group, as plain text with explicit coverage and presentation omissions; it creates no pending request or execution state. A failed dashboard refresh suppresses cached activity until a successful read, with retry owned by the existing dashboard query. Unresolved approvals and non-secret input requests are
 * actionable inline unless read-only. Baseline readiness stays sticky only for the current
 * Workspace and Thread so later command refetches cannot tear down its live subscription.
 */
export function ThreadStream({
  workspaceId,
  threadId,
  readOnly,
  emptyTitle,
  focusTurnId,
  onShowSteps,
  lens = 'work',
}: ThreadStreamProps) {
  const connection = useConnection();
  const queryClient = useQueryClient();
  const items = useThreadItems(workspaceId, threadId);
  const cursor = useThreadItemCursor(workspaceId, threadId);
  const loadEarlier = useLoadEarlierItems(workspaceId, threadId);
  const earlierCursor =
    typeof cursor.data === 'string' && cursor.data.length > 0 ? cursor.data : null;
  const decisionScope = useRef<string | null>(null);
  const knownDecisionIds = useRef<Set<string>>(new Set());
  const decisionIds = (items.data ?? [])
    .filter((item) => item.type === 'approval-request' || item.type === 'user-input-request')
    .map((item) => item.id)
    .join('\n');
  useEffect(() => {
    if (!workspaceId || !items.isSuccess) return;
    const ids = decisionIds.length === 0 ? [] : decisionIds.split('\n');
    const scope = `${workspaceId}:${threadId}`;
    if (decisionScope.current !== scope) {
      decisionScope.current = scope;
      knownDecisionIds.current = new Set(ids);
      return;
    }
    const arrived = ids.some((id) => !knownDecisionIds.current.has(id));
    knownDecisionIds.current = new Set(ids);
    if (arrived) void queryClient.invalidateQueries({ queryKey: ['attention', workspaceId] });
  }, [decisionIds, items.isSuccess, queryClient, threadId, workspaceId]);
  const baselineCandidate =
    items.isSuccess && (items.fetchStatus === 'idle' || items.isFetchedAfterMount);
  const [baseline, setBaseline] = useState(() => ({
    workspaceId,
    threadId,
    ready: baselineCandidate,
  }));

  useEffect(() => {
    setBaseline((current) => {
      if (current.workspaceId !== workspaceId || current.threadId !== threadId) {
        return { workspaceId, threadId, ready: baselineCandidate };
      }
      if (baselineCandidate && !current.ready) return { ...current, ready: true };
      return current;
    });
  }, [baselineCandidate, threadId, workspaceId]);

  const baselineReady =
    baseline.workspaceId === workspaceId && baseline.threadId === threadId && baseline.ready;
  const sourceGroups = useGenerativeSourceGroups(items.data);
  const groupedSourceIds = new Set([...sourceGroups.values()].map((item) => item.id));
  const live = useLiveThreadItems(workspaceId, threadId, items.isSuccess, baselineReady);
  const dashboard = live.data;
  const respond = useRespondApproval(workspaceId ?? '', threadId);
  const submitAnswers = useSubmitTurnAnswers(workspaceId ?? '', threadId);
  const withdraw = useWithdrawPendingRequest(workspaceId ?? '', threadId);
  const controlsReadOnly = Boolean(readOnly || !workspaceId || !connection.connected);
  const focusedElement = useRef<HTMLDivElement>(null);
  const located = useRef<string | null>(null);
  const focusedDashboard =
    focusTurnId &&
    !live.isError &&
    dashboard?.thread.id === threadId &&
    dashboard.thread.owner.kind === 'workspace' &&
    dashboard.thread.owner.workspaceId === workspaceId
      ? dashboard
      : undefined;
  const selectedTurn = focusedDashboard?.turns.find((turn) => turn.id === focusTurnId);
  const focusKey = JSON.stringify([workspaceId, threadId, focusTurnId]);
  useEffect(() => {
    if (!selectedTurn || items.isLoading || items.isError || !focusedElement.current) {
      if (located.current !== focusKey) located.current = null;
      return;
    }
    if (located.current === focusKey) return;
    focusedElement.current.scrollIntoView({ block: 'center' });
    located.current = focusKey;
  }, [focusKey, selectedTurn, items.isLoading, items.isError]);
  const unavailableTurn = Boolean(focusTurnId && focusedDashboard && !selectedTurn);

  if (items.isLoading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <Skeleton lines={2} />
        <Skeleton lines={3} />
      </div>
    );
  }

  if (items.isError) {
    return (
      <ErrorBanner message="Couldn't load this thread." onRetry={() => void items.refetch()} />
    );
  }

  const latestTurnId = dashboard?.turns.at(-1)?.id;
  const activityByTurn = new Map(
    live.isError ? [] : dashboard?.runtimeActivity?.map((activity) => [activity.turnId, activity])
  );
  const timeline = projectTimeline({
    items: items.data ?? [],
    turns: dashboard?.turns,
    latestTurnId,
    focusTurnId: selectedTurn ? focusTurnId : null,
    activityTurnIds: new Set(activityByTurn.keys()),
  });
  const groups = timeline.groups;
  const entryByTurn = new Map(timeline.entries.map((entry) => [entry.turnId, entry]));
  const participantNames = new Map(
    dashboard?.participants?.map((participant) => [
      `${participant.kind}:${participant.id}`,
      participant.displayName,
    ])
  );
  const turnAuthors = new Map(
    dashboard?.turns.map((turn) => [
      turn.id,
      turn.agentId ? (participantNames.get(`agent:${turn.agentId}`) ?? turn.agentId) : undefined,
    ])
  );

  if (groups.length === 0 && !live.isError) {
    if (unavailableTurn)
      return <p className="text-sm text-fg-muted">{timelineCopy.runUnavailable}</p>;
    return (
      <EmptyState
        icon="chat"
        title={emptyTitle ?? 'No messages yet'}
        hint="Send a message to begin."
      />
    );
  }

  /** Explains why this request cannot currently be answered; the server remains the command authority. */
  function approvalUnavailableReason(item: ThreadItem): string | undefined {
    if (item.type !== 'approval-request') return undefined;
    if (controlsReadOnly) return 'Reconnect to respond to this approval.';
    if (live.isError)
      return 'Approval status could not be loaded. Reload this conversation to try again.';
    if (!dashboard) return 'Checking approval status…';
    const state = dashboard.pendingRequests?.find(
      (record) => record.requestId === item.approvalRequestId
    );
    if (!state) return 'Request status is unavailable. Reload this conversation to check again.';
    if (state.state !== 'pending')
      return state.state === 'inspect-only'
        ? 'This request requires inspection.'
        : `This request is ${state.state}.`;
    if (state.canRespond !== true) return 'Approval actions are unavailable for this viewer.';
    return undefined;
  }

  return (
    <ThreadReadReceipts
      key={`${workspaceId}:${threadId}:${dashboard?.viewerUserId ?? ''}`}
      workspaceId={workspaceId}
      threadId={threadId}
      viewerUserId={dashboard?.viewerUserId}
      items={items.data ?? []}
      disabled={controlsReadOnly || live.isError}
    >
      <div className="flex flex-col gap-5">
        {earlierCursor ? (
          <Button
            variant="quiet"
            size="sm"
            isDisabled={loadEarlier.isPending}
            onPress={() => loadEarlier.mutate(earlierCursor)}
          >
            Load earlier
          </Button>
        ) : null}
        {unavailableTurn ? (
          <p className="text-sm text-fg-muted">{timelineCopy.runUnavailable}</p>
        ) : null}
        {live.isError ? (
          <ErrorBanner
            message="Runtime activity is unavailable. Retry to refresh."
            onRetry={() => void live.refetch()}
          />
        ) : null}
        {groups.map((group, index) => {
          const groupTurn = dashboard?.turns.find((turn) => turn.id === group.turnId);
          const isLastGroup =
            groups.findLastIndex((candidate) => candidate.turnId === group.turnId) === index;
          const activity = groupTurn && isLastGroup ? activityByTurn.get(group.turnId) : undefined;
          const projected = entryByTurn.get(group.turnId);
          const historicalFailure =
            groupTurn?.status === 'failed' && groupTurn.id !== latestTurnId && isLastGroup
              ? (projected?.outcome?.text ?? timelineCopy.runFailed)
              : null;
          const runningStep =
            groupTurn?.status === 'running' ? latestRunningStep(group.items) : undefined;
          const actorName = groupTurn?.agentId
            ? (participantNames.get(`agent:${groupTurn.agentId}`) ?? groupTurn.agentId)
            : 'Working';
          const hasSteps = group.items.some((item) => isTimelineDetail(item));

          return (
            <div
              key={group.items[0]?.id ?? group.turnId}
              className="flex flex-col gap-4"
              ref={
                selectedTurn?.id === group.turnId &&
                groups.findIndex((candidate) => candidate.turnId === group.turnId) === index
                  ? focusedElement
                  : undefined
              }
            >
              {selectedTurn?.id === group.turnId &&
              groups.findIndex((candidate) => candidate.turnId === group.turnId) === index ? (
                <p className="text-sm text-fg-muted">{selectedRunLabel(selectedTurn.status)}</p>
              ) : null}
              {index > 0 ? <TurnSeparator label={runSeparatorCopy(index + 1)} /> : null}
              {runningStep && groupTurn ? (
                <div role="status" className="text-sm text-fg">
                  <Button variant="quiet" size="sm" onPress={() => onShowSteps?.(group.turnId)}>
                    <span>{actorName}</span>
                    <span aria-hidden="true"> · </span>
                    <span>running</span>
                    <span aria-hidden="true"> · </span>
                    <span>{elapsedSeconds(groupTurn.startedAt ?? '')} seconds</span>
                    <span aria-hidden="true"> · </span>
                    <span>{runningStep.tool}</span>
                  </Button>
                </div>
              ) : null}
              {onShowSteps && hasSteps ? (
                <Button variant="quiet" size="sm" onPress={() => onShowSteps(group.turnId)}>
                  Show steps
                </Button>
              ) : null}
              {group.items.map((item) =>
                isTimelineDetail(item) || groupedSourceIds.has(item.id) ? null : item.type ===
                  'generative-ui-reference' ? (
                  <GenerativePresentationView
                    key={item.id}
                    item={item}
                    source={sourceGroups.get(item.id)}
                  />
                ) : item.type === 'user-input-request' &&
                  (items.data ?? []).some(
                    (candidate) =>
                      candidate.type === 'user-input-response' &&
                      candidate.userInputRequestId === item.userInputRequestId
                  ) ? null : (
                  <div
                    key={item.id}
                    className="contents"
                    data-voice={resolveRender(item.type, lens).voice}
                    data-disclosure={resolveRender(item.type, lens).disclosure}
                  >
                    <ItemView
                      item={item}
                      viewerUserId={dashboard?.viewerUserId}
                      authorName={
                        'actor' in item
                          ? participantNames.get(`${item.actor.kind}:${item.actor.id}`)
                          : turnAuthors.get(item.turnId)
                      }
                      requestObjective={
                        item.type === 'user-message'
                          ? dashboard?.taskInputs?.find((entry) => entry.itemId === item.id)
                              ?.objective
                          : undefined
                      }
                      readOnly={
                        controlsReadOnly ||
                        (item.type === 'user-input-request' &&
                          (live.isError ||
                            dashboard?.pendingRequests?.find(
                              (record) => record.requestId === item.userInputRequestId
                            )?.state !== 'pending'))
                      }
                      resolvedApproval={
                        item.type === 'approval-request'
                          ? (items.data ?? []).find(
                              (
                                candidate
                              ): candidate is Extract<
                                typeof candidate,
                                { type: 'approval-decision' }
                              > =>
                                candidate.type === 'approval-decision' &&
                                candidate.approvalRequestId === item.approvalRequestId
                            )
                          : undefined
                      }
                      approvalRequestTitle={
                        item.type === 'approval-decision'
                          ? (items.data ?? []).find(
                              (
                                candidate
                              ): candidate is Extract<ThreadItem, { type: 'approval-request' }> =>
                                candidate.type === 'approval-request' &&
                                candidate.approvalRequestId === item.approvalRequestId
                            )?.title
                          : undefined
                      }
                      approvalEffect={
                        item.type === 'approval-request'
                          ? dashboard?.pendingRequests?.find(
                              (row) => row.requestId === item.approvalRequestId
                            )?.approvalEffect
                          : undefined
                      }
                      onWithdrawApproval={(pendingRequestId) =>
                        withdraw.mutate({ pendingRequestId, requestId: createRequestId() })
                      }
                      approvalUnavailableReason={approvalUnavailableReason(item)}
                      approvalPending={
                        item.type === 'approval-request' &&
                        ((respond.isPending &&
                          respond.variables?.approvalRequestId === item.approvalRequestId) ||
                          (withdraw.isPending &&
                            withdraw.variables?.pendingRequestId === item.approvalRequestId))
                      }
                      approvalError={
                        item.type === 'approval-request' &&
                        ((respond.isError &&
                          respond.variables?.approvalRequestId === item.approvalRequestId) ||
                          (withdraw.isError &&
                            withdraw.variables?.pendingRequestId === item.approvalRequestId))
                      }
                      onRetryApproval={() => {
                        if (withdraw.isError && withdraw.variables)
                          withdraw.mutate(withdraw.variables);
                        else if (respond.variables) respond.mutate(respond.variables);
                      }}
                      onApprovalDecision={(approvalRequestId, turnId, decision) =>
                        respond.mutate({
                          approvalRequestId,
                          turnId,
                          decision,
                          requestId: createRequestId(),
                        })
                      }
                      onSubmitAnswers={(userInputRequestId, answers) =>
                        submitAnswers.mutate({
                          userInputRequestId,
                          answers,
                          requestId: createRequestId(),
                        })
                      }
                      answerPending={
                        submitAnswers.isPending &&
                        item.type === 'user-input-request' &&
                        submitAnswers.variables?.userInputRequestId === item.userInputRequestId
                      }
                      answerError={
                        submitAnswers.isError &&
                        item.type === 'user-input-request' &&
                        submitAnswers.variables?.userInputRequestId === item.userInputRequestId
                      }
                      onRetryAnswers={() => {
                        if (submitAnswers.variables) submitAnswers.mutate(submitAnswers.variables);
                      }}
                    />
                  </div>
                )
              )}
              {activity ? (
                <section
                  aria-label="Runtime activity"
                  aria-live="polite"
                  className="rounded-ok border border-border bg-sunken p-4 text-sm"
                >
                  <h3 className="font-semibold text-fg">Runtime activity</h3>
                  <p className="mt-1 text-fg-muted">{coverageCopy(activity.coverage)}</p>
                  <p className="mt-1 text-fg-muted">{captureCopy(activity.contentCapture)}</p>
                  {activity.omittedEntryCount > 0 ? (
                    <p className="mt-1 text-fg-muted">
                      {omittedActivityCopy(activity.omittedEntryCount)}
                    </p>
                  ) : null}
                  {activity.entries.length > 0 ? (
                    <ol className="mt-3 flex flex-col gap-3">
                      {activity.entries.map((entry) => (
                        <li key={entry.sequence}>
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="font-medium text-fg">
                              {entry.label ??
                                {
                                  'child-started': timelineCopy.childStarted,
                                  progress: timelineCopy.reportedProgress,
                                  result: timelineCopy.reportedResult,
                                  failure: timelineCopy.reportedFailure,
                                }[entry.kind]}
                            </span>
                            <time dateTime={entry.observedAt} className="text-xs text-fg-muted">
                              {new Date(entry.observedAt).toLocaleTimeString()}
                            </time>
                          </div>
                          {entry.text !== undefined ? (
                            <p className="mt-1 whitespace-pre-wrap break-words text-fg">
                              {entry.text}
                            </p>
                          ) : null}
                          {entry.textTruncated ? (
                            <p className="mt-1 text-xs text-fg-muted">
                              {timelineCopy.textShortened}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </section>
              ) : null}
              {historicalFailure ? <ErrorBanner message={historicalFailure} /> : null}
            </div>
          );
        })}
      </div>
    </ThreadReadReceipts>
  );
}
