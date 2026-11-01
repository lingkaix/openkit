import { TimestampSchema } from '@openkit/protocol';
import { WorkerLineageSchema, WorkerOpaqueIdSchema } from '@openkit/worker-protocol';
import { z } from 'zod';

/** Closed product-safe rejection tuple; authentication is proved by the existing route owner. */
export const ControlWorkerRejectedEvidenceSchema = WorkerLineageSchema.extend({
  rejectionId: z.string().uuid(),
  requestId: WorkerOpaqueIdSchema.nullable(),
  route: z.string().min(1),
  operation: z.string().min(1),
  errorCode: z.string().min(1),
  httpStatus: z.number().int().min(400).max(599),
  message: z.string(),
  rejectedAt: TimestampSchema,
}).strict();

/** Exact existing rejection row, never a callback or a generic SQL request. */
export type ControlWorkerRejectedEvidence = z.infer<typeof ControlWorkerRejectedEvidenceSchema>;
