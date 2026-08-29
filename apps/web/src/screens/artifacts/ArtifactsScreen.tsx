import { useEffect, useRef, useState } from 'react';
import { TextField as AriaTextField, Label, TextArea } from 'react-aria-components';
import { useConnection } from '../../app/core-client';
import {
  ArtifactRow,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  type StatusTone,
  TextField,
} from '../../primitives';
import {
  type ArtifactImportInput,
  type ArtifactIntroduceInput,
  type ArtifactListItem,
  artifactImportErrorMessage,
  artifactIntroduceErrorMessage,
  artifactListErrorMessage,
  createRequestId,
  isArtifactImportMediaType,
  isAuthoritativeIntroduceItem,
  isCorrectableImportError,
  isImportRefreshError,
  isIntroduceRefreshError,
  isRetryableImportError,
  isRetryableIntroduceError,
  isWorkspaceAccessDenied,
  useArtifact,
  useArtifacts,
  useCurrentWorkspaceId,
  useImportWorkspaceArtifact,
  useIntroduceWorkspaceArtifact,
  useThreads,
  useWorkspaces,
} from './data';

const ARTIFACT_STATUS: Record<ArtifactListItem['status'], { label: string; tone: StatusTone }> = {
  archived: { label: 'Archived', tone: 'neutral' },
  draft: { label: 'Draft', tone: 'notice' },
  ready: { label: 'Ready', tone: 'positive' },
};

/**
 * Returns whether the exact Artifact read is an importable introduction target.
 *
 * Eligibility is the detail origin only: `imported` with null Thread and Turn,
 * matching the listed version, and not a loading or failed read.
 *
 * @param listed Current list row for the selected Artifact.
 * @param detail Exact `getArtifact` payload, if loaded.
 * @param detailFailed True when the exact read is in error.
 * @returns True only when introduction may be submitted.
 */
function isImportedDetailEligible(
  listed: ArtifactListItem,
  detail: ReturnType<typeof useArtifact>['data'] | undefined,
  detailFailed: boolean
): boolean {
  return Boolean(
    detail &&
      !detailFailed &&
      detail.version === listed.version &&
      detail.origin.kind === 'imported' &&
      detail.threadId === null &&
      detail.turnId === null
  );
}

/**
 * Accessible multiline Import Content field.
 *
 * @param props Controlled value, change handler, and disabled state.
 * @returns React Aria textarea labeled Content.
 */
function ImportContentField(props: {
  value: string;
  onChange: (value: string) => void;
  isDisabled: boolean;
}) {
  return (
    <AriaTextField
      className="flex flex-col gap-1"
      value={props.value}
      onChange={props.onChange}
      isDisabled={props.isDisabled}
    >
      <Label className="text-xs font-bold text-fg">Content</Label>
      <TextArea className="min-h-32 resize-y rounded-ok border border-border bg-card px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted hover:border-border-hover focus:border-accent focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg" />
    </AriaTextField>
  );
}

