import { ThreadIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** App-local search result returned by NanoCore. */
export const AppSearchResultSchema = z.object({
  kind: z.enum(['workspace', 'thread', 'knowledge', 'artifact', 'item']),
  id: z.string().min(1),
  title: z.string().min(1),
  workspaceId: WorkspaceIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
});

/** App-local search response. */
export const AppSearchResponseSchema = z.object({
  items: z.array(AppSearchResultSchema),
});

/** App-local search result returned by NanoCore. */
export type AppSearchResult = z.infer<typeof AppSearchResultSchema>;
/** App-local search response. */
export type AppSearchResponse = z.infer<typeof AppSearchResponseSchema>;
