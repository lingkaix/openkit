import { ApiCallError, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { chatThreadPath, useCurrentWorkspaceId, useWorkspaces } from '../chat/data';
import { projectSafeValue } from '../settings/secret-safe';

/** Stable TanStack Query keys for recovery reads and shell search. */
export const operationsKeys = {
  workers: ['operations', 'interrupted-workers'] as const,
  admissions: (workspaceId: string) => ['operations', 'scheduler-admissions', workspaceId] as const,
  search: (query: string) => ['operations', 'search', query] as const,
};

/** Product-safe recovery choice label projected from the server action set. */
export type RecoveryWorkerChoice = {
  kind: 'inspect' | 'retry' | 'request_human';
  label: string;
};

/** Product-safe interrupted-worker row for the Recovery surface. */
export type RecoveryWorkerRow = {
  checkpointId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  diagnosticsSummary: string;
  stage: string;
  contextDigest: string;
  stopReason: string;
  choices: RecoveryWorkerChoice[];
  canInspect: boolean;
  canRetry: boolean;
};

/** Product-safe scheduler admission row for the Recovery surface. */
export type RecoveryAdmissionRow = {
  queueEntryId: string;
  workspaceId: string;
  requestedAgentId: string;
  status: 'queued' | 'denied';
};

/** Product-safe app search hit projected for shell navigation. */
export type AppSearchHit = {
  kind: 'workspace' | 'thread' | 'knowledge' | 'artifact' | 'item';
  id: string;
  title: string;
  workspaceId?: string;
  threadId?: string;
};

/** Exact interrupted-worker retry command, including stable request identity. */
export type RetryInterruptedWorkerInput = {
  workspaceId: string;
  threadId: string;
  turnId: string;
  requestId: string;
};

/** Frozen worker release command bound to one originating row. */
export type FrozenWorkerRelease = RetryInterruptedWorkerInput & {
  checkpointId: string;
};

/** Exact scheduler admission mutation target. */
export type SchedulerAdmissionTarget = {
  workspaceId: string;
  queueEntryId: string;
};

/** Re-export selected-Workspace discovery for Recovery. */
export { createRequestId, useCurrentWorkspaceId, useWorkspaces };

/**
 * Projects a value to a DOM-safe string, dropping secrets, paths, and non-text.
 *
 * @param value Arbitrary API field.
 * @returns Safe display string, or empty when nothing public remains.
 */
export function safeText(value: unknown): string {
  const projected = projectSafeValue(value);
  return typeof projected === 'string' ? projected : '';
}

/**
 * Returns whether an error is the interrupted-worker `recovery_required` contract.
 *
 * @param error Unknown mutation failure.
 * @returns True only for the typed recovery-required code.
 */
export function isRecoveryRequired(error: unknown): boolean {
  return error instanceof ApiCallError && error.code === 'recovery_required';
}

/**
 * Maps an interrupted-worker mutation failure to public action copy.
 *
 * @param error Unknown mutation failure.
 * @returns Safe message with no private server text.
 */
export function workerActionMessage(error: unknown): string {
  if (isRecoveryRequired(error)) return 'Recovery required';
  return "Couldn't release the checkpoint.";
}

/**
 * Maps a scheduler mutation failure to public action copy.
 *
 * @param error Unknown mutation failure.
 * @param action Retry or cancel that produced the failure.
 * @returns Safe message with no private server text.
 */
export function schedulerActionMessage(error: unknown, action: 'retry' | 'cancel'): string {
  if (error instanceof ApiCallError && error.code === 'workspace_access_denied') {
    return 'Access denied.';
  }
  return action === 'retry'
    ? "Couldn't retry scheduler admission."
    : "Couldn't cancel scheduler admission.";
}

/**
 * Returns the candidate Workspace id only when authorized discovery already admitted it.
 *
 * @param workspaces Authorized Workspace records, or undefined before discovery settles.
 * @param candidateId Search-hit Workspace identity.
 * @returns The authorized id, or undefined when discovery has not admitted it.
 */
export function authorizedWorkspaceId(
  workspaces: readonly { id: string }[] | undefined,
  candidateId: string | undefined
): string | undefined {
  if (!candidateId || !workspaces) return undefined;
  return workspaces.find((workspace) => workspace.id === candidateId)?.id;
}

/**
 * Resolves one search hit to an in-app route.
 *
 * @param hit Product-safe search hit.
 * @returns Live route for that kind.
 */
export function pathForSearchHit(hit: AppSearchHit): string {
  switch (hit.kind) {
    case 'thread':
      return hit.workspaceId ? chatThreadPath(hit.workspaceId, hit.id) : `/chat/${hit.id}`;
    case 'workspace':
      return '/';
    case 'knowledge':
      return '/knowledge';
    case 'artifact':
      return '/artifacts';
    case 'item':
      return hit.threadId && hit.workspaceId
        ? chatThreadPath(hit.workspaceId, hit.threadId)
        : hit.threadId
          ? `/chat/${hit.threadId}`
          : '/chat';
  }
}

/**
 * Lists interrupted workers through `listInterruptedWorkers` and keeps only public fields.
 *
 * @param workspaceId Validated selected Workspace, or null before discovery settles.
 * @returns TanStack query of product-safe worker rows.
 */
export function useInterruptedWorkers(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: operationsKeys.workers,
    queryFn: async (): Promise<RecoveryWorkerRow[]> => {
      const payload = await client.app.listInterruptedWorkers();
      return payload.items.flatMap((item) => {
        const checkpointId = safeText(item.checkpointId);
        const rowWorkspaceId = safeText(item.workspaceId);
        const threadId = safeText(item.threadId);
        const turnId = safeText(item.turnId);
        if (!checkpointId || !rowWorkspaceId || !threadId || !turnId) return [];
        const choices = (item.choices ?? []).flatMap((choice) => {
          const label = safeText(choice.label);
          if (!label) return [];
          return [{ kind: choice.kind, label }];
        });
        return [
          {
            checkpointId,
            workspaceId: rowWorkspaceId,
            threadId,
            turnId,
            diagnosticsSummary: safeText(item.diagnosticsSummary),
            stage: safeText(item.stage),
            contextDigest: safeText(item.contextDigest),
            stopReason: safeText(item.stopReason),
            choices,
            canInspect: choices.some((choice) => choice.kind === 'inspect'),
            canRetry: choices.some((choice) => choice.kind === 'retry'),
          },
        ];
      });
    },
    enabled: Boolean(workspaceId),
    retry: false,
  });
}

