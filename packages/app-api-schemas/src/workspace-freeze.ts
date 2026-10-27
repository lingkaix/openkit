import {
  AgentSessionIdSchema,
  ExecutionAttemptIdSchema,
  entityIdPattern,
  RecurringOccurrenceIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS } from './administrator-cleanup-operations.js';
import { GOAL_OPERATION_DEFINITIONS } from './goal.js';
import { PENDING_REQUEST_OPERATION_DEFINITIONS } from './pending-request-operations.js';
import { SCHEDULER_OPERATION_DEFINITIONS } from './scheduler-operations.js';
import { SYNC_OPERATION_DEFINITIONS } from './sync-operations.js';
import { TURN_OPERATION_DEFINITIONS } from './turn-operations.js';
import { WORKER_OPERATION_DEFINITIONS } from './worker-operations.js';

/** Existing operations offered for individual resolution or inspection; an offer grants no authority. */
export const WorkspaceQuickActionSchema = z.discriminatedUnion('operationId', [
  z.strictObject({
    operationId: z.literal('turn.interrupt'),
    input: TURN_OPERATION_DEFINITIONS['turn.interrupt'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('goal.cancel'),
    input: GOAL_OPERATION_DEFINITIONS['goal.cancel'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('goal.card.cancel'),
    input: GOAL_OPERATION_DEFINITIONS['goal.card.cancel'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('scheduler.cancel'),
    input: SCHEDULER_OPERATION_DEFINITIONS['scheduler.cancel'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('pending-request.withdraw'),
    input: PENDING_REQUEST_OPERATION_DEFINITIONS['pending-request.withdraw'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('administration.cleanup-read'),
    input: ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS['administration.cleanup-read'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('worker.list'),
    input: WORKER_OPERATION_DEFINITIONS['worker.list'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('sync.review-read'),
    input: SYNC_OPERATION_DEFINITIONS['sync.review-read'].inputSchema,
  }),
  z.strictObject({
    operationId: z.literal('sync.recovery-decide'),
    input: SYNC_OPERATION_DEFINITIONS['sync.recovery-decide'].inputSchema,
  }),
]);

/** Lifecycle intent refused before any new lifecycle or external effect is admitted. */
export const WorkspaceFreezeOperationSchema = z.enum([
  'capture',
  'archive',
  'delete',
  'restore',
  'move-out',
  'move-in',
]);

/** Derived current obstruction, never a retained execution state or proof of cleanup. */
export const WorkspaceBlockerReasonSchema = z.enum([
  'active-work',
  'pending-publication',
  'cleanup-unproved',
  'unproved-effect',
  'frozen',
  'held',
  'unavailable',
]);

const details = {
  reason: WorkspaceBlockerReasonSchema,
  actions: z.array(WorkspaceQuickActionSchema),
};
const ownerId = z.string().min(1);

/** Exact existing identities only; unavailable/private facts carry no reference or action. */
export const WorkspaceBlockerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('turn'),
    ...details,
    reference: z.strictObject({ threadId: ThreadIdSchema, turnId: TurnIdSchema }),
  }),
  z.strictObject({
    kind: z.literal('worker-attempt'),
    ...details,
    reference: z.strictObject({
      attemptId: ExecutionAttemptIdSchema,
      threadId: ThreadIdSchema,
      turnId: TurnIdSchema,
      agentSessionId: AgentSessionIdSchema.nullable(),
    }),
  }),
  z.strictObject({
    kind: z.literal('worker-residency'),
    ...details,
    reference: z.union([
      z.strictObject({ agentSessionId: AgentSessionIdSchema }),
      z.strictObject({ storageRef: WorkerStorageTargetIdSchema }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('pending-request'),
    ...details,
    reference: z.strictObject({ threadId: ThreadIdSchema, pendingRequestId: ownerId }),
  }),
  z.strictObject({
    kind: z.literal('recurring-occurrence'),
    ...details,
    reference: z.strictObject({ occurrenceId: RecurringOccurrenceIdSchema }),
  }),
  z.strictObject({
    kind: z.literal('scheduler-admission'),
    ...details,
    reference: z.strictObject({ queueEntryId: ownerId }),
  }),
  z.strictObject({
    kind: z.literal('goal-task'),
    ...details,
    reference: z.strictObject({ goalId: ownerId }),
  }),
  z.strictObject({
    kind: z.literal('synchronization'),
    ...details,
    reference: z.strictObject({ reviewId: ownerId }),
  }),
  z.strictObject({
    kind: z.literal('publication'),
    ...details,
    reference: z.strictObject({ workspaceId: WorkspaceIdSchema }),
  }),
  z.strictObject({
    kind: z.literal('snapshot'),
    ...details,
    reference: z.union([
      z.strictObject({ backupId: z.string().regex(entityIdPattern('wsbak')) }),
      z.strictObject({ recoveryRequestId: RequestIdSchema }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('retention'),
    ...details,
    reference: z.strictObject({ workspaceId: WorkspaceIdSchema }),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.literal('unavailable'),
    actions: z.array(z.never()),
  }),
]);

/** Details of a 409 workspace_blocked or workspace_frozen refusal; never an accepted request result. */
export const WorkspaceFreezeRefusalSchema = z
  .strictObject({
    workspaceId: WorkspaceIdSchema,
    operation: WorkspaceFreezeOperationSchema,
    retryable: z.boolean(),
    blockers: z.array(WorkspaceBlockerSchema).min(1),
  })
  .refine(
    (value) => value.blockers.filter((blocker) => blocker.kind === 'unavailable').length <= 1,
    {
      message: 'Unavailable or private blockers use one identity-free sentinel.',
    }
  );

/** Existing operation and exact input offered for one ordinary invocation. */
export type WorkspaceQuickAction = z.infer<typeof WorkspaceQuickActionSchema>;
/** Authoritative current blocker after disclosure filtering by the snapshot owner. */
export type WorkspaceBlocker = z.infer<typeof WorkspaceBlockerSchema>;
/** Shared refusal details rendered by the unified quick-action surface. */
export type WorkspaceFreezeRefusal = z.infer<typeof WorkspaceFreezeRefusalSchema>;
