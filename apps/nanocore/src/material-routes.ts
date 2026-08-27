import { createHash } from 'node:crypto';

import {
  BindThreadMaterialRequestSchema,
  BindThreadMaterialResponseSchema,
  CreateWorkspaceMaterialRequestSchema,
  CreateWorkspaceMaterialResponseSchema,
  ExcludeThreadMaterialRequestSchema,
  ExcludeThreadMaterialResponseSchema,
  GetThreadMaterialResponseSchema,
  GetWorkspaceMaterialResponseSchema,
  GetWorkspaceMaterialRevisionResponseSchema,
  ListWorkspaceMaterialRevisionsResponseSchema,
  ListWorkspaceMaterialsResponseSchema,
  RestoreThreadMaterialRequestSchema,
  RestoreThreadMaterialResponseSchema,
  SaveWorkspaceMaterialRevisionRequestSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  UnbindThreadMaterialRequestSchema,
  UnbindThreadMaterialResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import { projectThreadMaterialContext } from './context/worker-context-projection.js';
import type { CommandRequestRecord, FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  excludeThreadMaterial,
  getThreadMaterial,
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  listWorkspaceMaterialRevisions,
  listWorkspaceMaterials,
  restoreThreadMaterial,
  saveWorkspaceMaterialRevision,
  unbindThreadMaterial,
} from './workspace-materials.js';

/** Stable success identities returned by Thread Material binding commands. */
type BindingOutcome = 'bound' | 'unbound' | 'excluded' | 'included';

/**
 * Registers the Stage 2 Workspace Material read and mutation routes.
 *
 * @param dependencies App composition dependencies and Workspace database opener.
 */
export function registerMaterialRoutes({
  app,
  coreDb,
  inflightCommands,
  openWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly openWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listWorkspaceMaterials', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        return c.json(
          ListWorkspaceMaterialsResponseSchema.parse({
            materials: listWorkspaceMaterials(workspaceDb),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'createWorkspaceMaterial', async (c) => {
    const parsed = CreateWorkspaceMaterialRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        const input = parsed.data;
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.create',
          requestId: input.requestId,
          scope: { workspaceId },
          input: {
            title: input.title,
            kind: input.kind,
            sensitivity: input.sensitivity,
          },
          responseKind: 'material',
          workspaceDb,
          workspaceTransaction: true,
          execute: () =>
            CreateWorkspaceMaterialResponseSchema.parse(
              createWorkspaceMaterial(workspaceDb, {
                ...input,
                acceptedAt: new Date().toISOString(),
                actorId: c.get('actor').userId,
              })
            ),
          replay: (record) => replayMaterialCreate(workspaceDb, record),
          responseId: (result) => result.materialId,
        });

        return c.json(response, 201);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'getWorkspaceMaterial', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        return c.json(
          GetWorkspaceMaterialResponseSchema.parse({
            material: getWorkspaceMaterial(workspaceDb, materialId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceMaterialRevisions', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        return c.json(
          ListWorkspaceMaterialRevisionsResponseSchema.parse({
            revisions: listWorkspaceMaterialRevisions(workspaceDb, materialId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'saveWorkspaceMaterialRevision', async (c) => {
    const parsed = SaveWorkspaceMaterialRevisionRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      assertVerifiedContentDigest(parsed.data.content, parsed.data.contentDigest);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        const input = parsed.data;
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.save',
          requestId: input.requestId,
          scope: { workspaceId, materialId },
          input: {
            expectedRevisionId: input.expectedRevisionId,
            contentDigest: input.contentDigest,
          },
          responseKind: 'material_revision',
          workspaceDb,
          workspaceTransaction: true,
          execute: () => {
            return SaveWorkspaceMaterialRevisionResponseSchema.parse(
              saveWorkspaceMaterialRevision(workspaceDb, {
                ...input,
                acceptedAt: new Date().toISOString(),
                actorId: c.get('actor').userId,
                materialId,
              })
            );
          },
          replay: (record) => replayMaterialSave(workspaceDb, materialId, record),
          responseId: (result) => result.revisionId,
        });

        return c.json(response, 201);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'getWorkspaceMaterialRevision', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const revisionId = c.req.param('revisionId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        return c.json(
          GetWorkspaceMaterialRevisionResponseSchema.parse({
            revision: getWorkspaceMaterialRevision(workspaceDb, materialId, revisionId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'getThreadMaterial', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const threadId = c.req.param('threadId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      requireThreadTarget(store, workspaceId, threadId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        const material = getThreadMaterial(workspaceDb, threadId);
        const workspaceAccess = c.get('workspaceAccess');
        if (workspaceAccess && material) {
          assertAuthorizedWorkspaceLineage(workspaceAccess, material.workspaceId);
        }
        return c.json(
          GetThreadMaterialResponseSchema.parse({
            material:
              material && coreDb
                ? {
                    ...material,
                    ...projectThreadMaterialContext({
                      coreDb,
                      store,
                      workspaceDb,
                      threadId,
                      materialId: material.resource.materialId,
                    }),
                  }
                : material,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'bindThreadMaterial', async (c) => {
    const parsed = BindThreadMaterialRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const threadId = c.req.param('threadId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        const input = parsed.data;
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.bind',
          requestId: input.requestId,
          scope: { workspaceId, threadId, materialId },
          input: { expectedBindingState: input.expectedBindingState },
          responseKind: 'thread_material_binding',
          workspaceDb,
          workspaceTransaction: true,
          execute: () => {
            requireThreadTarget(store, workspaceId, threadId);
            return BindThreadMaterialResponseSchema.parse(
              bindThreadMaterial(workspaceDb, {
                ...input,
                acceptedAt: new Date().toISOString(),
                materialId,
                threadId,
              })
            );
          },
          replay: (record) =>
            BindThreadMaterialResponseSchema.parse(
              replayMaterialBinding(
                store,
                workspaceDb,
                workspaceId,
                threadId,
                materialId,
                'bound',
                record
              )
            ),
          responseId: (result) => result.materialId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'unbindThreadMaterial', async (c) => {
    const parsed = UnbindThreadMaterialRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const threadId = c.req.param('threadId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        const input = parsed.data;
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.unbind',
          requestId: input.requestId,
          scope: { workspaceId, threadId, materialId },
          input: { expectedBindingState: input.expectedBindingState },
          responseKind: 'thread_material_binding',
          workspaceDb,
          workspaceTransaction: true,
          execute: () => {
            requireThreadTarget(store, workspaceId, threadId);
            return UnbindThreadMaterialResponseSchema.parse(
              unbindThreadMaterial(workspaceDb, {
                ...input,
                acceptedAt: new Date().toISOString(),
                materialId,
                threadId,
              })
            );
          },
          replay: (record) =>
            UnbindThreadMaterialResponseSchema.parse(
              replayMaterialBinding(
                store,
                workspaceDb,
                workspaceId,
                threadId,
                materialId,
                'unbound',
                record
              )
            ),
          responseId: (result) => result.materialId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'excludeThreadMaterial', async (c) => {
    const parsed = ExcludeThreadMaterialRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const threadId = c.req.param('threadId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        const input = parsed.data;
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.exclude',
          requestId: input.requestId,
          scope: { workspaceId, threadId, materialId },
          input: {
            expectedBindingState: input.expectedBindingState,
            expectedInclusionState: input.expectedInclusionState,
            expectedQueuedRevisionId: input.expectedQueuedRevisionId,
          },
          responseKind: 'thread_material_binding',
          workspaceDb,
          workspaceTransaction: true,
          execute: () => {
            requireThreadTarget(store, workspaceId, threadId);
            return ExcludeThreadMaterialResponseSchema.parse(
              excludeThreadMaterial(workspaceDb, {
                ...input,
                acceptedAt: new Date().toISOString(),
                materialId,
                threadId,
              })
            );
          },
          replay: (record) =>
            ExcludeThreadMaterialResponseSchema.parse(
              replayMaterialBinding(
                store,
                workspaceDb,
                workspaceId,
                threadId,
                materialId,
                'excluded',
                record
              )
            ),
          responseId: (result) => result.materialId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });

  registerAppApiRoute(app, 'restoreThreadMaterial', async (c) => {
    const parsed = RestoreThreadMaterialRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const threadId = c.req.param('threadId') ?? '';
      const materialId = c.req.param('materialId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = openWorkspaceDb(workspaceId);
      try {
        const input = parsed.data;
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.restore',
          requestId: input.requestId,
          scope: { workspaceId, threadId, materialId },
          input: {
            expectedBindingState: input.expectedBindingState,
            expectedInclusionState: input.expectedInclusionState,
          },
          responseKind: 'thread_material_binding',
          workspaceDb,
          workspaceTransaction: true,
          execute: () => {
            requireThreadTarget(store, workspaceId, threadId);
            return RestoreThreadMaterialResponseSchema.parse(
              restoreThreadMaterial(workspaceDb, {
                ...input,
                acceptedAt: new Date().toISOString(),
                materialId,
                threadId,
              })
            );
          },
          replay: (record) =>
            RestoreThreadMaterialResponseSchema.parse(
              replayMaterialBinding(
                store,
                workspaceDb,
                workspaceId,
                threadId,
                materialId,
                'included',
                record
              )
            ),
          responseId: (result) => result.materialId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asMaterialApiError(error);
    }
  });
}

/**
 * Replays one create receipt after proving its Material owner still exists.
 *
 * @param workspaceDb Open Workspace database.
 * @param record Existing command receipt.
 * @returns Stable Material identity.
 * @throws A recovery error when receipt and owner disagree.
 */
function replayMaterialCreate(workspaceDb: WorkspaceDb, record: CommandRequestRecord) {
  if (record.response.kind !== 'material') {
    throw recoveryRequired('The Material create receipt has invalid response lineage.');
  }
  try {
    getWorkspaceMaterial(workspaceDb, record.response.id);
  } catch {
    throw recoveryRequired('The Material create receipt has no matching owner.');
  }
  return CreateWorkspaceMaterialResponseSchema.parse({ materialId: record.response.id });
}

/**
 * Replays one save receipt after proving its exact immutable revision exists.
 *
 * @param workspaceDb Open Workspace database.
 * @param materialId Material path owner.
 * @param record Existing command receipt.
 * @returns Stable revision identity.
 * @throws A recovery error when receipt and owner disagree.
 */
function replayMaterialSave(
  workspaceDb: WorkspaceDb,
  materialId: string,
  record: CommandRequestRecord
) {
  if (record.response.kind !== 'material_revision') {
    throw recoveryRequired('The Material save receipt has invalid response lineage.');
  }
  const owner = workspaceDb.sqlite
    .prepare(`SELECT created_by_request_id AS createdByRequestId
      FROM workspace_material_revisions
      WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
    .get(workspaceDb.workspaceId, materialId, record.response.id) as
    | { readonly createdByRequestId: string }
    | undefined;
  if (owner?.createdByRequestId !== record.requestId) {
    throw recoveryRequired('The Material save receipt has no matching revision owner.');
  }
  try {
    getWorkspaceMaterialRevision(workspaceDb, materialId, record.response.id);
  } catch {
    throw recoveryRequired('The Material save receipt has no matching revision owner.');
  }
  return SaveWorkspaceMaterialRevisionResponseSchema.parse({
    materialId,
    revisionId: record.response.id,
  });
}

/**
 * Replays one binding receipt from its immutable path identity and retained binding owner.
 *
 * @param store Actor-scoped product store.
 * @param workspaceDb Open Workspace database.
 * @param workspaceId Authorized path Workspace.
 * @param threadId Thread path owner.
 * @param materialId Material path owner.
 * @param outcome Stable command outcome.
 * @param record Existing command receipt.
 * @returns Stable binding success identity.
 * @throws A recovery error when receipt and owner disagree.
 */
function replayMaterialBinding<const Outcome extends BindingOutcome>(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  materialId: string,
  outcome: Outcome,
  record: CommandRequestRecord
): { readonly materialId: string; readonly threadId: string; readonly outcome: Outcome } {
  if (record.response.kind !== 'thread_material_binding' || record.response.id !== materialId) {
    throw recoveryRequired('The Material binding receipt has invalid response lineage.');
  }
  try {
    requireThreadTarget(store, workspaceId, threadId);
  } catch {
    throw recoveryRequired('The Material binding receipt has no matching Thread owner.');
  }
  try {
    getWorkspaceMaterial(workspaceDb, materialId);
  } catch {
    throw recoveryRequired('The Material binding receipt has no matching Material owner.');
  }
  const owner = workspaceDb.sqlite
    .prepare(`SELECT 1 FROM thread_material_bindings
      WHERE workspace_id = ? AND thread_id = ? AND material_id = ?`)
    .get(workspaceDb.workspaceId, threadId, materialId);
  if (!owner) {
    throw recoveryRequired('The Material binding receipt has no matching owner.');
  }
  return { materialId, threadId, outcome };
}

/**
 * Resolves one Thread only after its path Workspace has been authorized.
 *
 * @param store Actor-scoped product store.
 * @param workspaceId Authorized path Workspace.
 * @param threadId Requested Thread identifier.
 * @throws A stale error when the Thread is absent from the authorized Workspace.
 */
function requireThreadTarget(store: FsStore, workspaceId: string, threadId: string): void {
  try {
    store.getThread(workspaceId, threadId);
  } catch {
    throw Object.assign(new Error('The requested Thread does not exist.'), {
      code: 'stale' as const,
      status: 409 as const,
    });
  }
}

/**
 * Verifies exact Material bytes before a receipt can short-circuit command execution.
 *
 * @param content Submitted canonical content.
 * @param expectedDigest Submitted lowercase SHA-256 digest.
 * @throws A source-digest error when the bytes do not match.
 */
function assertVerifiedContentDigest(content: string, expectedDigest: string): void {
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (digest !== expectedDigest) {
    throw Object.assign(new Error('Material content does not match its digest.'), {
      code: 'source_digest_mismatch' as const,
      status: 400 as const,
    });
  }
}

/**
 * Creates the bounded S16 recovery error used by receipt-owner guards.
 *
 * @param message Product-safe recovery summary.
 * @returns Structural recovery error.
 */
function recoveryRequired(
  message: string
): Error & { readonly code: 'recovery_required'; readonly status: 409 } {
  return Object.assign(new Error(message), {
    code: 'recovery_required' as const,
    status: 409 as const,
  });
}

/**
 * Maps structural Material failures to their exact S16 HTTP semantics.
 *
 * @param error Route or authority failure.
 * @returns Protocol-stamped API error response.
 */
function asMaterialApiError(error: unknown): Response {
  if (error instanceof HTTPException) {
    throw error;
  }
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  const message =
    typeof candidate.message === 'string' ? candidate.message : 'Material request failed.';

  if (candidate.code === 'source_digest_mismatch') {
    return asApiError(message, candidate.code, 400);
  }
  if (
    candidate.code === 'conflict' ||
    candidate.code === 'recovery_required' ||
    candidate.code === 'stale'
  ) {
    return asApiError(message, candidate.code, 409);
  }
  return asCommandError(error, 'not_found', 404);
}
