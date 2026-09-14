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
import { AuditEventRow, PermissionDecisionRow } from './AuditRows';
import { useServerAudit } from './data';

/** Read-only server governance records, authorized by NanoCore from the current browser session. */
export function ServerAuditScreen() {
  const records = useServerAudit();
  const denied =
    records.error instanceof ApiCallError &&
    (records.error.status === 401 || records.error.status === 403);

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Server audit"
        subtitle="Read-only server audit events and permission decisions recorded by NanoCore."
      />
      {records.isLoading ? (
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
        <>
          <section className="flex flex-col gap-3" aria-labelledby="server-audit-events">
            <h2
              id="server-audit-events"
              className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
            >
              Audit events
            </h2>
            {records.data.auditEvents.length === 0 ? (
              <EmptyState
                icon="usage"
                title="No server audit events"
                hint="Server audit events will appear here as Core records them."
              />
            ) : (
              <Card className="py-0">
                {records.data.auditEvents.map((event) => (
                  <AuditEventRow key={event.id} event={event} />
                ))}
              </Card>
            )}
          </section>
          <section className="flex flex-col gap-3" aria-labelledby="server-permission-decisions">
            <h2
              id="server-permission-decisions"
              className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
            >
              Permission decisions
            </h2>
            {records.data.permissionDecisions.length === 0 ? (
              <EmptyState
                icon="usage"
                title="No server permission decisions"
                hint="Server permission decisions will appear here as policy is evaluated."
              />
            ) : (
              <Card className="py-0">
                {records.data.permissionDecisions.map((decision) => (
                  <PermissionDecisionRow key={decision.decisionId} decision={decision} />
                ))}
              </Card>
            )}
          </section>
        </>
      ) : null}
    </Page>
  );
}
