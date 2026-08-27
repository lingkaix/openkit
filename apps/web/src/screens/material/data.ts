import type { CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId } from '../chat/data';

/** The server-owned Workspace Material projection used by the screen. */
export type WorkspaceMaterial = Awaited<
  ReturnType<CoreClient['app']['listWorkspaceMaterials']>
>['materials'][number];

/** The immutable server-owned summary used by revision history. */
export type WorkspaceMaterialRevision = Awaited<
  ReturnType<CoreClient['app']['listWorkspaceMaterialRevisions']>
>['revisions'][number];

/** The two material formats admitted by the current App API. */
export type MaterialKind = WorkspaceMaterial['kind'];

/** The sensitivity choices admitted by the current App API. */
export type MaterialSensitivity = WorkspaceMaterial['sensitivity'];

/** Stable TanStack Query keys for the Workspace Material read models. */
export const materialKeys = {
  list: (workspaceId: string) => ['materials', workspaceId] as const,
  material: (workspaceId: string, materialId: string) =>
    ['material', workspaceId, materialId] as const,
  revisions: (workspaceId: string, materialId: string) =>
    ['material-revisions', workspaceId, materialId] as const,
  revision: (workspaceId: string, materialId: string, revisionId: string) =>
    ['material-revision', workspaceId, materialId, revisionId] as const,
  thread: (workspaceId: string, threadId: string) =>
    ['thread-material', workspaceId, threadId] as const,
};

/** Lists the current Workspace Materials through the public Core Client. */
export function useWorkspaceMaterials(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: materialKeys.list(workspaceId ?? ''),
    queryFn: async () => (await client.app.listWorkspaceMaterials(workspaceId as string)).materials,
    enabled: Boolean(workspaceId),
  });
}

/** Reads one server-owned Workspace Material identity. */
export function useWorkspaceMaterial(workspaceId: string | null, materialId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: materialKeys.material(workspaceId ?? '', materialId ?? ''),
    queryFn: () => client.app.getWorkspaceMaterial(workspaceId as string, materialId as string),
    enabled: Boolean(workspaceId && materialId),
  });
}

/** Lists immutable revision summaries without treating summaries as content. */
export function useWorkspaceMaterialRevisions(
  workspaceId: string | null,
  materialId: string | null
) {
  const client = useCoreClient();
  return useQuery({
    queryKey: materialKeys.revisions(workspaceId ?? '', materialId ?? ''),
    queryFn: () =>
      client.app.listWorkspaceMaterialRevisions(workspaceId as string, materialId as string),
    enabled: Boolean(workspaceId && materialId),
  });
}

/** Loads exact revision content only for the requested immutable revision id. */
export function useWorkspaceMaterialRevision(
  workspaceId: string | null,
  materialId: string | null,
  revisionId: string | null
) {
  const client = useCoreClient();
  return useQuery({
    queryKey: materialKeys.revision(workspaceId ?? '', materialId ?? '', revisionId ?? ''),
    queryFn: () =>
      client.app.getWorkspaceMaterialRevision(
        workspaceId as string,
        materialId as string,
        revisionId as string
      ),
    enabled: Boolean(workspaceId && materialId && revisionId),
  });
}

/** Reads the authoritative Thread Material projection without local state advancement. */
export function useThreadMaterial(workspaceId: string | null, threadId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
    queryFn: () => client.app.getThreadMaterial(workspaceId as string, threadId as string),
    enabled: Boolean(workspaceId && threadId),
  });
}

/**
 * Sends one exact current Material revision and re-reads only its Thread projection.
 *
 * @param workspaceId Workspace that owns the Material and Thread.
 * @param threadId Thread receiving the steering input.
 * @returns The send mutation backed by the public Core Client.
 */
export function useSendThreadMaterialDelivery(workspaceId: string | null, threadId: string | null) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { materialId: string; revisionId: string; contentDigest: string }) =>
      client.app.submitThreadGoalSteering(workspaceId as string, threadId as string, input),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
        exact: true,
      }),
  });
}

/**
 * Converts one queued Material delivery by its authoritative pending identity.
 *
 * @param workspaceId Workspace that owns the pending input.
 * @param threadId Thread that owns the pending input.
 * @param pendingTurnId Current server-projected pending identity.
 * @returns The follow-up mutation backed by the public Core Client.
 */
