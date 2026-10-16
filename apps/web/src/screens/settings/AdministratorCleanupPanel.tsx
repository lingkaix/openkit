import {
  type AdministratorCleanupItem,
  AdministratorCleanupReadResponseSchema,
  type AdministratorCleanupSource,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useId } from 'react';
import { Disclosure, DisclosurePanel } from 'react-aria-components';
import { useCoreClient } from '../../app/core-client';
import { Button, Card, ErrorBanner, Skeleton } from '../../primitives';

const SOURCE_LABELS: Record<AdministratorCleanupSource, string> = {
  'workspace-deletion': 'Workspace deletion',
  'execution-attempt': 'Execution attempts',
  'backend-session': 'Backend sessions',
  'agent-session-binding': 'AgentSession bindings',
  'sandbox-runtime': 'Sandbox runtimes',
  'worker-storage': 'Worker storage',
};

const COVERAGE_REASONS = {
  count_limit: 'Count limit reached',
  byte_limit: 'Byte limit reached',
  source_unavailable: 'Source unavailable',
  source_changed: 'Source changed during inspection',
} as const;

const FIELD_LABELS: Record<string, string> = {
  kind: 'Kind',
  workspaceId: 'Workspace ID',
  requestId: 'Request ID',
  attemptId: 'Attempt ID',
  threadId: 'Thread ID',
  turnId: 'Turn ID',
  agentSessionId: 'AgentSession ID',
  agentSessionRuntimeBindingId: 'AgentSession runtime binding ID',
  sandboxRuntimeId: 'Sandbox runtime ID',
  runtimeTargetId: 'Runtime target ID',
  storageRef: 'Storage reference',
  phase: 'Phase',
  retainedStaging: 'Retained staging',
  cleanedAt: 'Cleaned at',
  disposition: 'Disposition',
  state: 'State',
  workspaceHandoffState: 'Workspace handoff state',
  physicalCleanedAt: 'Physical cleanup recorded at',
  physicalEpochRelation: 'Physical Epoch relation',
  lifecycleState: 'Lifecycle state',
  cleanupState: 'Cleanup state',
  healthState: 'Health state',
  drainState: 'Drain state',
  revision: 'Revision',
  purgedAt: 'Purged at',
};

