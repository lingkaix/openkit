import { type WorkspaceApplyPlan, WorkspaceApplyPlanSchema } from '@openkit/app-api-schemas';
import {
  readRetainedV1,
  TimestampSchema,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import { OperationError } from '../operation-error.js';
import type { WorkspaceDb } from '../storage/db.js';

/** Frozen v1 repository-relative path meaning; a wire-only path rule cannot reinterpret saved Plans. */
const StoredApplyPlanPathV1Schema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)/.test(value) &&
      !/(^|\/)\.\.(\/|$)/.test(value) &&
      !value.includes('\0'),
    { message: 'path must be relative to the workspace and must not escape it' }
  );

/** Retained v1 check result, with inert descriptive additions. */
const StoredApplyPlanCheckV1Schema = z
  .object({
    command: z.string().min(1),
    status: z.enum(['passed', 'failed', 'skipped']),
    ref: z.string().min(1).nullable(),
  })
  .passthrough();

/** Native v1 Plan payload; SQL owns the outer marker and wire schemas only admit new commands. */
export const StoredWorkspaceApplyPlanV1Schema = z
  .object({
    id: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    reviewId: z.string().min(1),
    changeSetId: z.string().min(1),
    strategy: z.enum(['git', 'filesystem']),
    approvalState: z.enum(['approved', 'blocked']),
    plannedWrites: z.array(StoredApplyPlanPathV1Schema),
    baselineChecks: z.array(StoredApplyPlanCheckV1Schema),
    pathConflicts: z.array(z.string().min(1)),
    binaryRisks: z.array(StoredApplyPlanPathV1Schema),
    permissionChanges: z.array(StoredApplyPlanPathV1Schema),
    policyChecks: z.array(StoredApplyPlanCheckV1Schema),
    createdAt: TimestampSchema,
  })
  .passthrough();

/** Projects known public fields without making current wire validators the retained owner. */
const StoredApplyPlanViewV1Schema = StoredWorkspaceApplyPlanV1Schema.strip().extend({
  baselineChecks: z.array(StoredApplyPlanCheckV1Schema.strip()),
  policyChecks: z.array(StoredApplyPlanCheckV1Schema.strip()),
});

/** Checks the native row header before decoding its owned Plan payload. */
function readStoredApplyPlanV1(
  row: WorkspaceApplyPlanRow
): z.infer<typeof StoredWorkspaceApplyPlanV1Schema> {
  return readRetainedV1(row, () =>
    StoredWorkspaceApplyPlanV1Schema.parse(JSON.parse(row.payload_json))
  );
}

interface WorkspaceApplyPlanRow {
  readonly schemaVersion: unknown;
  readonly payload_json: string;
}

/**
 * Persists one durable workspace apply plan.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param plan Apply plan to persist.
 * @returns Stored public workspace apply plan.
 * @throws OperationError when a retained same-id plan contradicts the replay.
 */
export function recordWorkspaceApplyPlan(
  workspaceDb: WorkspaceDb,
  plan: WorkspaceApplyPlan
): WorkspaceApplyPlan {
  return persistWorkspaceApplyPlanV1(workspaceDb, WorkspaceApplyPlanSchema.parse(plan));
}

/** Persists admitted current or imported v1 bytes without discarding retained descriptive additions. */
function persistWorkspaceApplyPlanV1(
  workspaceDb: WorkspaceDb,
  parsed: z.infer<typeof StoredWorkspaceApplyPlanV1Schema>
): WorkspaceApplyPlan {
  const existingRow = workspaceDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, payload_json
       FROM workspace_apply_plans
       WHERE workspace_id = ? AND apply_plan_id = ?`
    )
    .get(parsed.workspaceId, parsed.id) as WorkspaceApplyPlanRow | undefined;
  if (existingRow) {
    const existing = StoredApplyPlanViewV1Schema.parse(readStoredApplyPlanV1(existingRow));
    if (
      JSON.stringify(existing) !==
      JSON.stringify(
        StoredApplyPlanViewV1Schema.parse({ ...parsed, createdAt: existing.createdAt })
      )
    ) {
      throw new OperationError(
        'workspace_sync_review_failed',
        `Workspace apply plan replay conflict: ${parsed.id}`,
        404
      );
    }
    return existing;
  }
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_apply_plans (
        schema_version,
        apply_plan_id,
        workspace_id,
        review_id,
        change_set_id,
        strategy,
        approval_state,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
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

  return StoredApplyPlanViewV1Schema.parse(parsed);
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
        `SELECT schema_version AS schemaVersion, payload_json
         FROM workspace_apply_plans
         WHERE workspace_id = ?
         ORDER BY created_at ASC, apply_plan_id ASC`
      )
      .all(workspaceId) as WorkspaceApplyPlanRow[]
  )
    .map((row) => StoredApplyPlanViewV1Schema.parse(readStoredApplyPlanV1(row)))
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
): WorkspaceApplyPlan[] {
  const rows = workspaceDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, payload_json
    FROM workspace_apply_plans WHERE workspace_id=? ORDER BY created_at ASC, apply_plan_id ASC`)
    .all(workspaceId) as WorkspaceApplyPlanRow[];
  return rows.map(readStoredApplyPlanV1);
}

/**
 * Replays imported workspace apply plans.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param plans Exported apply plans to replay.
 */
export function importWorkspaceApplyPlans(
  workspaceDb: WorkspaceDb,
  plans: readonly WorkspaceApplyPlan[]
): void {
  for (const plan of plans) {
    persistWorkspaceApplyPlanV1(workspaceDb, StoredWorkspaceApplyPlanV1Schema.parse(plan));
  }
}
