import { ProductSseEventEnvelopeSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { apiErrorPayload, asApiError } from './api-errors.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  assertAuthorizedWorkspaceLineage,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import type { FsStore } from './lib/store.js';
import type { ProductOperation } from './policy/workspace-access.js';
import type { CoreDb } from './storage/db.js';

/**
 * Registers the Core turn event replay and live stream route.
 *
 * @param dependencies Hono app, request-scoped storage, and optional Core membership authority.
 */
export function registerTurnEventRoutes({
  app,
  coreDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb?: CoreDb;
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
    const actor = c.get('actor');
    const workspaceAccess = c.get('workspaceAccess');
    const policyOperation: ProductOperation =
      workspaceAccess?.kind === 'workspace' ? workspaceAccess.policyOperation : 'thread.read';
    let ownerTurn: ReturnType<FsStore['getTurnById']>;

    try {
      ownerTurn = store.getTurnById(turnId);
    } catch (error) {
      return asApiError((error as Error).message);
    }

    if (workspaceAccess) {
      assertAuthorizedWorkspaceLineage(workspaceAccess, ownerTurn.workspaceId);
    }

    try {
      store.getTurn(workspaceId, threadId, turnId);
    } catch (error) {
      return asApiError((error as Error).message);
    }

    /**
     * Rechecks current Workspace permission, presented Token usability, and Thread audience before any event publication.
     *
     * @returns True only when the current actor may still receive this stream.
     */
    const publicationAuthorized = (): boolean =>
      isTurnEventPublicationAuthorized({
        actor,
        coreDb,
        policyOperation,
        store,
        threadId,
        workspaceId,
      });

    if (!publicationAuthorized()) {
      return asApiError('Thread not found.', 'not_found', 404);
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
        const productEvent = ProductSseEventEnvelopeSchema.safeParse(event);
        if (!productEvent.success) {
          return;
        }
        writeTail = writeTail.then(async () => {
          if (finished || stream.aborted) {
            return;
          }
          if (!publicationAuthorized()) {
            finished = true;
            stopListening();
            await stream.close();
            return;
          }

          await stream.writeSSE({
            data: JSON.stringify(productEvent.data),
          });

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

/**
 * Rechecks current Workspace permission, presented Token usability, and Thread audience without a new stream registry.
 *
 * @param input Live stream authority facts.
 * @returns True only when the current actor may still receive the publication.
 */
function isTurnEventPublicationAuthorized(input: {
  readonly actor: Actor | undefined;
  readonly coreDb: CoreDb | undefined;
  readonly policyOperation: ProductOperation;
  readonly store: FsStore;
  readonly threadId: string;
  readonly workspaceId: string;
}): boolean {
  if (!input.actor) {
    return false;
  }
  if (
    input.coreDb &&
    !isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
      mutating: false,
      policyOperation: input.policyOperation,
    })
  ) {
    return false;
  }
  return isThreadIdVisible(input.store, input.workspaceId, input.threadId, input.actor.userId);
}
