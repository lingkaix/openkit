import { z } from 'zod';

import {
  AgentIdSchema,
  AgentSessionIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/**
 * Product-safe capability call status.
 */
export const CapabilityCallStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * Product-visible capability call attribution and summary.
 */
export const CapabilityCallSchema = z.object({
  id: CapabilityCallIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema.nullable(),
  turnId: TurnIdSchema.nullable(),
  itemId: ItemIdSchema.nullable().default(null),
  agentId: AgentIdSchema.nullable().default(null),
  agentSessionId: AgentSessionIdSchema.nullable(),
  requestId: RequestIdSchema.nullable().default(null),
  sourceIds: z.array(z.string().min(1)).default([]),
  capabilityId: z.string().min(1),
  status: CapabilityCallStatusSchema,
  summary: z.string().min(1).nullable(),
  errorCode: z.string().min(1).nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
});

/**
 * Product-visible capability call attribution and summary.
 */
export type CapabilityCall = z.infer<typeof CapabilityCallSchema>;
