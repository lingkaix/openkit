import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** OpenKit access-token scope. */
export const OpenKitAccessTokenScopeSchema = z.enum([
  'server-admin',
  'workspace',
  'workspace-readonly',
]);

/** OpenKit access-token lifecycle status. */
export const OpenKitAccessTokenStatusSchema = z.enum(['active', 'expired', 'revoked', 'rotated']);

/** Redacted OpenKit access-token read model. */
export const OpenKitAccessTokenRecordSchema = z
  .object({
    tokenId: z.string().min(1),
    ownerUserId: z.string().min(1),
    scope: OpenKitAccessTokenScopeSchema,
    workspaceIds: z.array(z.string().min(1)),
    status: OpenKitAccessTokenStatusSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    predecessorTokenId: z.string().min(1).nullable(),
    rotatedGraceExpiresAt: z.string().datetime().nullable(),
    lastUsedAt: z.string().datetime().nullable(),
    lastUsedChannel: z.string().min(1).nullable(),
    lastUsedSource: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** OpenKit access-token issue request. */
export const CreateOpenKitAccessTokenRequestSchema = z
  .object({
    scope: OpenKitAccessTokenScopeSchema,
    workspaceIds: z.array(z.string().min(1)).default([]),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** OpenKit access-token issue response with the one-time plaintext token. */
export const CreateOpenKitAccessTokenResponseSchema = z
  .object({
    token: z.string().regex(/^okt_[A-Za-z0-9_-]+$/),
    record: OpenKitAccessTokenRecordSchema,
  })
  .strict();

/** OpenKit access-token list response. */
export const ListOpenKitAccessTokensResponseSchema = z
  .object({
    items: z.array(OpenKitAccessTokenRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** OpenKit access-token revocation response. */
export const RevokeOpenKitAccessTokenResponseSchema = z
  .object({
    record: OpenKitAccessTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** OpenKit access-token rotation request. */
export const RotateOpenKitAccessTokenRequestSchema = z
  .object({
    graceSeconds: z.number().int().min(0).default(86_400),
  })
  .strict();

/** OpenKit access-token rotation response with the one-time plaintext token. */
export const RotateOpenKitAccessTokenResponseSchema = z
  .object({
    token: z.string().regex(/^okt_[A-Za-z0-9_-]+$/),
    record: OpenKitAccessTokenRecordSchema,
    rotatedRecord: OpenKitAccessTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value.record, ctx, ['record']);
    addRawSecretIssues(value.rotatedRecord, ctx, ['rotatedRecord']);
  });

/** OpenKit server bootstrap token consumption request. */
export const ConsumeOpenKitBootstrapTokenRequestSchema = z
  .object({
    token: z.string().regex(/^okt_[A-Za-z0-9_-]+$/),
    ownerUserId: z.string().min(1),
    displayName: z.string().min(1),
    tokenExpiresAt: z.string().datetime(),
  })
  .strict();

/** OpenKit server bootstrap token consumption response. */
export const ConsumeOpenKitBootstrapTokenResponseSchema = CreateOpenKitAccessTokenResponseSchema;

/** Email/password auth request body. */
export const AuthEmailRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Email/password sign-up request body. */
export const AuthSignUpEmailRequestSchema = AuthEmailRequestSchema.extend({
  name: z.string().min(1),
});

/** Better Auth user payload returned to the browser. */
export const AuthUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().email(),
    name: z.string().min(1),
    image: z.string().nullable().optional(),
    emailVerified: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

/** Browser auth response for email sign-up. */
export const AuthSignUpEmailResponseSchema = z
  .object({
    token: z.string().min(1).nullable(),
    user: AuthUserSchema,
  })
  .strict();

/** Browser auth response for email sign-in. */
export const AuthSignInEmailResponseSchema = z
  .object({
    redirect: z.boolean(),
    token: z.string().min(1),
    url: z.string().min(1).nullable().optional(),
    user: AuthUserSchema,
  })
  .strict();

/** Browser auth response for sign-out. */
export const AuthSignOutResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .strict();

/** Email/password auth request body. */
export type AuthEmailRequest = z.infer<typeof AuthEmailRequestSchema>;
/** Email/password sign-up request body. */
export type AuthSignUpEmailRequest = z.infer<typeof AuthSignUpEmailRequestSchema>;
/** OpenKit access-token scope. */
export type OpenKitAccessTokenScope = z.infer<typeof OpenKitAccessTokenScopeSchema>;
/** OpenKit access-token lifecycle status. */
export type OpenKitAccessTokenStatus = z.infer<typeof OpenKitAccessTokenStatusSchema>;
/** Redacted OpenKit access-token read model. */
export type OpenKitAccessTokenRecord = z.infer<typeof OpenKitAccessTokenRecordSchema>;
/** OpenKit access-token issue request. */
export type CreateOpenKitAccessTokenRequest = z.infer<typeof CreateOpenKitAccessTokenRequestSchema>;
/** OpenKit access-token issue response. */
export type CreateOpenKitAccessTokenResponse = z.infer<
  typeof CreateOpenKitAccessTokenResponseSchema
>;
/** OpenKit access-token list response. */
export type ListOpenKitAccessTokensResponse = z.infer<typeof ListOpenKitAccessTokensResponseSchema>;
/** OpenKit access-token revocation response. */
export type RevokeOpenKitAccessTokenResponse = z.infer<
  typeof RevokeOpenKitAccessTokenResponseSchema
>;
/** OpenKit access-token rotation request. */
export type RotateOpenKitAccessTokenRequest = z.infer<typeof RotateOpenKitAccessTokenRequestSchema>;
/** OpenKit access-token rotation response. */
export type RotateOpenKitAccessTokenResponse = z.infer<
  typeof RotateOpenKitAccessTokenResponseSchema
>;
/** OpenKit server bootstrap token consumption request. */
export type ConsumeOpenKitBootstrapTokenRequest = z.infer<
  typeof ConsumeOpenKitBootstrapTokenRequestSchema
>;
/** OpenKit server bootstrap token consumption response. */
export type ConsumeOpenKitBootstrapTokenResponse = z.infer<
  typeof ConsumeOpenKitBootstrapTokenResponseSchema
>;
/** Browser auth response for email sign-up. */
export type AuthSignUpEmailResponse = z.infer<typeof AuthSignUpEmailResponseSchema>;
/** Browser auth response for email sign-in. */
export type AuthSignInEmailResponse = z.infer<typeof AuthSignInEmailResponseSchema>;
/** Browser auth response for sign-out. */
export type AuthSignOutResponse = z.infer<typeof AuthSignOutResponseSchema>;
