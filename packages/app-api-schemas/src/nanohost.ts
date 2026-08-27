import { z } from 'zod';

import { addRawSecretIssues } from './raw-secrets.js';

/** Closed NanoHost transport Token type. */
export const NanoHostTransportTokenTypeSchema = z.enum(['nanohost-transport']);

/** Closed NanoHost transport Token scope. */
export const NanoHostTransportTokenScopeSchema = z.enum(['nanohost-transport']);

/** NanoHost transport Token lifecycle status. */
export const NanoHostTransportTokenStatusSchema = z.enum([
  'active',
  'expired',
  'revoked',
  'rotated',
]);

/** Declared execution-host credential slot that receives safe-sink delivery. */
export const NanoHostCredentialSlotSchema = z.enum(['A', 'B']);

/** Configured NanoHost RuntimeTarget authenticated-readiness observation. */
export const NanoHostRuntimeTargetStatusResponseSchema = z
  .object({
    identityId: z.string().min(1),
    deploymentId: z.string().min(1),
    connectionGeneration: z.number().int().positive(),
    predecessorFenced: z.boolean(),
    ready: z.boolean(),
    freshEmpty: z.boolean(),
    observedAt: z.string().datetime(),
  })
  .strict();

/**
 * Redacted proof that one named slot received secret and companion writes.
 *
 * Carries no raw secret, hash, or private recoverable credential fragment.
 */
export const NanoHostCredentialSlotResultSchema = z
  .object({
    slot: NanoHostCredentialSlotSchema,
    status: z.literal('written'),
    issuanceGeneration: z.number().int().positive(),
  })
  .strict();

