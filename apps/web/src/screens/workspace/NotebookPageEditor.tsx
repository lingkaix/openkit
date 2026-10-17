import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TextField as AriaTextField, Label, TextArea } from 'react-aria-components';
import { useConnection, useCoreClient } from '../../app/core-client';
import { Button, DiffView, ErrorBanner, TextField } from '../../primitives';
import { workspaceKeys } from './data';

type EditCommand = Parameters<CoreClient['operations']['knowledge.notebook.update']>[0] & {
  requestId: string;
};

/** Exact current page selected from a complete currently authorized history diff. */
interface NotebookPageEditorProps {
  workspaceId: string;
  baseRevision: string;
  path: string;
  content: string;
  onClose: () => void;
  onInspect: () => void;
  onDenied: () => void;
  onPublished: () => void;
}

/** One volatile human edit; the server owns OKF validation, source authority and publication. */
export function NotebookPageEditor(props: NotebookPageEditorProps) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const connection = useConnection();
  // Freeze the source tuple on mount. Refreshed projections cannot retarget a draft or saved request.
  const [base] = useState(() => ({
    workspaceId: props.workspaceId,
    baseRevision: props.baseRevision,
    path: props.path,
    content: props.content,
  }));
  const [content, setContent] = useState(base.content);
  const [summary, setSummary] = useState('');
  const [intent, setIntent] = useState<EditCommand | null>(null);
  const update = useMutation({
    mutationFn: (command: EditCommand) => client.operations['knowledge.notebook.update'](command),
    onError: (error) => {
      if (error instanceof ApiCallError && (error.status === 401 || error.status === 403))
        props.onDenied();
    },
    onSuccess: async (_result, command) => {
      props.onPublished();
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.knowledge(command.workspaceId) }),
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.knowledgeIndexes(command.workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.attention(command.workspaceId) }),
      ]);
    },
    retry: false,
  });
  const pageTooLarge = new TextEncoder().encode(content).length > 2 * 1024 * 1024;
  const summaryTooLarge = new TextEncoder().encode(summary).length > 4096;
  const blocked = connection.checking || connection.failed || update.isPending;
  const frozen = intent !== null;
  const unknownResult =
    update.isError &&
    (!(update.error instanceof ApiCallError) ||
      update.error.status >= 500 ||
      update.error.code === 'recovery_required');
  const cause =
    update.error instanceof ApiCallError
      ? update.error.code === 'recovery_required'
        ? 'publication evidence is unavailable'
        : `server error ${update.error.status}`
      : 'connection or response failure';

  /** Save the exact command before dispatch; uncertain retries cannot take current form values. */
  function apply() {
    if (
      blocked ||
      frozen ||
      pageTooLarge ||
      summaryTooLarge ||
      !summary.trim() ||
      content === base.content
    )
      return;
    const command: EditCommand = {
      workspaceId: base.workspaceId,
      requestId: createRequestId(),
      baseRevision: base.baseRevision,
      changes: [{ path: base.path, content }],
      summary,
    };
    setIntent(command);
    update.mutate(command);
  }

  return (
    <section aria-label={`Edit ${base.path}`} className="flex flex-col gap-3">
      <p className="font-bold text-fg-strong">Edit {base.path}</p>
      <p className="text-sm text-fg-muted">
        Edit the complete page text. Publication checks the current schema and Source access and
        keeps the earlier revision.
      </p>
      <AriaTextField
        value={content}
        onChange={setContent}
        isDisabled={blocked || frozen}
        isInvalid={pageTooLarge}
        className="flex flex-col gap-1"
      >
        <Label className="text-xs font-bold text-fg">Page text/Markdown</Label>
        <TextArea
          rows={12}
          className="rounded-ok border border-border bg-card p-3 font-mono text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg"
        />
      </AriaTextField>
      <TextField
        label="Edit summary"
        value={summary}
        onChange={setSummary}
        isDisabled={blocked || frozen}
        isInvalid={summaryTooLarge}
      />
      {pageTooLarge ? (
        <ErrorBanner message="Page text exceeds the 2 MiB limit. Reduce the text before applying the edit." />
      ) : null}
      {summaryTooLarge ? (
        <ErrorBanner message="Edit summary exceeds the 4 KiB limit. Shorten the summary before applying the edit." />
      ) : null}
      {!pageTooLarge ? (
        <DiffView
          before={base.content}
          after={content}
          beforeLabel="Current page text"
          afterLabel="Edited page text"
        />
      ) : null}
      <div className="flex gap-2">
        {!frozen ? (
          <>
            <Button size="sm" variant="quiet" isDisabled={blocked} onPress={props.onClose}>
              Cancel edit
            </Button>
            <Button
              size="sm"
              isDisabled={
                blocked ||
                pageTooLarge ||
                summaryTooLarge ||
                !summary.trim() ||
                content === base.content
              }
              onPress={apply}
            >
              Apply page edit
            </Button>
          </>
        ) : null}
        {update.isError ? (
          <Button size="sm" variant="quiet" isDisabled={blocked} onPress={props.onInspect}>
            Close edit and inspect current history
          </Button>
        ) : null}
        {unknownResult && intent ? (
          <Button
            size="sm"
            variant="outline"
            isDisabled={blocked}
            onPress={() => update.mutate(intent)}
          >
            Retry saved page edit
          </Button>
        ) : null}
      </div>
      {update.isPending ? <p role="status">Publishing page edit…</p> : null}
      {update.isError ? (
        <p className="text-sm text-fg-muted">
          Inspecting history closes this draft. It does not undo the saved request.
        </p>
      ) : null}
      {update.isError ? (
        <ErrorBanner
          message={
            unknownResult
              ? `Page edit result is unknown (${cause}). Retry the saved request or inspect current history before another edit.`
              : update.error instanceof ApiCallError && update.error.code === 'conflict'
                ? 'The Notebook changed. This edit was refused. Inspect current history and start a new edit.'
                : 'Page edit was refused. Inspect current history before starting another edit.'
          }
        />
      ) : null}
    </section>
  );
}
