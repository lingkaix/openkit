import { Readable } from 'node:stream';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { apiErrorPayload } from './api-errors.js';
import { importArtifactFile } from './artifact-file-commands.js';
import { commitArtifactVersionCommand } from './artifact-versions.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isArtifactVisible, isThreadIdVisible } from './auth/thread-visibility.js';
import { ArtifactAuthorityError, type FsStore, StoreRecordNotFoundError } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import { OperationError, projectOperationError } from './operation-error.js';
import { admitOperation, type OperationAdmissionDependencies } from './operation-resolvers.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
} from './runtime/idempotent-command.js';
import {
  FileAdmissionError,
  type FileStorageAdmission,
  MAX_ARTIFACT_FILE_BYTES,
} from './storage/artifacts/file-admission.js';
import { ArtifactPayloadIntegrityError } from './storage/artifacts/file-payload.js';
import { readArtifactFilePayload } from './storage/artifacts/file-records.js';
import type { WorkspaceDb } from './storage/db.js';
import { resolveDataRootPath } from './storage/fs-layout.js';

/** Registers bounded metadata framing around exact Artifact import and download streams. */
export function registerArtifactFileRoutes(
  dependencies: OperationAdmissionDependencies & {
    readonly app: Hono<{ Variables: AuthVariables }>;
    readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
    readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
    readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
    readonly fileAdmission: FileStorageAdmission;
    readonly dataRoot: string | null;
  }
): void {
  const { app } = dependencies;
  registerAppApiRoute(app, 'artifact.version-file-commit', async (context) => {
    context.header('Cache-Control', 'no-store');
    let release: (() => void) | undefined;
    let workspaceDb: WorkspaceDb | undefined;
    try {
      const definition = OPERATION_DEFINITIONS['artifact.version-file-commit'];
      if (Buffer.byteLength(new URL(context.req.url).search, 'utf8') > 8_192)
        throw new OperationError('invalid_request', 'File metadata is too large.', 400);
      const byteLength = context.req.query('byteLength');
      const expectedVersion = context.req.query('expectedArtifactVersion');
      if (
        !byteLength ||
        !/^(0|[1-9][0-9]*)$/.test(byteLength) ||
        !expectedVersion ||
        !/^[1-9][0-9]*$/.test(expectedVersion)
      )
        throw new OperationError(
          'invalid_request',
          'Artifact version file metadata is invalid.',
          400
        );
      if (Number(byteLength) > MAX_ARTIFACT_FILE_BYTES)
        throw new FileAdmissionError('file_too_large');
      let summary: unknown;
      try {
        summary = JSON.parse(context.req.query('summary') ?? '');
      } catch {
        throw new OperationError('invalid_request', 'Artifact summary metadata is invalid.', 400);
      }
      const store = dependencies.requestStore(context);
      const admitted = admitOperation(
        definition,
        {
          ...context.req.query(),
          summary,
          requestId: context.req.header('x-openkit-request-id'),
          byteLength: Number(byteLength),
          expectedArtifactVersion: Number(expectedVersion),
        },
        { kind: 'public', actor: context.get('actor'), signal: context.req.raw.signal },
        { ...dependencies, store }
      );
      release = admitted.release;
      if (!('actorRef' in admitted.context) || !dependencies.dataRoot)
        throw new OperationError(
          'operation_storage_unavailable',
          'File storage is unavailable.',
          503
        );
      const metadata = definition.inputSchema.parse(admitted.input);
      const assertAuthorized = () => {
        const administrator = dependencies.coreDb
          ? isCurrentDeploymentAdministrator(dependencies.coreDb, context.get('actor'))
          : false;
        if (
          !dependencies.coreDb ||
          !isWorkspaceOperationAuthorized(
            dependencies.coreDb,
            context.get('actor'),
            metadata.workspaceId,
            definition
          )
        )
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        if (
          !isArtifactVisible(
            store,
            store.getArtifact(metadata.workspaceId, metadata.artifactId),
            context.get('actor').userId,
            administrator
          ) ||
          !isThreadIdVisible(
            store,
            metadata.workspaceId,
            metadata.threadId,
            context.get('actor').userId,
            administrator
          )
        )
          throw new OperationError('not_found', 'The Artifact version target is unavailable.', 404);
      };
      workspaceDb = dependencies.repositoryWorkspaceDb(metadata.workspaceId);
      const result = await commitArtifactVersionCommand({
        store,
        workspaceDb,
        inflightCommands: dependencies.inflightCommands,
        context: admitted.context,
        command: 'artifact.version-file-commit',
        metadata,
        assertAuthorized,
        file: {
          admission: dependencies.fileAdmission,
          source: context.req.raw.body
            ? Readable.fromWeb(context.req.raw.body as never)
            : Readable.from([]),
        },
      });
      return context.json(result, 201);
    } catch (error) {
      return fileRouteError(error);
    } finally {
      workspaceDb?.sqlite.close();
      release?.();
    }
  });
  registerAppApiRoute(app, 'artifact.import', async (context) => {
    context.header('Cache-Control', 'no-store');
    let release: (() => void) | undefined;
    let workspaceDb: WorkspaceDb | undefined;
    try {
      const definition = OPERATION_DEFINITIONS['artifact.import'];
      // Query metadata is bounded separately and never contains body bytes.
      const query = new URL(context.req.url).search;
      if (Buffer.byteLength(query, 'utf8') > 8_192) {
        throw new OperationError('invalid_request', 'File metadata is too large.', 400);
      }
      const byteLength = context.req.query('byteLength');
      if (!byteLength || !/^(0|[1-9][0-9]*)$/.test(byteLength)) {
        throw new OperationError('invalid_request', 'File byte length is invalid.', 400);
      }
      if (Number(byteLength) > MAX_ARTIFACT_FILE_BYTES)
        throw new FileAdmissionError('file_too_large');
      const value = {
        ...context.req.query(),
        requestId: context.req.header('x-openkit-request-id'),
        byteLength: Number(byteLength),
      };
      const store = dependencies.requestStore(context);
      const admitted = admitOperation(
        definition,
        value,
        { kind: 'public', actor: context.get('actor'), signal: context.req.raw.signal },
        { ...dependencies, store }
      );
      release = admitted.release;
      if (!('actorRef' in admitted.context) || !dependencies.dataRoot) {
        throw new OperationError(
          'operation_storage_unavailable',
          'File storage is unavailable.',
          503
        );
      }
      const metadata = definition.inputSchema.parse(admitted.input);
      const assertAuthorized = () => {
        if (
          !dependencies.coreDb ||
          !isWorkspaceOperationAuthorized(
            dependencies.coreDb,
            context.get('actor'),
            metadata.workspaceId,
            definition
          )
        ) {
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        }
      };
      workspaceDb = dependencies.repositoryWorkspaceDb(metadata.workspaceId);
      const source = context.req.raw.body
        ? Readable.fromWeb(context.req.raw.body as never)
        : Readable.from([]);
      const result = await importArtifactFile({
        store,
        workspaceDb,
        inflightCommands: dependencies.inflightCommands,
        admission: dependencies.fileAdmission,
        metadata,
        context: admitted.context,
        source,
        assertAuthorized,
      });
      return context.json(result, 201);
    } catch (error) {
      return fileRouteError(error);
    } finally {
      workspaceDb?.sqlite.close();
      release?.();
    }
  });

  registerAppApiRoute(app, 'artifact.download', async (context) => {
    context.header('Cache-Control', 'no-store');
    let release: (() => void) | undefined;
    try {
      const definition = OPERATION_DEFINITIONS['artifact.download'];
      if (Buffer.byteLength(new URL(context.req.url).search, 'utf8') > 8_192) {
        throw new OperationError('invalid_request', 'Download metadata is too large.', 400);
      }
      const version = context.req.query('artifactVersion');
      if (!version || !/^[1-9][0-9]*$/.test(version)) {
        throw new OperationError('invalid_request', 'Artifact version is invalid.', 400);
      }
      const body = { ...context.req.query(), artifactVersion: Number(version) };
      const store = dependencies.requestStore(context);
      const admitted = admitOperation(
        definition,
        body,
        { kind: 'public', actor: context.get('actor'), signal: context.req.raw.signal },
        { ...dependencies, store }
      );
      release = admitted.release;
      const input = definition.inputSchema.parse(admitted.input);
      const current = store.getArtifact(input.workspaceId, input.artifactId);
      const administrator = dependencies.coreDb
        ? isCurrentDeploymentAdministrator(dependencies.coreDb, context.get('actor'))
        : false;
      if (!isArtifactVisible(store, current, context.get('actor').userId, administrator)) {
        throw new OperationError('not_found', 'The Artifact version is unavailable.', 404);
      }
      const artifact = store.getArtifactVersion(
        input.workspaceId,
        input.artifactId,
        input.artifactVersion
      ).artifact;
      const content = artifact.content;
      const byteLength =
        content.format === 'file' ? content.byteLength : Buffer.byteLength(content.body, 'utf8');
      let source: Readable;
      if (content.format === 'file') {
        if (!dependencies.dataRoot) {
          throw new OperationError(
            'operation_storage_unavailable',
            'File storage is unavailable.',
            503
          );
        }
        try {
          source = readArtifactFilePayload({
            workspaceRoot: resolveDataRootPath(
              dependencies.dataRoot,
              'workspaces',
              artifact.workspaceId
            ),
            artifactId: artifact.id,
            version: artifact.version,
            byteLength,
            contentDigest: artifact.contentDigest,
            signal: context.req.raw.signal,
          });
        } catch {
          context.req.raw.signal.throwIfAborted();
          throw new OperationError(
            'recovery_required',
            'The Artifact original is unavailable.',
            503
          );
        }
      } else {
        store.assertArtifactContent(artifact);
        source = Readable.from([Buffer.from(content.body, 'utf8')]);
      }
      const mediaType =
        content.format === 'file'
          ? content.mediaType
          : { markdown: 'text/markdown', text: 'text/plain', json: 'application/json' }[
              content.format
            ];
      // Retained metadata can contain unpaired UTF-16; only the bounded filename hint uses replacement.
      return new Response(Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': mediaType,
          'Content-Length': String(byteLength),
          'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(Buffer.from(artifact.title.slice(0, 160), 'utf8').toString('utf8')).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          'X-Content-Type-Options': 'nosniff',
          'X-OpenKit-Content-Digest': artifact.contentDigest,
          ETag: `"${artifact.contentDigest}"`,
        },
      });
    } catch (error) {
      return fileRouteError(error);
    } finally {
      release?.();
    }
  });
}

