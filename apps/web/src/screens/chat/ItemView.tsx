import { useState } from 'react';
import {
  AssistantMessage,
  Button,
  ErrorBanner,
  ItemCard,
  RadioGroup,
  TextField,
  UserMessage,
} from '../../primitives';
import { ArtifactReference } from '../artifacts/ArtifactReference';
import type { ThreadItem } from './data';
import { GenerativePresentationView } from './GenerativePresentationView';

/** Protocol user-input request rendered by the inline Gate control. */
type UserInputRequestItem = Extract<ThreadItem, { type: 'user-input-request' }>;

export interface ItemViewProps {
  /** Item projected by the authoritative Thread stream. */
  item: ThreadItem;
  /** Authenticated viewer from the authorized dashboard; absent while loading. */
  viewerUserId?: string | null;
  /** Display-name projection for the recorded Item actor or assigned Turn Agent. */
  authorName?: string;
  /** Grant/deny an inline approval; omitted (or read-only) disables the actions. */
  onApprovalDecision?: (
    approvalRequestId: string,
    turnId: string,
    decision: 'granted' | 'denied'
  ) => void;
  /** Title of the exact approval request in this Turn, when present in the loaded stream. */
  approvalRequestTitle?: string;
  /** Matching authoritative outcome closes an approval request. */
  resolvedApproval?: Extract<ThreadItem, { type: 'approval-decision' }>;
  /** Explanation for unavailable approval controls. */
  approvalUnavailableReason?: string;
  /** Whether this request's decision is being submitted or refreshed. */
  approvalPending?: boolean;
  /** Whether this request's decision failed. */
  approvalError?: boolean;
  /** Retry the retained decision command with the same request id. */
  onRetryApproval?: () => void;
  /** When true, decision actions are hidden (e.g. runtime disconnected). */
  readOnly?: boolean;
  /** Submit one complete non-secret answer map for the item's paused Turn. */
  onSubmitAnswers?: (turnId: string, answers: Record<string, [string]>) => void;
  /** Whether this item's answer command is awaiting settlement. */
  answerPending?: boolean;
  /** Whether this item's latest answer command failed. */
  answerError?: boolean;
  /** Retry the exact answer command retained by its mutation owner. */
  onRetryAnswers?: () => void;
}

/** Properties for one protocol user-input request's bounded inline form. */
interface UserInputRequestViewProps {
  /** Exact Gate request Item. */
  item: UserInputRequestItem;
  /** Whether controls must remain visible but non-interactive. */
  readOnly: boolean;
  /** Whether the current answer submission is pending. */
  pending: boolean;
  /** Whether the current answer submission failed. */
  failed: boolean;
  /** Submit the complete answer map. */
  onSubmit?: (turnId: string, answers: Record<string, [string]>) => void;
  /** Retry the exact previously submitted answer map. */
  onRetry?: () => void;
}

/**
 * Renders one non-secret Gate as an accessible complete-map form.
 *
 * Secret-bearing Gates expose their questions without collecting answers because the existing
 * command contract rejects secret response transport.
 */
