import { createRequestId } from '@openkit/core-client';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-aria-components';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  ListRow,
  Modal,
  Page,
  PageHeader,
  Select,
  Skeleton,
  TextField,
} from '../../primitives';
import {
  type AnswerKnowledgeManagerCommand,
  type CheckKnowledgeHealthCommand,
  type CreateKnowledgeCommand,
  type DeleteKnowledgeCommand,
  type KnowledgeNotebookPage,
  type KnowledgeProposalDecisionInput,
  type KnowledgeStoreProjection,
  knowledgeActionErrorMessage,
  knowledgePageScopeLabel,
  matchesWorkspaceKnowledgePageReference,
  type PrepareKnowledgeContextCommand,
  type ReadKnowledgeSourceCommand,
  type RegisterKnowledgeSourceCommand,
  type RetrieveKnowledgeCommand,
  readKnowledgeCitationEvidence,
  type SuggestKnowledgeRepairsCommand,
  shouldShowKnowledgeCitationEvidence,
  type UpdateKnowledgeCommand,
  useAnswerKnowledgeManager,
  useCheckKnowledgeHealth,
  useCreateKnowledge,
  useCurrentWorkspaceId,
  useDeleteKnowledge,
  useHumanAttention,
  useKnowledge,
  useKnowledgeIndexes,
  useKnowledgeSources,
  usePrepareKnowledgeContext,
  useReadKnowledgeSource,
  useRegisterKnowledgeSource,
  useRetrieveKnowledge,
  useSubmitKnowledgeProposalDecision,
  useSuggestKnowledgeRepairs,
  useUpdateKnowledge,
  workspaceKeys,
  workspaceKnowledgePageScopeId,
} from './data';
import { KnowledgeProposalRow } from './KnowledgeProposalRow';
import {
  composeUserAuthoredKnowledgePage,
  patchKnowledgePageTitleBody,
  readKnowledgePageDisplay,
} from './knowledge-okf';
import { NotebookHistoryPanel } from './NotebookHistoryPanel';

const SOURCE_KIND_LABEL = {
  upload: 'Upload',
  url: 'Web link',
  document: 'Document',
  transcript: 'Transcript',
  code: 'Code',
} satisfies Record<KnowledgeStoreProjection['sources'][number]['kind'], string>;

const DERIVED_KIND_LABEL = {
  text: 'Text',
} as const;

const EXCLUSION_REASON_LABEL = {
  sensitive_content: 'Sensitive content',
  lower_conformance: 'Lower conformance',
  policy_excluded: 'Policy excluded',
  selector_mismatch: 'Selector mismatch',
  freshness_expired: 'Out of date',
  budget_exceeded: 'Over budget',
  source_unavailable: 'Source unavailable',
} as const;

const SOURCE_KIND_ITEMS = Object.entries(SOURCE_KIND_LABEL).map(([id, label]) => ({ id, label }));

function isSourceKind(value: string): value is keyof typeof SOURCE_KIND_LABEL {
  return Object.hasOwn(SOURCE_KIND_LABEL, value);
}

/** Scope the existing full-content fragment to its Workspace and page identity. */
function knowledgeContentId(workspaceId: string | null, knowledgePageId: string): string {
  return `knowledge-content-${encodeURIComponent(workspaceId ?? '')}-${encodeURIComponent(knowledgePageId)}`;
}

function matchesWorkspace(
  workspaceId: string | null,
  commandWorkspaceId: string | undefined
): boolean {
  return Boolean(workspaceId && commandWorkspaceId === workspaceId);
}

function omitWorkspaceFlag(
  current: Record<string, true>,
  workspaceId: string
): Record<string, true> {
  if (!current[workspaceId]) return current;
  const next = { ...current };
  delete next[workspaceId];
  return next;
}

function useWorkspaceScoped<T>(
  workspaceId: string | null,
  empty: T
): [T, (updater: T | ((prev: T) => T)) => void, (targetId: string) => void] {
  const [byWorkspace, setByWorkspace] = useState<Partial<Record<string, T>>>({});
  const value = workspaceId ? (byWorkspace[workspaceId] ?? empty) : empty;

  function setValue(updater: T | ((prev: T) => T)) {
    if (!workspaceId) return;
    setByWorkspace((current) => {
      const prev = current[workspaceId] ?? empty;
      const next = typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;
      return { ...current, [workspaceId]: next };
    });
  }

  function clear(targetId: string) {
    setByWorkspace((current) => ({ ...current, [targetId]: empty }));
  }

  return [value, setValue, clear];
}

/** Refetch one Workspace catalog, including inactive queries after a Workspace switch. */
async function refetchWorkspaceCatalog(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  onSuccess: () => void
) {
  try {
    await queryClient.refetchQueries({ queryKey, type: 'all' });
  } catch {
    return;
  }
  if (queryClient.getQueryState(queryKey)?.status === 'success') {
    onSuccess();
  }
}

type SourceDraft = {
  kind: string | null;
  title: string;
  content: string;
};

const EMPTY_SOURCE_DRAFT: SourceDraft = { kind: null, title: '', content: '' };

type AddDraft = {
  adding: boolean;
  baseRevision: string | null;
  pagePath: string | null;
  title: string;
  content: string;
  sourceReference: string | null;
};

