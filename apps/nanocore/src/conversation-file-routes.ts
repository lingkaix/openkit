import { OPERATION_DEFINITIONS, operationHttpPath } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { apiErrorPayload } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import {
  CONVERSATION_FILE_MEDIA_TYPE,
  ConversationFileBody,
  MAX_CONVERSATION_FILE_METADATA_BYTES,
} from './conversation-file-body.js';
import type { FsStore } from './lib/store.js';
import type { createConversationService } from './mode-entry-routes.js';
import { OperationError, projectOperationError } from './operation-error.js';
import { admitOperation, type OperationAdmissionDependencies } from './operation-resolvers.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import {
  FileAdmissionError,
  FileByteAdmission,
  type FileStorageAdmission,
  type FileStorageReservation,
} from './storage/artifacts/file-admission.js';
import {
  ArtifactPayloadCleanupError,
  ArtifactPayloadIntegrityError,
  type StagedArtifactPayload,
  stageArtifactPayload,
} from './storage/artifacts/file-payload.js';
import { resolveDataRootPath } from './storage/fs-layout.js';

/** Adds the file-body form before the same operation's ordinary JSON binding. Both use native admission and the same domain command receipt. */
export function registerConversationFileRoutes(
  dependencies: OperationAdmissionDependencies & {
    readonly app: Hono<{ Variables: AuthVariables }>;
    readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
    readonly conversationService: ReturnType<typeof createConversationService>;
    readonly fileAdmission: FileStorageAdmission;
    readonly dataRoot: string | null;
  }
): void {
  dependencies.app.use(operationHttpPath('conversation.submit'), async (context, next) => {
    if (
      context.req.method !== 'POST' ||
      context.req.header('content-type') !== CONVERSATION_FILE_MEDIA_TYPE
    )
      return next();
    context.header('Cache-Control', 'no-store');
    let body: ConversationFileBody | undefined;
    let release: (() => void) | undefined;
    let reservation: FileStorageReservation | undefined;
    const staged: StagedArtifactPayload[] = [];
    let cleanupUnproved = false;
    try {
      if (!context.req.raw.body)
        throw new OperationError('invalid_request', 'File body is required.', 400);
      body = new ConversationFileBody(context.req.raw.body, context.req.raw.signal);
      const value = await body.metadata();
      const definition = OPERATION_DEFINITIONS['conversation.submit'];
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new OperationError('invalid_request', 'Invalid operation input.', 400);
      const requestId = context.req.header('x-openkit-request-id');
      if ('requestId' in value && value.requestId !== requestId)
        throw new OperationError(
          'bound_input_conflict',
          'Request identity conflicts with its header.',
          403
        );
      const store = dependencies.requestStore(context);
      const admitted = admitOperation(
        definition,
        { ...value, requestId },
        {
          kind: 'public',
          actor: context.get('actor'),
          delivery: 'human',
          signal: context.req.raw.signal,
        },
        { ...dependencies, store }
      );
      release = admitted.release;
      const metadata = definition.inputSchema.parse(admitted.input);
      if (!metadata.fileInputs?.length)
        throw new OperationError(
          'invalid_request',
          'The file body requires an input inventory.',
          400
        );
      if (!dependencies.dataRoot || store.getDataRoot() !== dependencies.dataRoot)
        throw new OperationError(
          'operation_storage_unavailable',
          'File storage is unavailable.',
          503
        );
      const workspaceRoot = resolveDataRootPath(
        dependencies.dataRoot,
        'workspaces',
        metadata.workspaceId
      );
      const assertAuthorized = () => {
        if (
          !dependencies.coreDb ||
          !isWorkspaceOperationAuthorized(
            dependencies.coreDb,
            context.get('actor'),
            metadata.workspaceId,
            definition
          ) ||
          !isThreadIdVisible(
            store,
            metadata.workspaceId,
            metadata.threadId,
            context.get('actor').userId,
            isCurrentDeploymentAdministrator(dependencies.coreDb, context.get('actor'))
          )
        )
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        context.req.raw.signal.throwIfAborted();
      };
      const frame = body;
      const result = await dependencies.conversationService.submit(
        store,
        metadata,
        context.get('actor'),
        {
          prepare: async () => {
            try {
              assertAuthorized();
              const totalBytes = metadata.fileInputs!.reduce(
                (total, input) => total + input.sizeBytes,
                0
              );
              reservation = dependencies.fileAdmission.reserve({
                stagingBytes: BigInt(totalBytes),
                extractionBytes: 0n,
                derivativeBytes: 0n,
                // Bound new Turn metadata, user Item, Thread preview, their temporary publication overlap, and per-input directories, including empty originals.
                publicationBytes:
                  4n * BigInt(MAX_CONVERSATION_FILE_METADATA_BYTES) +
                  BigInt(metadata.fileInputs!.length) * 65_536n,
              });
              const submission = new FileByteAdmission();
              for (const input of metadata.fileInputs!) {
                staged.push(
                  await stageArtifactPayload({
                    workspaceRoot,
                    source: frame.payload(input.sizeBytes),
                    expectedByteLength: input.sizeBytes,
                    expectedDigest: input.contentDigest,
                    reservation,
                    submission,
                    signal: context.req.raw.signal,
                  })
                );
              }
              await frame.assertEnd();
              assertAuthorized();
              reservation.assertAvailable();
              return staged.map((payload) => payload.path);
            } catch (error) {
              cleanupUnproved ||= error instanceof ArtifactPayloadCleanupError;
              // The existing conversation owner preserves TurnStartValidationError; classify byte admission before crossing that boundary.
              if (context.req.raw.signal.aborted)
                throw new TurnStartValidationError(
                  'file_submission_aborted',
                  'Conversation file transfer was aborted.',
                  499
                );
              if (error instanceof OperationError)
                throw new TurnStartValidationError(error.code, error.message, error.status);
              if (error instanceof ArtifactPayloadIntegrityError)
                throw new TurnStartValidationError(error.code, error.message, 400);
              if (error instanceof FileAdmissionError)
                throw new TurnStartValidationError(
                  error.code,
                  error.message,
                  error.code === 'file_too_large'
                    ? 413
                    : error.code === 'invalid_file_size'
                      ? 400
                      : 507
                );
              throw error;
            }
          },
        }
      );
      return context.json(result.body, result.status);
    } catch (caught) {
      cleanupUnproved ||= caught instanceof ArtifactPayloadCleanupError;
      let error: unknown = caught;
      if (context.req.raw.signal.aborted)
        error = new OperationError(
          'file_submission_aborted',
          'Conversation file transfer was aborted.',
          499
        );
      if (error instanceof TurnStartValidationError || error instanceof IdempotencyKeyConflictError)
        error = new OperationError(error.code, error.message, error.status);
      const projected = projectOperationError(error);
      if (!projected) throw error;
      const { status, ...payload } = projected;
      return Response.json(apiErrorPayload(payload), {
        status,
        headers: { 'Cache-Control': 'no-store' },
      });
    } finally {
      await body?.cancel();
      for (const payload of staged) {
        try {
          await payload.remove();
        } catch {
          cleanupUnproved = true;
        }
      }
      if (!cleanupUnproved) reservation?.release();
      release?.();
    }
  });
}
