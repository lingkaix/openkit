import type { EvaluationCandidate } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useEffect, useState } from 'react';
import {
  Link as AriaLink,
  TextField as AriaTextField,
  FileTrigger,
  Label,
  TextArea,
} from 'react-aria-components';
import { useCoreClient } from '../../app/core-client';
import { Button, ErrorBanner, Select, Skeleton, StatusChip, TextField } from '../../primitives';
import { ArtifactJudgements } from './ArtifactJudgements';
import {
  type ArtifactVersionCommitInput,
  artifactVersionCommitErrorMessage,
  createRequestId,
  isArtifactImportMediaType,
  isRetryableArtifactVersionCommit,
  isWorkspaceAccessDenied,
  useArtifact,
  useArtifactVersion,
  useArtifactVersions,
  useCommitArtifactVersion,
  useThreads,
} from './data';
import { ZipFolderPanel } from './ZipFolderPanel';

type ArtifactRecord = Awaited<ReturnType<CoreClient['operations']['artifact.read']>>;
type VersionRow = NonNullable<ReturnType<typeof useArtifactVersions>['data']>[number];

/** Open preview for the selected version. Head bytes render before version history settles. */
function OpenedArtifact(props: {
  artifact: ArtifactRecord;
  metadata: VersionRow | undefined;
  disabled: boolean;
}) {
  const client = useCoreClient();
  const artifact = props.artifact;
  const metadata = props.metadata;
  const file = artifact.content.format === 'file' ? artifact.content : null;
  const downloadUrl = client.artifactFiles.browserDownloadUrl({
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
  });
  const zip = Boolean(
    file && (file.mediaType === 'application/zip' || artifact.title.toLowerCase().endsWith('.zip'))
  );
  return (
    <>
      <h3 className="text-base font-bold text-fg-strong">{artifact.title}</h3>
      {metadata ? (
        <dl className="text-sm text-fg-muted">
          <dt>Parent version</dt>
          <dd>
            {metadata.parentVersion === null ? 'No parent' : `Version ${metadata.parentVersion}`}
          </dd>
          <dt>Actor</dt>
          <dd>
            {metadata.actor.kind}: <span className="break-all">{metadata.actor.id}</span>
          </dd>
          {'responsibleUserId' in metadata.actor && metadata.actor.responsibleUserId ? (
            <>
              <dt>Responsible user</dt>
              <dd className="break-all">{metadata.actor.responsibleUserId}</dd>
            </>
          ) : null}
          <dt>Producing conversation</dt>
          <dd className="break-all">{metadata.threadId ?? 'No producing conversation'}</dd>
          <dt>Producing Turn</dt>
          <dd className="break-all">{metadata.turnId ?? 'No producing Turn'}</dd>
          <dt>Recorded at</dt>
          <dd>
            <time dateTime={metadata.recordedAt}>{metadata.recordedAt}</time>
          </dd>
          {file ? (
            <>
              <dt>Size</dt>
              <dd>{file.byteLength.toLocaleString()} bytes</dd>
              <dt>Source</dt>
              <dd>{artifact.origin.kind === 'imported' ? 'Imported file' : 'Worker output'}</dd>
            </>
          ) : null}
        </dl>
      ) : file ? (
        <p className="text-sm text-fg">{file.byteLength.toLocaleString()} bytes</p>
      ) : null}
      {file?.mediaType.startsWith('image/') ? (
        <img alt={artifact.title} className="max-w-full" src={downloadUrl} />
      ) : null}
      {artifact.content.format !== 'file' ? (
        <pre className="whitespace-pre-wrap text-sm text-fg">{artifact.content.body}</pre>
      ) : null}
      {zip && file ? (
        <ZipFolderPanel
          key={`${artifact.workspaceId}:${artifact.id}:${artifact.version}:${artifact.contentDigest}`}
          source={{
            workspaceId: artifact.workspaceId,
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            originalDigest: artifact.contentDigest,
          }}
          disabled={props.disabled}
        />
      ) : null}
      <ArtifactDetails
        key={`${artifact.id}:${artifact.version}`}
        mediaType={file ? file.mediaType : null}
        digest={metadata?.contentDigest ?? artifact.contentDigest}
        artifactId={artifact.id}
      />
      <AriaLink className="text-accent underline" href={downloadUrl}>
        Download original
      </AriaLink>
    </>
  );
}

/**
 * Media type, digest, and raw id. A button, because jsdom exposes text inside a closed details element.
 */
