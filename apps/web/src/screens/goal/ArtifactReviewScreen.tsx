import { type GetArtifactResponse, ApiCallError } from '@openkit/core-client';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConnection, useCoreClient } from '../../app/core-client';
import { useSurfaceParams } from '../../app/route-params';
import {
  ArtifactRow,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { chatThreadPath } from '../chat/data';
import { useMaterialProposalText, useWorkspaceMaterialRevision } from '../material/data';
import { MaterialRangeFeedback } from '../material/MaterialRangeFeedback';
import { ProposalReview } from '../material/ProposalReview';
import {
  type ArtifactReview,
  type ArtifactReviewDecisionInput,
  useArtifact,
  useArtifactReviews,
  useCurrentWorkspaceId,
  useSubmitArtifactReview,
  useSelectArtifactCandidate,
} from './data';

/**
 * Artifact review surface (board 12) for exact proposal comparison and decisions.
 *
 * The server-owned Review is the only displayed lifecycle authority; mutation
 * responses never advance local state, and disconnected writes remain visible but disabled.
 */
export function ArtifactReviewScreen() {
  const {
    workspaceId: routeWorkspaceId = '',
    threadId = '',
    artifactId = '',
  } = useSurfaceParams('artifact-review');
  const workspaceId = useCurrentWorkspaceId(routeWorkspaceId);
  const artifact = useArtifact(workspaceId, artifactId);
  const reviews = useArtifactReviews(workspaceId, artifactId);
  const pendingReview = reviews.data?.find((review) => review.decision === null) ?? null;
  const review = pendingReview ?? reviews.data?.at(-1) ?? null;

  if (!workspaceId || reviews.isLoading || (artifact.isLoading && !review)) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-8" aria-busy="true">
        <Skeleton lines={6} />
      </div>
    );
  }

  const sourceUnavailable = reviews.isError || artifact.isError;
  if (sourceUnavailable && !review) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-8">
        <ErrorBanner
          message="Couldn't load this artifact review."
          onRetry={() => {
            void reviews.refetch();
            void artifact.refetch();
          }}
        />
      </div>
    );
  }

  if (!review) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-8">
        <EmptyState
          icon="file"
          title="No artifact review"
          hint="This artifact has no review history yet."
        />
      </div>
    );
  }

  const exactArtifact =
    artifact.data?.id === artifactId &&
    artifact.data.workspaceId === workspaceId &&
    artifact.data.version === review.artifactVersion &&
    artifact.data.contentDigest === review.contentDigest
      ? artifact.data
      : null;


  return <ExactArtifactReview
    key={`${workspaceId}:${artifactId}:${review.artifactVersion}:${review.contentDigest}`}
    workspaceId={workspaceId}
    routeWorkspaceId={routeWorkspaceId}
    threadId={threadId}
    artifactId={artifactId}
    review={review}
    sourceUnavailable={sourceUnavailable}
    exactArtifact={exactArtifact}
    onRefresh={() => { void reviews.refetch(); void artifact.refetch(); }}
  />;
}

