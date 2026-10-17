import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { ArtifactMediaTypeSchema, MAX_ARTIFACT_FILE_BYTES } from '@openkit/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId, useThreads, useWorkspaces } from '../chat/data';
import { goalKeys, useArtifact } from '../goal/data';
import { sha256ArtifactFile } from './file-digest';

/** Product-safe Artifact list fields; list payloads never carry preview bytes. */
export type ArtifactListItem = Pick<
  Awaited<ReturnType<CoreClient['operations']['artifact.list']>>['items'][number],
  'id' | 'kind' | 'status' | 'summary' | 'title' | 'version'
>;

/** Media types admitted by the exact original streaming import. */
export type ArtifactImportMediaType = Parameters<
  CoreClient['artifactFiles']['import']
>[0]['mediaType'];

/** Frozen import command bound to one Workspace and request identity. */
export interface ArtifactImportInput {
  workspaceId: string;
  title: string;
  mediaType: ArtifactImportMediaType;
  content: string | Blob;
  requestId: string;
}

/** Frozen introduce command bound to one Workspace, Artifact version, and request identity. */
export interface ArtifactIntroduceInput {
  workspaceId: string;
  threadId: string;
  artifactId: string;
  expectedArtifactVersion: number;
  requestId: string;
}

/** Authoritative introduce settlement: command receipt, Turn read, and frozen request. */
export interface ArtifactIntroduceSettlement {
  result: Awaited<ReturnType<CoreClient['operations']['artifact.introduce']>>;
  turn: Awaited<ReturnType<CoreClient['operations']['turn.read']>>;
  input: ArtifactIntroduceInput;
}

/** Frozen user command retained across an unknown version publication result. */
export type ArtifactVersionCommitInput =
  | { kind: 'inline'; input: Parameters<CoreClient['operations']['artifact.version-commit']>[0] }
  | {
      kind: 'file';
      input: Omit<
        Parameters<CoreClient['artifactFiles']['commitVersion']>[0],
        'byteLength' | 'contentDigest'
      >;
      file: Blob;
    };

/** Publishes one next version and refreshes only its owning Artifact projections. */
export function useCommitArtifactVersion() {
  const client = useCoreClient();
  const cache = useQueryClient();
  const preparations = useRef(new WeakMap<ArtifactVersionCommitInput, Promise<string>>());
  return useMutation({
    mutationFn: async (command: ArtifactVersionCommitInput) => {
      const input = command.input;
      let result: Awaited<ReturnType<CoreClient['operations']['artifact.version-commit']>>;
      if (command.kind === 'inline') {
        result = await client.operations['artifact.version-commit'](command.input);
      } else {
        if (command.file.size > MAX_ARTIFACT_FILE_BYTES) {
          throw new ApiCallError(413, 'The file admission byte limit was exceeded.', {
            code: 'file_too_large',
          });
        }
        let preparation = preparations.current.get(command);
        if (!preparation) {
          preparation = sha256ArtifactFile(command.file);
          preparations.current.set(command, preparation);
        }
        let contentDigest: string;
        try {
          contentDigest = await preparation;
        } catch (error) {
          preparations.current.delete(command);
          throw error;
        }
        result = await client.artifactFiles.commitVersion(
          { ...command.input, byteLength: command.file.size, contentDigest },
          command.file
        );
      }
      if (
        result.artifact.workspaceId !== input.workspaceId ||
        result.artifact.id !== input.artifactId ||
        result.artifact.version !== input.expectedArtifactVersion + 1 ||
        result.version.workspaceId !== input.workspaceId ||
        result.version.artifactId !== input.artifactId ||
        result.version.artifactVersion !== input.expectedArtifactVersion + 1 ||
        result.version.parentVersion !== input.expectedArtifactVersion ||
        result.version.requestId !== input.requestId ||
        result.version.threadId !== input.threadId ||
        result.version.contentDigest !== result.artifact.contentDigest
      )
        throw new ApiCallError(409, 'Artifact version publication settlement is contradictory.', {
          code: 'recovery_required',
        });
      return result;
    },
    onSuccess: (_result, command) => {
      const { workspaceId, artifactId } = command.input;
      void cache.invalidateQueries({ queryKey: artifactKeys.list(workspaceId) });
      void cache.invalidateQueries({ queryKey: artifactKeys.versions(workspaceId, artifactId) });
      void cache.invalidateQueries({ queryKey: goalKeys.artifact(workspaceId, artifactId) });
    },
    retry: false,
  });
}

