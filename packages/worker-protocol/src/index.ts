import { z } from 'zod';

/**
 * Worker protocol schema version accepted by the first canonical contract.
 */
export const WorkerProtocolSchemaVersionSchema = z.literal(1);

/**
 * Opaque worker-facing id.
 */
export const WorkerOpaqueIdSchema = z.string().min(1);

/**
 * Worker lineage that binds every worker-originated record to one package snapshot and turn.
 */
export const WorkerLineageSchema = z
  .object({
    workspaceId: WorkerOpaqueIdSchema,
    threadId: WorkerOpaqueIdSchema,
    turnId: WorkerOpaqueIdSchema,
    agentSessionId: WorkerOpaqueIdSchema,
    packageSnapshotId: WorkerOpaqueIdSchema,
    requestId: WorkerOpaqueIdSchema.nullable().optional(),
  })
  .strict();

/**
 * Worker-emitted sequence number, monotonic within one package snapshot and channel.
 */
export const WorkerSequenceSchema = z.number().int().nonnegative();

/**
 * Product-safe worker diagnostic.
 */
export const WorkerDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();

/**
 * Shared worker record base fields.
 */
export const WorkerRecordBaseSchema = z
  .object({
    schemaVersion: WorkerProtocolSchemaVersionSchema,
    lineage: WorkerLineageSchema,
    sequence: WorkerSequenceSchema,
    emittedAt: z.iso.datetime().optional(),
  })
  .strict();

/**
 * Canonical worker event types accepted by the first live append surface.
 */
export const WorkerCanonicalEventTypeSchema = z.enum([
  'worker.ready',
  'worker.heartbeat',
  'item.created',
  'item.delta',
  'item.completed',
  'artifact.created',
  'artifact.updated',
  'turn.completed',
  'turn.failed',
]);

/**
 * JSON-compatible object payload used for product-safe summaries.
 */
export const WorkerRecordDataSchema = z.record(z.string(), z.unknown());

/**
 * Canonical event append record emitted by a worker sidecar.
 */
export const WorkerCanonicalEventRecordSchema = WorkerRecordBaseSchema.extend({
  kind: z.literal('event'),
  event: z
    .object({
      type: WorkerCanonicalEventTypeSchema,
      data: WorkerRecordDataSchema.default({}),
    })
    .strict(),
}).strict();

/**
 * Text part emitted in a worker assistant-message candidate.
 */
export const WorkerTextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict();

/**
 * Worker transcript item record collected from `/openkit/session/items.jsonl`.
 */
export const WorkerTranscriptItemRecordSchema = WorkerRecordBaseSchema.extend({
  kind: z.literal('item'),
  item: z
    .object({
      type: z.literal('assistant-message'),
      status: z.enum(['in_progress', 'completed', 'failed']).default('completed'),
      text: z.string().optional(),
      parts: z.array(WorkerTextPartSchema).optional(),
    })
    .strict(),
}).strict();

/**
 * Worker transcript artifact record collected from `/openkit/session/artifacts.jsonl`.
 */
export const WorkerTranscriptArtifactRecordSchema = WorkerRecordBaseSchema.extend({
  kind: z.literal('artifact'),
  artifact: z
    .object({
      kind: z.enum(['report', 'diff', 'file', 'summary']).default('file'),
      title: z.string().min(1),
      path: z.string().min(1),
      mediaType: z.string().min(1).nullable().optional(),
    })
    .strict(),
}).strict();

/**
 * Worker transcript event record collected from `/openkit/session/events.jsonl`.
 */
export const WorkerTranscriptEventRecordSchema = WorkerCanonicalEventRecordSchema;

/**
 * Union of canonical worker transcript records collected through the data plane.
 */
export const WorkerTranscriptRecordSchema = z.discriminatedUnion('kind', [
  WorkerTranscriptItemRecordSchema,
  WorkerTranscriptArtifactRecordSchema,
  WorkerTranscriptEventRecordSchema,
]);

/**
 * Relative workspace path that cannot be absolute or traverse outside the declared root.
 */
export const WorkerRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/'), 'Path must be relative.')
  .refine((value) => !value.split('/').includes('..'), 'Path must not traverse parent roots.');

/**
 * Base workspace snapshot referenced by a worker change manifest.
 */
