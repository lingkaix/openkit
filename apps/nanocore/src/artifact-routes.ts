import {
  ArtifactSchema,
  ListArtifactsResponseSchema,
  UpdateArtifactMetadataRequestSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';

/**
 * Registers the Core artifact list, detail, metadata update, and content routes.
 *
 * @param dependencies Hono app, request-scoped storage, and the shared idempotency ledger.
 */
export function registerArtifactRoutes({
  app,
  inflightCommands,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
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

  app.patch('/api/workspaces/:workspaceId/artifacts/:artifactId', async (c) => {
    try {
      const parsed = UpdateArtifactMetadataRequestSchema.safeParse({
        ...(await c.req.json().catch(() => ({}))),
        workspaceId: c.req.param('workspaceId'),
        artifactId: c.req.param('artifactId'),
      });
      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }
      const input = parsed.data;
      const updates = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      };
      const store = requestStore(c);
      const artifact = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'artifact.metadata.update',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, artifactId: input.artifactId },
        input,
        responseKind: 'artifact',
        execute: () =>
          ArtifactSchema.parse(store.updateArtifact(input.workspaceId, input.artifactId, updates)),
        replay: (record) =>
          ArtifactSchema.parse(store.getArtifact(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(artifact);
    } catch (error) {
      return asCommandError(error, 'artifact_update_failed');
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
