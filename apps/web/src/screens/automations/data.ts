import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useCoreClient } from '../../app/core-client';

/** Server-owned definition and bounded history projections. */
export type Automation = Awaited<
  ReturnType<CoreClient['operations']['automation.list']>
>['items'][number];
export type HistoryItem = Awaited<
  ReturnType<CoreClient['operations']['automation.history']>
>['items'][number];
/** Exact operation inputs, including the read definition revision on every update. */
export type AutomationCommand =
  | { kind: 'create'; input: Parameters<CoreClient['operations']['automation.create']>[0] }
  | { kind: 'update'; input: Parameters<CoreClient['operations']['automation.update']>[0] }
  | { kind: 'delete'; input: Parameters<CoreClient['operations']['automation.delete']>[0] }
  | { kind: 'cancel'; input: Parameters<CoreClient['operations']['scheduler.cancel']>[0] };

/** Workspace-separated cache identity even though Core lists all authorized Workspaces. */
export const automationKeys = {
  list: (workspaceId: string) => ['automations', workspaceId] as const,
  history: (workspaceId: string, id: string) =>
    ['automations', workspaceId, 'history', id] as const,
};

/** Reads only the selected Workspace into its cache, with no previous-Workspace placeholder. */
export function useAutomations(workspaceId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: automationKeys.list(workspaceId),
    queryFn: async ({ signal }) => {
      const result = await client.operations['automation.list']({});
      signal.throwIfAborted();
      return result.items.filter((record) => record.workspaceId === workspaceId);
    },
    retry: false,
    refetchOnMount: 'always',
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

/** Pages exact retained ranges and individual outcomes without expanding missed instants. */
export function useAutomationHistory(workspaceId: string, id: string) {
  const client = useCoreClient();
  return useInfiniteQuery({
    queryKey: automationKeys.history(workspaceId, id),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const result = await client.operations['automation.history']({
        automationId: id,
        limit: 32,
        ...(pageParam ? { before: pageParam } : {}),
      });
      signal.throwIfAborted();
      return result;
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    retry: false,
  });
}

/** Serializes one form's submissions before React renders its pending state; never retries a write. */
export function useAutomationCommand(workspaceId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const pending = useRef(false);
  const mutation = useMutation({
    mutationFn: async (command: AutomationCommand) => {
      if (command.kind === 'create') return client.operations['automation.create'](command.input);
      if (command.kind === 'update') return client.operations['automation.update'](command.input);
      if (command.kind === 'delete') return client.operations['automation.delete'](command.input);
      return client.operations['scheduler.cancel'](command.input);
    },
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: automationKeys.list(workspaceId) });
    },
    onSettled: () => {
      pending.current = false;
    },
  });
  return {
    ...mutation,
    submit: (command: AutomationCommand, onSuccess?: () => void) => {
      if (pending.current) return;
      pending.current = true;
      mutation.mutate(command, { onSuccess: () => onSuccess?.() });
    },
  };
}

/** Only definite client refusals permit correction without first inspecting an uncertain write. */
export function automationOutcomeUnknown(error: unknown): boolean {
  return (
    !(error instanceof ApiCallError) ||
    error.status < 400 ||
    error.status >= 500 ||
    error.status === 408
  );
}

/** Fixed product copy; dependency messages and attempt summaries are never rendered. */
export function automationError(error: unknown, action = false): string {
  if (action && automationOutcomeUnknown(error))
    return 'Outcome unknown. Refresh and inspect the current definitions and history before another action.';
  if (error instanceof ApiCallError) {
    if (error.status === 401 || error.status === 403) return 'Access denied.';
    if (error.status === 409)
      return 'The automation changed or the requested transition is unavailable. Refresh before continuing.';
    return action
      ? 'The change was refused. Check the input and refresh before continuing.'
      : "Couldn't load automations. Try refreshing.";
  }
  return "Couldn't reach NanoCore. Refresh when the connection returns.";
}
