import {
  AgentSessionIdSchema,
  ExecutionAttemptIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { WorkspaceDeletionPhaseSchema } from './workspace-sharing.js';

/** Maximum aggregate item count for the administrator cleanup observation. */
export const ADMINISTRATOR_CLEANUP_MAX_ENTRIES = 100;
/** Inclusive UTF-8 byte ceiling for the complete normalized JSON response. */
export const ADMINISTRATOR_CLEANUP_MAX_BYTES = 262144;

/** Stable source order, including sources with no available observations. */
export const ADMINISTRATOR_CLEANUP_SOURCES = [
  'workspace-deletion',
  'execution-attempt',
  'backend-session',
  'agent-session-binding',
  'sandbox-runtime',
  'worker-storage',
] as const;

/** Closed first-slice source vocabulary; no filesystem discovery source is implied. */
export const AdministratorCleanupSourceSchema = z.enum(ADMINISTRATOR_CLEANUP_SOURCES);
/** Existing canonical source represented by an administrator cleanup observation. */
export type AdministratorCleanupSource = z.infer<typeof AdministratorCleanupSourceSchema>;

/** Governing record owner for each source; these paths confer no mutation authority. */
export const ADMINISTRATOR_CLEANUP_SOURCE_OWNERS = {
  'workspace-deletion': 'docs/specs/20260715-multi_user_workspace_system.md',
  'execution-attempt': 'docs/specs/20260703-durable_scheduler_design.md',
  'backend-session': 'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'agent-session-binding': 'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'sandbox-runtime': 'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'worker-storage': 'docs/specs/20260910-persistent_worker_volumes.md',
} as const;

const opaqueId = z.string().min(1);
// Core owns RFC3339 timestamp semantics; the shared Phase-1 scalar only checks nonempty text.
const timestamp = TimestampSchema.datetime({ offset: true });
const unknownEvidence = z.object({
  kind: z.literal('unknown'),
  reason: z.enum(['missing', 'stale', 'contradictory', 'unavailable']),
});
const physicalEpochRelation = z.enum(['same', 'different', 'unknown']);

/**
 * Defines one known-field observation branch without importing a runtime record owner.
 *
 * @param source Existing record family.
 * @param targetShape Exact Core and opaque native identity fields admitted by that source.
 * @param stateShape Fixed source-owned state projection, without raw private record payloads.
 * @returns A descriptive reader with exact evidence and inspection correlation.
 */
function cleanupItemSchema<
  const Source extends AdministratorCleanupSource,
  Target extends z.ZodRawShape,
  State extends z.ZodRawShape,
>(source: Source, targetShape: Target, stateShape: State) {
  const target = z.object(targetShape);
  const state = z.object(stateShape);
  const sourceOwner = z.literal(ADMINISTRATOR_CLEANUP_SOURCE_OWNERS[source]);
  return z
    .object({
      source: z.literal(source),
      sourceOwner,
      target,
      state,
      sourceUpdatedAt: timestamp.nullable(),
      observedAt: timestamp,
      evidence: z.discriminatedUnion('kind', [
        unknownEvidence,
        z.object({
          kind: z.literal('recorded'),
          recordedAt: timestamp,
          reference: target,
        }),
      ]),
      nextInspection: z.object({
        kind: z.literal('source-record'),
        sourceOwner,
        target,
      }),
    })
    .superRefine((item, context) => {
      // Both references use the same known-field target schema and property order.
      const identity = JSON.stringify(item.target);
      if (JSON.stringify(item.nextInspection.target) !== identity) {
        context.addIssue({
          code: 'custom',
          path: ['nextInspection', 'target'],
          message: 'Inspection must address this exact source record.',
        });
      }
      if (
        item.evidence.kind === 'recorded' &&
        JSON.stringify(item.evidence.reference) !== identity
      ) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', 'reference'],
          message: 'Evidence must reference this exact source record.',
        });
      }
    });
}

