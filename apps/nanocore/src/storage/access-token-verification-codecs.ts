import { z } from 'zod';

/** Exact existing token identity/hash proof; no bearer or authorization decision crosses the wire. */
export const ControlAccessTokenVerificationSchema = z
  .object({
    tokenId: z.string().min(1),
    expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    now: z.iso.datetime().optional(),
    channel: z.string().optional(),
    source: z.string().optional(),
  })
  .strict();
/** Hash-only proof and existing verification options. */
export type ControlAccessTokenVerification = z.infer<typeof ControlAccessTokenVerificationSchema>;
/** Closed redacted existing record projection; no hash or bearer can return. */
export const ControlAccessTokenVerificationResultSchema = z
  .object({
    tokenId: z.string(),
    ownerUserId: z.string(),
    scope: z.enum(['server-admin', 'workspace', 'workspace-readonly']),
    workspaceIds: z.array(z.string()),
    status: z.enum(['active', 'expired', 'revoked', 'rotated']),
    issuedAt: z.string(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
    predecessorTokenId: z.string().nullable(),
    rotatedGraceExpiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    lastUsedChannel: z.string().nullable(),
    lastUsedSource: z.string().nullable(),
  })
  .strict()
  .nullable();
/** Existing non-secret verification outcome. */
export type ControlAccessTokenVerificationResult = z.infer<
  typeof ControlAccessTokenVerificationResultSchema
>;
