import { z } from 'zod';

/**
 * Shared machine-readable error shape.
 */
export const ApiErrorSchema = z.object({
  /** Explicit core protocol version for this error payload. */
  protocolVersion: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.string().min(1)).optional(),
  details: z.unknown().optional(),
  requestId: z.string().min(1).optional(),
});
