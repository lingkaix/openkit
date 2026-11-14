import { WorkerLineageSchema } from '@openkit/worker-protocol';
import { z } from 'zod';

/** Identity-owned zero-grant Automation subject; never an issuer or Kernel principal. */
export const ControlAccessTokenRunSubjectSchema = z
  .object({
    kind: z.literal('automation'),
    id: z.string().min(1),
    responsibleUserId: z.string().min(1),
    grants: z.tuple([]),
    lineage: WorkerLineageSchema,
    attemptId: z.string().min(1),
    planId: z.string().min(1),
    grantId: z.string().min(1),
    referenceId: z.string().min(1),
    materialVersion: z.number().int().positive(),
    receiptId: z.string().min(1),
  })
  .strict();
export type ControlAccessTokenRunSubject = z.infer<typeof ControlAccessTokenRunSubjectSchema>;

/** Private canonical issuance link, never a caller-supplied grant or a session lifetime. */
export const ControlAccessTokenIssuerRefSchema = z
  .object({ kind: z.enum(['user', 'token']), id: z.string().min(1) })
  .strict();
export type ControlAccessTokenIssuerRef = z.infer<typeof ControlAccessTokenIssuerRefSchema>;

/** Actual native client selection; NULL alone retains an ordinary User credential. */
export const ControlAccessTokenPrincipalRefSchema = z
  .object({
    kind: z.literal('integration'),
    id: z.string().min(1),
  })
  .strict();
export type ControlAccessTokenPrincipalRef = z.infer<typeof ControlAccessTokenPrincipalRefSchema>;

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
    issuerRef: ControlAccessTokenIssuerRefSchema.nullable(),
    principalRef: ControlAccessTokenPrincipalRefSchema.nullable(),
    runSubject: ControlAccessTokenRunSubjectSchema.nullable(),
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
