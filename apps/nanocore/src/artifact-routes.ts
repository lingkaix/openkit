import { ListArtifactsResponseSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asApiError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';

/**
 * Registers the Core Artifact list, detail, and content routes.
 *
 * @param dependencies Hono app and request-scoped storage.
 */
export function registerArtifactRoutes({
  app,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  app.get('/api/workspaces/:workspaceId/artifacts', (c) => {
    try {
      return c.json(
        ListArtifactsResponseSchema.parse({
          items: requestStore(c).listArtifacts(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/artifacts/:artifactId', (c) => {
    try {
      return c.json(
        requestStore(c).getArtifact(c.req.param('workspaceId'), c.req.param('artifactId'))
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/artifacts/:artifactId/content', (c) => {
    try {
      const artifact = requestStore(c).getArtifact(
        c.req.param('workspaceId'),
        c.req.param('artifactId')
      );
      const content = artifact.content;

      if (!content) {
        return new Response(null, { status: 204 });
      }

      if (content.format === 'markdown') {
        return c.text(content.body, 200, { 'content-type': 'text/markdown; charset=utf-8' });
      }

      if (content.format === 'text') {
        return c.text(content.body, 200, { 'content-type': 'text/plain; charset=utf-8' });
      }

      return c.json(content);
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });
}
