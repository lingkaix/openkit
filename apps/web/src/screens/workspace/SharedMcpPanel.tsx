import { ApiCallError, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { Button, Card, EmptyState, ErrorBanner, ListRow, Skeleton } from '../../primitives';

/** Preserve denial status while excluding arbitrary upstream details from UI and caches. */
function safeFailure(error: unknown) {
  return new ApiCallError(
    error instanceof ApiCallError ? error.status : 0,
    'Shared supply request failed.'
  );
}

/** Read and disable only the selected Workspace projection of administrator-owned MCP supply. */
export function SharedMcpPanel({
  workspaceId,
  blocked,
}: {
  workspaceId: string;
  blocked: boolean;
}) {
  const client = useCoreClient();
  const supply = useQuery({
    queryKey: ['catalog', 'shared-mcp', workspaceId],
    queryFn: async () => {
      try {
        return await client.operations['catalog.shared-mcp-list']({ workspaceId });
      } catch (error) {
        throw safeFailure(error);
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const change = useMutation({
    mutationFn: async ({ mcpId, disabled }: { mcpId: string; disabled: boolean }) => {
      if (!supply.data || supply.isError || blocked) throw safeFailure(null);
      try {
        await client.operations['catalog.shared-mcp-set-disabled']({
          workspaceId,
          mcpId,
          disabled,
          expectedRevision: supply.data.revision,
          requestId: createRequestId(),
        });
      } catch (error) {
        throw safeFailure(error);
      }
    },
    retry: false,
    onSuccess: async () => {
      await supply.refetch();
    },
  });
  const denied = [supply.error, change.error].some(
    (error) => error instanceof ApiCallError && [401, 403].includes(error.status)
  );
  const busy = blocked || supply.isFetching || change.isPending;
  const writeBlocked = busy || supply.isError || change.isError;

  /** Inspect current state without replaying an uncertain mutation. */
  function refresh() {
    void supply.refetch().then((result) => {
      if (result.isSuccess) change.reset();
    });
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-bold text-fg">Shared MCP servers</h2>
      <p className="text-xs text-fg-muted">
        Administrators manage this Server supply. Disablement here affects only this Workspace. An
        Agent must still select the server, and each tool call keeps its permission checks.
      </p>
      <Button size="sm" isDisabled={busy} onPress={refresh}>
        Refresh shared supply
      </Button>
      {denied ? (
        <EmptyState
          icon="key"
          title="Shared supply access denied"
          hint="Current Workspace read or configuration authority is required."
        />
      ) : supply.isLoading ? (
        <Skeleton lines={3} />
      ) : supply.isError ? (
        <ErrorBanner message="Couldn't read current shared supply. Refresh before changing it." />
      ) : (
        <>
          {change.isError ? (
            <ErrorBanner message="Shared supply change failed. Its outcome may be unknown. Refresh and inspect current state before a new change." />
          ) : null}
          {supply.data?.items.length ? (
            supply.data.items.map((entry) => (
              <ListRow key={entry.id} className="flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-fg">{entry.displayName}</p>
                  <p className="text-xs text-fg-muted">
                    {entry.id} ·{' '}
                    {entry.availability === 'removed'
                      ? 'removed on Server'
                      : !entry.enabled
                        ? 'inactive on Server'
                        : entry.disabled
                          ? 'disabled here'
                          : 'available for Agent selection'}
                  </p>
                  <p className="text-xs text-fg-muted">
                    Allowed tools: {entry.allowedTools.join(', ') || 'none'}
                  </p>
                  <p className="text-xs text-fg-muted">
                    Approval required: {entry.approvalRequiredTools.join(', ') || 'none'}
                  </p>
                  <p className="text-xs text-fg-muted">
                    Denied tools: {entry.deniedTools.join(', ') || 'none'}
                  </p>
                  {entry.shadowed ? (
                    <p className="text-xs text-fg-muted">
                      A local configuration or retained removal suppresses this shared server.
                      Resolve that local entry before shared supply can be used.
                    </p>
                  ) : null}
                </div>
                {!entry.shadowed && entry.availability !== 'removed' ? (
                  <Button
                    size="sm"
                    isDisabled={writeBlocked}
                    onPress={() => change.mutate({ mcpId: entry.id, disabled: !entry.disabled })}
                  >
                    {entry.disabled
                      ? `Restore ${entry.displayName} here`
                      : `Disable ${entry.displayName} here`}
                  </Button>
                ) : null}
              </ListRow>
            ))
          ) : (
            <EmptyState
              icon="connect"
              title="No shared MCP servers"
              hint="A deployment administrator can add shared supply."
            />
          )}
        </>
      )}
    </Card>
  );
}
