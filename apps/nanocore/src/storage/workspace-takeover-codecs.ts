import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { SchedulerExecutionAttemptSchema } from './execution-attempt-codecs.js';

/** Original Core attempt facts used by the Workspace stages; no current-authority boolean. */
const anchor = SchedulerExecutionAttemptSchema.pick({
  attemptId: true,
  workspaceId: true,
  phase: true,
  terminalCause: true,
}).strict();
/** Existing immutable package and observation facts, without secrets or arbitrary SQL. */
const facts = {
  attempt: anchor,
  environmentPackage: AgentEnvironmentPackageSchema,
  timestamp: TimestampSchema,
  physicallyCleaned: z.boolean(),
};
/** Each missing handle keeps its own durable stage, followed by a current disposition read. */
export const ControlWorkspaceTakeoverSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('handle'), ...facts, handleId: z.string().min(1) }).strict(),
    z.object({ action: z.literal('disposition'), ...facts }).strict(),
  ])
  .refine((value) => value.attempt.workspaceId === value.environmentPackage.scope.workspaceId);
/** One closed internal original recovery family, not a new retained or public shape. */
export type ControlWorkspaceTakeover = z.infer<typeof ControlWorkspaceTakeoverSchema>;
/** Only the original pending-retention predicate crosses the acknowledgement channel. */
export const ControlWorkspaceTakeoverResultSchema = z.boolean();
/** Exact owned handoff error; arbitrary SQL and paths remain redacted. */
export class WorkspaceTakeoverRefusal extends Error {
  constructor(readonly snapshotId: string) {
    super(`Workspace backend handle handoff is incomplete for package ${snapshotId}.`);
  }
}
/** Closed existing domain refusal, never a stale permission or a successful substitute. */
export const ControlWorkspaceTakeoverRefusalSchema = z
  .object({
    operation: z.literal('workspace-takeover'),
    code: z.literal('incomplete_handoff'),
    snapshotId: z.string().min(1),
    message: z.string(),
    status: z.literal(409),
  })
  .strict()
  .refine(
    (value) =>
      value.message ===
      `Workspace backend handle handoff is incomplete for package ${value.snapshotId}.`
  );
