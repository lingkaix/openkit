import type { GoalCard, GoalRecord } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import { Button, ErrorBanner, Skeleton, StatusChip, TextField } from '../../primitives';
import { useCurrentWorkspaceId, useGoalCommand, useGoalView } from './data';

/** Current card editing is separate from immutable Plan bytes and admitted Task input. */
function CardEditor({
  card,
  goal,
  command,
  disabled,
}: {
  card: GoalCard;
  goal: GoalRecord;
  command: ReturnType<typeof useGoalCommand>;
  disabled: boolean;
}) {
  const [description, setDescription] = useState(card.description);
  const [priority, setPriority] = useState(String(card.priority));
  const [reason, setReason] = useState('');
  const scope = { workspaceId: goal.workspaceId, threadId: goal.threadId, goalId: goal.goalId };
  return (
    <li className="rounded-ok border border-border bg-card p-4 space-y-3">
      <TextField
        label={`Card description ${card.cardId}`}
        value={description}
        onChange={setDescription}
        isDisabled={disabled || card.cancelled}
      />
      <TextField
        label={`Card priority ${card.cardId}`}
        value={priority}
        onChange={setPriority}
        isDisabled={disabled || card.cancelled}
      />
      <p>
        Revision {card.revision} · {card.cancelled ? 'Cancelled' : 'Work intent'}
      </p>
      {card.cancelled ? (
        <p>{card.cancellationReason}</p>
      ) : (
        <>
          <Button
            isDisabled={disabled || !description.trim() || !Number.isSafeInteger(Number(priority))}
            onPress={() =>
              command.mutate({
                operation: 'goal.card.edit',
                input: {
                  ...scope,
                  cardId: card.cardId,
                  expectedRevision: card.revision,
                  description,
                  priority: Number(priority),
                },
              })
            }
          >
            Save card {card.cardId}
          </Button>
          <TextField
            label={`Cancellation reason ${card.cardId}`}
            value={reason}
            onChange={setReason}
            isDisabled={disabled}
          />
          <Button
            variant="negative-outline"
            isDisabled={disabled || !reason.trim()}
            onPress={() =>
              command.mutate({
                operation: 'goal.card.cancel',
                input: { ...scope, cardId: card.cardId, expectedRevision: card.revision, reason },
              })
            }
          >
            Cancel card {card.cardId}
          </Button>
        </>
      )}
    </li>
  );
}
/** One Goal journey projects current intent, proposed versus active bytes, shared decisions and ordinary Tasks. */
export function GoalScreen() {
  const { workspaceId: routeWorkspaceId = '', threadId = '' } = useParams();
  const workspaceId = useCurrentWorkspaceId(routeWorkspaceId);
  const navigate = useNavigate();
  const view = useGoalView(workspaceId, threadId);
  const command = useGoalCommand(workspaceId ?? '', threadId);
  const connection = useConnection();
  const [intent, setIntent] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const disabled = connection.checking || connection.failed || command.isPending;
  if (!workspaceId || view.isLoading)
    return (
      <div aria-busy="true">
        <Skeleton lines={5} />
      </div>
    );
  if (view.isError)
    return <ErrorBanner message="Couldn't load this Goal." onRetry={() => void view.refetch()} />;
  const data = view.data!;
  const goal = data.goal;
  const error = command.error ? (
    <ErrorBanner
      message={
        command.error instanceof ApiCallError
          ? `Goal command rejected: ${command.error.code ?? command.error.status}.`
          : "Couldn't update this Goal."
      }
      onRetry={
        disabled || !command.variables ? undefined : () => command.mutate(command.variables!)
      }
    />
  ) : null;
  if (!goal)
    return (
      <main className="mx-auto max-w-3xl space-y-4 px-6 py-8">
        <h1>Create Goal</h1>
        <TextField label="Goal intent" value={intent} onChange={setIntent} isDisabled={disabled} />
        {error}
        <Button
          isDisabled={disabled || !intent.trim()}
          onPress={() =>
            command.mutate(
              {
                operation: 'goal.create',
                input: { workspaceId, intent, originThreadId: threadId },
              },
              {
                onSuccess: (result) => {
                  if (result.goal) void navigate(`/goals/${workspaceId}/${result.goal.threadId}`);
                },
              }
            )
          }
        >
          Create Goal
        </Button>
      </main>
    );
  const scope = { workspaceId, threadId: goal.threadId, goalId: goal.goalId };
  const closed = Boolean(goal.disposition);
  const writesDisabled = disabled || closed;
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <header>
        <h1>{goal.intent}</h1>
        <StatusChip tone="neutral">{goal.disposition?.kind ?? 'Open'}</StatusChip>
        <p>Worker results remain evidence until a person accepts completion.</p>
      </header>
      {error}
      <section aria-label="Current intent" className="space-y-3">
        <h2>Current intent</h2>
        <p>
          {goal.intent} · Revision {goal.intentRevision}
        </p>
        <TextField
          label="Revised intent"
          value={intent}
          onChange={setIntent}
          isDisabled={writesDisabled}
        />
        <Button
          isDisabled={writesDisabled || !intent.trim()}
          onPress={() =>
            command.mutate({
              operation: 'goal.intent.revise',
              input: { ...scope, expectedRevision: goal.intentRevision, intent },
            })
          }
        >
          Save intent
        </Button>
      </section>
      <section className="space-y-3">
        <h2>Cards</h2>
        <ul className="space-y-3">
          {data.cards.map((card) => (
            <CardEditor
              key={`${card.cardId}:${card.revision}`}
              card={card}
              goal={goal}
              command={command}
              disabled={writesDisabled}
            />
          ))}
        </ul>
        <TextField
          label="New card description"
          value={description}
          onChange={setDescription}
          isDisabled={writesDisabled}
        />
        <Button
          isDisabled={writesDisabled || !description.trim()}
          onPress={() =>
            command.mutate(
              { operation: 'goal.card.create', input: { ...scope, description, priority: 0 } },
              { onSuccess: () => setDescription('') }
            )
          }
        >
          Add card
        </Button>
      </section>
      {(['activePlanVersionId', 'proposedPlanVersionId'] as const).map((pointer) => {
        const version = data.versions.find((version) => version.planVersionId === goal[pointer]);
        return (
          <section key={pointer}>
            <h2>{pointer === 'activePlanVersionId' ? 'Active Plan' : 'Proposed Plan'}</h2>
            {version ? (
              <>
                <p>
                  Version {version.sequence} · {version.digest}
                </p>
                <pre className="whitespace-pre-wrap break-words rounded-ok bg-sunken p-4">
                  {version.bytes}
                </pre>
              </>
            ) : (
              <p>None</p>
            )}
          </section>
        );
      })}
      <section className="space-y-3">
        <h2>Decisions</h2>
        {data.requests.map((request) => (
          <article
            key={request.requestId}
            className="space-y-2 rounded-ok border border-border p-4"
          >
            <h3>
              {request.operation === 'goal.plan.approve'
                ? 'Plan approval'
                : 'Completion acceptance'}
            </h3>
            <p>
              {request.state} · {request.resolution ?? 'Awaiting response'}
              {request.reason ? ` · ${request.reason}` : ''}
            </p>
            <pre className="whitespace-pre-wrap break-words">
              {JSON.stringify(request.exactIntent, null, 2)}
            </pre>
            {request.state === 'pending' && (
              <>
                <Button
                  isDisabled={writesDisabled}
                  onPress={() =>
                    command.mutate({
                      operation:
                        request.operation === 'goal.plan.approve'
                          ? 'goal.plan.approve'
                          : 'goal.completion.accept',
                      input: { ...scope, pendingRequestId: request.requestId, decision: 'granted' },
                    })
                  }
                >
                  {request.operation === 'goal.plan.approve' ? 'Approve Plan' : 'Accept completion'}
                </Button>
                <Button
                  variant="outline"
                  isDisabled={writesDisabled}
                  onPress={() =>
                    command.mutate({
                      operation:
                        request.operation === 'goal.plan.approve'
                          ? 'goal.plan.approve'
                          : 'goal.completion.accept',
                      input: { ...scope, pendingRequestId: request.requestId, decision: 'denied' },
                    })
                  }
                >
                  Decline
                </Button>
              </>
            )}
          </article>
        ))}
      </section>
      <section>
        <h2>Linked Tasks</h2>
        {data.tasks.length === 0 ? (
          <p>No Tasks admitted.</p>
        ) : (
          <ul>
            {data.tasks.map((task) => (
              <li key={task.threadId}>
                <Link to={`/tasks/${workspaceId}/${task.threadId}`}>{task.threadId}</Link> · Card
                revision {task.cardRevision} · Plan {task.planVersionId}
                <p>
                  {task.missing
                    ? 'Missing Task: unresolved'
                    : task.turns.map((turn) => `${turn.turnId}: ${turn.status}`).join(', ') ||
                      'No Turn recorded'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {!closed && (
        <section className="space-y-3">
          <h2>Cancel Goal</h2>
          <TextField
            label="Goal cancellation reason"
            value={reason}
            onChange={setReason}
            isDisabled={disabled}
          />
          <Button
            variant="negative-outline"
            isDisabled={disabled || !reason.trim()}
            onPress={() =>
              command.mutate({
                operation: 'goal.cancel',
                input: { ...scope, expectedRevision: goal.changeRevision, reason },
              })
            }
          >
            Cancel Goal
          </Button>
        </section>
      )}
    </main>
  );
}