/** Redacted NanoHost transport Token read model. */
export const NanoHostTransportTokenRecordSchema = z
  .object({
    tokenId: z.string().min(1),
    ownerNanoHostIdentityId: z.string().min(1),
    tokenType: NanoHostTransportTokenTypeSchema,
    scope: NanoHostTransportTokenScopeSchema,
    deploymentId: z.string().min(1),
    status: NanoHostTransportTokenStatusSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    predecessorTokenId: z.string().min(1).nullable(),
    rotationOverlapExpiresAt: z.string().datetime().nullable(),
    responsibleServerAdminActorId: z.string().min(1),
    lastUsedAt: z.string().datetime().nullable(),
    lastUsedChannel: z.string().min(1).nullable(),
    lastUsedSource: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/**
 * Server-admin NanoHost enrollment request.
 *
 * Creates the configured NanoHost identity and first `nanohost-transport` Token,
 * naming only which configured execution-host slot receives the first secret.
 */
export const EnrollNanoHostRequestSchema = z
  .object({
    targetSlot: NanoHostCredentialSlotSchema.default('A'),
    expiresAt: z.string().datetime(),
  })
  .strict();

/**
 * Server-admin NanoHost enrollment response.
 *
 * Returns only redacted identity, token-reference, and slot-result metadata.
 * The raw secret MUST NOT appear here; enrollment delivers it only through the
 * proved safe-sink path.
 */
export const EnrollNanoHostResponseSchema = z
  .object({
    identityId: z.string().min(1),
    deploymentId: z.string().min(1),
    credentialRef: z.string().min(1),
    targetSlot: NanoHostCredentialSlotSchema,
    slotResult: NanoHostCredentialSlotResultSchema,
    record: NanoHostTransportTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/**
 * Server-admin NanoHost transport Token issue request for a later issuance
 * after enrollment or recovery.
 */
export const IssueNanoHostTransportTokenRequestSchema = z
  .object({
    targetSlot: NanoHostCredentialSlotSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

/**
 * NanoHost transport Token issue response.
 *
 * Returns only redacted credential-ref and slot-result metadata after a proved
 * named safe-sink write. The raw `okt_` secret MUST NOT appear in this general
 * App API result.
 */
export const IssueNanoHostTransportTokenResponseSchema = z
  .object({
    credentialRef: z.string().min(1),
    targetSlot: NanoHostCredentialSlotSchema,
    slotResult: NanoHostCredentialSlotResultSchema,
    record: NanoHostTransportTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** NanoHost transport Token list response. */
export const ListNanoHostTransportTokensResponseSchema = z
  .object({
    items: z.array(NanoHostTransportTokenRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** NanoHost transport Token rotation request. */
export const RotateNanoHostTransportTokenRequestSchema = z
  .object({
    overlapSeconds: z.number().int().min(0).default(86_400),
  })
  .strict();

/**
 * NanoHost transport Token rotation response.
 *
 * Returns only redacted credential-ref and slot-result metadata after a proved
 * successor sink write. The raw `okt_` secret MUST NOT appear in this general
 * App API result.
 */
export const RotateNanoHostTransportTokenResponseSchema = z
  .object({
    credentialRef: z.string().min(1),
    targetSlot: NanoHostCredentialSlotSchema,
    slotResult: NanoHostCredentialSlotResultSchema,
    record: NanoHostTransportTokenRecordSchema,
    rotatedRecord: NanoHostTransportTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted response after aborting one pending NanoHost Token rotation. */
export const AbortNanoHostTransportRotationResponseSchema = z
  .object({
    predecessor: NanoHostTransportTokenRecordSchema,
    successor: NanoHostTransportTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted response after decommissioning the configured NanoHost identity. */
export const DecommissionNanoHostResponseSchema = z
  .object({
    identityId: z.string().min(1),
    revokedTokenCount: z.number().int().nonnegative(),
    status: z.literal('decommissioned'),
  })
  .strict();

/** NanoHost transport Token revocation response. */
export const RevokeNanoHostTransportTokenResponseSchema = z
  .object({
    record: NanoHostTransportTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Closed NanoHost transport Token type. */
export type NanoHostTransportTokenType = z.infer<typeof NanoHostTransportTokenTypeSchema>;
/** Closed NanoHost transport Token scope. */
export type NanoHostTransportTokenScope = z.infer<typeof NanoHostTransportTokenScopeSchema>;
/** NanoHost transport Token lifecycle status. */
export type NanoHostTransportTokenStatus = z.infer<typeof NanoHostTransportTokenStatusSchema>;
/** Declared execution-host credential slot. */
export type NanoHostCredentialSlot = z.infer<typeof NanoHostCredentialSlotSchema>;
/** Configured NanoHost RuntimeTarget authenticated-readiness observation. */
export type NanoHostRuntimeTargetStatusResponse = z.infer<
  typeof NanoHostRuntimeTargetStatusResponseSchema
>;
/** Redacted named-slot write proof. */
export type NanoHostCredentialSlotResult = z.infer<typeof NanoHostCredentialSlotResultSchema>;
/** Redacted NanoHost transport Token read model. */
export type NanoHostTransportTokenRecord = z.infer<typeof NanoHostTransportTokenRecordSchema>;
/** Server-admin NanoHost enrollment request. */
export type EnrollNanoHostRequest = z.infer<typeof EnrollNanoHostRequestSchema>;
/** Server-admin NanoHost enrollment response. */
export type EnrollNanoHostResponse = z.infer<typeof EnrollNanoHostResponseSchema>;
/** Server-admin NanoHost transport Token issue request. */
export type IssueNanoHostTransportTokenRequest = z.infer<
  typeof IssueNanoHostTransportTokenRequestSchema
>;
/** NanoHost transport Token issue response. */
export type IssueNanoHostTransportTokenResponse = z.infer<
  typeof IssueNanoHostTransportTokenResponseSchema
>;
/** NanoHost transport Token list response. */
export type ListNanoHostTransportTokensResponse = z.infer<
  typeof ListNanoHostTransportTokensResponseSchema
>;
/** NanoHost transport Token rotation request. */
export type RotateNanoHostTransportTokenRequest = z.infer<
  typeof RotateNanoHostTransportTokenRequestSchema
>;
/** NanoHost transport Token rotation response. */
export type RotateNanoHostTransportTokenResponse = z.infer<
  typeof RotateNanoHostTransportTokenResponseSchema
>;
/** NanoHost transport rotation-abort response. */
export type AbortNanoHostTransportRotationResponse = z.infer<
  typeof AbortNanoHostTransportRotationResponseSchema
>;
/** Configured NanoHost decommission response. */
export type DecommissionNanoHostResponse = z.infer<typeof DecommissionNanoHostResponseSchema>;
/** NanoHost transport Token revocation response. */
export type RevokeNanoHostTransportTokenResponse = z.infer<
  typeof RevokeNanoHostTransportTokenResponseSchema
>;
