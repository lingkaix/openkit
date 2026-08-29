import { createRequestId } from '@openkit/core-client';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  StatusChip,
  type StatusChipProps,
  TextField,
} from '../../primitives';
import {
  type AnswerKnowledgeManagerCommand,
  type AttentionRow,
  type CheckKnowledgeHealthCommand,
  type CreateKnowledgeCommand,
  type DeleteKnowledgeCommand,
  type KnowledgeItem,
  type KnowledgeProposalDecision,
  type KnowledgeProposalDecisionInput,
  type KnowledgeStoreProjection,
  knowledgeActionErrorMessage,
  type PrepareKnowledgeContextCommand,
  type ReadKnowledgeSourceCommand,
  type RecordKnowledgeClaimCommand,
  type RecordKnowledgeConflictCommand,
  type RecordKnowledgeObservationCommand,
  type RegisterKnowledgeSourceCommand,
  type ResolveKnowledgeConflictCommand,
  type RetrieveKnowledgeCommand,
  type SuggestKnowledgeRepairsCommand,
  type UpdateKnowledgeCommand,
  useAnswerKnowledgeManager,
  useCheckKnowledgeHealth,
  useCreateKnowledge,
  useCurrentWorkspaceId,
  useDeleteKnowledge,
  useHumanAttention,
  useKnowledge,
  useKnowledgeClaims,
  useKnowledgeConflicts,
  useKnowledgeIndexes,
  useKnowledgeObservations,
  useKnowledgeSources,
  usePrepareKnowledgeContext,
  useReadKnowledgeSource,
  useRecordKnowledgeClaim,
  useRecordKnowledgeConflict,
  useRecordKnowledgeObservation,
  useRegisterKnowledgeSource,
  useResolveKnowledgeConflict,
  useRetrieveKnowledge,
  useSubmitKnowledgeProposalDecision,
  useSuggestKnowledgeRepairs,
  useUpdateKnowledge,
  workspaceKeys,
} from './data';

const KIND_LABEL: Record<KnowledgeItem['kind'], string> = {
  preference: 'Preferences',
  'project-context': 'Project context',
  'task-summary': 'Task summaries',
};

const SOURCE_KIND_LABEL = {
  upload: 'Upload',
  url: 'Web link',
  document: 'Document',
  transcript: 'Transcript',
  code: 'Code',
} satisfies Record<KnowledgeStoreProjection['sources'][number]['kind'], string>;

const OBSERVATION_KIND_LABEL = {
  retrieval: 'Retrieval',
  source: 'Source',
  maintenance: 'Maintenance',
  agent: 'Agent',
  'user-feedback': 'User feedback',
} satisfies Record<KnowledgeStoreProjection['observations'][number]['kind'], string>;

const OBSERVATION_STATUS_LABEL = {
  retained: 'Retained',
  promoted: 'Promoted',
  expired: 'Expired',
  archived: 'Archived',
} satisfies Record<KnowledgeStoreProjection['observations'][number]['status'], string>;

const CLAIM_REVIEW_STATUS = {
  'needs-review': { label: 'Needs review', tone: 'notice' },
  accepted: { label: 'Approved', tone: 'positive' },
  rejected: { label: 'Rejected', tone: 'negative' },
  deferred: { label: 'Paused', tone: 'neutral' },
} satisfies Record<
  KnowledgeStoreProjection['claims'][number]['reviewState'],
  { label: string; tone: StatusChipProps['tone'] }
>;

const CLAIM_CONFLICT_STATUS_LABEL = {
  none: 'No conflict',
  conflicting: 'Conflicting',
  weak_evidence: 'Weak evidence',
  stale: 'Stale',
  superseded: 'Superseded',
  partially_superseded: 'Partially superseded',
} satisfies Record<KnowledgeStoreProjection['claims'][number]['conflictStatus'], string>;

const DERIVED_KIND_LABEL = {
  text: 'Text',
} as const;

const EXCLUSION_REASON_LABEL = {
  sensitive_content: 'Sensitive content',
  lower_conformance: 'Lower conformance',
  policy_excluded: 'Policy excluded',
  freshness_expired: 'Out of date',
  budget_exceeded: 'Over budget',
  source_unavailable: 'Source unavailable',
} as const;

