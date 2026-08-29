import { Link } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  CountBadge,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';
import {
  type AttentionRow,
  canDecideInline,
  chatThreadPath,
  openHrefForRow,
  useCurrentWorkspaceId,
  useDecideAttention,
  useHumanAttention,
  useWorkspaceDashboard,
  waitingLabel,
} from './data';

/**
 * Overview / Action Center (WP-6, board 07) — the 1:N supervision home.
 *
 * Leads with the Needs-you queue sorted by waiting time. Rows that carry enough
 * ids decide inline (Approve / Skip); otherwise they offer an Open link into the
 * owning thread. Ambient in-motion cards come from the workspace dashboard when
 * available. Honors §9.13: skeleton, "You're all caught up", error+retry, and
 * stale counts / disabled actions when disconnected.
 */
export function OverviewScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const attention = useHumanAttention(workspaceId);
  const dashboard = useWorkspaceDashboard(workspaceId);
  const decide = useDecideAttention(workspaceId);
  const { failed: disconnected } = useConnection();

  const rows = attention.data ?? [];
  const activeWork = dashboard.data?.activeWork ?? [];

  return (
    <Page>
      <PageHeader
        title="Overview"
        subtitle="Everything that needs you, and everything in motion."
        actions={
          <span className="flex items-center gap-2">
            <CountBadge count={rows.length} label="need you" />
            {disconnected ? <StatusChip tone="notice">Counts may be stale</StatusChip> : null}
          </span>
        }
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <Eyebrow>Needs you</Eyebrow>
          <span className="text-xs text-fg-muted">Longest waiting first</span>
        </div>

        {!workspaceId || attention.isLoading ? (
          <Skeleton lines={4} />
        ) : attention.isError ? (
          <ErrorBanner
            message="Couldn't load what needs you."
            onRetry={() => void attention.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="home"
            title="You're all caught up"
            hint="When something needs a decision, it will show up here."
          />
        ) : (
          <Card className="p-0 px-4">
            {rows.map((row) => (
              <AttentionListRow
                key={row.id}
                row={row}
                disabled={disconnected || decide.isPending}
                onDecide={(action) => decide.mutate({ row, action })}
              />
            ))}
          </Card>
        )}
      </section>

      {activeWork.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Eyebrow>In motion</Eyebrow>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeWork.map((work) => (
              <Card key={work.threadId}>
                <div className="flex items-center gap-2">
                  <Eyebrow>{work.mode}</Eyebrow>
                  <StatusChip tone="informative" dot>
                    {work.status}
                  </StatusChip>
                </div>
                <p className="mt-2 text-sm font-bold text-fg-strong">{work.title}</p>
                {work.summary ? <p className="mt-1 text-xs text-fg-muted">{work.summary}</p> : null}
                <Link
                  to={workspaceId ? chatThreadPath(workspaceId, work.threadId) : '/chat'}
                  className="mt-3 inline-flex text-xs font-bold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  Open
                </Link>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </Page>
  );
}

function AttentionListRow({
  row,
  disabled,
  onDecide,
}: {
  row: AttentionRow;
  disabled: boolean;
  onDecide: (action: AttentionRow['actions'][number]) => void;
}) {
  const openHref = openHrefForRow(row);
  const decidable = row.actions.filter((action) => canDecideInline(row, action));
  const showOpen =
    openHref &&
    (decidable.length === 0 || row.actions.some((action) => action.kind === 'open_thread'));

  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-bold text-fg-strong">{row.title}</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          {waitingLabel(row.createdAt)}
          {row.summary ? ` · ${row.summary}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
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
            {action.label}
          </Button>
        ))}
        {showOpen && openHref ? (
          <Link
            to={openHref}
            aria-label="Open thread"
            className="inline-flex h-7 items-center rounded-full border border-border bg-card px-3 text-xs font-bold text-fg outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-focus"
          >
            Open
          </Link>
        ) : null}
      </div>
    </ListRow>
  );
}
