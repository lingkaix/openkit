import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Checkbox, CheckboxGroup } from 'react-aria-components';
import { useConnection, useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  DiffView,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  Modal,
  RadioGroup,
  Skeleton,
  TextField,
} from '../../primitives';
import { knowledgeActionErrorMessage, workspaceKeys } from './data';

type RestoreCommand = Parameters<CoreClient['operations']['knowledge.notebook.restore']>[0] & {
  requestId: string;
};

/** Workspace-keyed local choices cannot carry another Workspace's selected history or command. */
export function NotebookHistoryPanel({ workspaceId }: { workspaceId: string | null }) {
  return workspaceId ? <NotebookHistory key={workspaceId} workspaceId={workspaceId} /> : null;
}

/** Published history and exact restore preview remain server-owned Query projections. */
function NotebookHistory({ workspaceId }: { workspaceId: string }) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const connection = useConnection();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fromRevision, setFromRevision] = useState<string | null>(null);
  const [forRestore, setForRestore] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<string[] | null>(null);
  const [summary, setSummary] = useState('Restore selected Notebook pages');
  const [intent, setIntent] = useState<RestoreCommand | null>(null);
  const history = useQuery({
    queryKey: [...workspaceKeys.knowledge(workspaceId), 'history', cursor],
    queryFn: () =>
      client.operations['knowledge.notebook.history']({
        workspaceId,
        ...(cursor ? { revision: cursor } : {}),
      }),
    enabled: open,
    retry: false,
    refetchOnMount: 'always',
  });
  const baseRevision = history.isSuccess ? history.data.notebookRevision : null;
  const diff = useQuery({
    queryKey: [
      ...workspaceKeys.knowledge(workspaceId),
      'diff',
      baseRevision,
      fromRevision,
      forRestore,
    ],
    queryFn: () =>
      client.operations['knowledge.notebook.diff']({
        workspaceId,
        baseRevision: baseRevision!,
        fromRevision: fromRevision!,
        ...(forRestore ? { forRestore: true as const } : {}),
      }),
    enabled: open && Boolean(baseRevision && fromRevision),
    retry: false,
    refetchOnMount: 'always',
  });
  const preview =
    history.isSuccess &&
    !history.isFetching &&
    history.data.revisions.some(
      (revision) => revision.revision === fromRevision && revision.availability === 'available'
    ) &&
    diff.isSuccess &&
    !diff.isFetching &&
    diff.data.baseRevision === baseRevision &&
    diff.data.fromRevision === fromRevision &&
    diff.data.forRestore === forRestore
      ? diff.data
      : null;
  const changes = preview?.changes ?? [];
  const chosen = changes.filter(
    (change) => selectedPaths === null || selectedPaths.includes(change.path)
  );
  const restore = useMutation({
    mutationFn: (command: RestoreCommand) =>
      client.operations['knowledge.notebook.restore'](command),
    onSuccess: async (_result, command) => {
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.knowledge(command.workspaceId) }),
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.knowledgeIndexes(command.workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.attention(command.workspaceId) }),
      ]);
    },
  });
  const unknownResult =
    restore.isError && !(restore.error instanceof ApiCallError && restore.error.status < 500);
  const blocked = connection.checking || connection.failed || restore.isPending;
  const ready =
    !blocked &&
    !restore.isError &&
    history.isSuccess &&
    !history.isFetching &&
    forRestore &&
    preview !== null &&
    chosen.length > 0 &&
    summary.trim().length > 0 &&
    new TextEncoder().encode(summary).length <= 4096;
  const intentMatches =
    intent !== null &&
    preview !== null &&
    intent.baseRevision === preview.baseRevision &&
    intent.fromRevision === preview.fromRevision &&
    intent.pageIds.every((id) => preview.changes.some((change) => change.path === `${id}.md`));

  /** Creates a new command only after the user selects a complete immutable preview. */
  function reviewRestore() {
    if (!ready || !preview) return;
    setIntent({
      workspaceId,
      requestId: createRequestId(),
      baseRevision: preview.baseRevision,
      fromRevision: preview.fromRevision,
      pageIds: chosen.map((change) => change.path.slice(0, -3)),
      summary,
      ...(chosen.some((change) => change.after === null) ? { confirmRemoval: true as const } : {}),
    });
    restore.reset();
  }

  /** A read retry can clear a known refusal; an unknown command keeps its exact retry identity. */
  function refreshHistory() {
    if (!unknownResult) restore.reset();
    void history.refetch();
    if (baseRevision && fromRevision) void diff.refetch();
  }

  return (
    <section className="flex flex-col gap-3">
      <Button size="sm" variant="outline" aria-expanded={open} onPress={() => setOpen(!open)}>
        {open ? 'Close Notebook history' : 'Notebook history'}
      </Button>
      {open ? (
        <Card>
          <div className="flex flex-col gap-4">
            <Eyebrow>Published Notebook history</Eyebrow>
            <p className="text-sm text-fg-muted">
              Restore adds a new revision and keeps intervening history. Source access is checked
              again before publication.
            </p>
            {history.isPending || history.isFetching ? (
              <Skeleton lines={3} />
            ) : history.isError ? (
              <ErrorBanner
                message={knowledgeActionErrorMessage(
                  history.error,
                  "Couldn't read Notebook history."
                )}
                onRetry={refreshHistory}
              />
            ) : history.isSuccess ? (
              <>
                <RadioGroup
                  aria-label="Notebook revisions"
                  value={fromRevision ?? ''}
                  isDisabled={blocked}
                  onChange={(value) => {
                    setFromRevision(value);
                    setSelectedPaths(null);
                    setForRestore(false);
                  }}
                  items={history.data.revisions
                    .filter((revision) => revision.availability === 'available')
                    .map((revision) => ({
                      id: revision.revision,
                      label: revision.summary,
                      content: (
                        <>
                          <p className="font-bold text-fg-strong">{revision.summary}</p>
                          <p className="text-xs text-fg-muted">
                            {revision.producer.kind}: {revision.producer.id}
                          </p>
                          <code className="text-xs text-fg-muted">
                            {revision.revision.slice(0, 12)}
                          </code>
                        </>
                      ),
                    }))}
                />
                {history.data.revisions
                  .filter((revision) => revision.availability === 'unavailable')
                  .map((revision) => (
                    <p key={revision.revision} className="text-sm text-fg-muted">
                      Unavailable revision
                    </p>
                  ))}
                {history.data.revisions.length === 0 ? (
                  <EmptyState
                    title="No revisions available"
                    hint="Current permissions do not expose any Notebook revisions."
                  />
                ) : null}
                <div className="flex gap-2">
                  {history.data.nextRevision ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      isDisabled={blocked}
                      onPress={() => {
                        setCursor(history.data.nextRevision);
                        setFromRevision(null);
                        setSelectedPaths(null);
                      }}
                    >
                      Older revisions
                    </Button>
                  ) : null}
                  {cursor ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      isDisabled={blocked}
                      onPress={() => {
                        setCursor(null);
                        setFromRevision(null);
                        setSelectedPaths(null);
                      }}
                    >
                      Newest revisions
                    </Button>
                  ) : null}
                  <Button size="sm" variant="quiet" isDisabled={blocked} onPress={refreshHistory}>
                    Refresh history
                  </Button>
                </div>
              </>
            ) : null}
            {fromRevision && (diff.isPending || diff.isFetching) ? <Skeleton lines={3} /> : null}
            {fromRevision && diff.isError ? (
              <ErrorBanner
                message={knowledgeActionErrorMessage(
                  diff.error,
                  "Couldn't read the complete restore preview."
                )}
                onRetry={() => void diff.refetch()}
              />
            ) : null}
            {preview ? (
              <>
                <p className="text-sm text-fg-muted">
                  Current {preview.baseRevision.slice(0, 12)}. Historical{' '}
                  {preview.fromRevision.slice(0, 12)}.
                  {forRestore
                    ? ' Content-bound acceptance is cleared on changed pages in the restore preview.'
                    : ''}
                </p>
                {changes.length === 0 ? (
                  <p className="text-sm text-fg-muted">No page changes to restore.</p>
                ) : (
                  <>
                    {!forRestore ? (
                      <Button
                        size="sm"
                        variant="outline"
                        isDisabled={blocked}
                        onPress={() => setForRestore(true)}
                      >
                        Prepare restore
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="quiet"
                          isDisabled={blocked}
                          onPress={() => {
                            setForRestore(false);
                            setSelectedPaths(null);
                          }}
                        >
                          View historical diff
                        </Button>
                        <CheckboxGroup
                          aria-label="Pages to restore"
                          value={selectedPaths ?? changes.map((change) => change.path)}
                          isDisabled={blocked}
                          onChange={setSelectedPaths}
                          className="flex flex-col gap-2"
                        >
                          {changes.map((change) => (
                            <Checkbox
                              key={change.path}
                              value={change.path}
                              className="flex cursor-pointer items-center gap-2 rounded-ok border border-border px-3 py-2 text-sm text-fg outline-none data-[selected]:border-accent data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus"
                            >
                              {({ isSelected }) => (
                                <>
                                  <span aria-hidden="true">{isSelected ? '✓' : '○'}</span>
                                  <span>
                                    {change.path}
                                    {change.after === null ? ' (remove)' : ''}
                                  </span>
                                </>
                              )}
                            </Checkbox>
                          ))}
                        </CheckboxGroup>
                      </>
                    )}
                    {chosen.map((change) => (
                      <DiffView
                        key={change.path}
                        before={change.before ?? '(Page absent)'}
                        after={change.after ?? '(Page removed)'}
                        beforeLabel={`Current ${change.path}`}
                        afterLabel={`${forRestore ? 'Restored' : 'Historical'} ${change.path}`}
                      />
                    ))}
                    {forRestore ? (
                      <>
                        <TextField
                          label="Restore summary"
                          value={summary}
                          onChange={setSummary}
                          isDisabled={blocked}
                          maxLength={4096}
                        />
                        <Modal
                          trigger={
                            <Button
                              size="sm"
                              variant="outline"
                              isDisabled={!ready}
                              onPress={reviewRestore}
                            >
                              Review restore
                            </Button>
                          }
                        >
                          <Dialog title="Restore Notebook pages">
                            <p>
                              This creates a new revision with the selected page changes shown in
                              the preview.
                            </p>
                            <ul className="list-inside list-disc">
                              {intent?.pageIds.map((id) => (
                                <li key={id}>
                                  {id}.md
                                  {preview.changes.find((change) => change.path === `${id}.md`)
                                    ?.after === null
                                    ? ' (remove)'
                                    : ''}
                                </li>
                              ))}
                            </ul>
                            {!intentMatches ? (
                              <p>
                                The Notebook changed. Close this dialog and read the preview again.
                              </p>
                            ) : null}
                            <div className="flex justify-end gap-2">
                              <Button slot="close" size="sm" variant="quiet">
                                Cancel
                              </Button>
                              <Button
                                slot="close"
                                size="sm"
                                isDisabled={!ready || !intentMatches}
                                onPress={() => {
                                  if (intent && intentMatches && ready) restore.mutate(intent);
                                }}
                              >
                                Confirm restore
                              </Button>
                            </div>
                          </Dialog>
                        </Modal>
                      </>
                    ) : null}
                  </>
                )}
              </>
            ) : null}
            {restore.isPending ? <p role="status">Restoring selected pages…</p> : null}
            {restore.isSuccess ? (
              <p role="status">Selected pages were restored in a new revision.</p>
            ) : null}
            {restore.isError ? (
              <>
                <ErrorBanner
                  message={
                    unknownResult
                      ? 'Restore result is unknown. Retry the same request or inspect history.'
                      : knowledgeActionErrorMessage(
                          restore.error,
                          'Restore was refused. Refresh history before another change.'
                        )
                  }
                />
                {unknownResult && restore.variables ? (
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={blocked}
                    onPress={() => {
                      if (restore.variables) restore.mutate(restore.variables);
                    }}
                  >
                    Retry restore
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </Card>
      ) : null}
    </section>
  );
}
