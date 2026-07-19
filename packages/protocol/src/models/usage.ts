import { z } from 'zod';

import {
  AgentIdSchema,
  AgentSessionIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UsageRecordIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/**
 * Stable usage unit values.
 */
export const UsageUnitSchema = z.enum([
  'tokens',
  'usd',
  'requests',
  'seconds',
  'bytes',
  'files',
  'artifacts',
  'tool_calls',
  'capability_calls',
  'sandbox_sessions',
]);

/**
 * Product-visible usage attribution record.
 */
export const UsageRecordSchema = z.object({
  id: UsageRecordIdSchema,
  workspaceId: WorkspaceIdSchema,
  responsibleUserId: z.string().min(1).nullable(),
  threadId: ThreadIdSchema.nullable(),
  turnId: TurnIdSchema.nullable(),
  itemId: ItemIdSchema.nullable().default(null),
  capabilityCallId: CapabilityCallIdSchema.nullable().default(null),
  requestId: RequestIdSchema.nullable().default(null),
  agentId: AgentIdSchema.nullable().default(null),
  agentSessionId: AgentSessionIdSchema.nullable().default(null),
  sourceIds: z.array(z.string().min(1)).default([]),
  category: z.enum(['llm', 'tool', 'runtime', 'storage', 'network']).default('runtime'),
  unit: UsageUnitSchema,
  quantity: z.number().nonnegative(),
  modelId: z.string().min(1).nullable().default(null),
  providerRef: z.string().min(1).nullable().default(null),
  source: z.string().min(1).nullable().default(null),
  recordedAt: TimestampSchema,
});

/**
 * Product-visible usage attribution record.
 */
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
