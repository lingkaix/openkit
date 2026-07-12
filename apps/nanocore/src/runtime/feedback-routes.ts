import { SubmitTurnFeedbackRequestSchema } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { apiErrorPayload, asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import { updateTurnFeedback } from './feedback.js';

/**
 * Registers the turn feedback submission route.
 *
 * @param dependencies Hono app and request-scoped storage resolver.
 */
export function registerFeedbackRoutes({
  app,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'submitTurnFeedback', async (c) => {
    const parsed = SubmitTurnFeedbackRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return c.json(
        apiErrorPayload({
          code: 'invalid_feedback',
          message: z.prettifyError(parsed.error),
        }),
        400
      );
    }

    try {
      return c.json(updateTurnFeedback(requestStore(c), c.req.param('turnId'), parsed.data));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });
}
