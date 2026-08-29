import { useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Gallery,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
} from '../../primitives';
import {
  type AepSnapshotDetailRow,
  type AepSnapshotListRow,
  type EvidenceBundleRow,
  type RuntimeEvidenceRow,
  useAepSnapshotDetail,
  useAepSnapshots,
  useCurrentWorkspaceId,
  useEvidenceBundles,
  useRuntimeEvidence,
  useWorkspaces,
} from './data';

/** Settings home for the component catalog and selected-Workspace inspection reads. */
export function DebugScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const bundles = useEvidenceBundles(workspaceId);
  const runtime = useRuntimeEvidence(workspaceId);
  const snapshots = useAepSnapshots(workspaceId);
  const [selection, setSelection] = useState<{
    workspaceId: string;
    snapshotId: string;
  } | null>(null);
  const selectedSnapshotId =
    selection && workspaceId && selection.workspaceId === workspaceId ? selection.snapshotId : null;
  const snapshotDetail = useAepSnapshotDetail(workspaceId, selectedSnapshotId);

  return (
    <Page>
      <PageHeader
        eyebrow="Developer tools"
        title="Debug"
        subtitle="Component catalog and inspection tools."
      />
      <Gallery />

      {workspaces.isError ? (
        <ErrorBanner
          message="Couldn't load workspaces."
          onRetry={() => void workspaces.refetch()}
        />
      ) : workspaces.isLoading ? (
        <>
          <Skeleton lines={3} />
          <Skeleton lines={3} />
          <Skeleton lines={3} />
        </>
      ) : !workspaceId ? (
        <EmptyState
          icon="search"
          title="No workspace selected"
          hint="Select or create a Workspace to inspect its evidence and package snapshots."
        />
      ) : (
        <>
          <DebugList
            id="debug-evidence-bundles"
            title="Evidence bundles"
            emptyTitle="No evidence bundles"
            emptyHint="Workspace evidence summaries will appear here when collected."
            isLoading={bundles.isLoading}
            isError={bundles.isError}
            errorMessage="Couldn't load evidence bundles."
            onRetry={() => void bundles.refetch()}
          >
            {(bundles.data ?? []).map((bundle) => (
              <EvidenceRow key={bundle.id} bundle={bundle} />
            ))}
          </DebugList>

          <DebugList
            id="debug-runtime-evidence"
            title="Runtime evidence"
            emptyTitle="No runtime evidence"
            emptyHint="Workspace runtime summaries will appear here when collected."
            isLoading={runtime.isLoading}
            isError={runtime.isError}
            errorMessage="Couldn't load runtime evidence."
            onRetry={() => void runtime.refetch()}
          >
            {(runtime.data ?? []).map((record) => (
              <RuntimeRow key={record.id} record={record} />
            ))}
          </DebugList>

          <DebugList
            id="debug-aep-snapshots"
            title="Package snapshots"
            emptyTitle="No package snapshots"
            emptyHint="Agent Environment Package snapshots will appear here when recorded."
            isLoading={snapshots.isLoading}
            isError={snapshots.isError}
            errorMessage="Couldn't load package snapshots."
            onRetry={() => void snapshots.refetch()}
          >
            {(snapshots.data ?? []).map((snapshot) => (
              <SnapshotRow
                key={snapshot.snapshotId}
                snapshot={snapshot}
                selected={selectedSnapshotId === snapshot.snapshotId}
                onSelect={() => {
                  if (workspaceId) {
                    setSelection({ workspaceId, snapshotId: snapshot.snapshotId });
                  }
                }}
              />
            ))}
          </DebugList>

          {selectedSnapshotId ? (
            snapshotDetail.isLoading ? (
              <Skeleton lines={2} />
            ) : snapshotDetail.isError ? (
              <ErrorBanner
                message="Couldn't load package snapshot."
                onRetry={() => void snapshotDetail.refetch()}
              />
            ) : snapshotDetail.data ? (
              <SnapshotDetail detail={snapshotDetail.data} />
            ) : null
          ) : null}
        </>
      )}
    </Page>
  );
}

/**
 * Renders one independent Debug inspection family with its own loading, empty, and retry states.
 *
 * @param props Section identity, query state, and projected rows.
 */
function DebugList({
  id,
  title,
  emptyTitle,
  emptyHint,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  children,
}: {
  id: string;
  title: string;
  emptyTitle: string;
  emptyHint: string;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  const empty = !Array.isArray(children) || children.length === 0;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <h2 id={id} className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
        {title}
      </h2>
      {isLoading ? (
        <Skeleton lines={3} />
      ) : isError ? (
        <ErrorBanner message={errorMessage} onRetry={onRetry} />
      ) : empty ? (
        <EmptyState icon="search" title={emptyTitle} hint={emptyHint} />
      ) : (
        <Card className="py-0">{children}</Card>
      )}
    </section>
  );
}

/**
 * Renders one product-safe evidence-bundle summary.
 *
 * @param props Safe evidence-bundle row.
 */
function EvidenceRow({ bundle }: { bundle: EvidenceBundleRow }) {
  return (
    <ListRow>
      <p className="text-sm text-fg">{bundle.summary}</p>
    </ListRow>
  );
}

/**
 * Renders one product-safe runtime-evidence summary.
 *
 * @param props Safe runtime-evidence row.
 */
function RuntimeRow({ record }: { record: RuntimeEvidenceRow }) {
  return (
    <ListRow>
      <p className="text-sm text-fg">{record.summary}</p>
    </ListRow>
  );
}

/**
 * Renders one snapshot identity and selects it for the exact detail read.
 *
 * @param props Snapshot identity and selection callback.
 */
function SnapshotRow({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: AepSnapshotListRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <ListRow>
      <Button
        variant={selected ? 'outline' : 'quiet'}
        size="sm"
        aria-pressed={selected}
        onPress={onSelect}
      >
        {snapshot.snapshotId}
      </Button>
    </ListRow>
  );
}

/**
 * Renders the secret-safe AEP snapshot whitelist after the exact detail read.
 *
 * @param props Safe snapshot identity fields from the schema.
 */
function SnapshotDetail({ detail }: { detail: AepSnapshotDetailRow }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-fg">{detail.runtimeKind}</p>
      <p className="text-sm text-fg">{detail.packageId}</p>
    </div>
  );
}
