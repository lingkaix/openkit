import { useState } from 'react';
import {
  ArtifactRow,
  AssistantMessage,
  Button,
  ErrorBanner,
  ItemCard,
  RadioGroup,
  TextField,
  UserMessage,
} from '../../primitives';
import type { ThreadItem } from './data';

/** Protocol user-input request rendered by the inline Gate control. */
type UserInputRequestItem = Extract<ThreadItem, { type: 'user-input-request' }>;

export interface ItemViewProps {
  /** Item projected by the authoritative Thread stream. */
  item: ThreadItem;
  /** Grant/deny an inline approval; omitted (or read-only) disables the actions. */
  onApprovalDecision?: (
    approvalRequestId: string,
    turnId: string,
    decision: 'granted' | 'denied'
  ) => void;
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

/**
 * Item view (WP-4) — renders one thread Item with the primitive tier.
 *
 * The Web UI is a visible follower over the item stream, so every product-visible
 * item type (protocol §item model) maps to a calm, legible primitive. Approvals
 * are decidable inline (D-006), and human-authored items display only their
 * supplied authoritative actor IDs. Deep technical detail stays terse here.
 */
export function ItemView({
  item,
  onApprovalDecision,
  readOnly,
  onSubmitAnswers,
  answerPending,
  answerError,
  onRetryAnswers,
}: ItemViewProps) {
  switch (item.type) {
    case 'user-message':
      return (
        <UserMessage>
          <p>{item.text}</p>
          <p className="mt-1 text-xs text-fg-muted">by {item.actor.id}</p>
        </UserMessage>
      );

    case 'assistant-message':
      // Chat mode has a single assistant; per-worker attribution arrives with the
      // multi-worker goal surfaces (WP-5).
      return (
        <AssistantMessage hue="scout" initials="AI" author="Assistant">
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
      return <ArtifactRow name={item.title} icon="file" time={item.summary ?? undefined} />;

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
            readOnly ? undefined : (
              <>
                <Button
                  size="sm"
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
                  onPress={() =>
                    onApprovalDecision?.(item.approvalRequestId, item.turnId, 'denied')
                  }
                >
                  Deny
                </Button>
              </>
            )
          }
        />
      );

    case 'approval-decision':
      return (
        <ItemCard
          kind={item.decision === 'granted' ? 'positive' : 'neutral'}
          title={item.decision === 'granted' ? 'Approved' : 'Denied'}
          meta={`by ${item.actor.id}`}
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
      return <ItemCard kind="neutral" title="You answered" meta={`by ${item.actor.id}`} />;

    case 'file-change':
      return <ArtifactRow name={item.path} icon="file" time={item.changeKind} />;

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

    default:
      return null;
  }
}
