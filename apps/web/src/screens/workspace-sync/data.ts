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
  CoreClient['app']['submitWorkspaceSyncReviewDecision']
>[2]['decision'];

/** Human recovery decision submitted by the Workspace changes surface. */
export type WorkspaceRecoveryDecision = Parameters<
  CoreClient['app']['submitWorkspaceRecoveryDecision']
>[2]['decision'];

/** Joined selected-Workspace Workspace Sync collections used by the product UI. */
export type WorkspaceSyncProjection = {
  reviews: Awaited<ReturnType<CoreClient['app']['listWorkspaceSyncReviews']>>['items'];
  snapshots: Awaited<ReturnType<CoreClient['app']['listWorkspaceInputSnapshots']>>['items'];
  materializations: Awaited<
    ReturnType<CoreClient['app']['listWorkspaceMaterializationRecords']>
  >['items'];
  handles: Awaited<ReturnType<CoreClient['app']['listBackendWorkspaceHandles']>>['items'];
  manifests: Awaited<ReturnType<CoreClient['app']['listWorkerOutputManifests']>>['items'];
  changeSets: Awaited<ReturnType<CoreClient['app']['listWorkspaceChangeSets']>>['items'];
  staged: Awaited<ReturnType<CoreClient['app']['listStagedWorkspaceReviews']>>['items'];
  plans: Awaited<ReturnType<CoreClient['app']['listWorkspaceApplyPlans']>>['items'];
  results: Awaited<ReturnType<CoreClient['app']['getWorkspaceApplyResult']>>[];
  recovery: Awaited<ReturnType<CoreClient['app']['listWorkspaceReconciliationRecords']>>['items'];
  quarantine: Awaited<ReturnType<CoreClient['app']['listWorkspaceQuarantineRecords']>>['items'];
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
      client.app.submitWorkspaceSyncReviewDecision(input.workspaceId, input.reviewId, {
        decision: input.decision,
        requestId: createRequestId(),
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
      client.app.submitWorkspaceRecoveryDecision(input.workspaceId, input.reconciliationRecordId, {
        decision: input.decision,
        requestId: createRequestId(),
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
    client.app.listWorkspaceSyncReviews(workspaceId),
    client.app.listWorkspaceInputSnapshots(workspaceId),
    client.app.listWorkspaceMaterializationRecords(workspaceId),
    client.app.listBackendWorkspaceHandles(workspaceId),
    client.app.listWorkerOutputManifests(workspaceId),
    client.app.listWorkspaceChangeSets(workspaceId),
    client.app.listStagedWorkspaceReviews(workspaceId),
    client.app.listWorkspaceApplyPlans(workspaceId),
    client.app.listWorkspaceApplyResults(workspaceId),
    client.app.listWorkspaceReconciliationRecords(workspaceId),
    client.app.listWorkspaceQuarantineRecords(workspaceId),
  ]);

  const detailedPending = await Promise.all(
    reviews.items
      .filter((item) => item.review.status === 'pending')
      .map((item) => client.app.getWorkspaceSyncReview(workspaceId, item.review.id))
  );
  const pendingById = new Map(detailedPending.map((item) => [item.review.id, item]));

  const detailedResults = await Promise.all(
    results.items.map((item) => client.app.getWorkspaceApplyResult(workspaceId, item.id))
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
