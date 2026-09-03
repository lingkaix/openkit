import { CapabilityCallSchema, UsageRecordSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Read-only capability call evidence with ledger routing metadata. */
export const CapabilityUsageCallSchema = CapabilityCallSchema.extend({
  family: z.enum(['llm', 'mcp', 'knowledge', 'runtime', 'storage', 'workspace']),
  operation: z.string().min(1),
  providerRef: z.string().min(1).nullable().default(null),
  serviceRef: z.string().min(1).nullable().default(null),
  redactionClass: z.string().min(1),
}).meta({ ...CapabilityCallSchema.meta() });

/** Read-only capability usage evidence for one workspace. */
export const CapabilityUsageResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    capabilityCalls: z.array(CapabilityUsageCallSchema),
    usageRecords: z.array(UsageRecordSchema),
  })
  .strict();

/** Read-only capability call evidence with ledger routing metadata. */
export type CapabilityUsageCall = z.infer<typeof CapabilityUsageCallSchema>;

/** Read-only capability usage evidence for one workspace. */
export type CapabilityUsageResponse = z.infer<typeof CapabilityUsageResponseSchema>;