/** Projects classified refusals and the same value-free unexpected failure as the Artifact JSON owner. */
function fileRouteError(error: unknown): Response {
  if (error instanceof IdempotencyKeyConflictError) {
    return Response.json(apiErrorPayload({ code: error.code, message: error.message }), {
      status: 409,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (error instanceof ArtifactPayloadIntegrityError) {
    return Response.json(apiErrorPayload({ code: error.code, message: error.message }), {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (error instanceof FileAdmissionError) {
    const status =
      error.code === 'file_too_large' ? 413 : error.code === 'invalid_file_size' ? 400 : 507;
    return Response.json(apiErrorPayload({ code: error.code, message: error.message }), {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (error instanceof ArtifactAuthorityError) {
    return Response.json(apiErrorPayload({ code: error.code, message: error.message }), {
      status:
        error.code === 'invalid_request' || error.code === 'source_digest_mismatch' ? 400 : 409,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (error instanceof StoreRecordNotFoundError) {
    return Response.json(
      apiErrorPayload({ code: 'not_found', message: 'The Artifact is unavailable.' }),
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const projected = projectOperationError(error);
  if (!projected)
    return Response.json(
      apiErrorPayload({ code: 'internal_error', message: 'Internal Server Error' }),
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  const { status, ...body } = projected;
  return Response.json(apiErrorPayload(body), { status, headers: { 'Cache-Control': 'no-store' } });
}
