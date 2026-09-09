import {
  CreateLightAppRecordRequestSchema,
  CreateLightAppRequestSchema,
  CreateLightAppResponseSchema,
  GetLightAppRecordResponseSchema,
  GetLightAppResponseSchema,
  LightAppBatchRequestSchema,
  LightAppBatchResponseSchema,
  LightAppRequestIdSchema,
  ListLightAppRecordsResponseSchema,
  ListLightAppsResponseSchema,
  RetireLightAppRequestSchema,
  RetireLightAppResponseSchema,
  UpdateLightAppRecordRequestSchema,
  UpdateLightAppRecordResponseSchema,
  UpdateLightAppSchemaRequestSchema,
  UpdateLightAppSchemaResponseSchema,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  batchRecords,
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  type KernelCommandContext,
  listLightApps,
  listRecords,
  retireLightApp,
  updateLightAppSchema,
  updateRecord,
} from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/**
 * Registers Light App Kernel App API routes.
 *
 * @param dependencies App composition dependencies.
 */
export function registerKernelRoutes({
  app,
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
  registerAppApiRoute(app, 'listLightApps', (c) => {
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb);
      const page = optionalPositiveInt(c.req.query('page'), 1);
      const perPage = optionalPositiveInt(c.req.query('perPage'), 30);
      return c.json(
        ListLightAppsResponseSchema.parse(
          listLightApps(context.dataRoot, context.workspaceId, page, perPage)
        )
      );
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'createLightApp', async (c) => {
    const parsed = CreateLightAppRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb, inflightCommands, true);
      const response = await createLightApp(context, parsed.data);
      return c.json(CreateLightAppResponseSchema.parse(response), 201);
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'getLightApp', (c) => {
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb);
      const appId = c.req.param('appId') ?? '';
      return c.json(
        GetLightAppResponseSchema.parse(getLightApp(context.dataRoot, context.workspaceId, appId))
      );
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'updateLightAppSchema', async (c) => {
    const parsed = UpdateLightAppSchemaRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb, inflightCommands, true);
      const appId = c.req.param('appId') ?? '';
      const response = await updateLightAppSchema(
        context,
        appId,
        parsed.data.expectedAppRevision,
        parsed.data.expectedSchemaRevision,
        parsed.data.schema
      );
      return c.json(UpdateLightAppSchemaResponseSchema.parse(response));
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'retireLightApp', async (c) => {
    const parsed = RetireLightAppRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb, inflightCommands, true);
      const appId = c.req.param('appId') ?? '';
      const response = await retireLightApp(context, appId, parsed.data.expectedAppRevision);
      return c.json(RetireLightAppResponseSchema.parse(response));
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'listLightAppRecords', (c) => {
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb);
      const schemaRevision = requiredPositiveInt(c.req.query('schemaRevision'), 'schemaRevision');
      const filter = c.req.query('filter');
      const sort = c.req.query('sort');
      const fields = c.req.query('fields');
      return c.json(
        ListLightAppRecordsResponseSchema.parse(
          listRecords(
            context.dataRoot,
            context.workspaceId,
            c.req.param('appId') ?? '',
            c.req.param('collection') ?? '',
            {
              schemaRevision,
              page: optionalPositiveInt(c.req.query('page'), 1),
              perPage: optionalPositiveInt(c.req.query('perPage'), 30),
              ...(filter ? { filter } : {}),
              ...(sort ? { sort } : {}),
              ...(fields ? { fields } : {}),
            }
          )
        )
      );
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'getLightAppRecord', (c) => {
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb);
      const schemaRevision = requiredPositiveInt(c.req.query('schemaRevision'), 'schemaRevision');
      const fields = c.req.query('fields');
      return c.json(
        GetLightAppRecordResponseSchema.parse(
          getRecord(
            context.dataRoot,
            context.workspaceId,
            c.req.param('appId') ?? '',
            c.req.param('collection') ?? '',
            c.req.param('recordId') ?? '',
            schemaRevision,
            fields
          )
        )
      );
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'createLightAppRecord', async (c) => {
    const parsed = CreateLightAppRecordRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb, inflightCommands, true);
      const response = await createRecord(
        context,
        c.req.param('appId') ?? '',
        c.req.param('collection') ?? '',
        parsed.data.schemaRevision,
        parsed.data.data
      );
      return c.json(response, 201);
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'updateLightAppRecord', async (c) => {
    const parsed = UpdateLightAppRecordRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb, inflightCommands, true);
      const response = await updateRecord(
        context,
        c.req.param('appId') ?? '',
        c.req.param('collection') ?? '',
        c.req.param('recordId') ?? '',
        parsed.data
      );
      return c.json(UpdateLightAppRecordResponseSchema.parse(response));
    } catch (error) {
      return asKernelApiError(error);
    }
  });

  registerAppApiRoute(app, 'batchLightAppRecords', async (c) => {
    const parsed = LightAppBatchRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    try {
      const context = bindWorkspace(c, requestStore, openWorkspaceDb, inflightCommands, true);
      const response = await batchRecords(context, c.req.param('appId') ?? '', parsed.data);
      return c.json(LightAppBatchResponseSchema.parse(response));
    } catch (error) {
      return asKernelApiError(error);
    }
  });
}

/**
 * Resolves Workspace, data root, actor, and optional mutation request identity.
 *
 * @param c Request context.
 * @param requestStore Store accessor.
 * @param openWorkspaceDb Workspace opener used to prove the Workspace exists.
 * @param inflightCommands Optional in-flight map for mutations.
 * @param mutating Whether the request id header is required.
 * @returns Kernel command context.
 */
function bindWorkspace(
  c: Context<{ Variables: AuthVariables }>,
  requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore,
  openWorkspaceDb: (workspaceId: string) => WorkspaceDb,
  inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>,
  mutating = false
): KernelCommandContext {
  const workspaceId = c.req.param('workspaceId') ?? '';
  const store = requestStore(c);
  store.getWorkspace(workspaceId);
  const workspaceDb = openWorkspaceDb(workspaceId);
  workspaceDb.sqlite.close();
  const dataRoot = store.getDataRoot();
  if (!dataRoot) {
    throw new KernelCommandError('unavailable', 'Workspace storage is unavailable.');
  }
  const actor: ActorRef = { kind: 'user', id: c.get('actor').userId };
  let requestId = c.req.header('x-openkit-request-id') ?? '';
  if (mutating) {
    const parsed = LightAppRequestIdSchema.safeParse(requestId);
    if (!parsed.success) {
      throw new KernelCommandError(
        'validation_failed',
        'Kernel mutations require x-openkit-request-id.'
      );
    }
    requestId = parsed.data;
  }
  return {
    store,
    inflightCommands: inflightCommands ?? new WeakMap(),
    dataRoot,
    workspaceId,
    actor,
    requestId,
  };
}

/**
 * Converts Kernel failures to protocol API errors.
 *
 * @param error Caught error.
 * @returns JSON error response.
 */
function asKernelApiError(error: unknown): Response {
  return asCommandError(error, 'invalid_request', 400);
}

/**
 * Parses an optional positive integer query parameter.
 *
 * @param value Raw query value.
 * @param fallback Default.
 * @returns Integer.
 */
function optionalPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  return requiredPositiveInt(value, 'page');
}

/**
 * Parses a required positive integer query parameter.
 *
 * @param value Raw query value.
 * @param name Parameter name.
 * @returns Integer.
 */
function requiredPositiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new KernelCommandError('validation_failed', `${name} must be a positive integer.`);
  }
  return parsed;
}
