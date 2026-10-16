import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCoreClient } from '../../app/core-client';
import { Button, Card, EmptyState, ErrorBanner, Skeleton, StatusChip } from '../../primitives';
import { projectSafeValue } from './secret-safe';

const SUBSYSTEMS = {
  config: 'Configuration',
  storage: 'Storage',
  policy: 'Policy',
  vault: 'Vault',
  scheduler: 'Scheduler',
  llmGateway: 'Gateway',
  knowledgeIndex: 'Knowledge index',
} as const;

/** Keep only public health fields before TanStack Query retains the observation. */
function projectHealth(value: Awaited<ReturnType<CoreClient['operations']['diagnostics.app']>>) {
  const readiness = value.readiness;
  return {
    build: value.build
      ? { releaseTag: value.build.releaseTag, sourceCommit: value.build.sourceCommit }
      : null,
    boot: {
      acceptingProductWork: value.boot.acceptingProductWork,
      overall: value.boot.overall,
      subsystems: Object.entries(SUBSYSTEMS).map(([key, label]) => {
        const subsystem = value.boot.subsystems[key as keyof typeof SUBSYSTEMS];
        return {
          label,
          state: subsystem.state,
          reasons: subsystem.reasons.map((reason) => ({
            code: projectSafeValue(reason.code) as string,
            message: projectSafeValue(reason.message) as string,
            blocks: reason.blocks.map((block) => projectSafeValue(block) as string),
          })),
        };
      }),
    },
    process: {
      observedAt: value.process.observedAt,
      nodeVersion: projectSafeValue(value.process.nodeVersion) as string,
      uptimeSeconds: value.process.uptimeSeconds,
      memory: {
        rssBytes: value.process.memory.rssBytes,
        heapUsedBytes: value.process.memory.heapUsedBytes,
        heapTotalBytes: value.process.memory.heapTotalBytes,
      },
      telemetry: {
        enabled: value.process.telemetry.enabled,
        exportConfigured: value.process.telemetry.exportConfigured,
      },
    },
    runtimeConfig: {
      currentVersion: value.runtimeConfig.currentVersion,
      pendingRestartCount: value.runtimeConfig.pendingRestart.length,
    },
    readiness: readiness
      ? {
          serviceAvailability: readiness.serviceAvailability,
          productWork: readiness.productWork,
          update: readiness.update.state,
          maintenance: readiness.maintenanceSafety.state,
          maintenanceObservedAt: readiness.maintenanceSafety.observation?.observedAt ?? null,
          executionHost: {
            state: readiness.executionHost.state,
            observedAt: readiness.executionHost.observedAt,
            observationAgeMs: readiness.executionHost.observationAgeMs,
            freshEmpty: readiness.executionHost.freshEmpty,
          },
        }
      : null,
  };
}

/** A local date and timezone with the exact server instant in semantic markup. */
function ObservationTime({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>
      {new Date(value).toLocaleString(undefined, { timeZoneName: 'short' })}
    </time>
  ) : (
    <>Unavailable</>
  );
}

/** An existing boot state never implies that every product operation is admitted. */
function bootTone(state: BootReadinessSnapshot['overall']) {
  return state === 'ready' ? 'positive' : state === 'failed' ? 'negative' : 'notice';
}

/** Existing Settings card grammar for one independent diagnostic family. */
function HealthSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h3 className="text-lg font-extrabold text-fg-strong">{title}</h3>
      <Card className="flex flex-col gap-3">{children}</Card>
    </section>
  );
}

