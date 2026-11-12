import { ApiCallError } from '@openkit/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
} from '../../primitives';
import { AuditEventRow, PermissionDecisionRow, ThreadLink, useThreadActivity } from './AuditRows';
import { useServerAudit } from './data';
import {
  attentionClause,
  attentionSentence,
  isAttention,
  LongList,
  matchesLoadedRow,
} from './LongList';

/** Read-only server governance records, authorized by NanoCore from the current browser session. */
export function ServerAuditScreen() {
  const records = useServerAudit();
  const activity = useThreadActivity(
    records.data?.auditEvents.map((event) => event.workspaceId) ?? []
  );
  const denied =
    records.error instanceof ApiCallError &&
    (records.error.status === 401 || records.error.status === 403);

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Server audit"
        subtitle="Read-only server audit events and permission decisions recorded by NanoCore."
        actions={
          <Button
            variant="outline"
            isDisabled={records.isFetching}
            onPress={() => void records.refetch()}
          >
            Refresh audit
          </Button>
        }
      />
      {records.isLoading ||
      (records.isFetching && !records.isFetchingNextPage) ||
      !records.isFetchedAfterMount ? (
        <Skeleton lines={8} />
      ) : records.isError ? (
        denied ? (
          <EmptyState
            icon="key"
            title="Access denied"
            hint="Server audit requires derived server-admin authority on the signed-in session."
            action={
              <Button variant="outline" onPress={() => void records.refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <ErrorBanner
            message="Couldn't load server audit records."
            onRetry={() => void records.refetch()}
          />
        )
      ) : records.data ? (
        records.data.auditEvents.length === 0 && records.data.permissionDecisions.length === 0 ? (
          <>
            <EmptyState
              icon="usage"
              title="No server audit events"
              hint="Server audit events will appear here as Core records them."
            />
            <EmptyState
              icon="usage"
              title="No server permission decisions"
              hint="Server permission decisions will appear here as policy is evaluated."
            />
          </>
        ) : (
          <>
            <LongList
              summary={(filter) => {
                const lines = [
                  ...(records.data?.auditEvents ?? [])
                    .filter(
                      (event) =>
                        isAttention(event.outcome) &&
                        matchesLoadedRow(filter, {
                          outcome: event.outcome,
                          title: event.summary || event.action,
                          at: event.recordedAt,
                        })
                    )
                    .map((event) => (
                      <div key={event.id} className="flex flex-col gap-1">
                        <p>
                          {attentionSentence(
                            attentionClause(event.outcome),
                            event.summary || event.action,
                            event.recordedAt
                          )}
                        </p>
                        <ThreadLink
                          workspaceId={event.workspaceId}
                          threadId={event.threadId}
                          activity={activity.activityFor(event.threadId)}
                        />
                      </div>
                    )),
                  ...(records.data?.permissionDecisions ?? [])
                    .filter(
                      (decision) =>
                        isAttention(decision.result) &&
                        matchesLoadedRow(filter, {
                          outcome: decision.result,
                          title: decision.action,
                          at: decision.createdAt,
                        })
                    )
                    .map((decision) => (
                      <p key={decision.decisionId}>
                        {attentionSentence(
                          attentionClause(decision.result),
                          decision.action,
                          decision.createdAt
                        )}
                      </p>
                    )),
                ];
                return lines.length > 0 ? (
                  lines
                ) : (
                  <p>Nothing failed, was denied, or needs a decision.</p>
                );
              }}
              records={(filter) => (
                <>
                  <section className="flex flex-col gap-3" aria-labelledby="server-audit-events">
                    <h2
                      id="server-audit-events"
                      className="text-eyebrow font-bold tracking-eyebrow text-fg-muted"
                    >
                      Audit events
                    </h2>
                    {records.data?.auditEvents.length === 0 ? (
                      <EmptyState
                        icon="usage"
                        title="No server audit events"
                        hint="Server audit events will appear here as Core records them."
                      />
                    ) : (
                      <Card className="py-0">
                        {records.data?.auditEvents
                          .filter((event) =>
                            matchesLoadedRow(filter, {
                              outcome: event.outcome,
                              title: event.summary || event.action,
                              at: event.recordedAt,
                            })
                          )
                          .map((event) => (
                            <AuditEventRow
                              key={event.id}
                              event={event}
                              activity={activity.activityFor(event.threadId)}
                              audience={activity.sourceFor(event.threadId)}
                            />
                          ))}
                      </Card>
                    )}
                  </section>
                  <section
                    className="flex flex-col gap-3"
                    aria-labelledby="server-permission-decisions"
                  >
                    <h2
                      id="server-permission-decisions"
                      className="text-eyebrow font-bold tracking-eyebrow text-fg-muted"
                    >
                      Permission decisions
                    </h2>
                    {records.data?.permissionDecisions.length === 0 ? (
                      <EmptyState
                        icon="usage"
                        title="No server permission decisions"
                        hint="Server permission decisions will appear here as policy is evaluated."
                      />
                    ) : (
                      <Card className="py-0">
                        {records.data?.permissionDecisions
                          .filter((decision) =>
                            matchesLoadedRow(filter, {
                              outcome: decision.result,
                              title: decision.action,
                              at: decision.createdAt,
                            })
                          )
                          .map((decision) => (
                            <PermissionDecisionRow key={decision.decisionId} decision={decision} />
                          ))}
                      </Card>
                    )}
                  </section>
                </>
              )}
            />
            {records.hasNextPage ? (
              <Button
                variant="quiet"
                className="min-h-11 justify-start px-3"
                isDisabled={records.isFetchingNextPage}
                onPress={() => void records.fetchNextPage()}
              >
                Load more
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </Page>
  );
}
