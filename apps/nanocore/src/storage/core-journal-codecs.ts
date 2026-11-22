import {
  ActorRefSchema,
  AgentSessionIdSchema,
  ExecutionAttemptIdSchema,
  PolicyDocumentV1Schema,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { type WorkerLineage, WorkerLineageSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import { WorkerImageSettlementSchema } from '../runtime/worker-image-settlements-records.js';
import {
  KernelExecutionGrantSchema,
  KernelExecutionProofIntentSchema,
} from './control-kernel-proof-codecs.js';
import { SchedulerExecutionAttemptSchema } from './execution-attempt-codecs.js';
import {
  ControlWorkerFinalStatusInputSchema,
  ControlWorkerFinalStatusPayloadSchema,
} from './worker-control-final-status-codecs.js';

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

/** The original normalized Harness result and its exact idle consumer. */
export const CoreIdleHarnessConsumptionEvidenceSchema = z.strictObject({
  key: z.strictObject({
    harnessBindingRef: text.max(512),
    operationId: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().nonnegative().safe(),
    resultFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  consumer: z.strictObject({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    agentSessionId: AgentSessionIdSchema,
    agentSessionRuntimeBindingId: text.max(512),
  }),
});

export type CoreIdleHarnessConsumptionEvidence = z.infer<
  typeof CoreIdleHarnessConsumptionEvidenceSchema
>;

export const ControlCoreIdleHarnessConsumptionInputSchema =
  CoreIdleHarnessConsumptionEvidenceSchema.extend({ observedAt: z.iso.datetime().optional() });

export type ControlCoreIdleHarnessConsumptionInput = z.infer<
  typeof ControlCoreIdleHarnessConsumptionInputSchema
>;

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

const finalClocks = { acceptedAt: z.iso.datetime(), eventAcceptedAt: z.iso.datetime() };
const finalFingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Closed Core command carried under the existing Worker final-status byte admission. */
export const ControlCoreNanoHostFinalInputSchema = ControlWorkerFinalStatusInputSchema.omit({
  byteLength: true,
}).extend({
  sandboxBindingRef: text.max(512),
  payload: ControlWorkerFinalStatusPayloadSchema.extend(finalClocks),
});

/** The original Core intake, with the first decision class distinct from a Native replay. */
export const CoreNanoHostFinalIntakeSchema = z
  .object({
    kind: z.enum(['decided', 'cancellation-decided']),
    fingerprint: finalFingerprint,
    ...finalClocks,
  })
  .strict();

/** Exact reply to the Native final writer. A preparation grant cannot authorize a final. */
export const ControlCoreNanoHostFinalDecisionSchema = CoreNanoHostFinalIntakeSchema.extend({
  kind: z.enum(['decided', 'cancellation-decided', 'replay']),
  grant: KernelExecutionGrantSchema.options[1],
});

/** First observation and inspection both carry the exact committed Core receipt. */
export const ControlCoreNanoHostAcceptedFinalResultSchema = z.union([
  z
    .object({
      state: z.enum(['applied', 'inspect-original']),
      receipt: z
        .object({
          intent: KernelExecutionProofIntentSchema,
          disposition: z.literal('applied'),
          receiptDigest: finalFingerprint,
          result: z.object({ step: stepRef }).strict(),
        })
        .strict(),
    })
    .strict(),
  z.object({ state: z.enum(['unknown', 'conflict']) }).strict(),
]);

export type ControlCoreNanoHostAcceptedFinalResult = z.infer<
  typeof ControlCoreNanoHostAcceptedFinalResultSchema
>;

/** First submission names the attempt and the exact admitted Native placement. */
export const ControlNanoHostFirstSubmissionInputSchema = z
  .object({
    attemptId: ExecutionAttemptIdSchema,
    observedAt: z.string().datetime().optional(),
    placement: z
      .object({
        runtimeTargetId: text,
        identityId: text,
        deploymentId: text,
        physicalEpoch: z.string().regex(/^[0-9a-f]{64}$/),
        connectionGeneration: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict();
/** The private Worker frame carries placement facts only, with peer handles supplied by the writer. */
export type ControlNanoHostFirstSubmissionInput = z.infer<
  typeof ControlNanoHostFirstSubmissionInputSchema
>;

/** A replay carries the original submitted attempt without another dispatch permission. */
export const ControlNanoHostFirstSubmissionResultSchema = z
  .object({
    state: z.enum(['admitted-now', 'inspect-original']),
    attempt: SchedulerExecutionAttemptSchema.extend({
      backendId: z.literal('nanohost'),
      agentSessionId: AgentSessionIdSchema,
      inputRef: text,
      bindingRef: text,
      operationId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      deadline: z.string().datetime(),
    }).strict(),
  })
  .strict();
/** Complete submitted attempt and a decision state that distinguishes the first ACK from an inspection. */
export type ControlNanoHostFirstSubmissionResult = z.infer<
  typeof ControlNanoHostFirstSubmissionResultSchema
>;

/** Core consumes the exact physical retirement decision under the admitted peer openings. */
export const ControlNanoHostOrphanRetirementInputSchema = z.strictObject({
  attemptId: ExecutionAttemptIdSchema,
  inputRef: text,
  bindingRef: text,
  backendSessionId: text,
  target: imageTarget,
  observationHash: finalFingerprint,
  physicalCleanedAt: z.iso.datetime(),
  observedAt: z.iso.datetime().optional(),
});

export type ControlNanoHostOrphanRetirementInput = z.infer<
  typeof ControlNanoHostOrphanRetirementInputSchema
>;

const endedWorkerStep = z.strictObject({ stepId: text.max(128), digest: finalFingerprint });

/** Original Workspace handoff, Native fence and scoped release occurrence. */
export const ControlNanoHostTerminalReleaseInputSchema = z.strictObject({
  attemptId: ExecutionAttemptIdSchema,
  target: imageTarget,
  fenceRef: text.max(512),
  coveredScopeRefs: z.array(text.max(512)).min(1).max(4),
  workspaceExecutionId: text.max(128),
  workspaceSteps: z.strictObject({
    terminal: endedWorkerStep,
    output: endedWorkerStep,
    evidence: endedWorkerStep,
    collection: endedWorkerStep,
    consume: endedWorkerStep,
    release: endedWorkerStep,
  }),
});

export type ControlNanoHostTerminalReleaseInput = z.infer<
  typeof ControlNanoHostTerminalReleaseInputSchema
>;

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