function ArtifactDetails(props: { mediaType: string | null; digest: string; artifactId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        className="min-h-11"
        variant="quiet"
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
      >
        Details
      </Button>
      {open ? (
        <div className="mt-2 flex flex-col gap-1 text-sm text-fg">
          {props.mediaType ? <p>{props.mediaType}</p> : null}
          <p className="break-all">{props.digest}</p>
          <p className="break-all">{props.artifactId}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Exact retained-version inspection within one selected Artifact. Remount when Workspace or Artifact identity changes. */
export function ArtifactVersionHistory(props: {
  currentArtifact: Awaited<ReturnType<CoreClient['operations']['artifact.read']>>;
  disabled: boolean;
  unavailable?: boolean;
  onVersionChange: (version: number, readable: boolean) => void;
  onAddCandidate?: (candidate: EvaluationCandidate) => void;
  comparisonDisabled?: boolean;
}) {
  const current = props.currentArtifact;
  const [selectedVersion, setSelectedVersion] = useState(current.version);
  const [creating, setCreating] = useState(false);
  const [createdVersion, setCreatedVersion] = useState<number | null>(null);
  const history = useArtifactVersions(current.workspaceId, current.id, current.version);
  const exact = useArtifactVersion(
    current.workspaceId,
    current.id,
    selectedVersion,
    history.isSuccess && selectedVersion !== current.version
  );
  const metadata = history.isSuccess
    ? history.data.find((version) => version.artifactVersion === selectedVersion)
    : undefined;
  const retainedMetadata = history.data?.find(
    (version) => version.artifactVersion === selectedVersion
  );
  const headSelected = selectedVersion === current.version;
  const historicalArtifact =
    !headSelected && exact.isSuccess && !exact.isFetching ? exact.data.artifact : null;
  const digestAgrees = !metadata || current.contentDigest === metadata.contentDigest;
  const canPreviewHead =
    headSelected &&
    !props.unavailable &&
    !history.isError &&
    digestAgrees &&
    (!history.isSuccess || history.data.length === 0 || Boolean(metadata));
  const canPreviewHistorical = Boolean(
    historicalArtifact && metadata && historicalArtifact.contentDigest === metadata.contentDigest
  );
  const preview = canPreviewHead ? current : canPreviewHistorical ? historicalArtifact : null;
  const readable = Boolean(
    !props.unavailable && history.isSuccess && !history.isFetching && preview
  );
  const onVersionChange = props.onVersionChange;
  useEffect(() => {
    onVersionChange(selectedVersion, readable);
  }, [selectedVersion, readable, onVersionChange]);

  return (
    <section className="flex flex-col gap-3" aria-label="Artifact version history">
      {props.unavailable ? (
        <Skeleton lines={4} />
      ) : history.isError ? (
        <ErrorBanner
          message={
            isWorkspaceAccessDenied(history.error)
              ? 'Access denied.'
              : "Couldn't load version history."
          }
          onRetry={() => void history.refetch()}
        />
      ) : (
        <>
          {history.isSuccess ? (
            <>
              <h2 className="text-sm font-bold text-fg">Version history</h2>
              <p className="text-xs text-fg-muted">Current head: version {current.version}</p>
              <ol className="flex flex-wrap gap-2" aria-label="Artifact versions">
                {history.data.map((version) => (
                  <li key={version.artifactVersion}>
                    <Button
                      size="sm"
                      variant={selectedVersion === version.artifactVersion ? 'accent' : 'outline'}
                      aria-pressed={selectedVersion === version.artifactVersion}
                      onPress={() => {
                        setSelectedVersion(version.artifactVersion);
                        props.onVersionChange(version.artifactVersion, false);
                      }}
                    >
                      View version {version.artifactVersion}
                    </Button>
                  </li>
                ))}
              </ol>
              <p className="text-sm text-fg">Viewing version {selectedVersion}</p>
              {headSelected ? (
                <StatusChip tone="neutral">Current head</StatusChip>
              ) : (
                <StatusChip tone="notice">Historical version</StatusChip>
              )}
            </>
          ) : (
            <Skeleton lines={2} />
          )}
          {history.isSuccess && !metadata && !(headSelected && history.data.length === 0) ? (
            <ErrorBanner
              message="That version isn't available."
              onRetry={() => void history.refetch()}
            />
          ) : history.isSuccess && !headSelected && exact.isError ? (
            <ErrorBanner
              message={
                isWorkspaceAccessDenied(exact.error)
                  ? 'Access denied.'
                  : "Couldn't load that version."
              }
              onRetry={() => void exact.refetch()}
            />
          ) : history.isSuccess && !headSelected && !exact.isSuccess ? (
            <Skeleton lines={4} />
          ) : history.isSuccess && !preview ? (
            <ErrorBanner
              message="That version no longer matches the inventory. Refresh the artifact."
              onRetry={() => void history.refetch()}
            />
          ) : preview ? (
            <OpenedArtifact
              key="opened-artifact"
              artifact={preview}
              metadata={metadata}
              disabled={props.disabled}
            />
          ) : null}
        </>
      )}
      {retainedMetadata ? (
        <ArtifactJudgements
          key={`${current.workspaceId}:${current.id}:${selectedVersion}`}
          workspaceId={current.workspaceId}
          artifactId={current.id}
          artifactVersion={selectedVersion}
          contentDigest={retainedMetadata.contentDigest}
          disabled={props.disabled || !readable}
          unavailable={!readable}
        />
      ) : null}
      {createdVersion ? (
        <p className="text-sm text-fg" role="status">
          Version {createdVersion} saved. Select it to inspect the new version.
        </p>
      ) : null}
      {readable && preview && props.onAddCandidate ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled || props.comparisonDisabled}
          onPress={() =>
            props.onAddCandidate?.({
              artifactId: preview.id,
              artifactVersion: preview.version,
              contentDigest: preview.contentDigest,
            })
          }
        >
          Add exact version to comparison
        </Button>
      ) : null}
      {creating ? (
        <div hidden={history.isError || props.unavailable}>
          <ArtifactVersionCreate
            currentArtifact={current}
            disabled={props.disabled || !readable || selectedVersion !== current.version}
            onCancel={() => setCreating(false)}
            onCommitted={(version) => {
              setCreating(false);
              setCreatedVersion(version);
            }}
          />
        </div>
      ) : readable && selectedVersion === current.version ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled}
          onPress={() => setCreating(true)}
        >
          Create next version
        </Button>
      ) : null}
    </section>
  );
}

