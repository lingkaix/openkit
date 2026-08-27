import { Button, Card, Eyebrow } from '../../primitives';
import type { WorkspaceMaterialRevision } from './data';

/** Inputs for the immutable revision list and its client-only comparison action. */
export interface RevisionHistoryProps {
  /** Immutable summaries returned by Core. */
  revisions: WorkspaceMaterialRevision[];
  /** Revision currently opened in the read-only viewer. */
  selectedRevisionId: string | null;
  /** Opens one exact revision by server id. */
  onOpen: (revisionId: string) => void;
  /** Starts a local comparison of two immutable revisions. */
  onCompare: () => void;
}

/**
 * Presents immutable revision identities without adding a client-side ledger.
 *
 * @param props - Revision inputs and client-only open and comparison callbacks.
 * @returns An immutable revision/comparison projection that does not mutate Material authority.
 */
export function RevisionHistory({
  revisions,
  selectedRevisionId,
  onOpen,
  onCompare,
}: RevisionHistoryProps) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>Revision history</Eyebrow>
        <Button size="sm" variant="outline" isDisabled={revisions.length < 2} onPress={onCompare}>
          Compare revisions
        </Button>
      </div>
      <div className="mt-3 flex max-h-48 flex-col gap-1 overflow-y-auto">
        {revisions.length === 0 ? (
          <p className="text-sm text-fg-muted">No saved revisions yet.</p>
        ) : (
          revisions.map((revision) => (
            <Button
              key={revision.revisionId}
              size="sm"
              variant={revision.revisionId === selectedRevisionId ? 'outline' : 'quiet'}
              className="justify-start rounded-ok text-left"
              aria-pressed={revision.revisionId === selectedRevisionId}
              onPress={() => onOpen(revision.revisionId)}
            >
              <span className="font-mono">{revision.revisionId}</span>
              <span className="ml-auto text-fg-muted">{revision.contentDigest.slice(0, 15)}</span>
            </Button>
          ))
        )}
      </div>
    </Card>
  );
}
