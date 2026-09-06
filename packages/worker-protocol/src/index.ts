import { z } from 'zod';

/**
 * Worker protocol schema version accepted by the first canonical contract.
 */
export const WorkerProtocolSchemaVersionSchema = z.literal(1);

/** Direct worker-control envelope version, independent from canonical worker records. */
export const WorkerControlSchemaVersionSchema = z.literal(2);

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

/** Required feature id for bounded runtime-native provenance capture. */
export const WORKER_RUNTIME_PROVENANCE_FEATURE = 'worker.runtime-provenance.v1' as const;

/** Required feature schema for bounded runtime-native provenance capture. */
export const WorkerRuntimeProvenanceFeatureSchema = z.literal(WORKER_RUNTIME_PROVENANCE_FEATURE);

/** Canonical lowercase SHA-256 digest used by runtime provenance files and frames. */
export const WorkerRuntimeSha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Synthetic raw stream reference that cannot expose runtime-native ids or paths. */
export const WorkerRuntimeStreamRefSchema = z.string().regex(/^stream-\d{4}\.jsonl$/);

/** Runtime raw stream source classes understood by the backend-neutral manifest. */
export const WorkerRuntimeStreamSourceKindSchema = z.enum(['primary', 'runtime-thread']);

/** Capture outcomes retained for each raw stream and the complete manifest. */
export const WorkerRuntimeCaptureStatusSchema = z.enum([
  'complete',
  'truncated',
  'unstable',
  'failed',
]);

/** Parse outcomes retained for every physical runtime-native frame. */
export const WorkerRuntimeFrameParseStatusSchema = z.enum([
  'parsed',
  'unattributed',
  'malformed',
  'truncated',
]);

/** One byte-preserved raw stream declared by the restricted runtime manifest. */
export const WorkerRuntimeRawStreamSchema = z
  .object({
    streamRef: WorkerRuntimeStreamRefSchema,
    sourceKind: WorkerRuntimeStreamSourceKindSchema,
    bytes: z.number().int().nonnegative(),
    sha256: WorkerRuntimeSha256Schema,
    frameCount: z.number().int().nonnegative(),
    captureStatus: WorkerRuntimeCaptureStatusSchema,
    stableTerminal: z.boolean(),
  })
  .strict();

