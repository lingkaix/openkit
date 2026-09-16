import { ListThreadItemsResponseSchema } from '@openkit/app-api-schemas';
import {
  ArchiveThreadRequestSchema,
  CreateThreadRequestSchema,
  ListThreadsResponseSchema,
  ThreadSchema,
  UpdateThreadRequestSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';

/**
 * Registers the Core thread lifecycle routes and App API item history route.
 *
 * @param dependencies Hono app, request-scoped storage, and the in-flight idempotency ledger.
 */
export function registerThreadRoutes({
  app,
  inflightCommands,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  app.get('/api/workspaces/:workspaceId/threads', (c) => {
    try {
      const store = requestStore(c);
      const actorId = c.get('actor')?.userId;
      return c.json(
        ListThreadsResponseSchema.parse({
          items: store
            .listThreads(c.req.param('workspaceId'))
            .filter((thread) => isThreadVisible(store, thread, actorId)),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/workspaces/:workspaceId/threads', async (c) => {
    const parsed = CreateThreadRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      workspaceId: c.req.param('workspaceId'),
    });

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const input = parsed.data;
      const actorId = c.get('actor').userId;
      const thread = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'thread.create',
        requestId: input.requestId,
        scope: { actorId, workspaceId: input.workspaceId },
        input,
        responseKind: 'thread',
        execute: () =>
          ThreadSchema.parse(
            store.createThread(
              input.workspaceId,
              input.name,
              undefined,
              'conversation',
              input.visibility === 'workspace'
                ? { visibility: 'workspace' }
                : { visibility: 'private', privateOwnerUserId: actorId }
            )
          ),
        replay: (record) =>
          ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });
      if (!isThreadVisible(store, thread, actorId)) {
        return asApiError('Thread not found.', 'not_found', 404);
      }

      return c.json(thread, 201);
    } catch (error) {
      return asCommandError(error, 'thread_create_failed');
    }
  });

  app.get('/api/workspaces/:workspaceId/threads/:threadId', (c) => {
    const store = requestStore(c);
    const workspaceId = c.req.param('workspaceId');
    const threadId = c.req.param('threadId');
    assertThreadWorkspaceLineage(c, store, workspaceId, threadId);

    try {
      return c.json(ThreadSchema.parse(store.getThread(workspaceId, threadId)));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.patch('/api/workspaces/:workspaceId/threads/:threadId', async (c) => {
    const parsed = UpdateThreadRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      workspaceId: c.req.param('workspaceId'),
      threadId: c.req.param('threadId'),
    });
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const input = parsed.data;
    const store = requestStore(c);
    assertThreadWorkspaceLineage(c, store, input.workspaceId, input.threadId);

    try {
      const updates: { name?: string | null; status?: 'active' | 'archived' } = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.status !== undefined) {
        updates.status = input.status;
      }
      const thread = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'thread.update',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, threadId: input.threadId },
        input,
        responseKind: 'thread',
        execute: () =>
          ThreadSchema.parse(store.updateThread(input.workspaceId, input.threadId, updates)),
        replay: (record) =>
          ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(thread);
    } catch (error) {
      return asCommandError(error, 'thread_update_failed');
    }
  });

  app.post('/api/workspaces/:workspaceId/threads/:threadId/archive', async (c) => {
    const parsed = ArchiveThreadRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      workspaceId: c.req.param('workspaceId'),
      threadId: c.req.param('threadId'),
    });
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const input = parsed.data;
    const store = requestStore(c);
    assertThreadWorkspaceLineage(c, store, input.workspaceId, input.threadId);

    try {
      const thread = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'thread.archive',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, threadId: input.threadId },
        input,
        responseKind: 'thread',
        execute: () => ThreadSchema.parse(store.archiveThread(input.workspaceId, input.threadId)),
        replay: (record) =>
          ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(thread);
    } catch (error) {
      return asCommandError(error, 'thread_archive_failed');
    }
  });

  registerAppApiRoute(app, 'listThreadItems', (c) => {
    const store = requestStore(c);
    const workspaceId = c.req.param('workspaceId');
    const threadId = c.req.param('threadId');
    assertThreadWorkspaceLineage(c, store, workspaceId, threadId);

    try {
      return c.json(
        ListThreadItemsResponseSchema.parse({
          items: store.listThreadItems(workspaceId, threadId),
          nextCursor: null,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });
}

/**
 * Requires one scoped Thread owner to match the centrally authorized Workspace and current audience.
 *
 * @param context Request context carrying optional central Workspace authorization.
 * @param store Product store containing the Thread owner.
 * @param workspaceId Workspace named by the route path.
 * @param threadId Thread named by the route path.
 */
function assertThreadWorkspaceLineage(
  context: Context<{ Variables: AuthVariables }>,
  store: FsStore,
  workspaceId: string,
  threadId: string
): void {
  let thread: ReturnType<FsStore['getThread']>;
  try {
    thread = store.getThread(workspaceId, threadId);
  } catch {
    throw new HTTPException(404, { res: asApiError('Thread not found.', 'not_found', 404) });
  }
  const access = context.get('workspaceAccess');
  if (access) {
    assertAuthorizedWorkspaceLineage(access, thread.workspaceId);
  }
  if (!isThreadVisible(store, thread, context.get('actor')?.userId)) {
    throw new HTTPException(404, { res: asApiError('Thread not found.', 'not_found', 404) });
  }
}
