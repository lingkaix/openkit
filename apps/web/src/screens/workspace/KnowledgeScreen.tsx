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
  Skeleton,
  StatusChip,
  type StatusChipProps,
  TextField,
} from '../../primitives';
import {
  type AttentionRow,
  type KnowledgeItem,
  type KnowledgeProposalDecision,
  type KnowledgeProposalDecisionInput,
  type KnowledgeStoreProjection,
  useCreateKnowledge,
  useCurrentWorkspaceId,
  useDeleteKnowledge,
  useHumanAttention,
  useKnowledge,
  useKnowledgeStore,
  useSubmitKnowledgeProposalDecision,
  useUpdateKnowledge,
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

/**
 * Knowledge Store slice (WP-6, board 14).
 *
 * Lists and directly mutates user-authored knowledge through Core. Mutation
 * responses remain hidden until the authoritative list refetch settles.
 */
export function KnowledgeScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const knowledge = useKnowledge(workspaceId);
  const create = useCreateKnowledge(workspaceId);
  const update = useUpdateKnowledge(workspaceId);
  const remove = useDeleteKnowledge(workspaceId);
  const store = useKnowledgeStore(workspaceId);
  const attention = useHumanAttention(workspaceId);
  const proposalDecision = useSubmitKnowledgeProposalDecision();
  const { checking, failed } = useConnection();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const writePending =
    create.isPending || update.isPending || remove.isPending || proposalDecision.isPending;
  const entryWriteBlocked =
    checking || failed || writePending || knowledge.isError || knowledge.isFetching || !workspaceId;
  const proposalWriteBlocked = entryWriteBlocked || attention.isFetching || attention.isError;

  function resetForm() {
    setAdding(false);
    setTitle('');
    setContent('');
    create.reset();
  }

  function save() {
    if (!title.trim() || !content.trim()) return;
    create.mutate(
      { title: title.trim(), content: content.trim(), kind: 'preference' },
      { onSuccess: () => resetForm() }
    );
  }

  /** Prefill the edit form from one exact authoritative entry. */
  function startEditing(entry: KnowledgeItem) {
    setEditing(entry);
    setEditTitle(entry.title);
    setEditContent(entry.content);
    update.reset();
  }

  /** Close the edit form and discard its local intent. */
  function stopEditing() {
    setEditing(null);
    setEditTitle('');
    setEditContent('');
    update.reset();
  }

  /** Submit only changed, non-empty trimmed fields for the current entry. */
  function saveEdit() {
    if (!editing) return;
    const titleChanged = editTitle !== editing.title;
    const contentChanged = editContent !== editing.content;
    const nextTitle = editTitle.trim();
    const nextContent = editContent.trim();
    if (
      (!titleChanged && !contentChanged) ||
      (titleChanged && !nextTitle) ||
      (contentChanged && !nextContent)
    )
      return;
    update.mutate(
      {
        knowledgeEntryId: editing.id,
        ...(titleChanged ? { title: nextTitle } : {}),
        ...(contentChanged ? { content: nextContent } : {}),
      },
      {
        onSuccess: async () => {
          const result = await knowledge.refetch();
          if (result.isSuccess) stopEditing();
        },
      }
    );
  }

  /** Retry only the authoritative Knowledge read and settle a completed edit after success. */
  async function retryKnowledgeRead() {
    const result = await knowledge.refetch();
    if (result.isSuccess && editing && update.isSuccess) stopEditing();
  }

  /** Delete one entry, then refresh only through the authoritative Knowledge read. */
  function removeEntry(knowledgeEntryId: string) {
    remove.mutate(knowledgeEntryId, {
      onSuccess: async () => {
        await knowledge.refetch();
      },
    });
  }

  const editCanSave = Boolean(
    editing &&
      (editTitle !== editing.title || editContent !== editing.content) &&
      (editTitle === editing.title || editTitle.trim()) &&
      (editContent === editing.content || editContent.trim())
  );

  const entries = knowledge.data ?? [];
  const byKind = groupByKind(entries);
  const storeData = store.data;
  const knowledgeProposals = attention.data?.filter((row) => row.source.type === 'knowledge') ?? [];

  /** Submit a decision, then read the authoritative attention owner before UI settlement. */
  function submitProposalDecision(input: KnowledgeProposalDecisionInput) {
    proposalDecision.mutate(input, {
      onSuccess: async () => {
        await attention.refetch();
      },
    });
  }

  return (
    <Page>
      <PageHeader
        title="Knowledge"
        subtitle="What OpenKit saves and supplies to agents. Everything here is explicit — you can edit or remove any of it."
        actions={
          <Button size="sm" isDisabled={entryWriteBlocked} onPress={() => setAdding(true)}>
            Add knowledge
          </Button>
        }
      />

      {adding ? (
        <Card className="flex flex-col gap-3">
          <Eyebrow>New preference</Eyebrow>
          <TextField
            label="Title"
            value={title}
            onChange={setTitle}
            isDisabled={entryWriteBlocked}
            placeholder="Short name for this knowledge"
          />
          <TextField
            label="Content"
            value={content}
            onChange={setContent}
            isDisabled={entryWriteBlocked}
            placeholder="What should agents remember?"
          />
          {create.isError ? (
            <fieldset disabled={entryWriteBlocked} className="contents">
              <ErrorBanner message="Couldn't save that entry." onRetry={save} />
            </fieldset>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              isDisabled={entryWriteBlocked || !title.trim() || !content.trim()}
              onPress={save}
            >
              Save
            </Button>
            <Button size="sm" variant="outline" onPress={resetForm}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {remove.isError ? (
        <fieldset disabled={entryWriteBlocked} className="contents">
          <ErrorBanner
            message="Couldn't remove that entry."
            onRetry={() => {
              if (remove.variables) removeEntry(remove.variables);
            }}
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
      ) : knowledge.data === undefined ? null : entries.length === 0 && !adding ? (
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
                                  onPress={() => removeEntry(entry.id)}
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
                            value={editTitle}
                            onChange={setEditTitle}
                            isDisabled={entryWriteBlocked}
                          />
                          <TextField
                            label="Content"
                            value={editContent}
                            onChange={setEditContent}
                            isDisabled={entryWriteBlocked}
                          />
                          {update.isError ? (
                            <fieldset disabled={entryWriteBlocked} className="contents">
                              <ErrorBanner
                                message="Couldn't save those changes."
                                onRetry={saveEdit}
                              />
                            </fieldset>
                          ) : null}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              isDisabled={entryWriteBlocked || !editCanSave}
                              onPress={saveEdit}
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

      {!workspaceId || store.isLoading ? (
        <Skeleton lines={3} />
      ) : store.isError ? (
        <ErrorBanner
          message="Couldn't load Knowledge Store details."
          onRetry={() => void store.refetch()}
        />
      ) : !storeData ? null : (
        <>
          {storeData.sources.length > 0 ? (
            <section className="flex flex-col gap-2">
              <Eyebrow>Sources</Eyebrow>
              <Card className="p-0 px-4">
                {storeData.sources.map((source) => (
                  <ListRow key={source.id}>
                    <div className="min-w-0 flex-1 py-1">
                      <p className="text-sm font-bold text-fg-strong">{source.title}</p>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        {SOURCE_KIND_LABEL[source.kind]}
                      </p>
                    </div>
                  </ListRow>
                ))}
              </Card>
            </section>
          ) : null}
          {storeData.observations.length > 0 ? (
            <section className="flex flex-col gap-2">
              <Eyebrow>Observations</Eyebrow>
              <Card className="p-0 px-4">
                {storeData.observations.map((observation) => (
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
            </section>
          ) : null}
          {storeData.claims.length > 0 ? (
            <section className="flex flex-col gap-2">
              <Eyebrow>Claims</Eyebrow>
              <Card className="p-0 px-4">
                {storeData.claims.map((claim) => (
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
            </section>
          ) : null}
        </>
      )}

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
          {proposalDecision.isError ? (
            <fieldset disabled={proposalWriteBlocked} className="contents">
              <ErrorBanner
                message="Couldn't submit that proposal decision."
                onRetry={() => {
                  if (proposalDecision.variables) {
                    submitProposalDecision(proposalDecision.variables);
                  }
                }}
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
    </Page>
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
