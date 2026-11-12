import type { GoalCard, GoalRecord, GoalView } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import { useSurfaceParams } from '../../app/route-params';
import {
  Button,
  Dialog,
  ErrorBanner,
  Modal,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { taskThreadPath } from '../chat/data';
import { ThreadStream } from '../chat/ThreadStream';
import { runStatusLabel, timelineCopy } from '../chat/timeline/copy';
import { GoalNeedsYou } from '../chat/timeline/NeedsYouBar';
import { focusGoalCard } from '../chat/timeline/needs-you';
import { useTimelineSheets } from '../chat/timeline/PhoneChrome';
import { looksLikeIdentifier } from '../chat/timeline/present';
import { selectAgentProfile } from '../chat/timeline/profiles';
import { timelineJump } from '../chat/timeline/window';
import { useCurrentWorkspaceId, useGoalCommand, useGoalView } from './data';

const EDIT_CONSEQUENCE = 'goal-edit-consequence';
const APPROVE_CONSEQUENCE = 'goal-approve-consequence';
const ACCEPT_CONSEQUENCE = 'goal-accept-consequence';
const DENY_CONSEQUENCE = 'goal-deny-consequence';
const CANCEL_CONSEQUENCE = 'goal-cancel-consequence';
const CANCEL_CARD_CONSEQUENCE = 'goal-cancel-card-consequence';

type GoalTask = GoalView['tasks'][number];
type GoalCommand = ReturnType<typeof useGoalCommand>;

function goalStatus(kind: string | undefined): string {
  if (kind === 'accepted') return 'Accepted';
  if (kind === 'cancelled') return 'Cancelled';
  return 'Open';
}

function plainName(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || looksLikeIdentifier(text)) return null;
  return text;
}

function taskState(task: GoalTask): string {
  if (task.missing) return timelineCopy.missingTask;
  if (task.admittedAt == null || task.turns.length === 0) return timelineCopy.goalReserved;
  return runStatusLabel(task.turns[task.turns.length - 1]?.status);
}

function cardLabel(card: GoalCard): string {
  return plainName(card.description) ?? timelineCopy.linkedTask;
}

/** Current card editing is separate from immutable Plan bytes and admitted Task input. */
function CardEditor({
  card,
  goal,
  command,
  disabled,
  tasks,
  workspaceId,
}: {
  card: GoalCard;
  goal: GoalRecord;
  command: GoalCommand;
  disabled: boolean;
  tasks: readonly GoalTask[];
  workspaceId: string;
}) {
  const [description, setDescription] = useState(card.description);
  const [priority, setPriority] = useState(String(card.priority));
  const [reason, setReason] = useState('');
  const scope = { workspaceId: goal.workspaceId, threadId: goal.threadId, goalId: goal.goalId };
  const label = cardLabel(card);
  const linked = tasks.filter((task) => task.cardId === card.cardId);
  return (
    <li
      id={`goal-card-${card.cardId}`}
      tabIndex={-1}
      aria-label={label}
      className="rounded-ok border border-border bg-card p-4 space-y-3 outline-none focus:ring-2 focus:ring-focus"
    >
      <h3>{label}</h3>
      {linked.length === 0 ? (
        <p>No Task linked</p>
      ) : (
        <ul>
          {linked.map((task) => (
            <li key={task.threadId}>
              <Link to={taskThreadPath(workspaceId, task.threadId)}>{label}</Link>
              <p>{taskState(task)}</p>
            </li>
          ))}
        </ul>
      )}
      <TextField
        label="Card description"
        value={description}
        onChange={setDescription}
        isDisabled={disabled || card.cancelled}
      />
      <TextField
        label="Priority"
        value={priority}
        onChange={setPriority}
        isDisabled={disabled || card.cancelled}
      />
      {card.cancelled ? (
        <p>{plainName(card.cancellationReason) ?? 'Cancelled'}</p>
      ) : (
        <>
          <Button
            aria-describedby={EDIT_CONSEQUENCE}
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
            Save card
          </Button>
          <TextField
            label="Card cancellation reason"
            value={reason}
            onChange={setReason}
            isDisabled={disabled}
          />
          <Button
            variant="negative-outline"
            aria-describedby={CANCEL_CARD_CONSEQUENCE}
            isDisabled={disabled || !reason.trim()}
            onPress={() =>
              command.mutate({
                operation: 'goal.card.cancel',
                input: { ...scope, cardId: card.cardId, expectedRevision: card.revision, reason },
              })
            }
          >
            Cancel card
          </Button>
        </>
      )}
    </li>
  );
}