/**
 * Lists selected-Workspace scheduler admissions through `listSchedulerAdmissions`.
 *
 * @param workspaceId Validated selected Workspace, or null before discovery settles.
 * @returns TanStack query of product-safe admission rows.
 */
export function useSchedulerAdmissions(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: operationsKeys.admissions(workspaceId ?? ''),
    queryFn: async (): Promise<RecoveryAdmissionRow[]> => {
      const payload = await client.app.listSchedulerAdmissions(workspaceId as string);
      return payload.items.flatMap((item) => {
        if (item.status !== 'queued' && item.status !== 'denied') return [];
        return [
          {
            queueEntryId: safeText(item.queueEntryId),
            workspaceId: safeText(item.workspaceId),
            requestedAgentId: safeText(item.requestedAgentId),
            status: item.status,
          },
        ];
      });
    },
    enabled: Boolean(workspaceId),
    retry: false,
  });
}

/**
 * Releases one interrupted worker through `retryInterruptedWorkerCheckpoint`.
 *
 * @returns Mutation that does not project the command result into the DOM.
 */
export function useRetryInterruptedWorker() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: RetryInterruptedWorkerInput) =>
      client.app.retryInterruptedWorkerCheckpoint(input.workspaceId, input.threadId, input.turnId, {
        requestId: input.requestId,
      }),
    retry: false,
  });
}

/**
 * Requeues one denied scheduler admission through `retrySchedulerAdmission`.
 *
 * @returns Mutation over the typed client; settlement stays with the admissions read.
 */
export function useRetrySchedulerAdmission() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: SchedulerAdmissionTarget) =>
      client.app.retrySchedulerAdmission(input.workspaceId, input.queueEntryId),
    retry: false,
  });
}

/**
 * Cancels one queued or denied scheduler admission through `cancelSchedulerAdmission`.
 *
 * @returns Mutation over the typed client; settlement stays with the admissions read.
 */
export function useCancelSchedulerAdmission() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: SchedulerAdmissionTarget) =>
      client.app.cancelSchedulerAdmission(input.workspaceId, input.queueEntryId),
    retry: false,
  });
}

/**
 * Searches App read models through `searchApp` (`client.app.search`).
 *
 * @param query Submitted search string; the query stays idle until non-empty.
 * @returns TanStack query of product-safe hits.
 */
export function useAppSearch(query: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: operationsKeys.search(query),
    queryFn: async (): Promise<AppSearchHit[]> => {
      const payload = await client.app.search(query);
      return payload.items.map((item) => ({
        kind: item.kind,
        id: safeText(item.id),
        title: safeText(item.title),
        ...(item.workspaceId ? { workspaceId: safeText(item.workspaceId) } : {}),
        ...(item.threadId ? { threadId: safeText(item.threadId) } : {}),
      }));
    },
    enabled: query.length > 0,
    retry: false,
  });
}
