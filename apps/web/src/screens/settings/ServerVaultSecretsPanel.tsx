import {
  NarrowWorkspaceVaultGrantRequestSchema,
  type OperationInput,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useConnection, useCoreClient } from '../../app/core-client';
import { Button, Card, ErrorBanner, Select, Skeleton, TextField } from '../../primitives';
import { redactSecretShapedText } from './secret-safe';

/** Preserve only the HTTP status and fixed safe diagnostic, never backend or submitted material. */
function safeFailure(error: unknown) {
  return new ApiCallError(
    error instanceof ApiCallError ? error.status : 0,
    'Shared MCP Vault request failed. Refresh inventory before another action.'
  );
}

/** Operate the existing Server shared-MCP Vault family without retaining material in server-state caches. */
export function ServerVaultSecretsPanel() {
  const client = useCoreClient();
  const { failed: disconnected } = useConnection();
  const [material, setMaterial] = useState('');
  const hold = useRef<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [capabilityId, setCapabilityId] = useState<'' | 'mcp.list_tools' | 'mcp.call_tool'>('');
  const [expiresAt, setExpiresAt] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const constraints: OperationInput<'vault.server-mcp-grant-narrow'>['constraints'] = {
    ...(agentId.trim() ? { targetAgentId: agentId.trim() } : {}),
    ...(sessionId.trim() ? { targetAgentSessionId: sessionId.trim() } : {}),
    ...(capabilityId ? { targetCapabilityId: capabilityId } : {}),
    ...(expiresAt.trim() ? { expiresAt: expiresAt.trim() } : {}),
  };
  const inventory = useQuery({
    queryKey: ['settings', 'server-mcp-vault'],
    retry: false,
    queryFn: async () => {
      try {
        const [references, grants, plans, receipts, uses] = await Promise.all([
          client.operations['vault.server-mcp-reference-list']({}),
          client.operations['vault.server-mcp-grant-list']({}),
          client.operations['vault.server-mcp-injection-plan-list']({}),
          client.operations['vault.server-mcp-injection-receipt-list']({}),
          client.operations['vault.server-use-list']({}),
        ]);
        const referenceIds = new Set(references.items.map((reference) => reference.referenceId));
        return {
          plans: plans.items.map(({ planId, grantId, injectionVisibility, status }) => ({
            planId,
            grantId,
            injectionVisibility,
            status,
          })),
          receipts: receipts.items.map(
            ({ receiptId, planId, grantId, capabilityCallId, injectedAt, revocationStatus }) => ({
              receiptId,
              planId,
              grantId,
              capabilityCallId,
              injectedAt,
              revocationStatus,
            })
          ),
          uses: uses.vaultUseRecords
            .filter((use) => referenceIds.has(use.vaultReferenceId))
            .map(
              ({
                useId,
                vaultReferenceId,
                grantId,
                planId,
                receiptId,
                capabilityCallId,
                outcome,
                failureCode,
              }) => ({
                useId,
                vaultReferenceId,
                grantId,
                planId,
                receiptId,
                capabilityCallId,
                outcome,
                failureCode,
              })
            ),
          references: references.items.map(({ referenceId, status, currentVersion }) => ({
            referenceId: redactSecretShapedText(referenceId),
            status,
            currentVersion,
          })),
          grants: grants.items.map(
            ({
              grantId,
              vaultReferenceId,
              status,
              targetAgentId,
              targetAgentSessionId,
              targetCapabilityId,
              expiresAt,
              approvalId,
              policyDecisionId,
            }) => ({
              grantId: redactSecretShapedText(grantId),
              vaultReferenceId: redactSecretShapedText(vaultReferenceId),
              status,
              targetAgentId: targetAgentId ? redactSecretShapedText(targetAgentId) : null,
              targetAgentSessionId: targetAgentSessionId
                ? redactSecretShapedText(targetAgentSessionId)
                : null,
              targetCapabilityId: targetCapabilityId
                ? redactSecretShapedText(targetCapabilityId)
                : null,
              expiresAt,
              approvalId: approvalId ? redactSecretShapedText(approvalId) : null,
              policyDecisionId: policyDecisionId ? redactSecretShapedText(policyDecisionId) : null,
            })
          ),
        };
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const mutation = useMutation({
    mutationKey: ['vault-admin-secret', 'server-mcp'],
    retry: false,
    mutationFn: async (input: {
      action: 'save' | 'revoke' | 'grant' | 'narrow' | 'revoke-grant';
      id?: string;
      constraints?: typeof constraints;
    }) => {
      const secret = hold.current;
      hold.current = null;
      try {
        const requestId = crypto.randomUUID();
        if (input.action === 'save') {
          if (!secret) throw new Error('Secret input is required.');
          if (input.id)
            await client.operations['vault.server-mcp-secret-rotate']({
              requestId,
              referenceId: input.id,
              material: secret,
            });
          else
            await client.operations['vault.server-mcp-secret-create']({
              requestId,
              material: secret,
            });
        } else if (input.action === 'revoke')
          await client.operations['vault.server-mcp-secret-revoke']({
            requestId,
            referenceId: input.id!,
          });
        else if (input.action === 'grant')
          await client.operations['vault.server-mcp-grant-create']({
            requestId,
            referenceId: input.id!,
            ...input.constraints,
          });
        else if (input.action === 'narrow')
          await client.operations['vault.server-mcp-grant-narrow']({
            requestId,
            grantId: input.id!,
            constraints: input.constraints ?? {},
          });
        else
          await client.operations['vault.server-mcp-grant-revoke']({
            requestId,
            grantId: input.id!,
          });
        // Responses are discarded; only a whitelisted fresh inventory may enter TanStack caches.
      } catch (error) {
        throw safeFailure(error);
      }
    },
    onMutate: () => setNotice(null),
    onSuccess: async (_, input) => {
      setRotating(null);
      setNotice(
        input.action === 'narrow'
          ? 'Grant replaced. Bind the replacement explicitly before use.'
          : 'Shared MCP Vault updated. Grant IDs require an explicit Server binding.'
      );
      await inventory.refetch();
    },
    onSettled: () => {
      hold.current = null;
      setMaterial('');
    },
  });
  const denied = [inventory.error, mutation.error].some(
    (error) => error instanceof ApiCallError && [401, 403].includes(error.status)
  );
  useEffect(() => {
    if (denied || inventory.isError || disconnected) {
      hold.current = null;
      setMaterial('');
    }
  }, [denied, inventory.isError, disconnected]);
  useEffect(
    () => () => {
      hold.current = null;
    },
    []
  );
  const busy = inventory.isFetching || mutation.isPending;
  const disabled = busy || disconnected || inventory.isError || mutation.isError;
  /** Refresh never repeats a material or grant mutation. */
  function refresh() {
    hold.current = null;
    setMaterial('');
    setRotating(null);
    setNotice(null);
    mutation.reset();
    void inventory.refetch();
  }
  /** Apply the existing target schema before retaining grant restrictions in a mutation. */
  function changeGrant(action: 'grant' | 'narrow', id: string) {
    const parsed = NarrowWorkspaceVaultGrantRequestSchema.shape.constraints.safeParse(constraints);
    if (!parsed.success) {
      hold.current = null;
      setMaterial('');
      setAgentId('');
      setSessionId('');
      setExpiresAt('');
      setNotice('Grant restriction fields are invalid. Enter exact supported bounds only.');
      return;
    }
    mutation.mutate({ action, id, constraints: parsed.data });
  }
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg">Shared MCP secrets</h2>
      <p className="text-sm text-fg-muted">
        Server-owned MCP credentials use Gateway-only visibility and Server lifetime. Grant issue
        does not create a catalog binding.
      </p>
      {inventory.isLoading ? <Skeleton lines={3} /> : null}
      {inventory.isError || mutation.isError ? (
        <ErrorBanner message="Shared MCP Vault request failed. Refresh inventory before another action." />
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <Button variant="outline" isDisabled={busy} onPress={refresh}>
        Refresh shared MCP secrets
      </Button>
      {denied ? (
        <p>Access denied. Current administrator authority is required.</p>
      ) : (
        <>
          {disconnected ? (
            <p>Connection unavailable. Inventory may be stale; mutations are disabled.</p>
          ) : null}
          <TextField
            label="Shared MCP secret value"
            type="password"
            autoComplete="off"
            value={material}
            onChange={setMaterial}
            isDisabled={disabled}
          />
          {rotating ? <p>Replacing {rotating}</p> : null}
          <Button
            isDisabled={disabled || !material}
            onPress={() => {
              hold.current = material;
              setMaterial('');
              mutation.mutate({ action: 'save', ...(rotating ? { id: rotating } : {}) });
            }}
          >
            {rotating ? 'Save shared MCP replacement' : 'Add shared MCP secret'}
          </Button>
          {rotating ? (
            <Button
              variant="outline"
              isDisabled={busy}
              onPress={() => {
                setRotating(null);
                setMaterial('');
                hold.current = null;
              }}
            >
              Cancel shared MCP replacement
            </Button>
          ) : null}
          <TextField
            label="Shared grant Agent"
            value={agentId}
            onChange={setAgentId}
            isDisabled={disabled}
          />
          <TextField
            label="Shared grant AgentSession"
            value={sessionId}
            onChange={setSessionId}
            isDisabled={disabled}
          />
          <Select
            label="Shared grant capability"
            selectedKey={capabilityId || 'unrestricted'}
            items={[
              { id: 'unrestricted', label: 'No new capability restriction' },
              { id: 'mcp.list_tools', label: 'MCP tool discovery' },
              { id: 'mcp.call_tool', label: 'MCP tool call' },
            ]}
            isDisabled={disabled}
            onSelectionChange={(key) =>
              setCapabilityId(key === 'mcp.list_tools' || key === 'mcp.call_tool' ? key : '')
            }
          />
          <TextField
            label="Shared grant expiry (UTC)"
            value={expiresAt}
            onChange={setExpiresAt}
            isDisabled={disabled}
          />
          <p>
            Blank restrictions are unconstrained at issue and preserve existing restrictions when
            narrowing. Narrowing must reduce authority.
          </p>
          {inventory.data?.references.length === 0 ? <p>No shared MCP secrets.</p> : null}
          {inventory.data?.references.map((reference) => (
            <div key={reference.referenceId} className="flex flex-col gap-2">
              <p>
                {reference.referenceId} · version {reference.currentVersion} · {reference.status}
              </p>
              {reference.status === 'active' ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    isDisabled={disabled}
                    onPress={() => {
                      setMaterial('');
                      setRotating(reference.referenceId);
                    }}
                  >
                    Rotate shared secret {reference.referenceId}
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={disabled}
                    onPress={() => changeGrant('grant', reference.referenceId)}
                  >
                    Create shared gateway grant {reference.referenceId}
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={disabled}
                    onPress={() => mutation.mutate({ action: 'revoke', id: reference.referenceId })}
                  >
                    Revoke shared secret {reference.referenceId}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
          <h3 className="font-semibold text-fg">Shared MCP grants</h3>
          {inventory.data?.grants.length === 0 ? <p>No shared MCP grants.</p> : null}
          {inventory.data?.grants.map((grant) => (
            <div key={grant.grantId} className="flex flex-col gap-2">
              <p>{grant.grantId}</p>
              <p>
                {grant.vaultReferenceId} · {grant.status} · gateway-only · server
              </p>
              <p>
                Agent: {grant.targetAgentId ?? 'Unrestricted'} · AgentSession:{' '}
                {grant.targetAgentSessionId ?? 'Unrestricted'} · capability:{' '}
                {grant.targetCapabilityId ?? 'Unrestricted'} · expiry:{' '}
                {grant.expiresAt ?? 'No time bound'}
              </p>
              <p>
                Approval: {grant.approvalId ?? 'None'} · Policy decision:{' '}
                {grant.policyDecisionId ?? 'None'}
              </p>
              {grant.status === 'active' ? (
                <>
                  <Button
                    variant="outline"
                    isDisabled={disabled || Object.keys(constraints).length === 0}
                    onPress={() => changeGrant('narrow', grant.grantId)}
                  >
                    Narrow shared grant {grant.grantId}
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={disabled}
                    onPress={() => mutation.mutate({ action: 'revoke-grant', id: grant.grantId })}
                  >
                    Revoke shared grant {grant.grantId}
                  </Button>
                </>
              ) : null}
            </div>
          ))}
          <h3 className="font-semibold text-fg">Shared MCP delivery evidence</h3>
          <p>
            A plan describes intended delivery. A successful use records backend resolution. A
            receipt confirms credential delivery, independently of the upstream work result.
          </p>
          {inventory.data?.plans.map((plan) => (
            <p key={plan.planId}>
              Plan {plan.planId} · grant {plan.grantId} · {plan.injectionVisibility} · {plan.status}
            </p>
          ))}
          {inventory.data?.uses.map((use) => (
            <p key={use.useId}>
              Resolution {use.useId} · reference {use.vaultReferenceId} · grant{' '}
              {use.grantId ?? 'None'} · plan {use.planId ?? 'None'} · receipt link{' '}
              {use.receiptId ?? 'None'} · call {use.capabilityCallId ?? 'None'} · {use.outcome} ·{' '}
              {use.failureCode ?? 'No resolution failure'}
            </p>
          ))}
          {inventory.data?.receipts.map((receipt) => (
            <p key={receipt.receiptId}>
              Completed delivery {receipt.receiptId} · plan {receipt.planId} · grant{' '}
              {receipt.grantId} · call {receipt.capabilityCallId ?? 'None'} · {receipt.injectedAt} ·{' '}
              {receipt.revocationStatus}
            </p>
          ))}
          {!inventory.data?.plans.length &&
          !inventory.data?.uses.length &&
          !inventory.data?.receipts.length ? (
            <p>No shared MCP delivery evidence.</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