/** Live selected-Workspace Artifact inventory, exact read, import, and introduction. */
export function ArtifactsScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const artifacts = useArtifacts(workspaceId);
  const threads = useThreads(workspaceId);
  const importArtifact = useImportWorkspaceArtifact();
  const introduceArtifact = useIntroduceWorkspaceArtifact();
  const { connected } = useConnection();
  const disconnected = !connected;
  const [importing, setImporting] = useState(false);
  const [title, setTitle] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [content, setContent] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState('');
  const [listDeniedUntilSettled, setListDeniedUntilSettled] = useState(false);
  const selected = useArtifact(workspaceId, selectedId ?? '');
  const listDenied = isWorkspaceAccessDenied(artifacts.error);
  const hideCachedArtifacts = !artifacts.isSuccess && (listDenied || listDeniedUntilSettled);

  // Workspace identity is the reset trigger even though its bytes are not rendered here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear workspace-bound form and command state on selection change
  useEffect(() => {
    setImporting(false);
    setTitle('');
    setMediaType('');
    setContent('');
    setSelectedId(null);
    setThreadId('');
    setListDeniedUntilSettled(false);
    importArtifact.reset();
    introduceArtifact.reset();
  }, [workspaceId]);

  // Access-denied list refetch keeps TanStack cache; fail closed until a later list success.
  // biome-ignore lint/correctness/useExhaustiveDependencies: drop cached selection and mutation projections only on typed denial
  useEffect(() => {
    if (!listDenied) {
      if (artifacts.isSuccess) setListDeniedUntilSettled(false);
      return;
    }
    setListDeniedUntilSettled(true);
    setImporting(false);
    setTitle('');
    setMediaType('');
    setContent('');
    setSelectedId(null);
    setThreadId('');
    importArtifact.reset();
    introduceArtifact.reset();
  }, [listDenied, artifacts.isSuccess]);

  function resetImportForm() {
    setImporting(false);
    setTitle('');
    setMediaType('');
    setContent('');
    importArtifact.reset();
  }

  function submitImport(input: ArtifactImportInput) {
    const sourceWorkspaceId = input.workspaceId;
    importArtifact.mutate(input, {
      onSuccess: () => {
        if (workspaceIdRef.current !== sourceWorkspaceId) return;
        resetImportForm();
        void artifacts.refetch();
      },
    });
  }

  function submitIntroduce(input: ArtifactIntroduceInput) {
    introduceArtifact.mutate(input);
  }

  function tryImport() {
    if (!workspaceId || !isArtifactImportMediaType(mediaType) || !title || !content) return;
    submitImport({
      workspaceId,
      title,
      mediaType,
      content,
      requestId: createRequestId(),
    });
  }

  function tryIntroduce(listed: ArtifactListItem) {
    if (!workspaceId || !selectedId || !threadId) return;
    if (!isImportedDetailEligible(listed, selected.data, selected.isError)) return;
    submitIntroduce({
      workspaceId,
      threadId,
      artifactId: selectedId,
      expectedArtifactVersion: listed.version,
      requestId: createRequestId(),
    });
  }

  function retryImport() {
    if (disconnected) return;
    if (isWorkspaceAccessDenied(importArtifact.error)) {
      void workspaces.refetch().finally(() => importArtifact.reset());
      return;
    }
    if (isImportRefreshError(importArtifact.error)) {
      void artifacts.refetch().finally(() => importArtifact.reset());
      return;
    }
    if (importArtifact.variables) submitImport(importArtifact.variables);
  }

  function retryIntroduce() {
    if (disconnected) return;
    if (isWorkspaceAccessDenied(introduceArtifact.error)) {
      void workspaces.refetch().finally(() => introduceArtifact.reset());
      return;
    }
    if (isIntroduceRefreshError(introduceArtifact.error)) {
      void Promise.all([artifacts.refetch(), selected.refetch()]).finally(() =>
        introduceArtifact.reset()
      );
      return;
    }
    if (introduceArtifact.variables) submitIntroduce(introduceArtifact.variables);
  }

  /**
   * Retries the Artifact list. Typed access denial re-establishes Workspace
   * discovery first; generic failures refetch the list only.
   */
  function retryArtifactList() {
    if (isWorkspaceAccessDenied(artifacts.error) || listDeniedUntilSettled) {
      void workspaces.refetch().finally(() => {
        void artifacts.refetch();
      });
      return;
    }
    void artifacts.refetch();
  }

  function openArtifact(id: string) {
    if (id !== selectedId) {
      introduceArtifact.reset();
      setThreadId('');
    }
    setSelectedId(id);
  }

  if (!workspaces.isSuccess) {
    return (
      <Page>
        {workspaces.isError ? (
          <>
            <PageHeader title="Artifacts" />
            <ErrorBanner
              message="Couldn't load workspaces."
              onRetry={() => void workspaces.refetch()}
            />
          </>
        ) : (
          <Skeleton lines={8} />
        )}
      </Page>
    );
  }

  if (!workspaceId) {
    return (
      <Page>
        <PageHeader title="Artifacts" />
        <EmptyState icon="file" title="Choose a Workspace first" />
      </Page>
    );
  }

  if (artifacts.isLoading && artifacts.data === undefined) {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (artifacts.data === undefined || hideCachedArtifacts) {
    return (
      <Page>
        <PageHeader title="Artifacts" />
        <ErrorBanner
          message={artifactListErrorMessage(artifacts.error)}
          onRetry={retryArtifactList}
        />
      </Page>
    );
  }

  const items = artifacts.data;
  const listedItem = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;
  const previewBody =
    listedItem && selected.data && selected.data.version === listedItem.version && !selected.isError
      ? selected.data.content.body
      : undefined;
  const importBound = importArtifact.variables?.workspaceId === workspaceId;
  const introduceBound =
    introduceArtifact.variables?.workspaceId === workspaceId &&
    introduceArtifact.variables?.artifactId === selectedId;
  const introduced =
    introduceBound &&
    introduceArtifact.isSuccess &&
    introduceArtifact.data &&
    introduceArtifact.variables &&
    isAuthoritativeIntroduceItem(introduceArtifact.data, introduceArtifact.variables.requestId);
  const introducedThreadName = introduced
    ? (threads.data?.find((thread) => thread.id === introduceArtifact.variables?.threadId)?.name ??
      null)
    : null;
  const writeBlocked =
    disconnected ||
    artifacts.isError ||
    artifacts.isFetching ||
    importArtifact.isPending ||
    introduceArtifact.isPending;
  const canImport = isArtifactImportMediaType(mediaType) && Boolean(title && content);
  const canIntroduce = Boolean(
    listedItem &&
      threadId &&
      threads.isSuccess &&
      threads.data.length &&
      isImportedDetailEligible(listedItem, selected.data, selected.isError)
  );
  const importActionBlocked =
    writeBlocked || (importBound && isWorkspaceAccessDenied(importArtifact.error));
  const introduceActionBlocked =
    writeBlocked || (introduceBound && Boolean(introduceArtifact.isError));
  const importSubmitBlocked =
    importActionBlocked ||
    !canImport ||
    (importBound && importArtifact.isError && !isCorrectableImportError(importArtifact.error));
  const listStale = artifacts.isError;

  return (
    <Page>
      <PageHeader
        title="Artifacts"
        subtitle="Durable outputs in this Workspace. Open one to read its product content, or import a new Artifact."
        actions={
          <>
            {disconnected ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
            <Button size="sm" isDisabled={importActionBlocked} onPress={() => setImporting(true)}>
              Import artifact
            </Button>
          </>
        }
      />

      {listStale ? (
        <ErrorBanner
          message={artifactListErrorMessage(artifacts.error)}
          onRetry={retryArtifactList}
        />
      ) : null}

      {importing ? (
        <Card className="flex flex-col gap-3">
          <TextField
            label="Title"
            value={title}
            onChange={setTitle}
            isDisabled={importActionBlocked}
          />
          <TextField
            label="Media type"
            value={mediaType}
            onChange={setMediaType}
            isDisabled={importActionBlocked}
            placeholder="text/markdown"
          />
          <ImportContentField
            value={content}
            onChange={setContent}
            isDisabled={importActionBlocked}
          />
          {importBound && importArtifact.isError ? (
            <fieldset disabled={disconnected} className="contents">
              <ErrorBanner
                message={artifactImportErrorMessage(importArtifact.error)}
                onRetry={isRetryableImportError(importArtifact.error) ? retryImport : undefined}
              />
            </fieldset>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" isDisabled={importSubmitBlocked} onPress={tryImport}>
              Import
            </Button>
            <Button size="sm" variant="outline" onPress={resetImportForm}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {items.length === 0 && !importing ? (
        <EmptyState
          icon="file"
          title="No artifacts yet"
          hint="Import a document or wait for work to leave a durable output."
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const status = ARTIFACT_STATUS[item.status];
            return (
              <li key={item.id}>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <ArtifactRow name={item.title} onOpen={() => openArtifact(item.id)} />
                  </div>
                  <StatusChip tone={status.tone}>{status.label}</StatusChip>
                </div>
                {item.summary ? (
                  <p className="px-2 pb-2 text-xs text-fg-muted">{item.summary}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {selectedId ? (
        <Card className="flex flex-col gap-3">
          {listedItem ? (
            <p className="text-xs text-fg-muted">Version {listedItem.version}</p>
          ) : null}
          {listedItem && selected.isError ? (
            <ErrorBanner
              message="Couldn't load that artifact."
              onRetry={() => void selected.refetch()}
            />
          ) : listedItem && selected.isLoading && selected.data === undefined ? (
            <Skeleton lines={4} />
          ) : previewBody ? (
            <pre className="whitespace-pre-wrap text-sm text-fg">{previewBody}</pre>
          ) : null}
          {threads.isError ? (
            <ErrorBanner message="Couldn't load threads." onRetry={() => void threads.refetch()} />
          ) : threads.isLoading && threads.data === undefined ? (
            <Skeleton lines={2} />
          ) : !threads.data?.length ? (
            <p className="text-sm text-fg-muted">No threads in this Workspace.</p>
          ) : (
            <Select
              label="Thread"
              placeholder=""
              items={threads.data.map((thread) => ({
                id: thread.id,
                label: thread.name ?? 'Untitled thread',
              }))}
              selectedKey={threadId || null}
              isDisabled={introduceActionBlocked}
              onSelectionChange={(key) => setThreadId(key == null ? '' : String(key))}
            />
          )}
          {introduceBound && introduceArtifact.isError ? (
            <fieldset disabled={disconnected} className="contents">
              <ErrorBanner
                message={artifactIntroduceErrorMessage(introduceArtifact.error)}
                onRetry={
                  isRetryableIntroduceError(introduceArtifact.error) ? retryIntroduce : undefined
                }
              />
            </fieldset>
          ) : null}
          {introducedThreadName ? (
            <p className="text-sm text-fg">Introduced into {introducedThreadName}.</p>
          ) : null}
          <Button
            size="sm"
            isDisabled={introduceActionBlocked || !canIntroduce}
            onPress={() => {
              if (listedItem) tryIntroduce(listedItem);
            }}
          >
            Introduce into thread
          </Button>
        </Card>
      ) : null}
    </Page>
  );
}