/** One Goal journey: board, then Needs you, then the Coordinator narrative. */
export function GoalScreen() {
  const { workspaceId: routeWorkspaceId = '', threadId = '' } = useSurfaceParams('goal');
  const workspaceId = useCurrentWorkspaceId(routeWorkspaceId);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useGoalView(workspaceId, threadId);
  const command = useGoalCommand(workspaceId ?? '', threadId);
  const connection = useConnection();
  const [intent, setIntent] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [inspect, setInspect] = useState(false);
  const sheets = useTimelineSheets();
  const cardAnchor = searchParams.get('card');
  useEffect(() => {
    if (!cardAnchor || !view.data?.cards.some((card) => card.cardId === cardAnchor)) return;
    focusGoalCard(cardAnchor);
  }, [cardAnchor, view.data]);
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
  const profile = selectAgentProfile({ entryPath: 'conversation', mode: 'goal' });
  const taskLabels = new Map(
    data.tasks.map((task) => {
      const card = data.cards.find((entry) => entry.cardId === task.cardId);
      return [task.threadId, card ? cardLabel(card) : timelineCopy.linkedTask] as const;
    })
  );
  const cardByThread = new Map(data.tasks.map((task) => [task.threadId, task.cardId] as const));
  function rememberCard(cardId: string) {
    const next = new URLSearchParams(searchParams);
    next.set('card', cardId);
    setSearchParams(next, { replace: true });
  }
  return (
    <main
      className="mx-auto max-w-3xl space-y-6 px-6 py-8 pb-24"
      data-agent-profile={profile.state === 'ready' ? profile.profile.id : 'error'}
    >
      <header className="space-y-2">
        <h1>{goal.intent}</h1>
        <StatusChip tone="neutral">{goalStatus(goal.disposition?.kind)}</StatusChip>
        <p>Worker results remain evidence until a person accepts completion.</p>
        <Button
          variant="quiet"
          aria-label={timelineCopy.inspectGoal}
          onPress={() => setInspect((open) => !open)}
        >
          {timelineCopy.inspectRun}
        </Button>
      </header>
      {inspect ? (
        <aside
          aria-label={timelineCopy.inspectorLabel}
          data-surface="inspector"
          className="space-y-2"
        >
          <h2>{timelineCopy.inspectorLabel}</h2>
          <h3>{timelineCopy.identifiersHeading}</h3>
          <p>Goal</p>
          <p className="break-all">{goal.goalId}</p>
          <p>Responsible person</p>
          <p className="break-all">{goal.responsibleUserId}</p>
          {data.versions.map((version) => (
            <div key={version.planVersionId}>
              <p>Plan</p>
              <p className="break-all">{version.planVersionId}</p>
              <p className="break-all">{version.digest}</p>
            </div>
          ))}
          {data.cards.map((card) => (
            <div key={card.cardId}>
              <p>Card</p>
              <p className="break-all">{card.cardId}</p>
            </div>
          ))}
          {data.tasks.map((task) => (
            <div key={task.threadId}>
              <p>Task</p>
              <p className="break-all">{task.threadId}</p>
            </div>
          ))}
        </aside>
      ) : null}
      {error}
      <section aria-label={timelineCopy.goalBoard} className="space-y-6">
        <section aria-label="Current intent" className="space-y-3">
          <h2>Current intent</h2>
          <p>{goal.intent}</p>
          <p id={EDIT_CONSEQUENCE}>{timelineCopy.goalEditConsequence}</p>
          <TextField
            label="Revised intent"
            value={intent}
            onChange={setIntent}
            isDisabled={writesDisabled}
          />
          <Button
            aria-describedby={EDIT_CONSEQUENCE}
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
          <p id={CANCEL_CARD_CONSEQUENCE}>{timelineCopy.cancelCardConsequence}</p>
          <ul className="space-y-3">
            {data.cards.map((card) => (
              <CardEditor
                key={`${card.cardId}:${card.revision}`}
                card={card}
                goal={goal}
                command={command}
                disabled={writesDisabled}
                tasks={data.tasks}
                workspaceId={workspaceId}
              />
            ))}
          </ul>
          {/* goal.read is the only Task list. A new Goal does not include the origin Thread until admission writes the link. */}
          {data.tasks.length === 0 ? <p>No Tasks admitted.</p> : null}
          <TextField
            label="New card description"
            value={description}
            onChange={setDescription}
            isDisabled={writesDisabled}
          />
          <Button
            aria-describedby={EDIT_CONSEQUENCE}
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
          const version = data.versions.find((entry) => entry.planVersionId === goal[pointer]);
          return (
            <section key={pointer}>
              <h2>{pointer === 'activePlanVersionId' ? 'Active Plan' : 'Proposed Plan'}</h2>
              {/* TB-plan-diff: goal.read returns each version's bytes, not a diff. */}
              {version ? (
                <>
                  <p>Version {version.sequence}</p>
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
        {goal.disposition?.kind === 'accepted' && (
          <section className="space-y-3">
            <h2>Accepted completion</h2>
            <p>
              {plainName(goal.disposition.actorId)
                ? `Accepted by ${plainName(goal.disposition.actorId)}`
                : 'Accepted'}
            </p>
            <p>{goal.disposition.candidate.summary}</p>
            <h3>Unresolved work at acceptance</h3>
            {goal.disposition.candidate.unresolvedWork.length ? (
              <p className="whitespace-pre-wrap">
                {goal.disposition.candidate.unresolvedWork.join('\n')}
              </p>
            ) : (
              <p>None recorded.</p>
            )}
          </section>
        )}
        <section className="space-y-3">
          <h2>Decisions</h2>
          {data.requests.map((request) => {
            const approve = request.operation === 'goal.plan.approve';
            const actor = plainName(request.decidingActorId);
            const candidate = request.exactIntent.candidate;
            const summary =
              candidate &&
              typeof candidate === 'object' &&
              'summary' in candidate &&
              typeof candidate.summary === 'string'
                ? plainName(candidate.summary)
                : null;
            return (
              <article
                key={request.requestId}
                className="space-y-2 rounded-ok border border-border p-4"
              >
                <h3>{approve ? 'Plan approval' : 'Completion acceptance'}</h3>
                {request.state === 'pending' ? <p>{timelineCopy.awaitingDecision}</p> : null}
                {!closed &&
                request.resolution === 'granted' &&
                request.claim === 'unclaimed' &&
                !request.disposition ? (
                  <p>Granted; waiting for the Goal owner to apply this exact decision.</p>
                ) : null}
                {request.disposition ? <p>Decision outcome recorded.</p> : null}
                {actor ? <p>Decision by {actor}</p> : null}
                {summary ? <p>{summary}</p> : null}
                {request.state === 'pending' && (
                  <>
                    <p id={approve ? APPROVE_CONSEQUENCE : ACCEPT_CONSEQUENCE}>
                      {approve
                        ? timelineCopy.approvePlanConsequence
                        : timelineCopy.acceptGoalConsequence}
                    </p>
                    <p id={DENY_CONSEQUENCE}>{timelineCopy.denyConsequence}</p>
                    <Button
                      aria-describedby={approve ? APPROVE_CONSEQUENCE : ACCEPT_CONSEQUENCE}
                      isDisabled={writesDisabled}
                      onPress={() =>
                        command.mutate({
                          operation: approve ? 'goal.plan.approve' : 'goal.completion.accept',
                          input: {
                            ...scope,
                            pendingRequestId: request.requestId,
                            decision: 'granted',
                          },
                        })
                      }
                    >
                      {approve ? 'Approve Plan' : 'Accept completion'}
                    </Button>
                    <Button
                      variant="outline"
                      aria-describedby={DENY_CONSEQUENCE}
                      isDisabled={writesDisabled}
                      onPress={() =>
                        command.mutate({
                          operation: approve ? 'goal.plan.approve' : 'goal.completion.accept',
                          input: {
                            ...scope,
                            pendingRequestId: request.requestId,
                            decision: 'denied',
                          },
                        })
                      }
                    >
                      Decline
                    </Button>
                  </>
                )}
              </article>
            );
          })}
        </section>
        {!closed && (
          <section className="space-y-3">
            <h2>Cancel Goal</h2>
            <p id={CANCEL_CONSEQUENCE}>{timelineCopy.cancelGoalConsequence}</p>
            <TextField
              label="Goal cancellation reason"
              value={reason}
              onChange={setReason}
              isDisabled={disabled}
            />
            <Modal
              trigger={
                <Button
                  variant="negative-outline"
                  aria-describedby={CANCEL_CONSEQUENCE}
                  isDisabled={disabled || !reason.trim()}
                >
                  Cancel Goal
                </Button>
              }
            >
              <Dialog title="Cancel Goal">
                <p>{timelineCopy.cancelGoalConsequence}</p>
                <Button
                  variant="negative"
                  aria-describedby={CANCEL_CONSEQUENCE}
                  isDisabled={disabled || !reason.trim()}
                  onPress={() =>
                    command.mutate({
                      operation: 'goal.cancel',
                      input: { ...scope, expectedRevision: goal.changeRevision, reason },
                    })
                  }
                >
                  {timelineCopy.confirmCancel}
                </Button>
                <Button slot="close" variant="quiet">
                  {timelineCopy.keepGoal}
                </Button>
              </Dialog>
            </Modal>
          </section>
        )}
      </section>
      <GoalNeedsYou
        workspaceId={workspaceId}
        threadIds={[goal.threadId, ...data.tasks.map((task) => task.threadId)]}
        taskLabels={taskLabels}
        cardByThread={cardByThread}
        onFocusCard={rememberCard}
      />
      {/* Handoff lines render here when the Coordinator thread has them. goal.read has no separate handoff record. The Coordinator is never a steer target. */}
      <ThreadStream
        workspaceId={workspaceId}
        threadId={goal.threadId}
        narrativeOnly
        mode="goal"
        emptyTitle={timelineCopy.emptyGoalTitle}
        sheets={sheets}
        onJumpToItem={(itemId) => {
          const target = timelineJump({
            pathname: location.pathname,
            search: location.search,
            jump: { kind: 'item', itemId },
          });
          navigate({ pathname: target.pathname, search: target.search }, { replace: true });
        }}
      />
    </main>
  );
}
