import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId, useThreads, useWorkspaces } from '../chat/data';
import { useArtifact } from '../goal/data';
import { sha256Content } from '../material/data';

/** Product-safe Artifact list fields; list payloads never carry preview bytes. */
export type ArtifactListItem = Pick<
  Awaited<ReturnType<CoreClient['core']['listArtifacts']>>['items'][number],
  'id' | 'kind' | 'status' | 'summary' | 'title' | 'version'
>;

/** Media types admitted by `client.app.importWorkspaceArtifact`. */
export type ArtifactImportMediaType = Parameters<
  CoreClient['app']['importWorkspaceArtifact']
>[1]['mediaType'];

/** Frozen import command bound to one Workspace and request identity. */
export interface ArtifactImportInput {
  workspaceId: string;
  title: string;
  mediaType: ArtifactImportMediaType;
  content: string;
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
  result: Awaited<ReturnType<CoreClient['app']['introduceWorkspaceArtifact']>>;
  turn: Awaited<ReturnType<CoreClient['core']['getTurn']>>;
  input: ArtifactIntroduceInput;
}

/** Stable TanStack Query keys for the selected-Workspace Artifact list. */
export const artifactKeys = {
  list: (workspaceId: string) => ['artifacts', workspaceId] as const,
};

const IMPORT_MEDIA_TYPES: readonly ArtifactImportMediaType[] = [
  'text/markdown',
  'text/plain',
  'application/json',
];

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
  return (IMPORT_MEDIA_TYPES as readonly string[]).includes(value);
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
    return "Couldn't introduce that artifact.";
  }
  switch (error.code) {
    case 'workspace_access_denied':
      return 'Access denied.';
    case 'thread_busy':
      return "Couldn't introduce because that thread is busy.";
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
      return "Couldn't introduce that artifact.";
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
 * Lists selected-Workspace Artifacts through `client.core.listArtifacts`.
 *
 * @param workspaceId Validated selected Workspace, or null before discovery settles.
 * @returns TanStack query of product-safe list rows.
 */
export function useArtifacts(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: artifactKeys.list(workspaceId ?? ''),
    queryFn: async (): Promise<ArtifactListItem[]> => {
      const { items } = await client.core.listArtifacts(workspaceId as string);
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

/**
 * Imports one immutable Workspace Artifact bound to the command's Workspace.
 *
 * @returns Mutation over `client.app.importWorkspaceArtifact`.
 */
export function useImportWorkspaceArtifact() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: async (input: ArtifactImportInput) =>
      client.app.importWorkspaceArtifact(input.workspaceId, {
        title: input.title,
        mediaType: input.mediaType,
        content: input.content,
        contentDigest: await sha256Content(input.content),
        requestId: input.requestId,
      }),
    retry: false,
  });
}

/**
 * Introduces one exact Artifact version, then reads the authoritative completed Turn.
 *
 * @returns Mutation over `client.app.introduceWorkspaceArtifact` plus `client.core.getTurn`.
 */
export function useIntroduceWorkspaceArtifact() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: async (input: ArtifactIntroduceInput): Promise<ArtifactIntroduceSettlement> => {
      const result = await client.app.introduceWorkspaceArtifact(
        input.workspaceId,
        input.threadId,
        input.artifactId,
        {
          expectedArtifactVersion: input.expectedArtifactVersion,
          requestId: input.requestId,
        }
      );
      const turn = await client.core.getTurn(input.workspaceId, input.threadId, result.turnId);
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
