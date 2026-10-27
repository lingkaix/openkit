import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId, useWorkspaces } from '../chat/data';
import { settingsKeys } from '../settings/data';
import { parseWorkspaceFreezeRefusal } from '../workspace-freeze';

/** Selected-Workspace identity used to scope one vault rebind. */
export type PortabilityRebindTarget = {
  workspaceId: string;
  referenceId: string;
};

/** Re-export selected-Workspace discovery for the Portability screen. */
export { useCurrentWorkspaceId, useWorkspaces };

/**
 * Encodes Vault material as UTF-8 bytes then Base64 for `materialBase64`.
 *
 * @param value Password-field text entered by the user.
 * @returns Schema-owned Base64 payload.
 */
export function encodeVaultMaterial(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    const chars = new Array<string>(end - offset);
    for (let index = offset; index < end; index++) {
      chars[index - offset] = String.fromCharCode(bytes[index]!);
    }
    binary += chars.join('');
  }
  return btoa(binary);
}

/**
 * Turns a vault reference status token into the product label used by this surface.
 *
 * @param status Server-owned reference status.
 * @returns Sentence-style label such as Unbound or Active.
 */
export function portabilityVaultStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Returns whether selected-Workspace export and rebind apply to this Workspace kind.
 *
 * @param kind Workspace kind from discovery.
 * @returns True when an ordinary Workspace kind is available.
 */
export function isPortabilityProjectKind(kind: string | undefined): boolean {
  return Boolean(kind);
}

/**
 * Builds the same-origin archive GET href for one created export.
 *
 * @param workspaceId Source Workspace id; encoded as one path segment.
 * @param exportId Server-managed export handle; encoded as one path segment.
 * @returns Relative App API archive path.
 */
export function workspaceExportArchiveHref(workspaceId: string, exportId: string): string {
  return `/api/app/workspaces/${encodeURIComponent(workspaceId)}/exports/${encodeURIComponent(exportId)}/archive`;
}

/**
 * Maps a typed or uncertain export failure to product-safe copy without private text.
 *
 * @param error Mutation failure retained by TanStack Query.
 * @returns Safe banner copy, or null when a structured freeze refusal owns the UI.
 */
export function exportWorkspaceError(error: unknown): string | null {
  if (parseWorkspaceFreezeRefusal(error)) return null;
  const code = apiCode(error);
  if (code === 'conflict') {
    return 'Export is blocked by a conflict, pending input, or unresolved work.';
  }
  if (error instanceof ApiCallError && (error.status === 401 || error.status === 403)) {
    return 'Workspace export requires administrator authority.';
  }
  if (code === 'workspace_access_denied') {
    return 'Access denied for this workspace.';
  }
  if (error instanceof ApiCallError) {
    return "Couldn't export this workspace.";
  }
  return 'The export result is unknown. It is not known whether the export completed.';
}

/**
 * Maps a typed vault-rebind failure to product-safe copy without private text.
 *
 * @param error Mutation failure retained by TanStack Query.
 * @returns Safe banner copy.
 */
export function rebindWorkspaceVaultError(error: unknown): string {
  const code = apiCode(error);
  if (code === 'vault_reference_not_unbound') {
    return 'This vault reference is not unbound.';
  }
  if (code === 'vault_reference_not_found') {
    return 'This vault reference was not found.';
  }
  if (code === 'workspace_access_denied') {
    return 'Access denied for this workspace.';
  }
  if (code === 'vault_backend_not_available') {
    return 'The vault backend is not available.';
  }
  if (code === 'vault_storage_unavailable') {
    return 'Vault storage is not configured.';
  }
  return "Couldn't rebind this vault reference.";
}

/**
 * Exports the selected Workspace through `workspace.export`.
 *
 * @returns Mutation that retains the schema-owned export response.
 */
export function useExportWorkspace() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (workspaceId: string) => client.operations['workspace.export']({ workspaceId }),
    retry: false,
  });
}

/**
 * Rebinds one unbound vault reference, then rereads the shared Settings Vault owner.
 *
 * Vault material is held in an ephemeral ref scoped to one workspace and reference and is never copied into TanStack mutation variables or cache.
 *
 * @returns Mutation over `client.operations['vault.reference-rebind']` plus a submit helper.
 */
export function useRebindWorkspaceVaultReference() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const materialHold = useRef<(PortabilityRebindTarget & { materialBase64: string }) | null>(null);
  const mutation = useMutation({
    mutationFn: async (target: PortabilityRebindTarget) => {
      const prepared = materialHold.current;
      materialHold.current = null;
      if (
        !prepared ||
        prepared.workspaceId !== target.workspaceId ||
        prepared.referenceId !== target.referenceId
      ) {
        throw new Error('Vault material is no longer available.');
      }
      return client.operations['vault.reference-rebind']({
        workspaceId: target.workspaceId,
        referenceId: target.referenceId,
        materialBase64: prepared.materialBase64,
      });
    },
    retry: false,
    onSettled: (_data, _error, target) => {
      materialHold.current = null;
      void queryClient.invalidateQueries({ queryKey: settingsKeys.vault(target.workspaceId) });
    },
  });

  return {
    ...mutation,
    /**
     * Encodes material into the scoped hold, then rebinds one reference.
     *
     * @param workspaceId Selected Workspace that owns the reference.
     * @param referenceId Public reference identity.
     * @param material Password-field text; cleared from UI before the request.
     */
    submit(workspaceId: string, referenceId: string, material: string) {
      materialHold.current = {
        workspaceId,
        referenceId,
        materialBase64: encodeVaultMaterial(material),
      };
      mutation.mutate({ workspaceId, referenceId });
    },
  };
}

/**
 * Reads a typed API error code without exposing private failure text.
 *
 * @param error Unknown mutation or query failure.
 * @returns Server code, or null when the failure is not a typed API error.
 */
function apiCode(error: unknown): string | null {
  return error instanceof ApiCallError ? error.code : null;
}
