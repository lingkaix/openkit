import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Private NanoHost Sandbox placement and cleanup projection. */
export const sandboxRuntimeRecords = sqliteTable(
  'sandbox_runtime_records',
  {
    /** Stable private Sandbox runtime identity. */
    sandboxRuntimeId: text('sandbox_runtime_id').primaryKey().notNull(),
    /** Owning configured NanoHost RuntimeTarget. */
    runtimeTargetId: text('runtime_target_id').notNull(),
    /** Opaque NanoHost Sandbox binding. */
    sandboxBindingRef: text('sandbox_binding_ref').notNull(),
    /** Opaque private Sandbox Integration carriage binding. */
    sandboxIntegrationBindingRef: text('sandbox_integration_binding_ref').notNull(),
    /** Immutable shared-Sandbox compatibility digest. */
    sandboxCompatibilityKey: text('sandbox_compatibility_key').notNull(),
    /** Exact immutable image digest used by the retained Sandbox. */
    imageDigest: text('image_digest').notNull(),
    /** Fixed static environment class. */
    environmentClass: text('environment_class').notNull(),
    /** Aggregate open AgentSession capacity. */
    maxOpenSessions: integer('max_open_sessions').notNull(),
    /** Aggregate Harness Instance capacity. */
    maxHarnesses: integer('max_harnesses').notNull(),
    /** Aggregate active Turn capacity. */
    maxActiveTurns: integer('max_active_turns').notNull(),
    /** Private Sandbox lifecycle state. */
    lifecycleState: text('lifecycle_state').notNull(),
    /** Private health projection. */
    healthState: text('health_state').notNull(),
    /** Admission drain projection. */
    drainState: text('drain_state').notNull(),
    /** Cleanup proof projection. */
    cleanupState: text('cleanup_state').notNull(),
    /** Creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Last transition timestamp. */
    updatedAt: text('updated_at').notNull(),
    /** NanoCore-private Goal pin; null means this ordinary Sandbox currently pins no Goal. */
    pinnedGoalId: text('pinned_goal_id'),
  },
  (table) => [
    uniqueIndex('sandbox_runtime_records_binding_idx').on(table.sandboxBindingRef),
    uniqueIndex('sandbox_runtime_records_integration_binding_idx').on(
      table.sandboxIntegrationBindingRef
    ),
    index('sandbox_runtime_records_target_idx').on(table.runtimeTargetId, table.lifecycleState),
  ]
);

/** Private lifecycle, capacity, and current-operation projection for one Harness Instance. */
export const harnessInstanceRecords = sqliteTable(
  'harness_instance_records',
  {
    /** Stable private Harness identity. */
    harnessInstanceId: text('harness_instance_id').primaryKey().notNull(),
    /** Owning Sandbox runtime identity. */
    sandboxRuntimeId: text('sandbox_runtime_id').notNull(),
    /** Static non-secret bridge binding. */
    harnessBindingRef: text('harness_binding_ref').notNull(),
    /** Immutable Harness selection compatibility digest. */
    harnessCompatibilityKey: text('harness_compatibility_key').notNull(),
    /** Pinned native runtime family. */
    runtimeFamily: text('runtime_family').notNull(),
    /** Selected worker adapter. */
    adapterId: text('adapter_id').notNull(),
    /** Pinned adapter runtime version. */
    adapterVersion: text('adapter_version').notNull(),
    /** Fixed private protocol version. */
    protocolVersion: integer('protocol_version').notNull(),
    /** Bounded product-safe capability summary. */
    capabilitiesJson: text('capabilities_json').notNull(),
    /** Open AgentSession capacity. */
    maxOpenSessions: integer('max_open_sessions').notNull(),
    /** Active Turn capacity. */
    maxActiveTurns: integer('max_active_turns').notNull(),
    /** Current open AgentSession occupancy. */
    openSessionCount: integer('open_session_count').notNull(),
    /** Current active Turn occupancy. */
    activeTurnCount: integer('active_turn_count').notNull(),
    /** Harness lifecycle state. */
    lifecycleState: text('lifecycle_state').notNull(),
    /** Harness admission drain state. */
    drainState: text('drain_state').notNull(),
    /** Next exact operation sequence. */
    nextSequence: integer('next_sequence').notNull(),
    /** Current or immediately settled operation state. */
    operationState: text('operation_state').notNull(),
    /** Deterministic redacted operation identity. */
    operationId: text('operation_id'),
    /** Current operation sequence. */
    operationSequence: integer('operation_sequence'),
    /** Current fixed operation literal. */
    operation: text('operation'),
    /** Canonical redacted command body. */
    commandBodyJson: text('command_body_json'),
    /** Canonical command fingerprint. */
    commandFingerprint: text('command_fingerprint'),
    /** Canonical exact result retained for replay. */
    resultJson: text('result_json'),
    /** Canonical result fingerprint. */
    resultFingerprint: text('result_fingerprint'),
    /** Creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Last transition timestamp. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('harness_instance_records_compatibility_idx').on(
      table.sandboxRuntimeId,
      table.harnessCompatibilityKey
    ),
    uniqueIndex('harness_instance_records_binding_idx').on(table.harnessBindingRef),
  ]
);

/** Private Core AgentSession-to-Harness continuity projection. */
export const agentSessionRuntimeBindings = sqliteTable(
  'agent_session_runtime_bindings',
  {
    /** Stable private binding identity. */
    agentSessionRuntimeBindingId: text('agent_session_runtime_binding_id').primaryKey().notNull(),
    /** Owning Harness identity. */
    harnessInstanceId: text('harness_instance_id').notNull(),
    /** Exact Core AgentSession identity. */
    agentSessionId: text('agent_session_id').notNull(),
    /** Exact Workspace lineage. */
    workspaceId: text('workspace_id').notNull(),
    /** Exact Thread lineage. */
    threadId: text('thread_id').notNull(),
    /** Immutable continuity compatibility digest. */
    agentSessionCompatibilityKey: text('agent_session_compatibility_key').notNull(),
    /** Effective Agent Setup generation. */
    effectiveSetupGeneration: integer('effective_setup_generation').notNull(),
    /** Restricted native handle readiness projection. */
    nativeHandleState: text('native_handle_state').notNull(),
    /** Product-safe digest of the restricted native handle. */
    nativeHandleDigest: text('native_handle_digest'),
    /** Binding lifecycle state. */
    lifecycleState: text('lifecycle_state').notNull(),
    /** Active Turn identity, when present. */
    currentTurnId: text('current_turn_id'),
    /** Active Turn execution lease, when present. */
    currentLeaseId: text('current_lease_id'),
    /** Next sequential Turn number for this exact AgentSession binding. */
    nextTurnSequence: integer('next_turn_sequence').notNull(),
    /** AgentSession-local cleanup proof. */
    cleanupState: text('cleanup_state').notNull(),
    /** Creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Last transition timestamp. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('agent_session_runtime_bindings_session_idx').on(table.agentSessionId),
    uniqueIndex('agent_session_runtime_bindings_current_thread_idx')
      .on(table.workspaceId, table.threadId)
      .where(sql`${table.lifecycleState} NOT IN ('closed', 'failed')`),
    index('agent_session_runtime_bindings_harness_idx').on(
      table.harnessInstanceId,
      table.lifecycleState
    ),
  ]
);
