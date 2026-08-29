import type {
  CoreClient,
  ListThreadItemsResponse,
  SseEventEnvelope,
  Thread,
} from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useConnectionFailure, useCoreClient } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';

/** One item in a thread's stream (the protocol Item union, via the response type). */
export type ThreadItem = ListThreadItemsResponse['items'][number];

/**
 * Chat/task data hooks (WP-4). All thread, item, and turn access flows through
 * `@openkit/core-client` under TanStack Query — server state is never copied into
 * Zustand (rebuild-stack data boundary). Query and lifecycle-mutation keys are
 * centralized so each command retains its exact owner and invalidates precisely.
 */
export const chatKeys = {
  workspaces: ['workspaces'] as const,
  threads: (workspaceId: string) => ['threads', workspaceId] as const,
  thread: (workspaceId: string, threadId: string) => ['thread', workspaceId, threadId] as const,
  items: (workspaceId: string, threadId: string) => ['items', workspaceId, threadId] as const,
  dashboard: (workspaceId: string, threadId: string) =>
    ['thread-dashboard', workspaceId, threadId] as const,
  feedback: (workspaceId: string, threadId: string, turnId: string) =>
    ['turn-feedback', workspaceId, threadId, turnId] as const,
  renameMutation: ['thread-lifecycle', 'rename'] as const,
  archiveMutation: ['thread-lifecycle', 'archive'] as const,
  interruptMutation: ['thread-lifecycle', 'interrupt'] as const,
};

/** List the workspaces the user can act in. */
export function useWorkspaces() {
  const client = useCoreClient();
  return useQuery({
    queryKey: chatKeys.workspaces,
    queryFn: async () => (await client.core.listWorkspaces()).items,
  });
}

/**
 * Returns the current Workspace selection when authorized, otherwise Quick Chat,
 * the first authorized Workspace, or null when discovery is unresolved or empty.
 */
export function useCurrentWorkspaceId(): string | null {
  const selected = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaces();
  if (!workspaces.isSuccess) return null;
  return (
    workspaces.data.find((workspace) => workspace.id === selected)?.id ??
    workspaces.data.find((workspace) => workspace.kind === 'quick-chat')?.id ??
    workspaces.data[0]?.id ??
    null
  );
}

/** List a workspace's threads (most recent first, as returned by Core). */
export function useThreads(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: chatKeys.threads(workspaceId ?? ''),
    queryFn: async () => (await client.core.listThreads(workspaceId as string)).items,
    enabled: Boolean(workspaceId),
  });
}

/** Load one thread record. */
export function useThread(workspaceId: string | null, threadId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: chatKeys.thread(workspaceId ?? '', threadId),
    queryFn: () => client.core.getThread(workspaceId as string, threadId),
    enabled: Boolean(workspaceId),
  });
}

/**
 * Load the authoritative dashboard projection for one thread.
 *
 * @param workspaceId Current Workspace identity, or null before selection resolves.
 * @param threadId Current Thread identity.
 * @param enabled Whether this observer may fetch instead of only following cached state.
 */
export function useThreadDashboard(workspaceId: string | null, threadId: string, enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: chatKeys.dashboard(workspaceId ?? '', threadId),
    queryFn: () => client.app.getThreadDashboard(workspaceId as string, threadId),
    enabled: Boolean(workspaceId) && enabled,
  });
}

/** Replay a thread's item stream. */
export function useThreadItems(workspaceId: string | null, threadId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: chatKeys.items(workspaceId ?? '', threadId),
    queryFn: async () => (await client.core.listThreadItems(workspaceId as string, threadId)).items,
    enabled: Boolean(workspaceId),
  });
}

/**
 * Folds the item-bearing subset of one validated turn event into cached items.
 *
 * @param items Current authoritative and transient thread items.
 * @param event One sequence-filtered Core Client event.
 * @returns The unchanged or updated item list with at most one instance per event item.
 */
function foldTurnEvent(items: ThreadItem[], event: SseEventEnvelope): ThreadItem[] {
  const data = event.data;

  if (data.type === 'item-created') {
    const item = ItemSchema.safeParse(data.item);
    if (!item.success) return items;
    const existing = items.findIndex((candidate) => candidate.id === item.data.id);
    if (existing === -1) return [...items, item.data];
    if (items[existing]?.status === 'completed') return items;
    return items.map((candidate, index) => (index === existing ? item.data : candidate));
  }

  if (data.type === 'item-delta' && data.deltaKind === 'text-delta') {
    return items.map((item) => {
      if (
        item.id !== data.itemId ||
        item.type !== 'assistant-message' ||
        item.status === 'completed'
      )
        return item;
      return { ...item, text: item.text + data.delta };
    });
  }

  if (data.type === 'item-completed') {
    const item = ItemSchema.safeParse(data.item);
    if (!item.success) return items;
    const existing = items.findIndex((candidate) => candidate.id === item.data.id);
    if (existing === -1) return [...items, item.data];
    return items.map((candidate, index) => (index === existing ? item.data : candidate));
  }

  return items;
}

