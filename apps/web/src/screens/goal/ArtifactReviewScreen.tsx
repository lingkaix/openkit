import { ApiCallError } from '@openkit/core-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  ArtifactRow,
  Button,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { ProposalReview } from '../material/ProposalReview';
import {
  type ArtifactReviewDecisionInput,
  useArtifact,
  useArtifactReviews,
  useCurrentWorkspaceId,
  useSubmitArtifactReview,
} from './data';

/**
 * Artifact review surface (board 12) for exact proposal comparison and decisions.
 *
 * The server-owned Review is the only displayed lifecycle authority; mutation
 * responses never advance local state, and disconnected writes remain visible but disabled.
 */
export function ArtifactReviewScreen() {
  const { workspaceId: routeWorkspaceId = '', threadId = '', artifactId = '' } = useParams();
  const workspaceId = useCurrentWorkspaceId(routeWorkspaceId);
  const artifact = useArtifact(workspaceId, artifactId);
  const reviews = useArtifactReviews(workspaceId, artifactId);
  const { checking, failed: disconnected } = useConnection();
  const [feedback, setFeedback] = useState('');
  const pendingReview = reviews.data?.find((review) => review.decision === null) ?? null;
  const review = pendingReview ?? reviews.data?.at(-1) ?? null;
  const decide = useSubmitArtifactReview(
    workspaceId ?? '',
    artifactId,
    review?.artifactVersion ?? 1
  );
  const conflict =
    decide.error instanceof ApiCallError &&
    decide.error.status === 409 &&
    decide.error.code === 'conflict';

  if (!workspaceId || reviews.isLoading || (artifact.isLoading && !review)) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-8" aria-busy="true">
        <Skeleton lines={6} />
      </div>
    );
  }

  if (reviews.isError || (artifact.isError && (!review || review.decision === null))) {
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
    artifact.data?.version === review.artifactVersion &&
    artifact.data.contentDigest === review.contentDigest
      ? artifact.data
      : null;

  if (review.decision === null && !exactArtifact) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-8">
        <ErrorBanner message="This review is unavailable. Recovery is required before a decision can be recorded." />
      </div>
    );
  }

  const trimmedFeedback = feedback.trim();
  const writeBlocked = checking || disconnected || decide.isPending;
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
    decide.mutate(input);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-4 max-w-[760px]">
          <Link
            to={`/goals/${routeWorkspaceId}/${threadId}?lens=plan`}
            className="text-xs font-medium text-accent hover:underline"
          >
            ← Back to goal
          </Link>
          <h1 className="mt-4 text-title font-extrabold text-fg-strong">
            {exactArtifact?.title ?? `Artifact ${artifactId}`}
          </h1>
          <p className="mt-1 text-xs text-fg-muted">Review version {review.artifactVersion}</p>
        </div>
        <ProposalReview
          workspaceId={workspaceId}
          review={review}
          artifact={exactArtifact}
          conflict={conflict}
          onRefresh={() => void reviews.refetch()}
        />
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

        <div>
          <Eyebrow>Review gate</Eyebrow>
          {review.decision === null ? (
            <div className="mt-2 flex flex-col gap-2">{reviewStatus}</div>
          ) : (
            <div role="status" aria-label="Artifact review" className="mt-2 flex flex-col gap-2">
              {reviewStatus}
            </div>
          )}

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
                isDisabled={writeBlocked}
                description="Required for refinement and redo."
              />
              <Button
                size="sm"
                onPress={() => submitDecision('accepted')}
                isDisabled={writeBlocked}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => submitDecision('needs_refinement')}
                isDisabled={writeBlocked || !trimmedFeedback}
              >
                Request refinement
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => submitDecision('redo')}
                isDisabled={writeBlocked || !trimmedFeedback}
              >
                Redo
              </Button>
              <Button
                size="sm"
                variant="negative-outline"
                onPress={() => submitDecision('rejected')}
                isDisabled={writeBlocked}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={() => submitDecision('deferred')}
                isDisabled={writeBlocked}
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
