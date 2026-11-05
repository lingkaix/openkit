import { z } from 'zod';
import { ControlAccessTokenVerificationSchema } from '../storage/access-token-verification-codecs.js';

/** Original ENSURE hash only; no secret, lifetime override, clock, role or SQL. */
export const ControlBootstrapEnsureSchema = z
  .object({
    tokenHash: ControlAccessTokenVerificationSchema.shape.expectedHash,
  })
  .strict();
export type ControlBootstrapEnsure = z.infer<typeof ControlBootstrapEnsureSchema>;

/** Original non-secret issuance facts, or the original no-op. */
export const ControlBootstrapEnsureResultSchema = z
  .object({
    issuedAt: z.string(),
    expiresAt: z.string(),
  })
  .strict()
  .nullable();
export type ControlBootstrapEnsureResult = z.infer<typeof ControlBootstrapEnsureResultSchema>;
