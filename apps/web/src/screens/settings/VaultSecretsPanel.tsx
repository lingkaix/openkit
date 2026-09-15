import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import { Button, Card, ErrorBanner, TextField } from '../../primitives';
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
  const [secretKind, setSecretKind] = useState('github-token');
  const [material, setMaterial] = useState('');
  const [rotating, setRotating] = useState<string | null>(null);
  const hold = useRef<string | null>(null);
  const inventory = useQuery({
    queryKey: ['settings', 'vault-secrets', workspaceId],
    queryFn: async () => {
      try {
        const [references, grants] = await Promise.all([
          client.app.listWorkspaceVaultReferences(workspaceId),
          client.app.listWorkspaceVaultGrants(workspaceId),
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
          grants: grants.items.map(({ grantId, vaultReferenceId, status }) => ({
            grantId: redactSecretShapedText(grantId),
            vaultReferenceId: redactSecretShapedText(vaultReferenceId),
            status,
          })),
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
      action: 'save' | 'revoke' | 'grant' | 'revoke-grant';
      id?: string;
    }) => {
      const secret = hold.current;
      hold.current = null;
      try {
        if (input.action === 'save') {
          if (!secret) throw new Error('Secret is required.');
          if (input.id)
            await client.app.rotateWorkspaceVaultSecret(workspaceId, input.id, {
              material: secret,
            });
          else
            await client.app.createWorkspaceVaultSecret(workspaceId, {
              secretKind,
              material: secret,
            });
        } else if (input.action === 'grant')
          await client.app.createWorkspaceVaultGrant(workspaceId, { referenceId: input.id! });
        else if (input.action === 'revoke-grant')
          await client.app.revokeWorkspaceVaultGrant(workspaceId, input.id!);
        else await client.app.revokeWorkspaceVaultSecret(workspaceId, input.id!);
        // Discard mutation responses: only a fresh, whitelisted inventory enters the cache.
      } catch (error) {
        throw safeError(error);
      }
    },
    retry: false,
    onSuccess: async () => {
      setRotating(null);
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
        isDisabled={disabled || !material || !secretKind}
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
                onPress={() => mutation.mutate({ action: 'grant', id: reference.referenceId })}
              >
                Grant host push for {reference.referenceId}
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
        Bind a grant ID to the repository through the public repository.set-default operation. Each
        push still requires approval.
      </p>
      {inventory.data?.grants.map((grant) => (
        <div key={grant.grantId} className="flex flex-col gap-2">
          <p>
            {grant.grantId} · {grant.vaultReferenceId} · {grant.status}
          </p>
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
