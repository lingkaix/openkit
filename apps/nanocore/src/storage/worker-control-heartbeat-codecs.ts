import {
  WorkerControlHeartbeatRequestReaderSchema,
  WorkerLineageSchema,
} from '@openkit/worker-protocol';
import { z } from 'zod';

/** Hash-only authenticated coordinates for one complete heartbeat transaction. */
export const ControlWorkerHeartbeatInputSchema = z
  .object({
    lineage: WorkerLineageSchema,
    sandboxBindingRef: z.string().min(1),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Original semantic envelope and optional deterministic clock; raw reconnect credentials never cross. */
export const ControlWorkerHeartbeatPayloadSchema = z
  .object({
    request: WorkerControlHeartbeatRequestReaderSchema.refine(
      (request) => request.reconnectKey === undefined,
      'Reconnect credentials remain on Main.'
    ),
    acceptedAt: z.string().optional(),
    reconnectProcessKeyHash: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict();

/** Post-FULL sequence decision and the clock actually used by the native liveness writer. */
export const ControlWorkerHeartbeatResultSchema = z
  .object({
    duplicate: z.boolean(),
    nextExpectedSequence: z.number().int().nonnegative().safe(),
    acceptedAt: z.string(),
  })
  .strict();

/** Exact admitted heartbeat coordinates. */
export type ControlWorkerHeartbeatInput = z.infer<typeof ControlWorkerHeartbeatInputSchema>;
/** Exact original semantic bytes before existing binary admission. */
export type ControlWorkerHeartbeatCommand = Omit<ControlWorkerHeartbeatInput, 'byteLength'> & {
  readonly payload: z.infer<typeof ControlWorkerHeartbeatPayloadSchema>;
};
/** Complete durable acknowledgement facts. */
export type ControlWorkerHeartbeatResult = z.infer<typeof ControlWorkerHeartbeatResultSchema>;

/** Only the existing heartbeat domain refusals cross the private native boundary. */
export const ControlWorkerHeartbeatRefusalSchema = z
  .object({
    operation: z.literal('worker-control-heartbeat'),
    code: z.enum([
      'worker_control_unauthorized',
      'worker_control_lineage_mismatch',
      'worker_control_reconnect_required',
      'worker_control_lease_not_live',
      'worker_control_sequence_conflict',
      'worker_control_sequence_stale',
      'worker_control_identity_conflict',
    ]),
    message: z.string(),
    status: z.union([z.literal(401), z.literal(403), z.literal(409), z.literal(503)]),
  })
  .strict();

/** A closed original domain error, without arbitrary SQL messages. */
export class WorkerHeartbeatRefusal extends Error {
  constructor(
    readonly code: z.infer<typeof ControlWorkerHeartbeatRefusalSchema>['code'],
    message: string,
    readonly status: 401 | 403 | 409 | 503
  ) {
    super(message);
  }
}