/** Maps version publication failures to public outcomes without exposing private server text. */
export function artifactVersionCommitErrorMessage(error: unknown): string {
  if (!(error instanceof ApiCallError))
    return 'The result is unknown. Retry the same version request to check it.';
  switch (error.code) {
    case 'workspace_access_denied':
      return 'Access denied. Refresh the current version before trying again.';
    case 'stale':
    case 'conflict':
      return 'The artifact changed. Refresh and select its current version before saving again.';
    case 'thread_busy':
      return 'That conversation is busy. Retry the same version request when it is idle.';
    case 'idempotency_key_conflict':
      return 'Request conflict. Refresh the current version before making a new request.';
    case 'recovery_required':
      return 'Recovery required. Inspect the current version before trying again.';
    case 'file_too_large':
      return 'That file exceeds the upload limit.';
    case 'invalid_request':
    case 'source_digest_mismatch':
      return 'The version was not saved. Check the draft and current version before trying again.';
    default:
      return 'The result is unknown. Retry the same version request to check it.';
  }
}

/** Only unknown results and the no-effect busy refusal can replay a frozen version request. */
export function isRetryableArtifactVersionCommit(error: unknown): boolean {
  if (!(error instanceof ApiCallError)) return true;
  switch (error.code) {
    case 'workspace_access_denied':
    case 'stale':
    case 'conflict':
    case 'idempotency_key_conflict':
    case 'recovery_required':
    case 'invalid_request':
    case 'source_digest_mismatch':
    case 'file_too_large':
      return false;
    default:
      return true;
  }
}

/** Stable TanStack Query keys for the selected-Workspace Artifact list. */
export const artifactKeys = {
  list: (workspaceId: string) => ['artifacts', workspaceId] as const,
  versions: (workspaceId: string, artifactId: string) =>
    ['artifact-versions', workspaceId, artifactId] as const,
  version: (workspaceId: string, artifactId: string, artifactVersion: number) =>
    ['artifact-version', workspaceId, artifactId, artifactVersion] as const,
};

/** Re-export selected-Workspace discovery, Thread list, and the existing exact Artifact read. */
export { createRequestId, useArtifact, useCurrentWorkspaceId, useThreads, useWorkspaces };

/**
 * Returns the typed API code when the failure is an `ApiCallError`.
 *
 * @param error Unknown query or mutation failure.
 * @returns Machine-readable code, or null.
 */
function apiCode(error: unknown): string | null {
  return error instanceof ApiCallError ? error.code : null;
}

/**
 * Returns whether a form string is one admitted import media type.
 *
 * @param value Raw media-type field.
 * @returns True when the value may be submitted.
 */
export function isArtifactImportMediaType(value: string): value is ArtifactImportMediaType {
  return ArtifactMediaTypeSchema.safeParse(value).success;
}

/**
 * Returns whether a failure is the typed Workspace access-denied contract.
 *
 * @param error Unknown query or mutation failure.
 * @returns True only for `workspace_access_denied`.
 */
export function isWorkspaceAccessDenied(error: unknown): boolean {
  return apiCode(error) === 'workspace_access_denied';
}

/**
 * Returns whether introduction must refresh authoritative reads instead of replaying.
 *
 * @param error Unknown introduce failure.
 * @returns True for typed `stale`, `conflict`, or `idempotency_key_conflict`.
 */
