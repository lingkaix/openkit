import type { ApprovalEffectPreview } from '@openkit/app-api-schemas';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AssistantMessage,
  Button,
  ErrorBanner,
  ItemCard,
  RadioGroup,
  TextField,
  UserMessage,
} from '../../primitives';
import { useSteerController } from '../../primitives/steer-context';
import { ArtifactReference } from '../artifacts/ArtifactReference';
import type { ThreadItem } from './data';
import { GenerativePresentationView } from './GenerativePresentationView';
import { useDisplayedMessageBody } from './ThreadReadReceipts';
import { timelineCopy } from './timeline/copy';
import { visibleStatusSummary, visibleStatusTitle } from './timeline/present';
import { SteerOutcome } from './timeline/SteerOutcome';
import { contextSummaryCopy } from './timeline/source';
import { TimelineTime } from './timeline/TimelineTime';
import { durationDateTime, formatDuration } from './timeline/time';

/** Approving, denying, or withdrawing, with the consequence beside each control. */
function ApprovalActions({
  itemId,
  pending,
  pendingDecision,
  holdReason,
  canApprove,
  emphasizePrimary,
  onApprove,
  onDeny,
  onWithdraw,
}: {
  itemId: string;
  pending: boolean;
  pendingDecision?: 'granted' | 'denied' | 'withdraw';
  holdReason?: string;
  canApprove: boolean;
  emphasizePrimary?: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onWithdraw?: () => void;
}) {
  const approveId = `approve-why-${itemId}`;
  const denyId = `deny-why-${itemId}`;
  const waitId = `decision-wait-${itemId}`;
  const approvingId = `approving-${itemId}`;
  const held = Boolean(holdReason);
  const described = (id: string, own: boolean) =>
    pending && own ? approvingId : pending || held ? waitId : id;
  return (
    <div className="flex flex-col items-end gap-1">
      <p id={approveId}>{timelineCopy.approveConsequence}</p>
      <p id={denyId}>{timelineCopy.denyConsequence}</p>
      {pending && pendingDecision === 'granted' ? (
        <p id={approvingId} role="status">
          {timelineCopy.approving}
        </p>
      ) : null}
      {pending ? <p id={waitId}>{timelineCopy.waitForDecision}</p> : null}
      {!pending && held ? <p id={waitId}>{holdReason}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {canApprove ? (
          <Button
            size="sm"
            isDisabled={pending || held}
            aria-describedby={described(approveId, pendingDecision === 'granted')}
            variant={emphasizePrimary === false ? 'outline' : 'accent'}
            {...(emphasizePrimary ? { 'data-emphasis': 'true' } : {})}
            onPress={onApprove}
          >
            Approve
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="negative-outline"
          isDisabled={pending || held}
          aria-describedby={described(denyId, pendingDecision === 'denied')}
          onPress={onDeny}
        >
          Deny
        </Button>
        {onWithdraw ? (
          <Button
            size="sm"
            isDisabled={pending || held}
            aria-describedby={described(denyId, pendingDecision === 'withdraw')}
            onPress={onWithdraw}
          >
            Withdraw
          </Button>
        ) : null}
      </div>
    </div>
  );
}

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
  /** Complete authorized read-model detail; absence never enables grant. */
  approvalEffect?: ApprovalEffectPreview;
  /** Withdraw under the same current responsible-user predicate. */
  onWithdrawApproval?: (requestId: string) => void;
  /** Whether this request's decision is being submitted or refreshed. */
  approvalPending?: boolean;
  /** Whether this request's decision failed. */
  approvalError?: boolean;
  /** Retry the retained decision command with the same request id. */
  onRetryApproval?: () => void;
  /** When true, decision actions are hidden (e.g. runtime disconnected). */
  readOnly?: boolean;
  /** Submit one complete non-secret answer map for the pending user-input request. */
  onSubmitAnswers?: (userInputRequestId: string, answers: Record<string, [string]>) => void;
  /** Whether this item's answer command is awaiting settlement. */
  answerPending?: boolean;
  /** Whether this item's latest answer command failed. */
  answerError?: boolean;
  /** Retry the exact answer command retained by its mutation owner. */
  onRetryAnswers?: () => void;
  /** Dashboard initiating-request objective for this Item id, when the verified trace supplied one. */
  requestObjective?: string;
  /**
   * Whether this decision's primary button may use the emphasis budget.
   * False keeps the button usable and neutral. Unset keeps today's accent button.
   */
  emphasizePrimary?: boolean;
  /** Which decision is in flight, so pending copy and sibling reasons stay specific. */
  pendingDecision?: 'granted' | 'denied' | 'withdraw';
  /** Stale or unknown state. The control stays visible and explains why it is off. */
  holdReason?: string;
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
  onSubmit?: (userInputRequestId: string, answers: Record<string, [string]>) => void;
  /** Retry the exact previously submitted answer map. */
  onRetry?: () => void;
  /** Whether Submit may take an emphasis slot. */
  emphasizePrimary?: boolean;
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
  emphasizePrimary,
}: UserInputRequestViewProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const containsSecret = item.questions.some((question) => question.isSecret);
  const complete = item.questions.every((question) => Boolean(answers[question.id]?.trim()));

  return (
    <div role="status" aria-label="Needs your input">
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
              onSubmit(item.userInputRequestId, completeAnswers);
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
              <>
                <p id={`answer-why-${item.id}`}>{timelineCopy.answerConsequence}</p>
                {pending ? (
                  <p id={`answer-wait-${item.id}`}>{timelineCopy.waitForDecision}</p>
                ) : null}
                {!complete && !pending ? (
                  <p id={`answer-wait-${item.id}`}>Answer every question first.</p>
                ) : null}
                <Button
                  type="submit"
                  isDisabled={!complete || pending}
                  aria-describedby={
                    pending || !complete ? `answer-wait-${item.id}` : `answer-why-${item.id}`
                  }
                  variant={emphasizePrimary === false ? 'outline' : 'accent'}
                  {...(emphasizePrimary ? { 'data-emphasis': 'true' } : {})}
                >
                  {pending ? 'Submitting answers' : 'Submit answers'}
                </Button>
              </>
            ) : null}
          </form>
        )}
      </ItemCard>
    </div>
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
  const timestamp = item.completedAt ?? item.createdAt;
  const reason = system
    ? 'Automatically granted by the repository push policy.'
    : 'No reason was recorded.';
  return (
    <ItemCard
      kind={item.decision === 'granted' ? 'positive' : 'neutral'}
      title={item.decision === 'granted' ? 'Approved' : 'Denied'}
      meta={`by ${system ? 'OpenKit system' : (authorName ?? item.actor.id)}`}
    >
      <div className="flex flex-col gap-2">
        <p>Request: {requestTitle ?? item.approvalRequestId}</p>
        <p>{reason}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-muted">Decision time</dt>
          <dd>
            <time dateTime={timestamp} title={timestamp}>
              {new Date(timestamp).toLocaleString(undefined, { timeZoneName: 'short' })}
            </time>
          </dd>
          <dt className="text-fg-muted">Source</dt>
          <dd>{system ? 'Repository push policy' : 'User decision'}</dd>
          <dt className="text-fg-muted">Client</dt>
          <dd>{system ? 'Not applicable — automatic server action' : 'Not recorded'}</dd>
        </dl>
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
  approvalEffect,
  onWithdrawApproval,
  approvalPending,
  approvalError,
  onRetryApproval,
  readOnly,
  onSubmitAnswers,
  answerPending,
  answerError,
  onRetryAnswers,
  requestObjective,
  emphasizePrimary,
  pendingDecision,
  holdReason,
}: ItemViewProps) {
  const bodyRef = useDisplayedMessageBody(item.id);
  const steer = useSteerController();
  const steerReceipt = steer?.receipt(item.id) ?? null;
  switch (item.type) {
    case 'user-message': {
      // Core retains exact outcome input for S39 verification; S59 publishes its human decision separately.
      if (item.actor.kind === 'system' && item.actor.id === 'nanocore-pending-request') return null;
      const body = requestObjective ? (
        <p className="ok-prose">{requestObjective}</p>
      ) : item.actor.kind === 'user' ? (
        <p>{item.text}</p>
      ) : (
        item.text
      );
      return item.actor.kind === 'user' ? (
        <>
          <UserMessage
            author={authorName ?? item.actor.id}
            isSelf={item.actor.id === viewerUserId}
            bodyRef={bodyRef}
          >
            {body}
          </UserMessage>
          {steerReceipt ? <SteerOutcome onReplay={steer?.replay} receipt={steerReceipt} /> : null}
        </>
      ) : (
        <AssistantMessage
          hue="scout"
          initials="AI"
          author={authorName ?? item.actor.id}
          bodyRef={bodyRef}
        >
          {body}
        </AssistantMessage>
      );
    }

    case 'assistant-message':
      return (
        <AssistantMessage
          hue="scout"
          initials="AI"
          author={authorName ?? 'Agent'}
          bodyRef={bodyRef}
        >
          {item.text || <span className="text-fg-muted">…</span>}
        </AssistantMessage>
      );

    case 'context-summary':
      return (
        <ItemCard
          kind="informative"
          title="Continuation summary"
          meta={contextSummaryCopy(item.sourceRange.itemCount)}
        >
          <p className="whitespace-pre-wrap">{item.text}</p>
          <details className="mt-2">
            <summary>Covered history range</summary>
            <p>{item.sourceRange.itemCount} earlier messages are in this range.</p>
          </details>
        </ItemCard>
      );

    case 'reasoning': {
      const meta = item.summary[0] ?? 'Thinking through the task';
      const detailParts =
        item.summary.length > 1 ? [...item.summary, ...item.content] : [...item.content];
      const detailPartKeys = (() => {
        const occurrences = new Map<string, number>();
        return detailParts.map((part) => {
          const ordinal = occurrences.get(part) ?? 0;
          occurrences.set(part, ordinal + 1);
          return ordinal === 0 ? `${item.id}:${part}` : `${item.id}:${part}@${ordinal}`;
        });
      })();
      return (
        <ItemCard kind="neutral" title="Reasoning" meta={meta}>
          {detailParts.length > 0 ? (
            <details className="mt-2">
              <summary>Full reasoning</summary>
              {detailParts.map((part, index) => (
                <p key={detailPartKeys[index]} className="whitespace-pre-wrap">
                  {part}
                </p>
              ))}
            </details>
          ) : null}
        </ItemCard>
      );
    }

    case 'artifact-reference':
      return (
        <ArtifactReference
          key={`${item.owner.kind === 'workspace' ? item.owner.workspaceId : 'server'}:${item.id}`}
          item={item}
        />
      );

    case 'command-execution': {
      const duration =
        item.durationMs != null && item.durationMs >= 1000 ? formatDuration(item.durationMs) : null;
      return (
        <ItemCard
          kind="neutral"
          title={item.command}
          meta={item.exitCode === null ? 'running' : `exit ${item.exitCode}`}
        >
          {duration ? (
            <time dateTime={durationDateTime(item.durationMs ?? 0)}>{duration}</time>
          ) : null}
        </ItemCard>
      );
    }

    case 'approval-request':
      return (
        <div aria-live="polite" className="flex flex-col gap-2">
          <p className="text-xs font-bold text-fg">
            <span>Needs you</span>
            <span> · </span>
            <TimelineTime iso={item.createdAt} />
          </p>
          <ItemCard
            kind="notice"
            title={item.title}
            meta={item.description}
            actions={
              readOnly ||
              resolvedApproval ||
              approvalUnavailableReason ||
              !onApprovalDecision ? undefined : (
                <ApprovalActions
                  itemId={item.id}
                  pending={Boolean(approvalPending)}
                  pendingDecision={pendingDecision}
                  holdReason={holdReason}
                  canApprove={approvalEffect?.status === 'available'}
                  emphasizePrimary={emphasizePrimary}
                  onApprove={() =>
                    onApprovalDecision?.(item.approvalRequestId, item.turnId, 'granted')
                  }
                  onDeny={() => onApprovalDecision?.(item.approvalRequestId, item.turnId, 'denied')}
                  onWithdraw={
                    onWithdrawApproval
                      ? () => onWithdrawApproval(item.approvalRequestId)
                      : undefined
                  }
                />
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
            {!resolvedApproval &&
              !readOnly &&
              !approvalUnavailableReason &&
              (approvalEffect?.status === 'available' ? (
                <section aria-label="Complete exact effect">
                  <p>{approvalEffect.summary}</p>
                  <pre className="overflow-auto whitespace-pre-wrap break-all">
                    {approvalEffect.detail}
                  </pre>
                </section>
              ) : (
                <p>
                  Exact effect unavailable; approval disabled
                  {approvalEffect?.status === 'unavailable'
                    ? `: ${approvalEffect.reason}`
                    : ': Complete detail has not been loaded.'}
                </p>
              ))}
            {approvalPending && pendingDecision !== 'granted' ? (
              <p role="status">{timelineCopy.waitForDecision}</p>
            ) : null}
            {approvalError && !resolvedApproval ? (
              <ErrorBanner
                message="Couldn't submit this decision."
                onRetry={readOnly || approvalUnavailableReason ? undefined : onRetryApproval}
              />
            ) : null}
          </ItemCard>
        </div>
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
          emphasizePrimary={emphasizePrimary}
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

    case 'tool-call': {
      const duration =
        item.durationMs != null && item.durationMs >= 1000 ? formatDuration(item.durationMs) : null;
      return (
        <ItemCard kind="informative" title={item.tool} meta={item.server ?? undefined}>
          {duration ? (
            <time dateTime={durationDateTime(item.durationMs ?? 0)}>{duration}</time>
          ) : null}
        </ItemCard>
      );
    }

    case 'agent-handoff':
      return (
        <ItemCard
          kind="informative"
          title={timelineCopy['agent-handoff']}
          meta={item.reason ?? undefined}
        />
      );

    case 'status': {
      const title = visibleStatusTitle(item.title);
      const summary = visibleStatusSummary(item.summary);
      const revision = item.knowledgeMaintenanceResult?.notebookRevision;
      const ownerWorkspace = item.owner.kind === 'workspace' ? item.owner.workspaceId : null;
      const revisionLink: ReactNode =
        revision && ownerWorkspace ? (
          <Link
            to={`/knowledge?workspace=${encodeURIComponent(ownerWorkspace)}&revision=${encodeURIComponent(revision)}`}
          >
            Published notebook revision
          </Link>
        ) : null;
      if (title === timelineCopy.runAccepted) {
        return (
          <>
            <p data-voice="fact" data-status="fact" className="ok-voice-fact ok-meta">
              <span>{title}</span>
              {summary ? (
                <>
                  <span> · </span>
                  <span>{summary}</span>
                </>
              ) : null}
            </p>
            {revisionLink}
          </>
        );
      }
      const knownProblem =
        title === timelineCopy.runFailedTitle || title === timelineCopy.runStoppedTitle;
      if (item.level === 'warning' && !knownProblem) {
        return (
          <>
            <p data-voice="fact" data-status="unknown" className="ok-voice-fact ok-meta">
              <span className="text-notice-fg" aria-hidden="true">
                {timelineCopy.unknownMark}
              </span>{' '}
              <span>{title}</span>
              {summary ? (
                <>
                  <span> · </span>
                  <span>{summary}</span>
                </>
              ) : null}
            </p>
            {revisionLink}
          </>
        );
      }
      return (
        <>
          <ItemCard
            kind={item.level === 'info' ? 'informative' : 'neutral'}
            title={title}
            meta={summary ?? undefined}
          />
          {revisionLink}
        </>
      );
    }

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
