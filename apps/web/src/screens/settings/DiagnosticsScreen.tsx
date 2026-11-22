import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Card,
  EmptyState,
  InlineAlert,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
  ToggleButton,
} from '../../primitives';
import { threadPath } from '../chat/data';
import { ALL_COMPONENTS_PATH } from './AppearanceScreen';
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

/**
 * Server diagnostics: selected-Workspace evidence bundles, runtime evidence and package
 * snapshots. Component specimens live on the separate Components page (WEB-UX P14).
 */
export function DiagnosticsScreen() {
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
  const { state } = useLocation();
  const movedFromDebug = (state as { movedFrom?: string } | null)?.movedFrom === '/settings/debug';

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Diagnostics"
        subtitle="Evidence and package snapshots for the selected Workspace."
      />
      {movedFromDebug ? (
        <p className="text-sm text-fg-muted">
          The component gallery moved to{' '}
          <Link className="text-accent-content underline" to={ALL_COMPONENTS_PATH}>
            Appearance → All components
          </Link>
          .
        </p>
      ) : null}

      {workspaces.isError ? (
        <InlineAlert
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
          <DiagnosticsList
            id="diagnostics-evidence-bundles"
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
          </DiagnosticsList>

          <DiagnosticsList
            id="diagnostics-runtime-evidence"
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
          </DiagnosticsList>

          <DiagnosticsList
            id="diagnostics-aep-snapshots"
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
          </DiagnosticsList>

          {selectedSnapshotId ? (
            snapshotDetail.isLoading ? (
              <Skeleton lines={2} />
            ) : snapshotDetail.isError ? (
              <InlineAlert
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
 * Renders one independent Diagnostics inspection family with its own loading, empty, and retry states.
 *
 * @param props Section identity, query state, and projected rows.
 */
function DiagnosticsList({
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
      <h2 id={id} className="text-eyebrow font-bold tracking-eyebrow text-fg-muted">
        {title}
      </h2>
      {isLoading ? (
        <Skeleton lines={3} />
      ) : isError ? (
        <InlineAlert message={errorMessage} onRetry={onRetry} />
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
      <ToggleButton isQuiet size="sm" isSelected={selected} onPress={onSelect}>
        {snapshot.snapshotId}
      </ToggleButton>
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
      <Link
        className="text-sm text-accent underline"
        to={threadPath(detail.workspaceId, detail.threadId)}
      >
        Open Thread {detail.threadId}
      </Link>
      <p className="break-all text-sm text-fg">Turn: {detail.turnId}</p>
      <h3 className="text-sm font-bold text-fg">Recorded Skill supply</h3>
      <p className="text-xs text-fg-muted">
        These selections belong to this Turn's package, not the current catalog.
      </p>
      {detail.skills === null ? (
        <p>Skill lineage unavailable.</p>
      ) : detail.skills.length === 0 ? (
        <p>No Skills recorded.</p>
      ) : (
        detail.skills.map((skill) => (
          <div key={skill.id} className="flex flex-col gap-1">
            <p className="break-all text-sm text-fg">{skill.id}</p>
            <p className="break-all text-xs text-fg-muted">{skill.digest}</p>
            <p className="text-xs text-fg-muted">
              Selection source: {skill.selectionSource ?? 'Not recorded'}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
