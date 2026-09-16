import { ApiCallError, createRequestId } from '@openkit/core-client';
import { Link } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  CountBadge,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  Icon,
  type IconName,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';
import { taskThreadPath, useConversationNavigation } from '../chat/data';
import {
  type AttentionRow,
  attentionDecisionErrorMessage,
  canDecideInline,
  chatThreadPath,
  inlineAttentionActionLabel,
  isStaleAttentionDecision,
  openHrefForRow,
  useCurrentWorkspaceId,
  useDecideAttention,
  useHumanAttention,
  waitingLabel,
} from './data';

type ConversationItem = NonNullable<ReturnType<typeof useConversationNavigation>['data']>[number];

const ACTIVITY_ICON: Record<ConversationItem['activity'], IconName> = {
  chat: 'chat',
  task: 'agents',
  goal: 'goal',
  unknown: 'info',
};

const ACTIVITY_LABEL: Record<ConversationItem['activity'], string> = {
  chat: 'Assistant chat',
  task: 'Worker task',
  goal: 'Goal',
  unknown: 'Activity type unknown',
};

/**
 * Overview / Action Center (WP-6, board 07) — the 1:N supervision home.
 *
 * Leads with Needs-you attention, then every ongoing Task and Goal from viewer
 * conversation navigation. Approvals Allow or Deny inline; Goal and Workspace
 * review stay inspect-first. Honors §9.13: skeleton, "You're all caught up",
 * error+retry, and stale counts / disabled actions when disconnected.
 */
export function OverviewScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const attention = useHumanAttention(workspaceId);
  const navigation = useConversationNavigation(workspaceId);
  const decide = useDecideAttention();
  const { failed: disconnected } = useConnection();

  const attentionRows = attention.data ?? [];
  const conversations = navigation.data ?? [];
  const ongoing = conversations.filter(
    (item) =>
      (item.activity === 'task' || item.activity === 'goal') &&
      (item.state === 'working' || item.state === 'needs-you')
  );
  const inProgress = ongoing.filter((item) => item.state === 'working');
  const attentionThreadIds = new Set(
    attentionRows.flatMap((row) => {
      const id = row.threadId ?? ('threadId' in row.source ? row.source.threadId : null);
      return id ? [id] : [];
    })
  );
  const extraNeedsYou = ongoing.filter(
    (item) => item.state === 'needs-you' && !attentionThreadIds.has(item.thread.id)
  );
  const conversationByThread = new Map(conversations.map((item) => [item.thread.id, item]));
  const needsYouCount = attentionRows.length + extraNeedsYou.length;
  const caughtUp = attention.isSuccess && navigation.isSuccess && needsYouCount === 0;

  const currentDecision = decide.variables?.row.workspaceId === workspaceId;
  const accessDenied =
    decide.error instanceof ApiCallError && decide.error.code === 'workspace_access_denied';

  const retryDecision = () => {
    if (!currentDecision) return;
    if (isStaleAttentionDecision(decide.error)) {
      decide.reset();
      void attention.refetch();
      void navigation.refetch();
      return;
    }
    if (decide.variables) {
      decide.mutate(decide.variables);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Overview"
        subtitle="Ongoing Tasks and Goals, and anything that needs a decision."
        actions={
          <span className="flex items-center gap-2">
            <CountBadge count={needsYouCount} label="need you" />
            {disconnected ? <StatusChip tone="notice">Counts may be stale</StatusChip> : null}
          </span>
        }
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <Eyebrow>Needs you</Eyebrow>
          <span className="text-xs text-fg-muted">Longest waiting first</span>
        </div>

        {currentDecision && decide.isError ? (
          <ErrorBanner
            message={attentionDecisionErrorMessage(decide.error)}
            onRetry={disconnected || accessDenied ? undefined : retryDecision}
          />
        ) : null}

        {!workspaceId || attention.isLoading ? (
          <Skeleton lines={4} />
        ) : attention.isError ? (
          <ErrorBanner
            message="Couldn't load what needs you."
            onRetry={() => void attention.refetch()}
          />
        ) : caughtUp ? (
          <EmptyState
            icon="home"
            title="You're all caught up"
            hint="When something needs a decision, it will show up here."
          />
        ) : (
          <>
            {needsYouCount > 0 ? (
              <Card className="p-0 px-4">
                {attentionRows.map((row) => (
                  <AttentionListRow
                    key={row.id}
                    row={row}
                    conversation={
                      conversationByThread.get(
                        row.threadId ??
                          ('threadId' in row.source ? (row.source.threadId ?? '') : '')
                      ) ?? null
                    }
                    disabled={
                      disconnected ||
                      (currentDecision &&
                        (decide.isPending ||
                          (decide.isError && decide.variables?.row.id === row.id))) ||
                      attention.isFetching
                    }
                    onDecide={(action) =>
                      decide.mutate({ row, action, requestId: createRequestId() })
                    }
                  />
                ))}
                {extraNeedsYou.map((item) => (
                  <ConversationWorkRow key={item.thread.id} item={item} />
                ))}
              </Card>
            ) : null}
          </>
        )}
      </section>

      {navigation.isLoading || navigation.isError || inProgress.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Eyebrow>In progress</Eyebrow>
          {!workspaceId || navigation.isLoading ? (
            <Skeleton lines={4} />
          ) : navigation.isError ? (
            <ErrorBanner
              message="Couldn't load ongoing work."
              onRetry={() => void navigation.refetch()}
            />
          ) : (
            <Card className="p-0 px-4">
              {inProgress.map((item) => (
                <ConversationWorkRow key={item.thread.id} item={item} />
              ))}
            </Card>
          )}
        </section>
      ) : null}
    </Page>
  );
}

