import type {
  AppUpdateApprovalSummary,
  AppUpdateSource,
  AppUpdateStatusResponse,
  PrepareAppUpdateResponse,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
  type StatusTone,
  Switch,
  TextField,
} from '../../primitives';

/** Deployment-admin App update: prepare a source, then start with maintenance consent. */
export function AppUpdateScreen() {
  const client = useCoreClient();
  const [tag, setTag] = useState('');
  const [sourceCommit, setSourceCommit] = useState('');
  const [appDigest, setAppDigest] = useState('');
  const [expectedCurrentImageId, setExpectedCurrentImageId] = useState('');
  const [knownRequestId, setKnownRequestId] = useState('');
  const [maintenanceConsent, setMaintenanceConsent] = useState(false);
  const [review, setReview] = useState<PrepareAppUpdateResponse | null>(null);
  const [status, setStatus] = useState<AppUpdateStatusResponse | null>(null);
  const [diagnosticsDenied, setDiagnosticsDenied] = useState(false);

  const adminAccess = useQuery({
    queryKey: ['settings', 'app-update', 'admin-access'],
    queryFn: async ({ signal }) => {
      try {
        await client.operations['token.list']({});
        // Cached metadata and abandoned transports cannot admit a different mount.
        signal.throwIfAborted();
        return true;
      } catch (error) {
        signal.throwIfAborted();
        throw safeUpdateError(error);
      }
    },
    retry: false,
    refetchOnMount: 'always',
  });
  const admitted =
    adminAccess.isFetchedAfterMount && adminAccess.isSuccess && adminAccess.fetchStatus === 'idle';
  const diagnostics = useQuery({
    queryKey: ['settings', 'app-update', 'diagnostics'],
    queryFn: async ({ signal }) => {
      try {
        const response = await client.operations['diagnostics.app']({});
        signal.throwIfAborted();
        return response;
      } catch (error) {
        signal.throwIfAborted();
        throw safeUpdateError(error);
      }
    },
    enabled: admitted,
    retry: false,
    // This query first enables after admission, which must also refresh a fresh cache.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  useEffect(() => {
    // A transient error clear or a later 500 cannot revoke prior denial evidence.
    if (isAccessDenied(diagnostics.error)) {
      setDiagnosticsDenied(true);
    } else if (
      diagnostics.isFetchedAfterMount &&
      diagnostics.isSuccess &&
      diagnostics.fetchStatus === 'idle'
    ) {
      setDiagnosticsDenied(false);
    }
  }, [
    diagnostics.error,
    diagnostics.isFetchedAfterMount,
    diagnostics.isSuccess,
    diagnostics.fetchStatus,
  ]);
  const prepare = useMutation({
    mutationFn: async () => {
      try {
        return await client.operations['app-update.prepare']({
          expectedCurrentImageId: expectedCurrentImageId.trim(),
          source: {
            appDigest: appDigest.trim(),
            sourceCommit: sourceCommit.trim(),
            tag: tag.trim(),
          },
        });
      } catch (error) {
        throw safeUpdateError(error);
      }
    },
    onSuccess: (prepared) => {
      setReview(prepared);
      setStatus(null);
      setKnownRequestId(prepared.requestId);
      setMaintenanceConsent(false);
    },
  });
  const start = useMutation({
    mutationFn: async (requestId: string) => {
      try {
        return await client.operations['app-update.start']({ maintenanceConsent: true, requestId });
      } catch (error) {
        throw safeUpdateError(error);
      }
    },
    onSuccess: (started) => {
      setStatus(started);
      setKnownRequestId(started.requestId);
    },
  });
  const refresh = useMutation({
    mutationFn: async (requestId: string) => {
      try {
        return await client.operations['app-update.status']({ requestId });
      } catch (error) {
        throw safeUpdateError(error);
      }
    },
    onSuccess: (current) => {
      setStatus(current);
      setKnownRequestId(current.requestId);
    },
  });

  const canPrepare = Boolean(
    expectedCurrentImageId.trim() && sourceCommit.trim() && tag.trim() && appDigest.trim()
  );
  const requestId = knownRequestId.trim();
  const binding = reviewBinding(review, status, requestId);
  const error = prepare.error ?? start.error ?? refresh.error;
  const denied =
    diagnosticsDenied ||
    [adminAccess.error, diagnostics.error, prepare.error, start.error, refresh.error].some(
      isAccessDenied
    );
  const unconfigured = isUnconfigured(error);
  const blocked = denied || unconfigured;

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="App update"
        subtitle="Prepare one App update, then start replacement after explicit maintenance consent. The host applies the update and reports whether restoration was possible."
      />
      {!adminAccess.isFetchedAfterMount || adminAccess.isPending || adminAccess.fetchStatus !== 'idle' ? (
        <Skeleton lines={6} />
      ) : blocked ? (
        <EmptyState
          icon="key"
          title={denied ? 'Access denied' : 'App update unavailable'}
          hint={
            denied
              ? 'App update requires derived server-admin authority on the signed-in session.'
              : 'App update is disabled because deployment configuration is absent.'
          }
          action={
            <Button
              variant="outline"
              onPress={() => {
                prepare.reset();
                start.reset();
                refresh.reset();
                setMaintenanceConsent(false);
                void adminAccess.refetch().then((current) => {
                  if (current.isSuccess) {
                    void diagnostics.refetch({ cancelRefetch: false });
                  }
                });
              }}
            >
              Retry
            </Button>
          }
        />
      ) : adminAccess.isError ? (
        <ErrorBanner
          message="Couldn't verify deployment-admin authority."
          onRetry={() => void adminAccess.refetch()}
        />
      ) : (
        <>
          {error ? <ErrorBanner message={errorMessage(error)} /> : null}
          <Card className="flex flex-col gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Operational diagnostics</h2>
            {!diagnostics.isFetchedAfterMount || diagnostics.fetchStatus !== 'idle' ? (
              <Skeleton lines={4} />
            ) : diagnostics.isError ? (
              <ErrorBanner
                message="Operational diagnostics unavailable."
                onRetry={() => void diagnostics.refetch()}
              />
            ) : (
              <div className="text-xs text-fg-muted">
                <p>
                  Service availability:{' '}
                  {diagnostics.data?.readiness?.serviceAvailability ?? 'unknown'}
                </p>
                <p>
                  Product-work readiness: {diagnostics.data?.readiness?.productWork ?? 'unknown'}
                </p>
                <p>
                  Update readiness: {diagnostics.data?.readiness?.update.state ?? 'unknown'} —
                  prepare required
                </p>
                <p>
                  Maintenance safety:{' '}
                  {diagnostics.data?.readiness?.maintenanceSafety.state ?? 'unknown'}
                </p>
                <p>
                  Execution-host readiness:{' '}
                  {diagnostics.data?.readiness?.executionHost.state ?? 'unknown'}; observation age{' '}
                  {diagnostics.data?.readiness?.executionHost.observationAgeMs ?? 'unknown'} ms; not
                  a live probe
                </p>
                <p>freshEmpty does not establish deployment-wide idleness.</p>
              </div>
            )}
          </Card>
          <Card className="flex flex-col gap-4">
            <TextField label="Release tag" value={tag} onChange={setTag} />
            <TextField label="Published App digest" value={appDigest} onChange={setAppDigest} />
            <TextField
              label="Release source commit"
              value={sourceCommit}
              onChange={setSourceCommit}
            />
            <TextField
              label="Expected current image"
              value={expectedCurrentImageId}
              onChange={setExpectedCurrentImageId}
            />
            <Button
              isDisabled={!canPrepare || prepare.isPending}
              onPress={() => {
                prepare.mutate();
              }}
            >
              Prepare
            </Button>
          </Card>
          <Card className="flex flex-col gap-3">
            <TextField
              label="Request ID"
              value={knownRequestId}
              onChange={(value) => {
                setKnownRequestId(value);
                setMaintenanceConsent(false);
                if (review && review.requestId !== value.trim()) {
                  setReview(null);
                }
              }}
            />
            <Button
              variant="outline"
              isDisabled={!requestId || refresh.isPending}
              onPress={() => {
                refresh.mutate(requestId);
              }}
            >
              Refresh status
            </Button>
          </Card>
          {binding ? (
            <Card className="flex flex-col gap-3">
              <p className="text-sm text-fg">
                Prepared receipt{' '}
                <span className="font-bold text-fg-strong">{binding.requestId}</span>
              </p>
              <ReviewLines
                expectedCurrentImageId={binding.expectedCurrentImageId}
                source={binding.source}
              />
              {binding.approvalSummary ? (
                <div className="flex flex-col gap-1 text-xs text-fg-muted">
                  <p>{binding.approvalSummary.interruptionScope}</p>
                  <p>Observed current image {binding.approvalSummary.observedCurrentImageId}</p>
                  <p>
                    Maintenance safety: {binding.approvalSummary.safetyEvidence.preflight.state}
                  </p>
                  <p>Observed at {binding.approvalSummary.safetyEvidence.preflight.observedAt}</p>
                  <p>
                    Deployment bindings checked:{' '}
                    {String(binding.approvalSummary.safetyEvidence.deploymentBindings)}
                  </p>
                  {Object.entries(binding.approvalSummary.safetyEvidence.preflight.counts).map(
                    ([key, count]) => (
                      <p key={key}>
                        {key}: {count}
                      </p>
                    )
                  )}
                  {binding.approvalSummary.recoveryLimitations.map((limitation) => (
                    <p key={limitation}>{limitation}</p>
                  ))}
                  <p>Helper SHA-256 {binding.helperSha256 ?? 'unknown'}</p>
                </div>
              ) : (
                <p className="text-xs text-fg-muted">
                  Approval summary unavailable; prepare a new update.
                </p>
              )}
              <Switch isSelected={maintenanceConsent} onChange={setMaintenanceConsent}>
                I consent to the maintenance interruption for this prepared source
              </Switch>
              <Button
                isDisabled={
                  !binding.approvalSummary || !maintenanceConsent || start.isPending || !requestId
                }
                onPress={() => {
                  start.mutate(requestId);
                }}
              >
                Start update
              </Button>
            </Card>
          ) : null}
          {status ? <StatusCard status={status} /> : null}
        </>
      )}
    </Page>
  );
}

