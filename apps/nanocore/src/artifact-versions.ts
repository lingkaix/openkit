import type { Readable } from 'node:stream';
import type {
  CommitArtifactFileVersionRequest,
  CommitArtifactVersionRequest,
  CommitArtifactVersionResponse,
} from '@openkit/app-api-schemas';
import {
  canonicalIdentifierName,
  deriveEntityId,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { ArtifactAuthorityError, type FsStore } from './lib/store.js';
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
        const publication = () =>
          store.commitArtifactVersion(
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
            staged
          );
        const admission =
          input.command === 'artifact.version-file-commit' ? input.file.admission : input.admission;
        return admission ? withCanonicalFileWriteAdmission(admission, publication) : publication();
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
  return response;
}

/** Creates the existing fail-closed Artifact-family unknown-result refusal. */
function recovery(message: string): ArtifactAuthorityError {
  return new ArtifactAuthorityError('recovery_required', message);
}
