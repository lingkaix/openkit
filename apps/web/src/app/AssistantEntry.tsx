import { createRequestId } from '@openkit/core-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button, ErrorBanner, Icon } from '../primitives';
import { chatKeys, chatThreadPath } from '../screens/chat/data';
import { useCoreClient } from './core-client';

/** Opens the server-owned Assistant history without submitting a conversation message. */
export function AssistantEntry({ workspaceId }: { workspaceId: string }) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const opening = useMutation({
    mutationFn: (input: { workspaceId: string; requestId: string }) =>
      client.operations['thread.create']({ ...input, name: 'Assistant' }),
    retry: false,
    onSettled: (_thread, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.threads(input.workspaceId) });
    },
  });

  function open(input: { workspaceId: string; requestId: string }) {
    opening.mutate(input, {
      // Sidebar keys this entry by Workspace. Per-call callbacks stop on unmount,
      // so a departed Workspace cannot redirect the current navigation.
      onSuccess: (thread) => navigate(chatThreadPath(thread.workspaceId, thread.id)),
    });
  }

  return (
    <div>
      <Button
        variant="quiet"
        className="w-full justify-start rounded-ok! px-3! font-medium!"
        isDisabled={opening.isPending || opening.isError}
        onPress={() => open({ workspaceId, requestId: createRequestId() })}
      >
        <Icon name="chat" />
        Assistant
      </Button>
      {opening.isPending ? (
        <p role="status" className="px-3 text-xs text-fg-muted">
          Opening Assistant…
        </p>
      ) : null}
      {opening.isError ? (
        <ErrorBanner
          message="Couldn't open Assistant."
          onRetry={() => {
            if (opening.variables) open(opening.variables);
          }}
        />
      ) : null}
    </div>
  );
}
