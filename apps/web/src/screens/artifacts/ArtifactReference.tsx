import { WorkspaceSyncReviewItemSchema } from '@openkit/app-api-schemas';
import type { Item } from '@openkit/protocol';
import { Button, Dialog, ErrorBanner, ItemCard, Modal, Skeleton } from '../../primitives';
import { useArtifact } from './data';

/** Recorded Artifact reference carried by a Thread Item. */
type ArtifactReferenceItem = Extract<Item, { type: 'artifact-reference' }>;

/** Opens a Thread's exact Artifact reference from either the stream or its side index. */
export function ArtifactReference({ item }: { item: ArtifactReferenceItem }) {
  return (
    <ItemCard
      kind="neutral"
      title={item.title}
      meta={item.summary ?? undefined}
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
    />
  );
}

/** Loads only while the dialog is mounted; a different current version cannot replace historical evidence. */
function ArtifactContent({ item }: { item: ArtifactReferenceItem }) {
  const artifact = useArtifact(item.workspaceId, item.artifactId);
  if (artifact.isLoading) return <Skeleton lines={4} />;
  if (artifact.isError || !artifact.data) {
    return (
      <ErrorBanner message="Couldn't load that artifact." onRetry={() => void artifact.refetch()} />
    );
  }
  if (artifact.data.version !== item.artifactVersion) {
    return (
      <p>
        This message references version {item.artifactVersion}, but the artifact is now version{' '}
        {artifact.data.version}. The referenced content is unavailable.
      </p>
    );
  }
  const { content } = artifact.data;
  let review = null;
  if (artifact.data.kind === 'diff' && content.format === 'json') {
    try {
      const parsed = WorkspaceSyncReviewItemSchema.safeParse({
        ...JSON.parse(content.body),
        artifactId: item.artifactId,
      });
      if (
        parsed.success &&
        parsed.data.changeSet.workspaceId === item.workspaceId &&
        parsed.data.review.workspaceId === item.workspaceId
      )
        review = parsed.data;
    } catch {
      // Non-review content remains readable as escaped text below.
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-3 break-words">
      <p className="text-xs text-fg-muted">Version {artifact.data.version}</p>
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
            <pre className="overflow-x-auto whitespace-pre text-xs">{review.patchPayload.text}</pre>
          ) : (
            <p>No text diff was recorded.</p>
          )}
          <details>
            <summary className="cursor-pointer">Full recorded content</summary>
            <pre className="whitespace-pre-wrap break-words text-xs">{content.body}</pre>
          </details>
        </>
      ) : (
        <pre className="whitespace-pre-wrap break-words text-xs">{content.body}</pre>
      )}
    </div>
  );
}