/** Keeps transient feedback and command retry identity within one exact reviewed candidate. */
function ExactArtifactReview({ workspaceId, routeWorkspaceId, threadId, artifactId, review, sourceUnavailable, exactArtifact, onRefresh }: {
  workspaceId: string;
  routeWorkspaceId: string;
  threadId: string;
  artifactId: string;
  review: ArtifactReview;
  sourceUnavailable: boolean;
  exactArtifact: GetArtifactResponse | null;
  onRefresh: () => void;
}) {
  const client = useCoreClient();
  const navigate = useNavigate();
  const { checking, failed: disconnected } = useConnection();
  const [feedback, setFeedback] = useState('');
  const [reason, setReason] = useState('');
  const [rangeFeedback, setRangeFeedback] = useState<NonNullable<ArtifactReviewDecisionInput['rangeFeedback']> | null>(null);
  const decide = useSubmitArtifactReview(workspaceId, artifactId, review.artifactVersion);
  const select = useSelectArtifactCandidate(workspaceId, artifactId, review.artifactVersion, review.contentDigest);
  const proposal = review.materialProposal;
  const base = useWorkspaceMaterialRevision(workspaceId, proposal?.materialId ?? null, proposal?.baseRevisionId ?? null);
  const fileProposal = Boolean(proposal && exactArtifact?.content.format === 'file');
  const proposalText = useMaterialProposalText(workspaceId, fileProposal ? exactArtifact : null);
  const conflict = decide.error instanceof ApiCallError && decide.error.status === 409 && decide.error.code === 'conflict';
  if (sourceUnavailable) return <div className="mx-auto w-full max-w-[960px] px-6 py-8"><ErrorBanner message="Couldn't load this artifact review." onRetry={onRefresh} /></div>;
  if (review.decision === null && !exactArtifact) return <ErrorBanner message="This review is unavailable. Recovery is required before a decision can be recorded." />;
  if (proposal && base.isError) return <ErrorBanner message="Couldn't load the recorded Material base." onRetry={() => void base.refetch()} />;
  const exactBase = proposal && base.data && base.data.revision.materialId === proposal.materialId && base.data.revision.revisionId === proposal.baseRevisionId && base.data.revision.contentDigest === proposal.baseContentDigest ? base.data.revision : null;
  if (proposal && base.data && !exactBase) return <ErrorBanner message="The recorded Material base does not match this Review." onRetry={() => void base.refetch()} />;
  const baseUnavailable = Boolean(proposal && !exactBase);
  const proposalUnavailable = fileProposal && (proposalText.isPending || proposalText.isError || proposalText.isFetching);
  const candidateUnavailable = !exactArtifact || !review.sourceThreadId;
  const trimmedFeedback = feedback.trim();
  const writeBlocked = checking || disconnected || decide.isPending || select.isPending || baseUnavailable || proposalUnavailable;
  const reviewStatusText =
    review.decision === 'accepted'
      ? 'Approved'
      : review.decision === 'rejected'
        ? 'Rejected'
        : review.decision === 'deferred'
          ? 'Paused'
          : review.decision === 'redo'
            ? 'In progress'
            : 'Needs review';
  const decisionEvidence =
    review.decision === 'accepted'
      ? 'Accepted'
      : review.decision === 'rejected'
        ? 'Rejected'
        : review.decision === 'deferred'
          ? 'Deferred'
          : review.decision === 'needs_refinement'
            ? 'Needs refinement'
            : review.decision === 'redo'
              ? 'Redo'
              : null;
  const reviewStatus = (
    <>
      <StatusChip
        tone={
          review.decision === 'accepted'
            ? 'positive'
            : review.decision === 'rejected'
              ? 'negative'
              : review.decision === 'redo'
                ? 'informative'
                : review.decision === null || review.decision === 'needs_refinement'
                  ? 'notice'
                  : 'neutral'
        }
        dot
      >
        {reviewStatusText}
      </StatusChip>
      <p className="text-xs text-fg-muted">
        Version {review.artifactVersion} · {review.contentDigest}
      </p>
    </>
  );

  /** Submits one exact decision without projecting the mutation response. */
  const submitDecision = (decision: ArtifactReviewDecisionInput['decision']) => {
    const input: ArtifactReviewDecisionInput = trimmedFeedback
      ? { decision, feedback: trimmedFeedback }
      : { decision };
    decide.mutate(rangeFeedback ? { ...input, rangeFeedback } : input);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-4 max-w-[760px]">
          <Link
            to={`/goals/${encodeURIComponent(routeWorkspaceId)}/${encodeURIComponent(threadId)}?lens=plan`}
            className="text-xs font-medium text-accent hover:underline"
          >
            ← Back to goal
          </Link>
          <h1 className="mt-4 text-title font-extrabold text-fg-strong">
            {exactArtifact?.title ?? `Artifact ${artifactId}`}
          </h1>
          <p className="mt-1 text-xs text-fg-muted">Review version {review.artifactVersion}</p>
        </div>
        {exactArtifact?.content.format === 'file' && !proposal ? (
          <Card className="mx-auto max-w-[760px]">
            <section aria-label="Original file" className="flex flex-col gap-3">
              <Eyebrow>Original file</Eyebrow>
              <p className="text-sm text-fg">{exactArtifact.content.mediaType} · {exactArtifact.content.byteLength} bytes</p>
              <p className="text-sm text-fg">Version {review.artifactVersion}</p>
              <p className="font-mono text-xs text-fg-muted">{review.contentDigest}</p>
              <p className="text-sm text-fg-muted">Review the original file. A text comparison is not available.</p>
              <a className="text-sm font-medium text-accent hover:underline" href={client.artifactFiles.browserDownloadUrl({ workspaceId, artifactId, artifactVersion: review.artifactVersion })}>Download original</a>
            </section>
          </Card>
        ) : <ProposalReview
          workspaceId={workspaceId}
          review={review}
          artifact={exactArtifact}
          conflict={conflict}
          onRefresh={onRefresh}
        />}
        {review.decision === null && exactBase ? <MaterialRangeFeedback
          revision={exactBase}
          value={rangeFeedback}
          onChange={setRangeFeedback}
          isDisabled={writeBlocked || decide.isUncertain}
        /> : null}
        {review.rangeFeedback ? <section aria-label="Recorded feedback range" className="mx-auto mt-5 max-w-[760px] text-sm text-fg">
          <Eyebrow>Recorded feedback range</Eyebrow>
          <p>{review.rangeFeedback.materialId} · {review.rangeFeedback.revisionId}</p>
          <p className="font-mono text-xs">{review.rangeFeedback.contentDigest}</p>
          <p>Original UTF-16 offsets {review.rangeFeedback.start}–{review.rangeFeedback.end}</p>
          <pre className="whitespace-pre-wrap font-sans">{review.rangeFeedback.originalText}</pre>
        </section> : null}
      </div>

      <aside
        aria-label="Provenance and review"
        className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-separator bg-layer-1 p-4"
      >
        <div>
          <Eyebrow>Provenance</Eyebrow>
          <dl className="mt-2 flex flex-col gap-2 text-sm">
            <div>
              <dt className="text-xs text-fg-muted">Thread</dt>
              <dd className="font-medium text-fg">{review.sourceThreadId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Turn</dt>
              <dd className="font-medium text-fg">{review.sourceTurnId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Agent</dt>
              <dd className="font-medium text-fg">{review.sourceAgentId ?? '—'}</dd>
            </div>
          </dl>
        </div>

        <div>
          <Eyebrow>Artifact</Eyebrow>
          <div className="mt-2">
            <ArtifactRow name={exactArtifact?.title ?? artifactId} />
          </div>
        </div>

        <section aria-label="Candidate choice" className="flex flex-col gap-3">
          <Eyebrow>Candidate choice</Eyebrow>
          <div aria-live="polite">
          {review.candidateSelections?.length ? <p className="text-sm text-fg">Candidate selected.</p> : null}
          {(review.candidateSelections ?? []).map((choice) => <div key={choice.requestId} className="text-sm text-fg">
            <p>{choice.actorId}</p>
            <p className="text-xs text-fg-muted">{choice.selectedAt}</p>
            {choice.reason ? <p>{choice.reason}</p> : null}
          </div>)}
          </div>
          <TextField label="Selection reason" value={reason} onChange={setReason} isDisabled={writeBlocked || candidateUnavailable || select.isUncertain} description="Optional. Selection records a choice and starts no work." />
          <Button size="sm" variant="outline" isDisabled={writeBlocked || candidateUnavailable} onPress={() => select.mutate(reason.trim() || undefined)}>Select candidate</Button>
          {select.isPending ? <p role="status" className="text-sm text-fg-muted">Recording candidate choice.</p> : null}
          {select.isError ? <ErrorBanner message={select.error instanceof ApiCallError && (select.error.code === 'stale' || select.error.status === 404) ? 'This exact candidate is unavailable. Refresh the review.' : 'Candidate selection could not be confirmed. Inspect the review or retry the same choice.'} onRetry={onRefresh} /> : null}
          <Button size="sm" isDisabled={writeBlocked || !exactArtifact || !review.sourceThreadId || !(review.candidateSelections?.length)} onPress={() => {
            if (!review.sourceThreadId || !exactArtifact) return;
            navigate(chatThreadPath(workspaceId, review.sourceThreadId), { state: { candidateInput: { workspaceId, threadId: review.sourceThreadId, artifactId, artifactVersion: review.artifactVersion, contentDigest: review.contentDigest } } });
          }}>Use in next Turn</Button>
          <p className="text-xs text-fg-muted">Use adds the selected candidate to the source conversation draft. Choose Send there to start a Turn.</p>
        </section>

        <div>
          <Eyebrow>Review gate</Eyebrow>
          {review.decision === null ? (
            <div className="mt-2 flex flex-col gap-2">{reviewStatus}</div>
          ) : (
            <div role="status" aria-label="Artifact review" className="mt-2 flex flex-col gap-2">
              {reviewStatus}
            </div>
          )}

          {decide.isError && !conflict ? <ErrorBanner message="The review decision could not be confirmed. Inspect the review or retry the same decision." onRetry={onRefresh} /> : null}
          {decide.isPending ? <p role="status" className="mt-2 text-sm text-fg-muted">Recording review decision.</p> : null}
          {baseUnavailable ? <p role="status" className="mt-2 text-sm text-fg-muted">The recorded Material base is unavailable.</p> : null}
          {review.decision === null ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm text-fg-muted">Awaiting decision.</p>
              {checking || disconnected ? (
                <p className="text-sm text-fg-muted">
                  Review actions are read-only while the connection is unavailable.
                </p>
              ) : null}
              <TextField
                label="Review feedback"
                value={feedback}
                onChange={setFeedback}
                isDisabled={writeBlocked || decide.isUncertain}
                description="Required for refinement and redo."
              />
              <Button
                size="sm"
                onPress={() => submitDecision('accepted')}
                isDisabled={writeBlocked || (decide.isUncertain && decide.variables?.decision !== 'accepted')}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => submitDecision('needs_refinement')}
                isDisabled={writeBlocked || (decide.isUncertain && decide.variables?.decision !== 'needs_refinement') || !trimmedFeedback}
              >
                Request refinement
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => submitDecision('redo')}
                isDisabled={writeBlocked || (decide.isUncertain && decide.variables?.decision !== 'redo') || !trimmedFeedback}
              >
                Redo
              </Button>
              <Button
                size="sm"
                variant="negative-outline"
                onPress={() => submitDecision('rejected')}
                isDisabled={writeBlocked || (decide.isUncertain && decide.variables?.decision !== 'rejected')}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => submitDecision('deferred')}
                isDisabled={writeBlocked || (decide.isUncertain && decide.variables?.decision !== 'deferred')}
              >
                Defer
              </Button>
            </div>
          ) : (
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              <div>
                <dt className="text-xs text-fg-muted">Decision</dt>
                <dd className="font-medium text-fg">{decisionEvidence}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Decided by</dt>
                <dd className="font-medium text-fg">{review.decisionActorId}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Decided at</dt>
                <dd className="font-medium text-fg">{review.decidedAt}</dd>
              </div>
              {review.feedback ? (
                <div>
                  <dt className="text-xs text-fg-muted">Feedback</dt>
                  <dd className="font-medium text-fg">{review.feedback}</dd>
                </div>
              ) : null}
              {review.followUpTurnId ? (
                <div>
                  <dt className="text-xs text-fg-muted">Follow-up turn</dt>
                  <dd className="font-medium text-fg">{review.followUpTurnId}</dd>
                </div>
              ) : null}
              {review.appliedMaterialRevisionId ? (
                <div>
                  <dt className="text-xs text-fg-muted">Applied revision</dt>
                  <dd className="font-medium text-fg">{review.appliedMaterialRevisionId}</dd>
                </div>
              ) : null}
            </dl>
          )}
        </div>
      </aside>
    </div>
  );
}
