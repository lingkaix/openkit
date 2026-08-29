import { type ReactNode, useState } from 'react';
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
  type StatusTone,
} from '../../primitives';
import { useArtifact } from '../goal/data';
import {
  isWorkspaceSyncEligible,
  useCurrentWorkspaceId,
  useSubmitWorkspaceRecoveryDecision,
  useSubmitWorkspaceSyncReviewDecision,
  useWorkspaceSyncProjection,
  useWorkspaces,
  type WorkspaceRecoveryDecision,
  type WorkspaceSyncProjection,
  type WorkspaceSyncReviewDecision,
  workspaceSyncCommandError,
  workspaceSyncStatusLabel,
} from './data';

const REVIEW_ACTIONS: ReadonlyArray<{
  label: string;
  decision: WorkspaceSyncReviewDecision;
}> = [
  { label: 'Accept', decision: 'accepted' },
  { label: 'Refine', decision: 'needs_refinement' },
  { label: 'Reject', decision: 'rejected' },
  { label: 'Block', decision: 'blocked' },
];

const RECOVERY_ACTIONS: ReadonlyArray<{
  label: string;
  decision: WorkspaceRecoveryDecision;
  outcome: string;
}> = [
  { label: 'Resume collection', decision: 'resume_collection', outcome: 'Recovered' },
  { label: 'Stage verified', decision: 'stage_verified', outcome: 'Recovered' },
  { label: 'Quarantine', decision: 'quarantine', outcome: 'Quarantined' },
  { label: 'Abandon', decision: 'abandon', outcome: 'Unrecoverable' },
];