export function useConvertThreadMaterialDeliveryToFollowUp(
  workspaceId: string | null,
  threadId: string | null,
  pendingTurnId: string | null
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      client.app.convertGoalSteeringToFollowUp(
        workspaceId as string,
        threadId as string,
        pendingTurnId as string,
        {}
      ),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
        exact: true,
      }),
  });
}

/**
 * Cancels one queued Material delivery by its authoritative pending identity.
 *
 * @param workspaceId Workspace that owns the pending input.
 * @param threadId Thread that owns the pending input.
 * @param pendingTurnId Current server-projected pending identity.
 * @returns The cancellation mutation backed by the public Core Client.
 */
export function useCancelThreadMaterialDelivery(
  workspaceId: string | null,
  threadId: string | null,
  pendingTurnId: string | null
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      client.app.cancelGoalSteering(
        workspaceId as string,
        threadId as string,
        pendingTurnId as string,
        {}
      ),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
        exact: true,
      }),
  });
}

/** Binds the currently open Material and re-reads the authoritative Thread projection. */
export function useBindThreadMaterial(
  workspaceId: string | null,
  threadId: string | null,
  materialId: string | null
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expectedBindingState: 'not_bound' }) =>
      client.app.bindThreadMaterial(
        workspaceId as string,
        threadId as string,
        materialId as string,
        input
      ),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
        exact: true,
      }),
  });
}

/** Unbinds the current Thread Material and re-reads the authoritative projection. */
export function useUnbindThreadMaterial(
  workspaceId: string | null,
  threadId: string | null,
  materialId: string | null
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expectedBindingState: 'bound' }) =>
      client.app.unbindThreadMaterial(
        workspaceId as string,
        threadId as string,
        materialId as string,
        input
      ),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
        exact: true,
      }),
  });
}

/** Excludes the observed queued revision and re-reads the authoritative projection. */
export function useExcludeThreadMaterial(
  workspaceId: string | null,
  threadId: string | null,
  materialId: string | null
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      expectedBindingState: 'bound';
      expectedInclusionState: 'included';
      expectedQueuedRevisionId: string;
    }) =>
      client.app.excludeThreadMaterial(
        workspaceId as string,
        threadId as string,
        materialId as string,
        input
      ),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
        exact: true,
      }),
  });
}

/** Restores the excluded Thread Material and re-reads the authoritative projection. */
export function useRestoreThreadMaterial(
  workspaceId: string | null,
  threadId: string | null,
  materialId: string | null
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expectedBindingState: 'bound'; expectedInclusionState: 'excluded' }) =>
      client.app.restoreThreadMaterial(
        workspaceId as string,
        threadId as string,
        materialId as string,
        input
      ),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
        exact: true,
      }),
  });
}

/** Creates one Material and invalidates the server-owned Workspace list. */
export function useCreateWorkspaceMaterial(workspaceId: string | null) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; kind: MaterialKind; sensitivity: MaterialSensitivity }) =>
      client.app.createWorkspaceMaterial(workspaceId as string, input),
    onSuccess: () => {
      if (workspaceId)
        void queryClient.invalidateQueries({ queryKey: materialKeys.list(workspaceId) });
    },
  });
}

/**
 * Saves one exact draft and re-reads its registered-route Thread projection.
 *
 * @param workspaceId Workspace that owns the Material.
 * @param materialId Material receiving the immutable revision.
 * @param threadId Exact Thread from the registered Material route.
 * @returns The save mutation and its authoritative completion state.
 */
export function useSaveWorkspaceMaterialRevision(
  workspaceId: string | null,
  materialId: string,
  threadId: string
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      expectedRevisionId: string | null;
      contentDigest: string;
      content: string;
    }) => client.app.saveWorkspaceMaterialRevision(workspaceId as string, materialId, input),
    onSuccess: async () => {
      if (!workspaceId) return;
      void queryClient.invalidateQueries({ queryKey: materialKeys.list(workspaceId) });
      void queryClient.invalidateQueries({
        queryKey: materialKeys.material(workspaceId, materialId),
      });
      void queryClient.invalidateQueries({
        queryKey: materialKeys.revisions(workspaceId, materialId),
      });
      await queryClient.refetchQueries({
        queryKey: materialKeys.thread(workspaceId, threadId),
        exact: true,
      });
    },
  });
}

/** Computes the lowercase SHA-256 digest required by the Material contract. */
export async function sha256Content(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content)
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `sha256:${hex}`;
}

/** Re-exports the shared Workspace selection owner for the Material screen. */
export { useCurrentWorkspaceId };
