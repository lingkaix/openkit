import type { CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId } from '../chat/data';

/** The server-owned Workspace Material projection used by the screen. */
export type WorkspaceMaterial = Awaited<
  ReturnType<CoreClient['operations']['material.list']>
>['materials'][number];

/** The immutable server-owned summary used by revision history. */
export type WorkspaceMaterialRevision = Awaited<
  ReturnType<CoreClient['operations']['material.revision-list']>
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
    queryFn: async () =>
      (await client.operations['material.list']({ workspaceId: workspaceId as string })).materials,
    enabled: Boolean(workspaceId),
  });
}

/** Reads one server-owned Workspace Material identity. */
export function useWorkspaceMaterial(workspaceId: string | null, materialId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: materialKeys.material(workspaceId ?? '', materialId ?? ''),
    queryFn: () =>
      client.operations['material.read']({
        workspaceId: workspaceId as string,
        materialId: materialId as string,
      }),
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
      client.operations['material.revision-list']({
        workspaceId: workspaceId as string,
        materialId: materialId as string,
      }),
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
      client.operations['material.revision-read']({
        workspaceId: workspaceId as string,
        materialId: materialId as string,
        revisionId: revisionId as string,
      }),
    enabled: Boolean(workspaceId && materialId && revisionId),
  });
}

/** Reads the authoritative Thread Material projection without local state advancement. */
export function useThreadMaterial(workspaceId: string | null, threadId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: materialKeys.thread(workspaceId ?? '', threadId ?? ''),
    queryFn: () =>
      client.operations['material.thread-read']({
        workspaceId: workspaceId as string,
        threadId: threadId as string,
      }),
    enabled: Boolean(workspaceId && threadId),
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
      client.operations['material.bind']({
        workspaceId: workspaceId as string,
        threadId: threadId as string,
        materialId: materialId as string,
        ...input,
      }),
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
      client.operations['material.unbind']({
        workspaceId: workspaceId as string,
        threadId: threadId as string,
        materialId: materialId as string,
        ...input,
      }),
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
      client.operations['material.exclude']({
        workspaceId: workspaceId as string,
        threadId: threadId as string,
        materialId: materialId as string,
        ...input,
      }),
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
      client.operations['material.restore']({
        workspaceId: workspaceId as string,
        threadId: threadId as string,
        materialId: materialId as string,
        ...input,
      }),
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
      client.operations['material.create']({ workspaceId: workspaceId as string, ...input }),
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
    }) =>
      client.operations['material.revision-save']({
        workspaceId: workspaceId as string,
        materialId: materialId,
        ...input,
      }),
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
