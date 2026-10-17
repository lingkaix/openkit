import type { EvaluationCandidate } from '@openkit/app-api-schemas';
import { createRequestId } from '@openkit/core-client';
import { useEffect, useRef, useState } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { Link, useNavigate } from 'react-router-dom';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Select,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { chatThreadPath } from '../chat/data';
import { useThreads } from './data';
import {
  candidateCommandError,
  canEditCandidateCommand,
  canRetryCandidateCommand,
  sameCandidate,
  useCandidateSet,
  useCandidateSets,
  useCandidateVersions,
  useCreateCandidateSet,
  useSelectCandidate,
} from './evaluation-data';

/** Exact candidate comparison uses existing unsent Artifact pins; no selection starts work. */
export function ArtifactCandidateSets(props: {
  workspaceId: string;
  draftCandidates: EvaluationCandidate[];
  disabled: boolean;
  onRemoveCandidate: (candidate: EvaluationCandidate) => void;
  onClearDraft: () => void;
  onDraftLockedChange: (locked: boolean) => void;
}) {
  const { workspaceId } = props;
  const client = useCoreClient();
  const navigate = useNavigate();
  const list = useCandidateSets(workspaceId);
  const [inspection, setInspection] = useState<{
    workspaceId: string;
    candidateSetId: string;
  } | null>(null);
  const selectedId = inspection?.workspaceId === workspaceId ? inspection.candidateSetId : null;
  const detail = useCandidateSet(workspaceId, selectedId);
  const visibleSet = list.isSuccess && detail.isSuccess ? detail.data : undefined;
  const originals = useCandidateVersions(workspaceId, visibleSet);
  const threads = useThreads(workspaceId);
  const create = useCreateCandidateSet();
  const select = useSelectCandidate();
  const [draft, setDraft] = useState<{
    workspaceId: string;
    candidateSetId: string;
    candidateIndex: string;
    note: string;
    threadId: string;
  } | null>(null);
  const local =
    draft?.workspaceId === workspaceId && draft.candidateSetId === selectedId ? draft : null;
  const [refreshed, setRefreshed] = useState(false);
  const context = useRef({ workspaceId, selectedId });
  context.current = { workspaceId, selectedId };
  const commandLocked = create.isPending || create.isError || select.isPending || select.isError;
  const onDraftLockedChange = props.onDraftLockedChange;
  useEffect(() => {
    onDraftLockedChange(commandLocked);
  }, [commandLocked, onDraftLockedChange]);
  const current = visibleSet?.judgements.filter((judgement) => judgement.kind === 'select').at(-1);
  const currentCandidate = current?.kind === 'select' ? current.choice : null;
  const authorizedThreads = threads.isSuccess
    ? threads.data.filter((thread) => thread.status === 'active')
    : [];
  const readReady = Boolean(
    visibleSet &&
      originals.isSuccess &&
      !list.isFetching &&
      !detail.isFetching &&
      !originals.isFetching
  );
  const writeBlocked = props.disabled || commandLocked || !readReady;
  const selectedOriginal =
    originals.isSuccess && currentCandidate
      ? originals.data.find((record) => sameCandidate(record.version, currentCandidate))
      : null;
  const nextThread = authorizedThreads.find((thread) => thread.id === local?.threadId);

  /** Keeps local controls bound to the inspected set without rewriting a frozen command. */
  function changeDraft(change: Partial<NonNullable<typeof draft>>) {
    if (!selectedId) return;
    setDraft({
      workspaceId,
      candidateSetId: selectedId,
      candidateIndex: '',
      note: '',
      threadId: '',
      ...local,
      ...change,
    });
  }

  function createComparison() {
    if (
      props.disabled ||
      commandLocked ||
      props.draftCandidates.length < 2 ||
      !list.isSuccess ||
      list.isFetching
    )
      return;
    const source = { workspaceId, selectedId };
    setRefreshed(false);
    create.mutate(
      {
        workspaceId,
        requestId: createRequestId(),
        candidates: props.draftCandidates.map((candidate) => ({ ...candidate })),
      },
      {
        onSuccess: (record) => {
          if (
            context.current.workspaceId !== source.workspaceId ||
            context.current.selectedId !== source.selectedId
          )
            return;
          props.onClearDraft();
          setInspection({ workspaceId: source.workspaceId, candidateSetId: record.candidateSetId });
        },
      }
    );
  }

  function recordChoice() {
    if (writeBlocked || !visibleSet || !local || !originals.isSuccess || !local.candidateIndex)
      return;
    const index = Number(local.candidateIndex);
    if (!Number.isSafeInteger(index) || !visibleSet.candidates[index]) return;
    setRefreshed(false);
    select.mutate({
      workspaceId,
      candidateSetId: visibleSet.candidateSetId,
      requestId: createRequestId(),
      choice: visibleSet.candidates[index],
      ...(local.note.trim() ? { note: local.note } : {}),
    });
  }

  async function refreshComparison() {
    const source = { workspaceId, selectedId };
    const results = await Promise.all([
      list.refetch(),
      ...(selectedId ? [detail.refetch(), originals.refetch()] : []),
    ]);
    if (
      context.current.workspaceId === source.workspaceId &&
      context.current.selectedId === source.selectedId
    )
      setRefreshed(results.every((result) => result.isSuccess));
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Artifact comparisons">
      <h2 className="text-sm font-bold text-fg">Compare exact candidates</h2>
      <p className="text-sm text-fg-muted">
        Add at least two exact versions from Artifact history. A comparison keeps its original
        members. Recording a choice starts no work.
      </p>
      {props.draftCandidates.length ? (
        <ol className="flex flex-col gap-2" aria-label="New comparison candidates">
          {props.draftCandidates.map((candidate) => (
            <li
              key={`${candidate.artifactId}:${candidate.artifactVersion}`}
              className="flex flex-wrap items-center gap-2 text-sm text-fg"
            >
              <span className="break-all">
                {candidate.artifactId} · version {candidate.artifactVersion}
              </span>
              <Button
                size="sm"
                variant="quiet"
                isDisabled={commandLocked || props.disabled}
                onPress={() => props.onRemoveCandidate(candidate)}
              >
                Remove version {candidate.artifactVersion}
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-fg-muted">No candidates in the new comparison.</p>
      )}
      <Button
        size="sm"
        isDisabled={
          props.disabled ||
          commandLocked ||
          props.draftCandidates.length < 2 ||
          !list.isSuccess ||
          list.isFetching
        }
        onPress={createComparison}
      >
        Create comparison
      </Button>
      {create.isPending || select.isPending ? (
        <StatusChip tone="notice">
          {create.isPending ? 'Creating comparison' : 'Recording choice'}
        </StatusChip>
      ) : null}
      {create.isError ? <ErrorBanner message={candidateCommandError(create.error)} /> : null}
      {select.isError ? <ErrorBanner message={candidateCommandError(select.error)} /> : null}
      {create.isError && canRetryCandidateCommand(create.error) ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled || create.variables?.workspaceId !== workspaceId}
          onPress={() => {
            if (create.variables) create.mutate(create.variables);
          }}
        >
          Retry same comparison request
        </Button>
      ) : null}
      {select.isError && canRetryCandidateCommand(select.error) ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled || select.variables?.workspaceId !== workspaceId}
          onPress={() => {
            if (select.variables) select.mutate(select.variables);
          }}
        >
          Retry same choice request
        </Button>
      ) : null}
      {create.isError || select.isError ? (
        <>
          <Button
            size="sm"
            variant="outline"
            isDisabled={props.disabled || create.isPending || select.isPending}
            onPress={() => void refreshComparison()}
          >
            Refresh comparisons
          </Button>
          {refreshed &&
          list.isSuccess &&
          !list.isFetching &&
          (!selectedId || readReady) &&
          ((create.isError && canEditCandidateCommand(create.error)) ||
            (select.isError && canEditCandidateCommand(select.error))) ? (
            <Button
              size="sm"
              variant="outline"
              isDisabled={props.disabled}
              onPress={() => {
                if (create.isError && canEditCandidateCommand(create.error)) create.reset();
                if (select.isError && canEditCandidateCommand(select.error)) select.reset();
              }}
            >
              Edit refused request
            </Button>
          ) : null}
        </>
      ) : null}
      {list.isError ? (
        <ErrorBanner
          message="Couldn't load comparisons. Their current content is unavailable."
          onRetry={() => void list.refetch()}
        />
      ) : !list.isSuccess ? (
        <Skeleton lines={3} />
      ) : (
        <>
          {list.data.length ? (
            <ul className="flex flex-col gap-2" aria-label="Saved comparisons">
              {list.data.map((record) => (
                <li key={record.candidateSetId}>
                  <Button
                    size="sm"
                    variant="outline"
                    onPress={() => {
                      setInspection({ workspaceId, candidateSetId: record.candidateSetId });
                      setRefreshed(false);
                    }}
                  >
                    Open comparison {record.candidateSetId}
                  </Button>
                </li>
              ))}
            </ul>
          ) : !selectedId ? (
            <EmptyState icon="file" title="No saved comparisons" />
          ) : null}
          {selectedId ? (
            detail.isError ? (
              <ErrorBanner
                message="Couldn't read that comparison. Its candidates and choices are unavailable."
                onRetry={() => void detail.refetch()}
              />
            ) : !detail.isSuccess ? (
              <Skeleton lines={4} />
            ) : visibleSet ? (
              originals.isError ? (
                <ErrorBanner
                  message="Couldn't read every exact candidate. Comparison content and use are unavailable."
                  onRetry={() => void originals.refetch()}
                />
              ) : !originals.isSuccess ? (
                <Skeleton lines={6} />
              ) : (
                <>
                  <p className="text-xs text-fg-muted">
                    Created by {visibleSet.createdBy.id} ·{' '}
                    <time dateTime={visibleSet.createdAt}>{visibleSet.createdAt}</time>
                  </p>
                  <section
                    className="grid gap-4 md:grid-cols-2"
                    aria-label="Exact comparison originals"
                  >
                    {originals.data.map((record) => (
                      <article
                        key={`${record.artifact.id}:${record.artifact.version}`}
                        className="flex min-w-0 flex-col gap-2"
                      >
                        <h3 className="break-words text-sm font-bold text-fg">
                          {record.artifact.title} · version {record.artifact.version}
                        </h3>
                        <dl className="text-xs text-fg-muted">
                          <dt>Parent version</dt>
                          <dd>
                            {record.version.parentVersion === null
                              ? 'No parent'
                              : `Version ${record.version.parentVersion}`}
                          </dd>
                          <dt>SHA-256</dt>
                          <dd className="break-all">{record.artifact.contentDigest}</dd>
                          <dt>Actor</dt>
                          <dd className="break-all">
                            {record.version.actor.kind}: <span>{record.version.actor.id}</span>
                          </dd>
                          <dt>Recorded at</dt>
                          <dd>
                            <time dateTime={record.version.recordedAt}>
                              {record.version.recordedAt}
                            </time>
                          </dd>
                          <dt>Producing Turn</dt>
                          <dd className="break-all">
                            {record.version.turnId ?? 'No producing Turn'}
                          </dd>
                        </dl>
                        {record.version.threadId ? (
                          <Link
                            className="text-sm text-accent underline"
                            to={chatThreadPath(workspaceId, record.version.threadId)}
                          >
                            View producing conversation
                          </Link>
                        ) : null}
                        {record.artifact.content.format === 'file' ? (
                          <p className="text-sm text-fg-muted">
                            {record.artifact.content.mediaType} ·{' '}
                            {record.artifact.content.byteLength.toLocaleString()} bytes
                          </p>
                        ) : (
                          <pre className="whitespace-pre-wrap break-words text-sm text-fg">
                            {record.artifact.content.body}
                          </pre>
                        )}
                        <AriaLink
                          className="text-sm text-accent underline"
                          href={client.artifactFiles.browserDownloadUrl({
                            workspaceId,
                            artifactId: record.artifact.id,
                            artifactVersion: record.artifact.version,
                          })}
                        >
                          Download version {record.artifact.version}
                        </AriaLink>
                      </article>
                    ))}
                  </section>
                  <Select
                    label="Candidate choice"
                    items={originals.data.map((record, index) => ({
                      id: String(index),
                      label: `${record.artifact.title} · version ${record.artifact.version} · ${record.artifact.id}`,
                    }))}
                    selectedKey={local?.candidateIndex || null}
                    onSelectionChange={(key) =>
                      changeDraft({ candidateIndex: key === null ? '' : String(key) })
                    }
                    isDisabled={writeBlocked}
                  />
                  <TextField
                    label="Choice note"
                    value={local?.note ?? ''}
                    onChange={(note) => changeDraft({ note })}
                    isDisabled={writeBlocked}
                  />
                  <Button
                    size="sm"
                    isDisabled={writeBlocked || !local?.candidateIndex}
                    onPress={recordChoice}
                  >
                    Record choice
                  </Button>
                  <h3 className="text-sm font-bold text-fg">Choice history</h3>
                  {visibleSet.judgements.length ? (
                    <ol className="flex flex-col gap-2" aria-label="Comparison judgement history">
                      {visibleSet.judgements.map((judgement) => (
                        <li key={judgement.requestId} className="text-sm text-fg">
                          <p>
                            {judgement.kind} ·{' '}
                            <span className="break-all">{judgement.actor.id}</span> ·{' '}
                            <time dateTime={judgement.recordedAt}>{judgement.recordedAt}</time>
                          </p>
                          {judgement.kind === 'select' ? (
                            <p className="break-all">
                              {judgement.choice.artifactId} · version{' '}
                              {judgement.choice.artifactVersion} · {judgement.choice.contentDigest}
                            </p>
                          ) : judgement.kind === 'rate' ? (
                            <p>
                              {judgement.choice.value} on {judgement.choice.lowerBound} to{' '}
                              {judgement.choice.upperBound}
                            </p>
                          ) : null}
                          {judgement.note ? (
                            <p className="whitespace-pre-wrap">{judgement.note}</p>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-fg-muted">No choice recorded.</p>
                  )}
                  {currentCandidate ? (
                    <p className="break-all text-sm text-fg">
                      Current choice: {currentCandidate.artifactId} · version{' '}
                      {currentCandidate.artifactVersion}
                    </p>
                  ) : null}
                  <Select
                    label="Next conversation"
                    items={authorizedThreads.map((thread) => ({
                      id: thread.id,
                      label: thread.name ?? 'Untitled conversation',
                    }))}
                    selectedKey={local?.threadId || null}
                    onSelectionChange={(key) =>
                      changeDraft({ threadId: key === null ? '' : String(key) })
                    }
                    isDisabled={writeBlocked || !threads.isSuccess}
                  />
                  {threads.isError ? (
                    <ErrorBanner
                      message="Couldn't load conversations."
                      onRetry={() => void threads.refetch()}
                    />
                  ) : null}
                  <Button
                    size="sm"
                    isDisabled={
                      writeBlocked ||
                      !currentCandidate ||
                      !nextThread ||
                      selectedOriginal?.artifact.status !== 'ready'
                    }
                    onPress={() => {
                      if (
                        !currentCandidate ||
                        !nextThread ||
                        writeBlocked ||
                        selectedOriginal?.artifact.status !== 'ready'
                      )
                        return;
                      navigate(chatThreadPath(workspaceId, nextThread.id), {
                        state: {
                          candidateInput: {
                            workspaceId,
                            threadId: nextThread.id,
                            ...currentCandidate,
                          },
                        },
                      });
                    }}
                  >
                    Use selected in next Turn
                  </Button>
                  <p className="text-xs text-fg-muted">
                    Use adds the exact selected version to a conversation draft. Send remains
                    explicit.
                  </p>
                </>
              )
            ) : null
          ) : null}
        </>
      )}
    </section>
  );
}
