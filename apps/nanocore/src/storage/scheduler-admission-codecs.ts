import { MaterializedWorkspaceRootSchema } from '@openkit/app-api-schemas';
import { ActorRefSchema, ReasoningEffortSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { SchedulerAdmissionEntryRecord } from '../scheduler-records.js';
import type { RecurringOccurrence } from './recurring-records.js';
import {
  StoredRecurringAttemptCodeV1Schema,
  StoredRecurringOccurrenceV1Schema,
} from './recurring-retained-v1.js';
import type { SchedulerAdmissionDenialReason } from './schema/index.js';

/** Original scheduler transition failure, shared without importing a publisher. */
export class SchedulerAdmissionTransitionError extends Error {
  /** Preserves the original definite admission refusal reason. */
  constructor(
    message: string,
    readonly reason: SchedulerAdmissionDenialReason = 'invalid-request'
  ) {
    super(message);
  }
}
/** Original recurring record absence. */
export class AutomationRecordNotFoundError extends Error {}
/** Original recurring revision or lifecycle refusal. */
export class AutomationMutationError extends Error {}
/** Existing prepared selections; no effect or callback crosses this carrier. */
export const RecurringAdmissionPayloadSchema = z.object({
  backendId: z.string().min(1),
  requestedAgentId: z.string().min(1),
  profileRef: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  workspaceCwd: z.string().min(1).nullable(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema),
  reasoningEffort: ReasoningEffortSchema.optional(),
  requiredFeatures: z.array(z.never()).optional(),
});
const preparation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), payload: RecurringAdmissionPayloadSchema }).strict(),
  z
    .object({
      kind: z.literal('failure'),
      code: StoredRecurringAttemptCodeV1Schema.exclude(['accepted']),
      payload: RecurringAdmissionPayloadSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('recovery_required') }).strict(),
]);
const storageChoice = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fresh'),
      goalId: z.string().nullable(),
      taskId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('selected'),
      expectedRevision: z.number().int().positive().safe(),
      goalId: z.string().nullable(),
      taskId: z.string().nullable(),
      purpose: z.enum(['work', 'independent-review']),
      storageRef: z.string(),
      reuseWorkSlotRef: z.string().optional(),
      adjudicatedThreadIds: z.array(z.string()).readonly().optional(),
    })
    .strict(),
]);
/** Exact queue facts; the retained domain parser still owns identity and input hashing. */
export const SchedulerCreateSchema = z
  .object({
    backendId: z.string().min(1),
    queueEntryId: z.string().min(1),
    requestId: z.string().nullable().optional(),
    triggerActor: ActorRefSchema,
    serverAdminTokenId: z.string().nullable().optional(),
    workspaceCwd: z.string().nullable().optional(),
    workspaceRoots: z.array(MaterializedWorkspaceRootSchema).optional(),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    turnInput: z.string(),
    workerStorageChoice: storageChoice.nullable().optional(),
    requestedAgentId: z.string().min(1),
    profileRef: z.string().nullable().optional(),
    modelId: z.string().nullable().optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    timestamp: z.string().datetime().optional(),
  })
  .strict();
const actor = z
  .object({
    userId: z.string().min(1),
    kind: z.enum(['local', 'session', 'token']),
    sessionId: z.string().optional(),
    tokenId: z.string().optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(z.string()).optional(),
    adminTokenId: z.string().optional(),
  })
  .strict();
const lineage = z
  .object({
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    agentSessionId: z.string().min(1),
    packageSnapshotId: z.string().min(1),
  })
  .strict();
/** The authenticated source facts already held by an external poll operation. */
export const ExternalSourceSchema = z
  .object({
    scheduleId: z.string().min(1),
    eventKey: z.string().min(1).max(1024),
    source: z
      .object({
        workspaceId: z.string().min(1),
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        agentSessionId: z.string().min(1),
        packageSnapshotId: z.string().min(1),
        triggerActor: ActorRefSchema,
      })
      .strict(),
  })
  .strict();
