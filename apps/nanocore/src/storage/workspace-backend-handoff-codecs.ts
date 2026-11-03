import {
  WorkspaceInputSnapshotSchema,
  WorkspaceMaterializationRecordSchema,
} from '@openkit/app-api-schemas';
import { z } from 'zod';

/** Exact original handoff facts; no authority boolean, SQL or callback crosses the wire. */
export const ControlWorkspaceBackendHandoffSchema = z
  .object({
    workspaceId: WorkspaceInputSnapshotSchema.shape.workspaceId,
    inputSnapshots: z.array(WorkspaceInputSnapshotSchema),
    materializationRecords: z.array(WorkspaceMaterializationRecordSchema),
  })
  .strict()
  .refine((input) =>
    [...input.inputSnapshots, ...input.materializationRecords].every(
      (row) => row.workspaceId === input.workspaceId
    )
  );
/** The original five-family Workspace handoff. */
export type ControlWorkspaceBackendHandoff = z.infer<typeof ControlWorkspaceBackendHandoffSchema>;
/** Original ordered snapshot and materialization results. */
export const ControlWorkspaceBackendHandoffResultSchema = z
  .object({
    inputSnapshots: z.array(WorkspaceInputSnapshotSchema),
    materializationRecords: z.array(WorkspaceMaterializationRecordSchema),
  })
  .strict();
/** Ordered original records returned only after the covering FULL acknowledgement. */
export type ControlWorkspaceBackendHandoffResult = z.infer<
  typeof ControlWorkspaceBackendHandoffResultSchema
>;

/** Fixed existing messages, with only the original record identifier interpolated. */
const prefixes = {
  snapshot_conflict: 'Workspace input snapshot replay conflict',
  materialization_conflict: 'Workspace materialization replay conflict',
  materialization_not_recorded: 'Workspace materialization was not recorded',
  handle_conflict: 'Backend workspace handle replay conflict',
} as const;
/** Closed owned replay refusal, never an arbitrary SQLite diagnostic. */
export class WorkspaceBackendHandoffRefusal extends Error {
  constructor(
    readonly code: keyof typeof prefixes,
    readonly recordId: string
  ) {
    super(`${prefixes[code]}: ${recordId}`);
  }
}
/** Validates an exact fixed refusal and its original record identity. */
export const ControlWorkspaceBackendHandoffRefusalSchema = z
  .object({
    operation: z.literal('workspace-backend-handoff'),
    code: z.enum([
      'snapshot_conflict',
      'materialization_conflict',
      'materialization_not_recorded',
      'handle_conflict',
    ]),
    recordId: z.string().min(1),
    message: z.string(),
    status: z.literal(409),
  })
  .strict()
  .refine((value) => value.message === `${prefixes[value.code]}: ${value.recordId}`);