const EMPTY_ADD_DRAFT: AddDraft = {
  adding: false,
  baseRevision: null,
  pagePath: null,
  title: '',
  content: '',
  sourceReference: null,
};

type EditDraft = {
  page: KnowledgeNotebookPage | null;
  baseRevision: string | null;
  title: string;
  content: string;
};

const EMPTY_EDIT_DRAFT: EditDraft = { page: null, baseRevision: null, title: '', content: '' };

/**
 * Knowledge Store slice (WP-6, board 14).
 *
 * Lists and directly mutates user-authored knowledge through Core. Mutation
 * responses remain hidden until the authoritative list refetch settles.
 */
export function KnowledgeScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const knowledge = useKnowledge(workspaceId);
  const sourcesCatalog = useKnowledgeSources(workspaceId);
  const indexesCatalog = useKnowledgeIndexes(workspaceId);
  const create = useCreateKnowledge();
  const update = useUpdateKnowledge();
  const remove = useDeleteKnowledge();
  const attention = useHumanAttention(workspaceId);
  const proposalDecision = useSubmitKnowledgeProposalDecision();
  const { checking, failed } = useConnection();
  const queryClient = useQueryClient();
  const [addDraft, setAddDraft, clearAddDraft] = useWorkspaceScoped(workspaceId, EMPTY_ADD_DRAFT);
  const [editDraft, setEditDraft, clearEditDraft] = useWorkspaceScoped(
    workspaceId,
    EMPTY_EDIT_DRAFT
  );
  const editing = editDraft.page;
  const writePending =
    create.isPending || update.isPending || remove.isPending || proposalDecision.isPending;
  const entryWriteBlocked =
    checking ||
    failed ||
    writePending ||
    knowledge.isError ||
    knowledge.isFetching ||
    !workspaceId ||
    !knowledge.data?.notebookRevision;
  const proposalWriteBlocked = entryWriteBlocked || attention.isFetching || attention.isError;
  const connectionBlocked = checking || failed;
  const pagePending =
    !workspaceId || knowledge.isPending || sourcesCatalog.isPending || indexesCatalog.isPending;

  const sourceOptions = (sourcesCatalog.isSuccess ? sourcesCatalog.data : []).flatMap((source) =>
    source.workspaceId === workspaceId && source.contentDigest
      ? [{ id: `source:${source.id}@${source.contentDigest}`, label: source.title }]
      : []
  );
  const selectedSourceAvailable =
    !addDraft.sourceReference ||
    sourceOptions.some((source) => source.id === addDraft.sourceReference);
  const selectedSourceReady =
    selectedSourceAvailable && (!addDraft.sourceReference || !sourcesCatalog.isFetching);

  function resetForm(targetId: string) {
    clearAddDraft(targetId);
    if (create.variables?.workspaceId === targetId) create.reset();
  }

  function settleEdit(targetId: string) {
    clearEditDraft(targetId);
    if (update.variables?.workspaceId === targetId) update.reset();
  }

  /** Create one page, or replay the exact Workspace-bound command after unknown failure. */
  function save(command?: CreateKnowledgeCommand) {
    if (!command && !selectedSourceReady) return;
    const next =
      command ??
      (workspaceId &&
      addDraft.baseRevision &&
      addDraft.pagePath &&
      addDraft.title.trim() &&
      addDraft.content.trim()
        ? {
            workspaceId,
            input: {
              requestId: createRequestId(),
              baseRevision: addDraft.baseRevision,
              path: addDraft.pagePath,
              content: composeUserAuthoredKnowledgePage({
                workspaceId,
                path: addDraft.pagePath,
                title: addDraft.title.trim(),
                body: addDraft.content.trim(),
                ...(addDraft.sourceReference ? { sourceRefs: [addDraft.sourceReference] } : {}),
              }),
              summary: `Create ${addDraft.pagePath}`,
            },
          }
        : undefined);
    if (!next || entryWriteBlocked) return;
    create.mutate(next, {
      onSuccess: (_data, settled) => {
        resetForm(settled.workspaceId);
      },
    });
  }

  /** Prefill the edit form from one exact authoritative page. */
  function startEditing(page: KnowledgeNotebookPage) {
    if (!knowledge.data?.notebookRevision) return;
    const display = readKnowledgePageDisplay(page.path, page.content);
    setEditDraft({
      page,
      baseRevision: knowledge.data.notebookRevision,
      title: display.title,
      content: display.body,
    });
    update.reset();
  }

  /** Close the current Workspace edit form and discard its local intent. */
  function stopEditing() {
    if (!workspaceId) return;
    settleEdit(workspaceId);
  }

  /** Submit only changed, non-empty trimmed fields, or replay the exact failed command. */
  function saveEdit(command?: UpdateKnowledgeCommand) {
    let next = command;
    if (!next) {
      if (!workspaceId || !editing || !editDraft.baseRevision) return;
      const baseline = readKnowledgePageDisplay(editing.path, editing.content);
      const titleChanged = editDraft.title !== baseline.title;
      const contentChanged = editDraft.content !== baseline.body;
      const nextTitle = editDraft.title.trim();
      const nextContent = editDraft.content.trim();
      if (
        (!titleChanged && !contentChanged) ||
        (titleChanged && !nextTitle) ||
        (contentChanged && !nextContent)
      )
        return;
      const nextPageContent = patchKnowledgePageTitleBody({
        path: editing.path,
        content: editing.content,
        ...(titleChanged ? { title: nextTitle } : {}),
        ...(contentChanged ? { body: nextContent } : {}),
      });
      next = {
        workspaceId,
        input: {
          requestId: createRequestId(),
          baseRevision: editDraft.baseRevision,
          changes: [{ path: editing.path, content: nextPageContent }],
          summary: `Edit ${editing.path}`,
        },
      };
    }
    if (entryWriteBlocked) return;
    update.mutate(next, {
      onSuccess: async (_data, settled) => {
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.knowledge(settled.workspaceId),
          () => settleEdit(settled.workspaceId)
        );
      },
    });
  }

  /** Retry only the authoritative Knowledge read and settle a completed edit after success. */
  async function retryKnowledgeRead() {
    const result = await knowledge.refetch();
    if (
      result.isSuccess &&
      workspaceId &&
      editing &&
      update.isSuccess &&
      matchesWorkspace(workspaceId, update.variables?.workspaceId)
    ) {
      settleEdit(workspaceId);
    }
  }

  /** Delete one page, then refresh only through the authoritative Knowledge read. */
  function removeEntry(command: DeleteKnowledgeCommand) {
    if (entryWriteBlocked) return;
    remove.mutate(command, {
      onSuccess: async (_data, settled) => {
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.knowledge(settled.workspaceId),
          () => {}
        );
      },
    });
  }

  const failedCreate =
    create.isError && matchesWorkspace(workspaceId, create.variables?.workspaceId)
      ? create.variables
      : undefined;
  const failedUpdate =
    update.isError && matchesWorkspace(workspaceId, update.variables?.workspaceId)
      ? update.variables
      : undefined;
  const failedRemove =
    remove.isError && matchesWorkspace(workspaceId, remove.variables?.workspaceId)
      ? remove.variables
      : undefined;
  const failedProposalDecision =
    proposalDecision.isError &&
    matchesWorkspace(workspaceId, proposalDecision.variables?.source.workspaceId)
      ? proposalDecision.variables
      : undefined;

  const editingBaseline = editing ? readKnowledgePageDisplay(editing.path, editing.content) : null;
  const editCanSave = Boolean(
    editingBaseline &&
      (editDraft.title !== editingBaseline.title || editDraft.content !== editingBaseline.body) &&
      (editDraft.title === editingBaseline.title || editDraft.title.trim()) &&
      (editDraft.content === editingBaseline.body || editDraft.content.trim())
  );

  const pages = knowledge.data?.pages ?? [];
  const knowledgeProposals = attention.data?.filter((row) => row.source.type === 'knowledge') ?? [];

  /** Submit a decision, then read the authoritative attention owner before UI settlement. */
  function submitProposalDecision(input: KnowledgeProposalDecisionInput) {
    proposalDecision.mutate(input, {
      onSuccess: async (_data, settled) => {
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.attention(settled.source.workspaceId),
          () => {}
        );
      },
    });
  }

  return (
    <Page>
      {pagePending ? (
        <Skeleton lines={4} />
      ) : (
        <PageHeader
          title="Knowledge"
          subtitle="What OpenKit saves and supplies to agents. Everything here is explicit — you can edit or remove any of it."
          actions={
            <Button
              size="sm"
              isDisabled={entryWriteBlocked}
              onPress={() => {
                const baseRevision = knowledge.data?.notebookRevision;
                if (!baseRevision) return;
                setAddDraft((current) => ({
                  ...current,
                  adding: true,
                  baseRevision,
                  pagePath: `notes/${createRequestId()}.md`,
                }));
              }}
            >
              Add knowledge
            </Button>
          }
        />
      )}
      <div className={pagePending ? 'hidden' : undefined}>
        <NotebookHistoryPanel workspaceId={workspaceId} />
        {addDraft.adding ? (
          <Card className="flex flex-col gap-3">
            <Eyebrow>New notebook page</Eyebrow>
            <TextField
              label="Title"
              value={addDraft.title}
              onChange={(title) => setAddDraft((current) => ({ ...current, title }))}
              isDisabled={entryWriteBlocked}
              placeholder="Short name for this knowledge"
            />
            <TextField
              label="Content"
              value={addDraft.content}
              onChange={(content) => setAddDraft((current) => ({ ...current, content }))}
              isDisabled={entryWriteBlocked}
              placeholder="What should agents remember?"
            />
            <Select
              label="Registered source"
              items={[{ id: 'none', label: 'No registered source' }, ...sourceOptions]}
              selectedKey={addDraft.sourceReference ?? 'none'}
              isDisabled={entryWriteBlocked || sourcesCatalog.isFetching || sourcesCatalog.isError}
              onSelectionChange={(key) =>
                setAddDraft((current) => ({
                  ...current,
                  sourceReference: key === null || key === 'none' ? null : String(key),
                }))
              }
            />
            <p className="text-xs text-fg-muted">
              Register a source below, then select it here to keep its reference with this entry.
            </p>
            {!selectedSourceAvailable ? (
              <p className="text-xs text-fg-muted">
                The selected source is unavailable. Select a current source before saving.
              </p>
            ) : null}
            {failedCreate ? (
              <fieldset disabled={entryWriteBlocked} className="contents">
                <ErrorBanner
                  message="Couldn't save that entry."
                  onRetry={() => save(failedCreate)}
                />
              </fieldset>
            ) : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                isDisabled={
                  entryWriteBlocked ||
                  !selectedSourceReady ||
                  !addDraft.title.trim() ||
                  !addDraft.content.trim()
                }
                onPress={() => save()}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => {
                  if (workspaceId) resetForm(workspaceId);
                }}
              >
                Cancel
              </Button>
            </div>
          </Card>
        ) : null}

        {failedRemove ? (
          <fieldset disabled={entryWriteBlocked} className="contents">
            <ErrorBanner
              message="Couldn't remove that entry."
              onRetry={() => removeEntry(failedRemove)}
            />
          </fieldset>
        ) : null}

        {knowledge.isError ? (
          <fieldset disabled={knowledge.isFetching} className="contents">
            <ErrorBanner
              message="Couldn't load knowledge."
              onRetry={() => void retryKnowledgeRead()}
            />
          </fieldset>
        ) : null}

        {!workspaceId || (knowledge.isLoading && knowledge.data === undefined) ? (
          <Skeleton lines={4} />
        ) : knowledge.data === undefined ? null : pages.length === 0 && !addDraft.adding ? (
          <EmptyState
            icon="book"
            title="No notebook pages yet"
            hint="Add a notebook page so agents start with what you already know."
          />
        ) : (
          <section className="flex flex-col gap-2">
            <Eyebrow>Notebook pages</Eyebrow>
            <Card className="p-0 px-4">
              {pages.map((page) => {
                const display = readKnowledgePageDisplay(page.path, page.content);
                return (
                  <ListRow key={page.id}>
                    <div
                      id={knowledgeContentId(workspaceId, page.id)}
                      tabIndex={-1}
                      className="min-w-0 flex-1 rounded-ok py-1 outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-fg-strong">{display.title}</p>
                          <p className="mt-0.5 text-xs text-fg-muted">{display.body}</p>
                          <p className="mt-1 text-xs text-fg-muted">{page.path}</p>
                          {display.type ? (
                            <p className="mt-1 text-xs text-fg-muted">Type: {display.type}</p>
                          ) : null}
                          <p className="mt-1 text-xs text-fg-muted">
                            Content digest: {page.contentDigest}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            size="sm"
                            variant="quiet"
                            aria-label={`Edit ${display.title}`}
                            isDisabled={entryWriteBlocked}
                            onPress={() => startEditing(page)}
                          >
                            {'Edit '}
                          </Button>
                          <Modal
                            trigger={
                              <Button
                                size="sm"
                                variant="negative-outline"
                                aria-label={`Remove ${display.title}`}
                                isDisabled={entryWriteBlocked}
                              >
                                {'Remove '}
                              </Button>
                            }
                          >
                            <Dialog title="Remove knowledge">
                              <p className="text-sm text-fg-muted">
                                This removes the page from the workspace knowledge notebook.
                              </p>
                              <div className="flex justify-end gap-2">
                                <Button slot="close" size="sm" variant="quiet">
                                  Cancel
                                </Button>
                                <Button
                                  slot="close"
                                  size="sm"
                                  variant="negative"
                                  isDisabled={entryWriteBlocked}
                                  onPress={() => {
                                    if (!workspaceId || !knowledge.data?.notebookRevision) return;
                                    removeEntry({
                                      workspaceId,
                                      input: {
                                        requestId: createRequestId(),
                                        baseRevision: knowledge.data.notebookRevision,
                                        path: page.path,
                                        expectedContentDigest: page.contentDigest,
                                        confirmRemoval: true,
                                        summary: `Remove ${page.path}`,
                                      },
                                    });
                                  }}
                                >
                                  Remove
                                </Button>
                              </div>
                            </Dialog>
                          </Modal>
                        </div>
                      </div>
                      {editing?.id === page.id ? (
                        <div className="mt-3 flex flex-col gap-3 border-t border-separator pt-3">
                          <TextField
                            label="Title"
                            value={editDraft.title}
                            onChange={(title) => setEditDraft((current) => ({ ...current, title }))}
                            isDisabled={entryWriteBlocked}
                          />
                          <TextField
                            label="Content"
                            value={editDraft.content}
                            onChange={(content) =>
                              setEditDraft((current) => ({ ...current, content }))
                            }
                            isDisabled={entryWriteBlocked}
                          />
                          {failedUpdate ? (
                            <fieldset disabled={entryWriteBlocked} className="contents">
                              <ErrorBanner
                                message="Couldn't save those changes."
                                onRetry={() => saveEdit(failedUpdate)}
                              />
                            </fieldset>
                          ) : null}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              isDisabled={entryWriteBlocked || !editCanSave}
                              onPress={() => saveEdit()}
                            >
                              Save changes
                            </Button>
                            <Button size="sm" variant="outline" onPress={stopEditing}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </ListRow>
                );
              })}
            </Card>
          </section>
        )}

        <KnowledgeSourcesPanel connectionBlocked={connectionBlocked} workspaceId={workspaceId} />
        <KnowledgeRetrievalPanel
          connectionBlocked={connectionBlocked}
          workspaceId={workspaceId}
          knowledgeBaseId={knowledge.data?.knowledgeBaseId}
          currentEntries={knowledge.isSuccess ? pages : []}
        />
        <KnowledgeManagerPanel
          connectionBlocked={connectionBlocked}
          workspaceId={workspaceId}
          knowledgeBaseId={knowledge.data?.knowledgeBaseId}
          currentEntries={knowledge.isSuccess ? pages : []}
        />

        {attention.isLoading ? (
          <Skeleton lines={2} />
        ) : attention.isError ? (
          <fieldset disabled={entryWriteBlocked || attention.isFetching} className="contents">
            <ErrorBanner
              message="Couldn't refresh knowledge proposals."
              onRetry={() => void attention.refetch()}
            />
          </fieldset>
        ) : null}

        {knowledgeProposals.length > 0 ? (
          <section className="flex flex-col gap-2">
            <Eyebrow>Knowledge proposals</Eyebrow>
            {failedProposalDecision ? (
              <fieldset disabled={proposalWriteBlocked} className="contents">
                <ErrorBanner
                  message="Couldn't submit that proposal decision."
                  onRetry={
                    failedProposalDecision.decision === 'accepted'
                      ? undefined
                      : () => submitProposalDecision(failedProposalDecision)
                  }
                />
              </fieldset>
            ) : null}
            <Card className="p-0 px-4">
              {knowledgeProposals.map((row) => {
                const source = row.source;
                if (source.type !== 'knowledge') return null;
                return (
                  <KnowledgeProposalRow
                    key={`${source.workspaceId}/${source.knowledgeProposalId}/${source.proposalDigest}/${source.candidateRevision}`}
                    row={row}
                    blocked={proposalWriteBlocked}
                    onDecide={submitProposalDecision}
                  />
                );
              })}
            </Card>
          </section>
        ) : null}
      </div>
    </Page>
  );
}

function KnowledgeSourcesPanel({
  workspaceId,
  connectionBlocked,
}: {
  workspaceId: string | null;
  connectionBlocked: boolean;
}) {
  const queryClient = useQueryClient();
  const sources = useKnowledgeSources(workspaceId);
  const register = useRegisterKnowledgeSource();
  const read = useReadKnowledgeSource();
  const [draft, setDraft, clearDraft] = useWorkspaceScoped(workspaceId, EMPTY_SOURCE_DRAFT);
  const [awaiting, setAwaiting] = useState<Record<string, true>>({});
  const catalogRetryBlocked = connectionBlocked || sources.isFetching;
  const fieldBlocked = connectionBlocked || !workspaceId || sources.isFetching;
  const awaitingThisWorkspace = Boolean(workspaceId && awaiting[workspaceId]);
  const submitBlocked =
    fieldBlocked ||
    register.isPending ||
    sources.isError ||
    awaitingThisWorkspace ||
    (register.isSuccess && matchesWorkspace(workspaceId, register.variables?.workspaceId));
  const registerReady = Boolean(
    draft.kind && isSourceKind(draft.kind) && draft.title.trim() && draft.content.trim()
  );

  function settleRegister(targetId: string) {
    clearDraft(targetId);
    setAwaiting((current) => omitWorkspaceFlag(current, targetId));
    if (register.variables?.workspaceId === targetId) register.reset();
  }

  /** Register one source, then wait for the authoritative source list. */
  function submitRegister(command?: RegisterKnowledgeSourceCommand) {
    const next =
      command ??
      (workspaceId &&
      draft.kind &&
      isSourceKind(draft.kind) &&
      draft.title.trim() &&
      draft.content.trim()
        ? {
            workspaceId,
            input: {
              requestId: createRequestId(),
              kind: draft.kind,
              title: draft.title.trim(),
              content: draft.content.trim(),
            },
          }
        : undefined);
    if (!next || (!command && submitBlocked)) return;
    if (command && (fieldBlocked || register.isPending)) return;
    register.mutate(next, {
      onSuccess: async (_data, settled) => {
        setAwaiting((current) => ({ ...current, [settled.workspaceId]: true }));
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.knowledgeSources(settled.workspaceId),
          () => settleRegister(settled.workspaceId)
        );
      },
    });
  }

  /** Retry only the authoritative source list and settle a completed register after success. */
  async function retrySourcesCatalog() {
    const result = await sources.refetch();
    if (
      result.isSuccess &&
      workspaceId &&
      register.isSuccess &&
      matchesWorkspace(workspaceId, register.variables?.workspaceId)
    ) {
      settleRegister(workspaceId);
    }
  }

  /** Read one listed source through the current Workspace identity. */
  function viewSource(command: ReadKnowledgeSourceCommand) {
    if (
      connectionBlocked ||
      !workspaceId ||
      read.isPending ||
      command.workspaceId !== workspaceId
    ) {
      return;
    }
    read.mutate(command);
  }

  const failedRegister =
    register.isError && matchesWorkspace(workspaceId, register.variables?.workspaceId)
      ? register.variables
      : undefined;
  const failedRead =
    read.isError && matchesWorkspace(workspaceId, read.variables?.workspaceId)
      ? read.variables
      : undefined;
  const readResult =
    read.isSuccess && matchesWorkspace(workspaceId, read.variables?.workspaceId) ? read.data : null;

  return (
    <section aria-label="Sources" className="flex flex-col gap-2">
      <Eyebrow>Sources</Eyebrow>
      {sources.isError ? (
        <fieldset disabled={catalogRetryBlocked} className="contents">
          <ErrorBanner
            message={knowledgeActionErrorMessage(
              sources.error,
              "Couldn't load Knowledge Store details."
            )}
            onRetry={() => void retrySourcesCatalog()}
          />
        </fieldset>
      ) : null}
      <Card className="flex flex-col gap-3">
        <Select
          label="Source kind"
          placeholder={
            draft.kind && isSourceKind(draft.kind) ? SOURCE_KIND_LABEL[draft.kind] : 'Select…'
          }
          items={SOURCE_KIND_ITEMS}
          selectedKey={draft.kind ?? null}
          isDisabled={fieldBlocked}
          onSelectionChange={(key) =>
            setDraft((current) => ({ ...current, kind: key == null ? null : String(key) }))
          }
        />
        <TextField
          label="Source title"
          value={draft.title}
          onChange={(title) => setDraft((current) => ({ ...current, title }))}
          isDisabled={fieldBlocked}
        />
        <TextField
          label="Source content"
          value={draft.content}
          onChange={(content) => setDraft((current) => ({ ...current, content }))}
          isDisabled={fieldBlocked}
        />
        {failedRegister ? (
          <fieldset disabled={fieldBlocked || register.isPending} className="contents">
            <ErrorBanner
              message={knowledgeActionErrorMessage(
                register.error,
                "Couldn't register that source."
              )}
              onRetry={() => submitRegister(failedRegister)}
            />
          </fieldset>
        ) : null}
        <Button
          size="sm"
          isDisabled={submitBlocked || !registerReady}
          onPress={() => submitRegister()}
        >
          Register source
        </Button>
      </Card>
      {sources.data && sources.data.length > 0 ? (
        <Card className="p-0 px-4">
          {sources.data.map((source) => (
            <ListRow key={source.id}>
              <div className="min-w-0 flex-1 py-1">
                <p className="text-sm font-bold text-fg-strong">{source.title}</p>
                <p className="mt-0.5 text-xs text-fg-muted">{SOURCE_KIND_LABEL[source.kind]}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                isDisabled={connectionBlocked || !workspaceId || read.isPending}
                onPress={() => {
                  if (!workspaceId) return;
                  viewSource({ workspaceId, sourceId: source.id });
                }}
              >
                {`View ${source.title}`}
              </Button>
            </ListRow>
          ))}
        </Card>
      ) : null}
      {failedRead ? (
        <fieldset disabled={connectionBlocked || read.isPending} className="contents">
          <ErrorBanner
            message={knowledgeActionErrorMessage(read.error, "Couldn't load that source.")}
            onRetry={() => viewSource(failedRead)}
          />
        </fieldset>
      ) : null}
      {readResult
        ? readResult.derivedRepresentations.map((representation) => (
            <p key={representation.id} className="text-sm text-fg">
              {DERIVED_KIND_LABEL[representation.kind]}
            </p>
          ))
        : null}
    </section>
  );
}

