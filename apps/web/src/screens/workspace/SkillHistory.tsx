import { ApiCallError, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import { Button, ErrorBanner } from '../../primitives';
import { workspaceKeys } from './data';

/** Exact retained Skill history in the selected Workspace; reads do not change selection. */
export function SkillHistory({
  workspaceId,
  skillId,
  revision,
  blocked,
}: {
  workspaceId: string;
  skillId: string;
  revision: number;
  blocked: boolean;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const [digest, setDigest] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ['skill-history', workspaceId, skillId],
    queryFn: () => client.operations['catalog.skill-version-list']({ workspaceId, skillId }),
    retry: false,
  });
  const remove = useMutation({
    mutationFn: () =>
      client.operations['catalog.skill-remove']({
        workspaceId,
        skillId,
        expectedRevision: revision,
        requestId: createRequestId(),
      }),
    retry: false,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.catalog(workspaceId), exact: true }),
  });
  const versions = history.isSuccess ? history.data.items : [];
  return (
    <div className="flex flex-col gap-2">
      {history.isPending ? (
        <p className="text-xs text-fg-muted">Loading retained versions…</p>
      ) : null}
      {history.isError ? (
        <ErrorBanner
          message="Couldn't read Skill history."
          onRetry={blocked ? undefined : () => void history.refetch()}
        />
      ) : null}
      {history.isSuccess && versions.length === 0 ? <p>No retained versions.</p> : null}
      {versions.map((version) => (
        <Button
          key={version.digest}
          size="sm"
          isDisabled={blocked}
          onPress={() => setDigest(version.digest)}
        >
          Inspect {version.digest.slice(0, 19)}
        </Button>
      ))}
      {digest && history.isSuccess ? (
        <SkillVersionDetails
          key={`${workspaceId}:${skillId}:${digest}`}
          workspaceId={workspaceId}
          skillId={skillId}
          digest={digest}
          revision={revision}
          blocked={blocked}
          otherDigests={versions
            .map((version) => version.digest)
            .filter((other) => other !== digest)}
        />
      ) : null}
      <p className="text-xs text-fg-muted">Removal blocks future selection and retains history.</p>
      <Button
        size="sm"
        isDisabled={
          blocked || history.isError || remove.isPending || remove.isSuccess || remove.isError
        }
        onPress={() => remove.mutate()}
      >
        Remove Skill from future selection
      </Button>
      {remove.isSuccess ? <p role="status">Skill removed from future selection.</p> : null}
      {remove.isError ? (
        <>
          <ErrorBanner message={mutationFailure(remove.error, 'removal')} />
          <Button
            size="sm"
            isDisabled={blocked || history.isFetching}
            onPress={() => {
              void history.refetch();
              void queryClient.invalidateQueries({
                queryKey: workspaceKeys.catalog(workspaceId),
                exact: true,
              });
            }}
          >
            Inspect current Skill state
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Reads one exact version and binds all inspection and deletion commands to that immutable digest. */
function SkillVersionDetails({
  workspaceId,
  skillId,
  digest,
  revision,
  blocked,
  otherDigests,
}: {
  workspaceId: string;
  skillId: string;
  digest: string;
  revision: number;
  blocked: boolean;
  otherDigests: readonly string[];
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string | null>(null);
  const [comparison, setComparison] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const version = useQuery({
    queryKey: ['skill-version', workspaceId, skillId, digest],
    queryFn: () =>
      client.operations['catalog.skill-version-read']({ workspaceId, skillId, digest }),
    retry: false,
  });
  const content = useQuery({
    queryKey: ['skill-content', workspaceId, skillId, digest, path],
    queryFn: () =>
      client.operations['catalog.skill-content-read']({
        workspaceId,
        skillId,
        digest,
        path: path as string,
      }),
    enabled: path !== null,
    retry: false,
  });
  const diff = useQuery({
    queryKey: ['skill-diff', workspaceId, skillId, digest, comparison],
    queryFn: () =>
      client.operations['catalog.skill-diff']({
        workspaceId,
        skillId,
        baseDigest: digest,
        candidateDigest: comparison as string,
      }),
    enabled: comparison !== null,
    retry: false,
  });
  const check = useMutation({
    mutationFn: () =>
      client.operations['catalog.skill-update-check']({ workspaceId, skillId, digest }),
    retry: false,
  });
  const purge = useMutation({
    mutationFn: () =>
      client.operations['catalog.skill-purge']({
        workspaceId,
        skillId,
        digest,
        expectedRevision: revision,
        requestId: createRequestId(),
      }),
    retry: false,
    onSuccess: async () => {
      setPath(null);
      setComparison(null);
      setConfirmPurge(false);
      // Remove cached payloads so a successful purge does not leave readable bytes in this view.
      queryClient.removeQueries({ queryKey: ['skill-content', workspaceId, skillId, digest] });
      queryClient.removeQueries({ queryKey: ['skill-diff', workspaceId, skillId] });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.catalog(workspaceId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: ['skill-history', workspaceId, skillId],
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: ['skill-version', workspaceId, skillId, digest],
          exact: true,
        }),
      ]);
    },
  });
  const retained = version.isSuccess ? version.data.version : undefined;
  const unavailable = retained?.contentState !== 'retained' || purge.isSuccess || purge.isError;
  return (
    <div className="flex flex-col gap-2 rounded-ok border border-border p-3">
      <p className="text-xs break-all">Retained version {digest}</p>
      {version.isPending ? <p>Loading version…</p> : null}
      {version.isError ? (
        <ErrorBanner
          message="Couldn't read that Skill version."
          onRetry={blocked ? undefined : () => void version.refetch()}
        />
      ) : null}
      {retained ? (
        <>
          <p>{retained.provenance.sourceLocator ?? 'Uploaded Skill'}</p>
          <p className="text-xs break-all">
            Commit: {retained.provenance.sourceCommit ?? 'Not applicable'} · Path:{' '}
            {retained.provenance.sourceSubpath ?? '.'}
          </p>
          <p className="text-xs">Content: {purge.isSuccess ? 'purged' : retained.contentState}</p>
          {retained.inventory.map((file) => (
            <div key={file.path} className="flex flex-wrap gap-2">
              <span className="text-xs">
                {file.path} ·{' '}
                {file.kind === 'directory'
                  ? 'Directory'
                  : `${file.size} bytes${file.executable ? ' · executable' : ''}`}
              </span>
              {file.kind === 'file' ? (
                <Button
                  size="sm"
                  isDisabled={blocked || unavailable || content.isFetching}
                  onPress={() => setPath(file.path)}
                >
                  Read {file.path}
                </Button>
              ) : null}
            </div>
          ))}
          {content.isFetching ? <p>Loading file…</p> : null}
          {content.isError ? (
            <ErrorBanner
              message="Couldn't read that Skill file."
              onRetry={blocked ? undefined : () => void content.refetch()}
            />
          ) : null}
          {content.isSuccess && !unavailable ? (
            <div>
              <p className="text-xs">UTF-8 preview: {content.data.path}</p>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {preview(content.data.contentBase64)}
              </pre>
              <a
                className="text-accent-content underline"
                download={content.data.path.split('/').at(-1)}
                href={`data:application/octet-stream;base64,${content.data.contentBase64}`}
              >
                Download exact file bytes
              </a>
            </div>
          ) : null}
          <Button
            size="sm"
            isDisabled={blocked || check.isPending || unavailable}
            onPress={() => check.mutate()}
          >
            Check source for updates
          </Button>
          {check.data ? <p role="status">Source check: {check.data.status}</p> : null}
          {check.isError ? (
            <ErrorBanner message="Couldn't check that Skill source. Retry the source check." />
          ) : null}
          {otherDigests.map((other) => (
            <Button
              key={other}
              size="sm"
              isDisabled={blocked || unavailable || diff.isFetching}
              onPress={() => setComparison(other)}
            >
              Compare with {other.slice(0, 19)}
            </Button>
          ))}
          {diff.isFetching ? <p>Comparing versions…</p> : null}
          {diff.isError ? (
            <ErrorBanner
              message="Couldn't compare those versions."
              onRetry={blocked ? undefined : () => void diff.refetch()}
            />
          ) : null}
          {diff.isSuccess && diff.data.changes.length === 0 ? <p>No file differences.</p> : null}
          {diff.isSuccess
            ? diff.data.changes.map((change) => (
                <div key={change.path} className="text-xs break-all">
                  <p>
                    {change.before === null
                      ? 'Added'
                      : change.after === null
                        ? 'Removed'
                        : 'Changed'}
                    : {change.path}
                  </p>
                  {change.before ? (
                    <p>
                      Before:{' '}
                      {change.before.kind === 'directory'
                        ? 'Directory'
                        : `${change.before.size} bytes · ${change.before.sha256}`}
                    </p>
                  ) : null}
                  {change.after ? (
                    <p>
                      After:{' '}
                      {change.after.kind === 'directory'
                        ? 'Directory'
                        : `${change.after.size} bytes · ${change.after.sha256}`}
                    </p>
                  ) : null}
                </div>
              ))
            : null}
          <p className="text-xs text-fg-muted">
            Permanent deletion removes this version's bytes. Core refuses deletion while retained
            work or catalog references still need them.
          </p>
          <Button
            size="sm"
            isDisabled={blocked || unavailable || purge.isPending}
            onPress={() => setConfirmPurge(true)}
          >
            Delete retained version bytes
          </Button>
          {confirmPurge ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs break-all">
                Permanently delete {skillId} at {digest}?
              </p>
              <Button
                size="sm"
                isDisabled={blocked || purge.isPending || unavailable}
                onPress={() => purge.mutate()}
              >
                Confirm permanent deletion
              </Button>
              <Button size="sm" isDisabled={purge.isPending} onPress={() => setConfirmPurge(false)}>
                Cancel deletion
              </Button>
            </div>
          ) : null}
          {purge.isSuccess ? <p role="status">Version bytes permanently deleted.</p> : null}
          {purge.isError ? (
            <>
              <ErrorBanner message={mutationFailure(purge.error, 'deletion')} />
              <Button
                size="sm"
                isDisabled={blocked || version.isFetching}
                onPress={() => {
                  void version.refetch();
                  void queryClient.invalidateQueries({
                    queryKey: ['skill-history', workspaceId, skillId],
                    exact: true,
                  });
                  void queryClient.invalidateQueries({
                    queryKey: workspaceKeys.catalog(workspaceId),
                    exact: true,
                  });
                }}
              >
                Inspect current Skill state
              </Button>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Binary files keep an exact download; malformed byte encoding cannot break the Catalog render. */
function preview(contentBase64: string): string {
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0))
    );
  } catch {
    return 'Preview unavailable. Use the exact file download.';
  }
}

/** A refused command is definite; a lost or invalid response requires inspection before another effect. */
function mutationFailure(error: unknown, action: 'removal' | 'deletion'): string {
  return error instanceof ApiCallError && error.status < 500
    ? `Core refused Skill ${action}. Inspect current state before another change.`
    : `The Skill ${action} result is unknown. Inspect current state before requesting another change.`;
}
