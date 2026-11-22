import { createRequestId } from '@openkit/core-client';
import { workspaceIdForOwner } from '@openkit/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { EmptyState, InlineAlert } from '../primitives';
import {
  callerQuickChatWorkspace,
  chatKeys,
  threadPath,
  threadRouteState,
  useWorkspaceSummaries,
  useWorkspaces,
} from '../screens/chat/data';
import { useCoreClient } from './core-client';

/**
 * `/assistant`: the Personal Assistant (ia.md §0, G6).
 *
 * It is the private Assistant Timeline of the caller's personal Workspace: the owned, actively
 * joined `personal` row of `workspace.list`. The documented `thread.create` opener (name
 * `Assistant`) returns that exact Timeline, or creates the first empty Thread; it submits no
 * message and starts no Turn. The route then replaces itself with that Thread's route.
 */
export function AssistantRoute() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { search, hash } = useLocation();
  // The redirected address keeps its search and hash (`/chat?…#…` arrives here first).
  const tail = useRef('');
  tail.current = `${search}${hash}`;
  const workspaces = useWorkspaces();
  const summaries = useWorkspaceSummaries();
  const personal = callerQuickChatWorkspace(summaries.data);
  const request = useRef<{ workspaceId: string; requestId: string } | null>(null);
  const opening = useMutation({
    mutationFn: (input: { workspaceId: string; requestId: string }) =>
      client.operations['thread.create']({ ...input, name: 'Assistant' }),
    retry: false,
    onSettled: (_thread, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.threads(input.workspaceId) });
    },
  });
  const { mutate } = opening;

  function open(input: { workspaceId: string; requestId: string }) {
    mutate(input, {
      onSuccess: (thread) =>
        navigate(`${threadPath(workspaceIdForOwner(thread.owner), thread.id)}${tail.current}`, {
          replace: true,
          state: threadRouteState('chat'),
        }),
    });
  }

  const personalId = personal?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: open once per personal Workspace
  useEffect(() => {
    if (!personalId || request.current?.workspaceId === personalId) return;
    request.current = { workspaceId: personalId, requestId: createRequestId() };
    open(request.current);
  }, [personalId]);

  if (workspaces.isError) {
    return (
      <div className="px-4 py-6">
        <InlineAlert
          message="Couldn't open Personal Assistant."
          onRetry={() => void workspaces.refetch()}
        />
      </div>
    );
  }
  if (opening.isError) {
    return (
      <div className="px-4 py-6">
        <InlineAlert
          message="Couldn't open Personal Assistant."
          onRetry={() => {
            if (request.current) open(request.current);
          }}
        />
      </div>
    );
  }
  if (workspaces.isSuccess && summaries.isSuccess && !personal) {
    return (
      <EmptyState
        icon="chat"
        title="Personal Assistant"
        hint="Your account has no personal Workspace yet."
      />
    );
  }
  return (
    <p role="status" className="px-4 py-6 text-sm text-fg-muted">
      Opening Personal Assistant…
    </p>
  );
}
