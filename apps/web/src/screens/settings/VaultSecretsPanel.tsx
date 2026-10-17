import {
  NarrowWorkspaceVaultGrantRequestSchema,
  type OperationInput,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import { Button, Card, ErrorBanner, Select, TextField } from '../../primitives';
import { redactSecretShapedText } from './secret-safe';

/** Retain status for access-denial handling without retaining server error content. */
function safeError(error: unknown) {
  return new ApiCallError(
    error instanceof ApiCallError ? error.status : 0,
    'Vault request failed. Refresh inventory before a new request.'
  );
}

/** Administer selected-workspace secrets; material never enters query or mutation variables. */
export function VaultSecretsPanel({ workspaceId }: { readonly workspaceId: string }) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const [secretKind, setSecretKind] = useState('');
  const [material, setMaterial] = useState('');
  const [rotating, setRotating] = useState<string | null>(null);
  const [targetAgentId, setTargetAgentId] = useState('');
  const [targetAgentSessionId, setTargetAgentSessionId] = useState('');
  const [targetCapabilityId, setTargetCapabilityId] = useState<
    '' | 'mcp.list-tools' | 'mcp.call-tool'
  >('');
  const [grantExpiry, setGrantExpiry] = useState('');
  const [grantStatus, setGrantStatus] = useState<string | null>(null);
  const constraints: OperationInput<'vault.grant-narrow'>['constraints'] = {
    ...(targetAgentId.trim() ? { targetAgentId: targetAgentId.trim() } : {}),
    ...(targetAgentSessionId.trim() ? { targetAgentSessionId: targetAgentSessionId.trim() } : {}),
    ...(targetCapabilityId ? { targetCapabilityId } : {}),
    ...(grantExpiry.trim() ? { expiresAt: grantExpiry.trim() } : {}),
  };
  const hold = useRef<string | null>(null);
  const inventory = useQuery({
    queryKey: ['settings', 'vault-secrets', workspaceId],
    queryFn: async () => {
      try {
        const [references, grants] = await Promise.all([
          client.operations['vault.reference-list']({ workspaceId }),
          client.operations['vault.grant-list']({ workspaceId }),
        ]);
        return {
          references: references.items.map(
            ({ referenceId, secretKind, currentVersion, status }) => ({
              referenceId: redactSecretShapedText(referenceId),
              secretKind: redactSecretShapedText(secretKind),
              currentVersion,
              status,
            })
          ),
          grants: grants.items.map(
            ({
              grantId,
              vaultReferenceId,
              status,
              targetAgentId,
              targetAgentSessionId,
              targetCapabilityId,
              allowedInjectionPaths,
              lifetime,
              expiresAt,
              approvalId,
              policyDecisionId,
            }) => ({
              grantId: redactSecretShapedText(grantId),
              vaultReferenceId: redactSecretShapedText(vaultReferenceId),
              status,
              targetAgentId: targetAgentId === null ? null : redactSecretShapedText(targetAgentId),
              targetAgentSessionId:
                targetAgentSessionId === null ? null : redactSecretShapedText(targetAgentSessionId),
              targetCapabilityId:
                targetCapabilityId === null ? null : redactSecretShapedText(targetCapabilityId),
              allowedInjectionPaths: allowedInjectionPaths.map(redactSecretShapedText),
              lifetime,
              expiresAt,
              approvalId: approvalId === null ? null : redactSecretShapedText(approvalId),
              policyDecisionId:
                policyDecisionId === null ? null : redactSecretShapedText(policyDecisionId),
            })
          ),
        };
      } catch (error) {
        throw safeError(error);
      }
    },
    retry: false,
  });
  const mutation = useMutation({
    mutationKey: ['vault-admin-secret', workspaceId],
    mutationFn: async (input: {
      action: 'save' | 'revoke' | 'grant' | 'revoke-grant' | 'narrow-grant';
      id?: string;
      constraints?: OperationInput<'vault.grant-narrow'>['constraints'];
    }) => {
      const secret = hold.current;
      hold.current = null;
      try {
        if (input.action === 'save') {
          if (!secret) throw new Error('Secret is required.');
          if (input.id)
            await client.operations['vault.secret-rotate']({
              workspaceId,
              referenceId: input.id,
              material: secret,
            });
          else
            await client.operations['vault.secret-create']({
              workspaceId,
              secretKind,
              material: secret,
            });
        } else if (input.action === 'grant')
          await client.operations['vault.grant-create']({
            workspaceId,
            referenceId: input.id!,
            ...input.constraints,
          });
        else if (input.action === 'narrow-grant')
          await client.operations['vault.grant-narrow']({
            workspaceId,
            grantId: input.id!,
            constraints: input.constraints ?? {},
          });
        else if (input.action === 'revoke-grant')
          await client.operations['vault.grant-revoke']({
            workspaceId,
            grantId: input.id!,
          });
        else
          await client.operations['vault.secret-revoke']({
            workspaceId,
            referenceId: input.id!,
          });
        // Discard mutation responses: only a fresh, whitelisted inventory enters the cache.
      } catch (error) {
        throw safeError(error);
      }
    },
    retry: false,
    onMutate: () => {
      setGrantStatus(null);
    },
    onSuccess: async (_, input) => {
      setRotating(null);
      if (input.action === 'grant' || input.action === 'narrow-grant') {
        setTargetAgentId('');
        setTargetAgentSessionId('');
        setTargetCapabilityId('');
        setGrantExpiry('');
        if (input.action === 'narrow-grant')
          setGrantStatus('Grant replaced. Bind the replacement explicitly before use.');
      }
      await inventory.refetch();
      await queryClient.invalidateQueries({ queryKey: ['settings', 'vault', workspaceId] });
    },
    onSettled: () => {
      hold.current = null;
      setMaterial('');
    },
  });
  useEffect(
    () => () => {
      hold.current = null;
    },
    []
  );
  const denied = [inventory.error, mutation.error].some(
    (error) => error instanceof ApiCallError && [401, 403].includes(error.status)
  );
  useEffect(() => {
    if (denied || inventory.isError) {
      hold.current = null;
      setMaterial('');
    }
  }, [denied, inventory.isError]);
  const busy = inventory.isFetching || mutation.isPending;
  const disabled = busy || inventory.isError || mutation.isError;
  /** Refresh metadata without replaying a mutation or retaining a secret draft. */
  function refresh() {
    hold.current = null;
    setMaterial('');
    setRotating(null);
    mutation.reset();
    void inventory.refetch();
  }
  /** Validate before mutation retention; Core Client validation occurs after that cache boundary. */
  function submitGrant(action: 'grant' | 'narrow-grant', id: string) {
    const parsed = NarrowWorkspaceVaultGrantRequestSchema.shape.constraints.safeParse(constraints);
    if (!parsed.success) {
      hold.current = null;
      setMaterial('');
      setTargetAgentId('');
      setTargetAgentSessionId('');
      setTargetCapabilityId('');
      setGrantExpiry('');
      setGrantStatus('Grant restriction fields are invalid. Enter exact supported bounds only.');
      return;
    }
    mutation.mutate({ action, id, constraints: parsed.data });
  }
  if (denied)
    return (
      <Card>
        <p>Access denied.</p>
        <Button onPress={refresh}>Refresh inventory</Button>
      </Card>
    );
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg">Workspace secrets</h2>
      <p className="text-sm text-fg-muted">
        Manage secrets for the selected Workspace. Revoking a secret destroys its stored values and
        revokes its grants.
      </p>
      {inventory.isError || mutation.isError ? (
        <ErrorBanner message="Vault request failed. Refresh inventory before a new request." />
      ) : null}
      {grantStatus ? <p role="status">{grantStatus}</p> : null}
      <TextField
        label="Secret kind"
        value={secretKind}
        onChange={setSecretKind}
        isDisabled={disabled || rotating !== null}
      />
      <TextField
        label="Secret value"
        type="password"
        autoComplete="off"
        value={material}
        onChange={setMaterial}
        isDisabled={disabled}
      />
      {rotating ? <p>Replacing {rotating}</p> : null}
      <Button
        isDisabled={disabled || !material || (!rotating && !secretKind.trim())}
        onPress={() => {
          if (disabled || !material) return;
          hold.current = material;
          setMaterial('');
          mutation.mutate({ action: 'save', ...(rotating ? { id: rotating } : {}) });
        }}
      >
        {rotating ? 'Save replacement' : 'Add secret'}
      </Button>
      {rotating ? (
        <Button
          variant="outline"
          isDisabled={busy}
          onPress={() => {
            setRotating(null);
            setMaterial('');
          }}
        >
          Cancel replacement
        </Button>
      ) : null}
      <Button variant="outline" isDisabled={busy} onPress={refresh}>
        Refresh inventory
      </Button>
      <h3 className="font-semibold text-fg">Grant restrictions</h3>
      <p className="text-sm text-fg-muted">
        These restrictions apply to the Create or Narrow action you select below. Blank targets add
        no restriction at creation and preserve existing targets when narrowing. Narrowing must
        reduce authority and creates a replacement grant.
      </p>
      <TextField
        label="Grant target Agent"
        value={targetAgentId}
        onChange={setTargetAgentId}
        isDisabled={disabled}
      />
      <TextField
        label="Grant target AgentSession"
        value={targetAgentSessionId}
        onChange={setTargetAgentSessionId}
        isDisabled={disabled}
      />
      <Select
        label="Grant capability"
        selectedKey={targetCapabilityId || 'unchanged'}
        onSelectionChange={(key) =>
          setTargetCapabilityId(key === 'mcp.list-tools' || key === 'mcp.call-tool' ? key : '')
        }
        isDisabled={disabled}
        items={[
          { id: 'unchanged', label: 'No new capability restriction' },
          { id: 'mcp.list-tools', label: 'MCP tool discovery only' },
          { id: 'mcp.call-tool', label: 'MCP tool calls only' },
        ]}
      />
      <TextField
        label="Grant expiry (UTC)"
        value={grantExpiry}
        onChange={setGrantExpiry}
        isDisabled={disabled}
      />
      {inventory.data?.references.map((reference) => (
        <div key={reference.referenceId} className="flex flex-col gap-2">
          <p>
            {reference.referenceId} · {reference.secretKind} · version {reference.currentVersion} ·{' '}
            {reference.status}
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
                Rotate {reference.referenceId}
              </Button>
              <Button
                variant="outline"
                isDisabled={disabled}
                onPress={() => submitGrant('grant', reference.referenceId)}
              >
                Create gateway grant for {reference.referenceId}
              </Button>
              <Button
                variant="outline"
                isDisabled={disabled}
                onPress={() => mutation.mutate({ action: 'revoke', id: reference.referenceId })}
              >
                Revoke {reference.referenceId}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      <h3 className="font-semibold text-fg">Grants</h3>
      <p className="text-sm text-fg-muted">
        Bind a gateway grant ID to the selected MCP server through catalog.mcp-binding.
      </p>
      {inventory.data?.grants.map((grant) => (
        <div key={grant.grantId} className="flex flex-col gap-2">
          <p>
            {grant.grantId} · {grant.vaultReferenceId} · {grant.status}
          </p>
          <p>Agent: {grant.targetAgentId ?? 'Unrestricted'}</p>
          <p>AgentSession: {grant.targetAgentSessionId ?? 'Unrestricted'}</p>
          <p>Capability: {grant.targetCapabilityId ?? 'Unrestricted'}</p>
          <p>Visibility: {grant.allowedInjectionPaths.join(', ')}</p>
          <p>Lifetime: {grant.lifetime}</p>
          <p>Expiry: {grant.expiresAt ?? 'No time bound'}</p>
          <p>Approval: {grant.approvalId ?? 'None'}</p>
          <p>Policy decision: {grant.policyDecisionId ?? 'None'}</p>
          {grant.status === 'active' && grant.lifetime === 'workspace' ? (
            <Button
              variant="outline"
              isDisabled={disabled || Object.keys(constraints).length === 0}
              onPress={() => submitGrant('narrow-grant', grant.grantId)}
            >
              Narrow grant {grant.grantId}
            </Button>
          ) : null}
          {grant.status === 'active' ? (
            <Button
              variant="outline"
              isDisabled={disabled}
              onPress={() => mutation.mutate({ action: 'revoke-grant', id: grant.grantId })}
            >
              Revoke grant {grant.grantId}
            </Button>
          ) : null}
        </div>
      ))}
    </Card>
  );
}