function reviewBinding(
  review: PrepareAppUpdateResponse | null,
  status: AppUpdateStatusResponse | null,
  requestId: string
): {
  expectedCurrentImageId: string;
  requestId: string;
  source: AppUpdateSource;
  approvalSummary: AppUpdateApprovalSummary | null;
  helperSha256: string | null;
} | null {
  if (review && review.requestId === requestId) {
    return {
      approvalSummary: review.approvalSummary,
      helperSha256: review.helperSha256,
      expectedCurrentImageId: review.expectedCurrentImageId,
      requestId: review.requestId,
      source: review.source,
    };
  }
  if (status && status.requestId === requestId) {
    return {
      approvalSummary: status.approvalSummary ?? null,
      helperSha256: status.helperSha256 ?? null,
      expectedCurrentImageId: status.expectedCurrentImageId,
      requestId: status.requestId,
      source: status.source,
    };
  }
  return null;
}

function ReviewLines({
  expectedCurrentImageId,
  source,
}: {
  expectedCurrentImageId: string;
  source: AppUpdateSource;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      <p>Tag {source.tag}</p>
      <p>Commit {source.sourceCommit}</p>
      <p>App digest {source.appDigest}</p>
      <p>Current image {expectedCurrentImageId}</p>
    </div>
  );
}

