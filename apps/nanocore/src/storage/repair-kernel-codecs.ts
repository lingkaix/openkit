import {
  ActorRefSchema,
  AuditEventIdSchema,
  CapabilityCallIdSchema,
  PolicyDigestV1Schema,
  PolicyDocumentV1Schema,
  WorkOwnerSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { RepairCallIntent } from './control-kernel-port.js';

const key = z.string().min(1).max(512);
const step = z.strictObject({
  execution: z.strictObject({ executionId: key, owner: WorkOwnerSchema }),
  stepId: key,
});
const intent = z.strictObject({
  deploymentId: key,
  sourceOwner: z.literal('control-kernel'),
  verb: z.literal('repair.model-call'),
  occurrenceKey: key,
  requestId: key,
  target: z.strictObject({
    entryStep: step,
    attemptId: key,
    invocationId: key,
    callId: CapabilityCallIdSchema,
    routeRef: key,
    allocationRef: key,
  }),
  expectedGeneration: PolicyDigestV1Schema.nullable(),
  inputDigest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
}) satisfies z.ZodType<RepairCallIntent>;
const reservation = z.strictObject({
  intent,
  disposition: z.literal('applied'),
  receiptDigest: key,
  result: z.strictObject({ step }),
});
const authority = z.strictObject({
  actor: ActorRefSchema,
  credentialRef: key.nullable(),
  policy: PolicyDocumentV1Schema,
  vaultReferenceId: key,
  vaultVersion: z.number().int().positive(),
});
const proposal = z.string().min(1);

export const RepairWorkerInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('admit'),
    proposal,
    authority,
    admission: z.strictObject({
      callId: CapabilityCallIdSchema,
      routeRef: key,
      allocationRef: key,
      policyRevision: PolicyDigestV1Schema,
      inputDigest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
    }),
  }),
  z.strictObject({ kind: z.literal('reserve'), intent, proposal, authority }),
  z.strictObject({ kind: z.literal('inspect'), intent }),
  z.strictObject({ kind: z.literal('authorize-contact'), reservation, authority }),
  z.strictObject({
    kind: z.literal('settle'),
    reservation,
    proposal,
    outcome: z.strictObject({
      disposition: z.enum(['succeeded', 'failed', 'unknown']),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    }),
  }),
]);
export type RepairWorkerInput = z.infer<typeof RepairWorkerInputSchema>;

const hold = z.strictObject({ state: z.enum(['unknown', 'conflict']) });
const refused = z.strictObject({
  state: z.literal('refused'),
  reason: z.enum(['policy', 'vault', 'budget']),
});
const inspect = z.union([
  z.strictObject({ state: z.literal('reserved'), reservation }),
  z.strictObject({ state: z.literal('terminal'), auditEventId: AuditEventIdSchema }),
  z.strictObject({ state: z.literal('absent') }),
  refused,
  hold,
]);

export const RepairWorkerReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('admit'),
    value: z.union([hold, z.strictObject({ state: z.literal('settled'), receipt: intent })]),
  }),
  z.strictObject({
    kind: z.literal('reserve'),
    value: inspect.or(z.strictObject({ state: z.literal('reserved-now'), reservation })),
  }),
  z.strictObject({ kind: z.literal('inspect'), value: inspect }),
  z.strictObject({
    kind: z.literal('authorize-contact'),
    value: z.enum(['allowed', 'policy', 'vault']),
  }),
  z.strictObject({
    kind: z.literal('settle'),
    value: z.union([
      hold,
      z.strictObject({ state: z.literal('settled'), receipt: AuditEventIdSchema }),
    ]),
  }),
]);
export type RepairWorkerReply = z.infer<typeof RepairWorkerReplySchema>;