function UserInputRequestView({
  item,
  readOnly,
  pending,
  failed,
  onSubmit,
  onRetry,
}: UserInputRequestViewProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const containsSecret = item.questions.some((question) => question.isSecret);
  const complete = item.questions.every((question) => Boolean(answers[question.id]?.trim()));

  return (
    <ItemCard
      kind="notice"
      title="Needs your input"
      meta={
        item.questions.some((question) => question.question === item.prompt)
          ? undefined
          : item.prompt
      }
    >
      {containsSecret ? (
        <div className="flex flex-col gap-3">
          {item.questions.map((question) => (
            <div key={question.id}>
              <p className="font-bold text-fg-strong">{question.header}</p>
              <p className="text-xs text-fg-muted">{question.question}</p>
            </div>
          ))}
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (readOnly || pending || !complete || !onSubmit) return;
            const completeAnswers = Object.fromEntries(
              item.questions.map((question) => [question.id, [answers[question.id] as string]])
            ) as Record<string, [string]>;
            onSubmit(item.turnId, completeAnswers);
          }}
        >
          {item.questions.map((question) => (
            <div key={question.id} className="flex flex-col gap-2">
              <p className="text-xs text-fg-muted">{question.question}</p>
              {question.options ? (
                <>
                  <RadioGroup
                    aria-label={question.header}
                    isDisabled={readOnly || pending}
                    value={answers[question.id] ?? null}
                    onChange={(value) =>
                      setAnswers((current) => ({ ...current, [question.id]: value }))
                    }
                    items={question.options.map((option) => ({
                      id: option.label,
                      label: option.label,
                      content: (
                        <>
                          <span className="font-bold text-fg-strong">{option.label}</span>
                          <span className="text-xs text-fg-muted">{option.description}</span>
                        </>
                      ),
                    }))}
                  />
                  {question.isOther ? (
                    <TextField
                      label="Other"
                      isDisabled={readOnly || pending}
                      value={
                        question.options.some((option) => option.label === answers[question.id])
                          ? ''
                          : (answers[question.id] ?? '')
                      }
                      onChange={(value) =>
                        setAnswers((current) => ({ ...current, [question.id]: value }))
                      }
                    />
                  ) : null}
                </>
              ) : (
                <TextField
                  label={question.header}
                  isDisabled={readOnly || pending}
                  value={answers[question.id] ?? ''}
                  onChange={(value) =>
                    setAnswers((current) => ({ ...current, [question.id]: value }))
                  }
                />
              )}
            </div>
          ))}
          {failed ? <ErrorBanner message="Couldn't submit answers." onRetry={onRetry} /> : null}
          {!readOnly ? (
            <Button type="submit" isDisabled={!complete || pending}>
              {pending ? 'Submitting answers' : 'Submit answers'}
            </Button>
          ) : null}
        </form>
      )}
    </ItemCard>
  );
}

/** Explains recorded decisions without fabricating human reasons, client attribution, or recovery time. */
function ApprovalDecisionView({
  item,
  authorName,
  requestTitle,
}: {
  item: Extract<ThreadItem, { type: 'approval-decision' }>;
  authorName?: string;
  requestTitle?: string;
}) {
  const system = item.actor.kind === 'system';
  const recovery = system && item.actor.id === 'nanocore-boot-reconciliation';
  const timestamp = item.completedAt ?? item.createdAt;
  const reason = recovery
    ? 'The task had already ended without an approval decision. Server recovery closed the pending approval.'
    : system
      ? 'Automatically granted by the repository push policy.'
      : 'No reason was recorded.';
  return (
    <ItemCard
      kind={item.decision === 'granted' ? 'positive' : 'neutral'}
      title={item.decision === 'granted' ? 'Approved' : 'Denied'}
      meta={`by ${system ? 'OpenKit system' : (authorName ?? item.actor.id)}`}
    >
      <div className="flex flex-col gap-2 break-words">
        <p>Request: {requestTitle ?? item.approvalRequestId}</p>
        <p>{reason}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-muted">{recovery ? 'Inherited timestamp' : 'Decision time'}</dt>
          <dd>
            <time dateTime={timestamp} title={timestamp}>
              {new Date(timestamp).toLocaleString(undefined, { timeZoneName: 'short' })}
            </time>
          </dd>
          <dt className="text-fg-muted">Source</dt>
          <dd>
            {recovery ? 'Server recovery' : system ? 'Repository push policy' : 'User decision'}
          </dd>
          <dt className="text-fg-muted">Client</dt>
          <dd>{system ? 'Not applicable — automatic server action' : 'Not recorded'}</dd>
        </dl>
        {recovery ? (
          <p className="text-xs text-fg-muted">
            This timestamp was inherited from task completion, task start, or request creation. The
            actual recovery time was not recorded.
          </p>
        ) : null}
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">Record identifiers</summary>
          <p>Actor: {item.actor.id}</p>
          <p>Approval: {item.approvalRequestId}</p>
          <p>Cause: {item.causationId}</p>
        </details>
      </div>
    </ItemCard>
  );
}

/**
 * Item view (WP-4) — renders one thread Item with the primitive tier.
 *
 * The Web UI is a visible follower over the item stream, so every product-visible
 * item type (protocol §item model) maps to a calm, legible primitive. Approvals
 * are decidable inline (D-006), and human-authored items display only their
 * recorded actor identity with authorized display-name projections. Deep technical detail stays terse here.
 */