/** Display only scalar fields from the validated, source-specific schema projection. */
function ObservationFields({
  fields,
}: {
  fields: Record<string, string | number | boolean | null>;
}) {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      {Object.entries(fields).map(([field, value]) => (
        <Fragment key={field}>
          <dt className="text-fg-muted">{FIELD_LABELS[field]}</dt>
          <dd className="min-w-0 break-words text-fg [overflow-wrap:anywhere]">
            {value === null
              ? 'Not recorded'
              : typeof value === 'boolean'
                ? value
                  ? 'Yes'
                  : 'No'
                : value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Preserve owner facts and exact inspection correlation without adding a cleanup action. */
function CleanupObservation({ item }: { item: AdministratorCleanupItem }) {
  return (
    <article
      aria-label={`${SOURCE_LABELS[item.source]} record`}
      className="min-w-0 border-t border-separator pt-3"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <h4 className="text-sm font-bold text-fg-strong">Exact target</h4>
        <ObservationFields fields={item.target} />
        <h4 className="text-sm font-bold text-fg-strong">Source state</h4>
        <ObservationFields fields={item.state} />
        <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <dt className="text-fg-muted">Source updated at</dt>
          <dd className="break-words text-fg">{item.sourceUpdatedAt ?? 'Unknown'}</dd>
          <dt className="text-fg-muted">Observed at</dt>
          <dd className="break-words text-fg">{item.observedAt}</dd>
        </dl>
        {item.evidence.kind === 'recorded' ? (
          <div className="text-sm text-fg">
            <p className="font-bold">Recorded evidence</p>
            <p>
              Recorded at: <time>{item.evidence.recordedAt}</time>
            </p>
            <p className="text-fg-muted">
              The evidence references this exact target. It does not establish an aggregate cleanup
              result.
            </p>
          </div>
        ) : (
          <p className="text-sm text-fg">Unknown evidence: {item.evidence.reason}</p>
        )}
        <Disclosure className="min-w-0">
          <Button slot="trigger" variant="quiet" size="sm">
            Inspection correlation
          </Button>
          <DisclosurePanel className="min-w-0 pt-2">
            <div className="flex min-w-0 flex-col gap-2 text-sm text-fg">
              <p className="text-fg-muted">
                Source record correlation only. This read provides no inspection or cleanup action.
              </p>
              <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                <dt className="text-fg-muted">Inspection kind</dt>
                <dd>{item.nextInspection.kind}</dd>
                <dt className="text-fg-muted">Source owner</dt>
                <dd className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {item.nextInspection.sourceOwner}
                </dd>
              </dl>
              <ObservationFields fields={item.nextInspection.target} />
            </div>
          </DisclosurePanel>
        </Disclosure>
      </div>
    </article>
  );
}

/** Read the six canonical cleanup sources with current server-admin admission on each request. */
export function AdministratorCleanupPanel() {
  const client = useCoreClient();
  const headingId = useId();
  const query = useQuery({
    queryKey: ['settings', 'administrator-cleanup'],
    queryFn: async () => {
      try {
        // Strip unknown descriptive fields before TanStack Query admits response data to its cache.
        return AdministratorCleanupReadResponseSchema.parse(
          await client.operations['administration.cleanup-read']({})
        );
      } catch (error) {
        // Server messages, validation issues and error details can contain private source data.
        if (error instanceof ApiCallError && (error.status === 401 || error.status === 403)) {
          throw new ApiCallError(error.status, 'Administrator access required.');
        }
        throw new Error('Cleanup inspection failed.');
      }
    },
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const denied = query.error instanceof ApiCallError;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-sm font-bold text-fg-strong">
          Cleanup observations
        </h2>
        <Button
          variant="outline"
          isDisabled={query.isFetching}
          onPress={() => void query.refetch()}
        >
          {query.isError ? 'Retry cleanup inspection' : 'Refresh cleanup inspection'}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">
        Read-only observations from existing source records. Terminal phases and Physical Epoch
        differences do not prove cleanup or permission to delete.
      </p>
      {/* Cached success does not establish current mount authority; refresh also hides older rows. */}
      {!query.isFetchedAfterMount || query.isPending || query.isFetching ? (
        <Skeleton lines={6} />
      ) : query.isError ? (
        <ErrorBanner
          message={denied ? 'Administrator access required.' : 'Cleanup inspection failed.'}
        />
      ) : (
        <>
          <p className="text-sm text-fg">
            Observed at: <time>{query.data.observedAt}</time>
          </p>
          <p className="text-sm font-bold text-fg-strong">
            {query.data.incomplete ? 'Coverage incomplete' : 'Source coverage complete'}
          </p>
          <p className="text-sm text-fg-muted">
            Coverage describes record enumeration. It does not establish that resources are clean or
            safe to delete.
          </p>
          {query.data.sources.map((source) => (
            <Card key={source.source} className="flex min-w-0 flex-col gap-3">
              <h3 className="text-sm font-bold text-fg-strong">{SOURCE_LABELS[source.source]}</h3>
              <p className="text-sm text-fg">
                {source.availability === 'available' ? 'Available' : 'Unavailable'} ·{' '}
                {source.incomplete ? 'Incomplete coverage' : 'Complete coverage'}
              </p>
              {source.reasons.length > 0 ? (
                <ul className="list-inside list-disc text-sm text-fg-muted">
                  {source.reasons.map((reason) => (
                    <li key={reason}>{COVERAGE_REASONS[reason]}</li>
                  ))}
                </ul>
              ) : null}
              {query.data.items
                .filter((item) => item.source === source.source)
                .map((item) => (
                  <CleanupObservation key={JSON.stringify(item.target)} item={item} />
                ))}
              {!query.data.items.some((item) => item.source === source.source) ? (
                <p className="text-sm text-fg-muted">No records returned.</p>
              ) : null}
            </Card>
          ))}
        </>
      )}
    </section>
  );
}