/** Current deletion-request facts, without staging paths, export bytes or cleanup inference. */
export const AdministratorCleanupWorkspaceDeletionItemSchema = cleanupItemSchema(
  'workspace-deletion',
  {
    kind: z.literal('workspace-deletion'),
    workspaceId: WorkspaceIdSchema,
    requestId: opaqueId,
  },
  {
    phase: WorkspaceDeletionPhaseSchema,
    retainedStaging: z.boolean(),
    cleanedAt: timestamp.nullable(),
  }
);

/** Attempt coordination facts; closed product work does not establish physical cleanup. */
export const AdministratorCleanupExecutionAttemptItemSchema = cleanupItemSchema(
  'execution-attempt',
  {
    kind: z.literal('execution-attempt'),
    attemptId: ExecutionAttemptIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    agentSessionId: AgentSessionIdSchema.nullable(),
  },
  {
    phase: z.enum(['open', 'closing', 'closed']),
    disposition: z.enum(['not_accepted', 'accepted', 'unknown']),
  }
);

/** Backend-owned cleanup and handoff observations, excluding native handles and Epoch values. */
export const AdministratorCleanupBackendSessionItemSchema = cleanupItemSchema(
  'backend-session',
  {
    kind: z.literal('backend-session'),
    attemptId: ExecutionAttemptIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    agentSessionId: AgentSessionIdSchema,
  },
  {
    state: z.enum([
      'materializing',
      'materialized',
      'launching',
      'cleanup-pending',
      'cleanup-failed',
      'physical-cleaned',
      'cleaned',
    ]),
    workspaceHandoffState: z.enum(['pending', 'complete']),
    physicalCleanedAt: timestamp.nullable(),
    physicalEpochRelation,
  }
);

/** AgentSession-local lifecycle and cleanup observations, excluding restricted native state. */
export const AdministratorCleanupAgentSessionBindingItemSchema = cleanupItemSchema(
  'agent-session-binding',
  {
    kind: z.literal('agent-session-binding'),
    agentSessionRuntimeBindingId: opaqueId,
    agentSessionId: AgentSessionIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
  },
  {
    lifecycleState: z.enum(['opening', 'open', 'active', 'closing', 'closed', 'failed']),
    cleanupState: z.enum(['clean', 'pending', 'unknown']),
  }
);

/** Existing Sandbox record states; an Epoch comparison alone grants no replacement authority. */
export const AdministratorCleanupSandboxRuntimeItemSchema = cleanupItemSchema(
  'sandbox-runtime',
  {
    kind: z.literal('sandbox-runtime'),
    sandboxRuntimeId: opaqueId,
    runtimeTargetId: opaqueId,
  },
  {
    lifecycleState: z.enum(['open', 'failed']),
    healthState: z.enum(['ready', 'unknown']),
    drainState: z.enum(['accepting', 'draining']),
    cleanupState: z.enum(['clean', 'unknown']),
    physicalEpochRelation,
  }
);

/** Retained-storage state and revision, without paths, contributors or volume internals. */
export const AdministratorCleanupWorkerStorageItemSchema = cleanupItemSchema(
  'worker-storage',
  {
    kind: z.literal('worker-storage'),
    storageRef: WorkerStorageTargetIdSchema,
    workspaceId: WorkspaceIdSchema,
    runtimeTargetId: opaqueId,
  },
  {
    state: z.enum(['idle', 'reserved', 'attached', 'unknown', 'purge-pending', 'purged']),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    purgedAt: timestamp.nullable(),
  }
);

/** The six declared source branches; descriptive additions are removed at each object boundary. */
export const AdministratorCleanupItemSchema = z.discriminatedUnion('source', [
  AdministratorCleanupWorkspaceDeletionItemSchema,
  AdministratorCleanupExecutionAttemptItemSchema,
  AdministratorCleanupBackendSessionItemSchema,
  AdministratorCleanupAgentSessionBindingItemSchema,
  AdministratorCleanupSandboxRuntimeItemSchema,
  AdministratorCleanupWorkerStorageItemSchema,
]);

