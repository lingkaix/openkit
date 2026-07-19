import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { apiErrorPayload, asApiError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import type { FsStore } from './lib/store.js';

/**
 * Registers the Core turn event replay and live stream route.
 *
 * @param dependencies Hono app and request-scoped storage resolver.
 */
export function registerTurnEventRoutes({
  app,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  app.get('/api/workspaces/:workspaceId/threads/:threadId/events', (c) => {
    const turnId = c.req.query('turnId');
    const sinceQuery = c.req.query('since') ?? '0';
    const since = Number(sinceQuery);

    if (!turnId) {
      return c.json(
        apiErrorPayload({ code: 'missing_turn_id', message: 'turnId is required' }),
        400
      );
    }

    if (!Number.isInteger(since) || since < 0) {
      return c.json(
        apiErrorPayload({
          code: 'invalid_since',
          message: 'since must be a nonnegative integer',
        }),
        400
      );
    }

    const workspaceId = c.req.param('workspaceId');
    const threadId = c.req.param('threadId');
    const store = requestStore(c);
    let ownerTurn: ReturnType<FsStore['getTurnById']>;

    try {
      ownerTurn = store.getTurnById(turnId);
    } catch (error) {
      return asApiError((error as Error).message);
    }

    const workspaceAccess = c.get('workspaceAccess');
    if (workspaceAccess) {
      assertAuthorizedWorkspaceLineage(workspaceAccess, ownerTurn.workspaceId);
    }

    try {
      store.getTurn(workspaceId, threadId, turnId);
    } catch (error) {
      return asApiError((error as Error).message);
    }

    const retainedEvents = store.getTurnEvents(turnId);
    const replayEvents = retainedEvents.filter((event) => event.sequence > since);
    const firstRetainedSequence = retainedEvents.at(0)?.sequence;
    const terminalSequence = retainedEvents.find(
      (event) => event.event === 'turn.completed'
    )?.sequence;
    const completedBeforeCursor = terminalSequence !== undefined && since >= terminalSequence;

    if (firstRetainedSequence !== undefined && since > 0 && since < firstRetainedSequence - 1) {
      return c.json(
        apiErrorPayload({
          code: 'core.stream.cursor_expired',
          message: 'The requested turn event cursor is older than the retained stream window.',
        }),
        410
      );
    }

    if (completedBeforeCursor) {
      return c.body(null, 204);
    }

    return streamSSE(c, async (stream) => {
      let finished = false;
      let lastQueuedSequence = since;
      let unsubscribe: (() => void) | null = null;
      let writeTail = Promise.resolve();

      /** Removes the retained turn listener at most once. */
      const stopListening = (): void => {
        unsubscribe?.();
        unsubscribe = null;
      };

      /** Serializes replayed and live events without sequence gaps or duplicate writes. */
      const queueEvent = (event: (typeof replayEvents)[number]): void => {
        if (event.sequence <= lastQueuedSequence) {
          return;
        }

        lastQueuedSequence = event.sequence;
        writeTail = writeTail.then(async () => {
          if (finished || stream.aborted) {
            return;
          }

          await stream.writeSSE({ data: JSON.stringify(event) });

          if (event.event === 'turn.completed') {
            finished = true;
            stopListening();
            await stream.close();
          }
        });
      };

      replayEvents.forEach(queueEvent);

      if (terminalSequence === undefined) {
        unsubscribe = store.addTurnListener(turnId, queueEvent);
      }

      stream.onAbort(stopListening);

      try {
        await writeTail;

        while (!finished && !stream.aborted) {
          await stream.sleep(250);
        }
      } finally {
        stopListening();
      }
    });
  });
}