export function isIntroduceRefreshError(error: unknown): boolean {
  const code = apiCode(error);
  return code === 'stale' || code === 'conflict' || code === 'idempotency_key_conflict';
}

/**
 * Returns whether import must refresh authority instead of replaying the same request.
 *
 * @param error Unknown import failure.
 * @returns True for typed `idempotency_key_conflict`.
 */
export function isImportRefreshError(error: unknown): boolean {
  return apiCode(error) === 'idempotency_key_conflict';
}

/**
 * Returns whether import may continue from corrected input under a new request identity.
 *
 * @param error Unknown import failure.
 * @returns True for typed `invalid_request` or `source_digest_mismatch`.
 */
export function isCorrectableImportError(error: unknown): boolean {
  const code = apiCode(error);
  return code === 'invalid_request' || code === 'source_digest_mismatch';
}

/**
 * Returns whether the import banner may offer Try again.
 *
 * @param error Unknown import failure.
 * @returns True for uncertain transport, access-denied refresh, or idempotency refresh.
 */
export function isRetryableImportError(error: unknown): boolean {
  if (!(error instanceof ApiCallError)) return true;
  return error.code === 'workspace_access_denied' || error.code === 'idempotency_key_conflict';
}

/**
 * Returns whether the introduce banner may offer Try again.
 *
 * @param error Unknown introduce failure.
 * @returns True for uncertain transport, `thread_busy` replay, or authority refresh.
 */
export function isRetryableIntroduceError(error: unknown): boolean {
  if (!(error instanceof ApiCallError)) return true;
  switch (error.code) {
    case 'workspace_access_denied':
    case 'thread_busy':
    case 'stale':
    case 'conflict':
    case 'idempotency_key_conflict':
      return true;
    default:
      return false;
  }
}

/**
 * Maps an Artifact list failure to public copy with no private server text.
 *
 * @param error Unknown list failure.
 * @returns Access-denied or generic load copy.
 */
export function artifactListErrorMessage(error: unknown): string {
  return isWorkspaceAccessDenied(error) ? 'Access denied.' : "Couldn't load artifacts.";
}

/**
 * Maps an import failure to public copy with no private server text.
 *
 * @param error Unknown import failure.
 * @returns Typed public copy for denied, invalid, digest, recovery, and conflict failures.
 */
export function artifactImportErrorMessage(error: unknown): string {
  if (!(error instanceof ApiCallError)) {
    return "Couldn't import that artifact.";
  }
  switch (error.code) {
    case 'workspace_access_denied':
      return 'Access denied.';
    case 'invalid_request':
      return 'That request is invalid.';
    case 'source_digest_mismatch':
      return 'The content digest does not match.';
    case 'recovery_required':
      return 'Recovery required.';
    case 'idempotency_key_conflict':
      return 'Request conflict.';
    default:
      return "Couldn't import that artifact.";
  }
}

/**
 * Maps an introduce failure to public copy with no private server text.
 *
 * @param error Unknown introduce failure.
 * @returns Typed public copy for denied, busy, stale, invalid, recovery, and conflict failures.
 */
export function artifactIntroduceErrorMessage(error: unknown): string {
  if (!(error instanceof ApiCallError)) {
    return "Couldn't add that file to the conversation.";
  }
  switch (error.code) {
    case 'workspace_access_denied':
      return 'Access denied.';
    case 'thread_busy':
      return "Couldn't add the file because that conversation is busy.";
    case 'stale':
      return 'That artifact is no longer current.';
    case 'conflict':
      return 'The artifact changed. Use the expected version.';
    case 'invalid_request':
      return 'That request is invalid.';
    case 'recovery_required':
      return 'Recovery required.';
    case 'idempotency_key_conflict':
      return 'Request conflict.';
    default:
      return "Couldn't add that file to the conversation.";
  }
}

