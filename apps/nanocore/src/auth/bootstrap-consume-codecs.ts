import { ConsumeOpenKitBootstrapTokenRequestSchema } from '@openkit/app-api-schemas';
import { AccessTokenIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  ControlAccessTokenVerificationResultSchema,
  ControlAccessTokenVerificationSchema,
} from '../storage/access-token-verification-codecs.js';

const request = ConsumeOpenKitBootstrapTokenRequestSchema.shape;

/** Complete first-owner facts with prepared hashes only; no password, bearer, path, role or SQL. */
export const ControlBootstrapConsumeSchema = z
  .object({
    bootstrapHash: ControlAccessTokenVerificationSchema.shape.expectedHash,
    ownerUserId: request.ownerUserId,
    displayName: request.displayName,
    email: request.email,
    passwordHash: z.string().regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/),
    tokenExpiresAt: request.tokenExpiresAt,
    administrator: z
      .object({
        tokenId: AccessTokenIdSchema,
        tokenHash: ControlAccessTokenVerificationSchema.shape.expectedHash,
      })
      .strict(),
    // Existing trusted helper clock only; public input has no such field. Default time is native.
    now: z.string().max(64).optional(),
  })
  .strict();
export type ControlBootstrapConsume = z.infer<typeof ControlBootstrapConsumeSchema>;

/** Private redacted record; public validation stays after the original separate lifecycle Audit. */
export const ControlBootstrapConsumeResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('consumed'),
      record: ControlAccessTokenVerificationResultSchema.unwrap(),
    })
    .strict(),
  z.object({ status: z.literal('admin_expiry') }).strict(),
  z.object({ status: z.literal('invalid') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);
export type ControlBootstrapConsumeResult = z.infer<typeof ControlBootstrapConsumeResultSchema>;
