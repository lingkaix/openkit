import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Closed lifecycle states for one private retained Worker storage association. */
export type WorkerStorageBindingState =
  | 'idle'
  | 'reserved'
  | 'attached'
  | 'unknown'
  | 'purge-pending'
  | 'purged';

/** Core-owned retained Worker storage associations. */
export const workerStorageBindings = sqliteTable(
  'worker_storage_bindings',
  {
    /** Opaque association identity shared with one configured NanoHost. */
    storageRef: text('storage_ref').primaryKey().notNull(),
    /** Configured NanoHost RuntimeTarget that owns physical effects. */
    runtimeTargetId: text('runtime_target_id').notNull(),
    /** Configured deployment boundary for the RuntimeTarget. */
    deploymentId: text('deployment_id').notNull(),
    /** Exact owning Workspace. */
    workspaceId: text('workspace_id').notNull(),
    /** Opaque digest of the host-visible scope identity. */
    scopeDigest: text('scope_digest').notNull(),
    /** Canonical digest of the admitted immutable image storage layout. */
    layoutDigest: text('layout_digest').notNull(),
    /** Optional image-declared compatible storage family. */
    layoutFamily: text('layout_family'),
    /** Optional image-declared compatible storage version. */
    layoutVersion: text('layout_version'),
    /** OCI platform operating system. */
    platformOs: text('platform_os').notNull(),
    /** OCI platform architecture. */
    platformArchitecture: text('platform_architecture').notNull(),
    /** Numeric owner uid for retained targets. */
    ownerUid: integer('owner_uid').notNull(),
    /** Numeric owner gid for retained targets. */
    ownerGid: integer('owner_gid').notNull(),
    /** Image working directory used by layout admission. */
    workingDirectory: text('working_directory').notNull(),
    /** Canonical target-to-volume identities and initialization facts. */
    targetsJson: text('targets_json').notNull(),
    /** Association compare-and-set revision. */
    revision: integer('revision').notNull(),
    /** Monotonic attachment generation, including the current reservation. */
    attachmentGeneration: integer('attachment_generation').notNull(),
    /** Current lifecycle and attachment certainty. */
    state: text('state').$type<WorkerStorageBindingState>().notNull(),
    /** AgentSession that owns the current reservation or attachment. */
    currentAgentSessionId: text('current_agent_session_id'),
    /** Thread that owns the current reservation or attachment. */
    currentThreadId: text('current_thread_id'),
    /** Stable private work slot selected for the current attachment. */
    currentWorkSlotRef: text('current_work_slot_ref'),
    /** Exact Sandbox binding after attachment is proven. */
    currentSandboxBindingRef: text('current_sandbox_binding_ref'),
    /** Creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Last transition timestamp. */
    updatedAt: text('updated_at').notNull(),
    /** Terminal physical purge timestamp when deletion is proved. */
    purgedAt: text('purged_at'),
  },
  (table) => [
    index('worker_storage_bindings_workspace_idx').on(table.workspaceId, table.state),
    index('worker_storage_bindings_target_idx').on(table.runtimeTargetId, table.state),
    uniqueIndex('worker_storage_bindings_current_sandbox_idx').on(table.currentSandboxBindingRef),
  ]
);

/** Append-only contributor and work-slot lineage for retained Worker storage. */
export const workerStorageContributors = sqliteTable(
  'worker_storage_contributors',
  {
    /** Stable private contributor record identity. */
    contributorRef: text('contributor_ref').primaryKey().notNull(),
    /** Owning storage association. */
    storageRef: text('storage_ref').notNull(),
    /** Attachment generation that admitted this contributor. */
    attachmentGeneration: integer('attachment_generation').notNull(),
    /** Exact owning Workspace repeated for fail-closed scope reads. */
    workspaceId: text('workspace_id').notNull(),
    /** User responsible for the admitted work. */
    responsibleUserId: text('responsible_user_id').notNull(),
    /** Contributing Thread. */
    threadId: text('thread_id').notNull(),
    /** Optional contributing Goal. */
    goalId: text('goal_id'),
    /** Optional contributing Task. */
    taskId: text('task_id'),
    /** Whether the work contributes output or independently adjudicates named work. */
    purpose: text('purpose').$type<'work' | 'independent-review'>().notNull(),
    /** Stable private mutable slot used by this contributor. */
    workSlotRef: text('work_slot_ref').notNull(),
    /** Creation timestamp. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('worker_storage_contributors_generation_idx').on(
      table.storageRef,
      table.attachmentGeneration
    ),
    index('worker_storage_contributors_audience_idx').on(
      table.storageRef,
      table.workspaceId,
      table.responsibleUserId
    ),
    index('worker_storage_contributors_thread_idx').on(table.storageRef, table.threadId),
  ]
);
