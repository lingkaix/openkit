import {
  GetGenerativePresentationResponseSchema,
  GenerativePresentationDataModelResponseSchema,
  GenerativePresentationResourceResponseSchema,
  LightAppRequestIdSchema,
  PublishGenerativePresentationRequestSchema,
  PublishGenerativePresentationResponseSchema,
  RefreshGenerativePresentationRequestSchema,
  SubmitGenerativePresentationActionRequestSchema,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import type { GenerativeUiCommandContext } from './generative-ui/commands.js';
import {
  getGenerativePresentation,
  getGenerativePresentationResource,
  publishGenerativePresentation,
  refreshGenerativePresentation,
  submitGenerativePresentationAction,
} from './generative-ui/commands.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/**
 * Registers Generative UI App API routes.
 *
 * @param dependencies App composition dependencies.
 */
export function registerGenerativeUiRoutes({
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
  registerAppApiRoute(app, 'publishGenerativePresentation', async (c) => {
    const parsed = PublishGenerativePresentationRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const context = bindContext(c, requestStore, openWorkspaceDb, inflightCommands, true);
    try {
      const response = await publishGenerativePresentation(context, parsed.data);
      return c.json(PublishGenerativePresentationResponseSchema.parse(response), 201);
    } catch (error) {
      return asCommandError(error, 'invalid_request', 400);
    } finally {
      context.workspaceDb.sqlite.close();
    }
  });

  registerAppApiRoute(app, 'getGenerativePresentation', (c) => {
    const context = bindContext(c, requestStore, openWorkspaceDb, inflightCommands);
    try {
      return c.json(
        GetGenerativePresentationResponseSchema.parse(
          getGenerativePresentation(context, c.req.param('presentationId') ?? '')
        )
      );
    } catch (error) {
      return asCommandError(error, 'invalid_request', 400);
    } finally {
      context.workspaceDb.sqlite.close();
    }
  });

  registerAppApiRoute(app, 'getGenerativePresentationResource', (c) => {
    const context = bindContext(c, requestStore, openWorkspaceDb, inflightCommands);
    try {
      return c.json(
        GenerativePresentationResourceResponseSchema.parse(
          getGenerativePresentationResource(context, c.req.param('presentationId') ?? '')
        )
      );
    } catch (error) {
      return asCommandError(error, 'invalid_request', 400);
    } finally {
      context.workspaceDb.sqlite.close();
    }
  });

  registerAppApiRoute(app, 'refreshGenerativePresentation', async (c) => {
    const parsed = RefreshGenerativePresentationRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const context = bindContext(c, requestStore, openWorkspaceDb, inflightCommands);
    try {
      return c.json(
        GenerativePresentationDataModelResponseSchema.parse(
          refreshGenerativePresentation(context, c.req.param('presentationId') ?? '', parsed.data)
        )
      );
    } catch (error) {
      return asCommandError(error, 'invalid_request', 400);
    } finally {
      context.workspaceDb.sqlite.close();
    }
  });

  registerAppApiRoute(app, 'submitGenerativePresentationAction', async (c) => {
    const parsed = SubmitGenerativePresentationActionRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const context = bindContext(c, requestStore, openWorkspaceDb, inflightCommands, true);
    try {
      const response = await submitGenerativePresentationAction(
        context,
        c.req.param('presentationId') ?? '',
        parsed.data
      );
      return c.json(GenerativePresentationDataModelResponseSchema.parse(response));
    } catch (error) {
      return asCommandError(error, 'invalid_request', 400);
    } finally {
      context.workspaceDb.sqlite.close();
    }
  });
}

/**
 * Resolves Workspace, actor, and optional mutation request identity.
 *
 * @param c Request context.
 * @param requestStore Store accessor.
 * @param openWorkspaceDb Workspace opener.
 * @param inflightCommands In-flight command map.
 * @param mutating Whether the request id header is required.
 * @returns Generative UI command context.
 */
function bindContext(
  c: Context<{ Variables: AuthVariables }>,
  requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore,
  openWorkspaceDb: (workspaceId: string) => WorkspaceDb,
  inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>,
  mutating = false
): GenerativeUiCommandContext {
  const workspaceId = c.req.param('workspaceId') ?? '';
  const store = requestStore(c);
  store.getWorkspace(workspaceId);
  const workspaceDb = openWorkspaceDb(workspaceId);
  const dataRoot = store.getDataRoot();
  if (!dataRoot) {
    workspaceDb.sqlite.close();
    throw new KernelCommandError('unavailable', 'Workspace storage is unavailable.');
  }
  const actor: ActorRef = { kind: 'user', id: c.get('actor').userId };
  let requestId = c.req.header('x-openkit-request-id') ?? '';
  if (mutating) {
    const parsed = LightAppRequestIdSchema.safeParse(requestId);
    if (!parsed.success) {
      workspaceDb.sqlite.close();
      throw new KernelCommandError(
        'validation_failed',
        'Generative UI mutations require x-openkit-request-id.'
      );
    }
    requestId = parsed.data;
  }
  return {
    store,
    inflightCommands,
    dataRoot,
    workspaceId,
    actor,
    requestId,
    workspaceDb,
  };
}
