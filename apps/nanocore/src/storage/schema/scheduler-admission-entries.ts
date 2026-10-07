import type { ReasoningEffort } from '@openkit/protocol';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable scheduler admission statuses. */
export type SchedulerAdmissionStatus = 'queued' | 'admitted' | 'denied' | 'cancelled' | 'expired';

/** Typed scheduler admission denial reasons. */
export type SchedulerAdmissionDenialReason = 'queue-full' | 'authority-denied' | 'invalid-request';

/** Server-scoped durable scheduler admission queue rows. */
export const schedulerAdmissionEntries = sqliteTable(
  'scheduler_admission_entries',
  {
    /** Configured backend identity captured when the request is accepted. */
    backendId: text('backend_id').notNull(),
    /** Exact normalized command and provenance hash for idempotent replay. */
    inputHash: text('input_hash').notNull(),
    /** Stable queue entry id. */
    queueEntryId: text('queue_entry_id').primaryKey().notNull(),
    /** Original command request id used for event correlation. */
    requestId: text('request_id'),
    /** Exact JSON-encoded ActorRef that triggered this admission. */
    triggerActorJson: text('trigger_actor_json').notNull(),
    /** Non-secret id of the presented server-admin token, revalidated at each effect. */
    serverAdminTokenId: text('server_admin_token_id'),
    /** Host-local working directory captured for delayed preparation. */
    workspaceCwd: text('workspace_cwd'),
    /** Materialized roots captured with the exact accepted input. */
    workspaceRootsJson: text('workspace_roots_json').notNull().default('[]'),
    /** Workspace lineage id. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage id. */
    threadId: text('thread_id').notNull(),
    /** Turn lineage id. */
    turnId: text('turn_id').notNull(),
    /** Worker turn input captured when the entry is queued. */
    turnInput: text('turn_input').notNull(),
    /** Exact retained-storage choice captured before package planning. */
    workerStorageChoiceJson: text('worker_storage_choice_json'),
    /** Requested agent id. */
    requestedAgentId: text('requested_agent_id').notNull(),
    /** Requested agent profile reference. */
    profileRef: text('profile_ref'),
    /** Requested logical model id. */
    modelId: text('model_id'),
    /** Explicit Turn preference carried across delayed dispatch. */
    reasoningEffort: text('reasoning_effort').$type<ReasoningEffort>(),
    /** Entry enqueue timestamp. */
    enqueuedAt: text('enqueued_at').notNull(),
    /** Admission entry status. */
    status: text('status').$type<SchedulerAdmissionStatus>().notNull(),
    /** Typed denial reason when denied. */
    denialReason: text('denial_reason').$type<SchedulerAdmissionDenialReason>(),
  },
  (table) => [
    index('scheduler_admission_entries_queue_idx').on(table.status, table.enqueuedAt),
    index('scheduler_admission_entries_workspace_idx').on(
      table.workspaceId,
      table.status,
      table.enqueuedAt
    ),
  ]
);
