import { z } from 'zod';

/** App-local search result returned by NanoCore. */
export const AppSearchResultSchema = z.object({
  kind: z.enum(['workspace', 'thread', 'knowledge', 'artifact', 'item']),
  id: z.string().min(1),
  title: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

/** App-local search response. */
export const AppSearchResponseSchema = z.object({
  items: z.array(AppSearchResultSchema),
});

/** App-local search result returned by NanoCore. */
export type AppSearchResult = z.infer<typeof AppSearchResultSchema>;
/** App-local search response. */
export type AppSearchResponse = z.infer<typeof AppSearchResponseSchema>;
