import { HarnessResultEnvelopeReaderSchema } from '@openkit/worker-protocol';
import { z } from 'zod';

const identity = z.string().min(1);
const timestamp = identity;
const operation = z.enum([
  'session.open',
  'session.inspect',
  'turn.start',
  'turn.steer',
  'turn.interrupt',
  'session.close',
  'harness.drain',
]);
const body = z.record(z.string(), z.unknown());
const command = z
  .object({
    harnessInstanceId: identity,
    schemaVersion: z.literal(2),
    operationId: identity,
    sequence: z.number().int().nonnegative().safe(),
    operation,
    body,
  })
  .strict();
// Retained result envelopes keep the existing open descriptive extension rule.
const result = HarnessResultEnvelopeReaderSchema;
/** Existing original Vault injection lineage only; private commands cannot patch other binding fields. */
const RuntimeEnvCheckVersionCoreSchema = z.object({
  targetEnvVarName: identity.optional(),
  targetPath: identity.optional(),
  vaultReferenceId: identity,
  materialVersion: z.number().int().positive().safe(),
  grantId: identity,
  planId: identity,
  receiptId: identity,
});
export const RuntimeEnvCheckVersionInputSchema = RuntimeEnvCheckVersionCoreSchema.strict().refine(
  (value) =>
    Number(value.targetEnvVarName !== undefined) + Number(value.targetPath !== undefined) === 1
);
/** Retained descriptive additions remain in the original value; validation never rewrites existing entries. */
export const RetainedRuntimeEnvCheckVersionSchema =
  RuntimeEnvCheckVersionCoreSchema.passthrough().refine(
    (value) =>
      Number(value.targetEnvVarName !== undefined) + Number(value.targetPath !== undefined) === 1
  );

/** Exact private Harness tuples; every domain lineage and replay predicate stays in the existing record body. */
export const ControlHarnessLifecycleInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('runtime.create'),
      maxActiveTurns: z.number().int().positive().safe().optional(),
      adapterId: identity,
      adapterVersion: identity,
      harnessBindingRef: identity,
      harnessCompatibilityKey: identity,
      harnessInstanceId: identity,
      imageDigest: identity,
      originPhysicalEpoch: identity,
      sandboxBindingRef: identity,
      sandboxCompatibilityKey: identity,
      sandboxIntegrationBindingRef: identity,
      sandboxRuntimeId: identity,
      runtimeTargetId: identity,
      timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('sandbox.claim-idle-drain'),
      sandboxRuntimeId: identity,
      sandboxBindingRef: identity,
      sandboxCompatibilityKey: identity,
      runtimeTargetId: identity,
      originPhysicalEpoch: identity,
      physicalAbsent: z.boolean(),
      timestamp,
      incoming: z
        .object({
          workspaceId: identity,
          threadId: identity,
          turnId: identity,
          packageSnapshotId: identity,
          backendId: identity,
        })
        .strict(),
      bindings: z.array(
        z
          .object({
            agentSessionId: identity,
            agentSessionRuntimeBindingId: identity,
            harnessInstanceId: identity,
            harnessBindingRef: identity,
            harnessCompatibilityKey: identity,
            lifecycleState: identity,
            nativeHandleDigest: identity.nullable(),
          })
          .strict()
      ),
      replacementStorage: z
        .object({ storageRef: identity, revision: z.number().int().positive().safe() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('harness.claim-idle-capture-drain'),
      harnessBindingRef: identity,
      harnessInstanceId: identity,
      agentSessionId: identity,
      agentSessionRuntimeBindingId: identity,
      attemptId: identity,
      sandboxBindingRef: identity,
      originPhysicalEpoch: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('session-binding.initialize-check-versions'),
      agentSessionRuntimeBindingId: identity,
      harnessInstanceId: identity,
      agentSessionId: identity,
      expectedVersionsJson: z.string().nullable(),
      versions: z.array(RuntimeEnvCheckVersionInputSchema).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('session-binding.append-check-version'),
      agentSessionRuntimeBindingId: identity,
      harnessInstanceId: identity,
      agentSessionId: identity,
      expectedVersionsJson: z.string(),
      version: RuntimeEnvCheckVersionInputSchema.refine((value) => value.targetPath !== undefined),
    })
    .strict(),
  z.object({ kind: z.literal('sandbox.restore-admission'), sandboxRuntimeId: identity }).strict(),
  z.object({ kind: z.literal('sandbox.remove-for-harness'), harnessInstanceId: identity }).strict(),
  z.object({ kind: z.literal('sandbox.remove-by-binding'), sandboxBindingRef: identity }).strict(),
  z.object({ kind: z.literal('harness.drain'), harnessBindingRef: identity, timestamp }).strict(),
  z
    .object({
      kind: z.literal('sandbox.drain'),
      sandboxBindingRef: identity,
      originPhysicalEpoch: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('sandbox.fence'),
      harnessBindingRef: identity.optional(),
      sandboxBindingRef: identity.optional(),
      timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('session-binding.open'),
      nativeEnvironment: z
        .object({
          agentId: identity,
          imageDigest: identity,
          defaultsDigest: identity,
          values: z.record(z.string(), z.string()),
        })
        .strict()
        .optional(),
      agentSessionCompatibilityKey: identity,
      agentSessionId: identity,
      agentSessionRuntimeBindingId: identity,
      effectiveSetupGeneration: z.number().int().nonnegative().safe(),
      harnessInstanceId: identity,
      threadId: identity,
      timestamp,
      workspaceId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('measured-identity.copy'),
      agentSessionRuntimeBindingId: identity,
      imageDigest: identity,
      timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation.queue'),
      prepared: z.object({ command, wireBody: body }).strict(),
      body,
      harnessInstanceId: identity,
      operation,
      timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation.dispatch'),
      sandboxIntegrationBindingRef: identity,
      observedAt: timestamp.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('operation.expire'), harnessBindingRef: identity, timestamp })
    .strict(),
  z
    .object({
      kind: z.literal('operation.settle'),
      sandboxIntegrationBindingRef: identity,
      result,
      timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation.unknown'),
      harnessBindingRef: identity,
      operationId: identity,
      timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('result.acknowledge'),
      result,
      harnessBindingRef: identity,
      consumerReceipt: identity,
      timestamp,
    })
    .strict(),
]);
/** Exact domain input, with no SQL, callback or executable selector. */
export type ControlHarnessLifecycleInput = z.infer<typeof ControlHarnessLifecycleInputSchema>;
/** Existing method results only; void publication is represented by null on the private peer. */
export const ControlHarnessLifecycleResultSchema = z.union([
  z.null(),
  z.number().int().nonnegative().safe(),
  z.enum(['settled', 'replayed']),
  command,
]);
export type ControlHarnessLifecycleResult = z.infer<typeof ControlHarnessLifecycleResultSchema>;
/** Trusted domain rejection; SQLite diagnostics stay in the worker failure channel. */
export class HarnessLifecycleRefusal extends Error {
  constructor(
    message: string,
    readonly exhaustedBound?: 'sandbox.activeTurns'
  ) {
    super(message);
  }
}
/** Closed private projection of existing validation and busy refusal facts. */
export const ControlHarnessLifecycleRefusalSchema = z
  .object({
    operation: z.literal('harness-lifecycle'),
    code: z.literal('harness_refused'),
    message: z.string(),
    status: z.literal(409),
    exhaustedBound: z.literal('sandbox.activeTurns').optional(),
  })
  .strict();
