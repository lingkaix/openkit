import { AgentCatalogEntrySchema, AgentSummarySchema } from '@openkit/protocol';
import { z } from 'zod';

/** App API agent catalog entry without adapter-native runtime config. */
export const AppAgentCatalogEntrySchema = AgentCatalogEntrySchema;

/** App API agent catalog summary. */
export const AppAgentSummarySchema = AgentSummarySchema;

/** Agent catalog list response payload. */
export const ListAgentCatalogResponseSchema = z.object({
  items: z.array(AppAgentCatalogEntrySchema),
});

/** Agent catalog detail response payload. */
export const GetAgentCatalogEntryResponseSchema = AppAgentCatalogEntrySchema;

/** App API agent catalog entry without adapter-native runtime config. */
export type AppAgentCatalogEntry = z.infer<typeof AppAgentCatalogEntrySchema>;
/** App API agent catalog summary. */
export type AppAgentSummary = z.infer<typeof AppAgentSummarySchema>;
/** Agent catalog list response payload. */
export type ListAgentCatalogResponse = z.infer<typeof ListAgentCatalogResponseSchema>;
/** Agent catalog detail response payload. */
export type GetAgentCatalogEntryResponse = z.infer<typeof GetAgentCatalogEntryResponseSchema>;
