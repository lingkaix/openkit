import {
  type VaultGrantRequestTerms,
  VaultGrantRequestTermsSchema,
  type VaultGrantRequestView,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useConnection, useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Select,
  Skeleton,
  TextField,
} from '../../primitives';

/** Keep only fixed safe error text while preserving the status for access-denied presentation. */
function safeFailure(error: unknown): ApiCallError {
  return new ApiCallError(
    error instanceof ApiCallError ? error.status : 0,
    'Credential request failed. Refresh requests and grant inventory before another action.'
  );
}

/** Request and review supported grant intent while keeping approval, issue and actual use visibly distinct. */
export function VaultGrantRequestsPanel({ workspaceId }: { readonly workspaceId: string }) {
  const client = useCoreClient();
  const cache = useQueryClient();
  const { failed: disconnected } = useConnection();
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [scope, setScope] = useState<'workspace' | 'server'>('workspace');
  const [visibility, setVisibility] = useState<'gateway-only' | 'runtime-env'>('gateway-only');
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [capabilityId, setCapabilityId] = useState<'' | 'mcp.list_tools' | 'mcp.call_tool'>('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reviewedId, setReviewedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const threads = useQuery({
    queryKey: ['vault-request-threads', workspaceId],
    queryFn: async () => {
      try {
        return (await client.operations['thread.list']({ workspaceId })).items
          .filter((row) => row.status !== 'archived')
          .map(({ id, name }) => ({ id, label: name ?? id }));
      } catch (error) {
        throw safeFailure(error);
      }
    },
    retry: false,
  });
  const threadId = selectedThreadId || threads.data?.[0]?.id || '';
  const requests = useQuery({
    queryKey: ['vault-grant-requests', workspaceId, threadId],
    enabled: Boolean(threadId),
    queryFn: async () => {
      try {
        return await client.operations['vault.grant-request-list']({ workspaceId, threadId });
      } catch (error) {
        throw safeFailure(error);
      }
    },
    retry: false,
  });
  const action = useMutation({
    mutationKey: ['vault-grant-request-action', workspaceId, threadId],
    retry: false,
    mutationFn: async (
      input:
        | { kind: 'request'; terms: VaultGrantRequestTerms }
        | { kind: 'approve' | 'deny' | 'withdraw' | 'issue'; record: VaultGrantRequestView }
    ) => {
      try {
        if (input.kind === 'request')
          await client.operations['vault.grant-request']({
            workspaceId,
            threadId,
            requestId: crypto.randomUUID(),
            terms: input.terms,
          });
        else if (input.kind === 'withdraw')
          await client.operations['pending-request.withdraw']({
            workspaceId,
            threadId,
            pendingRequestId: input.record.approvalRequestId,
            requestId: crypto.randomUUID(),
          });
        else if (input.kind === 'issue')
          await client.operations['vault.grant-issue']({
            workspaceId,
            threadId,
            approvalRequestId: input.record.approvalRequestId,
          });
        else
          await client.operations['approval.respond']({
            workspaceId,
            threadId,
            turnId: input.record.raisingTurnId,
            approvalRequestId: input.record.approvalRequestId,
            decision: input.kind === 'approve' ? 'granted' : 'denied',
            requestId: crypto.randomUUID(),
          });
      } catch (error) {
        throw safeFailure(error);
      }
    },
    onSuccess: async (_, input) => {
      setReviewedId(null);
      setNotice(
        input.kind === 'issue'
          ? 'Grant issue completed. Inspect the actual grant and bind its ID explicitly before use.'
          : input.kind === 'approve'
            ? 'Request approved. A currently authorized administrator must issue the grant separately.'
            : 'Credential request updated.'
      );
      await requests.refetch();
      await cache.invalidateQueries({ queryKey: ['settings', 'vault', workspaceId] });
      await cache.invalidateQueries({ queryKey: ['settings', 'vault-secrets', workspaceId] });
    },
  });
  const busy = action.isPending || requests.isFetching || threads.isFetching;
  const disabled =
    busy || disconnected || requests.isError || threads.isError || action.isError || !threadId;
  const denied = [threads.error, requests.error, action.error].some(
    (error) => error instanceof ApiCallError && [401, 403].includes(error.status)
  );
  /** An uncertain mutation is inspected through reads and is never replayed by Refresh. */
  function refresh() {
    setReviewedId(null);
    setNotice(null);
    action.reset();
    void threads.refetch();
    if (threadId) void requests.refetch();
  }
  /** Validate before mutation retention; rejected input never enters a request or server-state cache. */
  function requestGrant() {
    const parsed = VaultGrantRequestTermsSchema.safeParse({
      referenceId: referenceId.trim(),
      ownerScope: scope,
      lifetime: scope,
      injectionPath: visibility,
      ...(agentId.trim() ? { targetAgentId: agentId.trim() } : {}),
      ...(sessionId.trim() ? { targetAgentSessionId: sessionId.trim() } : {}),
      ...(capabilityId ? { targetCapabilityId: capabilityId } : {}),
      ...(expiresAt.trim() ? { expiresAt: expiresAt.trim() } : {}),
    });
    if (!parsed.success) {
      setReferenceId('');
      setAgentId('');
      setSessionId('');
      setExpiresAt('');
      setNotice(
        'Credential request fields are invalid. Enter reference IDs and supported bounds only.'
      );
      return;
    }
    setNotice(null);
    action.mutate({ kind: 'request', terms: parsed.data });
  }
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg">Credential-use requests</h2>
      <p className="text-sm text-fg-muted">
        Request exact credential-use bounds. Approval, grant issue, secret delivery and completed
        work are separate facts. Enter reference IDs only.
      </p>
      {threads.isLoading ? <Skeleton lines={3} /> : null}
      {denied ? (
        <p>Access denied. Current request or administrator authority is required.</p>
      ) : null}
      {threads.isError || requests.isError || action.isError ? (
        <ErrorBanner message="Credential request failed. Refresh requests and grant inventory before another action." />
      ) : null}
      {disconnected ? (
        <p>Connection unavailable. Requests may be stale; actions are disabled.</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <Button variant="outline" isDisabled={busy} onPress={refresh}>
        Refresh credential requests
      </Button>
      {!denied ? (
        <>
          <Select
            label="Request Thread"
            selectedKey={threadId}
            items={threads.data ?? []}
            isDisabled={busy || disconnected}
            onSelectionChange={(key) => {
              setSelectedThreadId(String(key));
              setReviewedId(null);
              action.reset();
              setNotice(null);
            }}
          />
          {!threads.isLoading && !threads.isError && !threads.data?.length ? (
            <EmptyState
              title="No request Thread"
              hint="Create a conversation Thread, then refresh to request credential use."
            />
          ) : null}
          <TextField
            label="Requested reference ID"
            value={referenceId}
            onChange={setReferenceId}
            isDisabled={disabled}
          />
          <Select
            label="Requested reference scope"
            selectedKey={scope}
            items={[
              { id: 'workspace', label: 'Workspace' },
              { id: 'server', label: 'Shared Server MCP' },
            ]}
            isDisabled={disabled}
            onSelectionChange={(key) => {
              const next = key === 'server' ? 'server' : 'workspace';
              setScope(next);
              if (next === 'server') setVisibility('gateway-only');
            }}
          />
          <p>Requested lifetime: {scope}</p>
          <Select
            label="Requested visibility"
            selectedKey={visibility}
            items={[
              { id: 'gateway-only', label: 'Gateway only' },
              ...(scope === 'workspace'
                ? [{ id: 'runtime-env', label: 'Worker environment (GitHub token only)' }]
                : []),
            ]}
            isDisabled={disabled}
            onSelectionChange={(key) => {
              setVisibility(key === 'runtime-env' ? 'runtime-env' : 'gateway-only');
              if (key === 'runtime-env') setCapabilityId('');
            }}
          />
          {visibility === 'runtime-env' ? (
            <p>
              Worker processes can read this material. Existing runtime revocation may require
              stopping or recycling the environment.
            </p>
          ) : null}
          <TextField
            label="Requested Agent"
            value={agentId}
            onChange={setAgentId}
            isDisabled={disabled}
          />
          <TextField
            label="Requested AgentSession"
            value={sessionId}
            onChange={setSessionId}
            isDisabled={disabled}
          />
          <Select
            label="Requested capability"
            selectedKey={capabilityId || 'unrestricted'}
            items={[
              { id: 'unrestricted', label: 'No capability restriction' },
              { id: 'mcp.list_tools', label: 'MCP tool discovery' },
              { id: 'mcp.call_tool', label: 'MCP tool call' },
            ]}
            isDisabled={disabled || visibility === 'runtime-env'}
            onSelectionChange={(key) =>
              setCapabilityId(key === 'mcp.list_tools' || key === 'mcp.call_tool' ? key : '')
            }
          />
          <TextField
            label="Requested expiry (UTC)"
            value={expiresAt}
            onChange={setExpiresAt}
            isDisabled={disabled}
          />
          <Button isDisabled={disabled || !referenceId.trim()} onPress={requestGrant}>
            Request credential-use grant
          </Button>
          {requests.isLoading ? <Skeleton lines={3} /> : null}
          {requests.data?.items.length === 0 ? (
            <p>No credential-use requests on this Thread.</p>
          ) : null}
          {requests.data?.items.map((record) => (
            <div key={record.approvalRequestId} className="flex flex-col gap-2">
              <h3 className="font-semibold text-fg">{record.approvalRequestId}</h3>
              <p>
                Request: {record.state} · decision:{' '}
                {record.resolution ?? record.ending ?? 'pending'} · issue:{' '}
                {record.disposition ?? record.claim}
              </p>
              <p>
                Reference: {record.terms.referenceId} · scope: {record.terms.ownerScope} · lifetime:{' '}
                {record.terms.lifetime} · visibility: {record.terms.injectionPath}
              </p>
              <p>
                Agent: {record.terms.targetAgentId ?? 'Unrestricted'} · AgentSession:{' '}
                {record.terms.targetAgentSessionId ?? 'Unrestricted'} · capability:{' '}
                {record.terms.targetCapabilityId ?? 'Unrestricted'} · expiry:{' '}
                {record.terms.expiresAt ?? 'No time bound'}
              </p>
              <p>
                Deciding actor: {record.decidingActorId ?? 'None'} · actual grant:{' '}
                {record.grantId ?? 'Not issued'} · decision delivery: {record.delivery}
              </p>
              {record.state === 'pending' ? (
                <>
                  <Button
                    variant="outline"
                    isDisabled={disabled}
                    onPress={() => setReviewedId(record.approvalRequestId)}
                  >
                    Review exact effect {record.approvalRequestId}
                  </Button>
                  {reviewedId === record.approvalRequestId ? (
                    <>
                      {record.effect.status === 'available' ? (
                        <pre className="overflow-auto whitespace-pre-wrap text-sm text-fg">
                          {record.effect.detail}
                        </pre>
                      ) : (
                        <p>
                          Exact effect unavailable. Approval is disabled; deny or withdraw remains
                          available.
                        </p>
                      )}
                      {!record.canApprove ? (
                        <p>Current administrator authority is required to approve grant issue.</p>
                      ) : null}
                      <Button
                        isDisabled={
                          disabled || !record.canApprove || record.effect.status !== 'available'
                        }
                        onPress={() => action.mutate({ kind: 'approve', record })}
                      >
                        Approve exact request {record.approvalRequestId}
                      </Button>
                    </>
                  ) : null}
                  <Button
                    variant="outline"
                    isDisabled={disabled}
                    onPress={() => action.mutate({ kind: 'deny', record })}
                  >
                    Deny request {record.approvalRequestId}
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={disabled}
                    onPress={() => action.mutate({ kind: 'withdraw', record })}
                  >
                    Withdraw request {record.approvalRequestId}
                  </Button>
                </>
              ) : null}
              {record.resolution === 'granted' &&
              record.claim === 'unclaimed' &&
              !record.disposition ? (
                <Button
                  isDisabled={disabled || !record.canIssue}
                  onPress={() => action.mutate({ kind: 'issue', record })}
                >
                  Issue approved grant {record.approvalRequestId}
                </Button>
              ) : null}
              {record.grantId ? (
                <p>
                  Inspect current grant restrictions before use. Narrowing replaces the grant and
                  requires an explicit binding update.
                </p>
              ) : null}
              {record.disposition === 'outcome-unknown' ||
              record.claim === 'claimed' ||
              record.delivery === 'delivery-unknown' ? (
                <p>
                  Outcome unknown. Inspect request, grant inventory and Audit. Do not repeat the
                  effect.
                </p>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </Card>
  );
}
