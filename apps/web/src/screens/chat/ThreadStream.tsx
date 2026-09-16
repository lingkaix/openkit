import { createRequestId } from '@openkit/core-client';
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
 * grouped by Turn (Thread → Turn → Item). Unresolved approvals and non-secret Gate answers are
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

  const groups = groupItemsByTurn(items.data ?? []);
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

  if (groups.length === 0) {
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
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status))
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
      {groups.map((group, index) => (
        <div key={group.turnId} className="flex flex-col gap-4">
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
                readOnly={controlsReadOnly}
                resolvedApproval={
                  item.type === 'approval-request'
                    ? (items.data ?? []).find(
                        (
                          candidate
                        ): candidate is Extract<typeof candidate, { type: 'approval-decision' }> =>
                          candidate.type === 'approval-decision' &&
                          candidate.turnId === item.turnId &&
                          candidate.approvalRequestId === item.approvalRequestId
                      )
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
        </div>
      ))}
    </div>
  );
}
