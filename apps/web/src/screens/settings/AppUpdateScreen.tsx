import type {
  AppUpdateSource,
  AppUpdateStatusResponse,
  PrepareAppUpdateResponse,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  RadioGroup,
  Skeleton,
  StatusChip,
  type StatusTone,
  Switch,
  TextField,
} from '../../primitives';

type SourceKind = 'release' | 'commit';

/** Deployment-admin App update: prepare a source, then start with maintenance consent. */
export function AppUpdateScreen() {
  const client = useCoreClient();
  const [kind, setKind] = useState<SourceKind>('release');
  const [tag, setTag] = useState('');
  const [sourceCommit, setSourceCommit] = useState('');
  const [appDigest, setAppDigest] = useState('');
  const [expectedCurrentImageId, setExpectedCurrentImageId] = useState('');
  const [knownRequestId, setKnownRequestId] = useState('');
  const [maintenanceConsent, setMaintenanceConsent] = useState(false);
  const [review, setReview] = useState<PrepareAppUpdateResponse | null>(null);
  const [status, setStatus] = useState<AppUpdateStatusResponse | null>(null);

  const adminAccess = useQuery({
    queryKey: ['settings', 'app-update', 'admin-access'],
    queryFn: () => client.app.listOpenKitAccessTokens(),
    retry: false,
  });
  const prepare = useMutation({
    mutationFn: () =>
      client.app.prepareAppUpdate({
        expectedCurrentImageId: expectedCurrentImageId.trim(),
        source:
          kind === 'release'
            ? {
                appDigest: appDigest.trim(),
                kind: 'release',
                sourceCommit: sourceCommit.trim(),
                tag: tag.trim(),
              }
            : { kind: 'commit', sourceCommit: sourceCommit.trim() },
      }),
    onSuccess: (prepared) => {
      setReview(prepared);
      setStatus(null);
      setKnownRequestId(prepared.requestId);
      setMaintenanceConsent(false);
    },
  });
  const start = useMutation({
    mutationFn: (requestId: string) =>
      client.app.startAppUpdate({ maintenanceConsent: true, requestId }),
    onSuccess: (started) => {
      setStatus(started);
      setKnownRequestId(started.requestId);
    },
  });
  const refresh = useMutation({
    mutationFn: (requestId: string) => client.app.getAppUpdateStatus(requestId),
    onSuccess: (current) => {
      setStatus(current);
      setKnownRequestId(current.requestId);
    },
  });

  const canPrepare =
    Boolean(expectedCurrentImageId.trim() && sourceCommit.trim()) &&
    (kind === 'commit' || Boolean(tag.trim() && appDigest.trim()));
  const requestId = knownRequestId.trim();
  const binding = reviewBinding(review, status, requestId);
  const error = prepare.error ?? start.error ?? refresh.error;
  const denied = isAccessDenied(adminAccess.error) || isAccessDenied(error);
  const unconfigured = isUnconfigured(error);
  const blocked = denied || unconfigured;

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="App update"
        subtitle="Prepare one App update, then start replacement after explicit maintenance consent. The host applies and restores the running App."
      />
      {adminAccess.isLoading ? (
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
                void adminAccess.refetch();
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
          <Card className="flex flex-col gap-4">
            <RadioGroup
              aria-label="Source"
              value={kind}
              onChange={(value) => setKind(value as SourceKind)}
              items={[
                { id: 'release', label: 'Published release' },
                { id: 'commit', label: 'Exact commit' },
              ]}
            />
            {kind === 'release' ? (
              <>
                <TextField label="Release tag" value={tag} onChange={setTag} />
                <TextField label="Published App digest" value={appDigest} onChange={setAppDigest} />
              </>
            ) : null}
            <TextField label="Source commit" value={sourceCommit} onChange={setSourceCommit} />
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
              <Switch isSelected={maintenanceConsent} onChange={setMaintenanceConsent}>
                I consent to the maintenance interruption for this prepared source
              </Switch>
              <Button
                isDisabled={!maintenanceConsent || start.isPending || !requestId}
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
} | null {
  if (review && review.requestId === requestId) {
    return {
      expectedCurrentImageId: review.expectedCurrentImageId,
      requestId: review.requestId,
      source: review.source,
    };
  }
  if (status && status.requestId === requestId) {
    return {
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
      {source.kind === 'release' ? <p>Tag {source.tag}</p> : null}
      <p>Commit {source.sourceCommit}</p>
      {source.kind === 'release' ? <p>App digest {source.appDigest}</p> : null}
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
