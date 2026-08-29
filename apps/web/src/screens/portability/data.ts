import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useCoreClient } from '../../app/core-client';
import { chatKeys, useCurrentWorkspaceId, useWorkspaces } from '../chat/data';
import { settingsKeys } from '../settings/data';

/** Schema-owned export result from `exportWorkspace`. */
export type PortabilityExportResult = Awaited<ReturnType<CoreClient['app']['exportWorkspace']>>;
/** Schema-owned dry-run review from `dryRunWorkspaceImport`. */
export type PortabilityImportReview = Awaited<
  ReturnType<CoreClient['app']['dryRunWorkspaceImport']>
>;
/** Schema-owned import result from `importWorkspace`. */
export type PortabilityImportResult = Awaited<ReturnType<CoreClient['app']['importWorkspace']>>;
/** Exact import command accepted by `importWorkspace`. */
export type PortabilityImportCommand = Parameters<CoreClient['app']['importWorkspace']>[0];
/** Exact dry-run command accepted by `dryRunWorkspaceImport`. */
export type PortabilityReviewCommand = Parameters<CoreClient['app']['dryRunWorkspaceImport']>[0];
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
 * @returns False for Quick Chat; true for project workspaces.
 */
export function isPortabilityProjectKind(kind: string | undefined): boolean {
  return Boolean(kind) && kind !== 'quick-chat';
}

/**
 * Builds the exact retryable import command, creating a request id only on first attempt.
 *
 * @param previous Command retained by a failed import, if any.
 * @param sourceWorkspaceId Source Workspace handle from the review form.
 * @param exportId Export handle from the review form.
 * @returns Exact `importWorkspace` payload.
 */
export function nextImportCommand(
  previous: PortabilityImportCommand | undefined,
  sourceWorkspaceId: string,
  exportId: string
): PortabilityImportCommand {
  if (
    previous &&
    previous.sourceWorkspaceId === sourceWorkspaceId &&
    previous.exportId === exportId &&
    previous.requestId
  ) {
    return previous;
  }
  return {
    sourceWorkspaceId,
    exportId,
    requestId: createRequestId(),
  };
}

/**
 * Maps a typed or uncertain export failure to product-safe copy without private text.
 *
 * @param error Mutation failure retained by TanStack Query.
 * @returns Safe banner copy.
 */
export function exportWorkspaceError(error: unknown): string {
  const code = apiCode(error);
  if (code === 'conflict') {
    return 'Export is blocked by a conflict, pending input, or unresolved work.';
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
 * Maps a typed import-review failure to product-safe copy without private text.
 *
 * @param error Mutation failure retained by TanStack Query.
 * @returns Safe banner copy.
 */
export function dryRunWorkspaceImportError(error: unknown): string {
  const code = apiCode(error);
  if (code === 'workspace_import_forbidden') {
    return 'This import is forbidden or unavailable.';
  }
  if (code === 'workspace_access_denied') {
    return 'Access denied.';
  }
  return "Couldn't review this import.";
}

/**
 * Maps a typed import failure to product-safe copy without private text.
 *
 * @param error Mutation failure retained by TanStack Query.
 * @returns Safe banner copy.
 */
export function importWorkspaceError(error: unknown): string {
  const code = apiCode(error);
  if (code === 'workspace_import_forbidden') {
    return 'This import is forbidden or unavailable.';
  }
  if (code === 'workspace_access_denied') {
    return 'Access denied.';
  }
  return "Couldn't import this workspace.";
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
 * Exports the selected Workspace through `exportWorkspace`.
 *
 * @returns Mutation that retains the schema-owned export response.
 */
export function useExportWorkspace() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (workspaceId: string) => client.app.exportWorkspace(workspaceId),
    retry: false,
  });
}

/**
 * Reviews a server-managed import through `dryRunWorkspaceImport`.
 *
 * @returns Mutation that retains the schema-owned dry-run response.
 */
export function useDryRunWorkspaceImport() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: PortabilityReviewCommand) => client.app.dryRunWorkspaceImport(input),
    retry: false,
  });
}

/**
 * Imports a reviewed workspace export through `importWorkspace`, then refreshes Workspace discovery.
 *
 * @returns Mutation that keeps the exact request identity for retry.
 */
export function useImportWorkspace() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: PortabilityImportCommand) => client.app.importWorkspace(command),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.workspaces });
    },
  });
}

/**
 * Rebinds one unbound vault reference, then rereads the shared Settings Vault owner.
 *
 * Vault material is held in an ephemeral ref scoped to one workspace and reference
 * and is never copied into TanStack mutation variables or cache.
 *
 * @returns Mutation over `rebindWorkspaceVaultReference` plus a submit helper.
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
      return client.app.rebindWorkspaceVaultReference(target.workspaceId, target.referenceId, {
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
