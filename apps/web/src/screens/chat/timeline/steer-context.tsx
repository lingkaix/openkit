import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useCoreClient } from '../../../app/core-client';
import {
  type SteerController,
  SteerControllerProvider,
  type SteerReplay,
} from '../../../primitives/steer-context';
import {
  chatKeys,
  useConversationTargets,
  useCurrentWorkspaceId,
  useThreadDashboard,
} from '../data';
import {
  classifySteerError,
  composerLiveMode,
  receiptCoversRequest,
  type SteerFailureView,
  steerErrorCode,
  steerReasonSentence,
  steerReceiptsFromWindows,
} from './steer';
import { timelineReadAvailable, useTimelineWindow } from './use-timeline-window';
import { anchorFromSearch } from './window';

/**
 * Supplies steer mode and receipt state for the open thread.
 * The screen and stream stay untouched while another lane edits them.
 */
export function SteerProvider({ mode, children }: { mode: 'chat' | 'task'; children: ReactNode }) {
  const { workspaceId: routeWorkspaceId = '', threadId = '' } = useParams();
  const location = useLocation();
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const ownerId = useCurrentWorkspaceId(routeWorkspaceId);
  const dashboard = useThreadDashboard(ownerId, threadId, Boolean(ownerId), true);
  const targets = useConversationTargets(ownerId, threadId);
  const timelineOn = timelineReadAvailable(client);
  const runningTurn = dashboard.data?.turns.findLast((turn) => turn.status === 'running') ?? null;
  const waiting = dashboard.data?.turns.some((turn) => turn.status === 'pending') ?? false;
  const timeline = useTimelineWindow({
    workspaceId: ownerId,
    threadId,
    anchor: anchorFromSearch(location.search),
    enabled: timelineOn && Boolean(ownerId),
    running: Boolean(runningTurn),
    pending: waiting && !runningTurn,
  });
  const ownerKey = ownerId ?? '';
  // The stream keys its window by the route workspace. The store id can still be unresolved.
  const receiptVersion = useRef(0);
  const readReceiptVersion = useCallback(() => receiptVersion.current, []);
  const cachedReceiptVersion = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        queryClient.getQueryCache().subscribe((event) => {
          if (event.type !== 'added' && event.type !== 'updated' && event.type !== 'removed') {
            return;
          }
          const key = event.query.queryKey;
          if (key[0] !== 'thread-timeline' || key[2] !== threadId) return;
          const workspaceKey = String(key[1] ?? '');
          if (workspaceKey !== routeWorkspaceId && workspaceKey !== ownerKey) return;
          receiptVersion.current += 1;
          onChange();
        }),
      [ownerKey, queryClient, routeWorkspaceId, threadId]
    ),
    readReceiptVersion,
    readReceiptVersion
  );
  // cachedReceiptVersion is the timeline-cache tick. The callback does not read it; the dependency recomputes receipts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cachedReceiptVersion changes when a matching timeline query is written
  const receipts = useMemo(() => {
    const workspaceIds = [routeWorkspaceId, ownerKey].filter(
      (id, index, all) => id.length > 0 && all.indexOf(id) === index
    );
    const windows = workspaceIds.flatMap((id) =>
      queryClient
        .getQueriesData({ queryKey: ['thread-timeline', id, threadId] })
        .map((entry) => entry[1])
    );
    if (timeline.data && !windows.includes(timeline.data)) windows.push(timeline.data);
    return steerReceiptsFromWindows(windows);
  }, [cachedReceiptVersion, ownerKey, queryClient, routeWorkspaceId, threadId, timeline.data]);
  const live = composerLiveMode({
    task: mode === 'task',
    runningTurnId: runningTurn?.id ?? null,
    targets: targets.data?.targets,
  });
  const mutation = useMutation({
    mutationKey: ['task', 'steer', ownerId, threadId] as const,
    mutationFn: async (replay: SteerReplay) => {
      if (!ownerId) throw new Error('Workspace is unavailable.');
      return client.operations['task.steer']({
        workspaceId: ownerId,
        threadId,
        turnId: replay.turnId,
        requestId: replay.requestId,
        input: replay.text,
      });
    },
    onSettled: () => {
      if (!ownerId) return;
      void queryClient.invalidateQueries({
        queryKey: ['thread-timeline', ownerId, threadId],
      });
      void queryClient.invalidateQueries({ queryKey: chatKeys.items(ownerId, threadId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.dashboard(ownerId, threadId) });
    },
  });
  const recorded = receiptCoversRequest(receipts, mutation.variables?.requestId);
  const failure: SteerFailureView | null =
    mutation.isError && mutation.variables && !recorded
      ? {
          kind: classifySteerError(mutation.error),
          reason: steerReasonSentence(steerErrorCode(mutation.error)),
          replay: mutation.variables,
        }
      : null;
  const submit = useCallback(
    (replay: SteerReplay) => {
      if (mutation.isPending) return Promise.reject(new Error('A steer attempt is already open.'));
      return mutation.mutateAsync(replay);
    },
    [mutation.isPending, mutation.mutateAsync]
  );
  const replay = useCallback(
    (target: SteerReplay) => {
      if (mutation.isPending) return;
      mutation.mutate(target);
    },
    [mutation.isPending, mutation.mutate]
  );
  const receipt = useCallback((itemId: string) => receipts.get(itemId) ?? null, [receipts]);
  const value: SteerController = {
    live,
    pending: (mutation.isPending || mutation.isSuccess) && !recorded,
    failure,
    submit,
    replay,
    receipt,
  };
  return <SteerControllerProvider value={value}>{children}</SteerControllerProvider>;
}