function StatusCard({ status }: { status: AppUpdateStatusResponse }) {
  const bootId = status.candidateBoot?.bootId ?? null;
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <StatusChip tone={statusTone(status.stage)}>{status.stage}</StatusChip>
        <span className="text-sm text-fg-muted">{status.outcome}</span>
      </div>
      {status.jobId ? <p className="text-xs text-fg-muted">Job {status.jobId}</p> : null}
      {bootId ? <p className="text-xs text-fg-muted">Boot {bootId}</p> : null}
      {status.predicates ? (
        <ul className="flex flex-col gap-1 text-xs text-fg-muted">
          {PREDICATE_CHECKS.map(({ key, label }) => (
            <li key={key}>
              {label}: {formatPredicate(status.predicates?.[key] ?? null)}
            </li>
          ))}
        </ul>
      ) : null}
      {status.error ? <p className="text-sm text-fg">{status.error}</p> : null}
    </Card>
  );
}

const PREDICATE_CHECKS = [
  { key: 'imageMatch', label: 'Image match' },
  { key: 'sourceMatch', label: 'Source match' },
  { key: 'acceptingProductWork', label: 'Accepting product work' },
  { key: 'noBlockingReadiness', label: 'No blocking readiness' },
  { key: 'newBoot', label: 'New boot' },
  { key: 'retainedAuthRead', label: 'Retained auth read' },
  { key: 'nanohostReady', label: 'NanoHost ready' },
  { key: 'helperReachable', label: 'Helper reachable' },
  { key: 'webAssets', label: 'Web assets' },
] as const;

function formatPredicate(value: boolean | null): string {
  if (value === null) {
    return 'Not applicable';
  }
  return value ? 'Yes' : 'No';
}

function statusTone(stage: AppUpdateStatusResponse['stage']): StatusTone {
  if (stage === 'succeeded') {
    return 'positive';
  }
  if (stage === 'failed' || stage === 'recovery_required' || stage === 'unknown') {
    return 'negative';
  }
  if (stage === 'launching' || stage === 'applying' || stage === 'verifying') {
    return 'informative';
  }
  return 'neutral';
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}

function isUnconfigured(error: unknown): boolean {
  return error instanceof ApiCallError && error.code === 'app_update_unconfigured';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'App update request failed.';
}

/** Admit only safe copy and the denial or configuration discriminator to error caches. */
function safeUpdateError(error: unknown): Error {
  if (isAccessDenied(error) && error instanceof ApiCallError) {
    return new ApiCallError(error.status, 'Administrator access required.');
  }
  if (isUnconfigured(error) && error instanceof ApiCallError) {
    return new ApiCallError(error.status, 'App update configuration is absent.', {
      code: 'app_update_unconfigured',
    });
  }
  return new Error(
    'App update request failed. If start was interrupted, its outcome may be unknown. Refresh the known request ID before another start.'
  );
}
