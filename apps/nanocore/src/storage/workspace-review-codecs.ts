import {
  StagedWorkspaceReviewSchema,
  WorkspaceSyncReviewItemSchema,
} from '@openkit/app-api-schemas';
import { ActorRefSchema, AuditEventSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Exact original nonaccepted decision facts; no SQL, callback or authority decision crosses the wire. */
export const ControlWorkspaceReviewDecisionSchema = z
  .object({
    actor: ActorRefSchema.optional(),
    authentication: AuditEventSchema.shape.authentication.optional(),
    workspaceId: StagedWorkspaceReviewSchema.shape.workspaceId,
    reviewId: StagedWorkspaceReviewSchema.shape.id,
    status: z.enum(['needs_refinement', 'rejected', 'blocked']),
    requestId: z.string().min(1),
    updatedAt: StagedWorkspaceReviewSchema.shape.updatedAt,
  })
  .strict();
/** Original Review/Audit tuple input, admitted by the current Main command owner. */
export type ControlWorkspaceReviewDecision = z.infer<typeof ControlWorkspaceReviewDecisionSchema>;
/** Original acknowledged joined Review; the retained readers still verify lineage and exact patch bytes. */
export const ControlWorkspaceReviewDecisionResultSchema = WorkspaceSyncReviewItemSchema;

/** Fixed native categories; original identifier-bearing messages are reconstructed locally. */
export const WORKSPACE_REVIEW_REFUSALS = {
  review_absent: { message: 'Workspace synchronization review not found.', status: 404 },
  change_set_absent: { message: 'Workspace change set not found.', status: 404 },
  resolved: { message: 'Workspace synchronization review is already resolved.', status: 404 },
  unsupported_retained_format: { message: 'Unsupported retained record format.', status: 409 },
} as const;
/** One private translation of an existing owned refusal, never an arbitrary native diagnostic. */
export class WorkspaceReviewDecisionRefusal extends Error {
  constructor(readonly code: keyof typeof WORKSPACE_REVIEW_REFUSALS) {
    super(WORKSPACE_REVIEW_REFUSALS[code].message);
  }
}
