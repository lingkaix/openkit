import {
  WorkerCanonicalTerminalEventDataSchema,
  WorkerLineageSchema,
  WorkerSequenceSchema,
} from '@openkit/worker-protocol';
import { z } from 'zod';

/** Exact authenticated Core final-status coordinates; complete descriptive bytes use existing binary admission. */
export const ControlWorkerFinalStatusInputSchema = z
  .object({
    lineage: WorkerLineageSchema,
    sandboxBindingRef: z.string().min(1),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Original terminal record and clocks, with no callback or SQL selector. */
export const ControlWorkerFinalStatusPayloadSchema = z
  .object({
    terminalData: WorkerCanonicalTerminalEventDataSchema,
    sequence: WorkerSequenceSchema,
    acceptedAt: z.string(),
    eventAcceptedAt: z.string(),
  })
  .strict();

/** Existing final and event stream facts returned only after the covering FULL commit. */
export const ControlWorkerFinalStatusResultSchema = z
  .object({
    finalStatusDuplicate: z.boolean(),
    eventDuplicate: z.boolean(),
    nextFinalStatusSequence: WorkerSequenceSchema,
    nextEventSequence: WorkerSequenceSchema,
  })
  .strict();

/** Bounded peer metadata for one complete original Core tuple. */
export type ControlWorkerFinalStatusInput = z.infer<typeof ControlWorkerFinalStatusInputSchema>;
/** Exact terminal bytes admitted through existing binary accounting. */
export type ControlWorkerFinalStatusPayload = z.infer<typeof ControlWorkerFinalStatusPayloadSchema>;
/** Caller-owned exact tuple before existing binary admission. */
export type ControlWorkerFinalStatusCommand = Omit<ControlWorkerFinalStatusInput, 'byteLength'> & {
  readonly payload: ControlWorkerFinalStatusPayload;
};
/** Complete durable sequence acknowledgement. */
export type ControlWorkerFinalStatusResult = z.infer<typeof ControlWorkerFinalStatusResultSchema>;

/** Only existing public domain refusals cross the private native error channel. */
export const ControlWorkerFinalStatusRefusalSchema = z
  .object({
    operation: z.literal('worker-control-final-status'),
    code: z.enum([
      'worker_control_unauthorized',
      'worker_control_lineage_mismatch',
      'worker_control_reconnect_required',
      'worker_control_lease_not_live',
      'worker_control_sequence_conflict',
      'worker_control_sequence_stale',
    ]),
    message: z.string(),
    status: z.union([z.literal(401), z.literal(403), z.literal(409), z.literal(503)]),
  })
  .strict();

/** A fixed original domain failure; arbitrary SQL and private causes stay on the worker failure path. */
export class WorkerFinalStatusRefusal extends Error {
  constructor(
    readonly code: z.infer<typeof ControlWorkerFinalStatusRefusalSchema>['code'],
    message: string,
    readonly status: 401 | 403 | 409 | 503
  ) {
    super(message);
  }
}
