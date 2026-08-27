import type { GetArtifactResponse } from '@openkit/core-client';
import { Card, ErrorBanner, Eyebrow, Skeleton } from '../../primitives';
import type { ArtifactReview } from '../goal/data';
import { useWorkspaceMaterial, useWorkspaceMaterialRevision } from './data';

/**
 * Renders one exact reviewed Artifact proposal against its recorded Material base.
 *
 * A typed conflict adds the current immutable Material revision as a third region;
 * no comparison result or client state becomes write authority.
 */
export function ProposalReview({
  workspaceId,
  review,
  artifact,
  conflict,
  onRefresh,
}: {
  workspaceId: string;
  review: ArtifactReview;
  artifact: GetArtifactResponse | null;
  conflict: boolean;
  onRefresh: () => void;
}) {
  const proposal = review.materialProposal;
  const material = useWorkspaceMaterial(
    workspaceId,
    conflict && proposal ? proposal.materialId : null
  );
  const baseRevision = useWorkspaceMaterialRevision(
    workspaceId,
    proposal?.materialId ?? null,
    proposal?.baseRevisionId ?? null
  );
  const currentRevision = useWorkspaceMaterialRevision(
    workspaceId,
    conflict && proposal ? proposal.materialId : null,
    conflict ? (material.data?.material.currentRevisionId ?? null) : null
  );
  const proposalBody = artifact
    ? artifact.content.format === 'markdown' || artifact.content.format === 'text'
      ? artifact.content.body
      : JSON.stringify(artifact.content, null, 2)
    : null;

  if (artifact && proposal && baseRevision.isLoading) {
    return (
      <Card className="mx-auto max-w-[760px]" aria-busy="true">
        <Skeleton lines={6} />
      </Card>
    );
  }

  return (
    <Card className="mx-auto flex max-w-[760px] flex-col gap-5">
      <section aria-label={artifact ? 'Reviewed artifact proposal' : 'Historical artifact review'}>
        <Eyebrow>{artifact ? 'Reviewed artifact proposal' : 'Historical artifact review'}</Eyebrow>
        <p className="mt-2 font-mono text-xs text-fg-muted">{review.contentDigest}</p>
        {proposalBody ? (
          <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-fg">
            {proposalBody}
          </pre>
        ) : (
          <p className="mt-3 text-sm text-fg-muted">
            The reviewed version body is unavailable. Decision evidence remains below.
          </p>
        )}
      </section>

      {proposal ? (
        <section aria-label="Recorded base revision" className="border-t border-separator pt-5">
          <Eyebrow>Recorded base revision</Eyebrow>
          {baseRevision.data ? (
            <>
              <p className="mt-2 font-mono text-xs text-fg-muted">
                {baseRevision.data.revision.revisionId} · {baseRevision.data.revision.contentDigest}
              </p>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-fg">
                {baseRevision.data.revision.content}
              </pre>
            </>
          ) : (
            <p className="mt-2 text-sm text-negative-fg">
              The recorded base revision could not be loaded.
            </p>
          )}
        </section>
      ) : null}

      {conflict && (!material.data || !currentRevision.data) ? (
        <div className="border-t border-separator pt-5" aria-busy="true">
          <Skeleton lines={3} />
        </div>
      ) : null}

      {conflict && currentRevision.data ? (
        <>
          <ErrorBanner
            message="The Material changed since the proposal base. Both versions remain unchanged."
            onRetry={onRefresh}
          />
          <section
            aria-label="Current material revision"
            className="border-t border-separator pt-5"
          >
            <Eyebrow>Current material revision</Eyebrow>
            <p className="mt-2 font-mono text-xs text-fg-muted">
              {currentRevision.data.revision.revisionId} ·{' '}
              {currentRevision.data.revision.contentDigest}
            </p>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-fg">
              {currentRevision.data.revision.content}
            </pre>
          </section>
        </>
      ) : null}
    </Card>
  );
}
