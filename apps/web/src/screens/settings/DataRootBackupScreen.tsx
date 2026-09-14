import {
  type DataRootBackupCreateResponse,
  DataRootBackupVerifyRequestSchema,
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
  Skeleton,
  TextField,
} from '../../primitives';

/** Allowlisted deployment backup metadata; inventory paths and extension payloads stay out of the cache. */
function backupSummary(response: DataRootBackupCreateResponse) {
  return {
    backupId: response.backupId,
    mode: response.manifest.backupMode,
    consistency: response.manifest.consistency,
    startedAt: response.manifest.backupStartedAt,
    completedAt: response.manifest.backupCompletedAt,
    fileCount: response.fileCount,
    totalBytes: response.totalBytes,
    checkedFiles: response.checkedFiles.length,
  };
}

/** Create and verify deployment backups using only session-derived server-admin authority. */
export function DataRootBackupScreen() {
  const client = useCoreClient();
  const [knownBackupId, setKnownBackupId] = useState('');
  const adminAccess = useQuery({
    queryKey: ['settings', 'data-root-backup', 'admin-access'],
    queryFn: async () => {
      await client.app.listOpenKitAccessTokens();
      return true;
    },
    retry: false,
  });
  const backup = useMutation({
    mutationFn: async (action: { kind: 'create' } | { kind: 'verify'; backupId: string }) => {
      const response =
        action.kind === 'create'
          ? await client.app.createDataRootBackup()
          : await client.app.verifyDataRootBackup(action.backupId);
      return { kind: action.kind, ...backupSummary(response) };
    },
    retry: false,
    onSuccess: (summary) => setKnownBackupId(summary.backupId),
  });
  const denied = [adminAccess.error, backup.error].some(
    (error) => error instanceof ApiCallError && (error.status === 401 || error.status === 403)
  );
  const backupId = knownBackupId.trim();
  const validId = DataRootBackupVerifyRequestSchema.safeParse({ backupId }).success;
  const summary = backup.data;

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Create and verify backups"
        subtitle="Create a deployment data-root backup or verify a known backup ID."
      />
      {adminAccess.isLoading ? (
        <Skeleton lines={6} />
      ) : denied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Deployment backup requires derived server-admin authority on the signed-in session."
          action={
            <Button
              variant="outline"
              onPress={() => {
                backup.reset();
                setKnownBackupId('');
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
          {backup.isError ? (
            <ErrorBanner
              message="Backup request failed. If creation was interrupted, its outcome may be unknown. Verify a known backup ID or explicitly create another backup."
              onRetry={() => backup.reset()}
            />
          ) : null}
          <Card className="flex flex-col gap-4">
            <Button
              isDisabled={backup.isPending || adminAccess.isFetching}
              onPress={() => backup.mutate({ kind: 'create' })}
            >
              Create backup
            </Button>
            <TextField
              label="Backup ID"
              description="Use the ID returned by creation or enter a known backup ID."
              value={knownBackupId}
              onChange={setKnownBackupId}
              isDisabled={backup.isPending}
            />
            <Button
              variant="outline"
              isDisabled={!validId || backup.isPending || adminAccess.isFetching}
              onPress={() => backup.mutate({ kind: 'verify', backupId })}
            >
              Verify backup
            </Button>
          </Card>
          {backup.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              {backup.variables.kind === 'create' ? 'Creating backup…' : 'Verifying backup…'}
            </p>
          ) : null}
          {summary ? (
            <Card className="flex flex-col gap-3">
              <h2 className="text-sm font-bold text-fg-strong">
                {summary.kind === 'create' ? 'Backup created' : 'Backup verified'}
              </h2>
              <dl className="grid grid-cols-2 gap-2 text-sm text-fg">
                <dt>Backup ID</dt>
                <dd>{summary.backupId}</dd>
                <dt>Mode</dt>
                <dd>{summary.mode}</dd>
                <dt>Consistency</dt>
                <dd>{summary.consistency}</dd>
                <dt>Started at</dt>
                <dd>{summary.startedAt}</dd>
                <dt>Completed at</dt>
                <dd>{summary.completedAt}</dd>
                <dt>File count</dt>
                <dd>{summary.fileCount}</dd>
                <dt>Total bytes</dt>
                <dd>{summary.totalBytes}</dd>
                <dt>Checked files</dt>
                <dd>{summary.checkedFiles}</dd>
              </dl>
            </Card>
          ) : null}
        </>
      )}
    </Page>
  );
}
