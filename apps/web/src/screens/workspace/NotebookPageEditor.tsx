import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TextField as AriaTextField, Label, TextArea } from 'react-aria-components';
import { useConnection, useCoreClient } from '../../app/core-client';
import { Button, DiffView, ErrorBanner, Select, TextField } from '../../primitives';
import { workspaceKeys } from './data';
import {
  isKnowledgePageState,
  KNOWLEDGE_PAGE_STATES,
  type KnowledgePageState,
  patchKnowledgePageTitleBody,
  readKnowledgePageDisplay,
} from './knowledge-okf';

type EditCommand = Parameters<CoreClient['operations']['knowledge.notebook.update']>[0] & {
  requestId: string;
};

/** Human-facing label for one selectable page state. */
const PAGE_STATE_LABEL = {
  active: 'Active — default retrieval includes it',
  archived: 'Archived — kept, not retrieved by default',
  draft: 'Draft — not retrieved by default',
  superseded: 'Superseded — replaced by another page',
} satisfies Record<KnowledgePageState, string>;

const PAGE_STATE_OPTIONS = KNOWLEDGE_PAGE_STATES.map((state) => ({
  id: state,
  label: PAGE_STATE_LABEL[state],
}));

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
    state: readKnowledgePageDisplay(props.path, props.content).state,
  }));
  const [content, setContent] = useState(base.content);
  const [state, setState] = useState<KnowledgePageState | null>(base.state);
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
  // Compose the exact published bytes here so the diff shows the state change too.
  const editedContent =
    state === null || state === base.state
      ? content
      : patchKnowledgePageTitleBody({ path: base.path, content, state });
  const pageTooLarge = new TextEncoder().encode(editedContent).length > 2 * 1024 * 1024;
  const summaryTooLarge = new TextEncoder().encode(summary).length > 4096;
  const blocked = connection.checking || connection.failed || update.isPending;
  const frozen = intent !== null;
  const unchanged = editedContent === base.content;
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
    if (blocked || frozen || pageTooLarge || summaryTooLarge || !summary.trim() || unchanged)
      return;
    const command: EditCommand = {
      workspaceId: base.workspaceId,
      requestId: createRequestId(),
      baseRevision: base.baseRevision,
      changes: [{ path: base.path, content: editedContent }],
      summary,
    };
    setIntent(command);
    update.mutate(command);
  }

  return (
    <section aria-label={`Edit ${base.path}`} className="flex flex-col gap-3">
      <p className="font-bold text-fg-strong">Edit {base.path}</p>
      <p className="text-sm text-fg-muted">
        Edit the complete page text and choose its state. Publication checks the current schema and
        Source access and keeps the earlier revision. Archive keeps the page available without
        retrieval.
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
      <Select
        label="Page state"
        items={PAGE_STATE_OPTIONS}
        selectedKey={state}
        isDisabled={blocked || frozen}
        placeholder="Unsupported state in current bytes"
        onSelectionChange={(key) => {
          if (isKnowledgePageState(key)) setState(key);
        }}
      />
      {state === null ? (
        <p className="text-xs text-fg-muted">
          This page carries no selectable state. Choosing one publishes that state with the edit.
        </p>
      ) : null}
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
          after={editedContent}
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
                blocked || pageTooLarge || summaryTooLarge || !summary.trim() || unchanged
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
