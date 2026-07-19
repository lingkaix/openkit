import { AppSearchResponseSchema } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import type { AuthVariables } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';

/**
 * Registers the product-wide search route.
 *
 * @param dependencies Hono app and request-scoped storage resolver.
 */
export function registerSearchRoutes({
  app,
  authorizedWorkspaceIds,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly authorizedWorkspaceIds: (
    context: Context<{ Variables: AuthVariables }>
  ) => readonly string[];
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'searchApp', (c) => {
    const query = (c.req.query('q') ?? '').trim().toLowerCase();

    if (!query) {
      return c.json({ items: [] });
    }

    const store = requestStore(c);
    const workspaces = authorizedWorkspaceIds(c).map((workspaceId) =>
      store.getWorkspace(workspaceId)
    );
    const matches = (value: string | null | undefined) => value?.toLowerCase().includes(query);
    const items: Array<{
      kind: 'workspace' | 'thread' | 'knowledge' | 'artifact' | 'item';
      id: string;
      title: string;
      workspaceId?: string;
      threadId?: string;
    }> = [];

    for (const workspace of workspaces) {
      if (matches(workspace.name)) {
        items.push({ kind: 'workspace', id: workspace.id, title: workspace.name });
      }

      for (const knowledge of store.listKnowledge(workspace.id)) {
        if (matches(knowledge.title) || matches(knowledge.content)) {
          items.push({
            kind: 'knowledge',
            id: knowledge.id,
            title: knowledge.title,
            workspaceId: workspace.id,
          });
        }
      }

      for (const artifact of store.listArtifacts(workspace.id)) {
        if (matches(artifact.title) || matches(artifact.summary)) {
          const result = {
            kind: 'artifact',
            id: artifact.id,
            title: artifact.title,
            workspaceId: workspace.id,
            ...(artifact.threadId ? { threadId: artifact.threadId } : {}),
          } as const;
          items.push(result);
        }
      }
    }

    for (const workspace of workspaces) {
      for (const thread of store.listThreads(workspace.id)) {
        if (matches(thread.name) || matches(thread.preview)) {
          items.push({
            kind: 'thread',
            id: thread.id,
            title: thread.name ?? thread.id,
            workspaceId: thread.workspaceId,
          });
        }

        for (const item of store.listThreadItems(workspace.id, thread.id)) {
          if ('text' in item && matches(item.text)) {
            items.push({
              kind: 'item',
              id: item.id,
              title: item.text ?? item.id,
              workspaceId: item.workspaceId,
              threadId: item.threadId,
            });
          }
        }
      }
    }

    return c.json(AppSearchResponseSchema.parse({ items }));
  });
}