function AttentionListRow({
  row,
  conversation,
  disabled,
  onDecide,
}: {
  row: AttentionRow;
  conversation: ConversationItem | null;
  disabled: boolean;
  onDecide: (action: AttentionRow['actions'][number]) => void;
}) {
  const openHref = openHrefForRow(row);
  const decidable = row.actions.filter((action) => canDecideInline(row, action));
  const showOpen =
    openHref &&
    (decidable.length === 0 || row.actions.some((action) => action.kind === 'open_thread'));
  const activity = conversation?.activity;

  return (
    <ListRow className="flex-wrap items-start sm:items-center">
      {activity ? <Icon name={ACTIVITY_ICON[activity]} label={ACTIVITY_LABEL[activity]} /> : null}
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-bold text-fg-strong">{row.title}</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          {conversation ? `${conversation.thread.name ?? 'Untitled conversation'} · ` : ''}
          {waitingLabel(row.createdAt)}
          {row.summary ? ` · ${row.summary}` : ''}
        </p>
      </div>
      {conversation ? (
        <StatusChip tone={conversation.state === 'needs-you' ? 'notice' : 'informative'} dot>
          {statusLabel(conversation.state)}
        </StatusChip>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {decidable.map((action) => (
          <Button
            key={action.kind}
            size="sm"
            variant={
              action.kind === 'grant_approval' || action.kind === 'accept_review'
                ? 'accent'
                : 'outline'
            }
            isDisabled={disabled || action.disabled}
            onPress={() => onDecide(action)}
          >
            {inlineAttentionActionLabel(action)}
          </Button>
        ))}
        {showOpen && openHref ? (
          <Link
            to={openHref}
            aria-label={openLabelForHref(openHref)}
            className="inline-flex h-7 items-center rounded-full border border-border bg-card px-3 text-xs font-bold text-fg outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-focus"
          >
            Open
          </Link>
        ) : null}
      </div>
    </ListRow>
  );
}

/** Displays one current Task or Goal with its mode-specific destination. */
function ConversationWorkRow({ item }: { item: ConversationItem }) {
  const href = conversationHref(item);
  const title = item.thread.name ?? ACTIVITY_LABEL[item.activity];

  return (
    <ListRow className="flex-wrap items-start sm:items-center">
      <Icon name={ACTIVITY_ICON[item.activity]} label={ACTIVITY_LABEL[item.activity]} />
      <div className="min-w-0 flex-1">
        <h3 title={title} className="line-clamp-2 text-sm font-bold text-fg-strong">
          {title}
        </h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          {ACTIVITY_LABEL[item.activity]} · {statusLabel(item.state)}
        </p>
      </div>
      <StatusChip tone={item.state === 'needs-you' ? 'notice' : 'informative'} dot>
        {statusLabel(item.state)}
      </StatusChip>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={href}
          aria-label={openLabelForHref(href)}
          className="inline-flex h-7 items-center rounded-full border border-border bg-card px-3 text-xs font-bold text-fg outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-focus"
        >
          Open
        </Link>
      </div>
    </ListRow>
  );
}

/** Resolves the existing route owned by the conversation activity. */
function conversationHref(item: ConversationItem): string {
  if (item.activity === 'goal') {
    return `/goals/${encodeURIComponent(item.thread.workspaceId)}/${encodeURIComponent(item.thread.id)}`;
  }
  if (item.activity === 'task') {
    return taskThreadPath(item.thread.workspaceId, item.thread.id);
  }
  return chatThreadPath(item.thread.workspaceId, item.thread.id);
}

/** Labels the current navigation state. */
function statusLabel(state: ConversationItem['state']): string {
  if (state === 'working') return 'Working';
  if (state === 'needs-you') return 'Needs your attention';
  return 'Idle';
}

/** Gives each contextual destination an accessible link name. */
function openLabelForHref(href: string): string {
  if (href === '/workspace-changes') return 'Open workspace changes';
  if (href.includes('/goals/')) return 'Open goal';
  if (href.includes('/tasks/')) return 'Open task';
  return 'Open thread';
}