const SOURCE_KIND_ITEMS = Object.entries(SOURCE_KIND_LABEL).map(([id, label]) => ({ id, label }));
const OBSERVATION_KIND_ITEMS = Object.entries(OBSERVATION_KIND_LABEL).map(([id, label]) => ({
  id,
  label,
}));

/** Map one exact supported POST action to the Knowledge decision contract. */
function proposalDecisionForAction(
  action: AttentionRow['actions'][number]
): KnowledgeProposalDecision | null {
  if (action.method !== 'POST') return null;
  switch (action.kind) {
    case 'accept_knowledge':
      return 'accepted';
    case 'reject_knowledge':
      return 'rejected';
    case 'defer':
      return 'deferred';
    default:
      return null;
  }
}

function isSourceKind(value: string): value is keyof typeof SOURCE_KIND_LABEL {
  return Object.hasOwn(SOURCE_KIND_LABEL, value);
}

function isObservationKind(value: string): value is keyof typeof OBSERVATION_KIND_LABEL {
  return Object.hasOwn(OBSERVATION_KIND_LABEL, value);
}

function splitReferences(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

type ObservationDraft = {
  kind: string | null;
  summary: string;
  producer: string;
};

const EMPTY_OBSERVATION_DRAFT: ObservationDraft = { kind: null, summary: '', producer: '' };

type ClaimDraft = {
  statement: string;
  producer: string;
};

const EMPTY_CLAIM_DRAFT: ClaimDraft = { statement: '', producer: '' };

type ConflictDraft = {
  summary: string;
  subjectReferences: string;
  producer: string;
};

const EMPTY_CONFLICT_DRAFT: ConflictDraft = {
  summary: '',
  subjectReferences: '',
  producer: '',
};

type ResolveDraft = {
  conflictId: string | null;
  resolution: string;
  resolvedBy: string;
};

const EMPTY_RESOLVE_DRAFT: ResolveDraft = { conflictId: null, resolution: '', resolvedBy: '' };

type AddDraft = {
  adding: boolean;
  title: string;
  content: string;
};

const EMPTY_ADD_DRAFT: AddDraft = { adding: false, title: '', content: '' };

type EditDraft = {
  entry: KnowledgeItem | null;
  title: string;
  content: string;
};

const EMPTY_EDIT_DRAFT: EditDraft = { entry: null, title: '', content: '' };

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
  const observationsCatalog = useKnowledgeObservations(workspaceId);
  const claimsCatalog = useKnowledgeClaims(workspaceId);
  const conflictsCatalog = useKnowledgeConflicts(workspaceId);
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
  const editing = editDraft.entry;
  const writePending =
    create.isPending || update.isPending || remove.isPending || proposalDecision.isPending;
  const entryWriteBlocked =
    checking || failed || writePending || knowledge.isError || knowledge.isFetching || !workspaceId;
  const proposalWriteBlocked = entryWriteBlocked || attention.isFetching || attention.isError;
  const connectionBlocked = checking || failed;
  const pagePending =
    !workspaceId ||
    knowledge.isPending ||
    sourcesCatalog.isPending ||
    observationsCatalog.isPending ||
    claimsCatalog.isPending ||
    conflictsCatalog.isPending ||
    indexesCatalog.isPending;

  function resetForm(targetId: string) {
    clearAddDraft(targetId);
    if (create.variables?.workspaceId === targetId) create.reset();
  }

  function settleEdit(targetId: string) {
    clearEditDraft(targetId);
    if (update.variables?.workspaceId === targetId) update.reset();
  }

  /** Create one entry, or replay the exact Workspace-bound command after unknown failure. */
  function save(command?: CreateKnowledgeCommand) {
    const next =
      command ??
      (workspaceId && addDraft.title.trim() && addDraft.content.trim()
        ? {
            workspaceId,
            input: {
              requestId: createRequestId(),
              kind: 'preference' as const,
              title: addDraft.title.trim(),
              content: addDraft.content.trim(),
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

  /** Prefill the edit form from one exact authoritative entry. */
  function startEditing(entry: KnowledgeItem) {
    setEditDraft({ entry, title: entry.title, content: entry.content });
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
      if (!workspaceId || !editing) return;
      const titleChanged = editDraft.title !== editing.title;
      const contentChanged = editDraft.content !== editing.content;
      const nextTitle = editDraft.title.trim();
      const nextContent = editDraft.content.trim();
      if (
        (!titleChanged && !contentChanged) ||
        (titleChanged && !nextTitle) ||
        (contentChanged && !nextContent)
      )
        return;
      next = {
        workspaceId,
        knowledgeEntryId: editing.id,
        input: {
          requestId: createRequestId(),
          ...(titleChanged ? { title: nextTitle } : {}),
          ...(contentChanged ? { content: nextContent } : {}),
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

  /** Delete one entry, then refresh only through the authoritative Knowledge read. */
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

  const editCanSave = Boolean(
    editing &&
      (editDraft.title !== editing.title || editDraft.content !== editing.content) &&
      (editDraft.title === editing.title || editDraft.title.trim()) &&
      (editDraft.content === editing.content || editDraft.content.trim())
  );

  const entries = knowledge.data ?? [];
  const byKind = groupByKind(entries);
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
              onPress={() => setAddDraft((current) => ({ ...current, adding: true }))}
            >
              Add knowledge
            </Button>
          }
        />
      )}
      <div className={pagePending ? 'hidden' : undefined}>
        {addDraft.adding ? (
          <Card className="flex flex-col gap-3">
            <Eyebrow>New preference</Eyebrow>
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
                isDisabled={entryWriteBlocked || !addDraft.title.trim() || !addDraft.content.trim()}
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
        ) : knowledge.data === undefined ? null : entries.length === 0 && !addDraft.adding ? (
          <EmptyState
            icon="book"
            title="No entries yet"
            hint="Add a preference or project context so agents start with what you already know."
          />
        ) : (
          Object.entries(byKind).map(([kind, items]) =>
            items.length === 0 ? null : (
              <section key={kind} className="flex flex-col gap-2">
                <Eyebrow>{KIND_LABEL[kind as KnowledgeItem['kind']]}</Eyebrow>
                <Card className="p-0 px-4">
                  {items.map((entry) => (
                    <ListRow key={entry.id}>
                      <div className="min-w-0 flex-1 py-1">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-fg-strong">{entry.title}</p>
                            <p className="mt-0.5 text-xs text-fg-muted">{entry.content}</p>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <Button
                              size="sm"
                              variant="quiet"
                              aria-label={`Edit ${entry.title}`}
                              isDisabled={entryWriteBlocked}
                              onPress={() => startEditing(entry)}
                            >
                              {'Edit '}
                            </Button>
                            <Modal
                              trigger={
                                <Button
                                  size="sm"
                                  variant="negative-outline"
                                  aria-label={`Remove ${entry.title}`}
                                  isDisabled={entryWriteBlocked}
                                >
                                  {'Remove '}
                                </Button>
                              }
                            >
                              <Dialog title="Remove knowledge">
                                <p className="text-sm text-fg-muted">
                                  This removes the entry from the workspace knowledge store.
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
                                      if (!workspaceId) return;
                                      removeEntry({
                                        workspaceId,
                                        knowledgeEntryId: entry.id,
                                        input: { requestId: createRequestId() },
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
                        {editing?.id === entry.id ? (
                          <div className="mt-3 flex flex-col gap-3 border-t border-separator pt-3">
                            <TextField
                              label="Title"
                              value={editDraft.title}
                              onChange={(title) =>
                                setEditDraft((current) => ({ ...current, title }))
                              }
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
                  ))}
                </Card>
              </section>
            )
          )
        )}

        <KnowledgeSourcesPanel connectionBlocked={connectionBlocked} workspaceId={workspaceId} />
        <KnowledgeLedgerPanel connectionBlocked={connectionBlocked} workspaceId={workspaceId} />
        <KnowledgeRetrievalPanel connectionBlocked={connectionBlocked} workspaceId={workspaceId} />
        <KnowledgeManagerPanel connectionBlocked={connectionBlocked} workspaceId={workspaceId} />

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
                  onRetry={() => submitProposalDecision(failedProposalDecision)}
                />
              </fieldset>
            ) : null}
            <Card className="p-0 px-4">
              {knowledgeProposals.map((row) => {
                const source = row.source;
                if (source.type !== 'knowledge') return null;
                return (
                  <ListRow key={row.id}>
                    <div className="min-w-0 flex-1 py-1">
                      <p className="text-sm font-bold text-fg-strong">{row.title}</p>
                      <p className="mt-0.5 text-xs text-fg-muted">{row.summary}</p>
                    </div>
                    <div className="flex shrink-0 items-start gap-2">
                      {row.actions.map((action) => {
                        const decision = proposalDecisionForAction(action);
                        if (!decision) return null;
                        return (
                          <div key={action.kind} className="flex flex-col items-start gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              isDisabled={proposalWriteBlocked || action.disabled === true}
                              onPress={() => submitProposalDecision({ source, decision })}
                            >
                              {action.label}
                            </Button>
                            {action.reason ? (
                              <p className="max-w-64 text-xs text-fg-muted">{action.reason}</p>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </ListRow>
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

function KnowledgeLedgerPanel({
  workspaceId,
  connectionBlocked,
}: {
  workspaceId: string | null;
  connectionBlocked: boolean;
}) {
  const queryClient = useQueryClient();
  const observations = useKnowledgeObservations(workspaceId);
  const claims = useKnowledgeClaims(workspaceId);
  const conflicts = useKnowledgeConflicts(workspaceId);
  const recordObservation = useRecordKnowledgeObservation();
  const recordClaim = useRecordKnowledgeClaim();
  const recordConflict = useRecordKnowledgeConflict();
  const resolveConflict = useResolveKnowledgeConflict();
  const [observationDraft, setObservationDraft, clearObservationDraft] = useWorkspaceScoped(
    workspaceId,
    EMPTY_OBSERVATION_DRAFT
  );
  const [claimDraft, setClaimDraft, clearClaimDraft] = useWorkspaceScoped(
    workspaceId,
    EMPTY_CLAIM_DRAFT
  );
  const [conflictDraft, setConflictDraft, clearConflictDraft] = useWorkspaceScoped(
    workspaceId,
    EMPTY_CONFLICT_DRAFT
  );
  const [resolveDraft, setResolveDraft, clearResolveDraft] = useWorkspaceScoped(
    workspaceId,
    EMPTY_RESOLVE_DRAFT
  );
  const [awaitingObservation, setAwaitingObservation] = useState<Record<string, true>>({});
  const [awaitingClaim, setAwaitingClaim] = useState<Record<string, true>>({});
  const [awaitingConflict, setAwaitingConflict] = useState<Record<string, true>>({});
  const [awaitingResolve, setAwaitingResolve] = useState<Record<string, true>>({});
  const observationFieldBlocked = connectionBlocked || !workspaceId || observations.isFetching;
  const claimFieldBlocked = connectionBlocked || !workspaceId || claims.isFetching;
  const conflictFieldBlocked = connectionBlocked || !workspaceId || conflicts.isFetching;
  const resolveFieldBlocked = connectionBlocked || !workspaceId || conflicts.isFetching;
  const observationSubmitBlocked =
    observationFieldBlocked ||
    recordObservation.isPending ||
    observations.isError ||
    Boolean(workspaceId && awaitingObservation[workspaceId]) ||
    (recordObservation.isSuccess &&
      matchesWorkspace(workspaceId, recordObservation.variables?.workspaceId));
  const claimSubmitBlocked =
    claimFieldBlocked ||
    recordClaim.isPending ||
    claims.isError ||
    Boolean(workspaceId && awaitingClaim[workspaceId]) ||
    (recordClaim.isSuccess && matchesWorkspace(workspaceId, recordClaim.variables?.workspaceId));
  const conflictSubmitBlocked =
    conflictFieldBlocked ||
    recordConflict.isPending ||
    conflicts.isError ||
    Boolean(workspaceId && awaitingConflict[workspaceId]) ||
    (recordConflict.isSuccess &&
      matchesWorkspace(workspaceId, recordConflict.variables?.workspaceId));
  const resolveSubmitBlocked =
    resolveFieldBlocked ||
    resolveConflict.isPending ||
    conflicts.isError ||
    Boolean(workspaceId && awaitingResolve[workspaceId]) ||
    (resolveConflict.isSuccess &&
      matchesWorkspace(workspaceId, resolveConflict.variables?.workspaceId));
  const parsedSubjectReferences = splitReferences(conflictDraft.subjectReferences);
  const conflictItems = (conflicts.data ?? []).map((conflict) => ({
    id: conflict.id,
    label: conflict.summary,
  }));

  function settleObservation(targetId: string) {
    clearObservationDraft(targetId);
    setAwaitingObservation((current) => omitWorkspaceFlag(current, targetId));
    if (recordObservation.variables?.workspaceId === targetId) recordObservation.reset();
  }

  function settleClaim(targetId: string) {
    clearClaimDraft(targetId);
    setAwaitingClaim((current) => omitWorkspaceFlag(current, targetId));
    if (recordClaim.variables?.workspaceId === targetId) recordClaim.reset();
  }

  function settleConflict(targetId: string) {
    clearConflictDraft(targetId);
    setAwaitingConflict((current) => omitWorkspaceFlag(current, targetId));
    if (recordConflict.variables?.workspaceId === targetId) recordConflict.reset();
  }

  function settleResolve(targetId: string) {
    clearResolveDraft(targetId);
    setAwaitingResolve((current) => omitWorkspaceFlag(current, targetId));
    if (resolveConflict.variables?.workspaceId === targetId) resolveConflict.reset();
  }

  /** Append one observation, then wait for the authoritative observation list. */
  function submitObservation(command?: RecordKnowledgeObservationCommand) {
    const next =
      command ??
      (workspaceId &&
      observationDraft.kind &&
      isObservationKind(observationDraft.kind) &&
      observationDraft.summary.trim() &&
      observationDraft.producer.trim()
        ? {
            workspaceId,
            input: {
              requestId: createRequestId(),
              kind: observationDraft.kind,
              summary: observationDraft.summary.trim(),
              sourceReferences: [],
              scope: 'workspace',
              producer: observationDraft.producer.trim(),
              confidence: 0.5,
              freshness: 'current' as const,
              status: 'retained' as const,
            },
          }
        : undefined);
    if (!next || (!command && observationSubmitBlocked)) return;
    if (command && (observationFieldBlocked || recordObservation.isPending)) return;
    recordObservation.mutate(next, {
      onSuccess: async (_data, settled) => {
        setAwaitingObservation((current) => ({ ...current, [settled.workspaceId]: true }));
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.knowledgeObservations(settled.workspaceId),
          () => settleObservation(settled.workspaceId)
        );
      },
    });
  }

  /** Append one claim, then wait for the authoritative claim list. */
  function submitClaim(command?: RecordKnowledgeClaimCommand) {
    const next =
      command ??
      (workspaceId && claimDraft.statement.trim() && claimDraft.producer.trim()
        ? {
            workspaceId,
            input: {
              requestId: createRequestId(),
              statement: claimDraft.statement.trim(),
              producer: claimDraft.producer.trim(),
            },
          }
        : undefined);
    if (!next || (!command && claimSubmitBlocked)) return;
    if (command && (claimFieldBlocked || recordClaim.isPending)) return;
    recordClaim.mutate(next, {
      onSuccess: async (_data, settled) => {
        setAwaitingClaim((current) => ({ ...current, [settled.workspaceId]: true }));
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.knowledgeClaims(settled.workspaceId),
          () => settleClaim(settled.workspaceId)
        );
      },
    });
  }

  /** Append one conflict, then wait for the authoritative conflict list. */
  function submitConflict(command?: RecordKnowledgeConflictCommand) {
    const next =
      command ??
      (workspaceId &&
      conflictDraft.summary.trim() &&
      parsedSubjectReferences.length &&
      conflictDraft.producer.trim()
        ? {
            workspaceId,
            input: {
              requestId: createRequestId(),
              summary: conflictDraft.summary.trim(),
              subjectReferences: parsedSubjectReferences,
              producer: conflictDraft.producer.trim(),
            },
          }
        : undefined);
    if (!next || (!command && conflictSubmitBlocked)) return;
    if (command && (conflictFieldBlocked || recordConflict.isPending)) return;
    recordConflict.mutate(next, {
      onSuccess: async (_data, settled) => {
        setAwaitingConflict((current) => ({ ...current, [settled.workspaceId]: true }));
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.knowledgeConflicts(settled.workspaceId),
          () => settleConflict(settled.workspaceId)
        );
      },
    });
  }

  /** Resolve one listed conflict, then wait for the authoritative conflict list. */
  function submitResolve(command?: ResolveKnowledgeConflictCommand) {
    const next =
      command ??
      (workspaceId &&
      resolveDraft.conflictId &&
      resolveDraft.resolution.trim() &&
      resolveDraft.resolvedBy.trim()
        ? {
            workspaceId,
            conflictId: resolveDraft.conflictId,
            input: {
              requestId: createRequestId(),
              resolution: resolveDraft.resolution.trim(),
              resolvedBy: resolveDraft.resolvedBy.trim(),
            },
          }
        : undefined);
    if (!next || (!command && resolveSubmitBlocked)) return;
    if (command && (resolveFieldBlocked || resolveConflict.isPending)) return;
    resolveConflict.mutate(next, {
      onSuccess: async (_data, settled) => {
        setAwaitingResolve((current) => ({ ...current, [settled.workspaceId]: true }));
        await refetchWorkspaceCatalog(
          queryClient,
          workspaceKeys.knowledgeConflicts(settled.workspaceId),
          () => settleResolve(settled.workspaceId)
        );
      },
    });
  }

  async function retryObservationsCatalog() {
    const result = await observations.refetch();
    if (
      result.isSuccess &&
      workspaceId &&
      recordObservation.isSuccess &&
      matchesWorkspace(workspaceId, recordObservation.variables?.workspaceId)
    ) {
      settleObservation(workspaceId);
    }
  }

  async function retryClaimsCatalog() {
    const result = await claims.refetch();
    if (
      result.isSuccess &&
      workspaceId &&
      recordClaim.isSuccess &&
      matchesWorkspace(workspaceId, recordClaim.variables?.workspaceId)
    ) {
      settleClaim(workspaceId);
    }
  }

  async function retryConflictsCatalog() {
    const result = await conflicts.refetch();
    if (!result.isSuccess || !workspaceId) return;
    if (
      recordConflict.isSuccess &&
      matchesWorkspace(workspaceId, recordConflict.variables?.workspaceId)
    ) {
      settleConflict(workspaceId);
    }
    if (
      resolveConflict.isSuccess &&
      matchesWorkspace(workspaceId, resolveConflict.variables?.workspaceId)
    ) {
      settleResolve(workspaceId);
    }
  }

  const failedObservation =
    recordObservation.isError &&
    matchesWorkspace(workspaceId, recordObservation.variables?.workspaceId)
      ? recordObservation.variables
      : undefined;
  const failedClaim =
    recordClaim.isError && matchesWorkspace(workspaceId, recordClaim.variables?.workspaceId)
      ? recordClaim.variables
      : undefined;
  const failedConflict =
    recordConflict.isError && matchesWorkspace(workspaceId, recordConflict.variables?.workspaceId)
      ? recordConflict.variables
      : undefined;
  const failedResolve =
    resolveConflict.isError && matchesWorkspace(workspaceId, resolveConflict.variables?.workspaceId)
      ? resolveConflict.variables
      : undefined;

  return (
    <section aria-label="Ledger" className="flex flex-col gap-2">
      <Eyebrow>Ledger</Eyebrow>
      {observations.isError ? (
        <fieldset disabled={connectionBlocked || observations.isFetching} className="contents">
          <ErrorBanner
            message={knowledgeActionErrorMessage(observations.error, "Couldn't load observations.")}
            onRetry={() => void retryObservationsCatalog()}
          />
        </fieldset>
      ) : null}
      {claims.isError ? (
        <fieldset disabled={connectionBlocked || claims.isFetching} className="contents">
          <ErrorBanner
            message={knowledgeActionErrorMessage(claims.error, "Couldn't load claims.")}
            onRetry={() => void retryClaimsCatalog()}
          />
        </fieldset>
      ) : null}
      {conflicts.isError ? (
        <fieldset disabled={connectionBlocked || conflicts.isFetching} className="contents">
          <ErrorBanner
            message={knowledgeActionErrorMessage(conflicts.error, "Couldn't load conflicts.")}
            onRetry={() => void retryConflictsCatalog()}
          />
        </fieldset>
      ) : null}
      <Card className="flex flex-col gap-3">
        <Select
          label="Observation kind"
          placeholder={
            observationDraft.kind && isObservationKind(observationDraft.kind)
              ? OBSERVATION_KIND_LABEL[observationDraft.kind]
              : 'Select…'
          }
          items={OBSERVATION_KIND_ITEMS}
          selectedKey={observationDraft.kind ?? null}
          isDisabled={observationFieldBlocked}
          onSelectionChange={(key) =>
            setObservationDraft((current) => ({
              ...current,
              kind: key == null ? null : String(key),
            }))
          }
        />
        <TextField
          label="Observation summary"
          value={observationDraft.summary}
          onChange={(summary) => setObservationDraft((current) => ({ ...current, summary }))}
          isDisabled={observationFieldBlocked}
        />
        <TextField
          label="Observation producer"
          value={observationDraft.producer}
          onChange={(producer) => setObservationDraft((current) => ({ ...current, producer }))}
          isDisabled={observationFieldBlocked}
        />
        {failedObservation ? (
          <fieldset
            disabled={observationFieldBlocked || recordObservation.isPending}
            className="contents"
          >
            <ErrorBanner
              message={knowledgeActionErrorMessage(
                recordObservation.error,
                "Couldn't record that observation."
              )}
              onRetry={() => submitObservation(failedObservation)}
            />
          </fieldset>
        ) : null}
        <Button
          size="sm"
          isDisabled={
            observationSubmitBlocked ||
            !observationDraft.kind ||
            !isObservationKind(observationDraft.kind) ||
            !observationDraft.summary.trim() ||
            !observationDraft.producer.trim()
          }
          onPress={() => submitObservation()}
        >
          Record observation
        </Button>
      </Card>
      <Card className="flex flex-col gap-3">
        <TextField
          label="Claim statement"
          value={claimDraft.statement}
          onChange={(statement) => setClaimDraft((current) => ({ ...current, statement }))}
          isDisabled={claimFieldBlocked}
        />
        <TextField
          label="Claim producer"
          value={claimDraft.producer}
          onChange={(producer) => setClaimDraft((current) => ({ ...current, producer }))}
          isDisabled={claimFieldBlocked}
        />
        {failedClaim ? (
          <fieldset disabled={claimFieldBlocked || recordClaim.isPending} className="contents">
            <ErrorBanner
              message={knowledgeActionErrorMessage(
                recordClaim.error,
                "Couldn't record that claim."
              )}
              onRetry={() => submitClaim(failedClaim)}
            />
          </fieldset>
        ) : null}
        <Button
          size="sm"
          isDisabled={
            claimSubmitBlocked || !claimDraft.statement.trim() || !claimDraft.producer.trim()
          }
          onPress={() => submitClaim()}
        >
          Record claim
        </Button>
      </Card>
      <Card className="flex flex-col gap-3">
        <TextField
          label="Conflict summary"
          value={conflictDraft.summary}
          onChange={(summary) => setConflictDraft((current) => ({ ...current, summary }))}
          isDisabled={conflictFieldBlocked}
        />
        <TextField
          label="Subject references"
          value={conflictDraft.subjectReferences}
          onChange={(subjectReferences) =>
            setConflictDraft((current) => ({ ...current, subjectReferences }))
          }
          isDisabled={conflictFieldBlocked}
        />
        <TextField
          label="Conflict producer"
          value={conflictDraft.producer}
          onChange={(producer) => setConflictDraft((current) => ({ ...current, producer }))}
          isDisabled={conflictFieldBlocked}
        />
        {failedConflict ? (
          <fieldset
            disabled={conflictFieldBlocked || recordConflict.isPending}
            className="contents"
          >
            <ErrorBanner
              message={knowledgeActionErrorMessage(
                recordConflict.error,
                "Couldn't record that conflict."
              )}
              onRetry={() => submitConflict(failedConflict)}
            />
          </fieldset>
        ) : null}
        <Button
          size="sm"
          isDisabled={
            conflictSubmitBlocked ||
            !conflictDraft.summary.trim() ||
            parsedSubjectReferences.length === 0 ||
            !conflictDraft.producer.trim()
          }
          onPress={() => submitConflict()}
        >
          Record conflict
        </Button>
      </Card>
      <Card className="flex flex-col gap-3">
        <Select
          label="Conflict"
          placeholder={
            conflictItems.find((item) => item.id === resolveDraft.conflictId)?.label ?? 'Select…'
          }
          items={conflictItems}
          selectedKey={resolveDraft.conflictId ?? null}
          isDisabled={resolveFieldBlocked || conflictItems.length === 0}
          onSelectionChange={(key) =>
            setResolveDraft((current) => ({
              ...current,
              conflictId: key == null ? null : String(key),
            }))
          }
        />
        <TextField
          label="Resolution"
          value={resolveDraft.resolution}
          onChange={(resolution) => setResolveDraft((current) => ({ ...current, resolution }))}
          isDisabled={resolveFieldBlocked}
        />
        <TextField
          label="Resolved by"
          value={resolveDraft.resolvedBy}
          onChange={(resolvedBy) => setResolveDraft((current) => ({ ...current, resolvedBy }))}
          isDisabled={resolveFieldBlocked}
        />
        {failedResolve ? (
          <fieldset
            disabled={resolveFieldBlocked || resolveConflict.isPending}
            className="contents"
          >
            <ErrorBanner
              message={knowledgeActionErrorMessage(
                resolveConflict.error,
                "Couldn't resolve that conflict."
              )}
              onRetry={() => submitResolve(failedResolve)}
            />
          </fieldset>
        ) : null}
        <Button
          size="sm"
          isDisabled={
            resolveSubmitBlocked ||
            !resolveDraft.conflictId ||
            !resolveDraft.resolution.trim() ||
            !resolveDraft.resolvedBy.trim()
          }
          onPress={() => submitResolve()}
        >
          Resolve conflict
        </Button>
      </Card>
      {observations.data && observations.data.length > 0 ? (
        <Card className="p-0 px-4">
          {observations.data.map((observation) => (
            <ListRow key={observation.id}>
              <div className="min-w-0 flex-1 py-1">
                <p className="text-sm text-fg-strong">{observation.summary}</p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {OBSERVATION_STATUS_LABEL[observation.status]}
                </p>
              </div>
            </ListRow>
          ))}
        </Card>
      ) : null}
      {claims.data && claims.data.length > 0 ? (
        <Card className="p-0 px-4">
          {claims.data.map((claim) => (
            <ListRow key={claim.id}>
              <div className="min-w-0 flex-1 py-1">
                <p className="text-sm text-fg-strong">{claim.statement}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <StatusChip tone={CLAIM_REVIEW_STATUS[claim.reviewState].tone}>
                    {CLAIM_REVIEW_STATUS[claim.reviewState].label}
                  </StatusChip>
                  <span className="text-xs text-fg-muted">
                    {CLAIM_CONFLICT_STATUS_LABEL[claim.conflictStatus]}
                  </span>
                </div>
              </div>
            </ListRow>
          ))}
        </Card>
      ) : null}
      {conflicts.data && conflicts.data.length > 0 ? (
        <Card className="p-0 px-4">
          {conflicts.data.map((conflict) => (
            <ListRow key={conflict.id}>
              <div className="min-w-0 flex-1 py-1">
                <p className="text-sm text-fg-strong">{conflict.summary}</p>
                {conflict.resolution ? (
                  <p className="mt-0.5 text-xs text-fg-muted">{conflict.resolution}</p>
                ) : null}
              </div>
            </ListRow>
          ))}
        </Card>
      ) : null}
    </section>
  );
}

function KnowledgeRetrievalPanel({
  workspaceId,
  connectionBlocked,
}: {
  workspaceId: string | null;
  connectionBlocked: boolean;
}) {
  const indexes = useKnowledgeIndexes(workspaceId);
  const retrieve = useRetrieveKnowledge();
  const prepare = usePrepareKnowledgeContext();
  const [query, setQuery] = useWorkspaceScoped(workspaceId, '');
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
  const indexTerms = indexes.data?.fullText.terms ?? [];

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
      {indexTerms.length > 0 ? (
        <p className="text-sm text-fg">{indexTerms.map((entry) => entry.term).join(' ')}</p>
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
          <p className="text-sm text-fg-strong">{retrieveResult.traceId}</p>
          {retrieveResult.selected.map((row) => (
            <p key={row.knowledgePageId} className="text-sm text-fg">
              {row.knowledgePageId}
            </p>
          ))}
          {retrieveResult.excluded.map((row) => (
            <p key={`${row.knowledgePageId}:${row.reason}`} className="text-xs text-fg-muted">
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
}: {
  workspaceId: string | null;
  connectionBlocked: boolean;
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
      {answerResult ? <p className="text-sm text-fg">{answerResult.answer}</p> : null}
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

function groupByKind(entries: KnowledgeItem[]): Record<KnowledgeItem['kind'], KnowledgeItem[]> {
  const groups: Record<KnowledgeItem['kind'], KnowledgeItem[]> = {
    preference: [],
    'project-context': [],
    'task-summary': [],
  };
  for (const entry of entries) {
    groups[entry.kind].push(entry);
  }
  return groups;
}