/** Current administrator-authorized health, configuration and readiness observations. */
export function ServerHealthPanel() {
  const client = useCoreClient();
  const health = useQuery({
    queryKey: ['settings', 'server-operations', 'health'],
    queryFn: async ({ signal }) => {
      try {
        const response = await client.operations['diagnostics.app']({});
        // Discard a pending response when this mount loses its query observation.
        signal.throwIfAborted();
        return projectHealth(response);
      } catch (error) {
        if (error instanceof ApiCallError && (error.status === 401 || error.status === 403)) {
          throw new ApiCallError(error.status, 'Administrator access required.');
        }
        throw new Error('Server health unavailable.');
      }
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const denied =
    health.error instanceof ApiCallError &&
    (health.error.status === 401 || health.error.status === 403);
  const current = health.data;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="server-health">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="server-health" className="text-lg font-extrabold text-fg-strong">
          Server health
        </h2>
        <Button
          variant="outline"
          isDisabled={health.isFetching}
          onPress={() => void health.refetch()}
        >
          Refresh health
        </Button>
      </div>
      {!health.isFetchedAfterMount || health.isFetching ? (
        <Skeleton lines={8} />
      ) : health.isError ? (
        denied ? (
          <EmptyState
            icon="key"
            title="Access denied"
            hint="Server health requires current server-admin authority on the signed-in session."
            action={<Button onPress={() => void health.refetch()}>Retry</Button>}
          />
        ) : (
          <ErrorBanner
            message="Couldn't load server health."
            onRetry={() => void health.refetch()}
          />
        )
      ) : !current ? (
        <Skeleton lines={8} />
      ) : (
        <>
          <HealthSection title="Boot readiness">
            <div className="flex flex-wrap gap-2">
              <StatusChip tone={bootTone(current.boot.overall)}>
                {current.boot.overall === 'ready'
                  ? 'Ready'
                  : current.boot.overall === 'failed'
                    ? 'Failed'
                    : 'Degraded'}
              </StatusChip>
              <StatusChip tone={current.boot.acceptingProductWork ? 'positive' : 'notice'}>
                {current.boot.acceptingProductWork
                  ? 'Accepting product work'
                  : 'Product work blocked'}
              </StatusChip>
            </div>
            {current.boot.subsystems.map((subsystem) => (
              <section
                key={subsystem.label}
                aria-label={subsystem.label}
                className="flex flex-col gap-2 border-t border-separator pt-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-bold text-fg-strong">{subsystem.label}</h4>
                  <StatusChip tone={bootTone(subsystem.state)}>
                    {subsystem.state === 'ready'
                      ? 'Ready'
                      : subsystem.state === 'failed'
                        ? 'Failed'
                        : 'Degraded'}
                  </StatusChip>
                </div>
                {subsystem.reasons.map((reason) => (
                  <div key={JSON.stringify(reason)} className="text-sm text-fg-muted">
                    <p>{reason.message}</p>
                    <p>Code: {reason.code}</p>
                    <p>Blocks: {reason.blocks.length ? reason.blocks.join(', ') : 'None'}</p>
                  </div>
                ))}
              </section>
            ))}
          </HealthSection>
          <HealthSection title="Operational readiness">
            {!current.readiness ? (
              <p className="text-sm text-fg-muted">Operational readiness unavailable</p>
            ) : (
              <>
                <p>Service {current.readiness.serviceAvailability}</p>
                <p>Product admission: {current.readiness.productWork}</p>
                <p>
                  {current.readiness.update === 'configured'
                    ? 'Update helper configured; preparation required'
                    : 'Update helper unconfigured'}
                </p>
                <p>Maintenance {current.readiness.maintenance}</p>
                <p className="text-sm text-fg-muted">
                  Maintenance observed:{' '}
                  <ObservationTime value={current.readiness.maintenanceObservedAt} />
                </p>
                <p>Stored execution-host observation: {current.readiness.executionHost.state}</p>
                <p className="text-sm text-fg-muted">
                  Host observed:{' '}
                  <ObservationTime value={current.readiness.executionHost.observedAt} />
                </p>
                <p className="text-sm text-fg-muted">
                  Observation age:{' '}
                  {current.readiness.executionHost.observationAgeMs === null
                    ? 'Unavailable'
                    : `${current.readiness.executionHost.observationAgeMs} ms`}
                </p>
                <p className="text-sm text-fg-muted">
                  Host fresh-empty:{' '}
                  {current.readiness.executionHost.freshEmpty === null
                    ? 'Unknown'
                    : current.readiness.executionHost.freshEmpty
                      ? 'Yes'
                      : 'No'}
                  . This stored observation is not a live probe and does not prove deployment
                  idleness.
                </p>
              </>
            )}
          </HealthSection>
          <HealthSection title="Process and Telemetry">
            <p className="text-sm text-fg-muted">
              Sampled: <ObservationTime value={current.process.observedAt} />
            </p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt>Node version</dt>
              <dd>{current.process.nodeVersion}</dd>
              <dt>Uptime</dt>
              <dd>{current.process.uptimeSeconds.toLocaleString()} seconds</dd>
              <dt>Process RSS</dt>
              <dd>{current.process.memory.rssBytes.toLocaleString()} bytes</dd>
              <dt>Heap used</dt>
              <dd>{current.process.memory.heapUsedBytes.toLocaleString()} bytes</dd>
              <dt>Heap total</dt>
              <dd>{current.process.memory.heapTotalBytes.toLocaleString()} bytes</dd>
            </dl>
            <p>
              {current.process.telemetry.enabled
                ? 'Telemetry SDK enabled'
                : current.process.telemetry.exportConfigured
                  ? 'Exporter configured; SDK inactive'
                  : 'Telemetry exporter unconfigured'}
            </p>
            <p className="text-sm text-fg-muted">
              Telemetry configuration does not prove delivery. Memory describes the NanoCore
              process, not host capacity or Worker health.
            </p>
          </HealthSection>
          <HealthSection title="Running release and configuration">
            {current.build?.releaseTag ? (
              <>
                <p>{current.build.releaseTag}</p>
                <p className="break-all text-sm text-fg-muted">
                  Source commit: {current.build.sourceCommit}
                </p>
              </>
            ) : (
              <p>{current.build ? 'Non-release build' : 'Release identity unavailable'}</p>
            )}
            <p>Configuration version: {current.runtimeConfig.currentVersion}</p>
            <p>Changes pending restart: {current.runtimeConfig.pendingRestartCount}</p>
          </HealthSection>
        </>
      )}
    </section>
  );
}