/**
 * Subscribes once to the authoritative running Turn, folds item events into the
 * item cache, and projects its matching terminal Turn into the dashboard cache.
 *
 * @param workspaceId Current Workspace identity, or null before selection resolves.
 * @param threadId Current Thread identity.
 * @param enabled Whether an item cache value is available for dashboard discovery.
 * @param baselineReady Whether this mount has completed its first authoritative item fetch.
 */
export function useLiveThreadItems(
  workspaceId: string | null,
  threadId: string,
  enabled: boolean,
  baselineReady: boolean
): void {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const { clear, report } = useConnectionFailure();
  const [attempt, setAttempt] = useState(0);
  const dashboard = useThreadDashboard(
    workspaceId,
    threadId,
    enabled && !queryClient.getQueryData(chatKeys.dashboard(workspaceId ?? '', threadId))
  );
  const turnId = dashboard.data?.turns.findLast((turn) => turn.status === 'running')?.id;
  const owner = useMemo(() => ({ threadId, turnId, workspaceId }), [threadId, turnId, workspaceId]);

  useEffect(() => () => clear(owner), [clear, owner]);

  useEffect(() => {
    if (!workspaceId || !turnId || !baselineReady) return;

    let cancelled = false;
    let iterator: AsyncIterator<SseEventEnvelope> | null = null;

    void (async () => {
      try {
        const itemsKey = chatKeys.items(workspaceId, threadId);
        const dashboardKey = chatKeys.dashboard(workspaceId, threadId);
        iterator = client.core
          .subscribeTurnEvents({ workspaceId, threadId, turnId })
          [Symbol.asyncIterator]();

        while (!cancelled) {
          const next = await iterator.next();
          if (next.done) {
            if (!cancelled) clear(owner);
            break;
          }
          if (cancelled) break;
          clear(owner);
          const event = next.value;
          if (event.event === 'turn.completed') {
            const completedTurn = (
              event.data as {
                turn: Awaited<ReturnType<CoreClient['app']['getThreadDashboard']>>['turns'][number];
              }
            ).turn;
            await queryClient.cancelQueries({ queryKey: dashboardKey, exact: true });
            if (cancelled) break;
            queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['getThreadDashboard']>>>(
              dashboardKey,
              (dashboard) =>
                dashboard
                  ? {
                      ...dashboard,
                      turns: dashboard.turns.map((candidate) =>
                        candidate.id === turnId ? completedTurn : candidate
                      ),
                    }
                  : dashboard
            );
            continue;
          }
          await queryClient.cancelQueries({
            queryKey: itemsKey,
            exact: true,
          });
          if (cancelled) break;
          queryClient.setQueryData<ThreadItem[]>(itemsKey, (items) =>
            foldTurnEvent(items ?? [], next.value)
          );
        }
      } catch {
        if (!cancelled) report(owner, () => setAttempt(attempt + 1));
      }
    })();

    return () => {
      cancelled = true;
      void iterator?.return?.();
    };
  }, [
    attempt,
    baselineReady,
    clear,
    client,
    owner,
    queryClient,
    report,
    threadId,
    turnId,
    workspaceId,
  ]);
}

/**
 * Enter the route-selected Chat or Task mode, then refresh its projections.
 *
 * @returns A mutation whose variables retain the original route owner and input.
 */
export function useSendTurn() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      threadId: string;
      mode: 'chat' | 'task';
      message: string;
    }) => {
      if (input.mode === 'task') {
        await client.app.startTaskMode(input.workspaceId, input.threadId, {
          input: input.message,
        });
      } else {
        await client.app.startChatMode(input.workspaceId, input.threadId, {
          input: input.message,
        });
      }
    },
    onSuccess: (_response, input) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.items(input.workspaceId, input.threadId),
      });
      void queryClient.invalidateQueries({
        queryKey: chatKeys.dashboard(input.workspaceId, input.threadId),
      });
    },
  });
}

/**
 * Observe the last authoritative feedback response cached for one rendered Turn.
 *
 * @param workspaceId Workspace that owns the Turn.
 * @param threadId Thread that owns the Turn.
 * @param turnId Completed Turn identity, or null when no Turn is feedback-eligible.
 * @returns A disabled query observer updated only by successful feedback submissions.
 */
export function useTurnFeedback(workspaceId: string, threadId: string, turnId: string | null) {
  return useQuery<Awaited<ReturnType<CoreClient['app']['submitTurnFeedback']>>>({
    queryKey: chatKeys.feedback(workspaceId, threadId, turnId ?? ''),
    queryFn: skipToken,
  });
}

/**
 * Submit exact Turn feedback and cache only its matching authoritative response.
 *
 * @returns A mutation whose variables bind feedback to its original owner tuple.
 */
