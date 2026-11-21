import { ActorRefSchema, PolicyDocumentV1Schema, WorkspaceIdSchema } from '@openkit/protocol';
import { type WorkerLineage, WorkerLineageSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import { WorkerImageSettlementSchema } from '../runtime/worker-image-settlements-records.js';

const text = z.string().min(1);
const stepRef = z
  .object({
    execution: z
      .object({ owner: z.object({ kind: z.literal('server') }).strict(), executionId: text })
      .strict(),
    stepId: text,
  })
  .strict();
const imageTarget = z
  .object({
    targetId: text,
    identityId: text,
    deploymentId: text,
    connectionGeneration: z.number().int().positive().safe(),
    physicalEpoch: text,
  })
  .strict();

/** Exact result frame for the original acquisition under the current admitted NanoHost read. */
export const ControlCoreImageResultSchema = z
  .object({
    kind: z.literal('image-result'),
    ref: stepRef,
    settlement: WorkerImageSettlementSchema.extend({ operation: z.literal('image.acquire') }),
    target: imageTarget,
  })
  .strict();

export type ControlCoreImageResult = z.infer<typeof ControlCoreImageResultSchema>;

/** Release-authored bounds are part of the fixed reviewed template, never operator configuration. */
export const SECURITY_CONTAINMENT_LIMITS = Object.freeze({
  version: 'containment/v1',
  currentServer: 8,
  currentWorkspace: 2,
  cumulativeServer: 16,
  cumulativeWorkspace: 4,
  windowSeconds: 3_600,
  pendingServer: 16,
  pendingWorkspace: 4,
  actionSeconds: 60,
  reviewSeconds: 86_400,
});

/** Sensor and gap evidence have their own finite release bounds, independent of effect capacity. */
export const SECURITY_OBSERVATION_LIMITS = Object.freeze({
  perRun: 1,
  workspaceWindow: 16,
  serverWindow: 64,
  gapWindow: 16,
});

/** Closed existing Core producer decisions; callers cannot provide permission or capacity results. */
export const ControlCoreJournalInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('containment-inspect'),
      policy: PolicyDocumentV1Schema,
      workspaceId: WorkspaceIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('containment-intent'),
      policy: PolicyDocumentV1Schema,
      lineage: WorkerLineageSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('containment-check'),
      policy: PolicyDocumentV1Schema,
      ref: stepRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('containment-settle'),
      policy: PolicyDocumentV1Schema,
      ref: stepRef,
    })
    .strict(),
  z
    .object({ kind: z.literal('containment-cancel'), policy: PolicyDocumentV1Schema, ref: stepRef })
    .strict(),
  z
    .object({
      kind: z.literal('containment-outcome'),
      policy: PolicyDocumentV1Schema,
      ref: stepRef,
    })
    .strict(),
  z
    .object({ kind: z.literal('containment-review'), policy: PolicyDocumentV1Schema, ref: stepRef })
    .strict(),
  z
    .object({ kind: z.literal('containment-stop'), policy: PolicyDocumentV1Schema, ref: stepRef })
    .strict(),
  z
    .object({
      kind: z.literal('containment-stop-outcome'),
      policy: PolicyDocumentV1Schema,
      ref: stepRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('image-intent'),
      intentJson: text,
      processWitness: text,
      target: imageTarget,
    })
    .strict(),
  z.object({ kind: z.literal('image-abandon'), ref: stepRef, accepted: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('idle-intent'),
      intentJson: text,
      processWitness: text,
      backendId: text,
      attemptId: text,
      identity: z
        .object({
          agentSessionId: text,
          backendKind: z.literal('openshell'),
          backendSessionId: text,
          deploymentId: text,
          packageSnapshotId: text,
          runtimeTargetId: text,
          stagingDirectoryRef: text,
          transientProviderInstanceId: text.nullable(),
        })
        .strict(),
      package: z
        .object({
          workspaceId: text,
          threadId: text,
          turnId: text,
          agentSessionId: text,
          snapshotId: text,
          triggerActor: ActorRefSchema,
        })
        .strict(),
      originPhysicalEpoch: text,
      sandboxBindingRef: text,
      sandboxId: text.optional(),
      predecessor: z
        .object({ ref: stepRef, revision: z.number().int().positive().safe() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('idle-settle'),
      intentJson: text,
      state: z.enum(['completed', 'failed', 'unknown']),
      resultFingerprint: text.optional(),
      candidateDigest: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/)
        .optional(),
      processWitness: text,
    })
    .strict(),
]);
/** Exact existing Core tuple input, never a SQL or callback API. */
export type ControlCoreJournalInput = z.infer<typeof ControlCoreJournalInputSchema>;

/** Decodes the original containment step's one immutable lineage and matching Workspace. */
export function readCoreJournalLineage(inputRefs: readonly string[]): WorkerLineage {
  const lineages = inputRefs.filter((ref) => ref.startsWith('lineage:'));
  const workspaces = inputRefs.filter((ref) => ref.startsWith('workspace:'));
  if (lineages.length !== 1 || workspaces.length !== 1)
    throw new CoreJournalRefusal('Containment original lineage is uncertain.');
  const lineage = WorkerLineageSchema.parse(JSON.parse(lineages[0]!.slice(8)));
  if (workspaces[0] !== `workspace:${lineage.workspaceId}`)
    throw new CoreJournalRefusal('Containment original Workspace conflicts with its lineage.');
  return lineage;
}
/** Closed owner refusal; database errors remain private native causes. */
export class CoreJournalRefusal extends Error {
  constructor(
    message: string,
    readonly reasonCode?: 'idle_cleanup_result_only' | 'image_result_conflict'
  ) {
    super(message);
  }
}
/** A known domain refusal retains its original message and result-only classification. */
export const ControlCoreJournalRefusalSchema = z
  .object({
    operation: z.literal('core-journal'),
    code: z.literal('core_journal_refused'),
    message: text,
    status: z.literal(409),
    reasonCode: z.enum(['idle_cleanup_result_only', 'image_result_conflict']).optional(),
  })
  .strict();
