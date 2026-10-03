import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId, useWorkspaces } from '../chat/data';

/** Query keys for the selected-Workspace Workspace changes projection. */
export const workspaceSyncKeys = {
  projection: (workspaceId: string) => ['workspace-sync', workspaceId] as const,
};

/** Durable review decision submitted by the Workspace changes surface. */
export type WorkspaceSyncReviewDecision = Parameters<
  CoreClient['operations']['sync.review-decide']
>[0]['decision'];

/** Human recovery decision submitted by the Workspace changes surface. */
export type WorkspaceRecoveryDecision = Parameters<
  CoreClient['operations']['sync.recovery-decide']
>[0]['decision'];

/** Joined selected-Workspace Workspace Sync collections used by the product UI. */
export type WorkspaceSyncProjection = {
  reviews: Awaited<ReturnType<CoreClient['operations']['sync.review-list']>>['items'];
  snapshots: Awaited<ReturnType<CoreClient['operations']['sync.input-snapshot-list']>>['items'];
  materializations: Awaited<
    ReturnType<CoreClient['operations']['sync.materialization-list']>
  >['items'];
  handles: Awaited<ReturnType<CoreClient['operations']['sync.backend-handle-list']>>['items'];
  manifests: Awaited<ReturnType<CoreClient['operations']['sync.output-manifest-list']>>['items'];
  changeSets: Awaited<ReturnType<CoreClient['operations']['sync.change-set-list']>>['items'];
  staged: Awaited<ReturnType<CoreClient['operations']['sync.staged-review-list']>>['items'];
  plans: Awaited<ReturnType<CoreClient['operations']['sync.apply-plan-list']>>['items'];
  results: Awaited<ReturnType<CoreClient['operations']['sync.apply-result-read']>>[];
  recovery: Awaited<ReturnType<CoreClient['operations']['sync.reconciliation-list']>>['items'];
  quarantine: Awaited<ReturnType<CoreClient['operations']['sync.quarantine-list']>>['items'];
};

/** Re-export selected-Workspace discovery for the Workspace changes screen. */
export { useCurrentWorkspaceId, useWorkspaces };

/**
 * Returns whether the selected Workspace may publish Workspace Sync reads and actions.
 *
 * @param workspace Selected Workspace record, or null when unresolved.
 * @returns False for Quick Chat; true for ordinary Workspace kinds.
 */
export function isWorkspaceSyncEligible(workspace: { kind: string } | null | undefined): boolean {
  return workspace != null && workspace.kind !== 'quick-chat';
}

/**
 * Loads every Workspace Sync collection for one validated, Sync-eligible Workspace.
 *
 * @param workspaceId Validated selected Workspace id, or null when unresolved or ineligible.
 * @returns TanStack Query for the grouped Workspace changes projection.
 */
export function useWorkspaceSyncProjection(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceSyncKeys.projection(workspaceId ?? ''),
    queryFn: () => loadWorkspaceSyncProjection(client, workspaceId as string),
    enabled: Boolean(workspaceId),
    retry: false,
  });
}

/** @returns Mutation that records one Workspace Sync review decision. */
export function useSubmitWorkspaceSyncReviewDecision() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: {
      workspaceId: string;
      reviewId: string;
      decision: WorkspaceSyncReviewDecision;
    }) =>
      client.operations['sync.review-decide']({
        workspaceId: input.workspaceId,
        reviewId: input.reviewId,
        ...{
          decision: input.decision,
          requestId: createRequestId(),
        },
      }),
    retry: false,
  });
}

/** @returns Mutation that records one Workspace recovery decision. */
export function useSubmitWorkspaceRecoveryDecision() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: {
      workspaceId: string;
      reconciliationRecordId: string;
      decision: WorkspaceRecoveryDecision;
    }) =>
      client.operations['sync.recovery-decide']({
        workspaceId: input.workspaceId,
        reconciliationRecordId: input.reconciliationRecordId,
        ...{
          decision: input.decision,
          requestId: createRequestId(),
        },
      }),
    retry: false,
  });
}

/**
 * Maps a typed command failure to product-safe copy without server-private text.
 *
 * @param error Command failure retained by TanStack Query.
 * @param fallback Plain-language fallback when the code is not a known typed failure.
 * @returns Safe banner copy.
 */
export function workspaceSyncCommandError(error: unknown, fallback: string): string {
  if (error instanceof ApiCallError && error.code === 'recovery_required') {
    return 'Recovery required';
  }
  if (error instanceof ApiCallError && error.code === 'idempotency_key_conflict') {
    return 'Request conflict';
  }
  if (error instanceof ApiCallError && error.code === 'workspace_access_denied') {
    return 'Workspace access denied';
  }
  return fallback;
}

/**
 * Turns a durable status or kind token into a short product label.
 *
 * @param value Server-owned token using hyphens or underscores.
 * @returns Sentence-style label for chips and summaries.
 */
export function workspaceSyncStatusLabel(value: string): string {
  const spaced = value.replace(/[_-]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Reads every Workspace Sync collection, then authoritative pending-review and
 * apply-result rows, without copying host paths, runtime handles, or secrets.
 *
 * @param client Composed Core client.
 * @param workspaceId Validated Workspace id.
 * @returns Grouped product summaries for the Workspace changes screen.
 */
async function loadWorkspaceSyncProjection(
  client: CoreClient,
  workspaceId: string
): Promise<WorkspaceSyncProjection> {
  const [
    reviews,
    snapshots,
    materializations,
    handles,
    manifests,
    changeSets,
    staged,
    plans,
    results,
    recovery,
    quarantine,
  ] = await Promise.all([
    client.operations['sync.review-list']({ workspaceId: workspaceId }),
    client.operations['sync.input-snapshot-list']({ workspaceId: workspaceId }),
    client.operations['sync.materialization-list']({ workspaceId: workspaceId }),
    client.operations['sync.backend-handle-list']({ workspaceId: workspaceId }),
    client.operations['sync.output-manifest-list']({ workspaceId: workspaceId }),
    client.operations['sync.change-set-list']({ workspaceId: workspaceId }),
    client.operations['sync.staged-review-list']({ workspaceId: workspaceId }),
    client.operations['sync.apply-plan-list']({ workspaceId: workspaceId }),
    client.operations['sync.apply-result-list']({ workspaceId: workspaceId }),
    client.operations['sync.reconciliation-list']({ workspaceId: workspaceId }),
    client.operations['sync.quarantine-list']({ workspaceId: workspaceId }),
  ]);

  const detailedPending = await Promise.all(
    reviews.items
      .filter((item) => item.review.status === 'pending')
      .map((item) =>
        client.operations['sync.review-read']({
          workspaceId: workspaceId,
          reviewId: item.review.id,
        })
      )
  );
  const pendingById = new Map(detailedPending.map((item) => [item.review.id, item]));

  const detailedResults = await Promise.all(
    results.items.map((item) =>
      client.operations['sync.apply-result-read']({
        workspaceId: workspaceId,
        applyResultId: item.id,
      })
    )
  );

  return {
    reviews: reviews.items.map((item) => pendingById.get(item.review.id) ?? item),
    snapshots: snapshots.items,
    materializations: materializations.items,
    handles: handles.items,
    manifests: manifests.items,
    changeSets: changeSets.items,
    staged: staged.items,
    plans: plans.items,
    results: detailedResults,
    recovery: recovery.items,
    quarantine: quarantine.items,
  };
}
