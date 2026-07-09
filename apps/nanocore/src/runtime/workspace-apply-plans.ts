import { type WorkspaceApplyPlan, WorkspaceApplyPlanSchema } from '@openkit/app-api-schemas';
import type { WorkspaceDb } from '../storage/db.js';

interface WorkspaceApplyPlanRow {
  readonly payload_json: string;
}

/** Exportable workspace apply plan plus storage-only replay fields. */
export interface ExportedWorkspaceApplyPlan extends WorkspaceApplyPlan {}

/**
 * Persists one durable workspace apply plan.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param plan Apply plan to persist.
 * @returns Stored public workspace apply plan.
 */
export function recordWorkspaceApplyPlan(
  workspaceDb: WorkspaceDb,
  plan: WorkspaceApplyPlan
): WorkspaceApplyPlan {
  const parsed = WorkspaceApplyPlanSchema.parse(plan);
  workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO workspace_apply_plans (
        apply_plan_id,
        workspace_id,
        review_id,
        change_set_id,
        strategy,
        approval_state,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      parsed.id,
      parsed.workspaceId,
      parsed.reviewId,
      parsed.changeSetId,
      parsed.strategy,
      parsed.approvalState,
      JSON.stringify(parsed),
      parsed.createdAt,
      parsed.createdAt
    );

  return parsed;
}

/**
 * Lists durable workspace apply plans for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored apply plans in newest-first order.
 */
export function listWorkspaceApplyPlans(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceApplyPlan[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT payload_json
         FROM workspace_apply_plans
         WHERE workspace_id = ?
         ORDER BY created_at ASC, apply_plan_id ASC`
      )
      .all(workspaceId) as WorkspaceApplyPlanRow[]
  )
    .map((row) => WorkspaceApplyPlanSchema.parse(JSON.parse(row.payload_json) as unknown))
    .reverse();
}

/**
 * Lists durable workspace apply plans for export in stable dependency order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable apply plans in oldest-first order.
 */
export function listExportableWorkspaceApplyPlans(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportedWorkspaceApplyPlan[] {
  return [...listWorkspaceApplyPlans(workspaceDb, workspaceId)].reverse();
}

/**
 * Replays imported workspace apply plans.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param plans Exported apply plans to replay.
 */
export function importWorkspaceApplyPlans(
  workspaceDb: WorkspaceDb,
  plans: readonly ExportedWorkspaceApplyPlan[]
): void {
  for (const plan of plans) {
    recordWorkspaceApplyPlan(workspaceDb, WorkspaceApplyPlanSchema.parse(plan));
  }
}
