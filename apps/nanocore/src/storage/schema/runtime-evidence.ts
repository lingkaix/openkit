import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable runtime evidence placement. */
export type RuntimeEvidencePlacement = 'local' | 'remote' | 'unknown';

/** Durable runtime evidence lifecycle phase. */
export type RuntimeEvidencePhase =
  | 'sandbox-create'
  | 'capability-negotiation'
  | 'policy-apply'
  | 'provider-attach'
  | 'heartbeat'
  | 'file-transfer'
  | 'transcript-collection'
  | 'workspace-change-collection'
  | 'checkpoint'
  | 'teardown'
  | 'backend-error';

/** Durable runtime evidence outcome. */
export type RuntimeEvidenceOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';

/** Durable workspace-owned runtime evidence index rows. */
export const runtimeEvidence = sqliteTable(
  'runtime_evidence',
  {
    /** Stable runtime evidence id. */
    runtimeEvidenceId: text('runtime_evidence_id').primaryKey().notNull(),
    /** Workspace that owns the runtime evidence. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread lineage when available. */
    threadId: text('thread_id'),
    /** Turn lineage when available. */
    turnId: text('turn_id'),
    /** Goal lineage when available. */
    goalId: text('goal_id'),
    /** Goal task lineage when available. */
    taskId: text('task_id'),
    /** Agent session lineage when available. */
    agentSessionId: text('agent_session_id'),
    /** Worker backend type when known. */
    backendType: text('backend_type'),
    /** Worker backend version when known. */
    backendVersion: text('backend_version'),
    /** Runtime placement. */
    placement: text('placement').$type<RuntimeEvidencePlacement>().notNull(),
    /** Runtime lifecycle phase. */
    phase: text('phase').$type<RuntimeEvidencePhase>().notNull(),
    /** Product-safe evidence summary. */
    summary: text('summary').notNull(),
    /** Policy digest when known. */
    policyDigest: text('policy_digest'),
    /** Worker image or profile summary when known. */
    workerImage: text('worker_image'),
    /** Redacted sandbox locator summary when known. */
    sandboxSummary: text('sandbox_summary'),
    /** Capability route summary when known. */
    capabilitySummary: text('capability_summary'),
    /** JSON array of upload manifest entries. */
    uploadManifestJson: text('upload_manifest_json').notNull(),
    /** JSON array of download manifest entries. */
    downloadManifestJson: text('download_manifest_json').notNull(),
    /** Transcript collection summary when known. */
    transcriptSummary: text('transcript_summary'),
    /** Workspace change collection summary when known. */
    workspaceChangeSummary: text('workspace_change_summary'),
    /** Worker-control or heartbeat summary when known. */
    controlSummary: text('control_summary'),
    /** Runtime outcome. */
    outcome: text('outcome').$type<RuntimeEvidenceOutcome>().notNull(),
    /** Backend exit code when known. */
    exitCode: integer('exit_code'),
    /** Backend signal when known. */
    signal: text('signal'),
    /** Stop reason when known. */
    stopReason: text('stop_reason'),
    /** Stable backend error code when known. */
    errorCode: text('error_code'),
    /** Redacted backend error message when known. */
    errorMessage: text('error_message'),
    /** Redacted stdout summary when known. */
    redactedStdoutSummary: text('redacted_stdout_summary'),
    /** Redacted stderr summary when known. */
    redactedStderrSummary: text('redacted_stderr_summary'),
    /** JSON array of linked evidence bundle ids. */
    evidenceBundleIdsJson: text('evidence_bundle_ids_json').notNull(),
    /** JSON array of content digests. */
    contentDigestsJson: text('content_digests_json').notNull(),
    /** JSON array of required semantic features. */
    requiredFeaturesJson: text('required_features_json').notNull(),
    /** Storage creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Runtime started timestamp when known. */
    startedAt: text('started_at'),
    /** Runtime completed timestamp when known. */
    completedAt: text('completed_at'),
    /** Evidence collected timestamp when known. */
    collectedAt: text('collected_at'),
  },
  (table) => [
    index('runtime_evidence_workspace_idx').on(table.workspaceId, table.createdAt),
    index('runtime_evidence_thread_idx').on(table.workspaceId, table.threadId, table.turnId),
    index('runtime_evidence_agent_session_idx').on(table.workspaceId, table.agentSessionId),
    index('runtime_evidence_phase_idx').on(table.phase, table.outcome),
  ]
);