/** One closed Core queue/conditional-source family; each member commits only its original tuple. */
export const ControlSchedulerAdmissionSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('create'),
      entry: SchedulerCreateSchema,
      external: ExternalSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('deny'),
      queueEntryId: z.string().min(1),
      denialReason: z.enum(['queue-full', 'authority-denied', 'invalid-request']),
    })
    .strict(),
  z
    .object({
      mode: z.literal('retry'),
      queueEntryId: z.string().min(1),
      workspaceId: z.string().min(1),
      actor: z.union([actor, ActorRefSchema]),
      lineage: lineage.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('cancel'),
      queueEntryId: z.string().min(1),
      workspaceId: z.string().min(1),
      actor: z.union([actor, ActorRefSchema]).optional(),
      lineage: lineage.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('recurring-attempt'),
      occurrenceId: z.string().min(1),
      definitionRevision: z.number().int().positive(),
      preparation,
      current: preparation.optional(),
      timestamp: z.string().datetime(),
    })
    .strict(),
]);
/** Existing binary byte account carries uncapped domain text without enlarging the metadata envelope. */
export const ControlSchedulerAdmissionWireSchema = z
  .object({ byteLength: z.number().int().positive().safe(), turnId: z.string().min(1).nullable() })
  .strict();
/** Exact scheduler binary header; decoding still uses the one domain schema. */
export type ControlSchedulerAdmissionWire = z.infer<typeof ControlSchedulerAdmissionWireSchema>;
/** Typed request on the existing FIFO. */
export type ControlSchedulerAdmission = z.infer<typeof ControlSchedulerAdmissionSchema>;
/** Main finishes the existing injected clock only after native open. */
export type SchedulerAdmissionDraft =
  | ControlSchedulerAdmission
  | Omit<Extract<ControlSchedulerAdmission, { mode: 'recurring-attempt' }>, 'timestamp'>;
const entry = SchedulerCreateSchema.omit({ timestamp: true }).extend({
  requestId: z.string().nullable(),
  serverAdminTokenId: z.string().nullable(),
  workspaceCwd: z.string().nullable(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema),
  workerStorageChoice: storageChoice.nullable(),
  profileRef: z.string().nullable(),
  modelId: z.string().nullable(),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  enqueuedAt: z.string(),
  status: z.enum(['queued', 'admitted', 'denied', 'cancelled', 'expired']),
  denialReason: z.enum(['queue-full', 'authority-denied', 'invalid-request']).nullable(),
});
const external = z
  .object({
    scheduleId: z.string(),
    eventKey: z.string(),
    sourceTurnId: z.string(),
    queueEntryId: z.string(),
  })
  .strict();
/** Complete native results; no post-ACK result reread or reply reservation. */
export const ControlSchedulerAdmissionResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('queue'), entry, external: external.optional() }).strict(),
  z
    .object({
      kind: z.literal('occurrence'),
      occurrence: StoredRecurringOccurrenceV1Schema.nullable(),
    })
    .strict(),
]);
/** Complete success after the covering FULL commit. */
export type ControlSchedulerAdmissionResult =
  | {
      kind: 'queue';
      entry: SchedulerAdmissionEntryRecord;
      external?: {
        scheduleId: string;
        eventKey: string;
        sourceTurnId: string;
        queueEntryId: string;
      };
    }
  | { kind: 'occurrence'; occurrence: RecurringOccurrence | null };

/** Original transition metadata, never SQLite diagnostics or statement bindings. */
export const ControlSchedulerAdmissionRefusalSchema = z.union([
  z
    .object({
      operation: z.literal('scheduler-admission'),
      kind: z.literal('decoder'),
      code: z.literal('invalid_request'),
      message: z.literal('The record could not be processed.'),
      status: z.literal(400),
    })
    .strict(),
  z
    .object({
      operation: z.literal('scheduler-admission'),
      kind: z.literal('turn'),
      code: z.literal('thread_busy'),
      message: z.literal('Thread already has a nonterminal Turn.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      operation: z.literal('scheduler-admission'),
      kind: z.literal('authority'),
      code: z.literal('workspace_access_denied'),
      message: z.literal('Workspace access denied.'),
      status: z.literal(403),
    })
    .strict(),
  z
    .object({
      operation: z.literal('scheduler-admission'),
      kind: z.literal('transition'),
      code: z.enum(['queue-full', 'authority-denied', 'invalid-request']),
      status: z.literal(400),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('scheduler-admission'),
      kind: z.literal('turn'),
      code: z.literal('external_event_denied'),
      message: z.literal('Scheduled poll admission was denied.'),
      status: z.literal(403),
    })
    .strict(),
  z
    .object({
      operation: z.literal('scheduler-admission'),
      kind: z.literal('turn'),
      code: z.literal('recovery_required'),
      message: z.literal('Accepted external event work requires inspection.'),
      status: z.literal(409),
    })
    .strict(),
]);
/** Only declared scheduler owner refusals cross the private boundary. */
export type ControlSchedulerAdmissionRefusal = z.infer<
  typeof ControlSchedulerAdmissionRefusalSchema
>;
