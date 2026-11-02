import {
  WorkerCanonicalEventRecordReaderSchema,
  WorkerCapabilityCallSummaryReaderSchema,
} from '@openkit/worker-protocol';
import { z } from 'zod';
import {
  ControlWorkerHeartbeatInputSchema,
  ControlWorkerHeartbeatRefusalSchema,
} from './worker-control-heartbeat-codecs.js';

/** Nonterminal control streams retain their original independent sequence and receipt stages. */
const ControlOperationSchema = z.enum([
  'artifact_notice',
  'supply_refresh_ack',
  'capability_summary',
  'event_append',
]);
/** Exact hash-authenticated coordinates, sharing the existing binary framing. */
export const ControlWorkerRecordInputSchema = ControlWorkerHeartbeatInputSchema;
/** Original artifact notice projection; these are descriptive fields, not Artifact authority. */
const ArtifactNoticeSchema = z
  .object({
    artifactId: z.string(),
    sequence: z.number().int().nonnegative(),
    title: z.string(),
    path: z.string(),
    mediaType: z.string().nullable(),
    noticedAt: z.string(),
    digest: z.string().nullable().optional(),
    collectionHint: z.string().nullable().optional(),
  })
  .strict();
/** Original supply acknowledgement projection. */
const SupplyAckSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    refreshId: z.string(),
    status: z.enum(['applied', 'rejected', 'unsupported']),
    message: z.string().nullable(),
    acknowledgedAt: z.string(),
  })
  .strict();
/** Descriptive retained notices ignore inert additive fields; publication inputs stay exact. */
export const ControlWorkerArtifactNoticeReaderSchema = ArtifactNoticeSchema.strip();
/** Descriptive retained acknowledgements preserve known core fields and ignore inert additions. */
export const ControlWorkerSupplyAckReaderSchema = SupplyAckSchema.strip();
const receipt = {
  kind: z.literal('record'),
  recordKey: z.string(),
  sequence: z.number().int().nonnegative(),
  acceptedAt: z.string(),
};
/** Closed semantic bodies, with no SQL selector or unrelated record family. */
export const ControlWorkerRecordPayloadSchema = z.union([
  z
    .object({
      kind: z.literal('sequence'),
      operation: ControlOperationSchema,
      sequence: z.number().int().nonnegative(),
      fingerprint: z.string(),
    })
    .strict(),
  z
    .object({ ...receipt, operation: z.literal('artifact_notice'), record: ArtifactNoticeSchema })
    .strict(),
  z
    .object({ ...receipt, operation: z.literal('supply_refresh_ack'), record: SupplyAckSchema })
    .strict(),
  z
    .object({
      ...receipt,
      operation: z.literal('capability_summary'),
      record: WorkerCapabilityCallSummaryReaderSchema,
    })
    .strict(),
  z
    .object({
      ...receipt,
      operation: z.literal('event_append'),
      record: WorkerCanonicalEventRecordReaderSchema,
    })
    .strict(),
]);
/** A record result carries no reply backing; sequence facts preserve the original acknowledgement. */
export const ControlWorkerRecordResultSchema = z.union([
  z
    .object({
      kind: z.literal('sequence'),
      duplicate: z.boolean(),
      nextExpectedSequence: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z.object({ kind: z.literal('record') }).strict(),
]);
/** The original control-domain refusals, under the exact closed publication operation. */
export const ControlWorkerRecordRefusalSchema = ControlWorkerHeartbeatRefusalSchema.extend({
  operation: z.literal('worker-control-record'),
});
/** Exact admitted nonterminal stage. */
export type ControlWorkerRecordInput = z.infer<typeof ControlWorkerRecordInputSchema>;
/** Original semantic stage before existing binary admission. */
export type ControlWorkerRecordCommand = Omit<ControlWorkerRecordInput, 'byteLength'> & {
  readonly payload: z.infer<typeof ControlWorkerRecordPayloadSchema>;
};
/** Typed original receipt before its two independent publications. */
export type ControlWorkerOperationCommand = Omit<ControlWorkerRecordCommand, 'payload'> & {
  readonly payload: Extract<ControlWorkerRecordCommand['payload'], { kind: 'record' }>;
  readonly fingerprint: string;
};
/** Durable decision returned after the original sequence stage and any required receipt stage. */
export type ControlWorkerOperationResult = {
  readonly duplicate: boolean;
  readonly nextExpectedSequence: number;
  readonly record?: ControlWorkerOperationCommand['payload']['record'];
};
/** Complete native stage result. */
export type ControlWorkerRecordResult = z.infer<typeof ControlWorkerRecordResultSchema>;
