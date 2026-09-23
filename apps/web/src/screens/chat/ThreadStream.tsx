import { createRequestId } from '@openkit/core-client';
import { isSealedTurnTerminal } from '@openkit/protocol';
import { useEffect, useState } from 'react';
import { useConnection } from '../../app/core-client';
import { EmptyState, ErrorBanner, Skeleton, TurnSeparator } from '../../primitives';
import {
  groupItemsByTurn,
  type ThreadItem,
  useLiveThreadItems,
  useRespondApproval,
  useSubmitTurnAnswers,
  useThreadItems,
} from './data';
import { ItemView } from './ItemView';

const MISSING_TURN_ERROR = 'This turn failed. Review the conversation before trying again.';

/** Item-log groups plus dashboard activity or historical failures for Turns with no Items. */
function streamGroupsByTurn(
  items: ThreadItem[],
  turns: readonly { id: string; status: string }[] | undefined,
  latestTurnId: string | undefined,
  activityTurnIds: ReadonlySet<string>
): { turnId: string; items: ThreadItem[] }[] {
  const groups = groupItemsByTurn(items);
  const orderedTurns = turns ?? [];
  const turnOrder = new Map(orderedTurns.map((turn, index) => [turn.id, index]));
  for (const [index, turn] of orderedTurns.entries()) {
    // Historical errors insert failed Turns only; supplied activity also needs a group without Items.
    const historicalFailure = turn.status === 'failed' && turn.id !== latestTurnId;
    if (
      (!historicalFailure && !activityTurnIds.has(turn.id)) ||
      groups.some((group) => group.turnId === turn.id)
    )
      continue;
    const next = groups.findIndex((group) => (turnOrder.get(group.turnId) ?? -1) > index);
    groups.splice(next < 0 ? groups.length : next, 0, { turnId: turn.id, items: [] });
  }

  return groups;
}

export interface ThreadStreamProps {
  workspaceId: string | null;
  threadId: string;
  /** When true (runtime disconnected), inline approval and Gate actions are read-only. */
  readOnly?: boolean;
  /** Empty-state title when the thread has no items yet. */
  emptyTitle?: string;
}

/**
 * Thread item stream (WP-4) — the conversation column (DESIGN.md §3.2).
 *
 * Renders every applicable §9.13 state: a skeleton while the read model is in
 * flight, an inline error with retry, a calm empty block, or the populated stream
 * grouped by Turn (Thread → Turn → Item). Each durable failed Turn that is not the
 * latest keeps its recorded dashboard error beside that Turn, including Turns with no
 * Items. Authorized runtime activity appears once at each Turn's final Item group, or an empty group, as plain text with explicit coverage and presentation omissions; it creates no human Gate or execution state. A failed dashboard refresh suppresses cached activity until a successful read, with retry owned by the existing dashboard query. Unresolved approvals and non-secret Gate answers are
 * actionable inline unless read-only. Baseline readiness stays sticky only for the current
 * Workspace and Thread so later command refetches cannot tear down its live subscription.
 */
