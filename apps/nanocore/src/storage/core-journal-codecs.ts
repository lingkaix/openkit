import { ActorRefSchema } from '@openkit/protocol';
import { z } from 'zod';

const text = z.string().min(1);
const stepRef = z
  .object({
    execution: z
      .object({ owner: z.object({ kind: z.literal('server') }).strict(), executionId: text })
      .strict(),
    stepId: text,
  })
  .strict();
/** Only the four existing Core journal producer decisions may cross this private owner boundary. */
export const ControlCoreJournalInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('image-intent'),
      intentJson: text,
      processWitness: text,
      target: z
        .object({
          targetId: text,
          identityId: text,
          deploymentId: text,
          connectionGeneration: z.number().int().positive().safe(),
          physicalEpoch: text,
        })
        .strict(),
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
      processWitness: text,
    })
    .strict(),
]);
/** Exact existing Core tuple input, never a SQL or callback API. */
export type ControlCoreJournalInput = z.infer<typeof ControlCoreJournalInputSchema>;
/** Closed owner refusal; database errors remain private native causes. */
export class CoreJournalRefusal extends Error {
  constructor(
    message: string,
    readonly reasonCode?: 'idle_cleanup_result_only'
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
    reasonCode: z.literal('idle_cleanup_result_only').optional(),
  })
  .strict();