/**
 * Returns whether the completed Turn is the exact introduce receipt tuple.
 *
 * @param settlement Authoritative Turn read after the introduce command.
 * @param requestId Frozen request identity sent with the command.
 * @returns True only for one completed artifact-reference Item matching workspace, thread, artifact, version, request, and receipt.
 */
export function isAuthoritativeIntroduceItem(
  settlement: ArtifactIntroduceSettlement,
  requestId: string
): boolean {
  const { result, turn, input } = settlement;
  if (!turn || !input) return false;
  if (turn.status !== 'completed') return false;
  if (turn.id !== result.turnId) return false;
  if (turn.workspaceId !== input.workspaceId) return false;
  if (turn.threadId !== input.threadId) return false;
  if (input.requestId !== requestId) return false;
  if (result.artifactId !== input.artifactId) return false;
  if (result.artifactVersion !== input.expectedArtifactVersion) return false;
  const items = turn.items;
  if (items.length !== 1) return false;
  const item = items[0];
  return (
    item.type === 'artifact-reference' &&
    item.status === 'completed' &&
    item.id === result.itemId &&
    item.turnId === result.turnId &&
    item.workspaceId === input.workspaceId &&
    item.threadId === input.threadId &&
    item.artifactId === result.artifactId &&
    item.artifactVersion === result.artifactVersion &&
    item.lastMutationRequestId === requestId
  );
}

/**
 * Lists selected-Workspace Artifacts through `client.operations['artifact.list']`.
 *
 * @param workspaceId Validated selected Workspace, or null before discovery settles.
 * @returns TanStack query of product-safe list rows.
 */
export function useArtifacts(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: artifactKeys.list(workspaceId ?? ''),
    queryFn: async (): Promise<ArtifactListItem[]> => {
      const { items } = await client.operations['artifact.list']({
        workspaceId: workspaceId as string,
      });
      return items.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        summary: item.summary,
        title: item.title,
        version: item.version,
      }));
    },
    enabled: Boolean(workspaceId),
    retry: false,
  });
}

/** Reads retained immutable lineage for one selected Artifact without fetching its bytes. */
export function useArtifactVersions(
  workspaceId: string,
  artifactId: string,
  currentVersion: number
) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [...artifactKeys.versions(workspaceId, artifactId), currentVersion],
    queryFn: async () => {
      const result = await client.operations['artifact.version-list']({ workspaceId, artifactId });
      if (
        result.items.some(
          (version) => version.workspaceId !== workspaceId || version.artifactId !== artifactId
        )
      ) {
        throw new ApiCallError(409, 'Artifact version lineage does not match its selected owner.', {
          code: 'recovery_required',
        });
      }
      return result.items;
    },
    retry: false,
  });
}

/** Reads one exact retained version; a current-head or foreign response cannot replace it. */
export function useArtifactVersion(
  workspaceId: string,
  artifactId: string,
  artifactVersion: number,
  enabled: boolean
) {
  const client = useCoreClient();
  return useQuery({
    queryKey: artifactKeys.version(workspaceId, artifactId, artifactVersion),
    queryFn: async () => {
      const result = await client.operations['artifact.version-read']({
        workspaceId,
        artifactId,
        artifactVersion,
      });
      if (
        result.artifact.workspaceId !== workspaceId ||
        result.artifact.id !== artifactId ||
        result.artifact.version !== artifactVersion ||
        result.version.workspaceId !== workspaceId ||
        result.version.artifactId !== artifactId ||
        result.version.artifactVersion !== artifactVersion ||
        result.artifact.contentDigest !== result.version.contentDigest
      ) {
        throw new ApiCallError(409, 'Artifact version content does not match its selected owner.', {
          code: 'recovery_required',
        });
      }
      return result;
    },
    enabled,
    retry: false,
  });
}

/**
 * Imports one immutable Workspace Artifact bound to the command's Workspace.
 *
 * @returns Mutation over the exact original `client.artifactFiles.import` binding.
 */