export function ThreadStream({ workspaceId, threadId, readOnly, emptyTitle }: ThreadStreamProps) {
  const connection = useConnection();
  const items = useThreadItems(workspaceId, threadId);
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
  const live = useLiveThreadItems(workspaceId, threadId, items.isSuccess, baselineReady);
  const dashboard = live.data;
  const respond = useRespondApproval(workspaceId ?? '', threadId);
  const submitAnswers = useSubmitTurnAnswers(workspaceId ?? '', threadId);
  const controlsReadOnly = Boolean(readOnly || !workspaceId || !connection.connected);

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
  const groups = streamGroupsByTurn(
    items.data ?? [],
    dashboard?.turns,
    latestTurnId,
    new Set(activityByTurn.keys())
  );
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
    const turn = dashboard.turns.find((candidate) => candidate.id === item.turnId);
    if (!turn) return 'Task status is unavailable. Reload this conversation to check again.';
    if (isSealedTurnTerminal(turn.status))
      return 'This task has ended. This approval can no longer be answered.';
    if (
      item.status !== 'completed' ||
      turn.status !== 'awaiting_human' ||
      turn.humanGate?.kind !== 'approval' ||
      turn.humanGate.itemId !== item.id ||
      turn.humanGate.approvalRequestId !== item.approvalRequestId
    )
      return 'This request is not the task’s current approval. No decision can be submitted.';
    return undefined;
  }

  return (
    <div className="flex flex-col gap-5">
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
        const historicalFailure =
          groupTurn?.status === 'failed' && groupTurn.id !== latestTurnId && isLastGroup
            ? (groupTurn.error?.message ?? MISSING_TURN_ERROR)
            : null;

        return (
          <div key={group.items[0]?.id ?? group.turnId} className="flex flex-col gap-4">
            {index > 0 ? <TurnSeparator label={`Turn ${index + 1}`} /> : null}
            {group.items.map((item) =>
              item.type === 'user-input-request' &&
              (items.data ?? []).some(
                (candidate) =>
                  candidate.type === 'user-input-response' &&
                  candidate.turnId === item.turnId &&
                  candidate.userInputRequestId === item.userInputRequestId
              ) ? null : (
                <ItemView
                  key={item.id}
                  item={item}
                  viewerUserId={dashboard?.viewerUserId}
                  authorName={
                    'actor' in item
                      ? participantNames.get(`${item.actor.kind}:${item.actor.id}`)
                      : turnAuthors.get(item.turnId)
                  }
                  requestObjective={
                    item.type === 'user-message'
                      ? dashboard?.taskInputs?.find((entry) => entry.itemId === item.id)?.objective
                      : undefined
                  }
                  readOnly={controlsReadOnly}
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
                            candidate.turnId === item.turnId &&
                            candidate.approvalRequestId === item.approvalRequestId
                        )
                      : undefined
                  }
                  approvalRequestTitle={
                    item.type === 'approval-decision'
                      ? group.items.find(
                          (
                            candidate
                          ): candidate is Extract<ThreadItem, { type: 'approval-request' }> =>
                            candidate.type === 'approval-request' &&
                            candidate.approvalRequestId === item.approvalRequestId
                        )?.title
                      : undefined
                  }
                  approvalUnavailableReason={approvalUnavailableReason(item)}
                  approvalPending={
                    respond.isPending &&
                    item.type === 'approval-request' &&
                    respond.variables?.approvalRequestId === item.approvalRequestId
                  }
                  approvalError={
                    respond.isError &&
                    item.type === 'approval-request' &&
                    respond.variables?.approvalRequestId === item.approvalRequestId
                  }
                  onRetryApproval={() => {
                    if (respond.variables) respond.mutate(respond.variables);
                  }}
                  onApprovalDecision={(approvalRequestId, turnId, decision) =>
                    respond.mutate({
                      approvalRequestId,
                      turnId,
                      decision,
                      requestId: createRequestId(),
                    })
                  }
                  onSubmitAnswers={(turnId, answers) => submitAnswers.mutate({ turnId, answers })}
                  answerPending={
                    submitAnswers.isPending && submitAnswers.variables?.turnId === item.turnId
                  }
                  answerError={
                    submitAnswers.isError && submitAnswers.variables?.turnId === item.turnId
                  }
                  onRetryAnswers={() => {
                    if (submitAnswers.variables) submitAnswers.mutate(submitAnswers.variables);
                  }}
                />
              )
            )}
            {activity ? (
              <section
                aria-label="Runtime activity"
                className="rounded-ok border border-border bg-sunken p-4 text-sm"
              >
                <h3 className="font-semibold text-fg">Runtime activity</h3>
                <p className="mt-1 text-fg-muted">
                  {activity.coverage === 'collecting'
                    ? 'Activity collection is ongoing.'
                    : activity.coverage === 'partial'
                      ? 'Activity coverage is partial.'
                      : 'Activity coverage is unavailable.'}
                </p>
                <p className="mt-1 text-fg-muted">
                  {activity.contentCapture === 'on'
                    ? 'Full-content capture was enabled for this Turn.'
                    : activity.contentCapture === 'off'
                      ? 'Full-content capture was off for this Turn.'
                      : 'Full-content capture setting is unknown.'}
                </p>
                {activity.omittedEntryCount > 0 ? (
                  <p className="mt-1 text-fg-muted">
                    {activity.omittedEntryCount} earlier activity entries not shown.
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
                                'child-started': 'Child activity started',
                                progress: 'Reported progress',
                                result: 'Reported result',
                                failure: 'Reported failure',
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
                            Text shortened for this timeline.
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
  );
}