export function useSubmitTurnFeedback() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      threadId: string;
      turnId: string;
      rating: 'good' | 'bad';
    }) => {
      const response = await client.app.submitTurnFeedback(input.turnId, {
        rating: input.rating,
        note: null,
      });
      if (response.turnId !== input.turnId) {
        throw new Error('Turn feedback response owner mismatch.');
      }
      return response;
    },
    onSuccess: (response, input) => {
      queryClient.setQueryData(
        chatKeys.feedback(input.workspaceId, input.threadId, input.turnId),
        response
      );
    },
  });
}

/**
 * Rename a thread and cache only the authoritative Thread returned by Core.
 *
 * @returns A mutation whose variable is the complete requested Thread update.
 */
export function useRenameThread() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: chatKeys.renameMutation,
    mutationFn: (input: { workspaceId: string; threadId: string; name: string }) =>
      client.core.updateThread(input),
    onSuccess: (thread) => {
      queryClient.setQueryData(chatKeys.thread(thread.workspaceId, thread.id), thread);
      queryClient.setQueryData<Thread[]>(chatKeys.threads(thread.workspaceId), (threads) =>
        threads?.map((candidate) => (candidate.id === thread.id ? thread : candidate))
      );
    },
  });
}

/**
 * Archive a thread and cache only the authoritative Thread returned by Core.
 *
 * @returns A mutation whose variable identifies the Thread to archive.
 */
export function useArchiveThread() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: chatKeys.archiveMutation,
    mutationFn: (input: { workspaceId: string; threadId: string }) =>
      client.core.archiveThread(input),
    onSuccess: (thread) => {
      queryClient.setQueryData(chatKeys.thread(thread.workspaceId, thread.id), thread);
      queryClient.setQueryData<Thread[]>(chatKeys.threads(thread.workspaceId), (threads) =>
        threads?.map((candidate) => (candidate.id === thread.id ? thread : candidate))
      );
    },
  });
}

/**
 * Interrupt a running turn and cache only the authoritative Turn returned by Core.
 *
 * @returns A mutation whose variable identifies the running Turn to interrupt.
 */
export function useInterruptTurn() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: chatKeys.interruptMutation,
    mutationFn: (input: { workspaceId: string; threadId: string; turnId: string }) =>
      client.core.interruptTurn(input),
    onSuccess: (turn) => {
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['getThreadDashboard']>>>(
        chatKeys.dashboard(turn.workspaceId, turn.threadId),
        (dashboard) =>
          dashboard
            ? {
                ...dashboard,
                turns: dashboard.turns.map((candidate) =>
                  candidate.id === turn.id ? turn : candidate
                ),
              }
            : dashboard
      );
    },
  });
}

/**
 * Create a thread and enter Chat Mode with its first message.
 *
 * @returns A mutation whose variables retain the original Workspace identity.
 */
export function useCreateThread() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { workspaceId: string; firstMessage: string }): Promise<Thread> => {
      const name = input.firstMessage.slice(0, 60);
      const thread = await client.core.createThread({ workspaceId: input.workspaceId, name });
      // Open the thread even when the first turn cannot start (for example when the
      // workspace has no repository yet). The user can retry from ThreadScreen.
      try {
        await client.app.startChatMode(input.workspaceId, thread.id, { input: input.firstMessage });
      } catch {
        // Thread create succeeded; turn failure must not block navigation.
      }
      return thread;
    },
    onSuccess: (_thread, input) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.threads(input.workspaceId) });
    },
  });
}

/** Respond to an approval, then refresh its authoritative item and dashboard projections. */
export function useRespondApproval(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      approvalRequestId: string;
      turnId: string;
      decision: 'granted' | 'denied';
    }) =>
      client.core.respondApproval(args.approvalRequestId, {
        workspaceId,
        threadId,
        turnId: args.turnId,
        decision: args.decision,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.items(workspaceId, threadId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.dashboard(workspaceId, threadId) });
    },
  });
}

/**
 * Submit one complete non-secret user-input answer map and refresh its authoritative projections.
 *
 * @param workspaceId Workspace that owns the paused Turn.
 * @param threadId Thread that owns the paused Turn.
 * @returns Mutation retaining the exact Turn and answer map for visible retry.
 */
export function useSubmitTurnAnswers(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { turnId: string; answers: Record<string, [string]> }) =>
      client.core.startTurn({
        workspaceId,
        threadId,
        turnId: input.turnId,
        answers: input.answers,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.items(workspaceId, threadId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.dashboard(workspaceId, threadId) });
    },
  });
}

/** Group a flat item stream by turn, preserving order (Thread → Turn → Item). */
export function groupItemsByTurn(items: ThreadItem[]): { turnId: string; items: ThreadItem[] }[] {
  const groups: { turnId: string; items: ThreadItem[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.turnId === item.turnId) last.items.push(item);
    else groups.push({ turnId: item.turnId, items: [item] });
  }
  return groups;
}