/** Compose selected search hits with authorized current Workspace content, never snapshot bytes. */
function KnowledgeRetrievalPanel({
  workspaceId,
  connectionBlocked,
  knowledgeBaseId,
  currentEntries,
}: {
  workspaceId: string | null;
  connectionBlocked: boolean;
  knowledgeBaseId: string | undefined;
  currentEntries: KnowledgeNotebookPage[];
}) {
  const indexes = useKnowledgeIndexes(workspaceId);
  const retrieve = useRetrieveKnowledge();
  const prepare = usePrepareKnowledgeContext();
  const [query, setQuery] = useWorkspaceScoped(workspaceId, '');
  const currentPageScopeId =
    workspaceId && knowledgeBaseId
      ? workspaceKnowledgePageScopeId(workspaceId, knowledgeBaseId)
      : null;
  const retrieveBlocked = connectionBlocked || !workspaceId || retrieve.isPending;
  const prepareBlocked = connectionBlocked || !workspaceId || prepare.isPending;

  /** Retrieve ranked candidates for the current Workspace query. */
  function submitRetrieve(command?: RetrieveKnowledgeCommand) {
    const next =
      command ??
      (workspaceId && query.trim() ? { workspaceId, input: { query: query.trim() } } : undefined);
    if (!next || retrieveBlocked) return;
    retrieve.mutate(next);
  }

  /** Prepare context material from the current Workspace query. */
  function submitPrepare(command?: PrepareKnowledgeContextCommand) {
    const next =
      command ??
      (workspaceId && query.trim() ? { workspaceId, input: { query: query.trim() } } : undefined);
    if (!next || prepareBlocked) return;
    prepare.mutate(next);
  }

  const failedRetrieve =
    retrieve.isError && matchesWorkspace(workspaceId, retrieve.variables?.workspaceId)
      ? retrieve.variables
      : undefined;
  const failedPrepare =
    prepare.isError && matchesWorkspace(workspaceId, prepare.variables?.workspaceId)
      ? prepare.variables
      : undefined;
  const retrieveResult =
    retrieve.isSuccess && matchesWorkspace(workspaceId, retrieve.variables?.workspaceId)
      ? retrieve.data
      : null;
  const prepareResult =
    prepare.isSuccess && matchesWorkspace(workspaceId, prepare.variables?.workspaceId)
      ? prepare.data
      : null;
  return (
    <section aria-label="Retrieval" className="flex flex-col gap-2">
      <Eyebrow>Retrieval</Eyebrow>
      {indexes.isError ? (
        <fieldset disabled={connectionBlocked || indexes.isFetching} className="contents">
          <ErrorBanner
            message={knowledgeActionErrorMessage(indexes.error, "Couldn't load indexes.")}
            onRetry={() => void indexes.refetch()}
          />
        </fieldset>
      ) : null}
      <Card className="flex flex-col gap-3">
        <TextField
          label="Query"
          value={query}
          onChange={setQuery}
          isDisabled={retrieveBlocked && prepareBlocked}
        />
        {failedRetrieve ? (
          <fieldset disabled={retrieveBlocked} className="contents">
            <ErrorBanner
              message={knowledgeActionErrorMessage(retrieve.error, "Couldn't retrieve knowledge.")}
              onRetry={() => submitRetrieve(failedRetrieve)}
            />
          </fieldset>
        ) : null}
        {failedPrepare ? (
          <fieldset disabled={prepareBlocked} className="contents">
            <ErrorBanner
              message={knowledgeActionErrorMessage(prepare.error, "Couldn't prepare context.")}
              onRetry={() => submitPrepare(failedPrepare)}
            />
          </fieldset>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            isDisabled={retrieveBlocked || indexes.isError || !query.trim()}
            onPress={() => submitRetrieve()}
          >
            Retrieve
          </Button>
          <Button
            size="sm"
            variant="outline"
            isDisabled={prepareBlocked || indexes.isError || !query.trim()}
            onPress={() => submitPrepare()}
          >
            Prepare context
          </Button>
        </div>
      </Card>
      {retrieveResult ? (
        <Card className="flex flex-col gap-2">
          <p className="text-xs text-fg-muted">
            Current content; may differ from the search result.
          </p>
          <ol className="flex flex-col gap-3">
            {retrieveResult.selected.map((row) => {
              const entry =
                row.reference.scopeId === currentPageScopeId
                  ? currentEntries.find((candidate) => candidate.id === row.reference.objectId)
                  : undefined;
              const entryDisplay = entry
                ? readKnowledgePageDisplay(entry.path, entry.content)
                : null;
              return (
                <li
                  key={`${row.reference.scopeId}:${row.reference.objectId}`}
                  className="flex flex-col gap-1"
                >
                  <p className="text-xs text-fg-muted">{row.reference.objectId}</p>
                  {entry && entryDisplay ? (
                    <>
                      <p className="text-sm font-bold text-fg-strong">{entryDisplay.title}</p>
                      <p className="text-sm text-fg">
                        {entryDisplay.body.length > 240
                          ? `${entryDisplay.body.slice(0, 240)}…`
                          : entryDisplay.body}
                      </p>
                      <Link
                        aria-label={`View current content: ${entryDisplay.title}`}
                        href={`#${encodeURIComponent(knowledgeContentId(workspaceId, entry.id))}`}
                        className="text-sm text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        View current content
                      </Link>
                    </>
                  ) : (
                    <p className="text-sm text-fg-muted">Current content unavailable.</p>
                  )}
                </li>
              );
            })}
          </ol>
          {retrieveResult.excluded.map((row) => (
            <p
              key={`${row.reference.scopeId}:${row.reference.objectId}:${row.reason}`}
              className="text-xs text-fg-muted"
            >
              {EXCLUSION_REASON_LABEL[row.reason]}
            </p>
          ))}
        </Card>
      ) : null}
      {prepareResult ? <p className="text-sm text-fg">{prepareResult.outcome}</p> : null}
    </section>
  );
}

function KnowledgeManagerPanel({
  workspaceId,
  connectionBlocked,
  knowledgeBaseId,
  currentEntries,
}: {
  workspaceId: string | null;
  connectionBlocked: boolean;
  knowledgeBaseId: string | undefined;
  currentEntries: KnowledgeNotebookPage[];
}) {
  const answer = useAnswerKnowledgeManager();
  const suggest = useSuggestKnowledgeRepairs();
  const health = useCheckKnowledgeHealth();
  const [question, setQuestion] = useWorkspaceScoped(workspaceId, '');
  const answerBlocked = connectionBlocked || !workspaceId || answer.isPending;
  const suggestBlocked = connectionBlocked || !workspaceId || suggest.isPending;
  const healthBlocked = connectionBlocked || !workspaceId || health.isPending;

  /** Answer one Knowledge Manager question for the current Workspace. */
  function submitAnswer(command?: AnswerKnowledgeManagerCommand) {
    const next =
      command ??
      (workspaceId && question.trim()
        ? { workspaceId, input: { query: question.trim() } }
        : undefined);
    if (!next || answerBlocked) return;
    answer.mutate(next);
  }

  /** Request review-required repair suggestions for the current Workspace. */
  function submitSuggest(command?: SuggestKnowledgeRepairsCommand) {
    const next = command ?? (workspaceId ? { workspaceId, input: { limit: 10 } } : undefined);
    if (!next || suggestBlocked) return;
    suggest.mutate(next);
  }

  /** Inspect Knowledge Store health for the current Workspace. */
  function submitHealth(command?: CheckKnowledgeHealthCommand) {
    const next = command ?? (workspaceId ? { workspaceId, input: { limit: 10 } } : undefined);
    if (!next || healthBlocked) return;
    health.mutate(next);
  }

  const failedAnswer =
    answer.isError && matchesWorkspace(workspaceId, answer.variables?.workspaceId)
      ? answer.variables
      : undefined;
  const failedSuggest =
    suggest.isError && matchesWorkspace(workspaceId, suggest.variables?.workspaceId)
      ? suggest.variables
      : undefined;
  const failedHealth =
    health.isError && matchesWorkspace(workspaceId, health.variables?.workspaceId)
      ? health.variables
      : undefined;
  const answerResult =
    answer.isSuccess && matchesWorkspace(workspaceId, answer.variables?.workspaceId)
      ? answer.data
      : null;
  const suggestResult =
    suggest.isSuccess && matchesWorkspace(workspaceId, suggest.variables?.workspaceId)
      ? suggest.data
      : null;
  const healthResult =
    health.isSuccess && matchesWorkspace(workspaceId, health.variables?.workspaceId)
      ? health.data
      : null;

  return (
    <section aria-label="Manager" className="flex flex-col gap-2">
      <Eyebrow>Manager</Eyebrow>
      <Card className="flex flex-col gap-3">
        <TextField
          label="Question"
          value={question}
          onChange={setQuestion}
          isDisabled={connectionBlocked}
        />
        {failedAnswer ? (
          <fieldset disabled={answerBlocked} className="contents">
            <ErrorBanner
              message={knowledgeActionErrorMessage(answer.error, "Couldn't answer.")}
              onRetry={() => submitAnswer(failedAnswer)}
            />
          </fieldset>
        ) : null}
        {failedSuggest ? (
          <fieldset disabled={suggestBlocked} className="contents">
            <ErrorBanner
              message={knowledgeActionErrorMessage(suggest.error, "Couldn't suggest repairs.")}
              onRetry={() => submitSuggest(failedSuggest)}
            />
          </fieldset>
        ) : null}
        {failedHealth ? (
          <fieldset disabled={healthBlocked} className="contents">
            <ErrorBanner
              message={knowledgeActionErrorMessage(health.error, "Couldn't check health.")}
              onRetry={() => submitHealth(failedHealth)}
            />
          </fieldset>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            isDisabled={answerBlocked || !question.trim()}
            onPress={() => submitAnswer()}
          >
            Answer
          </Button>
          <Button
            size="sm"
            variant="outline"
            isDisabled={suggestBlocked}
            onPress={() => submitSuggest()}
          >
            Suggest repairs
          </Button>
          <Button
            size="sm"
            variant="outline"
            isDisabled={healthBlocked}
            onPress={() => submitHealth()}
          >
            Check health
          </Button>
        </div>
      </Card>
      {answerResult ? (
        <Card className="flex flex-col gap-2">
          <p className="text-sm text-fg">{answerResult.answer}</p>
          {answerResult.uncertainty !== null ? (
            <p className="text-sm text-fg">{answerResult.uncertainty}</p>
          ) : null}
          {answerResult.citations.length ? (
            <ol aria-label="Citations" className="flex flex-col gap-2">
              {answerResult.citations.map((citation) => {
                const evidence = readKnowledgeCitationEvidence(citation);
                const showEvidence = shouldShowKnowledgeCitationEvidence(
                  citation.reference.scopeId,
                  evidence
                );
                const entry =
                  workspaceId &&
                  knowledgeBaseId &&
                  matchesWorkspaceKnowledgePageReference(
                    citation.reference.scopeId,
                    workspaceId,
                    knowledgeBaseId
                  )
                    ? currentEntries.find(
                        (candidate) => candidate.id === citation.reference.objectId
                      )
                    : undefined;
                const entryDisplay = entry
                  ? readKnowledgePageDisplay(entry.path, entry.content)
                  : null;
                return (
                  <li key={`${citation.reference.scopeId}:${citation.reference.objectId}`}>
                    <p className="text-sm font-bold text-fg-strong">{citation.title}</p>
                    <p className="text-xs text-fg-muted">
                      {knowledgePageScopeLabel(citation.reference.scopeId)}
                    </p>
                    {showEvidence && evidence.revision ? (
                      <p className="text-xs text-fg-muted">
                        Notebook revision: {evidence.revision}
                      </p>
                    ) : null}
                    {showEvidence && evidence.contentDigest ? (
                      <p className="text-xs text-fg-muted">
                        Content digest: {evidence.contentDigest}
                      </p>
                    ) : null}
                    {evidence.referenceUri ? (
                      <p className="text-xs text-fg-muted">{evidence.referenceUri}</p>
                    ) : null}
                    <p className="text-sm text-fg">{citation.excerpt}</p>
                    {entry && entryDisplay ? (
                      <Link
                        aria-label={`View current content: ${entryDisplay.title}`}
                        href={`#${encodeURIComponent(knowledgeContentId(workspaceId, entry.id))}`}
                        className="text-sm text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        View current content
                      </Link>
                    ) : (
                      <p className="text-xs text-fg-muted">Current content unavailable.</p>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </Card>
      ) : null}
      {suggestResult
        ? suggestResult.suggestions.map((row) => (
            <p key={row.id} className="text-sm text-fg">
              {row.title}
            </p>
          ))
        : null}
      {healthResult ? <p className="text-sm text-fg">{healthResult.summary}</p> : null}
    </section>
  );
}
