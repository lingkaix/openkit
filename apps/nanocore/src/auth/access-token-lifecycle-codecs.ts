import { AccessTokenIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  ControlAccessTokenVerificationResultSchema,
  ControlAccessTokenVerificationSchema,
} from '../storage/access-token-verification-codecs.js';

const successor = z
  .object({
    tokenId: AccessTokenIdSchema,
    tokenHash: ControlAccessTokenVerificationSchema.shape.expectedHash,
  })
  .strict();

/** Original canonical revoke/rotation facts only; never a bearer, clock, SQL or grant. */
export const ControlAccessTokenLifecycleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revoke'), tokenId: AccessTokenIdSchema }).strict(),
  z
    .object({
      kind: z.literal('rotate'),
      tokenId: AccessTokenIdSchema,
      graceSeconds: z.number().int().nonnegative(),
      successor,
    })
    .strict(),
]);
export type ControlAccessTokenLifecycle = z.infer<typeof ControlAccessTokenLifecycleSchema>;

// Preserve the existing private non-secret record representation. Public output validation
// stays after its original later Audit; no new strict public projection joins the SQL tuple.
const record = ControlAccessTokenVerificationResultSchema.unwrap();
export const ControlAccessTokenLifecycleResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revoke'), record: record.nullable() }).strict(),
  z
    .object({
      kind: z.literal('rotate'),
      value: z.object({ tokenId: z.string(), record, rotatedRecord: record }).strict().nullable(),
    })
    .strict(),
]);
export type ControlAccessTokenLifecycleResult = z.infer<
  typeof ControlAccessTokenLifecycleResultSchema
>;