/** Coverage of source enumeration, distinct from the cleanup proof carried by individual items. */
export const AdministratorCleanupSourceObservationSchema = z
  .object({
    source: AdministratorCleanupSourceSchema,
    availability: z.enum(['available', 'unavailable']),
    incomplete: z.boolean(),
    reasons: z
      .array(z.enum(['count_limit', 'byte_limit', 'source_unavailable', 'source_changed']))
      .max(4),
  })
  .superRefine((source, context) => {
    if (new Set(source.reasons).size !== source.reasons.length) {
      context.addIssue({
        code: 'custom',
        path: ['reasons'],
        message: 'Coverage reasons must be unique.',
      });
    }
    if (source.incomplete !== source.reasons.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['incomplete'],
        message: 'Incomplete source coverage requires its reasons.',
      });
    }
    if ((source.availability === 'unavailable') !== source.reasons.includes('source_unavailable')) {
      context.addIssue({
        code: 'custom',
        path: ['availability'],
        message: 'Unavailable source coverage requires source_unavailable.',
      });
    }
  });

/**
 * Complete bounded read projection; validation does not enumerate, authorize or truncate sources.
 *
 * Evidence validity and current authority remain with the source reader. Byte accounting includes the complete normalized response, including all coverage and inspection metadata.
 */
export const AdministratorCleanupReadResponseSchema = z
  .object({
    observedAt: timestamp,
    items: z.array(AdministratorCleanupItemSchema).max(ADMINISTRATOR_CLEANUP_MAX_ENTRIES),
    sources: z
      .array(AdministratorCleanupSourceObservationSchema)
      .length(ADMINISTRATOR_CLEANUP_SOURCES.length),
    incomplete: z.boolean(),
  })
  .superRefine((response, context) => {
    for (const [index, source] of response.sources.entries()) {
      if (source.source !== ADMINISTRATOR_CLEANUP_SOURCES[index]) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'source'],
          message: 'Every declared source must occur once in the fixed source order.',
        });
      }
    }
    for (const [index, item] of response.items.entries()) {
      if (item.observedAt !== response.observedAt) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'observedAt'],
          message: 'Item observation time must match this read.',
        });
      }
    }
    if (
      response.incomplete !==
      response.sources.some((source) => source.incomplete || source.availability === 'unavailable')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['incomplete'],
        message: 'Aggregate completeness must retain every source coverage limitation.',
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      ADMINISTRATOR_CLEANUP_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Cleanup response exceeds its UTF-8 byte ceiling.',
      });
    }
  });

/** Safe projection of one canonical Workspace deletion request. */
export type AdministratorCleanupWorkspaceDeletionItem = z.infer<
  typeof AdministratorCleanupWorkspaceDeletionItemSchema
>;
/** Safe projection of one scheduler execution attempt. */
export type AdministratorCleanupExecutionAttemptItem = z.infer<
  typeof AdministratorCleanupExecutionAttemptItemSchema
>;
/** Safe projection of one backend cleanup anchor. */
export type AdministratorCleanupBackendSessionItem = z.infer<
  typeof AdministratorCleanupBackendSessionItemSchema
>;
/** Safe projection of one AgentSession runtime binding. */
export type AdministratorCleanupAgentSessionBindingItem = z.infer<
  typeof AdministratorCleanupAgentSessionBindingItemSchema
>;
/** Safe projection of one Sandbox runtime record. */
export type AdministratorCleanupSandboxRuntimeItem = z.infer<
  typeof AdministratorCleanupSandboxRuntimeItemSchema
>;
/** Safe projection of one retained Worker storage binding. */
export type AdministratorCleanupWorkerStorageItem = z.infer<
  typeof AdministratorCleanupWorkerStorageItemSchema
>;
/** Exact source-discriminated cleanup observation. */
export type AdministratorCleanupItem = z.infer<typeof AdministratorCleanupItemSchema>;
/** The five Core runtime branches supplied by the runtime cleanup reader. */
export type AdministratorCleanupRuntimeItem = Exclude<
  AdministratorCleanupItem,
  { source: 'workspace-deletion' }
>;
/** Explicit source enumeration coverage, including unavailable sources. */
export type AdministratorCleanupSourceObservation = z.infer<
  typeof AdministratorCleanupSourceObservationSchema
>;
/** Complete administrator-only cleanup read projection; the schema itself grants no access. */
export type AdministratorCleanupReadResponse = z.infer<
  typeof AdministratorCleanupReadResponseSchema
>;