/** Restricted manifest for one bounded set of runtime-native raw streams. */
export const WorkerRuntimeRawStreamManifestSchema = z
  .object({
    schemaVersion: WorkerProtocolSchemaVersionSchema,
    lineage: WorkerLineageSchema,
    runtimeFamily: WorkerOpaqueIdSchema,
    adapterVersion: WorkerOpaqueIdSchema,
    primaryStreamRef: z.literal('stream-0000.jsonl'),
    captureStatus: WorkerRuntimeCaptureStatusSchema,
    streams: z.array(WorkerRuntimeRawStreamSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const refs = new Set<string>();

    for (const [index, stream] of value.streams.entries()) {
      if (refs.has(stream.streamRef)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate runtime stream ref: ${stream.streamRef}.`,
          path: ['streams', index, 'streamRef'],
        });
      }
      refs.add(stream.streamRef);

      const isPrimary = stream.streamRef === value.primaryStreamRef;
      if (isPrimary !== (stream.sourceKind === 'primary')) {
        ctx.addIssue({
          code: 'custom',
          message: 'Exactly the declared primary stream must use sourceKind primary.',
          path: ['streams', index, 'sourceKind'],
        });
      }
      if (
        value.captureStatus === 'complete' &&
        (stream.captureStatus !== 'complete' || !stream.stableTerminal)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'A complete runtime manifest requires complete stable streams.',
          path: ['streams', index],
        });
      }
    }

    if (!refs.has(value.primaryStreamRef)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Runtime stream manifest must contain its declared primary stream.',
        path: ['primaryStreamRef'],
      });
    }
  });

/** Restricted index entry mapping one physical raw frame to runtime-native origin evidence. */
export const WorkerRuntimeNativeOriginIndexEntrySchema = z
  .object({
    schemaVersion: WorkerProtocolSchemaVersionSchema,
    lineage: WorkerLineageSchema,
    runtimeFamily: WorkerOpaqueIdSchema,
    adapterVersion: WorkerOpaqueIdSchema,
    streamRef: WorkerRuntimeStreamRefSchema,
    frameSequence: z.number().int().nonnegative(),
    byteOffset: z.number().int().nonnegative(),
    byteLength: z.number().int().positive(),
    frameSha256: WorkerRuntimeSha256Schema,
    eventKind: z.string().min(1),
    parseStatus: WorkerRuntimeFrameParseStatusSchema,
    nativeSessionId: WorkerOpaqueIdSchema.optional(),
    nativeThreadId: WorkerOpaqueIdSchema.optional(),
    parentNativeThreadId: WorkerOpaqueIdSchema.optional(),
    nativeTurnId: WorkerOpaqueIdSchema.optional(),
    runtimeRole: z.string().min(1).optional(),
    runtimeNickname: z.string().min(1).optional(),
    runtimeDepth: z.number().int().nonnegative().optional(),
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

/** Canonical non-terminal event types accepted through ordinary live append. */
export const WorkerCanonicalNonTerminalEventTypeSchema = z.enum([
  'worker.ready',
  'worker.heartbeat',
  'item.created',
  'item.delta',
  'item.completed',
  'artifact.created',
  'artifact.updated',
]);

/** Canonical terminal event types accepted only through final status. */
export const WorkerCanonicalTerminalEventTypeSchema = z.enum(['turn.completed', 'turn.failed']);

/**
 * JSON-compatible object payload used for product-safe summaries.
 */
export const WorkerRecordDataSchema = z.record(z.string(), z.unknown());

/** Worker-local bounded-step outcomes represented by canonical terminal events. */
export const WorkerCanonicalTerminalStatusSchema = z.enum([
  'blocked',
  'cancelled',
  'completed',
  'degraded',
  'failed',
  'interrupted',
  'lost',
]);

/** Strict product-safe data shared by terminal transcript and final-status event records. */
export const WorkerCanonicalTerminalEventDataSchema = z
  .object({
    diagnostics: z.record(z.string().min(1), z.string()).optional(),
    evidenceManifestDigests: z.record(z.string(), z.string().min(1)).default({}),
    status: WorkerCanonicalTerminalStatusSchema,
    stopReason: z.string().trim().min(1),
  })
  .strict();

/** Canonical worker event payload discriminated between ordinary and terminal records. */
const WorkerCanonicalEventSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: WorkerCanonicalNonTerminalEventTypeSchema,
        data: WorkerRecordDataSchema.default({}),
      })
      .strict(),
    z
      .object({
        type: WorkerCanonicalTerminalEventTypeSchema,
        data: WorkerCanonicalTerminalEventDataSchema,
      })
      .strict(),
  ])
  .superRefine((event, ctx) => {
    if (event.type === 'turn.completed' && event.data.status !== 'completed') {
      ctx.addIssue({
        code: 'custom',
        message: 'turn.completed requires completed status.',
        path: ['data', 'status'],
      });
    }
    if (event.type === 'turn.failed' && event.data.status === 'completed') {
      ctx.addIssue({
        code: 'custom',
        message: 'turn.failed cannot use completed status.',
        path: ['data', 'status'],
      });
    }
  });

/**
 * Canonical event append record emitted by a worker sidecar.
 */
export const WorkerCanonicalEventRecordSchema = WorkerRecordBaseSchema.extend({
  kind: z.literal('event'),
  event: WorkerCanonicalEventSchema,
}).strict();

/** Input used to build one canonical terminal event record. */
export interface BuildWorkerCanonicalTerminalEventRecordInput {
  /** Strict terminal event data, with empty evidence digests supplied by default. */
  readonly data: z.input<typeof WorkerCanonicalTerminalEventDataSchema>;
  /** Package-scoped worker lineage. */
  readonly lineage: WorkerLineage;
  /** Final worker transcript sequence. */
  readonly sequence: number;
}

/**
 * Builds the byte-stable terminal event shared by transcript and final-status paths.
 *
 * @param input Terminal data, lineage, and final worker sequence.
 * @returns Strict canonical terminal event record.
 * @throws ZodError when terminal data or lineage is invalid.
 */
export function buildWorkerCanonicalTerminalEventRecord(
  input: BuildWorkerCanonicalTerminalEventRecordInput
): WorkerCanonicalEventRecord {
  const data = WorkerCanonicalTerminalEventDataSchema.parse(input.data);

  return WorkerCanonicalEventRecordSchema.parse({
    event: {
      data,
      type: data.status === 'completed' ? 'turn.completed' : 'turn.failed',
    },
    kind: 'event',
    lineage: input.lineage,
    schemaVersion: 1,
    sequence: input.sequence,
  });
}

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
      kind: z.enum(['report', 'diff', 'file', 'summary']),
      title: z.string().min(1),
      path: z.string().min(1),
      mediaType: z.enum(['text/markdown', 'text/plain', 'application/json']),
      /** Optional immutable Material target and base proposed by this Artifact. */
      materialProposal: z
        .object({
          materialId: WorkerOpaqueIdSchema,
          baseRevisionId: WorkerOpaqueIdSchema,
          baseContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
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
  'event_append',
  'final_status',
  'supply_refresh_ack',
  'capability_summary',
]);

/** Canonical 256-bit worker process key or SHA-256 digest encoded as unpadded base64url. */
export const WorkerProcessKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Worker lifecycle states accepted by the heartbeat route. */
export const WorkerControlHeartbeatStatusSchema = z.enum([
  'starting',
  'running',
  'idle',
  'awaiting_command',
  'stopping',
  'completed',
  'failed',
]);

/** Canonical heartbeat body persisted and fingerprinted by NanoCore. */
export const WorkerControlHeartbeatBodySchema = z
  .object({
    status: WorkerControlHeartbeatStatusSchema,
    message: z.string().min(1).nullable().optional(),
    processKeyHash: WorkerProcessKeySchema.optional(),
  })
  .strict();

const WorkerControlHeartbeatEnvelopeBaseSchema = z
  .object({
    schemaVersion: WorkerControlSchemaVersionSchema,
    lineage: WorkerLineageSchema,
    sequence: WorkerSequenceSchema,
    operation: z.literal('heartbeat'),
    body: WorkerControlHeartbeatBodySchema,
  })
  .strict();

/** Heartbeat request with an optional memory-only reconnect key outside the canonical envelope. */
export const WorkerControlHeartbeatRequestSchema = WorkerControlHeartbeatEnvelopeBaseSchema.extend({
  reconnectKey: WorkerProcessKeySchema.optional(),
}).superRefine(validateWorkerControlHeartbeat);

/**
 * Bounded worker-control request envelope.
 */
export const WorkerControlRequestEnvelopeSchema = z
  .object({
    schemaVersion: WorkerControlSchemaVersionSchema,
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
    schemaVersion: WorkerControlSchemaVersionSchema,
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

/** Enforces the initial process-key commitment without changing later heartbeat fingerprints. */
function validateWorkerControlHeartbeat(
  value: z.infer<typeof WorkerControlHeartbeatEnvelopeBaseSchema>,
  context: z.RefinementCtx
): void {
  const initial = value.sequence === 0;

  if (initial !== (value.body.status === 'starting')) {
    context.addIssue({
      code: 'custom',
      message: 'Only the sequence-zero heartbeat may use starting status.',
      path: ['sequence'],
    });
  }
  if (initial !== (value.body.processKeyHash !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Only the sequence-zero heartbeat must commit the worker process key hash.',
      path: ['body', 'processKeyHash'],
    });
  }
}

/** Worker lineage inferred TypeScript type. */
export type WorkerLineage = z.infer<typeof WorkerLineageSchema>;
/** Runtime raw stream manifest inferred TypeScript type. */
export type WorkerRuntimeRawStreamManifest = z.infer<typeof WorkerRuntimeRawStreamManifestSchema>;
/** Runtime native-origin index entry inferred TypeScript type. */
export type WorkerRuntimeNativeOriginIndexEntry = z.infer<
  typeof WorkerRuntimeNativeOriginIndexEntrySchema
>;
/** Worker text part inferred TypeScript type. */
export type WorkerTextPart = z.infer<typeof WorkerTextPartSchema>;
/** Canonical worker event record inferred TypeScript type. */
export type WorkerCanonicalEventRecord = z.infer<typeof WorkerCanonicalEventRecordSchema>;
/** Canonical worker event type inferred TypeScript type. */
export type WorkerCanonicalEventType = z.infer<typeof WorkerCanonicalEventTypeSchema>;
/** Canonical non-terminal worker event type inferred TypeScript type. */
export type WorkerCanonicalNonTerminalEventType = z.infer<
  typeof WorkerCanonicalNonTerminalEventTypeSchema
>;
/** Canonical terminal event data inferred TypeScript type. */
export type WorkerCanonicalTerminalEventData = z.infer<
  typeof WorkerCanonicalTerminalEventDataSchema
>;
/** Canonical terminal event data input inferred TypeScript type. */
export type WorkerCanonicalTerminalEventDataInput = z.input<
  typeof WorkerCanonicalTerminalEventDataSchema
>;
/** Worker transcript record inferred TypeScript type. */
export type WorkerTranscriptRecord = z.infer<typeof WorkerTranscriptRecordSchema>;
/** Worker workspace change manifest inferred TypeScript type. */
export type WorkerWorkspaceChangeManifest = z.infer<typeof WorkerWorkspaceChangeManifestSchema>;
/** Worker capability call summary inferred TypeScript type. */
export type WorkerCapabilityCallSummary = z.infer<typeof WorkerCapabilityCallSummarySchema>;
/** Worker heartbeat lifecycle status inferred TypeScript type. */
export type WorkerControlHeartbeatStatus = z.infer<typeof WorkerControlHeartbeatStatusSchema>;
/** Worker control request envelope inferred TypeScript type. */
export type WorkerControlRequestEnvelope = z.infer<typeof WorkerControlRequestEnvelopeSchema>;
/** Complete worker-control heartbeat request inferred TypeScript type. */
export type WorkerControlHeartbeatRequest = z.infer<typeof WorkerControlHeartbeatRequestSchema>;
/** Worker control response envelope inferred TypeScript type. */
export type WorkerControlResponseEnvelope = z.infer<typeof WorkerControlResponseEnvelopeSchema>;
/** Product-safe worker error envelope inferred TypeScript type. */
export type WorkerErrorEnvelope = z.infer<typeof WorkerErrorEnvelopeSchema>;

/**
 * Derives the closed AEP and Context input slots owned by one admitted AgentSession.
 *
 * @param agentSessionId Exact internal identity, without a lossy path transformation.
 * @returns Stable absolute input paths and file-effect slot-relative paths.
 * @throws Error when the identity is missing or is not a canonical path segment.
 */
export function workerSessionInputPaths(agentSessionId: string | undefined) {
  if (typeof agentSessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(agentSessionId)) {
    throw new Error('Worker inputs require a canonical AgentSession identity.');
  }
  const root = `/openkit/sessions/${agentSessionId}`;
  return {
    root,
    packagePath: `${root}/config/package.json`,
    contextRoot: `${root}/context`,
    packageRelativePath: `${agentSessionId}/config/package.json`,
    contextRelativePath: `${agentSessionId}/context`,
  };
}
