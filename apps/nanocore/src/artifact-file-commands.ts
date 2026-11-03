import type { Readable } from 'node:stream';
import {
  type CommitArtifactFileVersionRequest,
  type CommitArtifactVersionRequest,
  type CommitArtifactVersionResponse,
  type ImportWorkspaceArtifactRequest,
  ImportWorkspaceArtifactResponseSchema,
} from '@openkit/app-api-schemas';
import {
  canonicalIdentifierName,
  deriveEntityId,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { ArtifactAuthorityError } from './artifact-authority.js';
import type { CommandRequestRecord, FsStore } from './lib/store.js';
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
  let artifactCreated = false;
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
        artifactCreated = true;
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
    if (artifactCreated) {
      try {
        const receipt = store.getCommandRequest(
          'artifact.import',
          metadata.requestId,
          { actorId, workspaceId: metadata.workspaceId },
          workspaceDb
        );
        // A later maintenance failure can follow a committed receipt. Unknown results retain authority.
        if (
          !receipt &&
          error instanceof Database.SqliteError &&
          error.code.startsWith('SQLITE_CONSTRAINT')
        ) {
          withCanonicalFileWriteAdmission(input.admission, () =>
            store.rollbackArtifactCreation(artifactId)
          );
        }
      } catch (rollbackError) {
        cleanupUnproved = true;
        failures.push(rollbackError);
      }
    }
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
  input.assertAuthorized();
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
  const artifact = store.getArtifactVersion(metadata.workspaceId, artifactId, 1).artifact;
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

type Selectors = {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly threadId: string;
};

/** Shared exact-version command owner for inline and streamed originals; receipts never contain response snapshots. */
export async function commitArtifactVersionCommand(
  input: {
    readonly store: FsStore;
    readonly workspaceDb: WorkspaceDb;
    readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
    readonly context: AdmittedOperationContext;
    readonly assertAuthorized: () => void;
  } & (
    | {
        readonly command: 'artifact.version-commit';
        readonly metadata: CommitArtifactVersionRequest & Selectors;
        readonly file?: never;
        readonly admission?: FileStorageAdmission;
      }
    | {
        readonly command: 'artifact.version-file-commit';
        readonly metadata: CommitArtifactFileVersionRequest & Selectors;
        readonly file: { readonly source: Readable; readonly admission: FileStorageAdmission };
        readonly admission?: never;
      }
  )
): Promise<CommitArtifactVersionResponse> {
  const { store, metadata, context, workspaceDb } = input;
  const actorId = responsibleUserIdForActor(context.actorRef);
  if (!actorId || metadata.workspaceId !== workspaceDb.workspaceId)
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  const turnId = deriveEntityId('tu', [
    context.actorRef,
    metadata.workspaceId,
    metadata.threadId,
    input.command,
    metadata.requestId,
  ]);
  const expectedVersion = metadata.expectedArtifactVersion + 1;
  let reservation: FileStorageReservation | undefined;
  let staged: Awaited<ReturnType<typeof stageArtifactPayload>> | undefined;
  let cleanupUnproved = false;
  const failures: unknown[] = [];
  let response: CommitArtifactVersionResponse | undefined;
  try {
    input.assertAuthorized();
    response = await runIdempotentCommand({
      store,
      workspaceDb,
      inflightCommands: input.inflightCommands,
      command: input.command,
      requestId: metadata.requestId,
      scope: {
        actorId,
        workspaceId: metadata.workspaceId,
        threadId: metadata.threadId,
        artifactId: metadata.artifactId,
      },
      input: {
        ...metadata,
        requestId: undefined,
        workspaceId: undefined,
        threadId: undefined,
        artifactId: undefined,
      },
      responseKind: 'artifact',
      responseId: (result) => result.artifact.id,
      execute: async () => {
        // A complete tuple without its receipt is an unknown result, including after a later head advance.
        if (
          store
            .listArtifactVersions(metadata.workspaceId, metadata.artifactId)
            .some((version) => version.turnId === turnId)
        )
          throw recovery('The request-owned Artifact version exists without its receipt.');
        store.assertArtifactVersionCommit(metadata);
        if (input.command === 'artifact.version-file-commit') {
          reservation = input.file.admission.reserve({
            stagingBytes: BigInt(input.metadata.byteLength),
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
            source: input.file.source,
            expectedByteLength: input.metadata.byteLength,
            expectedDigest: input.metadata.contentDigest,
            reservation,
            ...(context.signal ? { signal: context.signal } : {}),
          });
        }
        input.assertAuthorized();
        context.signal?.throwIfAborted();
        reservation?.assertAvailable();
        const admission =
          input.command === 'artifact.version-file-commit' ? input.file.admission : input.admission;
        return await store.commitArtifactVersion(
          {
            ...metadata,
            actor: context.actorRef,
            recordedAt: new Date().toISOString(),
            command: input.command,
            content:
              input.command === 'artifact.version-commit'
                ? input.metadata.content
                : {
                    format: 'file',
                    mediaType: input.metadata.mediaType,
                    byteLength: input.metadata.byteLength,
                  },
            ...(input.command === 'artifact.version-file-commit'
              ? { contentDigest: input.metadata.contentDigest }
              : {}),
          },
          staged,
          admission
        );
      },
      replay: (receipt) => {
        input.assertAuthorized();
        const result = store.getArtifactVersion(
          metadata.workspaceId,
          metadata.artifactId,
          expectedVersion
        );
        const version = result.version;
        const turn = store.getTurn(metadata.workspaceId, metadata.threadId, turnId);
        const item = turn.items[0];
        if (
          receipt.response.kind !== 'artifact' ||
          receipt.response.id !== metadata.artifactId ||
          version.turnId !== turnId ||
          version.threadId !== metadata.threadId ||
          version.requestId !== metadata.requestId ||
          canonicalIdentifierName(version.actor) !== canonicalIdentifierName(context.actorRef) ||
          canonicalIdentifierName(turn.triggerActor) !==
            canonicalIdentifierName(context.actorRef) ||
          turn.status !== 'completed' ||
          turn.agentId != null ||
          turn.agentSessionId != null ||
          turn.startedAt !== version.recordedAt ||
          turn.completedAt !== version.recordedAt ||
          turn.items.length !== 1 ||
          item?.type !== 'artifact-reference' ||
          item.artifactId !== metadata.artifactId ||
          item.artifactVersion !== expectedVersion ||
          item.lastMutationRequestId !== metadata.requestId ||
          item.title !== result.artifact.title ||
          item.summary !== result.artifact.summary
        )
          throw recovery('The Artifact version receipt disagrees with its exact durable tuple.');
        return result;
      },
    });
  } catch (error) {
    cleanupUnproved = error instanceof ArtifactPayloadCleanupError;
    failures.push(error);
  }
  input.file?.source.destroy();
  try {
    await staged?.remove();
  } catch (error) {
    cleanupUnproved = true;
    failures.push(error);
  }
  if (!cleanupUnproved) reservation?.release();
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new ArtifactPayloadCleanupError(failures);
  if (!response) throw recovery('The Artifact version acknowledgement is unavailable.');
  input.assertAuthorized();
  return response;
}

/** Creates the existing fail-closed Artifact-family unknown-result refusal. */
function recovery(message: string): ArtifactAuthorityError {
  return new ArtifactAuthorityError('recovery_required', message);
}