export function ItemView({
  item,
  viewerUserId,
  authorName,
  onApprovalDecision,
  approvalRequestTitle,
  resolvedApproval,
  approvalUnavailableReason,
  approvalPending,
  approvalError,
  onRetryApproval,
  readOnly,
  onSubmitAnswers,
  answerPending,
  answerError,
  onRetryAnswers,
}: ItemViewProps) {
  switch (item.type) {
    case 'user-message':
      return item.actor.kind === 'user' ? (
        <UserMessage author={authorName ?? item.actor.id} isSelf={item.actor.id === viewerUserId}>
          <p>{item.text}</p>
        </UserMessage>
      ) : (
        <AssistantMessage hue="scout" initials="AI" author={authorName ?? item.actor.id}>
          {item.text}
        </AssistantMessage>
      );

    case 'assistant-message':
      return (
        <AssistantMessage hue="scout" initials="AI" author={authorName ?? 'Agent'}>
          {item.text || <span className="text-fg-muted">…</span>}
        </AssistantMessage>
      );

    case 'reasoning':
      return (
        <ItemCard
          kind="neutral"
          title="Reasoning"
          meta={item.summary[0] ?? 'Thinking through the task'}
        />
      );

    case 'artifact-reference':
      return <ArtifactReference key={`${item.workspaceId}:${item.id}`} item={item} />;

    case 'command-execution':
      return (
        <ItemCard
          kind="neutral"
          title={item.command}
          meta={item.exitCode === null ? 'running' : `exit ${item.exitCode}`}
        />
      );

    case 'approval-request':
      return (
        <ItemCard
          kind="notice"
          title={item.title}
          meta={item.description}
          actions={
            readOnly ||
            resolvedApproval ||
            approvalUnavailableReason ||
            !onApprovalDecision ? undefined : (
              <>
                <Button
                  size="sm"
                  isDisabled={approvalPending}
                  variant="accent"
                  onPress={() =>
                    onApprovalDecision?.(item.approvalRequestId, item.turnId, 'granted')
                  }
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="negative-outline"
                  isDisabled={approvalPending}
                  onPress={() =>
                    onApprovalDecision?.(item.approvalRequestId, item.turnId, 'denied')
                  }
                >
                  Deny
                </Button>
              </>
            )
          }
        >
          {resolvedApproval ? (
            <p>
              {resolvedApproval.decision === 'granted' ? 'Approved' : 'Denied'}. This approval is
              closed.
            </p>
          ) : approvalUnavailableReason || readOnly ? (
            <p>{approvalUnavailableReason ?? 'Approval actions are unavailable in this view.'}</p>
          ) : null}
          {approvalPending ? <p role="status">Submitting decision…</p> : null}
          {approvalError && !resolvedApproval ? (
            <ErrorBanner
              message="Couldn't submit this decision."
              onRetry={readOnly || approvalUnavailableReason ? undefined : onRetryApproval}
            />
          ) : null}
        </ItemCard>
      );

    case 'approval-decision':
      return (
        <ApprovalDecisionView
          item={item}
          authorName={authorName}
          requestTitle={approvalRequestTitle}
        />
      );

    case 'user-input-request':
      return (
        <UserInputRequestView
          item={item}
          readOnly={Boolean(readOnly)}
          pending={Boolean(answerPending)}
          failed={Boolean(answerError)}
          onSubmit={onSubmitAnswers}
          onRetry={onRetryAnswers}
        />
      );

    case 'user-input-response':
      return (
        <ItemCard
          kind="neutral"
          title={item.actor.id === viewerUserId ? 'You answered' : 'Answered'}
          meta={`by ${authorName ?? item.actor.id}`}
        />
      );

    case 'file-change':
      return (
        <ItemCard kind="neutral" title={item.path} meta={`File change · ${item.changeKind}`} />
      );

    case 'tool-call':
      return <ItemCard kind="informative" title={item.tool} meta={item.server ?? undefined} />;

    case 'agent-handoff':
      return (
        <ItemCard
          kind="informative"
          title={`Handoff to ${item.toAgentId}`}
          meta={item.reason ?? undefined}
        />
      );

    case 'status':
      return (
        <ItemCard
          kind={item.level === 'info' ? 'informative' : 'notice'}
          title={item.title}
          meta={item.summary ?? undefined}
        />
      );

    case 'plan':
      return (
        <ItemCard
          kind="informative"
          title={item.title}
          meta={`${item.steps.length} steps${item.summary ? ` · ${item.summary}` : ''}`}
        />
      );

    case 'knowledge-injection':
      return <ItemCard kind="neutral" title="Knowledge added" meta={item.summary} />;

    case 'generative-ui-reference':
      return <GenerativePresentationView item={item} />;

    default:
      return null;
  }
}
