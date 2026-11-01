import { NativeEnvironmentRecordSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import {
  WorkerImageSettlementIdentitySchema,
  WorkerImageSettlementSchema,
} from '../runtime/worker-image-settlements-records.js';
/** Exact existing image publication stages, never a general journal or SQL command. */
export const ControlWorkerImageInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('settlement'), value: WorkerImageSettlementSchema }).strict(),
  z
    .object({
      kind: z.literal('environment'),
      candidate: WorkerImageSettlementIdentitySchema,
      environment: NativeEnvironmentRecordSchema,
    })
    .strict(),
]);
/** Closed typed image input carried by the existing Core FIFO. */
export type ControlWorkerImageInput = z.infer<typeof ControlWorkerImageInputSchema>;
/** Known immutable-result conflict; private SQLite causes never become a public domain message. */
export const ControlWorkerImageRefusalSchema = z
  .object({
    operation: z.literal('worker-image'),
    code: z.enum(['worker_image_conflict', 'unsupported_retained_format']),
    message: z.enum([
      'Worker image settlement conflicts with its immutable result.',
      'Unsupported retained record format.',
    ]),
    status: z.literal(409),
  })
  .strict();
