import { z } from 'zod';

import {
  ApprovalRequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/**
 * Closed lifecycle states for human-in-the-loop approval requests.
 */
export const ApprovalStatusSchema = z.enum([
  'pending',
  'granted',
  'denied',
  'expired',
  'superseded',
  'withdrawn',
]);

/**
 * Closed lifecycle state for a human-in-the-loop approval request.
 */
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * Human-in-the-loop approval request.
 */
export const ApprovalRequestSchema = z.object({
  id: ApprovalRequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  kind: z.enum(['permission', 'destructive-action']),
  status: ApprovalStatusSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});
