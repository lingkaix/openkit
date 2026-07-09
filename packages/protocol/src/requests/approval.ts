import { z } from 'zod';

import {
  ApprovalRequestIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';

/**
 * Approval response payload.
 */
export const RespondToApprovalRequestSchema = z.object({
  approvalRequestId: ApprovalRequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  decision: z.enum(['granted', 'denied']),
  requestId: RequestIdSchema,
});
