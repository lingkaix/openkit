import { CreateOpenKitAccessTokenRequestSchema } from '@openkit/app-api-schemas';
import { AccessTokenIdSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  ControlAccessTokenVerificationResultSchema,
  ControlAccessTokenVerificationSchema,
} from '../storage/access-token-verification-codecs.js';
import { ControlCoreSharingActorSchema } from '../storage/workspace-sharing-codecs.js';

const preparedToken = z
  .object({
    tokenId: AccessTokenIdSchema,
    tokenHash: ControlAccessTokenVerificationSchema.shape.expectedHash,
  })
  .strict();

/** Original canonical lifecycle and authenticated actor facts; never a bearer, clock, SQL or grant. */
export const ControlAccessTokenLifecycleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('issue'),
      actor: ControlCoreSharingActorSchema,
      ownerUserId: UserIdSchema,
      scope: CreateOpenKitAccessTokenRequestSchema.shape.scope,
      workspaceIds: CreateOpenKitAccessTokenRequestSchema.shape.workspaceIds,
      expiresAt: CreateOpenKitAccessTokenRequestSchema.shape.expiresAt,
      token: preparedToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal('revoke'),
      actor: ControlCoreSharingActorSchema,
      tokenId: AccessTokenIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('rotate'),
      actor: ControlCoreSharingActorSchema,
      tokenId: AccessTokenIdSchema,
      graceSeconds: z.number().int().nonnegative(),
      successor: preparedToken,
    })
    .strict(),
]);
export type ControlAccessTokenLifecycle = z.infer<typeof ControlAccessTokenLifecycleSchema>;

// Preserve the existing private non-secret record representation. Public output validation
// stays after its original later Audit; no new strict public projection joins the SQL tuple.
const record = ControlAccessTokenVerificationResultSchema.unwrap();
export const ControlAccessTokenLifecycleResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('denied'),
      code: z.enum([
        'deployment_admin_required',
        'workspace_access_denied',
        'access_token_owner_invalid',
        'core.auth.scope_forbidden',
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('issue'), record }).strict(),
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
