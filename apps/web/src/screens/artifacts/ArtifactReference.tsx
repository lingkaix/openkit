import {
  WorkspaceSyncReviewItemSchema,
  workspaceSyncReviewPatchBytes,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import type { Item } from '@openkit/protocol';
import { Link } from 'react-router-dom';
import { Button, Dialog, ErrorBanner, ItemCard, Modal, Skeleton } from '../../primitives';
import { fillCopy } from '../chat/timeline/copy';
import { timelineNotices } from '../chat/timeline/notices';
import { useArtifactVersion } from './data';

/** Recorded Artifact reference carried by a Thread Item. */
type ArtifactReferenceItem = Extract<Item, { type: 'artifact-reference' }>;

/** Opens a Thread's exact Artifact reference from either the stream or its side index. */
export function ArtifactReference({ item }: { item: ArtifactReferenceItem }) {
  return (
    <ItemCard
      kind="neutral"
      title={item.title}
      meta={`Saved output · Version ${item.artifactVersion}`}
      actions={
        <Modal
          trigger={
            <Button size="sm" variant="outline">
              View content
            </Button>
          }
        >
          <Dialog title={item.title}>
            <ArtifactContent item={item} />
            <Button slot="close" variant="quiet">
              Close
            </Button>
          </Dialog>
        </Modal>
      }
    >
      {item.summary ? <p className="text-xs text-fg-muted">{item.summary}</p> : null}
    </ItemCard>
  );
}

/** Loads only while the dialog is mounted. The head read cannot replace the referenced version. */
function ArtifactContent({ item }: { item: ArtifactReferenceItem }) {
  const itemWorkspaceId = item.owner.kind === 'workspace' ? item.owner.workspaceId : null;
  const exact = useArtifactVersion(
    itemWorkspaceId ?? '',
    item.artifactId,
    item.artifactVersion,
    Boolean(itemWorkspaceId)
  );
  if (!itemWorkspaceId) {
    return <p>{fillCopy(timelineNotices.versionUnavailable, { version: item.artifactVersion })}</p>;
  }
  if (exact.isLoading) return <Skeleton lines={4} />;
  const notRetained =
    exact.isError && exact.error instanceof ApiCallError && exact.error.status === 404;
  if (notRetained) {
    const params = new URLSearchParams();
    params.set('workspaceId', itemWorkspaceId);
    params.set('artifact', item.artifactId);
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p>{fillCopy(timelineNotices.versionUnavailable, { version: item.artifactVersion })}</p>
        <Link
          to={`/artifacts?${params.toString()}`}
          className="inline-flex min-h-11 items-center text-sm font-bold text-accent underline"
        >
          {timelineNotices.openVersionList}
        </Link>
      </div>
    );
  }
  if (exact.isError || !exact.data) {
    return (
      <ErrorBanner message="Couldn't load that artifact." onRetry={() => void exact.refetch()} />
    );
  }
  const artifact = exact.data.artifact;
  const { content } = artifact;
  let review = null;
  if (artifact.kind === 'diff' && content.format === 'json') {
    try {
      const parsed = WorkspaceSyncReviewItemSchema.safeParse({
        ...JSON.parse(content.body),
        artifactId: item.artifactId,
      });
      if (
        parsed.success &&
        itemWorkspaceId !== null &&
        parsed.data.changeSet.workspaceId === itemWorkspaceId &&
        parsed.data.review.workspaceId === itemWorkspaceId
      )
        review = parsed.data;
    } catch {
      // Non-review content remains readable as escaped text below.
    }
  }
  if (content.format === 'file') {
    return (
      <div className="flex min-w-0 flex-col gap-2 text-sm text-fg-muted">
        <p>
          Version {artifact.version} · {content.mediaType} · {content.byteLength.toLocaleString()}{' '}
          bytes
        </p>
        <p className="break-all">{artifact.contentDigest}</p>
        <p>Inspect this exact version in Artifacts to download its original bytes.</p>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-fg-muted">Version {artifact.version}</p>
      <p className="text-xs text-fg-muted">
        Type: {review ? 'Workspace change review' : artifact.kind}
      </p>
      {review ? (
        <>
          <p>
            Recorded workspace changes. Current review decisions are available in Workspace changes.
          </p>
          <ul className="flex flex-col gap-2">
            {review.changeSet.changedPaths.map((path) => (
              <li key={path.path}>
                <p className="font-mono">
                  {path.oldPath ? `${path.oldPath} → ` : ''}
                  {path.path}
                </p>
                <p className="text-xs text-fg-muted">
                  {path.status}
                  {path.binaryReview ? ` · ${path.binaryReview.summary}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {review.patchPayload ? (
            <pre className="overflow-x-auto whitespace-pre text-xs">
              {new TextDecoder().decode(workspaceSyncReviewPatchBytes(review.patchPayload))}
            </pre>
          ) : (
            <p>No text diff was recorded.</p>
          )}
          <details>
            <summary className="cursor-pointer">Full recorded content</summary>
            <pre className="whitespace-pre-wrap text-xs">{content.body}</pre>
          </details>
        </>
      ) : (
        <pre className="whitespace-pre-wrap text-xs">{content.body}</pre>
      )}
    </div>
  );
}