/** Explicit next-version draft. The chosen parent and frozen failed command never follow a head refresh automatically. */
function ArtifactVersionCreate(props: {
  currentArtifact: Awaited<ReturnType<CoreClient['operations']['artifact.read']>>;
  disabled: boolean;
  onCancel: () => void;
  onCommitted: (version: number) => void;
}) {
  const current = props.currentArtifact;
  const head = useArtifact(current.workspaceId, current.id);
  const threads = useThreads(current.workspaceId);
  const commit = useCommitArtifactVersion();
  const [parentVersion, setParentVersion] = useState(current.version);
  const [title, setTitle] = useState(current.title);
  const [summary, setSummary] = useState(current.summary ?? '');
  const [body, setBody] = useState(current.content.format === 'file' ? '' : current.content.body);
  const [format, setFormat] = useState<'markdown' | 'text' | 'json'>(
    current.content.format === 'file' ? 'text' : current.content.format
  );
  const [file, setFile] = useState<File | null>(null);
  const [threadId, setThreadId] = useState(current.threadId ?? '');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshedAfterFailure, setRefreshedAfterFailure] = useState(false);
  const availableThreads = threads.isSuccess
    ? threads.data.filter(
        (thread) =>
          thread.status === 'active' &&
          (current.origin.kind === 'turn-output'
            ? thread.id === current.threadId
            : thread.visibility === 'workspace')
      )
    : [];
  const threadAvailable = availableThreads.some((thread) => thread.id === threadId);
  const changedParent = current.version !== parentVersion;
  const blocked =
    props.disabled ||
    commit.isPending ||
    commit.isError ||
    head.isError ||
    head.isFetching ||
    threads.isFetching ||
    !threads.isSuccess ||
    changedParent;

  function submit() {
    if (blocked || !title.trim() || !threadAvailable || (!file && !body)) return;
    const input = {
      workspaceId: current.workspaceId,
      artifactId: current.id,
      threadId,
      expectedArtifactVersion: parentVersion,
      title,
      summary: summary || null,
      requestId: createRequestId(),
    };
    const command: ArtifactVersionCommitInput = file
      ? {
          kind: 'file',
          input: {
            ...input,
            mediaType: isArtifactImportMediaType(file.type)
              ? file.type
              : 'application/octet-stream',
          },
          file,
        }
      : { kind: 'inline', input: { ...input, content: { format, body } } };
    setRefreshedAfterFailure(false);
    commit.mutate(command, { onSuccess: (result) => props.onCommitted(result.artifact.version) });
  }

  async function refreshCurrent() {
    const result = await head.refetch();
    setRefreshFailed(!result.isSuccess);
    setRefreshedAfterFailure(result.isSuccess);
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Create next Artifact version">
      <h3 className="text-sm font-bold text-fg">Create next version</h3>
      <p className="text-sm text-fg-muted">
        Parent: version {parentVersion}. Previous versions stay available. The publishing
        conversation must be idle. Saving does not start agent work.
      </p>
      {commit.isPending ? <StatusChip tone="notice">Saving new version</StatusChip> : null}
      <TextField label="Version title" value={title} onChange={setTitle} isDisabled={blocked} />
      <TextField
        label="Version summary"
        value={summary}
        onChange={setSummary}
        isDisabled={blocked}
      />
      <Select
        label="Publishing conversation"
        items={availableThreads.map((thread) => ({
          id: thread.id,
          label: thread.name ?? 'Untitled conversation',
        }))}
        selectedKey={threadId || null}
        onSelectionChange={(key) => setThreadId(key === null ? '' : String(key))}
        isDisabled={blocked}
      />
      {threads.isError ? (
        <ErrorBanner
          message="Couldn't load publishing conversations."
          onRetry={() => void threads.refetch()}
        />
      ) : threads.isSuccess && !availableThreads.length ? (
        <p className="text-sm text-fg-muted">No eligible publishing conversation is available.</p>
      ) : null}
      <FileTrigger
        onSelect={(files) => {
          const chosen = files?.item(0);
          if (chosen) setFile(chosen);
        }}
      >
        <Button size="sm" variant="outline" isDisabled={blocked}>
          Choose replacement file
        </Button>
      </FileTrigger>
      {file ? (
        <>
          <p className="text-sm text-fg-muted">
            {file.name} · {file.size.toLocaleString()} bytes
          </p>
          <Button size="sm" variant="quiet" isDisabled={blocked} onPress={() => setFile(null)}>
            Remove replacement file
          </Button>
        </>
      ) : (
        <>
          <Select
            label="Version format"
            items={[
              { id: 'markdown', label: 'Markdown' },
              { id: 'text', label: 'Plain text' },
              { id: 'json', label: 'JSON' },
            ]}
            selectedKey={format}
            onSelectionChange={(key) => {
              if (key === 'markdown' || key === 'text' || key === 'json') setFormat(key);
            }}
            isDisabled={blocked}
          />
          <AriaTextField
            className="flex flex-col gap-1"
            value={body}
            onChange={setBody}
            isDisabled={blocked}
          >
            <Label className="text-xs font-bold text-fg">Version content</Label>
            <TextArea className="min-h-32 resize-y rounded-ok border border-border bg-card px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg" />
          </AriaTextField>
        </>
      )}
      {commit.isError ? (
        <ErrorBanner message={artifactVersionCommitErrorMessage(commit.error)} />
      ) : null}
      {refreshFailed || head.isError ? (
        <ErrorBanner
          message="Couldn't refresh the current version. The draft is retained."
          onRetry={() => void refreshCurrent()}
        />
      ) : null}
      {changedParent ? (
        <p className="text-sm text-fg-muted">
          The current head is version {current.version}. This draft still names version{' '}
          {parentVersion} as its parent.
        </p>
      ) : null}
      {commit.isError && isRetryableArtifactVersionCommit(commit.error) ? (
        <Button
          size="sm"
          isDisabled={props.disabled || commit.isPending}
          onPress={() => {
            if (commit.variables)
              commit.mutate(commit.variables, {
                onSuccess: (result) => props.onCommitted(result.artifact.version),
              });
          }}
        >
          Retry same version request
        </Button>
      ) : null}
      {commit.isError || changedParent ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled || commit.isPending || head.isFetching}
          onPress={() => void refreshCurrent()}
        >
          Refresh current version
        </Button>
      ) : null}
      {/* A newer head cannot discard a request whose publication still needs reconciliation. */}
      {((changedParent && commit.isIdle) ||
        (commit.isError &&
          refreshedAfterFailure &&
          !isRetryableArtifactVersionCommit(commit.error) &&
          commit.error instanceof ApiCallError &&
          commit.error.code !== 'recovery_required')) &&
      head.isSuccess &&
      !head.isFetching ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled || commit.isPending}
          onPress={() => {
            setParentVersion(head.data.version);
            commit.reset();
          }}
        >
          Use version {head.data.version} as parent
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          isDisabled={blocked || !title.trim() || !threadAvailable || (!file && !body)}
          onPress={submit}
        >
          Save new version
        </Button>
        <Button size="sm" variant="outline" isDisabled={commit.isPending} onPress={props.onCancel}>
          Cancel version draft
        </Button>
      </div>
    </section>
  );
}
