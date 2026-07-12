import { ListThreadItemsResponseSchema } from '@openkit/app-api-schemas';
import {
  ArchiveThreadRequestSchema,
  CreateThreadRequestSchema,
  ListThreadsResponseSchema,
  ThreadSchema,
  UpdateThreadRequestSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
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
      return c.json(
        ListThreadsResponseSchema.parse({
          items: requestStore(c).listThreads(c.req.param('workspaceId')),
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
      const thread = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'thread.create',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId },
        input,
        responseKind: 'thread',
        execute: () => ThreadSchema.parse(store.createThread(input.workspaceId, input.name)),
        replay: (record) =>
          ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(thread, 201);
    } catch (error) {
      return asCommandError(error, 'thread_create_failed');
    }
  });

  app.get('/api/workspaces/:workspaceId/threads/:threadId', (c) => {
    try {
      return c.json(
        ThreadSchema.parse(
          requestStore(c).getThread(c.req.param('workspaceId'), c.req.param('threadId'))
        )
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.patch('/api/workspaces/:workspaceId/threads/:threadId', async (c) => {
    try {
      const parsed = UpdateThreadRequestSchema.safeParse({
        ...(await c.req.json().catch(() => ({}))),
        workspaceId: c.req.param('workspaceId'),
        threadId: c.req.param('threadId'),
      });
      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }
      const input = parsed.data;
      const updates: { name?: string | null; status?: 'active' | 'archived' } = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.status !== undefined) {
        updates.status = input.status;
      }
      const store = requestStore(c);
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
    try {
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
    try {
      return c.json(
        ListThreadItemsResponseSchema.parse({
          items: requestStore(c).listThreadItems(
            c.req.param('workspaceId'),
            c.req.param('threadId')
          ),
          nextCursor: null,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });
}
