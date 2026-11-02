import { type WorkspaceApplyPlan, WorkspaceApplyPlanSchema } from '@openkit/app-api-schemas';

/** Closed current Plan input; retained readers keep the original v1 owner separately. */
export const ControlWorkspaceApplyPlanSchema = WorkspaceApplyPlanSchema;
/** Exact preflight record, never SQL, a callback or an authority decision. */
export type ControlWorkspaceApplyPlan = WorkspaceApplyPlan;

/** Original same-id instruction conflict, projected by Main without native SQL diagnostics. */
export class WorkspaceApplyPlanConflictError extends Error {
  /** Keeps the original owned message while the physical worker decides the conflicting replay. */
  constructor(planId: string) {
    super(`Workspace apply plan replay conflict: ${planId}`);
  }
}