export const WorkerWorkspaceBaseSchema = z
  .object({
    commit: z.string().min(1).nullable().optional(),
    contentDigest: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * One changed file summary emitted by the worker sidecar.
 */
export const WorkerWorkspaceChangedFileSchema = z
  .object({
    path: WorkerRelativePathSchema,
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    previousPath: WorkerRelativePathSchema.optional(),
    digest: z.string().min(1).nullable().optional(),
    binary: z.boolean().optional(),
    executable: z.boolean().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Workspace change manifest emitted through `/openkit/session/workspace-changes.json`.
 */
export const WorkerWorkspaceChangeManifestSchema = z
  .object({
    schemaVersion: WorkerProtocolSchemaVersionSchema,
    lineage: WorkerLineageSchema,
    sequence: WorkerSequenceSchema,
    base: WorkerWorkspaceBaseSchema.optional(),
    changes: z.array(WorkerWorkspaceChangedFileSchema).default([]),
    bundleDigest: z.string().min(1).nullable().optional(),
    generatedArtifactPaths: z.array(WorkerRelativePathSchema).default([]),
  })
  .strict();

/**
 * Worker capability families allowed through the governed capability plane.
 */
export const WorkerCapabilityFamilySchema = z.enum([
  'knowledge.search',
  'knowledge.read',
  'knowledge.proposal',
  'worker_mcp.call',
  'artifact.read',
  'diagnostic.read',
]);

/**
 * Worker capability call lifecycle status.
 */
export const WorkerCapabilityStatusSchema = z.enum([
  'requested',
  'running',
  'succeeded',
  'failed',
  'denied',
]);

/**
 * Product-safe capability call summary emitted for audit and coordinator inspection.
 */
export const WorkerCapabilityCallSummarySchema = z
  .object({
    schemaVersion: WorkerProtocolSchemaVersionSchema,
    lineage: WorkerLineageSchema,
    sequence: WorkerSequenceSchema,
    capabilityCallId: WorkerOpaqueIdSchema,
    family: WorkerCapabilityFamilySchema,
    status: WorkerCapabilityStatusSchema,
    inputSummary: z.string().min(1),
    outputSummary: z.string().min(1).nullable().optional(),
    policyRefId: WorkerOpaqueIdSchema.nullable().optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().nullable().optional(),
    diagnostics: z.array(WorkerDiagnosticSchema).default([]),
  })
  .strict();

/**
 * Worker control operation names allowed on the control plane.
 */
export const WorkerControlOperationSchema = z.enum([
  'heartbeat',
  'artifact_notice',
  'command_poll',
  'command_ack',
  'terminal_result',
  'event_append',
  'final_status',
  'supply_refresh_ack',
  'capability_summary',
  'knowledge_proposal_summary',
]);

/**
 * Bounded worker-control request envelope.
 */
export const WorkerControlRequestEnvelopeSchema = z
  .object({
    schemaVersion: WorkerProtocolSchemaVersionSchema,
    lineage: WorkerLineageSchema,
    sequence: WorkerSequenceSchema,
    operation: WorkerControlOperationSchema,
    body: WorkerRecordDataSchema.default({}),
  })
  .strict();

/**
 * Bounded worker-control response envelope.
 */
export const WorkerControlResponseEnvelopeSchema = z
  .object({
    schemaVersion: WorkerProtocolSchemaVersionSchema,
    accepted: z.boolean(),
    nextExpectedSequence: WorkerSequenceSchema.nullable().optional(),
    diagnostics: z.array(WorkerDiagnosticSchema).default([]),
  })
  .strict();

/**
 * Product-safe worker error envelope.
 */
export const WorkerErrorEnvelopeSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().default(false),
    diagnostics: z.array(WorkerDiagnosticSchema).default([]),
  })
  .strict();

/** Worker lineage inferred TypeScript type. */
export type WorkerLineage = z.infer<typeof WorkerLineageSchema>;
/** Worker text part inferred TypeScript type. */
export type WorkerTextPart = z.infer<typeof WorkerTextPartSchema>;
/** Canonical worker event record inferred TypeScript type. */
export type WorkerCanonicalEventRecord = z.infer<typeof WorkerCanonicalEventRecordSchema>;
/** Worker transcript record inferred TypeScript type. */
export type WorkerTranscriptRecord = z.infer<typeof WorkerTranscriptRecordSchema>;
/** Worker workspace change manifest inferred TypeScript type. */
export type WorkerWorkspaceChangeManifest = z.infer<typeof WorkerWorkspaceChangeManifestSchema>;
/** Worker capability call summary inferred TypeScript type. */
export type WorkerCapabilityCallSummary = z.infer<typeof WorkerCapabilityCallSummarySchema>;
/** Worker control request envelope inferred TypeScript type. */
export type WorkerControlRequestEnvelope = z.infer<typeof WorkerControlRequestEnvelopeSchema>;
/** Worker control response envelope inferred TypeScript type. */
export type WorkerControlResponseEnvelope = z.infer<typeof WorkerControlResponseEnvelopeSchema>;
/** Product-safe worker error envelope inferred TypeScript type. */
export type WorkerErrorEnvelope = z.infer<typeof WorkerErrorEnvelopeSchema>;
