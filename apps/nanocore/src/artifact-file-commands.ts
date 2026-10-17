import type { Readable } from 'node:stream';
import {
  type ImportWorkspaceArtifactRequest,
  ImportWorkspaceArtifactResponseSchema,
} from '@openkit/app-api-schemas';
import { deriveEntityId, responsibleUserIdForActor } from '@openkit/protocol';
import { ArtifactAuthorityError, type CommandRequestRecord, type FsStore } from './lib/store.js';
import type { AdmittedOperationContext } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type {
  FileStorageAdmission,
  FileStorageReservation,
} from './storage/artifacts/file-admission.js';
import {
  ArtifactPayloadCleanupError,
  stageArtifactPayload,
} from './storage/artifacts/file-payload.js';
import { withCanonicalFileWriteAdmission } from './storage/canonical-write-capacity.js';
import type { WorkspaceDb } from './storage/db.js';
import { resolveDataRootPath } from './storage/fs-layout.js';

/** Imports one streamed original through the existing Artifact and command receipt owners. */
export async function importArtifactFile(input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly admission: FileStorageAdmission;
  readonly metadata: ImportWorkspaceArtifactRequest & { readonly workspaceId: string };
  readonly context: AdmittedOperationContext;
  readonly source: Readable;
  /** Rechecks live authority after capture, without trusting the original admission forever. */
  readonly assertAuthorized: () => void;
}) {
  const { store, workspaceDb, metadata, context } = input;
  const actorId = responsibleUserIdForActor(context.actorRef);
  if (!actorId || workspaceDb.workspaceId !== metadata.workspaceId) {
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  }
  input.assertAuthorized();
  store.getWorkspace(metadata.workspaceId);
  const artifactId = deriveEntityId('ar', [
    context.actorRef,
    metadata.workspaceId,
    'artifact.import',
    metadata.requestId,
  ]);
  let reservation: FileStorageReservation | undefined;
  let staged: Awaited<ReturnType<typeof stageArtifactPayload>> | undefined;
  let cleanupUnproved = false;
  const failures: unknown[] = [];
  let response: ReturnType<typeof ImportWorkspaceArtifactResponseSchema.parse> | undefined;
  try {
    response = await runIdempotentCommand({
      store,
      workspaceDb,
      inflightCommands: input.inflightCommands,
      command: 'artifact.import',
      requestId: metadata.requestId,
      scope: { actorId, workspaceId: metadata.workspaceId },
      input: {
        title: metadata.title,
        mediaType: metadata.mediaType,
        contentDigest: metadata.contentDigest,
        byteLength: metadata.byteLength,
      },
      responseKind: 'artifact',
      execute: async () => {
        if (
          store.listArtifacts(metadata.workspaceId).some((artifact) => artifact.id === artifactId)
        ) {
          throw new ArtifactAuthorityError(
            'recovery_required',
            'The request-owned Artifact already exists without an accepted receipt.'
          );
        }
        reservation = input.admission.reserve({
          stagingBytes: BigInt(metadata.byteLength),
          extractionBytes: 0n,
          derivativeBytes: 0n,
          publicationBytes: 65_536n,
        });
        staged = await stageArtifactPayload({
          workspaceRoot: resolveDataRootPath(
            workspaceDb.dataRoot,
            'workspaces',
            metadata.workspaceId
          ),
          source: input.source,
          expectedByteLength: metadata.byteLength,
          expectedDigest: metadata.contentDigest,
          reservation,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        input.assertAuthorized();
        context.signal?.throwIfAborted();
        reservation.assertAvailable();
        const acceptedAt = new Date().toISOString();
        const payload = staged;
        const artifact = withCanonicalFileWriteAdmission(input.admission, () =>
          store.createArtifact(
            {
              id: artifactId,
              workspaceId: metadata.workspaceId,
              threadId: null,
              turnId: null,
              kind: 'file',
              title: metadata.title,
              status: 'ready',
              summary: null,
              version: 1,
              content: {
                format: 'file',
                mediaType: metadata.mediaType,
                byteLength: payload.byteLength,
              },
              contentDigest: payload.contentDigest,
              lastMutationRequestId: metadata.requestId,
              origin: {
                kind: 'imported',
                sourceKind: 'direct-import',
                sourceId: metadata.requestId,
                sourceDigest: payload.contentDigest,
                actor: { kind: 'user', id: actorId },
                requestId: metadata.requestId,
                recordedAt: acceptedAt,
              },
              createdAt: acceptedAt,
              updatedAt: acceptedAt,
            },
            payload
          )
        );
        return ImportWorkspaceArtifactResponseSchema.parse({
          artifactId: artifact.id,
          artifactVersion: artifact.version,
        });
      },
      replay: (record) => replayImportedFile(store, artifactId, actorId, metadata, record),
      responseId: (result) => result.artifactId,
    });
  } catch (error) {
    cleanupUnproved = error instanceof ArtifactPayloadCleanupError;
    failures.push(error);
  }
  input.source.destroy();
  try {
    await staged?.remove();
  } catch (error) {
    cleanupUnproved = true;
    failures.push(error);
  }
  if (!cleanupUnproved) reservation?.release();
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new ArtifactPayloadCleanupError(failures);
  if (!response)
    throw new OperationError('recovery_required', 'Artifact acknowledgement is unavailable.', 503);
  return response;
}

/** Proves an accepted receipt against the same immutable original without consuming retry bytes. */
function replayImportedFile(
  store: FsStore,
  artifactId: string,
  actorId: string,
  metadata: ImportWorkspaceArtifactRequest & { readonly workspaceId: string },
  record: CommandRequestRecord
) {
  const artifact = store.getArtifact(metadata.workspaceId, artifactId);
  const origin = artifact.origin;
  if (
    record.response.kind !== 'artifact' ||
    record.response.id !== artifactId ||
    artifact.version !== 1 ||
    artifact.content.format !== 'file' ||
    artifact.content.byteLength !== metadata.byteLength ||
    artifact.content.mediaType !== metadata.mediaType ||
    artifact.contentDigest !== metadata.contentDigest ||
    artifact.title !== metadata.title ||
    origin.kind !== 'imported' ||
    origin.sourceKind !== 'direct-import' ||
    origin.sourceId !== metadata.requestId ||
    origin.requestId !== metadata.requestId ||
    origin.sourceDigest !== metadata.contentDigest ||
    origin.actor.kind !== 'user' ||
    origin.actor.id !== actorId ||
    artifact.lastMutationRequestId !== metadata.requestId
  ) {
    throw new ArtifactAuthorityError(
      'recovery_required',
      'The Artifact import proof is inconsistent.'
    );
  }
  store.assertArtifactContent(artifact);
  return ImportWorkspaceArtifactResponseSchema.parse({ artifactId, artifactVersion: 1 });
}