/** Live selected-Workspace Workspace Sync review, apply, and recovery surface. */
export function WorkspaceChangesScreen() {
  const workspaces = useWorkspaces();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const workspace =
    workspaces.data?.find((candidate) => candidate.id === currentWorkspaceId) ?? null;
  const syncEligible = Boolean(workspace) && isWorkspaceSyncEligible(workspace);
  const projection = useWorkspaceSyncProjection(syncEligible && workspace ? workspace.id : null);
  const submitReview = useSubmitWorkspaceSyncReviewDecision();
  const submitRecovery = useSubmitWorkspaceRecoveryDecision();
  const { failed: disconnected } = useConnection();

  if (workspaces.isLoading || (syncEligible && projection.isLoading)) {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (workspaces.isError) {
    return (
      <Page>
        <WorkspaceChangesHeader />
        <ErrorBanner
          message="Couldn't load workspaces."
          onRetry={() => void workspaces.refetch()}
        />
      </Page>
    );
  }

  if (!workspace || !syncEligible) {
    return (
      <Page>
        <EmptyState
          icon="file"
          title="Workspace changes is unavailable"
          hint="Create or select an eligible project Workspace."
        />
      </Page>
    );
  }

  const workspaceId = workspace.id;
  const reviewBound = submitReview.variables?.workspaceId === workspaceId;
  const recoveryBound = submitRecovery.variables?.workspaceId === workspaceId;
  const reviewPending = Boolean(submitReview.isPending && reviewBound);
  const recoveryPending = Boolean(submitRecovery.isPending && recoveryBound);
  const settling = projection.isFetching;
  const reviewBusy = reviewPending || settling || disconnected;
  const recoveryBusy = recoveryPending || settling || disconnected;
  const reviewError =
    submitReview.error && reviewBound
      ? workspaceSyncCommandError(submitReview.error, "Couldn't submit that review decision.")
      : null;
  const recoveryError =
    submitRecovery.error && recoveryBound
      ? workspaceSyncCommandError(submitRecovery.error, "Couldn't submit that recovery decision.")
      : null;

  /** Submits one review decision for this Workspace, then refetches authoritative rows. */
  async function decideReview(reviewId: string, decision: WorkspaceSyncReviewDecision) {
    try {
      await submitReview.mutateAsync({ workspaceId, reviewId, decision });
      await projection.refetch();
    } catch {
      // TanStack Query retains the typed error for an explicit read-only retry.
    }
  }

  /** Submits one recovery decision for this Workspace, then refetches authoritative rows. */
  async function decideRecovery(
    reconciliationRecordId: string,
    decision: WorkspaceRecoveryDecision
  ) {
    try {
      await submitRecovery.mutateAsync({ workspaceId, reconciliationRecordId, decision });
      await projection.refetch();
    } catch {
      // TanStack Query retains the typed error for an explicit read-only retry.
    }
  }

  /** Refetches authoritative rows without replaying a failed review command. */
  async function retryReview() {
    await projection.refetch();
    if (submitReview.variables?.workspaceId === workspaceId) submitReview.reset();
  }

  /** Refetches authoritative rows without replaying a failed recovery command. */
  async function retryRecovery() {
    await projection.refetch();
    if (submitRecovery.variables?.workspaceId === workspaceId) submitRecovery.reset();
  }

  return (
    <Page>
      <WorkspaceChangesHeader stale={disconnected || projection.isFetching} />

      {projection.isError ? (
        <ErrorBanner
          message="Couldn't load workspace changes."
          onRetry={() => void projection.refetch()}
        />
      ) : null}

      {projection.data ? (
        <WorkspaceSyncSections
          data={projection.data}
          reviewError={reviewError}
          recoveryError={recoveryError}
          reviewBusy={reviewBusy}
          recoveryBusy={recoveryBusy}
          onReview={(reviewId, decision) => void decideReview(reviewId, decision)}
          onRecovery={(recordId, decision) => void decideRecovery(recordId, decision)}
          onRetryReview={() => void retryReview()}
          onRetryRecovery={() => void retryRecovery()}
        />
      ) : null}
    </Page>
  );
}

/**
 * Renders grouped Workspace Sync summaries and the two independent decision workflows.
 *
 * @param props Authoritative projection plus independent review and recovery handlers.
 */
function WorkspaceSyncSections({
  data,
  reviewError,
  recoveryError,
  reviewBusy,
  recoveryBusy,
  onReview,
  onRecovery,
  onRetryReview,
  onRetryRecovery,
}: {
  data: WorkspaceSyncProjection;
  reviewError: string | null;
  recoveryError: string | null;
  reviewBusy: boolean;
  recoveryBusy: boolean;
  onReview: (reviewId: string, decision: WorkspaceSyncReviewDecision) => void;
  onRecovery: (reconciliationRecordId: string, decision: WorkspaceRecoveryDecision) => void;
  onRetryReview: () => void;
  onRetryRecovery: () => void;
}) {
  const [inspectedArtifactId, setInspectedArtifactId] = useState<string | null>(null);

  return (
    <>
      <section className="flex flex-col gap-3" aria-label="Reviews">
        <Eyebrow>Reviews</Eyebrow>
        {reviewError ? <ErrorBanner message={reviewError} onRetry={onRetryReview} /> : null}
        {data.reviews.length === 0 ? (
          <EmptyState
            icon="file"
            title="No reviews"
            hint="Staged worker changes waiting for a decision will appear here."
          />
        ) : (
          <Card className="py-0">
            {data.reviews.map((item) => (
              <ListRow key={item.review.id} className="items-start">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-fg-strong">{item.review.id}</p>
                  {item.review.status === 'pending' ? (
                    <>
                      <p className="text-xs text-fg-muted">{item.changeSet.id}</p>
                      <p className="text-xs text-fg-muted">{item.artifactId}</p>
                      {item.changeSet.changedPaths.map((path) => (
                        <ChangedPathPreview key={path.path} path={path} />
                      ))}
                      {item.patchPayload?.text ? (
                        <pre className="whitespace-pre-wrap font-mono text-xs text-fg-muted">
                          {item.patchPayload.text}
                        </pre>
                      ) : null}
                      <p className="text-sm text-fg">
                        {item.review.diffSummary.filesChanged} files changed, +
                        {item.review.diffSummary.additions} added, -
                        {item.review.diffSummary.deletions} deleted
                      </p>
                      <p className="text-sm text-fg">{item.review.riskSummary}</p>
                      {inspectedArtifactId === item.artifactId ? (
                        <InspectedWorkspaceArtifact artifactId={item.artifactId} />
                      ) : null}
                      {item.review.validation.map((check) => (
                        <p
                          key={`${check.command}:${check.status}`}
                          className="text-xs text-fg-muted"
                        >
                          {check.command} {check.status}
                        </p>
                      ))}
                    </>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={statusTone(item.review.status)} dot>
                    {workspaceSyncStatusLabel(item.review.status)}
                  </StatusChip>
                  {item.review.status === 'pending' ? (
                    <>
                      {REVIEW_ACTIONS.map((action) => (
                        <Button
                          key={action.decision}
                          size="sm"
                          variant={action.decision === 'accepted' ? 'accent' : 'outline'}
                          aria-label={`${action.label} ${item.review.id}`}
                          isDisabled={reviewBusy}
                          onPress={() => onReview(item.review.id, action.decision)}
                        >
                          {action.label}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Inspect ${item.artifactId}`}
                        onPress={() => setInspectedArtifactId(item.artifactId)}
                      >
                        Inspect
                      </Button>
                    </>
                  ) : null}
                </div>
              </ListRow>
            ))}
          </Card>
        )}
      </section>

      <SummaryRegion
        label="Input snapshots"
        emptyTitle="No input snapshots"
        emptyHint="Workspace input snapshots used for worker materialization will appear here."
      >
        {data.snapshots.map((snapshot) => (
          <ListRow key={snapshot.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">{snapshot.strategy}</p>
            <StatusChip tone="neutral">{snapshot.backend.kind}</StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <SummaryRegion
        label="Materializations"
        emptyTitle="No materializations"
        emptyHint="Materialization records for this Workspace will appear here."
      >
        {data.materializations.map((record) => (
          <ListRow key={record.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">{record.strategy}</p>
            <StatusChip tone="neutral">{record.backendKind}</StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <SummaryRegion
        label="Backend handles"
        emptyTitle="No backend handles"
        emptyHint="Redacted backend workspace handles will appear here."
      >
        {data.handles.map((handle) => (
          <ListRow key={handle.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">{handle.backendKind}</p>
            <StatusChip tone={statusTone(handle.cleanupStatus)}>
              {workspaceSyncStatusLabel(handle.cleanupStatus)}
            </StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <SummaryRegion
        label="Worker outputs"
        emptyTitle="No worker outputs"
        emptyHint="Collected worker output manifests will appear here."
      >
        {data.manifests.map((manifest) => (
          <ListRow key={manifest.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">
              {changedPathSummary(manifest.changedPaths)}
            </p>
            <StatusChip tone="neutral">{manifest.strategy}</StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <SummaryRegion
        label="Change sets"
        emptyTitle="No change sets"
        emptyHint="Collected workspace change sets will appear here."
      >
        {data.changeSets.map((changeSet) => (
          <ListRow key={changeSet.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">
              {changedPathSummary(changeSet.changedPaths)}
            </p>
            <StatusChip tone="neutral">{changeSet.strategy}</StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <SummaryRegion
        label="Staged reviews"
        emptyTitle="No staged reviews"
        emptyHint="Durable staged review rows will appear here."
      >
        {data.staged.map((review) => (
          <ListRow key={review.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">{review.id}</p>
            <StatusChip tone={statusTone(review.status)} dot>
              {workspaceSyncStatusLabel(review.status)}
            </StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <SummaryRegion
        label="Apply plans"
        emptyTitle="No apply plans"
        emptyHint="Review-gated apply plans will appear here."
      >
        {data.plans.map((plan) => (
          <ListRow key={plan.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">{plan.plannedWrites.join(', ')}</p>
            <StatusChip tone={statusTone(plan.approvalState)}>
              {workspaceSyncStatusLabel(plan.approvalState)}
            </StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <SummaryRegion
        label="Apply results"
        emptyTitle="No apply results"
        emptyHint="Authoritative apply results will appear here."
      >
        {data.results.map((result) => (
          <ListRow key={result.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">{result.appliedPaths.join(', ')}</p>
            <StatusChip tone={statusTone(result.status)}>
              {workspaceSyncStatusLabel(result.status)}
            </StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>

      <section className="flex flex-col gap-3" aria-label="Recovery">
        <Eyebrow>Recovery</Eyebrow>
        {recoveryError ? <ErrorBanner message={recoveryError} onRetry={onRetryRecovery} /> : null}
        {data.recovery.length === 0 ? (
          <EmptyState
            icon="alert"
            title="No recovery records"
            hint="Restart and backend-recovery records will appear here."
          />
        ) : (
          <Card className="py-0">
            {data.recovery.map((record) => (
              <ListRow key={record.id} className="items-start">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-fg-strong">{record.id}</p>
                  <p className="text-xs text-fg-muted">{record.backendReachability.status}</p>
                  {record.collectedOutputManifestIds.map((manifestId) => (
                    <p key={manifestId} className="text-xs text-fg-muted">
                      {manifestId}
                    </p>
                  ))}
                  {record.evidenceBundleIds.map((bundleId) => (
                    <p key={bundleId} className="text-xs text-fg-muted">
                      {bundleId}
                    </p>
                  ))}
                  {record.affectedRecordIds.map((affectedId) => (
                    <p key={affectedId} className="text-xs text-fg-muted">
                      {affectedId}
                    </p>
                  ))}
                  {record.requiredHumanDecision ? (
                    <p className="text-sm text-fg">{record.requiredHumanDecision}</p>
                  ) : null}
                  {record.retentionDecision ? (
                    <p className="text-xs text-fg-muted">{record.retentionDecision}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={statusTone(record.stateAfter)} dot>
                    {workspaceSyncStatusLabel(record.stateAfter)}
                  </StatusChip>
                  {record.stateAfter === 'requires-human'
                    ? RECOVERY_ACTIONS.map((action) => {
                        const preview = recoveryDecisionEffects(action.outcome, record);
                        if (action.decision !== 'abandon') {
                          return (
                            <div
                              key={action.decision}
                              className="flex max-w-64 flex-col gap-1 rounded-ok border border-separator p-2"
                            >
                              <Button
                                size="sm"
                                variant={
                                  action.decision === 'resume_collection' ? 'accent' : 'outline'
                                }
                                aria-label={`${action.label} ${record.id}`}
                                aria-description={preview}
                                isDisabled={recoveryBusy}
                                onPress={() => onRecovery(record.id, action.decision)}
                              >
                                {action.label}
                              </Button>
                              <p className="text-xs text-fg-muted">{preview}</p>
                            </div>
                          );
                        }
                        return (
                          <Modal
                            key={action.decision}
                            trigger={
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`${action.label} ${record.id}`}
                                aria-description={preview}
                                isDisabled={recoveryBusy}
                              >
                                {action.label}
                                <span className="sr-only">{preview}</span>
                              </Button>
                            }
                          >
                            <Dialog title="Abandon recovery">
                              <p>
                                This recovery becomes unrecoverable. Teardown-backend proceeds and
                                retained evidence stays associated with this record.
                              </p>
                              <div className="flex justify-end gap-2">
                                <Button slot="close" variant="quiet">
                                  Cancel
                                </Button>
                                <Button
                                  slot="close"
                                  variant="negative"
                                  isDisabled={recoveryBusy}
                                  onPress={() => onRecovery(record.id, action.decision)}
                                >
                                  Abandon
                                </Button>
                              </div>
                            </Dialog>
                          </Modal>
                        );
                      })
                    : null}
                </div>
              </ListRow>
            ))}
          </Card>
        )}
      </section>

      <SummaryRegion
        label="Quarantine"
        emptyTitle="No quarantine records"
        emptyHint="Quarantined workspace-sync output will appear here."
      >
        {data.quarantine.map((record) => (
          <ListRow key={record.id}>
            <p className="min-w-0 flex-1 text-sm text-fg">
              {workspaceSyncStatusLabel(record.failureKind)}
            </p>
            <StatusChip tone={statusTone(record.resolution)}>
              {workspaceSyncStatusLabel(record.resolution)}
            </StatusChip>
          </ListRow>
        ))}
      </SummaryRegion>
    </>
  );
}

/**
 * Renders one read-only Workspace Sync collection as product summaries.
 *
 * @param props Region label, empty copy, and summary rows.
 */
function SummaryRegion({
  label,
  emptyTitle,
  emptyHint,
  children,
}: {
  label: string;
  emptyTitle: string;
  emptyHint: string;
  children: ReactNode;
}) {
  const rows = Array.isArray(children) ? children : [children];
  const hasRows = rows.filter(Boolean).length > 0;
  return (
    <section className="flex flex-col gap-3" aria-label={label}>
      <Eyebrow>{label}</Eyebrow>
      {hasRows ? (
        <Card className="py-0">{children}</Card>
      ) : (
        <EmptyState icon="file" title={emptyTitle} hint={emptyHint} />
      )}
    </section>
  );
}

/** Renders the Workspace changes header and stale-state evidence. */
function WorkspaceChangesHeader({ stale = false }: { stale?: boolean }) {
  return (
    <PageHeader
      eyebrow="Workspace"
      title="Workspace changes"
      subtitle="Review staged worker changes, apply outcomes, and recovery decisions for the selected Workspace."
      actions={stale ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
    />
  );
}

type ChangedPath = WorkspaceSyncProjection['reviews'][number]['changeSet']['changedPaths'][number];
type RecoveryRecord = WorkspaceSyncProjection['recovery'][number];

/**
 * Renders one pending-review changed path with row-scoped status and effect fields.
 *
 * @param props One change-set path from the authoritative pending review.
 */
function ChangedPathPreview({ path }: { path: ChangedPath }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      <p className="text-sm text-fg">{path.path}</p>
      {path.oldPath ? <p className="text-xs text-fg-muted">{path.oldPath}</p> : null}
      <StatusChip tone="neutral">{workspaceSyncStatusLabel(path.status)}</StatusChip>
      {path.binaryReview ? (
        <>
          <p className="text-xs text-fg">{path.binaryReview.summary}</p>
          <p className="text-xs text-fg-muted">
            {workspaceSyncStatusLabel(path.binaryReview.mode)}
          </p>
          <p className="text-xs text-fg-muted">
            {workspaceSyncStatusLabel(path.binaryReview.reason)}
          </p>
        </>
      ) : null}
      {path.oldPermissions ? <p className="text-xs text-fg-muted">{path.oldPermissions}</p> : null}
      {path.newPermissions ? <p className="text-xs text-fg-muted">{path.newPermissions}</p> : null}
    </div>
  );
}

/**
 * Reads and renders one Artifact's exact title and content after Inspect.
 *
 * @param props Artifact id from the pending review row.
 */
function InspectedWorkspaceArtifact({ artifactId }: { artifactId: string }) {
  const workspaceId = useCurrentWorkspaceId();
  const artifact = useArtifact(workspaceId, artifactId);
  if (artifact.isLoading && artifact.data === undefined) {
    return <Skeleton lines={4} />;
  }
  if (artifact.isError || !artifact.data) {
    return (
      <ErrorBanner message="Couldn't load that artifact." onRetry={() => void artifact.refetch()} />
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-sm font-bold text-fg-strong">{artifact.data.title}</p>
      <pre className="whitespace-pre-wrap text-sm text-fg">{artifact.data.content.body}</pre>
    </div>
  );
}

/**
 * Builds action-scoped recovery outcome, teardown, and retained-evidence copy.
 *
 * @param outcome Terminal state label for this decision.
 * @param record Authoritative reconciliation record that owns the evidence ids.
 * @returns Isolated preview text associated with one recovery control.
 */
function recoveryDecisionEffects(outcome: string, record: RecoveryRecord): string {
  return `${outcome}. Teardown-backend. Retains evidence ${record.evidenceBundleIds.join(' ')} ${record.collectedOutputManifestIds.join(' ')}`;
}

/**
 * Joins product-safe changed paths for a summary row.
 *
 * @param paths Changed-path records from a manifest or change set.
 * @returns Comma-separated relative paths.
 */
function changedPathSummary(paths: ReadonlyArray<{ path: string }>): string {
  return paths.map((entry) => entry.path).join(', ');
}

/**
 * Maps a durable status token to the Design status chip tone.
 *
 * @param value Server-owned status or kind token.
 * @returns Semantic chip tone.
 */
function statusTone(value: string): StatusTone {
  switch (value) {
    case 'accepted':
    case 'applied':
    case 'approved':
    case 'recovered':
    case 'released_to_review':
      return 'positive';
    case 'pending':
    case 'needs_refinement':
    case 'requires-human':
    case 'retained':
      return 'notice';
    case 'rejected':
    case 'blocked':
    case 'conflicted':
    case 'failed':
    case 'unrecoverable':
    case 'quarantined':
    case 'discarded':
      return 'negative';
    default:
      return 'neutral';
  }
}
