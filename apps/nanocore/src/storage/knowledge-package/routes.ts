import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  KnowledgePackageImportResponseSchema,
  OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { apiErrorPayload } from '../../api-errors.js';
import type { AuthVariables } from '../../auth/middleware.js';
import { isWorkspaceOperationAuthorized } from '../../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../../config/runtime-config.js';
import { NotebookError } from '../../knowledge/notebook.js';
import type { FsStore } from '../../lib/store.js';
import { registerAppApiRoute } from '../../openapi.js';
import { OperationError, projectOperationError } from '../../operation-error.js';
import { admitOperation, type OperationAdmissionDependencies } from '../../operation-resolvers.js';
import type { InflightIdempotentCommand } from '../../runtime/idempotent-command.js';
import { IdempotencyKeyConflictError } from '../../runtime/idempotent-command.js';
import type { FileStorageAdmission } from '../artifacts/file-admission.js';
import type { WorkspaceDb } from '../db.js';
import {
  createKnowledgePackageStaging,
  KNOWLEDGE_PACKAGE_MEDIA_TYPE,
  knowledgePackageArchive,
  stageKnowledgePackage,
} from './archive.js';
import { exportKnowledgePackage, importKnowledgePackage } from './operations.js';

/** Registers native parsed-selector admission before receiving or disclosing package streams. */
export function registerKnowledgePackageRoutes(
  dependencies: OperationAdmissionDependencies & {
    readonly app: Hono<{ Variables: AuthVariables }>;
    readonly dataRoot: string | null;
    readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
    readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
    readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
    readonly runtimeConfigManager: Pick<RuntimeConfigManager, 'current'>;
    readonly fileAdmission: FileStorageAdmission;
  }
) {
  for (const id of ['knowledge.package.export', 'knowledge.package.import'] as const) {
    registerAppApiRoute(dependencies.app, id, async (context) => {
      context.header('Cache-Control', 'no-store');
      let release: (() => void) | undefined;
      let staging: Awaited<ReturnType<typeof createKnowledgePackageStaging>> | undefined;
      try {
        const definition = OPERATION_DEFINITIONS[id];
        if (Buffer.byteLength(new URL(context.req.url).search) > 8192)
          throw new OperationError(
            'invalid_request',
            'Knowledge package metadata is too large.',
            400
          );
        const store = dependencies.requestStore(context);
        const admitted = await admitOperation(
          definition,
          {
            ...context.req.query(),
            ...(id === 'knowledge.package.import'
              ? { requestId: context.req.header('x-openkit-request-id') }
              : {}),
          },
          { kind: 'public', actor: context.get('actor'), signal: context.req.raw.signal },
          { ...dependencies, store }
        );
        release = admitted.release;
        if (!dependencies.dataRoot || !dependencies.coreDb)
          throw new OperationError(
            'operation_storage_unavailable',
            'Knowledge package storage is unavailable.',
            503
          );
        const workspaceId = admitted.input.workspaceId as string;
        const revalidate = () => {
          if (
            !isWorkspaceOperationAuthorized(
              dependencies.coreDb!,
              context.get('actor'),
              workspaceId,
              definition
            ) ||
            dependencies.workspaceMutationAdmission?.isClosed(workspaceId)
          )
            throw new OperationError(
              'workspace_access_denied',
              'Knowledge package access denied.',
              403
            );
        };
        revalidate();
        staging = await createKnowledgePackageStaging(dependencies.dataRoot);
        const access = {
          store,
          coreDb: dependencies.coreDb,
          actor: { kind: 'user' as const, id: context.get('actor').userId },
          requestActor: context.get('actor'),
        };
        const directory = join(staging.root, 'package');
        if (id === 'knowledge.package.import') {
          await mkdir(directory, { mode: 0o700 });
          await stageKnowledgePackage(context.req.raw, directory, dependencies.fileAdmission);
          const result = await importKnowledgePackage({
            ...dependencies,
            dataRoot: dependencies.dataRoot,
            directory,
            store,
            workspaceId,
            requestId: admitted.input.requestId as string,
            actorId: context.get('actor').userId,
            access,
            workspaceDb: dependencies.repositoryWorkspaceDb(workspaceId),
            revalidate,
          });
          return context.json(KnowledgePackageImportResponseSchema.parse(result));
        }
        const captured = await exportKnowledgePackage({
          ...dependencies,
          dataRoot: dependencies.dataRoot,
          workspaceId,
          directory,
          revalidate,
          access,
        });
        const archive = knowledgePackageArchive(directory, captured.manifest);
        const owned = staging;
        staging = undefined;
        // The body owns staging until EOF, cancellation or failure; no export handle is retained.
        const body = Readable.from(
          (async function* () {
            try {
              for await (const chunk of archive) {
                captured.revalidateDisclosure();
                yield chunk;
              }
            } finally {
              archive.destroy();
              await owned.remove();
            }
          })(),
          { objectMode: false, highWaterMark: 65_536 }
        );
        body.once('close', () => {
          archive.destroy();
          void owned.remove();
        });
        return new Response(Readable.toWeb(body) as ReadableStream, {
          headers: {
            'content-type': KNOWLEDGE_PACKAGE_MEDIA_TYPE,
            'cache-control': 'no-store',
            'content-disposition': 'attachment; filename="knowledge.openkit.tar"',
          },
        });
      } catch (error) {
        const projected =
          projectOperationError(error) ??
          (error instanceof IdempotencyKeyConflictError
            ? {
                code: error.code,
                message: error.message,
                status: error.status,
              }
            : undefined);
        const failure =
          projected ??
          (error instanceof NotebookError
            ? {
                code: error.code,
                message: error.message,
                status: error.code === 'invalid_request' ? 400 : 409,
              }
            : {
                code: 'invalid_request',
                message: 'Knowledge package validation or transfer failed.',
                status: 400,
              });
        return context.json(
          apiErrorPayload({ message: failure.message, code: failure.code }),
          failure.status as 400
        );
      } finally {
        release?.();
        await staging?.remove();
      }
    });
  }
}