export function useImportWorkspaceArtifact() {
  const client = useCoreClient();
  // Mutation variables retain one command and File through unknown settlement. Weak keys release
  // the prepared bytes and digest when the caller releases that draft; no server draft exists.
  const preparations = useRef(
    new WeakMap<ArtifactImportInput, Promise<{ body: Blob; contentDigest: string }>>()
  );
  return useMutation({
    mutationFn: async (input: ArtifactImportInput) => {
      let preparation = preparations.current.get(input);
      if (!preparation) {
        const file = typeof input.content === 'string' ? new Blob([input.content]) : input.content;
        if (file.size > MAX_ARTIFACT_FILE_BYTES) {
          throw new ApiCallError(413, 'The file admission byte limit was exceeded.', {
            code: 'file_too_large',
          });
        }
        preparation = sha256ArtifactFile(file).then((contentDigest) => ({
          body: file,
          contentDigest,
        }));
        preparations.current.set(input, preparation);
      }
      let prepared: Awaited<typeof preparation>;
      try {
        prepared = await preparation;
      } catch (error) {
        preparations.current.delete(input);
        throw error;
      }
      return client.artifactFiles.import(
        {
          workspaceId: input.workspaceId,
          title: input.title,
          mediaType: input.mediaType,
          byteLength: prepared.body.size,
          contentDigest: prepared.contentDigest,
          requestId: input.requestId,
        },
        prepared.body
      );
    },
    retry: false,
  });
}

/**
 * Introduces one exact Artifact version, then reads the authoritative completed Turn.
 *
 * @returns Mutation over `client.operations['artifact.introduce']` plus `client.operations['turn.read']`.
 */
export function useIntroduceWorkspaceArtifact() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: async (input: ArtifactIntroduceInput): Promise<ArtifactIntroduceSettlement> => {
      const result = await client.operations['artifact.introduce']({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        artifactId: input.artifactId,
        ...{
          expectedArtifactVersion: input.expectedArtifactVersion,
          requestId: input.requestId,
        },
      });
      const turn = await client.operations['turn.read']({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: result.turnId,
      });
      const settlement = { result, turn, input };
      if (!isAuthoritativeIntroduceItem(settlement, input.requestId)) {
        throw new ApiCallError(409, 'Introduction settlement was contradictory.', {
          code: 'recovery_required',
        });
      }
      return settlement;
    },
    retry: false,
  });
}

/** Exact original selected for explicit ZIP folder processing. */
export interface ArtifactFolderInput {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly originalDigest: string;
}

/** Reads one bounded inventory page; stale or failed reads never supply cached protected names. */
export function useArtifactFolder(input: ArtifactFolderInput, offset: number) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [
      'artifact-folder',
      input.workspaceId,
      input.artifactId,
      input.artifactVersion,
      input.originalDigest,
      offset,
    ],
    queryFn: async () => {
      const result = await client.operations['artifact.folder-read']({
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        artifactVersion: input.artifactVersion,
        offset,
      });
      assertFolderSource(input, result);
      return result;
    },
    retry: false,
  });
}

/** Explicit extraction is retryable from the exact retained original; it creates no new import. */
export function useExtractArtifactFolder() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: async (input: ArtifactFolderInput) => {
      const result = await client.operations['artifact.folder-extract']({
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        artifactVersion: input.artifactVersion,
        offset: 0,
      });
      assertFolderSource(input, result);
      return result;
    },
    retry: false,
  });
}

/** Prevents a current or unrelated source response from replacing the selected exact original. */
function assertFolderSource(
  input: ArtifactFolderInput,
  result: { artifactId: string; artifactVersion: number; originalDigest: string }
): void {
  if (
    result.artifactId !== input.artifactId ||
    result.artifactVersion !== input.artifactVersion ||
    result.originalDigest !== input.originalDigest
  )
    throw new ApiCallError(409, 'The folder snapshot source is inconsistent.', {
      code: 'recovery_required',
    });
}
